/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  claimDueGameServerSchedules,
  dispatchScheduledGameServers,
} from '../src/game-server-schedule.js'

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values)
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...(this.values as never[])) }
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...(this.values as never[]))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const fixture = (loseAcceptedResponse = false) => {
  const db = new DatabaseSync(':memory:')
  const directory = new URL('../../../packages/migrations/sql/', import.meta.url)
  for (const file of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort())
    db.exec(readFileSync(new URL(file, directory), 'utf8'))
  // Acceptance behavior belongs to the manifest D1 repository tests. This
  // fixture seeds an already accepted schedule and retains every transition
  // trigger exercised by the dispatcher.
  db.exec(`
    DROP TRIGGER game_server_draft_acceptance_fence;
    DROP TRIGGER game_server_draft_schedule_acceptance_fence;
    DROP TRIGGER audit_events_enqueue_export;
    INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('org-a', 'A', 'a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('draft-operation', 'org-a', 'game-server.draft.create', 'game-server-draft',
        'draft-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'succeeded', 100, 'draft-operation-key', 'draft-correlation', 1, 'now', 'now'),
       ('schedule-operation', 'org-a', 'game-server.draft.schedule', 'game-server-draft',
        'draft-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'succeeded', 100, 'schedule-operation-key', 'schedule-correlation', 1, 'now', 'now');
    INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
      VALUES ('draft-audit', 'org-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'game-server.draft.create', 'game-server-draft', 'draft-a', 'succeeded', 'draft-correlation', '{}', 'now'),
       ('schedule-audit', 'org-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'game-server.draft.schedule', 'game-server-draft', 'draft-a', 'succeeded', 'schedule-correlation', '{}', 'now');
    INSERT INTO game_server_drafts
      (organization_id, id, actor_id, idempotency_key, request_fingerprint, manifest_json,
       source_server_id, state, revision, operation_id, acceptance_audit_event_id, created_at, updated_at)
      VALUES ('org-a', 'draft-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'draft-key', '${'a'.repeat(64)}', '{}', NULL,
        'scheduled', 2, 'draft-operation', 'draft-audit', 'now', 'now');
    INSERT INTO game_server_draft_schedules
      (organization_id, id, draft_id, actor_id, idempotency_key, request_fingerprint,
       scheduled_for, state, revision, operation_id, target_operation_id, attempts,
       claim_id, lease_expires_at, last_error_code, acceptance_audit_event_id, created_at, updated_at)
      VALUES ('org-a', 'schedule-a', 'draft-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'schedule-key', '${'b'.repeat(64)}',
        '2026-08-24T00:00:00.000Z', 'scheduled', 1, 'schedule-operation', NULL, 0,
        NULL, NULL, NULL, 'schedule-audit', 'now', 'now');
  `)
  let lose = loseAcceptedResponse
  const wrapped = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        db.exec('COMMIT')
        if (
          lose &&
          statements.some((statement) => statement.sql.includes("SET state = 'accepted'"))
        ) {
          lose = false
          throw new Error('simulated response loss after commit')
        }
        return results
      } catch (cause) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw cause
      }
    },
  }
  return { db, wrapped }
}

describe('one-shot game-server schedules', () => {
  it('claims only the exact active tenant schedule and reclaims an expired lease', async () => {
    const { db, wrapped } = fixture()
    const first = await claimDueGameServerSchedules(wrapped as never, '2026-08-24T00:00:00.000Z')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      organizationId: 'org-a',
      draftId: 'draft-a',
      scheduleId: 'schedule-a',
      scheduleRevision: 2,
    })
    expect(first[0]?.actorId).toBe(
      (
        db
          .prepare(
            `SELECT identity_id AS identityId FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'`,
          )
          .get() as { identityId: string }
      ).identityId,
    )
    const retry = await claimDueGameServerSchedules(wrapped as never, '2026-08-24T00:06:00.000Z')
    expect(retry).toHaveLength(1)
    expect(retry[0]?.scheduleRevision).toBe(3)
    expect(retry[0]?.claimId).not.toBe(first[0]?.claimId)
    db.close()
  })

  it('adopts the accepted target operation after the D1 response is lost', async () => {
    const { db, wrapped } = fixture(true)
    const application = {
      fetch: async () => {
        db.prepare(`INSERT OR IGNORE INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES ('target-operation', 'org-a', 'server-provision-plan', 'server-provision',
            'provision-a', (SELECT identity_id FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'), 'queued', 0, 'scheduled-game:schedule-a',
            'scheduled-game-correlation', 1, 'now', 'now')`).run()
        return Response.json({ targetOperationId: 'target-operation' }, { status: 202 })
      },
    }
    expect(
      await dispatchScheduledGameServers(
        {
          DB: wrapped as never,
          APPLICATION: application as never,
          INTERNAL_SERVICE_SECRET: 'scheduled-game-test-secret-32-bytes',
        },
        Date.parse('2026-08-24T00:00:00.000Z'),
      ),
    ).toBe(1)
    expect(
      db
        .prepare(`SELECT state, target_operation_id AS targetOperationId
      FROM game_server_draft_schedules`)
        .get(),
    ).toEqual({ state: 'accepted', targetOperationId: 'target-operation' })
    expect(db.prepare(`SELECT state FROM game_server_drafts WHERE id = 'draft-a'`).get()).toEqual({
      state: 'materialized',
    })
    expect(await claimDueGameServerSchedules(wrapped as never, '2026-08-24T00:10:00.000Z')).toEqual(
      [],
    )
    db.close()
  })
})

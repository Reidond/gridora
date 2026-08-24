/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { claimDueBackupSchedules, dispatchScheduledBackups } from '../src/backup-schedule.js'

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
    private readonly loseAcceptedResponse?: { value: boolean },
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values, this.loseAcceptedResponse)
  }
  async first() {
    return this.db.prepare(this.sql).get(...(this.values as never[])) ?? null
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...(this.values as never[])) }
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...(this.values as never[]))
    if (this.loseAcceptedResponse?.value === true && this.sql.includes("SET state = 'accepted'")) {
      this.loseAcceptedResponse.value = false
      throw new Error('D1 response lost after commit')
    }
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const database = (loseAcceptedResponse?: { value: boolean }) => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, status TEXT, created_at TEXT);
    CREATE TABLE game_servers (organization_id TEXT, id TEXT, created_at TEXT, PRIMARY KEY (organization_id, id));
    CREATE TABLE identities (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE organization_memberships (organization_id TEXT, identity_id TEXT, role TEXT, status TEXT);
    CREATE TABLE policy_reconciliation_scheduler_identities (organization_id TEXT PRIMARY KEY, identity_id TEXT, created_at TEXT);
    CREATE TABLE orphan_reconciliation_scheduler_identities (organization_id TEXT PRIMARY KEY, identity_id TEXT, created_at TEXT);
    CREATE TABLE audit_actor_bindings (scope TEXT, scope_key TEXT, organization_id TEXT, actor_type TEXT, actor_id TEXT, operation_actor_id TEXT, created_at TEXT, UNIQUE(scope, scope_key, actor_type, actor_id));
    CREATE TABLE backup_jobs (organization_id TEXT, id TEXT, PRIMARY KEY (organization_id, id));
  `)
  db.exec(
    readFileSync(
      new URL('../../../packages/migrations/sql/0030_scheduled_backups.sql', import.meta.url),
      'utf8',
    ),
  )
  const wrapped = {
    prepare: (sql: string) => new Statement(db, sql, [], loseAcceptedResponse),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        db.exec('COMMIT')
        return results
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }
    },
  }
  return { db, wrapped }
}

describe('scheduled backup D1 claims', () => {
  it('uses canonical UTC instants, exact retry identity, and an active registered automation actor', async () => {
    const { db, wrapped } = database()
    db.exec(`
      INSERT INTO organizations VALUES ('org-a', 'active', '2026-08-23T00:00:00.000Z');
      INSERT INTO identities VALUES ('policy-scheduler-a', 'active');
      INSERT INTO policy_reconciliation_scheduler_identities VALUES ('org-a', 'policy-scheduler-a', '2026-08-23T00:00:00.000Z');
      INSERT INTO organization_memberships VALUES ('org-a', 'policy-scheduler-a', 'automation', 'active');
      INSERT INTO game_servers VALUES ('org-a', 'server-a', '2026-08-23T00:00:00.000Z');
    `)
    const first = await claimDueBackupSchedules(wrapped as never, '2026-08-24T00:00:00.000Z')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      organizationId: 'org-a',
      serverId: 'server-a',
      scheduledFor: '2026-08-24T00:00:00.000Z',
      actorId: 'policy-scheduler-a',
    })
    expect(db.prepare(`SELECT next_run_at AS nextRunAt FROM backup_schedules`).get()).toEqual({
      nextRunAt: '2026-08-25T00:00:00.000Z',
    })

    db.prepare(`UPDATE backup_schedule_dispatches
      SET state = 'retrying', claim_id = NULL, lease_expires_at = NULL`).run()
    const retry = await claimDueBackupSchedules(wrapped as never, '2026-08-24T00:05:00.000Z')
    expect(retry).toHaveLength(1)
    expect(retry[0]?.scheduledFor).toBe(first[0]?.scheduledFor)
    expect(retry[0]?.scheduleRevision).toBe(first[0]?.scheduleRevision)
    expect(retry[0]?.claimId).not.toBe(first[0]?.claimId)

    db.prepare(`UPDATE identities SET status = 'disabled' WHERE id = 'policy-scheduler-a'`).run()
    db.prepare(`UPDATE backup_schedule_dispatches
      SET state = 'retrying', claim_id = NULL, lease_expires_at = NULL`).run()
    expect(await claimDueBackupSchedules(wrapped as never, '2026-08-24T00:10:00.000Z')).toEqual([])
    db.close()
  })

  it('adopts an accepted dispatch after the D1 response is lost', async () => {
    const loss = { value: true }
    const { db, wrapped } = database(loss)
    db.exec(`
      INSERT INTO organizations VALUES ('org-a', 'active', '2026-08-23T00:00:00.000Z');
      INSERT INTO identities VALUES ('policy-scheduler-a', 'active');
      INSERT INTO policy_reconciliation_scheduler_identities VALUES ('org-a', 'policy-scheduler-a', '2026-08-23T00:00:00.000Z');
      INSERT INTO organization_memberships VALUES ('org-a', 'policy-scheduler-a', 'automation', 'active');
      INSERT INTO game_servers VALUES ('org-a', 'server-a', '2026-08-23T00:00:00.000Z');
    `)
    const application = {
      fetch: async (input: RequestInfo | URL) =>
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
        ).endsWith('/v1/internal/scheduled-backups/dispatch')
          ? Response.json({ backupJobId: 'job-a', operationId: 'operation-a' }, { status: 202 })
          : Response.json({ deleted: 0 }),
    }
    expect(
      await dispatchScheduledBackups(
        {
          DB: wrapped as never,
          APPLICATION: application as never,
          INTERNAL_SERVICE_SECRET: 'scheduled-backup-test-secret-32-bytes',
        },
        Date.parse('2026-08-24T00:00:00.000Z'),
      ),
    ).toBe(1)
    expect(loss.value).toBe(false)
    expect(
      db
        .prepare(`SELECT state, backup_job_id AS backupJobId, operation_id AS operationId
        FROM backup_schedule_dispatches`)
        .get(),
    ).toEqual({ state: 'accepted', backupJobId: 'job-a', operationId: 'operation-a' })
    expect(await claimDueBackupSchedules(wrapped as never, '2026-08-24T00:10:00.000Z')).toEqual([])
    db.close()
  })

  it('fails the scheduled run when physical retention reconciliation is unavailable', async () => {
    const { db, wrapped } = database()
    const application = {
      fetch: async () => new Response('retention unavailable', { status: 503 }),
    }
    await expect(
      dispatchScheduledBackups(
        {
          DB: wrapped as never,
          APPLICATION: application as never,
          INTERNAL_SERVICE_SECRET: 'scheduled-backup-test-secret-32-bytes',
        },
        Date.parse('2026-08-24T00:00:00.000Z'),
      ),
    ).rejects.toThrow('backup retention rejected with 503')
    db.close()
  })
})

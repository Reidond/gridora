import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeGameServerManifestD1Repository,
  makeGameServerDraftD1Repository,
  type GameServerManifestD1Database,
  type GameServerManifestD1Statement,
} from '../src/index.js'
import type {
  GameServerManifest,
  GameServerManifestPolicyUpdateCommand,
} from '@gridora/game-server-manifest-control'

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView

class SqliteStatement implements GameServerManifestD1Statement {
  private values: readonly unknown[] = []
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}
  bind(...values: readonly unknown[]): GameServerManifestD1Statement {
    this.values = values
    return this
  }
  async first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...(this.values as SqlInputValue[])) as
      | T
      | undefined
    return row ?? null
  }
  run(): void {
    this.database.prepare(this.sql).run(...(this.values as SqlInputValue[]))
  }
}

class SqliteD1 implements GameServerManifestD1Database {
  private loseResponse = false
  constructor(readonly database: DatabaseSync) {}
  loseNextBatchResponseAfterCommit(): void {
    this.loseResponse = true
  }
  prepare(sql: string): GameServerManifestD1Statement {
    return new SqliteStatement(this.database, sql)
  }
  async batch(statements: readonly GameServerManifestD1Statement[]): Promise<readonly unknown[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) (statement as SqliteStatement).run()
      this.database.exec('COMMIT')
    } catch (cause) {
      this.database.exec('ROLLBACK')
      throw cause
    }
    if (this.loseResponse) {
      this.loseResponse = false
      throw new Error('simulated D1 response loss after durable commit')
    }
    return []
  }
}

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrationFiles = readdirSync(sqlDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 63)
  .sort()

let database: DatabaseSync
let d1: SqliteD1
let sequence = 0

const auditRequestContext = (correlationId: string) => ({
  origin: 'http' as const,
  requestId: 'request-manifest-d1-test',
  correlationId,
  source: {
    ip: { state: 'captured' as const, value: '203.0.113.10' },
    access: {
      state: 'captured' as const,
      value: {
        subject: 'access-a',
        identityId: 'identity-a',
        issuer: 'https://team.cloudflareaccess.com',
        email: 'a@example.com',
      },
    },
  },
})

const seed = () => {
  database.exec(`
    INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('identity-a', 'access-a', 'a@example.com', 'A', 'active', 'now', 'now');
    INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('org-a', 'A', 'a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now');
    INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at)
      VALUES ('org-a', 'identity-a', 'owner', 'active', 'now');
    INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '0.1.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('initial-operation', 'org-a', 'server.create', 'server', 'server-a', 'identity-a',
       'succeeded', 100, 'initial-operation-key', 'initial-correlation', 1,
       '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z');
    INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, domain, steam_credential_reference, pending_lifecycle_operation_id,
       desired_revision, observed_revision, active_config_revision, created_at, updated_at)
      VALUES ('org-a', 'server-a', 'Frontline', 'arma-reforger', '0.1.0', 'running', 'running',
       '{"mode":"shared","nodeId":"node-a"}', NULL, NULL, NULL, 1, 1, 1,
       '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z');
    INSERT INTO game_server_config_revisions
      (organization_id, server_id, revision, schema_version, config_json, actor_id, created_at)
      VALUES ('org-a', 'server-a', 1, 1, '{"scenarioId":"x"}', 'identity-a', '2026-08-24T12:00:00.000Z');
    INSERT INTO mod_sets
      (organization_id, server_id, schema_version, desired_revision, resolved_revision, desired_json, resolved_json, revision)
      VALUES ('org-a', 'server-a', 1, 1, 0, '[]', '[]', 1);
    INSERT INTO game_server_desired_specs
      (organization_id, server_id, schema_version, desired_revision, source_operation_id, spec_json, created_at, updated_at)
      VALUES ('org-a', 'server-a', 1, 1, 'initial-operation',
       '{"schemaVersion":1,"plugin":{"id":"arma-reforger","version":"0.1.0"},"placement":{"mode":"shared","nodeId":"node-a"},"resources":{"cpuMillis":2000,"ramBytes":4294967296,"diskBytes":21474836480},"endpoint":{},"updatePolicy":{"mode":"manual","backupBeforeUpdate":true},"backupPolicy":{"schedule":"0 4 * * *","retainCount":7},"config":{"scenarioId":"x"},"mods":[]}',
       '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z');
  `)
}

const command = (
  overrides: Partial<GameServerManifestPolicyUpdateCommand> = {},
): GameServerManifestPolicyUpdateCommand => ({
  organizationId: 'org-a',
  actorId: 'identity-a',
  correlationId: 'manifest-policy-correlation',
  auditRequestContext: auditRequestContext('manifest-policy-correlation'),
  idempotencyKey: 'manifest-policy-update-a',
  serverId: 'server-a',
  expectedRevision: 1,
  updatePolicy: { mode: 'automatic', backupBeforeUpdate: false },
  backupPolicy: { schedule: '0 5 * * *', retainCount: 14 },
  ...overrides,
})

const repository = () =>
  makeGameServerManifestD1Repository(d1, {
    now: () => '2026-08-24T12:00:00.000Z',
    operationId: () => `manifest-policy-operation-${++sequence}`,
    auditEventId: () => `manifest-policy-audit-${sequence}`,
  })

const draftManifest: GameServerManifest = {
  apiVersion: 'games.gridora.example/v1alpha1',
  kind: 'GameServer',
  metadata: { name: 'Scheduled Frontline', organization: 'a' },
  spec: {
    plugin: { id: 'arma-reforger', version: '0.1.0' },
    placement: { mode: 'shared' },
    resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 21_474_836_480 },
    endpoint: {},
    updatePolicy: { mode: 'manual', backupBeforeUpdate: true },
    backupPolicy: { schedule: '0 4 * * *', retainCount: 7 },
    config: { scenarioId: 'x' },
    mods: [],
  },
}

const draftRepository = () =>
  makeGameServerDraftD1Repository(d1, {
    now: () => '2026-08-24T12:00:00.000Z',
    operationId: () => `draft-operation-${++sequence}`,
    auditEventId: () => `draft-audit-${sequence}`,
    draftId: () => 'draft-a',
    scheduleId: () => 'schedule-a',
  })

describe('game server manifest D1 repository', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrationFiles)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    seed()
    d1 = new SqliteD1(database)
    sequence = 0
  })
  afterEach(() => database.close())

  it('exports only authoritative desired state and fences tenant reads', async () => {
    const result = await Effect.runPromise(repository().readById('org-a', 'server-a'))
    expect(result).toMatchObject({
      organizationId: 'org-a',
      serverId: 'server-a',
      desiredRevision: 1,
      spec: {
        updatePolicy: { mode: 'manual', backupBeforeUpdate: true },
      },
    })
    expect(result.spec).not.toHaveProperty('steamCredentialRef')
    await expect(
      Effect.runPromise(repository().readById('org-b', 'server-a')),
    ).rejects.toMatchObject({
      _tag: 'GameServerManifestNotFoundError',
    })
  })

  it('atomically accepts policy-only desired state and adopts an exact response-loss retry', async () => {
    d1.loseNextBatchResponseAfterCommit()
    const accepted = await Effect.runPromise(repository().acceptPolicyUpdate(command()))
    expect(accepted).toMatchObject({
      disposition: 'adopted',
      state: 'succeeded',
      desiredRevision: 2,
    })
    expect(
      database
        .prepare(
          `SELECT desired_revision AS desiredRevision FROM game_servers WHERE id = 'server-a'`,
        )
        .get(),
    ).toEqual({ desiredRevision: 2 })
    expect(
      database
        .prepare(`SELECT status, progress FROM operations WHERE id = ?`)
        .get(accepted.operationId),
    ).toEqual({ status: 'succeeded', progress: 100 })
    expect(
      database.prepare(`SELECT capture_status AS captureStatus FROM audit_event_envelopes`).get(),
    ).toEqual({ captureStatus: 'complete' })
    const updated = await Effect.runPromise(repository().readById('org-a', 'server-a'))
    expect(updated.spec).toMatchObject({
      updatePolicy: { mode: 'automatic', backupBeforeUpdate: false },
      backupPolicy: { schedule: '0 5 * * *', retainCount: 14 },
    })
    const replay = await Effect.runPromise(repository().acceptPolicyUpdate(command()))
    expect(replay).toMatchObject({ disposition: 'adopted', operationId: accepted.operationId })
    expect(
      database.prepare('SELECT count(*) AS count FROM game_server_manifest_mutations').get(),
    ).toEqual({ count: 1 })
  })

  it('rejects a cross-actor or changed-payload replay instead of adopting it', async () => {
    await Effect.runPromise(repository().acceptPolicyUpdate(command()))
    await expect(
      Effect.runPromise(
        repository().acceptPolicyUpdate(
          command({ updatePolicy: { mode: 'manual', backupBeforeUpdate: false } }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'GameServerManifestIdempotencyConflictError' })
    await expect(
      Effect.runPromise(repository().acceptPolicyUpdate(command({ actorId: 'identity-b' }))),
    ).rejects.toMatchObject({ _tag: 'GameServerManifestIdempotencyConflictError' })
  })

  it('persists an immutable draft and adopts the exact response-loss replay', async () => {
    d1.loseNextBatchResponseAfterCommit()
    const draft = await Effect.runPromise(
      draftRepository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        correlationId: 'draft-correlation',
        auditRequestContext: auditRequestContext('draft-correlation'),
        idempotencyKey: 'draft-create-key-a',
        manifest: draftManifest,
        sourceServerId: 'server-a',
      }),
    )
    expect(draft).toMatchObject({
      id: 'draft-a',
      state: 'draft',
      revision: 1,
      sourceServerId: 'server-a',
    })
    expect(
      database
        .prepare(`SELECT capture_status AS captureStatus FROM audit_event_envelopes
      WHERE event_id = 'draft-audit-1'`)
        .get(),
    ).toEqual({ captureStatus: 'complete' })
    const replay = await Effect.runPromise(
      draftRepository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        correlationId: 'draft-correlation',
        auditRequestContext: auditRequestContext('draft-correlation'),
        idempotencyKey: 'draft-create-key-a',
        manifest: draftManifest,
        sourceServerId: 'server-a',
      }),
    )
    expect(replay.operationId).toBe(draft.operationId)
    await expect(
      Effect.runPromise(
        draftRepository().create({
          organizationId: 'org-a',
          actorId: 'identity-a',
          correlationId: 'draft-correlation',
          auditRequestContext: auditRequestContext('draft-correlation'),
          idempotencyKey: 'draft-create-key-a',
          manifest: { ...draftManifest, metadata: { ...draftManifest.metadata, name: 'Changed' } },
          sourceServerId: 'server-a',
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'GameServerManifestIdempotencyConflictError' })
  })

  it('accepts one exact future schedule and fences a second schedule', async () => {
    const draft = await Effect.runPromise(
      draftRepository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        correlationId: 'draft-correlation',
        auditRequestContext: auditRequestContext('draft-correlation'),
        idempotencyKey: 'draft-create-key-b',
        manifest: draftManifest,
      }),
    )
    d1.loseNextBatchResponseAfterCommit()
    const schedule = await Effect.runPromise(
      draftRepository().schedule({
        organizationId: 'org-a',
        actorId: 'identity-a',
        correlationId: 'schedule-correlation',
        auditRequestContext: auditRequestContext('schedule-correlation'),
        idempotencyKey: 'draft-schedule-key-a',
        draftId: draft.id,
        expectedRevision: 1,
        scheduledFor: '2026-08-25T12:00:00.000Z',
      }),
    )
    expect(schedule).toMatchObject({ id: 'schedule-a', state: 'scheduled', revision: 1 })
    expect(
      database.prepare(`SELECT state, revision FROM game_server_drafts WHERE id = 'draft-a'`).get(),
    ).toEqual({ state: 'scheduled', revision: 2 })
    const replay = await Effect.runPromise(
      draftRepository().schedule({
        organizationId: 'org-a',
        actorId: 'identity-a',
        correlationId: 'schedule-correlation',
        auditRequestContext: auditRequestContext('schedule-correlation'),
        idempotencyKey: 'draft-schedule-key-a',
        draftId: draft.id,
        expectedRevision: 1,
        scheduledFor: '2026-08-25T12:00:00.000Z',
      }),
    )
    expect(replay.operationId).toBe(schedule.operationId)
    await expect(
      Effect.runPromise(
        draftRepository().schedule({
          organizationId: 'org-a',
          actorId: 'identity-a',
          correlationId: 'schedule-correlation-2',
          auditRequestContext: auditRequestContext('schedule-correlation-2'),
          idempotencyKey: 'draft-schedule-key-b',
          draftId: draft.id,
          expectedRevision: 1,
          scheduledFor: '2026-08-26T12:00:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'GameServerManifestRevisionConflictError' })
  })
})

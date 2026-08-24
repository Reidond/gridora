import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupKeyRepositoryPort, BackupWrappedKeyRecord } from '@gridora/backup-key'
import { migrations } from '@gridora/migrations'
import {
  makeBackupKeyRepositoryD1Layer,
  type BackupKeyD1Database,
  type BackupKeyD1Result,
  type BackupKeyD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))

class SQLiteStatement implements BackupKeyD1Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: ReadonlyArray<unknown> = [],
    private readonly resultOverride?: BackupKeyD1Result,
  ) {}
  bind(...values: ReadonlyArray<unknown>): BackupKeyD1Statement {
    return new SQLiteStatement(this.statement, values, this.resultOverride)
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async run(): Promise<BackupKeyD1Result> {
    if (this.resultOverride !== undefined) return this.resultOverride
    const result = this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class SQLiteD1 implements BackupKeyD1Database {
  failInsertResult?: BackupKeyD1Result
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): BackupKeyD1Statement {
    return new SQLiteStatement(
      this.database.prepare(sql),
      [],
      sql.includes('INSERT OR IGNORE INTO backup_wrapped_keys') ? this.failInsertResult : undefined,
    )
  }
}

const candidate = (backupId = 'backup-a', serverId = 'server-a') =>
  new BackupWrappedKeyRecord({
    organizationId: 'org-a',
    serverId,
    backupId,
    keyVersion: 2,
    wrappedDataKey: 'AQIDBA==',
    revision: 1,
  })

const seed = (database: DatabaseSync) => {
  database
    .prepare(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('owner-a', 'access-owner-a', 'owner@example.com', 'Owner', 'active', 'now', 'now')`)
    .run()
  database
    .prepare(`INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision,
     revision, created_at)
    VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west',
      'organization', 1, 1, 'now')`)
    .run()
  database
    .prepare(`INSERT INTO game_plugins
    (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('test-game', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
    .run()
  for (const serverId of ['server-a', 'server-b'])
    database
      .prepare(`INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, created_at, updated_at)
      VALUES ('org-a', ?, ?, 'test-game', '1.0.0', 'stopped', 'stopped', '{}', 'now', 'now')`)
      .run(serverId, serverId)
  for (const [backupId, serverId] of [
    ['backup-a', 'server-a'],
    ['backup-b', 'server-b'],
  ] as const)
    database
      .prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version,
       metadata_json, state, created_at)
      VALUES ('org-a', ?, ?, ?, 'sha256:pending', 2, '{}', 'creating', 'now')`)
      .run(
        backupId,
        serverId,
        `organizations/org-a/servers/${serverId}/backups/${backupId}/manifest.json`,
      )
}

describe('D1 wrapped backup-key repository', () => {
  let database: DatabaseSync
  let d1: SQLiteD1
  let layer: ReturnType<typeof makeBackupKeyRepositoryD1Layer>
  const run = <A, E>(effect: Effect.Effect<A, E, BackupKeyRepositoryPort>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
    seed(database)
    d1 = new SQLiteD1(database)
    layer = makeBackupKeyRepositoryD1Layer(d1)
  })
  afterEach(() => database.close())

  it('inserts once and atomically adopts the immutable exact record', async () => {
    const first = await run(
      Effect.flatMap(BackupKeyRepositoryPort, (repository) => repository.insertOrGet(candidate())),
    )
    const differentRetry = new BackupWrappedKeyRecord({
      organizationId: 'org-a',
      serverId: 'server-a',
      backupId: 'backup-a',
      keyVersion: 2,
      wrappedDataKey: 'BQYHCA==',
      revision: 1,
    })
    const retry = await run(
      Effect.flatMap(BackupKeyRepositoryPort, (repository) =>
        repository.insertOrGet(differentRetry),
      ),
    )
    expect(first).toMatchObject({ kind: 'inserted', record: { wrappedDataKey: 'AQIDBA==' } })
    expect(retry).toMatchObject({ kind: 'existing', record: { wrappedDataKey: 'AQIDBA==' } })
    expect(database.prepare('SELECT COUNT(*) AS count FROM backup_wrapped_keys').get()).toEqual({
      count: 1,
    })
  })

  it('never reports a failed D1 write as an inserted key', async () => {
    d1.failInsertResult = { success: false, meta: { changes: 1 } }
    const result = await run(
      Effect.flatMap(BackupKeyRepositoryPort, (repository) =>
        Effect.result(repository.insertOrGet(candidate())),
      ),
    )
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BackupR2Error', code: 'key-failed' },
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM backup_wrapped_keys').get()).toEqual({
      count: 0,
    })
  })

  it('fences the key to the canonical backup/server pair and forbids mutation', async () => {
    const wrongScope = await run(
      Effect.flatMap(BackupKeyRepositoryPort, (repository) =>
        Effect.result(repository.insertOrGet(candidate('backup-a', 'server-b'))),
      ),
    )
    expect(wrongScope).toMatchObject({ _tag: 'Failure', failure: { code: 'key-failed' } })

    await run(
      Effect.flatMap(BackupKeyRepositoryPort, (repository) => repository.insertOrGet(candidate())),
    )
    expect(() =>
      database
        .prepare(
          `UPDATE backup_wrapped_keys SET wrapped_data_key = 'BQYHCA=='
           WHERE organization_id = 'org-a' AND server_id = 'server-a' AND backup_id = 'backup-a'`,
        )
        .run(),
    ).toThrow(/backup wrapped key is immutable/)
    expect(() =>
      database
        .prepare(
          `DELETE FROM backup_wrapped_keys
           WHERE organization_id = 'org-a' AND server_id = 'server-a' AND backup_id = 'backup-a'`,
        )
        .run(),
    ).toThrow(/backup wrapped key is immutable/)
  })
})

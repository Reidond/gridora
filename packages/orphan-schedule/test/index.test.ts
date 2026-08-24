import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeOrphanScheduleStore,
  type OrphanScheduleD1Database,
  type OrphanScheduleD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = Array.from(
  { length: 21 },
  (_, index) =>
    `${String(index + 1).padStart(4, '0')}_${
      [
        'identity_organizations',
        'operations_outbox',
        'mvp_inventory',
        'provider_account_credentials',
        'registration_policy_audit',
        'lifecycle_reservations',
        'audit_export_outbox',
        'tunnel_credential_delivery',
        'orphan_findings',
        'backup_wrapped_keys',
        'provider_account_lifecycle',
        'node_provision_acceptance',
        'server_plan',
        'agent_observation_ingestion',
        'node_provision_execution_lease',
        'platform_provider_control',
        'game_server_lifecycle_execution',
        'backup_orchestration',
        'destructive_lifecycle_termination',
        'logs_health_aggregates',
        'scheduled_orphan_reconciliation',
      ][index]
    }.sql`,
)

class Statement implements OrphanScheduleD1Statement {
  private values: ReadonlyArray<unknown> = []

  constructor(
    readonly database: DatabaseSync,
    readonly statement: StatementSync,
  ) {}

  bind(...values: ReadonlyArray<unknown>): Statement {
    const bound = new Statement(this.database, this.statement)
    bound.values = values
    return bound
  }

  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }

  async all(): Promise<{
    readonly results: ReadonlyArray<unknown>
    readonly meta: { readonly changes: number }
  }> {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    const changes = this.database.prepare('SELECT changes() AS changes').get() as {
      readonly changes: number
    }
    return { results, meta: { changes: changes.changes } }
  }
}

class SqliteD1 implements OrphanScheduleD1Database {
  loseNextBatchResponse = false

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, this.database.prepare(sql))
  }

  async batch(
    statements: ReadonlyArray<OrphanScheduleD1Statement>,
  ): Promise<ReadonlyArray<unknown>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement.all())
      this.database.exec('COMMIT')
      if (this.loseNextBatchResponse) {
        this.loseNextBatchResponse = false
        throw new Error('simulated D1 response loss')
      }
      return results
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // The commit already happened in the deliberate response-loss branch.
      }
      throw error
    }
  }
}

let database: DatabaseSync
let d1: SqliteD1
let clock: Date

const seedOrganization = (organizationId: string) => {
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
    .run(organizationId, organizationId, `${organizationId}-slug`, clock.toISOString())
}

const seedProvider = (organizationId: string, accountId: string) => {
  database
    .prepare(`INSERT INTO secret_envelopes
      (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
       key_version, revision, created_at, rotated_at)
      VALUES (?, ?, 'provider-account', ?, 'ciphertext', 'wrapped', 1, 1, ?, NULL)`)
    .run(organizationId, `credential-${accountId}`, accountId, clock.toISOString())
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status,
       revision, created_at, updated_at)
      VALUES (?, 'organization', ?, 'ovhcloud', ?, 'active', 1, ?, ?)`)
    .run(
      accountId,
      organizationId,
      `credential-${accountId}`,
      clock.toISOString(),
      clock.toISOString(),
    )
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, status, revision)
      VALUES (?, ?, '["eu-west"]', '["small"]', 10, 'active', 1)`)
    .run(organizationId, accountId)
}

const store = () =>
  makeOrphanScheduleStore(d1, {
    now: () => clock,
  })

describe('scheduled orphan reconciliation D1 composition', () => {
  beforeEach(() => {
    clock = new Date('2026-08-23T10:00:00.000Z')
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seedOrganization('org-a')
    seedOrganization('org-b')
    seedProvider('org-a', 'account-a')
    seedProvider('org-b', 'account-b')
  })

  afterEach(() => database.close())

  it('enumerates only exact active allocations and binds an internal tenant automation actor', async () => {
    const tasks = await Effect.runPromise(store().claimScheduledTasks(clock.toISOString()))
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => `${task.organizationId}:${task.providerAccountId}`).sort()).toEqual([
      'org-a:account-a',
      'org-b:account-b',
    ])
    expect(tasks.every((task) => task.actorId.startsWith('orphan-scheduler-'))).toBe(true)
    expect(tasks.every((task) => !JSON.stringify(task).includes('ciphertext'))).toBe(true)
  })

  it('fails closed for a forged tenant task before a Workflow can be started', async () => {
    const [task] = await Effect.runPromise(store().claimScheduledTasks(clock.toISOString()))
    if (task === undefined) throw new Error('missing scheduled task')
    await expect(
      Effect.runPromise(store().beginWorkflow({ ...task, organizationId: 'org-b' })),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    const state = database
      .prepare(`SELECT state FROM orphan_reconciliation_schedule_leases
        WHERE organization_id = ? AND provider_account_id = ?`)
      .get(task.organizationId, task.providerAccountId) as { readonly state: string }
    expect(state.state).toBe('pending')
  })

  it('adopts committed lease transitions after D1 response loss and keeps one task identity', async () => {
    d1.loseNextBatchResponse = true
    const [task] = await Effect.runPromise(store().claimScheduledTasks(clock.toISOString()))
    if (task === undefined) throw new Error('missing scheduled task')
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM orphan_reconciliation_schedule_leases
        WHERE organization_id = ? AND provider_account_id = ?`)
        .get(task.organizationId, task.providerAccountId),
    ).toEqual({ count: 1 })

    d1.loseNextBatchResponse = true
    await expect(Effect.runPromise(store().beginWorkflow(task))).resolves.toBe('adopted')
    d1.loseNextBatchResponse = true
    await expect(Effect.runPromise(store().complete(task))).resolves.toBe('replayed')
    await expect(Effect.runPromise(store().complete(task))).resolves.toBe('replayed')
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM orphan_reconciliation_schedule_leases
        WHERE organization_id = ? AND provider_account_id = ?`)
        .get(task.organizationId, task.providerAccountId),
    ).toEqual({ count: 1 })
  })

  it('does not schedule more than the bounded page size', async () => {
    for (let index = 0; index < 30; index++) {
      const id = `extra-${index}`
      seedProvider('org-a', id)
    }
    const tasks = await Effect.runPromise(store().claimScheduledTasks(clock.toISOString()))
    expect(tasks).toHaveLength(25)
  })
})

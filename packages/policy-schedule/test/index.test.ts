import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  makePolicyScheduleStore,
  type PolicyScheduleD1Database,
  type PolicyScheduleD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
  '0007_audit_export_outbox.sql',
  '0008_tunnel_credential_delivery.sql',
  '0009_orphan_findings.sql',
  '0010_backup_wrapped_keys.sql',
  '0011_provider_account_lifecycle.sql',
  '0012_node_provision_acceptance.sql',
  '0013_server_plan.sql',
  '0014_agent_observation_ingestion.sql',
  '0015_node_provision_execution_lease.sql',
  '0016_platform_provider_control.sql',
  '0017_game_server_lifecycle_execution.sql',
  '0018_backup_orchestration.sql',
  '0019_destructive_lifecycle_termination.sql',
  '0020_logs_health_aggregates.sql',
  '0021_scheduled_orphan_reconciliation.sql',
  '0022_automation_identity_credentials.sql',
  '0023_node_image_lifecycle.sql',
  '0024_node_runtime_lifecycle.sql',
  '0025_scheduled_policy_reconciliation.sql',
] as const

class Statement implements PolicyScheduleD1Statement {
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
    const changed = this.database.prepare('SELECT changes() AS changes').get() as {
      readonly changes: number
    }
    return { results, meta: { changes: changed.changes } }
  }
}

class SqliteD1 implements PolicyScheduleD1Database {
  loseNextBatchResponse = false

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, this.database.prepare(sql))
  }

  async batch(
    statements: ReadonlyArray<PolicyScheduleD1Statement>,
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
        // A simulated response loss occurs only after the durable commit.
      }
      throw error
    }
  }
}

const nowIso = '2026-08-23T10:30:00.000Z'
let clock = new Date(nowIso)
let database: DatabaseSync
let d1: SqliteD1

const policy = (organizationId: string): OrganizationPolicyV1 => ({
  schemaVersion: 1,
  organizationId,
  revision: 1,
  allowedProviders: ['ovhcloud'],
  allowedRegions: ['eu-west'],
  allowedPlans: ['small'],
  capacity: {
    maxActiveNodes: 10,
    maxDedicatedNodes: 5,
    maxServersPerNode: 8,
    maxDeploymentCpuMillis: 8_000,
    maxDeploymentRamBytes: 16_000,
    maxDeploymentDiskBytes: 100_000,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 10_000,
    hardLimitMinor: 20_000,
  },
  temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 168 },
  idle: { action: 'shutdown', afterMinutes: 60 },
  backups: { requiredBeforeDelete: true },
  maintenanceWindows: [{ dayOfWeekUtc: 0, startMinuteUtc: 600, durationMinutes: 120 }],
  updates: { automatic: 'security', requireMaintenanceWindow: true },
  contabo: { maxContractMonths: 12 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
})

const seedOrganization = (organizationId: string) => {
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
    .run(organizationId, organizationId, `${organizationId}-slug`, nowIso)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES (?, 'owner-a', 'owner', 'active', ?, 1)`)
    .run(organizationId, nowIso)
  database
    .prepare(`INSERT INTO organization_policies
      (organization_id, policy_json, revision, updated_by, updated_at)
      VALUES (?, ?, 1, 'owner-a', ?)`)
    .run(organizationId, JSON.stringify(policy(organizationId)), nowIso)
}

const store = () => makePolicyScheduleStore(d1, { now: () => clock })

describe('bounded policy reconciliation scheduling', () => {
  beforeEach(() => {
    clock = new Date(nowIso)
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    database
      .prepare(`INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('owner-a', 'access-owner-a', 'owner-a@example.test', 'Owner A', 'active', ?, ?)`)
      .run(nowIso, nowIso)
  })

  afterEach(() => database.close())

  it('selects at most one deterministic, secret-free task for each active organization in a bounded page', async () => {
    for (let index = 0; index < 30; index += 1)
      seedOrganization(`org-${String(index).padStart(2, '0')}`)

    const first = await Effect.runPromise(store().claimScheduledTasks(nowIso))
    const second = await Effect.runPromise(store().claimScheduledTasks(nowIso))

    expect(first).toHaveLength(25)
    expect(second).toHaveLength(5)
    expect([...first, ...second].map((task) => task.organizationId).sort()).toEqual(
      Array.from({ length: 30 }, (_, index) => `org-${String(index).padStart(2, '0')}`),
    )
    expect(first.every((task) => task.actorId.startsWith('policy-scheduler-'))).toBe(true)
    expect(JSON.stringify(first)).not.toContain('credential')
  })

  it('rejects a forged tenant task before a Workflow can claim the lease', async () => {
    seedOrganization('org-a')
    const [task] = await Effect.runPromise(store().claimScheduledTasks(nowIso))
    if (task === undefined) throw new Error('missing task')

    await expect(
      Effect.runPromise(store().beginWorkflow({ ...task, organizationId: 'org-b' })),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    const state = database
      .prepare(`SELECT state FROM policy_reconciliation_schedule_leases
        WHERE organization_id = ? AND schedule_slot = ?`)
      .get(task.organizationId, task.scheduleSlot) as { readonly state: string }
    expect(state.state).toBe('pending')
  })

  it('adopts exactly one task after queue or Workflow response loss', async () => {
    seedOrganization('org-a')
    d1.loseNextBatchResponse = true
    const [task] = await Effect.runPromise(store().claimScheduledTasks(nowIso))
    if (task === undefined) throw new Error('missing task')

    d1.loseNextBatchResponse = true
    await expect(Effect.runPromise(store().beginWorkflow(task))).resolves.toBe('adopted')
    d1.loseNextBatchResponse = true
    await expect(Effect.runPromise(store().complete(task))).resolves.toBe('replayed')
    await expect(Effect.runPromise(store().complete(task))).resolves.toBe('replayed')
    expect(
      database.prepare(`SELECT count(*) AS count FROM policy_reconciliation_schedule_leases`).get(),
    ).toEqual({ count: 1 })
  })

  it('fails closed when the current policy revision no longer matches the scheduled task', async () => {
    seedOrganization('org-a')
    const [task] = await Effect.runPromise(store().claimScheduledTasks(nowIso))
    if (task === undefined) throw new Error('missing task')
    await Effect.runPromise(store().beginWorkflow(task))
    database.prepare(`UPDATE organizations SET policy_revision = 2 WHERE id = 'org-a'`).run()

    await expect(Effect.runPromise(store().assertExecutionLease(task))).rejects.toMatchObject({
      code: 'invalid-scope',
    })
  })
})

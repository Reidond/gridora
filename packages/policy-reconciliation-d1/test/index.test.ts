import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import { CorrelationId, OperationId } from '@gridora/domain'
import {
  planPolicyReconciliation,
  type PolicyReconciliationPlan,
  type PolicyReconciliationRequest,
} from '@gridora/policy-reconciliation-control'
import {
  makePolicyScheduleStore,
  type PolicyScheduleD1Database,
  type PolicyScheduleD1Statement,
  type PolicyScheduleTask,
} from '@gridora/policy-schedule'
import {
  makePolicyReconciliationRepositoryD1,
  type PolicyReconciliationD1Database,
  type PolicyReconciliationD1Statement,
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
  '0026_organization_membership_leave.sql',
  '0027_game_command_envelope.sql',
  '0028_audit_envelope_v1.sql',
  '0032_policy_identifier_contract.sql',
] as const

class Statement implements PolicyReconciliationD1Statement, PolicyScheduleD1Statement {
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

class SqliteD1 implements PolicyReconciliationD1Database, PolicyScheduleD1Database {
  beforeNextBatch: (() => void) | undefined
  loseNextBatchResponse = false

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, this.database.prepare(sql))
  }

  async batch(
    statements: ReadonlyArray<PolicyReconciliationD1Statement>,
  ): Promise<ReadonlyArray<{ readonly results: ReadonlyArray<unknown> }>> {
    const before = this.beforeNextBatch
    this.beforeNextBatch = undefined
    before?.()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: Array<{ readonly results: ReadonlyArray<unknown> }> = []
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
        // The deliberate response-loss branch committed before its response failed.
      }
      throw error
    }
  }
}

const nowIso = '2026-08-23T10:30:00.000Z'
const now = new Date(nowIso)

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

let database: DatabaseSync
let d1: SqliteD1

const count = (table: string): number =>
  Number(
    (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
  )

const seed = () => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('owner-a', 'access-owner-a', 'owner-a@example.test', 'Owner A', 'active', ?, ?)`)
    .run(nowIso, nowIso)
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
    .run(nowIso)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES ('org-a', 'owner-a', 'owner', 'active', ?, 1)`)
    .run(nowIso)
  database
    .prepare(`INSERT INTO organization_policies
      (organization_id, policy_json, revision, updated_by, updated_at)
      VALUES ('org-a', ?, 1, 'owner-a', ?)`)
    .run(JSON.stringify(policy('org-a')), nowIso)
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'provider-envelope-a', 'active', 1, ?, ?)`)
    .run(nowIso, nowIso)
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, monthly_budget_minor, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 10, 20000, 'active', 1)`)
    .run()
  database
    .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-a', '1.0.0', 'checksum-a', 'signature-a', '{}', 'promoted', ?, ?)`)
    .run(nowIso, nowIso)
  database
    .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
       image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
       temporary_expires_at, created_at, updated_at)
      VALUES ('org-a', 'node-expired', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small',
       'image-a', 'shared', 'ready', 'ready', 3, 3, '2026-08-23T10:00:00.000Z', ?, ?)`)
    .run(nowIso, nowIso)
  database
    .prepare(`INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
    .run()
  for (const id of ['server-idle', 'server-update']) {
    database
      .prepare(`INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
        VALUES ('org-a', ?, ?, 'arma-reforger', '1.0.0', 'running', 'running', '{}', 5, 5, 2, ?, ?)`)
      .run(id, id, nowIso, nowIso)
    database
      .prepare(`INSERT INTO deployments
        (organization_id, id, server_id, node_id, desired_revision, observed_revision, observed_state, created_at, updated_at)
        VALUES ('org-a', ?, ?, 'node-expired', 1, 1, 'running', ?, ?)`)
      .run(`deployment-${id}`, id, nowIso, nowIso)
  }
  database
    .prepare(`INSERT INTO health_current_snapshots
      (organization_id, resource_type, resource_id, node_id, server_id, status, summary_json, sampled_at, revision)
      VALUES ('org-a', 'server', 'server-idle', 'node-expired', 'server-idle', 'healthy', ?,
       '2026-08-23T09:00:00.000Z', 1)`)
    .run(JSON.stringify({ game: { process: 'running', playerCount: 4 } }))
  database
    .prepare(`UPDATE health_current_snapshots
      SET summary_json = ?, sampled_at = '2026-08-23T10:29:00.000Z', revision = 2
      WHERE organization_id = 'org-a' AND resource_type = 'server' AND resource_id = 'server-idle'`)
    .run(JSON.stringify({ game: { process: 'running', playerCount: 0 } }))
  database
    .prepare(`INSERT INTO policy_reconciliation_update_candidates
      (organization_id, id, server_id, revision, category, target_version, status,
       approved_by, approved_at, created_at, updated_at)
      VALUES ('org-a', 'candidate-a', 'server-update', 1, 'security', '1.2.3', 'active',
       'owner-a', ?, ?, ?)`)
    .run(nowIso, nowIso, nowIso)
}

const beginTask = async (): Promise<PolicyScheduleTask> => {
  const store = makePolicyScheduleStore(d1, { now: () => now })
  const tasks = await Effect.runPromise(store.claimScheduledTasks(nowIso))
  const task = tasks[0]
  if (task === undefined) throw new Error('policy schedule did not create a task')
  await Effect.runPromise(store.beginWorkflow(task))
  return task
}

const requestFor = (task: PolicyScheduleTask): PolicyReconciliationRequest => ({
  organizationId: task.organizationId,
  actorId: task.actorId,
  policyRevision: task.policyRevision,
  scheduleSlot: task.scheduleSlot,
  runId: task.runId,
  idempotencyKey: task.idempotencyKey,
  leaseToken: task.leaseToken,
})

const plan = async (task: PolicyScheduleTask): Promise<PolicyReconciliationPlan> => {
  const request = requestFor(task)
  const repository = makePolicyReconciliationRepositoryD1(d1, { now: () => nowIso })
  const snapshot = await Effect.runPromise(repository.loadSnapshot(request))
  const actions = await Effect.runPromise(planPolicyReconciliation(request, snapshot, now))
  return {
    ...request,
    observedAt: snapshot.observedAt,
    snapshotFingerprint: `sha256:${'a'.repeat(64)}`,
    actions,
  }
}

describe('policy reconciliation D1 fences', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
  })

  afterEach(() => database.close())

  it('uses only bounded authoritative facts and atomically records read-only action requests with audit/outbox evidence', async () => {
    const task = await beginTask()
    const repository = makePolicyReconciliationRepositoryD1(d1, { now: () => nowIso })
    const input = await plan(task)
    expect(input.actions.map((action) => action.kind).sort()).toEqual([
      'retire-node',
      'shutdown-server',
      'update-server',
    ])

    const result = await Effect.runPromise(repository.applyAtomic(input))
    expect(result).toMatchObject({ organizationId: 'org-a', runId: task.runId, replayed: false })
    expect(result.actions.every((action) => action.dispatchState === 'pending')).toBe(true)
    expect(count('policy_reconciliation_runs')).toBe(1)
    expect(count('policy_reconciliation_actions')).toBe(3)
    expect(count('audit_events')).toBe(3)
    expect(count('audit_event_envelopes')).toBe(3)
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_event_envelopes
          WHERE scope = 'tenant' AND schema_version = 1 AND capture_status = 'complete'
            AND json_extract(envelope_json, '$.operationId') LIKE 'policy-acceptance-%'
            AND json_extract(envelope_json, '$.actor.type') = 'system'
            AND json_extract(envelope_json, '$.source.origin') = 'scheduler'`)
        .get(),
    ).toEqual({ count: 3 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operations
          WHERE id LIKE 'policy-acceptance-%' AND status = 'succeeded' AND progress = 100`)
        .get(),
    ).toEqual({ count: 3 })
    const operations = database
      .prepare(`SELECT id, correlation_id AS correlationId FROM operations
        WHERE id LIKE 'policy-operation-%' OR id LIKE 'policy-acceptance-%'
        ORDER BY id`)
      .all() as unknown as ReadonlyArray<{ readonly id: unknown; readonly correlationId: unknown }>
    expect(operations).toHaveLength(6)
    for (const operation of operations) {
      expect(() => Schema.decodeUnknownSync(OperationId)(operation.id)).not.toThrow()
      expect(() => Schema.decodeUnknownSync(CorrelationId)(operation.correlationId)).not.toThrow()
    }
    // Migration 0007 adds one audit-export outbox row for each audit row.
    expect(count('outbox')).toBe(6)
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM outbox WHERE event_type = 'policy-reconciliation.action.accepted'`,
        )
        .get(),
    ).toEqual({ count: 3 })
    const evidence = database
      .prepare(`SELECT group_concat(payload_json, '|') AS value FROM outbox`)
      .get() as {
      readonly value: string
    }
    expect(evidence.value).not.toContain('provider-envelope-a')
    expect(evidence.value).not.toContain('ciphertext')
  })

  it('adopts a committed run after D1 response loss without creating another action or audit receipt', async () => {
    const task = await beginTask()
    const repository = makePolicyReconciliationRepositoryD1(d1, { now: () => nowIso })
    d1.loseNextBatchResponse = true
    const result = await Effect.runPromise(repository.applyAtomic(await plan(task)))

    expect(result.replayed).toBe(true)
    expect(count('policy_reconciliation_runs')).toBe(1)
    expect(count('policy_reconciliation_actions')).toBe(3)
    expect(count('audit_events')).toBe(3)
    expect(count('audit_event_envelopes')).toBe(3)
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operations
          WHERE id LIKE 'policy-acceptance-%' AND status = 'succeeded' AND progress = 100`)
        .get(),
    ).toEqual({ count: 3 })
    expect(count('outbox')).toBe(6)
  })

  it.each([
    [
      'policy',
      () =>
        database.prepare(`UPDATE organizations SET policy_revision = 2 WHERE id = 'org-a'`).run(),
    ],
    [
      'resource',
      () =>
        database
          .prepare(
            `UPDATE nodes SET desired_revision = 4 WHERE organization_id = 'org-a' AND id = 'node-expired'`,
          )
          .run(),
    ],
  ] as const)(
    'rolls back every request and evidence row when the final %s fence changes',
    async (_label, change) => {
      const task = await beginTask()
      const repository = makePolicyReconciliationRepositoryD1(d1, { now: () => nowIso })
      const input = await plan(task)
      d1.beforeNextBatch = change

      await expect(Effect.runPromise(repository.applyAtomic(input))).rejects.toMatchObject({
        code: expect.stringMatching(/stale|persistence/),
      })
      expect(count('policy_reconciliation_runs')).toBe(0)
      expect(count('policy_reconciliation_actions')).toBe(0)
      expect(count('audit_events')).toBe(0)
      expect(count('outbox')).toBe(0)
    },
  )

  it('does not disclose a forged tenant task or start an unscoped reconciliation run', async () => {
    const task = await beginTask()
    const repository = makePolicyReconciliationRepositoryD1(d1, { now: () => nowIso })
    const forged = { ...requestFor(task), organizationId: 'org-b' }

    await expect(Effect.runPromise(repository.loadSnapshot(forged))).rejects.toMatchObject({
      code: 'stale-policy',
    })
    expect(count('policy_reconciliation_runs')).toBe(0)
  })
})

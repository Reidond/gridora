import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { type AuditRequestContextValue } from '@gridora/audit-contracts'
import type { ServerProvisionAtomicInput } from '@gridora/server-plan-control'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  makeServerProvisionRepositoryD1,
  type ServerPlanD1Database,
  type ServerPlanD1Result,
  type ServerPlanD1Statement,
} from '../src/index.js'

const migrationsDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort()
const now = '2026-08-23T14:00:00.000Z'

class SqliteStatement implements ServerPlanD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): ServerPlanD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<ServerPlanD1Result> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
}

class SqliteD1 implements ServerPlanD1Database {
  loseResponseAfterCommitOnce = false
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): ServerPlanD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<ServerPlanD1Statement>,
  ): Promise<ReadonlyArray<ServerPlanD1Result>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: ServerPlanD1Result[] = []
      for (const statement of statements) {
        const result = await statement.all()
        const changes = this.database.prepare('SELECT changes() AS value').get() as {
          value: number
        }
        results.push({ ...result, meta: { changes: changes.value } })
      }
      this.database.exec('COMMIT')
      if (this.loseResponseAfterCommitOnce) {
        this.loseResponseAfterCommitOnce = false
        throw new Error('simulated D1 response loss after commit')
      }
      return results
    } catch (cause) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw cause
    }
  }
}

let database: DatabaseSync
let d1: SqliteD1

const auditRequestContext: AuditRequestContextValue = {
  origin: 'http',
  requestId: 'request-server-provision-a',
  correlationId: 'correlation-server-provision-a',
  source: {
    ip: { state: 'captured', value: '203.0.113.10' },
    access: {
      state: 'captured',
      value: {
        subject: 'access-operator-a',
        identityId: 'operator-a',
        issuer: 'https://access.example.test',
        email: 'operator-a@example.test',
      },
    },
  },
}

const input = (): ServerProvisionAtomicInput => ({
  command: {
    context: {
      organizationId: 'org-a',
      actorId: 'operator-a',
      actorRole: 'operator',
      correlationId: 'correlation-server-provision-a',
    },
    idempotencyKey: 'server-provision-key-a',
    intent: {
      schemaVersion: 1,
      server: {
        schemaVersion: 1,
        name: 'Eastern Front',
        pluginId: 'arma-reforger',
        placementMode: 'auto',
        resources: { cpuMillis: 2000, ramBytes: 4294967296, diskBytes: 42949672960 },
        nonHourlyCommitmentConfirmed: false,
      },
      game: {
        schemaVersion: 1,
        name: 'Eastern Front',
        pluginId: 'arma-reforger',
        placement: { mode: 'shared' },
        resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
        config: {},
        mods: [],
      },
    },
    auditRequestContext,
  },
  fingerprint: 'a'.repeat(64),
  identity: {
    resourceId: 'server-provision-a',
    operationId: 'operation-server-provision-a',
    workflowStartRecordId: 'workflow-start-server-provision-a',
    auditEventId: 'audit-server-provision-a',
    outboxEventId: 'outbox-server-provision-a',
  },
  plan: {
    kind: 'existing-node',
    pluginId: 'arma-reforger',
    pluginVersion: '0.1.0',
    placementMode: 'shared',
    nodeId: 'node-a',
    resources: { cpuMillis: 2000, ramBytes: 4294967296, diskBytes: 42949672960 },
    ports: [],
    newPaidInfrastructure: false,
    estimatedMonthlyIncreaseMinor: 0,
    explanation: 'existing ready capacity',
    warnings: [],
    candidates: [],
  },
  now,
})

const seed = () => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('operator-a', 'access-operator-a', 'operator-a@example.test', 'Operator A', 'active', ?, ?)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
    .run(now)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES ('org-a', 'operator-a', 'operator', 'active', ?, 1)`)
    .run(now)
}

const auditContextJson = JSON.stringify(auditRequestContext)
const checksum = `sha256:${'a'.repeat(64)}`

/**
 * This scaffolds accepted node/retirement child rows without exercising their
 * own package-level admission tests. The assertions below deliberately leave
 * the 0042 parent-child triggers enabled: they prove that a server parent
 * cannot bind an arbitrary operation as a provision or compensation child.
 */
const seedCompensationScaffold = () => {
  // The production compensation adapter keeps the accepted parent actor and
  // uses its actual administrator/owner membership. This compact fixture
  // exercises the same destructive-operation scope guard rather than
  // suppressing it.
  database
    .prepare(`UPDATE organization_memberships SET role = 'administrator'
      WHERE organization_id = 'org-a' AND identity_id = 'operator-a'`)
    .run()
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('account-a', 'organization', 'org-a', 'ovhcloud', 'envelope-a', 'active', 1, ?, ?)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, monthly_budget_minor, status, revision)
      VALUES ('org-a', 'account-a', '["region-a"]', '["plan-a"]', 4, 10000, 'active', 1)`)
    .run()
  database
    .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-a', '1.0.0', ?, 'signature-a', '{"ovhcloud":{"region-a":"provider-image-a"}}', 'promoted', ?, ?)`)
    .run(checksum, now, now)
  for (const nodeId of ['node-a', 'node-foreign'])
    database
      .prepare(`INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
         placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
        VALUES ('org-a', ?, 'account-a', ?, 'ovhcloud', 'region-a', 'plan-a', 'image-a',
          'shared', 'ready', 'ready', 1, 1, ?, ?)`)
      .run(nodeId, `provider-${nodeId}`, now, now)

  // These unrelated admission guards have their own dedicated test suites.
  // Dropping them only permits compact child fixtures; 0042's own fences stay active.
  database.exec('DROP TRIGGER audit_events_enqueue_export')
  database.exec('DROP TRIGGER node_provision_acceptance_fence')
  database.exec('DROP TRIGGER node_provision_acceptance_temporary_expiry_guard')

  const seedNodeProvisionChild = (nodeId: string, operationId: string) => {
    database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES (?, 'org-a', 'provision-node', 'node', ?, 'operator-a', 'queued', 0, ?, 'correlation-server-provision-a', 1, ?, ?)`)
      .run(operationId, nodeId, `node-provision:${operationId}`, now, now)
    database
      .prepare(`INSERT INTO lifecycle_workflow_starts
        (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
        VALUES ('org-a', ?, ?, 'pending', 0, NULL, ?, ?)`)
      .run(operationId, `node-workflow:${operationId}`, now, now)
    database
      .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
        VALUES (?, 'org-a', 'operator-a', 'node.provision.accepted', 'node', ?, 'succeeded',
          'correlation-server-provision-a', '{}', ?)`)
      .run(`node-audit:${operationId}`, nodeId, now)
    database
      .prepare(`INSERT INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, created_at)
        VALUES (?, 'org-a', 'lifecycle.workflow-start.requested', 'operation', ?, '{}', 'pending', 0, ?, ?)`)
      .run(`node-outbox:${operationId}`, operationId, now, now)
    database
      .prepare(`INSERT INTO node_bootstrap_token_reservations
        (organization_id, token_record_id, node_id, operation_id, key_version, token_hash, state, expires_at, created_at, updated_at)
        VALUES ('org-a', ?, ?, ?, 1, ?, 'reserved', '2026-08-24T14:00:00.000Z', ?, ?)`)
      .run(`node-token:${operationId}`, nodeId, operationId, 'b'.repeat(64), now, now)
    database
      .prepare(`INSERT INTO node_provision_acceptances
        (organization_id, idempotency_key, request_fingerprint, node_id, operation_id, workflow_start_record_id,
         audit_event_id, outbox_event_id, bootstrap_token_record_id, bootstrap_key_version,
         provider_account_id, provider_account_revision, provider_type, allocation_revision,
         allocation_max_active_nodes, allocation_monthly_budget_minor, allocation_active_nodes_before,
         region, plan, catalog_refreshed_at, catalog_valid_until_epoch_ms, image_id, image_version,
         image_checksum, provider_image_id, placement_mode, policy_revision, active_nodes_before,
         dedicated_nodes_before, currency, estimated_monthly_minor, billing_cadence, contract_months,
         committed_monthly_before_minor, projected_committed_monthly_minor, receipt_json, created_at,
         temporary_lifetime_hours, temporary_expires_at, audit_request_context_json)
        VALUES ('org-a', ?, ?, ?, ?, ?, ?, ?, ?, 1,
          'account-a', 1, 'ovhcloud', 1, 4, 10000, 0,
          'region-a', 'plan-a', ?, 4102444800000, 'image-a', '1.0.0', ?, 'provider-image-a', 'shared', 1, 0,
          0, 'EUR', 1000, 'monthly', 1, 0, 1000, '{}', ?, NULL, NULL, ?)`)
      .run(
        `node-provision:${operationId}`,
        'c'.repeat(64),
        nodeId,
        operationId,
        `node-workflow:${operationId}`,
        `node-audit:${operationId}`,
        `node-outbox:${operationId}`,
        `node-token:${operationId}`,
        now,
        checksum,
        now,
        auditContextJson,
      )
  }
  seedNodeProvisionChild('node-a', 'node-provision-a')
}

const seedRetirementChild = (nodeId: string, operationId: string) => {
  database.exec('DROP TRIGGER IF EXISTS node_lifecycle_run_acceptance_guard')
  database.exec('DROP TRIGGER IF EXISTS node_lifecycle_provider_binding_acceptance_guard')
  database
    .prepare(`UPDATE nodes SET desired_state = 'draining', desired_revision = 2,
      pending_lifecycle_operation_id = ?, updated_at = ? WHERE organization_id = 'org-a' AND id = ?`)
    .run(operationId, now, nodeId)
  database
    .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, 'org-a', 'retire-node', 'node', ?, 'operator-a', 'queued', 0, ?, 'correlation-server-provision-a', 1, ?, ?)`)
    .run(operationId, nodeId, `retire:${operationId}`, now, now)
  database
    .prepare(`INSERT INTO destructive_lifecycle_operations
      (organization_id, operation_id, action, resource_type, resource_id, actor_id, idempotency_key,
       request_fingerprint, cancellation_policy, organization_deletion_operation_id, policy_reconciliation_action_id,
       state, revision, accepted_at, updated_at)
      VALUES ('org-a', ?, 'retire-node', 'node', ?, 'operator-a', ?, ?, 'before-destructive-step',
        NULL, NULL, 'queued', 1, ?, ?)`)
    .run(operationId, nodeId, `retire:${operationId}`, 'd'.repeat(64), now, now)
  database
    .prepare(`INSERT INTO node_lifecycle_runs
      (organization_id, operation_id, node_id, action, previous_desired_state, previous_desired_revision,
       desired_revision, force_requested, backup_policy, target_image_id, state, provider_retirement_state,
       billing_state, cancellation_date, billing_stops_at, provider_request_reference, blocked_reason,
       created_at, updated_at, audit_request_context_json)
      VALUES ('org-a', ?, ?, 'retire-node', 'ready', 1, 2, 0, 'required', NULL, 'draining', 'not-started',
       'not-applicable', NULL, NULL, NULL, NULL, ?, ?, ?)`)
    .run(operationId, nodeId, now, now, auditContextJson)
}

const provisionNodePlan = () => ({
  kind: 'provision-node' as const,
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  pluginSelectionRevision: 1,
  placementMode: 'shared' as const,
  nodeIntent: {
    schemaVersion: 1 as const,
    placementMode: 'shared' as const,
    temporaryLifetimeHours: null,
    nonHourlyCommitmentConfirmed: false,
  },
  selectedInfrastructure: { providerType: 'ovhcloud' as const, region: 'region-a', plan: 'plan-a' },
  billing: {
    currency: 'EUR',
    estimatedMonthlyIncreaseMinor: 1000,
    billingCadence: 'monthly' as const,
    contractMonths: 1,
    committedMonthlyBeforeMinor: 0,
    projectedCommittedMonthlyMinor: 1000,
  },
  requiresNonHourlyCommitmentConfirmation: false,
  commercialConsentRequired: false,
  implications: {
    dns: 'published after endpoint verification',
    mods: 'validated before activation',
    backups: 'applied after deployment',
    downtime: 'new deployment',
    billing: 'starts only after node acceptance',
  },
  warnings: [],
  explanation: 'no ready capacity fits',
  newPaidInfrastructure: true as const,
})

const reviewedNodeProvision = () => ({
  facts: {
    organizationId: 'org-a',
    providerAccountId: 'account-a',
    providerAccountRevision: 1,
    providerType: 'ovhcloud' as const,
    allocationRevision: 1,
    allocationMaxActiveNodes: 4,
    allocationMonthlyBudgetMinor: 10_000,
    allocationActiveNodes: 0,
    region: 'region-a',
    plan: 'plan-a',
    catalogRefreshedAt: now,
    catalogValidUntilEpochMilliseconds: 4_102_444_800_000,
    imageId: 'image-a',
    imageVersion: '1.0.0',
    imageChecksum: checksum,
    providerImageId: 'provider-image-a',
    policy: {
      schemaVersion: 1 as const,
      organizationId: 'org-a',
      revision: 1,
      allowedProviders: ['ovhcloud'],
      allowedRegions: ['region-a'],
      allowedPlans: ['plan-a'],
      capacity: {
        maxActiveNodes: 4,
        maxDedicatedNodes: 2,
        maxServersPerNode: 4,
        maxDeploymentCpuMillis: 4_000,
        maxDeploymentRamBytes: 8_589_934_592,
        maxDeploymentDiskBytes: 107_374_182_400,
      },
      monthlyBudget: {
        currency: 'EUR',
        setupWarningMinor: null,
        softLimitMinor: 8_000,
        hardLimitMinor: 10_000,
      },
      temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 168 },
      idle: { action: 'none' as const, afterMinutes: 60 },
      backups: { requiredBeforeDelete: true },
      maintenanceWindows: [],
      updates: { automatic: 'disabled' as const, requireMaintenanceWindow: false },
      contabo: { maxContractMonths: 1 },
      nonHourlyCommitment: { explicitConfirmationRequired: true },
    },
    usage: {
      organizationId: 'org-a',
      observedAtEpochMilliseconds: 1_777_000_000_000,
      activeNodes: 0,
      dedicatedNodes: 0,
      serversByNode: {},
      estimatedCommittedMonthlyMinor: 0,
      currency: 'EUR',
    },
    price: {
      currency: 'EUR',
      estimatedMonthlyMinor: 1_000,
      billingCadence: 'monthly' as const,
      contractMonths: 1,
    },
  },
  billing: {
    providerType: 'ovhcloud' as const,
    currency: 'EUR',
    estimatedMonthlyMinor: 1_000,
    billingCadence: 'monthly' as const,
    contractMonths: 1,
    committedMonthlyBeforeMinor: 0,
    projectedCommittedMonthlyMinor: 1_000,
    warnings: [],
  },
  selectionDigest: 'f'.repeat(64),
})

const automaticInput = (): ServerProvisionAtomicInput => ({
  ...input(),
  command: {
    ...input().command,
    context: {
      organizationId: 'org-a',
      actorId: 'operator-a',
      actorRole: 'administrator',
      actorMembershipRevision: 1,
      correlationId: 'correlation-server-provision-auto',
    },
    idempotencyKey: 'server-provision-key-auto',
  },
  fingerprint: 'e'.repeat(64),
  identity: {
    resourceId: 'server-provision-auto',
    operationId: 'operation-server-provision-auto',
    workflowStartRecordId: 'workflow-start-server-provision-auto',
    auditEventId: 'audit-server-provision-auto',
    outboxEventId: 'outbox-server-provision-auto',
  },
  plan: { ...provisionNodePlan(), reviewedNodeProvision: reviewedNodeProvision() },
})

describe('server provision parent D1 acceptance', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${migrationsDirectory}${migration}`, 'utf8'))
    seed()
    d1 = new SqliteD1(database)
  })
  afterEach(() => database.close())

  it('adopts the exact parent, audit, and workflow receipt after a committed response loss', async () => {
    const repository = makeServerProvisionRepositoryD1(d1)
    d1.loseResponseAfterCommitOnce = true

    const accepted = await Effect.runPromise(repository.acceptAtomic(input()))

    expect(accepted).toMatchObject({
      disposition: 'adopted',
      operationId: 'operation-server-provision-a',
      resourceId: 'server-provision-a',
      state: 'queued',
      plan: { kind: 'existing-node', nodeId: 'node-a' },
    })
    expect(
      database
        .prepare(
          'SELECT type, resource_type AS resourceType, resource_id AS resourceId, status FROM operations',
        )
        .get(),
    ).toEqual({
      type: 'server-provision-plan',
      resourceType: 'server-provision',
      resourceId: 'server-provision-a',
      status: 'queued',
    })
    const compactAudit = database
      .prepare(`SELECT result, target_type AS targetType, target_id AS targetId,
      summary_json AS summaryJson FROM audit_events WHERE id = 'audit-server-provision-a'`)
      .get() as {
      result: string
      targetType: string
      targetId: string
      summaryJson: string
    }
    expect(compactAudit).toMatchObject({
      result: 'succeeded',
      targetType: 'server-provision',
      targetId: 'server-provision-a',
    })
    expect(JSON.parse(compactAudit.summaryJson)).toMatchObject({
      operationId: 'operation-server-provision-a',
    })
    expect(
      database
        .prepare(`SELECT json_extract(envelope_json, '$.operationId') AS operationId,
        json_extract(envelope_json, '$.target.type') AS targetType,
        json_extract(envelope_json, '$.target.id') AS targetId,
        json_extract(envelope_json, '$.result') AS result,
        schema_version AS schemaVersion, capture_status AS captureStatus
        FROM audit_event_envelopes WHERE event_id = 'audit-server-provision-a'`)
        .get(),
    ).toEqual({
      operationId: 'operation-server-provision-a-accepted',
      targetType: 'server-provision',
      targetId: 'server-provision-a',
      result: 'succeeded',
      schemaVersion: 1,
      captureStatus: 'complete',
    })
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM server_provision_plan_runs').get(),
    ).toEqual({ count: 1 })

    const replay = await Effect.runPromise(repository.acceptAtomic(input()))
    expect(replay).toEqual(accepted)
  })

  it('records a terminal v1 failure audit for an accepted parent that never reaches node readiness', async () => {
    const repository = makeServerProvisionRepositoryD1(d1)
    await Effect.runPromise(repository.acceptAtomic(input()))

    await Effect.runPromise(
      repository.markFailed(
        'org-a',
        'operation-server-provision-a',
        'node provisioning reached a terminal failure',
        now,
      ),
    )

    expect(
      database
        .prepare(`SELECT phase, failure_reason AS failureReason, terminal_audit_event_id AS terminalAuditEventId
        FROM server_provision_plan_runs WHERE operation_id = 'operation-server-provision-a'`)
        .get(),
    ).toEqual({
      phase: 'failed',
      failureReason: 'node provisioning reached a terminal failure',
      terminalAuditEventId: 'audit-server-provision-failed:operation-server-provision-a',
    })
    expect(
      database
        .prepare(`SELECT status FROM operations WHERE id = 'operation-server-provision-a'`)
        .get(),
    ).toEqual({ status: 'failed_terminal' })
    expect(
      database
        .prepare(`SELECT json_extract(envelope_json, '$.action') AS action,
        json_extract(envelope_json, '$.result') AS result, schema_version AS schemaVersion,
        capture_status AS captureStatus
        FROM audit_event_envelopes
        WHERE event_id = 'audit-server-provision-failed:operation-server-provision-a'`)
        .get(),
    ).toEqual({
      action: 'server.provision.failed',
      result: 'failed',
      schemaVersion: 1,
      captureStatus: 'complete',
    })
  })

  it('rejects a foreign retirement child and adopts the exact compensation link after a lost D1 response', async () => {
    seedCompensationScaffold()
    seedRetirementChild('node-a', 'retire-node-a')
    seedRetirementChild('node-foreign', 'retire-node-foreign')
    const repository = makeServerProvisionRepositoryD1(d1)
    const accepted = await Effect.runPromise(repository.acceptAtomic(automaticInput()))
    const acceptanceSummary = JSON.parse(
      (
        database
          .prepare(`SELECT summary_json AS summaryJson FROM audit_events WHERE id = ?`)
          .get('audit-server-provision-auto') as { summaryJson: string }
      ).summaryJson,
    ) as Record<string, unknown>
    expect(acceptanceSummary).toMatchObject({
      pluginId: 'arma-reforger',
      pluginVersion: '0.1.0',
      pluginSelectionRevision: 1,
      providerType: 'ovhcloud',
      region: 'region-a',
      plan: 'plan-a',
      billingCadence: 'monthly',
      contractMonths: 1,
    })
    expect(accepted.plan).not.toHaveProperty('reviewedNodeProvision')
    const persisted = await Effect.runPromise(repository.load('org-a', accepted.operationId))
    expect(persisted.plan).toMatchObject({
      reviewedNodeProvision: {
        selectionDigest: 'f'.repeat(64),
        facts: { usage: { observedAtEpochMilliseconds: 1_777_000_000_000 } },
      },
    })
    await Effect.runPromise(
      repository.recordNodeProvision(
        'org-a',
        accepted.operationId,
        'node-a',
        'node-provision-a',
        now,
      ),
    )
    await Effect.runPromise(repository.markReadyForServer('org-a', accepted.operationId, now))

    await expect(
      Effect.runPromise(
        repository.recordCompensation(
          'org-a',
          accepted.operationId,
          'node-a',
          'retire-node-foreign',
          now,
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'ServerProvisionPersistenceError' })

    d1.loseResponseAfterCommitOnce = true
    await expect(
      Effect.runPromise(
        repository.recordCompensation(
          'org-a',
          accepted.operationId,
          'node-a',
          'retire-node-a',
          now,
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'ServerProvisionPersistenceError' })

    const adopted = await Effect.runPromise(
      repository.recordCompensation('org-a', accepted.operationId, 'node-a', 'retire-node-a', now),
    )
    expect(adopted).toMatchObject({
      phase: 'compensating',
      nodeId: 'node-a',
      nodeProvisionOperationId: 'node-provision-a',
      compensationOperationId: 'retire-node-a',
    })
    expect(
      database
        .prepare(`SELECT compensation_operation_id AS compensationOperationId, phase
        FROM server_provision_plan_runs WHERE organization_id = 'org-a' AND operation_id = ?`)
        .get(accepted.operationId),
    ).toEqual({ compensationOperationId: 'retire-node-a', phase: 'compensating' })
  })

  it('records exact temporary-node retirement before readiness succeeds', async () => {
    seedCompensationScaffold()
    seedRetirementChild('node-a', 'retire-node-a')
    const repository = makeServerProvisionRepositoryD1(d1)
    const accepted = await Effect.runPromise(repository.acceptAtomic(automaticInput()))
    await Effect.runPromise(
      repository.recordNodeProvision(
        'org-a',
        accepted.operationId,
        'node-a',
        'node-provision-a',
        now,
      ),
    )

    const compensated = await Effect.runPromise(
      repository.recordCompensation('org-a', accepted.operationId, 'node-a', 'retire-node-a', now),
    )

    expect(compensated).toMatchObject({
      phase: 'compensating',
      nodeId: 'node-a',
      nodeProvisionOperationId: 'node-provision-a',
      compensationOperationId: 'retire-node-a',
    })
  })
})

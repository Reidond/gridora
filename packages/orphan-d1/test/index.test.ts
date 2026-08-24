import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  OrphanClockLayer,
  OrphanControl,
  OrphanControlLive,
  OrphanDiscoveryPortLayer,
  OrphanRepositoryLayer,
  type OrphanDiscoverySnapshot,
  type OrphanReconciliationRequest,
} from '@gridora/orphan-control'
import {
  type OrphanD1Database,
  type OrphanD1Statement,
  makeOrphanD1Repository,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrationFiles = [
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
] as const

class SqliteStatement implements OrphanD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): OrphanD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
  run(): void {
    this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
  }
}

class SqliteD1 implements OrphanD1Database {
  loseNextBatchResponse = false
  beforeNextBatch: (() => void) | undefined
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): OrphanD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(statements: ReadonlyArray<OrphanD1Statement>): Promise<ReadonlyArray<unknown>> {
    const beforeBatch = this.beforeNextBatch
    this.beforeNextBatch = undefined
    beforeBatch?.()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) (statement as SqliteStatement).run()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    if (this.loseNextBatchResponse) {
      this.loseNextBatchResponse = false
      throw new Error('simulated response loss')
    }
    return statements.map(() => ({}))
  }
}

let database: DatabaseSync
let d1: SqliteD1
let schedulerActorId = ''

const request = (overrides: Partial<OrphanReconciliationRequest> = {}) => ({
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  providerType: 'ovhcloud' as const,
  runId: 'run-a',
  idempotencyKey: 'request-a',
  actorId: schedulerActorId,
  ...overrides,
})

const ownedResource = (organizationId = 'org-a', providerResourceId = 'instance-a') => ({
  kind: 'node' as const,
  providerResourceId,
  ownership: {
    managedBy: 'gridora',
    organizationId,
    nodeId: 'node-a',
    operationId: 'operation-a',
    imageVersion: '1.0.0',
  },
})

const snapshot = (
  command: OrphanReconciliationRequest,
  overrides: Partial<OrphanDiscoverySnapshot> = {},
): OrphanDiscoverySnapshot => ({
  organizationId: command.organizationId,
  providerAccountId: command.providerAccountId,
  providerType: command.providerType,
  credentialReference: `sealed-reference-${command.providerAccountId}`,
  credentialRevision: 1,
  requestId: command.runId,
  observedAt: '2026-08-23T10:00:00Z',
  complete: true,
  truncated: false,
  continuationToken: null,
  resources: [ownedResource()],
  removalEvidence: [],
  ...overrides,
})

const reconcile = async (
  command: OrphanReconciliationRequest,
  discovery: OrphanDiscoverySnapshot,
) => {
  const repository = makeOrphanD1Repository(d1, {
    now: () => '2026-08-23T10:05:00.000Z',
  })
  const dependencies = Layer.mergeAll(
    OrphanDiscoveryPortLayer({ discover: () => Effect.succeed(discovery) }),
    OrphanRepositoryLayer(repository),
    OrphanClockLayer(new Date('2026-08-23T10:05:00Z')),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* OrphanControl).reconcile(command)
    }).pipe(Effect.provide(OrphanControlLive.pipe(Layer.provide(dependencies)))),
  )
}

const seedIdentityAndOrganization = (identityId: string, organizationId: string, slug: string) => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', 'now', 'now')`)
    .run(identityId, `access-${identityId}`, `${identityId}@example.com`, identityId)
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now')`)
    .run(organizationId, organizationId, slug)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES (?, ?, 'automation', 'active', 'now', 1)`)
    .run(organizationId, identityId)
}

const seedProvider = (
  organizationId: string,
  accountId: string,
  providerType: 'ovhcloud' | 'contabo',
) => {
  database
    .prepare(`INSERT INTO secret_envelopes
      (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
       key_version, revision, created_at, rotated_at)
      VALUES (?, ?, 'provider-account', ?, 'ciphertext', 'wrapped', 1, 1, 'now', NULL)`)
    .run(organizationId, `sealed-reference-${accountId}`, accountId)
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference,
       status, revision, created_at, updated_at)
      VALUES (?, 'organization', ?, ?, ?, 'active', 1, 'now', 'now')`)
    .run(accountId, organizationId, providerType, `sealed-reference-${accountId}`)
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, status, revision)
      VALUES (?, ?, '["eu-west"]', '["small"]', 10, 'active', 1)`)
    .run(organizationId, accountId)
}

const seedAuthoritativeNode = () => {
  database
    .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type,
       region, plan, image_id, placement_mode, desired_state, observed_state,
       desired_revision, observed_revision, created_at, updated_at)
      VALUES ('org-a', 'node-a', 'account-a', 'instance-a', 'ovhcloud',
       'eu-west', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, 'now', 'now')`)
    .run()
  database
    .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status,
       progress, idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-a', 'org-a', 'node.provision', 'node', 'node-a', 'actor-a',
       'succeeded', 100, 'operation-key-a', 'operation-correlation-a', 1, 'now', 'now')`)
    .run()
}

const count = (table: string): number => {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }
  return row.count
}

describe('orphan D1 reconciliation', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    d1 = new SqliteD1(database)
    seedIdentityAndOrganization('actor-a', 'org-a', 'organization-a')
    seedIdentityAndOrganization('actor-b', 'org-b', 'organization-b')
    schedulerActorId = (
      database
        .prepare(`SELECT identity_id AS identityId FROM orphan_reconciliation_scheduler_identities
          WHERE organization_id = 'org-a'`)
        .get() as { readonly identityId: string }
    ).identityId
    seedProvider('org-a', 'account-a', 'ovhcloud')
    seedProvider('org-b', 'account-b', 'contabo')
    database
      .prepare(`INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at)
        VALUES ('image-a', '1.0.0', 'checksum-a', 'signature-a', '{}', 'promoted', 'now')`)
      .run()
  })

  afterEach(() => database.close())

  it('rejects foreign Gridora ownership without storing a finding or audit', async () => {
    const command = request()
    await expect(
      reconcile(command, snapshot(command, { resources: [ownedResource('org-b')] })),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    expect(count('orphan_findings')).toBe(0)
    expect(count('orphan_reconciliation_runs')).toBe(0)
    expect(count('audit_events')).toBe(0)
  })

  it('stores one finding and one secret-free audit across duplicate delivery', async () => {
    const command = request()
    const discovery = snapshot(command)
    const first = await reconcile(command, discovery)
    const replay = await reconcile(
      command,
      snapshot(command, { observedAt: '2026-08-23T09:00:00Z', resources: [] }),
    )
    expect(first).toMatchObject({ opened: 1, replayed: false })
    expect(replay).toEqual({ ...first, replayed: true })
    expect(count('orphan_findings')).toBe(1)
    expect(count('orphan_reconciliation_runs')).toBe(1)
    expect(count('audit_events')).toBe(1)
    expect(count('audit_export_requests')).toBe(1)
    expect(
      database
        .prepare(`SELECT schema_version AS version, capture_status AS captureStatus,
          json_extract(envelope_json, '$.source.origin') AS sourceOrigin,
          json_extract(envelope_json, '$.operationId') AS operationId,
          json_extract(envelope_json, '$.before.state') AS beforeState
          FROM audit_event_envelopes WHERE scope = 'tenant'`)
        .get(),
    ).toEqual({
      version: 1,
      captureStatus: 'complete',
      sourceOrigin: 'scheduler',
      operationId: 'orphan-audit-operation:org-a:run-a:1',
      beforeState: 'absent',
    })
    expect(
      database
        .prepare(`SELECT status, resource_type AS resourceType, resource_id AS resourceId,
          correlation_id AS correlationId FROM operations
          WHERE id = 'orphan-audit-operation:org-a:run-a:1'`)
        .get(),
    ).toEqual({
      status: 'succeeded',
      resourceType: 'orphan_finding',
      resourceId: 'account-a:instance-a',
      correlationId: 'run-a',
    })
    const audit = database
      .prepare('SELECT summary_json AS summaryJson FROM audit_events')
      .get() as {
      summaryJson: string
    }
    expect(JSON.parse(audit.summaryJson)).toEqual({
      severity: 'high',
      status: 'open',
      providerType: 'ovhcloud',
      providerAccountId: 'account-a',
      providerResourceId: 'instance-a',
      resourceKind: 'node',
    })
    expect(audit.summaryJson).not.toContain('sealed-reference')

    const rebound = request({ runId: 'different-run' })
    await expect(reconcile(rebound, snapshot(rebound))).rejects.toMatchObject({
      code: 'idempotency-conflict',
    })
  })

  it('adopts the committed result after the D1 batch response is lost', async () => {
    const command = request()
    d1.loseNextBatchResponse = true
    const result = await reconcile(command, snapshot(command))
    expect(result).toMatchObject({ opened: 1, replayed: true })
    expect(count('orphan_findings')).toBe(1)
    expect(count('orphan_reconciliation_runs')).toBe(1)
    expect(count('audit_events')).toBe(1)
    expect(count('audit_event_envelopes')).toBe(1)
    expect(count('audit_envelope_staging')).toBe(0)
    expect(
      database
        .prepare(`SELECT status FROM operations
          WHERE id = 'orphan-audit-operation:org-a:run-a:1'`)
        .get(),
    ).toEqual({ status: 'succeeded' })
  })

  it('rolls back every record when an allocation is disabled after discovery', async () => {
    const command = request()
    d1.beforeNextBatch = () => {
      database
        .prepare(`UPDATE provider_allocations
          SET status = 'disabled', revision = revision + 1
          WHERE organization_id = 'org-a' AND provider_account_id = 'account-a'`)
        .run()
    }

    await expect(reconcile(command, snapshot(command))).rejects.toMatchObject({
      code: 'persistence-failed',
    })
    expect(count('orphan_findings')).toBe(0)
    expect(count('orphan_reconciliation_runs')).toBe(0)
    expect(count('audit_events')).toBe(0)
  })

  it('rolls back every record when the exact provider credential rotates after discovery', async () => {
    const command = request()
    d1.beforeNextBatch = () => {
      database
        .prepare(`UPDATE secret_envelopes
          SET ciphertext = 'rotated-ciphertext', revision = revision + 1, rotated_at = 'now'
          WHERE organization_id = 'org-a' AND id = 'sealed-reference-account-a'`)
        .run()
    }

    await expect(reconcile(command, snapshot(command))).rejects.toMatchObject({
      code: 'persistence-failed',
    })
    expect(count('orphan_findings')).toBe(0)
    expect(count('orphan_reconciliation_runs')).toBe(0)
    expect(count('audit_events')).toBe(0)
  })

  it('rolls back the finding and run when its exact staged audit event collides', async () => {
    const targetId = 'account-a:instance-a'
    database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status,
         progress, idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES ('preexisting-orphan-audit-operation', 'org-a', 'orphan.finding.opened',
         'orphan_finding', ?, ?, 'succeeded', 100, 'preexisting-orphan-audit-key',
         'run-a', 1, '2026-08-23T10:05:00.000Z', '2026-08-23T10:05:00.000Z')`)
      .run(targetId, schedulerActorId)
    const stage = await Effect.runPromise(
      stageAuditEnvelope(
        'tenant',
        'orphan-audit:org-a:run-a:1',
        {
          version: 1,
          captureStatus: 'complete',
          occurredAt: '2026-08-23T10:05:00.000Z',
          scope: 'tenant',
          organizationId: 'org-a',
          actor: { type: 'system', id: schedulerActorId },
          request: { id: 'run-a', correlationId: 'run-a' },
          action: 'orphan.finding.opened',
          target: { type: 'orphan_finding', id: targetId },
          before: { state: 'absent', reason: 'orphan-finding-did-not-exist' },
          after: {
            state: 'captured',
            summary: {
              severity: 'high',
              status: 'open',
              providerType: 'ovhcloud',
              providerAccountId: 'account-a',
              providerResourceId: 'instance-a',
              resourceKind: 'node',
            },
          },
          operationId: 'preexisting-orphan-audit-operation',
          source: {
            origin: 'scheduler',
            ip: { state: 'not-available', reason: 'scheduler-has-no-client-ip' },
            access: { state: 'not-available', reason: 'scheduler-has-no-access-session' },
          },
          result: 'succeeded',
          error: { classification: 'none', code: null },
          forced: false,
          breakGlass: false,
        },
        '2026-08-23T10:05:00.000Z',
      ),
    )
    database.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
    database
      .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES ('orphan-audit:org-a:run-a:1', 'org-a', ?, 'orphan.finding.opened',
         'orphan_finding', ?, 'succeeded', 'run-a',
         '{"severity":"high","status":"open","providerType":"ovhcloud","providerAccountId":"account-a","providerResourceId":"instance-a","resourceKind":"node"}',
         '2026-08-23T10:05:00.000Z')`)
      .run(schedulerActorId, targetId)
    const command = request()
    await expect(reconcile(command, snapshot(command))).rejects.toMatchObject({
      code: 'persistence-failed',
    })
    expect(count('orphan_findings')).toBe(0)
    expect(count('orphan_reconciliation_runs')).toBe(0)
    expect(count('audit_events')).toBe(1)
  })

  it('rejects stale discovery before any reconciliation record is written', async () => {
    const command = request()
    await expect(
      reconcile(command, snapshot(command, { observedAt: '2026-08-23T09:00:00Z' })),
    ).rejects.toMatchObject({ code: 'stale-discovery' })
    expect(count('orphan_findings')).toBe(0)
    expect(count('orphan_reconciliation_runs')).toBe(0)
  })

  it('rejects a fresh but reordered provider snapshot for the same allocation', async () => {
    const newer = request()
    await reconcile(newer, snapshot(newer, { observedAt: '2026-08-23T10:04:00Z' }))

    const older = request({ runId: 'run-b', idempotencyKey: 'request-b' })
    await expect(
      reconcile(older, snapshot(older, { observedAt: '2026-08-23T10:03:00Z' })),
    ).rejects.toMatchObject({ code: 'stale-discovery' })
    expect(count('orphan_reconciliation_runs')).toBe(1)
    expect(count('audit_events')).toBe(1)
    expect(database.prepare('SELECT revision FROM orphan_findings').get()).toEqual({ revision: 1 })
  })

  it('rejects a distinct snapshot at the same observed time while preserving exact replay', async () => {
    const first = request()
    const observedAt = '2026-08-23T10:04:00Z'
    const committed = await reconcile(first, snapshot(first, { observedAt }))
    expect(await reconcile(first, snapshot(first, { observedAt }))).toEqual({
      ...committed,
      replayed: true,
    })

    const distinct = request({ runId: 'run-equal', idempotencyKey: 'request-equal' })
    await expect(
      reconcile(distinct, snapshot(distinct, { observedAt, resources: [] })),
    ).rejects.toMatchObject({ code: 'stale-discovery' })
    expect(count('orphan_reconciliation_runs')).toBe(1)

    expect(() =>
      database
        .prepare(`INSERT INTO orphan_reconciliation_runs
          (organization_id, idempotency_key, run_id, provider_account_id, provider_type,
           credential_reference, credential_revision, actor_id, discovery_fingerprint,
           discovery_observed_at, result_json, completed_at)
          SELECT organization_id, 'request-trigger', 'run-trigger', provider_account_id,
           provider_type, credential_reference, credential_revision, actor_id,
           discovery_fingerprint, discovery_observed_at, result_json, completed_at
          FROM orphan_reconciliation_runs WHERE organization_id = 'org-a' AND run_id = 'run-a'`)
        .run(),
    ).toThrow(/stale orphan discovery/)
  })

  it('resolves an open finding only after exact authoritative adoption appears', async () => {
    const firstCommand = request()
    await reconcile(firstCommand, snapshot(firstCommand))
    seedAuthoritativeNode()

    const secondCommand = request({ runId: 'run-b', idempotencyKey: 'request-b' })
    const result = await reconcile(
      secondCommand,
      snapshot(secondCommand, { observedAt: '2026-08-23T10:01:00Z' }),
    )
    expect(result).toMatchObject({ resolved: 1, replayed: false })
    expect(
      database
        .prepare(`SELECT status, resolution_kind AS resolutionKind,
          resolution_evidence_id AS resolutionEvidenceId, revision
          FROM orphan_findings`)
        .get(),
    ).toEqual({
      status: 'resolved',
      resolutionKind: 'authoritative-adoption',
      resolutionEvidenceId: 'operation-a',
      revision: 2,
    })
    expect(count('audit_events')).toBe(2)
  })

  it('uses only the canonical provision operation despite unrelated operation history', async () => {
    seedAuthoritativeNode()
    const insert = database.prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status,
       progress, idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, 'org-a', ?, 'node', 'node-a', 'actor-a', 'succeeded', 100, ?, ?, 1, 'now', 'now')`)
    for (let index = 0; index < 250; index += 1)
      insert.run(
        `historical-${index}`,
        index % 2 === 0 ? 'node.rebuild' : 'node.restart',
        `historical-key-${index}`,
        `historical-correlation-${index}`,
      )

    const command = request()
    const result = await reconcile(command, snapshot(command))
    expect(result).toMatchObject({ opened: 0, unchanged: 1 })
    expect(count('orphan_findings')).toBe(0)
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM operations
        WHERE organization_id = 'org-a' AND resource_type = 'node'
          AND resource_id = 'node-a' AND type = 'node.provision' AND status = 'succeeded'
        ORDER BY id LIMIT 2`)
      .all() as unknown as ReadonlyArray<{ readonly detail: string }>
    expect(plan.some(({ detail }) => detail.includes('operations_legacy_node_provision'))).toBe(
      true,
    )
  })

  it('fails closed when a legacy node has more than one successful provision operation', async () => {
    seedAuthoritativeNode()
    database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status,
         progress, idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES ('operation-ambiguous', 'org-a', 'node.provision', 'node', 'node-a', 'actor-a',
         'succeeded', 100, 'operation-key-ambiguous', 'operation-correlation-ambiguous', 1, 'now', 'now')`)
      .run()

    const command = request()
    const result = await reconcile(command, snapshot(command))
    expect(result).toMatchObject({ opened: 1 })
    expect(count('orphan_findings')).toBe(1)
  })

  it('keeps a missing resource open until explicit provider-removal evidence arrives', async () => {
    const firstCommand = request()
    await reconcile(firstCommand, snapshot(firstCommand))

    const absentCommand = request({ runId: 'run-b', idempotencyKey: 'request-b' })
    await reconcile(
      absentCommand,
      snapshot(absentCommand, { observedAt: '2026-08-23T10:01:00Z', resources: [] }),
    )
    expect(database.prepare('SELECT status, revision FROM orphan_findings').get()).toEqual({
      status: 'open',
      revision: 1,
    })

    const removalCommand = request({ runId: 'run-c', idempotencyKey: 'request-c' })
    await reconcile(
      removalCommand,
      snapshot(removalCommand, {
        observedAt: '2026-08-23T10:02:00Z',
        resources: [],
        removalEvidence: [
          {
            providerResourceId: 'instance-a',
            evidenceId: 'provider-absence-a',
            observedAt: '2026-08-23T10:02:00Z',
            kind: 'provider-removal',
          },
        ],
      }),
    )
    expect(
      database
        .prepare(`SELECT status, resolution_kind AS resolutionKind,
          resolution_evidence_id AS resolutionEvidenceId, revision
          FROM orphan_findings`)
        .get(),
    ).toEqual({
      status: 'resolved',
      resolutionKind: 'provider-removal',
      resolutionEvidenceId: 'provider-absence-a',
      revision: 2,
    })
  })

  it('ignores unknown provider resources and rejects tenant/account rebinding', async () => {
    const command = request()
    const unmanaged = snapshot(command, {
      resources: [{ kind: 'node', providerResourceId: 'human-vps-a', ownership: null }],
    })
    expect(await reconcile(command, unmanaged)).toMatchObject({ unchanged: 0 })
    expect(count('orphan_findings')).toBe(0)
    expect(count('audit_events')).toBe(0)

    const foreignAccountCommand = request({
      providerAccountId: 'account-b',
      providerType: 'contabo',
      runId: 'run-foreign',
      idempotencyKey: 'request-foreign',
    })
    await expect(
      reconcile(foreignAccountCommand, snapshot(foreignAccountCommand, { resources: [] })),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    expect(count('orphan_reconciliation_runs')).toBe(1)
  })
})

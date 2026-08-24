import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeGameLifecycleD1Repository,
  makeGameLifecycleCompletionD1Repository,
  makeGameLifecyclePlanningD1Repository,
  makeGameLifecycleObservationD1Repository,
  makeGameLifecycleCleanupD1Repository,
  type GameLifecycleD1Database,
  type GameLifecycleD1Statement,
} from '../src/index.js'
import type {
  GameCreateIntent,
  GameDeploymentPlan,
  GameMutationIntent,
  GameLifecycleRepository,
} from '@gridora/game-lifecycle-control'

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))

class SqliteStatement implements GameLifecycleD1Statement {
  private values: readonly unknown[] = []
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}
  bind(...values: readonly unknown[]): GameLifecycleD1Statement {
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

class SqliteD1 implements GameLifecycleD1Database {
  private loseNextResponse = false
  constructor(readonly database: DatabaseSync) {}
  loseNextBatchResponseAfterCommit(): void {
    this.loseNextResponse = true
  }
  prepare(sql: string): GameLifecycleD1Statement {
    return new SqliteStatement(this.database, sql)
  }
  async batch(statements: readonly GameLifecycleD1Statement[]): Promise<readonly unknown[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) (statement as SqliteStatement).run()
      this.database.exec('COMMIT')
    } catch (cause) {
      this.database.exec('ROLLBACK')
      throw cause
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      throw new Error('simulated D1 response loss after durable commit')
    }
    return []
  }
}

let database: DatabaseSync
let d1: SqliteD1
let operationSequence = 0
let auditSequence = 0
let outboxSequence = 0

const applyMigrations = () => {
  for (let id = 1; id <= 25; id += 1) {
    const files = [
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
    ]
    database.exec(readFileSync(`${sqlDirectory}${files[id - 1]}`, 'utf8'))
  }
  // Keep this behavioral fixture on the same audit/provenance path as the
  // Worker: terminal game receipts must be able to stage a complete v1
  // envelope, not only exercise the pre-envelope game fence.
  for (const file of [
    '0026_organization_membership_leave.sql',
    '0027_game_command_envelope.sql',
    '0028_audit_envelope_v1.sql',
    '0029_telemetry_ingestion_receipts.sql',
    '0030_scheduled_backups.sql',
    '0031_core_mutation_operations.sql',
    '0032_policy_identifier_contract.sql',
    '0033_organization_deletion_audit_provenance.sql',
  ]) {
    database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
  }
  database.exec(readFileSync(`${sqlDirectory}0034_game_audit_terminal_operations.sql`, 'utf8'))
  database.exec(readFileSync(`${sqlDirectory}0035_cancellation_audit_provenance.sql`, 'utf8'))
  database.exec(readFileSync(`${sqlDirectory}0036_game_server_move_execution.sql`, 'utf8'))
  database.exec(readFileSync(`${sqlDirectory}0039_game_lifecycle_completion_audit.sql`, 'utf8'))
  database.exec(
    readFileSync(`${sqlDirectory}0051_game_lifecycle_terminal_move_dns_repair.sql`, 'utf8'),
  )
  database.exec(
    readFileSync(`${sqlDirectory}0059_game_server_declarative_desired_specs.sql`, 'utf8'),
  )
  database.exec(readFileSync(`${sqlDirectory}0061_game_mod_metadata_acceptance.sql`, 'utf8'))
}

const seed = () => {
  database
    .prepare(
      `INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('identity-a', 'access-a', 'a@example.com', 'A', 'active', 'now', 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES ('org-a', 'A', 'a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at)
    VALUES ('org-a', 'identity-a', 'owner', 'active', 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO provider_accounts
    (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
    VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'provider-envelope-a', 'active', 1, 'now', 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO provider_allocations
    (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
    VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 3, 'active', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO node_images
    (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
    VALUES ('image-a', '1', 'checksum', 'signature', '{}', 'promoted', 'now', 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO nodes
    (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
     placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
    VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small', 'image-a',
     'shared', 'ready', 'ready', 1, 1, 'now', 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO node_runtime_capacity
    (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes, agent_ready, tunnel_ready,
     docker_ready, firewall_ready, reported_at, revision)
    VALUES ('org-a', 'node-a', 'amd64', 16_000, 64 * 1024 * 1024 * 1024, 500 * 1024 * 1024 * 1024,
     1, 1, 1, 1, '2026-08-23T12:00:00.000Z', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO node_player_endpoints
       (organization_id, node_id, provider_instance_id, record_type, target, source,
        observed_revision, revision, observed_at, created_at, updated_at)
       VALUES ('org-a', 'node-a', 'instance-a', 'A', '203.0.113.10', 'provider',
               1, 1, '2026-08-23T12:00:00.000Z', 'now', 'now')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO game_plugins
    (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('arma-reforger', '0.1.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO organization_policies
       (organization_id, policy_json, revision, updated_by, updated_at)
       VALUES ('org-a', ?, 1, 'identity-a', '2026-08-23T12:00:00.000Z')`,
    )
    .run(
      JSON.stringify({
        revision: 1,
        allowedProviders: ['ovhcloud'],
        allowedRegions: ['eu-west'],
        allowedPlans: ['small'],
        capacity: {
          maxDeploymentCpuMillis: 4_000,
          maxDeploymentRamBytes: 8_589_934_592,
          maxDeploymentDiskBytes: 107_374_182_400,
          maxServersPerNode: 4,
        },
      }),
    )
  database
    .prepare(
      `INSERT INTO provider_catalog
       (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor, metadata_json, refreshed_at)
       VALUES ('ovhcloud', 'eu-west', 'small', 'EUR', 1, 100, '{}', '2026-08-23T12:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO server_plugin_channels
       (plugin_id, active_version, plan_contract_json, revision, updated_at)
       VALUES ('arma-reforger', '0.1.0', ?, 1, '2026-08-23T12:00:00.000Z')`,
    )
    .run(
      JSON.stringify({
        architecture: 'amd64',
        sharedNodeAllowed: true,
        minimum: { cpuMillis: 1_000, ramBytes: 2_147_483_648, diskBytes: 21_474_836_480 },
        maximum: { cpuMillis: 4_000, ramBytes: 8_589_934_592, diskBytes: 107_374_182_400 },
        ports: [
          { name: 'game', protocol: 'udp', containerPort: 2001, preferredPublicPort: null },
          { name: 'query', protocol: 'udp', containerPort: 17777, preferredPublicPort: null },
        ],
      }),
    )
}

const plan: GameDeploymentPlan = {
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  nodeId: 'node-a',
  placementMode: 'shared',
  resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
  ports: [
    { protocol: 'udp', containerPort: 2001, publicPort: 2001, purpose: 'game' },
    {
      protocol: 'udp',
      containerPort: 17777,
      publicPort: 17777,
      purpose: 'query',
    },
  ],
  image: {
    installer: `sha256:${'a'.repeat(64)}`,
    runtime: `sha256:${'b'.repeat(64)}`,
  },
  loginMode: 'anonymous',
  config: {
    name: 'Frontline',
    scenarioId: 'scenario',
    maxPlayers: 32,
    visible: true,
    crossPlatform: true,
  },
  mods: [],
  controlPlan: {
    modMetadata: {
      state: 'resolved',
      catalog: [],
      provenance: [
        {
          provider: 'arma-reforger-workshop',
          endpoint: 'https://reforger.armaplatform.com/workshop/api/mods',
          fetchedAt: '2026-08-23T11:59:00.000Z',
          expiresAt: '2026-08-23T12:04:00.000Z',
          cache: 'revalidated',
          bodySha256: 'a'.repeat(64),
          etag: 'fixture-etag',
        },
      ],
      warnings: [],
    },
  } as unknown as GameDeploymentPlan['controlPlan'],
  policyRevision: 1,
  pluginSelectionRevision: 1,
  nodeDesiredRevision: 1,
  capacityRevision: 1,
  allocationRevision: 1,
  catalogRefreshedAt: '2026-08-23T12:00:00.000Z',
}

const createIntent: GameCreateIntent = {
  schemaVersion: 1,
  name: 'Frontline',
  pluginId: 'arma-reforger',
  placement: { mode: 'shared', nodeId: 'node-a' },
  config: plan.config,
  mods: [],
}

const auditRequestContext = (correlationId: string) => ({
  origin: 'http' as const,
  requestId: 'request-game-lifecycle-test',
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

type CreateInput = Parameters<GameLifecycleRepository['create']>[0]
type MutationInput = Parameters<GameLifecycleRepository['mutate']>[0]

const repository = () => {
  const base = makeGameLifecycleD1Repository(d1, {
    now: () => '2026-08-23T12:00:00.000Z',
    operationId: () => `operation-${++operationSequence}`,
    serverId: () => 'server-a',
    deploymentId: () => 'deployment-a',
    capacityReservationId: () => 'capacity-a',
    auditEventId: () => `audit-${++auditSequence}`,
    outboxEventId: () => `outbox-${++outboxSequence}`,
  })
  return {
    ...base,
    create: (input: Omit<CreateInput, 'auditRequestContext' | 'auditActorType'>) =>
      base.create({
        ...input,
        auditRequestContext: auditRequestContext(input.correlationId),
        auditActorType: 'human',
      }),
    mutate: (input: Omit<MutationInput, 'auditRequestContext' | 'auditActorType'>) =>
      base.mutate({
        ...input,
        auditRequestContext: auditRequestContext(input.correlationId),
        auditActorType: 'human',
      }),
  }
}

const observe = (serverId: string, operationId: string, revision: number, state: string) => {
  database
    .prepare(
      `INSERT INTO game_observation_reductions
    (organization_id, server_id, observed_revision, observed_state, operation_id, observation_json, observed_at)
    VALUES ('org-a', ?, ?, ?, ?, ?, '2026-08-23T12:01:00.000Z')`,
    )
    .run(serverId, revision, state, operationId, JSON.stringify({ state }))
}

const completeAccepted = async (
  acceptance: {
    readonly operation: {
      readonly operationId: string
      readonly serverId: string
      readonly action: string
    }
  },
  action:
    | 'create'
    | 'delete'
    | 'start'
    | 'stop'
    | 'restart'
    | 'update'
    | 'apply-config'
    | 'sync-mods'
    | 'move',
  now = '2026-08-23T12:02:00.000Z',
) =>
  Effect.runPromise(
    makeGameLifecycleCompletionD1Repository(d1).complete({
      organizationId: 'org-a',
      lifecycleOperationId: acceptance.operation.operationId,
      serverId: acceptance.operation.serverId,
      action,
      stepName: action === 'create' ? 'publish-endpoint' : 'verify-observation',
      evidence: { test: 'authoritative-observation' },
      now,
    }),
  )

describe('game lifecycle D1 repository', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    applyMigrations()
    seed()
    d1 = new SqliteD1(database)
    operationSequence = 0
    auditSequence = 0
    outboxSequence = 0
  })
  afterEach(() => database.close())

  it('atomically accepts create with capacity, exact protocol leases, audit, outbox, and pending workflow start', async () => {
    const accepted = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan,
      }),
    )
    expect(accepted.operation.serverId).toBe('server-a')
    expect(database.prepare('SELECT count(*) AS count FROM deployments').get()).toEqual({
      count: 1,
    })
    expect(
      database
        .prepare(
          'SELECT protocol, public_port, container_port, state FROM port_leases ORDER BY public_port',
        )
        .all(),
    ).toEqual([
      {
        protocol: 'udp',
        public_port: 2001,
        container_port: 2001,
        state: 'reserved',
      },
      {
        protocol: 'udp',
        public_port: 17777,
        container_port: 17777,
        state: 'reserved',
      },
    ])
    expect(database.prepare('SELECT state FROM lifecycle_workflow_starts').get()).toEqual({
      state: 'pending',
    })
    expect(database.prepare('SELECT status FROM operations').get()).toEqual({
      status: 'queued',
    })
    expect(
      database
        .prepare(
          `SELECT operation_id, server_id, plugin_id, resolution_state,
                  json_array_length(provenance_json) AS provenance_count
             FROM game_mod_metadata_acceptances`,
        )
        .get(),
    ).toEqual({
      operation_id: accepted.operation.operationId,
      server_id: 'server-a',
      plugin_id: 'arma-reforger',
      resolution_state: 'resolved',
      provenance_count: 1,
    })
    expect(
      JSON.stringify(database.prepare('SELECT summary_json FROM audit_events').get()),
    ).not.toContain('password')
    expect(
      database
        .prepare("SELECT target_type AS targetType FROM audit_events WHERE id = 'audit-1'")
        .get(),
    ).toEqual({ targetType: 'server' })
    expect(
      database
        .prepare('SELECT status, resource_type AS resourceType FROM operations WHERE id = ?')
        .get(`audit:${accepted.operation.operationId}`),
    ).toEqual({ status: 'succeeded', resourceType: 'server' })
    const replay = await Effect.runPromise(
      repository().findIdempotent('org-a', 'create-a', accepted.operation.fingerprint),
    )
    expect(replay).toMatchObject({
      disposition: 'adopted',
      workflowState: 'pending-reconciliation',
      operation: { actorId: 'identity-a', state: 'queued' },
    })

    // Placement facts can change after acceptance (the reserved ports are now
    // live).  The same request key must adopt the original operation rather
    // than hash a newly allocated port plan and report a false conflict.
    const changedPlanReplay = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan: {
          ...plan,
          ports: plan.ports.map((port) => ({
            ...port,
            publicPort: port.publicPort + 100,
          })),
        },
      }),
    )
    expect(changedPlanReplay).toMatchObject({
      disposition: 'adopted',
      operation: { operationId: accepted.operation.operationId },
    })
  })

  it("snapshots the selected node's authoritative DNS endpoint rather than a shared target", async () => {
    database
      .prepare(
        `INSERT INTO nodes
          (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
           placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
         VALUES ('org-a', 'node-b', 'provider-a', 'instance-b', 'ovhcloud', 'eu-west', 'small', 'image-a',
           'shared', 'ready', 'ready', 1, 1, 'now', 'now')`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO node_runtime_capacity
          (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
           agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
         VALUES ('org-a', 'node-b', 'amd64', 16_000, 64 * 1024 * 1024 * 1024,
           500 * 1024 * 1024 * 1024, 1, 1, 1, 1, '2026-08-23T12:00:00.000Z', 1)`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO node_player_endpoints
          (organization_id, node_id, provider_instance_id, record_type, target, source,
           observed_revision, revision, observed_at, created_at, updated_at)
         VALUES ('org-a', 'node-b', 'instance-b', 'A', '198.51.100.42', 'provider',
           1, 1, '2026-08-23T12:00:00.000Z', 'now', 'now')`,
      )
      .run()

    const accepted = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-domain-authority-a',
        correlationId: 'corr-domain-authority-a',
        intent: { ...createIntent, domain: 'server.example.test' },
        plan: { ...plan, domain: 'server.example.test' },
      }),
    )

    expect(
      database
        .prepare(`SELECT node_id AS nodeId, provider_instance_id AS providerInstanceId,
          record_type AS recordType, target, endpoint_revision AS endpointRevision
          FROM game_lifecycle_dns_authorities
          WHERE organization_id = 'org-a' AND operation_id = ?`)
        .get(accepted.operation.operationId),
    ).toEqual({
      nodeId: 'node-a',
      providerInstanceId: 'instance-a',
      recordType: 'A',
      target: '203.0.113.10',
      endpointRevision: 1,
    })
    expect(
      database
        .prepare(
          `SELECT target FROM dns_records WHERE organization_id = 'org-a' AND server_id = 'server-a'`,
        )
        .get(),
    ).toEqual({ target: '203.0.113.10' })
  })

  it('fails closed when the selected deployment node has no authoritative player endpoint', async () => {
    database
      .prepare(
        `DELETE FROM node_player_endpoints WHERE organization_id = 'org-a' AND node_id = 'node-a'`,
      )
      .run()

    await expect(
      Effect.runPromise(
        repository().create({
          organizationId: 'org-a',
          actorId: 'identity-a',
          idempotencyKey: 'create-domain-missing-authority-a',
          correlationId: 'corr-domain-missing-authority-a',
          intent: { ...createIntent, domain: 'server.example.test' },
          plan: { ...plan, domain: 'server.example.test' },
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'GameLifecyclePlacementError', serverId: 'server-a' })
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT count(*) AS count FROM game_servers').get()).toEqual({
      count: 0,
    })
  })

  it('stages a complete v1 audit envelope when the post-0028 ledger is present', async () => {
    const accepted = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-envelope-a',
        correlationId: 'corr-envelope-a',
        intent: createIntent,
        plan,
      }),
    )
    const envelope = database
      .prepare(
        `SELECT scope, organization_id AS organizationId, schema_version AS schemaVersion,
         capture_status AS captureStatus, json_extract(envelope_json, '$.operationId') AS operationId,
         json_extract(envelope_json, '$.after.summary.pluginId') AS pluginId,
         json_extract(envelope_json, '$.request.id') AS requestId,
         json_extract(envelope_json, '$.request.correlationId') AS correlationId,
         json_extract(envelope_json, '$.source.ip.value') AS sourceIp,
         json_extract(envelope_json, '$.source.access.value.subject') AS accessSubject,
         json_type(envelope_json, '$.after.revision') AS topLevelAfterRevision
         FROM audit_event_envelopes WHERE event_id = 'audit-1'`,
      )
      .get()
    expect(envelope).toMatchObject({
      scope: 'tenant',
      organizationId: 'org-a',
      schemaVersion: 1,
      captureStatus: 'complete',
      operationId: `audit:${accepted.operation.operationId}`,
      pluginId: 'arma-reforger',
      requestId: 'request-game-lifecycle-test',
      correlationId: 'corr-envelope-a',
      sourceIp: '203.0.113.10',
      accessSubject: 'access-a',
      topLevelAfterRevision: null,
    })
    expect(database.prepare('SELECT count(*) AS count FROM audit_envelope_staging').get()).toEqual({
      count: 0,
    })
  })

  it('commits and adopts one terminal completion operation, v1 envelope, and evidence receipt', async () => {
    const accepted = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-completion-a',
        correlationId: 'corr-completion-a',
        intent: createIntent,
        plan,
      }),
    )
    observe('server-a', accepted.operation.operationId, 1, 'running')
    const completion = makeGameLifecycleCompletionD1Repository(d1)
    const input = {
      organizationId: 'org-a',
      lifecycleOperationId: accepted.operation.operationId,
      serverId: accepted.operation.serverId,
      action: 'create' as const,
      stepName: 'publish-endpoint',
      evidence: { dns: 'absent' },
      now: '2026-08-23T12:02:00.000Z',
    }
    const first = await Effect.runPromise(completion.complete(input))
    expect(first).toMatchObject({
      disposition: 'created',
      action: 'create',
      stepName: 'publish-endpoint',
      state: 'succeeded',
      lifecycleOperationRevision: 2,
      revision: 1,
    })
    const second = await Effect.runPromise(
      completion.complete({
        ...input,
        evidence: { dns: 'tampered-after-response-loss' },
        now: '2026-08-23T12:03:00.000Z',
      }),
    )
    expect(second).toEqual({ ...first, disposition: 'adopted' })
    expect(
      database.prepare(`SELECT count(*) AS count FROM game_lifecycle_completion_receipts`).get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM audit_event_envelopes WHERE schema_version = 1 AND event_id = ?`,
        )
        .get(first.completionEventId),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT status, resource_type, resource_id FROM operations WHERE id = ?`)
        .get(first.completionOperationId),
    ).toEqual({ status: 'succeeded', resource_type: 'server', resource_id: 'server-a' })
    expect(
      database
        .prepare(`SELECT status, progress, revision FROM operations WHERE id = ?`)
        .get(accepted.operation.operationId),
    ).toEqual({
      status: 'succeeded',
      progress: 100,
      revision: 2,
    })
    expect(
      database
        .prepare(
          `SELECT pending_lifecycle_operation_id AS pending FROM game_servers WHERE id = 'server-a'`,
        )
        .get(),
    ).toEqual({ pending: null })
    await expect(
      Effect.runPromise(completion.complete({ ...input, serverId: 'foreign-server' })),
    ).rejects.toMatchObject({ _tag: 'GameLifecycleD1Error' })
  })

  it('adopts a response-lost original-operation terminalization without forcing its status', async () => {
    const accepted = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-completion-response-loss-a',
        correlationId: 'corr-completion-response-loss-a',
        intent: createIntent,
        plan,
      }),
    )
    observe('server-a', accepted.operation.operationId, 1, 'running')
    d1.loseNextBatchResponseAfterCommit()

    const completion = await Effect.runPromise(
      makeGameLifecycleCompletionD1Repository(d1).complete({
        organizationId: 'org-a',
        lifecycleOperationId: accepted.operation.operationId,
        serverId: accepted.operation.serverId,
        action: 'create',
        stepName: 'publish-endpoint',
        evidence: { dns: 'absent' },
        now: '2026-08-23T12:02:00.000Z',
      }),
    )

    expect(completion).toMatchObject({
      disposition: 'adopted',
      lifecycleOperationRevision: 2,
      state: 'succeeded',
    })
    expect(
      database
        .prepare(`SELECT status, progress, revision FROM operations WHERE id = ?`)
        .get(accepted.operation.operationId),
    ).toEqual({ status: 'succeeded', progress: 100, revision: 2 })
    await expect(
      Effect.runPromise(
        makeGameLifecycleCompletionD1Repository(d1).complete({
          organizationId: 'org-a',
          lifecycleOperationId: 'foreign-operation',
          serverId: accepted.operation.serverId,
          action: 'create',
          stepName: 'publish-endpoint',
          evidence: { dns: 'absent' },
          now: '2026-08-23T12:02:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'GameLifecycleD1Error' })
  })

  it('does not leak a foreign tenant and rolls the batch back', async () => {
    await expect(
      repository()
        .create({
          organizationId: 'org-b',
          actorId: 'identity-a',
          idempotencyKey: 'create-b',
          correlationId: 'corr-b',
          intent: createIntent,
          plan,
        })
        .pipe(Effect.runPromise),
    ).rejects.toBeDefined()
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 0 })
  })

  it('requires an observation before the next mutation and rejects stale config evidence atomically', async () => {
    const created = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan,
      }),
    )
    observe('server-a', created.operation.operationId, 1, 'running')
    await completeAccepted(created, 'create')
    const before = database
      .prepare('SELECT desired_revision AS revision FROM game_servers WHERE id = ?')
      .get('server-a')
    const stale: GameMutationIntent = {
      action: 'apply-config',
      expectedConfigRevision: 99,
      config: {
        name: 'Frontline',
        scenarioId: 'scenario',
        maxPlayers: 32,
        visible: true,
        crossPlatform: true,
      },
    }
    await expect(
      repository()
        .mutate({
          organizationId: 'org-a',
          actorId: 'identity-a',
          idempotencyKey: 'config-stale',
          correlationId: 'corr-c',
          serverId: 'server-a',
          expectedRevision: 1,
          intent: stale,
        })
        .pipe(Effect.runPromise),
    ).rejects.toBeDefined()
    expect(
      database
        .prepare('SELECT desired_revision AS revision FROM game_servers WHERE id = ?')
        .get('server-a'),
    ).toEqual(before)
    expect(
      database
        .prepare("SELECT count(*) AS count FROM operations WHERE type = 'server.configure'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('rechecks active tenant membership at the final mutation fence', async () => {
    const created = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan,
      }),
    )
    observe('server-a', created.operation.operationId, 1, 'running')
    await completeAccepted(created, 'create')
    database
      .prepare(
        `UPDATE organization_memberships
         SET role = 'viewer', revision = revision + 1
         WHERE organization_id = 'org-a' AND identity_id = 'identity-a'`,
      )
      .run()
    await expect(
      repository()
        .mutate({
          organizationId: 'org-a',
          actorId: 'identity-a',
          idempotencyKey: 'start-after-demotion',
          correlationId: 'corr-demoted',
          serverId: 'server-a',
          expectedRevision: 1,
          intent: { action: 'start' },
        })
        .pipe(Effect.runPromise),
    ).rejects.toBeDefined()
    expect(
      database
        .prepare(`SELECT desired_revision AS revision FROM game_servers WHERE id = 'server-a'`)
        .get(),
    ).toEqual({ revision: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 3 })
  })

  it('accepts config apply only when the active deployment and config revision fence agree', async () => {
    const created = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan,
      }),
    )
    observe('server-a', created.operation.operationId, 1, 'running')
    await completeAccepted(created, 'create')
    const accepted = await Effect.runPromise(
      repository().mutate({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'config-a',
        correlationId: 'corr-c',
        serverId: 'server-a',
        expectedRevision: 1,
        intent: {
          action: 'apply-config',
          expectedConfigRevision: 1,
          config: plan.config,
        },
      }),
    )
    expect(accepted.operation.action).toBe('apply-config')
    expect(
      database.prepare('SELECT active_config_revision AS revision FROM game_servers').get(),
    ).toEqual({ revision: 2 })
  })

  it('exposes only the operation-bound authoritative observation and proves absent DNS ownership', async () => {
    const created = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan,
      }),
    )
    const observation = makeGameLifecycleObservationD1Repository(d1)
    await expect(
      Effect.runPromise(
        observation.verifyNoDns('org-a', 'server-a', created.operation.operationId),
      ),
    ).resolves.toEqual({
      organizationId: 'org-a',
      serverId: 'server-a',
      operationId: created.operation.operationId,
    })
    await expect(
      Effect.runPromise(observation.verifyNoDns('org-a', 'server-a', 'foreign-operation')),
    ).rejects.toMatchObject({
      _tag: 'GameLifecycleD1Error',
    })
    database
      .prepare(
        `UPDATE game_servers SET domain = 'configured.example.test' WHERE organization_id = 'org-a' AND id = 'server-a'`,
      )
      .run()
    await expect(
      Effect.runPromise(
        observation.verifyNoDns('org-a', 'server-a', created.operation.operationId),
      ),
    ).rejects.toMatchObject({
      _tag: 'GameLifecycleD1Error',
    })
    database
      .prepare(
        `UPDATE game_servers SET domain = NULL WHERE organization_id = 'org-a' AND id = 'server-a'`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO dns_records
      (organization_id, id, server_id, hostname, target, proxy_mode, state, revision)
      VALUES ('org-a', 'dns-a', 'server-a', 'configured.example.test', 'pending', 'dns_only', 'pending', 1)`,
      )
      .run()
    await expect(
      Effect.runPromise(
        observation.verifyNoDns('org-a', 'server-a', created.operation.operationId),
      ),
    ).rejects.toMatchObject({
      _tag: 'GameLifecycleD1Error',
    })
    observe('server-a', created.operation.operationId, 1, 'running')
    await expect(
      Effect.runPromise(
        observation.readObservation('org-a', 'server-a', created.operation.operationId),
      ),
    ).resolves.toMatchObject({
      organizationId: 'org-a',
      serverId: 'server-a',
      operationId: created.operation.operationId,
      observedRevision: 1,
      state: 'running',
    })
    await expect(
      Effect.runPromise(observation.readObservation('org-a', 'server-a', 'foreign-operation')),
    ).rejects.toMatchObject({
      _tag: 'GameLifecycleD1Error',
    })
  })

  it('exposes a terminal operation-bound DNS deletion receipt for cleanup adoption', async () => {
    const created = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-domain-a',
        correlationId: 'corr-domain-a',
        intent: { ...createIntent, domain: 'server.example.test' },
        plan: { ...plan, domain: 'server.example.test' },
      }),
    )
    // Simulate the exact provider publication receipt before the create
    // terminalizes. The test deliberately does not force operation status.
    database
      .prepare(`UPDATE dns_records
      SET provider_record_id = 'record-domain', state = 'active', revision = revision + 1
      WHERE organization_id = 'org-a' AND server_id = 'server-a'`)
      .run()
    database
      .prepare(`INSERT INTO game_dns_lifecycle_receipts
      (organization_id, operation_id, server_id, action, zone_id, hostname, record_type, target,
       provider_record_id, provider_result_json, state, revision, created_at, updated_at)
      VALUES ('org-a', ?, 'server-a', 'publish', 'zone-a', 'server.example.test', 'A',
       '203.0.113.10', 'record-domain', '{"success":true}', 'active', 1, 'now', 'now')`)
      .run(created.operation.operationId)
    observe('server-a', created.operation.operationId, 1, 'running')
    await completeAccepted(created, 'create')
    const deleted = await Effect.runPromise(
      repository().mutate({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'delete-domain-a',
        correlationId: 'corr-delete-domain-a',
        serverId: 'server-a',
        expectedRevision: 1,
        intent: { action: 'delete', backupPolicy: 'skip-authorized' },
      }),
    )
    database
      .prepare(
        `UPDATE dns_records
         SET state = 'deleted', revision = revision + 1
         WHERE organization_id = 'org-a' AND server_id = 'server-a'`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO game_dns_lifecycle_receipts
          (organization_id, operation_id, server_id, action, zone_id, hostname, record_type, target,
           provider_record_id, provider_result_json, state, revision, created_at, updated_at)
         VALUES ('org-a', ?, 'server-a', 'delete', 'zone-a', 'server.example.test', 'A',
           '203.0.113.10', 'record-domain', '{"success":true}', 'deleted', 1, 'now', 'now')`,
      )
      .run(deleted.operation.operationId)
    observe('server-a', deleted.operation.operationId, 2, 'deleted')
    await completeAccepted(deleted, 'delete', '2026-08-23T12:03:00.000Z')
    const cleanup = makeGameLifecycleCleanupD1Repository(d1)
    await expect(
      Effect.runPromise(
        cleanup.requireDeletedDnsReceipt('org-a', 'server-a', deleted.operation.operationId),
      ),
    ).resolves.toEqual({
      organizationId: 'org-a',
      serverId: 'server-a',
      operationId: deleted.operation.operationId,
      state: 'deleted',
      hostname: 'server.example.test',
      recordType: 'A',
      target: '203.0.113.10',
      providerRecordId: 'record-domain',
      revision: 1,
    })
  })

  it('atomically admits a move with a tenant-scoped target reservation', async () => {
    database
      .prepare(
        `INSERT INTO nodes
          (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
           placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
         VALUES ('org-a', 'node-b', 'provider-a', 'instance-b', 'ovhcloud', 'eu-west', 'small', 'image-a',
           'shared', 'ready', 'ready', 1, 1, 'now', 'now')`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO node_runtime_capacity
          (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
           agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
         VALUES ('org-a', 'node-b', 'amd64', 16_000, 64 * 1024 * 1024 * 1024,
           500 * 1024 * 1024 * 1024, 1, 1, 1, 1, '2026-08-23T12:00:00.000Z', 1)`,
      )
      .run()
    const created = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-move-source',
        correlationId: 'corr-move-source',
        intent: createIntent,
        plan,
      }),
    )
    observe('server-a', created.operation.operationId, 1, 'running')
    await completeAccepted(created, 'create')
    const moved = await Effect.runPromise(
      repository().mutate({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'move-a',
        correlationId: 'corr-move-a',
        serverId: 'server-a',
        expectedRevision: 1,
        intent: { action: 'move', targetNodeId: 'node-b', backupPolicy: 'required' },
      }),
    )
    expect(moved.operation.action).toBe('move')
    expect(
      database
        .prepare(
          `SELECT source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
             phase, source_preserved AS sourcePreserved
           FROM game_lifecycle_moves WHERE organization_id = 'org-a' AND operation_id = ?`,
        )
        .get(moved.operation.operationId),
    ).toEqual({
      sourceNodeId: 'node-a',
      targetNodeId: 'node-b',
      phase: 'reserved',
      sourcePreserved: 1,
    })
    expect(
      database
        .prepare(
          `SELECT target_node_id AS targetNodeId, state
           FROM game_lifecycle_move_reservations WHERE organization_id = 'org-a' AND operation_id = ?`,
        )
        .get(moved.operation.operationId),
    ).toEqual({ targetNodeId: 'node-b', state: 'reserved' })
    expect(
      database
        .prepare(
          `SELECT acceptance_audit_event_id AS acceptanceAuditEventId
           FROM game_lifecycle_moves WHERE organization_id = 'org-a' AND operation_id = ?`,
        )
        .get(moved.operation.operationId),
    ).toMatchObject({ acceptanceAuditEventId: expect.any(String) })
    const replay = await Effect.runPromise(
      makeGameLifecyclePlanningD1Repository(d1, {
        imageCatalog: [
          {
            pluginId: 'arma-reforger',
            activeVersion: '0.1.0',
            selectionRevision: 1,
            image: {
              installer: `sha256:${'a'.repeat(64)}`,
              runtime: `sha256:${'b'.repeat(64)}`,
            },
          },
        ],
      }).readWorkflowData('org-a', moved.operation.operationId),
    )
    expect(replay).toMatchObject({
      nodeId: 'node-a',
      targetNodeId: 'node-b',
      deploymentId: 'deployment-a',
      movePhase: 'reserved',
    })
    // Admission alone cannot terminalize a move: the completion fence also
    // requires a released immutable cutover effect and a matching observation.
  })

  it('reads tenant-scoped placement/catalog facts and reconstructs the accepted Workflow payload', async () => {
    const planning = makeGameLifecyclePlanningD1Repository(d1, {
      imageCatalog: [
        {
          pluginId: 'arma-reforger',
          activeVersion: '0.1.0',
          selectionRevision: 1,
          image: {
            installer: `sha256:${'a'.repeat(64)}`,
            runtime: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
      now: () => '2026-08-23T12:02:00.000Z',
    })
    const facts = await Effect.runPromise(planning.readPlanningFacts('org-a'))
    expect(facts.catalog).toHaveLength(1)
    expect(facts.nodes).toMatchObject([
      {
        organizationId: 'org-a',
        nodeId: 'node-a',
        placementMode: 'shared',
        ready: true,
        capacity: { cpu: 16, memoryMiB: 65_536, diskGiB: 500 },
        reserved: { cpu: 0, memoryMiB: 0, diskGiB: 0 },
        livePorts: [],
      },
    ])

    const accepted = await Effect.runPromise(
      repository().create({
        organizationId: 'org-a',
        actorId: 'identity-a',
        idempotencyKey: 'create-a',
        correlationId: 'corr-a',
        intent: createIntent,
        plan,
      }),
    )
    const workflow = await Effect.runPromise(
      planning.readWorkflowData('org-a', accepted.operation.operationId),
    )
    expect(workflow).toMatchObject({
      organizationId: 'org-a',
      operationId: accepted.operation.operationId,
      serverId: 'server-a',
      deploymentId: 'deployment-a',
      action: 'create',
      workflowState: 'pending',
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
      image: {
        installer: `sha256:${'a'.repeat(64)}`,
        runtime: `sha256:${'b'.repeat(64)}`,
      },
      configRevision: 1,
      modRevision: 1,
      ports: [
        { protocol: 'udp', containerPort: 2001, publicPort: 2001, purpose: 'udp-2001' },
        { protocol: 'udp', containerPort: 17777, publicPort: 17777, purpose: 'udp-17777' },
      ],
    })
    await Effect.runPromise(planning.markWorkflowStarted('org-a', accepted.operation.operationId))
    expect(
      database
        .prepare('SELECT state FROM lifecycle_workflow_starts WHERE operation_id = ?')
        .get(accepted.operation.operationId),
    ).toEqual({ state: 'started' })
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Effect } from 'effect'
import {
  evaluateNodeHealth,
  evaluateServerHealth,
  type HealthSnapshot,
  type NodeHealthInput,
} from '@gridora/health-control'
import {
  makeHealthRepositoryD1,
  type HealthD1Database,
  type HealthD1Statement,
  type HealthD1AllResult,
  type HealthD1Result,
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
  '0020_logs_health_aggregates.sql',
]
class SqliteStatement implements HealthD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(private readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): HealthD1Statement {
    this.values = values
    return this
  }
  first(): Promise<unknown> {
    return Promise.resolve(
      this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null,
    )
  }
  all(): Promise<HealthD1AllResult> {
    return Promise.resolve({
      results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)),
    })
  }
  run(): Promise<HealthD1Result> {
    return Promise.resolve({
      meta: {
        changes: Number(
          this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>)).changes,
        ),
      },
    })
  }
}
class SqliteD1 implements HealthD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): HealthD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
}

const seed = (database: DatabaseSync) => {
  database
    .prepare(
      `INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at) VALUES ('identity-a', 'access-a', 'a@example.com', 'A', 'active', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO organizations (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at) VALUES ('org-a', 'A', 'organization-a', 'active', 'UTC', 'eu-west', 'organization', 1, 1, '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO provider_accounts (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at) VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO provider_allocations (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision) VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO node_images (id, version, checksum, signature, provider_mappings_json, status, created_at) VALUES ('image-a', '1.0.0', 'sha256:${'a'.repeat(64)}', 'sig', '{}', 'promoted', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO nodes (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at) VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z'), ('org-a', 'node-b', 'provider-a', 'instance-b', 'ovhcloud', 'eu-west', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO game_plugins (id, version, api_version, status, capability_manifest_json, config_schema_version) VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO game_servers (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state, placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at) VALUES ('org-a', 'server-a', 'A', 'arma-reforger', '1.0.0', 'running', 'running', '{}', 1, 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO deployments (organization_id, id, server_id, node_id, desired_revision, observed_revision, observed_state, created_at, updated_at) VALUES ('org-a', 'deployment-a', 'server-a', 'node-a', 1, 1, 'running', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
}
const node = (overrides: Partial<NodeHealthInput> = {}): NodeHealthInput => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  sampledAt: '2026-08-23T12:00:00.000Z',
  provider: { state: 'active' },
  agentLastSeenAt: '2026-08-23T11:59:30.000Z',
  agentVersion: '1.0.0',
  supportedAgent: true,
  tunnel: 'connected',
  docker: 'healthy',
  firewall: 'ready',
  cpuUsedMillis: 100,
  cpuTotalMillis: 4000,
  ramUsedBytes: 100,
  ramTotalBytes: 4000,
  diskUsedBytes: 100,
  diskTotalBytes: 4000,
  loadPermille: 100,
  networkReceiveBytes: 1,
  networkTransmitBytes: 2,
  containers: [],
  ...overrides,
})

let database: DatabaseSync
let repository: ReturnType<typeof makeHealthRepositoryD1>
let nodeSnapshot: HealthSnapshot
beforeEach(async () => {
  database = new DatabaseSync(':memory:')
  for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
  seed(database)
  repository = makeHealthRepositoryD1(new SqliteD1(database))
  nodeSnapshot = await Effect.runPromise(evaluateNodeHealth(node()))
})
afterEach(() => database.close())

describe('health D1 aggregate repository', () => {
  it('keeps current and one-per-hour history bounded while rejecting equal-time conflicts', async () => {
    await Effect.runPromise(repository.upsertCurrent(nodeSnapshot))
    await Effect.runPromise(repository.appendHourly(nodeSnapshot))
    await Effect.runPromise(repository.upsertCurrent(nodeSnapshot))
    await expect(
      Effect.runPromise(
        repository.getCurrent({
          organizationId: 'org-a',
          resourceType: 'node',
          resourceId: 'node-a',
        }),
      ),
    ).resolves.toMatchObject({ status: nodeSnapshot.status, resourceId: 'node-a' })
    await expect(
      Effect.runPromise(
        repository.getCurrent({
          organizationId: 'org-b',
          resourceType: 'node',
          resourceId: 'node-a',
        }),
      ),
    ).resolves.toBeNull()
    await expect(
      Effect.runPromise(
        repository.upsertCurrent({
          ...nodeSnapshot,
          status: 'degraded',
          summary: { ...nodeSnapshot.summary, degradationReasons: ['forged'] },
        }),
      ),
    ).rejects.toMatchObject({ operation: 'health.current.conflict' })
    await expect(
      Effect.runPromise(
        repository.listHistory({
          organizationId: 'org-a',
          resourceType: 'node',
          resourceId: 'node-a',
          limit: 100,
        }),
      ),
    ).resolves.toHaveLength(1)
    await expect(
      Effect.runPromise(
        repository.listHistory({
          organizationId: 'org-a',
          resourceType: 'node',
          resourceId: 'node-a',
          from: 'invalid',
          limit: 100,
        }),
      ),
    ).rejects.toMatchObject({ operation: 'health.history.list' })
  })

  it('settles equal-time current and hourly contenders at the committed row', async () => {
    const conflicting = {
      ...nodeSnapshot,
      status: 'degraded' as const,
      summary: { ...nodeSnapshot.summary, degradationReasons: ['concurrent-contender'] },
    }
    const current = await Promise.allSettled([
      Effect.runPromise(repository.upsertCurrent(nodeSnapshot)),
      Effect.runPromise(repository.upsertCurrent(conflicting)),
    ])
    expect(current.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(current.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(
      (current.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ operation: 'health.current.conflict' })

    const hourly = await Promise.allSettled([
      Effect.runPromise(repository.appendHourly(nodeSnapshot)),
      Effect.runPromise(repository.appendHourly(conflicting)),
    ])
    expect(hourly.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(hourly.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(
      (hourly.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ operation: 'health.hourly.conflict' })
  })

  it('rejects same-organization foreign node attribution and permits an authoritative moved deployment', async () => {
    await expect(
      Effect.runPromise(repository.upsertCurrent({ ...nodeSnapshot, nodeId: 'node-b' })),
    ).rejects.toMatchObject({ operation: 'health.current.upsert' })
    database
      .prepare(
        `UPDATE deployments SET node_id = 'node-b' WHERE organization_id = 'org-a' AND server_id = 'server-a'`,
      )
      .run()
    const movedServer = await Effect.runPromise(
      evaluateServerHealth(
        {
          organizationId: 'org-a',
          nodeId: 'node-b',
          serverId: 'server-a',
          deploymentId: 'deployment-a',
          sampledAt: '2026-08-23T12:00:00.000Z',
          container: null,
          game: null,
          lastSuccessfulBackupAt: null,
          backupStale: false,
          currentOperation: null,
          operationFailed: false,
        },
        { ...nodeSnapshot, nodeId: 'node-b' },
      ),
    )
    await expect(Effect.runPromise(repository.upsertCurrent(movedServer))).resolves.toBeUndefined()
  })

  it('keeps alert list tenant-scoped and resolves only missing fingerprints', async () => {
    const alert = {
      organizationId: 'org-a',
      id: 'alert_node_node-a_disk-low',
      resourceType: 'node' as const,
      resourceId: 'node-a',
      nodeId: 'node-a',
      serverId: null,
      type: 'disk-low',
      severity: 'warning' as const,
      message: 'disk low',
      fingerprint: 'node:node-a:disk-low',
      state: 'open' as const,
      firstSeenAt: nodeSnapshot.sampledAt,
      lastSeenAt: nodeSnapshot.sampledAt,
      resolvedAt: null,
    }
    await expect(Effect.runPromise(repository.upsertAlert(alert))).resolves.toMatchObject({
      fingerprint: alert.fingerprint,
    })
    await expect(
      Effect.runPromise(repository.listAlerts({ organizationId: 'org-b', limit: 100 })),
    ).resolves.toEqual([])
    await expect(
      Effect.runPromise(
        repository.resolveMissingAlerts('org-a', 'node', 'node-a', [], '2026-08-23T12:01:00.000Z'),
      ),
    ).resolves.toBe(1)
    await expect(
      Effect.runPromise(repository.listAlerts({ organizationId: 'org-a', limit: 100 })),
    ).resolves.toMatchObject([{ state: 'resolved' }])
  })
})

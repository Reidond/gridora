import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Effect } from 'effect'
import type { LogArchiveMetadata } from '@gridora/log-control'
import {
  makeLogArchiveRepositoryD1,
  type LogD1Database,
  type LogD1Result,
  type LogD1Statement,
  type LogD1AllResult,
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
  '0029_telemetry_ingestion_receipts.sql',
  '0037_telemetry_stream_epochs_and_reconciliation.sql',
]

class SqliteStatement implements LogD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(private readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): LogD1Statement {
    this.values = values
    return this
  }
  first(): Promise<unknown> {
    return Promise.resolve(
      this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null,
    )
  }
  all(): Promise<LogD1AllResult> {
    return Promise.resolve({
      results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)),
    })
  }
  run(): Promise<LogD1Result> {
    return Promise.resolve({
      meta: {
        changes: Number(
          this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>)).changes,
        ),
      },
    })
  }
}
class SqliteD1 implements LogD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): LogD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
}

const metadata = (
  organizationId: string,
  id: string,
  serverId: string,
  nodeId: string,
): LogArchiveMetadata => ({
  organizationId,
  id,
  serverId,
  nodeId,
  r2Key: `organizations/${organizationId}/logs/${serverId}/2026-08-23/${id}.ndjson.gz`,
  compression: 'gzip',
  firstTimestamp: '2026-08-23T12:00:01.000Z',
  lastTimestamp: '2026-08-23T12:00:02.000Z',
  entryCount: 2,
  uncompressedBytes: 200,
  compressedBytes: 120,
  sha256: `sha256:${'a'.repeat(64)}`,
  state: 'available',
  createdAt: '2026-08-23T12:01:00.000Z',
  expiresAt: '2026-09-23T12:01:00.000Z',
})

let database: DatabaseSync
let d1: SqliteD1
const seedTenant = (organizationId: string, identityId: string, slug: string) => {
  database
    .prepare(
      `INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      identityId,
      `access-${identityId}`,
      `${identityId}@example.com`,
      identityId,
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:00:00.000Z',
    )
  database
    .prepare(
      `INSERT INTO organizations (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at) VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'organization', 1, 1, ?)`,
    )
    .run(organizationId, organizationId, slug, '2026-08-23T10:00:00.000Z')
}
const seed = () => {
  seedTenant('org-a', 'identity-a', 'organization-a')
  seedTenant('org-b', 'identity-b', 'organization-b')
  database
    .prepare(
      `INSERT INTO provider_accounts (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at) VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z'), ('provider-b', 'organization', 'org-b', 'ovhcloud', 'secret-b', 'active', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO provider_allocations (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision) VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1), ('org-b', 'provider-b', '["eu-west"]', '["small"]', 2, 'active', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO node_images (id, version, checksum, signature, provider_mappings_json, status, created_at) VALUES ('image-a', '1.0.0', 'sha256:${'a'.repeat(64)}', 'signature', '{}', 'promoted', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO nodes (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at) VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z'), ('org-b', 'node-b', 'provider-b', 'instance-b', 'ovhcloud', 'eu-west', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO game_plugins (id, version, api_version, status, capability_manifest_json, config_schema_version) VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO game_servers (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state, placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at) VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running', 'running', '{}', 1, 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z'), ('org-b', 'server-b', 'Server B', 'arma-reforger', '1.0.0', 'running', 'running', '{}', 1, 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO deployments (organization_id, id, server_id, node_id, desired_revision, observed_revision, observed_state, created_at, updated_at) VALUES ('org-a', 'deployment-a', 'server-a', 'node-a', 1, 1, 'running', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z'), ('org-b', 'deployment-b', 'server-b', 'node-b', 1, 1, 'running', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`,
    )
    .run()
}

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
  seed()
  d1 = new SqliteD1(database)
})
afterEach(() => database.close())

describe('log D1 repository', () => {
  it('records idempotently and lists only the requested organization/server', async () => {
    const repository = makeLogArchiveRepositoryD1(d1)
    const first = await Effect.runPromise(
      repository.record(metadata('org-a', 'archive-a', 'server-a', 'node-a')),
    )
    await expect(Effect.runPromise(repository.record(first))).resolves.toEqual(first)
    await expect(
      Effect.runPromise(
        repository.list({ organizationId: 'org-a', serverId: 'server-a', limit: 100 }),
      ),
    ).resolves.toMatchObject({ items: [first] })
    await expect(
      Effect.runPromise(
        repository.list({ organizationId: 'org-b', serverId: 'server-b', limit: 100 }),
      ),
    ).resolves.toMatchObject({ items: [] })
    await expect(Effect.runPromise(repository.get('org-b', 'archive-a'))).resolves.toBeNull()
  })

  it('rejects foreign node/server archive metadata through migration scope fences', async () => {
    const repository = makeLogArchiveRepositoryD1(d1)
    await expect(
      Effect.runPromise(repository.record(metadata('org-a', 'archive-a', 'server-a', 'node-b'))),
    ).rejects.toMatchObject({ _tag: 'LogPersistenceError' })
  })

  it('advances a contiguous watermark, adopts exact replay, and rejects gaps', async () => {
    const repository = makeLogArchiveRepositoryD1(d1)
    const first = {
      organizationId: 'org-a',
      nodeId: 'node-a',
      firstSequence: 1,
      lastSequence: 2,
      lastTimestamp: '2026-08-23T12:00:02.000Z',
      fingerprint: 'a'.repeat(64),
    }
    await expect(Effect.runPromise(repository.advanceWatermark(first))).resolves.toEqual({
      accepted: true,
      replayed: false,
    })
    await expect(Effect.runPromise(repository.advanceWatermark(first))).resolves.toEqual({
      accepted: false,
      replayed: true,
    })
    await expect(
      Effect.runPromise(
        repository.advanceWatermark({
          ...first,
          firstSequence: 4,
          lastSequence: 4,
          fingerprint: 'b'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'LogPersistenceError' })
    await expect(
      Effect.runPromise(
        repository.advanceWatermark({
          ...first,
          firstSequence: 3,
          lastSequence: 3,
          fingerprint: 'b'.repeat(64),
          lastTimestamp: '2026-08-23T12:00:03.000Z',
        }),
      ),
    ).resolves.toEqual({ accepted: true, replayed: false })
  })
})

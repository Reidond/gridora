import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  makeServerPlanControl,
  makeWebCryptoServerCreateIdentity,
  ServerCreateIdentityPortLayer,
  ServerPlanClockLayer,
  ServerPlanConcurrencyError,
  ServerPlanRepositoryLayer,
  type ServerCreateCommand,
  type ServerPlanControlShape,
} from '@gridora/server-plan-control'
import {
  makeServerPlanRepositoryD1,
  serverPlanSchemaSql,
  type ServerPlanD1Database,
  type ServerPlanD1Result,
  type ServerPlanD1Statement,
} from '../src/index.js'

const migrationsDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
] as const
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
  failAfterCommitOnce = false
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
        const changes = this.database.prepare('SELECT changes() AS changes').get() as {
          changes: number
        }
        results.push({ ...result, meta: { changes: changes.changes } })
      }
      this.database.exec('COMMIT')
      if (this.failAfterCommitOnce) {
        this.failAfterCommitOnce = false
        throw new Error('simulated D1 response loss after commit')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const policy = (organizationId: string) => ({
  schemaVersion: 1,
  organizationId,
  revision: 3,
  allowedProviders: ['ovhcloud'],
  allowedRegions: ['eu-west'],
  allowedPlans: ['b2-15'],
  capacity: {
    maxActiveNodes: 5,
    maxDedicatedNodes: 2,
    maxServersPerNode: 4,
    maxDeploymentCpuMillis: 4_000,
    maxDeploymentRamBytes: 8_589_934_592,
    maxDeploymentDiskBytes: 107_374_182_400,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 10_000,
    hardLimitMinor: 20_000,
  },
  temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 168 },
  idle: { action: 'none', afterMinutes: 60 },
  backups: { requiredBeforeDelete: true },
  maintenanceWindows: [],
  updates: { automatic: 'disabled', requireMaintenanceWindow: false },
  contabo: { maxContractMonths: 1 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
})
const pluginContract = {
  architecture: 'amd64',
  sharedNodeAllowed: true,
  minimum: { cpuMillis: 1_000, ramBytes: 2_147_483_648, diskBytes: 21_474_836_480 },
  maximum: { cpuMillis: 4_000, ramBytes: 8_589_934_592, diskBytes: 107_374_182_400 },
  ports: [{ name: 'game', protocol: 'udp', containerPort: 20_001, preferredPublicPort: 20_001 }],
}

let database: DatabaseSync
let d1: SqliteD1
let service: ServerPlanControlShape

const seedTenant = (organizationId: string, actorId: string, withNode: boolean) => {
  database
    .prepare(
      `INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(actorId, `access-${actorId}`, `${actorId}@example.test`, actorId, now, now)
  database
    .prepare(
      `INSERT INTO organizations
     (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
     VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 3, 1, ?)`,
    )
    .run(organizationId, organizationId, organizationId, now)
  database
    .prepare(
      `INSERT INTO organization_memberships
     (organization_id, identity_id, role, status, joined_at, revision)
     VALUES (?, ?, 'operator', 'active', ?, 1)`,
    )
    .run(organizationId, actorId, now)
  database
    .prepare(
      `INSERT INTO organization_policies (organization_id, policy_json, revision, updated_by, updated_at)
     VALUES (?, ?, 3, ?, ?)`,
    )
    .run(organizationId, JSON.stringify(policy(organizationId)), actorId, now)
  if (!withNode) return
  const accountId = `account-${organizationId}`
  database
    .prepare(
      `INSERT INTO provider_accounts
     (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
     VALUES (?, 'organization', ?, 'ovhcloud', ?, 'active', 1, ?, ?)`,
    )
    .run(accountId, organizationId, `credentials-${organizationId}`, now, now)
  database
    .prepare(
      `INSERT INTO provider_allocations
     (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
      max_active_nodes, monthly_budget_minor, status, revision)
     VALUES (?, ?, '["eu-west"]', '["b2-15"]', 5, 20000, 'active', 2)`,
    )
    .run(organizationId, accountId)
  database
    .prepare(
      `INSERT INTO node_images
     (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
     VALUES (?, ?, 'checksum', 'signature', '{}', 'promoted', ?, ?)`,
    )
    .run(`image-${organizationId}`, `image-version-${organizationId}`, now, now)
  database
    .prepare(
      `INSERT INTO nodes
     (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
      plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
      observed_revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ovhcloud', 'eu-west', 'b2-15', ?, 'shared', 'ready', 'ready', 4, 4, ?, ?)`,
    )
    .run(
      organizationId,
      `node-${organizationId}`,
      accountId,
      `instance-${organizationId}`,
      `image-${organizationId}`,
      now,
      now,
    )
  database
    .prepare(
      `INSERT INTO node_runtime_capacity
     (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
      agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
     VALUES (?, ?, 'amd64', 8000, 17179869184, 214748364800, 1, 1, 1, 1, ?, 7)`,
    )
    .run(organizationId, `node-${organizationId}`, now)
}

const command = (
  organizationId: string,
  actorId: string,
  key: string,
  name = 'Eastern Front',
): ServerCreateCommand => ({
  context: {
    organizationId,
    actorId,
    actorRole: 'operator',
    correlationId: `correlation-${organizationId}`,
  },
  idempotencyKey: key,
  intent: {
    schemaVersion: 1,
    name,
    pluginId: 'arma-reforger',
    placementMode: 'auto',
    resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 42_949_672_960 },
    nonHourlyCommitmentConfirmed: false,
  },
})

const scalar = (sql: string, ...values: SQLInputValue[]) =>
  database.prepare(sql).get(...values) as Record<string, unknown> | undefined

describe('server plan D1 repository', () => {
  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${migrationsDirectory}${migration}`, 'utf8'))
    database.exec(serverPlanSchemaSql)
    database
      .prepare(
        `INSERT INTO game_plugins
       (id, version, api_version, status, capability_manifest_json, config_schema_version)
       VALUES ('arma-reforger', '0.1.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO server_plugin_channels
       (plugin_id, active_version, plan_contract_json, revision, updated_at)
       VALUES ('arma-reforger', '0.1.0', ?, 2, ?)`,
      )
      .run(JSON.stringify(pluginContract), now)
    database
      .prepare(
        `INSERT INTO provider_catalog
       (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor, metadata_json, refreshed_at)
       VALUES ('ovhcloud', 'eu-west', 'b2-15', 'EUR', 5, 5000, '{}', ?)`,
      )
      .run(now)
    seedTenant('org-a', 'operator-a', true)
    seedTenant('org-b', 'operator-b', false)
    d1 = new SqliteD1(database)
    const repository = makeServerPlanRepositoryD1(d1)
    const layer = Layer.mergeAll(
      ServerPlanRepositoryLayer(repository),
      ServerPlanClockLayer({
        now: Effect.succeed({ iso: now, epochMilliseconds: Date.parse(now) }),
      }),
      ServerCreateIdentityPortLayer(makeWebCryptoServerCreateIdentity()),
    )
    service = await Effect.runPromise(makeServerPlanControl.pipe(Effect.provide(layer)))
  })

  it('keeps preflight planning read-only', async () => {
    const before = database.prepare('SELECT total_changes() AS changes').get() as {
      changes: number
    }
    const planned = command('org-a', 'operator-a', 'idempotency-plan')
    const result = await Effect.runPromise(
      service.plan({ context: planned.context, intent: planned.intent }),
    )
    const after = database.prepare('SELECT total_changes() AS changes').get() as { changes: number }
    expect(result).toMatchObject({
      nodeId: 'node-org-a',
      pluginVersion: '0.1.0',
      newPaidInfrastructure: false,
    })
    expect(after.changes).toBe(before.changes)
  })

  it('atomically records a queued server, deployment, capacity, ports, operation, audit, outbox, and reservation', async () => {
    const result = await Effect.runPromise(
      service.create(command('org-a', 'operator-a', 'idempotency-create')),
    )
    expect(result).toMatchObject({
      disposition: 'created',
      state: 'queued',
      organizationId: 'org-a',
    })
    for (const table of [
      'game_servers',
      'deployments',
      'server_capacity_reservations',
      'port_leases',
      'operations',
      'audit_events',
      'outbox',
      'server_create_reservations',
      'lifecycle_workflow_starts',
    ])
      expect(scalar(`SELECT COUNT(*) AS count FROM ${table}`)?.count).toBe(1)
    expect(scalar('SELECT status FROM operations')?.status).toBe('queued')
    expect(scalar('SELECT observed_state AS state FROM game_servers')?.state).toBe('planning')
  })

  it('adopts the exact queued reservation after D1 commits but loses its response', async () => {
    d1.failAfterCommitOnce = true
    const result = await Effect.runPromise(
      service.create(command('org-a', 'operator-a', 'idempotency-lost')),
    )
    expect(result.disposition).toBe('adopted')
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(1)
    const replay = await Effect.runPromise(
      service.create(command('org-a', 'operator-a', 'idempotency-lost')),
    )
    expect(replay).toEqual(result)
  })

  it('binds an idempotency key to the exact tenant, actor, and intent fingerprint', async () => {
    await Effect.runPromise(
      service.create(command('org-a', 'operator-a', 'idempotency-conflict', 'Server A')),
    )
    await expect(
      Effect.runPromise(
        service.create(command('org-a', 'operator-a', 'idempotency-conflict', 'Server B')),
      ),
    ).rejects.toMatchObject({
      _tag: 'ServerPlanIdempotencyConflictError',
      idempotencyKey: 'idempotency-conflict',
    })
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(1)
  })

  it('never falls back to another organization candidate', async () => {
    await expect(
      Effect.runPromise(service.create(command('org-b', 'operator-b', 'idempotency-cross-tenant'))),
    ).rejects.toMatchObject({ _tag: 'ServerPlacementRejectedError', code: 'no_existing_node_fit' })
    expect(
      scalar(`SELECT COUNT(*) AS count FROM game_servers WHERE organization_id = 'org-b'`)?.count,
    ).toBe(0)
  })

  it('serializes competing fixed-port reservations so only one can win', async () => {
    const results = await Promise.allSettled([
      Effect.runPromise(
        service.create(command('org-a', 'operator-a', 'idempotency-race-a', 'Server A')),
      ),
      Effect.runPromise(
        service.create(command('org-a', 'operator-a', 'idempotency-race-b', 'Server B')),
      ),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(scalar('SELECT COUNT(*) AS count FROM port_leases')?.count).toBe(1)
  })

  it('rejects a stale capacity revision at the atomic fence', async () => {
    const repository = makeServerPlanRepositoryD1(d1)
    const changingRepository = {
      ...repository,
      acceptAtomic: (input: Parameters<typeof repository.acceptAtomic>[0]) => {
        database
          .prepare(
            `UPDATE node_runtime_capacity SET revision = revision + 1
           WHERE organization_id = ? AND node_id = ?`,
          )
          .run(input.command.context.organizationId, input.prepared.decision.nodeId)
        return repository.acceptAtomic(input)
      },
    }
    const layer = Layer.mergeAll(
      ServerPlanRepositoryLayer(changingRepository),
      ServerPlanClockLayer({
        now: Effect.succeed({ iso: now, epochMilliseconds: Date.parse(now) }),
      }),
      ServerCreateIdentityPortLayer(makeWebCryptoServerCreateIdentity()),
    )
    const staleService = await Effect.runPromise(makeServerPlanControl.pipe(Effect.provide(layer)))
    await expect(
      Effect.runPromise(staleService.create(command('org-a', 'operator-a', 'idempotency-stale'))),
    ).rejects.toBeInstanceOf(ServerPlanConcurrencyError)
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(0)
  })
})

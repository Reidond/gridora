import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations as registeredMigrations } from '@gridora/migrations'
import { evaluatePolicyAdmission, type OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  makeOrganizationPolicyRepositoryD1,
  makePolicyManagementRepositoryD1,
  makePolicyFactsD1Repository,
  type PolicyD1Database,
  type PolicyD1Result,
  type PolicyD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = registeredMigrations.map((migration) => migration.file)
const nowIso = '2026-08-23T12:00:00.000Z'
const now = Date.parse(nowIso)

class SqliteStatement implements PolicyD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): PolicyD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<PolicyD1Result> {
    return {
      results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)),
    }
  }
}

class SqliteD1 implements PolicyD1Database {
  afterBatch: (() => void) | undefined
  beforeBatch: (() => Promise<void>) | undefined
  batchCalls = 0
  private serial: Promise<void> = Promise.resolve()
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): PolicyD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<PolicyD1Statement>,
  ): Promise<ReadonlyArray<PolicyD1Result>> {
    this.batchCalls += 1
    await this.beforeBatch?.()
    const prior = this.serial
    let release!: () => void
    this.serial = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      this.database.exec('BEGIN')
      const results: PolicyD1Result[] = []
      for (const statement of statements) {
        const result = await statement.all()
        const changes = this.database.prepare('SELECT changes() AS changes').get() as {
          changes: number
        }
        results.push({ ...result, meta: { changes: changes.changes } })
      }
      this.database.exec('COMMIT')
      this.afterBatch?.()
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }
}

const policy = (organizationId: string): OrganizationPolicyV1 => ({
  schemaVersion: 1,
  organizationId,
  revision: 1,
  allowedProviders: ['ovhcloud', 'contabo'],
  allowedRegions: ['eu-west', 'de-central'],
  allowedPlans: ['b2-15', 'cloud-vps-10'],
  capacity: {
    maxActiveNodes: 10,
    maxDedicatedNodes: 5,
    maxServersPerNode: 4,
    maxDeploymentCpuMillis: 4_000,
    maxDeploymentRamBytes: 8_000,
    maxDeploymentDiskBytes: 80_000,
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
  maintenanceWindows: [{ dayOfWeekUtc: 0, startMinuteUtc: 720, durationMinutes: 60 }],
  updates: { automatic: 'security', requireMaintenanceWindow: true },
  contabo: { maxContractMonths: 12 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
})

let database: DatabaseSync
let d1: SqliteD1

const insertNode = (
  organizationId: string,
  id: string,
  account: string,
  provider: 'ovhcloud' | 'contabo',
  region: string,
  plan: string,
  mode: 'shared' | 'dedicated',
  instance: string,
  state: 'provisioning' | 'ready' | 'stopped' | 'deleted' = 'ready',
) => {
  database
    .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
       image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'image-a', ?, ?, 'ready', 1, 1, ?, ?) `)
    .run(organizationId, id, account, instance, provider, region, plan, mode, state, nowIso, nowIso)
}

const seed = () => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('actor-a', 'access-a', 'actor@example.com', 'Actor', 'active', ?, ?) `)
    .run(nowIso, nowIso)
  for (const organizationId of ['org-a', 'org-b']) {
    database
      .prepare(`INSERT INTO organizations
       (id, name, slug, status, timezone, default_region, onboarding_step,
        policy_revision, revision, created_at)
       VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?) `)
      .run(organizationId, organizationId, `${organizationId}-slug`, nowIso)
    database
      .prepare(`INSERT INTO organization_policies
       (organization_id, policy_json, revision, updated_by, updated_at) VALUES (?, ?, 1, 'actor-a', ?) `)
      .run(organizationId, JSON.stringify(policy(organizationId)), nowIso)
    database
      .prepare(`INSERT INTO organization_memberships
       (organization_id, identity_id, role, status, joined_at, invited_by, revision)
       VALUES (?, 'actor-a', 'owner', 'active', ?, NULL, 1)`)
      .run(organizationId, nowIso)
  }
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES
      ('account-ovh', 'platform', NULL, 'ovhcloud', 'secret-ovh', 'active', 1, ?, ?),
      ('account-contabo', 'platform', NULL, 'contabo', 'secret-contabo', 'active', 1, ?, ?) `)
    .run(nowIso, nowIso, nowIso, nowIso)
  for (const organizationId of ['org-a', 'org-b']) {
    database
      .prepare(`INSERT INTO provider_allocations
       (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
        max_active_nodes, monthly_budget_minor, status, revision)
       VALUES (?, 'account-ovh', '["eu-west"]', '["b2-15"]', 10, 20000, 'active', 1),
              (?, 'account-contabo', '["de-central"]', '["cloud-vps-10"]', 10, 20000, 'active', 1) `)
      .run(organizationId, organizationId)
  }
  database
    .prepare(`INSERT INTO provider_catalog
      (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
       metadata_json, refreshed_at) VALUES
      ('ovhcloud', 'eu-west', 'b2-15', 'EUR', NULL, 2500, '{}', ?),
      ('contabo', 'de-central', 'cloud-vps-10', 'EUR', NULL, 4000,
       '{"contractMonths":12}', ?) `)
    .run(nowIso, nowIso)
  database
    .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-a', '1.0.0', 'checksum', 'signature', '{}', 'promoted', ?, ?) `)
    .run(nowIso, nowIso)

  insertNode(
    'org-a',
    'node-existing',
    'account-ovh',
    'ovhcloud',
    'eu-west',
    'b2-15',
    'shared',
    'ovh-existing',
  )
  insertNode(
    'org-a',
    'node-dedicated',
    'account-contabo',
    'contabo',
    'de-central',
    'cloud-vps-10',
    'dedicated',
    'contabo-dedicated',
  )
  insertNode(
    'org-a',
    'node-candidate',
    'account-ovh',
    'ovhcloud',
    'eu-west',
    'b2-15',
    'dedicated',
    'ovh-candidate',
    'provisioning',
  )
  insertNode(
    'org-b',
    'node-candidate',
    'account-contabo',
    'contabo',
    'de-central',
    'cloud-vps-10',
    'shared',
    'contabo-candidate',
  )

  for (const capacity of [
    ['org-a', 'node-existing', 1_000, 2_000, 3_000],
    ['org-a', 'node-dedicated', 2_000, 3_000, 4_000],
    ['org-a', 'node-candidate', 0, 0, 0],
    ['org-b', 'node-candidate', 500, 600, 700],
  ] as const)
    database
      .prepare(`INSERT INTO node_capacity
       (organization_id, node_id, cpu_millis_total, cpu_millis_reserved,
        memory_bytes_total, memory_bytes_reserved, disk_bytes_total, disk_bytes_reserved,
        observed_usage_json, revision, observed_at)
       VALUES (?, ?, 10000, ?, 20000, ?, 30000, ?, '{}', 1, ?) `)
      .run(...capacity, nowIso)

  database
    .prepare(`INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1) `)
    .run()
  for (const organizationId of ['org-a', 'org-b']) {
    const placement =
      organizationId === 'org-a'
        ? {
            resources: { cpuMillis: 2_000, ramBytes: 4_000, diskBytes: 40_000 },
            updateMode: 'automatic',
            updateCategory: 'security',
          }
        : { resources: { cpuMillis: 9_000, ramBytes: 9_000, diskBytes: 90_000 } }
    database
      .prepare(`INSERT INTO game_servers
       (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
        placement_policy_json, desired_revision, observed_revision, active_config_revision,
        created_at, updated_at)
       VALUES (?, 'server-a', ?, 'arma-reforger', '1.0.0', 'running', 'running', ?, 3, 3, 1, ?, ?) `)
      .run(organizationId, `${organizationId} server`, JSON.stringify(placement), nowIso, nowIso)
    database
      .prepare(`INSERT INTO deployments
       (organization_id, id, server_id, node_id, desired_revision, observed_revision,
        observed_state, created_at, updated_at)
       VALUES (?, 'deployment-a', 'server-a', ?, 3, 3, 'running', ?, ?) `)
      .run(
        organizationId,
        organizationId === 'org-a' ? 'node-existing' : 'node-candidate',
        nowIso,
        nowIso,
      )
  }
  database
    .prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json,
       state, created_at)
      VALUES ('org-a', 'backup-a', 'server-a', 'organizations/org-a/backups/a', 'sum', 1,
       '{"desiredRevision":3}', 'available', ?) `)
    .run(nowIso)
}

const command = (organizationId: string, kind: string, resourceId: string) => ({
  organizationId,
  kind,
  resourceId,
})
const snapshot = (organizationId: string, id: string, kind: 'node' | 'server' = 'node') => ({
  organizationId,
  id,
  kind,
})
const runFailure = async <A>(effect: Effect.Effect<A, unknown>) => {
  const result = await Effect.runPromise(Effect.result(effect))
  return result._tag === 'Failure' ? result.failure : null
}

describe('policy D1 repositories', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
  })
  afterEach(() => database.close())

  const facts = () =>
    makePolicyFactsD1Repository(d1, {
      nowEpochMilliseconds: () => now,
      priceMaxAgeMilliseconds: 60 * 60 * 1_000,
    })

  it('loads only the requested organization policy and fences all three revisions', async () => {
    const repository = makeOrganizationPolicyRepositoryD1(d1)
    await expect(Effect.runPromise(repository.get('org-a'))).resolves.toMatchObject({
      organizationId: 'org-a',
      revision: 1,
    })
    await expect(runFailure(repository.get('org-c'))).resolves.toMatchObject({
      _tag: 'PolicyStoreError',
      operation: 'policy.get.not-found-or-invalid',
    })
    database.prepare("UPDATE organizations SET policy_revision = 2 WHERE id = 'org-a'").run()
    await expect(runFailure(repository.get('org-a'))).resolves.toMatchObject({
      operation: 'policy.get.revision-fence',
    })
  })

  it('keeps cross-tenant same IDs scoped through resource, allocation, and price reads', async () => {
    const repository = facts()
    const own = await Effect.runPromise(
      repository.resolve(
        command('org-a', 'provision-node', 'node-candidate'),
        snapshot('org-a', 'node-candidate'),
      ),
    )
    const foreign = await Effect.runPromise(
      repository.resolve(
        command('org-b', 'provision-node', 'node-candidate'),
        snapshot('org-b', 'node-candidate'),
      ),
    )
    expect(own.request).toMatchObject({ provider: 'ovhcloud', region: 'eu-west', plan: 'b2-15' })
    expect(foreign.request).toMatchObject({
      organizationId: 'org-b',
      provider: 'contabo',
      region: 'de-central',
      plan: 'cloud-vps-10',
    })
    await expect(
      runFailure(
        repository.resolve(
          command('org-a', 'provision-node', 'node-candidate'),
          snapshot('org-b', 'node-candidate'),
        ),
      ),
    ).resolves.toMatchObject({ operation: 'policy.facts.organization-scope' })
    await expect(
      runFailure(
        repository.resolve(
          command('org-a', 'provision-node', 'node-existing'),
          snapshot('org-a', 'node-candidate'),
        ),
      ),
    ).resolves.toMatchObject({ operation: 'policy.facts.resource-scope' })
  })

  it('selects the authoritative snapshot kind when a node and server share one tenant ID', async () => {
    insertNode(
      'org-a',
      'server-a',
      'account-ovh',
      'ovhcloud',
      'eu-west',
      'b2-15',
      'shared',
      'ovh-id-collision',
    )
    const resolved = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'deploy-server', 'server-a'),
        snapshot('org-a', 'server-a', 'server'),
      ),
    )
    expect(resolved.request).toMatchObject({
      action: 'deploy-server',
      targetNodeId: 'node-existing',
      resources: { cpuMillis: 2_000 },
    })
  })

  it('reads authoritative active/dedicated/server counts and resource aggregation', async () => {
    const result = await Effect.runPromise(facts().readUsageSnapshot('org-a'))
    expect(result.usage).toMatchObject({
      organizationId: 'org-a',
      activeNodes: 3,
      dedicatedNodes: 2,
      serversByNode: { 'node-existing': 1 },
      estimatedCommittedMonthlyMinor: 9_000,
      currency: 'EUR',
    })
    expect(result.resources).toMatchObject({
      cpuMillisReserved: 3_000,
      ramBytesReserved: 5_000,
      diskBytesReserved: 7_000,
      latestObservedAtEpochMilliseconds: now,
    })
  })

  it('excludes the planned candidate from pre-admission counts and commitments', async () => {
    const result = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'provision-node', 'node-candidate'),
        snapshot('org-a', 'node-candidate'),
      ),
    )
    expect(result.usage).toMatchObject({
      activeNodes: 2,
      dedicatedNodes: 1,
      estimatedCommittedMonthlyMinor: 6_500,
    })
    expect(result.price).toMatchObject({ status: 'known', estimatedMonthlyMinor: 2_500 })
  })

  it('returns one internally consistent batch snapshot when rows change immediately afterward', async () => {
    d1.afterBatch = () => {
      database
        .prepare(
          "UPDATE nodes SET desired_state = 'deleted' WHERE organization_id = 'org-a' AND id = 'node-dedicated'",
        )
        .run()
      database
        .prepare("UPDATE node_capacity SET cpu_millis_reserved = 0 WHERE organization_id = 'org-a'")
        .run()
    }
    const result = await Effect.runPromise(facts().readUsageSnapshot('org-a'))
    expect(d1.batchCalls).toBe(1)
    expect(result.usage.activeNodes).toBe(3)
    expect(result.usage.estimatedCommittedMonthlyMinor).toBe(9_000)
    expect(result.resources.cpuMillisReserved).toBe(3_000)
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nodes WHERE organization_id = 'org-a' AND desired_state <> 'deleted'",
        )
        .get(),
    ).toEqual({ count: 2 })
  })

  it('derives deployment resources and verified destructive backup from tenant rows', async () => {
    const deploy = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'deploy-server', 'server-a'),
        snapshot('org-a', 'server-a', 'server'),
      ),
    )
    expect(deploy.request).toMatchObject({
      targetNodeId: 'node-existing',
      resources: { cpuMillis: 2_000, ramBytes: 4_000, diskBytes: 40_000 },
    })
    const deletion = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'delete-server', 'server-a'),
        snapshot('org-a', 'server-a', 'server'),
      ),
    )
    expect(deletion.request.destructiveBackup).toBe('verified')
    const foreignDeletion = await Effect.runPromise(
      facts().resolve(
        command('org-b', 'delete-server', 'server-a'),
        snapshot('org-b', 'server-a', 'server'),
      ),
    )
    expect(foreignDeletion.request.destructiveBackup).toBe('missing')
  })

  it('requires backup coverage for every live server on node deletion and accepts an empty node', async () => {
    const empty = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'delete-node', 'node-dedicated'),
        snapshot('org-a', 'node-dedicated'),
      ),
    )
    expect(empty.request.destructiveBackup).toBe('verified')

    database
      .prepare(`INSERT INTO game_servers
       (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
        placement_policy_json, desired_revision, observed_revision, active_config_revision,
        created_at, updated_at)
       VALUES ('org-a', 'server-b', 'Server B', 'arma-reforger', '1.0.0', 'running', 'running',
        '{}', 2, 2, 1, ?, ?) `)
      .run(nowIso, nowIso)
    database
      .prepare(`INSERT INTO deployments
       (organization_id, id, server_id, node_id, desired_revision, observed_revision,
        observed_state, created_at, updated_at)
       VALUES ('org-a', 'deployment-b', 'server-b', 'node-existing', 2, 2, 'running', ?, ?) `)
      .run(nowIso, nowIso)
    const partial = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'delete-node', 'node-existing'),
        snapshot('org-a', 'node-existing'),
      ),
    )
    expect(partial.request.destructiveBackup).toBe('missing')

    database
      .prepare(`INSERT INTO backups
       (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json,
        state, created_at)
       VALUES ('org-a', 'backup-b', 'server-b', 'organizations/org-a/backups/b', 'sum-b', 1,
        '{"desiredRevision":2}', 'available', ?) `)
      .run(nowIso)
    const complete = await Effect.runPromise(
      facts().resolve(
        command('org-a', 'delete-node', 'node-existing'),
        snapshot('org-a', 'node-existing'),
      ),
    )
    expect(complete.request.destructiveBackup).toBe('verified')
  })

  it('makes unknown and stale requested prices deny through policy admission', async () => {
    const repository = facts()
    database
      .prepare(`INSERT INTO provider_catalog
       (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
        metadata_json, refreshed_at)
       VALUES ('ovhcloud', 'eu-west', 'b2-candidate', 'EUR', NULL, 2600, '{}',
        '2026-08-22T00:00:00.000Z')`)
      .run()
    database
      .prepare(
        "UPDATE nodes SET plan = 'b2-candidate' WHERE organization_id = 'org-a' AND id = 'node-candidate'",
      )
      .run()
    database
      .prepare(`UPDATE provider_allocations SET allowed_plans_json = '["b2-15","b2-candidate"]'
       WHERE organization_id = 'org-a' AND provider_account_id = 'account-ovh'`)
      .run()
    const stale = await Effect.runPromise(
      repository.resolve(
        command('org-a', 'provision-node', 'node-candidate'),
        snapshot('org-a', 'node-candidate'),
      ),
    )
    expect(stale.price.status).toBe('known')
    expect(
      evaluatePolicyAdmission({
        policy: policy('org-a'),
        ...stale,
        nowEpochMilliseconds: now,
      }),
    ).toMatchObject({
      outcome: 'deny',
      violations: expect.arrayContaining([expect.objectContaining({ code: 'price_stale' })]),
    })

    database
      .prepare(`DELETE FROM provider_catalog
       WHERE provider_type = 'ovhcloud' AND region = 'eu-west' AND plan = 'b2-candidate'`)
      .run()
    const unknown = await Effect.runPromise(
      repository.resolve(
        command('org-a', 'provision-node', 'node-candidate'),
        snapshot('org-a', 'node-candidate'),
      ),
    )
    expect(unknown.price).toEqual({ status: 'unknown' })
    expect(
      evaluatePolicyAdmission({
        policy: policy('org-a'),
        ...unknown,
        nowEpochMilliseconds: now,
      }),
    ).toMatchObject({
      outcome: 'deny',
      violations: expect.arrayContaining([expect.objectContaining({ code: 'price_unknown' })]),
    })
  })

  it('fails closed when an existing paid node has a stale catalog estimate', async () => {
    database
      .prepare(`UPDATE provider_catalog SET refreshed_at = '2026-08-22T00:00:00.000Z'
       WHERE provider_type = 'contabo' AND region = 'de-central' AND plan = 'cloud-vps-10'`)
      .run()
    await expect(runFailure(facts().readUsageSnapshot('org-a'))).resolves.toMatchObject({
      operation: 'policy.usage.commitment-price-missing',
    })
  })

  it('fails closed for new Contabo commitment without immutable node contract terms', async () => {
    const resolved = await Effect.runPromise(
      facts().resolve(
        command('org-b', 'provision-node', 'node-candidate'),
        snapshot('org-b', 'node-candidate'),
      ),
    )
    expect(resolved.price).toEqual({ status: 'unknown' })
  })

  it('fails closed rather than rounding unsafe estimated commitments', async () => {
    database
      .prepare(`UPDATE provider_catalog SET monthly_price_minor = 9007199254740992
       WHERE provider_type = 'contabo' AND region = 'de-central' AND plan = 'cloud-vps-10'`)
      .run()
    await expect(runFailure(facts().readUsageSnapshot('org-a'))).resolves.toMatchObject({
      operation: 'policy.facts.batch',
    })
  })

  it('fails closed for an in-flight paid operation without a corresponding node reservation', async () => {
    database
      .prepare(`INSERT INTO operations
       (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
        idempotency_key, correlation_id, revision, created_at, updated_at)
       VALUES ('operation-orphan', 'org-a', 'provision-node', 'node', 'node-not-reserved',
        'actor-a', 'queued', 0, 'idempotency-orphan', 'correlation-orphan', 1, ?, ?) `)
      .run(nowIso, nowIso)
    await expect(runFailure(facts().readUsageSnapshot('org-a'))).resolves.toMatchObject({
      operation: 'policy.usage.invalid-or-incomplete',
    })
  })
})

describe('policy management D1 transaction', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
  })
  afterEach(() => database.close())

  const putInput = (
    organizationId = 'org-a',
    overrides: Partial<
      Parameters<ReturnType<typeof makePolicyManagementRepositoryD1>['put']>[0]
    > = {},
  ) => ({
    context: {
      organizationId,
      identityId: 'actor-a',
      correlationId: `correlation-${organizationId}`,
    },
    expectedRevision: 1,
    policy: {
      ...policy(organizationId),
      revision: 2,
      monthlyBudget: {
        currency: 'EUR',
        setupWarningMinor: null,
        softLimitMinor: 11_000,
        hardLimitMinor: 20_000,
      },
    },
    idempotencyKey: 'policy-request-one',
    operationIdempotencyKey: `policy-operation-key-${organizationId}`,
    requestFingerprint: 'a'.repeat(64),
    operationId: `policy-operation-${organizationId}`,
    request: {
      origin: 'http' as const,
      requestId: `request-${organizationId}`,
      correlationId: `correlation-${organizationId}`,
      source: {
        ip: { state: 'captured' as const, value: '192.0.2.1' },
        access: {
          state: 'captured' as const,
          value: {
            subject: 'access-a',
            identityId: 'actor-a',
            issuer: 'test',
            email: 'actor@example.com',
          },
        },
      },
    },
    now: nowIso,
    ...overrides,
  })

  it('atomically advances both revisions and appends one operation and audit event', async () => {
    const repository = makePolicyManagementRepositoryD1(d1)
    const result = await Effect.runPromise(repository.put(putInput()))
    expect(result.value).toMatchObject({ organizationId: 'org-a', revision: 2 })
    expect(
      database
        .prepare(`SELECT policy.revision AS policyRevision,
         organization.policy_revision AS organizationRevision, policy.updated_by AS updatedBy
         FROM organization_policies policy JOIN organizations organization
          ON organization.id = policy.organization_id WHERE policy.organization_id = 'org-a'`)
        .get(),
    ).toEqual({ policyRevision: 2, organizationRevision: 2, updatedBy: 'actor-a' })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM operations WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 1 })
    const audit = database
      .prepare("SELECT summary_json AS summary FROM audit_events WHERE organization_id = 'org-a'")
      .get() as { summary: string }
    expect(JSON.parse(audit.summary)).toEqual(result.value)
  })

  it('adopts an exact replay and rejects an idempotency key rebound without writes', async () => {
    const repository = makePolicyManagementRepositoryD1(d1)
    const first = await Effect.runPromise(repository.put(putInput()))
    await expect(Effect.runPromise(repository.put(putInput()))).resolves.toEqual({
      ...first,
      replayed: true,
    })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 1 })
    await expect(
      runFailure(
        repository.put(
          putInput('org-a', {
            requestFingerprint: 'b'.repeat(64),
            policy: { ...putInput().policy, allowedRegions: ['de-central'] },
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'PolicyManagementConflictError',
      code: 'idempotency_payload_mismatch',
    })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 1 })
  })

  it('scopes the raw idempotency key independently from another action', async () => {
    database
      .prepare(`INSERT INTO operations
       (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
        idempotency_key, correlation_id, revision, created_at, updated_at)
       VALUES ('other-operation', 'org-a', 'other-action', 'server', 'server-a', 'actor-a',
        'succeeded', 100, 'policy-request-one', 'correlation-other', 1, ?, ?)`)
      .run(nowIso, nowIso)
    await expect(
      Effect.runPromise(makePolicyManagementRepositoryD1(d1).put(putInput())),
    ).resolves.toMatchObject({ replayed: false, resourceId: 'org-a' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
  })

  it('fences stale revision without a partial policy, operation, or audit write', async () => {
    const repository = makePolicyManagementRepositoryD1(d1)
    database
      .prepare("UPDATE organization_policies SET revision = 2 WHERE organization_id = 'org-a'")
      .run()
    await expect(runFailure(repository.put(putInput()))).resolves.toMatchObject({
      _tag: 'PolicyManagementPersistenceError',
      operation: 'policy.management.revision-fence',
    })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM operations WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('allows only one of two contenders that both pre-read revision one', async () => {
    const repository = makePolicyManagementRepositoryD1(d1)
    let arrived = 0
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    d1.beforeBatch = () => {
      arrived += 1
      if (arrived === 2) open()
      return gate
    }
    const contenderA = putInput('org-a', {
      idempotencyKey: 'contender-policy-a',
      requestFingerprint: 'd'.repeat(64),
      operationId: 'policy-operation-contender-a',
      policy: { ...putInput().policy, allowedRegions: ['eu-west'] },
    })
    const contenderB = putInput('org-a', {
      idempotencyKey: 'contender-policy-b',
      requestFingerprint: 'e'.repeat(64),
      operationId: 'policy-operation-contender-b',
      policy: { ...putInput().policy, allowedRegions: ['de-central'] },
    })
    const [first, second] = await Promise.all([
      Effect.runPromise(Effect.result(repository.put(contenderA))),
      Effect.runPromise(Effect.result(repository.put(contenderB))),
    ])
    const successes = [first, second].filter((result) => result._tag === 'Success')
    const failures = [first, second].filter((result) => result._tag === 'Failure')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      failure: { _tag: 'PolicyManagementConflictError', code: 'revision_mismatch' },
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
    const stored = database
      .prepare(
        "SELECT policy_json AS policyJson FROM organization_policies WHERE organization_id = 'org-a'",
      )
      .get() as { policyJson: string }
    const audit = database.prepare('SELECT summary_json AS summary FROM audit_events').get() as {
      summary: string
    }
    expect(JSON.parse(audit.summary)).toEqual(JSON.parse(stored.policyJson))
  })

  it('scopes the same idempotency key independently per organization', async () => {
    const repository = makePolicyManagementRepositoryD1(d1)
    await Effect.runPromise(repository.put(putInput('org-a')))
    await Effect.runPromise(
      repository.put(
        putInput('org-b', {
          operationId: 'policy-operation-org-b',
          requestFingerprint: 'c'.repeat(64),
        }),
      ),
    )
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 2 })
  })
})

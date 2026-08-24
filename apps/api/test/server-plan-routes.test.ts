import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError, ConflictError, PersistenceError } from '@gridora/contracts'
import { OrganizationContext, roleRank, type OrganizationRole } from '@gridora/domain'
import {
  CommercialReviewRequiredProblemCode,
  makeWorkerEffectRuntime,
} from '@gridora/http-hono-effect'
import {
  makeWebCryptoServerCreateIdentity,
  ServerCreateIdentityPortLayer,
  ServerPlanClockLayer,
  ServerPlanControl,
  ServerPlanControlLive,
  ServerPlanRepositoryLayer,
  ServerPlacementRejectedError,
  ServerProvisionValidationError,
  type ServerPlanControlShape,
} from '@gridora/server-plan-control'
import {
  makeServerPlanRepositoryD1,
  type ServerPlanD1Database,
  type ServerPlanD1Result,
  type ServerPlanD1Statement,
} from '@gridora/server-plan-d1'
import { mapServerApplyError, registerServerPlanRoutes } from '../src/server-plan-routes.js'
import {
  makeServerProvisionPlanControlRuntime,
  type ServerProvisionRuntimeBindings,
} from '../src/server-provision-runtime.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0006_lifecycle_reservations.sql',
  '0013_server_plan.sql',
] as const
const fullMigrations = readdirSync(sqlDirectory)
  .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
  .sort()
const now = '2026-08-23T14:00:00.000Z'

class SqliteStatement implements ServerPlanD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): SqliteStatement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<ServerPlanD1Result> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
  async run(): Promise<{
    readonly success: boolean
    readonly meta?: { readonly changes?: number }
  }> {
    const result = this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
    return {
      success: true,
      meta: {
        changes: typeof result.changes === 'bigint' ? Number(result.changes) : result.changes,
      },
    }
  }
}

class SqliteD1 implements ServerPlanD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<ServerPlanD1Statement>,
  ): Promise<ReadonlyArray<ServerPlanD1Result>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: ServerPlanD1Result[] = []
      for (const statement of statements) results.push(await statement.all())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }
}

type TestEnv = { Bindings: { DB: SqliteD1 } }
let database: DatabaseSync
let d1: SqliteD1
let app: Hono<TestEnv>
let runtime: ReturnType<typeof makeWorkerEffectRuntime<ServerPlanControl>>

const organizationPolicy = (organizationId: string) => ({
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

const seed = () => {
  for (const [identityId, role, organizationId, slug] of [
    ['operator-a', 'operator', 'org-a', 'organization-a'],
    ['viewer-a', 'viewer', 'org-a', 'organization-a'],
    ['operator-b', 'operator', 'org-b', 'organization-b'],
  ] as const) {
    database
      .prepare(
        `INSERT OR IGNORE INTO identities
         (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(identityId, `access-${identityId}`, `${identityId}@example.test`, identityId, now, now)
    database
      .prepare(
        `INSERT OR IGNORE INTO organizations
         (id, name, slug, status, timezone, default_region, onboarding_step,
          policy_revision, revision, created_at)
         VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 3, 1, ?)`,
      )
      .run(organizationId, organizationId, slug, now)
    database
      .prepare(
        `INSERT INTO organization_memberships
         (organization_id, identity_id, role, status, joined_at, revision)
         VALUES (?, ?, ?, 'active', ?, 1)`,
      )
      .run(organizationId, identityId, role, now)
  }
  for (const [organizationId, actorId] of [
    ['org-a', 'operator-a'],
    ['org-b', 'operator-b'],
  ] as const)
    database
      .prepare(
        `INSERT INTO organization_policies
         (organization_id, policy_json, revision, updated_by, updated_at)
         VALUES (?, ?, 3, ?, ?)`,
      )
      .run(organizationId, JSON.stringify(organizationPolicy(organizationId)), actorId, now)

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
       (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
        metadata_json, refreshed_at)
       VALUES ('ovhcloud', 'eu-west', 'b2-15', 'EUR', 5, 5000, '{}', ?)`,
    )
    .run(now)
  database
    .prepare(
      `INSERT INTO provider_accounts
       (id, scope, organization_id, provider_type, credential_reference, status,
        revision, created_at, updated_at)
       VALUES ('account-a', 'organization', 'org-a', 'ovhcloud', 'credentials-a',
        'active', 1, ?, ?)`,
    )
    .run(now, now)
  database
    .prepare(
      `INSERT INTO provider_allocations
       (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
        max_active_nodes, monthly_budget_minor, status, revision)
       VALUES ('org-a', 'account-a', '["eu-west"]', '["b2-15"]', 5, 20000, 'active', 2)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO node_images
       (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
       VALUES ('image-a', 'image-version-a', 'checksum', 'signature', '{}', 'promoted', ?, ?)`,
    )
    .run(now, now)
  database
    .prepare(
      `INSERT INTO nodes
       (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
        plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
        observed_revision, created_at, updated_at)
       VALUES ('org-a', 'node-a', 'account-a', 'instance-a', 'ovhcloud', 'eu-west',
        'b2-15', 'image-a', 'shared', 'ready', 'ready', 4, 4, ?, ?)`,
    )
    .run(now, now)
  database
    .prepare(
      `INSERT INTO node_runtime_capacity
       (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
        agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
       VALUES ('org-a', 'node-a', 'amd64', 8000, 17179869184, 214748364800,
        1, 1, 1, 1, ?, 7)`,
    )
    .run(now)
}

const authorize = (context: HonoContext<TestEnv>) =>
  Effect.gen(function* () {
    const identityId = context.req.header('x-test-identity')
    const organization = context.req.param('organization') ?? ''
    const membership = yield* Effect.try({
      try: () =>
        database
          .prepare(
            `SELECT organization.id AS organizationId, organization.slug AS organizationSlug,
             membership.role
             FROM organizations organization
             JOIN organization_memberships membership
               ON membership.organization_id = organization.id
             WHERE (organization.id = ? OR organization.slug = ?)
               AND membership.identity_id = ?
               AND membership.status = 'active' AND organization.status = 'active'`,
          )
          .get(organization, organization, identityId ?? '') as
          | { organizationId: string; organizationSlug: string; role: OrganizationRole }
          | undefined,
      catch: () =>
        new PersistenceError({
          operation: 'server-plan.test.authorize',
          message: 'Authorization persistence unavailable',
        }),
    })
    if (
      identityId === undefined ||
      membership === undefined ||
      roleRank[membership.role] < roleRank.operator
    )
      return yield* new AuthorizationError({
        code: 'role_required',
        message: 'Operator role is required',
      })
    return Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: membership.organizationId,
      organizationSlug: membership.organizationSlug,
      identityId,
      role: membership.role,
      correlationId: context.req.header('x-correlation-id') ?? 'correlation-plan-test',
    })
  })

const body = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schemaVersion: 1,
  name: 'Eastern Front',
  pluginId: 'arma-reforger',
  placementMode: 'auto',
  resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 42_949_672_960 },
  ...overrides,
})

const request = (identityId: string, requestBody: unknown) =>
  app.request(
    'https://api.gridora.test/v1/organizations/organization-a/game-servers/plan',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-identity': identityId },
      body: JSON.stringify(requestBody),
    },
    { DB: d1 },
  )

describe('game-server plan route', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
    const foundation = Layer.mergeAll(
      ServerPlanRepositoryLayer(makeServerPlanRepositoryD1(d1)),
      ServerPlanClockLayer({
        now: Effect.succeed({ iso: now, epochMilliseconds: Date.parse(now) }),
      }),
      ServerCreateIdentityPortLayer(makeWebCryptoServerCreateIdentity()),
    )
    runtime = makeWorkerEffectRuntime(ServerPlanControlLive.pipe(Layer.provide(foundation)))
    app = new Hono<TestEnv>()
    registerServerPlanRoutes(app, {
      runtimeFor: () => runtime,
      authorize,
      control: () => ServerPlanControl,
    })
  })
  afterEach(() => database.close())
  afterAll(() => runtime?.dispose())

  it('returns a real read-only D1 placement plan to an Operator', async () => {
    const changesBefore = database.prepare('SELECT total_changes() AS value').get() as {
      value: number
    }
    const response = await request('operator-a', body())
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      kind: 'existing-node',
      nodeId: 'node-a',
      pluginId: 'arma-reforger',
      pluginVersion: '0.1.0',
      newPaidInfrastructure: false,
    })
    const changesAfter = database.prepare('SELECT total_changes() AS value').get() as {
      value: number
    }
    expect(changesAfter.value).toBe(changesBefore.value)
    expect(database.prepare('SELECT COUNT(*) AS count FROM game_servers').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 0 })
  })

  it('requires an Operator and never falls back across organizations', async () => {
    expect((await request('viewer-a', body())).status).toBe(403)
    expect((await request('operator-b', body())).status).toBe(403)
  })

  it('rejects client-selected lifecycle and provider identifiers', async () => {
    const response = await request(
      'operator-a',
      body({ operationId: 'client-operation', providerAccountId: 'client-provider' }),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'REQUEST_VALIDATION_FAILED',
    })
  })

  it('returns HTTP 409 review-required when the commercial proof no longer matches the fresh plan', async () => {
    const applyApp = new Hono<TestEnv>()
    registerServerPlanRoutes(applyApp, {
      runtimeFor: () => runtime,
      authorize,
      control: () => ServerPlanControl,
      provisionControl: () =>
        Effect.succeed({
          plan: () => Effect.die('unused'),
          apply: () =>
            Effect.fail(
              new ServerProvisionValidationError({
                code: 'commercial_review_required',
                message: 'The reviewed commercial provider offer changed',
              }),
            ),
        }),
      auditRequestContext: () => ({
        origin: 'http',
        requestId: 'request-server-plan-a',
        correlationId: 'correlation-plan-test',
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
      }),
    })
    const response = await applyApp.request(
      'https://api.gridora.test/v1/organizations/organization-a/game-servers/apply',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-identity': 'operator-a',
          'idempotency-key': 'server-apply-review-a',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          server: body(),
          game: {
            schemaVersion: 1,
            name: 'Eastern Front',
            pluginId: 'arma-reforger',
            placement: { mode: 'shared' },
            resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
            config: {},
            mods: [],
          },
          commercialReviewToken: 'a'.repeat(64),
        }),
      },
      { DB: d1 },
    )

    expect(response.status, await response.clone().text()).toBe(409)
    const problem = await response.json<Record<string, unknown>>()
    expect(problem).toMatchObject({
      code: CommercialReviewRequiredProblemCode,
      detail: expect.stringMatching(/reviewed again before applying/i),
    })
    expect(problem).not.toHaveProperty('reviewedNodeProvision')
    expect(problem).not.toHaveProperty('selectionDigest')
  })

  it('turns an actually expired catalog offer from preview into review-required apply without starting infrastructure', async () => {
    const commercialDatabase = new DatabaseSync(':memory:')
    commercialDatabase.exec('PRAGMA foreign_keys = ON')
    for (const migration of fullMigrations)
      commercialDatabase.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    const commercialD1 = new SqliteD1(commercialDatabase)
    const nowEpochMilliseconds = Date.now()
    const validUntilEpochMilliseconds = nowEpochMilliseconds + 60_000
    const timestamp = new Date(nowEpochMilliseconds).toISOString()
    const commercialPolicy = {
      ...organizationPolicy('org-a'),
      temporaryNodes: { automaticExpiryRequired: false, maxLifetimeHours: 168 },
    }
    commercialDatabase
      .prepare(
        `INSERT INTO identities
         (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
         VALUES ('owner-a', 'access-owner-a', 'owner-a@example.test', 'Owner', 'active', ?, ?)`,
      )
      .run(timestamp, timestamp)
    commercialDatabase
      .prepare(
        `INSERT INTO organizations
         (id, name, slug, status, timezone, default_region, onboarding_step,
          policy_revision, revision, created_at)
         VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west', 'complete', 3, 1, ?)`,
      )
      .run(timestamp)
    commercialDatabase
      .prepare(
        `INSERT INTO organization_policies
         (organization_id, policy_json, revision, updated_by, updated_at)
         VALUES ('org-a', ?, 3, 'owner-a', ?)`,
      )
      .run(JSON.stringify(commercialPolicy), timestamp)
    commercialDatabase
      .prepare(
        `INSERT INTO organization_memberships
         (organization_id, identity_id, role, status, joined_at, revision)
         VALUES ('org-a', 'owner-a', 'owner', 'active', ?, 1)`,
      )
      .run(timestamp)
    commercialDatabase
      .prepare(
        `INSERT INTO game_plugins
         (id, version, api_version, status, capability_manifest_json, config_schema_version)
         VALUES ('arma-reforger', '0.1.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
      )
      .run()
    commercialDatabase
      .prepare(
        `INSERT INTO server_plugin_channels
         (plugin_id, active_version, plan_contract_json, revision, updated_at)
         VALUES ('arma-reforger', '0.1.0', ?, 2, ?)`,
      )
      .run(JSON.stringify(pluginContract), timestamp)
    commercialDatabase
      .prepare(
        `INSERT INTO provider_accounts
         (id, scope, organization_id, provider_type, credential_reference, status, revision,
          created_at, updated_at)
         VALUES ('account-a', 'organization', 'org-a', 'ovhcloud', 'credentials-a', 'active', 1, ?, ?)`,
      )
      .run(timestamp, timestamp)
    commercialDatabase
      .prepare(
        `INSERT INTO provider_allocations
         (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
          max_active_nodes, monthly_budget_minor, status, revision)
         VALUES ('org-a', 'account-a', '["eu-west"]', '["b2-15"]', 5, 20000, 'active', 2)`,
      )
      .run()
    commercialDatabase
      .prepare(
        `INSERT INTO provider_catalog
         (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
          metadata_json, refreshed_at)
         VALUES ('ovhcloud', 'eu-west', 'b2-15', 'EUR', 5, 5000, ?, ?)`,
      )
      .run(
        JSON.stringify({
          schemaVersion: 1,
          billingCadence: 'monthly',
          contractMonths: 1,
          validUntilEpochMilliseconds,
        }),
        timestamp,
      )
    commercialDatabase
      .prepare(
        `INSERT INTO node_images
         (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
         VALUES ('image-a', '2026.08.24', ?, 'signature-a', ?, 'promoted', ?, ?)`,
      )
      .run(
        `sha256:${'a'.repeat(64)}`,
        JSON.stringify({ ovhcloud: { 'eu-west': 'provider-image-a' } }),
        timestamp,
        timestamp,
      )

    let workflowStarted = false
    const workflow = {
      create: async (options?: { readonly id?: string }) => {
        workflowStarted = true
        return { id: options?.id ?? 'unexpected-workflow' }
      },
      get: async (id: string) => ({ id }),
    }
    const bindings = {
      DB: commercialD1,
      PROVISION_NODE: workflow,
      NODE_REGISTRATION_TOKEN_SECRET:
        'node-registration-test-secret-with-at-least-thirty-two-bytes',
      NODE_REGISTRATION_TOKEN_KEY_VERSION: '1',
      CONTROL_PLANE_URL: 'https://api.gridora.test/',
      AGENT_VERSION: '0.1.0',
      AGENT_COMMAND_SIGNING_PUBLIC_KEY_PEM: 'test-public-key',
      NODE_BOOTSTRAP_TTL_SECONDS: '900',
      SERVER_PROVISION_PLAN: workflow,
      DEPLOY_GAME_SERVER: workflow,
      RETIRE_NODE: workflow,
      SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET:
        'commercial-review-test-secret-with-at-least-thirty-two-bytes',
    } satisfies ServerProvisionRuntimeBindings
    const noFitServerPlan: ServerPlanControlShape = {
      plan: () =>
        Effect.fail(
          new ServerPlacementRejectedError({
            code: 'no_existing_node_fit',
            message: 'No ready capacity fits',
            reasons: [],
          }),
        ),
      create: () => Effect.die('not reached for commercial preview'),
    }
    const provisionControl = makeServerProvisionPlanControlRuntime(bindings, noFitServerPlan)
    const commercialRuntime = makeWorkerEffectRuntime(Layer.empty)
    const commercialApp = new Hono<TestEnv>()
    const commercialOwner = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'owner-a',
      role: 'owner',
      correlationId: 'commercial-review-test',
    })
    registerServerPlanRoutes(commercialApp, {
      runtimeFor: () => commercialRuntime,
      authorize: () => Effect.succeed(commercialOwner),
      control: () => Effect.succeed(noFitServerPlan),
      provisionControl: () => Effect.succeed(provisionControl),
      auditRequestContext: () => ({
        origin: 'http',
        requestId: 'request-commercial-review-test',
        correlationId: 'commercial-review-test',
        source: {
          ip: { state: 'captured', value: '203.0.113.10' },
          access: {
            state: 'captured',
            value: {
              subject: 'access-owner-a',
              identityId: 'owner-a',
              issuer: 'https://access.example.test',
              email: 'owner-a@example.test',
            },
          },
        },
      }),
    })

    try {
      const preview = await commercialApp.request(
        'https://api.gridora.test/v1/organizations/organization-a/game-servers/plan',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body()),
        },
        { DB: commercialD1 },
      )
      expect(preview.status, await preview.clone().text()).toBe(200)
      const planned = await preview.json<{ readonly commercialReviewToken?: string }>()
      expect(planned.commercialReviewToken).toMatch(/^[a-f0-9]{64}$/)
      const token = planned.commercialReviewToken
      if (token === undefined) throw new Error('expected an opaque commercial review token')

      // This is a real authoritative-fact mutation between preview and apply,
      // not a stubbed preview that keeps returning the old offer.
      commercialDatabase
        .prepare(
          `UPDATE provider_catalog
           SET metadata_json = ?
           WHERE provider_type = 'ovhcloud' AND region = 'eu-west' AND plan = 'b2-15'`,
        )
        .run(
          JSON.stringify({
            schemaVersion: 1,
            billingCadence: 'monthly',
            contractMonths: 1,
            validUntilEpochMilliseconds: Date.now() - 1,
          }),
        )

      // A first-time preview still has no current commercial offer to show,
      // so it remains a truthful infrastructure-facts failure rather than a
      // misleading review-required response.
      const freshPreviewAfterExpiry = await commercialApp.request(
        'https://api.gridora.test/v1/organizations/organization-a/game-servers/plan',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body()),
        },
        { DB: commercialD1 },
      )
      expect(freshPreviewAfterExpiry.status).toBe(503)

      const apply = await commercialApp.request(
        'https://api.gridora.test/v1/organizations/organization-a/game-servers/apply',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'commercial-review-stale-a',
          },
          body: JSON.stringify({
            schemaVersion: 1,
            server: { ...body(), nonHourlyCommitmentConfirmed: true },
            game: {
              schemaVersion: 1,
              name: 'Eastern Front',
              pluginId: 'arma-reforger',
              placement: { mode: 'shared' },
              resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
              config: {},
              mods: [],
            },
            commercialReviewToken: token,
          }),
        },
        { DB: commercialD1 },
      )
      expect(apply.status, await apply.clone().text()).toBe(409)
      await expect(apply.json()).resolves.toMatchObject({
        code: CommercialReviewRequiredProblemCode,
        detail: expect.stringMatching(/reviewed again before applying/i),
      })
      expect(workflowStarted).toBe(false)
      expect(commercialDatabase.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({
        count: 0,
      })
    } finally {
      await commercialRuntime.dispose()
      commercialDatabase.close()
    }
  })
})

describe('game-server apply route error mapping', () => {
  it('returns a review-required conflict when the opaque commercial proof is stale or mismatched', () => {
    const error = mapServerApplyError(
      new ServerProvisionValidationError({
        code: 'commercial_review_required',
        message: 'The reviewed commercial provider offer changed',
      }),
    )
    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ code: 'commercial_review_required' })
  })
})

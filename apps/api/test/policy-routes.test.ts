import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations as registeredMigrations } from '@gridora/migrations'
import { AuthorizationError, PersistenceError } from '@gridora/contracts'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { roleRank, type OrganizationRole } from '@gridora/domain'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import type { PolicyD1Database, PolicyD1Result, PolicyD1Statement } from '@gridora/policy-d1'
import { registerPolicyRoutes, type PolicyRouteMinimumRole } from '../src/policy-routes.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const migrations = registeredMigrations.map((migration) => migration.file)
const now = '2026-08-23T12:00:00.000Z'

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
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
}

class SqliteD1 implements PolicyD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): PolicyD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<PolicyD1Statement>,
  ): Promise<ReadonlyArray<PolicyD1Result>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: PolicyD1Result[] = []
      for (const statement of statements) {
        const result = await statement.all()
        const changes = this.database.prepare('SELECT changes() AS changes').get() as {
          changes: number
        }
        results.push({ ...result, meta: { changes: changes.changes } })
      }
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const policy = (organizationId: string, revision = 1): OrganizationPolicyV1 => ({
  schemaVersion: 1,
  organizationId,
  revision,
  allowedProviders: ['ovhcloud'],
  allowedRegions: ['eu-west'],
  allowedPlans: ['b2-15'],
  capacity: {
    maxActiveNodes: 5,
    maxDedicatedNodes: 2,
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

type TestEnv = { Bindings: { DB: SqliteD1 } }
const runtime = makeWorkerEffectRuntime(Layer.empty)
let database: DatabaseSync
let d1: SqliteD1
let app: Hono<TestEnv>

const minimumRank: Readonly<Record<PolicyRouteMinimumRole, number>> = {
  viewer: roleRank.viewer,
  administrator: roleRank.administrator,
  owner: roleRank.owner,
}

const authorize = (context: HonoContext<TestEnv>, minimumRole: PolicyRouteMinimumRole) =>
  Effect.gen(function* () {
    const identityId = context.req.header('x-test-identity')
    if (identityId === undefined)
      return yield* new AuthorizationError({
        code: 'membership_required',
        message: 'Organization membership is required',
      })
    const verifiedIdentityId: string = identityId
    const routeOrganization = context.req.param('organization') ?? ''
    const membership = yield* Effect.try({
      try: () =>
        database
          .prepare(`SELECT organization.id AS organizationId, membership.role
           FROM organizations organization
           JOIN organization_memberships membership
            ON membership.organization_id = organization.id
           WHERE (organization.id = ? OR organization.slug = ?)
            AND membership.identity_id = ? AND membership.status = 'active'
            AND organization.status = 'active'`)
          .get(routeOrganization, routeOrganization, verifiedIdentityId) as
          | { organizationId: string; role: OrganizationRole }
          | undefined,
      catch: () =>
        new PersistenceError({
          operation: 'policy.test.authorize',
          message: 'Authorization persistence unavailable',
        }),
    })
    if (membership === undefined)
      return yield* new AuthorizationError({
        code: 'membership_required',
        message: 'Organization membership is required',
      })
    if (roleRank[membership.role] < minimumRank[minimumRole])
      return yield* new AuthorizationError({
        code: 'role_required',
        message: 'A higher organization role is required',
      })
    return {
      organizationId: membership.organizationId,
      identityId: verifiedIdentityId,
      correlationId: context.req.header('x-correlation-id') ?? 'correlation-policy-test',
    }
  })

const seed = () => {
  for (const [identityId, role, organizationId] of [
    ['owner-a', 'owner', 'org-a'],
    ['admin-a', 'administrator', 'org-a'],
    ['operator-a', 'operator', 'org-a'],
    ['viewer-a', 'viewer', 'org-a'],
    ['owner-b', 'owner', 'org-b'],
  ] as const) {
    database
      .prepare(`INSERT OR IGNORE INTO identities
       (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(identityId, `access-${identityId}`, `${identityId}@example.com`, identityId, now, now)
    if (
      database.prepare('SELECT 1 FROM organizations WHERE id = ?').get(organizationId) === undefined
    )
      database
        .prepare(`INSERT INTO organizations
         (id, name, slug, status, timezone, default_region, onboarding_step,
          policy_revision, revision, created_at)
         VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
        .run(organizationId, organizationId, `${organizationId}-slug`, now)
    database
      .prepare(`INSERT INTO organization_memberships
       (organization_id, identity_id, role, status, joined_at, invited_by, revision)
       VALUES (?, ?, ?, 'active', ?, NULL, 1)`)
      .run(organizationId, identityId, role, now)
  }
  for (const organizationId of ['org-a', 'org-b'])
    database
      .prepare(`INSERT INTO organization_policies
       (organization_id, policy_json, revision, updated_by, updated_at)
       VALUES (?, ?, 1, ?, ?)`)
      .run(
        organizationId,
        JSON.stringify(policy(organizationId)),
        organizationId === 'org-a' ? 'owner-a' : 'owner-b',
        now,
      )
}

const request = (path: string, init: RequestInit = {}, identity = 'owner-a') => {
  const headers = new Headers(init.headers)
  headers.set('x-test-identity', identity)
  return app.request(
    `https://api.gridora.test${path}`,
    {
      ...init,
      headers,
    },
    { DB: d1 },
  )
}

const updateBody = (organizationId = 'org-a', overrides: Record<string, unknown> = {}) => ({
  expectedRevision: 1,
  policy: {
    ...policy(organizationId, 2),
    allowedRegions: ['eu-west', 'de-central'],
  },
  ...overrides,
})

describe('organization policy route module', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
    app = new Hono<TestEnv>()
    registerPolicyRoutes(app, {
      runtimeFor: () => runtime,
      database: (bindings) => bindings.DB,
      auditRequestContext: (context) => {
        const identityId = context.req.header('x-test-identity') ?? 'owner-a'
        return {
          origin: 'http',
          requestId: 'request-policy-route',
          correlationId: context.req.header('x-correlation-id') ?? 'correlation-policy-test',
          source: {
            ip: { state: 'captured', value: '192.0.2.1' },
            access: {
              state: 'captured',
              value: {
                subject: `access-${identityId}`,
                identityId,
                issuer: 'test',
                email: `${identityId}@example.com`,
              },
            },
          },
        }
      },
      authorize,
    })
  })
  afterEach(() => database.close())
  afterAll(() => runtime.dispose())

  it('returns a strictly tenant-scoped policy to an active viewer', async () => {
    const response = await request('/v1/organizations/org-a-slug/policy', {}, 'viewer-a')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      organizationId: 'org-a',
      revision: 1,
    })
    const crossTenant = await request('/v1/organizations/org-b/policy', {}, 'viewer-a')
    expect(crossTenant.status).toBe(403)
  })

  it('allows an administrator to atomically update operational policy and append audit', async () => {
    const response = await request(
      '/v1/organizations/org-a/policy',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'policy-update-one' },
        body: JSON.stringify(updateBody()),
      },
      'admin-a',
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resourceId: 'org-a',
      status: 'succeeded',
    })
    expect(
      database
        .prepare(`SELECT policy.revision AS policyRevision,
         organization.policy_revision AS organizationRevision
         FROM organization_policies policy JOIN organizations organization
          ON organization.id = policy.organization_id WHERE policy.organization_id = 'org-a'`)
        .get(),
    ).toEqual({ policyRevision: 2, organizationRevision: 2 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
  })

  it('requires Owner for budget and non-hourly commitment changes', async () => {
    const budgetBody = updateBody('org-a', {
      policy: {
        ...policy('org-a', 2),
        monthlyBudget: {
          currency: 'EUR',
          setupWarningMinor: null,
          softLimitMinor: 12_000,
          hardLimitMinor: 20_000,
        },
      },
    })
    const adminBudget = await request(
      '/v1/organizations/org-a/policy',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-budget-denied' },
        body: JSON.stringify(budgetBody),
      },
      'admin-a',
    )
    expect(adminBudget.status).toBe(403)

    const adminCommitment = await request(
      '/v1/organizations/org-a/policy',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'admin-commitment-denied',
        },
        body: JSON.stringify(
          updateBody('org-a', {
            policy: {
              ...policy('org-a', 2),
              nonHourlyCommitment: { explicitConfirmationRequired: false },
            },
          }),
        ),
      },
      'admin-a',
    )
    expect(adminCommitment.status).toBe(403)
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 0 })
  })

  it('allows Owner to change budget policy', async () => {
    const response = await request('/v1/organizations/org-a/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'owner-budget-allowed' },
      body: JSON.stringify(
        updateBody('org-a', {
          policy: {
            ...policy('org-a', 2),
            monthlyBudget: {
              currency: 'EUR',
              setupWarningMinor: null,
              softLimitMinor: 12_000,
              hardLimitMinor: 20_000,
            },
          },
        }),
      ),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resourceId: 'org-a',
      status: 'succeeded',
    })
    const stored = database
      .prepare(
        "SELECT policy_json AS policyJson FROM organization_policies WHERE organization_id = 'org-a'",
      )
      .get() as { policyJson: string }
    expect(JSON.parse(stored.policyJson)).toMatchObject({
      revision: 2,
      monthlyBudget: { softLimitMinor: 12_000 },
    })
  })

  it('denies policy mutation below Administrator without writing', async () => {
    const response = await request(
      '/v1/organizations/org-a/policy',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'policy-update-denied' },
        body: JSON.stringify(updateBody()),
      },
      'operator-a',
    )
    expect(response.status).toBe(403)
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 0,
    })
  })

  it('returns the exact replay and conflicts on an idempotency payload rebound', async () => {
    const send = (body: unknown) =>
      request('/v1/organizations/org-a/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'policy-replay-key' },
        body: JSON.stringify(body),
      })
    const first = await send(updateBody())
    const replay = await send(updateBody())
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    const rebound = await send(
      updateBody('org-a', {
        policy: { ...policy('org-a', 2), allowedRegions: ['de-central'] },
      }),
    )
    expect(rebound.status).toBe(409)
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
  })

  it('fails closed for stale revision, cross-org body, malformed policy, and excess fields', async () => {
    const send = (key: string, body: unknown) =>
      request('/v1/organizations/org-a/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      })
    expect((await send('policy-cross-org', updateBody('org-b'))).status).toBe(400)
    expect(
      (
        await send('policy-malformed', {
          ...updateBody(),
          policy: {
            ...policy('org-a', 2),
            monthlyBudget: {
              currency: 'EUR',
              setupWarningMinor: null,
              softLimitMinor: 30_000,
              hardLimitMinor: 20_000,
            },
          },
        })
      ).status,
    ).toBe(400)
    expect((await send('policy-excess', { ...updateBody(), bypass: true })).status).toBe(400)

    const success = await send('policy-current', updateBody())
    expect(success.status).toBe(200)
    const stale = await send('policy-stale', updateBody())
    expect(stale.status).toBe(409)
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
  })

  it('returns a retryable persistence failure for malformed or stale stored policy', async () => {
    database
      .prepare(
        "UPDATE organization_policies SET policy_json = '{}' WHERE organization_id = 'org-a'",
      )
      .run()
    const response = await request('/v1/organizations/org-a/policy')
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' })
  })

  it('does not register paid node or server creation routes', async () => {
    expect(
      (
        await request('/v1/organizations/org-a/nodes', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request('/v1/organizations/org-a/servers', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(404)
  })
})

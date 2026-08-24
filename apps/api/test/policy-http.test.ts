/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations as registeredMigrations } from '@gridora/migrations'
import { makeInitialOrganizationPolicy, type OrganizationPolicyV1 } from '@gridora/policy-control'
import { app, type ApiBindings } from '../src/index.js'

class Statement {
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
  async all(): Promise<{ results: ReadonlyArray<unknown>; meta: { changes: number } }> {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    const changes = this.database.prepare('SELECT changes() AS changes').get() as {
      changes: number
    }
    return { results, meta: { changes: changes.changes } }
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): Statement {
    return new Statement(this.database, this.database.prepare(sql))
  }
  async batch(statements: ReadonlyArray<Statement>): Promise<ReadonlyArray<unknown>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement.all())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const b64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const json = (value: unknown): string => b64(new TextEncoder().encode(JSON.stringify(value)))

describe('exported organization policy API', () => {
  let database: DatabaseSync
  let env: ApiBindings
  let assertions: Readonly<{ owner: string; admin: string; viewer: string }>

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const { file: name } of registeredMigrations.filter(({ id }) => id <= 31))
      database.exec(
        readFileSync(
          fileURLToPath(new URL(`../../../packages/migrations/sql/${name}`, import.meta.url)),
          'utf8',
        ),
      )
    const now = '2026-08-23T12:00:00Z'
    for (const [identityId, subject, role, organizationId, slug] of [
      ['owner-a', 'subject-owner', 'owner', 'org-a', 'organization-a'],
      ['admin-a', 'subject-admin', 'administrator', 'org-a', 'organization-a'],
      ['viewer-a', 'subject-viewer', 'viewer', 'org-a', 'organization-a'],
      ['owner-b', 'subject-foreign', 'owner', 'org-b', 'organization-b'],
    ] as const) {
      database
        .prepare(`INSERT OR IGNORE INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .run(identityId, subject, `${identityId}@example.com`, identityId, now, now)
      database
        .prepare(`INSERT OR IGNORE INTO organizations
        (id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at)
        VALUES (?, ?, ?, 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
        .run(organizationId, organizationId, slug, now)
      database
        .prepare(`INSERT INTO organization_memberships
        (organization_id,identity_id,role,status,joined_at,revision)
        VALUES (?, ?, ?, 'active', ?, 1)`)
        .run(organizationId, identityId, role, now)
    }
    for (const organizationId of ['org-a', 'org-b']) {
      const initial = makeInitialOrganizationPolicy({ organizationId, defaultRegion: 'eu' })
      database
        .prepare(`INSERT INTO organization_policies
        (organization_id, policy_json, revision, updated_by, updated_at)
        VALUES (?, ?, 1, ?, ?)`)
        .run(organizationId, JSON.stringify(initial), `owner-${organizationId.slice(-1)}`, now)
    }

    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    vi.stubGlobal('fetch', async () =>
      Response.json({ keys: [{ ...jwk, kid: 'policy-key', alg: 'RS256', use: 'sig' }] }),
    )
    const issuer = 'https://team.cloudflareaccess.com'
    const sign = async (subject: string) => {
      const { email } = database
        .prepare('SELECT email FROM identities WHERE access_subject = ?')
        .get(subject) as { readonly email: string }
      const header = json({ alg: 'RS256', typ: 'JWT', kid: 'policy-key' })
      const payload = json({
        iss: issuer,
        aud: ['gridora-api'],
        sub: subject,
        email,
        exp: Math.floor(Date.now() / 1_000) + 300,
      })
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      )
      return `${header}.${payload}.${b64(new Uint8Array(signature))}`
    }
    assertions = {
      owner: await sign('subject-owner'),
      admin: await sign('subject-admin'),
      viewer: await sign('subject-viewer'),
    }
    env = {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'test-invitation-secret-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_BYOP_ENABLED: 'false',
      PROVIDER_KEK_V1: { get: async () => b64(new Uint8Array(32).fill(41)) },
      OUTBOX_WAKEUPS: { send: async () => undefined },
      DB: new SqliteD1(database),
    } as unknown as ApiBindings
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  const send = (role: keyof typeof assertions, path: string, init: RequestInit = {}) =>
    app.request(
      `http://api.gridora.test${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          'cf-access-jwt-assertion': assertions[role],
        },
      },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

  it('exports tenant-scoped GET and role-separated optimistic PUT', async () => {
    const get = await send('viewer', '/v1/organizations/organization-a/policy')
    expect(get.status, await get.clone().text()).toBe(200)
    const current = (await get.json()) as OrganizationPolicyV1
    expect(current).toMatchObject({ organizationId: 'org-a', revision: 1 })
    expect((await send('viewer', '/v1/organizations/organization-b/policy')).status).toBe(403)

    const operational = { ...current, revision: 2, allowedProviders: ['ovhcloud'] }
    const admin = await send('admin', '/v1/organizations/organization-a/policy', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'policy-operational-update',
      },
      body: JSON.stringify({ expectedRevision: 1, policy: operational }),
    })
    expect(admin.status, await admin.clone().text()).toBe(200)

    const budget = {
      ...operational,
      revision: 3,
      monthlyBudget: {
        currency: 'EUR',
        setupWarningMinor: null,
        softLimitMinor: 10_000,
        hardLimitMinor: 20_000,
      },
    }
    const denied = await send('admin', '/v1/organizations/organization-a/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'policy-budget-denied' },
      body: JSON.stringify({ expectedRevision: 2, policy: budget }),
    })
    expect(denied.status).toBe(403)
    const owner = await send('owner', '/v1/organizations/organization-a/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'policy-budget-owner' },
      body: JSON.stringify({ expectedRevision: 2, policy: budget }),
    })
    expect(owner.status, await owner.clone().text()).toBe(200)
    expect(
      database
        .prepare("SELECT revision FROM organization_policies WHERE organization_id = 'org-a'")
        .get(),
    ).toEqual({ revision: 3 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE organization_id = 'org-a' AND action = 'update-organization-policy'",
        )
        .get(),
    ).toEqual({ count: 2 })
  })

  it('rejects invalid node intent and validates the active server creation contract', async () => {
    const nodeResponse = await send('owner', '/v1/organizations/organization-a/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'paid-create-remains-gated',
      },
      body: '{}',
    })
    expect(nodeResponse.status).toBe(400)
    await expect(nodeResponse.json()).resolves.toMatchObject({
      code: 'REQUEST_VALIDATION_FAILED',
    })
    const serverResponse = await send('owner', '/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'server-create-invalid-body',
      },
      body: '{}',
    })
    expect(serverResponse.status).toBe(400)
    await expect(serverResponse.json()).resolves.toMatchObject({
      code: 'REQUEST_VALIDATION_FAILED',
    })
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 0 })
  })

  it('atomically creates the exact fail-closed policy and rejects an unpaired setup warning', async () => {
    const malformed = await send('owner', '/v1/organizations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'organization-invalid-budget',
      },
      body: JSON.stringify({
        name: 'Invalid Budget',
        slug: 'invalid-budget',
        timezone: 'UTC',
        defaultRegion: 'eu-west',
        termsAccepted: true,
        budgetWarningThresholdMinor: 2_500,
      }),
    })
    expect(malformed.status).toBe(400)

    const createRequest = () =>
      send('owner', '/v1/organizations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'organization-policy-create',
        },
        body: JSON.stringify({
          name: 'Policy Organization',
          slug: 'policy-organization',
          timezone: 'UTC',
          defaultRegion: 'eu-west',
          termsAccepted: true,
          budgetWarningThresholdMinor: 2_500,
          budgetWarningCurrency: 'EUR',
        }),
      })
    const created = await createRequest()
    expect(created.status, await created.clone().text()).toBe(201)
    const result = (await created.json()) as {
      operationId: string
      resourceId: string
      status: string
    }
    const row = database
      .prepare(
        'SELECT policy_json AS policyJson, revision FROM organization_policies WHERE organization_id = ?',
      )
      .get(result.resourceId) as { policyJson: string; revision: number }
    expect(JSON.parse(row.policyJson)).toEqual(
      makeInitialOrganizationPolicy({
        organizationId: result.resourceId,
        defaultRegion: 'eu-west',
        setupBudgetWarning: { minor: 2_500, currency: 'EUR' },
      }),
    )
    expect(row.revision).toBe(1)
    expect(
      database
        .prepare('SELECT policy_revision AS policyRevision FROM organizations WHERE id = ?')
        .get(result.resourceId),
    ).toEqual({ policyRevision: 1 })
    const replay = await createRequest()
    expect(replay.status).toBe(201)
    await expect(replay.json()).resolves.toEqual(result)
    expect(
      database
        .prepare('SELECT count(*) AS count FROM organization_policies WHERE organization_id = ?')
        .get(result.resourceId),
    ).toEqual({ count: 1 })
  })
})

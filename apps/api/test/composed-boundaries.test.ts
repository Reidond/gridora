/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import { migrations as registeredMigrations } from '@gridora/migrations'
import { verifyRealtimeTicket } from '@gridora/realtime/ticket'
import { app, type ApiBindings } from '../src/index.js'

vi.mock('@gridora/realtime/ticket', async () => import('../../../workers/realtime/src/ticket.js'))

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

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const jsonPart = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)))

describe('centrally composed API boundaries', () => {
  let database: DatabaseSync
  let env: ApiBindings
  let assertion: string
  let jwksRequests: number

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const { file: name } of registeredMigrations.filter(({ id }) => id <= 31))
      database.exec(
        readFileSync(
          fileURLToPath(new URL(`../../../packages/migrations/sql/${name}`, import.meta.url)),
          'utf8',
        ),
      )

    const now = '2026-08-23T12:00:00.000Z'
    database
      .prepare(`INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('identity-a', 'subject-a', 'a@example.com', 'A', 'active', ?, ?)`)
      .run(now, now)
    database
      .prepare(`INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision,
         revision, created_at)
        VALUES ('org-a', 'A', 'organization-a', 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
      .run(now)
    database
      .prepare(`INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision,
         revision, created_at)
        VALUES ('org-b', 'B', 'organization-b', 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
      .run(now)
    database
      .prepare(`INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, revision)
        VALUES ('org-a', 'identity-a', 'operator', 'active', ?, 7)`)
      .run(now)
    const invitationToken = 'a'.repeat(64)
    const invitationTokenHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invitationToken)),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    database
      .prepare(`INSERT INTO organization_invitations
        (id, organization_id, email, role, token_hash, expires_at, inviter_id,
         status, created_at, revision)
        VALUES ('invite-existing', 'org-b', 'a@example.com', 'viewer', ?,
          '2099-08-24T12:00:00.000Z', 'identity-a', 'pending', ?, 1)`)
      .run(invitationTokenHash, now)
    database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES ('op-orphan', 'org-a', 'reconcile-orphan', 'organization', 'org-a', 'identity-a',
          'running', 10, 'workflow-test', 'corr-workflow', 1, ?, ?)`)
      .run(now, now)

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
    jwksRequests = 0
    vi.stubGlobal('fetch', async () => {
      jwksRequests += 1
      return Response.json({ keys: [{ ...jwk, kid: 'composed-key', alg: 'RS256', use: 'sig' }] })
    })
    const issuer = 'https://team.cloudflareaccess.com'
    const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid: 'composed-key' })
    const payload = jsonPart({
      iss: issuer,
      aud: ['gridora-api'],
      sub: 'subject-a',
      email: 'a@example.com',
      exp: Math.floor(Date.now() / 1_000) + 300,
    })
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    assertion = `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
    env = {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'invitation-secret-with-at-least-thirty-two-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: { get: async () => base64Url(new Uint8Array(32).fill(1)) },
      REALTIME_TICKET_SECRET: 'realtime-secret-with-at-least-thirty-two-bytes',
      ORGANIZATION_EVENTS: { getByName: () => ({ initialize: async () => undefined }) },
      DB: new SqliteD1(database),
    } as unknown as ApiBindings
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  const access = (path: string, init: RequestInit = {}) =>
    app.request(
      `https://api.gridora.test${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          'cf-access-jwt-assertion': assertion,
        },
      },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

  it('reaches desired-state reads only after Access and exact tenant authorization', async () => {
    const reachable = await access(
      '/v1/organizations/organization-a/game-servers/missing-server/config',
    )
    expect(reachable.status).toBe(404)
    expect((await reachable.json()) as { code: string }).toMatchObject({ code: 'NOT_FOUND' })

    const foreign = await access(
      '/v1/organizations/organization-b/game-servers/missing-server/config',
    )
    expect(foreign.status).toBe(403)
  })

  it('accepts an invitation for the Access-authenticated existing identity exactly once', async () => {
    const invitationToken = 'a'.repeat(64)
    const first = await access(`/v1/invitations/${invitationToken}/actions/accept`, {
      method: 'POST',
      headers: { 'idempotency-key': 'accept-invitation-existing-01' },
    })
    expect(first.status, await first.clone().text()).toBe(200)
    const firstPayload = (await first.json()) as {
      readonly operationId: string
      readonly resourceId: string
      readonly status: string
    }
    expect(firstPayload).toMatchObject({ resourceId: 'invite-existing', status: 'succeeded' })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM organization_memberships
          WHERE organization_id = 'org-b' AND identity_id = 'identity-a'`)
        .get(),
    ).toEqual({ count: 1 })

    const replay = await access(`/v1/invitations/${invitationToken}/actions/accept`, {
      method: 'POST',
      headers: { 'idempotency-key': 'accept-invitation-existing-01' },
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toEqual(firstPayload)

    const differentRequest = await access(`/v1/invitations/${invitationToken}/actions/accept`, {
      method: 'POST',
      headers: { 'idempotency-key': 'accept-invitation-existing-02' },
    })
    expect(differentRequest.status).toBe(409)
  })

  it('keeps desired-state mutations strict while exposing the tenant mod read', async () => {
    const config = await access('/v1/organizations/organization-a/game-servers/server-a/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const mods = await access('/v1/organizations/organization-a/game-servers/server-a/mods', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    for (const response of [config, mods]) {
      expect(response.status).toBe(400)
    }
  })

  it('bypasses Access on observation ingestion and requires a machine bearer credential', async () => {
    const before = jwksRequests
    const missing = await app.request(
      'https://api.gridora.test/v1/agent/events',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    )
    expect(missing.status).toBe(403)
    await expect(missing.json()).resolves.toMatchObject({ code: 'ORGANIZATION_ACCESS_DENIED' })
    expect(jwksRequests).toBe(before)

    const unknown = await app.request(
      'https://api.gridora.test/v1/agent/events',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'x'.repeat(64)}`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
      env,
    )
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toMatchObject({ code: 'NOT_FOUND' })
    expect(jwksRequests).toBe(before)
  })

  it('issues Access-authorized realtime tickets with the current membership revision', async () => {
    const first = await access('/v1/organizations/organization-a/events/ticket', {
      method: 'POST',
    })
    expect(first.status, await first.clone().text()).toBe(200)
    const firstBody = (await first.json()) as { ticket: string; expiresAt: number }
    const firstClaims = await Effect.runPromise(
      verifyRealtimeTicket(firstBody.ticket, env.REALTIME_TICKET_SECRET, {
        organizationId: 'org-a',
        resourceType: 'organization',
        resourceId: 'org-a',
      }),
    )
    expect(firstClaims.sessionVersion).toBe(7)

    database
      .prepare(`UPDATE organization_memberships SET revision = 8
        WHERE organization_id = 'org-a' AND identity_id = 'identity-a'`)
      .run()
    const second = await access('/v1/organizations/organization-a/events/ticket', {
      method: 'POST',
    })
    const secondBody = (await second.json()) as { ticket: string }
    const secondClaims = await Effect.runPromise(
      verifyRealtimeTicket(secondBody.ticket, env.REALTIME_TICKET_SECRET, {
        organizationId: 'org-a',
        resourceType: 'organization',
        resourceId: 'org-a',
      }),
    )
    expect(secondClaims.sessionVersion).toBe(8)
  })

  it('does not report false success for an uncomposed reconcile-orphan Workflow step', async () => {
    const body = JSON.stringify({
      operationId: 'op-orphan',
      organizationId: 'org-a',
      resourceId: 'org-a',
      resourceType: 'organization',
      actorId: 'identity-a',
      correlationId: 'corr-workflow',
      idempotencyKey: 'workflow-test',
      input: {},
      stepName: 'record-operation-started',
      ordinal: 0,
    })
    const routing = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: 'reconcile-orphan',
      workflowStep: 'record-operation-started',
      workflowStepOrdinal: '0',
      organizationId: 'org-a',
    }
    const secret = 'internal-service-secret-with-at-least-thirty-two-bytes'
    const headers = await Effect.runPromise(
      signInternalRequest(body, secret, Date.now(), 'nonce-orphan-not-composed', routing),
    )
    const response = await app.request(
      'https://api.gridora.test/v1/internal/workflow-steps/execute',
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'x-gridora-workflow': routing.workflow,
          'x-gridora-workflow-step': routing.workflowStep,
          'x-gridora-workflow-step-ordinal': routing.workflowStepOrdinal,
          'x-gridora-organization-id': routing.organizationId,
        },
        body,
      },
      {
        ...env,
        INTERNAL_SERVICE_SECRET: secret,
        INTERNAL_REPLAY_GUARD: { getByName: () => ({ claim: async () => true }) },
      } as unknown as ApiBindings,
    )
    expect(response.status).toBe(501)
    const operation = database
      .prepare(`SELECT status, progress, revision FROM operations WHERE id = 'op-orphan'`)
      .get() as { status: string; progress: number; revision: number }
    expect(operation).toEqual({ status: 'running', progress: 10, revision: 1 })
  })
})

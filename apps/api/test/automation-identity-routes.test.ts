import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError } from '@gridora/contracts'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { OrganizationContext } from '@gridora/domain'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  AutomationIdentity,
  AutomationIdentityNotFoundError,
  type AutomationIdentityControlError,
  type AutomationIdentityControlShape,
} from '@gridora/automation-identity-control'
import { registerAutomationIdentityRoutes } from '../src/automation-identity-routes.js'

type TestEnv = { Bindings: Record<string, never> }
const runtime = makeWorkerEffectRuntime(Layer.empty)
const now = '2026-08-23T12:00:00.000Z'
const rawCredential =
  'grda.v1.automation_client_aaaaaaaaaaaaaaaa.automation_credential_aaaaaaaaaaaa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const identity = Schema.decodeUnknownSync(AutomationIdentity)({
  organizationId: 'org-a',
  id: 'automation_identity_aaaaaaaaaaaaaaaa',
  name: 'Release CI',
  clientId: 'automation_client_aaaaaaaaaaaaaaaa',
  scopes: ['servers.manage', 'operations.read'],
  capabilities: ['operations.read', 'servers.manage'],
  status: 'active',
  expiresAt: '2026-08-24T12:00:00.000Z',
  credentialVersion: 1,
  lastUsedAt: null,
  createdBy: 'owner-a',
  createdAt: now,
  revokedAt: null,
  revision: 1,
})

const actor = (role: 'owner' | 'administrator' | 'operator' | 'viewer' | 'automation') =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId: 'org-a',
    organizationSlug: 'organization-a',
    identityId: `${role}-a`,
    role,
    correlationId: 'correlation-automation-route-test',
  })

let nextFailure: AutomationIdentityControlError | undefined
let app: Hono<TestEnv>
let calls: {
  readonly create: Array<{ readonly idempotencyKey: string }>
  readonly rotate: Array<{ readonly expectedRevision: number }>
  readonly revoke: Array<{ readonly expectedRevision: number }>
}

const control: AutomationIdentityControlShape = {
  create: (_actor, command) => {
    calls.create.push({ idempotencyKey: command.idempotencyKey })
    if (nextFailure !== undefined) return Effect.fail(nextFailure)
    return Effect.succeed(
      command.idempotencyKey === 'automation-replay-0001'
        ? { identity, replayed: true }
        : { identity, replayed: false, credential: rawCredential },
    )
  },
  list: () => (nextFailure === undefined ? Effect.succeed([identity]) : Effect.fail(nextFailure)),
  rotate: (_actor, command) => {
    calls.rotate.push({ expectedRevision: command.expectedRevision })
    if (nextFailure !== undefined) return Effect.fail(nextFailure)
    return Effect.succeed({
      identity: { ...identity, revision: 2 },
      replayed: false,
      credential: rawCredential,
    })
  },
  revoke: (_actor, command) => {
    calls.revoke.push({ expectedRevision: command.expectedRevision })
    if (nextFailure !== undefined) return Effect.fail(nextFailure)
    return Effect.succeed({
      identity: {
        ...identity,
        status: 'revoked' as const,
        revision: 2,
        revokedAt: identity.createdAt,
      },
      replayed: false,
    })
  },
}

const authorize = (context: HonoContext<TestEnv>) => {
  const requested = context.req.header('x-test-role')
  if (requested === undefined)
    return Effect.fail(
      new AuthorizationError({ code: 'membership_required', message: 'Membership is required' }),
    )
  return Effect.succeed(
    actor(requested as 'owner' | 'administrator' | 'operator' | 'viewer' | 'automation'),
  )
}

const request = (path: string, init: RequestInit = {}, role = 'owner') => {
  const headers = new Headers(init.headers)
  headers.set('x-test-role', role)
  return app.request(`https://api.gridora.test${path}`, { ...init, headers }, {})
}

const createBody = {
  name: 'Release CI',
  scopes: ['servers.manage', 'operations.read'],
  expiresAt: '2026-08-24T12:00:00.000Z',
}

const auditRequestContext: AuditRequestContextValue = {
  origin: 'http',
  requestId: 'request-automation-route-test',
  correlationId: 'correlation-automation-route-test',
  source: {
    ip: { state: 'captured', value: '203.0.113.10' },
    access: {
      state: 'captured',
      value: {
        subject: 'access-subject-owner-a',
        identityId: null,
        issuer: 'https://access.gridora.test',
        email: 'owner-a@example.test',
      },
    },
  },
}

describe('automation identity management route module', () => {
  beforeEach(() => {
    nextFailure = undefined
    calls = { create: [], rotate: [], revoke: [] }
    app = new Hono<TestEnv>()
    registerAutomationIdentityRoutes(app, {
      runtimeFor: () => runtime,
      auditRequestContext: () => auditRequestContext,
      authorize: (context) => authorize(context),
      control: () => Effect.succeed(control),
    })
  })
  afterAll(() => runtime.dispose())

  it('returns a new credential once with no-store controls and redacts a replay', async () => {
    const created = await request('/v1/organizations/organization-a/automation-identities', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'automation-create-0001' },
      body: JSON.stringify(createBody),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store, private')
    expect(created.headers.get('referrer-policy')).toBe('no-referrer')
    await expect(created.json()).resolves.toMatchObject({
      credential: rawCredential,
      replayed: false,
    })

    const replay = await request('/v1/organizations/organization-a/automation-identities', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'automation-replay-0001' },
      body: JSON.stringify(createBody),
    })
    expect(replay.status).toBe(200)
    const replayJson = await replay.json()
    expect(replayJson).toMatchObject({ identity: { id: identity.id }, replayed: true })
    expect(replayJson).not.toHaveProperty('credential')
    expect(JSON.stringify(replayJson)).not.toContain(rawCredential)
  })

  it('requires a human Owner or Administrator even if an upstream adapter is misconfigured', async () => {
    for (const role of ['operator', 'viewer', 'automation'] as const) {
      const response = await request(
        '/v1/organizations/organization-a/automation-identities',
        {},
        role,
      )
      expect(response.status).toBe(403)
    }
    const administrator = await request(
      '/v1/organizations/organization-a/automation-identities',
      {},
      'administrator',
    )
    expect(administrator.status).toBe(200)
    await expect(administrator.json()).resolves.toEqual({ items: [identity] })
  })

  it('strictly validates mutation input and revision headers before the control layer', async () => {
    const extraField = await request('/v1/organizations/organization-a/automation-identities', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'automation-create-0002' },
      body: JSON.stringify({ ...createBody, credential: rawCredential }),
    })
    expect(extraField.status).toBe(400)
    expect(calls.create).toHaveLength(0)

    const staleHeader = await request(
      `/v1/organizations/organization-a/automation-identities/${identity.id}/actions/rotate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'automation-rotate-0001',
          'if-match': '0',
        },
        body: JSON.stringify({ expiresAt: '2026-08-24T12:00:00.000Z' }),
      },
    )
    expect(staleHeader.status).toBe(400)
    expect(calls.rotate).toHaveLength(0)
  })

  it('does not disclose a forged cross-tenant identity in a public failure', async () => {
    const foreignId = 'automation_identity_foreign_secret'
    nextFailure = new AutomationIdentityNotFoundError({ automationIdentityId: foreignId })
    const response = await request(
      `/v1/organizations/organization-a/automation-identities/${foreignId}/actions/rotate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'automation-rotate-0002',
          'if-match': '1',
        },
        body: JSON.stringify({ expiresAt: '2026-08-24T12:00:00.000Z' }),
      },
    )
    expect(response.status).toBe(404)
    const publicBody = await response.text()
    expect(publicBody).not.toContain(foreignId)
    expect(publicBody).not.toContain(rawCredential)
  })

  it('never returns credentials from list or revoke responses', async () => {
    const listed = await request('/v1/organizations/organization-a/automation-identities')
    expect(listed.status).toBe(200)
    expect(await listed.text()).not.toContain(rawCredential)

    const revoked = await request(
      `/v1/organizations/organization-a/automation-identities/${identity.id}/actions/revoke`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'automation-revoke-0001',
          'if-match': '1',
        },
        body: '{}',
      },
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.text()).not.toContain(rawCredential)
    expect(calls.revoke).toEqual([{ expectedRevision: 1 }])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import {
  app,
  canonicalCreateResourceId,
  deriveInvitationToken,
  deriveNodeCredential,
  authenticationIntentStoredState,
  deriveNodeCredentialCandidates,
  recoverInvitationToken,
  validateSecretKeyring,
  operationIdempotencyScope,
  canonicalMutationFingerprint,
  browserCorsPolicyFor,
  persistWithReservationRelease,
  trustedCloudflareIp,
  consumeAuthenticationIntentState,
  type ApiBindings,
} from '../src/index.js'

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const jsonPart = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)))

const suspendedAccessFixture = async (
  status: 'active' | 'suspended' = 'suspended',
  leaveReceipt = false,
): Promise<{
  readonly assertion: string
  readonly env: ApiBindings
  readonly queries: ReadonlyArray<string>
}> => {
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
    Response.json({ keys: [{ ...jwk, kid: 'suspended-key', alg: 'RS256', use: 'sig' }] }),
  )
  const issuer = 'https://team.cloudflareaccess.com'
  const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid: 'suspended-key' })
  const payload = jsonPart({
    iss: issuer,
    aud: ['gridora-api'],
    sub: 'suspended-subject',
    email: 'suspended@example.com',
    exp: Math.floor(Date.now() / 1_000) + 300,
  })
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  const queries: string[] = []
  const leaveFingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          canonicalMutationFingerprint(
            'organization.membership.leave',
            'organization_membership',
            'identity_suspended',
            {
              actorId: 'identity_suspended',
              organizationId: 'org-a',
              expectedRevision: 7,
            },
          ),
        ),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const statement = (sql: string) => ({
    bind() {
      return this
    },
    async first() {
      if (sql.includes('core_mutation_receipts'))
        return leaveReceipt
          ? {
              organizationId: 'org-a',
              operationId: 'operation-leave',
              resourceId: 'identity_suspended',
              requestFingerprint: leaveFingerprint,
            }
          : null
      return {
        id: 'identity_suspended',
        accessSubject: 'suspended-subject',
        email: 'suspended@example.com',
        displayName: 'Suspended User',
        status,
        signedUpAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      }
    },
    async all() {
      return { results: [] }
    },
    async run() {
      return { success: true, meta: { changes: 0 } }
    },
  })
  return {
    assertion: `${header}.${payload}.${base64Url(new Uint8Array(signature))}`,
    queries,
    env: {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'test-invitation-secret-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: { get: async () => base64Url(new Uint8Array(32).fill(7)) },
      DB: {
        prepare: (sql: string) => {
          queries.push(sql)
          return statement(sql)
        },
        batch: async () => [],
      },
    } as unknown as ApiBindings,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('API edge adapter', () => {
  it('does not treat malformed CF-Connecting-IP values as captured source evidence', () => {
    expect(trustedCloudflareIp('face')).toBeUndefined()
    expect(trustedCloudflareIp(':::')).toBeUndefined()
    expect(trustedCloudflareIp('2001:db8::4')).toBe('2001:db8::4')
  })

  it('canonicalizes malformed client request IDs for middleware errors and response headers', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/internal/queue-events',
      {
        method: 'POST',
        headers: { 'x-request-id': 'bad request!', 'x-correlation-id': 'bad correlation!' },
        body: '{}',
      },
      { INTERNAL_SERVICE_SECRET: 'test-internal-secret' } as ApiBindings,
    )
    const body = await response.json<{ readonly requestId: string }>()
    expect(response.status).toBe(403)
    expect(body.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
    expect(body.requestId).not.toBe('bad request!')
    expect(response.headers.get('x-request-id')).toBe(body.requestId)
    expect(response.headers.get('x-correlation-id')).toBe(body.requestId)
  })

  it('serves health and generated OpenAPI through a real Hono fetch', async () => {
    const health = await app.request('http://api.gridora.test/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    const openapi = await app.request('http://api.gridora.test/openapi.json')
    expect(openapi.status).toBe(200)
    expect(await openapi.json()).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Gridora API' },
      paths: {
        '/v1/organizations/{organization}/nodes': {
          post: { responses: { '202': { description: 'Success' } } },
        },
        '/v1/organizations/{organization}/game-servers/plan': {
          post: { responses: { '200': { description: 'Success' } } },
        },
        '/v1/organizations/{organization}/game-servers': {
          post: { responses: { '202': { description: 'Success' } } },
        },
        '/v1/organizations/{organization}/notification-remediation': {
          get: { responses: { '200': { description: 'Success' } } },
        },
      },
    })
  })

  it('serves only the static first-party plugin registry to an active identity', async () => {
    const fixture = await suspendedAccessFixture('active')
    const headers = { 'cf-access-jwt-assertion': fixture.assertion }
    const list = await app.request('http://api.gridora.test/v1/plugins', { headers }, fixture.env)
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject([
      { id: 'arma-reforger', apiVersion: 'gridora.plugin/v1alpha1' },
      { id: 'valheim', apiVersion: 'gridora.plugin/v1alpha1' },
    ])
    const missing = await app.request(
      'http://api.gridora.test/v1/plugins/minecraft',
      { headers },
      fixture.env,
    )
    expect(missing.status).toBe(404)
  })

  it('adopts an exact self-leave operation response after the membership is gone', async () => {
    const fixture = await suspendedAccessFixture('active', true)
    const request = () =>
      app.request(
        'http://api.gridora.test/v1/organizations/organization-a/actions/leave',
        {
          method: 'POST',
          headers: {
            'cf-access-jwt-assertion': fixture.assertion,
            'content-type': 'application/json',
            'idempotency-key': 'leave-response-loss',
          },
          body: JSON.stringify({ expectedRevision: 7 }),
        },
        fixture.env,
      )
    await expect(request()).resolves.toMatchObject({ status: 200 })
    await expect(request()).resolves.toMatchObject({ status: 200 })
    expect(fixture.queries.filter((sql) => sql.includes('core_mutation_receipts'))).toHaveLength(2)
    expect(fixture.queries.some((sql) => sql.includes('FROM organization_memberships'))).toBe(false)
  })

  it('allows only the opaque auth-state header on configured console preflight', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/auth/complete',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://console.gridora.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-gridora-auth-state',
        },
      },
      {
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
      } as ApiBindings,
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://console.gridora.example',
    )
    const allowedHeaders = response.headers.get('access-control-allow-headers') ?? ''
    expect(allowedHeaders).toContain('x-gridora-auth-state')
    expect(allowedHeaders).not.toContain('x-gridora-auth-intent')
    expect(allowedHeaders).not.toContain('x-gridora-csrf')
  })

  it('allows the public origin to preflight only an authentication-intent POST', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/auth/intents',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.gridora.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-request-id',
        },
      },
      {
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
      } as ApiBindings,
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.gridora.example')
    expect(response.headers.get('access-control-allow-methods')).toBe('POST')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'content-type,x-request-id,x-correlation-id',
    )
    expect(response.headers.get('vary')).toBe(
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    )
  })

  it('sets credentialed response CORS only for the public authentication-intent POST', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/auth/intents',
      {
        method: 'POST',
        headers: {
          origin: 'https://app.gridora.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ intent: 'sign-in', returnTo: '/' }),
      },
      {
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
        AUTH_INTENT_RATE_LIMIT: {
          getByName: () => ({ allow: async () => true }),
        },
        AUTH_INTENT_STATE: {
          getByName: () => ({ issue: async () => true }),
        },
      } as unknown as ApiBindings,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.gridora.example')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('sets credentialed response CORS for an Access-authenticated console human route', async () => {
    const fixture = await suspendedAccessFixture('active')
    const response = await app.request(
      'http://api.gridora.test/v1/plugins',
      {
        headers: {
          origin: 'https://console.gridora.example',
          'cf-access-jwt-assertion': fixture.assertion,
        },
      },
      {
        ...fixture.env,
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://console.gridora.example',
    )
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('denies public CORS beyond authentication intents and never exposes agent or internal paths', async () => {
    const env = {
      PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
      CONSOLE_ORIGIN: 'https://console.gridora.example',
      INTERNAL_SERVICE_SECRET: 'test-internal-secret',
    } as ApiBindings
    const publicHumanRoute = await app.request(
      'http://api.gridora.test/v1/auth/complete',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.gridora.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      },
      env,
    )
    const internalRoute = await app.request(
      'http://api.gridora.test/v1/internal/queue-events',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://console.gridora.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      },
      env,
    )
    const internalResponse = await app.request(
      'http://api.gridora.test/v1/internal/queue-events',
      {
        method: 'POST',
        headers: { origin: 'https://console.gridora.example' },
        body: '{}',
      },
      env,
    )
    const consoleIntent = await app.request(
      'http://api.gridora.test/v1/auth/intents',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://console.gridora.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      },
      env,
    )

    for (const response of [publicHumanRoute, internalRoute, internalResponse, consoleIntent]) {
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    }
  })

  it('denies CORS header escalation and keeps CSRF route-scoped after Access authentication', async () => {
    const rejectedHeader = await app.request(
      'http://api.gridora.test/v1/auth/intents',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.gridora.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      },
      {
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
      } as ApiBindings,
    )
    expect(rejectedHeader.status).toBe(403)

    const fixture = await suspendedAccessFixture('active', true)
    const csrfRejected = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/actions/leave',
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': fixture.assertion,
          'content-type': 'application/json',
          'idempotency-key': 'public-cross-site-leave',
          origin: 'https://app.gridora.example',
        },
        body: JSON.stringify({ expectedRevision: 7 }),
      },
      {
        ...fixture.env,
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
      },
    )
    expect(csrfRejected.status).toBe(403)
    await expect(csrfRejected.json()).resolves.toMatchObject({ code: 'CSRF_REJECTED' })
    expect(csrfRejected.headers.get('access-control-allow-origin')).toBeNull()

    expect(
      browserCorsPolicyFor({
        path: '/v1/organizations/org-a/actions/leave',
        method: 'POST',
        origin: 'https://console.gridora.example',
        publicAppOrigin: 'https://app.gridora.example',
        consoleOrigin: 'https://console.gridora.example',
      }),
    ).toBeDefined()
  })

  it('never exposes internal handlers without an HMAC signature', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/internal/queue-events',
      { method: 'POST', body: '{}' },
      { INTERNAL_SERVICE_SECRET: 'test-internal-secret' } as ApiBindings,
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
  })

  it('scopes idempotency to the concrete resource as well as actor and route', () => {
    const first = operationIdempotencyScope(
      'org_1',
      'identity_1',
      'create',
      'node',
      'node_1',
      'client-key',
    )
    const second = operationIdempotencyScope(
      'org_1',
      'identity_1',
      'create',
      'node',
      'node_2',
      'client-key',
    )
    expect(first).not.toBe(second)
    expect(first).toContain(':node:node_1:')
  })

  it('returns one canonical created resource across two independent HTTP retries', async () => {
    const retryApp = new Hono()
    retryApp.post('/nodes', async (context) =>
      context.json({
        resourceId: await Effect.runPromise(
          canonicalCreateResourceId(
            'org_1',
            'identity_1',
            '/v1/organizations/:organization/nodes',
            'node',
            context.req.header('idempotency-key') ?? '',
          ),
        ),
      }),
    )
    const request = () =>
      retryApp.request('https://api.gridora.test/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'same-create-key' },
        body: JSON.stringify({ region: 'eu-west' }),
      })
    const first = await (await request()).json<{ resourceId: string }>()
    const retry = await (await request()).json<{ resourceId: string }>()
    expect(retry.resourceId).toBe(first.resourceId)
    expect(first.resourceId).toMatch(/^node_[a-f0-9]{24}$/)
  })

  it('derives stable invitation and node credentials for lost-response retries', async () => {
    const invitationSecret = 'invitation-secret-with-at-least-thirty-two-bytes'
    const firstInvitation = await Effect.runPromise(
      deriveInvitationToken(invitationSecret, 'org_1:key_1'),
    )
    // The persistence scope excludes the administrator, so another authorized
    // administrator can safely retry the same organization idempotency key.
    const retriedInvitationByAnotherAdministrator = await Effect.runPromise(
      deriveInvitationToken(invitationSecret, 'org_1:key_1'),
    )
    const otherInvitation = await Effect.runPromise(
      deriveInvitationToken(invitationSecret, 'org_1:key_2'),
    )
    expect(retriedInvitationByAnotherAdministrator).toEqual(firstInvitation)
    expect(otherInvitation.token).not.toBe(firstInvitation.token)

    const credentialSecret = 'node-credential-secret-with-at-least-thirty-two-bytes'
    const firstCredential = await Effect.runPromise(
      deriveNodeCredential(
        credentialSecret,
        'token_hash_1',
        'org_1',
        'node_1',
        'provider_instance_1',
      ),
    )
    const retriedCredential = await Effect.runPromise(
      deriveNodeCredential(
        credentialSecret,
        'token_hash_1',
        'org_1',
        'node_1',
        'provider_instance_1',
      ),
    )
    expect(retriedCredential).toEqual(firstCredential)
    expect(firstCredential.credential).toHaveLength(64)
  })

  it('stores only an invitation-token hash in authentication intent state', async () => {
    const rawToken = 'raw-invitation-capability-never-persisted'
    const stored = await Effect.runPromise(
      authenticationIntentStoredState({
        intent: 'accept-invitation',
        returnTo: '/invitations/accept',
        invitationToken: rawToken,
      }),
    )
    expect(stored).not.toHaveProperty('invitationToken')
    expect(stored.invitationTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(rawToken)
  })

  it('recovers lost-response invitation and node credentials across one overlapping key rotation', async () => {
    const oldSecret = 'old-secret-with-at-least-thirty-two-bytes'
    const newSecret = 'new-secret-with-at-least-thirty-two-bytes'
    const oldInvitation = await Effect.runPromise(deriveInvitationToken(oldSecret, 'org_1:key_1'))
    const recovered = await Effect.runPromise(
      recoverInvitationToken(
        [
          { secret: newSecret, version: 'v2' },
          { secret: oldSecret, version: 'v1' },
        ],
        'org_1:key_1',
        oldInvitation.hash,
      ),
    )
    expect(recovered.token).toBe(oldInvitation.token)
    expect(recovered.keyVersion).toBe('v1')
    const nodeCandidates = await Effect.runPromise(
      deriveNodeCredentialCandidates(
        newSecret,
        oldSecret,
        'token_hash',
        'org_1',
        'node_1',
        'provider_1',
      ),
    )
    expect(nodeCandidates).toHaveLength(2)
    expect(() => validateSecretKeyring('short')).toThrow()
    expect(() => validateSecretKeyring(newSecret, newSecret)).toThrow()
  })

  it('releases the matching reservation when persistence fails', async () => {
    const released: string[] = []
    const result = await Effect.runPromise(
      Effect.result(
        persistWithReservationRelease(Effect.fail('d1-insert-failed' as const), async () => {
          released.push('org_1:node:node_1:operation_1')
        }),
      ),
    )

    expect(result).toMatchObject({ _tag: 'Failure', failure: 'd1-insert-failed' })
    expect(released).toEqual(['org_1:node:node_1:operation_1'])
  })

  it.each([
    ['me', '/v1/me', 'GET'],
    ['bootstrap', '/v1/auth/bootstrap', 'GET'],
    ['organization creation', '/v1/organizations', 'POST'],
    ['tenant route', '/v1/organizations/example', 'GET'],
  ])(
    'rejects a suspended Access subject at the shared principal boundary for %s',
    async (_name, path, method) => {
      const fixture = await suspendedAccessFixture()
      const response = await app.request(
        `http://api.gridora.test${path}`,
        {
          method,
          headers: {
            'cf-access-jwt-assertion': fixture.assertion,
            ...(method === 'POST'
              ? { 'content-type': 'application/json', 'idempotency-key': 'suspended-test-key' }
              : {}),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        },
        fixture.env,
      )
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ code: 'IDENTITY_SUSPENDED' })
    },
  )

  it('applies the supported queue event once, allows signed delivery replay, and rejects nonce replay', async () => {
    const body = JSON.stringify({
      id: 'event_phase0',
      organizationId: 'platform',
      partitionKey: 'platform:reconciliation',
      type: 'reconciliation.scheduled',
      occurredAt: '2026-08-23T00:00:00.000Z',
      payload: { cron: '*/10 * * * *' },
    })
    const claimed = new Set<string>()
    const published = new Set<string>()
    const secret = 'test-internal-secret-with-enough-entropy'
    const env = {
      INTERNAL_SERVICE_SECRET: secret,
      INTERNAL_REPLAY_GUARD: {
        getByName: () => ({
          claim: async (scope: string, nonce: string) => {
            const key = `${scope}:${nonce}`
            if (claimed.has(key)) return false
            claimed.add(key)
            return true
          },
        }),
      },
      ORGANIZATION_EVENTS: {
        getByName: () => ({
          initialize: async () => undefined,
          publish: async (event: { id: string }) =>
            !published.has(event.id) && published.add(event.id),
        }),
      },
    } as unknown as ApiBindings
    const routing = {
      method: 'POST',
      path: '/v1/internal/queue-events',
      queue: 'gridora-reconciliation',
      organizationId: 'platform',
    }
    const firstHeaders = await Effect.runPromise(
      signInternalRequest(body, secret, Date.now(), 'nonce_phase0_first', routing),
    )
    const send = (headers: Record<string, string>, origin?: string) =>
      app.request(
        'http://api.gridora.test/v1/internal/queue-events',
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            ...(origin === undefined ? {} : { origin }),
            'x-gridora-queue': 'gridora-reconciliation',
            'x-gridora-organization-id': 'platform',
          },
          body,
        },
        env,
      )
    const first = await send(firstHeaders as Record<string, string>)
    expect(first.status).toBe(200)
    expect(first.headers.get('access-control-allow-origin')).toBeNull()
    expect(first.headers.get('access-control-allow-credentials')).toBeNull()
    const browserTransportHeaders = await Effect.runPromise(
      signInternalRequest(body, secret, Date.now(), 'nonce_phase0_browser_origin', routing),
    )
    const browserTransport = await send(
      browserTransportHeaders as Record<string, string>,
      'https://console.gridora.example',
    )
    expect(browserTransport.status).toBe(403)
    expect(browserTransport.headers.get('access-control-allow-origin')).toBeNull()
    expect(browserTransport.headers.get('access-control-allow-credentials')).toBeNull()
    await expect(first.json()).resolves.toMatchObject({
      status: 'applied',
      eventId: 'event_phase0',
    })
    const differentBody = JSON.stringify({
      operationId: 'op_1',
      organizationId: 'org_1',
      resourceId: 'resource_1',
      resourceType: 'resource',
      actorId: 'identity_1',
      correlationId: 'corr_1',
      idempotencyKey: 'idempotency_1',
      input: {},
      stepName: 'record-operation-started',
      ordinal: 0,
    })
    const differentRouting = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: 'reconcile-orphan',
      workflowStep: 'record-operation-started',
      workflowStepOrdinal: '0',
      organizationId: 'org_1',
    }
    const changedScopeHeaders = await Effect.runPromise(
      signInternalRequest(
        differentBody,
        secret,
        Date.now(),
        'nonce_phase0_first',
        differentRouting,
      ),
    )
    const changedScope = await app.request(
      'http://api.gridora.test/v1/internal/workflow-steps/execute',
      {
        method: 'POST',
        headers: {
          ...changedScopeHeaders,
          'content-type': 'application/json',
          'x-gridora-workflow': differentRouting.workflow,
          'x-gridora-workflow-step': differentRouting.workflowStep,
          'x-gridora-workflow-step-ordinal': differentRouting.workflowStepOrdinal,
          'x-gridora-organization-id': differentRouting.organizationId,
        },
        body: differentBody,
      },
      env,
    )
    expect(changedScope.status).toBe(409)
    const outboxBody = JSON.stringify({
      id: 'event_outbox',
      organizationId: 'org_1',
      partitionKey: 'org_1:organization_invitation:invite_1',
      type: 'organization.invitation.created',
      occurredAt: '2026-08-23T00:00:00.000Z',
      payload: { invitationId: 'invite_1' },
    })
    const outboxRouting = { ...routing, queue: 'gridora-outbox', organizationId: 'org_1' }
    const outboxHeaders = await Effect.runPromise(
      signInternalRequest(outboxBody, secret, Date.now(), 'nonce_outbox', outboxRouting),
    )
    const outboxResponse = await app.request(
      'http://api.gridora.test/v1/internal/queue-events',
      {
        method: 'POST',
        headers: {
          ...outboxHeaders,
          'content-type': 'application/json',
          'x-gridora-queue': 'gridora-outbox',
          'x-gridora-organization-id': 'org_1',
        },
        body: outboxBody,
      },
      env,
    )
    expect(outboxResponse.status).toBe(200)
    await expect(outboxResponse.json()).resolves.toMatchObject({
      status: 'applied',
      eventId: 'event_outbox',
    })
    const nonceReplay = await send(firstHeaders as Record<string, string>)
    expect(nonceReplay.status).toBe(409)
    const retryHeaders = await Effect.runPromise(
      signInternalRequest(body, secret, Date.now(), 'nonce_phase0_retry', routing),
    )
    const deliveryRetry = await send(retryHeaders as Record<string, string>)
    expect(deliveryRetry.status).toBe(200)
    await expect(deliveryRetry.json()).resolves.toMatchObject({
      status: 'replayed',
      eventId: 'event_phase0',
    })
  })

  it('issues a short-lived signed sign-up intent for an allowed public origin', async () => {
    const states = new Map<
      string,
      {
        verifierHash: string
        value: {
          intent: 'sign-up'
          returnTo: string
          displayName: string
        }
        consumed: boolean
      }
    >()
    const namespace = {
      getByName: (state: string) => ({
        issue: async (
          verifierHash: string,
          _expiresAt: number,
          value: { intent: 'sign-up'; returnTo: string; displayName: string },
        ) => {
          if (states.has(state)) return false
          states.set(state, { verifierHash, value, consumed: false })
          return true
        },
        consume: async (verifierHash: string) => {
          const stored = states.get(state)
          if (stored === undefined || stored.consumed || stored.verifierHash !== verifierHash)
            return null
          stored.consumed = true
          return stored.value
        },
      }),
    }
    const response = await app.request(
      'http://api.gridora.test/v1/auth/intents',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://app.gridora.example' },
        body: JSON.stringify({
          intent: 'sign-up',
          returnTo: '/setup/organization',
          displayName: 'Gridora Owner',
        }),
      },
      {
        AUTH_INTENT_STATE: namespace,
        AUTH_INTENT_RATE_LIMIT: { getByName: () => ({ allow: async () => true }) },
        PUBLIC_APP_ORIGIN: 'https://app.gridora.example',
        CONSOLE_ORIGIN: 'https://console.gridora.example',
      } as unknown as ApiBindings,
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.gridora.example')
    const body = await response.json<{ state: string; expiresAt: number }>()
    expect(body.state).toMatch(/^state_/)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    await expect(
      consumeAuthenticationIntentState(
        { AUTH_INTENT_STATE: namespace } as unknown as Pick<ApiBindings, 'AUTH_INTENT_STATE'>,
        body.state,
        undefined,
        'subject_other_browser',
      ),
    ).resolves.toBeNull()
    const firstPartyCookie = cookie.split(';')[0]
    await expect(
      consumeAuthenticationIntentState(
        { AUTH_INTENT_STATE: namespace } as unknown as Pick<ApiBindings, 'AUTH_INTENT_STATE'>,
        body.state,
        firstPartyCookie,
        'subject_1',
      ),
    ).resolves.toMatchObject({ intent: 'sign-up', displayName: 'Gridora Owner' })
    await expect(
      consumeAuthenticationIntentState(
        { AUTH_INTENT_STATE: namespace } as unknown as Pick<ApiBindings, 'AUTH_INTENT_STATE'>,
        body.state,
        firstPartyCookie,
        'subject_1',
      ),
    ).resolves.toBeNull()
  })

  it('rate-limits public auth-state allocation before creating a state Durable Object', async () => {
    let allocated = false
    const response = await app.request(
      'http://api.gridora.test/v1/auth/intents',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
        body: JSON.stringify({ intent: 'sign-in', returnTo: '/dashboard' }),
      },
      {
        AUTH_INTENT_RATE_LIMIT: { getByName: () => ({ allow: async () => false }) },
        AUTH_INTENT_STATE: {
          getByName: () => {
            allocated = true
            return {}
          },
        },
      } as unknown as ApiBindings,
    )
    expect(response.status).toBe(429)
    expect(allocated).toBe(false)
  })
})

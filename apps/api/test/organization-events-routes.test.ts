import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { AccessAuthenticationError } from '@gridora/auth-cloudflare-access'
import { AuthorizationError } from '@gridora/contracts'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { signRealtimeTicket, verifyRealtimeTicket } from '@gridora/realtime/ticket'
import type { OrganizationEventsDO } from '@gridora/realtime'
import {
  OrganizationRealtimePrincipal,
  registerOrganizationEventsRoutes,
  type OrganizationEventsNamespace,
  type OrganizationEventsStub,
} from '../src/organization-events-routes.js'

vi.mock('@gridora/realtime/ticket', async () => import('../../../workers/realtime/src/ticket.js'))

const realtimeSecret = 'realtime-test-secret-with-at-least-thirty-two-bytes'
const accessCanary = 'access-jwt-secret-canary'
const cookieCanary = 'session-cookie-secret-canary'

type TestBindings = {
  readonly REALTIME_TICKET_SECRET: string
  readonly ORGANIZATION_EVENTS: FakeOrganizationEventsNamespace
}
type TestEnv = { Bindings: TestBindings }

interface MembershipFixture {
  readonly organizationId: string
  readonly organizationSlug: string
  readonly identityId: string
  readonly revision: number
}

class FakeOrganizationEventsStub implements OrganizationEventsStub {
  readonly initialized: string[] = []
  readonly requests: Request[] = []
  readonly claimedNonces = new Set<string>()

  constructor(readonly secret: string) {}

  async initialize(organizationId: string): Promise<void> {
    this.initialized.push(organizationId)
  }

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request)
    const organizationId = this.initialized.at(-1)
    const ticket = new URL(request.url).searchParams.get('ticket')
    if (organizationId === undefined || ticket === null)
      return new Response('{"code":"REALTIME_ACCESS_DENIED"}', {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      })
    const result = await Effect.runPromise(
      Effect.result(
        verifyRealtimeTicket(ticket, this.secret, {
          organizationId,
          resourceType: 'organization',
          resourceId: organizationId,
        }),
      ),
    )
    if (result._tag === 'Failure' || this.claimedNonces.has(result.success.nonce))
      return new Response('{"code":"REALTIME_ACCESS_DENIED"}', {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      })
    this.claimedNonces.add(result.success.nonce)
    return new Response('{"connected":true}', {
      status: 200,
      headers: { 'x-test-websocket-proxy': 'accepted' },
    })
  }
}

class FakeOrganizationEventsNamespace implements OrganizationEventsNamespace {
  readonly names: string[] = []
  readonly stubs = new Map<string, FakeOrganizationEventsStub>()

  constructor(readonly secret: string) {}

  getByName(name: string): FakeOrganizationEventsStub {
    this.names.push(name)
    const existing = this.stubs.get(name)
    if (existing !== undefined) return existing
    const created = new FakeOrganizationEventsStub(this.secret)
    this.stubs.set(name, created)
    return created
  }
}

const runtime = makeWorkerEffectRuntime(Layer.empty)
let app: Hono<TestEnv>
let events: FakeOrganizationEventsNamespace
let now: number
let nonceSequence: number
let authorizationCalls: ReadonlyArray<{ readonly access: string; readonly organization: string }>
let memberships: ReadonlyArray<MembershipFixture>

const nextNonce = () => {
  nonceSequence += 1
  return `00000000-0000-4000-8000-${nonceSequence.toString(16).padStart(12, '0')}`
}

const authorize = (context: HonoContext<TestEnv>, minimumRole: 'viewer') =>
  Effect.gen(function* () {
    const access = context.req.header('x-test-access')
    if (access === undefined)
      return yield* new AccessAuthenticationError({
        reason: 'missing-assertion',
        message: 'Cloudflare Access assertion is required',
      })
    const organization = context.req.param('organization') ?? ''
    authorizationCalls = [...authorizationCalls, { access, organization }]
    if (minimumRole !== 'viewer')
      return yield* new AuthorizationError({
        code: 'role_required',
        message: 'Viewer role is required',
      })
    const membership = memberships.find(
      (candidate) =>
        candidate.identityId === access &&
        (candidate.organizationId === organization || candidate.organizationSlug === organization),
    )
    if (membership === undefined)
      return yield* new AuthorizationError({
        code: 'membership_required',
        message: 'Organization membership is required',
      })
    return yield* Schema.decodeUnknownEffect(OrganizationRealtimePrincipal)({
      organizationId: membership.organizationId,
      identityId: membership.identityId,
      membershipRevision: membership.revision,
    })
  })

const ticketUrl = (organization = 'organization-a') =>
  `https://api.gridora.test/v1/organizations/${organization}/events/ticket`
const eventsUrl = (ticket: string, organization = 'organization-a') =>
  `https://api.gridora.test/v1/organizations/${organization}/events?ticket=${encodeURIComponent(ticket)}`

const issue = (identityId = 'identity-a', organization = 'organization-a') =>
  app.request(
    ticketUrl(organization),
    { method: 'POST', headers: { 'x-test-access': identityId } },
    { REALTIME_TICKET_SECRET: realtimeSecret, ORGANIZATION_EVENTS: events },
  )

const connect = (
  ticket: string,
  identityId = 'identity-a',
  organization = 'organization-a',
  url = eventsUrl(ticket, organization),
) =>
  app.request(
    url,
    {
      headers: {
        upgrade: 'websocket',
        'x-test-access': identityId,
        'cf-access-jwt-assertion': accessCanary,
        cookie: `session=${cookieCanary}`,
      },
    },
    { REALTIME_TICKET_SECRET: realtimeSecret, ORGANIZATION_EVENTS: events },
  )

describe('organization realtime event routes', () => {
  it('accepts the real typed OrganizationEvents Durable Object namespace without an adapter cast', () => {
    expectTypeOf<
      DurableObjectNamespace<OrganizationEventsDO>
    >().toExtend<OrganizationEventsNamespace>()
  })

  beforeEach(() => {
    now = Date.now()
    nonceSequence = 0
    authorizationCalls = []
    memberships = [
      {
        organizationId: 'org-a',
        organizationSlug: 'organization-a',
        identityId: 'identity-a',
        revision: 7,
      },
      {
        organizationId: 'org-a',
        organizationSlug: 'organization-a',
        identityId: 'identity-a-second',
        revision: 4,
      },
      {
        organizationId: 'org-b',
        organizationSlug: 'organization-b',
        identityId: 'identity-b',
        revision: 3,
      },
    ]
    events = new FakeOrganizationEventsNamespace(realtimeSecret)
    app = new Hono<TestEnv>()
    registerOrganizationEventsRoutes(app, {
      runtimeFor: () => runtime,
      authorize,
      ticketSecret: (bindings) => bindings.REALTIME_TICKET_SECRET,
      organizationEvents: (bindings) => bindings.ORGANIZATION_EVENTS,
      now: () => now,
      nonce: nextNonce,
    })
  })

  afterAll(() => runtime.dispose())

  it('issues unique no-store tickets bound to the actor, membership revision, and organization', async () => {
    const first = await issue()
    expect(first.status, await first.clone().text()).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store, private')
    expect(first.headers.get('pragma')).toBe('no-cache')
    const firstBody = (await first.json()) as {
      readonly ticket: string
      readonly expiresAt: number
    }
    expect(firstBody.expiresAt).toBe(now + 60_000)
    expect(firstBody.ticket).not.toContain(realtimeSecret)
    await expect(
      Effect.runPromise(
        verifyRealtimeTicket(firstBody.ticket, realtimeSecret, {
          organizationId: 'org-a',
          resourceType: 'organization',
          resourceId: 'org-a',
        }),
      ),
    ).resolves.toEqual({
      organizationId: 'org-a',
      principalId: 'identity-a',
      audience: 'console',
      resourceType: 'organization',
      resourceId: 'org-a',
      machineId: null,
      sessionVersion: 7,
      expiresAt: now + 60_000,
      nonce: '00000000-0000-4000-8000-000000000001',
    })

    const second = await issue()
    const secondBody = (await second.json()) as { readonly ticket: string }
    expect(secondBody.ticket).not.toBe(firstBody.ticket)
    expect(authorizationCalls).toHaveLength(2)
  })

  it('requires Access and an active membership in the route organization', async () => {
    const missingAccess = await app.request(
      ticketUrl(),
      { method: 'POST' },
      { REALTIME_TICKET_SECRET: realtimeSecret, ORGANIZATION_EVENTS: events },
    )
    expect(missingAccess.status).toBe(401)
    expect((await issue('identity-b')).status).toBe(403)
    expect(events.names).toEqual([])
  })

  it('reauthorizes and proxies only a sanitized upgrade to the exact tenant coordinator', async () => {
    const issued = await issue()
    const { ticket } = (await issued.json()) as { readonly ticket: string }
    const response = await connect(ticket)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('x-test-websocket-proxy')).toBe('accepted')
    expect(authorizationCalls).toHaveLength(2)
    expect(events.names).toEqual(['org-a:events'])
    const stub = events.stubs.get('org-a:events')
    expect(stub?.initialized).toEqual(['org-a'])
    expect(stub?.requests).toHaveLength(1)
    const forwarded = stub?.requests[0]
    expect(forwarded?.method).toBe('GET')
    expect(forwarded?.headers.get('upgrade')).toBe('websocket')
    expect(forwarded?.headers.get('cf-access-jwt-assertion')).toBeNull()
    expect(forwarded?.headers.get('cookie')).toBeNull()
    expect(forwarded?.headers.get('x-test-access')).toBeNull()
    const forwardedUrl = new URL(forwarded?.url ?? 'https://invalid.test')
    expect(forwardedUrl.origin).toBe('https://organization-events.internal')
    expect(Array.from(forwardedUrl.searchParams.keys())).toEqual(['ticket'])
    expect(forwardedUrl.searchParams.get('ticket')).toBe(ticket)
  })

  it('rejects foreign organization, actor, membership revision, and expired tickets before the DO', async () => {
    const issued = await issue()
    const { ticket } = (await issued.json()) as { readonly ticket: string }

    expect((await connect(ticket, 'identity-b', 'organization-b')).status).toBe(403)
    expect((await connect(ticket, 'identity-a-second')).status).toBe(403)

    memberships = memberships.map((membership) =>
      membership.identityId === 'identity-a' ? { ...membership, revision: 8 } : membership,
    )
    expect((await connect(ticket)).status).toBe(403)

    const expired = await Effect.runPromise(
      signRealtimeTicket(
        {
          organizationId: 'org-a',
          principalId: 'identity-a',
          audience: 'console',
          resourceType: 'organization',
          resourceId: 'org-a',
          machineId: null,
          sessionVersion: 8,
          expiresAt: Date.now() - 1,
          nonce: '00000000-0000-4000-8000-000000000099',
        },
        realtimeSecret,
      ),
    )
    expect((await connect(expired)).status).toBe(403)
    expect(events.names).toEqual([])
  })

  it('rejects non-upgrades and ambiguous query input without invoking a coordinator', async () => {
    const issued = await issue()
    const { ticket } = (await issued.json()) as { readonly ticket: string }
    const noUpgrade = await app.request(
      eventsUrl(ticket),
      { headers: { 'x-test-access': 'identity-a' } },
      { REALTIME_TICKET_SECRET: realtimeSecret, ORGANIZATION_EVENTS: events },
    )
    expect(noUpgrade.status).toBe(426)
    await expect(noUpgrade.json()).resolves.toMatchObject({ code: 'WEBSOCKET_REQUIRED' })

    const ambiguous = await connect(
      ticket,
      'identity-a',
      'organization-a',
      `${eventsUrl(ticket)}&ticket=${encodeURIComponent(ticket)}&debug=${accessCanary}`,
    )
    expect(ambiguous.status).toBe(403)
    expect(events.names).toEqual([])
  })

  it('lets the coordinator consume the nonce once and preserves its replay rejection', async () => {
    const issued = await issue()
    const { ticket } = (await issued.json()) as { readonly ticket: string }
    expect((await connect(ticket)).status).toBe(200)
    const replay = await connect(ticket)
    expect(replay.status).toBe(403)
    await expect(replay.json()).resolves.toMatchObject({ code: 'REALTIME_ACCESS_DENIED' })
    expect(events.names).toEqual(['org-a:events', 'org-a:events'])
    expect(events.stubs.get('org-a:events')?.requests).toHaveLength(2)
  })

  it('keeps signing, Access, cookie, and ticket canaries out of error responses and DO headers', async () => {
    const invalidSecretCanary = 'short-signing-secret-canary'
    const response = await app.request(
      ticketUrl(),
      { method: 'POST', headers: { 'x-test-access': 'identity-a' } },
      { REALTIME_TICKET_SECRET: invalidSecretCanary, ORGANIZATION_EVENTS: events },
    )
    expect(response.status).toBe(503)
    const failureBody = await response.text()
    expect(failureBody).not.toContain(realtimeSecret)
    expect(failureBody).not.toContain(invalidSecretCanary)
    expect(failureBody).not.toContain(accessCanary)
    expect(failureBody).not.toContain(cookieCanary)

    const issued = await issue()
    const { ticket } = (await issued.json()) as { readonly ticket: string }
    const [payload, signature = ''] = ticket.split('.')
    const rejected = await connect(
      `${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`,
    )
    const rejectedBody = await rejected.text()
    expect(rejectedBody).not.toContain(realtimeSecret)
    expect(rejectedBody).not.toContain(accessCanary)
    expect(rejectedBody).not.toContain(cookieCanary)
    expect(rejectedBody).not.toContain(ticket)
    expect(events.names).toEqual([])
  })
})

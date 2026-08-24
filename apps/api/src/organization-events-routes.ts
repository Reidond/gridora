import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { AuthorizationError, PersistenceError } from '@gridora/contracts'
import { IdentityId, OrganizationId } from '@gridora/domain'
import {
  effectHandler,
  jsonResponse,
  problemResponse,
  requestIdFromContext,
  type HttpFailure,
  type WorkerEffectRuntime,
} from '@gridora/http-hono-effect'
import { signRealtimeTicket, verifyRealtimeTicket } from '@gridora/realtime/ticket'

const ticketLifetimeMilliseconds = 60_000

const MembershipRevision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const EpochMilliseconds = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - ticketLifetimeMilliseconds),
)
const RealtimeSecret = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(4096))
const RealtimeNonce = Schema.String.check(
  Schema.isMinLength(36),
  Schema.isMaxLength(36),
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
)
const RealtimeTicket = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
)

export const OrganizationRealtimePrincipal = Schema.Struct({
  organizationId: OrganizationId,
  identityId: IdentityId,
  membershipRevision: MembershipRevision,
})
export type OrganizationRealtimePrincipal = typeof OrganizationRealtimePrincipal.Type

export interface OrganizationEventsStub {
  readonly initialize: (organizationId: string) => Promise<void>
  readonly fetch: (request: Request) => Promise<Response>
}

export interface OrganizationEventsNamespace {
  readonly getByName: (name: string) => OrganizationEventsStub
}

export interface OrganizationEventsRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /**
   * Must authenticate Cloudflare Access, resolve the route organization, and read the current
   * active Viewer-or-higher membership and its revision on every call.
   */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'viewer',
  ) => Effect.Effect<OrganizationRealtimePrincipal, unknown, R>
  readonly ticketSecret: (bindings: E['Bindings']) => string
  readonly organizationEvents: (bindings: E['Bindings']) => OrganizationEventsNamespace
  /** Test seam. Production composition must leave this unset. */
  readonly now?: () => number
  /** Test seam. Production composition must leave this unset. */
  readonly nonce?: () => string
}

export const organizationRealtimeTicketPath = '/v1/organizations/:organization/events/ticket'
export const organizationRealtimeEventsPath = '/v1/organizations/:organization/events'

const unavailable = (operation: string) =>
  new PersistenceError({
    operation,
    message: 'Organization realtime authorization is unavailable',
  })

const denied = () =>
  new AuthorizationError({
    code: 'membership_required',
    message: 'Active organization membership is required',
  })

const decodePrincipal = (value: unknown) =>
  Schema.decodeUnknownEffect(OrganizationRealtimePrincipal, { onExcessProperty: 'error' })(
    value,
  ).pipe(Effect.mapError(() => denied()))

const decodeSecret = (value: unknown) =>
  Schema.decodeUnknownEffect(RealtimeSecret)(value).pipe(
    Effect.mapError(() => unavailable('organizationRealtime.ticketSecret')),
  )

const issueTime = (clock: () => number) =>
  Effect.try({
    try: clock,
    catch: () => unavailable('organizationRealtime.clock'),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EpochMilliseconds)),
    Effect.mapError(() => unavailable('organizationRealtime.clock')),
  )

const issueNonce = (randomNonce: () => string) =>
  Effect.try({
    try: randomNonce,
    catch: () => unavailable('organizationRealtime.nonce'),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RealtimeNonce)),
    Effect.mapError(() => unavailable('organizationRealtime.nonce')),
  )

const decodeTicket = <E extends HonoEnv>(context: HonoContext<E>) => {
  const search = new URL(context.req.url).searchParams
  const tickets = search.getAll('ticket')
  if (tickets.length !== 1 || Array.from(search.keys()).some((key) => key !== 'ticket'))
    return Effect.fail(denied())
  return Schema.decodeUnknownEffect(RealtimeTicket)(tickets[0]).pipe(
    Effect.mapError(() => denied()),
  )
}

const isHttpFailure = (value: Response | HttpFailure): value is HttpFailure =>
  value !== null && typeof value === 'object' && 'problem' in value

const websocketRequired = (requestId: string): Response =>
  problemResponse({
    status: 426,
    problem: {
      type: 'https://errors.gridora.example/websocket-required',
      title: 'WebSocket upgrade required',
      status: 426,
      code: 'WEBSOCKET_REQUIRED',
      detail: 'This endpoint accepts only a WebSocket upgrade',
      requestId,
      retryable: false,
      fields: [],
    },
  })

const internalUpgradeRequest = (ticket: string): Request => {
  const url = new URL('https://organization-events.internal/connect')
  url.searchParams.set('ticket', ticket)
  return new Request(url, {
    method: 'GET',
    headers: { upgrade: 'websocket' },
  })
}

/** Register after shared Access authentication, request-size, CORS, and CSRF middleware. */
export const registerOrganizationEventsRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: OrganizationEventsRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.post(
    organizationRealtimeTicketPath,
    handler((context) =>
      Effect.gen(function* () {
        const principal = yield* dependencies
          .authorize(context, 'viewer')
          .pipe(Effect.flatMap(decodePrincipal))
        const secret = yield* decodeSecret(dependencies.ticketSecret(context.env))
        const now = yield* issueTime(dependencies.now ?? (() => Date.now()))
        const nonce = yield* issueNonce(dependencies.nonce ?? (() => crypto.randomUUID()))
        const expiresAt = now + ticketLifetimeMilliseconds
        const ticket = yield* signRealtimeTicket(
          {
            organizationId: principal.organizationId,
            principalId: principal.identityId,
            audience: 'console',
            resourceType: 'organization',
            resourceId: principal.organizationId,
            machineId: null,
            sessionVersion: principal.membershipRevision,
            expiresAt,
            nonce,
          },
          secret,
        ).pipe(Effect.mapError(() => unavailable('organizationRealtime.signTicket')))
        return jsonResponse({ ticket, expiresAt }, 200, {
          'cache-control': 'no-store, private',
          pragma: 'no-cache',
          'referrer-policy': 'no-referrer',
        })
      }),
    ),
  )

  app.get(organizationRealtimeEventsPath, async (context) => {
    const requestId = requestIdFromContext(context)
    const runtime = dependencies.runtimeFor(context.env)
    const result = await runtime.run(
      Effect.gen(function* () {
        const principal = yield* dependencies
          .authorize(context, 'viewer')
          .pipe(Effect.flatMap(decodePrincipal))
        if (context.req.header('upgrade')?.toLowerCase() !== 'websocket')
          return websocketRequired(requestId)

        const ticket = yield* decodeTicket(context)
        const secret = yield* decodeSecret(dependencies.ticketSecret(context.env))
        const now = yield* issueTime(dependencies.now ?? (() => Date.now()))
        const claims = yield* verifyRealtimeTicket(ticket, secret, {
          organizationId: principal.organizationId,
          resourceType: 'organization',
          resourceId: principal.organizationId,
        }).pipe(Effect.mapError(() => denied()))
        if (
          claims.audience !== 'console' ||
          claims.principalId !== principal.identityId ||
          claims.sessionVersion !== principal.membershipRevision ||
          claims.machineId !== null ||
          Schema.is(RealtimeNonce)(claims.nonce) === false ||
          claims.expiresAt > now + ticketLifetimeMilliseconds
        )
          return yield* denied()

        const stub = yield* Effect.try({
          try: () =>
            dependencies
              .organizationEvents(context.env)
              .getByName(`${principal.organizationId}:events`),
          catch: () => unavailable('organizationRealtime.resolveCoordinator'),
        })
        yield* Effect.tryPromise({
          try: () => stub.initialize(principal.organizationId),
          catch: () => unavailable('organizationRealtime.initializeCoordinator'),
        })
        return yield* Effect.tryPromise({
          try: () => stub.fetch(internalUpgradeRequest(ticket)),
          catch: () => unavailable('organizationRealtime.proxyUpgrade'),
        })
      }),
      requestId,
    )
    return isHttpFailure(result) ? problemResponse(result) : result
  })

  return app
}

import { Effect } from 'effect'
import {
  LOG_LIMITS,
  LogPersistenceError,
  type LiveLogTicketClaims,
  type LiveLogTicketIssuer,
  type LiveLogTicketVerification,
} from '@gridora/log-control'
import {
  signRealtimeTicket,
  verifyRealtimeTicket,
  type RealtimeTicketClaims,
} from '@gridora/realtime/ticket'
import type { LiveLogTicketClaim } from '@gridora/realtime'

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ticketPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export interface LiveLogStreamStub {
  readonly initialize: (
    organizationId: string,
    serverId: string,
    streamEpoch: string,
    principalId: string,
    membershipRevision: number,
    membershipAuthorizationGeneration: number,
    organizationAuthorizationGeneration: number,
  ) => Promise<boolean>
  readonly claimTicket: (input: LiveLogTicketClaim) => Promise<boolean>
  readonly fetch: (request: Request) => Promise<Response>
}

export interface LiveLogStreamNamespace {
  readonly getByName: (name: string) => LiveLogStreamStub
}

export interface LogMonitoringRealtimeOptions {
  readonly secret: string
  readonly liveLogStream: LiveLogStreamNamespace
  readonly now?: () => number
  readonly nonce?: () => string
}

export interface LogMonitoringRealtimeComposition {
  readonly ticketIssuer: LiveLogTicketIssuer
  readonly ticketVerifier: LiveLogTicketVerification
  readonly stream: {
    readonly open: (claims: LiveLogTicketClaims, ticket?: string) => Promise<Response>
  }
}

const failure = (operation: string, message: string): LogPersistenceError =>
  new LogPersistenceError({ operation, message })

/**
 * A stream epoch must select a different Durable Object after a deployment
 * move. Encode every component to avoid collisions between otherwise valid
 * identifier values containing `:`.
 */
const scopeName = (organizationId: string, serverId: string, streamEpoch: string): string => {
  if (
    !identifier.test(organizationId) ||
    !identifier.test(serverId) ||
    !identifier.test(streamEpoch)
  )
    throw new Error('live log scope is invalid')
  return `${encodeURIComponent(organizationId)}:logs:${encodeURIComponent(serverId)}:${encodeURIComponent(streamEpoch)}`
}

/** The signed resource claim is an unambiguous server/epoch tuple. */
const ticketResourceId = (serverId: string, streamEpoch: string): string =>
  JSON.stringify([serverId, streamEpoch])

const internalUpgradeRequest = (ticket: string): Request => {
  const url = new URL('https://live-log-stream.internal/connect')
  url.searchParams.set('ticket', ticket)
  return new Request(url, { method: 'GET', headers: { upgrade: 'websocket' } })
}

/**
 * Composes the existing signed realtime ticket authority with the dedicated
 * server log Durable Object.  The object performs the final one-time nonce
 * transition during upgrade; the pre-upgrade claim prevents an API retry from
 * racing a second client into the same ticket.
 */
export const makeLogMonitoringRealtime = (
  options: LogMonitoringRealtimeOptions,
): LogMonitoringRealtimeComposition => {
  if (options.secret.length < 32 || options.secret.length > 4096)
    throw new Error('realtime ticket secret is invalid')
  const nonce = options.nonce ?? (() => crypto.randomUUID())
  const stubFor = (
    organizationId: string,
    serverId: string,
    streamEpoch: string,
  ): LiveLogStreamStub =>
    options.liveLogStream.getByName(scopeName(organizationId, serverId, streamEpoch))

  const ticketIssuer: LiveLogTicketIssuer = {
    issue: (input) =>
      Effect.gen(function* () {
        if (
          !identifier.test(input.organizationId) ||
          !identifier.test(input.serverId) ||
          !identifier.test(input.streamEpoch) ||
          !identifier.test(input.principalId) ||
          !Number.isSafeInteger(input.membershipRevision) ||
          input.membershipRevision < 1 ||
          !Number.isSafeInteger(input.membershipAuthorizationGeneration) ||
          input.membershipAuthorizationGeneration < 1 ||
          !Number.isSafeInteger(input.organizationAuthorizationGeneration) ||
          input.organizationAuthorizationGeneration < 1 ||
          !Number.isSafeInteger(input.now) ||
          input.now < 0 ||
          input.now > Number.MAX_SAFE_INTEGER - LOG_LIMITS.liveTicketLifetimeMilliseconds
        )
          return yield* failure('liveLogs.issue', 'Live log ticket scope is invalid')
        const expiresAt = input.now + LOG_LIMITS.liveTicketLifetimeMilliseconds
        const value = yield* Effect.try({
          try: nonce,
          catch: () => failure('liveLogs.nonce', 'Live log ticket nonce is unavailable'),
        })
        if (typeof value !== 'string' || !noncePattern.test(value))
          return yield* failure('liveLogs.nonce', 'Live log ticket nonce is invalid')
        const stub = yield* Effect.try({
          try: () => stubFor(input.organizationId, input.serverId, input.streamEpoch),
          catch: () => failure('liveLogs.resolve', 'Live log stream is unavailable'),
        })
        const initialized = yield* Effect.tryPromise({
          try: () =>
            stub.initialize(
              input.organizationId,
              input.serverId,
              input.streamEpoch,
              input.principalId,
              input.membershipRevision,
              input.membershipAuthorizationGeneration,
              input.organizationAuthorizationGeneration,
            ),
          catch: () => failure('liveLogs.initialize', 'Live log stream is unavailable'),
        })
        if (!initialized)
          return yield* failure(
            'liveLogs.initialize',
            'Live log authorization changed before ticket issuance',
          )
        const claims: RealtimeTicketClaims = {
          organizationId: input.organizationId,
          principalId: input.principalId,
          audience: 'console',
          resourceType: 'resource',
          resourceId: ticketResourceId(input.serverId, input.streamEpoch),
          machineId: null,
          sessionVersion: input.membershipRevision,
          membershipAuthorizationGeneration: input.membershipAuthorizationGeneration,
          organizationAuthorizationGeneration: input.organizationAuthorizationGeneration,
          expiresAt,
          nonce: value,
        }
        const ticket = yield* signRealtimeTicket(claims, options.secret).pipe(
          Effect.mapError(() =>
            failure('liveLogs.signTicket', 'Live log ticket could not be issued'),
          ),
        )
        return {
          ticket,
          expiresAt,
          organizationId: input.organizationId,
          streamEpoch: input.streamEpoch,
        }
      }),
  }

  const ticketVerifier: LiveLogTicketVerification = {
    verify: (input) =>
      Effect.gen(function* () {
        if (
          !ticketPattern.test(input.ticket) ||
          !identifier.test(input.organizationId) ||
          !identifier.test(input.serverId) ||
          !identifier.test(input.streamEpoch) ||
          !Number.isSafeInteger(input.now)
        )
          return yield* failure('liveLogs.verifyTicket', 'Live log ticket is invalid')
        const claims = yield* verifyRealtimeTicket(input.ticket, options.secret, {
          organizationId: input.organizationId,
          resourceType: 'resource',
          resourceId: ticketResourceId(input.serverId, input.streamEpoch),
        }).pipe(
          Effect.mapError(() => failure('liveLogs.verifyTicket', 'Live log ticket is invalid')),
        )
        const membershipAuthorizationGeneration = claims.membershipAuthorizationGeneration
        const organizationAuthorizationGeneration = claims.organizationAuthorizationGeneration
        if (
          claims.audience !== 'console' ||
          claims.machineId !== null ||
          claims.resourceType !== 'resource' ||
          claims.resourceId !== ticketResourceId(input.serverId, input.streamEpoch) ||
          !identifier.test(claims.principalId) ||
          !Number.isSafeInteger(claims.sessionVersion) ||
          claims.sessionVersion < 1 ||
          typeof membershipAuthorizationGeneration !== 'number' ||
          !Number.isSafeInteger(membershipAuthorizationGeneration) ||
          membershipAuthorizationGeneration < 1 ||
          typeof organizationAuthorizationGeneration !== 'number' ||
          !Number.isSafeInteger(organizationAuthorizationGeneration) ||
          organizationAuthorizationGeneration < 1 ||
          !Number.isSafeInteger(claims.expiresAt) ||
          !noncePattern.test(claims.nonce) ||
          claims.expiresAt <= input.now ||
          claims.expiresAt > input.now + LOG_LIMITS.liveTicketLifetimeMilliseconds
        )
          return yield* failure('liveLogs.verifyTicket', 'Live log ticket is invalid')
        return {
          organizationId: claims.organizationId,
          serverId: input.serverId,
          streamEpoch: input.streamEpoch,
          principalId: claims.principalId,
          membershipRevision: claims.sessionVersion,
          membershipAuthorizationGeneration,
          organizationAuthorizationGeneration,
          nonce: claims.nonce,
          expiresAt: claims.expiresAt,
        }
      }),
    consume: (input) =>
      Effect.gen(function* () {
        if (
          input.organizationId !== input.claims.organizationId ||
          input.serverId !== input.claims.serverId ||
          input.streamEpoch !== input.claims.streamEpoch ||
          input.claims.expiresAt <= input.now
        )
          return yield* failure('liveLogs.consumeTicket', 'Live log ticket is invalid')
        const stub = yield* Effect.try({
          try: () => stubFor(input.organizationId, input.serverId, input.streamEpoch),
          catch: () => failure('liveLogs.resolve', 'Live log stream is unavailable'),
        })
        const claimed = yield* Effect.tryPromise({
          try: () => stub.claimTicket(input.claims),
          catch: () => failure('liveLogs.consumeTicket', 'Live log stream is unavailable'),
        })
        if (!claimed)
          return yield* failure('liveLogs.consumeTicket', 'Live log ticket has already been used')
      }),
  }

  return {
    ticketIssuer,
    ticketVerifier,
    stream: {
      open: async (claims, ticket) => {
        if (ticket === undefined || !ticketPattern.test(ticket))
          throw new Error('live log ticket is required for upgrade')
        return stubFor(claims.organizationId, claims.serverId, claims.streamEpoch).fetch(
          internalUpgradeRequest(ticket),
        )
      },
    },
  }
}

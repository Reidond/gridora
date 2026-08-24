import { Effect } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import type { OrganizationContext } from '@gridora/domain'
import { prepareAgentTelemetryPayload, type AgentTelemetryPayload } from '@gridora/agent-telemetry'
import { isAuditIpAddress, type AuditRequestContextValue } from '@gridora/audit-contracts'
import {
  decodeLogCursor,
  encodeLogCursor,
  LogNotFoundError,
  LogValidationError,
  publicLogArchive,
  validateLogArchivePageRequest,
} from '@gridora/log-control'
import type {
  LogArchivePageRequest,
  LogArchiveRepositoryShape,
  LiveLogTicketClaims,
  LiveLogTicketIssuer,
  LiveLogTicketVerification,
} from '@gridora/log-control'
import { readLogArchive, type LogR2BucketShape } from '@gridora/log-r2'
import {
  effectHandler,
  correlationIdFromContext,
  jsonResponse,
  problemResponse,
  requestIdFromContext,
  type HttpFailure,
  type WorkerEffectRuntime,
} from '@gridora/http-hono-effect'

export interface AgentLogPrincipal {
  readonly organizationId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly version: number
  readonly sessionVersion: number
}
export interface AgentTelemetrySource {
  /** Provenance comes from the Worker request, never from the agent body. */
  readonly request: AuditRequestContextValue
  /** Cancels the archive writer when the authenticated Worker request ends. */
  readonly requestSignal?: AbortSignal
}

export interface LiveLogStreamScope {
  readonly deploymentId: string
  readonly streamEpoch: string
  /** D1-issued organization authorization generation, never a route slug. */
  readonly organizationAuthorizationGeneration: number
}

/**
 * The membership revision is part of the authorization result, not a field on
 * the general organization route context.  Live tickets are rejected when the
 * membership changes between ticket issue and stream upgrade.
 */
export interface LogMonitoringPrincipal extends OrganizationContext {
  readonly membershipRevision: number
  /** Monotonic across membership deletion and later regrant. */
  readonly membershipAuthorizationGeneration: number
}
export interface AgentLogIngestor {
  readonly ingest: (
    principal: AgentLogPrincipal,
    input: AgentTelemetryPayload,
    source?: AgentTelemetrySource,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly nodeId: string
      readonly acceptedAt: string
      readonly replayed: boolean
    },
    unknown
  >
}
export interface LogMonitoringRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Access/membership authorization is performed by the composition root. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'viewer',
  ) => Effect.Effect<LogMonitoringPrincipal, unknown, R>
  readonly logs: (bindings: E['Bindings']) => LogArchiveRepositoryShape
  readonly logArchiveBucket: (bindings: E['Bindings']) => LogR2BucketShape
  readonly liveTicket: (bindings: E['Bindings']) => LiveLogTicketIssuer
  /** Resolve the exact current deployment before allocating an epoch-scoped stream. */
  readonly liveStreamScope: (
    bindings: E['Bindings'],
    organizationId: string,
    serverId: string,
  ) => Effect.Effect<LiveLogStreamScope | null, unknown, R>
  readonly cursorSecret: (bindings: E['Bindings']) => string
  readonly liveTicketVerifier?: (bindings: E['Bindings']) => LiveLogTicketVerification
  readonly logStream?: (bindings: E['Bindings']) => {
    readonly open: (claims: LiveLogTicketClaims, ticket?: string) => Promise<Response>
  }
  /** Machine auth must resolve one exact organization/node credential; no request bearer is forwarded. */
  readonly agentAuthorize: (context: HonoContext<E>) => Effect.Effect<AgentLogPrincipal, unknown, R>
  readonly agentIngest: (bindings: E['Bindings']) => AgentLogIngestor
  readonly now?: () => number
}

export const logsPath = '/v1/organizations/:organization/game-servers/:serverId/logs'
export const logArchivePath =
  '/v1/organizations/:organization/game-servers/:serverId/logs/:archiveId'
export const logStreamTicketPath =
  '/v1/organizations/:organization/game-servers/:serverId/logs/stream/ticket'
export const logStreamPath = '/v1/organizations/:organization/game-servers/:serverId/logs/stream'
export const agentTelemetryPath = '/v1/agent/telemetry'

const isHttpFailure = (value: Response | HttpFailure): value is HttpFailure =>
  value !== null && typeof value === 'object' && 'problem' in value

const identifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const routeOrganizationMatches = (actor: LogMonitoringPrincipal, value: string): boolean =>
  value === actor.organizationId || value === actor.organizationSlug
/** Reads a request body with a hard streaming cap, including chunked bodies without Content-Length. */
export const readBoundedJson = (
  request: Request,
  maximumBytes: number,
): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: async () => {
      const declared = request.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))
        throw new Error('request body exceeds the telemetry limit')
      const stream = request.body
      if (stream === null) return {}
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > maximumBytes) {
            await reader.cancel()
            throw new Error('request body exceeds the telemetry limit')
          }
          chunks.push(next.value)
        }
      } finally {
        reader.releaseLock()
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder().decode(body)) as unknown
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error('request body is invalid')),
  })

const requestJson = readBoundedJson

/**
 * `cf-connecting-ip` is trusted only when the Worker supplied a CF request
 * metadata object. Local/internal callers intentionally produce no IP audit
 * fact, even if they inject the header.
 */
export const cloudflareSourceIp = (context: HonoContext): string | undefined => {
  const request = context.req.raw as Request & { readonly cf?: unknown }
  const ip = context.req.header('cf-connecting-ip')
  return request.cf !== undefined && ip !== undefined && isAuditIpAddress(ip) ? ip : undefined
}

/**
 * Agent bearer traffic is still a real Worker request. Capture the trusted
 * edge IP when available and explicitly retain the absence of Access identity
 * rather than silently labelling the machine call as an HTTP human request.
 */
export const agentAuditRequestContextFor = (context: HonoContext): AuditRequestContextValue => {
  const sourceIp = cloudflareSourceIp(context)
  return {
    origin: 'machine',
    requestId: requestIdFromContext(context),
    correlationId: correlationIdFromContext(context),
    source: {
      ip:
        sourceIp === undefined
          ? { state: 'not-available', reason: 'cloudflare-source-ip-not-available' }
          : { state: 'captured', value: sourceIp },
      access: { state: 'not-available', reason: 'machine-bearer-credential' },
    },
  }
}

const parseArchiveRequest = (
  context: HonoContext,
  organizationId: string,
  now: number,
): Effect.Effect<LogArchivePageRequest, LogValidationError> => {
  const url = new URL(context.req.url)
  const serverId = context.req.param('serverId') ?? ''
  const allowed = new Set(['limit', 'from', 'to', 'cursor'])
  const keys = [...url.searchParams.keys()]
  if (
    keys.some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
  )
    return Effect.fail(
      new LogValidationError({
        code: 'invalid-scope',
        message: 'Log archive query contains unsupported or repeated fields',
      }),
    )
  const rawLimit = url.searchParams.getAll('limit')[0]
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  const from = url.searchParams.getAll('from')[0]
  const to = url.searchParams.getAll('to')[0]
  const cursor = url.searchParams.getAll('cursor')[0]
  return Effect.succeed({
    organizationId,
    serverId,
    limit,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(cursor === undefined ? {} : { cursor }),
  }).pipe(
    Effect.flatMap((request) => {
      if (!identifier(serverId))
        return Effect.fail(
          new LogValidationError({ code: 'invalid-scope', message: 'Server id is invalid' }),
        )
      return validateLogArchivePageRequest(request, now)
    }),
  )
}

/** Isolated route registration. Root composition supplies Access, machine auth, R2/D1, and the realtime DO. */
export const registerLogMonitoringRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: LogMonitoringRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)
  app.get(
    logsPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        if (!routeOrganizationMatches(actor, context.req.param('organization') ?? ''))
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'Organization scope is invalid',
          })
        const now = dependencies.now?.() ?? Date.now()
        const request = yield* parseArchiveRequest(context, actor.organizationId, now)
        const decodedCursor =
          request.cursor === undefined
            ? undefined
            : yield* decodeLogCursor(
                request.cursor,
                { organizationId: actor.organizationId, serverId: request.serverId },
                dependencies.cursorSecret(context.env),
                now,
              )
        const page = yield* dependencies.logs(context.env).list(request, decodedCursor)
        const nextCursor =
          page.nextCursor === undefined
            ? undefined
            : yield* encodeLogCursor(
                { organizationId: actor.organizationId, serverId: request.serverId },
                { lastTimestamp: page.nextCursor.lastTimestamp, id: page.nextCursor.lastId },
                dependencies.cursorSecret(context.env),
                now,
              )
        return jsonResponse({
          items: page.items.map(publicLogArchive),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        })
      }),
    ),
  )

  app.post(
    logStreamTicketPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const serverId = context.req.param('serverId') ?? ''
        if (
          !routeOrganizationMatches(actor, context.req.param('organization') ?? '') ||
          !identifier(serverId)
        )
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'Log stream scope is invalid',
          })
        if ([...new URL(context.req.url).searchParams.keys()].length > 0)
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'Log stream ticket query is invalid',
          })
        const scope = yield* dependencies.liveStreamScope(
          context.env,
          actor.organizationId,
          serverId,
        )
        if (scope === null)
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'Log stream server is unavailable',
          })
        const ticket = yield* dependencies.liveTicket(context.env).issue({
          organizationId: actor.organizationId,
          serverId,
          streamEpoch: scope.streamEpoch,
          principalId: actor.identityId,
          membershipRevision: actor.membershipRevision,
          membershipAuthorizationGeneration: actor.membershipAuthorizationGeneration,
          organizationAuthorizationGeneration: scope.organizationAuthorizationGeneration,
          now: dependencies.now?.() ?? Date.now(),
        })
        return jsonResponse(ticket, 200, {
          'cache-control': 'no-store, private',
          pragma: 'no-cache',
          'referrer-policy': 'no-referrer',
        })
      }),
    ),
  )

  if (dependencies.liveTicketVerifier !== undefined && dependencies.logStream !== undefined) {
    app.get(logStreamPath, async (context) => {
      const runtime = dependencies.runtimeFor(context.env)
      const result = await runtime.run(
        Effect.gen(function* () {
          const actor = yield* dependencies.authorize(context, 'viewer')
          if (context.req.header('upgrade')?.toLowerCase() !== 'websocket')
            return new Response('WebSocket upgrade required', { status: 426 })
          const serverId = context.req.param('serverId') ?? ''
          if (!routeOrganizationMatches(actor, context.req.param('organization') ?? ''))
            return new Response('Live log authorization denied', { status: 403 })
          const url = new URL(context.req.url)
          const tickets = url.searchParams.getAll('ticket')
          if (
            !identifier(serverId) ||
            tickets.length !== 1 ||
            Array.from(url.searchParams.keys()).some((key) => key !== 'ticket')
          )
            return new Response('Live log authorization denied', { status: 403 })
          const scope = yield* dependencies.liveStreamScope(
            context.env,
            actor.organizationId,
            serverId,
          )
          if (scope === null) return new Response('Live log authorization denied', { status: 403 })
          const claims = yield* dependencies.liveTicketVerifier!(context.env).verify({
            ticket: tickets[0]!,
            organizationId: actor.organizationId,
            serverId,
            streamEpoch: scope.streamEpoch,
            now: dependencies.now?.() ?? Date.now(),
          })
          if (
            claims.principalId !== actor.identityId ||
            claims.membershipRevision !== actor.membershipRevision ||
            claims.membershipAuthorizationGeneration !== actor.membershipAuthorizationGeneration ||
            claims.organizationAuthorizationGeneration !==
              scope.organizationAuthorizationGeneration ||
            claims.streamEpoch !== scope.streamEpoch ||
            claims.expiresAt <= (dependencies.now?.() ?? Date.now())
          )
            return new Response('Live log authorization denied', { status: 403 })
          yield* dependencies.liveTicketVerifier!(context.env).consume({
            claims,
            organizationId: actor.organizationId,
            serverId,
            streamEpoch: scope.streamEpoch,
            now: dependencies.now?.() ?? Date.now(),
          })
          return yield* Effect.tryPromise({
            try: () => dependencies.logStream!(context.env).open(claims, tickets[0]),
            catch: () => new Error('Live log stream is unavailable'),
          }).pipe(
            Effect.catch(() =>
              Effect.succeed(new Response('Live log stream unavailable', { status: 503 })),
            ),
          )
        }),
        requestIdFromContext(context),
      )
      return isHttpFailure(result) ? problemResponse(result) : result
    })
  }

  // Register the archive wildcard after the fixed stream routes. Hono resolves
  // routes in registration order, and `stream` must never be treated as an archive id.
  app.get(
    logArchivePath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const serverId = context.req.param('serverId') ?? ''
        const archiveId = context.req.param('archiveId') ?? ''
        if (
          !routeOrganizationMatches(actor, context.req.param('organization') ?? '') ||
          !identifier(serverId) ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(archiveId)
        )
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'Log archive scope is invalid',
          })
        const metadata = yield* dependencies.logs(context.env).get(actor.organizationId, archiveId)
        if (metadata === null || metadata.serverId !== serverId || metadata.state !== 'available')
          return yield* new LogNotFoundError({ resource: 'log-archive', id: archiveId })
        const archive = yield* readLogArchive(
          dependencies.logArchiveBucket(context.env),
          metadata,
          actor.organizationId,
          serverId,
        )
        return jsonResponse({
          archive: publicLogArchive(archive.metadata),
          entries: archive.entries,
        })
      }),
    ),
  )

  app.post(
    agentTelemetryPath,
    handler((context) =>
      Effect.gen(function* () {
        const principal = yield* dependencies.agentAuthorize(context)
        const body = yield* requestJson(context.req.raw, 2 * 1024 * 1024).pipe(
          Effect.mapError(
            () =>
              new LogValidationError({
                code: 'invalid-entry',
                message: 'Telemetry request body is invalid or too large',
              }),
          ),
        )
        const payload = yield* prepareAgentTelemetryPayload(
          body,
          dependencies.now?.() ?? Date.now(),
        )
        const receipt = yield* dependencies.agentIngest(context.env).ingest(principal, payload, {
          request: agentAuditRequestContextFor(context),
          requestSignal: context.req.raw.signal,
        })
        return jsonResponse(receipt)
      }),
    ),
  )
  return app
}

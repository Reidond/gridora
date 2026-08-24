import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { NotFoundError } from '@gridora/contracts'
import type { OrganizationContext } from '@gridora/domain'
import {
  HEALTH_LIMITS,
  type HealthRepositoryShape,
  type HealthResourceType,
} from '@gridora/health-control'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

class HealthRequestValidationError extends Schema.TaggedError<HealthRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface HealthRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'viewer',
  ) => Effect.Effect<OrganizationContext, unknown, R>
  readonly health: (bindings: E['Bindings']) => HealthRepositoryShape
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

const invalid = (message: string) => new HealthRequestValidationError({ message })

const routeOrganizationMatches = (actor: OrganizationContext, value: string): boolean =>
  value === actor.organizationId || value === actor.organizationSlug

const exactSearchParameters = (url: URL, allowed: ReadonlySet<string>): boolean =>
  [...url.searchParams.keys()].every((key) => allowed.has(key))

const pageLimit = (url: URL): Effect.Effect<number, HealthRequestValidationError> => {
  const values = url.searchParams.getAll('limit')
  if (values.length > 1) return Effect.fail(invalid('Health page limit is invalid'))
  const raw = values[0] ?? '50'
  if (!/^\d+$/.test(raw)) return Effect.fail(invalid('Health page limit is invalid'))
  const limit = Number(raw)
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= HEALTH_LIMITS.maximumHistoryPageSize
    ? Effect.succeed(limit)
    : Effect.fail(invalid('Health page limit is invalid'))
}

const optionalTimestamp = (
  url: URL,
  key: 'from' | 'to' | 'before',
): Effect.Effect<string | undefined, HealthRequestValidationError> => {
  const values = url.searchParams.getAll(key)
  if (values.length === 0) return Effect.succeed(undefined)
  const value = values[0]!
  if (
    values.length !== 1 ||
    !timestamp.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return Effect.fail(invalid(`Health ${key} timestamp is invalid`))
  return Effect.succeed(value)
}

const resourceScope = <E extends HonoEnv>(
  context: HonoContext<E>,
  actor: OrganizationContext,
  resourceType: HealthResourceType,
): Effect.Effect<
  { readonly resourceType: HealthResourceType; readonly resourceId: string },
  HealthRequestValidationError
> => {
  const resourceId = context.req.param(resourceType === 'node' ? 'nodeId' : 'serverId') ?? ''
  if (
    !routeOrganizationMatches(actor, context.req.param('organization') ?? '') ||
    !identifier.test(resourceId)
  )
    return Effect.fail(invalid('Health resource scope is invalid'))
  return Effect.succeed({ resourceType, resourceId })
}

/** Register bounded, tenant-scoped current health, history, and alert reads. */
export const registerHealthRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: HealthRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  const registerResource = (
    resourceType: Extract<HealthResourceType, 'node' | 'server'>,
    segment: 'nodes' | 'game-servers',
    parameter: 'nodeId' | 'serverId',
  ): void => {
    const base = `/v1/organizations/:organization/${segment}/:${parameter}/health`
    app.get(
      base,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* dependencies.authorize(context, 'viewer')
          const scope = yield* resourceScope(context, actor, resourceType)
          if ([...new URL(context.req.url).searchParams.keys()].length > 0)
            return yield* invalid('Current health query does not accept fields')
          const snapshot = yield* dependencies.health(context.env).getCurrent({
            organizationId: actor.organizationId,
            ...scope,
          })
          if (snapshot === null)
            return yield* new NotFoundError({
              resource: `${resourceType}-health`,
              id: scope.resourceId,
            })
          return jsonResponse(snapshot)
        }),
      ),
    )

    app.get(
      `${base}/history`,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* dependencies.authorize(context, 'viewer')
          const scope = yield* resourceScope(context, actor, resourceType)
          const url = new URL(context.req.url)
          if (!exactSearchParameters(url, new Set(['from', 'to', 'before', 'limit'])))
            return yield* invalid('Health history query contains an unsupported field')
          const limit = yield* pageLimit(url)
          const from = yield* optionalTimestamp(url, 'from')
          const to = yield* optionalTimestamp(url, 'to')
          const before = yield* optionalTimestamp(url, 'before')
          if (
            from !== undefined &&
            to !== undefined &&
            (to < from ||
              Date.parse(to) - Date.parse(from) > HEALTH_LIMITS.maximumHistoryRangeMilliseconds)
          )
            return yield* invalid('Health history time range is invalid')
          const items = yield* dependencies.health(context.env).listHistory({
            organizationId: actor.organizationId,
            ...scope,
            limit,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(before === undefined ? {} : { before }),
          })
          return jsonResponse({
            items,
            ...(items.length === limit && items.at(-1) !== undefined
              ? { nextCursor: items.at(-1)!.sampledAt }
              : {}),
          })
        }),
      ),
    )
  }

  registerResource('node', 'nodes', 'nodeId')
  registerResource('server', 'game-servers', 'serverId')

  app.get(
    '/v1/organizations/:organization/health-alerts',
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        if (!routeOrganizationMatches(actor, context.req.param('organization') ?? ''))
          return yield* invalid('Health alert scope is invalid')
        const url = new URL(context.req.url)
        if (!exactSearchParameters(url, new Set(['resourceType', 'resourceId', 'limit'])))
          return yield* invalid('Health alert query contains an unsupported field')
        const limit = yield* pageLimit(url)
        const resourceTypes = url.searchParams.getAll('resourceType')
        const resourceIds = url.searchParams.getAll('resourceId')
        const resourceType = resourceTypes[0]
        const resourceId = resourceIds[0]
        if (
          resourceTypes.length > 1 ||
          resourceIds.length > 1 ||
          (resourceType !== undefined && !['node', 'server', 'container'].includes(resourceType)) ||
          (resourceId !== undefined && !identifier.test(resourceId)) ||
          (resourceId !== undefined && resourceType === undefined)
        )
          return yield* invalid('Health alert filter is invalid')
        const items = yield* dependencies.health(context.env).listAlerts({
          organizationId: actor.organizationId,
          limit,
          ...(resourceType === undefined
            ? {}
            : { resourceType: resourceType as HealthResourceType }),
          ...(resourceId === undefined ? {} : { resourceId }),
        })
        return jsonResponse({ items })
      }),
    ),
  )

  return app
}

import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
} from '@gridora/contracts'
import type { OrganizationContext } from '@gridora/domain'
import {
  DesiredStateCapabilityError,
  DesiredStateNotFoundError,
  DesiredStatePersistenceError,
  DesiredStatePluginUnavailableError,
  DesiredStateRevisionConflictError,
  DesiredStateValidationError,
  type DesiredStateControlError,
  type GameDesiredStateControlShape,
} from '@gridora/game-desired-state-control'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

const ServerId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

export class GameDesiredStateRequestValidationError extends Schema.TaggedError<GameDesiredStateRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export type GameDesiredStateRouteMinimumRole = 'viewer' | 'operator'
export interface GameDesiredStateRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Must resolve the route organization and enforce an active membership at this role. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: GameDesiredStateRouteMinimumRole,
  ) => Effect.Effect<OrganizationContext, unknown, R>
  readonly control: (
    bindings: E['Bindings'],
  ) => Effect.Effect<GameDesiredStateControlShape, never, R>
}

const invalid = (message: string) => new GameDesiredStateRequestValidationError({ message })
const decodeServerId = (value: string) =>
  Schema.decodeUnknownEffect(ServerId)(value).pipe(
    Effect.mapError(() => invalid('Server id does not match the API contract')),
  )
const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  })

const mapError = (error: DesiredStateControlError) => {
  if (error instanceof DesiredStateValidationError)
    return invalid('The request does not match the desired-state preview contract')
  if (error instanceof DesiredStateNotFoundError)
    return new NotFoundError({ resource: 'game-server', id: error.serverId })
  if (error instanceof DesiredStateRevisionConflictError)
    return new ConflictError({
      code: 'revision_conflict',
      message: `${error.resource} revision changed`,
    })
  if (error instanceof DesiredStateCapabilityError)
    return new ConflictError({
      code: 'capability_unavailable',
      message: `The authoritative ${error.pluginId} plugin does not support ${error.capability}`,
    })
  if (error instanceof DesiredStatePluginUnavailableError)
    return new ConflictError({
      code: 'plugin_unavailable',
      message: 'The authoritative game plugin version is not available in this build',
    })
  if (error instanceof DesiredStatePersistenceError)
    return new PersistenceError({
      operation: error.operation,
      message: 'Authoritative game desired state is unavailable',
    })
  return new PersistenceError({
    operation: 'game-desired-state.preview',
    message: 'Game desired-state preview is unavailable',
  })
}

const requireOperator = (actor: OrganizationContext) =>
  actor.role === 'operator' || actor.role === 'administrator' || actor.role === 'owner'
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'role_required',
          message: 'Operator role is required',
        }),
      )

const basePath = '/v1/organizations/:organization/game-servers/:serverId'

/**
 * Register after shared authentication, request-size, CORS, and CSRF middleware.
 * These routes only read D1 and calculate plans. Mutations are registered by
 * the game lifecycle adapter so their revisions and workflow evidence share
 * the same acceptance fence.
 */
export const registerGameDesiredStateRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: GameDesiredStateRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.get(
    `${basePath}/config`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const serverId = yield* decodeServerId(context.req.param('serverId') ?? '')
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .getConfig(actor.organizationId, serverId)
          .pipe(Effect.mapError(mapError))
        return jsonResponse(result)
      }),
    ),
  )

  app.get(
    `${basePath}/mods`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const serverId = yield* decodeServerId(context.req.param('serverId') ?? '')
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .getMods(actor.organizationId, serverId)
          .pipe(Effect.mapError(mapError))
        return jsonResponse(result)
      }),
    ),
  )

  app.post(
    `${basePath}/config/plan`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'operator')
        yield* requireOperator(actor)
        const serverId = yield* decodeServerId(context.req.param('serverId') ?? '')
        const body = yield* decodeBody(context.req.raw)
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .previewConfig(actor.organizationId, serverId, body)
          .pipe(Effect.mapError(mapError))
        return jsonResponse(result)
      }),
    ),
  )

  app.post(
    `${basePath}/mods/plan`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'operator')
        yield* requireOperator(actor)
        const serverId = yield* decodeServerId(context.req.param('serverId') ?? '')
        const body = yield* decodeBody(context.req.raw)
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .planMods(actor.organizationId, serverId, body)
          .pipe(Effect.mapError(mapError))
        return jsonResponse(result)
      }),
    ),
  )

  return app
}

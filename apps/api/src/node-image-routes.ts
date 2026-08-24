import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { AuthorizationError, ConflictError, PersistenceError } from '@gridora/contracts'
import { IdempotencyKey } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import type { PlatformActor } from '@gridora/platform-authority'
import {
  ConfigureImageScopeIntent,
  CreateNodeImageIntent,
  NodeImageConflictError,
  NodeImagePersistenceError,
  NodeImageValidationError,
  PromoteNodeImageIntent,
  RegisterProviderImageIntent,
  RevokeNodeImageIntent,
  RollbackNodeImageIntent,
  TestNodeImageIntent,
  type NodeImageControlError,
  type NodeImageControlShape,
} from '@gridora/node-image-control'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
export class NodeImageRequestValidationError extends Schema.TaggedError<NodeImageRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface NodeImageRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** This must verify the independent Platform Administrator grant, not an organization membership. */
  readonly authorizePlatformAdministrator: (
    context: HonoContext<E>,
  ) => Effect.Effect<PlatformActor, unknown, R>
  readonly control: (
    bindings: E['Bindings'],
    context: HonoContext<E>,
  ) => Effect.Effect<NodeImageControlShape, never, R>
}

const invalid = (message: string) => new NodeImageRequestValidationError({ message })
const identifier = (value: string | undefined) =>
  Schema.decodeUnknownEffect(Identifier)(value ?? '').pipe(
    Effect.mapError(() => invalid('Resource identifier does not match the platform API contract')),
  )
const idempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the platform API contract')),
      )
const decode = <A, I>(schema: Schema.Codec<A, I, never>, request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() => invalid('The request does not match the node image API contract')),
      ),
    ),
  )
const mapError = (error: NodeImageControlError) => {
  if (error instanceof NodeImageValidationError)
    return invalid('The request does not match the node image API contract')
  if (error instanceof NodeImageConflictError)
    return new ConflictError({
      code: error.code,
      message: 'The node image state or expected revision does not allow this action',
    })
  if (error instanceof NodeImagePersistenceError)
    return new PersistenceError({
      operation: 'node-image.lifecycle',
      message: 'The platform node image operation could not be recorded',
    })
  return new AuthorizationError({
    // The shared HTTP error contract deliberately has no platform-specific
    // authorization code. Do not widen it from this isolated route; the
    // route still fails closed after the independent platform grant check.
    code: 'role_required',
    message: 'Platform Administrator authority is required',
  })
}

/**
 * These routes intentionally do not accept an organization slug or membership.
 * The caller must hold the separately persisted Platform Administrator grant.
 */
export const registerNodeImageRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: NodeImageRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)
  const base = (context: HonoContext<E>) =>
    Effect.gen(function* () {
      const actor = yield* dependencies.authorizePlatformAdministrator(context)
      const key = yield* idempotencyKey(context.req.header('idempotency-key'))
      return { actor, idempotencyKey: key, correlationId: actor.correlationId }
    })

  app.post(
    '/v1/platform/node-images',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const intent = yield* decode(CreateNodeImageIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'create', intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  app.post(
    '/v1/platform/node-images/:imageId/actions/test',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const imageId = yield* identifier(context.req.param('imageId'))
        const intent = yield* decode(TestNodeImageIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'test', imageId, intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  app.post(
    '/v1/platform/node-image-scopes',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const intent = yield* decode(ConfigureImageScopeIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'configure-scope', intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  app.post(
    '/v1/platform/node-images/:imageId/registrations',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const imageId = yield* identifier(context.req.param('imageId'))
        const intent = yield* decode(RegisterProviderImageIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'register-provider', imageId, intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  app.post(
    '/v1/platform/node-images/:imageId/actions/promote',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const imageId = yield* identifier(context.req.param('imageId'))
        const intent = yield* decode(PromoteNodeImageIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'promote', imageId, intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  app.post(
    '/v1/platform/node-image-scopes/:scopeId/actions/rollback',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const scopeId = yield* identifier(context.req.param('scopeId'))
        const intent = yield* decode(RollbackNodeImageIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'rollback', scopeId, intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  app.post(
    '/v1/platform/node-images/:imageId/actions/revoke',
    handler((context) =>
      Effect.gen(function* () {
        const command = yield* base(context)
        const imageId = yield* identifier(context.req.param('imageId'))
        const intent = yield* decode(RevokeNodeImageIntent, context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control
            .submit({ ...command, kind: 'revoke', imageId, intent })
            .pipe(Effect.mapError(mapError)),
          202,
        )
      }),
    ),
  )
  return app
}

import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { AuthorizationError, ConflictError, PersistenceError } from '@gridora/contracts'
import { IdempotencyKey, type OrganizationContext } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  CreateNodeIntent,
  NodeProvisionAdmissionDeniedError,
  NodeProvisionAuthorizationError,
  NodeProvisionFactsUnavailableError,
  NodeProvisionIdempotencyConflictError,
  NodeProvisionPersistenceError,
  NodeProvisionValidationError,
  RegistrationTokenSecretError,
  type NodeProvisionControlError,
  type NodeProvisionControlShape,
} from '@gridora/node-provision-control'

export class NodeProvisionRequestValidationError extends Schema.TaggedError<NodeProvisionRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface NodeProvisionRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Resolves the route organization and enforces an active Administrator-or-higher membership. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'administrator',
  ) => Effect.Effect<OrganizationContext, unknown, R>
  readonly control: (
    bindings: E['Bindings'],
    context: HonoContext<E>,
  ) => Effect.Effect<NodeProvisionControlShape, never, R>
}

const invalid = (message: string) => new NodeProvisionRequestValidationError({ message })

const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CreateNodeIntent, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() => invalid('The request does not match the node create API contract')),
      ),
    ),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

const mapProvisionError = (error: NodeProvisionControlError) => {
  if (error instanceof NodeProvisionValidationError)
    return invalid('The request does not match the node create API contract')
  if (error instanceof NodeProvisionAuthorizationError)
    return new AuthorizationError({
      code: 'role_required',
      message: 'Administrator role is required',
    })
  if (error instanceof NodeProvisionIdempotencyConflictError)
    return new ConflictError({
      code: 'idempotency_conflict',
      message: 'The idempotency key was already used for a different request',
    })
  if (error instanceof NodeProvisionAdmissionDeniedError)
    return new ConflictError({
      code: 'node_provision_denied',
      message: 'The organization policy or current capacity does not allow this node',
    })
  if (
    error instanceof NodeProvisionFactsUnavailableError ||
    error instanceof NodeProvisionPersistenceError ||
    error instanceof RegistrationTokenSecretError
  )
    return new PersistenceError({
      operation: 'node.provision',
      message: 'Authoritative node provisioning state is unavailable',
    })
  return new PersistenceError({
    operation: 'node.provision',
    message: 'Node provisioning is unavailable',
  })
}

const nodePath = '/v1/organizations/:organization/nodes'

/**
 * Public create accepts intent only. Provider account, region, plan, image,
 * pricing, token records, and Workflow identity are all derived from durable
 * authoritative facts inside NodeProvisionControl.
 */
export const registerNodeProvisionRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: NodeProvisionRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.post(
    nodePath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        if (actor.role !== 'administrator' && actor.role !== 'owner')
          return yield* new AuthorizationError({
            code: 'role_required',
            message: 'Administrator role is required',
          })
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const intent = yield* decodeBody(context.req.raw)
        const control = yield* dependencies.control(context.env, context)
        const result = yield* control
          .submit({
            organizationId: actor.organizationId,
            actorId: actor.identityId,
            actorRole: actor.role,
            idempotencyKey,
            correlationId: actor.correlationId,
            intent,
          })
          .pipe(Effect.mapError(mapProvisionError))
        return jsonResponse(result, 202)
      }),
    ),
  )
  return app
}

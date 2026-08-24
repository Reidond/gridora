import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
} from '@gridora/contracts'
import { IdempotencyKey, type OrganizationContext } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  NodeRuntimeLifecycleAuthorizationError,
  NodeRuntimeLifecycleCapabilityError,
  NodeRuntimeLifecycleConflictError,
  NodeRuntimeLifecycleNotFoundError,
  NodeRuntimeLifecyclePersistenceError,
  NodeRuntimeLifecycleValidationError,
  type NodeRuntimeLifecycleAction,
  type NodeRuntimeLifecycleControlError,
  type NodeRuntimeLifecycleControlShape,
} from '@gridora/node-runtime-lifecycle-control'

const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const PublicNodeRuntimeActionBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedDesiredRevision: PositiveRevision,
})

export class NodeRuntimeLifecycleRequestValidationError extends Schema.TaggedError<NodeRuntimeLifecycleRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

type AuthorizedContext = OrganizationContext & { readonly membershipRevision?: number }

export interface NodeRuntimeLifecycleRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'operator',
  ) => Effect.Effect<AuthorizedContext, unknown, R>
  /** The control factory receives the edge context so its atomic audit uses the exact request provenance. */
  readonly control: (
    context: HonoContext<E>,
  ) => Effect.Effect<NodeRuntimeLifecycleControlShape, never, R>
}

const invalid = (message: string) => new NodeRuntimeLifecycleRequestValidationError({ message })

const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(PublicNodeRuntimeActionBody, { onExcessProperty: 'error' })(
        value,
      ).pipe(
        Effect.mapError(() =>
          invalid('The request does not match the node runtime action contract'),
        ),
      ),
    ),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

const errorFor = (error: NodeRuntimeLifecycleControlError) => {
  if (error instanceof NodeRuntimeLifecycleValidationError)
    return invalid('The request does not match the node runtime action contract')
  if (error instanceof NodeRuntimeLifecycleAuthorizationError)
    return new AuthorizationError({ code: 'role_required', message: 'Operator role is required' })
  if (error instanceof NodeRuntimeLifecycleNotFoundError)
    return new NotFoundError({ resource: 'node', id: 'redacted' })
  if (error instanceof NodeRuntimeLifecycleCapabilityError)
    return new ConflictError({
      code: 'node_runtime_action_unsupported',
      message: 'The provider does not support this node runtime action',
    })
  if (error instanceof NodeRuntimeLifecycleConflictError)
    return new ConflictError({
      code: `node_runtime_${error.code}`,
      message:
        error.code === 'idempotency_payload_mismatch'
          ? 'Idempotency-Key was already used with a different request'
          : 'The node state changed or is busy; refresh and retry',
    })
  if (error instanceof NodeRuntimeLifecyclePersistenceError)
    return new PersistenceError({
      operation: 'node.runtime.lifecycle',
      message: 'Authoritative node runtime lifecycle state is unavailable',
    })
  return new PersistenceError({
    operation: 'node.runtime.lifecycle',
    message: 'Node runtime lifecycle is unavailable',
  })
}

const actions: ReadonlyArray<NodeRuntimeLifecycleAction> = ['start', 'stop', 'reboot', 'reconcile']
const path = '/v1/organizations/:organization/nodes/:id/actions'

/**
 * The URL selects the action. The wire body deliberately cannot supply a
 * provider node identifier, desired state, or provider credential.
 */
export const registerNodeRuntimeLifecycleRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: NodeRuntimeLifecycleRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  for (const action of actions) {
    app.post(
      `${path}/${action}`,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* dependencies.authorize(context, 'operator')
          const body = yield* decodeBody(context.req.raw)
          const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
          const control = yield* dependencies.control(context)
          const result = yield* control
            .submit({
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              actorRole: actor.role,
              ...(actor.membershipRevision === undefined
                ? {}
                : { actorMembershipRevision: actor.membershipRevision }),
              nodeId: context.req.param('id') ?? '',
              idempotencyKey,
              correlationId: actor.correlationId,
              intent: { ...body, action },
            })
            .pipe(Effect.mapError(errorFor))
          return jsonResponse(result, 202)
        }),
      ),
    )
  }
  return app
}

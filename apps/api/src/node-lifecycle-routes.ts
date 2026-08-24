import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { AuthorizationError, ConflictError, PersistenceError } from '@gridora/contracts'
import { IdempotencyKey, type OrganizationContext } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  NodeRetirementBackupPolicy,
  TerminationAuthorizationError,
  TerminationConflictError,
  TerminationPersistenceError,
  TerminationValidationError,
  type NodeLifecycleAcceptance,
  type NodeLifecycleAction,
  type TerminationControlError,
  type TerminationControlShape,
} from '@gridora/lifecycle-termination-control'

const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

const PublicNodeLifecycleBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedNodeRevision: PositiveRevision,
  force: Schema.Boolean,
  backupPolicy: NodeRetirementBackupPolicy,
  targetImageId: Schema.optional(Identifier),
})
type PublicNodeLifecycleBody = typeof PublicNodeLifecycleBody.Type

export class NodeLifecycleRequestValidationError extends Schema.TaggedError<NodeLifecycleRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

type AuthorizedContext = OrganizationContext & { readonly membershipRevision?: number }

export interface NodeLifecycleRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'administrator',
  ) => Effect.Effect<AuthorizedContext, unknown, R>
  /** The control factory receives the edge context so its atomic audit uses the exact request provenance. */
  readonly control: (context: HonoContext<E>) => Effect.Effect<TerminationControlShape, never, R>
  /** Starts only the acceptance-bound native Workflow and records its exact start evidence. */
  readonly startWorkflow: (
    bindings: E['Bindings'],
    acceptance: NodeLifecycleAcceptance,
  ) => Effect.Effect<'started' | 'adopted', unknown, R>
}

const invalid = (message: string) => new NodeLifecycleRequestValidationError({ message })
const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(PublicNodeLifecycleBody, { onExcessProperty: 'error' })(
        value,
      ).pipe(
        Effect.mapError(() => invalid('The request does not match the node lifecycle contract')),
      ),
    ),
  )
const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

const errorFor = (error: TerminationControlError) => {
  if (error instanceof TerminationValidationError)
    return invalid('The request does not match the node lifecycle contract')
  if (error instanceof TerminationAuthorizationError)
    return new AuthorizationError({
      code: 'role_required',
      message: 'Administrator role is required',
    })
  if (error instanceof TerminationConflictError) {
    const code = error.code.includes('not_found')
      ? 'node_lifecycle_not_found'
      : `node_lifecycle_${error.code}`
    return new ConflictError({
      code,
      message:
        error.code === 'idempotency_key_reused'
          ? 'Idempotency-Key was already used with a different request'
          : 'The node lifecycle operation conflicts with current authoritative state',
    })
  }
  if (error instanceof TerminationPersistenceError)
    return new PersistenceError({
      operation: 'node.lifecycle',
      message: 'Authoritative node lifecycle state is unavailable',
    })
  return new PersistenceError({
    operation: 'node.lifecycle',
    message: 'Node lifecycle is unavailable',
  })
}

const actionFor = (
  routeAction: 'drain' | 'uncordon' | 'rebuild' | 'retire',
): NodeLifecycleAction => {
  switch (routeAction) {
    case 'drain':
      return 'drain-node'
    case 'uncordon':
      return 'leave-drain'
    case 'rebuild':
      return 'rebuild-node'
    case 'retire':
      return 'retire-node'
  }
}

const validateRouteBody = (
  routeAction: 'drain' | 'uncordon' | 'rebuild' | 'retire',
  body: PublicNodeLifecycleBody,
) => {
  if (routeAction === 'rebuild') {
    if (body.targetImageId === undefined)
      return Effect.fail(invalid('targetImageId is required for rebuild'))
    return Effect.succeed(body)
  }
  return body.targetImageId === undefined
    ? Effect.succeed(body)
    : Effect.fail(invalid('targetImageId is only allowed for rebuild'))
}

const base = '/v1/organizations/:organization/nodes/:id'

/**
 * `uncordon` is the public, operator-readable name for the internal
 * `leave-drain` action.  The routes never expose an internal workflow name,
 * resource-operation DO name, or provider identifier.
 */
export const registerNodeLifecycleRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: NodeLifecycleRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  const register = (
    method: 'post' | 'delete',
    routeAction: 'drain' | 'uncordon' | 'rebuild' | 'retire',
    path: string,
  ) => {
    app[method](
      path,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* dependencies.authorize(context, 'administrator')
          const body = yield* decodeBody(context.req.raw)
          const validBody = yield* validateRouteBody(routeAction, body)
          const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
          const control = yield* dependencies.control(context)
          const acceptance = yield* control
            .beginNodeLifecycle({
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              role: actor.role,
              correlationId: actor.correlationId,
              ...(actor.membershipRevision === undefined
                ? {}
                : { actorMembershipRevision: actor.membershipRevision }),
              idempotencyKey,
              action: actionFor(routeAction),
              nodeId: context.req.param('id') ?? '',
              expectedNodeRevision: validBody.expectedNodeRevision,
              force: validBody.force,
              backupPolicy: validBody.backupPolicy,
              ...(validBody.targetImageId === undefined
                ? {}
                : { targetImageId: validBody.targetImageId }),
            })
            .pipe(Effect.mapError(errorFor))
          const started = yield* Effect.result(dependencies.startWorkflow(context.env, acceptance))
          return jsonResponse(
            {
              disposition: acceptance.disposition,
              operationId: acceptance.operation.id,
              nodeId: acceptance.nodeId,
              state: acceptance.state,
              desiredNodeRevision: acceptance.desiredNodeRevision,
              workflowState: started._tag === 'Success' ? 'started' : 'pending-reconciliation',
            },
            202,
          )
        }),
      ),
    )
  }

  register('post', 'drain', `${base}/actions/drain`)
  register('post', 'uncordon', `${base}/actions/uncordon`)
  register('post', 'rebuild', `${base}/actions/rebuild`)
  register('delete', 'retire', base)
  return app
}

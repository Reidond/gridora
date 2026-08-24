import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { AuthorizationError, ConflictError, PersistenceError } from '@gridora/contracts'
import { IdempotencyKey } from '@gridora/domain'
import type { OrganizationContext } from '@gridora/domain'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  ServerCreateIntent,
  ServerApplyIntent,
  ServerPlanAuthorizationError,
  ServerPlanFactsUnavailableError,
  ServerPlanPersistenceError,
  ServerPlanValidationError,
  ServerPlacementRejectedError,
  ServerProvisionIdempotencyConflictError,
  ServerProvisionPersistenceError,
  ServerProvisionValidationError,
  CommercialReviewRequiredValidationCode,
  type ServerPlanControlShape,
  type ServerProvisionPlanControlShape,
  type ServerPlanError,
} from '@gridora/server-plan-control'

export class ServerPlanRequestValidationError extends Schema.TaggedError<ServerPlanRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

type AuthorizedContext = OrganizationContext & { readonly membershipRevision?: number }

export interface ServerPlanRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Must resolve the route organization and enforce an active Operator-or-higher membership. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'operator',
  ) => Effect.Effect<AuthorizedContext, unknown, R>
  readonly control: (bindings: E['Bindings']) => Effect.Effect<ServerPlanControlShape, never, R>
  /** Composes the parent plan/apply control around the existing server planner. */
  readonly provisionControl?: (
    bindings: E['Bindings'],
    serverPlan: ServerPlanControlShape,
  ) => Effect.Effect<ServerProvisionPlanControlShape, never, R>
  readonly auditRequestContext?: (context: HonoContext<E>) => AuditRequestContextValue
}

const invalid = (message: string) => new ServerPlanRequestValidationError({ message })

const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ServerCreateIntent, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() =>
          invalid('The request does not match the game-server plan API contract'),
        ),
      ),
    ),
  )

const decodeApplyBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ServerApplyIntent, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() => invalid('The request does not match the server apply API contract')),
      ),
    ),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

export const mapServerPlanError = (error: ServerPlanError) => {
  if (error instanceof ServerPlanValidationError)
    return invalid('The request does not match the game-server plan API contract')
  if (error instanceof ServerPlanAuthorizationError)
    return new AuthorizationError({
      code: 'role_required',
      message: 'Operator role is required',
    })
  if (error instanceof ServerPlacementRejectedError)
    return new ConflictError({ code: error.code, message: error.message })
  if (
    error instanceof ServerPlanFactsUnavailableError ||
    error instanceof ServerPlanPersistenceError
  )
    return new PersistenceError({
      operation: 'game-server.plan',
      message: 'Authoritative game-server planning facts are unavailable',
    })
  return new PersistenceError({
    operation: 'game-server.plan',
    message: 'Game-server planning is unavailable',
  })
}

export const mapServerApplyError = (error: unknown) => {
  if (
    error instanceof ServerProvisionValidationError &&
    error.code === CommercialReviewRequiredValidationCode
  )
    return new ConflictError({
      code: CommercialReviewRequiredValidationCode,
      message: 'The exact commercial provider offer must be reviewed again before applying',
    })
  if (error instanceof ServerProvisionValidationError)
    return invalid('The request does not match the server apply API contract')
  if (error instanceof ServerProvisionIdempotencyConflictError)
    return new ConflictError({
      code: 'idempotency_key_reused',
      message: 'Idempotency-Key was already used with a different server apply request',
    })
  if (error instanceof ServerProvisionPersistenceError)
    return new PersistenceError({
      operation: 'game-server.apply',
      message: 'The server provisioning plan could not be durably accepted',
    })
  return mapServerPlanError(error as ServerPlanError)
}

const planPath = '/v1/organizations/:organization/game-servers/plan'
const applyPath = '/v1/organizations/:organization/game-servers/apply'

/** Register after shared authentication, request-size, CORS, and CSRF middleware. */
export const registerServerPlanRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: ServerPlanRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.post(
    planPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'operator')
        if (actor.role !== 'operator' && actor.role !== 'administrator' && actor.role !== 'owner')
          return yield* new AuthorizationError({
            code: 'role_required',
            message: 'Operator role is required',
          })
        const intent = yield* decodeBody(context.req.raw)
        const serverPlan = yield* dependencies.control(context.env)
        const planRequest = {
          context: {
            organizationId: actor.organizationId,
            actorId: actor.identityId,
            actorRole: actor.role,
            correlationId: actor.correlationId,
            ...(actor.membershipRevision === undefined
              ? {}
              : { actorMembershipRevision: actor.membershipRevision }),
          },
          intent,
        } as const
        const decision =
          dependencies.provisionControl === undefined
            ? yield* serverPlan.plan(planRequest).pipe(Effect.mapError(mapServerPlanError))
            : yield* (yield* dependencies.provisionControl(context.env, serverPlan))
                .plan(planRequest)
                .pipe(Effect.mapError(mapServerApplyError))
        return jsonResponse(decision)
      }),
    ),
  )
  app.post(
    applyPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'operator')
        if (actor.role !== 'operator' && actor.role !== 'administrator' && actor.role !== 'owner')
          return yield* new AuthorizationError({
            code: 'role_required',
            message: 'Operator role is required',
          })
        if (
          dependencies.provisionControl === undefined ||
          dependencies.auditRequestContext === undefined
        )
          return yield* new PersistenceError({
            operation: 'game-server.apply',
            message: 'Server provisioning composition is unavailable',
          })
        const intent = yield* decodeApplyBody(context.req.raw)
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const serverPlan = yield* dependencies.control(context.env)
        const control = yield* dependencies.provisionControl(context.env, serverPlan)
        const accepted = yield* control
          .apply({
            context: {
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              actorRole: actor.role,
              correlationId: actor.correlationId,
              ...(actor.membershipRevision === undefined
                ? {}
                : { actorMembershipRevision: actor.membershipRevision }),
            },
            idempotencyKey,
            intent,
            auditRequestContext: dependencies.auditRequestContext(context),
          })
          .pipe(Effect.mapError(mapServerApplyError))
        return jsonResponse(accepted, 202)
      }),
    ),
  )
  return app
}

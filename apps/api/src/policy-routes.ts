import { Effect, Schema } from 'effect'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { ConflictError, NotFoundError, PersistenceError } from '@gridora/contracts'
import { IdempotencyKey } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import { decodeOrganizationPolicy } from '@gridora/policy-control'
import {
  makePolicyManagementRepositoryD1,
  PolicyManagementConflictError,
  PolicyManagementNotFoundError,
  PolicyManagementPersistenceError,
  type PolicyD1Database,
} from '@gridora/policy-d1'
import { PutOrganizationPolicyBody } from './contracts.js'

export class PolicyRequestValidationError extends Schema.TaggedError<PolicyRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface PolicyRouteActor {
  readonly organizationId: string
  readonly identityId: string
  readonly correlationId: string
}
export type PolicyRouteMinimumRole = 'viewer' | 'administrator' | 'owner'

export interface PolicyRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly database: (bindings: E['Bindings']) => PolicyD1Database
  readonly auditRequestContext: (context: HonoContext<E>) => AuditRequestContextValue
  /** Must resolve the route organization by ID or slug and enforce active membership and role. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: PolicyRouteMinimumRole,
  ) => Effect.Effect<PolicyRouteActor, unknown, R>
}

const invalid = (message: string) => new PolicyRequestValidationError({ message })
const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(PutOrganizationPolicyBody, {
        onExcessProperty: 'error',
      })(value).pipe(
        Effect.mapError(() => invalid('The request does not match the policy API contract')),
      ),
    ),
    Effect.flatMap((body) =>
      decodeOrganizationPolicy(body.policy).pipe(
        Effect.mapError(() => invalid('The policy is not valid schema version 1')),
        Effect.map((policy) => ({ ...body, policy })),
      ),
    ),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const sha256 = (value: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () =>
      new PersistenceError({ operation: 'policy.fingerprint', message: 'SHA-256 unavailable' }),
  })

const mapRepositoryError = (
  error:
    | PolicyManagementNotFoundError
    | PolicyManagementConflictError
    | PolicyManagementPersistenceError,
) => {
  if (error instanceof PolicyManagementNotFoundError)
    return new NotFoundError({ resource: 'organization-policy', id: error.organizationId })
  if (error instanceof PolicyManagementConflictError)
    return new ConflictError({
      code:
        error.code === 'idempotency_payload_mismatch'
          ? 'policy_idempotency_payload_mismatch'
          : 'policy_revision_mismatch',
      message:
        error.code === 'idempotency_payload_mismatch'
          ? 'Idempotency-Key was already used with a different policy payload'
          : 'Organization policy revision changed',
    })
  return new PersistenceError({
    operation: error.operation,
    message: 'Organization policy persistence is unavailable',
  })
}

const policyPath = '/v1/organizations/:organization/policy'

/** Register after the shared authentication, body-limit, CORS, and CSRF middleware. */
export const registerPolicyRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: PolicyRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.get(
    policyPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const repository = makePolicyManagementRepositoryD1(dependencies.database(context.env))
        const policy = yield* repository
          .get(actor.organizationId)
          .pipe(Effect.mapError(mapRepositoryError))
        return jsonResponse(policy)
      }),
    ),
  )

  app.put(
    policyPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const body = yield* decodeBody(context.req.raw)
        if (
          body.policy.organizationId !== actor.organizationId ||
          body.policy.revision !== body.expectedRevision + 1
        )
          return yield* invalid('Policy organization and revision must match the authorized update')
        const repository = makePolicyManagementRepositoryD1(dependencies.database(context.env))
        const current = yield* repository
          .get(actor.organizationId)
          .pipe(Effect.mapError(mapRepositoryError))
        const ownerOnlyChange =
          canonicalize(current.monthlyBudget) !== canonicalize(body.policy.monthlyBudget) ||
          canonicalize(current.nonHourlyCommitment) !==
            canonicalize(body.policy.nonHourlyCommitment)
        const mutationActor = ownerOnlyChange
          ? yield* dependencies.authorize(context, 'owner')
          : actor
        const requestFingerprint = yield* sha256(
          canonicalize({
            routeAction: 'update-organization-policy',
            organizationId: actor.organizationId,
            expectedRevision: body.expectedRevision,
            policy: body.policy,
          }),
        )
        const operationId = `policy_${crypto.randomUUID()}`
        const operationIdempotencyKey = yield* sha256(
          canonicalize({
            organizationId: actor.organizationId,
            actorId: mutationActor.identityId,
            action: 'update-organization-policy',
            resourceType: 'organization-policy',
            resourceId: actor.organizationId,
            idempotencyKey,
          }),
        )
        const updated = yield* repository
          .put({
            context: mutationActor,
            expectedRevision: body.expectedRevision,
            policy: body.policy,
            idempotencyKey,
            operationIdempotencyKey,
            requestFingerprint,
            operationId,
            request: dependencies.auditRequestContext(context),
            now: new Date().toISOString(),
          })
          .pipe(Effect.mapError(mapRepositoryError))
        return jsonResponse({
          operationId: updated.operationId,
          resourceId: updated.resourceId,
          status: 'succeeded',
          links: {
            operation: `/v1/organizations/${actor.organizationId}/operations/${updated.operationId}`,
          },
        })
      }),
    ),
  )
  return app
}

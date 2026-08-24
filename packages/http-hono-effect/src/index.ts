import { Effect, Layer, ManagedRuntime, Result, Schema } from 'effect'
import type { Context as HonoContext, Env as HonoEnv, Handler } from 'hono'

export const Problem = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Number,
  code: Schema.String,
  detail: Schema.String,
  requestId: Schema.String,
  operationId: Schema.optional(Schema.String),
  retryable: Schema.Boolean,
  fields: Schema.Array(Schema.Struct({ field: Schema.String, message: Schema.String })),
})
export type Problem = typeof Problem.Type

/**
 * A user must obtain a fresh, server-reviewed commercial offer before retrying
 * this conflict. It is intentionally distinct from a generic revision or
 * idempotency conflict so generated clients can safely stop rather than retry.
 */
export const CommercialReviewRequiredProblemCode = 'COMMERCIAL_REVIEW_REQUIRED' as const
export type CommercialReviewRequiredProblemCode = typeof CommercialReviewRequiredProblemCode

export interface HttpFailure {
  readonly status: number
  readonly problem: Problem
}

const tagOf = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && '_tag' in error && typeof error._tag === 'string'
    ? error._tag
    : undefined

const stringField = (error: unknown, field: string): string | undefined =>
  error !== null &&
  typeof error === 'object' &&
  field in error &&
  typeof error[field as keyof typeof error] === 'string'
    ? (error[field as keyof typeof error] as string)
    : undefined

export const problemFromError = (error: unknown, requestId: string): HttpFailure => {
  const tag = tagOf(error)
  const detail = stringField(error, 'message') ?? 'The request could not be completed'
  switch (tag) {
    case 'RequestValidationError':
    case 'HealthValidationError':
    case 'LogValidationError':
      return problem(
        400,
        'REQUEST_VALIDATION_FAILED',
        'Request validation failed',
        detail,
        requestId,
      )
    case 'AccessAuthenticationError':
    case 'AuthenticationIntentError':
      return problem(
        401,
        'ACCESS_AUTHENTICATION_FAILED',
        'Authentication required',
        detail,
        requestId,
      )
    case 'InternalRequestAuthenticationError':
      return problem(
        403,
        'INTERNAL_AUTHENTICATION_FAILED',
        'Internal authentication failed',
        'The internal request signature is invalid',
        requestId,
      )
    case 'AuthorizationError':
      if (stringField(error, 'code') === 'identity_suspended') {
        return problem(403, 'IDENTITY_SUSPENDED', 'Identity suspended', detail, requestId)
      }
      return problem(
        403,
        'ORGANIZATION_ACCESS_DENIED',
        'Organization access denied',
        detail,
        requestId,
      )
    case 'LogAuthorizationError':
      return problem(
        403,
        'ORGANIZATION_ACCESS_DENIED',
        'Organization access denied',
        'The requested log scope is not available',
        requestId,
      )
    case 'NotFoundError':
    case 'LogNotFoundError':
      return problem(404, 'NOT_FOUND', 'Resource not found', detail, requestId)
    case 'ConflictError':
      if (stringField(error, 'code') === 'commercial_review_required')
        return problem(
          409,
          CommercialReviewRequiredProblemCode,
          'Commercial review required',
          detail,
          requestId,
        )
      return problem(409, 'CONFLICT', 'Request conflict', detail, requestId)
    case 'LastOwnerError':
    case 'RevisionConflictError':
      return problem(409, 'CONFLICT', 'Request conflict', detail, requestId)
    case 'AgentObservationNotCommittedError':
      return problem(
        409,
        'AGENT_OBSERVATION_NOT_COMMITTED',
        'Agent observation not committed',
        'The authoritative cursor did not commit this observation',
        requestId,
      )
    case 'InvitationError':
      return problem(422, 'INVITATION_INVALID', 'Invitation cannot be used', detail, requestId)
    case 'RegistrationDeniedError':
      return problem(
        403,
        'REGISTRATION_NOT_AVAILABLE',
        'Registration not available',
        'Registration is not available',
        requestId,
      )
    case 'RegistrationPolicyUnavailableError':
      return problem(
        503,
        'REGISTRATION_POLICY_UNAVAILABLE',
        'Registration temporarily unavailable',
        'The request can be retried',
        requestId,
        true,
      )
    case 'PersistenceError':
    case 'HealthPersistenceError':
    case 'LogPersistenceError':
      return problem(
        503,
        'PERSISTENCE_UNAVAILABLE',
        'Service temporarily unavailable',
        'The request can be retried',
        requestId,
        true,
      )
    case 'AgentTelemetryError':
      return stringField(error, 'code') === 'invalid-input'
        ? problem(400, 'REQUEST_VALIDATION_FAILED', 'Request validation failed', detail, requestId)
        : problem(
            503,
            'TELEMETRY_UNAVAILABLE',
            'Telemetry temporarily unavailable',
            'The request can be retried',
            requestId,
            true,
          )
    case 'LogR2Error': {
      const code = stringField(error, 'code')
      if (code === 'invalid-input' || code === 'size-limit')
        return problem(
          400,
          'REQUEST_VALIDATION_FAILED',
          'Request validation failed',
          detail,
          requestId,
        )
      if (code === 'not-found' || code === 'ownership-denied')
        return problem(
          404,
          'NOT_FOUND',
          'Resource not found',
          'The log archive is not available',
          requestId,
        )
      if (code === 'conflict')
        return problem(409, 'CONFLICT', 'Request conflict', detail, requestId)
      return problem(
        503,
        'LOG_ARCHIVE_UNAVAILABLE',
        'Log archive temporarily unavailable',
        'The request can be retried',
        requestId,
        true,
      )
    }
    default:
      return problem(
        500,
        'INTERNAL_ERROR',
        'Internal server error',
        'An unexpected error occurred',
        requestId,
      )
  }
}

const problem = (
  status: number,
  code: string,
  title: string,
  detail: string,
  requestId: string,
  retryable = false,
): HttpFailure => ({
  status,
  problem: {
    type: `https://errors.gridora.example/${code.toLowerCase().replaceAll('_', '-')}`,
    title,
    status,
    code,
    detail,
    requestId,
    retryable,
    fields: [],
  },
})

export const problemResponse = (failure: HttpFailure): Response =>
  new Response(JSON.stringify(failure.problem), {
    status: failure.status,
    headers: { 'content-type': 'application/problem+json; charset=utf-8' },
  })

export interface WorkerEffectRuntime<R> {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, R>,
    requestId: string,
  ) => Promise<A | HttpFailure>
  readonly runBackground: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<void>
  readonly dispose: () => Promise<void>
}

export const makeWorkerEffectRuntime = <R>(
  layer: Layer.Layer<R, never>,
): WorkerEffectRuntime<R> => {
  const runtime = ManagedRuntime.make(layer)
  return {
    run: async (effect, requestId) => {
      const result = await runtime.runPromise(Effect.result(effect))
      return Result.isSuccess(result) ? result.success : problemFromError(result.failure, requestId)
    },
    runBackground: async (effect) => {
      await runtime.runPromise(effect)
    },
    dispose: runtime.dispose,
  }
}

export interface CanonicalRequestIds {
  readonly requestId: string
  readonly correlationId: string
}

const requestIds = new WeakMap<object, CanonicalRequestIds>()
const isSafeRequestIdentifier = (value: string | undefined): value is string =>
  value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

/**
 * Canonicalize once per HTTP request. Invalid client headers are never copied to
 * logs, operation records, audit envelopes, or response headers.
 */
export const canonicalRequestIdsFromContext = (context: HonoContext): CanonicalRequestIds => {
  const cached = requestIds.get(context)
  if (cached !== undefined) return cached
  const requestId = isSafeRequestIdentifier(context.req.header('x-request-id'))
    ? context.req.header('x-request-id')!
    : crypto.randomUUID()
  const correlationId = isSafeRequestIdentifier(context.req.header('x-correlation-id'))
    ? context.req.header('x-correlation-id')!
    : requestId
  const canonical = { requestId, correlationId }
  requestIds.set(context, canonical)
  return canonical
}

export const requestIdFromContext = (context: HonoContext): string =>
  canonicalRequestIdsFromContext(context).requestId

export const correlationIdFromContext = (context: HonoContext): string =>
  canonicalRequestIdsFromContext(context).correlationId

export const effectHandler =
  <E extends HonoEnv, R, Failure>(
    runtime: WorkerEffectRuntime<R> | ((context: HonoContext<E>) => WorkerEffectRuntime<R>),
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ): Handler<E> =>
  async (context) => {
    const { requestId, correlationId } = canonicalRequestIdsFromContext(context)
    const requestRuntime = typeof runtime === 'function' ? runtime(context) : runtime
    const result = await requestRuntime.run(program(context), requestId)
    const response =
      'problem' in Object(result) ? problemResponse(result as HttpFailure) : (result as Response)
    response.headers.set('x-request-id', requestId)
    response.headers.set('x-correlation-id', correlationId)
    return response
  }

export const waitUntilEffect = <R, A, E>(
  context: { readonly waitUntil: (promise: Promise<unknown>) => void },
  runtime: WorkerEffectRuntime<R>,
  effect: Effect.Effect<A, E, R>,
): void => {
  context.waitUntil(runtime.runBackground(effect))
}

export const jsonResponse = (value: unknown, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers)
  if (!responseHeaders.has('content-type'))
    responseHeaders.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  })
}

import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import {
  CommercialReviewRequiredProblemCode,
  canonicalRequestIdsFromContext,
  effectHandler,
  makeWorkerEffectRuntime,
  problemFromError,
  problemResponse,
} from '../src/index.js'

describe('problem mapping', () => {
  it('maps only the typed commercial-review conflict to a safe, actionable 409 envelope', () => {
    const failure = problemFromError(
      {
        _tag: 'ConflictError',
        code: 'commercial_review_required',
        message: 'The reviewed commercial provider offer changed',
        reviewedNodeProvision: { providerAccountId: 'must-not-leak' },
      },
      'req_commercial_review',
    )

    expect(failure).toEqual({
      status: 409,
      problem: {
        type: 'https://errors.gridora.example/commercial-review-required',
        title: 'Commercial review required',
        status: 409,
        code: CommercialReviewRequiredProblemCode,
        detail: 'The reviewed commercial provider offer changed',
        requestId: 'req_commercial_review',
        retryable: false,
        fields: [],
      },
    })
    expect(JSON.stringify(failure)).not.toContain('must-not-leak')
    expect(
      problemFromError(
        { _tag: 'ConflictError', code: 'idempotency_key_reused', message: 'reused' },
        'req_generic_conflict',
      ).problem.code,
    ).toBe('CONFLICT')
  })

  it('maps authentication failures without leaking causes', async () => {
    const failure = problemFromError(
      { _tag: 'AccessAuthenticationError', message: 'expired' },
      'req_1',
    )
    const response = problemResponse(failure)
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({
      code: 'ACCESS_AUTHENTICATION_FAILED',
      requestId: 'req_1',
    })
  })

  it('maps unknown failures to a stable internal envelope', () => {
    expect(problemFromError(new Error('secret'), 'req_2').problem).toMatchObject({
      status: 500,
      detail: 'An unexpected error occurred',
      retryable: false,
    })
  })

  it('distinguishes a proven uncommitted agent observation', () => {
    expect(
      problemFromError(
        {
          _tag: 'AgentObservationNotCommittedError',
          code: 'agent_observation_not_committed',
          message: 'secret-canary',
        },
        'req_observation',
      ).problem,
    ).toEqual({
      type: 'https://errors.gridora.example/agent-observation-not-committed',
      title: 'Agent observation not committed',
      status: 409,
      code: 'AGENT_OBSERVATION_NOT_COMMITTED',
      detail: 'The authoritative cursor did not commit this observation',
      requestId: 'req_observation',
      retryable: false,
      fields: [],
    })
  })

  it('maps bounded health and log boundary failures without exposing transport detail', () => {
    expect(
      problemFromError({ _tag: 'LogValidationError', message: 'bad cursor' }, 'req_log').problem,
    ).toMatchObject({ status: 400, code: 'REQUEST_VALIDATION_FAILED' })
    expect(
      problemFromError(
        { _tag: 'LogR2Error', code: 'ownership-denied', message: 'foreign tenant key' },
        'req_archive',
      ).problem,
    ).toMatchObject({ status: 404, code: 'NOT_FOUND', detail: 'The log archive is not available' })
    expect(
      problemFromError(
        {
          _tag: 'HealthPersistenceError',
          operation: 'health.current.read',
          message: 'database detail',
        },
        'req_health',
      ).problem,
    ).toMatchObject({
      status: 503,
      code: 'PERSISTENCE_UNAVAILABLE',
      detail: 'The request can be retried',
    })
  })

  it('uses one safe canonical pair for invalid client request headers and response headers', async () => {
    const app = new Hono()
    const runtime = makeWorkerEffectRuntime(Layer.empty)
    app.get(
      '/request',
      effectHandler(runtime, (context) =>
        Effect.sync(() => {
          const first = canonicalRequestIdsFromContext(context)
          const second = canonicalRequestIdsFromContext(context)
          return Response.json({ first, second })
        }),
      ),
    )

    const response = await app.request('https://api.gridora.test/request', {
      headers: {
        'x-request-id': 'unsafe request!',
        'x-correlation-id': 'also unsafe!',
      },
    })
    const body = await response.json<{
      readonly first: { readonly requestId: string; readonly correlationId: string }
      readonly second: { readonly requestId: string; readonly correlationId: string }
    }>()

    expect(body.first).toEqual(body.second)
    expect(body.first.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
    expect(body.first.correlationId).toBe(body.first.requestId)
    expect(response.headers.get('x-request-id')).toBe(body.first.requestId)
    expect(response.headers.get('x-correlation-id')).toBe(body.first.correlationId)
  })

  it('preserves valid supplied IDs as the single request identity', async () => {
    const app = new Hono()
    const runtime = makeWorkerEffectRuntime(Layer.empty)
    app.get(
      '/request',
      effectHandler(runtime, (context) =>
        Effect.sync(() => Response.json(canonicalRequestIdsFromContext(context))),
      ),
    )

    const response = await app.request('https://api.gridora.test/request', {
      headers: { 'x-request-id': 'request_42', 'x-correlation-id': 'correlation_42' },
    })
    await expect(response.json()).resolves.toEqual({
      requestId: 'request_42',
      correlationId: 'correlation_42',
    })
    expect(response.headers.get('x-request-id')).toBe('request_42')
    expect(response.headers.get('x-correlation-id')).toBe('correlation_42')
  })
})

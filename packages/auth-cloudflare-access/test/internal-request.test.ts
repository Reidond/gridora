import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { signInternalRequest, verifyInternalRequest } from '../src/index.js'

describe('internal request authentication', () => {
  const secret = 'test-secret-with-at-least-thirty-two-bytes'
  it('authenticates the exact body inside a short replay window', async () => {
    const body = JSON.stringify({ eventId: 'evt_1' })
    const now = Date.now()
    const headers = await Effect.runPromise(signInternalRequest(body, secret, now, 'nonce_1'))
    const request = new Request('https://internal.test', { method: 'POST', headers, body })
    await expect(Effect.runPromise(verifyInternalRequest(request, secret, now))).resolves.toEqual({
      nonce: 'nonce_1',
      timestamp: now,
      expiresAt: now + 60_000,
    })
  })

  it('rejects body tampering and expired signatures', async () => {
    const now = Date.now()
    const headers = await Effect.runPromise(signInternalRequest('original', secret, now, 'nonce_1'))
    await expect(
      Effect.runPromise(
        verifyInternalRequest(
          new Request('https://internal.test', {
            method: 'POST',
            headers,
            body: 'tampered',
          }),
          secret,
          now,
        ),
      ),
    ).rejects.toBeDefined()
    await expect(
      Effect.runPromise(
        verifyInternalRequest(
          new Request('https://internal.test', {
            method: 'POST',
            headers,
            body: 'original',
          }),
          secret,
          now + 120_000,
        ),
      ),
    ).rejects.toBeDefined()
  })

  it('binds method, path, and internal routing headers to the signature', async () => {
    const now = Date.now()
    const routing = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: 'reconcile-orphan',
      workflowStep: 'record-operation-started',
      workflowStepOrdinal: '0',
      organizationId: 'org_1',
    }
    const headers = await Effect.runPromise(
      signInternalRequest('{}', secret, now, 'nonce_routing', routing),
    )
    const requestHeaders = {
      ...headers,
      'x-gridora-workflow': routing.workflow,
      'x-gridora-workflow-step': routing.workflowStep,
      'x-gridora-workflow-step-ordinal': routing.workflowStepOrdinal,
      'x-gridora-organization-id': routing.organizationId,
    }
    await expect(
      Effect.runPromise(
        verifyInternalRequest(
          new Request('https://internal.test/v1/internal/workflow-steps/execute', {
            method: 'POST',
            headers: requestHeaders,
            body: '{}',
          }),
          secret,
          now,
        ),
      ),
    ).resolves.toMatchObject({ nonce: 'nonce_routing' })
    await expect(
      Effect.runPromise(
        verifyInternalRequest(
          new Request('https://internal.test/v1/internal/workflow-steps/execute', {
            method: 'POST',
            headers: { ...requestHeaders, 'x-gridora-workflow-step': 'tampered' },
            body: '{}',
          }),
          secret,
          now,
        ),
      ),
    ).rejects.toBeDefined()
  })
})

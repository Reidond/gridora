import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { verifyInternalRequest } from '@gridora/auth-cloudflare-access'
import { PolicyReconciliationResult } from '@gridora/policy-reconciliation-control'
import {
  POLICY_RECONCILIATION_STEP_NAME,
  POLICY_RECONCILIATION_STEP_OPTIONS,
  PolicyWorkflowPayload,
  executeSignedPolicyReconciliation,
  runPolicyReconciliationWorkflow,
  type PolicyDurableStep,
} from '../src/policy-reconciliation.js'

const payload = Schema.decodeUnknownSync(PolicyWorkflowPayload)({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-a',
  policyRevision: 1,
  scheduleSlot: '2026-08-23T10:30:00.000Z',
  runId: 'policy-run-a',
  idempotencyKey: 'policy-idempotency-a',
  workflowId: 'policy-workflow-a',
  leaseToken: 'policy-lease-a',
})

const result = Schema.decodeUnknownSync(PolicyReconciliationResult)({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-a',
  policyRevision: 1,
  runId: 'policy-run-a',
  idempotencyKey: 'policy-idempotency-a',
  snapshotFingerprint: `sha256:${'a'.repeat(64)}`,
  actions: [
    {
      id: 'policy-action-a',
      organizationId: 'org-a',
      actorId: 'policy-scheduler-a',
      runId: 'policy-run-a',
      policyRevision: 1,
      resourceKind: 'node',
      resourceId: 'node-a',
      resourceRevision: 1,
      kind: 'retire-node',
      reason: 'temporary-node-expired',
      idempotencyKey: 'policy-action-idempotency-a',
      correlationId: 'policy-reconciliation:policy-run-a',
      resourceExpiresAt: '2026-08-23T10:00:00.000Z',
      activityLastAt: null,
      healthSampledAt: null,
      healthRevision: null,
      updateCandidateId: null,
      updateCandidateRevision: null,
      updateCategory: null,
      updateTargetVersion: null,
      configRevision: null,
      modRevision: null,
      dispatchState: 'pending',
      operationId: null,
    },
  ],
  replayed: false,
})

describe('policy reconciliation Workflow boundary', () => {
  it('uses one deterministic durable step for fenced lifecycle command acceptance', async () => {
    const calls: Array<{ readonly name: string; readonly options: unknown }> = []
    const step: PolicyDurableStep = async (name, options, action) => {
      calls.push({ name, options })
      return action()
    }

    await expect(
      runPolicyReconciliationWorkflow(payload, step, async (received) => {
        expect(received).toEqual(payload)
        return result
      }),
    ).resolves.toEqual(result)
    expect(calls).toEqual([
      { name: POLICY_RECONCILIATION_STEP_NAME, options: POLICY_RECONCILIATION_STEP_OPTIONS },
    ])
  })

  it('adopts the durable result on replay without issuing another lifecycle request', async () => {
    let stored: string | undefined
    let reconciliations = 0
    const step: PolicyDurableStep = async (_name, _options, action) => {
      if (stored !== undefined) return stored
      stored = await action()
      return stored
    }
    const reconcile = async () => {
      reconciliations += 1
      return result
    }

    await runPolicyReconciliationWorkflow(payload, step, reconcile)
    await runPolicyReconciliationWorkflow(payload, step, reconcile)
    expect(reconciliations).toBe(1)
  })

  it('rejects forged tenant or excess input before invoking the reconciliation boundary', async () => {
    let invoked = false
    const step: PolicyDurableStep = async (_name, _options, action) => action()
    await expect(
      runPolicyReconciliationWorkflow(
        { ...payload, organizationId: 'org-b', providerCredential: 'must-not-enter-workflow' },
        step,
        async () => {
          invoked = true
          return result
        },
      ),
    ).rejects.toBeDefined()
    expect(invoked).toBe(false)
  })

  it('signs the exact tenant task for the fixed internal endpoint', async () => {
    const secret = 'workflow-test-internal-secret'
    let request: Request | undefined
    const environment = {
      INTERNAL_SERVICE_SECRET: secret,
      APPLICATION: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          request = new Request(input, init)
          return Response.json(result)
        },
      },
    }

    await expect(executeSignedPolicyReconciliation(environment as never, payload)).resolves.toEqual(
      result,
    )
    if (request === undefined) throw new Error('Workflow did not issue an internal request')
    expect(request.url).toBe('https://gridora.internal/v1/internal/policy-reconciliations/execute')
    expect(request.headers.get('x-gridora-workflow')).toBe('reconcile-policy')
    expect(request.headers.get('x-gridora-organization-id')).toBe(payload.organizationId)
    expect(request.headers.get('idempotency-key')).toBe(`workflow:${payload.idempotencyKey}`)
    await expect(Effect.runPromise(verifyInternalRequest(request, secret))).resolves.toMatchObject({
      nonce: expect.any(String),
    })
  })
})

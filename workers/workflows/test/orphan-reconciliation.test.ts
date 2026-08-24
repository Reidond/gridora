import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { verifyInternalRequest } from '@gridora/auth-cloudflare-access'
import {
  ORPHAN_RECONCILIATION_STEP_NAME,
  ORPHAN_RECONCILIATION_STEP_OPTIONS,
  OrphanWorkflowPayload,
  executeSignedOrphanReconciliation,
  runOrphanReconciliationWorkflow,
  type OrphanDurableStep,
} from '../src/orphan-reconciliation.js'

const payload = Schema.decodeUnknownSync(OrphanWorkflowPayload)({
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  providerType: 'ovhcloud' as const,
  scheduleSlot: '2026-08-23T10:00:00.000Z',
  runId: 'run-a',
  idempotencyKey: 'request-a',
  workflowId: 'orphan-workflow-a',
  leaseToken: 'orphan-lease-a',
  actorId: 'actor-a',
})

const result = {
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  runId: 'run-a',
  discoveryFingerprint: `sha256:${'a'.repeat(64)}`,
  opened: 1,
  updated: 0,
  resolved: 0,
  unchanged: 0,
  replayed: false,
}

describe('orphan reconciliation workflow boundary', () => {
  it('uses one fixed durable detection step and persists a bounded result', async () => {
    const calls: Array<{ name: string; options: unknown }> = []
    const step: OrphanDurableStep = async (name, options, action) => {
      calls.push({ name, options })
      return action()
    }
    await expect(
      runOrphanReconciliationWorkflow(payload, step, async (received) => {
        expect(received).toEqual(payload)
        return result
      }),
    ).resolves.toEqual(result)
    expect(calls).toEqual([
      {
        name: ORPHAN_RECONCILIATION_STEP_NAME,
        options: ORPHAN_RECONCILIATION_STEP_OPTIONS,
      },
    ])
  })

  it('adopts the durable step result after replay without re-running reconciliation', async () => {
    let stored: string | undefined
    let reconciliations = 0
    const step: OrphanDurableStep = async (_name, _options, action) => {
      if (stored !== undefined) return stored
      stored = await action()
      return stored
    }
    const reconcile = async () => {
      reconciliations += 1
      return result
    }
    await runOrphanReconciliationWorkflow(payload, step, reconcile)
    await runOrphanReconciliationWorkflow(payload, step, reconcile)
    expect(reconciliations).toBe(1)
  })

  it('rejects cross-scope or excess input before invoking reconciliation', async () => {
    let invoked = false
    const step: OrphanDurableStep = async (_name, _options, action) => action()
    await expect(
      runOrphanReconciliationWorkflow(
        { ...payload, providerAccountId: '', providerAccessToken: 'must-not-persist' },
        step,
        async () => {
          invoked = true
          return result
        },
      ),
    ).rejects.toBeDefined()
    expect(invoked).toBe(false)
  })

  it('rejects a reconciliation response containing provider material', async () => {
    const step: OrphanDurableStep = async (_name, _options, action) => action()
    await expect(
      runOrphanReconciliationWorkflow(payload, step, async () => ({
        ...result,
        providerAccessToken: 'must-not-persist',
      })),
    ).rejects.toBeDefined()
  })

  it('signs the exact tenant task for the fixed internal read-only route', async () => {
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

    await expect(executeSignedOrphanReconciliation(environment as never, payload)).resolves.toEqual(
      result,
    )
    if (request === undefined) throw new Error('Workflow did not issue an internal request')
    expect(request.url).toBe('https://gridora.internal/v1/internal/orphan-reconciliations/execute')
    expect(request.headers.get('x-gridora-workflow')).toBe('reconcile-orphan')
    expect(request.headers.get('x-gridora-organization-id')).toBe(payload.organizationId)
    expect(request.headers.get('idempotency-key')).toBe(`workflow:${payload.idempotencyKey}`)
    await expect(Effect.runPromise(verifyInternalRequest(request, secret))).resolves.toMatchObject({
      nonce: expect.any(String),
    })
  })
})

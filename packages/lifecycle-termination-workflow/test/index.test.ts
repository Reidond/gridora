import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import {
  type OperationCancellationFacts,
  type TerminationOperation,
  TerminationPersistenceError,
  type WorkflowStepClaim,
  type WorkflowStepEffectReceipt,
  type WorkflowStepLease,
  type WorkflowStepRepositoryShape,
} from '@gridora/lifecycle-termination-control'
import { executeSignedTerminationWorkflowStep } from '../src/index.js'

const now = 1_777_000_000_000
const secret = 'test-secret-with-at-least-thirty-two-bytes'
const outcomeFingerprint = 'a'.repeat(64)
const envelope = {
  organizationId: 'org-a',
  operationId: 'operation-a',
  workflowType: 'RetireNodeWorkflow',
  workflowInstanceId: 'operation-a',
  stepName: 'retire-provider-node',
  ordinal: 3,
  destructive: true,
} as const

const operation: TerminationOperation = {
  id: envelope.operationId,
  organizationId: envelope.organizationId,
  actorId: 'actor-a',
  action: 'retire-node',
  resourceType: 'node',
  resourceId: 'node-a',
  cancellationPolicy: 'before-destructive-step',
  revision: 2,
  state: 'running',
}
const facts: OperationCancellationFacts = {
  organizationId: envelope.organizationId,
  operationId: envelope.operationId,
  resourceType: 'node',
  resourceId: 'node-a',
  resourceOperationDoName: 'resource-operation:org-a:node:node-a',
  workflowBinding: 'RETIRE_NODE',
  workflowType: envelope.workflowType,
  workflowInstanceId: envelope.operationId,
  policy: 'before-destructive-step',
  phase: 'destructive-step-running',
  activeStepName: envelope.stepName,
  activeStepOrdinal: envelope.ordinal,
  revision: 2,
}
const priorLease: WorkflowStepLease = {
  claimId: 'prior-claim-identity-0001',
  attempt: 1,
  expiresAt: new Date(now - 1).toISOString(),
}
const retryLease: WorkflowStepLease = {
  claimId: 'retry-claim-identity-0002',
  attempt: 2,
  expiresAt: new Date(now + 300_000).toISOString(),
}
const receipt: WorkflowStepEffectReceipt = {
  effectId: 'provider-operation-identity-0001',
  outcomeFingerprint,
}

const claim = (
  disposition: WorkflowStepClaim['disposition'],
  extras: Partial<WorkflowStepClaim> = {},
): WorkflowStepClaim => ({ disposition, operation, facts, ...extras })

const signedRequest = async () => {
  const body = JSON.stringify(envelope)
  const routing = {
    method: 'POST',
    path: '/v1/internal/workflow-steps/execute',
    workflow: envelope.workflowType,
    workflowStep: envelope.stepName,
    workflowStepOrdinal: String(envelope.ordinal),
    organizationId: envelope.organizationId,
  }
  const signature = await Effect.runPromise(
    signInternalRequest(body, secret, now, 'nonce-a', routing),
  )
  return new Request(`https://internal.test${routing.path}`, {
    method: 'POST',
    headers: {
      ...signature,
      'x-gridora-workflow': routing.workflow,
      'x-gridora-workflow-step': routing.workflowStep,
      'x-gridora-workflow-step-ordinal': routing.workflowStepOrdinal,
      'x-gridora-organization-id': routing.organizationId,
    },
    body,
  })
}

const unused = () => Effect.die('not used')

describe('signed destructive workflow step recovery', () => {
  it('adopts an externally applied effect after a receipt response loss without a second provider mutation', async () => {
    let first = true
    let providerMutations = 0
    let observations = 0
    let completed = 0
    const repository: WorkflowStepRepositoryShape = {
      claimStep: () =>
        Effect.succeed(
          first
            ? claim('execute', { lease: priorLease })
            : claim('reconciliation-required', { lease: priorLease }),
        ),
      resolveExpiredStepClaim: (input) => {
        observations += 1
        expect(input.observation).toEqual({ state: 'applied', receipt })
        return Effect.succeed(
          claim('effect-adopted', { lease: priorLease, effectReceipt: receipt }),
        )
      },
      recordStepEffectReceipt: () => {
        first = false
        return Effect.fail(
          new TerminationPersistenceError({ operation: 'receipt', message: 'response lost' }),
        )
      },
      completeStep: () => {
        completed += 1
        return Effect.void
      },
      finalizeCancellation: unused,
    }
    const options = {
      secret,
      now,
      repository,
      execute: () => {
        providerMutations += 1
        return Effect.succeed(receipt)
      },
      observeExpiredEffect: () => Effect.succeed({ state: 'applied' as const, receipt }),
      nextClaimId: () => retryLease.claimId,
    }
    const firstExit = await Effect.runPromiseExit(
      executeSignedTerminationWorkflowStep({ request: await signedRequest(), ...options }),
    )
    expect(firstExit._tag).toBe('Failure')
    const second = await Effect.runPromise(
      executeSignedTerminationWorkflowStep({ request: await signedRequest(), ...options }),
    )
    expect(second).toEqual({ status: 'completed' })
    expect(providerMutations).toBe(1)
    expect(observations).toBe(1)
    expect(completed).toBe(1)
  })

  it('permits one new execution only after the observer proves the expired claim was not applied', async () => {
    let providerMutations = 0
    let completed = 0
    const repository: WorkflowStepRepositoryShape = {
      claimStep: () => Effect.succeed(claim('reconciliation-required', { lease: priorLease })),
      resolveExpiredStepClaim: (input) => {
        expect(input.observation).toEqual({ state: 'not-applied' })
        return Effect.succeed(claim('execute', { lease: retryLease }))
      },
      recordStepEffectReceipt: () => Effect.succeed(receipt),
      completeStep: (input) => {
        completed += 1
        expect(input.lease).toEqual(retryLease)
        return Effect.void
      },
      finalizeCancellation: unused,
    }
    const result = await Effect.runPromise(
      executeSignedTerminationWorkflowStep({
        request: await signedRequest(),
        secret,
        now,
        repository,
        execute: (_envelope, lease) => {
          expect(lease).toEqual(retryLease)
          providerMutations += 1
          return Effect.succeed(receipt)
        },
        observeExpiredEffect: () => Effect.succeed({ state: 'not-applied' }),
        nextClaimId: () => retryLease.claimId,
      }),
    )
    expect(result).toEqual({ status: 'completed' })
    expect(providerMutations).toBe(1)
    expect(completed).toBe(1)
  })

  it('does not execute when provider truth remains ambiguous after an expired paid claim', async () => {
    let providerMutations = 0
    const repository: WorkflowStepRepositoryShape = {
      claimStep: () => Effect.succeed(claim('reconciliation-required', { lease: priorLease })),
      resolveExpiredStepClaim: (input) => {
        expect(input.observation).toEqual({ state: 'unknown' })
        return Effect.succeed(claim('reconciliation-required', { lease: priorLease }))
      },
      recordStepEffectReceipt: unused,
      completeStep: unused,
      finalizeCancellation: unused,
    }
    const exit = await Effect.runPromiseExit(
      executeSignedTerminationWorkflowStep({
        request: await signedRequest(),
        secret,
        now,
        repository,
        execute: () => {
          providerMutations += 1
          return Effect.succeed(receipt)
        },
        observeExpiredEffect: () => Effect.succeed({ state: 'unknown' }),
        nextClaimId: () => retryLease.claimId,
      }),
    )
    expect(exit._tag).toBe('Failure')
    expect(providerMutations).toBe(0)
  })
})

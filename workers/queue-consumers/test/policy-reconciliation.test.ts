import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  PolicyScheduleTask,
  type PolicyScheduleStore,
  type PolicyScheduleTask as PolicyScheduleTaskType,
} from '@gridora/policy-schedule'
import {
  startOrAdoptPolicyReconciliationWorkflow,
  type PolicyReconciliationWorkflowBinding,
} from '../src/policy-reconciliation.js'

const task: PolicyScheduleTaskType = Schema.decodeUnknownSync(PolicyScheduleTask)({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-a',
  policyRevision: 1,
  scheduleSlot: '2026-08-23T10:30:00.000Z',
  runId: 'policy-run-a',
  idempotencyKey: 'policy-idempotency-a',
  workflowId: 'policy-workflow-a',
  leaseToken: 'policy-lease-a',
})

const store = (state: 'started' | 'adopted' = 'started'): PolicyScheduleStore => ({
  claimScheduledTasks: () => Effect.succeed([]),
  beginWorkflow: () => Effect.succeed(state),
  assertExecutionLease: () => Effect.void,
  complete: () => Effect.succeed('completed'),
})

describe('policy reconciliation queue Workflow adoption', () => {
  it('starts the exact deterministic Workflow only after its D1 lease begins', async () => {
    const calls: unknown[] = []
    const workflow: PolicyReconciliationWorkflowBinding = {
      create: async (input) => {
        calls.push(input)
        return { id: input.id }
      },
      get: async (id) => ({ id }),
    }

    await expect(startOrAdoptPolicyReconciliationWorkflow(task, store(), workflow)).resolves.toBe(
      'started',
    )
    expect(calls).toEqual([{ id: task.workflowId, params: task }])
  })

  it('adopts the deterministic Workflow after a create response is lost', async () => {
    let gets = 0
    const workflow: PolicyReconciliationWorkflowBinding = {
      create: async () => {
        throw new Error('response lost after Workflow creation')
      },
      get: async (id) => {
        gets += 1
        return { id }
      },
    }

    await expect(startOrAdoptPolicyReconciliationWorkflow(task, store(), workflow)).resolves.toBe(
      'adopted',
    )
    expect(gets).toBe(1)
  })

  it('rejects forged tenant input before it can claim a lease or create a Workflow', async () => {
    let claims = 0
    let creates = 0
    const forgedStore: PolicyScheduleStore = {
      ...store(),
      beginWorkflow: () => {
        claims += 1
        return Effect.succeed('started')
      },
    }
    const workflow: PolicyReconciliationWorkflowBinding = {
      create: async (input) => {
        creates += 1
        return { id: input.id }
      },
      get: async (id) => ({ id }),
    }

    await expect(
      startOrAdoptPolicyReconciliationWorkflow(
        { ...task, organizationId: '', providerCredential: 'must-not-enter-workflow' },
        forgedStore,
        workflow,
      ),
    ).rejects.toBeDefined()
    expect(claims).toBe(0)
    expect(creates).toBe(0)
  })
})

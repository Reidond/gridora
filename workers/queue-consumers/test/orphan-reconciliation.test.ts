import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  OrphanScheduleTask,
  type OrphanScheduleStore,
  type OrphanScheduleTask as OrphanScheduleTaskType,
} from '@gridora/orphan-schedule'
import { startOrAdoptOrphanWorkflow, type OrphanWorkflowBinding } from '../src/index.js'

const task: OrphanScheduleTaskType = Schema.decodeUnknownSync(OrphanScheduleTask)({
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  providerType: 'ovhcloud',
  actorId: 'orphan-scheduler-a',
  scheduleSlot: '2026-08-23T10:00:00.000Z',
  runId: 'orphan-run-a',
  idempotencyKey: 'orphan-idempotency-a',
  workflowId: 'orphan-workflow-a',
  leaseToken: 'orphan-lease-a',
})

const store = (state: 'started' | 'adopted' = 'started'): OrphanScheduleStore => ({
  claimScheduledTasks: () => Effect.succeed([]),
  beginWorkflow: () => Effect.succeed(state),
  assertExecutionLease: () => Effect.void,
  complete: () => Effect.succeed('completed'),
})

describe('orphan reconciliation queue workflow adoption', () => {
  it('starts the exact deterministic Workflow only after its D1 lease has begun', async () => {
    const calls: unknown[] = []
    const workflow: OrphanWorkflowBinding = {
      create: async (input) => {
        calls.push(input)
        return { id: input.id }
      },
      get: async (id) => ({ id }),
    }

    await expect(startOrAdoptOrphanWorkflow(task, store(), workflow)).resolves.toBe('started')
    expect(calls).toEqual([{ id: task.workflowId, params: task }])
  })

  it('adopts an existing deterministic Workflow after a create response is lost', async () => {
    let getCalls = 0
    const workflow: OrphanWorkflowBinding = {
      create: async () => {
        throw new Error('response lost after Workflow creation')
      },
      get: async (id) => {
        getCalls += 1
        return { id }
      },
    }

    await expect(startOrAdoptOrphanWorkflow(task, store(), workflow)).resolves.toBe('adopted')
    expect(getCalls).toBe(1)
  })

  it('rejects a forged tenant payload before it can claim a lease or create a Workflow', async () => {
    let leaseAttempts = 0
    let creates = 0
    const forgedStore: OrphanScheduleStore = {
      ...store(),
      beginWorkflow: () => {
        leaseAttempts += 1
        return Effect.succeed('started')
      },
    }
    const workflow: OrphanWorkflowBinding = {
      create: async (input) => {
        creates += 1
        return { id: input.id }
      },
      get: async (id) => ({ id }),
    }

    await expect(
      startOrAdoptOrphanWorkflow(
        { ...task, organizationId: 'org-b', providerCredential: 'must-not-enter-a-workflow' },
        forgedStore,
        workflow,
      ),
    ).rejects.toBeDefined()
    expect(leaseAttempts).toBe(0)
    expect(creates).toBe(0)
  })
})

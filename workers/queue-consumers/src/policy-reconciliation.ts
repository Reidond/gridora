import { Effect } from 'effect'
import {
  decodePolicyScheduleTask,
  makePolicyScheduleStore,
  PolicyScheduleError,
  type PolicyScheduleD1Database,
  type PolicyScheduleStore,
  type PolicyScheduleTask,
} from '@gridora/policy-schedule'

export interface PolicyReconciliationWorkflowBinding {
  create(options: {
    readonly id: string
    readonly params: PolicyScheduleTask
  }): Promise<{ readonly id: string }>
  get(id: string): Promise<{ readonly id: string }>
}

export interface PolicyReconciliationQueueBinding {
  send(message: PolicyScheduleTask, options: { readonly contentType: 'json' }): Promise<unknown>
}

const terminalScheduleError = (error: unknown): boolean =>
  error instanceof PolicyScheduleError &&
  (error.code === 'invalid-task' ||
    error.code === 'invalid-scope' ||
    error.code === 'lease-expired' ||
    error.code === 'idempotency-conflict')

/**
 * A D1 lease changes to running before the native Workflow call. A response
 * loss can therefore adopt only the same deterministic Workflow identifier.
 */
export const startOrAdoptPolicyReconciliationWorkflow = async (
  input: unknown,
  store: PolicyScheduleStore,
  workflow: PolicyReconciliationWorkflowBinding,
): Promise<'started' | 'adopted'> => {
  const task = await Effect.runPromise(decodePolicyScheduleTask(input))
  const state = await Effect.runPromise(store.beginWorkflow(task))
  try {
    const created = await workflow.create({ id: task.workflowId, params: task })
    if (created.id !== task.workflowId) throw new Error('Workflow identity mismatch')
    return state === 'adopted' ? 'adopted' : 'started'
  } catch (createError) {
    try {
      const adopted = await workflow.get(task.workflowId)
      if (adopted.id !== task.workflowId) throw new Error('Workflow identity mismatch')
      return 'adopted'
    } catch {
      throw createError
    }
  }
}

/** Bounded D1 selection happens before a credential-free queue payload is emitted. */
export const schedulePolicyReconciliations = async (
  database: PolicyScheduleD1Database,
  queue: PolicyReconciliationQueueBinding,
  scheduledAt: number,
): Promise<number> => {
  const tasks = await Effect.runPromise(
    makePolicyScheduleStore(database).claimScheduledTasks(new Date(scheduledAt).toISOString()),
  )
  await Promise.all(tasks.map((task) => queue.send(task, { contentType: 'json' })))
  return tasks.length
}

export type PolicyReconciliationMessageDisposition =
  | {
      readonly disposition: 'ack'
      readonly reason: 'invalid-task' | 'terminal' | 'started' | 'adopted'
    }
  | { readonly disposition: 'retry'; readonly reason: 'unavailable' }

/**
 * A malformed or stale message is terminal and cannot become an unbounded
 * tenant scan. A transient D1 or Workflow error retains the exact message.
 */
export const processPolicyReconciliationMessage = async (
  database: PolicyScheduleD1Database,
  workflow: PolicyReconciliationWorkflowBinding,
  input: unknown,
): Promise<PolicyReconciliationMessageDisposition> => {
  const decoded = await Effect.runPromise(Effect.result(decodePolicyScheduleTask(input)))
  if (decoded._tag === 'Failure') return { disposition: 'ack', reason: 'invalid-task' }
  const started = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          startOrAdoptPolicyReconciliationWorkflow(
            decoded.success,
            makePolicyScheduleStore(database),
            workflow,
          ),
        catch: (cause) => cause,
      }),
    ),
  )
  if (started._tag === 'Failure')
    return terminalScheduleError(started.failure)
      ? { disposition: 'ack', reason: 'terminal' }
      : { disposition: 'retry', reason: 'unavailable' }
  return {
    disposition: 'ack',
    reason: started.success === 'adopted' ? 'adopted' : 'started',
  }
}

export { terminalScheduleError as isTerminalPolicyScheduleError }

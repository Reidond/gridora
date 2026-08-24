import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { executePlan, OperationStepError, type OperationPlan } from './index.js'
describe('operation compensation', () => {
  it('compensates completed steps in reverse order', async () => {
    const log: string[] = []
    const context = {
      organizationId: 'o',
      operationId: 'op',
      resourceId: 'r',
      actorId: 'a',
      correlationId: 'c',
    }
    const plan: OperationPlan = {
      kind: 'deploy-server',
      context,
      cancellation: 'between-steps',
      summary: [],
      steps: [
        {
          id: 'reserve',
          description: '',
          destructive: false,
          run: () => Effect.succeed('lease'),
          compensate: () =>
            Effect.sync(() => {
              log.push('release')
            }),
        },
        {
          id: 'install',
          description: '',
          destructive: false,
          run: () =>
            Effect.fail(
              new OperationStepError({ stepId: 'install', message: 'failed', retryable: false }),
            ),
        },
      ],
    }
    const result = await Effect.runPromise(Effect.result(executePlan(plan)))
    expect(result._tag).toBe('Failure')
    expect(log).toEqual(['release'])
  })
})

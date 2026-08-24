import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  makeCancellationSignal,
  type CancellationRuntimeBindings,
} from '../src/cancellation-runtime.js'

const input = {
  organizationId: 'org-a',
  operationId: 'operation-a',
  resourceType: 'game-server',
  resourceId: 'server-a',
  resourceOperationDoName: 'resource-operation:org-a:game-server:server-a',
  workflowBinding: 'BACKUP_GAME_SERVER',
  workflowType: 'BackupGameServerWorkflow',
  workflowInstanceId: 'operation-a',
} as const

describe('production cancellation signal', () => {
  it('signals the exact stored DO and adopts a lost Workflow terminate response only from terminal status', async () => {
    const calls: unknown[] = []
    const instance = {
      terminate: async () => {
        calls.push('terminate')
        throw new Error('response lost')
      },
      status: async () => ({ status: 'terminated' as const }),
    }
    const workflow = { get: async (id: string) => (calls.push(['get', id]), instance) }
    const env = {
      RESOURCE_OPERATION: {
        getByName: (name: string) => ({
          requestCancellation: async (
            organizationId: string,
            resourceId: string,
            operationId: string,
          ) => {
            calls.push(['resource', name, organizationId, resourceId, operationId])
            return true
          },
        }),
      },
      BACKUP_GAME_SERVER: workflow,
    } as unknown as CancellationRuntimeBindings

    await expect(Effect.runPromise(makeCancellationSignal(env).signal(input))).resolves.toEqual({
      resourceOperationSignalled: true,
      workflowSignalled: true,
    })
    expect(calls).toContainEqual([
      'resource',
      input.resourceOperationDoName,
      input.organizationId,
      input.resourceId,
      input.operationId,
    ])
    expect(calls).toContainEqual(['get', input.workflowInstanceId])
  })

  it('fails closed when the persisted binding/type pair does not match', async () => {
    const env = {
      RESOURCE_OPERATION: {
        getByName: () => ({ requestCancellation: async () => true }),
      },
      BACKUP_GAME_SERVER: {
        get: async () => {
          throw new Error('must not run')
        },
      },
    } as unknown as CancellationRuntimeBindings
    const receipt = await Effect.runPromise(
      makeCancellationSignal(env).signal({ ...input, workflowType: 'RestoreGameServerWorkflow' }),
    )
    expect(receipt.workflowSignalled).toBe(false)
  })
})

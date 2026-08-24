import { Effect } from 'effect'
import {
  makeTerminationControl,
  type CancellationSignalInput,
  type OperationCancellationSignalShape,
  type TerminationControlShape,
} from '@gridora/lifecycle-termination-control'
import { makeTerminationD1Repository } from '@gridora/lifecycle-termination-d1'
import { makeExactCancellationSignal } from '@gridora/lifecycle-termination-workflow'
import type { ResourceOperationDO } from '@gridora/realtime'

type CancellationWorkflow = Pick<Workflow<unknown>, 'get'>

export interface CancellationRuntimeBindings {
  readonly DB: D1Database
  readonly RESOURCE_OPERATION: DurableObjectNamespace<ResourceOperationDO>
  readonly DELETE_ORGANIZATION: CancellationWorkflow
  readonly PROVISION_NODE: CancellationWorkflow
  readonly REBUILD_NODE: CancellationWorkflow
  readonly RETIRE_NODE: CancellationWorkflow
  readonly DRAIN_NODE?: CancellationWorkflow
  readonly LEAVE_DRAIN_NODE?: CancellationWorkflow
  readonly NODE_RUNTIME_LIFECYCLE?: CancellationWorkflow
  readonly DEPLOY_GAME_SERVER: CancellationWorkflow
  readonly START_GAME_SERVER?: CancellationWorkflow
  readonly STOP_GAME_SERVER?: CancellationWorkflow
  readonly RESTART_GAME_SERVER?: CancellationWorkflow
  readonly UPDATE_GAME_SERVER: CancellationWorkflow
  readonly APPLY_GAME_CONFIG: CancellationWorkflow
  readonly SYNC_MODS: CancellationWorkflow
  readonly BACKUP_GAME_SERVER: CancellationWorkflow
  readonly RESTORE_GAME_SERVER: CancellationWorkflow
  readonly MOVE_GAME_SERVER: CancellationWorkflow
  readonly DELETE_GAME_SERVER: CancellationWorkflow
  readonly REGISTER_PROVIDER_IMAGE: CancellationWorkflow
  readonly RECONCILE_ORPHAN: CancellationWorkflow
}

const workflowTarget = (binding: CancellationWorkflow, workflowType: string) => ({
  workflowType,
  requestCancellation: async (input: {
    readonly operationId: string
    readonly workflowInstanceId: string
    readonly workflowType: string
  }) => {
    if (input.workflowType !== workflowType) return { ...input, accepted: false }
    const instance = await binding.get(input.workflowInstanceId)
    let accepted = false
    try {
      await instance.terminate({ rollback: true })
      accepted = true
    } catch {
      // A lost termination response is adopted only when the exact instance now proves terminal.
      accepted = (await instance.status()).status === 'terminated'
    }
    return { ...input, accepted }
  },
})

export const makeCancellationSignal = (
  env: CancellationRuntimeBindings,
): OperationCancellationSignalShape => {
  const workflow = (binding: CancellationWorkflow | undefined, workflowType: string) =>
    binding === undefined ? undefined : workflowTarget(binding, workflowType)
  const targets: Record<string, ReturnType<typeof workflowTarget>> = {}
  for (const [name, target] of [
    ['DELETE_ORGANIZATION', workflow(env.DELETE_ORGANIZATION, 'DeleteOrganizationWorkflow')],
    ['PROVISION_NODE', workflow(env.PROVISION_NODE, 'ProvisionNodeWorkflow')],
    ['REBUILD_NODE', workflow(env.REBUILD_NODE, 'RebuildNodeWorkflow')],
    ['RETIRE_NODE', workflow(env.RETIRE_NODE, 'RetireNodeWorkflow')],
    ['DRAIN_NODE', workflow(env.DRAIN_NODE, 'DrainNodeWorkflow')],
    ['LEAVE_DRAIN_NODE', workflow(env.LEAVE_DRAIN_NODE, 'LeaveDrainNodeWorkflow')],
    [
      'NODE_RUNTIME_LIFECYCLE',
      workflow(env.NODE_RUNTIME_LIFECYCLE, 'NodeRuntimeLifecycleWorkflow'),
    ],
    ['DEPLOY_GAME_SERVER', workflow(env.DEPLOY_GAME_SERVER, 'DeployGameServerWorkflow')],
    ['START_GAME_SERVER', workflow(env.START_GAME_SERVER, 'StartGameServerWorkflow')],
    ['STOP_GAME_SERVER', workflow(env.STOP_GAME_SERVER, 'StopGameServerWorkflow')],
    ['RESTART_GAME_SERVER', workflow(env.RESTART_GAME_SERVER, 'RestartGameServerWorkflow')],
    ['UPDATE_GAME_SERVER', workflow(env.UPDATE_GAME_SERVER, 'UpdateGameServerWorkflow')],
    ['APPLY_GAME_CONFIG', workflow(env.APPLY_GAME_CONFIG, 'ApplyGameConfigWorkflow')],
    ['SYNC_MODS', workflow(env.SYNC_MODS, 'SyncModsWorkflow')],
    ['BACKUP_GAME_SERVER', workflow(env.BACKUP_GAME_SERVER, 'BackupGameServerWorkflow')],
    ['RESTORE_GAME_SERVER', workflow(env.RESTORE_GAME_SERVER, 'RestoreGameServerWorkflow')],
    ['MOVE_GAME_SERVER', workflow(env.MOVE_GAME_SERVER, 'MoveGameServerWorkflow')],
    ['DELETE_GAME_SERVER', workflow(env.DELETE_GAME_SERVER, 'DeleteGameServerWorkflow')],
    [
      'REGISTER_PROVIDER_IMAGE',
      workflow(env.REGISTER_PROVIDER_IMAGE, 'RegisterProviderImageWorkflow'),
    ],
    ['RECONCILE_ORPHAN', workflow(env.RECONCILE_ORPHAN, 'ReconcileOrphanWorkflow')],
  ] as const)
    if (target !== undefined) targets[name] = target
  return makeExactCancellationSignal(
    {
      requestCancellation: async (input) => {
        const accepted = await env.RESOURCE_OPERATION.getByName(
          input.resourceOperationDoName,
        ).requestCancellation(input.organizationId, input.resourceId, input.operationId)
        return { ...input, accepted }
      },
    },
    targets,
  )
}

export const makeCancellationControl = (
  env: CancellationRuntimeBindings,
): TerminationControlShape =>
  makeTerminationControl(makeTerminationD1Repository(env.DB), makeCancellationSignal(env))

export const signalCancellation = (
  env: CancellationRuntimeBindings,
  input: CancellationSignalInput,
) => makeCancellationSignal(env).signal(input).pipe(Effect.orDie)

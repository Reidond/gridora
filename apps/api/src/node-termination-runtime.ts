import { Effect } from 'effect'
import {
  TerminationWorkflowStartError,
  type NodeLifecycleAcceptance,
} from '@gridora/lifecycle-termination-control'
import {
  makeTerminationWorkflowStartD1Repository,
  type LifecycleTerminationD1Database,
} from '@gridora/lifecycle-termination-d1'

export interface NodeTerminationWorkflowParams {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: 'node'
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: Readonly<{
    action: 'drain-node' | 'leave-drain' | 'rebuild-node' | 'retire-node'
    workflowStartRecordId: string
    requestFingerprint: string
  }>
}

export interface NodeTerminationWorkflowBinding {
  readonly create: (options: {
    readonly id: string
    readonly params: NodeTerminationWorkflowParams
  }) => Promise<{ readonly id: string }>
  readonly get: (id: string) => Promise<{ readonly id: string }>
}

export interface NodeTerminationWorkflowBindings {
  readonly DRAIN_NODE: NodeTerminationWorkflowBinding
  readonly LEAVE_DRAIN_NODE: NodeTerminationWorkflowBinding
  readonly REBUILD_NODE: NodeTerminationWorkflowBinding
  readonly RETIRE_NODE: NodeTerminationWorkflowBinding
}

export type NodeTerminationRuntimeDatabase = LifecycleTerminationD1Database

type WorkflowSelection = {
  readonly binding: keyof NodeTerminationWorkflowBindings
  readonly workflowType:
    | 'DrainNodeWorkflow'
    | 'LeaveDrainNodeWorkflow'
    | 'RebuildNodeWorkflow'
    | 'RetireNodeWorkflow'
}

const workflowFor = (action: string): WorkflowSelection | undefined => {
  switch (action) {
    case 'drain-node':
      return { binding: 'DRAIN_NODE', workflowType: 'DrainNodeWorkflow' }
    case 'leave-drain':
      return { binding: 'LEAVE_DRAIN_NODE', workflowType: 'LeaveDrainNodeWorkflow' }
    case 'rebuild-node':
      return { binding: 'REBUILD_NODE', workflowType: 'RebuildNodeWorkflow' }
    case 'retire-node':
      return { binding: 'RETIRE_NODE', workflowType: 'RetireNodeWorkflow' }
    default:
      return undefined
  }
}

const row = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (value: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof value?.[key] === 'string' ? (value[key] as string) : undefined

const exactStartRow = (
  database: NodeTerminationRuntimeDatabase,
  acceptance: NodeLifecycleAcceptance,
) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT operation.id AS operationId, operation.organization_id AS organizationId,
          operation.resource_id AS nodeId, operation.actor_id AS actorId,
          operation.correlation_id AS correlationId, operation.idempotency_key AS idempotencyKey,
          lifecycle.action AS action, lifecycle.request_fingerprint AS requestFingerprint,
          start.start_record_id AS startRecordId, start.workflow_type AS workflowType,
          start.workflow_instance_id AS workflowInstanceId, start.params_fingerprint AS paramsFingerprint,
          start.state AS startState
        FROM operations operation
        JOIN destructive_lifecycle_operations lifecycle
          ON lifecycle.organization_id = operation.organization_id AND lifecycle.operation_id = operation.id
        JOIN termination_workflow_starts start
          ON start.organization_id = operation.organization_id AND start.operation_id = operation.id
        JOIN node_lifecycle_runs run
          ON run.organization_id = operation.organization_id AND run.operation_id = operation.id
        WHERE operation.organization_id = ? AND operation.id = ? AND run.node_id = ?`)
        .bind(acceptance.operation.organizationId, acceptance.operation.id, acceptance.nodeId)
        .first(),
    catch: () =>
      new TerminationWorkflowStartError({
        operationId: acceptance.operation.id,
        code: 'durable_start_record_unavailable',
      }),
  })

const validateStartRow = (
  value: unknown,
  acceptance: NodeLifecycleAcceptance,
): Effect.Effect<
  { readonly selection: WorkflowSelection; readonly params: NodeTerminationWorkflowParams },
  TerminationWorkflowStartError
> =>
  Effect.sync(() => {
    const found = row(value)
    const selection = workflowFor(text(found, 'action') ?? '')
    const operationId = text(found, 'operationId')
    const organizationId = text(found, 'organizationId')
    const nodeId = text(found, 'nodeId')
    const actorId = text(found, 'actorId')
    const correlationId = text(found, 'correlationId')
    const idempotencyKey = text(found, 'idempotencyKey')
    const requestFingerprint = text(found, 'requestFingerprint')
    const startRecordId = text(found, 'startRecordId')
    const workflowType = text(found, 'workflowType')
    const workflowInstanceId = text(found, 'workflowInstanceId')
    const paramsFingerprint = text(found, 'paramsFingerprint')
    const state = text(found, 'startState')
    if (
      selection === undefined ||
      operationId !== acceptance.operation.id ||
      organizationId !== acceptance.operation.organizationId ||
      nodeId !== acceptance.nodeId ||
      actorId === undefined ||
      correlationId === undefined ||
      idempotencyKey === undefined ||
      requestFingerprint === undefined ||
      startRecordId !== acceptance.workflowStart.id ||
      workflowType !== selection.workflowType ||
      workflowInstanceId !== acceptance.operation.id ||
      paramsFingerprint !== requestFingerprint ||
      (state !== 'pending' && state !== 'started' && state !== 'adopted')
    )
      throw new Error('node termination Workflow start facts do not match acceptance')
    const params: NodeTerminationWorkflowParams = {
      operationId,
      organizationId,
      resourceId: nodeId,
      resourceType: 'node',
      actorId,
      correlationId,
      idempotencyKey,
      input: {
        action: text(found, 'action') as NodeTerminationWorkflowParams['input']['action'],
        workflowStartRecordId: startRecordId,
        requestFingerprint,
      },
    }
    return {
      selection,
      params,
    }
  }).pipe(
    Effect.mapError(
      () =>
        new TerminationWorkflowStartError({
          operationId: acceptance.operation.id,
          code: 'workflow_start_binding_mismatch',
        }),
    ),
  )

const timestamp = () => new Date().toISOString()

/**
 * Native Workflows expose only their fixed instance ID on a later `get`. The
 * exact action, binding, and parameter fingerprint are therefore proved from
 * the acceptance transaction before create or adoption is attempted.
 */
export const makeNodeTerminationWorkflowStarter = (
  database: NodeTerminationRuntimeDatabase,
  bindings: NodeTerminationWorkflowBindings,
) => ({
  start: (
    acceptance: NodeLifecycleAcceptance,
  ): Effect.Effect<'started' | 'adopted', TerminationWorkflowStartError> =>
    Effect.gen(function* () {
      const authoritative = yield* exactStartRow(database, acceptance).pipe(
        Effect.flatMap((found) => validateStartRow(found, acceptance)),
      )
      const startRepository = makeTerminationWorkflowStartD1Repository(database)
      const mark = (state: 'started' | 'adopted') =>
        startRepository
          .markStartedOrAdopted({
            organizationId: authoritative.params.organizationId,
            operationId: authoritative.params.operationId,
            startRecordId: authoritative.params.input.workflowStartRecordId,
            state,
            now: timestamp(),
          })
          .pipe(
            Effect.mapError(
              () =>
                new TerminationWorkflowStartError({
                  operationId: acceptance.operation.id,
                  code: 'workflow_start_evidence_not_persisted',
                }),
            ),
          )
      const binding = bindings[authoritative.selection.binding]
      const created = yield* Effect.result(
        Effect.tryPromise({
          try: () => binding.create({ id: acceptance.operation.id, params: authoritative.params }),
          catch: () => new Error('Workflow create response is unavailable'),
        }),
      )
      if (created._tag === 'Success') {
        if (created.success.id !== acceptance.operation.id)
          return yield* new TerminationWorkflowStartError({
            operationId: acceptance.operation.id,
            code: 'workflow_create_identity_mismatch',
          })
        yield* mark('started')
        return 'started' as const
      }
      const adopted = yield* Effect.result(
        Effect.tryPromise({
          try: () => binding.get(acceptance.operation.id),
          catch: () => new Error('Workflow adoption lookup is unavailable'),
        }),
      )
      if (adopted._tag === 'Success' && adopted.success.id === acceptance.operation.id) {
        yield* mark('adopted')
        return 'adopted' as const
      }
      yield* startRepository
        .recordStartFailure({
          organizationId: authoritative.params.organizationId,
          operationId: authoritative.params.operationId,
          startRecordId: authoritative.params.input.workflowStartRecordId,
          code: 'workflow_start_pending_reconciliation',
          now: timestamp(),
        })
        .pipe(Effect.ignore)
      return yield* new TerminationWorkflowStartError({
        operationId: acceptance.operation.id,
        code: 'workflow_start_pending_reconciliation',
      })
    }),
})

/**
 * Starts or adopts a retirement accepted by the organization-deletion
 * coordinator. The authoritative D1 start record must name RetireNodeWorkflow;
 * callers cannot substitute a cancellation-only or differently typed binding.
 */
export const startRetireNodeWorkflow = (
  database: NodeTerminationRuntimeDatabase,
  binding: NodeTerminationWorkflowBinding,
  acceptance: NodeLifecycleAcceptance,
): Effect.Effect<'started' | 'adopted', TerminationWorkflowStartError> =>
  Effect.gen(function* () {
    const authoritative = yield* exactStartRow(database, acceptance).pipe(
      Effect.flatMap((found) => validateStartRow(found, acceptance)),
    )
    if (authoritative.selection.binding !== 'RETIRE_NODE')
      return yield* new TerminationWorkflowStartError({
        operationId: acceptance.operation.id,
        code: 'workflow_start_binding_mismatch',
      })
    return yield* makeNodeTerminationWorkflowStarter(database, {
      DRAIN_NODE: binding,
      LEAVE_DRAIN_NODE: binding,
      REBUILD_NODE: binding,
      RETIRE_NODE: binding,
    }).start(acceptance)
  })

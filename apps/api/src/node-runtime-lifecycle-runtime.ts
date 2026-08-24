import { Effect, Schema } from 'effect'
import {
  NodeRuntimeLifecycleWorkflowStartError,
  makeNodeRuntimeLifecycleControl,
  makeWebCryptoNodeRuntimeLifecycleIdentity,
  type NodeRuntimeLifecycleAcceptance,
  type NodeRuntimeLifecycleControlShape,
  type NodeRuntimeLifecycleWorkflowStarterShape,
} from '@gridora/node-runtime-lifecycle-control'
import {
  makeNodeRuntimeLifecycleExecutionRepositoryD1,
  makeNodeRuntimeLifecycleRepositoryD1,
  type NodeRuntimeLifecycleD1Database,
} from '@gridora/node-runtime-lifecycle-d1'
import {
  makeNodeRuntimeLifecycleExecution,
  webCryptoNodeRuntimeLifecycleLeaseTokens,
} from '@gridora/node-runtime-lifecycle-execution'
import type {
  ProviderNodeLifecycleAdapterResolverShape,
  ProviderNodeLifecycleTransportShape,
} from '@gridora/provider-node-lifecycle-transports'
import { makeProviderNodeLifecycleTransport } from '@gridora/provider-node-lifecycle-transports'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'

export interface NodeRuntimeLifecycleWorkflowParams {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: 'node'
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: Readonly<{
    action: 'start' | 'stop' | 'reboot' | 'reconcile'
    workflowStartRecordId: string
    requestFingerprint: string
  }>
}

/**
 * Worker-only input. The API still reloads the accepted execution from D1 and
 * rejects a result whose node/action facts do not match this signed route.
 */
export const NodeRuntimeLifecycleWorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.Literal('node'),
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Struct({
    action: Schema.Literals(['start', 'stop', 'reboot', 'reconcile']),
    workflowStartRecordId: Schema.String,
    requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  stepName: Schema.String,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type NodeRuntimeLifecycleWorkflowPayload = typeof NodeRuntimeLifecycleWorkflowPayload.Type

export interface NodeRuntimeLifecycleWorkflowBinding {
  readonly create: (input: {
    readonly id: string
    readonly params: NodeRuntimeLifecycleWorkflowParams
  }) => Promise<{ readonly id: string }>
  readonly get: (id: string) => Promise<{ readonly id: string }>
}

export interface NodeRuntimeLifecycleRuntimeBindings {
  readonly DB: NodeRuntimeLifecycleD1Database
  readonly NODE_RUNTIME_LIFECYCLE: NodeRuntimeLifecycleWorkflowBinding
}

export interface NodeRuntimeLifecycleWorkflowExecutionResult {
  readonly status: 'completed' | 'adopted' | 'waiting'
  readonly terminal: boolean
  readonly operationState:
    | 'succeeded'
    | 'waiting-observation'
    | 'reconciliation-required'
    | 'failed-terminal'
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const text = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined => (typeof value?.[key] === 'string' ? (value[key] as string) : undefined)

const authoritativeStartRow = (
  database: NodeRuntimeLifecycleD1Database,
  acceptance: NodeRuntimeLifecycleAcceptance,
) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT operation.id AS operationId, operation.organization_id AS organizationId,
          operation.resource_id AS nodeId, operation.actor_id AS actorId,
          operation.correlation_id AS correlationId, operation.idempotency_key AS idempotencyKey,
          execution.action AS action, start.start_record_id AS startRecordId,
          start.workflow_type AS workflowType, start.workflow_instance_id AS workflowInstanceId,
          start.params_fingerprint AS requestFingerprint, start.state AS startState
        FROM operations operation
        JOIN node_runtime_lifecycle_workflow_starts start
          ON start.organization_id = operation.organization_id AND start.operation_id = operation.id
        JOIN node_runtime_lifecycle_executions execution
          ON execution.organization_id = operation.organization_id AND execution.operation_id = operation.id
        WHERE operation.organization_id = ? AND operation.id = ? AND execution.node_id = ?`)
        .bind(acceptance.organizationId, acceptance.operationId, acceptance.nodeId)
        .first(),
    catch: () =>
      new NodeRuntimeLifecycleWorkflowStartError({
        operationId: acceptance.operationId,
        message: 'Authoritative runtime Workflow start state is unavailable',
      }),
  })

const paramsFor = (
  value: unknown,
  acceptance: NodeRuntimeLifecycleAcceptance,
): Effect.Effect<NodeRuntimeLifecycleWorkflowParams, NodeRuntimeLifecycleWorkflowStartError> =>
  Effect.sync(() => {
    const found = record(value)
    const operationId = text(found, 'operationId')
    const organizationId = text(found, 'organizationId')
    const nodeId = text(found, 'nodeId')
    const actorId = text(found, 'actorId')
    const correlationId = text(found, 'correlationId')
    const idempotencyKey = text(found, 'idempotencyKey')
    const action = text(found, 'action')
    const startRecordId = text(found, 'startRecordId')
    const workflowType = text(found, 'workflowType')
    const workflowInstanceId = text(found, 'workflowInstanceId')
    const requestFingerprint = text(found, 'requestFingerprint')
    const state = text(found, 'startState')
    if (
      operationId !== acceptance.operationId ||
      organizationId !== acceptance.organizationId ||
      nodeId !== acceptance.nodeId ||
      actorId === undefined ||
      correlationId === undefined ||
      idempotencyKey === undefined ||
      (action !== 'start' && action !== 'stop' && action !== 'reboot' && action !== 'reconcile') ||
      action !== acceptance.action ||
      startRecordId !== acceptance.workflowStart.id ||
      workflowType !== 'NodeRuntimeLifecycleWorkflow' ||
      workflowInstanceId !== acceptance.operationId ||
      requestFingerprint !== acceptance.fingerprint ||
      (state !== 'pending' && state !== 'started' && state !== 'adopted')
    )
      throw new Error('runtime Workflow start facts do not match acceptance')
    return {
      operationId,
      organizationId,
      resourceId: nodeId,
      resourceType: 'node' as const,
      actorId,
      correlationId,
      idempotencyKey,
      input: {
        action: action as NodeRuntimeLifecycleWorkflowParams['input']['action'],
        workflowStartRecordId: startRecordId,
        requestFingerprint,
      },
    }
  }).pipe(
    Effect.mapError(
      () =>
        new NodeRuntimeLifecycleWorkflowStartError({
          operationId: acceptance.operationId,
          message: 'Authoritative runtime Workflow start facts do not match the acceptance',
        }),
    ),
  )

/**
 * The D1 acceptance is the parameter authority.  A native Workflow response
 * loss is adopted only by its immutable instance ID; no retry can select a
 * new provider, node, action, or credential revision.
 */
export const makeNodeRuntimeLifecycleWorkflowStarter = (
  bindings: NodeRuntimeLifecycleRuntimeBindings,
): NodeRuntimeLifecycleWorkflowStarterShape => ({
  start: (acceptance) =>
    Effect.gen(function* () {
      const params = yield* authoritativeStartRow(bindings.DB, acceptance).pipe(
        Effect.flatMap((found) => paramsFor(found, acceptance)),
      )
      const repository = makeNodeRuntimeLifecycleRepositoryD1(bindings.DB)
      const markStarted = (state: 'started' | 'adopted') =>
        state === 'started'
          ? repository.markWorkflowStarted(params.organizationId, params.operationId)
          : repository.markWorkflowAdopted(params.organizationId, params.operationId)
      const persistStart = (state: 'started' | 'adopted') =>
        markStarted(state).pipe(
          Effect.mapError(
            () =>
              new NodeRuntimeLifecycleWorkflowStartError({
                operationId: params.operationId,
                message: 'Native runtime Workflow start evidence could not be persisted',
              }),
          ),
        )
      const created = yield* Effect.result(
        Effect.tryPromise({
          try: () => bindings.NODE_RUNTIME_LIFECYCLE.create({ id: params.operationId, params }),
          catch: () =>
            new NodeRuntimeLifecycleWorkflowStartError({
              operationId: params.operationId,
              message: 'Native runtime Workflow create response is unavailable',
            }),
        }),
      )
      if (created._tag === 'Success') {
        if (created.success.id !== params.operationId)
          return yield* new NodeRuntimeLifecycleWorkflowStartError({
            operationId: params.operationId,
            message: 'Native runtime Workflow identity does not match the acceptance',
          })
        yield* persistStart('started')
        return
      }
      const adopted = yield* Effect.result(
        Effect.tryPromise({
          try: () => bindings.NODE_RUNTIME_LIFECYCLE.get(params.operationId),
          catch: () => created.failure,
        }),
      )
      if (adopted._tag === 'Success' && adopted.success.id === params.operationId) {
        yield* persistStart('adopted')
        return
      }
      yield* repository
        .recordWorkflowStartFailure(
          params.organizationId,
          params.operationId,
          'native_workflow_start_pending_reconciliation',
        )
        .pipe(Effect.ignore)
      return yield* new NodeRuntimeLifecycleWorkflowStartError({
        operationId: params.operationId,
        message: 'Native runtime Workflow start requires reconciliation',
      })
    }),
})

export const makeNodeRuntimeLifecycleControlRuntime = (input: {
  readonly bindings: NodeRuntimeLifecycleRuntimeBindings
  readonly auditRequestContext: AuditRequestContextValue
  readonly resolver: ProviderNodeLifecycleAdapterResolverShape
}): NodeRuntimeLifecycleControlShape => {
  const transport = makeNodeRuntimeLifecycleProviderTransport(input.resolver)
  return makeNodeRuntimeLifecycleControl({
    repository: makeNodeRuntimeLifecycleRepositoryD1(input.bindings.DB, {
      auditRequestContext: input.auditRequestContext,
    }),
    capabilities: transport,
    identities: makeWebCryptoNodeRuntimeLifecycleIdentity(),
    clock: { now: Effect.sync(() => ({ iso: new Date().toISOString() })) },
    workflows: makeNodeRuntimeLifecycleWorkflowStarter(input.bindings),
  })
}

export const makeNodeRuntimeLifecycleProviderTransport = (
  resolver: ProviderNodeLifecycleAdapterResolverShape,
): ProviderNodeLifecycleTransportShape =>
  makeProviderNodeLifecycleTransport({
    capabilities: {
      ovhcloud: { start: true, stop: true, reboot: true, observe: true },
      contabo: { start: true, stop: true, reboot: true, observe: true },
    },
    resolver,
  })

/**
 * Executes only the D1-accepted runtime operation. A retry after a provider
 * delivery uncertainty is observation-only inside the execution package, so
 * a Workflow restart cannot issue a second start/stop/reboot request.
 */
export const executeNodeRuntimeLifecycleWorkflow = (input: {
  readonly bindings: NodeRuntimeLifecycleRuntimeBindings
  readonly resolver: ProviderNodeLifecycleAdapterResolverShape
  readonly payload: NodeRuntimeLifecycleWorkflowPayload
  readonly attemptedAt: string
}): Effect.Effect<
  NodeRuntimeLifecycleWorkflowExecutionResult,
  import('@gridora/node-runtime-lifecycle-execution').NodeRuntimeLifecycleExecutionError
> =>
  Effect.gen(function* () {
    const execution = makeNodeRuntimeLifecycleExecution({
      repository: makeNodeRuntimeLifecycleExecutionRepositoryD1(input.bindings.DB),
      transport: makeNodeRuntimeLifecycleProviderTransport(input.resolver),
      leaseTokens: webCryptoNodeRuntimeLifecycleLeaseTokens,
    })
    const outcome = yield* execution.execute({
      organizationId: input.payload.organizationId,
      operationId: input.payload.operationId,
      leaseOwner: 'node-runtime-workflow',
      attemptedAt: input.attemptedAt,
    })
    if (outcome.disposition === 'in-progress')
      return {
        status: 'waiting' as const,
        terminal: false,
        operationState: 'waiting-observation' as const,
      }
    const result = outcome.result
    if (
      result.organizationId !== input.payload.organizationId ||
      result.operationId !== input.payload.operationId ||
      result.nodeId !== input.payload.resourceId ||
      result.action !== input.payload.input.action
    )
      return yield* Effect.die(
        new Error('node runtime Workflow result does not match the accepted route'),
      )
    const terminal =
      result.state === 'succeeded' ||
      result.state === 'reconciliation-required' ||
      result.state === 'failed-terminal'
    return {
      status:
        result.state === 'succeeded'
          ? outcome.disposition === 'adopted'
            ? ('adopted' as const)
            : ('completed' as const)
          : ('waiting' as const),
      terminal,
      operationState: result.state,
    }
  })

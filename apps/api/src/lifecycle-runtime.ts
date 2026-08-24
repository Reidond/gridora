import { Effect, Layer } from 'effect'
import {
  canonicalCommandFingerprint,
  LifecycleControl,
  LifecycleControlLive,
  LifecycleRepository,
  PolicyAdmission,
  PolicyDeniedError,
  WorkflowStarter,
  WorkflowStartError,
  WorkflowStartReconciliationRepository,
  baselinePolicyAdmission,
  type PolicyAdmissionShape,
  type LifecycleCommand,
  type WorkflowStarterShape,
} from '@gridora/lifecycle-control'
import {
  LifecycleD1ClientLayer,
  LifecycleD1RepositoryLive,
  WorkflowStartReconciliationD1Live,
  type LifecycleD1Database,
  type LifecycleD1Options,
} from '@gridora/lifecycle-d1'
export interface NativeLifecycleWorkflowParams {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: 'node' | 'server'
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: Readonly<Record<string, unknown>>
}

export interface NativeLifecycleWorkflowBinding {
  readonly create: (options: {
    readonly id: string
    readonly params: NativeLifecycleWorkflowParams
  }) => Promise<{ readonly id: string }>
  readonly get: (id: string) => Promise<{ readonly id: string }>
}

/**
 * Only these reviewed action-to-binding relationships may be selected by the API root.
 * Binding identifiers never enter a request, response, operation fingerprint, or error.
 */
export interface LifecycleWorkflowBindings {
  readonly provisionNode: NativeLifecycleWorkflowBinding
  readonly retireNode: NativeLifecycleWorkflowBinding
  readonly deployServer: NativeLifecycleWorkflowBinding
  readonly configureServer: NativeLifecycleWorkflowBinding
  readonly updateServerMods: NativeLifecycleWorkflowBinding
  readonly createBackup: NativeLifecycleWorkflowBinding
  readonly restoreBackup: NativeLifecycleWorkflowBinding
  readonly moveServer: NativeLifecycleWorkflowBinding
  readonly deleteServer: NativeLifecycleWorkflowBinding
}

const workflowStartFailure = (operationId: string, reason: string) =>
  new WorkflowStartError({ operationId, message: `workflow_start_${reason}` })

const startWithAuthoritativeReservation = (
  binding: NativeLifecycleWorkflowBinding,
  input: Parameters<WorkflowStarterShape['start']>[0],
) =>
  Effect.gen(function* () {
    if (input.workflowInstanceId !== input.operation.id)
      return yield* workflowStartFailure(input.operation.id, 'identity_mismatch')
    const command = yield* Effect.try({
      try: () => JSON.parse(input.operation.fingerprint) as LifecycleCommand,
      catch: () => workflowStartFailure(input.operation.id, 'authoritative_mismatch'),
    })
    if (
      canonicalCommandFingerprint(command) !== input.operation.fingerprint ||
      command.kind !== input.operation.action ||
      command.organizationId !== input.operation.organizationId ||
      command.actorId !== input.operation.actorId ||
      command.resourceId !== input.operation.resourceId ||
      command.correlationId !== input.operation.correlationId ||
      command.expectedDesiredRevision !== input.reservation.previousRevision ||
      input.reservation.organizationId !== input.operation.organizationId ||
      input.reservation.resourceId !== input.operation.resourceId ||
      input.reservation.action !== input.operation.action ||
      input.reservation.desiredRevision !== input.reservation.previousRevision + 1
    )
      return yield* workflowStartFailure(input.operation.id, 'authoritative_mismatch')
    const params: NativeLifecycleWorkflowParams = {
      operationId: input.operation.id,
      organizationId: input.operation.organizationId,
      resourceId: input.operation.resourceId,
      resourceType: input.reservation.resourceKind,
      actorId: input.operation.actorId,
      correlationId: input.operation.correlationId,
      idempotencyKey: input.operation.idempotencyKey,
      input: {
        command,
        fingerprint: input.operation.fingerprint,
        previousRevision: input.reservation.previousRevision,
        desiredRevision: input.reservation.desiredRevision,
      },
    }
    const created = yield* Effect.tryPromise({
      try: () => binding.create({ id: input.operation.id, params }),
      catch: () => workflowStartFailure(input.operation.id, 'create_ambiguous'),
    }).pipe(Effect.result)
    if (created._tag === 'Success') {
      if (created.success.id !== input.operation.id)
        return yield* workflowStartFailure(input.operation.id, 'identity_mismatch')
      return
    }
    const existing = yield* Effect.tryPromise({
      try: () => binding.get(input.operation.id),
      catch: () => created.failure,
    })
    if (existing.id !== input.operation.id)
      return yield* workflowStartFailure(input.operation.id, 'identity_mismatch')
  })

export const makeFixedLifecycleWorkflowStarter = (
  bindings: LifecycleWorkflowBindings,
): WorkflowStarterShape => ({
  start: (input) => {
    const adapter = (() => {
      switch (input.operation.action) {
        case 'provision-node':
          return bindings.provisionNode
        case 'retire-node':
          return bindings.retireNode
        case 'deploy-server':
          return bindings.deployServer
        case 'configure-server':
          return bindings.configureServer
        case 'update-server-mods':
          return bindings.updateServerMods
        case 'create-backup':
          return bindings.createBackup
        case 'restore-backup':
          return bindings.restoreBackup
        case 'move-server':
          return bindings.moveServer
        case 'delete-server':
          return bindings.deleteServer
        // No exact reviewed Workflow exists for these actions. Never alias them to a nearby binding.
        case 'set-server-state':
        case 'delete-node':
          return undefined
      }
    })()
    return adapter === undefined
      ? Effect.fail(
          new WorkflowStartError({
            operationId: input.operation.id,
            message: 'workflow_start_unsupported_action',
          }),
        )
      : startWithAuthoritativeReservation(adapter, input)
  },
})

/** Baseline destructive checks and organization policy must both admit an operation. */
export const makeLifecyclePolicyAdmission = (
  organizationPolicy?: PolicyAdmissionShape,
): PolicyAdmissionShape => ({
  admit: (command, snapshot) =>
    baselinePolicyAdmission.admit(command, snapshot).pipe(
      Effect.flatMap(() =>
        organizationPolicy === undefined
          ? Effect.fail(
              new PolicyDeniedError({
                code: 'organization_policy_unavailable',
                message: 'Organization policy admission is unavailable',
              }),
            )
          : organizationPolicy.admit(command, snapshot),
      ),
    ),
})

export interface LifecycleRuntimeOptions {
  readonly database: LifecycleD1Database
  readonly workflows: LifecycleWorkflowBindings
  readonly organizationPolicy?: PolicyAdmissionShape
  readonly d1?: Partial<LifecycleD1Options>
}

/** Fully composes the Effect service; HTTP routes stay gated until their Workflow steps are executable. */
export const makeLifecycleControlLayer = (options: LifecycleRuntimeOptions) => {
  const workflowStarter = makeFixedLifecycleWorkflowStarter(options.workflows)
  const dependencies = Layer.mergeAll(
    LifecycleD1ClientLayer(options.database),
    Layer.succeed(PolicyAdmission, makeLifecyclePolicyAdmission(options.organizationPolicy)),
    Layer.succeed(WorkflowStarter, workflowStarter),
  )
  const repository = LifecycleD1RepositoryLive(options.d1).pipe(Layer.provide(dependencies))
  const control = LifecycleControlLive.pipe(Layer.provide(Layer.merge(dependencies, repository)))
  const reconciliation = WorkflowStartReconciliationD1Live.pipe(Layer.provide(dependencies))
  return Layer.mergeAll(
    control,
    repository,
    reconciliation,
    Layer.succeed(WorkflowStarter, workflowStarter),
  ) as Layer.Layer<
    LifecycleControl | LifecycleRepository | WorkflowStartReconciliationRepository | WorkflowStarter
  >
}

export {
  LifecycleControl,
  LifecycleRepository,
  WorkflowStartReconciliationRepository,
  WorkflowStarter,
}

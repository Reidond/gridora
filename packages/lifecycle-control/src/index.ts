import { Context, Effect, Layer, Schema } from 'effect'

export type OrganizationId = string
export type ActorId = string
export type ResourceId = string
export type OperationId = string

export type NodeDesiredState = 'provisioning' | 'ready' | 'draining' | 'stopped' | 'deleted'
export type NodeObservedState =
  | 'unknown'
  | 'provisioning'
  | 'bootstrapping'
  | 'ready'
  | 'degraded'
  | 'offline'
  | 'deleting'
  | 'deleted'
  | 'failed'
export type ServerDesiredState = 'running' | 'stopped' | 'deleted'
export type ServerObservedState =
  | 'unknown'
  | 'planning'
  | 'installing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'updating'
  | 'backing_up'
  | 'restoring'
  | 'moving'
  | 'repairing'
  | 'deleting'
  | 'deleted'
  | 'failed'

export interface NodeSnapshot {
  readonly kind: 'node'
  readonly id: ResourceId
  readonly organizationId: OrganizationId
  readonly desiredState: NodeDesiredState
  readonly observedState: NodeObservedState
  readonly desiredRevision: number
}

export interface ServerSnapshot {
  readonly kind: 'server'
  readonly id: ResourceId
  readonly organizationId: OrganizationId
  readonly desiredState: ServerDesiredState
  readonly observedState: ServerObservedState
  readonly desiredRevision: number
  /** The desired revision covered by the newest verified, available backup. */
  readonly lastVerifiedBackupRevision: number | null
}

export type ResourceSnapshot = NodeSnapshot | ServerSnapshot

export interface PlacementIntent {
  readonly mode: 'shared' | 'dedicated'
  readonly nodeId?: ResourceId
  readonly provider?: string
  readonly region?: string
}

interface CommandBase {
  readonly organizationId: OrganizationId
  readonly actorId: ActorId
  readonly resourceId: ResourceId
  readonly idempotencyKey: string
  readonly expectedDesiredRevision: number
  readonly correlationId: string
}

export interface ProvisionNodeCommand extends CommandBase {
  readonly kind: 'provision-node'
}
export interface RetireNodeCommand extends CommandBase {
  readonly kind: 'retire-node'
}
export interface DeleteNodeCommand extends CommandBase {
  readonly kind: 'delete-node'
}
export interface DeployServerCommand extends CommandBase {
  readonly kind: 'deploy-server'
  readonly placement: PlacementIntent
}
export interface SetServerStateCommand extends CommandBase {
  readonly kind: 'set-server-state'
  readonly state: 'running' | 'stopped'
}
export interface ConfigureServerCommand extends CommandBase {
  readonly kind: 'configure-server'
  readonly configRevision: number
}
export interface UpdateServerModsCommand extends CommandBase {
  readonly kind: 'update-server-mods'
  readonly modSetRevision: number
}
export interface CreateBackupCommand extends CommandBase {
  readonly kind: 'create-backup'
  readonly backupId: string
}
export interface RestoreBackupCommand extends CommandBase {
  readonly kind: 'restore-backup'
  readonly backupId: string
}
export interface MoveServerCommand extends CommandBase {
  readonly kind: 'move-server'
  readonly placement: PlacementIntent
}
export interface DeleteServerCommand extends CommandBase {
  readonly kind: 'delete-server'
  readonly backupPolicy: 'required' | 'skip-authorized'
}

export type LifecycleCommand =
  | ProvisionNodeCommand
  | RetireNodeCommand
  | DeleteNodeCommand
  | DeployServerCommand
  | SetServerStateCommand
  | ConfigureServerCommand
  | UpdateServerModsCommand
  | CreateBackupCommand
  | RestoreBackupCommand
  | MoveServerCommand
  | DeleteServerCommand

export type DesiredState = NodeDesiredState | ServerDesiredState

export interface DesiredStateReservation {
  readonly organizationId: OrganizationId
  readonly resourceKind: ResourceSnapshot['kind']
  readonly resourceId: ResourceId
  readonly action: LifecycleCommand['kind']
  readonly previousRevision: number
  readonly desiredRevision: number
  readonly desiredState: DesiredState
  readonly placement?: PlacementIntent
}

export interface LifecycleOperation {
  readonly id: OperationId
  readonly organizationId: OrganizationId
  readonly actorId: ActorId
  readonly resourceId: ResourceId
  readonly action: LifecycleCommand['kind']
  readonly state: 'queued'
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly correlationId: string
}

export interface WorkflowStartRecord {
  readonly id: string
  readonly operationId: OperationId
  readonly organizationId: OrganizationId
  readonly state: 'pending' | 'started'
  readonly attempts: number
  readonly lastError: string | null
}

export interface AtomicReservation {
  readonly disposition: 'created' | 'adopted'
  readonly operation: LifecycleOperation
  readonly reservation: DesiredStateReservation
  /** This durable record makes a failed or response-lost start reconcilable. */
  readonly workflowStart: WorkflowStartRecord
}

export interface WorkflowStartReconciliationRequest {
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
  readonly workflowStartRecordId: string
}

export class ResourceNotFoundError extends Schema.TaggedError<ResourceNotFoundError>()(
  'ResourceNotFoundError',
  { resourceId: Schema.String },
) {}
export class OrganizationScopeError extends Schema.TaggedError<OrganizationScopeError>()(
  'OrganizationScopeError',
  { organizationId: Schema.String, resourceId: Schema.String },
) {}
export class InvalidTransitionError extends Schema.TaggedError<InvalidTransitionError>()(
  'InvalidTransitionError',
  { action: Schema.String, resourceId: Schema.String, message: Schema.String },
) {}
export class RevisionConflictError extends Schema.TaggedError<RevisionConflictError>()(
  'RevisionConflictError',
  { resourceId: Schema.String, expected: Schema.Number, actual: Schema.Number },
) {}
export class IdempotencyConflictError extends Schema.TaggedError<IdempotencyConflictError>()(
  'IdempotencyConflictError',
  { idempotencyKey: Schema.String },
) {}
export class LifecycleOperationInProgressError extends Schema.TaggedError<LifecycleOperationInProgressError>()(
  'LifecycleOperationInProgressError',
  { resourceId: Schema.String },
) {}
export class PolicyDeniedError extends Schema.TaggedError<PolicyDeniedError>()(
  'PolicyDeniedError',
  { code: Schema.String, message: Schema.String },
) {}
export class PersistenceError extends Schema.TaggedError<PersistenceError>()('PersistenceError', {
  operation: Schema.String,
  message: Schema.String,
}) {}
export class WorkflowStartError extends Schema.TaggedError<WorkflowStartError>()(
  'WorkflowStartError',
  { operationId: Schema.String, message: Schema.String },
) {}
export class WorkflowStartReconciliationNotFoundError extends Schema.TaggedError<WorkflowStartReconciliationNotFoundError>()(
  'WorkflowStartReconciliationNotFoundError',
  {},
) {}
export class WorkflowStartReconciliationMismatchError extends Schema.TaggedError<WorkflowStartReconciliationMismatchError>()(
  'WorkflowStartReconciliationMismatchError',
  { code: Schema.Literal('binding_mismatch') },
) {}

export type ReservationError =
  | OrganizationScopeError
  | RevisionConflictError
  | IdempotencyConflictError
  | LifecycleOperationInProgressError
  | PersistenceError

export interface AtomicReserveInput {
  readonly command: LifecycleCommand
  readonly fingerprint: string
  readonly reservation: DesiredStateReservation
}

export interface LifecycleRepositoryShape {
  /** Resolves an idempotent replay before current-state validation can reject an already reserved command. */
  readonly findIdempotent: (
    organizationId: OrganizationId,
    idempotencyKey: string,
    fingerprint: string,
  ) => Effect.Effect<AtomicReservation | null, IdempotencyConflictError | PersistenceError>
  /** Reads inside an organization boundary. Adapters must not fall back to an unscoped lookup. */
  readonly get: (
    organizationId: OrganizationId,
    resourceId: ResourceId,
  ) => Effect.Effect<
    ResourceSnapshot,
    ResourceNotFoundError | OrganizationScopeError | PersistenceError
  >
  /**
   * In one transaction: enforce organization and revision fences, bind the idempotency key to the
   * exact fingerprint, reserve desired state, create the queued operation, and create a pending
   * workflow-start record. A replay with the same fingerprint returns the original records.
   */
  readonly reserveAtomic: (
    input: AtomicReserveInput,
  ) => Effect.Effect<AtomicReservation, ReservationError>
  readonly markWorkflowStarted: (
    organizationId: OrganizationId,
    operationId: OperationId,
  ) => Effect.Effect<void, PersistenceError>
  readonly recordWorkflowStartFailure: (
    organizationId: OrganizationId,
    operationId: OperationId,
    message: string,
  ) => Effect.Effect<void, PersistenceError>
}
export class LifecycleRepository extends Context.Service<
  LifecycleRepository,
  LifecycleRepositoryShape
>()('@gridora/lifecycle-control/LifecycleRepository') {}

export interface WorkflowStartReconciliationRepositoryShape {
  readonly load: (
    request: WorkflowStartReconciliationRequest,
  ) => Effect.Effect<
    AtomicReservation,
    | WorkflowStartReconciliationNotFoundError
    | WorkflowStartReconciliationMismatchError
    | PersistenceError
  >
}
export class WorkflowStartReconciliationRepository extends Context.Service<
  WorkflowStartReconciliationRepository,
  WorkflowStartReconciliationRepositoryShape
>()('@gridora/lifecycle-control/WorkflowStartReconciliationRepository') {}

export interface PolicyAdmissionShape {
  readonly admit: (
    command: LifecycleCommand,
    snapshot: ResourceSnapshot,
  ) => Effect.Effect<void, PolicyDeniedError>
}
export class PolicyAdmission extends Context.Service<PolicyAdmission, PolicyAdmissionShape>()(
  '@gridora/lifecycle-control/PolicyAdmission',
) {}

export interface WorkflowStarterShape {
  /** Must use operationId as the platform workflow instance id and adopt an existing instance. */
  readonly start: (input: {
    readonly workflowInstanceId: OperationId
    readonly startRecordId: string
    readonly operation: LifecycleOperation
    readonly reservation: DesiredStateReservation
  }) => Effect.Effect<void, WorkflowStartError>
}
export class WorkflowStarter extends Context.Service<WorkflowStarter, WorkflowStarterShape>()(
  '@gridora/lifecycle-control/WorkflowStarter',
) {}

export interface LifecycleAcceptance {
  readonly disposition: AtomicReservation['disposition']
  readonly operation: LifecycleOperation
  readonly reservation: DesiredStateReservation
  /** `pending-reconciliation` is durable acceptance, never lifecycle completion. */
  readonly workflowState: 'started' | 'pending-reconciliation'
}

export type LifecycleControlError =
  | ResourceNotFoundError
  | OrganizationScopeError
  | InvalidTransitionError
  | RevisionConflictError
  | IdempotencyConflictError
  | LifecycleOperationInProgressError
  | PolicyDeniedError
  | PersistenceError

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    )
  return value
}

/** Exact canonical payload binding; a persistence adapter may additionally hash this value. */
export const canonicalCommandFingerprint = (command: LifecycleCommand): string =>
  JSON.stringify(canonicalValue(command))

const failTransition = (command: LifecycleCommand, message: string) =>
  Effect.fail(
    new InvalidTransitionError({ action: command.kind, resourceId: command.resourceId, message }),
  )

const transition = (
  command: LifecycleCommand,
  snapshot: ResourceSnapshot,
): Effect.Effect<DesiredStateReservation, InvalidTransitionError> => {
  const base = {
    organizationId: command.organizationId,
    resourceKind: snapshot.kind,
    resourceId: command.resourceId,
    action: command.kind,
    previousRevision: snapshot.desiredRevision,
    desiredRevision: snapshot.desiredRevision + 1,
  } as const

  if (snapshot.kind === 'node') {
    if (
      command.kind === 'provision-node' &&
      snapshot.desiredState !== 'deleted' &&
      ['unknown', 'failed'].includes(snapshot.observedState)
    )
      return Effect.succeed({ ...base, desiredState: 'provisioning' })
    if (
      command.kind === 'retire-node' &&
      snapshot.desiredState !== 'deleted' &&
      snapshot.observedState !== 'deleted'
    )
      return Effect.succeed({ ...base, desiredState: 'draining' })
    if (
      command.kind === 'delete-node' &&
      snapshot.desiredState !== 'deleted' &&
      ['offline', 'failed'].includes(snapshot.observedState)
    )
      return Effect.succeed({ ...base, desiredState: 'deleted' })
    return failTransition(command, 'Action is not valid for the current node state')
  }

  if (
    snapshot.desiredState === 'deleted' ||
    ['deleted', 'deleting'].includes(snapshot.observedState)
  )
    return failTransition(command, 'A deleting or deleted server cannot accept lifecycle changes')
  switch (command.kind) {
    case 'deploy-server':
      return snapshot.observedState === 'unknown' || snapshot.observedState === 'stopped'
        ? Effect.succeed({ ...base, desiredState: 'running', placement: command.placement })
        : failTransition(command, 'Only an uninstalled or stopped server can be deployed')
    case 'set-server-state':
      return Effect.succeed({ ...base, desiredState: command.state })
    case 'configure-server':
    case 'update-server-mods':
    case 'create-backup':
      return ['moving', 'restoring'].includes(snapshot.observedState)
        ? failTransition(command, 'The server is busy with an exclusive lifecycle operation')
        : Effect.succeed({ ...base, desiredState: snapshot.desiredState })
    case 'restore-backup':
      return ['stopped', 'failed'].includes(snapshot.observedState)
        ? Effect.succeed({ ...base, desiredState: 'stopped' })
        : failTransition(command, 'Restore requires a stopped or failed server')
    case 'move-server':
      return ['running', 'stopped', 'failed'].includes(snapshot.observedState)
        ? Effect.succeed({
            ...base,
            desiredState: snapshot.desiredState,
            placement: command.placement,
          })
        : failTransition(command, 'Move requires a stable or failed server')
    case 'delete-server':
      return Effect.succeed({ ...base, desiredState: 'deleted' })
    default:
      return failTransition(command, 'Action does not target a server')
  }
}

export interface LifecycleControlShape {
  readonly submit: (
    command: LifecycleCommand,
  ) => Effect.Effect<LifecycleAcceptance, LifecycleControlError>
}
export class LifecycleControl extends Context.Service<LifecycleControl, LifecycleControlShape>()(
  '@gridora/lifecycle-control/LifecycleControl',
) {}

export const makeLifecycleControl = (
  repository: LifecycleRepositoryShape,
  policy: PolicyAdmissionShape,
  workflows: WorkflowStarterShape,
): LifecycleControlShape => ({
  submit: (command) =>
    Effect.gen(function* () {
      const fingerprint = canonicalCommandFingerprint(command)
      const existing = yield* repository.findIdempotent(
        command.organizationId,
        command.idempotencyKey,
        fingerprint,
      )
      const atomic = yield* Effect.gen(function* () {
        if (existing !== null) return { ...existing, disposition: 'adopted' as const }
        const snapshot = yield* repository.get(command.organizationId, command.resourceId)
        if (snapshot.organizationId !== command.organizationId)
          return yield* new OrganizationScopeError({
            organizationId: command.organizationId,
            resourceId: command.resourceId,
          })
        if (snapshot.desiredRevision !== command.expectedDesiredRevision)
          return yield* new RevisionConflictError({
            resourceId: command.resourceId,
            expected: command.expectedDesiredRevision,
            actual: snapshot.desiredRevision,
          })
        const reservation = yield* transition(command, snapshot)
        yield* policy.admit(command, snapshot)
        return yield* repository.reserveAtomic({ command, fingerprint, reservation })
      })
      const started = yield* workflows
        .start({
          workflowInstanceId: atomic.operation.id,
          startRecordId: atomic.workflowStart.id,
          operation: atomic.operation,
          reservation: atomic.reservation,
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              repository
                .recordWorkflowStartFailure(
                  command.organizationId,
                  atomic.operation.id,
                  error.message,
                )
                .pipe(
                  Effect.catch(() => Effect.void),
                  Effect.as(false),
                ),
            onSuccess: () =>
              repository
                .markWorkflowStarted(command.organizationId, atomic.operation.id)
                .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
          }),
        )
      return {
        disposition: atomic.disposition,
        operation: atomic.operation,
        reservation: atomic.reservation,
        workflowState: started ? 'started' : 'pending-reconciliation',
      }
    }),
})

export const LifecycleControlLive = Layer.effect(
  LifecycleControl,
  Effect.gen(function* () {
    const repository = yield* LifecycleRepository
    const policy = yield* PolicyAdmission
    const workflows = yield* WorkflowStarter
    return LifecycleControl.of(makeLifecycleControl(repository, policy, workflows))
  }),
)

/** Baseline safety policy. Installations can compose stricter organization policy checks. */
export const baselinePolicyAdmission: PolicyAdmissionShape = {
  admit: (command, snapshot) => {
    if (
      command.kind === 'delete-server' &&
      command.backupPolicy === 'required' &&
      snapshot.kind === 'server' &&
      (snapshot.lastVerifiedBackupRevision === null ||
        snapshot.lastVerifiedBackupRevision < snapshot.desiredRevision)
    )
      return Effect.fail(
        new PolicyDeniedError({
          code: 'verified_backup_required',
          message: 'A verified backup of the current desired revision is required before deletion',
        }),
      )
    return Effect.void
  },
}

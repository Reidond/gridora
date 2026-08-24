import { Context, Effect, Layer, Schema } from 'effect'

export type OrganizationId = string
export type ActorId = string
export type OperationId = string
export type NodeId = string
export type Sha256Fingerprint = string

const boundedText = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum))

export const TerminationRole = Schema.Literals([
  'owner',
  'administrator',
  'operator',
  'viewer',
  'automation',
])
export type TerminationRole = typeof TerminationRole.Type

export const NodeLifecycleAction = Schema.Literals([
  'drain-node',
  'leave-drain',
  'rebuild-node',
  'retire-node',
])
export type NodeLifecycleAction = typeof NodeLifecycleAction.Type

export const DestructiveLifecycleAction = Schema.Literals([
  'drain-node',
  'leave-drain',
  'rebuild-node',
  'retire-node',
  'delete-organization',
])
export type DestructiveLifecycleAction = typeof DestructiveLifecycleAction.Type

export const CancellationPolicy = Schema.Literals([
  'before-destructive-step',
  'between-steps',
  'not-cancellable',
])
export type CancellationPolicy = typeof CancellationPolicy.Type

/**
 * This is a fact about the exact point a workflow has reached, not an optimistic UI hint.
 * Unknown operations have no facts and are deliberately not cancellable.
 */
export const CancellationPhase = Schema.Literals([
  'before-destructive-step',
  'between-steps',
  'step-running',
  'destructive-step-running',
  'terminal',
])
export type CancellationPhase = typeof CancellationPhase.Type

export const TerminationOperationState = Schema.Literals([
  'queued',
  'running',
  'waiting-external',
  'blocked',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
  'retrying',
  'failed-terminal',
])
export type TerminationOperationState = typeof TerminationOperationState.Type

export const NodeTerminationState = Schema.Literals([
  'accepted',
  'draining',
  'drained',
  'drained-forced',
  'rebuilding',
  'awaiting-agent',
  'retiring',
  'awaiting-provider-confirmation',
  'cancel-scheduled',
  'blocked',
  'cancelled',
  'completed',
])
export type NodeTerminationState = typeof NodeTerminationState.Type

export const ProviderRetirementState = Schema.Literals([
  'not-started',
  'delete-requested',
  'deleted-confirmed',
  'secure-wipe-completed',
  'cancel-scheduled',
  'contract-ended',
  'ambiguous',
])
export type ProviderRetirementState = typeof ProviderRetirementState.Type

export const ProviderBillingState = Schema.Literals([
  'not-applicable',
  'unknown',
  'stopped',
  'continues-until-cancellation',
])
export type ProviderBillingState = typeof ProviderBillingState.Type

export const OrganizationDeletionState = Schema.Literals([
  'accepted',
  'inventorying',
  'draining',
  'retiring',
  'revoking',
  'cleaning-networking',
  'blocked',
  'ready-to-tombstone',
  'tombstoned',
  'cancelled',
])
export type OrganizationDeletionState = typeof OrganizationDeletionState.Type

export const DeletionBackupPolicy = Schema.Literals(['retain', 'delete-after-retention'])
export type DeletionBackupPolicy = typeof DeletionBackupPolicy.Type

export const NodeRetirementBackupPolicy = Schema.Literals(['required', 'skip-authorized'])
export type NodeRetirementBackupPolicy = typeof NodeRetirementBackupPolicy.Type

/**
 * Internal-only proof carried by the policy scheduler into the existing
 * retirement boundary. Public HTTP schemas deliberately omit it.
 */
export const PolicySchedulerRetireBinding = Schema.Struct({
  actionId: boundedText(1, 128),
})
export type PolicySchedulerRetireBinding = typeof PolicySchedulerRetireBinding.Type

/** Internal-only parent link. The public API schema must omit this property. */
export const NodeLifecycleCommand = Schema.Struct({
  organizationId: boundedText(1, 128),
  actorId: boundedText(1, 128),
  role: TerminationRole,
  /** Current active membership revision from the HTTP authorization fence. */
  actorMembershipRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  correlationId: boundedText(1, 160),
  idempotencyKey: boundedText(16, 256),
  action: NodeLifecycleAction,
  nodeId: boundedText(1, 128),
  expectedNodeRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  force: Schema.Boolean,
  backupPolicy: NodeRetirementBackupPolicy,
  targetImageId: Schema.optional(boundedText(1, 128)),
  organizationDeletionOperationId: Schema.optional(boundedText(1, 128)),
  policySchedulerRetire: Schema.optional(PolicySchedulerRetireBinding),
})
export type NodeLifecycleCommand = typeof NodeLifecycleCommand.Type

export const DeleteOrganizationCommand = Schema.Struct({
  organizationId: boundedText(1, 128),
  actorId: boundedText(1, 128),
  role: TerminationRole,
  correlationId: boundedText(1, 160),
  idempotencyKey: boundedText(16, 256),
  expectedOrganizationRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  typedSlug: boundedText(1, 120),
  backupPolicy: DeletionBackupPolicy,
})
export type DeleteOrganizationCommand = typeof DeleteOrganizationCommand.Type

export const CancelOperationCommand = Schema.Struct({
  organizationId: boundedText(1, 128),
  actorId: boundedText(1, 128),
  role: TerminationRole,
  correlationId: boundedText(1, 160),
  idempotencyKey: boundedText(16, 256),
  operationId: boundedText(1, 128),
  expectedOperationRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type CancelOperationCommand = typeof CancelOperationCommand.Type

export class TerminationValidationError extends Schema.TaggedError<TerminationValidationError>()(
  'TerminationValidationError',
  { code: Schema.String },
) {}
export class TerminationAuthorizationError extends Schema.TaggedError<TerminationAuthorizationError>()(
  'TerminationAuthorizationError',
  { code: Schema.String },
) {}
export class TerminationConflictError extends Schema.TaggedError<TerminationConflictError>()(
  'TerminationConflictError',
  { code: Schema.String },
) {}
export class TerminationPersistenceError extends Schema.TaggedError<TerminationPersistenceError>()(
  'TerminationPersistenceError',
  { operation: Schema.String, message: Schema.String },
) {}
export class CancellationSignalError extends Schema.TaggedError<CancellationSignalError>()(
  'CancellationSignalError',
  { operation: Schema.String, message: Schema.String },
) {}
export class TerminationWorkflowStartError extends Schema.TaggedError<TerminationWorkflowStartError>()(
  'TerminationWorkflowStartError',
  { operationId: Schema.String, code: Schema.String },
) {}

export type TerminationControlError =
  | TerminationValidationError
  | TerminationAuthorizationError
  | TerminationConflictError
  | TerminationPersistenceError

export interface TerminationOperation {
  readonly id: OperationId
  readonly organizationId: OrganizationId
  readonly actorId: ActorId
  readonly action: string
  readonly resourceType: string
  readonly resourceId: string
  readonly cancellationPolicy: CancellationPolicy
  readonly revision: number
  readonly state: TerminationOperationState
}

/**
 * The immutable start identity is committed with acceptance. An outbox event may wake a starter,
 * but it is not evidence that a different Workflow may be started or adopted.
 */
export interface TerminationWorkflowStart {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
  readonly workflowType: string
  readonly workflowInstanceId: string
  readonly paramsFingerprint: Sha256Fingerprint
  readonly state: 'pending' | 'started' | 'adopted'
  readonly attempts: number
  readonly lastErrorCode: string | null
}

export interface NodeLifecycleAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly operation: TerminationOperation
  readonly nodeId: NodeId
  readonly previousNodeRevision: number
  readonly desiredNodeRevision: number
  readonly state: NodeTerminationState
  readonly workflowStart: TerminationWorkflowStart
}

export interface OrganizationDeletionAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly operation: TerminationOperation
  readonly requestedSlug: string
  readonly state: OrganizationDeletionState
  readonly workflowStart: TerminationWorkflowStart
}

/**
 * Producers register these exact facts once, then only the signed step path can advance phase.
 * This is the cancellation boundary for destructive, provision, game, and backup operations.
 */
export interface OperationCancellationFacts {
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
  readonly resourceType: string
  readonly resourceId: string
  readonly resourceOperationDoName: string
  readonly workflowBinding: string
  readonly workflowType: string
  readonly workflowInstanceId: string
  readonly policy: CancellationPolicy
  readonly phase: CancellationPhase
  readonly activeStepName?: string
  readonly activeStepOrdinal?: number
  readonly revision: number
}

/**
 * The composition root must use this opaque name for both lock acquisition and cancellation; it
 * must not substitute an idempotency scope, a bare resource id, or a guessed Workflow instance.
 */
export const canonicalResourceOperationDoName = (
  organizationId: string,
  resourceType: string,
  resourceId: string,
): string => `resource-operation:${organizationId}:${resourceType}:${resourceId}`

export interface CancellationRequest {
  readonly disposition: 'created' | 'adopted'
  readonly operation: TerminationOperation
  readonly facts: OperationCancellationFacts
  readonly signalState: 'pending-delivery' | 'delivered' | 'cancelled'
}

export interface CancellationSignalInput {
  readonly organizationId: string
  readonly operationId: string
  readonly resourceType: string
  readonly resourceId: string
  readonly resourceOperationDoName: string
  readonly workflowBinding: string
  readonly workflowType: string
  readonly workflowInstanceId: string
}

export interface CancellationSignalReceipt {
  /** False is a failed delivery, even when the adapter request itself resolved successfully. */
  readonly resourceOperationSignalled: boolean
  /** False means the exact Workflow instance was not signalled and must be retried. */
  readonly workflowSignalled: boolean
}

/** A root adapter must use the exact stored DO name and exact stored Workflow binding/id. */
export interface OperationCancellationSignalShape {
  readonly signal: (
    input: CancellationSignalInput,
  ) => Effect.Effect<CancellationSignalReceipt, CancellationSignalError>
}
export class OperationCancellationSignal extends Context.Service<
  OperationCancellationSignal,
  OperationCancellationSignalShape
>()('@gridora/lifecycle-termination-control/OperationCancellationSignal') {}
export const OperationCancellationSignalLayer = (signal: OperationCancellationSignalShape) =>
  Layer.succeed(OperationCancellationSignal, signal)

/**
 * A producer may only register one fact row per existing operation. Unknown operation types do
 * not use a fallback route or Workflow; cancellation rejects them safely instead.
 */
export interface OperationCancellationFactsRepositoryShape {
  readonly register: (
    facts: OperationCancellationFacts,
  ) => Effect.Effect<
    OperationCancellationFacts,
    TerminationConflictError | TerminationPersistenceError
  >
  readonly get: (input: {
    readonly organizationId: string
    readonly operationId: string
  }) => Effect.Effect<OperationCancellationFacts | null, TerminationPersistenceError>
  readonly advancePhase: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly expectedRevision: number
    readonly phase: CancellationPhase
    readonly activeStepName?: string
    readonly activeStepOrdinal?: number
    readonly now: string
  }) => Effect.Effect<
    OperationCancellationFacts,
    TerminationConflictError | TerminationPersistenceError
  >
}
export class OperationCancellationFactsRepository extends Context.Service<
  OperationCancellationFactsRepository,
  OperationCancellationFactsRepositoryShape
>()('@gridora/lifecycle-termination-control/OperationCancellationFactsRepository') {}
export const OperationCancellationFactsRepositoryLayer = (
  repository: OperationCancellationFactsRepositoryShape,
) => Layer.succeed(OperationCancellationFactsRepository, repository)

export interface TerminationRepositoryShape {
  readonly acceptNodeLifecycle: (
    command: NodeLifecycleCommand,
    fingerprint: Sha256Fingerprint,
  ) => Effect.Effect<NodeLifecycleAcceptance, TerminationControlError>
  readonly acceptOrganizationDeletion: (
    command: DeleteOrganizationCommand,
    fingerprint: Sha256Fingerprint,
  ) => Effect.Effect<OrganizationDeletionAcceptance, TerminationControlError>
  readonly requestCancellation: (
    command: CancelOperationCommand,
    fingerprint: Sha256Fingerprint,
  ) => Effect.Effect<CancellationRequest, TerminationControlError>
  readonly recordCancellationSignal: (
    input: CancellationSignalInput,
    receipt: CancellationSignalReceipt,
  ) => Effect.Effect<CancellationRequest, TerminationPersistenceError>
}
export class TerminationRepository extends Context.Service<
  TerminationRepository,
  TerminationRepositoryShape
>()('@gridora/lifecycle-termination-control/TerminationRepository') {}
export const TerminationRepositoryLayer = (repository: TerminationRepositoryShape) =>
  Layer.succeed(TerminationRepository, repository)

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    )
  return value
}

/** Canonical payload is only an in-memory input to SHA-256; it must never be persisted. */
export const canonicalTerminationPayload = (
  command: NodeLifecycleCommand | DeleteOrganizationCommand | CancelOperationCommand,
): string => {
  /**
   * The membership revision is an authorization fence, not part of the
   * requested lifecycle change.  Including it would turn a retried HTTP
   * request into a different idempotency payload after an unrelated member
   * revision, even when the same active administrator still makes it.
   */
  const payload =
    'actorMembershipRevision' in command
      ? (() => {
          const { actorMembershipRevision: _authorizationFence, ...requestedChange } = command
          return requestedChange
        })()
      : command
  return JSON.stringify(canonical(payload))
}

export const sha256TerminationFingerprint = (
  command: NodeLifecycleCommand | DeleteOrganizationCommand | CancelOperationCommand,
): Effect.Effect<Sha256Fingerprint, TerminationPersistenceError> =>
  Effect.tryPromise({
    try: async () => {
      const payload = canonicalTerminationPayload(command)
      if (payload.length > 32_768) throw new Error('canonical request exceeds fingerprint bound')
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: (cause) =>
      new TerminationPersistenceError({
        operation: 'termination.fingerprint',
        message: cause instanceof Error ? cause.message : 'sha256 failed',
      }),
  })

export interface TerminationFingerprintShape {
  readonly fingerprint: (
    command: NodeLifecycleCommand | DeleteOrganizationCommand | CancelOperationCommand,
  ) => Effect.Effect<Sha256Fingerprint, TerminationPersistenceError>
}
export class TerminationFingerprint extends Context.Service<
  TerminationFingerprint,
  TerminationFingerprintShape
>()('@gridora/lifecycle-termination-control/TerminationFingerprint') {}
export const WebCryptoTerminationFingerprint = {
  fingerprint: sha256TerminationFingerprint,
} satisfies TerminationFingerprintShape
export const WebCryptoTerminationFingerprintLayer = Layer.succeed(
  TerminationFingerprint,
  WebCryptoTerminationFingerprint,
)

const requireAdministrator = (role: TerminationRole) =>
  role === 'owner' || role === 'administrator'
    ? Effect.void
    : Effect.fail(new TerminationAuthorizationError({ code: 'administrator_required' }))

const requireOwner = (role: TerminationRole) =>
  role === 'owner'
    ? Effect.void
    : Effect.fail(new TerminationAuthorizationError({ code: 'owner_required' }))

const validateNodeIntent = (
  command: NodeLifecycleCommand,
): Effect.Effect<NodeLifecycleCommand, TerminationValidationError> =>
  Schema.decodeUnknownEffect(NodeLifecycleCommand, { onExcessProperty: 'error' })(command).pipe(
    Effect.mapError(
      () => new TerminationValidationError({ code: 'invalid_node_lifecycle_request' }),
    ),
    Effect.filterOrFail(
      (decoded) =>
        (decoded.action !== 'rebuild-node' || decoded.targetImageId !== undefined) &&
        (decoded.action === 'rebuild-node' || decoded.targetImageId === undefined) &&
        (decoded.organizationDeletionOperationId === undefined ||
          decoded.action === 'drain-node' ||
          decoded.action === 'retire-node') &&
        (decoded.policySchedulerRetire === undefined ||
          (decoded.action === 'retire-node' &&
            decoded.role === 'automation' &&
            decoded.force === false &&
            decoded.backupPolicy === 'required' &&
            decoded.targetImageId === undefined &&
            decoded.organizationDeletionOperationId === undefined)),
      () => new TerminationValidationError({ code: 'invalid_node_lifecycle_binding' }),
    ),
  )

const validateOrganizationIntent = (
  command: DeleteOrganizationCommand,
): Effect.Effect<DeleteOrganizationCommand, TerminationValidationError> =>
  Schema.decodeUnknownEffect(DeleteOrganizationCommand, { onExcessProperty: 'error' })(
    command,
  ).pipe(
    Effect.mapError(
      () => new TerminationValidationError({ code: 'invalid_organization_deletion_request' }),
    ),
  )

const validateCancellationIntent = (
  command: CancelOperationCommand,
): Effect.Effect<CancelOperationCommand, TerminationValidationError> =>
  Schema.decodeUnknownEffect(CancelOperationCommand, { onExcessProperty: 'error' })(command).pipe(
    Effect.mapError(() => new TerminationValidationError({ code: 'invalid_cancellation_request' })),
  )

export interface TerminationControlShape {
  readonly beginNodeLifecycle: (
    command: NodeLifecycleCommand,
  ) => Effect.Effect<NodeLifecycleAcceptance, TerminationControlError>
  readonly beginOrganizationDeletion: (
    command: DeleteOrganizationCommand,
  ) => Effect.Effect<OrganizationDeletionAcceptance, TerminationControlError>
  /** Durable cancellation is committed before either exact signal is attempted. */
  readonly cancelOperation: (
    command: CancelOperationCommand,
  ) => Effect.Effect<CancellationRequest, TerminationControlError>
}
export class TerminationControl extends Context.Service<
  TerminationControl,
  TerminationControlShape
>()('@gridora/lifecycle-termination-control/TerminationControl') {}

export const makeTerminationControl = (
  repository: TerminationRepositoryShape,
  signal: OperationCancellationSignalShape,
  fingerprint: TerminationFingerprintShape = WebCryptoTerminationFingerprint,
): TerminationControlShape => ({
  beginNodeLifecycle: (command) =>
    Effect.gen(function* () {
      const validated = yield* validateNodeIntent(command)
      if (validated.policySchedulerRetire === undefined) yield* requireAdministrator(validated.role)
      else if (validated.role !== 'automation')
        return yield* new TerminationAuthorizationError({ code: 'policy_scheduler_required' })
      return yield* repository.acceptNodeLifecycle(
        validated,
        yield* fingerprint.fingerprint(validated),
      )
    }),
  beginOrganizationDeletion: (command) =>
    Effect.gen(function* () {
      const validated = yield* validateOrganizationIntent(command)
      yield* requireOwner(validated.role)
      return yield* repository.acceptOrganizationDeletion(
        validated,
        yield* fingerprint.fingerprint(validated),
      )
    }),
  cancelOperation: (command) =>
    Effect.gen(function* () {
      const validated = yield* validateCancellationIntent(command)
      yield* requireAdministrator(validated.role)
      const request = yield* repository.requestCancellation(
        validated,
        yield* fingerprint.fingerprint(validated),
      )
      if (request.signalState === 'cancelled' || request.signalState === 'delivered') return request
      const input: CancellationSignalInput = {
        organizationId: request.facts.organizationId,
        operationId: request.facts.operationId,
        resourceType: request.facts.resourceType,
        resourceId: request.facts.resourceId,
        resourceOperationDoName: request.facts.resourceOperationDoName,
        workflowBinding: request.facts.workflowBinding,
        workflowType: request.facts.workflowType,
        workflowInstanceId: request.facts.workflowInstanceId,
      }
      const receipt = yield* signal.signal(input).pipe(
        Effect.match({
          onFailure: () => ({ resourceOperationSignalled: false, workflowSignalled: false }),
          onSuccess: (delivered) => delivered,
        }),
      )
      // The transport receipt is intentionally not the user-visible truth. A request can resolve
      // after a response loss while the D1 batch rolls back, so only the exact durable row may
      // say that cancellation delivery is complete.
      return yield* repository.recordCancellationSignal(input, receipt)
    }),
})

export const TerminationControlLive = Layer.effect(
  TerminationControl,
  Effect.gen(function* () {
    const repository = yield* TerminationRepository
    const signal = yield* OperationCancellationSignal
    const fingerprint = yield* TerminationFingerprint
    return TerminationControl.of(makeTerminationControl(repository, signal, fingerprint))
  }),
)

export const isCancellationAllowed = (input: {
  readonly policy: CancellationPolicy
  readonly phase: CancellationPhase
}): boolean => {
  if (
    input.policy === 'not-cancellable' ||
    input.phase === 'terminal' ||
    input.phase === 'step-running' ||
    input.phase === 'destructive-step-running'
  )
    return false
  if (input.policy === 'before-destructive-step') return input.phase === 'before-destructive-step'
  return input.phase === 'between-steps'
}

/**
 * An opaque, fenced execution lease. The side-effect adapter must carry this identity into its
 * own idempotency/ownership metadata so that an expired claimant can be reconciled exactly.
 */
export interface WorkflowStepLease {
  readonly claimId: string
  readonly attempt: number
  readonly expiresAt: string
}

/**
 * Durable evidence that one exact step claim has applied its side effect. `effectId` is the
 * provider/agent operation identity, never a provider response body; the SHA-256 fingerprint
 * binds its observed outcome without retaining secrets or raw provider payloads.
 */
export interface WorkflowStepEffectReceipt {
  readonly effectId: string
  readonly outcomeFingerprint: Sha256Fingerprint
}

/**
 * An expired lease is never blindly replayed. The resource-operation owner must distinguish an
 * exact applied effect from a definitely unapplied effect; ambiguous provider truth stays pending
 * for reconciliation.
 */
export type WorkflowStepEffectObservation =
  | { readonly state: 'applied'; readonly receipt: WorkflowStepEffectReceipt }
  | { readonly state: 'not-applied' }
  | { readonly state: 'unknown' }

export interface WorkflowStepClaim {
  readonly disposition:
    | 'execute'
    | 'effect-adopted'
    | 'already-completed'
    | 'in-progress'
    | 'reconciliation-required'
    | 'cancelled'
  readonly operation: TerminationOperation
  readonly facts: OperationCancellationFacts
  readonly lease?: WorkflowStepLease
  readonly effectReceipt?: WorkflowStepEffectReceipt
}

export interface WorkflowStepRepositoryShape {
  readonly claimStep: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly workflowType: string
    readonly workflowInstanceId: string
    readonly stepName: string
    readonly ordinal: number
    readonly destructive: boolean
    readonly claimId: string
    readonly leaseExpiresAt: string
    readonly now: string
  }) => Effect.Effect<WorkflowStepClaim, TerminationPersistenceError | TerminationConflictError>
  /**
   * Resolves only the exact expired lease. A definitely-unapplied observation transfers the
   * lease to `nextClaimId`; an applied observation writes durable evidence and is completed
   * without reissuing the side effect; unknown truth remains reconciliation-required.
   */
  readonly resolveExpiredStepClaim: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly stepName: string
    readonly ordinal: number
    readonly destructive: boolean
    readonly previousLease: WorkflowStepLease
    readonly observation: WorkflowStepEffectObservation
    readonly nextClaimId: string
    readonly nextLeaseExpiresAt: string
    readonly now: string
  }) => Effect.Effect<WorkflowStepClaim, TerminationPersistenceError | TerminationConflictError>
  /** Records exact post-side-effect evidence before a step can become completed. */
  readonly recordStepEffectReceipt: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly stepName: string
    readonly ordinal: number
    readonly lease: WorkflowStepLease
    readonly receipt: WorkflowStepEffectReceipt
    readonly now: string
  }) => Effect.Effect<
    WorkflowStepEffectReceipt,
    TerminationPersistenceError | TerminationConflictError
  >
  readonly completeStep: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly stepName: string
    readonly ordinal: number
    readonly lease: WorkflowStepLease
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  /**
   * Marks cancelled only after the caller has stopped side effects. It releases only reservations
   * whose operation_id matches this exact cancelled operation.
   */
  readonly finalizeCancellation: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
}
export class WorkflowStepRepository extends Context.Service<
  WorkflowStepRepository,
  WorkflowStepRepositoryShape
>()('@gridora/lifecycle-termination-control/WorkflowStepRepository') {}
export const WorkflowStepRepositoryLayer = (repository: WorkflowStepRepositoryShape) =>
  Layer.succeed(WorkflowStepRepository, repository)

export interface TerminationWorkflowStartRepositoryShape {
  readonly loadExact: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly startRecordId: string
  }) => Effect.Effect<
    TerminationWorkflowStart,
    TerminationPersistenceError | TerminationConflictError
  >
  readonly markStartedOrAdopted: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly startRecordId: string
    readonly state: 'started' | 'adopted'
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  readonly recordStartFailure: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly startRecordId: string
    readonly code: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
}
export class TerminationWorkflowStartRepository extends Context.Service<
  TerminationWorkflowStartRepository,
  TerminationWorkflowStartRepositoryShape
>()('@gridora/lifecycle-termination-control/TerminationWorkflowStartRepository') {}
export const TerminationWorkflowStartRepositoryLayer = (
  repository: TerminationWorkflowStartRepositoryShape,
) => Layer.succeed(TerminationWorkflowStartRepository, repository)

export interface NodeTerminationAffectedServer {
  readonly serverId: string
  readonly deploymentId: string
  readonly desiredRevision: number
  readonly state: 'pending' | 'moved' | 'deleted'
}

export interface NodeProviderRetirementReceipt {
  readonly state: ProviderRetirementState
  readonly billingState: ProviderBillingState
  readonly cancellationDate?: string
  readonly billingStopsAt?: string
  readonly providerRequestReference?: string
}

export interface NodeProviderActionClaim {
  readonly disposition: 'execute' | 'blocked' | 'cancelled'
  readonly state: NodeTerminationState
  readonly reason?: 'active-deployments' | 'backup-evidence-missing' | 'not-drained'
}

/** Immutable, operation-bound token handoff for a rebuild image boot. */
export interface NodeRebuildBootstrap {
  readonly disposition: 'prepared' | 'adopted'
  readonly organizationId: string
  readonly operationId: string
  readonly nodeId: string
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerInstanceId: string
  readonly imageId: string
  readonly imageVersion: string
  readonly imageChecksum: string
  readonly providerImageId: string
  readonly tokenRecordId: string
  /** Hash of the scoped HMAC bytes, used only to recover the one-time token. */
  readonly derivationTokenHash: string
  /** Hash of the hex token delivered to the image helper and presented by the agent. */
  readonly tokenHash: string
  readonly keyVersion: number
  readonly expiresAt: string
  readonly nodeDesiredRevision: number
  readonly state: 'prepared' | 'provider-rebuilding' | 'awaiting-agent' | 'blocked' | 'ready'
}

export interface NodeProviderRebuildObservation {
  readonly state: 'rebuilding' | 'active' | 'missing' | 'unknown'
}

export interface NodeTerminationRepositoryShape {
  readonly listAffectedServers: (input: {
    readonly organizationId: string
    readonly operationId: string
  }) => Effect.Effect<ReadonlyArray<NodeTerminationAffectedServer>, TerminationPersistenceError>
  readonly markAffectedServerResolved: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly serverId: string
    readonly disposition: 'moved' | 'deleted'
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  readonly completeNodeDrain: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly now: string
  }) => Effect.Effect<
    { readonly state: NodeTerminationState },
    TerminationPersistenceError | TerminationConflictError
  >
  /** The only admission path to rebuild/retire provider side effects. */
  readonly claimNodeProviderDestructiveAction: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly now: string
  }) => Effect.Effect<
    NodeProviderActionClaim,
    TerminationPersistenceError | TerminationConflictError
  >
  /**
   * Atomically revokes the replaced credential epoch, binds a newly-derived
   * token to this rebuild operation, and moves the node to its target image.
   * A replay can adopt only the exact same token identity and expiry.
   */
  readonly prepareNodeRebuildBootstrap: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly tokenRecordId: string
    readonly derivationTokenHash: string
    readonly tokenHash: string
    readonly keyVersion: number
    readonly expiresAt: string
    readonly now: string
  }) => Effect.Effect<NodeRebuildBootstrap, TerminationPersistenceError | TerminationConflictError>
  readonly loadNodeRebuildBootstrap: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
  }) => Effect.Effect<
    NodeRebuildBootstrap | null,
    TerminationPersistenceError | TerminationConflictError
  >
  /** Records a read-only post-call provider observation; it never authorizes a second rebuild. */
  readonly recordNodeProviderRebuildObservation: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly observation: NodeProviderRebuildObservation
    readonly now: string
  }) => Effect.Effect<NodeRebuildBootstrap, TerminationPersistenceError | TerminationConflictError>
  /** Promotes the node only from a new-token, exact ready observation receipt. */
  readonly completeNodeRebuild: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly now: string
  }) => Effect.Effect<
    { readonly state: 'completed' },
    TerminationPersistenceError | TerminationConflictError
  >
  readonly recordNodeProviderRetirement: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly receipt: NodeProviderRetirementReceipt
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  /**
   * Persists a Cloudflare Tunnel deletion only after the executor has deleted
   * the exact immutable tunnel id/revision. A changed tunnel row is never
   * treated as evidence for an older retirement operation.
   */
  readonly recordNodeTunnelDeleted: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly tunnelId: string
    readonly expectedTunnelRevision: number
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  /** Revokes only tenant-scoped credentials, sessions, and unconsumed registration tokens for this run. */
  readonly revokeNodeCredentials: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  readonly finalizeNodeRetirement: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
}
export class NodeTerminationRepository extends Context.Service<
  NodeTerminationRepository,
  NodeTerminationRepositoryShape
>()('@gridora/lifecycle-termination-control/NodeTerminationRepository') {}
export const NodeTerminationRepositoryLayer = (repository: NodeTerminationRepositoryShape) =>
  Layer.succeed(NodeTerminationRepository, repository)

export const DeletionInventoryItemKind = Schema.Literals([
  'node',
  'game-server',
  'deployment',
  'backup',
  'tunnel',
  'dns-record',
  'node-credential',
  'node-registration-token',
  'agent-session',
  'automation-identity',
  'provider-account',
  'server-capacity-reservation',
  'port-lease',
])
export type DeletionInventoryItemKind = typeof DeletionInventoryItemKind.Type

export interface OrganizationDeletionInventory {
  readonly unresolvedPaidResources: number
  readonly unresolvedResources: number
  readonly retainedBackups: number
  readonly blockedReason?: string
}

export interface OrganizationDeletionRepositoryShape {
  readonly inventory: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly now: string
  }) => Effect.Effect<
    OrganizationDeletionInventory,
    TerminationPersistenceError | TerminationConflictError
  >
  readonly markItemResolved: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly kind: DeletionInventoryItemKind
    readonly resourceId: string
    readonly disposition: 'resolved' | 'retained' | 'ambiguous'
    readonly evidence: Readonly<Record<string, unknown>>
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  /** Revokes tenant credentials and disables organization-scoped provider access before tombstoning. */
  readonly revokeOrganizationCredentials: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  /** Releases only reservations in this organization, then records their physical resolution. */
  readonly releaseOrganizationReservations: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  readonly prepareTombstone: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly now: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
  readonly tombstone: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly now: string
    readonly retentionUntil: string
  }) => Effect.Effect<void, TerminationPersistenceError | TerminationConflictError>
}
export class OrganizationDeletionRepository extends Context.Service<
  OrganizationDeletionRepository,
  OrganizationDeletionRepositoryShape
>()('@gridora/lifecycle-termination-control/OrganizationDeletionRepository') {}
export const OrganizationDeletionRepositoryLayer = (
  repository: OrganizationDeletionRepositoryShape,
) => Layer.succeed(OrganizationDeletionRepository, repository)

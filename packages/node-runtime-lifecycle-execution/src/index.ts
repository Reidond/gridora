import { Context, Effect, Layer, Schema } from 'effect'
import {
  type NodeRuntimeLifecycleAction,
  type NodeRuntimeObservedState,
} from '@gridora/node-runtime-lifecycle-control'
import {
  type ProviderNodeLifecycleCredentialBinding,
  type ProviderNodeLifecycleObservation,
  type ProviderNodeLifecycleTarget,
  type ProviderNodeLifecycleTransportShape,
} from '@gridora/provider-node-lifecycle-transports'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderUnsupportedCapabilityError,
  ProviderValidationError,
  type ProviderError,
} from '@gridora/provider-sdk'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)

/** Internal Workflow request. It is not part of any public API contract. */
export const NodeRuntimeLifecycleExecutionRequest = Schema.Struct({
  organizationId: Identifier,
  operationId: Identifier,
  leaseOwner: Identifier,
  attemptedAt: Timestamp,
})
export type NodeRuntimeLifecycleExecutionRequest = typeof NodeRuntimeLifecycleExecutionRequest.Type

export interface NodeRuntimeLifecycleExecutionReservation {
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly action: NodeRuntimeLifecycleAction
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerInstanceId: string
  readonly credentialBinding: ProviderNodeLifecycleCredentialBinding
  readonly previousDesiredState: 'ready' | 'stopped'
  readonly previousDesiredRevision: number
  readonly desiredState: 'ready' | 'stopped'
  readonly desiredRevision: number
}

export interface NodeRuntimeLifecycleExecutionLease {
  readonly owner: string
  readonly token: string
  readonly attempt: number
  readonly expiresAt: string
}

export interface NodeRuntimeLifecycleExecutionResult {
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly action: NodeRuntimeLifecycleAction
  readonly state:
    | 'succeeded'
    | 'waiting-observation'
    | 'reconciliation-required'
    | 'failed-terminal'
  readonly operationStatus: 'succeeded' | 'waiting_external' | 'failed_terminal'
  readonly providerState: ProviderNodeLifecycleObservation['providerState']
  readonly rebootConfirmed: boolean
  readonly observedState: NodeRuntimeObservedState
}

export type NodeRuntimeLifecycleExecutionClaim =
  | {
      readonly disposition: 'dispatch'
      readonly reservation: NodeRuntimeLifecycleExecutionReservation
      readonly lease: NodeRuntimeLifecycleExecutionLease
      /** An expired lease with no dispatch mark is safe to send once under its new lease. */
      readonly recovery: 'fresh' | 'lease-expired-before-mark'
    }
  | {
      readonly disposition: 'observe'
      readonly reservation: NodeRuntimeLifecycleExecutionReservation
      readonly lease: NodeRuntimeLifecycleExecutionLease
      /** An action was marked durably but its provider delivery is now unknown. */
      readonly recovery: 'action-requested-expired' | 'observation-retry'
    }
  | { readonly disposition: 'adopted'; readonly result: NodeRuntimeLifecycleExecutionResult }
  | { readonly disposition: 'in-progress' }

export type NodeRuntimeLifecycleObservationRecovery =
  | 'fresh'
  | 'action-requested-expired'
  | 'observation-retry'
  /** D1 committed the dispatch mark, but this Worker never reached the provider call. */
  | 'dispatch-uncertain'

export class NodeRuntimeLifecycleExecutionValidationError extends Schema.TaggedError<NodeRuntimeLifecycleExecutionValidationError>()(
  'NodeRuntimeLifecycleExecutionValidationError',
  { code: Schema.String },
) {}
export class NodeRuntimeLifecycleExecutionPersistenceError extends Schema.TaggedError<NodeRuntimeLifecycleExecutionPersistenceError>()(
  'NodeRuntimeLifecycleExecutionPersistenceError',
  { operation: Schema.String },
) {}
export class NodeRuntimeLifecycleExecutionConflictError extends Schema.TaggedError<NodeRuntimeLifecycleExecutionConflictError>()(
  'NodeRuntimeLifecycleExecutionConflictError',
  { operation: Schema.String },
) {}

export type NodeRuntimeLifecycleExecutionError =
  | NodeRuntimeLifecycleExecutionValidationError
  | NodeRuntimeLifecycleExecutionPersistenceError
  | NodeRuntimeLifecycleExecutionConflictError

export interface NodeRuntimeLifecycleExecutionRepositoryShape {
  /**
   * A `dispatch` claim exists only for a brand-new `pending` record. All expiry/retry paths are
   * observation-only so a response loss can never issue a second provider request.
   */
  readonly claim: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly owner: string
    readonly token: string
    readonly leaseExpiresAt: string
    readonly now: string
  }) => Effect.Effect<
    NodeRuntimeLifecycleExecutionClaim,
    NodeRuntimeLifecycleExecutionPersistenceError | NodeRuntimeLifecycleExecutionConflictError
  >
  /**
   * Commits the provider action dispatch intent before the provider network call. `delivery-unknown`
   * means the D1 response was lost after the durable mark; the caller must observe and reconcile,
   * never issue a second provider request.
   */
  readonly markActionRequested: (input: {
    readonly reservation: NodeRuntimeLifecycleExecutionReservation
    readonly lease: NodeRuntimeLifecycleExecutionLease
    readonly requestedAt: string
  }) => Effect.Effect<
    'marked' | 'delivery-unknown',
    NodeRuntimeLifecycleExecutionPersistenceError | NodeRuntimeLifecycleExecutionConflictError
  >
  /** Atomically updates provider observation, node projection, operation, audit, and event evidence. */
  readonly recordObservation: (input: {
    readonly reservation: NodeRuntimeLifecycleExecutionReservation
    readonly lease: NodeRuntimeLifecycleExecutionLease
    readonly phase: 'leased' | 'action-requested'
    readonly observation: ProviderNodeLifecycleObservation
    readonly recovery: NodeRuntimeLifecycleObservationRecovery
    readonly observedAt: string
  }) => Effect.Effect<
    NodeRuntimeLifecycleExecutionResult,
    NodeRuntimeLifecycleExecutionPersistenceError | NodeRuntimeLifecycleExecutionConflictError
  >
  /** Stores a redacted terminal code only. Provider messages and credential material are forbidden. */
  readonly recordTerminalFailure: (input: {
    readonly reservation: NodeRuntimeLifecycleExecutionReservation
    readonly lease: NodeRuntimeLifecycleExecutionLease
    readonly phase: 'leased' | 'action-requested'
    readonly code: 'provider_authorization_blocked' | 'provider_validation_blocked'
    readonly failedAt: string
  }) => Effect.Effect<
    NodeRuntimeLifecycleExecutionResult,
    NodeRuntimeLifecycleExecutionPersistenceError | NodeRuntimeLifecycleExecutionConflictError
  >
}
export class NodeRuntimeLifecycleExecutionRepository extends Context.Service<
  NodeRuntimeLifecycleExecutionRepository,
  NodeRuntimeLifecycleExecutionRepositoryShape
>()('@gridora/node-runtime-lifecycle-execution/NodeRuntimeLifecycleExecutionRepository') {}
export const NodeRuntimeLifecycleExecutionRepositoryLayer = (
  repository: NodeRuntimeLifecycleExecutionRepositoryShape,
) => Layer.succeed(NodeRuntimeLifecycleExecutionRepository, repository)

export interface NodeRuntimeLifecycleLeaseTokenPortShape {
  readonly next: () => string
}
export class NodeRuntimeLifecycleLeaseTokenPort extends Context.Service<
  NodeRuntimeLifecycleLeaseTokenPort,
  NodeRuntimeLifecycleLeaseTokenPortShape
>()('@gridora/node-runtime-lifecycle-execution/NodeRuntimeLifecycleLeaseTokenPort') {}
export const NodeRuntimeLifecycleLeaseTokenPortLayer = (
  port: NodeRuntimeLifecycleLeaseTokenPortShape,
) => Layer.succeed(NodeRuntimeLifecycleLeaseTokenPort, port)

export const webCryptoNodeRuntimeLifecycleLeaseTokens: NodeRuntimeLifecycleLeaseTokenPortShape = {
  next: () => crypto.randomUUID(),
}

export class ProviderNodeLifecycleTransport extends Context.Service<
  ProviderNodeLifecycleTransport,
  ProviderNodeLifecycleTransportShape
>()('@gridora/node-runtime-lifecycle-execution/ProviderNodeLifecycleTransport') {}
export const ProviderNodeLifecycleTransportLayer = (
  transport: ProviderNodeLifecycleTransportShape,
) => Layer.succeed(ProviderNodeLifecycleTransport, transport)

const validateRequest = (request: NodeRuntimeLifecycleExecutionRequest) =>
  Schema.decodeUnknownEffect(NodeRuntimeLifecycleExecutionRequest, { onExcessProperty: 'error' })(
    request,
  ).pipe(
    Effect.asVoid,
    Effect.mapError(
      () => new NodeRuntimeLifecycleExecutionValidationError({ code: 'invalid_execution_request' }),
    ),
  )

const leaseExpiry = (
  timestamp: string,
  durationMilliseconds: number,
): Effect.Effect<string, NodeRuntimeLifecycleExecutionValidationError> => {
  const epochMilliseconds = Date.parse(timestamp)
  if (
    !Number.isFinite(epochMilliseconds) ||
    !Number.isInteger(durationMilliseconds) ||
    durationMilliseconds < 30_000 ||
    durationMilliseconds > 60 * 60_000
  )
    return Effect.fail(
      new NodeRuntimeLifecycleExecutionValidationError({ code: 'invalid_execution_lease' }),
    )
  return Effect.succeed(new Date(epochMilliseconds + durationMilliseconds).toISOString())
}

const targetFor = (
  reservation: NodeRuntimeLifecycleExecutionReservation,
): ProviderNodeLifecycleTarget => ({
  provider: reservation.providerType,
  organizationId: reservation.organizationId,
  operationId: reservation.operationId,
  nodeId: reservation.nodeId,
  providerNodeId: reservation.providerInstanceId,
  credentialBinding: reservation.credentialBinding,
})

const terminalCode = (
  error: ProviderError,
): 'provider_authorization_blocked' | 'provider_validation_blocked' =>
  error instanceof ProviderAuthenticationError || error instanceof ProviderAuthorizationError
    ? 'provider_authorization_blocked'
    : error instanceof ProviderValidationError ||
        error instanceof ProviderUnsupportedCapabilityError
      ? 'provider_validation_blocked'
      : 'provider_validation_blocked'

/**
 * Execution is deliberately one-way: `markActionRequested` is durable before the provider call.
 * If this Workflow crashes at any later point, its next delivery obtains an observe-only claim.
 */
export interface NodeRuntimeLifecycleExecutionShape {
  readonly execute: (request: NodeRuntimeLifecycleExecutionRequest) => Effect.Effect<
    | {
        readonly disposition: 'executed' | 'adopted'
        readonly result: NodeRuntimeLifecycleExecutionResult
      }
    | { readonly disposition: 'in-progress' },
    NodeRuntimeLifecycleExecutionError
  >
}
export class NodeRuntimeLifecycleExecution extends Context.Service<
  NodeRuntimeLifecycleExecution,
  NodeRuntimeLifecycleExecutionShape
>()('@gridora/node-runtime-lifecycle-execution/NodeRuntimeLifecycleExecution') {}

export const makeNodeRuntimeLifecycleExecution = (dependencies: {
  readonly repository: NodeRuntimeLifecycleExecutionRepositoryShape
  readonly transport: ProviderNodeLifecycleTransportShape
  readonly leaseTokens: NodeRuntimeLifecycleLeaseTokenPortShape
  readonly leaseDurationMilliseconds?: number
}): NodeRuntimeLifecycleExecutionShape => ({
  execute: (request) =>
    Effect.gen(function* () {
      yield* validateRequest(request)
      const token = dependencies.leaseTokens.next()
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(token) || token.length > 128)
        return yield* new NodeRuntimeLifecycleExecutionValidationError({
          code: 'invalid_lease_token',
        })
      const expiresAt = yield* leaseExpiry(
        request.attemptedAt,
        dependencies.leaseDurationMilliseconds ?? 5 * 60_000,
      )
      const claim = yield* dependencies.repository.claim({
        organizationId: request.organizationId,
        operationId: request.operationId,
        owner: request.leaseOwner,
        token,
        leaseExpiresAt: expiresAt,
        now: request.attemptedAt,
      })
      if (claim.disposition === 'adopted')
        return { disposition: 'adopted' as const, result: claim.result }
      if (claim.disposition === 'in-progress') return { disposition: 'in-progress' as const }

      const { reservation, lease } = claim
      const target = targetFor(reservation)
      const sideEffectAction = reservation.action === 'reconcile' ? null : reservation.action
      const dispatchMark =
        claim.disposition === 'dispatch' && sideEffectAction !== null
          ? yield* dependencies.repository.markActionRequested({
              reservation,
              lease,
              requestedAt: request.attemptedAt,
            })
          : null
      const phase: 'leased' | 'action-requested' =
        dispatchMark === null ? ('leased' as const) : ('action-requested' as const)
      const recovery: NodeRuntimeLifecycleObservationRecovery =
        dispatchMark === 'delivery-unknown'
          ? 'dispatch-uncertain'
          : claim.disposition === 'dispatch'
            ? 'fresh'
            : claim.recovery
      const observation =
        dispatchMark === 'marked' && sideEffectAction !== null
          ? yield* Effect.result(
              dependencies.transport.dispatchAndObserve({ ...target, action: sideEffectAction }),
            )
          : yield* Effect.result(dependencies.transport.observe(target))
      if (observation._tag === 'Failure') {
        // The transport turns uncertain provider outcomes into an `unknown` observation. Only
        // explicit auth/configuration failures reach here and are stored without their message.
        const providerFailure = observation.failure
        const result = yield* dependencies.repository.recordTerminalFailure({
          reservation,
          lease,
          phase,
          code: terminalCode(providerFailure),
          failedAt: request.attemptedAt,
        })
        return { disposition: 'executed' as const, result }
      }
      const result = yield* dependencies.repository.recordObservation({
        reservation,
        lease,
        phase,
        observation: observation.success,
        recovery,
        observedAt: request.attemptedAt,
      })
      return { disposition: 'executed' as const, result }
    }),
})

export const NodeRuntimeLifecycleExecutionLive = Layer.effect(
  NodeRuntimeLifecycleExecution,
  Effect.gen(function* () {
    return NodeRuntimeLifecycleExecution.of(
      makeNodeRuntimeLifecycleExecution({
        repository: yield* NodeRuntimeLifecycleExecutionRepository,
        transport: yield* ProviderNodeLifecycleTransport,
        leaseTokens: yield* NodeRuntimeLifecycleLeaseTokenPort,
      }),
    )
  }),
)

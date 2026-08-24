import { Effect } from 'effect'
import {
  NodeRuntimeLifecycleCapabilityError,
  type NodeRuntimeLifecycleAction,
  type NodeRuntimeLifecycleCapabilityPortShape,
} from '@gridora/node-runtime-lifecycle-control'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderUnsupportedCapabilityError,
  ProviderValidationError,
  type ComputeProviderShape,
  type ProviderError,
  type ProviderNode,
} from '@gridora/provider-sdk'

export interface ProviderNodeLifecycleCapabilities {
  readonly start: boolean
  readonly stop: boolean
  readonly reboot: boolean
  readonly observe: boolean
}

/** Exact provider-account and encrypted-envelope coordinates accepted under the tenant transaction. */
export interface ProviderNodeLifecycleCredentialBinding {
  readonly providerAccountId: string
  readonly providerAccountScope: 'platform' | 'organization'
  readonly providerAccountRevision: number
  readonly providerAllocationRevision: number
  readonly providerCredentialReference: string
  readonly providerCredentialRevision: number
}

export interface ProviderNodeLifecycleTarget {
  readonly provider: 'ovhcloud' | 'contabo'
  readonly organizationId: string
  readonly operationId: string
  readonly nodeId: string
  readonly providerNodeId: string
  readonly credentialBinding: ProviderNodeLifecycleCredentialBinding
}

/**
 * This is a provider fact only. `active` never means Gridora node readiness: agent, tunnel,
 * image, Docker, capacity, and firewall observations remain separate evidence.
 */
export interface ProviderNodeLifecycleObservation {
  readonly providerState: 'active' | 'stopped' | 'transitional' | 'missing' | 'unknown'
  /** False unless a provider-specific adapter has independent reboot completion evidence. */
  readonly rebootConfirmed: boolean
  /**
   * Only a provider-specific idempotency/operation receipt may set this. A state such as
   * `stopped` or `active` by itself is never proof that a prior action was not sent.
   */
  readonly actionNotApplied: boolean
  /**
   * Exact provider-reported address literals for the owned node. An omitted
   * field means the provider observation was uncertain; an empty array is a
   * definite observation that removes DNS authority rather than retaining a
   * stale player endpoint.
   */
  readonly playerAddresses?: readonly string[]
  readonly observedAt: string
}

export interface ProviderNodeLifecycleTransportShape extends NodeRuntimeLifecycleCapabilityPortShape {
  readonly dispatchAndObserve: (
    input: ProviderNodeLifecycleTarget & {
      readonly action: Exclude<NodeRuntimeLifecycleAction, 'reconcile'>
    },
  ) => Effect.Effect<ProviderNodeLifecycleObservation, ProviderError>
  readonly observe: (
    input: ProviderNodeLifecycleTarget,
  ) => Effect.Effect<ProviderNodeLifecycleObservation, ProviderError>
}

export interface ProviderRuntimeLifecycleAdapter {
  readonly provider: ComputeProviderShape
  readonly capabilities: ProviderNodeLifecycleCapabilities
}

/**
 * Composition opens a provider client using this exact account/envelope revision. The opener owns
 * decrypted credential bytes and must clear them before returning or failing. It must never fall
 * back to an arbitrary same-provider account.
 */
export interface ProviderNodeLifecycleAdapterResolverShape {
  readonly openExact: (
    input: ProviderNodeLifecycleTarget,
  ) => Effect.Effect<ProviderRuntimeLifecycleAdapter, ProviderError>
}

const unsafeToMask = (error: ProviderError): boolean =>
  error instanceof ProviderAuthenticationError ||
  error instanceof ProviderAuthorizationError ||
  error instanceof ProviderValidationError ||
  error instanceof ProviderUnsupportedCapabilityError

const capabilityFor = (
  action: NodeRuntimeLifecycleAction,
): keyof ProviderNodeLifecycleCapabilities => (action === 'reconcile' ? 'observe' : action)

const inputFor = (input: ProviderNodeLifecycleTarget) => ({
  organizationId: input.organizationId,
  operationId: input.operationId,
  nodeId: input.nodeId,
  providerNodeId: input.providerNodeId,
})

const stateFor = (node: ProviderNode): ProviderNodeLifecycleObservation['providerState'] => {
  switch (node.state) {
    case 'active':
      return 'active'
    case 'stopped':
      return 'stopped'
    case 'creating':
    case 'rebuilding':
    case 'retiring':
      return 'transitional'
    case 'retired':
      return 'missing'
    case 'unknown':
      return 'unknown'
  }
}

const owns = (node: ProviderNode, input: ProviderNodeLifecycleTarget): boolean =>
  node.metadata.managedBy === 'gridora' &&
  node.metadata.organizationId === input.organizationId &&
  node.metadata.nodeId === input.nodeId

const ownershipError = (input: ProviderNodeLifecycleTarget) =>
  new ProviderAuthorizationError({
    provider: input.provider,
    operation: 'nodeRuntimeLifecycle.observe',
    message: 'Provider node is outside the requested organization/node scope',
  })

const unknownObservation = (timestamp: string): ProviderNodeLifecycleObservation => ({
  providerState: 'unknown',
  rebootConfirmed: false,
  actionNotApplied: false,
  observedAt: timestamp,
})

const unsupported = (input: {
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly action: NodeRuntimeLifecycleAction
}) =>
  new NodeRuntimeLifecycleCapabilityError({
    providerType: input.providerType,
    action: input.action,
  })

/**
 * The capability map is intentionally explicit. Existing provider SDK capability fields describe
 * commercial/image features, while these four booleans bind the lifecycle adapter deployed for
 * this Worker. The transport checks it again immediately before a provider side effect.
 */
export const makeProviderNodeLifecycleTransport = (input: {
  /** Admission capability map. Execution separately opens the exact account-scoped adapter. */
  readonly capabilities: Readonly<{
    ovhcloud: ProviderNodeLifecycleCapabilities
    contabo: ProviderNodeLifecycleCapabilities
  }>
  readonly resolver: ProviderNodeLifecycleAdapterResolverShape
  readonly now?: () => string
}): ProviderNodeLifecycleTransportShape => {
  const now = input.now ?? (() => new Date().toISOString())
  const capabilitiesFor = (provider: 'ovhcloud' | 'contabo'): ProviderNodeLifecycleCapabilities =>
    input.capabilities[provider]

  const assertSupported: NodeRuntimeLifecycleCapabilityPortShape['assertSupported'] = ({
    providerType,
    action,
  }) =>
    capabilitiesFor(providerType)[capabilityFor(action)]
      ? Effect.void
      : Effect.fail(unsupported({ providerType, action }))

  const observe = (
    target: ProviderNodeLifecycleTarget,
  ): Effect.Effect<ProviderNodeLifecycleObservation, ProviderError> =>
    input.resolver.openExact(target).pipe(
      Effect.flatMap((adapter) => {
        if (!adapter.capabilities.observe)
          return Effect.fail(
            new ProviderUnsupportedCapabilityError({
              provider: target.provider,
              operation: 'nodeRuntimeLifecycle.observe',
              capability: 'observe',
              message: 'Provider lifecycle observation is not supported',
            }),
          )
        return adapter.provider
          .getNode({ organizationId: target.organizationId, providerNodeId: target.providerNodeId })
          .pipe(
            Effect.flatMap((providerNode) =>
              owns(providerNode, target)
                ? Effect.succeed({
                    providerState: stateFor(providerNode),
                    rebootConfirmed: false,
                    actionNotApplied: false,
                    playerAddresses: providerNode.addresses,
                    observedAt: now(),
                  } as const)
                : Effect.fail(ownershipError(target)),
            ),
            Effect.catchTag('ProviderNotFoundError', () =>
              Effect.succeed({
                providerState: 'missing' as const,
                rebootConfirmed: false,
                actionNotApplied: false,
                observedAt: now(),
              }),
            ),
            Effect.catch((error) =>
              unsafeToMask(error) ? Effect.fail(error) : Effect.succeed(unknownObservation(now())),
            ),
          )
      }),
    )

  const dispatchAndObserve: ProviderNodeLifecycleTransportShape['dispatchAndObserve'] = (
    target,
  ) => {
    return input.resolver.openExact(target).pipe(
      Effect.flatMap((adapter) => {
        if (!adapter.capabilities[capabilityFor(target.action)])
          return Effect.fail(
            new ProviderUnsupportedCapabilityError({
              provider: target.provider,
              operation: `nodeRuntimeLifecycle.${target.action}`,
              capability: target.action,
              message: 'Provider lifecycle action is not supported',
            }),
          )
        const request = inputFor(target)
        const dispatch =
          target.action === 'start'
            ? adapter.provider.startNode(request)
            : target.action === 'stop'
              ? adapter.provider.stopNode(request)
              : adapter.provider.rebootNode(request)
        // A definite provider rejection before an action is accepted is safe to expose to the
        // execution layer. Once the action succeeds or its response is ambiguous, every later
        // observation failure is delivery-uncertain and must become an unknown observation; it
        // must never cause a terminal rollback of a possibly successful provider action.
        const observeAfterPossibleDispatch = () =>
          observe(target).pipe(Effect.catch(() => Effect.succeed(unknownObservation(now()))))
        return dispatch.pipe(
          Effect.matchEffect({
            onSuccess: observeAfterPossibleDispatch,
            onFailure: (error) =>
              unsafeToMask(error) ? Effect.fail(error) : observeAfterPossibleDispatch(),
          }),
        )
      }),
    )
  }

  return { assertSupported, dispatchAndObserve, observe }
}

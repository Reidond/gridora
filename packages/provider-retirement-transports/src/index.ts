import { Effect } from 'effect'
import type { NodeProviderRetirementReceipt } from '@gridora/lifecycle-termination-control'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderValidationError,
  type ComputeProviderShape,
  type ProviderError,
  type ProviderNode,
} from '@gridora/provider-sdk'

export interface ProviderRetirementInput {
  readonly provider: 'ovhcloud' | 'contabo'
  readonly organizationId: string
  readonly operationId: string
  readonly nodeId: string
  readonly providerNodeId: string
}

/**
 * Reimage only a provider instance that is already frozen into a rebuild
 * lifecycle operation.  The cloud-init token is one-time and is deliberately
 * absent from observations and receipts.
 */
export interface ProviderRebuildInput extends ProviderRetirementInput {
  readonly imageId: string
  readonly imageVersion: string
  /** Present only for the one fresh provider call; observations never carry it. */
  readonly cloudInit?: string
}

export type ProviderRebuildObservation =
  | { readonly state: 'active' }
  | { readonly state: 'rebuilding' }
  | { readonly state: 'missing' }
  | { readonly state: 'unknown' }

/**
 * These are provider observations, not desired states. In particular, a Contabo instance is never
 * represented as deleted until its contract has actually ended, and OVH needs a post-delete 404.
 */
export type ProviderRetirementObservation =
  | {
      readonly state: 'deleted-confirmed'
      readonly billingState: 'stopped'
      readonly providerRequestReference?: string
    }
  | {
      readonly state: 'contract-ended'
      readonly billingState: 'stopped'
      readonly billingStopsAt?: string
      readonly providerRequestReference?: string
    }
  | {
      readonly state: 'delete-requested'
      readonly billingState: 'unknown'
      readonly providerRequestReference?: string
    }
  | {
      readonly state: 'secure-wipe-completed'
      readonly billingState: 'continues-until-cancellation'
      readonly cancellationDate?: string
      readonly providerRequestReference?: string
    }
  | {
      readonly state: 'cancel-scheduled'
      readonly billingState: 'continues-until-cancellation'
      readonly cancellationDate: string
      readonly billingStopsAt: string
      readonly providerRequestReference?: string
    }
  | {
      readonly state: 'ambiguous'
      readonly billingState: 'unknown'
      readonly providerRequestReference?: string
    }

const inputFor = (input: ProviderRetirementInput) => ({
  organizationId: input.organizationId,
  operationId: input.operationId,
  nodeId: input.nodeId,
  providerNodeId: input.providerNodeId,
})

const unsafeToMask = (error: ProviderError): boolean =>
  error instanceof ProviderAuthenticationError ||
  error instanceof ProviderAuthorizationError ||
  error instanceof ProviderValidationError

const observeRebuild = (
  provider: ComputeProviderShape,
  input: ProviderRebuildInput,
): Effect.Effect<ProviderRebuildObservation, ProviderError> =>
  provider
    .getNode({ organizationId: input.organizationId, providerNodeId: input.providerNodeId })
    .pipe(
      Effect.map((node) =>
        node.state === 'active'
          ? ({ state: 'active' } as const)
          : node.state === 'rebuilding' || node.state === 'creating'
            ? ({ state: 'rebuilding' } as const)
            : ({ state: 'unknown' } as const),
      ),
      Effect.catchTag('ProviderNotFoundError', () => Effect.succeed({ state: 'missing' } as const)),
      Effect.catch((error) =>
        unsafeToMask(error) ? Effect.fail(error) : Effect.succeed({ state: 'unknown' } as const),
      ),
    )

const cancellationFromNode = (node: ProviderNode): ProviderRetirementObservation | null => {
  const cancellationDate = node.contract?.cancellationDate
  const billingStopsAt = node.contract?.billingStopsAt
  return cancellationDate === undefined || billingStopsAt === undefined
    ? null
    : {
        state: 'cancel-scheduled',
        billingState: 'continues-until-cancellation',
        cancellationDate,
        billingStopsAt,
      }
}

const asNodeReceipt = (
  observation: ProviderRetirementObservation,
): NodeProviderRetirementReceipt => {
  switch (observation.state) {
    case 'deleted-confirmed':
      return {
        state: 'deleted-confirmed',
        billingState: 'stopped',
        ...(observation.providerRequestReference === undefined
          ? {}
          : { providerRequestReference: observation.providerRequestReference }),
      }
    case 'contract-ended':
      return {
        state: 'contract-ended',
        billingState: 'stopped',
        ...(observation.billingStopsAt === undefined
          ? {}
          : { billingStopsAt: observation.billingStopsAt }),
        ...(observation.providerRequestReference === undefined
          ? {}
          : { providerRequestReference: observation.providerRequestReference }),
      }
    case 'delete-requested':
      return {
        state: 'delete-requested',
        billingState: 'unknown',
        ...(observation.providerRequestReference === undefined
          ? {}
          : { providerRequestReference: observation.providerRequestReference }),
      }
    case 'secure-wipe-completed':
      return {
        state: 'secure-wipe-completed',
        billingState: 'continues-until-cancellation',
        ...(observation.cancellationDate === undefined
          ? {}
          : { cancellationDate: observation.cancellationDate }),
        ...(observation.providerRequestReference === undefined
          ? {}
          : { providerRequestReference: observation.providerRequestReference }),
      }
    case 'cancel-scheduled':
      return {
        state: 'cancel-scheduled',
        billingState: 'continues-until-cancellation',
        cancellationDate: observation.cancellationDate,
        billingStopsAt: observation.billingStopsAt,
        ...(observation.providerRequestReference === undefined
          ? {}
          : { providerRequestReference: observation.providerRequestReference }),
      }
    case 'ambiguous':
      return {
        state: 'ambiguous',
        billingState: 'unknown',
        ...(observation.providerRequestReference === undefined
          ? {}
          : { providerRequestReference: observation.providerRequestReference }),
      }
  }
}

const postOvhDelete = (
  provider: ComputeProviderShape,
  input: ProviderRetirementInput,
): Effect.Effect<ProviderRetirementObservation, ProviderError> =>
  provider
    .getNode({ organizationId: input.organizationId, providerNodeId: input.providerNodeId })
    .pipe(
      Effect.as({ state: 'delete-requested', billingState: 'unknown' } as const),
      Effect.catchTag('ProviderNotFoundError', () =>
        Effect.succeed({ state: 'deleted-confirmed', billingState: 'stopped' } as const),
      ),
      Effect.catch((error) =>
        unsafeToMask(error)
          ? Effect.fail(error)
          : Effect.succeed({ state: 'ambiguous', billingState: 'unknown' } as const),
      ),
    )

const postContabo = (
  provider: ComputeProviderShape,
  input: ProviderRetirementInput,
): Effect.Effect<ProviderRetirementObservation, ProviderError> =>
  provider
    .getNode({ organizationId: input.organizationId, providerNodeId: input.providerNodeId })
    .pipe(
      Effect.map(
        (node) =>
          cancellationFromNode(node) ?? ({ state: 'ambiguous', billingState: 'unknown' } as const),
      ),
      Effect.catchTag('ProviderNotFoundError', () =>
        Effect.succeed({ state: 'contract-ended', billingState: 'stopped' } as const),
      ),
      Effect.catch((error) =>
        unsafeToMask(error)
          ? Effect.fail(error)
          : Effect.succeed({ state: 'ambiguous', billingState: 'unknown' } as const),
      ),
    )

export interface ProviderRetirementTransportShape {
  readonly retire: (
    input: ProviderRetirementInput,
  ) => Effect.Effect<ProviderRetirementObservation, ProviderError>
  /**
   * Reads the provider's current retirement truth without sending another
   * destructive request. Workflow lease recovery must use this after a
   * response loss or a scheduled cancellation.
   */
  readonly observe: (
    input: ProviderRetirementInput,
  ) => Effect.Effect<ProviderRetirementObservation, ProviderError>
  readonly asNodeReceipt: (
    observation: ProviderRetirementObservation,
  ) => NodeProviderRetirementReceipt
}

export const makeProviderRetirementTransport = (input: {
  readonly ovh: ComputeProviderShape
  readonly contabo: ComputeProviderShape
}): ProviderRetirementTransportShape => ({
  retire: (request) => {
    if (request.provider === 'ovhcloud')
      return input.ovh.retireNode({ ...inputFor(request), mode: 'delete' }).pipe(
        Effect.flatMap(() => postOvhDelete(input.ovh, request)),
        // A timeout after the paid OVH delete POST must never trigger another POST. A post-read
        // either proves deletion or leaves the operation ambiguous for reconciliation.
        Effect.catch((error) =>
          unsafeToMask(error) ? Effect.fail(error) : postOvhDelete(input.ovh, request),
        ),
      )

    return Effect.gen(function* () {
      const current = yield* input.contabo
        .getNode({ organizationId: request.organizationId, providerNodeId: request.providerNodeId })
        .pipe(
          Effect.map((node) => ({ _tag: 'present' as const, node })),
          Effect.catchTag('ProviderNotFoundError', () =>
            Effect.succeed({ _tag: 'ended' as const }),
          ),
          Effect.catch((error) =>
            unsafeToMask(error)
              ? Effect.fail(error)
              : Effect.succeed({ _tag: 'ambiguous' as const }),
          ),
        )
      if (current._tag === 'ended')
        return { state: 'contract-ended', billingState: 'stopped' } as const
      if (current._tag === 'ambiguous')
        return { state: 'ambiguous', billingState: 'unknown' } as const
      const scheduled = cancellationFromNode(current.node)
      if (scheduled !== null) return scheduled
      const wipe = yield* input.contabo
        .retireNode({ ...inputFor(request), mode: 'secure_wipe_and_stop' })
        .pipe(Effect.result)
      if (wipe._tag === 'Failure') {
        if (unsafeToMask(wipe.failure)) return yield* Effect.fail(wipe.failure)
        return yield* postContabo(input.contabo, request)
      }
      const cancellation = yield* input.contabo
        .retireNode({ ...inputFor(request), mode: 'cancel_at_earliest_date' })
        .pipe(Effect.result)
      if (cancellation._tag === 'Success') {
        const result = cancellation.success
        if (result.kind === 'cancel_at_earliest_date' || result.kind === 'cancel_scheduled')
          return {
            state: 'cancel-scheduled',
            billingState: 'continues-until-cancellation',
            cancellationDate: result.cancellationDate,
            billingStopsAt: result.billingStopsAt,
          } as const
      }
      if (cancellation._tag === 'Failure' && unsafeToMask(cancellation.failure))
        return yield* Effect.fail(cancellation.failure)
      // A secure wipe alone is not an end-of-contract result. The post-read only adopts a concrete
      // cancellation schedule; otherwise paid billing remains ambiguous and blocked.
      return yield* postContabo(input.contabo, request)
    })
  },
  observe: (request) =>
    request.provider === 'ovhcloud'
      ? postOvhDelete(input.ovh, request)
      : postContabo(input.contabo, request),
  asNodeReceipt,
})

/**
 * A rebuild request is deliberately once-only.  After the prepared bootstrap
 * handoff survives D1, every retry uses `observe`; a timeout/error after the
 * provider call is resolved by a read, never another paid rebuild POST.
 */
export interface ProviderRebuildTransportShape {
  readonly rebuild: (
    input: ProviderRebuildInput,
  ) => Effect.Effect<ProviderRebuildObservation, ProviderError>
  readonly observe: (
    input: ProviderRebuildInput,
  ) => Effect.Effect<ProviderRebuildObservation, ProviderError>
}

export const makeProviderRebuildTransport = (input: {
  readonly ovh: ComputeProviderShape
  readonly contabo: ComputeProviderShape
}): ProviderRebuildTransportShape => {
  const providerFor = (provider: ProviderRebuildInput['provider']): ComputeProviderShape =>
    provider === 'ovhcloud' ? input.ovh : input.contabo
  return {
    observe: (request) => observeRebuild(providerFor(request.provider), request),
    rebuild: (request) => {
      const provider = providerFor(request.provider)
      return provider
        .rebuildNode({
          ...inputFor(request),
          imageId: request.imageId,
          imageVersion: request.imageVersion,
          ...(request.cloudInit === undefined ? {} : { cloudInit: request.cloudInit }),
        })
        .pipe(
          Effect.flatMap(() => observeRebuild(provider, request)),
          Effect.catch((error) =>
            unsafeToMask(error) ? Effect.fail(error) : observeRebuild(provider, request),
          ),
        )
    },
  }
}

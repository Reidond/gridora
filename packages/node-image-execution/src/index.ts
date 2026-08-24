import { Context, Effect, Layer, Schema } from 'effect'
import type {
  NodeImageExecutionRepositoryShape,
  NodeImageProviderTerminalFailureCode,
  NodeImageProviderRegistrationWork,
  NodeImageWorkflowReservation,
} from '@gridora/node-image-d1'
import type { ProviderImageRegistrationTransportShape } from '@gridora/provider-image-registration'
import { ProviderCreateUncertainError, type ProviderError } from '@gridora/provider-sdk'

export class NodeImageExecutionError extends Schema.TaggedError<NodeImageExecutionError>()(
  'NodeImageExecutionError',
  {
    code: Schema.Literals([
      'claim_unavailable',
      'artifact_locator_unavailable',
      'provider_transport_unavailable',
      'provider_registration_failed',
      'completion_unavailable',
    ]),
  },
) {}

export interface NodeImageArtifactLocatorShape {
  /** Returns an internal, short-lived R2 artifact URL for this exact digest. */
  readonly locate: (input: {
    readonly imageId: string
    readonly artifactDigest: string
  }) => Effect.Effect<string, NodeImageExecutionError>
}
export interface NodeImageProviderTransportResolverShape {
  /** The composition root opens only the exact account revision and secret reference D1 just re-read. */
  readonly resolve: (input: {
    readonly providerType: 'ovhcloud' | 'contabo'
    readonly providerAccountId: string
    readonly providerAccountRevision: number
    readonly credentialReference: string
  }) => Effect.Effect<ProviderImageRegistrationTransportShape, NodeImageExecutionError>
}
export interface NodeImageExecutionClockShape {
  readonly now: Effect.Effect<
    { readonly iso: string; readonly epochMilliseconds: number },
    NodeImageExecutionError
  >
}

export interface NodeImageExecutionShape {
  readonly execute: (
    reservation: NodeImageWorkflowReservation,
  ) => Effect.Effect<
    { readonly status: 'completed' | 'adopted' | 'waiting-external' | 'failed-terminal' },
    NodeImageExecutionError
  >
}
export class NodeImageExecution extends Context.Service<
  NodeImageExecution,
  NodeImageExecutionShape
>()('@gridora/node-image-execution/NodeImageExecution') {}
export const NodeImageExecutionLayer = (service: NodeImageExecutionShape) =>
  Layer.succeed(NodeImageExecution, service)

const failure = (code: NodeImageExecutionError['code']) => new NodeImageExecutionError({ code })
const terminalProviderFailureCode = (
  error: ProviderError,
): NodeImageProviderTerminalFailureCode | null => {
  switch (error._tag) {
    case 'ProviderAuthenticationError':
      return 'provider_authentication_failed'
    case 'ProviderAuthorizationError':
      return 'provider_authorization_failed'
    case 'ProviderValidationError':
      return 'provider_validation_failed'
    case 'ProviderQuotaError':
      return 'provider_quota_exhausted'
    case 'ProviderConflictError':
      return 'provider_conflict'
    case 'ProviderBillingActionRequiredError':
      return 'provider_billing_action_required'
    case 'ProviderUnsupportedCapabilityError':
      return 'provider_unsupported_capability'
    default:
      return null
  }
}

const requestFor = (work: NodeImageProviderRegistrationWork, artifactUrl: string) => ({
  registrationId: work.registrationId,
  providerAccountId: work.providerAccountId,
  provider: work.providerType,
  region: work.region,
  imageId: work.imageId,
  version: work.version,
  sourceCommit: work.sourceCommit,
  architecture: work.architecture,
  artifactDigest: work.artifactDigest,
  artifactUrl,
  // An uncertain result or any recovered lease is a one-way fence: discovery
  // may run, but it must never issue a second provider image create request.
  createMode: work.mustAdoptOnly ? ('adopt_only' as const) : ('create_or_adopt' as const),
  adoptionAttempt: work.adoptionAttempt,
  adoptionDeadlineAtEpochMs: work.adoptionDeadlineAtEpochMs,
})

export const makeNodeImageExecution = (dependencies: {
  readonly repository: NodeImageExecutionRepositoryShape
  readonly artifacts: NodeImageArtifactLocatorShape
  readonly providers: NodeImageProviderTransportResolverShape
  readonly clock: NodeImageExecutionClockShape
}): NodeImageExecutionShape => ({
  execute: (reservation) =>
    Effect.gen(function* () {
      const clock = yield* dependencies.clock.now
      const leaseExpiresAt = new Date(clock.epochMilliseconds + 5 * 60 * 1000).toISOString()
      const recoveryDeadlineAtEpochMs = clock.epochMilliseconds + 60 * 60 * 1000
      const claim = yield* dependencies.repository
        .claimExact({
          reservation,
          now: clock.iso,
          claimId: `node-image-claim:${globalThis.crypto.randomUUID()}`,
          leaseExpiresAt,
          recoveryDeadlineAtEpochMs,
        })
        .pipe(Effect.mapError(() => failure('claim_unavailable')))
      if (claim.disposition === 'adopted') return { status: 'adopted' as const }
      if (claim.disposition === 'waiting-external') return { status: 'waiting-external' as const }
      if (claim.disposition === 'failed-terminal') return { status: 'failed-terminal' as const }
      if (claim.reservation.action !== 'register-provider')
        return yield* dependencies.repository
          .completeLocal({ reservation: claim.reservation, claim, now: clock.iso })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const initialWork = yield* Effect.result(
        dependencies.repository.registrationWork({ reservation: claim.reservation, claim }),
      )
      if (initialWork._tag === 'Failure')
        return yield* dependencies.repository
          .failTerminal({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'provider_account_unavailable',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const work = initialWork.success
      if (
        (work.mode === 'stock-ubuntu-cloud-init' && work.registrationState === 'degraded') ||
        (work.mode === 'custom-image' && work.registrationState === 'registered')
      )
        return yield* dependencies.repository
          .completeLocal({ reservation: claim.reservation, claim, now: clock.iso })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      if (work.mode !== 'custom-image' || work.registrationState === 'revoked')
        return yield* dependencies.repository
          .failTerminal({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'provider_validation_failed',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      // The recovery deadline is an absolute durable fence. Once it elapses,
      // discovery/create is no longer dispatched; an operator can reconcile
      // the immutable provider metadata from the terminal event.
      if (work.mustAdoptOnly && clock.epochMilliseconds >= work.adoptionDeadlineAtEpochMs)
        return yield* dependencies.repository
          .failTerminal({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'provider_reconciliation_required',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const artifact = yield* Effect.result(
        dependencies.artifacts.locate({
          imageId: work.imageId,
          artifactDigest: work.artifactDigest,
        }),
      )
      if (artifact._tag === 'Failure')
        return yield* dependencies.repository
          .releasePreDispatch({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'artifact_locator_unavailable',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const artifactUrl = artifact.success
      // Re-read after artifact lookup and immediately before opening a provider
      // credential. A disabled or rotated account cannot reach a paid POST.
      const authorityResult = yield* Effect.result(
        dependencies.repository.preflightProviderRegistration({
          reservation: claim.reservation,
          claim,
        }),
      )
      if (authorityResult._tag === 'Failure')
        return yield* dependencies.repository
          .failTerminal({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'provider_account_unavailable',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const authority = authorityResult.success
      if (
        authority.providerType !== work.providerType ||
        authority.providerAccountId !== work.providerAccountId ||
        authority.providerAccountRevision !== work.providerAccountRevision ||
        authority.credentialReference !== work.credentialReference
      )
        return yield* dependencies.repository
          .failTerminal({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'provider_account_unavailable',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const resolvedTransport = yield* Effect.result(dependencies.providers.resolve(authority))
      if (resolvedTransport._tag === 'Failure')
        return yield* dependencies.repository
          .releasePreDispatch({
            reservation: claim.reservation,
            claim,
            now: clock.iso,
            code: 'provider_transport_unavailable',
          })
          .pipe(Effect.mapError(() => failure('completion_unavailable')))
      const transport = resolvedTransport.success
      // This is the one-way durable fence immediately before the provider API
      // can be called. A crash after it can only retry metadata adoption.
      yield* dependencies.repository
        .beginProviderDispatch({ reservation: claim.reservation, claim, now: clock.iso })
        .pipe(Effect.mapError(() => failure('claim_unavailable')))
      const providerResult = yield* Effect.result(
        transport.registerOrAdopt(requestFor(work, artifactUrl)),
      )
      if (providerResult._tag === 'Failure') {
        const error = providerResult.failure
        if (error instanceof ProviderCreateUncertainError) {
          if (error.nextAttemptAtEpochMs > work.adoptionDeadlineAtEpochMs)
            return yield* dependencies.repository
              .failTerminal({
                reservation: claim.reservation,
                claim,
                now: clock.iso,
                code: 'provider_reconciliation_required',
              })
              .pipe(Effect.mapError(() => failure('completion_unavailable')))
          return yield* dependencies.repository
            .settleProviderRegistration({
              reservation: claim.reservation,
              claim,
              now: clock.iso,
              outcome: {
                kind: 'uncertain',
                nextAttemptNumber: error.nextAttemptNumber,
                nextAttemptAtEpochMs: error.nextAttemptAtEpochMs,
                // The durable receipt owns this deadline. A provider response
                // cannot extend a recovery/create window after the first claim.
                recoveryDeadlineAtEpochMs: work.adoptionDeadlineAtEpochMs,
              },
            })
            .pipe(Effect.mapError(() => failure('completion_unavailable')))
        }
        const terminalCode = terminalProviderFailureCode(error)
        if (terminalCode !== null)
          return yield* dependencies.repository
            .failTerminal({
              reservation: claim.reservation,
              claim,
              now: clock.iso,
              code: terminalCode,
            })
            .pipe(Effect.mapError(() => failure('completion_unavailable')))
        return yield* Effect.fail(failure('provider_registration_failed'))
      }
      return yield* dependencies.repository
        .settleProviderRegistration({
          reservation: claim.reservation,
          claim,
          now: clock.iso,
          outcome: providerResult.success,
        })
        .pipe(Effect.mapError(() => failure('completion_unavailable')))
    }),
})

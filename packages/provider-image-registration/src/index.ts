import { Effect } from 'effect'
import {
  ProviderConflictError,
  ProviderCreateUncertainError,
  ProviderValidationError,
  type ProviderError,
  type ProviderId,
} from '@gridora/provider-sdk'

export interface ProviderImageRegistrationRequest {
  readonly registrationId: string
  readonly providerAccountId: string
  readonly provider: ProviderId
  readonly region: string
  readonly imageId: string
  readonly version: string
  readonly sourceCommit: string
  readonly architecture: 'amd64'
  readonly artifactDigest: string
  /** This URL is created by an internal R2 artifact locator, never a public route. */
  readonly artifactUrl: string
  readonly createMode: 'create_or_adopt' | 'adopt_only'
  readonly adoptionAttempt: number
  readonly adoptionDeadlineAtEpochMs: number
}

export interface RemoteProviderImage {
  readonly id: string
  readonly name: string
  readonly region: string
  readonly architecture: 'amd64' | 'arm64'
  readonly metadata: Readonly<Record<string, string>>
  readonly requestId?: string | undefined
}

export interface ProviderImageRegistrationRemoteShape {
  /** The adapter must return only one bounded provider-account and region page. */
  readonly list: (input: {
    readonly providerAccountId: string
    readonly region: string
    readonly expectedName: string
  }) => Effect.Effect<readonly RemoteProviderImage[], ProviderError>
  /** This call may allocate billable provider image storage. It is called at most once per operation. */
  readonly create: (input: {
    readonly providerAccountId: string
    readonly region: string
    readonly name: string
    readonly architecture: 'amd64'
    readonly artifactUrl: string
    readonly metadata: Readonly<Record<string, string>>
  }) => Effect.Effect<RemoteProviderImage, ProviderError>
}

export type ProviderImageRegistrationResult =
  | {
      readonly kind: 'registered'
      readonly providerImageId: string
      readonly providerRequestId: string | null
    }
  | {
      readonly kind: 'adopted'
      readonly providerImageId: string
      readonly providerRequestId: string | null
    }
  | {
      readonly kind: 'uncertain'
      readonly retryMode: 'adopt_only'
      readonly nextAttemptNumber: number
      readonly nextAttemptAtEpochMs: number
      readonly recoveryDeadlineAtEpochMs: number
    }

export interface ProviderImageRegistrationTransportShape {
  readonly registerOrAdopt: (
    request: ProviderImageRegistrationRequest,
  ) => Effect.Effect<ProviderImageRegistrationResult, ProviderError>
}

export interface ProviderImageRegistrationTransportOptions {
  readonly now?: () => number
}

const operation = 'nodeImage.registerOrAdopt'
const maxCandidates = 16
const providerImageName = (request: ProviderImageRegistrationRequest) =>
  `gridora-${request.imageId}-${request.artifactDigest.slice(7, 23)}`
const metadata = (request: ProviderImageRegistrationRequest): Readonly<Record<string, string>> => ({
  'managed-by': 'gridora',
  'gridora-image-id': request.imageId,
  'gridora-image-version': request.version,
  'gridora-source-commit': request.sourceCommit,
  'gridora-artifact-digest': request.artifactDigest,
  'gridora-registration-id': request.registrationId,
})
const owned = (
  candidate: RemoteProviderImage,
  request: ProviderImageRegistrationRequest,
): boolean => {
  const expected = metadata(request)
  return (
    candidate.name === providerImageName(request) &&
    candidate.region === request.region &&
    candidate.architecture === request.architecture &&
    Object.entries(expected).every(([key, value]) => candidate.metadata[key] === value)
  )
}
const conflict = (provider: ProviderId, message: string) =>
  new ProviderConflictError({ provider, operation, message })
const validation = (provider: ProviderId, field: string, message: string) =>
  new ProviderValidationError({ provider, operation, field, message })
const uncertain = (
  request: ProviderImageRegistrationRequest,
  now: () => number,
): ProviderCreateUncertainError => {
  const observed = now()
  const deadline = request.adoptionDeadlineAtEpochMs
  const next = request.adoptionAttempt + 1
  const delay = Math.min(5_000 * 2 ** Math.min(request.adoptionAttempt, 6), 5 * 60 * 1000)
  return new ProviderCreateUncertainError({
    provider: request.provider,
    operation,
    message: 'Provider image registration response is uncertain; use adopt-only discovery',
    organizationId: 'platform',
    operationId: request.registrationId,
    retryMode: 'adopt_only',
    stabilizationAttempts: request.adoptionAttempt,
    nextAttemptNumber: next,
    nextAttemptAtEpochMs:
      observed >= deadline ? deadline + 1 : Math.min(observed + delay, deadline),
    recoveryDeadlineAtEpochMs: deadline,
  })
}

const validArtifactUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}

/**
 * One provider-side create is allowed per registration. After a response loss,
 * only metadata-bound discovery can adopt an image; a retry never makes another
 * storage-creating provider request.
 */
export const makeProviderImageRegistrationTransport = (
  remote: ProviderImageRegistrationRemoteShape,
  options: ProviderImageRegistrationTransportOptions = {},
): ProviderImageRegistrationTransportShape => ({
  registerOrAdopt: (request) =>
    Effect.gen(function* () {
      if (!validArtifactUrl(request.artifactUrl))
        return yield* validation(request.provider, 'artifactUrl', 'Image artifact URL is invalid')
      if (
        !Number.isSafeInteger(request.adoptionAttempt) ||
        request.adoptionAttempt < 0 ||
        !Number.isSafeInteger(request.adoptionDeadlineAtEpochMs) ||
        request.adoptionDeadlineAtEpochMs < 1
      )
        return yield* validation(
          request.provider,
          'adoptionAttempt',
          'Adoption coordinates are invalid',
        )
      const candidates = yield* remote.list({
        providerAccountId: request.providerAccountId,
        region: request.region,
        expectedName: providerImageName(request),
      })
      if (candidates.length > maxCandidates)
        return yield* conflict(
          request.provider,
          'Provider image discovery exceeded the bounded result limit',
        )
      const matches = candidates.filter((candidate) => owned(candidate, request))
      if (matches.length === 1) {
        const image = matches[0]!
        return {
          kind: 'adopted',
          providerImageId: image.id,
          providerRequestId: image.requestId ?? null,
        }
      }
      if (matches.length > 1)
        return yield* conflict(
          request.provider,
          'Multiple provider images match immutable Gridora registration metadata',
        )
      if (request.createMode === 'adopt_only') {
        const state = uncertain(request, options.now ?? (() => Date.now()))
        return {
          kind: 'uncertain',
          retryMode: 'adopt_only',
          nextAttemptNumber: state.nextAttemptNumber,
          nextAttemptAtEpochMs: state.nextAttemptAtEpochMs,
          recoveryDeadlineAtEpochMs: state.recoveryDeadlineAtEpochMs,
        }
      }
      const created = yield* remote
        .create({
          providerAccountId: request.providerAccountId,
          region: request.region,
          name: providerImageName(request),
          architecture: request.architecture,
          artifactUrl: request.artifactUrl,
          metadata: metadata(request),
        })
        .pipe(
          Effect.mapError((error) => {
            if (
              error._tag === 'ProviderValidationError' ||
              error._tag === 'ProviderAuthenticationError' ||
              error._tag === 'ProviderAuthorizationError' ||
              error._tag === 'ProviderQuotaError' ||
              error._tag === 'ProviderConflictError' ||
              error._tag === 'ProviderBillingActionRequiredError'
            )
              return error
            return uncertain(request, options.now ?? (() => Date.now()))
          }),
        )
      if (!owned(created, request))
        return yield* conflict(
          request.provider,
          'Provider image response does not match immutable registration metadata',
        )
      return {
        kind: 'registered',
        providerImageId: created.id,
        providerRequestId: created.requestId ?? null,
      }
    }),
})

/** OVHcloud uses a Glance image-management adapter supplied by the platform credential boundary. */
export interface OvhImageRegistrationRemote extends ProviderImageRegistrationRemoteShape {}
export const makeOvhImageRegistrationTransport = (
  remote: OvhImageRegistrationRemote,
  options: ProviderImageRegistrationTransportOptions = {},
) => makeProviderImageRegistrationTransport(remote, options)

/** Contabo custom-image APIs vary by account capability; the adapter is explicit and independently tested. */
export interface ContaboImageRegistrationRemote extends ProviderImageRegistrationRemoteShape {}
export const makeContaboImageRegistrationTransport = (
  remote: ContaboImageRegistrationRemote,
  options: ProviderImageRegistrationTransportOptions = {},
) => makeProviderImageRegistrationTransport(remote, options)

/**
 * A fallback is usable only after D1 proved the scope policy allows it. It is
 * intentionally `degraded`, never a provider registration or promoted image.
 */
export const stockUbuntuCloudInitFallback = (input: {
  readonly policyAllowsFallback: boolean
  readonly stockImageId: string
  readonly cloudInitTemplateDigest: string
}) => {
  if (
    !input.policyAllowsFallback ||
    input.stockImageId.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(input.cloudInitTemplateDigest)
  )
    return Effect.fail(
      new ProviderValidationError({
        provider: 'unknown',
        operation,
        field: 'fallback',
        message: 'Stock Ubuntu cloud-init fallback is not permitted by policy',
      }),
    )
  return Effect.succeed({
    state: 'degraded' as const,
    providerImageId: input.stockImageId,
    degradedReason: 'stock-ubuntu-cloud-init' as const,
  })
}

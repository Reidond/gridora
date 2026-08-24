import { Context, Effect, Layer, Schema } from 'effect'
import { ContaboCredentials, OvhPublicCloudCredentials } from '@gridora/contracts'
import {
  ProviderAuthorizationError,
  ProviderValidationError,
  type CreateNodeInput,
  type ProviderError,
  type ProviderId,
  type ProviderNode,
} from '@gridora/provider-sdk'

export type OvhRuntimeCredentials = typeof OvhPublicCloudCredentials.Type
export type ContaboRuntimeCredentials = typeof ContaboCredentials.Type

export interface AuthoritativeProviderAccount {
  readonly id: string
  readonly providerType: ProviderId
  readonly scope: 'platform' | 'organization'
  readonly organizationId: string | null
  readonly revision: number
  readonly status: 'active' | 'disabled' | 'error'
}

export interface ProviderRuntimeCreateInput {
  /** Must be loaded from the authoritative provider-account repository, never the public body. */
  readonly account: AuthoritativeProviderAccount
  /** Must be loaded from the immutable post-commit node acceptance receipt. */
  readonly accepted: {
    readonly organizationId: string
    readonly nodeId: string
    readonly operationId: string
    readonly providerAccountId: string
    readonly providerAccountRevision: number
    readonly providerType: ProviderId
    readonly regionId: string
    readonly planId: string
    readonly providerImageId: string
    readonly imageVersion: string
    readonly commercialTerms: AcceptedProviderCommercialTerms
  }
  /** Exact decrypted envelope bytes. This buffer is cleared on success, failure, or interruption. */
  readonly credentialBytes: Uint8Array
  readonly node: CreateNodeInput
}

export interface AcceptedProviderCommercialTerms {
  readonly currency: string
  readonly estimatedMonthlyMinor: number
  readonly billingCadence: 'hourly' | 'monthly' | 'contract'
  readonly contractMonths: number
  readonly nonHourlyCommitmentConfirmed: boolean
  readonly catalogRefreshedAt: string
}

export interface OvhCreateTransportShape {
  readonly createOrAdopt: (
    credentials: OvhRuntimeCredentials,
    input: CreateNodeInput,
    commercialTerms: AcceptedProviderCommercialTerms,
  ) => Effect.Effect<ProviderNode, ProviderError>
}
export class OvhCreateTransport extends Context.Service<
  OvhCreateTransport,
  OvhCreateTransportShape
>()('@gridora/provider-runtime/OvhCreateTransport') {}
export const OvhCreateTransportLayer = (transport: OvhCreateTransportShape) =>
  Layer.succeed(OvhCreateTransport, transport)

export interface ContaboCreateTransportShape {
  readonly createOrAdopt: (
    credentials: ContaboRuntimeCredentials,
    input: CreateNodeInput,
    commercialTerms: AcceptedProviderCommercialTerms,
  ) => Effect.Effect<ProviderNode, ProviderError>
}
export class ContaboCreateTransport extends Context.Service<
  ContaboCreateTransport,
  ContaboCreateTransportShape
>()('@gridora/provider-runtime/ContaboCreateTransport') {}
export const ContaboCreateTransportLayer = (transport: ContaboCreateTransportShape) =>
  Layer.succeed(ContaboCreateTransport, transport)

export interface ProviderCreateRuntimeShape {
  readonly createOrAdopt: (
    input: ProviderRuntimeCreateInput,
  ) => Effect.Effect<ProviderNode, ProviderError>
}
export class ProviderCreateRuntime extends Context.Service<
  ProviderCreateRuntime,
  ProviderCreateRuntimeShape
>()('@gridora/provider-runtime/ProviderCreateRuntime') {}

const ProviderNodeContract = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  state: Schema.Literals([
    'creating',
    'active',
    'stopped',
    'rebuilding',
    'retiring',
    'retired',
    'unknown',
  ]),
  regionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  planId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  addresses: Schema.Array(Schema.String.check(Schema.isMaxLength(256))),
  metadata: Schema.Struct({
    managedBy: Schema.Literal('gridora'),
    organizationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    imageVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  contract: Schema.optional(
    Schema.Struct({
      periodEndsAt: Schema.String,
      cancellationDate: Schema.optional(Schema.String),
      billingStopsAt: Schema.optional(Schema.String),
    }),
  ),
})

const validation = (provider: ProviderId, message: string, field?: string) =>
  new ProviderValidationError({
    provider,
    operation: 'nodeProvision.createOrAdopt',
    message,
    ...(field === undefined ? {} : { field }),
  })

const strictUtf8Json = (
  provider: ProviderId,
  bytes: Uint8Array,
): Effect.Effect<unknown, ProviderValidationError> =>
  bytes.byteLength === 0 || bytes.byteLength > 64 * 1024
    ? Effect.fail(validation(provider, 'Provider credential envelope is invalid'))
    : Effect.try({
        try: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
        catch: () => validation(provider, 'Provider credential envelope is invalid'),
      })

const allowedUrl = (
  value: string,
  expected: { readonly host: string; readonly pathname: string },
): boolean => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === expected.host &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

export const isAllowedOvhAuthUrl = (value: string): boolean =>
  allowedUrl(value, { host: 'auth.cloud.ovh.net', pathname: '/v3' })
export const isAllowedContaboTokenUrl = (value: string): boolean =>
  allowedUrl(value, {
    host: 'auth.contabo.com',
    pathname: '/auth/realms/contabo/protocol/openid-connect/token',
  })
export const isAllowedContaboApiBaseUrl = (value: string): boolean =>
  allowedUrl(value, { host: 'api.contabo.com', pathname: '/' })

const decodeOvh = (bytes: Uint8Array) =>
  Effect.flatMap(strictUtf8Json('ovhcloud', bytes), (value) =>
    Schema.decodeUnknownEffect(OvhPublicCloudCredentials, { onExcessProperty: 'error' })(
      value,
    ).pipe(
      Effect.mapError(() => validation('ovhcloud', 'OVH credential envelope is invalid')),
      Effect.filterOrFail(
        (credentials) => isAllowedOvhAuthUrl(credentials.authUrl),
        () => validation('ovhcloud', 'OVH authentication endpoint is not allow-listed', 'authUrl'),
      ),
    ),
  )

const decodeContabo = (bytes: Uint8Array) =>
  Effect.flatMap(strictUtf8Json('contabo', bytes), (value) =>
    Schema.decodeUnknownEffect(ContaboCredentials, { onExcessProperty: 'error' })(value).pipe(
      Effect.mapError(() => validation('contabo', 'Contabo credential envelope is invalid')),
      Effect.filterOrFail(
        (credentials) =>
          isAllowedContaboTokenUrl(credentials.tokenUrl) &&
          isAllowedContaboApiBaseUrl(credentials.apiBaseUrl),
        () => validation('contabo', 'Contabo endpoint is not allow-listed'),
      ),
    ),
  )

const validateAccount = (
  account: AuthoritativeProviderAccount,
  accepted: ProviderRuntimeCreateInput['accepted'],
  input: CreateNodeInput,
): Effect.Effect<void, ProviderError> => {
  if (account.providerType !== 'ovhcloud' && account.providerType !== 'contabo')
    return Effect.fail(
      new ProviderValidationError({
        provider: 'unknown',
        operation: 'nodeProvision.createOrAdopt',
        message: 'Provider account type is unsupported',
      }),
    )
  if (
    account.id.length === 0 ||
    !Number.isSafeInteger(account.revision) ||
    account.revision < 1 ||
    account.status !== 'active'
  )
    return Effect.fail(validation(account.providerType, 'Provider account is not active'))
  if (
    account.id !== accepted.providerAccountId ||
    account.providerType !== accepted.providerType ||
    account.revision !== accepted.providerAccountRevision ||
    accepted.organizationId !== input.organizationId ||
    accepted.nodeId !== input.nodeId ||
    accepted.operationId !== input.operationId ||
    accepted.regionId !== input.regionId ||
    accepted.planId !== input.planId ||
    accepted.providerImageId !== input.imageId ||
    accepted.imageVersion !== input.imageVersion
  )
    return Effect.fail(
      validation(account.providerType, 'Provider account does not match the accepted reservation'),
    )
  if (
    !/^[A-Z]{3}$/.test(accepted.commercialTerms.currency) ||
    !Number.isSafeInteger(accepted.commercialTerms.estimatedMonthlyMinor) ||
    accepted.commercialTerms.estimatedMonthlyMinor < 0 ||
    !Number.isSafeInteger(accepted.commercialTerms.contractMonths) ||
    accepted.commercialTerms.contractMonths < 1 ||
    (accepted.commercialTerms.billingCadence !== 'hourly' &&
      accepted.commercialTerms.billingCadence !== 'monthly' &&
      accepted.commercialTerms.billingCadence !== 'contract') ||
    !Number.isFinite(Date.parse(accepted.commercialTerms.catalogRefreshedAt)) ||
    (accepted.providerType === 'contabo' &&
      accepted.commercialTerms.billingCadence !== 'hourly' &&
      !accepted.commercialTerms.nonHourlyCommitmentConfirmed)
  )
    return Effect.fail(validation(account.providerType, 'Accepted commercial terms are invalid'))
  if (
    [
      input.organizationId,
      input.operationId,
      input.nodeId,
      input.name,
      input.regionId,
      input.planId,
      input.imageId,
      input.imageVersion,
    ].some((value) => value.length === 0) ||
    (input.createMode !== undefined &&
      input.createMode !== 'create_or_adopt' &&
      input.createMode !== 'adopt_only') ||
    (input.adoptionAttempt !== undefined &&
      (!Number.isSafeInteger(input.adoptionAttempt) || input.adoptionAttempt < 1)) ||
    (input.adoptionDeadlineAtEpochMs !== undefined &&
      (!Number.isSafeInteger(input.adoptionDeadlineAtEpochMs) ||
        input.adoptionDeadlineAtEpochMs < 1)) ||
    (input.adoptionAttempt === undefined) !== (input.adoptionDeadlineAtEpochMs === undefined)
  )
    return Effect.fail(validation(account.providerType, 'Provider create reservation is invalid'))
  if (
    account.scope === 'organization' &&
    (account.organizationId === null || account.organizationId !== input.organizationId)
  )
    return Effect.fail(
      new ProviderAuthorizationError({
        provider: account.providerType,
        operation: 'nodeProvision.createOrAdopt',
        message: 'Provider account is outside the organization boundary',
      }),
    )
  if (account.scope === 'platform' && account.organizationId !== null)
    return Effect.fail(validation(account.providerType, 'Provider account scope is invalid'))
  return Effect.void
}

const validateNode = (
  provider: ProviderId,
  expected: CreateNodeInput,
  actual: ProviderNode,
): Effect.Effect<ProviderNode, ProviderValidationError> =>
  Schema.decodeUnknownEffect(ProviderNodeContract, { onExcessProperty: 'error' })(actual).pipe(
    Effect.mapError(() => validation(provider, 'Provider response is invalid')),
    Effect.flatMap((decoded) =>
      decoded.name === expected.name &&
      decoded.regionId === expected.regionId &&
      decoded.planId === expected.planId &&
      decoded.metadata.organizationId === expected.organizationId &&
      decoded.metadata.nodeId === expected.nodeId &&
      decoded.metadata.operationId === expected.operationId &&
      decoded.metadata.imageVersion === expected.imageVersion
        ? Effect.succeed({
            id: decoded.id,
            name: decoded.name,
            state: decoded.state,
            regionId: decoded.regionId,
            planId: decoded.planId,
            addresses: decoded.addresses,
            metadata: decoded.metadata,
            ...(decoded.contract === undefined
              ? {}
              : {
                  contract: {
                    periodEndsAt: decoded.contract.periodEndsAt,
                    ...(decoded.contract.cancellationDate === undefined
                      ? {}
                      : { cancellationDate: decoded.contract.cancellationDate }),
                    ...(decoded.contract.billingStopsAt === undefined
                      ? {}
                      : { billingStopsAt: decoded.contract.billingStopsAt }),
                  },
                }),
          } satisfies ProviderNode)
        : Effect.fail(
            validation(provider, 'Provider response does not match the authoritative reservation'),
          ),
    ),
  )

export const makeProviderCreateRuntime = (dependencies: {
  readonly ovhcloud: OvhCreateTransportShape
  readonly contabo: ContaboCreateTransportShape
}): ProviderCreateRuntimeShape => ({
  createOrAdopt: (input) =>
    Effect.acquireUseRelease(
      Effect.sync(() => input.credentialBytes),
      (bytes) =>
        Effect.andThen(
          validateAccount(input.account, input.accepted, input.node),
          Effect.suspend(() => {
            switch (input.account.providerType) {
              case 'ovhcloud':
                return Effect.flatMap(decodeOvh(bytes), (credentials) =>
                  credentials.region !== input.node.regionId
                    ? Effect.fail(
                        validation(
                          'ovhcloud',
                          'OVH credential region does not match the accepted reservation',
                        ),
                      )
                    : Effect.flatMap(
                        dependencies.ovhcloud.createOrAdopt(
                          credentials,
                          input.node,
                          input.accepted.commercialTerms,
                        ),
                        (node) => validateNode('ovhcloud', input.node, node),
                      ),
                )
              case 'contabo':
                return Effect.flatMap(decodeContabo(bytes), (credentials) =>
                  Effect.flatMap(
                    dependencies.contabo.createOrAdopt(
                      credentials,
                      input.node,
                      input.accepted.commercialTerms,
                    ),
                    (node) => validateNode('contabo', input.node, node),
                  ),
                )
              default:
                return Effect.fail(
                  new ProviderValidationError({
                    provider: 'unknown',
                    operation: 'nodeProvision.createOrAdopt',
                    message: 'Provider account type is unsupported',
                  }),
                )
            }
          }),
        ),
      (bytes) => Effect.sync(() => bytes.fill(0)),
    ),
})

export const ProviderCreateRuntimeLive = Layer.effect(
  ProviderCreateRuntime,
  Effect.gen(function* () {
    const ovhcloud = yield* OvhCreateTransport
    const contabo = yield* ContaboCreateTransport
    return ProviderCreateRuntime.of(makeProviderCreateRuntime({ ovhcloud, contabo }))
  }),
)

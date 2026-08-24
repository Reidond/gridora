import { Context, Effect, Layer, Schema } from 'effect'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
  ProviderAccountMetadata,
  RevisionConflictError,
} from '@gridora/contracts'
import {
  IdempotencyKey,
  IsoDateTime,
  OperationId,
  OrganizationContext,
  roleAtLeast,
} from '@gridora/domain'
import {
  ProviderValidationError,
  isRetryableProviderError,
  type ProviderError,
} from '@gridora/provider-sdk'
import {
  SecretEnvelopeService,
  type SecretEnvelopeError,
  type SecretEnvelopeServiceShape,
} from '@gridora/secret-envelope'
import {
  AuditRequestContextValue,
  type AuditRequestContextValue as AuditRequestContext,
} from '@gridora/audit-contracts'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
)
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const SafeText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NullablePositiveInteger = Schema.NullOr(PositiveRevision)
const RequestFingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const ProviderAccountType = Schema.Literals(['ovhcloud', 'contabo'])
export type ProviderAccountType = typeof ProviderAccountType.Type
export const ProviderAccountStatus = Schema.Literals(['active', 'disabled', 'error'])
export type ProviderAccountStatus = typeof ProviderAccountStatus.Type
export const ProviderAccountLifecycleAction = Schema.Literals([
  'test',
  'refresh',
  'disable',
  'remove',
])
export type ProviderAccountLifecycleAction = typeof ProviderAccountLifecycleAction.Type
export const ProviderAccountLifecycleOutcome = Schema.Literals([
  'valid',
  'refreshed',
  'disabled',
  'removed',
  'retryable_failure',
  'permanent_failure',
])
export type ProviderAccountLifecycleOutcome = typeof ProviderAccountLifecycleOutcome.Type
export const ProviderAccountFailureCategory = Schema.Literals([
  'authentication_failed',
  'authorization_failed',
  'validation_failed',
  'quota_exceeded',
  'not_found',
  'conflict',
  'rate_limited',
  'temporarily_unavailable',
  'billing_action_required',
  'unsupported',
  'provider_unavailable',
])
export type ProviderAccountFailureCategory = typeof ProviderAccountFailureCategory.Type

export class ProviderAccountRecord extends Schema.Class<ProviderAccountRecord>(
  'ProviderAccountRecord',
)({
  id: Identifier,
  scope: Schema.Literal('organization'),
  organizationId: Identifier,
  providerType: ProviderAccountType,
  credentialReference: Identifier,
  credentialRevision: PositiveRevision,
  status: ProviderAccountStatus,
  revision: PositiveRevision,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}) {}

export class ProviderCatalogEntry extends Schema.Class<ProviderCatalogEntry>(
  'ProviderCatalogEntry',
)({
  region: Identifier,
  plan: Identifier,
  currency: Currency,
  hourlyPriceMinor: Schema.NullOr(NonNegativeInteger),
  monthlyPriceMinor: Schema.NullOr(NonNegativeInteger),
  metadata: Schema.Struct({
    cpu: NullablePositiveInteger,
    memoryMiB: NullablePositiveInteger,
    diskGiB: NullablePositiveInteger,
    billingKind: Schema.Literals(['hourly', 'monthly', 'unknown']),
    contractMonths: NullablePositiveInteger,
  }),
}) {}

export class ProviderDiscoverySnapshot extends Schema.Class<ProviderDiscoverySnapshot>(
  'ProviderDiscoverySnapshot',
)({
  regions: Schema.Array(Identifier).check(Schema.isMaxLength(256)),
  projects: Schema.Array(Identifier).check(Schema.isMaxLength(256)),
  catalog: Schema.Array(ProviderCatalogEntry).check(Schema.isMaxLength(512)),
}) {}

export class ProviderAccountLifecycleResult extends Schema.Class<ProviderAccountLifecycleResult>(
  'ProviderAccountLifecycleResult',
)({
  accountId: Identifier,
  organizationId: Identifier,
  providerType: ProviderAccountType,
  action: ProviderAccountLifecycleAction,
  outcome: ProviderAccountLifecycleOutcome,
  accountStatus: Schema.NullOr(ProviderAccountStatus),
  revision: PositiveRevision,
  operationId: OperationId,
  failureCategory: Schema.NullOr(ProviderAccountFailureCategory),
  regionCount: NonNegativeInteger,
  projectCount: NonNegativeInteger,
  catalogItemCount: NonNegativeInteger,
  completedAt: IsoDateTime,
}) {}

export const ProviderAccountLifecycleBody = Schema.Struct({ expectedRevision: PositiveRevision })
export type ProviderAccountLifecycleBody = typeof ProviderAccountLifecycleBody.Type

export class ProviderAccountStoreNotFoundError extends Schema.TaggedError<ProviderAccountStoreNotFoundError>()(
  'ProviderAccountStoreNotFoundError',
  { accountId: Identifier },
) {}
export class ProviderAccountStoreConflictError extends Schema.TaggedError<ProviderAccountStoreConflictError>()(
  'ProviderAccountStoreConflictError',
  {
    accountId: Identifier,
    code: Schema.Literals([
      'idempotency_payload_mismatch',
      'account_not_disabled',
      'account_not_active',
      'account_referenced',
      'provider_type_mismatch',
    ]),
  },
) {}
export class ProviderAccountStoreRevisionError extends Schema.TaggedError<ProviderAccountStoreRevisionError>()(
  'ProviderAccountStoreRevisionError',
  { accountId: Identifier, expectedRevision: PositiveRevision, actualRevision: PositiveRevision },
) {}
export class ProviderAccountStorePersistenceError extends Schema.TaggedError<ProviderAccountStorePersistenceError>()(
  'ProviderAccountStorePersistenceError',
  { operation: SafeText },
) {}
export type ProviderAccountStoreError =
  | ProviderAccountStoreNotFoundError
  | ProviderAccountStoreConflictError
  | ProviderAccountStoreRevisionError
  | ProviderAccountStorePersistenceError

export interface ProviderAccountReplayQuery {
  readonly context: OrganizationContext
  readonly accountId: string
  readonly action: ProviderAccountLifecycleAction
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
}

export interface ProviderAccountCommitInput extends ProviderAccountReplayQuery {
  readonly account: ProviderAccountRecord
  readonly expectedRevision: number
  readonly result: ProviderAccountLifecycleResult
  readonly catalog: ReadonlyArray<ProviderCatalogEntry>
  readonly auditEventId: string
  /** Exact request provenance retained by the terminal v1 audit envelope. */
  readonly auditRequestContext: AuditRequestContext
  /** Actor/action/resource-scoped SHA-256 operation key, distinct from the client replay key. */
  readonly operationIdempotencyKey: IdempotencyKey
}

export interface ProviderAccountActionRepositoryShape {
  readonly getScoped: (
    context: OrganizationContext,
    accountId: string,
  ) => Effect.Effect<ProviderAccountRecord, ProviderAccountStoreError>
  readonly findReplay: (
    query: ProviderAccountReplayQuery,
  ) => Effect.Effect<ProviderAccountLifecycleResult | null, ProviderAccountStoreError>
  readonly commit: (
    input: ProviderAccountCommitInput,
  ) => Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountStoreError>
}
export class ProviderAccountActionRepository extends Context.Service<
  ProviderAccountActionRepository,
  ProviderAccountActionRepositoryShape
>()('@gridora/provider-account-control/ProviderAccountActionRepository') {}
export const ProviderAccountActionRepositoryLayer = (
  repository: ProviderAccountActionRepositoryShape,
) => Layer.succeed(ProviderAccountActionRepository, repository)

export interface ProviderAccountValidationInput {
  /** This buffer is valid only for the duration of `validate`; callers zero it immediately after. */
  readonly credentialBytes: Uint8Array
  readonly organizationId: string
  readonly accountId: string
  readonly refresh: boolean
}
export interface ProviderAccountValidatorShape {
  readonly validate: (
    input: ProviderAccountValidationInput,
  ) => Effect.Effect<ProviderDiscoverySnapshot, ProviderError>
}
export class OvhProviderAccountValidator extends Context.Service<
  OvhProviderAccountValidator,
  ProviderAccountValidatorShape
>()('@gridora/provider-account-control/OvhProviderAccountValidator') {}
export class ContaboProviderAccountValidator extends Context.Service<
  ContaboProviderAccountValidator,
  ProviderAccountValidatorShape
>()('@gridora/provider-account-control/ContaboProviderAccountValidator') {}
export const OvhProviderAccountValidatorLayer = (validator: ProviderAccountValidatorShape) =>
  Layer.succeed(OvhProviderAccountValidator, validator)
export const ContaboProviderAccountValidatorLayer = (validator: ProviderAccountValidatorShape) =>
  Layer.succeed(ContaboProviderAccountValidator, validator)

export interface ProviderAccountLifecycleCommand {
  readonly context: OrganizationContext
  readonly accountId: string
  readonly expectedRevision: number
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly operationId: OperationId
  readonly auditEventId: string
  readonly auditRequestContext: AuditRequestContext
  readonly operationIdempotencyKey: IdempotencyKey
  readonly now: string
}

export type ProviderAccountControlError =
  | AuthorizationError
  | NotFoundError
  | ConflictError
  | RevisionConflictError
  | PersistenceError

export interface ProviderAccountControlShape {
  readonly test: (
    command: ProviderAccountLifecycleCommand,
  ) => Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountControlError>
  readonly refresh: (
    command: ProviderAccountLifecycleCommand,
  ) => Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountControlError>
  readonly disable: (
    command: ProviderAccountLifecycleCommand,
  ) => Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountControlError>
  readonly remove: (
    command: ProviderAccountLifecycleCommand,
  ) => Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountControlError>
  readonly assertUsable: (
    context: OrganizationContext,
    accountId: string,
    providerType: ProviderAccountType,
  ) => Effect.Effect<ProviderAccountMetadata, ProviderAccountControlError>
}
export class ProviderAccountControl extends Context.Service<
  ProviderAccountControl,
  ProviderAccountControlShape
>()('@gridora/provider-account-control/ProviderAccountControl') {}

const safeProviderCategory = (error: ProviderError): ProviderAccountFailureCategory => {
  switch (error._tag) {
    case 'ProviderAuthenticationError':
      return 'authentication_failed'
    case 'ProviderAuthorizationError':
      return 'authorization_failed'
    case 'ProviderValidationError':
      return 'validation_failed'
    case 'ProviderQuotaError':
      return 'quota_exceeded'
    case 'ProviderNotFoundError':
      return 'not_found'
    case 'ProviderConflictError':
      return 'conflict'
    case 'ProviderRateLimitError':
      return 'rate_limited'
    case 'ProviderTemporaryError':
    case 'ProviderCreateUncertainError':
      return 'temporarily_unavailable'
    case 'ProviderBillingActionRequiredError':
      return 'billing_action_required'
    case 'ProviderUnsupportedCapabilityError':
      return 'unsupported'
    case 'ProviderUnknownError':
      return 'provider_unavailable'
  }
}

const storeError = (error: ProviderAccountStoreError): ProviderAccountControlError => {
  switch (error._tag) {
    case 'ProviderAccountStoreNotFoundError':
      return new NotFoundError({ resource: 'provider-account', id: error.accountId })
    case 'ProviderAccountStoreRevisionError':
      return new RevisionConflictError({
        resource: 'provider-account',
        expected: error.expectedRevision,
        actual: error.actualRevision,
      })
    case 'ProviderAccountStoreConflictError':
      return new ConflictError({
        code: `provider_account_${error.code}`,
        message:
          error.code === 'idempotency_payload_mismatch'
            ? 'Idempotency-Key was already used with a different provider-account request'
            : error.code === 'account_not_disabled'
              ? 'Provider account must be disabled before removal'
              : error.code === 'account_not_active'
                ? 'Provider account is disabled or unavailable'
                : error.code === 'account_referenced'
                  ? 'Provider account still has provider allocation or node references'
                  : 'Provider account type does not match the requested provider',
      })
    case 'ProviderAccountStorePersistenceError':
      return new PersistenceError({
        operation: error.operation,
        message: 'Provider account persistence is unavailable',
      })
  }
}

const secretError = (_error: SecretEnvelopeError): PersistenceError =>
  new PersistenceError({
    operation: 'providerAccount.credentials.open',
    message: 'Provider account credential validation is unavailable',
  })
const isPersistenceError = (error: ProviderError | PersistenceError): error is PersistenceError =>
  error._tag === 'PersistenceError'

const requireRole = (
  context: OrganizationContext,
  required: 'administrator' | 'owner',
): Effect.Effect<void, AuthorizationError> =>
  roleAtLeast(context.role, required)
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'role_required',
          message: `The ${required} organization role is required`,
        }),
      )

const metadata = (account: ProviderAccountRecord): ProviderAccountMetadata =>
  new ProviderAccountMetadata({
    id: account.id,
    scope: 'organization',
    organizationId: account.organizationId as never,
    providerType: account.providerType,
    status: account.status,
    revision: account.revision,
    credentialRevision: account.credentialRevision,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  })

const emptySnapshot = new ProviderDiscoverySnapshot({ regions: [], projects: [], catalog: [] })

const resultFor = (
  command: ProviderAccountLifecycleCommand,
  account: ProviderAccountRecord,
  action: ProviderAccountLifecycleAction,
  outcome: ProviderAccountLifecycleOutcome,
  accountStatus: ProviderAccountStatus | null,
  failureCategory: ProviderAccountFailureCategory | null,
  snapshot: ProviderDiscoverySnapshot,
) =>
  new ProviderAccountLifecycleResult({
    accountId: account.id,
    organizationId: account.organizationId,
    providerType: account.providerType,
    action,
    outcome,
    accountStatus,
    revision: command.expectedRevision + 1,
    operationId: command.operationId,
    failureCategory,
    regionCount: snapshot.regions.length,
    projectCount: snapshot.projects.length,
    catalogItemCount: snapshot.catalog.length,
    completedAt: command.now as never,
  })

const assertCommand = (
  command: ProviderAccountLifecycleCommand,
): Effect.Effect<void, ProviderAccountControlError> =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      context: OrganizationContext,
      accountId: Identifier,
      expectedRevision: PositiveRevision,
      idempotencyKey: IdempotencyKey,
      requestFingerprint: RequestFingerprint,
      operationId: OperationId,
      auditEventId: Identifier,
      auditRequestContext: AuditRequestContextValue,
      operationIdempotencyKey: IdempotencyKey,
      now: IsoDateTime,
    }),
    { onExcessProperty: 'error' },
  )(command).pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new ConflictError({
          code: 'provider_account_invalid_command',
          message: 'Provider account lifecycle command is invalid',
        }),
    ),
  )

export const ProviderAccountControlLive = Layer.effect(
  ProviderAccountControl,
  Effect.gen(function* () {
    const repository = yield* ProviderAccountActionRepository
    const secrets = yield* SecretEnvelopeService
    const ovh = yield* OvhProviderAccountValidator
    const contabo = yield* ContaboProviderAccountValidator

    const replay = (
      command: ProviderAccountLifecycleCommand,
      action: ProviderAccountLifecycleAction,
      required: 'administrator' | 'owner',
    ) =>
      Effect.gen(function* () {
        yield* assertCommand(command)
        yield* requireRole(command.context, required)
        return yield* repository
          .findReplay({
            context: command.context,
            accountId: command.accountId,
            action,
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
          })
          .pipe(Effect.mapError(storeError))
      })

    const getExpected = (command: ProviderAccountLifecycleCommand) =>
      Effect.gen(function* () {
        const account = yield* repository
          .getScoped(command.context, command.accountId)
          .pipe(Effect.mapError(storeError))
        if (account.revision !== command.expectedRevision)
          return yield* new RevisionConflictError({
            resource: 'provider-account',
            expected: command.expectedRevision,
            actual: account.revision,
          })
        return account
      })

    const validate = (
      command: ProviderAccountLifecycleCommand,
      action: 'test' | 'refresh',
    ): Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountControlError> =>
      Effect.gen(function* () {
        const repeated = yield* replay(command, action, 'administrator')
        if (repeated !== null) return repeated
        const account = yield* getExpected(command)
        if (action === 'refresh' && account.status !== 'active')
          return yield* storeError(
            new ProviderAccountStoreConflictError({
              accountId: account.id,
              code: 'account_not_active',
            }),
          )
        const validator = account.providerType === 'ovhcloud' ? ovh : contabo
        const validation = yield* Effect.result(
          Effect.acquireUseRelease(
            secrets
              .open(command.context, {
                id: account.credentialReference,
                scopeType: 'provider-account',
                scopeId: account.id,
              })
              .pipe(Effect.mapError(secretError)),
            (credentialBytes) =>
              Effect.suspend(() =>
                validator.validate({
                  credentialBytes,
                  organizationId: account.organizationId,
                  accountId: account.id,
                  refresh: action === 'refresh',
                }),
              ).pipe(
                Effect.flatMap((discovery) =>
                  Schema.decodeUnknownEffect(ProviderDiscoverySnapshot, {
                    onExcessProperty: 'error',
                  })(discovery).pipe(
                    Effect.mapError(
                      () =>
                        new ProviderValidationError({
                          provider: account.providerType,
                          operation: `providerAccount.${action}`,
                          message: 'Provider discovery returned an invalid normalized response',
                        }),
                    ),
                  ),
                ),
              ),
            (credentialBytes) => Effect.sync(() => credentialBytes.fill(0)),
          ),
        )
        let snapshot = emptySnapshot
        let category: ProviderAccountFailureCategory | null = null
        let retryable = false
        if (validation._tag === 'Success') {
          snapshot = validation.success
        } else {
          const validationError = validation.failure
          if (isPersistenceError(validationError)) return yield* validationError
          category = safeProviderCategory(validationError)
          retryable =
            isRetryableProviderError(validationError) ||
            validationError._tag === 'ProviderCreateUncertainError'
        }
        const outcome =
          validation._tag === 'Success'
            ? action === 'test'
              ? 'valid'
              : 'refreshed'
            : retryable
              ? 'retryable_failure'
              : 'permanent_failure'
        const nextStatus =
          validation._tag === 'Success' ? 'active' : retryable ? account.status : 'error'
        const result = resultFor(command, account, action, outcome, nextStatus, category, snapshot)
        return yield* repository
          .commit({
            context: command.context,
            accountId: account.id,
            account,
            action,
            expectedRevision: command.expectedRevision,
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            result,
            catalog: validation._tag === 'Success' && action === 'refresh' ? snapshot.catalog : [],
            auditEventId: command.auditEventId,
            auditRequestContext: command.auditRequestContext,
            operationIdempotencyKey: command.operationIdempotencyKey,
          })
          .pipe(Effect.mapError(storeError))
      })

    const mutateWithoutProvider = (
      command: ProviderAccountLifecycleCommand,
      action: 'disable' | 'remove',
    ): Effect.Effect<ProviderAccountLifecycleResult, ProviderAccountControlError> =>
      Effect.gen(function* () {
        const repeated = yield* replay(command, action, 'owner')
        if (repeated !== null) return repeated
        const account = yield* getExpected(command)
        if (action === 'remove' && account.status !== 'disabled')
          return yield* storeError(
            new ProviderAccountStoreConflictError({
              accountId: account.id,
              code: 'account_not_disabled',
            }),
          )
        const result = resultFor(
          command,
          account,
          action,
          action === 'disable' ? 'disabled' : 'removed',
          action === 'disable' ? 'disabled' : null,
          null,
          emptySnapshot,
        )
        return yield* repository
          .commit({
            context: command.context,
            accountId: account.id,
            account,
            action,
            expectedRevision: command.expectedRevision,
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            result,
            catalog: [],
            auditEventId: command.auditEventId,
            auditRequestContext: command.auditRequestContext,
            operationIdempotencyKey: command.operationIdempotencyKey,
          })
          .pipe(Effect.mapError(storeError))
      })

    const service: ProviderAccountControlShape = {
      test: (command) => validate(command, 'test'),
      refresh: (command) => validate(command, 'refresh'),
      disable: (command) => mutateWithoutProvider(command, 'disable'),
      remove: (command) => mutateWithoutProvider(command, 'remove'),
      assertUsable: (context, accountId, providerType) =>
        Effect.gen(function* () {
          const account = yield* repository
            .getScoped(context, accountId)
            .pipe(Effect.mapError(storeError))
          if (account.providerType !== providerType)
            return yield* storeError(
              new ProviderAccountStoreConflictError({
                accountId,
                code: 'provider_type_mismatch',
              }),
            )
          if (account.status !== 'active')
            return yield* storeError(
              new ProviderAccountStoreConflictError({ accountId, code: 'account_not_active' }),
            )
          return metadata(account)
        }),
    }
    return service
  }),
)

/** Convenience layer for tests and application composition. */
export const ProviderAccountControlLayer = (dependencies: {
  readonly repository: ProviderAccountActionRepositoryShape
  readonly secrets: SecretEnvelopeServiceShape
  readonly ovh: ProviderAccountValidatorShape
  readonly contabo: ProviderAccountValidatorShape
}) =>
  ProviderAccountControlLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderAccountActionRepositoryLayer(dependencies.repository),
        Layer.succeed(SecretEnvelopeService, dependencies.secrets),
        OvhProviderAccountValidatorLayer(dependencies.ovh),
        ContaboProviderAccountValidatorLayer(dependencies.contabo),
      ),
    ),
  )

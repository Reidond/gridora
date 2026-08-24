import { Context, Effect, Layer, Schema } from 'effect'
import type { PlatformActor } from '@gridora/platform-authority'
import type {
  PlatformSecretEnvelopeShape,
  PlatformSecretRecord,
} from '@gridora/platform-secret-envelope'
import {
  ProviderAccountType,
  type ProviderAccountValidatorShape,
} from '@gridora/provider-account-control'
import type { ProviderError } from '@gridora/provider-sdk'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
)
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const PlatformAccountStatus = Schema.Literals(['active', 'disabled', 'error'])
export class PlatformProviderAccount extends Schema.Class<PlatformProviderAccount>(
  'PlatformProviderAccount',
)({
  id: Identifier,
  scope: Schema.Literal('platform'),
  organizationId: Schema.Null,
  providerType: ProviderAccountType,
  credentialReference: Identifier,
  credentialRevision: Revision,
  status: PlatformAccountStatus,
  revision: Revision,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}
export class PlatformAllocation extends Schema.Class<PlatformAllocation>('PlatformAllocation')({
  organizationId: Identifier,
  accountId: Identifier,
  allowedRegions: Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  allowedPlans: Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  maxActiveNodes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  monthlyBudgetMinor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  status: Schema.Literals(['active', 'disabled']),
  revision: Revision,
}) {}
export class PlatformProviderControlError extends Schema.TaggedError<PlatformProviderControlError>()(
  'PlatformProviderControlError',
  {
    operation: Schema.String,
    code: Schema.Literals([
      'not_found',
      'conflict',
      'revision_conflict',
      'account_busy',
      'invalid_scope',
      'validation_failed',
      'persistence',
    ]),
  },
) {}
export interface PlatformMutation {
  readonly actor: PlatformActor
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  /** Deterministic durable terminal operation for this exact platform mutation. */
  readonly operationId: string
  /** Actor/action-scoped SHA-256 key, independent of the raw HTTP replay key. */
  readonly operationIdempotencyKey: string
  /** Deterministic compact audit event bound to `operationId`. */
  readonly auditEventId: string
  readonly now: string
}
export interface AccountMutation extends PlatformMutation {
  readonly accountId: string
  readonly expectedRevision: number
}
export interface PlatformProviderRepositoryShape {
  readonly findAccountReplay: (
    key: string,
    fingerprint: string,
  ) => Effect.Effect<PlatformProviderAccount | null, PlatformProviderControlError>
  readonly getAccount: (
    id: string,
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly createAccount: (
    input: PlatformMutation & {
      readonly account: PlatformProviderAccount
      readonly secret: PlatformSecretRecord
    },
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly updateAccount: (
    input: AccountMutation & {
      readonly status: PlatformProviderAccount['status']
      readonly credentialRevision: number
      readonly secret?: PlatformSecretRecord
      readonly action: 'validate' | 'disable' | 'rotate'
    },
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly removeAccount: (
    input: AccountMutation & { readonly credentialRevision: number },
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly findAllocationReplay: (
    key: string,
    fingerprint: string,
  ) => Effect.Effect<PlatformAllocation | null, PlatformProviderControlError>
  readonly putAllocation: (
    input: PlatformMutation & {
      readonly allocation: PlatformAllocation
      readonly expectedRevision: number
      readonly action: 'create' | 'update' | 'disable'
    },
  ) => Effect.Effect<PlatformAllocation, PlatformProviderControlError>
}
export class PlatformProviderRepository extends Context.Service<
  PlatformProviderRepository,
  PlatformProviderRepositoryShape
>()('@gridora/platform-provider-control/Repository') {}
export const PlatformProviderRepositoryLayer = (repo: PlatformProviderRepositoryShape) =>
  Layer.succeed(PlatformProviderRepository, repo)
export interface PlatformCredentialOpenerShape {
  readonly open: (
    accountId: string,
    expectedAccountRevision: number,
    expectedCredentialRevision: number,
  ) => Effect.Effect<Uint8Array, PlatformProviderControlError>
}
export class PlatformCredentialOpener extends Context.Service<
  PlatformCredentialOpener,
  PlatformCredentialOpenerShape
>()('@gridora/platform-provider-control/CredentialOpener') {}
export interface PlatformProviderControlShape {
  readonly add: (
    input: PlatformMutation & {
      accountId: string
      providerType: typeof ProviderAccountType.Type
      credentials: Uint8Array
    },
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly validate: (
    input: AccountMutation,
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly disable: (
    input: AccountMutation,
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly rotate: (
    input: AccountMutation & { credentials: Uint8Array },
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly remove: (
    input: AccountMutation,
  ) => Effect.Effect<PlatformProviderAccount, PlatformProviderControlError>
  readonly putAllocation: (
    input: PlatformMutation & {
      allocation: Omit<PlatformAllocation, 'revision'>
      expectedRevision: number
    },
  ) => Effect.Effect<PlatformAllocation, PlatformProviderControlError>
}
export class PlatformProviderControl extends Context.Service<
  PlatformProviderControl,
  PlatformProviderControlShape
>()('@gridora/platform-provider-control/Control') {}

const mapped = (operation: string) => (_: unknown) =>
  new PlatformProviderControlError({ operation, code: 'persistence' })
const validateCredentials = (
  account: PlatformProviderAccount,
  bytes: Uint8Array,
  validator: ProviderAccountValidatorShape,
) =>
  validator
    .validate({
      credentialBytes: bytes,
      organizationId: 'platform',
      accountId: account.id,
      refresh: true,
    })
    .pipe(
      Effect.mapError(
        (_: ProviderError) =>
          new PlatformProviderControlError({
            operation: 'platformProvider.validate',
            code: 'validation_failed',
          }),
      ),
    )
export const makePlatformCredentialOpener = (
  repo: PlatformProviderRepositoryShape,
  secrets: PlatformSecretEnvelopeShape,
): PlatformCredentialOpenerShape => ({
  open: (accountId, accountRevision, credentialRevision) =>
    Effect.gen(function* () {
      const account = yield* repo.getAccount(accountId)
      if (account.scope !== 'platform' || account.organizationId !== null)
        return yield* new PlatformProviderControlError({
          operation: 'platformCredential.open',
          code: 'invalid_scope',
        })
      if (
        account.status !== 'active' ||
        account.revision !== accountRevision ||
        account.credentialRevision !== credentialRevision
      )
        return yield* new PlatformProviderControlError({
          operation: 'platformCredential.open',
          code: 'revision_conflict',
        })
      return yield* secrets.open(accountId).pipe(Effect.mapError(mapped('platformCredential.open')))
    }),
})
export const makePlatformProviderControl = (
  repo: PlatformProviderRepositoryShape,
  secrets: PlatformSecretEnvelopeShape,
  validatorFor: (type: typeof ProviderAccountType.Type) => ProviderAccountValidatorShape,
): PlatformProviderControlShape => ({
  add: (input) =>
    Effect.acquireUseRelease(
      Effect.succeed(input.credentials),
      (credentials) =>
        Effect.gen(function* () {
          const replay = yield* repo.findAccountReplay(
            input.idempotencyKey,
            input.requestFingerprint,
          )
          if (replay !== null) return replay
          const credentialReference = `platform-provider-${input.accountId}`
          const account = new PlatformProviderAccount({
            id: input.accountId,
            scope: 'platform',
            organizationId: null,
            providerType: input.providerType,
            credentialReference,
            credentialRevision: 1,
            status: 'active',
            revision: 1,
            createdAt: input.now,
            updatedAt: input.now,
          })
          yield* validateCredentials(account, credentials, validatorFor(account.providerType))
          const secret = yield* secrets
            .prepareSeal({
              id: credentialReference,
              accountId: account.id,
              plaintext: credentials,
              now: input.now,
            })
            .pipe(Effect.mapError(mapped('platformProvider.secret.seal')))
          return yield* repo.createAccount({ ...input, account, secret })
        }),
      (bytes) => Effect.sync(() => bytes.fill(0)),
    ),
  validate: (input) =>
    Effect.gen(function* () {
      const replay = yield* repo.findAccountReplay(input.idempotencyKey, input.requestFingerprint)
      if (replay !== null) return replay
      const account = yield* repo.getAccount(input.accountId)
      const bytes = yield* secrets
        .open(account.id)
        .pipe(Effect.mapError(mapped('platformProvider.secret.open')))
      yield* Effect.acquireUseRelease(
        Effect.succeed(bytes),
        (credential) =>
          validateCredentials(account, credential, validatorFor(account.providerType)),
        (credential) => Effect.sync(() => credential.fill(0)),
      )
      return yield* repo.updateAccount({
        ...input,
        status: 'active',
        credentialRevision: account.credentialRevision,
        action: 'validate',
      })
    }),
  disable: (input) =>
    Effect.gen(function* () {
      const replay = yield* repo.findAccountReplay(input.idempotencyKey, input.requestFingerprint)
      if (replay !== null) return replay
      const account = yield* repo.getAccount(input.accountId)
      return yield* repo.updateAccount({
        ...input,
        status: 'disabled',
        credentialRevision: account.credentialRevision,
        action: 'disable',
      })
    }),
  rotate: (input) =>
    Effect.acquireUseRelease(
      Effect.succeed(input.credentials),
      (credentials) =>
        Effect.gen(function* () {
          const replay = yield* repo.findAccountReplay(
            input.idempotencyKey,
            input.requestFingerprint,
          )
          if (replay !== null) return replay
          const account = yield* repo.getAccount(input.accountId)
          yield* validateCredentials(account, credentials, validatorFor(account.providerType))
          const current = yield* secrets
            .getRecord(account.id)
            .pipe(Effect.mapError(mapped('platformProvider.secret.read')))
          if (current.revision !== account.credentialRevision)
            return yield* new PlatformProviderControlError({
              operation: 'platformProvider.rotate',
              code: 'revision_conflict',
            })
          const secret = yield* secrets
            .prepareRotation({ current, plaintext: credentials, now: input.now })
            .pipe(Effect.mapError(mapped('platformProvider.secret.rotate')))
          return yield* repo.updateAccount({
            ...input,
            status: 'active',
            credentialRevision: secret.revision,
            secret,
            action: 'rotate',
          })
        }),
      (bytes) => Effect.sync(() => bytes.fill(0)),
    ),
  remove: (input) =>
    Effect.gen(function* () {
      const replay = yield* repo.findAccountReplay(input.idempotencyKey, input.requestFingerprint)
      if (replay !== null) return replay
      const account = yield* repo.getAccount(input.accountId)
      return yield* repo.removeAccount({
        ...input,
        credentialRevision: account.credentialRevision,
      })
    }),
  putAllocation: (input) =>
    Effect.gen(function* () {
      const replay = yield* repo.findAllocationReplay(
        input.idempotencyKey,
        input.requestFingerprint,
      )
      if (replay !== null) return replay
      const revision = input.expectedRevision + 1
      const allocation = new PlatformAllocation({ ...input.allocation, revision })
      const action =
        input.expectedRevision === 0
          ? ('create' as const)
          : allocation.status === 'disabled'
            ? ('disable' as const)
            : ('update' as const)
      return yield* repo.putAllocation({
        ...input,
        allocation,
        action,
      })
    }),
})

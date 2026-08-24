import { Context, Effect, Layer, Schema } from 'effect'
import type { OrganizationContext } from '@gridora/domain'

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const idempotencyKey = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const BackupTrigger = Schema.Literals(['manual', 'scheduled'])
export type BackupTrigger = typeof BackupTrigger.Type
export const BackupJobMode = Schema.Literals(['create', 'restore'])
export type BackupJobMode = typeof BackupJobMode.Type
export const BackupJobState = Schema.Literals([
  'reserved',
  'running',
  'waiting_external',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
  'failed_terminal',
])
export type BackupJobState = typeof BackupJobState.Type
export const BackupArtifactState = Schema.Literals([
  'creating',
  'available',
  'restoring',
  'expired',
  'deleted',
  'failed',
])
export type BackupArtifactState = typeof BackupArtifactState.Type

export const BackupMetadata = Schema.Struct({
  pluginId: identifier,
  pluginVersion: identifier,
  gameBuild: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  configRevision: positive,
  modSetRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  desiredRevision: positive,
  nodeId: identifier,
  consistency: Schema.Literals(['crash-consistent', 'plugin-quiesced']),
  includes: Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state'])),
  containsGameBinaries: Schema.Literal(false),
})
export type BackupMetadata = typeof BackupMetadata.Type

export const BackupArtifact = Schema.Struct({
  organizationId: identifier,
  id: identifier,
  serverId: identifier,
  r2Key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  checksum: digest,
  encryptionVersion: positive,
  metadata: BackupMetadata,
  state: BackupArtifactState,
  revision: positive,
  createdAt: timestamp,
  expiresAt: Schema.NullOr(timestamp),
})
export type BackupArtifact = typeof BackupArtifact.Type

/** Public create intent. Server/plugin/build/node facts are resolved from D1. */
export const BackupCreateIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  includes: Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state'])),
  expiresAt: Schema.NullOr(timestamp),
})
export type BackupCreateIntent = typeof BackupCreateIntent.Type

export const BackupRestoreIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backupId: identifier,
  targetServerId: Schema.optional(identifier),
  targetNodeId: Schema.optional(identifier),
})
export type BackupRestoreIntent = typeof BackupRestoreIntent.Type

export interface BackupCreateFacts {
  readonly backupId: string
  readonly serverId: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly gameBuild: string
  readonly configRevision: number
  readonly modSetRevision: number
  readonly desiredRevision: number
  readonly nodeId: string
  readonly consistency: 'crash-consistent' | 'plugin-quiesced'
  readonly trigger: BackupTrigger
}
export interface BackupRestoreFacts {
  readonly sourceServerId: string
  readonly sourceNodeId: string
  readonly targetServerId: string
  readonly targetNodeId: string
  readonly metadata: BackupMetadata
  readonly expectedTargetRevision: number
}

export interface BackupJob {
  readonly organizationId: string
  readonly id: string
  readonly operationId: string
  readonly mode: BackupJobMode
  readonly trigger: BackupTrigger
  readonly backupId: string
  readonly sourceServerId: string
  readonly targetServerId: string | null
  readonly sourceNodeId: string | null
  readonly targetNodeId: string | null
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly completionFingerprint: string | null
  readonly state: BackupJobState
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly cancelledAt: string | null
}

export interface BackupCreateReservation {
  readonly disposition: 'created' | 'adopted'
  readonly job: BackupJob
  readonly artifact: BackupArtifact
}
export interface BackupRestoreReservation {
  readonly disposition: 'created' | 'adopted'
  readonly job: BackupJob
  readonly artifact: BackupArtifact
}

export class BackupValidationError extends Schema.TaggedError<BackupValidationError>()(
  'BackupValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class BackupAuthorizationError extends Schema.TaggedError<BackupAuthorizationError>()(
  'BackupAuthorizationError',
  { code: Schema.Literals(['operator_required', 'administrator_required']) },
) {}
export class BackupNotFoundError extends Schema.TaggedError<BackupNotFoundError>()(
  'BackupNotFoundError',
  { backupId: Schema.String },
) {}
export class BackupConflictError extends Schema.TaggedError<BackupConflictError>()(
  'BackupConflictError',
  { code: Schema.String, message: Schema.String },
) {}
export class BackupConcurrencyError extends Schema.TaggedError<BackupConcurrencyError>()(
  'BackupConcurrencyError',
  { code: Schema.String, message: Schema.String },
) {}
export class BackupPersistenceError extends Schema.TaggedError<BackupPersistenceError>()(
  'BackupPersistenceError',
  { operation: Schema.String },
) {}

export type BackupControlError =
  | BackupValidationError
  | BackupAuthorizationError
  | BackupNotFoundError
  | BackupConflictError
  | BackupConcurrencyError
  | BackupPersistenceError

export interface BackupRepositoryShape {
  readonly reserveCreate: (
    input: BackupRepositoryCreateInput,
  ) => Effect.Effect<
    BackupCreateReservation,
    BackupNotFoundError | BackupConflictError | BackupPersistenceError
  >
  readonly reserveRestore: (
    input: BackupRepositoryRestoreInput,
  ) => Effect.Effect<
    BackupRestoreReservation,
    BackupNotFoundError | BackupConflictError | BackupConcurrencyError | BackupPersistenceError
  >
  readonly get: (
    context: OrganizationContext,
    backupId: string,
  ) => Effect.Effect<BackupArtifact, BackupNotFoundError | BackupPersistenceError>
  readonly list: (
    context: OrganizationContext,
    options: { readonly limit: number; readonly cursor?: string; readonly serverId?: string },
  ) => Effect.Effect<
    { readonly items: ReadonlyArray<BackupArtifact>; readonly nextCursor?: string },
    BackupPersistenceError
  >
  readonly markRunning: (
    organizationId: string,
    jobId: string,
    expectedRevision: number,
    now: string,
  ) => Effect.Effect<BackupJob, BackupConcurrencyError | BackupPersistenceError>
  readonly markSucceeded: (
    input: BackupCompleteInput,
  ) => Effect.Effect<
    BackupJob,
    BackupConflictError | BackupConcurrencyError | BackupNotFoundError | BackupPersistenceError
  >
  readonly markFailed: (
    input: BackupFailureInput,
  ) => Effect.Effect<BackupJob, BackupConcurrencyError | BackupPersistenceError>
  readonly requestCancel: (
    organizationId: string,
    jobId: string,
    expectedRevision: number,
    now: string,
  ) => Effect.Effect<BackupJob, BackupConcurrencyError | BackupPersistenceError>
  /** Claim before private-R2 deletion. A retry adopts the same claim. */
  readonly claimDelete: (
    input: BackupDeleteClaimInput,
  ) => Effect.Effect<
    BackupDeletionClaim,
    BackupNotFoundError | BackupConflictError | BackupConcurrencyError | BackupPersistenceError
  >
  /** Complete only after the idempotent private-R2 delete succeeds. */
  readonly completeDelete: (
    input: BackupDeleteCompletionInput,
  ) => Effect.Effect<
    BackupArtifact,
    BackupConflictError | BackupConcurrencyError | BackupNotFoundError | BackupPersistenceError
  >
  /** Record a bounded, secret-free failure while retaining the deletion claim for retry. */
  readonly recordDeleteFailure: (
    input: BackupDeleteFailureInput,
  ) => Effect.Effect<void, BackupConcurrencyError | BackupPersistenceError>
  /** Claim or adopt expired artifacts for bounded physical retention deletion. */
  readonly claimRetentionDeletes: (
    now: string,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<BackupRetentionDeletionClaim>,
    BackupNotFoundError | BackupConflictError | BackupConcurrencyError | BackupPersistenceError
  >
  readonly expire: (
    now: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BackupArtifact>, BackupPersistenceError>
}
export class BackupRepository extends Context.Service<BackupRepository, BackupRepositoryShape>()(
  '@gridora/backup-control/BackupRepository',
) {}
export const BackupRepositoryLayer = (repository: BackupRepositoryShape) =>
  Layer.succeed(BackupRepository, repository)

export interface BackupRepositoryCreateInput {
  readonly context: OrganizationContext
  readonly operationId: string
  readonly jobId: string
  readonly backupId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly facts: BackupCreateFacts
  readonly intent: BackupCreateIntent
  readonly r2Key: string
  readonly now: string
}
export interface BackupRepositoryRestoreInput {
  readonly context: OrganizationContext
  readonly operationId: string
  readonly jobId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly intent: BackupRestoreIntent
  readonly facts: BackupRestoreFacts
  readonly now: string
}
export interface BackupCompleteInput {
  readonly organizationId: string
  readonly jobId: string
  readonly expectedRevision: number
  readonly checksum: string
  readonly encryptionVersion: number
  readonly r2Key: string
  readonly manifest: BackupMetadata
  /** SHA-256 over the complete canonical completion evidence. */
  readonly completionFingerprint: string
  readonly now: string
}
export interface BackupFailureInput {
  readonly organizationId: string
  readonly jobId: string
  readonly expectedRevision: number
  readonly terminal: boolean
  readonly now: string
}

export interface BackupDeleteClaimInput {
  readonly context: OrganizationContext
  readonly backupId: string
  readonly expectedRevision: number
  readonly claimId: string
  readonly now: string
}

export interface BackupDeleteCompletionInput {
  readonly context: OrganizationContext
  readonly claimId: string
  readonly expectedArtifactRevision: number
  readonly deletedPrefix: string
  readonly deletedObjects: number
  readonly alreadyAbsent: boolean
  readonly now: string
}

export interface BackupDeleteFailureInput {
  readonly context: OrganizationContext
  readonly claimId: string
  /** A stable, non-secret classification such as `r2_delete_failed`. */
  readonly failureCode: string
  readonly now: string
}

export interface BackupDeletionClaim {
  readonly claimId: string
  readonly operationId: string
  readonly backupId: string
  readonly organizationId: string
  readonly serverId: string
  readonly r2Key: string
  /** Artifact bytes remain logically available while deletion is in flight. */
  readonly artifact: BackupArtifact
  readonly state: 'deleting' | 'deleted'
}

export interface BackupRetentionDeletionClaim {
  readonly context: OrganizationContext
  readonly claim: BackupDeletionClaim
}

export interface BackupPluginCompatibilityShape {
  readonly validateRestore: (input: {
    readonly metadata: BackupMetadata
    readonly targetServerId: string
    readonly targetNodeId: string
  }) => Effect.Effect<void, BackupConflictError>
}
export class BackupPluginCompatibility extends Context.Service<
  BackupPluginCompatibility,
  BackupPluginCompatibilityShape
>()('@gridora/backup-control/BackupPluginCompatibility') {}
export const BackupPluginCompatibilityLayer = (port: BackupPluginCompatibilityShape) =>
  Layer.succeed(BackupPluginCompatibility, port)

export interface BackupServerFactsShape {
  readonly resolveCreate: (input: {
    readonly context: OrganizationContext
    readonly serverId: string
    readonly idempotencyKey: string
    readonly requestedIncludes: ReadonlyArray<BackupCreateIntent['includes'][number]>
    readonly expiresAt: string | null
  }) => Effect.Effect<BackupCreateFacts, BackupConflictError | BackupPersistenceError>
  readonly resolveRestore: (input: {
    readonly context: OrganizationContext
    readonly intent: BackupRestoreIntent
  }) => Effect.Effect<
    BackupRestoreFacts,
    BackupNotFoundError | BackupConflictError | BackupPersistenceError
  >
}
export class BackupServerFacts extends Context.Service<BackupServerFacts, BackupServerFactsShape>()(
  '@gridora/backup-control/BackupServerFacts',
) {}
export const BackupServerFactsLayer = (port: BackupServerFactsShape) =>
  Layer.succeed(BackupServerFacts, port)

export interface BackupFingerprintShape {
  readonly digest: (value: string) => Effect.Effect<string, BackupPersistenceError>
}
export class BackupFingerprint extends Context.Service<BackupFingerprint, BackupFingerprintShape>()(
  '@gridora/backup-control/BackupFingerprint',
) {}
export const BackupFingerprintLayer = (port: BackupFingerprintShape) =>
  Layer.succeed(BackupFingerprint, port)

export const WebCryptoBackupFingerprint: BackupFingerprintShape = {
  digest: (value) =>
    Effect.tryPromise({
      try: async () => {
        const bytes = new TextEncoder().encode(value)
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      },
      catch: () => new BackupPersistenceError({ operation: 'backup.fingerprint' }),
    }),
}

export interface BackupObjectDeletionShape {
  readonly remove: (input: {
    readonly organizationId: string
    readonly serverId: string
    readonly backupId: string
    readonly r2Key: string
  }) => Effect.Effect<
    {
      /** Number of exact-prefix objects removed (manifest plus encrypted chunks). */
      readonly deletedObjects: number
      /** True when an earlier attempt already removed the exact prefix. */
      readonly alreadyAbsent: boolean
      /** Must equal the claimed backup prefix; prevents foreign-prefix deletion. */
      readonly deletedPrefix: string
    },
    BackupPersistenceError
  >
}
export class BackupObjectDeletion extends Context.Service<
  BackupObjectDeletion,
  BackupObjectDeletionShape
>()('@gridora/backup-control/BackupObjectDeletion') {}
export const BackupObjectDeletionLayer = (port: BackupObjectDeletionShape) =>
  Layer.succeed(BackupObjectDeletion, port)

export interface BackupClockShape {
  readonly now: Effect.Effect<string>
}
export class BackupClock extends Context.Service<BackupClock, BackupClockShape>()(
  '@gridora/backup-control/BackupClock',
) {}
export const BackupClockLayer = (clock: BackupClockShape) => Layer.succeed(BackupClock, clock)

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export const canonicalBackupRequest = (value: unknown): string => canonicalJson(value)

const validIncludes = (includes: ReadonlyArray<BackupCreateIntent['includes'][number]>) =>
  includes.length > 0 && new Set(includes).size === includes.length

const validateCreate = (context: OrganizationContext, intent: BackupCreateIntent) => {
  if (!validIncludes(intent.includes))
    return new BackupValidationError({
      code: 'invalid_backup_create',
      message: 'Backup request is invalid',
    })
  return undefined
}

const validateRestore = (intent: BackupRestoreIntent) =>
  intent.backupId.length === 0
    ? new BackupValidationError({
        code: 'invalid_backup_restore',
        message: 'Restore request is invalid',
      })
    : undefined

export interface BackupControlShape {
  readonly create: (
    context: OrganizationContext,
    input: {
      readonly serverId: string
      readonly idempotencyKey: string
      readonly intent: BackupCreateIntent
    },
  ) => Effect.Effect<BackupCreateReservation, BackupControlError>
  readonly restore: (
    context: OrganizationContext,
    input: { readonly idempotencyKey: string; readonly intent: BackupRestoreIntent },
  ) => Effect.Effect<BackupRestoreReservation, BackupControlError>
  readonly list: (
    context: OrganizationContext,
    options: { readonly limit: number; readonly cursor?: string; readonly serverId?: string },
  ) => Effect.Effect<
    { readonly items: ReadonlyArray<BackupArtifact>; readonly nextCursor?: string },
    BackupControlError
  >
  readonly get: (
    context: OrganizationContext,
    backupId: string,
  ) => Effect.Effect<BackupArtifact, BackupControlError>
  readonly markRunning: (
    organizationId: string,
    jobId: string,
    expectedRevision: number,
  ) => Effect.Effect<BackupJob, BackupControlError>
  readonly markSucceeded: (
    input: Omit<BackupCompleteInput, 'now' | 'completionFingerprint'> & {
      readonly completionFingerprint?: string
    },
  ) => Effect.Effect<BackupJob, BackupControlError>
  readonly markFailed: (
    input: Omit<BackupFailureInput, 'now'>,
  ) => Effect.Effect<BackupJob, BackupControlError>
  readonly cancel: (
    organizationId: string,
    jobId: string,
    expectedRevision: number,
  ) => Effect.Effect<BackupJob, BackupControlError>
  readonly delete: (
    context: OrganizationContext,
    backupId: string,
    expectedRevision: number,
  ) => Effect.Effect<BackupArtifact, BackupControlError>
  readonly expire: (
    now: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BackupArtifact>, BackupControlError>
}
export class BackupControl extends Context.Service<BackupControl, BackupControlShape>()(
  '@gridora/backup-control/BackupControl',
) {}

export const BackupControlLive = Layer.effect(
  BackupControl,
  Effect.gen(function* () {
    const repository = yield* BackupRepository
    const clock = yield* BackupClock
    const plugin = yield* BackupPluginCompatibility
    const facts = yield* BackupServerFacts
    const fingerprint = yield* BackupFingerprint
    const deletion = yield* BackupObjectDeletion
    const now = () => clock.now
    const removeClaim = (
      context: OrganizationContext,
      claim: BackupDeletionClaim,
    ): Effect.Effect<BackupArtifact, BackupControlError> =>
      Effect.gen(function* () {
        if (claim.state === 'deleted') return claim.artifact
        const exactPrefix = `organizations/${context.organizationId}/servers/${claim.serverId}/backups/${claim.backupId}`
        if (claim.r2Key !== exactPrefix)
          return yield* new BackupPersistenceError({ operation: 'backup.delete.prefix-fence' })
        const deletionNow = yield* now()
        const receipt = yield* deletion
          .remove({
            organizationId: context.organizationId,
            serverId: claim.serverId,
            backupId: claim.backupId,
            r2Key: claim.r2Key,
          })
          .pipe(
            Effect.catch((error) =>
              repository
                .recordDeleteFailure({
                  context,
                  claimId: claim.claimId,
                  failureCode: 'r2_delete_failed',
                  now: deletionNow,
                })
                .pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(Effect.fail(error)),
                ),
            ),
          )
        if (
          !Number.isSafeInteger(receipt.deletedObjects) ||
          receipt.deletedObjects < 0 ||
          (receipt.deletedObjects < 1 && !receipt.alreadyAbsent) ||
          receipt.deletedPrefix !== claim.r2Key
        )
          return yield* new BackupPersistenceError({ operation: 'backup.delete.r2-verify' })
        return yield* repository.completeDelete({
          context,
          claimId: claim.claimId,
          expectedArtifactRevision: claim.artifact.revision,
          deletedPrefix: receipt.deletedPrefix,
          deletedObjects: receipt.deletedObjects,
          alreadyAbsent: receipt.alreadyAbsent,
          now: yield* now(),
        })
      })
    return BackupControl.of({
      create: (context, input) =>
        Effect.gen(function* () {
          if (context.role === 'viewer')
            return yield* new BackupAuthorizationError({ code: 'operator_required' })
          const decoded = yield* Schema.decodeUnknownEffect(BackupCreateIntent, {
            onExcessProperty: 'error',
          })(input.intent).pipe(
            Effect.mapError(
              () =>
                new BackupValidationError({
                  code: 'invalid_backup_create',
                  message: 'Backup request is invalid',
                }),
            ),
          )
          const validation = validateCreate(context, decoded)
          if (validation !== undefined) return yield* validation
          const key = yield* Schema.decodeUnknownEffect(idempotencyKey)(input.idempotencyKey).pipe(
            Effect.mapError(
              () =>
                new BackupValidationError({
                  code: 'invalid_idempotency_key',
                  message: 'Idempotency-Key is invalid',
                }),
            ),
          )
          const resolved = yield* facts.resolveCreate({
            context,
            serverId: input.serverId,
            idempotencyKey: key,
            requestedIncludes: decoded.includes,
            expiresAt: decoded.expiresAt,
          })
          const createdAt = yield* now()
          const requestFingerprint = yield* fingerprint.digest(
            canonicalBackupRequest({
              kind: 'create',
              organizationId: context.organizationId,
              serverId: input.serverId,
              intent: decoded,
            }),
          )
          const r2Key = `organizations/${context.organizationId}/servers/${resolved.serverId}/backups/${resolved.backupId}`
          return yield* repository.reserveCreate({
            context,
            operationId: `backup-op-${crypto.randomUUID()}`,
            jobId: `backup-job-${crypto.randomUUID()}`,
            backupId: resolved.backupId,
            idempotencyKey: key,
            fingerprint: requestFingerprint,
            facts: resolved,
            intent: decoded,
            r2Key,
            now: createdAt,
          })
        }),
      restore: (context, input) =>
        Effect.gen(function* () {
          if (context.role === 'viewer')
            return yield* new BackupAuthorizationError({ code: 'operator_required' })
          const decoded = yield* Schema.decodeUnknownEffect(BackupRestoreIntent, {
            onExcessProperty: 'error',
          })(input.intent).pipe(
            Effect.mapError(
              () =>
                new BackupValidationError({
                  code: 'invalid_backup_restore',
                  message: 'Restore request is invalid',
                }),
            ),
          )
          const validation = validateRestore(decoded)
          if (validation !== undefined) return yield* validation
          const resolved = yield* facts.resolveRestore({ context, intent: decoded })
          yield* plugin.validateRestore({
            metadata: resolved.metadata,
            targetServerId: resolved.targetServerId,
            targetNodeId: resolved.targetNodeId,
          })
          const key = yield* Schema.decodeUnknownEffect(idempotencyKey)(input.idempotencyKey).pipe(
            Effect.mapError(
              () =>
                new BackupValidationError({
                  code: 'invalid_idempotency_key',
                  message: 'Idempotency-Key is invalid',
                }),
            ),
          )
          const createdAt = yield* now()
          const requestFingerprint = yield* fingerprint.digest(
            canonicalBackupRequest({
              kind: 'restore',
              organizationId: context.organizationId,
              intent: decoded,
              sourceServerId: resolved.sourceServerId,
              targetServerId: resolved.targetServerId,
              targetNodeId: resolved.targetNodeId,
            }),
          )
          return yield* repository.reserveRestore({
            context,
            operationId: `restore-op-${crypto.randomUUID()}`,
            jobId: `restore-job-${crypto.randomUUID()}`,
            idempotencyKey: key,
            fingerprint: requestFingerprint,
            intent: decoded,
            facts: resolved,
            now: createdAt,
          })
        }),
      list: (context, options) => repository.list(context, options),
      get: (context, backupId) => repository.get(context, backupId),
      markRunning: (organizationId, jobId, expectedRevision) =>
        Effect.flatMap(now(), (value) =>
          repository.markRunning(organizationId, jobId, expectedRevision, value),
        ),
      markSucceeded: (input) =>
        Effect.gen(function* () {
          const completionFingerprint =
            input.completionFingerprint ??
            (yield* fingerprint.digest(
              canonicalBackupRequest({
                checksum: input.checksum,
                encryptionVersion: input.encryptionVersion,
                r2Key: input.r2Key,
                manifest: input.manifest,
              }),
            ))
          return yield* repository.markSucceeded({
            ...input,
            completionFingerprint,
            now: yield* now(),
          })
        }),
      markFailed: (input) =>
        Effect.flatMap(now(), (value) => repository.markFailed({ ...input, now: value })),
      cancel: (organizationId, jobId, expectedRevision) =>
        Effect.flatMap(now(), (value) =>
          repository.requestCancel(organizationId, jobId, expectedRevision, value),
        ),
      delete: (context, backupId, expectedRevision) =>
        Effect.gen(function* () {
          if (context.role !== 'owner' && context.role !== 'administrator')
            return yield* new BackupAuthorizationError({ code: 'administrator_required' })
          const claim = yield* repository.claimDelete({
            context,
            backupId,
            expectedRevision,
            claimId: `backup-delete-${crypto.randomUUID()}`,
            now: yield* now(),
          })
          return yield* removeClaim(context, claim)
        }),
      expire: (instant, limit) =>
        Effect.gen(function* () {
          yield* repository.expire(instant, limit)
          const claims = yield* repository.claimRetentionDeletes(instant, limit)
          return yield* Effect.forEach(
            claims,
            ({ context, claim }) => removeClaim(context, claim),
            { concurrency: 1 },
          )
        }),
    })
  }),
)

export const makeBackupControlLayer = (options: {
  readonly repository: BackupRepositoryShape
  readonly clock?: BackupClockShape
  /** Production composition must provide authoritative D1/plugin facts. */
  readonly plugin: BackupPluginCompatibilityShape
  readonly facts: BackupServerFactsShape
  readonly fingerprint?: BackupFingerprintShape
  /** Production composition must provide exact-prefix private-R2 deletion. */
  readonly deletion: BackupObjectDeletionShape
}) =>
  BackupControlLive.pipe(
    Layer.provide(BackupRepositoryLayer(options.repository)),
    Layer.provide(
      BackupClockLayer(options.clock ?? { now: Effect.succeed(new Date().toISOString()) }),
    ),
    Layer.provide(BackupPluginCompatibilityLayer(options.plugin)),
    Layer.provide(BackupServerFactsLayer(options.facts)),
    Layer.provide(BackupFingerprintLayer(options.fingerprint ?? WebCryptoBackupFingerprint)),
    Layer.provide(BackupObjectDeletionLayer(options.deletion)),
  )

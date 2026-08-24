import { Context, Effect, Layer, Schema } from 'effect'
import type { OrganizationContext } from '@gridora/domain'
import {
  BackupArtifact,
  BackupConflictError,
  BackupConcurrencyError,
  BackupJobState,
  BackupNotFoundError,
  BackupPersistenceError,
  BackupRepository,
  BackupServerFacts,
  type BackupCreateFacts,
  type BackupRestoreFacts,
  type BackupServerFactsShape,
  canonicalBackupRequest,
  type BackupArtifact as BackupArtifactType,
  type BackupCompleteInput,
  type BackupCreateReservation,
  type BackupDeleteClaimInput,
  type BackupDeleteCompletionInput,
  type BackupDeleteFailureInput,
  type BackupDeletionClaim,
  type BackupFailureInput,
  type BackupJob,
  type BackupRepositoryCreateInput,
  type BackupRepositoryRestoreInput,
  type BackupRetentionDeletionClaim,
  type BackupRestoreReservation,
} from '@gridora/backup-control'
import {
  BackupWorkflowError,
  BackupWorkflowReceipt,
  type BackupWorkflowReceiptShape,
} from '@gridora/backup-workflow'
import {
  auditEnvelopeStageBindings,
  AuditRequestContextValue,
  stageAuditEnvelope,
  type AuditResult,
} from '@gridora/audit-contracts'

export interface BackupD1Result {
  readonly success: boolean
  readonly meta?: { readonly changes?: number }
}
export interface BackupD1AllResult {
  readonly results: ReadonlyArray<unknown>
}
export interface BackupD1Statement {
  bind(...values: ReadonlyArray<unknown>): BackupD1Statement
  first(): Promise<unknown>
  all(): Promise<BackupD1AllResult>
  run(): Promise<BackupD1Result>
}
export interface BackupD1Database {
  prepare(sql: string): BackupD1Statement
  batch(statements: ReadonlyArray<BackupD1Statement>): Promise<ReadonlyArray<BackupD1Result>>
}
export class BackupD1Client extends Context.Service<BackupD1Client, BackupD1Database>()(
  '@gridora/backup-d1/BackupD1Client',
) {}
export const BackupD1ClientLayer = (database: BackupD1Database) =>
  Layer.succeed(BackupD1Client, database)

const persistence = (operation: string) => new BackupPersistenceError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => persistence(operation) })

const terminalAuditOperationId = (parentOperationId: string, action: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${parentOperationId}\n${action}`),
      )
      return `audit-${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')}`
    },
    catch: () => persistence('backupD1.audit-operation.identity'),
  })

const terminalAuditOperation = (
  db: BackupD1Database,
  input: {
    readonly id: string
    readonly parentOperationId: string
    readonly organizationId: string
    readonly type: string
    readonly now: string
  },
) =>
  db
    .prepare(`INSERT OR IGNORE INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      SELECT ?, organization_id, ?, resource_type, resource_id, actor_id, 'succeeded', 100,
        ?, correlation_id, 1, ?, ?
      FROM operations WHERE organization_id = ? AND id = ?`)
    .bind(
      input.id,
      input.type,
      input.id,
      input.now,
      input.now,
      input.organizationId,
      input.parentOperationId,
    )

const stageTenantAudit = (
  db: BackupD1Database,
  input: {
    readonly eventId: string
    readonly organizationId: string
    readonly actorId: string
    readonly actorType?: 'human' | 'automation' | 'system'
    readonly request?: AuditRequestContextValue | undefined
    readonly correlationId: string
    readonly operationId: string
    readonly action: string
    readonly targetType: string
    readonly targetId: string
    readonly result: AuditResult
    readonly errorClassification?: 'none' | 'provider' | 'transport' | 'unknown'
    readonly errorCode?: string | null
    readonly before?: Readonly<Record<string, unknown>>
    readonly after?: Readonly<Record<string, unknown>>
    readonly occurredAt: string
  },
) => {
  const request = input.request ?? {
    origin: 'internal' as const,
    requestId: `internal-${input.operationId}`,
    correlationId: input.correlationId,
    source: {
      ip: {
        state: 'not-available' as const,
        reason: 'non-HTTP repository invocation has no network source',
      },
      access: {
        state: 'not-available' as const,
        reason: 'non-HTTP repository invocation has no Access assertion',
      },
    },
  }
  return stageAuditEnvelope(
    'tenant',
    input.eventId,
    {
      version: 1,
      captureStatus: 'complete',
      occurredAt: input.occurredAt,
      scope: 'tenant',
      organizationId: input.organizationId,
      actor: { type: input.actorType ?? 'human', id: input.actorId },
      request: { id: request.requestId, correlationId: input.correlationId },
      action: input.action,
      target: { type: input.targetType, id: input.targetId },
      before:
        input.before === undefined
          ? { state: 'absent', reason: 'resource-did-not-exist' }
          : { state: 'captured', summary: input.before },
      after:
        input.after === undefined
          ? { state: 'absent', reason: 'resource-did-not-exist' }
          : { state: 'captured', summary: input.after },
      operationId: input.operationId,
      source: { origin: request.origin, ...request.source },
      result: input.result,
      error: {
        classification:
          input.errorClassification ?? (input.result === 'succeeded' ? 'none' : 'unknown'),
        code: input.errorCode ?? null,
      },
      forced: false,
      breakGlass: false,
    },
    input.occurredAt,
  ).pipe(
    Effect.map((stage) =>
      db
        .prepare(`INSERT INTO audit_envelope_staging
    (event_table, event_id, organization_id, envelope_json, staged_at)
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM operations WHERE organization_id = ? AND id = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM audit_events WHERE organization_id = ? AND id = ?
    )`)
        .bind(
          ...auditEnvelopeStageBindings(stage),
          input.organizationId,
          input.operationId,
          input.organizationId,
          input.eventId,
        ),
    ),
    Effect.mapError(() => persistence('backupD1.audit-envelope.stage')),
  )
}

type AuditAwareContext = OrganizationContext & {
  readonly auditRequestContext?: AuditRequestContextValue
  readonly auditActorType?: 'human' | 'automation' | 'system'
}
const auditRequestFrom = (context: OrganizationContext): AuditRequestContextValue | undefined =>
  (context as AuditAwareContext).auditRequestContext
const auditActorTypeFrom = (context: OrganizationContext): 'human' | 'automation' | 'system' =>
  (context as AuditAwareContext).auditActorType ??
  (context.role === 'automation' ? 'automation' : 'human')
const durableAuditRequestFrom = (
  context: OrganizationContext,
  operationId: string,
): AuditRequestContextValue =>
  auditRequestFrom(context) ?? {
    origin: 'internal',
    requestId: `internal-${operationId}`,
    correlationId: context.correlationId,
    source: {
      ip: {
        state: 'not-available',
        reason: 'non-HTTP repository invocation has no network source',
      },
      access: {
        state: 'not-available',
        reason: 'non-HTTP repository invocation has no Access assertion',
      },
    },
  }
const rowObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
const string = (row: Record<string, unknown>, key: string): string | null =>
  typeof row[key] === 'string' ? row[key] : null
const number = (row: Record<string, unknown>, key: string): number | null =>
  typeof row[key] === 'number' ? row[key] : null
const decodeJson = (
  operation: string,
  value: unknown,
): Effect.Effect<unknown, BackupPersistenceError> =>
  typeof value !== 'string'
    ? Effect.fail(persistence(operation))
    : Effect.try({ try: () => JSON.parse(value) as unknown, catch: () => persistence(operation) })
const decodeArtifact = (
  operation: string,
  value: unknown,
): Effect.Effect<BackupArtifactType, BackupPersistenceError> =>
  Effect.gen(function* () {
    const row = rowObject(value)
    if (row === null) return yield* persistence(operation)
    const metadata = yield* decodeJson(`${operation}.metadata`, row.metadata)
    return yield* Schema.decodeUnknownEffect(BackupArtifact)({ ...row, metadata }).pipe(
      Effect.mapError(() => persistence(operation)),
    )
  })
const decodeJob = (
  operation: string,
  value: unknown,
): Effect.Effect<BackupJob, BackupPersistenceError> =>
  Effect.gen(function* () {
    const row = rowObject(value)
    if (row === null) return yield* persistence(operation)
    const mode = string(row, 'mode')
    const trigger = string(row, 'trigger')
    const state = string(row, 'state')
    const required = [
      'organizationId',
      'id',
      'operationId',
      'backupId',
      'sourceServerId',
      'idempotencyKey',
      'fingerprint',
      'createdAt',
      'updatedAt',
    ] as const
    if (
      !required.every((key) => string(row, key) !== null) ||
      (mode !== 'create' && mode !== 'restore') ||
      (trigger !== 'manual' && trigger !== 'scheduled') ||
      !(
        [
          'reserved',
          'running',
          'waiting_external',
          'cancelling',
          'cancelled',
          'succeeded',
          'failed',
          'failed_terminal',
        ] as const
      ).includes(state as BackupJobState) ||
      number(row, 'revision') === null ||
      !Number.isInteger(number(row, 'revision'))
    )
      return yield* persistence(operation)
    return {
      organizationId: string(row, 'organizationId')!,
      id: string(row, 'id')!,
      operationId: string(row, 'operationId')!,
      mode,
      trigger,
      backupId: string(row, 'backupId')!,
      sourceServerId: string(row, 'sourceServerId')!,
      targetServerId: string(row, 'targetServerId'),
      sourceNodeId: string(row, 'sourceNodeId'),
      targetNodeId: string(row, 'targetNodeId'),
      idempotencyKey: string(row, 'idempotencyKey')!,
      fingerprint: string(row, 'fingerprint')!,
      completionFingerprint: string(row, 'completionFingerprint'),
      state: state as BackupJobState,
      revision: number(row, 'revision')!,
      createdAt: string(row, 'createdAt')!,
      updatedAt: string(row, 'updatedAt')!,
      cancelledAt: string(row, 'cancelledAt'),
    }
  })

const artifactSelect = `SELECT organization_id AS organizationId, id, server_id AS serverId,
 r2_key AS r2Key, checksum, encryption_version AS encryptionVersion,
 metadata_json AS metadata, state, revision, created_at AS createdAt, expires_at AS expiresAt
 FROM backups`
const jobSelect = `SELECT organization_id AS organizationId, id, operation_id AS operationId,
 mode, trigger, backup_id AS backupId, source_server_id AS sourceServerId,
 target_server_id AS targetServerId, source_node_id AS sourceNodeId,
 target_node_id AS targetNodeId, idempotency_key AS idempotencyKey,
 fingerprint, completion_fingerprint AS completionFingerprint, state, revision,
 created_at AS createdAt, updated_at AS updatedAt,
 cancelled_at AS cancelledAt FROM backup_jobs`

const isSha256 = (value: string): boolean => /^sha256:[a-f0-9]{64}$/.test(value)
const isFingerprint = (value: string): boolean => /^[a-f0-9]{64}$/.test(value)
const completionMatches = (artifact: BackupArtifactType, input: BackupCompleteInput): boolean =>
  artifact.checksum === input.checksum &&
  artifact.encryptionVersion === input.encryptionVersion &&
  artifact.r2Key === input.r2Key &&
  canonicalBackupRequest(artifact.metadata) === canonicalBackupRequest(input.manifest)

const loadArtifact = (
  db: BackupD1Database,
  organizationId: string,
  backupId: string,
): Effect.Effect<BackupArtifactType, BackupNotFoundError | BackupPersistenceError> =>
  Effect.flatMap(
    attempt('backupD1.artifact.get', () =>
      db
        .prepare(`${artifactSelect} WHERE organization_id = ? AND id = ?`)
        .bind(organizationId, backupId)
        .first(),
    ),
    (row): Effect.Effect<BackupArtifactType, BackupNotFoundError | BackupPersistenceError> =>
      row === null
        ? Effect.fail(new BackupNotFoundError({ backupId }))
        : decodeArtifact('backupD1.artifact.get', row),
  )
const loadJob = (db: BackupD1Database, organizationId: string, jobId: string) =>
  Effect.flatMap(
    attempt('backupD1.job.get', () =>
      db
        .prepare(`${jobSelect} WHERE organization_id = ? AND id = ?`)
        .bind(organizationId, jobId)
        .first(),
    ),
    (row) =>
      row === null
        ? Effect.fail(persistence('backupD1.job.get'))
        : decodeJob('backupD1.job.get', row),
  )

/** Loads only the immutable Workflow authority selected by an exact operation id. */
export const loadBackupWorkflowState = (
  db: BackupD1Database,
  organizationId: string,
  operationId: string,
) =>
  Effect.gen(function* () {
    const row = yield* attempt('backupD1.workflow-state.job', () =>
      db
        .prepare(`${jobSelect} WHERE organization_id = ? AND operation_id = ?`)
        .bind(organizationId, operationId)
        .first(),
    )
    if (row === null) return yield* persistence('backupD1.workflow-state.job')
    const job = yield* decodeJob('backupD1.workflow-state.job', row)
    const artifact = yield* loadArtifact(db, organizationId, job.backupId)
    return { job, artifact }
  })

export interface BackupUploadSessionClaimInput {
  readonly organizationId: string
  readonly operationId: string
  readonly backupId: string
  readonly serverId: string
  readonly nodeId: string
  readonly archiveCreatedAt: string
  readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
  readonly declaredBytes: number
  readonly declaredSha256: string
  readonly maximumChunkBytes: number
  readonly now: string
  readonly leaseExpiresAt: string
  readonly uploadWatchUntil: string
}

export interface BackupUploadSessionAuthority {
  readonly sessionId: string
  readonly leaseId: string
  readonly generation: number
  readonly jobId: string
  readonly operationId: string
  readonly backupId: string
  readonly organizationId: string
  readonly serverId: string
  readonly nodeId: string
  readonly r2Key: string
  readonly leaseExpiresAt: string
  readonly uploadWatchUntil: string
}

export interface BackupUploadAcceptanceReceipt {
  readonly receiptId: string
  readonly sessionId: string
  readonly leaseId: string
  readonly generation: number
  readonly jobId: string
  readonly operationId: string
  readonly backupId: string
  readonly organizationId: string
  readonly r2Key: string
  readonly manifestKey: string
  readonly bytes: number
  readonly sha256: string
  readonly encryptionVersion: number
  readonly archiveCreatedAt: string
  readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
  readonly acceptedAt: string
}

export type BackupUploadSessionClaim =
  | { readonly disposition: 'execute'; readonly authority: BackupUploadSessionAuthority }
  | { readonly disposition: 'adopted'; readonly receipt: BackupUploadAcceptanceReceipt }

interface BackupUploadSessionRow extends BackupUploadSessionAuthority {
  readonly state: 'uploading' | 'accepted' | 'revoked' | 'reconciled'
  readonly declaredBytes: number
  readonly declaredSha256: string
  readonly archiveCreatedAt: string
  readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
  readonly maximumChunkBytes: number
}

export type BackupUploadObjectKind = 'chunk' | 'manifest'
export type BackupUploadObjectEffectState = 'prepared' | 'completed' | 'aborted'
export interface BackupUploadObjectEffect {
  readonly effectId: string
  readonly organizationId: string
  readonly sessionId: string
  readonly generation: number
  readonly leaseId: string
  readonly attempt: number
  readonly objectKey: string
  readonly objectKind: BackupUploadObjectKind
  readonly chunkIndex: number
  readonly objectBytes: number
  readonly objectSha256: string
  readonly multipartUploadId: string
  readonly state: BackupUploadObjectEffectState
  readonly terminalLeaseId: string | null
  readonly providerEtag: string | null
  readonly createdAt: string
  readonly terminalAt: string | null
  readonly revision: number
}

export interface BackupUploadObjectCoordinates {
  readonly objectKey: string
  readonly objectKind: BackupUploadObjectKind
  readonly chunkIndex: number
  readonly objectBytes: number
  readonly objectSha256: string
}

const uploadSessionSelect = `SELECT organization_id AS organizationId, id AS sessionId,
  job_id AS jobId, operation_id AS operationId, backup_id AS backupId,
  server_id AS serverId, node_id AS nodeId, generation, r2_key AS r2Key,
  declared_bytes AS declaredBytes, declared_sha256 AS declaredSha256,
  archive_created_at AS archiveCreatedAt, includes_json AS includesJson,
  maximum_chunk_bytes AS maximumChunkBytes,
  COALESCE((SELECT takeover.next_lease_id FROM backup_upload_lease_takeovers takeover
    WHERE takeover.organization_id = backup_upload_sessions.organization_id
      AND takeover.session_id = backup_upload_sessions.id
    ORDER BY takeover.sequence DESC LIMIT 1), lease_id) AS leaseId,
  COALESCE((SELECT takeover.lease_expires_at FROM backup_upload_lease_takeovers takeover
    WHERE takeover.organization_id = backup_upload_sessions.organization_id
      AND takeover.session_id = backup_upload_sessions.id
    ORDER BY takeover.sequence DESC LIMIT 1), lease_expires_at) AS leaseExpiresAt,
  COALESCE((SELECT takeover.upload_watch_until FROM backup_upload_lease_takeovers takeover
    WHERE takeover.organization_id = backup_upload_sessions.organization_id
      AND takeover.session_id = backup_upload_sessions.id
    ORDER BY takeover.sequence DESC LIMIT 1), upload_watch_until) AS uploadWatchUntil,
  state
  FROM backup_upload_sessions`

const uploadReceiptSelect = `SELECT organization_id AS organizationId, id AS receiptId,
  session_id AS sessionId, lease_id AS leaseId, job_id AS jobId, operation_id AS operationId,
  backup_id AS backupId, generation, r2_key AS r2Key, manifest_key AS manifestKey,
  plaintext_bytes AS bytes, plaintext_sha256 AS sha256,
  encryption_version AS encryptionVersion, archive_created_at AS archiveCreatedAt,
  includes_json AS includesJson, accepted_at AS acceptedAt
  FROM backup_upload_acceptance_receipts`

const uploadObjectEffectSelect = `SELECT organization_id AS organizationId, id AS effectId,
  session_id AS sessionId, generation, lease_id AS leaseId, attempt,
  object_key AS objectKey, object_kind AS objectKind, chunk_index AS chunkIndex,
  object_bytes AS objectBytes, object_sha256 AS objectSha256,
  multipart_upload_id AS multipartUploadId, state,
  terminal_lease_id AS terminalLeaseId, provider_etag AS providerEtag,
  created_at AS createdAt, terminal_at AS terminalAt, revision
  FROM backup_upload_object_effects`

const decodeUploadIncludes = (
  operation: string,
  value: unknown,
): Effect.Effect<ReadonlyArray<'config' | 'data' | 'mods' | 'state'>, BackupPersistenceError> =>
  Effect.flatMap(decodeJson(operation, value), (decoded) =>
    Schema.decodeUnknownEffect(
      Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state'])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4),
      ),
    )(decoded).pipe(Effect.mapError(() => persistence(operation))),
  )

const decodeUploadSession = (
  operation: string,
  row: unknown,
): Effect.Effect<BackupUploadSessionRow, BackupPersistenceError> =>
  Effect.gen(function* () {
    const value = rowObject(row)
    if (value === null) return yield* persistence(operation)
    const state = string(value, 'state')
    const generation = number(value, 'generation')
    const declaredBytes = number(value, 'declaredBytes')
    const maximumChunkBytes = number(value, 'maximumChunkBytes')
    const required = [
      'organizationId',
      'sessionId',
      'leaseId',
      'jobId',
      'operationId',
      'backupId',
      'serverId',
      'nodeId',
      'r2Key',
      'declaredSha256',
      'archiveCreatedAt',
      'leaseExpiresAt',
      'uploadWatchUntil',
    ] as const
    if (
      !required.every((key) => string(value, key) !== null) ||
      (state !== 'uploading' &&
        state !== 'accepted' &&
        state !== 'revoked' &&
        state !== 'reconciled') ||
      generation === null ||
      !Number.isSafeInteger(generation) ||
      declaredBytes === null ||
      !Number.isSafeInteger(declaredBytes) ||
      maximumChunkBytes === null ||
      !Number.isSafeInteger(maximumChunkBytes)
    )
      return yield* persistence(operation)
    return {
      organizationId: string(value, 'organizationId')!,
      sessionId: string(value, 'sessionId')!,
      leaseId: string(value, 'leaseId')!,
      generation,
      jobId: string(value, 'jobId')!,
      operationId: string(value, 'operationId')!,
      backupId: string(value, 'backupId')!,
      serverId: string(value, 'serverId')!,
      nodeId: string(value, 'nodeId')!,
      r2Key: string(value, 'r2Key')!,
      leaseExpiresAt: string(value, 'leaseExpiresAt')!,
      uploadWatchUntil: string(value, 'uploadWatchUntil')!,
      state,
      declaredBytes,
      declaredSha256: string(value, 'declaredSha256')!,
      archiveCreatedAt: string(value, 'archiveCreatedAt')!,
      includes: yield* decodeUploadIncludes(`${operation}.includes`, value.includesJson),
      maximumChunkBytes,
    }
  })

const decodeUploadReceipt = (
  operation: string,
  row: unknown,
): Effect.Effect<BackupUploadAcceptanceReceipt, BackupPersistenceError> =>
  Effect.gen(function* () {
    const value = rowObject(row)
    if (value === null) return yield* persistence(operation)
    const generation = number(value, 'generation')
    const bytes = number(value, 'bytes')
    const encryptionVersion = number(value, 'encryptionVersion')
    const required = [
      'organizationId',
      'receiptId',
      'sessionId',
      'leaseId',
      'jobId',
      'operationId',
      'backupId',
      'r2Key',
      'manifestKey',
      'sha256',
      'archiveCreatedAt',
      'acceptedAt',
    ] as const
    if (
      !required.every((key) => string(value, key) !== null) ||
      generation === null ||
      !Number.isSafeInteger(generation) ||
      bytes === null ||
      !Number.isSafeInteger(bytes) ||
      encryptionVersion === null ||
      !Number.isSafeInteger(encryptionVersion)
    )
      return yield* persistence(operation)
    return {
      organizationId: string(value, 'organizationId')!,
      receiptId: string(value, 'receiptId')!,
      sessionId: string(value, 'sessionId')!,
      leaseId: string(value, 'leaseId')!,
      generation,
      jobId: string(value, 'jobId')!,
      operationId: string(value, 'operationId')!,
      backupId: string(value, 'backupId')!,
      r2Key: string(value, 'r2Key')!,
      manifestKey: string(value, 'manifestKey')!,
      bytes,
      sha256: string(value, 'sha256')!,
      encryptionVersion,
      archiveCreatedAt: string(value, 'archiveCreatedAt')!,
      includes: yield* decodeUploadIncludes(`${operation}.includes`, value.includesJson),
      acceptedAt: string(value, 'acceptedAt')!,
    }
  })

const decodeUploadObjectEffect = (
  operation: string,
  row: unknown,
): Effect.Effect<BackupUploadObjectEffect, BackupPersistenceError> =>
  Effect.gen(function* () {
    const value = rowObject(row)
    if (value === null) return yield* persistence(operation)
    const generation = number(value, 'generation')
    const attemptNumber = number(value, 'attempt')
    const chunkIndex = number(value, 'chunkIndex')
    const objectBytes = number(value, 'objectBytes')
    const revision = number(value, 'revision')
    const objectKind = string(value, 'objectKind')
    const state = string(value, 'state')
    const required = [
      'organizationId',
      'effectId',
      'sessionId',
      'leaseId',
      'objectKey',
      'objectSha256',
      'multipartUploadId',
      'createdAt',
    ] as const
    if (
      !required.every((key) => string(value, key) !== null) ||
      generation === null ||
      attemptNumber === null ||
      chunkIndex === null ||
      objectBytes === null ||
      revision === null ||
      ![generation, attemptNumber, chunkIndex, objectBytes, revision].every(Number.isSafeInteger) ||
      (objectKind !== 'chunk' && objectKind !== 'manifest') ||
      (state !== 'prepared' && state !== 'completed' && state !== 'aborted')
    )
      return yield* persistence(operation)
    return {
      organizationId: string(value, 'organizationId')!,
      effectId: string(value, 'effectId')!,
      sessionId: string(value, 'sessionId')!,
      generation,
      leaseId: string(value, 'leaseId')!,
      attempt: attemptNumber,
      objectKey: string(value, 'objectKey')!,
      objectKind,
      chunkIndex,
      objectBytes,
      objectSha256: string(value, 'objectSha256')!,
      multipartUploadId: string(value, 'multipartUploadId')!,
      state,
      terminalLeaseId: string(value, 'terminalLeaseId'),
      providerEtag: string(value, 'providerEtag'),
      createdAt: string(value, 'createdAt')!,
      terminalAt: string(value, 'terminalAt'),
      revision,
    }
  })

const uploadIdentity = (prefix: string, ...parts: ReadonlyArray<string | number>) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(parts.join('\n')),
      )
      return `${prefix}-${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')}`
    },
    catch: () => persistence('backupD1.upload-session.identity'),
  })

const loadUploadSession = (
  db: BackupD1Database,
  organizationId: string,
  jobId: string,
): Effect.Effect<BackupUploadSessionRow | null, BackupPersistenceError> =>
  attempt('backupD1.upload-session.load', () =>
    db
      .prepare(`${uploadSessionSelect} WHERE organization_id = ? AND job_id = ?
        ORDER BY generation DESC LIMIT 1`)
      .bind(organizationId, jobId)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeed(null)
        : decodeUploadSession('backupD1.upload-session.load', row),
    ),
  )

/** Returns the durable upload tombstone used by a physical-cleanup reconciler.
 * It never treats lease or watch expiry as provider quiescence. */
export const loadBackupUploadRecoverySession = (
  db: BackupD1Database,
  organizationId: string,
  backupId: string,
): Effect.Effect<
  | (BackupUploadSessionAuthority & {
      readonly state: 'uploading' | 'revoked' | 'reconciled' | 'accepted'
    })
  | null,
  BackupPersistenceError
> =>
  attempt('backupD1.upload-session.recovery-load', () =>
    db
      .prepare(`${uploadSessionSelect} WHERE organization_id = ? AND backup_id = ?
        ORDER BY generation DESC LIMIT 1`)
      .bind(organizationId, backupId)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeed(null)
        : decodeUploadSession('backupD1.upload-session.recovery-load', row).pipe(
            Effect.map(({ state, ...authority }) => ({ ...authority, state })),
          ),
    ),
  )

const effectMatches = (
  effect: BackupUploadObjectEffect,
  authority: BackupUploadSessionAuthority,
  coordinates: BackupUploadObjectCoordinates,
) =>
  effect.organizationId === authority.organizationId &&
  effect.sessionId === authority.sessionId &&
  effect.generation === authority.generation &&
  effect.objectKey === coordinates.objectKey &&
  effect.objectKind === coordinates.objectKind &&
  effect.chunkIndex === coordinates.chunkIndex &&
  effect.objectBytes === coordinates.objectBytes &&
  effect.objectSha256 === coordinates.objectSha256

export const loadBackupUploadObjectEffect = (
  db: BackupD1Database,
  authority: BackupUploadSessionAuthority,
  objectKey: string,
): Effect.Effect<BackupUploadObjectEffect | null, BackupPersistenceError> =>
  attempt('backupD1.upload-object.load', () =>
    db
      .prepare(`${uploadObjectEffectSelect}
        WHERE organization_id = ? AND session_id = ? AND object_key = ?
        ORDER BY attempt DESC LIMIT 1`)
      .bind(authority.organizationId, authority.sessionId, objectKey)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeed(null)
        : decodeUploadObjectEffect('backupD1.upload-object.load', row),
    ),
  )

/** Persists the provider multipart handle before the first byte is uploaded.
 * A concurrent registration is adopted only when every immutable coordinate
 * matches; the caller must abort any newly-created, unselected empty handle. */
export const registerBackupUploadObjectEffect = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority &
    BackupUploadObjectCoordinates & {
      readonly multipartUploadId: string
      readonly now: string
    },
): Effect.Effect<BackupUploadObjectEffect, BackupConflictError | BackupPersistenceError> =>
  Effect.gen(function* () {
    yield* validateBackupUploadSession(db, input)
    const prior = yield* loadBackupUploadObjectEffect(db, input, input.objectKey)
    if (prior !== null && prior.state !== 'aborted') {
      if (!effectMatches(prior, input, input))
        return yield* new BackupConflictError({
          code: 'backup_upload_object_mismatch',
          message: 'the durable multipart effect has different object coordinates',
        })
      return prior
    }
    const attemptNumber = (prior?.attempt ?? 0) + 1
    const effectId = yield* uploadIdentity(
      'backup-upload-object',
      input.sessionId,
      input.objectKey,
      attemptNumber,
    )
    const inserted = yield* Effect.catch(
      attempt('backupD1.upload-object.register', () =>
        db
          .prepare(`INSERT INTO backup_upload_object_effects
            (organization_id, id, session_id, generation, lease_id, attempt,
             object_key, object_kind, chunk_index, object_bytes, object_sha256,
             multipart_upload_id, state, terminal_lease_id, provider_etag,
             created_at, terminal_at, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, NULL, 1)`)
          .bind(
            input.organizationId,
            effectId,
            input.sessionId,
            input.generation,
            input.leaseId,
            attemptNumber,
            input.objectKey,
            input.objectKind,
            input.chunkIndex,
            input.objectBytes,
            input.objectSha256,
            input.multipartUploadId,
            input.now,
          )
          .run(),
      ),
      () => Effect.succeed<BackupD1Result | null>(null),
    )
    const selected = yield* loadBackupUploadObjectEffect(db, input, input.objectKey)
    if (
      selected !== null &&
      effectMatches(selected, input, input) &&
      ((inserted !== null && inserted.success && inserted.meta?.changes === 1) ||
        selected.state !== 'aborted')
    )
      return selected
    return yield* new BackupConflictError({
      code: 'backup_upload_object_conflict',
      message: 'the multipart effect could not be registered exactly',
    })
  })

const terminalizeBackupUploadObjectEffect = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority & {
    readonly effect: BackupUploadObjectEffect
    readonly outcome: 'completed' | 'aborted'
    readonly providerEtag?: string
    readonly now: string
  },
): Effect.Effect<BackupUploadObjectEffect, BackupConflictError | BackupPersistenceError> =>
  Effect.gen(function* () {
    if (
      input.effect.organizationId !== input.organizationId ||
      input.effect.sessionId !== input.sessionId ||
      input.effect.generation !== input.generation ||
      (input.outcome === 'completed') !== (input.providerEtag !== undefined)
    )
      return yield* new BackupConflictError({
        code: 'backup_upload_object_terminal_mismatch',
        message: 'provider terminal evidence does not match the upload generation',
      })
    if (input.effect.state !== 'prepared') {
      if (
        input.effect.state === input.outcome &&
        input.effect.terminalLeaseId === input.leaseId &&
        input.effect.providerEtag === (input.providerEtag ?? null)
      )
        return input.effect
      return yield* new BackupConflictError({
        code: 'backup_upload_object_terminal_conflict',
        message: 'the multipart effect already has different terminal evidence',
      })
    }
    const result = yield* Effect.catch(
      attempt('backupD1.upload-object.terminalize', () =>
        db
          .prepare(`UPDATE backup_upload_object_effects
            SET state = ?, terminal_lease_id = ?, provider_etag = ?, terminal_at = ?,
                revision = revision + 1
            WHERE organization_id = ? AND id = ? AND session_id = ?
              AND generation = ? AND state = 'prepared' AND revision = ?`)
          .bind(
            input.outcome,
            input.leaseId,
            input.providerEtag ?? null,
            input.now,
            input.organizationId,
            input.effect.effectId,
            input.sessionId,
            input.generation,
            input.effect.revision,
          )
          .run(),
      ),
      () => Effect.succeed<BackupD1Result | null>(null),
    )
    const observed = yield* loadBackupUploadObjectEffect(db, input, input.effect.objectKey)
    if (
      observed !== null &&
      observed.effectId === input.effect.effectId &&
      observed.state === input.outcome &&
      observed.terminalLeaseId === input.leaseId &&
      observed.providerEtag === (input.providerEtag ?? null) &&
      ((result !== null && result.success && result.meta?.changes === 1) ||
        observed.revision === input.effect.revision + 1)
    )
      return observed
    return yield* new BackupConflictError({
      code: 'backup_upload_object_terminal_conflict',
      message: 'the multipart terminal receipt could not be adopted exactly',
    })
  })

export const completeBackupUploadObjectEffect = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority & {
    readonly effect: BackupUploadObjectEffect
    readonly providerEtag: string
    readonly now: string
  },
) => terminalizeBackupUploadObjectEffect(db, { ...input, outcome: 'completed' })

export const abortBackupUploadObjectEffect = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority & {
    readonly effect: BackupUploadObjectEffect
    readonly now: string
  },
) => terminalizeBackupUploadObjectEffect(db, { ...input, outcome: 'aborted' })

export const listPreparedBackupUploadObjectEffects = (
  db: BackupD1Database,
  authority: BackupUploadSessionAuthority,
): Effect.Effect<ReadonlyArray<BackupUploadObjectEffect>, BackupPersistenceError> =>
  attempt('backupD1.upload-object.list-prepared', () =>
    db
      .prepare(`${uploadObjectEffectSelect}
        WHERE organization_id = ? AND session_id = ? AND state = 'prepared'
        ORDER BY object_key, attempt`)
      .bind(authority.organizationId, authority.sessionId)
      .all(),
  ).pipe(
    Effect.flatMap((result) =>
      Effect.forEach(result.results, (row) =>
        decodeUploadObjectEffect('backupD1.upload-object.list-prepared', row),
      ),
    ),
  )

const loadUploadReceipt = (
  db: BackupD1Database,
  organizationId: string,
  jobId: string,
): Effect.Effect<BackupUploadAcceptanceReceipt | null, BackupPersistenceError> =>
  attempt('backupD1.upload-receipt.load', () =>
    db
      .prepare(`${uploadReceiptSelect} WHERE organization_id = ? AND job_id = ?`)
      .bind(organizationId, jobId)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeed(null)
        : decodeUploadReceipt('backupD1.upload-receipt.load', row),
    ),
  )

const sameIncludes = (
  left: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>,
  right: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>,
) => JSON.stringify(left) === JSON.stringify(right)

const sessionMatchesClaim = (
  session: BackupUploadSessionRow,
  input: BackupUploadSessionClaimInput,
) =>
  session.organizationId === input.organizationId &&
  session.operationId === input.operationId &&
  session.backupId === input.backupId &&
  session.serverId === input.serverId &&
  session.nodeId === input.nodeId &&
  session.declaredBytes === input.declaredBytes &&
  session.declaredSha256 === input.declaredSha256 &&
  session.archiveCreatedAt === input.archiveCreatedAt &&
  session.maximumChunkBytes === input.maximumChunkBytes &&
  sameIncludes(session.includes, input.includes)

/** Atomically claims one immutable upload generation. A retry may take over an
 * expired lease, but the retained provider effects—not elapsed time—prove
 * whether every old multipart publication completed or was aborted. */
export const claimBackupUploadSession = (
  db: BackupD1Database,
  input: BackupUploadSessionClaimInput,
): Effect.Effect<
  BackupUploadSessionClaim,
  BackupConflictError | BackupPersistenceError | BackupNotFoundError
> =>
  Effect.gen(function* () {
    const { job, artifact } = yield* loadBackupWorkflowState(
      db,
      input.organizationId,
      input.operationId,
    )
    const exactPrefix = `organizations/${input.organizationId}/servers/${input.serverId}/backups/${input.backupId}`
    if (
      job.mode !== 'create' ||
      job.backupId !== input.backupId ||
      job.sourceServerId !== input.serverId ||
      job.sourceNodeId !== input.nodeId ||
      !['reserved', 'running', 'waiting_external'].includes(job.state) ||
      artifact.state !== 'creating' ||
      artifact.r2Key !== exactPrefix ||
      artifact.metadata.nodeId !== input.nodeId ||
      !sameIncludes(artifact.metadata.includes, input.includes) ||
      !Number.isSafeInteger(input.declaredBytes) ||
      input.declaredBytes < 1 ||
      !isSha256(input.declaredSha256) ||
      !Number.isSafeInteger(input.maximumChunkBytes) ||
      input.maximumChunkBytes < 64 * 1024 ||
      input.maximumChunkBytes > 4 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(input.now)) ||
      !Number.isFinite(Date.parse(input.leaseExpiresAt)) ||
      !Number.isFinite(Date.parse(input.uploadWatchUntil))
    )
      return yield* new BackupConflictError({
        code: 'backup_upload_authority_mismatch',
        message: 'upload request does not match the accepted backup generation scope',
      })

    const accepted = yield* loadUploadReceipt(db, input.organizationId, job.id)
    if (accepted !== null) {
      if (
        accepted.operationId !== input.operationId ||
        accepted.backupId !== input.backupId ||
        accepted.r2Key !== exactPrefix ||
        accepted.bytes !== input.declaredBytes ||
        accepted.sha256 !== input.declaredSha256 ||
        accepted.archiveCreatedAt !== input.archiveCreatedAt ||
        !sameIncludes(accepted.includes, input.includes)
      )
        return yield* new BackupConflictError({
          code: 'backup_upload_receipt_mismatch',
          message: 'accepted upload receipt does not match this request',
        })
      return { disposition: 'adopted', receipt: accepted }
    }

    let previous = yield* loadUploadSession(db, input.organizationId, job.id)
    if (previous !== null) {
      if (!sessionMatchesClaim(previous, input))
        return yield* new BackupConflictError({
          code: 'backup_upload_generation_mismatch',
          message: 'upload generation was already claimed with different archive facts',
        })
      if (previous.state === 'uploading' && previous.leaseExpiresAt > input.now)
        return yield* new BackupConflictError({
          code: 'backup_upload_generation_busy',
          message: 'the exact upload generation already has a live writer lease',
        })
      if (previous.state === 'accepted')
        return yield* persistence('backupD1.upload-session.accepted-without-receipt')
      if (previous.state === 'uploading') {
        const sequenceRow = rowObject(
          yield* attempt('backupD1.upload-session.takeover-sequence', () =>
            db
              .prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence
                FROM backup_upload_lease_takeovers
                WHERE organization_id = ? AND session_id = ?`)
              .bind(input.organizationId, previous!.sessionId)
              .first(),
          ),
        )
        const priorSequence = sequenceRow === null ? null : number(sequenceRow, 'sequence')
        if (priorSequence === null || !Number.isSafeInteger(priorSequence))
          return yield* persistence('backupD1.upload-session.takeover-sequence')
        const nextLeaseId = yield* uploadIdentity(
          'backup-upload-lease',
          previous.sessionId,
          input.now,
        )
        const takeoverId = yield* uploadIdentity(
          'backup-upload-takeover',
          previous.sessionId,
          previous.leaseId,
          nextLeaseId,
        )
        const takeover = yield* Effect.catch(
          attempt('backupD1.upload-session.takeover', () =>
            db
              .prepare(`INSERT INTO backup_upload_lease_takeovers
                (organization_id, id, session_id, sequence, prior_lease_id, next_lease_id,
                 claimed_at, lease_expires_at, upload_watch_until, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'worker-loss-retry')`)
              .bind(
                input.organizationId,
                takeoverId,
                previous!.sessionId,
                priorSequence + 1,
                previous!.leaseId,
                nextLeaseId,
                input.now,
                input.leaseExpiresAt,
                input.uploadWatchUntil,
              )
              .run(),
          ),
          () => Effect.succeed<BackupD1Result | null>(null),
        )
        const adopted = yield* loadUploadSession(db, input.organizationId, job.id)
        if (
          adopted !== null &&
          adopted.state === 'uploading' &&
          sessionMatchesClaim(adopted, input) &&
          adopted.leaseExpiresAt > input.now &&
          ((takeover !== null && takeover.success && takeover.meta?.changes === 1) ||
            adopted.leaseId === nextLeaseId)
        )
          return { disposition: 'execute', authority: adopted }
        return yield* new BackupConflictError({
          code: 'backup_upload_generation_busy',
          message: 'upload generation takeover changed concurrently',
        })
      }
      if (previous.state === 'revoked')
        return yield* new BackupConflictError({
          code: 'backup_upload_generation_quarantined',
          message: 'upload generation is blocked until its exact writer closes',
        })
    }

    const generation = (previous?.generation ?? 0) + 1
    if (generation > 1024)
      return yield* new BackupConflictError({
        code: 'backup_upload_generation_exhausted',
        message: 'backup upload generation limit is exhausted',
      })
    const sessionId = yield* uploadIdentity(
      'backup-upload-session',
      input.organizationId,
      job.id,
      generation,
    )
    const leaseId = yield* uploadIdentity('backup-upload-lease', sessionId, input.now)
    const inserted = yield* Effect.catch(
      attempt('backupD1.upload-session.insert', () =>
        db
          .prepare(`INSERT INTO backup_upload_sessions
            (organization_id, id, job_id, operation_id, backup_id, server_id, node_id,
             generation, r2_key, declared_bytes, declared_sha256, archive_created_at,
             includes_json, maximum_chunk_bytes, lease_id, lease_claimed_at,
             lease_expires_at, upload_watch_until, state, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 1, ?, ?)`)
          .bind(
            input.organizationId,
            sessionId,
            job.id,
            input.operationId,
            input.backupId,
            input.serverId,
            input.nodeId,
            generation,
            exactPrefix,
            input.declaredBytes,
            input.declaredSha256,
            input.archiveCreatedAt,
            JSON.stringify(input.includes),
            input.maximumChunkBytes,
            leaseId,
            input.now,
            input.leaseExpiresAt,
            input.uploadWatchUntil,
            input.now,
            input.now,
          )
          .run(),
      ),
      () => Effect.succeed<BackupD1Result | null>(null),
    )
    if (inserted === null || !inserted.success || inserted.meta?.changes !== 1) {
      const replay = yield* loadUploadSession(db, input.organizationId, job.id)
      if (
        replay !== null &&
        replay.state === 'uploading' &&
        replay.leaseExpiresAt > input.now &&
        sessionMatchesClaim(replay, input)
      )
        return { disposition: 'execute', authority: replay }
      return yield* new BackupConflictError({
        code: 'backup_upload_generation_conflict',
        message: 'upload generation could not be claimed exactly',
      })
    }
    return {
      disposition: 'execute',
      authority: {
        organizationId: input.organizationId,
        sessionId,
        leaseId,
        generation,
        jobId: job.id,
        operationId: input.operationId,
        backupId: input.backupId,
        serverId: input.serverId,
        nodeId: input.nodeId,
        r2Key: exactPrefix,
        leaseExpiresAt: input.leaseExpiresAt,
        uploadWatchUntil: input.uploadWatchUntil,
      },
    }
  })

export const validateBackupUploadSession = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority & { readonly now: string },
): Effect.Effect<void, BackupConflictError | BackupPersistenceError> =>
  attempt('backupD1.upload-session.validate', () =>
    db
      .prepare(`SELECT 1 AS valid
        FROM backup_upload_sessions session
        JOIN backup_jobs job
          ON job.organization_id = session.organization_id AND job.id = session.job_id
        JOIN operations operation
          ON operation.organization_id = session.organization_id
         AND operation.id = session.operation_id
        JOIN backups backup
          ON backup.organization_id = session.organization_id AND backup.id = session.backup_id
        WHERE session.organization_id = ? AND session.id = ?
          AND COALESCE((SELECT takeover.next_lease_id
            FROM backup_upload_lease_takeovers takeover
            WHERE takeover.organization_id = session.organization_id
              AND takeover.session_id = session.id
            ORDER BY takeover.sequence DESC LIMIT 1), session.lease_id) = ?
          AND session.generation = ? AND session.job_id = ? AND session.operation_id = ?
          AND session.backup_id = ? AND session.server_id = ? AND session.node_id = ?
          AND session.r2_key = ? AND session.state = 'uploading'
          AND COALESCE((SELECT takeover.lease_expires_at
            FROM backup_upload_lease_takeovers takeover
            WHERE takeover.organization_id = session.organization_id
              AND takeover.session_id = session.id
            ORDER BY takeover.sequence DESC LIMIT 1), session.lease_expires_at) > ?
          AND COALESCE((SELECT takeover.upload_watch_until
            FROM backup_upload_lease_takeovers takeover
            WHERE takeover.organization_id = session.organization_id
              AND takeover.session_id = session.id
            ORDER BY takeover.sequence DESC LIMIT 1), session.upload_watch_until) > ?
          AND job.mode = 'create' AND job.state IN ('reserved', 'running', 'waiting_external')
          AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
          AND backup.state = 'creating' AND backup.r2_key = session.r2_key
          AND NOT EXISTS (
            SELECT 1 FROM operation_cancellation_requests cancellation
            WHERE cancellation.organization_id = session.organization_id
              AND cancellation.operation_id = session.operation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM backup_deletion_claims claim
            WHERE claim.organization_id = session.organization_id
              AND claim.backup_id = session.backup_id
          )`)
      .bind(
        input.organizationId,
        input.sessionId,
        input.leaseId,
        input.generation,
        input.jobId,
        input.operationId,
        input.backupId,
        input.serverId,
        input.nodeId,
        input.r2Key,
        input.now,
        input.now,
      )
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.fail(
            new BackupConflictError({
              code: 'backup_upload_lease_lost',
              message: 'backup upload generation no longer has publication authority',
            }),
          )
        : Effect.void,
    ),
  )

export type BackupUploadClosureReason = 'request-failed' | 'authority-lost' | 'request-aborted'

/** Records explicit writer closure only after the request Effect has left the
 * R2 upload scope. Lease expiry alone never calls this function. A lost D1
 * response adopts the immutable closure receipt and exact reconciled state. */
export const closeBackupUploadSession = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority & {
    readonly reason: BackupUploadClosureReason
    readonly now: string
  },
): Effect.Effect<void, BackupConflictError | BackupPersistenceError> =>
  Effect.gen(function* () {
    const latest = yield* loadUploadSession(db, input.organizationId, input.jobId)
    if (
      latest === null ||
      latest.sessionId !== input.sessionId ||
      latest.leaseId !== input.leaseId ||
      latest.generation !== input.generation
    )
      return yield* new BackupConflictError({
        code: 'backup_upload_closure_mismatch',
        message: 'upload writer closure does not match the durable generation',
      })
    if (latest.state === 'accepted' || latest.state === 'reconciled') return
    const closureId = yield* uploadIdentity('backup-upload-closure', input.sessionId)
    const results = yield* Effect.catch(
      attempt('backupD1.upload-session.close', () =>
        db.batch([
          db
            .prepare(`INSERT OR IGNORE INTO backup_upload_closure_receipts
              (organization_id, id, session_id, lease_id, close_reason, closed_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(
              input.organizationId,
              closureId,
              input.sessionId,
              input.leaseId,
              input.reason,
              input.now,
            ),
          db
            .prepare(`UPDATE backup_upload_sessions
              SET state = 'reconciled', revision = revision + 1, updated_at = ?
              WHERE changes() = 1 AND organization_id = ? AND id = ?
                AND generation = ? AND state IN ('uploading', 'revoked')`)
            .bind(input.now, input.organizationId, input.sessionId, input.generation),
        ]),
      ),
      () => Effect.succeed<ReadonlyArray<BackupD1Result> | null>(null),
    )
    if (
      results !== null &&
      results.length === 2 &&
      results.every((result) => result.success && result.meta?.changes === 1)
    )
      return
    const adopted = yield* attempt('backupD1.upload-session.close.adopt', () =>
      db
        .prepare(`SELECT session.state, closure.id AS closureId, closure.lease_id AS leaseId
          FROM backup_upload_sessions session
          JOIN backup_upload_closure_receipts closure
            ON closure.organization_id = session.organization_id
           AND closure.session_id = session.id
          WHERE session.organization_id = ? AND session.id = ?
            AND closure.lease_id = ? AND session.generation = ?`)
        .bind(input.organizationId, input.sessionId, input.leaseId, input.generation)
        .first(),
    )
    const row = rowObject(adopted)
    if (
      row !== null &&
      string(row, 'state') === 'reconciled' &&
      string(row, 'closureId') === closureId &&
      string(row, 'leaseId') === input.leaseId
    )
      return
    return yield* new BackupConflictError({
      code: 'backup_upload_closure_conflict',
      message: 'upload writer closure was not recorded exactly',
    })
  })

export const acceptBackupUploadSession = (
  db: BackupD1Database,
  input: BackupUploadSessionAuthority & {
    readonly bytes: number
    readonly sha256: string
    readonly encryptionVersion: number
    readonly archiveCreatedAt: string
    readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
    readonly now: string
  },
): Effect.Effect<BackupUploadAcceptanceReceipt, BackupConflictError | BackupPersistenceError> =>
  Effect.gen(function* () {
    const receiptId = yield* uploadIdentity('backup-upload-receipt', input.sessionId)
    const existing = yield* loadUploadReceipt(db, input.organizationId, input.jobId)
    const exact = (receipt: BackupUploadAcceptanceReceipt) =>
      receipt.receiptId === receiptId &&
      receipt.sessionId === input.sessionId &&
      receipt.leaseId === input.leaseId &&
      receipt.generation === input.generation &&
      receipt.operationId === input.operationId &&
      receipt.backupId === input.backupId &&
      receipt.r2Key === input.r2Key &&
      receipt.bytes === input.bytes &&
      receipt.sha256 === input.sha256 &&
      receipt.encryptionVersion === input.encryptionVersion &&
      receipt.archiveCreatedAt === input.archiveCreatedAt &&
      sameIncludes(receipt.includes, input.includes)
    if (existing !== null)
      return exact(existing)
        ? existing
        : yield* new BackupConflictError({
            code: 'backup_upload_receipt_mismatch',
            message: 'durable upload receipt differs from completion evidence',
          })
    yield* validateBackupUploadSession(db, input)
    const results = yield* Effect.catch(
      attempt('backupD1.upload-session.accept', () =>
        db.batch([
          db
            .prepare(`INSERT INTO backup_upload_acceptance_receipts
              (organization_id, id, session_id, lease_id, job_id, operation_id, backup_id,
               generation, r2_key, manifest_key, plaintext_bytes, plaintext_sha256,
               encryption_version, archive_created_at, includes_json, accepted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              input.organizationId,
              receiptId,
              input.sessionId,
              input.leaseId,
              input.jobId,
              input.operationId,
              input.backupId,
              input.generation,
              input.r2Key,
              `${input.r2Key}/manifest.json`,
              input.bytes,
              input.sha256,
              input.encryptionVersion,
              input.archiveCreatedAt,
              JSON.stringify(input.includes),
              input.now,
            ),
          db
            .prepare(`UPDATE backup_upload_sessions
              SET state = 'accepted', revision = revision + 1, updated_at = ?
              WHERE changes() = 1 AND organization_id = ? AND id = ?
                AND COALESCE((SELECT takeover.next_lease_id
                  FROM backup_upload_lease_takeovers takeover
                  WHERE takeover.organization_id = backup_upload_sessions.organization_id
                    AND takeover.session_id = backup_upload_sessions.id
                  ORDER BY takeover.sequence DESC LIMIT 1), lease_id) = ?
                AND generation = ? AND state = 'uploading'
                AND COALESCE((SELECT takeover.lease_expires_at
                  FROM backup_upload_lease_takeovers takeover
                  WHERE takeover.organization_id = backup_upload_sessions.organization_id
                    AND takeover.session_id = backup_upload_sessions.id
                  ORDER BY takeover.sequence DESC LIMIT 1), lease_expires_at) > ?`)
            .bind(
              input.now,
              input.organizationId,
              input.sessionId,
              input.leaseId,
              input.generation,
              input.now,
            ),
        ]),
      ),
      () => Effect.succeed<ReadonlyArray<BackupD1Result> | null>(null),
    )
    if (
      results !== null &&
      results.length === 2 &&
      results.every((result) => result.success && result.meta?.changes === 1)
    ) {
      const accepted = yield* loadUploadReceipt(db, input.organizationId, input.jobId)
      if (accepted !== null && exact(accepted)) return accepted
    }
    const replay = yield* loadUploadReceipt(db, input.organizationId, input.jobId)
    if (replay !== null && exact(replay)) return replay
    return yield* new BackupConflictError({
      code: 'backup_upload_acceptance_conflict',
      message: 'upload completion lost its exact generation authority',
    })
  })
const existingByIdempotency = (
  db: BackupD1Database,
  organizationId: string,
  key: string,
  mode: 'create' | 'restore',
) =>
  attempt('backupD1.idempotency.get', () =>
    db
      .prepare(`${jobSelect} WHERE organization_id = ? AND idempotency_key = ? AND mode = ?`)
      .bind(organizationId, key, mode)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null ? Effect.succeed(null) : decodeJob('backupD1.idempotency.get', row),
    ),
  )

const createReservation = (
  db: BackupD1Database,
  input: BackupRepositoryCreateInput,
): Effect.Effect<
  BackupCreateReservation,
  BackupNotFoundError | BackupConflictError | BackupPersistenceError
> =>
  Effect.gen(function* () {
    const existingCreate = yield* existingByIdempotency(
      db,
      input.context.organizationId,
      input.idempotencyKey,
      'create',
    )
    if (existingCreate !== null) {
      if (existingCreate.fingerprint !== input.fingerprint)
        return yield* new BackupConflictError({
          code: 'idempotency_conflict',
          message: 'backup idempotency key was reused with different input',
        })
      return {
        disposition: 'adopted',
        job: existingCreate,
        artifact: yield* loadArtifact(db, input.context.organizationId, existingCreate.backupId),
      } satisfies BackupCreateReservation
    }
    const metadata = {
      pluginId: input.facts.pluginId,
      pluginVersion: input.facts.pluginVersion,
      gameBuild: input.facts.gameBuild,
      configRevision: input.facts.configRevision,
      modSetRevision: input.facts.modSetRevision,
      desiredRevision: input.facts.desiredRevision,
      nodeId: input.facts.nodeId,
      consistency: input.facts.consistency,
      includes: [...input.intent.includes],
      containsGameBinaries: false,
    }
    const operationInsert = db
      .prepare(`INSERT OR IGNORE INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'backup-game-server', 'game-server', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`)
      .bind(
        input.operationId,
        input.context.organizationId,
        input.facts.serverId,
        input.context.identityId,
        input.idempotencyKey,
        input.context.correlationId,
        input.now,
        input.now,
      )
    const auditOperationId = yield* terminalAuditOperationId(
      input.operationId,
      'backup.create.accepted',
    )
    const auditOperation = terminalAuditOperation(db, {
      id: auditOperationId,
      parentOperationId: input.operationId,
      organizationId: input.context.organizationId,
      type: 'backup.create.accepted',
      now: input.now,
    })
    const workflowStart = db
      .prepare(`INSERT OR IGNORE INTO lifecycle_workflow_starts
      (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
      SELECT organization_id, id, ?, 'pending', 0, NULL, ?, ? FROM operations
      WHERE organization_id = ? AND id = ?`)
      .bind(
        `workflow-start:${input.operationId}`,
        input.now,
        input.now,
        input.context.organizationId,
        input.operationId,
      )
    const audit = db
      .prepare(`INSERT OR IGNORE INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      SELECT ?, organization_id, actor_id, 'backup.create.accepted', 'game-server', ?, 'succeeded',
       correlation_id, ?, ? FROM operations
      WHERE organization_id = ? AND id = ? AND status = 'succeeded'`)
      .bind(
        `audit-backup-${input.operationId}`,
        input.facts.serverId,
        JSON.stringify({
          operationId: input.operationId,
          jobId: input.jobId,
          trigger: input.facts.trigger,
        }),
        input.now,
        input.context.organizationId,
        auditOperationId,
      )
    const auditStage = yield* stageTenantAudit(db, {
      eventId: `audit-backup-${input.operationId}`,
      organizationId: input.context.organizationId,
      actorId: input.context.identityId,
      actorType: auditActorTypeFrom(input.context),
      request: auditRequestFrom(input.context),
      correlationId: input.context.correlationId,
      operationId: auditOperationId,
      action: 'backup.create.accepted',
      targetType: 'game-server',
      targetId: input.facts.serverId,
      result: 'succeeded',
      after: { operationId: input.operationId, jobId: input.jobId, trigger: input.facts.trigger },
      occurredAt: input.now,
    })
    const outbox = db
      .prepare(`INSERT OR IGNORE INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      SELECT ?, organization_id, 'backup.workflow-start.requested', 'backup-job', ?, ?,
       'pending', 0, ?, ? FROM operations
      WHERE changes() = 1 AND organization_id = ? AND id = ?`)
      .bind(
        `outbox-backup-${input.operationId}`,
        input.jobId,
        JSON.stringify({
          operationId: input.operationId,
          workflowStartRecordId: `workflow-start:${input.operationId}`,
          organizationId: input.context.organizationId,
          backupId: input.backupId,
        }),
        input.now,
        input.now,
        input.context.organizationId,
        input.operationId,
      )
    const backupInsert = db
      .prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json, state, revision, created_at, expires_at)
      SELECT ?, ?, ?, ?, 'sha256:' || printf('%064d', 0), 1, ?, 'creating', 1, ?, ?
      WHERE EXISTS (SELECT 1 FROM operations WHERE organization_id = ? AND id = ?)
      `)
      .bind(
        input.context.organizationId,
        input.backupId,
        input.facts.serverId,
        input.r2Key,
        JSON.stringify(metadata),
        input.now,
        input.intent.expiresAt,
        input.context.organizationId,
        input.operationId,
      )
    const jobInsert = db
      .prepare(`INSERT INTO backup_jobs
      (organization_id, id, operation_id, mode, trigger, backup_id, source_server_id,
       source_node_id, idempotency_key, fingerprint, request_json, audit_request_context_json,
       audit_actor_type, state, revision, created_at, updated_at)
      SELECT ?, ?, ?, 'create', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, ?, ?
      WHERE EXISTS (SELECT 1 FROM operations WHERE organization_id = ? AND id = ?)
      `)
      .bind(
        input.context.organizationId,
        input.jobId,
        input.operationId,
        input.facts.trigger,
        input.backupId,
        input.facts.serverId,
        input.facts.nodeId,
        input.idempotencyKey,
        input.fingerprint,
        JSON.stringify(input.intent),
        JSON.stringify(durableAuditRequestFrom(input.context, input.operationId)),
        auditActorTypeFrom(input.context),
        input.now,
        input.now,
        input.context.organizationId,
        input.operationId,
      )
    const results = yield* Effect.catch(
      attempt('backupD1.reserveCreate.batch', () =>
        db.batch([
          operationInsert,
          auditOperation,
          auditStage,
          backupInsert,
          jobInsert,
          workflowStart,
          audit,
          outbox,
        ]),
      ),
      () => Effect.succeed<ReadonlyArray<BackupD1Result> | null>(null),
    )
    if (results === null) {
      const replay = yield* existingByIdempotency(
        db,
        input.context.organizationId,
        input.idempotencyKey,
        'create',
      )
      if (replay !== null) {
        if (replay.fingerprint !== input.fingerprint)
          return yield* new BackupConflictError({
            code: 'idempotency_conflict',
            message: 'backup idempotency key was reused with different input',
          })
        return {
          disposition: 'adopted',
          job: replay,
          artifact: yield* loadArtifact(db, input.context.organizationId, replay.backupId),
        } satisfies BackupCreateReservation
      }
      return yield* new BackupConflictError({
        code: 'backup_reservation_conflict',
        message: 'backup reservation was already changed',
      })
    }
    if (
      results.length !== 8 ||
      results.some((result) => !result.success || result.meta?.changes !== 1)
    )
      return yield* persistence('backupD1.reserveCreate.batch')
    const inserted = results[4]?.meta?.changes === 1
    if (inserted) {
      const artifact = yield* loadArtifact(db, input.context.organizationId, input.backupId)
      const job = yield* loadJob(db, input.context.organizationId, input.jobId)
      return { disposition: 'created', job, artifact } satisfies BackupCreateReservation
    }
    const replay = yield* existingByIdempotency(
      db,
      input.context.organizationId,
      input.idempotencyKey,
      'create',
    )
    if (replay !== null) {
      if (replay.fingerprint !== input.fingerprint)
        return yield* new BackupConflictError({
          code: 'idempotency_conflict',
          message: 'backup idempotency key was reused with different input',
        })
      return {
        disposition: 'adopted',
        job: replay,
        artifact: yield* loadArtifact(db, input.context.organizationId, replay.backupId),
      } satisfies BackupCreateReservation
    }
    const artifact = yield* loadArtifact(db, input.context.organizationId, input.backupId)
    const job = yield* loadJob(db, input.context.organizationId, input.jobId)
    if (job.fingerprint !== input.fingerprint)
      return yield* new BackupConflictError({
        code: 'idempotency_conflict',
        message: 'backup reservation fingerprint mismatch',
      })
    return { disposition: 'created', job, artifact } satisfies BackupCreateReservation
  })

const restoreReservation = (
  db: BackupD1Database,
  input: BackupRepositoryRestoreInput,
): Effect.Effect<
  BackupRestoreReservation,
  BackupNotFoundError | BackupConflictError | BackupConcurrencyError | BackupPersistenceError
> =>
  Effect.gen(function* () {
    const artifact = yield* loadArtifact(db, input.context.organizationId, input.intent.backupId)
    if (artifact.serverId !== input.facts.sourceServerId)
      return yield* new BackupConflictError({
        code: 'backup_scope_mismatch',
        message: 'backup does not belong to source server',
      })
    if (artifact.state !== 'available')
      return yield* new BackupConflictError({
        code: 'backup_not_available',
        message: 'backup is not available for restore',
      })
    const existingRestore = yield* existingByIdempotency(
      db,
      input.context.organizationId,
      input.idempotencyKey,
      'restore',
    )
    if (existingRestore !== null) {
      if (existingRestore.fingerprint !== input.fingerprint)
        return yield* new BackupConflictError({
          code: 'idempotency_conflict',
          message: 'restore idempotency key was reused with different input',
        })
      return {
        disposition: 'adopted',
        job: existingRestore,
        artifact,
      } satisfies BackupRestoreReservation
    }
    const operationInsert = db
      .prepare(`INSERT OR IGNORE INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'restore-game-server', 'game-server', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`)
      .bind(
        input.operationId,
        input.context.organizationId,
        input.facts.targetServerId,
        input.context.identityId,
        input.idempotencyKey,
        input.context.correlationId,
        input.now,
        input.now,
      )
    const auditOperationId = yield* terminalAuditOperationId(
      input.operationId,
      'backup.restore.accepted',
    )
    const auditOperation = terminalAuditOperation(db, {
      id: auditOperationId,
      parentOperationId: input.operationId,
      organizationId: input.context.organizationId,
      type: 'backup.restore.accepted',
      now: input.now,
    })
    const workflowStart = db
      .prepare(`INSERT OR IGNORE INTO lifecycle_workflow_starts
      (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
      SELECT organization_id, id, ?, 'pending', 0, NULL, ?, ? FROM operations
      WHERE organization_id = ? AND id = ?`)
      .bind(
        `workflow-start:${input.operationId}`,
        input.now,
        input.now,
        input.context.organizationId,
        input.operationId,
      )
    const audit = db
      .prepare(`INSERT OR IGNORE INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      SELECT ?, organization_id, actor_id, 'backup.restore.accepted', 'game-server', ?, 'succeeded',
       correlation_id, ?, ? FROM operations
      WHERE organization_id = ? AND id = ? AND status = 'succeeded'`)
      .bind(
        `audit-restore-${input.operationId}`,
        input.facts.targetServerId,
        JSON.stringify({
          operationId: input.operationId,
          jobId: input.jobId,
          targetServerId: input.facts.targetServerId,
          targetNodeId: input.facts.targetNodeId,
        }),
        input.now,
        input.context.organizationId,
        auditOperationId,
      )
    const auditStage = yield* stageTenantAudit(db, {
      eventId: `audit-restore-${input.operationId}`,
      organizationId: input.context.organizationId,
      actorId: input.context.identityId,
      actorType: auditActorTypeFrom(input.context),
      request: auditRequestFrom(input.context),
      correlationId: input.context.correlationId,
      operationId: auditOperationId,
      action: 'backup.restore.accepted',
      targetType: 'game-server',
      targetId: input.facts.targetServerId,
      result: 'succeeded',
      before: {
        backupId: input.intent.backupId,
        state: 'available',
        sourceServerId: input.facts.sourceServerId,
      },
      after: {
        operationId: input.operationId,
        jobId: input.jobId,
        targetServerId: input.facts.targetServerId,
        targetNodeId: input.facts.targetNodeId,
      },
      occurredAt: input.now,
    })
    const outbox = db
      .prepare(`INSERT OR IGNORE INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      SELECT ?, organization_id, 'backup.workflow-start.requested', 'backup-job', ?, ?,
       'pending', 0, ?, ? FROM operations
      WHERE changes() = 1 AND organization_id = ? AND id = ?`)
      .bind(
        `outbox-restore-${input.operationId}`,
        input.jobId,
        JSON.stringify({
          operationId: input.operationId,
          workflowStartRecordId: `workflow-start:${input.operationId}`,
          organizationId: input.context.organizationId,
          backupId: input.intent.backupId,
        }),
        input.now,
        input.now,
        input.context.organizationId,
        input.operationId,
      )
    const jobInsert = db
      .prepare(`INSERT OR IGNORE INTO backup_jobs
      (organization_id, id, operation_id, mode, trigger, backup_id, source_server_id,
       target_server_id, source_node_id, target_node_id, idempotency_key, fingerprint, request_json,
       audit_request_context_json, audit_actor_type, state, revision, created_at, updated_at)
      SELECT ?, ?, ?, 'restore', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, ?, ?
      WHERE changes() = 1 AND EXISTS (SELECT 1 FROM operations WHERE organization_id = ? AND id = ?)
      `)
      .bind(
        input.context.organizationId,
        input.jobId,
        input.operationId,
        input.intent.backupId,
        input.facts.sourceServerId,
        input.facts.targetServerId,
        input.facts.sourceNodeId,
        input.facts.targetNodeId,
        input.idempotencyKey,
        input.fingerprint,
        JSON.stringify(input.intent),
        JSON.stringify(durableAuditRequestFrom(input.context, input.operationId)),
        auditActorTypeFrom(input.context),
        input.now,
        input.now,
        input.context.organizationId,
        input.operationId,
      )
    const cutoverInsert = db
      .prepare(`INSERT INTO backup_restore_cutovers
        (organization_id, id, job_id, backup_id, source_server_id, target_server_id,
         source_endpoint_json, staged_endpoint_json, state, source_preserved,
         revision, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, 1, ?, ?
        WHERE changes() = 1`)
      .bind(
        input.context.organizationId,
        `cutover:${input.jobId}`,
        input.jobId,
        input.intent.backupId,
        input.facts.sourceServerId,
        input.facts.targetServerId,
        JSON.stringify({ serverId: input.facts.sourceServerId, nodeId: input.facts.sourceNodeId }),
        JSON.stringify({ serverId: input.facts.targetServerId, nodeId: input.facts.targetNodeId }),
        input.now,
        input.now,
      )
    // Insert the restore job immediately after its operation. The active
    // restore unique fence must abort the whole transaction before audit,
    // outbox, or Workflow-start evidence can be written for a losing request.
    const results = yield* Effect.catch(
      attempt('backupD1.reserveRestore.batch', () =>
        db.batch([
          operationInsert,
          auditOperation,
          auditStage,
          jobInsert,
          cutoverInsert,
          workflowStart,
          audit,
          outbox,
        ]),
      ),
      () => Effect.succeed<ReadonlyArray<BackupD1Result> | null>(null),
    )
    if (results === null) {
      const active = yield* attempt('backupD1.restore.active.get', () =>
        db
          .prepare(
            `${jobSelect} WHERE organization_id = ? AND backup_id = ? AND mode = 'restore' AND state IN ('reserved', 'running', 'waiting_external', 'cancelling') LIMIT 1`,
          )
          .bind(input.context.organizationId, input.intent.backupId)
          .first(),
      )
      if (active !== null)
        return yield* new BackupConcurrencyError({
          code: 'restore_in_progress',
          message: 'another restore is already active for this backup',
        })
      return yield* persistence('backupD1.reserveRestore.batch')
    }
    if (results.length !== 8 || results.some((value) => !value.success))
      return yield* persistence('backupD1.reserveRestore.batch')
    const inserted = results[3]?.meta?.changes === 1
    if (inserted)
      return {
        disposition: 'created',
        job: yield* loadJob(db, input.context.organizationId, input.jobId),
        artifact,
      } satisfies BackupRestoreReservation
    const replayAfterFence = yield* existingByIdempotency(
      db,
      input.context.organizationId,
      input.idempotencyKey,
      'restore',
    )
    if (replayAfterFence !== null) {
      if (replayAfterFence.fingerprint !== input.fingerprint)
        return yield* new BackupConflictError({
          code: 'idempotency_conflict',
          message: 'restore idempotency key was reused with different input',
        })
      return {
        disposition: 'adopted',
        job: replayAfterFence,
        artifact,
      } satisfies BackupRestoreReservation
    }
    const createReplay = yield* existingByIdempotency(
      db,
      input.context.organizationId,
      input.idempotencyKey,
      'create',
    )
    if (createReplay !== null)
      return yield* new BackupConflictError({
        code: 'idempotency_conflict',
        message: 'idempotency key was already used for a backup create',
      })
    return yield* new BackupPersistenceError({ operation: 'backupD1.reserveRestore.job' })
  })

const updateJob = (
  db: BackupD1Database,
  operation: string,
  organizationId: string,
  jobId: string,
  expectedRevision: number,
  state: BackupJobState,
  now: string,
  cancelled: boolean,
) =>
  Effect.gen(function* () {
    const job = yield* loadJob(db, organizationId, jobId)
    // D1 batches are atomic, so a lost response after this exact transition
    // leaves one authoritative successor revision. Adopt only that immediate
    // successor; an older/stale caller cannot adopt a later state.
    if (
      job.state === state &&
      job.revision === expectedRevision + 1 &&
      (!cancelled || job.cancelledAt !== null)
    )
      return job
    const operationState =
      state === 'running' ? 'running' : state === 'cancelled' ? 'cancelled' : 'cancelling'
    const operationProgress = state === 'running' ? 5 : state === 'cancelled' ? 100 : 90
    const results = yield* attempt(operation, () =>
      db.batch([
        db
          .prepare(`UPDATE backup_jobs SET state = ?, revision = revision + 1,
        updated_at = ?, cancelled_at = CASE WHEN ? = 1 THEN COALESCE(cancelled_at, ?) ELSE cancelled_at END
        WHERE organization_id = ? AND id = ? AND revision = ?
        AND state IN ('reserved', 'running', 'waiting_external', 'cancelling')`)
          .bind(state, now, cancelled ? 1 : 0, now, organizationId, jobId, expectedRevision),
        db
          .prepare(`UPDATE operations SET status = ?, progress = ?, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external', 'cancelling')`)
          .bind(operationState, operationProgress, now, organizationId, job.operationId),
      ]),
    )
    if (results.length !== 2 || results.some((value) => !value.success))
      return yield* persistence(operation)
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1)
      return yield* new BackupConcurrencyError({
        code: 'revision_conflict',
        message: 'backup job revision or state changed',
      })
    return yield* loadJob(db, organizationId, jobId)
  })

const completeCreate = (db: BackupD1Database, input: BackupCompleteInput) =>
  Effect.gen(function* () {
    if (
      !isSha256(input.checksum) ||
      !isFingerprint(input.completionFingerprint) ||
      !Number.isInteger(input.encryptionVersion) ||
      input.encryptionVersion < 1
    )
      return yield* new BackupConflictError({
        code: 'invalid_completion_evidence',
        message: 'backup completion evidence is invalid',
      })
    const job = yield* loadJob(db, input.organizationId, input.jobId)
    const artifact = yield* loadArtifact(db, input.organizationId, job.backupId)
    if (job.state === 'succeeded') {
      if (
        job.completionFingerprint === input.completionFingerprint &&
        completionMatches(artifact, input)
      ) {
        const terminal = yield* attempt('backupD1.completeCreate.terminal-receipt', () =>
          db
            .prepare(`SELECT receipt.completion_fingerprint AS completionFingerprint
              FROM backup_workflow_terminal_receipts receipt
              JOIN operations operation
                ON operation.organization_id = receipt.organization_id
               AND operation.id = receipt.operation_id
              JOIN operations terminal
                ON terminal.organization_id = receipt.organization_id
               AND terminal.id = receipt.audit_operation_id
              JOIN audit_events audit
                ON audit.organization_id = receipt.organization_id
               AND audit.id = receipt.audit_event_id
              JOIN outbox event
                ON event.organization_id = receipt.organization_id
               AND event.id = receipt.outbox_event_id
              WHERE receipt.organization_id = ? AND receipt.job_id = ?
                AND receipt.operation_id = ? AND operation.status = 'succeeded'
                AND terminal.status = 'succeeded' AND audit.result = 'succeeded'`)
            .bind(input.organizationId, input.jobId, job.operationId)
            .first(),
        )
        if (
          rowObject(terminal) !== null &&
          string(rowObject(terminal)!, 'completionFingerprint') === input.completionFingerprint
        )
          return job
        return yield* new BackupConflictError({
          code: 'completion_conflict',
          message: 'terminal backup completion audit evidence is incomplete',
        })
      }
      return yield* new BackupConflictError({
        code: 'completion_conflict',
        message: 'terminal backup completion evidence does not match',
      })
    }
    if (
      job.mode === 'create' &&
      (artifact.r2Key !== input.r2Key ||
        canonicalBackupRequest(artifact.metadata) !== canonicalBackupRequest(input.manifest))
    )
      return yield* new BackupConflictError({
        code: 'completion_scope_mismatch',
        message: 'backup completion does not match its reservation',
      })
    if (
      job.mode === 'restore' &&
      (artifact.state !== 'available' || !completionMatches(artifact, input))
    )
      return yield* new BackupConflictError({
        code: 'restore_evidence_mismatch',
        message: 'restore completion evidence does not match the source artifact',
      })
    const metadata = JSON.stringify(input.manifest)
    const auditAuthority = yield* attempt('backupD1.completeCreate.audit-authority', () =>
      db
        .prepare(`SELECT operation.actor_id AS actorId,
          operation.correlation_id AS correlationId,
          job.audit_request_context_json AS auditRequestContext,
          job.audit_actor_type AS auditActorType
        FROM backup_jobs job JOIN operations operation
          ON operation.organization_id = job.organization_id AND operation.id = job.operation_id
        WHERE job.organization_id = ? AND job.id = ? AND job.operation_id = ?`)
        .bind(input.organizationId, input.jobId, job.operationId)
        .first(),
    )
    const auditRow = rowObject(auditAuthority)
    const auditActorId = auditRow === null ? null : string(auditRow, 'actorId')
    const auditCorrelationId = auditRow === null ? null : string(auditRow, 'correlationId')
    const auditRequestJson = auditRow === null ? null : string(auditRow, 'auditRequestContext')
    const auditActorType = auditRow === null ? null : string(auditRow, 'auditActorType')
    if (
      auditActorId === null ||
      auditCorrelationId === null ||
      auditRequestJson === null ||
      (auditActorType !== 'human' && auditActorType !== 'automation' && auditActorType !== 'system')
    )
      return yield* persistence('backupD1.completeCreate.audit-authority')
    const auditRequest = yield* decodeJson(
      'backupD1.completeCreate.audit-request',
      auditRequestJson,
    ).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(AuditRequestContextValue, { onExcessProperty: 'error' })(
          value,
        ).pipe(Effect.mapError(() => persistence('backupD1.completeCreate.audit-request'))),
      ),
    )
    const completionAction =
      job.mode === 'create' ? 'backup.create.completed' : 'backup.restore.completed'
    const completionTargetId = job.targetServerId ?? job.sourceServerId
    const auditEventId = `audit-complete-${job.operationId}`
    const outboxEventId = `outbox-complete-${job.operationId}`
    const auditOperationId = yield* terminalAuditOperationId(job.operationId, completionAction)
    const auditOperation = db
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        SELECT ?, organization_id, ?, resource_type, resource_id, actor_id, 'succeeded', 100,
          ?, correlation_id, 1, ?, ?
        FROM operations WHERE organization_id = ? AND id = ? AND status = 'succeeded'`)
      .bind(
        auditOperationId,
        completionAction,
        auditOperationId,
        input.now,
        input.now,
        input.organizationId,
        job.operationId,
      )
    const completionSummary = {
      operationId: job.operationId,
      auditOperationId,
      jobId: job.id,
      backupId: job.backupId,
      state: 'succeeded',
      completionFingerprint: input.completionFingerprint,
    }
    const auditStage = yield* stageTenantAudit(db, {
      eventId: auditEventId,
      organizationId: input.organizationId,
      actorId: auditActorId,
      actorType: auditActorType,
      request: auditRequest,
      correlationId: auditCorrelationId,
      operationId: auditOperationId,
      action: completionAction,
      targetType: 'game-server',
      targetId: completionTargetId,
      result: 'succeeded',
      before: { jobId: job.id, state: job.state, revision: job.revision },
      after: completionSummary,
      occurredAt: input.now,
    })
    // Each statement checks the durable result that the next statement needs.
    // A stale artifact, job, or operation makes the complete batch a no-op.
    // This rule prevents a partial success when D1 reports zero changed rows.
    const artifactUpdate =
      job.mode === 'create'
        ? db
            .prepare(`UPDATE backups SET checksum = ?, encryption_version = ?, r2_key = ?, metadata_json = ?, state = 'available', revision = revision + 1
          WHERE organization_id = ? AND id = ? AND state = 'creating' AND r2_key = ?
            AND EXISTS (
              SELECT 1 FROM backup_jobs job
              WHERE job.organization_id = ? AND job.id = ? AND job.revision = ?
                AND job.state IN ('reserved', 'running', 'waiting_external')
            )
            AND EXISTS (
              SELECT 1 FROM operations operation
              WHERE operation.organization_id = ? AND operation.id = ?
                AND operation.status IN ('queued', 'running', 'waiting_external')
                AND NOT EXISTS (SELECT 1 FROM operation_cancellation_requests request
                  WHERE request.organization_id = operation.organization_id
                    AND request.operation_id = operation.id)
            )`)
            .bind(
              input.checksum,
              input.encryptionVersion,
              input.r2Key,
              metadata,
              input.organizationId,
              job.backupId,
              input.r2Key,
              input.organizationId,
              input.jobId,
              input.expectedRevision,
              input.organizationId,
              job.operationId,
            )
        : db
            .prepare(`UPDATE backups SET revision = revision
          WHERE organization_id = ? AND id = ? AND state = 'available'
            AND EXISTS (
              SELECT 1 FROM backup_jobs job
              WHERE job.organization_id = ? AND job.id = ? AND job.revision = ?
                AND job.state IN ('reserved', 'running', 'waiting_external')
            )
            AND EXISTS (
              SELECT 1 FROM operations operation
              WHERE operation.organization_id = ? AND operation.id = ?
                AND operation.status IN ('queued', 'running', 'waiting_external')
                AND NOT EXISTS (SELECT 1 FROM operation_cancellation_requests request
                  WHERE request.organization_id = operation.organization_id
                    AND request.operation_id = operation.id)
            )`)
            .bind(
              input.organizationId,
              job.backupId,
              input.organizationId,
              input.jobId,
              input.expectedRevision,
              input.organizationId,
              job.operationId,
            )
    const results = yield* attempt('backupD1.completeCreate.batch', () =>
      db.batch([
        artifactUpdate,
        db
          .prepare(`UPDATE backup_jobs SET state = 'succeeded', completion_fingerprint = ?, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND revision = ? AND state IN ('reserved', 'running', 'waiting_external')
          AND EXISTS (
            SELECT 1 FROM backups artifact
            WHERE artifact.organization_id = ? AND artifact.id = ? AND artifact.state = 'available'
              AND artifact.revision = ? AND artifact.checksum = ?
              AND artifact.encryption_version = ? AND artifact.r2_key = ?
          )
          AND EXISTS (
            SELECT 1 FROM operations operation
            WHERE operation.organization_id = ? AND operation.id = ?
              AND operation.status IN ('queued', 'running', 'waiting_external')
              AND NOT EXISTS (SELECT 1 FROM operation_cancellation_requests request
                WHERE request.organization_id = operation.organization_id
                  AND request.operation_id = operation.id)
          )`)
          .bind(
            input.completionFingerprint,
            input.now,
            input.organizationId,
            input.jobId,
            input.expectedRevision,
            input.organizationId,
            job.backupId,
            job.mode === 'create' ? artifact.revision + 1 : artifact.revision,
            input.checksum,
            input.encryptionVersion,
            input.r2Key,
            input.organizationId,
            job.operationId,
          ),
        db
          .prepare(`UPDATE operations SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')
          AND NOT EXISTS (SELECT 1 FROM operation_cancellation_requests request
            WHERE request.organization_id = operations.organization_id
              AND request.operation_id = operations.id)
          AND EXISTS (
            SELECT 1 FROM backup_jobs job
            WHERE job.organization_id = ? AND job.id = ? AND job.state = 'succeeded'
              AND job.completion_fingerprint = ?
          )`)
          .bind(
            input.now,
            input.organizationId,
            job.operationId,
            input.organizationId,
            input.jobId,
            input.completionFingerprint,
          ),
        auditOperation,
        auditStage,
        db
          .prepare(`INSERT OR IGNORE INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, organization_id, actor_id, ?, 'game-server', ?, 'succeeded',
              correlation_id, ?, ?
            FROM operations WHERE organization_id = ? AND id = ? AND status = 'succeeded'`)
          .bind(
            auditEventId,
            completionAction,
            completionTargetId,
            JSON.stringify(completionSummary),
            input.now,
            input.organizationId,
            auditOperationId,
          ),
        db
          .prepare(`INSERT OR IGNORE INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, created_at)
            SELECT ?, ?, ?, 'backup-job', ?, ?, 'pending', 0, ?, ?
            WHERE EXISTS (SELECT 1 FROM operations
              WHERE organization_id = ? AND id = ? AND status = 'succeeded')`)
          .bind(
            outboxEventId,
            input.organizationId,
            completionAction,
            job.id,
            JSON.stringify({
              operationId: job.operationId,
              jobId: job.id,
              backupId: job.backupId,
              completionFingerprint: input.completionFingerprint,
            }),
            input.now,
            input.now,
            input.organizationId,
            job.operationId,
          ),
        db
          .prepare(`INSERT OR IGNORE INTO backup_workflow_terminal_receipts
            (organization_id, job_id, operation_id, completion_fingerprint,
             audit_operation_id, audit_event_id, outbox_event_id, completed_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM backup_jobs
              WHERE organization_id = ? AND id = ? AND state = 'succeeded')`)
          .bind(
            input.organizationId,
            job.id,
            job.operationId,
            input.completionFingerprint,
            auditOperationId,
            auditEventId,
            outboxEventId,
            input.now,
            input.organizationId,
            job.id,
          ),
      ]),
    )
    if (
      results.length !== 8 ||
      results.some((value) => !value.success || value.meta?.changes !== 1)
    )
      return yield* new BackupConcurrencyError({
        code: 'completion_conflict',
        message: 'backup completion was already applied or fenced',
      })
    return yield* loadJob(db, input.organizationId, input.jobId)
  })

const deletionClaimSelect = `SELECT organization_id AS organizationId, id AS claimId,
 operation_id AS operationId, backup_id AS backupId, artifact_revision AS artifactRevision, r2_key AS r2Key,
 source_job_id AS sourceJobId, source_job_operation_id AS sourceJobOperationId,
 state, revision, created_at AS createdAt, updated_at AS updatedAt,
 audit_actor_type AS auditActorType, audit_request_context_json AS auditRequestContext,
 (SELECT operation.actor_id FROM operations operation
   WHERE operation.organization_id = backup_deletion_claims.organization_id
     AND operation.id = backup_deletion_claims.operation_id) AS actorId,
 (SELECT operation.correlation_id FROM operations operation
   WHERE operation.organization_id = backup_deletion_claims.organization_id
     AND operation.id = backup_deletion_claims.operation_id) AS correlationId
 FROM backup_deletion_claims`

const loadDeletionClaim = (db: BackupD1Database, organizationId: string, claimId: string) =>
  attempt('backupD1.delete.claim.get', () =>
    db
      .prepare(`${deletionClaimSelect} WHERE organization_id = ? AND id = ?`)
      .bind(organizationId, claimId)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.fail(persistence('backupD1.delete.claim.get'))
        : loadDeletionClaimFromRow(row),
    ),
  )

const loadDeletionClaimForBackup = (
  db: BackupD1Database,
  organizationId: string,
  backupId: string,
) =>
  attempt('backupD1.delete.claim.by-backup', () =>
    db
      .prepare(
        `${deletionClaimSelect} WHERE organization_id = ? AND backup_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .bind(organizationId, backupId)
      .first(),
  ).pipe(
    Effect.flatMap((row) => (row === null ? Effect.succeed(null) : loadDeletionClaimFromRow(row))),
  )

const loadDeletionClaimFromRow = (
  row: unknown,
): Effect.Effect<
  {
    readonly claimId: string
    readonly operationId: string
    readonly backupId: string
    readonly artifactRevision: number
    readonly r2Key: string
    readonly sourceJobId: string | null
    readonly sourceJobOperationId: string | null
    readonly state: 'deleting' | 'deleted'
    readonly actorId: string
    readonly actorType: 'human' | 'automation' | 'system'
    readonly correlationId: string
    readonly request: AuditRequestContextValue
  },
  BackupPersistenceError
> => {
  const value = rowObject(row)
  if (
    value === null ||
    string(value, 'claimId') === null ||
    string(value, 'operationId') === null ||
    string(value, 'backupId') === null ||
    string(value, 'r2Key') === null ||
    string(value, 'actorId') === null ||
    string(value, 'correlationId') === null
  )
    return Effect.fail(persistence('backupD1.delete.claim.get'))
  const state = string(value, 'state')
  const artifactRevision = number(value, 'artifactRevision')
  if (
    (state !== 'deleting' && state !== 'deleted') ||
    artifactRevision === null ||
    !Number.isInteger(artifactRevision)
  )
    return Effect.fail(persistence('backupD1.delete.claim.get'))
  const actorType = string(value, 'auditActorType')
  if (actorType !== 'human' && actorType !== 'automation' && actorType !== 'system')
    return Effect.fail(persistence('backupD1.delete.claim.provenance'))
  const sourceJobId = string(value, 'sourceJobId')
  const sourceJobOperationId = string(value, 'sourceJobOperationId')
  if ((sourceJobId === null) !== (sourceJobOperationId === null))
    return Effect.fail(persistence('backupD1.delete.claim.source'))
  return Effect.gen(function* () {
    const requestJson = yield* decodeJson(
      'backupD1.delete.claim.provenance',
      value.auditRequestContext,
    )
    const request = yield* Schema.decodeUnknownEffect(AuditRequestContextValue, {
      onExcessProperty: 'error',
    })(requestJson).pipe(Effect.mapError(() => persistence('backupD1.delete.claim.provenance')))
    return {
      claimId: string(value, 'claimId')!,
      operationId: string(value, 'operationId')!,
      backupId: string(value, 'backupId')!,
      artifactRevision,
      r2Key: string(value, 'r2Key')!,
      sourceJobId,
      sourceJobOperationId,
      state,
      actorId: string(value, 'actorId')!,
      actorType,
      correlationId: string(value, 'correlationId')!,
      request,
    }
  })
}

interface AbandonedCreateOwner {
  readonly jobId: string
  readonly operationId: string
}

const loadAbandonedCreateOwner = (
  db: BackupD1Database,
  artifact: BackupArtifactType,
): Effect.Effect<AbandonedCreateOwner | null, BackupPersistenceError> => {
  if (artifact.state !== 'creating' && artifact.state !== 'failed') return Effect.succeed(null)
  return attempt('backupD1.delete.abandoned-owner', () =>
    db
      .prepare(`SELECT source_job.id AS jobId, source_job.operation_id AS operationId
        FROM backup_jobs source_job
        JOIN operations source_operation
          ON source_operation.organization_id = source_job.organization_id
         AND source_operation.id = source_job.operation_id
        WHERE source_job.organization_id = ?
          AND source_job.backup_id = ?
          AND source_job.mode = 'create'
          AND (
            (? = 'creating' AND source_job.state = 'cancelled'
              AND source_operation.status = 'cancelled')
            OR
            (? = 'failed' AND source_job.state IN ('failed', 'failed_terminal')
              AND source_operation.status = source_job.state)
          )
          AND NOT EXISTS (
            SELECT 1 FROM backup_jobs active_create
            WHERE active_create.organization_id = source_job.organization_id
              AND active_create.backup_id = source_job.backup_id
              AND active_create.mode = 'create'
              AND active_create.state IN (
                'reserved', 'running', 'waiting_external', 'cancelling'
              )
          )
        ORDER BY source_job.created_at DESC, source_job.id DESC
        LIMIT 1`)
      .bind(artifact.organizationId, artifact.id, artifact.state, artifact.state)
      .first(),
  ).pipe(
    Effect.flatMap((row) => {
      if (row === null) return Effect.succeed(null)
      const value = rowObject(row)
      const jobId = value === null ? null : string(value, 'jobId')
      const operationId = value === null ? null : string(value, 'operationId')
      return jobId === null || operationId === null
        ? Effect.fail(persistence('backupD1.delete.abandoned-owner'))
        : Effect.succeed({ jobId, operationId })
    }),
  )
}

const artifactSupportsDeletionClaim = (
  artifact: BackupArtifactType,
  owner: AbandonedCreateOwner | null,
): boolean =>
  artifact.state === 'available' ||
  artifact.state === 'expired' ||
  ((artifact.state === 'creating' || artifact.state === 'failed') && owner !== null)

const makeDeletionClaim = (
  artifact: BackupArtifactType,
  claim: {
    readonly claimId: string
    readonly operationId: string
    readonly backupId: string
    readonly r2Key: string
    readonly state: 'deleting' | 'deleted'
  },
): BackupDeletionClaim => ({
  claimId: claim.claimId,
  operationId: claim.operationId,
  backupId: claim.backupId,
  organizationId: artifact.organizationId,
  serverId: artifact.serverId,
  r2Key: claim.r2Key,
  artifact,
  state: claim.state,
})

const claimDelete = (db: BackupD1Database, input: BackupDeleteClaimInput) =>
  Effect.gen(function* () {
    const activeWriter = yield* attempt('backupD1.delete.upload-writer', () =>
      db
        .prepare(`SELECT 1 AS active FROM backup_upload_sessions
          WHERE organization_id = ? AND backup_id = ?
            AND state IN ('uploading', 'revoked') LIMIT 1`)
        .bind(input.context.organizationId, input.backupId)
        .first(),
    )
    if (activeWriter !== null)
      return yield* new BackupConflictError({
        code: 'backup_upload_writer_not_closed',
        message: 'backup physical cleanup is waiting for exact upload writer closure',
      })
    const existing = yield* loadDeletionClaimForBackup(
      db,
      input.context.organizationId,
      input.backupId,
    )
    if (existing !== null) {
      const artifact = yield* loadArtifact(db, input.context.organizationId, input.backupId)
      const owner = yield* loadAbandonedCreateOwner(db, artifact)
      if (existing.r2Key !== artifact.r2Key)
        return yield* new BackupConflictError({
          code: 'delete_key_mismatch',
          message: 'backup deletion claim key does not match artifact',
        })
      if (
        existing.state === 'deleting' &&
        (artifact.revision !== existing.artifactRevision ||
          !artifactSupportsDeletionClaim(artifact, owner) ||
          (owner === null
            ? existing.sourceJobId !== null || existing.sourceJobOperationId !== null
            : existing.sourceJobId !== owner.jobId ||
              existing.sourceJobOperationId !== owner.operationId))
      )
        return yield* new BackupConcurrencyError({
          code: 'delete_claim_conflict',
          message: 'backup deletion claim does not own the current artifact revision',
        })
      return makeDeletionClaim(artifact, existing)
    }
    const artifact = yield* loadArtifact(db, input.context.organizationId, input.backupId)
    const owner = yield* loadAbandonedCreateOwner(db, artifact)
    if (!artifactSupportsDeletionClaim(artifact, owner))
      return yield* new BackupConflictError({
        code: 'backup_not_deletable',
        message: 'backup cannot be deleted in its current state',
      })
    if (artifact.revision !== input.expectedRevision)
      return yield* new BackupConcurrencyError({
        code: 'revision_conflict',
        message: 'backup revision changed before deletion claim',
      })
    const artifactRevision = artifact.revision + 1
    const deletionAuditRequest = durableAuditRequestFrom(input.context, input.claimId)
    const deletionAuditActorType = auditActorTypeFrom(input.context)
    const operationInsert = db
      .prepare(`INSERT OR IGNORE INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'delete-backup', 'backup', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`)
      .bind(
        input.claimId,
        input.context.organizationId,
        input.backupId,
        input.context.identityId,
        `backup-delete:${input.backupId}:${input.expectedRevision}`,
        input.context.correlationId,
        input.now,
        input.now,
      )
    const auditOperationId = yield* terminalAuditOperationId(
      input.claimId,
      'backup.delete.accepted',
    )
    const auditOperation = terminalAuditOperation(db, {
      id: auditOperationId,
      parentOperationId: input.claimId,
      organizationId: input.context.organizationId,
      type: 'backup.delete.accepted',
      now: input.now,
    })
    const artifactClaim =
      owner === null
        ? db
            .prepare(`UPDATE backups SET revision = revision + 1
              WHERE changes() = 1 AND organization_id = ? AND id = ? AND revision = ?
                AND state IN ('available', 'expired')`)
            .bind(input.context.organizationId, input.backupId, input.expectedRevision)
        : db
            .prepare(`UPDATE backups SET revision = revision + 1
              WHERE changes() = 1 AND organization_id = ? AND id = ? AND revision = ?
                AND state IN ('creating', 'failed')
                AND EXISTS (
                  SELECT 1
                  FROM backup_jobs source_job
                  JOIN operations source_operation
                    ON source_operation.organization_id = source_job.organization_id
                   AND source_operation.id = source_job.operation_id
                  WHERE source_job.organization_id = backups.organization_id
                    AND source_job.id = ?
                    AND source_job.operation_id = ?
                    AND source_job.backup_id = backups.id
                    AND source_job.mode = 'create'
                    AND (
                      (backups.state = 'creating' AND source_job.state = 'cancelled'
                        AND source_operation.status = 'cancelled')
                      OR
                      (backups.state = 'failed'
                        AND source_job.state IN ('failed', 'failed_terminal')
                        AND source_operation.status = source_job.state)
                    )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM backup_jobs active_create
                  WHERE active_create.organization_id = backups.organization_id
                    AND active_create.backup_id = backups.id
                    AND active_create.mode = 'create'
                    AND active_create.state IN (
                      'reserved', 'running', 'waiting_external', 'cancelling'
                    )
                )`)
            .bind(
              input.context.organizationId,
              input.backupId,
              input.expectedRevision,
              owner.jobId,
              owner.operationId,
            )
    const claimInsert = db
      .prepare(`INSERT INTO backup_deletion_claims
      (organization_id, id, operation_id, backup_id, artifact_revision, r2_key, state, revision,
       created_at, updated_at, audit_actor_type, audit_request_context_json,
       source_job_id, source_job_operation_id)
      VALUES (?, ?, ?, ?, ?, ?, 'deleting', 1, ?, ?, ?, ?, ?, ?)`)
      .bind(
        input.context.organizationId,
        input.claimId,
        input.claimId,
        input.backupId,
        artifactRevision,
        artifact.r2Key,
        input.now,
        input.now,
        deletionAuditActorType,
        JSON.stringify(deletionAuditRequest),
        owner?.jobId ?? null,
        owner?.operationId ?? null,
      )
    const workflowStart = db
      .prepare(`INSERT OR IGNORE INTO lifecycle_workflow_starts
      (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
      SELECT organization_id, id, ?, 'pending', 0, NULL, ?, ? FROM operations
      WHERE organization_id = ? AND id = ?`)
      .bind(
        `workflow-start:${input.claimId}`,
        input.now,
        input.now,
        input.context.organizationId,
        input.claimId,
      )
    const auditStage = yield* stageTenantAudit(db, {
      eventId: `audit-backup-delete-${input.claimId}`,
      organizationId: input.context.organizationId,
      actorId: input.context.identityId,
      actorType: deletionAuditActorType,
      request: deletionAuditRequest,
      correlationId: input.context.correlationId,
      operationId: auditOperationId,
      action: 'backup.delete.accepted',
      targetType: 'backup',
      targetId: input.backupId,
      result: 'succeeded',
      before: { revision: input.expectedRevision, state: artifact.state },
      after: {
        operationId: input.claimId,
        claimId: input.claimId,
        expectedRevision: input.expectedRevision,
        sourceJobId: owner?.jobId ?? null,
        sourceJobOperationId: owner?.operationId ?? null,
      },
      occurredAt: input.now,
    })
    const audit = db
      .prepare(`INSERT OR IGNORE INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      SELECT ?, organization_id, actor_id, 'backup.delete.accepted', 'backup', ?, 'succeeded',
       correlation_id, ?, ? FROM operations
      WHERE organization_id = ? AND id = ?`)
      .bind(
        `audit-backup-delete-${input.claimId}`,
        input.backupId,
        JSON.stringify({
          operationId: input.claimId,
          claimId: input.claimId,
          expectedRevision: input.expectedRevision,
          sourceJobId: owner?.jobId ?? null,
          sourceJobOperationId: owner?.operationId ?? null,
        }),
        input.now,
        input.context.organizationId,
        auditOperationId,
      )
    const outbox = db
      .prepare(`INSERT OR IGNORE INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      SELECT ?, organization_id, 'backup.deletion.requested', 'backup-deletion', ?, ?,
       'pending', 0, ?, ? FROM operations
      WHERE organization_id = ? AND id = ?`)
      .bind(
        `outbox-backup-delete-${input.claimId}`,
        input.claimId,
        JSON.stringify({
          operationId: input.claimId,
          workflowStartRecordId: `workflow-start:${input.claimId}`,
          organizationId: input.context.organizationId,
          backupId: input.backupId,
        }),
        input.now,
        input.now,
        input.context.organizationId,
        input.claimId,
      )
    // Advance the catalog revision first. The claim trigger then requires the
    // exact successor revision, so an optimistic loser cannot leave an orphan
    // claim that later deletes R2 bytes without owning the artifact.
    const batch = yield* Effect.catch(
      attempt('backupD1.delete.claim.batch', () =>
        db.batch([
          operationInsert,
          auditOperation,
          auditStage,
          artifactClaim,
          claimInsert,
          workflowStart,
          audit,
          outbox,
        ]),
      ),
      () => Effect.succeed<ReadonlyArray<BackupD1Result> | null>(null),
    )
    if (
      batch === null ||
      batch.length !== 8 ||
      batch.some((result) => !result.success || result.meta?.changes !== 1)
    ) {
      const adopted = yield* loadDeletionClaimForBackup(
        db,
        input.context.organizationId,
        input.backupId,
      )
      if (adopted !== null) {
        const current = yield* loadArtifact(db, input.context.organizationId, input.backupId)
        const adoptedOwner = yield* loadAbandonedCreateOwner(db, current)
        const adoptedSourceMatches =
          adopted.state === 'deleted'
            ? true
            : adoptedOwner === null
              ? adopted.sourceJobId === null && adopted.sourceJobOperationId === null
              : adopted.sourceJobId === adoptedOwner.jobId &&
                adopted.sourceJobOperationId === adoptedOwner.operationId
        if (
          current.r2Key === adopted.r2Key &&
          current.revision === adopted.artifactRevision &&
          adoptedSourceMatches &&
          (adopted.state === 'deleted' || artifactSupportsDeletionClaim(current, adoptedOwner))
        )
          return makeDeletionClaim(current, adopted)
        return yield* new BackupConcurrencyError({
          code: 'delete_claim_conflict',
          message: 'backup deletion claim does not own the current artifact revision',
        })
      }
      if (batch !== null)
        return yield* new BackupConcurrencyError({
          code: 'delete_claim_conflict',
          message: 'backup deletion claim was fenced',
        })
      return yield* persistence('backupD1.delete.claim.batch')
    }
    return makeDeletionClaim(
      yield* loadArtifact(db, input.context.organizationId, input.backupId),
      {
        claimId: input.claimId,
        operationId: input.claimId,
        backupId: input.backupId,
        r2Key: artifact.r2Key,
        state: 'deleting',
      },
    )
  })

export interface BackupPhysicalDeletionReceipt {
  readonly organizationId: string
  readonly claimId: string
  readonly operationId: string
  readonly backupId: string
  readonly artifactRevision: number
  readonly r2Key: string
  readonly sourceJobId: string | null
  readonly sourceJobOperationId: string | null
  readonly deletedObjects: number
  readonly alreadyAbsent: boolean
  readonly completedAt: string
}

const loadPhysicalDeletionReceipt = (
  db: BackupD1Database,
  organizationId: string,
  backupId: string,
) =>
  attempt('backupD1.delete.receipt.get', () =>
    db
      .prepare(`SELECT receipt.organization_id AS organizationId,
        receipt.claim_id AS claimId, receipt.operation_id AS operationId,
        receipt.backup_id AS backupId, receipt.artifact_revision AS artifactRevision,
        receipt.r2_key AS r2Key, receipt.deleted_objects AS deletedObjects,
        receipt.source_job_id AS sourceJobId,
        receipt.source_job_operation_id AS sourceJobOperationId,
        receipt.already_absent AS alreadyAbsent, receipt.completed_at AS completedAt
      FROM backup_physical_deletion_receipts receipt
      JOIN backup_deletion_claims claim
        ON claim.organization_id = receipt.organization_id AND claim.id = receipt.claim_id
      JOIN operations operation
        ON operation.organization_id = receipt.organization_id AND operation.id = receipt.operation_id
      JOIN backups backup
        ON backup.organization_id = receipt.organization_id AND backup.id = receipt.backup_id
      WHERE receipt.organization_id = ? AND receipt.backup_id = ?
        AND claim.state = 'deleted' AND operation.status = 'succeeded'
        AND backup.state = 'deleted' AND backup.r2_key = receipt.r2_key`)
      .bind(organizationId, backupId)
      .first(),
  ).pipe(
    Effect.flatMap((row) => {
      const value = rowObject(row)
      const artifactRevision = value === null ? null : number(value, 'artifactRevision')
      const deletedObjects = value === null ? null : number(value, 'deletedObjects')
      const alreadyAbsent = value === null ? null : number(value, 'alreadyAbsent')
      const sourceJobId = value === null ? null : string(value, 'sourceJobId')
      const sourceJobOperationId = value === null ? null : string(value, 'sourceJobOperationId')
      if (
        value === null ||
        string(value, 'organizationId') === null ||
        string(value, 'claimId') === null ||
        string(value, 'operationId') === null ||
        string(value, 'backupId') === null ||
        string(value, 'r2Key') === null ||
        string(value, 'completedAt') === null ||
        artifactRevision === null ||
        deletedObjects === null ||
        (sourceJobId === null) !== (sourceJobOperationId === null) ||
        (alreadyAbsent !== 0 && alreadyAbsent !== 1)
      )
        return Effect.fail(persistence('backupD1.delete.receipt.get'))
      return Effect.succeed({
        organizationId: string(value, 'organizationId')!,
        claimId: string(value, 'claimId')!,
        operationId: string(value, 'operationId')!,
        backupId: string(value, 'backupId')!,
        artifactRevision,
        r2Key: string(value, 'r2Key')!,
        sourceJobId,
        sourceJobOperationId,
        deletedObjects,
        alreadyAbsent: alreadyAbsent === 1,
        completedAt: string(value, 'completedAt')!,
      } satisfies BackupPhysicalDeletionReceipt)
    }),
  )

export const requirePhysicalBackupDeletionReceipt = (
  db: BackupD1Database,
  input: { readonly organizationId: string; readonly backupId: string },
): Effect.Effect<BackupPhysicalDeletionReceipt, BackupPersistenceError> =>
  loadPhysicalDeletionReceipt(db, input.organizationId, input.backupId)

const completeDelete = (db: BackupD1Database, input: BackupDeleteCompletionInput) =>
  Effect.gen(function* () {
    const claim = yield* loadDeletionClaim(db, input.context.organizationId, input.claimId)
    const artifact = yield* loadArtifact(db, input.context.organizationId, claim.backupId)
    if (claim.state === 'deleted') {
      yield* loadPhysicalDeletionReceipt(db, input.context.organizationId, claim.backupId)
      return artifact
    }
    if (
      input.deletedPrefix !== claim.r2Key ||
      !Number.isSafeInteger(input.deletedObjects) ||
      input.deletedObjects < 0 ||
      (input.deletedObjects === 0 && !input.alreadyAbsent)
    )
      return yield* persistence('backupD1.delete.complete.receipt')
    if (
      artifact.revision !== input.expectedArtifactRevision ||
      artifact.revision !== claim.artifactRevision ||
      (artifact.state !== 'available' &&
        artifact.state !== 'expired' &&
        artifact.state !== 'creating' &&
        artifact.state !== 'failed')
    )
      return yield* new BackupConcurrencyError({
        code: 'delete_completion_conflict',
        message: 'backup deletion claim no longer owns the artifact revision',
      })
    const auditStage = yield* stageTenantAudit(db, {
      eventId: `audit-backup-delete-completed-${claim.operationId}`,
      organizationId: input.context.organizationId,
      actorId: claim.actorId,
      actorType: claim.actorType,
      request: claim.request,
      correlationId: claim.correlationId,
      operationId: claim.operationId,
      action: 'backup.delete.completed',
      targetType: 'backup',
      targetId: claim.backupId,
      result: 'succeeded',
      before: { revision: artifact.revision, state: artifact.state },
      after: {
        operationId: claim.operationId,
        claimId: claim.claimId,
        deletedPrefix: input.deletedPrefix,
        deletedObjects: input.deletedObjects,
        alreadyAbsent: input.alreadyAbsent,
      },
      occurredAt: input.now,
    })
    const results = yield* Effect.catch(
      attempt('backupD1.delete.complete.batch', () =>
        db.batch([
          db
            .prepare(`INSERT INTO backup_physical_deletion_receipts
          (organization_id, claim_id, operation_id, backup_id, artifact_revision, r2_key,
           deleted_objects, already_absent, completed_at, source_job_id, source_job_operation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              input.context.organizationId,
              claim.claimId,
              claim.operationId,
              claim.backupId,
              claim.artifactRevision,
              input.deletedPrefix,
              input.deletedObjects,
              input.alreadyAbsent ? 1 : 0,
              input.now,
              claim.sourceJobId,
              claim.sourceJobOperationId,
            ),
          db
            .prepare(`UPDATE backups SET state = 'deleted', revision = revision + 1
        WHERE organization_id = ? AND id = ? AND revision = ?
          AND state IN ('available', 'expired', 'creating', 'failed')`)
            .bind(input.context.organizationId, claim.backupId, input.expectedArtifactRevision),
          db
            .prepare(`UPDATE backup_deletion_claims SET state = 'deleted', revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND artifact_revision = ? AND state = 'deleting'`)
            .bind(input.now, input.context.organizationId, input.claimId, claim.artifactRevision),
          db
            .prepare(`UPDATE operations SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'retrying')`)
            .bind(input.now, input.context.organizationId, claim.operationId),
          auditStage,
          db
            .prepare(`INSERT OR IGNORE INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        SELECT ?, operation.organization_id, operation.actor_id, 'backup.delete.completed', 'backup', ?, 'succeeded',
         operation.correlation_id, ?, ? FROM operations operation
        WHERE operation.organization_id = ? AND operation.id = ?`)
            .bind(
              `audit-backup-delete-completed-${claim.operationId}`,
              claim.backupId,
              JSON.stringify({
                operationId: claim.operationId,
                claimId: claim.claimId,
                deletedPrefix: input.deletedPrefix,
                deletedObjects: input.deletedObjects,
                alreadyAbsent: input.alreadyAbsent,
              }),
              input.now,
              input.context.organizationId,
              claim.operationId,
            ),
          db
            .prepare(`INSERT OR IGNORE INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, created_at)
        SELECT ?, organization_id, 'backup.deletion.completed', 'backup-deletion', ?, ?,
         'pending', 0, ?, ? FROM operations
        WHERE organization_id = ? AND id = ?`)
            .bind(
              `outbox-backup-delete-completed-${claim.operationId}`,
              claim.operationId,
              JSON.stringify({
                operationId: claim.operationId,
                organizationId: input.context.organizationId,
                backupId: claim.backupId,
              }),
              input.now,
              input.now,
              input.context.organizationId,
              claim.operationId,
            ),
        ]),
      ),
      () => Effect.succeed<ReadonlyArray<BackupD1Result> | null>(null),
    )
    if (
      results === null ||
      results.length !== 7 ||
      results.some((result) => !result.success || result.meta?.changes !== 1)
    ) {
      const receipt = yield* Effect.catch(
        loadPhysicalDeletionReceipt(db, input.context.organizationId, claim.backupId),
        () => Effect.succeed<BackupPhysicalDeletionReceipt | null>(null),
      )
      if (
        receipt !== null &&
        receipt.claimId === claim.claimId &&
        receipt.operationId === claim.operationId &&
        receipt.artifactRevision === claim.artifactRevision &&
        receipt.r2Key === input.deletedPrefix &&
        receipt.sourceJobId === claim.sourceJobId &&
        receipt.sourceJobOperationId === claim.sourceJobOperationId &&
        receipt.deletedObjects === input.deletedObjects &&
        receipt.alreadyAbsent === input.alreadyAbsent
      )
        return yield* loadArtifact(db, input.context.organizationId, claim.backupId)
      return yield* new BackupConcurrencyError({
        code: 'delete_completion_conflict',
        message: 'backup deletion completion was fenced',
      })
    }
    return yield* loadArtifact(db, input.context.organizationId, claim.backupId)
  })

const recordDeleteFailure = (db: BackupD1Database, input: BackupDeleteFailureInput) =>
  Effect.gen(function* () {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.failureCode))
      return yield* new BackupPersistenceError({ operation: 'backupD1.delete.failure.input' })
    const claim = yield* loadDeletionClaim(db, input.context.organizationId, input.claimId)
    if (claim.state === 'deleted') return
    const summary = JSON.stringify({
      operationId: claim.operationId,
      claimId: claim.claimId,
      failureCode: input.failureCode,
    })
    const auditOperationId = yield* terminalAuditOperationId(
      claim.operationId,
      'backup.delete.retry.accepted',
    )
    const auditOperation = terminalAuditOperation(db, {
      id: auditOperationId,
      parentOperationId: claim.operationId,
      organizationId: input.context.organizationId,
      type: 'backup.delete.retry.accepted',
      now: input.now,
    })
    const auditStage = yield* stageTenantAudit(db, {
      eventId: `audit-backup-delete-failed-${claim.operationId}`,
      organizationId: input.context.organizationId,
      actorId: claim.actorId,
      actorType: claim.actorType,
      request: claim.request,
      correlationId: claim.correlationId,
      operationId: auditOperationId,
      action: 'backup.delete.retry.accepted',
      targetType: 'backup',
      targetId: claim.backupId,
      result: 'succeeded',
      before: { state: claim.state },
      after: {
        operationId: claim.operationId,
        claimId: claim.claimId,
        failureCode: input.failureCode,
      },
      occurredAt: input.now,
    })
    const results = yield* attempt('backupD1.delete.failure.batch', () =>
      db.batch([
        db
          .prepare(`UPDATE operations SET status = 'retrying', progress = 50, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'retrying')`)
          .bind(input.now, input.context.organizationId, claim.operationId),
        auditOperation,
        auditStage,
        db
          .prepare(`INSERT OR IGNORE INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        SELECT ?, organization_id, actor_id, 'backup.delete.retry.accepted', 'backup', ?, 'succeeded',
         correlation_id, ?, ? FROM operations
        WHERE organization_id = ? AND id = ?`)
          .bind(
            `audit-backup-delete-failed-${claim.operationId}`,
            claim.backupId,
            summary,
            input.now,
            input.context.organizationId,
            auditOperationId,
          ),
        db
          .prepare(`INSERT OR IGNORE INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, created_at)
        SELECT ?, organization_id, 'backup.deletion.failed', 'backup-deletion', ?, ?,
         'pending', 0, ?, ? FROM operations
        WHERE organization_id = ? AND id = ?`)
          .bind(
            `outbox-backup-delete-failed-${claim.operationId}`,
            claim.operationId,
            JSON.stringify({
              operationId: claim.operationId,
              organizationId: input.context.organizationId,
              backupId: claim.backupId,
              failureCode: input.failureCode,
            }),
            input.now,
            input.now,
            input.context.organizationId,
            claim.operationId,
          ),
      ]),
    )
    if (results.length !== 5 || results.some((result) => !result.success))
      return yield* new BackupPersistenceError({ operation: 'backupD1.delete.failure.batch' })
    // A retry after a response loss updates the retrying operation again while
    // INSERT OR IGNORE adopts the already durable audit/outbox receipts.
    if (
      results[0]?.meta?.changes === 1 &&
      results[1]?.meta?.changes === 0 &&
      results[2]?.meta?.changes === 0 &&
      results[3]?.meta?.changes === 0 &&
      results[4]?.meta?.changes === 0
    )
      return
    if (
      results[1]?.meta?.changes !== 1 ||
      results[2]?.meta?.changes !== 1 ||
      results[3]?.meta?.changes !== 1 ||
      results[4]?.meta?.changes !== 1
    )
      return yield* new BackupConcurrencyError({
        code: 'delete_failure_conflict',
        message: 'backup deletion failure evidence was already changed',
      })
  })

const retentionDeletionClaimId = (organizationId: string, backupId: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${organizationId}\n${backupId}\nphysical-retention-deletion`),
      )
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return `backup-retention-${hex}`
    },
    catch: () => persistence('backupD1.retention-delete.identity'),
  })

const claimRetentionDeletes = (
  db: BackupD1Database,
  now: string,
  limit: number,
): Effect.Effect<
  ReadonlyArray<BackupRetentionDeletionClaim>,
  BackupNotFoundError | BackupConflictError | BackupConcurrencyError | BackupPersistenceError
> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return yield* persistence('backupD1.retention-delete.limit')
    const rows = yield* attempt('backupD1.retention-delete.candidates', () =>
      db
        .prepare(`SELECT artifact.organization_id AS organizationId, artifact.id,
          artifact.server_id AS serverId, artifact.r2_key AS r2Key, artifact.checksum,
          artifact.encryption_version AS encryptionVersion, artifact.metadata_json AS metadata,
          artifact.state, artifact.revision, artifact.created_at AS createdAt,
          artifact.expires_at AS expiresAt, organization.slug AS organizationSlug,
          automation.id AS actorId
        FROM backups artifact
        JOIN organizations organization
          ON organization.id = artifact.organization_id AND organization.status = 'active'
        JOIN orphan_reconciliation_scheduler_identities scheduler
          ON scheduler.organization_id = artifact.organization_id
        JOIN identities automation
          ON automation.id = scheduler.identity_id
         AND automation.access_subject = 'system:orphan-scheduler:' || artifact.organization_id
         AND automation.status = 'active'
        JOIN organization_memberships membership
          ON membership.organization_id = artifact.organization_id
         AND membership.identity_id = automation.id
         AND membership.role = 'automation' AND membership.status = 'active'
        WHERE (
          artifact.state = 'expired'
          OR (
            artifact.state IN ('creating', 'failed')
            AND EXISTS (
              SELECT 1
              FROM backup_jobs source_job
              JOIN operations source_operation
                ON source_operation.organization_id = source_job.organization_id
               AND source_operation.id = source_job.operation_id
              WHERE source_job.organization_id = artifact.organization_id
                AND source_job.backup_id = artifact.id
                AND source_job.mode = 'create'
                AND (
                  (artifact.state = 'creating' AND source_job.state = 'cancelled'
                    AND source_operation.status = 'cancelled')
                  OR
                  (artifact.state = 'failed'
                    AND source_job.state IN ('failed', 'failed_terminal')
                    AND source_operation.status = source_job.state)
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM backup_jobs active_create
              WHERE active_create.organization_id = artifact.organization_id
                AND active_create.backup_id = artifact.id
                AND active_create.mode = 'create'
                AND active_create.state IN (
                  'reserved', 'running', 'waiting_external', 'cancelling'
                )
            )
          )
        )
          AND NOT EXISTS (
            SELECT 1 FROM backup_jobs restore
            WHERE restore.organization_id = artifact.organization_id
              AND restore.backup_id = artifact.id AND restore.mode = 'restore'
              AND restore.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
          )
          AND NOT EXISTS (
            SELECT 1 FROM backup_upload_sessions writer
            WHERE writer.organization_id = artifact.organization_id
              AND writer.backup_id = artifact.id
              AND writer.state IN ('uploading', 'revoked')
          )
        ORDER BY artifact.organization_id, artifact.created_at, artifact.id
        LIMIT ?`)
        .bind(limit)
        .all(),
    )
    return yield* Effect.forEach(
      rows.results,
      (row) =>
        Effect.gen(function* () {
          const value = rowObject(row)
          if (
            value === null ||
            string(value, 'organizationId') === null ||
            string(value, 'organizationSlug') === null ||
            string(value, 'actorId') === null
          )
            return yield* persistence('backupD1.retention-delete.candidate')
          const artifact = yield* decodeArtifact('backupD1.retention-delete.candidate', value)
          const claimId = yield* retentionDeletionClaimId(artifact.organizationId, artifact.id)
          const request: AuditRequestContextValue = {
            origin: 'scheduler',
            requestId: claimId,
            correlationId: claimId,
            source: {
              ip: {
                state: 'not-available',
                reason: 'scheduled retention has no network source',
              },
              access: {
                state: 'not-available',
                reason: 'scheduled retention has no Access assertion',
              },
            },
          }
          const context = {
            organizationId: artifact.organizationId,
            organizationSlug: string(value, 'organizationSlug')!,
            identityId: string(value, 'actorId')!,
            role: 'automation' as const,
            correlationId: claimId,
            auditActorType: 'system' as const,
            auditRequestContext: request,
          } as OrganizationContext & {
            readonly auditActorType: 'system'
            readonly auditRequestContext: AuditRequestContextValue
          }
          const claim = yield* claimDelete(db, {
            context,
            backupId: artifact.id,
            expectedRevision: artifact.revision,
            claimId,
            now,
          })
          return { context, claim }
        }),
      { concurrency: 1 },
    )
  })

const deterministicBackupId = (organizationId: string, serverId: string, idempotencyKey: string) =>
  Effect.tryPromise({
    try: async () => {
      const value = new TextEncoder().encode(`${organizationId}\0${serverId}\0${idempotencyKey}`)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value))
      return `backup-${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
    },
    catch: () => persistence('backupD1.facts.backup-id'),
  })

const parseCapability = (
  value: unknown,
): Effect.Effect<Record<string, unknown>, BackupPersistenceError> =>
  typeof value !== 'string'
    ? Effect.fail(persistence('backupD1.facts.capability'))
    : Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(value)
          return typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {}
        },
        catch: () => persistence('backupD1.facts.capability'),
      })

const resolveCreateFacts = (
  db: BackupD1Database,
  input: Parameters<BackupServerFactsShape['resolveCreate']>[0],
) =>
  Effect.gen(function* () {
    const row = yield* attempt('backupD1.facts.create', () =>
      db
        .prepare(`
      SELECT server.id AS serverId, server.plugin_id AS pluginId,
        server.plugin_version AS pluginVersion, server.desired_revision AS desiredRevision,
        server.active_config_revision AS configRevision, server.observed_state AS serverState,
        deployment.node_id AS nodeId, deployment.installed_build AS gameBuild,
        deployment.observed_state AS deploymentState,
        node.desired_state AS nodeDesiredState, node.observed_state AS nodeObservedState,
        plugin.capability_manifest_json AS capabilityManifestJson,
        mods.resolved_revision AS modSetRevision
      FROM game_servers server
      JOIN deployments deployment
        ON deployment.organization_id = server.organization_id
       AND deployment.server_id = server.id
      JOIN nodes node
        ON node.organization_id = deployment.organization_id
       AND node.id = deployment.node_id
      JOIN game_plugins plugin
        ON plugin.id = server.plugin_id AND plugin.version = server.plugin_version
      LEFT JOIN mod_sets mods
        ON mods.organization_id = server.organization_id AND mods.server_id = server.id
      WHERE server.organization_id = ? AND server.id = ?
        AND server.desired_state <> 'deleted'
        AND deployment.observed_state NOT IN ('deleting', 'deleted')
      LIMIT 1`)
        .bind(input.context.organizationId, input.serverId)
        .first(),
    )
    const value = rowObject(row)
    if (value === null)
      return yield* new BackupConflictError({
        code: 'server_not_backupable',
        message: 'game server has no authoritative deployment facts',
      })
    const serverId = string(value, 'serverId')
    const pluginId = string(value, 'pluginId')
    const pluginVersion = string(value, 'pluginVersion')
    const gameBuild = string(value, 'gameBuild')
    const nodeId = string(value, 'nodeId')
    const desiredRevision = number(value, 'desiredRevision')
    const configRevision = number(value, 'configRevision')
    const modSetRevision = number(value, 'modSetRevision') ?? 0
    const serverState = string(value, 'serverState')
    const deploymentState = string(value, 'deploymentState')
    const nodeDesiredState = string(value, 'nodeDesiredState')
    const nodeObservedState = string(value, 'nodeObservedState')
    if (
      serverId === null ||
      pluginId === null ||
      pluginVersion === null ||
      gameBuild === null ||
      gameBuild.length === 0 ||
      gameBuild.length > 256 ||
      nodeId === null ||
      desiredRevision === null ||
      configRevision === null ||
      modSetRevision < 0 ||
      !Number.isInteger(desiredRevision) ||
      !Number.isInteger(configRevision) ||
      !Number.isInteger(modSetRevision) ||
      !['running', 'stopped'].includes(serverState ?? '') ||
      !['running', 'stopped'].includes(deploymentState ?? '') ||
      !['ready', 'provisioning', 'stopped'].includes(nodeDesiredState ?? '') ||
      nodeObservedState === 'failed'
    )
      return yield* new BackupConflictError({
        code: 'server_not_backupable',
        message: 'game server is not in a backupable authoritative state',
      })
    const capability = yield* parseCapability(value['capabilityManifestJson'])
    const backupCapability = capability['backup']
    const quiesce =
      capability['backupQuiesce'] === true ||
      (typeof backupCapability === 'object' &&
        backupCapability !== null &&
        (backupCapability as Record<string, unknown>)['quiesce'] === true)
    return {
      backupId: yield* deterministicBackupId(
        input.context.organizationId,
        serverId,
        input.idempotencyKey,
      ),
      serverId,
      pluginId,
      pluginVersion,
      gameBuild,
      configRevision,
      modSetRevision,
      desiredRevision,
      nodeId,
      consistency: quiesce ? ('plugin-quiesced' as const) : ('crash-consistent' as const),
      trigger: input.context.role === 'automation' ? ('scheduled' as const) : ('manual' as const),
    } satisfies BackupCreateFacts
  })

const resolveRestoreFacts = (
  db: BackupD1Database,
  input: Parameters<BackupServerFactsShape['resolveRestore']>[0],
) =>
  Effect.gen(function* () {
    const artifact = yield* loadArtifact(db, input.context.organizationId, input.intent.backupId)
    if (artifact.state !== 'available')
      return yield* new BackupConflictError({
        code: 'backup_not_available',
        message: 'backup is not available for restore',
      })
    const targetServerId = input.intent.targetServerId ?? artifact.serverId
    const row = yield* attempt('backupD1.facts.restore.server', () =>
      db
        .prepare(`
      SELECT server.id AS serverId, server.plugin_id AS pluginId,
        server.plugin_version AS pluginVersion, server.desired_state AS desiredState,
        server.desired_revision AS desiredRevision, deployment.node_id AS deployedNodeId
      FROM game_servers server
      LEFT JOIN deployments deployment
        ON deployment.organization_id = server.organization_id
       AND deployment.server_id = server.id
      WHERE server.organization_id = ? AND server.id = ?
      LIMIT 1`)
        .bind(input.context.organizationId, targetServerId)
        .first(),
    )
    const target = rowObject(row)
    if (target === null)
      return yield* new BackupConflictError({
        code: 'restore_target_not_found',
        message: 'restore target is not in this organization',
      })
    if (
      string(target, 'pluginId') !== artifact.metadata.pluginId ||
      string(target, 'pluginVersion') !== artifact.metadata.pluginVersion ||
      string(target, 'desiredState') === 'deleted'
    )
      return yield* new BackupConflictError({
        code: 'restore_incompatible_target',
        message: 'restore target plugin or lifecycle state is incompatible',
      })
    const targetNodeId =
      input.intent.targetNodeId ??
      (targetServerId === artifact.serverId
        ? artifact.metadata.nodeId
        : (string(target, 'deployedNodeId') ?? ''))
    if (targetNodeId.length === 0)
      return yield* new BackupConflictError({
        code: 'restore_target_node_required',
        message: 'a target node is required for an undeployed restore target',
      })
    const targetNodeRow = yield* attempt('backupD1.facts.restore.node', () =>
      db
        .prepare(`
      SELECT node.id AS nodeId, node.desired_state AS desiredState, node.observed_state AS observedState
      FROM nodes node
      WHERE node.organization_id = ? AND node.id = ?
      LIMIT 1`)
        .bind(input.context.organizationId, targetNodeId)
        .first(),
    )
    const targetNode = rowObject(targetNodeRow)
    if (
      targetNode === null ||
      !['provisioning', 'ready', 'stopped'].includes(string(targetNode, 'desiredState') ?? '') ||
      string(targetNode, 'observedState') === 'failed'
    )
      return yield* new BackupConflictError({
        code: 'restore_target_node_incompatible',
        message: 'restore target node is not compatible',
      })
    const occupied = yield* attempt('backupD1.facts.restore.node-ownership', () =>
      db
        .prepare(`
      SELECT 1 AS occupied FROM deployments deployment
      WHERE deployment.organization_id = ? AND deployment.node_id = ?
        AND deployment.server_id <> ? AND deployment.observed_state NOT IN ('deleted', 'deleting')
      LIMIT 1`)
        .bind(input.context.organizationId, targetNodeId, targetServerId)
        .first(),
    )
    if (occupied !== null)
      return yield* new BackupConflictError({
        code: 'restore_target_node_occupied',
        message: 'restore target node is already assigned to another server',
      })
    const expectedTargetRevision = number(target, 'desiredRevision')
    if (
      expectedTargetRevision === null ||
      !Number.isInteger(expectedTargetRevision) ||
      expectedTargetRevision < 1
    )
      return yield* new BackupPersistenceError({ operation: 'backupD1.facts.restore.revision' })
    return {
      sourceServerId: artifact.serverId,
      sourceNodeId: artifact.metadata.nodeId,
      targetServerId,
      targetNodeId,
      metadata: artifact.metadata,
      expectedTargetRevision,
    } satisfies BackupRestoreFacts
  })

export const BackupServerFactsD1Live = Layer.effect(
  BackupServerFacts,
  Effect.gen(function* () {
    const db = yield* BackupD1Client
    return BackupServerFacts.of({
      resolveCreate: (input) => resolveCreateFacts(db, input),
      resolveRestore: (input) => resolveRestoreFacts(db, input),
    })
  }),
)

export const makeBackupServerFactsD1Layer = (database: BackupD1Database) =>
  BackupServerFactsD1Live.pipe(Layer.provide(BackupD1ClientLayer(database)))

const failJob = (db: BackupD1Database, input: BackupFailureInput) =>
  Effect.gen(function* () {
    const job = yield* loadJob(db, input.organizationId, input.jobId)
    const requestedState = input.terminal ? 'failed_terminal' : 'failed'
    if (job.state === 'failed' || job.state === 'failed_terminal') {
      if (job.state === requestedState) return job
      return yield* new BackupConcurrencyError({
        code: 'failure_conflict',
        message: 'backup failure terminal mode does not match durable state',
      })
    }
    const artifactUpdate =
      job.mode === 'create'
        ? db
            .prepare(`UPDATE backups SET state = 'failed', revision = revision + 1
          WHERE organization_id = ? AND id = ? AND state = 'creating'`)
            .bind(input.organizationId, job.backupId)
        : db
            .prepare(`UPDATE backups SET revision = revision
          WHERE organization_id = ? AND id = ? AND state = 'available'`)
            .bind(input.organizationId, job.backupId)
    const results = yield* attempt('backupD1.fail.batch', () =>
      db.batch([
        artifactUpdate,
        db
          .prepare(`UPDATE backup_jobs SET state = ?, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND revision = ?
          AND state IN ('reserved', 'running', 'waiting_external', 'cancelling')`)
          .bind(
            input.terminal ? 'failed_terminal' : 'failed',
            input.now,
            input.organizationId,
            input.jobId,
            input.expectedRevision,
          ),
        db
          .prepare(`UPDATE operations SET status = ?, progress = 100, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external', 'cancelling')`)
          .bind(
            input.terminal ? 'failed_terminal' : 'failed',
            input.now,
            input.organizationId,
            job.operationId,
          ),
      ]),
    )
    if (
      results.length !== 3 ||
      results.some((value) => !value.success || value.meta?.changes !== 1)
    )
      return yield* new BackupConcurrencyError({
        code: 'failure_conflict',
        message: 'backup failure was already applied or fenced',
      })
    return yield* loadJob(db, input.organizationId, input.jobId)
  })

export const BackupRepositoryD1Live = Layer.effect(
  BackupRepository,
  Effect.gen(function* () {
    const db = yield* BackupD1Client
    const repository = {
      reserveCreate: (input: BackupRepositoryCreateInput) => createReservation(db, input),
      reserveRestore: (input: BackupRepositoryRestoreInput) => restoreReservation(db, input),
      get: (context: OrganizationContext, backupId: string) =>
        loadArtifact(db, context.organizationId, backupId),
      list: (
        context: OrganizationContext,
        options: { readonly limit: number; readonly cursor?: string; readonly serverId?: string },
      ) =>
        Effect.gen(function* () {
          const limit =
            Number.isInteger(options.limit) && options.limit > 0 && options.limit <= 100
              ? options.limit
              : 50
          const offset =
            options.cursor === undefined ? 0 : Number(options.cursor.replace(/^offset:/, ''))
          if (!Number.isInteger(offset) || offset < 0)
            return yield* persistence('backupD1.list.cursor')
          const result = yield* attempt('backupD1.list', () => {
            const statement =
              options.serverId === undefined
                ? db
                    .prepare(`${artifactSelect} WHERE organization_id = ? AND state <> 'deleted'
                ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
                    .bind(context.organizationId, limit + 1, offset)
                : db
                    .prepare(`${artifactSelect} WHERE organization_id = ? AND server_id = ? AND state <> 'deleted'
                ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
                    .bind(context.organizationId, options.serverId, limit + 1, offset)
            return statement.all()
          })
          const values = result.results.slice(0, limit)
          const items = yield* Effect.forEach(values, (row) => decodeArtifact('backupD1.list', row))
          return {
            items,
            ...(result.results.length > limit ? { nextCursor: `offset:${offset + limit}` } : {}),
          }
        }),
      markRunning: (organizationId: string, jobId: string, expectedRevision: number, now: string) =>
        updateJob(
          db,
          'backupD1.markRunning',
          organizationId,
          jobId,
          expectedRevision,
          'running',
          now,
          false,
        ),
      markSucceeded: (input: BackupCompleteInput) => completeCreate(db, input),
      markFailed: (input: BackupFailureInput) => failJob(db, input),
      requestCancel: (
        organizationId: string,
        jobId: string,
        expectedRevision: number,
        now: string,
      ) =>
        updateJob(
          db,
          'backupD1.cancel',
          organizationId,
          jobId,
          expectedRevision,
          'cancelled',
          now,
          true,
        ),
      claimDelete: (input: BackupDeleteClaimInput) => claimDelete(db, input),
      completeDelete: (input: BackupDeleteCompletionInput) => completeDelete(db, input),
      recordDeleteFailure: (input: BackupDeleteFailureInput) => recordDeleteFailure(db, input),
      claimRetentionDeletes: (now: string, limit: number) => claimRetentionDeletes(db, now, limit),
      expire: (now: string, limit: number) =>
        Effect.gen(function* () {
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            return yield* persistence('backupD1.expire.limit')
          const rows = yield* attempt('backupD1.expire.candidates', () =>
            db
              .prepare(`
            SELECT artifact.organization_id AS organizationId, artifact.id, artifact.server_id AS serverId,
              artifact.r2_key AS r2Key, artifact.checksum, artifact.encryption_version AS encryptionVersion,
              artifact.metadata_json AS metadata, artifact.state, artifact.revision,
              artifact.created_at AS createdAt, artifact.expires_at AS expiresAt,
              automation.id AS actorId
            FROM backups artifact
            JOIN backup_schedules schedule
              ON schedule.organization_id = artifact.organization_id
             AND schedule.server_id = artifact.server_id
             AND schedule.enabled = 1
            JOIN organizations organization
              ON organization.id = artifact.organization_id AND organization.status = 'active'
            JOIN orphan_reconciliation_scheduler_identities scheduler
              ON scheduler.organization_id = artifact.organization_id
            JOIN identities automation
              ON automation.id = scheduler.identity_id
             AND automation.access_subject = 'system:orphan-scheduler:' || artifact.organization_id
             AND automation.status = 'active'
            JOIN organization_memberships automation_membership
              ON automation_membership.organization_id = artifact.organization_id
             AND automation_membership.identity_id = automation.id
             AND automation_membership.role = 'automation'
             AND automation_membership.status = 'active'
            WHERE artifact.state = 'available'
              AND (
                (artifact.expires_at IS NOT NULL AND artifact.expires_at <= ?)
                OR (
                  SELECT COUNT(*) FROM backups newer
                  WHERE newer.organization_id = artifact.organization_id
                    AND newer.server_id = artifact.server_id
                    AND newer.state = 'available'
                    AND (newer.created_at > artifact.created_at
                      OR (newer.created_at = artifact.created_at AND newer.id > artifact.id))
                ) >= schedule.retention_count
              )
              AND NOT EXISTS (
                SELECT 1 FROM backup_jobs job
                WHERE job.organization_id = artifact.organization_id
                  AND job.backup_id = artifact.id
                  AND job.mode = 'restore'
                  AND job.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
              )
              AND NOT EXISTS (
                SELECT 1 FROM backup_deletion_claims claim
                WHERE claim.organization_id = artifact.organization_id
                  AND claim.backup_id = artifact.id
                  AND claim.state = 'deleting'
              )
            ORDER BY artifact.expires_at, artifact.organization_id, artifact.id
            LIMIT ?`)
              .bind(now, limit)
              .all(),
          )
          const candidates = yield* Effect.forEach(rows.results, (row) =>
            Effect.gen(function* () {
              const value = rowObject(row)
              if (value === null || string(value, 'actorId') === null)
                return yield* persistence('backupD1.expire.actor')
              return {
                artifact: yield* decodeArtifact('backupD1.expire.candidate', value),
                actorId: string(value, 'actorId')!,
              }
            }),
          )
          if (candidates.length === 0) return []
          const statements: BackupD1Statement[] = []
          for (const candidate of candidates) {
            const artifact = candidate.artifact
            const operationId = `backup-expire-${artifact.organizationId}-${artifact.id}`
            const idempotencyKey = `backup-expire:${artifact.id}:${artifact.revision}`
            const auditStage = yield* stageTenantAudit(db, {
              eventId: `audit-backup-expire-${artifact.organizationId}-${artifact.id}`,
              organizationId: artifact.organizationId,
              actorId: candidate.actorId,
              actorType: 'system',
              correlationId: idempotencyKey,
              operationId,
              action: 'backup.expired',
              targetType: 'backup',
              targetId: artifact.id,
              result: 'succeeded',
              before: { revision: artifact.revision, state: artifact.state },
              after: { operationId, backupId: artifact.id, expiresAt: artifact.expiresAt },
              occurredAt: now,
            })
            statements.push(
              db
                .prepare(`UPDATE backups SET state = 'expired', revision = revision + 1
                WHERE organization_id = ? AND id = ? AND revision = ? AND state = 'available'
                  -- The candidate query is only a snapshot. Recheck active
                  -- restore ownership in this atomic write transaction.
                  AND NOT EXISTS (
                    SELECT 1 FROM backup_jobs job
                    WHERE job.organization_id = ? AND job.backup_id = ?
                      AND job.mode = 'restore'
                      AND job.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM backup_deletion_claims claim
                    WHERE claim.organization_id = ? AND claim.backup_id = ?
                      AND claim.state = 'deleting'
                  )`)
                .bind(
                  artifact.organizationId,
                  artifact.id,
                  artifact.revision,
                  artifact.organizationId,
                  artifact.id,
                  artifact.organizationId,
                  artifact.id,
                ),
              db
                .prepare(`INSERT OR IGNORE INTO operations
                (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
                 idempotency_key, correlation_id, revision, created_at, updated_at)
                SELECT ?, ?, 'expire-backup', 'backup', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?
                WHERE changes() = 1`)
                .bind(
                  operationId,
                  artifact.organizationId,
                  artifact.id,
                  candidate.actorId,
                  idempotencyKey,
                  idempotencyKey,
                  now,
                  now,
                ),
              auditStage,
              db
                .prepare(`INSERT OR IGNORE INTO audit_events
                (id, organization_id, actor_id, action, target_type, target_id, result,
                 correlation_id, summary_json, created_at)
                SELECT ?, organization_id, actor_id, 'backup.expired', 'backup', ?, 'succeeded',
                 correlation_id, ?, ? FROM operations
                WHERE organization_id = ? AND id = ?`)
                .bind(
                  `audit-backup-expire-${artifact.organizationId}-${artifact.id}`,
                  artifact.id,
                  JSON.stringify({
                    operationId,
                    backupId: artifact.id,
                    expiresAt: artifact.expiresAt,
                  }),
                  now,
                  artifact.organizationId,
                  operationId,
                ),
              db
                .prepare(`INSERT OR IGNORE INTO outbox
                (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                 publish_state, retry_count, available_at, created_at)
                SELECT ?, organization_id, 'backup.expired', 'backup', ?, ?,
                 'pending', 0, ?, ? FROM operations
                WHERE organization_id = ? AND id = ?`)
                .bind(
                  `outbox-backup-expire-${artifact.organizationId}-${artifact.id}`,
                  artifact.id,
                  JSON.stringify({
                    operationId,
                    organizationId: artifact.organizationId,
                    backupId: artifact.id,
                  }),
                  now,
                  now,
                  artifact.organizationId,
                  operationId,
                ),
            )
          }
          const results = yield* attempt('backupD1.expire.batch', () => db.batch(statements))
          if (results.length !== candidates.length * 5 || results.some((result) => !result.success))
            return yield* persistence('backupD1.expire.batch')
          const expired: BackupArtifactType[] = []
          for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index]!
            const group = results.slice(index * 5, index * 5 + 5)
            if (group[0]?.meta?.changes === 0) {
              if (group.slice(1).some((result) => result.meta?.changes !== 0))
                return yield* persistence('backupD1.expire.side-effect-fence')
              continue
            }
            if (group.some((result) => result.meta?.changes !== 1))
              return yield* persistence('backupD1.expire.side-effect-fence')
            expired.push(
              yield* loadArtifact(
                db,
                candidate.artifact.organizationId,
                candidate.artifact.id,
              ).pipe(Effect.mapError(() => persistence('backupD1.expire.read'))),
            )
          }
          return expired
        }),
    }
    return BackupRepository.of(repository)
  }),
)

export const makeBackupRepositoryD1Layer = (database: BackupD1Database) =>
  BackupRepositoryD1Live.pipe(Layer.provide(BackupD1ClientLayer(database)))

const workflowFailure = (message: string) =>
  new BackupWorkflowError({ code: 'persistence-failed', message })

const workflowReceipt = (
  db: BackupD1Database,
  organizationId: string,
  jobId: string,
  ordinal: number,
) =>
  attempt('backupD1.workflow-receipt.get', () =>
    db
      .prepare(`SELECT step, payload_fingerprint AS payloadFingerprint, state, revision
        FROM backup_workflow_step_receipts
        WHERE organization_id = ? AND job_id = ? AND ordinal = ?`)
      .bind(organizationId, jobId, ordinal)
      .first(),
  ).pipe(Effect.mapError(() => workflowFailure('backup Workflow receipt could not be read')))

const claimWorkflowReceipt = (
  db: BackupD1Database,
  input: Parameters<BackupWorkflowReceiptShape['claim']>[0],
) =>
  Effect.gen(function* () {
    const existing = rowObject(
      yield* workflowReceipt(db, input.job.organizationId, input.job.id, input.ordinal),
    )
    if (existing !== null) {
      if (
        string(existing, 'step') !== input.step ||
        string(existing, 'payloadFingerprint') !== input.payloadFingerprint
      )
        return yield* new BackupWorkflowError({
          code: 'invalid-step',
          message: 'backup Workflow ordinal was replayed with different signed input',
        })
      const revision = number(existing, 'revision')
      if (revision === null || !Number.isSafeInteger(revision))
        return yield* workflowFailure('backup Workflow receipt revision is invalid')
      return {
        disposition:
          string(existing, 'state') === 'completed' ? ('adopted' as const) : ('execute' as const),
        revision,
      }
    }
    const rollback = input.step === 'restore-rollback' && input.ordinal === 99
    const terminalFailure = input.step === 'fail' && input.ordinal === 100
    const recoveryStep = rollback || terminalFailure
    const finalize = input.step === 'restore-finalize' && input.ordinal === 5
    const destructive = input.step === 'agent-create' || input.step === 'restore-cutover'
    const phaseGate = finalize
      ? db
          .prepare(`UPDATE backup_jobs SET revision = revision
            WHERE organization_id = ? AND id = ? AND state = 'succeeded'
              AND EXISTS (SELECT 1 FROM operation_cancellation_facts facts
                WHERE facts.organization_id = backup_jobs.organization_id
                  AND facts.operation_id = backup_jobs.operation_id AND facts.phase = 'terminal')`)
          .bind(input.job.organizationId, input.job.id)
      : db
          .prepare(`UPDATE operation_cancellation_facts
            SET phase = ?, active_step_name = ?, active_step_ordinal = ?,
                revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND operation_id = ?
              AND phase IN (${
                rollback
                  ? "'before-destructive-step', 'between-steps', 'step-running', 'destructive-step-running'"
                  : input.step === 'complete'
                    ? "'before-destructive-step', 'between-steps', 'step-running'"
                    : "'before-destructive-step', 'between-steps'"
              })
              ${
                rollback
                  ? ''
                  : `AND NOT EXISTS (
                SELECT 1 FROM operation_cancellation_requests request
                WHERE request.organization_id = operation_cancellation_facts.organization_id
                  AND request.operation_id = operation_cancellation_facts.operation_id
              )`
              }
              AND EXISTS (
                SELECT 1 FROM backup_jobs job JOIN operations operation
                  ON operation.organization_id = job.organization_id
                 AND operation.id = job.operation_id
                WHERE job.organization_id = ? AND job.id = ?
                  AND job.operation_id = operation_cancellation_facts.operation_id
                  AND job.state IN (${
                    rollback
                      ? "'reserved', 'running', 'waiting_external', 'cancelling'"
                      : "'reserved', 'running', 'waiting_external'"
                  })
                  AND operation.status IN (${
                    rollback
                      ? "'queued', 'running', 'waiting_external', 'cancelling'"
                      : "'queued', 'running', 'waiting_external'"
                  })
              )`)
          .bind(
            destructive ? 'destructive-step-running' : 'step-running',
            input.step,
            input.ordinal,
            input.now,
            input.job.organizationId,
            input.job.operationId,
            input.job.organizationId,
            input.job.id,
          )
    const receiptInsert = db
      .prepare(`INSERT INTO backup_workflow_step_receipts
          (organization_id, job_id, ordinal, step, payload_fingerprint, state,
           result_json, revision, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, 'claimed', NULL, 1, ?, ?
          WHERE changes() = 1
          AND (? = 1 OR ? = (
            SELECT count(*) FROM backup_workflow_step_receipts receipt
            WHERE receipt.organization_id = ? AND receipt.job_id = ?
              AND receipt.state = 'completed'
          ))`)
      .bind(
        input.job.organizationId,
        input.job.id,
        input.ordinal,
        input.step,
        input.payloadFingerprint,
        input.now,
        input.now,
        recoveryStep ? 1 : 0,
        input.ordinal,
        input.job.organizationId,
        input.job.id,
      )
    const claimFence = db
      .prepare(`INSERT INTO backup_workflow_claim_fences
        (organization_id, job_id, ordinal, step, payload_fingerprint, facts_revision, created_at)
        SELECT ?, ?, ?, ?, ?, facts.revision, ?
        FROM backup_jobs job JOIN operation_cancellation_facts facts
          ON facts.organization_id = job.organization_id AND facts.operation_id = job.operation_id
        WHERE job.organization_id = ? AND job.id = ?`)
      .bind(
        input.job.organizationId,
        input.job.id,
        input.ordinal,
        input.step,
        input.payloadFingerprint,
        input.now,
        input.job.organizationId,
        input.job.id,
      )
    const claimed = yield* attempt('backupD1.workflow-receipt.claim', () =>
      db.batch([phaseGate, receiptInsert, claimFence]),
    ).pipe(Effect.mapError(() => workflowFailure('backup Workflow receipt claim failed')))
    if (
      claimed.length !== 3 ||
      claimed.some((result) => !result.success || result.meta?.changes !== 1)
    )
      return yield* new BackupWorkflowError({
        code: 'invalid-step',
        message: 'backup Workflow ordinal was skipped or reordered',
      })
    return { disposition: 'execute' as const, revision: 1 }
  })

const completeWorkflowReceipt = (
  db: BackupD1Database,
  input: Parameters<BackupWorkflowReceiptShape['complete']>[0],
) =>
  Effect.gen(function* () {
    const evidence = JSON.stringify(input.evidence)
    let durableGate: BackupD1Statement
    let durableState: string | null = null
    if (input.job.mode === 'create') {
      durableGate = db
        .prepare(`UPDATE backup_jobs SET revision = revision
          WHERE organization_id = ? AND id = ?`)
        .bind(input.job.organizationId, input.job.id)
    } else {
      const transition =
        input.step === 'mark-running'
          ? { from: ['reserved'], to: 'reserved', sourcePreserved: 1 }
          : input.step === 'agent-restore-stage' && input.evidence['staged'] === true
            ? { from: ['reserved'], to: 'staged', sourcePreserved: 1 }
            : input.step === 'restore-validate' && input.evidence['validated'] === true
              ? { from: ['staged'], to: 'validated', sourcePreserved: 1 }
              : input.step === 'restore-cutover' &&
                  input.evidence['cutover'] === true &&
                  input.evidence['sourcePreserved'] === true
                ? { from: ['validated'], to: 'committed', sourcePreserved: 1 }
                : input.step === 'complete' &&
                    input.evidence['committed'] === true &&
                    input.evidence['sourcePreserved'] === true &&
                    input.evidence['observed'] === true &&
                    input.evidence['sourceServerId'] === input.job.sourceServerId &&
                    input.evidence['targetServerId'] === input.job.targetServerId &&
                    input.evidence['targetNodeId'] === input.job.targetNodeId &&
                    typeof input.evidence['observedRevision'] === 'number' &&
                    Number.isSafeInteger(input.evidence['observedRevision']) &&
                    input.evidence['observedRevision'] > 0
                  ? { from: ['committed'], to: 'committed', sourcePreserved: 1 }
                  : input.step === 'restore-finalize' && input.evidence['finalized'] === true
                    ? { from: ['committed'], to: 'committed', sourcePreserved: 1 }
                    : input.step === 'restore-rollback' &&
                        input.evidence['sourcePreserved'] === true
                      ? {
                          from: ['staged', 'validated', 'committed'],
                          to: 'rolled_back',
                          sourcePreserved: 1,
                        }
                      : input.step === 'fail'
                        ? {
                            from: ['reserved', 'staged', 'validated', 'committed', 'rolled_back'],
                            to: 'failed',
                            sourcePreserved: 1,
                          }
                        : null
      if (transition === null)
        return yield* new BackupWorkflowError({
          code: 'invalid-step',
          message: 'backup restore evidence does not prove the requested transition',
        })
      durableState = transition.to
      durableGate = db
        .prepare(`UPDATE backup_restore_cutovers
          SET state = ?, source_preserved = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND job_id = ?
            AND state IN (${transition.from.map(() => '?').join(', ')})
            ${
              input.step === 'restore-cutover'
                ? `AND EXISTS (
              SELECT 1 FROM backup_restore_endpoint_receipts endpoint
              WHERE endpoint.organization_id = backup_restore_cutovers.organization_id
                AND endpoint.job_id = backup_restore_cutovers.job_id
                AND endpoint.effect_id = ? AND endpoint.state = 'applied'
            )`
                : ''
            }`)
        .bind(
          transition.to,
          transition.sourcePreserved,
          input.now,
          input.job.organizationId,
          input.job.id,
          ...transition.from,
          ...(input.step === 'restore-cutover'
            ? [
                `${input.job.organizationId}:${input.job.id}:${input.ordinal}:${input.payloadFingerprint}`,
              ]
            : []),
        )
    }
    const receiptUpdate = db
      .prepare(`UPDATE backup_workflow_step_receipts
        SET state = 'completed', result_json = ?, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND job_id = ? AND ordinal = ? AND step = ?
          AND payload_fingerprint = ? AND revision = ? AND state = 'claimed'
          ${
            durableState === null
              ? ''
              : `AND EXISTS (
            SELECT 1 FROM backup_restore_cutovers cutover
            WHERE cutover.organization_id = ? AND cutover.job_id = ?
              AND cutover.state = ? AND cutover.source_preserved = 1
          )`
          }`)
      .bind(
        evidence,
        input.now,
        input.job.organizationId,
        input.job.id,
        input.ordinal,
        input.step,
        input.payloadFingerprint,
        input.expectedRevision,
        ...(durableState === null ? [] : [input.job.organizationId, input.job.id, durableState]),
      )
    const terminalStep =
      (input.job.mode === 'create' && input.step === 'agent-create') ||
      input.step === 'complete' ||
      input.step === 'fail'
    const nextPhase = terminalStep
      ? 'terminal'
      : input.step === 'restore-cutover'
        ? 'step-running'
        : input.step === 'restore-finalize'
          ? 'terminal'
          : 'between-steps'
    const factsUpdate =
      input.step === 'restore-finalize'
        ? db
            .prepare(`UPDATE backup_jobs SET revision = revision
              WHERE organization_id = ? AND id = ? AND state = 'succeeded'
                AND EXISTS (SELECT 1 FROM operation_cancellation_facts facts
                  WHERE facts.organization_id = backup_jobs.organization_id
                    AND facts.operation_id = backup_jobs.operation_id AND facts.phase = 'terminal')`)
            .bind(input.job.organizationId, input.job.id)
        : db
            .prepare(`UPDATE operation_cancellation_facts
              SET phase = ?, active_step_name = NULL, active_step_ordinal = NULL,
                  revision = revision + 1, updated_at = ?
              WHERE organization_id = ? AND operation_id = ?
                AND active_step_name = ? AND active_step_ordinal = ?
                AND phase IN ('step-running', 'destructive-step-running')
                AND EXISTS (
                  SELECT 1 FROM backup_workflow_step_receipts receipt
                  WHERE receipt.organization_id = ? AND receipt.job_id = ?
                    AND receipt.ordinal = ? AND receipt.step = ?
                    AND receipt.payload_fingerprint = ? AND receipt.revision = ?
                    AND receipt.state = 'claimed'
                )`)
            .bind(
              nextPhase,
              input.now,
              input.job.organizationId,
              input.job.operationId,
              input.step,
              input.ordinal,
              input.job.organizationId,
              input.job.id,
              input.ordinal,
              input.step,
              input.payloadFingerprint,
              input.expectedRevision,
            )
    const completionFence = db
      .prepare(`INSERT INTO backup_workflow_completion_fences
        (organization_id, job_id, ordinal, step, payload_fingerprint,
         receipt_revision, expected_cutover_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        input.job.organizationId,
        input.job.id,
        input.ordinal,
        input.step,
        input.payloadFingerprint,
        input.expectedRevision + 1,
        durableState,
        input.now,
      )
    const results = yield* attempt('backupD1.workflow-receipt.complete', () =>
      db.batch([durableGate, factsUpdate, receiptUpdate, completionFence]),
    ).pipe(Effect.mapError(() => workflowFailure('backup Workflow receipt completion failed')))
    if (
      results.length !== 4 ||
      results.some((result) => !result.success || result.meta?.changes !== 1)
    )
      return yield* new BackupWorkflowError({
        code: 'invalid-step',
        message: 'backup Workflow receipt or cutover revision was fenced',
      })
  })

export const BackupWorkflowReceiptD1Live = Layer.effect(
  BackupWorkflowReceipt,
  Effect.gen(function* () {
    const db = yield* BackupD1Client
    return BackupWorkflowReceipt.of({
      claim: (input) => claimWorkflowReceipt(db, input),
      complete: (input) => completeWorkflowReceipt(db, input),
      requireCommittedRestore: (job) =>
        attempt('backupD1.workflow-receipt.committed', () =>
          db
            .prepare(`SELECT revision FROM backup_restore_cutovers
              WHERE organization_id = ? AND job_id = ? AND backup_id = ?
                AND source_server_id = ? AND target_server_id = ?
                AND state = 'committed' AND source_preserved = 1`)
            .bind(job.organizationId, job.id, job.backupId, job.sourceServerId, job.targetServerId)
            .first(),
        ).pipe(
          Effect.mapError(() => workflowFailure('restore cutover evidence could not be read')),
          Effect.flatMap((row) => {
            const value = rowObject(row)
            const revision = value === null ? null : number(value, 'revision')
            return revision === null || !Number.isSafeInteger(revision)
              ? Effect.fail(
                  new BackupWorkflowError({
                    code: 'restore-failed',
                    message: 'restore completion requires a committed source-preserving cutover',
                  }),
                )
              : Effect.succeed({
                  committed: true as const,
                  sourcePreserved: true as const,
                  revision,
                })
          }),
        ),
    })
  }),
)

export const makeBackupWorkflowReceiptD1Layer = (database: BackupD1Database) =>
  BackupWorkflowReceiptD1Live.pipe(Layer.provide(BackupD1ClientLayer(database)))

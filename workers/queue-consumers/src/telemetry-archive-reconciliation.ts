/**
 * Reconciles the narrow crash window after an immutable log object reaches R2
 * but before the final D1 receipt batch accepts it. The pending table is
 * written before upload, so this worker never lists a broad R2 prefix or
 * deletes an object without matching its full immutable identity.
 */

export interface TelemetryArchiveReconciliationStatement {
  readonly bind: (...values: ReadonlyArray<unknown>) => TelemetryArchiveReconciliationStatement
  readonly all: () => Promise<{ readonly results: ReadonlyArray<unknown> }>
  readonly first: () => Promise<unknown>
  readonly run: () => Promise<unknown>
}

export interface TelemetryArchiveReconciliationDatabase {
  readonly prepare: (sql: string) => TelemetryArchiveReconciliationStatement
}

export interface TelemetryArchiveReconciliationBucket {
  readonly head: (key: string) => Promise<{
    readonly key: string
    readonly size: number
    readonly customMetadata?: Readonly<Record<string, string>>
  } | null>
  readonly delete: (key: string) => Promise<void>
}

interface PendingArchiveUpload {
  readonly organizationId: string
  readonly archiveId: string
  readonly archiveBaseId: string
  readonly archiveGeneration: number
  readonly nodeId: string
  readonly serverId: string
  readonly deploymentId: string
  readonly streamEpoch: string
  readonly r2Key: string
  readonly sha256: string
  readonly compressedSha256: string
  readonly entryCount: number
  readonly uncompressedBytes: number
  readonly compressedBytes: number
  readonly state: 'pending' | 'cleaned'
  readonly uploadLeaseId: string | null
  readonly uploadClaimedAt: string | null
  readonly uploadLeaseExpiresAt: string | null
  readonly uploadClaimedEver: 0 | 1
  readonly uploadWatchAfter: string | null
  readonly uploadWatchUntil: string | null
  readonly uploadWatchRequired: 0 | 1
  /** A queue worker may clean only after the R2 writer itself settled. */
  readonly uploadWriterState: 'unresolved' | 'terminated'
  readonly uploadWriterTerminatedAt: string | null
}

export type TelemetryArchiveReconciliationResult =
  | { readonly disposition: 'accepted'; readonly archive: PendingArchiveUpload }
  | { readonly disposition: 'cleaned'; readonly archive: PendingArchiveUpload }
  | { readonly disposition: 'preserved-conflict'; readonly archive: PendingArchiveUpload }
  | { readonly disposition: 'retry'; readonly archive?: PendingArchiveUpload }

const CLEANUP_LEASE_MILLISECONDS = 5 * 60_000
const MAX_ARCHIVE_GENERATION = 3
const ARCHIVE_RETRY_BACKOFF_MILLISECONDS = [30_000, 120_000, 600_000] as const

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const text = (row: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof row[key] === 'string' ? (row[key] as string) : undefined

const nullableText = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined => (row[key] === null ? null : text(row, key))

const integer = (row: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0
    ? (row[key] as number)
    : undefined

const decodePendingArchive = (value: unknown): PendingArchiveUpload | undefined => {
  const row = record(value)
  if (row === undefined) return undefined
  const organizationId = text(row, 'organizationId')
  const archiveId = text(row, 'archiveId')
  const archiveBaseId = text(row, 'archiveBaseId')
  const archiveGeneration = integer(row, 'archiveGeneration')
  const nodeId = text(row, 'nodeId')
  const serverId = text(row, 'serverId')
  const deploymentId = text(row, 'deploymentId')
  const streamEpoch = text(row, 'streamEpoch')
  const r2Key = text(row, 'r2Key')
  const sha256 = text(row, 'sha256')
  const compressedSha256 = text(row, 'compressedSha256')
  const entryCount = integer(row, 'entryCount')
  const uncompressedBytes = integer(row, 'uncompressedBytes')
  const compressedBytes = integer(row, 'compressedBytes')
  const state = text(row, 'state')
  const uploadLeaseId = nullableText(row, 'uploadLeaseId')
  const uploadClaimedAt = nullableText(row, 'uploadClaimedAt')
  const uploadLeaseExpiresAt = nullableText(row, 'uploadLeaseExpiresAt')
  const uploadClaimedEver = integer(row, 'uploadClaimedEver')
  const uploadWatchAfter = nullableText(row, 'uploadWatchAfter')
  const uploadWatchUntil = nullableText(row, 'uploadWatchUntil')
  const uploadWatchRequired = integer(row, 'uploadWatchRequired')
  const uploadWriterState = text(row, 'uploadWriterState')
  const uploadWriterTerminatedAt = nullableText(row, 'uploadWriterTerminatedAt')
  if (
    organizationId === undefined ||
    archiveId === undefined ||
    archiveBaseId === undefined ||
    archiveGeneration === undefined ||
    archiveGeneration > MAX_ARCHIVE_GENERATION ||
    archiveId !==
      (archiveGeneration === 0 ? archiveBaseId : `${archiveBaseId}_g${archiveGeneration}`) ||
    nodeId === undefined ||
    serverId === undefined ||
    deploymentId === undefined ||
    streamEpoch === undefined ||
    r2Key === undefined ||
    sha256 === undefined ||
    compressedSha256 === undefined ||
    entryCount === undefined ||
    entryCount < 1 ||
    uncompressedBytes === undefined ||
    uncompressedBytes < 1 ||
    compressedBytes === undefined ||
    compressedBytes < 1 ||
    (state !== 'pending' && state !== 'cleaned') ||
    uploadLeaseId === undefined ||
    uploadClaimedAt === undefined ||
    uploadLeaseExpiresAt === undefined ||
    (uploadClaimedEver !== 0 && uploadClaimedEver !== 1) ||
    uploadWatchAfter === undefined ||
    uploadWatchUntil === undefined ||
    (uploadWatchRequired !== 0 && uploadWatchRequired !== 1) ||
    (uploadWriterState !== 'unresolved' && uploadWriterState !== 'terminated') ||
    uploadWriterTerminatedAt === undefined ||
    (uploadClaimedEver === 0 &&
      (uploadLeaseId !== null ||
        uploadClaimedAt !== null ||
        uploadLeaseExpiresAt !== null ||
        uploadWatchAfter !== null ||
        uploadWatchUntil !== null ||
        uploadWatchRequired !== 0 ||
        uploadWriterState !== 'unresolved' ||
        uploadWriterTerminatedAt !== null)) ||
    (uploadClaimedEver === 1 &&
      (uploadClaimedAt === null ||
        uploadLeaseExpiresAt === null ||
        uploadWatchAfter === null ||
        uploadWatchUntil !== null ||
        (uploadWriterState === 'unresolved' &&
          (uploadLeaseId === null ||
            uploadWatchRequired !== 1 ||
            uploadWriterTerminatedAt !== null)) ||
        (uploadWriterState === 'terminated' &&
          (uploadLeaseId !== null ||
            uploadWatchRequired !== 0 ||
            uploadWriterTerminatedAt === null))))
  )
    return undefined
  return {
    organizationId,
    archiveId,
    archiveBaseId,
    archiveGeneration,
    nodeId,
    serverId,
    deploymentId,
    streamEpoch,
    r2Key,
    sha256,
    compressedSha256,
    entryCount,
    uncompressedBytes,
    compressedBytes,
    state,
    uploadLeaseId,
    uploadClaimedAt,
    uploadLeaseExpiresAt,
    uploadClaimedEver,
    uploadWatchAfter,
    uploadWatchUntil,
    uploadWatchRequired,
    uploadWriterState,
    uploadWriterTerminatedAt,
  }
}

const exactR2Identity = (
  archive: PendingArchiveUpload,
  object: NonNullable<Awaited<ReturnType<TelemetryArchiveReconciliationBucket['head']>>>,
): boolean => {
  const metadata = object.customMetadata
  return (
    object.key === archive.r2Key &&
    object.size === archive.compressedBytes &&
    metadata?.organizationId === archive.organizationId &&
    metadata.serverId === archive.serverId &&
    metadata.nodeId === archive.nodeId &&
    metadata.archiveId === archive.archiveId &&
    (archive.archiveGeneration === 0
      ? metadata.archiveGeneration === undefined || metadata.archiveGeneration === '0'
      : metadata.archiveGeneration === String(archive.archiveGeneration)) &&
    metadata.streamEpoch === archive.streamEpoch &&
    metadata.sha256 === archive.sha256 &&
    metadata.compressedSha256 === archive.compressedSha256 &&
    metadata.entryCount === String(archive.entryCount) &&
    metadata.uncompressedBytes === String(archive.uncompressedBytes) &&
    metadata.compressedBytes === String(archive.compressedBytes)
  )
}

const receiptAccepted = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
): Promise<boolean> => {
  const row = await database
    .prepare(`SELECT 1
    FROM telemetry_ingestion_receipts
    WHERE organization_id = ? AND node_id = ? AND server_id = ?
      AND deployment_id = ? AND stream_epoch = ?
      AND archive_id = ? AND archive_r2_key = ? AND archive_sha256 = ?
      AND archive_entry_count = ? AND archive_uncompressed_bytes = ?
      AND archive_compressed_bytes = ?
    LIMIT 1`)
    .bind(
      archive.organizationId,
      archive.nodeId,
      archive.serverId,
      archive.deploymentId,
      archive.streamEpoch,
      archive.archiveId,
      archive.r2Key,
      archive.sha256,
      archive.entryCount,
      archive.uncompressedBytes,
      archive.compressedBytes,
    )
    .first()
  return record(row) !== undefined
}

interface CleanupLease {
  readonly id: string
  readonly expiresAt: string
}

const leaseFor = (now: string): CleanupLease | undefined => {
  const milliseconds = Date.parse(now)
  if (!Number.isFinite(milliseconds)) return undefined
  return {
    id: crypto.randomUUID(),
    expiresAt: new Date(milliseconds + CLEANUP_LEASE_MILLISECONDS).toISOString(),
  }
}

/**
 * One D1 UPDATE is the cleanup ownership boundary. A scheduler may never
 * replace a live (or merely expired) upload owner: time is not proof that an
 * R2 PUT has stopped. It can claim only an intent that never started writing,
 * or one whose writer recorded a terminal state after its R2 promise settled.
 */
const claimCleanupLease = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  now: string,
): Promise<CleanupLease | undefined> => {
  const lease = leaseFor(now)
  if (lease === undefined) return undefined
  await database
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET cleanup_lease_id = ?, cleanup_claimed_at = ?, cleanup_lease_expires_at = ?,
        cleanup_claimed_ever = 1, updated_at = ?
    WHERE organization_id = ? AND archive_id = ? AND state = 'pending'
      AND (cleanup_lease_id IS NULL OR cleanup_lease_expires_at <= ?)
      AND (
        upload_claimed_ever = 0
        OR (
          upload_claimed_ever = 1
          AND upload_writer_state = 'terminated'
          AND upload_writer_terminated_at IS NOT NULL
          AND upload_lease_id IS NULL
          AND upload_watch_required = 0
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM telemetry_ingestion_receipts receipt
        WHERE receipt.organization_id = telemetry_pending_archive_uploads.organization_id
          AND receipt.node_id = telemetry_pending_archive_uploads.node_id
          AND receipt.server_id = telemetry_pending_archive_uploads.server_id
          AND receipt.deployment_id = telemetry_pending_archive_uploads.deployment_id
          AND receipt.stream_epoch = telemetry_pending_archive_uploads.stream_epoch
          AND receipt.archive_id = telemetry_pending_archive_uploads.archive_id
          AND receipt.archive_r2_key = telemetry_pending_archive_uploads.r2_key
          AND receipt.archive_sha256 = telemetry_pending_archive_uploads.sha256
          AND receipt.archive_entry_count = telemetry_pending_archive_uploads.entry_count
          AND receipt.archive_uncompressed_bytes = telemetry_pending_archive_uploads.uncompressed_bytes
          AND receipt.archive_compressed_bytes = telemetry_pending_archive_uploads.compressed_bytes
      )`)
    .bind(lease.id, now, lease.expiresAt, now, archive.organizationId, archive.archiveId, now)
    .run()
  const row = record(
    await database
      .prepare(`SELECT state, cleanup_lease_id AS cleanupLeaseId,
    cleanup_lease_expires_at AS cleanupLeaseExpiresAt
    FROM telemetry_pending_archive_uploads
    WHERE organization_id = ? AND archive_id = ?`)
      .bind(archive.organizationId, archive.archiveId)
      .first(),
  )
  return row !== undefined &&
    text(row, 'state') === 'pending' &&
    text(row, 'cleanupLeaseId') === lease.id &&
    text(row, 'cleanupLeaseExpiresAt') === lease.expiresAt
    ? lease
    : undefined
}

/** An old Worker must prove it still owns a non-expired lease immediately before R2 mutation. */
const ownsCleanupLease = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  lease: CleanupLease,
  now: string,
): Promise<boolean> => {
  const row = record(
    await database
      .prepare(`SELECT state, cleanup_lease_id AS cleanupLeaseId,
    cleanup_lease_expires_at AS cleanupLeaseExpiresAt
    FROM telemetry_pending_archive_uploads
    WHERE organization_id = ? AND archive_id = ?`)
      .bind(archive.organizationId, archive.archiveId)
      .first(),
  )
  return (
    row !== undefined &&
    text(row, 'state') === 'pending' &&
    text(row, 'cleanupLeaseId') === lease.id &&
    text(row, 'cleanupLeaseExpiresAt') === lease.expiresAt &&
    lease.expiresAt > now
  )
}

const releaseCleanupLease = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  lease: CleanupLease,
  now: string,
): Promise<void> => {
  await database
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET cleanup_lease_id = NULL, cleanup_claimed_at = NULL, cleanup_lease_expires_at = NULL, updated_at = ?
    WHERE organization_id = ? AND archive_id = ? AND state = 'pending' AND cleanup_lease_id = ?`)
    .bind(now, archive.organizationId, archive.archiveId, lease.id)
    .run()
}

const markReceiptAccepted = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  now: string,
): Promise<void> => {
  await database
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET state = 'accepted', cleanup_lease_id = NULL, cleanup_claimed_at = NULL,
        cleanup_lease_expires_at = NULL, updated_at = ?
    WHERE organization_id = ? AND archive_id = ? AND state = 'pending'
      AND cleanup_lease_id IS NULL`)
    .bind(now, archive.organizationId, archive.archiveId)
    .run()
}

const finishCleanup = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  lease: CleanupLease,
  now: string,
): Promise<boolean> => {
  await database
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET state = 'cleaned', cleanup_lease_id = NULL, cleanup_claimed_at = NULL,
        cleanup_lease_expires_at = NULL, updated_at = ?
    WHERE organization_id = ? AND archive_id = ? AND state = 'pending'
      AND cleanup_lease_id = ? AND cleanup_lease_expires_at = ?
      AND cleanup_lease_expires_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM telemetry_ingestion_receipts receipt
        WHERE receipt.organization_id = telemetry_pending_archive_uploads.organization_id
          AND receipt.node_id = telemetry_pending_archive_uploads.node_id
          AND receipt.server_id = telemetry_pending_archive_uploads.server_id
          AND receipt.deployment_id = telemetry_pending_archive_uploads.deployment_id
          AND receipt.stream_epoch = telemetry_pending_archive_uploads.stream_epoch
          AND receipt.archive_id = telemetry_pending_archive_uploads.archive_id
          AND receipt.archive_r2_key = telemetry_pending_archive_uploads.r2_key
          AND receipt.archive_sha256 = telemetry_pending_archive_uploads.sha256
          AND receipt.archive_entry_count = telemetry_pending_archive_uploads.entry_count
          AND receipt.archive_uncompressed_bytes = telemetry_pending_archive_uploads.uncompressed_bytes
          AND receipt.archive_compressed_bytes = telemetry_pending_archive_uploads.compressed_bytes
      )`)
    .bind(now, archive.organizationId, archive.archiveId, lease.id, lease.expiresAt, now)
    .run()
  const row = record(
    await database
      .prepare(`SELECT state FROM telemetry_pending_archive_uploads
    WHERE organization_id = ? AND archive_id = ?`)
      .bind(archive.organizationId, archive.archiveId)
      .first(),
  )
  return text(row ?? {}, 'state') === 'cleaned'
}

const retryAfter = (now: string, generation: number): string | undefined => {
  const milliseconds = Date.parse(now)
  const delay = ARCHIVE_RETRY_BACKOFF_MILLISECONDS[generation]
  return Number.isFinite(milliseconds) && delay !== undefined
    ? new Date(milliseconds + delay).toISOString()
    : undefined
}

/**
 * Persist the retry decision before deleting a physical attempt. The
 * reservation is the long-lived bounded ledger; the pending object row is
 * merely the exact cleanup target and can therefore be compacted safely.
 */
const recordRetryOutcome = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  now: string,
): Promise<boolean> => {
  const exhausted = archive.archiveGeneration >= MAX_ARCHIVE_GENERATION
  const retryAt = exhausted ? null : retryAfter(now, archive.archiveGeneration)
  if (!exhausted && retryAt === undefined) return false
  await database
    .prepare(`UPDATE telemetry_log_epoch_reservations
    SET archive_retry_state = ?, archive_retry_after = ?, updated_at = ?
    WHERE organization_id = ? AND node_id = ? AND server_id = ?
      AND deployment_id = ? AND stream_epoch = ?
      AND archive_base_id = ?
      AND state = 'reserved'
      AND archive_attempt_generation = ?
      AND archive_attempt_count = ?
      AND archive_retry_state = 'active'`)
    .bind(
      exhausted ? 'quarantined' : 'backoff',
      retryAt,
      now,
      archive.organizationId,
      archive.nodeId,
      archive.serverId,
      archive.deploymentId,
      archive.streamEpoch,
      // archive_base_id is a digest-derived immutable range identity.
      // Matching its generation/count prevents a stale cleaner from changing
      // a newer retry decision.
      archive.archiveBaseId,
      archive.archiveGeneration,
      archive.archiveGeneration + 1,
    )
    .run()
  const row = record(
    await database
      .prepare(`SELECT archive_retry_state AS archiveRetryState,
      archive_retry_after AS archiveRetryAfter
      FROM telemetry_log_epoch_reservations
      WHERE organization_id = ? AND node_id = ? AND server_id = ?
        AND deployment_id = ? AND stream_epoch = ?
        AND archive_base_id = ?
        AND archive_attempt_generation = ? AND archive_attempt_count = ?
      LIMIT 1`)
      .bind(
        archive.organizationId,
        archive.nodeId,
        archive.serverId,
        archive.deploymentId,
        archive.streamEpoch,
        archive.archiveBaseId,
        archive.archiveGeneration,
        archive.archiveGeneration + 1,
      )
      .first(),
  )
  return exhausted
    ? text(row ?? {}, 'archiveRetryState') === 'quarantined' &&
        nullableText(row ?? {}, 'archiveRetryAfter') === null
    : text(row ?? {}, 'archiveRetryState') === 'backoff' &&
        nullableText(row ?? {}, 'archiveRetryAfter') !== null
}

const compactTerminalAttempt = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
): Promise<void> => {
  await database
    .prepare(`DELETE FROM telemetry_pending_archive_uploads
    WHERE organization_id = ? AND archive_id = ? AND state = 'cleaned'
      AND cleanup_lease_id IS NULL
      AND (
        (
          upload_claimed_ever = 0
          AND upload_lease_id IS NULL
          AND upload_watch_required = 0
          AND upload_writer_state = 'unresolved'
          AND upload_writer_terminated_at IS NULL
        )
        OR (
          upload_claimed_ever = 1
          AND upload_lease_id IS NULL
          AND upload_watch_required = 0
          AND upload_writer_state = 'terminated'
          AND upload_writer_terminated_at IS NOT NULL
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM telemetry_ingestion_receipts receipt
        WHERE receipt.organization_id = telemetry_pending_archive_uploads.organization_id
          AND receipt.node_id = telemetry_pending_archive_uploads.node_id
          AND receipt.server_id = telemetry_pending_archive_uploads.server_id
          AND receipt.deployment_id = telemetry_pending_archive_uploads.deployment_id
          AND receipt.stream_epoch = telemetry_pending_archive_uploads.stream_epoch
          AND receipt.archive_id = telemetry_pending_archive_uploads.archive_id
      )
      AND EXISTS (
        SELECT 1 FROM telemetry_log_epoch_reservations reservation
        WHERE reservation.organization_id = telemetry_pending_archive_uploads.organization_id
          AND reservation.node_id = telemetry_pending_archive_uploads.node_id
          AND reservation.server_id = telemetry_pending_archive_uploads.server_id
          AND reservation.deployment_id = telemetry_pending_archive_uploads.deployment_id
          AND reservation.stream_epoch = telemetry_pending_archive_uploads.stream_epoch
          AND reservation.archive_attempt_generation = telemetry_pending_archive_uploads.archive_generation
          AND reservation.archive_attempt_count = telemetry_pending_archive_uploads.archive_generation + 1
          AND reservation.archive_retry_state IN ('backoff', 'quarantined')
      )`)
    .bind(archive.organizationId, archive.archiveId)
    .run()
}

const finalizeCleanedAttempt = async (
  database: TelemetryArchiveReconciliationDatabase,
  archive: PendingArchiveUpload,
  now: string,
): Promise<TelemetryArchiveReconciliationResult> => {
  if (
    archive.uploadClaimedEver === 1 &&
    (archive.uploadWriterState !== 'terminated' || archive.uploadWriterTerminatedAt === null)
  )
    return { disposition: 'retry', archive }
  if (!(await recordRetryOutcome(database, archive, now))) return { disposition: 'retry', archive }
  await compactTerminalAttempt(database, archive)
  return { disposition: 'cleaned', archive }
}

export const reconcilePendingTelemetryArchive = async (
  database: TelemetryArchiveReconciliationDatabase,
  bucket: TelemetryArchiveReconciliationBucket,
  value: unknown,
  now: string,
): Promise<TelemetryArchiveReconciliationResult> => {
  const archive = decodePendingArchive(value)
  if (archive === undefined) return { disposition: 'retry' }
  try {
    if (archive.state === 'cleaned') return await finalizeCleanedAttempt(database, archive, now)
    const lease = await claimCleanupLease(database, archive, now)
    if (lease === undefined) {
      // A final receipt won the D1 race, or another cleanup Worker already
      // owns the identity. Either outcome must leave the R2 object untouched.
      if (await receiptAccepted(database, archive)) {
        await markReceiptAccepted(database, archive, now)
        return { disposition: 'accepted', archive }
      }
      return { disposition: 'retry', archive }
    }
    if (await receiptAccepted(database, archive)) {
      await releaseCleanupLease(database, archive, lease, now)
      await markReceiptAccepted(database, archive, now)
      return { disposition: 'accepted', archive }
    }
    const object = await bucket.head(archive.r2Key)
    if (object === null) {
      if (!(await finishCleanup(database, archive, lease, now)))
        return { disposition: 'retry', archive }
      const cleaned = { ...archive, state: 'cleaned' as const }
      return finalizeCleanedAttempt(database, cleaned, now)
    }
    if (!exactR2Identity(archive, object)) {
      await releaseCleanupLease(database, archive, lease, now)
      return { disposition: 'preserved-conflict', archive }
    }
    // Do not let a delayed/stale scheduled Worker delete an object after its
    // ownership window changed. The receipt guard in migration 0045 prevents
    // final acceptance while this proven lease remains active.
    if (!(await ownsCleanupLease(database, archive, lease, now)))
      return { disposition: 'retry', archive }
    if (await receiptAccepted(database, archive)) {
      await releaseCleanupLease(database, archive, lease, now)
      await markReceiptAccepted(database, archive, now)
      return { disposition: 'accepted', archive }
    }
    await bucket.delete(archive.r2Key)
    if (!(await finishCleanup(database, archive, lease, now)))
      return { disposition: 'retry', archive }
    const cleaned = { ...archive, state: 'cleaned' as const }
    return await finalizeCleanedAttempt(database, cleaned, now)
  } catch {
    return { disposition: 'retry', archive }
  }
}

export const reconcilePendingTelemetryArchives = async (
  database: TelemetryArchiveReconciliationDatabase,
  bucket: TelemetryArchiveReconciliationBucket,
  scheduledAt: number,
  limit = 50,
): Promise<ReadonlyArray<TelemetryArchiveReconciliationResult>> => {
  const now = new Date(scheduledAt).toISOString()
  try {
    const page = await database
      .prepare(`SELECT organization_id AS organizationId,
      archive_id AS archiveId, archive_base_id AS archiveBaseId,
      archive_generation AS archiveGeneration, node_id AS nodeId, server_id AS serverId,
      deployment_id AS deploymentId, stream_epoch AS streamEpoch, r2_key AS r2Key,
      sha256, compressed_sha256 AS compressedSha256, entry_count AS entryCount,
      uncompressed_bytes AS uncompressedBytes, compressed_bytes AS compressedBytes,
      state, upload_lease_id AS uploadLeaseId, upload_claimed_at AS uploadClaimedAt,
      upload_lease_expires_at AS uploadLeaseExpiresAt,
      upload_claimed_ever AS uploadClaimedEver,
      upload_watch_after AS uploadWatchAfter, upload_watch_until AS uploadWatchUntil,
      upload_watch_required AS uploadWatchRequired,
      upload_writer_state AS uploadWriterState,
      upload_writer_terminated_at AS uploadWriterTerminatedAt
    FROM telemetry_pending_archive_uploads
      WHERE (
        state = 'pending' AND (
          (upload_claimed_ever = 0 AND cleanup_after <= ?)
          OR (
            upload_claimed_ever = 1
            AND upload_writer_state = 'terminated'
            AND upload_writer_terminated_at IS NOT NULL
            AND upload_lease_id IS NULL
            AND upload_watch_required = 0
          )
        )
      ) OR (
        state = 'cleaned' AND (
          upload_claimed_ever = 0
          OR (
            upload_claimed_ever = 1
            AND upload_writer_state = 'terminated'
            AND upload_writer_terminated_at IS NOT NULL
            AND upload_lease_id IS NULL
            AND upload_watch_required = 0
          )
        )
      )
      ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END,
        CASE WHEN upload_claimed_ever = 0 THEN 0 ELSE 1 END,
        cleanup_after ASC, organization_id ASC, archive_id ASC
      LIMIT ?`)
      .bind(now, limit)
      .all()
    const outcomes: TelemetryArchiveReconciliationResult[] = []
    for (const row of page.results)
      outcomes.push(await reconcilePendingTelemetryArchive(database, bucket, row, now))
    return outcomes
  } catch {
    return [{ disposition: 'retry' }]
  }
}

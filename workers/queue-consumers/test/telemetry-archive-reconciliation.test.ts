import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  reconcilePendingTelemetryArchive,
  reconcilePendingTelemetryArchives,
  type TelemetryArchiveReconciliationBucket,
  type TelemetryArchiveReconciliationDatabase,
  type TelemetryArchiveReconciliationStatement,
} from '../src/telemetry-archive-reconciliation.js'

class Statement implements TelemetryArchiveReconciliationStatement {
  #values: ReadonlyArray<unknown> = []

  constructor(
    readonly statement: StatementSync,
    readonly afterRun?: () => void,
  ) {}

  bind(...values: ReadonlyArray<unknown>): TelemetryArchiveReconciliationStatement {
    this.#values = values
    return this
  }

  all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return Promise.resolve({
      results: this.statement.all(...(this.#values as ReadonlyArray<SQLInputValue>)),
    })
  }

  first(): Promise<unknown> {
    return Promise.resolve(
      this.statement.get(...(this.#values as ReadonlyArray<SQLInputValue>)) ?? null,
    )
  }

  run(): Promise<unknown> {
    const result = this.statement.run(...(this.#values as ReadonlyArray<SQLInputValue>))
    this.afterRun?.()
    return Promise.resolve(result)
  }
}

class SqliteDatabase implements TelemetryArchiveReconciliationDatabase {
  throwAfterRetryOutcomeCommit = false

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): TelemetryArchiveReconciliationStatement {
    return new Statement(
      this.database.prepare(sql),
      sql.includes('SET archive_retry_state = ?, archive_retry_after = ?, updated_at = ?')
        ? () => {
            if (!this.throwAfterRetryOutcomeCommit) return
            this.throwAfterRetryOutcomeCommit = false
            throw new Error('simulated retry-ledger response loss after commit')
          }
        : undefined,
    )
  }
}

interface StoredObject {
  readonly key: string
  readonly size: number
  readonly customMetadata: Readonly<Record<string, string>>
}

class Bucket implements TelemetryArchiveReconciliationBucket {
  readonly objects = new Map<string, StoredObject>()
  readonly deleted: string[] = []

  constructor(...objects: ReadonlyArray<StoredObject>) {
    for (const object of objects) this.objects.set(object.key, object)
  }

  head(key: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(key) ?? null)
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key)
    this.objects.delete(key)
  }
}

const migrationPaths = [
  fileURLToPath(
    new URL(
      '../../../packages/migrations/sql/0045_telemetry_archive_cleanup_lease.sql',
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      '../../../packages/migrations/sql/0046_telemetry_archive_generation_fence.sql',
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      '../../../packages/migrations/sql/0055_telemetry_archive_upload_watch_fence.sql',
      import.meta.url,
    ),
  ),
]

const now = '2026-08-23T12:10:00.000Z'

interface ArchiveCandidate {
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
}

const archive = (suffix = 'a', generation = 0): ArchiveCandidate => {
  const archiveBaseId = `archive-${suffix}`
  const archiveId = generation === 0 ? archiveBaseId : `${archiveBaseId}_g${generation}`
  const serverId = `server-${suffix}`
  const deploymentId = `deployment-${suffix}`
  return {
    organizationId: 'org-a',
    archiveId,
    archiveBaseId,
    archiveGeneration: generation,
    nodeId: 'node-a',
    serverId,
    deploymentId,
    streamEpoch: deploymentId,
    r2Key: `organizations/org-a/logs/${serverId}/epochs/${deploymentId}/2026-08-23/${archiveId}.ndjson.gz`,
    sha256: `sha256:${'a'.repeat(64)}`,
    compressedSha256: `sha256:${'b'.repeat(64)}`,
    entryCount: 1,
    uncompressedBytes: 10,
    compressedBytes: 20,
  }
}

const object = (candidate: ArchiveCandidate): StoredObject => ({
  key: candidate.r2Key,
  size: candidate.compressedBytes,
  customMetadata: {
    organizationId: candidate.organizationId,
    nodeId: candidate.nodeId,
    serverId: candidate.serverId,
    archiveId: candidate.archiveId,
    archiveGeneration: String(candidate.archiveGeneration),
    streamEpoch: candidate.streamEpoch,
    sha256: candidate.sha256,
    compressedSha256: candidate.compressedSha256,
    entryCount: String(candidate.entryCount),
    uncompressedBytes: String(candidate.uncompressedBytes),
    compressedBytes: String(candidate.compressedBytes),
  },
})

let raw: DatabaseSync
let database: SqliteDatabase

const reservationFingerprint = (value: string): string =>
  `${value.replace(/[^a-f0-9]/gi, 'a').toLowerCase()}${'b'.repeat(64)}`.slice(0, 64)

const insertReservation = (candidate: ArchiveCandidate, sequence = 1) => {
  raw
    .prepare(`INSERT INTO telemetry_log_epoch_reservations
    (organization_id, node_id, server_id, deployment_id, stream_epoch,
     first_sequence, last_sequence, log_fingerprint, archive_base_id, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
    .run(
      candidate.organizationId,
      candidate.nodeId,
      candidate.serverId,
      candidate.deploymentId,
      candidate.streamEpoch,
      sequence,
      sequence,
      reservationFingerprint(`${candidate.archiveBaseId}${sequence}`),
      candidate.archiveBaseId,
      now,
      now,
    )
}

const insertPending = (
  candidate: ArchiveCandidate,
  cleanupAfter = '2026-08-23T13:10:00.000Z',
  sequence = 1,
) => {
  insertReservation(candidate, sequence)
  raw
    .prepare(`INSERT INTO telemetry_pending_archive_uploads
    (organization_id, archive_id, archive_base_id, archive_generation,
     node_id, server_id, deployment_id, stream_epoch, r2_key,
     sha256, compressed_sha256, entry_count, uncompressed_bytes, compressed_bytes,
     state, created_at, updated_at, cleanup_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .run(
      candidate.organizationId,
      candidate.archiveId,
      candidate.archiveBaseId,
      candidate.archiveGeneration,
      candidate.nodeId,
      candidate.serverId,
      candidate.deploymentId,
      candidate.streamEpoch,
      candidate.r2Key,
      candidate.sha256,
      candidate.compressedSha256,
      candidate.entryCount,
      candidate.uncompressedBytes,
      candidate.compressedBytes,
      now,
      now,
      cleanupAfter,
    )
  raw
    .prepare(`UPDATE telemetry_log_epoch_reservations
    SET archive_attempt_count = 1, updated_at = ?
    WHERE organization_id = ? AND server_id = ? AND stream_epoch = ?
      AND archive_base_id = ?`)
    .run(
      now,
      candidate.organizationId,
      candidate.serverId,
      candidate.streamEpoch,
      candidate.archiveBaseId,
    )
}

const insertReceipt = (candidate: ArchiveCandidate) => {
  raw
    .prepare(`INSERT INTO telemetry_ingestion_receipts
    (organization_id, node_id, server_id, deployment_id, stream_epoch, archive_id,
     archive_r2_key, archive_sha256, archive_entry_count, archive_uncompressed_bytes,
     archive_compressed_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      candidate.organizationId,
      candidate.nodeId,
      candidate.serverId,
      candidate.deploymentId,
      candidate.streamEpoch,
      candidate.archiveId,
      candidate.r2Key,
      candidate.sha256,
      candidate.entryCount,
      candidate.uncompressedBytes,
      candidate.compressedBytes,
    )
}

const claimAndTerminateUpload = (
  candidate: ArchiveCandidate,
  claimedAt = now,
  expiresAt = '2026-08-23T12:12:00.000Z',
  terminatedAt = '2026-08-23T12:10:01.000Z',
) => {
  raw
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET upload_lease_id = ?, upload_claimed_at = ?, upload_lease_expires_at = ?,
        upload_claimed_ever = 1, upload_watch_after = ?, upload_watch_until = NULL,
        upload_watch_required = 1, updated_at = ?
    WHERE organization_id = ? AND archive_id = ?`)
    .run(
      'upload-owner-00000000000000000001',
      claimedAt,
      expiresAt,
      expiresAt,
      claimedAt,
      candidate.organizationId,
      candidate.archiveId,
    )
  raw
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET upload_lease_id = NULL, upload_watch_required = 0,
        upload_writer_state = 'terminated', upload_writer_terminated_at = ?, updated_at = ?
    WHERE organization_id = ? AND archive_id = ?`)
    .run(terminatedAt, terminatedAt, candidate.organizationId, candidate.archiveId)
}

const claimUnresolvedUpload = (candidate: ArchiveCandidate) => {
  raw
    .prepare(`UPDATE telemetry_pending_archive_uploads
    SET upload_lease_id = ?, upload_claimed_at = ?, upload_lease_expires_at = ?,
        upload_claimed_ever = 1, upload_watch_after = ?, upload_watch_until = NULL,
        upload_watch_required = 1, updated_at = ?
    WHERE organization_id = ? AND archive_id = ?`)
    .run(
      'upload-owner-00000000000000000002',
      now,
      '2026-08-23T12:12:00.000Z',
      '2026-08-23T12:12:00.000Z',
      now,
      candidate.organizationId,
      candidate.archiveId,
    )
}

const storedArchive = (candidate: ArchiveCandidate): unknown =>
  raw
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
    WHERE organization_id = ? AND archive_id = ?`)
    .get(candidate.organizationId, candidate.archiveId)

beforeEach(() => {
  raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE telemetry_pending_archive_uploads (
      organization_id TEXT NOT NULL,
      archive_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      stream_epoch TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      compressed_sha256 TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      uncompressed_bytes INTEGER NOT NULL,
      compressed_bytes INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'cleaned')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cleanup_after TEXT NOT NULL,
      PRIMARY KEY (organization_id, archive_id)
    ) STRICT;
    CREATE TABLE telemetry_ingestion_receipts (
      organization_id TEXT NOT NULL,
      id TEXT,
      node_id TEXT NOT NULL,
      server_id TEXT,
      deployment_id TEXT,
      stream_epoch TEXT,
      archive_id TEXT,
      archive_r2_key TEXT,
      archive_sha256 TEXT,
      archive_entry_count INTEGER,
      archive_uncompressed_bytes INTEGER,
      archive_compressed_bytes INTEGER,
      accepted_at TEXT
    ) STRICT;
    CREATE TABLE telemetry_log_epoch_reservations (
      organization_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      stream_epoch TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      log_fingerprint TEXT NOT NULL,
      archive_base_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, server_id, stream_epoch, first_sequence)
    ) STRICT;
    CREATE TRIGGER telemetry_pending_archive_immutable_update
    BEFORE UPDATE ON telemetry_pending_archive_uploads BEGIN SELECT 1; END;
  `)
  for (const migrationPath of migrationPaths) raw.exec(readFileSync(migrationPath, 'utf8'))
  database = new SqliteDatabase(raw)
})

afterEach(() => raw.close())

describe('telemetry archive reconciliation', () => {
  it('never deletes an exact object once its final receipt has committed', async () => {
    const candidate = archive()
    insertPending(candidate)
    insertReceipt(candidate)
    const bucket = new Bucket(object(candidate))

    await expect(
      reconcilePendingTelemetryArchive(database, bucket, storedArchive(candidate), now),
    ).resolves.toMatchObject({ disposition: 'accepted' })
    expect(bucket.deleted).toEqual([])
    expect(raw.prepare(`SELECT state FROM telemetry_pending_archive_uploads`).get()).toEqual({
      state: 'accepted',
    })
  })

  it('does not clean an expired unresolved upload owner: expiry is not writer termination proof', async () => {
    const candidate = archive()
    insertPending(candidate)
    claimUnresolvedUpload(candidate)
    const bucket = new Bucket()

    await expect(
      reconcilePendingTelemetryArchive(
        database,
        bucket,
        storedArchive(candidate),
        '2026-08-23T12:13:00.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'retry' })
    expect(bucket.deleted).toEqual([])
    expect(
      raw
        .prepare(`SELECT state, upload_lease_id AS uploadLeaseId,
        upload_writer_state AS uploadWriterState, upload_watch_required AS uploadWatchRequired
        FROM telemetry_pending_archive_uploads`)
        .get(),
    ).toEqual({
      state: 'pending',
      uploadLeaseId: 'upload-owner-00000000000000000002',
      uploadWriterState: 'unresolved',
      uploadWatchRequired: 1,
    })
  })

  it('cleans only a terminal writer, then compacts it into the bounded retry ledger', async () => {
    const candidate = archive()
    insertPending(candidate)
    claimAndTerminateUpload(candidate)
    const bucket = new Bucket(object(candidate))

    await expect(
      reconcilePendingTelemetryArchive(
        database,
        bucket,
        storedArchive(candidate),
        '2026-08-23T12:10:02.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'cleaned' })
    expect(bucket.deleted).toEqual([candidate.r2Key])
    expect(
      raw.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
    expect(
      raw
        .prepare(`SELECT archive_attempt_generation AS generation,
        archive_attempt_count AS count, archive_retry_state AS retryState,
        archive_retry_after AS retryAfter FROM telemetry_log_epoch_reservations`)
        .get(),
    ).toEqual({
      generation: 0,
      count: 1,
      retryState: 'backoff',
      retryAfter: '2026-08-23T12:10:32.000Z',
    })
  })

  it('adopts an exact committed retry decision after response loss and compacts the cleaned row', async () => {
    const candidate = archive()
    insertPending(candidate)
    claimAndTerminateUpload(candidate)
    const bucket = new Bucket(object(candidate))
    database.throwAfterRetryOutcomeCommit = true

    await expect(
      reconcilePendingTelemetryArchive(
        database,
        bucket,
        storedArchive(candidate),
        '2026-08-23T12:10:02.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'retry' })
    expect(raw.prepare(`SELECT state FROM telemetry_pending_archive_uploads`).get()).toEqual({
      state: 'cleaned',
    })
    expect(
      raw
        .prepare(`SELECT archive_retry_state AS retryState,
        archive_retry_after AS retryAfter FROM telemetry_log_epoch_reservations`)
        .get(),
    ).toEqual({
      retryState: 'backoff',
      retryAfter: '2026-08-23T12:10:32.000Z',
    })

    await expect(
      reconcilePendingTelemetryArchive(
        database,
        bucket,
        storedArchive(candidate),
        '2026-08-23T12:11:02.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'cleaned' })
    expect(
      raw.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
    expect(
      raw
        .prepare(`SELECT archive_retry_state AS retryState,
        archive_retry_after AS retryAfter FROM telemetry_log_epoch_reservations`)
        .get(),
    ).toEqual({
      retryState: 'backoff',
      retryAfter: '2026-08-23T12:10:32.000Z',
    })
  })

  it('bounds failed-operation storage at 32 reservations and still schedules pending R2-outage work ahead of cleaned rows', async () => {
    const candidates = Array.from({ length: 32 }, (_, index) => archive(`${index}`))
    for (const [index, candidate] of candidates.entries()) {
      insertPending(candidate, now, index + 1)
      if (index < 31)
        raw
          .prepare(`UPDATE telemetry_pending_archive_uploads
          SET state = 'cleaned', updated_at = ?
          WHERE organization_id = ? AND archive_id = ?`)
          .run(now, candidate.organizationId, candidate.archiveId)
    }
    const bucket = new Bucket()

    const first = await reconcilePendingTelemetryArchives(database, bucket, Date.parse(now), 1)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      disposition: 'cleaned',
      archive: { archiveId: candidates[31]!.archiveId },
    })
    expect(
      raw
        .prepare(`SELECT archive_retry_state AS retryState FROM telemetry_log_epoch_reservations
        WHERE archive_base_id = ?`)
        .get(candidates[31]!.archiveBaseId),
    ).toEqual({ retryState: 'backoff' })

    await reconcilePendingTelemetryArchives(database, bucket, Date.parse(now), 50)
    expect(
      raw.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
    expect(
      raw.prepare(`SELECT count(*) AS count FROM telemetry_log_epoch_reservations`).get(),
    ).toEqual({ count: 32 })
    expect(() => insertReservation(archive('overflow'), 1)).toThrow(
      /telemetry unfinished archive fleet is saturated/,
    )
  })
})

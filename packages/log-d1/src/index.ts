import { Effect, Layer } from 'effect'
import { LogArchiveRepository, LogPersistenceError, LOG_LIMITS } from '@gridora/log-control'
import type {
  LogArchiveMetadata,
  LogArchivePage,
  LogArchiveRepositoryShape,
} from '@gridora/log-control'

export interface LogD1Result {
  readonly success?: boolean
  readonly meta?: { readonly changes?: number }
}
export interface LogD1AllResult {
  readonly results: ReadonlyArray<unknown>
}
export interface LogD1Statement {
  bind(...values: ReadonlyArray<unknown>): LogD1Statement
  first(): Promise<unknown>
  all(): Promise<LogD1AllResult>
  run(): Promise<LogD1Result>
}
export interface LogD1Database {
  prepare(sql: string): LogD1Statement
}

const persistence = (operation: string, cause: unknown) =>
  new LogPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const safeTimestamp = (value: string): boolean =>
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
const integer = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isSafeInteger(row[key]) ? row[key] : undefined
const nullableText = (row: Record<string, unknown>, key: string): string | null | undefined =>
  row[key] === null ? null : text(row, key)

const archiveSelect = `SELECT organization_id AS organizationId, id, server_id AS serverId,
  node_id AS nodeId, stream_epoch AS streamEpoch, r2_key AS r2Key, compression, first_timestamp AS firstTimestamp,
  last_timestamp AS lastTimestamp, entry_count AS entryCount,
  uncompressed_bytes AS uncompressedBytes, compressed_bytes AS compressedBytes,
  sha256, state, created_at AS createdAt, expires_at AS expiresAt
FROM log_archives`

const decodeMetadata = (value: unknown): LogArchiveMetadata | undefined => {
  const row = object(value)
  if (row === undefined) return undefined
  const organizationId = text(row, 'organizationId')
  const id = text(row, 'id')
  const serverId = text(row, 'serverId')
  const nodeId = text(row, 'nodeId')
  const streamEpoch = row.streamEpoch === null ? undefined : text(row, 'streamEpoch')
  const r2Key = text(row, 'r2Key')
  const compression = text(row, 'compression')
  const firstTimestamp = text(row, 'firstTimestamp')
  const lastTimestamp = text(row, 'lastTimestamp')
  const entryCount = integer(row, 'entryCount')
  const uncompressedBytes = integer(row, 'uncompressedBytes')
  const compressedBytes = integer(row, 'compressedBytes')
  const sha256 = text(row, 'sha256')
  const state = text(row, 'state')
  const createdAt = text(row, 'createdAt')
  const expiresAt = nullableText(row, 'expiresAt')
  if (
    organizationId === undefined ||
    id === undefined ||
    serverId === undefined ||
    nodeId === undefined ||
    r2Key === undefined ||
    compression !== 'gzip' ||
    firstTimestamp === undefined ||
    lastTimestamp === undefined ||
    entryCount === undefined ||
    uncompressedBytes === undefined ||
    compressedBytes === undefined ||
    sha256 === undefined ||
    (state !== 'pending' &&
      state !== 'available' &&
      state !== 'expired' &&
      state !== 'deleted' &&
      state !== 'failed') ||
    createdAt === undefined ||
    expiresAt === undefined
  )
    return undefined
  return {
    organizationId,
    id,
    serverId,
    nodeId,
    ...(streamEpoch === undefined ? {} : { streamEpoch }),
    r2Key,
    compression,
    firstTimestamp,
    lastTimestamp,
    entryCount,
    uncompressedBytes,
    compressedBytes,
    sha256,
    state,
    createdAt,
    expiresAt,
  } as LogArchiveMetadata
}

const sameMetadata = (left: LogArchiveMetadata, right: LogArchiveMetadata): boolean =>
  left.organizationId === right.organizationId &&
  left.id === right.id &&
  left.serverId === right.serverId &&
  left.nodeId === right.nodeId &&
  left.streamEpoch === right.streamEpoch &&
  left.r2Key === right.r2Key &&
  left.compression === right.compression &&
  left.firstTimestamp === right.firstTimestamp &&
  left.lastTimestamp === right.lastTimestamp &&
  left.entryCount === right.entryCount &&
  left.uncompressedBytes === right.uncompressedBytes &&
  left.compressedBytes === right.compressedBytes &&
  left.sha256 === right.sha256 &&
  left.createdAt === right.createdAt &&
  left.expiresAt === right.expiresAt

const readOne = (database: LogD1Database, organizationId: string, archiveId: string) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`${archiveSelect} WHERE organization_id = ? AND id = ?`)
        .bind(organizationId, archiveId)
        .first(),
    catch: (cause) => persistence('logs.archive.read', cause),
  }).pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null)
      const decoded = decodeMetadata(value)
      return decoded === undefined
        ? Effect.fail(persistence('logs.archive.decode', 'Stored log archive metadata is invalid'))
        : Effect.succeed(decoded)
    }),
  )

export const makeLogArchiveRepositoryD1 = (database: LogD1Database): LogArchiveRepositoryShape => ({
  record: (metadata) =>
    Effect.gen(function* () {
      if (
        metadata.entryCount > LOG_LIMITS.maximumArchiveEntries ||
        metadata.uncompressedBytes > LOG_LIMITS.maximumArchiveBytes ||
        metadata.compressedBytes > LOG_LIMITS.maximumArchiveBytes
      )
        return yield* persistence(
          'logs.archive.record',
          'Archive metadata exceeds configured limits',
        )
      const result = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`INSERT INTO log_archives
          (organization_id, id, server_id, node_id, stream_epoch, r2_key, compression, first_timestamp,
           last_timestamp, entry_count, uncompressed_bytes, compressed_bytes, sha256,
           state, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, 'gzip', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (organization_id, id) DO NOTHING`)
            .bind(
              metadata.organizationId,
              metadata.id,
              metadata.serverId,
              metadata.nodeId,
              metadata.streamEpoch ?? null,
              metadata.r2Key,
              metadata.firstTimestamp,
              metadata.lastTimestamp,
              metadata.entryCount,
              metadata.uncompressedBytes,
              metadata.compressedBytes,
              metadata.sha256,
              metadata.state,
              metadata.createdAt,
              metadata.expiresAt,
            )
            .run(),
        catch: (cause) => persistence('logs.archive.record', cause),
      })
      const stored = yield* readOne(database, metadata.organizationId, metadata.id)
      if (stored === null)
        return yield* persistence('logs.archive.record', 'Archive metadata was not committed')
      if (result.meta?.changes === 0 && !sameMetadata(stored, metadata))
        return yield* persistence(
          'logs.archive.record',
          'Archive idempotency key was reused with different metadata',
        )
      return stored
    }),
  get: (organizationId, archiveId) => readOne(database, organizationId, archiveId),
  list: (request, cursor) =>
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > LOG_LIMITS.maximumPageSize
      )
        return yield* persistence('logs.archive.list', 'Archive page size is invalid')
      if (
        (request.from !== undefined && !safeTimestamp(request.from)) ||
        (request.to !== undefined && !safeTimestamp(request.to))
      )
        return yield* persistence('logs.archive.list', 'Archive time range is invalid')
      if (
        request.from !== undefined &&
        request.to !== undefined &&
        (request.to < request.from ||
          Date.parse(request.to) - Date.parse(request.from) >
            LOG_LIMITS.maximumTimeRangeMilliseconds)
      )
        return yield* persistence('logs.archive.list', 'Archive time range is invalid')
      if (
        cursor !== undefined &&
        (!safeTimestamp(cursor.lastTimestamp) ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(cursor.lastId))
      )
        return yield* persistence('logs.archive.list', 'Archive cursor is invalid')
      const values: unknown[] = [request.organizationId, request.serverId]
      const predicates = ['organization_id = ?', 'server_id = ?', "state <> 'deleted'"]
      if (request.from !== undefined) {
        predicates.push('last_timestamp >= ?')
        values.push(request.from)
      }
      if (request.to !== undefined) {
        predicates.push('first_timestamp <= ?')
        values.push(request.to)
      }
      if (cursor !== undefined) {
        predicates.push('(last_timestamp < ? OR (last_timestamp = ? AND id < ?))')
        values.push(cursor.lastTimestamp, cursor.lastTimestamp, cursor.lastId)
      }
      values.push(request.limit + 1)
      const result = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`${archiveSelect}
          WHERE ${predicates.join(' AND ')}
          ORDER BY last_timestamp DESC, id DESC LIMIT ?`)
            .bind(...values)
            .all(),
        catch: (cause) => persistence('logs.archive.list', cause),
      })
      const decoded: LogArchiveMetadata[] = []
      for (const row of result.results) {
        const metadata = decodeMetadata(row)
        if (metadata === undefined)
          return yield* persistence(
            'logs.archive.list.decode',
            'Stored log archive metadata is invalid',
          )
        decoded.push(metadata)
      }
      const truncated = decoded.length > request.limit
      const items = truncated ? decoded.slice(0, request.limit) : decoded
      const last = items.at(-1)
      return {
        items,
        ...(truncated && last !== undefined
          ? { nextCursor: { lastTimestamp: last.lastTimestamp, lastId: last.id } }
          : {}),
      } satisfies LogArchivePage
    }),
  expire: (organizationId, now, limit) =>
    !Number.isSafeInteger(limit) || limit < 1 || limit > LOG_LIMITS.maximumPageSize
      ? Effect.fail(
          new LogPersistenceError({
            operation: 'logs.archive.expire',
            message: 'Archive expiration limit is invalid',
          }),
        )
      : Effect.tryPromise({
          try: () =>
            database
              .prepare(`UPDATE log_archives SET state = 'expired'
        WHERE organization_id = ? AND state = 'available' AND expires_at IS NOT NULL AND expires_at <= ?
          AND id IN (SELECT id FROM log_archives WHERE organization_id = ? AND state = 'available'
            AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC, id ASC LIMIT ?)`)
              .bind(organizationId, now, organizationId, now, limit)
              .run(),
          catch: (cause) => persistence('logs.archive.expire', cause),
        }).pipe(Effect.map((result) => result.meta?.changes ?? 0)),
  advanceWatermark: (input) =>
    Effect.gen(function* () {
      if (
        input.firstSequence < 1 ||
        input.lastSequence < input.firstSequence ||
        !safeTimestamp(input.lastTimestamp) ||
        input.fingerprint.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(input.fingerprint)
      )
        return yield* persistence('logs.watermark.validate', 'Log watermark input is invalid')
      const read = () =>
        database
          .prepare(`SELECT organization_id AS organizationId, node_id AS nodeId,
        last_sequence AS lastSequence, last_timestamp AS lastTimestamp, last_fingerprint AS lastFingerprint,
        revision FROM log_stream_watermarks WHERE organization_id = ? AND node_id = ?`)
          .bind(input.organizationId, input.nodeId)
          .first()
      const currentValue = yield* Effect.tryPromise({
        try: read,
        catch: (cause) => persistence('logs.watermark.read', cause),
      })
      const current = object(currentValue)
      if (current === undefined) {
        if (input.firstSequence !== 1)
          return yield* persistence(
            'logs.watermark.advance',
            'Log sequence has a gap before the first batch',
          )
        const inserted = yield* Effect.tryPromise({
          try: () =>
            database
              .prepare(`INSERT INTO log_stream_watermarks
            (organization_id, node_id, last_sequence, last_timestamp, last_fingerprint, revision)
            VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (organization_id, node_id) DO NOTHING`)
              .bind(
                input.organizationId,
                input.nodeId,
                input.lastSequence,
                input.lastTimestamp,
                input.fingerprint,
              )
              .run(),
          catch: (cause) => persistence('logs.watermark.insert', cause),
        })
        if ((inserted.meta?.changes ?? 0) === 1) return { accepted: true, replayed: false }
      }
      const storedValue = yield* Effect.tryPromise({
        try: read,
        catch: (cause) => persistence('logs.watermark.reread', cause),
      })
      const stored = object(storedValue)
      const lastSequence = stored?.lastSequence
      const revision = stored?.revision
      const lastFingerprint = stored?.lastFingerprint
      const lastTimestamp = stored?.lastTimestamp
      if (
        typeof lastSequence !== 'number' ||
        typeof revision !== 'number' ||
        typeof lastFingerprint !== 'string' ||
        typeof lastTimestamp !== 'string' ||
        !safeTimestamp(lastTimestamp)
      )
        return yield* persistence('logs.watermark.decode', 'Stored log watermark is invalid')
      if (
        lastSequence === input.lastSequence &&
        lastFingerprint === input.fingerprint &&
        lastTimestamp === input.lastTimestamp
      )
        return { accepted: false, replayed: true }
      if (input.firstSequence !== lastSequence + 1)
        return yield* persistence(
          'logs.watermark.advance',
          'Log sequence is not the next contiguous batch',
        )
      if (input.lastTimestamp < lastTimestamp)
        return yield* persistence(
          'logs.watermark.advance',
          'Log watermark timestamp moved backwards',
        )
      const updated = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`UPDATE log_stream_watermarks
          SET last_sequence = ?, last_timestamp = ?, last_fingerprint = ?, revision = revision + 1
          WHERE organization_id = ? AND node_id = ? AND revision = ? AND last_sequence = ?`)
            .bind(
              input.lastSequence,
              input.lastTimestamp,
              input.fingerprint,
              input.organizationId,
              input.nodeId,
              revision,
              lastSequence,
            )
            .run(),
        catch: (cause) => persistence('logs.watermark.advance', cause),
      })
      if ((updated.meta?.changes ?? 0) === 1) return { accepted: true, replayed: false }
      const after = yield* Effect.tryPromise({
        try: read,
        catch: (cause) => persistence('logs.watermark.conflict-read', cause),
      })
      const afterRow = object(after)
      if (
        afterRow?.lastSequence === input.lastSequence &&
        afterRow.lastFingerprint === input.fingerprint &&
        afterRow.lastTimestamp === input.lastTimestamp
      )
        return { accepted: false, replayed: true }
      return yield* persistence(
        'logs.watermark.advance',
        'Concurrent log batch changed the watermark',
      )
    }),
})

export const LogArchiveRepositoryD1Live = (database: LogD1Database) =>
  Layer.succeed(LogArchiveRepository, makeLogArchiveRepositoryD1(database))

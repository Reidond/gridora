import { Effect, Result, Schema } from 'effect'
import {
  LOG_LIMITS,
  LogValidationError,
  logArchiveObjectKey,
  makeLogBatch,
  sanitizeLogEntry,
} from '@gridora/log-control'
import type { LogArchiveMetadata, LogBatch, LogEntry } from '@gridora/log-control'

export interface LogR2ObjectInfo {
  readonly key: string
  readonly size: number
  readonly etag: string
  readonly customMetadata: Readonly<Record<string, string>>
}
export interface LogR2ObjectBody extends LogR2ObjectInfo {
  readonly body: ReadableStream<Uint8Array>
}
export interface LogR2BucketShape {
  readonly head: (key: string) => Promise<LogR2ObjectInfo | null>
  readonly get: (key: string) => Promise<LogR2ObjectBody | null>
  readonly put: (
    key: string,
    value: Uint8Array,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>
      readonly onlyIfAbsent: boolean
    },
  ) => Promise<LogR2ObjectInfo>
  /**
   * Optional deadline-aware write boundary. Callers that require a hard
   * cancellation proof must fail closed when this adapter is unavailable.
   */
  readonly putAbortable?: (
    key: string,
    value: Uint8Array,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>
      readonly onlyIfAbsent: boolean
      readonly signal: AbortSignal
    },
  ) => Promise<LogR2ObjectInfo>
  readonly delete: (key: string) => Promise<void>
}

export class LogR2Error extends Schema.TaggedError<LogR2Error>()('LogR2Error', {
  code: Schema.Literals([
    'invalid-input',
    'size-limit',
    'not-found',
    'ownership-denied',
    'conflict',
    'upload-uncertain',
    'transport-failed',
    'integrity-failed',
  ]),
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface ArchivedLogBatch {
  readonly metadata: LogArchiveMetadata
  readonly adopted: boolean
}

/** Canonical bytes are prepared before the upload so callers can durably record an orphan-cleanup intent. */
export interface PreparedLogArchive {
  readonly metadata: LogArchiveMetadata
  readonly compressed: Uint8Array
  readonly customMetadata: Readonly<Record<string, string>>
}

const textEncoder = new TextEncoder()
const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
const sha256 = (bytes: Uint8Array): Effect.Effect<string, LogR2Error> =>
  Effect.tryPromise({
    try: async () =>
      `sha256:${bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(bytes))))}`,
    catch: () =>
      new LogR2Error({
        code: 'transport-failed',
        operation: 'logs.sha256',
        message: 'Log archive digest failed',
      }),
  })

const gzip = (bytes: Uint8Array): Effect.Effect<Uint8Array, LogR2Error> =>
  Effect.tryPromise({
    try: async () => {
      const stream = new Blob([asArrayBuffer(bytes)])
        .stream()
        .pipeThrough(new CompressionStream('gzip'))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    },
    catch: () =>
      new LogR2Error({
        code: 'transport-failed',
        operation: 'logs.compress',
        message: 'Log archive compression failed',
      }),
  })

class StreamLimitError extends Error {}

const readStreamBounded = async (
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new StreamLimitError('log archive is too large')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const gunzipBounded = (bytes: Uint8Array, maximum: number): Effect.Effect<Uint8Array, LogR2Error> =>
  Effect.tryPromise({
    try: async () => {
      const stream = new Blob([asArrayBuffer(bytes)])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'))
      return readStreamBounded(stream, maximum)
    },
    catch: (cause) =>
      cause instanceof StreamLimitError
        ? new LogR2Error({
            code: 'size-limit',
            operation: 'logs.decompress',
            message: 'Archive decompressed size exceeds the configured bound',
          })
        : new LogR2Error({
            code: 'integrity-failed',
            operation: 'logs.decompress',
            message: 'Log archive decompression failed',
          }),
  })

const objectMetadata = (value: unknown): Readonly<Record<string, string>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

const metadataFrom = (
  batch: LogBatch,
  archiveId: string,
  r2Key: string,
  createdAt: string,
  compressedBytes: number,
  digest: string,
  expiresAt: string | null,
  streamEpoch: string | undefined,
): LogArchiveMetadata => ({
  organizationId: batch.organizationId,
  id: archiveId,
  serverId:
    batch.entries[0]?.serverId ??
    (() => {
      throw new Error('archive batch has no server')
    })(),
  nodeId: batch.nodeId,
  ...(streamEpoch === undefined ? {} : { streamEpoch }),
  r2Key,
  compression: 'gzip',
  firstTimestamp: batch.entries.reduce(
    (first, entry) => (entry.timestamp < first ? entry.timestamp : first),
    batch.entries[0]!.timestamp,
  ),
  lastTimestamp: batch.entries.reduce(
    (last, entry) => (entry.timestamp > last ? entry.timestamp : last),
    batch.entries[0]!.timestamp,
  ),
  entryCount: batch.entries.length,
  uncompressedBytes: batch.uncompressedBytes,
  compressedBytes,
  sha256: digest,
  state: 'available',
  createdAt,
  expiresAt,
})

const exactExisting = (
  existing: LogR2ObjectInfo,
  expected: {
    readonly organizationId: string
    readonly serverId: string
    readonly nodeId: string
    readonly archiveId: string
    readonly sha256: string
    readonly uncompressedBytes: number
    readonly entryCount: number
    readonly firstTimestamp: string
    readonly lastTimestamp: string
    readonly compressedBytes: number
    readonly compressedSha256: string
    readonly streamEpoch?: string
    readonly archiveGeneration?: string
  },
): boolean => {
  const metadata = existing.customMetadata
  return (
    metadata.organizationId === expected.organizationId &&
    metadata.serverId === expected.serverId &&
    metadata.nodeId === expected.nodeId &&
    metadata.archiveId === expected.archiveId &&
    metadata.sha256 === expected.sha256 &&
    metadata.uncompressedBytes === String(expected.uncompressedBytes) &&
    metadata.entryCount === String(expected.entryCount) &&
    metadata.firstTimestamp === expected.firstTimestamp &&
    metadata.lastTimestamp === expected.lastTimestamp &&
    metadata.compressedBytes === String(expected.compressedBytes) &&
    metadata.compressedSha256 === expected.compressedSha256 &&
    (expected.streamEpoch === undefined
      ? metadata.streamEpoch === undefined
      : metadata.streamEpoch === expected.streamEpoch) &&
    (expected.archiveGeneration === undefined
      ? metadata.archiveGeneration === undefined
      : metadata.archiveGeneration === expected.archiveGeneration) &&
    existing.size === expected.compressedBytes
  )
}

/**
 * A HEAD metadata match is not enough for response-loss adoption: R2 custom
 * metadata is evidence about an object, not the bytes themselves. Re-read the
 * bounded object and compare its compressed digest to the canonical bytes
 * generated for this request before treating the archive key as adopted.
 */
const exactExistingBytes = (
  bucket: LogR2BucketShape,
  key: string,
  expectedCompressedBytes: number,
  expectedCompressedSha256: string,
): Effect.Effect<boolean, LogR2Error> =>
  Effect.gen(function* () {
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(key),
      catch: () =>
        new LogR2Error({
          code: 'upload-uncertain',
          operation: 'logs.archive.reconcile',
          message: 'Archive bytes cannot be verified for response-loss adoption',
        }),
    })
    if (object === null || object.size !== expectedCompressedBytes) return false
    const compressed = yield* Effect.tryPromise({
      try: () => readStreamBounded(object.body, LOG_LIMITS.maximumArchiveBytes),
      catch: () =>
        new LogR2Error({
          code: 'conflict',
          operation: 'logs.archive.reconcile',
          message: 'Archive object is not bounded canonical gzip evidence',
        }),
    })
    return (
      compressed.byteLength === expectedCompressedBytes &&
      (yield* sha256(compressed)) === expectedCompressedSha256
    )
  })

export const prepareLogArchive = (
  batch: LogBatch,
  input: {
    readonly archiveId: string
    readonly createdAt: string
    readonly expiresAt: string | null
    readonly streamEpoch?: string
    /** Caller-owned immutable retry generation for a distinct R2 attempt. */
    readonly archiveGeneration?: number
  },
): Effect.Effect<PreparedLogArchive, LogR2Error | LogValidationError> =>
  Effect.gen(function* () {
    if (
      input.archiveGeneration !== undefined &&
      (!Number.isSafeInteger(input.archiveGeneration) || input.archiveGeneration < 0)
    )
      return yield* new LogR2Error({
        code: 'invalid-input',
        operation: 'logs.archive',
        message: 'Archive retry generation is invalid',
      })
    if (
      batch.entries.length === 0 ||
      batch.entries.length > LOG_LIMITS.maximumArchiveEntries ||
      batch.uncompressedBytes > LOG_LIMITS.maximumArchiveBytes
    )
      return yield* new LogR2Error({
        code: 'size-limit',
        operation: 'logs.archive',
        message: 'Log archive exceeds the configured bound',
      })
    const serverId = batch.entries[0]?.serverId
    if (serverId === undefined || batch.entries.some((entry) => entry.serverId !== serverId))
      return yield* new LogR2Error({
        code: 'invalid-input',
        operation: 'logs.archive',
        message: 'One archive may contain only one server',
      })
    const body = textEncoder.encode(
      batch.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    )
    const digest = yield* sha256(body)
    const compressed = yield* gzip(body)
    const compressedSha256 = yield* sha256(compressed)
    if (compressed.byteLength > LOG_LIMITS.maximumArchiveBytes)
      return yield* new LogR2Error({
        code: 'size-limit',
        operation: 'logs.archive',
        message: 'Compressed log archive exceeds the configured bound',
      })
    const key = logArchiveObjectKey(
      batch.organizationId,
      serverId,
      input.archiveId,
      batch.entries[0]!.timestamp,
      input.streamEpoch,
    )
    const metadata = metadataFrom(
      batch,
      input.archiveId,
      key,
      input.createdAt,
      compressed.byteLength,
      digest,
      input.expiresAt,
      input.streamEpoch,
    )
    return {
      metadata,
      compressed,
      customMetadata: {
        organizationId: batch.organizationId,
        serverId,
        nodeId: batch.nodeId,
        archiveId: input.archiveId,
        sha256: digest,
        uncompressedBytes: String(body.byteLength),
        entryCount: String(batch.entries.length),
        firstTimestamp: metadata.firstTimestamp,
        lastTimestamp: metadata.lastTimestamp,
        compressedBytes: String(compressed.byteLength),
        compressedSha256,
        ...(input.streamEpoch === undefined ? {} : { streamEpoch: input.streamEpoch }),
        ...(input.archiveGeneration === undefined
          ? {}
          : { archiveGeneration: String(input.archiveGeneration) }),
      },
    }
  })

const exactPrepared = (existing: LogR2ObjectInfo, prepared: PreparedLogArchive): boolean =>
  exactExisting(existing, {
    organizationId: prepared.metadata.organizationId,
    serverId: prepared.metadata.serverId,
    nodeId: prepared.metadata.nodeId,
    archiveId: prepared.metadata.id,
    sha256: prepared.metadata.sha256,
    uncompressedBytes: prepared.metadata.uncompressedBytes,
    entryCount: prepared.metadata.entryCount,
    firstTimestamp: prepared.metadata.firstTimestamp,
    lastTimestamp: prepared.metadata.lastTimestamp,
    compressedBytes: prepared.metadata.compressedBytes,
    compressedSha256: prepared.customMetadata.compressedSha256!,
    ...(prepared.metadata.streamEpoch === undefined
      ? {}
      : { streamEpoch: prepared.metadata.streamEpoch }),
    ...(prepared.customMetadata.archiveGeneration === undefined
      ? {}
      : { archiveGeneration: prepared.customMetadata.archiveGeneration }),
  })

/** Uploads/adopts only exact canonical bytes prepared by `prepareLogArchive`. */
export const uploadPreparedLogArchive = (
  bucket: LogR2BucketShape,
  prepared: PreparedLogArchive,
  options: { readonly signal?: AbortSignal } = {},
): Effect.Effect<ArchivedLogBatch, LogR2Error> =>
  Effect.gen(function* () {
    if (options.signal?.aborted)
      return yield* new LogR2Error({
        code: 'upload-uncertain',
        operation: 'logs.archive.deadline',
        message: 'Archive upload deadline elapsed before R2 ownership was proven',
      })
    const existing = yield* Effect.tryPromise({
      try: () => bucket.head(prepared.metadata.r2Key),
      catch: () =>
        new LogR2Error({
          code: 'transport-failed',
          operation: 'logs.archive.head',
          message: 'Archive lookup failed',
        }),
    })
    if (options.signal?.aborted)
      return yield* new LogR2Error({
        code: 'upload-uncertain',
        operation: 'logs.archive.deadline',
        message: 'Archive upload deadline elapsed before R2 ownership was proven',
      })
    if (existing !== null) {
      if (
        !exactPrepared(existing, prepared) ||
        !(yield* exactExistingBytes(
          bucket,
          prepared.metadata.r2Key,
          prepared.compressed.byteLength,
          prepared.customMetadata.compressedSha256!,
        ))
      )
        return yield* new LogR2Error({
          code: 'conflict',
          operation: 'logs.archive',
          message: 'Archive key is already owned by different content',
        })
      return { metadata: { ...prepared.metadata, compressedBytes: existing.size }, adopted: true }
    }
    const put = yield* Effect.result(
      Effect.tryPromise({
        try: () => {
          const putOptions = {
            customMetadata: prepared.customMetadata,
            onlyIfAbsent: true,
          } as const
          if (options.signal === undefined)
            return bucket.put(prepared.metadata.r2Key, prepared.compressed, putOptions)
          if (bucket.putAbortable === undefined)
            throw new Error('deadline-aware archive upload is unavailable')
          return bucket.putAbortable(prepared.metadata.r2Key, prepared.compressed, {
            ...putOptions,
            signal: options.signal,
          })
        },
        catch: () =>
          new LogR2Error({
            code: 'upload-uncertain',
            operation: 'logs.archive.put',
            message: 'Archive publication status is uncertain',
          }),
      }),
    )
    if (Result.isSuccess(put))
      return {
        metadata: { ...prepared.metadata, compressedBytes: put.success.size },
        adopted: false,
      }
    const after = yield* Effect.tryPromise({
      try: () => bucket.head(prepared.metadata.r2Key),
      catch: () =>
        new LogR2Error({
          code: 'upload-uncertain',
          operation: 'logs.archive.reconcile',
          message: 'Archive publication cannot be reconciled',
        }),
    })
    if (
      after !== null &&
      exactPrepared(after, prepared) &&
      (yield* exactExistingBytes(
        bucket,
        prepared.metadata.r2Key,
        prepared.compressed.byteLength,
        prepared.customMetadata.compressedSha256!,
      ))
    )
      return { metadata: { ...prepared.metadata, compressedBytes: after.size }, adopted: true }
    return yield* Effect.fail(put.failure)
  })

export const archiveLogBatch = (
  bucket: LogR2BucketShape,
  batch: LogBatch,
  input: {
    readonly archiveId: string
    readonly createdAt: string
    readonly expiresAt: string | null
    readonly streamEpoch?: string
    readonly archiveGeneration?: number
  },
): Effect.Effect<ArchivedLogBatch, LogR2Error | LogValidationError> =>
  prepareLogArchive(batch, input).pipe(
    Effect.flatMap((prepared) => uploadPreparedLogArchive(bucket, prepared)),
  )

export interface RestoredLogArchive {
  readonly metadata: LogArchiveMetadata
  readonly entries: ReadonlyArray<LogEntry>
}

export const readLogArchive = (
  bucket: LogR2BucketShape,
  metadata: LogArchiveMetadata,
  organizationId: string,
  serverId: string,
): Effect.Effect<RestoredLogArchive, LogR2Error | LogValidationError> =>
  Effect.gen(function* () {
    const expectedKey = logArchiveObjectKey(
      metadata.organizationId,
      metadata.serverId,
      metadata.id,
      metadata.firstTimestamp,
      metadata.streamEpoch,
    )
    if (
      metadata.organizationId !== organizationId ||
      metadata.serverId !== serverId ||
      metadata.r2Key !== expectedKey
    )
      return yield* new LogR2Error({
        code: 'ownership-denied',
        operation: 'logs.archive.read',
        message: 'Archive does not belong to this organization and server',
      })
    if (metadata.state !== 'available')
      return yield* new LogR2Error({
        code: 'not-found',
        operation: 'logs.archive.read',
        message: 'Archive is no longer available',
      })
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(metadata.r2Key),
      catch: () =>
        new LogR2Error({
          code: 'transport-failed',
          operation: 'logs.archive.get',
          message: 'Archive read failed',
        }),
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof LogR2Error
          ? cause
          : new LogR2Error({
              code: 'transport-failed',
              operation: 'logs.archive.get',
              message: 'Archive read failed',
            }),
      ),
    )
    if (object === null)
      return yield* new LogR2Error({
        code: 'not-found',
        operation: 'logs.archive.get',
        message: 'Archive is not available',
      })
    const compressed = yield* Effect.tryPromise({
      try: () => readStreamBounded(object.body, LOG_LIMITS.maximumArchiveBytes),
      catch: () =>
        new LogR2Error({
          code: 'size-limit',
          operation: 'logs.archive.read',
          message: 'Archive read exceeded the configured bound',
        }),
    })
    const compressedDigest = yield* sha256(compressed)
    if (
      object.size !== compressed.byteLength ||
      object.customMetadata.organizationId !== metadata.organizationId ||
      object.customMetadata.serverId !== metadata.serverId ||
      object.customMetadata.nodeId !== metadata.nodeId ||
      object.customMetadata.archiveId !== metadata.id ||
      object.customMetadata.sha256 !== metadata.sha256 ||
      object.customMetadata.uncompressedBytes !== String(metadata.uncompressedBytes) ||
      object.customMetadata.entryCount !== String(metadata.entryCount) ||
      object.customMetadata.firstTimestamp !== metadata.firstTimestamp ||
      object.customMetadata.lastTimestamp !== metadata.lastTimestamp ||
      object.customMetadata.compressedBytes !== String(metadata.compressedBytes) ||
      object.customMetadata.compressedSha256 !== compressedDigest ||
      (metadata.streamEpoch === undefined
        ? object.customMetadata.streamEpoch !== undefined
        : object.customMetadata.streamEpoch !== metadata.streamEpoch)
    )
      return yield* new LogR2Error({
        code: 'integrity-failed',
        operation: 'logs.archive.metadata',
        message: 'Archive object metadata does not match the immutable catalog entry',
      })
    const body = yield* gunzipBounded(compressed, LOG_LIMITS.maximumArchiveBytes)
    const observedDigest = yield* sha256(body)
    if (observedDigest !== metadata.sha256)
      return yield* new LogR2Error({
        code: 'integrity-failed',
        operation: 'logs.archive.read',
        message: 'Archive checksum does not match metadata',
      })
    const source = new TextDecoder().decode(body)
    const lines = source.split('\n').filter((line) => line.length > 0)
    if (lines.length !== metadata.entryCount || lines.length > LOG_LIMITS.maximumArchiveEntries)
      return yield* new LogR2Error({
        code: 'integrity-failed',
        operation: 'logs.archive.read',
        message: 'Archive entry count does not match metadata',
      })
    const entries: LogEntry[] = []
    for (const line of lines) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        return yield* new LogR2Error({
          code: 'integrity-failed',
          operation: 'logs.archive.read',
          message: 'Archive contains invalid JSON',
        })
      }
      entries.push(yield* sanitizeLogEntry(value))
    }
    if (
      entries.some(
        (entry) =>
          entry.organizationId !== organizationId ||
          entry.nodeId !== metadata.nodeId ||
          entry.serverId !== serverId,
      )
    )
      return yield* new LogR2Error({
        code: 'ownership-denied',
        operation: 'logs.archive.read',
        message: 'Archive contains a foreign tenant entry',
      })
    const batch = yield* makeLogBatch(organizationId, metadata.nodeId, entries)
    return { metadata, entries: batch.entries }
  })

export const deleteLogArchive = (
  bucket: LogR2BucketShape,
  metadata: LogArchiveMetadata,
  organizationId: string,
): Effect.Effect<void, LogR2Error> =>
  metadata.organizationId !== organizationId ||
  !metadata.r2Key.startsWith(`organizations/${organizationId}/logs/${metadata.serverId}/`)
    ? Effect.fail(
        new LogR2Error({
          code: 'ownership-denied',
          operation: 'logs.archive.delete',
          message: 'Archive does not belong to this organization',
        }),
      )
    : Effect.tryPromise({
        try: () => bucket.delete(metadata.r2Key),
        catch: () =>
          new LogR2Error({
            code: 'transport-failed',
            operation: 'logs.archive.delete',
            message: 'Archive deletion failed',
          }),
      })

export interface CloudflareLogR2Binding {
  readonly head: (key: string) => Promise<{
    readonly key: string
    readonly size: number
    readonly etag: string
    readonly customMetadata?: Readonly<Record<string, string>>
  } | null>
  readonly get: (key: string) => Promise<{
    readonly key: string
    readonly size: number
    readonly etag: string
    readonly body?: ReadableStream<Uint8Array>
    readonly customMetadata?: Readonly<Record<string, string>>
  } | null>
  readonly put: (
    key: string,
    body: Uint8Array,
    options?: {
      readonly customMetadata?: Readonly<Record<string, string>>
      readonly onlyIf?: Headers
    },
  ) => Promise<{
    readonly key: string
    readonly size: number
    readonly etag: string
    readonly customMetadata?: Readonly<Record<string, string>>
  } | null>
  readonly delete: (key: string) => Promise<void>
}

/**
 * R2 accepts a ReadableStream body. Keep it separate from the ordinary
 * adapter so archive readers/publishers with a byte-only fake cannot claim
 * deadline cancellation support accidentally.
 */
export interface CloudflareAbortableLogR2Binding extends Omit<CloudflareLogR2Binding, 'put'> {
  readonly put: (
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: {
      readonly customMetadata?: Readonly<Record<string, string>>
      readonly onlyIf?: Headers
    },
  ) => Promise<{
    readonly key: string
    readonly size: number
    readonly etag: string
    readonly customMetadata?: Readonly<Record<string, string>>
  } | null>
}

const cloudflarePutOptions = (
  customMetadata: Readonly<Record<string, string>>,
  onlyIfAbsent: boolean,
): { readonly customMetadata: Readonly<Record<string, string>>; readonly onlyIf?: Headers } => ({
  customMetadata,
  ...(onlyIfAbsent ? { onlyIf: new Headers({ 'if-none-match': '*' }) } : {}),
})

const cloudflareCommon = (
  binding: Pick<CloudflareLogR2Binding, 'head' | 'get' | 'delete'>,
): Pick<LogR2BucketShape, 'head' | 'get' | 'delete'> => ({
  head: async (key) => {
    const object = await binding.head(key)
    return object === null
      ? null
      : { ...object, customMetadata: objectMetadata(object.customMetadata) }
  },
  get: async (key) => {
    const object = await binding.get(key)
    if (object === null || object.body === undefined) return null
    return {
      ...object,
      body: object.body,
      customMetadata: objectMetadata(object.customMetadata),
    }
  },
  delete: binding.delete,
})

export const makeCloudflareLogR2Bucket = (binding: CloudflareLogR2Binding): LogR2BucketShape => ({
  ...cloudflareCommon(binding),
  put: async (key, body, options) => {
    const object = await binding.put(
      key,
      body,
      cloudflarePutOptions(options.customMetadata, options.onlyIfAbsent),
    )
    if (object === null) throw new Error('conditional archive write was not applied')
    return { ...object, customMetadata: objectMetadata(object.customMetadata) }
  },
})

/**
 * The telemetry ingress uses this adapter exclusively. Its R2 stream emits an
 * error as soon as the request/deadline aborts, rather than allowing a byte
 * buffer to continue writing after the application cancellation boundary.
 */
export const makeDeadlineAwareCloudflareLogR2Bucket = (
  binding: CloudflareAbortableLogR2Binding,
): LogR2BucketShape => ({
  ...cloudflareCommon(binding),
  put: async (key, body, options) => {
    const object = await binding.put(
      key,
      body,
      cloudflarePutOptions(options.customMetadata, options.onlyIfAbsent),
    )
    if (object === null) throw new Error('conditional archive write was not applied')
    return { ...object, customMetadata: objectMetadata(object.customMetadata) }
  },
  putAbortable: async (key, body, options) => {
    if (options.signal.aborted) throw new Error('archive upload deadline elapsed')
    let offset = 0
    let closed = false
    let removeAbortListener: (() => void) | undefined
    let abortStream: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        abortStream = () => {
          if (closed) return
          closed = true
          removeAbortListener?.()
          controller.error(new Error('archive upload deadline elapsed'))
        }
        removeAbortListener = () => options.signal.removeEventListener('abort', abortStream!)
        if (options.signal.aborted) {
          abortStream()
          return
        }
        options.signal.addEventListener('abort', abortStream, { once: true })
      },
      pull(controller) {
        if (options.signal.aborted) {
          abortStream?.()
          return
        }
        if (offset >= body.byteLength) {
          closed = true
          removeAbortListener?.()
          controller.close()
          return
        }
        const nextOffset = Math.min(offset + 16 * 1024, body.byteLength)
        controller.enqueue(body.slice(offset, nextOffset))
        offset = nextOffset
      },
      cancel() {
        closed = true
        removeAbortListener?.()
      },
    })
    const object = await binding.put(
      key,
      stream,
      cloudflarePutOptions(options.customMetadata, options.onlyIfAbsent),
    )
    if (object === null) throw new Error('conditional archive write was not applied')
    return { ...object, customMetadata: objectMetadata(object.customMetadata) }
  },
})

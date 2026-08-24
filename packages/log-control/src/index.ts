import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const ArchiveIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const LOG_LIMITS = {
  maximumMessageBytes: 16 * 1024,
  maximumFieldsBytes: 16 * 1024,
  maximumEntryBytes: 32 * 1024,
  maximumBatchEntries: 512,
  maximumBatchBytes: 2 * 1024 * 1024,
  maximumArchiveBytes: 8 * 1024 * 1024,
  maximumArchiveEntries: 10_000,
  maximumPageSize: 100,
  maximumTimeRangeMilliseconds: 31 * 24 * 60 * 60 * 1000,
  cursorLifetimeMilliseconds: 24 * 60 * 60 * 1000,
  liveTicketLifetimeMilliseconds: 60_000,
} as const

export const LogComponent = Schema.Literals([
  'agent',
  'cloudflared',
  'traefik',
  'docker',
  'game',
  'installer',
  'updater',
  'plugin-health',
  'provider-workflow',
])
export type LogComponent = typeof LogComponent.Type
export const LogLevel = Schema.Literals(['debug', 'info', 'warn', 'error'])
export type LogLevel = typeof LogLevel.Type

const JsonValue: Schema.Schema<unknown> = Schema.Unknown
export const LogEntry = Schema.Struct({
  organizationId: Identifier,
  nodeId: Identifier,
  serverId: Schema.optional(Identifier),
  operationId: Schema.optional(Identifier),
  component: LogComponent,
  level: LogLevel,
  timestamp: Timestamp,
  sequence: PositiveInteger,
  message: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(LOG_LIMITS.maximumMessageBytes),
  ),
  fields: Schema.optional(Schema.Record(Schema.String, JsonValue)),
})
export type LogEntry = typeof LogEntry.Type

export const LogArchiveState = Schema.Literals([
  'pending',
  'available',
  'expired',
  'deleted',
  'failed',
])
export type LogArchiveState = typeof LogArchiveState.Type

export const LogArchiveMetadata = Schema.Struct({
  organizationId: Identifier,
  id: ArchiveIdentifier,
  serverId: Identifier,
  nodeId: Identifier,
  /** Deployment-bound live stream epoch; absent only for pre-epoch archives. */
  streamEpoch: Schema.optional(Identifier),
  r2Key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  compression: Schema.Literal('gzip'),
  firstTimestamp: Timestamp,
  lastTimestamp: Timestamp,
  entryCount: PositiveInteger,
  uncompressedBytes: PositiveInteger,
  compressedBytes: PositiveInteger,
  sha256: Digest,
  state: LogArchiveState,
  createdAt: Timestamp,
  expiresAt: Schema.NullOr(Timestamp),
})
export type LogArchiveMetadata = typeof LogArchiveMetadata.Type

/** The public API deliberately omits the internal R2 key. */
export type PublicLogArchive = Omit<LogArchiveMetadata, 'r2Key'>
export const publicLogArchive = (metadata: LogArchiveMetadata): PublicLogArchive => {
  const { r2Key: _r2Key, ...publicMetadata } = metadata
  return publicMetadata
}

export class LogValidationError extends Schema.TaggedError<LogValidationError>()(
  'LogValidationError',
  {
    code: Schema.Literals([
      'invalid-entry',
      'invalid-scope',
      'invalid-time-range',
      'invalid-cursor',
      'batch-too-large',
      'archive-too-large',
      'secret-detected',
    ]),
    message: Schema.String,
  },
) {}
export class LogPersistenceError extends Schema.TaggedError<LogPersistenceError>()(
  'LogPersistenceError',
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
export class LogNotFoundError extends Schema.TaggedError<LogNotFoundError>()('LogNotFoundError', {
  resource: Schema.Literal('log-archive'),
  id: Schema.String,
}) {}
export class LogAuthorizationError extends Schema.TaggedError<LogAuthorizationError>()(
  'LogAuthorizationError',
  {
    code: Schema.Literal('organization_scope_required'),
  },
) {}

export type LogControlError =
  | LogValidationError
  | LogPersistenceError
  | LogNotFoundError
  | LogAuthorizationError

const textEncoder = new TextEncoder()
const byteLength = (value: string): number => textEncoder.encode(value).byteLength

/** Normalize plugin/Docker field names so compound and camelCase secrets fail closed. */
const normalizedSecretKey = (key: string): string =>
  key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const sensitiveKey = (key: string): boolean => {
  const normalized = normalizedSecretKey(key)
  if (
    normalized.startsWith('authorization') ||
    normalized.startsWith('setcookie') ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized === 'bearer' ||
    normalized === 'session'
  )
    return true
  return [
    'password',
    'passwd',
    'secret',
    'token',
    'credential',
    'apikey',
    'privatekey',
    'plaintextkey',
    'datakey',
    'wrappedkey',
    'signingkey',
    'accesskey',
    'sessionkey',
    'clientkey',
    'steamguard',
    'rcon',
  ].some((fragment) => normalized.includes(fragment))
}
const secretPatterns = [
  /(\bBearer\s+)[A-Za-z0-9._~+\-/]+=*/gi,
  /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  /\b(?:sk|pk|ghp|glpat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g,
  /((?:authorization|access[_-]?token|refresh[_-]?token|cookie|password|passwd|secret|credential|api[_-]?key|private[_-]?key|steam[_-]?guard|steamguard(?:code)?|rcon(?:password)?|client[_-]?secret|signing[_-]?key|access[_-]?key|session[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi,
]

/** Redacts both secret-shaped fields and common bearer/key material in free text. */
export const redactSecrets = (value: unknown, key = ''): unknown => {
  if (sensitiveKey(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return secretPatterns.reduce((current, pattern) => {
      if (pattern.source.includes('Bearer') || pattern.source.includes('\\s*[:=]'))
        return current.replace(pattern, '$1[REDACTED]')
      return current.replace(pattern, '[REDACTED]')
    }, value)
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item))
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of Object.entries(value))
      output[entryKey] = redactSecrets(entryValue, entryKey)
    return output
  }
  return value
}

const isSafeTimestamp = (value: string): boolean => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

const boundedJson = (value: unknown, depth = 0, seen = { count: 0 }): boolean => {
  seen.count += 1
  if (seen.count > 1024 || depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return byteLength(value) <= LOG_LIMITS.maximumFieldsBytes
  if (Array.isArray(value))
    return value.length <= 256 && value.every((item) => boundedJson(item, depth + 1, seen))
  if (typeof value !== 'object') return false
  const entries = Object.entries(value)
  return (
    entries.length <= 256 &&
    entries.every(
      ([entryKey, entryValue]) =>
        entryKey.length > 0 && entryKey.length <= 128 && boundedJson(entryValue, depth + 1, seen),
    )
  )
}

const decodeEntry = (value: unknown): Effect.Effect<LogEntry, LogValidationError> =>
  (() => {
    const keys = new Set([
      'organizationId',
      'nodeId',
      'serverId',
      'operationId',
      'component',
      'level',
      'timestamp',
      'sequence',
      'message',
      'fields',
    ])
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.has(key)) ||
      !Schema.is(LogEntry)(value)
    )
      return Effect.fail(
        new LogValidationError({
          code: 'invalid-entry',
          message: 'Log entry does not match the strict contract',
        }),
      )
    const decoded = value as LogEntry
    if (!isSafeTimestamp(decoded.timestamp) || !boundedJson(decoded.fields ?? {}))
      return Effect.fail(
        new LogValidationError({
          code: 'invalid-entry',
          message: 'Log entry fields or timestamp are invalid',
        }),
      )
    const sanitized = redactLogEntry(decoded)
    if (
      byteLength(sanitized.message) > LOG_LIMITS.maximumMessageBytes ||
      byteLength(JSON.stringify(sanitized.fields ?? {})) > LOG_LIMITS.maximumFieldsBytes ||
      byteLength(JSON.stringify(sanitized)) > LOG_LIMITS.maximumEntryBytes
    )
      return Effect.fail(
        new LogValidationError({
          code: 'batch-too-large',
          message: 'Log entry exceeds the configured byte bound',
        }),
      )
    return Effect.succeed(sanitized)
  })()

/** Validates and redacts one entry before it crosses the agent/control-plane boundary. */
export const sanitizeLogEntry = (value: unknown): Effect.Effect<LogEntry, LogValidationError> =>
  decodeEntry(value)

export const redactLogEntry = (entry: LogEntry): LogEntry => ({
  ...entry,
  message: redactSecrets(entry.message) as string,
  ...(entry.fields === undefined
    ? {}
    : { fields: redactSecrets(entry.fields) as Record<string, unknown> }),
})

export interface LogBatch {
  readonly organizationId: string
  readonly nodeId: string
  readonly entries: ReadonlyArray<LogEntry>
  readonly firstSequence: number
  readonly lastSequence: number
  readonly uncompressedBytes: number
}

export interface LogStreamWatermark {
  readonly organizationId: string
  readonly nodeId: string
  readonly lastSequence: number
  readonly lastTimestamp: string
  readonly lastFingerprint: string
}

export const makeLogBatch = (
  organizationId: string,
  nodeId: string,
  values: ReadonlyArray<unknown>,
): Effect.Effect<LogBatch, LogValidationError> =>
  Effect.gen(function* () {
    if (values.length === 0 || values.length > LOG_LIMITS.maximumBatchEntries)
      return yield* new LogValidationError({
        code: 'batch-too-large',
        message: 'Log batch entry count is outside the bound',
      })
    const entries: LogEntry[] = []
    let bytes = 0
    for (const value of values) {
      const entry = yield* sanitizeLogEntry(value)
      if (entry.organizationId !== organizationId || entry.nodeId !== nodeId)
        return yield* new LogValidationError({
          code: 'invalid-scope',
          message: 'Log batch organization or node does not match its envelope',
        })
      entries.push(entry)
      bytes += byteLength(`${JSON.stringify(entry)}\n`)
      if (bytes > LOG_LIMITS.maximumBatchBytes)
        return yield* new LogValidationError({
          code: 'batch-too-large',
          message: 'Log batch bytes exceed the bound',
        })
    }
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!
      const current = entries[index]!
      if (current.sequence !== previous.sequence + 1)
        return yield* new LogValidationError({
          code: 'invalid-entry',
          message: 'Log batch sequences must be ordered, unique, and contiguous',
        })
      if (current.timestamp < previous.timestamp)
        return yield* new LogValidationError({
          code: 'invalid-entry',
          message: 'Log batch timestamps must be non-decreasing',
        })
    }
    const first = entries[0]!
    const last = entries[entries.length - 1]!
    return {
      organizationId,
      nodeId,
      entries,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      uncompressedBytes: bytes,
    }
  })

export interface LogArchivePageRequest {
  readonly organizationId: string
  readonly serverId: string
  readonly from?: string
  readonly to?: string
  readonly cursor?: string
  readonly limit: number
}
export interface LogArchivePage {
  readonly items: ReadonlyArray<LogArchiveMetadata>
  readonly nextCursor?: { readonly lastTimestamp: string; readonly lastId: string }
}

export const validateLogArchivePageRequest = (
  request: LogArchivePageRequest,
  now = Date.now(),
): Effect.Effect<LogArchivePageRequest, LogValidationError> =>
  Effect.gen(function* () {
    if (!Schema.is(Identifier)(request.organizationId) || !Schema.is(Identifier)(request.serverId))
      return yield* new LogValidationError({
        code: 'invalid-scope',
        message: 'Log archive scope is invalid',
      })
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > LOG_LIMITS.maximumPageSize
    )
      return yield* new LogValidationError({
        code: 'invalid-time-range',
        message: 'Log archive page size is invalid',
      })
    if (
      request.from !== undefined &&
      (!isSafeTimestamp(request.from) || Date.parse(request.from) > now)
    )
      return yield* new LogValidationError({
        code: 'invalid-time-range',
        message: 'Log archive start time is invalid',
      })
    if (request.to !== undefined && !isSafeTimestamp(request.to))
      return yield* new LogValidationError({
        code: 'invalid-time-range',
        message: 'Log archive end time is invalid',
      })
    if (request.from !== undefined && request.to !== undefined) {
      const start = Date.parse(request.from)
      const end = Date.parse(request.to)
      if (end < start || end - start > LOG_LIMITS.maximumTimeRangeMilliseconds)
        return yield* new LogValidationError({
          code: 'invalid-time-range',
          message: 'Log archive time range is invalid',
        })
    }
    return request
  })

interface CursorPayload {
  readonly v: 1
  readonly organizationId: string
  readonly serverId: string
  readonly lastTimestamp: string
  readonly lastId: string
  readonly issuedAt: number
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
const fromBase64Url = (value: string): Uint8Array => {
  const binary = atob(
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  )
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
const cryptoKey = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey(
    'raw',
    asArrayBuffer(textEncoder.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export const encodeLogCursor = (
  request: Pick<LogArchivePageRequest, 'organizationId' | 'serverId'>,
  last: Pick<LogArchiveMetadata, 'lastTimestamp' | 'id'>,
  secret: string,
  now = Date.now(),
): Effect.Effect<string, LogValidationError> =>
  Effect.tryPromise({
    try: async () => {
      const payload: CursorPayload = {
        v: 1,
        organizationId: request.organizationId,
        serverId: request.serverId,
        lastTimestamp: last.lastTimestamp,
        lastId: last.id,
        issuedAt: now,
      }
      const encoded = toBase64Url(textEncoder.encode(JSON.stringify(payload)))
      const signature = await crypto.subtle.sign(
        'HMAC',
        await cryptoKey(secret, ['sign']),
        asArrayBuffer(textEncoder.encode(encoded)),
      )
      return `${encoded}.${toBase64Url(new Uint8Array(signature))}`
    },
    catch: () =>
      new LogValidationError({
        code: 'invalid-cursor',
        message: 'Log archive cursor could not be issued',
      }),
  })

export const decodeLogCursor = (
  value: string,
  expected: Pick<LogArchivePageRequest, 'organizationId' | 'serverId'>,
  secret: string,
  now = Date.now(),
): Effect.Effect<Pick<CursorPayload, 'lastTimestamp' | 'lastId'>, LogValidationError> =>
  Effect.tryPromise({
    try: async () => {
      const [encoded, signature, ...rest] = value.split('.')
      if (rest.length > 0 || encoded === undefined || signature === undefined) throw new Error()
      const valid = await crypto.subtle.verify(
        'HMAC',
        await cryptoKey(secret, ['verify']),
        asArrayBuffer(fromBase64Url(signature)),
        asArrayBuffer(textEncoder.encode(encoded)),
      )
      if (!valid) throw new Error()
      const payload = JSON.parse(
        new TextDecoder().decode(fromBase64Url(encoded)),
      ) as Partial<CursorPayload>
      if (
        payload.v !== 1 ||
        payload.organizationId !== expected.organizationId ||
        payload.serverId !== expected.serverId ||
        typeof payload.lastTimestamp !== 'string' ||
        !isSafeTimestamp(payload.lastTimestamp) ||
        typeof payload.lastId !== 'string' ||
        !Schema.is(ArchiveIdentifier)(payload.lastId) ||
        typeof payload.issuedAt !== 'number' ||
        now - payload.issuedAt > LOG_LIMITS.cursorLifetimeMilliseconds ||
        payload.issuedAt > now + 60_000
      )
        throw new Error()
      return { lastTimestamp: payload.lastTimestamp, lastId: payload.lastId }
    },
    catch: () =>
      new LogValidationError({ code: 'invalid-cursor', message: 'Log archive cursor is invalid' }),
  })

export interface LogArchiveRepositoryShape {
  readonly record: (
    metadata: LogArchiveMetadata,
  ) => Effect.Effect<LogArchiveMetadata, LogPersistenceError>
  readonly get: (
    organizationId: string,
    archiveId: string,
  ) => Effect.Effect<LogArchiveMetadata | null, LogPersistenceError>
  readonly list: (
    request: LogArchivePageRequest,
    cursor?: { readonly lastTimestamp: string; readonly lastId: string },
  ) => Effect.Effect<LogArchivePage, LogPersistenceError>
  readonly expire: (
    organizationId: string,
    now: string,
    limit: number,
  ) => Effect.Effect<number, LogPersistenceError>
  /** Advances the authenticated node's contiguous log sequence watermark. */
  readonly advanceWatermark: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly firstSequence: number
    readonly lastSequence: number
    readonly lastTimestamp: string
    readonly fingerprint: string
  }) => Effect.Effect<
    { readonly accepted: boolean; readonly replayed: boolean },
    LogPersistenceError
  >
}
export class LogArchiveRepository extends Context.Service<
  LogArchiveRepository,
  LogArchiveRepositoryShape
>()('@gridora/log-control/LogArchiveRepository') {}
export const LogArchiveRepositoryLayer = (repository: LogArchiveRepositoryShape) =>
  Layer.succeed(LogArchiveRepository, repository)

export interface LiveLogTicketIssuer {
  /** The response repeats the canonical organization ID so clients never compare frames to a route slug. */
  readonly issue: (input: {
    readonly organizationId: string
    readonly serverId: string
    readonly streamEpoch: string
    readonly principalId: string
    readonly membershipRevision: number
    readonly membershipAuthorizationGeneration: number
    readonly organizationAuthorizationGeneration: number
    readonly now: number
  }) => Effect.Effect<
    {
      readonly ticket: string
      readonly expiresAt: number
      readonly organizationId: string
      readonly streamEpoch: string
    },
    LogPersistenceError
  >
}
export class LiveLogTicketAuthority extends Context.Service<
  LiveLogTicketAuthority,
  LiveLogTicketIssuer
>()('@gridora/log-control/LiveLogTicketAuthority') {}

export interface LiveLogTicketClaims {
  readonly organizationId: string
  readonly serverId: string
  readonly streamEpoch: string
  readonly principalId: string
  readonly membershipRevision: number
  readonly membershipAuthorizationGeneration: number
  readonly organizationAuthorizationGeneration: number
  readonly nonce: string
  readonly expiresAt: number
}
export interface LiveLogTicketVerification {
  readonly verify: (input: {
    readonly ticket: string
    readonly organizationId: string
    readonly serverId: string
    readonly streamEpoch: string
    readonly now: number
  }) => Effect.Effect<LiveLogTicketClaims, LogPersistenceError>
  readonly consume: (input: {
    readonly claims: LiveLogTicketClaims
    readonly organizationId: string
    readonly serverId: string
    readonly streamEpoch: string
    readonly now: number
  }) => Effect.Effect<void, LogPersistenceError>
}
export class LiveLogTicketVerifier extends Context.Service<
  LiveLogTicketVerifier,
  LiveLogTicketVerification
>()('@gridora/log-control/LiveLogTicketVerifier') {}

export const logArchiveObjectKey = (
  organizationId: string,
  serverId: string,
  archiveId: string,
  firstTimestamp: string,
  streamEpoch?: string,
): string => {
  if (
    !Schema.is(Identifier)(organizationId) ||
    !Schema.is(Identifier)(serverId) ||
    !Schema.is(ArchiveIdentifier)(archiveId)
  )
    throw new Error('unsafe log archive key')
  if (streamEpoch !== undefined && !Schema.is(Identifier)(streamEpoch))
    throw new Error('unsafe live log stream epoch')
  const date = firstTimestamp.slice(0, 10)
  return streamEpoch === undefined
    ? `organizations/${organizationId}/logs/${serverId}/${date}/${archiveId}.ndjson.gz`
    : `organizations/${organizationId}/logs/${serverId}/epochs/${streamEpoch}/${date}/${archiveId}.ndjson.gz`
}

/**
 * Queue payload for asynchronous live publication. It deliberately carries an
 * immutable archive identity only; raw log bytes remain in R2 and never enter
 * a Queue message.
 */
export const LiveLogArchiveAvailableEvent = Schema.Struct({
  version: Schema.Literal(2),
  type: Schema.Literal('log.archive.available'),
  organizationId: Identifier,
  nodeId: Identifier,
  serverId: Identifier,
  streamEpoch: Identifier,
  archiveId: ArchiveIdentifier,
  r2Key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  sha256: Digest,
  firstSequence: PositiveInteger,
  lastSequence: PositiveInteger,
})
export type LiveLogArchiveAvailableEvent = typeof LiveLogArchiveAvailableEvent.Type

export const decodeLiveLogArchiveAvailableEvent = (
  input: unknown,
): Effect.Effect<LiveLogArchiveAvailableEvent, LogValidationError> =>
  Schema.decodeUnknownEffect(LiveLogArchiveAvailableEvent, { onExcessProperty: 'error' })(
    input,
  ).pipe(
    Effect.flatMap((event) =>
      event.lastSequence < event.firstSequence ||
      !event.r2Key.startsWith(`organizations/${event.organizationId}/logs/${event.serverId}/`)
        ? Effect.fail(
            new LogValidationError({
              code: 'invalid-scope',
              message: 'Live log archive event scope is invalid',
            }),
          )
        : Effect.succeed(event),
    ),
    Effect.mapError((error) =>
      error instanceof LogValidationError
        ? error
        : new LogValidationError({
            code: 'invalid-entry',
            message: 'Live log archive event is invalid',
          }),
    ),
  )

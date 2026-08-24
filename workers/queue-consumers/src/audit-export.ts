import { Effect, Schema } from 'effect'
import {
  AUDIT_ENVELOPE_LIMITS,
  AUDIT_TIMESTAMP_ADMISSION_POLICY,
  AuditExportEvent as AuditExportEventSchema,
  canonicalAuditJson,
  decodeAuditEnvelope,
  platformAuditPartitionKey,
  redactAuditValue,
  tenantAuditPartitionKey,
  validateAuditTimestampAdmission,
} from '@gridora/audit-contracts'

/** The Queue wire contract is the complete, versioned audit envelope event. */
export const AuditExportEvent = AuditExportEventSchema
export type AuditExportEvent = typeof AuditExportEventSchema.Type

/** Compatibility name for existing tenant-only producers. */
export const auditPartitionKey = tenantAuditPartitionKey

export const AUDIT_EXPORT_LIMITS = {
  ...AUDIT_ENVELOPE_LIMITS,
  maximumCanonicalBytes: 96 * 1024,
  maximumFutureSkewMilliseconds: AUDIT_TIMESTAMP_ADMISSION_POLICY.maximumFutureSkewMilliseconds,
  maximumR2KeyBytes: 1_024,
} as const

export class AuditExportError extends Schema.TaggedError<AuditExportError>()('AuditExportError', {
  code: Schema.Literals([
    'invalid-event',
    'partition-mismatch',
    'time-bound',
    'size-limit',
    'ownership-denied',
    'conflict',
    'transport-failed',
    'write-uncertain',
  ] as const),
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface AuditArchiveObjectInfo {
  readonly key: string
  readonly size: number
  readonly customMetadata?: Readonly<Record<string, string>>
}

export interface AuditArchiveObjectBody extends AuditArchiveObjectInfo {
  readonly body: ReadableStream<Uint8Array>
}

export interface AuditArchivePutOptions {
  readonly onlyIf: Headers
  readonly httpMetadata: {
    readonly contentType: 'application/json'
    readonly cacheControl: 'private, no-store'
  }
  readonly customMetadata: Readonly<Record<string, string>>
  readonly sha256: ArrayBuffer
}

/** Narrow structural subset of the Cloudflare AUDIT_ARCHIVE R2 binding. */
export interface AuditArchiveBucket {
  readonly head: (key: string) => Promise<AuditArchiveObjectInfo | null>
  readonly get: (key: string) => Promise<AuditArchiveObjectBody | null>
  readonly put: (
    key: string,
    value: Uint8Array,
    options: AuditArchivePutOptions,
  ) => Promise<AuditArchiveObjectInfo | null>
}

export interface AuditArchiveReceipt {
  readonly key: string
  readonly scope: 'tenant' | 'platform'
  /** Null is an intentional platform partition, never a fabricated tenant. */
  readonly organizationId: string | null
  readonly eventIdentitySha256: string
  readonly checksum: string
  readonly bytes: number
  readonly adopted: boolean
}

export interface AuditExportOptions {
  /**
   * Retained only for source compatibility.  Timestamp admission is fixed at
   * D1 staging time and must never depend on delayed queue worker wall time.
   */
  readonly now?: () => number
}

const textEncoder = new TextEncoder()
const failure = (operation: string, code: AuditExportError['code'], message: string) =>
  new AuditExportError({ operation, code, message })

const auditContractFailure = (operation: string, error: { readonly code: string }) =>
  failure(
    operation,
    error.code === 'size-limit' ? 'size-limit' : 'invalid-event',
    'Audit event does not meet the complete envelope contract',
  )

const decodeAuditExportEvent = (
  input: unknown,
): Effect.Effect<AuditExportEvent, AuditExportError> =>
  Effect.gen(function* () {
    const outer = yield* Schema.decodeUnknownEffect(AuditExportEventSchema, {
      onExcessProperty: 'error',
    })(input).pipe(
      Effect.mapError(() =>
        failure('audit.decode', 'invalid-event', 'Audit queue event is invalid'),
      ),
    )
    const envelope = yield* decodeAuditEnvelope(outer.envelope).pipe(
      Effect.mapError((error) => auditContractFailure('audit.envelope', error)),
    )
    yield* validateAuditTimestampAdmission(envelope.occurredAt, outer.admittedAt).pipe(
      Effect.mapError(() =>
        failure('audit.time', 'time-bound', 'Audit timestamp exceeds the durable admission policy'),
      ),
    )
    if (outer.scope === 'tenant') {
      if (
        envelope.scope !== 'tenant' ||
        envelope.organizationId !== outer.organizationId ||
        outer.partitionKey !== tenantAuditPartitionKey(outer.organizationId)
      ) {
        return yield* failure(
          'audit.partition',
          'partition-mismatch',
          'Tenant event scope, envelope, or partition is invalid',
        )
      }
      return { ...outer, envelope }
    }
    if (
      envelope.scope !== 'platform' ||
      envelope.organizationId !== null ||
      outer.partitionKey !== platformAuditPartitionKey
    ) {
      return yield* failure(
        'audit.partition',
        'partition-mismatch',
        'Platform event scope, envelope, or partition is invalid',
      )
    }
    return { ...outer, envelope }
  })

/**
 * The producer validates exactly the same canonical/redaction budget as D1.
 * It never down-converts an envelope to a compact summary.
 */
export const prepareAuditExportQueueEvent = (
  input: AuditExportEvent,
): Effect.Effect<AuditExportEvent, AuditExportError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeAuditExportEvent(input)
    const canonical = yield* canonicalAuditJson(
      redactAuditValue(decoded),
      AUDIT_EXPORT_LIMITS.maximumCanonicalBytes,
    ).pipe(Effect.mapError((error) => auditContractFailure('audit.queue.prepare', error)))
    return yield* Schema.decodeUnknownEffect(AuditExportEventSchema, {
      onExcessProperty: 'error',
    })(JSON.parse(canonical) as unknown).pipe(
      Effect.mapError(() =>
        failure(
          'audit.queue.prepare',
          'invalid-event',
          'Audit queue event cannot be canonicalized',
        ),
      ),
    )
  })

const archiveKey = (
  event: AuditExportEvent,
  occurredAt: string,
  eventIdentityHex: string,
): Effect.Effect<string, AuditExportError> => {
  const year = occurredAt.slice(0, 4)
  const month = occurredAt.slice(5, 7)
  const day = occurredAt.slice(8, 10)
  const prefix =
    event.scope === 'tenant' ? `organizations/${event.organizationId}/audit` : 'platform/audit'
  const key = `${prefix}/${year}/${month}/${day}/events/${eventIdentityHex}.json`
  if (
    textEncoder.encode(key).byteLength > AUDIT_EXPORT_LIMITS.maximumR2KeyBytes ||
    key.startsWith('/') ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return Effect.fail(failure('audit.key', 'invalid-event', 'Audit archive key is invalid'))
  }
  return Effect.succeed(key)
}

const ownershipMetadata = (
  event: AuditExportEvent,
  eventIdentitySha256: string,
  checksum: string,
): Readonly<Record<string, string>> => ({
  'gridora-managed-by': 'gridora',
  'gridora-audit-scope': event.scope,
  ...(event.scope === 'tenant'
    ? { 'gridora-organization-id': event.organizationId }
    : { 'gridora-platform-partition': platformAuditPartitionKey }),
  'gridora-event-identity-sha256': eventIdentitySha256,
  'gridora-object-kind': 'audit-event-v2',
  'gridora-occurred-at': event.envelope.occurredAt,
  'gridora-admitted-at': event.admittedAt,
  'gridora-envelope-version': String(event.envelope.version),
  'gridora-capture-status': event.envelope.captureStatus,
  'gridora-redaction-version': 'audit-contracts-v1',
  'gridora-sha256': checksum,
})

const verifyOwnedMetadata = (
  object: AuditArchiveObjectInfo,
  key: string,
  event: AuditExportEvent,
  eventIdentitySha256: string,
  checksum: string,
): Effect.Effect<void, AuditExportError> => {
  const metadata = object.customMetadata ?? {}
  const partitionMatches =
    event.scope === 'tenant'
      ? metadata['gridora-organization-id'] === event.organizationId
      : metadata['gridora-platform-partition'] === platformAuditPartitionKey &&
        metadata['gridora-organization-id'] === undefined
  const owned =
    object.key === key &&
    metadata['gridora-managed-by'] === 'gridora' &&
    metadata['gridora-audit-scope'] === event.scope &&
    partitionMatches &&
    metadata['gridora-event-identity-sha256'] === eventIdentitySha256 &&
    metadata['gridora-object-kind'] === 'audit-event-v2'
  if (!owned) {
    return Effect.fail(
      failure('audit.adopt', 'ownership-denied', 'Audit archive ownership mismatch'),
    )
  }
  if (
    metadata['gridora-occurred-at'] !== event.envelope.occurredAt ||
    metadata['gridora-admitted-at'] !== event.admittedAt ||
    metadata['gridora-envelope-version'] !== String(event.envelope.version) ||
    metadata['gridora-capture-status'] !== event.envelope.captureStatus ||
    metadata['gridora-redaction-version'] !== 'audit-contracts-v1' ||
    metadata['gridora-sha256'] !== checksum
  ) {
    return Effect.fail(failure('audit.adopt', 'conflict', 'Audit archive content conflicts'))
  }
  return Effect.void
}

const bufferSource = (bytes: Uint8Array): ArrayBuffer => {
  const output = new Uint8Array(bytes.byteLength)
  output.set(bytes)
  return output.buffer
}

const digest = (operation: string, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest('SHA-256', bufferSource(bytes)),
    catch: () => failure(operation, 'transport-failed', 'Audit digest operation failed'),
  }).pipe(
    Effect.map((buffer) => ({
      buffer,
      hex: [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    })),
  )

const r2Attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => failure(operation, 'transport-failed', 'Audit archive operation failed'),
  })

const collectBounded = async (
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new Error('Audit archive object exceeds bound')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const adopt = (
  bucket: AuditArchiveBucket,
  object: AuditArchiveObjectInfo,
  key: string,
  event: AuditExportEvent,
  eventIdentitySha256: string,
  checksum: string,
  expected: Uint8Array,
): Effect.Effect<AuditArchiveReceipt, AuditExportError> =>
  Effect.gen(function* () {
    yield* verifyOwnedMetadata(object, key, event, eventIdentitySha256, checksum)
    if (object.size !== expected.byteLength) {
      return yield* failure('audit.adopt', 'conflict', 'Audit archive content conflicts')
    }
    const stored = yield* r2Attempt('audit.get', () => bucket.get(key))
    if (stored === null) {
      return yield* failure(
        'audit.get',
        'write-uncertain',
        'Audit archive persistence is uncertain',
      )
    }
    yield* verifyOwnedMetadata(stored, key, event, eventIdentitySha256, checksum)
    if (stored.size !== expected.byteLength) {
      return yield* failure('audit.adopt', 'conflict', 'Audit archive content conflicts')
    }
    const observed = yield* Effect.tryPromise({
      try: () => collectBounded(stored.body, expected.byteLength),
      catch: () => failure('audit.read', 'conflict', 'Audit archive content conflicts'),
    })
    if (!equalBytes(observed, expected)) {
      return yield* failure('audit.adopt', 'conflict', 'Audit archive content conflicts')
    }
    const observedDigest = yield* digest('audit.read.digest', observed)
    if (`sha256:${observedDigest.hex}` !== checksum) {
      return yield* failure('audit.adopt', 'conflict', 'Audit archive content conflicts')
    }
    return {
      key,
      scope: event.scope,
      organizationId: event.scope === 'tenant' ? event.organizationId : null,
      eventIdentitySha256,
      checksum,
      bytes: expected.byteLength,
      adopted: true,
    }
  })

export const archiveAuditEvent = (
  bucket: AuditArchiveBucket,
  input: unknown,
  options: AuditExportOptions = {},
): Effect.Effect<AuditArchiveReceipt, AuditExportError> =>
  Effect.gen(function* () {
    const event = yield* prepareAuditExportQueueEvent(input as AuditExportEvent)
    // Delivery can happen much later than admission.  Do not use this worker's
    // clock for an immutable event; prepareAuditExportQueueEvent already bound
    // occurrence to its durable D1 admission time.
    void options.now
    const occurredAt = event.envelope.occurredAt
    const archiveJson = yield* canonicalAuditJson(
      {
        apiVersion: 'audit.archive.gridora.dev/v2',
        event: {
          ...event,
          envelope: { ...event.envelope, occurredAt },
        },
      },
      AUDIT_EXPORT_LIMITS.maximumCanonicalBytes,
    ).pipe(Effect.mapError((error) => auditContractFailure('audit.encode', error)))
    const encoded = textEncoder.encode(archiveJson)
    const eventIdentityDigest = yield* digest(
      'audit.identity.digest',
      textEncoder.encode(
        JSON.stringify([
          'audit-event-identity-v2',
          event.scope,
          event.scope === 'tenant' ? event.organizationId : null,
          event.id,
        ]),
      ),
    )
    const eventIdentitySha256 = `sha256:${eventIdentityDigest.hex}`
    const bodyDigest = yield* digest('audit.body.digest', encoded)
    const checksum = `sha256:${bodyDigest.hex}`
    const key = yield* archiveKey(event, occurredAt, eventIdentityDigest.hex)
    const existing = yield* r2Attempt('audit.head', () => bucket.head(key))
    if (existing !== null) {
      return yield* adopt(bucket, existing, key, event, eventIdentitySha256, checksum, encoded)
    }
    const written = yield* Effect.result(
      r2Attempt('audit.put', () =>
        bucket.put(key, encoded, {
          onlyIf: new Headers({ 'if-none-match': '*' }),
          httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
          customMetadata: ownershipMetadata(event, eventIdentitySha256, checksum),
          sha256: bodyDigest.buffer,
        }),
      ),
    )
    if (written._tag === 'Success' && written.success !== null) {
      const verified = yield* adopt(
        bucket,
        written.success,
        key,
        event,
        eventIdentitySha256,
        checksum,
        encoded,
      )
      return { ...verified, adopted: false }
    }
    const afterWrite = yield* r2Attempt('audit.put.recover', () => bucket.head(key))
    if (afterWrite === null) {
      return yield* failure(
        'audit.put',
        'write-uncertain',
        'Audit archive persistence is uncertain',
      )
    }
    return yield* adopt(bucket, afterWrite, key, event, eventIdentitySha256, checksum, encoded)
  })

export interface AuditExportQueueMessage {
  readonly body: unknown
  readonly attempts: number
  readonly ack: () => void
  readonly retry: (options: { readonly delaySeconds: number }) => void
}

export type AuditExportQueueDecision =
  | { readonly decision: 'ack'; readonly receipt: AuditArchiveReceipt }
  | { readonly decision: 'retry'; readonly errorCode: AuditExportError['code'] }

export const processAuditExportMessages = async (
  messages: ReadonlyArray<AuditExportQueueMessage>,
  bucket: AuditArchiveBucket,
  options: AuditExportOptions = {},
): Promise<ReadonlyArray<AuditExportQueueDecision>> => {
  const results = await Effect.runPromise(
    Effect.forEach(
      messages,
      (message) => Effect.result(archiveAuditEvent(bucket, message.body, options)),
      { concurrency: 5 },
    ),
  )
  return results.map((result, index) => {
    const message = messages[index]
    if (message === undefined) return { decision: 'retry', errorCode: 'transport-failed' } as const
    if (result._tag === 'Success') {
      message.ack()
      return { decision: 'ack', receipt: result.success } as const
    }
    message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) })
    return { decision: 'retry', errorCode: result.failure.code } as const
  })
}

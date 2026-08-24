import { Context, Effect, Schema } from 'effect'

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

const noControlCharacters = Schema.makeFilter<string>((value) =>
  hasControlCharacter(value) ? 'control characters are not allowed' : undefined,
)

export const AuditIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  noControlCharacters,
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
)
export const AuditLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  noControlCharacters,
)
const isValidUtcTimestamp = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const millisecondsForm = value.includes('.') ? value : value.replace('Z', '.000Z')
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === millisecondsForm
}

export const AuditTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  Schema.makeFilter<string>((value) =>
    isValidUtcTimestamp(value) ? undefined : 'timestamp must be a real UTC calendar time',
  ),
)

/**
 * A producer must admit an event no more than this far after its stated
 * occurrence.  The bound is evaluated against the durable staging time, not
 * the queue worker clock, so an accepted immutable event cannot later become
 * permanently unexportable simply because delivery is delayed.
 */
export const AUDIT_TIMESTAMP_ADMISSION_POLICY = {
  maximumFutureSkewMilliseconds: 5 * 60 * 1_000,
} as const

const isIpv4Address = (value: string): boolean => {
  const segments = value.split('.')
  return (
    segments.length === 4 &&
    segments.every((segment) => {
      if (!/^\d{1,3}$/.test(segment)) return false
      const numeric = Number(segment)
      return numeric >= 0 && numeric <= 255
    })
  )
}

/**
 * Worker-safe IP parsing for the trusted CF-Connecting-IP header. It accepts
 * IPv4, RFC 4291 IPv6, and IPv4-mapped IPv6, but never accepts a merely
 * hexadecimal-looking string as source evidence.
 */
export const isAuditIpAddress = (value: string): boolean => {
  if (value.length < 3 || value.length > 64 || value.includes('%')) return false
  if (isIpv4Address(value)) return true
  if (!value.includes(':') || value.includes(':::')) return false

  const compressionCount = value.split('::').length - 1
  if (compressionCount > 1) return false
  const compressed = compressionCount === 1
  const groups = value.split('::').flatMap((side) => (side === '' ? [] : side.split(':')))
  if (groups.some((group) => group.length === 0)) return false

  let groupCount = 0
  for (const [index, group] of groups.entries()) {
    if (group.includes('.')) {
      if (index !== groups.length - 1 || !isIpv4Address(group)) return false
      groupCount += 2
      continue
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return false
    groupCount += 1
  }
  return compressed ? groupCount < 8 : groupCount === 8
}

export const AuditIpAddress = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(64),
  Schema.makeFilter<string>((value) =>
    isAuditIpAddress(value) ? undefined : 'IP address must be valid IPv4 or IPv6',
  ),
)
export const AuditJsonObject = Schema.Record(Schema.String, Schema.Unknown)
const AuditMetadataText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  noControlCharacters,
)

export const AuditScope = Schema.Literals(['tenant', 'platform'] as const)
export type AuditScope = typeof AuditScope.Type
/**
 * The provenance channel is immutable audit evidence.  It is deliberately
 * separate from actor type: a machine may carry out work that was originally
 * accepted by a human, but it must not be recorded as an HTTP request.
 */
export const AuditSourceOrigin = Schema.Literals([
  'http',
  'machine',
  'scheduler',
  'internal',
  'legacy',
] as const)
export type AuditSourceOrigin = typeof AuditSourceOrigin.Type
export const AuditRequestOrigin = Schema.Literals([
  'http',
  'machine',
  'scheduler',
  'internal',
] as const)
export type AuditRequestOrigin = typeof AuditRequestOrigin.Type
export const AuditActorType = Schema.Literals([
  'human',
  'automation',
  'machine',
  'system',
  'platform',
] as const)
export type AuditActorType = typeof AuditActorType.Type
export const AuditResult = Schema.Literals(['succeeded', 'denied', 'failed'] as const)
export type AuditResult = typeof AuditResult.Type
export const AuditErrorClassification = Schema.Literals([
  'none',
  'authorization',
  'validation',
  'conflict',
  'policy',
  'provider',
  'transport',
  'timeout',
  'unknown',
] as const)
export type AuditErrorClassification = typeof AuditErrorClassification.Type
export const AuditCaptureStatus = Schema.Literal('complete')
export type AuditCaptureStatus = typeof AuditCaptureStatus.Type

export const AuditCapturedState = Schema.Struct({
  state: Schema.Literal('captured'),
  summary: AuditJsonObject,
})
export const AuditAbsentState = Schema.Struct({
  state: Schema.Literal('absent'),
  reason: AuditLabel,
})
/** A v1 mutation has a captured state or a precise statement that it did not exist. */
export const AuditStateSummary = Schema.Union([AuditCapturedState, AuditAbsentState])
export type AuditStateSummary = typeof AuditStateSummary.Type

/** v0 records can retain their historical lack of state evidence without masquerading as v1. */
export const LegacyAuditStateSummary = Schema.Union([
  Schema.Struct({
    state: Schema.Literal('captured'),
    summary: AuditJsonObject,
  }),
  Schema.Struct({
    state: Schema.Literal('not-available'),
    reason: AuditLabel,
  }),
])
export type LegacyAuditStateSummary = typeof LegacyAuditStateSummary.Type

const AuditSourceValue = <A extends Schema.Top>(value: A) =>
  Schema.Union([
    Schema.Struct({ state: Schema.Literal('captured'), value }),
    Schema.Struct({ state: Schema.Literal('not-available'), reason: AuditLabel }),
  ])

const auditSourceEvidenceFields = {
  ip: AuditSourceValue(AuditIpAddress),
  access: AuditSourceValue(
    Schema.Struct({
      subject: Schema.NullOr(AuditMetadataText),
      identityId: Schema.NullOr(AuditIdentifier),
      issuer: Schema.NullOr(AuditMetadataText),
      email: Schema.NullOr(
        Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320), noControlCharacters),
      ),
    }),
  ),
} as const

/** Evidence supplied by the request adapter before the immutable origin is added. */
export const AuditRequestSource = Schema.Struct(auditSourceEvidenceFields)
export type AuditRequestSource = typeof AuditRequestSource.Type

/** Immutable provenance retained with each persisted/exported envelope. */
export const AuditSource = Schema.Struct({
  origin: AuditSourceOrigin,
  ...auditSourceEvidenceFields,
})
export type AuditSource = typeof AuditSource.Type

/**
 * Request evidence is scoped to a single Effect program. The HTTP adapter owns
 * creating it once; repositories can require it without expanding every method
 * parameter. Schedulers and machine paths provide an explicit equivalent.
 */
export const AuditRequestContextValue = Schema.Struct({
  origin: AuditRequestOrigin,
  requestId: AuditIdentifier,
  correlationId: AuditIdentifier,
  source: AuditRequestSource,
})
export type AuditRequestContextValue = typeof AuditRequestContextValue.Type
export interface AuditRequestContextShape extends AuditRequestContextValue {}
export class AuditRequestContext extends Context.Service<
  AuditRequestContext,
  AuditRequestContextShape
>()('@gridora/audit-contracts/AuditRequestContext') {}

export const AuditEnvelopeV1 = Schema.Struct({
  version: Schema.Literal(1),
  captureStatus: AuditCaptureStatus,
  occurredAt: AuditTimestamp,
  scope: AuditScope,
  organizationId: Schema.NullOr(AuditIdentifier),
  actor: Schema.Struct({ type: AuditActorType, id: AuditIdentifier }),
  request: Schema.Struct({ id: AuditIdentifier, correlationId: AuditIdentifier }),
  action: AuditLabel,
  target: Schema.Struct({ type: AuditLabel, id: AuditIdentifier }),
  before: AuditStateSummary,
  after: AuditStateSummary,
  operationId: AuditIdentifier,
  source: AuditSource,
  result: AuditResult,
  error: Schema.Struct({
    classification: AuditErrorClassification,
    code: Schema.NullOr(AuditLabel),
  }),
  forced: Schema.Boolean,
  breakGlass: Schema.Boolean,
})
export type AuditEnvelopeV1 = typeof AuditEnvelopeV1.Type

/** Historical rows are explicitly labelled as incomplete compatibility evidence. */
export const LegacyAuditEnvelopeV0 = Schema.Struct({
  version: Schema.Literal(0),
  captureStatus: Schema.Literal('legacy'),
  occurredAt: AuditTimestamp,
  scope: AuditScope,
  organizationId: Schema.NullOr(AuditIdentifier),
  actor: Schema.Struct({ type: AuditActorType, id: AuditIdentifier }),
  request: Schema.Struct({ id: AuditIdentifier, correlationId: AuditIdentifier }),
  action: AuditLabel,
  target: Schema.Struct({ type: AuditLabel, id: AuditIdentifier }),
  before: LegacyAuditStateSummary,
  after: LegacyAuditStateSummary,
  operationId: AuditIdentifier,
  source: AuditSource,
  result: AuditResult,
  error: Schema.Struct({
    classification: Schema.Literal('unknown'),
    code: Schema.NullOr(AuditLabel),
  }),
  forced: Schema.Boolean,
  breakGlass: Schema.Boolean,
})
export type LegacyAuditEnvelopeV0 = typeof LegacyAuditEnvelopeV0.Type

export const AuditEnvelope = Schema.Union([AuditEnvelopeV1, LegacyAuditEnvelopeV0])
export type AuditEnvelope = typeof AuditEnvelope.Type

export const TenantAuditExportEvent = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.Literal('tenant'),
  id: AuditIdentifier,
  organizationId: AuditIdentifier,
  partitionKey: AuditLabel,
  exportRequestId: AuditIdentifier,
  /** The D1 staging time fixes the deterministic future-skew admission bound. */
  admittedAt: AuditTimestamp,
  envelope: AuditEnvelope,
})
export const PlatformAuditExportEvent = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.Literal('platform'),
  id: AuditIdentifier,
  partitionKey: AuditLabel,
  exportRequestId: AuditIdentifier,
  /** The D1 staging time fixes the deterministic future-skew admission bound. */
  admittedAt: AuditTimestamp,
  envelope: AuditEnvelope,
})
export const AuditExportEvent = Schema.Union([TenantAuditExportEvent, PlatformAuditExportEvent])
export type AuditExportEvent = typeof AuditExportEvent.Type

export class AuditEnvelopeError extends Schema.TaggedError<AuditEnvelopeError>()(
  'AuditEnvelopeError',
  {
    code: Schema.Literals([
      'invalid-envelope',
      'scope-mismatch',
      'result-mismatch',
      'source-mismatch',
      'timestamp-policy',
      'size-limit',
    ] as const),
    message: Schema.String,
  },
) {}

export const decodeAuditRequestContext = (
  input: unknown,
): Effect.Effect<AuditRequestContextValue, AuditEnvelopeError> =>
  Schema.decodeUnknownEffect(AuditRequestContextValue, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new AuditEnvelopeError({
          code: 'invalid-envelope',
          message: 'Audit request context is invalid',
        }),
    ),
  )

const secretLikeKey = (key: string): boolean => {
  // Envelope inputs cross multiple boundaries. Normalize compound/camelCase
  // names before deciding so secret-shaped values never reach immutable D1.
  const normalized = key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (normalized.startsWith('authorization') || normalized.startsWith('setcookie')) return true
  if (
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
    'apikey',
    'credential',
    'credentials',
    'privatekey',
    'plaintextkey',
    'datakey',
    'wrappedkey',
    'rconpassword',
    'rcon',
    'steamguard',
    'signingkey',
    'accesskey',
    'sessionkey',
    'clientkey',
  ].some((fragment) => normalized.includes(fragment))
}

/** Redacts recursively before any envelope reaches D1, Queue, or R2. */
export const redactAuditValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[REDACTED]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, seen))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return '[REDACTED]'
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) {
      output[key] = secretLikeKey(key)
        ? '[REDACTED]'
        : redactAuditValue(Reflect.get(value, key), seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

/** Keep every committed envelope below the R2 exporter's canonical JSON budget. */
export const AUDIT_ENVELOPE_LIMITS = {
  maximumCanonicalBytes: 80 * 1024,
  maximumSourceCharacters: 128 * 1024,
  maximumDepth: 12,
  maximumValues: 4_096,
  maximumArrayItems: 1_024,
  maximumObjectProperties: 512,
  maximumPropertyNameCharacters: 128,
  maximumScalarCharacters: 32 * 1024,
} as const

interface CanonicalAuditJsonObject {
  readonly [key: string]: CanonicalAuditJson
}

type CanonicalAuditJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalAuditJson>
  | CanonicalAuditJsonObject

class AuditBudgetFailure extends Error {}

interface AuditBudgetState {
  values: number
  sourceCharacters: number
  readonly ancestors: WeakSet<object>
}

const canonicalAuditValue = (
  value: unknown,
  depth: number,
  state: AuditBudgetState,
): CanonicalAuditJson => {
  state.values += 1
  if (
    state.values > AUDIT_ENVELOPE_LIMITS.maximumValues ||
    depth > AUDIT_ENVELOPE_LIMITS.maximumDepth
  ) {
    throw new AuditBudgetFailure()
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuditBudgetFailure()
    return value
  }
  if (typeof value === 'string') {
    state.sourceCharacters += value.length
    if (
      value.length > AUDIT_ENVELOPE_LIMITS.maximumScalarCharacters ||
      state.sourceCharacters > AUDIT_ENVELOPE_LIMITS.maximumSourceCharacters
    ) {
      throw new AuditBudgetFailure()
    }
    return value
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new AuditBudgetFailure()
  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > AUDIT_ENVELOPE_LIMITS.maximumArrayItems) throw new AuditBudgetFailure()
      return value.map((entry) => canonicalAuditValue(entry, depth + 1, state))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new AuditBudgetFailure()
    const keys = Object.keys(value).sort()
    if (keys.length > AUDIT_ENVELOPE_LIMITS.maximumObjectProperties) throw new AuditBudgetFailure()
    const output: Record<string, CanonicalAuditJson> = Object.create(null)
    for (const key of keys) {
      state.sourceCharacters += key.length
      if (
        key.length === 0 ||
        key.length > AUDIT_ENVELOPE_LIMITS.maximumPropertyNameCharacters ||
        hasControlCharacter(key) ||
        state.sourceCharacters > AUDIT_ENVELOPE_LIMITS.maximumSourceCharacters
      ) {
        throw new AuditBudgetFailure()
      }
      output[key] = canonicalAuditValue(Reflect.get(value, key), depth + 1, state)
    }
    return output
  } finally {
    state.ancestors.delete(value)
  }
}

const renderCanonicalAuditJson = (value: CanonicalAuditJson): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(renderCanonicalAuditJson).join(',')}]`
  const objectValue = value as CanonicalAuditJsonObject
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${renderCanonicalAuditJson(objectValue[key] ?? null)}`)
    .join(',')}}`
}

/**
 * Produces deterministic JSON with the one shared audit budget algorithm. The
 * envelope default is the commit-time limit; queue/R2 may use its larger
 * transport cap only after this same canonicalization has validated the value.
 */
export const canonicalAuditJson = (
  value: unknown,
  maximumCanonicalBytes = AUDIT_ENVELOPE_LIMITS.maximumCanonicalBytes,
): Effect.Effect<string, AuditEnvelopeError> =>
  Effect.try({
    try: () => {
      if (!Number.isSafeInteger(maximumCanonicalBytes) || maximumCanonicalBytes < 1) {
        throw new AuditBudgetFailure()
      }
      const canonical = renderCanonicalAuditJson(
        canonicalAuditValue(value, 0, { values: 0, sourceCharacters: 0, ancestors: new WeakSet() }),
      )
      if (new TextEncoder().encode(canonical).byteLength > maximumCanonicalBytes) {
        throw new AuditBudgetFailure()
      }
      return canonical
    },
    catch: () =>
      new AuditEnvelopeError({
        code: 'size-limit',
        message: 'Audit envelope exceeds the canonical archive budget',
      }),
  })

/** Produces stable JSON only when an envelope meets the commit-time budget. */
export const canonicalAuditEnvelopeJson = (
  value: unknown,
): Effect.Effect<string, AuditEnvelopeError> => canonicalAuditJson(value)

const sourceFailure = (message: string): Effect.Effect<never, AuditEnvelopeError> =>
  Effect.fail(new AuditEnvelopeError({ code: 'source-mismatch', message }))

/**
 * Keep source evidence internally coherent before it reaches the SQL fence.
 * SQL repeats these rules because privileged/raw writers do not call this
 * module.  Actor type is intentionally not used to infer origin: a scheduled
 * or machine execution may faithfully retain a human actor from its accepted
 * operation while still having non-HTTP execution provenance.
 */
const validateSource = (
  envelope: AuditEnvelope,
): Effect.Effect<AuditEnvelope, AuditEnvelopeError> => {
  const { source } = envelope
  if (envelope.version === 0) {
    return source.origin === 'legacy'
      ? Effect.succeed(envelope)
      : sourceFailure('A legacy audit envelope must use legacy source provenance')
  }
  if (source.origin === 'legacy') {
    return sourceFailure('A complete audit envelope cannot use legacy source provenance')
  }
  if (source.origin === 'http') {
    if (source.access.state !== 'captured') {
      return sourceFailure('An HTTP audit requires captured Access metadata')
    }
    const access = source.access.value
    if (access.subject === null || access.issuer === null || access.email === null) {
      return sourceFailure('An HTTP audit requires Access subject, issuer, and email')
    }
    if (envelope.actor.type === 'human' && access.identityId !== envelope.actor.id) {
      return sourceFailure('HTTP Access identity metadata does not match the human audit actor')
    }
    return Effect.succeed(envelope)
  }
  if (source.origin === 'machine') {
    return source.access.state === 'not-available'
      ? Effect.succeed(envelope)
      : sourceFailure('A machine audit cannot claim captured HTTP Access metadata')
  }
  if (source.ip.state !== 'not-available' || source.access.state !== 'not-available') {
    return sourceFailure('Scheduler and internal audits require unavailable request evidence')
  }
  return Effect.succeed(envelope)
}

const validateEnvelope = (
  envelope: AuditEnvelope,
): Effect.Effect<AuditEnvelope, AuditEnvelopeError> => {
  if (
    (envelope.scope === 'tenant' && envelope.organizationId === null) ||
    (envelope.scope === 'platform' && envelope.organizationId !== null)
  ) {
    return Effect.fail(
      new AuditEnvelopeError({
        code: 'scope-mismatch',
        message: 'Audit scope and organization do not match',
      }),
    )
  }
  if (
    envelope.version === 1 &&
    ((envelope.result === 'succeeded' && envelope.error.classification !== 'none') ||
      (envelope.result !== 'succeeded' && envelope.error.classification === 'none'))
  ) {
    return Effect.fail(
      new AuditEnvelopeError({
        code: 'result-mismatch',
        message: 'Audit result and error class do not match',
      }),
    )
  }
  return validateSource(envelope)
}

/**
 * Validate the one clock policy shared by staging and export.  `admittedAt`
 * is durable D1 evidence, so queue/R2 retries use the same decision without
 * consulting their current wall clock.
 */
export const validateAuditTimestampAdmission = (
  occurredAt: string,
  admittedAt: string,
): Effect.Effect<void, AuditEnvelopeError> =>
  Effect.gen(function* () {
    const occurred = yield* Schema.decodeUnknownEffect(AuditTimestamp)(occurredAt).pipe(
      Effect.mapError(
        () =>
          new AuditEnvelopeError({
            code: 'timestamp-policy',
            message: 'Audit occurrence time is invalid',
          }),
      ),
    )
    const admitted = yield* Schema.decodeUnknownEffect(AuditTimestamp)(admittedAt).pipe(
      Effect.mapError(
        () =>
          new AuditEnvelopeError({
            code: 'timestamp-policy',
            message: 'Audit admission time is invalid',
          }),
      ),
    )
    if (
      Date.parse(occurred) >
      Date.parse(admitted) + AUDIT_TIMESTAMP_ADMISSION_POLICY.maximumFutureSkewMilliseconds
    ) {
      return yield* new AuditEnvelopeError({
        code: 'timestamp-policy',
        message: 'Audit occurrence time exceeds the deterministic admission bound',
      })
    }
  })

export const decodeAuditEnvelope = (
  input: unknown,
): Effect.Effect<AuditEnvelope, AuditEnvelopeError> =>
  canonicalAuditEnvelopeJson(redactAuditValue(input)).pipe(
    Effect.flatMap((canonical) =>
      Schema.decodeUnknownEffect(AuditEnvelope, { onExcessProperty: 'error' })(
        JSON.parse(canonical),
      ).pipe(
        Effect.mapError(
          () =>
            new AuditEnvelopeError({
              code: 'invalid-envelope',
              message: 'Audit envelope is invalid',
            }),
        ),
      ),
    ),
    Effect.flatMap(validateEnvelope),
  )

export type CompleteAuditEnvelopeInput = Omit<
  AuditEnvelopeV1,
  'version' | 'captureStatus' | 'request' | 'source'
> & {
  readonly request: AuditRequestContextValue
}

const sourceForActor = (
  source: AuditRequestSource,
  actor: AuditEnvelopeV1['actor'],
  origin: AuditRequestOrigin,
): Effect.Effect<AuditSource, AuditEnvelopeError> => {
  const withOrigin: AuditSource = { origin, ...source }
  if (actor.type !== 'human' || origin !== 'http') return Effect.succeed(withOrigin)
  if (source.access.state !== 'captured') {
    return Effect.fail(
      new AuditEnvelopeError({
        code: 'source-mismatch',
        message: 'A human HTTP audit requires captured Access metadata',
      }),
    )
  }
  const access = source.access.value
  if (access.subject === null || access.issuer === null || access.email === null) {
    return Effect.fail(
      new AuditEnvelopeError({
        code: 'source-mismatch',
        message: 'A human HTTP audit requires Access subject, issuer, and email',
      }),
    )
  }
  if (access.identityId !== null && access.identityId !== actor.id) {
    return Effect.fail(
      new AuditEnvelopeError({
        code: 'source-mismatch',
        message: 'Access identity metadata does not match the human audit actor',
      }),
    )
  }
  return Effect.succeed({
    ...withOrigin,
    access: {
      state: 'captured',
      value: { ...access, identityId: actor.id },
    },
  })
}

/** Builds a complete v1 envelope and binds a resolved human actor to Access metadata. */
export const completeAuditEnvelope = (
  input: CompleteAuditEnvelopeInput,
): Effect.Effect<AuditEnvelopeV1, AuditEnvelopeError> =>
  sourceForActor(input.request.source, input.actor, input.request.origin).pipe(
    Effect.flatMap((source) =>
      decodeAuditEnvelope({
        version: 1,
        captureStatus: 'complete',
        ...input,
        request: { id: input.request.requestId, correlationId: input.request.correlationId },
        source,
      }),
    ),
    Effect.flatMap((decoded) =>
      decoded.version === 1
        ? Effect.succeed(decoded)
        : Effect.fail(
            new AuditEnvelopeError({ code: 'invalid-envelope', message: 'Expected a v1 envelope' }),
          ),
    ),
  )

/** Reads request metadata from the scoped service; internal callers provide the same service explicitly. */
export const completeAuditEnvelopeFromRequestContext = (
  input: Omit<CompleteAuditEnvelopeInput, 'request'>,
): Effect.Effect<AuditEnvelopeV1, AuditEnvelopeError, AuditRequestContext> =>
  Effect.gen(function* () {
    const request = yield* AuditRequestContext
    return yield* completeAuditEnvelope({ ...input, request })
  })

/** The compact audit row mirrors the exact post-state, including a typed absent post-state. */
export const auditEventSummaryJson = (envelope: AuditEnvelopeV1): string =>
  JSON.stringify(
    envelope.after.state === 'captured'
      ? envelope.after.summary
      : { state: 'absent', reason: envelope.after.reason },
  )

export const tenantAuditPartitionKey = (organizationId: string): string => `${organizationId}:audit`
export const platformAuditPartitionKey = 'platform:audit'

export interface AuditEnvelopeStage {
  readonly eventTable: 'tenant' | 'platform'
  readonly eventId: string
  readonly organizationId: string | null
  readonly envelopeJson: string
  readonly stagedAt: string
}

export const auditEnvelopeStageSql = `INSERT INTO audit_envelope_staging
  (event_table, event_id, organization_id, envelope_json, staged_at)
  VALUES (?, ?, ?, ?, ?)`

export const stageAuditEnvelope = (
  eventTable: AuditEnvelopeStage['eventTable'],
  eventId: string,
  envelope: unknown,
  stagedAt: string,
): Effect.Effect<AuditEnvelopeStage, AuditEnvelopeError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeAuditEnvelope(envelope)
    const validEventId = yield* Schema.decodeUnknownEffect(AuditIdentifier)(eventId).pipe(
      Effect.mapError(
        () =>
          new AuditEnvelopeError({
            code: 'invalid-envelope',
            message: 'Audit event id is invalid',
          }),
      ),
    )
    const validStagedAt = yield* Schema.decodeUnknownEffect(AuditTimestamp)(stagedAt).pipe(
      Effect.mapError(
        () =>
          new AuditEnvelopeError({
            code: 'invalid-envelope',
            message: 'Audit staged time is invalid',
          }),
      ),
    )
    yield* validateAuditTimestampAdmission(decoded.occurredAt, validStagedAt)
    if ((eventTable === 'tenant') !== (decoded.scope === 'tenant')) {
      return yield* new AuditEnvelopeError({
        code: 'scope-mismatch',
        message: 'Audit stage table and envelope scope do not match',
      })
    }
    return {
      eventTable,
      eventId: validEventId,
      organizationId: decoded.organizationId,
      envelopeJson: JSON.stringify(decoded),
      stagedAt: validStagedAt,
    }
  })

export const auditEnvelopeStageBindings = (
  stage: AuditEnvelopeStage,
): ReadonlyArray<string | null> => [
  stage.eventTable,
  stage.eventId,
  stage.organizationId,
  stage.envelopeJson,
  stage.stagedAt,
]

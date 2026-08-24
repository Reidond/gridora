import { Context, Effect, Layer, Schema } from 'effect'
import { IsoDateTime, type OrganizationContext, OrganizationId } from '@gridora/domain'

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
)
const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

export class SecretEnvelopeRecord extends Schema.Class<SecretEnvelopeRecord>(
  'SecretEnvelopeRecord',
)({
  organizationId: OrganizationId,
  id: identifier,
  scopeType: identifier,
  scopeId: identifier,
  ciphertext: Schema.String,
  wrappedDataKey: Schema.String,
  keyVersion: positiveInteger,
  revision: positiveInteger,
  createdAt: IsoDateTime,
  rotatedAt: Schema.NullOr(IsoDateTime),
}) {}

export interface SecretLocator {
  readonly id: string
  readonly scopeType: string
  readonly scopeId: string
}
export interface SealSecretInput extends SecretLocator {
  readonly plaintext: Uint8Array
  readonly now: string
}
export interface RotateSecretInput extends SecretLocator {
  readonly expectedRevision: number
  readonly now: string
}
export interface DeleteSecretInput extends SecretLocator {
  readonly expectedRevision: number
}

const safeErrorFields = { operation: Schema.String, message: Schema.String }
export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()(
  'SecretNotFoundError',
  safeErrorFields,
) {}
export class SecretConflictError extends Schema.TaggedError<SecretConflictError>()(
  'SecretConflictError',
  safeErrorFields,
) {}
export class SecretRevisionConflictError extends Schema.TaggedError<SecretRevisionConflictError>()(
  'SecretRevisionConflictError',
  { ...safeErrorFields, expectedRevision: positiveInteger },
) {}
export class SecretIntegrityError extends Schema.TaggedError<SecretIntegrityError>()(
  'SecretIntegrityError',
  safeErrorFields,
) {}
export class SecretPersistenceError extends Schema.TaggedError<SecretPersistenceError>()(
  'SecretPersistenceError',
  safeErrorFields,
) {}
export class SecretKekError extends Schema.TaggedError<SecretKekError>()(
  'SecretKekError',
  safeErrorFields,
) {}
export type SecretEnvelopeError =
  | SecretNotFoundError
  | SecretConflictError
  | SecretRevisionConflictError
  | SecretIntegrityError
  | SecretPersistenceError
  | SecretKekError

export interface SecretEnvelopeRepositoryShape {
  readonly create: (
    context: OrganizationContext,
    record: SecretEnvelopeRecord,
  ) => Effect.Effect<
    SecretEnvelopeRecord,
    SecretConflictError | SecretIntegrityError | SecretPersistenceError
  >
  readonly get: (
    context: OrganizationContext,
    locator: SecretLocator,
  ) => Effect.Effect<SecretEnvelopeRecord, SecretNotFoundError | SecretPersistenceError>
  readonly replace: (
    context: OrganizationContext,
    record: SecretEnvelopeRecord,
    expectedRevision: number,
  ) => Effect.Effect<SecretEnvelopeRecord, SecretEnvelopeError>
  readonly delete: (
    context: OrganizationContext,
    locator: SecretLocator,
    expectedRevision: number,
  ) => Effect.Effect<void, SecretEnvelopeError>
}
export class SecretEnvelopeRepository extends Context.Service<
  SecretEnvelopeRepository,
  SecretEnvelopeRepositoryShape
>()('@gridora/secret-envelope/SecretEnvelopeRepository') {}

export interface KekPortShape {
  readonly activeKeyVersion: Effect.Effect<number, SecretKekError>
  readonly wrap: (
    keyVersion: number,
    dataKey: Uint8Array,
    authenticatedData: Uint8Array,
  ) => Effect.Effect<Uint8Array, SecretKekError>
  readonly unwrap: (
    keyVersion: number,
    wrappedDataKey: Uint8Array,
    authenticatedData: Uint8Array,
  ) => Effect.Effect<Uint8Array, SecretKekError>
}
export class KekPort extends Context.Service<KekPort, KekPortShape>()(
  '@gridora/secret-envelope/KekPort',
) {}
export const KekPortLayer = (port: KekPortShape) => Layer.succeed(KekPort, port)

export interface SecretEnvelopeServiceShape {
  readonly seal: (
    context: OrganizationContext,
    input: SealSecretInput,
  ) => Effect.Effect<SecretEnvelopeRecord, SecretEnvelopeError>
  readonly open: (
    context: OrganizationContext,
    locator: SecretLocator,
  ) => Effect.Effect<Uint8Array, SecretEnvelopeError>
  readonly rotate: (
    context: OrganizationContext,
    input: RotateSecretInput,
  ) => Effect.Effect<SecretEnvelopeRecord, SecretEnvelopeError>
  readonly delete: (
    context: OrganizationContext,
    input: DeleteSecretInput,
  ) => Effect.Effect<void, SecretEnvelopeError>
}
export class SecretEnvelopeService extends Context.Service<
  SecretEnvelopeService,
  SecretEnvelopeServiceShape
>()('@gridora/secret-envelope/SecretEnvelopeService') {}

const encoder = new TextEncoder()
const bufferSource = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const base64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const unbase64 = (encoded: string) => {
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
const aad = (organizationId: string, locator: SecretLocator) =>
  encoder.encode(
    [organizationId, locator.scopeType, locator.scopeId, locator.id]
      .map((part) => `${encoder.encode(part).byteLength}:${part}`)
      .join('|'),
  )
const cryptoFailure = (operation: string) =>
  new SecretIntegrityError({ operation, message: 'secret authentication failed' })
const cryptoAttempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => cryptoFailure(operation) })

const encrypt = (plaintext: Uint8Array, dataKey: Uint8Array, authenticatedData: Uint8Array) =>
  Effect.gen(function* () {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = yield* cryptoAttempt('secret.encrypt', () =>
      crypto.subtle.importKey('raw', bufferSource(dataKey), 'AES-GCM', false, ['encrypt']),
    )
    const ciphertext = yield* cryptoAttempt('secret.encrypt', () =>
      crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: bufferSource(iv),
          additionalData: bufferSource(authenticatedData),
          tagLength: 128,
        },
        key,
        bufferSource(plaintext),
      ),
    )
    return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`
  })
const decrypt = (encoded: string, dataKey: Uint8Array, authenticatedData: Uint8Array) =>
  Effect.gen(function* () {
    const [version, ivEncoded, ciphertextEncoded, extra] = encoded.split('.')
    if (
      version !== 'v1' ||
      ivEncoded === undefined ||
      ciphertextEncoded === undefined ||
      extra !== undefined
    )
      return yield* cryptoFailure('secret.decrypt')
    const decoded = yield* Effect.try({
      try: () => ({ iv: unbase64(ivEncoded), ciphertext: unbase64(ciphertextEncoded) }),
      catch: () => cryptoFailure('secret.decrypt'),
    })
    const key = yield* cryptoAttempt('secret.decrypt', () =>
      crypto.subtle.importKey('raw', bufferSource(dataKey), 'AES-GCM', false, ['decrypt']),
    )
    const plaintext = yield* cryptoAttempt('secret.decrypt', () =>
      crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bufferSource(decoded.iv),
          additionalData: bufferSource(authenticatedData),
          tagLength: 128,
        },
        key,
        bufferSource(decoded.ciphertext),
      ),
    )
    return new Uint8Array(plaintext)
  })

const decryptRecord = (kek: KekPortShape, record: SecretEnvelopeRecord, locator: SecretLocator) =>
  Effect.gen(function* () {
    const authenticatedData = aad(record.organizationId, locator)
    const wrapped = yield* Effect.try({
      try: () => unbase64(record.wrappedDataKey),
      catch: () => cryptoFailure('secret.unwrap'),
    })
    const dataKey = yield* kek.unwrap(record.keyVersion, wrapped, authenticatedData)
    return yield* decrypt(record.ciphertext, dataKey, authenticatedData).pipe(
      Effect.ensuring(Effect.sync(() => dataKey.fill(0))),
    )
  })

const makeEncryptedRecord = (
  kek: KekPortShape,
  context: OrganizationContext,
  input: SealSecretInput,
  revision: number,
  createdAt: string,
  rotatedAt: string | null,
) =>
  Effect.gen(function* () {
    const authenticatedData = aad(context.organizationId, input)
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    return yield* Effect.gen(function* () {
      const keyVersion = yield* kek.activeKeyVersion
      const ciphertext = yield* encrypt(input.plaintext, dataKey, authenticatedData)
      const wrappedDataKey = yield* kek.wrap(keyVersion, dataKey, authenticatedData)
      return yield* Schema.decodeUnknownEffect(SecretEnvelopeRecord)({
        organizationId: context.organizationId,
        id: input.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        ciphertext,
        wrappedDataKey: base64(wrappedDataKey),
        keyVersion,
        revision,
        createdAt,
        rotatedAt,
      }).pipe(
        Effect.mapError(
          () =>
            new SecretIntegrityError({
              operation: 'secret.seal',
              message: 'invalid secret envelope',
            }),
        ),
      )
    }).pipe(Effect.ensuring(Effect.sync(() => dataKey.fill(0))))
  })

/** Prepare an authenticated envelope for inclusion in a larger atomic D1 transaction. */
export const prepareSecretEnvelope = (
  context: OrganizationContext,
  input: SealSecretInput,
): Effect.Effect<SecretEnvelopeRecord, SecretEnvelopeError, KekPort> =>
  Effect.flatMap(KekPort, (kek) => makeEncryptedRecord(kek, context, input, 1, input.now, null))

/** Prepare a revision-fenced replacement without persisting either version. */
export const prepareSecretEnvelopeReplacement = (
  context: OrganizationContext,
  existing: SecretEnvelopeRecord,
  plaintext: Uint8Array,
  now: string,
): Effect.Effect<SecretEnvelopeRecord, SecretEnvelopeError, KekPort> => {
  if (existing.organizationId !== context.organizationId) {
    return Effect.fail(
      new SecretIntegrityError({
        operation: 'secret.prepareReplacement',
        message: 'organization binding mismatch',
      }),
    )
  }
  return Effect.flatMap(KekPort, (kek) =>
    makeEncryptedRecord(
      kek,
      context,
      {
        id: existing.id,
        scopeType: existing.scopeType,
        scopeId: existing.scopeId,
        plaintext,
        now,
      },
      existing.revision + 1,
      existing.createdAt,
      now,
    ),
  )
}

export const makeSecretEnvelopeService = (
  repository: SecretEnvelopeRepositoryShape,
  kek: KekPortShape,
): SecretEnvelopeServiceShape => ({
  seal: (context, input) =>
    Effect.flatMap(makeEncryptedRecord(kek, context, input, 1, input.now, null), (record) =>
      repository.create(context, record),
    ),
  open: (context, locator) =>
    Effect.flatMap(repository.get(context, locator), (record) =>
      decryptRecord(kek, record, locator),
    ),
  rotate: (context, input) =>
    Effect.gen(function* () {
      const existing = yield* repository.get(context, input)
      if (existing.revision !== input.expectedRevision)
        return yield* new SecretRevisionConflictError({
          operation: 'secret.rotate',
          message: 'secret envelope revision changed',
          expectedRevision: input.expectedRevision,
        })
      const plaintext = yield* decryptRecord(kek, existing, input)
      return yield* makeEncryptedRecord(
        kek,
        context,
        { ...input, plaintext, now: input.now },
        existing.revision + 1,
        existing.createdAt,
        input.now,
      ).pipe(
        Effect.flatMap((replacement) =>
          repository.replace(context, replacement, input.expectedRevision),
        ),
        Effect.ensuring(Effect.sync(() => plaintext.fill(0))),
      )
    }),
  delete: (context, input) => repository.delete(context, input, input.expectedRevision),
})

export const SecretEnvelopeServiceLive = Layer.effect(
  SecretEnvelopeService,
  Effect.gen(function* () {
    const repository = yield* SecretEnvelopeRepository
    const kek = yield* KekPort
    return SecretEnvelopeService.of(makeSecretEnvelopeService(repository, kek))
  }),
)

const sensitiveField =
  /authorization|cookie|credential|password|secret|token|assertion|private[_-]?key|data[_-]?key|wrapped[_-]?data[_-]?key|ciphertext|plaintext|rcon|kek/i
/** Apply at every logger/audit/error serialization boundary for secret operations. */
export const redactSecretEnvelope = (value: unknown, key = ''): unknown => {
  if (sensitiveField.test(key) || value instanceof Uint8Array || value instanceof ArrayBuffer)
    return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactSecretEnvelope(item))
  if (value !== null && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: '[REDACTED]' }
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecretEnvelope(entryValue, entryKey),
      ]),
    )
  }
  return value
}

export interface SecretLogSink {
  readonly write: (event: string, fields: Readonly<Record<string, unknown>>) => Effect.Effect<void>
}
export const makeRedactedSecretLogSink = (sink: SecretLogSink): SecretLogSink => ({
  write: (event, fields) =>
    sink.write(event, redactSecretEnvelope(fields) as Readonly<Record<string, unknown>>),
})

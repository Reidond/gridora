import { Context, Effect, Layer, Schema } from 'effect'
import { KekPort, type KekPortShape, SecretKekError } from '@gridora/secret-envelope'

const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export class PlatformSecretRecord extends Schema.Class<PlatformSecretRecord>(
  'PlatformSecretRecord',
)({
  id: Schema.String,
  accountId: Schema.String,
  ciphertext: Schema.String,
  wrappedDataKey: Schema.String,
  keyVersion: Positive,
  revision: Positive,
  createdAt: Schema.String,
  rotatedAt: Schema.NullOr(Schema.String),
}) {}
export class PlatformSecretError extends Schema.TaggedError<PlatformSecretError>()(
  'PlatformSecretError',
  {
    operation: Schema.String,
    code: Schema.Literals(['not_found', 'conflict', 'integrity', 'persistence', 'account_busy']),
  },
) {}
export interface PlatformSecretRepositoryShape {
  readonly get: (accountId: string) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly create: (
    record: PlatformSecretRecord,
  ) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly replace: (
    record: PlatformSecretRecord,
    expectedRevision: number,
  ) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly remove: (
    accountId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, PlatformSecretError>
}
export class PlatformSecretRepository extends Context.Service<
  PlatformSecretRepository,
  PlatformSecretRepositoryShape
>()('@gridora/platform-secret-envelope/Repository') {}
export const PlatformSecretRepositoryLayer = (repo: PlatformSecretRepositoryShape) =>
  Layer.succeed(PlatformSecretRepository, repo)
export interface PlatformSecretEnvelopeShape {
  readonly getRecord: (
    accountId: string,
  ) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly prepareSeal: (input: {
    readonly id: string
    readonly accountId: string
    readonly plaintext: Uint8Array
    readonly now: string
  }) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly prepareRotation: (input: {
    readonly current: PlatformSecretRecord
    readonly plaintext: Uint8Array
    readonly now: string
  }) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly seal: (input: {
    readonly id: string
    readonly accountId: string
    readonly plaintext: Uint8Array
    readonly now: string
  }) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly open: (accountId: string) => Effect.Effect<Uint8Array, PlatformSecretError>
  readonly rotate: (input: {
    readonly accountId: string
    readonly expectedRevision: number
    readonly plaintext: Uint8Array
    readonly now: string
  }) => Effect.Effect<PlatformSecretRecord, PlatformSecretError>
  readonly remove: (
    accountId: string,
    expectedRevision: number,
  ) => Effect.Effect<void, PlatformSecretError>
}
export class PlatformSecretEnvelope extends Context.Service<
  PlatformSecretEnvelope,
  PlatformSecretEnvelopeShape
>()('@gridora/platform-secret-envelope/Service') {}

const encoder = new TextEncoder()
const source = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
const aad = (id: string, accountId: string) =>
  encoder.encode(`platform|provider-account|${id.length}:${id}|${accountId.length}:${accountId}`)
const failure = (operation: string, code: PlatformSecretError['code'] = 'integrity') =>
  new PlatformSecretError({ operation, code })
const cryptoTry = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: () => failure(operation) })
const mapKek = (operation: string) => (_: SecretKekError) => failure(operation)

const encrypt = (plaintext: Uint8Array, key: Uint8Array, authenticatedData: Uint8Array) =>
  Effect.gen(function* () {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const imported = yield* cryptoTry('platformSecret.encrypt', () =>
      crypto.subtle.importKey('raw', source(key), 'AES-GCM', false, ['encrypt']),
    )
    const encrypted = yield* cryptoTry('platformSecret.encrypt', () =>
      crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: source(iv), additionalData: source(authenticatedData) },
        imported,
        source(plaintext),
      ),
    )
    return `v1.${b64(iv)}.${b64(new Uint8Array(encrypted))}`
  })
const decrypt = (encoded: string, key: Uint8Array, authenticatedData: Uint8Array) =>
  Effect.gen(function* () {
    const [version, ivText, ciphertextText, extra] = encoded.split('.')
    if (
      version !== 'v1' ||
      ivText === undefined ||
      ciphertextText === undefined ||
      extra !== undefined
    )
      return yield* failure('platformSecret.decrypt')
    const iv = yield* Effect.try({
      try: () => unb64(ivText),
      catch: () => failure('platformSecret.decrypt'),
    })
    const ciphertext = yield* Effect.try({
      try: () => unb64(ciphertextText),
      catch: () => failure('platformSecret.decrypt'),
    })
    const imported = yield* cryptoTry('platformSecret.decrypt', () =>
      crypto.subtle.importKey('raw', source(key), 'AES-GCM', false, ['decrypt']),
    )
    const plaintext = yield* cryptoTry('platformSecret.decrypt', () =>
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: source(iv), additionalData: source(authenticatedData) },
        imported,
        source(ciphertext),
      ),
    )
    return new Uint8Array(plaintext)
  })
const sealRecord = (
  kek: KekPortShape,
  repo: PlatformSecretRepositoryShape,
  input: { id: string; accountId: string; plaintext: Uint8Array; now: string },
  revision: number,
  create: boolean,
) =>
  Effect.gen(function* () {
    const authenticatedData = aad(input.id, input.accountId)
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    try {
      const keyVersion = yield* kek.activeKeyVersion.pipe(
        Effect.mapError(mapKek('platformSecret.keyVersion')),
      )
      const ciphertext = yield* encrypt(input.plaintext, dataKey, authenticatedData)
      const wrapped = yield* kek
        .wrap(keyVersion, dataKey, authenticatedData)
        .pipe(Effect.mapError(mapKek('platformSecret.wrap')))
      const record = new PlatformSecretRecord({
        id: input.id,
        accountId: input.accountId,
        ciphertext,
        wrappedDataKey: b64(wrapped),
        keyVersion,
        revision,
        createdAt: input.now,
        rotatedAt: create ? null : input.now,
      })
      return yield* create ? repo.create(record) : repo.replace(record, revision - 1)
    } finally {
      dataKey.fill(0)
      authenticatedData.fill(0)
    }
  })
export const makePlatformSecretEnvelope = (
  repo: PlatformSecretRepositoryShape,
  kek: KekPortShape,
): PlatformSecretEnvelopeShape => ({
  getRecord: repo.get,
  prepareSeal: (input) =>
    Effect.acquireUseRelease(
      Effect.succeed(input.plaintext),
      (plaintext) =>
        sealRecord(
          kek,
          { ...repo, create: Effect.succeed, replace: (record) => Effect.succeed(record) },
          { ...input, plaintext },
          1,
          true,
        ),
      (plaintext) => Effect.sync(() => plaintext.fill(0)),
    ),
  prepareRotation: (input) =>
    Effect.acquireUseRelease(
      Effect.succeed(input.plaintext),
      (plaintext) =>
        sealRecord(
          kek,
          { ...repo, create: Effect.succeed, replace: (record) => Effect.succeed(record) },
          { id: input.current.id, accountId: input.current.accountId, plaintext, now: input.now },
          input.current.revision + 1,
          false,
        ),
      (plaintext) => Effect.sync(() => plaintext.fill(0)),
    ),
  seal: (input) =>
    Effect.acquireUseRelease(
      Effect.succeed(input.plaintext),
      (plaintext) => sealRecord(kek, repo, { ...input, plaintext }, 1, true),
      (plaintext) => Effect.sync(() => plaintext.fill(0)),
    ),
  open: (accountId) =>
    Effect.gen(function* () {
      const record = yield* repo.get(accountId)
      const authenticatedData = aad(record.id, accountId)
      return yield* Effect.acquireUseRelease(
        Effect.try({
          try: () => unb64(record.wrappedDataKey),
          catch: () => failure('platformSecret.unwrap'),
        }),
        (wrapped) =>
          Effect.gen(function* () {
            const dataKey = yield* kek
              .unwrap(record.keyVersion, wrapped, authenticatedData)
              .pipe(Effect.mapError(mapKek('platformSecret.unwrap')))
            return yield* Effect.acquireUseRelease(
              Effect.succeed(dataKey),
              (key) => decrypt(record.ciphertext, key, authenticatedData),
              (key) => Effect.sync(() => key.fill(0)),
            )
          }),
        (wrapped) =>
          Effect.sync(() => {
            authenticatedData.fill(0)
            wrapped.fill(0)
          }),
      )
    }),
  rotate: (input) =>
    Effect.acquireUseRelease(
      Effect.succeed(input.plaintext),
      (plaintext) =>
        Effect.gen(function* () {
          const current = yield* repo.get(input.accountId)
          if (current.revision !== input.expectedRevision)
            return yield* failure('platformSecret.rotate', 'conflict')
          return yield* sealRecord(
            kek,
            repo,
            { id: current.id, accountId: input.accountId, plaintext, now: input.now },
            current.revision + 1,
            false,
          )
        }),
      (plaintext) => Effect.sync(() => plaintext.fill(0)),
    ),
  remove: (accountId, expectedRevision) => repo.remove(accountId, expectedRevision),
})
export const PlatformSecretEnvelopeLive = Layer.effect(
  PlatformSecretEnvelope,
  Effect.gen(function* () {
    return makePlatformSecretEnvelope(yield* PlatformSecretRepository, yield* KekPort)
  }),
)

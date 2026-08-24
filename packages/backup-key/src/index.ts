import { Context, Effect, Layer, Schema } from 'effect'
import {
  BackupDataKeyPort,
  BackupR2Error,
  type BackupDataKey,
  type BackupDataKeyPortShape,
  type BackupKeyCoordinates,
} from '@gridora/backup-r2'
import { KekPort, type KekPortShape } from '@gridora/secret-envelope'

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
)
const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
export class BackupWrappedKeyRecord extends Schema.Class<BackupWrappedKeyRecord>(
  'BackupWrappedKeyRecord',
)({
  organizationId: identifier,
  serverId: identifier,
  backupId: identifier,
  keyVersion: positiveInteger,
  wrappedDataKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  revision: Schema.Literal(1),
}) {}

export type BackupKeyInsertResult =
  | { readonly kind: 'inserted'; readonly record: BackupWrappedKeyRecord }
  | { readonly kind: 'existing'; readonly record: BackupWrappedKeyRecord }

/**
 * Must atomically insert the candidate or return the already stored record for the exact composite
 * coordinates. It must never fall back to an unscoped backup ID lookup.
 */
export interface BackupKeyRepositoryPortShape {
  readonly insertOrGet: (
    candidate: BackupWrappedKeyRecord,
  ) => Effect.Effect<BackupKeyInsertResult, BackupR2Error>
  readonly get: (
    coordinates: BackupKeyCoordinates,
  ) => Effect.Effect<BackupWrappedKeyRecord | null, BackupR2Error>
}
export class BackupKeyRepositoryPort extends Context.Service<
  BackupKeyRepositoryPort,
  BackupKeyRepositoryPortShape
>()('@gridora/backup-key/BackupKeyRepositoryPort') {}
export const BackupKeyRepositoryPortLayer = (repository: BackupKeyRepositoryPortShape) =>
  Layer.succeed(BackupKeyRepositoryPort, repository)

export interface BackupKeyRandomShape {
  readonly bytes: (length: number) => Uint8Array
}
export class BackupKeyRandom extends Context.Service<BackupKeyRandom, BackupKeyRandomShape>()(
  '@gridora/backup-key/BackupKeyRandom',
) {}
export const WebCryptoBackupKeyRandom: BackupKeyRandomShape = {
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
}
export const BackupKeyRandomLayer = (random: BackupKeyRandomShape = WebCryptoBackupKeyRandom) =>
  Layer.succeed(BackupKeyRandom, random)

const textEncoder = new TextEncoder()
const aad = (coordinates: BackupKeyCoordinates) =>
  textEncoder.encode(
    [
      'gridora-backup-key-v1',
      coordinates.organizationId,
      coordinates.serverId,
      coordinates.backupId,
    ]
      .map((part) => `${textEncoder.encode(part).byteLength}:${part}`)
      .join('|'),
  )
const base64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const unbase64 = (value: string) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('invalid encoding')
  const binary = atob(value)
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (base64(decoded) !== value) throw new Error('non-canonical encoding')
  return decoded
}
const genericFailure = (operation: string) =>
  new BackupR2Error({
    code: 'key-failed',
    operation,
    message: 'backup key operation failed',
  })
const safeCoordinates = (coordinates: BackupKeyCoordinates) =>
  [coordinates.organizationId, coordinates.serverId, coordinates.backupId].every(
    (value) => value !== '.' && value !== '..' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value),
  )
const mapGeneric = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
  Effect.mapError(effect, () => genericFailure(operation))
const decodeRecord = (value: unknown) =>
  Schema.decodeUnknownEffect(BackupWrappedKeyRecord)(value).pipe(
    Effect.mapError(() => genericFailure('backupKey.record')),
  )
const matches = (record: BackupWrappedKeyRecord, coordinates: BackupKeyCoordinates) =>
  record.organizationId === coordinates.organizationId &&
  record.serverId === coordinates.serverId &&
  record.backupId === coordinates.backupId

const unwrapRecord = (
  kek: KekPortShape,
  coordinates: BackupKeyCoordinates,
  record: BackupWrappedKeyRecord,
) =>
  Effect.gen(function* () {
    if (!matches(record, coordinates)) return yield* genericFailure('backupKey.unwrap')
    const wrapped = yield* Effect.try({
      try: () => unbase64(record.wrappedDataKey),
      catch: () => genericFailure('backupKey.unwrap'),
    })
    const plaintext = yield* mapGeneric(
      'backupKey.unwrap',
      kek.unwrap(record.keyVersion, wrapped, aad(coordinates)),
    ).pipe(Effect.ensuring(Effect.sync(() => wrapped.fill(0))))
    if (plaintext.byteLength !== 32) {
      plaintext.fill(0)
      return yield* genericFailure('backupKey.unwrap')
    }
    return {
      plaintextKey: plaintext,
      wrappedDataKey: record.wrappedDataKey,
      keyVersion: record.keyVersion,
    } satisfies BackupDataKey
  })

export const BackupDataKeyPortLive = Layer.effect(
  BackupDataKeyPort,
  Effect.gen(function* () {
    const repository = yield* BackupKeyRepositoryPort
    const kek = yield* KekPort
    const random = yield* BackupKeyRandom
    const adopt = (coordinates: BackupKeyCoordinates) =>
      Effect.gen(function* () {
        const existing = yield* mapGeneric('backupKey.repository.get', repository.get(coordinates))
        if (existing === null) return yield* genericFailure('backupKey.issue')
        const decoded = yield* decodeRecord(existing)
        return yield* unwrapRecord(kek, coordinates, decoded)
      })
    const port: BackupDataKeyPortShape = {
      issue: (coordinates) =>
        Effect.gen(function* () {
          if (!safeCoordinates(coordinates)) return yield* genericFailure('backupKey.issue')
          const plaintext = yield* Effect.try({
            try: () => random.bytes(32),
            catch: () => genericFailure('backupKey.random'),
          })
          if (plaintext.byteLength !== 32) {
            plaintext.fill(0)
            return yield* genericFailure('backupKey.random')
          }
          const versionResult = yield* Effect.result(
            mapGeneric('backupKey.activeVersion', kek.activeKeyVersion),
          )
          if (versionResult._tag === 'Failure') {
            plaintext.fill(0)
            return yield* versionResult.failure
          }
          const keyVersion = versionResult.success
          if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
            plaintext.fill(0)
            return yield* genericFailure('backupKey.activeVersion')
          }
          const wrappedResult = yield* Effect.result(
            mapGeneric('backupKey.wrap', kek.wrap(keyVersion, plaintext, aad(coordinates))),
          )
          if (wrappedResult._tag === 'Failure') {
            plaintext.fill(0)
            return yield* wrappedResult.failure
          }
          const wrapped = wrappedResult.success
          const encodedResult = yield* Effect.result(
            Effect.try({
              try: () => base64(wrapped),
              catch: () => genericFailure('backupKey.wrap'),
            }),
          )
          wrapped.fill(0)
          if (encodedResult._tag === 'Failure') {
            plaintext.fill(0)
            return yield* encodedResult.failure
          }
          const wrappedDataKey = encodedResult.success
          const candidateResult = yield* Effect.result(
            decodeRecord({
              ...coordinates,
              keyVersion,
              wrappedDataKey,
              revision: 1,
            }),
          )
          if (candidateResult._tag === 'Failure') {
            plaintext.fill(0)
            return yield* candidateResult.failure
          }
          const candidate = candidateResult.success
          const persisted = yield* Effect.result(
            mapGeneric('backupKey.repository.insertOrGet', repository.insertOrGet(candidate)),
          )
          if (persisted._tag === 'Failure') {
            plaintext.fill(0)
            return yield* adopt(coordinates)
          }
          const storedResult = yield* Effect.result(decodeRecord(persisted.success.record))
          if (storedResult._tag === 'Failure') {
            plaintext.fill(0)
            return yield* storedResult.failure
          }
          const stored = storedResult.success
          if (!matches(stored, coordinates)) {
            plaintext.fill(0)
            return yield* genericFailure('backupKey.issue')
          }
          if (
            persisted.success.kind === 'inserted' &&
            stored.keyVersion === keyVersion &&
            stored.wrappedDataKey === wrappedDataKey
          )
            return { plaintextKey: plaintext, wrappedDataKey, keyVersion }
          plaintext.fill(0)
          return yield* unwrapRecord(kek, coordinates, stored)
        }),
      unwrap: (coordinates, keyVersion, wrappedDataKey) =>
        Effect.gen(function* () {
          if (!safeCoordinates(coordinates) || !Number.isSafeInteger(keyVersion) || keyVersion <= 0)
            return yield* genericFailure('backupKey.unwrap')
          const record = yield* decodeRecord({
            ...coordinates,
            keyVersion,
            wrappedDataKey,
            revision: 1,
          })
          const result = yield* unwrapRecord(kek, coordinates, record)
          return result.plaintextKey
        }),
    }
    return BackupDataKeyPort.of(port)
  }),
)

export const makeBackupDataKeyPortLayer = (
  repository: BackupKeyRepositoryPortShape,
  kek: KekPortShape,
  random: BackupKeyRandomShape = WebCryptoBackupKeyRandom,
) =>
  BackupDataKeyPortLive.pipe(
    Layer.provide(BackupKeyRepositoryPortLayer(repository)),
    Layer.provide(Layer.succeed(KekPort, kek)),
    Layer.provide(BackupKeyRandomLayer(random)),
  )

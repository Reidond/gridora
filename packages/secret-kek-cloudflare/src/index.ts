import { Effect, Layer } from 'effect'
import { KekPort, type KekPortShape, SecretKekError } from '@gridora/secret-envelope'

export interface SecretsStoreSecretBinding {
  readonly get: () => Promise<string>
}

export interface CloudflareKekKeyring {
  readonly activeVersion: number
  readonly keys: Readonly<Record<number, SecretsStoreSecretBinding>>
}

const envelopeVersion = 1
const ivLength = 12
const minimumWrappedLength = 1 + ivLength + 16

const bufferSource = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid KEK encoding')
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}=`
  const decoded = atob(padded)
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  if (bytes.byteLength !== 32) throw new Error('invalid KEK length')
  return bytes
}

const keyFailure = (operation: string): SecretKekError =>
  new SecretKekError({ operation, message: 'key encryption operation failed' })

const keyBinding = (
  keyring: CloudflareKekKeyring,
  keyVersion: number,
  operation: string,
): Effect.Effect<SecretsStoreSecretBinding, SecretKekError> => {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) return Effect.fail(keyFailure(operation))
  const binding = keyring.keys[keyVersion]
  return binding === undefined ? Effect.fail(keyFailure(operation)) : Effect.succeed(binding)
}

const importKek = (
  binding: SecretsStoreSecretBinding,
  usages: ReadonlyArray<'encrypt' | 'decrypt'>,
  operation: string,
): Effect.Effect<CryptoKey, SecretKekError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = decodeBase64Url(await binding.get())
      try {
        return await crypto.subtle.importKey('raw', bufferSource(raw), 'AES-GCM', false, usages)
      } finally {
        raw.fill(0)
      }
    },
    catch: () => keyFailure(operation),
  })

const wrap = (
  keyring: CloudflareKekKeyring,
  keyVersion: number,
  dataKey: Uint8Array,
  authenticatedData: Uint8Array,
): Effect.Effect<Uint8Array, SecretKekError> =>
  Effect.gen(function* () {
    if (dataKey.byteLength !== 32) return yield* keyFailure('kek.wrap')
    const binding = yield* keyBinding(keyring, keyVersion, 'kek.wrap')
    const key = yield* importKek(binding, ['encrypt'], 'kek.wrap')
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const ciphertext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: bufferSource(iv),
            additionalData: bufferSource(authenticatedData),
            tagLength: 128,
          },
          key,
          bufferSource(dataKey),
        ),
      catch: () => keyFailure('kek.wrap'),
    })
    const output = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength)
    output[0] = envelopeVersion
    output.set(iv, 1)
    output.set(new Uint8Array(ciphertext), 1 + iv.byteLength)
    return output
  })

const unwrap = (
  keyring: CloudflareKekKeyring,
  keyVersion: number,
  wrappedDataKey: Uint8Array,
  authenticatedData: Uint8Array,
): Effect.Effect<Uint8Array, SecretKekError> =>
  Effect.gen(function* () {
    if (wrappedDataKey.byteLength < minimumWrappedLength || wrappedDataKey[0] !== envelopeVersion)
      return yield* keyFailure('kek.unwrap')
    const binding = yield* keyBinding(keyring, keyVersion, 'kek.unwrap')
    const key = yield* importKek(binding, ['decrypt'], 'kek.unwrap')
    const iv = wrappedDataKey.slice(1, 1 + ivLength)
    const ciphertext = wrappedDataKey.slice(1 + ivLength)
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: bufferSource(iv),
            additionalData: bufferSource(authenticatedData),
            tagLength: 128,
          },
          key,
          bufferSource(ciphertext),
        ),
      catch: () => keyFailure('kek.unwrap'),
    })
    const dataKey = new Uint8Array(plaintext)
    if (dataKey.byteLength !== 32) {
      dataKey.fill(0)
      return yield* keyFailure('kek.unwrap')
    }
    return dataKey
  })

export const makeCloudflareSecretsStoreKekPort = (keyring: CloudflareKekKeyring): KekPortShape => ({
  activeKeyVersion:
    Number.isSafeInteger(keyring.activeVersion) &&
    keyring.activeVersion >= 1 &&
    keyring.keys[keyring.activeVersion] !== undefined
      ? Effect.succeed(keyring.activeVersion)
      : Effect.fail(keyFailure('kek.activeVersion')),
  wrap: (keyVersion, dataKey, authenticatedData) =>
    wrap(keyring, keyVersion, dataKey, authenticatedData),
  unwrap: (keyVersion, wrappedDataKey, authenticatedData) =>
    unwrap(keyring, keyVersion, wrappedDataKey, authenticatedData),
})

export const CloudflareSecretsStoreKekLayer = (keyring: CloudflareKekKeyring) =>
  Layer.succeed(KekPort, makeCloudflareSecretsStoreKekPort(keyring))

import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { BackupDataKeyPort, BackupR2Error, type BackupKeyCoordinates } from '@gridora/backup-r2'
import { SecretKekError, type KekPortShape } from '@gridora/secret-envelope'
import {
  BackupWrappedKeyRecord,
  makeBackupDataKeyPortLayer,
  type BackupKeyInsertResult,
  type BackupKeyRandomShape,
  type BackupKeyRepositoryPortShape,
} from '../src/index.js'

const source = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const genericRepositoryFailure = () =>
  new BackupR2Error({
    code: 'key-failed',
    operation: 'test.repository',
    message: 'test repository failure',
  })
const recordKey = (coordinates: BackupKeyCoordinates) =>
  `${coordinates.organizationId}:${coordinates.serverId}:${coordinates.backupId}`

class AtomicMemoryRepository implements BackupKeyRepositoryPortShape {
  readonly records = new Map<string, BackupWrappedKeyRecord>()
  failAfterInsertOnce = false
  insertOrGet = (
    candidate: BackupWrappedKeyRecord,
  ): Effect.Effect<BackupKeyInsertResult, BackupR2Error> =>
    Effect.suspend((): Effect.Effect<BackupKeyInsertResult, BackupR2Error> => {
      const key = recordKey(candidate)
      const existing = this.records.get(key)
      if (existing !== undefined)
        return Effect.succeed<BackupKeyInsertResult>({ kind: 'existing', record: existing })
      this.records.set(key, candidate)
      if (this.failAfterInsertOnce) {
        this.failAfterInsertOnce = false
        return Effect.fail(genericRepositoryFailure())
      }
      return Effect.succeed<BackupKeyInsertResult>({ kind: 'inserted', record: candidate })
    })
  get = (coordinates: BackupKeyCoordinates) =>
    Effect.succeed(this.records.get(recordKey(coordinates)) ?? null)
  tamper(coordinates: BackupKeyCoordinates) {
    const key = recordKey(coordinates)
    const record = this.records.get(key)
    if (record === undefined) throw new Error('record missing')
    const replacement = record.wrappedDataKey.startsWith('A')
      ? `B${record.wrappedDataKey.slice(1)}`
      : `A${record.wrappedDataKey.slice(1)}`
    this.records.set(
      key,
      new BackupWrappedKeyRecord({
        organizationId: record.organizationId,
        serverId: record.serverId,
        backupId: record.backupId,
        keyVersion: record.keyVersion,
        wrappedDataKey: replacement,
        revision: 1,
      }),
    )
  }
}

const makeLocalKek = () => {
  const state = {
    active: 1,
    keys: new Map<number, Uint8Array>([
      [1, crypto.getRandomValues(new Uint8Array(32))],
      [2, crypto.getRandomValues(new Uint8Array(32))],
    ]),
  }
  const key = (version: number, usages: KeyUsage[]) => {
    const bytes = state.keys.get(version)
    return bytes === undefined
      ? Effect.fail(
          new SecretKekError({
            operation: 'test.kek',
            message: 'test KEK unavailable',
          }),
        )
      : Effect.tryPromise({
          try: () => crypto.subtle.importKey('raw', source(bytes), 'AES-GCM', false, usages),
          catch: () =>
            new SecretKekError({ operation: 'test.kek', message: 'test KEK operation failed' }),
        })
  }
  const port: KekPortShape = {
    activeKeyVersion: Effect.sync(() => state.active),
    wrap: (version, plaintext, aad) =>
      Effect.gen(function* () {
        const wrappingKey = yield* key(version, ['encrypt'])
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: source(iv), additionalData: source(aad) },
              wrappingKey,
              source(plaintext),
            ),
          catch: () =>
            new SecretKekError({ operation: 'test.wrap', message: 'test KEK operation failed' }),
        })
        const wrapped = new Uint8Array(iv.byteLength + ciphertext.byteLength)
        wrapped.set(iv)
        wrapped.set(new Uint8Array(ciphertext), iv.byteLength)
        return wrapped
      }),
    unwrap: (version, wrapped, aad) =>
      Effect.gen(function* () {
        if (wrapped.byteLength <= 12)
          return yield* new SecretKekError({
            operation: 'test.unwrap',
            message: 'test KEK operation failed',
          })
        const wrappingKey = yield* key(version, ['decrypt'])
        return yield* Effect.tryPromise({
          try: async () =>
            new Uint8Array(
              await crypto.subtle.decrypt(
                {
                  name: 'AES-GCM',
                  iv: source(wrapped.slice(0, 12)),
                  additionalData: source(aad),
                },
                wrappingKey,
                source(wrapped.slice(12)),
              ),
            ),
          catch: () =>
            new SecretKekError({ operation: 'test.unwrap', message: 'test KEK operation failed' }),
        })
      }),
  }
  return { state, port }
}

const coordinates: BackupKeyCoordinates = {
  organizationId: 'org-a',
  serverId: 'server-a',
  backupId: 'backup-a',
}
const otherBackup: BackupKeyCoordinates = { ...coordinates, backupId: 'backup-b' }
const foreign: BackupKeyCoordinates = { ...coordinates, organizationId: 'org-b' }

let repository: AtomicMemoryRepository
let kek: ReturnType<typeof makeLocalKek>
let generated: Uint8Array[]
let random: BackupKeyRandomShape
let layer: ReturnType<typeof makeBackupDataKeyPortLayer>
const rebuildLayer = () => {
  layer = makeBackupDataKeyPortLayer(repository, kek.port, random)
}
const run = <A, E>(effect: Effect.Effect<A, E, BackupDataKeyPort>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

describe('atomic backup data-key issuance', () => {
  beforeEach(() => {
    repository = new AtomicMemoryRepository()
    kek = makeLocalKek()
    generated = []
    let counter = 1
    random = {
      bytes: (length) => {
        const bytes = new Uint8Array(length).fill(counter++)
        generated.push(bytes)
        return bytes
      },
    }
    rebuildLayer()
  })

  it('atomically adopts one exact key under concurrent issuance and zeroes the loser', async () => {
    const [first, second] = await Promise.all([
      run(Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates))),
      run(Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates))),
    ])
    expect(first.keyVersion).toBe(1)
    expect(second.keyVersion).toBe(1)
    expect([...first.plaintextKey]).toEqual([...second.plaintextKey])
    expect(first.wrappedDataKey).toBe(second.wrappedDataKey)
    expect(repository.records).toHaveLength(1)
    expect(generated).toHaveLength(2)
    expect(generated.filter((bytes) => bytes.every((byte) => byte === 0))).toHaveLength(1)
    expect(JSON.stringify([...repository.records.values()])).not.toContain('plaintextKey')
    first.plaintextKey.fill(0)
    second.plaintextKey.fill(0)
  })

  it('adopts an inserted record after a lost repository response and on retry', async () => {
    repository.failAfterInsertOnce = true
    const first = await run(Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates)))
    const retry = await run(Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates)))
    expect([...retry.plaintextKey]).toEqual([...first.plaintextKey])
    expect(retry.wrappedDataKey).toBe(first.wrappedDataKey)
    expect(repository.records).toHaveLength(1)
    expect(generated.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    first.plaintextKey.fill(0)
    retry.plaintextKey.fill(0)
  })

  it('binds unwrap to organization, server, and backup AAD', async () => {
    const issued = await run(Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates)))
    for (const changed of [foreign, otherBackup, { ...coordinates, serverId: 'server-b' }]) {
      const result = await run(
        Effect.flatMap(BackupDataKeyPort, (port) =>
          Effect.result(port.unwrap(changed, issued.keyVersion, issued.wrappedDataKey)),
        ),
      )
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'BackupR2Error',
          code: 'key-failed',
          message: 'backup key operation failed',
        },
      })
    }
    issued.plaintextKey.fill(0)
  })

  it('keeps old and new KEK versions available during rotation overlap', async () => {
    const versionOne = await run(
      Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates)),
    )
    kek.state.active = 2
    const versionTwo = await run(
      Effect.flatMap(BackupDataKeyPort, (port) => port.issue(otherBackup)),
    )
    const reopenedOne = await run(
      Effect.flatMap(BackupDataKeyPort, (port) =>
        port.unwrap(coordinates, versionOne.keyVersion, versionOne.wrappedDataKey),
      ),
    )
    const reopenedTwo = await run(
      Effect.flatMap(BackupDataKeyPort, (port) =>
        port.unwrap(otherBackup, versionTwo.keyVersion, versionTwo.wrappedDataKey),
      ),
    )
    expect(versionOne.keyVersion).toBe(1)
    expect(versionTwo.keyVersion).toBe(2)
    expect([...reopenedOne]).toEqual([...versionOne.plaintextKey])
    expect([...reopenedTwo]).toEqual([...versionTwo.plaintextKey])
    for (const bytes of [
      versionOne.plaintextKey,
      versionTwo.plaintextKey,
      reopenedOne,
      reopenedTwo,
    ])
      bytes.fill(0)
  })

  it('rejects manifest and stored-wrap tampering without leaking secret canaries', async () => {
    const issued = await run(Effect.flatMap(BackupDataKeyPort, (port) => port.issue(coordinates)))
    const replacement = issued.wrappedDataKey.startsWith('A')
      ? `B${issued.wrappedDataKey.slice(1)}`
      : `A${issued.wrappedDataKey.slice(1)}`
    const manifestTamper = await run(
      Effect.flatMap(BackupDataKeyPort, (port) =>
        Effect.result(port.unwrap(coordinates, issued.keyVersion, replacement)),
      ),
    )
    repository.tamper(coordinates)
    const storedTamper = await run(
      Effect.flatMap(BackupDataKeyPort, (port) => Effect.result(port.issue(coordinates))),
    )
    for (const result of [manifestTamper, storedTamper]) {
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'BackupR2Error', message: 'backup key operation failed' },
      })
      expect(JSON.stringify(result)).not.toContain('CANARY-key-material')
      expect(JSON.stringify(result)).not.toContain(issued.wrappedDataKey)
    }
    issued.plaintextKey.fill(0)
  })
})

import { createHash } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { OrganizationContext } from '@gridora/domain'
import {
  BACKUP_R2_LIMITS,
  BackupR2Error,
  BackupR2Transport,
  makeManagedBackupUploadObjectPublisher,
  makeBackupR2TransportLayer,
  recoverManagedBackupUploadEffects,
  type BackupDataKeyPortShape,
  type BackupKeyCoordinates,
  type BackupR2BucketShape,
  type BackupR2ObjectBody,
  type BackupR2ObjectInfo,
  type BackupR2PutOptions,
  type ManagedBackupUploadEffectRepositoryShape,
  type ManagedBackupUploadObjectEffect,
  type UploadBackupInput,
} from '../src/index.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const checksum = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const streamOf = (parts: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part.slice())
      controller.close()
    },
  })
const readStream = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    parts.push(result.value)
    size += result.value.byteLength
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

interface StoredObject {
  bytes: Uint8Array
  metadata: Readonly<Record<string, string>>
  etag: string
}
class MemoryR2 implements BackupR2BucketShape {
  readonly objects = new Map<string, StoredObject>()
  readonly putCounts = new Map<string, number>()
  failBeforeStoreOnce?: string
  failAfterStoreOnce?: string
  beforeStore?: (key: string) => Promise<void>
  private multipartSequence = 0
  private readonly multipart = new Map<
    string,
    {
      readonly key: string
      readonly options: BackupR2PutOptions
      part?: Uint8Array
      aborted: boolean
      completed: boolean
    }
  >()
  async head(key: string): Promise<BackupR2ObjectInfo | null> {
    const stored = this.objects.get(key)
    return stored === undefined ? null : this.info(key, stored)
  }
  async get(key: string): Promise<BackupR2ObjectBody | null> {
    const stored = this.objects.get(key)
    if (stored === undefined) return null
    return { ...this.info(key, stored), body: streamOf([stored.bytes]) }
  }
  async put(
    key: string,
    value: Uint8Array | string,
    options: BackupR2PutOptions,
  ): Promise<BackupR2ObjectInfo> {
    this.putCounts.set(key, (this.putCounts.get(key) ?? 0) + 1)
    await this.beforeStore?.(key)
    if (this.failBeforeStoreOnce === key) {
      delete this.failBeforeStoreOnce
      throw new Error('simulated response loss before storage')
    }
    if (options.onlyIfAbsent && this.objects.has(key)) throw new Error('precondition failed')
    const bytes = typeof value === 'string' ? encoder.encode(value) : value.slice()
    const stored = { bytes, metadata: { ...options.customMetadata }, etag: checksum(bytes) }
    this.objects.set(key, stored)
    if (this.failAfterStoreOnce === key) {
      delete this.failAfterStoreOnce
      throw new Error('simulated response loss after storage')
    }
    return this.info(key, stored)
  }
  async createMultipartUpload(key: string, options: BackupR2PutOptions) {
    const uploadId = `multipart-${(this.multipartSequence += 1)}`
    this.multipart.set(uploadId, {
      key,
      options,
      aborted: false,
      completed: false,
    })
    return this.resumeMultipartUpload(key, uploadId)
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const state = this.multipart.get(uploadId)
    if (state === undefined || state.key !== key) throw new Error('multipart upload missing')
    return {
      key,
      uploadId,
      uploadPart: async (_partNumber: number, value: Uint8Array | string) => {
        if (state.aborted || state.completed) throw new Error('multipart upload is terminal')
        await this.beforeStore?.(key)
        if (this.failBeforeStoreOnce === key) {
          delete this.failBeforeStoreOnce
          throw new Error('simulated response loss before storage')
        }
        state.part = typeof value === 'string' ? encoder.encode(value) : value.slice()
        return { partNumber: 1, etag: checksum(state.part) }
      },
      abort: async () => {
        if (state.completed) throw new Error('multipart upload completed')
        state.aborted = true
        delete state.part
      },
      complete: async () => {
        if (state.aborted || state.completed || state.part === undefined)
          throw new Error('multipart upload cannot complete')
        if (state.options.onlyIfAbsent && this.objects.has(key))
          throw new Error('precondition failed')
        const stored = {
          bytes: state.part.slice(),
          metadata: { ...state.options.customMetadata },
          etag: checksum(state.part),
        }
        this.objects.set(key, stored)
        state.completed = true
        this.putCounts.set(key, (this.putCounts.get(key) ?? 0) + 1)
        if (this.failAfterStoreOnce === key) {
          delete this.failAfterStoreOnce
          throw new Error('simulated response loss after storage')
        }
        return this.info(key, stored)
      },
    }
  }
  tamper(key: string) {
    const stored = this.objects.get(key)
    if (stored === undefined) throw new Error('missing object')
    const bytes = stored.bytes.slice()
    bytes[0] = bytes[0]! ^ 0xff
    this.objects.set(key, { ...stored, bytes })
  }
  private info(key: string, stored: StoredObject): BackupR2ObjectInfo {
    return {
      key,
      size: stored.bytes.byteLength,
      etag: stored.etag,
      customMetadata: { ...stored.metadata },
    }
  }
}

const coordinateKey = (coordinates: BackupKeyCoordinates) =>
  `${coordinates.organizationId}:${coordinates.serverId}:${coordinates.backupId}`
const localKeyPort = (): BackupDataKeyPortShape => {
  const keys = new Map<string, Uint8Array>()
  return {
    issue: (coordinates) =>
      Effect.sync(() => {
        const id = coordinateKey(coordinates)
        let key = keys.get(id)
        if (key === undefined) {
          key = crypto.getRandomValues(new Uint8Array(32))
          keys.set(id, key)
        }
        return { plaintextKey: key.slice(), wrappedDataKey: `test-wrapped:${id}`, keyVersion: 1 }
      }),
    unwrap: (coordinates, keyVersion, wrappedDataKey) => {
      const id = coordinateKey(coordinates)
      const key = keys.get(id)
      return keyVersion === 1 && wrappedDataKey === `test-wrapped:${id}` && key !== undefined
        ? Effect.succeed(key.slice())
        : Effect.fail(
            new BackupR2Error({
              code: 'key-failed',
              operation: 'test.unwrap',
              message: 'test key unavailable',
            }),
          )
    },
  }
}

const context = (organizationId: 'org-a' | 'org-b') =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'organization-a' : 'organization-b',
    identityId: organizationId === 'org-a' ? 'owner-a' : 'owner-b',
    role: 'owner',
    correlationId: `correlation-${organizationId}`,
  })
const prefix = 'organizations/org-a/servers/server-a/backups/backup-a'
const chunkKey = (index: number) => `${prefix}/chunks/${index.toString().padStart(8, '0')}.bin`
const manifestKey = `${prefix}/manifest.json`
const payload = encoder.encode(`compressed-server-state-${'archive-block-'.repeat(12_000)}`)
const payloadParts = [
  payload.slice(0, 73),
  payload.slice(73, 50_073),
  payload.slice(50_073, 110_073),
  payload.slice(110_073),
]
let currentLeaseId = 'upload-lease-a'
const input = (): UploadBackupInput => ({
  backupId: 'backup-a',
  serverId: 'server-a',
  operationId: 'operation-a',
  jobId: 'job-a',
  uploadSessionId: 'upload-session-a',
  uploadLeaseId: currentLeaseId,
  uploadGeneration: 1,
  createdAt: '2026-08-23T12:00:00Z',
  includes: ['config', 'data', 'state'],
  containsGameBinaries: false,
  compressedBytes: payload.byteLength,
  compressedSha256: checksum(payload),
  maximumCompressedBytes: 1024 * 1024,
  maximumChunkBytes: 64 * 1024,
  publicationGuard: () => Effect.void,
  publishObject: publisher,
  stream: streamOf(payloadParts),
})

let bucket: MemoryR2
let layer: ReturnType<typeof makeBackupR2TransportLayer>
let publisher: UploadBackupInput['publishObject']
let effects: Map<string, ManagedBackupUploadObjectEffect>
let repository: ManagedBackupUploadEffectRepositoryShape
const run = <A, E>(effect: Effect.Effect<A, E, BackupR2Transport>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

describe('authenticated organization-scoped R2 backup transport', () => {
  it('advertises an exactly reachable maximum boundary', () => {
    expect(BACKUP_R2_LIMITS.maximumBackupBytes).toBe(
      BACKUP_R2_LIMITS.maximumChunkBytes * BACKUP_R2_LIMITS.maximumChunks,
    )
  })

  beforeEach(() => {
    bucket = new MemoryR2()
    effects = new Map<string, ManagedBackupUploadObjectEffect>()
    currentLeaseId = 'upload-lease-a'
    repository = {
      load: (key) => Effect.succeed(effects.get(key) ?? null),
      register: (publication) =>
        Effect.sync(() => {
          const prior = effects.get(publication.key)
          const effect: ManagedBackupUploadObjectEffect = {
            effectId: `effect-${publication.key}-${prior?.state === 'aborted' ? 2 : 1}`,
            sessionId: 'upload-session-a',
            generation: 1,
            leaseId: currentLeaseId,
            objectKey: publication.key,
            objectKind: publication.kind,
            chunkIndex: publication.index ?? -1,
            objectBytes: publication.objectBytes,
            objectSha256: publication.checksum,
            multipartUploadId: publication.multipartUploadId,
            state: 'prepared',
            providerEtag: null,
          }
          effects.set(publication.key, effect)
          return effect
        }),
      complete: (effect, providerEtag) =>
        Effect.sync(() => {
          const completed = { ...effect, state: 'completed' as const, providerEtag }
          effects.set(effect.objectKey, completed)
          return completed
        }),
      abort: (effect) =>
        Effect.sync(() => {
          const aborted = { ...effect, state: 'aborted' as const }
          effects.set(effect.objectKey, aborted)
          return aborted
        }),
      listPrepared: Effect.sync(() =>
        [...effects.values()].filter((effect) => effect.state === 'prepared'),
      ),
    }
    publisher = makeManagedBackupUploadObjectPublisher(
      bucket,
      {
        organizationId: 'org-a',
        sessionId: 'upload-session-a',
        leaseId: 'upload-lease-a',
        generation: 1,
      },
      repository,
    )
    layer = makeBackupR2TransportLayer(bucket, localKeyPort())
  })

  it('safely resumes an upload loss and commits the versioned manifest last', async () => {
    bucket.failBeforeStoreOnce = chunkKey(1)
    const first = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(transport.upload(context('org-a'), input()))
      }),
    )
    expect(first).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BackupR2Error', code: 'transport-failed' },
    })
    expect(bucket.objects.has(chunkKey(0))).toBe(true)
    expect(bucket.objects.has(manifestKey)).toBe(false)

    bucket.failAfterStoreOnce = manifestKey
    const manifest = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* transport.upload(context('org-a'), {
          ...input(),
          stream: streamOf([
            payload.slice(0, 60_000),
            payload.slice(60_000, 120_000),
            payload.slice(120_000),
          ]),
        })
      }),
    )
    expect(manifest).toMatchObject({
      apiVersion: 'backup.r2.gridora.dev/v1alpha1',
      organizationId: 'org-a',
      content: { policy: 'server-state-only', excludes: ['game'], containsGameBinaries: false },
      plaintext: { sha256: checksum(payload), bytes: payload.byteLength },
    })
    expect(manifest.chunks.map((chunk) => chunk.plaintextBytes)).toEqual([
      64 * 1024,
      64 * 1024,
      payload.byteLength - 128 * 1024,
    ])
    expect(bucket.putCounts.get(chunkKey(0))).toBe(1)
    expect(bucket.objects.has(manifestKey)).toBe(true)

    // A completed retry adopts the authenticated manifest without reading a replacement stream.
    const adopted = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* transport.upload(context('org-a'), {
          ...input(),
          stream: new ReadableStream({
            pull() {
              throw new Error('must not consume completed retry stream')
            },
          }),
        })
      }),
    )
    expect(adopted).toEqual(manifest)
    for (const stored of bucket.objects.values()) {
      expect(stored.metadata).not.toHaveProperty('wrappedDataKey')
      expect(stored.metadata).not.toHaveProperty('plaintextKey')
      expect(JSON.stringify(stored.metadata)).not.toContain('test-wrapped:')
    }
  })

  it('runs the post-write authority fence when a chunk PUT returns after lease loss', async () => {
    let releasePut!: () => void
    let observePut!: () => void
    const putStarted = new Promise<void>((resolve) => {
      observePut = resolve
    })
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    bucket.beforeStore = async (key) => {
      if (key !== chunkKey(0)) return
      observePut()
      await putReleased
    }
    let authorized = true
    const uploading = run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.upload(context('org-a'), {
            ...input(),
            publicationGuard: () =>
              authorized
                ? Effect.void
                : Effect.fail(
                    new BackupR2Error({
                      code: 'publication-denied',
                      operation: 'test.publication-authority',
                      message: 'upload lease was revoked while R2 was in flight',
                    }),
                  ),
          }),
        )
      }),
    )
    await putStarted
    authorized = false
    releasePut()
    const result = await uploading
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BackupR2Error', code: 'publication-denied' },
    })
    // The external PUT may land after revocation. D1 must retain the writer
    // tombstone until the request closes, then exact-prefix cleanup reaps it.
    expect(bucket.objects.has(chunkKey(0))).toBe(true)
    expect(bucket.objects.has(manifestKey)).toBe(false)
  })

  it('aborts a held multipart publication after Worker loss and safely resumes the exact generation', async () => {
    let releasePart!: () => void
    let observePart!: () => void
    const partStarted = new Promise<void>((resolve) => {
      observePart = resolve
    })
    const partReleased = new Promise<void>((resolve) => {
      releasePart = resolve
    })
    bucket.beforeStore = async (key) => {
      if (key !== chunkKey(0)) return
      observePart()
      await partReleased
    }
    const lostWorker = run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(transport.upload(context('org-a'), input()))
      }),
    )
    await partStarted
    expect([...effects.values()]).toMatchObject([
      {
        objectKey: chunkKey(0),
        state: 'prepared',
        leaseId: 'upload-lease-a',
      },
    ])

    currentLeaseId = 'upload-lease-takeover'
    const recovered = await Effect.runPromise(
      recoverManagedBackupUploadEffects(
        bucket,
        {
          organizationId: 'org-a',
          sessionId: 'upload-session-a',
          leaseId: currentLeaseId,
          generation: 1,
        },
        repository,
      ),
    )
    expect(recovered).toEqual({ completed: 0, aborted: 1 })
    releasePart()
    await expect(lostWorker).resolves.toMatchObject({ _tag: 'Failure' })
    expect(bucket.objects.size).toBe(0)

    delete bucket.beforeStore
    publisher = makeManagedBackupUploadObjectPublisher(
      bucket,
      {
        organizationId: 'org-a',
        sessionId: 'upload-session-a',
        leaseId: currentLeaseId,
        generation: 1,
      },
      repository,
    )
    const resumed = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* transport.upload(context('org-a'), input())
      }),
    )
    expect(resumed).toMatchObject({
      uploadSessionId: 'upload-session-a',
      uploadGeneration: 1,
      plaintext: { sha256: checksum(payload), bytes: payload.byteLength },
    })
    expect(bucket.objects.has(manifestKey)).toBe(true)
  })

  it('denies cross-organization restore without exposing the foreign object key', async () => {
    await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        yield* transport.upload(context('org-a'), input())
      }),
    )
    const result = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.restore(context('org-b'), {
            backupId: 'backup-a',
            serverId: 'server-a',
            maximumRestoreBytes: 1024 * 1024,
          }),
        )
      }),
    )
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BackupR2Error', code: 'not-found' },
    })
  })

  it('rejects ciphertext tampering while consuming the restore stream', async () => {
    await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        yield* transport.upload(context('org-a'), input())
      }),
    )
    bucket.tamper(chunkKey(1))
    const restored = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* transport.restore(context('org-a'), {
          backupId: 'backup-a',
          serverId: 'server-a',
          maximumRestoreBytes: 1024 * 1024,
        })
      }),
    )
    await expect(readStream(restored.stream)).rejects.toMatchObject({
      _tag: 'BackupR2Error',
      code: 'integrity-failed',
    })
  })

  it('enforces declared total, producer chunk, chunk-count, and restore size bounds', async () => {
    const redistribution = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.upload(context('org-a'), {
            ...input(),
            backupId: 'backup-game-binaries',
            containsGameBinaries: true as false,
          }),
        )
      }),
    )
    expect(redistribution).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'invalid-input' },
    })

    const declared = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.upload(context('org-a'), {
            ...input(),
            maximumCompressedBytes: payload.byteLength - 1,
          }),
        )
      }),
    )
    expect(declared).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'size-limit' },
    })

    const oversized = new Uint8Array(64 * 1024 + 1)
    const producer = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.upload(context('org-a'), {
            ...input(),
            backupId: 'backup-large',
            compressedBytes: oversized.byteLength,
            compressedSha256: checksum(oversized),
            stream: streamOf([oversized]),
          }),
        )
      }),
    )
    expect(producer).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'size-limit' },
    })

    const tooManyChunks = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.upload(context('org-a'), {
            ...input(),
            backupId: 'backup-too-many-chunks',
            compressedBytes: (65_536 + 1) * 64 * 1024,
            maximumCompressedBytes: (65_536 + 1) * 64 * 1024,
            compressedSha256: checksum(new Uint8Array()),
            stream: streamOf([]),
          }),
        )
      }),
    )
    expect(tooManyChunks).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'size-limit' },
    })

    await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        yield* transport.upload(context('org-a'), input())
      }),
    )
    const restore = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* Effect.result(
          transport.restore(context('org-a'), {
            backupId: 'backup-a',
            serverId: 'server-a',
            maximumRestoreBytes: payload.byteLength - 1,
          }),
        )
      }),
    )
    expect(restore).toMatchObject({ _tag: 'Failure', failure: { code: 'size-limit' } })
  })

  it('streams the verified compressed archive in order', async () => {
    const uploaded = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* transport.upload(context('org-a'), input())
      }),
    )
    const restored = await run(
      Effect.gen(function* () {
        const transport = yield* BackupR2Transport
        return yield* transport.restore(context('org-a'), {
          backupId: 'backup-a',
          serverId: 'server-a',
          maximumRestoreBytes: 1024 * 1024,
        })
      }),
    )
    expect(restored.manifest).toEqual(uploaded)
    const bytes = await readStream(restored.stream)
    expect(decoder.decode(bytes)).toBe(decoder.decode(payload))
    expect(checksum(bytes)).toBe(uploaded.plaintext.sha256)
  })
})

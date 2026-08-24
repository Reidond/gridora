import { Context, Effect, Layer, Schema } from 'effect'
import type { OrganizationContext } from '@gridora/domain'

const checksumPattern = /^sha256:[a-f0-9]{64}$/
const safeIdentifier = (value: string) =>
  value !== '.' && value !== '..' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const digestSchema = Schema.String.check(Schema.isPattern(checksumPattern))
const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const nonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const BACKUP_R2_LIMITS = {
  // 4 MiB * 65,536 chunks = 256 GiB. Keep the advertised maximum reachable
  // under both the chunk-size and chunk-count limits.
  maximumBackupBytes: 256 * 1024 * 1024 * 1024,
  minimumChunkBytes: 64 * 1024,
  maximumChunkBytes: 4 * 1024 * 1024,
  maximumChunks: 65_536,
  maximumManifestBytes: 32 * 1024 * 1024,
} as const

export class BackupR2Error extends Schema.TaggedError<BackupR2Error>()('BackupR2Error', {
  code: Schema.Literals([
    'invalid-input',
    'size-limit',
    'not-found',
    'ownership-denied',
    'integrity-failed',
    'conflict',
    'transport-failed',
    'upload-uncertain',
    'publication-denied',
    'key-failed',
  ]),
  operation: Schema.String,
  message: Schema.String,
}) {}

export const BackupContentCategory = Schema.Literals(['config', 'data', 'mods', 'state'])
export type BackupContentCategory = typeof BackupContentCategory.Type
export const BackupR2Chunk = Schema.Struct({
  index: nonNegativeInteger,
  key: Schema.String,
  plaintextBytes: positiveInteger,
  ciphertextBytes: positiveInteger,
  plaintextSha256: digestSchema,
  ciphertextSha256: digestSchema,
})
export type BackupR2Chunk = typeof BackupR2Chunk.Type

const manifestCoreFields = {
  apiVersion: Schema.Literal('backup.r2.gridora.dev/v1alpha1'),
  organizationId: Schema.String,
  backupId: Schema.String,
  serverId: Schema.String,
  operationId: Schema.String,
  jobId: Schema.String,
  uploadSessionId: Schema.String,
  uploadGeneration: positiveInteger,
  createdAt: Schema.String,
  content: Schema.Struct({
    policy: Schema.Literal('server-state-only'),
    includes: Schema.Array(BackupContentCategory),
    excludes: Schema.Tuple([Schema.Literal('game')]),
    containsGameBinaries: Schema.Literal(false),
  }),
  encryption: Schema.Struct({
    algorithm: Schema.Literal('AES-256-GCM-CHUNKED'),
    keyVersion: positiveInteger,
    wrappedDataKey: Schema.String,
  }),
  plaintext: Schema.Struct({
    encoding: Schema.Literal('tar+zstd'),
    bytes: positiveInteger,
    sha256: digestSchema,
  }),
  ciphertext: Schema.Struct({ bytes: positiveInteger, sha256: digestSchema }),
  maximumChunkBytes: positiveInteger,
  chunks: Schema.Array(BackupR2Chunk),
} as const
export const BackupR2Manifest = Schema.Struct({
  ...manifestCoreFields,
  manifestAuthenticationTag: Schema.String,
})
export type BackupR2Manifest = typeof BackupR2Manifest.Type
type BackupR2ManifestCore = Omit<BackupR2Manifest, 'manifestAuthenticationTag'>

export interface BackupR2ObjectInfo {
  readonly key: string
  readonly size: number
  readonly etag: string
  readonly customMetadata: Readonly<Record<string, string>>
}
export interface BackupR2ObjectBody extends BackupR2ObjectInfo {
  readonly body: ReadableStream<Uint8Array>
}
export interface BackupR2PutOptions {
  readonly customMetadata: Readonly<Record<string, string>>
  readonly onlyIfAbsent: boolean
}
export interface BackupR2UploadedPart {
  readonly partNumber: number
  readonly etag: string
}
export interface BackupR2MultipartUploadShape {
  readonly key: string
  readonly uploadId: string
  readonly uploadPart: (
    partNumber: number,
    value: Uint8Array | string,
  ) => Promise<BackupR2UploadedPart>
  readonly abort: () => Promise<void>
  readonly complete: (parts: ReadonlyArray<BackupR2UploadedPart>) => Promise<BackupR2ObjectInfo>
}
/** Narrow subset implemented by a Cloudflare R2 binding adapter at the Worker composition root. */
export interface BackupR2BucketShape {
  readonly head: (key: string) => Promise<BackupR2ObjectInfo | null>
  readonly get: (key: string) => Promise<BackupR2ObjectBody | null>
  readonly put: (
    key: string,
    value: Uint8Array | string,
    options: BackupR2PutOptions,
  ) => Promise<BackupR2ObjectInfo>
  readonly createMultipartUpload: (
    key: string,
    options: BackupR2PutOptions,
  ) => Promise<BackupR2MultipartUploadShape>
  readonly resumeMultipartUpload: (key: string, uploadId: string) => BackupR2MultipartUploadShape
}
export class BackupR2Bucket extends Context.Service<BackupR2Bucket, BackupR2BucketShape>()(
  '@gridora/backup-r2/BackupR2Bucket',
) {}
export const BackupR2BucketLayer = (bucket: BackupR2BucketShape) =>
  Layer.succeed(BackupR2Bucket, bucket)

/** Structural Cloudflare R2 types keep this package usable in Worker and test runtimes. */
export interface CloudflareR2ObjectShape {
  readonly key: string
  readonly size: number
  readonly etag: string
  readonly customMetadata?: Readonly<Record<string, string>>
}
export interface CloudflareR2ObjectBodyShape extends CloudflareR2ObjectShape {
  readonly body?: ReadableStream<Uint8Array>
}
export interface CloudflareR2BucketBindingShape {
  readonly head: (key: string) => Promise<CloudflareR2ObjectShape | null>
  readonly get: (key: string) => Promise<CloudflareR2ObjectBodyShape | null>
  readonly put: (
    key: string,
    value: Uint8Array | string,
    options?: {
      readonly customMetadata?: Readonly<Record<string, string>>
      readonly onlyIf?: Headers
    },
  ) => Promise<CloudflareR2ObjectShape | null>
  readonly createMultipartUpload: (
    key: string,
    options?: { readonly customMetadata?: Readonly<Record<string, string>> },
  ) => Promise<CloudflareR2MultipartUploadShape>
  readonly resumeMultipartUpload: (
    key: string,
    uploadId: string,
  ) => CloudflareR2MultipartUploadShape
}
export interface CloudflareR2MultipartUploadShape {
  readonly key: string
  readonly uploadId: string
  readonly uploadPart: (
    partNumber: number,
    value: Uint8Array | string,
  ) => Promise<BackupR2UploadedPart>
  readonly abort: () => Promise<void>
  readonly complete: (parts: Array<BackupR2UploadedPart>) => Promise<CloudflareR2ObjectShape>
}

/** Separate destructive capability. The upload/restore bucket port intentionally
 * has no delete/list methods; composition must opt in to this exact-prefix
 * capability and its bounded deletion proof. */
export interface BackupR2DeletionBucketShape {
  readonly list: (input: {
    readonly prefix: string
    readonly cursor?: string
    readonly limit?: number
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>
    readonly truncated: boolean
    readonly cursor?: string
  }>
  readonly delete: (keys: ReadonlyArray<string>) => Promise<void>
}
export interface CloudflareR2DeletionBindingShape {
  readonly list: (input: {
    readonly prefix: string
    readonly cursor?: string
    readonly limit?: number
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>
    readonly truncated: boolean
    readonly cursor?: string
  }>
  readonly delete: (keys: string | ReadonlyArray<string>) => Promise<void>
}

export const makeCloudflareBackupR2DeletionBucket = (
  binding: CloudflareR2DeletionBindingShape,
): BackupR2DeletionBucketShape => ({
  list: (input) => binding.list(input),
  delete: (keys) => binding.delete(keys),
})

export interface BackupR2DeletionReceipt {
  readonly deletedObjects: number
  readonly alreadyAbsent: boolean
  readonly deletedPrefix: string
}

const deletionPrefixPattern =
  /^organizations\/[A-Za-z0-9_-]{1,128}\/servers\/[A-Za-z0-9_-]{1,128}\/backups\/[A-Za-z0-9_-]{1,128}$/

/** Delete only objects below one backup prefix, bounded by the encrypted
 * chunk policy. Chunks are deleted before the manifest; retries adopt an
 * already-empty prefix without claiming a foreign object was removed. */
export const deleteBackupObjectPrefix = (
  bucket: BackupR2DeletionBucketShape,
  prefix: string,
  maximumObjects = BACKUP_R2_LIMITS.maximumChunks + 1,
): Effect.Effect<BackupR2DeletionReceipt, BackupR2Error> =>
  Effect.gen(function* () {
    if (
      !deletionPrefixPattern.test(prefix) ||
      !Number.isSafeInteger(maximumObjects) ||
      maximumObjects < 1 ||
      maximumObjects > BACKUP_R2_LIMITS.maximumChunks + 1
    )
      return yield* transportFailure(
        'backup.delete',
        'invalid-input',
        'backup deletion prefix or bound is invalid',
      )
    const exactPrefix = `${prefix}/`
    const manifest = `${prefix}/manifest.json`
    const chunksPrefix = `${exactPrefix}chunks/`
    const keys: string[] = []
    const keySet = new Set<string>()
    let cursor: string | undefined
    let truncated = true
    let pages = 0
    const maximumPages = Math.ceil(maximumObjects / 1000) + 1
    const seenCursors = new Set<string>()
    while (truncated) {
      pages += 1
      if (pages > maximumPages)
        return yield* transportFailure(
          'backup.delete.list',
          'size-limit',
          'R2 deletion listing exceeds its bounded page count',
        )
      const page = yield* r2Attempt('backup.delete.list', () =>
        bucket.list({
          prefix: exactPrefix,
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.min(1000, maximumObjects),
        }),
      )
      for (const object of page.objects) {
        const chunkName = object.key.startsWith(chunksPrefix)
          ? object.key.slice(chunksPrefix.length)
          : null
        const validChunk =
          chunkName !== null &&
          /^\d{8}\.bin$/.test(chunkName) &&
          Number(chunkName.slice(0, 8)) < BACKUP_R2_LIMITS.maximumChunks
        if (
          !object.key.startsWith(exactPrefix) ||
          object.key.includes('..') ||
          (object.key !== manifest && !validChunk)
        )
          return yield* transportFailure(
            'backup.delete.list',
            'ownership-denied',
            'R2 deletion returned an object outside the exact backup prefix',
          )
        if (!keySet.has(object.key)) {
          keySet.add(object.key)
          keys.push(object.key)
        }
        if (keys.length > maximumObjects)
          return yield* transportFailure(
            'backup.delete.list',
            'size-limit',
            'backup object count exceeds deletion bound',
          )
      }
      truncated = page.truncated
      cursor = page.cursor
      if (truncated && (cursor === undefined || cursor.length === 0))
        return yield* transportFailure(
          'backup.delete.list',
          'transport-failed',
          'R2 deletion listing cursor is missing',
        )
      if (truncated && cursor !== undefined && seenCursors.has(cursor))
        return yield* transportFailure(
          'backup.delete.list',
          'transport-failed',
          'R2 deletion listing cursor repeated',
        )
      if (truncated && cursor !== undefined) seenCursors.add(cursor)
    }
    if (keys.length === 0) return { deletedObjects: 0, alreadyAbsent: true, deletedPrefix: prefix }
    const chunks = keys.filter((key) => key !== manifest).sort()
    for (let offset = 0; offset < chunks.length; offset += 1000)
      yield* r2Attempt('backup.delete.chunks', () =>
        bucket.delete(chunks.slice(offset, offset + 1000)),
      )
    // Keep the manifest in its own request and always last. If a response is
    // lost after this request, the next exact-prefix listing can safely adopt
    // an empty prefix; if the manifest was already absent, chunks are still
    // removed and the explicit delete request remains truthful.
    if (keySet.has(manifest))
      yield* r2Attempt('backup.delete.manifest', () => bucket.delete([manifest]))
    return { deletedObjects: keys.length, alreadyAbsent: false, deletedPrefix: prefix }
  })

const cloudflareObjectInfo = (object: CloudflareR2ObjectShape): BackupR2ObjectInfo => ({
  key: object.key,
  size: object.size,
  etag: object.etag,
  customMetadata: { ...object.customMetadata },
})

/**
 * Adapts the actual Workers R2 binding. `If-None-Match: *` makes publication create-only;
 * Cloudflare reports a failed precondition as `null`, which is intentionally surfaced as a
 * rejected write so the transport can perform its exact-byte adoption check.
 */
export const makeCloudflareBackupR2Bucket = (
  binding: CloudflareR2BucketBindingShape,
): BackupR2BucketShape => ({
  head: async (key) => {
    const object = await binding.head(key)
    return object === null ? null : cloudflareObjectInfo(object)
  },
  get: async (key) => {
    const object = await binding.get(key)
    if (object === null) return null
    if (object.body === undefined) throw new Error('R2 object body is unavailable')
    return { ...cloudflareObjectInfo(object), body: object.body }
  },
  put: async (key, value, options) => {
    const object = await binding.put(key, value, {
      customMetadata: options.customMetadata,
      ...(options.onlyIfAbsent ? { onlyIf: new Headers({ 'if-none-match': '*' }) } : {}),
    })
    if (object === null) throw new Error('R2 conditional write was not applied')
    return cloudflareObjectInfo(object)
  },
  createMultipartUpload: async (key, options) => {
    const upload = await binding.createMultipartUpload(key, {
      customMetadata: options.customMetadata,
    })
    return {
      key: upload.key,
      uploadId: upload.uploadId,
      uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
      abort: () => upload.abort(),
      complete: async (parts) => cloudflareObjectInfo(await upload.complete([...parts])),
    }
  },
  resumeMultipartUpload: (key, uploadId) => {
    const upload = binding.resumeMultipartUpload(key, uploadId)
    return {
      key: upload.key,
      uploadId: upload.uploadId,
      uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
      abort: () => upload.abort(),
      complete: async (parts) => cloudflareObjectInfo(await upload.complete([...parts])),
    }
  },
})

export interface BackupKeyCoordinates {
  readonly organizationId: string
  readonly serverId: string
  readonly backupId: string
}
interface BackupCryptoScope extends BackupKeyCoordinates {
  readonly operationId: string
  readonly jobId: string
  readonly uploadSessionId: string
  readonly uploadGeneration: number
  readonly plaintextSha256: string
  readonly chunkBytes: number
}
export interface BackupDataKey {
  /** Exactly 32 bytes. The implementation zeroes it after upload/restore setup. */
  readonly plaintextKey: Uint8Array
  readonly wrappedDataKey: string
  readonly keyVersion: number
}
/**
 * Secret-envelope-style key port. `issue` must be idempotent for the exact coordinates and return a
 * unique per-backup key. Wrapped keys are safe for the manifest; plaintext keys never enter R2.
 */
export interface BackupDataKeyPortShape {
  readonly issue: (coordinates: BackupKeyCoordinates) => Effect.Effect<BackupDataKey, BackupR2Error>
  readonly unwrap: (
    coordinates: BackupKeyCoordinates,
    keyVersion: number,
    wrappedDataKey: string,
  ) => Effect.Effect<Uint8Array, BackupR2Error>
}
export class BackupDataKeyPort extends Context.Service<BackupDataKeyPort, BackupDataKeyPortShape>()(
  '@gridora/backup-r2/BackupDataKeyPort',
) {}
export const BackupDataKeyPortLayer = (port: BackupDataKeyPortShape) =>
  Layer.succeed(BackupDataKeyPort, port)

export interface UploadBackupInput<R = never> {
  readonly backupId: string
  readonly serverId: string
  readonly operationId: string
  readonly jobId: string
  readonly uploadSessionId: string
  readonly uploadLeaseId: string
  readonly uploadGeneration: number
  readonly createdAt: string
  readonly includes: ReadonlyArray<BackupContentCategory>
  readonly containsGameBinaries: false
  readonly compressedBytes: number
  readonly compressedSha256: string
  readonly maximumCompressedBytes: number
  readonly maximumChunkBytes?: number
  /** D1-backed authority check. It is invoked before and after every R2
   * publication boundary, including manifest adoption after response loss. */
  readonly publicationGuard: (
    boundary: BackupUploadPublicationBoundary,
  ) => Effect.Effect<void, BackupR2Error, R>
  /** Publishes through a provider-managed multipart effect whose handle is
   * durably registered before the first byte. This makes a lost Worker
   * recoverable by exact completion adoption or provider-confirmed abort. */
  readonly publishObject: BackupUploadObjectPublisher<R>
  /** Producer contract: every emitted Uint8Array must be at most `maximumChunkBytes`. */
  readonly stream: ReadableStream<Uint8Array>
}
export interface BackupUploadObjectPublication {
  readonly key: string
  readonly value: Uint8Array | string
  readonly kind: 'chunk' | 'manifest'
  readonly checksum: string
  readonly index: number | null
  readonly customMetadata: Readonly<Record<string, string>>
}
export type BackupUploadObjectPublisher<R = never> = (
  publication: BackupUploadObjectPublication,
) => Effect.Effect<BackupR2ObjectInfo, BackupR2Error, R>
export interface BackupUploadPublicationBoundary {
  readonly phase: 'before' | 'after'
  readonly kind: 'chunk' | 'manifest'
  readonly key: string
  readonly index: number | null
}
export interface RestoreBackupInput {
  readonly backupId: string
  readonly serverId: string
  readonly maximumRestoreBytes: number
}
export interface RestoreBackupResult {
  readonly manifest: BackupR2Manifest
  readonly stream: ReadableStream<Uint8Array>
}
export interface BackupR2TransportShape {
  readonly upload: <R = never>(
    context: Pick<OrganizationContext, 'organizationId'>,
    input: UploadBackupInput<R>,
  ) => Effect.Effect<BackupR2Manifest, BackupR2Error, R>
  readonly restore: (
    context: Pick<OrganizationContext, 'organizationId'>,
    input: RestoreBackupInput,
  ) => Effect.Effect<RestoreBackupResult, BackupR2Error>
}
export class BackupR2Transport extends Context.Service<BackupR2Transport, BackupR2TransportShape>()(
  '@gridora/backup-r2/BackupR2Transport',
) {}

const textEncoder = new TextEncoder()
const base64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const unbase64 = (value: string) => {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
const bufferSource = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** Small streaming SHA-256 implementation so an archive is never buffered as a whole. */
class StreamingSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly buffer = new Uint8Array(64)
  private buffered = 0
  private bytes = 0
  private readonly words = new Uint32Array(64)
  update(input: Uint8Array) {
    this.bytes += input.byteLength
    let offset = 0
    while (offset < input.byteLength) {
      const take = Math.min(64 - this.buffered, input.byteLength - offset)
      this.buffer.set(input.subarray(offset, offset + take), this.buffered)
      this.buffered += take
      offset += take
      if (this.buffered === 64) {
        this.compress(this.buffer)
        this.buffered = 0
      }
    }
  }
  digest(): Uint8Array {
    const bitLength = this.bytes * 8
    this.buffer[this.buffered++] = 0x80
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered)
      this.compress(this.buffer)
      this.buffered = 0
    }
    this.buffer.fill(0, this.buffered, 56)
    const high = Math.floor(bitLength / 0x100000000)
    const low = bitLength >>> 0
    new DataView(this.buffer.buffer).setUint32(56, high)
    new DataView(this.buffer.buffer).setUint32(60, low)
    this.compress(this.buffer)
    const output = new Uint8Array(32)
    const view = new DataView(output.buffer)
    this.state.forEach((word, index) => view.setUint32(index * 4, word))
    return output
  }
  private compress(block: Uint8Array) {
    const constants = SHA256_CONSTANTS
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
    for (let index = 0; index < 16; index++) this.words[index] = view.getUint32(index * 4)
    for (let index = 16; index < 64; index++) {
      const x = this.words[index - 15]!
      const y = this.words[index - 2]!
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10)
      this.words[index] = (this.words[index - 16]! + s0 + this.words[index - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = this.state
    for (let index = 0; index < 64; index++) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25)
      const choice = (e! & f!) ^ (~e! & g!)
      const temp1 = (h! + sum1 + choice + constants[index]! + this.words[index]!) >>> 0
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22)
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d! + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    const next = [a!, b!, c!, d!, e!, f!, g!, h!]
    for (let index = 0; index < 8; index++)
      this.state[index] = (this.state[index]! + next[index]!) >>> 0
  }
}
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const sha256 = (bytes: Uint8Array) => {
  const hash = new StreamingSha256()
  hash.update(bytes)
  return `sha256:${hex(hash.digest())}`
}
const canonical = (value: unknown) => JSON.stringify(value)
const objectPrefix = (coordinates: BackupKeyCoordinates) =>
  `organizations/${coordinates.organizationId}/servers/${coordinates.serverId}/backups/${coordinates.backupId}`
const manifestKey = (coordinates: BackupKeyCoordinates) =>
  `${objectPrefix(coordinates)}/manifest.json`
const chunkKey = (coordinates: BackupKeyCoordinates, index: number) =>
  `${objectPrefix(coordinates)}/chunks/${index.toString().padStart(8, '0')}.bin`
const chunkAad = (scope: BackupCryptoScope, index: number, plaintextSha256: string) =>
  textEncoder.encode(
    `gridora-backup-chunk-v1|${scope.organizationId.length}:${scope.organizationId}|${scope.serverId.length}:${scope.serverId}|${scope.backupId.length}:${scope.backupId}|${scope.operationId.length}:${scope.operationId}|${scope.jobId.length}:${scope.jobId}|${scope.uploadSessionId.length}:${scope.uploadSessionId}|${scope.uploadGeneration}|${scope.plaintextSha256}|${scope.chunkBytes}|${index}|${plaintextSha256}`,
  )
const deterministicNonce = async (scope: BackupCryptoScope, discriminator: string) =>
  new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      textEncoder.encode(
        `gridora-backup-nonce-v1|${scope.organizationId}|${scope.serverId}|${scope.backupId}|${scope.operationId}|${scope.jobId}|${scope.uploadSessionId}|${scope.uploadGeneration}|${scope.plaintextSha256}|${scope.chunkBytes}|${discriminator}`,
      ),
    ),
  ).slice(0, 12)
const importedAesKey = (bytes: Uint8Array, usage: KeyUsage[]) =>
  crypto.subtle.importKey('raw', bufferSource(bytes), 'AES-GCM', false, usage)
const encryptChunk = async (
  key: CryptoKey,
  scope: BackupCryptoScope,
  index: number,
  plaintext: Uint8Array,
) => {
  const plaintextSha256 = sha256(plaintext)
  const nonce = await deterministicNonce(scope, `chunk:${index}:${plaintextSha256}`)
  return new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(nonce),
        additionalData: bufferSource(chunkAad(scope, index, plaintextSha256)),
        tagLength: 128,
      },
      key,
      bufferSource(plaintext),
    ),
  )
}
const decryptChunk = async (
  key: CryptoKey,
  scope: BackupCryptoScope,
  index: number,
  plaintextSha256: string,
  ciphertext: Uint8Array,
) => {
  const nonce = await deterministicNonce(scope, `chunk:${index}:${plaintextSha256}`)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(nonce),
        additionalData: bufferSource(chunkAad(scope, index, plaintextSha256)),
        tagLength: 128,
      },
      key,
      bufferSource(ciphertext),
    ),
  )
}
const authenticateManifest = async (
  key: CryptoKey,
  scope: BackupCryptoScope,
  core: BackupR2ManifestCore,
) => {
  const encodedCore = textEncoder.encode(canonical(core))
  const nonce = await deterministicNonce(scope, `manifest:${sha256(encodedCore)}`)
  const tag = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: bufferSource(nonce),
      additionalData: bufferSource(encodedCore),
      tagLength: 128,
    },
    key,
    new Uint8Array(),
  )
  return base64(new Uint8Array(tag))
}
const verifyManifestAuthentication = async (
  key: CryptoKey,
  scope: BackupCryptoScope,
  manifest: BackupR2Manifest,
) => {
  const { manifestAuthenticationTag, ...core } = manifest
  const encodedCore = textEncoder.encode(canonical(core))
  const nonce = await deterministicNonce(scope, `manifest:${sha256(encodedCore)}`)
  await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bufferSource(nonce),
      additionalData: bufferSource(encodedCore),
      tagLength: 128,
    },
    key,
    bufferSource(unbase64(manifestAuthenticationTag)),
  )
}

const transportFailure = (operation: string, code: BackupR2Error['code'], message: string) =>
  new BackupR2Error({ operation, code, message })
const r2Attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => transportFailure(operation, 'transport-failed', 'R2 operation failed'),
  })
const cryptoAttempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => transportFailure(operation, 'integrity-failed', 'backup authentication failed'),
  })
const readObject = (bucket: BackupR2BucketShape, key: string, operation: string) =>
  Effect.flatMap(
    r2Attempt(operation, () => bucket.get(key)),
    (object) =>
      object === null
        ? Effect.fail(transportFailure(operation, 'not-found', 'backup object not found'))
        : Effect.succeed(object),
  )
const collectBounded = async (body: ReadableStream<Uint8Array>, maximumBytes: number) => {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximumBytes) throw new Error('bounded object exceeded')
    parts.push(next.value)
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}
const readAllBounded = (
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  operation: string,
) =>
  Effect.tryPromise({
    try: () => collectBounded(body, maximumBytes),
    catch: () => transportFailure(operation, 'size-limit', 'R2 object exceeds bound'),
  })

interface BackupObjectOwnership extends BackupKeyCoordinates {
  readonly operationId?: string
  readonly jobId?: string
  readonly uploadSessionId?: string
  readonly uploadGeneration?: number
}

const ownershipMetadata = (
  coordinates: BackupObjectOwnership,
  kind: 'chunk' | 'manifest',
  checksum: string,
) => ({
  'gridora-managed-by': 'gridora',
  'gridora-organization-id': coordinates.organizationId,
  'gridora-server-id': coordinates.serverId,
  'gridora-backup-id': coordinates.backupId,
  'gridora-object-kind': kind,
  'gridora-sha256': checksum,
  ...(coordinates.operationId === undefined
    ? {}
    : { 'gridora-operation-id': coordinates.operationId }),
  ...(coordinates.jobId === undefined ? {} : { 'gridora-job-id': coordinates.jobId }),
  ...(coordinates.uploadSessionId === undefined
    ? {}
    : { 'gridora-upload-session-id': coordinates.uploadSessionId }),
  ...(coordinates.uploadGeneration === undefined
    ? {}
    : { 'gridora-upload-generation': String(coordinates.uploadGeneration) }),
})
const verifyOwnedObject = (
  object: BackupR2ObjectInfo,
  coordinates: BackupObjectOwnership,
  kind: 'chunk' | 'manifest',
  checksum?: string,
) => {
  const expected = ownershipMetadata(
    coordinates,
    kind,
    checksum ?? object.customMetadata['gridora-sha256'] ?? '',
  )
  const owned = Object.entries(expected).every(
    ([key, value]) => object.customMetadata[key] === value,
  )
  return owned
    ? Effect.void
    : Effect.fail(
        transportFailure(
          'backup.objectOwnership',
          'ownership-denied',
          'R2 object ownership mismatch',
        ),
      )
}

export interface ManagedBackupUploadAuthority {
  readonly organizationId: string
  readonly sessionId: string
  readonly leaseId: string
  readonly generation: number
}
export interface ManagedBackupUploadObjectEffect {
  readonly effectId: string
  readonly sessionId: string
  readonly generation: number
  readonly leaseId: string
  readonly objectKey: string
  readonly objectKind: 'chunk' | 'manifest'
  readonly chunkIndex: number
  readonly objectBytes: number
  readonly objectSha256: string
  readonly multipartUploadId: string
  readonly state: 'prepared' | 'completed' | 'aborted'
  readonly providerEtag: string | null
}
export interface ManagedBackupUploadEffectRepositoryShape<R = never> {
  readonly load: (
    objectKey: string,
  ) => Effect.Effect<ManagedBackupUploadObjectEffect | null, BackupR2Error, R>
  readonly register: (
    publication: Omit<BackupUploadObjectPublication, 'value' | 'customMetadata'> & {
      readonly objectBytes: number
      readonly multipartUploadId: string
    },
  ) => Effect.Effect<ManagedBackupUploadObjectEffect, BackupR2Error, R>
  readonly complete: (
    effect: ManagedBackupUploadObjectEffect,
    providerEtag: string,
  ) => Effect.Effect<ManagedBackupUploadObjectEffect, BackupR2Error, R>
  readonly abort: (
    effect: ManagedBackupUploadObjectEffect,
  ) => Effect.Effect<ManagedBackupUploadObjectEffect, BackupR2Error, R>
  readonly listPrepared: Effect.Effect<
    ReadonlyArray<ManagedBackupUploadObjectEffect>,
    BackupR2Error,
    R
  >
}

const exactManagedObject = <R>(
  bucket: BackupR2BucketShape,
  object: BackupR2ObjectInfo,
  publication: Omit<BackupUploadObjectPublication, 'value'> & { readonly objectBytes: number },
): Effect.Effect<BackupR2ObjectInfo, BackupR2Error, R> =>
  Effect.gen(function* () {
    yield* verifyOwnedObject(
      object,
      {
        organizationId: publication.customMetadata['gridora-organization-id'] ?? '',
        serverId: publication.customMetadata['gridora-server-id'] ?? '',
        backupId: publication.customMetadata['gridora-backup-id'] ?? '',
        operationId: publication.customMetadata['gridora-operation-id'] ?? '',
        jobId: publication.customMetadata['gridora-job-id'] ?? '',
        uploadSessionId: publication.customMetadata['gridora-upload-session-id'] ?? '',
        uploadGeneration: Number(publication.customMetadata['gridora-upload-generation']),
      },
      publication.kind,
      publication.checksum,
    )
    if (object.size !== publication.objectBytes)
      return yield* transportFailure(
        'backup.multipart.adopt',
        'conflict',
        'managed R2 object size differs',
      )
    const body = yield* readObject(bucket, publication.key, 'backup.multipart.adopt.get')
    const observed = yield* readAllBounded(
      body.body,
      publication.objectBytes,
      'backup.multipart.adopt.read',
    )
    if (
      observed.byteLength !== publication.objectBytes ||
      sha256(observed) !== publication.checksum
    )
      return yield* transportFailure(
        'backup.multipart.adopt',
        'integrity-failed',
        'managed R2 object checksum differs',
      )
    return object
  })

/** Provider-backed publication protocol. Multipart upload identity is written
 * to D1 before uploadPart. Recovery either adopts the exact completed object
 * or waits for an explicit provider abort; absence and elapsed time alone are
 * never treated as terminal evidence. */
export const makeManagedBackupUploadObjectPublisher = <R>(
  bucket: BackupR2BucketShape,
  authority: ManagedBackupUploadAuthority,
  repository: ManagedBackupUploadEffectRepositoryShape<R>,
): BackupUploadObjectPublisher<R> => {
  const settle = (
    effect: ManagedBackupUploadObjectEffect,
    publication: Omit<BackupUploadObjectPublication, 'value'> & {
      readonly objectBytes: number
    },
  ): Effect.Effect<
    | { readonly state: 'completed'; readonly object: BackupR2ObjectInfo }
    | {
        readonly state: 'aborted'
      },
    BackupR2Error,
    R
  > =>
    Effect.gen(function* () {
      const visible = yield* r2Attempt('backup.multipart.recover.head', () =>
        bucket.head(publication.key),
      )
      if (visible !== null) {
        const object = yield* exactManagedObject<R>(bucket, visible, publication)
        yield* repository.complete(effect, object.etag)
        return { state: 'completed' as const, object }
      }
      const upload = bucket.resumeMultipartUpload(effect.objectKey, effect.multipartUploadId)
      const aborted = yield* Effect.result(
        r2Attempt('backup.multipart.recover.abort', () => upload.abort()),
      )
      const afterAbort = yield* r2Attempt('backup.multipart.recover.head-after-abort', () =>
        bucket.head(publication.key),
      )
      if (afterAbort !== null) {
        const object = yield* exactManagedObject<R>(bucket, afterAbort, publication)
        yield* repository.complete(effect, object.etag)
        return { state: 'completed' as const, object }
      }
      if (aborted._tag === 'Failure')
        return yield* transportFailure(
          'backup.multipart.recover',
          'upload-uncertain',
          'multipart abort outcome is not terminal; exact retry is required',
        )
      yield* repository.abort(effect)
      return { state: 'aborted' as const }
    })

  return (publication) =>
    Effect.gen(function* () {
      const objectBytes =
        typeof publication.value === 'string'
          ? textEncoder.encode(publication.value).byteLength
          : publication.value.byteLength
      const coordinates = { ...publication, objectBytes }
      let selected = yield* repository.load(publication.key)
      if (selected !== null && selected.state === 'completed') {
        const object = yield* r2Attempt('backup.multipart.completed.head', () =>
          bucket.head(publication.key),
        )
        if (object === null)
          return yield* transportFailure(
            'backup.multipart.completed',
            'conflict',
            'completed multipart receipt has no exact R2 object',
          )
        return yield* exactManagedObject<R>(bucket, object, coordinates)
      }
      if (
        selected !== null &&
        selected.state === 'prepared' &&
        selected.leaseId !== authority.leaseId
      ) {
        const recovered = yield* settle(selected, coordinates)
        if (recovered.state === 'completed') return recovered.object
        selected = null
      }
      if (selected === null || selected.state === 'aborted') {
        const created = yield* r2Attempt('backup.multipart.create', () =>
          bucket.createMultipartUpload(publication.key, {
            customMetadata: publication.customMetadata,
            onlyIfAbsent: true,
          }),
        )
        selected = yield* repository.register({
          key: publication.key,
          kind: publication.kind,
          checksum: publication.checksum,
          index: publication.index,
          objectBytes,
          multipartUploadId: created.uploadId,
        })
        if (selected.multipartUploadId !== created.uploadId) {
          const discarded = yield* Effect.result(
            r2Attempt('backup.multipart.discard-unselected', () => created.abort()),
          )
          if (discarded._tag === 'Failure')
            return yield* transportFailure(
              'backup.multipart.discard-unselected',
              'upload-uncertain',
              'an unselected empty multipart handle could not be aborted',
            )
        }
      }
      if (selected.state !== 'prepared')
        return yield* transportFailure(
          'backup.multipart.publish',
          'conflict',
          'multipart effect is not writable',
        )
      const upload = bucket.resumeMultipartUpload(selected.objectKey, selected.multipartUploadId)
      const published = yield* Effect.result(
        Effect.gen(function* () {
          const part = yield* r2Attempt('backup.multipart.upload-part', () =>
            upload.uploadPart(1, publication.value),
          )
          return yield* r2Attempt('backup.multipart.complete', () => upload.complete([part]))
        }),
      )
      if (published._tag === 'Success') {
        const object = yield* exactManagedObject<R>(bucket, published.success, coordinates)
        yield* repository.complete(selected, object.etag)
        return object
      }
      const recovered = yield* settle(selected, coordinates)
      if (recovered.state === 'completed') return recovered.object
      return yield* transportFailure(
        'backup.multipart.publish',
        'transport-failed',
        'multipart publication was explicitly aborted after provider failure',
      )
    })
}

export const recoverManagedBackupUploadEffects = <R>(
  bucket: BackupR2BucketShape,
  authority: ManagedBackupUploadAuthority,
  repository: ManagedBackupUploadEffectRepositoryShape<R>,
): Effect.Effect<{ readonly completed: number; readonly aborted: number }, BackupR2Error, R> =>
  Effect.gen(function* () {
    let completed = 0
    let aborted = 0
    const prepared = yield* repository.listPrepared
    for (const effect of prepared) {
      if (effect.sessionId !== authority.sessionId || effect.generation !== authority.generation)
        return yield* transportFailure(
          'backup.multipart.reconcile',
          'ownership-denied',
          'multipart effect escaped the exact upload generation',
        )
      const visible = yield* r2Attempt('backup.multipart.reconcile.head', () =>
        bucket.head(effect.objectKey),
      )
      if (visible !== null) {
        if (
          visible.size !== effect.objectBytes ||
          visible.customMetadata['gridora-upload-session-id'] !== authority.sessionId ||
          visible.customMetadata['gridora-upload-generation'] !== String(authority.generation) ||
          visible.customMetadata['gridora-sha256'] !== effect.objectSha256
        )
          return yield* transportFailure(
            'backup.multipart.reconcile',
            'ownership-denied',
            'visible object does not match the durable multipart effect',
          )
        yield* repository.complete(effect, visible.etag)
        completed += 1
        continue
      }
      const upload = bucket.resumeMultipartUpload(effect.objectKey, effect.multipartUploadId)
      const providerAbort = yield* Effect.result(
        r2Attempt('backup.multipart.reconcile.abort', () => upload.abort()),
      )
      const afterAbort = yield* r2Attempt('backup.multipart.reconcile.head-after-abort', () =>
        bucket.head(effect.objectKey),
      )
      if (afterAbort !== null) {
        if (
          afterAbort.size !== effect.objectBytes ||
          afterAbort.customMetadata['gridora-upload-session-id'] !== authority.sessionId ||
          afterAbort.customMetadata['gridora-upload-generation'] !== String(authority.generation) ||
          afterAbort.customMetadata['gridora-sha256'] !== effect.objectSha256
        )
          return yield* transportFailure(
            'backup.multipart.reconcile',
            'ownership-denied',
            'post-abort object does not match the durable multipart effect',
          )
        yield* repository.complete(effect, afterAbort.etag)
        completed += 1
        continue
      }
      if (providerAbort._tag === 'Failure')
        return yield* transportFailure(
          'backup.multipart.reconcile',
          'upload-uncertain',
          'provider did not prove multipart completion or abort',
        )
      yield* repository.abort(effect)
      aborted += 1
    }
    return { completed, aborted }
  })

const putOrAdopt = <R>(
  bucket: BackupR2BucketShape,
  coordinates: BackupObjectOwnership,
  key: string,
  value: Uint8Array | string,
  kind: 'chunk' | 'manifest',
  checksum: string,
  publicationGuard: UploadBackupInput<R>['publicationGuard'],
  publishObject: UploadBackupInput<R>['publishObject'],
  index: number | null,
) =>
  Effect.gen(function* () {
    yield* publicationGuard({ phase: 'before', kind, key, index })
    const expectedSize =
      typeof value === 'string' ? textEncoder.encode(value).byteLength : value.byteLength
    const adopt = (object: BackupR2ObjectInfo) =>
      Effect.gen(function* () {
        yield* verifyOwnedObject(object, coordinates, kind, checksum)
        if (object.size !== expectedSize)
          return yield* transportFailure(
            'backup.adopt',
            'conflict',
            'existing R2 object size differs',
          )
        const body = yield* readObject(bucket, key, 'backup.adopt.get')
        const observed = yield* readAllBounded(body.body, expectedSize, 'backup.adopt.read')
        if (observed.byteLength !== expectedSize || sha256(observed) !== checksum)
          return yield* transportFailure(
            'backup.adopt',
            'integrity-failed',
            'existing R2 object checksum differs',
          )
        return object
      })
    const existing = yield* r2Attempt('backup.head', () => bucket.head(key))
    if (existing !== null) {
      const adopted = yield* adopt(existing)
      yield* publicationGuard({ phase: 'after', kind, key, index })
      return adopted
    }
    const metadata = ownershipMetadata(coordinates, kind, checksum)
    const stored = yield* Effect.catch(
      publishObject({ key, value, kind, checksum, index, customMetadata: metadata }),
      (failure) =>
        Effect.flatMap(
          r2Attempt('backup.put.recover', () => bucket.head(key)),
          (afterLoss) => (afterLoss === null ? Effect.fail(failure) : adopt(afterLoss)),
        ),
    )
    yield* publicationGuard({ phase: 'after', kind, key, index })
    return stored
  })

const parseManifest = (bytes: Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: () =>
      transportFailure('backup.manifest.decode', 'integrity-failed', 'manifest is invalid'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(BackupR2Manifest)(value).pipe(
        Effect.mapError(() =>
          transportFailure('backup.manifest.decode', 'integrity-failed', 'manifest is invalid'),
        ),
      ),
    ),
  )

const validateUpload = <R>(
  context: Pick<OrganizationContext, 'organizationId'>,
  input: UploadBackupInput<R>,
) => {
  if (
    ![
      context.organizationId,
      input.backupId,
      input.serverId,
      input.operationId,
      input.jobId,
      input.uploadSessionId,
      input.uploadLeaseId,
    ].every(safeIdentifier) ||
    !Number.isSafeInteger(input.uploadGeneration) ||
    input.uploadGeneration < 1 ||
    input.uploadGeneration > 1024 ||
    input.containsGameBinaries !== false ||
    input.includes.length === 0 ||
    input.includes.some(
      (category) => !(['config', 'data', 'mods', 'state'] as const).includes(category),
    ) ||
    new Set(input.includes).size !== input.includes.length ||
    !checksumPattern.test(input.compressedSha256) ||
    !Number.isSafeInteger(input.compressedBytes) ||
    input.compressedBytes <= 0 ||
    !Number.isSafeInteger(input.maximumCompressedBytes) ||
    input.maximumCompressedBytes <= 0
  )
    return Effect.fail(
      transportFailure('backup.upload', 'invalid-input', 'backup upload contract is invalid'),
    )
  if (input.compressedBytes > input.maximumCompressedBytes)
    return Effect.fail(
      transportFailure('backup.upload', 'size-limit', 'backup exceeds upload size policy'),
    )
  if (input.maximumCompressedBytes > BACKUP_R2_LIMITS.maximumBackupBytes)
    return Effect.fail(
      transportFailure('backup.upload', 'size-limit', 'backup size policy exceeds platform limit'),
    )
  const maximumChunkBytes = input.maximumChunkBytes ?? 1024 * 1024
  if (
    !Number.isSafeInteger(maximumChunkBytes) ||
    maximumChunkBytes < BACKUP_R2_LIMITS.minimumChunkBytes ||
    maximumChunkBytes > BACKUP_R2_LIMITS.maximumChunkBytes
  )
    return Effect.fail(
      transportFailure('backup.upload', 'invalid-input', 'backup chunk bound is invalid'),
    )
  if (Math.ceil(input.compressedBytes / maximumChunkBytes) > BACKUP_R2_LIMITS.maximumChunks)
    return Effect.fail(
      transportFailure('backup.upload', 'size-limit', 'backup exceeds the encrypted chunk limit'),
    )
  return Effect.succeed(maximumChunkBytes)
}

const loadManifest = (
  bucket: BackupR2BucketShape,
  coordinates: BackupKeyCoordinates,
  maximumBytes = BACKUP_R2_LIMITS.maximumManifestBytes,
) =>
  Effect.gen(function* () {
    const object = yield* readObject(bucket, manifestKey(coordinates), 'backup.manifest.get')
    yield* verifyOwnedObject(object, coordinates, 'manifest')
    const bytes = yield* readAllBounded(object.body, maximumBytes, 'backup.manifest.read')
    if (object.customMetadata['gridora-sha256'] !== sha256(bytes))
      return yield* transportFailure(
        'backup.manifest.read',
        'integrity-failed',
        'manifest object checksum mismatch',
      )
    const manifest = yield* parseManifest(bytes)
    yield* verifyOwnedObject(
      object,
      {
        ...coordinates,
        operationId: manifest.operationId,
        jobId: manifest.jobId,
        uploadSessionId: manifest.uploadSessionId,
        uploadGeneration: manifest.uploadGeneration,
      },
      'manifest',
    )
    return manifest
  })

export const BackupR2TransportLive = Layer.effect(
  BackupR2Transport,
  Effect.gen(function* () {
    const bucket = yield* BackupR2Bucket
    const keyPort = yield* BackupDataKeyPort
    return BackupR2Transport.of({
      upload: (context, input) =>
        Effect.gen(function* () {
          const maximumChunkBytes = yield* validateUpload(context, input)
          const coordinates = {
            organizationId: context.organizationId,
            serverId: input.serverId,
            backupId: input.backupId,
          }
          const ownership = {
            ...coordinates,
            operationId: input.operationId,
            jobId: input.jobId,
            uploadSessionId: input.uploadSessionId,
            uploadGeneration: input.uploadGeneration,
          }
          const cryptoScope = {
            ...ownership,
            plaintextSha256: input.compressedSha256,
            chunkBytes: maximumChunkBytes,
          }
          yield* input.publicationGuard({
            phase: 'before',
            kind: 'manifest',
            key: manifestKey(coordinates),
            index: null,
          })
          const existing = yield* r2Attempt('backup.manifest.head', () =>
            bucket.head(manifestKey(coordinates)),
          )
          if (existing !== null) {
            const manifest = yield* loadManifest(bucket, coordinates)
            if (
              manifest.operationId !== input.operationId ||
              manifest.jobId !== input.jobId ||
              manifest.uploadSessionId !== input.uploadSessionId ||
              manifest.uploadGeneration !== input.uploadGeneration ||
              manifest.plaintext.sha256 !== input.compressedSha256 ||
              manifest.plaintext.bytes !== input.compressedBytes ||
              manifest.maximumChunkBytes !== maximumChunkBytes ||
              manifest.createdAt !== input.createdAt ||
              JSON.stringify(manifest.content.includes) !== JSON.stringify(input.includes)
            )
              return yield* transportFailure(
                'backup.upload',
                'conflict',
                'backup identity already has different content',
              )
            const raw = yield* keyPort.unwrap(
              coordinates,
              manifest.encryption.keyVersion,
              manifest.encryption.wrappedDataKey,
            )
            yield* cryptoAttempt('backup.manifest.verify', async () => {
              const key = await importedAesKey(raw, ['decrypt'])
              await verifyManifestAuthentication(key, cryptoScope, manifest)
            }).pipe(Effect.ensuring(Effect.sync(() => raw.fill(0))))
            yield* input.publicationGuard({
              phase: 'after',
              kind: 'manifest',
              key: manifestKey(coordinates),
              index: null,
            })
            return manifest
          }
          const issued = yield* keyPort.issue(coordinates)
          if (
            issued.plaintextKey.byteLength !== 32 ||
            issued.wrappedDataKey.length === 0 ||
            !Number.isSafeInteger(issued.keyVersion) ||
            issued.keyVersion <= 0
          )
            return yield* Effect.sync(() => issued.plaintextKey.fill(0)).pipe(
              Effect.andThen(
                Effect.fail(
                  transportFailure(
                    'backup.key.issue',
                    'key-failed',
                    'backup key port returned invalid material',
                  ),
                ),
              ),
            )
          return yield* Effect.gen(function* () {
            const key = yield* cryptoAttempt('backup.key.import', () =>
              importedAesKey(issued.plaintextKey, ['encrypt']),
            )
            const reader = input.stream.getReader()
            const plaintextHash = new StreamingSha256()
            const ciphertextHash = new StreamingSha256()
            const chunks: BackupR2Chunk[] = []
            let plaintextBytes = 0
            let ciphertextBytes = 0
            let pending = new Uint8Array(maximumChunkBytes)
            let pendingBytes = 0
            const persistChunk = (plaintext: Uint8Array) =>
              Effect.gen(function* () {
                const index = chunks.length
                if (index >= BACKUP_R2_LIMITS.maximumChunks)
                  return yield* transportFailure(
                    'backup.stream.read',
                    'size-limit',
                    'backup exceeds the maximum encrypted chunk count',
                  )
                const plaintextSha256 = sha256(plaintext)
                const encrypted = yield* cryptoAttempt('backup.chunk.encrypt', () =>
                  encryptChunk(key, cryptoScope, index, plaintext),
                )
                ciphertextHash.update(encrypted)
                ciphertextBytes += encrypted.byteLength
                const descriptor: BackupR2Chunk = {
                  index,
                  key: chunkKey(coordinates, index),
                  plaintextBytes: plaintext.byteLength,
                  ciphertextBytes: encrypted.byteLength,
                  plaintextSha256,
                  ciphertextSha256: sha256(encrypted),
                }
                yield* putOrAdopt(
                  bucket,
                  ownership,
                  descriptor.key,
                  encrypted,
                  'chunk',
                  descriptor.ciphertextSha256,
                  input.publicationGuard,
                  input.publishObject,
                  index,
                )
                chunks.push(descriptor)
              })
            while (true) {
              const next = yield* Effect.tryPromise({
                try: () => reader.read(),
                catch: () =>
                  transportFailure(
                    'backup.stream.read',
                    'transport-failed',
                    'backup stream failed',
                  ),
              })
              if (next.done) break
              if (next.value.byteLength === 0) continue
              if (next.value.byteLength > maximumChunkBytes)
                return yield* transportFailure(
                  'backup.stream.read',
                  'size-limit',
                  'producer chunk exceeds the configured memory bound',
                )
              plaintextBytes += next.value.byteLength
              if (
                plaintextBytes > input.maximumCompressedBytes ||
                plaintextBytes > input.compressedBytes
              )
                return yield* transportFailure(
                  'backup.stream.read',
                  'size-limit',
                  'backup stream exceeds its declared size',
                )
              plaintextHash.update(next.value)
              let sourceOffset = 0
              while (sourceOffset < next.value.byteLength) {
                const take = Math.min(
                  maximumChunkBytes - pendingBytes,
                  next.value.byteLength - sourceOffset,
                )
                pending.set(next.value.subarray(sourceOffset, sourceOffset + take), pendingBytes)
                pendingBytes += take
                sourceOffset += take
                if (pendingBytes === maximumChunkBytes) {
                  yield* persistChunk(pending)
                  pending = new Uint8Array(maximumChunkBytes)
                  pendingBytes = 0
                }
              }
            }
            if (pendingBytes > 0) yield* persistChunk(pending.slice(0, pendingBytes))
            const observedPlaintext = `sha256:${hex(plaintextHash.digest())}`
            if (
              plaintextBytes !== input.compressedBytes ||
              observedPlaintext !== input.compressedSha256 ||
              chunks.length === 0
            )
              return yield* transportFailure(
                'backup.stream.verify',
                'integrity-failed',
                'compressed backup size or checksum mismatch',
              )
            const core: BackupR2ManifestCore = {
              apiVersion: 'backup.r2.gridora.dev/v1alpha1',
              organizationId: context.organizationId,
              backupId: input.backupId,
              serverId: input.serverId,
              operationId: input.operationId,
              jobId: input.jobId,
              uploadSessionId: input.uploadSessionId,
              uploadGeneration: input.uploadGeneration,
              createdAt: input.createdAt,
              content: {
                policy: 'server-state-only',
                includes: [...input.includes],
                excludes: ['game'],
                containsGameBinaries: false,
              },
              encryption: {
                algorithm: 'AES-256-GCM-CHUNKED',
                keyVersion: issued.keyVersion,
                wrappedDataKey: issued.wrappedDataKey,
              },
              plaintext: {
                encoding: 'tar+zstd',
                bytes: plaintextBytes,
                sha256: observedPlaintext,
              },
              ciphertext: {
                bytes: ciphertextBytes,
                sha256: `sha256:${hex(ciphertextHash.digest())}`,
              },
              maximumChunkBytes,
              chunks,
            }
            const manifest: BackupR2Manifest = {
              ...core,
              manifestAuthenticationTag: yield* cryptoAttempt('backup.manifest.authenticate', () =>
                authenticateManifest(key, cryptoScope, core),
              ),
            }
            const encoded = canonical(manifest)
            yield* putOrAdopt(
              bucket,
              ownership,
              manifestKey(coordinates),
              encoded,
              'manifest',
              sha256(textEncoder.encode(encoded)),
              input.publicationGuard,
              input.publishObject,
              null,
            )
            return manifest
          }).pipe(Effect.ensuring(Effect.sync(() => issued.plaintextKey.fill(0))))
        }),
      restore: (context, input) =>
        Effect.gen(function* () {
          if (
            ![context.organizationId, input.backupId, input.serverId].every(safeIdentifier) ||
            !Number.isSafeInteger(input.maximumRestoreBytes) ||
            input.maximumRestoreBytes <= 0
          )
            return yield* transportFailure(
              'backup.restore',
              'invalid-input',
              'restore contract is invalid',
            )
          const coordinates = {
            organizationId: context.organizationId,
            serverId: input.serverId,
            backupId: input.backupId,
          }
          const manifest = yield* loadManifest(bucket, coordinates)
          if (
            manifest.organizationId !== context.organizationId ||
            manifest.serverId !== input.serverId ||
            manifest.backupId !== input.backupId
          )
            return yield* transportFailure(
              'backup.restore',
              'ownership-denied',
              'backup does not belong to restore scope',
            )
          if (manifest.plaintext.bytes > input.maximumRestoreBytes)
            return yield* transportFailure(
              'backup.restore',
              'size-limit',
              'backup exceeds restore size policy',
            )
          const raw = yield* keyPort.unwrap(
            coordinates,
            manifest.encryption.keyVersion,
            manifest.encryption.wrappedDataKey,
          )
          const cryptoScope = {
            ...coordinates,
            operationId: manifest.operationId,
            jobId: manifest.jobId,
            uploadSessionId: manifest.uploadSessionId,
            uploadGeneration: manifest.uploadGeneration,
            plaintextSha256: manifest.plaintext.sha256,
            chunkBytes: manifest.maximumChunkBytes,
          }
          const expectedChunkCount = Math.ceil(
            manifest.plaintext.bytes / manifest.maximumChunkBytes,
          )
          if (
            manifest.maximumChunkBytes < BACKUP_R2_LIMITS.minimumChunkBytes ||
            manifest.maximumChunkBytes > BACKUP_R2_LIMITS.maximumChunkBytes ||
            manifest.chunks.length !== expectedChunkCount ||
            expectedChunkCount > BACKUP_R2_LIMITS.maximumChunks
          )
            return yield* transportFailure(
              'backup.restore',
              'integrity-failed',
              'backup chunk layout is invalid',
            )
          const key = yield* Effect.gen(function* () {
            const imported = yield* cryptoAttempt('backup.key.import', () =>
              importedAesKey(raw, ['decrypt']),
            )
            yield* cryptoAttempt('backup.manifest.verify', () =>
              verifyManifestAuthentication(imported, cryptoScope, manifest),
            )
            return imported
          }).pipe(Effect.ensuring(Effect.sync(() => raw.fill(0))))
          let index = 0
          let plaintextBytes = 0
          let ciphertextBytes = 0
          const plaintextHash = new StreamingSha256()
          const ciphertextHash = new StreamingSha256()
          const stream = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              try {
                if (index >= manifest.chunks.length) {
                  if (
                    plaintextBytes !== manifest.plaintext.bytes ||
                    ciphertextBytes !== manifest.ciphertext.bytes ||
                    `sha256:${hex(plaintextHash.digest())}` !== manifest.plaintext.sha256 ||
                    `sha256:${hex(ciphertextHash.digest())}` !== manifest.ciphertext.sha256
                  )
                    throw new Error('aggregate integrity mismatch')
                  controller.close()
                  return
                }
                const descriptor = manifest.chunks[index]!
                if (
                  descriptor.index !== index ||
                  descriptor.key !== chunkKey(coordinates, index) ||
                  descriptor.plaintextBytes !==
                    (index + 1 === manifest.chunks.length
                      ? manifest.plaintext.bytes - index * manifest.maximumChunkBytes
                      : manifest.maximumChunkBytes)
                )
                  throw new Error('chunk manifest mismatch')
                const object = await bucket.get(descriptor.key)
                if (object === null) throw new Error('chunk missing')
                const metadata = object.customMetadata
                if (
                  metadata['gridora-managed-by'] !== 'gridora' ||
                  metadata['gridora-organization-id'] !== coordinates.organizationId ||
                  metadata['gridora-server-id'] !== coordinates.serverId ||
                  metadata['gridora-backup-id'] !== coordinates.backupId ||
                  metadata['gridora-operation-id'] !== manifest.operationId ||
                  metadata['gridora-job-id'] !== manifest.jobId ||
                  metadata['gridora-upload-session-id'] !== manifest.uploadSessionId ||
                  metadata['gridora-upload-generation'] !== String(manifest.uploadGeneration) ||
                  metadata['gridora-object-kind'] !== 'chunk' ||
                  metadata['gridora-sha256'] !== descriptor.ciphertextSha256
                )
                  throw new Error('chunk ownership mismatch')
                const ciphertext = await collectBounded(object.body, descriptor.ciphertextBytes)
                if (
                  ciphertext.byteLength !== descriptor.ciphertextBytes ||
                  sha256(ciphertext) !== descriptor.ciphertextSha256
                )
                  throw new Error('ciphertext checksum mismatch')
                const plaintext = await decryptChunk(
                  key,
                  cryptoScope,
                  index,
                  descriptor.plaintextSha256,
                  ciphertext,
                )
                if (
                  plaintext.byteLength !== descriptor.plaintextBytes ||
                  sha256(plaintext) !== descriptor.plaintextSha256
                )
                  throw new Error('plaintext checksum mismatch')
                ciphertextHash.update(ciphertext)
                plaintextHash.update(plaintext)
                ciphertextBytes += ciphertext.byteLength
                plaintextBytes += plaintext.byteLength
                index++
                controller.enqueue(plaintext)
              } catch {
                controller.error(
                  transportFailure(
                    'backup.restore.stream',
                    'integrity-failed',
                    'restore stream authentication failed',
                  ),
                )
              }
            },
          })
          return { manifest, stream }
        }),
    })
  }),
)

export const makeBackupR2TransportLayer = (
  bucket: BackupR2BucketShape,
  keyPort: BackupDataKeyPortShape,
) =>
  BackupR2TransportLive.pipe(
    Layer.provide(BackupR2BucketLayer(bucket)),
    Layer.provide(BackupDataKeyPortLayer(keyPort)),
  )

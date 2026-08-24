import { constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'

const checksum = /^sha256:[a-f0-9]{64}$/
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const maximumChunkBytes = 4 * 1024 * 1024
const minimumChunkBytes = 64 * 1024
const maximumChunks = 65_536
const maximumBackupBytes = maximumChunkBytes * maximumChunks

export class BackupUploadError extends Schema.TaggedError<BackupUploadError>()(
  'BackupUploadError',
  {
    code: Schema.Literals([
      'invalid-input',
      'cancelled',
      'size-limit',
      'corrupt-state',
      'corrupt-remote',
      'transport-failed',
    ]),
    message: Schema.String,
  },
) {}

export interface RemoteBackupChunk {
  readonly index: number
  readonly bytes: number
  readonly sha256: string
}

export interface BackupChunkUploadTransportShape {
  readonly headChunk: (input: {
    readonly organizationId: string
    readonly serverId: string
    readonly backupId: string
    readonly operationId: string
    readonly index: number
  }) => Effect.Effect<RemoteBackupChunk | null, BackupUploadError>
  readonly putChunk: (input: {
    readonly organizationId: string
    readonly serverId: string
    readonly backupId: string
    readonly operationId: string
    readonly index: number
    readonly bytes: Uint8Array
    readonly sha256: string
    readonly signal?: AbortSignal
  }) => Effect.Effect<RemoteBackupChunk, BackupUploadError>
  /** The server authenticates and publishes the manifest only after all exact chunks exist. */
  readonly putManifest: (input: {
    readonly organizationId: string
    readonly serverId: string
    readonly backupId: string
    readonly operationId: string
    readonly bytes: number
    readonly sha256: string
    readonly manifest: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }) => Effect.Effect<{ readonly sha256: string }, BackupUploadError>
}
export class BackupChunkUploadTransport extends Context.Service<
  BackupChunkUploadTransport,
  BackupChunkUploadTransportShape
>()('@gridora/agent/BackupChunkUploadTransport') {}
export const BackupChunkUploadTransportLayer = (port: BackupChunkUploadTransportShape) =>
  Layer.succeed(BackupChunkUploadTransport, port)

const chunkRecord = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sha256: Schema.String.check(Schema.isPattern(checksum)),
})
const uploadState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: Schema.String,
  serverId: Schema.String,
  backupId: Schema.String,
  operationId: Schema.String,
  chunkBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimumChunkBytes)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  archiveSha256: Schema.String.check(Schema.isPattern(checksum)),
  nextChunk: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  chunks: Schema.Array(chunkRecord),
  complete: Schema.Boolean,
  manifestSha256: Schema.optional(Schema.String.check(Schema.isPattern(checksum))),
})
type UploadState = typeof uploadState.Type

export interface BackupArchiveUploadInput {
  readonly organizationId: string
  readonly serverId: string
  readonly backupId: string
  readonly operationId: string
  readonly archivePath: string
  readonly expectedBytes: number
  readonly expectedSha256: string
  readonly chunkBytes?: number
  readonly manifest: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}
export interface BackupArchiveUploadReceipt {
  readonly organizationId: string
  readonly serverId: string
  readonly backupId: string
  readonly bytes: number
  readonly sha256: string
  readonly chunks: number
  readonly manifestSha256: string
}

const failure = (
  code: ConstructorParameters<typeof BackupUploadError>[0]['code'],
  message: string,
) => new BackupUploadError({ code, message })
const hashChunk = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const checkCancelled = (signal: AbortSignal | undefined): Effect.Effect<void, BackupUploadError> =>
  signal?.aborted ? Effect.fail(failure('cancelled', 'backup upload was cancelled')) : Effect.void
const safeStateName = (backupId: string) => `${backupId}.upload.json`

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

const readState = (path: string): Effect.Effect<UploadState | null, BackupUploadError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
        return Schema.decodeUnknownSync(uploadState)(parsed)
      } catch (cause) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        )
          return null
        throw failure('corrupt-state', 'backup upload state is invalid or unreadable')
      }
    },
    catch: () => failure('corrupt-state', 'backup upload state is invalid or unreadable'),
  })

const writeState = (path: string, state: UploadState): Effect.Effect<void, BackupUploadError> =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${path}.${process.pid}.partial`
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    },
    catch: () => failure('transport-failed', 'backup upload state could not be persisted'),
  })

const validateRemote = (
  expected: RemoteBackupChunk,
  observed: RemoteBackupChunk | null,
): Effect.Effect<void, BackupUploadError> =>
  observed === null
    ? Effect.fail(failure('transport-failed', 'backup chunk is not present after upload'))
    : observed.index !== expected.index ||
        observed.bytes !== expected.bytes ||
        observed.sha256 !== expected.sha256
      ? Effect.fail(
          failure('corrupt-remote', 'remote backup chunk does not match the local checksum'),
        )
      : Effect.void

export interface BackupChunkUploaderShape {
  readonly upload: (
    input: BackupArchiveUploadInput,
  ) => Effect.Effect<BackupArchiveUploadReceipt, BackupUploadError>
}
export class BackupChunkUploader extends Context.Service<
  BackupChunkUploader,
  BackupChunkUploaderShape
>()('@gridora/agent/BackupChunkUploader') {}

export const NodeBackupChunkUploader = (options: {
  readonly trustedRoot: string
  readonly stateDirectory?: string
}) =>
  Layer.effect(
    BackupChunkUploader,
    Effect.gen(function* () {
      const transport = yield* BackupChunkUploadTransport
      const trustedRoot = resolve(options.trustedRoot)
      const stateDirectory = resolve(
        options.stateDirectory ?? join(trustedRoot, '.gridora-upload-state'),
      )
      return BackupChunkUploader.of({
        upload: (input) =>
          Effect.gen(function* () {
            if (
              ![input.organizationId, input.serverId, input.backupId, input.operationId].every(
                (value) => safeIdentifier.test(value),
              ) ||
              !isAbsolute(input.archivePath) ||
              !checksum.test(input.expectedSha256) ||
              !Number.isSafeInteger(input.expectedBytes) ||
              input.expectedBytes <= 0 ||
              input.expectedBytes > maximumBackupBytes
            )
              return yield* failure('invalid-input', 'backup upload contract is invalid')
            const chunkBytes = input.chunkBytes ?? maximumChunkBytes
            if (
              !Number.isSafeInteger(chunkBytes) ||
              chunkBytes < minimumChunkBytes ||
              chunkBytes > maximumChunkBytes ||
              Math.ceil(input.expectedBytes / chunkBytes) > maximumChunks
            )
              return yield* failure('size-limit', 'backup chunk policy is invalid')
            const archivePath = resolve(input.archivePath)
            if (!within(trustedRoot, archivePath))
              return yield* failure('invalid-input', 'archive path escapes the trusted server root')
            yield* checkCancelled(input.signal)
            yield* Effect.tryPromise({
              try: () => mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
              catch: () => failure('transport-failed', 'backup state directory is unavailable'),
            })
            const statePath = join(stateDirectory, safeStateName(input.backupId))
            const prior = yield* readState(statePath)
            if (
              prior !== null &&
              (prior.organizationId !== input.organizationId ||
                prior.serverId !== input.serverId ||
                prior.backupId !== input.backupId ||
                prior.operationId !== input.operationId ||
                prior.chunkBytes !== chunkBytes ||
                prior.totalBytes !== input.expectedBytes ||
                prior.archiveSha256 !== input.expectedSha256)
            )
              return yield* failure(
                'corrupt-state',
                'backup upload state belongs to a different exact request',
              )
            const handle = yield* Effect.tryPromise({
              try: () => open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
              catch: () => failure('invalid-input', 'backup archive cannot be opened safely'),
            })
            try {
              const info = yield* Effect.tryPromise({
                try: () => handle.stat(),
                catch: () => failure('transport-failed', 'backup archive metadata is unavailable'),
              })
              if (!info.isFile() || info.size !== input.expectedBytes)
                return yield* failure(
                  'corrupt-state',
                  'backup archive size changed during resumable upload',
                )
              let state: UploadState = prior ?? {
                schemaVersion: 1,
                organizationId: input.organizationId,
                serverId: input.serverId,
                backupId: input.backupId,
                operationId: input.operationId,
                chunkBytes,
                totalBytes: input.expectedBytes,
                archiveSha256: input.expectedSha256,
                nextChunk: 0,
                chunks: [],
                complete: false,
              }
              const totalChunks = Math.ceil(input.expectedBytes / chunkBytes)
              for (let index = 0; index < totalChunks; index += 1) {
                yield* checkCancelled(input.signal)
                const bytesExpected =
                  index === totalChunks - 1 ? input.expectedBytes - index * chunkBytes : chunkBytes
                const bytes = yield* Effect.tryPromise({
                  try: async () => {
                    const buffer = new Uint8Array(bytesExpected)
                    let offset = 0
                    while (offset < bytesExpected) {
                      const read = await handle.read(
                        buffer,
                        offset,
                        bytesExpected - offset,
                        index * chunkBytes + offset,
                      )
                      if (read.bytesRead === 0) throw new Error('archive truncated')
                      offset += read.bytesRead
                    }
                    return buffer
                  },
                  catch: () => failure('corrupt-state', 'backup archive could not be read exactly'),
                })
                const sha256 = hashChunk(bytes)
                const expected: RemoteBackupChunk = { index, bytes: bytes.byteLength, sha256 }
                const persisted = state.chunks[index]
                if (
                  persisted !== undefined &&
                  (persisted.index !== expected.index ||
                    persisted.bytes !== expected.bytes ||
                    persisted.sha256 !== expected.sha256)
                )
                  return yield* failure(
                    'corrupt-state',
                    'persisted chunk checksum does not match the archive',
                  )
                let observed = yield* transport.headChunk({
                  organizationId: input.organizationId,
                  serverId: input.serverId,
                  backupId: input.backupId,
                  operationId: input.operationId,
                  index,
                })
                if (observed === null) {
                  observed = yield* Effect.catch(
                    transport.putChunk({
                      organizationId: input.organizationId,
                      serverId: input.serverId,
                      backupId: input.backupId,
                      operationId: input.operationId,
                      index,
                      bytes,
                      sha256,
                      ...(input.signal === undefined ? {} : { signal: input.signal }),
                    }),
                    () =>
                      transport
                        .headChunk({
                          organizationId: input.organizationId,
                          serverId: input.serverId,
                          backupId: input.backupId,
                          operationId: input.operationId,
                          index,
                        })
                        .pipe(
                          Effect.flatMap((recovered) =>
                            validateRemote(expected, recovered).pipe(Effect.as(recovered)),
                          ),
                        ),
                  )
                }
                yield* validateRemote(expected, observed)
                state = {
                  ...state,
                  nextChunk: index + 1,
                  chunks: [
                    ...state.chunks.slice(0, index),
                    expected,
                    ...state.chunks.slice(index + 1),
                  ],
                  complete: false,
                }
                yield* writeState(statePath, state)
              }
              yield* checkCancelled(input.signal)
              const manifest = yield* transport.putManifest({
                organizationId: input.organizationId,
                serverId: input.serverId,
                backupId: input.backupId,
                operationId: input.operationId,
                bytes: input.expectedBytes,
                sha256: input.expectedSha256,
                manifest: input.manifest,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              })
              state = {
                ...state,
                nextChunk: totalChunks,
                complete: true,
                manifestSha256: manifest.sha256,
              }
              yield* writeState(statePath, state)
              return {
                organizationId: input.organizationId,
                serverId: input.serverId,
                backupId: input.backupId,
                bytes: input.expectedBytes,
                sha256: input.expectedSha256,
                chunks: totalChunks,
                manifestSha256: manifest.sha256,
              }
            } finally {
              yield* Effect.tryPromise({ try: () => handle.close(), catch: () => undefined }).pipe(
                Effect.orDie,
              )
            }
          }),
      })
    }),
  )

export const BACKUP_UPLOAD_LIMITS = {
  minimumChunkBytes,
  maximumChunkBytes,
  maximumChunks,
  maximumBackupBytes,
} as const

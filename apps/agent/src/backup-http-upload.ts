import { constants as fsConstants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { BackupArchiveUploader } from './services.js'
import { AgentError } from './errors.js'

const UploadReceipt = Schema.Struct({
  kind: Schema.Literal('backup-uploaded'),
  backupId: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  checksum: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  encryptionVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  r2Key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  manifestVerified: Schema.Literal(true),
})

const failure = (message: string) => new AgentError({ code: 'execution-failed', message })

export const FetchBackupArchiveUploader = (options: {
  readonly controlPlaneOrigin: URL
  readonly nodeCredential: string
  readonly maximumBytes?: number
}) =>
  Layer.succeed(BackupArchiveUploader, {
    upload: (input) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => open(input.archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
          catch: () => failure('backup archive could not be opened for upload'),
        }),
        (handle) =>
          Effect.gen(function* () {
            const metadata = yield* Effect.tryPromise({
              try: () => handle.stat(),
              catch: () => failure('backup archive metadata is unavailable'),
            })
            const maximumBytes = options.maximumBytes ?? 256 * 1024 ** 3
            if (
              !metadata.isFile() ||
              metadata.size !== input.bytes ||
              input.bytes < 1 ||
              input.bytes > maximumBytes
            )
              return yield* failure('backup archive size changed before upload')
            const target = new URL(
              `/v1/agent/nodes/${encodeURIComponent(input.nodeId)}/backups/${encodeURIComponent(input.backupId)}/archive`,
              options.controlPlaneOrigin,
            )
            const request = new Request(target, {
              method: 'PUT',
              headers: {
                authorization: `Bearer ${options.nodeCredential}`,
                'content-type': 'application/octet-stream',
                'content-length': String(input.bytes),
                'x-gridora-organization-id': input.organizationId,
                'x-gridora-operation-id': input.operationId,
                'x-gridora-server-id': input.serverId,
                'x-gridora-backup-sha256': input.sha256,
                'x-gridora-backup-created-at': input.createdAt,
                'x-gridora-backup-includes': input.includes.join(','),
              },
              body: handle.readableWebStream() as ReadableStream<Uint8Array>,
              // Node's Fetch implementation requires this for a streaming request body.
              duplex: 'half',
            } as RequestInit & { readonly duplex: 'half' })
            const response = yield* Effect.tryPromise({
              try: (signal) => fetch(request, { signal }),
              catch: () => failure('backup archive upload transport failed'),
            })
            if (!response.ok) {
              yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
              return yield* failure(`backup archive upload was rejected (${response.status})`)
            }
            const value = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: () => failure('backup upload receipt is invalid'),
            })
            return yield* Schema.decodeUnknownEffect(UploadReceipt, {
              onExcessProperty: 'error',
            })(value).pipe(Effect.mapError(() => failure('backup upload receipt is invalid')))
          }),
        (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
      ),
    download: (input) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(input.archivePath), { recursive: true, mode: 0o700 })
            const temporary = `${input.archivePath}.${input.operationId}.partial`
            return { temporary, handle: await open(temporary, 'wx', 0o600) }
          },
          catch: () => failure('restore archive staging could not be created'),
        }),
        ({ temporary, handle }) =>
          Effect.gen(function* () {
            const target = new URL(
              `/v1/agent/nodes/${encodeURIComponent(input.nodeId)}/backups/${encodeURIComponent(input.backupId)}/archive?serverId=${encodeURIComponent(input.sourceServerId)}&maximumBytes=${encodeURIComponent(String(input.maximumBytes))}`,
              options.controlPlaneOrigin,
            )
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(target, {
                  redirect: 'error',
                  signal,
                  headers: {
                    authorization: `Bearer ${options.nodeCredential}`,
                    'x-gridora-organization-id': input.organizationId,
                    'x-gridora-operation-id': input.operationId,
                    'x-gridora-target-server-id': input.targetServerId,
                  },
                }),
              catch: () => failure('restore archive download transport failed'),
            })
            if (!response.ok || response.body === null)
              return yield* failure(`restore archive download was rejected (${response.status})`)
            const declared = response.headers.get('content-length')
            if (
              declared === null ||
              !/^\d+$/.test(declared) ||
              Number(declared) > input.maximumBytes
            )
              return yield* failure('restore archive download size is invalid')
            const writer = handle.createWriteStream({ autoClose: false })
            yield* Effect.tryPromise({
              try: () =>
                response.body!.pipeTo(
                  new WritableStream({
                    write(chunk) {
                      return new Promise<void>((resolve, reject) =>
                        writer.write(chunk, (error) =>
                          error === null || error === undefined ? resolve() : reject(error),
                        ),
                      )
                    },
                    close() {
                      return new Promise<void>((resolve, reject) =>
                        writer.end((error?: Error | null) => (error ? reject(error) : resolve())),
                      )
                    },
                    abort() {
                      writer.destroy()
                    },
                  }),
                ),
              catch: () => failure('restore archive download failed'),
            })
            yield* Effect.tryPromise({
              try: async () => {
                await handle.sync()
                await rename(temporary, input.archivePath)
              },
              catch: () => failure('restore archive could not be published locally'),
            })
          }),
        ({ temporary, handle }) =>
          Effect.promise(async () => {
            await handle.close().catch(() => undefined)
            await rm(temporary, { force: true }).catch(() => undefined)
          }),
      ),
  })

import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import type { AgentCredentialPrincipal } from '@gridora/db-contracts'
import {
  BackupR2Error,
  BackupR2Transport,
  type BackupR2TransportShape,
  type BackupUploadObjectPublisher,
} from '@gridora/backup-r2'
import type {
  BackupUploadAcceptanceReceipt,
  BackupUploadSessionAuthority,
  BackupUploadSessionClaim,
} from '@gridora/backup-d1'
import { AuthorizationError, PersistenceError } from '@gridora/contracts'
import { OrganizationId } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const Includes = Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state'])).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
)
const UploadHeaders = Schema.Struct({
  organizationId: Identifier,
  operationId: Identifier,
  serverId: Identifier,
  backupId: Identifier,
  createdAt: Timestamp,
  includes: Includes,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
})

export interface BackupAgentUploadDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly authenticate: (
    context: HonoContext<E>,
  ) => Effect.Effect<AgentCredentialPrincipal, unknown, R>
  readonly transport: (bindings: E['Bindings']) => Effect.Effect<BackupR2TransportShape, never, R>
  readonly claimUpload: (
    bindings: E['Bindings'],
    input: {
      readonly organizationId: string
      readonly operationId: string
      readonly backupId: string
      readonly serverId: string
      readonly nodeId: string
      readonly archiveCreatedAt: string
      readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
      readonly declaredBytes: number
      readonly declaredSha256: string
      readonly maximumChunkBytes: number
    },
  ) => Effect.Effect<BackupUploadSessionClaim, unknown, R>
  readonly validateUpload: (
    bindings: E['Bindings'],
    input: BackupUploadSessionAuthority,
  ) => Effect.Effect<void, unknown, R>
  readonly publishUploadObject: (
    bindings: E['Bindings'],
    authority: BackupUploadSessionAuthority,
  ) => BackupUploadObjectPublisher<R>
  readonly acceptUpload: (
    bindings: E['Bindings'],
    input: BackupUploadSessionAuthority & {
      readonly bytes: number
      readonly sha256: string
      readonly encryptionVersion: number
      readonly archiveCreatedAt: string
      readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
    },
  ) => Effect.Effect<BackupUploadAcceptanceReceipt, unknown, R>
  readonly closeUpload: (
    bindings: E['Bindings'],
    input: BackupUploadSessionAuthority,
  ) => Effect.Effect<void, unknown, R>
  readonly authorizeRestore: (
    bindings: E['Bindings'],
    input: {
      readonly organizationId: string
      readonly operationId: string
      readonly backupId: string
      readonly sourceServerId: string
      readonly targetServerId: string
      readonly targetNodeId: string
    },
  ) => Effect.Effect<void, unknown, R>
}

const boundedChunkStream = (source: ReadableStream<Uint8Array>, maximum = 1024 * 1024) => {
  const reader = source.getReader()
  let pending: Uint8Array | undefined
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (pending === undefined || offset >= pending.byteLength) {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          return
        }
        if (next.value.byteLength === 0) continue
        pending = next.value
        offset = 0
      }
      const end = Math.min(offset + maximum, pending.byteLength)
      controller.enqueue(pending.subarray(offset, end))
      offset = end
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export const registerBackupAgentUploadRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: BackupAgentUploadDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.put(
    '/v1/agent/nodes/:nodeId/backups/:backupId/archive',
    handler((context) =>
      Effect.gen(function* () {
        const principal = yield* dependencies.authenticate(context)
        const contentLength = context.req.header('content-length')
        const raw = {
          organizationId: context.req.header('x-gridora-organization-id'),
          operationId: context.req.header('x-gridora-operation-id'),
          serverId: context.req.header('x-gridora-server-id'),
          backupId: context.req.param('backupId'),
          createdAt: context.req.header('x-gridora-backup-created-at'),
          includes: context.req.header('x-gridora-backup-includes')?.split(','),
          bytes:
            contentLength !== undefined && /^\d+$/.test(contentLength)
              ? Number(contentLength)
              : Number.NaN,
          sha256: context.req.header('x-gridora-backup-sha256'),
        }
        const decoded = yield* Schema.decodeUnknownEffect(UploadHeaders, {
          onExcessProperty: 'error',
        })(raw).pipe(
          Effect.mapError(
            () =>
              new PersistenceError({
                operation: 'backup.agent-upload.contract',
                message: 'The backup upload contract is invalid',
              }),
          ),
        )
        if (
          principal.organizationId !== decoded.organizationId ||
          principal.nodeId !== context.req.param('nodeId') ||
          decoded.backupId !== context.req.param('backupId')
        )
          return yield* new AuthorizationError({
            code: 'membership_required',
            message: 'The node credential is not valid for this backup upload',
          })
        if (context.req.raw.body === null)
          return yield* new PersistenceError({
            operation: 'backup.agent-upload.body',
            message: 'The backup archive body is missing',
          })
        const claim = yield* dependencies.claimUpload(context.env, {
          organizationId: decoded.organizationId,
          operationId: decoded.operationId,
          backupId: decoded.backupId,
          serverId: decoded.serverId,
          nodeId: principal.nodeId,
          archiveCreatedAt: decoded.createdAt,
          includes: decoded.includes,
          declaredBytes: decoded.bytes,
          declaredSha256: decoded.sha256,
          maximumChunkBytes: 1024 * 1024,
        })
        if (claim.disposition === 'adopted') {
          yield* Effect.promise(() => context.req.raw.body?.cancel() ?? Promise.resolve()).pipe(
            Effect.ignore,
          )
          return jsonResponse({
            kind: 'backup-uploaded',
            backupId: claim.receipt.backupId,
            bytes: claim.receipt.bytes,
            sha256: claim.receipt.sha256,
            checksum: claim.receipt.sha256,
            encryptionVersion: claim.receipt.encryptionVersion,
            r2Key: claim.receipt.r2Key,
            manifestVerified: true,
          })
        }
        const authority = claim.authority
        const transport = yield* dependencies.transport(context.env)
        const uploaded = yield* Effect.result(
          transport.upload(
            { organizationId: principal.organizationId },
            {
              backupId: decoded.backupId,
              serverId: decoded.serverId,
              operationId: decoded.operationId,
              jobId: authority.jobId,
              uploadSessionId: authority.sessionId,
              uploadLeaseId: authority.leaseId,
              uploadGeneration: authority.generation,
              createdAt: decoded.createdAt,
              includes: decoded.includes,
              containsGameBinaries: false,
              compressedBytes: decoded.bytes,
              compressedSha256: decoded.sha256,
              maximumCompressedBytes: 256 * 1024 ** 3,
              maximumChunkBytes: 1024 * 1024,
              publicationGuard: () =>
                dependencies.validateUpload(context.env, authority).pipe(
                  Effect.mapError(
                    () =>
                      new BackupR2Error({
                        code: 'publication-denied',
                        operation: 'backup.upload.publication-authority',
                        message: 'the durable upload generation no longer authorizes publication',
                      }),
                  ),
                ),
              publishObject: dependencies.publishUploadObject(context.env, authority),
              stream: boundedChunkStream(context.req.raw.body),
            },
          ),
        )
        if (uploaded._tag === 'Failure') {
          if (uploaded.failure.code !== 'upload-uncertain')
            yield* dependencies.closeUpload(context.env, authority).pipe(
              Effect.mapError(
                () =>
                  new PersistenceError({
                    operation: 'backup.agent-upload.close',
                    message: 'The failed upload writer could not be closed durably',
                  }),
              ),
            )
          return yield* new PersistenceError({
            operation: 'backup.agent-upload.r2',
            message: 'The encrypted backup upload did not complete',
          })
        }
        const manifest = uploaded.success
        const accepted = yield* Effect.result(
          dependencies.acceptUpload(context.env, {
            ...authority,
            bytes: manifest.plaintext.bytes,
            sha256: manifest.plaintext.sha256,
            encryptionVersion: manifest.encryption.keyVersion,
            archiveCreatedAt: manifest.createdAt,
            includes: manifest.content.includes,
          }),
        )
        if (accepted._tag === 'Failure') {
          yield* dependencies.closeUpload(context.env, authority).pipe(
            Effect.mapError(
              () =>
                new PersistenceError({
                  operation: 'backup.agent-upload.close',
                  message: 'The unaccepted upload writer could not be closed durably',
                }),
            ),
          )
          return yield* new PersistenceError({
            operation: 'backup.agent-upload.accept',
            message: 'The encrypted upload could not be accepted durably',
          })
        }
        const receipt = accepted.success
        return jsonResponse({
          kind: 'backup-uploaded',
          backupId: decoded.backupId,
          bytes: receipt.bytes,
          sha256: receipt.sha256,
          checksum: receipt.sha256,
          encryptionVersion: receipt.encryptionVersion,
          r2Key: receipt.r2Key,
          manifestVerified: true,
        })
      }),
    ),
  )

  app.get(
    '/v1/agent/nodes/:nodeId/backups/:backupId/archive',
    handler((context) =>
      Effect.gen(function* () {
        const principal = yield* dependencies.authenticate(context)
        const decodeIdentifier = (value: unknown) =>
          Schema.decodeUnknownEffect(Identifier)(value).pipe(
            Effect.mapError(
              () =>
                new PersistenceError({
                  operation: 'backup.agent-restore.contract',
                  message: 'The restore download contract is invalid',
                }),
            ),
          )
        const organizationId = yield* Schema.decodeUnknownEffect(OrganizationId)(
          context.req.header('x-gridora-organization-id') ?? '',
        ).pipe(
          Effect.mapError(
            () =>
              new PersistenceError({
                operation: 'backup.agent-restore.contract',
                message: 'The restore organization is invalid',
              }),
          ),
        )
        const operationId = yield* decodeIdentifier(
          context.req.header('x-gridora-operation-id') ?? '',
        )
        const targetServerId = yield* decodeIdentifier(
          context.req.header('x-gridora-target-server-id') ?? '',
        )
        const sourceServerId = yield* decodeIdentifier(context.req.query('serverId') ?? '')
        const backupId = yield* decodeIdentifier(context.req.param('backupId') ?? '')
        const maximumBytes = Number(context.req.query('maximumBytes') ?? '')
        if (
          principal.organizationId !== organizationId ||
          principal.nodeId !== context.req.param('nodeId') ||
          !Number.isSafeInteger(maximumBytes) ||
          maximumBytes < 1 ||
          maximumBytes > 256 * 1024 ** 3
        )
          return yield* new AuthorizationError({
            code: 'membership_required',
            message: 'The node credential is not valid for this restore download',
          })
        yield* dependencies.authorizeRestore(context.env, {
          organizationId,
          operationId,
          backupId,
          sourceServerId,
          targetServerId,
          targetNodeId: principal.nodeId,
        })
        const transport = yield* dependencies.transport(context.env)
        const restored = yield* transport
          .restore(
            { organizationId },
            { backupId, serverId: sourceServerId, maximumRestoreBytes: maximumBytes },
          )
          .pipe(
            Effect.mapError(
              () =>
                new PersistenceError({
                  operation: 'backup.agent-restore.r2',
                  message: 'The encrypted restore archive is unavailable',
                }),
            ),
          )
        return new Response(restored.stream, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(restored.manifest.plaintext.bytes),
            'x-gridora-backup-sha256': restored.manifest.plaintext.sha256,
          },
        })
      }),
    ),
  )
  return app
}

export { BackupR2Transport }

import { Effect, Layer, Schema } from 'effect'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  BackupUploadAcceptanceReceipt,
  BackupUploadSessionAuthority,
} from '@gridora/backup-d1'
import { BackupR2Error, type BackupR2TransportShape } from '@gridora/backup-r2'
import type { AgentCredentialPrincipal } from '@gridora/db-contracts'
import { OrganizationId } from '@gridora/domain'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { registerBackupAgentUploadRoutes } from '../src/backup-agent-upload-routes.js'

type TestEnv = { Bindings: Record<string, never> }
const runtime = makeWorkerEffectRuntime(Layer.empty)
const organizationId = Schema.decodeUnknownSync(OrganizationId)('org-a')
const sha256 = `sha256:${'a'.repeat(64)}`
const prefix = 'organizations/org-a/servers/server-a/backups/backup-a'
const authority: BackupUploadSessionAuthority = {
  organizationId,
  sessionId: 'upload-session-a',
  leaseId: 'upload-lease-a-1234567890',
  generation: 1,
  jobId: 'job-a',
  operationId: 'operation-a',
  backupId: 'backup-a',
  serverId: 'server-a',
  nodeId: 'node-a',
  r2Key: prefix,
  leaseExpiresAt: '2026-08-23T10:10:00.000Z',
  uploadWatchUntil: '2026-08-23T10:20:00.000Z',
}
const receipt: BackupUploadAcceptanceReceipt = {
  receiptId: 'upload-receipt-a',
  sessionId: authority.sessionId,
  leaseId: authority.leaseId,
  generation: authority.generation,
  jobId: authority.jobId,
  operationId: authority.operationId,
  backupId: authority.backupId,
  organizationId,
  r2Key: prefix,
  manifestKey: `${prefix}/manifest.json`,
  bytes: 4,
  sha256,
  encryptionVersion: 1,
  archiveCreatedAt: '2026-08-23T10:00:00.000Z',
  includes: ['config'],
  acceptedAt: '2026-08-23T10:00:02.000Z',
}
const principal: AgentCredentialPrincipal = {
  organizationId,
  nodeId: 'node-a',
  credentialId: 'credential-a',
  version: 1,
  sessionVersion: 1,
}

const manifest = {
  apiVersion: 'backup.r2.gridora.dev/v1alpha1' as const,
  organizationId,
  backupId: 'backup-a',
  serverId: 'server-a',
  operationId: 'operation-a',
  jobId: 'job-a',
  uploadSessionId: 'upload-session-a',
  uploadGeneration: 1,
  createdAt: '2026-08-23T10:00:00.000Z',
  content: {
    policy: 'server-state-only' as const,
    includes: ['config'] as const,
    excludes: ['game'] as const,
    containsGameBinaries: false as const,
  },
  encryption: {
    algorithm: 'AES-256-GCM-CHUNKED' as const,
    keyVersion: 1,
    wrappedDataKey: 'wrapped',
  },
  plaintext: { encoding: 'tar+zstd' as const, bytes: 4, sha256 },
  ciphertext: { bytes: 20, sha256 },
  maximumChunkBytes: 1024 * 1024,
  chunks: [
    {
      index: 0,
      key: `${prefix}/chunks/00000000.bin`,
      plaintextBytes: 4,
      ciphertextBytes: 20,
      plaintextSha256: sha256,
      ciphertextSha256: sha256,
    },
  ],
  manifestAuthenticationTag: 'tag',
}

const request = () =>
  new Request('https://api.gridora.test/v1/agent/nodes/node-a/backups/backup-a/archive', {
    method: 'PUT',
    headers: {
      'content-length': '4',
      'x-gridora-organization-id': organizationId,
      'x-gridora-operation-id': 'operation-a',
      'x-gridora-server-id': 'server-a',
      'x-gridora-backup-created-at': '2026-08-23T10:00:00.000Z',
      'x-gridora-backup-includes': 'config',
      'x-gridora-backup-sha256': sha256,
    },
    body: new Uint8Array([1, 2, 3, 4]),
  })

describe('backup agent upload generation boundary', () => {
  let app: Hono<TestEnv>
  let validationCalls: number
  let acceptanceCalls: number
  let closureCalls: number

  beforeEach(() => {
    validationCalls = 0
    acceptanceCalls = 0
    closureCalls = 0
    app = new Hono<TestEnv>()
  })

  afterAll(() => runtime.dispose())

  const register = (transport: BackupR2TransportShape) =>
    registerBackupAgentUploadRoutes(app, {
      runtimeFor: () => runtime,
      authenticate: () => Effect.succeed(principal),
      transport: () => Effect.succeed(transport),
      claimUpload: () => Effect.succeed({ disposition: 'execute', authority }),
      validateUpload: () =>
        Effect.sync(() => {
          validationCalls += 1
        }),
      publishUploadObject: () => () => Effect.die('transport owns publication in this test'),
      acceptUpload: () =>
        Effect.sync(() => {
          acceptanceCalls += 1
          return receipt
        }),
      closeUpload: () =>
        Effect.sync(() => {
          closureCalls += 1
        }),
      authorizeRestore: () => Effect.void,
    })

  it('accepts only after the transport crosses guarded publication boundaries', async () => {
    register({
      upload: (_context, input) =>
        Effect.gen(function* () {
          yield* input.publicationGuard({
            phase: 'before',
            kind: 'chunk',
            key: manifest.chunks[0]!.key,
            index: 0,
          })
          yield* input.publicationGuard({
            phase: 'after',
            kind: 'manifest',
            key: `${prefix}/manifest.json`,
            index: null,
          })
          return manifest
        }),
      restore: () => Effect.die('restore is outside this test'),
    })
    const response = await app.request(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      kind: 'backup-uploaded',
      backupId: 'backup-a',
      checksum: sha256,
      r2Key: prefix,
      manifestVerified: true,
    })
    expect(validationCalls).toBe(2)
    expect(acceptanceCalls).toBe(1)
    expect(closureCalls).toBe(0)
  })

  it('durably closes a writer when its post-write authority check fails', async () => {
    register({
      upload: () =>
        Effect.fail(
          new BackupR2Error({
            code: 'publication-denied',
            operation: 'test.upload.after-put',
            message: 'cancellation won after the R2 PUT returned',
          }),
        ),
      restore: () => Effect.die('restore is outside this test'),
    })
    const response = await app.request(request())
    expect(response.status).toBe(503)
    expect(acceptanceCalls).toBe(0)
    expect(closureCalls).toBe(1)
  })

  it('adopts the immutable upload receipt without consuming a replacement body', async () => {
    let transportCalls = 0
    let cancelled = false
    registerBackupAgentUploadRoutes(app, {
      runtimeFor: () => runtime,
      authenticate: () => Effect.succeed(principal),
      transport: () =>
        Effect.sync(() => {
          transportCalls += 1
          return {
            upload: () => Effect.die('adoption must not upload again'),
            restore: () => Effect.die('restore is outside this test'),
          }
        }),
      claimUpload: () => Effect.succeed({ disposition: 'adopted', receipt }),
      validateUpload: () => Effect.void,
      publishUploadObject: () => () => Effect.die('adoption must not publish'),
      acceptUpload: () => Effect.die('adoption must not accept again'),
      closeUpload: () => Effect.die('adoption must not close'),
      authorizeRestore: () => Effect.void,
    })
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('replacement body must not be read')
      },
      cancel() {
        cancelled = true
      },
    })
    const replacement = request()
    const response = await app.request(
      new Request(replacement, { body: stream, duplex: 'half' } as RequestInit),
    )
    expect(response.status).toBe(200)
    expect(cancelled).toBe(true)
    expect(transportCalls).toBe(0)
  })
})

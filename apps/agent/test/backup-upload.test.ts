import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BackupChunkUploadTransportLayer,
  BackupChunkUploader,
  BackupUploadError,
  NodeBackupChunkUploader,
  type BackupChunkUploadTransportShape,
} from '../src/backup-upload.js'

const bytes = (size: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_, index) => index % 251)
const digest = (value: Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

class MemoryTransport implements BackupChunkUploadTransportShape {
  readonly chunks = new Map<
    number,
    { readonly index: number; readonly bytes: number; readonly sha256: string }
  >()
  putCount = 0
  failAfterFirstWrite = false
  headChunk = ({ index }: { readonly index: number }) =>
    Effect.succeed(this.chunks.get(index) ?? null)
  putChunk = ({
    index,
    bytes: value,
    sha256,
  }: {
    readonly index: number
    readonly bytes: Uint8Array
    readonly sha256: string
  }) => {
    this.putCount += 1
    const record = { index, bytes: value.byteLength, sha256 }
    this.chunks.set(index, record)
    if (this.failAfterFirstWrite && this.putCount === 1)
      return Effect.fail(
        new BackupUploadError({ code: 'transport-failed', message: 'response lost' }),
      )
    return Effect.succeed(record)
  }
  putManifest = ({ sha256 }: { readonly sha256: string }) => Effect.succeed({ sha256 })
}

describe('agent resumable backup upload', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('uses bounded exact chunks, adopts a lost response, and resumes without plaintext secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-upload-'))
    roots.push(root)
    const archive = join(root, 'archive.tar.zst')
    const content = bytes(150_000)
    await writeFile(archive, content)
    const transport = new MemoryTransport()
    transport.failAfterFirstWrite = true
    const layer = NodeBackupChunkUploader({ trustedRoot: root }).pipe(
      Layer.provide(BackupChunkUploadTransportLayer(transport)),
    )
    const uploader = Effect.runSync(Effect.service(BackupChunkUploader).pipe(Effect.provide(layer)))
    const input = {
      organizationId: 'org-a',
      serverId: 'server-a',
      backupId: 'backup-a',
      operationId: 'op-a',
      archivePath: archive,
      expectedBytes: content.byteLength,
      expectedSha256: digest(content),
      chunkBytes: 64 * 1024,
      manifest: { apiVersion: 'backup.r2.gridora.dev/v1alpha1', containsGameBinaries: false },
    }
    const first = await Effect.runPromise(uploader.upload(input))
    expect(first.chunks).toBe(3)
    expect(transport.putCount).toBe(3)
    const state = await readFile(
      join(root, '.gridora-upload-state', 'backup-a.upload.json'),
      'utf8',
    )
    expect(state).not.toMatch(/plaintext|secret|privateKey|wrappedDataKey/i)
    const second = await Effect.runPromise(uploader.upload(input))
    expect(second).toEqual(first)
    expect(transport.putCount).toBe(3)
  })

  it('fails closed when a remote chunk checksum conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-upload-corrupt-'))
    roots.push(root)
    const archive = join(root, 'archive.tar.zst')
    const content = bytes(70_000)
    await writeFile(archive, content)
    const transport = new MemoryTransport()
    transport.chunks.set(0, { index: 0, bytes: 64 * 1024, sha256: `sha256:${'0'.repeat(64)}` })
    const layer = NodeBackupChunkUploader({ trustedRoot: root }).pipe(
      Layer.provide(BackupChunkUploadTransportLayer(transport)),
    )
    const uploader = Effect.runSync(Effect.service(BackupChunkUploader).pipe(Effect.provide(layer)))
    const result = await Effect.runPromise(
      Effect.result(
        uploader.upload({
          organizationId: 'org-a',
          serverId: 'server-a',
          backupId: 'backup-b',
          operationId: 'op-b',
          archivePath: archive,
          expectedBytes: content.byteLength,
          expectedSha256: digest(content),
          chunkBytes: 64 * 1024,
          manifest: {},
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure).toBeInstanceOf(BackupUploadError)
  })

  it('honors cancellation before opening the archive and rejects paths outside the trusted root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-upload-cancel-'))
    roots.push(root)
    const archive = join(root, 'archive.tar.zst')
    const content = bytes(70_000)
    await writeFile(archive, content)
    const transport = new MemoryTransport()
    const layer = NodeBackupChunkUploader({ trustedRoot: root }).pipe(
      Layer.provide(BackupChunkUploadTransportLayer(transport)),
    )
    const uploader = Effect.runSync(Effect.service(BackupChunkUploader).pipe(Effect.provide(layer)))
    const controller = new AbortController()
    controller.abort()
    const cancelled = await Effect.runPromise(
      Effect.result(
        uploader.upload({
          organizationId: 'org-a',
          serverId: 'server-a',
          backupId: 'backup-c',
          operationId: 'op-c',
          archivePath: archive,
          expectedBytes: content.byteLength,
          expectedSha256: digest(content),
          manifest: {},
          signal: controller.signal,
        }),
      ),
    )
    expect(cancelled._tag).toBe('Failure')
    const outside = await Effect.runPromise(
      Effect.result(
        uploader.upload({
          organizationId: 'org-a',
          serverId: 'server-a',
          backupId: 'backup-d',
          operationId: 'op-d',
          archivePath: join(root, '..', 'outside'),
          expectedBytes: content.byteLength,
          expectedSha256: digest(content),
          manifest: {},
        }),
      ),
    )
    expect(outside._tag).toBe('Failure')
  })
})

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeLogBatch, type LiveLogArchiveAvailableEvent } from '@gridora/log-control'
import { archiveLogBatch, type LogR2BucketShape, type LogR2ObjectInfo } from '@gridora/log-r2'
import type { LogD1Database, LogD1Statement } from '@gridora/log-d1'
import type { LiveLogPublication } from '@gridora/realtime'
import {
  processLiveLogArchiveAvailable,
  type LiveLogPublicationBindings,
} from '../src/live-log-publication.js'

class MetadataStatement implements LogD1Statement {
  constructor(private readonly row: unknown) {}

  bind(..._values: ReadonlyArray<unknown>): LogD1Statement {
    return this
  }

  first(): Promise<unknown> {
    return Promise.resolve(this.row)
  }

  all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return Promise.resolve({ results: [] })
  }

  run(): Promise<{ readonly success: boolean }> {
    return Promise.resolve({ success: true })
  }
}

class MetadataDatabase implements LogD1Database {
  constructor(private readonly row: unknown) {}

  prepare(_sql: string): LogD1Statement {
    return new MetadataStatement(this.row)
  }
}

class ArchiveBucket implements LogR2BucketShape {
  readonly objects = new Map<
    string,
    { readonly body: Uint8Array; readonly info: LogR2ObjectInfo }
  >()

  async head(key: string): Promise<LogR2ObjectInfo | null> {
    return this.objects.get(key)?.info ?? null
  }

  async get(key: string) {
    const object = this.objects.get(key)
    return object === undefined
      ? null
      : {
          ...object.info,
          body: new Response(new Uint8Array(object.body).buffer).body!,
        }
  }

  async put(
    key: string,
    body: Uint8Array,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>
      readonly onlyIfAbsent: boolean
    },
  ): Promise<LogR2ObjectInfo> {
    if (options.onlyIfAbsent && this.objects.has(key)) throw new Error('conditional write lost')
    const copy = new Uint8Array(body)
    const info: LogR2ObjectInfo = {
      key,
      size: copy.byteLength,
      etag: `etag-${this.objects.size + 1}`,
      customMetadata: options.customMetadata,
    }
    this.objects.set(key, { body: copy, info })
    return info
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

const entry = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  serverId: 'server-a',
  component: 'game' as const,
  level: 'info' as const,
  timestamp: '2026-08-23T12:00:00.000Z',
  sequence: 1,
  message: 'started',
}

const storedArchive = async () => {
  const bucket = new ArchiveBucket()
  const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry]))
  const archive = await Effect.runPromise(
    archiveLogBatch(bucket, batch, {
      archiveId: 'archive_a',
      createdAt: '2026-08-23T12:00:00.000Z',
      expiresAt: null,
      streamEpoch: 'deployment-a',
    }),
  )
  return { bucket, archive }
}

const catalogRow = (
  metadata: Awaited<ReturnType<typeof storedArchive>>['archive']['metadata'],
) => ({
  organizationId: metadata.organizationId,
  id: metadata.id,
  serverId: metadata.serverId,
  nodeId: metadata.nodeId,
  streamEpoch: metadata.streamEpoch,
  r2Key: metadata.r2Key,
  compression: metadata.compression,
  firstTimestamp: metadata.firstTimestamp,
  lastTimestamp: metadata.lastTimestamp,
  entryCount: metadata.entryCount,
  uncompressedBytes: metadata.uncompressedBytes,
  compressedBytes: metadata.compressedBytes,
  sha256: metadata.sha256,
  state: metadata.state,
  createdAt: metadata.createdAt,
  expiresAt: metadata.expiresAt,
})

const eventFor = (
  metadata: Awaited<ReturnType<typeof storedArchive>>['archive']['metadata'],
): LiveLogArchiveAvailableEvent => ({
  version: 2,
  type: 'log.archive.available',
  organizationId: metadata.organizationId,
  nodeId: metadata.nodeId,
  serverId: metadata.serverId,
  streamEpoch: metadata.streamEpoch ?? 'deployment-a',
  archiveId: metadata.id,
  r2Key: metadata.r2Key,
  sha256: metadata.sha256,
  firstSequence: 1,
  lastSequence: 1,
})

const r2 = (bucket: ArchiveBucket): LiveLogPublicationBindings['LOGS'] => ({
  head: (key) => bucket.head(key),
  get: (key) => bucket.get(key),
  put: async () => {
    throw new Error('live log consumer never writes R2')
  },
  delete: (key) => bucket.delete(key),
})

describe('live-log archive queue consumer', () => {
  it('retries a response-lost DO publish and lets archive-id dedupe produce one live delivery', async () => {
    const { bucket, archive } = await storedArchive()
    const published: LiveLogPublication[] = []
    const broadcast: LiveLogPublication[] = []
    const seen = new Map<string, string>()
    let responseLost = true
    const bindings: LiveLogPublicationBindings = {
      DB: new MetadataDatabase(catalogRow(archive.metadata)),
      LOGS: r2(bucket),
      LIVE_LOG_STREAM: {
        getByName: (name) => ({
          publish: async (input) => {
            expect(name).toBe('org-a:logs:server-a:deployment-a')
            published.push(input)
            const prior = seen.get(input.archiveId)
            if (prior === input.archiveSha256)
              return {
                accepted: false,
                replayed: true,
                firstSequence: input.entries[0]!.sequence,
                lastSequence: input.entries.at(-1)!.sequence,
              }
            seen.set(input.archiveId, input.archiveSha256)
            broadcast.push(input)
            if (responseLost) {
              responseLost = false
              throw new Error('simulated response loss after Durable Object persistence')
            }
            return {
              accepted: true,
              replayed: false,
              firstSequence: input.entries[0]!.sequence,
              lastSequence: input.entries.at(-1)!.sequence,
            }
          },
        }),
      },
    }

    await expect(
      processLiveLogArchiveAvailable(bindings, eventFor(archive.metadata)),
    ).resolves.toMatchObject({
      disposition: 'retry',
      reason: 'live_stream_unavailable',
    })
    await expect(
      processLiveLogArchiveAvailable(bindings, eventFor(archive.metadata)),
    ).resolves.toMatchObject({
      disposition: 'ack',
      reason: 'published',
    })
    expect(published).toHaveLength(2)
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0]).toMatchObject({
      organizationId: 'org-a',
      serverId: 'server-a',
      streamEpoch: 'deployment-a',
      archiveId: archive.metadata.id,
      archiveSha256: archive.metadata.sha256,
      entries: [expect.objectContaining({ sequence: 1 })],
    })
  })

  it('acks forged archive identity before R2 or the Durable Object is reached', async () => {
    const { bucket, archive } = await storedArchive()
    let opened = 0
    const bindings: LiveLogPublicationBindings = {
      DB: new MetadataDatabase(catalogRow(archive.metadata)),
      LOGS: r2(bucket),
      LIVE_LOG_STREAM: {
        getByName: () => {
          opened += 1
          return {
            publish: async () => ({
              accepted: true,
              replayed: false,
              firstSequence: 1,
              lastSequence: 1,
            }),
          }
        },
      },
    }

    const forged = {
      ...eventFor(archive.metadata),
      sha256: `sha256:${'f'.repeat(64)}` as `sha256:${string}`,
    }
    await expect(processLiveLogArchiveAvailable(bindings, forged)).resolves.toMatchObject({
      disposition: 'ack',
      reason: 'archive_identity_mismatch',
    })
    expect(opened).toBe(0)
  })

  it('retries a temporary R2 read failure without inventing live delivery', async () => {
    const { archive } = await storedArchive()
    const bindings: LiveLogPublicationBindings = {
      DB: new MetadataDatabase(catalogRow(archive.metadata)),
      LOGS: {
        head: async () => null,
        get: async () => {
          throw new Error('R2 unavailable')
        },
        put: async () => null,
        delete: async () => undefined,
      },
      LIVE_LOG_STREAM: {
        getByName: () => ({
          publish: async () => ({
            accepted: true,
            replayed: false,
            firstSequence: 1,
            lastSequence: 1,
          }),
        }),
      },
    }

    await expect(
      processLiveLogArchiveAvailable(bindings, eventFor(archive.metadata)),
    ).resolves.toMatchObject({
      disposition: 'retry',
      reason: 'archive_read_failed',
    })
  })
})

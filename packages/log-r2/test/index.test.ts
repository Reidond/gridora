import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { LOG_LIMITS, makeLogBatch } from '@gridora/log-control'
import {
  archiveLogBatch,
  readLogArchive,
  type LogR2BucketShape,
  type LogR2ObjectInfo,
} from '../src/index.js'

const entry = (sequence: number) => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  serverId: 'server-a',
  component: 'game' as const,
  level: 'info' as const,
  timestamp: `2026-08-23T12:00:0${sequence}.000Z`,
  sequence,
  message: `line ${sequence}`,
})

const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const stream = new Blob([input.buffer]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`
}

class FakeBucket implements LogR2BucketShape {
  readonly objects = new Map<
    string,
    { readonly body: Uint8Array; readonly info: LogR2ObjectInfo }
  >()
  failAfterPut = false
  head = async (key: string) => this.objects.get(key)?.info ?? null
  get = async (key: string) => {
    const object = this.objects.get(key)
    return object === undefined
      ? null
      : {
          ...object.info,
          body: new Response(new Uint8Array(object.body).buffer).body!,
        }
  }
  put = async (
    key: string,
    body: Uint8Array,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>
      readonly onlyIfAbsent: boolean
    },
  ) => {
    const existing = this.objects.get(key)
    if (existing !== undefined && options.onlyIfAbsent) throw new Error('already exists')
    const info = {
      key,
      size: body.byteLength,
      etag: `etag-${body.byteLength}`,
      customMetadata: options.customMetadata,
    }
    this.objects.set(key, { body: new Uint8Array(body), info })
    if (this.failAfterPut) {
      this.failAfterPut = false
      throw new Error('response lost after commit')
    }
    return info
  }
  delete = async (key: string) => {
    this.objects.delete(key)
  }
}

describe('log R2 archive boundary', () => {
  it('compresses, publishes, and reads a tenant-bound archive', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)]))
    const bucket = new FakeBucket()
    const archived = await Effect.runPromise(
      archiveLogBatch(bucket, batch, {
        archiveId: 'archive-a',
        createdAt: '2026-08-23T12:01:00.000Z',
        expiresAt: '2026-09-23T12:01:00.000Z',
      }),
    )
    expect(archived.metadata.r2Key).toMatch(/^organizations\/org-a\/logs\/server-a\//)
    expect(archived.metadata.compression).toBe('gzip')
    const restored = await Effect.runPromise(
      readLogArchive(bucket, archived.metadata, 'org-a', 'server-a'),
    )
    expect(restored.entries.map((value) => value.sequence)).toEqual([1, 2])
    await expect(
      Effect.runPromise(readLogArchive(bucket, archived.metadata, 'org-b', 'server-a')),
    ).rejects.toMatchObject({ code: 'ownership-denied' })
    await expect(
      Effect.runPromise(
        readLogArchive(
          bucket,
          {
            ...archived.metadata,
            r2Key: archived.metadata.r2Key.replace('organizations/org-a/', 'organizations/org-b/'),
          },
          'org-a',
          'server-a',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ownership-denied' })
    await expect(
      Effect.runPromise(
        readLogArchive(bucket, { ...archived.metadata, state: 'expired' }, 'org-a', 'server-a'),
      ),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('adopts a committed R2 object after a lost put response and rejects different content at the same key', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)]))
    const bucket = new FakeBucket()
    bucket.failAfterPut = true
    const first = await Effect.runPromise(
      archiveLogBatch(bucket, batch, {
        archiveId: 'archive-a',
        createdAt: '2026-08-23T12:01:00.000Z',
        expiresAt: null,
      }),
    )
    expect(first.adopted).toBe(true)
    const replay = await Effect.runPromise(
      archiveLogBatch(bucket, batch, {
        archiveId: 'archive-a',
        createdAt: '2026-08-23T12:01:00.000Z',
        expiresAt: null,
      }),
    )
    expect(replay.adopted).toBe(true)
    const different = await Effect.runPromise(
      makeLogBatch('org-a', 'node-a', [entry(1), { ...entry(2), message: 'different' }]),
    )
    await expect(
      Effect.runPromise(
        archiveLogBatch(bucket, different, {
          archiveId: 'archive-a',
          createdAt: '2026-08-23T12:01:00.000Z',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('does not adopt an R2 key when any immutable metadata differs', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)]))
    const bucket = new FakeBucket()
    const archived = await Effect.runPromise(
      archiveLogBatch(bucket, batch, {
        archiveId: 'archive-a',
        createdAt: '2026-08-23T12:01:00.000Z',
        expiresAt: null,
      }),
    )
    const stored = bucket.objects.get(archived.metadata.r2Key)!
    bucket.objects.set(archived.metadata.r2Key, {
      ...stored,
      info: {
        ...stored.info,
        customMetadata: {
          ...stored.info.customMetadata,
          compressedSha256: `sha256:${'f'.repeat(64)}`,
        },
      },
    })
    await expect(
      Effect.runPromise(
        archiveLogBatch(bucket, batch, {
          archiveId: 'archive-a',
          createdAt: '2026-08-23T12:01:00.000Z',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('fences response-loss adoption by immutable archive generation', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)]))
    const bucket = new FakeBucket()
    const input = {
      archiveId: 'archive-a_g1',
      archiveGeneration: 1,
      createdAt: '2026-08-23T12:01:00.000Z',
      expiresAt: null,
      streamEpoch: 'deployment-a',
    }
    const archived = await Effect.runPromise(archiveLogBatch(bucket, batch, input))
    const stored = bucket.objects.get(archived.metadata.r2Key)!
    bucket.objects.set(archived.metadata.r2Key, {
      ...stored,
      info: {
        ...stored.info,
        customMetadata: {
          ...stored.info.customMetadata,
          archiveGeneration: '0',
        },
      },
    })

    await expect(Effect.runPromise(archiveLogBatch(bucket, batch, input))).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('does not adopt metadata-shaped R2 evidence whose compressed bytes differ', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)]))
    const bucket = new FakeBucket()
    const archived = await Effect.runPromise(
      archiveLogBatch(bucket, batch, {
        archiveId: 'archive-a',
        createdAt: '2026-08-23T12:01:00.000Z',
        expiresAt: null,
      }),
    )
    const stored = bucket.objects.get(archived.metadata.r2Key)!
    const corrupted = new Uint8Array(stored.body)
    corrupted[0] = corrupted[0]! ^ 1
    bucket.objects.set(archived.metadata.r2Key, {
      ...stored,
      body: corrupted,
      // The object metadata still claims to be the original archive. Adoption
      // must hash the actual bytes instead of trusting that claim.
      info: stored.info,
    })

    await expect(
      Effect.runPromise(
        archiveLogBatch(bucket, batch, {
          archiveId: 'archive-a',
          createdAt: '2026-08-23T12:01:00.000Z',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects an archive batch containing entries from another server', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)]))
    const foreign = {
      ...batch,
      entries: [...batch.entries.slice(0, 1), { ...batch.entries[1]!, serverId: 'server-b' }],
    }
    const bucket = new FakeBucket()
    await expect(
      Effect.runPromise(
        archiveLogBatch(bucket, foreign, {
          archiveId: 'archive-a',
          createdAt: '2026-08-23T12:01:00.000Z',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('stops a compressed archive while its expansion crosses the memory bound', async () => {
    const batch = await Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1)]))
    const bucket = new FakeBucket()
    const archived = await Effect.runPromise(
      archiveLogBatch(bucket, batch, {
        archiveId: 'archive-a',
        createdAt: '2026-08-23T12:01:00.000Z',
        expiresAt: null,
      }),
    )
    const bomb = await gzipBytes(new Uint8Array(LOG_LIMITS.maximumArchiveBytes + 1))
    expect(bomb.byteLength).toBeLessThan(LOG_LIMITS.maximumArchiveBytes)
    const existing = bucket.objects.get(archived.metadata.r2Key)!
    bucket.objects.set(archived.metadata.r2Key, {
      body: bomb,
      // Make the object look internally consistent so this exercises the
      // decompression budget rather than the earlier immutable-header fence.
      info: {
        ...existing.info,
        size: bomb.byteLength,
        customMetadata: {
          ...existing.info.customMetadata,
          compressedBytes: String(bomb.byteLength),
          compressedSha256: await sha256(bomb),
        },
      },
    })

    await expect(
      Effect.runPromise(
        readLogArchive(
          bucket,
          { ...archived.metadata, compressedBytes: bomb.byteLength },
          'org-a',
          'server-a',
        ),
      ),
    ).rejects.toMatchObject({
      code: 'size-limit',
      operation: 'logs.decompress',
    })
  })
})

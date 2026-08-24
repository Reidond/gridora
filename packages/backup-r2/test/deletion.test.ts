import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { deleteBackupObjectPrefix, type BackupR2DeletionBucketShape } from '../src/index.js'

const prefix = 'organizations/org-a/servers/server-a/backups/backup-a'

class MemoryDeletionBucket implements BackupR2DeletionBucketShape {
  readonly values = new Set<string>()
  readonly deleted: string[] = []
  corruptListing = false
  cycleCursor = false
  failManifestAfterDelete = false
  pageSize: number | undefined
  duplicateAcrossPages = false
  listCalls = 0
  list = async ({
    prefix: requested,
    cursor,
    limit,
  }: {
    readonly prefix: string
    readonly cursor?: string
    readonly limit?: number
  }) => {
    this.listCalls += 1
    const values = [...this.values].filter((key) => key.startsWith(requested)).sort()
    const offset = cursor === undefined || this.cycleCursor ? 0 : Number(cursor)
    const size = Math.min(this.pageSize ?? (values.length || 1), limit ?? 1000)
    const page = values.slice(offset, offset + size)
    if (this.duplicateAcrossPages && offset > 0 && values[offset - 1] !== undefined)
      page.unshift(values[offset - 1]!)
    const nextOffset = offset + size
    const truncated = this.cycleCursor || nextOffset < values.length
    return {
      objects: page.map((key) => ({
        key: this.corruptListing ? `${key}/../foreign` : key,
      })),
      truncated,
      ...(truncated ? { cursor: this.cycleCursor ? 'cycle' : String(nextOffset) } : {}),
    }
  }
  delete = async (keys: ReadonlyArray<string>) => {
    for (const key of keys) {
      this.deleted.push(key)
      this.values.delete(key)
    }
    if (
      keys.length === 1 &&
      keys[0] === `${prefix}/manifest.json` &&
      this.failManifestAfterDelete
    ) {
      this.failManifestAfterDelete = false
      throw new Error('manifest response lost')
    }
  }
}

describe('bounded backup prefix deletion', () => {
  it('deletes encrypted chunks before the manifest and never a sibling prefix', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.values.add(`${prefix}/chunks/00000000.bin`)
    bucket.values.add(`${prefix}/chunks/00000001.bin`)
    bucket.values.add(`${prefix}/manifest.json`)
    bucket.values.add('organizations/org-a/servers/server-a/backups/backup-other/manifest.json')
    const receipt = await Effect.runPromise(deleteBackupObjectPrefix(bucket, prefix))
    expect(receipt).toEqual({ deletedObjects: 3, alreadyAbsent: false, deletedPrefix: prefix })
    expect(bucket.deleted.at(-1)).toBe(`${prefix}/manifest.json`)
    expect(
      bucket.values.has('organizations/org-a/servers/server-a/backups/backup-other/manifest.json'),
    ).toBe(true)
  })

  it('adopts an already-empty exact prefix after response loss', async () => {
    const bucket = new MemoryDeletionBucket()
    const receipt = await Effect.runPromise(deleteBackupObjectPrefix(bucket, prefix))
    expect(receipt.alreadyAbsent).toBe(true)
    expect(receipt.deletedPrefix).toBe(prefix)
  })

  it('fails closed for foreign objects returned by a faulty listing adapter', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.values.add(`${prefix}/manifest.json`)
    bucket.corruptListing = true
    const result = await Effect.runPromise(Effect.result(deleteBackupObjectPrefix(bucket, prefix)))
    expect(result._tag).toBe('Failure')
  })

  it('fails closed for an unexpected object inside the backup prefix', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.values.add(`${prefix}/unexpected.txt`)
    const result = await Effect.runPromise(Effect.result(deleteBackupObjectPrefix(bucket, prefix)))
    expect(result._tag).toBe('Failure')
    expect(bucket.deleted).toEqual([])
  })

  it('rejects a repeated R2 listing cursor instead of looping', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.values.add(`${prefix}/manifest.json`)
    bucket.cycleCursor = true
    const result = await Effect.runPromise(Effect.result(deleteBackupObjectPrefix(bucket, prefix)))
    expect(result._tag).toBe('Failure')
  })

  it('keeps the manifest as a separate final delete and adopts a lost final response', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.values.add(`${prefix}/chunks/00000000.bin`)
    bucket.values.add(`${prefix}/chunks/00000001.bin`)
    bucket.values.add(`${prefix}/manifest.json`)
    bucket.failManifestAfterDelete = true
    const first = await Effect.runPromise(Effect.result(deleteBackupObjectPrefix(bucket, prefix)))
    expect(first._tag).toBe('Failure')
    expect(bucket.deleted).toEqual([
      `${prefix}/chunks/00000000.bin`,
      `${prefix}/chunks/00000001.bin`,
      `${prefix}/manifest.json`,
    ])
    expect(bucket.values.size).toBe(0)
    const retry = await Effect.runPromise(deleteBackupObjectPrefix(bucket, prefix))
    expect(retry.alreadyAbsent).toBe(true)
  })

  it('deduplicates overlapping multipage listings in first-seen order', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.pageSize = 2
    bucket.duplicateAcrossPages = true
    bucket.values.add(`${prefix}/chunks/00000002.bin`)
    bucket.values.add(`${prefix}/manifest.json`)
    bucket.values.add(`${prefix}/chunks/00000000.bin`)
    bucket.values.add(`${prefix}/chunks/00000001.bin`)

    const receipt = await Effect.runPromise(deleteBackupObjectPrefix(bucket, prefix, 4))
    expect(receipt).toEqual({ deletedObjects: 4, alreadyAbsent: false, deletedPrefix: prefix })
    expect(bucket.listCalls).toBe(2)
    expect(bucket.deleted).toEqual([
      `${prefix}/chunks/00000000.bin`,
      `${prefix}/chunks/00000001.bin`,
      `${prefix}/chunks/00000002.bin`,
      `${prefix}/manifest.json`,
    ])
  })

  it('fails before deletion when unique keys across pages exceed the maximum bound', async () => {
    const bucket = new MemoryDeletionBucket()
    bucket.pageSize = 2
    bucket.values.add(`${prefix}/chunks/00000000.bin`)
    bucket.values.add(`${prefix}/chunks/00000001.bin`)
    bucket.values.add(`${prefix}/chunks/00000002.bin`)
    bucket.values.add(`${prefix}/manifest.json`)

    const result = await Effect.runPromise(
      Effect.result(deleteBackupObjectPrefix(bucket, prefix, 3)),
    )
    expect(result._tag).toBe('Failure')
    expect(bucket.listCalls).toBe(2)
    expect(bucket.deleted).toEqual([])
  })
})

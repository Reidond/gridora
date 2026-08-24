import { describe, expect, it } from 'vitest'
import {
  makeCloudflareBackupR2Bucket,
  type CloudflareR2BucketBindingShape,
  type CloudflareR2ObjectShape,
} from '../src/index.js'

const object = (key: string): CloudflareR2ObjectShape => ({
  key,
  size: 4,
  etag: 'etag-a',
  customMetadata: { tenant: 'org-a' },
})

describe('Cloudflare R2 binding adapter', () => {
  it('maps metadata and sends a create-only conditional write', async () => {
    let observedOnlyIf: Headers | undefined
    let observedMetadata: Readonly<Record<string, string>> | undefined
    const binding: CloudflareR2BucketBindingShape = {
      head: async (key) => object(key),
      get: async (key) => ({
        ...object(key),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]))
            controller.close()
          },
        }),
      }),
      put: async (key, _value, options) => {
        observedOnlyIf = options?.onlyIf
        observedMetadata = options?.customMetadata
        return object(key)
      },
      createMultipartUpload: async (key, options) => ({
        key,
        uploadId: 'multipart-a',
        uploadPart: async () => ({ partNumber: 1, etag: 'part-a' }),
        abort: async () => undefined,
        complete: async () => ({
          ...object(key),
          ...(options?.customMetadata === undefined
            ? {}
            : { customMetadata: options.customMetadata }),
        }),
      }),
      resumeMultipartUpload: (key, uploadId) => ({
        key,
        uploadId,
        uploadPart: async () => ({ partNumber: 1, etag: 'part-a' }),
        abort: async () => undefined,
        complete: async () => object(key),
      }),
    }
    const bucket = makeCloudflareBackupR2Bucket(binding)
    await expect(bucket.head('key-a')).resolves.toEqual({
      key: 'key-a',
      size: 4,
      etag: 'etag-a',
      customMetadata: { tenant: 'org-a' },
    })
    await expect(bucket.get('key-a')).resolves.toMatchObject({ key: 'key-a', size: 4 })
    await expect(
      bucket.put('key-a', new Uint8Array([1, 2, 3, 4]), {
        customMetadata: { tenant: 'org-a' },
        onlyIfAbsent: true,
      }),
    ).resolves.toMatchObject({ key: 'key-a', etag: 'etag-a' })
    expect(observedOnlyIf?.get('if-none-match')).toBe('*')
    expect(observedMetadata).toEqual({ tenant: 'org-a' })
  })

  it('rejects Cloudflare precondition failures and objects without a body', async () => {
    const binding: CloudflareR2BucketBindingShape = {
      head: async () => null,
      get: async (key) => object(key),
      put: async () => null,
      createMultipartUpload: async () => {
        throw new Error('not used')
      },
      resumeMultipartUpload: () => {
        throw new Error('not used')
      },
    }
    const bucket = makeCloudflareBackupR2Bucket(binding)
    await expect(
      bucket.put('key-a', 'body', { customMetadata: {}, onlyIfAbsent: true }),
    ).rejects.toThrow(/conditional write/)
    await expect(bucket.get('key-a')).rejects.toThrow(/body is unavailable/)
  })
})

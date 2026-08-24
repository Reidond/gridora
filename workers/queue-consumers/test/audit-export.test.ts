import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_EXPORT_LIMITS,
  AuditExportEvent,
  archiveAuditEvent,
  auditPartitionKey,
  processAuditExportMessages,
  type AuditArchiveBucket,
  type AuditArchiveObjectBody,
  type AuditArchiveObjectInfo,
  type AuditArchivePutOptions,
  type AuditExportEvent as AuditExportEventValue,
} from '../src/audit-export.js'

interface StoredObject {
  readonly key: string
  bytes: Uint8Array
  customMetadata: Record<string, string>
}

const copy = (bytes: Uint8Array): Uint8Array => {
  const output = new Uint8Array(bytes.byteLength)
  output.set(bytes)
  return output
}

const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const output = new Uint8Array(bytes.byteLength)
  output.set(bytes)
  return output.buffer
}

const info = (stored: StoredObject): AuditArchiveObjectInfo => ({
  key: stored.key,
  size: stored.bytes.byteLength,
  customMetadata: { ...stored.customMetadata },
})

class InMemoryAuditArchive implements AuditArchiveBucket {
  readonly objects = new Map<string, StoredObject>()
  putCalls = 0
  failAfterStoreOnce = false
  failBeforeStoreOnce = false
  lastOnlyIfNoneMatch: string | null = null

  async head(key: string): Promise<AuditArchiveObjectInfo | null> {
    const stored = this.objects.get(key)
    return stored === undefined ? null : info(stored)
  }

  async get(key: string): Promise<AuditArchiveObjectBody | null> {
    const stored = this.objects.get(key)
    if (stored === undefined) return null
    const bytes = copy(stored.bytes)
    return {
      ...info(stored),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    }
  }

  async put(
    key: string,
    value: Uint8Array,
    options: AuditArchivePutOptions,
  ): Promise<AuditArchiveObjectInfo | null> {
    this.putCalls += 1
    this.lastOnlyIfNoneMatch = options.onlyIf.get('if-none-match')
    if (this.failBeforeStoreOnce) {
      this.failBeforeStoreOnce = false
      throw new Error('simulated transport loss before persistence')
    }
    if (this.lastOnlyIfNoneMatch !== '*') throw new Error('only-if-absent is required')
    const observedDigest = await crypto.subtle.digest('SHA-256', arrayBuffer(value))
    expect(new Uint8Array(options.sha256)).toEqual(new Uint8Array(observedDigest))
    if (this.objects.has(key)) return null
    this.objects.set(key, {
      key,
      bytes: copy(value),
      customMetadata: { ...options.customMetadata },
    })
    if (this.failAfterStoreOnce) {
      this.failAfterStoreOnce = false
      throw new Error('simulated response loss after persistence')
    }
    return info(this.objects.get(key)!)
  }

  bodyText(key: string): string {
    const stored = this.objects.get(key)
    if (stored === undefined) throw new Error('missing test object')
    return new TextDecoder().decode(stored.bytes)
  }

  replaceMetadata(key: string, metadata: Record<string, string>): void {
    const stored = this.objects.get(key)
    if (stored === undefined) throw new Error('missing test object')
    stored.customMetadata = { ...metadata }
  }

  tamperBody(key: string): void {
    const stored = this.objects.get(key)
    if (stored === undefined || stored.bytes.byteLength === 0)
      throw new Error('missing test object')
    stored.bytes[stored.bytes.byteLength - 1] = (stored.bytes[stored.bytes.byteLength - 1] ?? 0) ^ 1
  }
}

const now = Date.parse('2026-08-23T12:00:00.000Z')

const tenantEnvelope = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  captureStatus: 'complete',
  occurredAt: '2026-08-23T11:59:00.000Z',
  scope: 'tenant',
  organizationId: 'org-a',
  actor: { type: 'human', id: 'identity-a' },
  request: { id: 'request-a', correlationId: 'correlation-a' },
  action: 'provider.node.create',
  target: { type: 'node', id: 'node-a' },
  before: { state: 'absent', reason: 'node-did-not-exist' },
  after: { state: 'captured', summary: { region: 'eu-west', state: 'provisioning' } },
  operationId: 'operation-a',
  source: {
    origin: 'http',
    ip: { state: 'captured', value: '203.0.113.7' },
    access: {
      state: 'captured',
      value: {
        subject: 'access-subject-a',
        identityId: 'identity-a',
        issuer: 'https://access.example.test',
        email: 'operator@example.test',
      },
    },
  },
  result: 'succeeded',
  error: { classification: 'none', code: null },
  forced: false,
  breakGlass: false,
  ...overrides,
})

const tenantEvent = (
  outer: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): AuditExportEventValue =>
  Schema.decodeUnknownSync(AuditExportEvent)({
    version: 1,
    scope: 'tenant',
    id: 'audit-provider-create-a',
    organizationId: 'org-a',
    partitionKey: auditPartitionKey('org-a'),
    exportRequestId: 'audit-export-00000000000000000001',
    admittedAt: '2026-08-23T12:00:00.000Z',
    envelope: tenantEnvelope(envelope),
    ...outer,
  })

const platformEvent = (
  outer: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): AuditExportEventValue =>
  Schema.decodeUnknownSync(AuditExportEvent)({
    version: 1,
    scope: 'platform',
    id: 'platform-audit-image-a',
    partitionKey: 'platform:audit',
    exportRequestId: 'platform-audit-export-00000000000000000001',
    admittedAt: '2026-08-23T12:00:00.000Z',
    envelope: {
      ...tenantEnvelope({
        scope: 'platform',
        organizationId: null,
        action: 'platform.image.promote',
        target: { type: 'node-image', id: 'image-a' },
        operationId: 'platform-operation-a',
        request: { id: 'platform-request-a', correlationId: 'platform-correlation-a' },
      }),
      ...envelope,
    },
    ...outer,
  })

const archive = (bucket: AuditArchiveBucket, input: unknown = tenantEvent()) =>
  Effect.runPromise(archiveAuditEvent(bucket, input, { now: () => now }))

describe('complete audit envelope R2 archive', () => {
  it('recovers a response-loss write and preserves the full v1 envelope byte-for-byte', async () => {
    const bucket = new InMemoryAuditArchive()
    bucket.failAfterStoreOnce = true
    const first = await archive(bucket)
    expect(first).toMatchObject({ adopted: true, scope: 'tenant', organizationId: 'org-a' })
    expect(first.key).toMatch(
      /^organizations\/org-a\/audit\/2026\/08\/23\/events\/[a-f0-9]{64}\.json$/,
    )
    expect(bucket.lastOnlyIfNoneMatch).toBe('*')
    const firstBody = bucket.bodyText(first.key)
    expect(firstBody).toContain('operation-a')
    expect(firstBody).toContain('node-did-not-exist')
    expect(firstBody).toContain('captureStatus')

    const replay = await archive(bucket)
    expect(replay).toMatchObject({ key: first.key, adopted: true, checksum: first.checksum })
    expect(bucket.putCalls).toBe(1)
    expect(bucket.bodyText(first.key)).toBe(firstBody)
  })

  it('keeps tenant and platform evidence in disjoint prefixes without platform tenant metadata', async () => {
    const bucket = new InMemoryAuditArchive()
    const tenant = await archive(bucket)
    const platform = await archive(bucket, platformEvent())
    expect(tenant.key).toContain('organizations/org-a/audit/')
    expect(platform.key).toMatch(/^platform\/audit\/2026\/08\/23\/events\/[a-f0-9]{64}\.json$/)
    expect(tenant.key).not.toBe(platform.key)
    expect(platform.organizationId).toBeNull()
    const metadata = bucket.objects.get(platform.key)?.customMetadata
    expect(metadata?.['gridora-platform-partition']).toBe('platform:audit')
    expect(metadata).not.toHaveProperty('gridora-organization-id')
    expect(metadata?.['gridora-admitted-at']).toBe('2026-08-23T12:00:00.000Z')
  })

  it('accepts the durable admission boundary and replays after a much later Queue delivery', async () => {
    const bucket = new InMemoryAuditArchive()
    bucket.failAfterStoreOnce = true
    const event = tenantEvent({}, { occurredAt: '2026-08-23T12:05:00.000Z' })
    const delayedWorkerClock = Date.parse('2031-01-01T00:00:00.000Z')
    const first = await Effect.runPromise(
      archiveAuditEvent(bucket, event, { now: () => delayedWorkerClock }),
    )
    expect(first.adopted).toBe(true)
    const replay = await Effect.runPromise(
      archiveAuditEvent(bucket, event, { now: () => delayedWorkerClock + 86_400_000 }),
    )
    expect(replay).toMatchObject({ key: first.key, adopted: true })
    expect(bucket.putCalls).toBe(1)
  })

  it('does not adopt foreign ownership or mutated archive content', async () => {
    const bucket = new InMemoryAuditArchive()
    const receipt = await archive(bucket)
    bucket.replaceMetadata(receipt.key, { 'gridora-managed-by': 'foreign' })
    await expect(archive(bucket)).rejects.toMatchObject({ code: 'ownership-denied' })

    const conflict = new InMemoryAuditArchive()
    const conflictReceipt = await archive(conflict)
    conflict.tamperBody(conflictReceipt.key)
    await expect(archive(conflict)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('retries before persistence and acknowledges only after R2 holds the exact event', async () => {
    const bucket = new InMemoryAuditArchive()
    bucket.failBeforeStoreOnce = true
    const actions: string[] = []
    const message = {
      body: tenantEvent(),
      attempts: 20,
      ack: () => actions.push('ack'),
      retry: ({ delaySeconds }: { readonly delaySeconds: number }) =>
        actions.push(`retry:${delaySeconds}`),
    }
    await expect(
      processAuditExportMessages([message], bucket, { now: () => now }),
    ).resolves.toEqual([{ decision: 'retry', errorCode: 'write-uncertain' }])
    await expect(
      processAuditExportMessages([message], bucket, { now: () => now }),
    ).resolves.toMatchObject([{ decision: 'ack' }])
    expect(actions).toEqual(['retry:256', 'ack'])
  })
})

describe('audit export boundary validation', () => {
  it('rejects scope/partition confusion and timestamps outside durable admission before R2', async () => {
    const bucket = new InMemoryAuditArchive()
    await expect(
      archive(bucket, tenantEvent({ partitionKey: auditPartitionKey('org-b') })),
    ).rejects.toMatchObject({ code: 'partition-mismatch' })
    await expect(
      archive(bucket, tenantEvent({}, { occurredAt: '2026-08-23T12:05:00.001Z' })),
    ).rejects.toMatchObject({ code: 'time-bound' })
    const invalidTimestamp = {
      ...tenantEvent(),
      envelope: { ...tenantEvent().envelope, occurredAt: '2026-02-30T12:00:00.000Z' },
    }
    await expect(archive(bucket, invalidTimestamp)).rejects.toMatchObject({ code: 'invalid-event' })
    await expect(
      archive(bucket, platformEvent({ partitionKey: auditPartitionKey('org-a') })),
    ).rejects.toMatchObject({ code: 'partition-mismatch' })
    expect(bucket.putCalls).toBe(0)
  })

  it('uses shared recursive redaction and budgets for tenant and platform archive payloads', async () => {
    const bucket = new InMemoryAuditArchive()
    const canary = 'gridora-super-secret-canary'
    const receipt = await archive(
      bucket,
      tenantEvent(
        {},
        {
          after: {
            state: 'captured',
            summary: { apiToken: canary, nested: { passwordHash: canary, visible: 'yes' } },
          },
        },
      ),
    )
    const body = bucket.bodyText(receipt.key)
    expect(body).toContain('[REDACTED]')
    expect(body).toContain('visible')
    expect(body).not.toContain(canary)
    await expect(
      archive(
        bucket,
        tenantEvent(
          {},
          {
            after: {
              state: 'captured',
              summary: { description: 'x'.repeat(AUDIT_EXPORT_LIMITS.maximumScalarCharacters + 1) },
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'size-limit' })
  })
})

/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  archiveAuditEvent,
  type AuditArchiveBucket,
  type AuditArchiveObjectBody,
  type AuditArchiveObjectInfo,
  type AuditArchivePutOptions,
} from '../src/audit-export.js'
import { publishPlatformAuditOutbox, type QueueEnv } from '../src/index.js'

class D1StatementAdapter {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: ReadonlyArray<unknown> = [],
  ) {}

  bind(...values: ReadonlyArray<unknown>): D1StatementAdapter {
    return new D1StatementAdapter(this.database, this.sql, values)
  }

  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.database.prepare(this.sql).all(...(this.values as SQLInputValue[])) }
  }

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    const result = this.database.prepare(this.sql).run(...(this.values as SQLInputValue[]))
    return { meta: { changes: Number(result.changes) } }
  }
}

interface StoredAudit {
  readonly key: string
  readonly bytes: Uint8Array
  readonly metadata: Readonly<Record<string, string>>
}

class InMemoryArchive implements AuditArchiveBucket {
  readonly objects = new Map<string, StoredAudit>()

  async head(key: string): Promise<AuditArchiveObjectInfo | null> {
    const stored = this.objects.get(key)
    return stored === undefined
      ? null
      : { key, size: stored.bytes.byteLength, customMetadata: stored.metadata }
  }

  async get(key: string): Promise<AuditArchiveObjectBody | null> {
    const stored = this.objects.get(key)
    if (stored === undefined) return null
    const bytes = new Uint8Array(stored.bytes)
    return {
      key,
      size: bytes.byteLength,
      customMetadata: stored.metadata,
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
    if (options.onlyIf.get('if-none-match') !== '*') throw new Error('conditional write required')
    const existing = await this.head(key)
    if (existing !== null) return null
    const bytes = new Uint8Array(value)
    this.objects.set(key, { key, bytes, metadata: options.customMetadata })
    return { key, size: bytes.byteLength, customMetadata: options.customMetadata }
  }
}

let database: DatabaseSync | undefined

afterEach(() => {
  database?.close()
  database = undefined
})

describe('platform audit outbox to Queue to R2', () => {
  it('replays a lost Queue response through the platform partition and R2 adopts the exact event', async () => {
    database = new DatabaseSync(':memory:')
    const migrationsDirectory = fileURLToPath(
      new URL('../../../packages/migrations/sql/', import.meta.url),
    )
    for (const migration of readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      database.exec(readFileSync(`${migrationsDirectory}/${migration}`, 'utf8'))
    }
    const occurredAt = '2026-08-23T12:00:00.000Z'
    database
      .prepare(`INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('identity-platform', 'access-platform', 'platform@example.test', 'Platform', 'active', ?, ?)`)
      .run(occurredAt, occurredAt)
    database
      .prepare(`INSERT INTO platform_operations
        (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
         progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
        VALUES ('platform-operation-a', 'platform', 'platform.image.promote', 'node-image', 'image-a',
          'identity-platform', 'platform-correlation-a', 'succeeded', 100,
          'platform-operation-a-key', ?, 1, ?, ?)`)
      .run('a'.repeat(64), occurredAt, occurredAt)
    const stage = await Effect.runPromise(
      stageAuditEnvelope(
        'platform',
        'platform-audit-a',
        {
          version: 1,
          captureStatus: 'complete',
          occurredAt,
          scope: 'platform',
          organizationId: null,
          actor: { type: 'human', id: 'identity-platform' },
          request: { id: 'platform-request-a', correlationId: 'platform-correlation-a' },
          action: 'platform.image.promote',
          target: { type: 'node-image', id: 'image-a' },
          before: { state: 'captured', summary: { channel: 'candidate' } },
          after: { state: 'captured', summary: { channel: 'stable' } },
          operationId: 'platform-operation-a',
          source: {
            origin: 'http',
            ip: { state: 'captured', value: '203.0.113.10' },
            access: {
              state: 'captured',
              value: {
                subject: 'access-platform',
                identityId: 'identity-platform',
                issuer: 'https://access.example.test',
                email: 'platform@example.test',
              },
            },
          },
          result: 'succeeded',
          error: { classification: 'none', code: null },
          forced: false,
          breakGlass: false,
        },
        occurredAt,
      ),
    )
    database.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
    database
      .prepare(`INSERT INTO global_audit_events
        (id, scope, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
        VALUES ('platform-audit-a', 'platform', 'identity-platform', 'platform.image.promote',
          'node-image', 'image-a', 'succeeded', 'platform-correlation-a', '{"channel":"stable"}', ?)`)
      .run(occurredAt)

    const archive = new InMemoryArchive()
    let responseLost = true
    const env = {
      DB: { prepare: (sql: string) => new D1StatementAdapter(database!, sql) },
      AUDIT_EXPORT: {
        send: async (event: unknown) => {
          await Effect.runPromise(
            archiveAuditEvent(archive, event, { now: () => Date.parse(occurredAt) }),
          )
          if (responseLost) {
            responseLost = false
            throw new Error('simulated Queue response loss')
          }
        },
      },
    } as unknown as Pick<QueueEnv, 'DB' | 'AUDIT_EXPORT'>

    await expect(publishPlatformAuditOutbox(env)).rejects.toThrow('simulated Queue response loss')
    expect(
      database
        .prepare(`SELECT publish_state AS publishState, retry_count AS retryCount
          FROM platform_audit_export_outbox WHERE audit_event_id = 'platform-audit-a'`)
        .get(),
    ).toEqual({ publishState: 'failed', retryCount: 1 })
    database
      .prepare(
        `UPDATE platform_audit_export_outbox SET available_at = ? WHERE audit_event_id = 'platform-audit-a'`,
      )
      .run(occurredAt)

    await expect(publishPlatformAuditOutbox(env)).resolves.toBe(1)
    expect(
      database
        .prepare(`SELECT publish_state AS publishState, retry_count AS retryCount
          FROM platform_audit_export_outbox WHERE audit_event_id = 'platform-audit-a'`)
        .get(),
    ).toEqual({ publishState: 'delivered', retryCount: 1 })
    expect([...archive.objects.keys()]).toHaveLength(1)
    const [key, stored] = [...archive.objects.entries()][0] ?? []
    expect(key).toMatch(/^platform\/audit\//)
    expect(stored?.metadata).toMatchObject({ 'gridora-platform-partition': 'platform:audit' })
    expect(stored?.metadata).not.toHaveProperty('gridora-organization-id')
  })
})

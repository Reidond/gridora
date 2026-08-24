import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
const migrationFiles = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
] as const
const auditExportMigration = '0007_audit_export_outbox.sql'

interface AuditRow {
  readonly id: string
  readonly organizationId: string
  readonly exportRequestId?: string
  readonly actorId: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly result: 'succeeded' | 'denied' | 'failed'
  readonly correlationId: string
  readonly summary: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

interface OutboxRow {
  readonly id: string
  readonly organization_id: string
  readonly event_type: string
  readonly aggregate_type: string
  readonly aggregate_id: string
  readonly payload_json: string
  readonly publish_state: string
  readonly retry_count: number
  readonly available_at: string
  readonly created_at: string
}

let database: DatabaseSync | undefined

const apply = (file: string): void => {
  database?.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
}

const initializeBeforeAuditExport = (): DatabaseSync => {
  const next = new DatabaseSync(':memory:')
  database = next
  for (const file of migrationFiles) apply(file)
  return next
}

const seedTenant = (
  target: DatabaseSync,
  organizationId: string,
  slug: string,
  identityId: string,
): void => {
  target
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(
      identityId,
      `access-${identityId}`,
      `${identityId}@example.com`,
      identityId,
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:00:00.000Z',
    )
  target
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'organization', 1, 1, ?)`)
    .run(organizationId, organizationId, slug, '2026-08-23T10:00:00.000Z')
}

const insertAudit = (target: DatabaseSync, row: AuditRow): void => {
  target
    .prepare(`INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id,
      row.organizationId,
      row.actorId,
      row.action,
      row.targetType,
      row.targetId,
      row.result,
      row.correlationId,
      JSON.stringify(row.summary),
      row.createdAt,
    )
}

const event = (overrides: Partial<AuditRow> = {}): AuditRow => ({
  id: 'audit-provider-create-a',
  organizationId: 'org-a',
  actorId: 'identity-a',
  action: 'provider.node.create',
  targetType: 'node',
  targetId: 'node-a',
  result: 'succeeded',
  correlationId: 'correlation-a',
  summary: { state: 'provisioning', region: 'eu-west' },
  createdAt: '2001-01-01T00:00:00.000Z',
  ...overrides,
})

const expectedQueuePayload = (row: AuditRow): Record<string, unknown> => ({
  id: row.id,
  organizationId: row.organizationId,
  partitionKey: `${row.organizationId}:audit`,
  exportRequestId: row.exportRequestId,
  actorId: row.actorId,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  result: row.result,
  correlationId: row.correlationId,
  summary: row.summary,
  createdAt: row.createdAt,
})

afterEach(() => {
  database?.close()
  database = undefined
})

describe('audit export outbox migration', () => {
  it('fails closed when a pre-migration row has claimed an audit export namespace', () => {
    const target = initializeBeforeAuditExport()
    seedTenant(target, 'org-a', 'organization-a', 'identity-a')
    target
      .prepare(`INSERT INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, created_at)
        VALUES ('audit-export-00000000000000000001', 'org-a', 'foreign.event',
         'foreign', 'foreign-1', '{}', 'pending', 0,
         '2026-08-23T11:00:00.000Z', '2026-08-23T11:00:00.000Z')`)
      .run()

    expect(() => apply(auditExportMigration)).toThrow(/audit_export_namespace_policy|CHECK/)
    expect(
      target
        .prepare("SELECT count(*) AS count FROM outbox WHERE event_type = 'audit.export.requested'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('fails closed before backfill when a historical summary contains a secret-shaped field', () => {
    const target = initializeBeforeAuditExport()
    seedTenant(target, 'org-a', 'organization-a', 'identity-a')
    const canary = 'gridora-historical-audit-canary'
    insertAudit(
      target,
      event({
        id: 'audit-historical-secret',
        summary: { nested: { providerCredential: canary } },
      }),
    )

    let migrationError = ''
    try {
      apply(auditExportMigration)
    } catch (cause) {
      migrationError = cause instanceof Error ? cause.message : 'unknown migration failure'
    }
    expect(migrationError).toMatch(/audit_export_summary_policy|CHECK constraint failed/)
    expect(migrationError).not.toContain(canary)
    expect(target.prepare('SELECT count(*) AS count FROM outbox').get()).toEqual({ count: 0 })
  })

  it('backfills authoritative rows exactly once, including old audits and separate tenants', () => {
    const target = initializeBeforeAuditExport()
    seedTenant(target, 'org-a', 'organization-a', 'identity-a')
    seedTenant(target, 'org-b', 'organization-b', 'identity-b')
    const tenantA = event()
    const tenantB = event({
      id: 'audit-provider-create-b',
      organizationId: 'org-b',
      actorId: 'identity-b',
      targetId: 'node-b',
      correlationId: 'correlation-b',
      createdAt: '2002-02-02T00:00:00.000Z',
    })
    insertAudit(target, tenantA)
    insertAudit(target, tenantB)

    apply(auditExportMigration)

    const rows = target
      .prepare(`SELECT id, organization_id, event_type, aggregate_type, aggregate_id,
        payload_json, publish_state, retry_count, available_at, created_at
        FROM outbox WHERE event_type = 'audit.export.requested' ORDER BY id`)
      .all() as unknown as OutboxRow[]
    expect(rows).toHaveLength(2)
    const first = rows[0]
    const second = rows[1]
    if (first === undefined || second === undefined) throw new Error('missing audit outbox rows')
    expect(rows.map((row) => row.organization_id)).toEqual(['org-a', 'org-b'])
    expect(first).toMatchObject({
      id: 'audit-export-00000000000000000001',
      organization_id: 'org-a',
      event_type: 'audit.export.requested',
      aggregate_type: 'audit_event',
      aggregate_id: 'audit-event-00000000000000000001',
      publish_state: 'pending',
      retry_count: 0,
      available_at: tenantA.createdAt,
      created_at: tenantA.createdAt,
    })
    expect(first.payload_json).toBe(
      JSON.stringify(expectedQueuePayload({ ...tenantA, exportRequestId: first.id })),
    )
    expect(second.payload_json).toBe(
      JSON.stringify(expectedQueuePayload({ ...tenantB, exportRequestId: second.id })),
    )
    expect(JSON.parse(first.payload_json)).not.toHaveProperty('secret')

    const stableSnapshot = rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      payload: row.payload_json,
    }))
    apply(auditExportMigration)
    const replayed = target
      .prepare(`SELECT id, aggregate_id, payload_json
        FROM outbox WHERE event_type = 'audit.export.requested' ORDER BY id`)
      .all()
    expect(replayed).toEqual(
      stableSnapshot.map(({ id, aggregateId, payload }) => ({
        id,
        aggregate_id: aggregateId,
        payload_json: payload,
      })),
    )
    expect(target.prepare('SELECT count(*) AS count FROM audit_export_requests').get()).toEqual({
      count: 2,
    })
    expect(() =>
      target
        .prepare(
          "DELETE FROM audit_export_requests WHERE audit_event_id = 'audit-provider-create-a'",
        )
        .run(),
    ).toThrow(/audit export request identity is immutable/)
    expect(target.prepare('SELECT count(*) AS count FROM audit_export_requests').get()).toEqual({
      count: 2,
    })
    expect(() =>
      target
        .prepare(`UPDATE outbox
          SET publish_state = 'publishing', lease_owner = 'worker-a',
              lease_token = 'lease-a', lease_until = '2026-08-23T12:00:00.000Z'
          WHERE id = 'audit-export-00000000000000000001'`)
        .run(),
    ).not.toThrow()
    expect(
      target
        .prepare("SELECT publish_state FROM outbox WHERE id = 'audit-export-00000000000000000001'")
        .get(),
    ).toEqual({ publish_state: 'publishing' })
  })

  it('atomically enqueues inserts and rolls back both rows while rejecting non-object summaries', () => {
    const target = initializeBeforeAuditExport()
    seedTenant(target, 'org-a', 'organization-a', 'identity-a')
    seedTenant(target, 'org-b', 'organization-b', 'identity-b')
    apply(auditExportMigration)

    const rolledBack = event({
      id: 'audit-rolled-back',
      createdAt: '2026-08-23T11:00:00.000Z',
    })
    target.exec('BEGIN IMMEDIATE')
    insertAudit(target, rolledBack)
    expect(target.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({ count: 1 })
    expect(target.prepare('SELECT count(*) AS count FROM outbox').get()).toEqual({ count: 1 })
    target.exec('ROLLBACK')
    expect(target.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({ count: 0 })
    expect(target.prepare('SELECT count(*) AS count FROM outbox').get()).toEqual({ count: 0 })

    const tenantA = event({ id: 'audit-trigger-a', createdAt: '2026-08-23T11:01:00.000Z' })
    const tenantB = event({
      id: 'audit-trigger-b',
      organizationId: 'org-b',
      actorId: 'identity-b',
      targetId: 'node-b',
      correlationId: 'correlation-b',
      createdAt: '2026-08-23T11:02:00.000Z',
    })
    insertAudit(target, tenantA)
    insertAudit(target, tenantB)

    const payloads = target
      .prepare(`SELECT organization_id, payload_json
        FROM outbox WHERE event_type = 'audit.export.requested' ORDER BY organization_id`)
      .all() as unknown as Array<{ organization_id: string; payload_json: string }>
    expect(
      payloads.map(({ organization_id, payload_json }) => ({
        organization_id,
        payload: JSON.parse(payload_json),
      })),
    ).toEqual([
      {
        organization_id: 'org-a',
        payload: expectedQueuePayload({
          ...tenantA,
          exportRequestId: 'audit-export-00000000000000000001',
        }),
      },
      {
        organization_id: 'org-b',
        payload: expectedQueuePayload({
          ...tenantB,
          exportRequestId: 'audit-export-00000000000000000002',
        }),
      },
    ])

    expect(() =>
      target
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES ('audit-scalar', 'org-a', 'identity-a', 'test', 'node', 'node-a',
           'failed', 'correlation-scalar', '"secret-value"', '2026-08-23T11:03:00.000Z')`)
        .run(),
    ).toThrow(/audit summary violates export policy/)
    const canary = 'gridora-plaintext-audit-canary'
    expect(() =>
      insertAudit(
        target,
        event({
          id: 'audit-secret-shaped',
          summary: { safe: 'visible', nested: { apiToken: canary } },
          createdAt: '2026-08-23T11:04:00.000Z',
        }),
      ),
    ).toThrow(/audit summary violates export policy/)
    expect(() =>
      insertAudit(
        target,
        event({
          id: 'audit-obfuscated-secret',
          summary: { nested: { 'api/token': canary } },
          createdAt: '2026-08-23T11:04:30.000Z',
        }),
      ),
    ).toThrow(/audit summary violates export policy/)
    expect(
      target.prepare("SELECT count(*) AS count FROM audit_events WHERE id = 'audit-scalar'").get(),
    ).toEqual({ count: 0 })
    expect(target.prepare('SELECT count(*) AS count FROM outbox').get()).toEqual({ count: 2 })
    const persisted = JSON.stringify({
      audits: target.prepare('SELECT summary_json FROM audit_events').all(),
      outbox: target.prepare('SELECT payload_json FROM outbox').all(),
    })
    expect(persisted).not.toContain(canary)

    expect(() =>
      target
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES ('audit-export-00000000000000000003', 'org-a', 'foreign.event',
           'foreign', 'foreign-3', '{}', 'pending', 0,
           '2026-08-23T11:05:00.000Z', '2026-08-23T11:05:00.000Z')`)
        .run(),
    ).toThrow(/audit export outbox identity is invalid/)
    expect(() =>
      target
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES ('audit-export-00000000000000000003', 'org-a',
           'audit.export.requested', 'audit_event',
           'audit-event-00000000000000000003', '{}', 'pending', 0,
           '2026-08-23T11:05:00.000Z', '2026-08-23T11:05:00.000Z')`)
        .run(),
    ).toThrow(/audit export outbox identity is invalid/)
    expect(() =>
      target
        .prepare(`UPDATE outbox SET payload_json = '{"tampered":true}'
          WHERE id = 'audit-export-00000000000000000001'`)
        .run(),
    ).toThrow(/audit export outbox identity is immutable/)
    target
      .prepare(`INSERT INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, created_at)
        VALUES ('foreign-outbox-3', 'org-a', 'foreign.event', 'foreign', 'foreign-3',
         '{}', 'pending', 0, '2026-08-23T11:05:00.000Z', '2026-08-23T11:05:00.000Z')`)
      .run()
    expect(() =>
      target
        .prepare(`UPDATE outbox SET aggregate_id = 'audit-event-00000000000000000003'
          WHERE id = 'foreign-outbox-3'`)
        .run(),
    ).toThrow(/audit export outbox identity is immutable/)
    expect(() =>
      target
        .prepare(`UPDATE audit_events SET summary_json = '{"state":"tampered"}'
          WHERE id = 'audit-trigger-a'`)
        .run(),
    ).toThrow(/audit event is immutable/)
  })
})

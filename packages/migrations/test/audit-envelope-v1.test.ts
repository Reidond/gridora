import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import { migrations } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
const beforeV1 = migrations.filter((migration) => migration.id < 28)
const v1 = migrations.find((migration) => migration.id === 28)
if (v1 === undefined) throw new Error('audit envelope migration is not registered')

let database: DatabaseSync | undefined

const apply = (file: string): void => database?.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))

const seedTenant = (organizationId: string, identityId: string): void => {
  database
    ?.prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(
      identityId,
      `access-${identityId}`,
      `${identityId}@example.test`,
      identityId,
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:00:00.000Z',
    )
  database
    ?.prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'organization', 1, 1, ?)`)
    .run(organizationId, organizationId, organizationId, '2026-08-23T10:00:00.000Z')
  database
    ?.prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES (?, ?, 'owner', 'active', ?, NULL, 1)`)
    .run(organizationId, identityId, '2026-08-23T10:00:00.000Z')
}

const insertOperation = (
  organizationId: string,
  identityId: string,
  id: string,
  overrides: {
    readonly resourceType?: string
    readonly resourceId?: string
    readonly correlationId?: string
    readonly status?: string
  } = {},
): void => {
  database
    ?.prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status,
       progress, idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'audit.test', ?, ?, ?, ?, 100,
       ?, ?, 1, ?, ?)`)
    .run(
      id,
      organizationId,
      overrides.resourceType ?? 'game-server',
      overrides.resourceId ?? 'server-a',
      identityId,
      overrides.status ?? 'succeeded',
      `idempotency-${id}`,
      overrides.correlationId ?? 'correlation-a',
      '2026-08-23T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
    )
}

const envelope = (
  organizationId: string,
  operationId: string,
  overrides: Record<string, unknown> = {},
) => ({
  version: 1,
  captureStatus: 'complete',
  occurredAt: '2026-08-23T12:00:00.000Z',
  scope: 'tenant',
  organizationId,
  actor: { type: 'human', id: 'identity-a' },
  request: { id: 'request-a', correlationId: 'correlation-a' },
  action: 'server.update',
  target: { type: 'game-server', id: 'server-a' },
  before: { state: 'captured', summary: { desiredState: 'stopped' } },
  after: { state: 'captured', summary: { desiredState: 'running' } },
  operationId,
  source: {
    origin: 'http',
    ip: { state: 'captured', value: '203.0.113.7' },
    access: {
      state: 'captured',
      value: {
        subject: 'access-identity-a',
        identityId: 'identity-a',
        issuer: 'https://access.example.test',
        email: 'identity-a@example.test',
      },
    },
  },
  result: 'succeeded',
  error: { classification: 'none', code: null },
  forced: false,
  breakGlass: false,
  ...overrides,
})

const insertTenantAudit = (
  id: string,
  overrides: {
    readonly organizationId?: string
    readonly actorId?: string
    readonly action?: string
    readonly targetType?: string
    readonly targetId?: string
    readonly result?: string
    readonly correlationId?: string
    readonly summaryJson?: string
    readonly createdAt?: string
  } = {},
): void => {
  database
    ?.prepare(`INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      overrides.organizationId ?? 'org-a',
      overrides.actorId ?? 'identity-a',
      overrides.action ?? 'server.update',
      overrides.targetType ?? 'game-server',
      overrides.targetId ?? 'server-a',
      overrides.result ?? 'succeeded',
      overrides.correlationId ?? 'correlation-a',
      overrides.summaryJson ?? '{"desiredState":"running"}',
      overrides.createdAt ?? '2026-08-23T12:00:00.000Z',
    )
}

const insertPlatformOperation = (
  id: string,
  overrides: {
    readonly actorId?: string
    readonly resourceType?: string
    readonly resourceId?: string
    readonly correlationId?: string
    readonly status?: string
    readonly fingerprint?: string
  } = {},
): void => {
  database
    ?.prepare(`INSERT INTO platform_operations
      (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
       progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
      VALUES (?, 'platform', 'platform.image.promote', ?, ?, ?, ?, ?, 100, ?, ?, 1, ?, ?)`)
    .run(
      id,
      overrides.resourceType ?? 'node-image',
      overrides.resourceId ?? 'image-a',
      overrides.actorId ?? 'identity-a',
      overrides.correlationId ?? 'platform-correlation',
      overrides.status ?? 'succeeded',
      `idempotency-${id}`,
      overrides.fingerprint ?? 'a'.repeat(64),
      '2026-08-23T12:01:00.000Z',
      '2026-08-23T12:01:00.000Z',
    )
}

const platformEnvelope = (operationId: string, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  captureStatus: 'complete',
  occurredAt: '2026-08-23T12:01:00.000Z',
  scope: 'platform',
  organizationId: null,
  actor: { type: 'human', id: 'identity-a' },
  request: { id: 'platform-request-a', correlationId: 'platform-correlation' },
  action: 'platform.image.promote',
  target: { type: 'node-image', id: 'image-a' },
  before: { state: 'captured', summary: { channel: 'candidate' } },
  after: { state: 'captured', summary: { channel: 'stable' } },
  operationId,
  source: {
    origin: 'http',
    ip: { state: 'captured', value: '203.0.113.8' },
    access: {
      state: 'captured',
      value: {
        subject: 'access-identity-a',
        identityId: 'identity-a',
        issuer: 'https://access.example.test',
        email: 'identity-a@example.test',
      },
    },
  },
  result: 'succeeded',
  error: { classification: 'none', code: null },
  forced: false,
  breakGlass: false,
  ...overrides,
})

const insertPlatformAudit = (
  id: string,
  overrides: {
    readonly actorId?: string
    readonly action?: string
    readonly targetType?: string
    readonly targetId?: string
    readonly result?: string
    readonly correlationId?: string
    readonly summaryJson?: string
    readonly createdAt?: string
  } = {},
): void => {
  database
    ?.prepare(`INSERT INTO global_audit_events
      (id, scope, actor_id, action, target_type, target_id, result, correlation_id,
       summary_json, created_at)
      VALUES (?, 'platform', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      overrides.actorId ?? 'identity-a',
      overrides.action ?? 'platform.image.promote',
      overrides.targetType ?? 'node-image',
      overrides.targetId ?? 'image-a',
      overrides.result ?? 'succeeded',
      overrides.correlationId ?? 'platform-correlation',
      overrides.summaryJson ?? '{"channel":"stable"}',
      overrides.createdAt ?? '2026-08-23T12:01:00.000Z',
    )
}

const setupBeforeV1 = (): DatabaseSync => {
  const next = new DatabaseSync(':memory:')
  database = next
  for (const migration of beforeV1) apply(migration.file)
  seedTenant('org-a', 'identity-a')
  seedTenant('org-b', 'identity-b')
  return next
}

afterEach(() => {
  database?.close()
  database = undefined
})

describe('audit envelope v1 migration', () => {
  it('backfills explicit legacy envelopes and exports tenant and platform events without fake tenant ownership', () => {
    const target = setupBeforeV1()
    insertTenantAudit('audit-historical')
    target
      .prepare(`INSERT INTO global_audit_events
        (id, scope, actor_id, action, target_type, target_id, result, correlation_id,
         summary_json, created_at)
        VALUES ('platform-historical', 'platform', 'identity-a', 'platform.image.promote',
         'node-image', 'image-a', 'succeeded', 'platform-correlation', '{}',
         '2026-08-23T12:01:00.000Z')`)
      .run()

    apply(v1.file)

    expect(
      target
        .prepare(`SELECT scope, organization_id AS organizationId, schema_version AS version,
          capture_status AS captureStatus FROM audit_event_envelopes ORDER BY event_id`)
        .all(),
    ).toEqual([
      { scope: 'tenant', organizationId: 'org-a', version: 0, captureStatus: 'legacy' },
      { scope: 'platform', organizationId: null, version: 0, captureStatus: 'legacy' },
    ])
    const tenantPayload = JSON.parse(
      (
        target
          .prepare(
            `SELECT payload_json AS payload FROM outbox WHERE event_type = 'audit.export.requested'`,
          )
          .get() as { payload: string }
      ).payload,
    )
    expect(tenantPayload).toMatchObject({
      version: 1,
      scope: 'tenant',
      organizationId: 'org-a',
      admittedAt: '2026-08-23T12:00:00.000Z',
      envelope: { version: 0, captureStatus: 'legacy' },
    })
    const platformPayload = JSON.parse(
      (
        target
          .prepare(`SELECT payload_json AS payload FROM platform_audit_export_outbox`)
          .get() as { payload: string }
      ).payload,
    )
    expect(platformPayload).toMatchObject({
      version: 1,
      scope: 'platform',
      partitionKey: 'platform:audit',
      admittedAt: '2026-08-23T12:01:00.000Z',
      envelope: { version: 0, organizationId: null },
    })
    expect(platformPayload).not.toHaveProperty('organizationId')
  })

  it('keeps tenant and platform evidence distinct when independent audit tables reuse an event id', () => {
    const target = setupBeforeV1()
    insertTenantAudit('shared-audit-id')
    insertPlatformAudit('shared-audit-id')
    apply(v1.file)

    expect(
      target
        .prepare(`SELECT scope, organization_id AS organizationId
          FROM audit_event_envelopes WHERE event_id = 'shared-audit-id' ORDER BY scope`)
        .all(),
    ).toEqual([
      { scope: 'platform', organizationId: null },
      { scope: 'tenant', organizationId: 'org-a' },
    ])
  })

  it('requires a same-organization operation before a v1 envelope and atomically adopts a lost response replay', async () => {
    const target = setupBeforeV1()
    apply(v1.file)
    insertOperation('org-a', 'identity-a', 'operation-a')
    const stage = await Effect.runPromise(
      stageAuditEnvelope(
        'tenant',
        'audit-complete',
        envelope('org-a', 'operation-a'),
        '2026-08-23T12:00:00.000Z',
      ),
    )
    target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
    insertTenantAudit('audit-complete')

    expect(
      target
        .prepare(`SELECT schema_version AS version, capture_status AS captureStatus,
          json_extract(envelope_json, '$.operationId') AS operationId,
          json_extract(envelope_json, '$.source.ip.value') AS sourceIp
          FROM audit_event_envelopes WHERE event_id = 'audit-complete'`)
        .get(),
    ).toEqual({
      version: 1,
      captureStatus: 'complete',
      operationId: 'operation-a',
      sourceIp: '203.0.113.7',
    })
    expect(target.prepare('SELECT count(*) AS count FROM audit_envelope_staging').get()).toEqual({
      count: 0,
    })
    expect(
      target
        .prepare(`SELECT count(*) AS count FROM outbox WHERE event_type = 'audit.export.requested'`)
        .get(),
    ).toEqual({ count: 1 })

    target
      .prepare(`INSERT OR IGNORE INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES ('audit-complete', 'org-a', 'identity-a', 'server.update', 'game-server',
         'server-a', 'succeeded', 'correlation-a', '{"desiredState":"running"}',
         '2026-08-23T12:00:00.000Z')`)
      .run()
    expect(target.prepare('SELECT count(*) AS count FROM audit_event_envelopes').get()).toEqual({
      count: 1,
    })
    expect(target.prepare('SELECT count(*) AS count FROM audit_envelope_staging').get()).toEqual({
      count: 0,
    })
    expect(
      target
        .prepare(`SELECT count(*) AS count FROM outbox WHERE event_type = 'audit.export.requested'`)
        .get(),
    ).toEqual({ count: 1 })

    insertOperation('org-b', 'identity-b', 'operation-b')
    const crossTenant = await Effect.runPromise(
      stageAuditEnvelope(
        'tenant',
        'audit-cross-tenant',
        envelope('org-a', 'operation-b'),
        '2026-08-23T12:00:00.000Z',
      ),
    )
    expect(() =>
      target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(crossTenant)),
    ).toThrow(/audit envelope staging violates v1 policy/)
    expect(
      target
        .prepare("SELECT count(*) AS count FROM audit_events WHERE id = 'audit-cross-tenant'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('stages and exports a complete platform audit through a real platform operation without tenant ownership', async () => {
    const target = setupBeforeV1()
    apply(v1.file)
    insertPlatformOperation('platform-operation-a')
    const stage = await Effect.runPromise(
      stageAuditEnvelope(
        'platform',
        'platform-complete',
        platformEnvelope('platform-operation-a'),
        '2026-08-23T12:01:00.000Z',
      ),
    )
    target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
    insertPlatformAudit('platform-complete')

    expect(
      target
        .prepare(`SELECT scope, organization_id AS organizationId, schema_version AS version,
          capture_status AS captureStatus, json_extract(envelope_json, '$.operationId') AS operationId
          FROM audit_event_envelopes WHERE scope = 'platform' AND event_id = 'platform-complete'`)
        .get(),
    ).toEqual({
      scope: 'platform',
      organizationId: null,
      version: 1,
      captureStatus: 'complete',
      operationId: 'platform-operation-a',
    })
    const payload = JSON.parse(
      (
        target
          .prepare(
            `SELECT payload_json AS payload FROM platform_audit_export_outbox WHERE audit_event_id = 'platform-complete'`,
          )
          .get() as { payload: string }
      ).payload,
    )
    expect(payload).toMatchObject({
      version: 1,
      scope: 'platform',
      partitionKey: 'platform:audit',
      admittedAt: '2026-08-23T12:01:00.000Z',
      envelope: { version: 1, organizationId: null, operationId: 'platform-operation-a' },
    })
    expect(payload).not.toHaveProperty('organizationId')

    expect(() =>
      target
        .prepare(`INSERT INTO platform_audit_export_outbox
          (id, audit_event_id, payload_json, publish_state, retry_count, available_at, created_at)
          VALUES ('platform-audit-export-manual', 'platform-complete', '{}', 'pending', 0,
            '2026-08-23T12:01:00.000Z', '2026-08-23T12:01:00.000Z')`)
        .run(),
    ).toThrow(/platform audit export outbox identity is invalid/)

    target
      .prepare(`INSERT OR IGNORE INTO global_audit_events
        (id, scope, actor_id, action, target_type, target_id, result, correlation_id,
         summary_json, created_at)
        VALUES ('platform-complete', 'platform', 'identity-a', 'platform.image.promote',
         'node-image', 'image-a', 'succeeded', 'platform-correlation', '{"channel":"stable"}',
         '2026-08-23T12:01:00.000Z')`)
      .run()
    expect(
      target.prepare(`SELECT count(*) AS count FROM platform_audit_export_outbox`).get(),
    ).toEqual({ count: 1 })
  })

  it('rejects unrelated operations and any envelope facts that disagree with the authoritative audit row', async () => {
    const target = setupBeforeV1()
    apply(v1.file)
    insertOperation('org-a', 'identity-a', 'operation-match')

    const unrelatedOperationEnvelopes = [
      envelope('org-a', 'operation-match', {
        actor: { type: 'human', id: 'identity-b' },
        source: {
          origin: 'http',
          ip: { state: 'captured', value: '203.0.113.7' },
          access: {
            state: 'captured',
            value: {
              subject: 'access-identity-b',
              identityId: 'identity-b',
              issuer: 'https://access.example.test',
              email: 'identity-b@example.test',
            },
          },
        },
      }),
      envelope('org-a', 'operation-match', { target: { type: 'game-server', id: 'server-b' } }),
      envelope('org-a', 'operation-match', {
        request: { id: 'request-a', correlationId: 'correlation-b' },
      }),
      envelope('org-a', 'operation-match', {
        result: 'failed',
        error: { classification: 'provider', code: 'provider-rejected' },
      }),
    ]
    for (const [index, invalid] of unrelatedOperationEnvelopes.entries()) {
      const stage = await Effect.runPromise(
        stageAuditEnvelope(
          'tenant',
          `operation-mismatch-${index}`,
          invalid,
          '2026-08-23T12:00:00.000Z',
        ),
      )
      expect(() =>
        target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage)),
      ).toThrow(/audit envelope staging violates v1 policy/)
    }

    const expectAuthoritativeMismatch = async (
      id: string,
      auditOverrides: Parameters<typeof insertTenantAudit>[1],
    ): Promise<void> => {
      const stage = await Effect.runPromise(
        stageAuditEnvelope(
          'tenant',
          id,
          envelope('org-a', 'operation-match'),
          '2026-08-23T12:00:00.000Z',
        ),
      )
      target.exec('BEGIN')
      try {
        target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
        expect(() => insertTenantAudit(id, auditOverrides)).toThrow(
          /audit envelope does not match an authoritative audit event/,
        )
      } finally {
        target.exec('ROLLBACK')
      }
      expect(
        target.prepare(`SELECT count(*) AS count FROM audit_events WHERE id = ?`).get(id),
      ).toEqual({ count: 0 })
      expect(
        target
          .prepare(`SELECT count(*) AS count FROM audit_event_envelopes WHERE event_id = ?`)
          .get(id),
      ).toEqual({ count: 0 })
      expect(
        target
          .prepare(`SELECT count(*) AS count FROM audit_envelope_staging WHERE event_id = ?`)
          .get(id),
      ).toEqual({ count: 0 })
    }

    await expectAuthoritativeMismatch('audit-actor-mismatch', { actorId: 'identity-b' })
    await expectAuthoritativeMismatch('audit-action-mismatch', { action: 'server.delete' })
    await expectAuthoritativeMismatch('audit-target-type-mismatch', { targetType: 'backup' })
    await expectAuthoritativeMismatch('audit-target-id-mismatch', { targetId: 'server-b' })
    await expectAuthoritativeMismatch('audit-result-mismatch', { result: 'failed' })
    await expectAuthoritativeMismatch('audit-correlation-mismatch', {
      correlationId: 'correlation-b',
    })
    await expectAuthoritativeMismatch('audit-time-mismatch', {
      createdAt: '2026-08-23T12:00:01.000Z',
    })
    await expectAuthoritativeMismatch('audit-summary-mismatch', {
      summaryJson: '{"desiredState":"other"}',
    })
  })

  it('enforces canonical target names, terminal operations, typed unions, timestamps, and budgets for raw staging', async () => {
    const target = setupBeforeV1()
    apply(v1.file)
    insertOperation('org-a', 'identity-a', 'operation-raw')

    const rejectRawStage = (eventId: string, value: Record<string, unknown>): void => {
      expect(() =>
        target
          .prepare(auditEnvelopeStageSql)
          .run('tenant', eventId, 'org-a', JSON.stringify(value), '2026-08-23T12:00:00.000Z'),
      ).toThrow(/audit envelope staging violates v1 policy/)
    }

    rejectRawStage('audit-nonterminal-operation', {
      ...envelope('org-a', 'operation-raw'),
      operationId: 'operation-requested',
    })
    // The operation is deliberately added after the first check so the first
    // failure proves operation existence rather than status only.
    insertOperation('org-a', 'identity-a', 'operation-requested', { status: 'requested' })
    rejectRawStage('audit-requested-operation', envelope('org-a', 'operation-requested'))
    rejectRawStage('audit-spoofed-machine', {
      ...envelope('org-a', 'operation-raw'),
      actor: { type: 'machine', id: 'identity-a' },
    })
    rejectRawStage('audit-invalid-union', {
      ...envelope('org-a', 'operation-raw'),
      before: { state: 'captured', summary: {}, reason: 'must-not-exist' },
    })
    rejectRawStage('audit-unexpected-property', {
      ...envelope('org-a', 'operation-raw'),
      source: { ...envelope('org-a', 'operation-raw').source, untrusted: true },
    })
    rejectRawStage('audit-invalid-calendar', {
      ...envelope('org-a', 'operation-raw'),
      occurredAt: '2026-02-30T12:00:00.000Z',
    })
    rejectRawStage('audit-future-beyond-admission', {
      ...envelope('org-a', 'operation-raw'),
      occurredAt: '2026-08-23T12:05:00.001Z',
    })
    expect(() =>
      target.prepare(auditEnvelopeStageSql).run(
        'tenant',
        'audit-admission-boundary',
        'org-a',
        JSON.stringify({
          ...envelope('org-a', 'operation-raw'),
          occurredAt: '2026-08-23T12:05:00.000Z',
        }),
        '2026-08-23T12:00:00.000Z',
      ),
    ).not.toThrow()
    expect(() =>
      target.prepare(auditEnvelopeStageSql).run(
        'tenant',
        'audit-invalid-ip-evidence',
        'org-a',
        JSON.stringify({
          ...envelope('org-a', 'operation-raw'),
          source: {
            ...envelope('org-a', 'operation-raw').source,
            ip: { state: 'captured', value: '999.1.1.1' },
          },
        }),
        '2026-08-23T12:00:00.000Z',
      ),
    ).toThrow(/audit source IP is invalid/)
    expect(() =>
      target.prepare(auditEnvelopeStageSql).run(
        'tenant',
        'audit-ipv6-evidence',
        'org-a',
        JSON.stringify({
          ...envelope('org-a', 'operation-raw'),
          source: {
            ...envelope('org-a', 'operation-raw').source,
            ip: { state: 'captured', value: '::ffff:192.0.2.8' },
          },
        }),
        '2026-08-23T12:00:00.000Z',
      ),
    ).not.toThrow()
    rejectRawStage('audit-http-identity-spoof', {
      ...envelope('org-a', 'operation-raw'),
      source: {
        ...envelope('org-a', 'operation-raw').source,
        access: {
          state: 'captured',
          value: {
            subject: 'access-identity-a',
            identityId: 'identity-b',
            issuer: 'https://access.example.test',
            email: 'identity-a@example.test',
          },
        },
      },
    })
    rejectRawStage('audit-http-subject-spoof', {
      ...envelope('org-a', 'operation-raw'),
      source: {
        ...envelope('org-a', 'operation-raw').source,
        access: {
          state: 'captured',
          value: {
            subject: 'access-other',
            identityId: 'identity-a',
            issuer: 'https://access.example.test',
            email: 'identity-a@example.test',
          },
        },
      },
    })
    rejectRawStage('audit-http-email-spoof', {
      ...envelope('org-a', 'operation-raw'),
      source: {
        ...envelope('org-a', 'operation-raw').source,
        access: {
          state: 'captured',
          value: {
            subject: 'access-identity-a',
            identityId: 'identity-a',
            issuer: 'https://access.example.test',
            email: 'other@example.test',
          },
        },
      },
    })
    rejectRawStage('audit-machine-access-spoof', {
      ...envelope('org-a', 'operation-raw'),
      source: { ...envelope('org-a', 'operation-raw').source, origin: 'machine' },
    })
    rejectRawStage('audit-scheduler-ip-spoof', {
      ...envelope('org-a', 'operation-raw'),
      source: {
        origin: 'scheduler',
        ip: { state: 'captured', value: '203.0.113.7' },
        access: { state: 'not-available', reason: 'scheduler-has-no-access-session' },
      },
    })
    rejectRawStage('audit-scalar-overflow', {
      ...envelope('org-a', 'operation-raw'),
      after: { state: 'captured', summary: { detail: 'x'.repeat(32 * 1024 + 1) } },
    })
    rejectRawStage('audit-depth-overflow', {
      ...envelope('org-a', 'operation-raw'),
      after: {
        state: 'captured',
        summary: {
          one: {
            two: {
              three: {
                four: { five: { six: { seven: { eight: { nine: { ten: { eleven: {} } } } } } } },
              },
            },
          },
        },
      },
    })

    insertOperation('org-a', 'identity-a', 'operation-canonical-target', { resourceType: 'server' })
    const canonicalTargetStage = await Effect.runPromise(
      stageAuditEnvelope(
        'tenant',
        'audit-canonical-target',
        envelope('org-a', 'operation-canonical-target', {
          target: { type: 'server', id: 'server-a' },
        }),
        '2026-08-23T12:00:00.000Z',
      ),
    )
    target.exec('BEGIN')
    try {
      target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(canonicalTargetStage))
      expect(() =>
        insertTenantAudit('audit-canonical-target', { targetType: 'game_server' }),
      ).toThrow(/audit envelope does not match an authoritative audit event/)
    } finally {
      target.exec('ROLLBACK')
    }
  })

  it('fails closed for every post-migration direct tenant or platform audit write', () => {
    const target = setupBeforeV1()
    apply(v1.file)
    expect(() => insertTenantAudit('audit-direct')).toThrow(
      /audit event has no matching v1 envelope/,
    )
    expect(() => insertPlatformAudit('platform-direct')).toThrow(
      /platform audit event has no matching v1 envelope/,
    )
    expect(target.prepare(`SELECT count(*) AS count FROM audit_events`).get()).toEqual({ count: 0 })
    expect(target.prepare(`SELECT count(*) AS count FROM global_audit_events`).get()).toEqual({
      count: 0,
    })
    expect(target.prepare(`SELECT count(*) AS count FROM audit_event_envelopes`).get()).toEqual({
      count: 0,
    })
    expect(target.prepare(`SELECT count(*) AS count FROM audit_envelope_staging`).get()).toEqual({
      count: 0,
    })
    expect(target.prepare(`SELECT count(*) AS count FROM outbox`).get()).toEqual({ count: 0 })
    expect(target.prepare(`SELECT count(*) AS count FROM platform_operations`).get()).toEqual({
      count: 0,
    })
    expect(
      target.prepare(`SELECT count(*) AS count FROM platform_audit_export_outbox`).get(),
    ).toEqual({ count: 0 })
  })

  it('rejects recursive secret fields and protects event, envelope, and platform evidence from tampering', async () => {
    const target = setupBeforeV1()
    apply(v1.file)
    insertOperation('org-a', 'identity-a', 'operation-secret')
    const canary = 'gridora-audit-envelope-canary'
    const raw = envelope('org-a', 'operation-secret', {
      after: { state: 'captured', summary: { nested: { apiToken: canary } } },
    })
    expect(() =>
      target
        .prepare(auditEnvelopeStageSql)
        .run('tenant', 'audit-secret', 'org-a', JSON.stringify(raw), '2026-08-23T12:00:00.000Z'),
    ).toThrow(/audit envelope staging violates v1 policy/)
    expect(
      JSON.stringify(target.prepare('SELECT * FROM audit_envelope_staging').all()),
    ).not.toContain(canary)

    insertOperation('org-a', 'identity-a', 'operation-redacted')
    const redacted = envelope('org-a', 'operation-redacted', {
      after: {
        state: 'captured',
        summary: {
          ordinaryStatus: 'visible',
          credentialStatus: '[REDACTED]',
          nested: { apiTokenDigest: '[REDACTED]', passwordHash: '[REDACTED]' },
        },
      },
    })
    target
      .prepare(auditEnvelopeStageSql)
      .run(
        'tenant',
        'audit-redacted',
        'org-a',
        JSON.stringify(redacted),
        '2026-08-23T12:00:00.000Z',
      )
    insertTenantAudit('audit-redacted', {
      summaryJson: JSON.stringify({
        ordinaryStatus: 'visible',
        credentialStatus: '[REDACTED]',
        nested: { apiTokenDigest: '[REDACTED]', passwordHash: '[REDACTED]' },
      }),
    })

    const stage = await Effect.runPromise(
      stageAuditEnvelope(
        'tenant',
        'audit-immutable',
        envelope('org-a', 'operation-secret'),
        '2026-08-23T12:00:00.000Z',
      ),
    )
    target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
    insertTenantAudit('audit-immutable')
    expect(() =>
      target
        .prepare(
          `UPDATE audit_event_envelopes SET capture_status = 'partial' WHERE event_id = 'audit-immutable'`,
        )
        .run(),
    ).toThrow(/audit envelope is immutable/)
    expect(() =>
      target
        .prepare(`UPDATE audit_events SET action = 'tampered' WHERE id = 'audit-immutable'`)
        .run(),
    ).toThrow(/audit event is immutable/)
    insertPlatformOperation('platform-operation-immutable')
    const platformStage = await Effect.runPromise(
      stageAuditEnvelope(
        'platform',
        'platform-immutable',
        platformEnvelope('platform-operation-immutable'),
        '2026-08-23T12:01:00.000Z',
      ),
    )
    target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(platformStage))
    insertPlatformAudit('platform-immutable')
    expect(
      target
        .prepare(
          `SELECT id FROM platform_audit_export_outbox WHERE audit_event_id = 'platform-immutable'`,
        )
        .get(),
    ).toEqual({ id: 'platform-audit-export-00000000000000000001' })
    expect(() =>
      target
        .prepare(
          `UPDATE platform_audit_export_outbox SET payload_json = '{}' WHERE audit_event_id = 'platform-immutable'`,
        )
        .run(),
    ).toThrow(/platform audit export identity is immutable/)
    expect(() =>
      target
        .prepare(
          `DELETE FROM platform_audit_export_outbox WHERE audit_event_id = 'platform-immutable'`,
        )
        .run(),
    ).toThrow(/platform audit export outbox is immutable/)
  })
})

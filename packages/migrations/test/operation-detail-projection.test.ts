import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
let database: DatabaseSync

const now = '2026-08-23T12:00:00.000Z'

const applyMigrations = () => {
  for (const migration of migrations)
    database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
}

const seedOperation = (organizationId: string, operationId: string) => {
  const identityId = `identity-${organizationId}`
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?) `)
    .run(identityId, `access-${identityId}`, `${identityId}@example.com`, identityId, now, now)
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'organization', 1, 1, ?) `)
    .run(organizationId, organizationId, organizationId, now)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES (?, ?, 'owner', 'active', ?, NULL, 1)`)
    .run(organizationId, identityId, now)
  database
    .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status,
       progress, idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'server.start', 'game-server', 'server-01', ?, 'running',
       10, ?, ?, 1, ?, ?) `)
    .run(
      operationId,
      organizationId,
      identityId,
      `idempotency-${operationId}`,
      `correlation-${operationId}`,
      now,
      now,
    )
}

describe('operation detail projection migration', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    applyMigrations()
  })

  afterEach(() => database.close())

  it('projects only real workflow steps, retries, terminal resources, audit logs, and tenant scope', async () => {
    seedOperation('org-a', 'operation-a')
    seedOperation('org-b', 'operation-b')

    expect(
      database
        .prepare(`SELECT retry_count AS retryCount, recovery_code AS recoveryCode
          FROM operation_detail_projection
          WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
        .get(),
    ).toEqual({ retryCount: 0, recoveryCode: 'none' })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operation_detail_steps
          WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
        .get(),
    ).toEqual({ count: 0 })

    database
      .prepare(`INSERT INTO game_command_deliveries
        (organization_id, operation_id, command_id, step_name, command_fingerprint,
         state, attempts, created_at, updated_at, command_json)
        VALUES ('org-a', 'operation-a', 'command-a', 'start-container', ?,
         'pending', 0, ?, ?, ?) `)
      .run(
        'a'.repeat(64),
        now,
        now,
        JSON.stringify({
          commandId: 'command-a',
          operationId: 'operation-a',
          organizationId: 'org-a',
        }),
      )
    database
      .prepare(`UPDATE game_command_deliveries
        SET state = 'failed', attempts = 3, updated_at = '2026-08-23T12:01:00.000Z'
        WHERE organization_id = 'org-a' AND operation_id = 'operation-a'
          AND step_name = 'start-container'`)
      .run()

    expect(
      database
        .prepare(`SELECT label, state, attempt, completed_at AS completedAt
          FROM operation_detail_steps
          WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
        .get(),
    ).toEqual({
      label: 'start-container',
      state: 'failed',
      attempt: 3,
      completedAt: '2026-08-23T12:01:00.000Z',
    })
    expect(
      database
        .prepare(`SELECT retry_count AS retryCount, waiting_reason AS waitingReason
          FROM operation_detail_projection
          WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
        .get(),
    ).toEqual({ retryCount: 2, waitingReason: 'game-command-failed' })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operation_detail_steps
          WHERE organization_id = 'org-b' AND operation_id = 'operation-b'`)
        .get(),
    ).toEqual({ count: 0 })

    database
      .prepare(`UPDATE operations
        SET status = 'succeeded', progress = 100, updated_at = '2026-08-23T12:02:00.000Z'
        WHERE organization_id = 'org-a' AND id = 'operation-a'`)
      .run()
    expect(
      database
        .prepare(`SELECT final_resource_type AS finalResourceType,
            final_resource_id AS finalResourceId, recovery_code AS recoveryCode
          FROM operation_detail_projection
          WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
        .get(),
    ).toEqual({
      finalResourceType: 'game-server',
      finalResourceId: 'server-01',
      recoveryCode: 'none',
    })

    const auditEnvelope = await Effect.runPromise(
      stageAuditEnvelope(
        'tenant',
        'audit-operation-a',
        {
          version: 1,
          captureStatus: 'complete',
          occurredAt: '2026-08-23T12:02:00.000Z',
          scope: 'tenant',
          organizationId: 'org-a',
          actor: { type: 'human', id: 'identity-org-a' },
          request: {
            id: 'request-operation-a',
            correlationId: 'correlation-operation-a',
          },
          action: 'server.start.completed',
          target: { type: 'game-server', id: 'server-01' },
          before: { state: 'captured', summary: { status: 'running' } },
          after: {
            state: 'captured',
            summary: { status: 'succeeded', operationId: 'operation-a' },
          },
          operationId: 'operation-a',
          source: {
            origin: 'http',
            ip: { state: 'captured', value: '203.0.113.7' },
            access: {
              state: 'captured',
              value: {
                subject: 'access-identity-org-a',
                identityId: 'identity-org-a',
                issuer: 'https://access.example.test',
                email: 'identity-org-a@example.com',
              },
            },
          },
          result: 'succeeded',
          error: { classification: 'none', code: null },
          forced: false,
          breakGlass: false,
        },
        '2026-08-23T12:02:00.000Z',
      ),
    )
    database.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(auditEnvelope))
    database
      .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES ('audit-operation-a', 'org-a', 'identity-org-a', 'server.start.completed',
          'game-server', 'server-01', 'succeeded', 'correlation-operation-a', ?,
          '2026-08-23T12:02:00.000Z')`)
      .run(JSON.stringify({ status: 'succeeded', operationId: 'operation-a' }))
    expect(
      database
        .prepare(`SELECT action, result, created_at AS createdAt
          FROM operation_detail_log_events
          WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
        .get(),
    ).toEqual({
      action: 'server.start.completed',
      result: 'succeeded',
      createdAt: '2026-08-23T12:02:00.000Z',
    })
  })
})

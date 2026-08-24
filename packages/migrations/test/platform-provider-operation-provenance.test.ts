import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import { migrations } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
const now = '2026-08-24T00:00:00.000Z'
const beforeProvenance = migrations.filter((migration) => migration.id < 53)
const provenance = migrations.find((migration) => migration.id === 53)
if (provenance === undefined)
  throw new Error('platform provider provenance migration is not registered')

let database: DatabaseSync | undefined

const apply = (file: string): void => database?.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))

const seed = (): void => {
  database
    ?.prepare(`INSERT INTO identities
      (id,access_subject,email,display_name,status,signed_up_at,last_login_at)
      VALUES ('identity-a','access-identity-a','identity-a@example.test','A','active',?,?)`)
    .run(now, now)
  database
    ?.prepare(`INSERT INTO provider_accounts
      (id,scope,organization_id,provider_type,credential_reference,status,revision,created_at,updated_at)
      VALUES ('platform-ovh','platform',NULL,'ovhcloud','platform-ovh.credentials','active',1,?,?)`)
    .run(now, now)
  database
    ?.prepare(`INSERT INTO platform_secret_envelopes
      (id,scope_type,scope_id,ciphertext,wrapped_data_key,key_version,revision,created_at,rotated_at)
      VALUES ('platform-ovh.credentials','provider-account','platform-ovh','ciphertext','wrapped',1,1,?,NULL)`)
    .run(now)
}

const insertAuditedOperation = async (input: {
  readonly operationId: string
  readonly operationIdempotencyKey: string
  readonly requestFingerprint: string
  readonly auditEventId: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
}): Promise<void> => {
  const target = database
  if (target === undefined) throw new Error('database is unavailable')
  const correlationId = `correlation-${input.operationId}`
  target
    .prepare(`INSERT INTO platform_operations
      (id,scope,type,resource_type,resource_id,actor_id,correlation_id,status,progress,
       idempotency_key,payload_fingerprint,revision,created_at,updated_at)
      VALUES (?,'platform',?,?,?,?,?,'succeeded',100,?,?,1,?,?)`)
    .run(
      input.operationId,
      input.action,
      input.targetType,
      input.targetId,
      'identity-a',
      correlationId,
      input.operationIdempotencyKey,
      input.requestFingerprint,
      now,
      now,
    )
  const envelope = await Effect.runPromise(
    completeAuditEnvelope({
      occurredAt: now,
      scope: 'platform',
      organizationId: null,
      actor: { type: 'human', id: 'identity-a' },
      action: input.action,
      target: { type: input.targetType, id: input.targetId },
      before: { state: 'absent', reason: 'resource did not exist' },
      after: { state: 'captured', summary: { resourceId: input.targetId, status: 'accepted' } },
      operationId: input.operationId,
      request: {
        origin: 'http',
        requestId: `request-${input.operationId}`,
        correlationId,
        source: {
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
      },
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }),
  )
  const stage = await Effect.runPromise(
    stageAuditEnvelope('platform', input.auditEventId, envelope, now),
  )
  target.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
  target
    .prepare(`INSERT INTO global_audit_events
      (id,scope,actor_id,action,target_type,target_id,result,correlation_id,summary_json,created_at)
      VALUES (?,'platform','identity-a',?,?,?,?,?,?,?)`)
    .run(
      input.auditEventId,
      input.action,
      input.targetType,
      input.targetId,
      'succeeded',
      correlationId,
      auditEventSummaryJson(envelope),
      now,
    )
}

afterEach(() => {
  database?.close()
  database = undefined
})

describe('platform provider operation provenance migration', () => {
  it('preserves legacy receipts while requiring immutable exact v1 operation and audit provenance for new ones', async () => {
    database = new DatabaseSync(':memory:')
    for (const migration of beforeProvenance) apply(migration.file)
    seed()
    const target = database

    await insertAuditedOperation({
      operationId: 'legacy-platform-provider-operation',
      operationIdempotencyKey: '1'.repeat(64),
      requestFingerprint: '2'.repeat(64),
      auditEventId: 'legacy-platform-provider-audit',
      action: 'platform.provider-account.create',
      targetType: 'provider-account',
      targetId: 'platform-ovh',
    })
    target
      .prepare(`INSERT INTO platform_provider_mutations
        (idempotency_key,action,account_id,actor_id,request_fingerprint,expected_revision,result_revision,
         response_json,audit_event_id,created_at)
        VALUES ('legacy-provider-receipt','create','platform-ovh','identity-a',?,0,1,?,
          'legacy-platform-provider-audit',?)`)
      .run('2'.repeat(64), JSON.stringify({ status: 'active', credentialRevision: 1 }), now)

    apply(provenance.file)

    expect(
      target
        .prepare(`SELECT operation_id AS operationId, operation_idempotency_key AS operationIdempotencyKey
          FROM platform_provider_mutations WHERE idempotency_key = 'legacy-provider-receipt'`)
        .get(),
    ).toEqual({ operationId: null, operationIdempotencyKey: null })

    await insertAuditedOperation({
      operationId: 'strict-platform-provider-operation',
      operationIdempotencyKey: '3'.repeat(64),
      requestFingerprint: '4'.repeat(64),
      auditEventId: 'strict-platform-provider-audit',
      action: 'platform.provider-account.create',
      targetType: 'provider-account',
      targetId: 'platform-ovh',
    })
    expect(() =>
      target
        .prepare(`INSERT INTO platform_provider_mutations
          (idempotency_key,action,account_id,actor_id,request_fingerprint,expected_revision,result_revision,
           response_json,audit_event_id,operation_id,operation_idempotency_key,created_at)
          VALUES ('missing-operation','create','platform-ovh','identity-a',?,0,1,?,
            'strict-platform-provider-audit',NULL,NULL,?)`)
        .run('4'.repeat(64), JSON.stringify({ status: 'active', credentialRevision: 1 }), now),
    ).toThrow(/platform provider mutation requires exact v1 operation and audit provenance/)

    database
      .prepare(`INSERT INTO platform_provider_mutations
        (idempotency_key,action,account_id,actor_id,request_fingerprint,expected_revision,result_revision,
         response_json,audit_event_id,operation_id,operation_idempotency_key,created_at)
        VALUES ('strict-provider-receipt','create','platform-ovh','identity-a',?,0,1,?,
          'strict-platform-provider-audit','strict-platform-provider-operation',?,?)`)
      .run(
        '4'.repeat(64),
        JSON.stringify({ status: 'active', credentialRevision: 1 }),
        '3'.repeat(64),
        now,
      )

    expect(() =>
      target
        .prepare(`UPDATE platform_provider_mutations
          SET operation_id = 'replacement-operation'
          WHERE idempotency_key = 'strict-provider-receipt'`)
        .run(),
    ).toThrow(/platform provider mutation audit provenance is immutable/)
  })
})

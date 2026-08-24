import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { OperationDetailRepository } from '@gridora/db-contracts'
import { OperationId, OrganizationContext } from '@gridora/domain'
import { migrations } from '@gridora/migrations'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeD1RepositoriesLayer,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
let database: DatabaseSync

class SqliteStatement implements D1PreparedStatementLike {
  constructor(
    readonly sql: string,
    readonly values: ReadonlyArray<unknown> = [],
  ) {}

  bind(...values: ReadonlyArray<unknown>): D1PreparedStatementLike {
    return new SqliteStatement(this.sql, values)
  }

  async first(): Promise<unknown> {
    return database.prepare(this.sql).get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }

  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return {
      results: database.prepare(this.sql).all(...(this.values as ReadonlyArray<SQLInputValue>)),
    }
  }

  async run(): Promise<D1ResultLike> {
    const result = database.prepare(this.sql).run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const adapter: D1DatabaseLike = {
  prepare: (sql) => new SqliteStatement(sql),
  batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
}

const context = (organizationId: string, slug: string) =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: slug,
    identityId: `identity-${organizationId}`,
    role: 'owner',
    correlationId: `correlation-${organizationId}`,
  })

const operationId = (value: string) => Schema.decodeUnknownSync(OperationId)(value)

const seedTenantOperation = (organizationId: string, slug: string, operationId: string) => {
  const now = '2026-08-23T12:00:00.000Z'
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
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?) `)
    .run(organizationId, organizationId, slug, now)
  database
    .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status,
       progress, idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'retire-node', 'node', 'node-a', ?, 'waiting_external',
       60, ?, ?, 3, ?, ?) `)
    .run(
      operationId,
      organizationId,
      identityId,
      `idempotency-${operationId}`,
      `correlation-${operationId}`,
      now,
      '2026-08-23T12:01:00.000Z',
    )
}

describe('operation detail D1 repository', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
    seedTenantOperation('org-a', 'organization-a', 'operation-a')
    seedTenantOperation('org-b', 'organization-b', 'operation-b')
    database
      .prepare(`INSERT INTO operation_detail_steps
        (organization_id, operation_id, source_type, source_key, sequence, label, state,
         attempt, started_at, completed_at, updated_at)
        VALUES ('org-a', 'operation-a', 'node-runtime', 'retire', 0, 'retire', 'running',
         2, '2026-08-23T12:00:10.000Z', NULL, '2026-08-23T12:00:30.000Z')`)
      .run()
    database
      .prepare(`UPDATE operation_detail_projection
        SET retry_count = 1, waiting_reason = 'provider-reconciliation-required',
          provider_reference_hint = 'abcd...wxyz'
        WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
      .run()
  })

  afterEach(() => database.close())

  it('returns bounded persisted facts and no manufactured logs or retry action', async () => {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* OperationDetailRepository
        return yield* repository.get(context('org-a', 'organization-a'), operationId('operation-a'))
      }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
    )

    expect(detail).toMatchObject({
      id: 'operation-a',
      organizationId: 'org-a',
      retryCount: 1,
      waitingReason: 'provider-reconciliation-required',
      providerReferenceHint: 'abcd...wxyz',
      cancellable: false,
      recovery: { code: 'wait-for-external-evidence', retryAction: null },
      finalResource: null,
      steps: [{ key: 'node-runtime:retire', label: 'retire', attempt: 2 }],
      logs: [],
    })
  })

  it('does not return another organization operation', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const repository = yield* OperationDetailRepository
          return yield* repository.get(
            context('org-a', 'organization-a'),
            operationId('operation-b'),
          )
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      ),
    )
    expect(result._tag).toBe('Failure')
  })

  it('returns only the newest 100 persisted logs in chronological display order', async () => {
    database.exec('PRAGMA foreign_keys = OFF')
    const insert = database.prepare(`INSERT INTO operation_detail_log_events
      (organization_id, operation_id, audit_event_id, action, result, created_at)
      VALUES ('org-a', 'operation-a', ?, ?, 'succeeded', ?)`)
    for (let index = 0; index < 105; index += 1) {
      const suffix = String(index).padStart(3, '0')
      insert.run(
        `audit-${suffix}`,
        `action-${suffix}`,
        new Date(Date.parse('2026-08-23T13:00:00.000Z') + index * 1_000).toISOString(),
      )
    }
    database.exec('PRAGMA foreign_keys = ON')

    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* OperationDetailRepository
        return yield* repository.get(context('org-a', 'organization-a'), operationId('operation-a'))
      }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
    )

    expect(detail.logs).toHaveLength(100)
    expect(detail.logs[0]?.id).toBe('audit-005')
    expect(detail.logs.at(-1)?.id).toBe('audit-104')
    const timestamps = detail.logs.map((log) => log.createdAt)
    expect(timestamps).toEqual(timestamps.toSorted())
  })

  it('clears a stale waiting reason when the operation becomes terminal', async () => {
    database
      .prepare(`UPDATE operations SET status = 'succeeded', progress = 100,
        revision = revision + 1, updated_at = '2026-08-23T12:02:00.000Z'
        WHERE organization_id = 'org-a' AND id = 'operation-a'`)
      .run()
    const row = database
      .prepare(`SELECT waiting_reason AS waitingReason, recovery_code AS recoveryCode,
        final_resource_id AS finalResourceId FROM operation_detail_projection
        WHERE organization_id = 'org-a' AND operation_id = 'operation-a'`)
      .get()
    expect(row).toEqual({
      waitingReason: null,
      recoveryCode: 'none',
      finalResourceId: 'node-a',
    })
  })
})

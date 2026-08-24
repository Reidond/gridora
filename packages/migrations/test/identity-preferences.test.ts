import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../src/index.js'

const sqlDirectory = new URL('../sql/', import.meta.url)
let database: DatabaseSync

describe('identity preference and platform identity receipts', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of migrations)
      database.exec(readFileSync(new URL(migration.file, sqlDirectory), 'utf8'))
    database.exec(`
      INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('identity-a', 'access-a', 'a@example.com', 'A', 'active', '2026-08-23T12:00:00Z', '2026-08-23T12:00:00Z');
      INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
        VALUES ('org-a', 'A', 'organization-a', 'active', 'UTC', 'eu', 'complete', 1, 1, '2026-08-23T12:00:00Z');
      INSERT INTO platform_operations
        (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
         progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
        VALUES ('operation-sign-up', 'platform', 'identity.sign-up', 'identity', 'identity-a',
          'identity-a', 'correlation-a', 'succeeded', 100, '${'e'.repeat(64)}', '${'a'.repeat(64)}',
          1, '2026-08-23T12:00:00Z', '2026-08-23T12:00:00Z');
    `)
  })
  afterEach(() => database.close())

  it('fences preference revisions and organization references', () => {
    database
      .prepare(`INSERT INTO identity_preferences
      (identity_id, last_organization_id, revision, updated_at) VALUES (?, ?, 1, ?)`)
      .run('identity-a', 'org-a', '2026-08-23T12:00:00Z')
    expect(() =>
      database
        .prepare('UPDATE identity_preferences SET revision = 3 WHERE identity_id = ?')
        .run('identity-a'),
    ).toThrow(/identity preference revision must advance exactly once/)
    expect(() =>
      database
        .prepare(`INSERT INTO identity_preferences
        (identity_id, last_organization_id, revision, updated_at) VALUES (?, ?, 1, ?)`)
        .run('identity-missing', 'org-a', '2026-08-23T12:00:00Z'),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('bounds keys and rejects a response that does not match its operation', () => {
    const insert = (key: string, response: object) =>
      database
        .prepare(`INSERT INTO platform_identity_mutation_receipts
        (access_subject, action, idempotency_key, payload_fingerprint, operation_id,
         identity_id, result_json, response_json, created_at)
        VALUES (?, 'identity.sign-up', ?, ?, 'operation-sign-up', 'identity-a', '{}', ?, ?)`)
        .run('access-a', key, 'a'.repeat(64), JSON.stringify(response), '2026-08-23T12:00:00Z')

    const validResponse = {
      operationId: 'operation-sign-up',
      resourceId: 'identity-a',
      status: 'succeeded',
      links: { operation: '/v1/platform/operations/operation-sign-up' },
    }
    expect(() => insert('1234567', validResponse)).toThrow(/CHECK constraint failed/)
    expect(() =>
      insert('12345678', {
        operationId: 'wrong-operation',
        resourceId: 'identity-a',
        status: 'succeeded',
        links: { operation: '/v1/platform/operations/wrong-operation' },
      }),
    ).toThrow(/platform identity mutation response does not match operation/)
    expect(() => insert('k'.repeat(255), validResponse)).not.toThrow()
    expect(() => insert('z'.repeat(256), validResponse)).toThrow(/CHECK constraint failed/)
  })
})

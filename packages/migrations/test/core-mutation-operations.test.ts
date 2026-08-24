import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
const now = '2026-08-23T12:00:00.000Z'
let database: DatabaseSync

const seed = (): void => {
  database.exec(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES
      ('identity-a', 'access-a', 'a@example.test', 'A', 'active', '${now}', '${now}'),
      ('identity-b', 'access-b', 'b@example.test', 'B', 'active', '${now}', '${now}');
    INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step,
     policy_revision, revision, created_at)
    VALUES ('org-a', 'A', 'org-a', 'active', 'UTC', 'eu-west', 'provider', 1, 1, '${now}');
    INSERT INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, invited_by, revision)
    VALUES
      ('org-a', 'identity-a', 'owner', 'active', '${now}', NULL, 1),
      ('org-a', 'identity-b', 'viewer', 'active', '${now}', 'identity-a', 1);`)
}

const operation = (id: string, actor: string, action: string, resourceId: string): void => {
  database
    .prepare(`INSERT INTO operations
    (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
     idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES (?, 'org-a', ?, 'organization_membership', ?, ?, 'succeeded', 100,
      ?, ?, 1, ?, ?)`)
    .run(id, action, resourceId, actor, `scoped-${id}`, `correlation-${id}`, now, now)
}

const receipt = (input: {
  id: string
  actor?: string
  action?: string
  key: string
  resourceId?: string
  response?: object
}): void => {
  const actor = input.actor ?? 'identity-a'
  const action = input.action ?? 'organization.membership.role.update'
  const resourceId = input.resourceId ?? 'identity-b'
  operation(input.id, actor, action, resourceId)
  const response = input.response ?? {
    operationId: input.id,
    resourceId,
    status: 'succeeded',
    links: { operation: `/v1/organizations/org-a/operations/${input.id}` },
  }
  database
    .prepare(`INSERT INTO core_mutation_receipts
    (organization_id, actor_id, action, idempotency_key, payload_fingerprint,
     operation_id, resource_type, resource_id, result_json, response_json, created_at)
    VALUES ('org-a', ?, ?, ?, ?, ?, 'organization_membership', ?, 'null', ?, ?)`)
    .run(
      actor,
      action,
      input.key,
      'a'.repeat(64),
      input.id,
      resourceId,
      JSON.stringify(response),
      now,
    )
}

describe('core mutation operation receipts', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
    seed()
  })
  afterEach(() => database.close())

  it('accepts the public idempotency-key boundaries and rejects values outside them', () => {
    expect(() => receipt({ id: 'op-min', key: '12345678' })).not.toThrow()
    expect(() =>
      receipt({ id: 'op-max', key: 'x'.repeat(255), action: 'organization.membership.remove' }),
    ).not.toThrow()
    expect(() =>
      receipt({ id: 'op-short', key: '1234567', action: 'organization.membership.leave' }),
    ).toThrow()
    expect(() =>
      receipt({ id: 'op-long', key: 'x'.repeat(256), action: 'organization.invitation.revoke' }),
    ).toThrow()
  })

  it('scopes the same raw key by actor and action and retains history after membership removal', () => {
    receipt({ id: 'op-a', key: 'same-key', actor: 'identity-a' })
    receipt({ id: 'op-b', key: 'same-key', actor: 'identity-b' })
    receipt({
      id: 'op-c',
      key: 'same-key',
      actor: 'identity-a',
      action: 'organization.membership.remove',
    })
    database
      .prepare(
        "DELETE FROM organization_memberships WHERE organization_id = 'org-a' AND identity_id = 'identity-b'",
      )
      .run()
    expect(database.prepare('SELECT COUNT(*) AS count FROM core_mutation_receipts').get()).toEqual({
      count: 3,
    })
  })

  it('rejects a canonical response that does not match the referenced operation', () => {
    expect(() =>
      receipt({
        id: 'op-tampered',
        key: 'tampered-key',
        response: {
          operationId: 'op-other',
          resourceId: 'identity-b',
          status: 'succeeded',
          links: { operation: '/v1/organizations/org-a/operations/op-other' },
        },
      }),
    ).toThrow(/response does not match operation/)
  })
})

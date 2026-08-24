import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MembershipSql } from '../src/index.js'

let database: DatabaseSync
const migrationFiles = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0026_organization_membership_leave.sql',
]
const migrationDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))

const membershipRole = (identityId: string) =>
  database
    .prepare(
      "SELECT role FROM organization_memberships WHERE organization_id = 'org-a' AND identity_id = ?",
    )
    .get(identityId) as { role: string }

describe('membership SQL race guards', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles)
      database.exec(readFileSync(`${migrationDirectory}${file}`, 'utf8'))
    for (const id of ['owner-a', 'member-b', 'member-c']) {
      database
        .prepare(`INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES (?, ?, ?, ?, 'active', 'now', 'now')`)
        .run(id, `access-${id}`, `${id}@example.com`, id)
    }
    database
      .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu', 'organization', 1, 1, 'now')`)
      .run()
    database
      .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision) VALUES
      ('org-a', 'owner-a', 'owner', 'active', 'now', 1),
      ('org-a', 'member-b', 'administrator', 'active', 'now', 1),
      ('org-a', 'member-c', 'administrator', 'active', 'now', 1)`)
      .run()
  })
  afterEach(() => database.close())

  it('atomically rejects demotion of the final active Owner', () => {
    const result = database
      .prepare(MembershipSql.updateRole)
      .run('administrator', 'org-a', 'owner-a', 1, 'administrator', 'org-a')
    expect(result.changes).toBe(0)
    expect(membershipRole('owner-a').role).toBe('owner')
  })

  it('a stale concurrent ownership transfer cannot create another Owner', () => {
    const first = database
      .prepare(MembershipSql.transferOwnership)
      .run('owner-a', 'org-a', 'owner-a', 'member-b', 'org-a', 'owner-a', 'owner-a', 'member-b')
    const stale = database
      .prepare(MembershipSql.transferOwnership)
      .run('owner-a', 'org-a', 'owner-a', 'member-c', 'org-a', 'owner-a', 'owner-a', 'member-c')

    expect(first.changes).toBe(2)
    expect(stale.changes).toBe(0)
    expect(membershipRole('owner-a').role).toBe('administrator')
    expect(membershipRole('member-b').role).toBe('owner')
    expect(membershipRole('member-c').role).toBe('administrator')
  })

  it('does not demote the Owner when the transfer target is the same identity', () => {
    const result = database
      .prepare(MembershipSql.transferOwnership)
      .run('owner-a', 'org-a', 'owner-a', 'owner-a', 'org-a', 'owner-a', 'owner-a', 'owner-a')

    expect(result.changes).toBe(0)
    expect(membershipRole('owner-a').role).toBe('owner')
  })

  it('atomically records a self-leave with its outbox and audit evidence', () => {
    const leave = database
      .prepare(MembershipSql.leave)
      .run('correlation-leave', 'event-leave', '2026-08-23T12:00:00.000Z', 'org-a', 'member-b', 1)
    expect(leave.changes).toBe(1)
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id = 'org-a' AND identity_id = 'member-b'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(
          "SELECT event_type AS eventType, aggregate_id AS aggregateId FROM outbox WHERE id = 'event-leave'",
        )
        .get(),
    ).toEqual({ eventType: 'organization.membership.left', aggregateId: 'member-b' })
    expect(
      database
        .prepare(
          "SELECT actor_id AS actorId, action, result FROM audit_events WHERE id = 'audit-event-leave'",
        )
        .get(),
    ).toEqual({
      actorId: 'member-b',
      action: 'organization.membership.leave',
      result: 'succeeded',
    })
  })

  it('protects the final Owner and rejects stale leave revisions without partial evidence', () => {
    const finalOwner = database
      .prepare(MembershipSql.leave)
      .run('correlation-owner', 'event-owner', '2026-08-23T12:00:00.000Z', 'org-a', 'owner-a', 1)
    const stale = database
      .prepare(MembershipSql.leave)
      .run('correlation-stale', 'event-stale', '2026-08-23T12:00:00.000Z', 'org-a', 'member-c', 2)
    expect(finalOwner.changes).toBe(0)
    expect(stale.changes).toBe(0)
    expect(membershipRole('owner-a').role).toBe('owner')
    expect(membershipRole('member-c').role).toBe('administrator')
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE id IN ('event-owner', 'event-stale')")
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE id IN ('audit-event-owner', 'audit-event-stale')",
        )
        .get(),
    ).toEqual({ count: 0 })
  })
})

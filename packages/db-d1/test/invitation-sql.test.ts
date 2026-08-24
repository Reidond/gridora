import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvitationAcceptanceSql } from '../src/index.js'

let database: DatabaseSync
const migration = fileURLToPath(
  new URL('../../migrations/sql/0001_identity_organizations.sql', import.meta.url),
)

const accept = (identityId: string) => {
  const membership = database
    .prepare(InvitationAcceptanceSql.insertMembership)
    .run(identityId, '2026-08-23T12:00:00Z', 'org-a', 'invite-a', '2026-08-23T12:00:00Z')
  const invitation = database
    .prepare(InvitationAcceptanceSql.acceptInvitation)
    .run(identityId, 'org-a', 'invite-a', '2026-08-23T12:00:00Z')
  return { membership, invitation }
}

describe('invitation acceptance SQL race guards', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec(readFileSync(migration, 'utf8'))
    for (const id of ['owner-a', 'invitee-a', 'new-member']) {
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
      ('org-a', 'invitee-a', 'owner', 'active', 'now', 1)`)
      .run()
    database
      .prepare(`INSERT INTO organization_invitations
      (id, organization_id, email, role, token_hash, expires_at, inviter_id, status, created_at, revision)
      VALUES ('invite-a', 'org-a', 'invitee-a@example.com', 'viewer', 'hash-a',
       '2026-08-24T12:00:00Z', 'owner-a', 'pending', 'now', 1)`)
      .run()
  })
  afterEach(() => database.close())

  it('does not overwrite the role of an existing member', () => {
    const result = accept('invitee-a')

    expect(result.membership.changes).toBe(0)
    expect(result.invitation.changes).toBe(0)
    expect(
      database
        .prepare(`SELECT role FROM organization_memberships
          WHERE organization_id = 'org-a' AND identity_id = 'invitee-a'`)
        .get(),
    ).toEqual({ role: 'owner' })
    expect(
      database.prepare("SELECT status FROM organization_invitations WHERE id = 'invite-a'").get(),
    ).toEqual({ status: 'pending' })
  })

  it('accepts once and rejects a replay', () => {
    database
      .prepare(
        "UPDATE organization_invitations SET email = 'new-member@example.com' WHERE id = 'invite-a'",
      )
      .run()

    const first = accept('new-member')
    const replay = accept('new-member')

    expect(first.membership.changes).toBe(1)
    expect(first.invitation.changes).toBe(1)
    expect(replay.membership.changes).toBe(0)
    expect(replay.invitation.changes).toBe(0)
  })
})

import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentRegistrationRepository,
  OrganizationInvitationRepository,
  OrganizationMembershipRepository,
  OrganizationRepository,
  OutboxRepository,
} from '@gridora/db-contracts'
import {
  IdentityId,
  IdempotencyKey,
  InvitationId,
  IsoDateTime,
  OperationId,
  OrganizationContext,
  OrganizationId,
  OutboxEventId,
} from '@gridora/domain'
import {
  makeD1RepositoriesLayer,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/index.js'

let database: DatabaseSync
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
  '0007_audit_export_outbox.sql',
  '0008_tunnel_credential_delivery.sql',
  '0009_orphan_findings.sql',
  '0010_backup_wrapped_keys.sql',
  '0011_provider_account_lifecycle.sql',
  '0012_node_provision_acceptance.sql',
  '0013_server_plan.sql',
  '0014_agent_observation_ingestion.sql',
  '0015_node_provision_execution_lease.sql',
  '0016_platform_provider_control.sql',
  '0017_game_server_lifecycle_execution.sql',
  '0018_backup_orchestration.sql',
  '0019_destructive_lifecycle_termination.sql',
  '0020_logs_health_aggregates.sql',
  '0021_scheduled_orphan_reconciliation.sql',
  '0022_automation_identity_credentials.sql',
  '0023_node_image_lifecycle.sql',
  '0024_node_runtime_lifecycle.sql',
  '0025_scheduled_policy_reconciliation.sql',
  '0026_organization_membership_leave.sql',
  '0027_game_command_envelope.sql',
  '0028_audit_envelope_v1.sql',
  '0031_core_mutation_operations.sql',
  '0038_identity_preferences.sql',
].map((name) => fileURLToPath(new URL(`../../migrations/sql/${name}`, import.meta.url)))
const now = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:00:00Z')
const later = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:05:00Z')
const organizationId = Schema.decodeUnknownSync(OrganizationId)('org-a')
const installerPublicKey = 'rsa-oaep-spki-v1.test-installer-key'
const installerPublicKeyFingerprint = `sha256:${'a'.repeat(64)}`
const mutation = (
  action: string,
  resourceType: string,
  resourceId: string,
  suffix: string,
  requestFingerprint = 'a'.repeat(64),
  actor: 'a' | 'b' = 'a',
) => ({
  operationId: Schema.decodeUnknownSync(OperationId)(`op-${suffix}`),
  idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(`key-${suffix}`),
  operationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(`scoped-${suffix}`),
  requestFingerprint,
  action,
  resourceType,
  resourceId,
  request: {
    origin: 'http' as const,
    requestId: `request-${suffix}`,
    correlationId: `correlation-${suffix}`,
    source: {
      ip: { state: 'captured' as const, value: '192.0.2.1' },
      access: {
        state: 'captured' as const,
        value: {
          subject: `access-${actor}`,
          identityId: null,
          issuer: 'test',
          email: `${actor}@example.com`,
        },
      },
    },
  },
  now,
})

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
    return this.runSync()
  }

  runSync(): D1ResultLike {
    const result = database.prepare(this.sql).run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const adapter: D1DatabaseLike = {
  prepare: (sql) => new SqliteStatement(sql),
  batch: async (statements) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => (statement as SqliteStatement).runSync())
      database.exec('COMMIT')
      return results
    } catch (cause) {
      database.exec('ROLLBACK')
      throw cause
    }
  },
}

const seedRegistration = () => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES
      ('identity-a', 'access-a', 'a@example.com', 'A', 'active', ?, ?),
      ('identity-b', 'access-b', 'b@example.com', 'B', 'active', ?, ?)`)
    .run(now, now, now, now)
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
    .run(now)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES ('org-a', 'identity-a', 'owner', 'active', ?, 1),
             ('org-a', 'identity-b', 'viewer', 'active', ?, 1)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, ?, ?)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu"]', '["small"]', 2, 'active', 1)`)
    .run()
  database
    .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-a', '1.0.0', 'checksum', 'signature', '{}', 'promoted', ?)`)
    .run(now)
  database
    .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
       image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
       created_at, updated_at)
      VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu', 'small',
       'image-a', 'shared', 'ready', 'ready', 1, 1, ?, ?)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-a', 'org-a', 'node.provision', 'node', 'node-a', 'identity-a', 'running', 50,
       'key-a', 'correlation-a', 1, ?, ?)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO node_registration_tokens
      (token_hash, organization_id, node_id, provider_instance_id, operation_id, expires_at, issued_at)
      VALUES ('token-hash', 'org-a', 'node-a', 'instance-a', 'operation-a', ?, ?)`)
    .run(later, now)
}

const exchange = (credentialId: string, credentialHash: string) =>
  Effect.gen(function* () {
    const repository = yield* AgentRegistrationRepository
    return yield* repository.exchange({
      tokenHash: 'token-hash',
      organizationId,
      nodeId: 'node-a',
      providerInstanceId: 'instance-a',
      credentialId,
      credentialHash,
      agentVersion: '0.1.0',
      installerPublicKey,
      installerPublicKeyFingerprint,
      now,
    })
  }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter)))

describe('agent credential and outbox D1 transactions', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations) database.exec(readFileSync(migration, 'utf8'))
    seedRegistration()
  })
  afterEach(() => database.close())

  it('consumes a scoped registration token exactly once under concurrency', async () => {
    const results = await Promise.all([
      Effect.runPromise(Effect.result(exchange('credential-a', 'credential-hash-a'))),
      Effect.runPromise(Effect.result(exchange('credential-b', 'credential-hash-b'))),
    ])

    expect(results.filter((result) => result._tag === 'Success')).toHaveLength(1)
    expect(results.filter((result) => result._tag === 'Failure')).toHaveLength(1)
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM node_credentials WHERE status = 'active'")
        .get(),
    ).toEqual({ count: 1 })
  })

  it('replays the exact credential after a lost exchange response', async () => {
    const first = await Effect.runPromise(exchange('credential-a', 'credential-hash-a'))
    const replay = await Effect.runPromise(exchange('credential-a', 'credential-hash-a'))

    expect(replay).toEqual(first)
    expect(database.prepare('SELECT COUNT(*) AS count FROM node_credentials').get()).toEqual({
      count: 1,
    })
    expect(
      database
        .prepare(`SELECT public_key AS publicKey, public_key_fingerprint AS fingerprint
      FROM node_installer_keys WHERE organization_id = 'org-a' AND node_id = 'node-a'`)
        .get(),
    ).toEqual({
      publicKey: installerPublicKey,
      fingerprint: installerPublicKeyFingerprint,
    })
  })

  it('rejects a registration replay with a different installer key', async () => {
    await Effect.runPromise(exchange('credential-a', 'credential-hash-a'))
    const replay = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const repository = yield* AgentRegistrationRepository
          return yield* repository.exchange({
            tokenHash: 'token-hash',
            organizationId,
            nodeId: 'node-a',
            providerInstanceId: 'instance-a',
            credentialId: 'credential-a',
            credentialHash: 'credential-hash-a',
            agentVersion: '0.1.0',
            installerPublicKey: 'rsa-oaep-spki-v1.different-installer-key',
            installerPublicKeyFingerprint: `sha256:${'b'.repeat(64)}`,
            now,
          })
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      ),
    )

    expect(replay._tag).toBe('Failure')
    expect(database.prepare('SELECT COUNT(*) AS count FROM node_installer_keys').get()).toEqual({
      count: 1,
    })
  })

  it('throttles credential heartbeat writes during idle command polling', async () => {
    await Effect.runPromise(exchange('credential-a', 'credential-hash-a'))
    const layer = makeD1RepositoriesLayer(adapter)
    const authenticate = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* AgentRegistrationRepository
          return yield* repository.authenticate('credential-hash-a', now)
        }).pipe(Effect.provide(layer)),
      )

    await authenticate()
    const afterFirst = database.prepare('SELECT total_changes() AS count').get()
    await authenticate()
    const afterSecond = database.prepare('SELECT total_changes() AS count').get()

    expect(afterSecond).toEqual(afterFirst)
  })

  it('rejects a wrong provider-instance binding and expired token', async () => {
    const wrong = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const repository = yield* AgentRegistrationRepository
          return yield* repository.exchange({
            tokenHash: 'token-hash',
            organizationId,
            nodeId: 'node-a',
            providerInstanceId: 'instance-foreign',
            credentialId: 'credential-a',
            credentialHash: 'credential-hash-a',
            agentVersion: '0.1.0',
            installerPublicKey,
            installerPublicKeyFingerprint,
            now,
          })
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      ),
    )
    expect(wrong._tag).toBe('Failure')

    database
      .prepare("UPDATE node_registration_tokens SET expires_at = '2026-08-23T11:00:00Z'")
      .run()
    await expect(
      Effect.runPromise(exchange('credential-b', 'credential-hash-b')),
    ).rejects.toMatchObject({ code: 'agent_registration_rejected' })
  })

  it('rotates and revokes credentials with version fencing', async () => {
    const principal = await Effect.runPromise(exchange('credential-a', 'credential-hash-a'))
    const layer = makeD1RepositoriesLayer(adapter)
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* AgentRegistrationRepository
        yield* repository.revokeRegistrationToken(principal, 'token-hash', later)
        return yield* repository.authenticate('credential-hash-a', later)
      }).pipe(Effect.provide(layer)),
    )
    expect(
      database
        .prepare(
          "SELECT revoked_at AS revokedAt FROM node_registration_tokens WHERE token_hash = 'token-hash'",
        )
        .get(),
    ).toEqual({ revokedAt: later })
    const rotated = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* AgentRegistrationRepository
        return yield* repository.rotate({
          principal,
          newCredentialId: 'credential-b',
          newCredentialHash: 'credential-hash-b',
          now: later,
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(rotated).toMatchObject({ version: 2, sessionVersion: 2 })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* AgentRegistrationRepository
          return yield* repository.authenticate('credential-hash-a', later)
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeDefined()
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* AgentRegistrationRepository
        yield* repository.revoke(rotated, later)
      }).pipe(Effect.provide(layer)),
    )
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* AgentRegistrationRepository
          return yield* repository.authenticate('credential-hash-b', later)
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeDefined()
  })

  it('reclaims an expired outbox lease and fences the stale worker', async () => {
    database
      .prepare(`INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      VALUES ('event-a', 'org-a', 'organization.membership.revoked', 'membership',
       'identity-a', '{}', 'pending', 0, ?, ?)`)
      .run(now, now)
    const eventId = Schema.decodeUnknownSync(OutboxEventId)('event-a')
    const firstLeaseUntil = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:01:00Z')
    const afterLease = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:02:00Z')
    const secondLeaseUntil = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:03:00Z')
    const layer = makeD1RepositoriesLayer(adapter)
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* OutboxRepository
        return yield* outbox.claimPending('worker-a', 'lease-a', 10, now, firstLeaseUntil)
      }).pipe(Effect.provide(layer)),
    )
    expect(first.map(({ id }) => id)).toEqual(['event-a'])

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* OutboxRepository
        return yield* outbox.claimPending('worker-b', 'lease-b', 10, afterLease, secondLeaseUntil)
      }).pipe(Effect.provide(layer)),
    )
    expect(second.map(({ id }) => id)).toEqual(['event-a'])

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const outbox = yield* OutboxRepository
          yield* outbox.markDelivered(eventId, 'worker-a', 'lease-a', afterLease)
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toMatchObject({ code: 'outbox_lease_lost' })
    await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* OutboxRepository
        yield* outbox.markDelivered(eventId, 'worker-b', 'lease-b', afterLease)
      }).pipe(Effect.provide(layer)),
    )
    expect(
      database.prepare("SELECT publish_state AS state FROM outbox WHERE id = 'event-a'").get(),
    ).toEqual({ state: 'delivered' })
  })

  it('terminally fails a leased outbox event and never reclaims it', async () => {
    database
      .prepare(`INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      VALUES ('event-terminal', 'org-a', 'organization.invitation.created', 'invitation',
       'invite-a', '{}', 'pending', 0, ?, ?)`)
      .run(now, now)
    const eventId = Schema.decodeUnknownSync(OutboxEventId)('event-terminal')
    const layer = makeD1RepositoriesLayer(adapter)
    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* OutboxRepository
        return yield* outbox.claimPending('worker-a', 'lease-terminal', 10, now, later)
      }).pipe(Effect.provide(layer)),
    )
    expect(claimed.map(({ id }) => id)).toContain('event-terminal')
    await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* OutboxRepository
        yield* outbox.markTerminalFailed(eventId, 'worker-a', 'lease-terminal')
      }).pipe(Effect.provide(layer)),
    )
    const reclaimed = await Effect.runPromise(
      Effect.gen(function* () {
        const outbox = yield* OutboxRepository
        return yield* outbox.claimPending('worker-b', 'lease-b', 10, later, later)
      }).pipe(Effect.provide(layer)),
    )
    expect(reclaimed.map(({ id }) => id)).not.toContain('event-terminal')
    expect(
      database
        .prepare("SELECT publish_state AS state FROM outbox WHERE id = 'event-terminal'")
        .get(),
    ).toEqual({ state: 'failed_terminal' })
  })

  it('persists membership removal, revocation event, and audit atomically', async () => {
    const context = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'identity-a',
      role: 'owner',
      correlationId: 'correlation-remove',
    })
    const eventId = Schema.decodeUnknownSync(OutboxEventId)('event-remove')
    const remove = (requestFingerprint = 'a'.repeat(64)) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const memberships = yield* OrganizationMembershipRepository
          return yield* memberships.remove(
            context,
            Schema.decodeUnknownSync(IdentityId)('identity-b'),
            1,
            mutation(
              'organization.membership.remove',
              'organization_membership',
              'identity-b',
              'remove',
              requestFingerprint,
            ),
            eventId,
          )
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      )
    await expect(remove()).resolves.toMatchObject({ replayed: false, operationId: 'op-remove' })
    await expect(remove()).resolves.toMatchObject({ replayed: true, operationId: 'op-remove' })
    await expect(remove('b'.repeat(64))).rejects.toMatchObject({
      _tag: 'ConflictError',
      code: 'idempotency_key_payload_mismatch',
    })

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM organization_memberships WHERE identity_id = 'identity-b'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(
          "SELECT event_type AS eventType, payload_json AS payload FROM outbox WHERE id = 'event-remove'",
        )
        .get(),
    ).toEqual({
      eventType: 'organization.membership.revoked',
      payload: JSON.stringify({ principalId: 'identity-b' }),
    })
    expect(
      database.prepare("SELECT action FROM audit_events WHERE id = 'audit-op-remove'").get(),
    ).toEqual({ action: 'organization.membership.remove' })
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM operations WHERE id = 'op-remove'").get(),
    ).toEqual({ count: 1 })
  })

  it('persists self-leave, outbox, and audit through one immutable receipt', async () => {
    const context = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'identity-b',
      role: 'viewer',
      correlationId: 'correlation-leave',
    })
    const eventId = Schema.decodeUnknownSync(OutboxEventId)('event-leave')
    const leave = Effect.gen(function* () {
      const memberships = yield* OrganizationMembershipRepository
      yield* memberships.leave(
        context,
        1,
        mutation(
          'organization.membership.leave',
          'organization_membership',
          'identity-b',
          'leave',
          'a'.repeat(64),
          'b',
        ),
        eventId,
      )
      return {
        byId: yield* memberships.hasLeaveReceipt('org-a', context.identityId, 1),
        bySlug: yield* memberships.hasLeaveReceipt('organization-a', context.identityId, 1),
      }
    }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter)))
    await expect(Effect.runPromise(leave)).resolves.toEqual({ byId: true, bySlug: true })
    // Adopt a successful write after the HTTP response is lost. The deleted
    // membership is not needed and no second evidence record is created.
    await expect(Effect.runPromise(leave)).resolves.toEqual({ byId: true, bySlug: true })

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM organization_memberships WHERE identity_id = 'identity-b'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database.prepare("SELECT event_type AS eventType FROM outbox WHERE id = 'event-leave'").get(),
    ).toEqual({ eventType: 'organization.membership.left' })
    expect(
      database.prepare("SELECT action FROM audit_events WHERE id = 'audit-op-leave'").get(),
    ).toEqual({ action: 'organization.membership.leave' })
    expect(
      database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM outbox WHERE id = 'event-leave') AS outboxCount, (SELECT COUNT(*) FROM audit_events WHERE id = 'audit-op-leave') AS auditCount",
        )
        .get(),
    ).toEqual({ outboxCount: 1, auditCount: 1 })
  })

  it('updates an organization profile exactly once and adopts a lost response', async () => {
    const context = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'identity-a',
      role: 'owner',
      correlationId: 'correlation-profile',
    })
    const update = (requestFingerprint = 'a'.repeat(64)) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const organizations = yield* OrganizationRepository
          return yield* organizations.updateProfile(
            context,
            { name: 'Renamed organization', timezone: 'Europe/Kyiv', defaultRegion: 'eu-west' },
            1,
            mutation(
              'organization.profile.update',
              'organization',
              'org-a',
              'profile',
              requestFingerprint,
            ),
            Schema.decodeUnknownSync(OutboxEventId)('event-profile'),
          )
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      )

    await expect(update()).resolves.toMatchObject({ replayed: false, operationId: 'op-profile' })
    await expect(update()).resolves.toMatchObject({ replayed: true, operationId: 'op-profile' })
    await expect(update('b'.repeat(64))).rejects.toMatchObject({
      _tag: 'ConflictError',
      code: 'idempotency_key_payload_mismatch',
    })
    expect(
      database
        .prepare(
          "SELECT name, slug, timezone, default_region AS defaultRegion, revision FROM organizations WHERE id = 'org-a'",
        )
        .get(),
    ).toEqual({
      name: 'Renamed organization',
      slug: 'organization-a',
      timezone: 'Europe/Kyiv',
      defaultRegion: 'eu-west',
      revision: 2,
    })
    expect(
      database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM operations WHERE id = 'op-profile') AS operations, (SELECT COUNT(*) FROM audit_events WHERE id = 'audit-op-profile') AS audits, (SELECT COUNT(*) FROM outbox WHERE id = 'event-profile') AS outbox",
        )
        .get(),
    ).toEqual({ operations: 1, audits: 1, outbox: 1 })
  })

  it('resends a pending invitation without exposing token material and adopts a lost response', async () => {
    database
      .prepare(`INSERT INTO organization_invitations
      (id, organization_id, email, role, token_hash, expires_at, inviter_id, status, created_at, revision)
      VALUES ('invite-resend', 'org-a', 'invitee@example.com', 'operator', ?, ?, 'identity-a', 'pending', ?, 1)`)
      .run('c'.repeat(64), later, now)
    const context = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'identity-a',
      role: 'owner',
      correlationId: 'correlation-resend',
    })
    const resend = (requestFingerprint = 'a'.repeat(64)) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const invitations = yield* OrganizationInvitationRepository
          return yield* invitations.resend(
            context,
            Schema.decodeUnknownSync(InvitationId)('invite-resend'),
            1,
            {
              tokenHash: 'd'.repeat(64),
              tokenScope: 'resend:org-a:invite-resend:key-resend',
              tokenKeyVersion: 'v1',
              expiresAt: Schema.decodeUnknownSync(IsoDateTime)('2026-08-24T12:00:00Z'),
              now,
            },
            mutation(
              'organization.invitation.resend',
              'organization_invitation',
              'invite-resend',
              'resend',
              requestFingerprint,
            ),
            Schema.decodeUnknownSync(OutboxEventId)('event-resend'),
          )
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      )

    await expect(resend()).resolves.toMatchObject({ replayed: false, operationId: 'op-resend' })
    await expect(resend()).resolves.toMatchObject({ replayed: true, operationId: 'op-resend' })
    await expect(resend('b'.repeat(64))).rejects.toMatchObject({
      _tag: 'ConflictError',
      code: 'idempotency_key_payload_mismatch',
    })
    const event = database
      .prepare("SELECT payload_json AS payload FROM outbox WHERE id = 'event-resend'")
      .get() as { payload: string }
    expect(event.payload).toContain('tokenDerivation')
    expect(event.payload).not.toContain('tokenHash')
    expect(event.payload).not.toContain('d'.repeat(64))
    expect(
      database
        .prepare(
          "SELECT token_hash AS tokenHash, revision FROM organization_invitations WHERE id = 'invite-resend'",
        )
        .get(),
    ).toEqual({ tokenHash: 'd'.repeat(64), revision: 2 })
    expect(
      database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM operations WHERE id = 'op-resend') AS operations, (SELECT COUNT(*) FROM audit_events WHERE id = 'audit-op-resend') AS audits, (SELECT COUNT(*) FROM outbox WHERE id = 'event-resend') AS outbox",
        )
        .get(),
    ).toEqual({ operations: 1, audits: 1, outbox: 1 })
  })

  it('records an organization switch as an exact audited preference without authorization state', async () => {
    const context = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'identity-b',
      role: 'viewer',
      correlationId: 'correlation-switch',
    })
    const record = (requestFingerprint = 'a'.repeat(64)) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const organizations = yield* OrganizationRepository
          return yield* organizations.recordSwitch(
            context,
            mutation(
              'identity.organization.switch',
              'organization',
              'org-a',
              'switch',
              requestFingerprint,
              'b',
            ),
            Schema.decodeUnknownSync(OutboxEventId)('event-switch'),
          )
        }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter))),
      )

    await expect(record()).resolves.toMatchObject({ replayed: false, operationId: 'op-switch' })
    await expect(record()).resolves.toMatchObject({ replayed: true, operationId: 'op-switch' })
    await expect(record('b'.repeat(64))).rejects.toMatchObject({
      _tag: 'ConflictError',
      code: 'idempotency_key_payload_mismatch',
    })
    expect(
      database
        .prepare(
          "SELECT identity_id AS identityId, last_organization_id AS organizationId, revision FROM identity_preferences WHERE identity_id = 'identity-b'",
        )
        .get(),
    ).toEqual({ identityId: 'identity-b', organizationId: 'org-a', revision: 1 })
    expect(
      database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM operations WHERE id = 'op-switch') AS operations, (SELECT COUNT(*) FROM audit_events WHERE id = 'audit-op-switch') AS audits, (SELECT COUNT(*) FROM outbox WHERE id = 'event-switch') AS outbox",
        )
        .get(),
    ).toEqual({ operations: 1, audits: 1, outbox: 1 })
  })
})

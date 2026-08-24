import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdentityRepository, OrganizationUnitOfWork } from '@gridora/db-contracts'
import { migrations as registeredMigrations } from '@gridora/migrations'
import {
  EmailAddress,
  IdempotencyKey,
  IdentityId,
  InvitationId,
  IsoDateTime,
  OrganizationId,
  OrganizationInvitation,
  OperationId,
  OrganizationSlug,
  OutboxEventId,
} from '@gridora/domain'
import { makeInitialOrganizationPolicy } from '@gridora/policy-control'
import {
  makeD1RepositoriesLayer,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/index.js'

let database: DatabaseSync
const migrations = registeredMigrations.map((migration) =>
  fileURLToPath(new URL(`../../migrations/sql/${migration.file}`, import.meta.url)),
)
const now = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:00:00Z')
const tokenHash = 'a'.repeat(64)

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

const accept = (
  subject: string,
  email: string,
  identityId: string,
  outboxId: string,
  acceptedTokenHash = tokenHash,
  displayName = subject,
) =>
  Effect.gen(function* () {
    const units = yield* OrganizationUnitOfWork
    return yield* units.acceptInvitationWithIdentity({
      tokenHash: acceptedTokenHash,
      identityId: Schema.decodeUnknownSync(IdentityId)(identityId),
      accessSubject: subject,
      email: Schema.decodeUnknownSync(EmailAddress)(email),
      displayName,
      now,
      outboxEventId: Schema.decodeUnknownSync(OutboxEventId)(outboxId),
      tenantOperationId: Schema.decodeUnknownSync(OperationId)(`tenant-${outboxId}`),
      platformOperationId: Schema.decodeUnknownSync(OperationId)(`platform-${outboxId}`),
      idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(`accept-${outboxId}`),
      tenantOperationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(
        `tenant-key-${outboxId}`,
      ),
      platformOperationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(
        `platform-key-${outboxId}`,
      ),
      requestFingerprint: 'b'.repeat(64),
      request: {
        origin: 'http',
        requestId: `request-${outboxId}`,
        correlationId: `correlation-${outboxId}`,
        source: {
          ip: { state: 'captured', value: '192.0.2.1' },
          access: {
            state: 'captured',
            value: { subject, identityId: null, issuer: 'test', email },
          },
        },
      },
    })
  }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter)))

const acceptExisting = (outboxId: string) =>
  Effect.gen(function* () {
    const units = yield* OrganizationUnitOfWork
    return yield* units.acceptInvitation(
      {
        organizationId: Schema.decodeUnknownSync(OrganizationId)('org-a'),
        identityId: Schema.decodeUnknownSync(IdentityId)('existing-id'),
        role: 'viewer',
      },
      Schema.decodeUnknownSync(OrganizationInvitation)({
        id: 'invite-a',
        organizationId: 'org-a',
        email: 'new@example.com',
        role: 'viewer',
        tokenHash,
        expiresAt: '2026-08-24T12:00:00Z',
        inviterId: 'owner-a',
        status: 'pending',
        createdAt: '2026-08-23T12:00:00Z',
        acceptedBy: null,
        revision: 1,
      }),
      {
        operationId: Schema.decodeUnknownSync(OperationId)(`operation-${outboxId}`),
        idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(`accept-${outboxId}`),
        requestFingerprint: 'f'.repeat(64),
        operationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(
          `operation-key-${outboxId}`,
        ),
        action: 'organization.invitation.accept',
        resourceType: 'organization_invitation',
        resourceId: 'invite-a',
        request: {
          origin: 'http',
          requestId: `request-${outboxId}`,
          correlationId: `correlation-${outboxId}`,
          source: {
            ip: { state: 'captured', value: '192.0.2.1' },
            access: {
              state: 'captured',
              value: {
                subject: 'existing-access',
                identityId: 'existing-id',
                issuer: 'test',
                email: 'new@example.com',
              },
            },
          },
        },
        now,
      },
      Schema.decodeUnknownSync(OutboxEventId)(outboxId),
    )
  }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter)))

describe('atomic first-invitation identity acceptance', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations) database.exec(readFileSync(migration, 'utf8'))
    database.exec(`
      INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('owner-a', 'owner-access', 'owner@example.com', 'Owner', 'active', '2026-08-23T12:00:00Z', '2026-08-23T12:00:00Z');
      INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
        VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu', 'complete', 1, 1, '2026-08-23T12:00:00Z');
      INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, revision)
        VALUES ('org-a', 'owner-a', 'owner', 'active', '2026-08-23T12:00:00Z', 1);
      INSERT INTO organization_invitations
        (id, organization_id, email, role, token_hash, expires_at, inviter_id, status, created_at, revision)
        VALUES ('invite-a', 'org-a', 'new@example.com', 'viewer', '${tokenHash}',
          '2026-08-24T12:00:00Z', 'owner-a', 'pending', '2026-08-23T12:00:00Z', 1);
    `)
  })

  it('adopts an exact sign-in operation and conflicts on a changed payload', async () => {
    const signIn = (operationId: string, requestFingerprint: string) =>
      Effect.gen(function* () {
        const identities = yield* IdentityRepository
        return yield* identities.touchLastLogin(Schema.decodeUnknownSync(IdentityId)('owner-a'), {
          operationId: Schema.decodeUnknownSync(OperationId)(operationId),
          idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)('sign-in-key'),
          operationIdempotencyKey:
            Schema.decodeUnknownSync(IdempotencyKey)('sign-in-operation-key'),
          requestFingerprint,
          action: 'identity.sign-in',
          resourceType: 'identity',
          resourceId: 'owner-a',
          request: {
            origin: 'http',
            requestId: 'request-sign-in',
            correlationId: 'correlation-sign-in',
            source: {
              ip: { state: 'captured', value: '192.0.2.1' },
              access: {
                state: 'captured',
                value: {
                  subject: 'owner-access',
                  identityId: 'owner-a',
                  issuer: 'test',
                  email: 'owner@example.com',
                },
              },
            },
          },
          now,
        })
      }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter)))

    await Effect.runPromise(signIn('operation-sign-in-one', '1'.repeat(64)))
    await Effect.runPromise(signIn('operation-sign-in-two', '1'.repeat(64)))
    const mismatch = await Effect.runPromise(
      Effect.result(signIn('operation-sign-in-three', '2'.repeat(64))),
    )
    expect(mismatch._tag).toBe('Failure')
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM platform_operations WHERE type = 'identity.sign-in'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM global_audit_events WHERE action = 'identity.sign-in'",
        )
        .get(),
    ).toEqual({ count: 1 })
  })

  it('adopts an exact sign-up operation and conflicts on a changed payload', async () => {
    const signUp = (identityId: string, operationId: string, requestFingerprint: string) =>
      Effect.gen(function* () {
        const identities = yield* IdentityRepository
        return yield* identities.createOrGet({
          id: Schema.decodeUnknownSync(IdentityId)(identityId),
          accessSubject: 'new-sign-up-access',
          email: Schema.decodeUnknownSync(EmailAddress)('signup@example.com'),
          displayName: 'Sign Up',
          now,
          mutation: {
            operationId: Schema.decodeUnknownSync(OperationId)(operationId),
            idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)('sign-up-key'),
            operationIdempotencyKey:
              Schema.decodeUnknownSync(IdempotencyKey)('sign-up-operation-key'),
            requestFingerprint,
            action: 'identity.sign-up',
            resourceType: 'identity',
            resourceId: identityId,
            request: {
              origin: 'http',
              requestId: 'request-sign-up',
              correlationId: 'correlation-sign-up',
              source: {
                ip: { state: 'captured', value: '192.0.2.1' },
                access: {
                  state: 'captured',
                  value: {
                    subject: 'new-sign-up-access',
                    identityId: null,
                    issuer: 'test',
                    email: 'signup@example.com',
                  },
                },
              },
            },
            now,
          },
        })
      }).pipe(Effect.provide(makeD1RepositoriesLayer(adapter)))

    const first = await Effect.runPromise(
      signUp('signup-id', 'operation-sign-up-one', '1'.repeat(64)),
    )
    const replay = await Effect.runPromise(
      signUp('discarded-id', 'operation-sign-up-two', '1'.repeat(64)),
    )
    expect(replay.id).toBe(first.id)
    const mismatch = await Effect.runPromise(
      Effect.result(signUp('discarded-id-2', 'operation-sign-up-three', '2'.repeat(64))),
    )
    expect(mismatch).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ConflictError', code: 'idempotency_key_payload_mismatch' },
    })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM identities WHERE access_subject = 'new-sign-up-access'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM platform_operations WHERE type = 'identity.sign-up'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM global_audit_events WHERE action = 'identity.sign-up'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM platform_identity_mutation_receipts WHERE access_subject = 'new-sign-up-access'",
        )
        .get(),
    ).toEqual({ count: 1 })
  })
  afterEach(() => database.close())

  it.each([
    ['invalid token', 'b'.repeat(64), 'new@example.com', undefined],
    [
      'expired token',
      tokenHash,
      'new@example.com',
      "UPDATE organization_invitations SET expires_at = '2026-08-22T12:00:00Z'",
    ],
    [
      'revoked token',
      tokenHash,
      'new@example.com',
      "UPDATE organization_invitations SET status = 'revoked'",
    ],
    ['email mismatch', tokenHash, 'other@example.com', undefined],
  ])('leaves no identity for an %s', async (_label, tokenHash, email, setup) => {
    if (setup !== undefined) database.exec(setup)
    const result = await Effect.runPromise(
      Effect.result(accept('new-access', email, 'new-id', 'outbox-a', tokenHash)),
    )
    expect(result._tag).toBe('Failure')
    expect(
      database
        .prepare("SELECT count(*) AS count FROM identities WHERE access_subject = 'new-access'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('serializes concurrent contenders so only the accepted subject is created', async () => {
    const [first, second] = await Promise.all([
      Effect.runPromise(
        Effect.result(accept('access-one', 'new@example.com', 'identity-one', 'outbox-one')),
      ),
      Effect.runPromise(
        Effect.result(accept('access-two', 'new@example.com', 'identity-two', 'outbox-two')),
      ),
    ])
    expect([first._tag, second._tag].sort()).toEqual(['Failure', 'Success'])
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM identities WHERE access_subject IN ('access-one', 'access-two')",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM organization_memberships WHERE organization_id = 'org-a' AND identity_id IN ('identity-one', 'identity-two')",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'organization.invitation.accept'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM global_audit_events WHERE action = 'identity.sign-up'",
        )
        .get(),
    ).toEqual({ count: 1 })
  })

  it('replays the exact accepted subject without creating another identity', async () => {
    const first = await Effect.runPromise(
      accept('new-access', 'new@example.com', 'new-id', 'outbox-a'),
    )
    const replay = await Effect.runPromise(
      accept('new-access', 'new@example.com', 'different-id', 'outbox-b'),
    )
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.identity.id).toBe(first.identity.id)
    expect(
      database
        .prepare("SELECT count(*) AS count FROM identities WHERE access_subject = 'new-access'")
        .get(),
    ).toEqual({ count: 1 })
  })

  it('adopts an exact existing-identity acceptance after response loss', async () => {
    database.exec(`
      INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('existing-id', 'existing-access', 'new@example.com', 'Existing', 'active', '${now}', '${now}');
    `)
    const first = await Effect.runPromise(acceptExisting('outbox-existing-replay'))
    const replay = await Effect.runPromise(acceptExisting('outbox-existing-replay'))
    expect(first.replayed).toBe(false)
    expect(replay).toEqual({ ...first, replayed: true })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM organization_memberships WHERE organization_id = 'org-a' AND identity_id = 'existing-id'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'organization.invitation.accept'",
        )
        .get(),
    ).toEqual({ count: 1 })
  })

  it('does not emit a false sign-up audit for an existing active identity', async () => {
    database
      .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('existing-id', 'existing-access', 'new@example.com', 'Existing', 'active', ?, ?)`)
      .run(now, now)
    await Effect.runPromise(
      accept('existing-access', 'new@example.com', 'unused-generated-id', 'outbox-existing'),
    )
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'organization.invitation.accept'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM global_audit_events WHERE action = 'identity.sign-up'",
        )
        .get(),
    ).toEqual({ count: 0 })
  })

  it('rolls back existing-identity acceptance when outbox evidence collides', async () => {
    database.exec(`
      INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('existing-id', 'existing-access', 'new@example.com', 'Existing', 'active', '${now}', '${now}');
      INSERT INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, created_at)
        VALUES ('outbox-collision', 'org-a', 'existing.event', 'organization', 'org-a', '{}',
          'pending', 0, '${now}', '${now}');
    `)

    const result = await Effect.runPromise(Effect.result(acceptExisting('outbox-collision')))

    expect(result._tag).toBe('Failure')
    expect(
      database.prepare("SELECT status FROM organization_invitations WHERE id = 'invite-a'").get(),
    ).toEqual({ status: 'pending' })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM organization_memberships WHERE organization_id = 'org-a' AND identity_id = 'existing-id'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE target_id = 'invite-a'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('rolls back new-identity acceptance when its platform operation identity collides', async () => {
    database.exec(`
      INSERT INTO platform_operations
        (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
         progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
        VALUES ('platform-outbox-new', 'platform', 'existing.event', 'identity', 'owner-a',
          'owner-a', 'existing-correlation', 'succeeded', 100, 'existing-operation-key',
          '${'e'.repeat(64)}', 1, '${now}', '${now}');
    `)

    const result = await Effect.runPromise(
      Effect.result(accept('new-access', 'new@example.com', 'new-id', 'outbox-new')),
    )

    expect(result._tag).toBe('Failure')
    expect(
      database
        .prepare("SELECT count(*) AS count FROM identities WHERE access_subject = 'new-access'")
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database.prepare("SELECT status FROM organization_invitations WHERE id = 'invite-a'").get(),
    ).toEqual({ status: 'pending' })
    expect(
      database.prepare("SELECT count(*) AS count FROM outbox WHERE id = 'outbox-new'").get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE target_id = 'invite-a'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('rolls back identity and invitation changes for an oversized IdP display name', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        accept(
          'oversized-access',
          'new@example.com',
          'oversized-id',
          'outbox-oversized',
          tokenHash,
          'x'.repeat(161),
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM identities WHERE access_subject = 'oversized-access'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database.prepare("SELECT status FROM organization_invitations WHERE id = 'invite-a'").get(),
    ).toEqual({ status: 'pending' })
  })

  it('creates initial invitations atomically and does not duplicate them on organization retry', async () => {
    const layer = makeD1RepositoriesLayer(adapter)
    const initialTokenHash = 'c'.repeat(64)
    const create = Effect.gen(function* () {
      const units = yield* OrganizationUnitOfWork
      return yield* units.createOrganizationWithOwner({
        id: Schema.decodeUnknownSync(OrganizationId)('org-new'),
        ownerIdentityId: Schema.decodeUnknownSync(IdentityId)('owner-a'),
        name: 'New Organization',
        slug: Schema.decodeUnknownSync(OrganizationSlug)('new-organization'),
        timezone: 'UTC',
        defaultRegion: 'eu',
        termsVersion: 'product-0.2',
        initialPolicy: makeInitialOrganizationPolicy({
          organizationId: 'org-new',
          defaultRegion: 'eu',
          setupBudgetWarning: { minor: 5_000, currency: 'USD' },
        }),
        idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)('setup-key'),
        now,
        outboxEventId: Schema.decodeUnknownSync(OutboxEventId)('event-organization'),
        operationId: Schema.decodeUnknownSync(OperationId)('operation-organization'),
        operationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(
          'organization-operation-key',
        ),
        requestFingerprint: 'd'.repeat(64),
        request: {
          origin: 'http',
          requestId: 'request-organization',
          correlationId: 'correlation-organization',
          source: {
            ip: { state: 'captured', value: '192.0.2.1' },
            access: {
              state: 'captured',
              value: {
                subject: 'owner-access',
                identityId: 'owner-a',
                issuer: 'test',
                email: 'owner@example.com',
              },
            },
          },
        },
        initialInvitations: [
          {
            id: Schema.decodeUnknownSync(InvitationId)('invite-initial'),
            email: Schema.decodeUnknownSync(EmailAddress)('initial@example.com'),
            role: 'operator',
            tokenHash: initialTokenHash,
            tokenScope: 'setup:owner-a:setup-key:0:initial@example.com',
            tokenKeyVersion: 'v1',
            expiresAt: Schema.decodeUnknownSync(IsoDateTime)('2026-08-30T12:00:00Z'),
            outboxEventId: Schema.decodeUnknownSync(OutboxEventId)('event-invitation'),
          },
        ],
      })
    }).pipe(Effect.provide(layer))
    const first = await Effect.runPromise(create)
    const replay = await Effect.runPromise(create)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM organization_invitations WHERE organization_id = 'org-new'",
        )
        .get(),
    ).toEqual({ count: 1 })
    const payload = database
      .prepare("SELECT payload_json AS payload FROM outbox WHERE id = 'event-invitation'")
      .get() as { payload: string }
    expect(payload.payload).not.toContain(initialTokenHash)
    expect(JSON.parse(payload.payload)).toMatchObject({
      email: 'initial@example.com',
      tokenDerivation: { version: 'v1', scope: 'setup:owner-a:setup-key:0:initial@example.com' },
    })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM global_audit_events WHERE action = 'organization.create' AND target_id = 'org-new'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM organization_bootstrap_mutation_receipts WHERE organization_id = 'org-new'",
        )
        .get(),
    ).toEqual({ count: 1 })
    const storedPolicy = database
      .prepare(
        "SELECT policy_json AS policyJson, revision FROM organization_policies WHERE organization_id = 'org-new'",
      )
      .get() as { policyJson: string; revision: number }
    expect(JSON.parse(storedPolicy.policyJson)).toEqual(
      makeInitialOrganizationPolicy({
        organizationId: 'org-new',
        defaultRegion: 'eu',
        setupBudgetWarning: { minor: 5_000, currency: 'USD' },
      }),
    )
    expect(storedPolicy.revision).toBe(1)
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditRequestContext } from '@gridora/audit-contracts'
import {
  AutomationIdentityAuthorizationError,
  AutomationIdentityConflictError,
  AutomationIdentityNotFoundError,
  type CreateAutomationIdentityRecord,
  type RevokeAutomationIdentityRecord,
  type RotateAutomationIdentityRecord,
} from '@gridora/automation-identity-control'
import {
  makeAutomationCredentialAuthenticator,
  type AutomationCredentialCryptography,
} from '@gridora/automation-identity-auth'
import {
  AutomationCredentialId,
  AutomationIdentityId,
  IdempotencyKey,
  OrganizationContext,
} from '@gridora/domain'
import {
  makeAutomationCredentialAuthenticationRepositoryD1,
  makeAutomationIdentityRepositoryD1,
  type AutomationIdentityD1Database,
  type AutomationIdentityD1Result,
  type AutomationIdentityD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
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
] as const

class Statement implements AutomationIdentityD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: ReadonlyArray<SQLInputValue> = [],
  ) {}

  bind(...values: ReadonlyArray<unknown>): AutomationIdentityD1Statement {
    return new Statement(this.database, this.sql, values as ReadonlyArray<SQLInputValue>)
  }

  async first(): Promise<unknown> {
    return this.database.prepare(this.sql).get(...this.values) ?? null
  }

  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.database.prepare(this.sql).all(...this.values) }
  }

  run(): AutomationIdentityD1Result {
    const outcome = this.database.prepare(this.sql).run(...this.values)
    return { meta: { changes: Number(outcome.changes) } }
  }
}

class Database implements AutomationIdentityD1Database {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): AutomationIdentityD1Statement {
    return new Statement(this.sqlite, sql)
  }

  async batch(
    statements: ReadonlyArray<AutomationIdentityD1Statement>,
  ): Promise<ReadonlyArray<AutomationIdentityD1Result>> {
    const hook = beforeBatch
    beforeBatch = undefined
    hook?.()
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement)) throw new Error('unexpected statement')
        return statement.run()
      })
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

const now = '2026-08-23T12:00:00.000Z'
const nextHour = '2026-08-23T13:00:00.000Z'
const later = '2026-08-23T12:01:01.000Z'
const auditRequestContextFor = (identityId: string) => ({
  origin: 'http' as const,
  requestId: `request-automation-identity-d1-test-${identityId}`,
  correlationId: 'correlation-org-a',
  source: {
    ip: { state: 'captured' as const, value: '203.0.113.10' },
    access: {
      state: 'captured' as const,
      value: {
        subject: `access-${identityId}`,
        identityId,
        issuer: 'https://access.test',
        email: `${identityId}@example.test`,
      },
    },
  },
})
const auditRequestContext = auditRequestContextFor('owner-a')
const run = <A, E>(
  effect: Effect.Effect<A, E, AuditRequestContext>,
  requestContext = auditRequestContext,
) => Effect.runPromise(effect.pipe(Effect.provideService(AuditRequestContext, requestContext)))
const runExit = <A, E>(effect: Effect.Effect<A, E, AuditRequestContext>) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provideService(AuditRequestContext, auditRequestContext)),
  )
const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
const id = (value: string) => Schema.decodeUnknownSync(AutomationIdentityId)(value)
const credentialId = (value: string) => Schema.decodeUnknownSync(AutomationCredentialId)(value)
const idempotency = (value: string) => Schema.decodeUnknownSync(IdempotencyKey)(value)
const context = (
  organizationId: 'org-a' | 'org-b',
  role: 'owner' | 'administrator' | 'automation' = 'owner',
  identityId = organizationId === 'org-a' ? 'owner-a' : 'owner-b',
) =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'organization-a' : 'organization-b',
    identityId,
    role,
    correlationId: `correlation-${organizationId}`,
  })

const tokenFor = (clientId: string, credential: string) =>
  `grda.v1.${clientId}.${credential}.${'A'.repeat(43)}`

const cryptoPort = (calls: { compare: number }): AutomationCredentialCryptography => ({
  hash: (value) => Effect.promise(() => sha256(value)),
  timingSafeEqual: (left, right) =>
    Effect.sync(() => {
      calls.compare += 1
      let difference = left.length ^ right.length
      const maxLength = Math.max(left.length, right.length)
      for (let index = 0; index < maxLength; index += 1)
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
      return difference === 0
    }),
})

let sqlite: DatabaseSync
let database: Database
let beforeBatch: (() => void) | undefined

const applyMigrations = () => {
  for (const migration of migrations)
    sqlite.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
}

const seedOrganization = (organizationId: 'org-a' | 'org-b') => {
  const ownerId = organizationId === 'org-a' ? 'owner-a' : 'owner-b'
  const slug = organizationId === 'org-a' ? 'organization-a' : 'organization-b'
  sqlite
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(ownerId, `access-${ownerId}`, `${ownerId}@example.test`, ownerId, now, now)
  sqlite
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
    .run(organizationId, organizationId, slug, now)
  sqlite
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES (?, ?, 'owner', 'active', ?, NULL, 1)`)
    .run(organizationId, ownerId, now)
}

const createRecord = async (
  overrides: Partial<CreateAutomationIdentityRecord> = {},
): Promise<CreateAutomationIdentityRecord> => {
  const clientId = 'automation_client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const keyId = credentialId('automation_credential_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const token = tokenFor(clientId, keyId)
  return {
    context: context('org-a'),
    automationIdentityId: id('automation_identity_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    credentialId: keyId,
    clientId,
    credentialHash: await sha256(token),
    name: 'Release CI',
    scopes: ['servers.manage', 'operations.read'],
    expiresAt: nextHour as never,
    idempotencyKey: idempotency('automation-create-0001'),
    requestFingerprint: await sha256('automation-create-0001'),
    operationId: 'automation_identity_operation_create',
    auditEventId: 'audit_automation_identity_create',
    outboxEventId: 'outbox_automation_identity_create',
    now: now as never,
    ...overrides,
  }
}

describe('automation identity D1 repository', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    applyMigrations()
    database = new Database(sqlite)
    beforeBatch = undefined
    seedOrganization('org-a')
    seedOrganization('org-b')
  })
  afterEach(() => sqlite.close())

  it('persists a verifier, atomic evidence, and a redacted replay response', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    const rawCredential = tokenFor(input.clientId, input.credentialId)
    const created = await run(repository.create(input))

    expect(created).toMatchObject({ replayed: false, identity: { status: 'active', revision: 1 } })
    expect(JSON.stringify(created)).not.toContain(rawCredential)
    const stored = sqlite
      .prepare(
        `SELECT credential_hash AS credentialHash, status FROM automation_identity_credentials`,
      )
      .get() as { readonly credentialHash: string; readonly status: string }
    expect(stored.credentialHash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.credentialHash).not.toBe(rawCredential)
    expect(stored.status).toBe('active')

    const evidence = sqlite
      .prepare(`SELECT
        (SELECT response_json FROM automation_identity_mutations) AS replay,
        (SELECT summary_json FROM audit_events) AS audit,
        (SELECT payload_json FROM outbox) AS outbox`)
      .get() as { readonly replay: string; readonly audit: string; readonly outbox: string }
    expect(JSON.stringify(evidence)).not.toContain(rawCredential)
    expect(JSON.stringify(evidence)).not.toContain(stored.credentialHash)
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM operations`).get()).toEqual({ count: 1 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get()).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM outbox WHERE event_type = 'automation-identity.create'`,
        )
        .get(),
    ).toEqual({ count: 1 })
  })

  it('adopts response-loss replays without returning or replacing a credential', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const first = await createRecord()
    const rawCredential = tokenFor(first.clientId, first.credentialId)
    await run(repository.create(first))
    const second = await createRecord({
      credentialHash: await sha256('different-secret-that-must-not-persist'),
      operationId: 'automation_identity_operation_replay',
      auditEventId: 'audit_automation_identity_replay',
      outboxEventId: 'outbox_automation_identity_replay',
    })
    const replay = await run(repository.create(second))
    expect(replay.replayed).toBe(true)
    expect(JSON.stringify(replay)).not.toContain(rawCredential)
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM automation_identity_credentials`).get(),
    ).toEqual({
      count: 1,
    })
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM operations`).get()).toEqual({ count: 1 })
  })

  it('keeps identity lookup and mutation non-disclosing across organizations', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    await run(repository.create(input))
    await expect(
      Effect.runPromise(repository.get(context('org-b'), input.automationIdentityId)),
    ).rejects.toBeInstanceOf(AutomationIdentityNotFoundError)
    const rotate: RotateAutomationIdentityRecord = {
      context: context('org-b'),
      automationIdentityId: input.automationIdentityId,
      credentialId: credentialId('automation_credential_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      credentialHash: await sha256('foreign'),
      expectedRevision: 1,
      expiresAt: nextHour as never,
      idempotencyKey: idempotency('automation-rotate-foreign'),
      requestFingerprint: await sha256('automation-rotate-foreign'),
      operationId: 'automation_identity_operation_foreign',
      auditEventId: 'audit_automation_identity_foreign',
      outboxEventId: 'outbox_automation_identity_foreign',
      now: now as never,
    }
    const outcome = await runExit(repository.rotate(rotate))
    expect(outcome._tag).toBe('Failure')
    // The repository returns the same not-found shape for absent and foreign IDs.
    // The HTTP adapter below maps that shape to a generic public response.
  })

  it('uses exact revisions, immediately revokes verifiers, and never revives stale credentials', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    await run(repository.create(input))
    const rotatedCredentialId = credentialId(
      'automation_credential_cccccccccccccccccccccccccccccccc',
    )
    const rotate: RotateAutomationIdentityRecord = {
      context: context('org-a'),
      automationIdentityId: input.automationIdentityId,
      credentialId: rotatedCredentialId,
      credentialHash: await sha256(tokenFor(input.clientId, rotatedCredentialId)),
      expectedRevision: 1,
      expiresAt: nextHour as never,
      idempotencyKey: idempotency('automation-rotate-0001'),
      requestFingerprint: await sha256('automation-rotate-0001'),
      operationId: 'automation_identity_operation_rotate',
      auditEventId: 'audit_automation_identity_rotate',
      outboxEventId: 'outbox_automation_identity_rotate',
      now: now as never,
    }
    const rotated = await run(repository.rotate(rotate))
    expect(rotated.identity).toMatchObject({ revision: 2, credentialVersion: 2, status: 'active' })

    const stale: RevokeAutomationIdentityRecord = {
      context: context('org-a'),
      automationIdentityId: input.automationIdentityId,
      expectedRevision: 1,
      idempotencyKey: idempotency('automation-revoke-stale'),
      requestFingerprint: await sha256('automation-revoke-stale'),
      operationId: 'automation_identity_operation_revoke_stale',
      auditEventId: 'audit_automation_identity_revoke_stale',
      outboxEventId: 'outbox_automation_identity_revoke_stale',
      now: later as never,
    }
    await expect(run(repository.revoke(stale))).rejects.toBeInstanceOf(
      AutomationIdentityConflictError,
    )
    const revoke = {
      ...stale,
      expectedRevision: 2,
      idempotencyKey: idempotency('automation-revoke-0001'),
      requestFingerprint: await sha256('automation-revoke-0001'),
      operationId: 'automation_identity_operation_revoke',
      auditEventId: 'audit_automation_identity_revoke',
      outboxEventId: 'outbox_automation_identity_revoke',
    }
    const revoked = await run(repository.revoke(revoke))
    expect(revoked.identity).toMatchObject({ status: 'revoked', revision: 3 })
    expect(
      sqlite
        .prepare(
          `SELECT status, COUNT(*) AS count FROM automation_identity_credentials GROUP BY status`,
        )
        .all(),
    ).toEqual([{ status: 'revoked', count: 2 }])
  })

  it('fences a demoted Administrator at D1 commit time after the initial read', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    await run(repository.create(input))
    sqlite
      .prepare(`INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('admin-a', 'access-admin-a', 'admin-a@example.test', 'Admin A', 'active', ?, ?)`)
      .run(now, now)
    sqlite
      .prepare(`INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, invited_by, revision)
        VALUES ('org-a', 'admin-a', 'administrator', 'active', ?, NULL, 7)`)
      .run(now)
    const rotatedCredentialId = credentialId(
      'automation_credential_dddddddddddddddddddddddddddddddd',
    )
    const rotate: RotateAutomationIdentityRecord = {
      context: context('org-a', 'administrator', 'admin-a'),
      actorMembershipRevision: 7,
      automationIdentityId: input.automationIdentityId,
      credentialId: rotatedCredentialId,
      credentialHash: await sha256(tokenFor(input.clientId, rotatedCredentialId)),
      expectedRevision: 1,
      expiresAt: nextHour as never,
      idempotencyKey: idempotency('automation-rotate-demoted'),
      requestFingerprint: await sha256('automation-rotate-demoted'),
      operationId: 'automation_identity_operation_demoted',
      auditEventId: 'audit_automation_identity_demoted',
      outboxEventId: 'outbox_automation_identity_demoted',
      now: now as never,
    }
    // This runs after repository.get() and before the D1 mutation batch.
    beforeBatch = () => {
      sqlite
        .prepare(`UPDATE organization_memberships
          SET role = 'operator', revision = revision + 1
          WHERE organization_id = 'org-a' AND identity_id = 'admin-a'`)
        .run()
    }
    await expect(
      run(repository.rotate(rotate), auditRequestContextFor('admin-a')),
    ).rejects.toBeInstanceOf(AutomationIdentityAuthorizationError)
    expect(
      sqlite
        .prepare(`SELECT status, revision, credential_version AS credentialVersion
          FROM automation_identities WHERE organization_id = 'org-a'`)
        .get(),
    ).toEqual({ status: 'active', revision: 1, credentialVersion: 1 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM operations`).get()).toEqual({ count: 1 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get()).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM outbox WHERE event_type = 'automation-identity.rotate'`,
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM automation_identity_mutations`).get(),
    ).toEqual({
      count: 1,
    })
  })

  it('uses a route-scoped constant-time verifier, records last use, rate limits, and blocks suspended organizations', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    await run(repository.create(input))
    const authenticationRepository = makeAutomationCredentialAuthenticationRepositoryD1(database)
    const calls = { compare: 0 }
    let authenticationNow = now
    const authenticator = makeAutomationCredentialAuthenticator({
      repository: authenticationRepository,
      cryptography: cryptoPort(calls),
      clock: {
        get now() {
          return Effect.succeed(authenticationNow as never)
        },
      },
      rateLimit: { limit: 1, windowMilliseconds: 60_000 },
    })
    const authorization = `Bearer ${tokenFor(input.clientId, input.credentialId)}`
    const principal = await Effect.runPromise(
      authenticator.authenticate({
        authorization,
        organization: 'organization-a',
        requiredScope: 'servers.manage',
      }),
    )
    expect(principal).toMatchObject({
      authenticationType: 'automation-credential',
      organizationId: 'org-a',
    })
    expect(calls.compare).toBe(1)
    expect(
      sqlite.prepare(`SELECT last_used_at AS lastUsedAt FROM automation_identities`).get(),
    ).toEqual({ lastUsedAt: now })

    await expect(
      Effect.runPromise(
        authenticator.authenticate({
          authorization,
          organization: 'organization-a',
          requiredScope: 'servers.manage',
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'AutomationCredentialAuthenticationError',
      reason: 'rate_limited',
    })
    authenticationNow = later
    const comparisonsBeforeForeignTenant = calls.compare
    await expect(
      Effect.runPromise(
        authenticator.authenticate({
          authorization,
          organization: 'organization-b',
          requiredScope: 'servers.manage',
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'AutomationCredentialAuthenticationError',
      reason: 'invalid_credential',
    })
    // A foreign selector follows the same hash-and-compare path as an absent one.
    // The public API adapter maps both to the same generic response.
    expect(calls.compare).toBe(comparisonsBeforeForeignTenant + 1)
    sqlite.prepare(`UPDATE organizations SET status = 'suspended' WHERE id = 'org-a'`).run()
    await expect(
      Effect.runPromise(
        authenticator.authenticate({
          authorization,
          organization: 'organization-a',
          requiredScope: 'servers.manage',
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'AutomationCredentialAuthenticationError',
      reason: 'invalid_credential',
    })
    expect(calls.compare).toBeGreaterThanOrEqual(2)
  })

  it('revokes credentials when the owning human membership is suspended and never exposes them in lists', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    const rawCredential = tokenFor(input.clientId, input.credentialId)
    await run(repository.create(input))
    sqlite
      .prepare(`UPDATE organization_memberships SET status = 'suspended'
        WHERE organization_id = 'org-a' AND identity_id = 'owner-a'`)
      .run()
    expect(sqlite.prepare(`SELECT status FROM automation_identities`).get()).toEqual({
      status: 'revoked',
    })
    const identities = await Effect.runPromise(repository.list(context('org-a')))
    expect(identities).toHaveLength(1)
    const listed = JSON.stringify(identities)
    expect(listed).not.toContain(rawCredential)
    expect(listed).not.toContain('credentialHash')
    expect(listed).not.toContain('credentialReference')
  })

  it('fails closed when an organization id and another organization slug are ambiguous', async () => {
    const repository = makeAutomationIdentityRepositoryD1(database)
    const input = await createRecord()
    await run(repository.create(input))
    // This makes `organization-a` match org-a by slug and a different row by id.
    // The auth query must not choose either tenant.
    sqlite
      .prepare(`INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
        VALUES ('organization-a', 'ambiguous', 'ambiguous-org', 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
      .run(now)
    const authenticator = makeAutomationCredentialAuthenticator({
      repository: makeAutomationCredentialAuthenticationRepositoryD1(database),
      cryptography: cryptoPort({ compare: 0 }),
      clock: { now: Effect.succeed(now as never) },
      rateLimit: { limit: 60, windowMilliseconds: 60_000 },
    })
    await expect(
      Effect.runPromise(
        authenticator.authenticate({
          authorization: `Bearer ${tokenFor(input.clientId, input.credentialId)}`,
          organization: 'organization-a',
          requiredScope: 'servers.manage',
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'AutomationCredentialAuthenticationError',
      reason: 'invalid_credential',
    })
  })
})

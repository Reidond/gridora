import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderAccountMetadata } from '@gridora/contracts'
import { ProviderAccountRepository } from '@gridora/db-contracts'
import { IdempotencyKey, IsoDateTime, OrganizationContext } from '@gridora/domain'
import { migrations } from '@gridora/migrations'
import { SecretEnvelopeRecord } from '@gridora/secret-envelope'
import {
  makeD1RepositoriesLayer,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/index.js'

const now = Schema.decodeUnknownSync(IsoDateTime)('2026-08-24T00:00:00Z')
const later = Schema.decodeUnknownSync(IsoDateTime)('2026-08-24T00:01:00Z')
const migrationsDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrationFiles = migrations.map((migration) => `${migrationsDirectory}${migration.file}`)
const context = Schema.decodeUnknownSync(OrganizationContext)({
  organizationId: 'org-a',
  organizationSlug: 'organization-a',
  identityId: 'owner-a',
  role: 'owner',
  correlationId: 'provider-account-response-loss',
})
const key = (value: string) => Schema.decodeUnknownSync(IdempotencyKey)(value)

class Statement implements D1PreparedStatementLike {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): D1PreparedStatementLike {
    return new Statement(this.database, this.sql, values)
  }
  async first(): Promise<unknown> {
    return (
      this.database.prepare(this.sql).get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
    )
  }
  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as ReadonlyArray<SQLInputValue>)),
    }
  }
  async run(): Promise<D1ResultLike> {
    const result = this.database
      .prepare(this.sql)
      .run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class ResponseLossD1 implements D1DatabaseLike {
  loseAfterCommitOnce = false
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): D1PreparedStatementLike {
    return new Statement(this.database, sql)
  }
  async batch(
    statements: ReadonlyArray<D1PreparedStatementLike>,
  ): Promise<ReadonlyArray<D1ResultLike>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.database.exec('COMMIT')
      if (this.loseAfterCommitOnce) {
        this.loseAfterCommitOnce = false
        throw new Error('simulated D1 response loss after commit')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }
}

let database: DatabaseSync
let d1: ResponseLossD1

const request = (requestId: string) => ({
  origin: 'http' as const,
  requestId,
  correlationId: context.correlationId,
  source: {
    ip: { state: 'captured' as const, value: '203.0.113.11' },
    access: {
      state: 'captured' as const,
      value: {
        subject: 'access-owner-a',
        identityId: context.identityId,
        issuer: 'https://access.example.test',
        email: 'owner-a@example.test',
      },
    },
  },
})

const account = new ProviderAccountMetadata({
  id: 'provider-a',
  scope: 'organization',
  organizationId: context.organizationId,
  providerType: 'ovhcloud',
  status: 'disabled',
  revision: 1,
  credentialRevision: 1,
  createdAt: now,
  updatedAt: now,
})
const initialEnvelope = new SecretEnvelopeRecord({
  organizationId: context.organizationId,
  id: 'provider-a.credentials',
  scopeType: 'provider-account',
  scopeId: account.id,
  ciphertext: 'ciphertext-v1',
  wrappedDataKey: 'wrapped-v1',
  keyVersion: 1,
  revision: 1,
  createdAt: now,
  rotatedAt: null,
})

const run = <A>(program: Effect.Effect<A, unknown, ProviderAccountRepository>) =>
  Effect.runPromise(program.pipe(Effect.provide(makeD1RepositoriesLayer(d1))))

const create = () =>
  Effect.gen(function* () {
    const repository = yield* ProviderAccountRepository
    return yield* repository.create(context, {
      account,
      credentialEnvelope: initialEnvelope,
      idempotencyKey: key('provider-create-loss'),
      operationIdempotencyKey: key('a'.repeat(64)),
      requestFingerprint: 'b'.repeat(64),
      auditRequestContext: request('provider-create-loss-request'),
    })
  })

const rotate = () =>
  Effect.gen(function* () {
    const repository = yield* ProviderAccountRepository
    return yield* repository.updateCredentials(context, {
      accountId: account.id,
      providerType: account.providerType,
      expectedRevision: 1,
      expectedCredentialRevision: 1,
      credentialEnvelope: new SecretEnvelopeRecord({
        organizationId: initialEnvelope.organizationId,
        id: initialEnvelope.id,
        scopeType: initialEnvelope.scopeType,
        scopeId: initialEnvelope.scopeId,
        ciphertext: 'ciphertext-v2',
        wrappedDataKey: 'wrapped-v2',
        keyVersion: initialEnvelope.keyVersion,
        revision: 2,
        createdAt: initialEnvelope.createdAt,
        rotatedAt: later,
      }),
      idempotencyKey: key('provider-rotate-loss'),
      operationIdempotencyKey: key('c'.repeat(64)),
      requestFingerprint: 'd'.repeat(64),
      auditRequestContext: request('provider-rotate-loss-request'),
      now: later,
    })
  })

describe('provider-account v1 audit persistence', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrationFiles) database.exec(readFileSync(migration, 'utf8'))
    database
      .prepare(`INSERT INTO identities
        (id,access_subject,email,display_name,status,signed_up_at,last_login_at)
        VALUES ('owner-a','access-owner-a','owner-a@example.test','Owner','active',?,?)`)
      .run(now, now)
    database
      .prepare(`INSERT INTO organizations
        (id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at)
        VALUES ('org-a','Organization A','organization-a','active','UTC','eu','complete',1,1,?)`)
      .run(now)
    database
      .prepare(`INSERT INTO organization_memberships
        (organization_id,identity_id,role,status,joined_at,revision)
        VALUES ('org-a','owner-a','owner','active',?,1)`)
      .run(now)
    d1 = new ResponseLossD1(database)
  })
  afterEach(() => database.close())

  it('adopts exact create and credential-update receipts after a committed D1 response loss', async () => {
    d1.loseAfterCommitOnce = true
    await expect(run(create())).resolves.toEqual(account)
    d1.loseAfterCommitOnce = true
    await expect(run(rotate())).resolves.toMatchObject({ revision: 2, credentialRevision: 2 })

    expect(
      database.prepare(`SELECT count(*) AS count FROM provider_account_mutation_idempotency`).get(),
    ).toEqual({ count: 2 })
    expect(database.prepare(`SELECT count(*) AS count FROM operations`).get()).toEqual({ count: 2 })
    expect(database.prepare(`SELECT count(*) AS count FROM audit_events`).get()).toEqual({
      count: 2,
    })
    expect(database.prepare(`SELECT count(*) AS count FROM audit_event_envelopes`).get()).toEqual({
      count: 2,
    })
    expect(
      database
        .prepare(`SELECT type,resource_type AS resourceType,status,progress,idempotency_key AS idempotencyKey
          FROM operations WHERE type = 'provider-account.credentials.update'`)
        .get(),
    ).toEqual({
      type: 'provider-account.credentials.update',
      resourceType: 'provider_account',
      status: 'succeeded',
      progress: 100,
      idempotencyKey: 'c'.repeat(64),
    })
    expect(
      database
        .prepare(`SELECT json_extract(envelope_json, '$.operationId') AS operationId,
          json_extract(envelope_json, '$.source.origin') AS origin
          FROM audit_event_envelopes
          WHERE event_id = 'provider-account-audit:${'c'.repeat(64)}'`)
        .get(),
    ).toEqual({
      operationId: `provider-account-operation:${'c'.repeat(64)}`,
      origin: 'http',
    })
  })
})

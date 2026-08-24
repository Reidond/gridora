import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { IdempotencyKey, OrganizationContext } from '@gridora/domain'
import {
  ProviderAccountLifecycleResult,
  ProviderAccountStoreConflictError,
  ProviderAccountStoreNotFoundError,
  ProviderAccountStoreRevisionError,
  type ProviderAccountCommitInput,
  type ProviderAccountLifecycleAction,
} from '@gridora/provider-account-control'
import {
  makeProviderAccountActionRepositoryD1,
  providerAccountActionSchemaSql,
  type ProviderAccountD1Database,
  type ProviderAccountD1Result,
  type ProviderAccountD1Statement,
} from '../src/index.js'

const migrationsDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_[A-Za-z0-9_]+\.sql$/.test(file))
  .sort()
const now = '2026-08-23T14:00:00.000Z'

class SqliteStatement implements ProviderAccountD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): ProviderAccountD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<ProviderAccountD1Result> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
}

class SqliteD1 implements ProviderAccountD1Database {
  failBeforeCommitOnce = false
  failAfterCommitOnce = false
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): ProviderAccountD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<ProviderAccountD1Statement>,
  ): Promise<ReadonlyArray<ProviderAccountD1Result>> {
    if (this.failBeforeCommitOnce) {
      this.failBeforeCommitOnce = false
      throw new Error('simulated transport loss before transaction')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: ProviderAccountD1Result[] = []
      for (const statement of statements) {
        const result = await statement.all()
        const changes = this.database.prepare('SELECT changes() AS changes').get() as {
          changes: number
        }
        results.push({ ...result, meta: { changes: changes.changes } })
      }
      this.database.exec('COMMIT')
      if (this.failAfterCommitOnce) {
        this.failAfterCommitOnce = false
        throw new Error('simulated response loss after commit')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const context = (organizationId: 'org-a' | 'org-b', identityId: 'owner-a' | 'owner-b') =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'org-a-slug' : 'org-b-slug',
    identityId,
    role: 'owner',
    correlationId: `correlation-${organizationId}`,
  })

const key = (value: string) => Schema.decodeUnknownSync(IdempotencyKey)(value)

let database: DatabaseSync
let d1: SqliteD1
let repository: ReturnType<typeof makeProviderAccountActionRepositoryD1>
let operationKeySequence = 0

const seedIdentityAndOrganization = (
  organizationId: 'org-a' | 'org-b',
  identityId: 'owner-a' | 'owner-b',
) => {
  database
    .prepare(
      `INSERT INTO identities
       (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(identityId, `access-${identityId}`, `${identityId}@example.test`, identityId, now, now)
  database
    .prepare(
      `INSERT INTO organizations
       (id, name, slug, status, timezone, default_region, onboarding_step,
        policy_revision, revision, created_at)
       VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`,
    )
    .run(organizationId, organizationId, `${organizationId}-slug`, now)
  database
    .prepare(
      `INSERT INTO organization_memberships
       (organization_id, identity_id, role, status, joined_at, invited_by, revision)
       VALUES (?, ?, 'owner', 'active', ?, NULL, 1)`,
    )
    .run(organizationId, identityId, now)
}

const seedAccount = (
  organizationId: 'org-a' | 'org-b',
  accountId: string,
  status: 'active' | 'disabled' | 'error' = 'active',
  providerType: 'ovhcloud' | 'contabo' = 'ovhcloud',
) => {
  const credentialReference = `${accountId}.credentials`
  database
    .prepare(
      `INSERT INTO provider_accounts
       (id, scope, organization_id, provider_type, credential_reference, status,
        revision, created_at, updated_at)
       VALUES (?, 'organization', ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(accountId, organizationId, providerType, credentialReference, status, now, now)
  database
    .prepare(
      `INSERT INTO secret_envelopes
       (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
        key_version, revision, created_at, rotated_at)
       VALUES (?, ?, 'provider-account', ?, 'v1.encrypted.ciphertext',
        'wrapped-key-material', 1, 1, ?, NULL)`,
    )
    .run(organizationId, credentialReference, accountId, now)
}

const makeCommit = async (
  accountId: string,
  action: ProviderAccountLifecycleAction,
  overrides: Partial<ProviderAccountCommitInput> = {},
): Promise<ProviderAccountCommitInput> => {
  operationKeySequence += 1
  const account = await Effect.runPromise(
    repository.getScoped(context('org-a', 'owner-a'), accountId),
  )
  const outcome =
    action === 'test'
      ? 'valid'
      : action === 'refresh'
        ? 'refreshed'
        : action === 'disable'
          ? 'disabled'
          : 'removed'
  const result = Schema.decodeUnknownSync(ProviderAccountLifecycleResult)({
    accountId,
    organizationId: 'org-a',
    providerType: account.providerType,
    action,
    outcome,
    accountStatus: action === 'remove' ? null : action === 'disable' ? 'disabled' : 'active',
    revision: 2,
    operationId: `operation-${accountId}-${action}`,
    failureCategory: null,
    regionCount: action === 'refresh' ? 1 : 0,
    projectCount: 0,
    catalogItemCount: action === 'refresh' ? 1 : 0,
    completedAt: now,
  })
  return {
    context: context('org-a', 'owner-a'),
    accountId,
    account,
    action,
    expectedRevision: 1,
    idempotencyKey: key(`idempotency-${accountId}-${action}`),
    operationIdempotencyKey: key(operationKeySequence.toString(16).padStart(64, '0')),
    requestFingerprint: 'a'.repeat(64),
    result,
    catalog:
      action === 'refresh'
        ? [
            {
              region: 'eu-west',
              plan: 'b2-15',
              currency: 'EUR',
              hourlyPriceMinor: 5,
              monthlyPriceMinor: 2500,
              metadata: {
                cpu: 4,
                memoryMiB: 16_384,
                diskGiB: 160,
                billingKind: 'hourly',
                contractMonths: null,
              },
            },
          ]
        : [],
    auditEventId: `audit-${accountId}-${action}`,
    auditRequestContext: {
      origin: 'http',
      requestId: `request-${accountId}-${action}`,
      correlationId: 'correlation-org-a',
      source: {
        ip: { state: 'captured', value: '203.0.113.10' },
        access: {
          state: 'captured',
          value: {
            subject: 'access-owner-a',
            identityId: 'owner-a',
            issuer: 'https://access.example.test',
            email: 'owner-a@example.test',
          },
        },
      },
    },
    ...overrides,
  }
}

const scalar = (sql: string, ...values: SQLInputValue[]) =>
  database.prepare(sql).get(...values) as Record<string, unknown> | undefined

describe('provider account lifecycle D1 adapter', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    operationKeySequence = 0
    for (const migration of migrations)
      database.exec(readFileSync(`${migrationsDirectory}${migration}`, 'utf8'))
    database.exec(providerAccountActionSchemaSql)
    d1 = new SqliteD1(database)
    repository = makeProviderAccountActionRepositoryD1(d1)
    seedIdentityAndOrganization('org-a', 'owner-a')
    seedIdentityAndOrganization('org-b', 'owner-b')
  })

  it('does not disclose a provider account across organization scope', async () => {
    seedAccount('org-a', 'account-shared')
    await expect(
      Effect.runPromise(repository.getScoped(context('org-b', 'owner-b'), 'account-shared')),
    ).rejects.toBeInstanceOf(ProviderAccountStoreNotFoundError)
  })

  it('atomically updates status, operation, audit, catalog, and an exact replay fence', async () => {
    seedAccount('org-a', 'account-refresh')
    const input = await makeCommit('account-refresh', 'refresh')
    const first = await Effect.runPromise(repository.commit(input))
    const replay = await Effect.runPromise(repository.commit(input))

    expect(replay).toEqual(first)
    expect(first).toMatchObject({ outcome: 'refreshed', revision: 2, catalogItemCount: 1 })
    expect(
      scalar(
        `SELECT provider_type AS providerType, status, revision
         FROM provider_accounts WHERE organization_id = ? AND id = ?`,
        'org-a',
        'account-refresh',
      ),
    ).toEqual({ providerType: 'ovhcloud', status: 'active', revision: 2 })
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(1)
    expect(scalar('SELECT COUNT(*) AS count FROM audit_events')?.count).toBe(1)
    expect(scalar('SELECT COUNT(*) AS count FROM audit_event_envelopes')?.count).toBe(1)
    expect(
      scalar(
        `SELECT status, idempotency_key AS idempotencyKey
         FROM operations WHERE id = ?`,
        input.result.operationId,
      ),
    ).toEqual({ status: 'succeeded', idempotencyKey: input.operationIdempotencyKey })
    expect(scalar('SELECT COUNT(*) AS count FROM provider_catalog')?.count).toBe(1)
    expect(
      scalar(
        `SELECT revision FROM secret_envelopes
         WHERE organization_id = 'org-a' AND scope_id = 'account-refresh'`,
      )?.revision,
    ).toBe(1)
    const persisted = JSON.stringify(
      database
        .prepare(
          `SELECT response_json, request_fingerprint FROM provider_account_action_idempotency`,
        )
        .all(),
    )
    expect(persisted).not.toContain('applicationCredentialSecret')
    expect(persisted).not.toContain('apiPassword')

    // Credential rotation has its own terminal operation/audit boundary. This
    // lifecycle test intentionally does not forge the old raw SQL receipt.
  })

  it('adopts the exact result when D1 stored the batch but its response was lost', async () => {
    seedAccount('org-a', 'account-lost')
    const input = await makeCommit('account-lost', 'test')
    d1.failAfterCommitOnce = true

    const recovered = await Effect.runPromise(repository.commit(input))
    expect(recovered).toEqual(input.result)
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(1)
    expect(scalar('SELECT COUNT(*) AS count FROM audit_events')?.count).toBe(1)
    expect(
      scalar('SELECT revision FROM provider_accounts WHERE id = ?', 'account-lost')?.revision,
    ).toBe(2)
  })

  it('rolls back completely when transport fails before the transaction and can be retried', async () => {
    seedAccount('org-a', 'account-before')
    const input = await makeCommit('account-before', 'disable')
    d1.failBeforeCommitOnce = true
    await expect(Effect.runPromise(repository.commit(input))).rejects.toMatchObject({
      _tag: 'ProviderAccountStorePersistenceError',
    })
    expect(
      scalar('SELECT status, revision FROM provider_accounts WHERE id = ?', 'account-before'),
    ).toEqual({ status: 'active', revision: 1 })
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(0)
    expect(scalar('SELECT COUNT(*) AS count FROM audit_events')?.count).toBe(0)

    await expect(Effect.runPromise(repository.commit(input))).resolves.toMatchObject({
      outcome: 'disabled',
    })
  })

  it('rejects stale revisions and idempotency-key payload changes', async () => {
    seedAccount('org-a', 'account-conflict')
    const input = await makeCommit('account-conflict', 'disable')
    await Effect.runPromise(repository.commit(input))
    await expect(
      Effect.runPromise(
        repository.findReplay({
          ...input,
          requestFingerprint: 'different-fingerprint-0000000000',
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderAccountStoreConflictError)

    await expect(
      Effect.runPromise(
        repository.commit({
          ...input,
          idempotencyKey: key('another-idempotency-key'),
          requestFingerprint: 'b'.repeat(64),
          result: Schema.decodeUnknownSync(ProviderAccountLifecycleResult)({
            accountId: input.result.accountId,
            organizationId: input.result.organizationId,
            providerType: input.result.providerType,
            action: input.result.action,
            outcome: input.result.outcome,
            accountStatus: input.result.accountStatus,
            revision: input.result.revision,
            operationId: 'operation-stale-test',
            failureCategory: input.result.failureCategory,
            regionCount: input.result.regionCount,
            projectCount: input.result.projectCount,
            catalogItemCount: input.result.catalogItemCount,
            completedAt: input.result.completedAt,
          }),
          auditEventId: 'audit-stale-test',
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderAccountStoreRevisionError)
  })

  it('requires disabled and unreferenced state, then removes account and envelope atomically', async () => {
    seedAccount('org-a', 'account-active')
    const activeInput = await makeCommit('account-active', 'remove')
    await expect(Effect.runPromise(repository.commit(activeInput))).rejects.toBeInstanceOf(
      ProviderAccountStoreConflictError,
    )
    expect(scalar('SELECT COUNT(*) AS count FROM secret_envelopes')?.count).toBe(1)

    seedAccount('org-a', 'account-referenced', 'disabled')
    database
      .prepare(
        `INSERT INTO provider_allocations
         (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
          max_active_nodes, monthly_budget_minor, status, revision)
         VALUES ('org-a', 'account-referenced', '[]', '[]', 1, NULL, 'active', 1)`,
      )
      .run()
    const referencedInput = await makeCommit('account-referenced', 'remove')
    await expect(Effect.runPromise(repository.commit(referencedInput))).rejects.toMatchObject({
      code: 'account_referenced',
    })
    expect(scalar('SELECT COUNT(*) AS count FROM secret_envelopes')?.count).toBe(2)

    seedAccount('org-a', 'account-node', 'disabled')
    database
      .prepare(
        `INSERT INTO provider_allocations
         (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
          max_active_nodes, monthly_budget_minor, status, revision)
         VALUES ('org-a', 'account-node', '[]', '[]', 1, NULL, 'disabled', 1)`,
      )
      .run()
    database
      .prepare(
        `INSERT INTO node_images
         (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
         VALUES ('image-a', 'v1', 'checksum', 'signature', '{}', 'promoted', ?, ?)`,
      )
      .run(now, now)
    database
      .prepare(
        `INSERT INTO nodes
         (organization_id, id, provider_account_id, provider_instance_id, provider_type,
          region, plan, image_id, placement_mode, desired_state, observed_state,
          desired_revision, observed_revision, reconciliation_error, last_reconciled_at,
          created_at, updated_at)
         VALUES ('org-a', 'node-a', 'account-node', 'provider-node-a', 'ovhcloud',
          'eu-west', 'b2-15', 'image-a', 'dedicated', 'ready', 'ready',
          1, 1, NULL, ?, ?, ?)`,
      )
      .run(now, now, now)
    await expect(
      Effect.runPromise(repository.commit(await makeCommit('account-node', 'remove'))),
    ).rejects.toMatchObject({ code: 'account_referenced' })

    seedAccount('org-a', 'account-disabled-allocation', 'disabled')
    database
      .prepare(
        `INSERT INTO provider_allocations
         (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
          max_active_nodes, monthly_budget_minor, status, revision)
         VALUES ('org-a', 'account-disabled-allocation', '[]', '[]', 0, NULL, 'disabled', 1)`,
      )
      .run()
    await expect(
      Effect.runPromise(
        repository.commit(await makeCommit('account-disabled-allocation', 'remove')),
      ),
    ).resolves.toMatchObject({ outcome: 'removed' })
    expect(
      scalar(
        `SELECT 1 FROM provider_allocations
         WHERE organization_id = 'org-a' AND provider_account_id = 'account-disabled-allocation'`,
      ),
    ).toBeUndefined()

    seedAccount('org-a', 'account-remove', 'disabled', 'contabo')
    const removeInput = await makeCommit('account-remove', 'remove')
    const removed = await Effect.runPromise(repository.commit(removeInput))
    expect(removed).toMatchObject({
      providerType: 'contabo',
      outcome: 'removed',
      accountStatus: null,
      revision: 2,
    })
    expect(
      scalar('SELECT status, revision FROM provider_accounts WHERE id = ?', 'account-remove'),
    ).toEqual({ status: 'disabled', revision: 2 })
    expect(
      scalar('SELECT 1 FROM secret_envelopes WHERE scope_id = ?', 'account-remove'),
    ).toBeUndefined()
    expect(
      scalar(
        `SELECT COUNT(*) AS count FROM provider_account_mutation_idempotency
         WHERE organization_id = 'org-a' AND account_id = 'account-remove'`,
      )?.count,
    ).toBe(0)
    await expect(
      Effect.runPromise(repository.getScoped(context('org-a', 'owner-a'), 'account-remove')),
    ).rejects.toBeInstanceOf(ProviderAccountStoreNotFoundError)
    await expect(repository.commit(removeInput).pipe(Effect.runPromise)).resolves.toEqual(removed)
  })

  it('rejects a forged cross-organization commit before any write or catalog refresh', async () => {
    seedAccount('org-a', 'account-owned')
    const input = await makeCommit('account-owned', 'refresh')
    const forged = {
      ...input,
      context: context('org-b', 'owner-b'),
    }
    await expect(Effect.runPromise(repository.commit(forged))).rejects.toMatchObject({
      _tag: 'ProviderAccountStorePersistenceError',
    })
    expect(
      scalar('SELECT revision FROM provider_accounts WHERE id = ?', 'account-owned')?.revision,
    ).toBe(1)
    expect(scalar('SELECT COUNT(*) AS count FROM provider_catalog')?.count).toBe(0)
    expect(scalar('SELECT COUNT(*) AS count FROM operations')?.count).toBe(0)
  })
})

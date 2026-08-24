import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import { OrganizationContext } from '@gridora/domain'
import {
  AuditEventInventory,
  BackupInventory,
  GameServerInventory,
  InventoryPageRequest,
  NodeImageInventory,
  NodeInventory,
  OperationInventory,
  ProviderInventory,
} from '@gridora/inventory-contracts'
import {
  makeInventoryD1Layer,
  type InventoryD1Database,
  type InventoryD1Statement,
} from '../src/index.js'

let database: DatabaseSync
const migrationsDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => `${migrationsDirectory}${name}`)
const timestamp = '2026-08-23T12:00:00Z'

class SqliteStatement implements InventoryD1Statement {
  constructor(
    private readonly sql: string,
    private readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): InventoryD1Statement {
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
}
const adapter: InventoryD1Database = { prepare: (sql) => new SqliteStatement(sql) }
const layer = () => makeInventoryD1Layer(adapter)
const context = (organizationId: string, identityId: string) =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'organization-a' : 'organization-b',
    identityId,
    role: 'owner',
    correlationId: `correlation-${organizationId}`,
  })
const page = (limit: number, cursor?: string) =>
  Schema.decodeUnknownSync(InventoryPageRequest)({
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  })

const insertCompleteAudit = (
  id: string,
  organizationId: string,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  correlationId: string,
  operationId: string,
  summary: Record<string, unknown>,
): void => {
  const actor = database
    .prepare('SELECT access_subject AS accessSubject, email FROM identities WHERE id = ?')
    .get(actorId) as { readonly accessSubject: string; readonly email: string }
  const stage = Effect.runSync(
    stageAuditEnvelope(
      'tenant',
      id,
      {
        version: 1,
        captureStatus: 'complete',
        occurredAt: timestamp,
        scope: 'tenant',
        organizationId,
        actor: { type: 'human', id: actorId },
        request: { id: `request-${id}`, correlationId },
        action,
        target: { type: targetType, id: targetId },
        before: { state: 'absent', reason: 'fixture-state-before' },
        after: { state: 'captured', summary },
        operationId,
        source: {
          origin: 'http',
          ip: { state: 'captured', value: '203.0.113.19' },
          access: {
            state: 'captured',
            value: {
              subject: actor.accessSubject,
              identityId: actorId,
              issuer: 'https://access.example.test',
              email: actor.email,
            },
          },
        },
        result: 'succeeded',
        error: { classification: 'none', code: null },
        forced: false,
        breakGlass: false,
      },
      timestamp,
    ),
  )
  database.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
  database
    .prepare(`INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`)
    .run(
      id,
      organizationId,
      actorId,
      action,
      targetType,
      targetId,
      correlationId,
      JSON.stringify(summary),
      timestamp,
    )
}

const insertFixture = () => {
  for (const [id, email] of [
    ['owner-a', 'a@example.com'],
    ['owner-b', 'b@example.com'],
  ] as const) {
    database
      .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(id, `access-${id}`, email, id, timestamp, timestamp)
  }
  database
    .prepare(`INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES
    ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu', 'complete', 1, 1, ?),
    ('org-b', 'Organization B', 'organization-b', 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
    .run(timestamp, timestamp)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES ('org-a', 'owner-a', 'owner', 'active', ?, NULL, 1),
        ('org-b', 'owner-b', 'owner', 'active', ?, NULL, 1)`)
    .run(timestamp, timestamp)
  database
    .prepare(`INSERT INTO provider_accounts
    (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
    VALUES
    ('account-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, ?, ?),
    ('account-b', 'organization', 'org-b', 'contabo', 'secret-b', 'active', 1, ?, ?),
    ('account-platform', 'platform', NULL, 'ovhcloud', 'secret-platform', 'active', 1, ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp)
  database
    .prepare(`INSERT INTO provider_allocations
    (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
     max_active_nodes, monthly_budget_minor, status, revision)
    VALUES
    ('org-a', 'account-a', '["eu"]', '["small"]', 4, 5000, 'active', 1),
    ('org-a', 'account-platform', '["eu"]', '["medium"]', 2, NULL, 'active', 1),
    ('org-b', 'account-b', '["us"]', '["large"]', 4, 9000, 'active', 1)`)
    .run()
  database
    .prepare(`INSERT INTO node_images
    (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
    VALUES ('image-a', '1.0.0', 'sha256:a', 'signature-a', '{"ovhcloud":"image-ref"}', 'promoted', ?, ?)`)
    .run(timestamp, timestamp)
  database
    .prepare(`INSERT INTO nodes
    (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
     image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
     created_at, updated_at)
    VALUES
    ('org-a', 'node-a1', 'account-a', 'instance-a1', 'ovhcloud', 'eu', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, ?, ?),
    ('org-a', 'node-a2', 'account-a', 'instance-a2', 'ovhcloud', 'eu', 'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, ?, ?),
    ('org-b', 'node-b', 'account-b', 'instance-b', 'contabo', 'us', 'large', 'image-a', 'shared', 'ready', 'ready', 1, 1, ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp)
  database
    .prepare(`INSERT INTO game_plugins
    (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
    .run()
  database
    .prepare(`INSERT INTO game_servers
    (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
     placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
    VALUES
    ('org-a', 'server-a', 'A server', 'arma-reforger', '1.0.0', 'running', 'running', '{"region":"eu"}', 1, 1, 1, ?, ?),
    ('org-b', 'server-b', 'B server', 'arma-reforger', '1.0.0', 'running', 'running', '{"region":"us"}', 1, 1, 1, ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp)
  database
    .prepare(`INSERT INTO backups
    (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json, state, created_at)
    VALUES
    ('org-a', 'backup-a', 'server-a', 'organizations/org-a/backups/a', 'checksum-a', 1, '{"size":1}', 'available', ?),
    ('org-b', 'backup-b', 'server-b', 'organizations/org-b/backups/b', 'checksum-b', 1, '{"size":2}', 'available', ?)`)
    .run(timestamp, timestamp)
  for (const [org, owner, suffix] of [
    ['org-a', 'owner-a', 'a'],
    ['org-b', 'owner-b', 'b'],
  ] as const) {
    database
      .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, 'server.start', 'server', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
      .run(
        `operation-${suffix}`,
        org,
        `server-${suffix}`,
        owner,
        `idempotency-${suffix}`,
        `correlation-${org}`,
        timestamp,
        timestamp,
      )
    insertCompleteAudit(
      `audit-${suffix}`,
      org,
      owner,
      'server.start',
      'server',
      `server-${suffix}`,
      `correlation-${org}`,
      `operation-${suffix}`,
      { safe: true },
    )
  }
}

describe('tenant-scoped inventory D1 repositories', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations) database.exec(readFileSync(migration, 'utf8'))
    insertFixture()
  })
  afterEach(() => database.close())

  it('lists only scoped rows across every tenant-owned inventory', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const providers = yield* ProviderInventory
        const nodes = yield* NodeInventory
        const servers = yield* GameServerInventory
        const backups = yield* BackupInventory
        const audit = yield* AuditEventInventory
        const operations = yield* OperationInventory
        const ctx = context('org-a', 'owner-a')
        return {
          providers: yield* providers.list(ctx, page(100)),
          allocations: yield* providers.listAllocations(ctx, page(100)),
          nodes: yield* nodes.list(ctx, page(100)),
          servers: yield* servers.list(ctx, page(100)),
          backups: yield* backups.list(ctx, page(100)),
          audit: yield* audit.list(ctx, page(100)),
          operations: yield* operations.list(ctx, page(100)),
        }
      }).pipe(Effect.provide(layer())),
    )
    expect(result.providers.items.map(({ id }) => id).sort()).toEqual([
      'account-a',
      'account-platform',
    ])
    expect(
      result.allocations.items.map(({ providerAccountId }) => providerAccountId).sort(),
    ).toEqual(['account-a', 'account-platform'])
    expect(result.nodes.items.map(({ id }) => id).sort()).toEqual(['node-a1', 'node-a2'])
    expect(result.servers.items.map(({ id }) => id)).toEqual(['server-a'])
    expect(result.backups.items.map(({ id }) => id)).toEqual(['backup-a'])
    expect(result.audit.items.map(({ id }) => id)).toEqual(['audit-a'])
    expect(result.operations.items.map(({ id }) => id)).toEqual(['operation-a'])
    expect(result.providers.items[0]).not.toHaveProperty('credentialReference')
    expect(result.backups.items[0]).not.toHaveProperty('r2Key')
  })

  it('returns non-disclosing NotFound results for every cross-organization detail ID', async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const providers = yield* ProviderInventory
        const nodes = yield* NodeInventory
        const servers = yield* GameServerInventory
        const backups = yield* BackupInventory
        const audit = yield* AuditEventInventory
        const operations = yield* OperationInventory
        const ctx = context('org-a', 'owner-a')
        return yield* Effect.all([
          Effect.result(providers.get(ctx, 'account-b')),
          Effect.result(providers.getAllocation(ctx, 'account-b')),
          Effect.result(nodes.get(ctx, 'node-b')),
          Effect.result(servers.get(ctx, 'server-b')),
          Effect.result(backups.get(ctx, 'backup-b')),
          Effect.result(audit.get(ctx, 'audit-b')),
          Effect.result(operations.get(ctx, 'operation-b')),
          Effect.result(nodes.get(ctx, 'node-missing')),
        ])
      }).pipe(Effect.provide(layer())),
    )
    expect(results).toHaveLength(8)
    for (const result of results) {
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'NotFoundError' } })
    }
  })

  it('does not expose a removed provider-account tombstone', async () => {
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('account-removed', 'organization', 'org-a', 'ovhcloud', 'account-removed.credentials',
       'disabled', 1, ?, ?)`)
      .run(timestamp, timestamp)
    database
      .prepare(`INSERT INTO secret_envelopes
      (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
       key_version, revision, created_at, rotated_at)
      VALUES ('org-a', 'account-removed.credentials', 'provider-account', 'account-removed',
       'ciphertext', 'wrapped-key', 1, 1, ?, NULL)`)
      .run(timestamp)
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-provider-remove', 'org-a', 'provider-account.remove', 'provider-account',
       'account-removed', 'owner-a', 'succeeded', 100, ?,
       'correlation-org-a', 1, ?, ?)`)
      .run('a'.repeat(64), timestamp, timestamp)
    insertCompleteAudit(
      'audit-provider-remove',
      'org-a',
      'owner-a',
      'provider-account.remove',
      'provider-account',
      'account-removed',
      'correlation-org-a',
      'operation-provider-remove',
      {},
    )
    const result = JSON.stringify({
      accountId: 'account-removed',
      organizationId: 'org-a',
      providerType: 'ovhcloud',
      action: 'remove',
      outcome: 'removed',
      accountStatus: null,
      revision: 2,
      operationId: 'operation-provider-remove',
      failureCategory: null,
      regionCount: 0,
      projectCount: 0,
      catalogItemCount: 0,
      completedAt: timestamp,
    })
    database
      .prepare(`INSERT INTO provider_account_action_idempotency
      (organization_id, idempotency_key, action, account_id, provider_type,
       request_fingerprint, expected_revision, credential_revision, result_revision,
       operation_id, operation_idempotency_key, audit_event_id, actor_id, response_json, finalized, created_at)
      VALUES ('org-a', 'remove-account-key', 'remove', 'account-removed', 'ovhcloud', ?, 1, 1, 2,
       'operation-provider-remove', ?, 'audit-provider-remove', 'owner-a', ?, 0, ?)`)
      .run('a'.repeat(64), 'a'.repeat(64), result, timestamp)
    database
      .prepare(`UPDATE provider_accounts SET status = 'disabled', revision = 2, updated_at = ?
       WHERE organization_id = 'org-a' AND id = 'account-removed' AND revision = 1`)
      .run(timestamp)
    database
      .prepare(`DELETE FROM secret_envelopes
       WHERE organization_id = 'org-a' AND id = 'account-removed.credentials' AND revision = 1`)
      .run()
    database
      .prepare(`UPDATE provider_account_action_idempotency SET finalized = 1
       WHERE organization_id = 'org-a' AND idempotency_key = 'remove-account-key'`)
      .run()
    database.exec('COMMIT')

    const inventory = await Effect.runPromise(
      Effect.gen(function* () {
        const providers = yield* ProviderInventory
        const scoped = context('org-a', 'owner-a')
        return {
          list: yield* providers.list(scoped, page(100)),
          get: yield* Effect.result(providers.get(scoped, 'account-removed')),
        }
      }).pipe(Effect.provide(layer())),
    )
    expect(inventory.list.items.map(({ id }) => id)).not.toContain('account-removed')
    expect(inventory.get).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'NotFoundError' },
    })
  })

  it('keeps pagination bounded and tenant-safe across page boundaries', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const nodes = yield* NodeInventory
        const ctx = context('org-a', 'owner-a')
        const first = yield* nodes.list(ctx, page(1))
        const second = yield* nodes.list(ctx, page(1, first.nextCursor))
        return { first, second }
      }).pipe(Effect.provide(layer())),
    )
    expect(result.first.items).toHaveLength(1)
    expect(result.first.nextCursor).toBe('offset:1')
    expect(result.second.items).toHaveLength(1)
    expect(result.second.nextCursor).toBeUndefined()
    expect([...result.first.items, ...result.second.items].map(({ id }) => id).sort()).toEqual([
      'node-a1',
      'node-a2',
    ])
    expect(() => page(101)).toThrow()
    expect(() => page(1, 'not-a-cursor')).toThrow()
  })

  it('requires a persisted organization even for global node images', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const images = yield* NodeImageInventory
        const unknown = context('org-missing', 'owner-a')
        return {
          list: yield* images.list(unknown, page(10)),
          get: yield* Effect.result(images.get(unknown, 'image-a')),
        }
      }).pipe(Effect.provide(layer())),
    )
    expect(result.list.items).toEqual([])
    expect(result.get).toMatchObject({ _tag: 'Failure', failure: { _tag: 'NotFoundError' } })
  })
})

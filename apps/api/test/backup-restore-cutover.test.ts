import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '@gridora/migrations'
import {
  CloudflareControlError,
  resourceComment,
  type CloudflareApiShape,
} from '@gridora/cloudflare-control'
import type { BackupD1Database, BackupD1Statement } from '@gridora/backup-d1'
import {
  applyBackupRestoreEndpointCutover,
  rollbackBackupRestoreEndpointCutover,
  type BackupWorkflowRuntimeBindings,
} from '../src/backup-workflow-runtime.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const now = '2026-08-23T12:00:00.000Z'
let loseRunResponses: string[] = []

class Statement implements BackupD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>) {
    return new Statement(this.database, this.sql, values)
  }
  async first(): Promise<unknown> {
    return this.database.prepare(this.sql).get(...(this.values as SQLInputValue[])) ?? null
  }
  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return {
      results: this.database.prepare(this.sql).all(...(this.values as SQLInputValue[])),
    }
  }
  async run() {
    const result = this.database.prepare(this.sql).run(...(this.values as SQLInputValue[]))
    const lost = loseRunResponses.findIndex((pattern) => this.sql.includes(pattern))
    if (lost >= 0) {
      loseRunResponses.splice(lost, 1)
      throw new Error('D1 response lost after statement commit')
    }
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const wrap = (
  database: DatabaseSync,
  loseNextBatchResponse: () => boolean = () => false,
): BackupD1Database => ({
  prepare: (sql) => new Statement(database, sql),
  batch: async (statements) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      database.exec('COMMIT')
      if (loseNextBatchResponse()) throw new Error('D1 response lost after commit')
      return results
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
      throw error
    }
  },
})

interface ProviderRecord {
  readonly id: string
  readonly type: 'A' | 'AAAA'
  readonly name: string
  content: string
  comment: string
}

const provider = (
  records: ReadonlyArray<ProviderRecord>,
  options: {
    readonly failPutName?: string
    readonly losePutResponseName?: string
    readonly beforePut?: (name: string) => void
  } = {},
) => {
  const byName = new Map(records.map((record) => [record.name, record]))
  const calls: string[] = []
  const api: CloudflareApiShape = {
    request: (request) => {
      calls.push(`${request.method}:${request.path}`)
      if (request.method === 'GET') {
        const query = new URL(`https://api.example${request.path}`).searchParams
        const name = query.get('name.exact')
        const record = name === null ? undefined : byName.get(name)
        return Effect.succeed({ result: record === undefined ? [] : [{ ...record }] })
      }
      if (request.method !== 'PUT' || typeof request.body !== 'object' || request.body === null)
        return Effect.fail(
          new CloudflareControlError({
            operation: 'test.provider',
            message: 'unsupported request',
            retryable: false,
          }),
        )
      const body = request.body as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name : ''
      options.beforePut?.(name)
      if (options.failPutName === name)
        return Effect.fail(
          new CloudflareControlError({
            operation: 'test.put',
            message: 'injected provider failure',
            retryable: true,
          }),
        )
      const record = byName.get(name)
      if (
        record === undefined ||
        typeof body.content !== 'string' ||
        typeof body.comment !== 'string'
      )
        return Effect.fail(
          new CloudflareControlError({
            operation: 'test.put',
            message: 'provider record missing',
            retryable: false,
          }),
        )
      record.content = body.content
      record.comment = body.comment
      if (options.losePutResponseName === name)
        return Effect.fail(
          new CloudflareControlError({
            operation: 'test.put',
            message: 'response lost after provider commit',
            retryable: true,
          }),
        )
      return Effect.succeed({ result: { id: record.id } })
    },
  }
  return { api, calls, byName }
}

const seed = (database: DatabaseSync, sourceRecords = 1) => {
  database.exec(`
    INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('actor-a', 'access-a', 'owner@example.com', 'Owner', 'active', '${now}', '${now}');
    INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west',
       'complete', 1, 1, '${now}');
    INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES ('org-a', 'actor-a', 'owner', 'active', '${now}', 1);
    INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision,
       created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1,
       '${now}', '${now}');
    INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 5, 'active', 1);
    INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-a', '1.0.0', 'checksum-a', 'signature-a', '{}', 'promoted', '${now}');
    INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type,
       region, plan, image_id, placement_mode, desired_state, observed_state,
       desired_revision, observed_revision, created_at, updated_at)
      VALUES
      ('org-a', 'node-source', 'provider-a', 'instance-source', 'ovhcloud', 'eu-west',
       'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, '${now}', '${now}'),
      ('org-a', 'node-target', 'provider-a', 'instance-target', 'ovhcloud', 'eu-west',
       'small', 'image-a', 'shared', 'ready', 'ready', 1, 1, '${now}', '${now}');
    INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
    INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, desired_revision, observed_revision, active_config_revision,
       created_at, updated_at)
      VALUES
      ('org-a', 'server-source', 'Source', 'arma-reforger', '1.0.0', 'running', 'running',
       '{}', 3, 3, 1, '${now}', '${now}'),
      ('org-a', 'server-target', 'Target', 'arma-reforger', '1.0.0', 'running', 'running',
       '{}', 3, 3, 1, '${now}', '${now}');
    INSERT INTO deployments
      (organization_id, id, server_id, node_id, desired_revision, observed_revision,
       installed_build, observed_state, created_at, updated_at)
      VALUES
      ('org-a', 'deployment-source', 'server-source', 'node-source', 3, 3, 'build-a',
       'running', '${now}', '${now}'),
      ('org-a', 'deployment-target', 'server-target', 'node-target', 3, 3, 'build-a',
       'running', '${now}', '${now}');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('restore-operation', 'org-a', 'restore-backup', 'game-server', 'server-target',
       'actor-a', 'running', 40, 'restore-operation-key', 'correlation-a', 1, '${now}', '${now}');
    INSERT INTO port_leases
      (organization_id, id, node_id, server_id, protocol, public_port, container_port,
       state, operation_id, revision, created_at)
      VALUES ('org-a', 'target-port', 'node-target', 'server-target', 'udp', 2001, 2001,
       'active', 'restore-operation', 1, '${now}');
    INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json,
       state, created_at, expires_at, revision)
      VALUES ('org-a', 'backup-a', 'server-source',
       'organizations/org-a/servers/server-source/backups/backup-a',
       'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1,
       '{"pluginId":"arma-reforger","pluginVersion":"1.0.0","gameBuild":"build-a","configRevision":1,"modSetRevision":0,"desiredRevision":3,"nodeId":"node-source","consistency":"plugin-quiesced","includes":["config","data"],"containsGameBinaries":false}',
       'available', '${now}', NULL, 1);
    INSERT INTO backup_jobs
      (organization_id, id, operation_id, mode, trigger, backup_id, source_server_id,
       target_server_id, source_node_id, target_node_id, idempotency_key, fingerprint,
       completion_fingerprint, request_json, state, revision, created_at, updated_at,
       cancelled_at, audit_request_context_json, audit_actor_type)
      VALUES ('org-a', 'restore-job', 'restore-operation', 'restore', 'manual', 'backup-a',
       'server-source', 'server-target', 'node-source', 'node-target', 'restore-job-key',
       '${'a'.repeat(64)}', NULL, '{}', 'running', 1, '${now}', '${now}', NULL,
       '{"origin":"http","requestId":"request-a","correlationId":"correlation-a","source":{"ip":{"state":"captured","value":"203.0.113.7"},"access":{"state":"captured","value":{"subject":"access-a","identityId":"actor-a","issuer":"https://access.example.com","email":"owner@example.com"}}}}',
       'human');
    INSERT INTO dns_records
      (organization_id, id, server_id, provider_record_id, hostname, target,
       proxy_mode, state, revision)
      VALUES ('org-a', 'target-dns', 'server-target', 'cf-target', 'target.example.com',
       '192.0.2.20', 'dns_only', 'active', 1);
  `)
  for (let index = 0; index < sourceRecords; index += 1)
    database
      .prepare(`INSERT INTO dns_records
        (organization_id, id, server_id, provider_record_id, hostname, target,
         proxy_mode, state, revision)
        VALUES ('org-a', ?, 'server-source', ?, ?, '192.0.2.10', 'dns_only', 'active', 1)`)
      .run(`source-dns-${index}`, `cf-source-${index}`, `game-${index}.example.com`)
}

const cutoverInput = {
  effectId: 'restore-cutover-effect',
  organizationId: 'org-a',
  jobId: 'restore-job',
  sourceServerId: 'server-source',
  targetServerId: 'server-target',
  targetNodeId: 'node-target',
} as const

describe('backup restore endpoint cutover saga', () => {
  let database: DatabaseSync
  let loseBatch = false
  beforeEach(() => {
    loseRunResponses = []
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
  })
  afterEach(() => database.close())

  const bindings = (api: CloudflareApiShape): BackupWorkflowRuntimeBindings => ({
    database: wrap(database, () => {
      const lose = loseBatch
      loseBatch = false
      return lose
    }),
    cloudflare: api,
    dnsZoneId: 'zone-a',
    nodeCoordinator: {} as BackupWorkflowRuntimeBindings['nodeCoordinator'],
    signingKey: { get: async () => '' },
    internalSecret: 'internal-secret',
  })

  it('rejects a missing target DNS row even when a stale global fallback is supplied', async () => {
    seed(database)
    database.prepare(`DELETE FROM dns_records WHERE id = 'target-dns'`).run()
    const cloudflare = provider([
      {
        id: 'cf-source-0',
        type: 'A',
        name: 'game-0.example.com',
        content: '192.0.2.10',
        comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
      },
    ])
    const staleBindings = { ...bindings(cloudflare.api), dnsTarget: '192.0.2.99' }
    const result = await Effect.runPromise(
      Effect.result(applyBackupRestoreEndpointCutover(staleBindings, cutoverInput)),
    )
    expect(result._tag).toBe('Failure')
    expect(cloudflare.calls).toEqual([])
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM backup_restore_endpoint_effects`).get(),
    ).toEqual({ count: 0 })
  })

  it('rejects multiple target DNS rows even when they contain the same address', async () => {
    seed(database)
    database
      .prepare(`INSERT INTO dns_records
        (organization_id, id, server_id, provider_record_id, hostname, target,
         proxy_mode, state, revision)
        VALUES ('org-a', 'target-dns-duplicate', 'server-target', 'cf-target-duplicate',
          'target-duplicate.example.com', '192.0.2.20', 'dns_only', 'active', 1)`)
      .run()
    const cloudflare = provider([
      {
        id: 'cf-source-0',
        type: 'A',
        name: 'game-0.example.com',
        content: '192.0.2.10',
        comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
      },
    ])
    const result = await Effect.runPromise(
      Effect.result(applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput)),
    )
    expect(result._tag).toBe('Failure')
    expect(cloudflare.calls).toEqual([])
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM backup_restore_endpoint_effects`).get(),
    ).toEqual({ count: 0 })
  })

  it('persists the immutable plan, adopts provider response loss, and rolls back exact state', async () => {
    seed(database)
    const cloudflare = provider(
      [
        {
          id: 'cf-source-0',
          type: 'A',
          name: 'game-0.example.com',
          content: '192.0.2.10',
          comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
        },
      ],
      { losePutResponseName: 'game-0.example.com' },
    )
    await expect(
      Effect.runPromise(applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput)),
    ).resolves.toEqual({ cutover: true, sourcePreserved: true })
    expect(
      database
        .prepare(`SELECT effect_id AS effectId, state FROM backup_restore_endpoint_effects`)
        .get(),
    ).toEqual({ effectId: cutoverInput.effectId, state: 'applied' })
    expect(
      database
        .prepare(`SELECT server_id AS serverId, target, revision FROM dns_records
          WHERE id = 'source-dns-0'`)
        .get(),
    ).toEqual({ serverId: 'server-target', target: '192.0.2.20', revision: 2 })
    loseRunResponses = ['INSERT INTO backup_restore_endpoint_rollbacks']
    loseBatch = true
    await expect(
      Effect.runPromise(
        rollbackBackupRestoreEndpointCutover(bindings(cloudflare.api), {
          ...cutoverInput,
          effectId: 'restore-rollback-effect',
        }),
      ),
    ).resolves.toEqual({ rolledBack: true, sourcePreserved: true })
    expect(loseRunResponses).toEqual([])
    expect(
      database
        .prepare(`SELECT server_id AS serverId, target, revision FROM dns_records
          WHERE id = 'source-dns-0'`)
        .get(),
    ).toEqual({ serverId: 'server-source', target: '192.0.2.10', revision: 3 })
    expect(cloudflare.byName.get('game-0.example.com')).toMatchObject({
      content: '192.0.2.10',
      comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
    })
  })

  it('adopts an exact D1 commit after response loss without compensating provider state', async () => {
    seed(database)
    const cloudflare = provider([
      {
        id: 'cf-source-0',
        type: 'A',
        name: 'game-0.example.com',
        content: '192.0.2.10',
        comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
      },
    ])
    loseBatch = true
    await expect(
      Effect.runPromise(applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput)),
    ).resolves.toEqual({ cutover: true, sourcePreserved: true })
    expect(cloudflare.byName.get('game-0.example.com')).toMatchObject({
      content: '192.0.2.20',
      comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-target' }),
    })
    expect(cloudflare.calls.filter((call) => call.startsWith('PUT:'))).toHaveLength(1)
  })

  it('adopts immutable effect and provider receipts after individual D1 responses are lost', async () => {
    seed(database)
    const cloudflare = provider([
      {
        id: 'cf-source-0',
        type: 'A',
        name: 'game-0.example.com',
        content: '192.0.2.10',
        comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
      },
    ])
    loseRunResponses = [
      'INSERT INTO backup_restore_endpoint_effects',
      'INSERT INTO backup_restore_endpoint_provider_receipts',
    ]
    await expect(
      Effect.runPromise(applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput)),
    ).resolves.toEqual({ cutover: true, sourcePreserved: true })
    expect(loseRunResponses).toEqual([])
    expect(cloudflare.calls.filter((call) => call.startsWith('PUT:'))).toHaveLength(1)
    expect(
      database
        .prepare(`SELECT state FROM backup_restore_endpoint_provider_receipts
          WHERE record_id = 'source-dns-0'`)
        .get(),
    ).toEqual({ state: 'applied' })
  })

  it('compensates completed provider items in reverse after a mid-plan failure', async () => {
    seed(database, 2)
    const cloudflare = provider(
      [0, 1].map((index) => ({
        id: `cf-source-${index}`,
        type: 'A' as const,
        name: `game-${index}.example.com`,
        content: '192.0.2.10',
        comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
      })),
      { failPutName: 'game-1.example.com' },
    )
    const result = await Effect.runPromise(
      Effect.result(applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput)),
    )
    expect(result._tag).toBe('Failure')
    expect(
      database
        .prepare(`SELECT id, server_id AS serverId, target, revision FROM dns_records
          WHERE server_id = 'server-source' ORDER BY id`)
        .all(),
    ).toEqual([
      { id: 'source-dns-0', serverId: 'server-source', target: '192.0.2.10', revision: 1 },
      { id: 'source-dns-1', serverId: 'server-source', target: '192.0.2.10', revision: 1 },
    ])
    expect([...cloudflare.byName.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'game-0.example.com', content: '192.0.2.10' }),
        expect.objectContaining({ name: 'game-1.example.com', content: '192.0.2.10' }),
      ]),
    )
    await expect(
      Effect.runPromise(
        rollbackBackupRestoreEndpointCutover(bindings(cloudflare.api), {
          ...cutoverInput,
          effectId: 'rollback-after-provider-failure',
        }),
      ),
    ).resolves.toEqual({ rolledBack: true, sourcePreserved: true })
    expect(
      database
        .prepare(`SELECT effect.state, rollback.state AS rollbackState
          FROM backup_restore_endpoint_effects effect
          JOIN backup_restore_endpoint_rollbacks rollback
            ON rollback.organization_id = effect.organization_id AND rollback.job_id = effect.job_id`)
        .get(),
    ).toEqual({ state: 'rolled_back', rollbackState: 'applied' })
  })

  it('rejects a stale D1 row and compensates the already-applied provider transfer', async () => {
    seed(database)
    let changed = false
    const cloudflare = provider(
      [
        {
          id: 'cf-source-0',
          type: 'A',
          name: 'game-0.example.com',
          content: '192.0.2.10',
          comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
        },
      ],
      {
        beforePut: () => {
          if (changed) return
          changed = true
          database.prepare(`UPDATE dns_records SET revision = 2 WHERE id = 'source-dns-0'`).run()
        },
      },
    )
    const result = await Effect.runPromise(
      Effect.result(applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput)),
    )
    expect(result._tag).toBe('Failure')
    expect(cloudflare.byName.get('game-0.example.com')).toMatchObject({
      content: '192.0.2.10',
      comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
    })
    expect(
      database
        .prepare(
          `SELECT server_id AS serverId, revision FROM dns_records WHERE id = 'source-dns-0'`,
        )
        .get(),
    ).toEqual({
      serverId: 'server-source',
      revision: 2,
    })
  })

  it('rejects a foreign rollback effect after the exact effect was adopted', async () => {
    seed(database)
    const cloudflare = provider([
      {
        id: 'cf-source-0',
        type: 'A',
        name: 'game-0.example.com',
        content: '192.0.2.10',
        comment: resourceComment({ organizationId: 'org-a', ownerResourceId: 'server-source' }),
      },
    ])
    await Effect.runPromise(
      applyBackupRestoreEndpointCutover(bindings(cloudflare.api), cutoverInput),
    )
    await Effect.runPromise(
      rollbackBackupRestoreEndpointCutover(bindings(cloudflare.api), {
        ...cutoverInput,
        effectId: 'restore-rollback-effect',
      }),
    )
    const foreign = await Effect.runPromise(
      Effect.result(
        rollbackBackupRestoreEndpointCutover(bindings(cloudflare.api), {
          ...cutoverInput,
          effectId: 'foreign-rollback-effect',
        }),
      ),
    )
    expect(foreign._tag).toBe('Failure')
  })

  it('records an exact pre-cutover rollback without calling Cloudflare after validation fails', async () => {
    seed(database)
    const calls: unknown[] = []
    const noProviderMutation: CloudflareApiShape = {
      request: (request) => {
        calls.push(request)
        return Effect.fail(
          new CloudflareControlError({
            operation: 'unexpected',
            message: 'provider must not be called before cutover planning',
            retryable: false,
          }),
        )
      },
    }
    const rollbackInput = { ...cutoverInput, effectId: 'validation-rollback-effect' }
    loseRunResponses = ['INSERT INTO backup_restore_pre_cutover_rollbacks']
    await expect(
      Effect.runPromise(
        rollbackBackupRestoreEndpointCutover(bindings(noProviderMutation), rollbackInput),
      ),
    ).resolves.toEqual({ rolledBack: true, sourcePreserved: true })
    expect(loseRunResponses).toEqual([])
    await expect(
      Effect.runPromise(
        rollbackBackupRestoreEndpointCutover(bindings(noProviderMutation), rollbackInput),
      ),
    ).resolves.toEqual({ rolledBack: true, sourcePreserved: true })
    expect(calls).toEqual([])
    expect(
      database
        .prepare(`SELECT rollback_effect_id AS rollbackEffectId
          FROM backup_restore_pre_cutover_rollbacks`)
        .get(),
    ).toEqual({ rollbackEffectId: rollbackInput.effectId })
    const foreign = await Effect.runPromise(
      Effect.result(
        rollbackBackupRestoreEndpointCutover(bindings(noProviderMutation), {
          ...rollbackInput,
          effectId: 'foreign-validation-rollback',
        }),
      ),
    )
    expect(foreign._tag).toBe('Failure')
  })
})

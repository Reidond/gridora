import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeOrganizationDeletionD1Repository,
  makeTerminationD1Repository,
  type LifecycleTerminationD1Database,
  type LifecycleTerminationD1Statement,
} from '@gridora/lifecycle-termination-d1'
import { makeGameLifecycleCompletionD1Repository } from '@gridora/game-lifecycle-d1'
import {
  BackupControl,
  BackupPersistenceError,
  BackupRepository,
  makeBackupControlLayer,
} from '@gridora/backup-control'
import {
  BackupD1ClientLayer,
  BackupRepositoryD1Live,
  type BackupD1Database,
} from '@gridora/backup-d1'
import { deleteBackupObjectPrefix, type BackupR2DeletionBucketShape } from '@gridora/backup-r2'
import type { OrganizationContext } from '@gridora/domain'
import {
  cleanupOrganizationDeletionBackup,
  executeOrganizationDeletionStep,
  organizationBackupRetentionDecision,
  hasTerminalBackupDeletionReceipt,
  hasTerminalGameDeletionReceipt,
  hasTerminalNodeRetirementReceipt,
  startOrganizationDeletionWorkflow,
} from '../src/organization-deletion-runtime.js'

const migrationDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)
const now = '2026-08-23T12:00:00.000Z'

class Statement implements LifecycleTerminationD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>) {
    return new Statement(this.database, this.sql, values)
  }
  async first<T = unknown>(): Promise<T | null> {
    return (
      (this.database.prepare(this.sql).get(...(this.values as SQLInputValue[])) as T | undefined) ??
      null
    )
  }
  async all<T = unknown>(): Promise<{ readonly results: ReadonlyArray<T> }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as SQLInputValue[])) as unknown as ReadonlyArray<T>,
    }
  }
  run() {
    const result = this.database.prepare(this.sql).run(...(this.values as SQLInputValue[]))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const wrap = (database: DatabaseSync): LifecycleTerminationD1Database => ({
  prepare: (sql) => new Statement(database, sql),
  batch: async (statements) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => (statement as Statement).run())
      database.exec('COMMIT')
      return results
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  },
})

const auditRequest = {
  origin: 'http' as const,
  requestId: 'request-a',
  correlationId: 'correlation-a',
  source: {
    ip: { state: 'captured' as const, value: '203.0.113.7' },
    access: {
      state: 'captured' as const,
      value: {
        subject: 'access-a',
        identityId: 'actor-a',
        issuer: 'https://access.example.com',
        email: 'owner@example.com',
      },
    },
  },
}

let database: DatabaseSync | undefined

afterEach(() => {
  database?.close()
  database = undefined
})

const acceptedDeletion = async (backupPolicy: 'retain' | 'delete-after-retention' = 'retain') => {
  database = new DatabaseSync(':memory:')
  for (const migration of readdirSync(migrationDirectory)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort())
    database.exec(readFileSync(`${migrationDirectory}${migration}`, 'utf8'))
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
  `)
  const d1 = wrap(database)
  const acceptance = await Effect.runPromise(
    makeTerminationD1Repository(d1, {
      now: () => now,
      operationId: () => 'delete-operation-a',
      auditEventId: () => 'audit-delete-operation-a',
      outboxEventId: () => 'outbox-delete-operation-a',
      workflowStartRecordId: (operationId) => `start-${operationId}`,
      auditRequestContext: auditRequest,
    }).acceptOrganizationDeletion(
      {
        organizationId: 'org-a',
        actorId: 'actor-a',
        role: 'owner',
        correlationId: 'correlation-a',
        idempotencyKey: 'delete-organization-key-a',
        expectedOrganizationRevision: 1,
        typedSlug: 'organization-a',
        backupPolicy,
      },
      'a'.repeat(64),
    ),
  )
  return { acceptance, d1 }
}

const physicalBackupControl = (
  d1: LifecycleTerminationD1Database,
  objects: Set<string>,
  completedAt: string,
) => {
  const repositoryLayer = BackupRepositoryD1Live.pipe(
    Layer.provide(BackupD1ClientLayer(d1 as unknown as BackupD1Database)),
  )
  const backupRepository = Effect.runSync(
    Effect.service(BackupRepository).pipe(Effect.provide(repositoryLayer)),
  )
  const bucket: BackupR2DeletionBucketShape = {
    list: async ({ prefix }) => ({
      objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
    }),
    delete: async (keys) => {
      for (const key of keys) objects.delete(key)
    },
  }
  return Effect.runSync(
    Effect.service(BackupControl).pipe(
      Effect.provide(
        makeBackupControlLayer({
          repository: backupRepository,
          clock: { now: Effect.succeed(completedAt) },
          plugin: { validateRestore: () => Effect.void },
          facts: {
            resolveCreate: () => Effect.die('unused create facts port'),
            resolveRestore: () => Effect.die('unused restore facts port'),
          },
          deletion: {
            remove: (input) =>
              deleteBackupObjectPrefix(bucket, input.r2Key).pipe(
                Effect.mapError(
                  () => new BackupPersistenceError({ operation: 'test.backup-r2.delete' }),
                ),
              ),
          },
        }),
      ),
    ),
  )
}

describe('organization deletion runtime', () => {
  it('keeps a deleted server pending until its exact operation-bound DNS receipt exists', async () => {
    await expect(
      Effect.runPromise(
        hasTerminalGameDeletionReceipt(() => Effect.fail(new Error('foreign receipt'))),
      ),
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(
        hasTerminalGameDeletionReceipt(() =>
          Effect.succeed({ operationId: 'exact-child-operation', state: 'deleted' }),
        ),
      ),
    ).resolves.toBe(true)
  })

  it('keeps an observed-deleted node pending until its exact retirement receipt exists', async () => {
    await expect(
      Effect.runPromise(
        hasTerminalNodeRetirementReceipt(() =>
          Effect.fail(new Error('foreign child retirement operation')),
        ),
      ),
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(
        hasTerminalNodeRetirementReceipt(() =>
          Effect.succeed({ childOperationId: 'exact-retire-child', state: 'deleted' }),
        ),
      ),
    ).resolves.toBe(true)
  })

  it('keeps an expired or D1-deleted backup pending without exact physical R2 evidence', async () => {
    await expect(
      Effect.runPromise(
        hasTerminalBackupDeletionReceipt(() =>
          Effect.fail(new Error('physical deletion receipt missing')),
        ),
      ),
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(
        hasTerminalBackupDeletionReceipt(() =>
          Effect.succeed({
            operationId: 'backup-retention-operation-a',
            backupId: 'backup-a',
            r2Key: 'organizations/org-a/servers/server-a/backups/backup-a',
          }),
        ),
      ),
    ).resolves.toBe(true)
  })

  it('waits for exact retention expiry and never treats missing or malformed expiry as deletable', () => {
    expect(
      organizationBackupRetentionDecision('2026-09-01T12:00:00.000Z', '2026-08-23T12:00:00.000Z'),
    ).toEqual({
      state: 'waiting',
      nextAttemptAt: '2026-09-01T12:00:00.000Z',
      recoveryDeadlineAt: '2026-09-02T12:00:00.000Z',
    })
    expect(organizationBackupRetentionDecision(null, '2026-08-23T12:00:00.000Z')).toEqual({
      state: 'ambiguous',
    })
    expect(
      organizationBackupRetentionDecision('not-an-instant', '2026-08-23T12:00:00.000Z'),
    ).toEqual({ state: 'ambiguous' })
  })

  it('allows deletion only at or after the exact retained instant', () => {
    expect(
      organizationBackupRetentionDecision('2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z'),
    ).toEqual({ state: 'deletable' })
    expect(
      organizationBackupRetentionDecision('2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.001Z'),
    ).toEqual({ state: 'deletable' })
  })

  it('physically removes failed upload chunks through the organization deletion cleanup seam', async () => {
    const { acceptance, d1 } = await acceptedDeletion('delete-after-retention')
    const r2Key = 'organizations/org-a/servers/server-a/backups/backup-failed-upload'
    database!.exec(`
      INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status,
         revision, created_at, updated_at)
        VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'credential-a',
          'active', 1, '${now}', '${now}');
      INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at)
        VALUES ('image-a', '1.0.0',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'signature-a', '{"ovhcloud":{"eu-west":"image-a"}}', 'promoted', '${now}');
      INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
         max_active_nodes, status, revision)
        VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1);
      INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_type, region, plan, image_id,
         placement_mode, desired_state, observed_state, desired_revision, observed_revision,
         created_at, updated_at)
        VALUES ('org-a', 'node-a', 'provider-a', 'ovhcloud', 'eu-west', 'small', 'image-a',
          'shared', 'ready', 'ready', 1, 1, '${now}', '${now}');
      INSERT INTO game_plugins
        (id, version, api_version, status, capability_manifest_json, config_schema_version)
        VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
      INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, desired_revision, observed_revision, active_config_revision,
         created_at, updated_at)
        VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running',
          'running', '{}', 1, 1, 1, '${now}', '${now}');
      INSERT INTO deployments
        (organization_id, id, server_id, node_id, desired_revision, observed_revision,
         installed_build, observed_state, created_at, updated_at)
        VALUES ('org-a', 'deployment-a', 'server-a', 'node-a', 1, 1, 'build-a',
          'running', '${now}', '${now}');
      INSERT INTO backups
        (organization_id, id, server_id, r2_key, checksum, encryption_version,
         metadata_json, state, revision, created_at, expires_at)
        VALUES ('org-a', 'backup-failed-upload', 'server-a', '${r2Key}',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1,
          '{"pluginId":"arma-reforger","pluginVersion":"1.0.0","gameBuild":"build-a","configRevision":1,"modSetRevision":0,"desiredRevision":1,"nodeId":"node-a","consistency":"plugin-quiesced","includes":["config"],"containsGameBinaries":false}',
          'failed', 2, '${now}', NULL);
      INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES ('backup-create-failed', 'org-a', 'backup-game-server', 'game-server',
          'server-a', 'actor-a', 'failed_terminal', 100,
          'backup-create-failed-key', 'correlation-a', 2, '${now}', '${now}');
      INSERT INTO backup_jobs
        (organization_id, id, operation_id, mode, trigger, backup_id, source_server_id,
         target_server_id, source_node_id, target_node_id, idempotency_key, fingerprint,
         completion_fingerprint, request_json, state, revision, created_at, updated_at,
         cancelled_at, audit_request_context_json, audit_actor_type)
        VALUES ('org-a', 'backup-job-failed', 'backup-create-failed', 'create', 'manual',
          'backup-failed-upload', 'server-a', NULL, 'node-a', NULL,
          'backup-job-failed-key', '${'c'.repeat(64)}', NULL, '{}', 'failed_terminal', 2,
          '${now}', '${now}', NULL, '${JSON.stringify(auditRequest)}', 'human');
    `)
    const deletionRepository = makeOrganizationDeletionD1Repository(d1)
    await Effect.runPromise(
      deletionRepository.inventory({
        organizationId: 'org-a',
        operationId: acceptance.operation.id,
        now,
      }),
    )
    expect(
      database!
        .prepare(`SELECT state FROM organization_deletion_items
          WHERE organization_id = 'org-a' AND operation_id = ?
            AND kind = 'backup' AND resource_id = 'backup-failed-upload'`)
        .get(acceptance.operation.id),
    ).toEqual({ state: 'pending' })

    const repositoryLayer = BackupRepositoryD1Live.pipe(
      Layer.provide(BackupD1ClientLayer(d1 as unknown as BackupD1Database)),
    )
    const backupRepository = Effect.runSync(
      Effect.service(BackupRepository).pipe(Effect.provide(repositoryLayer)),
    )
    const objects = new Set([`${r2Key}/chunks/00000000.bin`, `${r2Key}/chunks/00000001.bin`])
    const bucket: BackupR2DeletionBucketShape = {
      list: async ({ prefix }) => ({
        objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys) => {
        for (const key of keys) objects.delete(key)
      },
    }
    const backupControl = Effect.runSync(
      Effect.service(BackupControl).pipe(
        Effect.provide(
          makeBackupControlLayer({
            repository: backupRepository,
            clock: { now: Effect.succeed('2026-08-23T12:00:01.000Z') },
            plugin: { validateRestore: () => Effect.void },
            facts: {
              resolveCreate: () => Effect.die('unused create facts port'),
              resolveRestore: () => Effect.die('unused restore facts port'),
            },
            deletion: {
              remove: (input) =>
                deleteBackupObjectPrefix(bucket, input.r2Key).pipe(
                  Effect.mapError(
                    () => new BackupPersistenceError({ operation: 'test.backup-r2.delete' }),
                  ),
                ),
            },
          }),
        ),
      ),
    )
    const cleanup = await Effect.runPromise(
      cleanupOrganizationDeletionBackup(
        d1 as unknown as BackupD1Database,
        backupControl,
        {
          organizationId: 'org-a',
          organizationSlug: 'organization-a',
          identityId: 'actor-a',
          role: 'owner',
          correlationId: 'correlation-a',
          auditRequestContext: auditRequest,
        } as unknown as OrganizationContext,
        {
          backupId: 'backup-failed-upload',
          revision: 2,
          state: 'failed',
          expiresAt: null,
          abandonedCleanupReady: true,
          mandatoryDeletionBackup: false,
        },
        '2026-08-23T12:00:01.000Z',
      ),
    )
    expect(cleanup.state).toBe('deleted')
    expect(objects.size).toBe(0)
    if (cleanup.state !== 'deleted') throw new Error('cleanup did not produce a receipt')
    await Effect.runPromise(
      deletionRepository.markItemResolved({
        organizationId: 'org-a',
        operationId: acceptance.operation.id,
        now: '2026-08-23T12:00:02.000Z',
        kind: 'backup',
        resourceId: 'backup-failed-upload',
        disposition: 'resolved',
        evidence: {
          state: 'deleted',
          physicalDeletionOperationId: cleanup.receipt.operationId,
          physicalDeletionClaimId: cleanup.receipt.claimId,
        },
      }),
    )
    expect(
      database!
        .prepare(`SELECT item.state, backup.state AS backupState,
          receipt.source_job_id AS sourceJobId, receipt.deleted_objects AS deletedObjects
          FROM organization_deletion_items item
          JOIN backups backup ON backup.organization_id = item.organization_id
            AND backup.id = item.resource_id
          JOIN backup_physical_deletion_receipts receipt
            ON receipt.organization_id = backup.organization_id AND receipt.backup_id = backup.id
          WHERE item.organization_id = 'org-a' AND item.operation_id = ?
            AND item.kind = 'backup' AND item.resource_id = 'backup-failed-upload'`)
        .get(acceptance.operation.id),
    ).toEqual({
      state: 'resolved',
      backupState: 'deleted',
      sourceJobId: 'backup-job-failed',
      deletedObjects: 2,
    })
  })

  it('refreshes a terminal server child backup, deletes it immediately, and adopts a repeated drain', async () => {
    const { acceptance, d1 } = await acceptedDeletion('delete-after-retention')
    database!.exec(`
      INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status,
         revision, created_at, updated_at)
        VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'credential-a',
          'active', 1, '${now}', '${now}');
      INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at)
        VALUES ('image-a', '1.0.0',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'signature-a', '{"ovhcloud":{"eu-west":"image-a"}}', 'promoted', '${now}');
      INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
         max_active_nodes, status, revision)
        VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1);
      INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_type, region, plan, image_id,
         placement_mode, desired_state, observed_state, desired_revision, observed_revision,
         created_at, updated_at)
        VALUES ('org-a', 'node-a', 'provider-a', 'ovhcloud', 'eu-west', 'small', 'image-a',
          'shared', 'ready', 'ready', 1, 1, '${now}', '${now}');
      INSERT INTO game_plugins
        (id, version, api_version, status, capability_manifest_json, config_schema_version)
        VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
      INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, desired_revision, observed_revision, active_config_revision,
         created_at, updated_at)
        VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running',
          'running', '{}', 1, 1, 1, '${now}', '${now}');
      INSERT INTO deployments
        (organization_id, id, server_id, node_id, desired_revision, observed_revision,
         installed_build, observed_state, created_at, updated_at)
        VALUES ('org-a', 'deployment-a', 'server-a', 'node-a', 1, 1, 'build-a',
          'running', '${now}', '${now}');
    `)
    const deletionRepository = makeOrganizationDeletionD1Repository(d1)
    await Effect.runPromise(
      deletionRepository.inventory({
        organizationId: 'org-a',
        operationId: acceptance.operation.id,
        now,
      }),
    )
    expect(
      database!
        .prepare(`SELECT COUNT(*) AS count FROM organization_deletion_items
          WHERE organization_id = 'org-a' AND operation_id = ? AND kind = 'backup'`)
        .get(acceptance.operation.id),
    ).toEqual({ count: 0 })

    const planning = {
      readPlanningFacts: () => Effect.succeed({ nodes: [], catalog: [] }),
      readWorkflowData: () => Effect.fail(new Error('simulated lost Workflow response')),
      markWorkflowStarted: () => Effect.void,
    }
    const env = {
      DB: d1,
      DELETE_ORGANIZATION: {},
      RETIRE_NODE: {},
    } as unknown as Parameters<typeof executeOrganizationDeletionStep>[0]
    const noObjects = new Set<string>()
    const first = await Effect.runPromise(
      executeOrganizationDeletionStep(
        env,
        {
          planning: planning as unknown as Parameters<
            typeof executeOrganizationDeletionStep
          >[1]['planning'],
          deletionWorkflow: {
            create: async () => {
              throw new Error('simulated lost create response')
            },
            get: async (id: string) => ({ id }),
          },
          backup: physicalBackupControl(d1, noObjects, '2026-08-23T12:03:00.000Z'),
        },
        {
          organizationId: 'org-a',
          operationId: acceptance.operation.id,
          resourceId: 'org-a',
          stepName: 'drain-deployments',
          now,
        },
      ),
    )
    expect(first.status).toBe('waiting')
    const child = database!
      .prepare(`SELECT child_operation_id AS childOperationId, state
        FROM organization_deletion_child_operations
        WHERE organization_id = 'org-a' AND parent_operation_id = ?
          AND kind = 'game-server' AND resource_id = 'server-a'`)
      .get(acceptance.operation.id) as { childOperationId: string; state: string }
    expect(child.state).toBe('accepted')

    const backupId = 'backup-required-by-org-delete'
    const r2Key = `organizations/org-a/servers/server-a/backups/${backupId}`
    database!.exec(`
      INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES ('backup-required-operation', 'org-a', 'backup-game-server', 'game-server',
          'server-a', 'actor-a', 'succeeded', 100, 'backup-required-operation-key',
          'correlation-a', 2, '${now}', '${now}');
      INSERT INTO backups
        (organization_id, id, server_id, r2_key, checksum, encryption_version,
         metadata_json, state, revision, created_at, expires_at)
        VALUES ('org-a', '${backupId}', 'server-a', '${r2Key}',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1,
          '{"pluginId":"arma-reforger","pluginVersion":"1.0.0","gameBuild":"build-a","configRevision":1,"modSetRevision":0,"desiredRevision":1,"nodeId":"node-a","consistency":"plugin-quiesced","includes":["config"],"containsGameBinaries":false}',
          'available', 1, '${now}', NULL);
    `)
    database!
      .prepare(`INSERT INTO backup_jobs
        (organization_id, id, operation_id, mode, trigger, backup_id, source_server_id,
         target_server_id, source_node_id, target_node_id, idempotency_key, fingerprint,
         completion_fingerprint, request_json, state, revision, created_at, updated_at,
         cancelled_at, audit_request_context_json, audit_actor_type)
        VALUES ('org-a', 'backup-required-job', 'backup-required-operation', 'create', 'manual',
          ?, 'server-a', NULL, 'node-a', NULL, ?, ?, ?, '{}', 'succeeded', 2,
          ?, ?, NULL, ?, 'human')`)
      .run(
        backupId,
        `game-lifecycle:${child.childOperationId}:backup`,
        'c'.repeat(64),
        'd'.repeat(64),
        now,
        now,
        JSON.stringify(auditRequest),
      )
    database!
      .prepare(`INSERT INTO game_observation_reductions
        (organization_id, server_id, observed_revision, observed_state, operation_id,
         observation_json, observed_at)
        VALUES ('org-a', 'server-a', 2, 'deleted', ?, '{"state":"deleted"}', ?)`)
      .run(child.childOperationId, '2026-08-23T12:01:00.000Z')
    await Effect.runPromise(
      makeGameLifecycleCompletionD1Repository(d1).complete({
        organizationId: 'org-a',
        lifecycleOperationId: child.childOperationId,
        serverId: 'server-a',
        action: 'delete',
        stepName: 'verify-observation',
        evidence: { test: 'exact terminal child evidence' },
        now: '2026-08-23T12:02:00.000Z',
      }),
    )
    database!
      .prepare(`UPDATE deployments SET observed_state = 'deleted', observed_revision = desired_revision,
        updated_at = ? WHERE organization_id = 'org-a' AND id = 'deployment-a'`)
      .run('2026-08-23T12:02:00.000Z')
    const objects = new Set([`${r2Key}/chunks/00000000.bin`, `${r2Key}/manifest.json`])
    const game = {
      planning: planning as unknown as Parameters<
        typeof executeOrganizationDeletionStep
      >[1]['planning'],
      deletionWorkflow: undefined,
      backup: physicalBackupControl(d1, objects, '2026-08-23T12:03:00.000Z'),
    } as unknown as Parameters<typeof executeOrganizationDeletionStep>[1]
    await expect(
      Effect.runPromise(
        executeOrganizationDeletionStep(env, game, {
          organizationId: 'org-a',
          operationId: acceptance.operation.id,
          resourceId: 'org-a',
          stepName: 'drain-deployments',
          now: '2026-08-23T12:03:00.000Z',
        }),
      ),
    ).resolves.toEqual({ status: 'completed' })
    expect(objects.size).toBe(0)
    expect(
      database!
        .prepare(`SELECT item.state, backup.state AS backupState,
          child.state AS childState, receipt.r2_key AS deletedPrefix
          FROM organization_deletion_items item
          JOIN backups backup ON backup.organization_id = item.organization_id
            AND backup.id = item.resource_id
          JOIN organization_deletion_child_operations child
            ON child.organization_id = item.organization_id
           AND child.parent_operation_id = item.operation_id
           AND child.kind = 'game-server' AND child.resource_id = backup.server_id
          JOIN backup_physical_deletion_receipts receipt
            ON receipt.organization_id = backup.organization_id AND receipt.backup_id = backup.id
          WHERE item.organization_id = 'org-a' AND item.operation_id = ?
            AND item.kind = 'backup' AND item.resource_id = ?`)
        .get(acceptance.operation.id, backupId),
    ).toEqual({
      state: 'resolved',
      backupState: 'deleted',
      childState: 'succeeded',
      deletedPrefix: r2Key,
    })
    await expect(
      Effect.runPromise(
        executeOrganizationDeletionStep(env, game, {
          organizationId: 'org-a',
          operationId: acceptance.operation.id,
          resourceId: 'org-a',
          stepName: 'drain-deployments',
          now: '2026-08-23T12:03:30.000Z',
        }),
      ),
    ).resolves.toEqual({ status: 'completed' })
  })

  it('adopts the exact organization Workflow after a lost create response', async () => {
    const { acceptance, d1 } = await acceptedDeletion()
    const env = {
      DB: d1,
      DELETE_ORGANIZATION: {
        create: async () => {
          throw new Error('response lost')
        },
        get: async (id: string) => ({ id }),
      },
    } as unknown as Parameters<typeof startOrganizationDeletionWorkflow>[0]
    await expect(
      Effect.runPromise(
        startOrganizationDeletionWorkflow(
          env,
          acceptance,
          'actor-a',
          'correlation-a',
          'delete-organization-key-a',
        ),
      ),
    ).resolves.toBe('adopted')
    expect(
      database
        ?.prepare(`SELECT state, attempts FROM termination_workflow_starts
          WHERE organization_id = 'org-a' AND operation_id = 'delete-operation-a'`)
        .get(),
    ).toEqual({ state: 'adopted', attempts: 1 })
  })

  it('records a bounded reconciliation failure without inventing a Workflow start', async () => {
    const { acceptance, d1 } = await acceptedDeletion()
    const env = {
      DB: d1,
      DELETE_ORGANIZATION: {
        create: async () => {
          throw new Error('unavailable')
        },
        get: async () => {
          throw new Error('unavailable')
        },
      },
    } as unknown as Parameters<typeof startOrganizationDeletionWorkflow>[0]
    await expect(
      Effect.runPromise(
        startOrganizationDeletionWorkflow(
          env,
          acceptance,
          'actor-a',
          'correlation-a',
          'delete-organization-key-a',
        ),
      ),
    ).rejects.toThrow('start remains pending')
    expect(
      database
        ?.prepare(`SELECT state, attempts, last_error_code AS lastErrorCode
          FROM termination_workflow_starts
          WHERE organization_id = 'org-a' AND operation_id = 'delete-operation-a'`)
        .get(),
    ).toEqual({
      state: 'pending',
      attempts: 1,
      lastErrorCode: 'workflow_start_pending_reconciliation',
    })
  })
})

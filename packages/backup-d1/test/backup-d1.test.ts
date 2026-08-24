import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { migrations } from '@gridora/migrations'
import {
  makeTerminationD1Repository,
  makeWorkflowStepD1Repository,
  type LifecycleTerminationD1Database,
} from '@gridora/lifecycle-termination-d1'
import type { OrganizationContext } from '@gridora/domain'
import {
  BackupConflictError,
  BackupConcurrencyError,
  BackupNotFoundError,
  BackupRepository,
  BackupServerFacts,
  type BackupServerFactsShape,
  type BackupRepositoryShape,
} from '@gridora/backup-control'
import {
  BackupWorkflowError,
  BackupWorkflowReceipt,
  type BackupWorkflowReceiptShape,
} from '@gridora/backup-workflow'
import { deleteBackupObjectPrefix, type BackupR2DeletionBucketShape } from '@gridora/backup-r2'
import {
  acceptBackupUploadSession,
  abortBackupUploadObjectEffect,
  BackupD1ClientLayer,
  BackupRepositoryD1Live,
  BackupServerFactsD1Live,
  BackupWorkflowReceiptD1Live,
  claimBackupUploadSession,
  closeBackupUploadSession,
  completeBackupUploadObjectEffect,
  listPreparedBackupUploadObjectEffects,
  loadBackupUploadRecoverySession,
  registerBackupUploadObjectEffect,
  validateBackupUploadSession,
  type BackupD1Database,
  type BackupD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))

class TestStatement implements BackupD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private values: unknown[] = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): BackupD1Statement {
    return new TestStatement(this.database, this.sql, [...values])
  }
  async first(): Promise<unknown> {
    return this.database.prepare(this.sql).get(...(this.values as any[])) ?? null
  }
  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.database.prepare(this.sql).all(...(this.values as any[])) }
  }
  async run(): Promise<{
    readonly success: boolean
    readonly meta?: { readonly changes?: number }
  }> {
    const result = this.database.prepare(this.sql).run(...(this.values as any[]))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const wrap = (
  database: DatabaseSync,
  beforeBatch?: (statements: ReadonlyArray<BackupD1Statement>) => Promise<void>,
  afterBatch?: (statements: ReadonlyArray<BackupD1Statement>) => Promise<void>,
): BackupD1Database => ({
  prepare: (sql) => new TestStatement(database, sql),
  batch: async (statements) => {
    await beforeBatch?.(statements)
    database.exec('BEGIN')
    let results: Array<{
      readonly success: boolean
      readonly meta?: { readonly changes?: number }
    }>
    try {
      results = []
      for (const statement of statements) results.push(await statement.run())
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    await afterBatch?.(statements)
    return results
  },
})

const context = (organizationId: string): OrganizationContext =>
  ({
    organizationId,
    organizationSlug: `${organizationId}-slug`,
    identityId: `${organizationId}-identity`,
    role: 'operator' as const,
    correlationId: `${organizationId}-correlation`,
  }) as unknown as OrganizationContext

const httpContext = (organizationId: string): OrganizationContext =>
  ({
    organizationId,
    organizationSlug: `${organizationId}-slug`,
    identityId: `${organizationId}-identity`,
    role: 'operator' as const,
    correlationId: `${organizationId}-correlation`,
    auditRequestContext: {
      origin: 'http',
      requestId: `${organizationId}-request`,
      correlationId: `${organizationId}-correlation`,
      source: {
        ip: { state: 'captured', value: '203.0.113.7' },
        access: {
          state: 'captured',
          value: {
            subject: `${organizationId}-subject`,
            identityId: `${organizationId}-identity`,
            issuer: 'https://access.example.com',
            email: `${organizationId}@example.com`,
          },
        },
      },
    },
  }) as unknown as OrganizationContext

const seed = (database: DatabaseSync, organizationId: string) => {
  database
    .prepare(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES (?, ?, ?, ?, 'active', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z')`)
    .run(
      `${organizationId}-identity`,
      `${organizationId}-subject`,
      `${organizationId}@example.com`,
      organizationId,
    )
  database
    .prepare(`INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, '2026-08-23T10:00:00.000Z')`)
    .run(organizationId, organizationId, `${organizationId}-slug`)
  database
    .prepare(`INSERT INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, invited_by, revision)
    VALUES (?, ?, 'owner', 'active', '2026-08-23T10:00:00.000Z', NULL, 1)`)
    .run(organizationId, `${organizationId}-identity`)
  database
    .prepare(`INSERT INTO provider_accounts
    (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
    VALUES (?, 'organization', ?, 'ovhcloud', ?, 'active', 1, 'now', 'now')`)
    .run(`${organizationId}-provider`, organizationId, `${organizationId}-credential`)
  database
    .prepare(`INSERT INTO provider_allocations
    (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
    VALUES (?, ?, '["eu-west"]', '["small"]', 5, 'active', 1)`)
    .run(organizationId, `${organizationId}-provider`)
  database
    .prepare(`INSERT INTO node_images
    (id, version, checksum, signature, provider_mappings_json, status, created_at)
    VALUES (?, ?, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sig', '{"ovhcloud":{"eu-west":"image"}}', 'promoted', 'now')`)
    .run(`${organizationId}-image`, `${organizationId}-1.0.0`)
  for (const node of ['node-a', 'node-b']) {
    database
      .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_type, region, plan, image_id, placement_mode,
       desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES (?, ?, ?, 'ovhcloud', 'eu-west', 'small', ?, 'shared', 'ready', 'ready', 1, 1, 'now', 'now')`)
      .run(
        organizationId,
        `${organizationId}-${node}`,
        `${organizationId}-provider`,
        `${organizationId}-image`,
      )
  }
  database
    .prepare(`INSERT OR IGNORE INTO game_plugins
    (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
    .run()
  database
    .prepare(`INSERT INTO game_servers
    (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
     placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
    VALUES (?, ?, 'Server', 'arma-reforger', '1.0.0', 'running', 'running', '{}', 3, 2, 2, 'now', 'now')`)
    .run(organizationId, `${organizationId}-server`)
  database
    .prepare(`INSERT INTO deployments
    (organization_id, id, server_id, node_id, desired_revision, observed_revision, installed_build, observed_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, 2, 2, 'arma-build-1', 'running', 'now', 'now')`)
    .run(
      organizationId,
      `${organizationId}-deployment`,
      `${organizationId}-server`,
      `${organizationId}-node-a`,
    )
}

const createFacts = (
  organizationId: string,
  backupId: string,
  nodeId = `${organizationId}-node-a`,
) => ({
  backupId,
  serverId: `${organizationId}-server`,
  pluginId: 'arma-reforger',
  pluginVersion: '1.0.0',
  gameBuild: 'build-1',
  configRevision: 2,
  modSetRevision: 0,
  desiredRevision: 3,
  nodeId,
  consistency: 'plugin-quiesced' as const,
  trigger: 'manual' as const,
})

const metadataFor = (facts: ReturnType<typeof createFacts>) => ({
  pluginId: facts.pluginId,
  pluginVersion: facts.pluginVersion,
  gameBuild: facts.gameBuild,
  configRevision: facts.configRevision,
  modSetRevision: facts.modSetRevision,
  desiredRevision: facts.desiredRevision,
  nodeId: facts.nodeId,
  consistency: facts.consistency,
  includes: ['config', 'data', 'mods', 'state'] as const,
  containsGameBinaries: false as const,
})

describe('backup D1 orchestration', () => {
  let database: DatabaseSync
  let repository: BackupRepositoryShape
  let factsPort: BackupServerFactsShape
  let receiptPort: BackupWorkflowReceiptShape
  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
    seed(database, 'org-a')
    seed(database, 'org-b')
    const layer = BackupRepositoryD1Live.pipe(Layer.provide(BackupD1ClientLayer(wrap(database))))
    repository = Effect.runSync(Effect.service(BackupRepository).pipe(Effect.provide(layer)))
    const factsLayer = BackupServerFactsD1Live.pipe(
      Layer.provide(BackupD1ClientLayer(wrap(database))),
    )
    factsPort = Effect.runSync(Effect.service(BackupServerFacts).pipe(Effect.provide(factsLayer)))
    const receiptLayer = BackupWorkflowReceiptD1Live.pipe(
      Layer.provide(BackupD1ClientLayer(wrap(database))),
    )
    receiptPort = Effect.runSync(
      Effect.service(BackupWorkflowReceipt).pipe(Effect.provide(receiptLayer)),
    )
  })
  afterEach(() => database.close())

  it('atomically creates operation, workflow start, artifact, job, audit, and outbox and adopts exact replay', async () => {
    const facts = createFacts('org-a', 'backup-a')
    const first = await Effect.runPromise(
      repository.reserveCreate({
        context: httpContext('org-a'),
        operationId: 'op-a',
        jobId: 'job-a',
        backupId: facts.backupId,
        idempotencyKey: 'backup-key-a',
        fingerprint: 'a'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: null,
        },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-a',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    expect(first.disposition).toBe('created')
    expect(database.prepare(`SELECT status FROM operations WHERE id = 'op-a'`).get()).toEqual({
      status: 'queued',
    })
    expect(
      database
        .prepare(`SELECT state FROM lifecycle_workflow_starts WHERE operation_id = 'op-a'`)
        .get(),
    ).toEqual({ state: 'pending' })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events WHERE organization_id = 'org-a'`)
        .get(),
    ).toEqual({ count: 1 })
    const envelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id = 'audit-backup-op-a'`)
      .get() as { envelope: string }
    expect(JSON.parse(envelope.envelope)).toMatchObject({
      source: {
        origin: 'http',
        ip: { state: 'captured', value: '203.0.113.7' },
        access: { state: 'captured', value: { identityId: 'org-a-identity' } },
      },
    })
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM outbox WHERE organization_id = 'org-a' AND event_type = 'backup.workflow-start.requested'`,
        )
        .get(),
    ).toEqual({ count: 1 })
    const replay = await Effect.runPromise(
      repository.reserveCreate({
        context: httpContext('org-a'),
        operationId: 'op-lost-response',
        jobId: 'job-lost-response',
        backupId: 'backup-other',
        idempotencyKey: 'backup-key-a',
        fingerprint: 'a'.repeat(64),
        facts: createFacts('org-a', 'backup-other'),
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: null,
        },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-other',
        now: '2026-08-23T10:00:01.000Z',
      }),
    )
    expect(replay.disposition).toBe('adopted')
    expect(replay.job.id).toBe('job-a')
    expect(database.prepare(`SELECT count(*) AS count FROM backup_jobs`).get()).toEqual({
      count: 1,
    })
    expect(database.prepare(`SELECT count(*) AS count FROM operations`).get()).toEqual({ count: 2 })
    expect(
      database
        .prepare(
          `SELECT type, status FROM operations WHERE type = 'backup.create.accepted' LIMIT 1`,
        )
        .get(),
    ).toEqual({ type: 'backup.create.accepted', status: 'succeeded' })
    expect(
      database.prepare(`SELECT count(*) AS count FROM lifecycle_workflow_starts`).get(),
    ).toEqual({ count: 1 })
    expect(database.prepare(`SELECT count(*) AS count FROM audit_events`).get()).toEqual({
      count: 1,
    })
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM outbox WHERE event_type = 'backup.workflow-start.requested'`,
        )
        .get(),
    ).toEqual({ count: 1 })
  })

  it('rejects a reused idempotency key with a different fingerprint', async () => {
    const facts = createFacts('org-a', 'backup-a')
    const input = {
      context: context('org-a'),
      operationId: 'op-a',
      jobId: 'job-a',
      backupId: facts.backupId,
      idempotencyKey: 'backup-key-a',
      fingerprint: 'a'.repeat(64),
      facts,
      intent: {
        schemaVersion: 1 as const,
        includes: ['config', 'data', 'mods', 'state'] as const,
        expiresAt: null,
      },
      r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-a',
      now: '2026-08-23T10:00:00.000Z',
    }
    await Effect.runPromise(repository.reserveCreate(input))
    const result = await Effect.runPromise(
      Effect.result(
        repository.reserveCreate({
          ...input,
          operationId: 'op-b',
          jobId: 'job-b',
          backupId: 'backup-b',
          fingerprint: 'b'.repeat(64),
          facts: createFacts('org-a', 'backup-b'),
          r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-b',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure).toBeInstanceOf(BackupConflictError)
  })

  it('records scheduled reservations with the registered system actor and scheduler origin', async () => {
    const scheduler = database
      .prepare(`SELECT identity_id AS identityId
        FROM policy_reconciliation_scheduler_identities WHERE organization_id = 'org-a'`)
      .get() as { identityId: string }
    const schedulerContext = {
      organizationId: 'org-a',
      organizationSlug: 'org-a-slug',
      identityId: scheduler.identityId,
      role: 'automation',
      correlationId: 'scheduled-backup-correlation-a',
      auditActorType: 'system',
      auditRequestContext: {
        origin: 'scheduler',
        requestId: 'scheduled-backup-request-a',
        correlationId: 'scheduled-backup-correlation-a',
        source: {
          ip: { state: 'not-available', reason: 'scheduler-has-no-request-ip' },
          access: { state: 'not-available', reason: 'scheduler-has-no-access-assertion' },
        },
      },
    } as unknown as OrganizationContext
    const facts = createFacts('org-a', 'backup-scheduled-a')
    const reservation = await Effect.runPromise(
      repository.reserveCreate({
        context: schedulerContext,
        operationId: 'op-scheduled-a',
        jobId: 'job-scheduled-a',
        backupId: facts.backupId,
        idempotencyKey: 'backup-scheduled-key-a',
        fingerprint: 'c'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: '2026-08-30T10:00:00.000Z',
        },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-scheduled-a',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    expect(reservation.disposition).toBe('created')
    const envelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id = 'audit-backup-op-scheduled-a'`)
      .get() as { envelope: string }
    expect(JSON.parse(envelope.envelope)).toMatchObject({
      actor: { type: 'system', id: scheduler.identityId },
      source: {
        origin: 'scheduler',
        ip: { state: 'not-available' },
        access: { state: 'not-available' },
      },
    })
  })

  it('allows same-server and cross-node restore staging while fencing concurrent restores', async () => {
    const facts = createFacts('org-a', 'backup-a')
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-create',
        jobId: 'job-create',
        backupId: 'backup-a',
        idempotencyKey: 'backup-create-a',
        fingerprint: 'c'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: null,
        },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-a',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-create',
        expectedRevision: 1,
        checksum: 'sha256:' + 'b'.repeat(64),
        encryptionVersion: 1,
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-a',
        manifest: metadataFor(facts),
        completionFingerprint: 'f'.repeat(64),
        now: '2026-08-23T10:00:02.000Z',
      }),
    )
    const conflictingReplay = await Effect.runPromise(
      Effect.result(
        repository.markSucceeded({
          organizationId: 'org-a',
          jobId: 'job-create',
          expectedRevision: 1,
          checksum: 'sha256:' + 'c'.repeat(64),
          encryptionVersion: 1,
          r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-a',
          manifest: metadataFor(facts),
          completionFingerprint: 'e'.repeat(64),
          now: '2026-08-23T10:00:02.500Z',
        }),
      ),
    )
    expect(conflictingReplay._tag).toBe('Failure')
    if (conflictingReplay._tag === 'Failure')
      expect(conflictingReplay.failure).toBeInstanceOf(BackupConflictError)
    const restore = await Effect.runPromise(
      repository.reserveRestore({
        context: context('org-a'),
        operationId: 'op-restore',
        jobId: 'job-restore',
        idempotencyKey: 'restore-a',
        fingerprint: 'd'.repeat(64),
        intent: {
          schemaVersion: 1,
          backupId: 'backup-a',
          targetServerId: 'org-a-server',
          targetNodeId: 'org-a-node-b',
        },
        facts: {
          sourceServerId: 'org-a-server',
          sourceNodeId: 'org-a-node-a',
          targetServerId: 'org-a-server',
          targetNodeId: 'org-a-node-b',
          expectedTargetRevision: 3,
          metadata: metadataFor(facts),
        },
        now: '2026-08-23T10:00:03.000Z',
      }),
    )
    expect(restore.disposition).toBe('created')
    const operationCountBeforeLosingRestore = database
      .prepare(`SELECT count(*) AS count FROM operations`)
      .get()
    const auditCountBeforeLosingRestore = database
      .prepare(`SELECT count(*) AS count FROM audit_events`)
      .get()
    const outboxCountBeforeLosingRestore = database
      .prepare(`SELECT count(*) AS count FROM outbox`)
      .get()
    const workflowCountBeforeLosingRestore = database
      .prepare(`SELECT count(*) AS count FROM lifecycle_workflow_starts`)
      .get()
    const concurrent = await Effect.runPromise(
      Effect.result(
        repository.reserveRestore({
          context: context('org-a'),
          operationId: 'op-restore-2',
          jobId: 'job-restore-2',
          idempotencyKey: 'restore-b',
          fingerprint: 'e'.repeat(64),
          intent: {
            schemaVersion: 1,
            backupId: 'backup-a',
            targetServerId: 'org-a-server',
            targetNodeId: 'org-a-node-a',
          },
          facts: {
            sourceServerId: 'org-a-server',
            sourceNodeId: 'org-a-node-a',
            targetServerId: 'org-a-server',
            targetNodeId: 'org-a-node-a',
            expectedTargetRevision: 3,
            metadata: metadataFor(facts),
          },
          now: '2026-08-23T10:00:04.000Z',
        }),
      ),
    )
    expect(concurrent._tag).toBe('Failure')
    expect(database.prepare(`SELECT count(*) AS count FROM operations`).get()).toEqual(
      operationCountBeforeLosingRestore,
    )
    expect(database.prepare(`SELECT count(*) AS count FROM audit_events`).get()).toEqual(
      auditCountBeforeLosingRestore,
    )
    expect(database.prepare(`SELECT count(*) AS count FROM outbox`).get()).toEqual(
      outboxCountBeforeLosingRestore,
    )
    expect(
      database.prepare(`SELECT count(*) AS count FROM lifecycle_workflow_starts`).get(),
    ).toEqual(workflowCountBeforeLosingRestore)
  })

  it('enforces organization scope and a real artifact revision on deletion', async () => {
    const result = await Effect.runPromise(
      Effect.result(repository.get(context('org-b'), 'missing')),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure).toBeInstanceOf(BackupNotFoundError)
  })

  it('claims deletion before R2, blocks restore, and adopts response loss exactly', async () => {
    const facts = createFacts('org-a', 'backup-delete')
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-delete',
        jobId: 'job-delete',
        backupId: facts.backupId,
        idempotencyKey: 'backup-delete-key',
        fingerprint: '1'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: null,
        },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-delete',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-delete',
        expectedRevision: 1,
        checksum: `sha256:${'c'.repeat(64)}`,
        encryptionVersion: 1,
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-delete',
        manifest: metadataFor(facts),
        completionFingerprint: '2'.repeat(64),
        now: '2026-08-23T10:00:01.000Z',
      }),
    )
    const stale = await Effect.runPromise(
      Effect.result(
        repository.claimDelete({
          context: context('org-a'),
          backupId: facts.backupId,
          expectedRevision: 1,
          claimId: 'delete-stale',
          now: '2026-08-23T10:00:02.000Z',
        }),
      ),
    )
    expect(stale._tag).toBe('Failure')
    const claim = await Effect.runPromise(
      repository.claimDelete({
        context: context('org-a'),
        backupId: facts.backupId,
        expectedRevision: 2,
        claimId: 'delete-claim',
        now: '2026-08-23T10:00:02.000Z',
      }),
    )
    expect(claim.state).toBe('deleting')
    expect(claim.artifact.revision).toBe(3)
    const restoreBlocked = await Effect.runPromise(
      Effect.result(
        repository.reserveRestore({
          context: context('org-a'),
          operationId: 'op-delete-restore',
          jobId: 'job-delete-restore',
          idempotencyKey: 'restore-delete',
          fingerprint: '3'.repeat(64),
          intent: {
            schemaVersion: 1,
            backupId: facts.backupId,
            targetServerId: 'org-a-server',
            targetNodeId: 'org-a-node-b',
          },
          facts: {
            sourceServerId: 'org-a-server',
            sourceNodeId: 'org-a-node-a',
            targetServerId: 'org-a-server',
            targetNodeId: 'org-a-node-b',
            expectedTargetRevision: 3,
            metadata: metadataFor(facts),
          },
          now: '2026-08-23T10:00:03.000Z',
        }),
      ),
    )
    expect(restoreBlocked._tag).toBe('Failure')
    await Effect.runPromise(
      repository.recordDeleteFailure({
        context: context('org-a'),
        claimId: 'delete-claim',
        failureCode: 'r2_delete_failed',
        now: '2026-08-23T10:00:03.500Z',
      }),
    )
    await Effect.runPromise(
      repository.recordDeleteFailure({
        context: context('org-a'),
        claimId: 'delete-claim',
        failureCode: 'r2_delete_failed',
        now: '2026-08-23T10:00:03.600Z',
      }),
    )
    expect(
      database
        .prepare(
          `SELECT status FROM operations WHERE organization_id = 'org-a' AND id = 'delete-claim'`,
        )
        .get(),
    ).toEqual({ status: 'retrying' })
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM audit_events WHERE action = 'backup.delete.retry.accepted'`,
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM outbox WHERE event_type = 'backup.deletion.failed'`)
        .get(),
    ).toEqual({ count: 1 })
    const adopted = await Effect.runPromise(
      repository.claimDelete({
        context: context('org-a'),
        backupId: facts.backupId,
        expectedRevision: 1,
        claimId: 'delete-response-lost',
        now: '2026-08-23T10:00:04.000Z',
      }),
    )
    expect(adopted.claimId).toBe('delete-claim')
    const deleted = await Effect.runPromise(
      repository.completeDelete({
        context: context('org-a'),
        claimId: 'delete-claim',
        expectedArtifactRevision: 3,
        deletedPrefix: 'organizations/org-a/servers/org-a-server/backups/backup-delete',
        deletedObjects: 3,
        alreadyAbsent: false,
        now: '2026-08-23T10:00:05.000Z',
      }),
    )
    expect(deleted.state).toBe('deleted')
    expect(deleted.revision).toBe(4)
    const completionReplay = await Effect.runPromise(
      repository.completeDelete({
        context: context('org-a'),
        claimId: 'delete-claim',
        expectedArtifactRevision: 3,
        deletedPrefix: 'organizations/org-a/servers/org-a-server/backups/backup-delete',
        deletedObjects: 3,
        alreadyAbsent: false,
        now: '2026-08-23T10:00:06.000Z',
      }),
    )
    expect(completionReplay.state).toBe('deleted')
    expect(
      database
        .prepare(
          `SELECT action, result FROM audit_events WHERE organization_id = 'org-a' AND target_id = 'backup-delete' AND action LIKE 'backup.delete.%' ORDER BY created_at, id`,
        )
        .all(),
    ).toEqual([
      { action: 'backup.delete.accepted', result: 'succeeded' },
      { action: 'backup.delete.retry.accepted', result: 'succeeded' },
      { action: 'backup.delete.completed', result: 'succeeded' },
    ])
    expect(
      database
        .prepare(
          `SELECT event_type FROM outbox WHERE organization_id = 'org-a' AND aggregate_id = 'delete-claim' ORDER BY created_at, id`,
        )
        .all(),
    ).toEqual([
      { event_type: 'backup.deletion.requested' },
      { event_type: 'backup.deletion.failed' },
      { event_type: 'backup.deletion.completed' },
    ])
    expect(
      database
        .prepare(
          `SELECT status FROM operations WHERE organization_id = 'org-a' AND id = 'delete-claim'`,
        )
        .get(),
    ).toEqual({ status: 'succeeded' })
  })

  it('adopts exact running/cancel/failure transitions after response loss', async () => {
    const facts = createFacts('org-a', 'backup-transitions')
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-transitions',
        jobId: 'job-transitions',
        backupId: facts.backupId,
        idempotencyKey: 'backup-transitions-key',
        fingerprint: '4'.repeat(64),
        facts,
        intent: { schemaVersion: 1, includes: ['config'], expiresAt: null },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-transitions',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    const running = await Effect.runPromise(
      repository.markRunning('org-a', 'job-transitions', 1, '2026-08-23T10:00:01.000Z'),
    )
    expect(running.state).toBe('running')
    const runningReplay = await Effect.runPromise(
      repository.markRunning('org-a', 'job-transitions', 1, '2026-08-23T10:00:02.000Z'),
    )
    expect(runningReplay.revision).toBe(running.revision)
    const cancelled = await Effect.runPromise(
      repository.requestCancel(
        'org-a',
        'job-transitions',
        running.revision,
        '2026-08-23T10:00:03.000Z',
      ),
    )
    expect(cancelled.state).toBe('cancelled')
    const cancelReplay = await Effect.runPromise(
      repository.requestCancel(
        'org-a',
        'job-transitions',
        running.revision,
        '2026-08-23T10:00:04.000Z',
      ),
    )
    expect(cancelReplay.revision).toBe(cancelled.revision)

    const failedFacts = createFacts('org-a', 'backup-failure-transition')
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-failure-transition',
        jobId: 'job-failure-transition',
        backupId: failedFacts.backupId,
        idempotencyKey: 'backup-failure-transition-key',
        fingerprint: '5'.repeat(64),
        facts: failedFacts,
        intent: { schemaVersion: 1, includes: ['config'], expiresAt: null },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/failure-transition',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    const failed = await Effect.runPromise(
      repository.markFailed({
        organizationId: 'org-a',
        jobId: 'job-failure-transition',
        expectedRevision: 1,
        terminal: false,
        now: '2026-08-23T10:00:01.000Z',
      }),
    )
    expect(failed.state).toBe('failed')
    expect(
      (
        await Effect.runPromise(
          repository.markFailed({
            organizationId: 'org-a',
            jobId: 'job-failure-transition',
            expectedRevision: 1,
            terminal: false,
            now: '2026-08-23T10:00:02.000Z',
          }),
        )
      ).revision,
    ).toBe(failed.revision)
    const wrongTerminal = await Effect.runPromise(
      Effect.result(
        repository.markFailed({
          organizationId: 'org-a',
          jobId: 'job-failure-transition',
          expectedRevision: 1,
          terminal: true,
          now: '2026-08-23T10:00:03.000Z',
        }),
      ),
    )
    expect(wrongTerminal._tag).toBe('Failure')
  })

  it('atomically chooses exactly one winner between completion and cancellation', async () => {
    const reserve = async (suffix: string) => {
      const facts = createFacts('org-a', `backup-race-${suffix}`)
      const r2Key = `organizations/org-a/servers/org-a-server/backups/${facts.backupId}`
      const reservation = await Effect.runPromise(
        repository.reserveCreate({
          context: httpContext('org-a'),
          operationId: `op-race-${suffix}`,
          jobId: `job-race-${suffix}`,
          backupId: facts.backupId,
          idempotencyKey: `backup-race-${suffix}`,
          fingerprint: suffix.repeat(64).slice(0, 64),
          facts,
          intent: {
            schemaVersion: 1,
            includes: ['config', 'data', 'mods', 'state'],
            expiresAt: null,
          },
          r2Key,
          now: '2026-08-23T11:00:00.000Z',
        }),
      )
      return { facts, r2Key, reservation }
    }
    const completion = (value: Awaited<ReturnType<typeof reserve>>, expectedRevision: number) =>
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: value.reservation.job.id,
        expectedRevision,
        checksum: `sha256:${'b'.repeat(64)}`,
        encryptionVersion: 1,
        r2Key: value.r2Key,
        manifest: metadataFor(value.facts),
        completionFingerprint: 'c'.repeat(64),
        now: '2026-08-23T11:00:01.000Z',
      })
    const cancellationRepository = (suffix: string) =>
      makeTerminationD1Repository(wrap(database) as LifecycleTerminationD1Database, {
        now: () => '2026-08-23T11:00:02.000Z',
        auditEventId: () => `audit-cancel-race-${suffix}`,
        outboxEventId: () => `outbox-cancel-race-${suffix}`,
        auditRequestContext: {
          origin: 'http',
          requestId: `request-cancel-race-${suffix}`,
          correlationId: `correlation-cancel-race-${suffix}`,
          source: {
            ip: { state: 'captured', value: '203.0.113.7' },
            access: {
              state: 'captured',
              value: {
                subject: 'org-a-subject',
                identityId: 'org-a-identity',
                issuer: 'https://access.example.com',
                email: 'org-a@example.com',
              },
            },
          },
        },
      })
    const cancel = (suffix: string, expectedOperationRevision: number) =>
      cancellationRepository(suffix).requestCancellation(
        {
          organizationId: 'org-a',
          actorId: 'org-a-identity',
          role: 'owner',
          correlationId: `correlation-cancel-race-${suffix}`,
          idempotencyKey: `cancel-race-${suffix}`,
          operationId: `op-race-${suffix}`,
          expectedOperationRevision,
        },
        'd'.repeat(64),
      )

    const completedFirst = await reserve('a')
    await Effect.runPromise(completion(completedFirst, 1))
    expect((await Effect.runPromise(Effect.result(cancel('a', 2))))._tag).toBe('Failure')
    expect(
      database
        .prepare(`SELECT operation.status, job.state FROM operations operation
          JOIN backup_jobs job ON job.organization_id = operation.organization_id
            AND job.operation_id = operation.id
          WHERE operation.organization_id = 'org-a' AND operation.id = 'op-race-a'`)
        .get(),
    ).toEqual({ status: 'succeeded', state: 'succeeded' })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operation_cancellation_requests
          WHERE organization_id = 'org-a' AND operation_id = 'op-race-a'`)
        .get(),
    ).toEqual({ count: 0 })

    const cancelledFirst = await reserve('e')
    await Effect.runPromise(cancel('e', 1))
    expect((await Effect.runPromise(Effect.result(completion(cancelledFirst, 2))))._tag).toBe(
      'Failure',
    )
    await Effect.runPromise(
      cancellationRepository('e').recordCancellationSignal(
        {
          organizationId: 'org-a',
          operationId: 'op-race-e',
          resourceType: 'game-server',
          resourceId: 'org-a-server',
          resourceOperationDoName: 'resource-operation:org-a:game-server:org-a-server',
          workflowBinding: 'BACKUP_GAME_SERVER',
          workflowType: 'BackupGameServerWorkflow',
          workflowInstanceId: 'op-race-e',
        },
        { resourceOperationSignalled: true, workflowSignalled: true },
      ),
    )
    await Effect.runPromise(
      makeWorkflowStepD1Repository(
        wrap(database) as LifecycleTerminationD1Database,
      ).finalizeCancellation({
        organizationId: 'org-a',
        operationId: 'op-race-e',
        now: '2026-08-23T11:00:04.000Z',
      }),
    )
    expect(
      database
        .prepare(`SELECT operation.status, job.state, request.state AS cancellationState
          FROM operations operation
          JOIN backup_jobs job ON job.organization_id = operation.organization_id
            AND job.operation_id = operation.id
          JOIN operation_cancellation_requests request
            ON request.organization_id = operation.organization_id
            AND request.operation_id = operation.id
          WHERE operation.organization_id = 'org-a' AND operation.id = 'op-race-e'`)
        .get(),
    ).toEqual({ status: 'cancelled', state: 'cancelled', cancellationState: 'cancelled' })
  })

  it('persists exact restore ordinals, cutover evidence, and response-loss adoption', async () => {
    const facts = createFacts('org-a', 'backup-receipts')
    const r2Key = 'organizations/org-a/servers/org-a-server/backups/backup-receipts'
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-receipt-create',
        jobId: 'job-receipt-create',
        backupId: facts.backupId,
        idempotencyKey: 'receipt-create',
        fingerprint: 'd'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: null,
        },
        r2Key,
        now: '2026-08-23T08:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-receipt-create',
        expectedRevision: 1,
        checksum: `sha256:${'e'.repeat(64)}`,
        encryptionVersion: 1,
        r2Key,
        manifest: metadataFor(facts),
        completionFingerprint: 'e'.repeat(64),
        now: '2026-08-23T08:00:01.000Z',
      }),
    )
    const reservation = await Effect.runPromise(
      repository.reserveRestore({
        context: context('org-a'),
        operationId: 'op-receipt-restore',
        jobId: 'job-receipt-restore',
        idempotencyKey: 'receipt-restore',
        fingerprint: 'f'.repeat(64),
        intent: {
          schemaVersion: 1,
          backupId: facts.backupId,
          targetServerId: 'org-a-server',
          targetNodeId: 'org-a-node-b',
        },
        facts: {
          sourceServerId: 'org-a-server',
          sourceNodeId: 'org-a-node-a',
          targetServerId: 'org-a-server',
          targetNodeId: 'org-a-node-b',
          expectedTargetRevision: 3,
          metadata: metadataFor(facts),
        },
        now: '2026-08-23T08:00:02.000Z',
      }),
    )
    const restoreJob = reservation.job
    const fingerprint = (ordinal: number) => ordinal.toString(16).padStart(64, '0')
    const claim = (
      ordinal: number,
      workflowStep: Parameters<BackupWorkflowReceiptShape['claim']>[0]['step'],
    ) =>
      receiptPort.claim({
        job: restoreJob,
        ordinal,
        step: workflowStep,
        payloadFingerprint: fingerprint(ordinal),
        now: `2026-08-23T08:00:0${ordinal + 3}.000Z`,
      })
    const complete = (
      ordinal: number,
      workflowStep: Parameters<BackupWorkflowReceiptShape['complete']>[0]['step'],
      evidence: Readonly<Record<string, unknown>>,
    ) =>
      receiptPort.complete({
        job: restoreJob,
        ordinal,
        step: workflowStep,
        payloadFingerprint: fingerprint(ordinal),
        expectedRevision: 1,
        evidence,
        now: `2026-08-23T08:00:1${ordinal}.000Z`,
      })

    const skipped = await Effect.runPromise(Effect.result(claim(1, 'agent-restore-stage')))
    expect(skipped._tag).toBe('Failure')
    if (skipped._tag === 'Failure') expect(skipped.failure).toBeInstanceOf(BackupWorkflowError)

    expect((await Effect.runPromise(claim(0, 'mark-running'))).disposition).toBe('execute')
    await Effect.runPromise(complete(0, 'mark-running', {}))
    expect((await Effect.runPromise(claim(0, 'mark-running'))).disposition).toBe('adopted')
    const changedReplay = await Effect.runPromise(
      Effect.result(
        receiptPort.claim({
          job: restoreJob,
          ordinal: 0,
          step: 'mark-running',
          payloadFingerprint: 'a'.repeat(64),
          now: '2026-08-23T08:00:20.000Z',
        }),
      ),
    )
    expect(changedReplay._tag).toBe('Failure')
    expect((await Effect.runPromise(Effect.result(claim(2, 'restore-validate'))))._tag).toBe(
      'Failure',
    )

    await Effect.runPromise(claim(1, 'agent-restore-stage'))
    await Effect.runPromise(
      complete(1, 'agent-restore-stage', { staged: true, validation: 'passed' }),
    )
    await Effect.runPromise(claim(2, 'restore-validate'))
    await Effect.runPromise(complete(2, 'restore-validate', { validated: true }))
    await Effect.runPromise(claim(3, 'restore-cutover'))
    expect(
      (
        await Effect.runPromise(
          Effect.result(complete(3, 'restore-cutover', { cutover: true, sourcePreserved: false })),
        )
      )._tag,
    ).toBe('Failure')
    expect(
      database
        .prepare(
          `SELECT state FROM backup_restore_cutovers WHERE organization_id = 'org-a' AND job_id = 'job-receipt-restore'`,
        )
        .get(),
    ).toEqual({ state: 'validated' })
    database
      .prepare(`UPDATE backup_workflow_step_receipts SET payload_fingerprint = ?
        WHERE organization_id = 'org-a' AND job_id = 'job-receipt-restore' AND ordinal = 3`)
      .run('9'.repeat(64))
    expect(
      (
        await Effect.runPromise(
          Effect.result(complete(3, 'restore-cutover', { cutover: true, sourcePreserved: true })),
        )
      )._tag,
    ).toBe('Failure')
    expect(
      database
        .prepare(`SELECT state FROM backup_restore_cutovers
          WHERE organization_id = 'org-a' AND job_id = 'job-receipt-restore'`)
        .get(),
    ).toEqual({ state: 'validated' })
    database
      .prepare(`UPDATE backup_workflow_step_receipts SET payload_fingerprint = ?
        WHERE organization_id = 'org-a' AND job_id = 'job-receipt-restore' AND ordinal = 3`)
      .run(fingerprint(3))
    database
      .prepare(`INSERT INTO backup_restore_endpoint_effects
      (organization_id, job_id, effect_id, source_server_id, target_server_id,
       target_node_id, target_deployment_id, expected_cutover_revision,
       source_snapshot_json, transition_plan_json, state, revision, created_at, updated_at)
      VALUES ('org-a', 'job-receipt-restore', ?, 'org-a-server', 'org-a-server',
        'org-a-node-b', NULL, 4, '[]', '[]', 'planned', 1,
        '2026-08-23T08:00:13.000Z', '2026-08-23T08:00:13.000Z')`)
      .run(`org-a:job-receipt-restore:3:${fingerprint(3)}`)
    database
      .prepare(`INSERT INTO backup_restore_endpoint_receipts
      (organization_id, job_id, effect_id, source_dns_json, target_dns_json,
       target_deployment_id, target_node_id, state, applied_at, updated_at,
       target_server_id, cutover_revision)
      VALUES ('org-a', 'job-receipt-restore', ?, '[]', '[]',
        'same-server:org-a-server', 'org-a-node-b', 'applied',
        '2026-08-23T08:00:13.000Z', '2026-08-23T08:00:13.000Z',
        'org-a-server', 4)`)
      .run(`org-a:job-receipt-restore:3:${fingerprint(3)}`)
    await Effect.runPromise(
      complete(3, 'restore-cutover', { cutover: true, sourcePreserved: true }),
    )
    expect(
      (await Effect.runPromise(receiptPort.requireCommittedRestore(restoreJob))).sourcePreserved,
    ).toBe(true)

    await Effect.runPromise(claim(4, 'complete'))
    await Effect.runPromise(
      complete(4, 'complete', {
        observed: true,
        committed: true,
        sourcePreserved: true,
        sourceServerId: 'org-a-server',
        targetServerId: 'org-a-server',
        targetNodeId: 'org-a-node-b',
        observedRevision: 7,
      }),
    )
    expect((await Effect.runPromise(claim(4, 'complete'))).disposition).toBe('adopted')
    expect(
      database
        .prepare(`SELECT ordinal, step, state FROM backup_workflow_step_receipts
      WHERE organization_id = 'org-a' AND job_id = 'job-receipt-restore' ORDER BY ordinal`)
        .all(),
    ).toEqual([
      { ordinal: 0, step: 'mark-running', state: 'completed' },
      { ordinal: 1, step: 'agent-restore-stage', state: 'completed' },
      { ordinal: 2, step: 'restore-validate', state: 'completed' },
      { ordinal: 3, step: 'restore-cutover', state: 'completed' },
      { ordinal: 4, step: 'complete', state: 'completed' },
    ])
  })

  it('expires only newly transitioned artifacts and records one operation, audit, and outbox trail', async () => {
    const facts = createFacts('org-a', 'backup-expire')
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-expire',
        jobId: 'job-expire',
        backupId: facts.backupId,
        idempotencyKey: 'backup-expire-key',
        fingerprint: '6'.repeat(64),
        facts,
        intent: { schemaVersion: 1, includes: ['config'], expiresAt: '2026-08-23T09:00:00.000Z' },
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-expire',
        now: '2026-08-23T08:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-expire',
        expectedRevision: 1,
        checksum: `sha256:${'d'.repeat(64)}`,
        encryptionVersion: 1,
        r2Key: 'organizations/org-a/servers/org-a-server/backups/backup-expire',
        manifest: { ...metadataFor(facts), includes: ['config'] },
        completionFingerprint: '7'.repeat(64),
        now: '2026-08-23T08:00:01.000Z',
      }),
    )
    const expired = await Effect.runPromise(repository.expire('2026-08-23T10:00:00.000Z', 10))
    expect(expired).toHaveLength(1)
    expect(expired[0]?.state).toBe('expired')
    expect(
      database
        .prepare(`SELECT status FROM operations WHERE id = 'backup-expire-org-a-backup-expire'`)
        .get(),
    ).toEqual({ status: 'succeeded' })
    expect(
      database
        .prepare(`SELECT action, result FROM audit_events WHERE action = 'backup.expired'`)
        .all(),
    ).toEqual([{ action: 'backup.expired', result: 'succeeded' }])
    expect(
      database.prepare(`SELECT event_type FROM outbox WHERE event_type = 'backup.expired'`).all(),
    ).toEqual([{ event_type: 'backup.expired' }])
    expect(await Effect.runPromise(repository.expire('2026-08-23T10:00:00.000Z', 10))).toEqual([])
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events WHERE action = 'backup.expired'`)
        .get(),
    ).toEqual({ count: 1 })
  })

  it('claims expired retention bytes deterministically and adopts a lost terminal D1 response', async () => {
    const backupId = 'backup-retention-physical'
    const r2Key = `organizations/org-a/servers/org-a-server/backups/${backupId}`
    const facts = createFacts('org-a', backupId)
    database
      .prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version,
       metadata_json, state, revision, created_at, expires_at)
      VALUES ('org-a', ?, 'org-a-server', ?, ?, 1, ?, 'expired', 2, ?, ?)`)
      .run(
        backupId,
        r2Key,
        `sha256:${'8'.repeat(64)}`,
        JSON.stringify(metadataFor(facts)),
        '2026-08-20T08:00:00.000Z',
        '2026-08-22T08:00:00.000Z',
      )

    const first = await Effect.runPromise(
      repository.claimRetentionDeletes('2026-08-23T10:00:00.000Z', 10),
    )
    expect(first).toHaveLength(1)
    expect(first[0]?.claim.state).toBe('deleting')
    expect(
      (
        first[0]!.context as OrganizationContext & {
          readonly auditRequestContext: { readonly origin: string }
        }
      ).auditRequestContext.origin,
    ).toBe('scheduler')
    const replay = await Effect.runPromise(
      repository.claimRetentionDeletes('2026-08-23T10:00:01.000Z', 10),
    )
    expect(replay[0]?.claim.claimId).toBe(first[0]?.claim.claimId)

    let loseCompletion = true
    const lossLayer = BackupRepositoryD1Live.pipe(
      Layer.provide(
        BackupD1ClientLayer(
          wrap(database, undefined, async (statements) => {
            if (
              loseCompletion &&
              statements.some(
                (statement) =>
                  statement instanceof TestStatement &&
                  statement.sql.includes('backup_physical_deletion_receipts'),
              )
            ) {
              loseCompletion = false
              throw new Error('D1 response lost after physical receipt commit')
            }
          }),
        ),
      ),
    )
    const lossRepository = Effect.runSync(
      Effect.service(BackupRepository).pipe(Effect.provide(lossLayer)),
    )
    const claim = first[0]!.claim
    const deleted = await Effect.runPromise(
      lossRepository.completeDelete({
        context: first[0]!.context,
        claimId: claim.claimId,
        expectedArtifactRevision: claim.artifact.revision,
        deletedPrefix: r2Key,
        deletedObjects: 3,
        alreadyAbsent: false,
        now: '2026-08-23T10:00:02.000Z',
      }),
    )
    expect(loseCompletion).toBe(false)
    expect(deleted.state).toBe('deleted')
    expect(
      database
        .prepare(`SELECT claim_id AS claimId, operation_id AS operationId,
          deleted_objects AS deletedObjects, already_absent AS alreadyAbsent
        FROM backup_physical_deletion_receipts
        WHERE organization_id = 'org-a' AND backup_id = ?`)
        .get(backupId),
    ).toEqual({
      claimId: claim.claimId,
      operationId: claim.operationId,
      deletedObjects: 3,
      alreadyAbsent: 0,
    })
  })

  it('rejects a physical receipt for a foreign backup prefix', async () => {
    const backupId = 'backup-retention-foreign-prefix'
    const foreignPrefix = 'organizations/org-a/servers/org-a-server/backups/a-different-backup'
    const facts = createFacts('org-a', backupId)
    database
      .prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version,
       metadata_json, state, revision, created_at, expires_at)
      VALUES ('org-a', ?, 'org-a-server', ?, ?, 1, ?, 'expired', 2, ?, ?)`)
      .run(
        backupId,
        foreignPrefix,
        `sha256:${'9'.repeat(64)}`,
        JSON.stringify(metadataFor(facts)),
        '2026-08-20T08:00:00.000Z',
        '2026-08-22T08:00:00.000Z',
      )
    const claimed = await Effect.runPromise(
      Effect.result(repository.claimRetentionDeletes('2026-08-23T10:00:00.000Z', 10)),
    )
    expect(claimed._tag).toBe('Failure')
    expect(
      database
        .prepare(`SELECT state FROM backups WHERE organization_id = 'org-a' AND id = ?`)
        .get(backupId),
    ).toEqual({ state: 'expired' })
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM backup_physical_deletion_receipts
          WHERE organization_id = 'org-a' AND backup_id = ?`)
        .get(backupId),
    ).toEqual({ count: 0 })
  })

  it('fences expiry after a physical deletion claim and completes the exact claimed revision', async () => {
    const backupId = 'backup-expiry-delete-race'
    const facts = createFacts('org-a', backupId)
    const r2Key = `organizations/org-a/servers/org-a-server/backups/${backupId}`
    await Effect.runPromise(
      repository.reserveCreate({
        context: httpContext('org-a'),
        operationId: 'op-expiry-delete-race',
        jobId: 'job-expiry-delete-race',
        backupId,
        idempotencyKey: 'backup-expiry-delete-race',
        fingerprint: 'a'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config'],
          expiresAt: '2026-08-23T09:00:00.000Z',
        },
        r2Key,
        now: '2026-08-23T08:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-expiry-delete-race',
        expectedRevision: 1,
        checksum: `sha256:${'b'.repeat(64)}`,
        encryptionVersion: 1,
        r2Key,
        manifest: { ...metadataFor(facts), includes: ['config'] },
        completionFingerprint: 'c'.repeat(64),
        now: '2026-08-23T08:00:01.000Z',
      }),
    )
    const claim = await Effect.runPromise(
      repository.claimDelete({
        context: httpContext('org-a'),
        backupId,
        expectedRevision: 2,
        claimId: 'claim-expiry-delete-race',
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    expect(claim.artifact.revision).toBe(3)

    const objects = new Set([
      `${r2Key}/chunks/00000000.bin`,
      `${r2Key}/chunks/00000001.bin`,
      `${r2Key}/manifest.json`,
    ])
    const bucket: BackupR2DeletionBucketShape = {
      list: async ({ prefix }) => ({
        objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys) => {
        for (const key of keys) objects.delete(key)
      },
    }
    const physical = await Effect.runPromise(deleteBackupObjectPrefix(bucket, r2Key))
    expect(physical).toEqual({
      deletedObjects: 3,
      alreadyAbsent: false,
      deletedPrefix: r2Key,
    })
    expect(objects.size).toBe(0)

    // The exact prefix is now physically gone but the immutable D1 receipt has
    // not committed. Neither the scheduler nor a raw concurrent writer may
    // advance the claimed catalog revision and strand that receipt.
    expect(await Effect.runPromise(repository.expire('2026-08-23T10:00:01.000Z', 10))).toEqual([])
    expect(() =>
      database
        .prepare(`UPDATE backups SET state = 'expired', revision = revision + 1
          WHERE organization_id = 'org-a' AND id = ?`)
        .run(backupId),
    ).toThrow('backup expiry is fenced by physical deletion')
    expect(
      database
        .prepare(`SELECT state, revision FROM backups WHERE organization_id = 'org-a' AND id = ?`)
        .get(backupId),
    ).toEqual({ state: 'available', revision: 3 })

    const deleted = await Effect.runPromise(
      repository.completeDelete({
        context: httpContext('org-a'),
        claimId: claim.claimId,
        expectedArtifactRevision: claim.artifact.revision,
        deletedPrefix: physical.deletedPrefix,
        deletedObjects: physical.deletedObjects,
        alreadyAbsent: physical.alreadyAbsent,
        now: '2026-08-23T10:00:02.000Z',
      }),
    )
    expect(deleted).toMatchObject({ state: 'deleted', revision: 4 })
  })

  it('binds failed and cancelled partial cleanup to each exact terminal create owner', async () => {
    const partials = [
      { suffix: 'failed', terminal: 'failed' as const },
      { suffix: 'cancelled', terminal: 'cancelled' as const },
    ]
    for (const [index, partial] of partials.entries()) {
      const backupId = `backup-partial-${partial.suffix}`
      const facts = createFacts('org-a', backupId)
      const r2Key = `organizations/org-a/servers/org-a-server/backups/${backupId}`
      const jobId = `job-partial-${partial.suffix}`
      const operationId = `op-partial-${partial.suffix}`
      await Effect.runPromise(
        repository.reserveCreate({
          context: httpContext('org-a'),
          operationId,
          jobId,
          backupId,
          idempotencyKey: `backup-partial-${partial.suffix}`,
          fingerprint: String(index + 3).repeat(64),
          facts,
          intent: { schemaVersion: 1, includes: ['config'], expiresAt: null },
          r2Key,
          now: `2026-08-23T08:00:0${index}.000Z`,
        }),
      )
      if (partial.terminal === 'failed')
        await Effect.runPromise(
          repository.markFailed({
            organizationId: 'org-a',
            jobId,
            expectedRevision: 1,
            terminal: true,
            now: '2026-08-23T09:00:00.000Z',
          }),
        )
      else
        await Effect.runPromise(
          repository.requestCancel('org-a', jobId, 1, '2026-08-23T09:00:00.000Z'),
        )
    }

    const claims = await Effect.runPromise(
      repository.claimRetentionDeletes('2026-08-23T10:00:00.000Z', 10),
    )
    expect(claims.map(({ claim }) => claim.backupId).sort()).toEqual([
      'backup-partial-cancelled',
      'backup-partial-failed',
    ])
    for (const { context: cleanupContext, claim } of claims) {
      const source = database
        .prepare(`SELECT source_job_id AS sourceJobId,
          source_job_operation_id AS sourceJobOperationId
          FROM backup_deletion_claims
          WHERE organization_id = 'org-a' AND id = ?`)
        .get(claim.claimId)
      expect(source).toEqual({
        sourceJobId: `job-partial-${claim.backupId.endsWith('failed') ? 'failed' : 'cancelled'}`,
        sourceJobOperationId: `op-partial-${claim.backupId.endsWith('failed') ? 'failed' : 'cancelled'}`,
      })
      expect(() =>
        database
          .prepare(`UPDATE backup_jobs SET state = 'running'
            WHERE organization_id = 'org-a' AND id = ?`)
          .run((source as { sourceJobId: string }).sourceJobId),
      ).toThrow('backup cleanup source job is claimed')
      await Effect.runPromise(
        repository.completeDelete({
          context: cleanupContext,
          claimId: claim.claimId,
          expectedArtifactRevision: claim.artifact.revision,
          deletedPrefix: claim.r2Key,
          deletedObjects: 2,
          alreadyAbsent: false,
          now: '2026-08-23T10:00:01.000Z',
        }),
      )
    }
    expect(
      database
        .prepare(`SELECT backup.id, backup.state, receipt.source_job_id AS sourceJobId
          FROM backups backup JOIN backup_physical_deletion_receipts receipt
            ON receipt.organization_id = backup.organization_id AND receipt.backup_id = backup.id
          WHERE backup.organization_id = 'org-a' AND backup.id LIKE 'backup-partial-%'
          ORDER BY backup.id`)
        .all(),
    ).toEqual([
      {
        id: 'backup-partial-cancelled',
        state: 'deleted',
        sourceJobId: 'job-partial-cancelled',
      },
      { id: 'backup-partial-failed', state: 'deleted', sourceJobId: 'job-partial-failed' },
    ])
  })

  it('takes over a lost Worker generation and keeps cleanup fenced until every provider effect is terminal', async () => {
    const backupId = 'backup-delayed-upload-cancel'
    const jobId = 'job-delayed-upload-cancel'
    const operationId = 'op-delayed-upload-cancel'
    const r2Key = `organizations/org-a/servers/org-a-server/backups/${backupId}`
    await Effect.runPromise(
      repository.reserveCreate({
        context: httpContext('org-a'),
        operationId,
        jobId,
        backupId,
        idempotencyKey: 'backup-delayed-upload-cancel',
        fingerprint: 'd'.repeat(64),
        facts: createFacts('org-a', backupId),
        intent: { schemaVersion: 1, includes: ['config'], expiresAt: null },
        r2Key,
        now: '2026-08-23T10:00:00.000Z',
      }),
    )
    const session = await Effect.runPromise(
      claimBackupUploadSession(wrap(database), {
        organizationId: 'org-a',
        operationId,
        backupId,
        serverId: 'org-a-server',
        nodeId: 'org-a-node-a',
        archiveCreatedAt: '2026-08-23T10:00:01.000Z',
        includes: ['config'],
        declaredBytes: 128 * 1024,
        declaredSha256: `sha256:${'a'.repeat(64)}`,
        maximumChunkBytes: 64 * 1024,
        now: '2026-08-23T10:00:01.000Z',
        leaseExpiresAt: '2026-08-23T10:10:01.000Z',
        uploadWatchUntil: '2026-08-23T10:20:01.000Z',
      }),
    )
    expect(session.disposition).toBe('execute')
    if (session.disposition !== 'execute') throw new Error('expected upload authority')

    const completedExternally = await Effect.runPromise(
      registerBackupUploadObjectEffect(wrap(database), {
        ...session.authority,
        objectKey: `${r2Key}/chunks/00000000.bin`,
        objectKind: 'chunk',
        chunkIndex: 0,
        objectBytes: 64 * 1024 + 16,
        objectSha256: `sha256:${'1'.repeat(64)}`,
        multipartUploadId: 'multipart-lost-worker-completed',
        now: '2026-08-23T10:00:02.000Z',
      }),
    )
    const mustAbort = await Effect.runPromise(
      registerBackupUploadObjectEffect(wrap(database), {
        ...session.authority,
        objectKey: `${r2Key}/chunks/00000001.bin`,
        objectKind: 'chunk',
        chunkIndex: 1,
        objectBytes: 64 * 1024 + 16,
        objectSha256: `sha256:${'2'.repeat(64)}`,
        multipartUploadId: 'multipart-lost-worker-inflight',
        now: '2026-08-23T10:00:03.000Z',
      }),
    )
    const busy = await Effect.runPromise(
      Effect.result(
        claimBackupUploadSession(wrap(database), {
          organizationId: 'org-a',
          operationId,
          backupId,
          serverId: 'org-a-server',
          nodeId: 'org-a-node-a',
          archiveCreatedAt: '2026-08-23T10:00:01.000Z',
          includes: ['config'],
          declaredBytes: 128 * 1024,
          declaredSha256: `sha256:${'a'.repeat(64)}`,
          maximumChunkBytes: 64 * 1024,
          now: '2026-08-23T10:05:00.000Z',
          leaseExpiresAt: '2026-08-23T10:15:00.000Z',
          uploadWatchUntil: '2026-08-23T10:25:00.000Z',
        }),
      ),
    )
    expect(busy).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'backup_upload_generation_busy' },
    })

    // The retry takes over the same immutable generation after the old lease,
    // but it does not infer that either multipart provider call has stopped.
    const takeover = await Effect.runPromise(
      claimBackupUploadSession(wrap(database), {
        organizationId: 'org-a',
        operationId,
        backupId,
        serverId: 'org-a-server',
        nodeId: 'org-a-node-a',
        archiveCreatedAt: '2026-08-23T10:00:01.000Z',
        includes: ['config'],
        declaredBytes: 128 * 1024,
        declaredSha256: `sha256:${'a'.repeat(64)}`,
        maximumChunkBytes: 64 * 1024,
        now: '2026-08-23T10:10:02.000Z',
        leaseExpiresAt: '2026-08-23T10:20:02.000Z',
        uploadWatchUntil: '2026-08-23T10:30:02.000Z',
      }),
    )
    if (takeover.disposition !== 'execute') throw new Error('expected takeover authority')
    expect(takeover.authority).toMatchObject({
      sessionId: session.authority.sessionId,
      generation: session.authority.generation,
    })
    expect(takeover.authority.leaseId).not.toBe(session.authority.leaseId)

    expect(
      await Effect.runPromise(
        Effect.result(
          validateBackupUploadSession(wrap(database), {
            ...session.authority,
            now: '2026-08-23T10:10:03.000Z',
          }),
        ),
      ),
    ).toMatchObject({ _tag: 'Failure', failure: { code: 'backup_upload_lease_lost' } })
    await Effect.runPromise(
      validateBackupUploadSession(wrap(database), {
        ...takeover.authority,
        now: '2026-08-23T10:10:03.000Z',
      }),
    )

    await Effect.runPromise(repository.requestCancel('org-a', jobId, 1, '2026-08-23T10:11:00.000Z'))
    expect(
      database
        .prepare(`SELECT state FROM backup_upload_sessions WHERE organization_id = 'org-a'
          AND job_id = ?`)
        .get(jobId),
    ).toEqual({ state: 'revoked' })
    expect(
      await Effect.runPromise(
        Effect.result(
          validateBackupUploadSession(wrap(database), {
            ...takeover.authority,
            now: '2026-08-23T10:11:01.000Z',
          }),
        ),
      ),
    ).toMatchObject({ _tag: 'Failure', failure: { code: 'backup_upload_lease_lost' } })

    // Cancellation and all timestamps may pass, but the durable multipart
    // effects remain the authority. Time alone may never release D1.
    const blocked = await Effect.runPromise(
      Effect.result(
        repository.claimDelete({
          context: httpContext('org-a'),
          backupId,
          expectedRevision: 1,
          claimId: 'claim-delayed-upload-before-close',
          now: '2026-08-23T10:30:00.000Z',
        }),
      ),
    )
    expect(blocked._tag).toBe('Failure')
    expect(
      database
        .prepare(`SELECT revision, state FROM backups WHERE organization_id = 'org-a' AND id = ?`)
        .get(backupId),
    ).toEqual({ revision: 1, state: 'creating' })

    const objects = new Set([`${r2Key}/chunks/00000000.bin`])
    await Effect.runPromise(
      completeBackupUploadObjectEffect(wrap(database), {
        ...takeover.authority,
        effect: completedExternally,
        providerEtag: 'etag-lost-worker-completed',
        now: '2026-08-23T10:30:00.250Z',
      }),
    )
    await Effect.runPromise(
      abortBackupUploadObjectEffect(wrap(database), {
        ...takeover.authority,
        effect: mustAbort,
        now: '2026-08-23T10:30:00.500Z',
      }),
    )
    expect(
      await Effect.runPromise(
        listPreparedBackupUploadObjectEffects(wrap(database), takeover.authority),
      ),
    ).toEqual([])
    expect(
      await Effect.runPromise(loadBackupUploadRecoverySession(wrap(database), 'org-a', backupId)),
    ).toMatchObject({ state: 'revoked', leaseId: takeover.authority.leaseId })
    let loseCloseResponse = true
    await Effect.runPromise(
      closeBackupUploadSession(
        wrap(database, undefined, async () => {
          if (loseCloseResponse) {
            loseCloseResponse = false
            throw new Error('lost closure response after commit')
          }
        }),
        {
          ...takeover.authority,
          reason: 'authority-lost',
          now: '2026-08-23T10:30:01.000Z',
        },
      ),
    )
    expect(loseCloseResponse).toBe(false)
    expect(
      database
        .prepare(`SELECT state FROM backup_upload_sessions WHERE organization_id = 'org-a'
          AND job_id = ?`)
        .get(jobId),
    ).toEqual({ state: 'reconciled' })

    const claim = await Effect.runPromise(
      repository.claimDelete({
        context: httpContext('org-a'),
        backupId,
        expectedRevision: 1,
        claimId: 'claim-delayed-upload-after-close',
        now: '2026-08-23T10:30:02.000Z',
      }),
    )
    const physical = await Effect.runPromise(
      deleteBackupObjectPrefix(
        {
          list: async ({ prefix }) => ({
            objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
            truncated: false,
          }),
          delete: async (keys) => {
            for (const key of keys) objects.delete(key)
          },
        },
        r2Key,
      ),
    )
    await Effect.runPromise(
      repository.completeDelete({
        context: httpContext('org-a'),
        claimId: claim.claimId,
        expectedArtifactRevision: claim.artifact.revision,
        deletedPrefix: physical.deletedPrefix,
        deletedObjects: physical.deletedObjects,
        alreadyAbsent: physical.alreadyAbsent,
        now: '2026-08-23T10:30:03.000Z',
      }),
    )
    expect(objects.size).toBe(0)
    expect(
      database
        .prepare(`SELECT state FROM backups WHERE organization_id = 'org-a' AND id = ?`)
        .get(backupId),
    ).toEqual({ state: 'deleted' })
  })

  it('adopts a lost upload acceptance response and fences create completion to its receipt', async () => {
    const backupId = 'backup-upload-acceptance-loss'
    const jobId = 'job-upload-acceptance-loss'
    const operationId = 'op-upload-acceptance-loss'
    const r2Key = `organizations/org-a/servers/org-a-server/backups/${backupId}`
    const facts = createFacts('org-a', backupId)
    await Effect.runPromise(
      repository.reserveCreate({
        context: httpContext('org-a'),
        operationId,
        jobId,
        backupId,
        idempotencyKey: 'backup-upload-acceptance-loss',
        fingerprint: 'e'.repeat(64),
        facts,
        intent: { schemaVersion: 1, includes: ['config'], expiresAt: null },
        r2Key,
        now: '2026-08-23T11:00:00.000Z',
      }),
    )
    const session = await Effect.runPromise(
      claimBackupUploadSession(wrap(database), {
        organizationId: 'org-a',
        operationId,
        backupId,
        serverId: 'org-a-server',
        nodeId: 'org-a-node-a',
        archiveCreatedAt: '2026-08-23T11:00:01.000Z',
        includes: ['config'],
        declaredBytes: 96 * 1024,
        declaredSha256: `sha256:${'b'.repeat(64)}`,
        maximumChunkBytes: 64 * 1024,
        now: '2026-08-23T11:00:01.000Z',
        leaseExpiresAt: '2026-08-23T11:10:01.000Z',
        uploadWatchUntil: '2026-08-23T11:20:01.000Z',
      }),
    )
    if (session.disposition !== 'execute') throw new Error('expected upload authority')
    const manifestEffect = await Effect.runPromise(
      registerBackupUploadObjectEffect(wrap(database), {
        ...session.authority,
        objectKey: `${r2Key}/manifest.json`,
        objectKind: 'manifest',
        chunkIndex: -1,
        objectBytes: 1024,
        objectSha256: `sha256:${'c'.repeat(64)}`,
        multipartUploadId: 'multipart-upload-acceptance-manifest',
        now: '2026-08-23T11:00:01.500Z',
      }),
    )
    await Effect.runPromise(
      completeBackupUploadObjectEffect(wrap(database), {
        ...session.authority,
        effect: manifestEffect,
        providerEtag: 'etag-upload-acceptance-manifest',
        now: '2026-08-23T11:00:01.750Z',
      }),
    )
    let loseAcceptanceResponse = true
    const receipt = await Effect.runPromise(
      acceptBackupUploadSession(
        wrap(database, undefined, async () => {
          if (loseAcceptanceResponse) {
            loseAcceptanceResponse = false
            throw new Error('lost acceptance response after commit')
          }
        }),
        {
          ...session.authority,
          bytes: 96 * 1024,
          sha256: `sha256:${'b'.repeat(64)}`,
          encryptionVersion: 1,
          archiveCreatedAt: '2026-08-23T11:00:01.000Z',
          includes: ['config'],
          now: '2026-08-23T11:00:02.000Z',
        },
      ),
    )
    expect(loseAcceptanceResponse).toBe(false)
    expect(receipt).toMatchObject({
      sessionId: session.authority.sessionId,
      generation: 1,
      jobId,
      operationId,
      backupId,
      r2Key,
    })
    const completed = await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId,
        expectedRevision: 1,
        checksum: receipt.sha256,
        encryptionVersion: receipt.encryptionVersion,
        r2Key,
        manifest: { ...metadataFor(facts), includes: ['config'] },
        completionFingerprint: 'f'.repeat(64),
        now: '2026-08-23T11:00:03.000Z',
      }),
    )
    expect(completed.state).toBe('succeeded')
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM backup_upload_acceptance_receipts
          WHERE organization_id = 'org-a' AND job_id = ?`)
        .get(jobId),
    ).toEqual({ count: 1 })
  })

  it('intersects retention age and count while retaining the newest available artifact', async () => {
    database
      .prepare(`UPDATE backup_schedules SET retention_count = 1
      WHERE organization_id = 'org-a' AND server_id = 'org-a-server'`)
      .run()
    const artifacts = [
      {
        id: 'backup-retention-old',
        createdAt: '2026-08-20T08:00:00.000Z',
        expiresAt: '2026-08-22T08:00:00.000Z',
      },
      {
        id: 'backup-retention-over-count',
        createdAt: '2026-08-21T08:00:00.000Z',
        expiresAt: '2026-09-21T08:00:00.000Z',
      },
      {
        id: 'backup-retention-newest',
        createdAt: '2026-08-22T08:00:00.000Z',
        expiresAt: '2026-09-22T08:00:00.000Z',
      },
    ] as const
    for (const [index, artifact] of artifacts.entries()) {
      const facts = createFacts('org-a', artifact.id)
      database
        .prepare(`INSERT INTO backups
        (organization_id, id, server_id, r2_key, checksum, encryption_version,
         metadata_json, state, revision, created_at, expires_at)
        VALUES ('org-a', ?, 'org-a-server', ?, ?, 1, ?, 'available', 1, ?, ?)`)
        .run(
          artifact.id,
          `organizations/org-a/servers/org-a-server/backups/${artifact.id}`,
          `sha256:${String(index + 1).repeat(64)}`,
          JSON.stringify(metadataFor(facts)),
          artifact.createdAt,
          artifact.expiresAt,
        )
    }

    const expired = await Effect.runPromise(repository.expire('2026-08-23T10:00:00.000Z', 10))
    expect(expired.map((artifact) => artifact.id)).toEqual([
      'backup-retention-old',
      'backup-retention-over-count',
    ])
    expect(
      database
        .prepare(`SELECT id, state FROM backups
        WHERE organization_id = 'org-a' AND id LIKE 'backup-retention-%' ORDER BY created_at`)
        .all(),
    ).toEqual([
      { id: 'backup-retention-old', state: 'expired' },
      { id: 'backup-retention-over-count', state: 'expired' },
      { id: 'backup-retention-newest', state: 'available' },
    ])
  })

  it('uses the platform retention principal and isolates inactive tenant scopes', async () => {
    for (const organizationId of ['org-a', 'org-b']) {
      const backupId = `${organizationId}-retention-scope`
      const facts = createFacts(organizationId, backupId)
      const r2Key = `organizations/${organizationId}/servers/${organizationId}-server/backups/${backupId}`
      await Effect.runPromise(
        repository.reserveCreate({
          context: context(organizationId),
          operationId: `${organizationId}-retention-create`,
          jobId: `${organizationId}-retention-job`,
          backupId,
          idempotencyKey: `${organizationId}-retention-key`,
          fingerprint: organizationId === 'org-a' ? '1'.repeat(64) : '2'.repeat(64),
          facts,
          intent: { schemaVersion: 1, includes: ['config'], expiresAt: '2026-08-23T09:00:00.000Z' },
          r2Key,
          now: '2026-08-23T08:00:00.000Z',
        }),
      )
      await Effect.runPromise(
        repository.markSucceeded({
          organizationId,
          jobId: `${organizationId}-retention-job`,
          expectedRevision: 1,
          checksum: `sha256:${organizationId === 'org-a' ? '3'.repeat(64) : '4'.repeat(64)}`,
          encryptionVersion: 1,
          r2Key,
          manifest: { ...metadataFor(facts), includes: ['config'] },
          completionFingerprint: organizationId === 'org-a' ? '5'.repeat(64) : '6'.repeat(64),
          now: '2026-08-23T08:00:01.000Z',
        }),
      )
    }
    database
      .prepare(`DELETE FROM organization_memberships
      WHERE organization_id = 'org-a' AND role = 'owner'`)
      .run()
    database.prepare(`UPDATE organizations SET status = 'deleting' WHERE id = 'org-a'`).run()
    const first = await Effect.runPromise(repository.expire('2026-08-23T10:00:00.000Z', 10))
    expect(first.map((item) => item.organizationId)).toEqual(['org-b'])
    expect(
      database
        .prepare(`SELECT operation.actor_id AS actorId FROM operations operation
      JOIN identities identity ON identity.id = operation.actor_id
      WHERE operation.id = 'backup-expire-org-b-org-b-retention-scope'
        AND identity.access_subject = 'system:orphan-scheduler:org-b'`)
        .get(),
    ).toMatchObject({ actorId: expect.any(String) })
    database.prepare(`UPDATE organizations SET status = 'active' WHERE id = 'org-a'`).run()
    const second = await Effect.runPromise(repository.expire('2026-08-23T10:00:01.000Z', 10))
    expect(second.map((item) => item.organizationId)).toEqual(['org-a'])
    expect(
      database
        .prepare(`SELECT operation.actor_id AS actorId FROM operations operation
      JOIN identities identity ON identity.id = operation.actor_id
      WHERE operation.id = 'backup-expire-org-a-org-a-retention-scope'
        AND identity.access_subject = 'system:orphan-scheduler:org-a'`)
        .get(),
    ).toMatchObject({ actorId: expect.any(String) })
  })

  it('fences expiry after candidate selection and never partially completes a restore', async () => {
    const facts = createFacts('org-a', 'backup-expiry-restore-race')
    const r2Key = 'organizations/org-a/servers/org-a-server/backups/backup-expiry-restore-race'
    await Effect.runPromise(
      repository.reserveCreate({
        context: context('org-a'),
        operationId: 'op-race-create',
        jobId: 'job-race-create',
        backupId: facts.backupId,
        idempotencyKey: 'backup-race-create',
        fingerprint: '8'.repeat(64),
        facts,
        intent: {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: '2026-08-23T09:00:00.000Z',
        },
        r2Key,
        now: '2026-08-23T08:00:00.000Z',
      }),
    )
    const completion = {
      checksum: `sha256:${'e'.repeat(64)}`,
      encryptionVersion: 1,
      r2Key,
      manifest: metadataFor(facts),
    }
    await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-race-create',
        expectedRevision: 1,
        ...completion,
        completionFingerprint: '9'.repeat(64),
        now: '2026-08-23T08:00:01.000Z',
      }),
    )

    let releasedRestoreAtExpiryBarrier = false
    const expiryLayer = BackupRepositoryD1Live.pipe(
      Layer.provide(
        BackupD1ClientLayer(
          wrap(database, async (statements) => {
            const first = statements[0]
            if (
              releasedRestoreAtExpiryBarrier ||
              !(first instanceof TestStatement) ||
              !first.sql.includes("UPDATE backups SET state = 'expired'")
            )
              return
            releasedRestoreAtExpiryBarrier = true
            await Effect.runPromise(
              repository.reserveRestore({
                context: context('org-a'),
                operationId: 'op-race-restore',
                jobId: 'job-race-restore',
                idempotencyKey: 'backup-race-restore',
                fingerprint: 'a'.repeat(64),
                intent: {
                  schemaVersion: 1,
                  backupId: facts.backupId,
                  targetServerId: 'org-a-server',
                  targetNodeId: 'org-a-node-b',
                },
                facts: {
                  sourceServerId: 'org-a-server',
                  sourceNodeId: 'org-a-node-a',
                  targetServerId: 'org-a-server',
                  targetNodeId: 'org-a-node-b',
                  expectedTargetRevision: 3,
                  metadata: metadataFor(facts),
                },
                now: '2026-08-23T10:00:00.000Z',
              }),
            )
          }),
        ),
      ),
    )
    const expiryRepository = Effect.runSync(
      Effect.service(BackupRepository).pipe(Effect.provide(expiryLayer)),
    )
    expect(
      await Effect.runPromise(expiryRepository.expire('2026-08-23T10:00:01.000Z', 10)),
    ).toEqual([])
    expect(releasedRestoreAtExpiryBarrier).toBe(true)
    expect(
      database
        .prepare(
          `SELECT state FROM backups WHERE organization_id = 'org-a' AND id = 'backup-expiry-restore-race'`,
        )
        .get(),
    ).toEqual({ state: 'available' })
    expect(
      database
        .prepare(
          `SELECT state FROM backup_jobs WHERE organization_id = 'org-a' AND id = 'job-race-restore'`,
        )
        .get(),
    ).toEqual({ state: 'reserved' })
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM operations WHERE id = 'backup-expire-org-a-backup-expiry-restore-race'`,
        )
        .get(),
    ).toEqual({ count: 0 })

    const restored = await Effect.runPromise(
      repository.markSucceeded({
        organizationId: 'org-a',
        jobId: 'job-race-restore',
        expectedRevision: 1,
        ...completion,
        completionFingerprint: 'b'.repeat(64),
        now: '2026-08-23T10:00:02.000Z',
      }),
    )
    expect(restored.state).toBe('succeeded')
    expect(
      database
        .prepare(
          `SELECT state FROM backups WHERE organization_id = 'org-a' AND id = 'backup-expiry-restore-race'`,
        )
        .get(),
    ).toEqual({ state: 'available' })
    expect(
      database
        .prepare(
          `SELECT status FROM operations WHERE organization_id = 'org-a' AND id = 'op-race-restore'`,
        )
        .get(),
    ).toEqual({ status: 'succeeded' })

    let forcedArtifactFence = false
    const fencedLayer = BackupRepositoryD1Live.pipe(
      Layer.provide(
        BackupD1ClientLayer(
          wrap(database, async (statements) => {
            const first = statements[0]
            if (
              forcedArtifactFence ||
              !(first instanceof TestStatement) ||
              !first.sql.includes('UPDATE backups SET revision = revision')
            )
              return
            forcedArtifactFence = true
            database
              .prepare(`UPDATE backups SET state = 'expired', revision = revision + 1
          WHERE organization_id = 'org-a' AND id = 'backup-expiry-restore-race'`)
              .run()
          }),
        ),
      ),
    )
    const fencedRepository = Effect.runSync(
      Effect.service(BackupRepository).pipe(Effect.provide(fencedLayer)),
    )
    database
      .prepare(`UPDATE backup_jobs SET state = 'running', revision = revision + 1
      WHERE organization_id = 'org-a' AND id = 'job-race-restore'`)
      .run()
    database
      .prepare(`UPDATE operations SET status = 'running'
      WHERE organization_id = 'org-a' AND id = 'op-race-restore'`)
      .run()
    const fencedCompletion = await Effect.runPromise(
      Effect.result(
        fencedRepository.markSucceeded({
          organizationId: 'org-a',
          jobId: 'job-race-restore',
          expectedRevision: 3,
          ...completion,
          completionFingerprint: 'c'.repeat(64),
          now: '2026-08-23T10:00:03.000Z',
        }),
      ),
    )
    expect(fencedCompletion._tag).toBe('Failure')
    if (fencedCompletion._tag === 'Failure')
      expect(fencedCompletion.failure).toBeInstanceOf(BackupConcurrencyError)
    expect(forcedArtifactFence).toBe(true)
    expect(
      database
        .prepare(
          `SELECT state FROM backups WHERE organization_id = 'org-a' AND id = 'backup-expiry-restore-race'`,
        )
        .get(),
    ).toEqual({ state: 'expired' })
    expect(
      database
        .prepare(
          `SELECT state FROM backup_jobs WHERE organization_id = 'org-a' AND id = 'job-race-restore'`,
        )
        .get(),
    ).toEqual({ state: 'running' })
    expect(
      database
        .prepare(
          `SELECT status FROM operations WHERE organization_id = 'org-a' AND id = 'op-race-restore'`,
        )
        .get(),
    ).toEqual({ status: 'running' })
  })

  it('derives create and restore facts from tenant-scoped server, deployment, plugin, mod, and node rows', async () => {
    const create = await Effect.runPromise(
      factsPort.resolveCreate({
        context: context('org-a'),
        serverId: 'org-a-server',
        idempotencyKey: 'facts-key-a',
        requestedIncludes: ['config', 'data', 'mods', 'state'],
        expiresAt: null,
      }),
    )
    expect(create.serverId).toBe('org-a-server')
    expect(create.nodeId).toBe('org-a-node-a')
    expect(create.gameBuild).toBe('arma-build-1')
    expect(create.modSetRevision).toBe(0)
    expect(create.backupId).toBe(
      (
        await Effect.runPromise(
          factsPort.resolveCreate({
            context: context('org-a'),
            serverId: 'org-a-server',
            idempotencyKey: 'facts-key-a',
            requestedIncludes: ['config'],
            expiresAt: null,
          }),
        )
      ).backupId,
    )
    const crossTenant = await Effect.runPromise(
      Effect.result(
        factsPort.resolveCreate({
          context: context('org-b'),
          serverId: 'org-a-server',
          idempotencyKey: 'facts-key-b',
          requestedIncludes: ['config'],
          expiresAt: null,
        }),
      ),
    )
    expect(crossTenant._tag).toBe('Failure')
    const missingBackup = await Effect.runPromise(
      Effect.result(
        factsPort.resolveRestore({
          context: context('org-a'),
          intent: { schemaVersion: 1, backupId: 'missing-backup' },
        }),
      ),
    )
    expect(missingBackup._tag).toBe('Failure')
    if (missingBackup._tag === 'Failure')
      expect(missingBackup.failure).toBeInstanceOf(BackupNotFoundError)
  })
})

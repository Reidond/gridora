import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import {
  makeOrganizationDeletionD1Repository,
  makeNodeTerminationD1Repository,
  makeTerminationD1Repository,
  makeWorkflowStepD1Repository,
  requireDeletedRetirementReceipt,
  type LifecycleTerminationD1Database,
  type LifecycleTerminationD1Statement,
} from '../src/index.js'

const migrationDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const now = '2026-08-23T12:00:00.000Z'
let throwAfterCommittedBatch = false

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
      const results = []
      for (const statement of statements) results.push((statement as Statement).run())
      database.exec('COMMIT')
      if (throwAfterCommittedBatch) {
        throwAfterCommittedBatch = false
        throw new Error('response lost after committed batch')
      }
      return results
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  },
})

const request: AuditRequestContextValue = {
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

const command = {
  organizationId: 'org-a',
  actorId: 'actor-a',
  role: 'owner' as const,
  correlationId: 'correlation-a',
  idempotencyKey: 'delete-organization-key-a',
  expectedOrganizationRevision: 1,
  typedSlug: 'organization-a',
  backupPolicy: 'retain' as const,
}

const nodeCommand = {
  organizationId: 'org-a',
  actorId: 'actor-a',
  role: 'owner' as const,
  actorMembershipRevision: 1,
  correlationId: 'correlation-a',
  idempotencyKey: 'node-lifecycle-drain-key-a',
  action: 'drain-node' as const,
  nodeId: 'node-a',
  expectedNodeRevision: 1,
  force: false,
  backupPolicy: 'required' as const,
}

describe('organization deletion audit provenance', () => {
  let database: DatabaseSync
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of readdirSync(migrationDirectory)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort())
      database.exec(readFileSync(`${migrationDirectory}${migration}`, 'utf8'))
    database
      .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('actor-a', 'access-a', 'owner@example.com', 'Owner', 'active', ?, ?) `)
      .run(now, now)
    database
      .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west',
        'complete', 1, 1, ?)`)
      .run(now)
    database
      .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES ('org-a', 'actor-a', 'owner', 'active', ?, 1)`)
      .run(now)
  })
  afterEach(() => database.close())

  const seedNode = () => {
    database
      .prepare(`INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status, revision,
         created_at, updated_at)
        VALUES ('provider-account-a', 'organization', 'org-a', 'ovhcloud',
          'secret:provider-account-a', 'active', 1, ?, ?)`)
      .run(now, now)
    database
      .prepare(`INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
         max_active_nodes, monthly_budget_minor, status, revision)
        VALUES ('org-a', 'provider-account-a', '["eu-west"]', '["small"]',
          5, NULL, 'active', 1)`)
      .run()
    database
      .prepare(`INSERT INTO secret_envelopes
        (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key, key_version,
         revision, created_at, rotated_at)
        VALUES ('org-a', 'secret:provider-account-a', 'provider-account', 'provider-account-a',
          'ciphertext-a', 'wrapped-key-a', 1, 1, ?, NULL)`)
      .run(now)
    database
      .prepare(`INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
        VALUES ('image-a', '2026.08.23-a', 'checksum-a', 'signature-a', '{}', 'promoted', ?, ?)`)
      .run(now, now)
    database
      .prepare(`INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
         plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
         observed_revision, reconciliation_error, last_reconciled_at, created_at, updated_at)
        VALUES ('org-a', 'node-a', 'provider-account-a', 'ovh-node-a', 'ovhcloud', 'eu-west',
          'small', 'image-a', 'dedicated', 'ready', 'ready', 1, 1, NULL, ?, ?, ?)`)
      .run(now, now, now)
  }

  const repository = (context: typeof request) =>
    makeTerminationD1Repository(wrap(database), {
      now: () => now,
      operationId: () => 'delete-operation-a',
      auditEventId: () => 'audit-delete-operation-a',
      outboxEventId: () => 'outbox-delete-operation-a',
      workflowStartRecordId: (operationId) => `start-${operationId}`,
      auditRequestContext: context,
    })

  const nodeRepository = (
    context: typeof request,
    identity: {
      readonly operationId: string
      readonly auditEventId: string
      readonly outboxEventId: string
    } = {
      operationId: 'node-lifecycle-operation-a',
      auditEventId: 'audit-node-lifecycle-operation-a',
      outboxEventId: 'outbox-node-lifecycle-operation-a',
    },
  ) =>
    makeTerminationD1Repository(wrap(database), {
      now: () => now,
      operationId: () => identity.operationId,
      auditEventId: () => identity.auditEventId,
      outboxEventId: () => identity.outboxEventId,
      workflowStartRecordId: (operationId) => `start-${operationId}`,
      auditRequestContext: context,
    })

  it('persists exact bounded provenance and binds idempotent replay to it', async () => {
    const first = await Effect.runPromise(
      repository(request).acceptOrganizationDeletion(command, 'a'.repeat(64)),
    )
    expect(first.disposition).toBe('created')
    expect(
      database
        .prepare(`SELECT audit_request_context_json AS context
        FROM organization_deletion_runs WHERE organization_id = 'org-a'`)
        .get(),
    ).toEqual({ context: JSON.stringify(request) })
    expect(
      (
        await Effect.runPromise(
          repository(request).acceptOrganizationDeletion(command, 'a'.repeat(64)),
        )
      ).disposition,
    ).toBe('adopted')

    const changed = { ...request, requestId: 'request-tampered' }
    const mismatch = await Effect.runPromise(
      Effect.result(repository(changed).acceptOrganizationDeletion(command, 'a'.repeat(64))),
    )
    expect(mismatch._tag).toBe('Failure')

    const delayed = makeOrganizationDeletionD1Repository(wrap(database))
    expect(
      await Effect.runPromise(
        delayed.inventory({
          organizationId: 'org-a',
          operationId: first.operation.id,
          now: '2026-08-23T12:01:00.000Z',
        }),
      ),
    ).toMatchObject({ unresolvedResources: 0, unresolvedPaidResources: 0 })
    await Effect.runPromise(
      delayed.revokeOrganizationCredentials({
        organizationId: 'org-a',
        operationId: first.operation.id,
        now: '2026-08-23T12:02:00.000Z',
      }),
    )
    await Effect.runPromise(
      delayed.releaseOrganizationReservations({
        organizationId: 'org-a',
        operationId: first.operation.id,
        now: '2026-08-23T12:03:00.000Z',
      }),
    )
    await Effect.runPromise(
      delayed.prepareTombstone({
        organizationId: 'org-a',
        operationId: first.operation.id,
        now: '2026-08-23T12:04:00.000Z',
      }),
    )
    await Effect.runPromise(
      delayed.tombstone({
        organizationId: 'org-a',
        operationId: first.operation.id,
        now: '2026-08-23T12:05:00.000Z',
        retentionUntil: '2026-09-22T12:05:00.000Z',
      }),
    )
    expect(database.prepare(`SELECT status FROM organizations WHERE id = 'org-a'`).get()).toEqual({
      status: 'deleted',
    })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events
        WHERE organization_id = 'org-a' AND action LIKE 'organization.delete.%'`)
        .get(),
    ).toEqual({ count: 6 })
  })

  it('rejects oversized provenance before mutating the organization', async () => {
    const oversized = {
      ...request,
      source: {
        ...request.source,
        ip: { state: 'captured' as const, value: 'x'.repeat(9000) },
      },
    }
    const result = await Effect.runPromise(
      Effect.result(repository(oversized).acceptOrganizationDeletion(command, 'b'.repeat(64))),
    )
    expect(result._tag).toBe('Failure')
    expect(
      database.prepare(`SELECT status, revision FROM organizations WHERE id = 'org-a'`).get(),
    ).toEqual({ status: 'active', revision: 1 })
  })

  it('inventories expired and failed backups and blocks resolution/tombstoning without physical evidence', async () => {
    database.exec(`
      INSERT OR IGNORE INTO game_plugins
        (id, version, api_version, status, capability_manifest_json, config_schema_version)
        VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
      INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, desired_revision, observed_revision, active_config_revision,
         created_at, updated_at)
        VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0',
          'stopped', 'stopped', '{}', 1, 1, 1, '${now}', '${now}');
      INSERT INTO backups
        (organization_id, id, server_id, r2_key, checksum, encryption_version,
         metadata_json, state, revision, created_at, expires_at)
        VALUES ('org-a', 'backup-expired-a', 'server-a',
          'organizations/org-a/servers/server-a/backups/backup-expired-a',
          'sha256:${'a'.repeat(64)}', 1, '{}', 'expired', 2, '${now}', '${now}');
      INSERT INTO backups
        (organization_id, id, server_id, r2_key, checksum, encryption_version,
         metadata_json, state, revision, created_at, expires_at)
        VALUES ('org-a', 'backup-failed-a', 'server-a',
          'organizations/org-a/servers/server-a/backups/backup-failed-a',
          'sha256:${'b'.repeat(64)}', 1, '{}', 'failed', 2, '${now}', NULL);
    `)
    const accepted = await Effect.runPromise(
      repository(request).acceptOrganizationDeletion(
        { ...command, backupPolicy: 'delete-after-retention' },
        'f'.repeat(64),
      ),
    )
    const delayed = makeOrganizationDeletionD1Repository(wrap(database))
    await Effect.runPromise(
      delayed.inventory({
        organizationId: 'org-a',
        operationId: accepted.operation.id,
        now: '2026-08-23T12:01:00.000Z',
      }),
    )
    expect(
      database
        .prepare(`SELECT state FROM organization_deletion_items
          WHERE organization_id = 'org-a' AND operation_id = ?
            AND kind = 'backup' AND resource_id = 'backup-expired-a'`)
        .get(accepted.operation.id),
    ).toEqual({ state: 'pending' })
    expect(
      database
        .prepare(`SELECT state FROM organization_deletion_items
          WHERE organization_id = 'org-a' AND operation_id = ?
            AND kind = 'backup' AND resource_id = 'backup-failed-a'`)
        .get(accepted.operation.id),
    ).toEqual({ state: 'pending' })
    expect(() =>
      database
        .prepare(`UPDATE organization_deletion_items
          SET state = 'resolved', resolution_evidence_json = '{}', resolved_at = ?
          WHERE organization_id = 'org-a' AND operation_id = ?
            AND kind = 'backup' AND resource_id = 'backup-expired-a'`)
        .run(now, accepted.operation.id),
    ).toThrow('organization backup item requires physical deletion')
    expect(() =>
      database
        .prepare(`UPDATE backups SET state = 'deleted', revision = revision + 1
          WHERE organization_id = 'org-a' AND id = 'backup-expired-a'`)
        .run(),
    ).toThrow('backup physical deletion receipt is required')
    await expect(
      Effect.runPromise(
        delayed.prepareTombstone({
          organizationId: 'org-a',
          operationId: accepted.operation.id,
          now: '2026-08-23T12:02:00.000Z',
        }),
      ),
    ).rejects.toBeDefined()
  })

  it('requires immutable node lifecycle provenance and adopts a committed lost response', async () => {
    seedNode()
    throwAfterCommittedBatch = true
    const first = await Effect.runPromise(
      nodeRepository(request).acceptNodeLifecycle(nodeCommand, 'e'.repeat(64)),
    )
    expect(first).toMatchObject({
      disposition: 'adopted',
      operation: { id: 'node-lifecycle-operation-a', state: 'queued' },
      workflowStart: { workflowType: 'DrainNodeWorkflow', state: 'pending' },
    })
    expect(
      database
        .prepare(`SELECT audit_request_context_json AS context, state
          FROM node_lifecycle_runs
          WHERE organization_id = 'org-a' AND operation_id = 'node-lifecycle-operation-a'`)
        .get(),
    ).toEqual({ context: JSON.stringify(request), state: 'draining' })
    expect(
      database
        .prepare(`SELECT type, status FROM operations
          WHERE id = 'node-lifecycle-operation-a-acceptance'`)
        .get(),
    ).toEqual({ type: 'node.drain-node.accepted', status: 'succeeded' })
    const envelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id = 'audit-node-lifecycle-operation-a'`)
      .get() as { readonly envelope: string }
    expect(JSON.parse(envelope.envelope)).toMatchObject({
      operationId: 'node-lifecycle-operation-a-acceptance',
      action: 'node.drain-node.accepted',
      actor: { type: 'human', id: 'actor-a' },
      source: {
        origin: 'http',
        ip: { state: 'captured', value: '203.0.113.7' },
        access: { state: 'captured', value: { identityId: 'actor-a' } },
      },
      result: 'succeeded',
    })
    expect(
      await Effect.runPromise(
        makeNodeTerminationD1Repository(wrap(database)).completeNodeDrain({
          organizationId: 'org-a',
          operationId: 'node-lifecycle-operation-a',
          nodeId: 'node-a',
          now: '2026-08-23T12:01:00.000Z',
        }),
      ),
    ).toEqual({ state: 'completed' })
    expect(
      database
        .prepare(`SELECT pending_lifecycle_operation_id AS pending, desired_state AS desiredState
          FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({ pending: null, desiredState: 'draining' })
    expect(
      database
        .prepare(`SELECT status, progress FROM operations
          WHERE id = 'node-lifecycle-operation-a'`)
        .get(),
    ).toEqual({ status: 'succeeded', progress: 100 })
    const machineEnvelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id =
          'termination-node-drain-completed:org-a:node-lifecycle-operation-a:audit'`)
      .get() as { readonly envelope: string }
    expect(JSON.parse(machineEnvelope.envelope)).toMatchObject({
      operationId: 'node-lifecycle-operation-a-audit-drain-completed',
      action: 'node.drain.transition',
      source: {
        origin: 'machine',
        ip: { state: 'not-available' },
        access: { state: 'not-available' },
      },
      result: 'succeeded',
    })
    expect(
      (
        await Effect.runPromise(
          nodeRepository(request).acceptNodeLifecycle(nodeCommand, 'e'.repeat(64)),
        )
      ).disposition,
    ).toBe('adopted')
    const mismatchedReplay = await Effect.runPromise(
      Effect.result(
        nodeRepository({ ...request, requestId: 'request-tampered' }).acceptNodeLifecycle(
          nodeCommand,
          'e'.repeat(64),
        ),
      ),
    )
    expect(mismatchedReplay._tag).toBe('Failure')
    expect(() =>
      database
        .prepare(`UPDATE node_lifecycle_runs SET audit_request_context_json = ?
          WHERE organization_id = 'org-a' AND operation_id = 'node-lifecycle-operation-a'`)
        .run(JSON.stringify({ ...request, requestId: 'tampered-at-rest' })),
    ).toThrow('node lifecycle audit provenance is immutable')
    expect(() =>
      database
        .prepare(`INSERT INTO node_lifecycle_runs
          (organization_id, operation_id, node_id, action, previous_desired_state,
           previous_desired_revision, desired_revision, force_requested, backup_policy,
           target_image_id, state, provider_retirement_state, billing_state, cancellation_date,
           billing_stops_at, provider_request_reference, blocked_reason, created_at, updated_at,
           audit_request_context_json)
          VALUES ('org-a', 'node-missing-provenance-a', 'node-a', 'drain-node', 'ready',
            1, 2, 0, 'required', NULL, 'draining', 'not-started', 'not-applicable',
            NULL, NULL, NULL, NULL, ?, ?, NULL)`)
        .run(now, now),
    ).toThrow('node lifecycle audit provenance is required')
  })

  it('uncordons through the same terminal v1 lifecycle boundary after an exact drain', async () => {
    seedNode()
    const drained = await Effect.runPromise(
      nodeRepository(request).acceptNodeLifecycle(nodeCommand, 'e'.repeat(64)),
    )
    await Effect.runPromise(
      makeNodeTerminationD1Repository(wrap(database)).completeNodeDrain({
        organizationId: 'org-a',
        operationId: drained.operation.id,
        nodeId: 'node-a',
        now: '2026-08-23T12:01:00.000Z',
      }),
    )
    const uncordonIdentity = {
      operationId: 'node-lifecycle-operation-uncordon-a',
      auditEventId: 'audit-node-lifecycle-operation-uncordon-a',
      outboxEventId: 'outbox-node-lifecycle-operation-uncordon-a',
    }
    const uncordon = await Effect.runPromise(
      nodeRepository(request, uncordonIdentity).acceptNodeLifecycle(
        {
          ...nodeCommand,
          idempotencyKey: 'node-lifecycle-uncordon-key-a',
          action: 'leave-drain',
          expectedNodeRevision: 2,
        },
        'd'.repeat(64),
      ),
    )
    expect(uncordon).toMatchObject({
      disposition: 'created',
      operation: { id: uncordonIdentity.operationId, action: 'leave-drain', state: 'queued' },
      workflowStart: { workflowType: 'LeaveDrainNodeWorkflow', state: 'pending' },
    })
    await expect(
      Effect.runPromise(
        makeNodeTerminationD1Repository(wrap(database)).completeNodeDrain({
          organizationId: 'org-a',
          operationId: uncordon.operation.id,
          nodeId: 'node-a',
          now: '2026-08-23T12:02:00.000Z',
        }),
      ),
    ).resolves.toEqual({ state: 'completed' })
    expect(
      database
        .prepare(`SELECT desired_state AS desiredState, desired_revision AS desiredRevision,
          pending_lifecycle_operation_id AS pending FROM nodes
          WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({ desiredState: 'ready', desiredRevision: 3, pending: null })
    const acceptanceEnvelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id = ?`)
      .get(uncordonIdentity.auditEventId) as { readonly envelope: string }
    expect(JSON.parse(acceptanceEnvelope.envelope)).toMatchObject({
      operationId: `${uncordonIdentity.operationId}-acceptance`,
      action: 'node.leave-drain.accepted',
      result: 'succeeded',
      source: { origin: 'http', access: { state: 'captured', value: { identityId: 'actor-a' } } },
    })
    const completedEnvelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id = ?`)
      .get(`termination-node-drain-completed:org-a:${uncordonIdentity.operationId}:audit`) as {
      readonly envelope: string
    }
    expect(JSON.parse(completedEnvelope.envelope)).toMatchObject({
      operationId: `${uncordonIdentity.operationId}-audit-drain-completed`,
      action: 'node.drain.transition',
      result: 'succeeded',
      source: { origin: 'machine', access: { state: 'not-available' } },
    })
  })

  it('fences organization deletion child identity, parent scope, and replay state', async () => {
    const accepted = await Effect.runPromise(
      repository(request).acceptOrganizationDeletion(command, 'd'.repeat(64)),
    )
    expect(() =>
      database
        .prepare(`INSERT INTO organization_deletion_child_operations
        (organization_id, parent_operation_id, kind, resource_id, child_operation_id,
         idempotency_key, state, created_at, updated_at)
        VALUES ('org-a', 'wrong-parent', 'node', 'node-a', 'child-node-a',
          'child-node-key-a', 'dispatching', ?, ?)`)
        .run(now, now),
    ).toThrow('organization deletion child scope fence failed')
    database
      .prepare(`INSERT INTO organization_deletion_child_operations
      (organization_id, parent_operation_id, kind, resource_id, child_operation_id,
       idempotency_key, state, created_at, updated_at)
      VALUES ('org-a', ?, 'node', 'node-a', 'child-node-a',
        'child-node-key-a', 'dispatching', ?, ?)`)
      .run(accepted.operation.id, now, now)
    database
      .prepare(`UPDATE organization_deletion_child_operations
      SET state = 'accepted', updated_at = ?
      WHERE organization_id = 'org-a' AND parent_operation_id = ? AND resource_id = 'node-a'`)
      .run('2026-08-23T12:01:00.000Z', accepted.operation.id)
    expect(() =>
      database
        .prepare(`UPDATE organization_deletion_child_operations
        SET idempotency_key = 'tampered-child-key'
        WHERE organization_id = 'org-a' AND parent_operation_id = ? AND resource_id = 'node-a'`)
        .run(accepted.operation.id),
    ).toThrow('organization deletion child identity is immutable')
    expect(
      database
        .prepare(`SELECT child_operation_id AS childOperationId, idempotency_key AS idempotencyKey,
          state FROM organization_deletion_child_operations
        WHERE organization_id = 'org-a' AND parent_operation_id = ? AND resource_id = 'node-a'`)
        .get(accepted.operation.id),
    ).toEqual({
      childOperationId: 'child-node-a',
      idempotencyKey: 'child-node-key-a',
      state: 'accepted',
    })
  })

  it('exports only an exact terminal RETIRE_NODE receipt for organization deletion', async () => {
    seedNode()
    const parent = await Effect.runPromise(
      repository(request).acceptOrganizationDeletion(command, 'c'.repeat(64)),
    )
    const childOperationId = 'orgdel-retire-child-a'
    const childKey = 'orgdel-retire-child-key-a'
    database
      .prepare(`INSERT INTO organization_deletion_child_operations
        (organization_id, parent_operation_id, kind, resource_id, child_operation_id,
         idempotency_key, state, created_at, updated_at)
        VALUES ('org-a', ?, 'node', 'node-a', ?, ?, 'dispatching', ?, ?)`)
      .run(parent.operation.id, childOperationId, childKey, now, now)
    const accepted = await Effect.runPromise(
      makeTerminationD1Repository(wrap(database), {
        now: () => now,
        operationId: () => childOperationId,
        auditEventId: () => 'audit-orgdel-retire-child-a',
        outboxEventId: () => 'outbox-orgdel-retire-child-a',
        workflowStartRecordId: (operationId) => `start-${operationId}`,
        auditRequestContext: request,
      }).acceptNodeLifecycle(
        {
          ...nodeCommand,
          action: 'retire-node',
          idempotencyKey: childKey,
          organizationDeletionOperationId: parent.operation.id,
        },
        'd'.repeat(64),
      ),
    )
    expect(accepted.operation.id).toBe(childOperationId)
    database
      .prepare(`UPDATE organization_deletion_child_operations SET state = 'accepted', updated_at = ?
        WHERE organization_id = 'org-a' AND parent_operation_id = ? AND kind = 'node'
          AND resource_id = 'node-a' AND child_operation_id = ?`)
      .run(now, parent.operation.id, childOperationId)

    const nodeTermination = makeNodeTerminationD1Repository(wrap(database))
    await Effect.runPromise(
      nodeTermination.completeNodeDrain({
        organizationId: 'org-a',
        operationId: childOperationId,
        nodeId: 'node-a',
        now,
      }),
    )
    // The provider mutation is only reachable through the signed destructive Workflow step.
    // Claim it here rather than mutating cancellation facts directly so this receipt proof
    // exercises the same authorization fence as the production executor.
    const workflowSteps = makeWorkflowStepD1Repository(wrap(database))
    const claimedStep = await Effect.runPromise(
      workflowSteps.claimStep({
        organizationId: 'org-a',
        operationId: childOperationId,
        workflowType: 'RetireNodeWorkflow',
        workflowInstanceId: childOperationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        destructive: true,
        claimId: 'retire-receipt-proof-claim-a',
        leaseExpiresAt: '2026-08-23T12:10:00.000Z',
        now,
      }),
    )
    expect(claimedStep).toMatchObject({ disposition: 'execute' })
    if (claimedStep.lease === undefined) throw new Error('destructive step lease missing')
    expect(
      await Effect.runPromise(
        nodeTermination.claimNodeProviderDestructiveAction({
          organizationId: 'org-a',
          operationId: childOperationId,
          nodeId: 'node-a',
          now,
        }),
      ),
    ).toMatchObject({ disposition: 'execute', state: 'retiring' })
    await Effect.runPromise(
      nodeTermination.recordNodeProviderRetirement({
        organizationId: 'org-a',
        operationId: childOperationId,
        nodeId: 'node-a',
        receipt: { state: 'deleted-confirmed', billingState: 'stopped' },
        now,
      }),
    )
    database
      .prepare(`INSERT INTO tunnels
        (organization_id, node_id, tunnel_id, hostname, state, credential_reference, revision)
        VALUES ('org-a', 'node-a', 'tunnel-a', 'node-a.example.test', 'connected',
          'secret:tunnel-a', 1)`)
      .run()
    database
      .prepare(`INSERT INTO node_credentials
        (organization_id, node_id, id, credential_hash, version, status, issued_at, last_used_at, revoked_at)
        VALUES ('org-a', 'node-a', 'credential-a', 'credential-hash-a', 1, 'active', ?, NULL, NULL)`)
      .run(now)
    database
      .prepare(`INSERT INTO agent_sessions
        (organization_id, node_id, credential_id, session_version, agent_version, session_state,
         last_seen_at, revision)
        VALUES ('org-a', 'node-a', 'credential-a', 1, '1.0.0', 'connected', ?, 1)`)
      .run(now)
    database
      .prepare(`INSERT INTO node_registration_tokens
        (token_hash, organization_id, node_id, provider_instance_id, operation_id, credential_id,
         expires_at, consumed_at, revoked_at, issued_at)
        VALUES ('token-hash-a', 'org-a', 'node-a', 'ovh-node-a', ?, 'credential-a',
          '2026-08-23T13:00:00.000Z', NULL, NULL, ?)`)
      .run(childOperationId, now)
    await Effect.runPromise(
      nodeTermination.revokeNodeCredentials({
        organizationId: 'org-a',
        operationId: childOperationId,
        nodeId: 'node-a',
        now,
      }),
    )
    // A D1 response loss after the external Tunnel deletion is adopted only
    // from the exact tunnel id/revision plus its strict v1 audit receipt.
    throwAfterCommittedBatch = true
    await Effect.runPromise(
      nodeTermination.recordNodeTunnelDeleted({
        organizationId: 'org-a',
        operationId: childOperationId,
        nodeId: 'node-a',
        tunnelId: 'tunnel-a',
        expectedTunnelRevision: 1,
        now,
      }),
    )
    const tunnelEnvelope = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND event_id =
          'termination-node-tunnel-deleted:org-a:orgdel-retire-child-a:audit'`)
      .get() as { readonly envelope: string }
    expect(JSON.parse(tunnelEnvelope.envelope)).toMatchObject({
      operationId: 'orgdel-retire-child-a-audit-tunnel-deleted',
      action: 'node.tunnel.deleted',
      source: { origin: 'machine' },
      result: 'succeeded',
    })
    await Effect.runPromise(
      workflowSteps.recordStepEffectReceipt({
        organizationId: 'org-a',
        operationId: childOperationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        lease: claimedStep.lease,
        receipt: {
          effectId: 'ovh-node-a:deleted-confirmed',
          outcomeFingerprint: 'f'.repeat(64),
        },
        now,
      }),
    )
    await Effect.runPromise(
      workflowSteps.completeStep({
        organizationId: 'org-a',
        operationId: childOperationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        lease: claimedStep.lease,
        now,
      }),
    )
    await Effect.runPromise(
      nodeTermination.finalizeNodeRetirement({
        organizationId: 'org-a',
        operationId: childOperationId,
        nodeId: 'node-a',
        now,
      }),
    )

    await expect(
      Effect.runPromise(
        requireDeletedRetirementReceipt(wrap(database), {
          organizationId: 'org-a',
          nodeId: 'node-a',
          childOperationId,
        }),
      ),
    ).resolves.toEqual({
      organizationId: 'org-a',
      nodeId: 'node-a',
      childOperationId,
      parentOrganizationDeletionOperationId: parent.operation.id,
      providerTerminalState: 'deleted-confirmed',
    })
    for (const input of [
      { organizationId: 'org-b', nodeId: 'node-a', childOperationId },
      { organizationId: 'org-a', nodeId: 'node-b', childOperationId },
      { organizationId: 'org-a', nodeId: 'node-a', childOperationId: 'wrong-retire-operation' },
    ]) {
      const result = await Effect.runPromise(
        Effect.result(requireDeletedRetirementReceipt(wrap(database), input)),
      )
      expect(result._tag).toBe('Failure')
    }
  })

  it('stages strict delayed cancellation audits from the immutable request provenance', async () => {
    database
      .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('cancel-target-a', 'org-a', 'retire-node', 'node', 'node-a', 'actor-a',
        'queued', 0, 'target-operation-key', 'correlation-a', 1, ?, ?)`)
      .run(now, now)
    database
      .prepare(`INSERT INTO operation_cancellation_facts
      (organization_id, operation_id, resource_type, resource_id,
       resource_operation_do_name, workflow_binding, workflow_type, workflow_instance_id,
       cancellation_policy, phase, revision, registered_at, updated_at)
      VALUES ('org-a', 'cancel-target-a', 'node', 'node-a',
       'resource-operation:org-a:node:node-a', 'RETIRE_NODE', 'RetireNodeWorkflow',
       'cancel-target-a', 'before-destructive-step', 'before-destructive-step', 1, ?, ?)`)
      .run(now, now)
    const cancellation = makeTerminationD1Repository(wrap(database), {
      now: () => now,
      auditEventId: () => 'audit-cancellation-requested-a',
      outboxEventId: () => 'outbox-cancellation-requested-a',
      auditRequestContext: request,
    })
    await Effect.runPromise(
      cancellation.requestCancellation(
        {
          organizationId: 'org-a',
          actorId: 'actor-a',
          role: 'owner',
          correlationId: 'correlation-a',
          idempotencyKey: 'cancel-operation-key-a',
          operationId: 'cancel-target-a',
          expectedOperationRevision: 1,
        },
        'c'.repeat(64),
      ),
    )
    await Effect.runPromise(
      cancellation.recordCancellationSignal(
        {
          organizationId: 'org-a',
          operationId: 'cancel-target-a',
          resourceType: 'node',
          resourceId: 'node-a',
          resourceOperationDoName: 'resource-operation:org-a:node:node-a',
          workflowBinding: 'RETIRE_NODE',
          workflowType: 'RetireNodeWorkflow',
          workflowInstanceId: 'cancel-target-a',
        },
        { resourceOperationSignalled: true, workflowSignalled: true },
      ),
    )
    await Effect.runPromise(
      makeWorkflowStepD1Repository(wrap(database)).finalizeCancellation({
        organizationId: 'org-a',
        operationId: 'cancel-target-a',
        now: '2026-08-23T12:06:00.000Z',
      }),
    )
    expect(
      database
        .prepare(`SELECT action, result FROM audit_events
        WHERE target_id = 'node-a' ORDER BY created_at, action`)
        .all(),
    ).toEqual([
      { action: 'operation.cancellation.requested', result: 'succeeded' },
      { action: 'operation.cancellation.signal-recorded', result: 'succeeded' },
      { action: 'operation.cancellation.finalized', result: 'succeeded' },
    ])
    expect(
      database
        .prepare(`SELECT type, status FROM operations
        WHERE type IN ('operation-cancellation-requested',
          'operation-cancellation-signal-recorded', 'operation-cancellation-finalized')
        ORDER BY type`)
        .all(),
    ).toEqual([
      { type: 'operation-cancellation-finalized', status: 'succeeded' },
      { type: 'operation-cancellation-requested', status: 'succeeded' },
      { type: 'operation-cancellation-signal-recorded', status: 'succeeded' },
    ])
    const envelopes = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
        WHERE scope = 'tenant' AND organization_id = 'org-a'
          AND json_extract(envelope_json, '$.action') LIKE 'operation.cancellation.%'
        ORDER BY event_id`)
      .all() as unknown as ReadonlyArray<{ envelope: string }>
    expect(envelopes).toHaveLength(3)
    for (const row of envelopes)
      expect(JSON.parse(row.envelope)).toMatchObject({
        actor: { type: 'human', id: 'actor-a' },
        source: {
          origin: 'http',
          ip: { state: 'captured', value: '203.0.113.7' },
          access: { state: 'captured', value: { identityId: 'actor-a' } },
        },
        result: 'succeeded',
      })
  })
})

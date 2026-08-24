import { generateKeyPairSync } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  completeAuditEnvelope,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import type { AgentCommand } from '@gridora/agent-protocol'
import {
  makeGameLifecyclePlanningD1Repository,
  makeGameLifecycleD1Repository,
  type GameLifecycleD1Database,
  type GameLifecycleD1Statement,
} from '@gridora/game-lifecycle-d1'
import type { NodeCoordinatorDO } from '@gridora/realtime'
import {
  executeGameLifecycleWorkflowStep,
  makeGameDnsAuthorityResolver,
  makeGameDnsReceiptRecorder,
  makeGameMoveCoordinator,
  type GameMoveBackupAdapter,
  type GameMoveEffect,
} from '../src/game-lifecycle-runtime.js'
import { makeNativeGameMoveBackupAdapter } from '../src/game-move-native-adapter.js'

type Input = null | number | bigint | string | NodeJS.ArrayBufferView

class SqliteStatement implements GameLifecycleD1Statement {
  private values: readonly unknown[] = []

  constructor(
    private readonly statement: StatementSync,
    readonly sql: string,
  ) {}

  bind(...values: readonly unknown[]): GameLifecycleD1Statement {
    this.values = values
    return this
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.statement.get(...(this.values as Input[])) as T | undefined) ?? null
  }

  run(): void {
    this.statement.run(...(this.values as Input[]))
  }
}

class SqliteD1 implements GameLifecycleD1Database {
  private loseNextResponse = false
  private failNextBatch = false
  private failNextMoveTransition = false

  constructor(readonly database: DatabaseSync) {}

  loseNextBatchResponseAfterCommit(): void {
    this.loseNextResponse = true
  }

  failNextBatchBeforeCommit(): void {
    this.failNextBatch = true
  }

  failNextMoveTransitionBeforeCommit(): void {
    this.failNextMoveTransition = true
  }

  prepare(sql: string): GameLifecycleD1Statement {
    return new SqliteStatement(this.database.prepare(sql), sql)
  }

  async batch(statements: readonly GameLifecycleD1Statement[]): Promise<readonly unknown[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false
      throw new Error('simulated D1 transition failure before commit')
    }
    if (
      this.failNextMoveTransition &&
      statements.some((statement) =>
        (statement as SqliteStatement).sql.includes('UPDATE game_lifecycle_moves'),
      )
    ) {
      this.failNextMoveTransition = false
      throw new Error('simulated post-command move transition failure before commit')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) (statement as SqliteStatement).run()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      throw new Error('simulated D1 response loss after durable commit')
    }
    return []
  }
}

const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)

const applyMigrations = (database: DatabaseSync) => {
  for (const migration of readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    database.exec(readFileSync(`${migrationsDirectory}${migration}`, 'utf8'))
}

const privateKeyPem = () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`
}

const seedOperation = (database: DatabaseSync) => {
  database.exec(`
    INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('actor-a', 'access-a', 'actor@example.com', 'Actor', 'active', 'now', 'now');
    INSERT INTO organizations (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES ('org-a', 'Org A', 'org-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now');
    INSERT INTO organization_memberships (organization_id, identity_id, role, status, joined_at)
    VALUES ('org-a', 'actor-a', 'owner', 'active', 'now');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress, idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES ('operation-a', 'org-a', 'server.start', 'server', 'server-a', 'actor-a', 'queued', 0, 'request-a', 'correlation-a', 1, 'now', 'now');
  `)
}

const payload = {
  schemaVersion: 1,
  organizationId: 'org-a',
  actorId: 'actor-a',
  operationId: 'operation-a',
  serverId: 'server-a',
  nodeId: 'node-a',
  deploymentId: 'deployment-a',
  plugin: { id: 'arma-reforger', version: '1.0.0' },
  image: { installer: `sha256:${'a'.repeat(64)}`, runtime: `sha256:${'b'.repeat(64)}` },
  ports: [],
  resources: { cpu: 1, memoryMiB: 128, diskGiB: 1 },
  config: {},
  mods: [],
  configRevision: 1,
  modRevision: 0,
  expectedPriorRevision: 0,
  action: 'start',
  expiresAt: '2099-01-01T00:00:00.000Z',
} as const

const seedDeleteDnsOperation = (database: DatabaseSync) => {
  database.exec(`
    INSERT INTO game_plugins (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
    INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, domain, desired_revision, observed_revision, active_config_revision,
       created_at, updated_at, pending_lifecycle_operation_id)
    VALUES ('org-a', 'server-delete', 'Delete me', 'arma-reforger', '1.0.0', 'deleted', 'deleting',
      '{}', 'delete.example.test', 2, 1, 1, 'now', 'now', 'operation-delete');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES ('operation-delete', 'org-a', 'server.delete', 'server', 'server-delete', 'actor-a',
      'queued', 0, 'request-delete', 'correlation-delete', 1, 'now', 'now');
    INSERT INTO dns_records
      (organization_id, id, server_id, provider_record_id, hostname, target, proxy_mode, state, revision)
    VALUES ('org-a', 'dns-delete', 'server-delete', 'record-old', 'delete.example.test',
      '203.0.113.20', 'dns_only', 'active', 1);
  `)
}

/**
 * A fully accepted move without DNS. The coordinator owns transitions from
 * this point forward; this fixture deliberately does not force an operation
 * terminal state or bypass the move admission fences.
 */
const seedAcceptedMove = async (database: DatabaseSync) => {
  database.exec(`
    INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('move-actor', 'move-access', 'move@example.com', 'Move actor', 'active', 'now', 'now');
    INSERT INTO organizations (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES ('move-org', 'Move org', 'move-org', 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now');
    INSERT INTO organization_memberships (organization_id, identity_id, role, status, joined_at)
    VALUES ('move-org', 'move-actor', 'operator', 'active', 'now');
    INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
    VALUES ('move-provider', 'organization', 'move-org', 'ovhcloud', 'provider-ref', 'active', 1, 'now', 'now');
    INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
    VALUES ('move-org', 'move-provider', '["eu-west"]', '["small"]', 2, 'active', 1);
    INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
    VALUES ('move-image', 'move-image-v1', 'checksum', 'signature', '{}', 'promoted', 'now', 'now');
    INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
       placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
    VALUES
      ('move-org', 'move-node-a', 'move-provider', 'move-instance-a', 'ovhcloud', 'eu-west', 'small', 'move-image',
       'shared', 'ready', 'ready', 1, 1, 'now', 'now'),
      ('move-org', 'move-node-b', 'move-provider', 'move-instance-b', 'ovhcloud', 'eu-west', 'small', 'move-image',
       'shared', 'ready', 'ready', 1, 1, 'now', 'now');
    INSERT INTO node_runtime_capacity
      (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
       agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
    VALUES
      ('move-org', 'move-node-a', 'amd64', 16000, 68719476736, 536870912000, 1, 1, 1, 1, 'now', 1),
      ('move-org', 'move-node-b', 'amd64', 16000, 68719476736, 536870912000, 1, 1, 1, 1, 'now', 1);
    INSERT INTO game_plugins (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('move-plugin', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES ('move-operation-a', 'move-org', 'server.move', 'server', 'move-server-a', 'move-actor', 'queued', 0,
      'move-request-a', 'move-correlation-a', 1, 'now', 'now');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES ('audit:move-operation-a', 'move-org', 'game-server.audit.move.accepted', 'server', 'move-server-a',
      'move-actor', 'succeeded', 100, 'audit:move-operation-a', 'move-correlation-a', 1, 'now', 'now');
    INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, desired_revision, observed_revision, active_config_revision,
       created_at, updated_at, pending_lifecycle_operation_id)
    VALUES ('move-org', 'move-server-a', 'Move server', 'move-plugin', '1.0.0', 'running', 'moving',
      '{}', 2, 1, 1, 'now', 'now', 'move-operation-a');
    INSERT INTO deployments
      (organization_id, id, server_id, node_id, desired_revision, observed_revision, observed_state, created_at, updated_at)
    VALUES ('move-org', 'move-deployment-a', 'move-server-a', 'move-node-a', 1, 1, 'running', 'now', 'now');
    INSERT INTO server_capacity_reservations
      (organization_id, id, node_id, server_id, operation_id, cpu_millis, ram_bytes, disk_bytes,
       capacity_revision, state, created_at)
    VALUES ('move-org', 'move-capacity-a', 'move-node-a', 'move-server-a', 'move-operation-a',
      2000, 4294967296, 21474836480, 1, 'reserved', 'now');
    UPDATE server_capacity_reservations SET state = 'active'
      WHERE organization_id = 'move-org' AND id = 'move-capacity-a';
    INSERT INTO port_leases
      (organization_id, id, node_id, server_id, protocol, public_port, container_port, state,
       operation_id, revision, created_at)
    VALUES ('move-org', 'move-port-a', 'move-node-a', 'move-server-a', 'udp', 22001, 2001, 'active',
      'move-operation-a', 1, 'now');
    INSERT INTO lifecycle_workflow_starts
      (organization_id, operation_id, start_record_id, state, attempts, created_at, updated_at)
    VALUES ('move-org', 'move-operation-a', 'move-workflow-a', 'pending', 0, 'now', 'now');
  `)
  const acceptedAt = '2026-08-23T12:00:00.000Z'
  const envelope = await Effect.runPromise(
    completeAuditEnvelope({
      occurredAt: acceptedAt,
      scope: 'tenant',
      organizationId: 'move-org',
      actor: { type: 'human', id: 'move-actor' },
      action: 'game-server.move.accepted',
      target: { type: 'server', id: 'move-server-a' },
      before: { state: 'captured', summary: { nodeId: 'move-node-a' } },
      after: { state: 'captured', summary: { nodeId: 'move-node-b' } },
      operationId: 'audit:move-operation-a',
      request: {
        origin: 'http',
        requestId: 'move-request-a',
        correlationId: 'move-correlation-a',
        source: {
          ip: { state: 'captured', value: '203.0.113.10' },
          access: {
            state: 'captured',
            value: {
              subject: 'move-access',
              identityId: 'move-actor',
              issuer: 'https://access.gridora.test',
              email: 'move@example.com',
            },
          },
        },
      },
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }),
  )
  const staged = await Effect.runPromise(
    stageAuditEnvelope('tenant', 'move-audit-a', envelope, acceptedAt),
  )
  database.prepare(auditEnvelopeStageSql).run(...(auditEnvelopeStageBindings(staged) as Input[]))
  database.exec(`
    INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
    VALUES ('move-audit-a', 'move-org', 'move-actor', 'game-server.move.accepted', 'server', 'move-server-a',
      'succeeded', 'move-correlation-a', '{"nodeId":"move-node-b"}', '${acceptedAt}');
    INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, available_at, created_at)
    VALUES ('move-outbox-a', 'move-org', 'game-server.lifecycle.accepted', 'game_server', 'move-server-a',
      '{"operationId":"move-operation-a"}', 'now', 'now');
    INSERT INTO game_lifecycle_move_reservations
      (organization_id, id, operation_id, server_id, expected_revision, source_node_id, target_node_id,
       cpu_millis, ram_bytes, disk_bytes, target_capacity_revision, state, created_at, updated_at)
    VALUES ('move-org', 'move-operation-a:target', 'move-operation-a', 'move-server-a', 1,
      'move-node-a', 'move-node-b', 2000, 4294967296, 21474836480, 1, 'reserved', 'now', 'now');
    INSERT INTO game_lifecycle_moves
      (organization_id, idempotency_key, action, request_fingerprint, operation_id, server_id,
       expected_revision, source_node_id, target_node_id, source_deployment_id, backup_policy,
       backup_id, phase, source_preserved, acceptance_audit_event_id, result_json, revision, created_at, updated_at)
    VALUES ('move-org', 'move-request-a', 'move', '${'a'.repeat(64)}', 'move-operation-a', 'move-server-a',
      1, 'move-node-a', 'move-node-b', 'move-deployment-a', 'required', NULL, 'reserved', 1,
      'move-audit-a', '{"targetNodeId":"move-node-b"}', 1, 'now', 'now');
  `)
}

const moveWorkflowPayload = {
  ...payload,
  organizationId: 'move-org',
  actorId: 'move-actor',
  operationId: 'move-operation-a',
  serverId: 'move-server-a',
  nodeId: 'move-node-a',
  targetNodeId: 'move-node-b',
  deploymentId: 'move-deployment-a',
  plugin: { id: 'move-plugin', version: '1.0.0' },
  ports: [{ protocol: 'udp' as const, containerPort: 2001, publicPort: 22001, purpose: 'game' }],
  expectedPriorRevision: 1,
  action: 'move' as const,
}

const physicalEvidence = (effect: GameMoveEffect, phase: string) => ({
  effectId: effect.effectId,
  receipt: {
    phase,
    sourceNodeId: effect.source.nodeId,
    targetNodeId: effect.target.nodeId,
    sourceDeploymentId: effect.sourceDeploymentId,
  },
})

const seedMoveBackup = (database: DatabaseSync) => {
  const checksum = `sha256:${'c'.repeat(64)}`
  database.exec(`
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES ('move-backup-operation-a', 'move-org', 'backup.create', 'game-server', 'move-server-a',
      'move-actor', 'succeeded', 100, 'move-backup-request-a', 'move-correlation-a', 1, 'now', 'now');
    INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json,
       state, revision, created_at, expires_at)
    VALUES ('move-org', 'move-backup-a', 'move-server-a',
      'organizations/move-org/backups/move-backup-a.tar.zst', '${checksum}', 1,
      '{"pluginId":"move-plugin","pluginVersion":"1.0.0","gameBuild":"move-build",' ||
      '"configRevision":1,"modSetRevision":0,"desiredRevision":2,"nodeId":"move-node-a",' ||
      '"consistency":"crash-consistent","includes":["config","data","mods","state"],' ||
      '"containsGameBinaries":false}',
      'available', 1, '2026-08-23T12:00:00.000Z', NULL);
    INSERT INTO backup_jobs
      (organization_id, id, operation_id, mode, trigger, backup_id, source_server_id, source_node_id,
       idempotency_key, fingerprint, request_json, audit_request_context_json, audit_actor_type,
       state, revision, created_at, updated_at)
    VALUES ('move-org', 'move-backup-job-a', 'move-backup-operation-a', 'create', 'manual',
      'move-backup-a', 'move-server-a', 'move-node-a', 'game-move:move-operation-a:backup',
      '${'d'.repeat(64)}', '{"schemaVersion":1}',
      '{"origin":"internal","requestId":"workflow:move-operation-a",' ||
      '"correlationId":"move-operation-a","source":{"ip":{"state":"not-available"},' ||
      '"access":{"state":"not-available"}}}',
      'system', 'succeeded', 1, '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z');
  `)
}

describe('game lifecycle command delivery', () => {
  it('forces cleanup only through an exact failed-node lifecycle receipt and adopts terminal evidence', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    database.exec(`
      INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('force-actor', 'force-access', 'force@example.com', 'Force actor', 'active', 'now', 'now');
      INSERT INTO organizations (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('force-org', 'Force org', 'force-org', 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now');
      INSERT INTO organization_memberships (organization_id, identity_id, role, status, joined_at)
      VALUES ('force-org', 'force-actor', 'administrator', 'active', 'now');
      INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('force-provider', 'organization', 'force-org', 'ovhcloud', 'force-provider-envelope', 'active', 1, 'now', 'now');
      INSERT INTO secret_envelopes
        (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
         key_version, revision, created_at, rotated_at)
      VALUES ('force-org', 'force-provider-envelope', 'provider-account', 'force-provider',
        'force-ciphertext', 'force-wrapped-key', 1, 1, 'now', NULL);
      INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('force-org', 'force-provider', '["eu-west"]', '["small"]', 1, 'active', 1);
      INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('force-image', 'force-image-v1', 'checksum', 'signature', '{}', 'promoted', 'now', 'now');
      INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('node-retire-operation', 'force-org', 'retire-node', 'node', 'force-node',
        'force-actor', 'queued', 0, 'node-retire-key', 'node-retire-correlation', 1, 'now', 'now'),
       ('force-initial-operation', 'force-org', 'server.create', 'server', 'force-server',
        'force-actor', 'succeeded', 100, 'force-initial-key', 'force-initial-correlation', 1, 'now', 'now');
      INSERT INTO destructive_lifecycle_operations
        (organization_id, operation_id, action, resource_type, resource_id, actor_id,
         idempotency_key, request_fingerprint, cancellation_policy, state, revision, accepted_at, updated_at)
      VALUES ('force-org', 'node-retire-operation', 'retire-node', 'node', 'force-node',
        'force-actor', 'node-retire-key', '${'a'.repeat(64)}', 'before-destructive-step',
        'queued', 1, 'now', 'now');
      INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
         image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
         pending_lifecycle_operation_id, created_at, updated_at)
      VALUES ('force-org', 'force-node', 'force-provider', 'force-instance', 'ovhcloud', 'eu-west',
        'small', 'force-image', 'shared', 'draining', 'failed', 2, 7,
        'node-retire-operation', 'now', 'now');
      INSERT INTO node_lifecycle_runs
        (organization_id, operation_id, node_id, action, previous_desired_state,
         previous_desired_revision, desired_revision, force_requested, backup_policy,
         target_image_id, state, provider_retirement_state, billing_state, created_at, updated_at,
         provider_account_id, provider_account_scope, provider_account_revision,
         provider_allocation_revision, provider_credential_reference, provider_credential_revision,
         provider_type_snapshot, provider_instance_id_snapshot, audit_request_context_json)
      VALUES ('force-org', 'node-retire-operation', 'force-node', 'retire-node', 'ready',
        1, 2, 1, 'skip-authorized', NULL, 'draining', 'not-started', 'not-applicable', 'now', 'now',
        'force-provider', 'organization', 1, 1, 'force-provider-envelope', 1,
        'ovhcloud', 'force-instance',
        '{"origin":"http","requestId":"node-retire-request","correlationId":"node-retire-correlation","source":{"ip":{"state":"captured","value":"203.0.113.10"},"access":{"state":"captured","value":{"subject":"force-access","identityId":"force-actor","issuer":"https://access.gridora.test","email":"force@example.com"}}}}');
      INSERT INTO game_plugins (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('force-plugin', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
      INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, domain, desired_revision, observed_revision, active_config_revision,
         created_at, updated_at)
      VALUES ('force-org', 'force-server', 'Force server', 'force-plugin', '1.0.0', 'running',
        'failed', '{"mode":"shared","nodeId":"force-node"}', NULL, 1, 1, 1, 'now', 'now');
      INSERT INTO deployments
        (organization_id, id, server_id, node_id, desired_revision, observed_revision,
         observed_state, created_at, updated_at)
      VALUES ('force-org', 'force-deployment', 'force-server', 'force-node', 1, 1, 'failed', 'now', 'now');
      INSERT INTO node_lifecycle_affected_servers
        (organization_id, operation_id, server_id, deployment_id, desired_revision, state, resolved_at)
      VALUES ('force-org', 'node-retire-operation', 'force-server', 'force-deployment', 1, 'pending', NULL);
      INSERT INTO port_leases
        (organization_id, id, node_id, server_id, protocol, public_port, container_port,
         state, operation_id, revision, created_at)
      VALUES ('force-org', 'force-port', 'force-node', 'force-server', 'udp', 22001, 2001,
        'active', 'force-initial-operation', 1, 'now');
      INSERT INTO mod_sets
        (organization_id, server_id, schema_version, desired_revision, resolved_revision,
         desired_json, resolved_json, revision)
      VALUES ('force-org', 'force-server', 1, 1, 0, '[]', '[]', 1);
      INSERT INTO game_server_desired_specs
        (organization_id, server_id, schema_version, desired_revision, source_operation_id,
         spec_json, created_at, updated_at)
      VALUES ('force-org', 'force-server', 1, 1, 'force-initial-operation',
        '{"schemaVersion":1,"plugin":{"id":"force-plugin","version":"1.0.0"},"placement":{"mode":"shared","nodeId":"force-node"},"resources":{"cpuMillis":1000,"ramBytes":134217728,"diskBytes":1073741824},"endpoint":{},"updatePolicy":{"mode":"manual","backupBeforeUpdate":true},"backupPolicy":{"schedule":"0 4 * * *","retainCount":7},"config":{},"mods":[]}',
        'now', 'now');
    `)
    const d1 = new SqliteD1(database)
    const lifecycle = makeGameLifecycleD1Repository(d1, {
      now: () => '2026-08-24T12:00:00.000Z',
      operationId: () => 'force-delete-operation',
      auditEventId: () => 'force-delete-audit',
      outboxEventId: () => 'force-delete-outbox',
    })
    const acceptance = await Effect.runPromise(
      lifecycle.mutate({
        organizationId: 'force-org',
        actorId: 'force-actor',
        auditActorType: 'human',
        auditRequestContext: {
          origin: 'http',
          requestId: 'force-request',
          correlationId: 'force-correlation',
          source: {
            ip: { state: 'captured', value: '203.0.113.10' },
            access: {
              state: 'captured',
              value: {
                subject: 'force-access',
                identityId: 'force-actor',
                issuer: 'https://access.gridora.test',
                email: 'force@example.com',
              },
            },
          },
        },
        idempotencyKey: 'force-delete-key',
        correlationId: 'force-correlation',
        serverId: 'force-server',
        expectedRevision: 1,
        intent: { action: 'delete', backupPolicy: 'skip-authorized', forcedCleanup: true },
      }),
    )
    expect(acceptance.operation.operationId).toBe('force-delete-operation')
    const forcedPayload = {
      ...payload,
      organizationId: 'force-org',
      actorId: 'force-actor',
      operationId: 'force-delete-operation',
      serverId: 'force-server',
      nodeId: 'force-node',
      deploymentId: 'force-deployment',
      plugin: { id: 'force-plugin', version: '1.0.0' },
      ports: [
        { protocol: 'udp' as const, containerPort: 2001, publicPort: 22001, purpose: 'game' },
      ],
      expectedPriorRevision: 1,
      action: 'delete' as const,
      backupPolicy: 'skip-authorized' as const,
      forcedCleanup: true as const,
    }
    const bindings = {
      database: d1,
      nodeCoordinator: {} as DurableObjectNamespace<NodeCoordinatorDO>,
      signingKey: { get: async () => privateKeyPem() },
    }
    for (const step of [
      'authorize-force-cleanup',
      'stop',
      'remove',
      'release-ports',
      'delete-dns',
      'verify-observation',
    ] as const)
      await Effect.runPromise(executeGameLifecycleWorkflowStep(bindings, forcedPayload, step))
    expect(
      database.prepare(`SELECT state, revision FROM game_failed_node_cleanup_receipts`).get(),
    ).toEqual({ state: 'completed', revision: 2 })
    expect(
      database
        .prepare(
          `SELECT observed_state AS observedState FROM deployments WHERE id = 'force-deployment'`,
        )
        .get(),
    ).toEqual({ observedState: 'deleted' })
    expect(
      database
        .prepare(
          `SELECT state FROM node_lifecycle_affected_servers WHERE server_id = 'force-server'`,
        )
        .get(),
    ).toEqual({ state: 'deleted' })
    expect(
      database
        .prepare(`SELECT status, progress FROM operations WHERE id = 'force-delete-operation'`)
        .get(),
    ).toEqual({ status: 'succeeded', progress: 100 })
    const envelope = database
      .prepare(`SELECT envelope_json AS envelopeJson FROM audit_event_envelopes
      WHERE event_id = 'force-delete-audit'`)
      .get() as { envelopeJson: string }
    expect(JSON.parse(envelope.envelopeJson)).toMatchObject({ forced: true })
    database.close()
  })

  it('adopts a response-lost physical cutover and reverses immutable move effects before recording rollback', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    await seedAcceptedMove(database)
    const d1 = new SqliteD1(database)
    const phases: string[] = []
    let releaseSawTargetDeployment = false
    const adapter: GameMoveBackupAdapter = {
      backupSource: (_payload, effect) =>
        Effect.sync(() => {
          phases.push('backup')
          expect(effect?.effectId).toBe('game-move-effect:move-operation-a')
          return {
            backupId: 'backup-move-a',
            sourcePreserved: true as const,
            evidence: physicalEvidence(effect!, 'backup'),
          }
        }),
      restoreTarget: (_payload, backupId, effect) =>
        Effect.sync(() => {
          phases.push('restore')
          expect(backupId).toBe('backup-move-a')
          expect(effect.source).toMatchObject({
            nodeId: 'move-node-a',
            providerInstanceId: 'move-instance-a',
          })
          expect(effect.target).toMatchObject({
            nodeId: 'move-node-b',
            providerInstanceId: 'move-instance-b',
          })
          return { restored: true as const, evidence: physicalEvidence(effect, 'restore') }
        }),
      verifyTarget: (_payload, backupId, effect) =>
        Effect.sync(() => {
          phases.push('validate')
          expect(backupId).toBe('backup-move-a')
          return { validated: true as const, evidence: physicalEvidence(effect, 'validate') }
        }),
      cutoverEndpoint: (_payload, backupId, effect) =>
        Effect.sync(() => {
          phases.push('cutover')
          expect(backupId).toBe('backup-move-a')
          return {
            cutover: true as const,
            sourcePreserved: true as const,
            evidence: physicalEvidence(effect, 'cutover'),
          }
        }),
      releaseSource: (_payload, backupId, effect) =>
        Effect.sync(() => {
          phases.push('release')
          expect(backupId).toBe('backup-move-a')
          releaseSawTargetDeployment =
            (
              database
                .prepare(
                  `SELECT node_id AS nodeId FROM deployments
           WHERE organization_id = 'move-org' AND id = 'move-deployment-a'`,
                )
                .get() as { readonly nodeId: string }
            ).nodeId === 'move-node-b'
          return {
            released: true as const,
            sourcePreserved: true as const,
            evidence: physicalEvidence(effect, 'release'),
          }
        }),
      rollback: (_payload, backupId, effect) =>
        Effect.sync(() => {
          phases.push('rollback')
          expect(backupId).toBe('backup-move-a')
          // The persisted cutover is the only source for reverse work; no
          // mutable deployment lookup is supplied to the adapter.
          expect(effect.state).toBe('cutover')
          return {
            rolledBack: true as const,
            sourcePreserved: true as const,
            evidence: physicalEvidence(effect, 'rollback'),
          }
        }),
    }
    const coordinator = makeGameMoveCoordinator(d1, adapter)

    await Effect.runPromise(coordinator(moveWorkflowPayload, 'reserve-target'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'backup-source'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'stop-source'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'restore-target'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'verify-target'))

    // The effect and target deployment commit, then D1 loses its response.
    // The coordinator must adopt that exact transition instead of repeating
    // the physical cutover on Workflow retry.
    d1.loseNextBatchResponseAfterCommit()
    await expect(
      Effect.runPromise(coordinator(moveWorkflowPayload, 'cutover-endpoint')),
    ).resolves.toMatchObject({
      step: 'cutover-endpoint',
      revision: 6,
    })
    expect(phases).toEqual(['backup', 'restore', 'validate', 'cutover'])
    expect(
      database
        .prepare(
          `SELECT phase, revision FROM game_lifecycle_moves
       WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`,
        )
        .get(),
    ).toEqual({ phase: 'cutover', revision: 6 })
    expect(
      database
        .prepare(
          `SELECT state, revision FROM game_lifecycle_move_effects
       WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`,
        )
        .get(),
    ).toEqual({ state: 'cutover', revision: 2 })

    // A later post-source failure drives reverse data/agent cutover first;
    // only its immutable effect receipt permits the D1 rollback phase.
    await expect(
      Effect.runPromise(coordinator(moveWorkflowPayload, 'rollback-if-required')),
    ).resolves.toMatchObject({
      step: 'rollback-if-required',
      revision: 7,
    })
    expect(phases).toEqual(['backup', 'restore', 'validate', 'cutover', 'rollback'])
    expect(releaseSawTargetDeployment).toBe(false)
    expect(
      database
        .prepare(
          `SELECT phase, source_preserved AS sourcePreserved FROM game_lifecycle_moves
       WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`,
        )
        .get(),
    ).toEqual({ phase: 'rolled_back', sourcePreserved: 1 })
    expect(
      database
        .prepare(
          `SELECT node_id AS nodeId FROM deployments
       WHERE organization_id = 'move-org' AND id = 'move-deployment-a'`,
        )
        .get(),
    ).toEqual({ nodeId: 'move-node-a' })
    expect(
      database
        .prepare(
          `SELECT node_id AS nodeId, state FROM server_capacity_reservations
       WHERE organization_id = 'move-org' AND server_id = 'move-server-a'`,
        )
        .get(),
    ).toEqual({ nodeId: 'move-node-a', state: 'active' })
    expect(
      database
        .prepare(
          `SELECT phase FROM game_lifecycle_move_effect_receipts
       WHERE organization_id = 'move-org' AND effect_id = 'game-move-effect:move-operation-a'
       ORDER BY phase`,
        )
        .all(),
    ).toEqual([
      { phase: 'backup' },
      { phase: 'cutover' },
      { phase: 'restore' },
      { phase: 'rollback' },
      { phase: 'validate' },
    ])
    database.close()
  })

  it('does not release the source before the immutable target cutover is committed', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    await seedAcceptedMove(database)
    const d1 = new SqliteD1(database)
    let releaseCalls = 0
    const adapter: GameMoveBackupAdapter = {
      backupSource: (_payload, effect) =>
        Effect.succeed({
          backupId: 'backup-move-a',
          sourcePreserved: true as const,
          evidence: physicalEvidence(effect!, 'backup'),
        }),
      restoreTarget: (_payload, _backupId, effect) =>
        Effect.succeed({
          restored: true as const,
          evidence: physicalEvidence(effect, 'restore'),
        }),
      verifyTarget: (_payload, _backupId, effect) =>
        Effect.succeed({
          validated: true as const,
          evidence: physicalEvidence(effect, 'validate'),
        }),
      cutoverEndpoint: (_payload, _backupId, effect) =>
        Effect.succeed({
          cutover: true as const,
          sourcePreserved: true as const,
          evidence: physicalEvidence(effect, 'cutover'),
        }),
      releaseSource: (_payload, _backupId, effect) =>
        Effect.sync(() => {
          releaseCalls += 1
          return {
            released: true as const,
            sourcePreserved: true as const,
            evidence: physicalEvidence(effect, 'release'),
          }
        }),
      rollback: (_payload, _backupId, effect) =>
        Effect.succeed({
          rolledBack: true as const,
          sourcePreserved: true as const,
          evidence: physicalEvidence(effect, 'rollback'),
        }),
    }
    const coordinator = makeGameMoveCoordinator(d1, adapter)
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'backup-source'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'stop-source'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'restore-target'))
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'verify-target'))

    await expect(
      Effect.runPromise(coordinator(moveWorkflowPayload, 'release-source')),
    ).rejects.toMatchObject({
      code: 'move-phase-invalid',
    })
    expect(releaseCalls).toBe(0)
    await Effect.runPromise(coordinator(moveWorkflowPayload, 'cutover-endpoint'))
    await expect(
      Effect.runPromise(coordinator(moveWorkflowPayload, 'release-source')),
    ).resolves.toMatchObject({
      step: 'release-source',
      revision: 7,
    })
    expect(releaseCalls).toBe(1)
    expect(
      database
        .prepare(
          `SELECT phase FROM game_lifecycle_moves
       WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`,
        )
        .get(),
    ).toEqual({ phase: 'released' })
    expect(
      database
        .prepare(
          `SELECT state FROM game_lifecycle_move_effects
       WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`,
        )
        .get(),
    ).toEqual({ state: 'released' })
    database.close()
  })

  it('records and adopts an operation-bound Cloudflare DNS deletion receipt', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    seedOperation(database)
    seedDeleteDnsOperation(database)
    const recorder = makeGameDnsReceiptRecorder(new SqliteD1(database), {
      zoneId: 'zone-a',
      type: 'A',
      target: '203.0.113.20',
      providerRecordId: 'record-old',
    })
    const deletePayload = {
      ...payload,
      operationId: 'operation-delete',
      serverId: 'server-delete',
      action: 'delete' as const,
      expectedPriorRevision: 1,
      domain: 'delete.example.test',
    }
    const first = await Effect.runPromise(
      recorder(deletePayload, 'delete-dns', {
        success: true,
        result: { id: 'record-old', type: 'A', name: 'delete.example.test' },
      }),
    )
    expect(first).toMatchObject({
      organizationId: 'org-a',
      serverId: 'server-delete',
      operationId: 'operation-delete',
      step: 'delete-dns',
      revision: 1,
    })
    expect(
      database
        .prepare(
          'SELECT state, target, provider_record_id AS providerRecordId FROM dns_records WHERE id = ?',
        )
        .get('dns-delete'),
    ).toEqual({
      state: 'deleted',
      target: '203.0.113.20',
      providerRecordId: 'record-old',
    })
    const second = await Effect.runPromise(
      recorder(deletePayload, 'delete-dns', {
        success: true,
        result: { id: 'different-provider-record' },
      }),
    )
    expect(second).toEqual(first)
    const wrongProviderIdentity = makeGameDnsReceiptRecorder(new SqliteD1(database), {
      zoneId: 'zone-a',
      type: 'A',
      target: '203.0.113.20',
      providerRecordId: 'foreign-record',
    })
    await expect(
      Effect.runPromise(wrongProviderIdentity(deletePayload, 'delete-dns', undefined)),
    ).rejects.toMatchObject({ code: 'dns-receipt-mismatch' })
    expect(
      database.prepare('SELECT count(*) AS count FROM game_dns_lifecycle_receipts').get(),
    ).toEqual({ count: 1 })
    const foreign = { ...deletePayload, serverId: 'foreign-server' }
    await expect(
      Effect.runPromise(recorder(foreign, 'delete-dns', undefined)),
    ).rejects.toMatchObject({
      _tag: 'GameWorkflowStepError',
      code: 'dns-receipt-mismatch',
    })
    database.close()
  })

  it('resolves DNS teardown from the immutable publish receipt rather than the current configured zone', async () => {
    const receipt = {
      zoneId: 'published-zone-a',
      providerRecordId: 'published-record-a',
      recordType: 'A',
      target: '203.0.113.20',
    }
    const statement = {
      bind: vi.fn(function bind() {
        return statement
      }),
      first: vi.fn(async () => receipt),
    }
    const prepare = vi.fn(() => statement)
    const database = { prepare } as unknown as GameLifecycleD1Database
    const resolve = makeGameDnsAuthorityResolver(database, 'current-worker-zone-must-not-be-used')
    const deletePayload = {
      ...payload,
      operationId: 'operation-delete',
      serverId: 'server-delete',
      action: 'delete' as const,
      expectedPriorRevision: 1,
      domain: 'delete.example.test',
    }

    await expect(Effect.runPromise(resolve(deletePayload))).resolves.toEqual({
      zoneId: 'published-zone-a',
      providerRecordId: 'published-record-a',
      type: 'A',
      target: '203.0.113.20',
    })
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('receipt.zone_id AS zoneId'))
    expect(statement.bind).toHaveBeenCalledWith(
      'org-a',
      'server-delete',
      'delete.example.test',
      'operation-delete',
    )
  })

  it('stages and physically compensates a target move without making it authoritative before cutover', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    await seedAcceptedMove(database)
    seedMoveBackup(database)
    const d1 = new SqliteD1(database)
    const queued: AgentCommand[] = []
    const targetDeploymentNodes: string[] = []
    let startCalls = 0
    let loseTargetStageResult = true
    const coordinator = {
      enqueue: vi.fn(async (command: AgentCommand) => {
        queued.push(command)
      }),
      waitForCommandResult: vi.fn(
        async (_organizationId: string, _nodeId: string, commandId: string) => {
          const command = queued.find((candidate) => candidate.commandId === commandId)!
          if (
            command.type === 'backup.restore' &&
            (command.payload as { readonly phase?: string }).phase === 'stage'
          ) {
            targetDeploymentNodes.push(
              (
                database
                  .prepare(
                    `SELECT node_id AS nodeId FROM deployments
             WHERE organization_id = 'move-org' AND id = 'move-deployment-a'`,
                  )
                  .get() as { readonly nodeId: string }
              ).nodeId,
            )
            if (loseTargetStageResult) {
              loseTargetStageResult = false
              d1.loseNextBatchResponseAfterCommit()
            }
          }
          return {
            commandId,
            operationId: 'move-operation-a',
            status: 'succeeded' as const,
            revision: 1,
            code: 'ok',
            message: command.type,
            duplicate: false,
            completedAt: '2026-08-23T12:00:00.000Z',
          }
        },
      ),
    }
    const backupControl = {
      create: vi.fn(() =>
        Effect.succeed({
          job: { backupId: 'move-backup-a' },
        }),
      ),
    }
    const adapter = await Effect.runPromise(
      makeNativeGameMoveBackupAdapter({
        database: d1 as unknown as GameLifecycleD1Database &
          import('@gridora/backup-d1').BackupD1Database,
        nodeCoordinator: {
          getByName: vi.fn(() => coordinator),
        } as unknown as DurableObjectNamespace<NodeCoordinatorDO>,
        signingKey: { get: vi.fn(async () => privateKeyPem()) },
        backupControl: backupControl as never,
        startBackupWorkflow: () =>
          Effect.sync(() => {
            startCalls += 1
          }),
      }),
    )
    const move = makeGameMoveCoordinator(d1, adapter)

    await Effect.runPromise(move(moveWorkflowPayload, 'backup-source'))
    await Effect.runPromise(move(moveWorkflowPayload, 'stop-source'))
    await Effect.runPromise(move(moveWorkflowPayload, 'restore-target'))
    await Effect.runPromise(move(moveWorkflowPayload, 'verify-target'))

    expect(startCalls).toBe(1)
    expect(backupControl.create).toHaveBeenCalledOnce()
    expect(targetDeploymentNodes).toEqual(['move-node-a'])
    expect(
      database
        .prepare(`SELECT state, target_node_id AS targetNodeId
      FROM game_lifecycle_move_target_stages WHERE organization_id = 'move-org'`)
        .get(),
    ).toEqual({
      state: 'validated',
      targetNodeId: 'move-node-b',
    })
    expect(
      database
        .prepare(`SELECT node_id AS nodeId FROM deployments
      WHERE organization_id = 'move-org' AND id = 'move-deployment-a'`)
        .get(),
    ).toEqual({ nodeId: 'move-node-a' })

    // The response from the target staging command is deliberately lost after
    // its D1 result row commits. The adapter adopts that exact command rather
    // than queueing another restore-stage command.
    expect(
      queued.filter(
        (command) =>
          command.type === 'backup.restore' &&
          (command.payload as { readonly phase?: string }).phase === 'stage',
      ),
    ).toHaveLength(1)
    const restoreCommands = queued.filter((command) => command.type === 'backup.restore')
    expect(restoreCommands).toHaveLength(2)
    for (const command of restoreCommands) {
      const restore = command.payload as {
        readonly targetServerId?: string
        readonly phase?: string
        readonly manifest?: { readonly backupId?: string }
        readonly restoreRoot?: string
        readonly stagingDirectory?: string
      }
      expect(command).toMatchObject({
        operationId: 'move-operation-a',
        nodeId: 'move-node-b',
        resourceId: 'move-server-a',
      })
      expect(restore.targetServerId).toBe('move-server-a')
      expect(restore.manifest?.backupId).toBe('move-backup-a')
      // The agent derives its sibling staging root and promoted validation
      // image from these operation-bound values. The move wire contract never
      // accepts a caller-selected host path.
      expect(restore.restoreRoot).toBeUndefined()
      expect(restore.stagingDirectory).toBeUndefined()
    }

    await Effect.runPromise(move(moveWorkflowPayload, 'cutover-endpoint'))
    expect(
      database
        .prepare(`SELECT state FROM game_lifecycle_move_target_stages
      WHERE organization_id = 'move-org'`)
        .get(),
    ).toEqual({ state: 'active' })
    expect(
      database
        .prepare(`SELECT node_id AS nodeId FROM deployments
      WHERE organization_id = 'move-org' AND id = 'move-deployment-a'`)
        .get(),
    ).toEqual({ nodeId: 'move-node-b' })
    // This is an actual fenced cutover, not a test-only phase mutation. A
    // signed Workflow retry must still reconstruct the originally accepted
    // source coordinates even though the authoritative deployment now points
    // to the target.
    const replay = await Effect.runPromise(
      makeGameLifecyclePlanningD1Repository(d1, {
        imageCatalog: [
          {
            pluginId: 'move-plugin',
            activeVersion: '1.0.0',
            selectionRevision: 1,
            image: {
              installer: `sha256:${'a'.repeat(64)}`,
              runtime: `sha256:${'b'.repeat(64)}`,
            },
          },
        ],
      }).readWorkflowData('move-org', 'move-operation-a'),
    )
    expect(replay).toMatchObject({
      nodeId: 'move-node-a',
      targetNodeId: 'move-node-b',
      deploymentId: 'move-deployment-a',
      movePhase: 'cutover',
    })
    await Effect.runPromise(move(moveWorkflowPayload, 'rollback-if-required'))

    expect(queued.map((command) => command.type)).toContain('deployment.remove')
    expect(queued.map((command) => command.type)).toContain('deployment.apply')
    expect(queued.map((command) => command.type)).toContain('server.start')
    expect(
      database
        .prepare(`SELECT phase FROM game_lifecycle_moves
      WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`)
        .get(),
    ).toEqual({ phase: 'rolled_back' })
    expect(
      database
        .prepare(`SELECT state FROM game_lifecycle_move_target_stages
      WHERE organization_id = 'move-org'`)
        .get(),
    ).toEqual({ state: 'rolled_back' })
    expect(
      database
        .prepare(`SELECT action, state FROM game_lifecycle_move_physical_commands
      WHERE organization_id = 'move-org' ORDER BY action`)
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { action: 'restore-stage', state: 'succeeded' },
        { action: 'restore-validate', state: 'succeeded' },
        { action: 'restore-commit', state: 'succeeded' },
        { action: 'activate-target', state: 'succeeded' },
        { action: 'rollback-target', state: 'succeeded' },
        { action: 'rollback-stage', state: 'succeeded' },
        { action: 'rollback-source-deploy', state: 'succeeded' },
        { action: 'rollback-source-start', state: 'succeeded' },
      ]),
    )
    database.close()
  })

  it('physically reverses a failed target validation and restarts the source before recording rollback', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    await seedAcceptedMove(database)
    seedMoveBackup(database)
    const d1 = new SqliteD1(database)
    const queued: AgentCommand[] = []
    const node = {
      enqueue: vi.fn(async (command: AgentCommand) => {
        queued.push(command)
      }),
      waitForCommandResult: vi.fn(
        async (_organizationId: string, _nodeId: string, commandId: string) => {
          const command = queued.find((candidate) => candidate.commandId === commandId)!
          const phase =
            command.type === 'backup.restore'
              ? (command.payload as { readonly phase?: string }).phase
              : undefined
          return {
            commandId,
            operationId: 'move-operation-a',
            status: phase === 'validate' ? ('failed' as const) : ('succeeded' as const),
            revision: 1,
            code: phase === 'validate' ? 'validation-failed' : 'ok',
            message: command.type,
            duplicate: false,
            completedAt: '2026-08-23T12:00:00.000Z',
          }
        },
      ),
    }
    const nodeCoordinator = {
      getByName: vi.fn(() => node),
    } as unknown as DurableObjectNamespace<NodeCoordinatorDO>
    const adapter = await Effect.runPromise(
      makeNativeGameMoveBackupAdapter({
        database: d1 as unknown as GameLifecycleD1Database &
          import('@gridora/backup-d1').BackupD1Database,
        nodeCoordinator,
        signingKey: { get: vi.fn(async () => privateKeyPem()) },
        backupControl: {
          create: () => Effect.succeed({ job: { backupId: 'move-backup-a' } }),
        } as never,
        startBackupWorkflow: () => Effect.void,
      }),
    )
    const move = makeGameMoveCoordinator(d1, adapter)
    await Effect.runPromise(move(moveWorkflowPayload, 'backup-source'))
    await Effect.runPromise(move(moveWorkflowPayload, 'stop-source'))
    await Effect.runPromise(move(moveWorkflowPayload, 'restore-target'))

    const result = await Effect.runPromise(
      Effect.result(
        executeGameLifecycleWorkflowStep(
          {
            database: d1,
            nodeCoordinator,
            signingKey: { get: vi.fn(async () => privateKeyPem()) },
            move,
          },
          moveWorkflowPayload,
          'verify-target',
        ),
      ),
    )

    expect(result._tag).toBe('Failure')
    expect(
      queued.some(
        (command) =>
          command.type === 'backup.restore' &&
          (command.payload as { readonly phase?: string }).phase === 'validate',
      ),
    ).toBe(true)
    expect(
      queued.some(
        (command) =>
          command.type === 'backup.restore' &&
          (command.payload as { readonly phase?: string }).phase === 'rollback',
      ),
    ).toBe(true)
    expect(
      queued.some(
        (command) => command.type === 'deployment.apply' && command.nodeId === 'move-node-a',
      ),
    ).toBe(true)
    expect(
      queued.some((command) => command.type === 'server.start' && command.nodeId === 'move-node-a'),
    ).toBe(true)
    // Target activation has not run, so compensation must not attempt a
    // spurious target deployment remove merely to satisfy a status check.
    expect(queued.some((command) => command.type === 'deployment.remove')).toBe(false)
    expect(
      database
        .prepare(`SELECT phase FROM game_lifecycle_moves
      WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`)
        .get(),
    ).toEqual({ phase: 'rolled_back' })
    expect(
      database
        .prepare(`SELECT state FROM game_lifecycle_move_target_stages
      WHERE organization_id = 'move-org'`)
        .get(),
    ).toEqual({ state: 'rolled_back' })
    expect(
      database
        .prepare(`SELECT action, state FROM game_lifecycle_move_physical_commands
      WHERE organization_id = 'move-org' ORDER BY action`)
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { action: 'restore-stage', state: 'succeeded' },
        { action: 'restore-validate', state: 'failed' },
        { action: 'rollback-stage', state: 'succeeded' },
        { action: 'rollback-source-deploy', state: 'succeeded' },
        { action: 'rollback-source-start', state: 'succeeded' },
      ]),
    )
    database.close()
  })

  it('physically reverses a failed target staging command before any target deployment is authoritative', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    await seedAcceptedMove(database)
    seedMoveBackup(database)
    const d1 = new SqliteD1(database)
    const queued: AgentCommand[] = []
    const node = {
      enqueue: vi.fn(async (command: AgentCommand) => {
        queued.push(command)
      }),
      waitForCommandResult: vi.fn(
        async (_organizationId: string, _nodeId: string, commandId: string) => {
          const command = queued.find((candidate) => candidate.commandId === commandId)!
          const phase =
            command.type === 'backup.restore'
              ? (command.payload as { readonly phase?: string }).phase
              : undefined
          return {
            commandId,
            operationId: 'move-operation-a',
            status: phase === 'stage' ? ('failed' as const) : ('succeeded' as const),
            revision: 1,
            code: phase === 'stage' ? 'restore-stage-failed' : 'ok',
            message: command.type,
            duplicate: false,
            completedAt: '2026-08-23T12:00:00.000Z',
          }
        },
      ),
    }
    const nodeCoordinator = {
      getByName: vi.fn(() => node),
    } as unknown as DurableObjectNamespace<NodeCoordinatorDO>
    const adapter = await Effect.runPromise(
      makeNativeGameMoveBackupAdapter({
        database: d1 as unknown as GameLifecycleD1Database &
          import('@gridora/backup-d1').BackupD1Database,
        nodeCoordinator,
        signingKey: { get: vi.fn(async () => privateKeyPem()) },
        backupControl: {
          create: () => Effect.succeed({ job: { backupId: 'move-backup-a' } }),
        } as never,
        startBackupWorkflow: () => Effect.void,
      }),
    )
    const move = makeGameMoveCoordinator(d1, adapter)
    await Effect.runPromise(move(moveWorkflowPayload, 'backup-source'))
    await Effect.runPromise(move(moveWorkflowPayload, 'stop-source'))

    const result = await Effect.runPromise(
      Effect.result(
        executeGameLifecycleWorkflowStep(
          {
            database: d1,
            nodeCoordinator,
            signingKey: { get: vi.fn(async () => privateKeyPem()) },
            move,
          },
          moveWorkflowPayload,
          'restore-target',
        ),
      ),
    )

    expect(result._tag).toBe('Failure')
    expect(
      queued.some(
        (command) =>
          command.type === 'backup.restore' &&
          (command.payload as { readonly phase?: string }).phase === 'stage',
      ),
    ).toBe(true)
    expect(
      queued.some(
        (command) =>
          command.type === 'backup.restore' &&
          (command.payload as { readonly phase?: string }).phase === 'rollback',
      ),
    ).toBe(true)
    expect(queued.some((command) => command.type === 'deployment.remove')).toBe(false)
    expect(
      queued.some(
        (command) => command.type === 'deployment.apply' && command.nodeId === 'move-node-a',
      ),
    ).toBe(true)
    expect(
      queued.some((command) => command.type === 'server.start' && command.nodeId === 'move-node-a'),
    ).toBe(true)
    expect(
      database
        .prepare(`SELECT phase FROM game_lifecycle_moves
      WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`)
        .get(),
    ).toEqual({ phase: 'rolled_back' })
    expect(
      database
        .prepare(`SELECT action, state FROM game_lifecycle_move_physical_commands
      WHERE organization_id = 'move-org' ORDER BY action`)
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { action: 'restore-stage', state: 'failed' },
        { action: 'rollback-stage', state: 'succeeded' },
        { action: 'rollback-source-deploy', state: 'succeeded' },
        { action: 'rollback-source-start', state: 'succeeded' },
      ]),
    )
    database.close()
  })

  it.each([
    { failure: 'cutover activation', workflowStep: 'cutover-endpoint' as const },
    { failure: 'source release', workflowStep: 'release-source' as const },
  ])(
    'physically compensates native $failure failure with immutable target/source commands',
    async ({ workflowStep }) => {
      const database = new DatabaseSync(':memory:')
      database.exec('PRAGMA foreign_keys = ON')
      applyMigrations(database)
      await seedAcceptedMove(database)
      seedMoveBackup(database)
      const d1 = new SqliteD1(database)
      const queued: AgentCommand[] = []
      const node = {
        enqueue: vi.fn(async (command: AgentCommand) => {
          queued.push(command)
        }),
        waitForCommandResult: vi.fn(
          async (_organizationId: string, _nodeId: string, commandId: string) => {
            const command = queued.find((candidate) => candidate.commandId === commandId)!
            const failActivation =
              workflowStep === 'cutover-endpoint' &&
              command.type === 'deployment.apply' &&
              command.nodeId === 'move-node-b'
            const failRelease =
              workflowStep === 'release-source' &&
              command.type === 'deployment.remove' &&
              command.nodeId === 'move-node-a'
            return {
              commandId,
              operationId: 'move-operation-a',
              status: failActivation || failRelease ? ('failed' as const) : ('succeeded' as const),
              revision: 1,
              code: failActivation || failRelease ? 'injected-failure' : 'ok',
              message: command.type,
              duplicate: false,
              completedAt: '2026-08-23T12:00:00.000Z',
            }
          },
        ),
      }
      const nodeCoordinator = {
        getByName: vi.fn(() => node),
      } as unknown as DurableObjectNamespace<NodeCoordinatorDO>
      const adapter = await Effect.runPromise(
        makeNativeGameMoveBackupAdapter({
          database: d1 as unknown as GameLifecycleD1Database &
            import('@gridora/backup-d1').BackupD1Database,
          nodeCoordinator,
          signingKey: { get: vi.fn(async () => privateKeyPem()) },
          backupControl: {
            create: () => Effect.succeed({ job: { backupId: 'move-backup-a' } }),
          } as never,
          startBackupWorkflow: () => Effect.void,
        }),
      )
      const move = makeGameMoveCoordinator(d1, adapter)
      await Effect.runPromise(move(moveWorkflowPayload, 'backup-source'))
      await Effect.runPromise(move(moveWorkflowPayload, 'stop-source'))
      await Effect.runPromise(move(moveWorkflowPayload, 'restore-target'))
      await Effect.runPromise(move(moveWorkflowPayload, 'verify-target'))
      if (workflowStep === 'release-source')
        await Effect.runPromise(move(moveWorkflowPayload, 'cutover-endpoint'))

      const result = await Effect.runPromise(
        Effect.result(
          executeGameLifecycleWorkflowStep(
            {
              database: d1,
              nodeCoordinator,
              signingKey: { get: vi.fn(async () => privateKeyPem()) },
              move,
            },
            moveWorkflowPayload,
            workflowStep,
          ),
        ),
      )

      expect(result._tag).toBe('Failure')
      expect(
        queued.some(
          (command) => command.type === 'deployment.remove' && command.nodeId === 'move-node-b',
        ),
      ).toBe(true)
      expect(
        queued.some(
          (command) =>
            command.type === 'backup.restore' &&
            (command.payload as { readonly phase?: string }).phase === 'rollback',
        ),
      ).toBe(true)
      expect(
        queued.some(
          (command) => command.type === 'deployment.apply' && command.nodeId === 'move-node-a',
        ),
      ).toBe(true)
      expect(
        queued.some(
          (command) => command.type === 'server.start' && command.nodeId === 'move-node-a',
        ),
      ).toBe(true)
      expect(
        database
          .prepare(`SELECT phase FROM game_lifecycle_moves
      WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`)
          .get(),
      ).toEqual({ phase: 'rolled_back' })
      expect(
        database
          .prepare(`SELECT state FROM game_lifecycle_move_target_stages
      WHERE organization_id = 'move-org'`)
          .get(),
      ).toEqual({ state: 'rolled_back' })
      database.close()
    },
  )

  it('recreates and starts the source when the stop command succeeds but its D1 phase transition fails', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    await seedAcceptedMove(database)
    seedMoveBackup(database)
    const d1 = new SqliteD1(database)
    const queued: AgentCommand[] = []
    const node = {
      enqueue: vi.fn(async (command: AgentCommand) => {
        queued.push(command)
      }),
      waitForCommandResult: vi.fn(
        async (_organizationId: string, _nodeId: string, commandId: string) => ({
          commandId,
          operationId: 'move-operation-a',
          status: 'succeeded' as const,
          revision: 1,
          code: 'ok',
          message: 'completed',
          duplicate: false,
          completedAt: '2026-08-23T12:00:00.000Z',
        }),
      ),
    }
    const nodeCoordinator = {
      getByName: vi.fn(() => node),
    } as unknown as DurableObjectNamespace<NodeCoordinatorDO>
    const adapter = await Effect.runPromise(
      makeNativeGameMoveBackupAdapter({
        database: d1 as unknown as GameLifecycleD1Database &
          import('@gridora/backup-d1').BackupD1Database,
        nodeCoordinator,
        signingKey: { get: vi.fn(async () => privateKeyPem()) },
        backupControl: {
          create: () => Effect.succeed({ job: { backupId: 'move-backup-a' } }),
        } as never,
        startBackupWorkflow: () => Effect.void,
      }),
    )
    const move = makeGameMoveCoordinator(d1, adapter)
    await Effect.runPromise(move(moveWorkflowPayload, 'backup-source'))
    d1.failNextMoveTransitionBeforeCommit()

    const result = await Effect.runPromise(
      Effect.result(
        executeGameLifecycleWorkflowStep(
          {
            database: d1,
            nodeCoordinator,
            signingKey: { get: vi.fn(async () => privateKeyPem()) },
            move,
          },
          moveWorkflowPayload,
          'stop-source',
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(
      queued.some((command) => command.type === 'server.stop' && command.nodeId === 'move-node-a'),
    ).toBe(true)
    expect(
      queued.some(
        (command) => command.type === 'deployment.apply' && command.nodeId === 'move-node-a',
      ),
    ).toBe(true)
    expect(
      queued.some((command) => command.type === 'server.start' && command.nodeId === 'move-node-a'),
    ).toBe(true)
    expect(
      database
        .prepare(`SELECT phase FROM game_lifecycle_moves
      WHERE organization_id = 'move-org' AND operation_id = 'move-operation-a'`)
        .get(),
    ).toEqual({ phase: 'rolled_back' })
    expect(
      database
        .prepare(`SELECT action, state FROM game_lifecycle_move_physical_commands
      WHERE organization_id = 'move-org' ORDER BY action`)
        .all(),
    ).toEqual([
      { action: 'rollback-source-deploy', state: 'succeeded' },
      { action: 'rollback-source-start', state: 'succeeded' },
    ])
    database.close()
  })

  it('reuses the exact signed envelope after response loss and signing-key rotation', async () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    seedOperation(database)

    const keyOne = privateKeyPem()
    const keyTwo = privateKeyPem()
    let keyReads = 0
    let waitCalls = 0
    const enqueued: AgentCommand[] = []
    const coordinator = {
      enqueue: vi.fn(async (command: AgentCommand) => {
        enqueued.push(command)
      }),
      waitForCommandResult: vi.fn(async () => {
        waitCalls += 1
        if (waitCalls === 1) return null
        return {
          commandId: enqueued[0]?.commandId,
          operationId: 'operation-a',
          status: 'succeeded',
          revision: 1,
          code: 'ok',
          message: 'started',
          duplicate: true,
          completedAt: '2026-08-23T12:00:00.000Z',
        }
      }),
    }
    const nodeCoordinator = {
      getByName: vi.fn(() => coordinator),
    } as unknown as DurableObjectNamespace<NodeCoordinatorDO>
    const bindings = {
      database: new SqliteD1(database),
      nodeCoordinator,
      signingKey: {
        get: vi.fn(async () => {
          keyReads += 1
          return keyReads === 1 ? keyOne : keyTwo
        }),
      },
    }

    const first = await Effect.runPromise(
      Effect.result(executeGameLifecycleWorkflowStep(bindings, payload, 'start')),
    )
    expect(first._tag).toBe('Failure')
    expect(
      database
        .prepare('SELECT command_json IS NOT NULL AS persisted FROM game_command_deliveries')
        .get(),
    ).toEqual({ persisted: 1 })
    const persisted = database
      .prepare('SELECT command_json, command_fingerprint FROM game_command_deliveries')
      .get() as {
      command_json: string
      command_fingerprint: string
    }

    const second = await Effect.runPromise(
      Effect.result(executeGameLifecycleWorkflowStep(bindings, payload, 'start')),
    )
    expect(second._tag).toBe('Success')
    expect(keyReads).toBe(1)
    expect(enqueued).toHaveLength(2)
    expect(enqueued[0]).toEqual(enqueued[1])
    expect(JSON.parse(persisted.command_json)).toEqual(enqueued[0])
    expect(database.prepare('SELECT state FROM game_command_deliveries').get()).toEqual({
      state: 'completed',
    })
    expect(persisted.command_fingerprint).toHaveLength(64)
    expect(() =>
      database
        .prepare('UPDATE game_command_deliveries SET command_json = ? WHERE operation_id = ?')
        .run(
          JSON.stringify({
            commandId: 'other',
            operationId: 'operation-a',
            organizationId: 'org-a',
          }),
          'operation-a',
        ),
    ).toThrow(/immutable/)
    database.close()
  })

  it('fences command-envelope tenant and operation coordinates in D1', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    seedOperation(database)
    const fingerprint = 'a'.repeat(64)
    expect(() =>
      database
        .prepare(`
      INSERT INTO game_command_deliveries
        (organization_id, operation_id, command_id, step_name, command_fingerprint, command_json,
         state, result_json, attempts, created_at, updated_at)
      VALUES ('org-a', 'operation-a', 'command-a', 'start', ?, ?, 'pending', NULL, 0, 'now', 'now')
    `)
        .run(
          fingerprint,
          JSON.stringify({
            commandId: 'command-a',
            operationId: 'operation-a',
            organizationId: 'org-b',
          }),
        ),
    ).toThrow(/scope mismatch/)
    database.close()
  })
})

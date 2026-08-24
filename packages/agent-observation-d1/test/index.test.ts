import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandResult } from '@gridora/agent-protocol'
import {
  AgentObservationClockLayer,
  AgentObservationNotCommittedError,
  AgentObservationRepositoryLayer,
  makeAgentObservationControl,
  type AgentObservationControlShape,
  type AgentObservationEvent,
  type AuthenticatedAgentPrincipal,
} from '@gridora/agent-observation-control'
import {
  makeAgentMachineAuditRepositoryD1,
  makeAgentObservationRepositoryD1,
  type AgentObservationD1Database,
  type AgentObservationD1Result,
  type AgentObservationD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrationFiles = readdirSync(sqlDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

class SqliteStatement implements AgentObservationD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(
    readonly statement: StatementSync,
    readonly onFirst: () => void,
  ) {}
  bind(...values: ReadonlyArray<unknown>): AgentObservationD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    this.onFirst()
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<AgentObservationD1Result> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
}
class SqliteD1 implements AgentObservationD1Database {
  failAfterCommitOnce = false
  holdBatchesUntilFirstReads = 0
  firstReads = 0
  beforeBatchOnce: (() => void) | undefined
  private serial: Promise<void> = Promise.resolve()
  private releaseReadGate: (() => void) | undefined
  private readGate: Promise<void> | undefined
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): AgentObservationD1Statement {
    return new SqliteStatement(this.database.prepare(sql), () => {
      this.firstReads += 1
      if (this.firstReads >= this.holdBatchesUntilFirstReads) this.releaseReadGate?.()
    })
  }
  async batch(statements: ReadonlyArray<AgentObservationD1Statement>) {
    if (this.holdBatchesUntilFirstReads > 0 && this.firstReads < this.holdBatchesUntilFirstReads) {
      this.readGate ??= new Promise<void>((resolve) => {
        this.releaseReadGate = resolve
      })
      await this.readGate
    }
    const beforeBatch = this.beforeBatchOnce
    this.beforeBatchOnce = undefined
    beforeBatch?.()
    const prior = this.serial
    let release!: () => void
    this.serial = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const results: AgentObservationD1Result[] = []
      for (const statement of statements) results.push(await statement.all())
      this.database.exec('COMMIT')
      if (this.failAfterCommitOnce) {
        this.failAfterCommitOnce = false
        throw new Error('simulated D1 response loss after commit')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }
}

const now = '2026-08-23T15:00:00.000Z'
const imageChecksum = `sha256:${'a'.repeat(64)}`
const buildIdentityManifestSha256 = `sha256:${'b'.repeat(64)}`
const buildIdentitySignatureSha256 = `sha256:${'c'.repeat(64)}`
const buildIdentityPublicKeySha256 = `sha256:${'d'.repeat(64)}`
const imageSignature = JSON.stringify({
  schemaVersion: 1,
  algorithm: 'ed25519',
  buildIdentityManifestSha256,
  buildIdentitySignatureSha256,
  buildIdentityPublicKeySha256,
})
const principal: AuthenticatedAgentPrincipal = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  credentialId: 'credential-a',
  version: 1,
  sessionVersion: 1,
}
const observation = (overrides: Partial<AgentObservationEvent> = {}): AgentObservationEvent => ({
  apiVersion: 'agent.gridora.dev/v1alpha1',
  organizationId: 'org-a',
  nodeId: 'node-a',
  sessionVersion: 1,
  sequence: 1,
  observedRevision: 1,
  issuedAt: now,
  facts: {
    agent: { version: '0.1.0', ready: true },
    image: {
      imageId: 'image-a',
      imageVersion: '1.0.0',
      checksum: imageChecksum,
      signatureVerified: true,
      buildIdentityManifestSha256,
      buildIdentitySignatureSha256,
      buildIdentityPublicKeySha256,
      ready: true,
    },
    tunnel: { state: 'connected', ready: true },
    docker: {
      engineVersion: '28.0.0',
      storageDriver: 'overlay2',
      projectQuotaReady: true,
      privilegedContainers: 0,
      dockerSocketMounted: false,
      ready: true,
    },
    firewall: { defaultDeny: true, allowedTcpPorts: [22], allowedUdpPorts: [2001], ready: true },
    capacity: {
      architecture: 'amd64',
      cpuMillis: 4000,
      ramBytes: 8000,
      diskBytes: 16000,
      cpuUsedMillis: 100,
      ramUsedBytes: 1000,
      diskUsedBytes: 2000,
    },
    metrics: {
      loadPermille: 100,
      networkReceiveBytes: 10,
      networkTransmitBytes: 20,
      containerRestarts: 0,
    },
  },
  ...overrides,
})

let database: DatabaseSync
let d1: SqliteD1
let service: AgentObservationControlShape
let currentTime = Date.parse(now)

const seed = () => {
  database.exec(`
    INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('actor-a', 'access-a', 'a@example.test', 'A', 'active', '${now}', '${now}');
    INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES ('org-a', 'Org A', 'org-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, '${now}');
    INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, revision)
      VALUES ('org-a', 'actor-a', 'owner', 'active', '${now}', 1);
    INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'envelope-a', 'active', 1, '${now}', '${now}');
    INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1);
    INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-a', '1.0.0', '${imageChecksum}', '${imageSignature}',
       '{"ovhcloud":{"eu-west":"provider-image-a"}}', 'promoted', '${now}', '${now}');
    INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
       image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
       created_at, updated_at)
      VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small',
       'image-a', 'shared', 'ready', 'unknown', 1, 0, '${now}', '${now}');
    INSERT INTO tunnels
      (organization_id, node_id, tunnel_id, hostname, state, credential_reference, revision)
      VALUES ('org-a', 'node-a', 'tunnel-a', 'node-a.example.test', 'connected', 'tunnel-envelope-a', 1);
    INSERT INTO node_credentials
      (organization_id, node_id, id, credential_hash, version, status, issued_at)
      VALUES ('org-a', 'node-a', 'credential-a', 'hash-a', 1, 'active', '${now}');
    INSERT INTO agent_sessions
      (organization_id, node_id, credential_id, session_version, agent_version,
       session_state, last_seen_at, revision)
      VALUES ('org-a', 'node-a', 'credential-a', 1, '0.1.0', 'connected', '${now}', 1);
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-ports-a', 'org-a', 'allocate-ports', 'server', 'server-a', 'actor-a',
       'succeeded', 100, 'allocate-ports-a', 'ports-a', 1, '${now}', '${now}');
    INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
    INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, desired_revision, observed_revision, active_config_revision,
       created_at, updated_at)
      VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running',
       'running', '{}', 1, 1, 1, '${now}', '${now}');
    INSERT INTO port_leases
      (organization_id, id, node_id, server_id, protocol, public_port, container_port,
       state, operation_id, revision, created_at)
      VALUES
       ('org-a', 'port-tcp-22', 'node-a', 'server-a', 'tcp', 22, 22, 'active',
        'operation-ports-a', 1, '${now}'),
       ('org-a', 'port-udp-2001', 'node-a', 'server-a', 'udp', 2001, 2001, 'active',
        'operation-ports-a', 1, '${now}');
  `)
}

const seedAcceptedProviderAndRegistration = () => {
  const fingerprint = 'f'.repeat(64)
  const bootstrapHash = 'a'.repeat(64)
  const deliveredHash = 'b'.repeat(64)
  const validUntil = Date.parse(now) + 86_400_000
  database.exec(`
    INSERT INTO organization_policies
      (organization_id, policy_json, revision, updated_by, updated_at)
      VALUES ('org-a', '{"organizationId":"org-a","revision":1}', 1, 'actor-a', '${now}');
    UPDATE provider_allocations SET monthly_budget_minor = 10000 WHERE organization_id = 'org-a';
    INSERT INTO provider_catalog
      (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
       metadata_json, refreshed_at)
      VALUES ('ovhcloud', 'eu-west', 'small', 'EUR', NULL, 100,
       '{"schemaVersion":1,"billingCadence":"monthly","contractMonths":1,"validUntilEpochMilliseconds":${validUntil}}',
       '${now}');
    UPDATE node_images
      SET provider_mappings_json = '{"ovhcloud":{"eu-west":"provider-image-a"}}'
      WHERE id = 'image-a';
    UPDATE nodes SET provider_instance_id = NULL, desired_state = 'provisioning',
      observed_state = 'unknown', desired_revision = 2, observed_revision = 0,
      pending_lifecycle_operation_id = 'operation-a'
      WHERE organization_id = 'org-a' AND id = 'node-a';
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-a', 'org-a', 'provision-node', 'node', 'node-a', 'actor-a',
       'queued', 0, 'create-node-a', 'correlation-a', 1, '${now}', '${now}');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-accept-a', 'org-a', 'node.provision.acceptance', 'node', 'node-a', 'actor-a',
       'succeeded', 100, 'accept-node-a', 'correlation-a', 1, '${now}', '${now}');
    INSERT INTO lifecycle_workflow_starts
      (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
      VALUES ('org-a', 'operation-a', 'workflow-a', 'pending', 0, NULL, '${now}', '${now}');
    INSERT INTO lifecycle_reservations
      (organization_id, idempotency_key, fingerprint, operation_id, resource_kind, resource_id,
       command_json, reservation_json, created_at)
      VALUES ('org-a', 'create-node-a', '${fingerprint}', 'operation-a', 'node', 'node-a',
       '{"kind":"provision-node","organizationId":"org-a","resourceId":"node-a","expectedDesiredRevision":1}',
       '{"previousRevision":1,"desiredRevision":2}', '${now}');
    INSERT INTO node_provision_contracts
      (organization_id, node_id, operation_id, provider_type, currency, estimated_monthly_minor,
       billing_cadence, contract_months, non_hourly_commitment_confirmed, catalog_refreshed_at, accepted_at)
      VALUES ('org-a', 'node-a', 'operation-a', 'ovhcloud', 'EUR', 100, 'monthly', 1, 1, '${now}', '${now}');
    INSERT INTO node_provision_spend_reservations
      (organization_id, node_id, operation_id, currency, estimated_monthly_minor,
       state, revision, reserved_at, released_at)
      VALUES ('org-a', 'node-a', 'operation-a', 'EUR', 100, 'active', 1, '${now}', NULL);
    INSERT INTO node_bootstrap_token_reservations
      (organization_id, token_record_id, node_id, operation_id, key_version, token_hash,
       state, expires_at, created_at, updated_at)
      VALUES ('org-a', 'bootstrap-a', 'node-a', 'operation-a', 1, '${bootstrapHash}',
       'reserved', '2026-08-24T15:00:00.000Z', '${now}', '${now}');
    INSERT INTO audit_envelope_staging
      (event_table, event_id, organization_id, envelope_json, staged_at)
      VALUES ('tenant', 'audit-accept-a', 'org-a',
        '{"version":1,"captureStatus":"complete","occurredAt":"${now}","scope":"tenant","organizationId":"org-a","actor":{"type":"human","id":"actor-a"},"request":{"id":"request-a","correlationId":"correlation-a"},"action":"node.provision.accepted","target":{"type":"node","id":"node-a"},"before":{"state":"captured","summary":{"operationId":"operation-accept-a","state":"requested"}},"after":{"state":"captured","summary":{"operationId":"operation-accept-a","state":"accepted"}},"operationId":"operation-accept-a","source":{"origin":"http","ip":{"state":"not-available","reason":"test-ip-unavailable"},"access":{"state":"captured","value":{"subject":"access-a","identityId":"actor-a","issuer":"test-issuer","email":"a@example.test"}}},"result":"succeeded","error":{"classification":"none","code":null},"forced":false,"breakGlass":false}',
        '${now}');
    INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      VALUES ('audit-accept-a', 'org-a', 'actor-a', 'node.provision.accepted', 'node',
       'node-a', 'succeeded', 'correlation-a', '{"operationId":"operation-accept-a","state":"accepted"}', '${now}');
    INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      VALUES ('outbox-start-a', 'org-a', 'lifecycle.workflow-start.requested', 'operation',
       'operation-a', '{"operationId":"operation-a","workflowStartRecordId":"workflow-a","action":"provision-node"}',
       'pending', 0, '${now}', '${now}');
    INSERT INTO node_provision_acceptances
      (organization_id, idempotency_key, request_fingerprint, node_id, operation_id,
       workflow_start_record_id, audit_event_id, outbox_event_id, bootstrap_token_record_id,
       bootstrap_key_version, provider_account_id, provider_account_revision, provider_type,
       allocation_revision, allocation_max_active_nodes, allocation_monthly_budget_minor,
       allocation_active_nodes_before, region, plan, catalog_refreshed_at,
       catalog_valid_until_epoch_ms, image_id, image_version, image_checksum, provider_image_id,
       placement_mode,
       policy_revision, active_nodes_before, dedicated_nodes_before, currency,
       estimated_monthly_minor, billing_cadence, contract_months,
       committed_monthly_before_minor, projected_committed_monthly_minor, receipt_json,
       audit_request_context_json, created_at)
      VALUES ('org-a', 'create-node-a', '${fingerprint}', 'node-a', 'operation-a',
       'workflow-a', 'audit-accept-a', 'outbox-start-a', 'bootstrap-a', 1,
       'provider-a', 1, 'ovhcloud', 1, 2, 10000, 0, 'eu-west', 'small', '${now}',
       ${validUntil}, 'image-a', '1.0.0', '${imageChecksum}', 'provider-image-a', 'shared', 1, 0, 0,
       'EUR', 100, 'monthly', 1, 0, 100,
       '{"organizationId":"org-a","nodeId":"node-a","operationId":"operation-a","idempotencyKey":"create-node-a","fingerprint":"${fingerprint}","providerType":"ovhcloud","workflowStart":{"id":"workflow-a"}}',
       '{"origin":"http","requestId":"request-a","correlationId":"correlation-a","source":{"ip":{"state":"not-available","reason":"test-ip-unavailable"},"access":{"state":"captured","value":{"subject":"access-a","identityId":"actor-a","issuer":"test-issuer","email":"a@example.test"}}}}',
       '${now}');

    UPDATE nodes SET provider_instance_id = 'instance-a', observed_state = 'provisioning'
      WHERE organization_id = 'org-a' AND id = 'node-a';
    UPDATE node_bootstrap_token_reservations
      SET token_hash = '${deliveredHash}', state = 'materialized', updated_at = '${now}'
      WHERE organization_id = 'org-a' AND token_record_id = 'bootstrap-a';
    INSERT INTO node_registration_tokens
      (token_hash, organization_id, node_id, provider_instance_id, operation_id, credential_id,
       expires_at, consumed_at, revoked_at, issued_at)
      VALUES ('${deliveredHash}', 'org-a', 'node-a', 'instance-a', 'operation-a', 'credential-a',
       '2026-08-24T15:00:00.000Z', '${now}', NULL, '${now}');
    UPDATE operations SET status = 'waiting_external', progress = 50, revision = 3,
      updated_at = '${now}' WHERE organization_id = 'org-a' AND id = 'operation-a';
    INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      VALUES ('outbox_node_provider:operation-a', 'org-a', 'node.provision.provider-created',
       'node', 'node-a',
       '{"organizationId":"org-a","nodeId":"node-a","operationId":"operation-a","providerInstanceId":"instance-a","state":"waiting-for-agent"}',
       'pending', 0, '${now}', '${now}');
  `)
}

const setReadyNodeFixture = () => {
  database
    .prepare(
      `UPDATE nodes SET desired_state = 'ready', observed_state = 'unknown',
       pending_lifecycle_operation_id = NULL
       WHERE organization_id = 'org-a' AND id = 'node-a'`,
    )
    .run()
}

const setAcceptedProvisioningFixture = () => {
  database
    .prepare(
      `UPDATE nodes SET desired_state = 'provisioning', observed_state = 'provisioning',
       desired_revision = 2, observed_revision = 0, pending_lifecycle_operation_id = 'operation-a'
       WHERE organization_id = 'org-a' AND id = 'node-a'`,
    )
    .run()
  database
    .prepare(
      `UPDATE operations SET status = 'waiting_external', progress = 50, revision = 3
       WHERE organization_id = 'org-a' AND id = 'operation-a'`,
    )
    .run()
}

const exchangeTokenHash = 'c'.repeat(64)
const exchangeCredentialHash = 'd'.repeat(64)
const installerFingerprint = `sha256:${'e'.repeat(64)}`
const registeredTokenHash = 'b'.repeat(64)

const seedRegistrationExchange = () => {
  database.exec(`
    INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
       image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
       created_at, updated_at)
      VALUES ('org-a', 'node-registration', 'provider-a', 'instance-registration', 'ovhcloud',
       'eu-west', 'small', 'image-a', 'shared', 'provisioning', 'unknown', 1, 0, '${now}', '${now}');
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-registration', 'org-a', 'provision-node', 'node', 'node-registration',
       'actor-a', 'waiting_external', 50, 'registration-node-a', 'registration-correlation-a', 1,
       '${now}', '${now}');
    INSERT INTO node_registration_tokens
      (token_hash, organization_id, node_id, provider_instance_id, operation_id, credential_id,
       expires_at, consumed_at, revoked_at, issued_at)
      VALUES ('${exchangeTokenHash}', 'org-a', 'node-registration', 'instance-registration',
       'operation-registration', NULL, '2026-08-24T15:00:00.000Z', NULL, NULL, '${now}');
  `)
}

const gameCommandResult = (overrides: Partial<CommandResult> = {}): CommandResult => ({
  commandId: 'command-machine-a',
  operationId: 'operation-command-a',
  status: 'succeeded' as const,
  revision: 1,
  code: 'completed',
  message: 'provider output that must not become audit evidence',
  duplicate: false,
  completedAt: now,
  ...overrides,
})

const seedGameCommand = (commandId = 'command-machine-a') => {
  const commandJson = JSON.stringify({
    apiVersion: 'agent.gridora.dev/v1alpha1',
    commandId,
    operationId: 'operation-command-a',
    organizationId: 'org-a',
    nodeId: 'node-a',
    resourceId: 'server-a',
    type: 'server.start',
    payloadSchemaVersion: 1,
    issuedAt: now,
    expiresAt: '2026-08-24T15:00:00.000Z',
    idempotencyKey: `command-${commandId}`,
    expectedPriorRevision: null,
    payload: {},
    signature: 'signature-not-verified-by-d1-test',
  })
  database.exec(`
    INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-command-a', 'org-a', 'server.start', 'server', 'server-a', 'actor-a',
       'running', 60, 'command-operation-a', 'command-correlation-a', 1, '${now}', '${now}');
    INSERT INTO game_command_deliveries
      (organization_id, operation_id, command_id, step_name, command_fingerprint, state,
       result_json, attempts, created_at, updated_at, command_json)
      VALUES ('org-a', 'operation-command-a', '${commandId}', 'start', '${'f'.repeat(64)}',
       'delivered', NULL, 1, '${now}', '${now}', '${commandJson.replaceAll("'", "''")}');
  `)
}

const expectObservationRejectedAtomically = async (event: AgentObservationEvent) => {
  await expect(Effect.runPromise(service.ingest(principal, event))).rejects.toMatchObject({
    code: 'agent_observation_rejected',
  })
  expect(database.prepare('SELECT observed_revision FROM nodes').get()).toEqual({
    observed_revision: 0,
  })
  expect(
    database.prepare('SELECT count(*) AS count FROM agent_observation_aggregates').get(),
  ).toEqual({ count: 0 })
  expect(database.prepare('SELECT count(*) AS count FROM node_runtime_capacity').get()).toEqual({
    count: 0,
  })
}

describe('agent observation D1 transaction', () => {
  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    seed()
    seedAcceptedProviderAndRegistration()
    setReadyNodeFixture()
    d1 = new SqliteD1(database)
    currentTime = Date.parse(now)
    const repository = makeAgentObservationRepositoryD1(d1)
    service = await Effect.runPromise(
      makeAgentObservationControl.pipe(
        Effect.provide(
          Layer.mergeAll(
            AgentObservationClockLayer({ nowEpochMilliseconds: () => currentTime }),
            AgentObservationRepositoryLayer(repository),
          ),
        ),
      ),
    )
  })
  afterEach(() => database.close())

  it('publishes ready capacity and seven bounded current aggregates atomically', async () => {
    await expect(
      Effect.runPromise(service.ingest(principal, observation())),
    ).resolves.toMatchObject({
      sequence: 1,
      observedRevision: 1,
      observedState: 'ready',
      capacityPublished: true,
    })
    expect(database.prepare('SELECT observed_state, observed_revision FROM nodes').get()).toEqual({
      observed_state: 'ready',
      observed_revision: 1,
    })
    expect(
      database.prepare('SELECT count(*) AS count FROM agent_observation_aggregates').get(),
    ).toEqual({ count: 7 })
    expect(
      database.prepare('SELECT cpu_millis, agent_ready FROM node_runtime_capacity').get(),
    ).toEqual({ cpu_millis: 4000, agent_ready: 1 })
  })

  it('accepts fully ready facts while provisioning without publishing placement capacity', async () => {
    database.prepare("UPDATE nodes SET desired_state = 'provisioning' WHERE id = 'node-a'").run()
    await expect(
      Effect.runPromise(service.ingest(principal, observation())),
    ).resolves.toMatchObject({
      sequence: 1,
      observedRevision: 1,
      observedState: 'bootstrapping',
      capacityPublished: false,
    })
    expect(database.prepare('SELECT count(*) AS count FROM node_runtime_capacity').get()).toEqual({
      count: 0,
    })
    expect(
      database.prepare('SELECT count(*) AS count FROM agent_observation_aggregates').get(),
    ).toEqual({ count: 7 })
  })

  it('atomically completes an accepted provider-created registered node on its ready observation', async () => {
    setAcceptedProvisioningFixture()
    d1.failAfterCommitOnce = true
    const receipt = await Effect.runPromise(service.ingest(principal, observation()))
    expect(receipt).toMatchObject({
      observedState: 'ready',
      capacityPublished: true,
      observedRevision: 1,
    })
    expect(
      database
        .prepare(`SELECT desired_state, observed_state, desired_revision, observed_revision,
          pending_lifecycle_operation_id FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'ready',
      observed_state: 'ready',
      desired_revision: 3,
      observed_revision: 1,
      pending_lifecycle_operation_id: null,
    })
    expect(
      database
        .prepare("SELECT status, progress, revision FROM operations WHERE id = 'operation-a'")
        .get(),
    ).toEqual({ status: 'succeeded', progress: 100, revision: 4 })
    expect(database.prepare('SELECT count(*) AS count FROM node_runtime_capacity').get()).toEqual({
      count: 1,
    })
    expect(
      database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'node.provision.ready'")
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare("SELECT count(*) AS count FROM outbox WHERE event_type = 'node.provision.ready'")
        .get(),
    ).toEqual({ count: 1 })

    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(Effect.runPromise(service.ingest(principal, observation()))).resolves.toEqual(
      receipt,
    )
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    expect(
      database
        .prepare(
          "SELECT (SELECT count(*) FROM audit_events WHERE action = 'node.provision.ready') AS audits, (SELECT count(*) FROM outbox WHERE event_type = 'node.provision.ready') AS events",
        )
        .get(),
    ).toEqual({ audits: 1, events: 1 })
  })

  it('records a legitimate reported agent upgrade without an immutable registration-version fence', async () => {
    const upgraded = observation({
      facts: { ...observation().facts, agent: { version: '0.2.0', ready: true } },
    })
    await expect(Effect.runPromise(service.ingest(principal, upgraded))).resolves.toMatchObject({
      observedState: 'ready',
      capacityPublished: true,
    })
    expect(
      database
        .prepare(
          "SELECT json_extract(summary_json, '$.version') AS version FROM agent_observation_aggregates WHERE fact_kind = 'agent'",
        )
        .get(),
    ).toEqual({ version: '0.2.0' })
  })

  it('returns the exact receipt for an exact replay without any writes', async () => {
    const receipt = await Effect.runPromise(service.ingest(principal, observation()))
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(Effect.runPromise(service.ingest(principal, observation()))).resolves.toEqual(
      receipt,
    )
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    expect(
      database.prepare('SELECT revision, last_fingerprint FROM agent_observation_streams').get(),
    ).toMatchObject({ revision: 1, last_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('rejects changed facts at the committed cursor without any writes', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    const changed = observation({
      facts: {
        ...observation().facts,
        metrics: { ...observation().facts.metrics, networkReceiveBytes: 11 },
      },
    })
    await expect(Effect.runPromise(service.ingest(principal, changed))).rejects.toMatchObject({
      code: 'agent_observation_replay_mismatch',
    })
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
  })

  it('rejects changed credential or session coordinates at the committed cursor', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(
      Effect.runPromise(service.ingest({ ...principal, version: 2 }, observation())),
    ).rejects.toMatchObject({ code: 'agent_observation_replay_mismatch' })
    await expect(
      Effect.runPromise(
        service.ingest({ ...principal, sessionVersion: 2 }, observation({ sessionVersion: 2 })),
      ),
    ).rejects.toMatchObject({ code: 'agent_observation_replay_mismatch' })
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
  })

  it('rejects an out-of-order cursor without changing current aggregates', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    await expect(
      Effect.runPromise(
        service.ingest(principal, observation({ sequence: 3, observedRevision: 2 })),
      ),
    ).rejects.toMatchObject({ code: 'agent_observation_rejected' })
    expect(
      database
        .prepare("SELECT sequence FROM agent_observation_aggregates WHERE fact_kind = 'agent'")
        .get(),
    ).toEqual({ sequence: 1 })
  })

  it('recovers an exact receipt after a committed response is lost', async () => {
    d1.failAfterCommitOnce = true
    const receipt = await Effect.runPromise(service.ingest(principal, observation()))
    expect(receipt).toMatchObject({ sequence: 1, observedRevision: 1 })
    expect(database.prepare('SELECT revision FROM agent_observation_streams').get()).toEqual({
      revision: 1,
    })
  })

  it('adopts one concurrent duplicate after both pre-reads miss', async () => {
    d1.holdBatchesUntilFirstReads = 2
    const [first, second] = await Promise.all([
      Effect.runPromise(service.ingest(principal, observation())),
      Effect.runPromise(service.ingest(principal, observation())),
    ])
    expect(second).toEqual(first)
    expect(database.prepare('SELECT revision FROM agent_observation_streams').get()).toEqual({
      revision: 1,
    })
    expect(
      database.prepare('SELECT count(*) AS count FROM agent_observation_aggregates').get(),
    ).toEqual({ count: 7 })
  })

  it('returns an exact stale replay before freshness validation', async () => {
    const receipt = await Effect.runPromise(service.ingest(principal, observation()))
    currentTime += 3_600_000
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(Effect.runPromise(service.ingest(principal, observation()))).resolves.toEqual(
      receipt,
    )
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
  })

  it('proves a stale first event was not committed so the emitter can refresh it', async () => {
    currentTime += 3_600_000
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(
      Effect.runPromise(service.ingest(principal, observation())),
    ).rejects.toBeInstanceOf(AgentObservationNotCommittedError)
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
  })

  it('proves a stale next event was not committed and rejects an advanced cursor', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    currentTime += 3_600_000
    await expect(
      Effect.runPromise(
        service.ingest(principal, observation({ sequence: 2, observedRevision: 2 })),
      ),
    ).rejects.toBeInstanceOf(AgentObservationNotCommittedError)
    await expect(
      Effect.runPromise(
        service.ingest(principal, observation({ sequence: 3, observedRevision: 3 })),
      ),
    ).rejects.toMatchObject({ code: 'agent_observation_cursor_advanced_or_different' })
  })

  it('withdraws capacity and degrades the node when any readiness fact fails', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    const failed = observation({
      sequence: 2,
      observedRevision: 2,
      facts: {
        ...observation().facts,
        docker: { ...observation().facts.docker, projectQuotaReady: false, ready: false },
      },
    })
    await expect(Effect.runPromise(service.ingest(principal, failed))).resolves.toMatchObject({
      observedState: 'degraded',
      capacityPublished: false,
    })
    expect(database.prepare('SELECT count(*) AS count FROM node_runtime_capacity').get()).toEqual({
      count: 0,
    })
    expect(
      database
        .prepare(
          'SELECT count(*) AS count, min(sequence) AS sequence FROM agent_observation_aggregates',
        )
        .get(),
    ).toEqual({ count: 7, sequence: 2 })
  })

  it.each([
    { name: 'missing TCP lease', firewall: { allowedTcpPorts: [] } },
    { name: 'extra TCP lease', firewall: { allowedTcpPorts: [22, 23] } },
    { name: 'duplicate TCP lease', firewall: { allowedTcpPorts: [22, 22] } },
    { name: 'missing UDP lease', firewall: { allowedUdpPorts: [] } },
    { name: 'extra UDP lease', firewall: { allowedUdpPorts: [2001, 2002] } },
    { name: 'duplicate UDP lease', firewall: { allowedUdpPorts: [2001, 2001] } },
  ])('rolls back a ready snapshot with $name', async ({ firewall }) => {
    await expectObservationRejectedAtomically(
      observation({
        facts: {
          ...observation().facts,
          firewall: { ...observation().facts.firewall, ...firewall },
        },
      }),
    )
  })

  it.each([
    {
      name: 'opaque legacy signature',
      signature: 'legacy-signature',
    },
    {
      name: 'missing build identity coordinate',
      signature: JSON.stringify({
        schemaVersion: 1,
        algorithm: 'ed25519',
        buildIdentityManifestSha256,
        buildIdentitySignatureSha256,
      }),
    },
    {
      name: 'extra signature property',
      signature: JSON.stringify({
        schemaVersion: 1,
        algorithm: 'ed25519',
        buildIdentityManifestSha256,
        buildIdentitySignatureSha256,
        buildIdentityPublicKeySha256,
        artifactSignature: 'not-part-of-build-identity',
      }),
    },
    {
      name: 'malformed digest',
      signature: JSON.stringify({
        schemaVersion: 1,
        algorithm: 'ed25519',
        buildIdentityManifestSha256: `sha256:${'B'.repeat(64)}`,
        buildIdentitySignatureSha256,
        buildIdentityPublicKeySha256,
      }),
    },
  ])('rolls back a ready snapshot for a $name', async ({ signature }) => {
    database.prepare('UPDATE node_images SET signature = ? WHERE id = ?').run(signature, 'image-a')
    await expectObservationRejectedAtomically(observation())
  })

  it('rolls back a build-identity digest mismatch against the promoted image', async () => {
    const facts = observation().facts
    await expectObservationRejectedAtomically(
      observation({
        facts: {
          ...facts,
          image: {
            ...facts.image,
            buildIdentitySignatureSha256: `sha256:${'e'.repeat(64)}`,
          },
        },
      }),
    )
  })

  it('rolls back an update snapshot when promoted build identity changes after sequence one', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    const mismatchedSignature = JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ed25519',
      buildIdentityManifestSha256,
      buildIdentitySignatureSha256: `sha256:${'e'.repeat(64)}`,
      buildIdentityPublicKeySha256,
    })
    database
      .prepare('UPDATE node_images SET signature = ? WHERE id = ?')
      .run(mismatchedSignature, 'image-a')
    await expect(
      Effect.runPromise(
        service.ingest(principal, observation({ sequence: 2, observedRevision: 2 })),
      ),
    ).rejects.toMatchObject({ code: 'agent_observation_rejected' })
    expect(database.prepare('SELECT observed_revision FROM nodes').get()).toEqual({
      observed_revision: 1,
    })
    expect(
      database
        .prepare(
          'SELECT min(sequence) AS minimum, max(sequence) AS maximum FROM agent_observation_aggregates',
        )
        .get(),
    ).toEqual({ minimum: 1, maximum: 1 })
  })

  it('rolls back a retired image', async () => {
    database.prepare("UPDATE node_images SET status = 'retired' WHERE id = 'image-a'").run()
    await expectObservationRejectedAtomically(observation())
  })

  it('rolls back when the promoted image no longer maps to the accepted provider image', async () => {
    database
      .prepare(
        `UPDATE node_images SET provider_mappings_json =
         '{"ovhcloud":{"eu-west":"different-provider-image"}}' WHERE id = 'image-a'`,
      )
      .run()
    await expectObservationRejectedAtomically(observation())
  })

  it('rolls back when node provider coordinates no longer match the immutable acceptance', async () => {
    database.prepare("UPDATE nodes SET plan = 'different-plan' WHERE id = 'node-a'").run()
    await expectObservationRejectedAtomically(observation())
  })

  it('rolls back the full snapshot when authoritative Tunnel state is not ready', async () => {
    database
      .prepare("UPDATE tunnels SET state = 'degraded', revision = 2 WHERE node_id = 'node-a'")
      .run()
    await expect(Effect.runPromise(service.ingest(principal, observation()))).rejects.toMatchObject(
      { code: 'agent_observation_rejected' },
    )
    expect(database.prepare('SELECT observed_revision FROM nodes').get()).toEqual({
      observed_revision: 0,
    })
    expect(
      database.prepare('SELECT count(*) AS count FROM agent_observation_aggregates').get(),
    ).toEqual({ count: 0 })
  })

  it('accepts an authenticated next session only with a reset sequence and next session version', async () => {
    await Effect.runPromise(service.ingest(principal, observation()))
    database
      .prepare(
        "UPDATE agent_sessions SET session_version = 2, revision = 2 WHERE node_id = 'node-a'",
      )
      .run()
    const nextPrincipal = { ...principal, sessionVersion: 2 }
    await expect(
      Effect.runPromise(
        service.ingest(
          nextPrincipal,
          observation({ sessionVersion: 2, sequence: 1, observedRevision: 2 }),
        ),
      ),
    ).resolves.toMatchObject({ sequence: 1 })
  })

  it('rejects a foreign authenticated organization before the D1 transaction', async () => {
    await expect(
      Effect.runPromise(service.ingest({ ...principal, organizationId: 'org-b' }, observation())),
    ).rejects.toMatchObject({ code: 'agent_scope_mismatch' })
    expect(database.prepare('SELECT observed_revision FROM nodes').get()).toEqual({
      observed_revision: 0,
    })
  })

  it('records registration exchange atomically with a machine v1 envelope and adopts response loss exactly', async () => {
    seedRegistrationExchange()
    const repository = makeAgentMachineAuditRepositoryD1(d1)
    const input = {
      tokenHash: exchangeTokenHash,
      organizationId: 'org-a',
      nodeId: 'node-registration',
      providerInstanceId: 'instance-registration',
      credentialId: 'credential-registration',
      credentialHash: exchangeCredentialHash,
      agentVersion: '0.1.0',
      installerPublicKey: 'machine-installer-public-key',
      installerPublicKeyFingerprint: installerFingerprint,
      now,
    }
    d1.failAfterCommitOnce = true
    await expect(Effect.runPromise(repository.exchange(input))).resolves.toMatchObject({
      organizationId: 'org-a',
      nodeId: 'node-registration',
      credentialId: 'credential-registration',
      version: 1,
      sessionVersion: 1,
    })
    const persisted = database
      .prepare(`SELECT receipt.result_json AS resultJson, operation.status AS operationStatus,
        operation.resource_type AS targetType, operation.resource_id AS targetId,
        json_extract(envelope.envelope_json, '$.source.origin') AS origin,
        json_extract(envelope.envelope_json, '$.source.access.state') AS accessState,
        envelope.envelope_json AS envelopeJson
        FROM agent_machine_audit_receipts receipt
        JOIN operations operation ON operation.organization_id = receipt.organization_id
          AND operation.id = receipt.operation_id
        JOIN audit_event_envelopes envelope ON envelope.event_id = receipt.audit_event_id
          AND envelope.organization_id = receipt.organization_id
        WHERE receipt.organization_id = 'org-a' AND receipt.kind = 'registration-exchange'`)
      .get() as Record<string, unknown>
    expect(persisted).toMatchObject({
      operationStatus: 'succeeded',
      targetType: 'node',
      targetId: 'node-registration',
      origin: 'machine',
      accessState: 'not-available',
    })
    expect(String(persisted.envelopeJson)).not.toContain(exchangeCredentialHash)
    expect(() =>
      database
        .prepare(`UPDATE operations SET status = 'failed_terminal', updated_at = ?
          WHERE id = (
            SELECT operation_id FROM agent_machine_audit_receipts
            WHERE organization_id = 'org-a' AND kind = 'registration-exchange'
          )`)
        .run('2026-08-23T15:00:02.000Z'),
    ).toThrow(/agent machine audit operation is immutable/)
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(
      Effect.runPromise(repository.exchange({ ...input, now: '2026-08-23T15:00:01.000Z' })),
    ).resolves.toMatchObject({
      credentialId: 'credential-registration',
    })
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    await expect(
      Effect.runPromise(repository.exchange({ ...input, credentialHash: 'f'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'agent_machine_audit_replay_mismatch' })
    await expect(
      Effect.runPromise(repository.exchange({ ...input, organizationId: 'org-b' })),
    ).rejects.toMatchObject({ code: 'agent_machine_registration_scope_rejected' })
  })

  it('records registration token revocation with exact replay and rejects changed or foreign scope', async () => {
    const repository = makeAgentMachineAuditRepositoryD1(d1)
    d1.failAfterCommitOnce = true
    await expect(
      Effect.runPromise(repository.revokeRegistrationToken(principal, registeredTokenHash, now)),
    ).resolves.toBeUndefined()
    const revocationEvidence = database
      .prepare(`SELECT token.revoked_at AS revokedAt,
        token.machine_revocation_operation_id AS revocationOperationId,
        receipt.operation_id AS receiptOperationId
        FROM node_registration_tokens token
        JOIN agent_machine_audit_receipts receipt
          ON receipt.organization_id = token.organization_id
         AND receipt.kind = 'registration-revoke'
         AND receipt.effect_key = token.token_hash
        WHERE token.token_hash = ?`)
      .get(registeredTokenHash) as {
      readonly revokedAt: string
      readonly revocationOperationId: string
      readonly receiptOperationId: string
    }
    expect(revocationEvidence.revokedAt).toBe(now)
    expect(revocationEvidence.revocationOperationId).toBe(revocationEvidence.receiptOperationId)
    expect(
      database
        .prepare(`SELECT revoked_at AS revokedAt, machine_revocation_operation_id AS operationId
          FROM node_registration_tokens WHERE token_hash = ?`)
        .get(registeredTokenHash),
    ).toEqual({ revokedAt: now, operationId: revocationEvidence.receiptOperationId })
    expect(
      database
        .prepare(`SELECT json_extract(envelope.envelope_json, '$.source.origin') AS origin,
          json_extract(envelope.envelope_json, '$.source.access.state') AS accessState
          FROM agent_machine_audit_receipts receipt
          JOIN audit_event_envelopes envelope ON envelope.event_id = receipt.audit_event_id
            AND envelope.organization_id = receipt.organization_id
          WHERE receipt.organization_id = 'org-a' AND receipt.kind = 'registration-revoke'`)
        .get(),
    ).toEqual({ origin: 'machine', accessState: 'not-available' })
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(
      Effect.runPromise(repository.revokeRegistrationToken(principal, registeredTokenHash, now)),
    ).resolves.toBeUndefined()
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    await expect(
      Effect.runPromise(
        repository.revokeRegistrationToken(
          principal,
          registeredTokenHash,
          '2026-08-23T15:00:01.000Z',
        ),
      ),
    ).resolves.toBeUndefined()
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    await expect(
      Effect.runPromise(
        repository.revokeRegistrationToken(
          { ...principal, credentialId: 'credential-other' },
          registeredTokenHash,
          '2026-08-23T15:00:02.000Z',
        ),
      ),
    ).rejects.toMatchObject({ code: 'agent_machine_audit_replay_mismatch' })
    await expect(
      Effect.runPromise(
        repository.revokeRegistrationToken(
          { ...principal, organizationId: 'org-b' },
          registeredTokenHash,
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: 'agent_machine_registration_scope_rejected' })
  })

  it('rejects a legacy pre-revoked registration token without creating machine success evidence', async () => {
    const repository = makeAgentMachineAuditRepositoryD1(d1)
    const legacyRevokedAt = '2026-08-23T14:59:59.000Z'
    database
      .prepare(`UPDATE node_registration_tokens SET revoked_at = ? WHERE token_hash = ?`)
      .run(legacyRevokedAt, registeredTokenHash)
    const changes = database.prepare('SELECT total_changes() AS changes').get()

    await expect(
      Effect.runPromise(repository.revokeRegistrationToken(principal, registeredTokenHash, now)),
    ).rejects.toMatchObject({ code: 'agent_machine_registration_scope_rejected' })

    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    expect(
      database
        .prepare(`SELECT revoked_at AS revokedAt, machine_revocation_operation_id AS operationId
          FROM node_registration_tokens WHERE token_hash = ?`)
        .get(registeredTokenHash),
    ).toEqual({ revokedAt: legacyRevokedAt, operationId: null })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM agent_machine_audit_receipts
          WHERE organization_id = 'org-a' AND kind = 'registration-revoke'`)
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operations
          WHERE organization_id = 'org-a' AND type = 'agent.registration.revoke'`)
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events
          WHERE organization_id = 'org-a' AND action = 'node.agent.registration.revoked'`)
        .get(),
    ).toEqual({ count: 0 })
  })

  it('rejects a same-clock competing revoke after authority lookup without manufacturing receipt evidence', async () => {
    const repository = makeAgentMachineAuditRepositoryD1(d1)
    d1.beforeBatchOnce = () => {
      database
        .prepare(`UPDATE node_registration_tokens SET revoked_at = ? WHERE token_hash = ?`)
        .run(now, registeredTokenHash)
    }

    await expect(
      Effect.runPromise(repository.revokeRegistrationToken(principal, registeredTokenHash, now)),
    ).rejects.toMatchObject({ code: 'agent_machine_audit_rejected' })

    expect(
      database
        .prepare(`SELECT revoked_at AS revokedAt, machine_revocation_operation_id AS operationId
          FROM node_registration_tokens WHERE token_hash = ?`)
        .get(registeredTokenHash),
    ).toEqual({ revokedAt: now, operationId: null })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM agent_machine_audit_receipts
          WHERE organization_id = 'org-a' AND kind = 'registration-revoke'`)
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM operations
          WHERE organization_id = 'org-a' AND type = 'agent.registration.revoke'`)
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events
          WHERE organization_id = 'org-a' AND action = 'node.agent.registration.revoked'`)
        .get(),
    ).toEqual({ count: 0 })
  })

  it('adopts one concurrent same-token revocation after both authority reads miss', async () => {
    const repository = makeAgentMachineAuditRepositoryD1(d1)
    // Each call reads its receipt and parent authority before it can enter the
    // serialized D1 batch. The second call uses a later acceptance clock to
    // prove that the clock is not part of the durable replay fingerprint.
    d1.holdBatchesUntilFirstReads = 4
    const [first, second] = await Promise.all([
      Effect.runPromise(repository.revokeRegistrationToken(principal, registeredTokenHash, now)),
      Effect.runPromise(
        repository.revokeRegistrationToken(
          principal,
          registeredTokenHash,
          '2026-08-23T15:00:01.000Z',
        ),
      ),
    ])
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM agent_machine_audit_receipts
          WHERE organization_id = 'org-a' AND kind = 'registration-revoke'`)
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT token.revoked_at AS revokedAt,
          token.machine_revocation_operation_id AS operationId,
          receipt.operation_id AS receiptOperationId,
          receipt.accepted_at AS receiptAcceptedAt
          FROM node_registration_tokens token
          JOIN agent_machine_audit_receipts receipt
            ON receipt.organization_id = token.organization_id
           AND receipt.kind = 'registration-revoke'
           AND receipt.effect_key = token.token_hash
          WHERE token.token_hash = ?`)
        .get(registeredTokenHash),
    ).toEqual({
      operationId: expect.stringMatching(/^operation:machine:registration-revoke:/),
      receiptOperationId: expect.stringMatching(/^operation:machine:registration-revoke:/),
      receiptAcceptedAt: expect.stringMatching(/^2026-08-23T15:00:0[01]\.000Z$/),
      revokedAt: expect.stringMatching(/^2026-08-23T15:00:0[01]\.000Z$/),
    })
    const committed = database
      .prepare(`SELECT token.revoked_at AS revokedAt, receipt.accepted_at AS receiptAcceptedAt
        FROM node_registration_tokens token
        JOIN agent_machine_audit_receipts receipt
          ON receipt.organization_id = token.organization_id
         AND receipt.kind = 'registration-revoke'
         AND receipt.effect_key = token.token_hash
        WHERE token.token_hash = ?`)
      .get(registeredTokenHash) as {
      readonly revokedAt: string
      readonly receiptAcceptedAt: string
    }
    expect(committed.revokedAt).toBe(committed.receiptAcceptedAt)
    const linked = database
      .prepare(`SELECT token.machine_revocation_operation_id AS operationId,
        receipt.operation_id AS receiptOperationId
        FROM node_registration_tokens token
        JOIN agent_machine_audit_receipts receipt
          ON receipt.organization_id = token.organization_id
         AND receipt.kind = 'registration-revoke'
         AND receipt.effect_key = token.token_hash
        WHERE token.token_hash = ?`)
      .get(registeredTokenHash) as {
      readonly operationId: string
      readonly receiptOperationId: string
    }
    expect(linked.operationId).toBe(linked.receiptOperationId)
  })

  it('fences command results to the authenticated node and records only redacted machine evidence', async () => {
    seedGameCommand()
    const repository = makeAgentMachineAuditRepositoryD1(d1)
    const result = gameCommandResult()
    await expect(
      Effect.runPromise(
        repository.recordCommandResult({
          principal,
          result,
          acceptedAt: now,
          auditRequestContext: {
            origin: 'http',
            requestId: 'incorrect-http-request',
            correlationId: 'incorrect-http-correlation',
            source: {
              ip: { state: 'not-available', reason: 'test-ip-unavailable' },
              access: { state: 'not-available', reason: 'test-access-unavailable' },
            },
          } as never,
        }),
      ),
    ).rejects.toMatchObject({ code: 'agent_machine_audit_context_not_machine' })
    expect(
      database
        .prepare(`SELECT state FROM game_command_deliveries WHERE command_id = ?`)
        .get(result.commandId),
    ).toEqual({ state: 'delivered' })

    d1.failAfterCommitOnce = true
    await expect(
      Effect.runPromise(repository.recordCommandResult({ principal, result, acceptedAt: now })),
    ).resolves.toMatchObject({
      commandId: result.commandId,
      operationId: result.operationId,
      result: 'succeeded',
      replayed: true,
    })
    expect(
      database
        .prepare(`SELECT state, json_extract(result_json, '$.message') AS message
          FROM game_command_deliveries WHERE command_id = ?`)
        .get(result.commandId),
    ).toEqual({ state: 'completed', message: '[REDACTED]' })
    expect(
      database
        .prepare(`SELECT operation.resource_type AS targetType, operation.resource_id AS targetId,
          operation.status AS operationStatus,
          json_extract(envelope.envelope_json, '$.source.origin') AS origin,
          json_extract(envelope.envelope_json, '$.source.access.state') AS accessState,
          envelope.envelope_json AS envelopeJson
          FROM agent_machine_audit_receipts receipt
          JOIN operations operation ON operation.organization_id = receipt.organization_id
            AND operation.id = receipt.operation_id
          JOIN audit_event_envelopes envelope ON envelope.event_id = receipt.audit_event_id
            AND envelope.organization_id = receipt.organization_id
          WHERE receipt.organization_id = 'org-a' AND receipt.kind = 'command-result'`)
        .get(),
    ).toMatchObject({
      targetType: 'server',
      targetId: 'server-a',
      operationStatus: 'succeeded',
      origin: 'machine',
      accessState: 'not-available',
    })
    const changes = database.prepare('SELECT total_changes() AS changes').get()
    await expect(
      Effect.runPromise(repository.recordCommandResult({ principal, result, acceptedAt: now })),
    ).resolves.toMatchObject({ replayed: true })
    expect(database.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    await expect(
      Effect.runPromise(
        repository.recordCommandResult({
          principal,
          result: gameCommandResult({ code: 'different-outcome' }),
          acceptedAt: now,
        }),
      ),
    ).rejects.toMatchObject({ code: 'agent_machine_audit_replay_mismatch' })
    await expect(
      Effect.runPromise(
        repository.recordCommandResult({
          principal: { ...principal, organizationId: 'org-b' },
          result,
          acceptedAt: now,
        }),
      ),
    ).rejects.toMatchObject({ code: 'agent_machine_command_scope_rejected' })
  })
})

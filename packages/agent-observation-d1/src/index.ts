import { Effect, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  decodeAuditRequestContext,
  stageAuditEnvelope,
  type AuditEnvelopeV1,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import type { CommandResult } from '@gridora/agent-protocol'
import {
  AgentObservationConflictError,
  AgentObservationPersistenceError,
  canonicalJson,
  type AgentObservationEvent,
  type AgentObservationReplayKey,
  type AgentObservationReceipt,
  type AgentObservationRepositoryShape,
} from '@gridora/agent-observation-control'

export interface AgentObservationD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface AgentObservationD1Statement {
  bind(...values: ReadonlyArray<unknown>): AgentObservationD1Statement
  first(): Promise<unknown>
  all(): Promise<AgentObservationD1Result>
}
export interface AgentObservationD1Database {
  prepare(sql: string): AgentObservationD1Statement
  batch(
    statements: ReadonlyArray<AgentObservationD1Statement>,
  ): Promise<ReadonlyArray<AgentObservationD1Result>>
}

/** Machine credentials are never represented as HTTP/Access provenance. */
export interface AgentMachineAuditD1Options {
  readonly auditRequestContext?: AuditRequestContextValue
}

export interface AgentMachinePrincipal {
  readonly organizationId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly version: number
  readonly sessionVersion: number
}

export interface AgentMachineRegistrationExchange {
  readonly tokenHash: string
  readonly organizationId: string
  readonly nodeId: string
  readonly providerInstanceId: string
  readonly credentialId: string
  readonly credentialHash: string
  readonly agentVersion: string
  readonly installerPublicKey: string
  readonly installerPublicKeyFingerprint: string
  readonly now: string
  readonly auditRequestContext?: AuditRequestContextValue
}

export interface AgentMachineCommandResultInput {
  readonly principal: AgentMachinePrincipal
  readonly result: CommandResult
  /** Durable API admission time, not the agent-provided completion clock. */
  readonly acceptedAt: string
  readonly auditRequestContext?: AuditRequestContextValue
}

export interface AgentMachineCommandResultReceipt {
  readonly commandId: string
  readonly operationId: string
  readonly auditOperationId: string
  readonly auditEventId: string
  readonly result: 'succeeded' | 'failed'
  readonly replayed: boolean
}

export interface AgentMachineAuditRepositoryD1 {
  readonly exchange: (
    registration: AgentMachineRegistrationExchange,
  ) => Effect.Effect<
    AgentMachinePrincipal,
    AgentMachineAuditConflictError | AgentMachineAuditPersistenceError
  >
  readonly revokeRegistrationToken: (
    principal: AgentMachinePrincipal,
    tokenHash: string,
    now: string,
    auditRequestContext?: AuditRequestContextValue,
  ) => Effect.Effect<void, AgentMachineAuditConflictError | AgentMachineAuditPersistenceError>
  readonly recordCommandResult: (
    input: AgentMachineCommandResultInput,
  ) => Effect.Effect<
    AgentMachineCommandResultReceipt,
    AgentMachineAuditConflictError | AgentMachineAuditPersistenceError
  >
}

export class AgentMachineAuditConflictError extends Schema.TaggedError<AgentMachineAuditConflictError>()(
  'AgentMachineAuditConflictError',
  { code: Schema.String },
) {}

export class AgentMachineAuditPersistenceError extends Schema.TaggedError<AgentMachineAuditPersistenceError>()(
  'AgentMachineAuditPersistenceError',
  { operation: Schema.String },
) {}

const machineConflict = (code: string) => new AgentMachineAuditConflictError({ code })
const machinePersistence = (operation: string) =>
  new AgentMachineAuditPersistenceError({ operation })

type MachineAuditKind =
  | 'registration-exchange'
  | 'registration-revoke'
  | 'observation'
  | 'command-result'
  | 'node-runtime-completion'
type MachineAuditResult = 'succeeded' | 'failed'

interface PrincipalCoordinates {
  readonly organizationId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly version: number
  readonly sessionVersion: number
}
interface MachineIdentity {
  readonly id: string
  readonly digest: string
}
interface PreparedAudit {
  readonly eventId: string
  readonly envelope: AuditEnvelopeV1
  readonly stageBindings: ReadonlyArray<string | null>
}
interface StoredMachineReceipt {
  readonly requestFingerprint: string
  readonly effectKey: string
  readonly nodeId: string
  readonly credentialId: string
  readonly credentialVersion: number
  readonly sessionVersion: number
  readonly operationId: string
  readonly auditEventId: string
  readonly result: MachineAuditResult
  readonly resultJson: string
}

const kinds = ['agent', 'image', 'tunnel', 'docker', 'firewall', 'capacity', 'metrics'] as const

const isReady = (event: AgentObservationEvent): boolean =>
  event.facts.agent.ready &&
  event.facts.image.ready &&
  event.facts.image.signatureVerified &&
  event.facts.tunnel.ready &&
  event.facts.tunnel.state === 'connected' &&
  event.facts.docker.ready &&
  event.facts.docker.storageDriver === 'overlay2' &&
  event.facts.docker.projectQuotaReady &&
  event.facts.docker.privilegedContainers === 0 &&
  !event.facts.docker.dockerSocketMounted &&
  event.facts.firewall.ready &&
  event.facts.firewall.defaultDeny

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const isMachineResult = (value: unknown): value is MachineAuditResult =>
  value === 'succeeded' || value === 'failed'

const decodeReceipt = (value: unknown): AgentObservationReceipt | undefined => {
  const row = record(value)
  if (row === undefined) return undefined
  const sequence = number(row.sequence)
  const observedRevision = number(row.observedRevision)
  const observedState = row.observedState
  if (
    typeof row.organizationId !== 'string' ||
    typeof row.nodeId !== 'string' ||
    sequence === undefined ||
    observedRevision === undefined ||
    (observedState !== 'bootstrapping' &&
      observedState !== 'ready' &&
      observedState !== 'degraded') ||
    (row.capacityPublished !== 0 && row.capacityPublished !== 1) ||
    typeof row.acceptedAt !== 'string'
  )
    return undefined
  return {
    organizationId: row.organizationId,
    nodeId: row.nodeId,
    sequence,
    observedRevision,
    observedState,
    capacityPublished: row.capacityPublished === 1,
    acceptedAt: row.acceptedAt,
  }
}

interface StoredObservationCursor {
  readonly receipt: AgentObservationReceipt
  readonly credentialId: string
  readonly credentialVersion: number
  readonly sessionVersion: number
  readonly fingerprint: string
}
const decodeStoredCursor = (value: unknown): StoredObservationCursor | undefined => {
  const row = record(value)
  const receipt = decodeReceipt(value)
  const credentialVersion = number(row?.credentialVersion)
  const sessionVersion = number(row?.sessionVersion)
  if (
    row === undefined ||
    receipt === undefined ||
    typeof row.credentialId !== 'string' ||
    credentialVersion === undefined ||
    sessionVersion === undefined ||
    typeof row.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint)
  )
    return undefined
  return {
    receipt,
    credentialId: row.credentialId,
    credentialVersion,
    sessionVersion,
    fingerprint: row.fingerprint,
  }
}

const decodeStoredMachineReceipt = (value: unknown): StoredMachineReceipt | undefined => {
  const row = record(value)
  const credentialVersion = number(row?.credentialVersion)
  const sessionVersion = number(row?.sessionVersion)
  if (
    row === undefined ||
    typeof row.requestFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.requestFingerprint) ||
    typeof row.effectKey !== 'string' ||
    typeof row.nodeId !== 'string' ||
    typeof row.credentialId !== 'string' ||
    credentialVersion === undefined ||
    sessionVersion === undefined ||
    typeof row.operationId !== 'string' ||
    typeof row.auditEventId !== 'string' ||
    !isMachineResult(row.result) ||
    typeof row.resultJson !== 'string'
  )
    return undefined
  return {
    requestFingerprint: row.requestFingerprint,
    effectKey: row.effectKey,
    nodeId: row.nodeId,
    credentialId: row.credentialId,
    credentialVersion,
    sessionVersion,
    operationId: row.operationId,
    auditEventId: row.auditEventId,
    result: row.result,
    resultJson: row.resultJson,
  }
}

const replaySelect = `SELECT organization_id AS organizationId, node_id AS nodeId,
  credential_id AS credentialId, credential_version AS credentialVersion,
  session_version AS sessionVersion, last_sequence AS sequence,
  last_observed_revision AS observedRevision, last_fingerprint AS fingerprint,
  observed_state AS observedState, capacity_published AS capacityPublished,
  last_event_at AS acceptedAt
FROM agent_observation_streams WHERE organization_id = ? AND node_id = ?`

const receiptSelect = `SELECT request_fingerprint AS requestFingerprint, effect_key AS effectKey,
  node_id AS nodeId, credential_id AS credentialId, credential_version AS credentialVersion,
  session_version AS sessionVersion, operation_id AS operationId, audit_event_id AS auditEventId,
  result, result_json AS resultJson
FROM agent_machine_audit_receipts
WHERE organization_id = ? AND kind = ? AND idempotency_key = ?`

const cursorProbeSelect = `SELECT node.observed_revision AS nodeObservedRevision,
  stream.credential_id AS streamCredentialId,
  stream.credential_version AS streamCredentialVersion,
  stream.session_version AS streamSessionVersion,
  stream.last_sequence AS streamSequence,
  stream.last_observed_revision AS streamObservedRevision
FROM nodes node
JOIN agent_sessions session
  ON session.organization_id = node.organization_id AND session.node_id = node.id
JOIN node_credentials credential
  ON credential.organization_id = session.organization_id
 AND credential.node_id = session.node_id AND credential.id = session.credential_id
LEFT JOIN agent_observation_streams stream
  ON stream.organization_id = node.organization_id AND stream.node_id = node.id
WHERE node.organization_id = ? AND node.id = ?
  AND session.credential_id = ? AND session.session_version = ?
  AND session.session_state = 'connected'
  AND credential.id = ? AND credential.version = ? AND credential.status = 'active'`

const aggregateUpsert = `INSERT INTO agent_observation_aggregates
  (organization_id, node_id, fact_kind, sequence, observed_revision, summary_json, observed_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (organization_id, node_id, fact_kind) DO UPDATE SET
  sequence = excluded.sequence,
  observed_revision = excluded.observed_revision,
  summary_json = excluded.summary_json,
  observed_at = excluded.observed_at`

const capacityUpsert = `INSERT INTO node_runtime_capacity
  (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
   agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
SELECT ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, 1
FROM nodes node
WHERE node.organization_id = ? AND node.id = ? AND node.desired_state = 'ready'
ON CONFLICT (organization_id, node_id) DO UPDATE SET
  architecture = excluded.architecture,
  cpu_millis = excluded.cpu_millis,
  ram_bytes = excluded.ram_bytes,
  disk_bytes = excluded.disk_bytes,
  agent_ready = 1,
  tunnel_ready = 1,
  docker_ready = 1,
  firewall_ready = 1,
  reported_at = excluded.reported_at,
  revision = node_runtime_capacity.revision + 1`

const bootstrapAuthoritySelect = `SELECT operation.id AS parentOperationId
FROM operations operation
JOIN nodes node
  ON node.organization_id = operation.organization_id AND node.id = operation.resource_id
JOIN node_provision_acceptances acceptance
  ON acceptance.organization_id = operation.organization_id
 AND acceptance.operation_id = operation.id AND acceptance.node_id = node.id
JOIN node_bootstrap_token_reservations bootstrap
  ON bootstrap.organization_id = operation.organization_id
 AND bootstrap.operation_id = operation.id AND bootstrap.node_id = node.id
 AND bootstrap.token_record_id = acceptance.bootstrap_token_record_id
JOIN node_registration_tokens registration
  ON registration.organization_id = operation.organization_id
 AND registration.operation_id = operation.id AND registration.node_id = node.id
 AND registration.provider_instance_id = node.provider_instance_id
 AND registration.token_hash = bootstrap.token_hash
JOIN agent_sessions session
  ON session.organization_id = node.organization_id AND session.node_id = node.id
JOIN node_credentials credential
  ON credential.organization_id = session.organization_id
 AND credential.node_id = session.node_id AND credential.id = session.credential_id
JOIN outbox provider_event
  ON provider_event.organization_id = operation.organization_id
 AND provider_event.id = 'outbox_node_provider:' || operation.id
 AND provider_event.event_type = 'node.provision.provider-created'
 AND provider_event.aggregate_type = 'node' AND provider_event.aggregate_id = node.id
WHERE operation.organization_id = ? AND node.id = ?
  AND operation.type = 'provision-node' AND operation.resource_type = 'node'
  AND operation.status = 'waiting_external' AND operation.progress = 50
  AND node.pending_lifecycle_operation_id = operation.id
  AND node.desired_state = 'provisioning' AND node.provider_instance_id IS NOT NULL
  AND acceptance.image_id = node.image_id
  AND bootstrap.state = 'materialized'
  AND registration.consumed_at IS NOT NULL AND registration.revoked_at IS NULL
  AND registration.credential_id = ?
  AND session.credential_id = ? AND session.session_version = ? AND session.session_state = 'connected'
  AND credential.id = ? AND credential.version = ? AND credential.status = 'active'
  AND json_extract(provider_event.payload_json, '$.organizationId') = node.organization_id
  AND json_extract(provider_event.payload_json, '$.nodeId') = node.id
  AND json_extract(provider_event.payload_json, '$.operationId') = operation.id
  AND json_extract(provider_event.payload_json, '$.providerInstanceId') = node.provider_instance_id
  AND json_extract(provider_event.payload_json, '$.state') = 'waiting-for-agent'`

const bootstrapReadyOutboxInsert = `INSERT INTO outbox
  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
   publish_state, retry_count, available_at, lease_owner, lease_token, lease_until,
   created_at, delivered_at)
SELECT 'outbox_node_ready:' || operation.id, operation.organization_id,
  'node.provision.ready', 'node', operation.resource_id,
  json_object('schemaVersion', 1, 'organizationId', operation.organization_id,
    'partitionKey', operation.organization_id || ':node:' || operation.resource_id,
    'nodeId', operation.resource_id, 'operationId', operation.id, 'state', 'ready'),
  'pending', 0, ?, NULL, NULL, NULL, ?, NULL
FROM operations operation
JOIN audit_events audit ON audit.id = 'audit_node_ready:' || operation.id
WHERE operation.organization_id = ? AND operation.resource_id = ?
  AND operation.type = 'provision-node' AND operation.resource_type = 'node'
  AND operation.status = 'waiting_external'
  AND audit.organization_id = operation.organization_id
  AND audit.action = 'node.provision.ready' AND audit.target_type = 'node'
  AND audit.target_id = operation.resource_id AND audit.result = 'succeeded'`

const bootstrapOperationComplete = `UPDATE operations
SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
WHERE organization_id = ? AND resource_id = ? AND type = 'provision-node'
  AND resource_type = 'node' AND status = 'waiting_external'
  AND EXISTS (SELECT 1 FROM audit_events audit
    WHERE audit.id = 'audit_node_ready:' || operations.id
      AND audit.organization_id = operations.organization_id
      AND audit.action = 'node.provision.ready' AND audit.target_id = operations.resource_id
      AND audit.result = 'succeeded')
  AND EXISTS (SELECT 1 FROM outbox event
    WHERE event.id = 'outbox_node_ready:' || operations.id
      AND event.organization_id = operations.organization_id
      AND event.event_type = 'node.provision.ready' AND event.aggregate_id = operations.resource_id)`

const bootstrapCompletedPredicate = `EXISTS (
  SELECT 1 FROM operations operation
  JOIN audit_events audit ON audit.id = 'audit_node_ready:' || operation.id
  JOIN outbox event ON event.id = 'outbox_node_ready:' || operation.id
  WHERE operation.organization_id = nodes.organization_id
    AND operation.id = nodes.pending_lifecycle_operation_id
    AND operation.type = 'provision-node' AND operation.resource_type = 'node'
    AND operation.resource_id = nodes.id AND operation.status = 'succeeded'
    AND operation.progress = 100
    AND audit.organization_id = operation.organization_id
    AND audit.action = 'node.provision.ready' AND audit.target_id = nodes.id
    AND audit.result = 'succeeded'
    AND event.organization_id = operation.organization_id
    AND event.event_type = 'node.provision.ready' AND event.aggregate_id = nodes.id
)`

const nodeUpdate = `UPDATE nodes SET
  desired_state = CASE WHEN ? = 1 AND desired_state = 'provisioning'
    AND ${bootstrapCompletedPredicate} THEN 'ready' ELSE desired_state END,
  desired_revision = CASE WHEN ? = 1 AND desired_state = 'provisioning'
    AND ${bootstrapCompletedPredicate} THEN desired_revision + 1 ELSE desired_revision END,
  pending_lifecycle_operation_id = CASE WHEN ? = 1 AND desired_state = 'provisioning'
    AND ${bootstrapCompletedPredicate} THEN NULL ELSE pending_lifecycle_operation_id END,
  observed_revision = ?,
  observed_state = CASE
    WHEN ? = 1 AND (desired_state = 'ready' OR
      (desired_state = 'provisioning' AND ${bootstrapCompletedPredicate})) THEN 'ready'
    WHEN desired_state = 'provisioning' THEN 'bootstrapping'
    ELSE 'degraded'
  END,
  reconciliation_error = CASE WHEN ? = 1 AND (desired_state = 'ready' OR
      (desired_state = 'provisioning' AND ${bootstrapCompletedPredicate})) THEN NULL
    ELSE 'agent_readiness_incomplete' END,
  last_reconciled_at = ?, updated_at = ?
WHERE organization_id = ? AND id = ? AND observed_revision = ?
  AND desired_state IN ('provisioning', 'ready')`

const streamCommit = `INSERT INTO agent_observation_streams
  (organization_id, node_id, credential_id, credential_version, session_version,
   last_sequence, last_observed_revision, last_fingerprint, observed_state, capacity_published,
   last_event_at, revision)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, node.observed_state,
  CASE WHEN node.observed_state = 'ready' THEN 1 ELSE 0 END, ?, 1
FROM nodes node WHERE node.organization_id = ? AND node.id = ?
ON CONFLICT (organization_id, node_id) DO UPDATE SET
  credential_id = excluded.credential_id,
  credential_version = excluded.credential_version,
  session_version = excluded.session_version,
  last_sequence = excluded.last_sequence,
  last_observed_revision = excluded.last_observed_revision,
  last_fingerprint = excluded.last_fingerprint,
  observed_state = excluded.observed_state,
  capacity_published = excluded.capacity_published,
  last_event_at = excluded.last_event_at,
  revision = agent_observation_streams.revision + 1`

const terminalOperationInsert = `INSERT INTO operations
  (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
   idempotency_key, correlation_id, revision, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?, ?, 1, ?, ?)`

const compactAuditInsert = `INSERT INTO audit_events
  (id, organization_id, actor_id, action, target_type, target_id, result,
   correlation_id, summary_json, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const machineReceiptInsert = `INSERT INTO agent_machine_audit_receipts
  (organization_id, kind, idempotency_key, request_fingerprint, effect_key,
   node_id, credential_id, credential_version, session_version, machine_identity_id,
   parent_operation_id, operation_id, audit_event_id, target_type, target_id, result,
   observation_sequence, observation_revision, result_json, accepted_at, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const registrationParentSelect = `SELECT operation_id AS parentOperationId
FROM node_registration_tokens
WHERE token_hash = ? AND organization_id = ? AND node_id = ?
  AND (? IS NULL OR provider_instance_id = ?)
  -- Response-loss retries adopt their receipt before this lookup.  A request
  -- with no exact receipt must never treat an already-revoked token as an
  -- eligible parent authority.
  AND revoked_at IS NULL`

/**
 * A rebuild replaces an already-observed machine credential.  The next agent
 * session must therefore advance both immutable epochs rather than reusing the
 * provision-only `(credentialVersion, sessionVersion) = (1, 1)` pair.  This
 * query is intentionally separate from the generic registration-parent lookup:
 * the presence of a bootstrap row is not authority by itself.  Every mutable
 * node/run/operation fact and the exact unconsumed token must still match the
 * immutable 0058 bootstrap handoff.
 */
const rebuildRegistrationBootstrapSelect = `SELECT 1 AS present
FROM node_lifecycle_rebuild_bootstraps
WHERE organization_id = ? AND operation_id = ? AND node_id = ? AND token_hash = ?`

const rebuildRegistrationEpochSelect = `SELECT
  COALESCE((SELECT MAX(credential.version)
    FROM node_credentials credential
    WHERE credential.organization_id = bootstrap.organization_id
      AND credential.node_id = bootstrap.node_id), 0) + 1 AS credentialVersion,
  MAX(
    COALESCE((SELECT MAX(session.session_version)
      FROM agent_sessions session
      WHERE session.organization_id = bootstrap.organization_id
        AND session.node_id = bootstrap.node_id), 0),
    COALESCE((SELECT MAX(stream.session_version)
      FROM agent_observation_streams stream
      WHERE stream.organization_id = bootstrap.organization_id
        AND stream.node_id = bootstrap.node_id), 0)
  ) + 1 AS sessionVersion
FROM node_lifecycle_rebuild_bootstraps bootstrap
JOIN node_lifecycle_runs run
  ON run.organization_id = bootstrap.organization_id AND run.operation_id = bootstrap.operation_id
JOIN destructive_lifecycle_operations lifecycle
  ON lifecycle.organization_id = run.organization_id AND lifecycle.operation_id = run.operation_id
JOIN operations operation
  ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
JOIN nodes node
  ON node.organization_id = bootstrap.organization_id AND node.id = bootstrap.node_id
JOIN node_registration_tokens registration
  ON registration.token_hash = bootstrap.token_hash
 AND registration.organization_id = bootstrap.organization_id
 AND registration.operation_id = bootstrap.operation_id
 AND registration.node_id = bootstrap.node_id
 AND registration.provider_instance_id = bootstrap.provider_instance_id
WHERE bootstrap.organization_id = ? AND bootstrap.operation_id = ?
  AND bootstrap.node_id = ? AND bootstrap.token_hash = ?
  AND bootstrap.state IN ('prepared', 'provider-rebuilding', 'awaiting-agent')
  AND run.action = 'rebuild-node' AND run.state IN ('rebuilding', 'awaiting-agent')
  AND lifecycle.action = 'rebuild-node' AND lifecycle.state = 'running'
  AND operation.type = 'rebuild-node' AND operation.resource_type = 'node'
  AND operation.resource_id = bootstrap.node_id AND operation.status = 'running'
  AND node.pending_lifecycle_operation_id = bootstrap.operation_id
  AND node.desired_state = 'provisioning'
  AND node.desired_revision = bootstrap.node_desired_revision
  AND node.provider_type = bootstrap.provider_type
  AND node.provider_instance_id = bootstrap.provider_instance_id
  AND node.image_id = bootstrap.target_image_id
  AND registration.credential_id IS NULL AND registration.consumed_at IS NULL
  AND registration.revoked_at IS NULL AND registration.expires_at > ?
  AND NOT EXISTS (
    SELECT 1 FROM node_credentials credential
    WHERE credential.organization_id = bootstrap.organization_id
      AND credential.node_id = bootstrap.node_id AND credential.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_sessions session
    WHERE session.organization_id = bootstrap.organization_id
      AND session.node_id = bootstrap.node_id AND session.session_state <> 'revoked'
  )
  AND NOT EXISTS (
    SELECT 1 FROM node_installer_keys installer
    WHERE installer.organization_id = bootstrap.organization_id
      AND installer.node_id = bootstrap.node_id AND installer.status = 'active'
  )`

const commandBindingSelect = `SELECT family, parentOperationId, targetType, targetId,
  state, action, deliveryRevision
FROM (
  SELECT 'game' AS family, delivery.operation_id AS parentOperationId,
    operation.resource_type AS targetType, operation.resource_id AS targetId,
    delivery.state AS state, NULL AS action, NULL AS deliveryRevision
  FROM game_command_deliveries delivery
  JOIN operations operation
    ON operation.organization_id = delivery.organization_id AND operation.id = delivery.operation_id
  WHERE delivery.organization_id = ? AND delivery.command_id = ?
    AND json_extract(delivery.command_json, '$.nodeId') = ?
  UNION ALL
  SELECT 'tunnel' AS family, delivery.operation_id AS parentOperationId,
    operation.resource_type AS targetType, operation.resource_id AS targetId,
    delivery.state AS state, delivery.action AS action, delivery.revision AS deliveryRevision
  FROM tunnel_credential_deliveries delivery
  JOIN operations operation
    ON operation.organization_id = delivery.organization_id AND operation.id = delivery.operation_id
  WHERE delivery.organization_id = ? AND delivery.delivery_id = ? AND delivery.node_id = ?
)`

const machineIdentityStatements = (
  database: AgentObservationD1Database,
  principal: PrincipalCoordinates,
  identity: MachineIdentity,
  at: string,
): ReadonlyArray<AgentObservationD1Statement> => [
  database
    .prepare(`INSERT OR IGNORE INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'suspended', ?, ?)`)
    .bind(
      identity.id,
      `gridora-machine:${identity.digest}`,
      `machine-${identity.digest.slice(0, 32)}@audit.invalid`,
      `Machine agent ${principal.nodeId}`,
      at,
      at,
    ),
  database
    .prepare(`INSERT OR IGNORE INTO machine_audit_identities
      (organization_id, node_id, credential_id, credential_version, identity_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      principal.organizationId,
      principal.nodeId,
      principal.credentialId,
      principal.version,
      identity.id,
      at,
    ),
  database
    .prepare(`INSERT OR IGNORE INTO audit_actor_bindings
      (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
      VALUES ('tenant', ?, ?, 'machine', ?, ?, ?)`)
    .bind(principal.organizationId, principal.organizationId, identity.id, identity.id, at),
]

const defaultMachineRequest = (
  kind: MachineAuditKind,
  fingerprint: string,
): AuditRequestContextValue => ({
  origin: 'machine',
  requestId: `machine:${kind}:${fingerprint}`,
  correlationId: `machine:${kind}:${fingerprint}`,
  source: {
    ip: { state: 'not-available', reason: 'machine-source-ip-unavailable' },
    access: { state: 'not-available', reason: 'machine-bearer-credential' },
  },
})

const resolveMachineRequest = (
  request: AuditRequestContextValue | undefined,
  kind: MachineAuditKind,
  fingerprint: string,
): Effect.Effect<AuditRequestContextValue, AgentMachineAuditConflictError> =>
  decodeAuditRequestContext(request ?? defaultMachineRequest(kind, fingerprint)).pipe(
    Effect.mapError(() => machineConflict('agent_machine_audit_context_invalid')),
    Effect.flatMap((decoded) =>
      decoded.origin === 'machine' && decoded.source.access.state === 'not-available'
        ? Effect.succeed(decoded)
        : Effect.fail(machineConflict('agent_machine_audit_context_not_machine')),
    ),
  )

const sha256 = (value: unknown, operation: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalJson(value)),
      )
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => machinePersistence(operation),
  })

const machineIdentityFor = (
  principal: PrincipalCoordinates,
): Effect.Effect<MachineIdentity, AgentMachineAuditPersistenceError> =>
  sha256(
    {
      organizationId: principal.organizationId,
      nodeId: principal.nodeId,
      credentialId: principal.credentialId,
      credentialVersion: principal.version,
    },
    'agent-machine.audit-identity',
  ).pipe(Effect.map((digest) => ({ id: `machine_${digest}`, digest })))

const auditIds = (kind: MachineAuditKind, fingerprint: string) => ({
  operationId: `operation:machine:${kind}:${fingerprint}`,
  eventId: `audit:machine:${kind}:${fingerprint}`,
  idempotencyKey: `machine-audit:${kind}:${fingerprint}`,
})
const completionAuditIds = (parentOperationId: string) => ({
  operationId: `operation:machine:node-runtime-completion:${parentOperationId}`,
  eventId: `audit_node_ready:${parentOperationId}`,
  idempotencyKey: `machine-audit:node-runtime-completion:${parentOperationId}`,
})

const actionFor = (kind: MachineAuditKind): string =>
  ({
    'registration-exchange': 'node.agent.registration.exchanged',
    'registration-revoke': 'node.agent.registration.revoked',
    observation: 'node.agent.observation.accepted',
    'command-result': 'agent.command.result.accepted',
    'node-runtime-completion': 'node.provision.ready',
  })[kind]
const operationTypeFor = (kind: MachineAuditKind): string =>
  ({
    'registration-exchange': 'agent.registration.exchange',
    'registration-revoke': 'agent.registration.revoke',
    observation: 'agent.observation',
    'command-result': 'agent.command.result',
    'node-runtime-completion': 'node.runtime.completion',
  })[kind]

const prepareAudit = (input: {
  readonly eventId: string
  readonly operationId: string
  readonly organizationId: string
  readonly actorId: string
  readonly request: AuditRequestContextValue
  readonly kind: MachineAuditKind
  readonly targetType: string
  readonly targetId: string
  readonly result: MachineAuditResult
  readonly before: Record<string, unknown>
  readonly after: Record<string, unknown>
  readonly acceptedAt: string
  readonly errorCode?: string
}): Effect.Effect<PreparedAudit, AgentMachineAuditConflictError> =>
  completeAuditEnvelope({
    occurredAt: input.acceptedAt,
    scope: 'tenant',
    organizationId: input.organizationId,
    actor: { type: 'machine', id: input.actorId },
    request: input.request,
    action: actionFor(input.kind),
    target: { type: input.targetType, id: input.targetId },
    before: { state: 'captured', summary: input.before },
    after: { state: 'captured', summary: input.after },
    operationId: input.operationId,
    result: input.result,
    error: {
      classification: input.result === 'succeeded' ? 'none' : 'validation',
      code: input.result === 'succeeded' ? null : (input.errorCode ?? 'machine-command-failed'),
    },
    forced: false,
    breakGlass: false,
  }).pipe(
    Effect.flatMap((envelope) =>
      stageAuditEnvelope('tenant', input.eventId, envelope, input.acceptedAt).pipe(
        Effect.map((stage) => ({
          eventId: input.eventId,
          envelope,
          stageBindings: auditEnvelopeStageBindings(stage),
        })),
      ),
    ),
    Effect.mapError(() => machineConflict('agent_machine_audit_envelope_invalid')),
  )

const auditStatements = (
  database: AgentObservationD1Database,
  audit: PreparedAudit,
): ReadonlyArray<AgentObservationD1Statement> => [
  database.prepare(auditEnvelopeStageSql).bind(...audit.stageBindings),
  database
    .prepare(compactAuditInsert)
    .bind(
      audit.eventId,
      audit.envelope.organizationId,
      audit.envelope.actor.id,
      audit.envelope.action,
      audit.envelope.target.type,
      audit.envelope.target.id,
      audit.envelope.result,
      audit.envelope.request.correlationId,
      auditEventSummaryJson(audit.envelope),
      audit.envelope.occurredAt,
    ),
]

const terminalOperationStatement = (
  database: AgentObservationD1Database,
  input: {
    readonly id: string
    readonly organizationId: string
    readonly kind: MachineAuditKind
    readonly targetType: string
    readonly targetId: string
    readonly actorId: string
    readonly result: MachineAuditResult
    readonly idempotencyKey: string
    readonly correlationId: string
    readonly acceptedAt: string
  },
): AgentObservationD1Statement =>
  database
    .prepare(terminalOperationInsert)
    .bind(
      input.id,
      input.organizationId,
      operationTypeFor(input.kind),
      input.targetType,
      input.targetId,
      input.actorId,
      input.result === 'succeeded' ? 'succeeded' : 'failed_terminal',
      input.idempotencyKey,
      input.correlationId,
      input.acceptedAt,
      input.acceptedAt,
    )

const machineReceiptStatement = (
  database: AgentObservationD1Database,
  input: {
    readonly organizationId: string
    readonly kind: MachineAuditKind
    readonly idempotencyKey: string
    readonly requestFingerprint: string
    readonly effectKey: string
    readonly principal: PrincipalCoordinates
    readonly machineIdentityId: string
    readonly parentOperationId: string | null
    readonly operationId: string
    readonly auditEventId: string
    readonly targetType: string
    readonly targetId: string
    readonly result: MachineAuditResult
    readonly observationSequence: number | null
    readonly observationRevision: number | null
    readonly resultJson: string
    readonly acceptedAt: string
  },
): AgentObservationD1Statement =>
  database
    .prepare(machineReceiptInsert)
    .bind(
      input.organizationId,
      input.kind,
      input.idempotencyKey,
      input.requestFingerprint,
      input.effectKey,
      input.principal.nodeId,
      input.principal.credentialId,
      input.principal.version,
      input.principal.sessionVersion,
      input.machineIdentityId,
      input.parentOperationId,
      input.operationId,
      input.auditEventId,
      input.targetType,
      input.targetId,
      input.result,
      input.observationSequence,
      input.observationRevision,
      input.resultJson,
      input.acceptedAt,
      input.acceptedAt,
    )

const readMachineReceipt = (
  database: AgentObservationD1Database,
  organizationId: string,
  kind: MachineAuditKind,
  idempotencyKey: string,
): Effect.Effect<StoredMachineReceipt | null, AgentMachineAuditPersistenceError> =>
  Effect.tryPromise({
    try: () => database.prepare(receiptSelect).bind(organizationId, kind, idempotencyKey).first(),
    catch: () => machinePersistence('agent-machine.audit-receipt.read'),
  }).pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null)
      const decoded = decodeStoredMachineReceipt(value)
      return decoded === undefined
        ? Effect.fail(machinePersistence('agent-machine.audit-receipt.decode'))
        : Effect.succeed(decoded)
    }),
  )

const assertExactReceipt = (
  receipt: StoredMachineReceipt,
  input: {
    readonly fingerprint: string
    readonly effectKey: string
    readonly principal: PrincipalCoordinates
  },
): Effect.Effect<StoredMachineReceipt, AgentMachineAuditConflictError> =>
  receipt.requestFingerprint === input.fingerprint &&
  receipt.effectKey === input.effectKey &&
  receipt.nodeId === input.principal.nodeId &&
  receipt.credentialId === input.principal.credentialId &&
  receipt.credentialVersion === input.principal.version &&
  receipt.sessionVersion === input.principal.sessionVersion
    ? Effect.succeed(receipt)
    : Effect.fail(machineConflict('agent_machine_audit_replay_mismatch'))

const parseJsonRecord = (
  value: string,
  operation: string,
): Effect.Effect<Record<string, unknown>, AgentMachineAuditPersistenceError> =>
  Effect.try({
    try: () => {
      const decoded = record(JSON.parse(value))
      if (decoded === undefined) throw new Error('not a JSON object')
      return decoded
    },
    catch: () => machinePersistence(operation),
  })

const mapObservationError = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /agent observation|agent machine|audit envelope|constraint failed|UNIQUE constraint/i.test(
    message,
  )
    ? new AgentObservationConflictError({ code: 'agent_observation_rejected' })
    : new AgentObservationPersistenceError({ operation: 'agent-observation.ingest' })
}
const mapMachineError = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /agent machine|audit envelope|constraint failed|UNIQUE constraint|FOREIGN KEY/i.test(
    message,
  )
    ? machineConflict('agent_machine_audit_rejected')
    : machinePersistence(operation)
}

const loadReplay = (
  database: AgentObservationD1Database,
  input: AgentObservationReplayKey,
): Effect.Effect<
  AgentObservationReceipt | null,
  AgentObservationConflictError | AgentObservationPersistenceError
> =>
  Effect.gen(function* () {
    const value = yield* Effect.tryPromise({
      try: () =>
        database.prepare(replaySelect).bind(input.event.organizationId, input.event.nodeId).first(),
      catch: () =>
        new AgentObservationPersistenceError({ operation: 'agent-observation.replay.read' }),
    })
    if (value === null) return null
    const stored = decodeStoredCursor(value)
    if (stored === undefined)
      return yield* new AgentObservationPersistenceError({
        operation: 'agent-observation.replay.decode',
      })
    const sameCursor =
      stored.receipt.sequence === input.event.sequence &&
      stored.receipt.observedRevision === input.event.observedRevision
    if (!sameCursor) return null
    if (
      stored.receipt.organizationId !== input.principal.organizationId ||
      stored.receipt.nodeId !== input.principal.nodeId ||
      stored.credentialId !== input.principal.credentialId ||
      stored.credentialVersion !== input.principal.version ||
      stored.sessionVersion !== input.principal.sessionVersion ||
      stored.sessionVersion !== input.event.sessionVersion ||
      stored.fingerprint !== input.fingerprint
    )
      return yield* new AgentObservationConflictError({ code: 'agent_observation_replay_mismatch' })
    const receipt = yield* readMachineReceipt(
      database,
      input.principal.organizationId,
      'observation',
      input.fingerprint,
    ).pipe(
      Effect.mapError(
        () =>
          new AgentObservationPersistenceError({ operation: 'agent-observation.replay.receipt' }),
      ),
    )
    if (receipt === null)
      return yield* new AgentObservationPersistenceError({
        operation: 'agent-observation.replay.strict-receipt-missing',
      })
    yield* assertExactReceipt(receipt, {
      fingerprint: input.fingerprint,
      effectKey: input.fingerprint,
      principal: input.principal,
    }).pipe(
      Effect.mapError(
        () => new AgentObservationConflictError({ code: 'agent_observation_replay_mismatch' }),
      ),
    )
    return stored.receipt
  })

const probeNotCommitted = (
  database: AgentObservationD1Database,
  input: {
    readonly principal: AgentObservationReplayKey['principal']
    readonly event: AgentObservationReplayKey['event']
  },
): Effect.Effect<void, AgentObservationConflictError | AgentObservationPersistenceError> =>
  Effect.gen(function* () {
    const value = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(cursorProbeSelect)
          .bind(
            input.principal.organizationId,
            input.principal.nodeId,
            input.principal.credentialId,
            input.principal.sessionVersion,
            input.principal.credentialId,
            input.principal.version,
          )
          .first(),
      catch: () =>
        new AgentObservationPersistenceError({ operation: 'agent-observation.cursor.read' }),
    })
    const row = record(value)
    const nodeObservedRevision = number(row?.nodeObservedRevision)
    if (nodeObservedRevision === undefined)
      return yield* new AgentObservationConflictError({
        code: 'agent_observation_cursor_advanced_or_different',
      })
    if (row?.streamSequence === null) {
      if (input.event.sequence === 1 && input.event.observedRevision === nodeObservedRevision + 1)
        return
      return yield* new AgentObservationConflictError({
        code: 'agent_observation_cursor_advanced_or_different',
      })
    }
    const streamSequence = number(row?.streamSequence)
    const streamObservedRevision = number(row?.streamObservedRevision)
    const streamSessionVersion = number(row?.streamSessionVersion)
    const streamCredentialVersion = number(row?.streamCredentialVersion)
    const streamCredentialId = text(row?.streamCredentialId)
    if (
      streamSequence === undefined ||
      streamObservedRevision === undefined ||
      streamSessionVersion === undefined ||
      streamCredentialVersion === undefined ||
      streamCredentialId === undefined ||
      nodeObservedRevision !== streamObservedRevision
    )
      return yield* new AgentObservationConflictError({
        code: 'agent_observation_cursor_advanced_or_different',
      })
    const sameSessionNext =
      streamCredentialId === input.principal.credentialId &&
      streamCredentialVersion === input.principal.version &&
      streamSessionVersion === input.principal.sessionVersion &&
      input.event.sequence === streamSequence + 1
    const nextSessionFirst =
      input.principal.sessionVersion === streamSessionVersion + 1 && input.event.sequence === 1
    if (
      input.event.observedRevision === streamObservedRevision + 1 &&
      (sameSessionNext || nextSessionFirst)
    )
      return
    return yield* new AgentObservationConflictError({
      code: 'agent_observation_cursor_advanced_or_different',
    })
  })

const bootstrapParent = (
  database: AgentObservationD1Database,
  principal: PrincipalCoordinates,
): Effect.Effect<string | null, AgentObservationPersistenceError> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(bootstrapAuthoritySelect)
        .bind(
          principal.organizationId,
          principal.nodeId,
          principal.credentialId,
          principal.credentialId,
          principal.sessionVersion,
          principal.credentialId,
          principal.version,
        )
        .first(),
    catch: () =>
      new AgentObservationPersistenceError({ operation: 'agent-observation.bootstrap.read' }),
  }).pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null)
      const parentOperationId = text(record(value)?.parentOperationId)
      return parentOperationId === undefined
        ? Effect.fail(
            new AgentObservationPersistenceError({
              operation: 'agent-observation.bootstrap.decode',
            }),
          )
        : Effect.succeed(parentOperationId)
    }),
  )

/**
 * Observation ingestion atomically commits facts, node state, the cursor,
 * terminal machine operation, strict v1 audit envelope/row, and receipt.
 */
export const makeAgentObservationRepositoryD1 = (
  database: AgentObservationD1Database,
  options: AgentMachineAuditD1Options = {},
): AgentObservationRepositoryShape => {
  const findReplay: AgentObservationRepositoryShape['findReplay'] = (input) =>
    loadReplay(database, input)
  const probe: AgentObservationRepositoryShape['probeNotCommitted'] = (input) =>
    probeNotCommitted(database, input)
  const ingestAtomic: AgentObservationRepositoryShape['ingestAtomic'] = ({
    principal,
    event,
    fingerprint,
    acceptedAt,
  }) =>
    Effect.gen(function* () {
      const request = yield* resolveMachineRequest(
        options.auditRequestContext,
        'observation',
        fingerprint,
      ).pipe(
        Effect.mapError(
          () =>
            new AgentObservationPersistenceError({ operation: 'agent-observation.audit-context' }),
        ),
      )
      const identity = yield* machineIdentityFor(principal).pipe(
        Effect.mapError(
          () => new AgentObservationPersistenceError({ operation: 'agent-observation.identity' }),
        ),
      )
      const ids = auditIds('observation', fingerprint)
      const ready = isReady(event)
      const parentOperationId = ready ? yield* bootstrapParent(database, principal) : null
      const observationAudit = yield* prepareAudit({
        eventId: ids.eventId,
        operationId: ids.operationId,
        organizationId: principal.organizationId,
        actorId: identity.id,
        request,
        kind: 'observation',
        targetType: 'node',
        targetId: principal.nodeId,
        result: 'succeeded',
        before: { operationId: ids.operationId, state: 'observation-not-yet-accepted' },
        after: {
          operationId: ids.operationId,
          nodeId: principal.nodeId,
          sequence: event.sequence,
          observedRevision: event.observedRevision,
          readinessReported: ready,
        },
        acceptedAt,
      }).pipe(
        Effect.mapError(
          () => new AgentObservationPersistenceError({ operation: 'agent-observation.audit' }),
        ),
      )
      const completion =
        parentOperationId === null
          ? null
          : { parentOperationId, ids: completionAuditIds(parentOperationId) }
      const completionAudit =
        completion === null
          ? null
          : yield* prepareAudit({
              eventId: completion.ids.eventId,
              operationId: completion.ids.operationId,
              organizationId: principal.organizationId,
              actorId: identity.id,
              request,
              kind: 'node-runtime-completion',
              targetType: 'node',
              targetId: principal.nodeId,
              result: 'succeeded',
              before: {
                operationId: completion.parentOperationId,
                state: 'waiting-for-agent-readiness',
              },
              after: {
                operationId: completion.ids.operationId,
                nodeId: principal.nodeId,
                state: 'ready',
              },
              acceptedAt,
            }).pipe(
              Effect.mapError(
                () =>
                  new AgentObservationPersistenceError({
                    operation: 'agent-observation.completion-audit',
                  }),
              ),
            )
      const committed = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            const statements: AgentObservationD1Statement[] = [
              ...machineIdentityStatements(database, principal, identity, acceptedAt),
              terminalOperationStatement(database, {
                id: ids.operationId,
                organizationId: principal.organizationId,
                kind: 'observation',
                targetType: 'node',
                targetId: principal.nodeId,
                actorId: identity.id,
                result: 'succeeded',
                idempotencyKey: ids.idempotencyKey,
                correlationId: request.correlationId,
                acceptedAt,
              }),
              ...auditStatements(database, observationAudit),
              ...kinds.map((kind) =>
                database
                  .prepare(aggregateUpsert)
                  .bind(
                    event.organizationId,
                    event.nodeId,
                    kind,
                    event.sequence,
                    event.observedRevision,
                    JSON.stringify(event.facts[kind]),
                    acceptedAt,
                  ),
              ),
            ]
            if (completion !== null && completionAudit !== null) {
              statements.push(
                terminalOperationStatement(database, {
                  id: completion.ids.operationId,
                  organizationId: principal.organizationId,
                  kind: 'node-runtime-completion',
                  targetType: 'node',
                  targetId: principal.nodeId,
                  actorId: identity.id,
                  result: 'succeeded',
                  idempotencyKey: completion.ids.idempotencyKey,
                  correlationId: request.correlationId,
                  acceptedAt,
                }),
                ...auditStatements(database, completionAudit),
                database
                  .prepare(bootstrapReadyOutboxInsert)
                  .bind(acceptedAt, acceptedAt, principal.organizationId, principal.nodeId),
                database
                  .prepare(bootstrapOperationComplete)
                  .bind(acceptedAt, principal.organizationId, principal.nodeId),
              )
            }
            statements.push(
              database
                .prepare(nodeUpdate)
                .bind(
                  ready ? 1 : 0,
                  ready ? 1 : 0,
                  ready ? 1 : 0,
                  event.observedRevision,
                  ready ? 1 : 0,
                  ready ? 1 : 0,
                  acceptedAt,
                  acceptedAt,
                  event.organizationId,
                  event.nodeId,
                  event.observedRevision - 1,
                ),
            )
            if (ready) {
              statements.push(
                database
                  .prepare(capacityUpsert)
                  .bind(
                    event.organizationId,
                    event.nodeId,
                    event.facts.capacity.architecture,
                    event.facts.capacity.cpuMillis,
                    event.facts.capacity.ramBytes,
                    event.facts.capacity.diskBytes,
                    acceptedAt,
                    event.organizationId,
                    event.nodeId,
                  ),
              )
            }
            statements.push(
              database
                .prepare(`DELETE FROM node_runtime_capacity
                  WHERE organization_id = ? AND node_id = ? AND (
                    ? = 0 OR EXISTS (SELECT 1 FROM nodes node
                      WHERE node.organization_id = ? AND node.id = ? AND node.desired_state <> 'ready')
                  )`)
                .bind(
                  event.organizationId,
                  event.nodeId,
                  ready ? 1 : 0,
                  event.organizationId,
                  event.nodeId,
                ),
              database
                .prepare(streamCommit)
                .bind(
                  event.organizationId,
                  event.nodeId,
                  principal.credentialId,
                  principal.version,
                  event.sessionVersion,
                  event.sequence,
                  event.observedRevision,
                  fingerprint,
                  acceptedAt,
                  event.organizationId,
                  event.nodeId,
                ),
              machineReceiptStatement(database, {
                organizationId: principal.organizationId,
                kind: 'observation',
                idempotencyKey: fingerprint,
                requestFingerprint: fingerprint,
                effectKey: fingerprint,
                principal,
                machineIdentityId: identity.id,
                parentOperationId: null,
                operationId: ids.operationId,
                auditEventId: ids.eventId,
                targetType: 'node',
                targetId: principal.nodeId,
                result: 'succeeded',
                observationSequence: event.sequence,
                observationRevision: event.observedRevision,
                resultJson: JSON.stringify({
                  operationId: ids.operationId,
                  nodeId: principal.nodeId,
                  sequence: event.sequence,
                  observedRevision: event.observedRevision,
                  accepted: true,
                }),
                acceptedAt,
              }),
            )
            if (completion !== null) {
              statements.push(
                machineReceiptStatement(database, {
                  organizationId: principal.organizationId,
                  kind: 'node-runtime-completion',
                  idempotencyKey: completion.parentOperationId,
                  requestFingerprint: fingerprint,
                  effectKey: completion.parentOperationId,
                  principal,
                  machineIdentityId: identity.id,
                  parentOperationId: completion.parentOperationId,
                  operationId: completion.ids.operationId,
                  auditEventId: completion.ids.eventId,
                  targetType: 'node',
                  targetId: principal.nodeId,
                  result: 'succeeded',
                  observationSequence: null,
                  observationRevision: null,
                  resultJson: JSON.stringify({
                    operationId: completion.ids.operationId,
                    parentOperationId: completion.parentOperationId,
                    nodeId: principal.nodeId,
                    state: 'ready',
                  }),
                  acceptedAt,
                }),
              )
            }
            await database.batch(statements)
          },
          catch: mapObservationError,
        }),
      )
      const replay = yield* loadReplay(database, { principal, event, fingerprint })
      if (replay !== null) return replay
      if (committed._tag === 'Failure') return yield* committed.failure
      return yield* new AgentObservationPersistenceError({
        operation: 'agent-observation.commit-without-strict-receipt',
      })
    })
  return { findReplay, probeNotCommitted: probe, ingestAtomic }
}

const registrationParent = (
  database: AgentObservationD1Database,
  tokenHash: string,
  organizationId: string,
  nodeId: string,
  providerInstanceId: string | null,
): Effect.Effect<string | null, AgentMachineAuditPersistenceError> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(registrationParentSelect)
        .bind(tokenHash, organizationId, nodeId, providerInstanceId, providerInstanceId)
        .first(),
    catch: () => machinePersistence('agent-machine.registration-parent.read'),
  }).pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null)
      const parentOperationId = text(record(value)?.parentOperationId)
      return parentOperationId === undefined
        ? Effect.fail(machinePersistence('agent-machine.registration-parent.decode'))
        : Effect.succeed(parentOperationId)
    }),
  )

interface RebuildRegistrationEpoch {
  readonly credentialVersion: number
  readonly sessionVersion: number
}

/**
 * Returns `null` for the unchanged provision-registration path.  If the
 * immutable bootstrap row exists but cannot prove the exact live rebuild
 * handoff, fail closed instead of falling back to epoch one.
 */
const rebuildRegistrationEpoch = (
  database: AgentObservationD1Database,
  input: {
    readonly tokenHash: string
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly now: string
  },
): Effect.Effect<
  RebuildRegistrationEpoch | null,
  AgentMachineAuditConflictError | AgentMachineAuditPersistenceError
> =>
  Effect.gen(function* () {
    const bootstrap = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(rebuildRegistrationBootstrapSelect)
          .bind(input.organizationId, input.operationId, input.nodeId, input.tokenHash)
          .first(),
      catch: () => machinePersistence('agent-machine.rebuild-registration.bootstrap.read'),
    })
    if (bootstrap === null) return null
    const raw = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(rebuildRegistrationEpochSelect)
          .bind(input.organizationId, input.operationId, input.nodeId, input.tokenHash, input.now)
          .first(),
      catch: () => machinePersistence('agent-machine.rebuild-registration.epoch.read'),
    })
    const row = record(raw)
    const credentialVersion = number(row?.credentialVersion)
    const sessionVersion = number(row?.sessionVersion)
    if (
      credentialVersion === undefined ||
      credentialVersion < 2 ||
      sessionVersion === undefined ||
      sessionVersion < 2
    )
      return yield* machineConflict('agent_machine_rebuild_registration_epoch_unavailable')
    return { credentialVersion, sessionVersion }
  })

const decodePrincipalResult = (
  value: Record<string, unknown>,
): AgentMachinePrincipal | undefined => {
  const version = number(value.version)
  const sessionVersion = number(value.sessionVersion)
  if (
    typeof value.organizationId !== 'string' ||
    typeof value.nodeId !== 'string' ||
    typeof value.credentialId !== 'string' ||
    version === undefined ||
    sessionVersion === undefined
  )
    return undefined
  return {
    organizationId: value.organizationId,
    nodeId: value.nodeId,
    credentialId: value.credentialId,
    version,
    sessionVersion,
  }
}

interface CommandBinding {
  readonly family: 'game' | 'tunnel'
  readonly parentOperationId: string
  readonly targetType: string
  readonly targetId: string
  readonly state: string
  readonly action: 'install' | 'rotate' | 'revoke' | null
  readonly deliveryRevision: number | null
}

const commandBinding = (
  database: AgentObservationD1Database,
  principal: PrincipalCoordinates,
  commandId: string,
): Effect.Effect<
  CommandBinding | null,
  AgentMachineAuditConflictError | AgentMachineAuditPersistenceError
> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(commandBindingSelect)
          .bind(
            principal.organizationId,
            commandId,
            principal.nodeId,
            principal.organizationId,
            commandId,
            principal.nodeId,
          )
          .all(),
      catch: () => machinePersistence('agent-machine.command-binding.read'),
    })
    if (result.results.length === 0) return null
    if (result.results.length !== 1)
      return yield* machineConflict('agent_machine_command_binding_ambiguous')
    const row = record(result.results[0])
    const family = row?.family
    const parentOperationId = text(row?.parentOperationId)
    const targetType = text(row?.targetType)
    const targetId = text(row?.targetId)
    const state = text(row?.state)
    const action = row?.action === null ? null : text(row?.action)
    const deliveryRevision = row?.deliveryRevision === null ? null : number(row?.deliveryRevision)
    if (
      (family !== 'game' && family !== 'tunnel') ||
      parentOperationId === undefined ||
      targetType === undefined ||
      targetId === undefined ||
      state === undefined ||
      (action !== null && action !== 'install' && action !== 'rotate' && action !== 'revoke') ||
      (family === 'tunnel' && deliveryRevision === undefined)
    )
      return yield* machinePersistence('agent-machine.command-binding.decode')
    return {
      family,
      parentOperationId,
      targetType,
      targetId,
      state,
      action: action as CommandBinding['action'],
      deliveryRevision: deliveryRevision ?? null,
    }
  })

const safeCommandResult = (result: CommandResult): Record<string, unknown> => ({
  commandId: result.commandId,
  operationId: result.operationId,
  status: result.status,
  revision: result.revision,
  code: result.code,
  // Agent command messages can contain shell or provider output. Existing
  // command-result decoders still receive the required string shape.
  message: '[REDACTED]',
  duplicate: result.duplicate,
  ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
  completedAt: result.completedAt,
})

/**
 * API composition calls this after the node coordinator accepted or replayed a
 * result. This adapter makes the authoritative D1 state and audit evidence one
 * atomic commit, and adopts only the exact receipt after response loss.
 */
export const makeAgentMachineAuditRepositoryD1 = (
  database: AgentObservationD1Database,
  options: AgentMachineAuditD1Options = {},
): AgentMachineAuditRepositoryD1 => {
  const exchange: AgentMachineAuditRepositoryD1['exchange'] = (registration) =>
    Effect.gen(function* () {
      const fingerprint = yield* sha256(
        {
          tokenHash: registration.tokenHash,
          organizationId: registration.organizationId,
          nodeId: registration.nodeId,
          providerInstanceId: registration.providerInstanceId,
          credentialId: registration.credentialId,
          credentialHash: registration.credentialHash,
          agentVersion: registration.agentVersion,
          installerPublicKey: registration.installerPublicKey,
          installerPublicKeyFingerprint: registration.installerPublicKeyFingerprint,
        },
        'agent-machine.registration-exchange.fingerprint',
      )
      const existing = yield* readMachineReceipt(
        database,
        registration.organizationId,
        'registration-exchange',
        registration.tokenHash,
      )
      if (existing !== null) {
        if (
          existing.requestFingerprint !== fingerprint ||
          existing.effectKey !== registration.tokenHash ||
          existing.nodeId !== registration.nodeId ||
          existing.credentialId !== registration.credentialId
        )
          return yield* machineConflict('agent_machine_audit_replay_mismatch')
        const result = yield* parseJsonRecord(
          existing.resultJson,
          'agent-machine.registration-exchange.replay',
        )
        const replay = decodePrincipalResult(result)
        if (
          replay === undefined ||
          replay.organizationId !== registration.organizationId ||
          replay.nodeId !== registration.nodeId ||
          replay.credentialId !== registration.credentialId
        )
          return yield* machinePersistence('agent-machine.registration-exchange.replay.decode')
        yield* assertExactReceipt(existing, {
          fingerprint,
          effectKey: registration.tokenHash,
          principal: replay,
        })
        return replay
      }
      const parentOperationId = yield* registrationParent(
        database,
        registration.tokenHash,
        registration.organizationId,
        registration.nodeId,
        registration.providerInstanceId,
      )
      if (parentOperationId === null)
        return yield* machineConflict('agent_machine_registration_scope_rejected')
      const rebuildEpoch = yield* rebuildRegistrationEpoch(database, {
        tokenHash: registration.tokenHash,
        organizationId: registration.organizationId,
        operationId: parentOperationId,
        nodeId: registration.nodeId,
        now: registration.now,
      })
      const principal: AgentMachinePrincipal = {
        organizationId: registration.organizationId,
        nodeId: registration.nodeId,
        credentialId: registration.credentialId,
        version: rebuildEpoch?.credentialVersion ?? 1,
        sessionVersion: rebuildEpoch?.sessionVersion ?? 1,
      }
      const request = yield* resolveMachineRequest(
        registration.auditRequestContext ?? options.auditRequestContext,
        'registration-exchange',
        fingerprint,
      )
      const identity = yield* machineIdentityFor(principal)
      const ids = auditIds('registration-exchange', fingerprint)
      const audit = yield* prepareAudit({
        eventId: ids.eventId,
        operationId: ids.operationId,
        organizationId: registration.organizationId,
        actorId: identity.id,
        request,
        kind: 'registration-exchange',
        targetType: 'node',
        targetId: registration.nodeId,
        result: 'succeeded',
        before: { operationId: parentOperationId, state: 'registration-token-unconsumed' },
        after: {
          operationId: ids.operationId,
          nodeId: registration.nodeId,
          credentialVersion: principal.version,
          sessionVersion: principal.sessionVersion,
          state: 'agent-registered',
        },
        acceptedAt: registration.now,
      })
      const attempt = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            await database.batch([
              database
                .prepare(`UPDATE node_registration_tokens SET consumed_at = ?
                  WHERE token_hash = ? AND organization_id = ? AND node_id = ?
                  AND provider_instance_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
                  AND expires_at > ?`)
                .bind(
                  registration.now,
                  registration.tokenHash,
                  registration.organizationId,
                  registration.nodeId,
                  registration.providerInstanceId,
                  registration.now,
                ),
              database
                .prepare(`INSERT INTO node_credentials
                  (organization_id, node_id, id, credential_hash, version, status, issued_at)
                  SELECT organization_id, node_id, ?, ?, ?, 'active', ?
                  FROM node_registration_tokens
                  WHERE token_hash = ? AND consumed_at = ?`)
                .bind(
                  registration.credentialId,
                  registration.credentialHash,
                  principal.version,
                  registration.now,
                  registration.tokenHash,
                  registration.now,
                ),
              database
                .prepare(`INSERT INTO agent_sessions
                  (organization_id, node_id, credential_id, session_version, agent_version,
                   session_state, last_seen_at, revision)
                  SELECT organization_id, node_id, ?, ?, ?, 'connected', ?, 1
                  FROM node_registration_tokens
                  WHERE token_hash = ? AND consumed_at = ?`)
                .bind(
                  registration.credentialId,
                  principal.sessionVersion,
                  registration.agentVersion,
                  registration.now,
                  registration.tokenHash,
                  registration.now,
                ),
              database
                .prepare(`UPDATE node_registration_tokens SET credential_id = ?
                  WHERE token_hash = ? AND consumed_at = ? AND credential_id IS NULL`)
                .bind(registration.credentialId, registration.tokenHash, registration.now),
              database
                .prepare(`UPDATE node_installer_keys
                  SET public_key = ?, public_key_fingerprint = ?, status = 'active',
                      revision = revision + 1, registered_at = ?, revoked_at = NULL
                  WHERE organization_id = ? AND node_id = ? AND status = 'revoked'
                    AND EXISTS (
                      SELECT 1 FROM node_lifecycle_rebuild_bootstraps bootstrap
                      WHERE bootstrap.organization_id = ? AND bootstrap.operation_id = ?
                        AND bootstrap.node_id = ? AND bootstrap.token_hash = ?
                        AND bootstrap.state IN ('prepared', 'provider-rebuilding', 'awaiting-agent')
                    )`)
                .bind(
                  registration.installerPublicKey,
                  registration.installerPublicKeyFingerprint,
                  registration.now,
                  registration.organizationId,
                  registration.nodeId,
                  registration.organizationId,
                  parentOperationId,
                  registration.nodeId,
                  registration.tokenHash,
                ),
              database
                .prepare(`INSERT OR IGNORE INTO node_installer_keys
                  (organization_id, node_id, public_key, public_key_fingerprint, status,
                   revision, registered_at)
                  SELECT organization_id, node_id, ?, ?, 'active', 1, ?
                  FROM node_registration_tokens
                  WHERE token_hash = ? AND consumed_at = ? AND credential_id = ?`)
                .bind(
                  registration.installerPublicKey,
                  registration.installerPublicKeyFingerprint,
                  registration.now,
                  registration.tokenHash,
                  registration.now,
                  registration.credentialId,
                ),
              ...machineIdentityStatements(database, principal, identity, registration.now),
              terminalOperationStatement(database, {
                id: ids.operationId,
                organizationId: registration.organizationId,
                kind: 'registration-exchange',
                targetType: 'node',
                targetId: registration.nodeId,
                actorId: identity.id,
                result: 'succeeded',
                idempotencyKey: ids.idempotencyKey,
                correlationId: request.correlationId,
                acceptedAt: registration.now,
              }),
              ...auditStatements(database, audit),
              machineReceiptStatement(database, {
                organizationId: registration.organizationId,
                kind: 'registration-exchange',
                idempotencyKey: registration.tokenHash,
                requestFingerprint: fingerprint,
                effectKey: registration.tokenHash,
                principal,
                machineIdentityId: identity.id,
                parentOperationId,
                operationId: ids.operationId,
                auditEventId: ids.eventId,
                targetType: 'node',
                targetId: registration.nodeId,
                result: 'succeeded',
                observationSequence: null,
                observationRevision: null,
                resultJson: JSON.stringify(principal),
                acceptedAt: registration.now,
              }),
            ])
          },
          catch: (cause) => mapMachineError('agent-machine.registration-exchange', cause),
        }),
      )
      const replay = yield* readMachineReceipt(
        database,
        registration.organizationId,
        'registration-exchange',
        registration.tokenHash,
      )
      if (replay !== null) {
        const exact = yield* assertExactReceipt(replay, {
          fingerprint,
          effectKey: registration.tokenHash,
          principal,
        })
        const result = yield* parseJsonRecord(
          exact.resultJson,
          'agent-machine.registration-exchange.result',
        )
        const accepted = decodePrincipalResult(result)
        if (accepted === undefined)
          return yield* machinePersistence('agent-machine.registration-exchange.result.decode')
        return accepted
      }
      if (attempt._tag === 'Failure') return yield* attempt.failure
      return yield* machinePersistence('agent-machine.registration-exchange.receipt-missing')
    })

  const revokeRegistrationToken: AgentMachineAuditRepositoryD1['revokeRegistrationToken'] = (
    principal,
    tokenHash,
    now,
    auditRequestContext,
  ) =>
    Effect.gen(function* () {
      const fingerprint = yield* sha256(
        { principal, tokenHash },
        'agent-machine.registration-revoke.fingerprint',
      )
      const existing = yield* readMachineReceipt(
        database,
        principal.organizationId,
        'registration-revoke',
        tokenHash,
      )
      if (existing !== null) {
        yield* assertExactReceipt(existing, { fingerprint, effectKey: tokenHash, principal })
        return
      }
      const parentOperationId = yield* registrationParent(
        database,
        tokenHash,
        principal.organizationId,
        principal.nodeId,
        null,
      )
      if (parentOperationId === null)
        return yield* machineConflict('agent_machine_registration_scope_rejected')
      const request = yield* resolveMachineRequest(
        auditRequestContext ?? options.auditRequestContext,
        'registration-revoke',
        fingerprint,
      )
      const identity = yield* machineIdentityFor(principal)
      const ids = auditIds('registration-revoke', fingerprint)
      const audit = yield* prepareAudit({
        eventId: ids.eventId,
        operationId: ids.operationId,
        organizationId: principal.organizationId,
        actorId: identity.id,
        request,
        kind: 'registration-revoke',
        targetType: 'node',
        targetId: principal.nodeId,
        result: 'succeeded',
        before: { operationId: parentOperationId, state: 'registration-token-active' },
        after: {
          operationId: ids.operationId,
          nodeId: principal.nodeId,
          state: 'registration-token-revoked',
        },
        acceptedAt: now,
      })
      const attempt = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            database.batch([
              // The audit operation and envelope are staged before the token
              // transition, but this is one atomic D1 batch.  The token link
              // guard can therefore prove that the transition belongs to this
              // terminal operation, and the receipt remains last.
              ...machineIdentityStatements(database, principal, identity, now),
              terminalOperationStatement(database, {
                id: ids.operationId,
                organizationId: principal.organizationId,
                kind: 'registration-revoke',
                targetType: 'node',
                targetId: principal.nodeId,
                actorId: identity.id,
                result: 'succeeded',
                idempotencyKey: ids.idempotencyKey,
                correlationId: request.correlationId,
                acceptedAt: now,
              }),
              ...auditStatements(database, audit),
              database
                .prepare(`UPDATE node_registration_tokens
                  SET consumed_at = COALESCE(consumed_at, ?),
                      revoked_at = ?,
                      machine_revocation_operation_id = ?
                  WHERE token_hash = ? AND organization_id = ? AND node_id = ?
                    AND revoked_at IS NULL AND machine_revocation_operation_id IS NULL`)
                .bind(
                  now,
                  now,
                  ids.operationId,
                  tokenHash,
                  principal.organizationId,
                  principal.nodeId,
                ),
              machineReceiptStatement(database, {
                organizationId: principal.organizationId,
                kind: 'registration-revoke',
                idempotencyKey: tokenHash,
                requestFingerprint: fingerprint,
                effectKey: tokenHash,
                principal,
                machineIdentityId: identity.id,
                parentOperationId,
                operationId: ids.operationId,
                auditEventId: ids.eventId,
                targetType: 'node',
                targetId: principal.nodeId,
                result: 'succeeded',
                observationSequence: null,
                observationRevision: null,
                resultJson: JSON.stringify({
                  operationId: ids.operationId,
                  nodeId: principal.nodeId,
                  state: 'registration-token-revoked',
                }),
                acceptedAt: now,
              }),
            ]),
          catch: (cause) => mapMachineError('agent-machine.registration-revoke', cause),
        }),
      )
      const replay = yield* readMachineReceipt(
        database,
        principal.organizationId,
        'registration-revoke',
        tokenHash,
      )
      if (replay !== null) {
        yield* assertExactReceipt(replay, { fingerprint, effectKey: tokenHash, principal })
        return
      }
      if (attempt._tag === 'Failure') return yield* attempt.failure
      return yield* machinePersistence('agent-machine.registration-revoke.receipt-missing')
    })

  const recordCommandResult: AgentMachineAuditRepositoryD1['recordCommandResult'] = (input) =>
    Effect.gen(function* () {
      const { principal, result, acceptedAt } = input
      const fingerprint = yield* sha256(
        { principal, result },
        'agent-machine.command-result.fingerprint',
      )
      const existing = yield* readMachineReceipt(
        database,
        principal.organizationId,
        'command-result',
        result.commandId,
      )
      if (existing !== null) {
        const exact = yield* assertExactReceipt(existing, {
          fingerprint,
          effectKey: result.commandId,
          principal,
        })
        const stored = yield* parseJsonRecord(
          exact.resultJson,
          'agent-machine.command-result.replay',
        )
        const operationId = text(stored.operationId)
        if (operationId === undefined)
          return yield* machinePersistence('agent-machine.command-result.replay.decode')
        return {
          commandId: result.commandId,
          operationId,
          auditOperationId: exact.operationId,
          auditEventId: exact.auditEventId,
          result: exact.result,
          replayed: true,
        }
      }
      const binding = yield* commandBinding(database, principal, result.commandId)
      if (binding === null || binding.parentOperationId !== result.operationId)
        return yield* machineConflict('agent_machine_command_scope_rejected')
      if (binding.state !== 'pending' && binding.state !== 'delivered')
        return yield* machineConflict('agent_machine_command_state_rejected')
      const successful =
        result.status === 'succeeded' &&
        (binding.family === 'game' || result.revision === binding.deliveryRevision)
      const terminalResult: MachineAuditResult = successful ? 'succeeded' : 'failed'
      const request = yield* resolveMachineRequest(
        input.auditRequestContext ?? options.auditRequestContext,
        'command-result',
        fingerprint,
      )
      const identity = yield* machineIdentityFor(principal)
      const ids = auditIds('command-result', fingerprint)
      const safeResultJson = JSON.stringify(safeCommandResult(result))
      const audit = yield* prepareAudit({
        eventId: ids.eventId,
        operationId: ids.operationId,
        organizationId: principal.organizationId,
        actorId: identity.id,
        request,
        kind: 'command-result',
        targetType: binding.targetType,
        targetId: binding.targetId,
        result: terminalResult,
        before: {
          operationId: binding.parentOperationId,
          commandId: result.commandId,
          state: binding.state,
        },
        after: {
          operationId: ids.operationId,
          parentOperationId: binding.parentOperationId,
          commandId: result.commandId,
          status: result.status,
          code: result.code,
        },
        acceptedAt,
        ...(terminalResult === 'failed' ? { errorCode: result.code } : {}),
      })
      const sideEffect: AgentObservationD1Statement =
        binding.family === 'game'
          ? database
              .prepare(`UPDATE game_command_deliveries
              SET state = ?, result_json = ?, attempts = attempts + 1, updated_at = ?
              WHERE organization_id = ? AND operation_id = ? AND command_id = ?
                AND state IN ('pending', 'delivered')`)
              .bind(
                terminalResult === 'succeeded' ? 'completed' : 'failed',
                safeResultJson,
                acceptedAt,
                principal.organizationId,
                binding.parentOperationId,
                result.commandId,
              )
          : database
              .prepare(`UPDATE tunnel_credential_deliveries
              SET state = ?, failure_code = ?, acknowledged_at = ?, updated_at = ?
              WHERE organization_id = ? AND node_id = ? AND delivery_id = ?
                AND operation_id = ? AND state IN ('queued', 'delivered')`)
              .bind(
                terminalResult === 'succeeded'
                  ? binding.action === 'revoke'
                    ? 'revoked'
                    : 'acknowledged'
                  : 'failed',
                terminalResult === 'succeeded' ? null : result.code,
                acceptedAt,
                acceptedAt,
                principal.organizationId,
                principal.nodeId,
                result.commandId,
                binding.parentOperationId,
              )
      const parentTerminal: AgentObservationD1Statement | null =
        binding.family === 'tunnel'
          ? database
              .prepare(`UPDATE operations SET status = ?, progress = 100, revision = revision + 1,
              updated_at = ? WHERE organization_id = ? AND id = ?
              AND status IN ('queued', 'running')`)
              .bind(
                terminalResult === 'succeeded' ? 'succeeded' : 'failed_terminal',
                acceptedAt,
                principal.organizationId,
                binding.parentOperationId,
              )
          : null
      const attempt = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            const statements: AgentObservationD1Statement[] = [
              sideEffect,
              ...(parentTerminal === null ? [] : [parentTerminal]),
              ...machineIdentityStatements(database, principal, identity, acceptedAt),
              terminalOperationStatement(database, {
                id: ids.operationId,
                organizationId: principal.organizationId,
                kind: 'command-result',
                targetType: binding.targetType,
                targetId: binding.targetId,
                actorId: identity.id,
                result: terminalResult,
                idempotencyKey: ids.idempotencyKey,
                correlationId: request.correlationId,
                acceptedAt,
              }),
              ...auditStatements(database, audit),
              machineReceiptStatement(database, {
                organizationId: principal.organizationId,
                kind: 'command-result',
                idempotencyKey: result.commandId,
                requestFingerprint: fingerprint,
                effectKey: result.commandId,
                principal,
                machineIdentityId: identity.id,
                parentOperationId: binding.parentOperationId,
                operationId: ids.operationId,
                auditEventId: ids.eventId,
                targetType: binding.targetType,
                targetId: binding.targetId,
                result: terminalResult,
                observationSequence: null,
                observationRevision: null,
                resultJson: safeResultJson,
                acceptedAt,
              }),
            ]
            await database.batch(statements)
          },
          catch: (cause) => mapMachineError('agent-machine.command-result', cause),
        }),
      )
      const replay = yield* readMachineReceipt(
        database,
        principal.organizationId,
        'command-result',
        result.commandId,
      )
      if (replay !== null) {
        const exact = yield* assertExactReceipt(replay, {
          fingerprint,
          effectKey: result.commandId,
          principal,
        })
        return {
          commandId: result.commandId,
          operationId: binding.parentOperationId,
          auditOperationId: exact.operationId,
          auditEventId: exact.auditEventId,
          result: exact.result,
          replayed: attempt._tag === 'Failure',
        }
      }
      if (attempt._tag === 'Failure') return yield* attempt.failure
      return yield* machinePersistence('agent-machine.command-result.receipt-missing')
    })

  return { exchange, revokeRegistrationToken, recordCommandResult }
}

import { Context, Effect, Layer, Schema } from 'effect'
import {
  AuditRequestContext,
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelopeFromRequestContext,
  stageAuditEnvelope,
  AuditRequestContextValue,
} from '@gridora/audit-contracts'
import {
  NodeProvisionExecutionConflictError,
  NodeProvisionExecutionPersistenceError,
  NodeProvisionExecutionRepository,
  NodeProvisionExecutionResultContract,
  type NodeProvisionExecutionCompletionInput,
  type NodeProvisionExecutionFailureInput,
  type NodeProvisionExecutionRepositoryShape,
  type NodeProvisionExecutionResult,
  type NodeProvisionExecutionPreparation,
  type ProvisionalNodeRegistrationExchangePortShape,
  type ProvisionalNodeRegistrationBindingPortShape,
  ProvisionalNodeRegistrationExchangePort,
  ProvisionalNodeRegistrationBindingPort,
} from '@gridora/node-provision-execution'

export interface NodeProvisionExecutionD1Result {
  readonly success?: boolean
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface NodeProvisionExecutionD1Statement {
  bind(...values: ReadonlyArray<unknown>): NodeProvisionExecutionD1Statement
  first(): Promise<unknown>
  all(): Promise<NodeProvisionExecutionD1Result>
}
export interface NodeProvisionExecutionD1Database {
  prepare(sql: string): NodeProvisionExecutionD1Statement
  batch(
    statements: ReadonlyArray<NodeProvisionExecutionD1Statement>,
  ): Promise<ReadonlyArray<NodeProvisionExecutionD1Result>>
}

export class NodeProvisionExecutionD1Client extends Context.Service<
  NodeProvisionExecutionD1Client,
  NodeProvisionExecutionD1Database
>()('@gridora/node-provision-execution-d1/NodeProvisionExecutionD1Client') {}
export const NodeProvisionExecutionD1ClientLayer = (database: NodeProvisionExecutionD1Database) =>
  Layer.succeed(NodeProvisionExecutionD1Client, database)

const persistence = (operation: string) => new NodeProvisionExecutionPersistenceError({ operation })
const conflict = (operation: string) => new NodeProvisionExecutionConflictError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => persistence(operation) })
const row = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
const one = (result: NodeProvisionExecutionD1Result): boolean =>
  result.success !== false && result.meta?.changes === 1

interface NodeProvisionAuditAuthority {
  readonly actorId: string
  readonly correlationId: string
  readonly request: AuditRequestContextValue
}

type NodeProvisionAuditState =
  | { readonly state: 'captured'; readonly summary: Readonly<Record<string, unknown>> }
  | { readonly state: 'absent'; readonly reason: string }

interface StagedNodeProvisionAudit {
  readonly statement: NodeProvisionExecutionD1Statement
  readonly summaryJson: string
}

type PlayerEndpointEvidence =
  | { readonly state: 'captured'; readonly endpoints: readonly PlayerEndpoint[] }
  | {
      readonly state: 'absent'
      readonly reason:
        | 'provider-addresses-missing'
        | 'provider-addresses-invalid'
        | 'provider-addresses-ambiguous'
    }

interface PlayerEndpoint {
  readonly recordType: 'A' | 'AAAA'
  readonly target: string
}

const normalizeIpv4 = (value: string): string | undefined => {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const parsed = Number(part)
    return parsed >= 0 && parsed <= 255 ? String(parsed) : undefined
  })
  return octets.some((part) => part === undefined) ? undefined : (octets.join('.') as string)
}

const normalizeIpv6 = (value: string): string | undefined => {
  const candidate = value.trim().toLowerCase()
  // Provider adapters only return address literals. Reject CIDRs, zones,
  // hostnames, and IPv4-mapped spellings rather than widening the DNS target
  // grammar beyond the authoritative 0051 table contract.
  if (candidate.length < 2 || candidate.length > 45 || !/^[0-9a-f:]+$/.test(candidate))
    return undefined
  const doubleColon = candidate.indexOf('::')
  if (doubleColon !== -1 && candidate.indexOf('::', doubleColon + 1) !== -1) return undefined
  const pieces = candidate.split(':')
  const groups = pieces.filter((piece) => piece.length > 0)
  if (
    groups.length > 8 ||
    (doubleColon === -1 && groups.length !== 8) ||
    (doubleColon !== -1 && groups.length >= 8) ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return undefined
  return candidate
}

/**
 * A provider may report no reachable public address while a VM is still
 * booting. That is a valid node-provision completion but not a valid DNS
 * authority. Multiple distinct addresses of the same DNS family are equally
 * unsafe to choose implicitly, so no player endpoint is persisted for them.
 */
const playerEndpointEvidence = (addresses: readonly string[]): PlayerEndpointEvidence => {
  if (addresses.length === 0) return { state: 'absent', reason: 'provider-addresses-missing' }
  const candidates = new Map<'A' | 'AAAA', string>()
  for (const rawAddress of addresses) {
    const ipv4 = normalizeIpv4(rawAddress.trim())
    const recordType: 'A' | 'AAAA' = ipv4 === undefined ? 'AAAA' : 'A'
    const target = ipv4 ?? normalizeIpv6(rawAddress)
    if (target === undefined) return { state: 'absent', reason: 'provider-addresses-invalid' }
    const current = candidates.get(recordType)
    if (current !== undefined && current !== target)
      return { state: 'absent', reason: 'provider-addresses-ambiguous' }
    candidates.set(recordType, target)
  }
  const endpoints = (['A', 'AAAA'] as const).flatMap((recordType) => {
    const target = candidates.get(recordType)
    return target === undefined ? [] : [{ recordType, target }]
  })
  return endpoints.length === 0
    ? { state: 'absent', reason: 'provider-addresses-missing' }
    : { state: 'captured', endpoints }
}

const auditAuthoritySql = `SELECT operation.actor_id AS actorId,
 operation.correlation_id AS correlationId,
 acceptance.audit_request_context_json AS auditRequestContext
FROM operations operation
JOIN node_provision_acceptances acceptance
  ON acceptance.organization_id = operation.organization_id
 AND acceptance.operation_id = operation.id AND acceptance.node_id = operation.resource_id
WHERE operation.organization_id = ? AND operation.id = ?
  AND operation.type = 'provision-node' AND operation.resource_type = 'node'
  AND operation.resource_id = ?`

const auditOperationId = (operationId: string, kind: string) => `${operationId}-audit-${kind}`
const auditIdempotencyKey = (operationId: string, kind: string) =>
  `node-provision-audit-${kind}:${operationId}`

const machineAuditRequest = (
  authority: NodeProvisionAuditAuthority,
  operationId: string,
): AuditRequestContextValue => ({
  origin: 'machine',
  requestId: `node-provision-workflow-${operationId}`,
  correlationId: authority.correlationId,
  source: {
    ip: { state: 'not-available', reason: 'provider Workflow has no client IP' },
    access: { state: 'not-available', reason: 'provider Workflow has no Access assertion' },
  },
})

const readAuditAuthority = (
  database: NodeProvisionExecutionD1Database,
  input: { readonly organizationId: string; readonly operationId: string; readonly nodeId: string },
): Effect.Effect<NodeProvisionAuditAuthority, NodeProvisionExecutionPersistenceError> =>
  Effect.gen(function* () {
    const value = yield* attempt('node-provision-execution.audit-authority.read', () =>
      database
        .prepare(auditAuthoritySql)
        .bind(input.organizationId, input.operationId, input.nodeId)
        .first(),
    )
    const authority = row(value)
    const actorId = authority === undefined ? undefined : string(authority.actorId)
    const correlationId = authority === undefined ? undefined : string(authority.correlationId)
    const encoded = authority === undefined ? undefined : string(authority.auditRequestContext)
    if (actorId === undefined || correlationId === undefined || encoded === undefined)
      return yield* persistence('node-provision-execution.audit-authority.missing')
    const request = yield* Effect.try({
      try: () => JSON.parse(encoded) as unknown,
      catch: () => undefined,
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(AuditRequestContextValue, { onExcessProperty: 'error' })(value),
      ),
      Effect.mapError(() => persistence('node-provision-execution.audit-authority.decode')),
    )
    if (request.correlationId !== correlationId)
      return yield* persistence('node-provision-execution.audit-authority.correlation')
    return { actorId, correlationId, request }
  })

const terminalAuditOperation = (
  database: NodeProvisionExecutionD1Database,
  input: {
    readonly organizationId: string
    readonly parentOperationId: string
    readonly nodeId: string
    readonly authority: NodeProvisionAuditAuthority
    readonly kind: string
    readonly type: string
    readonly status: 'succeeded' | 'failed_terminal'
    readonly now: string
  },
) =>
  database
    .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, 'node', ?, ?, ?, 100, ?, ?, 1, ?, ?)`)
    .bind(
      auditOperationId(input.parentOperationId, input.kind),
      input.organizationId,
      input.type,
      input.nodeId,
      input.authority.actorId,
      input.status,
      auditIdempotencyKey(input.parentOperationId, input.kind),
      input.authority.correlationId,
      input.now,
      input.now,
    )

const stageNodeProvisionAudit = (
  database: NodeProvisionExecutionD1Database,
  input: {
    readonly eventId: string
    readonly organizationId: string
    readonly parentOperationId: string
    readonly nodeId: string
    readonly kind: string
    readonly action: string
    readonly authority: NodeProvisionAuditAuthority
    readonly request: AuditRequestContextValue
    readonly before: NodeProvisionAuditState
    readonly after: NodeProvisionAuditState
    readonly result: 'succeeded' | 'failed'
    /** A safe, domain-specific provider failure class when the result failed. */
    readonly errorCode?: string
    readonly now: string
  },
): Effect.Effect<StagedNodeProvisionAudit, NodeProvisionExecutionPersistenceError> =>
  Effect.gen(function* () {
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.organizationId,
      actor: { type: 'human', id: input.authority.actorId },
      action: input.action,
      target: { type: 'node', id: input.nodeId },
      before: input.before,
      after: input.after,
      operationId: auditOperationId(input.parentOperationId, input.kind),
      result: input.result,
      error:
        input.result === 'succeeded'
          ? { classification: 'none' as const, code: null }
          : {
              classification: 'provider' as const,
              code: input.errorCode ?? 'provider-operation-failed',
            },
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.provideService(AuditRequestContext, input.request),
      Effect.mapError(() => persistence('node-provision-execution.audit-envelope')),
    )
    const stage = yield* stageAuditEnvelope('tenant', input.eventId, envelope, input.now).pipe(
      Effect.mapError(() => persistence('node-provision-execution.audit-stage')),
    )
    return {
      statement: database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const completionSql = `SELECT
 node.organization_id AS organizationId,
 node.id AS nodeId,
 operation.id AS operationId,
 node.provider_instance_id AS providerInstanceId,
 json_extract(event.payload_json, '$.providerState') AS providerState,
 json_extract(event.payload_json, '$.state') AS state
FROM nodes node
JOIN operations operation
  ON operation.organization_id = node.organization_id
 AND operation.id = node.pending_lifecycle_operation_id
 AND operation.type = 'provision-node'
 AND operation.resource_type = 'node'
 AND operation.resource_id = node.id
 AND operation.status IN ('waiting_external', 'succeeded')
JOIN node_provision_acceptances acceptance
  ON acceptance.organization_id = node.organization_id
 AND acceptance.node_id = node.id
 AND acceptance.operation_id = operation.id
JOIN node_bootstrap_token_reservations bootstrap
  ON bootstrap.organization_id = node.organization_id
 AND bootstrap.token_record_id = acceptance.bootstrap_token_record_id
 AND bootstrap.node_id = node.id
 AND bootstrap.operation_id = operation.id
 AND bootstrap.state = 'materialized'
JOIN node_registration_tokens registration
  ON registration.organization_id = node.organization_id
 AND registration.node_id = node.id
 AND registration.operation_id = operation.id
 AND registration.provider_instance_id = node.provider_instance_id
 AND registration.token_hash = bootstrap.token_hash
 AND registration.expires_at = bootstrap.expires_at
JOIN node_provision_execution_leases lease
  ON lease.organization_id = node.organization_id
 AND lease.operation_id = operation.id
 AND lease.node_id = node.id
 AND lease.provider_account_id = acceptance.provider_account_id
 AND lease.provider_account_revision = acceptance.provider_account_revision
 AND lease.provider_type = acceptance.provider_type
 AND lease.delivered_token_hash = bootstrap.token_hash
 AND lease.bootstrap_expires_at = bootstrap.expires_at
 AND lease.state = 'released'
JOIN outbox event
  ON event.organization_id = node.organization_id
 AND event.id = 'outbox_node_provider:' || operation.id
 AND event.event_type = 'node.provision.provider-created'
 AND event.aggregate_type = 'node'
 AND event.aggregate_id = node.id
WHERE node.organization_id = ? AND operation.id = ?
  AND node.provider_instance_id IS NOT NULL
  AND node.desired_state = 'provisioning'
  AND node.observed_state = 'provisioning'
  AND node.observed_revision = 0
  AND json_extract(event.payload_json, '$.schemaVersion') = 1
  AND json_extract(event.payload_json, '$.organizationId') = node.organization_id
  AND json_extract(event.payload_json, '$.nodeId') = node.id
  AND json_extract(event.payload_json, '$.operationId') = operation.id
  AND json_extract(event.payload_json, '$.providerInstanceId') = node.provider_instance_id
  AND json_extract(event.payload_json, '$.providerType') = acceptance.provider_type
  AND json_extract(event.payload_json, '$.providerAccountId') = acceptance.provider_account_id
  AND json_extract(event.payload_json, '$.providerAccountRevision') = acceptance.provider_account_revision
  AND json_extract(event.payload_json, '$.envelopeRevision') = lease.envelope_revision
  AND json_extract(event.payload_json, '$.imageId') = acceptance.image_id
  AND json_extract(event.payload_json, '$.imageVersion') = acceptance.image_version
  AND json_extract(event.payload_json, '$.imageChecksum') = acceptance.image_checksum
  AND (
    COALESCE(json_extract(event.payload_json, '$.playerEndpointEvidence'), 'absent') <> 'captured'
    OR (
      json_array_length(json_extract(event.payload_json, '$.playerEndpoints')) BETWEEN 1 AND 2
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(event.payload_json, '$.playerEndpoints')) expected
        WHERE NOT EXISTS (
          SELECT 1 FROM node_player_endpoints endpoint
          WHERE endpoint.organization_id = node.organization_id AND endpoint.node_id = node.id
            AND endpoint.provider_instance_id = node.provider_instance_id
            AND endpoint.record_type = json_extract(expected.value, '$.recordType')
            AND endpoint.target = json_extract(expected.value, '$.target')
            AND endpoint.source = 'provider' AND endpoint.observed_revision = 1
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM node_player_endpoints endpoint
        WHERE endpoint.organization_id = node.organization_id AND endpoint.node_id = node.id
          AND endpoint.provider_instance_id = node.provider_instance_id
          AND NOT EXISTS (
            SELECT 1 FROM json_each(json_extract(event.payload_json, '$.playerEndpoints')) expected
            WHERE endpoint.record_type = json_extract(expected.value, '$.recordType')
              AND endpoint.target = json_extract(expected.value, '$.target')
          )
      )
    )
  )`

const probeSql = `SELECT node.provider_instance_id AS providerInstanceId,
 operation.status, bootstrap.state AS bootstrapState,
 lease.state AS leaseState, binding.state AS bindingState
FROM operations operation
JOIN nodes node ON node.organization_id = operation.organization_id
 AND node.id = operation.resource_id
LEFT JOIN node_bootstrap_token_reservations bootstrap
 ON bootstrap.organization_id = operation.organization_id
 AND bootstrap.operation_id = operation.id
LEFT JOIN node_provision_execution_leases lease
 ON lease.organization_id = operation.organization_id
 AND lease.operation_id = operation.id AND lease.node_id = node.id
LEFT JOIN node_provision_registration_bindings binding
 ON binding.organization_id = operation.organization_id
 AND binding.operation_id = operation.id AND binding.node_id = node.id
WHERE operation.organization_id = ? AND operation.id = ?
 AND operation.type = 'provision-node' AND operation.resource_type = 'node'`

const operationSql = `SELECT operation.status, operation.revision,
 operation.resource_id AS resourceId
FROM operations operation
JOIN node_provision_acceptances acceptance
 ON acceptance.organization_id = operation.organization_id
 AND acceptance.operation_id = operation.id
JOIN nodes node
 ON node.organization_id = operation.organization_id
 AND node.id = operation.resource_id
 AND node.id = acceptance.node_id
 AND node.pending_lifecycle_operation_id = operation.id
WHERE operation.organization_id = ? AND operation.id = ?
 AND operation.type = 'provision-node' AND operation.resource_type = 'node'`

const leaseSql = `SELECT provider_account_id AS providerAccountId,
 provider_account_revision AS providerAccountRevision, provider_type AS providerType,
 envelope_revision AS envelopeRevision, derivation_token_hash AS derivationTokenHash,
 delivered_token_hash AS deliveredTokenHash, bootstrap_expires_at AS bootstrapExpiresAt, state
FROM node_provision_execution_leases
WHERE organization_id = ? AND operation_id = ? AND node_id = ?`

const preparationSql = `SELECT lease.organization_id AS organizationId,
 lease.node_id AS nodeId, lease.operation_id AS operationId,
 lease.provider_account_id AS providerAccountId,
 lease.provider_account_revision AS providerAccountRevision,
 lease.provider_type AS providerType, lease.envelope_revision AS envelopeRevision,
 lease.derivation_token_hash AS derivationTokenHash,
 lease.delivered_token_hash AS deliveredTokenHash,
 lease.bootstrap_expires_at AS bootstrapExpiresAt, lease.state
FROM node_provision_execution_leases lease
JOIN node_bootstrap_token_reservations bootstrap
 ON bootstrap.organization_id = lease.organization_id
 AND bootstrap.operation_id = lease.operation_id AND bootstrap.node_id = lease.node_id
 AND bootstrap.token_hash = lease.delivered_token_hash
 AND bootstrap.expires_at = lease.bootstrap_expires_at AND bootstrap.state = 'materialized'
JOIN node_provision_registration_bindings binding
 ON binding.organization_id = lease.organization_id AND binding.operation_id = lease.operation_id
 AND binding.node_id = lease.node_id AND binding.provider_type = lease.provider_type
 AND binding.delivered_token_hash = lease.delivered_token_hash
 AND binding.expires_at = lease.bootstrap_expires_at
 AND binding.state IN ('materialized', 'bound')
WHERE lease.organization_id = ? AND lease.operation_id = ? AND lease.state = 'active'`

const registrationBindingSql = `SELECT binding.provider_instance_id AS providerInstanceId,
 binding.state, binding.delivered_token_hash AS deliveredTokenHash,
 binding.expires_at AS expiresAt,
 CASE WHEN registration.token_hash IS NULL THEN 0 ELSE 1 END AS registrationExists
FROM node_provision_registration_bindings binding
LEFT JOIN node_registration_tokens registration
 ON registration.organization_id = binding.organization_id
 AND registration.operation_id = binding.operation_id AND registration.node_id = binding.node_id
 AND registration.token_hash = binding.delivered_token_hash
 AND registration.provider_instance_id = binding.provider_instance_id
WHERE binding.organization_id = ? AND binding.operation_id = ? AND binding.node_id = ?`

const decodeCompletion = (
  value: unknown,
  disposition: 'completed' | 'adopted',
): Effect.Effect<NodeProvisionExecutionResult, NodeProvisionExecutionPersistenceError> => {
  const record = row(value)
  return record === undefined
    ? Effect.fail(persistence('node-provision-execution.completion.decode'))
    : Schema.decodeUnknownEffect(NodeProvisionExecutionResultContract, {
        onExcessProperty: 'error',
      })({
        disposition,
        organizationId: record.organizationId,
        nodeId: record.nodeId,
        operationId: record.operationId,
        providerInstanceId: record.providerInstanceId,
        providerState: record.providerState,
        state: record.state,
      }).pipe(Effect.mapError(() => persistence('node-provision-execution.completion.decode')))
}

const decodePreparation = (
  value: unknown,
): Effect.Effect<NodeProvisionExecutionPreparation, NodeProvisionExecutionPersistenceError> => {
  const record = row(value)
  const preparation =
    record === undefined
      ? undefined
      : {
          organizationId: string(record.organizationId),
          nodeId: string(record.nodeId),
          operationId: string(record.operationId),
          providerAccountId: string(record.providerAccountId),
          providerAccountRevision: integer(record.providerAccountRevision),
          providerType: string(record.providerType),
          envelopeRevision: integer(record.envelopeRevision),
          derivationTokenHash: string(record.derivationTokenHash),
          deliveredTokenHash: string(record.deliveredTokenHash),
          bootstrapExpiresAt: string(record.bootstrapExpiresAt),
          state: string(record.state),
        }
  if (
    preparation?.organizationId === undefined ||
    preparation.nodeId === undefined ||
    preparation.operationId === undefined ||
    preparation.providerAccountId === undefined ||
    preparation.providerAccountRevision === undefined ||
    (preparation.providerType !== 'ovhcloud' && preparation.providerType !== 'contabo') ||
    preparation.envelopeRevision === undefined ||
    preparation.derivationTokenHash === undefined ||
    !/^[a-f0-9]{64}$/.test(preparation.derivationTokenHash) ||
    preparation.deliveredTokenHash === undefined ||
    !/^[a-f0-9]{64}$/.test(preparation.deliveredTokenHash) ||
    preparation.bootstrapExpiresAt === undefined ||
    !Number.isFinite(Date.parse(preparation.bootstrapExpiresAt)) ||
    preparation.state !== 'active'
  )
    return Effect.fail(persistence('node-provision-execution.preparation.decode'))
  return Effect.succeed(preparation as NodeProvisionExecutionPreparation)
}

const validateCompletionInput = (
  input: NodeProvisionExecutionCompletionInput,
): Effect.Effect<void, NodeProvisionExecutionConflictError> => {
  const { reservation, account, providerNode } = input
  if (
    !/^[a-f0-9]{64}$/.test(input.deliveredTokenHash) ||
    !Number.isFinite(Date.parse(input.completedAt)) ||
    !Number.isSafeInteger(input.envelopeRevision) ||
    input.envelopeRevision < 1 ||
    account.id !== reservation.providerAccountId ||
    account.providerType !== reservation.providerType ||
    account.revision !== reservation.providerAccountRevision ||
    !(
      (account.scope === 'organization' && account.organizationId === reservation.organizationId) ||
      (account.scope === 'platform' && account.organizationId === null)
    ) ||
    providerNode.id.length === 0 ||
    providerNode.metadata.managedBy !== 'gridora' ||
    providerNode.metadata.organizationId !== reservation.organizationId ||
    providerNode.metadata.nodeId !== reservation.nodeId ||
    providerNode.metadata.operationId !== reservation.operationId ||
    providerNode.metadata.imageVersion !== reservation.imageVersion ||
    providerNode.regionId !== reservation.region ||
    providerNode.planId !== reservation.plan
  )
    return Effect.fail(conflict('node-provision-execution.completion.fence'))
  return Effect.void
}

const completionResult = (
  input: NodeProvisionExecutionCompletionInput,
  disposition: 'completed' | 'adopted',
): NodeProvisionExecutionResult => ({
  disposition,
  organizationId: input.reservation.organizationId,
  nodeId: input.reservation.nodeId,
  operationId: input.reservation.operationId,
  providerInstanceId: input.providerNode.id,
  providerState: input.providerNode.state,
  state: 'waiting-for-agent',
})

export const makeNodeProvisionExecutionRepositoryD1 = (
  database: NodeProvisionExecutionD1Database,
): NodeProvisionExecutionRepositoryShape => {
  const findCompletion: NodeProvisionExecutionRepositoryShape['findCompletion'] = (
    organizationId,
    operationId,
  ) =>
    Effect.gen(function* () {
      const value = yield* attempt('node-provision-execution.completion.read', () =>
        database.prepare(completionSql).bind(organizationId, operationId).first(),
      )
      if (value !== null && value !== undefined) return yield* decodeCompletion(value, 'adopted')
      const probe = yield* attempt('node-provision-execution.completion.probe', () =>
        database.prepare(probeSql).bind(organizationId, operationId).first(),
      )
      const existing = row(probe)
      const prepared =
        existing !== undefined &&
        string(existing.bootstrapState) === 'materialized' &&
        string(existing.leaseState) === 'active' &&
        (string(existing.bindingState) === 'materialized' ||
          string(existing.bindingState) === 'bound') &&
        (string(existing.status) === 'running' || string(existing.status) === 'retrying')
      if (
        existing !== undefined &&
        ((string(existing.providerInstanceId) !== undefined && !prepared) ||
          (string(existing.bootstrapState) === 'materialized' && !prepared) ||
          string(existing.status) === 'waiting_external' ||
          string(existing.status) === 'succeeded')
      )
        return yield* persistence('node-provision-execution.completion.invariant')
      return null
    })

  const findPreparation: NodeProvisionExecutionRepositoryShape['findPreparation'] = (
    organizationId,
    operationId,
  ) =>
    Effect.gen(function* () {
      const value = yield* attempt('node-provision-execution.preparation.read', () =>
        database.prepare(preparationSql).bind(organizationId, operationId).first(),
      )
      return value === null || value === undefined ? null : yield* decodePreparation(value)
    })

  const beginAttempt: NodeProvisionExecutionRepositoryShape['beginAttempt'] = (input) =>
    Effect.gen(function* () {
      const {
        reservation,
        account,
        envelopeRevision,
        derivationTokenHash,
        deliveredTokenHash,
        bootstrapExpiresAt,
        attemptedAt,
      } = input
      if (
        account.id !== reservation.providerAccountId ||
        account.providerType !== reservation.providerType ||
        account.revision !== reservation.providerAccountRevision ||
        !Number.isSafeInteger(envelopeRevision) ||
        envelopeRevision < 1 ||
        !/^[a-f0-9]{64}$/.test(derivationTokenHash) ||
        !/^[a-f0-9]{64}$/.test(deliveredTokenHash) ||
        !Number.isFinite(Date.parse(bootstrapExpiresAt)) ||
        Date.parse(bootstrapExpiresAt) <= Date.parse(attemptedAt) ||
        !(
          (account.scope === 'organization' &&
            account.organizationId === reservation.organizationId) ||
          (account.scope === 'platform' && account.organizationId === null)
        )
      )
        return yield* conflict('node-provision-execution.attempt.account-fence')
      // Do this before the provider call is reachable. Historic acceptances
      // without immutable provenance must not trigger a paid create request.
      yield* readAuditAuthority(database, reservation)
      const value = yield* attempt('node-provision-execution.attempt.read', () =>
        database
          .prepare(operationSql)
          .bind(reservation.organizationId, reservation.operationId)
          .first(),
      )
      const operation = row(value)
      const status = operation === undefined ? undefined : string(operation.status)
      const revision = operation === undefined ? undefined : integer(operation.revision)
      const resourceId = operation === undefined ? undefined : string(operation.resourceId)
      if (revision === undefined || resourceId !== reservation.nodeId || status === undefined)
        return yield* conflict('node-provision-execution.attempt.not-found')
      const existingLease = yield* attempt('node-provision-execution.lease.read', () =>
        database
          .prepare(leaseSql)
          .bind(reservation.organizationId, reservation.operationId, reservation.nodeId)
          .first(),
      )
      const lease = row(existingLease)
      const leaseMatches =
        lease !== undefined &&
        string(lease.providerAccountId) === reservation.providerAccountId &&
        integer(lease.providerAccountRevision) === reservation.providerAccountRevision &&
        string(lease.providerType) === reservation.providerType &&
        integer(lease.envelopeRevision) === envelopeRevision &&
        string(lease.derivationTokenHash) === derivationTokenHash &&
        string(lease.deliveredTokenHash) === deliveredTokenHash &&
        string(lease.bootstrapExpiresAt) === bootstrapExpiresAt &&
        string(lease.state) === 'active'
      if (status === 'running' || status === 'waiting_external') {
        if (!leaseMatches) return yield* conflict('node-provision-execution.lease.missing')
        return { mode: 'adopt_only' as const, attemptNumber: revision }
      }
      if (status !== 'queued' && status !== 'retrying')
        return yield* conflict('node-provision-execution.attempt.terminal')
      if (status === 'retrying' && !leaseMatches)
        return yield* conflict('node-provision-execution.lease.missing')
      if (status === 'queued' && lease !== undefined)
        return yield* conflict('node-provision-execution.lease.unexpected')
      if (
        (status === 'queued' &&
          (reservation.bootstrapToken.state !== 'reserved' ||
            reservation.bootstrapToken.tokenHash !== derivationTokenHash)) ||
        (status === 'retrying' &&
          (reservation.bootstrapToken.state !== 'materialized' ||
            reservation.bootstrapToken.tokenHash !== deliveredTokenHash ||
            reservation.bootstrapToken.expiresAt !== bootstrapExpiresAt))
      )
        return yield* conflict('node-provision-execution.attempt.bootstrap-fence')
      const update = database
        .prepare(`UPDATE operations SET status = 'running', progress = max(progress, 20),
            revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ? AND resource_type = 'node'
              AND resource_id = ? AND status = ? AND revision = ?`)
        .bind(
          attemptedAt,
          reservation.organizationId,
          reservation.operationId,
          reservation.nodeId,
          status,
          revision,
        )
      const statements =
        status === 'queued'
          ? [
              update,
              database
                .prepare(`UPDATE node_bootstrap_token_reservations
                  SET token_hash = ?, state = 'materialized', expires_at = ?, updated_at = ?
                  WHERE organization_id = ? AND token_record_id = ? AND node_id = ?
                    AND operation_id = ? AND key_version = ? AND token_hash = ?
                    AND state = 'reserved'`)
                .bind(
                  deliveredTokenHash,
                  bootstrapExpiresAt,
                  attemptedAt,
                  reservation.organizationId,
                  reservation.bootstrapToken.recordId,
                  reservation.nodeId,
                  reservation.operationId,
                  reservation.bootstrapToken.keyVersion,
                  derivationTokenHash,
                ),
              database
                .prepare(`INSERT INTO node_provision_execution_leases
                  (organization_id, operation_id, node_id, provider_account_id,
                   provider_account_revision, provider_type, envelope_revision,
                   derivation_token_hash, delivered_token_hash, bootstrap_expires_at,
                   state, acquired_at, released_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`)
                .bind(
                  reservation.organizationId,
                  reservation.operationId,
                  reservation.nodeId,
                  reservation.providerAccountId,
                  reservation.providerAccountRevision,
                  reservation.providerType,
                  envelopeRevision,
                  derivationTokenHash,
                  deliveredTokenHash,
                  bootstrapExpiresAt,
                  attemptedAt,
                ),
              database
                .prepare(`INSERT INTO node_provision_registration_bindings
                  (organization_id, operation_id, node_id, provider_type, delivered_token_hash,
                   provider_instance_id, state, issued_at, expires_at, bound_at)
                  VALUES (?, ?, ?, ?, ?, NULL, 'materialized', ?, ?, NULL)`)
                .bind(
                  reservation.organizationId,
                  reservation.operationId,
                  reservation.nodeId,
                  reservation.providerType,
                  deliveredTokenHash,
                  attemptedAt,
                  bootstrapExpiresAt,
                ),
            ]
          : [update]
      const result = yield* Effect.result(
        attempt('node-provision-execution.attempt.claim', () => database.batch(statements)),
      )
      if (
        result._tag === 'Success' &&
        result.success.length === statements.length &&
        result.success.every(one)
      )
        return {
          mode: status === 'queued' ? ('create_or_adopt' as const) : ('adopt_only' as const),
          attemptNumber: revision + 1,
        }
      const raced = yield* attempt('node-provision-execution.attempt.race-read', () =>
        database
          .prepare(operationSql)
          .bind(reservation.organizationId, reservation.operationId)
          .first(),
      )
      const racedRow = row(raced)
      const racedStatus = racedRow === undefined ? undefined : string(racedRow.status)
      const racedRevision = racedRow === undefined ? undefined : integer(racedRow.revision)
      const racedLease = yield* attempt('node-provision-execution.lease.race-read', () =>
        database
          .prepare(leaseSql)
          .bind(reservation.organizationId, reservation.operationId, reservation.nodeId)
          .first(),
      )
      const racedLeaseRow = row(racedLease)
      if (
        racedStatus === 'running' &&
        racedRevision !== undefined &&
        racedLeaseRow !== undefined &&
        string(racedLeaseRow.providerAccountId) === reservation.providerAccountId &&
        integer(racedLeaseRow.providerAccountRevision) === reservation.providerAccountRevision &&
        integer(racedLeaseRow.envelopeRevision) === envelopeRevision &&
        string(racedLeaseRow.derivationTokenHash) === derivationTokenHash &&
        string(racedLeaseRow.deliveredTokenHash) === deliveredTokenHash &&
        string(racedLeaseRow.bootstrapExpiresAt) === bootstrapExpiresAt &&
        string(racedLeaseRow.state) === 'active'
      )
        return { mode: 'adopt_only' as const, attemptNumber: racedRevision }
      return yield* conflict('node-provision-execution.attempt.race')
    })

  const completeAtomic: NodeProvisionExecutionRepositoryShape['completeAtomic'] = (input) =>
    Effect.gen(function* () {
      yield* validateCompletionInput(input)
      const prior = yield* findCompletion(
        input.reservation.organizationId,
        input.reservation.operationId,
      )
      if (prior !== null) {
        if (prior.providerInstanceId !== input.providerNode.id)
          return yield* conflict('node-provision-execution.completion.provider-mismatch')
        return prior
      }
      const reservation = input.reservation
      const endpointEvidence = playerEndpointEvidence(input.providerNode.addresses)
      const authority = yield* readAuditAuthority(database, reservation)
      const bindingValue = yield* attempt(
        'node-provision-execution.registration-binding.read',
        () =>
          database
            .prepare(registrationBindingSql)
            .bind(reservation.organizationId, reservation.operationId, reservation.nodeId)
            .first(),
      )
      const binding = row(bindingValue)
      const bindingState = binding === undefined ? undefined : string(binding.state)
      const boundProviderInstanceId =
        binding?.providerInstanceId === null ? null : string(binding?.providerInstanceId)
      const bindingTokenHash =
        binding === undefined ? undefined : string(binding.deliveredTokenHash)
      const bindingExpiresAt = binding === undefined ? undefined : string(binding.expiresAt)
      const registrationExists =
        binding === undefined ? undefined : integer(binding.registrationExists)
      if (
        binding === undefined ||
        bindingTokenHash !== input.deliveredTokenHash ||
        bindingExpiresAt === undefined ||
        (bindingState === 'materialized' &&
          (boundProviderInstanceId !== null || registrationExists !== 0)) ||
        (bindingState === 'bound' &&
          (boundProviderInstanceId !== input.providerNode.id || registrationExists !== 1)) ||
        (bindingState !== 'materialized' && bindingState !== 'bound')
      )
        return yield* conflict('node-provision-execution.registration-binding.mismatch')
      const needsProviderBinding = bindingState === 'materialized'
      const auditId = `audit_node_provider:${reservation.operationId}`
      const outboxId = `outbox_node_provider:${reservation.operationId}`
      const auditAfter = {
        schemaVersion: 1,
        providerType: reservation.providerType,
        providerAccountId: reservation.providerAccountId,
        providerAccountRevision: reservation.providerAccountRevision,
        envelopeRevision: input.envelopeRevision,
        providerInstanceId: input.providerNode.id,
        providerState: input.providerNode.state,
        imageVersion: reservation.imageVersion,
        imageChecksum: reservation.imageChecksum,
        playerEndpointEvidence: endpointEvidence.state,
        playerEndpointReason: endpointEvidence.state === 'absent' ? endpointEvidence.reason : null,
        playerEndpoints: endpointEvidence.state === 'captured' ? endpointEvidence.endpoints : [],
        outcome: 'waiting-for-agent',
      }
      const audit = yield* stageNodeProvisionAudit(database, {
        eventId: auditId,
        organizationId: reservation.organizationId,
        parentOperationId: reservation.operationId,
        nodeId: reservation.nodeId,
        kind: 'provider-created',
        action: 'node.provision.provider-created',
        authority,
        request: machineAuditRequest(authority, reservation.operationId),
        before: { state: 'absent', reason: 'provider creation receipt was not committed' },
        after: { state: 'captured', summary: auditAfter },
        result: 'succeeded',
        now: input.completedAt,
      })
      const eventPayload = JSON.stringify({
        schemaVersion: 1,
        organizationId: reservation.organizationId,
        partitionKey: `${reservation.organizationId}:node:${reservation.nodeId}`,
        nodeId: reservation.nodeId,
        operationId: reservation.operationId,
        providerType: reservation.providerType,
        providerAccountId: reservation.providerAccountId,
        providerAccountRevision: reservation.providerAccountRevision,
        envelopeRevision: input.envelopeRevision,
        providerInstanceId: input.providerNode.id,
        providerState: input.providerNode.state,
        region: reservation.region,
        plan: reservation.plan,
        imageId: reservation.imageId,
        imageVersion: reservation.imageVersion,
        imageChecksum: reservation.imageChecksum,
        playerEndpointEvidence: endpointEvidence.state,
        playerEndpointReason: endpointEvidence.state === 'absent' ? endpointEvidence.reason : null,
        playerEndpoints: endpointEvidence.state === 'captured' ? endpointEvidence.endpoints : [],
        state: 'waiting-for-agent',
      })
      const providerBindingStatements = needsProviderBinding
        ? [
            database
              .prepare(`INSERT INTO node_registration_tokens
                (token_hash, organization_id, node_id, provider_instance_id, operation_id,
                 credential_id, expires_at, consumed_at, revoked_at, issued_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`)
              .bind(
                input.deliveredTokenHash,
                reservation.organizationId,
                reservation.nodeId,
                input.providerNode.id,
                reservation.operationId,
                bindingExpiresAt,
                input.completedAt,
              ),
            database
              .prepare(`UPDATE node_provision_registration_bindings
                SET provider_instance_id = ?, state = 'bound', bound_at = ?
                WHERE organization_id = ? AND operation_id = ? AND node_id = ?
                  AND delivered_token_hash = ? AND provider_instance_id IS NULL
                  AND state = 'materialized'`)
              .bind(
                input.providerNode.id,
                input.completedAt,
                reservation.organizationId,
                reservation.operationId,
                reservation.nodeId,
                input.deliveredTokenHash,
              ),
          ]
        : []
      const endpointStatements =
        endpointEvidence.state === 'captured'
          ? endpointEvidence.endpoints.map((endpoint) =>
              database
                .prepare(`INSERT INTO node_player_endpoints
                  (organization_id, node_id, provider_instance_id, record_type, target, source,
                   observed_revision, revision, observed_at, created_at, updated_at)
                  SELECT ?, ?, ?, ?, ?, 'provider', 1, 1, ?, ?, ?
                  FROM nodes node
                  JOIN operations operation
                    ON operation.organization_id = node.organization_id
                   AND operation.id = node.pending_lifecycle_operation_id
                  WHERE node.organization_id = ? AND node.id = ?
                    AND node.provider_instance_id = ? AND node.pending_lifecycle_operation_id = ?
                    AND operation.type = 'provision-node' AND operation.resource_type = 'node'
                    AND operation.status = 'waiting_external'`)
                .bind(
                  reservation.organizationId,
                  reservation.nodeId,
                  input.providerNode.id,
                  endpoint.recordType,
                  endpoint.target,
                  input.completedAt,
                  input.completedAt,
                  input.completedAt,
                  reservation.organizationId,
                  reservation.nodeId,
                  input.providerNode.id,
                  reservation.operationId,
                ),
            )
          : []
      const statements = [
        database
          .prepare(`UPDATE nodes SET provider_instance_id = ?, observed_state = 'provisioning',
            reconciliation_error = NULL, updated_at = ?
            WHERE organization_id = ? AND id = ?
              AND (provider_instance_id IS NULL OR provider_instance_id = ?)
              AND provider_account_id = ? AND provider_type = ? AND region = ? AND plan = ?
              AND image_id = ? AND placement_mode = ? AND desired_state = 'provisioning'
              AND observed_state IN ('unknown', 'provisioning') AND observed_revision = 0
              AND pending_lifecycle_operation_id = ?`)
          .bind(
            input.providerNode.id,
            input.completedAt,
            reservation.organizationId,
            reservation.nodeId,
            input.providerNode.id,
            reservation.providerAccountId,
            reservation.providerType,
            reservation.region,
            reservation.plan,
            reservation.imageId,
            reservation.placementMode,
            reservation.operationId,
          ),
        ...providerBindingStatements,
        database
          .prepare(`UPDATE operations SET status = 'waiting_external', progress = 50,
            revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ? AND type = 'provision-node'
              AND resource_type = 'node' AND resource_id = ? AND status = 'running'`)
          .bind(
            input.completedAt,
            reservation.organizationId,
            reservation.operationId,
            reservation.nodeId,
          ),
        ...endpointStatements,
        terminalAuditOperation(database, {
          organizationId: reservation.organizationId,
          parentOperationId: reservation.operationId,
          nodeId: reservation.nodeId,
          authority,
          kind: 'provider-created',
          type: 'node.provision.provider-created',
          status: 'succeeded',
          now: input.completedAt,
        }),
        audit.statement,
        database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, operation.organization_id, operation.actor_id,
             'node.provision.provider-created', 'node', operation.resource_id, 'succeeded',
             operation.correlation_id, ?, ?
            FROM operations operation
            JOIN node_provision_execution_leases lease
              ON lease.organization_id = operation.organization_id
             AND lease.operation_id = operation.id AND lease.node_id = operation.resource_id
             AND lease.provider_account_id = ? AND lease.provider_type = ?
             AND lease.provider_account_revision = ? AND lease.envelope_revision = ?
             AND lease.state = 'active'
            JOIN node_provision_contracts contract
              ON contract.organization_id = operation.organization_id
             AND contract.operation_id = operation.id AND contract.node_id = operation.resource_id
             AND contract.provider_type = ? AND contract.currency = ?
             AND contract.estimated_monthly_minor = ? AND contract.billing_cadence = ?
             AND contract.contract_months = ?
             AND contract.non_hourly_commitment_confirmed = ?
             AND contract.catalog_refreshed_at = ?
            WHERE operation.organization_id = ? AND operation.id = ?
              AND operation.resource_id = ? AND operation.status = 'waiting_external'`)
          .bind(
            auditId,
            audit.summaryJson,
            input.completedAt,
            reservation.providerAccountId,
            reservation.providerType,
            reservation.providerAccountRevision,
            input.envelopeRevision,
            reservation.providerType,
            reservation.billing.currency,
            reservation.billing.estimatedMonthlyMinor,
            reservation.billing.billingCadence,
            reservation.billing.contractMonths,
            reservation.billing.nonHourlyCommitmentConfirmed ? 1 : 0,
            reservation.billing.catalogRefreshedAt,
            reservation.organizationId,
            reservation.operationId,
            reservation.nodeId,
          ),
        database
          .prepare(`UPDATE node_provision_execution_leases
            SET state = 'released', released_at = ?
            WHERE organization_id = ? AND operation_id = ? AND node_id = ?
              AND provider_account_id = ? AND provider_account_revision = ?
              AND provider_type = ? AND envelope_revision = ? AND state = 'active'`)
          .bind(
            input.completedAt,
            reservation.organizationId,
            reservation.operationId,
            reservation.nodeId,
            reservation.providerAccountId,
            reservation.providerAccountRevision,
            reservation.providerType,
            input.envelopeRevision,
          ),
        database
          .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, lease_owner, lease_token, lease_until,
             created_at, delivered_at)
            VALUES (?, ?, 'node.provision.provider-created', 'node',
             (SELECT node.id
              FROM nodes node
              JOIN operations operation
                ON operation.organization_id = node.organization_id
               AND operation.id = node.pending_lifecycle_operation_id
               AND operation.status = 'waiting_external' AND operation.progress = 50
              JOIN node_provision_execution_leases lease
                ON lease.organization_id = operation.organization_id
               AND lease.operation_id = operation.id AND lease.node_id = node.id
               AND lease.state = 'released' AND lease.released_at = ?
              JOIN node_bootstrap_token_reservations bootstrap
                ON bootstrap.organization_id = operation.organization_id
               AND bootstrap.operation_id = operation.id AND bootstrap.node_id = node.id
               AND bootstrap.token_hash = ? AND bootstrap.state = 'materialized'
              JOIN node_provision_registration_bindings binding
                ON binding.organization_id = operation.organization_id
               AND binding.operation_id = operation.id AND binding.node_id = node.id
               AND binding.provider_instance_id = node.provider_instance_id
               AND binding.delivered_token_hash = bootstrap.token_hash
               AND binding.state = 'bound' AND binding.expires_at = bootstrap.expires_at
              JOIN node_registration_tokens registration
                ON registration.organization_id = operation.organization_id
               AND registration.operation_id = operation.id AND registration.node_id = node.id
               AND registration.provider_instance_id = node.provider_instance_id
               AND registration.token_hash = bootstrap.token_hash
               AND registration.expires_at = bootstrap.expires_at
              JOIN audit_events audit
                ON audit.organization_id = operation.organization_id AND audit.id = ?
               AND audit.action = 'node.provision.provider-created'
               AND audit.target_type = 'node' AND audit.target_id = node.id
              WHERE node.organization_id = ? AND node.id = ?
                AND node.provider_instance_id = ? AND node.observed_state = 'provisioning'
                AND node.observed_revision = 0),
             ?, 'pending', 0, ?, NULL, NULL, NULL, ?, NULL)`)
          .bind(
            outboxId,
            reservation.organizationId,
            input.completedAt,
            input.deliveredTokenHash,
            auditId,
            reservation.organizationId,
            reservation.nodeId,
            input.providerNode.id,
            eventPayload,
            input.completedAt,
            input.completedAt,
          ),
      ]
      const committed = yield* Effect.result(
        attempt('node-provision-execution.completion.atomic', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* findCompletion(reservation.organizationId, reservation.operationId)
        if (adopted !== null) {
          if (adopted.providerInstanceId !== input.providerNode.id)
            return yield* conflict('node-provision-execution.completion.provider-mismatch')
          return adopted
        }
        return yield* committed.failure
      }
      if (
        committed.success.length !== statements.length ||
        committed.success.some((item) => !one(item))
      )
        return yield* persistence('node-provision-execution.completion.atomic-changes')
      return completionResult(input, 'completed')
    })

  const recordFailureAtomic: NodeProvisionExecutionRepositoryShape['recordFailureAtomic'] = (
    input,
  ) => recordFailure(database, input)

  return { findCompletion, findPreparation, beginAttempt, completeAtomic, recordFailureAtomic }
}

const provisionalBindingByTokenSql = `SELECT binding.operation_id AS operationId,
 binding.provider_type AS providerType, binding.provider_instance_id AS providerInstanceId,
 binding.state, binding.expires_at AS expiresAt,
 CASE WHEN registration.token_hash IS NULL THEN 0 ELSE 1 END AS registrationExists,
 lease.state AS leaseState
FROM node_provision_registration_bindings binding
JOIN node_provision_execution_leases lease
 ON lease.organization_id = binding.organization_id AND lease.operation_id = binding.operation_id
 AND lease.node_id = binding.node_id AND lease.provider_type = binding.provider_type
 AND lease.delivered_token_hash = binding.delivered_token_hash
JOIN operations operation
 ON operation.organization_id = binding.organization_id AND operation.id = binding.operation_id
 AND operation.resource_type = 'node' AND operation.resource_id = binding.node_id
JOIN node_provision_acceptances acceptance
 ON acceptance.organization_id = binding.organization_id
 AND acceptance.operation_id = binding.operation_id AND acceptance.node_id = binding.node_id
LEFT JOIN node_registration_tokens registration
 ON registration.organization_id = binding.organization_id
 AND registration.operation_id = binding.operation_id AND registration.node_id = binding.node_id
 AND registration.token_hash = binding.delivered_token_hash
 AND registration.provider_instance_id = binding.provider_instance_id
WHERE binding.organization_id = ? AND binding.node_id = ? AND binding.delivered_token_hash = ?`

export const makeProvisionalNodeRegistrationBindingD1 = (
  database: NodeProvisionExecutionD1Database,
): ProvisionalNodeRegistrationBindingPortShape => {
  const read = (organizationId: string, nodeId: string, deliveredTokenHash: string) =>
    attempt('node-provision-execution.registration-bind.read', () =>
      database
        .prepare(provisionalBindingByTokenSql)
        .bind(organizationId, nodeId, deliveredTokenHash)
        .first(),
    )
  return {
    bindFirst: (input) =>
      Effect.gen(function* () {
        if (
          !/^[a-f0-9]{64}$/.test(input.deliveredTokenHash) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.providerInstanceId) ||
          !Number.isFinite(Date.parse(input.boundAt))
        )
          return yield* conflict('node-provision-execution.registration-bind.invalid')
        const currentValue = yield* read(
          input.organizationId,
          input.nodeId,
          input.deliveredTokenHash,
        )
        const current = row(currentValue)
        if (current === undefined)
          return yield* conflict('node-provision-execution.registration-bind.not-found')
        const operationId = string(current.operationId)
        const providerType = string(current.providerType)
        const state = string(current.state)
        const expiresAt = string(current.expiresAt)
        const existingProviderInstanceId =
          current.providerInstanceId === null ? null : string(current.providerInstanceId)
        const registrationExists = integer(current.registrationExists)
        if (
          operationId === undefined ||
          (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
          expiresAt === undefined
        )
          return yield* persistence('node-provision-execution.registration-bind.decode')
        if (state === 'bound') {
          if (existingProviderInstanceId !== input.providerInstanceId || registrationExists !== 1)
            return yield* conflict('node-provision-execution.registration-bind.mismatch')
          return {
            disposition: 'adopted' as const,
            organizationId: input.organizationId,
            nodeId: input.nodeId,
            operationId,
            providerType,
            providerInstanceId: input.providerInstanceId,
            expiresAt,
          }
        }
        if (
          state !== 'materialized' ||
          existingProviderInstanceId !== null ||
          registrationExists !== 0 ||
          string(current.leaseState) !== 'active' ||
          Date.parse(expiresAt) <= Date.parse(input.boundAt)
        )
          return yield* conflict('node-provision-execution.registration-bind.unavailable')
        const auditId = `audit_node_registration_bind:${operationId}`
        const authority = yield* readAuditAuthority(database, {
          organizationId: input.organizationId,
          operationId,
          nodeId: input.nodeId,
        })
        const auditAfter = {
          schemaVersion: 1,
          providerType,
          providerInstanceId: input.providerInstanceId,
          outcome: 'provider-identity-bound',
        }
        const audit = yield* stageNodeProvisionAudit(database, {
          eventId: auditId,
          organizationId: input.organizationId,
          parentOperationId: operationId,
          nodeId: input.nodeId,
          kind: 'provider-identity-bound',
          action: 'node.registration.provider-identity-bound',
          authority,
          request: machineAuditRequest(authority, operationId),
          before: { state: 'absent', reason: 'provider identity was not bound' },
          after: { state: 'captured', summary: auditAfter },
          result: 'succeeded',
          now: input.boundAt,
        })
        const statements = [
          database
            .prepare(`UPDATE nodes SET provider_instance_id = ?, updated_at = ?
              WHERE organization_id = ? AND id = ? AND provider_type = ?
                AND provider_instance_id IS NULL AND desired_state = 'provisioning'
                AND observed_state = 'unknown' AND observed_revision = 0
                AND pending_lifecycle_operation_id = ?`)
            .bind(
              input.providerInstanceId,
              input.boundAt,
              input.organizationId,
              input.nodeId,
              providerType,
              operationId,
            ),
          database
            .prepare(`INSERT INTO node_registration_tokens
              (token_hash, organization_id, node_id, provider_instance_id, operation_id,
               credential_id, expires_at, consumed_at, revoked_at, issued_at)
              VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`)
            .bind(
              input.deliveredTokenHash,
              input.organizationId,
              input.nodeId,
              input.providerInstanceId,
              operationId,
              expiresAt,
              input.boundAt,
            ),
          database
            .prepare(`UPDATE node_provision_registration_bindings
              SET provider_instance_id = ?, state = 'bound', bound_at = ?
              WHERE organization_id = ? AND operation_id = ? AND node_id = ?
                AND delivered_token_hash = ? AND provider_instance_id IS NULL
                AND state = 'materialized'`)
            .bind(
              input.providerInstanceId,
              input.boundAt,
              input.organizationId,
              operationId,
              input.nodeId,
              input.deliveredTokenHash,
            ),
          terminalAuditOperation(database, {
            organizationId: input.organizationId,
            parentOperationId: operationId,
            nodeId: input.nodeId,
            authority,
            kind: 'provider-identity-bound',
            type: 'node.registration.provider-identity-bound',
            status: 'succeeded',
            now: input.boundAt,
          }),
          audit.statement,
          database
            .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              VALUES (?, ?,
               (SELECT operation.actor_id FROM operations operation
                JOIN node_provision_registration_bindings binding
                  ON binding.organization_id = operation.organization_id
                 AND binding.operation_id = operation.id AND binding.node_id = operation.resource_id
                 AND binding.state = 'bound' AND binding.provider_instance_id = ?
                 AND binding.delivered_token_hash = ?
                WHERE operation.organization_id = ? AND operation.id = ?
                  AND operation.resource_type = 'node' AND operation.resource_id = ?),
               'node.registration.provider-identity-bound', 'node', ?, 'succeeded',
               (SELECT correlation_id FROM operations
                WHERE organization_id = ? AND id = ? AND resource_id = ?), ?, ?)`)
            .bind(
              auditId,
              input.organizationId,
              input.providerInstanceId,
              input.deliveredTokenHash,
              input.organizationId,
              operationId,
              input.nodeId,
              input.nodeId,
              input.organizationId,
              operationId,
              input.nodeId,
              audit.summaryJson,
              input.boundAt,
            ),
        ]
        const committed = yield* Effect.result(
          attempt('node-provision-execution.registration-bind.atomic', () =>
            database.batch(statements),
          ),
        )
        if (committed._tag === 'Failure') {
          const adoptedValue = yield* read(
            input.organizationId,
            input.nodeId,
            input.deliveredTokenHash,
          )
          const adopted = row(adoptedValue)
          if (
            string(adopted?.state) === 'bound' &&
            string(adopted?.providerInstanceId) === input.providerInstanceId &&
            integer(adopted?.registrationExists) === 1
          )
            return {
              disposition: 'adopted' as const,
              organizationId: input.organizationId,
              nodeId: input.nodeId,
              operationId,
              providerType,
              providerInstanceId: input.providerInstanceId,
              expiresAt,
            }
          return yield* committed.failure
        }
        if (
          committed.success.length !== statements.length ||
          committed.success.some((result) => !one(result))
        )
          return yield* persistence('node-provision-execution.registration-bind.atomic-changes')
        return {
          disposition: 'bound' as const,
          organizationId: input.organizationId,
          nodeId: input.nodeId,
          operationId,
          providerType,
          providerInstanceId: input.providerInstanceId,
          expiresAt,
        }
      }),
  }
}

/**
 * This query intentionally begins at the operation-bound binding rather than at
 * node_registration_tokens. A token that has no such binding is a legacy
 * registration token and is handled by the existing registration repository.
 * Once a binding is found, every mismatch stays in this fail-closed adapter.
 */
const provisionalRegistrationExchangeSql = `SELECT
 binding.operation_id AS operationId,
 binding.provider_type AS providerType,
 binding.provider_instance_id AS bindingProviderInstanceId,
 binding.state AS bindingState,
 binding.expires_at AS expiresAt,
 lease.state AS leaseState,
 node.provider_instance_id AS nodeProviderInstanceId,
 node.provider_account_id AS nodeProviderAccountId,
 node.provider_type AS nodeProviderType,
 node.image_id AS nodeImageId,
 node.desired_state AS nodeDesiredState,
 node.observed_state AS nodeObservedState,
 node.observed_revision AS nodeObservedRevision,
 node.pending_lifecycle_operation_id AS nodeOperationId,
 operation.status AS operationStatus,
 registration.provider_instance_id AS registrationProviderInstanceId,
 registration.credential_id AS registrationCredentialId,
 registration.consumed_at AS registrationConsumedAt,
 registration.revoked_at AS registrationRevokedAt,
 registration.expires_at AS registrationExpiresAt,
 credential.id AS credentialId,
 credential.credential_hash AS credentialHash,
 credential.version AS credentialVersion,
 credential.status AS credentialStatus,
 session.credential_id AS sessionCredentialId,
 session.session_version AS sessionVersion,
 session.agent_version AS sessionAgentVersion,
 session.session_state AS sessionState,
 installer.public_key AS installerPublicKey,
 installer.public_key_fingerprint AS installerPublicKeyFingerprint,
 installer.status AS installerStatus,
 acceptance.provider_account_id AS acceptedProviderAccountId,
 acceptance.provider_account_revision AS acceptedProviderAccountRevision,
 acceptance.provider_type AS acceptedProviderType,
 acceptance.image_id AS acceptedImageId,
 acceptance.image_version AS acceptedImageVersion,
 acceptance.image_checksum AS acceptedImageChecksum,
 bootstrap.token_hash AS bootstrapTokenHash,
 bootstrap.expires_at AS bootstrapExpiresAt,
 bootstrap.state AS bootstrapState,
 providerAudit.id AS providerAuditId,
 exchangeAudit.id AS exchangeAuditId,
 exchangeOutbox.id AS exchangeOutboxId
FROM node_provision_registration_bindings binding
JOIN node_provision_execution_leases lease
  ON lease.organization_id = binding.organization_id
 AND lease.operation_id = binding.operation_id
 AND lease.node_id = binding.node_id
 AND lease.provider_type = binding.provider_type
 AND lease.delivered_token_hash = binding.delivered_token_hash
JOIN nodes node
  ON node.organization_id = binding.organization_id AND node.id = binding.node_id
JOIN operations operation
  ON operation.organization_id = binding.organization_id AND operation.id = binding.operation_id
JOIN node_provision_acceptances acceptance
  ON acceptance.organization_id = binding.organization_id
 AND acceptance.operation_id = binding.operation_id AND acceptance.node_id = binding.node_id
JOIN node_bootstrap_token_reservations bootstrap
  ON bootstrap.organization_id = binding.organization_id
 AND bootstrap.operation_id = binding.operation_id AND bootstrap.node_id = binding.node_id
 AND bootstrap.token_hash = binding.delivered_token_hash
LEFT JOIN node_registration_tokens registration
  ON registration.organization_id = binding.organization_id
 AND registration.operation_id = binding.operation_id AND registration.node_id = binding.node_id
 AND registration.token_hash = binding.delivered_token_hash
LEFT JOIN node_credentials credential
  ON credential.organization_id = registration.organization_id
 AND credential.node_id = registration.node_id AND credential.id = registration.credential_id
LEFT JOIN agent_sessions session
  ON session.organization_id = credential.organization_id
 AND session.node_id = credential.node_id AND session.credential_id = credential.id
LEFT JOIN node_installer_keys installer
  ON installer.organization_id = binding.organization_id AND installer.node_id = binding.node_id
LEFT JOIN audit_events providerAudit
  ON providerAudit.organization_id = binding.organization_id
 AND providerAudit.id = 'audit_node_provider:' || binding.operation_id
 AND providerAudit.action = 'node.provision.provider-created'
LEFT JOIN audit_events exchangeAudit
  ON exchangeAudit.organization_id = binding.organization_id
 AND exchangeAudit.id = 'audit_node_registration_exchange:' || binding.operation_id
 AND exchangeAudit.action = 'node.registration.exchanged'
LEFT JOIN outbox exchangeOutbox
  ON exchangeOutbox.organization_id = binding.organization_id
 AND exchangeOutbox.id = 'outbox_node_registration_exchange:' || binding.operation_id
 AND exchangeOutbox.event_type = 'node.registration.exchanged'
WHERE binding.organization_id = ?
  AND binding.node_id = ?
  AND binding.delivered_token_hash = ?`

const validRegistrationExchangeInput = (input: {
  readonly organizationId: string
  readonly nodeId: string
  readonly deliveredTokenHash: string
  readonly providerInstanceId: string
  readonly credentialId: string
  readonly credentialHash: string
  readonly agentVersion: string
  readonly installerPublicKey: string
  readonly installerPublicKeyFingerprint: string
  readonly now: string
}): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.organizationId) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.nodeId) &&
  /^[a-f0-9]{64}$/.test(input.deliveredTokenHash) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.providerInstanceId) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.credentialId) &&
  /^[a-f0-9]{64}$/.test(input.credentialHash) &&
  /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/.test(input.agentVersion) &&
  input.installerPublicKey.length >= 512 &&
  input.installerPublicKey.length <= 2048 &&
  /^rsa-oaep-spki-v1\.[A-Za-z0-9_-]+$/.test(input.installerPublicKey) &&
  /^sha256:[a-f0-9]{64}$/.test(input.installerPublicKeyFingerprint) &&
  Number.isFinite(Date.parse(input.now))

type RegistrationExchangeInput = Parameters<
  ProvisionalNodeRegistrationExchangePortShape['exchange']
>[0]
type RegistrationExchangeRow = Record<string, unknown>

const registeredExchangeReplay = (
  value: RegistrationExchangeRow,
  input: RegistrationExchangeInput,
) => {
  const operationId = string(value.operationId)
  const credentialVersion = integer(value.credentialVersion)
  const sessionVersion = integer(value.sessionVersion)
  const replayed =
    string(value.bindingState) === 'bound' &&
    string(value.bindingProviderInstanceId) === input.providerInstanceId &&
    string(value.nodeProviderInstanceId) === input.providerInstanceId &&
    string(value.registrationProviderInstanceId) === input.providerInstanceId &&
    string(value.registrationCredentialId) === input.credentialId &&
    value.registrationConsumedAt !== null &&
    value.registrationRevokedAt === null &&
    string(value.credentialId) === input.credentialId &&
    string(value.credentialHash) === input.credentialHash &&
    credentialVersion === 1 &&
    string(value.credentialStatus) === 'active' &&
    string(value.sessionCredentialId) === input.credentialId &&
    sessionVersion === 1 &&
    string(value.sessionAgentVersion) === input.agentVersion &&
    string(value.sessionState) === 'connected' &&
    string(value.installerPublicKey) === input.installerPublicKey &&
    string(value.installerPublicKeyFingerprint) === input.installerPublicKeyFingerprint &&
    string(value.installerStatus) === 'active' &&
    string(value.exchangeAuditId) === `audit_node_registration_exchange:${operationId}` &&
    string(value.exchangeOutboxId) === `outbox_node_registration_exchange:${operationId}` &&
    (string(value.leaseState) === 'active' || string(value.leaseState) === 'released')
  return replayed &&
    operationId !== undefined &&
    credentialVersion !== undefined &&
    sessionVersion !== undefined
    ? {
        disposition: 'adopted' as const,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        operationId,
        providerInstanceId: input.providerInstanceId,
        credentialId: input.credentialId,
        credentialVersion,
        sessionVersion,
      }
    : null
}

const materializedRegistrationStatements = (
  database: NodeProvisionExecutionD1Database,
  row: RegistrationExchangeRow,
  input: RegistrationExchangeInput,
  authority: NodeProvisionAuditAuthority,
  audit: StagedNodeProvisionAudit,
) => {
  const operationId = string(row.operationId)!
  const providerType = string(row.providerType)!
  const expiresAt = string(row.expiresAt)!
  const auditId = `audit_node_registration_exchange:${operationId}`
  const outboxId = `outbox_node_registration_exchange:${operationId}`
  const payload = JSON.stringify({
    schemaVersion: 1,
    organizationId: input.organizationId,
    partitionKey: `${input.organizationId}:node:${input.nodeId}`,
    nodeId: input.nodeId,
    operationId,
    providerType,
    providerInstanceId: input.providerInstanceId,
    credentialId: input.credentialId,
    credentialVersion: 1,
    sessionVersion: 1,
  })
  return [
    database
      .prepare(`UPDATE nodes SET provider_instance_id = ?, updated_at = ?
        WHERE organization_id = ? AND id = ? AND provider_type = ?
          AND provider_instance_id IS NULL AND desired_state = 'provisioning'
          AND observed_state = 'unknown' AND observed_revision = 0
          AND pending_lifecycle_operation_id = ?`)
      .bind(
        input.providerInstanceId,
        input.now,
        input.organizationId,
        input.nodeId,
        providerType,
        operationId,
      ),
    database
      .prepare(`INSERT INTO node_registration_tokens
        (token_hash, organization_id, node_id, provider_instance_id, operation_id,
         credential_id, expires_at, consumed_at, revoked_at, issued_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`)
      .bind(
        input.deliveredTokenHash,
        input.organizationId,
        input.nodeId,
        input.providerInstanceId,
        operationId,
        expiresAt,
        input.now,
      ),
    database
      .prepare(`UPDATE node_registration_tokens SET consumed_at = ?
        WHERE token_hash = ? AND organization_id = ? AND node_id = ?
          AND provider_instance_id = ? AND operation_id = ?
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .bind(
        input.now,
        input.deliveredTokenHash,
        input.organizationId,
        input.nodeId,
        input.providerInstanceId,
        operationId,
        input.now,
      ),
    database
      .prepare(`INSERT INTO node_credentials
        (organization_id, node_id, id, credential_hash, version, status, issued_at)
        SELECT organization_id, node_id, ?, ?, 1, 'active', ?
        FROM node_registration_tokens
        WHERE token_hash = ? AND consumed_at = ? AND changes() = 1`)
      .bind(
        input.credentialId,
        input.credentialHash,
        input.now,
        input.deliveredTokenHash,
        input.now,
      ),
    database
      .prepare(`INSERT INTO agent_sessions
        (organization_id, node_id, credential_id, session_version, agent_version,
         session_state, last_seen_at, revision)
        SELECT organization_id, node_id, ?, 1, ?, 'connected', ?, 1
        FROM node_registration_tokens
        WHERE token_hash = ? AND consumed_at = ? AND changes() = 1`)
      .bind(input.credentialId, input.agentVersion, input.now, input.deliveredTokenHash, input.now),
    database
      .prepare(`UPDATE node_registration_tokens SET credential_id = ?
        WHERE token_hash = ? AND consumed_at = ? AND credential_id IS NULL AND changes() = 1`)
      .bind(input.credentialId, input.deliveredTokenHash, input.now),
    database
      .prepare(`INSERT INTO node_installer_keys
        (organization_id, node_id, public_key, public_key_fingerprint, status,
         revision, registered_at)
        SELECT organization_id, node_id, ?, ?, 'active', 1, ?
        FROM node_registration_tokens
        WHERE token_hash = ? AND consumed_at = ? AND credential_id = ?`)
      .bind(
        input.installerPublicKey,
        input.installerPublicKeyFingerprint,
        input.now,
        input.deliveredTokenHash,
        input.now,
        input.credentialId,
      ),
    database
      .prepare(`UPDATE node_provision_registration_bindings
        SET provider_instance_id = ?, state = 'bound', bound_at = ?
        WHERE organization_id = ? AND operation_id = ? AND node_id = ?
          AND delivered_token_hash = ? AND provider_instance_id IS NULL
          AND state = 'materialized'`)
      .bind(
        input.providerInstanceId,
        input.now,
        input.organizationId,
        operationId,
        input.nodeId,
        input.deliveredTokenHash,
      ),
    terminalAuditOperation(database, {
      organizationId: input.organizationId,
      parentOperationId: operationId,
      nodeId: input.nodeId,
      authority,
      kind: 'registration-exchanged',
      type: 'node.registration.exchanged',
      status: 'succeeded',
      now: input.now,
    }),
    audit.statement,
    /* A NOT NULL scalar subquery is the batch abort guard: zero-row updates above cannot commit. */
    database
      .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES (?,
          (SELECT operation.organization_id
           FROM operations operation
           JOIN nodes node ON node.organization_id = operation.organization_id
             AND node.id = operation.resource_id
           JOIN node_provision_acceptances acceptance
             ON acceptance.organization_id = operation.organization_id
             AND acceptance.operation_id = operation.id AND acceptance.node_id = node.id
           JOIN node_provision_execution_leases lease
             ON lease.organization_id = operation.organization_id
             AND lease.operation_id = operation.id AND lease.node_id = node.id
             AND lease.provider_account_id = acceptance.provider_account_id
             AND lease.provider_account_revision = acceptance.provider_account_revision
             AND lease.provider_type = acceptance.provider_type
             AND lease.delivered_token_hash = ? AND lease.bootstrap_expires_at = ?
             AND lease.state = 'active'
           JOIN node_bootstrap_token_reservations bootstrap
             ON bootstrap.organization_id = operation.organization_id
             AND bootstrap.operation_id = operation.id AND bootstrap.node_id = node.id
             AND bootstrap.token_hash = lease.delivered_token_hash
             AND bootstrap.expires_at = lease.bootstrap_expires_at
             AND bootstrap.state = 'materialized'
           JOIN node_provision_registration_bindings binding
             ON binding.organization_id = operation.organization_id
             AND binding.operation_id = operation.id AND binding.node_id = node.id
             AND binding.provider_type = acceptance.provider_type
             AND binding.delivered_token_hash = lease.delivered_token_hash
             AND binding.provider_instance_id = node.provider_instance_id
             AND binding.state = 'bound' AND binding.expires_at = bootstrap.expires_at
           JOIN node_registration_tokens registration
             ON registration.organization_id = operation.organization_id
             AND registration.operation_id = operation.id AND registration.node_id = node.id
             AND registration.provider_instance_id = node.provider_instance_id
             AND registration.token_hash = lease.delivered_token_hash
             AND registration.expires_at = bootstrap.expires_at
             AND registration.credential_id = ? AND registration.consumed_at = ?
             AND registration.revoked_at IS NULL
           JOIN node_credentials credential
             ON credential.organization_id = registration.organization_id
             AND credential.node_id = registration.node_id AND credential.id = registration.credential_id
             AND credential.credential_hash = ? AND credential.version = 1 AND credential.status = 'active'
           JOIN agent_sessions session
             ON session.organization_id = credential.organization_id
             AND session.node_id = credential.node_id AND session.credential_id = credential.id
             AND session.session_version = 1 AND session.agent_version = ?
             AND session.session_state = 'connected'
           JOIN node_installer_keys installer
             ON installer.organization_id = operation.organization_id AND installer.node_id = node.id
             AND installer.public_key = ? AND installer.public_key_fingerprint = ?
             AND installer.status = 'active'
           WHERE operation.organization_id = ? AND operation.id = ?
             AND operation.type = 'provision-node' AND operation.resource_type = 'node'
             AND operation.resource_id = ? AND operation.status = 'running'
             AND node.provider_instance_id = ? AND node.provider_type = acceptance.provider_type
             AND node.provider_account_id = acceptance.provider_account_id
             AND node.image_id = acceptance.image_id
             AND acceptance.image_version = ? AND acceptance.image_checksum = ?),
          (SELECT operation.actor_id FROM operations operation
           WHERE operation.organization_id = ? AND operation.id = ?),
          'node.registration.exchanged', 'node', ?, 'succeeded',
          (SELECT operation.correlation_id FROM operations operation
           WHERE operation.organization_id = ? AND operation.id = ?), ?, ?)`)
      .bind(
        auditId,
        input.deliveredTokenHash,
        expiresAt,
        input.credentialId,
        input.now,
        input.credentialHash,
        input.agentVersion,
        input.installerPublicKey,
        input.installerPublicKeyFingerprint,
        input.organizationId,
        operationId,
        input.nodeId,
        input.providerInstanceId,
        string(row.acceptedImageVersion),
        string(row.acceptedImageChecksum),
        input.organizationId,
        operationId,
        input.nodeId,
        input.organizationId,
        operationId,
        audit.summaryJson,
        input.now,
      ),
    database
      .prepare(`INSERT INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, lease_owner, lease_token, lease_until,
         created_at, delivered_at)
        VALUES (?, ?, 'node.registration.exchanged', 'node',
          (SELECT node.id FROM nodes node
           JOIN audit_events audit ON audit.organization_id = node.organization_id
             AND audit.id = ? AND audit.action = 'node.registration.exchanged'
           WHERE node.organization_id = ? AND node.id = ? AND node.provider_instance_id = ?),
          ?, 'pending', 0, ?, NULL, NULL, NULL, ?, NULL)`)
      .bind(
        outboxId,
        input.organizationId,
        auditId,
        input.organizationId,
        input.nodeId,
        input.providerInstanceId,
        payload,
        input.now,
        input.now,
      ),
  ]
}

const completedProviderRegistrationStatements = (
  database: NodeProvisionExecutionD1Database,
  row: RegistrationExchangeRow,
  input: RegistrationExchangeInput,
  authority: NodeProvisionAuditAuthority,
  audit: StagedNodeProvisionAudit,
) => {
  const operationId = string(row.operationId)!
  const providerType = string(row.providerType)!
  const expiresAt = string(row.expiresAt)!
  const auditId = `audit_node_registration_exchange:${operationId}`
  const outboxId = `outbox_node_registration_exchange:${operationId}`
  const payload = JSON.stringify({
    schemaVersion: 1,
    organizationId: input.organizationId,
    partitionKey: `${input.organizationId}:node:${input.nodeId}`,
    nodeId: input.nodeId,
    operationId,
    providerType,
    providerInstanceId: input.providerInstanceId,
    credentialId: input.credentialId,
    credentialVersion: 1,
    sessionVersion: 1,
  })
  return [
    database
      .prepare(`UPDATE node_registration_tokens SET consumed_at = ?
        WHERE token_hash = ? AND organization_id = ? AND node_id = ?
          AND provider_instance_id = ? AND operation_id = ?
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at = ? AND expires_at > ?`)
      .bind(
        input.now,
        input.deliveredTokenHash,
        input.organizationId,
        input.nodeId,
        input.providerInstanceId,
        operationId,
        expiresAt,
        input.now,
      ),
    database
      .prepare(`INSERT INTO node_credentials
        (organization_id, node_id, id, credential_hash, version, status, issued_at)
        SELECT organization_id, node_id, ?, ?, 1, 'active', ?
        FROM node_registration_tokens
        WHERE token_hash = ? AND consumed_at = ? AND changes() = 1`)
      .bind(
        input.credentialId,
        input.credentialHash,
        input.now,
        input.deliveredTokenHash,
        input.now,
      ),
    database
      .prepare(`INSERT INTO agent_sessions
        (organization_id, node_id, credential_id, session_version, agent_version,
         session_state, last_seen_at, revision)
        SELECT organization_id, node_id, ?, 1, ?, 'connected', ?, 1
        FROM node_registration_tokens
        WHERE token_hash = ? AND consumed_at = ? AND changes() = 1`)
      .bind(input.credentialId, input.agentVersion, input.now, input.deliveredTokenHash, input.now),
    database
      .prepare(`UPDATE node_registration_tokens SET credential_id = ?
        WHERE token_hash = ? AND consumed_at = ? AND credential_id IS NULL AND changes() = 1`)
      .bind(input.credentialId, input.deliveredTokenHash, input.now),
    database
      .prepare(`INSERT INTO node_installer_keys
        (organization_id, node_id, public_key, public_key_fingerprint, status,
         revision, registered_at)
        SELECT organization_id, node_id, ?, ?, 'active', 1, ?
        FROM node_registration_tokens
        WHERE token_hash = ? AND consumed_at = ? AND credential_id = ?`)
      .bind(
        input.installerPublicKey,
        input.installerPublicKeyFingerprint,
        input.now,
        input.deliveredTokenHash,
        input.now,
        input.credentialId,
      ),
    terminalAuditOperation(database, {
      organizationId: input.organizationId,
      parentOperationId: operationId,
      nodeId: input.nodeId,
      authority,
      kind: 'registration-exchanged',
      type: 'node.registration.exchanged',
      status: 'succeeded',
      now: input.now,
    }),
    audit.statement,
    database
      .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES (?,
          (SELECT operation.organization_id
           FROM operations operation
           JOIN nodes node ON node.organization_id = operation.organization_id
             AND node.id = operation.resource_id
           JOIN node_provision_acceptances acceptance
             ON acceptance.organization_id = operation.organization_id
             AND acceptance.operation_id = operation.id AND acceptance.node_id = node.id
           JOIN node_provision_execution_leases lease
             ON lease.organization_id = operation.organization_id
             AND lease.operation_id = operation.id AND lease.node_id = node.id
             AND lease.provider_account_id = acceptance.provider_account_id
             AND lease.provider_account_revision = acceptance.provider_account_revision
             AND lease.provider_type = acceptance.provider_type
             AND lease.delivered_token_hash = ? AND lease.bootstrap_expires_at = ?
             AND lease.state = 'released'
           JOIN node_bootstrap_token_reservations bootstrap
             ON bootstrap.organization_id = operation.organization_id
             AND bootstrap.operation_id = operation.id AND bootstrap.node_id = node.id
             AND bootstrap.token_hash = lease.delivered_token_hash
             AND bootstrap.expires_at = lease.bootstrap_expires_at
             AND bootstrap.state = 'materialized'
           JOIN node_provision_registration_bindings binding
             ON binding.organization_id = operation.organization_id
             AND binding.operation_id = operation.id AND binding.node_id = node.id
             AND binding.provider_type = acceptance.provider_type
             AND binding.delivered_token_hash = lease.delivered_token_hash
             AND binding.provider_instance_id = node.provider_instance_id
             AND binding.state = 'bound' AND binding.expires_at = bootstrap.expires_at
           JOIN node_registration_tokens registration
             ON registration.organization_id = operation.organization_id
             AND registration.operation_id = operation.id AND registration.node_id = node.id
             AND registration.provider_instance_id = node.provider_instance_id
             AND registration.token_hash = lease.delivered_token_hash
             AND registration.expires_at = bootstrap.expires_at
             AND registration.credential_id = ? AND registration.consumed_at = ?
             AND registration.revoked_at IS NULL
           JOIN node_credentials credential
             ON credential.organization_id = registration.organization_id
             AND credential.node_id = registration.node_id AND credential.id = registration.credential_id
             AND credential.credential_hash = ? AND credential.version = 1 AND credential.status = 'active'
           JOIN agent_sessions session
             ON session.organization_id = credential.organization_id
             AND session.node_id = credential.node_id AND session.credential_id = credential.id
             AND session.session_version = 1 AND session.agent_version = ?
             AND session.session_state = 'connected'
           JOIN node_installer_keys installer
             ON installer.organization_id = operation.organization_id AND installer.node_id = node.id
             AND installer.public_key = ? AND installer.public_key_fingerprint = ?
             AND installer.status = 'active'
           JOIN audit_events providerAudit
             ON providerAudit.organization_id = operation.organization_id
             AND providerAudit.id = 'audit_node_provider:' || operation.id
             AND providerAudit.action = 'node.provision.provider-created'
           WHERE operation.organization_id = ? AND operation.id = ?
             AND operation.type = 'provision-node' AND operation.resource_type = 'node'
             AND operation.resource_id = ? AND operation.status = 'waiting_external'
             AND node.provider_instance_id = ? AND node.provider_type = acceptance.provider_type
             AND node.provider_account_id = acceptance.provider_account_id
             AND node.image_id = acceptance.image_id
             AND node.observed_state = 'provisioning' AND node.observed_revision = 0
             AND acceptance.image_version = ? AND acceptance.image_checksum = ?),
          (SELECT operation.actor_id FROM operations operation
           WHERE operation.organization_id = ? AND operation.id = ?),
          'node.registration.exchanged', 'node', ?, 'succeeded',
          (SELECT operation.correlation_id FROM operations operation
           WHERE operation.organization_id = ? AND operation.id = ?), ?, ?)`)
      .bind(
        auditId,
        input.deliveredTokenHash,
        expiresAt,
        input.credentialId,
        input.now,
        input.credentialHash,
        input.agentVersion,
        input.installerPublicKey,
        input.installerPublicKeyFingerprint,
        input.organizationId,
        operationId,
        input.nodeId,
        input.providerInstanceId,
        string(row.acceptedImageVersion),
        string(row.acceptedImageChecksum),
        input.organizationId,
        operationId,
        input.nodeId,
        input.organizationId,
        operationId,
        audit.summaryJson,
        input.now,
      ),
    database
      .prepare(`INSERT INTO outbox
        (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
         publish_state, retry_count, available_at, lease_owner, lease_token, lease_until,
         created_at, delivered_at)
        VALUES (?, ?, 'node.registration.exchanged', 'node',
          (SELECT node.id FROM nodes node
           JOIN audit_events audit ON audit.organization_id = node.organization_id
             AND audit.id = ? AND audit.action = 'node.registration.exchanged'
           WHERE node.organization_id = ? AND node.id = ? AND node.provider_instance_id = ?),
          ?, 'pending', 0, ?, NULL, NULL, NULL, ?, NULL)`)
      .bind(
        outboxId,
        input.organizationId,
        auditId,
        input.organizationId,
        input.nodeId,
        input.providerInstanceId,
        payload,
        input.now,
        input.now,
      ),
  ]
}

const canMaterializeProvisionalRegistration = (
  value: RegistrationExchangeRow,
  input: RegistrationExchangeInput,
): boolean =>
  string(value.bindingState) === 'materialized' &&
  value.bindingProviderInstanceId === null &&
  value.registrationProviderInstanceId === null &&
  string(value.leaseState) === 'active' &&
  string(value.nodeProviderInstanceId) === undefined &&
  string(value.nodeProviderType) === string(value.providerType) &&
  string(value.nodeDesiredState) === 'provisioning' &&
  string(value.nodeObservedState) === 'unknown' &&
  integer(value.nodeObservedRevision) === 0 &&
  string(value.nodeOperationId) === string(value.operationId) &&
  string(value.operationStatus) === 'running' &&
  string(value.bootstrapState) === 'materialized' &&
  string(value.bootstrapTokenHash) === input.deliveredTokenHash &&
  string(value.bootstrapExpiresAt) === string(value.expiresAt) &&
  Date.parse(string(value.expiresAt) ?? '') > Date.parse(input.now)

const canConsumeCompletedProviderRegistration = (
  value: RegistrationExchangeRow,
  input: RegistrationExchangeInput,
): boolean =>
  string(value.bindingState) === 'bound' &&
  string(value.bindingProviderInstanceId) === input.providerInstanceId &&
  string(value.registrationProviderInstanceId) === input.providerInstanceId &&
  value.registrationCredentialId === null &&
  value.registrationConsumedAt === null &&
  value.registrationRevokedAt === null &&
  string(value.leaseState) === 'released' &&
  string(value.nodeProviderInstanceId) === input.providerInstanceId &&
  string(value.nodeProviderType) === string(value.providerType) &&
  string(value.nodeDesiredState) === 'provisioning' &&
  string(value.nodeObservedState) === 'provisioning' &&
  integer(value.nodeObservedRevision) === 0 &&
  string(value.nodeOperationId) === string(value.operationId) &&
  string(value.operationStatus) === 'waiting_external' &&
  string(value.bootstrapState) === 'materialized' &&
  string(value.bootstrapTokenHash) === input.deliveredTokenHash &&
  string(value.bootstrapExpiresAt) === string(value.expiresAt) &&
  string(value.registrationExpiresAt) === string(value.expiresAt) &&
  string(value.providerAuditId) === `audit_node_provider:${string(value.operationId)}` &&
  Date.parse(string(value.expiresAt) ?? '') > Date.parse(input.now)

export const makeProvisionalNodeRegistrationExchangeD1 = (
  database: NodeProvisionExecutionD1Database,
): ProvisionalNodeRegistrationExchangePortShape => {
  const read = (input: RegistrationExchangeInput) =>
    attempt('node-provision-execution.registration-exchange.read', () =>
      database
        .prepare(provisionalRegistrationExchangeSql)
        .bind(input.organizationId, input.nodeId, input.deliveredTokenHash)
        .first(),
    )
  return {
    exchange: (input) =>
      Effect.gen(function* () {
        if (!validRegistrationExchangeInput(input))
          return yield* conflict('node-provision-execution.registration-exchange.invalid')
        const initialValue = yield* read(input)
        const initial = row(initialValue)
        if (initial === undefined) return null
        const replay = registeredExchangeReplay(initial, input)
        if (replay !== null) return replay
        const operationId = string(initial.operationId)
        const providerType = string(initial.providerType)
        const expiresAt = string(initial.expiresAt)
        if (
          operationId === undefined ||
          (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
          expiresAt === undefined
        )
          return yield* persistence('node-provision-execution.registration-exchange.decode')
        const materialized = canMaterializeProvisionalRegistration(initial, input)
        const completed = canConsumeCompletedProviderRegistration(initial, input)
        if (!materialized && !completed)
          return yield* conflict('node-provision-execution.registration-exchange.unavailable')
        const authority = yield* readAuditAuthority(database, {
          organizationId: input.organizationId,
          operationId,
          nodeId: input.nodeId,
        })
        const audit = yield* stageNodeProvisionAudit(database, {
          eventId: `audit_node_registration_exchange:${operationId}`,
          organizationId: input.organizationId,
          parentOperationId: operationId,
          nodeId: input.nodeId,
          kind: 'registration-exchanged',
          action: 'node.registration.exchanged',
          authority,
          request: machineAuditRequest(authority, operationId),
          before: {
            state: 'captured',
            summary: {
              providerType,
              providerInstanceId: materialized ? null : input.providerInstanceId,
              registrationState: materialized ? 'materialized' : 'provider-created',
              credentialVersion: 0,
              sessionVersion: 0,
            },
          },
          after: {
            state: 'captured',
            summary: {
              providerType,
              providerInstanceId: input.providerInstanceId,
              registrationState: 'bound',
              credentialVersion: 1,
              sessionVersion: 1,
              sessionState: 'connected',
            },
          },
          result: 'succeeded',
          now: input.now,
        })
        const statements = materialized
          ? materializedRegistrationStatements(database, initial, input, authority, audit)
          : completedProviderRegistrationStatements(database, initial, input, authority, audit)
        const committed = yield* Effect.result(
          attempt('node-provision-execution.registration-exchange.atomic', () =>
            database.batch(statements),
          ),
        )
        if (committed._tag === 'Success' && committed.success.every(one))
          return {
            disposition: 'bound' as const,
            organizationId: input.organizationId,
            nodeId: input.nodeId,
            operationId,
            providerInstanceId: input.providerInstanceId,
            credentialId: input.credentialId,
            credentialVersion: 1,
            sessionVersion: 1,
          }
        const replayValue = yield* read(input)
        const replayRow = row(replayValue)
        const adopted = replayRow === undefined ? null : registeredExchangeReplay(replayRow, input)
        if (adopted !== null) return adopted
        return yield* committed._tag === 'Failure'
          ? committed.failure
          : conflict('node-provision-execution.registration-exchange.atomic-fence')
      }),
  }
}

const safeFailureCategory = (value: string): boolean => /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value)

const recordFailure = (
  database: NodeProvisionExecutionD1Database,
  input: NodeProvisionExecutionFailureInput,
): Effect.Effect<void, NodeProvisionExecutionPersistenceError> =>
  Effect.gen(function* () {
    if (
      !safeFailureCategory(input.category) ||
      !Number.isSafeInteger(input.attemptNumber) ||
      input.attemptNumber < 1 ||
      !Number.isFinite(Date.parse(input.attemptedAt))
    )
      return yield* persistence('node-provision-execution.failure.invalid')
    const { reservation } = input
    const status = input.retryable ? 'retrying' : 'failed_terminal'
    const outcome = input.retryable ? 'reconciliation-required' : 'operator-required'
    const auditId = `audit_node_provider_failure:${reservation.operationId}:${input.attemptNumber}`
    const outboxId = `outbox_node_provider_failure:${reservation.operationId}:${input.attemptNumber}`
    const authority = yield* readAuditAuthority(database, reservation)
    const audit = yield* stageNodeProvisionAudit(database, {
      eventId: auditId,
      organizationId: reservation.organizationId,
      parentOperationId: reservation.operationId,
      nodeId: reservation.nodeId,
      kind: `provider-failed-${input.attemptNumber}`,
      action: 'node.provision.provider-failed',
      authority,
      request: machineAuditRequest(authority, reservation.operationId),
      before: {
        state: 'captured',
        summary: {
          desiredState: 'provisioning',
          providerState: 'create-attempted',
          attemptNumber: input.attemptNumber,
        },
      },
      after: {
        state: 'captured',
        summary: {
          desiredState: 'provisioning',
          providerState: input.retryable ? 'adoption-required' : 'failed',
          attemptNumber: input.attemptNumber,
          retryable: input.retryable,
          outcome,
        },
      },
      result: 'failed',
      errorCode: input.category,
      now: input.attemptedAt,
    })
    const payload = JSON.stringify({
      schemaVersion: 1,
      organizationId: reservation.organizationId,
      partitionKey: `${reservation.organizationId}:node:${reservation.nodeId}`,
      nodeId: reservation.nodeId,
      operationId: reservation.operationId,
      category: input.category,
      retryable: input.retryable,
      attemptNumber: input.attemptNumber,
      outcome,
    })
    const releaseStatements = input.retryable
      ? []
      : [
          database
            .prepare(`UPDATE node_provision_execution_leases
              SET state = 'released', released_at = ?
              WHERE organization_id = ? AND operation_id = ? AND node_id = ?
                AND state = 'active'`)
            .bind(
              input.attemptedAt,
              reservation.organizationId,
              reservation.operationId,
              reservation.nodeId,
            ),
        ]
    const leaseFence = input.retryable
      ? `lease.state = 'active' AND lease.released_at IS NULL`
      : `lease.state = 'released' AND lease.released_at = ?`
    const statements = [
      database
        .prepare(`UPDATE operations SET status = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND type = 'provision-node'
            AND resource_type = 'node' AND resource_id = ? AND status = 'running'`)
        .bind(
          status,
          input.attemptedAt,
          reservation.organizationId,
          reservation.operationId,
          reservation.nodeId,
        ),
      database
        .prepare(`UPDATE nodes SET reconciliation_error = ?, updated_at = ?
          WHERE organization_id = ? AND id = ? AND pending_lifecycle_operation_id = ?
            AND desired_state = 'provisioning' AND observed_revision = 0`)
        .bind(
          outcome,
          input.attemptedAt,
          reservation.organizationId,
          reservation.nodeId,
          reservation.operationId,
        ),
      terminalAuditOperation(database, {
        organizationId: reservation.organizationId,
        parentOperationId: reservation.operationId,
        nodeId: reservation.nodeId,
        authority,
        kind: `provider-failed-${input.attemptNumber}`,
        type: 'node.provision.provider-failed',
        status: 'failed_terminal',
        now: input.attemptedAt,
      }),
      audit.statement,
      database
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, organization_id, actor_id, 'node.provision.provider-failed', 'node',
           resource_id, 'failed', correlation_id, ?, ?
          FROM operations WHERE organization_id = ? AND id = ? AND resource_id = ? AND status = ?`)
        .bind(
          auditId,
          audit.summaryJson,
          input.attemptedAt,
          reservation.organizationId,
          reservation.operationId,
          reservation.nodeId,
          status,
        ),
      ...releaseStatements,
      database
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, lease_owner, lease_token, lease_until,
           created_at, delivered_at)
          VALUES (?, ?, 'node.provision.provider-failed', 'node',
           (SELECT node.id
            FROM operations operation
            JOIN nodes node
              ON node.organization_id = operation.organization_id
             AND node.id = operation.resource_id
             AND node.pending_lifecycle_operation_id = operation.id
             AND node.desired_state = 'provisioning'
             AND node.observed_revision = 0
             AND node.reconciliation_error = ?
            JOIN node_provision_execution_leases lease
              ON lease.organization_id = operation.organization_id
             AND lease.operation_id = operation.id AND lease.node_id = node.id
             AND ${leaseFence}
            JOIN node_bootstrap_token_reservations bootstrap
              ON bootstrap.organization_id = operation.organization_id
             AND bootstrap.operation_id = operation.id AND bootstrap.node_id = node.id
             AND bootstrap.token_hash = lease.delivered_token_hash
             AND bootstrap.expires_at = lease.bootstrap_expires_at
             AND bootstrap.state = 'materialized'
            JOIN node_provision_registration_bindings binding
              ON binding.organization_id = operation.organization_id
             AND binding.operation_id = operation.id AND binding.node_id = node.id
             AND binding.delivered_token_hash = lease.delivered_token_hash
             AND binding.expires_at = lease.bootstrap_expires_at
             AND binding.state IN ('materialized', 'bound')
            JOIN audit_events audit
              ON audit.organization_id = operation.organization_id AND audit.id = ?
             AND audit.action = 'node.provision.provider-failed'
             AND audit.target_type = 'node' AND audit.target_id = node.id
             AND audit.result = 'failed'
            WHERE operation.organization_id = ? AND operation.id = ?
              AND operation.resource_type = 'node' AND operation.resource_id = ?
              AND operation.status = ?),
           ?, 'pending', 0, ?, NULL, NULL, NULL, ?, NULL)`)
        .bind(
          outboxId,
          reservation.organizationId,
          outcome,
          ...(input.retryable ? [] : [input.attemptedAt]),
          auditId,
          reservation.organizationId,
          reservation.operationId,
          reservation.nodeId,
          status,
          payload,
          input.attemptedAt,
          input.attemptedAt,
        ),
    ]
    const result = yield* attempt('node-provision-execution.failure.atomic', () =>
      database.batch(statements),
    )
    if (result.length !== statements.length || result.some((item) => !one(item)))
      return yield* persistence('node-provision-execution.failure.atomic-changes')
  })

export const NodeProvisionExecutionRepositoryD1Live = Layer.effect(
  NodeProvisionExecutionRepository,
  Effect.gen(function* () {
    const database = yield* NodeProvisionExecutionD1Client
    return NodeProvisionExecutionRepository.of(makeNodeProvisionExecutionRepositoryD1(database))
  }),
)

export const ProvisionalNodeRegistrationBindingD1Live = Layer.effect(
  ProvisionalNodeRegistrationBindingPort,
  Effect.gen(function* () {
    const database = yield* NodeProvisionExecutionD1Client
    return ProvisionalNodeRegistrationBindingPort.of(
      makeProvisionalNodeRegistrationBindingD1(database),
    )
  }),
)

export const ProvisionalNodeRegistrationExchangeD1Live = Layer.effect(
  ProvisionalNodeRegistrationExchangePort,
  Effect.gen(function* () {
    const database = yield* NodeProvisionExecutionD1Client
    return ProvisionalNodeRegistrationExchangePort.of(
      makeProvisionalNodeRegistrationExchangeD1(database),
    )
  }),
)

import { Context, Effect, Layer, Schema } from 'effect'
import {
  AuditRequestContext,
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelopeFromRequestContext,
  stageAuditEnvelope,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import {
  NodeRuntimeLifecycleAcceptanceContract,
  NodeRuntimeLifecycleAuthorizationError,
  NodeRuntimeLifecycleConflictError,
  NodeRuntimeLifecycleNotFoundError,
  NodeRuntimeLifecyclePersistenceError,
  NodeRuntimeLifecycleRepository,
  type NodeRuntimeLifecycleAcceptance,
  type NodeRuntimeLifecycleAtomicInput,
  type NodeRuntimeLifecycleNode,
  type NodeRuntimeLifecycleRepositoryShape,
  type NodeRuntimeObservedState,
} from '@gridora/node-runtime-lifecycle-control'
import {
  NodeRuntimeLifecycleExecutionConflictError,
  NodeRuntimeLifecycleExecutionPersistenceError,
  NodeRuntimeLifecycleExecutionRepository,
  type NodeRuntimeLifecycleExecutionLease,
  type NodeRuntimeLifecycleObservationRecovery,
  type NodeRuntimeLifecycleExecutionRepositoryShape,
  type NodeRuntimeLifecycleExecutionReservation,
  type NodeRuntimeLifecycleExecutionResult,
} from '@gridora/node-runtime-lifecycle-execution'

export interface NodeRuntimeLifecycleD1Result {
  readonly success?: boolean
  readonly meta?: { readonly changes?: number }
}
export interface NodeRuntimeLifecycleD1Statement {
  bind(...values: ReadonlyArray<unknown>): NodeRuntimeLifecycleD1Statement
  first(): Promise<unknown>
  all(): Promise<{ readonly results: ReadonlyArray<unknown> }>
}
export interface NodeRuntimeLifecycleD1Database {
  prepare(sql: string): NodeRuntimeLifecycleD1Statement
  /** D1 commits the listed statements as one transaction and preserves their order. */
  batch(
    statements: ReadonlyArray<NodeRuntimeLifecycleD1Statement>,
  ): Promise<ReadonlyArray<NodeRuntimeLifecycleD1Result>>
}

export interface NodeRuntimeLifecycleD1Options {
  /**
   * Canonical edge provenance for the acceptance audit. Internal callers must
   * provide their own explicit machine or scheduler context instead of using
   * an invented HTTP source.
   */
  readonly auditRequestContext: AuditRequestContextValue
}

const defaults: NodeRuntimeLifecycleD1Options = {
  auditRequestContext: {
    origin: 'internal',
    requestId: 'node-runtime-lifecycle-internal',
    correlationId: 'node-runtime-lifecycle-internal',
    source: {
      ip: { state: 'not-available', reason: 'internal runtime lifecycle has no client IP' },
      access: {
        state: 'not-available',
        reason: 'internal runtime lifecycle has no Access assertion',
      },
    },
  },
}

export class NodeRuntimeLifecycleD1Client extends Context.Service<
  NodeRuntimeLifecycleD1Client,
  NodeRuntimeLifecycleD1Database
>()('@gridora/node-runtime-lifecycle-d1/NodeRuntimeLifecycleD1Client') {}
export const NodeRuntimeLifecycleD1ClientLayer = (database: NodeRuntimeLifecycleD1Database) =>
  Layer.succeed(NodeRuntimeLifecycleD1Client, database)

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (value: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof value?.[key] === 'string' ? (value[key] as string) : undefined
const nullableText = (
  value: Record<string, unknown> | undefined,
  key: string,
): string | null | undefined => (value?.[key] === null ? null : text(value, key))
const integer = (value: Record<string, unknown> | undefined, key: string): number | undefined =>
  typeof value?.[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined
const one = (result: NodeRuntimeLifecycleD1Result | undefined): boolean =>
  (result?.meta?.changes ?? 0) === 1

interface PlayerEndpoint {
  readonly recordType: 'A' | 'AAAA'
  readonly target: string
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
  if (candidate.length < 2 || candidate.length > 45 || !/^[0-9a-f:]+$/.test(candidate))
    return undefined
  const doubleColon = candidate.indexOf('::')
  if (doubleColon !== -1 && candidate.indexOf('::', doubleColon + 1) !== -1) return undefined
  const groups = candidate.split(':').filter((group) => group.length > 0)
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
 * This read is authoritative only when the provider returned one exact
 * address per DNS family. Missing/invalid/ambiguous observations invalidate
 * old endpoint authority instead of silently retaining a stale target.
 */
const playerEndpointEvidence = (addresses: readonly string[]): PlayerEndpointEvidence => {
  if (addresses.length === 0) return { state: 'absent', reason: 'provider-addresses-missing' }
  const values = new Map<'A' | 'AAAA', string>()
  for (const rawAddress of addresses) {
    const ipv4 = normalizeIpv4(rawAddress.trim())
    const recordType: 'A' | 'AAAA' = ipv4 === undefined ? 'AAAA' : 'A'
    const target = ipv4 ?? normalizeIpv6(rawAddress)
    if (target === undefined) return { state: 'absent', reason: 'provider-addresses-invalid' }
    const previous = values.get(recordType)
    if (previous !== undefined && previous !== target)
      return { state: 'absent', reason: 'provider-addresses-ambiguous' }
    values.set(recordType, target)
  }
  const endpoints = (['A', 'AAAA'] as const).flatMap((recordType) => {
    const target = values.get(recordType)
    return target === undefined ? [] : [{ recordType, target }]
  })
  return endpoints.length === 0
    ? { state: 'absent', reason: 'provider-addresses-missing' }
    : { state: 'captured', endpoints }
}

const persistence = (operation: string) => new NodeRuntimeLifecyclePersistenceError({ operation })
const executionPersistence = (operation: string) =>
  new NodeRuntimeLifecycleExecutionPersistenceError({ operation })
const executionConflict = (operation: string) =>
  new NodeRuntimeLifecycleExecutionConflictError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => persistence(operation) })
const executionAttempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => executionPersistence(operation) })

const nodeQuery = `SELECT
  node.organization_id AS organizationId, node.id AS nodeId,
  node.provider_account_id AS providerAccountId, account.scope AS providerAccountScope,
  account.revision AS providerAccountRevision, allocation.revision AS providerAllocationRevision,
  account.credential_reference AS providerCredentialReference,
  CASE account.scope WHEN 'organization' THEN orgEnvelope.revision ELSE platformEnvelope.revision END
    AS providerCredentialRevision,
  node.provider_type AS providerType, node.provider_instance_id AS providerInstanceId,
  node.desired_state AS desiredState, node.observed_state AS observedState,
  node.desired_revision AS desiredRevision, node.observed_revision AS observedRevision,
  node.pending_lifecycle_operation_id AS pendingLifecycleOperationId
FROM nodes node
JOIN provider_accounts account
  ON account.id = node.provider_account_id AND account.provider_type = node.provider_type
JOIN provider_allocations allocation
  ON allocation.organization_id = node.organization_id AND allocation.provider_account_id = account.id
LEFT JOIN secret_envelopes orgEnvelope
  ON account.scope = 'organization' AND orgEnvelope.organization_id = node.organization_id
 AND orgEnvelope.id = account.credential_reference AND orgEnvelope.scope_type = 'provider-account'
 AND orgEnvelope.scope_id = account.id
LEFT JOIN platform_secret_envelopes platformEnvelope
  ON account.scope = 'platform' AND platformEnvelope.id = account.credential_reference
 AND platformEnvelope.scope_type = 'provider-account' AND platformEnvelope.scope_id = account.id
WHERE node.organization_id = ? AND node.id = ?
  AND account.status = 'active' AND allocation.status = 'active'
  AND (account.scope = 'platform' OR account.organization_id = node.organization_id)
  AND ((account.scope = 'organization' AND orgEnvelope.revision IS NOT NULL)
    OR (account.scope = 'platform' AND platformEnvelope.revision IS NOT NULL))`

const validDesired = (value: unknown): value is NodeRuntimeLifecycleNode['desiredState'] =>
  value === 'provisioning' ||
  value === 'ready' ||
  value === 'draining' ||
  value === 'stopped' ||
  value === 'deleted'
const validObserved = (value: unknown): value is NodeRuntimeObservedState =>
  value === 'unknown' ||
  value === 'provisioning' ||
  value === 'bootstrapping' ||
  value === 'ready' ||
  value === 'degraded' ||
  value === 'offline' ||
  value === 'deleting' ||
  value === 'deleted' ||
  value === 'failed'

const decodeNode = (
  value: unknown,
): Effect.Effect<NodeRuntimeLifecycleNode, NodeRuntimeLifecyclePersistenceError> =>
  Effect.sync(() => {
    const row = record(value)
    const providerType = text(row, 'providerType')
    const providerAccountScope = text(row, 'providerAccountScope')
    const desiredState = row?.desiredState
    const observedState = row?.observedState
    const required = [
      text(row, 'organizationId'),
      text(row, 'nodeId'),
      text(row, 'providerAccountId'),
      integer(row, 'providerAccountRevision'),
      integer(row, 'providerAllocationRevision'),
      text(row, 'providerCredentialReference'),
      integer(row, 'providerCredentialRevision'),
      nullableText(row, 'providerInstanceId'),
      integer(row, 'desiredRevision'),
      integer(row, 'observedRevision'),
      nullableText(row, 'pendingLifecycleOperationId'),
    ]
    if (
      required.some((item) => item === undefined) ||
      (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
      (providerAccountScope !== 'platform' && providerAccountScope !== 'organization') ||
      !validDesired(desiredState) ||
      !validObserved(observedState) ||
      (integer(row, 'providerAccountRevision') ?? 0) < 1 ||
      (integer(row, 'providerAllocationRevision') ?? 0) < 1 ||
      (integer(row, 'providerCredentialRevision') ?? 0) < 1 ||
      (integer(row, 'desiredRevision') ?? 0) < 1 ||
      (integer(row, 'observedRevision') ?? -1) < 0
    )
      throw new Error('invalid node runtime lifecycle row')
    return {
      organizationId: text(row, 'organizationId')!,
      nodeId: text(row, 'nodeId')!,
      providerAccountId: text(row, 'providerAccountId')!,
      providerAccountScope:
        providerAccountScope as NodeRuntimeLifecycleNode['providerAccountScope'],
      providerAccountRevision: integer(row, 'providerAccountRevision')!,
      providerAllocationRevision: integer(row, 'providerAllocationRevision')!,
      providerCredentialReference: text(row, 'providerCredentialReference')!,
      providerCredentialRevision: integer(row, 'providerCredentialRevision')!,
      providerType: providerType as NodeRuntimeLifecycleNode['providerType'],
      providerInstanceId: nullableText(row, 'providerInstanceId')!,
      desiredState,
      observedState,
      desiredRevision: integer(row, 'desiredRevision')!,
      observedRevision: integer(row, 'observedRevision')!,
      pendingLifecycleOperationId: nullableText(row, 'pendingLifecycleOperationId')!,
    }
  }).pipe(Effect.mapError(() => persistence('nodeRuntimeLifecycle.node.decode')))

const scopedNode = (
  database: NodeRuntimeLifecycleD1Database,
  organizationId: string,
  nodeId: string,
) =>
  Effect.gen(function* () {
    const found = yield* attempt('nodeRuntimeLifecycle.node.read', () =>
      database.prepare(nodeQuery).bind(organizationId, nodeId).first(),
    )
    if (found !== null) return yield* decodeNode(found)
    const raw = yield* attempt('nodeRuntimeLifecycle.node.presence', () =>
      database
        .prepare(`SELECT 1 AS present FROM nodes WHERE organization_id = ? AND id = ?`)
        .bind(organizationId, nodeId)
        .first(),
    )
    if (raw === null) return yield* new NodeRuntimeLifecycleNotFoundError({ nodeId })
    return yield* new NodeRuntimeLifecycleConflictError({ code: 'provider_binding_unavailable' })
  })

const decodeAcceptance = (
  responseJson: unknown,
  workflow: Record<string, unknown> | undefined,
): Effect.Effect<NodeRuntimeLifecycleAcceptance, NodeRuntimeLifecyclePersistenceError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        if (typeof responseJson !== 'string') throw new Error('missing response JSON')
        return JSON.parse(responseJson) as unknown
      },
      catch: () => persistence('nodeRuntimeLifecycle.replay.json'),
    })
    const state = text(workflow, 'workflowState')
    const attempts = integer(workflow, 'workflowAttempts')
    const lastError = nullableText(workflow, 'workflowLastError')
    if (
      (state !== 'pending' && state !== 'started' && state !== 'adopted') ||
      attempts === undefined ||
      attempts < 0 ||
      lastError === undefined
    )
      return yield* persistence('nodeRuntimeLifecycle.replay.workflow')
    return yield* Schema.decodeUnknownEffect(NodeRuntimeLifecycleAcceptanceContract, {
      onExcessProperty: 'error',
    })({
      ...(parsed as Record<string, unknown>),
      workflowStart: {
        ...(parsed as { readonly workflowStart?: Record<string, unknown> }).workflowStart,
        state,
        attempts,
        lastError,
      },
    }).pipe(Effect.mapError(() => persistence('nodeRuntimeLifecycle.replay.decode')))
  })

const replayQuery = `SELECT intent.request_fingerprint AS fingerprint, intent.response_json AS responseJson,
  start.state AS workflowState, start.attempts AS workflowAttempts, start.last_error AS workflowLastError
FROM node_runtime_lifecycle_intents intent
JOIN node_runtime_lifecycle_workflow_starts start
  ON start.organization_id = intent.organization_id AND start.operation_id = intent.operation_id
WHERE intent.organization_id = ? AND intent.idempotency_key = ?`

const findReplay = (
  database: NodeRuntimeLifecycleD1Database,
  input: {
    readonly organizationId: string
    readonly idempotencyKey: string
    readonly fingerprint: string
  },
) =>
  Effect.gen(function* () {
    const value = yield* attempt('nodeRuntimeLifecycle.replay.read', () =>
      database.prepare(replayQuery).bind(input.organizationId, input.idempotencyKey).first(),
    )
    if (value === null) return null
    const row = record(value)
    if (text(row, 'fingerprint') !== input.fingerprint)
      return yield* new NodeRuntimeLifecycleConflictError({ code: 'idempotency_payload_mismatch' })
    return yield* decodeAcceptance(text(row, 'responseJson'), row)
  })

type ActorFenceInput = {
  readonly organizationId: string
  readonly actorId: string
  readonly actorMembershipRevision?: number
}
const activeActorFence = `EXISTS (
  SELECT 1 FROM organizations organization
  JOIN identities actor ON actor.id = ?
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = actor.id
  WHERE organization.id = ? AND organization.status = 'active' AND actor.status = 'active'
    AND membership.status = 'active' AND membership.role IN ('owner', 'administrator', 'operator')
    AND (? IS NULL OR membership.revision = ?)
)`
const actorFenceBindings = (input: ActorFenceInput) => {
  const revision = input.actorMembershipRevision ?? null
  return [input.actorId, input.organizationId, revision, revision] as const
}
const requireActiveActor = (database: NodeRuntimeLifecycleD1Database, input: ActorFenceInput) =>
  Effect.gen(function* () {
    const allowed = yield* attempt('nodeRuntimeLifecycle.actor.fence', () =>
      database
        .prepare(`SELECT 1 AS allowed WHERE ${activeActorFence}`)
        .bind(...actorFenceBindings(input))
        .first(),
    )
    if (allowed === null)
      return yield* new NodeRuntimeLifecycleAuthorizationError({ code: 'operator_required' })
  })

const providerBindingFence = `EXISTS (
  SELECT 1 FROM provider_accounts account
  JOIN provider_allocations allocation
    ON allocation.organization_id = ? AND allocation.provider_account_id = account.id
  WHERE account.id = ? AND account.scope = ? AND account.revision = ?
    AND allocation.revision = ? AND account.credential_reference = ?
    AND account.provider_type = ? AND account.status = 'active' AND allocation.status = 'active'
    AND (account.scope = 'platform' OR account.organization_id = ?)
    AND ((account.scope = 'organization' AND EXISTS (
      SELECT 1 FROM secret_envelopes envelope
      WHERE envelope.organization_id = ? AND envelope.id = account.credential_reference
        AND envelope.scope_type = 'provider-account' AND envelope.scope_id = account.id
        AND envelope.revision = ?
    )) OR (account.scope = 'platform' AND EXISTS (
      SELECT 1 FROM platform_secret_envelopes envelope
      WHERE envelope.id = account.credential_reference AND envelope.scope_type = 'provider-account'
        AND envelope.scope_id = account.id AND envelope.revision = ?
    )))
)`

const bindingBindings = (node: NodeRuntimeLifecycleNode) =>
  [
    node.organizationId,
    node.providerAccountId,
    node.providerAccountScope,
    node.providerAccountRevision,
    node.providerAllocationRevision,
    node.providerCredentialReference,
    node.providerType,
    node.organizationId,
    node.organizationId,
    node.providerCredentialRevision,
    node.providerCredentialRevision,
  ] as const

const acceptanceFor = (input: NodeRuntimeLifecycleAtomicInput): NodeRuntimeLifecycleAcceptance => ({
  disposition: 'created',
  organizationId: input.command.organizationId,
  nodeId: input.command.nodeId,
  action: input.command.intent.action,
  operationId: input.identity.operationId,
  idempotencyKey: input.command.idempotencyKey,
  fingerprint: input.fingerprint,
  transition: input.transition,
  workflowStart: {
    id: input.identity.workflowStartRecordId,
    state: 'pending',
    attempts: 0,
    lastError: null,
  },
})

const acceptanceSummaryValue = (input: NodeRuntimeLifecycleAtomicInput) => ({
  schemaVersion: 1,
  operationId: input.identity.operationId,
  action: input.command.intent.action,
  previousDesiredState: input.transition.previousDesiredState,
  previousDesiredRevision: input.transition.previousDesiredRevision,
  desiredState: input.transition.desiredState,
  desiredRevision: input.transition.desiredRevision,
})
/**
 * The provider lifecycle operation stays queued. A separate, terminal
 * acceptance operation records the completed fact that the request was
 * accepted; migration 0028 forbids pointing a succeeded audit at queued work.
 */
const stageAcceptanceAudit = (
  database: NodeRuntimeLifecycleD1Database,
  input: NodeRuntimeLifecycleAtomicInput,
  requestContext: AuditRequestContextValue,
): Effect.Effect<
  { readonly statement: NodeRuntimeLifecycleD1Statement; readonly summaryJson: string },
  NodeRuntimeLifecyclePersistenceError
> =>
  Effect.gen(function* () {
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.command.organizationId,
      actor: { type: 'human', id: input.command.actorId },
      action: `node.runtime.${input.command.intent.action}.accepted`,
      target: { type: 'node', id: input.command.nodeId },
      before: {
        state: 'captured',
        summary: {
          desiredState: input.transition.previousDesiredState,
          desiredRevision: input.transition.previousDesiredRevision,
        },
      },
      after: { state: 'captured', summary: acceptanceSummaryValue(input) },
      operationId: input.identity.auditOperationId,
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(
      // The command correlation is the canonical edge correlation persisted on
      // the operation. Keep the source/request id from the real edge context.
      Effect.provideService(AuditRequestContext, {
        ...requestContext,
        correlationId: input.command.correlationId,
      }),
      Effect.mapError(() => persistence('nodeRuntimeLifecycle.audit.envelope')),
    )
    const stage = yield* stageAuditEnvelope(
      'tenant',
      input.identity.auditEventId,
      envelope,
      input.now,
    ).pipe(Effect.mapError(() => persistence('nodeRuntimeLifecycle.audit.stage')))
    // `auditEventSummaryJson` deliberately shares the exact post-state
    // serialization with the compact row checked by migration 0028.
    return {
      statement: database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })
const acceptanceOutbox = (input: NodeRuntimeLifecycleAtomicInput) =>
  JSON.stringify({
    schemaVersion: 1,
    organizationId: input.command.organizationId,
    partitionKey: `${input.command.organizationId}:node:${input.command.nodeId}`,
    nodeId: input.command.nodeId,
    operationId: input.identity.operationId,
    action: input.command.intent.action,
    desiredRevision: input.transition.desiredRevision,
  })

const diagnoseAcceptance = (
  database: NodeRuntimeLifecycleD1Database,
  input: NodeRuntimeLifecycleAtomicInput,
) =>
  Effect.gen(function* () {
    yield* requireActiveActor(database, {
      organizationId: input.command.organizationId,
      actorId: input.command.actorId,
      ...(input.command.actorMembershipRevision === undefined
        ? {}
        : { actorMembershipRevision: input.command.actorMembershipRevision }),
    })
    const replay = yield* findReplay(database, {
      organizationId: input.command.organizationId,
      idempotencyKey: input.command.idempotencyKey,
      fingerprint: input.fingerprint,
    })
    if (replay !== null) return replay
    const current = yield* scopedNode(database, input.command.organizationId, input.command.nodeId)
    if (current.desiredRevision !== input.transition.previousDesiredRevision)
      return yield* new NodeRuntimeLifecycleConflictError({ code: 'desired_revision_mismatch' })
    if (current.pendingLifecycleOperationId !== null)
      return yield* new NodeRuntimeLifecycleConflictError({ code: 'node_busy' })
    if (current.providerInstanceId === null)
      return yield* new NodeRuntimeLifecycleConflictError({ code: 'provider_instance_missing' })
    if (current.desiredState !== input.transition.previousDesiredState)
      return yield* new NodeRuntimeLifecycleConflictError({ code: 'invalid_desired_state' })
    return yield* persistence('nodeRuntimeLifecycle.accept')
  })

export const makeNodeRuntimeLifecycleRepositoryD1 = (
  database: NodeRuntimeLifecycleD1Database,
  options: Partial<NodeRuntimeLifecycleD1Options> = {},
): NodeRuntimeLifecycleRepositoryShape => {
  const configured = { ...defaults, ...options }
  const repository: NodeRuntimeLifecycleRepositoryShape = {
    findReplay: (input) => findReplay(database, input),
    getNode: (organizationId, nodeId) => scopedNode(database, organizationId, nodeId),
    acceptAtomic: (input) =>
      Effect.gen(function* () {
        const prior = yield* findReplay(database, {
          organizationId: input.command.organizationId,
          idempotencyKey: input.command.idempotencyKey,
          fingerprint: input.fingerprint,
        })
        if (prior !== null) return prior
        const acceptance = acceptanceFor(input)
        const responseJson = JSON.stringify(acceptance)
        const node = input.node
        const actor = {
          organizationId: input.command.organizationId,
          actorId: input.command.actorId,
          ...(input.command.actorMembershipRevision === undefined
            ? {}
            : { actorMembershipRevision: input.command.actorMembershipRevision }),
        }
        const nodeUpdate = database
          .prepare(`UPDATE nodes SET desired_state = ?, desired_revision = ?,
            pending_lifecycle_operation_id = ?, reconciliation_error = 'runtime_lifecycle_pending',
            updated_at = ?
            WHERE organization_id = ? AND id = ? AND desired_state = ? AND desired_revision = ?
              AND pending_lifecycle_operation_id IS NULL AND provider_instance_id IS NOT NULL
              AND provider_account_id = ? AND provider_type = ?
              AND ${providerBindingFence} AND ${activeActorFence}`)
          .bind(
            input.transition.desiredState,
            input.transition.desiredRevision,
            input.identity.operationId,
            input.now,
            input.command.organizationId,
            input.command.nodeId,
            input.transition.previousDesiredState,
            input.transition.previousDesiredRevision,
            node.providerAccountId,
            node.providerType,
            ...bindingBindings(node),
            ...actorFenceBindings(actor),
          )
        const operationInsert = database
          .prepare(`INSERT INTO operations
            (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
             idempotency_key, correlation_id, revision, created_at, updated_at)
            SELECT ?, ?, ?, 'node', ?, ?, 'queued', 0, ?, ?, 1, ?, ?
            FROM nodes node WHERE node.organization_id = ? AND node.id = ?
              AND node.pending_lifecycle_operation_id = ? AND node.desired_state = ?
              AND node.desired_revision = ?`)
          .bind(
            input.identity.operationId,
            input.command.organizationId,
            `node.runtime.${input.command.intent.action}`,
            input.command.nodeId,
            input.command.actorId,
            input.command.idempotencyKey,
            input.command.correlationId,
            input.now,
            input.now,
            input.command.organizationId,
            input.command.nodeId,
            input.identity.operationId,
            input.transition.desiredState,
            input.transition.desiredRevision,
          )
        const workflowInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_workflow_starts
            (organization_id, operation_id, start_record_id, workflow_type, workflow_instance_id,
             params_fingerprint, state, attempts, last_error, created_at, updated_at)
            SELECT ?, operation.id, ?, 'NodeRuntimeLifecycleWorkflow', operation.id, ?,
              'pending', 0, NULL, ?, ?
            FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?
              AND operation.status = 'queued' AND operation.revision = 1`)
          .bind(
            input.command.organizationId,
            input.identity.workflowStartRecordId,
            input.fingerprint,
            input.now,
            input.now,
            input.command.organizationId,
            input.identity.operationId,
          )
        const executionInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_executions
            (organization_id, operation_id, node_id, action, provider_account_id, provider_account_scope,
             provider_account_revision, provider_allocation_revision, provider_credential_reference,
             provider_credential_revision, provider_type, provider_instance_id, previous_desired_state,
             previous_desired_revision, desired_state, desired_revision, state, lease_owner, lease_token,
             lease_until, attempt, action_requested_at, last_provider_state, reboot_confirmed, result_json,
             failure_code, revision, created_at, updated_at)
            SELECT ?, operation.id, node.id, ?, node.provider_account_id, ?, ?, ?, ?, ?, node.provider_type,
              node.provider_instance_id, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL, NULL, 0, NULL,
              NULL, 1, ?, ?
            FROM nodes node JOIN operations operation
              ON operation.organization_id = node.organization_id AND operation.id = node.pending_lifecycle_operation_id
            WHERE node.organization_id = ? AND node.id = ? AND operation.id = ?
              AND operation.status = 'queued' AND node.desired_state = ? AND node.desired_revision = ?
              AND node.provider_instance_id IS NOT NULL AND ${providerBindingFence}`)
          .bind(
            input.command.organizationId,
            input.command.intent.action,
            node.providerAccountScope,
            node.providerAccountRevision,
            node.providerAllocationRevision,
            node.providerCredentialReference,
            node.providerCredentialRevision,
            input.transition.previousDesiredState,
            input.transition.previousDesiredRevision,
            input.transition.desiredState,
            input.transition.desiredRevision,
            input.now,
            input.now,
            input.command.organizationId,
            input.command.nodeId,
            input.identity.operationId,
            input.transition.desiredState,
            input.transition.desiredRevision,
            ...bindingBindings(node),
          )
        // This is not a relabelled provider operation. It is the distinct,
        // terminal fact that the queued runtime request was accepted with the
        // exact transition above. The child idempotency key is deterministic
        // and scoped by the immutable parent operation identity.
        const auditOperationInsert = database
          .prepare(`INSERT INTO operations
            (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
             idempotency_key, correlation_id, revision, created_at, updated_at)
            SELECT ?, ?, ?, 'node', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?
            FROM operations lifecycle
            JOIN node_runtime_lifecycle_executions execution
              ON execution.organization_id = lifecycle.organization_id
             AND execution.operation_id = lifecycle.id
            WHERE lifecycle.organization_id = ? AND lifecycle.id = ?
              AND lifecycle.type = ? AND lifecycle.status = 'queued'
              AND execution.node_id = ? AND execution.state = 'pending'`)
          .bind(
            input.identity.auditOperationId,
            input.command.organizationId,
            `node.runtime.${input.command.intent.action}.accepted`,
            input.command.nodeId,
            input.command.actorId,
            `audit-acceptance-${input.identity.operationId}`,
            input.command.correlationId,
            input.now,
            input.now,
            input.command.organizationId,
            input.identity.operationId,
            `node.runtime.${input.command.intent.action}`,
            input.command.nodeId,
          )
        const auditStage = yield* stageAcceptanceAudit(
          database,
          input,
          configured.auditRequestContext,
        )
        const auditInsert = database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, auditOperation.organization_id, auditOperation.actor_id, ?, 'node', auditOperation.resource_id,
              'succeeded', auditOperation.correlation_id, ?, ?
            FROM operations auditOperation
            JOIN operations lifecycle
              ON lifecycle.organization_id = auditOperation.organization_id
            JOIN node_runtime_lifecycle_executions execution
              ON execution.organization_id = lifecycle.organization_id AND execution.operation_id = lifecycle.id
            WHERE auditOperation.organization_id = ? AND auditOperation.id = ?
              AND auditOperation.type = ? AND auditOperation.status = 'succeeded'
              AND lifecycle.id = ? AND execution.state = 'pending'`)
          .bind(
            input.identity.auditEventId,
            `node.runtime.${input.command.intent.action}.accepted`,
            auditStage.summaryJson,
            input.now,
            input.command.organizationId,
            input.identity.auditOperationId,
            `node.runtime.${input.command.intent.action}.accepted`,
            input.identity.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, created_at)
            SELECT ?, operation.organization_id, 'node.runtime.lifecycle.requested', 'node',
              operation.resource_id, ?, 'pending', 0, ?, ?
            FROM operations operation JOIN audit_events audit
              ON audit.organization_id = operation.organization_id AND audit.id = ?
            WHERE operation.organization_id = ? AND operation.id = ?
              AND audit.action = ? AND audit.target_id = operation.resource_id`)
          .bind(
            input.identity.outboxEventId,
            acceptanceOutbox(input),
            input.now,
            input.now,
            input.identity.auditEventId,
            input.command.organizationId,
            input.identity.operationId,
            `node.runtime.${input.command.intent.action}.accepted`,
          )
        const intentInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_intents
            (organization_id, idempotency_key, request_fingerprint, action, node_id, operation_id,
             provider_account_id, provider_account_scope, provider_account_revision,
             provider_allocation_revision, provider_credential_reference, provider_credential_revision,
             previous_desired_state, previous_desired_revision, desired_state, desired_revision,
             workflow_start_record_id, audit_event_id, outbox_event_id, response_json, created_at)
            SELECT ?, ?, ?, ?, node.id, ?, node.provider_account_id, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?
            FROM nodes node JOIN node_runtime_lifecycle_executions execution
              ON execution.organization_id = node.organization_id AND execution.operation_id = node.pending_lifecycle_operation_id
            JOIN node_runtime_lifecycle_workflow_starts start
              ON start.organization_id = execution.organization_id AND start.operation_id = execution.operation_id
            JOIN audit_events audit ON audit.organization_id = node.organization_id AND audit.id = ?
            JOIN outbox event ON event.organization_id = node.organization_id AND event.id = ?
            WHERE node.organization_id = ? AND node.id = ? AND node.pending_lifecycle_operation_id = ?
              AND node.desired_state = ? AND node.desired_revision = ? AND execution.state = 'pending'
              AND start.start_record_id = ? AND start.state = 'pending'
              AND audit.action = ? AND event.event_type = 'node.runtime.lifecycle.requested'`)
          .bind(
            input.command.organizationId,
            input.command.idempotencyKey,
            input.fingerprint,
            input.command.intent.action,
            input.identity.operationId,
            node.providerAccountScope,
            node.providerAccountRevision,
            node.providerAllocationRevision,
            node.providerCredentialReference,
            node.providerCredentialRevision,
            input.transition.previousDesiredState,
            input.transition.previousDesiredRevision,
            input.transition.desiredState,
            input.transition.desiredRevision,
            input.identity.workflowStartRecordId,
            input.identity.auditEventId,
            input.identity.outboxEventId,
            responseJson,
            input.now,
            input.identity.auditEventId,
            input.identity.outboxEventId,
            input.command.organizationId,
            input.command.nodeId,
            input.identity.operationId,
            input.transition.desiredState,
            input.transition.desiredRevision,
            input.identity.workflowStartRecordId,
            `node.runtime.${input.command.intent.action}.accepted`,
          )
        const committed = yield* Effect.result(
          attempt('nodeRuntimeLifecycle.accept.batch', () =>
            database.batch([
              nodeUpdate,
              operationInsert,
              workflowInsert,
              executionInsert,
              auditOperationInsert,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              intentInsert,
            ]),
          ),
        )
        if (
          committed._tag === 'Success' &&
          committed.success.length === 9 &&
          committed.success.every(one)
        )
          return acceptance
        return yield* diagnoseAcceptance(database, input)
      }),
    markWorkflowStarted: (organizationId, operationId) =>
      Effect.gen(function* () {
        const result = yield* attempt('nodeRuntimeLifecycle.workflow.start', () =>
          database.batch([
            database
              .prepare(`UPDATE node_runtime_lifecycle_workflow_starts
                SET state = 'started', attempts = attempts + 1, last_error = NULL, updated_at = ?
                WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`)
              .bind(new Date().toISOString(), organizationId, operationId),
          ]),
        )
        if (one(result[0])) return
        const current = yield* attempt('nodeRuntimeLifecycle.workflow.start.read', () =>
          database
            .prepare(`SELECT state FROM node_runtime_lifecycle_workflow_starts
              WHERE organization_id = ? AND operation_id = ?`)
            .bind(organizationId, operationId)
            .first(),
        )
        const state = text(record(current), 'state')
        if (state === 'started' || state === 'adopted') return
        return yield* persistence('nodeRuntimeLifecycle.workflow.start')
      }),
    markWorkflowAdopted: (organizationId, operationId) =>
      Effect.gen(function* () {
        const result = yield* attempt('nodeRuntimeLifecycle.workflow.adopt', () =>
          database.batch([
            database
              .prepare(`UPDATE node_runtime_lifecycle_workflow_starts
                SET state = 'adopted', attempts = attempts + 1, last_error = NULL, updated_at = ?
                WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`)
              .bind(new Date().toISOString(), organizationId, operationId),
          ]),
        )
        if (one(result[0])) return
        const current = yield* attempt('nodeRuntimeLifecycle.workflow.adopt.read', () =>
          database
            .prepare(`SELECT state FROM node_runtime_lifecycle_workflow_starts
              WHERE organization_id = ? AND operation_id = ?`)
            .bind(organizationId, operationId)
            .first(),
        )
        const state = text(record(current), 'state')
        if (state === 'started' || state === 'adopted') return
        return yield* persistence('nodeRuntimeLifecycle.workflow.adopt')
      }),
    recordWorkflowStartFailure: (organizationId, operationId, _message) =>
      Effect.gen(function* () {
        const result = yield* attempt('nodeRuntimeLifecycle.workflow.failure', () =>
          database.batch([
            database
              .prepare(`UPDATE node_runtime_lifecycle_workflow_starts
                SET attempts = attempts + 1, last_error = 'workflow_start_pending', updated_at = ?
                WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`)
              .bind(new Date().toISOString(), organizationId, operationId),
          ]),
        )
        if (one(result[0])) return
        const current = yield* attempt('nodeRuntimeLifecycle.workflow.failure.read', () =>
          database
            .prepare(`SELECT state FROM node_runtime_lifecycle_workflow_starts
              WHERE organization_id = ? AND operation_id = ?`)
            .bind(organizationId, operationId)
            .first(),
        )
        if (text(record(current), 'state') === 'started') return
        return yield* persistence('nodeRuntimeLifecycle.workflow.failure')
      }),
  }
  return repository
}

export const NodeRuntimeLifecycleRepositoryD1Live = Layer.effect(
  NodeRuntimeLifecycleRepository,
  Effect.gen(function* () {
    return NodeRuntimeLifecycleRepository.of(
      makeNodeRuntimeLifecycleRepositoryD1(yield* NodeRuntimeLifecycleD1Client),
    )
  }),
)

type ExecutionSnapshot = {
  readonly reservation: NodeRuntimeLifecycleExecutionReservation
  /** The durable operation remains the user-visible actor/correlation source. */
  readonly auditActorId: string
  readonly auditCorrelationId: string
  readonly state:
    | 'pending'
    | 'leased'
    | 'action-requested'
    | 'waiting-observation'
    | 'reconciliation-required'
    | 'succeeded'
    | 'failed-terminal'
  readonly lease: NodeRuntimeLifecycleExecutionLease | null
  readonly observedState: NodeRuntimeObservedState
  readonly observedRevision: number
  readonly resultJson: string | null
}

const executionQuery = `SELECT execution.organization_id AS organizationId, execution.operation_id AS operationId,
  operation.actor_id AS auditActorId, operation.correlation_id AS auditCorrelationId,
  execution.node_id AS nodeId, execution.action, execution.provider_account_id AS providerAccountId,
  execution.provider_account_scope AS providerAccountScope,
  execution.provider_account_revision AS providerAccountRevision,
  execution.provider_allocation_revision AS providerAllocationRevision,
  execution.provider_credential_reference AS providerCredentialReference,
  execution.provider_credential_revision AS providerCredentialRevision,
  execution.provider_type AS providerType, execution.provider_instance_id AS providerInstanceId,
  execution.previous_desired_state AS previousDesiredState,
  execution.previous_desired_revision AS previousDesiredRevision,
  execution.desired_state AS desiredState, execution.desired_revision AS desiredRevision,
  execution.state AS executionState, execution.lease_owner AS leaseOwner,
  execution.lease_token AS leaseToken, execution.lease_until AS leaseUntil,
  execution.attempt, execution.result_json AS resultJson,
  node.observed_state AS observedState, node.observed_revision AS observedRevision
FROM node_runtime_lifecycle_executions execution
JOIN operations operation
  ON operation.organization_id = execution.organization_id AND operation.id = execution.operation_id
JOIN nodes node ON node.organization_id = execution.organization_id AND node.id = execution.node_id
JOIN provider_accounts account ON account.id = execution.provider_account_id
JOIN provider_allocations allocation
  ON allocation.organization_id = execution.organization_id AND allocation.provider_account_id = account.id
LEFT JOIN secret_envelopes orgEnvelope
  ON account.scope = 'organization' AND orgEnvelope.organization_id = execution.organization_id
 AND orgEnvelope.id = account.credential_reference AND orgEnvelope.scope_type = 'provider-account'
 AND orgEnvelope.scope_id = account.id
LEFT JOIN platform_secret_envelopes platformEnvelope
  ON account.scope = 'platform' AND platformEnvelope.id = account.credential_reference
 AND platformEnvelope.scope_type = 'provider-account' AND platformEnvelope.scope_id = account.id
WHERE execution.organization_id = ? AND execution.operation_id = ?
  AND (
    execution.state IN ('succeeded', 'failed-terminal', 'reconciliation-required')
    OR (
      node.pending_lifecycle_operation_id = execution.operation_id
      AND node.desired_state = execution.desired_state AND node.desired_revision = execution.desired_revision
      AND node.provider_account_id = execution.provider_account_id
      AND node.provider_type = execution.provider_type
      AND node.provider_instance_id = execution.provider_instance_id
      AND account.scope = execution.provider_account_scope
      AND account.revision = execution.provider_account_revision
      AND account.credential_reference = execution.provider_credential_reference
      AND account.provider_type = execution.provider_type AND account.status = 'active'
      AND allocation.status = 'active' AND allocation.revision = execution.provider_allocation_revision
      AND (account.scope = 'platform' OR account.organization_id = execution.organization_id)
      AND ((account.scope = 'organization' AND orgEnvelope.revision = execution.provider_credential_revision)
        OR (account.scope = 'platform' AND platformEnvelope.revision = execution.provider_credential_revision))
    )
  )`

const validExecutionState = (value: unknown): value is ExecutionSnapshot['state'] =>
  value === 'pending' ||
  value === 'leased' ||
  value === 'action-requested' ||
  value === 'waiting-observation' ||
  value === 'reconciliation-required' ||
  value === 'succeeded' ||
  value === 'failed-terminal'
const validAction = (value: unknown): value is NodeRuntimeLifecycleExecutionReservation['action'] =>
  value === 'start' || value === 'stop' || value === 'reboot' || value === 'reconcile'

const decodeExecutionSnapshot = (
  value: unknown,
): Effect.Effect<ExecutionSnapshot, NodeRuntimeLifecycleExecutionPersistenceError> =>
  Effect.sync(() => {
    const row = record(value)
    const state = text(row, 'executionState')
    const action = row?.action
    const providerType = text(row, 'providerType')
    const scope = text(row, 'providerAccountScope')
    const desiredState = text(row, 'desiredState')
    const previousDesiredState = text(row, 'previousDesiredState')
    const observedState = row?.observedState
    const attemptNumber = integer(row, 'attempt')
    const leaseOwner = nullableText(row, 'leaseOwner')
    const leaseToken = nullableText(row, 'leaseToken')
    const leaseUntil = nullableText(row, 'leaseUntil')
    const hasLease =
      typeof leaseOwner === 'string' &&
      typeof leaseToken === 'string' &&
      typeof leaseUntil === 'string'
    const hasNoLease = leaseOwner === null && leaseToken === null && leaseUntil === null
    if (
      !validExecutionState(state) ||
      !validAction(action) ||
      (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
      (scope !== 'platform' && scope !== 'organization') ||
      (desiredState !== 'ready' && desiredState !== 'stopped') ||
      (previousDesiredState !== 'ready' && previousDesiredState !== 'stopped') ||
      !validObserved(observedState) ||
      attemptNumber === undefined ||
      attemptNumber < 0 ||
      integer(row, 'previousDesiredRevision') === undefined ||
      integer(row, 'desiredRevision') === undefined ||
      integer(row, 'observedRevision') === undefined ||
      [
        text(row, 'organizationId'),
        text(row, 'operationId'),
        text(row, 'auditActorId'),
        text(row, 'auditCorrelationId'),
        text(row, 'nodeId'),
        text(row, 'providerAccountId'),
        integer(row, 'providerAccountRevision'),
        integer(row, 'providerAllocationRevision'),
        text(row, 'providerCredentialReference'),
        integer(row, 'providerCredentialRevision'),
        text(row, 'providerInstanceId'),
        nullableText(row, 'resultJson'),
      ].some((item) => item === undefined) ||
      ((state === 'leased' || state === 'action-requested') && !hasLease) ||
      (state !== 'leased' && state !== 'action-requested' && !hasNoLease)
    )
      throw new Error('invalid execution row')
    const lease: NodeRuntimeLifecycleExecutionLease | null = hasLease
      ? { owner: leaseOwner, token: leaseToken, expiresAt: leaseUntil, attempt: attemptNumber }
      : null
    return {
      reservation: {
        organizationId: text(row, 'organizationId')!,
        nodeId: text(row, 'nodeId')!,
        operationId: text(row, 'operationId')!,
        action,
        providerType: providerType as NodeRuntimeLifecycleExecutionReservation['providerType'],
        providerInstanceId: text(row, 'providerInstanceId')!,
        credentialBinding: {
          providerAccountId: text(row, 'providerAccountId')!,
          providerAccountScope:
            scope as NodeRuntimeLifecycleExecutionReservation['credentialBinding']['providerAccountScope'],
          providerAccountRevision: integer(row, 'providerAccountRevision')!,
          providerAllocationRevision: integer(row, 'providerAllocationRevision')!,
          providerCredentialReference: text(row, 'providerCredentialReference')!,
          providerCredentialRevision: integer(row, 'providerCredentialRevision')!,
        },
        previousDesiredState:
          previousDesiredState as NodeRuntimeLifecycleExecutionReservation['previousDesiredState'],
        previousDesiredRevision: integer(row, 'previousDesiredRevision')!,
        desiredState: desiredState as NodeRuntimeLifecycleExecutionReservation['desiredState'],
        desiredRevision: integer(row, 'desiredRevision')!,
      },
      auditActorId: text(row, 'auditActorId')!,
      auditCorrelationId: text(row, 'auditCorrelationId')!,
      state,
      lease,
      observedState,
      observedRevision: integer(row, 'observedRevision')!,
      resultJson: nullableText(row, 'resultJson')!,
    }
  }).pipe(Effect.mapError(() => executionPersistence('nodeRuntimeLifecycle.execution.decode')))

const decodeExecutionResult = (
  value: string | null,
): Effect.Effect<
  NodeRuntimeLifecycleExecutionResult,
  NodeRuntimeLifecycleExecutionPersistenceError
> =>
  Effect.try({
    try: () => {
      if (value === null) throw new Error('missing terminal execution result')
      const parsed = JSON.parse(value) as unknown
      const row = record(parsed)
      const state = text(row, 'state')
      const operationStatus = text(row, 'operationStatus')
      const action = row?.action
      const providerState = text(row, 'providerState')
      const observedState = row?.observedState
      if (
        text(row, 'organizationId') === undefined ||
        text(row, 'nodeId') === undefined ||
        text(row, 'operationId') === undefined ||
        !validAction(action) ||
        (state !== 'succeeded' &&
          state !== 'waiting-observation' &&
          state !== 'reconciliation-required' &&
          state !== 'failed-terminal') ||
        (operationStatus !== 'succeeded' &&
          operationStatus !== 'waiting_external' &&
          operationStatus !== 'failed_terminal') ||
        (providerState !== 'active' &&
          providerState !== 'stopped' &&
          providerState !== 'transitional' &&
          providerState !== 'missing' &&
          providerState !== 'unknown') ||
        typeof row?.rebootConfirmed !== 'boolean' ||
        !validObserved(observedState)
      )
        throw new Error('invalid execution result')
      return {
        organizationId: text(row, 'organizationId')!,
        nodeId: text(row, 'nodeId')!,
        operationId: text(row, 'operationId')!,
        action,
        state,
        operationStatus,
        providerState,
        rebootConfirmed: row.rebootConfirmed,
        observedState,
      }
    },
    catch: () => executionPersistence('nodeRuntimeLifecycle.execution.result.decode'),
  })

const executionRawExists = (
  database: NodeRuntimeLifecycleD1Database,
  organizationId: string,
  operationId: string,
) =>
  executionAttempt('nodeRuntimeLifecycle.execution.presence', () =>
    database
      .prepare(`SELECT 1 AS present FROM node_runtime_lifecycle_executions
        WHERE organization_id = ? AND operation_id = ?`)
      .bind(organizationId, operationId)
      .first(),
  )

const loadExecution = (
  database: NodeRuntimeLifecycleD1Database,
  organizationId: string,
  operationId: string,
) =>
  Effect.gen(function* () {
    const found = yield* executionAttempt('nodeRuntimeLifecycle.execution.read', () =>
      database.prepare(executionQuery).bind(organizationId, operationId).first(),
    )
    if (found !== null) return yield* decodeExecutionSnapshot(found)
    const raw = yield* executionRawExists(database, organizationId, operationId)
    if (raw !== null)
      return yield* executionConflict('nodeRuntimeLifecycle.execution.provider-binding-unavailable')
    return yield* executionConflict('nodeRuntimeLifecycle.execution.not-found')
  })

const executionBindingFence = `EXISTS (
  SELECT 1 FROM provider_accounts account
  JOIN provider_allocations allocation
    ON allocation.organization_id = node_runtime_lifecycle_executions.organization_id
   AND allocation.provider_account_id = account.id
  WHERE account.id = node_runtime_lifecycle_executions.provider_account_id
    AND account.scope = node_runtime_lifecycle_executions.provider_account_scope
    AND account.revision = node_runtime_lifecycle_executions.provider_account_revision
    AND account.credential_reference = node_runtime_lifecycle_executions.provider_credential_reference
    AND account.provider_type = node_runtime_lifecycle_executions.provider_type
    AND account.status = 'active' AND allocation.status = 'active'
    AND allocation.revision = node_runtime_lifecycle_executions.provider_allocation_revision
    AND (account.scope = 'platform' OR account.organization_id = node_runtime_lifecycle_executions.organization_id)
    AND ((account.scope = 'organization' AND EXISTS (
      SELECT 1 FROM secret_envelopes envelope
      WHERE envelope.organization_id = node_runtime_lifecycle_executions.organization_id
        AND envelope.id = account.credential_reference AND envelope.scope_type = 'provider-account'
        AND envelope.scope_id = account.id
        AND envelope.revision = node_runtime_lifecycle_executions.provider_credential_revision
    )) OR (account.scope = 'platform' AND EXISTS (
      SELECT 1 FROM platform_secret_envelopes envelope
      WHERE envelope.id = account.credential_reference AND envelope.scope_type = 'provider-account'
        AND envelope.scope_id = account.id
        AND envelope.revision = node_runtime_lifecycle_executions.provider_credential_revision
    )))
)`

const executionNodeFence = `EXISTS (
  SELECT 1 FROM nodes node
  WHERE node.organization_id = node_runtime_lifecycle_executions.organization_id
    AND node.id = node_runtime_lifecycle_executions.node_id
    AND node.pending_lifecycle_operation_id = node_runtime_lifecycle_executions.operation_id
    AND node.desired_state = node_runtime_lifecycle_executions.desired_state
    AND node.desired_revision = node_runtime_lifecycle_executions.desired_revision
    AND node.provider_account_id = node_runtime_lifecycle_executions.provider_account_id
    AND node.provider_type = node_runtime_lifecycle_executions.provider_type
    AND node.provider_instance_id = node_runtime_lifecycle_executions.provider_instance_id
)`

type ObservationDecision = {
  readonly result: NodeRuntimeLifecycleExecutionResult
  readonly desiredState: 'ready' | 'stopped'
  readonly desiredRevision: number
  readonly clearPending: boolean
  readonly reconciliationError: string | null
  readonly failureCode: 'action_unproven_not_applied' | 'action_delivery_unproven' | null
}

const decisionFor = (input: {
  readonly snapshot: ExecutionSnapshot
  readonly observation: {
    readonly providerState: NodeRuntimeLifecycleExecutionResult['providerState']
    readonly rebootConfirmed: boolean
    readonly actionNotApplied: boolean
  }
  readonly recovery: NodeRuntimeLifecycleObservationRecovery
}): ObservationDecision => {
  const { reservation } = input.snapshot
  const definiteNonApplication =
    input.recovery === 'action-requested-expired' &&
    input.observation.actionNotApplied &&
    ((reservation.action === 'start' && input.observation.providerState === 'stopped') ||
      (reservation.action === 'stop' && input.observation.providerState === 'active'))
  if (definiteNonApplication) {
    const observedState: NodeRuntimeObservedState =
      input.observation.providerState === 'stopped' ? 'offline' : 'degraded'
    return {
      result: {
        organizationId: reservation.organizationId,
        nodeId: reservation.nodeId,
        operationId: reservation.operationId,
        action: reservation.action,
        state: 'reconciliation-required',
        operationStatus: 'failed_terminal',
        providerState: input.observation.providerState,
        rebootConfirmed: input.observation.rebootConfirmed,
        observedState,
      },
      desiredState: reservation.previousDesiredState,
      desiredRevision: reservation.desiredRevision + 1,
      clearPending: true,
      reconciliationError: 'provider_action_unproven_not_applied',
      failureCode: 'action_unproven_not_applied',
    }
  }
  const readyConverged =
    reservation.desiredState === 'ready' &&
    input.observation.providerState === 'active' &&
    input.snapshot.observedState === 'ready' &&
    (reservation.action !== 'reboot' || input.observation.rebootConfirmed)
  const stoppedConverged =
    reservation.desiredState === 'stopped' && input.observation.providerState === 'stopped'
  const succeeded =
    (reservation.action === 'start' && readyConverged) ||
    (reservation.action === 'stop' && stoppedConverged) ||
    (reservation.action === 'reboot' && readyConverged) ||
    (reservation.action === 'reconcile' && (readyConverged || stoppedConverged))
  const observedState: NodeRuntimeObservedState =
    input.observation.providerState === 'stopped'
      ? 'offline'
      : input.observation.providerState === 'active'
        ? reservation.desiredState === 'ready' && succeeded
          ? 'ready'
          : reservation.desiredState === 'ready'
            ? 'bootstrapping'
            : 'degraded'
        : input.observation.providerState === 'transitional'
          ? reservation.desiredState === 'ready'
            ? 'bootstrapping'
            : 'degraded'
          : input.observation.providerState === 'missing'
            ? 'failed'
            : 'degraded'
  // A lease can be committed before a Worker gets CPU time for the HTTP call. If that Worker
  // dies and the provider cannot prove either delivery or non-delivery, repeating the action is
  // unsafe. End the bounded recovery attempt with a released reconciliation item instead. For a
  // reboot this deliberately requires manual confirmation; an active VM does not prove a reboot.
  if (
    (input.recovery === 'action-requested-expired' || input.recovery === 'dispatch-uncertain') &&
    !succeeded
  )
    return {
      result: {
        organizationId: reservation.organizationId,
        nodeId: reservation.nodeId,
        operationId: reservation.operationId,
        action: reservation.action,
        state: 'reconciliation-required',
        operationStatus: 'failed_terminal',
        providerState: input.observation.providerState,
        rebootConfirmed: input.observation.rebootConfirmed,
        observedState,
      },
      desiredState: reservation.previousDesiredState,
      desiredRevision: reservation.desiredRevision + 1,
      clearPending: true,
      reconciliationError:
        reservation.action === 'reboot'
          ? 'provider_reboot_delivery_unproven_manual_review'
          : 'provider_action_delivery_unproven',
      failureCode: 'action_delivery_unproven',
    }
  return {
    result: {
      organizationId: reservation.organizationId,
      nodeId: reservation.nodeId,
      operationId: reservation.operationId,
      action: reservation.action,
      state: succeeded ? 'succeeded' : 'waiting-observation',
      operationStatus: succeeded ? 'succeeded' : 'waiting_external',
      providerState: input.observation.providerState,
      rebootConfirmed: input.observation.rebootConfirmed,
      observedState,
    },
    desiredState: reservation.desiredState,
    desiredRevision: reservation.desiredRevision,
    clearPending: succeeded,
    reconciliationError: succeeded
      ? null
      : `provider_${input.observation.providerState}_not_converged`,
    failureCode: null,
  }
}

const executionResultJson = (result: NodeRuntimeLifecycleExecutionResult): string =>
  JSON.stringify(result)
const terminalAuditId = (operationId: string) => `audit_node_runtime_complete:${operationId}`
const terminalOutboxId = (operationId: string) => `outbox_node_runtime_complete:${operationId}`

const executionAuditBefore = (snapshot: ExecutionSnapshot) => ({
  desiredState: snapshot.reservation.desiredState,
  desiredRevision: snapshot.reservation.desiredRevision,
  observedState: snapshot.observedState,
  observedRevision: snapshot.observedRevision,
  executionState: snapshot.state,
})

const machineAuditRequestContext = (
  snapshot: ExecutionSnapshot,
  attempt: number,
): AuditRequestContextValue => ({
  origin: 'machine',
  requestId: `node-runtime-execution:${snapshot.reservation.operationId}:${attempt}`,
  correlationId: snapshot.auditCorrelationId,
  source: {
    ip: { state: 'not-available', reason: 'workflow execution has no client IP' },
    access: { state: 'not-available', reason: 'workflow execution has no Access assertion' },
  },
})

/**
 * Provider observations are machine-path mutations, but retain the exact
 * initiating human actor from the immutable operation. The source honestly
 * records that the Workflow has no HTTP request or Access assertion.
 */
const stageExecutionAudit = (
  database: NodeRuntimeLifecycleD1Database,
  input: {
    readonly snapshot: ExecutionSnapshot
    readonly attempt: number
    readonly eventId: string
    readonly occurredAt: string
    readonly action: string
    readonly result: 'succeeded' | 'failed'
    readonly after: Readonly<Record<string, unknown>>
    readonly error: { readonly classification: 'none' | 'provider'; readonly code: string | null }
  },
): Effect.Effect<
  { readonly statement: NodeRuntimeLifecycleD1Statement; readonly summaryJson: string },
  NodeRuntimeLifecycleExecutionPersistenceError
> =>
  Effect.gen(function* () {
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.occurredAt,
      scope: 'tenant',
      organizationId: input.snapshot.reservation.organizationId,
      actor: { type: 'human', id: input.snapshot.auditActorId },
      action: input.action,
      target: { type: 'node', id: input.snapshot.reservation.nodeId },
      before: { state: 'captured', summary: executionAuditBefore(input.snapshot) },
      after: { state: 'captured', summary: input.after },
      operationId: input.snapshot.reservation.operationId,
      result: input.result,
      error: input.error,
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.provideService(
        AuditRequestContext,
        machineAuditRequestContext(input.snapshot, input.attempt),
      ),
      Effect.mapError(() => executionPersistence('nodeRuntimeLifecycle.execution.audit-envelope')),
    )
    const stage = yield* stageAuditEnvelope(
      'tenant',
      input.eventId,
      envelope,
      input.occurredAt,
    ).pipe(
      Effect.mapError(() => executionPersistence('nodeRuntimeLifecycle.execution.audit-stage')),
    )
    return {
      statement: database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const sameReservation = (
  left: NodeRuntimeLifecycleExecutionReservation,
  right: NodeRuntimeLifecycleExecutionReservation,
): boolean =>
  left.organizationId === right.organizationId &&
  left.nodeId === right.nodeId &&
  left.operationId === right.operationId &&
  left.action === right.action &&
  left.providerType === right.providerType &&
  left.providerInstanceId === right.providerInstanceId &&
  left.previousDesiredState === right.previousDesiredState &&
  left.previousDesiredRevision === right.previousDesiredRevision &&
  left.desiredState === right.desiredState &&
  left.desiredRevision === right.desiredRevision &&
  left.credentialBinding.providerAccountId === right.credentialBinding.providerAccountId &&
  left.credentialBinding.providerAccountScope === right.credentialBinding.providerAccountScope &&
  left.credentialBinding.providerAccountRevision ===
    right.credentialBinding.providerAccountRevision &&
  left.credentialBinding.providerAllocationRevision ===
    right.credentialBinding.providerAllocationRevision &&
  left.credentialBinding.providerCredentialReference ===
    right.credentialBinding.providerCredentialReference &&
  left.credentialBinding.providerCredentialRevision ===
    right.credentialBinding.providerCredentialRevision

const dispatchMarkExists = (
  database: NodeRuntimeLifecycleD1Database,
  input: {
    readonly organizationId: string
    readonly operationId: string
    readonly lease: NodeRuntimeLifecycleExecutionLease
  },
) =>
  executionAttempt('nodeRuntimeLifecycle.execution.dispatch-mark.read', () =>
    database
      .prepare(`SELECT 1 AS present FROM node_runtime_lifecycle_dispatch_marks
        WHERE organization_id = ? AND operation_id = ? AND attempt = ?
          AND lease_owner = ? AND lease_token = ?`)
      .bind(
        input.organizationId,
        input.operationId,
        input.lease.attempt,
        input.lease.owner,
        input.lease.token,
      )
      .first(),
  )

export const makeNodeRuntimeLifecycleExecutionRepositoryD1 = (
  database: NodeRuntimeLifecycleD1Database,
): NodeRuntimeLifecycleExecutionRepositoryShape => {
  const repository: NodeRuntimeLifecycleExecutionRepositoryShape = {
    claim: (input) =>
      Effect.gen(function* () {
        const before = yield* loadExecution(database, input.organizationId, input.operationId)
        if (
          before.state === 'succeeded' ||
          before.state === 'failed-terminal' ||
          before.state === 'reconciliation-required'
        )
          return {
            disposition: 'adopted' as const,
            result: yield* decodeExecutionResult(before.resultJson),
          }
        if (
          (before.state === 'leased' || before.state === 'action-requested') &&
          before.lease !== null &&
          before.lease.expiresAt > input.now
        )
          return { disposition: 'in-progress' as const }
        // A crash or lost D1 response before `markActionRequested` cannot have sent a provider
        // request. Its expired lease is therefore safe to reclaim for one dispatch. A dispatch
        // mark is the boundary after which retries must never send again.
        if (before.state === 'leased' && before.lease !== null) {
          const existingMark = yield* dispatchMarkExists(database, {
            organizationId: input.organizationId,
            operationId: input.operationId,
            lease: before.lease,
          })
          if (existingMark !== null)
            return yield* executionConflict(
              'nodeRuntimeLifecycle.execution.lease-with-dispatch-mark',
            )
        }
        const recovery =
          before.state === 'pending'
            ? ('fresh' as const)
            : before.state === 'action-requested'
              ? ('action-requested-expired' as const)
              : before.state === 'leased'
                ? ('lease-expired-before-mark' as const)
                : ('observation-retry' as const)
        const update = database
          .prepare(`UPDATE node_runtime_lifecycle_executions
            SET state = 'leased', lease_owner = ?, lease_token = ?, lease_until = ?,
              attempt = attempt + 1, revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND state = ?
              AND ((state NOT IN ('leased', 'action-requested')) OR lease_until <= ?)
              AND ${executionBindingFence} AND ${executionNodeFence}`)
          .bind(
            input.owner,
            input.token,
            input.leaseExpiresAt,
            input.now,
            input.organizationId,
            input.operationId,
            before.state,
            input.now,
          )
        const committed = yield* executionAttempt('nodeRuntimeLifecycle.execution.claim', () =>
          database.batch([update]),
        )
        if (one(committed[0])) {
          // Attempt is a monotonic execution counter, not a desired revision. Read it exactly once
          // after the CAS so a process cannot manufacture its own provider idempotency identity.
          const claimed = yield* loadExecution(database, input.organizationId, input.operationId)
          if (
            claimed.lease === null ||
            claimed.lease.owner !== input.owner ||
            claimed.lease.token !== input.token
          )
            return yield* executionConflict('nodeRuntimeLifecycle.execution.claim-read')
          return recovery === 'fresh' || recovery === 'lease-expired-before-mark'
            ? {
                disposition: 'dispatch' as const,
                reservation: claimed.reservation,
                lease: claimed.lease,
                recovery,
              }
            : {
                disposition: 'observe' as const,
                reservation: claimed.reservation,
                lease: claimed.lease,
                recovery,
              }
        }
        const raced = yield* loadExecution(database, input.organizationId, input.operationId)
        if (
          raced.state === 'succeeded' ||
          raced.state === 'failed-terminal' ||
          raced.state === 'reconciliation-required'
        )
          return {
            disposition: 'adopted' as const,
            result: yield* decodeExecutionResult(raced.resultJson),
          }
        if (
          (raced.state === 'leased' || raced.state === 'action-requested') &&
          raced.lease !== null &&
          raced.lease.expiresAt > input.now
        )
          return { disposition: 'in-progress' as const }
        return yield* executionConflict('nodeRuntimeLifecycle.execution.claim-race')
      }),
    markActionRequested: (input) =>
      Effect.gen(function* () {
        const executionUpdate = database
          .prepare(`UPDATE node_runtime_lifecycle_executions
            SET state = 'action-requested', action_requested_at = ?, revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND state = 'leased'
              AND lease_owner = ? AND lease_token = ? AND attempt = ?
              AND ${executionBindingFence} AND ${executionNodeFence}`)
          .bind(
            input.requestedAt,
            input.requestedAt,
            input.reservation.organizationId,
            input.reservation.operationId,
            input.lease.owner,
            input.lease.token,
            input.lease.attempt,
          )
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = 'running', progress = max(progress, 20),
            revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('queued', 'waiting_external')
              AND EXISTS (SELECT 1 FROM node_runtime_lifecycle_executions execution
                WHERE execution.organization_id = operations.organization_id
                  AND execution.operation_id = operations.id AND execution.state = 'action-requested'
                  AND execution.lease_owner = ? AND execution.lease_token = ? AND execution.attempt = ?)`)
          .bind(
            input.requestedAt,
            input.reservation.organizationId,
            input.reservation.operationId,
            input.lease.owner,
            input.lease.token,
            input.lease.attempt,
          )
        // This receipt is the final dispatch-side transaction fence. A provider request is not
        // permitted until both execution and operation rows prove the same lease and attempt.
        const dispatchMarkInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_dispatch_marks
            (organization_id, operation_id, attempt, lease_owner, lease_token,
             action_requested_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            input.reservation.organizationId,
            input.reservation.operationId,
            input.lease.attempt,
            input.lease.owner,
            input.lease.token,
            input.requestedAt,
            input.requestedAt,
          )
        const outcome = yield* Effect.result(
          executionAttempt('nodeRuntimeLifecycle.execution.dispatch-mark', () =>
            database.batch([executionUpdate, operationUpdate, dispatchMarkInsert]),
          ),
        )
        if (
          outcome._tag === 'Success' &&
          outcome.success.length === 3 &&
          outcome.success.every(one)
        )
          return 'marked' as const
        const current = yield* loadExecution(
          database,
          input.reservation.organizationId,
          input.reservation.operationId,
        )
        if (
          current.state === 'action-requested' &&
          sameReservation(current.reservation, input.reservation) &&
          current.lease !== null &&
          current.lease.owner === input.lease.owner &&
          current.lease.token === input.lease.token &&
          current.lease.attempt === input.lease.attempt &&
          (yield* dispatchMarkExists(database, {
            organizationId: input.reservation.organizationId,
            operationId: input.reservation.operationId,
            lease: input.lease,
          })) !== null
        )
          return 'delivery-unknown' as const
        return yield* executionConflict('nodeRuntimeLifecycle.execution.dispatch-mark')
      }),
    recordObservation: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* loadExecution(
          database,
          input.reservation.organizationId,
          input.reservation.operationId,
        )
        if (
          !sameReservation(snapshot.reservation, input.reservation) ||
          snapshot.lease === null ||
          snapshot.lease.owner !== input.lease.owner ||
          snapshot.lease.token !== input.lease.token ||
          snapshot.lease.attempt !== input.lease.attempt ||
          snapshot.state !== input.phase
        )
          return yield* executionConflict('nodeRuntimeLifecycle.execution.observation-lease')
        const decision = decisionFor({
          snapshot,
          observation: input.observation,
          recovery: input.recovery,
        })
        const terminal =
          decision.result.state === 'succeeded' ||
          decision.result.state === 'reconciliation-required'
        const endpointEvidence =
          terminal &&
          decision.result.observedState === 'ready' &&
          input.observation.playerAddresses !== undefined
            ? playerEndpointEvidence(input.observation.playerAddresses)
            : undefined
        const resultJson = executionResultJson(decision.result)
        const nodeUpdate = database
          .prepare(`UPDATE nodes SET desired_state = ?, desired_revision = ?, observed_state = ?,
            observed_revision = observed_revision + 1, reconciliation_error = ?, last_reconciled_at = ?,
            pending_lifecycle_operation_id = CASE WHEN ? = 1 THEN NULL ELSE pending_lifecycle_operation_id END,
            updated_at = ?
            WHERE organization_id = ? AND id = ? AND pending_lifecycle_operation_id = ?
              AND desired_state = ? AND desired_revision = ? AND observed_state = ? AND observed_revision = ?`)
          .bind(
            decision.desiredState,
            decision.desiredRevision,
            decision.result.observedState,
            decision.reconciliationError,
            input.observedAt,
            decision.clearPending ? 1 : 0,
            input.observedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.nodeId,
            snapshot.reservation.operationId,
            snapshot.reservation.desiredState,
            snapshot.reservation.desiredRevision,
            snapshot.observedState,
            snapshot.observedRevision,
          )
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = ?, progress = ?, revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')
              AND EXISTS (SELECT 1 FROM nodes node WHERE node.organization_id = operations.organization_id
                AND node.id = operations.resource_id
                AND ((? = 1 AND node.pending_lifecycle_operation_id IS NULL)
                  OR (? = 0 AND node.pending_lifecycle_operation_id = operations.id)))`)
          .bind(
            decision.result.operationStatus,
            terminal ? 100 : 50,
            input.observedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            decision.clearPending ? 1 : 0,
            decision.clearPending ? 1 : 0,
          )
        const executionUpdate = database
          .prepare(`UPDATE node_runtime_lifecycle_executions
            SET state = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              last_provider_state = ?, reboot_confirmed = ?, result_json = ?, failure_code = ?,
              revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND state = ? AND lease_owner = ?
              AND lease_token = ? AND attempt = ?`)
          .bind(
            decision.result.state === 'reconciliation-required'
              ? 'reconciliation-required'
              : decision.result.state === 'succeeded'
                ? 'succeeded'
                : 'waiting-observation',
            input.observation.providerState,
            input.observation.rebootConfirmed ? 1 : 0,
            resultJson,
            decision.failureCode,
            input.observedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.phase,
            input.lease.owner,
            input.lease.token,
            input.lease.attempt,
          )
        const observationInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_observations
            (organization_id, operation_id, attempt, provider_state, reboot_confirmed, result_state,
             result_json, observed_at)
            SELECT ?, ?, execution.attempt, ?, ?, ?, ?, ?
            FROM node_runtime_lifecycle_executions execution
            WHERE execution.organization_id = ? AND execution.operation_id = ? AND execution.attempt = ?
              AND execution.result_json = ?`)
          .bind(
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.observation.providerState,
            input.observation.rebootConfirmed ? 1 : 0,
            decision.result.state,
            resultJson,
            input.observedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.lease.attempt,
            resultJson,
          )
        const terminalAuditSummary = {
          schemaVersion: 1,
          operationId: snapshot.reservation.operationId,
          action: snapshot.reservation.action,
          providerState: input.observation.providerState,
          rebootConfirmed: input.observation.rebootConfirmed,
          ...(endpointEvidence === undefined
            ? {}
            : {
                playerEndpointEvidence: endpointEvidence.state,
                playerEndpointReason:
                  endpointEvidence.state === 'absent' ? endpointEvidence.reason : null,
                playerEndpoints:
                  endpointEvidence.state === 'captured' ? endpointEvidence.endpoints : [],
              }),
          outcome: decision.result.state,
        }
        const terminalAudit = terminal
          ? yield* stageExecutionAudit(database, {
              snapshot,
              attempt: input.lease.attempt,
              eventId: terminalAuditId(snapshot.reservation.operationId),
              occurredAt: input.observedAt,
              action:
                decision.result.state === 'succeeded'
                  ? `node.runtime.${snapshot.reservation.action}.completed`
                  : 'node.runtime.lifecycle.reconciliation-required',
              result: decision.result.state === 'succeeded' ? 'succeeded' : 'failed',
              after: terminalAuditSummary,
              error:
                decision.result.state === 'succeeded'
                  ? { classification: 'none' as const, code: null }
                  : {
                      classification: 'provider' as const,
                      code: decision.failureCode ?? 'provider-reconciliation-required',
                    },
            })
          : null
        const terminalStatements =
          terminalAudit === null
            ? []
            : [
                terminalAudit.statement,
                database
                  .prepare(`INSERT INTO audit_events
                  (id, organization_id, actor_id, action, target_type, target_id, result,
                   correlation_id, summary_json, created_at)
                  SELECT ?, operation.organization_id, operation.actor_id, ?, 'node', operation.resource_id,
                    ?, operation.correlation_id, ?, ?
                  FROM operations operation JOIN node_runtime_lifecycle_executions execution
                    ON execution.organization_id = operation.organization_id AND execution.operation_id = operation.id
                  WHERE operation.organization_id = ? AND operation.id = ? AND operation.status = ?
                    AND execution.state = ? AND execution.result_json = ?`)
                  .bind(
                    terminalAuditId(snapshot.reservation.operationId),
                    decision.result.state === 'succeeded'
                      ? `node.runtime.${snapshot.reservation.action}.completed`
                      : 'node.runtime.lifecycle.reconciliation-required',
                    decision.result.state === 'succeeded' ? 'succeeded' : 'failed',
                    terminalAudit.summaryJson,
                    input.observedAt,
                    snapshot.reservation.organizationId,
                    snapshot.reservation.operationId,
                    decision.result.operationStatus,
                    decision.result.state === 'succeeded' ? 'succeeded' : 'reconciliation-required',
                    resultJson,
                  ),
                database
                  .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  SELECT ?, operation.organization_id, ?, 'node', operation.resource_id, ?,
                    'pending', 0, ?, ?
                  FROM operations operation JOIN audit_events audit
                    ON audit.organization_id = operation.organization_id AND audit.id = ?
                  WHERE operation.organization_id = ? AND operation.id = ? AND operation.status = ?`)
                  .bind(
                    terminalOutboxId(snapshot.reservation.operationId),
                    decision.result.state === 'succeeded'
                      ? 'node.runtime.lifecycle.completed'
                      : 'node.runtime.lifecycle.reconciliation-required',
                    JSON.stringify({
                      schemaVersion: 1,
                      organizationId: snapshot.reservation.organizationId,
                      partitionKey: `${snapshot.reservation.organizationId}:node:${snapshot.reservation.nodeId}`,
                      nodeId: snapshot.reservation.nodeId,
                      operationId: snapshot.reservation.operationId,
                      action: snapshot.reservation.action,
                      state: decision.result.state,
                      ...(endpointEvidence === undefined
                        ? {}
                        : {
                            playerEndpointEvidence: endpointEvidence.state,
                            playerEndpointReason:
                              endpointEvidence.state === 'absent' ? endpointEvidence.reason : null,
                            playerEndpoints:
                              endpointEvidence.state === 'captured'
                                ? endpointEvidence.endpoints
                                : [],
                          }),
                    }),
                    input.observedAt,
                    input.observedAt,
                    terminalAuditId(snapshot.reservation.operationId),
                    snapshot.reservation.organizationId,
                    snapshot.reservation.operationId,
                    decision.result.operationStatus,
                  ),
              ]
        /**
         * The endpoint write is fenced by the exact terminal lifecycle
         * operation.  Keep this binding list in SQL-placeholder order; a
         * response-loss replay must never adopt endpoint evidence from a
         * different operation, provider instance, or node revision.
         */
        const endpointScopeBindings = [
          snapshot.reservation.operationId,
          snapshot.reservation.organizationId,
          snapshot.reservation.nodeId,
          snapshot.reservation.providerInstanceId,
          decision.desiredState,
          decision.desiredRevision,
          snapshot.observedRevision + 1,
          decision.result.operationStatus,
        ] as const
        const endpointScope = `FROM nodes node
          JOIN operations operation
            ON operation.organization_id = node.organization_id
           AND operation.id = ?
          WHERE node.organization_id = ? AND node.id = ?
            AND node.provider_instance_id = ? AND node.desired_state = ?
            AND node.observed_state = 'ready' AND node.desired_revision = ?
            AND node.observed_revision = ?
            AND operation.status = ?`
        const endpointStatements =
          endpointEvidence === undefined
            ? []
            : endpointEvidence.state === 'captured'
              ? [
                  ...endpointEvidence.endpoints.map((endpoint) =>
                    database
                      .prepare(`INSERT INTO node_player_endpoints
                        (organization_id, node_id, provider_instance_id, record_type, target, source,
                         observed_revision, revision, observed_at, created_at, updated_at)
                        SELECT ?, ?, ?, ?, ?, 'provider', ?, 1, ?, ?, ?
                        ${endpointScope}
                        ON CONFLICT(organization_id, node_id, record_type) DO UPDATE SET
                          target = excluded.target,
                          source = excluded.source,
                          observed_revision = excluded.observed_revision,
                          revision = node_player_endpoints.revision + 1,
                          observed_at = excluded.observed_at,
                          updated_at = excluded.updated_at
                        WHERE node_player_endpoints.provider_instance_id = excluded.provider_instance_id
                          AND (node_player_endpoints.target <> excluded.target
                            OR node_player_endpoints.source <> excluded.source)`)
                      .bind(
                        snapshot.reservation.organizationId,
                        snapshot.reservation.nodeId,
                        snapshot.reservation.providerInstanceId,
                        endpoint.recordType,
                        endpoint.target,
                        snapshot.observedRevision + 1,
                        input.observedAt,
                        input.observedAt,
                        input.observedAt,
                        ...endpointScopeBindings,
                      ),
                  ),
                  database
                    .prepare(`DELETE FROM node_player_endpoints
                      WHERE organization_id = ? AND node_id = ? AND provider_instance_id = ?
                        AND record_type NOT IN (${endpointEvidence.endpoints.map(() => '?').join(', ')})
                        AND EXISTS (
                          SELECT 1 ${endpointScope}
                        )`)
                    .bind(
                      snapshot.reservation.organizationId,
                      snapshot.reservation.nodeId,
                      snapshot.reservation.providerInstanceId,
                      ...endpointEvidence.endpoints.map((endpoint) => endpoint.recordType),
                      ...endpointScopeBindings,
                    ),
                ]
              : [
                  database
                    .prepare(`DELETE FROM node_player_endpoints
                      WHERE organization_id = ? AND node_id = ? AND provider_instance_id = ?
                        AND EXISTS (
                          SELECT 1 ${endpointScope}
                        )`)
                    .bind(
                      snapshot.reservation.organizationId,
                      snapshot.reservation.nodeId,
                      snapshot.reservation.providerInstanceId,
                      ...endpointScopeBindings,
                    ),
                ]
        // This final insert is guarded in migration 0024. It is intentionally last: if any
        // projection update above loses its optimistic fence, the receipt trigger aborts the
        // entire D1 batch instead of allowing a partial provider outcome to persist.
        const receiptInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_execution_receipts
            (organization_id, operation_id, attempt, result_state, operation_status,
             node_desired_state, node_desired_revision, node_observed_state,
             node_observed_revision, pending_cleared, result_json, audit_event_id,
             outbox_event_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.lease.attempt,
            decision.result.state,
            decision.result.operationStatus,
            decision.desiredState,
            decision.desiredRevision,
            decision.result.observedState,
            snapshot.observedRevision + 1,
            decision.clearPending ? 1 : 0,
            resultJson,
            terminal ? terminalAuditId(snapshot.reservation.operationId) : null,
            terminal ? terminalOutboxId(snapshot.reservation.operationId) : null,
            input.observedAt,
          )
        const outcome = yield* Effect.result(
          executionAttempt('nodeRuntimeLifecycle.execution.observe-commit', () =>
            database.batch([
              nodeUpdate,
              operationUpdate,
              executionUpdate,
              observationInsert,
              ...endpointStatements,
              ...terminalStatements,
              receiptInsert,
            ]),
          ),
        )
        if (
          outcome._tag === 'Success' &&
          outcome.success.length === 5 + endpointStatements.length + terminalStatements.length &&
          outcome.success
            .filter((_result, index) => index < 4 || index >= 4 + endpointStatements.length)
            .every(one)
        )
          return decision.result
        const raced = yield* loadExecution(
          database,
          snapshot.reservation.organizationId,
          snapshot.reservation.operationId,
        )
        if (
          raced.state === 'succeeded' ||
          raced.state === 'failed-terminal' ||
          raced.state === 'reconciliation-required'
        )
          return yield* decodeExecutionResult(raced.resultJson)
        return yield* executionConflict('nodeRuntimeLifecycle.execution.observe-commit')
      }),
    recordTerminalFailure: (input) =>
      Effect.gen(function* () {
        const snapshot = yield* loadExecution(
          database,
          input.reservation.organizationId,
          input.reservation.operationId,
        )
        if (snapshot.state === 'failed-terminal')
          return yield* decodeExecutionResult(snapshot.resultJson)
        if (
          !sameReservation(snapshot.reservation, input.reservation) ||
          snapshot.lease === null ||
          snapshot.lease.owner !== input.lease.owner ||
          snapshot.lease.token !== input.lease.token ||
          snapshot.lease.attempt !== input.lease.attempt ||
          snapshot.state !== input.phase
        )
          return yield* executionConflict('nodeRuntimeLifecycle.execution.failure-lease')
        const result: NodeRuntimeLifecycleExecutionResult = {
          organizationId: snapshot.reservation.organizationId,
          nodeId: snapshot.reservation.nodeId,
          operationId: snapshot.reservation.operationId,
          action: snapshot.reservation.action,
          state: 'failed-terminal',
          operationStatus: 'failed_terminal',
          providerState: 'unknown',
          rebootConfirmed: false,
          observedState: 'degraded',
        }
        const resultJson = executionResultJson(result)
        // A definite authorization or validation failure means this worker did not make a usable
        // provider change. Revert the requested desired state at a new revision and release the
        // node so an Owner/Admin can reconcile it rather than leaving a permanent pending lock.
        const revertedDesiredRevision = snapshot.reservation.desiredRevision + 1
        const nodeUpdate = database
          .prepare(`UPDATE nodes SET desired_state = ?, desired_revision = ?, observed_state = 'degraded',
            observed_revision = observed_revision + 1, reconciliation_error = ?, last_reconciled_at = ?,
            pending_lifecycle_operation_id = NULL, updated_at = ?
            WHERE organization_id = ? AND id = ? AND pending_lifecycle_operation_id = ?
              AND desired_state = ? AND desired_revision = ? AND observed_state = ?
              AND observed_revision = ?`)
          .bind(
            snapshot.reservation.previousDesiredState,
            revertedDesiredRevision,
            input.code,
            input.failedAt,
            input.failedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.nodeId,
            snapshot.reservation.operationId,
            snapshot.reservation.desiredState,
            snapshot.reservation.desiredRevision,
            snapshot.observedState,
            snapshot.observedRevision,
          )
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = 'failed_terminal', progress = 100,
            revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')
              AND EXISTS (SELECT 1 FROM nodes node WHERE node.organization_id = operations.organization_id
                AND node.id = operations.resource_id AND node.pending_lifecycle_operation_id IS NULL
                AND node.desired_state = ? AND node.desired_revision = ?)`)
          .bind(
            input.failedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            snapshot.reservation.previousDesiredState,
            revertedDesiredRevision,
          )
        const executionUpdate = database
          .prepare(`UPDATE node_runtime_lifecycle_executions
            SET state = 'failed-terminal', lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              last_provider_state = 'unknown', reboot_confirmed = 0, result_json = ?, failure_code = ?,
              revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND state = ? AND lease_owner = ?
              AND lease_token = ? AND attempt = ?`)
          .bind(
            resultJson,
            input.code,
            input.failedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.phase,
            input.lease.owner,
            input.lease.token,
            input.lease.attempt,
          )
        const observationInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_observations
            (organization_id, operation_id, attempt, provider_state, reboot_confirmed, result_state,
             result_json, observed_at)
            SELECT ?, ?, execution.attempt, 'unknown', 0, 'failed-terminal', ?, ?
            FROM node_runtime_lifecycle_executions execution
            WHERE execution.organization_id = ? AND execution.operation_id = ? AND execution.attempt = ?
              AND execution.result_json = ?`)
          .bind(
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            resultJson,
            input.failedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.lease.attempt,
            resultJson,
          )
        const failureAuditSummary = {
          schemaVersion: 1,
          operationId: snapshot.reservation.operationId,
          code: input.code,
          outcome: 'failed-terminal',
        }
        const auditStage = yield* stageExecutionAudit(database, {
          snapshot,
          attempt: input.lease.attempt,
          eventId: terminalAuditId(snapshot.reservation.operationId),
          occurredAt: input.failedAt,
          action: 'node.runtime.lifecycle.blocked',
          result: 'failed',
          after: failureAuditSummary,
          error: { classification: 'provider', code: input.code },
        })
        const auditInsert = database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, operation.organization_id, operation.actor_id, 'node.runtime.lifecycle.blocked',
              'node', operation.resource_id, 'failed', operation.correlation_id, ?, ?
            FROM operations operation JOIN node_runtime_lifecycle_executions execution
              ON execution.organization_id = operation.organization_id AND execution.operation_id = operation.id
            WHERE operation.organization_id = ? AND operation.id = ? AND operation.status = 'failed_terminal'
              AND execution.state = 'failed-terminal' AND execution.result_json = ?`)
          .bind(
            terminalAuditId(snapshot.reservation.operationId),
            auditStage.summaryJson,
            input.failedAt,
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            resultJson,
          )
        const outboxInsert = database
          .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, created_at)
            SELECT ?, operation.organization_id, 'node.runtime.lifecycle.blocked', 'node',
              operation.resource_id, ?, 'pending', 0, ?, ?
            FROM operations operation JOIN audit_events audit
              ON audit.organization_id = operation.organization_id AND audit.id = ?
            WHERE operation.organization_id = ? AND operation.id = ? AND operation.status = 'failed_terminal'`)
          .bind(
            terminalOutboxId(snapshot.reservation.operationId),
            JSON.stringify({
              schemaVersion: 1,
              organizationId: snapshot.reservation.organizationId,
              nodeId: snapshot.reservation.nodeId,
              operationId: snapshot.reservation.operationId,
              state: 'failed-terminal',
            }),
            input.failedAt,
            input.failedAt,
            terminalAuditId(snapshot.reservation.operationId),
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
          )
        const receiptInsert = database
          .prepare(`INSERT INTO node_runtime_lifecycle_execution_receipts
            (organization_id, operation_id, attempt, result_state, operation_status,
             node_desired_state, node_desired_revision, node_observed_state,
             node_observed_revision, pending_cleared, result_json, audit_event_id,
             outbox_event_id, created_at)
            VALUES (?, ?, ?, 'failed-terminal', 'failed_terminal', ?, ?, 'degraded', ?, 1, ?, ?, ?, ?)`)
          .bind(
            snapshot.reservation.organizationId,
            snapshot.reservation.operationId,
            input.lease.attempt,
            snapshot.reservation.previousDesiredState,
            revertedDesiredRevision,
            snapshot.observedRevision + 1,
            resultJson,
            terminalAuditId(snapshot.reservation.operationId),
            terminalOutboxId(snapshot.reservation.operationId),
            input.failedAt,
          )
        const outcome = yield* Effect.result(
          executionAttempt('nodeRuntimeLifecycle.execution.failure-commit', () =>
            database.batch([
              nodeUpdate,
              operationUpdate,
              executionUpdate,
              observationInsert,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
            ]),
          ),
        )
        if (
          outcome._tag === 'Success' &&
          outcome.success.length === 8 &&
          outcome.success.every(one)
        )
          return result
        const raced = yield* loadExecution(
          database,
          snapshot.reservation.organizationId,
          snapshot.reservation.operationId,
        )
        if (raced.state === 'failed-terminal') return yield* decodeExecutionResult(raced.resultJson)
        return yield* executionConflict('nodeRuntimeLifecycle.execution.failure-commit')
      }),
  }
  return repository
}

export const NodeRuntimeLifecycleExecutionRepositoryD1Live = Layer.effect(
  NodeRuntimeLifecycleExecutionRepository,
  Effect.gen(function* () {
    return NodeRuntimeLifecycleExecutionRepository.of(
      makeNodeRuntimeLifecycleExecutionRepositoryD1(yield* NodeRuntimeLifecycleD1Client),
    )
  }),
)

export const makeNodeRuntimeLifecycleD1Layer = (database: NodeRuntimeLifecycleD1Database) =>
  Layer.mergeAll(
    NodeRuntimeLifecycleRepositoryD1Live,
    NodeRuntimeLifecycleExecutionRepositoryD1Live,
  ).pipe(Layer.provide(NodeRuntimeLifecycleD1ClientLayer(database)))

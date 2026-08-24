import { Context, Effect, Layer, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  decodeAuditEnvelope,
  decodeAuditRequestContext,
  stageAuditEnvelope,
  type AuditEnvelopeV1,
} from '@gridora/audit-contracts'
import {
  canonicalGameMutationFingerprint,
  type GameDeploymentPlan,
  type GameNodeFact,
  type GamePluginCatalogEntry,
  type PluginImageContract,
  type GameLifecycleOperation,
  type GameLifecycleRepository,
  type GameMutationAcceptance,
  type GameMutationIntent,
} from '@gridora/game-lifecycle-control'
import { desiredSpecFromAcceptedCreate } from '@gridora/game-server-manifest-control'

export interface GameLifecycleD1Statement {
  bind(...values: readonly unknown[]): GameLifecycleD1Statement
  first<T = unknown>(): Promise<T | null>
}
export interface GameLifecycleD1Database {
  prepare(sql: string): GameLifecycleD1Statement
  batch(statements: readonly GameLifecycleD1Statement[]): Promise<readonly unknown[]>
}
export class GameLifecycleD1Client extends Context.Service<
  GameLifecycleD1Client,
  GameLifecycleD1Database
>()('@gridora/game-lifecycle-d1/GameLifecycleD1Client') {}
export const GameLifecycleD1ClientLayer = (database: GameLifecycleD1Database) =>
  Layer.succeed(GameLifecycleD1Client, database)

export class GameLifecycleD1Error extends Schema.TaggedError<GameLifecycleD1Error>()(
  'GameLifecycleD1Error',
  { operation: Schema.String, message: Schema.String },
) {}
export class GameLifecycleIdempotencyConflictError extends Schema.TaggedError<GameLifecycleIdempotencyConflictError>()(
  'GameLifecycleIdempotencyConflictError',
  { idempotencyKey: Schema.String },
) {}
export class GameLifecycleRevisionConflictError extends Schema.TaggedError<GameLifecycleRevisionConflictError>()(
  'GameLifecycleRevisionConflictError',
  { serverId: Schema.String, expected: Schema.Number, actual: Schema.Number },
) {}
export class GameLifecyclePlacementError extends Schema.TaggedError<GameLifecyclePlacementError>()(
  'GameLifecyclePlacementError',
  { serverId: Schema.String, message: Schema.String },
) {}

export class GameLifecycleD1Repository extends Context.Service<
  GameLifecycleD1Repository,
  GameLifecycleRepository
>()('@gridora/game-lifecycle-d1/GameLifecycleD1Repository') {}

export interface GameLifecycleObservationFact {
  readonly organizationId: string
  readonly serverId: string
  readonly operationId: string
  readonly observedRevision: number
  readonly state: string
  readonly observedAt: string
  readonly error?: string
}

export interface GameLifecycleObservationD1Repository {
  readonly readObservation: (
    organizationId: string,
    serverId: string,
    operationId: string,
  ) => Effect.Effect<GameLifecycleObservationFact, GameLifecycleD1Error>
  readonly verifyNoDns: (
    organizationId: string,
    serverId: string,
    operationId: string,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
    },
    GameLifecycleD1Error
  >
}

/**
 * Narrow cleanup evidence consumed by organization deletion.  The cleanup
 * lane must adopt the operation-bound DNS receipt (or prove that the server
 * never had a domain); it must not infer teardown from a provider response or
 * from the child operation status alone.
 */
export interface GameLifecycleDeletedDnsReceipt {
  readonly organizationId: string
  readonly serverId: string
  readonly operationId: string
  readonly state: 'deleted' | 'none'
  readonly hostname?: string
  readonly recordType?: 'A' | 'AAAA'
  readonly target?: string
  readonly providerRecordId?: string
  readonly revision: number
}

export interface GameLifecycleCleanupD1Repository {
  readonly requireDeletedDnsReceipt: (
    organizationId: string,
    serverId: string,
    operationId: string,
  ) => Effect.Effect<GameLifecycleDeletedDnsReceipt, GameLifecycleD1Error>
}

export class GameLifecycleCleanupD1 extends Context.Service<
  GameLifecycleCleanupD1,
  GameLifecycleCleanupD1Repository
>()('@gridora/game-lifecycle-d1/GameLifecycleCleanupD1') {}

export type GameLifecycleCompletionAction =
  | 'create'
  | 'delete'
  | 'start'
  | 'stop'
  | 'restart'
  | 'update'
  | 'apply-config'
  | 'sync-mods'
  | 'move'

export interface GameLifecycleCompletionInput {
  readonly organizationId: string
  readonly lifecycleOperationId: string
  readonly serverId: string
  readonly action: GameLifecycleCompletionAction
  readonly stepName: string
  readonly evidence: Readonly<Record<string, unknown>>
  readonly now: string
}

export interface GameLifecycleCompletionReceipt {
  readonly organizationId: string
  readonly lifecycleOperationId: string
  readonly serverId: string
  readonly action: GameLifecycleCompletionAction
  readonly stepName: string
  readonly completionOperationId: string
  readonly completionEventId: string
  readonly acceptanceAuditEventId: string
  readonly evidenceJson: string
  readonly state: 'succeeded'
  /** Revision of the original accepted lifecycle operation after terminalization. */
  readonly lifecycleOperationRevision: number
  readonly revision: number
  readonly disposition: 'created' | 'adopted'
}

export interface GameLifecycleCompletionD1Repository {
  readonly complete: (
    input: GameLifecycleCompletionInput,
  ) => Effect.Effect<GameLifecycleCompletionReceipt, GameLifecycleD1Error>
}

export class GameLifecycleCompletionD1 extends Context.Service<
  GameLifecycleCompletionD1,
  GameLifecycleCompletionD1Repository
>()('@gridora/game-lifecycle-d1/GameLifecycleCompletionD1') {}

export class GameLifecycleObservationD1 extends Context.Service<
  GameLifecycleObservationD1,
  GameLifecycleObservationD1Repository
>()('@gridora/game-lifecycle-d1/GameLifecycleObservationD1') {}

export interface GameLifecyclePlanningFacts {
  readonly nodes: readonly GameNodeFact[]
  readonly catalog: readonly GamePluginCatalogEntry[]
}

export interface GameLifecycleWorkflowData {
  readonly organizationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly operationId: string
  readonly serverId: string
  readonly action: GameLifecycleOperation['action']
  readonly expectedPriorRevision: number
  readonly createdAt: string
  readonly workflowState: 'pending' | 'started'
  readonly nodeId: string
  readonly targetNodeId?: string
  readonly movePhase?:
    | 'reserved'
    | 'backup'
    | 'stopped'
    | 'restoring'
    | 'validated'
    | 'cutover'
    | 'released'
    | 'rolled_back'
    | 'failed'
  readonly moveSourcePreserved?: boolean
  readonly moveBackupId?: string
  readonly deploymentId: string
  readonly pluginId: string
  readonly pluginVersion: string
  /** Historical reviewed image retained for replaying an already accepted version. */
  readonly image?: PluginImageContract
  readonly domain?: string
  readonly steamCredentialRef?: string
  readonly backupBeforeUpdate?: boolean
  readonly backupPolicy?: 'required' | 'skip-authorized'
  readonly forcedCleanup?: true
  readonly ports: readonly {
    readonly protocol: 'tcp' | 'udp'
    readonly containerPort: number
    readonly publicPort: number
    readonly purpose: string
  }[]
  readonly resources: {
    readonly cpu: number
    readonly memoryMiB: number
    readonly diskGiB: number
  }
  readonly config: Readonly<Record<string, unknown>>
  readonly mods: readonly {
    readonly source: string
    readonly id: string
    readonly requestedVersion?: string
    readonly loadOrder: number
  }[]
  readonly configRevision: number
  readonly modRevision: number
}

export interface GameLifecyclePlanningD1Repository {
  readonly readPlanningFacts: (
    organizationId: string,
  ) => Effect.Effect<GameLifecyclePlanningFacts, GameLifecycleD1Error>
  readonly readWorkflowData: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<GameLifecycleWorkflowData, GameLifecycleD1Error>
  readonly markWorkflowStarted: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<void, GameLifecycleD1Error>
}

export class GameLifecyclePlanningD1 extends Context.Service<
  GameLifecyclePlanningD1,
  GameLifecyclePlanningD1Repository
>()('@gridora/game-lifecycle-d1/GameLifecyclePlanningD1') {}

export interface GameLifecyclePlanningD1Options {
  /**
   * Immutable, reviewed image entries generated from the plugin registry.  D1
   * is only allowed to select an active plugin/version from this catalog; it
   * cannot provide workload image names or digests.
   */
  readonly imageCatalog: readonly GamePluginCatalogEntry[]
  readonly portRange?: { readonly start: number; readonly end: number }
  readonly now?: () => string
}

export interface GameLifecycleD1Options {
  readonly now: () => string
  readonly operationId: () => string
  readonly serverId: () => string
  readonly deploymentId: () => string
  readonly capacityReservationId: () => string
  readonly auditEventId: () => string
  readonly outboxEventId: () => string
  readonly mutationResult: (operation: GameLifecycleOperation) => Readonly<Record<string, unknown>>
}

const defaults: GameLifecycleD1Options = {
  now: () => new Date().toISOString(),
  operationId: () => crypto.randomUUID(),
  serverId: () => crypto.randomUUID(),
  deploymentId: () => crypto.randomUUID(),
  capacityReservationId: () => crypto.randomUUID(),
  auditEventId: () => crypto.randomUUID(),
  outboxEventId: () => crypto.randomUUID(),
  mutationResult: (operation) => ({
    operationId: operation.operationId,
    serverId: operation.serverId,
    action: operation.action,
    accepted: true,
    observed: false,
  }),
}

const persistence = (operation: string, cause: unknown) =>
  new GameLifecycleD1Error({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => persistence(operation, cause),
  })
const rowObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const integer = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] : undefined

const replaySql = `SELECT mutation.organization_id AS organizationId,
 mutation.idempotency_key AS idempotencyKey, mutation.action,
 mutation.request_fingerprint AS fingerprint, mutation.operation_id AS operationId,
 mutation.server_id AS serverId, mutation.expected_revision AS expectedRevision,
 operation.actor_id AS actorId, operation.status AS operationState,
 workflow.state AS workflowState
 FROM game_lifecycle_mutations mutation
 JOIN operations operation
   ON operation.organization_id = mutation.organization_id
  AND operation.id = mutation.operation_id
 JOIN lifecycle_workflow_starts workflow
   ON workflow.organization_id = mutation.organization_id
  AND workflow.operation_id = mutation.operation_id
 WHERE mutation.organization_id = ? AND mutation.idempotency_key = ?`

const moveReplaySql = `SELECT mutation.organization_id AS organizationId,
 mutation.idempotency_key AS idempotencyKey, mutation.action,
 mutation.request_fingerprint AS fingerprint, mutation.operation_id AS operationId,
 mutation.server_id AS serverId, mutation.expected_revision AS expectedRevision,
 operation.actor_id AS actorId, operation.status AS operationState,
 workflow.state AS workflowState
 FROM game_lifecycle_moves mutation
 JOIN operations operation
   ON operation.organization_id = mutation.organization_id
  AND operation.id = mutation.operation_id
 JOIN lifecycle_workflow_starts workflow
   ON workflow.organization_id = mutation.organization_id
  AND workflow.operation_id = mutation.operation_id
 WHERE mutation.organization_id = ? AND mutation.idempotency_key = ?`

const operationStates = new Set<GameLifecycleOperation['state']>([
  'requested',
  'queued',
  'running',
  'waiting_external',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
  'retrying',
  'failed_terminal',
])

const lifecycleActions = new Set<GameLifecycleOperation['action']>([
  'create',
  'delete',
  'start',
  'stop',
  'restart',
  'update',
  'apply-config',
  'sync-mods',
  'move',
])

const decodeReplay = (
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
  value: unknown,
): Effect.Effect<
  GameMutationAcceptance | null,
  GameLifecycleD1Error | GameLifecycleIdempotencyConflictError
> => {
  if (value === null || value === undefined) return Effect.succeed(null)
  const row = rowObject(value)
  if (row === undefined)
    return Effect.fail(persistence('game-lifecycle.replay.decode', 'invalid replay row'))
  const storedFingerprint = text(row, 'fingerprint')
  if (storedFingerprint !== fingerprint)
    return Effect.fail(new GameLifecycleIdempotencyConflictError({ idempotencyKey }))
  const operationId = text(row, 'operationId')
  const serverId = text(row, 'serverId')
  const storedAction = text(row, 'action')
  const action =
    storedAction !== undefined &&
    lifecycleActions.has(storedAction as GameLifecycleOperation['action'])
      ? (storedAction as GameLifecycleOperation['action'])
      : undefined
  const expectedRevision = integer(row, 'expectedRevision')
  const actorId = text(row, 'actorId')
  const storedOperationState = text(row, 'operationState')
  const operationState =
    storedOperationState !== undefined &&
    operationStates.has(storedOperationState as GameLifecycleOperation['state'])
      ? (storedOperationState as GameLifecycleOperation['state'])
      : undefined
  const storedWorkflowState = text(row, 'workflowState')
  const workflowState =
    storedWorkflowState === 'started'
      ? ('started' as const)
      : storedWorkflowState === 'pending'
        ? ('pending-reconciliation' as const)
        : undefined
  if (
    operationId === undefined ||
    serverId === undefined ||
    action === undefined ||
    expectedRevision === undefined ||
    actorId === undefined ||
    operationState === undefined ||
    workflowState === undefined
  )
    return Effect.fail(persistence('game-lifecycle.replay.decode', 'invalid replay identifiers'))
  return Effect.succeed({
    disposition: 'adopted',
    operation: {
      organizationId,
      actorId,
      operationId,
      serverId,
      action,
      expectedRevision,
      fingerprint,
      state: operationState,
    },
    workflowState,
  })
}

const operationInsert = `INSERT INTO operations
 (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
  idempotency_key, correlation_id, revision, created_at, updated_at)
 VALUES (?, ?, ?, 'server', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`

// A v1 audit envelope with result=succeeded must bind to a terminal operation.
// Lifecycle acceptance itself remains queued until its durable Workflow has
// completed, so acceptance auditing uses a separate deterministic operation
// that is inserted in the same transaction as the accepted mutation.
const auditOperationInsert = `INSERT INTO operations
 (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
  idempotency_key, correlation_id, revision, created_at, updated_at)
 VALUES (?, ?, ?, 'server', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`

const auditOperationIdFor = (operationId: string): string => `audit:${operationId}`

const auditInsert = `INSERT INTO audit_events
 (id, organization_id, actor_id, action, target_type, target_id, result,
  correlation_id, summary_json, created_at)
 VALUES (?, ?, ?, ?, 'server', ?, 'succeeded', ?, ?, ?)`

const auditEnvelopeTableProbe = `SELECT name FROM sqlite_master
 WHERE type = 'table' AND name = 'audit_envelope_staging' LIMIT 1`

const outboxInsert = `INSERT INTO outbox
 (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
  publish_state, retry_count, available_at, created_at)
 VALUES (?, ?, ?, 'game_server', ?, ?, 'pending', 0, ?, ?)`

const latestObservationSql = `SELECT organization_id AS organizationId, server_id AS serverId,
 operation_id AS operationId, observed_revision AS observedRevision, observed_state AS state,
 observation_json AS observationJson, observed_at AS observedAt
 FROM game_observation_reductions
 WHERE organization_id = ? AND server_id = ? AND operation_id = ?
 ORDER BY observed_revision DESC LIMIT 1`

const deletedDnsReceiptSql = `SELECT
  server.domain AS domain,
  operation.type AS operationType,
  operation.status AS operationStatus,
  operation.progress AS operationProgress,
  operation.revision AS operationRevision,
  completion.state AS completionState,
  completion.lifecycle_operation_revision AS completionOperationRevision,
  COALESCE((SELECT COUNT(*) FROM dns_records record
    WHERE record.organization_id = server.organization_id
      AND record.server_id = server.id
      AND record.state <> 'deleted'), 0) AS liveDnsCount,
  receipt.state AS receiptState,
  receipt.hostname AS hostname,
  receipt.record_type AS recordType,
  receipt.target AS target,
  receipt.provider_record_id AS providerRecordId,
  receipt.revision AS receiptRevision
FROM game_servers server
JOIN operations operation
  ON operation.organization_id = server.organization_id
 AND operation.id = ?
LEFT JOIN game_dns_lifecycle_receipts receipt
  ON receipt.organization_id = operation.organization_id
 AND receipt.operation_id = operation.id
 AND receipt.server_id = server.id
 AND receipt.action = 'delete'
LEFT JOIN game_lifecycle_completion_receipts completion
  ON completion.organization_id = operation.organization_id
 AND completion.lifecycle_operation_id = operation.id
 AND completion.server_id = server.id
 AND completion.action = 'delete'
 AND completion.step_name = 'verify-observation'
WHERE server.organization_id = ?
  AND server.id = ?
  AND operation.resource_type = 'server'
  AND operation.resource_id = server.id
  AND operation.type = 'server.delete'`

const moveFactsSql = `SELECT
  deployment.id AS sourceDeploymentId,
  deployment.node_id AS sourceNodeId,
  target.id AS targetNodeId,
  target.placement_mode AS targetPlacementMode,
  target.desired_state AS targetDesiredState,
  target.observed_state AS targetObservedState,
  targetCapacity.revision AS targetCapacityRevision,
  targetCapacity.cpu_millis AS targetCpuMillis,
  targetCapacity.ram_bytes AS targetMemoryBytes,
  targetCapacity.disk_bytes AS targetDiskBytes,
  sourceCapacity.cpu_millis AS cpuMillis,
  sourceCapacity.ram_bytes AS ramBytes,
  sourceCapacity.disk_bytes AS diskBytes,
  server.desired_revision AS currentRevision,
  server.observed_state AS currentObservedState
FROM game_servers server
JOIN deployments deployment
  ON deployment.organization_id = server.organization_id
 AND deployment.server_id = server.id
JOIN server_capacity_reservations sourceCapacity
  ON sourceCapacity.organization_id = server.organization_id
 AND sourceCapacity.server_id = server.id
 AND sourceCapacity.state IN ('reserved', 'active')
JOIN nodes target
  ON target.organization_id = server.organization_id
 AND target.id = ?
JOIN node_runtime_capacity targetCapacity
  ON targetCapacity.organization_id = target.organization_id
 AND targetCapacity.node_id = target.id
WHERE server.organization_id = ?
  AND server.id = ?
  AND server.desired_revision = ?
  AND server.pending_lifecycle_operation_id IS NULL
  AND server.desired_state <> 'deleted'
  AND deployment.node_id <> target.id
  AND (SELECT COUNT(*) FROM deployments exact
    WHERE exact.organization_id = server.organization_id
      AND exact.server_id = server.id) = 1`

const insertMutation = `INSERT INTO game_lifecycle_mutations
 (organization_id, idempotency_key, action, request_fingerprint, operation_id,
  server_id, expected_revision, policy_reconciliation_action_id,
  acceptance_audit_event_id, result_json, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const createAction = 'create' as const
const mutationAction = (intent: GameMutationIntent): GameLifecycleOperation['action'] =>
  intent.action

const stateForAction = (action: GameLifecycleOperation['action']) => {
  switch (action) {
    case 'start':
    case 'restart':
      return {
        desired: 'running',
        observed: 'starting',
        operationType: `server.${action}`,
      }
    case 'stop':
      return {
        desired: 'stopped',
        observed: 'stopping',
        operationType: 'server.stop',
      }
    case 'update':
      return {
        desired: 'running',
        observed: 'updating',
        operationType: 'server.update',
      }
    case 'apply-config':
      return {
        desired: 'running',
        observed: 'updating',
        operationType: 'server.configure',
      }
    case 'sync-mods':
      return {
        desired: 'running',
        observed: 'updating',
        operationType: 'server.mods.sync',
      }
    case 'delete':
      return {
        desired: 'deleted',
        observed: 'deleting',
        operationType: 'server.delete',
      }
    case 'move':
      return {
        desired: 'running',
        observed: 'moving',
        operationType: 'server.move',
      }
    case 'create':
      return {
        desired: 'running',
        observed: 'planning',
        operationType: 'server.create',
      }
  }
}

const auditSummary = (operation: GameLifecycleOperation, plan?: GameDeploymentPlan) => ({
  operationId: operation.operationId,
  action: operation.action,
  serverId: operation.serverId,
  expectedRevision: operation.expectedRevision,
  ...(plan === undefined
    ? {}
    : {
        pluginId: plan.pluginId,
        pluginVersion: plan.pluginVersion,
        nodeId: plan.nodeId,
        placementMode: plan.placementMode,
        portCount: plan.ports.length,
        loginMode: plan.loginMode,
        ...(plan.domain === undefined ? {} : { domain: plan.domain }),
      }),
})

const stageGameAudit = (
  database: GameLifecycleD1Database,
  input: {
    readonly eventId: string
    readonly operation: GameLifecycleOperation
    readonly auditOperationId: string
    readonly action: string
    readonly correlationId: string
    readonly auditRequestContext: Parameters<typeof completeAuditEnvelope>[0]['request']
    readonly auditActorType: AuditEnvelopeV1['actor']['type']
    readonly before: AuditEnvelopeV1['before']
    readonly after: Readonly<Record<string, unknown>>
    readonly now: string
    readonly forced?: boolean
  },
): Effect.Effect<
  { readonly statement: GameLifecycleD1Statement; readonly summaryJson: string },
  GameLifecycleD1Error
> => {
  if (input.auditRequestContext.correlationId !== input.correlationId)
    return Effect.fail(
      persistence(
        'game-lifecycle.audit-envelope.context',
        'audit correlation does not match operation',
      ),
    )
  return completeAuditEnvelope({
    occurredAt: input.now,
    scope: 'tenant',
    organizationId: input.operation.organizationId,
    actor: { type: input.auditActorType, id: input.operation.actorId },
    action: `game-server.${input.action}.accepted`,
    target: { type: 'server', id: input.operation.serverId },
    before: input.before,
    after: { state: 'captured', summary: input.after },
    operationId: input.auditOperationId,
    request: input.auditRequestContext,
    result: 'succeeded',
    error: { classification: 'none', code: null },
    forced: input.forced === true,
    breakGlass: false,
  }).pipe(
    Effect.mapError((cause) => persistence('game-lifecycle.audit-envelope.complete', cause)),
    Effect.flatMap((envelope) =>
      stageAuditEnvelope('tenant', input.eventId, envelope, input.now).pipe(
        Effect.mapError((cause) => persistence('game-lifecycle.audit-envelope.stage', cause)),
        Effect.map((stage) => ({
          statement: database
            .prepare(auditEnvelopeStageSql)
            .bind(...auditEnvelopeStageBindings(stage)),
          summaryJson: auditEventSummaryJson(envelope),
        })),
      ),
    ),
  )
}

const completionAcceptanceSql = `SELECT
  lifecycle.actor_id AS actorId,
  lifecycle.correlation_id AS correlationId,
  lifecycle.resource_id AS resourceId,
  lifecycle.type AS operationType,
  lifecycle.status AS lifecycleStatus,
  lifecycle.revision AS lifecycleRevision,
  COALESCE(
    (SELECT mutation.acceptance_audit_event_id
     FROM game_lifecycle_mutations mutation
     WHERE mutation.organization_id = lifecycle.organization_id
       AND mutation.operation_id = lifecycle.id),
    (SELECT move.acceptance_audit_event_id
     FROM game_lifecycle_moves move
     WHERE move.organization_id = lifecycle.organization_id
       AND move.operation_id = lifecycle.id)
  ) AS acceptanceAuditEventId
FROM operations lifecycle
WHERE lifecycle.organization_id = ? AND lifecycle.id = ?`

const completionReceiptSql = `SELECT
  organization_id AS organizationId,
  lifecycle_operation_id AS lifecycleOperationId,
  server_id AS serverId,
  action,
  step_name AS stepName,
  completion_operation_id AS completionOperationId,
  completion_event_id AS completionEventId,
  acceptance_audit_event_id AS acceptanceAuditEventId,
  evidence_json AS evidenceJson,
  state,
  lifecycle_operation_revision AS lifecycleOperationRevision,
  revision
FROM game_lifecycle_completion_receipts
WHERE organization_id = ? AND lifecycle_operation_id = ? AND step_name = ?`

const completionReceiptFromRow = (
  input: GameLifecycleCompletionInput,
  value: unknown,
  disposition: GameLifecycleCompletionReceipt['disposition'],
): GameLifecycleCompletionReceipt | undefined => {
  const row = rowObject(value)
  if (row === undefined) return undefined
  const organizationId = text(row, 'organizationId')
  const lifecycleOperationId = text(row, 'lifecycleOperationId')
  const serverId = text(row, 'serverId')
  const action = text(row, 'action')
  const stepName = text(row, 'stepName')
  const completionOperationId = text(row, 'completionOperationId')
  const completionEventId = text(row, 'completionEventId')
  const acceptanceAuditEventId = text(row, 'acceptanceAuditEventId')
  const evidenceJson = text(row, 'evidenceJson')
  const state = text(row, 'state')
  const lifecycleOperationRevision = integer(row, 'lifecycleOperationRevision')
  const revision = integer(row, 'revision')
  if (
    organizationId !== input.organizationId ||
    lifecycleOperationId !== input.lifecycleOperationId ||
    serverId !== input.serverId ||
    action !== input.action ||
    stepName !== input.stepName ||
    completionOperationId === undefined ||
    completionEventId === undefined ||
    acceptanceAuditEventId === undefined ||
    evidenceJson === undefined ||
    state !== 'succeeded' ||
    lifecycleOperationRevision === undefined ||
    lifecycleOperationRevision <= 1 ||
    revision === undefined
  )
    return undefined
  return {
    organizationId,
    lifecycleOperationId,
    serverId,
    action: input.action,
    stepName,
    completionOperationId,
    completionEventId,
    acceptanceAuditEventId,
    evidenceJson,
    state: 'succeeded',
    lifecycleOperationRevision,
    revision,
    disposition,
  }
}

const completionOperationIdFor = (lifecycleOperationId: string, stepName: string): string =>
  `game-completion:${lifecycleOperationId}:${stepName}`

const completionEventIdFor = (lifecycleOperationId: string, stepName: string): string =>
  `game-completion-audit:${lifecycleOperationId}:${stepName}`

const completionOperationType = (action: GameLifecycleCompletionAction): string => {
  switch (action) {
    case 'create':
      return 'server.create'
    case 'delete':
      return 'server.delete'
    case 'start':
      return 'server.start'
    case 'stop':
      return 'server.stop'
    case 'restart':
      return 'server.restart'
    case 'update':
      return 'server.update'
    case 'apply-config':
      return 'server.configure'
    case 'sync-mods':
      return 'server.mods.sync'
    case 'move':
      return 'server.move'
  }
}

const completionTerminalState = (
  action: GameLifecycleCompletionAction,
): 'running' | 'stopped' | 'deleted' => {
  switch (action) {
    case 'delete':
      return 'deleted'
    case 'stop':
      return 'stopped'
    default:
      return 'running'
  }
}

const lifecycleIsTerminalizable = (status: string | undefined): boolean =>
  status === 'queued' ||
  status === 'running' ||
  status === 'waiting_external' ||
  status === 'retrying'

/**
 * Finish a game Workflow step only after an operation-bound terminal audit
 * operation, complete v1 envelope, compact audit row, and receipt commit as
 * one D1 transaction.  The request/source values are copied from the exact
 * accepted v1 envelope; no Workflow retry can invent a new client context.
 */
export const makeGameLifecycleCompletionD1Repository = (
  database: GameLifecycleD1Database,
): GameLifecycleCompletionD1Repository => {
  const readExisting = (input: GameLifecycleCompletionInput) =>
    attempt('game-lifecycle.completion.read', () =>
      database
        .prepare(completionReceiptSql)
        .bind(input.organizationId, input.lifecycleOperationId, input.stepName)
        .first(),
    ).pipe(
      Effect.flatMap((value) => {
        if (value === null) return Effect.succeed(null as GameLifecycleCompletionReceipt | null)
        const receipt = completionReceiptFromRow(input, value, 'adopted')
        return receipt === undefined
          ? Effect.fail(
              persistence(
                'game-lifecycle.completion.decode',
                'persisted completion receipt is not bound to the requested lifecycle step',
              ),
            )
          : Effect.succeed(receipt)
      }),
    )

  const complete = (input: GameLifecycleCompletionInput) =>
    Effect.gen(function* () {
      const existing = yield* readExisting(input)
      if (existing !== null) return existing

      const operationRow = rowObject(
        yield* attempt('game-lifecycle.completion.acceptance', () =>
          database
            .prepare(completionAcceptanceSql)
            .bind(input.organizationId, input.lifecycleOperationId)
            .first(),
        ),
      )
      if (operationRow === undefined)
        return yield* persistence(
          'game-lifecycle.completion.acceptance',
          'accepted lifecycle operation is missing',
        )
      const actorId = text(operationRow, 'actorId')
      const correlationId = text(operationRow, 'correlationId')
      const resourceId = text(operationRow, 'resourceId')
      const operationType = text(operationRow, 'operationType')
      const lifecycleStatus = text(operationRow, 'lifecycleStatus')
      const lifecycleRevision = integer(operationRow, 'lifecycleRevision')
      const acceptanceAuditEventId = text(operationRow, 'acceptanceAuditEventId')
      if (
        actorId === undefined ||
        correlationId === undefined ||
        resourceId !== input.serverId ||
        operationType !== completionOperationType(input.action) ||
        !lifecycleIsTerminalizable(lifecycleStatus) ||
        lifecycleRevision === undefined ||
        acceptanceAuditEventId === undefined
      )
        return yield* persistence(
          'game-lifecycle.completion.acceptance',
          'accepted lifecycle operation coordinates are incomplete',
        )

      const acceptedEnvelopeValue = yield* attempt('game-lifecycle.completion.provenance', () =>
        database
          .prepare(
            `SELECT envelope_json AS envelopeJson
               FROM audit_event_envelopes
               WHERE scope = 'tenant' AND organization_id = ? AND event_id = ?`,
          )
          .bind(input.organizationId, acceptanceAuditEventId)
          .first(),
      )
      const acceptedEnvelopeRow = rowObject(acceptedEnvelopeValue)
      const acceptedEnvelopeJson =
        acceptedEnvelopeRow === undefined ? undefined : text(acceptedEnvelopeRow, 'envelopeJson')
      if (acceptedEnvelopeJson === undefined)
        return yield* persistence(
          'game-lifecycle.completion.provenance',
          'accepted lifecycle operation has no complete v1 envelope',
        )
      const acceptedEnvelope = yield* decodeAuditEnvelope(
        yield* Effect.try({
          try: () => JSON.parse(acceptedEnvelopeJson) as unknown,
          catch: (cause) =>
            persistence(
              'game-lifecycle.completion.provenance',
              `accepted v1 envelope JSON is invalid: ${String(cause)}`,
            ),
        }),
      ).pipe(Effect.mapError((cause) => persistence('game-lifecycle.completion.provenance', cause)))
      if (acceptedEnvelope.version !== 1 || acceptedEnvelope.source.origin === 'legacy')
        return yield* persistence(
          'game-lifecycle.completion.provenance',
          'accepted lifecycle operation does not carry v1 request provenance',
        )
      const request = yield* decodeAuditRequestContext({
        origin: acceptedEnvelope.source.origin,
        requestId: acceptedEnvelope.request.id,
        correlationId: acceptedEnvelope.request.correlationId,
        source: {
          ip: acceptedEnvelope.source.ip,
          access: acceptedEnvelope.source.access,
        },
      }).pipe(
        Effect.mapError((cause) => persistence('game-lifecycle.completion.provenance', cause)),
      )
      if (request.correlationId !== correlationId)
        return yield* persistence(
          'game-lifecycle.completion.provenance',
          'accepted request provenance does not match lifecycle correlation',
        )

      const completionOperationId = completionOperationIdFor(
        input.lifecycleOperationId,
        input.stepName,
      )
      const completionEventId = completionEventIdFor(input.lifecycleOperationId, input.stepName)
      const summary = {
        operationId: input.lifecycleOperationId,
        serverId: input.serverId,
        action: input.action,
        step: input.stepName,
        evidence: input.evidence,
      } satisfies Readonly<Record<string, unknown>>
      const envelope = yield* completeAuditEnvelope({
        occurredAt: input.now,
        scope: 'tenant',
        organizationId: input.organizationId,
        actor: { type: acceptedEnvelope.actor.type, id: actorId },
        action: `game-server.${input.action}.completed`,
        target: { type: 'server', id: input.serverId },
        before: {
          state: 'captured',
          summary: {
            operationId: input.lifecycleOperationId,
            serverId: input.serverId,
            action: input.action,
            state: 'accepted',
          },
        },
        after: { state: 'captured', summary },
        operationId: completionOperationId,
        request,
        result: 'succeeded',
        error: { classification: 'none', code: null },
        forced: acceptedEnvelope.forced,
        breakGlass: acceptedEnvelope.breakGlass,
      }).pipe(Effect.mapError((cause) => persistence('game-lifecycle.completion.envelope', cause)))
      const stage = yield* stageAuditEnvelope(
        'tenant',
        completionEventId,
        envelope,
        input.now,
      ).pipe(Effect.mapError((cause) => persistence('game-lifecycle.completion.stage', cause)))
      const terminalState = completionTerminalState(input.action)
      const nextLifecycleRevision = lifecycleRevision + 1
      // This transition must be in the same batch as the terminal receipt.
      // The receipt trigger repeats the fence, making a zero-row update fail
      // closed rather than allowing a synthetic audit child to imply success.
      const transitionAcceptedOperation = database
        .prepare(
          `UPDATE operations
           SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND id = ?
             AND resource_type = 'server' AND resource_id = ? AND type = ?
             AND revision = ? AND status IN ('queued', 'running', 'waiting_external', 'retrying')
             AND EXISTS (
               SELECT 1
               FROM game_servers server
               WHERE server.organization_id = operations.organization_id
                 AND server.id = operations.resource_id
                 AND server.pending_lifecycle_operation_id = operations.id
                 AND server.desired_state = ? AND server.observed_state = ?
                 AND server.desired_revision = server.observed_revision
                 AND (
                   (? = 'move' AND EXISTS (
                     SELECT 1 FROM game_lifecycle_moves move
                     WHERE move.organization_id = operations.organization_id
                       AND move.operation_id = operations.id
                       AND move.server_id = operations.resource_id
                       AND server.observed_revision = move.expected_revision + 1
                   ))
                   OR
                   (? <> 'move' AND EXISTS (
                     SELECT 1 FROM game_lifecycle_mutations mutation
                     WHERE mutation.organization_id = operations.organization_id
                       AND mutation.operation_id = operations.id
                       AND mutation.server_id = operations.resource_id
                       AND mutation.action = ?
                       AND server.observed_revision = mutation.expected_revision + 1
                   ))
                 )
             )`,
        )
        .bind(
          input.now,
          input.organizationId,
          input.lifecycleOperationId,
          input.serverId,
          completionOperationType(input.action),
          lifecycleRevision,
          terminalState,
          terminalState,
          input.action,
          input.action,
          input.action,
        )
      const clearAcceptedOperationPending = database
        .prepare(
          `UPDATE game_servers
           SET pending_lifecycle_operation_id = NULL, updated_at = ?
           WHERE organization_id = ? AND id = ? AND pending_lifecycle_operation_id = ?
             AND desired_state = ? AND observed_state = ?
             AND desired_revision = observed_revision
             AND EXISTS (
               SELECT 1 FROM operations lifecycle
               WHERE lifecycle.organization_id = game_servers.organization_id
                 AND lifecycle.id = ?
                 AND lifecycle.resource_type = 'server'
                 AND lifecycle.resource_id = game_servers.id
                 AND lifecycle.status = 'succeeded'
                 AND lifecycle.progress = 100
                 AND lifecycle.revision = ?
                 AND lifecycle.updated_at = ?
             )`,
        )
        .bind(
          input.now,
          input.organizationId,
          input.serverId,
          input.lifecycleOperationId,
          terminalState,
          terminalState,
          input.lifecycleOperationId,
          nextLifecycleRevision,
          input.now,
        )
      const statements = [
        transitionAcceptedOperation,
        clearAcceptedOperationPending,
        database
          .prepare(
            `INSERT INTO operations
             (id, organization_id, type, resource_type, resource_id, actor_id,
              status, progress, idempotency_key, correlation_id, revision,
              created_at, updated_at)
             VALUES (?, ?, 'server.lifecycle.completion', 'server', ?, ?,
                     'succeeded', 100, ?, ?, 1, ?, ?)`,
          )
          .bind(
            completionOperationId,
            input.organizationId,
            input.serverId,
            actorId,
            completionOperationId,
            correlationId,
            input.now,
            input.now,
          ),
        database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
        database
          .prepare(auditInsert)
          .bind(
            completionEventId,
            input.organizationId,
            actorId,
            `game-server.${input.action}.completed`,
            input.serverId,
            correlationId,
            auditEventSummaryJson(envelope),
            input.now,
          ),
        database
          .prepare(
            `INSERT INTO game_lifecycle_completion_receipts
             (organization_id, lifecycle_operation_id, server_id, action,
              step_name, completion_operation_id, completion_event_id,
              acceptance_audit_event_id, evidence_json, state,
              lifecycle_operation_revision, revision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, 1, ?)`,
          )
          .bind(
            input.organizationId,
            input.lifecycleOperationId,
            input.serverId,
            input.action,
            input.stepName,
            completionOperationId,
            completionEventId,
            acceptanceAuditEventId,
            auditEventSummaryJson(envelope),
            nextLifecycleRevision,
            input.now,
          ),
      ]
      const committed = yield* Effect.result(
        attempt('game-lifecycle.completion.commit', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        // The D1 transaction may have committed before its response was lost.
        // Only the immutable receipt (which is fenced to the original accepted
        // operation's terminal revision) is sufficient to adopt that outcome;
        // otherwise preserve the real persistence failure.
        const adopted = yield* readExisting(input)
        if (adopted !== null) return adopted
        return yield* committed.failure
      }
      return {
        organizationId: input.organizationId,
        lifecycleOperationId: input.lifecycleOperationId,
        serverId: input.serverId,
        action: input.action,
        stepName: input.stepName,
        completionOperationId,
        completionEventId,
        acceptanceAuditEventId,
        evidenceJson: auditEventSummaryJson(envelope),
        state: 'succeeded' as const,
        lifecycleOperationRevision: nextLifecycleRevision,
        revision: 1,
        disposition: 'created' as const,
      }
    })

  return { complete }
}

const serverCreatePlanJson = (plan: GameDeploymentPlan) => ({
  nodeId: plan.nodeId,
  pluginId: plan.pluginId,
  pluginVersion: plan.pluginVersion,
  placementMode: plan.placementMode,
  newPaidInfrastructure: 0,
  resources: {
    cpuMillis: Math.max(1, Math.round(plan.resources.cpu * 1_000)),
    ramBytes: Math.round(plan.resources.memoryMiB * 1024 * 1024),
    diskBytes: Math.round(plan.resources.diskGiB * 1024 ** 3),
  },
  ports: plan.ports.map((port) => ({
    name: port.purpose,
    protocol: port.protocol,
    containerPort: port.containerPort,
    publicPort: port.publicPort,
    // The current reviewed plugin manifests do not authorize a preferred
    // public port. Allocation is authoritative, so the reservation receipt
    // records an explicit JSON null and the 0013 fence compares it exactly.
    preferredPublicPort: null,
  })),
})

type AuthoritativePlayerEndpoint = {
  readonly providerInstanceId: string
  readonly recordType: 'A' | 'AAAA'
  readonly target: string
  readonly endpointRevision: number
}

const readAuthoritativePlayerEndpoint = (
  database: GameLifecycleD1Database,
  organizationId: string,
  nodeId: string,
  serverId: string,
): Effect.Effect<AuthoritativePlayerEndpoint, GameLifecycleD1Error | GameLifecyclePlacementError> =>
  attempt('game-lifecycle.dns-authority.read', () =>
    database
      .prepare(
        `SELECT endpoint.provider_instance_id AS providerInstanceId,
                endpoint.record_type AS recordType,
                endpoint.target,
                endpoint.revision AS endpointRevision
         FROM node_player_endpoints endpoint
         JOIN nodes node
           ON node.organization_id = endpoint.organization_id
          AND node.id = endpoint.node_id
          AND node.provider_instance_id = endpoint.provider_instance_id
         WHERE endpoint.organization_id = ? AND endpoint.node_id = ?
           AND node.desired_state = 'ready' AND node.observed_state = 'ready'
         ORDER BY CASE endpoint.record_type WHEN 'A' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .bind(organizationId, nodeId)
      .first(),
  ).pipe(
    Effect.flatMap((value) => {
      const row = rowObject(value)
      const providerInstanceId = row === undefined ? undefined : text(row, 'providerInstanceId')
      const recordType = row === undefined ? undefined : text(row, 'recordType')
      const target = row === undefined ? undefined : text(row, 'target')
      const endpointRevision = row === undefined ? undefined : integer(row, 'endpointRevision')
      if (
        providerInstanceId === undefined ||
        (recordType !== 'A' && recordType !== 'AAAA') ||
        target === undefined ||
        target === 'pending' ||
        endpointRevision === undefined
      )
        return Effect.fail(
          new GameLifecyclePlacementError({
            serverId,
            message: 'The accepted deployment node has no authoritative player endpoint',
          }),
        )
      return Effect.succeed({ providerInstanceId, recordType, target, endpointRevision })
    }),
  )

const commandPayloadSummary = (intent: GameMutationIntent) => {
  switch (intent.action) {
    case 'apply-config':
      return { configRevision: intent.expectedConfigRevision + 1 }
    case 'sync-mods':
      return {
        modRevision: intent.expectedModRevision + 1,
        modCount: intent.mods.length,
      }
    case 'update':
      return {
        expectedConfigRevision: intent.expectedConfigRevision,
        expectedModRevision: intent.expectedModRevision,
        backupBeforeUpdate: intent.backupBeforeUpdate,
      }
    case 'delete':
      return {
        backupPolicy: intent.backupPolicy,
        ...(intent.forcedCleanup === true ? { forcedCleanup: true } : {}),
      }
    case 'move':
      return { targetNodeId: intent.targetNodeId, backupPolicy: intent.backupPolicy }
    default:
      return {}
  }
}

const mutationBeforeSummary = (
  operation: GameLifecycleOperation,
  intent: GameMutationIntent,
): Readonly<Record<string, unknown>> => ({
  serverId: operation.serverId,
  desiredRevision: operation.expectedRevision,
  ...(() => {
    switch (intent.action) {
      case 'apply-config':
        return { configRevision: intent.expectedConfigRevision }
      case 'sync-mods':
        return { modRevision: intent.expectedModRevision }
      case 'update':
        return {
          configRevision: intent.expectedConfigRevision,
          modRevision: intent.expectedModRevision,
          backupBeforeUpdate: intent.backupBeforeUpdate,
        }
      case 'delete':
        return {
          backupPolicy: intent.backupPolicy,
          ...(intent.forcedCleanup === true ? { forcedCleanup: true } : {}),
        }
      case 'move':
        return { targetNodeId: intent.targetNodeId, backupPolicy: intent.backupPolicy }
      default:
        return {}
    }
  })(),
})

const makeOperation = (
  organizationId: string,
  actorId: string,
  operationId: string,
  serverId: string,
  action: GameLifecycleOperation['action'],
  expectedRevision: number,
  fingerprint: string,
): GameLifecycleOperation => ({
  organizationId,
  actorId,
  operationId,
  serverId,
  action,
  expectedRevision,
  fingerprint,
  state: 'queued',
})

export const makeGameLifecycleD1Repository = (
  database: GameLifecycleD1Database,
  options: Partial<GameLifecycleD1Options> = {},
): GameLifecycleRepository => {
  const configured = { ...defaults, ...options }
  const auditEnvelopeAvailable = () =>
    attempt('game-lifecycle.audit-envelope.probe', () =>
      database.prepare(auditEnvelopeTableProbe).first(),
    ).pipe(Effect.map((row) => rowObject(row)?.name === 'audit_envelope_staging'))

  const findIdempotent: GameLifecycleRepository['findIdempotent'] = (
    organizationId,
    idempotencyKey,
    fingerprint,
  ) =>
    Effect.gen(function* () {
      const row = yield* attempt('game-lifecycle.replay', async () => {
        const regular = await database
          .prepare(replaySql)
          .bind(organizationId, idempotencyKey)
          .first()
        return (
          regular ??
          (await database.prepare(moveReplaySql).bind(organizationId, idempotencyKey).first())
        )
      })
      return yield* decodeReplay(organizationId, idempotencyKey, fingerprint, row)
    })

  const create: GameLifecycleRepository['create'] = (input) =>
    Effect.gen(function* () {
      const fingerprint = yield* attempt('game-lifecycle.create.fingerprint', () =>
        // Port/node allocation is authoritative but can change on a retry
        // after this operation has already reserved it.  Idempotency binds
        // the caller's intent; the first accepted plan remains in D1 and is
        // adopted instead of hashing a newly allocated replay plan.
        canonicalGameMutationFingerprint({
          action: createAction,
          organizationId: input.organizationId,
          intent: input.intent,
        }),
      )
      const existing = yield* findIdempotent(
        input.organizationId,
        input.idempotencyKey,
        fingerprint,
      )
      if (existing !== null) return existing
      const now = configured.now()
      const operationId = configured.operationId()
      const serverId = configured.serverId()
      const deploymentId = configured.deploymentId()
      const capacityId = configured.capacityReservationId()
      const auditId = configured.auditEventId()
      const auditOperationId = auditOperationIdFor(operationId)
      const outboxId = configured.outboxEventId()
      const startRecordId = `workflow-start:${operationId}`
      const operation = makeOperation(
        input.organizationId,
        input.actorId,
        operationId,
        serverId,
        createAction,
        0,
        fingerprint,
      )
      const state = stateForAction(createAction)
      const dnsAuthority =
        input.plan.domain === undefined
          ? undefined
          : yield* readAuthoritativePlayerEndpoint(
              database,
              input.organizationId,
              input.plan.nodeId,
              serverId,
            )
      const cpuMillis = Math.max(1, Math.round(input.plan.resources.cpu * 1_000))
      const ramBytes = Math.round(input.plan.resources.memoryMiB * 1024 * 1024)
      const diskBytes = Math.round(input.plan.resources.diskGiB * 1024 ** 3)
      // This is the normalized, public desired state that can later be
      // exported as a declarative manifest.  It intentionally contains none
      // of the selected provider/image/capacity/runtime facts held by the
      // lifecycle plan and reservation.
      const desiredSpec = desiredSpecFromAcceptedCreate({
        intent: input.intent,
        plan: input.plan,
      })
      const result = configured.mutationResult(operation)
      const auditEnvelopeEnabled = yield* auditEnvelopeAvailable()
      const auditStage = auditEnvelopeEnabled
        ? yield* stageGameAudit(database, {
            eventId: auditId,
            operation,
            auditOperationId,
            action: createAction,
            correlationId: input.correlationId,
            auditRequestContext: input.auditRequestContext,
            auditActorType: input.auditActorType,
            before: { state: 'absent', reason: 'resource-did-not-exist' },
            after: auditSummary(operation, input.plan),
            now,
          })
        : undefined
      const statements = [
        database
          .prepare(operationInsert)
          .bind(
            operationId,
            input.organizationId,
            state.operationType,
            serverId,
            input.actorId,
            input.idempotencyKey,
            input.correlationId,
            now,
            now,
          ),
        database
          .prepare(auditOperationInsert)
          .bind(
            auditOperationId,
            input.organizationId,
            `game-server.audit.${createAction}.accepted`,
            serverId,
            input.actorId,
            auditOperationId,
            input.correlationId,
            now,
            now,
          ),
        database
          .prepare(
            `INSERT INTO lifecycle_workflow_starts
          (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`,
          )
          .bind(input.organizationId, operationId, startRecordId, now, now),
        database
          .prepare(
            `INSERT INTO game_servers
          (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
           placement_policy_json, domain, steam_credential_reference, pending_lifecycle_operation_id, desired_revision,
           observed_revision, active_config_revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`,
          )
          .bind(
            input.organizationId,
            serverId,
            input.intent.name,
            input.plan.pluginId,
            input.plan.pluginVersion,
            state.desired,
            state.observed,
            JSON.stringify({
              mode: input.plan.placementMode,
              nodeId: input.plan.nodeId,
            }),
            input.plan.domain ?? null,
            input.intent.steamCredentialRef ?? null,
            operationId,
            now,
            now,
          ),
        database
          .prepare(
            `INSERT INTO game_server_desired_specs
          (organization_id, server_id, schema_version, desired_revision,
           source_operation_id, spec_json, created_at, updated_at)
          VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
          )
          .bind(input.organizationId, serverId, operationId, JSON.stringify(desiredSpec), now, now),
        database
          .prepare(
            `INSERT INTO deployments
          (organization_id, id, server_id, node_id, desired_revision, observed_revision,
           observed_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, 0, 'installing', ?, ?)`,
          )
          .bind(input.organizationId, deploymentId, serverId, input.plan.nodeId, now, now),
        database
          .prepare(
            `INSERT INTO game_server_config_revisions
          (organization_id, server_id, revision, schema_version, config_json, actor_id, created_at)
          VALUES (?, ?, 1, 1, ?, ?, ?)`,
          )
          .bind(
            input.organizationId,
            serverId,
            JSON.stringify(input.plan.config),
            input.actorId,
            now,
          ),
        database
          .prepare(
            `INSERT INTO mod_sets
          (organization_id, server_id, schema_version, desired_revision, resolved_revision,
           desired_json, resolved_json, revision)
          VALUES (?, ?, 1, 1, 0, ?, '[]', 1)`,
          )
          .bind(input.organizationId, serverId, JSON.stringify(input.plan.mods)),
        database
          .prepare(
            `INSERT INTO server_capacity_reservations
          (organization_id, id, node_id, server_id, operation_id, cpu_millis, ram_bytes,
           disk_bytes, capacity_revision, state, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, runtime.revision, 'reserved', ?
          FROM node_runtime_capacity runtime
          WHERE runtime.organization_id = ? AND runtime.node_id = ?`,
          )
          .bind(
            input.organizationId,
            capacityId,
            input.plan.nodeId,
            serverId,
            operationId,
            cpuMillis,
            ramBytes,
            diskBytes,
            now,
            input.organizationId,
            input.plan.nodeId,
          ),
        ...input.plan.ports.map((port, index) =>
          database
            .prepare(
              `INSERT INTO port_leases
            (organization_id, id, node_id, server_id, protocol, public_port, container_port,
             state, operation_id, revision, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 1, ?)`,
            )
            .bind(
              input.organizationId,
              `${operationId}:port:${index}`,
              input.plan.nodeId,
              serverId,
              port.protocol,
              port.publicPort,
              port.containerPort,
              operationId,
              now,
            ),
        ),
        database
          .prepare(
            `INSERT INTO server_create_reservations
          (organization_id, idempotency_key, fingerprint, reservation_id, server_id,
           deployment_id, operation_id, node_id, plugin_id, plugin_version,
           policy_revision, plugin_selection_revision, node_desired_revision,
           capacity_revision, allocation_revision, catalog_refreshed_at, plan_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.organizationId,
            input.idempotencyKey,
            fingerprint,
            capacityId,
            serverId,
            deploymentId,
            operationId,
            input.plan.nodeId,
            input.plan.pluginId,
            input.plan.pluginVersion,
            input.plan.policyRevision,
            input.plan.pluginSelectionRevision,
            input.plan.nodeDesiredRevision,
            input.plan.capacityRevision,
            input.plan.allocationRevision,
            input.plan.catalogRefreshedAt,
            JSON.stringify(serverCreatePlanJson(input.plan)),
            now,
          ),
        ...(input.plan.domain === undefined
          ? []
          : [
              database
                .prepare(
                  `INSERT INTO dns_records
                (organization_id, id, server_id, hostname, target, proxy_mode, state, revision)
                VALUES (?, ?, ?, ?, ?, 'dns_only', 'pending', 1)`,
                )
                .bind(
                  input.organizationId,
                  `${serverId}:dns`,
                  serverId,
                  input.plan.domain,
                  dnsAuthority!.target,
                ),
            ]),
        ...(auditStage === undefined ? [] : [auditStage.statement]),
        database
          .prepare(auditInsert)
          .bind(
            auditId,
            input.organizationId,
            input.actorId,
            'game-server.create.accepted',
            serverId,
            input.correlationId,
            auditStage?.summaryJson ?? JSON.stringify(auditSummary(operation, input.plan)),
            now,
          ),
        database.prepare(outboxInsert).bind(
          outboxId,
          input.organizationId,
          'game-server.lifecycle.accepted',
          serverId,
          JSON.stringify({
            operationId,
            serverId,
            action: createAction,
            organizationId: input.organizationId,
          }),
          now,
          now,
        ),
        database
          .prepare(insertMutation)
          .bind(
            input.organizationId,
            input.idempotencyKey,
            createAction,
            fingerprint,
            operationId,
            serverId,
            0,
            null,
            auditId,
            JSON.stringify(result),
            now,
          ),
        ...(input.plan.controlPlan.modMetadata === undefined
          ? []
          : [
              database
                .prepare(
                  `INSERT INTO game_mod_metadata_acceptances
                    (organization_id, operation_id, server_id, plugin_id, plugin_version,
                     resolution_state, catalog_json, provenance_json, warnings_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  input.organizationId,
                  operationId,
                  serverId,
                  input.plan.pluginId,
                  input.plan.pluginVersion,
                  input.plan.controlPlan.modMetadata.state,
                  JSON.stringify(input.plan.controlPlan.modMetadata.catalog),
                  JSON.stringify(input.plan.controlPlan.modMetadata.provenance),
                  JSON.stringify(input.plan.controlPlan.modMetadata.warnings),
                  now,
                ),
            ]),
        ...(input.plan.domain === undefined
          ? []
          : [
              database
                .prepare(
                  `INSERT INTO game_lifecycle_dns_authorities
                    (organization_id, operation_id, server_id, deployment_id, node_id,
                     provider_instance_id, hostname, record_type, target, endpoint_revision, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  input.organizationId,
                  operationId,
                  serverId,
                  deploymentId,
                  input.plan.nodeId,
                  dnsAuthority!.providerInstanceId,
                  input.plan.domain,
                  dnsAuthority!.recordType,
                  dnsAuthority!.target,
                  dnsAuthority!.endpointRevision,
                  now,
                ),
            ]),
      ]
      yield* attempt('game-lifecycle.create.batch', () => database.batch(statements))
      return {
        disposition: 'created',
        operation,
        workflowState: 'pending-reconciliation',
      }
    })

  const mutate: GameLifecycleRepository['mutate'] = (input) =>
    Effect.gen(function* () {
      const fingerprint = yield* attempt('game-lifecycle.mutate.fingerprint', () =>
        canonicalGameMutationFingerprint({
          action: input.intent.action,
          organizationId: input.organizationId,
          serverId: input.serverId,
          expectedRevision: input.expectedRevision,
          intent: input.intent,
          policyReconciliationActionId: input.policyReconciliationActionId ?? null,
        }),
      )
      const existing = yield* findIdempotent(
        input.organizationId,
        input.idempotencyKey,
        fingerprint,
      )
      if (existing !== null) return existing
      const now = configured.now()
      const operationId = configured.operationId()
      const auditId = configured.auditEventId()
      const auditOperationId = auditOperationIdFor(operationId)
      const outboxId = configured.outboxEventId()
      const startRecordId = `workflow-start:${operationId}`
      const action = mutationAction(input.intent)
      const state = stateForAction(action)
      const operation = makeOperation(
        input.organizationId,
        input.actorId,
        operationId,
        input.serverId,
        action,
        input.expectedRevision,
        fingerprint,
      )
      if (input.intent.action === 'move') {
        const moveIntent = input.intent
        const facts = yield* attempt('game-lifecycle.move.facts', () =>
          database
            .prepare(moveFactsSql)
            .bind(
              moveIntent.targetNodeId,
              input.organizationId,
              input.serverId,
              input.expectedRevision,
            )
            .first(),
        )
        const fact = rowObject(facts)
        const sourceDeploymentId = fact === undefined ? undefined : text(fact, 'sourceDeploymentId')
        const sourceNodeId = fact === undefined ? undefined : text(fact, 'sourceNodeId')
        const targetNodeId = fact === undefined ? undefined : text(fact, 'targetNodeId')
        const targetPlacementMode =
          fact === undefined ? undefined : text(fact, 'targetPlacementMode')
        const targetCapacityRevision =
          fact === undefined ? undefined : integer(fact, 'targetCapacityRevision')
        const cpuMillis = fact === undefined ? undefined : integer(fact, 'cpuMillis')
        const ramBytes = fact === undefined ? undefined : integer(fact, 'ramBytes')
        const diskBytes = fact === undefined ? undefined : integer(fact, 'diskBytes')
        if (
          sourceDeploymentId === undefined ||
          sourceNodeId === undefined ||
          targetNodeId === undefined ||
          (targetPlacementMode !== 'shared' && targetPlacementMode !== 'dedicated') ||
          targetCapacityRevision === undefined ||
          cpuMillis === undefined ||
          ramBytes === undefined ||
          diskBytes === undefined ||
          sourceNodeId === targetNodeId ||
          targetNodeId !== moveIntent.targetNodeId ||
          cpuMillis < 1 ||
          ramBytes < 1 ||
          diskBytes < 1
        )
          return yield* new GameLifecyclePlacementError({
            serverId: input.serverId,
            message: 'The requested move target is not an eligible organization-owned node',
          })
        const result = {
          ...configured.mutationResult(operation),
          ...commandPayloadSummary(moveIntent),
          sourceNodeId,
          sourceDeploymentId,
          phase: 'reserved' as const,
        }
        const auditEnvelopeEnabled = yield* auditEnvelopeAvailable()
        const auditStage = auditEnvelopeEnabled
          ? yield* stageGameAudit(database, {
              eventId: auditId,
              operation,
              auditOperationId,
              action: 'move',
              correlationId: input.correlationId,
              auditRequestContext: input.auditRequestContext,
              auditActorType: input.auditActorType,
              before: { state: 'captured', summary: mutationBeforeSummary(operation, moveIntent) },
              after: { ...auditSummary(operation), ...commandPayloadSummary(moveIntent) },
              now,
            })
          : undefined
        const statements = [
          database
            .prepare(operationInsert)
            .bind(
              operationId,
              input.organizationId,
              state.operationType,
              input.serverId,
              input.actorId,
              input.idempotencyKey,
              input.correlationId,
              now,
              now,
            ),
          database
            .prepare(auditOperationInsert)
            .bind(
              auditOperationId,
              input.organizationId,
              'game-server.audit.move.accepted',
              input.serverId,
              input.actorId,
              auditOperationId,
              input.correlationId,
              now,
              now,
            ),
          database
            .prepare(`INSERT INTO lifecycle_workflow_starts
            (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`)
            .bind(input.organizationId, operationId, startRecordId, now, now),
          database
            .prepare(`UPDATE game_servers
            SET desired_state = 'running', observed_state = 'moving',
                desired_revision = desired_revision + 1,
                pending_lifecycle_operation_id = ?, updated_at = ?
            WHERE organization_id = ? AND id = ? AND desired_revision = ?
              AND pending_lifecycle_operation_id IS NULL
              AND desired_state <> 'deleted'`)
            .bind(operationId, now, input.organizationId, input.serverId, input.expectedRevision),
          // Keep the exported desired state on the exact lifecycle revision.
          // A legacy server without a post-0059 projection simply updates no
          // row and remains deliberately non-exportable; we never invent one
          // from runtime state.
          database
            .prepare(`UPDATE game_server_desired_specs
            SET desired_revision = desired_revision + 1,
                source_operation_id = ?,
                spec_json = json_set(spec_json, '$.placement', json(?)),
                updated_at = ?
            WHERE organization_id = ? AND server_id = ? AND desired_revision = ?
              AND EXISTS (
                SELECT 1 FROM game_servers server
                WHERE server.organization_id = game_server_desired_specs.organization_id
                  AND server.id = game_server_desired_specs.server_id
                  AND server.desired_revision = ?
                  AND server.pending_lifecycle_operation_id = ?
              )`)
            .bind(
              operationId,
              JSON.stringify({ mode: targetPlacementMode, nodeId: targetNodeId }),
              now,
              input.organizationId,
              input.serverId,
              input.expectedRevision,
              input.expectedRevision + 1,
              operationId,
            ),
          database
            .prepare(`INSERT INTO game_lifecycle_move_reservations
            (organization_id, id, operation_id, server_id, expected_revision,
             source_node_id, target_node_id, cpu_millis, ram_bytes, disk_bytes,
             target_capacity_revision, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
            .bind(
              input.organizationId,
              `${operationId}:target`,
              operationId,
              input.serverId,
              input.expectedRevision,
              sourceNodeId,
              targetNodeId,
              cpuMillis,
              ramBytes,
              diskBytes,
              targetCapacityRevision,
              now,
              now,
            ),
          ...(auditStage === undefined ? [] : [auditStage.statement]),
          database
            .prepare(auditInsert)
            .bind(
              auditId,
              input.organizationId,
              input.actorId,
              'game-server.move.accepted',
              input.serverId,
              input.correlationId,
              auditStage?.summaryJson ?? JSON.stringify(result),
              now,
            ),
          database.prepare(outboxInsert).bind(
            outboxId,
            input.organizationId,
            'game-server.lifecycle.accepted',
            input.serverId,
            JSON.stringify({
              operationId,
              serverId: input.serverId,
              action: 'move',
              organizationId: input.organizationId,
              targetNodeId,
            }),
            now,
            now,
          ),
          database
            .prepare(`INSERT INTO game_lifecycle_moves
            (organization_id, idempotency_key, action, request_fingerprint,
             operation_id, server_id, expected_revision, source_node_id,
             target_node_id, source_deployment_id, backup_policy, backup_id,
             phase, source_preserved, acceptance_audit_event_id, result_json,
             revision, created_at, updated_at)
            VALUES (?, ?, 'move', ?, ?, ?, ?, ?, ?, ?, 'required', NULL,
                    'reserved', 1, ?, ?, 1, ?, ?)`)
            .bind(
              input.organizationId,
              input.idempotencyKey,
              fingerprint,
              operationId,
              input.serverId,
              input.expectedRevision,
              sourceNodeId,
              targetNodeId,
              sourceDeploymentId,
              auditId,
              JSON.stringify(result),
              now,
              now,
            ),
        ]
        yield* attempt('game-lifecycle.move.batch', () => database.batch(statements))
        return {
          disposition: 'created' as const,
          operation,
          workflowState: 'pending-reconciliation' as const,
        }
      }
      const result = {
        ...configured.mutationResult(operation),
        ...commandPayloadSummary(input.intent),
      }
      const auditEnvelopeEnabled = yield* auditEnvelopeAvailable()
      const auditStage = auditEnvelopeEnabled
        ? yield* stageGameAudit(database, {
            eventId: auditId,
            operation,
            auditOperationId,
            action,
            correlationId: input.correlationId,
            auditRequestContext: input.auditRequestContext,
            auditActorType: input.auditActorType,
            before: { state: 'captured', summary: mutationBeforeSummary(operation, input.intent) },
            after: {
              ...auditSummary(operation),
              ...commandPayloadSummary(input.intent),
            },
            forced: input.intent.action === 'delete' && input.intent.forcedCleanup === true,
            now,
          })
        : undefined
      // Desired-spec revisions move in the same transaction as every
      // lifecycle acceptance. Only config/mod mutations alter public desired
      // JSON here; state transitions still advance the source operation so an
      // export is always fenced to the server's current desired revision.
      const desiredSpecUpdate =
        input.intent.action === 'apply-config'
          ? database
              .prepare(`UPDATE game_server_desired_specs
            SET desired_revision = desired_revision + 1,
                source_operation_id = ?,
                spec_json = json_set(spec_json, '$.config', json(?)),
                updated_at = ?
            WHERE organization_id = ? AND server_id = ? AND desired_revision = ?
              AND EXISTS (
                SELECT 1 FROM game_servers server
                WHERE server.organization_id = game_server_desired_specs.organization_id
                  AND server.id = game_server_desired_specs.server_id
                  AND server.desired_revision = ?
                  AND server.pending_lifecycle_operation_id = ?
              )`)
              .bind(
                operationId,
                JSON.stringify(input.intent.config),
                now,
                input.organizationId,
                input.serverId,
                input.expectedRevision,
                input.expectedRevision + 1,
                operationId,
              )
          : input.intent.action === 'sync-mods'
            ? database
                .prepare(`UPDATE game_server_desired_specs
              SET desired_revision = desired_revision + 1,
                  source_operation_id = ?,
                  spec_json = json_set(spec_json, '$.mods', json(?)),
                  updated_at = ?
              WHERE organization_id = ? AND server_id = ? AND desired_revision = ?
                AND EXISTS (
                  SELECT 1 FROM game_servers server
                  WHERE server.organization_id = game_server_desired_specs.organization_id
                    AND server.id = game_server_desired_specs.server_id
                    AND server.desired_revision = ?
                    AND server.pending_lifecycle_operation_id = ?
                )`)
                .bind(
                  operationId,
                  JSON.stringify(input.intent.mods),
                  now,
                  input.organizationId,
                  input.serverId,
                  input.expectedRevision,
                  input.expectedRevision + 1,
                  operationId,
                )
            : database
                .prepare(`UPDATE game_server_desired_specs
              SET desired_revision = desired_revision + 1,
                  source_operation_id = ?,
                  updated_at = ?
              WHERE organization_id = ? AND server_id = ? AND desired_revision = ?
                AND EXISTS (
                  SELECT 1 FROM game_servers server
                  WHERE server.organization_id = game_server_desired_specs.organization_id
                    AND server.id = game_server_desired_specs.server_id
                    AND server.desired_revision = ?
                    AND server.pending_lifecycle_operation_id = ?
                )`)
                .bind(
                  operationId,
                  now,
                  input.organizationId,
                  input.serverId,
                  input.expectedRevision,
                  input.expectedRevision + 1,
                  operationId,
                )
      const statements = [
        database
          .prepare(operationInsert)
          .bind(
            operationId,
            input.organizationId,
            state.operationType,
            input.serverId,
            input.actorId,
            input.idempotencyKey,
            input.correlationId,
            now,
            now,
          ),
        database
          .prepare(auditOperationInsert)
          .bind(
            auditOperationId,
            input.organizationId,
            `game-server.audit.${action}.accepted`,
            input.serverId,
            input.actorId,
            auditOperationId,
            input.correlationId,
            now,
            now,
          ),
        database
          .prepare(
            `INSERT INTO lifecycle_workflow_starts
          (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`,
          )
          .bind(input.organizationId, operationId, startRecordId, now, now),
        database
          .prepare(
            `UPDATE game_servers
          SET desired_state = ?, observed_state = ?, desired_revision = desired_revision + 1,
              pending_lifecycle_operation_id = ?, updated_at = ?
          WHERE organization_id = ? AND id = ? AND desired_revision = ?
            AND pending_lifecycle_operation_id IS NULL
            AND desired_state <> 'deleted'`,
          )
          .bind(
            state.desired,
            state.observed,
            operationId,
            now,
            input.organizationId,
            input.serverId,
            input.expectedRevision,
          ),
        desiredSpecUpdate,
        ...(input.intent.action === 'apply-config'
          ? [
              database
                .prepare(
                  `INSERT INTO game_server_config_revisions
                (organization_id, server_id, revision, schema_version, config_json, actor_id, created_at)
                SELECT organization_id, id, active_config_revision + 1, 1, ?, ?, ?
                FROM game_servers
                WHERE organization_id = ? AND id = ? AND active_config_revision = ?`,
                )
                .bind(
                  JSON.stringify(input.intent.config),
                  input.actorId,
                  now,
                  input.organizationId,
                  input.serverId,
                  input.intent.expectedConfigRevision,
                ),
              database
                .prepare(
                  `UPDATE game_servers
                SET active_config_revision = active_config_revision + 1
                WHERE organization_id = ? AND id = ? AND active_config_revision = ?`,
                )
                .bind(input.organizationId, input.serverId, input.intent.expectedConfigRevision),
            ]
          : []),
        ...(input.intent.action === 'sync-mods'
          ? [
              database
                .prepare(
                  `UPDATE mod_sets
                SET desired_revision = desired_revision + 1, revision = revision + 1,
                    desired_json = ?
                WHERE organization_id = ? AND server_id = ?
                  AND desired_revision = ?`,
                )
                .bind(
                  JSON.stringify(input.intent.mods),
                  input.organizationId,
                  input.serverId,
                  input.intent.expectedModRevision,
                ),
            ]
          : []),
        ...(auditStage === undefined ? [] : [auditStage.statement]),
        database.prepare(auditInsert).bind(
          auditId,
          input.organizationId,
          input.actorId,
          `game-server.${action}.accepted`,
          input.serverId,
          input.correlationId,
          auditStage?.summaryJson ??
            JSON.stringify({
              operationId,
              serverId: input.serverId,
              action,
              expectedRevision: input.expectedRevision,
              ...commandPayloadSummary(input.intent),
            }),
          now,
        ),
        database.prepare(outboxInsert).bind(
          outboxId,
          input.organizationId,
          'game-server.lifecycle.accepted',
          input.serverId,
          JSON.stringify({
            operationId,
            serverId: input.serverId,
            action,
            organizationId: input.organizationId,
          }),
          now,
          now,
        ),
        database
          .prepare(insertMutation)
          .bind(
            input.organizationId,
            input.idempotencyKey,
            action,
            fingerprint,
            operationId,
            input.serverId,
            input.expectedRevision,
            input.policyReconciliationActionId ?? null,
            auditId,
            JSON.stringify(result),
            now,
          ),
      ]
      yield* attempt('game-lifecycle.mutate.batch', () => database.batch(statements))
      return {
        disposition: 'created',
        operation,
        workflowState: 'pending-reconciliation',
      }
    })

  return { findIdempotent, create, mutate }
}

const planningNodesSql = `SELECT COALESCE(json_group_array(json_object(
  'organizationId', node.organization_id,
  'nodeId', node.id,
  'placementMode', node.placement_mode,
  'provider', node.provider_type,
  'region', node.region,
  'plan', node.plan,
  'architecture', runtime.architecture,
  'policyRevision', policy.revision,
  'nodeDesiredRevision', node.desired_revision,
  'capacityRevision', runtime.revision,
  'allocationRevision', allocation.revision,
  'catalogRefreshedAt', provider_catalog.refreshed_at,
  'ready', CASE WHEN node.desired_state = 'ready'
    AND node.observed_state = 'ready'
    AND runtime.agent_ready = 1
    AND runtime.tunnel_ready = 1
    AND runtime.docker_ready = 1
    AND runtime.firewall_ready = 1 THEN 1 ELSE 0 END,
  'capacity', json_object(
    'cpu', runtime.cpu_millis / 1000.0,
    'memoryMiB', runtime.ram_bytes / 1048576.0,
    'diskGiB', runtime.disk_bytes / 1073741824.0
  ),
  'reserved', json_object(
    'cpu', COALESCE((SELECT SUM(reservation.cpu_millis) / 1000.0
      FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = node.organization_id
        AND reservation.node_id = node.id
        AND reservation.state IN ('reserved', 'active')), 0),
    'memoryMiB', COALESCE((SELECT SUM(reservation.ram_bytes) / 1048576.0
      FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = node.organization_id
        AND reservation.node_id = node.id
        AND reservation.state IN ('reserved', 'active')), 0),
    'diskGiB', COALESCE((SELECT SUM(reservation.disk_bytes) / 1073741824.0
      FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = node.organization_id
        AND reservation.node_id = node.id
        AND reservation.state IN ('reserved', 'active')), 0)
  ),
  'dedicatedReservationId', (
    SELECT reservation.idempotency_key
    FROM lifecycle_reservations reservation
    WHERE reservation.organization_id = node.organization_id
      AND reservation.resource_kind = 'node'
      AND reservation.resource_id = node.id
      AND (
        json_extract(reservation.command_json, '$.intent.placementMode') = 'dedicated'
        OR json_extract(reservation.command_json, '$.placementMode') = 'dedicated'
        OR json_extract(reservation.reservation_json, '$.placementMode') = 'dedicated'
      )
    ORDER BY reservation.created_at DESC
    LIMIT 1
  ),
  'livePorts', json((SELECT COALESCE(json_group_array(json_object(
    'protocol', lease.protocol,
    'publicPort', lease.public_port
  )), '[]')
    FROM (
      SELECT port.protocol, port.public_port
      FROM port_leases port
      WHERE port.organization_id = node.organization_id
        AND port.node_id = node.id
        AND port.state <> 'released'
      ORDER BY port.protocol, port.public_port
    ) lease
  ))
)), '[]') AS nodesJson
FROM nodes node
JOIN node_runtime_capacity runtime
  ON runtime.organization_id = node.organization_id
 AND runtime.node_id = node.id
JOIN provider_accounts account
  ON account.id = node.provider_account_id
 AND account.provider_type = node.provider_type
 AND account.status = 'active'
 AND (account.scope = 'platform' OR account.organization_id = node.organization_id)
JOIN provider_allocations allocation
  ON allocation.organization_id = node.organization_id
 AND allocation.provider_account_id = node.provider_account_id
 AND allocation.status = 'active'
JOIN organization_policies policy
  ON policy.organization_id = node.organization_id
JOIN provider_catalog provider_catalog
  ON provider_catalog.provider_type = node.provider_type
 AND provider_catalog.region = node.region
 AND provider_catalog.plan = node.plan
WHERE node.organization_id = ?
ORDER BY node.id`

const planningCatalogSql = `SELECT COALESCE(json_group_array(json_object(
  'pluginId', channel.plugin_id,
  'activeVersion', channel.active_version,
  'selectionRevision', channel.revision
)), '[]') AS catalogJson
FROM server_plugin_channels channel
JOIN game_plugins plugin
  ON plugin.id = channel.plugin_id
 AND plugin.version = channel.active_version
WHERE plugin.status = 'available'`

const workflowDataSql = `SELECT
  operation.organization_id AS organizationId,
  operation.actor_id AS actorId,
  operation.correlation_id AS correlationId,
  operation.idempotency_key AS idempotencyKey,
  operation.id AS operationId,
  operation.resource_id AS serverId,
  operation.created_at AS createdAt,
  COALESCE(mutation.action, move.action) AS action,
  COALESCE(mutation.expected_revision, move.expected_revision) AS expectedPriorRevision,
  COALESCE(mutation.result_json, move.result_json) AS mutationResultJson,
  workflow.state AS workflowState,
  server.plugin_id AS pluginId,
  server.plugin_version AS pluginVersion,
  server.domain AS domain,
  server.steam_credential_reference AS steamCredentialRef,
  -- A move's signed Workflow input is bound to its accepted source
  -- coordinates.  The authoritative deployment is intentionally changed to
  -- the target at cutover, so reconstructing from deployment alone would
  -- falsely reject a later signed Workflow turn as foreign.
  COALESCE(move.source_node_id, deployment.node_id) AS nodeId,
  COALESCE(move.source_deployment_id, deployment.id) AS deploymentId,
  move.target_node_id AS targetNodeId,
  move.phase AS movePhase,
  move.source_preserved AS moveSourcePreserved,
  move.backup_id AS moveBackupId,
  COALESCE((SELECT SUM(reservation.cpu_millis) / 1000.0
    FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = server.organization_id
      AND reservation.server_id = server.id
      AND reservation.state IN ('reserved', 'active')), 0) AS cpu,
  COALESCE((SELECT SUM(reservation.ram_bytes) / 1048576.0
    FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = server.organization_id
      AND reservation.server_id = server.id
      AND reservation.state IN ('reserved', 'active')), 0) AS memoryMiB,
  COALESCE((SELECT SUM(reservation.disk_bytes) / 1073741824.0
    FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = server.organization_id
      AND reservation.server_id = server.id
      AND reservation.state IN ('reserved', 'active')), 0) AS diskGiB,
  COALESCE((SELECT config.config_json
    FROM game_server_config_revisions config
    WHERE config.organization_id = server.organization_id
      AND config.server_id = server.id
      AND config.revision = server.active_config_revision), '{}') AS configJson,
  server.active_config_revision AS configRevision,
  COALESCE((SELECT mods.desired_json
    FROM mod_sets mods
    WHERE mods.organization_id = server.organization_id
      AND mods.server_id = server.id), '[]') AS modsJson,
  COALESCE((SELECT mods.desired_revision
    FROM mod_sets mods
    WHERE mods.organization_id = server.organization_id
      AND mods.server_id = server.id), 0) AS modRevision,
  json((SELECT COALESCE(json_group_array(json_object(
    'protocol', lease.protocol,
    'containerPort', lease.container_port,
    'publicPort', lease.public_port,
    'purpose', lease.protocol || '-' || lease.container_port
  )), '[]')
    FROM (
      SELECT port.protocol, port.container_port, port.public_port
      FROM port_leases port
      WHERE port.organization_id = server.organization_id
        AND port.server_id = server.id
        AND port.state <> 'released'
      ORDER BY port.protocol, port.public_port
    ) lease
  )) AS portsJson
FROM operations operation
LEFT JOIN game_lifecycle_mutations mutation
  ON mutation.organization_id = operation.organization_id
 AND mutation.operation_id = operation.id
LEFT JOIN game_lifecycle_moves move
  ON move.organization_id = operation.organization_id
 AND move.operation_id = operation.id
JOIN lifecycle_workflow_starts workflow
  ON workflow.organization_id = operation.organization_id
 AND workflow.operation_id = operation.id
JOIN game_servers server
  ON server.organization_id = operation.organization_id
 AND server.id = operation.resource_id
JOIN deployments deployment
  ON deployment.organization_id = server.organization_id
 AND deployment.server_id = server.id
WHERE operation.organization_id = ?
  AND operation.id = ?
  AND operation.resource_type = 'server'
  AND (mutation.operation_id IS NOT NULL OR move.operation_id IS NOT NULL)
  AND COALESCE(mutation.server_id, move.server_id) = server.id
  AND server.pending_lifecycle_operation_id = operation.id
  AND (SELECT COUNT(*) FROM deployments exact_deployment
    WHERE exact_deployment.organization_id = server.organization_id
      AND exact_deployment.server_id = server.id) = 1`

const workflowStateUpdateSql = `UPDATE lifecycle_workflow_starts
SET state = 'started', attempts = attempts + 1, last_error = NULL, updated_at = ?
WHERE organization_id = ? AND operation_id = ? AND state IN ('pending', 'started')`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const numberValue = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isFinite(row[key] as number)
    ? (row[key] as number)
    : undefined
const booleanValue = (row: Record<string, unknown>, key: string): boolean | undefined => {
  const value = row[key]
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return undefined
}
const jsonValue = (
  operation: string,
  value: unknown,
): Effect.Effect<unknown, GameLifecycleD1Error> =>
  typeof value !== 'string'
    ? Effect.fail(persistence(operation, 'expected JSON text'))
    : Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: (cause) => persistence(operation, cause),
      })
const jsonArray = (operation: string, value: unknown) =>
  jsonValue(operation, value).pipe(
    Effect.flatMap((parsed) =>
      Array.isArray(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(persistence(operation, 'expected JSON array')),
    ),
  )

const decodePlanningNode = (
  organizationId: string,
  value: unknown,
  portRange: { readonly start: number; readonly end: number },
): Effect.Effect<GameNodeFact, GameLifecycleD1Error> => {
  if (!isRecord(value))
    return Effect.fail(persistence('game-lifecycle.planning.nodes.decode', 'invalid node row'))
  const nodeOrganizationId = text(value, 'organizationId')
  const nodeId = text(value, 'nodeId')
  const placementMode = text(value, 'placementMode')
  const provider = text(value, 'provider')
  const region = text(value, 'region')
  const plan = text(value, 'plan')
  const architecture = text(value, 'architecture')
  const ready = booleanValue(value, 'ready')
  const policyRevision = numberValue(value, 'policyRevision')
  const nodeDesiredRevision = numberValue(value, 'nodeDesiredRevision')
  const capacityRevision = numberValue(value, 'capacityRevision')
  const allocationRevision = numberValue(value, 'allocationRevision')
  const catalogRefreshedAt = text(value, 'catalogRefreshedAt')
  const capacity = isRecord(value.capacity) ? value.capacity : undefined
  const reserved = isRecord(value.reserved) ? value.reserved : undefined
  const capacityCpu = capacity === undefined ? undefined : numberValue(capacity, 'cpu')
  const capacityMemory = capacity === undefined ? undefined : numberValue(capacity, 'memoryMiB')
  const capacityDisk = capacity === undefined ? undefined : numberValue(capacity, 'diskGiB')
  const reservedCpu = reserved === undefined ? undefined : numberValue(reserved, 'cpu')
  const reservedMemory = reserved === undefined ? undefined : numberValue(reserved, 'memoryMiB')
  const reservedDisk = reserved === undefined ? undefined : numberValue(reserved, 'diskGiB')
  const dedicatedReservationId =
    value.dedicatedReservationId === null ? undefined : text(value, 'dedicatedReservationId')
  const rawPorts = Array.isArray(value.livePorts) ? value.livePorts : undefined
  if (
    nodeOrganizationId !== organizationId ||
    nodeId === undefined ||
    (placementMode !== 'shared' && placementMode !== 'dedicated') ||
    provider === undefined ||
    region === undefined ||
    plan === undefined ||
    (architecture !== 'amd64' && architecture !== 'arm64') ||
    ready === undefined ||
    policyRevision === undefined ||
    !Number.isInteger(policyRevision) ||
    policyRevision < 1 ||
    nodeDesiredRevision === undefined ||
    !Number.isInteger(nodeDesiredRevision) ||
    nodeDesiredRevision < 1 ||
    capacityRevision === undefined ||
    !Number.isInteger(capacityRevision) ||
    capacityRevision < 1 ||
    allocationRevision === undefined ||
    !Number.isInteger(allocationRevision) ||
    allocationRevision < 1 ||
    catalogRefreshedAt === undefined ||
    capacityCpu === undefined ||
    capacityMemory === undefined ||
    capacityDisk === undefined ||
    reservedCpu === undefined ||
    reservedMemory === undefined ||
    reservedDisk === undefined ||
    rawPorts === undefined
  )
    return Effect.fail(persistence('game-lifecycle.planning.nodes.decode', 'invalid node facts'))
  const livePorts: Array<{ protocol: 'tcp' | 'udp'; publicPort: number }> = []
  for (const port of rawPorts) {
    if (!isRecord(port))
      return Effect.fail(persistence('game-lifecycle.planning.nodes.decode', 'invalid live port'))
    const protocol = text(port, 'protocol')
    const publicPort = numberValue(port, 'publicPort')
    if (
      (protocol !== 'tcp' && protocol !== 'udp') ||
      publicPort === undefined ||
      !Number.isInteger(publicPort)
    )
      return Effect.fail(persistence('game-lifecycle.planning.nodes.decode', 'invalid live port'))
    livePorts.push({ protocol, publicPort })
  }
  return Effect.succeed({
    organizationId,
    nodeId,
    placementMode,
    provider,
    region,
    plan,
    architecture,
    ready,
    policyRevision,
    nodeDesiredRevision,
    capacityRevision,
    allocationRevision,
    catalogRefreshedAt,
    capacity: { cpu: capacityCpu, memoryMiB: capacityMemory, diskGiB: capacityDisk },
    reserved: { cpu: reservedCpu, memoryMiB: reservedMemory, diskGiB: reservedDisk },
    livePorts,
    ...(dedicatedReservationId === undefined ? {} : { dedicatedReservationId }),
    portRange,
  })
}

const decodeCatalogSelection = (
  value: unknown,
  imageCatalog: readonly GamePluginCatalogEntry[],
): Effect.Effect<readonly GamePluginCatalogEntry[], GameLifecycleD1Error> =>
  jsonArray('game-lifecycle.planning.catalog.decode', value).pipe(
    Effect.flatMap((rows) => {
      const immutable = new Map(
        imageCatalog.map((entry) => [`${entry.pluginId}@${entry.activeVersion}`, entry]),
      )
      const selected: GamePluginCatalogEntry[] = []
      for (const row of rows) {
        if (!isRecord(row))
          return Effect.fail(
            persistence('game-lifecycle.planning.catalog.decode', 'invalid catalog row'),
          )
        const pluginId = text(row, 'pluginId')
        const activeVersion = text(row, 'activeVersion')
        const selectionRevision = numberValue(row, 'selectionRevision')
        if (
          pluginId === undefined ||
          activeVersion === undefined ||
          selectionRevision === undefined ||
          !Number.isInteger(selectionRevision) ||
          selectionRevision < 1
        )
          return Effect.fail(
            persistence('game-lifecycle.planning.catalog.decode', 'invalid catalog identifiers'),
          )
        const entry = immutable.get(`${pluginId}@${activeVersion}`)
        if (entry !== undefined) selected.push({ ...entry, selectionRevision })
      }
      return Effect.succeed(selected)
    }),
  )

const decodeWorkflowData = (
  organizationId: string,
  value: unknown,
  imageCatalog: readonly GamePluginCatalogEntry[],
): Effect.Effect<GameLifecycleWorkflowData, GameLifecycleD1Error> => {
  const row = rowObject(value)
  if (row === undefined)
    return Effect.fail(
      persistence('game-lifecycle.workflow-data.decode', 'workflow data is missing'),
    )
  const rowOrganizationId = text(row, 'organizationId')
  const actorId = text(row, 'actorId')
  const correlationId = text(row, 'correlationId')
  const idempotencyKey = text(row, 'idempotencyKey')
  const operationId = text(row, 'operationId')
  const serverId = text(row, 'serverId')
  const createdAt = text(row, 'createdAt')
  const action = text(row, 'action')
  const expectedPriorRevision = integer(row, 'expectedPriorRevision')
  const workflowState = text(row, 'workflowState')
  const nodeId = text(row, 'nodeId')
  const targetNodeId = row.targetNodeId === null ? undefined : text(row, 'targetNodeId')
  const movePhase = row.movePhase === null ? undefined : text(row, 'movePhase')
  const moveSourcePreserved =
    row.moveSourcePreserved === null ? undefined : booleanValue(row, 'moveSourcePreserved')
  const moveBackupId = row.moveBackupId === null ? undefined : text(row, 'moveBackupId')
  const deploymentId = text(row, 'deploymentId')
  const pluginId = text(row, 'pluginId')
  const pluginVersion = text(row, 'pluginVersion')
  const mutationResultJson = text(row, 'mutationResultJson')
  const cpu = numberValue(row, 'cpu')
  const memoryMiB = numberValue(row, 'memoryMiB')
  const diskGiB = numberValue(row, 'diskGiB')
  const configRevision = integer(row, 'configRevision')
  const modRevision = integer(row, 'modRevision')
  type MovePhase = NonNullable<GameLifecycleWorkflowData['movePhase']>
  const movePhaseValue =
    movePhase !== undefined &&
    (
      [
        'reserved',
        'backup',
        'stopped',
        'restoring',
        'validated',
        'cutover',
        'released',
        'rolled_back',
        'failed',
      ] as readonly string[]
    ).includes(movePhase)
      ? (movePhase as MovePhase)
      : undefined
  if (
    rowOrganizationId !== organizationId ||
    actorId === undefined ||
    correlationId === undefined ||
    idempotencyKey === undefined ||
    operationId === undefined ||
    serverId === undefined ||
    createdAt === undefined ||
    action === undefined ||
    !lifecycleActions.has(action as GameLifecycleOperation['action']) ||
    expectedPriorRevision === undefined ||
    (workflowState !== 'pending' && workflowState !== 'started') ||
    nodeId === undefined ||
    deploymentId === undefined ||
    pluginId === undefined ||
    pluginVersion === undefined ||
    cpu === undefined ||
    memoryMiB === undefined ||
    diskGiB === undefined ||
    cpu <= 0 ||
    memoryMiB < 128 ||
    diskGiB < 1 ||
    configRevision === undefined ||
    configRevision < 1 ||
    modRevision === undefined ||
    modRevision < 0 ||
    (action === 'move' &&
      (targetNodeId === undefined || movePhaseValue === undefined || moveSourcePreserved !== true))
  )
    return Effect.fail(
      persistence(
        'game-lifecycle.workflow-data.decode',
        'invalid workflow identifiers or resources',
      ),
    )
  const image = imageCatalog.find(
    (entry) => entry.pluginId === pluginId && entry.activeVersion === pluginVersion,
  )?.image
  const domain = row.domain === null ? undefined : text(row, 'domain')
  const steamCredentialRef =
    row.steamCredentialRef === null ? undefined : text(row, 'steamCredentialRef')
  if (row.domain !== null && domain === undefined)
    return Effect.fail(persistence('game-lifecycle.workflow-data.decode', 'invalid domain'))
  if (row.steamCredentialRef !== null && steamCredentialRef === undefined)
    return Effect.fail(
      persistence('game-lifecycle.workflow-data.decode', 'invalid Steam credential reference'),
    )
  let mutationResult: Record<string, unknown> = {}
  if (mutationResultJson !== undefined) {
    try {
      const parsed = JSON.parse(mutationResultJson) as unknown
      if (!isRecord(parsed))
        return Effect.fail(
          persistence('game-lifecycle.workflow-data.decode', 'invalid mutation result'),
        )
      mutationResult = parsed
    } catch (cause) {
      return Effect.fail(persistence('game-lifecycle.workflow-data.decode', cause))
    }
  }
  const backupBeforeUpdate =
    typeof mutationResult.backupBeforeUpdate === 'boolean'
      ? mutationResult.backupBeforeUpdate
      : undefined
  const backupPolicy =
    mutationResult.backupPolicy === 'required' || mutationResult.backupPolicy === 'skip-authorized'
      ? mutationResult.backupPolicy
      : undefined
  const forcedCleanup = mutationResult.forcedCleanup === true ? (true as const) : undefined
  return Effect.gen(function* () {
    const configParsed = yield* jsonValue('game-lifecycle.workflow-data.config', row.configJson)
    const modsParsed = yield* jsonArray('game-lifecycle.workflow-data.mods', row.modsJson)
    const portsParsed = yield* jsonArray('game-lifecycle.workflow-data.ports', row.portsJson)
    if (!isRecord(configParsed))
      return yield* persistence('game-lifecycle.workflow-data.config', 'config must be an object')
    const mods: Array<{
      source: string
      id: string
      requestedVersion?: string
      loadOrder: number
    }> = []
    for (const mod of modsParsed) {
      if (!isRecord(mod))
        return yield* persistence('game-lifecycle.workflow-data.mods', 'invalid mod record')
      const source = text(mod, 'source')
      const id = text(mod, 'id')
      const loadOrder = numberValue(mod, 'loadOrder')
      const requestedVersion =
        mod.requestedVersion === null ? undefined : text(mod, 'requestedVersion')
      if (
        source === undefined ||
        id === undefined ||
        loadOrder === undefined ||
        !Number.isInteger(loadOrder) ||
        loadOrder < 0
      )
        return yield* persistence('game-lifecycle.workflow-data.mods', 'invalid mod record')
      if (
        mod.requestedVersion !== undefined &&
        mod.requestedVersion !== null &&
        requestedVersion === undefined
      )
        return yield* persistence('game-lifecycle.workflow-data.mods', 'invalid mod version')
      mods.push({
        source,
        id,
        loadOrder,
        ...(requestedVersion === undefined ? {} : { requestedVersion }),
      })
    }
    const ports: Array<{
      protocol: 'tcp' | 'udp'
      containerPort: number
      publicPort: number
      purpose: string
    }> = []
    for (const port of portsParsed) {
      if (!isRecord(port))
        return yield* persistence('game-lifecycle.workflow-data.ports', 'invalid port record')
      const protocol = text(port, 'protocol')
      const containerPort = numberValue(port, 'containerPort')
      const publicPort = numberValue(port, 'publicPort')
      const purpose = text(port, 'purpose')
      if (
        (protocol !== 'tcp' && protocol !== 'udp') ||
        containerPort === undefined ||
        publicPort === undefined ||
        !Number.isInteger(containerPort) ||
        !Number.isInteger(publicPort) ||
        containerPort < 1 ||
        containerPort > 65_535 ||
        publicPort < 1 ||
        publicPort > 65_535 ||
        purpose === undefined
      )
        return yield* persistence('game-lifecycle.workflow-data.ports', 'invalid port record')
      ports.push({ protocol, containerPort, publicPort, purpose })
    }
    return {
      organizationId,
      actorId,
      correlationId,
      idempotencyKey,
      operationId,
      serverId,
      action: action as GameLifecycleOperation['action'],
      expectedPriorRevision,
      createdAt,
      workflowState,
      nodeId,
      ...(targetNodeId === undefined ? {} : { targetNodeId }),
      ...(movePhaseValue === undefined ? {} : { movePhase: movePhaseValue }),
      ...(moveSourcePreserved === undefined ? {} : { moveSourcePreserved }),
      ...(moveBackupId === undefined ? {} : { moveBackupId }),
      deploymentId,
      pluginId,
      pluginVersion,
      ...(image === undefined ? {} : { image }),
      ...(domain === undefined ? {} : { domain }),
      ...(steamCredentialRef === undefined ? {} : { steamCredentialRef }),
      ...(backupBeforeUpdate === undefined ? {} : { backupBeforeUpdate }),
      ...(backupPolicy === undefined ? {} : { backupPolicy }),
      ...(forcedCleanup === undefined ? {} : { forcedCleanup }),
      ports,
      resources: { cpu, memoryMiB, diskGiB },
      config: configParsed,
      mods,
      configRevision,
      modRevision,
    }
  })
}

export const makeGameLifecyclePlanningD1Repository = (
  database: GameLifecycleD1Database,
  options: GameLifecyclePlanningD1Options,
): GameLifecyclePlanningD1Repository => {
  const configuredPortRange = options.portRange ?? { start: 20_000, end: 60_000 }
  const now = options.now ?? (() => new Date().toISOString())
  if (
    !Number.isInteger(configuredPortRange.start) ||
    !Number.isInteger(configuredPortRange.end) ||
    configuredPortRange.start < 1 ||
    configuredPortRange.end > 65_535 ||
    configuredPortRange.start > configuredPortRange.end
  )
    throw new Error('invalid game lifecycle port range')

  const readPlanningFacts = (organizationId: string) =>
    Effect.gen(function* () {
      const nodesValue = yield* attempt('game-lifecycle.planning.nodes.read', () =>
        database.prepare(planningNodesSql).bind(organizationId).first(),
      )
      const nodeRow = rowObject(nodesValue)
      if (nodeRow === undefined)
        return yield* persistence(
          'game-lifecycle.planning.nodes.read',
          'planning node aggregate is missing',
        )
      const nodes = yield* jsonArray(
        'game-lifecycle.planning.nodes.decode',
        nodeRow.nodesJson,
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodePlanningNode(organizationId, row, configuredPortRange),
          ),
        ),
      )
      const catalogValue = yield* attempt('game-lifecycle.planning.catalog.read', () =>
        database.prepare(planningCatalogSql).first(),
      )
      const catalogRow = rowObject(catalogValue)
      if (catalogRow === undefined)
        return yield* persistence(
          'game-lifecycle.planning.catalog.read',
          'plugin catalog aggregate is missing',
        )
      const catalog = yield* decodeCatalogSelection(catalogRow.catalogJson, options.imageCatalog)
      return { nodes, catalog }
    })

  const readWorkflowData = (organizationId: string, operationId: string) =>
    Effect.gen(function* () {
      const value = yield* attempt('game-lifecycle.workflow-data.read', () =>
        database.prepare(workflowDataSql).bind(organizationId, operationId).first(),
      )
      return yield* decodeWorkflowData(organizationId, value, options.imageCatalog)
    })

  const markWorkflowStarted = (organizationId: string, operationId: string) =>
    Effect.gen(function* () {
      const timestamp = now()
      yield* attempt('game-lifecycle.workflow-start.mark', () =>
        database
          .batch([
            database.prepare(workflowStateUpdateSql).bind(timestamp, organizationId, operationId),
          ])
          .then(() => undefined),
      )
      const row = yield* attempt('game-lifecycle.workflow-start.verify', () =>
        database
          .prepare(
            `SELECT state FROM lifecycle_workflow_starts WHERE organization_id = ? AND operation_id = ?`,
          )
          .bind(organizationId, operationId)
          .first(),
      )
      const state = rowObject(row)
      if (state === undefined || text(state, 'state') !== 'started')
        return yield* persistence(
          'game-lifecycle.workflow-start.verify',
          'workflow start record is missing or not started',
        )
    })

  return { readPlanningFacts, readWorkflowData, markWorkflowStarted }
}

export const GameLifecyclePlanningD1Live = (options: GameLifecyclePlanningD1Options) =>
  Layer.effect(
    GameLifecyclePlanningD1,
    Effect.gen(function* () {
      const database = yield* GameLifecycleD1Client
      return makeGameLifecyclePlanningD1Repository(database, options)
    }),
  )

export const makeGameLifecycleObservationD1Repository = (
  database: GameLifecycleD1Database,
): GameLifecycleObservationD1Repository => ({
  readObservation: (organizationId, serverId, operationId) =>
    Effect.gen(function* () {
      const row = yield* attempt('game-lifecycle.observation.read', () =>
        database.prepare(latestObservationSql).bind(organizationId, serverId, operationId).first(),
      )
      const value = rowObject(row)
      const observedOrganizationId = value === undefined ? undefined : text(value, 'organizationId')
      const observedServerId = value === undefined ? undefined : text(value, 'serverId')
      const observedOperationId = value === undefined ? undefined : text(value, 'operationId')
      const observedRevision = value === undefined ? undefined : integer(value, 'observedRevision')
      const state = value === undefined ? undefined : text(value, 'state')
      const observedAt = value === undefined ? undefined : text(value, 'observedAt')
      if (
        observedOrganizationId !== organizationId ||
        observedServerId !== serverId ||
        observedOperationId !== operationId ||
        observedRevision === undefined ||
        state === undefined ||
        observedAt === undefined
      )
        return yield* persistence(
          'game-lifecycle.observation.read',
          'authoritative game observation is missing or scope-mismatched',
        )
      let error: string | undefined
      const observationJson = text(value!, 'observationJson')
      if (observationJson !== undefined) {
        try {
          const parsed = JSON.parse(observationJson) as Record<string, unknown>
          if (typeof parsed.error === 'string') error = parsed.error
        } catch {
          return yield* persistence(
            'game-lifecycle.observation.read',
            'authoritative observation JSON is invalid',
          )
        }
      }
      return {
        organizationId,
        serverId,
        operationId,
        observedRevision,
        state,
        observedAt,
        ...(error === undefined ? {} : { error }),
      }
    }),
  verifyNoDns: (organizationId, serverId, operationId) =>
    Effect.gen(function* () {
      const row = yield* attempt('game-lifecycle.observation.no-dns', () =>
        database
          .prepare(
            `SELECT 1 AS verified
          FROM game_servers server
          JOIN operations operation
            ON operation.organization_id = server.organization_id
           AND operation.id = server.pending_lifecycle_operation_id
          JOIN lifecycle_workflow_starts workflow
            ON workflow.organization_id = operation.organization_id
           AND workflow.operation_id = operation.id
          WHERE server.organization_id = ? AND server.id = ?
            AND server.domain IS NULL
            AND server.pending_lifecycle_operation_id = ?
            AND operation.resource_type = 'server'
            AND operation.resource_id = server.id
            AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
            AND workflow.state IN ('pending', 'started')
            AND NOT EXISTS (
              SELECT 1 FROM dns_records dns
              WHERE dns.organization_id = server.organization_id
                AND dns.server_id = server.id
                AND dns.state <> 'deleted'
            )`,
          )
          .bind(organizationId, serverId, operationId)
          .first(),
      )
      const verified =
        rowObject(row) === undefined ? undefined : integer(rowObject(row)!, 'verified')
      if (verified !== 1)
        return yield* persistence(
          'game-lifecycle.observation.no-dns',
          'exact pending no-domain lifecycle evidence is missing or scope-mismatched',
        )
      return { organizationId, serverId, operationId }
    }),
})

export const makeGameLifecycleCleanupD1Repository = (
  database: GameLifecycleD1Database,
): GameLifecycleCleanupD1Repository => ({
  requireDeletedDnsReceipt: (organizationId, serverId, operationId) =>
    Effect.gen(function* () {
      const raw = yield* attempt('game-lifecycle.cleanup.deleted-dns.read', () =>
        database.prepare(deletedDnsReceiptSql).bind(operationId, organizationId, serverId).first(),
      )
      const row = rowObject(raw)
      if (row === undefined)
        return yield* persistence(
          'game-lifecycle.cleanup.deleted-dns.read',
          'delete operation or server is missing or scope-mismatched',
        )
      const operationType = text(row, 'operationType')
      const operationStatus = text(row, 'operationStatus')
      const operationProgress = integer(row, 'operationProgress')
      const operationRevision = integer(row, 'operationRevision')
      const completionState = text(row, 'completionState')
      const completionOperationRevision = integer(row, 'completionOperationRevision')
      const domain = text(row, 'domain')
      const liveDnsCount = integer(row, 'liveDnsCount')
      if (
        operationType !== 'server.delete' ||
        operationStatus !== 'succeeded' ||
        operationProgress !== 100 ||
        operationRevision === undefined ||
        completionState !== 'succeeded' ||
        completionOperationRevision !== operationRevision ||
        liveDnsCount === undefined ||
        liveDnsCount !== 0
      )
        return yield* persistence(
          'game-lifecycle.cleanup.deleted-dns.read',
          'delete operation is not terminal or live DNS ownership remains',
        )
      if (domain === undefined) {
        return {
          organizationId,
          serverId,
          operationId,
          state: 'none' as const,
          revision: 0,
        }
      }
      const receiptState = text(row, 'receiptState')
      const hostname = text(row, 'hostname')
      const recordType = text(row, 'recordType')
      const target = text(row, 'target')
      const providerRecordId = text(row, 'providerRecordId')
      const revision = integer(row, 'receiptRevision')
      if (
        receiptState !== 'deleted' ||
        hostname !== domain ||
        (recordType !== 'A' && recordType !== 'AAAA') ||
        target === undefined ||
        revision === undefined ||
        revision < 1
      )
        return yield* persistence(
          'game-lifecycle.cleanup.deleted-dns.read',
          'operation-bound deleted DNS receipt is missing or scope-mismatched',
        )
      return {
        organizationId,
        serverId,
        operationId,
        state: 'deleted' as const,
        hostname,
        recordType,
        target,
        ...(providerRecordId === undefined ? {} : { providerRecordId }),
        revision,
      }
    }),
})

export const GameLifecycleCleanupD1Live = Layer.effect(
  GameLifecycleCleanupD1,
  Effect.gen(function* () {
    const database = yield* GameLifecycleD1Client
    return makeGameLifecycleCleanupD1Repository(database)
  }),
)

export const GameLifecycleObservationD1Live = Layer.effect(
  GameLifecycleObservationD1,
  Effect.gen(function* () {
    const database = yield* GameLifecycleD1Client
    return makeGameLifecycleObservationD1Repository(database)
  }),
)

export const GameLifecycleD1RepositoryLive = Layer.effect(
  GameLifecycleD1Repository,
  Effect.gen(function* () {
    const database = yield* GameLifecycleD1Client
    return makeGameLifecycleD1Repository(database)
  }),
)

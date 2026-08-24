import { Context, Effect, Layer, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  PolicyActionDispatch,
  PolicyReconciliationActionRecord,
  PolicyReconciliationError,
  PolicyReconciliationPlan,
  PolicyReconciliationRepository,
  PolicyReconciliationResult,
  PolicyNodeSnapshot,
  PolicyServerSnapshot,
  type PolicyActionDispatchState,
  type PolicyReconciliationRepositoryShape,
  type PolicyReconciliationRequest,
  type PolicyReconciliationSnapshot,
} from '@gridora/policy-reconciliation-control'
import { decodeOrganizationPolicy, type OrganizationUsage } from '@gridora/policy-control'

export interface PolicyReconciliationD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface PolicyReconciliationD1Statement {
  bind(...values: ReadonlyArray<unknown>): PolicyReconciliationD1Statement
  first(): Promise<unknown>
  all(): Promise<PolicyReconciliationD1Result>
}
export interface PolicyReconciliationD1Database {
  prepare(sql: string): PolicyReconciliationD1Statement
  batch(
    statements: ReadonlyArray<PolicyReconciliationD1Statement>,
  ): Promise<ReadonlyArray<PolicyReconciliationD1Result>>
}

export class PolicyReconciliationD1Client extends Context.Service<
  PolicyReconciliationD1Client,
  PolicyReconciliationD1Database
>()('@gridora/policy-reconciliation-d1/PolicyReconciliationD1Client') {}
export const PolicyReconciliationD1ClientLayer = (database: PolicyReconciliationD1Database) =>
  Layer.succeed(PolicyReconciliationD1Client, database)

export interface PolicyReconciliationD1Options {
  readonly now?: () => string
}
const defaults: Required<PolicyReconciliationD1Options> = { now: () => new Date().toISOString() }

const failure = (
  operation: string,
  code:
    | 'invalid-request'
    | 'invalid-scope'
    | 'stale-policy'
    | 'stale-resource'
    | 'stale-snapshot'
    | 'unbounded-snapshot'
    | 'idempotency-conflict'
    | 'persistence-failed',
) => new PolicyReconciliationError({ operation, code, message: 'policy reconciliation failed' })

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation, 'persistence-failed') })
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const text = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined =>
  value !== undefined && typeof value[key] === 'string' ? (value[key] as string) : undefined
const integer = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined =>
  value !== undefined && typeof value[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined
const nullableText = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null | undefined => (value?.[key] === null ? null : text(value, key))
const nullableInteger = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | null | undefined => (value?.[key] === null ? null : integer(value, key))
const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const runByIdempotencySql = `SELECT organization_id AS organizationId, run_id AS runId,
 actor_id AS actorId, policy_revision AS policyRevision, schedule_slot AS scheduleSlot,
 idempotency_key AS idempotencyKey, lease_token AS leaseToken,
 observed_at AS observedAt, snapshot_fingerprint AS snapshotFingerprint
 FROM policy_reconciliation_runs WHERE organization_id = ? AND idempotency_key = ?`
const actionsByRunSql = `SELECT id, organization_id AS organizationId, run_id AS runId, actor_id AS actorId,
 policy_revision AS policyRevision, resource_kind AS resourceKind, resource_id AS resourceId,
 resource_revision AS resourceRevision, action AS kind, reason, idempotency_key AS idempotencyKey,
 correlation_id AS correlationId, resource_expires_at AS resourceExpiresAt,
 activity_last_at AS activityLastAt, health_sampled_at AS healthSampledAt,
 health_revision AS healthRevision, config_revision AS configRevision, mod_revision AS modRevision,
 update_candidate_id AS updateCandidateId,
 update_candidate_revision AS updateCandidateRevision, update_category AS updateCategory,
 update_target_version AS updateTargetVersion, dispatch_state AS dispatchState,
 operation_id AS operationId
 FROM policy_reconciliation_actions WHERE organization_id = ? AND run_id = ? ORDER BY id`
const policyScopeSql = `SELECT organization.id AS organizationId, scheduler.identity_id AS actorId,
 organization.policy_revision AS organizationPolicyRevision, policy.revision AS policyRevision,
 policy.policy_json AS policyJson
 FROM organizations organization
 JOIN organization_policies policy ON policy.organization_id = organization.id
 JOIN policy_reconciliation_scheduler_identities scheduler ON scheduler.organization_id = organization.id
 JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
 JOIN organization_memberships membership
   ON membership.organization_id = organization.id AND membership.identity_id = actor.id
 WHERE organization.id = ? AND scheduler.identity_id = ?
   AND organization.status = 'active' AND organization.policy_revision = ?
   AND policy.revision = ? AND membership.status = 'active' AND membership.role = 'automation'`
const usageSql = `SELECT
 (SELECT count(*) FROM nodes WHERE organization_id = ?
   AND desired_state <> 'deleted' AND observed_state <> 'deleted') AS activeNodes,
 (SELECT count(*) FROM nodes WHERE organization_id = ? AND placement_mode = 'dedicated'
   AND desired_state <> 'deleted' AND observed_state <> 'deleted') AS dedicatedNodes,
 (SELECT json_extract(policy_json, '$.monthlyBudget.currency') FROM organization_policies
   WHERE organization_id = ?) AS budgetCurrency`
const serverCountsSql = `SELECT deployment.node_id AS nodeId, count(*) AS serverCount
 FROM deployments deployment JOIN game_servers server
   ON server.organization_id = deployment.organization_id AND server.id = deployment.server_id
 WHERE deployment.organization_id = ? AND server.desired_state <> 'deleted'
   AND deployment.observed_state <> 'deleted'
 GROUP BY deployment.node_id ORDER BY deployment.node_id`
const nodesSql = `SELECT node.organization_id AS organizationId, node.id AS nodeId,
 node.desired_revision AS desiredRevision, node.desired_state AS desiredState,
 node.observed_state AS observedState, node.temporary_expires_at AS temporaryExpiresAt
 FROM nodes node JOIN organization_policies policy ON policy.organization_id = node.organization_id
 WHERE node.organization_id = ?
   AND json_extract(policy.policy_json, '$.temporaryNodes.automaticExpiryRequired') = 1
   AND node.temporary_expires_at IS NOT NULL AND julianday(node.temporary_expires_at) <= julianday(?)
   AND node.desired_state NOT IN ('deleted', 'draining') AND node.observed_state <> 'deleted'
 ORDER BY node.temporary_expires_at, node.id LIMIT 100`
const serversSql = `SELECT server.organization_id AS organizationId, server.id AS serverId,
 server.desired_revision AS desiredRevision, server.desired_state AS desiredState,
 server.observed_state AS observedState, server.active_config_revision AS activeConfigRevision,
 COALESCE(mods.desired_revision, 0) AS desiredModRevision,
 server.pending_lifecycle_operation_id AS pendingLifecycleOperationId,
 activity.last_player_activity_at AS lastActivityAt,
 health.sampled_at AS healthSampledAt, health.revision AS healthRevision,
 CASE WHEN json_type(health.summary_json, '$.game.playerCount') = 'integer'
   THEN CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) ELSE NULL END AS currentPlayerCount,
 candidate.id AS updateCandidateId, candidate.revision AS updateCandidateRevision,
 candidate.category AS updateCategory, candidate.target_version AS updateTargetVersion
 FROM game_servers server
 JOIN organization_policies policy ON policy.organization_id = server.organization_id
 LEFT JOIN mod_sets mods ON mods.organization_id = server.organization_id AND mods.server_id = server.id
 LEFT JOIN policy_reconciliation_server_activity activity
   ON activity.organization_id = server.organization_id AND activity.server_id = server.id
 LEFT JOIN health_current_snapshots health
   ON health.organization_id = server.organization_id AND health.resource_type = 'server'
     AND health.resource_id = server.id AND health.status = 'healthy'
     AND json_extract(health.summary_json, '$.game.process') = 'running'
 LEFT JOIN policy_reconciliation_update_candidates candidate
   ON candidate.organization_id = server.organization_id AND candidate.server_id = server.id
     AND candidate.status = 'active'
     AND candidate.revision = (
       SELECT max(candidate2.revision) FROM policy_reconciliation_update_candidates candidate2
       WHERE candidate2.organization_id = server.organization_id AND candidate2.server_id = server.id
         AND candidate2.status = 'active'
     )
 WHERE server.organization_id = ? AND server.desired_state = 'running'
   AND server.observed_state = 'running' AND server.pending_lifecycle_operation_id IS NULL
   AND (
     candidate.id IS NOT NULL
     OR (
       json_extract(policy.policy_json, '$.idle.action') <> 'none'
       AND activity.last_player_activity_at IS NOT NULL
       AND health.sampled_at IS NOT NULL
       AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
       AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) = 0
       AND julianday(health.sampled_at) <= julianday(?)
       AND julianday(health.sampled_at) >= julianday(?, '-5 minutes')
       AND julianday(activity.last_player_activity_at) <=
         julianday(?) - json_extract(policy.policy_json, '$.idle.afterMinutes') / 1440.0
     )
   )
 ORDER BY server.id LIMIT 100`

const decodeRecord = (
  value: unknown,
): Effect.Effect<PolicyReconciliationActionRecord, PolicyReconciliationError> =>
  Schema.decodeUnknownEffect(PolicyReconciliationActionRecord, { onExcessProperty: 'error' })(
    value,
  ).pipe(
    Effect.mapError(() => failure('policy-reconciliation.d1.action.decode', 'persistence-failed')),
  )

const decodeResult = (
  request: PolicyReconciliationRequest,
  run: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<unknown>,
  replayed: boolean,
): Effect.Effect<PolicyReconciliationResult, PolicyReconciliationError> =>
  Effect.gen(function* () {
    if (
      text(run, 'organizationId') !== request.organizationId ||
      text(run, 'actorId') !== request.actorId ||
      integer(run, 'policyRevision') !== request.policyRevision ||
      text(run, 'scheduleSlot') !== request.scheduleSlot ||
      text(run, 'runId') !== request.runId ||
      text(run, 'idempotencyKey') !== request.idempotencyKey ||
      text(run, 'leaseToken') !== request.leaseToken
    )
      return yield* failure('policy-reconciliation.d1.replay.binding', 'idempotency-conflict')
    const snapshotFingerprint = text(run, 'snapshotFingerprint')
    if (snapshotFingerprint === undefined)
      return yield* failure('policy-reconciliation.d1.replay.fingerprint', 'persistence-failed')
    const records = yield* Effect.forEach(actions, decodeRecord)
    return yield* Schema.decodeUnknownEffect(PolicyReconciliationResult, {
      onExcessProperty: 'error',
    })({
      organizationId: request.organizationId,
      actorId: request.actorId,
      policyRevision: request.policyRevision,
      runId: request.runId,
      idempotencyKey: request.idempotencyKey,
      snapshotFingerprint,
      actions: records,
      replayed,
    }).pipe(
      Effect.mapError(() =>
        failure('policy-reconciliation.d1.result.decode', 'persistence-failed'),
      ),
    )
  })

const actionValue = (row: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
  id: text(row, 'id'),
  organizationId: text(row, 'organizationId'),
  runId: text(row, 'runId'),
  actorId: text(row, 'actorId'),
  policyRevision: integer(row, 'policyRevision'),
  resourceKind: text(row, 'resourceKind'),
  resourceId: text(row, 'resourceId'),
  resourceRevision: integer(row, 'resourceRevision'),
  kind: text(row, 'kind'),
  reason: text(row, 'reason'),
  idempotencyKey: text(row, 'idempotencyKey'),
  correlationId: text(row, 'correlationId'),
  resourceExpiresAt: nullableText(row, 'resourceExpiresAt'),
  activityLastAt: nullableText(row, 'activityLastAt'),
  healthSampledAt: nullableText(row, 'healthSampledAt'),
  healthRevision: nullableInteger(row, 'healthRevision'),
  configRevision: nullableInteger(row, 'configRevision'),
  modRevision: nullableInteger(row, 'modRevision'),
  updateCandidateId: nullableText(row, 'updateCandidateId'),
  updateCandidateRevision: nullableInteger(row, 'updateCandidateRevision'),
  updateCategory: nullableText(row, 'updateCategory'),
  updateTargetVersion: nullableText(row, 'updateTargetVersion'),
  dispatchState: text(row, 'dispatchState'),
  operationId: nullableText(row, 'operationId'),
})

const decodeNode = (
  value: unknown,
): Effect.Effect<PolicyNodeSnapshot, PolicyReconciliationError> => {
  const row = record(value)
  if (row === undefined)
    return Effect.fail(failure('policy-reconciliation.d1.node.decode', 'persistence-failed'))
  return Schema.decodeUnknownEffect(PolicyNodeSnapshot, { onExcessProperty: 'error' })(row).pipe(
    Effect.mapError(() => failure('policy-reconciliation.d1.node.decode', 'persistence-failed')),
  )
}

const decodeServer = (
  value: unknown,
): Effect.Effect<PolicyServerSnapshot, PolicyReconciliationError> => {
  const row = record(value)
  if (row === undefined)
    return Effect.fail(failure('policy-reconciliation.d1.server.decode', 'persistence-failed'))
  const candidateId = nullableText(row, 'updateCandidateId')
  const candidateRevision = nullableInteger(row, 'updateCandidateRevision')
  const candidateCategory = nullableText(row, 'updateCategory')
  const candidateTargetVersion = nullableText(row, 'updateTargetVersion')
  const hasCandidate =
    candidateId !== null &&
    candidateRevision !== null &&
    candidateCategory !== null &&
    candidateTargetVersion !== null
  if (
    (candidateId === null) !== (candidateRevision === null) ||
    (candidateId === null) !== (candidateCategory === null) ||
    (candidateId === null) !== (candidateTargetVersion === null)
  )
    return Effect.fail(failure('policy-reconciliation.d1.server.candidate', 'persistence-failed'))
  const output = {
    organizationId: text(row, 'organizationId'),
    serverId: text(row, 'serverId'),
    desiredRevision: integer(row, 'desiredRevision'),
    desiredState: text(row, 'desiredState'),
    observedState: text(row, 'observedState'),
    activeConfigRevision: integer(row, 'activeConfigRevision'),
    desiredModRevision: integer(row, 'desiredModRevision'),
    pendingLifecycleOperationId: nullableText(row, 'pendingLifecycleOperationId'),
    lastActivityAt: nullableText(row, 'lastActivityAt'),
    healthSampledAt: nullableText(row, 'healthSampledAt'),
    healthRevision: nullableInteger(row, 'healthRevision'),
    currentPlayerCount: nullableInteger(row, 'currentPlayerCount'),
    updateCandidate: hasCandidate
      ? {
          id: candidateId,
          revision: candidateRevision,
          category: candidateCategory,
          targetVersion: candidateTargetVersion,
        }
      : null,
  }
  return Schema.decodeUnknownEffect(PolicyServerSnapshot, { onExcessProperty: 'error' })(
    output,
  ).pipe(
    Effect.mapError(() => failure('policy-reconciliation.d1.server.decode', 'persistence-failed')),
  )
}

const actionInsert = `INSERT INTO policy_reconciliation_actions
 (organization_id, id, run_id, actor_id, policy_revision, resource_kind, resource_id,
 resource_revision, action, reason, idempotency_key, correlation_id, policy_operation_id,
  resource_expires_at, activity_last_at, health_sampled_at, health_revision, config_revision, mod_revision, update_candidate_id,
  update_candidate_revision, update_category, update_target_version, dispatch_state,
  operation_id, audit_event_id, outbox_event_id, created_at, updated_at, revision)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, 1)`

// Action IDs are deterministic `policy-action-<sha256>` identifiers, so all
// derived records stay below the 128-character public OperationId limit. Do
// not use colon-delimited internal names: OperationInventory decodes these
// same values through the public domain schema.
const policyOperationIdForAction = (actionId: string): string => `policy-operation-${actionId}`
const policyAcceptanceOperationIdForAction = (actionId: string): string =>
  `policy-acceptance-${actionId}`
const policyOperationIdempotencyKeyForAction = (idempotencyKey: string): string =>
  `policy-operation-${idempotencyKey}`
const policyAcceptanceOperationIdempotencyKeyForAction = (idempotencyKey: string): string =>
  `policy-acceptance-${idempotencyKey}`

const currentActionSql = `SELECT action.id, action.organization_id AS organizationId,
 action.run_id AS runId, action.actor_id AS actorId, action.policy_revision AS policyRevision,
 action.resource_kind AS resourceKind, action.resource_id AS resourceId,
 action.resource_revision AS resourceRevision, action.action AS kind, action.reason,
 action.idempotency_key AS idempotencyKey, action.correlation_id AS correlationId,
 action.resource_expires_at AS resourceExpiresAt, action.activity_last_at AS activityLastAt,
 action.health_sampled_at AS healthSampledAt, action.health_revision AS healthRevision,
 action.config_revision AS configRevision, action.mod_revision AS modRevision,
 action.update_candidate_id AS updateCandidateId,
 action.update_candidate_revision AS updateCandidateRevision, action.update_category AS updateCategory,
 action.update_target_version AS updateTargetVersion, action.dispatch_state AS dispatchState,
 action.operation_id AS operationId
 FROM policy_reconciliation_actions action
 JOIN policy_reconciliation_runs run
   ON run.organization_id = action.organization_id AND run.run_id = action.run_id
 JOIN policy_reconciliation_schedule_leases lease
   ON lease.organization_id = run.organization_id AND lease.schedule_slot = run.schedule_slot
 JOIN organizations organization ON organization.id = action.organization_id
 JOIN organization_policies policy ON policy.organization_id = organization.id
 JOIN policy_reconciliation_scheduler_identities scheduler
   ON scheduler.organization_id = action.organization_id AND scheduler.identity_id = action.actor_id
 JOIN identities actor ON actor.id = scheduler.identity_id
 JOIN organization_memberships membership
   ON membership.organization_id = action.organization_id AND membership.identity_id = actor.id
 WHERE action.organization_id = ? AND action.id = ? AND action.dispatch_state = 'pending'
   AND run.actor_id = action.actor_id AND run.policy_revision = action.policy_revision
   AND lease.actor_id = action.actor_id AND lease.policy_revision = action.policy_revision
   AND lease.run_id = run.run_id AND lease.idempotency_key = run.idempotency_key
   AND lease.lease_token = run.lease_token AND lease.state = 'running'
   AND julianday(lease.lease_until) > julianday(?)
   AND organization.status = 'active' AND organization.policy_revision = action.policy_revision
   AND policy.revision = action.policy_revision AND actor.status = 'active'
   AND membership.status = 'active' AND membership.role = 'automation'
   AND (
     (action.action = 'retire-node' AND EXISTS (
       SELECT 1 FROM nodes node WHERE node.organization_id = action.organization_id AND node.id = action.resource_id
         AND node.desired_revision = action.resource_revision
         AND node.desired_state NOT IN ('deleted', 'draining') AND node.observed_state <> 'deleted'
         AND node.temporary_expires_at = action.resource_expires_at
         AND julianday(node.temporary_expires_at) <= julianday(?)
         AND json_extract(policy.policy_json, '$.temporaryNodes.automaticExpiryRequired') = 1
     ))
     OR ((action.action = 'shutdown-server' OR action.action = 'delete-server') AND EXISTS (
       SELECT 1 FROM game_servers server
       JOIN policy_reconciliation_server_activity activity
         ON activity.organization_id = server.organization_id AND activity.server_id = server.id
       JOIN health_current_snapshots health
         ON health.organization_id = server.organization_id AND health.resource_type = 'server'
           AND health.resource_id = server.id
       WHERE server.organization_id = action.organization_id AND server.id = action.resource_id
         AND server.desired_revision = action.resource_revision
         AND server.desired_state = 'running' AND server.observed_state = 'running'
         AND server.pending_lifecycle_operation_id IS NULL
         AND activity.last_player_activity_at = action.activity_last_at
         AND health.sampled_at = action.health_sampled_at AND health.revision = action.health_revision
         AND health.status = 'healthy' AND json_extract(health.summary_json, '$.game.process') = 'running'
         AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
         AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) = 0
         AND julianday(health.sampled_at) >= julianday(?, '-5 minutes')
         AND json_extract(policy.policy_json, '$.idle.action') =
           CASE WHEN action.action = 'shutdown-server' THEN 'shutdown' ELSE 'delete' END
         AND julianday(activity.last_player_activity_at) <=
           julianday(?) - json_extract(policy.policy_json, '$.idle.afterMinutes') / 1440.0
         AND (action.action <> 'delete-server'
           OR json_extract(policy.policy_json, '$.backups.requiredBeforeDelete') = 0
           OR EXISTS (SELECT 1 FROM backups backup
             WHERE backup.organization_id = server.organization_id AND backup.server_id = server.id
               AND backup.state = 'available'
               AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
               AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER) = server.desired_revision))
     ))
     OR (action.action = 'update-server' AND EXISTS (
       SELECT 1 FROM game_servers server
       JOIN policy_reconciliation_update_candidates candidate
         ON candidate.organization_id = server.organization_id AND candidate.server_id = server.id
       WHERE server.organization_id = action.organization_id AND server.id = action.resource_id
         AND server.desired_revision = action.resource_revision
         AND server.desired_state = 'running' AND server.observed_state = 'running'
         AND server.pending_lifecycle_operation_id IS NULL
         AND server.active_config_revision = action.config_revision
         AND COALESCE((SELECT mods.desired_revision FROM mod_sets mods
           WHERE mods.organization_id = server.organization_id AND mods.server_id = server.id), 0) = action.mod_revision
         AND candidate.id = action.update_candidate_id AND candidate.revision = action.update_candidate_revision
         AND candidate.category = action.update_category AND candidate.target_version = action.update_target_version
         AND candidate.status = 'active'
         AND json_extract(policy.policy_json, '$.updates.automatic') IN ('all', action.update_category)
         AND json_extract(policy.policy_json, '$.monthlyBudget.currency') IS NOT NULL
         AND (json_extract(policy.policy_json, '$.updates.requireMaintenanceWindow') = 0 OR EXISTS (
           SELECT 1 FROM json_each(policy.policy_json, '$.maintenanceWindows') window
           WHERE ((CAST(strftime('%w', ?) AS INTEGER) * 1440 + CAST(strftime('%H', ?) AS INTEGER) * 60
             + CAST(strftime('%M', ?) AS INTEGER)
             - (json_extract(window.value, '$.dayOfWeekUtc') * 1440 + json_extract(window.value, '$.startMinuteUtc'))
             + 10080) % 10080) < json_extract(window.value, '$.durationMinutes')
         ))
     ))
   )`

export const makePolicyReconciliationRepositoryD1 = (
  database: PolicyReconciliationD1Database,
  overrides: PolicyReconciliationD1Options = {},
): PolicyReconciliationRepositoryShape => {
  const options = { now: overrides.now ?? defaults.now }
  const findReplay: PolicyReconciliationRepositoryShape['findReplay'] = (request) =>
    Effect.gen(function* () {
      const value = yield* attempt('policy-reconciliation.d1.replay.run', () =>
        database
          .prepare(runByIdempotencySql)
          .bind(request.organizationId, request.idempotencyKey)
          .first(),
      )
      if (value === null) return null
      const run = record(value)
      if (run === undefined)
        return yield* failure('policy-reconciliation.d1.replay.run', 'persistence-failed')
      const actionRows = yield* attempt('policy-reconciliation.d1.replay.actions', () =>
        database.prepare(actionsByRunSql).bind(request.organizationId, request.runId).all(),
      )
      return yield* decodeResult(
        request,
        run,
        actionRows.results.map((row) => actionValue(record(row) ?? {})),
        true,
      )
    })

  const loadSnapshot: PolicyReconciliationRepositoryShape['loadSnapshot'] = (request) =>
    Effect.gen(function* () {
      const scope = yield* attempt('policy-reconciliation.d1.snapshot.scope', () =>
        database
          .prepare(policyScopeSql)
          .bind(
            request.organizationId,
            request.actorId,
            request.policyRevision,
            request.policyRevision,
          )
          .first(),
      )
      const scopeRow = record(scope)
      if (
        scopeRow === undefined ||
        text(scopeRow, 'organizationId') !== request.organizationId ||
        text(scopeRow, 'actorId') !== request.actorId ||
        integer(scopeRow, 'organizationPolicyRevision') !== request.policyRevision ||
        integer(scopeRow, 'policyRevision') !== request.policyRevision
      )
        return yield* failure('policy-reconciliation.d1.snapshot.scope', 'stale-policy')
      const policy = yield* decodeOrganizationPolicy(parseJson(scopeRow.policyJson)).pipe(
        Effect.mapError(() => failure('policy-reconciliation.d1.snapshot.policy', 'stale-policy')),
      )
      const now = options.now()
      const [usageResult, serverCounts, nodeResult, serverResult] = yield* Effect.all([
        attempt('policy-reconciliation.d1.snapshot.usage', () =>
          database
            .prepare(usageSql)
            .bind(request.organizationId, request.organizationId, request.organizationId)
            .first(),
        ),
        attempt('policy-reconciliation.d1.snapshot.server-counts', () =>
          database.prepare(serverCountsSql).bind(request.organizationId).all(),
        ),
        attempt('policy-reconciliation.d1.snapshot.nodes', () =>
          database.prepare(nodesSql).bind(request.organizationId, now).all(),
        ),
        attempt('policy-reconciliation.d1.snapshot.servers', () =>
          database.prepare(serversSql).bind(request.organizationId, now, now, now).all(),
        ),
      ])
      if (nodeResult.results.length > 100 || serverResult.results.length > 100)
        return yield* failure('policy-reconciliation.d1.snapshot.bound', 'unbounded-snapshot')
      const usageRow = record(usageResult)
      const activeNodes = integer(usageRow, 'activeNodes')
      const dedicatedNodes = integer(usageRow, 'dedicatedNodes')
      const budgetCurrency = nullableText(usageRow, 'budgetCurrency')
      if (activeNodes === undefined || dedicatedNodes === undefined || budgetCurrency === undefined)
        return yield* failure('policy-reconciliation.d1.snapshot.usage', 'persistence-failed')
      const serversByNode: Record<string, number> = {}
      for (const raw of serverCounts.results) {
        const row = record(raw)
        const nodeId = text(row, 'nodeId')
        const count = integer(row, 'serverCount')
        if (nodeId === undefined || count === undefined || count < 0)
          return yield* failure(
            'policy-reconciliation.d1.snapshot.server-counts',
            'persistence-failed',
          )
        serversByNode[nodeId] = count
      }
      // Policy admission itself rejects a missing currency for automatic updates.
      // The sentinel merely lets unrelated expiry/idle decisions remain available.
      const usage: OrganizationUsage = {
        organizationId: request.organizationId,
        observedAtEpochMilliseconds: Date.parse(now),
        activeNodes,
        dedicatedNodes,
        serversByNode,
        estimatedCommittedMonthlyMinor: 0,
        currency: budgetCurrency ?? 'ZZZ',
      }
      const nodes = yield* Effect.forEach(nodeResult.results, decodeNode)
      const servers = yield* Effect.forEach(serverResult.results, decodeServer)
      return {
        organizationId: request.organizationId,
        actorId: request.actorId,
        policyRevision: request.policyRevision,
        observedAt: now,
        policy,
        usage,
        nodes,
        servers,
      } satisfies PolicyReconciliationSnapshot
    })

  const applyAtomic: PolicyReconciliationRepositoryShape['applyAtomic'] = (input) =>
    Effect.gen(function* () {
      const plan = yield* Schema.decodeUnknownEffect(PolicyReconciliationPlan, {
        onExcessProperty: 'error',
      })(input).pipe(
        Effect.mapError(() => failure('policy-reconciliation.d1.plan.decode', 'invalid-request')),
      )
      const request = {
        organizationId: plan.organizationId,
        actorId: plan.actorId,
        policyRevision: plan.policyRevision,
        scheduleSlot: plan.scheduleSlot,
        runId: plan.runId,
        idempotencyKey: plan.idempotencyKey,
        leaseToken: plan.leaseToken,
      }
      const replay = yield* findReplay(request)
      if (replay !== null) return replay
      const now = options.now()
      const actionStatements = (yield* Effect.forEach(plan.actions, (action) =>
        Effect.gen(function* () {
          const auditId = `policy-audit-${action.id}`
          const outboxId = `policy-outbox-${action.id}`
          // This is the durable policy action itself, not a synthetic audit
          // operation. The later lifecycle operation remains separately typed.
          const policyOperationId = policyOperationIdForAction(action.id)
          const policyOperationIdempotencyKey = policyOperationIdempotencyKeyForAction(
            action.idempotencyKey,
          )
          // Acceptance itself is a completed policy decision. Keep it distinct
          // from the pending operation that will later drive lifecycle
          // dispatch, so a successful audit does not claim that external work
          // has already completed.
          const policyAcceptanceOperationId = policyAcceptanceOperationIdForAction(action.id)
          const policyAcceptanceOperationIdempotencyKey =
            policyAcceptanceOperationIdempotencyKeyForAction(action.idempotencyKey)
          // The audit-envelope trigger requires the captured post-state to
          // equal the immutable audit summary exactly. Keep one source for
          // both values so the final D1 batch cannot stage an evidence row
          // that describes a different policy action.
          const auditSummary = {
            actionId: action.id,
            runId: action.runId,
            operationId: policyOperationId,
            action: action.kind,
            reason: action.reason,
            resourceRevision: action.resourceRevision,
          }
          const summary = JSON.stringify(auditSummary)
          const payload = JSON.stringify({
            actionId: action.id,
            runId: action.runId,
            operationId: policyOperationId,
            organizationId: action.organizationId,
            resourceKind: action.resourceKind,
            resourceId: action.resourceId,
            action: action.kind,
            reason: action.reason,
          })
          const stage = yield* stageAuditEnvelope(
            'tenant',
            auditId,
            {
              version: 1,
              captureStatus: 'complete',
              occurredAt: now,
              scope: 'tenant',
              organizationId: action.organizationId,
              // This is Gridora's dedicated scheduler identity, not a user-created
              // automation identity. It retains its identity FK for tenant scope,
              // while the envelope truthfully records a system actor kind.
              actor: { type: 'system', id: action.actorId },
              request: { id: action.idempotencyKey, correlationId: action.correlationId },
              action: `policy-reconciliation.${action.kind}.accepted`,
              target: { type: action.resourceKind, id: action.resourceId },
              before: {
                state: 'captured',
                summary: {
                  policyRevision: action.policyRevision,
                  resourceRevision: action.resourceRevision,
                  resourceExpiresAt: action.resourceExpiresAt,
                  activityLastAt: action.activityLastAt,
                  healthRevision: action.healthRevision,
                  configRevision: action.configRevision,
                  modRevision: action.modRevision,
                  updateCandidateRevision: action.updateCandidateRevision,
                },
              },
              after: {
                state: 'captured',
                summary: auditSummary,
              },
              operationId: policyAcceptanceOperationId,
              source: {
                origin: 'scheduler',
                ip: { state: 'not-available', reason: 'scheduler has no client IP' },
                access: { state: 'not-available', reason: 'scheduler has no Access request' },
              },
              result: 'succeeded',
              error: { classification: 'none', code: null },
              forced: false,
              breakGlass: false,
            },
            now,
          ).pipe(
            Effect.mapError(() =>
              failure('policy-reconciliation.d1.audit-envelope.stage', 'persistence-failed'),
            ),
          )
          return [
            database
              .prepare(`INSERT INTO operations
                  (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
                   idempotency_key, correlation_id, revision, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'requested', 0, ?, ?, 1, ?, ?)`)
              .bind(
                policyOperationId,
                action.organizationId,
                `policy-reconciliation.${action.kind}`,
                action.resourceKind,
                action.resourceId,
                action.actorId,
                policyOperationIdempotencyKey,
                action.correlationId,
                now,
                now,
              ),
            database
              .prepare(`INSERT INTO operations
                  (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
                   idempotency_key, correlation_id, revision, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
              .bind(
                policyAcceptanceOperationId,
                action.organizationId,
                `policy-reconciliation.${action.kind}.accepted`,
                action.resourceKind,
                action.resourceId,
                action.actorId,
                policyAcceptanceOperationIdempotencyKey,
                action.correlationId,
                now,
                now,
              ),
            database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
            database
              .prepare(`INSERT INTO audit_events
                  (id, organization_id, actor_id, action, target_type, target_id, result,
                   correlation_id, summary_json, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`)
              .bind(
                auditId,
                action.organizationId,
                action.actorId,
                `policy-reconciliation.${action.kind}.accepted`,
                action.resourceKind,
                action.resourceId,
                action.correlationId,
                summary,
                now,
              ),
            database
              .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  VALUES (?, ?, 'policy-reconciliation.action.accepted', ?, ?, ?, 'pending', 0, ?, ?)`)
              .bind(
                outboxId,
                action.organizationId,
                action.resourceKind,
                action.resourceId,
                payload,
                now,
                now,
              ),
            database
              .prepare(actionInsert)
              .bind(
                action.organizationId,
                action.id,
                action.runId,
                action.actorId,
                action.policyRevision,
                action.resourceKind,
                action.resourceId,
                action.resourceRevision,
                action.kind,
                action.reason,
                action.idempotencyKey,
                action.correlationId,
                policyOperationId,
                action.resourceExpiresAt,
                action.activityLastAt,
                action.healthSampledAt,
                action.healthRevision,
                action.configRevision,
                action.modRevision,
                action.updateCandidateId,
                action.updateCandidateRevision,
                action.updateCategory,
                action.updateTargetVersion,
                auditId,
                outboxId,
                now,
                now,
              ),
          ]
        }),
      )).flat()
      const committed = yield* Effect.result(
        attempt('policy-reconciliation.d1.apply.atomic', () =>
          database.batch([
            database
              .prepare(`INSERT INTO policy_reconciliation_runs
                (organization_id, run_id, actor_id, policy_revision, schedule_slot, idempotency_key,
                 lease_token, observed_at, snapshot_fingerprint, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(
                plan.organizationId,
                plan.runId,
                plan.actorId,
                plan.policyRevision,
                plan.scheduleSlot,
                plan.idempotencyKey,
                plan.leaseToken,
                plan.observedAt,
                plan.snapshotFingerprint,
                now,
              ),
            ...actionStatements,
          ]),
        ),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* findReplay(request)
        if (adopted !== null) return adopted
        return yield* committed.failure
      }
      const accepted = yield* findReplay(request)
      return accepted === null
        ? yield* failure('policy-reconciliation.d1.apply.readback', 'persistence-failed')
        : { ...accepted, replayed: false }
    })

  const assertDispatchAuthority: PolicyReconciliationRepositoryShape['assertDispatchAuthority'] = (
    action,
  ) =>
    Effect.gen(function* () {
      const now = options.now()
      const value = yield* attempt('policy-reconciliation.d1.dispatch.authority', () =>
        database
          .prepare(currentActionSql)
          .bind(action.organizationId, action.id, now, now, now, now, now, now, now)
          .first(),
      )
      if (value === null)
        return yield* failure('policy-reconciliation.d1.dispatch.authority', 'stale-resource')
      const decoded = yield* decodeRecord(actionValue(record(value) ?? {}))
      if (
        decoded.id !== action.id ||
        decoded.organizationId !== action.organizationId ||
        decoded.dispatchState !== 'pending' ||
        decoded.idempotencyKey !== action.idempotencyKey
      )
        return yield* failure('policy-reconciliation.d1.dispatch.binding', 'stale-resource')
    })

  const loadAction = (organizationId: string, actionId: string) =>
    attempt('policy-reconciliation.d1.action.read', () =>
      database
        .prepare(
          `${actionsByRunSql.replace('WHERE organization_id = ? AND run_id = ?', 'WHERE organization_id = ? AND id = ?')}`,
        )
        .bind(organizationId, actionId)
        .all(),
    ).pipe(
      Effect.flatMap((result) => {
        const row = result.results[0]
        return row === undefined
          ? Effect.fail(failure('policy-reconciliation.d1.action.read', 'persistence-failed'))
          : decodeRecord(actionValue(record(row) ?? {}))
      }),
    )

  const markDispatch: PolicyReconciliationRepositoryShape['markDispatch'] = (action, dispatch) =>
    Effect.gen(function* () {
      const decodedDispatch = yield* Schema.decodeUnknownEffect(PolicyActionDispatch, {
        onExcessProperty: 'error',
      })(dispatch).pipe(
        Effect.mapError(() => failure('policy-reconciliation.d1.dispatch.decode', 'invalid-scope')),
      )
      if (decodedDispatch.actionId !== action.id)
        return yield* failure('policy-reconciliation.d1.dispatch.binding', 'invalid-scope')
      const nextState: PolicyActionDispatchState =
        decodedDispatch.workflowState === 'pending-reconciliation'
          ? 'pending-reconciliation'
          : 'accepted'
      const now = options.now()
      const result = yield* Effect.result(
        attempt('policy-reconciliation.d1.dispatch.mark', () =>
          database.batch([
            database
              .prepare(`UPDATE operations
                SET status = 'queued', updated_at = ?, revision = revision + 1
                WHERE id = ? AND organization_id = ? AND status = 'requested'
                  AND type = ? AND resource_type = ? AND resource_id = ?
                  AND actor_id = ? AND idempotency_key = ? AND correlation_id = ?`)
              .bind(
                now,
                policyOperationIdForAction(action.id),
                action.organizationId,
                `policy-reconciliation.${action.kind}`,
                action.resourceKind,
                action.resourceId,
                action.actorId,
                policyOperationIdempotencyKeyForAction(action.idempotencyKey),
                action.correlationId,
              ),
            database
              .prepare(`UPDATE policy_reconciliation_actions
                SET dispatch_state = ?, operation_id = ?, updated_at = ?, revision = revision + 1
                WHERE organization_id = ? AND id = ? AND dispatch_state = 'pending'`)
              .bind(nextState, decodedDispatch.operationId, now, action.organizationId, action.id),
          ]),
        ),
      )
      const current = yield* loadAction(action.organizationId, action.id)
      if (
        current.operationId !== decodedDispatch.operationId ||
        current.dispatchState !== nextState ||
        (result._tag === 'Failure' && current.operationId !== decodedDispatch.operationId)
      )
        return yield* result._tag === 'Failure'
          ? result.failure
          : failure('policy-reconciliation.d1.dispatch.mark', 'persistence-failed')
      return current
    })

  const markRejected: PolicyReconciliationRepositoryShape['markRejected'] = (action, state) =>
    Effect.gen(function* () {
      const now = options.now()
      const result = yield* Effect.result(
        attempt('policy-reconciliation.d1.reject.mark', () =>
          database.batch([
            database
              .prepare(`UPDATE operations
                SET status = 'failed', progress = 100, updated_at = ?, revision = revision + 1
                WHERE id = ? AND organization_id = ? AND status = 'requested'
                  AND type = ? AND resource_type = ? AND resource_id = ?
                  AND actor_id = ? AND idempotency_key = ? AND correlation_id = ?`)
              .bind(
                now,
                policyOperationIdForAction(action.id),
                action.organizationId,
                `policy-reconciliation.${action.kind}`,
                action.resourceKind,
                action.resourceId,
                action.actorId,
                policyOperationIdempotencyKeyForAction(action.idempotencyKey),
                action.correlationId,
              ),
            database
              .prepare(`UPDATE policy_reconciliation_actions
                SET dispatch_state = ?, updated_at = ?, revision = revision + 1
                WHERE organization_id = ? AND id = ? AND dispatch_state = 'pending'`)
              .bind(state, now, action.organizationId, action.id),
          ]),
        ),
      )
      const current = yield* loadAction(action.organizationId, action.id)
      if (current.dispatchState !== state || current.operationId !== null)
        return yield* result._tag === 'Failure'
          ? result.failure
          : failure('policy-reconciliation.d1.reject.mark', 'persistence-failed')
      return current
    })

  return {
    findReplay,
    loadSnapshot,
    applyAtomic,
    assertDispatchAuthority,
    markDispatch,
    markRejected,
  }
}

export const PolicyReconciliationRepositoryD1Live = Layer.effect(
  PolicyReconciliationRepository,
  Effect.gen(function* () {
    return PolicyReconciliationRepository.of(
      makePolicyReconciliationRepositoryD1(yield* PolicyReconciliationD1Client),
    )
  }),
)

import { Effect, Schema } from 'effect'
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
  ServerApplyIntent,
  ServerProvisionAcceptedPlanSchema,
  ServerProvisionIdempotencyConflictError,
  ServerProvisionPersistenceError,
  publicServerProvisionPlan,
  type ServerApplyIntent as ServerApplyIntentType,
  type ServerProvisionAcceptedPlan,
  type ServerProvisionAcceptance,
  type ServerProvisionAtomicInput,
  type ServerProvisionRepositoryShape,
} from '@gridora/server-plan-control'
import type { ServerPlanD1Database, ServerPlanD1Result, ServerPlanD1Statement } from './index.js'

const persistence = (operation: string, cause?: unknown) =>
  new ServerProvisionPersistenceError({
    operation,
    message:
      cause instanceof Error && cause.message.length > 0
        ? cause.message.slice(0, 500)
        : cause === undefined
          ? operation
          : 'D1 persistence operation failed',
  })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => persistence(operation, cause) })
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const integer = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isSafeInteger(row[key]) ? row[key] : undefined
const changesExactlyOne = (result: ServerPlanD1Result): boolean => result.meta?.changes === 1

const parseJson = (operation: string, value: unknown) =>
  typeof value !== 'string'
    ? Effect.fail(persistence(operation, 'expected JSON text'))
    : Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: (cause) => persistence(operation, cause),
      })

const replaySql = `SELECT operation_id AS operationId, resource_id AS resourceId,
  request_fingerprint AS fingerprint, plan_json AS planJson
 FROM server_provision_plan_runs
 WHERE organization_id = ? AND idempotency_key = ?`

const decodeAcceptance = (
  organizationId: string,
  idempotencyKey: string,
  expectedFingerprint: string,
  value: unknown,
  disposition: 'created' | 'adopted',
): Effect.Effect<
  ServerProvisionAcceptance | null,
  ServerProvisionIdempotencyConflictError | ServerProvisionPersistenceError
> => {
  if (value === null || value === undefined) return Effect.succeed(null)
  const row = record(value)
  if (row === undefined)
    return Effect.fail(persistence('server-provision.replay.decode', 'invalid replay row'))
  if (text(row, 'fingerprint') !== expectedFingerprint)
    return Effect.fail(new ServerProvisionIdempotencyConflictError({ idempotencyKey }))
  const operationId = text(row, 'operationId')
  const resourceId = text(row, 'resourceId')
  if (operationId === undefined || resourceId === undefined)
    return Effect.fail(persistence('server-provision.replay.decode', 'invalid replay identifiers'))
  return Effect.flatMap(parseJson('server-provision.replay.plan', row.planJson), (plan) =>
    Schema.decodeUnknownEffect(ServerProvisionAcceptedPlanSchema, { onExcessProperty: 'error' })(
      plan,
    ).pipe(
      Effect.mapError(() => persistence('server-provision.replay.plan', 'invalid stored plan')),
      Effect.map((decoded): ServerProvisionAcceptance => ({
        disposition,
        organizationId,
        operationId,
        resourceId,
        idempotencyKey,
        fingerprint: expectedFingerprint,
        state: 'queued',
        plan: publicServerProvisionPlan(decoded),
      })),
    ),
  )
}

const acceptanceAuditOperation = (operationId: string) => `${operationId}-accepted`
const stageAcceptanceAudit = (
  database: ServerPlanD1Database,
  input: ServerProvisionAtomicInput,
): Effect.Effect<
  { readonly statement: ServerPlanD1Statement; readonly summaryJson: string },
  ServerProvisionPersistenceError
> =>
  Effect.gen(function* () {
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.command.context.organizationId,
      actor: { type: 'human', id: input.command.context.actorId },
      action: 'server.provision.accepted',
      target: { type: 'server-provision', id: input.identity.resourceId },
      before: { state: 'absent', reason: 'no server provisioning plan had been accepted' },
      after: {
        state: 'captured',
        summary: {
          operationId: input.identity.operationId,
          planKind: input.plan.kind,
          pluginId: input.command.intent.server.pluginId,
          placementMode:
            input.plan.kind === 'existing-node'
              ? input.plan.placementMode
              : input.plan.placementMode,
          nodeId: input.plan.kind === 'existing-node' ? input.plan.nodeId : null,
          newPaidInfrastructure: input.plan.newPaidInfrastructure,
          ...(input.plan.kind === 'provision-node'
            ? {
                pluginVersion: input.plan.pluginVersion,
                pluginSelectionRevision: input.plan.pluginSelectionRevision,
                providerType: input.plan.selectedInfrastructure.providerType,
                region: input.plan.selectedInfrastructure.region,
                plan: input.plan.selectedInfrastructure.plan,
                currency: input.plan.billing.currency,
                estimatedMonthlyIncreaseMinor: input.plan.billing.estimatedMonthlyIncreaseMinor,
                billingCadence: input.plan.billing.billingCadence,
                contractMonths: input.plan.billing.contractMonths,
              }
            : {}),
        },
      },
      operationId: acceptanceAuditOperation(input.identity.operationId),
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.provideService(AuditRequestContext, {
        ...input.command.auditRequestContext,
        correlationId: input.command.context.correlationId,
      }),
      Effect.mapError(() => persistence('server-provision.accept.audit-envelope')),
    )
    const staged = yield* stageAuditEnvelope(
      'tenant',
      input.identity.auditEventId,
      envelope,
      input.now,
    ).pipe(Effect.mapError(() => persistence('server-provision.accept.audit-stage')))
    return {
      statement: database
        .prepare(auditEnvelopeStageSql)
        .bind(...auditEnvelopeStageBindings(staged)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

export interface ServerProvisionRun {
  readonly organizationId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly operationId: string
  readonly resourceId: string
  readonly actorId: string
  readonly actorRole: 'owner' | 'administrator' | 'operator'
  readonly actorMembershipRevision?: number
  readonly correlationId: string
  readonly serverIntent: ServerApplyIntentType['server']
  readonly gameIntent: ServerApplyIntentType['game']
  /** Internal accepted plan; public repositories project it before returning an acceptance. */
  readonly plan: ServerProvisionAcceptedPlan
  readonly phase:
    | 'accepted'
    | 'waiting-node'
    | 'ready-for-server'
    | 'waiting-server'
    | 'succeeded'
    | 'failed'
    | 'compensating'
    | 'compensated'
  readonly nodeId?: string
  readonly nodeProvisionOperationId?: string
  readonly gameServerId?: string
  readonly gameOperationId?: string
  readonly compensationOperationId?: string
  readonly failureReason?: string
  readonly auditRequestContext: AuditRequestContextValue
}

export interface ServerProvisionNodeReadiness {
  readonly state: 'waiting' | 'ready' | 'failed'
  readonly nodeId: string
  readonly reason?: string
}
export interface ServerProvisionGameStatus {
  readonly state: 'waiting' | 'succeeded' | 'failed'
  readonly serverId: string
  readonly reason?: string
}
export interface ServerProvisionCompensableNode {
  readonly nodeId: string
  readonly expectedNodeRevision: number
}
export interface ServerProvisionCompensationStatus {
  readonly state: 'waiting' | 'succeeded' | 'failed'
  readonly nodeId: string
  readonly operationId: string
  readonly reason?: string
}

export interface ServerProvisionExecutionRepository {
  readonly load: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError>
  readonly recordExistingNode: (
    organizationId: string,
    operationId: string,
    nodeId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError>
  readonly recordNodeProvision: (
    organizationId: string,
    operationId: string,
    nodeId: string,
    nodeProvisionOperationId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError>
  readonly readNodeReadiness: (
    organizationId: string,
    operationId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionNodeReadiness, ServerProvisionPersistenceError>
  readonly markReadyForServer: (
    organizationId: string,
    operationId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError>
  readonly recordGameProvision: (
    organizationId: string,
    operationId: string,
    serverId: string,
    gameOperationId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError>
  readonly readGameStatus: (
    organizationId: string,
    operationId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionGameStatus, ServerProvisionPersistenceError>
  /** Returns only a node provisioned by this exact parent, with its current revision fence. */
  readonly readCompensableNode: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<ServerProvisionCompensableNode, ServerProvisionPersistenceError>
  /** Persists the exact accepted retirement child before its Workflow may be dispatched. */
  readonly recordCompensation: (
    organizationId: string,
    operationId: string,
    nodeId: string,
    compensationOperationId: string,
    now: string,
  ) => Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError>
  readonly readCompensationStatus: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<ServerProvisionCompensationStatus, ServerProvisionPersistenceError>
  /** Commits the failed parent terminal state and its complete v1 audit only after retirement proof. */
  readonly markCompensated: (
    organizationId: string,
    operationId: string,
    reason: string,
    now: string,
  ) => Effect.Effect<void, ServerProvisionPersistenceError>
  readonly markFailed: (
    organizationId: string,
    operationId: string,
    reason: string,
    now: string,
  ) => Effect.Effect<void, ServerProvisionPersistenceError>
}

const terminalAuditEventId = (
  action: 'server.provision.failed' | 'server.provision.compensated',
  operationId: string,
) => `audit-${action.replaceAll('.', '-')}:${operationId}`

const stageTerminalAudit = (
  database: ServerPlanD1Database,
  input: {
    readonly run: ServerProvisionRun
    readonly action: 'server.provision.failed' | 'server.provision.compensated'
    readonly reason: string
    readonly now: string
  },
): Effect.Effect<
  {
    readonly eventId: string
    readonly statement: ServerPlanD1Statement
    readonly summaryJson: string
  },
  ServerProvisionPersistenceError
> =>
  Effect.gen(function* () {
    const eventId = terminalAuditEventId(input.action, input.run.operationId)
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.run.organizationId,
      actor: { type: 'human', id: input.run.actorId },
      action: input.action,
      target: { type: 'server-provision', id: input.run.resourceId },
      before: {
        state: 'captured',
        summary: {
          phase: input.run.phase,
          nodeId: input.run.nodeId ?? null,
          nodeProvisionOperationId: input.run.nodeProvisionOperationId ?? null,
          gameOperationId: input.run.gameOperationId ?? null,
          compensationOperationId: input.run.compensationOperationId ?? null,
        },
      },
      after: {
        state: 'captured',
        summary: {
          phase: input.action === 'server.provision.compensated' ? 'compensated' : 'failed',
          reason: input.reason.slice(0, 500),
          nodeId: input.run.nodeId ?? null,
          nodeProvisionOperationId: input.run.nodeProvisionOperationId ?? null,
          gameOperationId: input.run.gameOperationId ?? null,
          compensationOperationId: input.run.compensationOperationId ?? null,
        },
      },
      operationId: input.run.operationId,
      result: 'failed',
      error: {
        classification: 'unknown',
        code:
          input.action === 'server.provision.compensated'
            ? 'server-provision-compensated'
            : 'server-provision-failed',
      },
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.provideService(AuditRequestContext, {
        ...input.run.auditRequestContext,
        correlationId: input.run.correlationId,
      }),
      Effect.mapError(() => persistence('server-provision.terminal.audit-envelope')),
    )
    const staged = yield* stageAuditEnvelope('tenant', eventId, envelope, input.now).pipe(
      Effect.mapError(() => persistence('server-provision.terminal.audit-stage')),
    )
    return {
      eventId,
      statement: database
        .prepare(auditEnvelopeStageSql)
        .bind(...auditEnvelopeStageBindings(staged)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const loadSql = `SELECT run.organization_id AS organizationId, run.idempotency_key AS idempotencyKey,
  run.request_fingerprint AS fingerprint, run.operation_id AS operationId, run.resource_id AS resourceId,
  run.actor_id AS actorId, run.actor_role AS actorRole,
  run.actor_membership_revision AS actorMembershipRevision, run.correlation_id AS correlationId,
  run.server_intent_json AS serverIntentJson, run.game_intent_json AS gameIntentJson,
  run.plan_json AS planJson, run.phase, run.node_id AS nodeId,
  run.node_provision_operation_id AS nodeProvisionOperationId, run.game_server_id AS gameServerId,
  run.game_operation_id AS gameOperationId, run.compensation_operation_id AS compensationOperationId,
  run.failure_reason AS failureReason, run.audit_request_context_json AS auditRequestContextJson
 FROM server_provision_plan_runs run
 WHERE run.organization_id = ? AND run.operation_id = ?`

const decodeRun = (
  value: unknown,
): Effect.Effect<ServerProvisionRun, ServerProvisionPersistenceError> =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* persistence('server-provision.run.decode', 'run not found')
    const organizationId = text(row, 'organizationId')
    const idempotencyKey = text(row, 'idempotencyKey')
    const fingerprint = text(row, 'fingerprint')
    const operationId = text(row, 'operationId')
    const resourceId = text(row, 'resourceId')
    const actorId = text(row, 'actorId')
    const actorRole = text(row, 'actorRole')
    const actorMembershipRevision =
      row.actorMembershipRevision === null || row.actorMembershipRevision === undefined
        ? undefined
        : integer(row, 'actorMembershipRevision')
    const correlationId = text(row, 'correlationId')
    const phase = text(row, 'phase')
    if (
      organizationId === undefined ||
      idempotencyKey === undefined ||
      fingerprint === undefined ||
      operationId === undefined ||
      resourceId === undefined ||
      actorId === undefined ||
      (actorRole !== 'owner' && actorRole !== 'administrator' && actorRole !== 'operator') ||
      correlationId === undefined ||
      ![
        'accepted',
        'waiting-node',
        'ready-for-server',
        'waiting-server',
        'succeeded',
        'failed',
        'compensating',
        'compensated',
      ].includes(phase ?? '')
    )
      return yield* persistence('server-provision.run.decode', 'invalid run coordinates')
    const serverIntent = yield* parseJson(
      'server-provision.run.server-intent',
      row.serverIntentJson,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(ServerApplyIntent.fields.server, { onExcessProperty: 'error' }),
      ),
      Effect.mapError(() =>
        persistence('server-provision.run.server-intent', 'invalid server intent'),
      ),
    )
    const gameIntent = yield* parseJson(
      'server-provision.run.game-intent',
      row.gameIntentJson,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(ServerApplyIntent.fields.game, { onExcessProperty: 'error' }),
      ),
      Effect.mapError(() => persistence('server-provision.run.game-intent', 'invalid game intent')),
    )
    const plan = yield* parseJson('server-provision.run.plan', row.planJson).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(ServerProvisionAcceptedPlanSchema, {
          onExcessProperty: 'error',
        }),
      ),
      Effect.mapError(() => persistence('server-provision.run.plan', 'invalid plan')),
    )
    const auditRequestContext = yield* parseJson(
      'server-provision.run.audit',
      row.auditRequestContextJson,
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(AuditRequestContextValue, { onExcessProperty: 'error' }),
      ),
      Effect.mapError(() => persistence('server-provision.run.audit', 'invalid audit context')),
    )
    const optionalText = (key: string) => {
      const value = row[key]
      return value === null || value === undefined ? undefined : text(row, key)
    }
    const nodeId = optionalText('nodeId')
    const nodeProvisionOperationId = optionalText('nodeProvisionOperationId')
    const gameServerId = optionalText('gameServerId')
    const gameOperationId = optionalText('gameOperationId')
    const compensationOperationId = optionalText('compensationOperationId')
    const failureReason = optionalText('failureReason')
    if (
      (row.nodeId !== null && row.nodeId !== undefined && nodeId === undefined) ||
      (row.nodeProvisionOperationId !== null &&
        row.nodeProvisionOperationId !== undefined &&
        nodeProvisionOperationId === undefined) ||
      (row.gameServerId !== null && row.gameServerId !== undefined && gameServerId === undefined) ||
      (row.gameOperationId !== null &&
        row.gameOperationId !== undefined &&
        gameOperationId === undefined) ||
      (row.compensationOperationId !== null &&
        row.compensationOperationId !== undefined &&
        compensationOperationId === undefined) ||
      (row.failureReason !== null &&
        row.failureReason !== undefined &&
        failureReason === undefined) ||
      (actorMembershipRevision !== undefined && actorMembershipRevision < 1)
    )
      return yield* persistence('server-provision.run.decode', 'invalid child coordinates')
    return {
      organizationId,
      idempotencyKey,
      fingerprint,
      operationId,
      resourceId,
      actorId,
      actorRole,
      correlationId,
      serverIntent,
      gameIntent,
      plan,
      phase: phase as ServerProvisionRun['phase'],
      ...(actorMembershipRevision === undefined ? {} : { actorMembershipRevision }),
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(nodeProvisionOperationId === undefined ? {} : { nodeProvisionOperationId }),
      ...(gameServerId === undefined ? {} : { gameServerId }),
      ...(gameOperationId === undefined ? {} : { gameOperationId }),
      ...(compensationOperationId === undefined ? {} : { compensationOperationId }),
      ...(failureReason === undefined ? {} : { failureReason }),
      auditRequestContext,
    }
  })

const updateAndLoad = (
  database: ServerPlanD1Database,
  operation: string,
  statement: ServerPlanD1Statement,
  organizationId: string,
  operationId: string,
) =>
  Effect.gen(function* () {
    const result = yield* attempt(operation, () => database.batch([statement]))
    if (result.length !== 1 || !changesExactlyOne(result[0]!))
      return yield* persistence(`${operation}.changes`)
    return yield* attempt(`${operation}.load`, () =>
      database.prepare(loadSql).bind(organizationId, operationId).first(),
    ).pipe(Effect.flatMap(decodeRun))
  })

export const makeServerProvisionRepositoryD1 = (
  database: ServerPlanD1Database,
): ServerProvisionRepositoryShape & ServerProvisionExecutionRepository => {
  const findReplay: ServerProvisionRepositoryShape['findReplay'] = (
    organizationId,
    idempotencyKey,
    fingerprint,
  ) =>
    attempt('server-provision.replay.read', () =>
      database.prepare(replaySql).bind(organizationId, idempotencyKey).first(),
    ).pipe(
      Effect.flatMap((row) =>
        decodeAcceptance(organizationId, idempotencyKey, fingerprint, row, 'adopted'),
      ),
    )
  const acceptAtomic: ServerProvisionRepositoryShape['acceptAtomic'] = (input) =>
    Effect.gen(function* () {
      const audit = yield* stageAcceptanceAudit(database, input)
      const org = input.command.context.organizationId
      const operation = input.identity.operationId
      const statements = [
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'server-provision-plan', 'server-provision', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`)
          .bind(
            operation,
            org,
            input.identity.resourceId,
            input.command.context.actorId,
            input.command.idempotencyKey,
            input.command.context.correlationId,
            input.now,
            input.now,
          ),
        // The acceptance itself is a completed, auditable fact. The parent
        // coordination operation remains queued until its child workflows
        // prove readiness and game deployment.
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'server.provision.accepted', 'server-provision', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
          .bind(
            acceptanceAuditOperation(operation),
            org,
            input.identity.resourceId,
            input.command.context.actorId,
            `server-provision-accepted:${operation}`,
            input.command.context.correlationId,
            input.now,
            input.now,
          ),
        database
          .prepare(`INSERT INTO lifecycle_workflow_starts
          (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`)
          .bind(org, operation, input.identity.workflowStartRecordId, input.now, input.now),
        audit.statement,
        database
          .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, 'server.provision.accepted', 'server-provision', ?, 'succeeded', ?, ?, ?)`)
          .bind(
            input.identity.auditEventId,
            org,
            input.command.context.actorId,
            input.identity.resourceId,
            input.command.context.correlationId,
            audit.summaryJson,
            input.now,
          ),
        database
          .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'lifecycle.workflow-start.requested', 'operation', ?, ?, 'pending', 0, ?, ?)`)
          .bind(
            input.identity.outboxEventId,
            org,
            operation,
            JSON.stringify({
              operationId: operation,
              workflowStartRecordId: input.identity.workflowStartRecordId,
              resourceKind: 'server-provision',
              resourceId: input.identity.resourceId,
              action: 'server-provision-plan',
            }),
            input.now,
            input.now,
          ),
        database
          .prepare(`INSERT INTO server_provision_plan_runs
          (organization_id, idempotency_key, request_fingerprint, operation_id, resource_id,
           actor_id, actor_role, actor_membership_revision, correlation_id,
           server_intent_json, game_intent_json, plan_json,
           phase, node_id, node_provision_operation_id, game_server_id, game_operation_id,
           compensation_operation_id, terminal_audit_event_id,
           audit_event_id, workflow_start_record_id, outbox_event_id, audit_request_context_json,
           created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
          .bind(
            org,
            input.command.idempotencyKey,
            input.fingerprint,
            operation,
            input.identity.resourceId,
            input.command.context.actorId,
            input.command.context.actorRole,
            input.command.context.actorMembershipRevision ?? null,
            input.command.context.correlationId,
            JSON.stringify(input.command.intent.server),
            JSON.stringify(input.command.intent.game),
            JSON.stringify(input.plan),
            input.identity.auditEventId,
            input.identity.workflowStartRecordId,
            input.identity.outboxEventId,
            JSON.stringify(input.command.auditRequestContext),
            input.now,
            input.now,
          ),
      ]
      const committed = yield* Effect.result(
        attempt('server-provision.accept.atomic', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        const replay = yield* findReplay(org, input.command.idempotencyKey, input.fingerprint)
        if (replay !== null) return replay
        return yield* committed.failure
      }
      if (
        committed.success.length !== statements.length ||
        committed.success.some((result) => !changesExactlyOne(result))
      )
        return yield* persistence('server-provision.accept.atomic-changes')
      return {
        disposition: 'created',
        organizationId: org,
        operationId: operation,
        resourceId: input.identity.resourceId,
        idempotencyKey: input.command.idempotencyKey,
        fingerprint: input.fingerprint,
        state: 'queued',
        plan: publicServerProvisionPlan(input.plan),
      }
    })
  const markWorkflowStarted: ServerProvisionRepositoryShape['markWorkflowStarted'] = (
    organizationId,
    operationId,
  ) =>
    attempt('server-provision.workflow.mark-started', () =>
      database.batch([
        database
          .prepare(`UPDATE lifecycle_workflow_starts SET state = 'started', attempts = attempts + 1,
        last_error = NULL, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`)
          .bind(new Date().toISOString(), organizationId, operationId),
      ]),
    ).pipe(Effect.asVoid)
  const recordWorkflowStartFailure: ServerProvisionRepositoryShape['recordWorkflowStartFailure'] = (
    organizationId,
    operationId,
    message,
  ) =>
    attempt('server-provision.workflow.record-failure', () =>
      database.batch([
        database
          .prepare(`UPDATE lifecycle_workflow_starts SET attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE organization_id = ? AND operation_id = ?`)
          .bind(message.slice(0, 500), new Date().toISOString(), organizationId, operationId),
      ]),
    ).pipe(Effect.asVoid)

  const load: ServerProvisionExecutionRepository['load'] = (organizationId, operationId) =>
    attempt('server-provision.run.load', () =>
      database.prepare(loadSql).bind(organizationId, operationId).first(),
    ).pipe(Effect.flatMap(decodeRun))
  const recordExistingNode: ServerProvisionExecutionRepository['recordExistingNode'] = (
    organizationId,
    operationId,
    nodeId,
    now,
  ) =>
    updateAndLoad(
      database,
      'server-provision.record-existing-node',
      database
        .prepare(`UPDATE server_provision_plan_runs
      SET node_id = ?, phase = CASE WHEN phase = 'accepted' THEN 'ready-for-server' ELSE phase END, updated_at = ?
      WHERE organization_id = ? AND operation_id = ?
        AND (node_id IS NULL OR node_id = ?)
        AND (phase = 'accepted' OR phase = 'ready-for-server' OR phase = 'waiting-server')`)
        .bind(nodeId, now, organizationId, operationId, nodeId),
      organizationId,
      operationId,
    )
  const recordNodeProvision: ServerProvisionExecutionRepository['recordNodeProvision'] = (
    organizationId,
    operationId,
    nodeId,
    nodeProvisionOperationId,
    now,
  ) =>
    updateAndLoad(
      database,
      'server-provision.record-node',
      database
        .prepare(`UPDATE server_provision_plan_runs
      SET node_id = ?, node_provision_operation_id = ?, phase = 'waiting-node', updated_at = ?
      WHERE organization_id = ? AND operation_id = ?
        AND (node_id IS NULL OR node_id = ?)
        AND (node_provision_operation_id IS NULL OR node_provision_operation_id = ?)
        AND phase IN ('accepted', 'waiting-node')`)
        .bind(
          nodeId,
          nodeProvisionOperationId,
          now,
          organizationId,
          operationId,
          nodeId,
          nodeProvisionOperationId,
        ),
      organizationId,
      operationId,
    )
  const readinessSql = `SELECT run.node_id AS nodeId, run.node_provision_operation_id AS nodeProvisionOperationId,
      child.status AS childStatus, node.desired_state AS desiredState, node.observed_state AS observedState,
      capacity.agent_ready AS agentReady, capacity.tunnel_ready AS tunnelReady, capacity.docker_ready AS dockerReady,
      capacity.firewall_ready AS firewallReady, capacity.reported_at AS reportedAt
    FROM server_provision_plan_runs run
    LEFT JOIN node_provision_acceptances acceptance
      ON acceptance.organization_id = run.organization_id AND acceptance.operation_id = run.node_provision_operation_id
    LEFT JOIN operations child
      ON child.organization_id = run.organization_id AND child.id = acceptance.operation_id
    LEFT JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
    LEFT JOIN node_runtime_capacity capacity ON capacity.organization_id = run.organization_id AND capacity.node_id = run.node_id
    WHERE run.organization_id = ? AND run.operation_id = ?`
  const readNodeReadiness: ServerProvisionExecutionRepository['readNodeReadiness'] = (
    organizationId,
    operationId,
    now,
  ) =>
    Effect.gen(function* () {
      const row = record(
        yield* attempt('server-provision.node-readiness', () =>
          database.prepare(readinessSql).bind(organizationId, operationId).first(),
        ),
      )
      const nodeId = row === undefined ? undefined : text(row, 'nodeId')
      if (nodeId === undefined)
        return yield* persistence('server-provision.node-readiness', 'node has not been accepted')
      const childStatus = text(row!, 'childStatus')
      if (
        childStatus === 'failed' ||
        childStatus === 'failed_terminal' ||
        childStatus === 'cancelled'
      )
        return {
          state: 'failed',
          nodeId,
          reason: 'node provisioning operation reached a terminal failure',
        }
      const reportedAt = row === undefined ? undefined : text(row, 'reportedAt')
      const freshness =
        reportedAt === undefined ? Number.NaN : Date.parse(now) - Date.parse(reportedAt)
      const ready =
        row?.desiredState === 'ready' &&
        row?.observedState === 'ready' &&
        row?.agentReady === 1 &&
        row?.tunnelReady === 1 &&
        row?.dockerReady === 1 &&
        row?.firewallReady === 1 &&
        Number.isFinite(freshness) &&
        freshness >= -60_000 &&
        freshness <= 300_000
      return ready
        ? { state: 'ready', nodeId }
        : {
            state: 'waiting',
            nodeId,
            reason: 'waiting for authoritative node, agent, tunnel, and capacity evidence',
          }
    })
  const markReadyForServer: ServerProvisionExecutionRepository['markReadyForServer'] = (
    organizationId,
    operationId,
    now,
  ) =>
    updateAndLoad(
      database,
      'server-provision.mark-ready',
      database
        .prepare(`UPDATE server_provision_plan_runs
      SET phase = 'ready-for-server', updated_at = ?
      WHERE organization_id = ? AND operation_id = ? AND phase IN ('accepted', 'waiting-node', 'ready-for-server')`)
        .bind(now, organizationId, operationId),
      organizationId,
      operationId,
    )
  const recordGameProvision: ServerProvisionExecutionRepository['recordGameProvision'] = (
    organizationId,
    operationId,
    serverId,
    gameOperationId,
    now,
  ) =>
    updateAndLoad(
      database,
      'server-provision.record-game',
      database
        .prepare(`UPDATE server_provision_plan_runs
      SET game_server_id = ?, game_operation_id = ?, phase = 'waiting-server', updated_at = ?
      WHERE organization_id = ? AND operation_id = ?
        AND (game_server_id IS NULL OR game_server_id = ?)
        AND (game_operation_id IS NULL OR game_operation_id = ?)
        AND phase IN ('ready-for-server', 'waiting-server')`)
        .bind(
          serverId,
          gameOperationId,
          now,
          organizationId,
          operationId,
          serverId,
          gameOperationId,
        ),
      organizationId,
      operationId,
    )
  const gameSql = `SELECT run.game_server_id AS serverId, child.status AS childStatus
    FROM server_provision_plan_runs run
    LEFT JOIN operations child ON child.organization_id = run.organization_id AND child.id = run.game_operation_id
    WHERE run.organization_id = ? AND run.operation_id = ?`
  const readGameStatus: ServerProvisionExecutionRepository['readGameStatus'] = (
    organizationId,
    operationId,
    now,
  ) =>
    Effect.gen(function* () {
      const row = record(
        yield* attempt('server-provision.game-status', () =>
          database.prepare(gameSql).bind(organizationId, operationId).first(),
        ),
      )
      const serverId = row === undefined ? undefined : text(row, 'serverId')
      const status = row === undefined ? undefined : text(row, 'childStatus')
      if (serverId === undefined || status === undefined)
        return yield* persistence(
          'server-provision.game-status',
          'game deployment operation is unavailable',
        )
      if (status === 'succeeded') {
        const results = yield* attempt('server-provision.succeed', () =>
          database.batch([
            database
              .prepare(`UPDATE server_provision_plan_runs SET phase = 'succeeded', updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND phase = 'waiting-server'`)
              .bind(now, organizationId, operationId),
            database
              .prepare(`UPDATE operations SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')`)
              .bind(now, organizationId, operationId),
          ]),
        )
        if (results.length !== 2 || results.some((result) => !changesExactlyOne(result)))
          return yield* persistence('server-provision.succeed.changes')
        return { state: 'succeeded', serverId }
      }
      if (status === 'failed' || status === 'failed_terminal' || status === 'cancelled')
        return {
          state: 'failed',
          serverId,
          reason: 'game deployment operation reached a terminal failure',
        }
      return { state: 'waiting', serverId, reason: 'waiting for game deployment observation' }
    })
  const compensableNodeSql = `SELECT run.node_id AS nodeId, node.desired_revision AS expectedNodeRevision
    FROM server_provision_plan_runs run
    JOIN node_provision_acceptances acceptance
      ON acceptance.organization_id = run.organization_id
     AND acceptance.operation_id = run.node_provision_operation_id
     AND acceptance.node_id = run.node_id
    JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
    WHERE run.organization_id = ? AND run.operation_id = ?
      AND run.node_provision_operation_id IS NOT NULL`
  const readCompensableNode: ServerProvisionExecutionRepository['readCompensableNode'] = (
    organizationId,
    operationId,
  ) =>
    Effect.gen(function* () {
      const row = record(
        yield* attempt('server-provision.compensation-node.read', () =>
          database.prepare(compensableNodeSql).bind(organizationId, operationId).first(),
        ),
      )
      const nodeId = row === undefined ? undefined : text(row, 'nodeId')
      const expectedNodeRevision =
        row === undefined ? undefined : integer(row, 'expectedNodeRevision')
      if (nodeId === undefined || expectedNodeRevision === undefined || expectedNodeRevision < 1)
        return yield* persistence(
          'server-provision.compensation-node.read',
          'only a node created by this server plan can be compensated',
        )
      return { nodeId, expectedNodeRevision }
    })
  const recordCompensation: ServerProvisionExecutionRepository['recordCompensation'] = (
    organizationId,
    operationId,
    nodeId,
    compensationOperationId,
    now,
  ) =>
    updateAndLoad(
      database,
      'server-provision.compensation.record',
      database
        .prepare(`UPDATE server_provision_plan_runs
        SET compensation_operation_id = ?, phase = 'compensating', updated_at = ?
        WHERE organization_id = ? AND operation_id = ?
          AND node_id = ? AND node_provision_operation_id IS NOT NULL
          AND (compensation_operation_id IS NULL OR compensation_operation_id = ?)
          AND phase IN ('waiting-node', 'ready-for-server', 'waiting-server', 'compensating')`)
        .bind(
          compensationOperationId,
          now,
          organizationId,
          operationId,
          nodeId,
          compensationOperationId,
        ),
      organizationId,
      operationId,
    )
  const compensationStatusSql = `SELECT run.node_id AS nodeId,
      run.compensation_operation_id AS compensationOperationId,
      operation.status AS operationStatus,
      lifecycle.state AS lifecycleState,
      node_run.state AS nodeRunState,
      node_run.provider_retirement_state AS providerRetirementState,
      node_run.billing_state AS billingState,
      cancellation.phase AS cancellationPhase,
      node.desired_state AS desiredState,
      node.observed_state AS observedState,
      node.pending_lifecycle_operation_id AS pendingOperationId,
      EXISTS (
        SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
        WHERE receipt.organization_id = run.organization_id
          AND receipt.operation_id = run.compensation_operation_id
          AND receipt.receipt_key = 'node-retirement-finalized'
      ) AS finalizedReceipt,
      EXISTS (
        SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
        WHERE receipt.organization_id = run.organization_id
          AND receipt.operation_id = run.compensation_operation_id
          AND receipt.receipt_key = 'node-credentials-revoked'
      ) AS credentialReceipt
    FROM server_provision_plan_runs run
    LEFT JOIN operations operation
      ON operation.organization_id = run.organization_id
     AND operation.id = run.compensation_operation_id
    LEFT JOIN destructive_lifecycle_operations lifecycle
      ON lifecycle.organization_id = run.organization_id
     AND lifecycle.operation_id = run.compensation_operation_id
    LEFT JOIN node_lifecycle_runs node_run
      ON node_run.organization_id = run.organization_id
     AND node_run.operation_id = run.compensation_operation_id
    LEFT JOIN operation_cancellation_facts cancellation
      ON cancellation.organization_id = run.organization_id
     AND cancellation.operation_id = run.compensation_operation_id
    LEFT JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
    WHERE run.organization_id = ? AND run.operation_id = ?`
  const readCompensationStatus: ServerProvisionExecutionRepository['readCompensationStatus'] = (
    organizationId,
    operationId,
  ) =>
    Effect.gen(function* () {
      const row = record(
        yield* attempt('server-provision.compensation-status.read', () =>
          database.prepare(compensationStatusSql).bind(organizationId, operationId).first(),
        ),
      )
      const nodeId = row === undefined ? undefined : text(row, 'nodeId')
      const childOperationId = row === undefined ? undefined : text(row, 'compensationOperationId')
      if (nodeId === undefined || childOperationId === undefined)
        return yield* persistence(
          'server-provision.compensation-status.read',
          'compensation child operation has not been recorded',
        )
      const operationStatus = text(row!, 'operationStatus')
      if (
        operationStatus === 'failed' ||
        operationStatus === 'failed_terminal' ||
        operationStatus === 'cancelled'
      )
        return {
          state: 'failed',
          nodeId,
          operationId: childOperationId,
          reason: 'node retirement compensation reached a terminal failure',
        }
      const ready =
        operationStatus === 'succeeded' &&
        row?.lifecycleState === 'succeeded' &&
        row?.nodeRunState === 'completed' &&
        (row?.providerRetirementState === 'deleted-confirmed' ||
          row?.providerRetirementState === 'contract-ended') &&
        row?.billingState === 'stopped' &&
        row?.cancellationPhase === 'terminal' &&
        row?.desiredState === 'deleted' &&
        row?.observedState === 'deleted' &&
        row?.pendingOperationId === null &&
        row?.finalizedReceipt === 1 &&
        row?.credentialReceipt === 1
      return ready
        ? { state: 'succeeded', nodeId, operationId: childOperationId }
        : {
            state: 'waiting',
            nodeId,
            operationId: childOperationId,
            reason:
              'waiting for exact node retirement, credential, provider, and observation evidence',
          }
    })
  const markCompensated: ServerProvisionExecutionRepository['markCompensated'] = (
    organizationId,
    operationId,
    reason,
    now,
  ) =>
    Effect.gen(function* () {
      const run = yield* load(organizationId, operationId)
      if (run.phase === 'compensated') return
      if (run.compensationOperationId === undefined)
        return yield* persistence(
          'server-provision.compensation.complete',
          'compensation child is unavailable',
        )
      const status = yield* readCompensationStatus(organizationId, operationId)
      if (status.state !== 'succeeded')
        return yield* persistence(
          'server-provision.compensation.complete',
          'compensation terminal evidence is unavailable',
        )
      const audit = yield* stageTerminalAudit(database, {
        run,
        action: 'server.provision.compensated',
        reason,
        now,
      })
      const outcome = yield* Effect.result(
        attempt('server-provision.compensation.complete', () =>
          database.batch([
            database
              .prepare(`UPDATE operations SET status = 'failed_terminal', progress = 100,
              revision = revision + 1, updated_at = ?
              WHERE organization_id = ? AND id = ?
                AND status IN ('queued', 'running', 'waiting_external', 'retrying')`)
              .bind(now, organizationId, operationId),
            audit.statement,
            database
              .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              VALUES (?, ?, ?, 'server.provision.compensated', 'server-provision', ?, 'failed', ?, ?, ?)`)
              .bind(
                audit.eventId,
                run.organizationId,
                run.actorId,
                run.resourceId,
                run.correlationId,
                audit.summaryJson,
                now,
              ),
            database
              .prepare(`UPDATE server_provision_plan_runs
              SET phase = 'compensated', failure_reason = ?, terminal_audit_event_id = ?, updated_at = ?
              WHERE organization_id = ? AND operation_id = ? AND phase = 'compensating'
                AND compensation_operation_id = ? AND terminal_audit_event_id IS NULL`)
              .bind(
                reason.slice(0, 500),
                audit.eventId,
                now,
                organizationId,
                operationId,
                run.compensationOperationId,
              ),
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* load(organizationId, operationId)
        if (adopted.phase === 'compensated') return
        return yield* outcome.failure
      }
      if (
        outcome.success.length !== 4 ||
        outcome.success.some((result) => !changesExactlyOne(result))
      )
        return yield* persistence('server-provision.compensation.complete.changes')
    })
  const markFailed: ServerProvisionExecutionRepository['markFailed'] = (
    organizationId,
    operationId,
    reason,
    now,
  ) =>
    Effect.gen(function* () {
      const run = yield* load(organizationId, operationId)
      if (run.phase === 'failed' || run.phase === 'compensated') return
      if (run.phase === 'compensating')
        return yield* persistence(
          'server-provision.mark-failed',
          'a created node must finish compensation',
        )
      const audit = yield* stageTerminalAudit(database, {
        run,
        action: 'server.provision.failed',
        reason,
        now,
      })
      const outcome = yield* Effect.result(
        attempt('server-provision.mark-failed', () =>
          database.batch([
            database
              .prepare(`UPDATE operations SET status = 'failed_terminal', progress = 100,
              revision = revision + 1, updated_at = ?
              WHERE organization_id = ? AND id = ?
                AND status IN ('queued', 'running', 'waiting_external', 'retrying')`)
              .bind(now, organizationId, operationId),
            audit.statement,
            database
              .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              VALUES (?, ?, ?, 'server.provision.failed', 'server-provision', ?, 'failed', ?, ?, ?)`)
              .bind(
                audit.eventId,
                run.organizationId,
                run.actorId,
                run.resourceId,
                run.correlationId,
                audit.summaryJson,
                now,
              ),
            database
              .prepare(`UPDATE server_provision_plan_runs
              SET phase = 'failed', failure_reason = ?, terminal_audit_event_id = ?, updated_at = ?
              WHERE organization_id = ? AND operation_id = ?
                AND phase NOT IN ('succeeded', 'compensated', 'compensating')
                AND terminal_audit_event_id IS NULL`)
              .bind(reason.slice(0, 500), audit.eventId, now, organizationId, operationId),
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* load(organizationId, operationId)
        if (adopted.phase === 'failed') return
        return yield* outcome.failure
      }
      if (
        outcome.success.length !== 4 ||
        outcome.success.some((result) => !changesExactlyOne(result))
      )
        return yield* persistence('server-provision.mark-failed.changes')
    })
  return {
    findReplay,
    acceptAtomic,
    markWorkflowStarted,
    recordWorkflowStartFailure,
    load,
    recordExistingNode,
    recordNodeProvision,
    readNodeReadiness,
    markReadyForServer,
    recordGameProvision,
    readGameStatus,
    readCompensableNode,
    recordCompensation,
    readCompensationStatus,
    markCompensated,
    markFailed,
  }
}

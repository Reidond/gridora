import { Context, Effect, Layer } from 'effect'
import {
  type AtomicReservation,
  canonicalCommandFingerprint,
  IdempotencyConflictError,
  type LifecycleCommand,
  LifecycleOperationInProgressError,
  LifecycleRepository,
  type LifecycleRepositoryShape,
  OrganizationScopeError,
  PersistenceError,
  ResourceNotFoundError,
  type ResourceSnapshot,
  RevisionConflictError,
  WorkflowStartReconciliationMismatchError,
  WorkflowStartReconciliationNotFoundError,
  WorkflowStartReconciliationRepository,
  type WorkflowStartReconciliationRepositoryShape,
} from '@gridora/lifecycle-control'

export interface LifecycleD1Result {
  readonly results: ReadonlyArray<unknown>
}
export interface LifecycleD1Statement {
  bind(...values: ReadonlyArray<unknown>): LifecycleD1Statement
  first(): Promise<unknown>
  all(): Promise<LifecycleD1Result>
}
export interface LifecycleD1Database {
  prepare(sql: string): LifecycleD1Statement
  /** Cloudflare D1 executes a batch as one transaction and rolls the batch back on statement failure. */
  batch(statements: ReadonlyArray<LifecycleD1Statement>): Promise<ReadonlyArray<unknown>>
}

export class LifecycleD1Client extends Context.Service<LifecycleD1Client, LifecycleD1Database>()(
  '@gridora/lifecycle-d1/LifecycleD1Client',
) {}
export const LifecycleD1ClientLayer = (database: LifecycleD1Database) =>
  Layer.succeed(LifecycleD1Client, database)

export interface LifecycleD1Options {
  readonly now: () => string
  readonly operationId: () => string
  readonly auditEventId: () => string
  readonly outboxEventId: () => string
}

const defaultOptions: LifecycleD1Options = {
  now: () => new Date().toISOString(),
  operationId: () => crypto.randomUUID(),
  auditEventId: () => crypto.randomUUID(),
  outboxEventId: () => crypto.randomUUID(),
}

const persistence = (operation: string, cause: unknown) =>
  new PersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => persistence(operation, cause) })
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const string = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const number = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' ? row[key] : undefined

const nodeDesired = ['provisioning', 'ready', 'draining', 'stopped', 'deleted'] as const
const nodeObserved = [
  'unknown',
  'provisioning',
  'bootstrapping',
  'ready',
  'degraded',
  'offline',
  'deleting',
  'deleted',
  'failed',
] as const
const serverDesired = ['running', 'stopped', 'deleted'] as const
const serverObserved = [
  'unknown',
  'planning',
  'installing',
  'starting',
  'running',
  'stopping',
  'stopped',
  'updating',
  'backing_up',
  'restoring',
  'moving',
  'repairing',
  'deleting',
  'deleted',
  'failed',
] as const

const included = <A extends string>(values: readonly A[], value: unknown): value is A =>
  typeof value === 'string' && values.includes(value as A)

const decodeSnapshot = (rowValue: unknown): Effect.Effect<ResourceSnapshot, PersistenceError> => {
  const row = record(rowValue)
  const kind = row === undefined ? undefined : string(row, 'kind')
  const id = row === undefined ? undefined : string(row, 'id')
  const organizationId = row === undefined ? undefined : string(row, 'organizationId')
  const desiredRevision = row === undefined ? undefined : number(row, 'desiredRevision')
  if (
    row === undefined ||
    id === undefined ||
    organizationId === undefined ||
    desiredRevision === undefined ||
    !Number.isInteger(desiredRevision) ||
    desiredRevision < 1
  )
    return Effect.fail(persistence('lifecycle.snapshot.decode', 'invalid resource row'))
  if (
    kind === 'node' &&
    included(nodeDesired, row.desiredState) &&
    included(nodeObserved, row.observedState)
  )
    return Effect.succeed({
      kind,
      id,
      organizationId,
      desiredState: row.desiredState,
      observedState: row.observedState,
      desiredRevision,
    })
  if (
    kind === 'server' &&
    included(serverDesired, row.desiredState) &&
    included(serverObserved, row.observedState) &&
    (row.lastVerifiedBackupRevision === null ||
      (typeof row.lastVerifiedBackupRevision === 'number' &&
        Number.isInteger(row.lastVerifiedBackupRevision)))
  )
    return Effect.succeed({
      kind,
      id,
      organizationId,
      desiredState: row.desiredState,
      observedState: row.observedState,
      desiredRevision,
      lastVerifiedBackupRevision: row.lastVerifiedBackupRevision,
    })
  return Effect.fail(persistence('lifecycle.snapshot.decode', 'invalid resource state'))
}

const resourceSelect = `SELECT 'node' AS kind, id, organization_id AS organizationId,
 desired_state AS desiredState, observed_state AS observedState,
 desired_revision AS desiredRevision, NULL AS lastVerifiedBackupRevision
 FROM nodes WHERE organization_id = ? AND id = ?
 UNION ALL
 SELECT 'server' AS kind, server.id, server.organization_id AS organizationId,
 server.desired_state AS desiredState, server.observed_state AS observedState,
 server.desired_revision AS desiredRevision,
 (SELECT MAX(CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER))
  FROM backups backup WHERE backup.organization_id = server.organization_id
   AND backup.server_id = server.id AND backup.state = 'available'
   AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer') AS lastVerifiedBackupRevision
 FROM game_servers server WHERE server.organization_id = ? AND server.id = ?`

const reservationJoinSelect = `SELECT reservation.fingerprint, reservation.command_json AS commandJson,
 reservation.reservation_json AS reservationJson,
 operation.id AS operationId, operation.organization_id AS organizationId,
 operation.actor_id AS actorId, operation.resource_id AS resourceId,
 operation.type AS action, operation.status, operation.idempotency_key AS idempotencyKey,
 operation.correlation_id AS correlationId,
 start.start_record_id AS startRecordId, start.state AS startState,
 start.attempts, start.last_error AS lastError
 FROM lifecycle_reservations reservation
 JOIN operations operation ON operation.organization_id = reservation.organization_id
  AND operation.id = reservation.operation_id
 JOIN lifecycle_workflow_starts start ON start.organization_id = operation.organization_id
  AND start.operation_id = operation.id`
const reservationSelect = `${reservationJoinSelect}
 WHERE reservation.organization_id = ? AND reservation.idempotency_key = ?`
const workflowStartReconciliationSelect = `${reservationJoinSelect}
 WHERE reservation.organization_id = ? AND reservation.operation_id = ?`

const parseJson = (operation: string, value: unknown): Effect.Effect<unknown, PersistenceError> =>
  typeof value !== 'string'
    ? Effect.fail(persistence(operation, 'expected JSON text'))
    : Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: (cause) => persistence(operation, cause),
      })

const commandKinds = [
  'provision-node',
  'retire-node',
  'delete-node',
  'deploy-server',
  'set-server-state',
  'configure-server',
  'update-server-mods',
  'create-backup',
  'restore-backup',
  'move-server',
  'delete-server',
] as const

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
const validPlacement = (value: unknown): boolean => {
  const placement = record(value)
  return (
    placement !== undefined &&
    (placement.mode === 'shared' || placement.mode === 'dedicated') &&
    (placement.nodeId === undefined || typeof placement.nodeId === 'string') &&
    (placement.provider === undefined || typeof placement.provider === 'string') &&
    (placement.region === undefined || typeof placement.region === 'string')
  )
}

const decodeCommand = (
  value: unknown,
  fingerprint: string,
): Effect.Effect<LifecycleCommand, PersistenceError> => {
  const row = record(value)
  if (
    row === undefined ||
    !included(commandKinds, row.kind) ||
    typeof row.organizationId !== 'string' ||
    typeof row.actorId !== 'string' ||
    typeof row.resourceId !== 'string' ||
    typeof row.idempotencyKey !== 'string' ||
    typeof row.correlationId !== 'string' ||
    typeof row.expectedDesiredRevision !== 'number' ||
    !Number.isInteger(row.expectedDesiredRevision) ||
    row.expectedDesiredRevision < 1
  )
    return Effect.fail(persistence('lifecycle.reservation.decode', 'invalid stored command'))
  const actionFieldsValid = (() => {
    switch (row.kind) {
      case 'provision-node':
      case 'retire-node':
      case 'delete-node':
        return true
      case 'deploy-server':
      case 'move-server':
        return validPlacement(row.placement)
      case 'set-server-state':
        return row.state === 'running' || row.state === 'stopped'
      case 'configure-server':
        return positiveInteger(row.configRevision)
      case 'update-server-mods':
        return positiveInteger(row.modSetRevision)
      case 'create-backup':
      case 'restore-backup':
        return typeof row.backupId === 'string' && row.backupId.length > 0
      case 'delete-server':
        return row.backupPolicy === 'required' || row.backupPolicy === 'skip-authorized'
    }
  })()
  if (!actionFieldsValid)
    return Effect.fail(persistence('lifecycle.reservation.decode', 'invalid command action fields'))
  const candidate = row as unknown as LifecycleCommand
  if (canonicalCommandFingerprint(candidate) !== fingerprint)
    return Effect.fail(
      persistence('lifecycle.reservation.decode', 'stored command fingerprint mismatch'),
    )
  return Effect.succeed(candidate)
}

const decodeDesiredReservation = (
  value: unknown,
  command: LifecycleCommand,
): Effect.Effect<AtomicReservation['reservation'], PersistenceError> => {
  const row = record(value)
  const expectedResourceKind = command.kind.endsWith('-node') ? 'node' : 'server'
  const desiredStateValid =
    row !== undefined &&
    (row.resourceKind === 'node'
      ? included(nodeDesired, row.desiredState)
      : row.resourceKind === 'server' && included(serverDesired, row.desiredState))
  const expectedPlacement =
    command.kind === 'deploy-server' || command.kind === 'move-server'
      ? JSON.stringify(row?.placement) === JSON.stringify(command.placement)
      : row?.placement === undefined
  if (
    row === undefined ||
    row.organizationId !== command.organizationId ||
    row.resourceId !== command.resourceId ||
    row.action !== command.kind ||
    (row.resourceKind !== 'node' && row.resourceKind !== 'server') ||
    row.resourceKind !== expectedResourceKind ||
    typeof row.previousRevision !== 'number' ||
    typeof row.desiredRevision !== 'number' ||
    !Number.isInteger(row.previousRevision) ||
    !Number.isInteger(row.desiredRevision) ||
    row.previousRevision !== command.expectedDesiredRevision ||
    row.desiredRevision !== row.previousRevision + 1 ||
    !desiredStateValid ||
    !expectedPlacement
  )
    return Effect.fail(persistence('lifecycle.reservation.decode', 'invalid stored reservation'))
  if (
    row.placement !== undefined &&
    (record(row.placement) === undefined ||
      (record(row.placement)?.mode !== 'shared' && record(row.placement)?.mode !== 'dedicated'))
  )
    return Effect.fail(persistence('lifecycle.reservation.decode', 'invalid stored placement'))
  return Effect.succeed(row as unknown as AtomicReservation['reservation'])
}

const decodeReservation = (
  rowValue: unknown,
  disposition: AtomicReservation['disposition'],
): Effect.Effect<AtomicReservation, PersistenceError> =>
  Effect.gen(function* () {
    const row = record(rowValue)
    if (row === undefined) return yield* persistence('lifecycle.reservation.decode', 'invalid row')
    const reservationValue = yield* parseJson('lifecycle.reservation.decode', row.reservationJson)
    const operationId = string(row, 'operationId')
    const organizationId = string(row, 'organizationId')
    const actorId = string(row, 'actorId')
    const resourceId = string(row, 'resourceId')
    const action = string(row, 'action') as LifecycleCommand['kind'] | undefined
    const idempotencyKey = string(row, 'idempotencyKey')
    const fingerprint = string(row, 'fingerprint')
    const correlationId = string(row, 'correlationId')
    const startRecordId = string(row, 'startRecordId')
    const startState = string(row, 'startState')
    const attempts = number(row, 'attempts')
    if (
      operationId === undefined ||
      organizationId === undefined ||
      actorId === undefined ||
      resourceId === undefined ||
      action === undefined ||
      idempotencyKey === undefined ||
      fingerprint === undefined ||
      correlationId === undefined ||
      startRecordId === undefined ||
      (startState !== 'pending' && startState !== 'started') ||
      attempts === undefined
    )
      return yield* persistence('lifecycle.reservation.decode', 'invalid joined row')
    const commandValue = yield* parseJson('lifecycle.reservation.decode', row.commandJson)
    const command = yield* decodeCommand(commandValue, fingerprint)
    const reservation = yield* decodeDesiredReservation(reservationValue, command)
    if (
      command.organizationId !== organizationId ||
      command.actorId !== actorId ||
      command.resourceId !== resourceId ||
      command.kind !== action ||
      command.idempotencyKey !== idempotencyKey ||
      command.correlationId !== correlationId
    )
      return yield* persistence('lifecycle.reservation.decode', 'stored operation binding mismatch')
    return {
      disposition,
      operation: {
        id: operationId,
        organizationId,
        actorId,
        resourceId,
        action,
        state: 'queued',
        idempotencyKey,
        fingerprint,
        correlationId,
      },
      reservation,
      workflowStart: {
        id: startRecordId,
        operationId,
        organizationId,
        state: startState,
        attempts,
        lastError: typeof row.lastError === 'string' ? row.lastError : null,
      },
    }
  })

export const makeLifecycleD1Repository = (
  database: LifecycleD1Database,
  options: Partial<LifecycleD1Options> = defaultOptions,
): LifecycleRepositoryShape => {
  const configured: LifecycleD1Options = { ...defaultOptions, ...options }
  const loadReservation = (
    organizationId: string,
    idempotencyKey: string,
    disposition: AtomicReservation['disposition'],
  ): Effect.Effect<AtomicReservation | null, PersistenceError> =>
    Effect.gen(function* () {
      const row = yield* attempt('lifecycle.reservation.get', () =>
        database.prepare(reservationSelect).bind(organizationId, idempotencyKey).first(),
      )
      return row === null ? null : yield* decodeReservation(row, disposition)
    })

  const get: LifecycleRepositoryShape['get'] = (organizationId, resourceId) =>
    Effect.gen(function* () {
      const rows = yield* attempt('lifecycle.resource.get', () =>
        database
          .prepare(resourceSelect)
          .bind(organizationId, resourceId, organizationId, resourceId)
          .all(),
      )
      if (rows.results.length === 0) return yield* new ResourceNotFoundError({ resourceId })
      if (rows.results.length !== 1)
        return yield* persistence('lifecycle.resource.get', 'ambiguous resource identifier')
      return yield* decodeSnapshot(rows.results[0])
    })

  const findIdempotent: LifecycleRepositoryShape['findIdempotent'] = (
    organizationId,
    idempotencyKey,
    fingerprint,
  ) =>
    Effect.gen(function* () {
      const existing = yield* loadReservation(organizationId, idempotencyKey, 'adopted')
      if (existing === null) return null
      if (existing.operation.fingerprint !== fingerprint)
        return yield* new IdempotencyConflictError({ idempotencyKey })
      return existing
    })

  const reserveAtomic: LifecycleRepositoryShape['reserveAtomic'] = (input) =>
    Effect.gen(function* () {
      const existing = yield* findIdempotent(
        input.command.organizationId,
        input.command.idempotencyKey,
        input.fingerprint,
      )
      if (existing !== null) return existing

      if (canonicalCommandFingerprint(input.command) !== input.fingerprint)
        return yield* persistence('lifecycle.reserve.invariant', 'command fingerprint mismatch')
      yield* decodeDesiredReservation(input.reservation, input.command).pipe(
        Effect.mapError((error) => persistence('lifecycle.reserve.invariant', error.message)),
      )

      const operationId = configured.operationId()
      const startRecordId = `workflow-start:${operationId}`
      const auditEventId = configured.auditEventId()
      const outboxEventId = configured.outboxEventId()
      const timestamp = configured.now()
      const table = input.reservation.resourceKind === 'node' ? 'nodes' : 'game_servers'
      const update = database
        .prepare(`UPDATE ${table}
         SET desired_state = ?, desired_revision = ?, pending_lifecycle_operation_id = ?, updated_at = ?
         WHERE organization_id = ? AND id = ? AND desired_revision = ?
          AND NOT EXISTS (SELECT 1 FROM operations active
           WHERE active.organization_id = ? AND active.resource_type = ?
            AND active.resource_id = ?
            AND active.status IN ('requested', 'queued', 'running', 'waiting_external',
             'cancelling', 'retrying'))`)
        .bind(
          input.reservation.desiredState,
          input.reservation.desiredRevision,
          operationId,
          timestamp,
          input.command.organizationId,
          input.command.resourceId,
          input.command.expectedDesiredRevision,
          input.command.organizationId,
          input.reservation.resourceKind,
          input.command.resourceId,
        )
      const insertOperation = database
        .prepare(`INSERT INTO operations
         (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
          idempotency_key, correlation_id, revision, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, 1, ?, ?
         FROM ${table} WHERE organization_id = ? AND id = ?
          AND pending_lifecycle_operation_id = ? AND desired_revision = ?`)
        .bind(
          operationId,
          input.command.organizationId,
          input.command.kind,
          input.reservation.resourceKind,
          input.command.resourceId,
          input.command.actorId,
          input.command.idempotencyKey,
          input.command.correlationId,
          timestamp,
          timestamp,
          input.command.organizationId,
          input.command.resourceId,
          operationId,
          input.reservation.desiredRevision,
        )
      const insertStart = database
        .prepare(`INSERT INTO lifecycle_workflow_starts
         (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
         SELECT organization_id, id, ?, 'pending', 0, NULL, ?, ? FROM operations
         WHERE organization_id = ? AND id = ?`)
        .bind(startRecordId, timestamp, timestamp, input.command.organizationId, operationId)
      /* The NOT NULL + FK operation_id makes a zero-row CAS abort the entire D1 batch here. */
      const insertReservation = database
        .prepare(`INSERT INTO lifecycle_reservations
         (organization_id, idempotency_key, fingerprint, operation_id, resource_kind,
          resource_id, command_json, reservation_json, created_at)
         VALUES (?, ?, ?, (SELECT id FROM operations WHERE organization_id = ? AND id = ?),
          ?, ?, ?, ?, ?)`)
        .bind(
          input.command.organizationId,
          input.command.idempotencyKey,
          input.fingerprint,
          input.command.organizationId,
          operationId,
          input.reservation.resourceKind,
          input.command.resourceId,
          JSON.stringify(input.command),
          JSON.stringify(input.reservation),
          timestamp,
        )
      const insertAudit = database
        .prepare(`INSERT INTO audit_events
         (id, organization_id, actor_id, action, target_type, target_id, result,
          correlation_id, summary_json, created_at)
         SELECT ?, organization_id, actor_id, ?, resource_type, resource_id, 'succeeded',
          correlation_id, ?, ? FROM operations WHERE organization_id = ? AND id = ?`)
        .bind(
          auditEventId,
          `lifecycle.${input.command.kind}.accepted`,
          JSON.stringify({
            operationId,
            previousRevision: input.reservation.previousRevision,
            desiredRevision: input.reservation.desiredRevision,
            workflowStartRecordId: startRecordId,
          }),
          timestamp,
          input.command.organizationId,
          operationId,
        )
      const insertOutbox = database
        .prepare(`INSERT INTO outbox
         (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
          publish_state, retry_count, available_at, created_at)
         SELECT ?, organization_id, 'lifecycle.workflow-start.requested', 'operation', id, ?,
          'pending', 0, ?, ? FROM operations WHERE organization_id = ? AND id = ?`)
        .bind(
          outboxEventId,
          JSON.stringify({
            operationId,
            workflowStartRecordId: startRecordId,
            resourceKind: input.reservation.resourceKind,
            resourceId: input.command.resourceId,
            action: input.command.kind,
          }),
          timestamp,
          timestamp,
          input.command.organizationId,
          operationId,
        )
      const committed = yield* Effect.result(
        attempt('lifecycle.reserve.atomic', () =>
          database.batch([
            update,
            insertOperation,
            insertStart,
            insertAudit,
            insertOutbox,
            insertReservation,
          ]),
        ),
      )
      if (committed._tag === 'Failure') {
        const replay = yield* findIdempotent(
          input.command.organizationId,
          input.command.idempotencyKey,
          input.fingerprint,
        )
        if (replay !== null) return replay
        const current = yield* get(input.command.organizationId, input.command.resourceId).pipe(
          Effect.mapError((error) =>
            error._tag === 'ResourceNotFoundError'
              ? new OrganizationScopeError({
                  organizationId: input.command.organizationId,
                  resourceId: input.command.resourceId,
                })
              : error,
          ),
        )
        if (current.desiredRevision !== input.command.expectedDesiredRevision)
          return yield* new RevisionConflictError({
            resourceId: input.command.resourceId,
            expected: input.command.expectedDesiredRevision,
            actual: current.desiredRevision,
          })
        const occupied = yield* attempt('lifecycle.idempotency.inspect', () =>
          database
            .prepare('SELECT id FROM operations WHERE organization_id = ? AND idempotency_key = ?')
            .bind(input.command.organizationId, input.command.idempotencyKey)
            .first(),
        )
        if (occupied !== null)
          return yield* new IdempotencyConflictError({
            idempotencyKey: input.command.idempotencyKey,
          })
        const active = yield* attempt('lifecycle.nonterminal.inspect', () =>
          database
            .prepare(`SELECT id FROM operations WHERE organization_id = ?
             AND resource_type = ? AND resource_id = ?
             AND status IN ('requested', 'queued', 'running', 'waiting_external',
              'cancelling', 'retrying') LIMIT 1`)
            .bind(
              input.command.organizationId,
              input.reservation.resourceKind,
              input.command.resourceId,
            )
            .first(),
        )
        if (active !== null)
          return yield* new LifecycleOperationInProgressError({
            resourceId: input.command.resourceId,
          })
        return yield* committed.failure
      }
      const created = yield* loadReservation(
        input.command.organizationId,
        input.command.idempotencyKey,
        'created',
      )
      if (created === null)
        return yield* persistence('lifecycle.reserve.atomic', 'committed reservation is missing')
      return created
    })

  return {
    get,
    findIdempotent,
    reserveAtomic,
    markWorkflowStarted: (organizationId, operationId) =>
      Effect.gen(function* () {
        const timestamp = configured.now()
        const updated = yield* attempt('lifecycle.workflow-start.mark-started', () =>
          database
            .prepare(`UPDATE lifecycle_workflow_starts SET state = 'started',
             attempts = attempts + 1, last_error = NULL, updated_at = ?
             WHERE organization_id = ? AND operation_id = ?
             RETURNING operation_id AS operationId`)
            .bind(timestamp, organizationId, operationId)
            .first(),
        )
        if (updated === null)
          return yield* persistence(
            'lifecycle.workflow-start.mark-started',
            'workflow start record not found in organization',
          )
      }),
    recordWorkflowStartFailure: (organizationId, operationId, message) =>
      Effect.gen(function* () {
        const timestamp = configured.now()
        const updated = yield* attempt('lifecycle.workflow-start.record-failure', () =>
          database
            .prepare(`UPDATE lifecycle_workflow_starts SET state = 'pending',
             attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE organization_id = ? AND operation_id = ?
             RETURNING operation_id AS operationId`)
            .bind(message, timestamp, organizationId, operationId)
            .first(),
        )
        if (updated === null)
          return yield* persistence(
            'lifecycle.workflow-start.record-failure',
            'workflow start record not found in organization',
          )
      }),
  }
}

export const LifecycleD1RepositoryLive = (options: Partial<LifecycleD1Options> = defaultOptions) =>
  Layer.effect(
    LifecycleRepository,
    Effect.gen(function* () {
      const database = yield* LifecycleD1Client
      return LifecycleRepository.of(makeLifecycleD1Repository(database, options))
    }),
  )

export const makeWorkflowStartReconciliationD1Repository = (
  database: LifecycleD1Database,
): WorkflowStartReconciliationRepositoryShape => ({
  load: (request) =>
    Effect.gen(function* () {
      const row = yield* attempt('lifecycle.workflow-start.reconciliation.get', () =>
        database
          .prepare(workflowStartReconciliationSelect)
          .bind(request.organizationId, request.operationId)
          .first(),
      )
      if (row === null) return yield* new WorkflowStartReconciliationNotFoundError({})
      const reservation = yield* decodeReservation(row, 'adopted').pipe(
        Effect.mapError(
          () => new WorkflowStartReconciliationMismatchError({ code: 'binding_mismatch' }),
        ),
      )
      if (
        reservation.operation.organizationId !== request.organizationId ||
        reservation.operation.id !== request.operationId ||
        reservation.workflowStart.organizationId !== request.organizationId ||
        reservation.workflowStart.operationId !== request.operationId ||
        reservation.workflowStart.id !== request.workflowStartRecordId
      )
        return yield* new WorkflowStartReconciliationMismatchError({
          code: 'binding_mismatch',
        })
      return reservation
    }),
})

export const WorkflowStartReconciliationD1Live = Layer.effect(
  WorkflowStartReconciliationRepository,
  Effect.gen(function* () {
    const database = yield* LifecycleD1Client
    return WorkflowStartReconciliationRepository.of(
      makeWorkflowStartReconciliationD1Repository(database),
    )
  }),
)

export type { OrganizationScopeError }

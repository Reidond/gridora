import { Context, Effect, Layer, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  GameServerDesiredSpec,
  GameServerDraft,
  GameServerManifest,
  GameServerManifestIdempotencyConflictError,
  GameServerManifestNotFoundError,
  GameServerManifestPersistenceError,
  GameServerManifestRevisionConflictError,
  canonicalGameServerManifest,
  type GameServerDraftCreateCommand,
  type GameServerDraftRepository,
  type GameServerDraftSchedule,
  type GameServerManifestPolicyUpdateAcceptance,
  type GameServerManifestPolicyUpdateCommand,
  type GameServerManifestRepository,
  type GameServerManifestRepositoryError,
  type GameServerManifestStoredState,
} from '@gridora/game-server-manifest-control'

export interface GameServerManifestD1Statement {
  bind(...values: readonly unknown[]): GameServerManifestD1Statement
  first<T = unknown>(): Promise<T | null>
}

export interface GameServerManifestD1Database {
  prepare(sql: string): GameServerManifestD1Statement
  batch(statements: readonly GameServerManifestD1Statement[]): Promise<readonly unknown[]>
}

export class GameServerManifestD1Client extends Context.Service<
  GameServerManifestD1Client,
  GameServerManifestD1Database
>()('@gridora/game-server-manifest-d1/GameServerManifestD1Client') {}

export const GameServerManifestD1ClientLayer = (database: GameServerManifestD1Database) =>
  Layer.succeed(GameServerManifestD1Client, database)

export class GameServerManifestD1Repository extends Context.Service<
  GameServerManifestD1Repository,
  GameServerManifestRepository
>()('@gridora/game-server-manifest-d1/GameServerManifestD1Repository') {}

export interface GameServerManifestD1Options {
  readonly now: () => string
  readonly operationId: () => string
  readonly auditEventId: () => string
  readonly draftId: () => string
  readonly scheduleId: () => string
}

const defaults: GameServerManifestD1Options = {
  now: () => new Date().toISOString(),
  operationId: () => crypto.randomUUID(),
  auditEventId: () => crypto.randomUUID(),
  draftId: () => crypto.randomUUID(),
  scheduleId: () => crypto.randomUUID(),
}

const persistence = (operation: string, detail?: string) =>
  new GameServerManifestPersistenceError({
    operation,
    message:
      detail === undefined
        ? 'Authoritative declarative game-server state is unavailable'
        : detail.slice(0, 500),
  })

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      persistence(
        operation,
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : 'D1 persistence operation failed',
      ),
  })

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const text = (row: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const integer = (row: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isSafeInteger(row[key]) ? row[key] : undefined

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    )
  return value
}

const fingerprintForPolicyUpdate = (command: GameServerManifestPolicyUpdateCommand) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify(
          canonical({
            action: 'game-server-manifest-policy-update',
            organizationId: command.organizationId,
            actorId: command.actorId,
            serverId: command.serverId,
            expectedRevision: command.expectedRevision,
            updatePolicy: command.updatePolicy,
            backupPolicy: command.backupPolicy,
          }),
        ),
      )
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => persistence('game-server-manifest.policy.fingerprint'),
  })

const storedStateSql = `SELECT
  server.organization_id AS organizationId,
  server.id AS serverId,
  server.name AS name,
  server.desired_state AS desiredState,
  server.desired_revision AS desiredRevision,
  server.active_config_revision AS configRevision,
  mods.desired_revision AS modRevision,
  spec.source_operation_id AS sourceOperationId,
  spec.spec_json AS specJson
FROM game_servers server
LEFT JOIN game_server_desired_specs spec
  ON spec.organization_id = server.organization_id
 AND spec.server_id = server.id
LEFT JOIN mod_sets mods
  ON mods.organization_id = server.organization_id
 AND mods.server_id = server.id
WHERE server.organization_id = ? AND %CONDITION%
LIMIT 1`

const decodeStoredState = (
  value: unknown,
  operation: string,
): Effect.Effect<GameServerManifestStoredState | null, GameServerManifestPersistenceError> =>
  Effect.gen(function* () {
    if (value === null || value === undefined) return null
    const row = record(value)
    if (row === undefined)
      return yield* persistence(operation, 'invalid authoritative manifest projection row')
    const organizationId = text(row, 'organizationId')
    const serverId = text(row, 'serverId')
    const name = text(row, 'name')
    const desiredState = text(row, 'desiredState')
    const desiredRevision = integer(row, 'desiredRevision')
    const configRevision = integer(row, 'configRevision')
    const modRevision = integer(row, 'modRevision')
    const sourceOperationId = text(row, 'sourceOperationId')
    const specJson = text(row, 'specJson')
    if (
      organizationId === undefined ||
      serverId === undefined ||
      name === undefined ||
      desiredRevision === undefined ||
      desiredRevision < 1 ||
      configRevision === undefined ||
      configRevision < 1 ||
      modRevision === undefined ||
      modRevision < 0
    )
      return yield* persistence(operation, 'invalid authoritative manifest projection coordinates')
    if (desiredState === 'deleted')
      return yield* persistence(
        operation,
        'a deleted server cannot be exported or reused by a declarative manifest',
      )
    if (sourceOperationId === undefined || specJson === undefined)
      return yield* persistence(
        operation,
        'this server predates declarative desired-state persistence and cannot be exported safely',
      )
    const rawSpec = yield* Effect.try({
      try: () => JSON.parse(specJson) as unknown,
      catch: () => persistence(operation, 'stored declarative desired state is not valid JSON'),
    })
    const spec = yield* Schema.decodeUnknownEffect(GameServerDesiredSpec, {
      onExcessProperty: 'error',
    })(rawSpec).pipe(
      Effect.mapError(() =>
        persistence(operation, 'stored declarative desired state does not match schema version 1'),
      ),
    )
    return {
      organizationId,
      serverId,
      name,
      desiredRevision,
      configRevision,
      modRevision,
      sourceOperationId,
      spec,
    }
  })

const readReplaySql = `SELECT
  mutation.request_fingerprint AS fingerprint,
  mutation.operation_id AS operationId,
  mutation.server_id AS serverId,
  mutation.expected_revision AS expectedRevision,
  mutation.desired_revision AS desiredRevision,
  operation.actor_id AS actorId,
  operation.status AS state
FROM game_server_manifest_mutations mutation
JOIN operations operation
  ON operation.organization_id = mutation.organization_id
 AND operation.id = mutation.operation_id
WHERE mutation.organization_id = ? AND mutation.idempotency_key = ?`

const decodeReplay = (
  command: GameServerManifestPolicyUpdateCommand,
  fingerprint: string,
  value: unknown,
): Effect.Effect<
  GameServerManifestPolicyUpdateAcceptance | null,
  GameServerManifestIdempotencyConflictError | GameServerManifestPersistenceError
> =>
  Effect.gen(function* () {
    if (value === null || value === undefined) return null
    const row = record(value)
    if (row === undefined)
      return yield* persistence('game-server-manifest.policy.replay', 'invalid policy replay row')
    if (text(row, 'fingerprint') !== fingerprint || text(row, 'actorId') !== command.actorId)
      return yield* new GameServerManifestIdempotencyConflictError({
        idempotencyKey: command.idempotencyKey,
      })
    const operationId = text(row, 'operationId')
    const serverId = text(row, 'serverId')
    const expectedRevision = integer(row, 'expectedRevision')
    const desiredRevision = integer(row, 'desiredRevision')
    const state = text(row, 'state')
    if (
      operationId === undefined ||
      serverId === undefined ||
      expectedRevision === undefined ||
      desiredRevision === undefined ||
      expectedRevision < 1 ||
      desiredRevision <= expectedRevision ||
      state !== 'succeeded'
    )
      return yield* persistence(
        'game-server-manifest.policy.replay',
        'invalid durable policy acceptance',
      )
    return {
      disposition: 'adopted',
      operationId,
      serverId,
      expectedRevision,
      desiredRevision,
      state: 'succeeded',
    }
  })

const stagePolicyAudit = (
  database: GameServerManifestD1Database,
  command: GameServerManifestPolicyUpdateCommand,
  operationId: string,
  eventId: string,
  now: string,
) =>
  completeAuditEnvelope({
    occurredAt: now,
    scope: 'tenant',
    organizationId: command.organizationId,
    actor: { type: 'human', id: command.actorId },
    action: 'game-server.manifest.policy.update.accepted',
    target: { type: 'server', id: command.serverId },
    before: { state: 'captured', summary: { desiredRevision: command.expectedRevision } },
    after: {
      state: 'captured',
      summary: {
        desiredRevision: command.expectedRevision + 1,
        updatePolicy: command.updatePolicy,
        backupPolicy: command.backupPolicy,
      },
    },
    operationId,
    request: command.auditRequestContext,
    result: 'succeeded',
    error: { classification: 'none', code: null },
    forced: false,
    breakGlass: false,
  }).pipe(
    Effect.mapError(() => persistence('game-server-manifest.policy.audit-envelope')),
    Effect.flatMap((envelope) =>
      stageAuditEnvelope('tenant', eventId, envelope, now).pipe(
        Effect.mapError(() => persistence('game-server-manifest.policy.audit-stage')),
        Effect.map((stage) => ({
          statement: database
            .prepare(auditEnvelopeStageSql)
            .bind(...auditEnvelopeStageBindings(stage)),
          summaryJson: auditEventSummaryJson(envelope),
        })),
      ),
    ),
  )

export const makeGameServerManifestD1Repository = (
  database: GameServerManifestD1Database,
  options: Partial<GameServerManifestD1Options> = {},
): GameServerManifestRepository => {
  const configured = { ...defaults, ...options }

  const readById: GameServerManifestRepository['readById'] = (organizationId, serverId) =>
    attempt('game-server-manifest.read-by-id', () =>
      database
        .prepare(storedStateSql.replace('%CONDITION%', 'server.id = ?'))
        .bind(organizationId, serverId)
        .first(),
    ).pipe(
      Effect.flatMap((row) => decodeStoredState(row, 'game-server-manifest.read-by-id')),
      Effect.flatMap((state) =>
        state === null
          ? Effect.fail(new GameServerManifestNotFoundError({ server: serverId }))
          : Effect.succeed(state),
      ),
    )

  const readByName: GameServerManifestRepository['readByName'] = (organizationId, name) =>
    attempt('game-server-manifest.read-by-name', () =>
      database
        .prepare(storedStateSql.replace('%CONDITION%', 'server.name = ?'))
        .bind(organizationId, name)
        .first(),
    ).pipe(Effect.flatMap((row) => decodeStoredState(row, 'game-server-manifest.read-by-name')))

  const findReplay = (command: GameServerManifestPolicyUpdateCommand, fingerprint: string) =>
    attempt('game-server-manifest.policy.replay', () =>
      database.prepare(readReplaySql).bind(command.organizationId, command.idempotencyKey).first(),
    ).pipe(Effect.flatMap((row) => decodeReplay(command, fingerprint, row)))

  const acceptPolicyUpdate: GameServerManifestRepository['acceptPolicyUpdate'] = (command) =>
    Effect.gen(function* () {
      const fingerprint = yield* fingerprintForPolicyUpdate(command)
      const replay = yield* findReplay(command, fingerprint)
      if (replay !== null) return replay
      const current = yield* readById(command.organizationId, command.serverId)
      if (current.desiredRevision !== command.expectedRevision)
        return yield* new GameServerManifestRevisionConflictError({
          serverId: command.serverId,
          expectedRevision: command.expectedRevision,
        })
      const now = configured.now()
      const operationId = configured.operationId()
      const auditEventId = configured.auditEventId()
      const audit = yield* stagePolicyAudit(database, command, operationId, auditEventId, now)
      const desiredRevision = command.expectedRevision + 1
      const result = {
        operationId,
        serverId: command.serverId,
        expectedRevision: command.expectedRevision,
        desiredRevision,
        state: 'succeeded' as const,
      }
      const statements = [
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'server.manifest.policy.update', 'server', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
          .bind(
            operationId,
            command.organizationId,
            command.serverId,
            command.actorId,
            command.idempotencyKey,
            command.correlationId,
            now,
            now,
          ),
        database
          .prepare(`UPDATE game_servers
          SET desired_revision = desired_revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND desired_revision = ?
            AND pending_lifecycle_operation_id IS NULL AND desired_state <> 'deleted'`)
          .bind(now, command.organizationId, command.serverId, command.expectedRevision),
        database
          .prepare(`UPDATE game_server_desired_specs
          SET desired_revision = desired_revision + 1,
              source_operation_id = ?,
              spec_json = json_set(
                spec_json,
                '$.updatePolicy', json(?),
                '$.backupPolicy', json(?)
              ),
              updated_at = ?
          WHERE organization_id = ? AND server_id = ? AND desired_revision = ?
            AND EXISTS (
              SELECT 1 FROM game_servers server
              WHERE server.organization_id = game_server_desired_specs.organization_id
                AND server.id = game_server_desired_specs.server_id
                AND server.desired_revision = ?
                AND server.pending_lifecycle_operation_id IS NULL
            )`)
          .bind(
            operationId,
            JSON.stringify(command.updatePolicy),
            JSON.stringify(command.backupPolicy),
            now,
            command.organizationId,
            command.serverId,
            command.expectedRevision,
            desiredRevision,
          ),
        audit.statement,
        database
          .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, 'game-server.manifest.policy.update.accepted', 'server', ?, 'succeeded', ?, ?, ?)`)
          .bind(
            auditEventId,
            command.organizationId,
            command.actorId,
            command.serverId,
            command.correlationId,
            audit.summaryJson,
            now,
          ),
        database
          .prepare(`INSERT INTO game_server_manifest_mutations
          (organization_id, idempotency_key, request_fingerprint, operation_id,
           server_id, expected_revision, desired_revision, acceptance_audit_event_id,
           result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            command.organizationId,
            command.idempotencyKey,
            fingerprint,
            operationId,
            command.serverId,
            command.expectedRevision,
            desiredRevision,
            auditEventId,
            JSON.stringify(result),
            now,
          ),
      ]
      const committed = yield* Effect.result(
        attempt('game-server-manifest.policy.accept', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* findReplay(command, fingerprint)
        if (adopted !== null) return adopted
        const latest = yield* readById(command.organizationId, command.serverId).pipe(Effect.result)
        if (
          latest._tag === 'Success' &&
          latest.success.desiredRevision !== command.expectedRevision
        )
          return yield* new GameServerManifestRevisionConflictError({
            serverId: command.serverId,
            expectedRevision: command.expectedRevision,
          })
        return yield* committed.failure
      }
      return { disposition: 'created', ...result }
    })

  return { readById, readByName, acceptPolicyUpdate }
}

const draftFingerprint = (value: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => persistence('game-server-draft.fingerprint'),
  })

const decodeDraft = (
  value: unknown,
  operation: string,
): Effect.Effect<typeof GameServerDraft.Type, GameServerManifestPersistenceError> =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* persistence(operation, 'draft row is missing')
    const id = text(row, 'id')
    const organizationId = text(row, 'organizationId')
    const actorId = text(row, 'actorId')
    const manifestJson = text(row, 'manifestJson')
    const state = text(row, 'state')
    const revision = integer(row, 'revision')
    const operationId = text(row, 'operationId')
    const createdAt = text(row, 'createdAt')
    const updatedAt = text(row, 'updatedAt')
    const sourceServerId = row.sourceServerId === null ? undefined : text(row, 'sourceServerId')
    if (
      id === undefined ||
      organizationId === undefined ||
      actorId === undefined ||
      manifestJson === undefined ||
      (state !== 'draft' &&
        state !== 'scheduled' &&
        state !== 'materialized' &&
        state !== 'cancelled') ||
      revision === undefined ||
      revision < 1 ||
      operationId === undefined ||
      createdAt === undefined ||
      updatedAt === undefined
    )
      return yield* persistence(operation, 'draft coordinates are invalid')
    const manifestUnknown = yield* Effect.try({
      try: () => JSON.parse(manifestJson) as unknown,
      catch: () => persistence(operation, 'draft manifest JSON is invalid'),
    })
    const manifest = yield* Schema.decodeUnknownEffect(GameServerManifest, {
      onExcessProperty: 'error',
    })(manifestUnknown).pipe(
      Effect.mapError(() =>
        persistence(operation, 'draft manifest does not match the normalized contract'),
      ),
    )
    return {
      id,
      organizationId,
      actorId,
      manifest,
      ...(sourceServerId === undefined ? {} : { sourceServerId }),
      state,
      revision,
      operationId,
      createdAt,
      updatedAt,
    }
  })

const draftSelect = `SELECT id, organization_id AS organizationId, actor_id AS actorId,
  manifest_json AS manifestJson, source_server_id AS sourceServerId, state, revision,
  operation_id AS operationId, created_at AS createdAt, updated_at AS updatedAt
FROM game_server_drafts`

const decodeSchedule = (
  value: unknown,
  operation: string,
): Effect.Effect<GameServerDraftSchedule, GameServerManifestPersistenceError> => {
  const row = record(value)
  if (row === undefined) return Effect.fail(persistence(operation, 'schedule row is missing'))
  const id = text(row, 'id')
  const organizationId = text(row, 'organizationId')
  const draftId = text(row, 'draftId')
  const scheduledFor = text(row, 'scheduledFor')
  const state = text(row, 'state')
  const revision = integer(row, 'revision')
  const operationId = text(row, 'operationId')
  const targetOperationId =
    row.targetOperationId === null ? undefined : text(row, 'targetOperationId')
  const createdAt = text(row, 'createdAt')
  const updatedAt = text(row, 'updatedAt')
  if (
    id === undefined ||
    organizationId === undefined ||
    draftId === undefined ||
    scheduledFor === undefined ||
    (state !== 'scheduled' &&
      state !== 'dispatching' &&
      state !== 'retrying' &&
      state !== 'accepted' &&
      state !== 'failed' &&
      state !== 'cancelled') ||
    revision === undefined ||
    revision < 1 ||
    operationId === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  )
    return Effect.fail(persistence(operation, 'schedule coordinates are invalid'))
  return Effect.succeed({
    id,
    organizationId,
    draftId,
    scheduledFor,
    state,
    revision,
    operationId,
    ...(targetOperationId === undefined ? {} : { targetOperationId }),
    createdAt,
    updatedAt,
  })
}

const scheduleSelect = `SELECT id, organization_id AS organizationId, draft_id AS draftId,
  scheduled_for AS scheduledFor, state, revision, operation_id AS operationId,
  target_operation_id AS targetOperationId, created_at AS createdAt, updated_at AS updatedAt
FROM game_server_draft_schedules`

const stageDraftAudit = (
  database: GameServerManifestD1Database,
  input: {
    readonly eventId: string
    readonly operationId: string
    readonly organizationId: string
    readonly actorId: string
    readonly correlationId: string
    readonly request: GameServerDraftCreateCommand['auditRequestContext']
    readonly action: 'create' | 'schedule'
    readonly draftId: string
    readonly before: Parameters<typeof completeAuditEnvelope>[0]['before']
    readonly after: Readonly<Record<string, unknown>>
    readonly now: string
  },
) =>
  completeAuditEnvelope({
    occurredAt: input.now,
    scope: 'tenant',
    organizationId: input.organizationId,
    actor: { type: 'human', id: input.actorId },
    action: `game-server.draft.${input.action}`,
    target: { type: 'game-server-draft', id: input.draftId },
    before: input.before,
    after: { state: 'captured', summary: input.after },
    operationId: input.operationId,
    request: input.request,
    result: 'succeeded',
    error: { classification: 'none', code: null },
    forced: false,
    breakGlass: false,
  }).pipe(
    Effect.mapError(() => persistence(`game-server-draft.${input.action}.audit-envelope`)),
    Effect.flatMap((envelope) =>
      stageAuditEnvelope('tenant', input.eventId, envelope, input.now).pipe(
        Effect.mapError(() => persistence(`game-server-draft.${input.action}.audit-stage`)),
        Effect.map((stage) => ({
          statement: database
            .prepare(auditEnvelopeStageSql)
            .bind(...auditEnvelopeStageBindings(stage)),
          summaryJson: auditEventSummaryJson(envelope),
        })),
      ),
    ),
  )

/** Durable create-draft and one-shot schedule acceptance. The due dispatcher
 * is separate so a client request can never choose an automation identity or
 * claim that delayed provider work has already happened. */
export const makeGameServerDraftD1Repository = (
  database: GameServerManifestD1Database,
  options: Partial<GameServerManifestD1Options> = {},
): GameServerDraftRepository => {
  const configured = { ...defaults, ...options }

  const read: GameServerDraftRepository['read'] = (organizationId, draftId) =>
    attempt('game-server-draft.read', () =>
      database
        .prepare(`${draftSelect} WHERE organization_id = ? AND id = ?`)
        .bind(organizationId, draftId)
        .first(),
    ).pipe(
      Effect.flatMap(
        (value): Effect.Effect<typeof GameServerDraft.Type, GameServerManifestRepositoryError> =>
          value === null
            ? Effect.fail(new GameServerManifestNotFoundError({ server: draftId }))
            : decodeDraft(value, 'game-server-draft.read'),
      ),
    )

  const create: GameServerDraftRepository['create'] = (command) =>
    Effect.gen(function* () {
      const fingerprint = yield* draftFingerprint({
        action: 'create-draft',
        organizationId: command.organizationId,
        manifest: JSON.parse(canonicalGameServerManifest(command.manifest)) as unknown,
        sourceServerId: command.sourceServerId ?? null,
      })
      const replay = yield* attempt('game-server-draft.replay', () =>
        database
          .prepare(`${draftSelect} WHERE organization_id = ? AND idempotency_key = ?`)
          .bind(command.organizationId, command.idempotencyKey)
          .first(),
      )
      if (replay !== null) {
        // The common projection intentionally omits the fingerprint; read it
        // directly when a replay exists so cross-payload reuse stays denied.
        const exact = yield* attempt('game-server-draft.replay-fingerprint', () =>
          database
            .prepare(`SELECT request_fingerprint AS requestFingerprint, actor_id AS actorId
            FROM game_server_drafts WHERE organization_id = ? AND idempotency_key = ?`)
            .bind(command.organizationId, command.idempotencyKey)
            .first(),
        )
        const exactRow = record(exact)
        if (
          text(exactRow ?? {}, 'requestFingerprint') !== fingerprint ||
          text(exactRow ?? {}, 'actorId') !== command.actorId
        )
          return yield* new GameServerManifestIdempotencyConflictError({
            idempotencyKey: command.idempotencyKey,
          })
        return yield* decodeDraft(replay, 'game-server-draft.replay')
      }
      const now = configured.now()
      const draftId = configured.draftId()
      const operationId = configured.operationId()
      const eventId = configured.auditEventId()
      const audit = yield* stageDraftAudit(database, {
        eventId,
        operationId,
        organizationId: command.organizationId,
        actorId: command.actorId,
        correlationId: command.correlationId,
        request: command.auditRequestContext,
        action: 'create',
        draftId,
        before: { state: 'absent', reason: 'resource-did-not-exist' },
        after: {
          draftId,
          manifestName: command.manifest.metadata.name,
          ...(command.sourceServerId === undefined
            ? {}
            : { sourceServerId: command.sourceServerId }),
          state: 'draft',
          revision: 1,
        },
        now,
      })
      const statements = [
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status,
           progress, idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'game-server.draft.create', 'game-server-draft', ?, ?,
            'succeeded', 100, ?, ?, 1, ?, ?)`)
          .bind(
            operationId,
            command.organizationId,
            draftId,
            command.actorId,
            command.idempotencyKey,
            command.correlationId,
            now,
            now,
          ),
        audit.statement,
        database
          .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, 'game-server.draft.create', 'game-server-draft', ?,
            'succeeded', ?, ?, ?)`)
          .bind(
            eventId,
            command.organizationId,
            command.actorId,
            draftId,
            command.correlationId,
            audit.summaryJson,
            now,
          ),
        database
          .prepare(`INSERT INTO game_server_drafts
          (organization_id, id, actor_id, idempotency_key, request_fingerprint,
           manifest_json, source_server_id, state, revision, operation_id,
           acceptance_audit_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`)
          .bind(
            command.organizationId,
            draftId,
            command.actorId,
            command.idempotencyKey,
            fingerprint,
            canonicalGameServerManifest(command.manifest),
            command.sourceServerId ?? null,
            operationId,
            eventId,
            now,
            now,
          ),
      ]
      const committed = yield* Effect.result(
        attempt('game-server-draft.create', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* attempt('game-server-draft.adopt', () =>
          database
            .prepare(`${draftSelect} WHERE organization_id = ? AND idempotency_key = ?`)
            .bind(command.organizationId, command.idempotencyKey)
            .first(),
        )
        if (adopted !== null) return yield* decodeDraft(adopted, 'game-server-draft.adopt')
        return yield* committed.failure
      }
      return yield* read(command.organizationId, draftId)
    })

  const schedule: GameServerDraftRepository['schedule'] = (command) =>
    Effect.gen(function* () {
      const fingerprint = yield* draftFingerprint({
        action: 'schedule-draft',
        organizationId: command.organizationId,
        draftId: command.draftId,
        expectedRevision: command.expectedRevision,
        scheduledFor: command.scheduledFor,
      })
      const replay = yield* attempt('game-server-draft.schedule.replay', () =>
        database
          .prepare(`${scheduleSelect} WHERE organization_id = ? AND idempotency_key = ?`)
          .bind(command.organizationId, command.idempotencyKey)
          .first(),
      )
      if (replay !== null) {
        const exact = yield* attempt('game-server-draft.schedule.replay-fingerprint', () =>
          database
            .prepare(`SELECT request_fingerprint AS requestFingerprint, actor_id AS actorId
            FROM game_server_draft_schedules WHERE organization_id = ? AND idempotency_key = ?`)
            .bind(command.organizationId, command.idempotencyKey)
            .first(),
        )
        const exactRow = record(exact)
        if (
          text(exactRow ?? {}, 'requestFingerprint') !== fingerprint ||
          text(exactRow ?? {}, 'actorId') !== command.actorId
        )
          return yield* new GameServerManifestIdempotencyConflictError({
            idempotencyKey: command.idempotencyKey,
          })
        return yield* decodeSchedule(replay, 'game-server-draft.schedule.replay')
      }
      const draft = yield* read(command.organizationId, command.draftId)
      if (draft.state !== 'draft' || draft.revision !== command.expectedRevision)
        return yield* new GameServerManifestRevisionConflictError({
          serverId: command.draftId,
          expectedRevision: command.expectedRevision,
        })
      const now = configured.now()
      const scheduleId = configured.scheduleId()
      const operationId = configured.operationId()
      const eventId = configured.auditEventId()
      const audit = yield* stageDraftAudit(database, {
        eventId,
        operationId,
        organizationId: command.organizationId,
        actorId: command.actorId,
        correlationId: command.correlationId,
        request: command.auditRequestContext,
        action: 'schedule',
        draftId: command.draftId,
        before: { state: 'captured', summary: { state: draft.state, revision: draft.revision } },
        after: {
          state: 'scheduled',
          revision: draft.revision + 1,
          scheduleId,
          scheduledFor: command.scheduledFor,
        },
        now,
      })
      const statements = [
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status,
           progress, idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'game-server.draft.schedule', 'game-server-draft', ?, ?,
            'succeeded', 100, ?, ?, 1, ?, ?)`)
          .bind(
            operationId,
            command.organizationId,
            command.draftId,
            command.actorId,
            command.idempotencyKey,
            command.correlationId,
            now,
            now,
          ),
        audit.statement,
        database
          .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, 'game-server.draft.schedule', 'game-server-draft', ?,
            'succeeded', ?, ?, ?)`)
          .bind(
            eventId,
            command.organizationId,
            command.actorId,
            command.draftId,
            command.correlationId,
            audit.summaryJson,
            now,
          ),
        database
          .prepare(`INSERT INTO game_server_draft_schedules
          (organization_id, id, draft_id, actor_id, idempotency_key,
           request_fingerprint, scheduled_for, state, revision, operation_id,
           target_operation_id, attempts, claim_id, lease_expires_at,
           last_error_code, acceptance_audit_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL, 0, NULL, NULL,
            NULL, ?, ?, ?)`)
          .bind(
            command.organizationId,
            scheduleId,
            command.draftId,
            command.actorId,
            command.idempotencyKey,
            fingerprint,
            command.scheduledFor,
            operationId,
            eventId,
            now,
            now,
          ),
        database
          .prepare(`UPDATE game_server_drafts
          SET state = 'scheduled', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND state = 'draft' AND revision = ?`)
          .bind(now, command.organizationId, command.draftId, command.expectedRevision),
      ]
      const committed = yield* Effect.result(
        attempt('game-server-draft.schedule', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* attempt('game-server-draft.schedule.adopt', () =>
          database
            .prepare(`${scheduleSelect} WHERE organization_id = ? AND idempotency_key = ?`)
            .bind(command.organizationId, command.idempotencyKey)
            .first(),
        )
        if (adopted !== null)
          return yield* decodeSchedule(adopted, 'game-server-draft.schedule.adopt')
        return yield* committed.failure
      }
      const accepted = yield* attempt('game-server-draft.schedule.read', () =>
        database
          .prepare(`${scheduleSelect} WHERE organization_id = ? AND id = ?`)
          .bind(command.organizationId, scheduleId)
          .first(),
      )
      return yield* decodeSchedule(accepted, 'game-server-draft.schedule.read')
    })

  return { create, read, schedule }
}

export const GameServerManifestD1Live = Layer.effect(
  GameServerManifestD1Repository,
  Effect.gen(function* () {
    const database = yield* GameServerManifestD1Client
    return makeGameServerManifestD1Repository(database)
  }),
)

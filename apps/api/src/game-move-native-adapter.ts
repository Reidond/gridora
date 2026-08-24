import { Effect, Schema } from 'effect'
import {
  AgentCommand,
  CommandResult,
  DeploymentSpec,
  canonicalCommandPayload,
  canonicalJson,
  type AgentCommand as AgentCommandType,
  type CommandResult as CommandResultType,
} from '@gridora/agent-protocol'
import {
  BackupPersistenceError,
  type BackupControlShape,
  type BackupJob,
} from '@gridora/backup-control'
import type { BackupD1Database } from '@gridora/backup-d1'
import { loadBackupWorkflowState } from '@gridora/backup-d1'
import { makeCloudflareControl, type CloudflareApiShape } from '@gridora/cloudflare-control'
import {
  CorrelationId,
  IdentityId,
  OrganizationContext as OrganizationContextValue,
  OrganizationId,
  OrganizationSlug,
  type OrganizationContext,
} from '@gridora/domain'
import type { GameLifecycleD1Database } from '@gridora/game-lifecycle-d1'
import type { NodeCoordinatorDO } from '@gridora/realtime'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import type {
  GameMoveBackupAdapter,
  GameMoveDnsProviderReceipt,
  GameMoveEffect,
  GameMovePhysicalEvidence,
} from './game-lifecycle-runtime.js'
import { commandSigner, sha256Hex } from './game-lifecycle-runtime.js'
import {
  GameWorkflowStepError,
  type GameWorkflowPayload as GameWorkflowPayloadType,
} from '@gridora/game-lifecycle-execution'

type MoveDatabase = GameLifecycleD1Database & BackupD1Database

type PhysicalAction =
  | 'restore-stage'
  | 'restore-validate'
  | 'restore-commit'
  | 'activate-target'
  | 'release-source'
  | 'rollback-target'
  | 'rollback-stage'
  | 'rollback-source-deploy'
  | 'rollback-source-start'

type TargetStageState = 'prepared' | 'staged' | 'validated' | 'committed' | 'active' | 'rolled_back'

interface TargetStage {
  readonly effectId: string
  readonly operationId: string
  readonly serverId: string
  readonly backupId: string
  readonly stageId: string
  readonly sourceDeploymentId: string
  readonly targetNodeId: string
  readonly state: TargetStageState
  readonly revision: number
}

interface PhysicalCommand {
  readonly action: PhysicalAction
  readonly nodeId: string
  readonly resourceId: string
  readonly commandId: string
  readonly commandJson: string
  readonly fingerprint: string
  readonly resultJson?: string
  readonly state: 'pending' | 'succeeded' | 'failed'
  readonly revision: number
}

interface SucceededBackup {
  readonly job: BackupJob
  readonly artifact: {
    readonly id: string
    readonly organizationId: string
    readonly serverId: string
    readonly checksum: string
    readonly state: string
    readonly revision: number
    readonly createdAt: string
    readonly metadata: {
      readonly pluginId: string
      readonly pluginVersion: string
      readonly consistency: 'crash-consistent' | 'plugin-quiesced'
      readonly includes: readonly ('config' | 'data' | 'mods' | 'state')[]
    }
  }
}

export interface GameMoveNativeAdapterBindings {
  /** One shared tenant-scoped D1 binding used by game and backup repositories. */
  readonly database: MoveDatabase
  readonly nodeCoordinator: DurableObjectNamespace<NodeCoordinatorDO>
  readonly signingKey: { readonly get: () => Promise<string> }
  readonly backupControl: BackupControlShape
  /** Starts/adopts the native backup Workflow after its D1 reservation. */
  readonly startBackupWorkflow: (
    actor: OrganizationContext,
    job: BackupJob,
  ) => Effect.Effect<void, BackupPersistenceError>
  /** Required only for a move with a persisted immutable DNS effect. */
  readonly cloudflare?: CloudflareApiShape
}

const failure = (code: string, message: string) => new GameWorkflowStepError({ code, message })

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => failure('move-persistence', `${operation}: ${String(cause)}`),
  })

const rowObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined

const wholeNumber = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] : undefined

const moveBackupKey = (operationId: string) => `game-move:${operationId}:backup`
const stageIdFor = (effect: GameMoveEffect) => `game-move-stage:${effect.effectId}`

const asMovePayload = (payload: GameWorkflowPayloadType) => {
  if (payload.action !== 'move')
    return Effect.fail(
      failure('move-action-mismatch', 'native move adapter received a non-move Workflow payload'),
    )
  if (payload.targetNodeId === undefined)
    return Effect.fail(failure('move-target-missing', 'accepted move has no target node'))
  return Effect.succeed(payload)
}

const internalActor = (
  database: MoveDatabase,
  payload: GameWorkflowPayloadType,
): Effect.Effect<OrganizationContext, GameWorkflowStepError> =>
  Effect.gen(function* () {
    const organizationId = yield* Schema.decodeUnknownEffect(OrganizationId)(
      payload.organizationId,
    ).pipe(Effect.mapError(() => failure('move-actor-invalid', 'move organization id is invalid')))
    const identityId = yield* Schema.decodeUnknownEffect(IdentityId)(payload.actorId).pipe(
      Effect.mapError(() => failure('move-actor-invalid', 'move actor id is invalid')),
    )
    const correlationId = yield* Schema.decodeUnknownEffect(CorrelationId)(
      payload.operationId,
    ).pipe(Effect.mapError(() => failure('move-actor-invalid', 'move operation id is invalid')))
    const organization = yield* attempt('game-move.actor.organization', () =>
      database
        .prepare('SELECT slug FROM organizations WHERE id = ?')
        .bind(payload.organizationId)
        .first(),
    )
    const slug = organization === null ? undefined : text(rowObject(organization) ?? {}, 'slug')
    if (slug === undefined)
      return yield* failure(
        'move-organization-missing',
        'move organization authority is unavailable',
      )
    const organizationSlug = yield* Schema.decodeUnknownEffect(OrganizationSlug)(slug).pipe(
      Effect.mapError(() => failure('move-actor-invalid', 'move organization slug is invalid')),
    )
    const auditRequestContext: AuditRequestContextValue = {
      origin: 'internal',
      requestId: `workflow:${payload.operationId}`,
      correlationId: payload.operationId,
      source: {
        ip: { state: 'not-available', reason: 'internal-workflow-has-no-network-source' },
        access: { state: 'not-available', reason: 'internal-workflow-has-no-access-assertion' },
      },
    }
    return new OrganizationContextValue({
      organizationId,
      organizationSlug,
      identityId,
      role: 'operator',
      correlationId,
      auditRequestContext,
    } as OrganizationContext & { readonly auditRequestContext: AuditRequestContextValue })
  })

const readSucceededBackupByKey = (
  database: MoveDatabase,
  payload: GameWorkflowPayloadType,
  backupId?: string,
): Effect.Effect<SucceededBackup, GameWorkflowStepError> =>
  Effect.gen(function* () {
    const row = yield* attempt('game-move.backup.lookup', () =>
      database
        .prepare(`SELECT operation_id AS operationId FROM backup_jobs
        WHERE organization_id = ? AND idempotency_key = ? AND mode = 'create'`)
        .bind(payload.organizationId, moveBackupKey(payload.operationId))
        .first(),
    )
    const operationId = row === null ? undefined : text(rowObject(row) ?? {}, 'operationId')
    if (operationId === undefined)
      return yield* failure('move-backup-missing', 'no source backup job is bound to this move')
    const loaded = yield* loadBackupWorkflowState(
      database,
      payload.organizationId,
      operationId,
    ).pipe(
      Effect.mapError(() =>
        failure('move-backup-unavailable', 'source backup Workflow authority is unavailable'),
      ),
    )
    if (
      loaded.job.mode !== 'create' ||
      loaded.job.state !== 'succeeded' ||
      loaded.job.sourceServerId !== payload.serverId ||
      loaded.artifact.organizationId !== payload.organizationId ||
      loaded.artifact.serverId !== payload.serverId ||
      loaded.artifact.state !== 'available' ||
      (backupId !== undefined && loaded.artifact.id !== backupId)
    )
      return yield* failure(
        'move-backup-mismatch',
        'source backup is not a completed artifact bound to this move',
      )
    if (
      loaded.artifact.metadata.pluginId !== payload.plugin.id ||
      loaded.artifact.metadata.pluginVersion !== payload.plugin.version
    )
      return yield* failure(
        'move-backup-plugin-mismatch',
        'source backup plugin facts do not match the accepted move',
      )
    return {
      job: loaded.job,
      artifact: loaded.artifact,
    } satisfies SucceededBackup
  })

const readStage = (
  database: MoveDatabase,
  effect: GameMoveEffect,
): Effect.Effect<TargetStage | null, GameWorkflowStepError> =>
  attempt('game-move.stage.read', () =>
    database
      .prepare(`SELECT effect_id AS effectId, operation_id AS operationId, server_id AS serverId,
      backup_id AS backupId, stage_id AS stageId, source_deployment_id AS sourceDeploymentId,
      target_node_id AS targetNodeId, state, revision
      FROM game_lifecycle_move_target_stages
      WHERE organization_id = ? AND effect_id = ?`)
      .bind(effect.organizationId, effect.effectId)
      .first(),
  ).pipe(
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed(null)
      const row = rowObject(raw)
      const effectId = row === undefined ? undefined : text(row, 'effectId')
      const operationId = row === undefined ? undefined : text(row, 'operationId')
      const serverId = row === undefined ? undefined : text(row, 'serverId')
      const backupId = row === undefined ? undefined : text(row, 'backupId')
      const stageId = row === undefined ? undefined : text(row, 'stageId')
      const sourceDeploymentId = row === undefined ? undefined : text(row, 'sourceDeploymentId')
      const targetNodeId = row === undefined ? undefined : text(row, 'targetNodeId')
      const state = row === undefined ? undefined : text(row, 'state')
      const revision = row === undefined ? undefined : wholeNumber(row, 'revision')
      if (
        effectId !== effect.effectId ||
        operationId !== effect.operationId ||
        serverId !== effect.serverId ||
        backupId === undefined ||
        stageId !== stageIdFor(effect) ||
        sourceDeploymentId !== effect.sourceDeploymentId ||
        targetNodeId !== effect.target.nodeId ||
        (state !== 'prepared' &&
          state !== 'staged' &&
          state !== 'validated' &&
          state !== 'committed' &&
          state !== 'active' &&
          state !== 'rolled_back') ||
        revision === undefined
      )
        return Effect.fail(
          failure(
            'move-stage-invalid',
            'target staging record is not bound to the immutable move effect',
          ),
        )
      return Effect.succeed({
        effectId,
        operationId,
        serverId,
        backupId,
        stageId,
        sourceDeploymentId,
        targetNodeId,
        state,
        revision,
      } satisfies TargetStage)
    }),
  )

const ensureStage = (
  database: MoveDatabase,
  payload: GameWorkflowPayloadType,
  effect: GameMoveEffect,
  backupId: string,
): Effect.Effect<TargetStage, GameWorkflowStepError> =>
  Effect.gen(function* () {
    const existing = yield* readStage(database, effect)
    if (existing !== null) {
      if (existing.backupId !== backupId)
        return yield* failure(
          'move-stage-backup-mismatch',
          'target staging record uses a different source backup',
        )
      return existing
    }
    const now = new Date().toISOString()
    const committed = yield* Effect.result(
      attempt('game-move.stage.prepare', () =>
        database
          .batch([
            database
              .prepare(`INSERT INTO game_lifecycle_move_target_stages
          (organization_id, effect_id, operation_id, server_id, backup_id, stage_id,
           source_deployment_id, target_node_id, state, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?)`)
              .bind(
                payload.organizationId,
                effect.effectId,
                payload.operationId,
                payload.serverId,
                backupId,
                stageIdFor(effect),
                effect.sourceDeploymentId,
                effect.target.nodeId,
                now,
                now,
              ),
          ])
          .then(() => undefined),
      ),
    )
    const adopted = yield* readStage(database, effect)
    if (adopted !== null && adopted.backupId === backupId) return adopted
    if (committed._tag === 'Failure') return yield* committed.failure
    return yield* failure('move-stage-missing', 'target staging record did not persist')
  })

const advanceStage = (
  database: MoveDatabase,
  effect: GameMoveEffect,
  stage: TargetStage,
  next: TargetStageState,
): Effect.Effect<TargetStage, GameWorkflowStepError> =>
  Effect.gen(function* () {
    if (stage.state === next) return stage
    const now = new Date().toISOString()
    const committed = yield* Effect.result(
      attempt('game-move.stage.advance', () =>
        database
          .batch([
            database
              .prepare(`UPDATE game_lifecycle_move_target_stages
          SET state = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND effect_id = ? AND state = ? AND revision = ?`)
              .bind(next, now, effect.organizationId, effect.effectId, stage.state, stage.revision),
          ])
          .then(() => undefined),
      ),
    )
    const adopted = yield* readStage(database, effect)
    if (adopted?.state === next && adopted.revision === stage.revision + 1) return adopted
    if (committed._tag === 'Failure') return yield* committed.failure
    return yield* failure(
      'move-stage-transition-missing',
      'target staging transition did not persist exact evidence',
    )
  })

const requireStage = (
  database: MoveDatabase,
  effect: GameMoveEffect,
  backupId: string,
  allowed: readonly TargetStageState[],
) =>
  readStage(database, effect).pipe(
    Effect.flatMap((stage) => {
      if (stage === null || stage.backupId !== backupId || !allowed.includes(stage.state))
        return Effect.fail(
          failure(
            'move-stage-required',
            'move target is not in the required immutable staging state',
          ),
        )
      return Effect.succeed(stage)
    }),
  )

const commandTypeFor = (action: PhysicalAction): AgentCommandType['type'] => {
  switch (action) {
    case 'restore-stage':
    case 'restore-validate':
    case 'restore-commit':
    case 'rollback-stage':
      return 'backup.restore'
    case 'activate-target':
    case 'rollback-source-deploy':
      return 'deployment.apply'
    case 'release-source':
    case 'rollback-target':
      return 'deployment.remove'
    case 'rollback-source-start':
      return 'server.start'
  }
}

const nodeFor = (effect: GameMoveEffect, action: PhysicalAction) =>
  action === 'release-source' ||
  action === 'rollback-source-deploy' ||
  action === 'rollback-source-start'
    ? effect.source.nodeId
    : effect.target.nodeId

const readPhysicalCommand = (
  database: MoveDatabase,
  effect: GameMoveEffect,
  action: PhysicalAction,
): Effect.Effect<PhysicalCommand | null, GameWorkflowStepError> =>
  attempt('game-move.command.read', () =>
    database
      .prepare(`SELECT action, node_id AS nodeId, resource_id AS resourceId, command_id AS commandId,
      command_json AS commandJson, command_fingerprint AS fingerprint, result_json AS resultJson,
      state, revision
      FROM game_lifecycle_move_physical_commands
      WHERE organization_id = ? AND effect_id = ? AND action = ?`)
      .bind(effect.organizationId, effect.effectId, action)
      .first(),
  ).pipe(
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed(null)
      const row = rowObject(raw)
      const storedAction = row === undefined ? undefined : text(row, 'action')
      const nodeId = row === undefined ? undefined : text(row, 'nodeId')
      const resourceId = row === undefined ? undefined : text(row, 'resourceId')
      const commandId = row === undefined ? undefined : text(row, 'commandId')
      const commandJson = row === undefined ? undefined : text(row, 'commandJson')
      const fingerprint = row === undefined ? undefined : text(row, 'fingerprint')
      const resultJson =
        row === undefined || row.resultJson === null ? undefined : text(row, 'resultJson')
      const state = row === undefined ? undefined : text(row, 'state')
      const revision = row === undefined ? undefined : wholeNumber(row, 'revision')
      if (
        storedAction !== action ||
        nodeId !== nodeFor(effect, action) ||
        resourceId !== effect.serverId ||
        commandId === undefined ||
        commandJson === undefined ||
        fingerprint === undefined ||
        (state !== 'pending' && state !== 'succeeded' && state !== 'failed') ||
        revision === undefined ||
        (state === 'pending' && resultJson !== undefined) ||
        (state !== 'pending' && resultJson === undefined)
      )
        return Effect.fail(
          failure(
            'move-command-invalid',
            'persisted physical command is not bound to this move effect',
          ),
        )
      return Effect.succeed({
        action,
        nodeId,
        resourceId,
        commandId,
        commandJson,
        fingerprint,
        ...(resultJson === undefined ? {} : { resultJson }),
        state,
        revision,
      } satisfies PhysicalCommand)
    }),
  )

const decodeStoredCommand = (
  effect: GameMoveEffect,
  action: PhysicalAction,
  row: PhysicalCommand,
): Effect.Effect<AgentCommandType, GameWorkflowStepError> =>
  Effect.try({
    try: () => JSON.parse(row.commandJson) as unknown,
    catch: (cause) => failure('move-command-invalid', String(cause)),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })(value),
    ),
    Effect.mapError(() =>
      failure('move-command-invalid', 'persisted physical command cannot be decoded'),
    ),
    Effect.flatMap((command) =>
      command.commandId !== row.commandId ||
      command.organizationId !== effect.organizationId ||
      command.operationId !== effect.operationId ||
      command.nodeId !== row.nodeId ||
      command.resourceId !== effect.serverId ||
      command.type !== commandTypeFor(action)
        ? Effect.fail(
            failure(
              'move-command-scope-mismatch',
              'persisted physical command is foreign to the immutable move effect',
            ),
          )
        : sha256Hex(canonicalCommandPayload(command)).pipe(
            Effect.flatMap((fingerprint) =>
              fingerprint !== row.fingerprint
                ? Effect.fail(
                    failure(
                      'move-command-fingerprint-mismatch',
                      'persisted physical command fingerprint changed',
                    ),
                  )
                : Effect.succeed(command),
            ),
          ),
    ),
  )

const decodeStoredResult = (
  effect: GameMoveEffect,
  row: PhysicalCommand,
): Effect.Effect<CommandResultType, GameWorkflowStepError> => {
  if (row.resultJson === undefined)
    return Effect.fail(
      failure('move-command-result-missing', 'terminal physical command has no durable result'),
    )
  return Effect.try({
    try: () => JSON.parse(row.resultJson!) as unknown,
    catch: (cause) => failure('move-command-result-invalid', String(cause)),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CommandResult, { onExcessProperty: 'error' })(value),
    ),
    Effect.mapError(() =>
      failure('move-command-result-invalid', 'durable physical command result cannot be decoded'),
    ),
    Effect.flatMap((result) =>
      result.commandId !== row.commandId || result.operationId !== effect.operationId
        ? Effect.fail(
            failure(
              'move-command-result-scope-mismatch',
              'physical command result is foreign to the move effect',
            ),
          )
        : Effect.succeed(result),
    ),
  )
}

const materializeCommand = (
  bindings: GameMoveNativeAdapterBindings,
  payload: GameWorkflowPayloadType,
  effect: GameMoveEffect,
  action: PhysicalAction,
  commandPayload: unknown,
): Effect.Effect<
  { readonly command: AgentCommandType; readonly fingerprint: string },
  GameWorkflowStepError
> =>
  Effect.gen(function* () {
    if (Date.parse(payload.expiresAt) <= Date.now())
      return yield* failure('move-command-expired', 'accepted move payload has expired')
    const digest = yield* sha256Hex(`${effect.effectId}:${action}`).pipe(
      Effect.mapError(() =>
        failure('move-command-identity-failed', 'physical command identity could not be derived'),
      ),
    )
    const commandId = `gamemovecmd_${digest.slice(0, 48)}`
    const issuedAt = new Date().toISOString()
    const unsigned = yield* Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })(
      {
        apiVersion: 'agent.gridora.dev/v1alpha1',
        commandId,
        operationId: effect.operationId,
        organizationId: effect.organizationId,
        nodeId: nodeFor(effect, action),
        resourceId: effect.serverId,
        type: commandTypeFor(action),
        payloadSchemaVersion: 1,
        plugin: { id: payload.plugin.id, version: payload.plugin.version },
        issuedAt,
        expiresAt: payload.expiresAt,
        idempotencyKey: `game-move:${digest}`,
        expectedPriorRevision: null,
        payload: commandPayload,
        signature: 'unsigned-command-placeholder-00000000',
      },
    ).pipe(
      Effect.mapError(() =>
        failure('move-command-invalid', 'physical command does not satisfy the agent contract'),
      ),
    )
    const pem = yield* Effect.tryPromise({
      try: () => bindings.signingKey.get(),
      catch: () =>
        failure('move-command-signing-key-unavailable', 'agent signing key is unavailable'),
    })
    const signer = yield* commandSigner(pem)
    const signature = yield* Effect.tryPromise({
      try: () => signer.sign(canonicalCommandPayload(unsigned)),
      catch: () => failure('move-command-signing-failed', 'physical command could not be signed'),
    })
    const command = yield* Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })({
      ...unsigned,
      signature,
    }).pipe(
      Effect.mapError(() =>
        failure(
          'move-command-invalid',
          'signed physical command does not satisfy the agent contract',
        ),
      ),
    )
    const fingerprint = yield* sha256Hex(canonicalCommandPayload(command)).pipe(
      Effect.mapError(() =>
        failure(
          'move-command-identity-failed',
          'physical command fingerprint could not be derived',
        ),
      ),
    )
    return { command, fingerprint }
  })

const persistCommand = (
  database: MoveDatabase,
  effect: GameMoveEffect,
  action: PhysicalAction,
  command: AgentCommandType,
  fingerprint: string,
): Effect.Effect<PhysicalCommand, GameWorkflowStepError> =>
  Effect.gen(function* () {
    const now = new Date().toISOString()
    const committed = yield* Effect.result(
      attempt('game-move.command.prepare', () =>
        database
          .batch([
            database
              .prepare(`INSERT INTO game_lifecycle_move_physical_commands
          (organization_id, effect_id, action, node_id, resource_id, command_id, command_json,
           command_fingerprint, result_json, state, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 1, ?, ?)`)
              .bind(
                effect.organizationId,
                effect.effectId,
                action,
                command.nodeId,
                command.resourceId,
                command.commandId,
                canonicalJson(command),
                fingerprint,
                now,
                now,
              ),
          ])
          .then(() => undefined),
      ),
    )
    const adopted = yield* readPhysicalCommand(database, effect, action)
    if (adopted !== null) return adopted
    if (committed._tag === 'Failure') return yield* committed.failure
    return yield* failure('move-command-missing', 'physical command envelope did not persist')
  })

const persistResult = (
  database: MoveDatabase,
  effect: GameMoveEffect,
  row: PhysicalCommand,
  result: CommandResultType,
): Effect.Effect<PhysicalCommand, GameWorkflowStepError> =>
  Effect.gen(function* () {
    if (row.state !== 'pending') return row
    const state = result.status === 'succeeded' ? ('succeeded' as const) : ('failed' as const)
    const now = new Date().toISOString()
    const committed = yield* Effect.result(
      attempt('game-move.command.result', () =>
        database
          .batch([
            database
              .prepare(`UPDATE game_lifecycle_move_physical_commands
          SET result_json = ?, state = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND effect_id = ? AND action = ?
            AND state = 'pending' AND revision = ?`)
              .bind(
                canonicalJson(result),
                state,
                now,
                effect.organizationId,
                effect.effectId,
                row.action,
                row.revision,
              ),
          ])
          .then(() => undefined),
      ),
    )
    const adopted = yield* readPhysicalCommand(database, effect, row.action)
    if (adopted !== null && adopted.state === state) return adopted
    if (committed._tag === 'Failure') return yield* committed.failure
    return yield* failure('move-command-result-missing', 'physical command result did not persist')
  })

const executePhysicalCommand = (
  bindings: GameMoveNativeAdapterBindings,
  payload: GameWorkflowPayloadType,
  effect: GameMoveEffect,
  action: PhysicalAction,
  commandPayload: unknown,
): Effect.Effect<
  { readonly command: PhysicalCommand; readonly result: CommandResultType },
  GameWorkflowStepError
> =>
  Effect.gen(function* () {
    let row = yield* readPhysicalCommand(bindings.database, effect, action)
    let command: AgentCommandType
    if (row === null) {
      const materialized = yield* materializeCommand(
        bindings,
        payload,
        effect,
        action,
        commandPayload,
      )
      row = yield* persistCommand(
        bindings.database,
        effect,
        action,
        materialized.command,
        materialized.fingerprint,
      )
      command = yield* decodeStoredCommand(effect, action, row)
    } else {
      command = yield* decodeStoredCommand(effect, action, row)
    }
    if (row.state !== 'pending') {
      const result = yield* decodeStoredResult(effect, row)
      if (row.state !== 'succeeded' || result.status !== 'succeeded')
        return yield* failure(
          'move-physical-command-failed',
          `${action} previously reached a non-success terminal state`,
        )
      return { command: row, result }
    }
    const coordinator = bindings.nodeCoordinator.getByName(
      `${effect.organizationId}:${command.nodeId}`,
    )
    yield* Effect.tryPromise({
      try: () => coordinator.enqueue(command),
      catch: (cause) => failure('move-command-enqueue-failed', `${action}: ${String(cause)}`),
    })
    const rawResult = yield* Effect.tryPromise({
      try: () =>
        coordinator.waitForCommandResult(
          effect.organizationId,
          command.nodeId,
          command.commandId,
          30,
        ),
      catch: (cause) => failure('move-command-result-unavailable', `${action}: ${String(cause)}`),
    })
    if (rawResult === null)
      return yield* failure(
        'move-command-result-pending',
        `${action} has no durable terminal command result`,
      )
    const result = yield* Schema.decodeUnknownEffect(CommandResult, { onExcessProperty: 'error' })(
      rawResult,
    ).pipe(
      Effect.mapError(() =>
        failure('move-command-result-invalid', `${action} returned invalid terminal evidence`),
      ),
    )
    if (result.commandId !== command.commandId || result.operationId !== effect.operationId)
      return yield* failure(
        'move-command-result-scope-mismatch',
        `${action} returned foreign terminal evidence`,
      )
    row = yield* persistResult(bindings.database, effect, row, result)
    if (row.state !== 'succeeded' || result.status !== 'succeeded')
      return yield* failure(
        'move-physical-command-failed',
        `${action} did not complete successfully`,
      )
    return { command: row, result }
  })

const backupManifest = (backup: SucceededBackup) => ({
  apiVersion: 'backup.gridora.dev/v1alpha1' as const,
  backupId: backup.artifact.id,
  organizationId: backup.artifact.organizationId,
  serverId: backup.artifact.serverId,
  pluginId: backup.artifact.metadata.pluginId,
  pluginVersion: backup.artifact.metadata.pluginVersion,
  consistency: backup.artifact.metadata.consistency,
  createdAt: backup.artifact.createdAt,
  sha256: backup.artifact.checksum,
  files: backup.artifact.metadata.includes,
  diskBytes: 256 * 1024 ** 3,
})

const backupRestorePayload = (
  backup: SucceededBackup,
  phase: 'stage' | 'validate' | 'commit' | 'rollback',
  targetServerId: string,
) => ({
  manifest: backupManifest(backup),
  targetServerId,
  phase,
})

const moveDeploymentSpec = (
  payload: GameWorkflowPayloadType,
  effect: GameMoveEffect,
  nodeId: string,
) =>
  Schema.decodeUnknownEffect(DeploymentSpec, { onExcessProperty: 'error' })({
    apiVersion: 'agent.gridora.dev/v1alpha1',
    organizationId: payload.organizationId,
    nodeId,
    serverId: payload.serverId,
    deploymentId: effect.sourceDeploymentId,
    operationId: payload.operationId,
    revision: Math.max(1, (payload.expectedPriorRevision ?? 0) + 1),
    plugin: {
      id: payload.plugin.id,
      version: payload.plugin.version,
      apiVersion: 'gridora.plugin/v1alpha1',
    },
    image: payload.image,
    ports: payload.ports.map(({ protocol, containerPort, publicPort }) => ({
      host: publicPort,
      container: containerPort,
      protocol,
    })),
    mounts: [
      {
        source: `/var/lib/gridora/servers/${payload.serverId}/game`,
        target: '/opt/gridora/game',
        readOnly: false,
      },
      {
        source: `/var/lib/gridora/servers/${payload.serverId}/config`,
        target: '/opt/gridora/config',
        readOnly: true,
      },
      {
        source: `/var/lib/gridora/servers/${payload.serverId}/data`,
        target: '/opt/gridora/data',
        readOnly: false,
      },
      {
        source: `/var/lib/gridora/servers/${payload.serverId}/mods`,
        target: '/opt/gridora/mods',
        readOnly: false,
      },
      {
        source: `/var/lib/gridora/servers/${payload.serverId}/state`,
        target: '/opt/gridora/state',
        readOnly: false,
      },
    ],
    resources: { ...payload.resources, pids: 256 },
    expiresAt: payload.expiresAt,
  }).pipe(
    Effect.mapError(() =>
      failure('move-target-deployment-invalid', 'target deployment staging spec is invalid'),
    ),
  )

const commandSummary = (command: PhysicalCommand) => ({
  action: command.action,
  commandId: command.commandId,
  nodeId: command.nodeId,
  fingerprint: command.fingerprint,
  revision: command.revision,
})

const evidence = (
  effect: GameMoveEffect,
  phase: string,
  commands: readonly PhysicalCommand[],
  extra: Readonly<Record<string, unknown>> = {},
): GameMovePhysicalEvidence => ({
  effectId: effect.effectId,
  receipt: {
    phase,
    operationId: effect.operationId,
    source: effect.source,
    target: effect.target,
    sourceDeploymentId: effect.sourceDeploymentId,
    commands: commands.map(commandSummary),
    ...extra,
  },
})

const transferDns = (
  bindings: GameMoveNativeAdapterBindings,
  effect: GameMoveEffect,
  direction: 'forward' | 'rollback',
): Effect.Effect<readonly GameMoveDnsProviderReceipt[], GameWorkflowStepError> => {
  if (effect.dns === undefined) return Effect.succeed([])
  if (bindings.cloudflare === undefined)
    return Effect.fail(
      failure('move-dns-adapter-missing', 'immutable move DNS effect requires Cloudflare control'),
    )
  if (effect.dns.providerRecordId === undefined)
    return Effect.fail(
      failure(
        'move-dns-provider-id-missing',
        'immutable move DNS effect has no provider record identity',
      ),
    )
  const reverse = direction === 'rollback'
  return makeCloudflareControl(bindings.cloudflare)
    .transferDnsRecord({
      organizationId: effect.organizationId,
      zoneId: effect.dns.zoneId,
      name: effect.dns.hostname,
      type: effect.dns.recordType,
      // A game move retains the same server owner. The exact content changes
      // only after the target service has been staged and activated.
      expectedOwnerResourceId: effect.serverId,
      expectedContent: reverse ? effect.dns.targetTarget : effect.dns.sourceTarget,
      nextOwnerResourceId: effect.serverId,
      nextContent: reverse ? effect.dns.sourceTarget : effect.dns.targetTarget,
    })
    .pipe(
      Effect.mapError((error) => failure('move-dns-transfer-failed', error.message)),
      Effect.flatMap((result) =>
        result.recordId !== effect.dns!.providerRecordId
          ? Effect.fail(
              failure(
                'move-dns-provider-id-mismatch',
                'DNS transfer did not retain the immutable provider record identity',
              ),
            )
          : Effect.succeed([
              {
                recordId: effect.dns!.recordId,
                providerRecordId: result.recordId,
                providerResult: {
                  effectId: effect.effectId,
                  direction,
                  recordId: result.recordId,
                  disposition: result.disposition,
                },
              },
            ] satisfies readonly GameMoveDnsProviderReceipt[]),
      ),
    )
}

const withDnsEvidence = (
  value: GameMovePhysicalEvidence,
  dnsReceipts: readonly GameMoveDnsProviderReceipt[],
): GameMovePhysicalEvidence => ({
  ...value,
  ...(dnsReceipts.length === 0 ? {} : { dnsReceipts }),
})

/**
 * Production move adapter. It uses an immutable move effect for every
 * physical coordinate, stages target data without changing `deployments`,
 * and persists exact signed command/result evidence before the coordinator
 * may advance an authoritative lifecycle phase.
 */
export const makeNativeGameMoveBackupAdapter = (
  bindings: GameMoveNativeAdapterBindings,
): Effect.Effect<GameMoveBackupAdapter, GameWorkflowStepError> => {
  const control: BackupControlShape = {
    ...bindings.backupControl,
    create: (actor, input) =>
      bindings.backupControl
        .create(actor, input)
        .pipe(Effect.tap((reservation) => bindings.startBackupWorkflow(actor, reservation.job))),
  }
  return Effect.succeed({
    backupSource: (payload, effect) =>
      Effect.gen(function* () {
        const context = yield* internalActor(bindings.database, payload)
        const reservation = yield* control
          .create(context, {
            serverId: payload.serverId,
            idempotencyKey:
              payload.action === 'move'
                ? moveBackupKey(payload.operationId)
                : `game-lifecycle:${payload.operationId}:backup`,
            intent: {
              schemaVersion: 1,
              includes: ['config', 'data', 'mods', 'state'],
              expiresAt: null,
            },
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                'move-backup-reservation-failed',
                'native source backup could not be reserved',
              ),
            ),
          )
        const loaded = yield* readSucceededBackupByKey(bindings.database, payload)
        if (reservation.job.backupId !== loaded.artifact.id)
          return yield* failure(
            'move-backup-mismatch',
            'reserved backup id differs from durable source artifact',
          )
        if (effect === undefined)
          return { backupId: loaded.artifact.id, sourcePreserved: true as const }
        return {
          backupId: loaded.artifact.id,
          sourcePreserved: true as const,
          evidence: evidence(effect, 'backup', [], {
            backupJobId: loaded.job.id,
            backupOperationId: loaded.job.operationId,
            backupId: loaded.artifact.id,
            backupRevision: loaded.artifact.revision,
            backupChecksum: loaded.artifact.checksum,
          }),
        }
      }),
    restoreTarget: (payload, backupId, effect) =>
      Effect.gen(function* () {
        const accepted = yield* asMovePayload(payload)
        const backup = yield* readSucceededBackupByKey(bindings.database, accepted, backupId)
        let stage = yield* ensureStage(bindings.database, accepted, effect, backupId)
        if (stage.state === 'rolled_back')
          return yield* failure('move-stage-rolled-back', 'target staging was already rolled back')
        const command = yield* executePhysicalCommand(
          bindings,
          accepted,
          effect,
          'restore-stage',
          backupRestorePayload(backup, 'stage', accepted.serverId),
        )
        if (stage.state === 'prepared')
          stage = yield* advanceStage(bindings.database, effect, stage, 'staged')
        if (
          stage.state !== 'staged' &&
          stage.state !== 'validated' &&
          stage.state !== 'committed' &&
          stage.state !== 'active'
        )
          return yield* failure(
            'move-stage-transition-missing',
            'target restore stage did not become durable',
          )
        return {
          restored: true as const,
          evidence: evidence(effect, 'restore', [command.command], {
            stageId: stage.stageId,
            stageState: stage.state,
            authoritativeDeploymentRemains: effect.sourceDeploymentId,
          }),
        }
      }),
    verifyTarget: (payload, backupId, effect) =>
      Effect.gen(function* () {
        const accepted = yield* asMovePayload(payload)
        const backup = yield* readSucceededBackupByKey(bindings.database, accepted, backupId)
        let stage = yield* requireStage(bindings.database, effect, backupId, [
          'staged',
          'validated',
          'committed',
          'active',
        ])
        const command = yield* executePhysicalCommand(
          bindings,
          accepted,
          effect,
          'restore-validate',
          backupRestorePayload(backup, 'validate', accepted.serverId),
        )
        if (stage.state === 'staged')
          stage = yield* advanceStage(bindings.database, effect, stage, 'validated')
        if (stage.state !== 'validated' && stage.state !== 'committed' && stage.state !== 'active')
          return yield* failure(
            'move-stage-transition-missing',
            'target validation did not become durable',
          )
        return {
          validated: true as const,
          evidence: evidence(effect, 'validate', [command.command], {
            stageId: stage.stageId,
            stageState: stage.state,
            authoritativeDeploymentRemains: effect.sourceDeploymentId,
          }),
        }
      }),
    cutoverEndpoint: (payload, backupId, effect) =>
      Effect.gen(function* () {
        const accepted = yield* asMovePayload(payload)
        const backup = yield* readSucceededBackupByKey(bindings.database, accepted, backupId)
        let stage = yield* requireStage(bindings.database, effect, backupId, [
          'validated',
          'committed',
          'active',
        ])
        const commands: PhysicalCommand[] = []
        const restore = yield* executePhysicalCommand(
          bindings,
          accepted,
          effect,
          'restore-commit',
          backupRestorePayload(backup, 'commit', accepted.serverId),
        )
        commands.push(restore.command)
        if (stage.state === 'validated')
          stage = yield* advanceStage(bindings.database, effect, stage, 'committed')
        if (stage.state === 'committed') {
          const deployment = yield* moveDeploymentSpec(accepted, effect, effect.target.nodeId)
          const activated = yield* executePhysicalCommand(
            bindings,
            accepted,
            effect,
            'activate-target',
            deployment,
          )
          commands.push(activated.command)
          stage = yield* advanceStage(bindings.database, effect, stage, 'active')
        } else {
          const activated = yield* readPhysicalCommand(bindings.database, effect, 'activate-target')
          if (activated === null || activated.state !== 'succeeded')
            return yield* failure(
              'move-stage-activation-missing',
              'target stage is active without an exact activation command',
            )
          commands.push(activated)
        }
        const dnsReceipts = yield* transferDns(bindings, effect, 'forward')
        return {
          cutover: true as const,
          sourcePreserved: true as const,
          evidence: withDnsEvidence(
            evidence(effect, 'cutover', commands, {
              stageId: stage.stageId,
              stageState: stage.state,
            }),
            dnsReceipts,
          ),
        }
      }),
    releaseSource: (payload, backupId, effect) =>
      Effect.gen(function* () {
        const accepted = yield* asMovePayload(payload)
        yield* readSucceededBackupByKey(bindings.database, accepted, backupId)
        const removed = yield* executePhysicalCommand(
          bindings,
          accepted,
          effect,
          'release-source',
          { deploymentId: effect.sourceDeploymentId },
        )
        return {
          released: true as const,
          sourcePreserved: true as const,
          evidence: evidence(effect, 'release', [removed.command], { backupId }),
        }
      }),
    rollback: (payload, backupId, effect) =>
      Effect.gen(function* () {
        const accepted = yield* asMovePayload(payload)
        const backup = yield* readSucceededBackupByKey(bindings.database, accepted, backupId)
        const stage = yield* readStage(bindings.database, effect)
        const commands: PhysicalCommand[] = []
        const incomplete: string[] = []

        // Every compensating operation is attempted before we report an
        // incomplete rollback. In particular, a Cloudflare or target-cleanup
        // error must not prevent us from recreating and starting the source.
        // The exact failed command/result remains in D1 for a fenced retry;
        // D1 does not record `rolled_back` until all of these operations have
        // returned operation-bound success evidence.
        const sourceDeployment = yield* moveDeploymentSpec(accepted, effect, effect.source.nodeId)
        const applied = yield* Effect.result(
          executePhysicalCommand(
            bindings,
            accepted,
            effect,
            'rollback-source-deploy',
            sourceDeployment,
          ),
        )
        if (applied._tag === 'Success') commands.push(applied.success.command)
        else incomplete.push('source-deployment')
        const started = yield* Effect.result(
          executePhysicalCommand(bindings, accepted, effect, 'rollback-source-start', {
            deploymentId: effect.sourceDeploymentId,
          }),
        )
        if (started._tag === 'Success') commands.push(started.success.command)
        else incomplete.push('source-start')

        // A target deployment cannot exist before `restore-commit` has made
        // the stage durable. Removing it for an earlier restore/validation
        // failure is not a harmless status check: it can turn a recoverable
        // failed stage into a failed compensation. Data staging is still
        // always reversed below, including from the prepared state.
        if (stage !== null && (stage.state === 'committed' || stage.state === 'active')) {
          const target = yield* Effect.result(
            executePhysicalCommand(bindings, accepted, effect, 'rollback-target', {
              deploymentId: effect.sourceDeploymentId,
            }),
          )
          if (target._tag === 'Success') commands.push(target.success.command)
          else incomplete.push('target-deployment')
        }
        if (stage !== null && stage.state !== 'rolled_back') {
          const staged = yield* Effect.result(
            executePhysicalCommand(
              bindings,
              accepted,
              effect,
              'rollback-stage',
              backupRestorePayload(backup, 'rollback', accepted.serverId),
            ),
          )
          if (staged._tag === 'Success') commands.push(staged.success.command)
          else incomplete.push('target-stage')
        }

        // Reverse endpoint publication after the source has been restored so
        // a release-source failure cannot direct traffic at an unavailable
        // source. `transferDnsRecord` adopts the immutable source tuple when
        // a forward transfer never occurred and rejects foreign/mixed state.
        const dns = yield* Effect.result(transferDns(bindings, effect, 'rollback'))
        const dnsReceipts = dns._tag === 'Success' ? dns.success : []
        if (dns._tag === 'Failure') incomplete.push('dns')

        if (incomplete.length === 0 && stage !== null && stage.state !== 'rolled_back') {
          const advanced = yield* Effect.result(
            advanceStage(bindings.database, effect, stage, 'rolled_back'),
          )
          if (advanced._tag === 'Failure') incomplete.push('target-stage-evidence')
        }
        if (incomplete.length > 0)
          return yield* failure(
            'move-rollback-incomplete',
            `physical rollback is incomplete for ${incomplete.join(', ')}; immutable command evidence is retained for recovery`,
          )
        return {
          rolledBack: true as const,
          sourcePreserved: true as const,
          evidence: withDnsEvidence(
            evidence(effect, 'rollback', commands, {
              ...(stage === null ? {} : { stageId: stage.stageId }),
              backupId,
              sourceRestarted: true,
            }),
            dnsReceipts,
          ),
        }
      }),
  } satisfies GameMoveBackupAdapter)
}

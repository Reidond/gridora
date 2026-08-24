import { Effect, Schema } from 'effect'
import type { CloudflareApiShape } from '@gridora/cloudflare-control'
import {
  AgentCommand,
  CommandResult,
  canonicalJson,
  canonicalCommandPayload,
  type AgentCommand as AgentCommandType,
  type CommandResult as CommandResultType,
} from '@gridora/agent-protocol'
import {
  GameLifecycleD1Error,
  makeGameLifecycleCompletionD1Repository,
  makeGameLifecycleObservationD1Repository,
} from '@gridora/game-lifecycle-d1'
import type { GameLifecycleD1Database, GameLifecycleD1Statement } from '@gridora/game-lifecycle-d1'
import {
  executeGameWorkflowStep,
  GameObservation,
  GameWorkflowPayload,
  GameWorkflowStepError,
  GameWorkflowStepNames,
  makeSignedGameAgentCommand,
  type GameWorkflowStepName,
  type GameWorkflowStepResult,
} from '@gridora/game-lifecycle-execution'
import type { NodeCoordinatorDO } from '@gridora/realtime'

export interface GameLifecycleCommandBindings {
  readonly database: GameLifecycleD1Database
  readonly nodeCoordinator: DurableObjectNamespace<NodeCoordinatorDO>
  readonly signingKey: { readonly get: () => Promise<string> }
  readonly cloudflare?: CloudflareApiShape
  readonly dns?: GameDnsReceiptConfig
  /** Resolves one accepted server deployment's immutable authoritative DNS tuple. */
  readonly resolveDns?: (
    payload: typeof GameWorkflowPayload.Type,
  ) => Effect.Effect<GameDnsReceiptConfig, GameWorkflowStepError>
  readonly recordDns?: (
    payload: typeof GameWorkflowPayload.Type,
    step: Extract<GameWorkflowStepName, 'publish-endpoint' | 'delete-dns'>,
    providerResult: unknown,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  >
  /** Native backup Workflow adapter used by update/delete backup policy steps. */
  readonly backup?: GameMoveBackupAdapter['backupSource']
  readonly move?: (
    payload: typeof GameWorkflowPayload.Type,
    step: GameWorkflowStepName,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  >
}

export interface GameMoveDnsEffect {
  readonly recordId: string
  readonly zoneId: string
  readonly hostname: string
  readonly recordType: 'A' | 'AAAA'
  readonly providerRecordId?: string
  readonly sourceTarget: string
  readonly targetTarget: string
}

export interface GameMoveEffect {
  readonly effectId: string
  readonly organizationId: string
  readonly operationId: string
  readonly serverId: string
  readonly source: {
    readonly nodeId: string
    readonly providerInstanceId: string
    readonly endpointRevision?: number
  }
  readonly target: {
    readonly nodeId: string
    readonly providerInstanceId: string
    readonly endpointRevision?: number
  }
  readonly sourceDeploymentId: string
  readonly state: 'prepared' | 'cutover' | 'released' | 'rolled_back'
  readonly revision: number
  readonly snapshotJson: string
  readonly dns?: GameMoveDnsEffect
}

export interface GameMoveDnsProviderReceipt {
  readonly recordId: string
  readonly providerRecordId?: string
  readonly providerResult: unknown
}

export interface GameMovePhysicalEvidence {
  /** Must equal the D1-persisted deterministic effect id supplied to the adapter. */
  readonly effectId: string
  /** Bounded agent/data/backup evidence stored immutably for this physical phase. */
  readonly receipt: Readonly<Record<string, unknown>>
  /** Exact Cloudflare/provider results for every DNS record in the immutable effect. */
  readonly dnsReceipts?: readonly GameMoveDnsProviderReceipt[]
}

/**
 * Native move effects.  Every method receives the immutable effect snapshot,
 * so an adapter must use its coordinates rather than rereading mutable server
 * or node state.  `rollback` must reverse any staged agent/data and DNS
 * transfer before D1 is permitted to record the rollback.
 */
export interface GameMoveBackupAdapter {
  readonly backupSource: (
    payload: typeof GameWorkflowPayload.Type,
    effect?: GameMoveEffect,
  ) => Effect.Effect<
    {
      readonly backupId: string
      readonly sourcePreserved: true
      readonly evidence?: GameMovePhysicalEvidence
    },
    GameWorkflowStepError
  >
  readonly restoreTarget: (
    payload: typeof GameWorkflowPayload.Type,
    backupId: string,
    effect: GameMoveEffect,
  ) => Effect.Effect<
    { readonly restored: true; readonly evidence?: GameMovePhysicalEvidence },
    GameWorkflowStepError
  >
  readonly verifyTarget: (
    payload: typeof GameWorkflowPayload.Type,
    backupId: string,
    effect: GameMoveEffect,
  ) => Effect.Effect<
    { readonly validated: true; readonly evidence?: GameMovePhysicalEvidence },
    GameWorkflowStepError
  >
  readonly cutoverEndpoint: (
    payload: typeof GameWorkflowPayload.Type,
    backupId: string,
    effect: GameMoveEffect,
  ) => Effect.Effect<
    {
      readonly cutover: true
      readonly sourcePreserved: true
      readonly evidence?: GameMovePhysicalEvidence
    },
    GameWorkflowStepError
  >
  /** Physically retire/release the source only after the D1 cutover coordinates exist. */
  readonly releaseSource?: (
    payload: typeof GameWorkflowPayload.Type,
    backupId: string,
    effect: GameMoveEffect,
  ) => Effect.Effect<
    {
      readonly released: true
      readonly sourcePreserved: true
      readonly evidence?: GameMovePhysicalEvidence
    },
    GameWorkflowStepError
  >
  readonly rollback: (
    payload: typeof GameWorkflowPayload.Type,
    backupId: string,
    effect: GameMoveEffect,
  ) => Effect.Effect<
    {
      readonly rolledBack: true
      readonly sourcePreserved: true
      readonly evidence?: GameMovePhysicalEvidence
    },
    GameWorkflowStepError
  >
}

export interface GameMoveCoordinatorOptions {
  /** Required only when the accepted move has a DNS record to transfer. */
  readonly dnsZoneId?: string
}

const failure = (code: string, message: string) => new GameWorkflowStepError({ code, message })

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new GameLifecycleD1Error({ operation, message: String(cause) }),
  })

const rowObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined

const wholeNumber = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] : undefined

export interface GameDnsReceiptConfig {
  readonly zoneId: string
  readonly target: string
  readonly type: 'A' | 'AAAA'
  /** Required for teardown and sourced from the immutable publish receipt. */
  readonly providerRecordId?: string
}

const dnsConfigFailure = (code: string, message: string) =>
  new GameWorkflowStepError({ code, message })

/**
 * Resolves DNS only from the accepted deployment's immutable D1 authority.
 * A target is never taken from a Worker-wide binding or another server's row.
 */
export const makeGameDnsAuthorityResolver =
  (database: GameLifecycleD1Database, zoneId: string) =>
  (
    payload: typeof GameWorkflowPayload.Type,
  ): Effect.Effect<GameDnsReceiptConfig, GameWorkflowStepError> =>
    Effect.gen(function* () {
      if (payload.domain === undefined)
        return yield* dnsConfigFailure(
          'dns-authority-missing',
          'a domainless server has no DNS authority to resolve',
        )
      if (payload.action === 'create') {
        if (zoneId.length === 0)
          return yield* dnsConfigFailure(
            'dns-zone-missing',
            'DNS publication requires an explicit configured zone id',
          )
        const raw = yield* attempt('game-dns-authority.create.read', () =>
          database
            .prepare(`SELECT authority.hostname, authority.record_type AS recordType, authority.target,
          authority.deployment_id AS deploymentId, authority.node_id AS nodeId,
          authority.provider_instance_id AS providerInstanceId, authority.endpoint_revision AS endpointRevision
        FROM game_lifecycle_dns_authorities authority
        JOIN game_servers server
          ON server.organization_id = authority.organization_id AND server.id = authority.server_id
        JOIN deployments deployment
          ON deployment.organization_id = authority.organization_id AND deployment.id = authority.deployment_id
        JOIN nodes node
          ON node.organization_id = authority.organization_id AND node.id = authority.node_id
           AND node.provider_instance_id = authority.provider_instance_id
        JOIN node_player_endpoints endpoint
          ON endpoint.organization_id = authority.organization_id AND endpoint.node_id = authority.node_id
           AND endpoint.provider_instance_id = authority.provider_instance_id
           AND endpoint.record_type = authority.record_type AND endpoint.target = authority.target
           AND endpoint.revision = authority.endpoint_revision
        WHERE authority.organization_id = ? AND authority.operation_id = ? AND authority.server_id = ?
          AND authority.hostname = ? AND authority.deployment_id = ? AND authority.node_id = ?
          AND server.pending_lifecycle_operation_id = authority.operation_id
          AND deployment.server_id = authority.server_id AND deployment.node_id = authority.node_id
          AND node.desired_state = 'ready' AND node.observed_state = 'ready'`)
            .bind(
              payload.organizationId,
              payload.operationId,
              payload.serverId,
              payload.domain,
              payload.deploymentId,
              payload.nodeId,
            )
            .first(),
        )
        const row = rowObject(raw)
        const recordType = row === undefined ? undefined : text(row, 'recordType')
        const target = row === undefined ? undefined : text(row, 'target')
        if (
          (recordType !== 'A' && recordType !== 'AAAA') ||
          target === undefined ||
          target === 'pending'
        )
          return yield* dnsConfigFailure(
            'dns-authority-missing',
            'the accepted deployment has no exact authoritative player endpoint',
          )
        return { zoneId, type: recordType as 'A' | 'AAAA', target }
      }
      if (payload.action === 'delete') {
        const raw = yield* attempt('game-dns-authority.delete.read', () =>
          database
            .prepare(`SELECT receipt.zone_id AS zoneId, receipt.provider_record_id AS providerRecordId,
          record.target, receipt.record_type AS recordType
        FROM dns_records record
        JOIN game_servers server
          ON server.organization_id = record.organization_id AND server.id = record.server_id
        JOIN game_dns_lifecycle_receipts receipt
          ON receipt.organization_id = record.organization_id AND receipt.server_id = record.server_id
           AND receipt.action = 'publish' AND receipt.state = 'active'
           AND receipt.hostname = record.hostname AND receipt.target = record.target
           AND receipt.provider_record_id = record.provider_record_id
        WHERE record.organization_id = ? AND record.server_id = ? AND record.hostname = ?
          AND record.state IN ('pending', 'active', 'deleting')
          AND record.proxy_mode = 'dns_only'
          AND server.pending_lifecycle_operation_id = ?
        ORDER BY receipt.created_at DESC LIMIT 1`)
            .bind(payload.organizationId, payload.serverId, payload.domain, payload.operationId)
            .first(),
        )
        const row = rowObject(raw)
        const recordType = row === undefined ? undefined : text(row, 'recordType')
        const target = row === undefined ? undefined : text(row, 'target')
        const publishedZoneId = row === undefined ? undefined : text(row, 'zoneId')
        const publishedProviderRecordId =
          row === undefined ? undefined : text(row, 'providerRecordId')
        if (
          (recordType !== 'A' && recordType !== 'AAAA') ||
          target === undefined ||
          target === 'pending' ||
          publishedZoneId === undefined ||
          publishedZoneId.length === 0 ||
          publishedProviderRecordId === undefined ||
          publishedProviderRecordId.length === 0
        )
          return yield* dnsConfigFailure(
            'dns-authority-missing',
            'the delete operation has no exact published DNS authority',
          )
        // Delete uses the immutable publish receipt. An absent record in a later
        // configured zone is never evidence that the original record was deleted.
        return {
          zoneId: publishedZoneId,
          type: recordType as 'A' | 'AAAA',
          target,
          providerRecordId: publishedProviderRecordId,
        }
      }
      return yield* dnsConfigFailure(
        'dns-authority-action',
        'only create publication and delete teardown resolve DNS authority',
      )
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GameWorkflowStepError
          ? error
          : dnsConfigFailure('dns-authority-persistence', error.message),
      ),
    )

const providerRecordId = (value: unknown): string | undefined => {
  const object = rowObject(value)
  const result = object === undefined ? undefined : rowObject(object.result)
  return (
    (result === undefined ? undefined : text(result, 'id')) ??
    (object === undefined ? undefined : text(object, 'recordId'))
  )
}

/**
 * Persist Cloudflare's exact result together with the tenant DNS row.  The
 * receipt is deliberately written in the same D1 batch as the state change;
 * a retry after a lost response adopts the receipt and never reports a
 * provider-only side effect as a completed lifecycle step.
 */
export const makeGameDnsReceiptRecorder =
  (database: GameLifecycleD1Database, config: GameDnsReceiptConfig) =>
  (
    payload: typeof GameWorkflowPayload.Type,
    step: Extract<GameWorkflowStepName, 'publish-endpoint' | 'delete-dns'>,
    providerResult: unknown,
  ): Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  > =>
    Effect.gen(function* () {
      const action = step === 'publish-endpoint' ? 'publish' : 'delete'
      const existing = yield* attempt('game-dns-receipt.read', () =>
        database
          .prepare(`SELECT server_id AS serverId, zone_id AS zoneId, hostname, record_type AS recordType, target,
        provider_record_id AS providerRecordId, state, revision
      FROM game_dns_lifecycle_receipts
      WHERE organization_id = ? AND operation_id = ? AND action = ?`)
          .bind(payload.organizationId, payload.operationId, action)
          .first(),
      )
      const existingRow = existing === null ? undefined : rowObject(existing)
      if (existingRow !== undefined) {
        const hostname = text(existingRow, 'hostname')
        const existingServerId = text(existingRow, 'serverId')
        const existingZoneId = text(existingRow, 'zoneId')
        const recordType = text(existingRow, 'recordType')
        const target = text(existingRow, 'target')
        const existingProviderRecordId =
          existingRow.providerRecordId === null ? undefined : text(existingRow, 'providerRecordId')
        const state = text(existingRow, 'state')
        const revision = wholeNumber(existingRow, 'revision')
        if (
          hostname !== payload.domain ||
          existingServerId !== payload.serverId ||
          existingZoneId !== config.zoneId ||
          recordType !== config.type ||
          target !== config.target ||
          (action === 'delete' && existingProviderRecordId !== config.providerRecordId) ||
          revision === undefined ||
          state !== (action === 'publish' ? 'active' : 'deleted')
        )
          return yield* failure(
            'dns-receipt-mismatch',
            'persisted DNS receipt is not bound to this operation and endpoint',
          )
        return {
          organizationId: payload.organizationId,
          serverId: payload.serverId,
          operationId: payload.operationId,
          step,
          revision,
        }
      }
      if (payload.domain === undefined)
        return yield* failure(
          'dns-receipt-missing',
          'a DNS receipt requires an authoritative hostname',
        )
      const record = yield* attempt('game-dns-record.read', () =>
        database
          .prepare(`SELECT id, hostname, target, provider_record_id AS providerRecordId,
        state, revision
      FROM dns_records
      WHERE organization_id = ? AND server_id = ? AND hostname = ?
        AND EXISTS (
          SELECT 1 FROM game_servers server
          WHERE server.organization_id = dns_records.organization_id
            AND server.id = dns_records.server_id
            AND server.pending_lifecycle_operation_id = ?
        )`)
          .bind(payload.organizationId, payload.serverId, payload.domain, payload.operationId)
          .first(),
      )
      const recordRow = rowObject(record)
      if (recordRow === undefined)
        return yield* failure(
          'dns-row-missing',
          'the tenant DNS row is not pending for this operation',
        )
      const recordId = text(recordRow, 'id')
      const hostname = text(recordRow, 'hostname')
      const currentTarget = text(recordRow, 'target')
      const currentState = text(recordRow, 'state')
      const currentRevision = wholeNumber(recordRow, 'revision')
      const currentProviderRecordId =
        recordRow.providerRecordId === null ? undefined : text(recordRow, 'providerRecordId')
      if (
        recordId === undefined ||
        hostname !== payload.domain ||
        currentTarget === undefined ||
        currentState === undefined ||
        currentRevision === undefined ||
        (action === 'publish' && currentState !== 'pending' && currentState !== 'active') ||
        (action === 'delete' &&
          currentState !== 'pending' &&
          currentState !== 'active' &&
          currentState !== 'deleting')
      )
        return yield* failure(
          'dns-row-mismatch',
          'the tenant DNS row is not in an admissible state',
        )
      const target = config.target
      if (target === 'pending' || currentTarget !== target)
        return yield* failure(
          'dns-target-mismatch',
          'DNS receipt target is not the exact accepted authoritative endpoint',
        )
      if (
        action === 'delete' &&
        (config.providerRecordId === undefined ||
          currentProviderRecordId !== config.providerRecordId)
      )
        return yield* failure(
          'dns-provider-receipt-mismatch',
          'DNS teardown is not bound to the immutable published provider record',
        )
      const returnedProviderId = providerRecordId(providerResult)
      if (
        action === 'delete' &&
        returnedProviderId !== undefined &&
        returnedProviderId !== config.providerRecordId
      )
        return yield* failure(
          'dns-provider-receipt-mismatch',
          'Cloudflare teardown result is not the immutable published provider record',
        )
      const providerId =
        action === 'delete'
          ? config.providerRecordId
          : (returnedProviderId ?? currentProviderRecordId)
      if (action === 'publish' && providerId === undefined)
        return yield* failure(
          'dns-provider-receipt-missing',
          'Cloudflare did not return an exact DNS record id',
        )
      const nextState = action === 'publish' ? 'active' : 'deleted'
      const resultJson = providerResult === undefined ? 'null' : canonicalJson(providerResult)
      const receiptRevision = 1
      const updatedAt = new Date().toISOString()
      const update = database
        .prepare(`UPDATE dns_records
    SET provider_record_id = COALESCE(?, provider_record_id), target = ?, state = ?, revision = revision + 1
    WHERE organization_id = ? AND id = ? AND server_id = ? AND hostname = ?
      AND revision = ? AND state IN ('pending', 'active', 'deleting')`)
        .bind(
          providerId ?? null,
          target,
          nextState,
          payload.organizationId,
          recordId,
          payload.serverId,
          payload.domain,
          currentRevision,
        )
      const insert = database
        .prepare(`INSERT INTO game_dns_lifecycle_receipts
    (organization_id, operation_id, server_id, action, zone_id, hostname, record_type,
     target, provider_record_id, provider_result_json, state, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          payload.organizationId,
          payload.operationId,
          payload.serverId,
          action,
          config.zoneId,
          payload.domain,
          config.type,
          target,
          providerId ?? null,
          resultJson,
          nextState,
          receiptRevision,
          updatedAt,
          updatedAt,
        )
      const result = yield* Effect.result(
        attempt('game-dns-receipt.commit', () =>
          database.batch([update, insert]).then(() => undefined),
        ),
      )
      if (result._tag === 'Failure') {
        const adopted = yield* attempt('game-dns-receipt.adopt', () =>
          database
            .prepare(`SELECT zone_id AS zoneId, hostname, record_type AS recordType, target,
          provider_record_id AS providerRecordId, state, revision
        FROM game_dns_lifecycle_receipts
        WHERE organization_id = ? AND operation_id = ? AND action = ?`)
            .bind(payload.organizationId, payload.operationId, action)
            .first(),
        )
        const adoptedRow = adopted === null ? undefined : rowObject(adopted)
        if (
          adoptedRow === undefined ||
          text(adoptedRow, 'zoneId') !== config.zoneId ||
          text(adoptedRow, 'hostname') !== payload.domain ||
          text(adoptedRow, 'recordType') !== config.type ||
          text(adoptedRow, 'target') !== target ||
          (action === 'delete' &&
            text(adoptedRow, 'providerRecordId') !== config.providerRecordId) ||
          text(adoptedRow, 'state') !== nextState
        )
          return yield* result.failure
        return {
          organizationId: payload.organizationId,
          serverId: payload.serverId,
          operationId: payload.operationId,
          step,
          revision: wholeNumber(adoptedRow, 'revision') ?? receiptRevision,
        }
      }
      return {
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        operationId: payload.operationId,
        step,
        revision: receiptRevision,
      }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GameWorkflowStepError
          ? error
          : failure('persistence', error instanceof Error ? error.message : String(error)),
      ),
    )

/** Resolve and persist the exact same authority tuple used for the provider call. */
export const makeGameDnsAuthorityReceiptRecorder =
  (
    database: GameLifecycleD1Database,
    resolveDns: (
      payload: typeof GameWorkflowPayload.Type,
    ) => Effect.Effect<GameDnsReceiptConfig, GameWorkflowStepError>,
  ) =>
  (
    payload: typeof GameWorkflowPayload.Type,
    step: Extract<GameWorkflowStepName, 'publish-endpoint' | 'delete-dns'>,
    providerResult: unknown,
  ) =>
    resolveDns(payload).pipe(
      Effect.flatMap((config) =>
        makeGameDnsReceiptRecorder(database, config)(payload, step, providerResult),
      ),
    )

export const sha256Hex = (value: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: (cause) => failure('command-identity-failed', String(cause)),
  })

const pemBody = (pem: string): ArrayBuffer => {
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  if (encoded.length === 0) throw new Error('agent command signing key is empty')
  const decoded = atob(encoded)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length))
  for (const [index, character] of Array.from(decoded).entries())
    bytes[index] = character.charCodeAt(0)
  return bytes.buffer
}

export const commandSigner = (pem: string) =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey('pkcs8', pemBody(pem), { name: 'Ed25519' }, false, [
        'sign',
      ])
      return {
        sign: async (canonicalPayload: string) => {
          const signature = await crypto.subtle.sign(
            { name: 'Ed25519' },
            key,
            new TextEncoder().encode(canonicalPayload),
          )
          return btoa(String.fromCharCode(...new Uint8Array(signature)))
        },
      }
    },
    catch: (cause) => failure('command-signing-key-invalid', String(cause)),
  })

interface DeliveryRow {
  readonly commandId: string
  readonly fingerprint: string
  readonly state: 'pending' | 'delivered' | 'completed' | 'failed'
  readonly createdAt: string
  readonly commandJson?: string
  readonly resultJson?: string
}

const readDelivery = (
  database: GameLifecycleD1Database,
  organizationId: string,
  operationId: string,
  step: GameWorkflowStepName,
) =>
  attempt('game-command-delivery.read', () =>
    database
      .prepare(
        `SELECT command_id AS commandId, command_fingerprint AS fingerprint,
                state, command_json AS commandJson, result_json AS resultJson, created_at AS createdAt
         FROM game_command_deliveries
         WHERE organization_id = ? AND operation_id = ? AND step_name = ?`,
      )
      .bind(organizationId, operationId, step)
      .first(),
  ).pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null as DeliveryRow | null)
      const row = rowObject(value)
      const commandId = row === undefined ? undefined : text(row, 'commandId')
      const fingerprint = row === undefined ? undefined : text(row, 'fingerprint')
      const state = row === undefined ? undefined : text(row, 'state')
      const createdAt = row === undefined ? undefined : text(row, 'createdAt')
      const commandJson =
        row === undefined || row.commandJson === null ? undefined : text(row, 'commandJson')
      const resultJson =
        row === undefined
          ? undefined
          : row.resultJson === null
            ? undefined
            : text(row, 'resultJson')
      if (
        commandId === undefined ||
        fingerprint === undefined ||
        createdAt === undefined ||
        (state !== 'pending' &&
          state !== 'delivered' &&
          state !== 'completed' &&
          state !== 'failed') ||
        (row?.commandJson !== null &&
          row?.commandJson !== undefined &&
          commandJson === undefined) ||
        (row?.resultJson !== null && row?.resultJson !== undefined && resultJson === undefined)
      )
        return Effect.fail(
          new GameLifecycleD1Error({
            operation: 'game-command-delivery.decode',
            message: 'invalid command delivery row',
          }),
        )
      return Effect.succeed({
        commandId,
        fingerprint,
        state,
        createdAt,
        ...(commandJson === undefined ? {} : { commandJson }),
        ...(resultJson === undefined ? {} : { resultJson }),
      } satisfies DeliveryRow)
    }),
  )

const decodeResult = (resultJson: string, expectedCommandId: string, expectedOperationId: string) =>
  Effect.try({
    try: () => JSON.parse(resultJson) as unknown,
    catch: (cause) => failure('command-result-invalid', String(cause)),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CommandResult, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError((cause) => failure('command-result-invalid', String(cause))),
      ),
    ),
    Effect.flatMap((result) =>
      result.commandId !== expectedCommandId || result.operationId !== expectedOperationId
        ? Effect.fail(
            failure(
              'command-result-scope-mismatch',
              'command terminal result is not bound to this operation',
            ),
          )
        : Effect.succeed(result),
    ),
  )

type DispatchResult = {
  readonly commandId: string
  readonly operationId: string
  readonly step: GameWorkflowStepName
  readonly status: 'succeeded' | 'failed' | 'rejected'
  readonly delivery: 'executed' | 'adopted'
  readonly revision: number | null
}

const resultFor = (
  result: CommandResultType,
  delivery: 'executed' | 'adopted',
  step: GameWorkflowStepName,
): DispatchResult => ({
  commandId: result.commandId,
  operationId: result.operationId,
  step,
  status: result.status,
  delivery,
  revision: result.revision,
})

const updateDelivery = (
  database: GameLifecycleD1Database,
  row: DeliveryRow,
  organizationId: string,
  operationId: string,
  step: GameWorkflowStepName,
  state: 'delivered' | 'completed' | 'failed',
  resultJson?: string,
) =>
  attempt('game-command-delivery.update', () =>
    database
      .batch([
        database
          .prepare(
            `UPDATE game_command_deliveries
             SET state = ?, result_json = COALESCE(?, result_json), attempts = attempts + 1, updated_at = ?
             WHERE organization_id = ? AND operation_id = ? AND step_name = ?
               AND command_id = ? AND command_fingerprint = ?`,
          )
          .bind(
            state,
            resultJson ?? null,
            new Date().toISOString(),
            organizationId,
            operationId,
            step,
            row.commandId,
            row.fingerprint,
          ),
      ])
      .then(() => undefined),
  )

const dispatchCommand = (
  bindings: GameLifecycleCommandBindings,
  payload: typeof GameWorkflowPayload.Type,
  step: GameWorkflowStepName,
  commandSpec: { readonly type: string; readonly payload: unknown },
) =>
  Effect.gen(function* () {
    const identity = yield* sha256Hex(`${payload.operationId}:${step}`)
    const commandId = `gamecmd_${identity.slice(0, 48)}`
    const idempotencyKey = `gamecmd_${identity}`
    const existing = yield* readDelivery(
      bindings.database,
      payload.organizationId,
      payload.operationId,
      step,
    )
    // The first delivery timestamp is the durable command nonce. Reusing it
    // makes the signed envelope byte-identical after a response-loss retry;
    // resigning with a fresh timestamp would permanently fail the fingerprint
    // fence after an enqueue succeeded but its result was lost.
    const issuedAt = existing?.createdAt ?? new Date().toISOString()
    if (Date.parse(issuedAt) >= Date.parse(payload.expiresAt))
      return yield* failure('command-expired', 'the accepted Workflow payload has expired')
    if (existing !== null && existing.commandId !== commandId)
      return yield* failure(
        'command-identity-mismatch',
        'durable command delivery identity changed',
      )
    if (existing?.state === 'completed' || existing?.state === 'failed') {
      if (existing.resultJson === undefined)
        return yield* failure(
          'command-result-missing',
          'terminal command delivery has no result evidence',
        )
      const terminal = yield* decodeResult(existing.resultJson, commandId, payload.operationId)
      return resultFor(terminal, 'adopted', step)
    }

    let command: AgentCommandType
    if (existing === null) {
      const signingKey = yield* Effect.tryPromise({
        try: () => bindings.signingKey.get(),
        catch: (cause) => failure('command-signing-key-unavailable', String(cause)),
      })
      const signer = yield* commandSigner(signingKey)
      command = yield* makeSignedGameAgentCommand(payload, step, {
        commandId,
        issuedAt,
        expiresAt: payload.expiresAt,
        idempotencyKey,
        signer,
      })
    } else {
      if (existing.commandJson === undefined)
        return yield* failure(
          'command-envelope-missing',
          'the pending command has no persisted signed envelope',
        )
      const persistedCommandJson = existing.commandJson
      command = yield* Effect.try({
        try: () => JSON.parse(persistedCommandJson) as unknown,
        catch: (cause) => failure('command-envelope-invalid', String(cause)),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })(value).pipe(
            Effect.mapError((cause) => failure('command-envelope-invalid', String(cause))),
          ),
        ),
      )
    }
    if (
      command.commandId !== commandId ||
      command.operationId !== payload.operationId ||
      command.organizationId !== payload.organizationId ||
      command.nodeId !== payload.nodeId
    )
      return yield* failure(
        'command-envelope-scope-mismatch',
        'the persisted signed envelope is not bound to this operation',
      )
    if (command.type !== commandSpec.type)
      return yield* failure(
        'command-spec-mismatch',
        'materialized command does not match the Workflow step',
      )
    const commandFingerprint = yield* sha256Hex(canonicalCommandPayload(command))

    let delivery = existing
    if (delivery === null) {
      yield* Effect.result(
        attempt('game-command-delivery.insert', () =>
          bindings.database
            .batch([
              bindings.database
                .prepare(
                  `INSERT INTO game_command_deliveries
                   (organization_id, operation_id, command_id, step_name, command_fingerprint,
                    command_json, state, result_json, attempts, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?)`,
                )
                .bind(
                  payload.organizationId,
                  payload.operationId,
                  commandId,
                  step,
                  commandFingerprint,
                  canonicalJson(command),
                  issuedAt,
                  issuedAt,
                ),
            ])
            .then(() => undefined),
        ),
      )
      delivery = yield* readDelivery(
        bindings.database,
        payload.organizationId,
        payload.operationId,
        step,
      )
    }
    if (
      delivery === null ||
      delivery.commandId !== commandId ||
      delivery.fingerprint !== commandFingerprint
    )
      return yield* failure(
        'command-delivery-fence',
        'durable command delivery does not match the signed command',
      )

    const coordinator = bindings.nodeCoordinator.getByName(
      `${payload.organizationId}:${payload.nodeId}`,
    )
    yield* Effect.tryPromise({
      try: () => coordinator.enqueue(command),
      catch: (cause) => failure('command-enqueue-failed', String(cause)),
    })
    yield* updateDelivery(
      bindings.database,
      delivery,
      payload.organizationId,
      payload.operationId,
      step,
      'delivered',
    )
    const terminal = yield* Effect.tryPromise({
      try: () =>
        coordinator.waitForCommandResult(payload.organizationId, payload.nodeId, commandId, 30),
      catch: (cause) => failure('command-result-unavailable', String(cause)),
    })
    if (terminal === null)
      return yield* failure(
        'command-result-pending',
        'the agent has not produced a terminal command result',
      )
    const decoded = yield* Schema.decodeUnknownEffect(CommandResult, { onExcessProperty: 'error' })(
      terminal,
    ).pipe(Effect.mapError((cause) => failure('command-result-invalid', String(cause))))
    const state = decoded.status === 'succeeded' ? 'completed' : 'failed'
    yield* updateDelivery(
      bindings.database,
      delivery,
      payload.organizationId,
      payload.operationId,
      step,
      state,
      JSON.stringify(decoded),
    )
    return resultFor(decoded, 'executed', step)
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GameWorkflowStepError
        ? error
        : failure('persistence', error instanceof Error ? error.message : String(error)),
    ),
  )

const coordinate = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  step: Extract<
    GameWorkflowStepName,
    | 'reserve'
    | 'release-ports'
    | 'backup-if-required'
    | 'authorize-force-cleanup'
    | 'stop'
    | 'remove'
    | 'verify-observation'
  >,
  backup?: GameMoveBackupAdapter['backupSource'],
) =>
  Effect.gen(function* () {
    if (step === 'authorize-force-cleanup') {
      if (payload.forcedCleanup !== true)
        return {
          organizationId: payload.organizationId,
          serverId: payload.serverId,
          operationId: payload.operationId,
          step,
          revision: (payload.expectedPriorRevision ?? 0) + 1,
        }
      const existing = yield* attempt('game-lifecycle.force-cleanup.read', () =>
        database
          .prepare(`SELECT lifecycle_operation_id AS lifecycleOperationId,
            server_id AS serverId, state, revision
          FROM game_failed_node_cleanup_receipts
          WHERE organization_id = ? AND lifecycle_operation_id = ?`)
          .bind(payload.organizationId, payload.operationId)
          .first(),
      )
      const existingRow = rowObject(existing)
      if (existingRow !== undefined) {
        if (
          text(existingRow, 'lifecycleOperationId') !== payload.operationId ||
          text(existingRow, 'serverId') !== payload.serverId ||
          (text(existingRow, 'state') !== 'authorized' &&
            text(existingRow, 'state') !== 'completed')
        )
          return yield* failure(
            'forced-cleanup-receipt-mismatch',
            'the failed-node cleanup receipt is not bound to this server operation',
          )
        const revision = wholeNumber(existingRow, 'revision')
        if (revision === undefined)
          return yield* failure(
            'forced-cleanup-receipt-invalid',
            'the failed-node cleanup receipt has no valid revision',
          )
        return {
          organizationId: payload.organizationId,
          serverId: payload.serverId,
          operationId: payload.operationId,
          step,
          revision,
        }
      }
      const now = new Date().toISOString()
      yield* attempt('game-lifecycle.force-cleanup.authorize', () =>
        database
          .batch([
            database
              .prepare(`INSERT INTO game_failed_node_cleanup_receipts
            (organization_id, lifecycle_operation_id, server_id, deployment_id,
             node_id, node_lifecycle_operation_id, node_observed_revision,
             state, revision, authorized_at, completed_at)
            SELECT ?, ?, ?, deployment.id, deployment.node_id, lifecycle.operation_id,
              node.observed_revision, 'authorized', 1, ?, NULL
            FROM deployments deployment
            JOIN nodes node
              ON node.organization_id = deployment.organization_id
             AND node.id = deployment.node_id
            JOIN node_lifecycle_runs lifecycle
              ON lifecycle.organization_id = node.organization_id
             AND lifecycle.node_id = node.id
            JOIN node_lifecycle_affected_servers affected
              ON affected.organization_id = lifecycle.organization_id
             AND affected.operation_id = lifecycle.operation_id
             AND affected.server_id = deployment.server_id
             AND affected.deployment_id = deployment.id
            WHERE deployment.organization_id = ? AND deployment.server_id = ?
              AND deployment.node_id = ? AND deployment.observed_state <> 'deleted'
              AND node.observed_state = 'failed'
              AND lifecycle.action IN ('rebuild-node', 'retire-node')
              AND lifecycle.state NOT IN ('cancelled', 'completed')
              AND affected.state = 'pending'
            ORDER BY lifecycle.created_at DESC LIMIT 1`)
              .bind(
                payload.organizationId,
                payload.operationId,
                payload.serverId,
                now,
                payload.organizationId,
                payload.serverId,
                payload.nodeId,
              ),
          ])
          .then(() => undefined),
      )
      const authorized = yield* attempt('game-lifecycle.force-cleanup.verify', () =>
        database
          .prepare(`SELECT state, revision FROM game_failed_node_cleanup_receipts
          WHERE organization_id = ? AND lifecycle_operation_id = ? AND server_id = ?`)
          .bind(payload.organizationId, payload.operationId, payload.serverId)
          .first(),
      )
      const authorizedRow = rowObject(authorized)
      if (
        text(authorizedRow ?? {}, 'state') !== 'authorized' ||
        wholeNumber(authorizedRow ?? {}, 'revision') !== 1
      )
        return yield* failure(
          'forced-cleanup-authority-missing',
          'the server is not inventoried by an active rebuild/retire run for the failed node',
        )
      return {
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        operationId: payload.operationId,
        step,
        revision: 1,
      }
    }

    if (payload.forcedCleanup === true && (step === 'stop' || step === 'remove')) {
      const receipt = yield* attempt(`game-lifecycle.force-cleanup.${step}`, () =>
        database
          .prepare(`SELECT state, revision FROM game_failed_node_cleanup_receipts
          WHERE organization_id = ? AND lifecycle_operation_id = ? AND server_id = ?
            AND state IN ('authorized', 'completed')`)
          .bind(payload.organizationId, payload.operationId, payload.serverId)
          .first(),
      )
      const receiptRow = rowObject(receipt)
      const revision = receiptRow === undefined ? undefined : wholeNumber(receiptRow, 'revision')
      if (revision === undefined)
        return yield* failure(
          'forced-cleanup-authority-missing',
          `forced ${step} skip requires the exact failed-node cleanup receipt`,
        )
      return {
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        operationId: payload.operationId,
        step,
        revision,
      }
    }

    if (payload.forcedCleanup === true && step === 'verify-observation') {
      const receipt = yield* attempt('game-lifecycle.force-cleanup.finalize.read', () =>
        database
          .prepare(`SELECT receipt.state, receipt.revision,
            receipt.deployment_id AS deploymentId,
            receipt.node_id AS nodeId,
            receipt.node_lifecycle_operation_id AS nodeLifecycleOperationId,
            server.observed_revision AS serverObservedRevision
          FROM game_failed_node_cleanup_receipts receipt
          JOIN game_servers server
            ON server.organization_id = receipt.organization_id
           AND server.id = receipt.server_id
          WHERE receipt.organization_id = ? AND receipt.lifecycle_operation_id = ?
            AND receipt.server_id = ?`)
          .bind(payload.organizationId, payload.operationId, payload.serverId)
          .first(),
      )
      const receiptRow = rowObject(receipt)
      if (receiptRow === undefined)
        return yield* failure(
          'forced-cleanup-authority-missing',
          'forced cleanup finalization requires an authorization receipt',
        )
      const state = text(receiptRow, 'state')
      const revision = wholeNumber(receiptRow, 'revision')
      if (state === 'completed' && revision === 2)
        return {
          organizationId: payload.organizationId,
          serverId: payload.serverId,
          operationId: payload.operationId,
          step,
          revision,
        }
      const deploymentId = text(receiptRow, 'deploymentId')
      const nodeId = text(receiptRow, 'nodeId')
      const nodeLifecycleOperationId = text(receiptRow, 'nodeLifecycleOperationId')
      const serverObservedRevision = wholeNumber(receiptRow, 'serverObservedRevision')
      if (
        state !== 'authorized' ||
        revision !== 1 ||
        deploymentId === undefined ||
        nodeId !== payload.nodeId ||
        nodeLifecycleOperationId === undefined ||
        serverObservedRevision === undefined
      )
        return yield* failure(
          'forced-cleanup-receipt-invalid',
          'forced cleanup receipt coordinates are incomplete',
        )
      const liveResources = yield* attempt('game-lifecycle.force-cleanup.resources', () =>
        database
          .prepare(`SELECT
          (SELECT COUNT(*) FROM port_leases lease
            WHERE lease.organization_id = ? AND lease.server_id = ? AND lease.state <> 'released') AS livePorts,
          (SELECT COUNT(*) FROM dns_records dns
            WHERE dns.organization_id = ? AND dns.server_id = ? AND dns.state <> 'deleted') AS liveDns`)
          .bind(payload.organizationId, payload.serverId, payload.organizationId, payload.serverId)
          .first(),
      )
      const liveRow = rowObject(liveResources)
      if (liveRow?.livePorts !== 0 || liveRow?.liveDns !== 0)
        return yield* failure(
          'forced-cleanup-resources-live',
          'ports and DNS must be reconciled before forced cleanup completion',
        )
      const now = new Date().toISOString()
      const observationRevision = serverObservedRevision + 1
      yield* attempt('game-lifecycle.force-cleanup.finalize', () =>
        database
          .batch([
            database
              .prepare(`UPDATE deployments
            SET observed_state = 'deleted', observed_revision = observed_revision + 1,
                reconciliation_error = NULL, updated_at = ?
            WHERE organization_id = ? AND id = ? AND server_id = ? AND node_id = ?
              AND observed_state <> 'deleted'`)
              .bind(now, payload.organizationId, deploymentId, payload.serverId, nodeId),
            database
              .prepare(`UPDATE node_lifecycle_affected_servers
            SET state = 'deleted', resolved_at = ?
            WHERE organization_id = ? AND operation_id = ? AND server_id = ?
              AND deployment_id = ? AND state = 'pending'`)
              .bind(
                now,
                payload.organizationId,
                nodeLifecycleOperationId,
                payload.serverId,
                deploymentId,
              ),
            database
              .prepare(`INSERT INTO game_observation_reductions
            (organization_id, server_id, observed_revision, observed_state,
             operation_id, observation_json, observed_at)
            VALUES (?, ?, ?, 'deleted', ?, ?, ?)`)
              .bind(
                payload.organizationId,
                payload.serverId,
                observationRevision,
                payload.operationId,
                canonicalJson({
                  source: 'failed-node-forced-cleanup',
                  nodeId,
                  nodeLifecycleOperationId,
                }),
                now,
              ),
            database
              .prepare(`UPDATE game_failed_node_cleanup_receipts
            SET state = 'completed', revision = 2, completed_at = ?
            WHERE organization_id = ? AND lifecycle_operation_id = ?
              AND server_id = ? AND state = 'authorized' AND revision = 1`)
              .bind(now, payload.organizationId, payload.operationId, payload.serverId),
          ])
          .then(() => undefined),
      )
      const completed = yield* attempt('game-lifecycle.force-cleanup.finalize.verify', () =>
        database
          .prepare(`SELECT state, revision FROM game_failed_node_cleanup_receipts
          WHERE organization_id = ? AND lifecycle_operation_id = ? AND server_id = ?`)
          .bind(payload.organizationId, payload.operationId, payload.serverId)
          .first(),
      )
      if (
        text(rowObject(completed) ?? {}, 'state') !== 'completed' ||
        wholeNumber(rowObject(completed) ?? {}, 'revision') !== 2
      )
        return yield* failure(
          'forced-cleanup-completion-missing',
          'forced cleanup did not commit its exact terminal receipt',
        )
      return {
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        operationId: payload.operationId,
        step,
        revision: 2,
      }
    }

    if (step === 'reserve') {
      const row = yield* attempt('game-lifecycle.reserve.evidence', () =>
        database
          .prepare(
            `SELECT 1 AS verified
             FROM game_servers server
             JOIN server_capacity_reservations capacity
               ON capacity.organization_id = server.organization_id AND capacity.server_id = server.id
              AND capacity.operation_id = server.pending_lifecycle_operation_id AND capacity.state = 'reserved'
             WHERE server.organization_id = ? AND server.id = ? AND server.pending_lifecycle_operation_id = ?
               AND EXISTS (SELECT 1 FROM port_leases lease WHERE lease.organization_id = server.organization_id
                 AND lease.server_id = server.id AND lease.state <> 'released')`,
          )
          .bind(payload.organizationId, payload.serverId, payload.operationId)
          .first(),
      )
      if (rowObject(row)?.verified !== 1)
        return yield* failure(
          'reservation-evidence-missing',
          'capacity and exact port leases are not reserved for this operation',
        )
      return {
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        operationId: payload.operationId,
        step,
        revision: (payload.expectedPriorRevision ?? 0) + 1,
      }
    }
    if (step === 'backup-if-required') {
      const requiresBackup =
        payload.backupBeforeUpdate === true || payload.backupPolicy === 'required'
      if (!requiresBackup) {
        const skipped = yield* attempt('game-lifecycle.backup.skip-evidence', () =>
          database
            .prepare(`SELECT 1 AS verified
            FROM game_lifecycle_mutations mutation
            WHERE mutation.organization_id = ? AND mutation.operation_id = ?
              AND ((mutation.action = 'update' AND json_extract(mutation.result_json, '$.backupBeforeUpdate') = 0)
                OR (mutation.action = 'delete' AND json_extract(mutation.result_json, '$.backupPolicy') = 'skip-authorized'))`)
            .bind(payload.organizationId, payload.operationId)
            .first(),
        )
        if (rowObject(skipped)?.verified !== 1)
          return yield* failure(
            'backup-policy-evidence-missing',
            'the accepted lifecycle does not prove an authorized backup skip',
          )
        return {
          organizationId: payload.organizationId,
          serverId: payload.serverId,
          operationId: payload.operationId,
          step,
          revision: (payload.expectedPriorRevision ?? 0) + 1,
        }
      }
      if (backup === undefined)
        return yield* failure(
          'backup-evidence-missing',
          'this lifecycle request requires an available native backup Workflow',
        )
      const evidence = yield* backup(payload)
      if (evidence.sourcePreserved !== true || evidence.backupId.length === 0)
        return yield* failure(
          'backup-evidence-missing',
          'the native backup Workflow did not produce source-preservation evidence',
        )
      const idempotencyKey = `game-lifecycle:${payload.operationId}:backup`
      const receipt = yield* attempt('game-lifecycle.backup.receipt', () =>
        database
          .prepare(`SELECT backup_id AS backupId, state, revision
          FROM backup_jobs
          WHERE organization_id = ? AND idempotency_key = ? AND mode = 'create'`)
          .bind(payload.organizationId, idempotencyKey)
          .first(),
      )
      const receiptRow = rowObject(receipt)
      const backupId = receiptRow === undefined ? undefined : text(receiptRow, 'backupId')
      const state = receiptRow === undefined ? undefined : text(receiptRow, 'state')
      const revision = receiptRow === undefined ? undefined : wholeNumber(receiptRow, 'revision')
      if (backupId !== evidence.backupId || state !== 'succeeded' || revision === undefined)
        return yield* failure(
          'backup-receipt-missing',
          'the native backup Workflow receipt is not terminal or operation-bound',
        )
      return {
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        operationId: payload.operationId,
        step,
        revision,
      }
    }
    const evidence = yield* attempt('game-lifecycle.release-ports.evidence', () =>
      database
        .prepare(
          `SELECT 1 AS verified
           FROM game_servers server
           WHERE server.organization_id = ? AND server.id = ? AND server.pending_lifecycle_operation_id = ?
             AND (EXISTS (SELECT 1 FROM game_command_deliveries delivery
               WHERE delivery.organization_id = server.organization_id AND delivery.operation_id = ?
                 AND delivery.step_name = 'remove' AND delivery.state = 'completed')
               OR EXISTS (SELECT 1 FROM game_failed_node_cleanup_receipts receipt
                 WHERE receipt.organization_id = server.organization_id
                   AND receipt.lifecycle_operation_id = ? AND receipt.server_id = server.id
                   AND receipt.state IN ('authorized', 'completed')))`,
        )
        .bind(
          payload.organizationId,
          payload.serverId,
          payload.operationId,
          payload.operationId,
          payload.operationId,
        )
        .first(),
    )
    if (rowObject(evidence)?.verified !== 1)
      return yield* failure(
        'remove-evidence-missing',
        'ports cannot be released before the exact deployment removal result',
      )
    yield* attempt('game-lifecycle.release-ports', () =>
      database
        .batch([
          database
            .prepare(
              `UPDATE port_leases SET state = 'released'
               WHERE organization_id = ? AND server_id = ? AND state <> 'released'`,
            )
            .bind(payload.organizationId, payload.serverId),
        ])
        .then(() => undefined),
    )
    const remaining = yield* attempt('game-lifecycle.release-ports.verify', () =>
      database
        .prepare(
          `SELECT COUNT(*) AS remaining FROM port_leases
           WHERE organization_id = ? AND server_id = ? AND state <> 'released'`,
        )
        .bind(payload.organizationId, payload.serverId)
        .first(),
    )
    if (rowObject(remaining)?.remaining !== 0)
      return yield* failure('port-release-incomplete', 'one or more exact port leases remain live')
    return {
      organizationId: payload.organizationId,
      serverId: payload.serverId,
      operationId: payload.operationId,
      step,
      revision: (payload.expectedPriorRevision ?? 0) + 1,
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GameLifecycleD1Error ? failure('persistence', error.message) : error,
    ),
  )

type MovePhase = NonNullable<(typeof GameWorkflowPayload.Type)['movePhase']>
type MoveRow = {
  readonly phase: MovePhase
  readonly revision: number
  readonly backupId?: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly sourceDeploymentId: string
  readonly sourcePreserved: boolean
}

type MoveEffectPhase = 'backup' | 'restore' | 'validate' | 'cutover' | 'release' | 'rollback'

const moveEffectIdFor = (operationId: string) => `game-move-effect:${operationId}`

const readMoveEffect = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
): Effect.Effect<GameMoveEffect | null, GameLifecycleD1Error> =>
  attempt('game-lifecycle.move-effect.read', () =>
    database
      .prepare(`SELECT effect.effect_id AS effectId, effect.operation_id AS operationId,
        effect.server_id AS serverId, effect.source_node_id AS sourceNodeId,
        effect.target_node_id AS targetNodeId, effect.source_deployment_id AS sourceDeploymentId,
        effect.source_provider_instance_id AS sourceProviderInstanceId,
        effect.target_provider_instance_id AS targetProviderInstanceId,
        effect.source_endpoint_revision AS sourceEndpointRevision,
        effect.target_endpoint_revision AS targetEndpointRevision,
        effect.snapshot_json AS snapshotJson, effect.state, effect.revision,
        dns.record_id AS recordId, dns.zone_id AS zoneId, dns.hostname,
        dns.record_type AS recordType, dns.provider_record_id AS providerRecordId,
        dns.source_target AS sourceTarget, dns.target_target AS targetTarget
      FROM game_lifecycle_move_effects effect
      LEFT JOIN game_lifecycle_move_dns_effects dns
        ON dns.organization_id = effect.organization_id AND dns.effect_id = effect.effect_id
      WHERE effect.organization_id = ? AND effect.operation_id = ? AND effect.server_id = ?`)
      .bind(payload.organizationId, payload.operationId, payload.serverId)
      .first(),
  ).pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null)
      const row = rowObject(value)
      const effectId = row === undefined ? undefined : text(row, 'effectId')
      const operationId = row === undefined ? undefined : text(row, 'operationId')
      const serverId = row === undefined ? undefined : text(row, 'serverId')
      const sourceNodeId = row === undefined ? undefined : text(row, 'sourceNodeId')
      const targetNodeId = row === undefined ? undefined : text(row, 'targetNodeId')
      const sourceDeploymentId = row === undefined ? undefined : text(row, 'sourceDeploymentId')
      const sourceProviderInstanceId =
        row === undefined ? undefined : text(row, 'sourceProviderInstanceId')
      const targetProviderInstanceId =
        row === undefined ? undefined : text(row, 'targetProviderInstanceId')
      const snapshotJson = row === undefined ? undefined : text(row, 'snapshotJson')
      const state = row === undefined ? undefined : text(row, 'state')
      const revision = row === undefined ? undefined : wholeNumber(row, 'revision')
      const sourceEndpointRevision =
        row === undefined || row.sourceEndpointRevision === null
          ? undefined
          : wholeNumber(row, 'sourceEndpointRevision')
      const targetEndpointRevision =
        row === undefined || row.targetEndpointRevision === null
          ? undefined
          : wholeNumber(row, 'targetEndpointRevision')
      if (
        effectId !== moveEffectIdFor(payload.operationId) ||
        operationId !== payload.operationId ||
        serverId !== payload.serverId ||
        sourceNodeId === undefined ||
        targetNodeId === undefined ||
        sourceDeploymentId === undefined ||
        sourceProviderInstanceId === undefined ||
        targetProviderInstanceId === undefined ||
        snapshotJson === undefined ||
        (state !== 'prepared' &&
          state !== 'cutover' &&
          state !== 'released' &&
          state !== 'rolled_back') ||
        revision === undefined
      )
        return Effect.fail(
          new GameLifecycleD1Error({
            operation: 'game-lifecycle.move-effect.decode',
            message: 'move effect is missing immutable operation-bound coordinates',
          }),
        )
      const safeRow = row ?? {}
      const recordId = safeRow.recordId === null ? undefined : text(safeRow, 'recordId')
      const zoneId = safeRow.zoneId === null ? undefined : text(safeRow, 'zoneId')
      const hostname = safeRow.hostname === null ? undefined : text(safeRow, 'hostname')
      const recordType = safeRow.recordType === null ? undefined : text(safeRow, 'recordType')
      const providerRecordId =
        safeRow.providerRecordId === null ? undefined : text(safeRow, 'providerRecordId')
      const sourceTarget = safeRow.sourceTarget === null ? undefined : text(safeRow, 'sourceTarget')
      const targetTarget = safeRow.targetTarget === null ? undefined : text(safeRow, 'targetTarget')
      const dns =
        recordId === undefined
          ? undefined
          : zoneId === undefined ||
              hostname === undefined ||
              (recordType !== 'A' && recordType !== 'AAAA') ||
              sourceTarget === undefined ||
              targetTarget === undefined
            ? null
            : ({
                recordId,
                zoneId,
                hostname,
                recordType,
                ...(providerRecordId === undefined ? {} : { providerRecordId }),
                sourceTarget,
                targetTarget,
              } satisfies GameMoveDnsEffect)
      if (dns === null)
        return Effect.fail(
          new GameLifecycleD1Error({
            operation: 'game-lifecycle.move-effect.decode',
            message: 'move DNS effect is missing an exact record tuple',
          }),
        )
      return Effect.succeed({
        effectId,
        organizationId: payload.organizationId,
        operationId,
        serverId,
        source: {
          nodeId: sourceNodeId,
          providerInstanceId: sourceProviderInstanceId,
          ...(sourceEndpointRevision === undefined
            ? {}
            : { endpointRevision: sourceEndpointRevision }),
        },
        target: {
          nodeId: targetNodeId,
          providerInstanceId: targetProviderInstanceId,
          ...(targetEndpointRevision === undefined
            ? {}
            : { endpointRevision: targetEndpointRevision }),
        },
        sourceDeploymentId,
        state,
        revision,
        snapshotJson,
        ...(dns === undefined ? {} : { dns }),
      } satisfies GameMoveEffect)
    }),
  )

const createMoveEffect = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  options: GameMoveCoordinatorOptions,
): Effect.Effect<GameMoveEffect, GameLifecycleD1Error | GameWorkflowStepError> =>
  Effect.gen(function* () {
    const raw = yield* attempt('game-lifecycle.move-effect.snapshot.read', () =>
      database
        .prepare(`SELECT move.source_node_id AS sourceNodeId, move.target_node_id AS targetNodeId,
        move.source_deployment_id AS sourceDeploymentId,
        source.provider_instance_id AS sourceProviderInstanceId,
        target.provider_instance_id AS targetProviderInstanceId,
        server.domain, record.id AS recordId, record.hostname AS hostname,
        record.provider_record_id AS providerRecordId, record.target AS sourceTarget,
        published.record_type AS recordType,
        sourceEndpoint.revision AS sourceEndpointRevision,
        targetEndpoint.revision AS targetEndpointRevision,
        targetEndpoint.target AS targetTarget,
        COALESCE((SELECT json_group_array(json_object(
          'id', lease.id, 'protocol', lease.protocol, 'publicPort', lease.public_port,
          'containerPort', lease.container_port, 'nodeId', lease.node_id, 'state', lease.state
        )) FROM port_leases lease
          WHERE lease.organization_id = move.organization_id AND lease.server_id = move.server_id
            AND lease.state IN ('reserved', 'active')), '[]') AS portsJson
      FROM game_lifecycle_moves move
      JOIN game_servers server
        ON server.organization_id = move.organization_id AND server.id = move.server_id
      JOIN nodes source
        ON source.organization_id = move.organization_id AND source.id = move.source_node_id
      JOIN nodes target
        ON target.organization_id = move.organization_id AND target.id = move.target_node_id
      LEFT JOIN dns_records record
        ON record.organization_id = server.organization_id AND record.server_id = server.id
         AND record.hostname = server.domain AND record.state = 'active' AND record.proxy_mode = 'dns_only'
      LEFT JOIN game_dns_lifecycle_receipts published
        ON published.organization_id = record.organization_id AND published.server_id = record.server_id
         AND published.action = 'publish' AND published.state = 'active'
         AND published.hostname = record.hostname AND published.target = record.target
      LEFT JOIN node_player_endpoints sourceEndpoint
        ON sourceEndpoint.organization_id = source.organization_id AND sourceEndpoint.node_id = source.id
         AND sourceEndpoint.provider_instance_id = source.provider_instance_id
         AND sourceEndpoint.record_type = published.record_type
      LEFT JOIN node_player_endpoints targetEndpoint
        ON targetEndpoint.organization_id = target.organization_id AND targetEndpoint.node_id = target.id
         AND targetEndpoint.provider_instance_id = target.provider_instance_id
         AND targetEndpoint.record_type = sourceEndpoint.record_type
      WHERE move.organization_id = ? AND move.operation_id = ? AND move.server_id = ?
        AND move.phase = 'reserved'
        AND server.pending_lifecycle_operation_id = move.operation_id
        AND source.desired_state = 'ready' AND source.observed_state = 'ready'
        AND target.desired_state = 'ready' AND target.observed_state = 'ready'
      ORDER BY published.created_at DESC LIMIT 1`)
        .bind(payload.organizationId, payload.operationId, payload.serverId)
        .first(),
    )
    const row = rowObject(raw)
    const sourceNodeId = row === undefined ? undefined : text(row, 'sourceNodeId')
    const targetNodeId = row === undefined ? undefined : text(row, 'targetNodeId')
    const sourceDeploymentId = row === undefined ? undefined : text(row, 'sourceDeploymentId')
    const sourceProviderInstanceId =
      row === undefined ? undefined : text(row, 'sourceProviderInstanceId')
    const targetProviderInstanceId =
      row === undefined ? undefined : text(row, 'targetProviderInstanceId')
    if (
      sourceNodeId === undefined ||
      targetNodeId === undefined ||
      sourceDeploymentId === undefined ||
      sourceProviderInstanceId === undefined ||
      targetProviderInstanceId === undefined
    )
      return yield* failure(
        'move-effect-missing',
        'the accepted move no longer has exact source and target node/provider coordinates',
      )
    const domain =
      row?.domain === null ? undefined : row === undefined ? undefined : text(row, 'domain')
    const recordId =
      row?.recordId === null ? undefined : row === undefined ? undefined : text(row, 'recordId')
    const hostname =
      row?.hostname === null ? undefined : row === undefined ? undefined : text(row, 'hostname')
    const providerRecordId =
      row?.providerRecordId === null
        ? undefined
        : row === undefined
          ? undefined
          : text(row, 'providerRecordId')
    const recordType =
      row?.recordType === null ? undefined : row === undefined ? undefined : text(row, 'recordType')
    const sourceTarget =
      row?.sourceTarget === null
        ? undefined
        : row === undefined
          ? undefined
          : text(row, 'sourceTarget')
    const targetTarget =
      row?.targetTarget === null
        ? undefined
        : row === undefined
          ? undefined
          : text(row, 'targetTarget')
    const sourceEndpointRevision =
      row?.sourceEndpointRevision === null
        ? undefined
        : row === undefined
          ? undefined
          : wholeNumber(row, 'sourceEndpointRevision')
    const targetEndpointRevision =
      row?.targetEndpointRevision === null
        ? undefined
        : row === undefined
          ? undefined
          : wholeNumber(row, 'targetEndpointRevision')
    let ports: unknown = []
    const portsJson = row === undefined ? undefined : text(row, 'portsJson')
    try {
      ports = portsJson === undefined ? [] : (JSON.parse(portsJson) as unknown)
    } catch {
      return yield* failure(
        'move-effect-ports-invalid',
        'accepted move port snapshot is not valid JSON',
      )
    }
    const effectId = moveEffectIdFor(payload.operationId)
    const dns =
      domain === undefined
        ? undefined
        : (() => {
            if (
              options.dnsZoneId === undefined ||
              options.dnsZoneId.length === 0 ||
              recordId === undefined ||
              hostname !== domain ||
              providerRecordId === undefined ||
              (recordType !== 'A' && recordType !== 'AAAA') ||
              sourceTarget === undefined ||
              targetTarget === undefined ||
              sourceTarget === 'pending' ||
              targetTarget === 'pending' ||
              sourceEndpointRevision === undefined ||
              targetEndpointRevision === undefined
            )
              return undefined
            return {
              recordId,
              zoneId: options.dnsZoneId,
              hostname,
              recordType: recordType as 'A' | 'AAAA',
              providerRecordId,
              sourceTarget,
              targetTarget,
            } satisfies GameMoveDnsEffect
          })()
    if (domain !== undefined && dns === undefined)
      return yield* failure(
        'move-dns-authority-missing',
        'move DNS cutover requires exact source and target authoritative endpoint evidence',
      )
    const snapshotJson = canonicalJson({
      effectId,
      operationId: payload.operationId,
      serverId: payload.serverId,
      source: {
        nodeId: sourceNodeId,
        providerInstanceId: sourceProviderInstanceId,
        ...(sourceEndpointRevision === undefined
          ? {}
          : { endpointRevision: sourceEndpointRevision }),
      },
      target: {
        nodeId: targetNodeId,
        providerInstanceId: targetProviderInstanceId,
        ...(targetEndpointRevision === undefined
          ? {}
          : { endpointRevision: targetEndpointRevision }),
      },
      sourceDeploymentId,
      ports,
      ...(dns === undefined ? {} : { dns }),
    })
    const now = new Date().toISOString()
    const statements: GameLifecycleD1Statement[] = [
      database
        .prepare(`INSERT INTO game_lifecycle_move_effects
      (organization_id, operation_id, server_id, effect_id, source_node_id, target_node_id,
       source_deployment_id, source_provider_instance_id, target_provider_instance_id,
       source_endpoint_revision, target_endpoint_revision, dns_zone_id, dns_record_id,
       dns_hostname, dns_record_type, dns_provider_record_id, source_target, target_target,
       snapshot_json, state, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?)`)
        .bind(
          payload.organizationId,
          payload.operationId,
          payload.serverId,
          effectId,
          sourceNodeId,
          targetNodeId,
          sourceDeploymentId,
          sourceProviderInstanceId,
          targetProviderInstanceId,
          sourceEndpointRevision ?? null,
          targetEndpointRevision ?? null,
          dns?.zoneId ?? null,
          dns?.recordId ?? null,
          dns?.hostname ?? null,
          dns?.recordType ?? null,
          dns?.providerRecordId ?? null,
          dns?.sourceTarget ?? null,
          dns?.targetTarget ?? null,
          snapshotJson,
          now,
          now,
        ),
    ]
    if (dns !== undefined)
      statements.push(
        database
          .prepare(`INSERT INTO game_lifecycle_move_dns_effects
      (organization_id, effect_id, record_id, zone_id, hostname, record_type,
       provider_record_id, source_target, target_target, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            payload.organizationId,
            effectId,
            dns.recordId,
            dns.zoneId,
            dns.hostname,
            dns.recordType,
            dns.providerRecordId ?? null,
            dns.sourceTarget,
            dns.targetTarget,
            now,
          ),
      )
    const committed = yield* Effect.result(
      attempt('game-lifecycle.move-effect.prepare', () =>
        database.batch(statements).then(() => undefined),
      ),
    )
    const persisted = yield* readMoveEffect(database, payload)
    if (persisted !== null) return persisted
    if (committed._tag === 'Failure') return yield* committed.failure
    return yield* failure(
      'move-effect-missing',
      'move effect preparation did not persist immutable evidence',
    )
  })

const ensureMoveEffect = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  options: GameMoveCoordinatorOptions,
) =>
  readMoveEffect(database, payload).pipe(
    Effect.flatMap((existing) =>
      existing === null ? createMoveEffect(database, payload, options) : Effect.succeed(existing),
    ),
  )

const moveEffectReceiptStatements = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  effect: GameMoveEffect,
  phase: MoveEffectPhase,
  evidence: GameMovePhysicalEvidence | undefined,
): Effect.Effect<readonly GameLifecycleD1Statement[], GameWorkflowStepError> => {
  if (evidence === undefined || evidence.effectId !== effect.effectId)
    return Effect.fail(
      failure(
        'move-effect-evidence-missing',
        `move ${phase} did not return evidence for the immutable effect`,
      ),
    )
  const now = new Date().toISOString()
  const receiptJson = canonicalJson({ ...evidence.receipt, effectId: effect.effectId, phase })
  const statements: GameLifecycleD1Statement[] = [
    database
      .prepare(`INSERT INTO game_lifecycle_move_effect_receipts
      (organization_id, effect_id, phase, receipt_json, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(payload.organizationId, effect.effectId, phase, receiptJson, now),
  ]
  const expectsDnsReceipt = phase === 'cutover' || phase === 'rollback'
  const dnsReceipts = evidence.dnsReceipts ?? []
  if (!expectsDnsReceipt && dnsReceipts.length > 0)
    return Effect.fail(
      failure(
        'move-dns-evidence-unexpected',
        `move ${phase} returned DNS receipts outside a cutover/rollback`,
      ),
    )
  if (effect.dns === undefined) {
    if (dnsReceipts.length > 0)
      return Effect.fail(
        failure('move-dns-evidence-unexpected', 'a move without DNS has provider DNS receipts'),
      )
    return Effect.succeed(statements)
  }
  if (!expectsDnsReceipt) return Effect.succeed(statements)
  if (dnsReceipts.length !== 1 || dnsReceipts[0]?.recordId !== effect.dns.recordId)
    return Effect.fail(
      failure(
        'move-dns-evidence-missing',
        'move DNS cutover did not return the exact prepared record receipt',
      ),
    )
  const receipt = dnsReceipts[0]
  statements.push(
    database
      .prepare(`INSERT INTO game_lifecycle_move_dns_receipts
    (organization_id, effect_id, record_id, direction, provider_record_id, provider_result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        payload.organizationId,
        effect.effectId,
        effect.dns.recordId,
        phase === 'cutover' ? 'forward' : 'rollback',
        receipt.providerRecordId ?? null,
        canonicalJson(receipt.providerResult ?? null),
        now,
      ),
  )
  return Effect.succeed(statements)
}

const movePhaseRank: Readonly<Record<MovePhase, number>> = {
  reserved: 0,
  backup: 1,
  stopped: 2,
  restoring: 3,
  validated: 4,
  cutover: 5,
  released: 6,
  rolled_back: 7,
  failed: 8,
}

const readMove = (database: GameLifecycleD1Database, payload: typeof GameWorkflowPayload.Type) =>
  attempt('game-lifecycle.move.read', () =>
    database
      .prepare(`SELECT phase, revision, backup_id AS backupId,
      source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
      source_deployment_id AS sourceDeploymentId, source_preserved AS sourcePreserved
    FROM game_lifecycle_moves
    WHERE organization_id = ? AND operation_id = ? AND server_id = ?`)
      .bind(payload.organizationId, payload.operationId, payload.serverId)
      .first(),
  ).pipe(
    Effect.flatMap((value) => {
      const row = rowObject(value)
      const phase = row === undefined ? undefined : text(row, 'phase')
      const revision = row === undefined ? undefined : wholeNumber(row, 'revision')
      const sourceNodeId = row === undefined ? undefined : text(row, 'sourceNodeId')
      const targetNodeId = row === undefined ? undefined : text(row, 'targetNodeId')
      const sourceDeploymentId = row === undefined ? undefined : text(row, 'sourceDeploymentId')
      const sourcePreserved = row === undefined ? undefined : row.sourcePreserved === 1
      const backupId =
        row === undefined || row.backupId === null ? undefined : text(row, 'backupId')
      if (
        (phase !== 'reserved' &&
          phase !== 'backup' &&
          phase !== 'stopped' &&
          phase !== 'restoring' &&
          phase !== 'validated' &&
          phase !== 'cutover' &&
          phase !== 'released' &&
          phase !== 'rolled_back' &&
          phase !== 'failed') ||
        revision === undefined ||
        sourceNodeId === undefined ||
        targetNodeId === undefined ||
        sourceDeploymentId === undefined ||
        sourcePreserved === undefined
      )
        return Effect.fail(
          new GameLifecycleD1Error({
            operation: 'game-lifecycle.move.decode',
            message: 'move evidence row is missing or invalid',
          }),
        )
      return Effect.succeed({
        phase,
        revision,
        ...(backupId === undefined ? {} : { backupId }),
        sourceNodeId,
        targetNodeId,
        sourceDeploymentId,
        sourcePreserved,
      } satisfies MoveRow)
    }),
  )

const moveEvidence = (
  payload: typeof GameWorkflowPayload.Type,
  step: GameWorkflowStepName,
  row: MoveRow,
) => ({
  organizationId: payload.organizationId,
  serverId: payload.serverId,
  operationId: payload.operationId,
  step,
  revision: row.revision,
})

const advanceMove = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  row: MoveRow,
  nextPhase: MovePhase,
  backupId?: string,
  additional: readonly GameLifecycleD1Statement[] = [],
) =>
  Effect.gen(function* () {
    const updatedAt = new Date().toISOString()
    // A D1 response can be lost after its transaction commits. Re-read the
    // exact fenced phase before treating the call as failed so Workflow retry
    // adopts the immutable receipt rather than invoking the physical phase a
    // second time.
    const committed = yield* Effect.result(
      attempt('game-lifecycle.move.advance', () =>
        database
          .batch([
            ...additional,
            database
              .prepare(`UPDATE game_lifecycle_moves
        SET phase = ?, backup_id = COALESCE(?, backup_id), source_preserved = 1,
            revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND server_id = ?
          AND phase = ? AND revision = ?`)
              .bind(
                nextPhase,
                backupId ?? null,
                updatedAt,
                payload.organizationId,
                payload.operationId,
                payload.serverId,
                row.phase,
                row.revision,
              ),
          ])
          .then(() => undefined),
      ),
    )
    const after = yield* readMove(database, payload)
    if (after.phase !== nextPhase || after.revision !== row.revision + 1)
      if (committed._tag === 'Failure') return yield* committed.failure
      else
        return yield* failure(
          'move-transition-missing',
          'move phase transition did not commit its exact revision',
        )
    if (backupId !== undefined && after.backupId !== backupId)
      return yield* failure(
        'move-backup-mismatch',
        'move phase does not retain the exact backup id',
      )
    return after
  })

const cutoverMove = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  row: MoveRow,
  effect: GameMoveEffect,
  receipts: readonly GameLifecycleD1Statement[],
) =>
  Effect.gen(function* () {
    if (row.phase !== 'validated') return row
    const now = new Date().toISOString()
    const committed = yield* Effect.result(
      attempt('game-lifecycle.move.cutover', () =>
        database
          .batch([
            ...receipts,
            database
              .prepare(`UPDATE game_lifecycle_move_effects
        SET state = 'cutover', revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND effect_id = ?
          AND state = 'prepared' AND revision = ?`)
              .bind(
                now,
                payload.organizationId,
                payload.operationId,
                effect.effectId,
                effect.revision,
              ),
            database
              .prepare(`UPDATE deployments
        SET node_id = ?, observed_state = 'starting', updated_at = ?
        WHERE organization_id = ? AND id = ? AND server_id = ?
          AND node_id = ? AND (SELECT COUNT(*) FROM deployments exact
            WHERE exact.organization_id = ? AND exact.server_id = ?) = 1`)
              .bind(
                row.targetNodeId,
                now,
                payload.organizationId,
                row.sourceDeploymentId,
                payload.serverId,
                row.sourceNodeId,
                payload.organizationId,
                payload.serverId,
              ),
            database
              .prepare(`UPDATE server_capacity_reservations
        SET node_id = ?, state = 'active'
        WHERE organization_id = ? AND server_id = ? AND node_id = ?
          AND state IN ('reserved', 'active')`)
              .bind(row.targetNodeId, payload.organizationId, payload.serverId, row.sourceNodeId),
            database
              .prepare(`UPDATE port_leases
        SET node_id = ?
        WHERE organization_id = ? AND server_id = ? AND node_id = ?
          AND state IN ('reserved', 'active')`)
              .bind(row.targetNodeId, payload.organizationId, payload.serverId, row.sourceNodeId),
            database
              .prepare(`UPDATE game_lifecycle_move_reservations
        SET state = 'active', updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND server_id = ?
          AND source_node_id = ? AND target_node_id = ? AND state = 'reserved'`)
              .bind(
                now,
                payload.organizationId,
                payload.operationId,
                payload.serverId,
                row.sourceNodeId,
                row.targetNodeId,
              ),
            database
              .prepare(`UPDATE game_lifecycle_moves
        SET phase = 'cutover', source_preserved = 1, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND server_id = ?
          AND phase = 'validated' AND revision = ?`)
              .bind(
                now,
                payload.organizationId,
                payload.operationId,
                payload.serverId,
                row.revision,
              ),
          ])
          .then(() => undefined),
      ),
    )
    const after = yield* readMove(database, payload)
    const effectAfter = yield* readMoveEffect(database, payload)
    if (
      after.phase === 'cutover' &&
      after.revision === row.revision + 1 &&
      after.sourcePreserved &&
      effectAfter?.state === 'cutover' &&
      effectAfter.revision === effect.revision + 1
    )
      return after
    if (committed._tag === 'Failure') return yield* committed.failure
    if (effectAfter?.state !== 'cutover' || effectAfter.revision !== effect.revision + 1)
      return yield* failure(
        'move-effect-cutover-missing',
        'move cutover did not persist the immutable physical effect transition',
      )
    return yield* failure(
      'move-cutover-missing',
      'move cutover did not commit exact deployment, lease, and phase evidence',
    )
  })

const rollbackMove = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  row: MoveRow,
  effect: GameMoveEffect,
  receipts: readonly GameLifecycleD1Statement[],
) =>
  Effect.gen(function* () {
    const now = new Date().toISOString()
    const statements: GameLifecycleD1Statement[] = []
    if (row.phase === 'cutover') {
      statements.push(
        database
          .prepare(`UPDATE deployments
        SET node_id = ?, observed_state = 'starting', updated_at = ?
        WHERE organization_id = ? AND id = ? AND server_id = ? AND node_id = ?`)
          .bind(
            row.sourceNodeId,
            now,
            payload.organizationId,
            row.sourceDeploymentId,
            payload.serverId,
            row.targetNodeId,
          ),
        database
          .prepare(`UPDATE server_capacity_reservations
        SET node_id = ?, state = 'active'
        WHERE organization_id = ? AND server_id = ? AND node_id = ?
          AND state IN ('reserved', 'active')`)
          .bind(row.sourceNodeId, payload.organizationId, payload.serverId, row.targetNodeId),
        database
          .prepare(`UPDATE port_leases
        SET node_id = ?
        WHERE organization_id = ? AND server_id = ? AND node_id = ?
          AND state IN ('reserved', 'active')`)
          .bind(row.sourceNodeId, payload.organizationId, payload.serverId, row.targetNodeId),
      )
    }
    statements.push(
      ...receipts,
      database
        .prepare(`UPDATE game_lifecycle_move_effects
      SET state = 'rolled_back', revision = revision + 1, updated_at = ?
      WHERE organization_id = ? AND operation_id = ? AND effect_id = ?
        AND state IN ('prepared', 'cutover', 'released') AND revision = ?`)
        .bind(now, payload.organizationId, payload.operationId, effect.effectId, effect.revision),
      database
        .prepare(`UPDATE game_lifecycle_move_reservations
      SET state = 'rolled_back', updated_at = ?
      WHERE organization_id = ? AND operation_id = ? AND server_id = ?
        AND state IN ('reserved', 'active')`)
        .bind(now, payload.organizationId, payload.operationId, payload.serverId),
      database
        .prepare(`UPDATE game_lifecycle_moves
      SET phase = 'rolled_back', source_preserved = 1, revision = revision + 1, updated_at = ?
      WHERE organization_id = ? AND operation_id = ? AND server_id = ?
        AND phase = ? AND revision = ?`)
        .bind(
          now,
          payload.organizationId,
          payload.operationId,
          payload.serverId,
          row.phase,
          row.revision,
        ),
    )
    const committed = yield* Effect.result(
      attempt('game-lifecycle.move.rollback', () =>
        database.batch(statements).then(() => undefined),
      ),
    )
    const after = yield* readMove(database, payload)
    const effectAfter = yield* readMoveEffect(database, payload)
    if (
      after.phase === 'rolled_back' &&
      after.revision === row.revision + 1 &&
      after.sourcePreserved &&
      effectAfter?.state === 'rolled_back' &&
      effectAfter.revision === effect.revision + 1
    )
      return after
    if (committed._tag === 'Failure') return yield* committed.failure
    if (effectAfter?.state !== 'rolled_back' || effectAfter.revision !== effect.revision + 1)
      return yield* failure(
        'move-effect-rollback-missing',
        'move rollback did not persist the reverse physical effect',
      )
    return yield* failure(
      'move-rollback-missing',
      'move rollback did not restore the exact source coordinates',
    )
  })

const releaseMove = (
  database: GameLifecycleD1Database,
  payload: typeof GameWorkflowPayload.Type,
  row: MoveRow,
  effect: GameMoveEffect,
  receipts: readonly GameLifecycleD1Statement[],
) =>
  Effect.gen(function* () {
    if (row.phase !== 'cutover')
      return yield* failure(
        'move-phase-invalid',
        'source release requires a committed endpoint cutover',
      )
    const now = new Date().toISOString()
    const committed = yield* Effect.result(
      attempt('game-lifecycle.move.release', () =>
        database
          .batch([
            ...receipts,
            database
              .prepare(`UPDATE game_lifecycle_move_effects
        SET state = 'released', revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND effect_id = ?
          AND state = 'cutover' AND revision = ?`)
              .bind(
                now,
                payload.organizationId,
                payload.operationId,
                effect.effectId,
                effect.revision,
              ),
            database
              .prepare(`UPDATE game_lifecycle_move_reservations
        SET state = 'released', updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND server_id = ? AND state = 'active'`)
              .bind(now, payload.organizationId, payload.operationId, payload.serverId),
            database
              .prepare(`UPDATE game_lifecycle_moves
        SET phase = 'released', source_preserved = 1, revision = revision + 1, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND server_id = ?
          AND phase = 'cutover' AND revision = ?`)
              .bind(
                now,
                payload.organizationId,
                payload.operationId,
                payload.serverId,
                row.revision,
              ),
          ])
          .then(() => undefined),
      ),
    )
    const after = yield* readMove(database, payload)
    const effectAfter = yield* readMoveEffect(database, payload)
    if (
      after.phase !== 'released' ||
      after.revision !== row.revision + 1 ||
      effectAfter?.state !== 'released' ||
      effectAfter.revision !== effect.revision + 1
    )
      if (committed._tag === 'Failure') return yield* committed.failure
      else
        return yield* failure(
          'move-release-missing',
          'source release did not atomically persist the physical release evidence',
        )
    return after
  })

export const makeGameMoveCoordinator =
  (
    database: GameLifecycleD1Database,
    adapter: GameMoveBackupAdapter,
    options: GameMoveCoordinatorOptions = {},
  ) =>
  (
    payload: typeof GameWorkflowPayload.Type,
    step: GameWorkflowStepName,
  ): Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  > =>
    Effect.gen(function* () {
      if (payload.action !== 'move')
        return yield* failure(
          'move-action-mismatch',
          'move coordinator received a non-move payload',
        )
      const initial = yield* readMove(database, payload)
      const effect = yield* ensureMoveEffect(database, payload, options)
      if (step === 'reserve-target') return moveEvidence(payload, step, initial)
      if (step === 'backup-source') {
        if (movePhaseRank[initial.phase] >= movePhaseRank.backup)
          return moveEvidence(payload, step, initial)
        const evidence = yield* adapter.backupSource(payload, effect)
        if (evidence.sourcePreserved !== true || evidence.backupId.length === 0)
          return yield* failure(
            'backup-evidence-missing',
            'move backup did not prove source preservation',
          )
        const receipts = yield* moveEffectReceiptStatements(
          database,
          payload,
          effect,
          'backup',
          evidence.evidence,
        )
        return moveEvidence(
          payload,
          step,
          yield* advanceMove(database, payload, initial, 'backup', evidence.backupId, receipts),
        )
      }
      if (step === 'stop-source') {
        if (movePhaseRank[initial.phase] >= movePhaseRank.stopped)
          return moveEvidence(payload, step, initial)
        return moveEvidence(
          payload,
          step,
          yield* advanceMove(database, payload, initial, 'stopped'),
        )
      }
      if (step === 'restore-target') {
        if (movePhaseRank[initial.phase] >= movePhaseRank.restoring)
          return moveEvidence(payload, step, initial)
        if (initial.backupId === undefined)
          return yield* failure(
            'move-backup-missing',
            'restore requires the committed source backup id',
          )
        const evidence = yield* adapter.restoreTarget(payload, initial.backupId, effect)
        if (evidence.restored !== true)
          return yield* failure(
            'restore-evidence-missing',
            'target restore did not commit exact evidence',
          )
        const receipts = yield* moveEffectReceiptStatements(
          database,
          payload,
          effect,
          'restore',
          evidence.evidence,
        )
        return moveEvidence(
          payload,
          step,
          yield* advanceMove(database, payload, initial, 'restoring', undefined, receipts),
        )
      }
      if (step === 'verify-target') {
        if (movePhaseRank[initial.phase] >= movePhaseRank.validated)
          return moveEvidence(payload, step, initial)
        if (initial.backupId === undefined)
          return yield* failure(
            'move-backup-missing',
            'target verification requires the committed source backup id',
          )
        const evidence = yield* adapter.verifyTarget(payload, initial.backupId, effect)
        if (evidence.validated !== true)
          return yield* failure(
            'target-evidence-missing',
            'target restore has no exact validation evidence',
          )
        const receipts = yield* moveEffectReceiptStatements(
          database,
          payload,
          effect,
          'validate',
          evidence.evidence,
        )
        return moveEvidence(
          payload,
          step,
          yield* advanceMove(database, payload, initial, 'validated', undefined, receipts),
        )
      }
      if (step === 'cutover-endpoint') {
        if (movePhaseRank[initial.phase] >= movePhaseRank.cutover)
          return moveEvidence(payload, step, initial)
        if (initial.backupId === undefined)
          return yield* failure(
            'move-backup-missing',
            'endpoint cutover requires the committed source backup id',
          )
        const evidence = yield* adapter.cutoverEndpoint(payload, initial.backupId, effect)
        if (evidence.cutover !== true || evidence.sourcePreserved !== true)
          return yield* failure(
            'cutover-evidence-missing',
            'endpoint cutover did not prove source preservation',
          )
        const receipts = yield* moveEffectReceiptStatements(
          database,
          payload,
          effect,
          'cutover',
          evidence.evidence,
        )
        return moveEvidence(
          payload,
          step,
          yield* cutoverMove(database, payload, initial, effect, receipts),
        )
      }
      if (step === 'release-source') {
        if (initial.phase === 'released') {
          const reservation = yield* attempt('game-lifecycle.move.reservation.release.verify', () =>
            database
              .prepare(`SELECT state FROM game_lifecycle_move_reservations
          WHERE organization_id = ? AND operation_id = ? AND server_id = ?`)
              .bind(payload.organizationId, payload.operationId, payload.serverId)
              .first(),
          )
          if (
            text(rowObject(reservation) ?? {}, 'state') !== 'released' ||
            effect.state !== 'released'
          )
            return yield* failure(
              'move-reservation-release-missing',
              'target reservation release was not durably adopted',
            )
          return moveEvidence(payload, step, initial)
        }
        if (initial.phase !== 'cutover')
          return yield* failure(
            'move-phase-invalid',
            'source release requires a committed endpoint cutover',
          )
        if (adapter.releaseSource === undefined)
          return yield* failure(
            'move-release-adapter-missing',
            'source release requires an immutable physical release adapter',
          )
        if (initial.backupId === undefined)
          return yield* failure(
            'move-backup-missing',
            'source release requires the committed source backup id',
          )
        const evidence = yield* adapter.releaseSource(payload, initial.backupId, effect)
        if (evidence.released !== true || evidence.sourcePreserved !== true)
          return yield* failure(
            'release-evidence-missing',
            'source release did not prove the recoverable source snapshot',
          )
        const receipts = yield* moveEffectReceiptStatements(
          database,
          payload,
          effect,
          'release',
          evidence.evidence,
        )
        return moveEvidence(
          payload,
          step,
          yield* releaseMove(database, payload, initial, effect, receipts),
        )
      }
      if (step === 'rollback-if-required') {
        if (initial.phase === 'released' || initial.phase === 'rolled_back')
          return moveEvidence(payload, step, initial)
        if (initial.backupId === undefined)
          return yield* failure(
            'move-backup-missing',
            'rollback requires the committed source backup id',
          )
        const evidence = yield* adapter.rollback(payload, initial.backupId, effect)
        if (evidence.rolledBack !== true || evidence.sourcePreserved !== true)
          return yield* failure(
            'rollback-evidence-missing',
            'rollback did not prove source preservation',
          )
        const receipts = yield* moveEffectReceiptStatements(
          database,
          payload,
          effect,
          'rollback',
          evidence.evidence,
        )
        return moveEvidence(
          payload,
          step,
          yield* rollbackMove(database, payload, initial, effect, receipts),
        )
      }
      return yield* failure('move-step-invalid', `move coordinator cannot execute ${step}`)
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GameWorkflowStepError
          ? error
          : failure('move-persistence', error instanceof Error ? error.message : String(error)),
      ),
    )

const workflowStep = (
  payload: typeof GameWorkflowPayload.Type,
  step: string,
): GameWorkflowStepName | undefined => {
  const names = GameWorkflowStepNames[payload.action]
  return names.includes(step as never) ? (step as GameWorkflowStepName) : undefined
}

export const executeGameLifecycleWorkflowStep = (
  bindings: GameLifecycleCommandBindings,
  rawPayload: unknown,
  rawStep: string,
): Effect.Effect<GameWorkflowStepResult, GameWorkflowStepError | GameLifecycleD1Error> =>
  Schema.decodeUnknownEffect(GameWorkflowPayload, { onExcessProperty: 'error' })(rawPayload).pipe(
    Effect.mapError((cause) => failure('invalid-workflow-payload', String(cause))),
    Effect.flatMap((payload) =>
      Effect.gen(function* () {
        const step = workflowStep(payload, rawStep)
        if (step === undefined)
          return yield* Effect.fail(
            failure(
              'workflow-step-mismatch',
              'the signed Workflow step is not valid for this action',
            ),
          )
        const requiresDnsAuthority =
          payload.domain !== undefined && (step === 'publish-endpoint' || step === 'delete-dns')
        const resolvedDns = !requiresDnsAuthority
          ? bindings.dns
          : bindings.resolveDns === undefined
            ? bindings.dns
            : yield* bindings.resolveDns(payload)
        const observation = makeGameLifecycleObservationD1Repository(bindings.database)
        const completion = makeGameLifecycleCompletionD1Repository(bindings.database)
        const dependencies: Parameters<typeof executeGameWorkflowStep>[2] = {
          dispatch: (_payload, _step, command) => dispatchCommand(bindings, payload, step, command),
          coordinate: (coordinatePayload, coordinateStep) =>
            coordinate(bindings.database, coordinatePayload, coordinateStep, bindings.backup),
          readObservation: (observationPayload) =>
            observation
              .readObservation(
                observationPayload.organizationId,
                observationPayload.serverId,
                observationPayload.operationId,
              )
              .pipe(
                Effect.mapError((error) => failure('persistence', error.message)),
                Effect.flatMap((value) =>
                  Schema.decodeUnknownEffect(GameObservation, { onExcessProperty: 'error' })(
                    value,
                  ).pipe(Effect.mapError((cause) => failure('observation-invalid', String(cause)))),
                ),
              ),
          verifyNoDns: (noDnsPayload) =>
            observation
              .verifyNoDns(
                noDnsPayload.organizationId,
                noDnsPayload.serverId,
                noDnsPayload.operationId,
              )
              .pipe(Effect.mapError((error) => failure('persistence', error.message))),
          ...(bindings.cloudflare === undefined || resolvedDns === undefined
            ? {}
            : {
                cloudflare: bindings.cloudflare,
                dns: resolvedDns,
              }),
          ...(bindings.recordDns === undefined ? {} : { recordDns: bindings.recordDns }),
          ...(bindings.move === undefined ? {} : { move: bindings.move }),
          complete: (completionPayload, completionStep, evidence) =>
            completion
              .complete({
                organizationId: completionPayload.organizationId,
                lifecycleOperationId: completionPayload.operationId,
                serverId: completionPayload.serverId,
                action: completionPayload.action,
                stepName: completionStep,
                evidence,
                now: new Date().toISOString(),
              })
              .pipe(
                Effect.map((receipt) => ({
                  organizationId: receipt.organizationId,
                  serverId: receipt.serverId,
                  operationId: receipt.lifecycleOperationId,
                  step: receipt.stepName,
                  revision: receipt.revision,
                })),
                Effect.mapError((error) => failure('completion-persistence', error.message)),
              ),
        }
        return yield* executeGameWorkflowStep(payload, step, dependencies)
      }),
    ),
  )

export type GameAgentCommand = AgentCommandType

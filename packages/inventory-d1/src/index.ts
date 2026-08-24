import { Context, Effect, Layer, Schema } from 'effect'
import { NotFoundError, Operation, PersistenceError } from '@gridora/contracts'
import type { OrganizationContext } from '@gridora/domain'
import {
  AuditEventInventory,
  AuditEventView,
  BackupInventory,
  BackupView,
  GameServerInventory,
  GameServerView,
  InventoryPageRequest,
  NodeImageInventory,
  NodeImageView,
  NodeInventory,
  NodeView,
  ProviderAccountView,
  ProviderAllocationView,
  ProviderInventory,
  OperationInventory,
  type InventoryCursor,
  type InventoryPage,
} from '@gridora/inventory-contracts'

export interface InventoryD1AllResult {
  readonly results: ReadonlyArray<unknown>
}
export interface InventoryD1Statement {
  bind(...values: ReadonlyArray<unknown>): InventoryD1Statement
  first(): Promise<unknown>
  all(): Promise<InventoryD1AllResult>
}
export interface InventoryD1Database {
  prepare(sql: string): InventoryD1Statement
}
export class InventoryD1Client extends Context.Service<InventoryD1Client, InventoryD1Database>()(
  '@gridora/inventory-d1/InventoryD1Client',
) {}
export const InventoryD1ClientLayer = (database: InventoryD1Database) =>
  Layer.succeed(InventoryD1Client, database)

const persistence = (operation: string, cause: unknown) =>
  new PersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => persistence(operation, cause) })
const decode = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  row: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError((cause) => persistence(operation, cause)),
  )
const parseJsonFields = (row: unknown, fields: ReadonlyArray<string>): unknown => {
  if (typeof row !== 'object' || row === null) return row
  const parsed: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const field of fields) {
    const value = parsed[field]
    if (typeof value === 'string') parsed[field] = JSON.parse(value)
  }
  return parsed
}
const decodeParsed = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  fields: ReadonlyArray<string>,
  row: unknown,
) =>
  Effect.try({
    try: () => parseJsonFields(row, fields),
    catch: (cause) => persistence(operation, cause),
  }).pipe(Effect.flatMap((parsed) => decode(operation, schema, parsed)))

const pageWindow = (operation: string, request: InventoryPageRequest) =>
  Schema.decodeUnknownEffect(InventoryPageRequest)(request).pipe(
    Effect.mapError((cause) => persistence(operation, cause)),
    Effect.map((valid) => ({
      limit: valid.limit,
      offset: valid.cursor === undefined ? 0 : Number(valid.cursor.slice('offset:'.length)),
    })),
  )

const listRows = <A>(options: {
  readonly db: InventoryD1Database
  readonly operation: string
  readonly sql: string
  readonly context: OrganizationContext
  readonly page: InventoryPageRequest
  readonly schema: Schema.Codec<A, unknown, never, never>
  readonly jsonFields?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const window = yield* pageWindow(options.operation, options.page)
    const result = yield* attempt(options.operation, () =>
      options.db
        .prepare(options.sql)
        .bind(options.context.organizationId, window.limit + 1, window.offset)
        .all(),
    )
    const hasNext = result.results.length > window.limit
    const rows = result.results.slice(0, window.limit)
    const items = yield* Effect.forEach(rows, (row) =>
      decodeParsed(options.operation, options.schema, options.jsonFields ?? [], row),
    )
    return {
      items,
      ...(hasNext
        ? { nextCursor: `offset:${window.offset + window.limit}` as InventoryCursor }
        : {}),
    } satisfies InventoryPage<A>
  })

const getRow = <A>(options: {
  readonly db: InventoryD1Database
  readonly operation: string
  readonly resource: string
  readonly sql: string
  readonly context: OrganizationContext
  readonly id: string
  readonly schema: Schema.Codec<A, unknown, never, never>
  readonly jsonFields?: ReadonlyArray<string>
}): Effect.Effect<A, NotFoundError | PersistenceError> =>
  Effect.gen(function* () {
    const row = yield* attempt(options.operation, () =>
      options.db.prepare(options.sql).bind(options.context.organizationId, options.id).first(),
    )
    if (row === null) {
      return yield* new NotFoundError({ resource: options.resource, id: options.id })
    }
    return yield* decodeParsed(options.operation, options.schema, options.jsonFields ?? [], row)
  })

const providerSelect = `SELECT pa.id, pa.scope, pa.organization_id AS organizationId,
 pa.provider_type AS providerType, pa.status, pa.revision,
 (SELECT envelope.revision FROM secret_envelopes envelope
  WHERE envelope.organization_id = pa.organization_id
    AND envelope.id = pa.credential_reference
    AND envelope.scope_type = 'provider-account'
    AND envelope.scope_id = pa.id) AS credentialRevision,
 pa.created_at AS createdAt,
 pa.updated_at AS updatedAt FROM provider_accounts pa`
const providerScope = `(pa.organization_id = ? OR (pa.scope = 'platform' AND EXISTS (
 SELECT 1 FROM provider_allocations scoped
 WHERE scoped.organization_id = ? AND scoped.provider_account_id = pa.id)))`
const providerNotRemoved = `NOT EXISTS (
 SELECT 1 FROM provider_account_action_idempotency removed
 WHERE removed.organization_id = pa.organization_id
   AND removed.account_id = pa.id
   AND removed.action = 'remove'
   AND removed.finalized = 1
)`
const allocationSelect = `SELECT a.organization_id AS organizationId,
 a.provider_account_id AS providerAccountId, pa.provider_type AS providerType,
 pa.scope AS accountScope, a.allowed_regions_json AS allowedRegions,
 a.allowed_plans_json AS allowedPlans, a.max_active_nodes AS maxActiveNodes,
 a.monthly_budget_minor AS monthlyBudgetMinor, a.status, a.revision
 FROM provider_allocations a JOIN provider_accounts pa ON pa.id = a.provider_account_id`
const nodeImageSelect = `SELECT i.id, i.version, i.checksum, i.signature,
 i.provider_mappings_json AS providerMappings, i.status, i.created_at AS createdAt,
 i.promoted_at AS promotedAt FROM node_images i`
const nodeSelect = `SELECT organization_id AS organizationId, id,
 provider_account_id AS providerAccountId, provider_instance_id AS providerInstanceId,
 provider_type AS providerType, region, plan, image_id AS imageId,
 placement_mode AS placementMode, desired_state AS desiredState, observed_state AS observedState,
 desired_revision AS desiredRevision, observed_revision AS observedRevision,
 reconciliation_error AS reconciliationError, last_reconciled_at AS lastReconciledAt,
 created_at AS createdAt, updated_at AS updatedAt FROM nodes`
const serverSelect = `SELECT organization_id AS organizationId, id, name, plugin_id AS pluginId,
 plugin_version AS pluginVersion, desired_state AS desiredState, observed_state AS observedState,
 placement_policy_json AS placementPolicy, domain, desired_revision AS desiredRevision,
 observed_revision AS observedRevision, active_config_revision AS activeConfigRevision,
 reconciliation_error AS reconciliationError, last_reconciled_at AS lastReconciledAt,
 created_at AS createdAt, updated_at AS updatedAt FROM game_servers`
const backupSelect = `SELECT organization_id AS organizationId, id, server_id AS serverId,
 checksum, encryption_version AS encryptionVersion, metadata_json AS metadata, state,
 created_at AS createdAt, expires_at AS expiresAt FROM backups`
const auditSelect = `SELECT audit.id, audit.organization_id AS organizationId, audit.actor_id AS actorId,
 audit.action, audit.target_type AS targetType, audit.target_id AS targetId, audit.result,
 audit.correlation_id AS correlationId, audit.summary_json AS summary, audit.created_at AS createdAt,
 envelope.envelope_json AS envelope, envelope.schema_version AS schemaVersion,
 envelope.capture_status AS captureStatus
 FROM audit_events audit
 JOIN audit_event_envelopes envelope
   ON envelope.scope = 'tenant'
  AND envelope.event_id = audit.id
  AND envelope.organization_id = audit.organization_id`
const operationSelect = `SELECT id, organization_id AS organizationId, type,
 resource_type AS resourceType, resource_id AS resourceId, actor_id AS actorId, status, progress,
 idempotency_key AS idempotencyKey, correlation_id AS correlationId, revision,
 created_at AS createdAt, updated_at AS updatedAt FROM operations`

const ProviderInventoryLive = Layer.effect(
  ProviderInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return ProviderInventory.of({
      list: (context, page) =>
        Effect.gen(function* () {
          const window = yield* pageWindow('inventory.providers.list', page)
          const result = yield* attempt('inventory.providers.list', () =>
            db
              .prepare(
                `${providerSelect} WHERE ${providerScope} AND ${providerNotRemoved}
                 ORDER BY pa.created_at DESC, pa.id LIMIT ? OFFSET ?`,
              )
              .bind(context.organizationId, context.organizationId, window.limit + 1, window.offset)
              .all(),
          )
          const items = yield* Effect.forEach(result.results.slice(0, window.limit), (row) =>
            decode('inventory.providers.list', ProviderAccountView, row),
          )
          return {
            items,
            ...(result.results.length > window.limit
              ? { nextCursor: `offset:${window.offset + window.limit}` as InventoryCursor }
              : {}),
          }
        }),
      get: (context, id) =>
        Effect.gen(function* () {
          const row = yield* attempt('inventory.providers.get', () =>
            db
              .prepare(
                `${providerSelect} WHERE ${providerScope} AND ${providerNotRemoved} AND pa.id = ?`,
              )
              .bind(context.organizationId, context.organizationId, id)
              .first(),
          )
          if (row === null) return yield* new NotFoundError({ resource: 'providerAccount', id })
          return yield* decode('inventory.providers.get', ProviderAccountView, row)
        }),
      listAllocations: (context, page) =>
        listRows({
          db,
          operation: 'inventory.allocations.list',
          sql: `${allocationSelect} WHERE a.organization_id = ? ORDER BY a.provider_account_id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: ProviderAllocationView,
          jsonFields: ['allowedRegions', 'allowedPlans'],
        }),
      getAllocation: (context, id) =>
        getRow({
          db,
          operation: 'inventory.allocations.get',
          resource: 'providerAllocation',
          sql: `${allocationSelect} WHERE a.organization_id = ? AND a.provider_account_id = ?`,
          context,
          id,
          schema: ProviderAllocationView,
          jsonFields: ['allowedRegions', 'allowedPlans'],
        }),
    })
  }),
)

const NodeImageInventoryLive = Layer.effect(
  NodeImageInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return NodeImageInventory.of({
      list: (context, page) =>
        listRows({
          db,
          operation: 'inventory.nodeImages.list',
          sql: `${nodeImageSelect} WHERE EXISTS (SELECT 1 FROM organizations o WHERE o.id = ?)
            ORDER BY i.created_at DESC, i.id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: NodeImageView,
          jsonFields: ['providerMappings'],
        }),
      get: (context, id) =>
        getRow({
          db,
          operation: 'inventory.nodeImages.get',
          resource: 'nodeImage',
          sql: `${nodeImageSelect} WHERE EXISTS (SELECT 1 FROM organizations o WHERE o.id = ?) AND i.id = ?`,
          context,
          id,
          schema: NodeImageView,
          jsonFields: ['providerMappings'],
        }),
    })
  }),
)

const NodeInventoryLive = Layer.effect(
  NodeInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return NodeInventory.of({
      list: (context, page) =>
        listRows({
          db,
          operation: 'inventory.nodes.list',
          sql: `${nodeSelect} WHERE organization_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: NodeView,
        }),
      get: (context, id) =>
        getRow({
          db,
          operation: 'inventory.nodes.get',
          resource: 'node',
          sql: `${nodeSelect} WHERE organization_id = ? AND id = ?`,
          context,
          id,
          schema: NodeView,
        }),
    })
  }),
)
const GameServerInventoryLive = Layer.effect(
  GameServerInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return GameServerInventory.of({
      list: (context, page) =>
        listRows({
          db,
          operation: 'inventory.servers.list',
          sql: `${serverSelect} WHERE organization_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: GameServerView,
          jsonFields: ['placementPolicy'],
        }),
      get: (context, id) =>
        getRow({
          db,
          operation: 'inventory.servers.get',
          resource: 'gameServer',
          sql: `${serverSelect} WHERE organization_id = ? AND id = ?`,
          context,
          id,
          schema: GameServerView,
          jsonFields: ['placementPolicy'],
        }),
    })
  }),
)
const BackupInventoryLive = Layer.effect(
  BackupInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return BackupInventory.of({
      list: (context, page) =>
        listRows({
          db,
          operation: 'inventory.backups.list',
          sql: `${backupSelect} WHERE organization_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: BackupView,
          jsonFields: ['metadata'],
        }),
      get: (context, id) =>
        getRow({
          db,
          operation: 'inventory.backups.get',
          resource: 'backup',
          sql: `${backupSelect} WHERE organization_id = ? AND id = ?`,
          context,
          id,
          schema: BackupView,
          jsonFields: ['metadata'],
        }),
    })
  }),
)
const AuditEventInventoryLive = Layer.effect(
  AuditEventInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return AuditEventInventory.of({
      list: (context, page) =>
        listRows({
          db,
          operation: 'inventory.audit.list',
          sql: `${auditSelect} WHERE audit.organization_id = ?
            ORDER BY audit.created_at DESC, audit.id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: AuditEventView,
          jsonFields: ['summary', 'envelope'],
        }),
      get: (context, id) =>
        getRow({
          db,
          operation: 'inventory.audit.get',
          resource: 'auditEvent',
          sql: `${auditSelect} WHERE audit.organization_id = ? AND audit.id = ?`,
          context,
          id,
          schema: AuditEventView,
          jsonFields: ['summary', 'envelope'],
        }),
    })
  }),
)
const OperationInventoryLive = Layer.effect(
  OperationInventory,
  Effect.gen(function* () {
    const db = yield* InventoryD1Client
    return OperationInventory.of({
      list: (context, page) =>
        listRows({
          db,
          operation: 'inventory.operations.list',
          sql: `${operationSelect} WHERE organization_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
          context,
          page,
          schema: Operation,
        }),
      get: (context, id) =>
        getRow({
          db,
          operation: 'inventory.operations.get',
          resource: 'operation',
          sql: `${operationSelect} WHERE organization_id = ? AND id = ?`,
          context,
          id,
          schema: Operation,
        }),
    })
  }),
)

export const InventoryD1RepositoriesLive = Layer.mergeAll(
  ProviderInventoryLive,
  NodeImageInventoryLive,
  NodeInventoryLive,
  GameServerInventoryLive,
  BackupInventoryLive,
  AuditEventInventoryLive,
  OperationInventoryLive,
)
export const makeInventoryD1Layer = (database: InventoryD1Database) =>
  InventoryD1RepositoriesLive.pipe(Layer.provide(InventoryD1ClientLayer(database)))

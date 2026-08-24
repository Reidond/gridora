import { Context, type Effect, Schema } from 'effect'
import { AuditEnvelope } from '@gridora/audit-contracts'
import { type NotFoundError, Operation, type PersistenceError } from '@gridora/contracts'
import { IdentityId, IsoDateTime, type OrganizationContext, OrganizationId } from '@gridora/domain'

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
)
const revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const positiveRevision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const nonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const jsonObject = Schema.Record(Schema.String, Schema.Unknown)
const jsonStringArray = Schema.Array(Schema.String)

/** Offset cursors are opaque to HTTP consumers and validated again by the D1 adapter. */
export const InventoryCursor = Schema.String.check(Schema.isPattern(/^offset:[0-9]+$/))
export type InventoryCursor = typeof InventoryCursor.Type
export const InventoryPageLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
)
export type InventoryPageLimit = typeof InventoryPageLimit.Type

export class InventoryPageRequest extends Schema.Class<InventoryPageRequest>(
  'InventoryPageRequest',
)({
  limit: InventoryPageLimit,
  cursor: Schema.optional(InventoryCursor),
}) {}

export interface InventoryPage<A> {
  readonly items: ReadonlyArray<A>
  readonly nextCursor?: InventoryCursor
}

export const ProviderType = Schema.Literals(['ovhcloud', 'contabo'])
export const ProviderAccountScope = Schema.Literals(['platform', 'organization'])
export class ProviderAccountView extends Schema.Class<ProviderAccountView>('ProviderAccountView')({
  id: identifier,
  scope: ProviderAccountScope,
  organizationId: Schema.NullOr(OrganizationId),
  providerType: ProviderType,
  status: Schema.Literals(['active', 'disabled', 'error']),
  revision: positiveRevision,
  credentialRevision: Schema.NullOr(positiveRevision),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}) {}

export class ProviderAllocationView extends Schema.Class<ProviderAllocationView>(
  'ProviderAllocationView',
)({
  organizationId: OrganizationId,
  providerAccountId: identifier,
  providerType: ProviderType,
  accountScope: ProviderAccountScope,
  allowedRegions: jsonStringArray,
  allowedPlans: jsonStringArray,
  maxActiveNodes: nonNegativeInteger,
  monthlyBudgetMinor: Schema.NullOr(nonNegativeInteger),
  status: Schema.Literals(['active', 'disabled']),
  revision: positiveRevision,
}) {}

export class NodeImageView extends Schema.Class<NodeImageView>('NodeImageView')({
  id: identifier,
  version: Schema.String,
  checksum: Schema.String,
  signature: Schema.String,
  providerMappings: jsonObject,
  status: Schema.Literals(['building', 'candidate', 'promoted', 'retired', 'failed']),
  createdAt: IsoDateTime,
  promotedAt: Schema.NullOr(IsoDateTime),
}) {}

export class NodeView extends Schema.Class<NodeView>('NodeView')({
  organizationId: OrganizationId,
  id: identifier,
  providerAccountId: identifier,
  providerInstanceId: Schema.NullOr(Schema.String),
  providerType: ProviderType,
  region: Schema.String,
  plan: Schema.String,
  imageId: identifier,
  placementMode: Schema.Literals(['dedicated', 'shared']),
  desiredState: Schema.Literals(['provisioning', 'ready', 'draining', 'stopped', 'deleted']),
  observedState: Schema.Literals([
    'unknown',
    'provisioning',
    'bootstrapping',
    'ready',
    'degraded',
    'offline',
    'deleting',
    'deleted',
    'failed',
  ]),
  desiredRevision: positiveRevision,
  observedRevision: revision,
  reconciliationError: Schema.NullOr(Schema.String),
  lastReconciledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}) {}

export class GameServerView extends Schema.Class<GameServerView>('GameServerView')({
  organizationId: OrganizationId,
  id: identifier,
  name: Schema.String,
  pluginId: identifier,
  pluginVersion: Schema.String,
  desiredState: Schema.Literals(['running', 'stopped', 'deleted']),
  observedState: Schema.Literals([
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
  ]),
  placementPolicy: jsonObject,
  domain: Schema.NullOr(Schema.String),
  desiredRevision: positiveRevision,
  observedRevision: revision,
  activeConfigRevision: positiveRevision,
  reconciliationError: Schema.NullOr(Schema.String),
  lastReconciledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}) {}

export class BackupView extends Schema.Class<BackupView>('BackupView')({
  organizationId: OrganizationId,
  id: identifier,
  serverId: identifier,
  checksum: Schema.String,
  encryptionVersion: positiveRevision,
  metadata: jsonObject,
  state: Schema.Literals(['creating', 'available', 'restoring', 'expired', 'deleted', 'failed']),
  createdAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
}) {}

export class AuditEventView extends Schema.Class<AuditEventView>('AuditEventView')({
  id: identifier,
  organizationId: OrganizationId,
  actorId: IdentityId,
  action: Schema.String,
  targetType: Schema.String,
  targetId: Schema.String,
  result: Schema.Literals(['succeeded', 'denied', 'failed']),
  correlationId: Schema.String,
  summary: jsonObject,
  createdAt: IsoDateTime,
  /** Full immutable evidence; v0 rows remain visibly `legacy`. */
  envelope: AuditEnvelope,
  schemaVersion: Schema.Literals([0, 1] as const),
  captureStatus: Schema.Literals(['legacy', 'complete'] as const),
}) {}

type ReadError = NotFoundError | PersistenceError
interface ReadInventoryShape<A> {
  readonly list: (
    context: OrganizationContext,
    page: InventoryPageRequest,
  ) => Effect.Effect<InventoryPage<A>, PersistenceError>
  readonly get: (context: OrganizationContext, id: string) => Effect.Effect<A, ReadError>
}

export interface ProviderInventoryShape extends ReadInventoryShape<ProviderAccountView> {
  readonly listAllocations: (
    context: OrganizationContext,
    page: InventoryPageRequest,
  ) => Effect.Effect<InventoryPage<ProviderAllocationView>, PersistenceError>
  readonly getAllocation: (
    context: OrganizationContext,
    providerAccountId: string,
  ) => Effect.Effect<ProviderAllocationView, ReadError>
}
export class ProviderInventory extends Context.Service<ProviderInventory, ProviderInventoryShape>()(
  '@gridora/inventory-contracts/ProviderInventory',
) {}
export class NodeImageInventory extends Context.Service<
  NodeImageInventory,
  ReadInventoryShape<NodeImageView>
>()('@gridora/inventory-contracts/NodeImageInventory') {}
export class NodeInventory extends Context.Service<NodeInventory, ReadInventoryShape<NodeView>>()(
  '@gridora/inventory-contracts/NodeInventory',
) {}
export class GameServerInventory extends Context.Service<
  GameServerInventory,
  ReadInventoryShape<GameServerView>
>()('@gridora/inventory-contracts/GameServerInventory') {}
export class BackupInventory extends Context.Service<
  BackupInventory,
  ReadInventoryShape<BackupView>
>()('@gridora/inventory-contracts/BackupInventory') {}
export class AuditEventInventory extends Context.Service<
  AuditEventInventory,
  ReadInventoryShape<AuditEventView>
>()('@gridora/inventory-contracts/AuditEventInventory') {}
export class OperationInventory extends Context.Service<
  OperationInventory,
  ReadInventoryShape<Operation>
>()('@gridora/inventory-contracts/OperationInventory') {}

import { Context, Effect, Layer, Schema } from 'effect'
import { decodeOrganizationPolicy, type OrganizationUsage } from '@gridora/policy-control'
import {
  PluginPlanContractSchema,
  ServerPlanConcurrencyError,
  ServerPlanFactsUnavailableError,
  ServerPlanIdempotencyConflictError,
  ServerPlanPersistenceError,
  ServerPlanRepository,
  ServerPlanDecisionSchema,
  type Architecture,
  type ExistingPortLease,
  type ServerCreateAcceptance,
  type ServerNodeCandidate,
  type ServerPlanFacts,
  type ServerPlanRepositoryShape,
} from '@gridora/server-plan-control'

export interface ServerPlanD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface ServerPlanD1Statement {
  bind(...values: ReadonlyArray<unknown>): ServerPlanD1Statement
  first(): Promise<unknown>
  all(): Promise<ServerPlanD1Result>
}
export interface ServerPlanD1Database {
  prepare(sql: string): ServerPlanD1Statement
  /** Cloudflare D1 batches execute transactionally in statement order. */
  batch(
    statements: ReadonlyArray<ServerPlanD1Statement>,
  ): Promise<ReadonlyArray<ServerPlanD1Result>>
}
export class ServerPlanD1Client extends Context.Service<ServerPlanD1Client, ServerPlanD1Database>()(
  '@gridora/server-plan-d1/ServerPlanD1Client',
) {}
export const ServerPlanD1ClientLayer = (database: ServerPlanD1Database) =>
  Layer.succeed(ServerPlanD1Client, database)

/**
 * Exact additive migration required by this package. It is exported because this bounded package is
 * intentionally not allowed to modify the shared numbered migration sequence.
 */
export const serverPlanSchemaSql = `
CREATE TABLE server_plugin_channels (
  plugin_id TEXT PRIMARY KEY NOT NULL,
  active_version TEXT NOT NULL,
  plan_contract_json TEXT NOT NULL CHECK (json_valid(plan_contract_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (plugin_id, active_version)
    REFERENCES game_plugins(id, version) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER server_plugin_channel_revision_fence
BEFORE UPDATE ON server_plugin_channels
WHEN NEW.plugin_id IS NOT OLD.plugin_id OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'server plugin channel revision fence failed');
END;

CREATE TABLE node_runtime_capacity (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture IN ('amd64', 'arm64')),
  cpu_millis INTEGER NOT NULL CHECK (cpu_millis > 0),
  ram_bytes INTEGER NOT NULL CHECK (ram_bytes > 0),
  disk_bytes INTEGER NOT NULL CHECK (disk_bytes > 0),
  agent_ready INTEGER NOT NULL CHECK (agent_ready IN (0, 1)),
  tunnel_ready INTEGER NOT NULL CHECK (tunnel_ready IN (0, 1)),
  docker_ready INTEGER NOT NULL CHECK (docker_ready IN (0, 1)),
  firewall_ready INTEGER NOT NULL CHECK (firewall_ready IN (0, 1)),
  reported_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_runtime_capacity_revision_fence
BEFORE UPDATE ON node_runtime_capacity
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'node runtime capacity revision fence failed');
END;

CREATE TABLE server_capacity_reservations (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  cpu_millis INTEGER NOT NULL CHECK (cpu_millis > 0),
  ram_bytes INTEGER NOT NULL CHECK (ram_bytes > 0),
  disk_bytes INTEGER NOT NULL CHECK (disk_bytes > 0),
  capacity_revision INTEGER NOT NULL CHECK (capacity_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'releasing', 'released')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, server_id),
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER server_capacity_reservation_admission
BEFORE INSERT ON server_capacity_reservations
WHEN NEW.state <> 'reserved'
  OR NOT EXISTS (
    SELECT 1
    FROM nodes node
    JOIN node_runtime_capacity capacity
      ON capacity.organization_id = node.organization_id AND capacity.node_id = node.id
    WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.node_id
      AND node.desired_state = 'ready'
      AND node.observed_state = 'ready'
      AND node.desired_revision > 0
      AND capacity.revision = NEW.capacity_revision
      AND capacity.agent_ready = 1
      AND capacity.tunnel_ready = 1
      AND capacity.docker_ready = 1
      AND capacity.firewall_ready = 1
      AND NEW.cpu_millis + COALESCE((
        SELECT SUM(existing.cpu_millis) FROM server_capacity_reservations existing
        WHERE existing.organization_id = NEW.organization_id
          AND existing.node_id = NEW.node_id
          AND existing.state IN ('reserved', 'active')
      ), 0) <= capacity.cpu_millis
      AND NEW.ram_bytes + COALESCE((
        SELECT SUM(existing.ram_bytes) FROM server_capacity_reservations existing
        WHERE existing.organization_id = NEW.organization_id
          AND existing.node_id = NEW.node_id
          AND existing.state IN ('reserved', 'active')
      ), 0) <= capacity.ram_bytes
      AND NEW.disk_bytes + COALESCE((
        SELECT SUM(existing.disk_bytes) FROM server_capacity_reservations existing
        WHERE existing.organization_id = NEW.organization_id
          AND existing.node_id = NEW.node_id
          AND existing.state IN ('reserved', 'active')
      ), 0) <= capacity.disk_bytes
  )
BEGIN
  SELECT RAISE(ABORT, 'server capacity reservation admission failed');
END;

CREATE TABLE server_create_reservations (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  reservation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  plugin_selection_revision INTEGER NOT NULL CHECK (plugin_selection_revision > 0),
  node_desired_revision INTEGER NOT NULL CHECK (node_desired_revision > 0),
  capacity_revision INTEGER NOT NULL CHECK (capacity_revision > 0),
  allocation_revision INTEGER NOT NULL CHECK (allocation_revision > 0),
  catalog_refreshed_at TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, reservation_id),
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, server_id),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (plugin_id, plugin_version)
    REFERENCES game_plugins(id, version) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER server_create_reservation_fence
BEFORE INSERT ON server_create_reservations
WHEN json_extract(NEW.plan_json, '$.nodeId') IS NOT NEW.node_id
  OR json_extract(NEW.plan_json, '$.pluginId') IS NOT NEW.plugin_id
  OR json_extract(NEW.plan_json, '$.pluginVersion') IS NOT NEW.plugin_version
  OR json_extract(NEW.plan_json, '$.newPaidInfrastructure') IS NOT 0
  OR NOT EXISTS (
    SELECT 1 FROM organization_policies policy
    WHERE policy.organization_id = NEW.organization_id
      AND policy.revision = NEW.policy_revision
      AND json_extract(policy.policy_json, '$.revision') = NEW.policy_revision
      AND json_extract(NEW.plan_json, '$.resources.cpuMillis') <= json_extract(policy.policy_json, '$.capacity.maxDeploymentCpuMillis')
      AND json_extract(NEW.plan_json, '$.resources.ramBytes') <= json_extract(policy.policy_json, '$.capacity.maxDeploymentRamBytes')
      AND json_extract(NEW.plan_json, '$.resources.diskBytes') <= json_extract(policy.policy_json, '$.capacity.maxDeploymentDiskBytes')
      AND EXISTS (SELECT 1 FROM json_each(policy.policy_json, '$.allowedProviders')
        WHERE value = (SELECT provider_type FROM nodes
          WHERE organization_id = NEW.organization_id AND id = NEW.node_id))
      AND EXISTS (SELECT 1 FROM json_each(policy.policy_json, '$.allowedRegions')
        WHERE value = (SELECT region FROM nodes
          WHERE organization_id = NEW.organization_id AND id = NEW.node_id))
      AND EXISTS (SELECT 1 FROM json_each(policy.policy_json, '$.allowedPlans')
        WHERE value = (SELECT plan FROM nodes
          WHERE organization_id = NEW.organization_id AND id = NEW.node_id))
      AND (SELECT COUNT(*) FROM deployments deployment
        WHERE deployment.organization_id = NEW.organization_id
          AND deployment.node_id = NEW.node_id) <= json_extract(policy.policy_json, '$.capacity.maxServersPerNode')
  )
  OR NOT EXISTS (
    SELECT 1 FROM server_plugin_channels channel
    JOIN game_plugins plugin
      ON plugin.id = channel.plugin_id AND plugin.version = channel.active_version
    JOIN nodes node
      ON node.organization_id = NEW.organization_id AND node.id = NEW.node_id
    JOIN node_runtime_capacity runtime
      ON runtime.organization_id = node.organization_id AND runtime.node_id = node.id
    WHERE channel.plugin_id = NEW.plugin_id
      AND channel.active_version = NEW.plugin_version
      AND channel.revision = NEW.plugin_selection_revision
      AND plugin.status = 'available'
      AND json_extract(channel.plan_contract_json, '$.architecture') = runtime.architecture
      AND json_extract(NEW.plan_json, '$.placementMode') = node.placement_mode
      AND (node.placement_mode <> 'shared'
        OR json_extract(channel.plan_contract_json, '$.sharedNodeAllowed') = 1)
      AND json_extract(NEW.plan_json, '$.resources.cpuMillis') >= json_extract(channel.plan_contract_json, '$.minimum.cpuMillis')
      AND json_extract(NEW.plan_json, '$.resources.ramBytes') >= json_extract(channel.plan_contract_json, '$.minimum.ramBytes')
      AND json_extract(NEW.plan_json, '$.resources.diskBytes') >= json_extract(channel.plan_contract_json, '$.minimum.diskBytes')
      AND json_extract(NEW.plan_json, '$.resources.cpuMillis') <= json_extract(channel.plan_contract_json, '$.maximum.cpuMillis')
      AND json_extract(NEW.plan_json, '$.resources.ramBytes') <= json_extract(channel.plan_contract_json, '$.maximum.ramBytes')
      AND json_extract(NEW.plan_json, '$.resources.diskBytes') <= json_extract(channel.plan_contract_json, '$.maximum.diskBytes')
      AND json_array_length(NEW.plan_json, '$.ports') = json_array_length(channel.plan_contract_json, '$.ports')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(channel.plan_contract_json, '$.ports') contract_port
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(NEW.plan_json, '$.ports') planned_port
          WHERE json_extract(planned_port.value, '$.name') = json_extract(contract_port.value, '$.name')
            AND json_extract(planned_port.value, '$.protocol') = json_extract(contract_port.value, '$.protocol')
            AND json_extract(planned_port.value, '$.containerPort') = json_extract(contract_port.value, '$.containerPort')
            AND json_extract(planned_port.value, '$.preferredPublicPort') IS json_extract(contract_port.value, '$.preferredPublicPort')
        )
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
    JOIN provider_allocations allocation
      ON allocation.organization_id = node.organization_id
     AND allocation.provider_account_id = node.provider_account_id
    JOIN provider_accounts account ON account.id = node.provider_account_id
    JOIN provider_catalog catalog
      ON catalog.provider_type = node.provider_type
     AND catalog.region = node.region
     AND catalog.plan = node.plan
    JOIN node_runtime_capacity runtime
      ON runtime.organization_id = node.organization_id AND runtime.node_id = node.id
    WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.node_id
      AND node.desired_state = 'ready'
      AND node.observed_state = 'ready'
      AND node.desired_revision = NEW.node_desired_revision
      AND allocation.status = 'active'
      AND allocation.revision = NEW.allocation_revision
      AND account.status = 'active'
      AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_regions_json) WHERE value = node.region)
      AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_plans_json) WHERE value = node.plan)
      AND catalog.refreshed_at = NEW.catalog_refreshed_at
      AND runtime.revision = NEW.capacity_revision
      AND (julianday(NEW.created_at) - julianday(runtime.reported_at)) * 86400000 BETWEEN -60000 AND 300000
      AND (julianday(NEW.created_at) - julianday(catalog.refreshed_at)) * 86400000 BETWEEN -60000 AND 86400000
  )
  OR (SELECT COUNT(*) FROM deployments deployment
      WHERE deployment.organization_id = NEW.organization_id
        AND deployment.node_id = NEW.node_id)
    <> (SELECT COUNT(*) FROM server_capacity_reservations capacity
      WHERE capacity.organization_id = NEW.organization_id
        AND capacity.node_id = NEW.node_id
        AND capacity.state IN ('reserved', 'active'))
  OR EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.node_id
      AND node.placement_mode = 'dedicated'
      AND (SELECT COUNT(*) FROM deployments deployment
        WHERE deployment.organization_id = NEW.organization_id
          AND deployment.node_id = NEW.node_id) <> 1
  )
  OR NOT EXISTS (
    SELECT 1 FROM server_capacity_reservations capacity
    WHERE capacity.organization_id = NEW.organization_id
      AND capacity.server_id = NEW.server_id
      AND capacity.operation_id = NEW.operation_id
      AND capacity.node_id = NEW.node_id
      AND capacity.capacity_revision = NEW.capacity_revision
      AND capacity.state = 'reserved'
      AND capacity.cpu_millis = json_extract(NEW.plan_json, '$.resources.cpuMillis')
      AND capacity.ram_bytes = json_extract(NEW.plan_json, '$.resources.ramBytes')
      AND capacity.disk_bytes = json_extract(NEW.plan_json, '$.resources.diskBytes')
  )
  OR (SELECT COUNT(*) FROM port_leases lease
      WHERE lease.organization_id = NEW.organization_id
        AND lease.server_id = NEW.server_id
        AND lease.operation_id = NEW.operation_id
        AND lease.node_id = NEW.node_id
        AND lease.state = 'reserved') <> json_array_length(NEW.plan_json, '$.ports')
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.plan_json, '$.ports') planned
    WHERE NOT EXISTS (
      SELECT 1 FROM port_leases lease
      WHERE lease.organization_id = NEW.organization_id
        AND lease.server_id = NEW.server_id
        AND lease.operation_id = NEW.operation_id
        AND lease.node_id = NEW.node_id
        AND lease.protocol = json_extract(planned.value, '$.protocol')
        AND lease.public_port = json_extract(planned.value, '$.publicPort')
        AND lease.container_port = json_extract(planned.value, '$.containerPort')
        AND lease.state = 'reserved'
    )
  )
  OR NOT EXISTS (
    SELECT 1 FROM lifecycle_workflow_starts start
    WHERE start.organization_id = NEW.organization_id
      AND start.operation_id = NEW.operation_id
      AND start.state = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'server create revision or scope fence failed');
END;

CREATE TRIGGER server_create_reservation_immutable_update
BEFORE UPDATE ON server_create_reservations
BEGIN
  SELECT RAISE(ABORT, 'server create reservation is immutable');
END;

CREATE TRIGGER server_create_reservation_immutable_delete
BEFORE DELETE ON server_create_reservations
BEGIN
  SELECT RAISE(ABORT, 'server create reservation is immutable');
END;

CREATE INDEX server_create_reservations_node
  ON server_create_reservations(organization_id, node_id, created_at DESC);
`

const persistence = (operation: string, cause: unknown) =>
  new ServerPlanPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const isConcurrencyPersistence = (error: ServerPlanPersistenceError): boolean =>
  /constraint|unique|fence|admission|foreign key/i.test(error.message)
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => persistence(operation, cause) })
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const integer = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isSafeInteger(row[key]) ? row[key] : undefined
const parseJson = (operation: string, value: unknown) =>
  typeof value !== 'string'
    ? Effect.fail(persistence(operation, 'expected JSON text'))
    : Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: (cause) => persistence(operation, cause),
      })

const replaySelect = `SELECT reservation.fingerprint,
 reservation.server_id AS serverId, reservation.deployment_id AS deploymentId,
 reservation.operation_id AS operationId, reservation.plan_json AS planJson
 FROM server_create_reservations reservation
 WHERE reservation.organization_id = ? AND reservation.idempotency_key = ?`

const decodeReplay = (
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
  value: unknown,
): Effect.Effect<
  ServerCreateAcceptance | null,
  ServerPlanIdempotencyConflictError | ServerPlanPersistenceError
> => {
  if (value === null || value === undefined) return Effect.succeed(null)
  const row = record(value)
  if (row === undefined)
    return Effect.fail(persistence('server-plan.replay.decode', 'invalid replay row'))
  if (text(row, 'fingerprint') !== fingerprint)
    return Effect.fail(new ServerPlanIdempotencyConflictError({ idempotencyKey }))
  const serverId = text(row, 'serverId')
  const deploymentId = text(row, 'deploymentId')
  const operationId = text(row, 'operationId')
  if (serverId === undefined || deploymentId === undefined || operationId === undefined)
    return Effect.fail(persistence('server-plan.replay.decode', 'invalid replay identifiers'))
  return Effect.flatMap(parseJson('server-plan.replay.plan', row.planJson), (planValue) =>
    Schema.decodeUnknownEffect(ServerPlanDecisionSchema, { onExcessProperty: 'error' })(
      planValue,
    ).pipe(
      Effect.mapError(() => persistence('server-plan.replay.plan', 'invalid stored plan')),
      Effect.map((plan): ServerCreateAcceptance => ({
        disposition: 'adopted',
        organizationId,
        serverId,
        deploymentId,
        operationId,
        idempotencyKey,
        fingerprint,
        state: 'queued',
        plan,
      })),
    ),
  )
}

const pluginSelect = `SELECT channel.active_version AS pluginVersion,
 channel.plan_contract_json AS contractJson, channel.revision AS selectionRevision
 FROM server_plugin_channels channel
 JOIN game_plugins plugin ON plugin.id = channel.plugin_id AND plugin.version = channel.active_version
 WHERE channel.plugin_id = ? AND plugin.status = 'available'`
const policySelect = `SELECT policy_json AS policyJson, revision
 FROM organization_policies WHERE organization_id = ?`
const usageSelect = `SELECT
 (SELECT COUNT(*) FROM nodes WHERE organization_id = ? AND desired_state <> 'deleted') AS activeNodes,
 (SELECT COUNT(*) FROM nodes WHERE organization_id = ? AND desired_state <> 'deleted' AND placement_mode = 'dedicated') AS dedicatedNodes,
 (SELECT MAX(updated_at) FROM nodes WHERE organization_id = ? AND desired_state <> 'deleted') AS observedAt,
 (SELECT COUNT(*)
   FROM nodes node JOIN provider_catalog catalog
     ON catalog.provider_type = node.provider_type AND catalog.region = node.region AND catalog.plan = node.plan
   WHERE node.organization_id = ? AND node.desired_state <> 'deleted'
     AND (catalog.monthly_price_minor IS NOT NULL OR catalog.hourly_price_minor IS NOT NULL)) AS pricedNodes,
 COALESCE((SELECT SUM(COALESCE(catalog.monthly_price_minor, catalog.hourly_price_minor * 730))
   FROM nodes node JOIN provider_catalog catalog
     ON catalog.provider_type = node.provider_type AND catalog.region = node.region AND catalog.plan = node.plan
   WHERE node.organization_id = ? AND node.desired_state <> 'deleted'), 0) AS committedMonthlyMinor`
const candidatesSelect = `SELECT node.id AS nodeId, node.provider_type AS providerType,
 node.region, node.plan, node.placement_mode AS placementMode,
 node.desired_revision AS desiredRevision, capacity.revision AS capacityRevision,
 allocation.revision AS allocationRevision, catalog.refreshed_at AS catalogRefreshedAt,
 capacity.architecture, capacity.cpu_millis AS cpuMillis,
 capacity.ram_bytes AS ramBytes, capacity.disk_bytes AS diskBytes,
 capacity.reported_at AS capacityReportedAt,
 CASE WHEN node.desired_state = 'ready' AND node.observed_state = 'ready'
   AND allocation.status = 'active' AND account.status = 'active'
   AND capacity.agent_ready = 1 AND capacity.tunnel_ready = 1
   AND capacity.docker_ready = 1 AND capacity.firewall_ready = 1
   AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_regions_json) WHERE value = node.region)
   AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_plans_json) WHERE value = node.plan)
   THEN 1 ELSE 0 END AS healthy,
 COALESCE((SELECT SUM(reservation.cpu_millis) FROM server_capacity_reservations reservation
   WHERE reservation.organization_id = node.organization_id AND reservation.node_id = node.id
     AND reservation.state IN ('reserved', 'active')), 0) AS reservedCpuMillis,
 COALESCE((SELECT SUM(reservation.ram_bytes) FROM server_capacity_reservations reservation
   WHERE reservation.organization_id = node.organization_id AND reservation.node_id = node.id
     AND reservation.state IN ('reserved', 'active')), 0) AS reservedRamBytes,
 COALESCE((SELECT SUM(reservation.disk_bytes) FROM server_capacity_reservations reservation
   WHERE reservation.organization_id = node.organization_id AND reservation.node_id = node.id
     AND reservation.state IN ('reserved', 'active')), 0) AS reservedDiskBytes,
 (SELECT COUNT(*) FROM deployments deployment
   WHERE deployment.organization_id = node.organization_id AND deployment.node_id = node.id) AS serverCount,
 (SELECT COUNT(*) FROM server_capacity_reservations reservation
   WHERE reservation.organization_id = node.organization_id AND reservation.node_id = node.id
     AND reservation.state IN ('reserved', 'active')) AS reservationCount
 FROM nodes node
 JOIN node_runtime_capacity capacity
   ON capacity.organization_id = node.organization_id AND capacity.node_id = node.id
 JOIN provider_allocations allocation
   ON allocation.organization_id = node.organization_id
  AND allocation.provider_account_id = node.provider_account_id
 JOIN provider_accounts account ON account.id = node.provider_account_id
 JOIN provider_catalog catalog
   ON catalog.provider_type = node.provider_type AND catalog.region = node.region AND catalog.plan = node.plan
 WHERE node.organization_id = ?
 ORDER BY node.id`
const portsSelect = `SELECT protocol, public_port AS publicPort
 FROM port_leases WHERE organization_id = ? AND node_id = ? AND state <> 'released'
 ORDER BY protocol, public_port`
const serversByNodeSelect = `SELECT node.id AS nodeId, COUNT(deployment.id) AS serverCount
 FROM nodes node LEFT JOIN deployments deployment
   ON deployment.organization_id = node.organization_id AND deployment.node_id = node.id
 WHERE node.organization_id = ? GROUP BY node.id ORDER BY node.id`

const decodeCandidateBase = (
  value: unknown,
): Effect.Effect<Omit<ServerNodeCandidate, 'ports'>, ServerPlanPersistenceError> => {
  const row = record(value)
  if (row === undefined)
    return Effect.fail(persistence('server-plan.candidate.decode', 'invalid row'))
  const nodeId = text(row, 'nodeId')
  const providerType = text(row, 'providerType')
  const region = text(row, 'region')
  const plan = text(row, 'plan')
  const placementMode = text(row, 'placementMode')
  const architecture = text(row, 'architecture')
  const catalogRefreshedAt = text(row, 'catalogRefreshedAt')
  const capacityReportedAt = text(row, 'capacityReportedAt')
  const desiredRevision = integer(row, 'desiredRevision')
  const capacityRevision = integer(row, 'capacityRevision')
  const allocationRevision = integer(row, 'allocationRevision')
  const cpuMillis = integer(row, 'cpuMillis')
  const ramBytes = integer(row, 'ramBytes')
  const diskBytes = integer(row, 'diskBytes')
  const reservedCpuMillis = integer(row, 'reservedCpuMillis')
  const reservedRamBytes = integer(row, 'reservedRamBytes')
  const reservedDiskBytes = integer(row, 'reservedDiskBytes')
  const serverCount = integer(row, 'serverCount')
  const reservationCount = integer(row, 'reservationCount')
  if (
    nodeId === undefined ||
    (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
    region === undefined ||
    plan === undefined ||
    (placementMode !== 'shared' && placementMode !== 'dedicated') ||
    (architecture !== 'amd64' && architecture !== 'arm64') ||
    catalogRefreshedAt === undefined ||
    capacityReportedAt === undefined ||
    desiredRevision === undefined ||
    capacityRevision === undefined ||
    allocationRevision === undefined ||
    cpuMillis === undefined ||
    ramBytes === undefined ||
    diskBytes === undefined ||
    reservedCpuMillis === undefined ||
    reservedRamBytes === undefined ||
    reservedDiskBytes === undefined ||
    serverCount === undefined ||
    reservationCount === undefined ||
    (row.healthy !== 0 && row.healthy !== 1)
  )
    return Effect.fail(
      persistence('server-plan.candidate.decode', 'invalid authoritative candidate'),
    )
  return Effect.succeed({
    nodeId,
    providerType,
    region,
    plan,
    placementMode,
    desiredRevision,
    capacityRevision,
    allocationRevision,
    catalogRefreshedAt,
    capacityReportedAt,
    architecture: architecture as Architecture,
    healthy: row.healthy === 1,
    capacity: { cpuMillis, ramBytes, diskBytes },
    reserved: {
      cpuMillis: reservedCpuMillis,
      ramBytes: reservedRamBytes,
      diskBytes: reservedDiskBytes,
    },
    serverCount,
    reservationCount,
  })
}

const decodePorts = (
  rows: ReadonlyArray<unknown>,
): Effect.Effect<readonly ExistingPortLease[], ServerPlanPersistenceError> =>
  Effect.forEach(rows, (value) => {
    const row = record(value)
    const protocol = row === undefined ? undefined : text(row, 'protocol')
    const publicPort = row === undefined ? undefined : integer(row, 'publicPort')
    return (protocol !== 'tcp' && protocol !== 'udp') ||
      publicPort === undefined ||
      publicPort < 1 ||
      publicPort > 65_535
      ? Effect.fail(persistence('server-plan.ports.decode', 'invalid port lease'))
      : Effect.succeed({ protocol, publicPort } satisfies ExistingPortLease)
  })

export const makeServerPlanRepositoryD1 = (
  database: ServerPlanD1Database,
): ServerPlanRepositoryShape => {
  const findReplay: ServerPlanRepositoryShape['findReplay'] = (
    organizationId,
    idempotencyKey,
    fingerprint,
  ) =>
    Effect.flatMap(
      attempt('server-plan.replay.read', () =>
        database.prepare(replaySelect).bind(organizationId, idempotencyKey).first(),
      ),
      (row) => decodeReplay(organizationId, idempotencyKey, fingerprint, row),
    )
  const readFacts: ServerPlanRepositoryShape['readFacts'] = (organizationId, pluginId) =>
    Effect.gen(function* () {
      const [pluginRowValue, policyRowValue, usageRowValue, candidateRows, serversByNodeRows] =
        yield* Effect.all([
          attempt('server-plan.plugin.read', () =>
            database.prepare(pluginSelect).bind(pluginId).first(),
          ),
          attempt('server-plan.policy.read', () =>
            database.prepare(policySelect).bind(organizationId).first(),
          ),
          attempt('server-plan.usage.read', () =>
            database
              .prepare(usageSelect)
              .bind(organizationId, organizationId, organizationId, organizationId, organizationId)
              .first(),
          ),
          attempt('server-plan.nodes.read', () =>
            database.prepare(candidatesSelect).bind(organizationId).all(),
          ).pipe(Effect.map((result) => result.results)),
          attempt('server-plan.servers-by-node.read', () =>
            database.prepare(serversByNodeSelect).bind(organizationId).all(),
          ).pipe(Effect.map((result) => result.results)),
        ])
      const pluginRow = record(pluginRowValue)
      const policyRow = record(policyRowValue)
      const usageRow = record(usageRowValue)
      if (pluginRow === undefined)
        return yield* new ServerPlanFactsUnavailableError({
          operation: 'plugin-selection',
          message: 'No available active plugin selection exists',
        })
      if (policyRow === undefined)
        return yield* new ServerPlanFactsUnavailableError({
          operation: 'organization-policy',
          message: 'Organization policy is unavailable',
        })
      if (usageRow === undefined)
        return yield* new ServerPlanFactsUnavailableError({
          operation: 'organization-usage',
          message: 'Organization usage is unavailable',
        })
      const pluginVersion = text(pluginRow, 'pluginVersion')
      const selectionRevision = integer(pluginRow, 'selectionRevision')
      if (pluginVersion === undefined || selectionRevision === undefined)
        return yield* persistence('server-plan.plugin.decode', 'invalid plugin selection')
      const contractUnknown = yield* parseJson(
        'server-plan.plugin.contract',
        pluginRow.contractJson,
      )
      const contract = yield* Schema.decodeUnknownEffect(PluginPlanContractSchema, {
        onExcessProperty: 'error',
      })(contractUnknown).pipe(
        Effect.mapError(() =>
          persistence('server-plan.plugin.contract', 'invalid plugin plan contract'),
        ),
      )
      const policyUnknown = yield* parseJson('server-plan.policy.json', policyRow.policyJson)
      const policy = yield* decodeOrganizationPolicy(policyUnknown).pipe(
        Effect.mapError(() =>
          persistence('server-plan.policy.decode', 'invalid organization policy'),
        ),
      )
      if (
        policy.organizationId !== organizationId ||
        policy.revision !== integer(policyRow, 'revision')
      )
        return yield* persistence('server-plan.policy.decode', 'policy scope or revision mismatch')
      const activeNodes = integer(usageRow, 'activeNodes')
      const dedicatedNodes = integer(usageRow, 'dedicatedNodes')
      const observedAt = text(usageRow, 'observedAt')
      const pricedNodes = integer(usageRow, 'pricedNodes')
      const committedMonthlyMinor = integer(usageRow, 'committedMonthlyMinor')
      if (
        activeNodes === undefined ||
        dedicatedNodes === undefined ||
        (activeNodes > 0 &&
          (observedAt === undefined || !Number.isFinite(Date.parse(observedAt)))) ||
        pricedNodes === undefined ||
        pricedNodes !== activeNodes ||
        committedMonthlyMinor === undefined ||
        policy.monthlyBudget.currency === null
      )
        return yield* new ServerPlanFactsUnavailableError({
          operation: 'budget-facts',
          message: 'Complete organization budget facts are required',
        })
      const serversByNode: Record<string, number> = {}
      for (const value of serversByNodeRows) {
        const row = record(value)
        const nodeId = row === undefined ? undefined : text(row, 'nodeId')
        const serverCount = row === undefined ? undefined : integer(row, 'serverCount')
        if (nodeId === undefined || serverCount === undefined)
          return yield* persistence('server-plan.usage.decode', 'invalid server usage row')
        serversByNode[nodeId] = serverCount
      }
      const usage: OrganizationUsage = {
        organizationId,
        observedAtEpochMilliseconds: observedAt === undefined ? 0 : Date.parse(observedAt),
        activeNodes,
        dedicatedNodes,
        serversByNode,
        estimatedCommittedMonthlyMinor: committedMonthlyMinor,
        currency: policy.monthlyBudget.currency,
      }
      const nodes = yield* Effect.forEach(candidateRows, (candidateValue) =>
        Effect.gen(function* () {
          const candidate = yield* decodeCandidateBase(candidateValue)
          const ports = yield* attempt('server-plan.ports.read', () =>
            database.prepare(portsSelect).bind(organizationId, candidate.nodeId).all(),
          ).pipe(Effect.flatMap((result) => decodePorts(result.results)))
          return { ...candidate, ports }
        }),
      )
      return {
        organizationId,
        policy,
        usage,
        plugin: { pluginId, pluginVersion, selectionRevision, contract },
        nodes,
      } satisfies ServerPlanFacts
    }).pipe(
      Effect.mapError((error) =>
        error instanceof ServerPlanFactsUnavailableError ||
        error instanceof ServerPlanPersistenceError
          ? error
          : persistence('server-plan.facts', error),
      ),
    )

  const acceptAtomic: ServerPlanRepositoryShape['acceptAtomic'] = (input) => {
    const { command, identity, prepared, fingerprint, now } = input
    const organizationId = command.context.organizationId
    const planJson = JSON.stringify(prepared.decision)
    const placementJson = JSON.stringify({
      mode: prepared.decision.placementMode,
      nodeId: prepared.decision.nodeId,
      explanation: prepared.decision.explanation,
    })
    const operation = database
      .prepare(
        `INSERT INTO operations
       (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
        idempotency_key, correlation_id, revision, created_at, updated_at)
       VALUES (?, ?, 'create-server', 'server', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`,
      )
      .bind(
        identity.operationId,
        organizationId,
        identity.serverId,
        command.context.actorId,
        command.idempotencyKey,
        command.context.correlationId,
        now,
        now,
      )
    const server = database
      .prepare(
        `INSERT INTO game_servers
       (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
        placement_policy_json, domain, desired_revision, observed_revision, active_config_revision,
        reconciliation_error, last_reconciled_at, created_at, updated_at, pending_lifecycle_operation_id)
       VALUES (?, ?, ?, ?, ?, 'running', 'planning', ?, NULL, 1, 0, 1, NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        organizationId,
        identity.serverId,
        command.intent.name,
        prepared.decision.pluginId,
        prepared.decision.pluginVersion,
        placementJson,
        now,
        now,
        identity.operationId,
      )
    const deployment = database
      .prepare(
        `INSERT INTO deployments
       (organization_id, id, server_id, node_id, desired_revision, observed_revision,
        installed_build, observed_state, reconciliation_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, NULL, 'planning', NULL, ?, ?)`,
      )
      .bind(
        organizationId,
        identity.deploymentId,
        identity.serverId,
        prepared.decision.nodeId,
        now,
        now,
      )
    const capacity = database
      .prepare(
        `INSERT INTO server_capacity_reservations
       (organization_id, id, node_id, server_id, operation_id, cpu_millis, ram_bytes,
        disk_bytes, capacity_revision, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
      )
      .bind(
        organizationId,
        identity.capacityReservationId,
        prepared.decision.nodeId,
        identity.serverId,
        identity.operationId,
        prepared.decision.resources.cpuMillis,
        prepared.decision.resources.ramBytes,
        prepared.decision.resources.diskBytes,
        prepared.fences.capacityRevision,
        now,
      )
    const ports = prepared.decision.ports.map((port, index) =>
      database
        .prepare(
          `INSERT INTO port_leases
         (organization_id, id, node_id, server_id, protocol, public_port, container_port,
          state, operation_id, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 1, ?)`,
        )
        .bind(
          organizationId,
          identity.portLeaseIds[index],
          prepared.decision.nodeId,
          identity.serverId,
          port.protocol,
          port.publicPort,
          port.containerPort,
          identity.operationId,
          now,
        ),
    )
    const workflow = database
      .prepare(
        `INSERT INTO lifecycle_workflow_starts
       (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`,
      )
      .bind(organizationId, identity.operationId, identity.workflowStartRecordId, now, now)
    const audit = database
      .prepare(
        `INSERT INTO audit_events
       (id, organization_id, actor_id, action, target_type, target_id, result,
        correlation_id, summary_json, created_at)
       VALUES (?, ?, ?, 'server.create.reserved', 'server', ?, 'succeeded', ?, ?, ?)`,
      )
      .bind(
        identity.auditEventId,
        organizationId,
        command.context.actorId,
        identity.serverId,
        command.context.correlationId,
        JSON.stringify({
          state: 'queued',
          operationId: identity.operationId,
          nodeId: prepared.decision.nodeId,
        }),
        now,
      )
    const outbox = database
      .prepare(
        `INSERT INTO outbox
       (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
        publish_state, retry_count, available_at, created_at)
       VALUES (?, ?, 'server.create.reserved', 'server', ?, ?, 'pending', 0, ?, ?)`,
      )
      .bind(
        identity.outboxEventId,
        organizationId,
        identity.serverId,
        JSON.stringify({
          organizationId,
          serverId: identity.serverId,
          operationId: identity.operationId,
        }),
        now,
        now,
      )
    const reservation = database
      .prepare(
        `INSERT INTO server_create_reservations
       (organization_id, idempotency_key, fingerprint, reservation_id, server_id, deployment_id,
        operation_id, node_id, plugin_id, plugin_version, policy_revision,
        plugin_selection_revision, node_desired_revision, capacity_revision,
        allocation_revision, catalog_refreshed_at, plan_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        organizationId,
        command.idempotencyKey,
        fingerprint,
        identity.reservationId,
        identity.serverId,
        identity.deploymentId,
        identity.operationId,
        prepared.decision.nodeId,
        prepared.decision.pluginId,
        prepared.decision.pluginVersion,
        prepared.fences.policyRevision,
        prepared.fences.pluginSelectionRevision,
        prepared.fences.nodeDesiredRevision,
        prepared.fences.capacityRevision,
        prepared.fences.allocationRevision,
        prepared.fences.catalogRefreshedAt,
        planJson,
        now,
      )
    const created: ServerCreateAcceptance = {
      disposition: 'created',
      organizationId,
      serverId: identity.serverId,
      deploymentId: identity.deploymentId,
      operationId: identity.operationId,
      idempotencyKey: command.idempotencyKey,
      fingerprint,
      state: 'queued',
      plan: prepared.decision,
    }
    return attempt('server-plan.accept', () =>
      database.batch([
        server,
        operation,
        deployment,
        capacity,
        ...ports,
        workflow,
        audit,
        outbox,
        reservation,
      ]),
    ).pipe(
      Effect.map(() => created),
      Effect.catch(
        (
          failure: ServerPlanPersistenceError,
        ): Effect.Effect<
          ServerCreateAcceptance,
          | ServerPlanIdempotencyConflictError
          | ServerPlanConcurrencyError
          | ServerPlanPersistenceError
        > =>
          findReplay(organizationId, command.idempotencyKey, fingerprint).pipe(
            Effect.catch(
              (
                replayFailure,
              ): Effect.Effect<
                ServerCreateAcceptance | null,
                ServerPlanIdempotencyConflictError | ServerPlanPersistenceError
              > =>
                replayFailure instanceof ServerPlanIdempotencyConflictError
                  ? Effect.fail(replayFailure)
                  : Effect.fail(failure),
            ),
            Effect.flatMap(
              (
                replay,
              ): Effect.Effect<
                ServerCreateAcceptance,
                ServerPlanConcurrencyError | ServerPlanPersistenceError
              > =>
                replay !== null
                  ? Effect.succeed(replay)
                  : isConcurrencyPersistence(failure)
                    ? Effect.fail(
                        new ServerPlanConcurrencyError({ code: 'authoritative_fact_changed' }),
                      )
                    : Effect.fail(failure),
            ),
          ),
      ),
    )
  }
  return { findReplay, readFacts, acceptAtomic }
}

export * from './provisioning.js'

export const ServerPlanRepositoryD1Live = Layer.effect(
  ServerPlanRepository,
  Effect.map(ServerPlanD1Client, makeServerPlanRepositoryD1),
)

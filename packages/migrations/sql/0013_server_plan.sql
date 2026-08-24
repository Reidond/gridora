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

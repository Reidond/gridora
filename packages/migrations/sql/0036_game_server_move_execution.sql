PRAGMA foreign_keys = ON;

-- Provider DNS effects are acknowledged only after the exact tenant/server
-- row and operation-bound receipt are committed.  This prevents a successful
-- Cloudflare response from being mistaken for durable teardown after a lost
-- Worker response.
CREATE TABLE game_dns_lifecycle_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publish', 'delete')),
  hostname TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('A', 'AAAA')),
  target TEXT NOT NULL,
  provider_record_id TEXT,
  provider_result_json TEXT NOT NULL CHECK (json_valid(provider_result_json)),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, action),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_dns_lifecycle_receipts_server
  ON game_dns_lifecycle_receipts(organization_id, server_id, hostname, action);

CREATE TRIGGER game_dns_lifecycle_receipt_scope_guard
BEFORE INSERT ON game_dns_lifecycle_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN organizations organization ON organization.id = operation.organization_id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND organization.status IN ('active', 'deleting')
    AND (
      (NEW.action = 'publish' AND operation.type = 'server.create' AND NEW.state = 'active')
      OR (NEW.action = 'delete' AND operation.type = 'server.delete' AND NEW.state = 'deleted')
    )
)
OR NOT EXISTS (
  SELECT 1
  FROM dns_records record
  WHERE record.organization_id = NEW.organization_id
    AND record.server_id = NEW.server_id
    AND record.hostname = NEW.hostname
    AND record.target = NEW.target
    AND record.state = CASE NEW.action WHEN 'publish' THEN 'active' ELSE 'deleted' END
    AND record.proxy_mode = 'dns_only'
)
BEGIN
  SELECT RAISE(ABORT, 'game DNS receipt scope/evidence fence failed');
END;

CREATE TRIGGER game_dns_lifecycle_receipt_immutable
BEFORE UPDATE ON game_dns_lifecycle_receipts
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.action IS NOT OLD.action
  OR NEW.hostname IS NOT OLD.hostname
  OR NEW.record_type IS NOT OLD.record_type
  OR NEW.target IS NOT OLD.target
  OR NEW.provider_record_id IS NOT OLD.provider_record_id
  OR NEW.provider_result_json IS NOT OLD.provider_result_json
  OR NEW.state IS NOT OLD.state
  OR NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'game DNS receipt is immutable');
END;

-- A move is a distinct lifecycle operation.  It is deliberately represented by
-- its own acceptance/evidence tables instead of being treated as an update:
-- the source deployment, target admission, backup preservation, and cutover
-- all have different safety invariants.
CREATE TABLE game_lifecycle_move_reservations (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  cpu_millis INTEGER NOT NULL CHECK (cpu_millis > 0),
  ram_bytes INTEGER NOT NULL CHECK (ram_bytes > 0),
  disk_bytes INTEGER NOT NULL CHECK (disk_bytes > 0),
  target_capacity_revision INTEGER NOT NULL CHECK (target_capacity_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'released', 'rolled_back')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  CHECK (source_node_id <> target_node_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX game_lifecycle_move_reservations_target
  ON game_lifecycle_move_reservations(organization_id, target_node_id, state);

CREATE TRIGGER game_lifecycle_move_reservation_admission
BEFORE INSERT ON game_lifecycle_move_reservations
WHEN NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN organizations organization ON organization.id = operation.organization_id
  JOIN identities actor ON actor.id = operation.actor_id
  JOIN organization_memberships membership
    ON membership.organization_id = operation.organization_id
   AND membership.identity_id = operation.actor_id
  JOIN game_servers server
    ON server.organization_id = operation.organization_id
   AND server.id = operation.resource_id
  JOIN deployments deployment
    ON deployment.organization_id = server.organization_id
   AND deployment.server_id = server.id
  JOIN nodes target_node
    ON target_node.organization_id = NEW.organization_id
   AND target_node.id = NEW.target_node_id
  JOIN node_runtime_capacity target_capacity
    ON target_capacity.organization_id = target_node.organization_id
   AND target_capacity.node_id = target_node.id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND operation.status = 'queued'
    AND organization.status = 'active'
    AND actor.status = 'active'
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'administrator', 'operator')
    AND server.pending_lifecycle_operation_id = NEW.operation_id
    AND server.desired_revision = NEW.expected_revision + 1
    AND server.observed_state = 'moving'
    AND deployment.id IS NOT NULL
    AND deployment.node_id = NEW.source_node_id
    AND target_node.desired_state = 'ready'
    AND target_node.observed_state = 'ready'
    AND target_capacity.revision = NEW.target_capacity_revision
    AND target_capacity.agent_ready = 1
    AND target_capacity.tunnel_ready = 1
    AND target_capacity.docker_ready = 1
    AND target_capacity.firewall_ready = 1
    AND NEW.cpu_millis + COALESCE((
      SELECT SUM(reservation.cpu_millis)
      FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.node_id = NEW.target_node_id
        AND reservation.state IN ('reserved', 'active')
    ), 0) + COALESCE((
      SELECT SUM(reservation.cpu_millis)
      FROM game_lifecycle_move_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.target_node_id = NEW.target_node_id
        AND reservation.state IN ('reserved', 'active')
    ), 0) <= target_capacity.cpu_millis
    AND NEW.ram_bytes + COALESCE((
      SELECT SUM(reservation.ram_bytes)
      FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.node_id = NEW.target_node_id
        AND reservation.state IN ('reserved', 'active')
    ), 0) + COALESCE((
      SELECT SUM(reservation.ram_bytes)
      FROM game_lifecycle_move_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.target_node_id = NEW.target_node_id
        AND reservation.state IN ('reserved', 'active')
    ), 0) <= target_capacity.ram_bytes
    AND NEW.disk_bytes + COALESCE((
      SELECT SUM(reservation.disk_bytes)
      FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.node_id = NEW.target_node_id
        AND reservation.state IN ('reserved', 'active')
    ), 0) + COALESCE((
      SELECT SUM(reservation.disk_bytes)
      FROM game_lifecycle_move_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.target_node_id = NEW.target_node_id
        AND reservation.state IN ('reserved', 'active')
    ), 0) <= target_capacity.disk_bytes
    AND (
      (target_node.placement_mode = 'shared')
      OR (
        target_node.placement_mode = 'dedicated'
        AND NOT EXISTS (
          SELECT 1 FROM deployments occupied
          WHERE occupied.organization_id = NEW.organization_id
            AND occupied.node_id = NEW.target_node_id
            AND occupied.observed_state NOT IN ('deleted', 'deleting')
        )
        AND NOT EXISTS (
          SELECT 1 FROM game_lifecycle_move_reservations occupied
          WHERE occupied.organization_id = NEW.organization_id
            AND occupied.target_node_id = NEW.target_node_id
            AND occupied.state IN ('reserved', 'active')
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'game move target admission failed');
END;

CREATE TABLE game_lifecycle_moves (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'move'),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  source_deployment_id TEXT NOT NULL,
  backup_policy TEXT NOT NULL CHECK (backup_policy = 'required'),
  backup_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN (
    'reserved', 'backup', 'stopped', 'restoring', 'validated', 'cutover',
    'released', 'rolled_back', 'failed'
  )),
  source_preserved INTEGER NOT NULL CHECK (source_preserved IN (0, 1)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  CHECK (source_node_id <> target_node_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX game_lifecycle_moves_server
  ON game_lifecycle_moves(organization_id, server_id, created_at DESC);

CREATE TRIGGER game_lifecycle_move_acceptance_fence
BEFORE INSERT ON game_lifecycle_moves
WHEN NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN organizations organization ON organization.id = operation.organization_id
  JOIN identities actor ON actor.id = operation.actor_id
  JOIN organization_memberships membership
    ON membership.organization_id = operation.organization_id
   AND membership.identity_id = operation.actor_id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND operation.type = 'server.move'
    AND operation.status = 'queued'
    AND operation.idempotency_key = NEW.idempotency_key
    AND organization.status = 'active'
    AND actor.status = 'active'
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'administrator', 'operator')
)
OR NOT EXISTS (
  SELECT 1 FROM game_servers server
  WHERE server.organization_id = NEW.organization_id
    AND server.id = NEW.server_id
    AND server.pending_lifecycle_operation_id = NEW.operation_id
    AND server.desired_revision = NEW.expected_revision + 1
    AND server.observed_state = 'moving'
)
OR NOT EXISTS (
  SELECT 1 FROM deployments deployment
  WHERE deployment.organization_id = NEW.organization_id
    AND deployment.id = NEW.source_deployment_id
    AND deployment.server_id = NEW.server_id
    AND deployment.node_id = NEW.source_node_id
    AND (SELECT COUNT(*) FROM deployments exact
      WHERE exact.organization_id = NEW.organization_id
        AND exact.server_id = NEW.server_id) = 1
)
OR NOT EXISTS (
  SELECT 1 FROM game_lifecycle_move_reservations reservation
  WHERE reservation.organization_id = NEW.organization_id
    AND reservation.operation_id = NEW.operation_id
    AND reservation.server_id = NEW.server_id
    AND reservation.source_node_id = NEW.source_node_id
    AND reservation.target_node_id = NEW.target_node_id
    AND reservation.state = 'reserved'
)
OR NOT EXISTS (
  SELECT 1 FROM audit_events audit
  JOIN operations operation
    ON operation.organization_id = audit.organization_id
   AND operation.correlation_id = audit.correlation_id
   AND operation.id = NEW.operation_id
  WHERE audit.organization_id = NEW.organization_id
    AND audit.target_type = 'server'
    AND audit.target_id = NEW.server_id
    AND audit.result = 'succeeded'
)
OR NOT EXISTS (
  SELECT 1 FROM outbox event
  WHERE event.organization_id = NEW.organization_id
    AND event.aggregate_type = 'game_server'
    AND event.aggregate_id = NEW.server_id
    AND event.event_type = 'game-server.lifecycle.accepted'
    AND json_extract(event.payload_json, '$.operationId') = NEW.operation_id
)
OR NOT EXISTS (
  SELECT 1 FROM lifecycle_workflow_starts start
  WHERE start.organization_id = NEW.organization_id
    AND start.operation_id = NEW.operation_id
    AND start.state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'game move acceptance evidence fence failed');
END;

CREATE TRIGGER game_lifecycle_move_transition_fence
BEFORE UPDATE OF organization_id, idempotency_key, action, request_fingerprint,
  operation_id, server_id, expected_revision, source_node_id, target_node_id,
  source_deployment_id, backup_policy, backup_id, phase, source_preserved, revision
ON game_lifecycle_moves
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.action IS NOT OLD.action
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.expected_revision IS NOT OLD.expected_revision
  OR NEW.source_node_id IS NOT OLD.source_node_id
  OR NEW.target_node_id IS NOT OLD.target_node_id
  OR NEW.source_deployment_id IS NOT OLD.source_deployment_id
  OR NEW.backup_policy IS NOT OLD.backup_policy
  OR (OLD.backup_id IS NOT NULL AND NEW.backup_id IS NOT OLD.backUP_id)
  OR NEW.source_preserved < OLD.source_preserved
  OR NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.phase = 'reserved' AND NEW.phase = 'backup')
    OR (OLD.phase = 'backup' AND NEW.phase IN ('stopped', 'failed', 'rolled_back'))
    OR (OLD.phase = 'stopped' AND NEW.phase IN ('restoring', 'failed', 'rolled_back'))
    OR (OLD.phase = 'restoring' AND NEW.phase IN ('validated', 'failed', 'rolled_back'))
    OR (OLD.phase = 'validated' AND NEW.phase IN ('cutover', 'failed', 'rolled_back'))
    OR (OLD.phase = 'cutover' AND NEW.phase IN ('released', 'failed', 'rolled_back'))
    OR (OLD.phase = 'released' AND NEW.phase = 'released')
    OR (OLD.phase = 'rolled_back' AND NEW.phase = 'rolled_back')
    OR (OLD.phase = 'failed' AND NEW.phase = 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'game move transition fence failed');
END;

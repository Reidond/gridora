PRAGMA foreign_keys = ON;

-- A forced server cleanup never impersonates an agent command. It is allowed
-- only for the exact deployment already inventoried by an active node
-- rebuild/retire operation after the node is authoritatively failed.
CREATE TABLE game_failed_node_cleanup_receipts (
  organization_id TEXT NOT NULL,
  lifecycle_operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_lifecycle_operation_id TEXT NOT NULL,
  node_observed_revision INTEGER NOT NULL CHECK (node_observed_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('authorized', 'completed')),
  revision INTEGER NOT NULL CHECK (revision IN (1, 2)),
  authorized_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (organization_id, lifecycle_operation_id),
  UNIQUE (organization_id, node_lifecycle_operation_id, server_id),
  FOREIGN KEY (organization_id, lifecycle_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_lifecycle_operation_id)
    REFERENCES node_lifecycle_runs(organization_id, operation_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'authorized' AND revision = 1 AND completed_at IS NULL)
    OR (state = 'completed' AND revision = 2 AND completed_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_failed_node_cleanup_authorization_fence
BEFORE INSERT ON game_failed_node_cleanup_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN game_lifecycle_mutations mutation
    ON mutation.organization_id = operation.organization_id
   AND mutation.operation_id = operation.id
  JOIN game_servers server
    ON server.organization_id = operation.organization_id
   AND server.id = operation.resource_id
  JOIN deployments deployment
    ON deployment.organization_id = server.organization_id
   AND deployment.server_id = server.id
  JOIN nodes node
    ON node.organization_id = deployment.organization_id
   AND node.id = deployment.node_id
  JOIN node_lifecycle_runs lifecycle
    ON lifecycle.organization_id = node.organization_id
   AND lifecycle.node_id = node.id
  JOIN node_lifecycle_affected_servers affected
    ON affected.organization_id = lifecycle.organization_id
   AND affected.operation_id = lifecycle.operation_id
   AND affected.server_id = server.id
   AND affected.deployment_id = deployment.id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.lifecycle_operation_id
    AND operation.type = 'server.delete'
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
    AND mutation.action = 'delete'
    AND mutation.server_id = NEW.server_id
    AND json_extract(mutation.result_json, '$.forcedCleanup') = 1
    AND server.pending_lifecycle_operation_id = operation.id
    AND server.desired_state = 'deleted'
    AND deployment.id = NEW.deployment_id
    AND deployment.node_id = NEW.node_id
    AND deployment.observed_state <> 'deleted'
    AND node.id = NEW.node_id
    AND node.observed_state = 'failed'
    AND node.observed_revision = NEW.node_observed_revision
    AND lifecycle.operation_id = NEW.node_lifecycle_operation_id
    AND lifecycle.action IN ('rebuild-node', 'retire-node')
    AND lifecycle.state NOT IN ('cancelled', 'completed')
    AND affected.state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'failed node cleanup authorization fence failed');
END;

CREATE TRIGGER game_failed_node_cleanup_completion_fence
BEFORE UPDATE OF state, revision, completed_at ON game_failed_node_cleanup_receipts
WHEN OLD.state <> 'authorized'
  OR NEW.state <> 'completed'
  OR NEW.revision <> OLD.revision + 1
  OR NEW.completed_at IS NULL
  OR NEW.organization_id <> OLD.organization_id
  OR NEW.lifecycle_operation_id <> OLD.lifecycle_operation_id
  OR NEW.server_id <> OLD.server_id
  OR NEW.deployment_id <> OLD.deployment_id
  OR NEW.node_id <> OLD.node_id
  OR NEW.node_lifecycle_operation_id <> OLD.node_lifecycle_operation_id
  OR NEW.node_observed_revision <> OLD.node_observed_revision
  OR EXISTS (
    SELECT 1 FROM port_leases lease
    WHERE lease.organization_id = NEW.organization_id
      AND lease.server_id = NEW.server_id
      AND lease.state <> 'released'
  )
  OR EXISTS (
    SELECT 1 FROM dns_records dns
    WHERE dns.organization_id = NEW.organization_id
      AND dns.server_id = NEW.server_id
      AND dns.state <> 'deleted'
  )
  OR NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.id = NEW.deployment_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
      AND deployment.observed_state = 'deleted'
  )
  OR NOT EXISTS (
    SELECT 1 FROM node_lifecycle_affected_servers affected
    WHERE affected.organization_id = NEW.organization_id
      AND affected.operation_id = NEW.node_lifecycle_operation_id
      AND affected.server_id = NEW.server_id
      AND affected.deployment_id = NEW.deployment_id
      AND affected.state = 'deleted'
  )
  OR NOT EXISTS (
    SELECT 1 FROM game_observation_reductions observation
    WHERE observation.organization_id = NEW.organization_id
      AND observation.server_id = NEW.server_id
      AND observation.operation_id = NEW.lifecycle_operation_id
      AND observation.observed_state = 'deleted'
  )
BEGIN
  SELECT RAISE(ABORT, 'failed node cleanup completion fence failed');
END;

CREATE TRIGGER game_failed_node_cleanup_coordinates_immutable
BEFORE UPDATE OF organization_id, lifecycle_operation_id, server_id,
  deployment_id, node_id, node_lifecycle_operation_id, node_observed_revision,
  authorized_at ON game_failed_node_cleanup_receipts
BEGIN
  SELECT RAISE(ABORT, 'failed node cleanup coordinates are immutable');
END;

CREATE TRIGGER game_failed_node_cleanup_immutable_delete
BEFORE DELETE ON game_failed_node_cleanup_receipts
BEGIN
  SELECT RAISE(ABORT, 'failed node cleanup receipt is immutable');
END;

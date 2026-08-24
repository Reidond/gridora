ALTER TABLE operation_cancellation_requests
ADD COLUMN audit_request_context_json TEXT
  CHECK (
    audit_request_context_json IS NULL OR (
      length(audit_request_context_json) BETWEEN 2 AND 8192
      AND json_valid(audit_request_context_json)
      AND json_type(audit_request_context_json, '$') = 'object'
      AND json_type(audit_request_context_json, '$.origin') = 'text'
      AND json_type(audit_request_context_json, '$.requestId') = 'text'
      AND json_type(audit_request_context_json, '$.correlationId') = 'text'
      AND json_type(audit_request_context_json, '$.source') = 'object'
    )
  );

CREATE TRIGGER cancellation_audit_provenance_required
BEFORE INSERT ON operation_cancellation_requests
WHEN NEW.audit_request_context_json IS NULL
BEGIN SELECT RAISE(ABORT, 'cancellation audit provenance is required'); END;

CREATE TRIGGER cancellation_audit_provenance_immutable
BEFORE UPDATE OF audit_request_context_json ON operation_cancellation_requests
WHEN NEW.audit_request_context_json <> OLD.audit_request_context_json
BEGIN SELECT RAISE(ABORT, 'cancellation audit provenance is immutable'); END;

CREATE TABLE organization_deletion_child_operations (
  organization_id TEXT NOT NULL,
  parent_operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('game-server', 'node', 'backup', 'dns-record', 'tunnel')),
  resource_id TEXT NOT NULL,
  child_operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dispatching', 'accepted', 'succeeded', 'failed', 'ambiguous')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, parent_operation_id, kind, resource_id),
  UNIQUE (organization_id, child_operation_id),
  FOREIGN KEY (organization_id, parent_operation_id)
    REFERENCES organization_deletion_runs(organization_id, operation_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER organization_deletion_child_scope_guard
BEFORE INSERT ON organization_deletion_child_operations
WHEN NOT EXISTS (
  SELECT 1 FROM organization_deletion_runs run
  JOIN organizations organization ON organization.id = run.organization_id
  JOIN operations parent
    ON parent.organization_id = run.organization_id AND parent.id = run.operation_id
  WHERE run.organization_id = NEW.organization_id
    AND run.operation_id = NEW.parent_operation_id
    AND organization.status = 'deleting'
    AND parent.type = 'delete-organization'
    AND parent.status IN ('queued', 'running', 'waiting_external')
)
BEGIN SELECT RAISE(ABORT, 'organization deletion child scope fence failed'); END;

CREATE TRIGGER organization_deletion_child_identity_immutable
BEFORE UPDATE OF organization_id, parent_operation_id, kind, resource_id,
  child_operation_id, idempotency_key, created_at
ON organization_deletion_child_operations
WHEN NEW.organization_id <> OLD.organization_id
  OR NEW.parent_operation_id <> OLD.parent_operation_id
  OR NEW.kind <> OLD.kind
  OR NEW.resource_id <> OLD.resource_id
  OR NEW.child_operation_id <> OLD.child_operation_id
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'organization deletion child identity is immutable'); END;

DROP TRIGGER game_lifecycle_mutation_fence;
CREATE TRIGGER game_lifecycle_mutation_fence
BEFORE INSERT ON game_lifecycle_mutations
WHEN NOT EXISTS (
  SELECT 1 FROM operations operation
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND operation.status = 'queued'
    AND operation.idempotency_key = NEW.idempotency_key
)
OR NOT (
  EXISTS (
    SELECT 1 FROM operations operation
    JOIN organizations organization ON organization.id = operation.organization_id
    JOIN identities actor ON actor.id = operation.actor_id
    JOIN organization_memberships membership
      ON membership.organization_id = operation.organization_id
     AND membership.identity_id = operation.actor_id
    WHERE operation.organization_id = NEW.organization_id
      AND operation.id = NEW.operation_id AND organization.status = 'active'
      AND actor.status = 'active' AND membership.status = 'active'
      AND ((NEW.action = 'delete' AND membership.role IN ('owner', 'administrator'))
        OR (NEW.action <> 'delete' AND membership.role IN ('owner', 'administrator', 'operator')))
  )
  OR EXISTS (
    SELECT 1 FROM organization_deletion_child_operations child
    JOIN organization_deletion_runs run
      ON run.organization_id = child.organization_id
     AND run.operation_id = child.parent_operation_id
    JOIN organizations organization ON organization.id = run.organization_id
    JOIN operations parent
      ON parent.organization_id = run.organization_id AND parent.id = run.operation_id
    JOIN operations operation
      ON operation.organization_id = child.organization_id
     AND operation.id = child.child_operation_id
    WHERE child.organization_id = NEW.organization_id
      AND child.kind = 'game-server' AND child.resource_id = NEW.server_id
      AND child.child_operation_id = NEW.operation_id
      AND child.idempotency_key = NEW.idempotency_key
      AND child.state = 'dispatching' AND NEW.action = 'delete'
      AND operation.actor_id = run.actor_id
      AND organization.status = 'deleting'
      AND parent.type = 'delete-organization'
      AND parent.status IN ('queued', 'running', 'waiting_external')
  )
)
OR NOT EXISTS (
  SELECT 1 FROM game_servers server
  WHERE server.organization_id = NEW.organization_id
    AND server.id = NEW.server_id
    AND server.pending_lifecycle_operation_id = NEW.operation_id
    AND server.desired_revision = NEW.expected_revision + 1
)
OR NOT EXISTS (
  SELECT 1 FROM audit_events audit JOIN operations operation
    ON operation.organization_id = audit.organization_id
   AND operation.correlation_id = audit.correlation_id
   AND operation.id = NEW.operation_id
  WHERE audit.organization_id = NEW.organization_id
    AND audit.target_type = 'server' AND audit.target_id = NEW.server_id
    AND audit.result = 'succeeded'
)
OR NOT EXISTS (
  SELECT 1 FROM outbox event
  WHERE event.organization_id = NEW.organization_id
    AND event.aggregate_type = 'game_server' AND event.aggregate_id = NEW.server_id
    AND event.event_type = 'game-server.lifecycle.accepted'
    AND json_extract(event.payload_json, '$.operationId') = NEW.operation_id
)
OR NOT EXISTS (
  SELECT 1 FROM lifecycle_workflow_starts start
  WHERE start.organization_id = NEW.organization_id
    AND start.operation_id = NEW.operation_id AND start.state = 'pending'
)
OR (NEW.action = 'create' AND (
  NOT EXISTS (SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.desired_revision = 1 AND deployment.observed_state = 'installing')
  OR NOT EXISTS (SELECT 1 FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.server_id = NEW.server_id
      AND reservation.operation_id = NEW.operation_id AND reservation.state = 'reserved')
))
OR (NEW.action <> 'create' AND (
  (SELECT COUNT(*) FROM deployments deployment
   WHERE deployment.organization_id = NEW.organization_id
     AND deployment.server_id = NEW.server_id) <> 1
))
OR (NEW.action = 'apply-config' AND NOT EXISTS (
  SELECT 1 FROM game_servers server JOIN game_server_config_revisions config
    ON config.organization_id = server.organization_id AND config.server_id = server.id
   AND config.revision = json_extract(NEW.result_json, '$.configRevision')
  WHERE server.organization_id = NEW.organization_id AND server.id = NEW.server_id
    AND server.active_config_revision = json_extract(NEW.result_json, '$.configRevision')
))
OR (NEW.action = 'sync-mods' AND NOT EXISTS (
  SELECT 1 FROM mod_sets mods
  WHERE mods.organization_id = NEW.organization_id AND mods.server_id = NEW.server_id
    AND mods.desired_revision = json_extract(NEW.result_json, '$.modRevision')
))
BEGIN SELECT RAISE(ABORT, 'game lifecycle mutation evidence fence failed'); END;

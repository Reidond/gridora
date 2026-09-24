PRAGMA foreign_keys = ON;

-- A rename is a terminal, metadata-only declarative mutation (ADR 0107). It
-- reuses the manifest mutation receipt table. The guard now accepts exactly
-- two operation/audit pairs and still requires the same revision fence, spec
-- source operation, and target server as the policy-only mutation.
-- UNIQUE (organization_id, name) on game_servers already enforces per-tenant
-- name uniqueness, so no new index is required.
DROP TRIGGER game_server_manifest_mutation_insert_guard;

CREATE TRIGGER game_server_manifest_mutation_insert_guard
BEFORE INSERT ON game_server_manifest_mutations
WHEN NOT EXISTS (
  SELECT 1
  FROM game_servers server
  JOIN game_server_desired_specs spec
    ON spec.organization_id = server.organization_id AND spec.server_id = server.id
  JOIN operations operation
    ON operation.organization_id = server.organization_id AND operation.id = NEW.operation_id
  JOIN audit_events audit
    ON audit.id = NEW.acceptance_audit_event_id
   AND audit.organization_id = server.organization_id
  WHERE server.organization_id = NEW.organization_id
    AND server.id = NEW.server_id
    AND server.desired_revision = NEW.desired_revision
    AND spec.desired_revision = NEW.desired_revision
    AND spec.source_operation_id = NEW.operation_id
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND (
      (operation.type = 'server.manifest.policy.update'
        AND audit.action = 'game-server.manifest.policy.update.accepted')
      OR
      (operation.type = 'server.manifest.rename'
        AND audit.action = 'game-server.manifest.rename.accepted')
    )
    AND operation.status = 'succeeded'
    AND operation.progress = 100
    AND audit.target_type = 'server'
    AND audit.target_id = NEW.server_id
    AND audit.result = 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'game server manifest mutation insert fence failed');
END;

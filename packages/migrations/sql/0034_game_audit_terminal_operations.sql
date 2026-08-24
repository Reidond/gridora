-- Game lifecycle acceptance writes are queued work.  The v1 audit contract
-- requires result=succeeded to bind to a terminal operation, so acceptance
-- records use a deterministic, terminal audit operation inserted in the same
-- D1 batch as the queued lifecycle operation.  Migration 0017 predates that
-- contract and looked for the legacy game_server compact target; replace only
-- its final mutation fence with the canonical server target used by the
-- operations table and v1 envelope.
DROP TRIGGER IF EXISTS game_lifecycle_mutation_fence;

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
OR NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN organizations organization
    ON organization.id = operation.organization_id
  JOIN identities actor
    ON actor.id = operation.actor_id
  JOIN organization_memberships membership
    ON membership.organization_id = operation.organization_id
   AND membership.identity_id = operation.actor_id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND organization.status = 'active'
    AND actor.status = 'active'
    AND membership.status = 'active'
    AND (
      (NEW.action = 'delete' AND membership.role IN ('owner', 'administrator'))
      OR (NEW.action <> 'delete' AND membership.role IN ('owner', 'administrator', 'operator'))
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
OR (NEW.action = 'create' AND (
  NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.desired_revision = 1
      AND deployment.observed_state = 'installing'
  )
  OR NOT EXISTS (
    SELECT 1 FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.server_id = NEW.server_id
      AND reservation.operation_id = NEW.operation_id
      AND reservation.state = 'reserved'
  )
))
OR (NEW.action <> 'create' AND (
  (SELECT COUNT(*) FROM deployments deployment
   WHERE deployment.organization_id = NEW.organization_id
     AND deployment.server_id = NEW.server_id) <> 1
))
OR (NEW.action = 'apply-config' AND NOT EXISTS (
  SELECT 1 FROM game_servers server
  JOIN game_server_config_revisions config
    ON config.organization_id = server.organization_id
   AND config.server_id = server.id
   AND config.revision = json_extract(NEW.result_json, '$.configRevision')
  WHERE server.organization_id = NEW.organization_id
    AND server.id = NEW.server_id
    AND server.active_config_revision = json_extract(NEW.result_json, '$.configRevision')
))
OR (NEW.action = 'sync-mods' AND NOT EXISTS (
  SELECT 1 FROM mod_sets mods
  WHERE mods.organization_id = NEW.organization_id
    AND mods.server_id = NEW.server_id
    AND mods.desired_revision = json_extract(NEW.result_json, '$.modRevision')
))
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle mutation evidence fence failed');
END;

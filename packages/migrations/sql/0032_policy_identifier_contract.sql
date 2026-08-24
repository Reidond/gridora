-- Policy scheduler operation records are exposed by the same inventory/API
-- contracts as all other operations.  Earlier internal prefixes used `:`,
-- which is not accepted by OperationId or CorrelationId.  Replace the one
-- scope trigger that bound the legacy idempotency prefix; all other fences
-- and historical records remain immutable.
DROP TRIGGER policy_reconciliation_action_scope_guard;

CREATE TRIGGER policy_reconciliation_action_scope_guard
BEFORE INSERT ON policy_reconciliation_actions
WHEN NEW.dispatch_state <> 'pending'
  OR NEW.operation_id IS NOT NULL
  OR NEW.revision <> 1
  OR NEW.updated_at IS NOT NEW.created_at
  OR NOT EXISTS (
    SELECT 1
    FROM policy_reconciliation_runs run
    JOIN policy_reconciliation_schedule_leases lease
      ON lease.organization_id = run.organization_id AND lease.schedule_slot = run.schedule_slot
    JOIN organizations organization ON organization.id = run.organization_id
    JOIN organization_policies policy ON policy.organization_id = organization.id
    JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = organization.id AND scheduler.identity_id = NEW.actor_id
    JOIN identities actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id AND membership.identity_id = actor.id
    WHERE run.organization_id = NEW.organization_id AND run.run_id = NEW.run_id
      AND run.actor_id = NEW.actor_id AND run.policy_revision = NEW.policy_revision
      AND lease.actor_id = NEW.actor_id AND lease.policy_revision = NEW.policy_revision
      AND lease.run_id = run.run_id AND lease.idempotency_key = run.idempotency_key
      AND lease.lease_token = run.lease_token AND lease.state = 'running'
      AND julianday(lease.lease_until) > julianday(NEW.created_at)
      AND organization.status = 'active'
      AND organization.policy_revision = NEW.policy_revision
      AND policy.revision = NEW.policy_revision
      AND json_extract(policy.policy_json, '$.organizationId') = NEW.organization_id
      AND json_extract(policy.policy_json, '$.revision') = NEW.policy_revision
      AND actor.status = 'active'
      AND membership.status = 'active' AND membership.role = 'automation'
      AND EXISTS (
        SELECT 1 FROM operations operation
        WHERE operation.id = NEW.policy_operation_id
          AND operation.organization_id = NEW.organization_id
          AND operation.type = 'policy-reconciliation.' || NEW.action
          AND operation.resource_type = NEW.resource_kind AND operation.resource_id = NEW.resource_id
          AND operation.actor_id = NEW.actor_id
          AND operation.idempotency_key = 'policy-operation-' || NEW.idempotency_key
          AND operation.correlation_id = NEW.correlation_id
          AND operation.status = 'requested' AND operation.progress = 0
      )
      AND (
        (NEW.action = 'retire-node' AND EXISTS (
          SELECT 1 FROM nodes node
          WHERE node.organization_id = NEW.organization_id AND node.id = NEW.resource_id
            AND node.desired_revision = NEW.resource_revision
            AND node.desired_state NOT IN ('deleted', 'draining')
            AND node.observed_state <> 'deleted'
            AND node.temporary_expires_at = NEW.resource_expires_at
            AND julianday(node.temporary_expires_at) <= julianday(NEW.created_at)
            AND json_extract(policy.policy_json, '$.temporaryNodes.automaticExpiryRequired') = 1
        ))
        OR ((NEW.action = 'shutdown-server' OR NEW.action = 'delete-server') AND EXISTS (
          SELECT 1
          FROM game_servers server
          JOIN policy_reconciliation_server_activity activity
            ON activity.organization_id = server.organization_id AND activity.server_id = server.id
          JOIN health_current_snapshots health
            ON health.organization_id = server.organization_id
              AND health.resource_type = 'server' AND health.resource_id = server.id
          WHERE server.organization_id = NEW.organization_id AND server.id = NEW.resource_id
            AND server.desired_revision = NEW.resource_revision
            AND server.desired_state = 'running' AND server.observed_state = 'running'
            AND server.pending_lifecycle_operation_id IS NULL
            AND activity.last_player_activity_at = NEW.activity_last_at
            AND health.sampled_at = NEW.health_sampled_at
            AND health.revision = NEW.health_revision
            AND health.status = 'healthy'
            AND json_extract(health.summary_json, '$.game.process') = 'running'
            AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
            AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) = 0
            AND julianday(health.sampled_at) <= julianday(NEW.created_at)
            AND julianday(health.sampled_at) >= julianday(NEW.created_at, '-5 minutes')
            AND json_extract(policy.policy_json, '$.idle.action') =
              CASE WHEN NEW.action = 'shutdown-server' THEN 'shutdown' ELSE 'delete' END
            AND julianday(activity.last_player_activity_at) <=
              julianday(NEW.created_at) - json_extract(policy.policy_json, '$.idle.afterMinutes') / 1440.0
            AND (NEW.action <> 'delete-server'
              OR json_extract(policy.policy_json, '$.backups.requiredBeforeDelete') = 0
              OR EXISTS (
                SELECT 1 FROM backups backup
                WHERE backup.organization_id = server.organization_id AND backup.server_id = server.id
                  AND backup.state = 'available'
                  AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
                  AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER)
                    = server.desired_revision
              ))
        ))
        OR (NEW.action = 'update-server' AND EXISTS (
          SELECT 1
          FROM game_servers server
          JOIN policy_reconciliation_update_candidates candidate
            ON candidate.organization_id = server.organization_id AND candidate.server_id = server.id
          WHERE server.organization_id = NEW.organization_id AND server.id = NEW.resource_id
            AND server.desired_revision = NEW.resource_revision
            AND server.desired_state = 'running' AND server.observed_state = 'running'
            AND server.pending_lifecycle_operation_id IS NULL
            AND server.active_config_revision = NEW.config_revision
            AND COALESCE((SELECT mods.desired_revision FROM mod_sets mods
              WHERE mods.organization_id = server.organization_id AND mods.server_id = server.id), 0) = NEW.mod_revision
            AND candidate.id = NEW.update_candidate_id
            AND candidate.revision = NEW.update_candidate_revision
            AND candidate.category = NEW.update_category
            AND candidate.target_version = NEW.update_target_version
            AND candidate.status = 'active'
            AND json_extract(policy.policy_json, '$.updates.automatic') IN ('all', NEW.update_category)
            AND json_extract(policy.policy_json, '$.monthlyBudget.currency') IS NOT NULL
            AND (
              json_extract(policy.policy_json, '$.updates.requireMaintenanceWindow') = 0
              OR EXISTS (
                SELECT 1 FROM json_each(policy.policy_json, '$.maintenanceWindows') AS window
                WHERE ((
                  CAST(strftime('%w', NEW.created_at) AS INTEGER) * 1440
                  + CAST(strftime('%H', NEW.created_at) AS INTEGER) * 60
                  + CAST(strftime('%M', NEW.created_at) AS INTEGER)
                  - (json_extract(window.value, '$.dayOfWeekUtc') * 1440
                    + json_extract(window.value, '$.startMinuteUtc')) + 10080
                ) % 10080) < json_extract(window.value, '$.durationMinutes')
              )
            )
        ))
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'policy-reconciliation.' || NEW.action || '.accepted'
      AND audit.target_type = NEW.resource_kind AND audit.target_id = NEW.resource_id
      AND audit.result = 'succeeded' AND audit.correlation_id = NEW.correlation_id
      AND json_extract(audit.summary_json, '$.actionId') = NEW.id
      AND json_extract(audit.summary_json, '$.runId') = NEW.run_id
      AND json_extract(audit.summary_json, '$.operationId') = NEW.policy_operation_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM outbox event
    WHERE event.organization_id = NEW.organization_id AND event.id = NEW.outbox_event_id
      AND event.event_type = 'policy-reconciliation.action.accepted'
      AND event.aggregate_type = NEW.resource_kind AND event.aggregate_id = NEW.resource_id
      AND event.publish_state = 'pending'
      AND json_extract(event.payload_json, '$.actionId') = NEW.id
      AND json_extract(event.payload_json, '$.runId') = NEW.run_id
      AND json_extract(event.payload_json, '$.operationId') = NEW.policy_operation_id
  )
BEGIN SELECT RAISE(ABORT, 'policy reconciliation action scope fence failed'); END;

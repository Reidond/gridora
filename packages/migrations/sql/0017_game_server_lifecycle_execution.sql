PRAGMA foreign_keys = ON;

ALTER TABLE game_servers ADD COLUMN steam_credential_reference TEXT;

CREATE TRIGGER game_server_steam_credential_scope_guard_insert
BEFORE INSERT ON game_servers
WHEN NEW.steam_credential_reference IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM secret_envelopes envelope
    WHERE envelope.organization_id = NEW.organization_id
      AND envelope.id = NEW.steam_credential_reference
      AND envelope.scope_type = 'steam-account'
  )
BEGIN
  SELECT RAISE(ABORT, 'game Steam credential scope mismatch');
END;

CREATE TRIGGER game_server_steam_credential_scope_guard_update
BEFORE UPDATE OF steam_credential_reference ON game_servers
WHEN NEW.steam_credential_reference IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM secret_envelopes envelope
    WHERE envelope.organization_id = NEW.organization_id
      AND envelope.id = NEW.steam_credential_reference
      AND envelope.scope_type = 'steam-account'
  )
BEGIN
  SELECT RAISE(ABORT, 'game Steam credential scope mismatch');
END;

-- Game mutations are accepted independently from the eventual agent observation.  The
-- idempotency row is the durable correlation point for HTTP retries, Workflow retries,
-- and response-loss recovery.  It deliberately stores only a digest and redacted result.
CREATE TABLE game_lifecycle_mutations (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'create', 'delete', 'start', 'stop', 'restart', 'update', 'apply-config', 'sync-mods'
  )),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_lifecycle_mutations_server
  ON game_lifecycle_mutations(organization_id, server_id, created_at DESC);

-- A command may be delivered at least once.  This table makes each step replayable and
-- permits reconciliation to distinguish a lost response from a second command payload.
CREATE TABLE game_command_deliveries (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'completed', 'failed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, step_name),
  UNIQUE (organization_id, command_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_command_deliveries_pending
  ON game_command_deliveries(state, updated_at, organization_id, operation_id);

-- Observations are append-only by (tenant, server, observed revision).  The reducer may
-- only advance from a prior revision and never turns a command acknowledgement into
-- success without this authoritative observation evidence.
CREATE TABLE game_observation_reductions (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  observed_revision INTEGER NOT NULL CHECK (observed_revision > 0),
  observed_state TEXT NOT NULL CHECK (observed_state IN (
    'unknown', 'planning', 'installing', 'starting', 'running', 'stopping', 'stopped',
    'updating', 'backing_up', 'restoring', 'moving', 'repairing', 'deleting', 'deleted', 'failed'
  )),
  operation_id TEXT,
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, server_id, observed_revision),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_observation_reductions_latest
  ON game_observation_reductions(organization_id, server_id, observed_revision DESC);

-- A reducer cannot advance a server from a foreign operation or skip an observed revision.
CREATE TRIGGER game_observation_reduction_fence
BEFORE INSERT ON game_observation_reductions
WHEN NOT EXISTS (
  SELECT 1 FROM game_servers server
  WHERE server.organization_id = NEW.organization_id
    AND server.id = NEW.server_id
    AND server.observed_revision + 1 = NEW.observed_revision
)
BEGIN
  SELECT RAISE(ABORT, 'game observation revision fence failed');
END;

CREATE TRIGGER game_observation_reduction_apply
AFTER INSERT ON game_observation_reductions
BEGIN
  UPDATE game_servers
  SET observed_state = NEW.observed_state,
      observed_revision = NEW.observed_revision,
      pending_lifecycle_operation_id = CASE
        WHEN pending_lifecycle_operation_id = NEW.operation_id THEN NULL
        ELSE pending_lifecycle_operation_id
      END,
      reconciliation_error = CASE
        WHEN NEW.observed_state = 'failed' THEN json_extract(NEW.observation_json, '$.error')
        ELSE NULL
      END,
      last_reconciled_at = NEW.observed_at,
      updated_at = NEW.observed_at
  WHERE organization_id = NEW.organization_id AND id = NEW.server_id
    AND observed_revision + 1 = NEW.observed_revision;
END;

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
    AND audit.target_type = 'game_server'
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

CREATE TRIGGER game_observation_operation_completion
AFTER UPDATE OF observed_state ON game_servers
WHEN NEW.pending_lifecycle_operation_id IS NULL
  AND OLD.pending_lifecycle_operation_id IS NOT NULL
  AND NEW.observed_state IN ('running', 'stopped', 'deleted')
  AND (
    (NEW.desired_state = 'running' AND NEW.observed_state = 'running')
    OR (NEW.desired_state = 'stopped' AND NEW.observed_state = 'stopped')
    OR (NEW.desired_state = 'deleted' AND NEW.observed_state = 'deleted')
  )
BEGIN
  UPDATE operations
  SET status = 'succeeded', progress = 100, updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND id = OLD.pending_lifecycle_operation_id
    AND resource_type = 'server'
    AND resource_id = NEW.id
    AND status IN ('queued', 'running', 'waiting_external', 'retrying');
END;

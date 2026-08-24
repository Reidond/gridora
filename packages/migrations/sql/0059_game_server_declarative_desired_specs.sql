PRAGMA foreign_keys = ON;

-- Public declarative state is stored separately from runtime/deployment facts.
-- The JSON can contain only the normalized manifest spec, never provider
-- credentials, a commercial review proof, image/catalog selection, or agent
--/Workflow evidence. Every row is bound to the accepted operation and the
-- corresponding game-server desired revision.
CREATE TABLE game_server_desired_specs (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  source_operation_id TEXT NOT NULL,
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, server_id),
  UNIQUE (organization_id, source_operation_id),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_server_desired_specs_source
  ON game_server_desired_specs(organization_id, source_operation_id, desired_revision);

-- Each policy-only manifest apply is a terminal, auditable mutation. The
-- lifecycle operation table remains reserved for work that dispatches a
-- server Workflow, so a future-policy change cannot claim a runtime effect.
CREATE TABLE game_server_manifest_mutations (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  desired_revision INTEGER NOT NULL CHECK (desired_revision > expected_revision),
  acceptance_audit_event_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  UNIQUE (acceptance_audit_event_id),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_audit_event_id)
    REFERENCES audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_server_desired_spec_insert_guard
BEFORE INSERT ON game_server_desired_specs
WHEN NEW.schema_version <> 1
  OR NOT EXISTS (
    SELECT 1
    FROM game_servers server
    JOIN operations operation
      ON operation.organization_id = server.organization_id
     AND operation.id = NEW.source_operation_id
    WHERE server.organization_id = NEW.organization_id
      AND server.id = NEW.server_id
      AND server.desired_revision = NEW.desired_revision
      AND operation.resource_type = 'server'
      AND operation.resource_id = NEW.server_id
      AND operation.status IN ('queued', 'succeeded')
  )
BEGIN
  SELECT RAISE(ABORT, 'game server desired spec insert fence failed');
END;

CREATE TRIGGER game_server_desired_spec_update_guard
BEFORE UPDATE ON game_server_desired_specs
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.desired_revision <> OLD.desired_revision + 1
  OR NOT EXISTS (
    SELECT 1
    FROM game_servers server
    JOIN operations operation
      ON operation.organization_id = server.organization_id
     AND operation.id = NEW.source_operation_id
    WHERE server.organization_id = NEW.organization_id
      AND server.id = NEW.server_id
      AND server.desired_revision = NEW.desired_revision
      AND operation.resource_type = 'server'
      AND operation.resource_id = NEW.server_id
      AND operation.status IN ('queued', 'succeeded')
  )
BEGIN
  SELECT RAISE(ABORT, 'game server desired spec update fence failed');
END;

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
    AND operation.type = 'server.manifest.policy.update'
    AND operation.status = 'succeeded'
    AND operation.progress = 100
    AND audit.target_type = 'server'
    AND audit.target_id = NEW.server_id
    AND audit.action = 'game-server.manifest.policy.update.accepted'
    AND audit.result = 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'game server manifest mutation insert fence failed');
END;

PRAGMA foreign_keys = ON;

-- A live game-specific metadata lookup is an acceptance fact, not an
-- ephemeral planning hint. Keep the exact normalized catalog and transport
-- provenance immutable and operation-bound so later installs, audits, and
-- incident review can explain which upstream facts selected a mod version.
CREATE TABLE game_mod_metadata_acceptances (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('resolved', 'offline')),
  catalog_json TEXT NOT NULL CHECK (json_valid(catalog_json) AND json_type(catalog_json) = 'array'),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'array'),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (plugin_id, plugin_version)
    REFERENCES game_plugins(id, version) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_mod_metadata_acceptances_server
  ON game_mod_metadata_acceptances(organization_id, server_id, created_at DESC);

CREATE TRIGGER game_mod_metadata_acceptance_insert_fence
BEFORE INSERT ON game_mod_metadata_acceptances
WHEN NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN game_lifecycle_mutations mutation
    ON mutation.organization_id = operation.organization_id
   AND mutation.operation_id = operation.id
  JOIN game_servers server
    ON server.organization_id = operation.organization_id
   AND server.id = operation.resource_id
  JOIN server_create_reservations reservation
    ON reservation.organization_id = operation.organization_id
   AND reservation.operation_id = operation.id
   AND reservation.server_id = server.id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.type = 'server.create'
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND operation.status = 'queued'
    AND mutation.action = 'create'
    AND mutation.server_id = NEW.server_id
    AND server.plugin_id = NEW.plugin_id
    AND server.plugin_version = NEW.plugin_version
    AND reservation.plugin_id = NEW.plugin_id
    AND reservation.plugin_version = NEW.plugin_version
)
OR json_array_length(NEW.catalog_json) > 256
OR json_array_length(NEW.provenance_json) > 512
OR json_array_length(NEW.warnings_json) > 256
BEGIN
  SELECT RAISE(ABORT, 'game mod metadata acceptance fence failed');
END;

CREATE TRIGGER game_mod_metadata_acceptance_immutable_update
BEFORE UPDATE ON game_mod_metadata_acceptances
BEGIN
  SELECT RAISE(ABORT, 'game mod metadata acceptance is immutable');
END;

CREATE TRIGGER game_mod_metadata_acceptance_immutable_delete
BEFORE DELETE ON game_mod_metadata_acceptances
BEGIN
  SELECT RAISE(ABORT, 'game mod metadata acceptance is immutable');
END;

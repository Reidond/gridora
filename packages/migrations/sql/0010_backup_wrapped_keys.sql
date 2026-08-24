PRAGMA foreign_keys = ON;

CREATE TABLE backup_wrapped_keys (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  wrapped_data_key TEXT NOT NULL CHECK (
    length(wrapped_data_key) BETWEEN 1 AND 16384
    AND wrapped_data_key NOT GLOB '*[^A-Za-z0-9+/=]*'
  ),
  revision INTEGER NOT NULL CHECK (revision = 1),
  PRIMARY KEY (organization_id, server_id, backup_id),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id)
    REFERENCES backups(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_wrapped_keys_backup_scope_guard
BEFORE INSERT ON backup_wrapped_keys
WHEN NOT EXISTS (
  SELECT 1
  FROM backups
  WHERE organization_id = NEW.organization_id
    AND id = NEW.backup_id
    AND server_id = NEW.server_id
)
BEGIN
  SELECT RAISE(ABORT, 'backup wrapped key scope mismatch');
END;

CREATE TRIGGER backup_wrapped_keys_immutable
BEFORE UPDATE ON backup_wrapped_keys
BEGIN
  SELECT RAISE(ABORT, 'backup wrapped key is immutable');
END;

CREATE TRIGGER backup_wrapped_keys_no_delete
BEFORE DELETE ON backup_wrapped_keys
BEGIN
  SELECT RAISE(ABORT, 'backup wrapped key is immutable');
END;

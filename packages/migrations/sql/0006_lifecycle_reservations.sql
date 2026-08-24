PRAGMA foreign_keys = ON;

ALTER TABLE nodes ADD COLUMN pending_lifecycle_operation_id TEXT;
ALTER TABLE game_servers ADD COLUMN pending_lifecycle_operation_id TEXT;

CREATE TABLE lifecycle_workflow_starts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  start_record_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'started')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (start_record_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX lifecycle_workflow_starts_pending
ON lifecycle_workflow_starts(state, updated_at, organization_id, operation_id);

CREATE TABLE lifecycle_reservations (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('node', 'server')),
  resource_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  reservation_json TEXT NOT NULL CHECK (json_valid(reservation_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX lifecycle_reservations_resource
ON lifecycle_reservations(organization_id, resource_kind, resource_id, created_at DESC);

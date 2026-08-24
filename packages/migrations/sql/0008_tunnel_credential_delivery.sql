PRAGMA foreign_keys = ON;

CREATE TABLE node_installer_keys (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL CHECK (
    substr(public_key_fingerprint, 1, 7) = 'sha256:'
    AND substr(public_key_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    AND length(public_key_fingerprint) = 71
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  registered_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE tunnel_credential_deliveries (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  tunnel_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('install', 'rotate', 'revoke')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  expected_prior_revision INTEGER NOT NULL CHECK (expected_prior_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('issuing', 'queued', 'delivered', 'acknowledged', 'revoked', 'failed')),
  installer_key_fingerprint TEXT NOT NULL,
  command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json)),
  command_fingerprint TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  PRIMARY KEY (organization_id, delivery_id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, node_id, tunnel_id, revision),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id) REFERENCES node_installer_keys(organization_id, node_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  CHECK (revision = expected_prior_revision + 1),
  CHECK ((state = 'issuing' AND command_json IS NULL AND command_fingerprint IS NULL)
    OR (state <> 'issuing' AND command_json IS NOT NULL AND command_fingerprint IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE TRIGGER tunnel_credential_delivery_scope_guard
BEFORE INSERT ON tunnel_credential_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM tunnels
  WHERE organization_id = NEW.organization_id
    AND node_id = NEW.node_id
    AND tunnel_id = NEW.tunnel_id
    AND state <> 'deleted'
)
BEGIN
  SELECT RAISE(ABORT, 'tunnel credential delivery scope mismatch');
END;

CREATE INDEX tunnel_credential_deliveries_pending
ON tunnel_credential_deliveries(state, updated_at, organization_id, node_id);

CREATE UNIQUE INDEX outbox_tunnel_credential_delivery_once
ON outbox(organization_id, event_type, aggregate_type, aggregate_id)
WHERE event_type = 'agent.command.sealed' AND aggregate_type = 'tunnel_credential_delivery';

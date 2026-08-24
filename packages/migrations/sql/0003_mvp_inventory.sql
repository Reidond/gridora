PRAGMA foreign_keys = ON;

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'organization')),
  organization_id TEXT,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  credential_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'error')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CHECK ((scope = 'platform' AND organization_id IS NULL) OR (scope = 'organization' AND organization_id IS NOT NULL)),
  UNIQUE (organization_id, id)
) STRICT;

CREATE TABLE provider_allocations (
  organization_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  allowed_regions_json TEXT NOT NULL CHECK (json_valid(allowed_regions_json)),
  allowed_plans_json TEXT NOT NULL CHECK (json_valid(allowed_plans_json)),
  max_active_nodes INTEGER NOT NULL CHECK (max_active_nodes >= 0),
  monthly_budget_minor INTEGER CHECK (monthly_budget_minor IS NULL OR monthly_budget_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, provider_account_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER provider_allocations_scope_guard_insert
BEFORE INSERT ON provider_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM provider_accounts
  WHERE id = NEW.provider_account_id
    AND (scope = 'platform' OR organization_id = NEW.organization_id)
)
BEGIN
  SELECT RAISE(ABORT, 'provider account scope mismatch');
END;

CREATE TRIGGER provider_allocations_scope_guard_update
BEFORE UPDATE OF organization_id, provider_account_id ON provider_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM provider_accounts
  WHERE id = NEW.provider_account_id
    AND (scope = 'platform' OR organization_id = NEW.organization_id)
)
BEGIN
  SELECT RAISE(ABORT, 'provider account scope mismatch');
END;

CREATE TRIGGER provider_accounts_allocation_identity_immutable
BEFORE UPDATE OF scope, organization_id, provider_type ON provider_accounts
WHEN EXISTS (
  SELECT 1 FROM provider_allocations WHERE provider_account_id = OLD.id
)
AND (
  OLD.scope IS NOT NEW.scope
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.provider_type IS NOT NEW.provider_type
)
BEGIN
  SELECT RAISE(ABORT, 'allocated provider account identity is immutable');
END;

CREATE TABLE provider_catalog (
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  region TEXT NOT NULL,
  plan TEXT NOT NULL,
  currency TEXT NOT NULL,
  hourly_price_minor INTEGER CHECK (hourly_price_minor IS NULL OR hourly_price_minor >= 0),
  monthly_price_minor INTEGER CHECK (monthly_price_minor IS NULL OR monthly_price_minor >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (provider_type, region, plan)
) WITHOUT ROWID, STRICT;

CREATE TABLE node_images (
  id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  signature TEXT NOT NULL,
  provider_mappings_json TEXT NOT NULL CHECK (json_valid(provider_mappings_json)),
  status TEXT NOT NULL CHECK (status IN ('building', 'candidate', 'promoted', 'retired', 'failed')),
  created_at TEXT NOT NULL,
  promoted_at TEXT
) STRICT;

CREATE TABLE nodes (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_instance_id TEXT,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  region TEXT NOT NULL,
  plan TEXT NOT NULL,
  image_id TEXT NOT NULL,
  placement_mode TEXT NOT NULL CHECK (placement_mode IN ('dedicated', 'shared')),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('provisioning', 'ready', 'draining', 'stopped', 'deleted')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'provisioning', 'bootstrapping', 'ready', 'degraded', 'offline', 'deleting', 'deleted', 'failed')),
  desired_revision INTEGER NOT NULL DEFAULT 1 CHECK (desired_revision > 0),
  observed_revision INTEGER NOT NULL DEFAULT 0 CHECK (observed_revision >= 0),
  reconciliation_error TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, provider_account_id) REFERENCES provider_allocations(organization_id, provider_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, id, provider_instance_id),
  UNIQUE (provider_type, provider_instance_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER nodes_provider_type_guard_insert
BEFORE INSERT ON nodes
WHEN NOT EXISTS (
  SELECT 1 FROM provider_accounts
  WHERE id = NEW.provider_account_id AND provider_type = NEW.provider_type
)
BEGIN
  SELECT RAISE(ABORT, 'node provider type mismatch');
END;

CREATE TRIGGER nodes_provider_type_guard_update
BEFORE UPDATE OF provider_account_id, provider_type ON nodes
WHEN NOT EXISTS (
  SELECT 1 FROM provider_accounts
  WHERE id = NEW.provider_account_id AND provider_type = NEW.provider_type
)
BEGIN
  SELECT RAISE(ABORT, 'node provider type mismatch');
END;

CREATE INDEX nodes_reconcile ON nodes(organization_id, desired_state, observed_state, updated_at);
CREATE INDEX nodes_capacity_candidates ON nodes(organization_id, placement_mode, observed_state, region);

CREATE TABLE node_capacity (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  cpu_millis_total INTEGER NOT NULL CHECK (cpu_millis_total > 0),
  cpu_millis_reserved INTEGER NOT NULL DEFAULT 0 CHECK (cpu_millis_reserved >= 0),
  memory_bytes_total INTEGER NOT NULL CHECK (memory_bytes_total > 0),
  memory_bytes_reserved INTEGER NOT NULL DEFAULT 0 CHECK (memory_bytes_reserved >= 0),
  disk_bytes_total INTEGER NOT NULL CHECK (disk_bytes_total > 0),
  disk_bytes_reserved INTEGER NOT NULL DEFAULT 0 CHECK (disk_bytes_reserved >= 0),
  observed_usage_json TEXT NOT NULL CHECK (json_valid(observed_usage_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  CHECK (cpu_millis_reserved <= cpu_millis_total),
  CHECK (memory_bytes_reserved <= memory_bytes_total),
  CHECK (disk_bytes_reserved <= disk_bytes_total)
) WITHOUT ROWID, STRICT;

CREATE TABLE tunnels (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  tunnel_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'connected', 'degraded', 'deleted', 'failed')),
  credential_reference TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (tunnel_id),
  UNIQUE (hostname)
) WITHOUT ROWID, STRICT;

CREATE TABLE game_plugins (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  api_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'disabled', 'retired')),
  capability_manifest_json TEXT NOT NULL CHECK (json_valid(capability_manifest_json)),
  config_schema_version INTEGER NOT NULL CHECK (config_schema_version > 0),
  PRIMARY KEY (id, version)
) WITHOUT ROWID, STRICT;

CREATE TABLE game_servers (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'deleted')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'planning', 'installing', 'starting', 'running', 'stopping', 'stopped', 'updating', 'backing_up', 'restoring', 'moving', 'repairing', 'deleting', 'deleted', 'failed')),
  placement_policy_json TEXT NOT NULL CHECK (json_valid(placement_policy_json)),
  domain TEXT,
  desired_revision INTEGER NOT NULL DEFAULT 1 CHECK (desired_revision > 0),
  observed_revision INTEGER NOT NULL DEFAULT 0 CHECK (observed_revision >= 0),
  active_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (active_config_revision > 0),
  reconciliation_error TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (plugin_id, plugin_version) REFERENCES game_plugins(id, version) ON DELETE RESTRICT,
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, domain)
) WITHOUT ROWID, STRICT;

CREATE INDEX game_servers_reconcile ON game_servers(organization_id, desired_state, observed_state, updated_at);

CREATE TABLE game_server_config_revisions (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, server_id, revision),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE deployments (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  observed_revision INTEGER NOT NULL DEFAULT 0 CHECK (observed_revision >= 0),
  installed_build TEXT,
  observed_state TEXT NOT NULL,
  reconciliation_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, server_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX deployments_node ON deployments(organization_id, node_id, observed_state);

CREATE TABLE port_leases (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('tcp', 'udp')),
  public_port INTEGER NOT NULL CHECK (public_port BETWEEN 1 AND 65535),
  container_port INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'releasing', 'released')),
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE UNIQUE INDEX port_leases_live_port
ON port_leases(organization_id, node_id, protocol, public_port)
WHERE state <> 'released';

CREATE TABLE dns_records (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  provider_record_id TEXT,
  hostname TEXT NOT NULL,
  target TEXT NOT NULL,
  proxy_mode TEXT NOT NULL CHECK (proxy_mode IN ('dns_only', 'proxied', 'tunnel')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'deleting', 'deleted', 'failed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, hostname)
) WITHOUT ROWID, STRICT;

CREATE TABLE mod_sets (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  resolved_revision INTEGER NOT NULL DEFAULT 0 CHECK (resolved_revision >= 0),
  desired_json TEXT NOT NULL CHECK (json_valid(desired_json)),
  resolved_json TEXT NOT NULL CHECK (json_valid(resolved_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, server_id),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE backups (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  encryption_version INTEGER NOT NULL CHECK (encryption_version > 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  state TEXT NOT NULL CHECK (state IN ('creating', 'available', 'restoring', 'expired', 'deleted', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, r2_key),
  CHECK (r2_key LIKE 'organizations/' || organization_id || '/%')
) WITHOUT ROWID, STRICT;

CREATE TABLE node_registration_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  credential_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  issued_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, node_id, provider_instance_id)
    REFERENCES nodes(organization_id, id, provider_instance_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER node_registration_tokens_operation_guard
BEFORE INSERT ON node_registration_tokens
WHEN NOT EXISTS (
  SELECT 1 FROM operations
  WHERE organization_id = NEW.organization_id
    AND id = NEW.operation_id
    AND resource_type = 'node'
    AND resource_id = NEW.node_id
)
BEGIN
  SELECT RAISE(ABORT, 'registration operation does not own node');
END;

CREATE TABLE node_credentials (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  id TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, node_id, id),
  UNIQUE (organization_id, node_id, version)
) WITHOUT ROWID, STRICT;

CREATE UNIQUE INDEX node_credentials_one_active
ON node_credentials(organization_id, node_id)
WHERE status = 'active';

CREATE TABLE agent_sessions (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  session_version INTEGER NOT NULL CHECK (session_version > 0),
  agent_version TEXT NOT NULL,
  session_state TEXT NOT NULL CHECK (session_state IN ('connected', 'disconnected', 'revoked')),
  last_seen_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE health_snapshots (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  sampled_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX health_snapshots_resource ON health_snapshots(organization_id, resource_type, resource_id, sampled_at DESC);

CREATE TABLE secret_envelopes (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, scope_type, scope_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE organization_policies (
  organization_id TEXT PRIMARY KEY NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE organization_terms_acceptances (
  organization_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, identity_id, terms_version),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE automation_identities (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  credential_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  last_used_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES identities(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, name)
) WITHOUT ROWID, STRICT;

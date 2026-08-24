PRAGMA foreign_keys = ON;

-- Archived log metadata is bounded control-plane state.  The bytes live only in a
-- tenant-prefixed R2 object and are never copied into D1.
CREATE TABLE log_archives (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  compression TEXT NOT NULL CHECK (compression = 'gzip'),
  first_timestamp TEXT NOT NULL,
  last_timestamp TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 1 AND 10000),
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes BETWEEN 1 AND 8388608),
  compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 71 AND sha256 LIKE 'sha256:%' AND substr(sha256, 8) NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'available', 'expired', 'deleted', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, r2_key),
  CHECK (r2_key LIKE 'organizations/' || organization_id || '/logs/' || server_id || '/%'),
  CHECK (last_timestamp >= first_timestamp)
) WITHOUT ROWID, STRICT;

CREATE INDEX log_archives_server_time
  ON log_archives(organization_id, server_id, last_timestamp DESC, id DESC);

-- The archive catalog is not the delivery cursor.  This one-row watermark is the
-- authenticated node's contiguous sequence evidence for loss/replay detection.
CREATE TABLE log_stream_watermarks (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  last_timestamp TEXT NOT NULL,
  last_fingerprint TEXT NOT NULL CHECK (length(last_fingerprint) = 64 AND last_fingerprint NOT GLOB '*[^a-f0-9]*'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER log_archives_scope_guard_insert
BEFORE INSERT ON log_archives
WHEN NOT EXISTS (
  SELECT 1 FROM deployments deployment
  WHERE deployment.organization_id = NEW.organization_id
    AND deployment.server_id = NEW.server_id
    AND deployment.node_id = NEW.node_id
)
BEGIN
  SELECT RAISE(ABORT, 'log archive server and node scope mismatch');
END;

CREATE TRIGGER log_archives_metadata_immutable
BEFORE UPDATE ON log_archives
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.id IS NOT OLD.id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.r2_key IS NOT OLD.r2_key
  OR NEW.compression IS NOT OLD.compression
  OR NEW.first_timestamp IS NOT OLD.first_timestamp
  OR NEW.last_timestamp IS NOT OLD.last_timestamp
  OR NEW.entry_count IS NOT OLD.entry_count
  OR NEW.uncompressed_bytes IS NOT OLD.uncompressed_bytes
  OR NEW.compressed_bytes IS NOT OLD.compressed_bytes
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'log archive metadata is immutable');
END;

-- One current aggregate and at most one low-frequency bucket per hour are retained.
-- This explicitly prevents high-frequency raw telemetry from becoming D1 history.
CREATE TABLE health_current_snapshots (
  organization_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('node', 'server', 'container')),
  resource_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 8192),
  sampled_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, resource_type, resource_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE health_hourly_snapshots (
  organization_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('node', 'server', 'container')),
  resource_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT,
  bucket_start TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 8192),
  sampled_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, resource_type, resource_id, bucket_start),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX health_hourly_timeline
  ON health_hourly_snapshots(organization_id, resource_type, resource_id, sampled_at DESC);

CREATE TRIGGER health_current_scope_guard_insert
BEFORE INSERT ON health_current_snapshots
WHEN (NEW.resource_type = 'node' AND (NEW.resource_id IS NOT NEW.node_id OR NEW.server_id IS NOT NULL))
  OR (NEW.resource_type = 'server' AND (NEW.server_id IS NULL OR NEW.resource_id IS NOT NEW.server_id))
  OR (NEW.resource_type = 'container' AND NEW.server_id IS NULL)
  OR (NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'health current resource scope mismatch');
END;

CREATE TRIGGER health_current_scope_guard_update
BEFORE UPDATE ON health_current_snapshots
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR (NEW.resource_type = 'node' AND (NEW.resource_id IS NOT NEW.node_id OR NEW.server_id IS NOT NULL))
  OR (NEW.resource_type = 'server' AND (NEW.server_id IS NULL OR NEW.resource_id IS NOT NEW.server_id))
  OR (NEW.resource_type = 'container' AND NEW.server_id IS NULL)
  OR (NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'health current resource scope mismatch');
END;

CREATE TRIGGER health_hourly_scope_guard_insert
BEFORE INSERT ON health_hourly_snapshots
WHEN (NEW.resource_type = 'node' AND (NEW.resource_id IS NOT NEW.node_id OR NEW.server_id IS NOT NULL))
  OR (NEW.resource_type = 'server' AND (NEW.server_id IS NULL OR NEW.resource_id IS NOT NEW.server_id))
  OR (NEW.resource_type = 'container' AND NEW.server_id IS NULL)
  OR (NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'health hourly resource scope mismatch');
END;

CREATE TRIGGER health_hourly_scope_guard_update
BEFORE UPDATE ON health_hourly_snapshots
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.bucket_start IS NOT OLD.bucket_start
  OR (NEW.resource_type = 'node' AND (NEW.resource_id IS NOT NEW.node_id OR NEW.server_id IS NOT NULL))
  OR (NEW.resource_type = 'server' AND (NEW.server_id IS NULL OR NEW.resource_id IS NOT NEW.server_id))
  OR (NEW.resource_type = 'container' AND NEW.server_id IS NULL)
  OR (NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'health hourly resource scope mismatch');
END;

CREATE TABLE health_alerts (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('node', 'server', 'container')),
  resource_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64 AND type NOT GLOB '*[^a-z0-9._-]*' AND type GLOB '[a-z0-9]*'),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 512),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, fingerprint),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX health_alerts_open
  ON health_alerts(organization_id, state, last_seen_at DESC);

CREATE TRIGGER health_alert_scope_guard_insert
BEFORE INSERT ON health_alerts
WHEN (NEW.resource_type = 'node' AND (NEW.resource_id IS NOT NEW.node_id OR NEW.server_id IS NOT NULL))
  OR (NEW.resource_type = 'server' AND (NEW.server_id IS NULL OR NEW.resource_id IS NOT NEW.server_id))
  OR (NEW.resource_type = 'container' AND NEW.server_id IS NULL)
  OR (NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'health alert resource scope mismatch');
END;

CREATE TRIGGER health_alert_scope_guard_update
BEFORE UPDATE ON health_alerts
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.id IS NOT OLD.id
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR (NEW.resource_type = 'node' AND (NEW.resource_id IS NOT NEW.node_id OR NEW.server_id IS NOT NULL))
  OR (NEW.resource_type = 'server' AND (NEW.server_id IS NULL OR NEW.resource_id IS NOT NEW.server_id))
  OR (NEW.resource_type = 'container' AND NEW.server_id IS NULL)
  OR (NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'health alert resource scope mismatch');
END;

PRAGMA foreign_keys = ON;

-- `audit_events.actor_id` is intentionally a local-identity foreign key. A
-- machine credential is not an Access identity, so the telemetry boundary
-- creates a deterministic, suspended internal identity only for audit
-- referential integrity. The v1 audit actor is that deterministic machine
-- identity; credential/session versions remain receipt evidence rather than
-- acting as an identity.
CREATE TABLE machine_audit_identities (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  identity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id, credential_id, credential_version),
  UNIQUE (identity_id),
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER machine_audit_identity_immutable_update
BEFORE UPDATE ON machine_audit_identities
BEGIN
  SELECT RAISE(ABORT, 'machine audit identity is immutable');
END;

CREATE TRIGGER machine_audit_identity_immutable_delete
BEFORE DELETE ON machine_audit_identities
BEGIN
  SELECT RAISE(ABORT, 'machine audit identity cannot be deleted');
END;

CREATE TRIGGER machine_audit_identity_scope_guard
BEFORE INSERT ON machine_audit_identities
WHEN NOT EXISTS (
  SELECT 1 FROM node_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.node_id = NEW.node_id
    AND credential.id = NEW.credential_id
    AND credential.version = NEW.credential_version
)
BEGIN
  SELECT RAISE(ABORT, 'machine audit identity credential scope mismatch');
END;

-- Agent telemetry has a server-required log scope. Keep its cursor separate
-- from the older node-global log cursor so a sequence for one deployment can
-- never advance or replay a different server's evidence on the same node.
CREATE TABLE telemetry_log_stream_watermarks (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  last_timestamp TEXT NOT NULL,
  last_fingerprint TEXT NOT NULL CHECK (
    length(last_fingerprint) = 64 AND last_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, node_id, server_id),
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER telemetry_log_stream_watermark_scope_guard
BEFORE INSERT ON telemetry_log_stream_watermarks
WHEN NOT EXISTS (
  SELECT 1 FROM deployments deployment
  WHERE deployment.organization_id = NEW.organization_id
    AND deployment.node_id = NEW.node_id
    AND deployment.server_id = NEW.server_id
    AND deployment.observed_state = 'running'
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry log watermark deployment scope mismatch');
END;

CREATE TRIGGER telemetry_log_stream_watermark_immutable_identity
BEFORE UPDATE ON telemetry_log_stream_watermarks
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.server_id IS NOT OLD.server_id
BEGIN
  SELECT RAISE(ABORT, 'telemetry log watermark scope is immutable');
END;

CREATE TRIGGER telemetry_log_stream_watermark_forward_only
BEFORE UPDATE ON telemetry_log_stream_watermarks
WHEN NEW.last_sequence <= OLD.last_sequence
  OR NEW.last_timestamp < OLD.last_timestamp
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'telemetry log watermark must advance monotonically');
END;

CREATE TRIGGER telemetry_log_stream_watermark_immutable_delete
BEFORE DELETE ON telemetry_log_stream_watermarks
BEGIN
  SELECT RAISE(ABORT, 'telemetry log watermark cannot be deleted');
END;

-- One receipt is the loss-response authority for one exact machine payload.
-- It contains no raw log body and no credential secret.
CREATE TABLE telemetry_ingestion_receipts (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  session_version INTEGER NOT NULL CHECK (session_version > 0),
  machine_identity_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  health_sampled_at TEXT NOT NULL,
  health_summary_json TEXT NOT NULL CHECK (json_valid(health_summary_json) AND length(health_summary_json) <= 8192),
  health_hour_bucket TEXT NOT NULL,
  server_id TEXT,
  deployment_id TEXT,
  log_first_sequence INTEGER,
  log_last_sequence INTEGER,
  log_last_timestamp TEXT,
  log_fingerprint TEXT,
  archive_id TEXT,
  archive_r2_key TEXT,
  archive_sha256 TEXT,
  archive_entry_count INTEGER,
  archive_uncompressed_bytes INTEGER,
  archive_compressed_bytes INTEGER,
  operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, node_id, credential_id, credential_version, session_version, payload_fingerprint),
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (machine_identity_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (server_id IS NULL AND deployment_id IS NULL AND log_first_sequence IS NULL
      AND log_last_sequence IS NULL AND log_last_timestamp IS NULL AND log_fingerprint IS NULL
      AND archive_id IS NULL AND archive_r2_key IS NULL AND archive_sha256 IS NULL
      AND archive_entry_count IS NULL AND archive_uncompressed_bytes IS NULL
      AND archive_compressed_bytes IS NULL)
    OR
    (server_id IS NOT NULL AND deployment_id IS NOT NULL AND log_first_sequence >= 1
      AND log_last_sequence >= log_first_sequence AND log_last_timestamp IS NOT NULL
      AND length(log_fingerprint) = 64 AND log_fingerprint NOT GLOB '*[^a-f0-9]*'
      AND archive_id IS NOT NULL AND archive_r2_key IS NOT NULL
      AND length(archive_sha256) = 71 AND archive_sha256 LIKE 'sha256:%'
      AND archive_entry_count >= 1 AND archive_uncompressed_bytes >= 1
      AND archive_compressed_bytes >= 1)
  ),
  CHECK (accepted_at = health_sampled_at),
  CHECK (health_hour_bucket <= health_sampled_at)
) WITHOUT ROWID, STRICT;

CREATE INDEX telemetry_ingestion_receipts_node_time
  ON telemetry_ingestion_receipts(organization_id, node_id, accepted_at DESC);

-- The final receipt is allowed only after the same atomic D1 batch has made
-- the exact aggregate and, when present, exact archive/watermark evidence.
CREATE TRIGGER telemetry_ingestion_receipt_evidence_guard
BEFORE INSERT ON telemetry_ingestion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN node_credentials credential
    ON credential.organization_id = NEW.organization_id
   AND credential.node_id = NEW.node_id
   AND credential.id = NEW.credential_id
   AND credential.version = NEW.credential_version
   AND credential.status = 'active'
  -- Re-check the authoritative node lifecycle state in the final receipt
  -- transaction. The ingress read is intentionally not relied on here: a
  -- node can be deleted between authentication and the D1 evidence batch.
  JOIN nodes node
    ON node.organization_id = credential.organization_id
   AND node.id = credential.node_id
   AND node.desired_state <> 'deleted'
   AND node.observed_state <> 'deleted'
  JOIN agent_sessions session
    ON session.organization_id = credential.organization_id
   AND session.node_id = credential.node_id
   AND session.credential_id = credential.id
   AND session.session_version = NEW.session_version
   AND session.session_state = 'connected'
  JOIN machine_audit_identities machine_identity
    ON machine_identity.organization_id = credential.organization_id
   AND machine_identity.node_id = credential.node_id
   AND machine_identity.credential_id = credential.id
   AND machine_identity.credential_version = credential.version
   AND machine_identity.identity_id = NEW.machine_identity_id
  JOIN operations operation
    ON operation.organization_id = NEW.organization_id
   AND operation.id = NEW.operation_id
   AND operation.type = 'agent.telemetry'
   AND operation.resource_type = 'node'
   AND operation.resource_id = NEW.node_id
   AND operation.actor_id = NEW.machine_identity_id
   AND operation.status = 'succeeded'
  JOIN health_current_snapshots current
    ON current.organization_id = NEW.organization_id
   AND current.resource_type = 'node'
   AND current.resource_id = NEW.node_id
   AND current.node_id = NEW.node_id
   AND current.server_id IS NULL
   AND current.sampled_at = NEW.health_sampled_at
   AND current.summary_json = NEW.health_summary_json
  JOIN health_hourly_snapshots hourly
    ON hourly.organization_id = NEW.organization_id
   AND hourly.resource_type = 'node'
   AND hourly.resource_id = NEW.node_id
   AND hourly.node_id = NEW.node_id
   AND hourly.server_id IS NULL
   AND hourly.bucket_start = NEW.health_hour_bucket
   AND hourly.sampled_at = NEW.health_sampled_at
   AND hourly.summary_json = NEW.health_summary_json
  WHERE organization.id = NEW.organization_id
    AND organization.status = 'active'
)
OR (
  NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM deployments deployment
    JOIN log_archives archive
      ON archive.organization_id = deployment.organization_id
     AND archive.id = NEW.archive_id
     AND archive.server_id = NEW.server_id
     AND archive.node_id = NEW.node_id
     AND archive.r2_key = NEW.archive_r2_key
     AND archive.sha256 = NEW.archive_sha256
     AND archive.entry_count = NEW.archive_entry_count
     AND archive.uncompressed_bytes = NEW.archive_uncompressed_bytes
     AND archive.compressed_bytes = NEW.archive_compressed_bytes
     AND archive.state = 'available'
    JOIN telemetry_log_stream_watermarks watermark
      ON watermark.organization_id = deployment.organization_id
     AND watermark.node_id = NEW.node_id
     AND watermark.server_id = NEW.server_id
     AND watermark.last_sequence = NEW.log_last_sequence
     AND watermark.last_timestamp = NEW.log_last_timestamp
     AND watermark.last_fingerprint = NEW.log_fingerprint
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.id = NEW.deployment_id
      AND deployment.server_id = NEW.server_id
      AND deployment.node_id = NEW.node_id
      AND deployment.observed_state = 'running'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry ingestion evidence fence failed');
END;

CREATE TRIGGER telemetry_ingestion_receipt_immutable_update
BEFORE UPDATE ON telemetry_ingestion_receipts
BEGIN
  SELECT RAISE(ABORT, 'telemetry ingestion receipt is immutable');
END;

CREATE TRIGGER telemetry_ingestion_receipt_immutable_delete
BEFORE DELETE ON telemetry_ingestion_receipts
BEGIN
  SELECT RAISE(ABORT, 'telemetry ingestion receipt cannot be deleted');
END;

-- Durable queue intent closes the gap between a committed HTTP receipt and a
-- response loss before the Queue send. The object owns downstream dedupe.
CREATE TABLE telemetry_live_publications (
  organization_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  archive_r2_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  first_sequence INTEGER NOT NULL CHECK (first_sequence >= 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
  created_at TEXT NOT NULL,
  enqueued_at TEXT,
  PRIMARY KEY (organization_id, receipt_id),
  UNIQUE (organization_id, archive_id),
  FOREIGN KEY (organization_id, receipt_id)
    REFERENCES telemetry_ingestion_receipts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  CHECK (archive_r2_key LIKE 'organizations/' || organization_id || '/logs/' || server_id || '/%')
) WITHOUT ROWID, STRICT;

CREATE INDEX telemetry_live_publications_pending
  ON telemetry_live_publications(state, created_at, organization_id, receipt_id);

CREATE TRIGGER telemetry_live_publication_scope_guard
BEFORE INSERT ON telemetry_live_publications
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_ingestion_receipts receipt
  WHERE receipt.organization_id = NEW.organization_id
    AND receipt.id = NEW.receipt_id
    AND receipt.node_id = NEW.node_id
    AND receipt.server_id = NEW.server_id
    AND receipt.archive_id = NEW.archive_id
    AND receipt.archive_r2_key = NEW.archive_r2_key
    AND receipt.archive_sha256 = NEW.archive_sha256
    AND receipt.log_first_sequence = NEW.first_sequence
    AND receipt.log_last_sequence = NEW.last_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry live publication scope mismatch');
END;

CREATE TRIGGER telemetry_live_publication_immutable_update
BEFORE UPDATE ON telemetry_live_publications
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.receipt_id IS NOT OLD.receipt_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.archive_id IS NOT OLD.archive_id
  OR NEW.archive_r2_key IS NOT OLD.archive_r2_key
  OR NEW.archive_sha256 IS NOT OLD.archive_sha256
  OR NEW.first_sequence IS NOT OLD.first_sequence
  OR NEW.last_sequence IS NOT OLD.last_sequence
  OR NEW.state NOT IN ('pending', 'enqueued')
  OR (OLD.state = 'enqueued' AND NEW.state <> 'enqueued')
BEGIN
  SELECT RAISE(ABORT, 'telemetry live publication is immutable');
END;

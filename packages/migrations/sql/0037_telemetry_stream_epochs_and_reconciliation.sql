PRAGMA foreign_keys = ON;

-- A deployment is a fresh log-stream epoch.  Keeping epoch state outside the
-- legacy server/node watermark means a server can move or be redeployed on the
-- same node without an old sequence cursor contaminating its new stream.
ALTER TABLE log_archives ADD COLUMN stream_epoch TEXT;
ALTER TABLE telemetry_ingestion_receipts ADD COLUMN stream_epoch TEXT;
ALTER TABLE telemetry_live_publications ADD COLUMN stream_epoch TEXT;

CREATE TABLE telemetry_log_stream_epochs (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_authorized_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, server_id, deployment_id),
  UNIQUE (organization_id, server_id, stream_epoch),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deployment_id) REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  CHECK (stream_epoch = deployment_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER telemetry_log_stream_epoch_scope_guard
BEFORE INSERT ON telemetry_log_stream_epochs
WHEN NOT EXISTS (
  SELECT 1 FROM deployments deployment
  WHERE deployment.organization_id = NEW.organization_id
    AND deployment.id = NEW.deployment_id
    AND deployment.server_id = NEW.server_id
    AND deployment.node_id = NEW.node_id
    AND deployment.observed_state = 'running'
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry stream epoch deployment scope mismatch');
END;

CREATE TRIGGER telemetry_log_stream_epoch_immutable_update
BEFORE UPDATE ON telemetry_log_stream_epochs
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.stream_epoch IS NOT OLD.stream_epoch
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.last_authorized_at < OLD.last_authorized_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry stream epoch is immutable');
END;

CREATE TABLE telemetry_log_stream_epoch_watermarks (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  last_timestamp TEXT NOT NULL,
  last_fingerprint TEXT NOT NULL CHECK (
    length(last_fingerprint) = 64 AND last_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, server_id, stream_epoch),
  FOREIGN KEY (organization_id, server_id, deployment_id)
    REFERENCES telemetry_log_stream_epochs(organization_id, server_id, deployment_id) ON DELETE RESTRICT,
  CHECK (stream_epoch = deployment_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER telemetry_epoch_watermark_forward_only
BEFORE UPDATE ON telemetry_log_stream_epoch_watermarks
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.stream_epoch IS NOT OLD.stream_epoch
  OR NEW.last_sequence <= OLD.last_sequence
  OR NEW.last_timestamp < OLD.last_timestamp
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'telemetry epoch watermark must advance monotonically');
END;

CREATE TRIGGER telemetry_epoch_watermark_immutable_delete
BEFORE DELETE ON telemetry_log_stream_epoch_watermarks
BEGIN
  SELECT RAISE(ABORT, 'telemetry epoch watermark cannot be deleted');
END;

-- A canonical payload identity is intentionally independent of a rotating
-- credential/session. It is bound to one authenticated organization/node and
-- adopts only the exact immutable receipt created earlier.
CREATE TABLE telemetry_payload_adoptions (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id, payload_fingerprint),
  UNIQUE (organization_id, receipt_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, receipt_id)
    REFERENCES telemetry_ingestion_receipts(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER telemetry_payload_adoption_scope_guard
BEFORE INSERT ON telemetry_payload_adoptions
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_ingestion_receipts receipt
  WHERE receipt.organization_id = NEW.organization_id
    AND receipt.id = NEW.receipt_id
    AND receipt.node_id = NEW.node_id
    AND receipt.payload_fingerprint = NEW.payload_fingerprint
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry payload adoption receipt mismatch');
END;

CREATE TRIGGER telemetry_payload_adoption_immutable_update
BEFORE UPDATE ON telemetry_payload_adoptions
BEGIN
  SELECT RAISE(ABORT, 'telemetry payload adoption is immutable');
END;

CREATE TRIGGER telemetry_payload_adoption_immutable_delete
BEFORE DELETE ON telemetry_payload_adoptions
BEGIN
  SELECT RAISE(ABORT, 'telemetry payload adoption cannot be deleted');
END;

-- Record the exact R2 object identity before uploading. A failed final D1
-- receipt therefore leaves a bounded durable reconciliation target rather than
-- an untracked immutable object.
CREATE TABLE telemetry_pending_archive_uploads (
  organization_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  compressed_sha256 TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 1),
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes >= 1),
  compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'cleaned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleanup_after TEXT NOT NULL,
  PRIMARY KEY (organization_id, archive_id),
  UNIQUE (organization_id, r2_key),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id, deployment_id)
    REFERENCES telemetry_log_stream_epochs(organization_id, server_id, deployment_id) ON DELETE RESTRICT,
  CHECK (stream_epoch = deployment_id),
  CHECK (r2_key LIKE 'organizations/' || organization_id || '/logs/' || server_id || '/epochs/' || stream_epoch || '/%'),
  CHECK (length(sha256) = 71 AND sha256 LIKE 'sha256:%'),
  CHECK (length(compressed_sha256) = 71 AND compressed_sha256 LIKE 'sha256:%')
) WITHOUT ROWID, STRICT;

CREATE INDEX telemetry_pending_archive_reconcile
  ON telemetry_pending_archive_uploads(state, cleanup_after, organization_id, archive_id);

CREATE TRIGGER telemetry_pending_archive_immutable_update
BEFORE UPDATE ON telemetry_pending_archive_uploads
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.archive_id IS NOT OLD.archive_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.stream_epoch IS NOT OLD.stream_epoch
  OR NEW.r2_key IS NOT OLD.r2_key
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.compressed_sha256 IS NOT OLD.compressed_sha256
  OR NEW.entry_count IS NOT OLD.entry_count
  OR NEW.uncompressed_bytes IS NOT OLD.uncompressed_bytes
  OR NEW.compressed_bytes IS NOT OLD.compressed_bytes
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.cleanup_after IS NOT OLD.cleanup_after
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.state = 'accepted' AND NEW.state <> 'accepted')
  OR (OLD.state = 'cleaned' AND NEW.state <> 'cleaned')
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive identity is immutable');
END;

-- Replace the v1 receipt fence with an epoch-aware equivalent.
DROP TRIGGER telemetry_ingestion_receipt_evidence_guard;
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
  NEW.server_id IS NULL AND NEW.stream_epoch IS NOT NULL
)
OR (
  NEW.server_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM deployments deployment
    JOIN telemetry_log_stream_epochs epoch
      ON epoch.organization_id = deployment.organization_id
     AND epoch.node_id = NEW.node_id
     AND epoch.server_id = NEW.server_id
     AND epoch.deployment_id = NEW.deployment_id
     AND epoch.stream_epoch = NEW.stream_epoch
    JOIN log_archives archive
      ON archive.organization_id = deployment.organization_id
     AND archive.id = NEW.archive_id
     AND archive.server_id = NEW.server_id
     AND archive.node_id = NEW.node_id
     AND archive.stream_epoch = NEW.stream_epoch
     AND archive.r2_key = NEW.archive_r2_key
     AND archive.sha256 = NEW.archive_sha256
     AND archive.entry_count = NEW.archive_entry_count
     AND archive.uncompressed_bytes = NEW.archive_uncompressed_bytes
     AND archive.compressed_bytes = NEW.archive_compressed_bytes
     AND archive.state = 'available'
    JOIN telemetry_log_stream_epoch_watermarks watermark
      ON watermark.organization_id = deployment.organization_id
     AND watermark.node_id = NEW.node_id
     AND watermark.server_id = NEW.server_id
     AND watermark.deployment_id = NEW.deployment_id
     AND watermark.stream_epoch = NEW.stream_epoch
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
  SELECT RAISE(ABORT, 'telemetry ingestion epoch evidence fence failed');
END;

DROP TRIGGER telemetry_live_publication_scope_guard;
CREATE TRIGGER telemetry_live_publication_scope_guard
BEFORE INSERT ON telemetry_live_publications
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_ingestion_receipts receipt
  WHERE receipt.organization_id = NEW.organization_id
    AND receipt.id = NEW.receipt_id
    AND receipt.node_id = NEW.node_id
    AND receipt.server_id = NEW.server_id
    AND receipt.stream_epoch = NEW.stream_epoch
    AND receipt.archive_id = NEW.archive_id
    AND receipt.archive_r2_key = NEW.archive_r2_key
    AND receipt.archive_sha256 = NEW.archive_sha256
    AND receipt.log_first_sequence = NEW.first_sequence
    AND receipt.log_last_sequence = NEW.last_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry live publication epoch scope mismatch');
END;

CREATE TRIGGER telemetry_live_publication_epoch_immutable_update
BEFORE UPDATE ON telemetry_live_publications
WHEN NEW.stream_epoch IS NOT OLD.stream_epoch
BEGIN
  SELECT RAISE(ABORT, 'telemetry live publication epoch is immutable');
END;

-- Suspension is emitted through the committed outbox. Queue consumers revoke
-- live sockets after commit, so mutating membership/organization transactions
-- never call a Durable Object directly.
CREATE TRIGGER telemetry_live_log_organization_suspended
AFTER UPDATE OF status ON organizations
WHEN OLD.status = 'active' AND NEW.status <> 'active'
BEGIN
  INSERT OR IGNORE INTO outbox
    (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
     publish_state, retry_count, available_at, created_at)
  VALUES (
    'live-log-org-suspended-' || NEW.id || '-' || NEW.revision,
    NEW.id,
    'organization.live-log.suspended',
    'organization',
    NEW.id,
    json_object('organizationId', NEW.id, 'status', NEW.status),
    'pending', 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

PRAGMA foreign_keys = ON;
-- D1 executes each migration inside an implicit transaction and does not let a
-- migration turn foreign keys off. Defer checks while the parent and its two
-- direct children are replaced, then restore a fully valid graph before this
-- migration completes.
PRAGMA defer_foreign_keys = ON;

-- 0029 used the machine's sample time for both evidence and receipt
-- acceptance. That lets an offline agent backdate a control-plane fact. A
-- receipt is immutable, so SQLite cannot remove that CHECK in place. Rebuild
-- the parent and its direct FK children together. We do not rename the old
-- parent: SQLite would rewrite child references to the temporary name.

DROP TRIGGER IF EXISTS telemetry_ingestion_receipt_evidence_guard;
DROP TRIGGER IF EXISTS telemetry_ingestion_receipt_immutable_update;
DROP TRIGGER IF EXISTS telemetry_ingestion_receipt_immutable_delete;
DROP TRIGGER IF EXISTS telemetry_ingestion_receipt_cleanup_lease_guard;

CREATE TABLE telemetry_payload_adoptions_replacement (
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

INSERT INTO telemetry_payload_adoptions_replacement
  (organization_id, node_id, payload_fingerprint, receipt_id, created_at)
SELECT organization_id, node_id, payload_fingerprint, receipt_id, created_at
FROM telemetry_payload_adoptions;

CREATE TABLE telemetry_live_publications_replacement (
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
  stream_epoch TEXT,
  PRIMARY KEY (organization_id, receipt_id),
  UNIQUE (organization_id, archive_id),
  FOREIGN KEY (organization_id, receipt_id)
    REFERENCES telemetry_ingestion_receipts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  CHECK (archive_r2_key LIKE 'organizations/' || organization_id || '/logs/' || server_id || '/%')
) WITHOUT ROWID, STRICT;

INSERT INTO telemetry_live_publications_replacement (
  organization_id, receipt_id, node_id, server_id, archive_id, archive_r2_key,
  archive_sha256, first_sequence, last_sequence, state, created_at, enqueued_at,
  stream_epoch
)
SELECT organization_id, receipt_id, node_id, server_id, archive_id, archive_r2_key,
  archive_sha256, first_sequence, last_sequence, state, created_at, enqueued_at,
  stream_epoch
FROM telemetry_live_publications;

-- Remove the children first: their RESTRICT constraints otherwise make the
-- parent replacement fail even when D1 defers ordinary FK validation.
DROP TABLE telemetry_payload_adoptions;
DROP TABLE telemetry_live_publications;

CREATE TABLE telemetry_ingestion_receipts_replacement (
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
  stream_epoch TEXT,
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
  CHECK (health_hour_bucket <= health_sampled_at)
) WITHOUT ROWID, STRICT;

INSERT INTO telemetry_ingestion_receipts_replacement (
  organization_id, node_id, id, credential_id, credential_version,
  session_version, machine_identity_id, payload_fingerprint,
  health_sampled_at, health_summary_json, health_hour_bucket,
  server_id, deployment_id, log_first_sequence, log_last_sequence,
  log_last_timestamp, log_fingerprint, archive_id, archive_r2_key,
  archive_sha256, archive_entry_count, archive_uncompressed_bytes,
  archive_compressed_bytes, operation_id, audit_event_id, accepted_at,
  created_at, stream_epoch
)
SELECT
  organization_id, node_id, id, credential_id, credential_version,
  session_version, machine_identity_id, payload_fingerprint,
  health_sampled_at, health_summary_json, health_hour_bucket,
  server_id, deployment_id, log_first_sequence, log_last_sequence,
  log_last_timestamp, log_fingerprint, archive_id, archive_r2_key,
  archive_sha256, archive_entry_count, archive_uncompressed_bytes,
  archive_compressed_bytes, operation_id, audit_event_id, accepted_at,
  created_at, stream_epoch
FROM telemetry_ingestion_receipts;

DROP TABLE telemetry_ingestion_receipts;
ALTER TABLE telemetry_ingestion_receipts_replacement RENAME TO telemetry_ingestion_receipts;
ALTER TABLE telemetry_payload_adoptions_replacement RENAME TO telemetry_payload_adoptions;
ALTER TABLE telemetry_live_publications_replacement RENAME TO telemetry_live_publications;

CREATE INDEX telemetry_ingestion_receipts_node_time
  ON telemetry_ingestion_receipts(organization_id, node_id, accepted_at DESC);
CREATE INDEX telemetry_live_publications_pending
  ON telemetry_live_publications(state, created_at, organization_id, receipt_id);

-- Recreate the epoch-aware receipt evidence and cleanup guards dropped with
-- the rebuilt table.  `accepted_at` is intentionally unconstrained by the
-- machine sample; the canonical health facts remain tied to sampled time.
CREATE TRIGGER telemetry_ingestion_receipt_evidence_guard
BEFORE INSERT ON telemetry_ingestion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN node_credentials credential
    ON credential.organization_id = organization.id
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
OR (NEW.server_id IS NULL AND NEW.stream_epoch IS NOT NULL)
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

CREATE TRIGGER telemetry_ingestion_receipt_cleanup_lease_guard
BEFORE INSERT ON telemetry_ingestion_receipts
WHEN NEW.archive_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM telemetry_pending_archive_uploads pending
  WHERE pending.organization_id = NEW.organization_id
    AND pending.archive_id = NEW.archive_id
    AND pending.state = 'pending'
    AND pending.cleanup_claimed_ever = 1
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry receipt blocked by archive cleanup lease history');
END;

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

CREATE TRIGGER telemetry_live_publication_epoch_immutable_update
BEFORE UPDATE ON telemetry_live_publications
WHEN NEW.stream_epoch IS NOT OLD.stream_epoch
BEGIN
  SELECT RAISE(ABORT, 'telemetry live publication epoch is immutable');
END;

PRAGMA defer_foreign_keys = OFF;
PRAGMA foreign_keys = ON;

-- Live-log tickets are short lived, but their authorization must survive a
-- membership delete/regrant and an organization suspend/reactivate cycle. The
-- durable generation is the control-plane fact passed to the stream DO; an
-- old outbox delivery can therefore never resurrect an earlier permission.
CREATE TABLE live_log_organization_authorizations (
  organization_id TEXT PRIMARY KEY NOT NULL,
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'deleted')),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CHECK ((state = 'deleted') = (terminal = 1))
) WITHOUT ROWID, STRICT;

INSERT INTO live_log_organization_authorizations
  (organization_id, authorization_generation, state, terminal, updated_at)
SELECT
  id,
  1,
  CASE WHEN status = 'active' THEN 'active'
       WHEN status = 'deleted' THEN 'deleted'
       ELSE 'suspended' END,
  CASE WHEN status = 'deleted' THEN 1 ELSE 0 END,
  created_at
FROM organizations;

CREATE TRIGGER live_log_organization_authorization_insert
AFTER INSERT ON organizations
BEGIN
  INSERT INTO live_log_organization_authorizations
    (organization_id, authorization_generation, state, terminal, updated_at)
  VALUES (
    NEW.id,
    1,
    CASE WHEN NEW.status = 'active' THEN 'active'
         WHEN NEW.status = 'deleted' THEN 'deleted'
         ELSE 'suspended' END,
    CASE WHEN NEW.status = 'deleted' THEN 1 ELSE 0 END,
    NEW.created_at
  );
END;

CREATE TRIGGER live_log_organization_authorization_status
AFTER UPDATE OF status ON organizations
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO live_log_organization_authorizations
    (organization_id, authorization_generation, state, terminal, updated_at)
  VALUES (
    NEW.id,
    1,
    CASE WHEN NEW.status = 'active' THEN 'active'
         WHEN NEW.status = 'deleted' THEN 'deleted'
         ELSE 'suspended' END,
    CASE WHEN NEW.status = 'deleted' THEN 1 ELSE 0 END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    authorization_generation = live_log_organization_authorizations.authorization_generation + 1,
    state = CASE
      WHEN live_log_organization_authorizations.terminal = 1 THEN 'deleted'
      ELSE excluded.state
    END,
    terminal = CASE
      WHEN live_log_organization_authorizations.terminal = 1
        OR excluded.state = 'deleted' THEN 1
      ELSE 0
    END,
    updated_at = excluded.updated_at;
END;

-- 0037 already emits the active-to-nonactive transition. A later
-- suspended-to-deleted (or controlled reactivation) transition needs its own
-- committed wake-up too; otherwise an object that consumed the suspension
-- before the deletion would never learn that deletion is terminal. The queue
-- reader fetches the current generation/state rather than trusting this body.
CREATE TRIGGER live_log_organization_authorization_changed_outbox
AFTER UPDATE OF status ON organizations
WHEN NEW.status IS NOT OLD.status
  AND NOT (OLD.status = 'active' AND NEW.status <> 'active')
BEGIN
  INSERT OR IGNORE INTO outbox
    (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
     publish_state, retry_count, available_at, created_at)
  VALUES (
    'live-log-org-authorization-' || NEW.id || '-' || NEW.revision,
    NEW.id,
    'organization.live-log.authorization.changed',
    'organization',
    NEW.id,
    json_object('organizationId', NEW.id, 'status', NEW.status),
    'pending', 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TABLE live_log_membership_authorizations (
  organization_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation >= 1),
  membership_revision INTEGER NOT NULL CHECK (membership_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, identity_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

INSERT INTO live_log_membership_authorizations
  (organization_id, identity_id, authorization_generation, membership_revision, state, updated_at)
SELECT
  organization_id,
  identity_id,
  revision,
  revision,
  CASE WHEN status = 'active' THEN 'active' ELSE 'revoked' END,
  joined_at
FROM organization_memberships;

CREATE TRIGGER live_log_membership_authorization_insert
AFTER INSERT ON organization_memberships
BEGIN
  INSERT INTO live_log_membership_authorizations
    (organization_id, identity_id, authorization_generation, membership_revision, state, updated_at)
  VALUES (
    NEW.organization_id,
    NEW.identity_id,
    NEW.revision,
    NEW.revision,
    CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'revoked' END,
    NEW.joined_at
  )
  ON CONFLICT (organization_id, identity_id) DO UPDATE SET
    authorization_generation = MAX(
      live_log_membership_authorizations.authorization_generation + 1,
      excluded.authorization_generation
    ),
    membership_revision = excluded.membership_revision,
    state = excluded.state,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER live_log_membership_authorization_update
AFTER UPDATE OF role, status, revision ON organization_memberships
WHEN NEW.revision IS NOT OLD.revision OR NEW.status IS NOT OLD.status OR NEW.role IS NOT OLD.role
BEGIN
  INSERT INTO live_log_membership_authorizations
    (organization_id, identity_id, authorization_generation, membership_revision, state, updated_at)
  VALUES (
    NEW.organization_id,
    NEW.identity_id,
    NEW.revision,
    NEW.revision,
    CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'revoked' END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (organization_id, identity_id) DO UPDATE SET
    authorization_generation = MAX(
      live_log_membership_authorizations.authorization_generation + 1,
      excluded.authorization_generation
    ),
    membership_revision = excluded.membership_revision,
    state = excluded.state,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER live_log_membership_authorization_delete
AFTER DELETE ON organization_memberships
BEGIN
  INSERT INTO live_log_membership_authorizations
    (organization_id, identity_id, authorization_generation, membership_revision, state, updated_at)
  VALUES (
    OLD.organization_id,
    OLD.identity_id,
    OLD.revision + 1,
    OLD.revision + 1,
    'revoked',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (organization_id, identity_id) DO UPDATE SET
    authorization_generation = MAX(
      live_log_membership_authorizations.authorization_generation + 1,
      excluded.authorization_generation
    ),
    membership_revision = excluded.membership_revision,
    state = 'revoked',
    updated_at = excluded.updated_at;
END;

-- Reserve the only next contiguous sequence before a pending upload or R2
-- object exists. The immutable log fingerprint is the collision key: exact
-- retries adopt the reservation, while stale or changed same-sequence bodies
-- stop before they can amplify object storage or cleanup work.
CREATE TABLE telemetry_log_epoch_reservations (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  first_sequence INTEGER NOT NULL CHECK (first_sequence >= 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  log_fingerprint TEXT NOT NULL CHECK (
    length(log_fingerprint) = 64 AND log_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  archive_base_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, server_id, stream_epoch, first_sequence),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id, deployment_id)
    REFERENCES telemetry_log_stream_epochs(organization_id, server_id, deployment_id) ON DELETE RESTRICT,
  CHECK (stream_epoch = deployment_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX telemetry_log_epoch_reservation_lookup
  ON telemetry_log_epoch_reservations(organization_id, server_id, stream_epoch, state, last_sequence);

CREATE TRIGGER telemetry_log_epoch_reservation_insert_guard
BEFORE INSERT ON telemetry_log_epoch_reservations
WHEN NEW.state <> 'reserved'
  OR NOT EXISTS (
    SELECT 1 FROM telemetry_log_stream_epochs epoch
    WHERE epoch.organization_id = NEW.organization_id
      AND epoch.node_id = NEW.node_id
      AND epoch.server_id = NEW.server_id
      AND epoch.deployment_id = NEW.deployment_id
      AND epoch.stream_epoch = NEW.stream_epoch
  )
  OR NOT (
    (NEW.first_sequence = 1 AND NOT EXISTS (
      SELECT 1 FROM telemetry_log_stream_epoch_watermarks watermark
      WHERE watermark.organization_id = NEW.organization_id
        AND watermark.node_id = NEW.node_id
        AND watermark.server_id = NEW.server_id
        AND watermark.deployment_id = NEW.deployment_id
        AND watermark.stream_epoch = NEW.stream_epoch
    ))
    OR EXISTS (
      SELECT 1 FROM telemetry_log_stream_epoch_watermarks watermark
      WHERE watermark.organization_id = NEW.organization_id
        AND watermark.node_id = NEW.node_id
        AND watermark.server_id = NEW.server_id
        AND watermark.deployment_id = NEW.deployment_id
        AND watermark.stream_epoch = NEW.stream_epoch
        AND watermark.last_sequence = NEW.first_sequence - 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'telemetry epoch reservation is stale or out of sequence');
END;

CREATE TRIGGER telemetry_log_epoch_reservation_immutable_update
BEFORE UPDATE ON telemetry_log_epoch_reservations
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.stream_epoch IS NOT OLD.stream_epoch
  OR NEW.first_sequence IS NOT OLD.first_sequence
  OR NEW.last_sequence IS NOT OLD.last_sequence
  OR NEW.log_fingerprint IS NOT OLD.log_fingerprint
  OR NEW.archive_base_id IS NOT OLD.archive_base_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.state = 'accepted' AND NEW.state <> 'accepted')
  OR (OLD.state = 'reserved' AND NEW.state NOT IN ('reserved', 'accepted'))
BEGIN
  SELECT RAISE(ABORT, 'telemetry epoch reservation is immutable');
END;

CREATE TRIGGER telemetry_pending_archive_reservation_guard
BEFORE INSERT ON telemetry_pending_archive_uploads
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_log_epoch_reservations reservation
  WHERE reservation.organization_id = NEW.organization_id
    AND reservation.node_id = NEW.node_id
    AND reservation.server_id = NEW.server_id
    AND reservation.deployment_id = NEW.deployment_id
    AND reservation.stream_epoch = NEW.stream_epoch
    AND reservation.archive_base_id = NEW.archive_base_id
    AND reservation.state = 'reserved'
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive requires an active epoch reservation');
END;

CREATE TRIGGER telemetry_ingestion_receipt_epoch_reservation_guard
BEFORE INSERT ON telemetry_ingestion_receipts
WHEN NEW.server_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM telemetry_log_epoch_reservations reservation
  JOIN telemetry_pending_archive_uploads pending
    ON pending.organization_id = reservation.organization_id
   AND pending.node_id = reservation.node_id
   AND pending.server_id = reservation.server_id
   AND pending.deployment_id = reservation.deployment_id
   AND pending.stream_epoch = reservation.stream_epoch
   AND pending.archive_base_id = reservation.archive_base_id
   AND pending.archive_id = NEW.archive_id
   AND pending.state = 'pending'
  WHERE reservation.organization_id = NEW.organization_id
    AND reservation.node_id = NEW.node_id
    AND reservation.server_id = NEW.server_id
    AND reservation.deployment_id = NEW.deployment_id
    AND reservation.stream_epoch = NEW.stream_epoch
    AND reservation.first_sequence = NEW.log_first_sequence
    AND reservation.last_sequence = NEW.log_last_sequence
    AND reservation.log_fingerprint = NEW.log_fingerprint
    AND reservation.state = 'reserved'
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry receipt requires an exact epoch reservation');
END;

CREATE TRIGGER telemetry_ingestion_receipt_epoch_reservation_accept
AFTER INSERT ON telemetry_ingestion_receipts
WHEN NEW.server_id IS NOT NULL
BEGIN
  UPDATE telemetry_log_epoch_reservations
  SET state = 'accepted', updated_at = NEW.accepted_at
  WHERE organization_id = NEW.organization_id
    AND node_id = NEW.node_id
    AND server_id = NEW.server_id
    AND deployment_id = NEW.deployment_id
    AND stream_epoch = NEW.stream_epoch
    AND first_sequence = NEW.log_first_sequence
    AND last_sequence = NEW.log_last_sequence
    AND log_fingerprint = NEW.log_fingerprint
    AND state = 'reserved';
END;

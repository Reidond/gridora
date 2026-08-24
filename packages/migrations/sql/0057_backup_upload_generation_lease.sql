PRAGMA foreign_keys = ON;

-- A node upload is a long-lived external writer. Its authority must outlive
-- the HTTP authorization read so cancellation and physical cleanup cannot
-- race an already-started R2 publication. Every archive receives one
-- immutable generation. A lost Worker may be taken over by a new finite
-- lease, but elapsed time never proves that the old provider call stopped.
CREATE TABLE backup_upload_sessions (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 1024),
  r2_key TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0),
  declared_sha256 TEXT NOT NULL CHECK (
    length(declared_sha256) = 71
    AND declared_sha256 LIKE 'sha256:%'
    AND substr(declared_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  archive_created_at TEXT NOT NULL,
  includes_json TEXT NOT NULL CHECK (
    json_valid(includes_json)
    AND json_type(includes_json, '$') = 'array'
    AND json_array_length(includes_json) BETWEEN 1 AND 4
    AND length(includes_json) <= 128
  ),
  maximum_chunk_bytes INTEGER NOT NULL CHECK (
    maximum_chunk_bytes BETWEEN 65536 AND 4194304
  ),
  lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 16 AND 128),
  lease_claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  upload_watch_until TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'accepted', 'revoked', 'reconciled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, backup_id, generation),
  UNIQUE (organization_id, lease_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id)
    REFERENCES backups(organization_id, id) ON DELETE RESTRICT,
  CHECK (r2_key = 'organizations/' || organization_id || '/servers/' ||
    server_id || '/backups/' || backup_id),
  CHECK (lease_expires_at > lease_claimed_at),
  CHECK (upload_watch_until > lease_expires_at),
  CHECK (created_at = lease_claimed_at),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID, STRICT;

CREATE INDEX backup_upload_sessions_job
  ON backup_upload_sessions(organization_id, job_id, generation DESC);
CREATE INDEX backup_upload_sessions_cleanup_fence
  ON backup_upload_sessions(organization_id, backup_id, state, upload_watch_until);

-- A takeover does not erase the original lease. The exact archive generation
-- is resumed under a new lease, while provider multipart effects from the old
-- lease are adopted or explicitly aborted before any replacement publication.
CREATE TABLE backup_upload_lease_takeovers (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1024),
  prior_lease_id TEXT NOT NULL,
  next_lease_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  upload_watch_until TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'worker-loss-retry'),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, session_id, sequence),
  UNIQUE (organization_id, next_lease_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES backup_upload_sessions(organization_id, id) ON DELETE RESTRICT,
  CHECK (prior_lease_id <> next_lease_id),
  CHECK (lease_expires_at > claimed_at),
  CHECK (upload_watch_until > lease_expires_at)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_upload_lease_takeover_guard
BEFORE INSERT ON backup_upload_lease_takeovers
WHEN NEW.sequence <> COALESCE((
    SELECT MAX(prior.sequence) + 1
    FROM backup_upload_lease_takeovers prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.session_id = NEW.session_id
  ), 1)
  OR julianday(NEW.lease_expires_at) <= julianday(NEW.claimed_at)
  OR julianday(NEW.lease_expires_at) > julianday(NEW.claimed_at) + (15.0 / 1440.0)
  OR julianday(NEW.upload_watch_until) <= julianday(NEW.lease_expires_at)
  OR julianday(NEW.upload_watch_until) > julianday(NEW.claimed_at) + (30.0 / 1440.0)
  OR NOT EXISTS (
    SELECT 1
    FROM backup_upload_sessions session
    JOIN backup_jobs job
      ON job.organization_id = session.organization_id AND job.id = session.job_id
    JOIN operations operation
      ON operation.organization_id = session.organization_id
     AND operation.id = session.operation_id
    JOIN backups backup
      ON backup.organization_id = session.organization_id AND backup.id = session.backup_id
    WHERE session.organization_id = NEW.organization_id
      AND session.id = NEW.session_id
      AND session.state = 'uploading'
      AND COALESCE((
        SELECT latest.next_lease_id
        FROM backup_upload_lease_takeovers latest
        WHERE latest.organization_id = session.organization_id
          AND latest.session_id = session.id
        ORDER BY latest.sequence DESC LIMIT 1
      ), session.lease_id) = NEW.prior_lease_id
      AND COALESCE((
        SELECT latest.lease_expires_at
        FROM backup_upload_lease_takeovers latest
        WHERE latest.organization_id = session.organization_id
          AND latest.session_id = session.id
        ORDER BY latest.sequence DESC LIMIT 1
      ), session.lease_expires_at) <= NEW.claimed_at
      AND job.mode = 'create'
      AND job.state IN ('reserved', 'running', 'waiting_external')
      AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
      AND backup.state = 'creating'
      AND NOT EXISTS (
        SELECT 1 FROM operation_cancellation_requests cancellation
        WHERE cancellation.organization_id = session.organization_id
          AND cancellation.operation_id = session.operation_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM backup_deletion_claims claim
        WHERE claim.organization_id = session.organization_id
          AND claim.backup_id = session.backup_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM backup_upload_closure_receipts closure
        WHERE closure.organization_id = session.organization_id
          AND closure.session_id = session.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM backup_upload_acceptance_receipts accepted
        WHERE accepted.organization_id = session.organization_id
          AND accepted.session_id = session.id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'backup upload takeover is fenced');
END;

CREATE TRIGGER backup_upload_lease_takeover_immutable_update
BEFORE UPDATE ON backup_upload_lease_takeovers
BEGIN SELECT RAISE(ABORT, 'backup upload takeover is immutable'); END;

CREATE TRIGGER backup_upload_lease_takeover_immutable_delete
BEFORE DELETE ON backup_upload_lease_takeovers
BEGIN SELECT RAISE(ABORT, 'backup upload takeover is immutable'); END;

-- Every encrypted object is published through a provider-managed multipart
-- effect. The upload id is persisted before the first byte is sent, so a
-- recovery can prove one of two terminal outcomes: exact object completion or
-- provider-confirmed abort. A Worker may never publish through a raw R2 PUT.
CREATE TABLE backup_upload_object_effects (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 1024),
  lease_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 1024),
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN -1 AND 65535),
  object_bytes INTEGER NOT NULL CHECK (object_bytes > 0),
  object_sha256 TEXT NOT NULL CHECK (
    length(object_sha256) = 71
    AND object_sha256 LIKE 'sha256:%'
    AND substr(object_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  multipart_upload_id TEXT NOT NULL CHECK (length(multipart_upload_id) BETWEEN 1 AND 1024),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'aborted')),
  terminal_lease_id TEXT,
  provider_etag TEXT,
  created_at TEXT NOT NULL,
  terminal_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, session_id, object_key, attempt),
  UNIQUE (organization_id, multipart_upload_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES backup_upload_sessions(organization_id, id) ON DELETE RESTRICT,
  CHECK ((object_kind = 'manifest' AND chunk_index = -1)
    OR (object_kind = 'chunk' AND chunk_index >= 0)),
  CHECK ((state = 'prepared' AND terminal_lease_id IS NULL
      AND provider_etag IS NULL AND terminal_at IS NULL)
    OR (state = 'completed' AND terminal_lease_id IS NOT NULL
      AND provider_etag IS NOT NULL AND terminal_at IS NOT NULL)
    OR (state = 'aborted' AND terminal_lease_id IS NOT NULL
      AND provider_etag IS NULL AND terminal_at IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE INDEX backup_upload_object_effects_session
  ON backup_upload_object_effects(organization_id, session_id, state, object_key, attempt DESC);

CREATE TRIGGER backup_upload_object_effect_insert_guard
BEFORE INSERT ON backup_upload_object_effects
WHEN NEW.state <> 'prepared' OR NEW.revision <> 1
  OR NEW.terminal_lease_id IS NOT NULL OR NEW.provider_etag IS NOT NULL
  OR NEW.terminal_at IS NOT NULL
  OR NEW.attempt <> COALESCE((
    SELECT MAX(prior.attempt) + 1
    FROM backup_upload_object_effects prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.session_id = NEW.session_id AND prior.object_key = NEW.object_key
  ), 1)
  OR EXISTS (
    SELECT 1 FROM backup_upload_object_effects prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.session_id = NEW.session_id AND prior.object_key = NEW.object_key
      AND prior.state = 'prepared'
  )
  OR NOT EXISTS (
    SELECT 1 FROM backup_upload_sessions session
    WHERE session.organization_id = NEW.organization_id
      AND session.id = NEW.session_id
      AND session.generation = NEW.generation
      AND session.state = 'uploading'
      AND NEW.object_key LIKE session.r2_key || '/%'
      AND COALESCE((
        SELECT latest.next_lease_id FROM backup_upload_lease_takeovers latest
        WHERE latest.organization_id = session.organization_id
          AND latest.session_id = session.id
        ORDER BY latest.sequence DESC LIMIT 1
      ), session.lease_id) = NEW.lease_id
      AND COALESCE((
        SELECT latest.lease_expires_at FROM backup_upload_lease_takeovers latest
        WHERE latest.organization_id = session.organization_id
          AND latest.session_id = session.id
        ORDER BY latest.sequence DESC LIMIT 1
      ), session.lease_expires_at) > NEW.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'backup upload object effect is fenced');
END;

CREATE TRIGGER backup_upload_object_effect_identity_immutable
BEFORE UPDATE OF organization_id, id, session_id, generation, lease_id, attempt,
  object_key, object_kind, chunk_index, object_bytes, object_sha256,
  multipart_upload_id, created_at
ON backup_upload_object_effects
BEGIN SELECT RAISE(ABORT, 'backup upload object effect identity is immutable'); END;

CREATE TRIGGER backup_upload_object_effect_terminal_guard
BEFORE UPDATE OF state, terminal_lease_id, provider_etag, terminal_at, revision
ON backup_upload_object_effects
WHEN OLD.state <> 'prepared' OR NEW.state NOT IN ('completed', 'aborted')
  OR NEW.revision <> OLD.revision + 1
  OR NEW.terminal_at < OLD.created_at
  OR NOT EXISTS (
    SELECT 1 FROM backup_upload_sessions session
    WHERE session.organization_id = OLD.organization_id
      AND session.id = OLD.session_id
      AND session.generation = OLD.generation
      AND session.state IN ('uploading', 'revoked')
      AND COALESCE((
        SELECT latest.next_lease_id FROM backup_upload_lease_takeovers latest
        WHERE latest.organization_id = session.organization_id
          AND latest.session_id = session.id
        ORDER BY latest.sequence DESC LIMIT 1
      ), session.lease_id) = NEW.terminal_lease_id
  )
BEGIN
  SELECT RAISE(ABORT, 'backup upload object terminal receipt is fenced');
END;

CREATE TRIGGER backup_upload_object_effect_terminal_immutable
BEFORE UPDATE ON backup_upload_object_effects
WHEN OLD.state IN ('completed', 'aborted')
BEGIN SELECT RAISE(ABORT, 'backup upload object terminal receipt is immutable'); END;

CREATE TRIGGER backup_upload_object_effect_delete_immutable
BEFORE DELETE ON backup_upload_object_effects
BEGIN SELECT RAISE(ABORT, 'backup upload object effect is immutable'); END;

CREATE TABLE backup_upload_closure_receipts (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  close_reason TEXT NOT NULL CHECK (
    close_reason IN ('request-failed', 'authority-lost', 'request-aborted')
  ),
  closed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, session_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES backup_upload_sessions(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_upload_closure_receipt_guard
BEFORE INSERT ON backup_upload_closure_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM backup_upload_sessions session
  WHERE session.organization_id = NEW.organization_id
    AND session.id = NEW.session_id
    AND COALESCE((
      SELECT latest.next_lease_id FROM backup_upload_lease_takeovers latest
      WHERE latest.organization_id = session.organization_id
        AND latest.session_id = session.id
      ORDER BY latest.sequence DESC LIMIT 1
    ), session.lease_id) = NEW.lease_id
    AND session.state IN ('uploading', 'revoked')
    AND NOT EXISTS (
      SELECT 1 FROM backup_upload_object_effects effect
      WHERE effect.organization_id = session.organization_id
        AND effect.session_id = session.id AND effect.state = 'prepared'
    )
    AND NOT EXISTS (
      SELECT 1 FROM backup_upload_acceptance_receipts accepted
      WHERE accepted.organization_id = session.organization_id
        AND accepted.session_id = session.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'backup upload closure requires the exact live writer');
END;

CREATE TRIGGER backup_upload_closure_receipt_immutable_update
BEFORE UPDATE ON backup_upload_closure_receipts
BEGIN SELECT RAISE(ABORT, 'backup upload closure receipt is immutable'); END;

CREATE TRIGGER backup_upload_closure_receipt_immutable_delete
BEFORE DELETE ON backup_upload_closure_receipts
BEGIN SELECT RAISE(ABORT, 'backup upload closure receipt is immutable'); END;

CREATE TRIGGER backup_upload_session_insert_guard
BEFORE INSERT ON backup_upload_sessions
WHEN NEW.state <> 'uploading'
  OR NEW.revision <> 1
  OR NEW.generation <> COALESCE((
    SELECT MAX(previous.generation) + 1
    FROM backup_upload_sessions previous
    WHERE previous.organization_id = NEW.organization_id
      AND previous.backup_id = NEW.backup_id
  ), 1)
  OR julianday(NEW.lease_expires_at) <= julianday(NEW.lease_claimed_at)
  OR julianday(NEW.lease_expires_at) > julianday(NEW.lease_claimed_at) + (15.0 / 1440.0)
  OR julianday(NEW.upload_watch_until) <= julianday(NEW.lease_expires_at)
  OR julianday(NEW.upload_watch_until) > julianday(NEW.lease_claimed_at) + (30.0 / 1440.0)
  OR EXISTS (
    SELECT 1 FROM backup_upload_sessions prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.backup_id = NEW.backup_id
      AND prior.state = 'accepted'
  )
  OR EXISTS (
    SELECT 1 FROM backup_upload_sessions prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.backup_id = NEW.backup_id
      AND prior.state IN ('uploading', 'revoked')
  )
  OR EXISTS (
    SELECT 1 FROM backup_deletion_claims claim
    WHERE claim.organization_id = NEW.organization_id
      AND claim.backup_id = NEW.backup_id
  )
  OR EXISTS (
    SELECT 1 FROM backup_physical_deletion_receipts receipt
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.backup_id = NEW.backup_id
  )
  OR NOT EXISTS (
    SELECT 1
    FROM backup_jobs job
    JOIN operations operation
      ON operation.organization_id = job.organization_id
     AND operation.id = job.operation_id
    JOIN backups backup
      ON backup.organization_id = job.organization_id
     AND backup.id = job.backup_id
    WHERE job.organization_id = NEW.organization_id
      AND job.id = NEW.job_id
      AND job.operation_id = NEW.operation_id
      AND job.backup_id = NEW.backup_id
      AND job.source_server_id = NEW.server_id
      AND job.source_node_id = NEW.node_id
      AND job.mode = 'create'
      AND job.state IN ('reserved', 'running', 'waiting_external')
      AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
      AND backup.state = 'creating'
      AND backup.server_id = NEW.server_id
      AND backup.r2_key = NEW.r2_key
      AND json(NEW.includes_json) = json(json_extract(backup.metadata_json, '$.includes'))
      AND NOT EXISTS (
        SELECT 1 FROM operation_cancellation_requests cancellation
        WHERE cancellation.organization_id = job.organization_id
          AND cancellation.operation_id = job.operation_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'backup upload session authority is fenced');
END;

CREATE TRIGGER backup_upload_session_identity_immutable
BEFORE UPDATE OF organization_id, id, job_id, operation_id, backup_id, server_id,
  node_id, generation, r2_key, declared_bytes, declared_sha256,
  archive_created_at, includes_json, maximum_chunk_bytes, lease_id,
  lease_claimed_at, lease_expires_at, upload_watch_until, created_at
ON backup_upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'backup upload session identity is immutable');
END;

CREATE TRIGGER backup_upload_session_state_guard
BEFORE UPDATE OF state, revision, updated_at ON backup_upload_sessions
WHEN NEW.revision <> OLD.revision + 1
  OR NEW.updated_at < OLD.updated_at
  OR NOT (
    (OLD.state = 'uploading' AND NEW.state IN ('accepted', 'revoked'))
    OR (OLD.state IN ('uploading', 'revoked') AND NEW.state = 'reconciled'
      AND EXISTS (
        SELECT 1 FROM backup_upload_closure_receipts closure
        WHERE closure.organization_id = OLD.organization_id
          AND closure.session_id = OLD.id
          AND closure.lease_id = COALESCE((
            SELECT latest.next_lease_id FROM backup_upload_lease_takeovers latest
            WHERE latest.organization_id = OLD.organization_id
              AND latest.session_id = OLD.id
            ORDER BY latest.sequence DESC LIMIT 1
          ), OLD.lease_id)
          AND closure.closed_at = NEW.updated_at
      ))
    OR (OLD.state = NEW.state)
  )
BEGIN
  SELECT RAISE(ABORT, 'backup upload session transition is invalid');
END;

-- Cancellation wins by revoking the writer before cleanup can claim the
-- backup. The retained watch fence remains immutable and survives response
-- loss or a Worker that disappears while an R2 PUT is in flight.
CREATE TRIGGER backup_upload_session_revoke_on_job_terminal
AFTER UPDATE OF state ON backup_jobs
WHEN NEW.state IN ('cancelling', 'cancelled', 'failed', 'failed_terminal')
  AND OLD.state <> NEW.state
BEGIN
  UPDATE backup_upload_sessions
  SET state = 'revoked', revision = revision + 1, updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND job_id = NEW.id
    AND state = 'uploading';
END;

CREATE TRIGGER backup_upload_session_revoke_on_cancellation_request
AFTER INSERT ON operation_cancellation_requests
BEGIN
  UPDATE backup_upload_sessions
  SET state = 'revoked', revision = revision + 1, updated_at = NEW.requested_at
  WHERE organization_id = NEW.organization_id
    AND operation_id = NEW.operation_id
    AND state = 'uploading';
END;

CREATE TABLE backup_upload_acceptance_receipts (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 1024),
  r2_key TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes > 0),
  plaintext_sha256 TEXT NOT NULL CHECK (
    length(plaintext_sha256) = 71
    AND plaintext_sha256 LIKE 'sha256:%'
    AND substr(plaintext_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  encryption_version INTEGER NOT NULL CHECK (encryption_version > 0),
  archive_created_at TEXT NOT NULL,
  includes_json TEXT NOT NULL CHECK (json_valid(includes_json)),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, session_id),
  UNIQUE (organization_id, job_id),
  UNIQUE (organization_id, backup_id),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES backup_upload_sessions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id)
    REFERENCES backups(organization_id, id) ON DELETE RESTRICT,
  CHECK (manifest_key = r2_key || '/manifest.json')
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_upload_acceptance_receipt_guard
BEFORE INSERT ON backup_upload_acceptance_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM backup_upload_sessions session
  JOIN backup_jobs job
    ON job.organization_id = session.organization_id AND job.id = session.job_id
  JOIN operations operation
    ON operation.organization_id = session.organization_id
   AND operation.id = session.operation_id
  JOIN backups backup
    ON backup.organization_id = session.organization_id
   AND backup.id = session.backup_id
  WHERE session.organization_id = NEW.organization_id
    AND session.id = NEW.session_id
    AND session.job_id = NEW.job_id
    AND session.operation_id = NEW.operation_id
    AND session.backup_id = NEW.backup_id
    AND session.generation = NEW.generation
    AND session.r2_key = NEW.r2_key
    AND session.declared_bytes = NEW.plaintext_bytes
    AND session.declared_sha256 = NEW.plaintext_sha256
    AND session.archive_created_at = NEW.archive_created_at
    AND json(session.includes_json) = json(NEW.includes_json)
    AND session.state = 'uploading'
    AND COALESCE((
      SELECT latest.next_lease_id FROM backup_upload_lease_takeovers latest
      WHERE latest.organization_id = session.organization_id
        AND latest.session_id = session.id
      ORDER BY latest.sequence DESC LIMIT 1
    ), session.lease_id) = NEW.lease_id
    AND COALESCE((
      SELECT latest.lease_expires_at FROM backup_upload_lease_takeovers latest
      WHERE latest.organization_id = session.organization_id
        AND latest.session_id = session.id
      ORDER BY latest.sequence DESC LIMIT 1
    ), session.lease_expires_at) > NEW.accepted_at
    AND COALESCE((
      SELECT latest.upload_watch_until FROM backup_upload_lease_takeovers latest
      WHERE latest.organization_id = session.organization_id
        AND latest.session_id = session.id
      ORDER BY latest.sequence DESC LIMIT 1
    ), session.upload_watch_until) > NEW.accepted_at
    AND job.mode = 'create'
    AND job.state IN ('reserved', 'running', 'waiting_external')
    AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
    AND backup.state = 'creating'
    AND backup.r2_key = NEW.r2_key
    AND NOT EXISTS (
      SELECT 1 FROM operation_cancellation_requests cancellation
      WHERE cancellation.organization_id = session.organization_id
        AND cancellation.operation_id = session.operation_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM backup_deletion_claims claim
      WHERE claim.organization_id = session.organization_id
        AND claim.backup_id = session.backup_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM backup_upload_object_effects effect
      WHERE effect.organization_id = session.organization_id
        AND effect.session_id = session.id AND effect.state = 'prepared'
    )
    AND EXISTS (
      SELECT 1 FROM backup_upload_object_effects manifest_effect
      WHERE manifest_effect.organization_id = session.organization_id
        AND manifest_effect.session_id = session.id
        AND manifest_effect.object_kind = 'manifest'
        AND manifest_effect.state = 'completed'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'backup upload receipt requires the active generation lease');
END;

CREATE TRIGGER backup_upload_acceptance_receipt_immutable_update
BEFORE UPDATE ON backup_upload_acceptance_receipts
BEGIN
  SELECT RAISE(ABORT, 'backup upload receipt is immutable');
END;

CREATE TRIGGER backup_upload_acceptance_receipt_immutable_delete
BEFORE DELETE ON backup_upload_acceptance_receipts
BEGIN
  SELECT RAISE(ABORT, 'backup upload receipt is immutable');
END;

-- Once a durable upload authority exists, Workflow success must consume its
-- exact accepted receipt. Legacy rows without a session remain readable and
-- completable during migration rollout.
CREATE TRIGGER backup_create_success_requires_upload_receipt
BEFORE UPDATE OF state ON backup_jobs
WHEN NEW.mode = 'create' AND NEW.state = 'succeeded' AND OLD.state <> 'succeeded'
  AND EXISTS (
    SELECT 1 FROM backup_upload_sessions session
    WHERE session.organization_id = OLD.organization_id AND session.job_id = OLD.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM backup_upload_acceptance_receipts receipt
    JOIN backup_upload_sessions session
      ON session.organization_id = receipt.organization_id
     AND session.id = receipt.session_id
    WHERE receipt.organization_id = OLD.organization_id
      AND receipt.job_id = OLD.id
      AND receipt.operation_id = OLD.operation_id
      AND receipt.backup_id = OLD.backup_id
      AND session.state = 'accepted'
      AND receipt.r2_key = (
        SELECT backup.r2_key FROM backups backup
        WHERE backup.organization_id = OLD.organization_id AND backup.id = OLD.backup_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'backup completion requires an accepted upload generation');
END;

-- Supersede 0054: uploading/revoked is a durable writer tombstone, even after
-- lease expiry. Time is never treated as proof that an in-flight R2 PUT ended.
-- Only exact route finalization (reconciled) or terminal acceptance releases
-- cleanup to claim the canonical prefix.
DROP TRIGGER backup_deletion_claim_scope_guard_insert;

CREATE TRIGGER backup_deletion_claim_scope_guard_insert
BEFORE INSERT ON backup_deletion_claims
WHEN NOT EXISTS (
  SELECT 1
  FROM backups backup
  WHERE backup.organization_id = NEW.organization_id
    AND backup.id = NEW.backup_id
    AND backup.r2_key = NEW.r2_key
    AND backup.r2_key = 'organizations/' || backup.organization_id || '/servers/' ||
      backup.server_id || '/backups/' || backup.id
    AND backup.revision = NEW.artifact_revision
    AND (
      (backup.state IN ('available', 'expired')
        AND NEW.source_job_id IS NULL AND NEW.source_job_operation_id IS NULL)
      OR
      (backup.state IN ('creating', 'failed')
        AND NEW.source_job_id IS NOT NULL AND NEW.source_job_operation_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM backup_jobs source_job
          JOIN operations source_operation
            ON source_operation.organization_id = source_job.organization_id
           AND source_operation.id = source_job.operation_id
          WHERE source_job.organization_id = backup.organization_id
            AND source_job.id = NEW.source_job_id
            AND source_job.operation_id = NEW.source_job_operation_id
            AND source_job.backup_id = backup.id
            AND source_job.mode = 'create'
            AND (
              (backup.state = 'creating'
                AND source_job.state = 'cancelled'
                AND source_operation.status = 'cancelled')
              OR
              (backup.state = 'failed'
                AND source_job.state IN ('failed', 'failed_terminal')
                AND source_operation.status = source_job.state)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM backup_jobs active_create
          WHERE active_create.organization_id = backup.organization_id
            AND active_create.backup_id = backup.id
            AND active_create.mode = 'create'
            AND active_create.state IN (
              'reserved', 'running', 'waiting_external', 'cancelling'
            )
        ))
    )
)
OR EXISTS (
  SELECT 1 FROM backup_jobs restore
  WHERE restore.organization_id = NEW.organization_id
    AND restore.backup_id = NEW.backup_id
    AND restore.mode = 'restore'
    AND restore.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
)
OR EXISTS (
  SELECT 1 FROM backup_upload_sessions session
  WHERE session.organization_id = NEW.organization_id
    AND session.backup_id = NEW.backup_id
    AND session.state IN ('uploading', 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'backup deletion claim is fenced');
END;

DROP TRIGGER backup_physical_deletion_receipt_guard;

CREATE TRIGGER backup_physical_deletion_receipt_guard
BEFORE INSERT ON backup_physical_deletion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM backup_deletion_claims claim
  JOIN backups backup
    ON backup.organization_id = claim.organization_id
   AND backup.id = claim.backup_id
  JOIN operations operation
    ON operation.organization_id = claim.organization_id
   AND operation.id = claim.operation_id
  WHERE claim.organization_id = NEW.organization_id
    AND claim.id = NEW.claim_id
    AND claim.operation_id = NEW.operation_id
    AND claim.backup_id = NEW.backup_id
    AND claim.artifact_revision = NEW.artifact_revision
    AND claim.r2_key = NEW.r2_key
    AND claim.source_job_id IS NEW.source_job_id
    AND claim.source_job_operation_id IS NEW.source_job_operation_id
    AND claim.state = 'deleting'
    AND backup.revision = claim.artifact_revision
    AND backup.r2_key = claim.r2_key
    AND backup.r2_key = 'organizations/' || backup.organization_id || '/servers/' ||
      backup.server_id || '/backups/' || backup.id
    AND operation.type = 'delete-backup'
    AND operation.resource_type = 'backup'
    AND operation.resource_id = backup.id
    AND operation.status IN ('queued', 'running', 'retrying')
    AND (
      (backup.state IN ('available', 'expired')
        AND NEW.source_job_id IS NULL AND NEW.source_job_operation_id IS NULL)
      OR
      (backup.state IN ('creating', 'failed')
        AND NEW.source_job_id IS NOT NULL AND NEW.source_job_operation_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM backup_jobs source_job
          JOIN operations source_operation
            ON source_operation.organization_id = source_job.organization_id
           AND source_operation.id = source_job.operation_id
          WHERE source_job.organization_id = backup.organization_id
            AND source_job.id = NEW.source_job_id
            AND source_job.operation_id = NEW.source_job_operation_id
            AND source_job.backup_id = backup.id
            AND source_job.mode = 'create'
            AND (
              (backup.state = 'creating'
                AND source_job.state = 'cancelled'
                AND source_operation.status = 'cancelled')
              OR
              (backup.state = 'failed'
                AND source_job.state IN ('failed', 'failed_terminal')
                AND source_operation.status = source_job.state)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM backup_jobs active_create
          WHERE active_create.organization_id = backup.organization_id
            AND active_create.backup_id = backup.id
            AND active_create.mode = 'create'
            AND active_create.state IN (
              'reserved', 'running', 'waiting_external', 'cancelling'
            )
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM backup_jobs restore
      WHERE restore.organization_id = backup.organization_id
        AND restore.backup_id = backup.id
        AND restore.mode = 'restore'
        AND restore.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
    )
    AND NOT EXISTS (
      SELECT 1 FROM backup_upload_sessions session
      WHERE session.organization_id = backup.organization_id
        AND session.backup_id = backup.id
        AND session.state IN ('uploading', 'revoked')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'backup physical deletion receipt is fenced');
END;

CREATE TRIGGER organization_ready_requires_backup_upload_quiescence
BEFORE UPDATE OF state ON organization_deletion_runs
WHEN NEW.state = 'ready-to-tombstone' AND EXISTS (
  SELECT 1 FROM backup_upload_sessions session
  WHERE session.organization_id = NEW.organization_id
    AND session.state IN ('uploading', 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'organization backup upload writer is not quiescent');
END;

CREATE TRIGGER organization_tombstone_requires_backup_upload_quiescence
BEFORE UPDATE OF status ON organizations
WHEN OLD.status = 'deleting' AND NEW.status = 'deleted' AND EXISTS (
  SELECT 1
  FROM backup_upload_sessions session
  JOIN organization_deletion_runs run
    ON run.organization_id = session.organization_id
  WHERE session.organization_id = OLD.id
    AND session.state IN ('uploading', 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'organization tombstone backup upload writer is not quiescent');
END;

PRAGMA foreign_keys = ON;

-- A pending row exists before R2 upload, but a HEAD=null cleanup result used
-- to be able to tombstone it while the original Worker still had a delayed
-- PUT in flight. The upload lease is paired with an application cancellation
-- boundary: an unresolved writer retains its exact key indefinitely, while a
-- writer that has durably settled can be reconciled and compacted safely.
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN upload_lease_id TEXT;
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN upload_claimed_at TEXT;
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN upload_lease_expires_at TEXT;
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN upload_claimed_ever INTEGER NOT NULL DEFAULT 0
  CHECK (upload_claimed_ever IN (0, 1));
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN upload_watch_after TEXT;
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN upload_watch_until TEXT;
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN upload_watch_required INTEGER NOT NULL DEFAULT 0
  CHECK (upload_watch_required IN (0, 1));
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN upload_writer_state TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (upload_writer_state IN ('unresolved', 'terminated'));
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN upload_writer_terminated_at TEXT;

-- The epoch reservation is the per-operation retry ledger. It persists the
-- highest immutable generation after the corresponding physical pending row is
-- compacted, prevents generation re-use, and bounds retries without adding a
-- second unbounded table.
ALTER TABLE telemetry_log_epoch_reservations
  ADD COLUMN archive_attempt_generation INTEGER NOT NULL DEFAULT 0
  CHECK (archive_attempt_generation >= 0 AND archive_attempt_generation <= 3);
ALTER TABLE telemetry_log_epoch_reservations
  ADD COLUMN archive_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (archive_attempt_count >= 0 AND archive_attempt_count <= 4);
ALTER TABLE telemetry_log_epoch_reservations
  ADD COLUMN archive_retry_state TEXT NOT NULL DEFAULT 'active'
  CHECK (archive_retry_state IN ('active', 'backoff', 'quarantined'));
ALTER TABLE telemetry_log_epoch_reservations
  ADD COLUMN archive_retry_after TEXT;

CREATE INDEX telemetry_pending_archive_upload_watch
  ON telemetry_pending_archive_uploads(
    state, upload_watch_required, upload_watch_after, organization_id, archive_id
  );

CREATE INDEX telemetry_log_epoch_reservation_retry_fleet
  ON telemetry_log_epoch_reservations(
    organization_id, node_id, state, archive_retry_state, created_at
  );

-- A node may retain at most 32 unfinished exact ranges. This covers active,
-- backed-off, and quarantined operations; accepted ranges do not consume the
-- fleet budget. The route's durable spool keeps unaccepted bytes for retry.
CREATE TRIGGER telemetry_log_epoch_reservation_fleet_guard
BEFORE INSERT ON telemetry_log_epoch_reservations
WHEN NEW.state = 'reserved' AND (
  SELECT COUNT(*)
  FROM telemetry_log_epoch_reservations reservation
  WHERE reservation.organization_id = NEW.organization_id
    AND reservation.node_id = NEW.node_id
    AND reservation.state = 'reserved'
) >= 32
BEGIN
  SELECT RAISE(ABORT, 'telemetry unfinished archive fleet is saturated');
END;

CREATE TRIGGER telemetry_log_epoch_reservation_retry_guard
BEFORE UPDATE OF archive_attempt_generation, archive_attempt_count,
  archive_retry_state, archive_retry_after
ON telemetry_log_epoch_reservations
WHEN NEW.archive_attempt_generation < 0
  OR NEW.archive_attempt_generation > 3
  OR NEW.archive_attempt_count < 0
  OR NEW.archive_attempt_count > 4
  OR NOT (
    (NEW.archive_attempt_count = 0 AND NEW.archive_attempt_generation = 0)
    OR NEW.archive_attempt_count = NEW.archive_attempt_generation + 1
  )
  OR NEW.archive_retry_state NOT IN ('active', 'backoff', 'quarantined')
  OR (NEW.archive_retry_state = 'active' AND NEW.archive_retry_after IS NOT NULL)
  OR (NEW.archive_retry_state = 'backoff' AND NEW.archive_retry_after IS NULL)
  OR (NEW.archive_retry_state = 'quarantined' AND NEW.archive_retry_after IS NOT NULL)
  OR NEW.archive_attempt_generation < OLD.archive_attempt_generation
  OR NEW.archive_attempt_count < OLD.archive_attempt_count
  OR NEW.archive_attempt_generation > OLD.archive_attempt_generation + 1
  OR NEW.archive_attempt_count > OLD.archive_attempt_count + 1
  OR (
    OLD.state = 'accepted' AND (
      NEW.archive_attempt_generation IS NOT OLD.archive_attempt_generation
      OR NEW.archive_attempt_count IS NOT OLD.archive_attempt_count
      OR NEW.archive_retry_state IS NOT OLD.archive_retry_state
      OR NEW.archive_retry_after IS NOT OLD.archive_retry_after
    )
  )
  OR (
    OLD.archive_retry_state = 'quarantined' AND (
      NEW.archive_retry_state <> 'quarantined'
      OR NEW.archive_attempt_generation IS NOT OLD.archive_attempt_generation
      OR NEW.archive_attempt_count IS NOT OLD.archive_attempt_count
      OR NEW.archive_retry_after IS NOT OLD.archive_retry_after
    )
  )
  OR (
    OLD.archive_retry_state = 'active'
    AND NEW.archive_retry_state = 'active'
    AND NOT (
      (
        NEW.archive_attempt_generation = OLD.archive_attempt_generation
        AND NEW.archive_attempt_count = OLD.archive_attempt_count
        AND NEW.archive_retry_after IS NULL
      )
      OR (
        OLD.archive_attempt_count = 0
        AND OLD.archive_attempt_generation = 0
        AND NEW.archive_attempt_count = 1
        AND NEW.archive_attempt_generation = 0
        AND NEW.archive_retry_after IS NULL
      )
    )
  )
  OR (
    OLD.archive_retry_state = 'active'
    AND NEW.archive_retry_state IN ('backoff', 'quarantined')
    AND (
      NEW.archive_attempt_generation IS NOT OLD.archive_attempt_generation
      OR NEW.archive_attempt_count IS NOT OLD.archive_attempt_count
    )
  )
  OR (
    OLD.archive_retry_state = 'backoff'
    AND NEW.archive_retry_state = 'active'
    AND NOT (
      NEW.archive_attempt_generation = OLD.archive_attempt_generation + 1
      AND NEW.archive_attempt_count = OLD.archive_attempt_count + 1
      AND NEW.archive_retry_after IS NULL
    )
  )
  OR (
    OLD.archive_retry_state = 'backoff'
    AND NEW.archive_retry_state IN ('backoff', 'quarantined')
    AND (
      NEW.archive_attempt_generation IS NOT OLD.archive_attempt_generation
      OR NEW.archive_attempt_count IS NOT OLD.archive_attempt_count
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'telemetry archive retry control is invalid');
END;

-- Keep immutable archive identity/cleanup history from 0046, while allowing
-- only the tightly constrained upload-fence fields below to evolve.
DROP TRIGGER telemetry_pending_archive_immutable_update;
CREATE TRIGGER telemetry_pending_archive_immutable_update
BEFORE UPDATE ON telemetry_pending_archive_uploads
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.archive_id IS NOT OLD.archive_id
  OR NEW.archive_base_id IS NOT OLD.archive_base_id
  OR NEW.archive_generation IS NOT OLD.archive_generation
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

-- The first upload lease is the only upload owner for an archive generation.
-- An unresolved writer keeps its lease/key even after the hard deadline: only
-- a settled writer can release this exact cleanup target. Retries therefore
-- use a new generation only after the terminal row has been compacted into the
-- reservation's bounded retry ledger.
CREATE TRIGGER telemetry_pending_archive_upload_fence_guard
BEFORE UPDATE OF upload_lease_id, upload_claimed_at, upload_lease_expires_at,
  upload_claimed_ever, upload_watch_after, upload_watch_until,
  upload_watch_required, upload_writer_state, upload_writer_terminated_at, state
ON telemetry_pending_archive_uploads
WHEN (
  NEW.upload_claimed_ever NOT IN (0, 1)
  OR NEW.upload_watch_required NOT IN (0, 1)
  OR NEW.upload_writer_state NOT IN ('unresolved', 'terminated')
  OR NEW.upload_claimed_ever < OLD.upload_claimed_ever
  OR (
    NEW.upload_claimed_ever = 0 AND NOT (
      NEW.upload_lease_id IS NULL
      AND NEW.upload_claimed_at IS NULL
      AND NEW.upload_lease_expires_at IS NULL
      AND NEW.upload_watch_after IS NULL
      AND NEW.upload_watch_until IS NULL
      AND NEW.upload_watch_required = 0
      AND NEW.upload_writer_state = 'unresolved'
      AND NEW.upload_writer_terminated_at IS NULL
    )
  )
  OR (
    NEW.upload_claimed_ever = 1 AND NOT (
      NEW.upload_claimed_at IS NOT NULL
      AND NEW.upload_lease_expires_at IS NOT NULL
      AND NEW.upload_watch_after = NEW.upload_lease_expires_at
      AND NEW.upload_watch_until IS NULL
      AND NEW.upload_lease_expires_at > NEW.upload_claimed_at
      AND (
        (
          NEW.upload_writer_state = 'unresolved'
          AND NEW.upload_writer_terminated_at IS NULL
          AND NEW.upload_lease_id IS NOT NULL
          AND length(NEW.upload_lease_id) >= 16
          AND NEW.state = 'pending'
          AND NEW.cleanup_lease_id IS NULL
          AND NEW.upload_watch_required = 1
        )
        OR (
          NEW.upload_writer_state = 'terminated'
          AND NEW.upload_writer_terminated_at IS NOT NULL
          AND NEW.upload_lease_id IS NULL
          AND NEW.upload_watch_required = 0
          AND NEW.state IN ('pending', 'cleaned', 'accepted')
        )
      )
    )
  )
  OR (
    OLD.upload_claimed_ever = 1 AND (
      NEW.upload_claimed_at IS NOT OLD.upload_claimed_at
      OR NEW.upload_lease_expires_at IS NOT OLD.upload_lease_expires_at
      OR NEW.upload_watch_after IS NOT OLD.upload_watch_after
      OR NEW.upload_watch_until IS NOT OLD.upload_watch_until
    )
  )
  OR (
    OLD.upload_claimed_ever = 0
    AND NEW.upload_claimed_ever = 1
    AND NEW.upload_lease_id IS NULL
  )
  OR (
    OLD.upload_lease_id IS NOT NULL
    AND NEW.upload_lease_id IS NOT NULL
    AND NEW.upload_lease_id IS NOT OLD.upload_lease_id
  )
  OR (
    OLD.upload_lease_id IS NOT NULL
    AND NEW.upload_lease_id IS NULL
    AND NOT (
      NEW.state = 'accepted'
      OR (
        NEW.upload_writer_state = 'terminated'
        AND NEW.upload_writer_terminated_at IS NOT NULL
      )
    )
  )
  OR (
    OLD.upload_watch_required = 1
    AND NEW.upload_watch_required = 0
    AND NOT (
      NEW.state = 'accepted'
      OR (
        NEW.upload_writer_state = 'terminated'
        AND NEW.upload_writer_terminated_at IS NOT NULL
      )
    )
  )
  OR (
    OLD.upload_writer_state = 'terminated' AND (
      NEW.upload_writer_state <> 'terminated'
      OR NEW.upload_writer_terminated_at IS NOT OLD.upload_writer_terminated_at
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive upload fence is invalid');
END;

CREATE TRIGGER telemetry_pending_archive_upload_insert_guard
BEFORE INSERT ON telemetry_pending_archive_uploads
WHEN NEW.upload_claimed_ever <> 0
  OR NEW.upload_lease_id IS NOT NULL
  OR NEW.upload_claimed_at IS NOT NULL
  OR NEW.upload_lease_expires_at IS NOT NULL
  OR NEW.upload_watch_after IS NOT NULL
  OR NEW.upload_watch_until IS NOT NULL
  OR NEW.upload_watch_required <> 0
  OR NEW.upload_writer_state <> 'unresolved'
  OR NEW.upload_writer_terminated_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive upload fence must start empty');
END;

CREATE TRIGGER telemetry_pending_archive_retry_generation_guard
BEFORE INSERT ON telemetry_pending_archive_uploads
WHEN NEW.archive_generation > 3
BEGIN
  SELECT RAISE(ABORT, 'telemetry archive retry generation is quarantined');
END;

-- The fence is inserted in the final D1 batch immediately before the receipt.
-- It binds receipt acceptance to the exact active upload owner without adding
-- a mutable lease token to the immutable public receipt shape.
CREATE TABLE telemetry_archive_upload_acceptance_fences (
  organization_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  upload_lease_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, receipt_id),
  UNIQUE (organization_id, archive_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER telemetry_archive_upload_acceptance_fence_insert_guard
BEFORE INSERT ON telemetry_archive_upload_acceptance_fences
WHEN length(NEW.upload_lease_id) < 16
  OR NOT EXISTS (
    SELECT 1
    FROM telemetry_pending_archive_uploads pending
    WHERE pending.organization_id = NEW.organization_id
      AND pending.archive_id = NEW.archive_id
      AND pending.state = 'pending'
      AND pending.cleanup_lease_id IS NULL
      AND pending.cleanup_claimed_ever = 0
      AND pending.upload_claimed_ever = 1
      AND pending.upload_watch_required = 1
      AND pending.upload_writer_state = 'unresolved'
      AND pending.upload_writer_terminated_at IS NULL
      AND pending.upload_lease_id = NEW.upload_lease_id
      AND pending.upload_lease_expires_at > NEW.accepted_at
  )
BEGIN
  SELECT RAISE(ABORT, 'telemetry archive receipt requires the active upload lease');
END;

CREATE TRIGGER telemetry_archive_upload_acceptance_fence_immutable_update
BEFORE UPDATE ON telemetry_archive_upload_acceptance_fences
BEGIN
  SELECT RAISE(ABORT, 'telemetry archive upload acceptance fence is immutable');
END;

CREATE TRIGGER telemetry_archive_upload_acceptance_fence_immutable_delete
BEFORE DELETE ON telemetry_archive_upload_acceptance_fences
BEGIN
  SELECT RAISE(ABORT, 'telemetry archive upload acceptance fence cannot be deleted');
END;

-- Legacy (pre-0055) rows never claimed an upload lease, so historical receipt
-- repair remains possible. Every new upload-claimed row must present the exact
-- acceptance fence in the same atomic batch as its receipt.
CREATE TRIGGER telemetry_ingestion_receipt_upload_lease_guard
BEFORE INSERT ON telemetry_ingestion_receipts
WHEN NEW.archive_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM telemetry_pending_archive_uploads pending
    WHERE pending.organization_id = NEW.organization_id
      AND pending.archive_id = NEW.archive_id
      AND pending.upload_claimed_ever = 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM telemetry_archive_upload_acceptance_fences fence
    WHERE fence.organization_id = NEW.organization_id
      AND fence.receipt_id = NEW.id
      AND fence.archive_id = NEW.archive_id
      AND fence.accepted_at = NEW.accepted_at
  )
BEGIN
  SELECT RAISE(ABORT, 'telemetry receipt is missing its exact upload acceptance fence');
END;

-- A receipt turns the active lease into an accepted archive in the same D1
-- transaction. `changes()` makes a stale/expired owner fail atomically rather
-- than leaving a receipt whose pending row was not advanced.
CREATE TRIGGER telemetry_ingestion_receipt_upload_accept
AFTER INSERT ON telemetry_ingestion_receipts
WHEN NEW.archive_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM telemetry_archive_upload_acceptance_fences fence
    WHERE fence.organization_id = NEW.organization_id
      AND fence.receipt_id = NEW.id
      AND fence.archive_id = NEW.archive_id
      AND fence.accepted_at = NEW.accepted_at
  )
BEGIN
  UPDATE telemetry_pending_archive_uploads
  SET state = 'accepted', cleanup_lease_id = NULL, cleanup_claimed_at = NULL,
      cleanup_lease_expires_at = NULL, upload_lease_id = NULL,
      upload_watch_required = 0, upload_writer_state = 'terminated',
      upload_writer_terminated_at = NEW.accepted_at, updated_at = NEW.accepted_at
  WHERE organization_id = NEW.organization_id
    AND archive_id = NEW.archive_id
    AND state = 'pending'
    AND cleanup_lease_id IS NULL
    AND cleanup_claimed_ever = 0
    AND upload_claimed_ever = 1
    AND upload_watch_required = 1
    AND upload_writer_state = 'unresolved'
    AND upload_writer_terminated_at IS NULL
    AND upload_lease_id = (
      SELECT upload_lease_id
      FROM telemetry_archive_upload_acceptance_fences
      WHERE organization_id = NEW.organization_id
        AND receipt_id = NEW.id
    )
    AND upload_lease_expires_at > NEW.accepted_at;
  SELECT CASE WHEN changes() = 1 THEN 1
    ELSE RAISE(ABORT, 'telemetry receipt lost its active upload lease') END;
END;

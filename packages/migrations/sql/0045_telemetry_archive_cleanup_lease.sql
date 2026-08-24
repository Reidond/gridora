PRAGMA foreign_keys = ON;

-- R2 and D1 cannot share a transaction. A cleanup lease makes the delete
-- saga durable: cleanup claims the pending identity before touching R2, while
-- a final receipt is fenced until an expired lease is explicitly released.
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN cleanup_lease_id TEXT;
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN cleanup_claimed_at TEXT;
ALTER TABLE telemetry_pending_archive_uploads ADD COLUMN cleanup_lease_expires_at TEXT;

CREATE INDEX telemetry_pending_archive_cleanup_lease
  ON telemetry_pending_archive_uploads(state, cleanup_lease_expires_at, organization_id, archive_id);

-- Replace the initial state guard only to permit an exact cleaned identity to
-- be re-armed by a retrying durable agent. Its R2/archive metadata remains
-- immutable; a new cleanup deadline must move forward and no lease may carry
-- across the re-arm.
DROP TRIGGER telemetry_pending_archive_immutable_update;
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
  -- The reconciliation deadline is immutable too, except when an exact
  -- cleaned identity is deliberately re-armed for a durable agent retry.
  -- Without this fence a writer could postpone cleanup of an arbitrary
  -- pending object while preserving the rest of its identity.
  OR (
    NEW.cleanup_after IS NOT OLD.cleanup_after AND NOT (
      OLD.state = 'cleaned'
      AND NEW.state = 'pending'
      AND NEW.cleanup_lease_id IS NULL
      AND NEW.cleanup_claimed_at IS NULL
      AND NEW.cleanup_lease_expires_at IS NULL
      AND NEW.cleanup_after > OLD.cleanup_after
    )
  )
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.state = 'accepted' AND NEW.state <> 'accepted')
  OR (
    OLD.state = 'cleaned' AND NEW.state <> 'cleaned' AND NOT (
      NEW.state = 'pending'
      AND NEW.cleanup_lease_id IS NULL
      AND NEW.cleanup_claimed_at IS NULL
      AND NEW.cleanup_lease_expires_at IS NULL
      AND NEW.cleanup_after > OLD.cleanup_after
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive identity is immutable');
END;

CREATE TRIGGER telemetry_pending_archive_cleanup_lease_guard
BEFORE UPDATE OF cleanup_lease_id, cleanup_claimed_at, cleanup_lease_expires_at, state
ON telemetry_pending_archive_uploads
WHEN (
  (NEW.cleanup_lease_id IS NULL AND (
    NEW.cleanup_claimed_at IS NOT NULL OR NEW.cleanup_lease_expires_at IS NOT NULL
  ))
  OR (NEW.cleanup_lease_id IS NOT NULL AND (
    NEW.cleanup_claimed_at IS NULL
    OR NEW.cleanup_lease_expires_at IS NULL
    OR length(NEW.cleanup_lease_id) < 16
    OR NEW.cleanup_lease_expires_at <= NEW.cleanup_claimed_at
  ))
  OR (NEW.state IN ('accepted', 'cleaned') AND NEW.cleanup_lease_id IS NOT NULL)
  -- A replacement owner may only take a lease after the recorded owner has
  -- expired. This fences a delayed stale Worker from deleting a new retry.
  OR (
    OLD.cleanup_lease_id IS NOT NULL
    AND NEW.cleanup_lease_id IS NOT NULL
    AND NEW.cleanup_lease_id IS NOT OLD.cleanup_lease_id
    AND NEW.cleanup_claimed_at <= OLD.cleanup_lease_expires_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive cleanup lease is invalid');
END;

-- A receipt and a cleanup claim are mutually exclusive. The ingress runtime
-- releases only an expired claim before this insert; an active claim makes the
-- request retry rather than allowing an R2 delete after receipt acceptance.
CREATE TRIGGER telemetry_ingestion_receipt_cleanup_lease_guard
BEFORE INSERT ON telemetry_ingestion_receipts
WHEN NEW.archive_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM telemetry_pending_archive_uploads pending
  WHERE pending.organization_id = NEW.organization_id
    AND pending.archive_id = NEW.archive_id
    AND pending.state = 'pending'
    AND pending.cleanup_lease_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry receipt blocked by active archive cleanup lease');
END;

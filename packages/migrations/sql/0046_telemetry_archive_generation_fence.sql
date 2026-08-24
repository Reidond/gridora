PRAGMA foreign_keys = ON;

-- An expired cleanup lease is not a lifetime ownership proof: a delayed
-- worker may resume after a fresh retry has been accepted. Preserve every
-- prior R2 key as a tombstone and make each retry a new immutable attempt.
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN archive_base_id TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN archive_generation INTEGER NOT NULL DEFAULT 0
  CHECK (archive_generation >= 0 AND archive_generation <= 999999);
ALTER TABLE telemetry_pending_archive_uploads
  ADD COLUMN cleanup_claimed_ever INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_claimed_ever IN (0, 1));

-- Rows written before this migration were generation zero. Their existing
-- archive ID/key remain immutable and are never re-used by a later attempt.
UPDATE telemetry_pending_archive_uploads
SET archive_base_id = archive_id
WHERE archive_base_id = '';
UPDATE telemetry_pending_archive_uploads
SET cleanup_claimed_ever = 1
-- Pre-0046 pending rows have no durable ownership history. Conservatively
-- fence every one instead of assuming a now-null lease was never claimed.
WHERE state = 'pending'
   OR cleanup_lease_id IS NOT NULL
   OR cleanup_claimed_at IS NOT NULL
   OR cleanup_lease_expires_at IS NOT NULL;

CREATE UNIQUE INDEX telemetry_pending_archive_attempt_generation
  ON telemetry_pending_archive_uploads(organization_id, archive_base_id, archive_generation);

-- Supersede the 0045 temporary re-arm exception. A cleaned attempt is now a
-- permanent tombstone: retrying telemetry inserts generation n + 1 with a
-- different archive ID and R2 key instead of ever reviving this key.
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

-- Keep cleanup ownership history even after a worker releases an expired or
-- conflicting lease. The history, rather than the currently-null lease, is
-- what forces a retry into a new R2 generation.
DROP TRIGGER telemetry_pending_archive_cleanup_lease_guard;
CREATE TRIGGER telemetry_pending_archive_cleanup_lease_guard
BEFORE UPDATE OF cleanup_lease_id, cleanup_claimed_at, cleanup_lease_expires_at,
  cleanup_claimed_ever, state
ON telemetry_pending_archive_uploads
WHEN (
  NEW.cleanup_claimed_ever NOT IN (0, 1)
  OR NEW.cleanup_claimed_ever < OLD.cleanup_claimed_ever
  OR (NEW.cleanup_lease_id IS NULL AND (
    NEW.cleanup_claimed_at IS NOT NULL OR NEW.cleanup_lease_expires_at IS NOT NULL
  ))
  OR (NEW.cleanup_lease_id IS NOT NULL AND (
    NEW.cleanup_claimed_ever <> 1
    OR NEW.cleanup_claimed_at IS NULL
    OR NEW.cleanup_lease_expires_at IS NULL
    OR length(NEW.cleanup_lease_id) < 16
    OR NEW.cleanup_lease_expires_at <= NEW.cleanup_claimed_at
  ))
  OR (NEW.state IN ('accepted', 'cleaned') AND NEW.cleanup_lease_id IS NOT NULL)
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

-- A released/expired lease can still have an in-flight R2 delete. Do not let
-- ingress accept the same generation merely because the current lease fields
-- are null; it must allocate the next immutable key instead.
DROP TRIGGER telemetry_ingestion_receipt_cleanup_lease_guard;
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

-- The generated archive ID is deliberately part of the R2 key. This makes a
-- stale delete harmless to a later generation even if the original lease has
-- expired before its R2 HEAD/DELETE round trip returns.
CREATE TRIGGER telemetry_pending_archive_generation_insert_guard
BEFORE INSERT ON telemetry_pending_archive_uploads
WHEN NEW.archive_base_id = ''
  OR NEW.archive_generation < 0
  OR NEW.archive_generation > 999999
  OR NEW.cleanup_claimed_ever <> 0
  OR NEW.archive_id <> CASE
    WHEN NEW.archive_generation = 0 THEN NEW.archive_base_id
    ELSE NEW.archive_base_id || '_g' || NEW.archive_generation
  END
  OR NEW.r2_key NOT LIKE
    'organizations/' || NEW.organization_id || '/logs/' || NEW.server_id ||
    '/epochs/' || NEW.stream_epoch || '/%/' || NEW.archive_id || '.ndjson.gz'
BEGIN
  SELECT RAISE(ABORT, 'telemetry pending archive generation identity is invalid');
END;

-- Bind physical cleanup of an abandoned partial upload to the exact terminal
-- create job that owned the R2 prefix. Available/expired artifacts have no
-- source job because their completed catalog row is the ownership evidence.
ALTER TABLE backup_deletion_claims ADD COLUMN source_job_id TEXT;
ALTER TABLE backup_deletion_claims ADD COLUMN source_job_operation_id TEXT;

ALTER TABLE backup_physical_deletion_receipts ADD COLUMN source_job_id TEXT;
ALTER TABLE backup_physical_deletion_receipts ADD COLUMN source_job_operation_id TEXT;

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
    -- The catalog revision is advanced immediately before the claim insert.
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
BEGIN
  SELECT RAISE(ABORT, 'backup deletion claim is fenced');
END;

CREATE TRIGGER backup_deletion_claim_source_immutable
BEFORE UPDATE OF source_job_id, source_job_operation_id ON backup_deletion_claims
BEGIN
  SELECT RAISE(ABORT, 'backup deletion source ownership is immutable');
END;

-- A terminal create owner cannot be reopened after its prefix has been
-- claimed. Otherwise a successful R2 delete could be followed by a receipt
-- fence and strand the artifact without physical evidence.
CREATE TRIGGER backup_partial_cleanup_source_job_fence
BEFORE UPDATE OF state ON backup_jobs
WHEN NEW.state <> OLD.state AND EXISTS (
  SELECT 1 FROM backup_deletion_claims claim
  WHERE claim.organization_id = OLD.organization_id
    AND claim.source_job_id = OLD.id
    AND claim.source_job_operation_id = OLD.operation_id
    AND claim.state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'backup cleanup source job is claimed');
END;

CREATE TRIGGER backup_partial_cleanup_source_operation_fence
BEFORE UPDATE OF status ON operations
WHEN NEW.status <> OLD.status AND EXISTS (
  SELECT 1 FROM backup_deletion_claims claim
  WHERE claim.organization_id = OLD.organization_id
    AND claim.source_job_operation_id = OLD.id
    AND claim.state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'backup cleanup source operation is claimed');
END;

-- Retention selection is a snapshot. Once physical deletion owns an artifact
-- revision, expiry must not advance that revision between R2 deletion and the
-- operation-bound D1 receipt.
CREATE TRIGGER backup_expiry_active_deletion_guard
BEFORE UPDATE OF state ON backups
WHEN OLD.state = 'available' AND NEW.state = 'expired' AND EXISTS (
  SELECT 1 FROM backup_deletion_claims claim
  WHERE claim.organization_id = OLD.organization_id
    AND claim.backup_id = OLD.id
    AND claim.artifact_revision = OLD.revision
    AND claim.r2_key = OLD.r2_key
    AND claim.state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'backup expiry is fenced by physical deletion');
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
)
BEGIN
  SELECT RAISE(ABORT, 'backup physical deletion receipt is fenced');
END;

-- The legacy organization-item guard accepted `expired` as deletion evidence.
-- Require the exact immutable physical receipt for every resolved backup item.
CREATE TRIGGER organization_deletion_backup_item_physical_receipt_guard
BEFORE UPDATE OF state ON organization_deletion_items
WHEN NEW.kind = 'backup' AND NEW.state = 'resolved' AND OLD.state <> 'resolved'
  AND NOT EXISTS (
    SELECT 1
    FROM backup_physical_deletion_receipts receipt
    JOIN backup_deletion_claims claim
      ON claim.organization_id = receipt.organization_id AND claim.id = receipt.claim_id
    JOIN operations operation
      ON operation.organization_id = receipt.organization_id AND operation.id = receipt.operation_id
    JOIN backups backup
      ON backup.organization_id = receipt.organization_id AND backup.id = receipt.backup_id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.backup_id = NEW.resource_id
      AND receipt.r2_key = backup.r2_key
      AND claim.state = 'deleted'
      AND operation.status = 'succeeded'
      AND backup.state = 'deleted'
  )
BEGIN
  SELECT RAISE(ABORT, 'organization backup item requires physical deletion');
END;

-- Recreate the 0052 guards without a state allow-list. A failed or cancelled
-- create may already own encrypted chunks even though no manifest was ever
-- published, so every delete-policy catalog row needs terminal physical proof.
DROP TRIGGER organization_ready_requires_backup_physical_deletion;

CREATE TRIGGER organization_ready_requires_backup_physical_deletion
BEFORE UPDATE OF state ON organization_deletion_runs
WHEN NEW.state = 'ready-to-tombstone' AND NEW.backup_policy = 'delete-after-retention'
  AND EXISTS (
    SELECT 1 FROM backups backup
    WHERE backup.organization_id = NEW.organization_id
      AND NOT EXISTS (
        SELECT 1
        FROM backup_physical_deletion_receipts receipt
        JOIN backup_deletion_claims claim
          ON claim.organization_id = receipt.organization_id AND claim.id = receipt.claim_id
        JOIN operations operation
          ON operation.organization_id = receipt.organization_id
         AND operation.id = receipt.operation_id
        WHERE receipt.organization_id = backup.organization_id
          AND receipt.backup_id = backup.id
          AND receipt.r2_key = backup.r2_key
          AND claim.state = 'deleted'
          AND operation.status = 'succeeded'
          AND backup.state = 'deleted'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'organization backup physical deletion is incomplete');
END;

DROP TRIGGER organization_tombstone_requires_backup_physical_deletion;

CREATE TRIGGER organization_tombstone_requires_backup_physical_deletion
BEFORE UPDATE OF status ON organizations
WHEN OLD.status = 'deleting' AND NEW.status = 'deleted' AND EXISTS (
  SELECT 1 FROM organization_deletion_runs run
  WHERE run.organization_id = OLD.id
    AND run.backup_policy = 'delete-after-retention'
    AND EXISTS (
      SELECT 1 FROM backups backup
      WHERE backup.organization_id = OLD.id
        AND NOT EXISTS (
          SELECT 1
          FROM backup_physical_deletion_receipts receipt
          JOIN backup_deletion_claims claim
            ON claim.organization_id = receipt.organization_id AND claim.id = receipt.claim_id
          JOIN operations operation
            ON operation.organization_id = receipt.organization_id
           AND operation.id = receipt.operation_id
          WHERE receipt.organization_id = backup.organization_id
            AND receipt.backup_id = backup.id
            AND receipt.r2_key = backup.r2_key
            AND claim.state = 'deleted'
            AND operation.status = 'succeeded'
            AND backup.state = 'deleted'
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'organization tombstone backup physical deletion is incomplete');
END;

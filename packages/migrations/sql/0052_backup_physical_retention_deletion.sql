-- A backup is not physically deleted merely because retention made it
-- unavailable. Persist the immutable acceptance provenance used by delayed
-- deletion and an operation-bound receipt for the exact private-R2 prefix.
ALTER TABLE backup_deletion_claims
  ADD COLUMN audit_actor_type TEXT
  CHECK (audit_actor_type IS NULL OR audit_actor_type IN ('human', 'automation', 'system'));

ALTER TABLE backup_deletion_claims
  ADD COLUMN audit_request_context_json TEXT
  CHECK (
    audit_request_context_json IS NULL
    OR (json_valid(audit_request_context_json) AND length(audit_request_context_json) <= 8192)
  );

-- A pre-0052 in-flight claim may continue only when its already committed v1
-- acceptance envelope contains the exact actor and source. Do not synthesize
-- human request evidence when that envelope is absent.
UPDATE backup_deletion_claims AS claim
SET audit_actor_type = (
      SELECT json_extract(envelope.envelope_json, '$.actor.type')
      FROM audit_event_envelopes envelope
      WHERE envelope.scope = 'tenant'
        AND envelope.organization_id = claim.organization_id
        AND envelope.event_id = 'audit-backup-delete-' || claim.id
    ),
    audit_request_context_json = (
      SELECT json_object(
        'origin', json_extract(envelope.envelope_json, '$.source.origin'),
        'requestId', json_extract(envelope.envelope_json, '$.request.id'),
        'correlationId', json_extract(envelope.envelope_json, '$.request.correlationId'),
        'source', json_object(
          'ip', json(json_extract(envelope.envelope_json, '$.source.ip')),
          'access', json(json_extract(envelope.envelope_json, '$.source.access'))
        )
      )
      FROM audit_event_envelopes envelope
      WHERE envelope.scope = 'tenant'
        AND envelope.organization_id = claim.organization_id
        AND envelope.event_id = 'audit-backup-delete-' || claim.id
    )
WHERE EXISTS (
  SELECT 1 FROM audit_event_envelopes envelope
  WHERE envelope.scope = 'tenant'
    AND envelope.organization_id = claim.organization_id
    AND envelope.event_id = 'audit-backup-delete-' || claim.id
);

CREATE TRIGGER backup_deletion_claim_provenance_guard
BEFORE INSERT ON backup_deletion_claims
WHEN NEW.audit_actor_type IS NULL OR NEW.audit_request_context_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'backup deletion provenance is required');
END;

CREATE TRIGGER backup_deletion_claim_provenance_immutable
BEFORE UPDATE OF audit_actor_type, audit_request_context_json ON backup_deletion_claims
BEGIN
  SELECT RAISE(ABORT, 'backup deletion provenance is immutable');
END;

CREATE TABLE backup_physical_deletion_receipts (
  organization_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 1),
  r2_key TEXT NOT NULL,
  deleted_objects INTEGER NOT NULL CHECK (deleted_objects >= 0),
  already_absent INTEGER NOT NULL CHECK (already_absent IN (0, 1)),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, backup_id),
  UNIQUE (organization_id, claim_id),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, claim_id)
    REFERENCES backup_deletion_claims(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id)
    REFERENCES backups(organization_id, id) ON DELETE RESTRICT,
  CHECK (already_absent = 1 OR deleted_objects > 0),
  CHECK (r2_key LIKE 'organizations/' || organization_id || '/%')
) WITHOUT ROWID, STRICT;

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
    AND claim.state = 'deleting'
    AND backup.revision = claim.artifact_revision
    AND backup.state IN ('available', 'expired')
    AND backup.r2_key = claim.r2_key
    AND backup.r2_key = 'organizations/' || backup.organization_id || '/servers/' ||
      backup.server_id || '/backups/' || backup.id
    AND operation.type = 'delete-backup'
    AND operation.resource_type = 'backup'
    AND operation.resource_id = backup.id
    AND operation.status IN ('queued', 'running', 'retrying')
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

CREATE TRIGGER backup_physical_deletion_receipt_immutable_update
BEFORE UPDATE ON backup_physical_deletion_receipts
BEGIN
  SELECT RAISE(ABORT, 'backup physical deletion receipt is immutable');
END;

CREATE TRIGGER backup_physical_deletion_receipt_immutable_delete
BEFORE DELETE ON backup_physical_deletion_receipts
BEGIN
  SELECT RAISE(ABORT, 'backup physical deletion receipt is immutable');
END;

CREATE TRIGGER backup_deleted_requires_physical_receipt
BEFORE UPDATE OF state ON backups
WHEN NEW.state = 'deleted' AND OLD.state <> 'deleted' AND NOT EXISTS (
  SELECT 1 FROM backup_physical_deletion_receipts receipt
  WHERE receipt.organization_id = OLD.organization_id
    AND receipt.backup_id = OLD.id
    AND receipt.artifact_revision = OLD.revision
    AND receipt.r2_key = OLD.r2_key
)
BEGIN
  SELECT RAISE(ABORT, 'backup physical deletion receipt is required');
END;

CREATE TRIGGER backup_claim_deleted_requires_physical_receipt
BEFORE UPDATE OF state ON backup_deletion_claims
WHEN NEW.state = 'deleted' AND OLD.state <> 'deleted' AND NOT EXISTS (
  SELECT 1 FROM backup_physical_deletion_receipts receipt
  WHERE receipt.organization_id = OLD.organization_id
    AND receipt.claim_id = OLD.id
    AND receipt.operation_id = OLD.operation_id
    AND receipt.backup_id = OLD.backup_id
    AND receipt.artifact_revision = OLD.artifact_revision
    AND receipt.r2_key = OLD.r2_key
)
BEGIN
  SELECT RAISE(ABORT, 'backup claim physical deletion receipt is required');
END;

CREATE TRIGGER backup_delete_operation_success_requires_physical_receipt
BEFORE UPDATE OF status ON operations
WHEN OLD.type = 'delete-backup' AND NEW.status = 'succeeded' AND OLD.status <> 'succeeded'
  AND NOT EXISTS (
    SELECT 1 FROM backup_physical_deletion_receipts receipt
    WHERE receipt.organization_id = OLD.organization_id
      AND receipt.operation_id = OLD.id
      AND receipt.backup_id = OLD.resource_id
  )
BEGIN
  SELECT RAISE(ABORT, 'backup operation physical deletion receipt is required');
END;

-- An expired catalog row or an in-flight claim is not physical deletion
-- evidence. Organization deletion may advance only when every delete-policy
-- backup has the exact immutable receipt and terminal operation.
CREATE TRIGGER organization_ready_requires_backup_physical_deletion
BEFORE UPDATE OF state ON organization_deletion_runs
WHEN NEW.state = 'ready-to-tombstone' AND NEW.backup_policy = 'delete-after-retention'
  AND EXISTS (
    SELECT 1 FROM backups backup
    WHERE backup.organization_id = NEW.organization_id
      AND backup.state IN ('available', 'expired', 'deleted')
      AND NOT EXISTS (
        SELECT 1
        FROM backup_physical_deletion_receipts receipt
        JOIN backup_deletion_claims claim
          ON claim.organization_id = receipt.organization_id
         AND claim.id = receipt.claim_id
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

CREATE TRIGGER organization_tombstone_requires_backup_physical_deletion
BEFORE UPDATE OF status ON organizations
WHEN OLD.status = 'deleting' AND NEW.status = 'deleted' AND EXISTS (
  SELECT 1 FROM organization_deletion_runs run
  WHERE run.organization_id = OLD.id
    AND run.backup_policy = 'delete-after-retention'
    AND EXISTS (
      SELECT 1 FROM backups backup
      WHERE backup.organization_id = OLD.id
        AND backup.state IN ('available', 'expired', 'deleted')
        AND NOT EXISTS (
          SELECT 1
          FROM backup_physical_deletion_receipts receipt
          JOIN backup_deletion_claims claim
            ON claim.organization_id = receipt.organization_id
           AND claim.id = receipt.claim_id
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

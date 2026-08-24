ALTER TABLE organization_deletion_runs
ADD COLUMN audit_request_context_json TEXT
  CHECK (
    audit_request_context_json IS NULL OR (
      length(audit_request_context_json) BETWEEN 2 AND 8192
      AND json_valid(audit_request_context_json)
      AND json_type(audit_request_context_json, '$') = 'object'
      AND json_type(audit_request_context_json, '$.origin') = 'text'
      AND json_type(audit_request_context_json, '$.requestId') = 'text'
      AND json_type(audit_request_context_json, '$.correlationId') = 'text'
      AND json_type(audit_request_context_json, '$.source') = 'object'
      AND json_type(audit_request_context_json, '$.source.ip') = 'object'
      AND json_type(audit_request_context_json, '$.source.access') = 'object'
    )
  );

-- SQLite requires one exact parent key for the composite lifecycle references.
-- The original table had separate PRIMARY KEY/UNIQUE constraints, which do not
-- satisfy a composite foreign key once all migrations are active.
CREATE UNIQUE INDEX organization_deletion_runs_operation_scope_unique
ON organization_deletion_runs(organization_id, operation_id);

CREATE TRIGGER organization_deletion_audit_provenance_required
BEFORE INSERT ON organization_deletion_runs
WHEN NEW.audit_request_context_json IS NULL
BEGIN SELECT RAISE(ABORT, 'organization deletion audit provenance is required'); END;

CREATE TRIGGER organization_deletion_audit_provenance_immutable
BEFORE UPDATE OF audit_request_context_json ON organization_deletion_runs
WHEN NEW.audit_request_context_json <> OLD.audit_request_context_json
BEGIN SELECT RAISE(ABORT, 'organization deletion audit provenance is immutable'); END;

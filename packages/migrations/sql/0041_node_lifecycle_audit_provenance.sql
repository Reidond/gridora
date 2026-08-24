-- A node lifecycle Workflow can perform a provider mutation after the HTTP
-- acceptance has returned. Preserve the edge evidence with that immutable
-- acceptance so later terminal child audits never invent a client request.
ALTER TABLE node_lifecycle_runs
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

-- Existing historical runs remain readable. Every acceptance created after
-- this migration must carry a complete, immutable request-context envelope.
CREATE TRIGGER node_lifecycle_audit_provenance_required
BEFORE INSERT ON node_lifecycle_runs
WHEN NEW.audit_request_context_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle audit provenance is required');
END;

CREATE TRIGGER node_lifecycle_audit_provenance_immutable
BEFORE UPDATE OF audit_request_context_json ON node_lifecycle_runs
WHEN NEW.audit_request_context_json IS NOT OLD.audit_request_context_json
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle audit provenance is immutable');
END;

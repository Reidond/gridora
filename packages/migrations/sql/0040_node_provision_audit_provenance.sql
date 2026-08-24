-- The provider call is asynchronous and can outlive the originating HTTP
-- request. Preserve the complete edge provenance on the immutable acceptance
-- record so provider/adoption/registration audit facts retain the original
-- request and Access context instead of fabricating an internal request.
ALTER TABLE node_provision_acceptances
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

-- Existing acceptances predate full v1 evidence. New external work must not
-- start without a durable request context that can be replayed exactly.
CREATE TRIGGER node_provision_audit_provenance_required
BEFORE INSERT ON node_provision_acceptances
WHEN NEW.audit_request_context_json IS NULL
BEGIN SELECT RAISE(ABORT, 'node provision audit provenance is required'); END;

CREATE TRIGGER node_provision_audit_provenance_immutable
BEFORE UPDATE OF audit_request_context_json ON node_provision_acceptances
WHEN NEW.audit_request_context_json <> OLD.audit_request_context_json
BEGIN SELECT RAISE(ABORT, 'node provision audit provenance is immutable'); END;

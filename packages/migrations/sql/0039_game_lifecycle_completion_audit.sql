PRAGMA foreign_keys = ON;

-- A lifecycle acceptance is immutable input to a later Workflow.  Keep the
-- exact audit event id on that acceptance so a terminal child cannot discover
-- provenance by a best-effort correlation search after response loss.
ALTER TABLE game_lifecycle_mutations
  ADD COLUMN acceptance_audit_event_id TEXT;

ALTER TABLE game_lifecycle_moves
  ADD COLUMN acceptance_audit_event_id TEXT;

CREATE TRIGGER game_lifecycle_mutation_acceptance_audit_provenance
BEFORE INSERT ON game_lifecycle_mutations
WHEN NEW.acceptance_audit_event_id IS NULL
  OR length(NEW.acceptance_audit_event_id) = 0
  OR NOT EXISTS (
    SELECT 1
    FROM audit_events audit
    WHERE audit.organization_id = NEW.organization_id
      AND audit.id = NEW.acceptance_audit_event_id
      AND audit.target_type = 'server'
      AND audit.target_id = NEW.server_id
      AND audit.result = 'succeeded'
      AND audit.action = 'game-server.' || NEW.action || '.accepted'
  )
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle acceptance audit provenance is invalid');
END;

CREATE TRIGGER game_lifecycle_move_acceptance_audit_provenance
BEFORE INSERT ON game_lifecycle_moves
WHEN NEW.acceptance_audit_event_id IS NULL
  OR length(NEW.acceptance_audit_event_id) = 0
  OR NOT EXISTS (
    SELECT 1
    FROM audit_events audit
    WHERE audit.organization_id = NEW.organization_id
      AND audit.id = NEW.acceptance_audit_event_id
      AND audit.target_type = 'server'
      AND audit.target_id = NEW.server_id
      AND audit.result = 'succeeded'
      AND audit.action = 'game-server.move.accepted'
  )
BEGIN
  SELECT RAISE(ABORT, 'game move acceptance audit provenance is invalid');
END;

CREATE TRIGGER game_lifecycle_mutation_acceptance_audit_immutable
BEFORE UPDATE OF acceptance_audit_event_id ON game_lifecycle_mutations
WHEN NEW.acceptance_audit_event_id IS NOT OLD.acceptance_audit_event_id
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle acceptance audit provenance is immutable');
END;

CREATE TRIGGER game_lifecycle_move_acceptance_audit_immutable
BEFORE UPDATE OF acceptance_audit_event_id ON game_lifecycle_moves
WHEN NEW.acceptance_audit_event_id IS NOT OLD.acceptance_audit_event_id
BEGIN
  SELECT RAISE(ABORT, 'game move acceptance audit provenance is immutable');
END;

-- The provider/agent side effect is not complete when a command is queued.
-- This receipt is the durable terminal boundary: it is written in the same D1
-- transaction as a succeeded completion operation, its v1 audit event/envelope,
-- and the bounded evidence summary.  A retry adopts this exact row.
CREATE TABLE game_lifecycle_completion_receipts (
  organization_id TEXT NOT NULL,
  lifecycle_operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'create', 'delete', 'start', 'stop', 'restart', 'update',
    'apply-config', 'sync-mods', 'move'
  )),
  step_name TEXT NOT NULL,
  completion_operation_id TEXT NOT NULL,
  completion_event_id TEXT NOT NULL,
  acceptance_audit_event_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (
    json_valid(evidence_json)
    AND json_type(evidence_json) = 'object'
    AND length(CAST(evidence_json AS BLOB)) <= 81920
  ),
  state TEXT NOT NULL CHECK (state = 'succeeded'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, lifecycle_operation_id, step_name),
  UNIQUE (organization_id, completion_operation_id),
  UNIQUE (organization_id, completion_event_id),
  FOREIGN KEY (organization_id, lifecycle_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX game_lifecycle_completion_server
  ON game_lifecycle_completion_receipts(organization_id, server_id, created_at DESC);

CREATE TRIGGER game_lifecycle_completion_receipt_scope
BEFORE INSERT ON game_lifecycle_completion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM operations lifecycle
  JOIN game_servers server
    ON server.organization_id = lifecycle.organization_id
   AND server.id = NEW.server_id
  WHERE lifecycle.organization_id = NEW.organization_id
    AND lifecycle.id = NEW.lifecycle_operation_id
    AND lifecycle.resource_type = 'server'
    AND lifecycle.resource_id = NEW.server_id
    AND lifecycle.type = CASE NEW.action
      WHEN 'create' THEN 'server.create'
      WHEN 'delete' THEN 'server.delete'
      WHEN 'start' THEN 'server.start'
      WHEN 'stop' THEN 'server.stop'
      WHEN 'restart' THEN 'server.restart'
      WHEN 'update' THEN 'server.update'
      WHEN 'apply-config' THEN 'server.configure'
      WHEN 'sync-mods' THEN 'server.mods.sync'
      WHEN 'move' THEN 'server.move'
    END
)
OR NOT EXISTS (
  SELECT 1
  FROM operations lifecycle
  JOIN operations completion
    ON completion.organization_id = lifecycle.organization_id
   AND completion.id = NEW.completion_operation_id
  WHERE lifecycle.organization_id = NEW.organization_id
    AND lifecycle.id = NEW.lifecycle_operation_id
    AND completion.type = 'server.lifecycle.completion'
    AND completion.resource_type = 'server'
    AND completion.resource_id = NEW.server_id
    AND completion.actor_id = lifecycle.actor_id
    AND completion.correlation_id = lifecycle.correlation_id
    AND completion.status = 'succeeded'
    AND completion.idempotency_key = NEW.completion_operation_id
)
OR (
  NEW.action <> 'move'
  AND NOT EXISTS (
    SELECT 1
    FROM game_lifecycle_mutations mutation
    WHERE mutation.organization_id = NEW.organization_id
      AND mutation.operation_id = NEW.lifecycle_operation_id
      AND mutation.server_id = NEW.server_id
      AND mutation.action = NEW.action
  )
)
OR (
  NEW.action = 'move'
  AND NOT EXISTS (
    SELECT 1
    FROM game_lifecycle_moves move
    WHERE move.organization_id = NEW.organization_id
      AND move.operation_id = NEW.lifecycle_operation_id
      AND move.server_id = NEW.server_id
      AND move.acceptance_audit_event_id = NEW.acceptance_audit_event_id
  )
)
OR NOT EXISTS (
  SELECT 1
  FROM audit_events accepted
  JOIN audit_event_envelopes accepted_envelope
    ON accepted_envelope.scope = 'tenant'
   AND accepted_envelope.organization_id = accepted.organization_id
   AND accepted_envelope.event_id = accepted.id
  JOIN operations lifecycle
    ON lifecycle.organization_id = accepted.organization_id
   AND lifecycle.id = NEW.lifecycle_operation_id
  WHERE accepted.organization_id = NEW.organization_id
    AND accepted.id = NEW.acceptance_audit_event_id
    AND accepted.target_type = 'server'
    AND accepted.target_id = NEW.server_id
    AND accepted.result = 'succeeded'
    AND accepted.correlation_id = lifecycle.correlation_id
    AND accepted_envelope.schema_version = 1
    AND accepted_envelope.capture_status = 'complete'
    AND json_extract(accepted_envelope.envelope_json, '$.operationId') = 'audit:' || NEW.lifecycle_operation_id
    AND json_extract(accepted_envelope.envelope_json, '$.target.type') = 'server'
    AND json_extract(accepted_envelope.envelope_json, '$.target.id') = NEW.server_id
)
OR NOT EXISTS (
  SELECT 1
  FROM audit_events completed
  JOIN operations lifecycle
    ON lifecycle.organization_id = completed.organization_id
   AND lifecycle.id = NEW.lifecycle_operation_id
  WHERE completed.organization_id = NEW.organization_id
    AND completed.id = NEW.completion_event_id
    AND completed.actor_id = lifecycle.actor_id
    AND completed.action = 'game-server.' || NEW.action || '.completed'
    AND completed.target_type = 'server'
    AND completed.target_id = NEW.server_id
    AND completed.result = 'succeeded'
    AND completed.correlation_id = lifecycle.correlation_id
    AND json(completed.summary_json) = json(NEW.evidence_json)
)
OR NOT EXISTS (
  SELECT 1
  FROM audit_event_envelopes completed_envelope
  JOIN audit_event_envelopes accepted_envelope
    ON accepted_envelope.scope = completed_envelope.scope
   AND accepted_envelope.organization_id = completed_envelope.organization_id
   AND accepted_envelope.event_id = NEW.acceptance_audit_event_id
  JOIN operations completion
    ON completion.organization_id = completed_envelope.organization_id
   AND completion.id = NEW.completion_operation_id
  WHERE completed_envelope.scope = 'tenant'
    AND completed_envelope.organization_id = NEW.organization_id
    AND completed_envelope.event_id = NEW.completion_event_id
    AND completed_envelope.schema_version = 1
    AND completed_envelope.capture_status = 'complete'
    AND json_extract(completed_envelope.envelope_json, '$.operationId') = NEW.completion_operation_id
    AND json_extract(completed_envelope.envelope_json, '$.action') = 'game-server.' || NEW.action || '.completed'
    AND json_extract(completed_envelope.envelope_json, '$.target.type') = 'server'
    AND json_extract(completed_envelope.envelope_json, '$.target.id') = NEW.server_id
    AND json_extract(completed_envelope.envelope_json, '$.request') = json_extract(accepted_envelope.envelope_json, '$.request')
    AND json_extract(completed_envelope.envelope_json, '$.source') = json_extract(accepted_envelope.envelope_json, '$.source')
    AND json_extract(completed_envelope.envelope_json, '$.actor') = json_extract(accepted_envelope.envelope_json, '$.actor')
    AND completion.status = 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle completion evidence fence failed');
END;

CREATE TRIGGER game_lifecycle_completion_receipt_immutable_update
BEFORE UPDATE ON game_lifecycle_completion_receipts
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.lifecycle_operation_id IS NOT OLD.lifecycle_operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.action IS NOT OLD.action
  OR NEW.step_name IS NOT OLD.step_name
  OR NEW.completion_operation_id IS NOT OLD.completion_operation_id
  OR NEW.completion_event_id IS NOT OLD.completion_event_id
  OR NEW.acceptance_audit_event_id IS NOT OLD.acceptance_audit_event_id
  OR NEW.evidence_json IS NOT OLD.evidence_json
  OR NEW.state IS NOT OLD.state
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle completion receipt is immutable');
END;

CREATE TRIGGER game_lifecycle_completion_receipt_immutable_delete
BEFORE DELETE ON game_lifecycle_completion_receipts
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle completion receipt is immutable');
END;

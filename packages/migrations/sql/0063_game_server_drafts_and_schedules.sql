PRAGMA foreign_keys = ON;

CREATE TABLE game_server_drafts (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  source_server_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'scheduled', 'materialized', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_id TEXT NOT NULL,
  acceptance_audit_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  UNIQUE (acceptance_audit_event_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_audit_event_id)
    REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE game_server_draft_schedules (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  scheduled_for TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'dispatching', 'retrying', 'accepted', 'failed', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_id TEXT NOT NULL,
  target_operation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  claim_id TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  acceptance_audit_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, draft_id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  UNIQUE (acceptance_audit_event_id),
  FOREIGN KEY (organization_id, draft_id)
    REFERENCES game_server_drafts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_audit_event_id)
    REFERENCES audit_events(id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('scheduled', 'retrying', 'failed', 'cancelled') AND claim_id IS NULL AND lease_expires_at IS NULL)
    OR (state = 'dispatching' AND claim_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state = 'accepted' AND claim_id IS NULL AND lease_expires_at IS NULL AND target_operation_id IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX game_server_draft_schedules_due
  ON game_server_draft_schedules(state, scheduled_for, updated_at);

CREATE TRIGGER game_server_draft_acceptance_fence
BEFORE INSERT ON game_server_drafts
WHEN NOT EXISTS (
  SELECT 1 FROM operations operation
  JOIN audit_events audit
    ON audit.organization_id = operation.organization_id
   AND audit.id = NEW.acceptance_audit_event_id
  JOIN audit_event_envelopes envelope
    ON envelope.scope = 'tenant'
   AND envelope.organization_id = operation.organization_id
   AND envelope.event_id = audit.id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.type = 'game-server.draft.create'
    AND operation.resource_type = 'game-server-draft'
    AND operation.resource_id = NEW.id
    AND operation.actor_id = NEW.actor_id
    AND operation.idempotency_key = NEW.idempotency_key
    AND operation.status = 'succeeded'
    AND operation.progress = 100
    AND audit.actor_id = NEW.actor_id
    AND audit.action = 'game-server.draft.create'
    AND audit.target_type = 'game-server-draft'
    AND audit.target_id = NEW.id
    AND audit.result = 'succeeded'
    AND json_extract(envelope.envelope_json, '$.version') = 1
    AND json_extract(envelope.envelope_json, '$.operationId') = operation.id
    AND json_extract(envelope.envelope_json, '$.target.id') = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'game server draft acceptance fence failed');
END;

CREATE TRIGGER game_server_draft_schedule_acceptance_fence
BEFORE INSERT ON game_server_draft_schedules
WHEN NOT EXISTS (
  SELECT 1 FROM game_server_drafts draft
  JOIN operations operation
    ON operation.organization_id = draft.organization_id
   AND operation.id = NEW.operation_id
  JOIN audit_events audit
    ON audit.organization_id = operation.organization_id
   AND audit.id = NEW.acceptance_audit_event_id
  JOIN audit_event_envelopes envelope
    ON envelope.scope = 'tenant'
   AND envelope.organization_id = operation.organization_id
   AND envelope.event_id = audit.id
  WHERE draft.organization_id = NEW.organization_id
    AND draft.id = NEW.draft_id
    AND draft.state = 'draft'
    AND operation.type = 'game-server.draft.schedule'
    AND operation.resource_type = 'game-server-draft'
    AND operation.resource_id = NEW.draft_id
    AND operation.actor_id = NEW.actor_id
    AND operation.idempotency_key = NEW.idempotency_key
    AND operation.status = 'succeeded'
    AND operation.progress = 100
    AND audit.actor_id = NEW.actor_id
    AND audit.action = 'game-server.draft.schedule'
    AND audit.target_type = 'game-server-draft'
    AND audit.target_id = NEW.draft_id
    AND audit.result = 'succeeded'
    AND json_extract(envelope.envelope_json, '$.version') = 1
    AND json_extract(envelope.envelope_json, '$.operationId') = operation.id
    AND json_extract(envelope.envelope_json, '$.target.id') = NEW.draft_id
)
BEGIN
  SELECT RAISE(ABORT, 'game server draft schedule acceptance fence failed');
END;

CREATE TRIGGER game_server_draft_coordinates_immutable
BEFORE UPDATE OF organization_id, id, actor_id, idempotency_key,
  request_fingerprint, manifest_json, source_server_id, operation_id,
  acceptance_audit_event_id, created_at ON game_server_drafts
BEGIN
  SELECT RAISE(ABORT, 'game server draft coordinates are immutable');
END;

CREATE TRIGGER game_server_draft_schedule_coordinates_immutable
BEFORE UPDATE OF organization_id, id, draft_id, actor_id, idempotency_key,
  request_fingerprint, scheduled_for, operation_id, acceptance_audit_event_id,
  created_at ON game_server_draft_schedules
BEGIN
  SELECT RAISE(ABORT, 'game server draft schedule coordinates are immutable');
END;

CREATE TRIGGER game_server_draft_transition_fence
BEFORE UPDATE OF state, revision, updated_at ON game_server_drafts
WHEN NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.state = 'draft' AND NEW.state IN ('scheduled', 'cancelled'))
    OR (OLD.state = 'scheduled' AND NEW.state IN ('materialized', 'cancelled'))
  )
  OR (NEW.state = 'scheduled' AND NOT EXISTS (
    SELECT 1 FROM game_server_draft_schedules schedule
    WHERE schedule.organization_id = NEW.organization_id
      AND schedule.draft_id = NEW.id AND schedule.state = 'scheduled'
  ))
  OR (NEW.state = 'materialized' AND NOT EXISTS (
    SELECT 1 FROM game_server_draft_schedules schedule
    WHERE schedule.organization_id = NEW.organization_id
      AND schedule.draft_id = NEW.id AND schedule.state = 'accepted'
      AND schedule.target_operation_id IS NOT NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'game server draft transition fence failed');
END;

CREATE TRIGGER game_server_draft_schedule_transition_fence
BEFORE UPDATE OF state, revision, target_operation_id, attempts, claim_id,
  lease_expires_at, last_error_code, updated_at ON game_server_draft_schedules
WHEN NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.state IN ('scheduled', 'retrying') AND NEW.state = 'dispatching'
      AND NEW.claim_id IS NOT NULL AND NEW.lease_expires_at IS NOT NULL
      AND NEW.attempts = OLD.attempts + 1 AND NEW.attempts <= 8)
    OR (OLD.state = 'dispatching' AND NEW.state = 'dispatching'
      AND OLD.lease_expires_at <= NEW.updated_at
      AND NEW.claim_id IS NOT NULL AND NEW.claim_id <> OLD.claim_id
      AND NEW.lease_expires_at IS NOT NULL
      AND NEW.attempts = OLD.attempts + 1 AND NEW.attempts <= 8)
    OR (OLD.state = 'dispatching' AND NEW.state IN ('retrying', 'failed')
      AND NEW.claim_id IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.attempts = OLD.attempts)
    OR (OLD.state = 'dispatching' AND NEW.state = 'accepted'
      AND NEW.claim_id IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.target_operation_id IS NOT NULL AND NEW.attempts = OLD.attempts)
    OR (OLD.state IN ('scheduled', 'retrying') AND NEW.state = 'cancelled'
      AND NEW.claim_id IS NULL AND NEW.lease_expires_at IS NULL)
  )
  OR (NEW.state = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.organization_id = NEW.organization_id
      AND operation.id = NEW.target_operation_id
      AND operation.type = 'server-provision-plan'
      AND operation.resource_type = 'server-provision'
      AND operation.idempotency_key = 'scheduled-game:' || NEW.id
      AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying', 'succeeded')
  ))
BEGIN
  SELECT RAISE(ABORT, 'game server draft schedule transition fence failed');
END;

CREATE TRIGGER game_server_draft_immutable_delete
BEFORE DELETE ON game_server_drafts
BEGIN SELECT RAISE(ABORT, 'game server draft is immutable history'); END;

CREATE TRIGGER game_server_draft_schedule_immutable_delete
BEFORE DELETE ON game_server_draft_schedules
BEGIN SELECT RAISE(ABORT, 'game server draft schedule is immutable history'); END;

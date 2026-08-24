-- Generic, organization-scoped operation detail projection. Source-specific
-- workflow receipts remain authoritative; these rows expose only bounded,
-- non-secret facts needed by the shared API, CLI, and dashboard.
CREATE TABLE operation_detail_projection (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  waiting_reason TEXT CHECK (waiting_reason IS NULL OR length(waiting_reason) BETWEEN 1 AND 500),
  provider_reference_hint TEXT CHECK (
    provider_reference_hint IS NULL OR length(provider_reference_hint) BETWEEN 1 AND 80
  ),
  recovery_code TEXT NOT NULL CHECK (recovery_code IN (
    'none', 'wait-for-external-evidence', 'inspect-terminal-failure', 'cancelled'
  )),
  final_resource_type TEXT,
  final_resource_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (final_resource_type IS NULL AND final_resource_id IS NULL)
    OR (final_resource_type IS NOT NULL AND final_resource_id IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TABLE operation_detail_steps (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'destructive-workflow', 'game-command', 'backup-workflow', 'node-runtime'
  )),
  source_key TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, source_type, source_key),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR started_at IS NOT NULL)
) WITHOUT ROWID, STRICT;

CREATE INDEX operation_detail_steps_timeline
  ON operation_detail_steps(organization_id, operation_id, sequence, source_type, source_key);

CREATE TABLE operation_detail_log_events (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 160),
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'failed', 'denied')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, audit_event_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX operation_detail_log_events_timeline
  ON operation_detail_log_events(organization_id, operation_id, created_at, audit_event_id);

INSERT INTO operation_detail_projection
  (organization_id, operation_id, retry_count, waiting_reason, provider_reference_hint,
   recovery_code, final_resource_type, final_resource_id, updated_at)
SELECT organization_id, id, 0, NULL, NULL,
  CASE status
    WHEN 'waiting_external' THEN 'wait-for-external-evidence'
    WHEN 'failed' THEN 'inspect-terminal-failure'
    WHEN 'failed_terminal' THEN 'inspect-terminal-failure'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'none'
  END,
  CASE WHEN status = 'succeeded' THEN resource_type ELSE NULL END,
  CASE WHEN status = 'succeeded' THEN resource_id ELSE NULL END,
  updated_at
FROM operations;

CREATE TRIGGER operation_detail_projection_on_operation_insert
AFTER INSERT ON operations
BEGIN
  INSERT INTO operation_detail_projection
    (organization_id, operation_id, retry_count, waiting_reason, provider_reference_hint,
     recovery_code, final_resource_type, final_resource_id, updated_at)
  VALUES (
    NEW.organization_id, NEW.id, 0, NULL, NULL,
    CASE NEW.status
      WHEN 'waiting_external' THEN 'wait-for-external-evidence'
      WHEN 'failed' THEN 'inspect-terminal-failure'
      WHEN 'failed_terminal' THEN 'inspect-terminal-failure'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE 'none'
    END,
    CASE WHEN NEW.status = 'succeeded' THEN NEW.resource_type ELSE NULL END,
    CASE WHEN NEW.status = 'succeeded' THEN NEW.resource_id ELSE NULL END,
    NEW.updated_at
  );
END;

CREATE TRIGGER operation_detail_projection_on_operation_update
AFTER UPDATE OF status, resource_type, resource_id, updated_at ON operations
BEGIN
  UPDATE operation_detail_projection
  SET recovery_code = CASE NEW.status
        WHEN 'waiting_external' THEN 'wait-for-external-evidence'
        WHEN 'failed' THEN 'inspect-terminal-failure'
        WHEN 'failed_terminal' THEN 'inspect-terminal-failure'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'none'
      END,
      final_resource_type = CASE WHEN NEW.status = 'succeeded' THEN NEW.resource_type ELSE NULL END,
      final_resource_id = CASE WHEN NEW.status = 'succeeded' THEN NEW.resource_id ELSE NULL END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.id;
END;

INSERT INTO operation_detail_steps
  (organization_id, operation_id, source_type, source_key, sequence, label, state,
   attempt, started_at, completed_at, updated_at)
SELECT organization_id, operation_id, 'destructive-workflow', CAST(ordinal AS TEXT), ordinal,
  step_name,
  CASE state WHEN 'completed' THEN 'complete' WHEN 'cancelled' THEN 'cancelled' ELSE 'running' END,
  claim_attempt, started_at, completed_at, COALESCE(completed_at, started_at)
FROM operation_cancellation_step_receipts;

CREATE TRIGGER operation_detail_destructive_step_insert
AFTER INSERT ON operation_cancellation_step_receipts
BEGIN
  INSERT INTO operation_detail_steps
    (organization_id, operation_id, source_type, source_key, sequence, label, state,
     attempt, started_at, completed_at, updated_at)
  VALUES (NEW.organization_id, NEW.operation_id, 'destructive-workflow', CAST(NEW.ordinal AS TEXT),
    NEW.ordinal, NEW.step_name,
    CASE NEW.state WHEN 'completed' THEN 'complete' WHEN 'cancelled' THEN 'cancelled' ELSE 'running' END,
    NEW.claim_attempt, NEW.started_at, NEW.completed_at, COALESCE(NEW.completed_at, NEW.started_at));
  UPDATE operation_detail_projection
  SET retry_count = max(retry_count, NEW.claim_attempt - 1), updated_at = NEW.started_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

CREATE TRIGGER operation_detail_destructive_step_update
AFTER UPDATE OF state, claim_attempt, completed_at ON operation_cancellation_step_receipts
BEGIN
  UPDATE operation_detail_steps
  SET state = CASE NEW.state
        WHEN 'completed' THEN 'complete' WHEN 'cancelled' THEN 'cancelled' ELSE 'running' END,
      attempt = NEW.claim_attempt, completed_at = NEW.completed_at,
      updated_at = COALESCE(NEW.completed_at, NEW.started_at)
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id
    AND source_type = 'destructive-workflow' AND source_key = CAST(NEW.ordinal AS TEXT);
  UPDATE operation_detail_projection
  SET retry_count = max(retry_count, NEW.claim_attempt - 1),
      updated_at = COALESCE(NEW.completed_at, NEW.started_at)
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

INSERT INTO operation_detail_steps
  (organization_id, operation_id, source_type, source_key, sequence, label, state,
   attempt, started_at, completed_at, updated_at)
SELECT delivery.organization_id, delivery.operation_id, 'game-command', delivery.step_name,
  row_number() OVER (
    PARTITION BY delivery.organization_id, delivery.operation_id
    ORDER BY delivery.created_at, delivery.step_name
  ) - 1,
  delivery.step_name,
  CASE delivery.state
    WHEN 'pending' THEN 'pending' WHEN 'completed' THEN 'complete'
    WHEN 'failed' THEN 'failed' ELSE 'running'
  END,
  max(delivery.attempts, 1), delivery.created_at,
  CASE WHEN delivery.state IN ('completed', 'failed') THEN delivery.updated_at ELSE NULL END,
  delivery.updated_at
FROM game_command_deliveries delivery;

CREATE TRIGGER operation_detail_game_step_insert
AFTER INSERT ON game_command_deliveries
BEGIN
  INSERT INTO operation_detail_steps
    (organization_id, operation_id, source_type, source_key, sequence, label, state,
     attempt, started_at, completed_at, updated_at)
  SELECT NEW.organization_id, NEW.operation_id, 'game-command', NEW.step_name,
    COALESCE(max(sequence) + 1, 0), NEW.step_name,
    CASE NEW.state
      WHEN 'pending' THEN 'pending' WHEN 'completed' THEN 'complete'
      WHEN 'failed' THEN 'failed' ELSE 'running'
    END,
    max(NEW.attempts, 1), NEW.created_at,
    CASE WHEN NEW.state IN ('completed', 'failed') THEN NEW.updated_at ELSE NULL END,
    NEW.updated_at
  FROM operation_detail_steps
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id
    AND source_type = 'game-command';
  UPDATE operation_detail_projection
  SET retry_count = max(retry_count, max(NEW.attempts, 1) - 1), updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

CREATE TRIGGER operation_detail_game_step_update
AFTER UPDATE OF state, attempts, updated_at ON game_command_deliveries
BEGIN
  UPDATE operation_detail_steps
  SET state = CASE NEW.state
        WHEN 'pending' THEN 'pending' WHEN 'completed' THEN 'complete'
        WHEN 'failed' THEN 'failed' ELSE 'running'
      END,
      attempt = max(NEW.attempts, 1),
      completed_at = CASE WHEN NEW.state IN ('completed', 'failed') THEN NEW.updated_at ELSE NULL END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id
    AND source_type = 'game-command' AND source_key = NEW.step_name;
  UPDATE operation_detail_projection
  SET retry_count = max(retry_count, max(NEW.attempts, 1) - 1), updated_at = NEW.updated_at,
      waiting_reason = CASE WHEN NEW.state = 'failed' THEN 'game-command-failed' ELSE waiting_reason END
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

INSERT INTO operation_detail_steps
  (organization_id, operation_id, source_type, source_key, sequence, label, state,
   attempt, started_at, completed_at, updated_at)
SELECT receipt.organization_id, job.operation_id, 'backup-workflow', CAST(receipt.ordinal AS TEXT),
  receipt.ordinal, receipt.step,
  CASE receipt.state WHEN 'completed' THEN 'complete' ELSE 'running' END,
  1, receipt.created_at,
  CASE WHEN receipt.state = 'completed' THEN receipt.updated_at ELSE NULL END,
  receipt.updated_at
FROM backup_workflow_step_receipts receipt
JOIN backup_jobs job
  ON job.organization_id = receipt.organization_id AND job.id = receipt.job_id;

CREATE TRIGGER operation_detail_backup_step_insert
AFTER INSERT ON backup_workflow_step_receipts
BEGIN
  INSERT INTO operation_detail_steps
    (organization_id, operation_id, source_type, source_key, sequence, label, state,
     attempt, started_at, completed_at, updated_at)
  SELECT NEW.organization_id, job.operation_id, 'backup-workflow', CAST(NEW.ordinal AS TEXT),
    NEW.ordinal, NEW.step, CASE NEW.state WHEN 'completed' THEN 'complete' ELSE 'running' END,
    1, NEW.created_at, CASE WHEN NEW.state = 'completed' THEN NEW.updated_at ELSE NULL END,
    NEW.updated_at
  FROM backup_jobs job WHERE job.organization_id = NEW.organization_id AND job.id = NEW.job_id;
END;

CREATE TRIGGER operation_detail_backup_step_update
AFTER UPDATE OF state, updated_at ON backup_workflow_step_receipts
BEGIN
  UPDATE operation_detail_steps
  SET state = CASE NEW.state WHEN 'completed' THEN 'complete' ELSE 'running' END,
      completed_at = CASE WHEN NEW.state = 'completed' THEN NEW.updated_at ELSE NULL END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id
    AND operation_id = (SELECT operation_id FROM backup_jobs
      WHERE organization_id = NEW.organization_id AND id = NEW.job_id)
    AND source_type = 'backup-workflow' AND source_key = CAST(NEW.ordinal AS TEXT);
END;

INSERT INTO operation_detail_steps
  (organization_id, operation_id, source_type, source_key, sequence, label, state,
   attempt, started_at, completed_at, updated_at)
SELECT organization_id, operation_id, 'node-runtime', action, 0, action,
  CASE state
    WHEN 'pending' THEN 'pending' WHEN 'succeeded' THEN 'complete'
    WHEN 'failed-terminal' THEN 'failed' ELSE 'running'
  END,
  max(attempt, 1), created_at,
  CASE WHEN state IN ('succeeded', 'failed-terminal') THEN updated_at ELSE NULL END,
  updated_at
FROM node_runtime_lifecycle_executions;

CREATE TRIGGER operation_detail_node_runtime_insert
AFTER INSERT ON node_runtime_lifecycle_executions
BEGIN
  INSERT INTO operation_detail_steps
    (organization_id, operation_id, source_type, source_key, sequence, label, state,
     attempt, started_at, completed_at, updated_at)
  VALUES (NEW.organization_id, NEW.operation_id, 'node-runtime', NEW.action, 0, NEW.action,
    CASE NEW.state
      WHEN 'pending' THEN 'pending' WHEN 'succeeded' THEN 'complete'
      WHEN 'failed-terminal' THEN 'failed' ELSE 'running'
    END,
    max(NEW.attempt, 1), NEW.created_at,
    CASE WHEN NEW.state IN ('succeeded', 'failed-terminal') THEN NEW.updated_at ELSE NULL END,
    NEW.updated_at);
END;

CREATE TRIGGER operation_detail_node_runtime_update
AFTER UPDATE OF state, attempt, failure_code, updated_at ON node_runtime_lifecycle_executions
BEGIN
  UPDATE operation_detail_steps
  SET state = CASE NEW.state
        WHEN 'pending' THEN 'pending' WHEN 'succeeded' THEN 'complete'
        WHEN 'failed-terminal' THEN 'failed' ELSE 'running'
      END,
      attempt = max(NEW.attempt, 1),
      completed_at = CASE WHEN NEW.state IN ('succeeded', 'failed-terminal') THEN NEW.updated_at ELSE NULL END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id
    AND source_type = 'node-runtime' AND source_key = NEW.action;
  UPDATE operation_detail_projection
  SET retry_count = max(retry_count, max(NEW.attempt, 1) - 1),
      waiting_reason = CASE
        WHEN NEW.failure_code IS NOT NULL THEN NEW.failure_code
        WHEN NEW.state = 'reconciliation-required' THEN 'provider-reconciliation-required'
        ELSE waiting_reason
      END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

CREATE TRIGGER operation_detail_node_lifecycle_update
AFTER UPDATE OF blocked_reason, provider_request_reference, updated_at ON node_lifecycle_runs
BEGIN
  UPDATE operation_detail_projection
  SET waiting_reason = CASE
        WHEN NEW.blocked_reason IS NOT NULL THEN NEW.blocked_reason
        WHEN NEW.state = 'cancel-scheduled' THEN 'provider-cancellation-scheduled'
        ELSE waiting_reason
      END,
      provider_reference_hint = CASE
        WHEN NEW.provider_request_reference IS NULL THEN provider_reference_hint
        WHEN length(NEW.provider_request_reference) <= 8 THEN '[redacted]'
        ELSE substr(NEW.provider_request_reference, 1, 4) || '...' || substr(NEW.provider_request_reference, -4)
      END,
      updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

CREATE TRIGGER operation_detail_organization_deletion_update
AFTER UPDATE OF blocked_reason, updated_at ON organization_deletion_runs
WHEN NEW.blocked_reason IS NOT NULL
BEGIN
  UPDATE operation_detail_projection
  SET waiting_reason = NEW.blocked_reason, updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.operation_id;
END;

INSERT OR IGNORE INTO operation_detail_log_events
  (organization_id, operation_id, audit_event_id, action, result, created_at)
SELECT audit.organization_id, operation.id, audit.id, audit.action, audit.result, audit.created_at
FROM audit_events audit
JOIN operations operation
  ON operation.organization_id = audit.organization_id
 AND operation.id = json_extract(audit.summary_json, '$.operationId')
WHERE json_valid(audit.summary_json);

CREATE TRIGGER operation_detail_log_on_audit_insert
AFTER INSERT ON audit_events
WHEN json_valid(NEW.summary_json)
BEGIN
  INSERT OR IGNORE INTO operation_detail_log_events
    (organization_id, operation_id, audit_event_id, action, result, created_at)
  SELECT NEW.organization_id, operation.id, NEW.id, NEW.action, NEW.result, NEW.created_at
  FROM operations operation
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = json_extract(NEW.summary_json, '$.operationId');
END;

CREATE TRIGGER operation_detail_log_events_immutable_update
BEFORE UPDATE ON operation_detail_log_events
BEGIN SELECT RAISE(ABORT, 'operation detail log events are immutable'); END;

CREATE TRIGGER operation_detail_log_events_immutable_delete
BEFORE DELETE ON operation_detail_log_events
BEGIN SELECT RAISE(ABORT, 'operation detail log events are immutable'); END;

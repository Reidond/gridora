PRAGMA foreign_keys = ON;

-- A parent coordination receipt for the no-fit server path. It owns no
-- provider credentials or game runtime state; it only binds immutable intent
-- and exact child operations so a replay can adopt work after a lost response.
CREATE TABLE server_provision_plan_runs (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'administrator', 'operator')),
  actor_membership_revision INTEGER CHECK (
    actor_membership_revision IS NULL OR actor_membership_revision >= 1
  ),
  correlation_id TEXT NOT NULL,
  server_intent_json TEXT NOT NULL CHECK (json_valid(server_intent_json)),
  game_intent_json TEXT NOT NULL CHECK (json_valid(game_intent_json)),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  phase TEXT NOT NULL CHECK (phase IN (
    'accepted', 'waiting-node', 'ready-for-server', 'waiting-server',
    'succeeded', 'failed', 'compensating', 'compensated'
  )),
  node_id TEXT,
  node_provision_operation_id TEXT,
  game_server_id TEXT,
  game_operation_id TEXT,
  -- Only an auto-provisioned node may be retired by the parent. This exact
  -- child is persisted before its Workflow is started so a response loss can
  -- adopt it without ever selecting or retiring unrelated existing capacity.
  compensation_operation_id TEXT,
  terminal_audit_event_id TEXT,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 500),
  audit_event_id TEXT NOT NULL,
  workflow_start_record_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  audit_request_context_json TEXT NOT NULL CHECK (
    length(audit_request_context_json) BETWEEN 2 AND 8192
    AND json_valid(audit_request_context_json)
    AND json_type(audit_request_context_json, '$') = 'object'
    AND json_type(audit_request_context_json, '$.origin') = 'text'
    AND json_type(audit_request_context_json, '$.requestId') = 'text'
    AND json_type(audit_request_context_json, '$.correlationId') = 'text'
    AND json_type(audit_request_context_json, '$.source') = 'object'
    AND json_type(audit_request_context_json, '$.source.ip') = 'object'
    AND json_type(audit_request_context_json, '$.source.access') = 'object'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, resource_id),
  UNIQUE (organization_id, node_provision_operation_id),
  UNIQUE (organization_id, game_operation_id),
  UNIQUE (organization_id, compensation_operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_provision_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, game_server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, game_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, compensation_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES lifecycle_workflow_starts(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (terminal_audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT,
  CHECK ((node_provision_operation_id IS NULL) OR node_id IS NOT NULL),
  CHECK ((game_operation_id IS NULL) OR (game_server_id IS NOT NULL AND node_id IS NOT NULL)),
  CHECK ((compensation_operation_id IS NULL) OR node_provision_operation_id IS NOT NULL),
  CHECK ((phase <> 'compensating') OR compensation_operation_id IS NOT NULL),
  CHECK ((phase <> 'failed') OR terminal_audit_event_id IS NOT NULL),
  CHECK ((phase <> 'compensated') OR (
    compensation_operation_id IS NOT NULL AND terminal_audit_event_id IS NOT NULL
  )),
  CHECK ((terminal_audit_event_id IS NULL) OR phase IN ('failed', 'compensated')),
  CHECK ((phase <> 'waiting-node') OR node_provision_operation_id IS NOT NULL),
  CHECK ((phase NOT IN ('ready-for-server', 'waiting-server', 'succeeded')) OR node_id IS NOT NULL)
) WITHOUT ROWID, STRICT;

CREATE INDEX server_provision_plan_runs_operation
  ON server_provision_plan_runs(organization_id, phase, updated_at, operation_id);

CREATE TRIGGER server_provision_plan_run_admission
BEFORE INSERT ON server_provision_plan_runs
WHEN NEW.phase <> 'accepted'
  OR NEW.node_id IS NOT NULL
  OR NEW.node_provision_operation_id IS NOT NULL
  OR NEW.game_server_id IS NOT NULL
  OR NEW.game_operation_id IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.organization_id = NEW.organization_id
      AND operation.id = NEW.operation_id
      AND operation.type = 'server-provision-plan'
      AND operation.resource_type = 'server-provision'
      AND operation.resource_id = NEW.resource_id
      AND operation.actor_id = NEW.actor_id
      AND operation.idempotency_key = NEW.idempotency_key
      AND operation.correlation_id = NEW.correlation_id
      AND operation.status = 'queued'
  )
  OR NOT EXISTS (
    SELECT 1 FROM lifecycle_workflow_starts start
    WHERE start.organization_id = NEW.organization_id
      AND start.operation_id = NEW.operation_id
      AND start.start_record_id = NEW.workflow_start_record_id
      AND start.state = 'pending'
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'server.provision.accepted'
      AND audit.target_type = 'server-provision'
      AND audit.target_id = NEW.resource_id
      AND audit.result = 'succeeded'
      AND audit.correlation_id = NEW.correlation_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM outbox outbox
    WHERE outbox.organization_id = NEW.organization_id
      AND outbox.id = NEW.outbox_event_id
      AND outbox.event_type = 'lifecycle.workflow-start.requested'
      AND outbox.aggregate_id = NEW.operation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'server provision plan acceptance fence failed');
END;

CREATE TRIGGER server_provision_plan_run_identity_immutable
BEFORE UPDATE OF organization_id, idempotency_key, request_fingerprint, operation_id, resource_id,
  actor_id, actor_role, actor_membership_revision, correlation_id, server_intent_json, game_intent_json, plan_json,
  audit_event_id, workflow_start_record_id, outbox_event_id, audit_request_context_json, created_at
ON server_provision_plan_runs
BEGIN
  SELECT RAISE(ABORT, 'server provision plan immutable acceptance changed');
END;

CREATE TRIGGER server_provision_plan_compensation_immutable
BEFORE UPDATE OF compensation_operation_id, terminal_audit_event_id ON server_provision_plan_runs
WHEN
  (OLD.compensation_operation_id IS NOT NULL
    AND NEW.compensation_operation_id IS NOT OLD.compensation_operation_id)
  OR (OLD.terminal_audit_event_id IS NOT NULL
    AND NEW.terminal_audit_event_id IS NOT OLD.terminal_audit_event_id)
BEGIN
  SELECT RAISE(ABORT, 'server provision compensation evidence changed');
END;

CREATE TRIGGER server_provision_plan_node_child_fence
BEFORE UPDATE OF node_id, node_provision_operation_id ON server_provision_plan_runs
WHEN NEW.node_provision_operation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM node_provision_acceptances acceptance
    JOIN operations operation
      ON operation.organization_id = acceptance.organization_id
      AND operation.id = acceptance.operation_id
    WHERE acceptance.organization_id = NEW.organization_id
      AND acceptance.node_id = NEW.node_id
      AND acceptance.operation_id = NEW.node_provision_operation_id
      AND operation.type = 'provision-node'
  )
BEGIN
  SELECT RAISE(ABORT, 'server provision node child fence failed');
END;

CREATE TRIGGER server_provision_plan_game_child_fence
BEFORE UPDATE OF game_server_id, game_operation_id ON server_provision_plan_runs
WHEN NEW.game_operation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.organization_id = NEW.organization_id
      AND operation.id = NEW.game_operation_id
      AND operation.resource_type = 'server'
      AND operation.resource_id = NEW.game_server_id
  )
BEGIN
  SELECT RAISE(ABORT, 'server provision game child fence failed');
END;

CREATE TRIGGER server_provision_plan_compensation_child_fence
BEFORE UPDATE OF compensation_operation_id ON server_provision_plan_runs
WHEN NEW.compensation_operation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM destructive_lifecycle_operations lifecycle
    JOIN node_lifecycle_runs node_run
      ON node_run.organization_id = lifecycle.organization_id
     AND node_run.operation_id = lifecycle.operation_id
    JOIN operations operation
      ON operation.organization_id = lifecycle.organization_id
     AND operation.id = lifecycle.operation_id
    WHERE lifecycle.organization_id = NEW.organization_id
      AND lifecycle.operation_id = NEW.compensation_operation_id
      AND lifecycle.action = 'retire-node'
      AND lifecycle.resource_type = 'node'
      AND lifecycle.resource_id = NEW.node_id
      AND lifecycle.organization_deletion_operation_id IS NULL
      AND node_run.node_id = NEW.node_id
      AND node_run.action = 'retire-node'
      AND operation.type = 'retire-node'
      AND operation.resource_type = 'node'
      AND operation.resource_id = NEW.node_id
  )
BEGIN
  SELECT RAISE(ABORT, 'server provision compensation child fence failed');
END;

CREATE TRIGGER server_provision_plan_compensation_audit_fence
BEFORE UPDATE OF terminal_audit_event_id ON server_provision_plan_runs
WHEN NEW.terminal_audit_event_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.terminal_audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = NEW.actor_id
      AND audit.target_type = 'server-provision'
      AND audit.target_id = NEW.resource_id
      AND audit.result = 'failed'
      AND audit.correlation_id = NEW.correlation_id
      AND (
        (NEW.phase = 'failed' AND audit.action = 'server.provision.failed')
        OR (NEW.phase = 'compensated' AND audit.action = 'server.provision.compensated')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'server provision compensation audit fence failed');
END;

PRAGMA foreign_keys = ON;

-- This is a separate ledger from destructive node lifecycle runs. It owns only start, stop,
-- reboot, and reconcile intents and never changes provider retirement, rebuild, or image state.
CREATE TABLE node_runtime_lifecycle_workflow_starts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  start_record_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (workflow_type = 'NodeRuntimeLifecycleWorkflow'),
  workflow_instance_id TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL CHECK (
    length(params_fingerprint) = 64 AND params_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'adopted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (start_record_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  CHECK (workflow_instance_id = operation_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX node_runtime_lifecycle_workflow_starts_pending
  ON node_runtime_lifecycle_workflow_starts(state, updated_at, organization_id, operation_id);

CREATE TABLE node_runtime_lifecycle_executions (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start', 'stop', 'reboot', 'reconcile')),
  provider_account_id TEXT NOT NULL,
  provider_account_scope TEXT NOT NULL CHECK (provider_account_scope IN ('platform', 'organization')),
  provider_account_revision INTEGER NOT NULL CHECK (provider_account_revision > 0),
  provider_allocation_revision INTEGER NOT NULL CHECK (provider_allocation_revision > 0),
  provider_credential_reference TEXT NOT NULL,
  provider_credential_revision INTEGER NOT NULL CHECK (provider_credential_revision > 0),
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  provider_instance_id TEXT NOT NULL,
  previous_desired_state TEXT NOT NULL CHECK (previous_desired_state IN ('ready', 'stopped')),
  previous_desired_revision INTEGER NOT NULL CHECK (previous_desired_revision > 0),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('ready', 'stopped')),
  desired_revision INTEGER NOT NULL CHECK (desired_revision = previous_desired_revision + 1),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'leased', 'action-requested', 'waiting-observation', 'reconciliation-required',
    'succeeded', 'failed-terminal'
  )),
  lease_owner TEXT,
  lease_token TEXT,
  lease_until TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  action_requested_at TEXT,
  last_provider_state TEXT CHECK (last_provider_state IN (
    'active', 'stopped', 'transitional', 'missing', 'unknown'
  )),
  reboot_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (reboot_confirmed IN (0, 1)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'provider_authorization_blocked', 'provider_validation_blocked'
    , 'action_unproven_not_applied', 'action_delivery_unproven'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, node_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('leased', 'action-requested')
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state NOT IN ('leased', 'action-requested')
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CHECK (
    (state IN ('failed-terminal', 'reconciliation-required') AND failure_code IS NOT NULL)
    OR (state NOT IN ('failed-terminal', 'reconciliation-required') AND failure_code IS NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX node_runtime_lifecycle_execution_leases
  ON node_runtime_lifecycle_executions(state, lease_until, organization_id, operation_id);

-- A workflow may not make the provider call until this receipt exists. It is inserted last in
-- the dispatch-mark transaction so a stale operation row rolls the execution state back too.
CREATE TABLE node_runtime_lifecycle_dispatch_marks (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  lease_owner TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  action_requested_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, attempt),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_runtime_lifecycle_executions(organization_id, operation_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_runtime_lifecycle_dispatch_mark_guard
BEFORE INSERT ON node_runtime_lifecycle_dispatch_marks
WHEN NOT EXISTS (
  SELECT 1
  FROM node_runtime_lifecycle_executions execution
  JOIN nodes node
    ON node.organization_id = execution.organization_id AND node.id = execution.node_id
  JOIN operations operation
    ON operation.organization_id = execution.organization_id AND operation.id = execution.operation_id
  WHERE execution.organization_id = NEW.organization_id AND execution.operation_id = NEW.operation_id
    AND execution.attempt = NEW.attempt AND execution.state = 'action-requested'
    AND execution.lease_owner = NEW.lease_owner AND execution.lease_token = NEW.lease_token
    AND execution.action_requested_at = NEW.action_requested_at
    AND node.pending_lifecycle_operation_id = execution.operation_id
    AND node.desired_state = execution.desired_state AND node.desired_revision = execution.desired_revision
    AND node.provider_account_id = execution.provider_account_id
    AND node.provider_type = execution.provider_type
    AND node.provider_instance_id = execution.provider_instance_id
    AND operation.status = 'running' AND operation.resource_type = 'node'
    AND operation.resource_id = execution.node_id
)
BEGIN SELECT RAISE(ABORT, 'node runtime lifecycle dispatch mark fence failed'); END;

CREATE TABLE node_runtime_lifecycle_observations (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  provider_state TEXT NOT NULL CHECK (provider_state IN (
    'active', 'stopped', 'transitional', 'missing', 'unknown'
  )),
  reboot_confirmed INTEGER NOT NULL CHECK (reboot_confirmed IN (0, 1)),
  result_state TEXT NOT NULL CHECK (result_state IN (
    'succeeded', 'waiting-observation', 'reconciliation-required', 'failed-terminal'
  )),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, attempt),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_runtime_lifecycle_executions(organization_id, operation_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

-- This is the final statement in every observation or terminal-failure batch. Its trigger is a
-- transaction assertion: a stale node or lease can never leave a partial operation/execution
-- projection committed after the provider result was recorded.
CREATE TABLE node_runtime_lifecycle_execution_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  result_state TEXT NOT NULL CHECK (result_state IN (
    'succeeded', 'waiting-observation', 'reconciliation-required', 'failed-terminal'
  )),
  operation_status TEXT NOT NULL CHECK (operation_status IN (
    'succeeded', 'waiting_external', 'failed_terminal'
  )),
  node_desired_state TEXT NOT NULL CHECK (node_desired_state IN ('ready', 'stopped')),
  node_desired_revision INTEGER NOT NULL CHECK (node_desired_revision > 0),
  node_observed_state TEXT NOT NULL CHECK (node_observed_state IN (
    'unknown', 'provisioning', 'bootstrapping', 'ready', 'degraded', 'offline', 'deleting',
    'deleted', 'failed'
  )),
  node_observed_revision INTEGER NOT NULL CHECK (node_observed_revision >= 0),
  pending_cleared INTEGER NOT NULL CHECK (pending_cleared IN (0, 1)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  audit_event_id TEXT,
  outbox_event_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, attempt),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_runtime_lifecycle_executions(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id, attempt)
    REFERENCES node_runtime_lifecycle_observations(organization_id, operation_id, attempt)
    ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (result_state = 'waiting-observation' AND operation_status = 'waiting_external'
      AND pending_cleared = 0 AND audit_event_id IS NULL AND outbox_event_id IS NULL)
    OR
    (result_state = 'succeeded' AND operation_status = 'succeeded'
      AND pending_cleared = 1 AND audit_event_id IS NOT NULL AND outbox_event_id IS NOT NULL)
    OR
    (result_state IN ('reconciliation-required', 'failed-terminal')
      AND operation_status = 'failed_terminal' AND pending_cleared = 1
      AND audit_event_id IS NOT NULL AND outbox_event_id IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_runtime_lifecycle_execution_receipt_guard
BEFORE INSERT ON node_runtime_lifecycle_execution_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM node_runtime_lifecycle_executions execution
  JOIN nodes node
    ON node.organization_id = execution.organization_id AND node.id = execution.node_id
  JOIN operations operation
    ON operation.organization_id = execution.organization_id AND operation.id = execution.operation_id
  JOIN node_runtime_lifecycle_observations observation
    ON observation.organization_id = execution.organization_id
   AND observation.operation_id = execution.operation_id AND observation.attempt = execution.attempt
  LEFT JOIN audit_events audit ON audit.organization_id = execution.organization_id
    AND audit.id = NEW.audit_event_id
  LEFT JOIN outbox event ON event.organization_id = execution.organization_id
    AND event.id = NEW.outbox_event_id
  WHERE execution.organization_id = NEW.organization_id AND execution.operation_id = NEW.operation_id
    AND execution.attempt = NEW.attempt AND execution.state = NEW.result_state
    AND execution.result_json = NEW.result_json
    AND execution.lease_owner IS NULL AND execution.lease_token IS NULL AND execution.lease_until IS NULL
    AND node.desired_state = NEW.node_desired_state
    AND node.desired_revision = NEW.node_desired_revision
    AND node.observed_state = NEW.node_observed_state
    AND node.observed_revision = NEW.node_observed_revision
    AND (
      (NEW.pending_cleared = 0 AND node.pending_lifecycle_operation_id = execution.operation_id)
      OR (NEW.pending_cleared = 1 AND node.pending_lifecycle_operation_id IS NULL)
    )
    AND operation.status = NEW.operation_status
    AND operation.resource_type = 'node' AND operation.resource_id = execution.node_id
    AND observation.provider_state = execution.last_provider_state
    AND observation.reboot_confirmed = execution.reboot_confirmed
    AND observation.result_state = NEW.result_state AND observation.result_json = NEW.result_json
    AND (
      (NEW.result_state = 'waiting-observation'
        AND NEW.audit_event_id IS NULL AND NEW.outbox_event_id IS NULL)
      OR (NEW.result_state = 'succeeded'
        AND audit.action = 'node.runtime.' || execution.action || '.completed'
        AND audit.target_type = 'node' AND audit.target_id = execution.node_id AND audit.result = 'succeeded'
        AND event.event_type = 'node.runtime.lifecycle.completed'
        AND event.aggregate_type = 'node' AND event.aggregate_id = execution.node_id)
      OR (NEW.result_state = 'reconciliation-required'
        AND audit.action = 'node.runtime.lifecycle.reconciliation-required'
        AND audit.target_type = 'node' AND audit.target_id = execution.node_id AND audit.result = 'failed'
        AND event.event_type = 'node.runtime.lifecycle.reconciliation-required'
        AND event.aggregate_type = 'node' AND event.aggregate_id = execution.node_id)
      OR (NEW.result_state = 'failed-terminal'
        AND audit.action = 'node.runtime.lifecycle.blocked'
        AND audit.target_type = 'node' AND audit.target_id = execution.node_id AND audit.result = 'failed'
        AND event.event_type = 'node.runtime.lifecycle.blocked'
        AND event.aggregate_type = 'node' AND event.aggregate_id = execution.node_id)
    )
)
BEGIN SELECT RAISE(ABORT, 'node runtime lifecycle execution receipt fence failed'); END;

CREATE TABLE node_runtime_lifecycle_intents (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  action TEXT NOT NULL CHECK (action IN ('start', 'stop', 'reboot', 'reconcile')),
  node_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_account_scope TEXT NOT NULL CHECK (provider_account_scope IN ('platform', 'organization')),
  provider_account_revision INTEGER NOT NULL CHECK (provider_account_revision > 0),
  provider_allocation_revision INTEGER NOT NULL CHECK (provider_allocation_revision > 0),
  provider_credential_reference TEXT NOT NULL,
  provider_credential_revision INTEGER NOT NULL CHECK (provider_credential_revision > 0),
  previous_desired_state TEXT NOT NULL CHECK (previous_desired_state IN (
    'provisioning', 'ready', 'draining', 'stopped', 'deleted'
  )),
  previous_desired_revision INTEGER NOT NULL CHECK (previous_desired_revision > 0),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('ready', 'stopped')),
  desired_revision INTEGER NOT NULL CHECK (desired_revision = previous_desired_revision + 1),
  workflow_start_record_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_runtime_lifecycle_executions(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_runtime_lifecycle_workflow_starts(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (action = 'start' AND previous_desired_state = 'stopped' AND desired_state = 'ready')
    OR (action = 'stop' AND previous_desired_state = 'ready' AND desired_state = 'stopped')
    OR (action = 'reboot' AND previous_desired_state = 'ready' AND desired_state = 'ready')
    OR (action = 'reconcile' AND previous_desired_state IN ('ready', 'stopped')
      AND desired_state = previous_desired_state)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX node_runtime_lifecycle_intents_node
  ON node_runtime_lifecycle_intents(organization_id, node_id, created_at DESC);

-- The final intent row is an atomic receipt. It is accepted only after the target node, operation,
-- audit event, outbox event, workflow start, and execution lease row all prove the same intent.
--
-- Keep these guards deliberately split. Cloudflare D1 rejects the former single
-- predicate because its SQLite expression tree exceeds D1's depth limit. Each
-- trigger proves a disjoint part of the same conjunction, so an insert is still
-- accepted only when every receipt, provider snapshot, allocation and immutable
-- credential reference is present and exact.
CREATE TRIGGER node_runtime_lifecycle_intent_atomic_guard
BEFORE INSERT ON node_runtime_lifecycle_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM nodes node
  JOIN operations operation
    ON operation.organization_id = node.organization_id AND operation.id = NEW.operation_id
  JOIN node_runtime_lifecycle_workflow_starts start
    ON start.organization_id = operation.organization_id AND start.operation_id = operation.id
  JOIN node_runtime_lifecycle_executions execution
    ON execution.organization_id = operation.organization_id AND execution.operation_id = operation.id
  JOIN audit_events audit
    ON audit.organization_id = operation.organization_id AND audit.id = NEW.audit_event_id
  JOIN outbox event
    ON event.organization_id = operation.organization_id AND event.id = NEW.outbox_event_id
  JOIN organizations organization ON organization.id = operation.organization_id
  JOIN identities actor ON actor.id = operation.actor_id
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = actor.id
  WHERE node.organization_id = NEW.organization_id AND node.id = NEW.node_id
    AND node.pending_lifecycle_operation_id = NEW.operation_id
    AND node.desired_state = NEW.desired_state AND node.desired_revision = NEW.desired_revision
    AND operation.type = 'node.runtime.' || NEW.action
    AND operation.resource_type = 'node' AND operation.resource_id = NEW.node_id
    AND operation.idempotency_key = NEW.idempotency_key AND operation.status = 'queued'
    AND operation.revision = 1
    AND start.start_record_id = NEW.workflow_start_record_id
    AND start.workflow_type = 'NodeRuntimeLifecycleWorkflow'
    AND start.workflow_instance_id = NEW.operation_id
    AND start.params_fingerprint = NEW.request_fingerprint AND start.state = 'pending'
    AND execution.node_id = NEW.node_id AND execution.action = NEW.action
    AND execution.provider_account_id = NEW.provider_account_id
    AND execution.provider_account_scope = NEW.provider_account_scope
    AND execution.provider_account_revision = NEW.provider_account_revision
    AND execution.provider_allocation_revision = NEW.provider_allocation_revision
    AND execution.provider_credential_reference = NEW.provider_credential_reference
    AND execution.provider_credential_revision = NEW.provider_credential_revision
    AND execution.provider_type = node.provider_type
    AND execution.provider_instance_id = node.provider_instance_id
    AND execution.previous_desired_state = NEW.previous_desired_state
    AND execution.previous_desired_revision = NEW.previous_desired_revision
    AND execution.desired_state = NEW.desired_state AND execution.desired_revision = NEW.desired_revision
    AND execution.state = 'pending' AND execution.attempt = 0
    AND audit.action = 'node.runtime.' || NEW.action || '.accepted'
    AND audit.target_type = 'node' AND audit.target_id = NEW.node_id AND audit.result = 'succeeded'
    AND event.event_type = 'node.runtime.lifecycle.requested'
    AND event.aggregate_type = 'node' AND event.aggregate_id = NEW.node_id
    AND organization.status = 'active' AND actor.status = 'active'
    AND membership.status = 'active' AND membership.role IN ('owner', 'administrator', 'operator')
)
BEGIN SELECT RAISE(ABORT, 'node runtime lifecycle atomic acceptance fence failed'); END;

-- Account and allocation facts are checked separately from the intent receipt
-- graph above. This is an AND with the core guard, not a fallback: a missing,
-- foreign, rotated, disabled, or different-provider account rejects the insert.
CREATE TRIGGER node_runtime_lifecycle_intent_provider_snapshot_guard
BEFORE INSERT ON node_runtime_lifecycle_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM nodes node
  JOIN provider_accounts account ON account.id = NEW.provider_account_id
  JOIN provider_allocations allocation
    ON allocation.organization_id = NEW.organization_id
   AND allocation.provider_account_id = account.id
  WHERE node.organization_id = NEW.organization_id AND node.id = NEW.node_id
    AND account.scope = NEW.provider_account_scope
    AND account.revision = NEW.provider_account_revision
    AND account.provider_type = node.provider_type
    AND account.credential_reference = NEW.provider_credential_reference
    AND account.status = 'active'
    AND (account.scope = 'platform' OR account.organization_id = NEW.organization_id)
    AND allocation.status = 'active'
    AND allocation.revision = NEW.provider_allocation_revision
)
BEGIN SELECT RAISE(ABORT, 'node runtime lifecycle provider snapshot fence failed'); END;

-- Tenant account credentials must be the immutable envelope revision captured by
-- the intent. This remains independent of mutable account state above.
CREATE TRIGGER node_runtime_lifecycle_intent_tenant_credential_guard
BEFORE INSERT ON node_runtime_lifecycle_intents
WHEN NEW.provider_account_scope = 'organization'
  AND NOT EXISTS (
    SELECT 1
    FROM provider_accounts account
    JOIN secret_envelopes envelope
      ON envelope.organization_id = NEW.organization_id
     AND envelope.id = account.credential_reference
    WHERE account.id = NEW.provider_account_id
      AND account.scope = 'organization'
      AND account.organization_id = NEW.organization_id
      AND account.credential_reference = NEW.provider_credential_reference
      AND envelope.scope_type = 'provider-account'
      AND envelope.scope_id = account.id
      AND envelope.revision = NEW.provider_credential_revision
  )
BEGIN SELECT RAISE(ABORT, 'node runtime lifecycle tenant credential fence failed'); END;

-- Platform account credentials use the platform envelope namespace, but retain
-- the same exact account/reference/revision fence.
CREATE TRIGGER node_runtime_lifecycle_intent_platform_credential_guard
BEFORE INSERT ON node_runtime_lifecycle_intents
WHEN NEW.provider_account_scope = 'platform'
  AND NOT EXISTS (
    SELECT 1
    FROM provider_accounts account
    JOIN platform_secret_envelopes envelope
      ON envelope.id = account.credential_reference
    WHERE account.id = NEW.provider_account_id
      AND account.scope = 'platform'
      AND account.credential_reference = NEW.provider_credential_reference
      AND envelope.scope_type = 'provider-account'
      AND envelope.scope_id = account.id
      AND envelope.revision = NEW.provider_credential_revision
  )
BEGIN SELECT RAISE(ABORT, 'node runtime lifecycle platform credential fence failed'); END;

-- An account or envelope cannot rotate while a worker owns an exact provider action lease. If it
-- changes before a pending run is claimed, the later claim fails closed instead of using new data.
CREATE TRIGGER provider_account_node_runtime_execution_guard
BEFORE UPDATE OF revision, status, credential_reference ON provider_accounts
WHEN EXISTS (
  SELECT 1 FROM node_runtime_lifecycle_executions execution
  WHERE execution.provider_account_id = OLD.id AND execution.state IN ('leased', 'action-requested')
)
BEGIN SELECT RAISE(ABORT, 'provider account has active node runtime execution'); END;

CREATE TRIGGER provider_allocation_node_runtime_execution_guard
BEFORE UPDATE ON provider_allocations
WHEN EXISTS (
  SELECT 1 FROM node_runtime_lifecycle_executions execution
  WHERE execution.organization_id = OLD.organization_id
    AND execution.provider_account_id = OLD.provider_account_id
    AND execution.state IN ('leased', 'action-requested')
)
BEGIN SELECT RAISE(ABORT, 'provider allocation has active node runtime execution'); END;

CREATE TRIGGER provider_runtime_envelope_execution_guard
BEFORE UPDATE ON secret_envelopes
WHEN EXISTS (
  SELECT 1
  FROM node_runtime_lifecycle_executions execution
  JOIN provider_accounts account ON account.id = execution.provider_account_id
  WHERE execution.state IN ('leased', 'action-requested')
    AND account.scope = 'organization' AND execution.organization_id = OLD.organization_id
    AND OLD.id = execution.provider_credential_reference
    AND OLD.scope_type = 'provider-account' AND OLD.scope_id = account.id
    AND OLD.revision = execution.provider_credential_revision
)
BEGIN SELECT RAISE(ABORT, 'provider envelope has active node runtime execution'); END;

CREATE TRIGGER platform_provider_runtime_envelope_execution_guard
BEFORE UPDATE ON platform_secret_envelopes
WHEN EXISTS (
  SELECT 1
  FROM node_runtime_lifecycle_executions execution
  JOIN provider_accounts account ON account.id = execution.provider_account_id
  WHERE execution.state IN ('leased', 'action-requested')
    AND account.scope = 'platform' AND OLD.id = execution.provider_credential_reference
    AND OLD.scope_type = 'provider-account' AND OLD.scope_id = account.id
    AND OLD.revision = execution.provider_credential_revision
)
BEGIN SELECT RAISE(ABORT, 'platform provider envelope has active node runtime execution'); END;

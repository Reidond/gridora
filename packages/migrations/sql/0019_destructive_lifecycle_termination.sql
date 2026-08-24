PRAGMA foreign_keys = ON;

-- Destructive intent is distinct from the generic operation ledger. It records a SHA-256 request
-- binding, tenant/actor/revision fence, and the exact Workflow start identity. Canonical request
-- JSON is intentionally never persisted here.
CREATE TABLE destructive_lifecycle_operations (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'drain-node', 'leave-drain', 'rebuild-node', 'retire-node', 'delete-organization'
  )),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('node', 'organization')),
  resource_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  cancellation_policy TEXT NOT NULL CHECK (cancellation_policy IN (
    'before-destructive-step', 'between-steps', 'not-cancellable'
  )),
  organization_deletion_operation_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'waiting-external', 'blocked', 'cancelling', 'cancelled',
    'succeeded', 'failed-terminal'
  )),
  revision INTEGER NOT NULL CHECK (revision > 0),
  accepted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, organization_deletion_operation_id)
    REFERENCES organization_deletion_runs(organization_id, operation_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (resource_type = 'node' AND action <> 'delete-organization')
    OR (resource_type = 'organization' AND action = 'delete-organization'
      AND resource_id = organization_id)
  ),
  CHECK (
    organization_deletion_operation_id IS NULL
    OR action IN ('drain-node', 'retire-node')
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX destructive_lifecycle_operation_resource
  ON destructive_lifecycle_operations(organization_id, resource_type, resource_id, state);

-- One fact row is the explicit cancellation registry. It is usable by destructive operations and
-- by independently accepted node provision, game, backup/restore, and future operation types.
-- No fact means cancellation fails closed; there is no type-name or resource-name fallback.
CREATE TABLE operation_cancellation_facts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 128),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  resource_operation_do_name TEXT NOT NULL CHECK (length(resource_operation_do_name) BETWEEN 1 AND 512),
  workflow_binding TEXT NOT NULL CHECK (length(workflow_binding) BETWEEN 1 AND 128),
  workflow_type TEXT NOT NULL CHECK (length(workflow_type) BETWEEN 1 AND 128),
  workflow_instance_id TEXT NOT NULL CHECK (workflow_instance_id = operation_id),
  cancellation_policy TEXT NOT NULL CHECK (cancellation_policy IN (
    'before-destructive-step', 'between-steps', 'not-cancellable'
  )),
  phase TEXT NOT NULL CHECK (phase IN (
    'before-destructive-step', 'between-steps', 'step-running', 'destructive-step-running', 'terminal'
  )),
  active_step_ordinal INTEGER,
  active_step_name TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (active_step_ordinal IS NULL AND active_step_name IS NULL)
    OR (active_step_ordinal IS NOT NULL AND active_step_name IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX operation_cancellation_facts_resource
  ON operation_cancellation_facts(organization_id, resource_type, resource_id, phase);

CREATE TRIGGER operation_cancellation_facts_scope_guard
BEFORE INSERT ON operation_cancellation_facts
WHEN NOT EXISTS (
  SELECT 1 FROM operations operation
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.resource_type = NEW.resource_type
    AND operation.resource_id = NEW.resource_id
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation facts scope fence failed'); END;

CREATE TRIGGER operation_cancellation_facts_transition_guard
BEFORE UPDATE ON operation_cancellation_facts
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.resource_operation_do_name IS NOT OLD.resource_operation_do_name
  OR NEW.workflow_binding IS NOT OLD.workflow_binding
  OR NEW.workflow_type IS NOT OLD.workflow_type
  OR NEW.workflow_instance_id IS NOT OLD.workflow_instance_id
  OR NEW.cancellation_policy IS NOT OLD.cancellation_policy
  OR NEW.revision <> OLD.revision + 1
  OR (OLD.phase = 'terminal' AND NEW.phase <> 'terminal')
  OR (OLD.phase = 'destructive-step-running' AND NEW.phase = 'before-destructive-step')
  OR (OLD.phase = 'destructive-step-running' AND NEW.phase = 'between-steps')
  OR (OLD.phase = 'step-running' AND NEW.phase = 'before-destructive-step'
    AND OLD.cancellation_policy = 'between-steps')
  OR (OLD.phase = 'between-steps' AND NEW.phase = 'before-destructive-step')
BEGIN SELECT RAISE(ABORT, 'operation cancellation facts transition fence failed'); END;

CREATE TABLE operation_cancellation_step_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  step_name TEXT NOT NULL CHECK (length(step_name) BETWEEN 1 AND 160),
  destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'cancelled')),
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 16 AND 256),
  claim_attempt INTEGER NOT NULL CHECK (claim_attempt > 0),
  facts_revision INTEGER NOT NULL CHECK (facts_revision > 0),
  lease_expires_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (organization_id, operation_id, ordinal),
  UNIQUE (organization_id, operation_id, step_name),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operation_cancellation_facts(organization_id, operation_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'running' AND completed_at IS NULL AND lease_expires_at IS NOT NULL)
    OR (state IN ('completed', 'cancelled') AND completed_at IS NOT NULL AND lease_expires_at IS NULL)
  )
) WITHOUT ROWID, STRICT;

-- A provider/agent side effect is considered applied only after an exact, non-secret outcome
-- receipt is durable. The claim identity must also be present in provider ownership metadata so
-- an expired lease can be observed rather than replayed.
CREATE TABLE operation_cancellation_step_effect_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 16 AND 256),
  claim_attempt INTEGER NOT NULL CHECK (claim_attempt > 0),
  effect_id TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 512),
  outcome_fingerprint TEXT NOT NULL CHECK (
    length(outcome_fingerprint) = 64 AND outcome_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, ordinal),
  FOREIGN KEY (organization_id, operation_id, ordinal)
    REFERENCES operation_cancellation_step_receipts(organization_id, operation_id, ordinal)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER operation_cancellation_step_effect_receipt_guard
BEFORE INSERT ON operation_cancellation_step_effect_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM operation_cancellation_step_receipts step
  WHERE step.organization_id = NEW.organization_id
    AND step.operation_id = NEW.operation_id
    AND step.ordinal = NEW.ordinal
    AND step.state = 'running'
    AND step.claim_id = NEW.claim_id
    AND step.claim_attempt = NEW.claim_attempt
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation step effect receipt fence failed'); END;

-- This final receipt is deliberately part of the completion transaction. It turns both
-- zero-change update cases (facts revision/cancellation race or step-claim race) into an abort:
-- neither the facts transition nor the completed step may commit on its own.
CREATE TABLE operation_cancellation_step_completion_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 16 AND 256),
  claim_attempt INTEGER NOT NULL CHECK (claim_attempt > 0),
  facts_revision INTEGER NOT NULL CHECK (facts_revision > 0),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, ordinal),
  FOREIGN KEY (organization_id, operation_id, ordinal)
    REFERENCES operation_cancellation_step_receipts(organization_id, operation_id, ordinal)
    ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER operation_cancellation_step_completion_receipt_guard
BEFORE INSERT ON operation_cancellation_step_completion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM operation_cancellation_step_receipts step
  JOIN operation_cancellation_facts facts
    ON facts.organization_id = step.organization_id AND facts.operation_id = step.operation_id
  JOIN operation_cancellation_step_effect_receipts effect
    ON effect.organization_id = step.organization_id
      AND effect.operation_id = step.operation_id
      AND effect.ordinal = step.ordinal
      AND effect.claim_id = step.claim_id
      AND effect.claim_attempt = step.claim_attempt
  WHERE step.organization_id = NEW.organization_id
    AND step.operation_id = NEW.operation_id
    AND step.ordinal = NEW.ordinal
    AND step.state = 'completed'
    AND step.claim_id = NEW.claim_id
    AND step.claim_attempt = NEW.claim_attempt
    AND facts.revision = NEW.facts_revision
    AND facts.revision = step.facts_revision + 1
    AND facts.active_step_name IS NULL
    AND facts.active_step_ordinal IS NULL
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation step completion receipt fence failed'); END;

-- The signed step executor must claim this row before it can perform a side effect.  The trigger
-- makes a cancellation request and a competing step claim mutually exclusive at the database
-- boundary; a stale worker gets an abort rather than an optimistic execute disposition.
CREATE TRIGGER operation_cancellation_step_claim_guard
BEFORE INSERT ON operation_cancellation_step_receipts
WHEN NEW.state = 'running' AND NOT EXISTS (
  SELECT 1
  FROM operation_cancellation_facts facts
  JOIN operations operation
    ON operation.organization_id = facts.organization_id AND operation.id = facts.operation_id
  WHERE facts.organization_id = NEW.organization_id AND facts.operation_id = NEW.operation_id
    AND operation.status = 'running'
    AND NOT EXISTS (
      SELECT 1 FROM operation_cancellation_requests request
      WHERE request.organization_id = facts.organization_id AND request.operation_id = facts.operation_id
    )
    AND facts.phase = CASE WHEN NEW.destructive = 1
      THEN 'destructive-step-running' ELSE 'step-running' END
    AND facts.active_step_name = NEW.step_name
    AND facts.active_step_ordinal = NEW.ordinal
    AND facts.revision = NEW.facts_revision
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation step claim fence failed'); END;

-- Completion can only consume the exact lease that has durable side-effect evidence. This keeps
-- a crash between provider success and response handling recoverable through observation rather
-- than a second paid mutation.
CREATE TRIGGER operation_cancellation_step_completion_guard
BEFORE UPDATE OF state ON operation_cancellation_step_receipts
WHEN NEW.state = 'completed' AND (
  OLD.state <> 'running'
  OR NEW.claim_id <> OLD.claim_id
  OR NEW.claim_attempt <> OLD.claim_attempt
  OR NEW.facts_revision <> OLD.facts_revision
  OR NOT EXISTS (
    SELECT 1 FROM operation_cancellation_step_effect_receipts effect
    WHERE effect.organization_id = OLD.organization_id
      AND effect.operation_id = OLD.operation_id
      AND effect.ordinal = OLD.ordinal
      AND effect.claim_id = OLD.claim_id
      AND effect.claim_attempt = OLD.claim_attempt
  )
  OR NOT EXISTS (
    SELECT 1 FROM operation_cancellation_facts facts
    WHERE facts.organization_id = OLD.organization_id
      AND facts.operation_id = OLD.operation_id
      AND facts.revision = OLD.facts_revision + 1
      AND facts.active_step_name IS NULL
      AND facts.active_step_ordinal IS NULL
  )
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation step completion evidence fence failed'); END;

-- This start record is the durable source of truth for the exact destructive Workflow binding.
-- It is intentionally separate from lifecycle_workflow_starts because its params digest and
-- binding identity are required before a destructive side effect can be scheduled.
CREATE TABLE termination_workflow_starts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  start_record_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN (
    'DrainNodeWorkflow', 'LeaveDrainNodeWorkflow', 'RebuildNodeWorkflow',
    'RetireNodeWorkflow', 'DeleteOrganizationWorkflow'
  )),
  workflow_instance_id TEXT NOT NULL CHECK (workflow_instance_id = operation_id),
  params_fingerprint TEXT NOT NULL CHECK (
    length(params_fingerprint) = 64 AND params_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'adopted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (start_record_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES destructive_lifecycle_operations(organization_id, operation_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX termination_workflow_starts_pending
  ON termination_workflow_starts(state, updated_at, organization_id, operation_id);

CREATE TRIGGER termination_workflow_start_guard
BEFORE INSERT ON termination_workflow_starts
WHEN NOT EXISTS (
  SELECT 1 FROM destructive_lifecycle_operations operation
  WHERE operation.organization_id = NEW.organization_id
    AND operation.operation_id = NEW.operation_id
    AND operation.request_fingerprint = NEW.params_fingerprint
)
BEGIN SELECT RAISE(ABORT, 'termination workflow start binding fence failed'); END;

CREATE TABLE node_lifecycle_runs (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'drain-node', 'leave-drain', 'rebuild-node', 'retire-node'
  )),
  previous_desired_state TEXT NOT NULL CHECK (previous_desired_state IN (
    'provisioning', 'ready', 'draining', 'stopped', 'deleted'
  )),
  previous_desired_revision INTEGER NOT NULL CHECK (previous_desired_revision > 0),
  desired_revision INTEGER NOT NULL CHECK (desired_revision = previous_desired_revision + 1),
  force_requested INTEGER NOT NULL CHECK (force_requested IN (0, 1)),
  backup_policy TEXT NOT NULL CHECK (backup_policy IN ('required', 'skip-authorized')),
  target_image_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'accepted', 'draining', 'drained', 'drained-forced', 'rebuilding', 'awaiting-agent',
    'retiring', 'awaiting-provider-confirmation', 'cancel-scheduled', 'blocked',
    'cancelled', 'completed'
  )),
  provider_retirement_state TEXT NOT NULL DEFAULT 'not-started' CHECK (provider_retirement_state IN (
    'not-started', 'delete-requested', 'deleted-confirmed', 'secure-wipe-completed',
    'cancel-scheduled', 'contract-ended', 'ambiguous'
  )),
  billing_state TEXT NOT NULL DEFAULT 'not-applicable' CHECK (billing_state IN (
    'not-applicable', 'unknown', 'stopped', 'continues-until-cancellation'
  )),
  cancellation_date TEXT,
  billing_stops_at TEXT,
  provider_request_reference TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, node_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES destructive_lifecycle_operations(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (target_image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  CHECK (
    (action = 'rebuild-node' AND target_image_id IS NOT NULL)
    OR (action <> 'rebuild-node' AND target_image_id IS NULL)
  ),
  CHECK (
    (provider_retirement_state = 'cancel-scheduled'
      AND billing_state = 'continues-until-cancellation'
      AND cancellation_date IS NOT NULL AND billing_stops_at IS NOT NULL)
    OR (provider_retirement_state IN ('deleted-confirmed', 'contract-ended')
      AND billing_state = 'stopped')
    OR (provider_retirement_state NOT IN ('cancel-scheduled', 'deleted-confirmed', 'contract-ended'))
  )
) WITHOUT ROWID, STRICT;

-- Blocked and ambiguous paid-provider runs remain exclusive. A finished drain may release its
-- node, but a rebuild/retire remains active until explicit cancellation or confirmed completion.
CREATE UNIQUE INDEX node_lifecycle_one_active_run
  ON node_lifecycle_runs(organization_id, node_id)
  WHERE state NOT IN ('cancelled', 'completed')
    AND NOT (
      action IN ('drain-node', 'leave-drain')
      AND state IN ('drained', 'drained-forced')
    );

CREATE TRIGGER node_lifecycle_run_acceptance_guard
BEFORE INSERT ON node_lifecycle_runs
WHEN NOT EXISTS (
  SELECT 1 FROM destructive_lifecycle_operations operation
  JOIN nodes node ON node.organization_id = operation.organization_id AND node.id = NEW.node_id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.operation_id = NEW.operation_id
    AND operation.action = NEW.action
    AND operation.resource_type = 'node'
    AND operation.resource_id = NEW.node_id
    AND operation.state = 'queued'
    AND node.desired_revision = NEW.desired_revision
    AND node.pending_lifecycle_operation_id = NEW.operation_id
    AND node.desired_state = CASE NEW.action WHEN 'leave-drain' THEN 'ready' ELSE 'draining' END
    AND NEW.state = CASE NEW.action WHEN 'leave-drain' THEN 'accepted' ELSE 'draining' END
)
OR (NEW.action = 'rebuild-node' AND NOT EXISTS (
  SELECT 1 FROM node_images image
  WHERE image.id = NEW.target_image_id AND image.status = 'promoted'
))
BEGIN SELECT RAISE(ABORT, 'node lifecycle acceptance fence failed'); END;

CREATE TABLE node_lifecycle_affected_servers (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'moved', 'deleted')),
  resolved_at TEXT,
  PRIMARY KEY (organization_id, operation_id, server_id),
  UNIQUE (organization_id, operation_id, deployment_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_lifecycle_runs(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'pending' AND resolved_at IS NULL) OR (state IN ('moved', 'deleted') AND resolved_at IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_lifecycle_affected_server_scope_guard
BEFORE INSERT ON node_lifecycle_affected_servers
WHEN NOT EXISTS (
  SELECT 1 FROM node_lifecycle_runs run
  JOIN deployments deployment
    ON deployment.organization_id = run.organization_id AND deployment.id = NEW.deployment_id
  WHERE run.organization_id = NEW.organization_id
    AND run.operation_id = NEW.operation_id
    AND run.node_id = deployment.node_id
    AND deployment.server_id = NEW.server_id
    AND deployment.desired_revision = NEW.desired_revision
    AND deployment.observed_state <> 'deleted'
)
BEGIN SELECT RAISE(ABORT, 'node lifecycle affected server scope fence failed'); END;

CREATE TRIGGER node_lifecycle_affected_server_resolution_guard
BEFORE UPDATE OF state ON node_lifecycle_affected_servers
WHEN (NEW.state = 'moved' AND NOT EXISTS (
  SELECT 1 FROM node_lifecycle_runs run
  JOIN deployments deployment
    ON deployment.organization_id = run.organization_id AND deployment.id = NEW.deployment_id
  WHERE run.organization_id = NEW.organization_id
    AND run.operation_id = NEW.operation_id
    AND deployment.server_id = NEW.server_id
    AND deployment.node_id <> run.node_id
    AND deployment.observed_state <> 'deleted'
)) OR (NEW.state = 'deleted' AND NOT EXISTS (
  SELECT 1 FROM deployments deployment
  WHERE deployment.organization_id = NEW.organization_id
    AND deployment.id = NEW.deployment_id
    AND deployment.server_id = NEW.server_id
    AND deployment.observed_state = 'deleted'
))
BEGIN SELECT RAISE(ABORT, 'node lifecycle affected server resolution fence failed'); END;

-- This is the hard provider-side-effect fence. Acceptance may inventory active deployments and
-- start draining; it never waits for the impossible condition of an already-empty node.
CREATE TRIGGER node_lifecycle_provider_destructive_guard
BEFORE UPDATE OF state ON node_lifecycle_runs
WHEN NEW.state IN ('rebuilding', 'retiring')
  AND OLD.state NOT IN ('rebuilding', 'retiring')
  AND (
    EXISTS (
      SELECT 1 FROM deployments deployment
      WHERE deployment.organization_id = NEW.organization_id
        AND deployment.node_id = NEW.node_id
        AND deployment.observed_state <> 'deleted'
    )
    OR EXISTS (
      SELECT 1 FROM node_lifecycle_affected_servers affected
      WHERE affected.organization_id = NEW.organization_id
        AND affected.operation_id = NEW.operation_id
        AND affected.state = 'pending'
    )
    OR (NEW.backup_policy = 'required' AND EXISTS (
      SELECT 1 FROM node_lifecycle_affected_servers affected
      WHERE affected.organization_id = NEW.organization_id
        AND affected.operation_id = NEW.operation_id
        AND NOT EXISTS (
          SELECT 1 FROM backups backup
          WHERE backup.organization_id = affected.organization_id
            AND backup.server_id = affected.server_id
            AND backup.state = 'available'
            AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
            AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER)
              >= affected.desired_revision
        )
    ))
  )
BEGIN SELECT RAISE(ABORT, 'node provider destructive action requires drain and backup evidence'); END;

CREATE TRIGGER node_lifecycle_finalization_guard
BEFORE UPDATE OF state ON node_lifecycle_runs
WHEN NEW.state = 'completed' AND OLD.action = 'retire-node' AND (
  NEW.provider_retirement_state NOT IN ('deleted-confirmed', 'contract-ended')
  OR NEW.billing_state <> 'stopped'
  OR EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.node_id = NEW.node_id
      AND deployment.observed_state <> 'deleted'
  )
  OR EXISTS (
    SELECT 1 FROM node_credentials credential
    WHERE credential.organization_id = NEW.organization_id
      AND credential.node_id = NEW.node_id
      AND credential.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM agent_sessions session
    WHERE session.organization_id = NEW.organization_id
      AND session.node_id = NEW.node_id
      AND session.session_state <> 'revoked'
  )
  OR EXISTS (
    SELECT 1 FROM tunnels tunnel
    WHERE tunnel.organization_id = NEW.organization_id
      AND tunnel.node_id = NEW.node_id
      AND tunnel.state <> 'deleted'
  )
)
BEGIN SELECT RAISE(ABORT, 'node retirement finalization fence failed'); END;

CREATE TABLE organization_deletion_runs (
  organization_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  requested_slug TEXT NOT NULL,
  previous_revision INTEGER NOT NULL CHECK (previous_revision > 0),
  deleting_revision INTEGER NOT NULL CHECK (deleting_revision = previous_revision + 1),
  backup_policy TEXT NOT NULL CHECK (backup_policy IN ('retain', 'delete-after-retention')),
  state TEXT NOT NULL CHECK (state IN (
    'accepted', 'inventorying', 'draining', 'retiring', 'revoking', 'cleaning-networking',
    'blocked', 'ready-to-tombstone', 'tombstoned', 'cancelled'
  )),
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES destructive_lifecycle_operations(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER organization_deletion_run_acceptance_guard
BEFORE INSERT ON organization_deletion_runs
WHEN NOT EXISTS (
  SELECT 1 FROM destructive_lifecycle_operations operation
  JOIN organizations organization ON organization.id = operation.organization_id
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = NEW.actor_id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.operation_id = NEW.operation_id
    AND operation.action = 'delete-organization'
    AND operation.resource_type = 'organization'
    AND operation.resource_id = NEW.organization_id
    AND operation.actor_id = NEW.actor_id
    AND operation.state = 'queued'
    AND organization.status = 'deleting'
    AND organization.slug = NEW.requested_slug
    AND organization.revision = NEW.deleting_revision
    AND membership.status = 'active' AND membership.role = 'owner'
)
BEGIN SELECT RAISE(ABORT, 'organization deletion acceptance fence failed'); END;

CREATE TABLE organization_deletion_items (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'node', 'game-server', 'deployment', 'backup', 'tunnel', 'dns-record', 'node-credential',
    'node-registration-token', 'agent-session',
    'automation-identity', 'provider-account', 'server-capacity-reservation', 'port-lease'
  )),
  resource_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'retained', 'ambiguous', 'blocked')),
  paid INTEGER NOT NULL CHECK (paid IN (0, 1)),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  resolution_evidence_json TEXT CHECK (resolution_evidence_json IS NULL OR json_valid(resolution_evidence_json)),
  discovered_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (organization_id, operation_id, kind, resource_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES organization_deletion_runs(organization_id, operation_id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('resolved', 'retained') AND resolved_at IS NOT NULL AND resolution_evidence_json IS NOT NULL)
    OR (state IN ('pending', 'ambiguous', 'blocked') AND resolved_at IS NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX organization_deletion_items_unresolved
  ON organization_deletion_items(organization_id, operation_id, state, paid);

CREATE TRIGGER organization_deletion_item_retention_insert_guard
BEFORE INSERT ON organization_deletion_items
WHEN NEW.state = 'retained' AND NOT (
  NEW.kind = 'backup'
  AND NEW.resolved_at IS NOT NULL
  AND NEW.resolution_evidence_json IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM organization_deletion_runs run
    WHERE run.organization_id = NEW.organization_id
      AND run.operation_id = NEW.operation_id
      AND run.backup_policy = 'retain'
  )
)
BEGIN SELECT RAISE(ABORT, 'organization deletion retained item fence failed'); END;

CREATE TRIGGER organization_deletion_item_resolution_guard
BEFORE UPDATE OF state ON organization_deletion_items
WHEN (NEW.state = 'retained' AND NOT (
  NEW.kind = 'backup' AND EXISTS (
    SELECT 1 FROM organization_deletion_runs run
    WHERE run.organization_id = NEW.organization_id
      AND run.operation_id = NEW.operation_id
      AND run.backup_policy = 'retain'
  )
)) OR (NEW.state = 'resolved' AND (
  (NEW.kind = 'node' AND NOT EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id AND node.id = NEW.resource_id
      AND node.desired_state = 'deleted'
  ))
  OR (NEW.kind = 'game-server' AND NOT EXISTS (
    SELECT 1 FROM game_servers server
    WHERE server.organization_id = NEW.organization_id AND server.id = NEW.resource_id
      AND server.observed_state = 'deleted'
  ))
  OR (NEW.kind = 'deployment' AND NOT EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = NEW.organization_id AND deployment.id = NEW.resource_id
      AND deployment.observed_state = 'deleted'
  ))
  OR (NEW.kind = 'backup' AND NOT EXISTS (
    SELECT 1 FROM backups backup
    WHERE backup.organization_id = NEW.organization_id AND backup.id = NEW.resource_id
      AND backup.state IN ('deleted', 'expired')
  ))
  OR (NEW.kind = 'tunnel' AND NOT EXISTS (
    SELECT 1 FROM tunnels tunnel
    WHERE tunnel.organization_id = NEW.organization_id AND tunnel.node_id = NEW.resource_id
      AND tunnel.state = 'deleted'
  ))
  OR (NEW.kind = 'dns-record' AND NOT EXISTS (
    SELECT 1 FROM dns_records record
    WHERE record.organization_id = NEW.organization_id AND record.id = NEW.resource_id
      AND record.state = 'deleted'
  ))
  OR (NEW.kind = 'node-credential' AND NOT EXISTS (
    SELECT 1 FROM node_credentials credential
    WHERE credential.organization_id = NEW.organization_id AND credential.id = NEW.resource_id
      AND credential.status = 'revoked'
  ))
  OR (NEW.kind = 'node-registration-token' AND NOT EXISTS (
    SELECT 1 FROM node_registration_tokens token
    WHERE token.organization_id = NEW.organization_id AND token.token_hash = NEW.resource_id
      AND token.revoked_at IS NOT NULL
  ))
  OR (NEW.kind = 'agent-session' AND NOT EXISTS (
    SELECT 1 FROM agent_sessions session
    WHERE session.organization_id = NEW.organization_id AND session.node_id = NEW.resource_id
      AND session.session_state = 'revoked'
  ))
  OR (NEW.kind = 'automation-identity' AND NOT EXISTS (
    SELECT 1 FROM automation_identities identity
    WHERE identity.organization_id = NEW.organization_id AND identity.id = NEW.resource_id
      AND identity.status = 'revoked'
  ))
  OR (NEW.kind = 'provider-account' AND NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    WHERE account.organization_id = NEW.organization_id AND account.id = NEW.resource_id
      AND account.scope = 'organization' AND account.status IN ('disabled', 'error')
  ))
  OR (NEW.kind = 'server-capacity-reservation' AND NOT EXISTS (
    SELECT 1 FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id AND reservation.id = NEW.resource_id
      AND reservation.state = 'released'
  ))
  OR (NEW.kind = 'port-lease' AND NOT EXISTS (
    SELECT 1 FROM port_leases lease
    WHERE lease.organization_id = NEW.organization_id AND lease.id = NEW.resource_id
      AND lease.state = 'released'
  ))
))
BEGIN SELECT RAISE(ABORT, 'organization deletion item evidence fence failed'); END;

CREATE TABLE organization_tombstones (
  organization_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  inventory_digest TEXT NOT NULL CHECK (
    length(inventory_digest) = 64 AND inventory_digest NOT GLOB '*[^0-9a-f]*'
  ),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES organization_deletion_runs(organization_id, operation_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

-- Cancellation request revision is fenced against the generic operation row. The two delivery
-- bits are kept independently so a response loss or one successful-false signal never suppresses
-- a retry of the exact DO/Workflow target.
CREATE TABLE operation_cancellation_requests (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  actor_id TEXT NOT NULL,
  expected_operation_revision INTEGER NOT NULL CHECK (expected_operation_revision > 0),
  requested_revision INTEGER NOT NULL CHECK (requested_revision = expected_operation_revision + 1),
  policy TEXT NOT NULL CHECK (policy IN (
    'before-destructive-step', 'between-steps', 'not-cancellable'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'requested', 'delivery-pending', 'signalled', 'cancelled', 'rejected'
  )),
  resource_operation_signalled INTEGER NOT NULL DEFAULT 0 CHECK (resource_operation_signalled IN (0, 1)),
  workflow_signalled INTEGER NOT NULL DEFAULT 0 CHECK (workflow_signalled IN (0, 1)),
  requested_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operation_cancellation_facts(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  CHECK (
    (state = 'signalled' AND resource_operation_signalled = 1 AND workflow_signalled = 1 AND delivered_at IS NOT NULL)
    OR (state <> 'signalled' AND delivered_at IS NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TRIGGER operation_cancellation_request_guard
BEFORE INSERT ON operation_cancellation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM operation_cancellation_facts facts
  JOIN operations operation
    ON operation.organization_id = facts.organization_id AND operation.id = facts.operation_id
  JOIN organization_memberships membership
    ON membership.organization_id = facts.organization_id AND membership.identity_id = NEW.actor_id
  WHERE facts.organization_id = NEW.organization_id
    AND facts.operation_id = NEW.operation_id
    AND facts.cancellation_policy = NEW.policy
    AND facts.workflow_binding <> 'unbound'
    AND facts.workflow_instance_id = NEW.operation_id
    AND (
      (facts.cancellation_policy = 'before-destructive-step' AND facts.phase = 'before-destructive-step')
      OR (facts.cancellation_policy = 'between-steps' AND facts.phase = 'between-steps')
    )
    AND operation.status = 'cancelling'
    AND operation.revision = NEW.requested_revision
    AND membership.status = 'active' AND membership.role IN ('owner', 'administrator')
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation request fence failed'); END;

CREATE TABLE operation_cancellation_compensation_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('node-spend', 'node-bootstrap', 'server-capacity', 'port-lease')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, kind),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operation_cancellation_requests(organization_id, operation_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER operation_cancellation_compensation_guard
BEFORE INSERT ON operation_cancellation_compensation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM operation_cancellation_requests request
  JOIN operations operation
    ON operation.organization_id = request.organization_id AND operation.id = request.operation_id
  WHERE request.organization_id = NEW.organization_id
    AND request.operation_id = NEW.operation_id
    AND request.state = 'cancelled'
    AND operation.status = 'cancelled'
)
BEGIN SELECT RAISE(ABORT, 'operation cancellation compensation fence failed'); END;

CREATE TRIGGER organization_deletion_ready_guard
BEFORE UPDATE OF state ON organization_deletion_runs
WHEN NEW.state = 'ready-to-tombstone' AND (
  EXISTS (
    SELECT 1 FROM organization_deletion_items item
    WHERE item.organization_id = NEW.organization_id
      AND item.operation_id = NEW.operation_id
      AND item.state IN ('pending', 'ambiguous', 'blocked')
  )
  OR EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id AND node.provider_instance_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM node_lifecycle_runs run
        WHERE run.organization_id = node.organization_id AND run.node_id = node.id
          AND run.action = 'retire-node'
          AND run.state = 'completed'
          AND run.provider_retirement_state IN ('deleted-confirmed', 'contract-ended')
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'organization deletion is not ready to tombstone'); END;

-- Every state-changing batch ends by inserting one receipt with matching audit and outbox data.
-- For acceptance rows, the start record id proves exact Workflow intent independently of the outbox.
CREATE TABLE destructive_lifecycle_atomic_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  workflow_start_record_id TEXT,
  audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id, receipt_key),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER destructive_lifecycle_atomic_receipt_guard
BEFORE INSERT ON destructive_lifecycle_atomic_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events audit
  WHERE audit.id = NEW.audit_event_id AND audit.organization_id = NEW.organization_id
)
OR NOT EXISTS (
  SELECT 1 FROM outbox event
  WHERE event.id = NEW.outbox_event_id AND event.organization_id = NEW.organization_id
)
BEGIN SELECT RAISE(ABORT, 'destructive lifecycle atomic receipt evidence missing'); END;

CREATE TRIGGER destructive_lifecycle_atomic_receipt_state_guard
BEFORE INSERT ON destructive_lifecycle_atomic_receipts
WHEN (
  NEW.receipt_key = 'node-accepted' AND NOT EXISTS (
    SELECT 1 FROM destructive_lifecycle_operations operation
    JOIN node_lifecycle_runs run
      ON run.organization_id = operation.organization_id AND run.operation_id = operation.operation_id
    JOIN termination_workflow_starts start
      ON start.organization_id = operation.organization_id AND start.operation_id = operation.operation_id
    JOIN operation_cancellation_facts facts
      ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.operation_id
    WHERE operation.organization_id = NEW.organization_id AND operation.operation_id = NEW.operation_id
      AND operation.state = 'queued' AND run.state IN ('draining', 'accepted')
      AND NEW.workflow_start_record_id = start.start_record_id
      AND start.workflow_instance_id = operation.operation_id
      AND start.params_fingerprint = operation.request_fingerprint
      AND facts.workflow_instance_id = operation.operation_id
  )
) OR (
  NEW.receipt_key = 'organization-accepted' AND NOT EXISTS (
    SELECT 1 FROM destructive_lifecycle_operations operation
    JOIN organization_deletion_runs run
      ON run.organization_id = operation.organization_id AND run.operation_id = operation.operation_id
    JOIN termination_workflow_starts start
      ON start.organization_id = operation.organization_id AND start.operation_id = operation.operation_id
    JOIN operation_cancellation_facts facts
      ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.operation_id
    WHERE operation.organization_id = NEW.organization_id AND operation.operation_id = NEW.operation_id
      AND operation.state = 'queued' AND run.state = 'accepted'
      AND NEW.workflow_start_record_id = start.start_record_id
      AND start.workflow_instance_id = operation.operation_id
      AND start.params_fingerprint = operation.request_fingerprint
      AND facts.workflow_instance_id = operation.operation_id
  )
) OR (
  NEW.receipt_key = 'cancellation-requested' AND NOT EXISTS (
    SELECT 1 FROM operation_cancellation_requests request
    JOIN operations operation
      ON operation.organization_id = request.organization_id AND operation.id = request.operation_id
    WHERE request.organization_id = NEW.organization_id AND request.operation_id = NEW.operation_id
      AND operation.status = 'cancelling' AND request.state IN ('requested', 'delivery-pending')
  )
) OR (
  NEW.receipt_key = 'cancellation-signalled' AND NOT EXISTS (
    SELECT 1 FROM operation_cancellation_requests request
    WHERE request.organization_id = NEW.organization_id AND request.operation_id = NEW.operation_id
      AND request.state = 'signalled'
      AND request.resource_operation_signalled = 1 AND request.workflow_signalled = 1
  )
) OR (
  NEW.receipt_key = 'cancellation-delivery-pending' AND NOT EXISTS (
    SELECT 1 FROM operation_cancellation_requests request
    WHERE request.organization_id = NEW.organization_id AND request.operation_id = NEW.operation_id
      AND request.state = 'delivery-pending'
  )
) OR (
  NEW.receipt_key = 'cancellation-finalized' AND NOT EXISTS (
    SELECT 1 FROM operation_cancellation_requests request
    JOIN operations operation
      ON operation.organization_id = request.organization_id AND operation.id = request.operation_id
    WHERE request.organization_id = NEW.organization_id AND request.operation_id = NEW.operation_id
      AND operation.status = 'cancelled' AND request.state = 'cancelled'
  )
) OR (
  NEW.receipt_key = 'node-drain-completed' AND NOT EXISTS (
    SELECT 1 FROM node_lifecycle_runs run
    WHERE run.organization_id = NEW.organization_id AND run.operation_id = NEW.operation_id
      AND run.state IN ('drained', 'drained-forced', 'completed')
  )
) OR (
  NEW.receipt_key = 'node-retirement-finalized' AND NOT EXISTS (
    SELECT 1 FROM node_lifecycle_runs run
    JOIN destructive_lifecycle_operations lifecycle
      ON lifecycle.organization_id = run.organization_id AND lifecycle.operation_id = run.operation_id
    WHERE run.organization_id = NEW.organization_id AND run.operation_id = NEW.operation_id
      AND run.state = 'completed'
      AND run.provider_retirement_state IN ('deleted-confirmed', 'contract-ended')
      AND lifecycle.state = 'succeeded'
  )
) OR (
  NEW.receipt_key = 'organization-tombstoned' AND NOT EXISTS (
    SELECT 1 FROM organization_deletion_runs run
    JOIN organizations organization ON organization.id = run.organization_id
    JOIN organization_tombstones tombstone
      ON tombstone.organization_id = run.organization_id AND tombstone.operation_id = run.operation_id
    WHERE run.organization_id = NEW.organization_id AND run.operation_id = NEW.operation_id
      AND run.state = 'tombstoned' AND organization.status = 'deleted'
  )
)
BEGIN SELECT RAISE(ABORT, 'destructive lifecycle atomic receipt state fence failed'); END;

CREATE TRIGGER destructive_lifecycle_operation_scope_guard
BEFORE INSERT ON destructive_lifecycle_operations
WHEN NOT EXISTS (
  SELECT 1 FROM operations operation
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.type = NEW.action
    AND operation.resource_type = NEW.resource_type
    AND operation.resource_id = NEW.resource_id
    AND operation.actor_id = NEW.actor_id
    AND operation.idempotency_key = NEW.idempotency_key
    AND operation.status = 'queued'
)
OR NOT EXISTS (
  SELECT 1 FROM organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.identity_id = NEW.actor_id
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'administrator')
)
OR NOT EXISTS (
  SELECT 1 FROM organizations organization
  WHERE organization.id = NEW.organization_id
    AND (
      organization.status = 'active'
      OR (NEW.action = 'delete-organization'
        AND NEW.organization_deletion_operation_id IS NULL
        AND organization.status = 'deleting')
      OR (NEW.organization_deletion_operation_id IS NOT NULL
        AND organization.status = 'deleting'
        AND EXISTS (
          SELECT 1 FROM organization_deletion_runs run
          WHERE run.organization_id = NEW.organization_id
            AND run.operation_id = NEW.organization_deletion_operation_id
            AND run.actor_id = NEW.actor_id
            AND run.state NOT IN ('tombstoned', 'cancelled')
        ))
    )
)
BEGIN SELECT RAISE(ABORT, 'destructive lifecycle operation scope fence failed'); END;

CREATE TRIGGER organization_deletion_tombstone_guard
BEFORE UPDATE OF status ON organizations
WHEN OLD.status = 'deleting' AND NEW.status = 'deleted' AND (
  NOT EXISTS (
    SELECT 1 FROM organization_deletion_runs run
    WHERE run.organization_id = OLD.id AND run.state = 'ready-to-tombstone'
  )
  OR EXISTS (
    SELECT 1 FROM organization_deletion_items item
    WHERE item.organization_id = OLD.id
      AND item.state IN ('pending', 'ambiguous', 'blocked')
  )
  OR EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = OLD.id AND node.provider_instance_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM node_lifecycle_runs run
        WHERE run.organization_id = node.organization_id AND run.node_id = node.id
          AND run.action = 'retire-node'
          AND run.provider_retirement_state IN ('deleted-confirmed', 'contract-ended')
          AND run.state = 'completed'
      )
  )
  OR EXISTS (
    SELECT 1 FROM deployments deployment
    WHERE deployment.organization_id = OLD.id AND deployment.observed_state <> 'deleted'
  )
  OR EXISTS (
    SELECT 1 FROM game_servers server
    WHERE server.organization_id = OLD.id AND server.observed_state <> 'deleted'
  )
  OR EXISTS (
    SELECT 1 FROM node_credentials credential
    WHERE credential.organization_id = OLD.id AND credential.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM agent_sessions session
    WHERE session.organization_id = OLD.id AND session.session_state <> 'revoked'
  )
  OR EXISTS (
    SELECT 1 FROM node_registration_tokens token
    WHERE token.organization_id = OLD.id AND token.revoked_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM tunnels tunnel
    WHERE tunnel.organization_id = OLD.id AND tunnel.state <> 'deleted'
  )
  OR EXISTS (
    SELECT 1 FROM dns_records record
    WHERE record.organization_id = OLD.id AND record.state <> 'deleted'
  )
  OR EXISTS (
    SELECT 1 FROM automation_identities identity
    WHERE identity.organization_id = OLD.id AND identity.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM provider_accounts account
    WHERE account.organization_id = OLD.id AND account.scope = 'organization' AND account.status = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM server_capacity_reservations reservation
    WHERE reservation.organization_id = OLD.id AND reservation.state <> 'released'
  )
  OR EXISTS (
    SELECT 1 FROM port_leases lease
    WHERE lease.organization_id = OLD.id AND lease.state <> 'released'
  )
  OR EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.organization_id = OLD.id
      AND operation.status IN ('requested', 'queued', 'running', 'waiting_external', 'cancelling', 'retrying')
      AND operation.id <> (
        SELECT run.operation_id FROM organization_deletion_runs run
        WHERE run.organization_id = OLD.id
      )
  )
  OR EXISTS (
    SELECT 1 FROM organization_deletion_runs run
    WHERE run.organization_id = OLD.id AND run.backup_policy = 'delete-after-retention'
      AND EXISTS (
        SELECT 1 FROM backups backup
        WHERE backup.organization_id = OLD.id AND backup.state NOT IN ('deleted', 'expired')
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'organization deletion has unresolved resources'); END;

-- Existing independently accepted operations materialize explicit facts. The stored coordinator
-- name is a contract: root composition must use exactly this name for ResourceOperationDO locks.
CREATE TRIGGER cancellation_facts_from_node_provision
AFTER INSERT ON node_provision_acceptances
BEGIN
  INSERT OR IGNORE INTO operation_cancellation_facts (
    organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
    workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
    active_step_ordinal, active_step_name, revision, registered_at, updated_at
  ) VALUES (
    NEW.organization_id, NEW.operation_id, 'node', NEW.node_id,
    'resource-operation:' || NEW.organization_id || ':node:' || NEW.node_id,
    'PROVISION_NODE', 'ProvisionNodeWorkflow', NEW.operation_id,
    'before-destructive-step', 'before-destructive-step', NULL, NULL, 1, NEW.created_at, NEW.created_at
  );
END;

CREATE TRIGGER cancellation_facts_from_game_lifecycle
AFTER INSERT ON game_lifecycle_mutations
BEGIN
  INSERT OR IGNORE INTO operation_cancellation_facts (
    organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
    workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
    active_step_ordinal, active_step_name, revision, registered_at, updated_at
  ) VALUES (
    NEW.organization_id, NEW.operation_id, 'server', NEW.server_id,
    'resource-operation:' || NEW.organization_id || ':server:' || NEW.server_id,
    CASE NEW.action
      WHEN 'create' THEN 'DEPLOY_GAME_SERVER'
      WHEN 'delete' THEN 'DELETE_GAME_SERVER'
      WHEN 'update' THEN 'UPDATE_GAME_SERVER'
      WHEN 'apply-config' THEN 'APPLY_GAME_CONFIG'
      WHEN 'sync-mods' THEN 'SYNC_MODS'
      ELSE 'unbound'
    END,
    CASE NEW.action
      WHEN 'create' THEN 'DeployGameServerWorkflow'
      WHEN 'delete' THEN 'DeleteGameServerWorkflow'
      WHEN 'update' THEN 'UpdateGameServerWorkflow'
      WHEN 'apply-config' THEN 'ApplyGameConfigWorkflow'
      WHEN 'sync-mods' THEN 'SyncModsWorkflow'
      ELSE 'UnboundGameWorkflow'
    END,
    NEW.operation_id,
    CASE WHEN NEW.action IN ('create', 'delete') THEN 'before-destructive-step' ELSE 'between-steps' END,
    CASE WHEN NEW.action IN ('create', 'delete') THEN 'before-destructive-step' ELSE 'between-steps' END,
    NULL, NULL, 1, NEW.created_at, NEW.created_at
  );
END;

CREATE TRIGGER cancellation_facts_from_backup_job
AFTER INSERT ON backup_jobs
BEGIN
  INSERT OR IGNORE INTO operation_cancellation_facts (
    organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
    workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
    active_step_ordinal, active_step_name, revision, registered_at, updated_at
  ) VALUES (
    NEW.organization_id, NEW.operation_id, 'game-server',
    CASE NEW.mode WHEN 'create' THEN NEW.source_server_id ELSE NEW.target_server_id END,
    'resource-operation:' || NEW.organization_id || ':game-server:' ||
      CASE NEW.mode WHEN 'create' THEN NEW.source_server_id ELSE NEW.target_server_id END,
    CASE NEW.mode WHEN 'create' THEN 'BACKUP_GAME_SERVER' ELSE 'RESTORE_GAME_SERVER' END,
    CASE NEW.mode WHEN 'create' THEN 'BackupGameServerWorkflow' ELSE 'RestoreGameServerWorkflow' END,
    NEW.operation_id,
    CASE NEW.mode WHEN 'create' THEN 'before-destructive-step' ELSE 'between-steps' END,
    CASE NEW.mode WHEN 'create' THEN 'before-destructive-step' ELSE 'between-steps' END,
    NULL, NULL, 1, NEW.created_at, NEW.created_at
  );
END;

CREATE TRIGGER cancellation_facts_from_generic_lifecycle
AFTER INSERT ON lifecycle_reservations
WHEN EXISTS (
  SELECT 1 FROM operations operation
  WHERE operation.organization_id = NEW.organization_id AND operation.id = NEW.operation_id
    AND operation.type IN (
      'provision-node', 'retire-node', 'delete-node', 'deploy-server', 'update-server-mods',
      'configure-server', 'create-backup', 'restore-backup', 'move-server', 'delete-server'
    )
)
BEGIN
  INSERT OR IGNORE INTO operation_cancellation_facts (
    organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
    workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
    active_step_ordinal, active_step_name, revision, registered_at, updated_at
  ) SELECT
    operation.organization_id, operation.id, operation.resource_type, operation.resource_id,
    'resource-operation:' || operation.organization_id || ':' || operation.resource_type || ':' || operation.resource_id,
    CASE operation.type
      WHEN 'provision-node' THEN 'PROVISION_NODE'
      WHEN 'retire-node' THEN 'RETIRE_NODE'
      WHEN 'delete-node' THEN 'RETIRE_NODE'
      WHEN 'deploy-server' THEN 'DEPLOY_GAME_SERVER'
      WHEN 'update-server-mods' THEN 'SYNC_MODS'
      WHEN 'configure-server' THEN 'APPLY_GAME_CONFIG'
      WHEN 'create-backup' THEN 'BACKUP_GAME_SERVER'
      WHEN 'restore-backup' THEN 'RESTORE_GAME_SERVER'
      WHEN 'move-server' THEN 'MOVE_GAME_SERVER'
      WHEN 'delete-server' THEN 'DELETE_GAME_SERVER'
    END,
    CASE operation.type
      WHEN 'provision-node' THEN 'ProvisionNodeWorkflow'
      WHEN 'retire-node' THEN 'RetireNodeWorkflow'
      WHEN 'delete-node' THEN 'RetireNodeWorkflow'
      WHEN 'deploy-server' THEN 'DeployGameServerWorkflow'
      WHEN 'update-server-mods' THEN 'SyncModsWorkflow'
      WHEN 'configure-server' THEN 'ApplyGameConfigWorkflow'
      WHEN 'create-backup' THEN 'BackupGameServerWorkflow'
      WHEN 'restore-backup' THEN 'RestoreGameServerWorkflow'
      WHEN 'move-server' THEN 'MoveGameServerWorkflow'
      WHEN 'delete-server' THEN 'DeleteGameServerWorkflow'
    END,
    operation.id,
    CASE WHEN operation.type IN ('provision-node', 'retire-node', 'delete-node', 'delete-server', 'create-backup')
      THEN 'before-destructive-step' ELSE 'between-steps' END,
    CASE WHEN operation.type IN ('provision-node', 'retire-node', 'delete-node', 'delete-server', 'create-backup')
      THEN 'before-destructive-step' ELSE 'between-steps' END,
    NULL, NULL, 1, NEW.created_at, NEW.created_at
  FROM operations operation
  WHERE operation.organization_id = NEW.organization_id AND operation.id = NEW.operation_id;
END;

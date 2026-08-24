PRAGMA foreign_keys = ON;

-- A NULL expiry means that this node predates (or deliberately bypassed) the
-- temporary-node contract. It is non-actionable for the scheduler. Once set,
-- the accepted expiry can never be edited into a different retirement date.
ALTER TABLE nodes ADD COLUMN temporary_expires_at TEXT;
ALTER TABLE node_provision_acceptances ADD COLUMN temporary_lifetime_hours INTEGER;
ALTER TABLE node_provision_acceptances ADD COLUMN temporary_expires_at TEXT;

CREATE TRIGGER node_temporary_expiry_immutable
BEFORE UPDATE OF temporary_expires_at ON nodes
WHEN NEW.temporary_expires_at IS NOT OLD.temporary_expires_at
BEGIN
  SELECT RAISE(ABORT, 'node temporary expiry is immutable');
END;

CREATE TRIGGER node_provision_acceptance_temporary_expiry_guard
BEFORE INSERT ON node_provision_acceptances
WHEN
  (NEW.temporary_lifetime_hours IS NULL) <> (NEW.temporary_expires_at IS NULL)
  OR (NEW.temporary_lifetime_hours IS NOT NULL AND (
    NEW.temporary_lifetime_hours < 1
    OR julianday(NEW.temporary_expires_at) IS NULL
    OR CAST(strftime('%s', NEW.temporary_expires_at) AS INTEGER) <>
       CAST(strftime('%s', NEW.created_at) AS INTEGER) + NEW.temporary_lifetime_hours * 3600
  ))
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id AND node.id = NEW.node_id
      AND node.temporary_expires_at IS NEW.temporary_expires_at
  )
  OR NOT EXISTS (
    SELECT 1 FROM lifecycle_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.operation_id = NEW.operation_id
      AND reservation.idempotency_key = NEW.idempotency_key
      AND json_extract(reservation.command_json, '$.temporaryLifetimeHours')
          IS NEW.temporary_lifetime_hours
  )
BEGIN
  SELECT RAISE(ABORT, 'node provision temporary expiry fence failed');
END;

-- A separate, immutable scheduler identity prevents an ordinary automation
-- identity from acquiring destructive policy authority merely by using the
-- same role name.
CREATE TABLE policy_reconciliation_scheduler_identities (
  organization_id TEXT PRIMARY KEY NOT NULL,
  identity_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

INSERT INTO identities
  (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
SELECT
  'policy-scheduler-' || lower(hex(randomblob(16))),
  'system:policy-scheduler:' || organization.id,
  'policy-scheduler+' || lower(hex(organization.id)) || '@gridora.invalid',
  'Gridora policy scheduler',
  'active',
  organization.created_at,
  organization.created_at
FROM organizations AS organization
WHERE NOT EXISTS (
  SELECT 1 FROM identities AS identity
  WHERE identity.access_subject = 'system:policy-scheduler:' || organization.id
);

INSERT OR IGNORE INTO policy_reconciliation_scheduler_identities
  (organization_id, identity_id, created_at)
SELECT organization.id, identity.id, organization.created_at
FROM organizations AS organization
JOIN identities AS identity
  ON identity.access_subject = 'system:policy-scheduler:' || organization.id;

INSERT OR IGNORE INTO organization_memberships
  (organization_id, identity_id, role, status, joined_at, invited_by, revision)
SELECT scheduler.organization_id, scheduler.identity_id, 'automation', 'active',
  scheduler.created_at, NULL, 1
FROM policy_reconciliation_scheduler_identities AS scheduler;

CREATE TRIGGER policy_reconciliation_scheduler_identity_for_organization
AFTER INSERT ON organizations
BEGIN
  INSERT OR IGNORE INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
  VALUES (
    'policy-scheduler-' || lower(hex(randomblob(16))),
    'system:policy-scheduler:' || NEW.id,
    'policy-scheduler+' || lower(hex(NEW.id)) || '@gridora.invalid',
    'Gridora policy scheduler',
    'active',
    NEW.created_at,
    NEW.created_at
  );
  INSERT OR IGNORE INTO policy_reconciliation_scheduler_identities
    (organization_id, identity_id, created_at)
  SELECT NEW.id, identity.id, NEW.created_at
  FROM identities AS identity
  WHERE identity.access_subject = 'system:policy-scheduler:' || NEW.id;
  INSERT OR IGNORE INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, invited_by, revision)
  SELECT scheduler.organization_id, scheduler.identity_id, 'automation', 'active',
    scheduler.created_at, NULL, 1
  FROM policy_reconciliation_scheduler_identities AS scheduler
  WHERE scheduler.organization_id = NEW.id;
END;

CREATE TRIGGER policy_reconciliation_scheduler_identity_immutable_update
BEFORE UPDATE ON policy_reconciliation_scheduler_identities
BEGIN SELECT RAISE(ABORT, 'policy scheduler identity is immutable'); END;
CREATE TRIGGER policy_reconciliation_scheduler_identity_immutable_delete
BEFORE DELETE ON policy_reconciliation_scheduler_identities
BEGIN SELECT RAISE(ABORT, 'policy scheduler identity is immutable'); END;
CREATE TRIGGER policy_reconciliation_scheduler_identity_active
BEFORE UPDATE OF status ON identities
WHEN EXISTS (
  SELECT 1 FROM policy_reconciliation_scheduler_identities scheduler
  WHERE scheduler.identity_id = OLD.id
) AND NEW.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'policy scheduler identity must remain active'); END;
CREATE TRIGGER policy_reconciliation_scheduler_membership_active_update
BEFORE UPDATE ON organization_memberships
WHEN EXISTS (
  SELECT 1 FROM policy_reconciliation_scheduler_identities scheduler
  WHERE scheduler.organization_id = OLD.organization_id
    AND scheduler.identity_id = OLD.identity_id
) AND (
  NEW.organization_id IS NOT OLD.organization_id
  OR NEW.identity_id IS NOT OLD.identity_id
  OR NEW.role <> 'automation'
  OR NEW.status <> 'active'
)
BEGIN SELECT RAISE(ABORT, 'policy scheduler membership must remain active automation'); END;
CREATE TRIGGER policy_reconciliation_scheduler_membership_active_delete
BEFORE DELETE ON organization_memberships
WHEN EXISTS (
  SELECT 1 FROM policy_reconciliation_scheduler_identities scheduler
  WHERE scheduler.organization_id = OLD.organization_id
    AND scheduler.identity_id = OLD.identity_id
)
BEGIN SELECT RAISE(ABORT, 'policy scheduler membership must remain active automation'); END;

-- At most one live reconciliation lease exists for an organization. The page
-- cursor bounds each cron invocation without ever enumerating all tenants.
CREATE TABLE policy_reconciliation_schedule_leases (
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  schedule_slot TEXT NOT NULL CHECK (julianday(schedule_slot) IS NOT NULL),
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed')),
  lease_until TEXT NOT NULL CHECK (julianday(lease_until) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  started_at TEXT,
  completed_at TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, schedule_slot),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, run_id),
  UNIQUE (workflow_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  CHECK (
    (state = 'pending' AND started_at IS NULL AND completed_at IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX policy_reconciliation_schedule_recovery
  ON policy_reconciliation_schedule_leases(state, lease_until, schedule_slot, organization_id);

CREATE TABLE policy_reconciliation_schedule_cursor (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'policy-schedule-v1'),
  last_organization_id TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  revision INTEGER NOT NULL CHECK (revision > 0)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER policy_reconciliation_schedule_lease_scope_guard_insert
BEFORE INSERT ON policy_reconciliation_schedule_leases
WHEN NEW.state <> 'pending'
  OR NEW.revision <> 1
  OR julianday(NEW.lease_until) <= julianday(NEW.created_at)
  OR NOT EXISTS (
    SELECT 1
    FROM organizations organization
    JOIN organization_policies policy ON policy.organization_id = organization.id
    JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = organization.id AND scheduler.identity_id = NEW.actor_id
    JOIN identities actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id AND membership.identity_id = actor.id
    WHERE organization.id = NEW.organization_id
      AND organization.status = 'active'
      AND organization.policy_revision = NEW.policy_revision
      AND policy.revision = NEW.policy_revision
      AND json_extract(policy.policy_json, '$.organizationId') = NEW.organization_id
      AND json_extract(policy.policy_json, '$.revision') = NEW.policy_revision
      AND actor.status = 'active'
      AND membership.status = 'active' AND membership.role = 'automation'
  )
BEGIN SELECT RAISE(ABORT, 'policy reconciliation schedule lease scope fence failed'); END;

CREATE TRIGGER policy_reconciliation_schedule_lease_transition_guard
BEFORE UPDATE OF state, lease_until, started_at, completed_at, revision
ON policy_reconciliation_schedule_leases
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.schedule_slot IS NOT OLD.schedule_slot
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.workflow_id IS NOT OLD.workflow_id
  OR NEW.lease_token IS NOT OLD.lease_token
  OR NEW.revision <> OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1
    FROM organizations organization
    JOIN organization_policies policy ON policy.organization_id = organization.id
    JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = organization.id AND scheduler.identity_id = NEW.actor_id
    JOIN identities actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id AND membership.identity_id = actor.id
    WHERE organization.id = NEW.organization_id
      AND organization.status = 'active'
      AND organization.policy_revision = NEW.policy_revision
      AND policy.revision = NEW.policy_revision
      AND actor.status = 'active'
      AND membership.status = 'active' AND membership.role = 'automation'
  )
  OR NOT (
    (OLD.state = 'pending' AND NEW.state = 'running'
      AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
    OR (OLD.state IN ('pending', 'running') AND NEW.state = OLD.state
      AND NEW.started_at IS OLD.started_at AND NEW.completed_at IS OLD.completed_at)
    OR (OLD.state = 'running' AND NEW.state = 'completed'
      AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NOT NULL)
  )
BEGIN SELECT RAISE(ABORT, 'policy reconciliation schedule lease transition fence failed'); END;

-- Release intake creates only reviewed, tenant-scoped candidates. The cron
-- path can consume an already approved candidate but has no write capability
-- for this table.
CREATE TABLE policy_reconciliation_update_candidates (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  category TEXT NOT NULL CHECK (category IN ('security', 'feature')),
  target_version TEXT NOT NULL CHECK (length(target_version) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'withdrawn')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL CHECK (julianday(approved_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, server_id, revision),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX policy_reconciliation_update_candidates_active
  ON policy_reconciliation_update_candidates(organization_id, status, server_id, revision);

CREATE TRIGGER policy_reconciliation_update_candidate_scope_guard
BEFORE INSERT ON policy_reconciliation_update_candidates
WHEN NOT EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN game_servers server
    ON server.organization_id = organization.id AND server.id = NEW.server_id
  JOIN identities approver ON approver.id = NEW.approved_by
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = approver.id
  WHERE organization.id = NEW.organization_id
    AND organization.status = 'active'
    AND server.desired_state <> 'deleted'
    AND approver.status = 'active'
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'administrator')
)
BEGIN SELECT RAISE(ABORT, 'policy update candidate scope fence failed'); END;

CREATE TRIGGER policy_reconciliation_update_candidate_immutable
BEFORE UPDATE ON policy_reconciliation_update_candidates
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.id IS NOT OLD.id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.category IS NOT OLD.category
  OR NEW.target_version IS NOT OLD.target_version
  OR NEW.approved_by IS NOT OLD.approved_by
  OR NEW.approved_at IS NOT OLD.approved_at
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.status NOT IN ('active', 'superseded', 'withdrawn')
BEGIN SELECT RAISE(ABORT, 'policy update candidate immutable field changed'); END;

-- Player activity is derived only from the existing authoritative health
-- reduction. Agent heartbeat time is intentionally not an idle signal.
CREATE TABLE policy_reconciliation_server_activity (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  last_player_activity_at TEXT NOT NULL CHECK (julianday(last_player_activity_at) IS NOT NULL),
  health_sampled_at TEXT NOT NULL CHECK (julianday(health_sampled_at) IS NOT NULL),
  health_revision INTEGER NOT NULL CHECK (health_revision > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (organization_id, server_id),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER policy_reconciliation_activity_insert_guard
BEFORE INSERT ON policy_reconciliation_server_activity
WHEN NOT EXISTS (
  SELECT 1 FROM health_current_snapshots health
  WHERE health.organization_id = NEW.organization_id
    AND health.resource_type = 'server' AND health.resource_id = NEW.server_id
    AND health.server_id = NEW.server_id
    AND health.sampled_at = NEW.health_sampled_at
    AND health.revision = NEW.health_revision
    AND health.sampled_at = NEW.last_player_activity_at
    AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
    AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) > 0
)
BEGIN SELECT RAISE(ABORT, 'policy activity must derive from positive health evidence'); END;

CREATE TRIGGER policy_reconciliation_activity_update_guard
BEFORE UPDATE OF last_player_activity_at, health_sampled_at, health_revision,
  created_at, updated_at ON policy_reconciliation_server_activity
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.created_at IS NOT OLD.created_at
  OR julianday(NEW.last_player_activity_at) < julianday(OLD.last_player_activity_at)
  OR NOT EXISTS (
    SELECT 1 FROM health_current_snapshots health
    WHERE health.organization_id = NEW.organization_id
      AND health.resource_type = 'server' AND health.resource_id = NEW.server_id
      AND health.server_id = NEW.server_id
      AND health.sampled_at = NEW.health_sampled_at
      AND health.revision = NEW.health_revision
      AND health.sampled_at = NEW.last_player_activity_at
      AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
      AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) > 0
  )
BEGIN SELECT RAISE(ABORT, 'policy activity update must derive from positive health evidence'); END;

CREATE TRIGGER policy_reconciliation_activity_from_health_insert
AFTER INSERT ON health_current_snapshots
WHEN NEW.resource_type = 'server'
  AND json_type(NEW.summary_json, '$.game.playerCount') = 'integer'
  AND CAST(json_extract(NEW.summary_json, '$.game.playerCount') AS INTEGER) > 0
BEGIN
  INSERT INTO policy_reconciliation_server_activity
    (organization_id, server_id, last_player_activity_at, health_sampled_at, health_revision,
     created_at, updated_at)
  VALUES (NEW.organization_id, NEW.server_id, NEW.sampled_at, NEW.sampled_at, NEW.revision,
    NEW.sampled_at, NEW.sampled_at)
  ON CONFLICT (organization_id, server_id) DO UPDATE SET
    last_player_activity_at = excluded.last_player_activity_at,
    health_sampled_at = excluded.health_sampled_at,
    health_revision = excluded.health_revision,
    updated_at = excluded.updated_at
  WHERE julianday(policy_reconciliation_server_activity.last_player_activity_at)
    <= julianday(excluded.last_player_activity_at);
END;

CREATE TRIGGER policy_reconciliation_activity_from_health_update
AFTER UPDATE OF summary_json, sampled_at, revision ON health_current_snapshots
WHEN NEW.resource_type = 'server'
  AND json_type(NEW.summary_json, '$.game.playerCount') = 'integer'
  AND CAST(json_extract(NEW.summary_json, '$.game.playerCount') AS INTEGER) > 0
BEGIN
  INSERT INTO policy_reconciliation_server_activity
    (organization_id, server_id, last_player_activity_at, health_sampled_at, health_revision,
     created_at, updated_at)
  VALUES (NEW.organization_id, NEW.server_id, NEW.sampled_at, NEW.sampled_at, NEW.revision,
    NEW.sampled_at, NEW.sampled_at)
  ON CONFLICT (organization_id, server_id) DO UPDATE SET
    last_player_activity_at = excluded.last_player_activity_at,
    health_sampled_at = excluded.health_sampled_at,
    health_revision = excluded.health_revision,
    updated_at = excluded.updated_at
  WHERE julianday(policy_reconciliation_server_activity.last_player_activity_at)
    <= julianday(excluded.last_player_activity_at);
END;

-- The run row binds a deterministic Workflow task to one current policy
-- revision and one active lease. It stores no provider, agent, or client
-- secret and is inserted before its child action receipts.
CREATE TABLE policy_reconciliation_runs (
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  schedule_slot TEXT NOT NULL CHECK (julianday(schedule_slot) IS NOT NULL),
  idempotency_key TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK (julianday(observed_at) IS NOT NULL),
  snapshot_fingerprint TEXT NOT NULL CHECK (
    length(snapshot_fingerprint) = 71
    AND snapshot_fingerprint GLOB 'sha256:*'
    AND substr(snapshot_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (organization_id, run_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, schedule_slot)
    REFERENCES policy_reconciliation_schedule_leases(organization_id, schedule_slot) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE policy_reconciliation_actions (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('node', 'server')),
  resource_id TEXT NOT NULL,
  resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
  action TEXT NOT NULL CHECK (action IN (
    'retire-node', 'shutdown-server', 'delete-server', 'update-server'
  )),
  reason TEXT NOT NULL CHECK (reason IN (
    'temporary-node-expired', 'idle-threshold-reached', 'automatic-update-eligible'
  )),
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  -- This is the durable policy-action operation. It is not an audit-only
  -- synthetic row and is distinct from the later node or game operation.
  policy_operation_id TEXT NOT NULL,
  resource_expires_at TEXT,
  activity_last_at TEXT,
  health_sampled_at TEXT,
  health_revision INTEGER,
  config_revision INTEGER CHECK (config_revision > 0),
  mod_revision INTEGER CHECK (mod_revision >= 0),
  update_candidate_id TEXT,
  update_candidate_revision INTEGER,
  update_category TEXT CHECK (update_category IN ('security', 'feature')),
  update_target_version TEXT,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN (
    'pending', 'accepted', 'pending-reconciliation', 'rejected-stale', 'rejected-policy'
  )),
  operation_id TEXT,
  audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES policy_reconciliation_runs(organization_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (action = 'retire-node' AND resource_kind = 'node'
      AND reason = 'temporary-node-expired'
      AND resource_expires_at IS NOT NULL
      AND activity_last_at IS NULL AND health_sampled_at IS NULL AND health_revision IS NULL
      AND config_revision IS NULL AND mod_revision IS NULL
      AND update_candidate_id IS NULL AND update_candidate_revision IS NULL
      AND update_category IS NULL AND update_target_version IS NULL)
    OR ((action = 'shutdown-server' OR action = 'delete-server') AND resource_kind = 'server'
      AND reason = 'idle-threshold-reached'
      AND resource_expires_at IS NULL
      AND activity_last_at IS NOT NULL AND health_sampled_at IS NOT NULL AND health_revision IS NOT NULL
      AND config_revision IS NULL AND mod_revision IS NULL
      AND update_candidate_id IS NULL AND update_candidate_revision IS NULL
      AND update_category IS NULL AND update_target_version IS NULL)
    OR (action = 'update-server' AND resource_kind = 'server'
      AND reason = 'automatic-update-eligible'
      AND resource_expires_at IS NULL
      AND activity_last_at IS NULL AND health_sampled_at IS NULL AND health_revision IS NULL
      AND config_revision IS NOT NULL AND mod_revision IS NOT NULL
      AND update_candidate_id IS NOT NULL AND update_candidate_revision IS NOT NULL
      AND update_category IS NOT NULL AND update_target_version IS NOT NULL)
  ),
  CHECK (
    (dispatch_state = 'pending' AND operation_id IS NULL)
    OR (dispatch_state IN ('accepted', 'pending-reconciliation') AND operation_id IS NOT NULL)
    OR (dispatch_state IN ('rejected-stale', 'rejected-policy') AND operation_id IS NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX policy_reconciliation_actions_dispatch
  ON policy_reconciliation_actions(organization_id, dispatch_state, resource_kind, resource_id);

CREATE TRIGGER policy_reconciliation_run_scope_guard
BEFORE INSERT ON policy_reconciliation_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM policy_reconciliation_schedule_leases lease
  JOIN organizations organization ON organization.id = lease.organization_id
  JOIN organization_policies policy ON policy.organization_id = organization.id
  JOIN policy_reconciliation_scheduler_identities scheduler
    ON scheduler.organization_id = organization.id AND scheduler.identity_id = lease.actor_id
  JOIN identities actor ON actor.id = scheduler.identity_id
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = actor.id
  WHERE lease.organization_id = NEW.organization_id
    AND lease.schedule_slot = NEW.schedule_slot
    AND lease.actor_id = NEW.actor_id
    AND lease.policy_revision = NEW.policy_revision
    AND lease.run_id = NEW.run_id
    AND lease.idempotency_key = NEW.idempotency_key
    AND lease.lease_token = NEW.lease_token
    AND lease.state = 'running'
    AND julianday(lease.lease_until) > julianday(NEW.created_at)
    AND organization.status = 'active'
    AND organization.policy_revision = NEW.policy_revision
    AND policy.revision = NEW.policy_revision
    AND json_extract(policy.policy_json, '$.organizationId') = NEW.organization_id
    AND json_extract(policy.policy_json, '$.revision') = NEW.policy_revision
    AND actor.status = 'active'
    AND membership.status = 'active' AND membership.role = 'automation'
)
BEGIN SELECT RAISE(ABORT, 'policy reconciliation run scope fence failed'); END;

CREATE TRIGGER policy_reconciliation_action_scope_guard
BEFORE INSERT ON policy_reconciliation_actions
WHEN NEW.dispatch_state <> 'pending'
  OR NEW.operation_id IS NOT NULL
  OR NEW.revision <> 1
  OR NEW.updated_at IS NOT NEW.created_at
  OR NOT EXISTS (
    SELECT 1
    FROM policy_reconciliation_runs run
    JOIN policy_reconciliation_schedule_leases lease
      ON lease.organization_id = run.organization_id AND lease.schedule_slot = run.schedule_slot
    JOIN organizations organization ON organization.id = run.organization_id
    JOIN organization_policies policy ON policy.organization_id = organization.id
    JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = organization.id AND scheduler.identity_id = NEW.actor_id
    JOIN identities actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id AND membership.identity_id = actor.id
    WHERE run.organization_id = NEW.organization_id AND run.run_id = NEW.run_id
      AND run.actor_id = NEW.actor_id AND run.policy_revision = NEW.policy_revision
      AND lease.actor_id = NEW.actor_id AND lease.policy_revision = NEW.policy_revision
      AND lease.run_id = run.run_id AND lease.idempotency_key = run.idempotency_key
      AND lease.lease_token = run.lease_token AND lease.state = 'running'
      AND julianday(lease.lease_until) > julianday(NEW.created_at)
      AND organization.status = 'active'
      AND organization.policy_revision = NEW.policy_revision
      AND policy.revision = NEW.policy_revision
      AND json_extract(policy.policy_json, '$.organizationId') = NEW.organization_id
      AND json_extract(policy.policy_json, '$.revision') = NEW.policy_revision
      AND actor.status = 'active'
      AND membership.status = 'active' AND membership.role = 'automation'
      AND EXISTS (
        SELECT 1 FROM operations operation
        WHERE operation.id = NEW.policy_operation_id
          AND operation.organization_id = NEW.organization_id
          AND operation.type = 'policy-reconciliation.' || NEW.action
          AND operation.resource_type = NEW.resource_kind AND operation.resource_id = NEW.resource_id
          AND operation.actor_id = NEW.actor_id
          AND operation.idempotency_key = 'policy-operation:' || NEW.idempotency_key
          AND operation.correlation_id = NEW.correlation_id
          AND operation.status = 'requested' AND operation.progress = 0
      )
      AND (
        (NEW.action = 'retire-node' AND EXISTS (
          SELECT 1 FROM nodes node
          WHERE node.organization_id = NEW.organization_id AND node.id = NEW.resource_id
            AND node.desired_revision = NEW.resource_revision
            AND node.desired_state NOT IN ('deleted', 'draining')
            AND node.observed_state <> 'deleted'
            AND node.temporary_expires_at = NEW.resource_expires_at
            AND julianday(node.temporary_expires_at) <= julianday(NEW.created_at)
            AND json_extract(policy.policy_json, '$.temporaryNodes.automaticExpiryRequired') = 1
        ))
        OR ((NEW.action = 'shutdown-server' OR NEW.action = 'delete-server') AND EXISTS (
          SELECT 1
          FROM game_servers server
          JOIN policy_reconciliation_server_activity activity
            ON activity.organization_id = server.organization_id AND activity.server_id = server.id
          JOIN health_current_snapshots health
            ON health.organization_id = server.organization_id
              AND health.resource_type = 'server' AND health.resource_id = server.id
          WHERE server.organization_id = NEW.organization_id AND server.id = NEW.resource_id
            AND server.desired_revision = NEW.resource_revision
            AND server.desired_state = 'running' AND server.observed_state = 'running'
            AND server.pending_lifecycle_operation_id IS NULL
            AND activity.last_player_activity_at = NEW.activity_last_at
            AND health.sampled_at = NEW.health_sampled_at
            AND health.revision = NEW.health_revision
            AND health.status = 'healthy'
            AND json_extract(health.summary_json, '$.game.process') = 'running'
            AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
            AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) = 0
            AND julianday(health.sampled_at) <= julianday(NEW.created_at)
            AND julianday(health.sampled_at) >= julianday(NEW.created_at, '-5 minutes')
            AND json_extract(policy.policy_json, '$.idle.action') =
              CASE WHEN NEW.action = 'shutdown-server' THEN 'shutdown' ELSE 'delete' END
            AND julianday(activity.last_player_activity_at) <=
              julianday(NEW.created_at) - json_extract(policy.policy_json, '$.idle.afterMinutes') / 1440.0
            AND (NEW.action <> 'delete-server'
              OR json_extract(policy.policy_json, '$.backups.requiredBeforeDelete') = 0
              OR EXISTS (
                SELECT 1 FROM backups backup
                WHERE backup.organization_id = server.organization_id AND backup.server_id = server.id
                  AND backup.state = 'available'
                  AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
                  AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER)
                    = server.desired_revision
              ))
        ))
        OR (NEW.action = 'update-server' AND EXISTS (
          SELECT 1
          FROM game_servers server
          JOIN policy_reconciliation_update_candidates candidate
            ON candidate.organization_id = server.organization_id AND candidate.server_id = server.id
          WHERE server.organization_id = NEW.organization_id AND server.id = NEW.resource_id
            AND server.desired_revision = NEW.resource_revision
            AND server.desired_state = 'running' AND server.observed_state = 'running'
            AND server.pending_lifecycle_operation_id IS NULL
            AND server.active_config_revision = NEW.config_revision
            AND COALESCE((SELECT mods.desired_revision FROM mod_sets mods
              WHERE mods.organization_id = server.organization_id AND mods.server_id = server.id), 0) = NEW.mod_revision
            AND candidate.id = NEW.update_candidate_id
            AND candidate.revision = NEW.update_candidate_revision
            AND candidate.category = NEW.update_category
            AND candidate.target_version = NEW.update_target_version
            AND candidate.status = 'active'
            AND json_extract(policy.policy_json, '$.updates.automatic') IN ('all', NEW.update_category)
            AND json_extract(policy.policy_json, '$.monthlyBudget.currency') IS NOT NULL
            AND (
              json_extract(policy.policy_json, '$.updates.requireMaintenanceWindow') = 0
              OR EXISTS (
                SELECT 1 FROM json_each(policy.policy_json, '$.maintenanceWindows') AS window
                WHERE ((
                  CAST(strftime('%w', NEW.created_at) AS INTEGER) * 1440
                  + CAST(strftime('%H', NEW.created_at) AS INTEGER) * 60
                  + CAST(strftime('%M', NEW.created_at) AS INTEGER)
                  - (json_extract(window.value, '$.dayOfWeekUtc') * 1440
                    + json_extract(window.value, '$.startMinuteUtc')) + 10080
                ) % 10080) < json_extract(window.value, '$.durationMinutes')
              )
            )
        ))
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'policy-reconciliation.' || NEW.action || '.accepted'
      AND audit.target_type = NEW.resource_kind AND audit.target_id = NEW.resource_id
      AND audit.result = 'succeeded' AND audit.correlation_id = NEW.correlation_id
      AND json_extract(audit.summary_json, '$.actionId') = NEW.id
      AND json_extract(audit.summary_json, '$.runId') = NEW.run_id
      AND json_extract(audit.summary_json, '$.operationId') = NEW.policy_operation_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM outbox event
    WHERE event.organization_id = NEW.organization_id AND event.id = NEW.outbox_event_id
      AND event.event_type = 'policy-reconciliation.action.accepted'
      AND event.aggregate_type = NEW.resource_kind AND event.aggregate_id = NEW.resource_id
      AND event.publish_state = 'pending'
      AND json_extract(event.payload_json, '$.actionId') = NEW.id
      AND json_extract(event.payload_json, '$.runId') = NEW.run_id
      AND json_extract(event.payload_json, '$.operationId') = NEW.policy_operation_id
  )
BEGIN SELECT RAISE(ABORT, 'policy reconciliation action scope fence failed'); END;

CREATE TRIGGER policy_reconciliation_action_transition_guard
BEFORE UPDATE ON policy_reconciliation_actions
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.id IS NOT OLD.id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.resource_kind IS NOT OLD.resource_kind
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.resource_revision IS NOT OLD.resource_revision
  OR NEW.action IS NOT OLD.action
  OR NEW.reason IS NOT OLD.reason
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.correlation_id IS NOT OLD.correlation_id
  OR NEW.policy_operation_id IS NOT OLD.policy_operation_id
  OR NEW.resource_expires_at IS NOT OLD.resource_expires_at
  OR NEW.activity_last_at IS NOT OLD.activity_last_at
  OR NEW.health_sampled_at IS NOT OLD.health_sampled_at
  OR NEW.health_revision IS NOT OLD.health_revision
  OR NEW.config_revision IS NOT OLD.config_revision
  OR NEW.mod_revision IS NOT OLD.mod_revision
  OR NEW.update_candidate_id IS NOT OLD.update_candidate_id
  OR NEW.update_candidate_revision IS NOT OLD.update_candidate_revision
  OR NEW.update_category IS NOT OLD.update_category
  OR NEW.update_target_version IS NOT OLD.update_target_version
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
  OR NEW.outbox_event_id IS NOT OLD.outbox_event_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.dispatch_state = 'pending'
      AND NEW.dispatch_state IN ('accepted', 'pending-reconciliation')
      AND NEW.operation_id IS NOT NULL)
    OR (OLD.dispatch_state = 'pending'
      AND NEW.dispatch_state IN ('rejected-stale', 'rejected-policy')
      AND NEW.operation_id IS NULL)
  )
BEGIN SELECT RAISE(ABORT, 'policy reconciliation action transition fence failed'); END;

-- Both existing lifecycle repositories retain their normal human paths. These
-- nullable bindings exist only for an action that has passed the policy
-- scheduler's final D1 fence; no public route receives either field.
ALTER TABLE destructive_lifecycle_operations
  ADD COLUMN policy_reconciliation_action_id TEXT;
ALTER TABLE game_lifecycle_mutations
  ADD COLUMN policy_reconciliation_action_id TEXT;

CREATE INDEX policy_reconciliation_game_action_lookup
  ON game_lifecycle_mutations(organization_id, policy_reconciliation_action_id);
CREATE INDEX policy_reconciliation_destructive_action_lookup
  ON destructive_lifecycle_operations(organization_id, policy_reconciliation_action_id);

-- The original destructive trigger only allowed human administrators. Replace
-- that one membership clause with an exact, immutable scheduler exception.
DROP TRIGGER destructive_lifecycle_operation_scope_guard;
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
OR (
  NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.organization_id = NEW.organization_id
      AND membership.identity_id = NEW.actor_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'administrator')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM policy_reconciliation_actions action
    JOIN policy_reconciliation_runs run
      ON run.organization_id = action.organization_id AND run.run_id = action.run_id
    JOIN policy_reconciliation_schedule_leases lease
      ON lease.organization_id = run.organization_id AND lease.schedule_slot = run.schedule_slot
    JOIN organizations organization ON organization.id = action.organization_id
    JOIN organization_policies policy ON policy.organization_id = organization.id
    JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = action.organization_id AND scheduler.identity_id = NEW.actor_id
    JOIN identities actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships membership
      ON membership.organization_id = action.organization_id AND membership.identity_id = actor.id
    JOIN nodes node ON node.organization_id = action.organization_id AND node.id = action.resource_id
    WHERE action.organization_id = NEW.organization_id
      AND action.id = NEW.policy_reconciliation_action_id
      AND action.actor_id = NEW.actor_id
      AND action.action = 'retire-node'
      AND action.resource_kind = 'node' AND action.resource_id = NEW.resource_id
      AND action.idempotency_key = NEW.idempotency_key
      AND action.dispatch_state = 'pending'
      AND run.actor_id = NEW.actor_id AND run.policy_revision = action.policy_revision
      AND lease.actor_id = NEW.actor_id AND lease.policy_revision = action.policy_revision
      AND lease.run_id = run.run_id AND lease.idempotency_key = run.idempotency_key
      AND lease.lease_token = run.lease_token AND lease.state = 'running'
      AND julianday(lease.lease_until) > julianday(NEW.accepted_at)
      AND organization.status = 'active' AND organization.policy_revision = action.policy_revision
      AND policy.revision = action.policy_revision
      AND json_extract(policy.policy_json, '$.temporaryNodes.automaticExpiryRequired') = 1
      AND actor.status = 'active'
      AND membership.status = 'active' AND membership.role = 'automation'
      AND NEW.action = 'retire-node' AND NEW.resource_type = 'node'
      AND NEW.organization_deletion_operation_id IS NULL
      AND node.desired_revision = action.resource_revision + 1
      AND node.temporary_expires_at = action.resource_expires_at
      AND julianday(node.temporary_expires_at) <= julianday(NEW.accepted_at)
  )
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

CREATE TRIGGER policy_reconciliation_node_lifecycle_run_guard
BEFORE INSERT ON node_lifecycle_runs
WHEN EXISTS (
  SELECT 1 FROM destructive_lifecycle_operations lifecycle
  WHERE lifecycle.organization_id = NEW.organization_id
    AND lifecycle.operation_id = NEW.operation_id
    AND lifecycle.policy_reconciliation_action_id IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1
  FROM destructive_lifecycle_operations lifecycle
  JOIN policy_reconciliation_actions action
    ON action.organization_id = lifecycle.organization_id
      AND action.id = lifecycle.policy_reconciliation_action_id
  JOIN policy_reconciliation_runs run
    ON run.organization_id = action.organization_id AND run.run_id = action.run_id
  JOIN policy_reconciliation_schedule_leases lease
    ON lease.organization_id = run.organization_id AND lease.schedule_slot = run.schedule_slot
  JOIN organizations organization ON organization.id = action.organization_id
  JOIN organization_policies policy ON policy.organization_id = organization.id
  JOIN policy_reconciliation_scheduler_identities scheduler
    ON scheduler.organization_id = action.organization_id AND scheduler.identity_id = lifecycle.actor_id
  JOIN identities actor ON actor.id = scheduler.identity_id
  JOIN organization_memberships membership
    ON membership.organization_id = action.organization_id AND membership.identity_id = actor.id
  JOIN nodes node ON node.organization_id = action.organization_id AND node.id = action.resource_id
  WHERE lifecycle.organization_id = NEW.organization_id AND lifecycle.operation_id = NEW.operation_id
    AND lifecycle.action = 'retire-node' AND lifecycle.resource_type = 'node'
    AND lifecycle.actor_id = action.actor_id
    AND lifecycle.idempotency_key = action.idempotency_key
    AND action.action = 'retire-node' AND action.dispatch_state = 'pending'
    AND action.resource_kind = 'node' AND action.resource_id = NEW.node_id
    AND action.resource_revision = NEW.previous_desired_revision
    AND NEW.action = 'retire-node' AND NEW.force_requested = 0
    AND NEW.backup_policy = 'required' AND NEW.target_image_id IS NULL
    AND NEW.desired_revision = NEW.previous_desired_revision + 1
    AND node.desired_revision = NEW.desired_revision
    AND node.temporary_expires_at = action.resource_expires_at
    AND json_extract(policy.policy_json, '$.temporaryNodes.automaticExpiryRequired') = 1
    AND organization.status = 'active' AND organization.policy_revision = action.policy_revision
    AND policy.revision = action.policy_revision
    AND actor.status = 'active' AND membership.status = 'active' AND membership.role = 'automation'
    AND lease.actor_id = lifecycle.actor_id AND lease.policy_revision = action.policy_revision
    AND lease.run_id = run.run_id AND lease.idempotency_key = run.idempotency_key
    AND lease.lease_token = run.lease_token AND lease.state = 'running'
    AND julianday(lease.lease_until) > julianday(NEW.created_at)
)
BEGIN SELECT RAISE(ABORT, 'policy scheduler node retirement fence failed'); END;

-- A policy scheduler game mutation is a command acceptance only. This final
-- trigger runs after the normal repository has prepared its operation/state
-- rows but before the batch can commit, so a stale lease, policy, candidate,
-- health fact, or membership rolls every prepared row back together.
CREATE TRIGGER policy_reconciliation_game_scheduler_binding_guard
BEFORE INSERT ON game_lifecycle_mutations
WHEN EXISTS (
  SELECT 1
  FROM operations operation
  JOIN policy_reconciliation_scheduler_identities scheduler
    ON scheduler.organization_id = operation.organization_id AND scheduler.identity_id = operation.actor_id
  WHERE operation.organization_id = NEW.organization_id AND operation.id = NEW.operation_id
)
AND NOT EXISTS (
  SELECT 1
  FROM policy_reconciliation_actions action
  JOIN policy_reconciliation_runs run
    ON run.organization_id = action.organization_id AND run.run_id = action.run_id
  JOIN policy_reconciliation_schedule_leases lease
    ON lease.organization_id = run.organization_id AND lease.schedule_slot = run.schedule_slot
  JOIN organizations organization ON organization.id = action.organization_id
  JOIN organization_policies policy ON policy.organization_id = organization.id
  JOIN policy_reconciliation_scheduler_identities scheduler
    ON scheduler.organization_id = action.organization_id AND scheduler.identity_id = action.actor_id
  JOIN identities actor ON actor.id = scheduler.identity_id
  JOIN organization_memberships membership
    ON membership.organization_id = action.organization_id AND membership.identity_id = actor.id
  JOIN operations operation
    ON operation.organization_id = action.organization_id AND operation.id = NEW.operation_id
  JOIN game_servers server
    ON server.organization_id = action.organization_id AND server.id = action.resource_id
  WHERE action.organization_id = NEW.organization_id
    AND action.id = NEW.policy_reconciliation_action_id
    AND action.resource_kind = 'server' AND action.resource_id = NEW.server_id
    AND action.actor_id = operation.actor_id
    AND action.idempotency_key = NEW.idempotency_key
    AND action.resource_revision = NEW.expected_revision
    AND action.dispatch_state = 'pending'
    AND operation.actor_id = action.actor_id AND operation.idempotency_key = action.idempotency_key
    AND run.actor_id = action.actor_id AND run.policy_revision = action.policy_revision
    AND lease.actor_id = action.actor_id AND lease.policy_revision = action.policy_revision
    AND lease.run_id = run.run_id AND lease.idempotency_key = run.idempotency_key
    AND lease.lease_token = run.lease_token AND lease.state = 'running'
    AND julianday(lease.lease_until) > julianday(NEW.created_at)
    AND organization.status = 'active' AND organization.policy_revision = action.policy_revision
    AND policy.revision = action.policy_revision
    AND actor.status = 'active' AND membership.status = 'active' AND membership.role = 'automation'
    AND server.desired_revision = action.resource_revision + 1
    AND server.pending_lifecycle_operation_id = NEW.operation_id
    AND (
      ((action.action = 'shutdown-server' AND NEW.action = 'stop')
        OR (action.action = 'delete-server' AND NEW.action = 'delete'))
      AND EXISTS (
        SELECT 1
        FROM policy_reconciliation_server_activity activity
        JOIN health_current_snapshots health
          ON health.organization_id = activity.organization_id
            AND health.resource_type = 'server' AND health.resource_id = activity.server_id
        WHERE activity.organization_id = action.organization_id AND activity.server_id = action.resource_id
          AND activity.last_player_activity_at = action.activity_last_at
          AND health.sampled_at = action.health_sampled_at
          AND health.revision = action.health_revision
          AND health.status = 'healthy'
          AND json_extract(health.summary_json, '$.game.process') = 'running'
          AND json_type(health.summary_json, '$.game.playerCount') = 'integer'
          AND CAST(json_extract(health.summary_json, '$.game.playerCount') AS INTEGER) = 0
          AND julianday(health.sampled_at) <= julianday(NEW.created_at)
          AND julianday(health.sampled_at) >= julianday(NEW.created_at, '-5 minutes')
          AND json_extract(policy.policy_json, '$.idle.action') =
            CASE WHEN action.action = 'shutdown-server' THEN 'shutdown' ELSE 'delete' END
          AND julianday(activity.last_player_activity_at) <=
            julianday(NEW.created_at) - json_extract(policy.policy_json, '$.idle.afterMinutes') / 1440.0
          AND (action.action <> 'delete-server'
            OR json_extract(policy.policy_json, '$.backups.requiredBeforeDelete') = 0
            OR EXISTS (
              SELECT 1 FROM backups backup
              WHERE backup.organization_id = action.organization_id AND backup.server_id = action.resource_id
                AND backup.state = 'available'
                AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
                AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER)
                  = action.resource_revision
            ))
      )
      OR (action.action = 'update-server' AND NEW.action = 'update'
        AND server.desired_state = 'running'
        AND server.active_config_revision = action.config_revision
        AND COALESCE((SELECT mods.desired_revision FROM mod_sets mods
          WHERE mods.organization_id = server.organization_id AND mods.server_id = server.id), 0) = action.mod_revision
        AND json_extract(NEW.result_json, '$.expectedConfigRevision') = action.config_revision
        AND json_extract(NEW.result_json, '$.expectedModRevision') = action.mod_revision
        AND EXISTS (
          SELECT 1 FROM policy_reconciliation_update_candidates candidate
          WHERE candidate.organization_id = action.organization_id AND candidate.server_id = action.resource_id
            AND candidate.id = action.update_candidate_id
            AND candidate.revision = action.update_candidate_revision
            AND candidate.category = action.update_category
            AND candidate.target_version = action.update_target_version
            AND candidate.status = 'active'
        )
        AND json_extract(policy.policy_json, '$.updates.automatic') IN ('all', action.update_category)
        AND json_extract(policy.policy_json, '$.monthlyBudget.currency') IS NOT NULL
        AND (
          json_extract(policy.policy_json, '$.updates.requireMaintenanceWindow') = 0
          OR EXISTS (
            SELECT 1 FROM json_each(policy.policy_json, '$.maintenanceWindows') AS window
            WHERE ((
              CAST(strftime('%w', NEW.created_at) AS INTEGER) * 1440
              + CAST(strftime('%H', NEW.created_at) AS INTEGER) * 60
              + CAST(strftime('%M', NEW.created_at) AS INTEGER)
              - (json_extract(window.value, '$.dayOfWeekUtc') * 1440
                + json_extract(window.value, '$.startMinuteUtc')) + 10080
            ) % 10080) < json_extract(window.value, '$.durationMinutes')
          )
        )
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'policy scheduler game lifecycle fence failed'); END;

-- The policy action can become accepted only after the exact normal lifecycle
-- receipt exists. These checks deliberately do not treat any provider or
-- agent observation as completed work.
CREATE TRIGGER policy_reconciliation_action_dispatch_receipt_guard
BEFORE UPDATE OF dispatch_state, operation_id ON policy_reconciliation_actions
WHEN NEW.dispatch_state IN ('accepted', 'pending-reconciliation')
  AND NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.id = NEW.policy_operation_id
      AND operation.organization_id = NEW.organization_id
      AND operation.status = 'queued'
  )
  OR NEW.dispatch_state IN ('accepted', 'pending-reconciliation')
  AND NOT (
    (NEW.action = 'retire-node' AND EXISTS (
      SELECT 1 FROM destructive_lifecycle_operations lifecycle
      WHERE lifecycle.organization_id = NEW.organization_id
        AND lifecycle.operation_id = NEW.operation_id
        AND lifecycle.policy_reconciliation_action_id = NEW.id
        AND lifecycle.action = 'retire-node' AND lifecycle.resource_type = 'node'
        AND lifecycle.resource_id = NEW.resource_id AND lifecycle.actor_id = NEW.actor_id
        AND lifecycle.idempotency_key = NEW.idempotency_key
    ))
    OR (NEW.action IN ('shutdown-server', 'delete-server', 'update-server') AND EXISTS (
      SELECT 1 FROM game_lifecycle_mutations mutation
      JOIN operations operation
        ON operation.organization_id = mutation.organization_id AND operation.id = mutation.operation_id
      WHERE mutation.organization_id = NEW.organization_id
        AND mutation.operation_id = NEW.operation_id
        AND mutation.policy_reconciliation_action_id = NEW.id
        AND mutation.server_id = NEW.resource_id
        AND mutation.idempotency_key = NEW.idempotency_key
        AND operation.actor_id = NEW.actor_id
    ))
  )
BEGIN SELECT RAISE(ABORT, 'policy reconciliation action dispatch receipt fence failed'); END;

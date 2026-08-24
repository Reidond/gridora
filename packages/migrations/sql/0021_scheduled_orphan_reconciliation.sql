PRAGMA foreign_keys = ON;

-- A discovery result is valid only for the exact account credential revision
-- that was opened. Old rows remain readable for replay evidence; every new row
-- is fenced by the trigger below.
ALTER TABLE orphan_reconciliation_runs
  ADD COLUMN credential_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE orphan_reconciliation_runs
  ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER orphan_reconciliation_runs_active_scope_credential_guard
BEFORE INSERT ON orphan_reconciliation_runs
WHEN NEW.credential_reference = ''
  OR NEW.credential_revision < 1
  OR NOT EXISTS (
    SELECT 1
    FROM provider_allocations AS allocation
    JOIN provider_accounts AS account
      ON account.id = allocation.provider_account_id
    JOIN organizations AS organization
      ON organization.id = allocation.organization_id
    JOIN identities AS actor ON actor.id = NEW.actor_id
    JOIN organization_memberships AS membership
      ON membership.organization_id = allocation.organization_id
     AND membership.identity_id = actor.id
    WHERE allocation.organization_id = NEW.organization_id
      AND allocation.provider_account_id = NEW.provider_account_id
      AND account.provider_type = NEW.provider_type
      AND allocation.status = 'active'
      AND account.status = 'active'
      AND organization.status = 'active'
      AND actor.status = 'active'
      AND membership.status = 'active'
      AND (
        (account.scope = 'platform' AND account.organization_id IS NULL AND EXISTS (
          SELECT 1 FROM platform_secret_envelopes AS secret
          WHERE secret.id = account.credential_reference
            AND secret.scope_type = 'provider-account'
            AND secret.scope_id = account.id
            AND secret.revision = NEW.credential_revision
            AND account.credential_reference = NEW.credential_reference
        ))
        OR
        (account.scope = 'organization' AND account.organization_id = NEW.organization_id AND EXISTS (
          SELECT 1 FROM secret_envelopes AS secret
          WHERE secret.organization_id = NEW.organization_id
            AND secret.id = account.credential_reference
            AND secret.scope_type = 'provider-account'
            AND secret.scope_id = account.id
            AND secret.revision = NEW.credential_revision
            AND account.credential_reference = NEW.credential_reference
        ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'orphan reconciliation active credential fence failed');
END;

-- Each organization receives an internal automation identity. The identity has
-- no Access session or user credential and exists only for scheduler audit
-- attribution. It cannot be suspended or reassigned through membership APIs.
CREATE TABLE orphan_reconciliation_scheduler_identities (
  organization_id TEXT PRIMARY KEY NOT NULL,
  identity_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

INSERT INTO identities
  (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
SELECT
  'orphan-scheduler-' || lower(hex(randomblob(16))),
  'system:orphan-scheduler:' || organization.id,
  'orphan-scheduler+' || lower(hex(organization.id)) || '@gridora.invalid',
  'Gridora orphan scheduler',
  'active',
  organization.created_at,
  organization.created_at
FROM organizations AS organization
WHERE NOT EXISTS (
  SELECT 1 FROM identities AS identity
  WHERE identity.access_subject = 'system:orphan-scheduler:' || organization.id
);

INSERT OR IGNORE INTO orphan_reconciliation_scheduler_identities
  (organization_id, identity_id, created_at)
SELECT organization.id, identity.id, organization.created_at
FROM organizations AS organization
JOIN identities AS identity
  ON identity.access_subject = 'system:orphan-scheduler:' || organization.id
;

INSERT OR IGNORE INTO organization_memberships
  (organization_id, identity_id, role, status, joined_at, invited_by, revision)
SELECT scheduler.organization_id, scheduler.identity_id, 'automation', 'active',
  scheduler.created_at, NULL, 1
FROM orphan_reconciliation_scheduler_identities AS scheduler
;

CREATE TRIGGER orphan_reconciliation_scheduler_identity_for_organization
AFTER INSERT ON organizations
BEGIN
  INSERT OR IGNORE INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
  VALUES (
    'orphan-scheduler-' || lower(hex(randomblob(16))),
    'system:orphan-scheduler:' || NEW.id,
    'orphan-scheduler+' || lower(hex(NEW.id)) || '@gridora.invalid',
    'Gridora orphan scheduler',
    'active',
    NEW.created_at,
    NEW.created_at
  );
  INSERT OR IGNORE INTO orphan_reconciliation_scheduler_identities
    (organization_id, identity_id, created_at)
  SELECT NEW.id, identity.id, NEW.created_at
  FROM identities AS identity
  WHERE identity.access_subject = 'system:orphan-scheduler:' || NEW.id;
  INSERT OR IGNORE INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, invited_by, revision)
  SELECT scheduler.organization_id, scheduler.identity_id, 'automation', 'active',
    scheduler.created_at, NULL, 1
  FROM orphan_reconciliation_scheduler_identities AS scheduler
  WHERE scheduler.organization_id = NEW.id;
END;

CREATE TRIGGER orphan_reconciliation_scheduler_identity_immutable_update
BEFORE UPDATE ON orphan_reconciliation_scheduler_identities
BEGIN
  SELECT RAISE(ABORT, 'orphan scheduler identity is immutable');
END;

CREATE TRIGGER orphan_reconciliation_scheduler_identity_immutable_delete
BEFORE DELETE ON orphan_reconciliation_scheduler_identities
BEGIN
  SELECT RAISE(ABORT, 'orphan scheduler identity is immutable');
END;

CREATE TRIGGER orphan_reconciliation_scheduler_identity_active
BEFORE UPDATE OF status ON identities
WHEN EXISTS (
  SELECT 1 FROM orphan_reconciliation_scheduler_identities AS scheduler
  WHERE scheduler.identity_id = OLD.id
)
AND NEW.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'orphan scheduler identity must remain active');
END;

CREATE TRIGGER orphan_reconciliation_scheduler_membership_active_update
BEFORE UPDATE ON organization_memberships
WHEN EXISTS (
  SELECT 1 FROM orphan_reconciliation_scheduler_identities AS scheduler
  WHERE scheduler.organization_id = OLD.organization_id
    AND scheduler.identity_id = OLD.identity_id
)
AND (
  NEW.organization_id IS NOT OLD.organization_id
  OR NEW.identity_id IS NOT OLD.identity_id
  OR NEW.role <> 'automation'
  OR NEW.status <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'orphan scheduler membership must remain active automation');
END;

CREATE TRIGGER orphan_reconciliation_scheduler_membership_active_delete
BEFORE DELETE ON organization_memberships
WHEN EXISTS (
  SELECT 1 FROM orphan_reconciliation_scheduler_identities AS scheduler
  WHERE scheduler.organization_id = OLD.organization_id
    AND scheduler.identity_id = OLD.identity_id
)
BEGIN
  SELECT RAISE(ABORT, 'orphan scheduler membership must remain active automation');
END;

-- The queue worker may create only bounded, tenant-scoped tasks. A task never
-- stores a provider secret; execution reopens the exact current envelope in the
-- API Worker after this D1 fence is checked again.
CREATE TABLE orphan_reconciliation_schedule_leases (
  organization_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  actor_id TEXT NOT NULL,
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
  PRIMARY KEY (organization_id, provider_account_id, schedule_slot),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, run_id),
  UNIQUE (workflow_id),
  FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_allocations(organization_id, provider_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  CHECK (
    (state = 'pending' AND started_at IS NULL AND completed_at IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX orphan_reconciliation_schedule_recovery
  ON orphan_reconciliation_schedule_leases(state, lease_until, schedule_slot,
    organization_id, provider_account_id);

CREATE TRIGGER orphan_reconciliation_schedule_lease_scope_guard_insert
BEFORE INSERT ON orphan_reconciliation_schedule_leases
WHEN NEW.state <> 'pending'
  OR NEW.revision <> 1
  OR julianday(NEW.lease_until) <= julianday(NEW.created_at)
  OR NOT EXISTS (
    SELECT 1
    FROM provider_allocations AS allocation
    JOIN provider_accounts AS account
      ON account.id = allocation.provider_account_id
    JOIN organizations AS organization
      ON organization.id = allocation.organization_id
    JOIN orphan_reconciliation_scheduler_identities AS scheduler
      ON scheduler.organization_id = allocation.organization_id
     AND scheduler.identity_id = NEW.actor_id
    JOIN identities AS actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships AS membership
      ON membership.organization_id = scheduler.organization_id
     AND membership.identity_id = scheduler.identity_id
    WHERE allocation.organization_id = NEW.organization_id
      AND allocation.provider_account_id = NEW.provider_account_id
      AND account.provider_type = NEW.provider_type
      AND allocation.status = 'active'
      AND account.status = 'active'
      AND organization.status = 'active'
      AND actor.status = 'active'
      AND membership.role = 'automation'
      AND membership.status = 'active'
      AND (
        (account.scope = 'platform' AND account.organization_id IS NULL AND EXISTS (
          SELECT 1 FROM platform_secret_envelopes AS secret
          WHERE secret.id = account.credential_reference
            AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
        ))
        OR
        (account.scope = 'organization' AND account.organization_id = NEW.organization_id AND EXISTS (
          SELECT 1 FROM secret_envelopes AS secret
          WHERE secret.organization_id = NEW.organization_id
            AND secret.id = account.credential_reference
            AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
        ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'orphan schedule active allocation fence failed');
END;

CREATE TRIGGER orphan_reconciliation_schedule_lease_transition_guard
BEFORE UPDATE ON orphan_reconciliation_schedule_leases
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.schedule_slot IS NOT OLD.schedule_slot
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.workflow_id IS NOT OLD.workflow_id
  OR NEW.lease_token IS NOT OLD.lease_token
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR (OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'running'))
  OR (OLD.state = 'running' AND NEW.state NOT IN ('running', 'completed'))
  OR OLD.state = 'completed'
  OR (NEW.state = 'pending' AND (NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL))
  OR (NEW.state = 'running' AND (NEW.started_at IS NULL OR NEW.completed_at IS NOT NULL))
  OR (NEW.state = 'completed' AND (NEW.started_at IS NULL OR NEW.completed_at IS NULL))
  OR julianday(NEW.lease_until) IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM provider_allocations AS allocation
    JOIN provider_accounts AS account
      ON account.id = allocation.provider_account_id
    JOIN organizations AS organization
      ON organization.id = allocation.organization_id
    JOIN orphan_reconciliation_scheduler_identities AS scheduler
      ON scheduler.organization_id = allocation.organization_id
     AND scheduler.identity_id = NEW.actor_id
    JOIN identities AS actor ON actor.id = scheduler.identity_id
    JOIN organization_memberships AS membership
      ON membership.organization_id = scheduler.organization_id
     AND membership.identity_id = scheduler.identity_id
    WHERE allocation.organization_id = NEW.organization_id
      AND allocation.provider_account_id = NEW.provider_account_id
      AND account.provider_type = NEW.provider_type
      AND allocation.status = 'active'
      AND account.status = 'active'
      AND organization.status = 'active'
      AND actor.status = 'active'
      AND membership.role = 'automation'
      AND membership.status = 'active'
      AND (
        (account.scope = 'platform' AND account.organization_id IS NULL AND EXISTS (
          SELECT 1 FROM platform_secret_envelopes AS secret
          WHERE secret.id = account.credential_reference
            AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
        ))
        OR
        (account.scope = 'organization' AND account.organization_id = NEW.organization_id AND EXISTS (
          SELECT 1 FROM secret_envelopes AS secret
          WHERE secret.organization_id = NEW.organization_id
            AND secret.id = account.credential_reference
            AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
        ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'orphan schedule lease transition fence failed');
END;

CREATE TABLE orphan_reconciliation_schedule_cursor (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'orphan-schedule-v1'),
  last_organization_id TEXT NOT NULL,
  last_provider_account_id TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

CREATE TRIGGER orphan_reconciliation_schedule_cursor_transition_guard
BEFORE UPDATE ON orphan_reconciliation_schedule_cursor
WHEN NEW.id IS NOT OLD.id
  OR NEW.revision <> OLD.revision + 1
  OR julianday(NEW.updated_at) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'orphan schedule cursor transition fence failed');
END;

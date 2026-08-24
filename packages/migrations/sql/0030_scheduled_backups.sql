-- Durable, organization-scoped scheduled backup dispatch. The schedule revision
-- and scheduled instant form the idempotency fence used by the API reservation.
CREATE TABLE backup_schedules (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (interval_minutes BETWEEN 60 AND 10080),
  retention_days INTEGER NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 1 AND 365),
  retention_count INTEGER NOT NULL DEFAULT 7 CHECK (retention_count BETWEEN 1 AND 1000),
  next_run_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, server_id),
  FOREIGN KEY (organization_id, server_id) REFERENCES game_servers(organization_id, id)
);

CREATE INDEX backup_schedules_due
  ON backup_schedules(enabled, next_run_at, organization_id, id);

CREATE TABLE backup_schedule_dispatches (
  organization_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK (schedule_revision >= 1),
  server_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'dispatching', 'accepted', 'retrying', 'terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id TEXT,
  lease_expires_at TEXT,
  backup_job_id TEXT,
  operation_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, schedule_id, scheduled_for),
  FOREIGN KEY (organization_id, schedule_id) REFERENCES backup_schedules(organization_id, id),
  CHECK ((state IN ('claimed', 'retrying') AND lease_expires_at IS NULL AND claim_id IS NULL) OR
         (state = 'dispatching' AND lease_expires_at IS NOT NULL AND claim_id IS NOT NULL) OR
         (state IN ('accepted', 'terminal') AND lease_expires_at IS NULL AND claim_id IS NULL))
);

CREATE INDEX backup_schedule_dispatch_retry
  ON backup_schedule_dispatches(state, lease_expires_at, updated_at);

-- Existing and newly-created servers receive the product default: daily with
-- seven-day retention. An organization may disable or revise it explicitly.
INSERT OR IGNORE INTO backup_schedules
  (organization_id, id, server_id, enabled, interval_minutes, retention_days, retention_count,
   next_run_at, revision, created_at, updated_at)
SELECT organization_id, 'backup-schedule:' || id, id, 1, 1440, 7, 7,
       strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day'), 1, created_at, created_at
FROM game_servers;

CREATE TRIGGER game_servers_default_backup_schedule
AFTER INSERT ON game_servers
BEGIN
  INSERT OR IGNORE INTO backup_schedules
    (organization_id, id, server_id, enabled, interval_minutes, retention_days, retention_count,
     next_run_at, revision, created_at, updated_at)
  VALUES (NEW.organization_id, 'backup-schedule:' || NEW.id, NEW.id, 1, 1440, 7, 7,
          strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+1 day'), 1, NEW.created_at, NEW.created_at);
END;

CREATE TRIGGER backup_schedule_dispatch_scope
BEFORE INSERT ON backup_schedule_dispatches
BEGIN
  SELECT RAISE(ABORT, 'backup_schedule_dispatch_scope')
  WHERE NOT EXISTS (
    SELECT 1 FROM backup_schedules schedule
    WHERE schedule.organization_id = NEW.organization_id
      AND schedule.id = NEW.schedule_id
      AND schedule.server_id = NEW.server_id
      AND schedule.revision = NEW.schedule_revision
  );
END;

CREATE TABLE backup_restore_endpoint_receipts (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  source_dns_json TEXT NOT NULL CHECK (json_valid(source_dns_json)),
  target_dns_json TEXT NOT NULL CHECK (json_valid(target_dns_json)),
  target_deployment_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applied', 'rolled_back')),
  applied_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id),
  UNIQUE (organization_id, effect_id),
  FOREIGN KEY (organization_id, job_id) REFERENCES backup_jobs(organization_id, id)
) WITHOUT ROWID, STRICT;

-- Retention already uses the immutable orphan scheduler principal. Register
-- it explicitly as a system actor so strict v1 expiry audit envelopes resolve
-- to the exact operation actor without impersonating an Owner.
INSERT OR IGNORE INTO audit_actor_bindings
  (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
SELECT 'tenant', scheduler.organization_id, scheduler.organization_id, 'system',
       scheduler.identity_id, scheduler.identity_id, scheduler.created_at
FROM orphan_reconciliation_scheduler_identities scheduler;

CREATE TRIGGER audit_actor_binding_for_backup_retention_scheduler
AFTER INSERT ON orphan_reconciliation_scheduler_identities
BEGIN
  INSERT OR IGNORE INTO audit_actor_bindings
    (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
  VALUES ('tenant', NEW.organization_id, NEW.organization_id, 'system',
          NEW.identity_id, NEW.identity_id, NEW.created_at);
END;

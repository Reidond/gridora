PRAGMA foreign_keys = ON;

ALTER TABLE backups ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);

-- A backup artifact is deliberately separate from its operation. The artifact
-- survives a lost API response, while the job row is the idempotency and
-- cancellation fence used by the Workflow and agent.
CREATE TABLE backup_jobs (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('create', 'restore')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  backup_id TEXT NOT NULL,
  source_server_id TEXT NOT NULL,
  target_server_id TEXT,
  source_node_id TEXT,
  target_node_id TEXT,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  completion_fingerprint TEXT CHECK (
    completion_fingerprint IS NULL
    OR (length(completion_fingerprint) = 64 AND completion_fingerprint NOT GLOB '*[^0-9a-f]*')
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND length(request_json) <= 32768),
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'running', 'waiting_external', 'cancelling', 'cancelled',
    'succeeded', 'failed', 'failed_terminal'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id)
    REFERENCES backups(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, idempotency_key, mode),
  CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK ((mode = 'create' AND target_server_id IS NULL AND target_node_id IS NULL)
    OR (mode = 'restore' AND target_server_id IS NOT NULL AND target_node_id IS NOT NULL)),
  CHECK (source_node_id IS NOT NULL)
) WITHOUT ROWID, STRICT;

CREATE INDEX backup_jobs_operation ON backup_jobs(organization_id, operation_id);
CREATE INDEX backup_jobs_backup ON backup_jobs(organization_id, backup_id, state);
CREATE UNIQUE INDEX backup_jobs_active_restore
  ON backup_jobs(organization_id, backup_id)
  WHERE mode = 'restore'
    AND state IN ('reserved', 'running', 'waiting_external', 'cancelling');

-- INSERT OR IGNORE must not turn the active-restore uniqueness fence into a
-- successful no-op: the reservation batch contains operation/audit/outbox
-- evidence and must roll back all of it for a losing contender.
CREATE TRIGGER backup_jobs_active_restore_guard
BEFORE INSERT ON backup_jobs
WHEN NEW.mode = 'restore'
  AND EXISTS (
    SELECT 1 FROM backup_jobs existing
    WHERE existing.organization_id = NEW.organization_id
      AND existing.backup_id = NEW.backup_id
      AND existing.mode = 'restore'
      AND existing.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
  )
BEGIN
  SELECT RAISE(ABORT, 'backup restore is already active');
END;

-- Deletion is a two-phase protocol. The artifact revision is bumped while this
-- claim is active, before private R2 is touched. A lost R2/D1 response can
-- therefore adopt the exact key and finish safely, while restore insertion is
-- fenced for the same artifact.
CREATE TABLE backup_deletion_claims (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 1),
  r2_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('deleting', 'deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id)
    REFERENCES backups(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, backup_id, artifact_revision),
  CHECK (r2_key LIKE 'organizations/' || organization_id || '/%')
) WITHOUT ROWID, STRICT;

CREATE UNIQUE INDEX backup_deletion_claim_active
  ON backup_deletion_claims(organization_id, backup_id)
  WHERE state = 'deleting';

CREATE TRIGGER backup_deletion_claim_scope_guard_insert
BEFORE INSERT ON backup_deletion_claims
WHEN NOT EXISTS (
  SELECT 1 FROM backups backup
  WHERE backup.organization_id = NEW.organization_id
    AND backup.id = NEW.backup_id
    AND backup.r2_key = NEW.r2_key
    AND backup.state IN ('available', 'expired')
    -- The artifact revision is bumped by the first statement of the claim
    -- transaction. The row may only be inserted for that exact successor.
    AND backup.revision = NEW.artifact_revision
)
OR EXISTS (
  SELECT 1 FROM backup_jobs job
  WHERE job.organization_id = NEW.organization_id
    AND job.backup_id = NEW.backup_id
    AND job.mode = 'restore'
    AND job.state IN ('reserved', 'running', 'waiting_external', 'cancelling')
)
BEGIN
  SELECT RAISE(ABORT, 'backup deletion claim is fenced');
END;

CREATE TRIGGER backup_deletion_claim_immutable
BEFORE UPDATE OF organization_id, id, backup_id, artifact_revision, r2_key
ON backup_deletion_claims
BEGIN
  SELECT RAISE(ABORT, 'backup deletion claim scope is immutable');
END;

CREATE TRIGGER backup_jobs_scope_guard_insert
BEFORE INSERT ON backup_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM backups backup
  WHERE backup.organization_id = NEW.organization_id
    AND backup.id = NEW.backup_id
    AND backup.server_id = NEW.source_server_id
)
OR (NEW.mode = 'create' AND NOT EXISTS (
  SELECT 1 FROM deployments deployment
  WHERE deployment.organization_id = NEW.organization_id
    AND deployment.server_id = NEW.source_server_id
    AND deployment.node_id = NEW.source_node_id
))
OR (NEW.mode = 'restore' AND NOT EXISTS (
  SELECT 1 FROM backups backup
  WHERE backup.organization_id = NEW.organization_id
    AND backup.id = NEW.backup_id
    AND backup.state = 'available'
))
OR (NEW.mode = 'restore' AND EXISTS (
  SELECT 1 FROM backup_deletion_claims claim
  WHERE claim.organization_id = NEW.organization_id
    AND claim.backup_id = NEW.backup_id
    AND claim.state = 'deleting'
))
BEGIN
  SELECT RAISE(ABORT, 'backup job scope mismatch');
END;

CREATE TRIGGER backup_jobs_restore_target_guard
BEFORE INSERT ON backup_jobs
WHEN NEW.mode = 'restore'
AND (NOT EXISTS (
    SELECT 1 FROM game_servers server
    WHERE server.organization_id = NEW.organization_id
      AND server.id = NEW.target_server_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
      WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.target_node_id
      AND node.desired_state IN ('provisioning', 'ready', 'stopped')
  )
  OR EXISTS (
    SELECT 1 FROM deployments occupied
    WHERE occupied.organization_id = NEW.organization_id
      AND occupied.node_id = NEW.target_node_id
      AND occupied.server_id <> NEW.target_server_id
      AND occupied.observed_state NOT IN ('deleted', 'deleting')
  ))
BEGIN
  SELECT RAISE(ABORT, 'restore target is not a compatible organization deployment');
END;

CREATE TRIGGER backup_jobs_immutable_scope
BEFORE UPDATE OF organization_id, operation_id, mode, trigger, backup_id,
  source_server_id, target_server_id, source_node_id, target_node_id,
  idempotency_key, fingerprint, request_json ON backup_jobs
BEGIN
  SELECT RAISE(ABORT, 'backup job scope is immutable');
END;

CREATE TABLE backup_retention_policies (
  organization_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  schedule TEXT NOT NULL CHECK (length(schedule) BETWEEN 1 AND 128),
  retention_count INTEGER NOT NULL CHECK (retention_count BETWEEN 1 AND 10000),
  retention_age_days INTEGER NOT NULL CHECK (retention_age_days BETWEEN 1 AND 36500),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, server_id),
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE backup_restore_cutovers (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  source_server_id TEXT NOT NULL,
  target_server_id TEXT NOT NULL,
  source_endpoint_json TEXT NOT NULL CHECK (json_valid(source_endpoint_json)),
  staged_endpoint_json TEXT NOT NULL CHECK (json_valid(staged_endpoint_json)),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'staged', 'validated', 'cutover', 'committed', 'rolled_back', 'failed')),
  source_preserved INTEGER NOT NULL CHECK (source_preserved IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, job_id) REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, backup_id) REFERENCES backups(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_server_id) REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, job_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX backup_restore_cutovers_job ON backup_restore_cutovers(organization_id, job_id);

CREATE TABLE backup_workflow_step_receipts (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  step TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'completed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id, ordinal),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE backup_workflow_completion_fences (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  step TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  receipt_revision INTEGER NOT NULL,
  expected_cutover_state TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id, ordinal),
  FOREIGN KEY (organization_id, job_id, ordinal)
    REFERENCES backup_workflow_step_receipts(organization_id, job_id, ordinal) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_workflow_completion_fence_guard
BEFORE INSERT ON backup_workflow_completion_fences
WHEN NOT EXISTS (
  SELECT 1 FROM backup_workflow_step_receipts receipt
  WHERE receipt.organization_id = NEW.organization_id
    AND receipt.job_id = NEW.job_id
    AND receipt.ordinal = NEW.ordinal
    AND receipt.step = NEW.step
    AND receipt.payload_fingerprint = NEW.payload_fingerprint
    AND receipt.state = 'completed'
    AND receipt.revision = NEW.receipt_revision
)
OR (
  NEW.expected_cutover_state IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM backup_restore_cutovers cutover
    WHERE cutover.organization_id = NEW.organization_id
      AND cutover.job_id = NEW.job_id
      AND cutover.state = NEW.expected_cutover_state
      AND cutover.source_preserved = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'backup Workflow completion fence failed');
END;

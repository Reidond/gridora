-- Backup acceptance provenance is immutable because completion and compensation
-- can occur days after the originating HTTP/scheduler request.
ALTER TABLE backup_jobs ADD COLUMN audit_request_context_json TEXT
  CHECK (
    audit_request_context_json IS NULL OR (
      length(audit_request_context_json) BETWEEN 2 AND 8192
      AND json_valid(audit_request_context_json)
      AND json_type(audit_request_context_json, '$') = 'object'
      AND json_type(audit_request_context_json, '$.origin') = 'text'
      AND json_type(audit_request_context_json, '$.requestId') = 'text'
      AND json_type(audit_request_context_json, '$.correlationId') = 'text'
      AND json_type(audit_request_context_json, '$.source') = 'object'
      AND json_type(audit_request_context_json, '$.source.ip') = 'object'
      AND json_type(audit_request_context_json, '$.source.access') = 'object'
    )
  );
ALTER TABLE backup_jobs ADD COLUMN audit_actor_type TEXT
  CHECK (audit_actor_type IS NULL OR audit_actor_type IN ('human', 'automation', 'system'));

CREATE TRIGGER backup_job_audit_provenance_required
BEFORE INSERT ON backup_jobs
WHEN NEW.audit_request_context_json IS NULL OR NEW.audit_actor_type IS NULL
BEGIN SELECT RAISE(ABORT, 'backup acceptance audit provenance is required'); END;

CREATE TRIGGER backup_job_audit_provenance_immutable
BEFORE UPDATE OF audit_request_context_json, audit_actor_type ON backup_jobs
WHEN NEW.audit_request_context_json IS NOT OLD.audit_request_context_json
  OR NEW.audit_actor_type IS NOT OLD.audit_actor_type
BEGIN SELECT RAISE(ABORT, 'backup acceptance audit provenance is immutable'); END;

CREATE TABLE backup_workflow_terminal_receipts (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  completion_fingerprint TEXT NOT NULL CHECK (
    length(completion_fingerprint) = 64
    AND completion_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  audit_operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id),
  UNIQUE (organization_id, audit_operation_id),
  UNIQUE (organization_id, audit_event_id),
  UNIQUE (organization_id, outbox_event_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, audit_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE backup_workflow_claim_fences (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  step TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  facts_revision INTEGER NOT NULL CHECK (facts_revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id, ordinal),
  FOREIGN KEY (organization_id, job_id, ordinal)
    REFERENCES backup_workflow_step_receipts(organization_id, job_id, ordinal) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_workflow_claim_fence_guard
BEFORE INSERT ON backup_workflow_claim_fences
WHEN NOT EXISTS (
  SELECT 1 FROM backup_workflow_step_receipts receipt
  JOIN backup_jobs job
    ON job.organization_id = receipt.organization_id AND job.id = receipt.job_id
  JOIN operation_cancellation_facts facts
    ON facts.organization_id = job.organization_id AND facts.operation_id = job.operation_id
  WHERE receipt.organization_id = NEW.organization_id AND receipt.job_id = NEW.job_id
    AND receipt.ordinal = NEW.ordinal AND receipt.step = NEW.step
    AND receipt.payload_fingerprint = NEW.payload_fingerprint
    AND receipt.state = 'claimed' AND facts.revision = NEW.facts_revision
)
BEGIN SELECT RAISE(ABORT, 'backup workflow claim fence failed'); END;

CREATE TRIGGER backup_terminal_receipt_guard
BEFORE INSERT ON backup_workflow_terminal_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM backup_jobs job JOIN operations operation
    ON operation.organization_id = job.organization_id AND operation.id = job.operation_id
  WHERE job.organization_id = NEW.organization_id AND job.id = NEW.job_id
    AND job.operation_id = NEW.operation_id AND job.state = 'succeeded'
    AND job.completion_fingerprint = NEW.completion_fingerprint
    AND operation.status = 'succeeded'
)
OR NOT EXISTS (
  SELECT 1 FROM operations terminal
  WHERE terminal.organization_id = NEW.organization_id
    AND terminal.id = NEW.audit_operation_id AND terminal.status = 'succeeded'
)
OR NOT EXISTS (
  SELECT 1 FROM audit_events audit
  WHERE audit.organization_id = NEW.organization_id AND audit.id = NEW.audit_event_id
    AND audit.result = 'succeeded'
)
OR NOT EXISTS (
  SELECT 1 FROM outbox event
  WHERE event.organization_id = NEW.organization_id AND event.id = NEW.outbox_event_id
)
BEGIN SELECT RAISE(ABORT, 'backup terminal receipt evidence is incomplete'); END;

-- Immutable endpoint cutover plan. It is committed before the first external
-- DNS mutation and is the only source of truth used on retry or rollback.
CREATE TABLE backup_restore_endpoint_effects (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  source_server_id TEXT NOT NULL,
  target_server_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  target_deployment_id TEXT,
  expected_cutover_revision INTEGER NOT NULL CHECK (expected_cutover_revision > 0),
  source_snapshot_json TEXT NOT NULL CHECK (json_valid(source_snapshot_json)),
  transition_plan_json TEXT NOT NULL CHECK (json_valid(transition_plan_json)),
  state TEXT NOT NULL CHECK (state IN ('planned', 'applied', 'rolled_back')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id),
  UNIQUE (organization_id, effect_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_restore_endpoint_effect_immutable
BEFORE UPDATE OF organization_id, job_id, effect_id, source_server_id, target_server_id,
  target_node_id, target_deployment_id, expected_cutover_revision,
  source_snapshot_json, transition_plan_json, created_at
ON backup_restore_endpoint_effects
BEGIN SELECT RAISE(ABORT, 'backup restore endpoint effect identity is immutable'); END;

-- Validation can fail after agent staging but before endpoint planning. This
-- receipt proves that no endpoint effect could have mutated provider or D1
-- state, while still giving the signed rollback step an immutable identity.
CREATE TABLE backup_restore_pre_cutover_rollbacks (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  rollback_effect_id TEXT NOT NULL,
  source_server_id TEXT NOT NULL,
  target_server_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id),
  UNIQUE (organization_id, rollback_effect_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_jobs(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_restore_pre_cutover_rollback_guard
BEFORE INSERT ON backup_restore_pre_cutover_rollbacks
WHEN EXISTS (
  SELECT 1 FROM backup_restore_endpoint_effects effect
  WHERE effect.organization_id = NEW.organization_id AND effect.job_id = NEW.job_id
)
OR EXISTS (
  SELECT 1 FROM backup_restore_endpoint_receipts receipt
  WHERE receipt.organization_id = NEW.organization_id AND receipt.job_id = NEW.job_id
)
OR NOT EXISTS (
  SELECT 1 FROM backup_jobs job
  WHERE job.organization_id = NEW.organization_id AND job.id = NEW.job_id
    AND job.mode = 'restore' AND job.source_server_id = NEW.source_server_id
    AND job.target_server_id = NEW.target_server_id AND job.target_node_id = NEW.target_node_id
)
BEGIN SELECT RAISE(ABORT, 'backup restore pre-cutover rollback is not exact'); END;

CREATE TRIGGER backup_restore_pre_cutover_rollback_immutable
BEFORE UPDATE ON backup_restore_pre_cutover_rollbacks
BEGIN SELECT RAISE(ABORT, 'backup restore pre-cutover rollback is immutable'); END;

CREATE TRIGGER backup_restore_pre_cutover_rollback_delete_guard
BEFORE DELETE ON backup_restore_pre_cutover_rollbacks
BEGIN SELECT RAISE(ABORT, 'backup restore pre-cutover rollback is immutable'); END;

CREATE TABLE backup_restore_endpoint_provider_receipts (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  provider_record_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('A', 'AAAA')),
  source_owner_resource_id TEXT NOT NULL,
  source_content TEXT NOT NULL,
  target_owner_resource_id TEXT NOT NULL,
  target_content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applied', 'rolled_back')),
  disposition TEXT NOT NULL CHECK (disposition IN ('applied', 'adopted')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id, effect_id, record_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_restore_endpoint_effects(organization_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES backup_restore_endpoint_effects(organization_id, effect_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_restore_provider_receipt_identity_immutable
BEFORE UPDATE OF organization_id, job_id, effect_id, record_id, provider_record_id,
  hostname, record_type, source_owner_resource_id, source_content,
  target_owner_resource_id, target_content
ON backup_restore_endpoint_provider_receipts
BEGIN SELECT RAISE(ABORT, 'backup restore provider receipt identity is immutable'); END;

ALTER TABLE backup_restore_endpoint_receipts ADD COLUMN target_server_id TEXT;
ALTER TABLE backup_restore_endpoint_receipts ADD COLUMN cutover_revision INTEGER
  CHECK (cutover_revision IS NULL OR cutover_revision > 0);

CREATE TRIGGER backup_restore_endpoint_receipt_exact_guard
BEFORE INSERT ON backup_restore_endpoint_receipts
WHEN NEW.target_server_id IS NULL OR NEW.cutover_revision IS NULL
OR NOT EXISTS (
  SELECT 1 FROM backup_restore_endpoint_effects effect
  WHERE effect.organization_id = NEW.organization_id AND effect.job_id = NEW.job_id
    AND effect.effect_id = NEW.effect_id
    AND effect.target_server_id = NEW.target_server_id
    AND effect.target_node_id = NEW.target_node_id
    AND effect.expected_cutover_revision = NEW.cutover_revision
    AND effect.state = 'planned'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(effect.transition_plan_json) planned
      WHERE NOT EXISTS (
        SELECT 1 FROM backup_restore_endpoint_provider_receipts provider
        WHERE provider.organization_id = effect.organization_id
          AND provider.job_id = effect.job_id AND provider.effect_id = effect.effect_id
          AND provider.record_id = json_extract(planned.value, '$.id')
          AND provider.state = 'applied'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(effect.transition_plan_json) planned
      WHERE NOT EXISTS (
        SELECT 1 FROM dns_records record
        WHERE record.organization_id = effect.organization_id
          AND record.id = json_extract(planned.value, '$.id')
          AND record.server_id = json_extract(planned.value, '$.targetOwnerResourceId')
          AND record.provider_record_id = json_extract(planned.value, '$.providerRecordId')
          AND record.hostname = json_extract(planned.value, '$.hostname')
          AND record.target = json_extract(planned.value, '$.targetContent')
          AND record.state = 'active'
          AND record.revision = json_extract(planned.value, '$.targetRevision')
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'backup restore endpoint receipt is not exact'); END;

CREATE TABLE backup_restore_endpoint_rollbacks (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  rollback_effect_id TEXT NOT NULL,
  cutover_effect_id TEXT NOT NULL,
  expected_cutover_revision INTEGER NOT NULL CHECK (expected_cutover_revision > 0),
  target_server_id TEXT NOT NULL,
  cutover_was_applied INTEGER NOT NULL CHECK (cutover_was_applied IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('planned', 'applied')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id),
  UNIQUE (organization_id, rollback_effect_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_restore_endpoint_effects(organization_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cutover_effect_id)
    REFERENCES backup_restore_endpoint_effects(organization_id, effect_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_restore_endpoint_rollback_immutable
BEFORE UPDATE OF organization_id, job_id, rollback_effect_id, cutover_effect_id,
  expected_cutover_revision, target_server_id, cutover_was_applied, created_at
ON backup_restore_endpoint_rollbacks
BEGIN SELECT RAISE(ABORT, 'backup restore rollback identity is immutable'); END;

CREATE TABLE backup_restore_endpoint_rollback_fences (
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  rollback_effect_id TEXT NOT NULL,
  cutover_effect_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job_id),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES backup_restore_endpoint_rollbacks(organization_id, job_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER backup_restore_endpoint_rollback_fence_guard
BEFORE INSERT ON backup_restore_endpoint_rollback_fences
WHEN NOT EXISTS (
  SELECT 1 FROM backup_restore_endpoint_rollbacks rollback
  JOIN backup_restore_endpoint_effects effect
    ON effect.organization_id = rollback.organization_id AND effect.job_id = rollback.job_id
  LEFT JOIN backup_restore_endpoint_receipts endpoint
    ON endpoint.organization_id = rollback.organization_id AND endpoint.job_id = rollback.job_id
  WHERE rollback.organization_id = NEW.organization_id AND rollback.job_id = NEW.job_id
    AND rollback.rollback_effect_id = NEW.rollback_effect_id
    AND rollback.cutover_effect_id = NEW.cutover_effect_id
    AND rollback.state = 'applied' AND effect.state = 'rolled_back'
    AND (
      (rollback.cutover_was_applied = 1 AND endpoint.state = 'rolled_back')
      OR (rollback.cutover_was_applied = 0 AND endpoint.job_id IS NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(effect.transition_plan_json) planned
      WHERE NOT EXISTS (
        SELECT 1 FROM backup_restore_endpoint_provider_receipts provider
        WHERE provider.organization_id = effect.organization_id
          AND provider.job_id = effect.job_id AND provider.effect_id = effect.effect_id
          AND provider.record_id = json_extract(planned.value, '$.id')
          AND provider.state = 'rolled_back'
      )
      OR NOT EXISTS (
        SELECT 1 FROM dns_records record
        WHERE record.organization_id = effect.organization_id
          AND record.id = json_extract(planned.value, '$.id')
          AND record.server_id = json_extract(planned.value, '$.sourceOwnerResourceId')
          AND record.provider_record_id = json_extract(planned.value, '$.providerRecordId')
          AND record.hostname = json_extract(planned.value, '$.hostname')
          AND record.target = json_extract(planned.value, '$.sourceContent')
          AND record.state = 'active'
          AND record.revision = CASE rollback.cutover_was_applied
            WHEN 1 THEN json_extract(planned.value, '$.targetRevision') + 1
            ELSE json_extract(planned.value, '$.sourceRevision')
          END
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'backup restore endpoint rollback is not exact'); END;

-- Completion and cancellation are mutually exclusive winners. The request
-- insert is last in the cancellation acceptance batch, so any losing update
-- aborts and rolls the entire batch back.
CREATE TRIGGER backup_cancellation_request_winner_guard
BEFORE INSERT ON operation_cancellation_requests
WHEN EXISTS (
  SELECT 1 FROM backup_jobs job
  WHERE job.organization_id = NEW.organization_id AND job.operation_id = NEW.operation_id
    AND job.state <> 'cancelling'
)
BEGIN SELECT RAISE(ABORT, 'backup cancellation did not win the job fence'); END;

CREATE TRIGGER backup_completion_after_cancellation_guard
BEFORE UPDATE OF state ON backup_jobs
WHEN NEW.state = 'succeeded' AND EXISTS (
  SELECT 1 FROM operation_cancellation_requests request
  WHERE request.organization_id = NEW.organization_id AND request.operation_id = NEW.operation_id
)
BEGIN SELECT RAISE(ABORT, 'backup completion lost to cancellation'); END;

CREATE TRIGGER backup_cancellation_final_receipt_guard
BEFORE INSERT ON destructive_lifecycle_atomic_receipts
WHEN NEW.receipt_key = 'cancellation-finalized'
AND EXISTS (
  SELECT 1 FROM backup_jobs job
  WHERE job.organization_id = NEW.organization_id AND job.operation_id = NEW.operation_id
    AND job.state <> 'cancelled'
)
BEGIN SELECT RAISE(ABORT, 'backup cancellation finalization is inconsistent'); END;

-- Waiting details are useful only while an operation is nonterminal.
CREATE TRIGGER operation_detail_clear_terminal_waiting_reason
AFTER UPDATE OF status ON operations
WHEN NEW.status IN ('succeeded', 'failed', 'failed_terminal', 'cancelled')
BEGIN
  UPDATE operation_detail_projection SET waiting_reason = NULL, updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND operation_id = NEW.id;
END;

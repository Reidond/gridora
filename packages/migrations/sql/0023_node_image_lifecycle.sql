PRAGMA foreign_keys = ON;

-- `node_images` is retained as a compatibility projection for already deployed
-- node and observation code. The lifecycle table below is the authoritative
-- state machine. It bridges old candidate and retired rows without claiming
-- that legacy rows have modern provenance or promotion evidence.
CREATE TABLE node_image_lifecycle_records (
  image_id TEXT PRIMARY KEY NOT NULL,
  source_commit TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture = 'amd64'),
  artifact_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  sbom_digest TEXT NOT NULL,
  build_log_digest TEXT NOT NULL,
  signature_evidence_json TEXT NOT NULL CHECK (json_valid(signature_evidence_json)),
  scan_evidence_json TEXT CHECK (scan_evidence_json IS NULL OR json_valid(scan_evidence_json)),
  smoke_test_evidence_json TEXT CHECK (smoke_test_evidence_json IS NULL OR json_valid(smoke_test_evidence_json)),
  state TEXT NOT NULL CHECK (state IN ('building', 'testing', 'promoted', 'deprecated', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  legacy_unattested INTEGER NOT NULL DEFAULT 0 CHECK (legacy_unattested IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_at TEXT,
  deprecated_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  CHECK (
    (state = 'building' AND scan_evidence_json IS NULL AND smoke_test_evidence_json IS NULL)
    OR (state = 'testing' AND scan_evidence_json IS NOT NULL AND smoke_test_evidence_json IS NOT NULL)
    OR (state IN ('promoted', 'deprecated', 'revoked')
      AND scan_evidence_json IS NOT NULL AND smoke_test_evidence_json IS NOT NULL)
    OR legacy_unattested = 1
  )
) WITHOUT ROWID, STRICT;

-- Existing candidate becomes testing, existing retired becomes deprecated, and
-- an old failed image becomes revoked. An old promoted row is conservatively
-- deprecated in this new authority because old schema data has no pinned
-- source, SBOM, scan, or complete signature evidence. The legacy projection is
-- deliberately not rewritten for these bridge rows, so already running nodes
-- keep their prior observation compatibility until they are drained or rebuilt.
INSERT INTO node_image_lifecycle_records (
  image_id, source_commit, architecture, artifact_digest, manifest_digest,
  sbom_digest, build_log_digest, signature_evidence_json, scan_evidence_json,
  smoke_test_evidence_json, state, revision, legacy_unattested, created_at,
  updated_at, promoted_at, deprecated_at, revoked_at
)
SELECT
  image.id,
  'legacy-unattested:' || image.id,
  'amd64',
  image.checksum,
  image.checksum,
  image.checksum,
  image.checksum,
  json_object('schemaVersion', 0, 'legacySignature', image.signature),
  NULL,
  NULL,
  CASE image.status
    WHEN 'building' THEN 'building'
    WHEN 'candidate' THEN 'testing'
    WHEN 'promoted' THEN 'deprecated'
    WHEN 'retired' THEN 'deprecated'
    ELSE 'revoked'
  END,
  1,
  1,
  image.created_at,
  COALESCE(image.promoted_at, image.created_at),
  CASE WHEN image.status = 'promoted' THEN image.promoted_at ELSE NULL END,
  CASE WHEN image.status IN ('promoted', 'retired') THEN COALESCE(image.promoted_at, image.created_at) ELSE NULL END,
  CASE WHEN image.status = 'failed' THEN image.created_at ELSE NULL END
FROM node_images AS image;

CREATE TABLE node_image_policy_scopes (
  id TEXT PRIMARY KEY NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  provider_account_id TEXT NOT NULL,
  region TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture = 'amd64'),
  allow_stock_ubuntu_cloud_init_fallback INTEGER NOT NULL CHECK (allow_stock_ubuntu_cloud_init_fallback IN (0, 1)),
  promoted_image_id TEXT,
  last_known_good_image_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (promoted_image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_known_good_image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  UNIQUE (provider_account_id, region, architecture)
) WITHOUT ROWID, STRICT;

CREATE TABLE node_image_provider_registrations (
  id TEXT PRIMARY KEY NOT NULL,
  image_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  provider_account_id TEXT NOT NULL,
  provider_account_revision INTEGER NOT NULL CHECK (provider_account_revision > 0),
  credential_reference TEXT NOT NULL,
  region TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture = 'amd64'),
  mode TEXT NOT NULL CHECK (mode IN ('custom-image', 'stock-ubuntu-cloud-init')),
  provider_image_id TEXT,
  provider_request_id TEXT,
  cloud_init_template_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'registered', 'uncertain', 'degraded', 'revoked')),
  degraded_reason TEXT CHECK (degraded_reason IS NULL OR degraded_reason = 'stock-ubuntu-cloud-init'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id) REFERENCES node_image_policy_scopes(id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  UNIQUE (image_id, scope_id),
  CHECK (
    (mode = 'custom-image'
      AND cloud_init_template_digest IS NULL
      AND degraded_reason IS NULL
      AND state <> 'degraded')
    OR (mode = 'stock-ubuntu-cloud-init'
      AND cloud_init_template_digest IS NOT NULL
      AND state IN ('degraded', 'revoked')
      AND degraded_reason = 'stock-ubuntu-cloud-init'
      AND provider_image_id IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX node_image_provider_registrations_selectable
  ON node_image_provider_registrations(scope_id, image_id, state, mode);

-- Provider credentials can rotate between acceptance and a Workflow delivery.
-- A registration pins the exact active account revision and secret reference
-- that the delivery is allowed to open. It never silently follows a rotation.
CREATE INDEX node_image_provider_registrations_account_fence
  ON node_image_provider_registrations(provider_account_id, provider_account_revision, credential_reference, state);

-- Platform image operations have a separate ledger. They cannot be inserted by
-- an organization role, and they never use tenant outbox rows as a hidden
-- platform namespace.
CREATE TABLE platform_node_image_operations (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'create', 'test', 'configure-scope', 'register-provider', 'promote', 'rollback', 'revoke'
  )),
  image_id TEXT,
  scope_id TEXT,
  actor_id TEXT NOT NULL,
  actor_administrator_revision INTEGER NOT NULL CHECK (actor_administrator_revision > 0),
  audit_event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting-external', 'succeeded', 'failed-terminal')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id) REFERENCES node_image_policy_scopes(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES global_audit_events(id) ON DELETE RESTRICT,
  CHECK (
    (action = 'configure-scope' AND image_id IS NULL AND scope_id IS NOT NULL)
    OR (action = 'rollback' AND image_id IS NULL AND scope_id IS NOT NULL)
    OR (action = 'create' AND image_id IS NOT NULL AND scope_id IS NULL)
    OR (action = 'test' AND image_id IS NOT NULL AND scope_id IS NULL)
    OR (action IN ('register-provider', 'promote', 'revoke') AND image_id IS NOT NULL AND scope_id IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX platform_node_image_operations_resource
  ON platform_node_image_operations(image_id, scope_id, state, created_at DESC);

CREATE TABLE platform_node_image_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  publish_state TEXT NOT NULL CHECK (publish_state IN ('pending', 'publishing', 'delivered', 'failed', 'failed-terminal')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES platform_node_image_operations(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

-- Acceptance has one immutable event. A definitive provider failure needs a
-- separate, durable terminal event so consumers do not infer success from the
-- accepted event alone. The redacted code is the only provider outcome kept.
CREATE TABLE platform_node_image_terminal_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  audit_event_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  claim_id TEXT NOT NULL,
  claim_attempt INTEGER NOT NULL CHECK (claim_attempt > 0),
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'provider_account_unavailable', 'provider_authentication_failed', 'provider_authorization_failed',
    'provider_validation_failed', 'provider_quota_exhausted', 'provider_conflict',
    'provider_billing_action_required', 'provider_unsupported_capability', 'provider_reconciliation_required'
  )),
  event_type TEXT NOT NULL CHECK (event_type = 'node-image.register-provider.failed-terminal'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  publish_state TEXT NOT NULL CHECK (publish_state IN ('pending', 'publishing', 'delivered', 'failed', 'failed-terminal')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES platform_node_image_operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES global_audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE platform_node_image_workflow_starts (
  operation_id TEXT PRIMARY KEY NOT NULL,
  start_record_id TEXT NOT NULL UNIQUE,
  workflow_type TEXT NOT NULL CHECK (workflow_type = 'NodeImageLifecycleWorkflow'),
  workflow_instance_id TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL CHECK (
    length(params_fingerprint) = 64 AND params_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'adopted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES platform_node_image_operations(id) ON DELETE RESTRICT,
  CHECK (workflow_instance_id = operation_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE platform_node_image_step_receipts (
  operation_id TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (workflow_type = 'NodeImageLifecycleWorkflow'),
  step_name TEXT NOT NULL CHECK (step_name = 'apply-node-image-lifecycle'),
  ordinal INTEGER NOT NULL CHECK (ordinal = 0),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'waiting-external', 'failed-terminal')),
  claim_id TEXT NOT NULL,
  claim_attempt INTEGER NOT NULL CHECK (claim_attempt > 0),
  lease_expires_at TEXT NOT NULL,
  -- This deadline is set from the trusted Workflow clock on the first claim.
  -- It is immutable across lease recovery, so a crashed create can only be
  -- adopted during its original bounded recovery window.
  recovery_deadline_at_epoch_ms INTEGER NOT NULL CHECK (recovery_deadline_at_epoch_ms > 0),
  -- Set immediately before provider transport dispatch. Once true, any retry
  -- is discovery/adoption only, even if the worker dies before the HTTP call.
  provider_dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK (provider_dispatch_started IN (0, 1)),
  provider_request_id TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, ordinal),
  FOREIGN KEY (operation_id) REFERENCES platform_node_image_operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES platform_node_image_workflow_starts(operation_id) ON DELETE RESTRICT,
  CHECK (workflow_instance_id = operation_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_image_lifecycle_immutable_guard
BEFORE UPDATE ON node_image_lifecycle_records
WHEN NEW.image_id IS NOT OLD.image_id
  OR NEW.source_commit IS NOT OLD.source_commit
  OR NEW.architecture IS NOT OLD.architecture
  OR NEW.artifact_digest IS NOT OLD.artifact_digest
  OR NEW.manifest_digest IS NOT OLD.manifest_digest
  OR NEW.sbom_digest IS NOT OLD.sbom_digest
  OR NEW.build_log_digest IS NOT OLD.build_log_digest
  OR NEW.signature_evidence_json IS NOT OLD.signature_evidence_json
  OR NEW.legacy_unattested IS NOT OLD.legacy_unattested
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR OLD.state = 'revoked'
  OR OLD.legacy_unattested = 1
  OR (OLD.state = 'building' AND NEW.state NOT IN ('testing', 'revoked'))
  OR (OLD.state = 'testing' AND NEW.state NOT IN ('promoted', 'deprecated', 'revoked'))
  OR (OLD.state = 'promoted' AND NEW.state NOT IN ('deprecated', 'revoked'))
  OR (OLD.state = 'deprecated' AND NEW.state NOT IN ('promoted', 'revoked'))
BEGIN SELECT RAISE(ABORT, 'node image lifecycle transition fence failed'); END;

-- New lifecycle records project the modern state into the old selection column.
-- Legacy bridge records do not rewrite it; an old node remains observable while
-- the new selector uses `node_image_lifecycle_records` and its scope pointer.
CREATE TRIGGER node_image_lifecycle_projection_insert
AFTER INSERT ON node_image_lifecycle_records
WHEN NEW.legacy_unattested = 0
BEGIN
  UPDATE node_images
  SET status = CASE NEW.state
      WHEN 'building' THEN 'building'
      WHEN 'testing' THEN 'candidate'
      WHEN 'promoted' THEN 'promoted'
      WHEN 'deprecated' THEN 'retired'
      ELSE 'failed'
    END,
    promoted_at = CASE WHEN NEW.state = 'promoted' THEN NEW.promoted_at ELSE promoted_at END
  WHERE id = NEW.image_id;
END;

CREATE TRIGGER node_image_lifecycle_projection_update
AFTER UPDATE OF state ON node_image_lifecycle_records
WHEN NEW.legacy_unattested = 0
BEGIN
  UPDATE node_images
  SET status = CASE NEW.state
      WHEN 'building' THEN 'building'
      WHEN 'testing' THEN 'candidate'
      WHEN 'promoted' THEN 'promoted'
      WHEN 'deprecated' THEN 'retired'
      ELSE 'failed'
    END,
    promoted_at = CASE WHEN NEW.state = 'promoted' THEN NEW.promoted_at ELSE promoted_at END
  WHERE id = NEW.image_id;
END;

CREATE TRIGGER node_image_scope_account_guard
BEFORE INSERT ON node_image_policy_scopes
WHEN NOT EXISTS (
  SELECT 1 FROM provider_accounts account
  WHERE account.id = NEW.provider_account_id
    AND account.provider_type = NEW.provider_type
    AND account.scope = 'platform'
    AND account.organization_id IS NULL
    AND account.status = 'active'
)
BEGIN SELECT RAISE(ABORT, 'node image scope requires active platform provider account'); END;

CREATE TRIGGER node_image_scope_update_guard
BEFORE UPDATE ON node_image_policy_scopes
WHEN NEW.id IS NOT OLD.id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.region IS NOT OLD.region
  OR NEW.architecture IS NOT OLD.architecture
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    WHERE account.id = NEW.provider_account_id
      AND account.provider_type = NEW.provider_type
      AND account.scope = 'platform'
      AND account.organization_id IS NULL
      AND account.status = 'active'
  )
BEGIN SELECT RAISE(ABORT, 'node image scope update fence failed'); END;

CREATE TRIGGER node_image_registration_scope_guard_insert
BEFORE INSERT ON node_image_provider_registrations
WHEN NOT EXISTS (
  SELECT 1 FROM node_image_policy_scopes scope
  JOIN provider_accounts account ON account.id = scope.provider_account_id
  JOIN node_image_lifecycle_records image ON image.image_id = NEW.image_id
  WHERE scope.id = NEW.scope_id
    AND scope.provider_type = NEW.provider_type
    AND scope.provider_account_id = NEW.provider_account_id
    AND scope.region = NEW.region
    AND scope.architecture = NEW.architecture
    AND account.scope = 'platform'
    AND account.organization_id IS NULL
    AND account.status = 'active'
    AND account.revision = NEW.provider_account_revision
    AND account.credential_reference = NEW.credential_reference
    AND image.architecture = NEW.architecture
    AND image.legacy_unattested = 0
)
OR (NEW.mode = 'stock-ubuntu-cloud-init' AND NOT EXISTS (
  SELECT 1 FROM node_image_policy_scopes scope
  WHERE scope.id = NEW.scope_id AND scope.allow_stock_ubuntu_cloud_init_fallback = 1
))
BEGIN SELECT RAISE(ABORT, 'node image registration scope fence failed'); END;

CREATE TRIGGER node_image_registration_scope_guard_update
BEFORE UPDATE ON node_image_provider_registrations
WHEN NEW.id IS NOT OLD.id
  OR NEW.image_id IS NOT OLD.image_id
  OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.region IS NOT OLD.region
  OR NEW.architecture IS NOT OLD.architecture
  OR NEW.mode IS NOT OLD.mode
  OR NEW.cloud_init_template_digest IS NOT OLD.cloud_init_template_digest
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR (OLD.state = 'revoked' AND NEW.state <> 'revoked')
  OR (NEW.state <> 'revoked' AND NOT EXISTS (
    SELECT 1 FROM node_image_policy_scopes scope
    JOIN provider_accounts account ON account.id = scope.provider_account_id
    WHERE scope.id = NEW.scope_id
      AND scope.provider_type = NEW.provider_type
      AND scope.provider_account_id = NEW.provider_account_id
      AND scope.region = NEW.region
      AND scope.architecture = NEW.architecture
      AND account.scope = 'platform'
      AND account.organization_id IS NULL
      AND account.status = 'active'
      AND account.revision = NEW.provider_account_revision
      AND account.credential_reference = NEW.credential_reference
  ))
BEGIN SELECT RAISE(ABORT, 'node image registration update fence failed'); END;

CREATE TRIGGER platform_node_image_operation_actor_guard
BEFORE INSERT ON platform_node_image_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM identities identity
  JOIN platform_administrators administrator ON administrator.identity_id = identity.id
  WHERE identity.id = NEW.actor_id
    AND identity.status = 'active'
    AND administrator.status = 'active'
    AND administrator.revision = NEW.actor_administrator_revision
)
BEGIN SELECT RAISE(ABORT, 'node image operation requires active platform administrator'); END;

-- This trigger is the atomic acceptance fence. Resources are staged before the
-- operation row so their foreign keys are available; the final operation insert
-- re-reads every expected revision and rolls the complete batch back on a
-- stale or forged command.
CREATE TRIGGER platform_node_image_operation_acceptance_guard
BEFORE INSERT ON platform_node_image_operations
WHEN
  (NEW.action = 'create' AND NOT EXISTS (
    SELECT 1 FROM node_image_lifecycle_records image
    WHERE image.image_id = NEW.image_id AND image.state = 'building'
      AND image.revision = 1 AND image.legacy_unattested = 0
      AND image.image_id = json_extract(NEW.command_json, '$.intent.imageId')
  ))
  OR (NEW.action = 'test' AND NOT EXISTS (
    SELECT 1 FROM node_image_lifecycle_records image
    WHERE image.image_id = NEW.image_id AND image.state = 'building'
      AND image.revision = json_extract(NEW.command_json, '$.intent.expectedImageRevision')
      AND image.legacy_unattested = 0
      AND json_extract(NEW.command_json, '$.trustedTestingEvidence.scan.result') = 'passed'
      AND json_extract(NEW.command_json, '$.trustedTestingEvidence.smokeTest.result') = 'passed'
      AND json_extract(NEW.command_json, '$.trustedTestingEvidence.smokeTest.testRunId') =
        json_extract(NEW.command_json, '$.intent.testRunId')
  ))
  OR (NEW.action = 'configure-scope' AND NOT EXISTS (
    SELECT 1 FROM node_image_policy_scopes scope
    WHERE scope.id = NEW.scope_id
      AND scope.revision = json_extract(NEW.command_json, '$.resultScopeRevision')
      AND scope.provider_type = json_extract(NEW.command_json, '$.intent.providerType')
      AND scope.provider_account_id = json_extract(NEW.command_json, '$.intent.providerAccountId')
      AND scope.region = json_extract(NEW.command_json, '$.intent.region')
      AND scope.architecture = json_extract(NEW.command_json, '$.intent.architecture')
  ))
  OR (NEW.action = 'register-provider' AND (
    NOT EXISTS (
      SELECT 1 FROM node_image_lifecycle_records image
      WHERE image.image_id = NEW.image_id
        AND image.revision = json_extract(NEW.command_json, '$.intent.expectedImageRevision')
        AND image.legacy_unattested = 0
    )
    OR NOT EXISTS (
      SELECT 1 FROM node_image_policy_scopes scope
      WHERE scope.id = NEW.scope_id
        AND scope.revision = json_extract(NEW.command_json, '$.intent.expectedScopeRevision')
    )
    OR NOT EXISTS (
      SELECT 1 FROM node_image_provider_registrations registration
      WHERE registration.id = json_extract(NEW.command_json, '$.registrationId')
        AND registration.image_id = NEW.image_id AND registration.scope_id = NEW.scope_id
        AND registration.revision = json_extract(NEW.command_json, '$.resultRegistrationRevision')
    )
  ))
  OR (NEW.action = 'promote' AND (
    NOT EXISTS (
      SELECT 1 FROM node_image_lifecycle_records image
      WHERE image.image_id = NEW.image_id AND image.state IN ('testing', 'promoted')
        AND image.revision = json_extract(NEW.command_json, '$.intent.expectedImageRevision')
        AND image.legacy_unattested = 0
    )
    OR NOT EXISTS (
      SELECT 1 FROM node_image_policy_scopes scope
      WHERE scope.id = NEW.scope_id
        AND scope.revision = json_extract(NEW.command_json, '$.intent.expectedScopeRevision')
    )
    OR NOT EXISTS (
      SELECT 1 FROM node_image_provider_registrations registration
      WHERE registration.image_id = NEW.image_id AND registration.scope_id = NEW.scope_id
        AND registration.mode = 'custom-image' AND registration.state = 'registered'
    )
  ))
  OR (NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM node_image_policy_scopes scope
    WHERE scope.id = NEW.scope_id
      AND scope.revision = json_extract(NEW.command_json, '$.intent.expectedScopeRevision')
      AND scope.promoted_image_id IS NOT NULL
      AND scope.last_known_good_image_id IS NOT NULL
      AND scope.last_known_good_image_id <> scope.promoted_image_id
  ))
  OR (NEW.action = 'revoke' AND (
    NOT EXISTS (
      SELECT 1 FROM node_image_lifecycle_records image
      WHERE image.image_id = NEW.image_id
        AND image.revision = json_extract(NEW.command_json, '$.intent.expectedImageRevision')
        AND image.state IN ('testing', 'promoted', 'deprecated')
        AND image.legacy_unattested = 0
    )
    OR NOT EXISTS (
      SELECT 1 FROM node_image_policy_scopes scope
      WHERE scope.id = NEW.scope_id
        AND scope.revision = json_extract(NEW.command_json, '$.intent.expectedScopeRevision')
    )
    OR EXISTS (
      SELECT 1 FROM node_image_policy_scopes selected
      WHERE selected.promoted_image_id = NEW.image_id
        AND selected.id <> NEW.scope_id
    )
    OR EXISTS (
      SELECT 1 FROM node_image_policy_scopes selected
      WHERE selected.id = NEW.scope_id
        AND selected.promoted_image_id = NEW.image_id
        AND (selected.last_known_good_image_id IS NULL
          OR selected.last_known_good_image_id = NEW.image_id)
    )
  ))
  OR NOT EXISTS (
    SELECT 1 FROM global_audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.scope = 'platform'
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'node-image.' || NEW.action
      AND audit.target_type = CASE WHEN NEW.image_id IS NULL THEN 'node-image-scope' ELSE 'node-image' END
      AND audit.target_id = COALESCE(NEW.image_id, NEW.scope_id)
      AND audit.result = 'succeeded'
  )
BEGIN SELECT RAISE(ABORT, 'node image operation acceptance revision fence failed'); END;

CREATE TRIGGER platform_node_image_start_guard
BEFORE INSERT ON platform_node_image_workflow_starts
WHEN NOT EXISTS (
  SELECT 1 FROM platform_node_image_operations operation
  WHERE operation.id = NEW.operation_id
    AND operation.request_fingerprint = NEW.params_fingerprint
    AND operation.state = 'queued'
)
OR NOT EXISTS (
  SELECT 1 FROM global_audit_events audit
  JOIN platform_node_image_operations operation ON operation.id = NEW.operation_id
  WHERE audit.id = operation.audit_event_id
    AND audit.scope = 'platform'
    AND audit.actor_id = operation.actor_id
    AND audit.action = 'node-image.' || operation.action
    AND audit.result = 'succeeded'
)
OR NOT EXISTS (
  SELECT 1 FROM platform_node_image_outbox event
  WHERE event.operation_id = NEW.operation_id
)
BEGIN SELECT RAISE(ABORT, 'node image Workflow start fence failed'); END;

CREATE TRIGGER platform_node_image_outbox_guard
BEFORE INSERT ON platform_node_image_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM platform_node_image_operations operation
  WHERE operation.id = NEW.operation_id
    AND NEW.event_type = 'node-image.' || operation.action || '.accepted'
    AND json_extract(NEW.payload_json, '$.operationId') = NEW.operation_id
    AND json_extract(NEW.payload_json, '$.action') = operation.action
)
BEGIN SELECT RAISE(ABORT, 'node image outbox fence failed'); END;

CREATE TRIGGER platform_node_image_terminal_outbox_guard
BEFORE INSERT ON platform_node_image_terminal_outbox
WHEN NOT EXISTS (
  SELECT 1
  FROM platform_node_image_operations operation
  JOIN platform_node_image_step_receipts receipt
    ON receipt.operation_id = operation.id AND receipt.ordinal = 0
  JOIN node_image_provider_registrations registration
    ON registration.id = json_extract(operation.command_json, '$.registrationId')
   AND registration.image_id = operation.image_id AND registration.scope_id = operation.scope_id
  JOIN node_image_policy_scopes scope ON scope.id = registration.scope_id
  JOIN global_audit_events audit ON audit.id = NEW.audit_event_id
  WHERE operation.id = NEW.operation_id
    AND operation.action = 'register-provider'
    AND operation.state = 'running'
    AND operation.request_fingerprint = NEW.request_fingerprint
    AND receipt.state = 'running'
    AND receipt.claim_id = NEW.claim_id AND receipt.claim_attempt = NEW.claim_attempt
    AND audit.scope = 'platform' AND audit.actor_id = operation.actor_id
    AND audit.action = 'node-image.register-provider.failed-terminal'
    AND audit.target_type = 'node-image' AND audit.target_id = operation.image_id
    AND audit.result = 'failed'
    AND json_extract(audit.summary_json, '$.operationId') = operation.id
    AND json_extract(audit.summary_json, '$.code') = NEW.failure_code
    AND json_extract(NEW.payload_json, '$.operationId') = operation.id
    AND json_extract(NEW.payload_json, '$.code') = NEW.failure_code
    AND registration.provider_type = scope.provider_type
    AND registration.provider_account_id = scope.provider_account_id
    AND registration.region = scope.region AND registration.architecture = scope.architecture
)
BEGIN SELECT RAISE(ABORT, 'node image terminal outbox fence failed'); END;

-- A Workflow delivery may retry. The receipt is the sole authority for a
-- provider side effect. A second delivery sees `running`, `waiting-external`,
-- or `completed`; it never gets a second unbounded create permission.
CREATE TRIGGER platform_node_image_step_receipt_insert_guard
BEFORE INSERT ON platform_node_image_step_receipts
WHEN NEW.state <> 'running'
  OR NEW.revision <> 1
  OR length(NEW.claim_id) < 16
  OR NEW.claim_attempt <> 1
  OR NEW.lease_expires_at <= NEW.created_at
  OR NEW.provider_dispatch_started <> 0
  OR NEW.recovery_deadline_at_epoch_ms <= CAST(unixepoch(NEW.created_at) * 1000 AS INTEGER)
  OR NEW.recovery_deadline_at_epoch_ms > CAST(unixepoch(NEW.created_at) * 1000 AS INTEGER) + 86400000
  OR NEW.provider_request_id IS NOT NULL
  OR NEW.result_json IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM platform_node_image_operations operation
    JOIN platform_node_image_workflow_starts workflow ON workflow.operation_id = operation.id
    WHERE operation.id = NEW.operation_id
      AND operation.state = 'running'
      AND workflow.start_record_id IS NOT NULL
      AND workflow.workflow_instance_id = NEW.workflow_instance_id
      AND workflow.workflow_type = NEW.workflow_type
      AND workflow.state IN ('started', 'adopted')
      AND NEW.request_fingerprint = operation.request_fingerprint
  )
BEGIN SELECT RAISE(ABORT, 'node image Workflow step claim fence failed'); END;

CREATE TRIGGER platform_node_image_step_receipt_update_guard
BEFORE UPDATE ON platform_node_image_step_receipts
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.workflow_instance_id IS NOT OLD.workflow_instance_id
  OR NEW.workflow_type IS NOT OLD.workflow_type
  OR NEW.step_name IS NOT OLD.step_name
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.recovery_deadline_at_epoch_ms IS NOT OLD.recovery_deadline_at_epoch_ms
  OR NEW.provider_dispatch_started NOT IN (0, 1)
  OR (OLD.provider_dispatch_started = 1 AND NEW.provider_dispatch_started <> 1)
  OR NEW.revision <> OLD.revision + 1
  OR OLD.state IN ('completed', 'failed-terminal')
  OR (OLD.state = 'running' AND NEW.state NOT IN ('running', 'waiting-external', 'completed', 'failed-terminal'))
  OR (OLD.state = 'waiting-external' AND NEW.state NOT IN ('running', 'completed', 'failed-terminal'))
  OR (NEW.state = 'running' AND NOT (
    -- Lease recovery takes a new identity. It cannot clear a provider-boundary mark.
    (length(NEW.claim_id) >= 16
      AND NEW.claim_attempt = OLD.claim_attempt + 1
      AND NEW.lease_expires_at > NEW.updated_at
      AND NEW.provider_dispatch_started = OLD.provider_dispatch_started)
    OR
    -- The exact pre-HTTP dispatch fence changes no lease coordinate.
    (OLD.provider_dispatch_started = 0
      AND NEW.provider_dispatch_started = 1
      AND NEW.claim_id IS OLD.claim_id
      AND NEW.claim_attempt = OLD.claim_attempt
      AND NEW.lease_expires_at IS OLD.lease_expires_at)
  ))
  OR (NEW.state <> 'running' AND (
    NEW.claim_id IS NOT OLD.claim_id
    OR NEW.claim_attempt <> OLD.claim_attempt
    OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
    OR NEW.provider_dispatch_started <> OLD.provider_dispatch_started
  ))
  OR (NEW.state = 'running' AND NOT EXISTS (
    SELECT 1 FROM platform_node_image_operations operation
    WHERE operation.id = NEW.operation_id AND operation.state = 'running'
  ))
  OR NOT EXISTS (
    SELECT 1 FROM platform_node_image_operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.request_fingerprint = NEW.request_fingerprint
      AND operation.state IN ('running', 'waiting-external')
  )
BEGIN SELECT RAISE(ABORT, 'node image Workflow step receipt fence failed'); END;

-- A provider step enters waiting state only as one receipt/operation pair.
-- The receipt is updated first; this final operation fence aborts the batch if
-- a concurrent dispatch claim changed the receipt before a pre-dispatch release.
CREATE TRIGGER platform_node_image_operation_waiting_guard
BEFORE UPDATE OF state ON platform_node_image_operations
WHEN NEW.state = 'waiting-external' AND (
  NEW.revision <> OLD.revision + 1
  OR OLD.state <> 'running'
  OR NOT EXISTS (
    SELECT 1 FROM platform_node_image_step_receipts receipt
    WHERE receipt.operation_id = NEW.id AND receipt.ordinal = 0
      AND receipt.request_fingerprint = NEW.request_fingerprint
      AND receipt.state = 'waiting-external'
      AND receipt.result_json IS NOT NULL
      AND json_extract(receipt.result_json, '$.kind') IN ('pre-dispatch-retry', 'uncertain')
  )
  OR (NEW.action = 'register-provider' AND EXISTS (
    SELECT 1 FROM platform_node_image_step_receipts receipt
    WHERE receipt.operation_id = NEW.id AND receipt.ordinal = 0
      AND json_extract(receipt.result_json, '$.kind') = 'uncertain'
  ) AND NOT EXISTS (
    SELECT 1
    FROM platform_node_image_step_receipts receipt
    JOIN node_image_provider_registrations registration
      ON registration.id = json_extract(NEW.command_json, '$.registrationId')
     AND registration.image_id = NEW.image_id AND registration.scope_id = NEW.scope_id
    WHERE receipt.operation_id = NEW.id AND receipt.ordinal = 0
      AND json_extract(receipt.result_json, '$.kind') = 'uncertain'
      AND registration.state = 'uncertain'
      -- The operation command records the acceptance revision. A provider
      -- visibility timeout can occur more than once, so the receipt records
      -- the exact post-CAS registration revision for this one settlement.
      -- This preserves the three-row atomic fence without limiting recovery
      -- to a single adopt-only poll.
      AND registration.revision = json_extract(receipt.result_json, '$.registrationRevision')
  ))
)
BEGIN SELECT RAISE(ABORT, 'node image waiting operation fence failed'); END;

-- Completion is valid only after the exact receipt has a terminal evidence
-- record and the authoritative lifecycle state reflects that operation. This
-- makes an optimistic SQL update fail atomically instead of reporting success.
CREATE TRIGGER platform_node_image_operation_completion_guard
BEFORE UPDATE OF state ON platform_node_image_operations
WHEN NEW.state = 'succeeded' AND (
  NEW.revision <> OLD.revision + 1
  OR OLD.state NOT IN ('running', 'waiting-external')
  OR NOT EXISTS (
    SELECT 1 FROM platform_node_image_step_receipts receipt
    WHERE receipt.operation_id = NEW.id
      AND receipt.workflow_instance_id = NEW.id
      AND receipt.request_fingerprint = NEW.request_fingerprint
      AND receipt.state = 'completed'
  )
  OR (NEW.action = 'create' AND NOT EXISTS (
    SELECT 1 FROM node_image_lifecycle_records image
    WHERE image.image_id = NEW.image_id AND image.state = 'building'
      AND image.legacy_unattested = 0
  ))
  OR (NEW.action = 'test' AND NOT EXISTS (
    SELECT 1 FROM node_image_lifecycle_records image
    WHERE image.image_id = NEW.image_id AND image.state = 'testing'
      AND image.revision = json_extract(NEW.command_json, '$.intent.expectedImageRevision') + 1
      AND image.scan_evidence_json = json_extract(NEW.command_json, '$.trustedTestingEvidence.scan')
      AND image.smoke_test_evidence_json = json_extract(NEW.command_json, '$.trustedTestingEvidence.smokeTest')
  ))
  OR (NEW.action = 'configure-scope' AND NOT EXISTS (
    SELECT 1 FROM node_image_policy_scopes scope
    WHERE scope.id = NEW.scope_id
      AND scope.revision = json_extract(NEW.command_json, '$.resultScopeRevision')
  ))
  OR (NEW.action = 'register-provider' AND NOT EXISTS (
    SELECT 1 FROM node_image_provider_registrations registration
    WHERE registration.id = json_extract(NEW.command_json, '$.registrationId')
      AND registration.image_id = NEW.image_id AND registration.scope_id = NEW.scope_id
      AND ((registration.mode = 'custom-image' AND registration.state = 'registered')
        OR (registration.mode = 'stock-ubuntu-cloud-init' AND registration.state = 'degraded'))
  ))
  OR (NEW.action = 'promote' AND NOT EXISTS (
    SELECT 1 FROM node_image_policy_scopes scope
    JOIN node_image_lifecycle_records image ON image.image_id = NEW.image_id
    WHERE scope.id = NEW.scope_id AND scope.promoted_image_id = NEW.image_id
      AND scope.revision = json_extract(NEW.command_json, '$.intent.expectedScopeRevision') + 1
      AND image.state = 'promoted'
  ))
  OR (NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM node_image_policy_scopes scope
    JOIN node_image_lifecycle_records image ON image.image_id = scope.promoted_image_id
    WHERE scope.id = NEW.scope_id
      AND scope.revision = json_extract(NEW.command_json, '$.intent.expectedScopeRevision') + 1
      AND scope.promoted_image_id = scope.last_known_good_image_id
      AND image.state = 'promoted'
  ))
  OR (NEW.action = 'revoke' AND (
    NOT EXISTS (
      SELECT 1 FROM node_image_lifecycle_records image
      WHERE image.image_id = NEW.image_id AND image.state = 'revoked'
    )
    OR EXISTS (
      SELECT 1 FROM node_image_policy_scopes scope WHERE scope.promoted_image_id = NEW.image_id
    )
  ))
)
BEGIN SELECT RAISE(ABORT, 'node image operation completion fence failed'); END;

CREATE TRIGGER platform_node_image_operation_terminal_guard
BEFORE UPDATE OF state ON platform_node_image_operations
WHEN NEW.state = 'failed-terminal' AND (
  NEW.revision <> OLD.revision + 1
  OR OLD.state <> 'running'
  OR NEW.action <> 'register-provider'
  OR NOT EXISTS (
    SELECT 1
    FROM platform_node_image_step_receipts receipt
    JOIN platform_node_image_terminal_outbox terminal ON terminal.operation_id = receipt.operation_id
    WHERE receipt.operation_id = NEW.id AND receipt.ordinal = 0
      AND receipt.state = 'failed-terminal'
      AND receipt.request_fingerprint = NEW.request_fingerprint
      AND terminal.request_fingerprint = NEW.request_fingerprint
      AND terminal.claim_id = receipt.claim_id AND terminal.claim_attempt = receipt.claim_attempt
      AND json_extract(receipt.result_json, '$.code') = terminal.failure_code
  )
)
BEGIN SELECT RAISE(ABORT, 'node image operation terminal fence failed'); END;

CREATE TRIGGER node_image_no_delete_while_in_use
BEFORE DELETE ON node_images
WHEN EXISTS (SELECT 1 FROM nodes node WHERE node.image_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'node image is in use and cannot be deleted'); END;

CREATE TRIGGER node_image_lifecycle_no_delete_while_in_use
BEFORE DELETE ON node_image_lifecycle_records
WHEN EXISTS (SELECT 1 FROM nodes node WHERE node.image_id = OLD.image_id)
BEGIN SELECT RAISE(ABORT, 'node image lifecycle is in use and cannot be deleted'); END;

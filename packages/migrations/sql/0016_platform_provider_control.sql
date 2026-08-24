PRAGMA foreign_keys = ON;

CREATE TABLE platform_administrators (
  identity_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (granted_by) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE platform_secret_envelopes (
  id TEXT PRIMARY KEY NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type = 'provider-account'),
  scope_id TEXT NOT NULL UNIQUE,
  ciphertext TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  FOREIGN KEY (scope_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE platform_provider_mutations (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'validate', 'disable', 'rotate', 'remove')),
  account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  audit_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES global_audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE platform_allocation_mutations (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'disable')),
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  audit_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES global_audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER platform_secret_scope_insert_guard
BEFORE INSERT ON platform_secret_envelopes
WHEN NOT EXISTS (SELECT 1 FROM provider_accounts a WHERE a.id = NEW.scope_id AND a.scope = 'platform' AND a.organization_id IS NULL AND a.credential_reference = NEW.id)
BEGIN SELECT RAISE(ABORT, 'platform secret scope mismatch'); END;

CREATE TRIGGER platform_secret_scope_update_guard
BEFORE UPDATE ON platform_secret_envelopes
WHEN NEW.id IS NOT OLD.id OR NEW.scope_type IS NOT OLD.scope_type OR NEW.scope_id IS NOT OLD.scope_id OR NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'platform secret revision fence failed'); END;

CREATE TRIGGER platform_secret_lease_update_guard
BEFORE UPDATE ON platform_secret_envelopes
WHEN EXISTS (SELECT 1 FROM node_provision_execution_leases l WHERE l.provider_account_id = OLD.scope_id AND l.state = 'active')
BEGIN SELECT RAISE(ABORT, 'platform provider account has active execution'); END;

CREATE TRIGGER platform_secret_lease_delete_guard
BEFORE DELETE ON platform_secret_envelopes
WHEN EXISTS (SELECT 1 FROM node_provision_execution_leases l WHERE l.provider_account_id = OLD.scope_id AND l.state = 'active')
BEGIN SELECT RAISE(ABORT, 'platform provider account has active execution'); END;

CREATE TRIGGER platform_allocation_scope_insert_guard
BEFORE INSERT ON platform_allocation_mutations
WHEN NOT EXISTS (SELECT 1 FROM provider_accounts a WHERE a.id = NEW.account_id AND a.scope = 'platform' AND a.organization_id IS NULL)
  OR NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = NEW.organization_id AND o.status = 'active')
BEGIN SELECT RAISE(ABORT, 'platform allocation scope mismatch'); END;

CREATE TRIGGER platform_provider_mutation_audit_guard
BEFORE INSERT ON platform_provider_mutations
WHEN NOT EXISTS (SELECT 1 FROM global_audit_events a WHERE a.id = NEW.audit_event_id AND a.scope = 'platform' AND a.actor_id = NEW.actor_id AND a.target_id = NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'platform provider audit mismatch'); END;

CREATE TRIGGER platform_provider_mutation_result_guard
BEFORE INSERT ON platform_provider_mutations
WHEN
  (NEW.action = 'remove' AND (
    EXISTS (SELECT 1 FROM provider_accounts a WHERE a.id = NEW.account_id)
    OR EXISTS (SELECT 1 FROM platform_secret_envelopes s WHERE s.scope_id = NEW.account_id)
    OR EXISTS (SELECT 1 FROM provider_allocations p WHERE p.provider_account_id = NEW.account_id)
  ))
  OR (NEW.action <> 'remove' AND NOT EXISTS (
    SELECT 1 FROM provider_accounts a
    JOIN platform_secret_envelopes s ON s.id = a.credential_reference AND s.scope_id = a.id
    WHERE a.id = NEW.account_id AND a.scope = 'platform' AND a.organization_id IS NULL
      AND a.revision = NEW.result_revision
      AND a.status = json_extract(NEW.response_json, '$.status')
      AND s.revision = json_extract(NEW.response_json, '$.credentialRevision')
  ))
BEGIN SELECT RAISE(ABORT, 'platform provider mutation result mismatch'); END;

CREATE TRIGGER platform_allocation_mutation_audit_guard
BEFORE INSERT ON platform_allocation_mutations
WHEN NOT EXISTS (SELECT 1 FROM global_audit_events a WHERE a.id = NEW.audit_event_id AND a.scope = 'platform' AND a.actor_id = NEW.actor_id AND a.target_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'platform allocation audit mismatch'); END;

CREATE TRIGGER platform_allocation_mutation_result_guard
BEFORE INSERT ON platform_allocation_mutations
WHEN NOT EXISTS (
  SELECT 1 FROM provider_allocations p
  WHERE p.organization_id = NEW.organization_id
    AND p.provider_account_id = NEW.account_id
    AND p.revision = NEW.result_revision
    AND p.status = json_extract(NEW.response_json, '$.status')
    AND p.max_active_nodes = json_extract(NEW.response_json, '$.maxActiveNodes')
    AND p.monthly_budget_minor IS json_extract(NEW.response_json, '$.monthlyBudgetMinor')
    AND p.allowed_regions_json = json_extract(NEW.response_json, '$.allowedRegions')
    AND p.allowed_plans_json = json_extract(NEW.response_json, '$.allowedPlans')
)
BEGIN SELECT RAISE(ABORT, 'platform allocation mutation result mismatch'); END;

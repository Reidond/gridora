PRAGMA foreign_keys = ON;

CREATE TABLE orphan_findings (
  organization_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  resource_kind TEXT NOT NULL CHECK (resource_kind = 'node'),
  provider_resource_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  image_version TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity = 'high'),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  last_discovery_run_id TEXT NOT NULL,
  resolution_kind TEXT CHECK (resolution_kind IN ('authoritative-adoption', 'provider-removal')),
  resolution_evidence_id TEXT,
  resolved_at TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, provider_account_id, provider_resource_id),
  FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_allocations(organization_id, provider_account_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'open' AND resolution_kind IS NULL AND resolution_evidence_id IS NULL AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolution_kind IS NOT NULL AND resolution_evidence_id IS NOT NULL AND resolved_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX orphan_findings_open
ON orphan_findings(organization_id, status, severity, last_detected_at DESC);

-- Cover the bounded legacy authority fallback. New nodes use immutable provision
-- acceptances. Legacy lookup reads at most two candidates to classify 0, 1, or 2+.
CREATE INDEX operations_legacy_node_provision
ON operations(organization_id, resource_id, id)
WHERE resource_type = 'node' AND type = 'node.provision' AND status = 'succeeded';

CREATE TRIGGER orphan_findings_scope_guard_insert
BEFORE INSERT ON orphan_findings
WHEN NOT EXISTS (
  SELECT 1
  FROM provider_allocations AS allocation
  JOIN provider_accounts AS account ON account.id = allocation.provider_account_id
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.provider_account_id = NEW.provider_account_id
    AND account.provider_type = NEW.provider_type
)
BEGIN
  SELECT RAISE(ABORT, 'orphan finding provider scope mismatch');
END;

CREATE TRIGGER orphan_findings_identity_immutable
BEFORE UPDATE ON orphan_findings
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.resource_kind IS NOT OLD.resource_kind
  OR NEW.provider_resource_id IS NOT OLD.provider_resource_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.image_version IS NOT OLD.image_version
  OR NEW.severity IS NOT OLD.severity
  OR NEW.first_detected_at IS NOT OLD.first_detected_at
BEGIN
  SELECT RAISE(ABORT, 'orphan finding identity is immutable');
END;

CREATE TRIGGER orphan_findings_no_delete
BEFORE DELETE ON orphan_findings
BEGIN
  SELECT RAISE(ABORT, 'orphan finding history is immutable');
END;

CREATE TABLE orphan_reconciliation_runs (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  actor_id TEXT NOT NULL,
  discovery_fingerprint TEXT NOT NULL CHECK (
    substr(discovery_fingerprint, 1, 7) = 'sha256:'
    AND length(discovery_fingerprint) = 71
    AND substr(discovery_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  discovery_observed_at TEXT NOT NULL CHECK (julianday(discovery_observed_at) IS NOT NULL),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  completed_at TEXT NOT NULL CHECK (julianday(completed_at) IS NOT NULL),
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, run_id),
  FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_allocations(organization_id, provider_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER orphan_reconciliation_runs_scope_guard_insert
BEFORE INSERT ON orphan_reconciliation_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM provider_allocations AS allocation
  JOIN provider_accounts AS account ON account.id = allocation.provider_account_id
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.provider_account_id = NEW.provider_account_id
    AND account.provider_type = NEW.provider_type
    AND EXISTS (
      SELECT 1
      FROM organization_memberships AS membership
      JOIN identities AS identity ON identity.id = membership.identity_id
      WHERE membership.organization_id = NEW.organization_id
        AND membership.identity_id = NEW.actor_id
        AND membership.status = 'active'
        AND identity.status = 'active'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'orphan reconciliation provider scope mismatch');
END;

CREATE TRIGGER orphan_reconciliation_runs_monotonic_insert
BEFORE INSERT ON orphan_reconciliation_runs
WHEN EXISTS (
  SELECT 1
  FROM orphan_reconciliation_runs AS prior
  WHERE prior.organization_id = NEW.organization_id
    AND prior.provider_account_id = NEW.provider_account_id
    AND prior.provider_type = NEW.provider_type
    AND julianday(prior.discovery_observed_at) >= julianday(NEW.discovery_observed_at)
)
BEGIN
  SELECT RAISE(ABORT, 'stale orphan discovery');
END;

CREATE TRIGGER orphan_reconciliation_runs_immutable
BEFORE UPDATE ON orphan_reconciliation_runs
BEGIN
  SELECT RAISE(ABORT, 'orphan reconciliation run is immutable');
END;

CREATE TRIGGER orphan_reconciliation_runs_no_delete
BEFORE DELETE ON orphan_reconciliation_runs
BEGIN
  SELECT RAISE(ABORT, 'orphan reconciliation run is immutable');
END;

PRAGMA foreign_keys = ON;

-- A symmetry scan is read-only with respect to provider, agent, DNS, Tunnel,
-- and R2 resources. It may only persist high-severity evidence and resolution
-- metadata. External deletion requires a different, explicitly accepted flow.
CREATE TABLE orphan_symmetry_runs (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authority_fingerprint TEXT NOT NULL CHECK (
    length(authority_fingerprint) = 71
    AND substr(authority_fingerprint, 1, 7) = 'sha256:'
    AND substr(authority_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  discovery_fingerprint TEXT NOT NULL CHECK (
    length(discovery_fingerprint) = 71
    AND substr(discovery_fingerprint, 1, 7) = 'sha256:'
    AND substr(discovery_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  discovery_observed_at TEXT NOT NULL CHECK (julianday(discovery_observed_at) IS NOT NULL),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  findings_json TEXT NOT NULL CHECK (
    json_valid(findings_json)
    AND json_type(findings_json) = 'array'
    AND json_array_length(findings_json) <= 500
    AND length(CAST(findings_json AS BLOB)) <= 262144
  ),
  operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  completed_at TEXT NOT NULL CHECK (julianday(completed_at) IS NOT NULL),
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, run_id),
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE orphan_symmetry_findings (
  organization_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'deployment-container', 'port-lease', 'dns-record',
    'tunnel-authority', 'backup-object'
  )),
  resource_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'missing-observed', 'unmanaged-observed', 'duplicate-observed',
    'foreign-observed', 'fingerprint-mismatch', 'receipt-missing',
    'receipt-stale', 'authority-stale'
  )),
  resource_id TEXT NOT NULL,
  node_id TEXT,
  severity TEXT NOT NULL CHECK (severity = 'high'),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  expected_fingerprint TEXT CHECK (
    expected_fingerprint IS NULL OR (
      length(expected_fingerprint) = 71
      AND substr(expected_fingerprint, 1, 7) = 'sha256:'
      AND substr(expected_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observed_fingerprint TEXT CHECK (
    observed_fingerprint IS NULL OR (
      length(observed_fingerprint) = 71
      AND substr(observed_fingerprint, 1, 7) = 'sha256:'
      AND substr(observed_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  recommendation TEXT NOT NULL CHECK (recommendation IN (
    'inspect-agent-container-inventory', 'inspect-node-port-ownership',
    'inspect-provider-dns-and-receipt', 'inspect-tunnel-and-node-authority',
    'inspect-r2-prefix-and-backup-catalog'
  )),
  first_detected_at TEXT NOT NULL CHECK (julianday(first_detected_at) IS NOT NULL),
  last_detected_at TEXT NOT NULL CHECK (julianday(last_detected_at) IS NOT NULL),
  last_run_id TEXT NOT NULL,
  resolved_at TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, resource_kind, resource_key, reason),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, last_run_id)
    REFERENCES orphan_symmetry_runs(organization_id, run_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX orphan_symmetry_findings_open
  ON orphan_symmetry_findings(organization_id, status, severity, resource_kind, last_detected_at DESC);

CREATE TRIGGER orphan_symmetry_run_strict_v1_guard
BEFORE INSERT ON orphan_symmetry_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN identities actor ON actor.id = NEW.actor_id AND actor.status = 'active'
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id
   AND membership.identity_id = actor.id
   AND membership.status = 'active'
  JOIN operations operation
    ON operation.organization_id = organization.id
   AND operation.id = NEW.operation_id
   AND operation.type = 'orphan.symmetry.reconciled'
   AND operation.resource_type = 'organization'
   AND operation.resource_id = organization.id
   AND operation.actor_id = actor.id
   AND operation.status = 'succeeded'
   AND operation.progress = 100
   AND operation.idempotency_key = 'orphan-symmetry-audit:' || NEW.idempotency_key
   AND operation.correlation_id = NEW.run_id
  JOIN audit_events audit
    ON audit.organization_id = organization.id
   AND audit.id = NEW.audit_event_id
   AND audit.actor_id = actor.id
   AND audit.action = 'orphan.symmetry.reconciled'
   AND audit.target_type = 'organization'
   AND audit.target_id = organization.id
   AND audit.result = 'succeeded'
   AND audit.correlation_id = NEW.run_id
  JOIN audit_event_envelopes envelope
    ON envelope.scope = 'tenant'
   AND envelope.organization_id = organization.id
   AND envelope.event_id = audit.id
   AND envelope.schema_version = 1
   AND envelope.capture_status = 'complete'
  WHERE organization.id = NEW.organization_id
    AND organization.status IN ('active', 'deleting')
    AND json_extract(envelope.envelope_json, '$.version') = 1
    AND json_extract(envelope.envelope_json, '$.captureStatus') = 'complete'
    AND json_extract(envelope.envelope_json, '$.action') = 'orphan.symmetry.reconciled'
    AND json_extract(envelope.envelope_json, '$.target.type') = 'organization'
    AND json_extract(envelope.envelope_json, '$.target.id') = organization.id
    AND json_extract(envelope.envelope_json, '$.operationId') = operation.id
    AND json_extract(envelope.envelope_json, '$.request.id') = NEW.run_id
    AND json_extract(envelope.envelope_json, '$.request.correlationId') = NEW.run_id
    AND json_extract(envelope.envelope_json, '$.source.origin') = 'scheduler'
    AND json_extract(envelope.envelope_json, '$.result') = 'succeeded'
    AND json_extract(envelope.envelope_json, '$.after.summary.discoveryFingerprint') =
      NEW.discovery_fingerprint
    AND json_extract(envelope.envelope_json, '$.after.summary.findingCount') =
      json_array_length(NEW.findings_json)
)
BEGIN
  SELECT RAISE(ABORT, 'orphan symmetry run strict v1 fence failed');
END;

CREATE TRIGGER orphan_symmetry_run_immutable_update
BEFORE UPDATE ON orphan_symmetry_runs
BEGIN
  SELECT RAISE(ABORT, 'orphan symmetry run is immutable');
END;

CREATE TRIGGER orphan_symmetry_run_immutable_delete
BEFORE DELETE ON orphan_symmetry_runs
BEGIN
  SELECT RAISE(ABORT, 'orphan symmetry run is immutable');
END;

CREATE TRIGGER orphan_symmetry_finding_insert_guard
BEFORE INSERT ON orphan_symmetry_findings
WHEN NEW.severity <> 'high'
  OR NOT EXISTS (
    SELECT 1
    FROM orphan_symmetry_runs run, json_each(run.findings_json) finding
    WHERE run.organization_id = NEW.organization_id
      AND run.run_id = NEW.last_run_id
      AND json_extract(finding.value, '$.kind') = NEW.resource_kind
      AND json_extract(finding.value, '$.resourceKey') = NEW.resource_key
      AND json_extract(finding.value, '$.reason') = NEW.reason
      AND json_extract(finding.value, '$.resourceId') = NEW.resource_id
      AND json_extract(finding.value, '$.nodeId') IS NEW.node_id
      AND json_extract(finding.value, '$.severity') = 'high'
      AND json_extract(finding.value, '$.expectedFingerprint') IS NEW.expected_fingerprint
      AND json_extract(finding.value, '$.observedFingerprint') IS NEW.observed_fingerprint
      AND json_extract(finding.value, '$.recommendation') = NEW.recommendation
  )
BEGIN
  SELECT RAISE(ABORT, 'orphan symmetry finding scope failed');
END;

CREATE TRIGGER orphan_symmetry_finding_update_guard
BEFORE UPDATE ON orphan_symmetry_findings
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.resource_kind IS NOT OLD.resource_kind
  OR NEW.resource_key IS NOT OLD.resource_key
  OR NEW.reason IS NOT OLD.reason
  OR NEW.severity <> 'high'
  OR NEW.first_detected_at IS NOT OLD.first_detected_at
  OR NEW.revision <> OLD.revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM orphan_symmetry_runs run
    WHERE run.organization_id = NEW.organization_id
      AND run.run_id = NEW.last_run_id
      AND (
        (NEW.status = 'open' AND EXISTS (
          SELECT 1 FROM json_each(run.findings_json) finding
          WHERE json_extract(finding.value, '$.kind') = NEW.resource_kind
            AND json_extract(finding.value, '$.resourceKey') = NEW.resource_key
            AND json_extract(finding.value, '$.reason') = NEW.reason
            AND json_extract(finding.value, '$.resourceId') = NEW.resource_id
            AND json_extract(finding.value, '$.nodeId') IS NEW.node_id
            AND json_extract(finding.value, '$.severity') = 'high'
            AND json_extract(finding.value, '$.expectedFingerprint') IS NEW.expected_fingerprint
            AND json_extract(finding.value, '$.observedFingerprint') IS NEW.observed_fingerprint
            AND json_extract(finding.value, '$.recommendation') = NEW.recommendation
        ))
        OR (NEW.status = 'resolved' AND NOT EXISTS (
          SELECT 1 FROM json_each(run.findings_json) finding
          WHERE json_extract(finding.value, '$.kind') = NEW.resource_kind
            AND json_extract(finding.value, '$.resourceKey') = NEW.resource_key
            AND json_extract(finding.value, '$.reason') = NEW.reason
        ))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'orphan symmetry finding transition failed');
END;

CREATE TRIGGER orphan_symmetry_finding_no_delete
BEFORE DELETE ON orphan_symmetry_findings
BEGIN
  SELECT RAISE(ABORT, 'orphan symmetry finding history is immutable');
END;

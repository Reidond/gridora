PRAGMA foreign_keys = ON;

-- Migration 0026 emitted its compact audit from a trigger. Migration 0028
-- correctly rejects that un-staged write, so replace the trigger and let the
-- core mutation batch stage the complete v1 envelope after this receipt runs.
DROP TRIGGER organization_membership_leave_apply;
CREATE TRIGGER organization_membership_leave_apply
AFTER INSERT ON organization_membership_leave_receipts
BEGIN
  DELETE FROM organization_memberships
  WHERE organization_id = NEW.organization_id
    AND identity_id = NEW.identity_id
    AND revision = NEW.membership_revision
    AND role = NEW.membership_role
    AND status = 'active'
    AND (
      role <> 'owner'
      OR (SELECT COUNT(*) FROM organization_memberships
          WHERE organization_id = NEW.organization_id AND role = 'owner' AND status = 'active') > 1
    );
  SELECT RAISE(ABORT, 'organization membership leave fence failed')
  WHERE EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE organization_id = NEW.organization_id AND identity_id = NEW.identity_id
  );
  INSERT INTO outbox
    (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
     publish_state, retry_count, available_at, created_at)
  VALUES (
    NEW.outbox_event_id, NEW.organization_id, 'organization.membership.left',
    'organization_membership', NEW.identity_id,
    json_object('principalId', NEW.identity_id, 'role', NEW.membership_role),
    'pending', 0, NEW.left_at, NEW.left_at
  );
END;

-- A raw client key is scoped by actor and action before it reaches the tenant
-- operations table. This receipt preserves the raw scope and the canonical
-- payload fingerprint so response-loss retries can adopt the exact operation.
CREATE TABLE core_mutation_receipts (
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 160),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  operation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 100),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 160),
  result_json TEXT NOT NULL CHECK (
    length(CAST(result_json AS BLOB)) <= 65536 AND json_valid(result_json)
  ),
  response_json TEXT NOT NULL CHECK (
    length(CAST(response_json AS BLOB)) <= 4096 AND json_valid(response_json)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_id, action, idempotency_key),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX core_mutation_receipts_operation
  ON core_mutation_receipts(organization_id, operation_id);

CREATE TRIGGER core_mutation_receipts_response_integrity
BEFORE INSERT ON core_mutation_receipts
WHEN
  json_extract(NEW.response_json, '$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.response_json, '$.resourceId') IS NOT NEW.resource_id
  OR json_extract(NEW.response_json, '$.status') IS NOT 'succeeded'
  OR json_extract(NEW.response_json, '$.links.operation') IS NOT
    '/v1/organizations/' || NEW.organization_id || '/operations/' || NEW.operation_id
  OR (SELECT resource_type FROM operations
      WHERE organization_id = NEW.organization_id AND id = NEW.operation_id) IS NOT NEW.resource_type
  OR (SELECT resource_id FROM operations
      WHERE organization_id = NEW.organization_id AND id = NEW.operation_id) IS NOT NEW.resource_id
BEGIN
  SELECT RAISE(ABORT, 'core mutation receipt response does not match operation');
END;

CREATE TRIGGER core_mutation_receipts_immutable_update
BEFORE UPDATE ON core_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'core mutation receipt is immutable');
END;

CREATE TRIGGER core_mutation_receipts_immutable_delete
BEFORE DELETE ON core_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'core mutation receipt is immutable');
END;

-- Organization creation cannot reference a tenant operation until the tenant
-- exists. Keep a platform-scoped bootstrap receipt linked to the platform
-- operation created by migration 0028.
CREATE TABLE organization_bootstrap_mutation_receipts (
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'organization.create'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  operation_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL CHECK (
    length(CAST(result_json AS BLOB)) <= 65536 AND json_valid(result_json)
  ),
  response_json TEXT NOT NULL CHECK (
    length(CAST(response_json AS BLOB)) <= 4096 AND json_valid(response_json)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, action, idempotency_key),
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES platform_operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER organization_bootstrap_mutation_receipts_immutable_update
BEFORE UPDATE ON organization_bootstrap_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'organization bootstrap mutation receipt is immutable');
END;

CREATE TRIGGER organization_bootstrap_mutation_receipts_response_integrity
BEFORE INSERT ON organization_bootstrap_mutation_receipts
WHEN
  json_extract(NEW.response_json, '$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.response_json, '$.resourceId') IS NOT NEW.organization_id
  OR json_extract(NEW.response_json, '$.status') IS NOT 'succeeded'
  OR json_extract(NEW.response_json, '$.links.operation') IS NOT
    '/v1/platform/operations/' || NEW.operation_id
BEGIN
  SELECT RAISE(ABORT, 'organization bootstrap response does not match operation');
END;

CREATE TRIGGER organization_bootstrap_mutation_receipts_immutable_delete
BEFORE DELETE ON organization_bootstrap_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'organization bootstrap mutation receipt is immutable');
END;

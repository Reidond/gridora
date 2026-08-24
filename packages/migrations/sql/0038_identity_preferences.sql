CREATE TABLE identity_preferences (
  identity_id TEXT PRIMARY KEY NOT NULL,
  last_organization_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE,
  FOREIGN KEY (last_organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER identity_preferences_revision_guard
BEFORE UPDATE ON identity_preferences
WHEN NEW.identity_id IS NOT OLD.identity_id OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'identity preference revision must advance exactly once');
END;

CREATE TABLE platform_identity_mutation_receipts (
  access_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'identity.sign-up'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  operation_id TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (
    length(CAST(result_json AS BLOB)) <= 65536 AND json_valid(result_json)
  ),
  response_json TEXT NOT NULL CHECK (
    length(CAST(response_json AS BLOB)) <= 4096 AND json_valid(response_json)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (access_subject, action, idempotency_key),
  FOREIGN KEY (operation_id) REFERENCES platform_operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER platform_identity_mutation_receipts_response_integrity
BEFORE INSERT ON platform_identity_mutation_receipts
WHEN
  json_extract(NEW.response_json, '$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.response_json, '$.resourceId') IS NOT NEW.identity_id
  OR json_extract(NEW.response_json, '$.status') IS NOT 'succeeded'
  OR json_extract(NEW.response_json, '$.links.operation') IS NOT
    '/v1/platform/operations/' || NEW.operation_id
BEGIN
  SELECT RAISE(ABORT, 'platform identity mutation response does not match operation');
END;

CREATE TRIGGER platform_identity_mutation_receipts_immutable_update
BEFORE UPDATE ON platform_identity_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'platform identity mutation receipt is immutable');
END;

CREATE TRIGGER platform_identity_mutation_receipts_immutable_delete
BEFORE DELETE ON platform_identity_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'platform identity mutation receipt is immutable');
END;

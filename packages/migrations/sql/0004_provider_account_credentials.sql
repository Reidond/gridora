PRAGMA foreign_keys = ON;

CREATE TABLE provider_account_mutation_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update-credentials')),
  account_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  expected_credential_revision INTEGER NOT NULL CHECK (expected_credential_revision >= 0),
  result_credential_revision INTEGER NOT NULL CHECK (result_credential_revision > 0),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

-- The idempotency row is the transaction fence. If either the provider metadata
-- or encrypted envelope update did not reach the claimed revision, abort the
-- whole D1 batch rather than committing a partial credential rotation.
CREATE TRIGGER provider_account_mutation_revision_fence
BEFORE INSERT ON provider_account_mutation_idempotency
WHEN NOT EXISTS (
  SELECT 1
  FROM provider_accounts p
  JOIN secret_envelopes s
    ON s.organization_id = p.organization_id
   AND s.id = p.credential_reference
   AND s.scope_type = 'provider-account'
   AND s.scope_id = p.id
  WHERE p.organization_id = NEW.organization_id
    AND p.id = NEW.account_id
    AND p.scope = 'organization'
    AND p.revision = NEW.result_revision
    AND s.revision = NEW.result_credential_revision
    AND (
      (NEW.action = 'create'
        AND NEW.expected_revision = 0
        AND NEW.result_revision = 1
        AND NEW.expected_credential_revision = 0
        AND NEW.result_credential_revision = 1)
      OR
      (NEW.action = 'update-credentials'
        AND NEW.result_revision = NEW.expected_revision + 1
        AND NEW.result_credential_revision = NEW.expected_credential_revision + 1)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'provider account credential revision fence failed');
END;

CREATE INDEX provider_account_mutation_account
  ON provider_account_mutation_idempotency(organization_id, account_id, created_at DESC);

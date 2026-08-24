CREATE TABLE IF NOT EXISTS provider_account_action_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('test', 'refresh', 'disable', 'remove')),
  account_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  result_revision INTEGER NOT NULL CHECK (result_revision = expected_revision + 1),
  operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX IF NOT EXISTS provider_account_action_account
  ON provider_account_action_idempotency(organization_id, account_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS provider_account_action_precondition_fence
BEFORE INSERT ON provider_account_action_idempotency
WHEN
  json_extract(NEW.response_json, '$.organizationId') IS NOT NEW.organization_id
  OR json_extract(NEW.response_json, '$.accountId') IS NOT NEW.account_id
  OR json_extract(NEW.response_json, '$.providerType') IS NOT NEW.provider_type
  OR json_extract(NEW.response_json, '$.action') IS NOT NEW.action
  OR json_extract(NEW.response_json, '$.revision') IS NOT NEW.result_revision
  OR json_extract(NEW.response_json, '$.operationId') IS NOT NEW.operation_id
  OR NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.organization_id = NEW.organization_id
      AND operation.resource_type = 'provider-account'
      AND operation.resource_id = NEW.account_id
      AND operation.idempotency_key = NEW.idempotency_key
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.target_type = 'provider-account'
      AND audit.target_id = NEW.account_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    JOIN secret_envelopes envelope
      ON envelope.organization_id = account.organization_id
     AND envelope.id = account.credential_reference
     AND envelope.scope_type = 'provider-account'
     AND envelope.scope_id = account.id
     AND envelope.revision = NEW.credential_revision
    WHERE account.id = NEW.account_id
      AND account.scope = 'organization'
      AND account.organization_id = NEW.organization_id
      AND account.provider_type = NEW.provider_type
      AND account.revision = NEW.expected_revision
  )
  OR (NEW.action = 'refresh' AND NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    WHERE account.id = NEW.account_id
      AND account.organization_id = NEW.organization_id
      AND account.revision = NEW.expected_revision
      AND account.status = 'active'
  ))
  OR (NEW.action = 'remove' AND (
    NOT EXISTS (
      SELECT 1 FROM provider_accounts account
      WHERE account.id = NEW.account_id
        AND account.organization_id = NEW.organization_id
        AND account.revision = NEW.expected_revision
        AND account.status = 'disabled'
    )
    OR EXISTS (
      SELECT 1 FROM provider_allocations allocation
      WHERE allocation.organization_id = NEW.organization_id
        AND allocation.provider_account_id = NEW.account_id
        AND allocation.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM nodes node
      WHERE node.organization_id = NEW.organization_id
        AND node.provider_account_id = NEW.account_id
    )
  ))
  OR NEW.finalized <> 0
BEGIN
  SELECT RAISE(ABORT, 'provider account lifecycle precondition fence failed');
END;

CREATE TRIGGER IF NOT EXISTS provider_account_action_result_fence
BEFORE UPDATE OF finalized ON provider_account_action_idempotency
WHEN
  OLD.finalized <> 0
  OR NEW.finalized <> 1
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.action IS NOT OLD.action
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.expected_revision IS NOT OLD.expected_revision
  OR NEW.credential_revision IS NOT OLD.credential_revision
  OR NEW.result_revision IS NOT OLD.result_revision
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
  OR NEW.response_json IS NOT OLD.response_json
  OR (
    NEW.action = 'remove' AND (
      json_type(NEW.response_json, '$.accountStatus') <> 'null'
      OR NOT EXISTS (
        SELECT 1 FROM provider_accounts account
        WHERE account.id = NEW.account_id
          AND account.scope = 'organization'
          AND account.organization_id = NEW.organization_id
          AND account.provider_type = NEW.provider_type
          AND account.status = 'disabled'
          AND account.revision = NEW.result_revision
      )
      OR EXISTS (
        SELECT 1 FROM secret_envelopes envelope
        WHERE envelope.organization_id = NEW.organization_id
          AND envelope.scope_type = 'provider-account'
          AND envelope.scope_id = NEW.account_id
      )
    )
  )
  OR (
    NEW.action <> 'remove' AND NOT EXISTS (
      SELECT 1 FROM provider_accounts account
      JOIN secret_envelopes envelope
        ON envelope.organization_id = account.organization_id
       AND envelope.id = account.credential_reference
       AND envelope.scope_type = 'provider-account'
       AND envelope.scope_id = account.id
       AND envelope.revision = NEW.credential_revision
      WHERE account.id = NEW.account_id
        AND account.scope = 'organization'
        AND account.organization_id = NEW.organization_id
        AND account.provider_type = NEW.provider_type
        AND account.revision = NEW.result_revision
        AND account.status = json_extract(NEW.response_json, '$.accountStatus')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'provider account lifecycle transaction fence failed');
END;

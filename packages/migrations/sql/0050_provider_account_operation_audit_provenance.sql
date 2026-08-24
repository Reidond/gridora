PRAGMA foreign_keys = ON;

-- Historical provider-account idempotency rows predate the strict v1 audit
-- fence. Keep them readable for forensics, but require every new mutation to
-- bind its actor-scoped operation key, terminal operation, and compact audit
-- event together. The columns remain nullable solely for pre-0050 history;
-- the insert trigger below rejects any new row without complete provenance.
ALTER TABLE provider_account_mutation_idempotency ADD COLUMN actor_id TEXT;
ALTER TABLE provider_account_mutation_idempotency ADD COLUMN operation_id TEXT;
ALTER TABLE provider_account_mutation_idempotency ADD COLUMN operation_idempotency_key TEXT;
ALTER TABLE provider_account_mutation_idempotency ADD COLUMN audit_event_id TEXT;

CREATE UNIQUE INDEX provider_account_mutation_operation_once
  ON provider_account_mutation_idempotency(organization_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX provider_account_mutation_audit_once
  ON provider_account_mutation_idempotency(organization_id, audit_event_id)
  WHERE audit_event_id IS NOT NULL;

CREATE TRIGGER provider_account_mutation_v1_provenance_fence
BEFORE INSERT ON provider_account_mutation_idempotency
WHEN
  NEW.actor_id IS NULL
  OR NEW.operation_id IS NULL
  OR NEW.operation_idempotency_key IS NULL
  OR NEW.audit_event_id IS NULL
  OR length(NEW.operation_idempotency_key) <> 64
  OR NEW.operation_idempotency_key GLOB '*[^a-f0-9]*'
  OR NOT EXISTS (
    SELECT 1
    FROM operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.organization_id = NEW.organization_id
      AND operation.type = CASE NEW.action
        WHEN 'create' THEN 'provider-account.create'
        WHEN 'update-credentials' THEN 'provider-account.credentials.update'
      END
      AND operation.resource_type = 'provider_account'
      AND operation.resource_id = NEW.account_id
      AND operation.actor_id = NEW.actor_id
      AND operation.status = 'succeeded'
      AND operation.progress = 100
      AND operation.idempotency_key = NEW.operation_idempotency_key
  )
  OR NOT EXISTS (
    SELECT 1
    FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = NEW.actor_id
      AND audit.action = CASE NEW.action
        WHEN 'create' THEN 'provider.account.create'
        WHEN 'update-credentials' THEN 'provider.account.credentials.update'
      END
      AND audit.target_type = 'provider_account'
      AND audit.target_id = NEW.account_id
      AND audit.result = 'succeeded'
      AND audit.correlation_id = (
        SELECT operation.correlation_id
        FROM operations operation
        WHERE operation.id = NEW.operation_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'provider account mutation requires exact v1 operation and audit provenance');
END;

CREATE TRIGGER provider_account_mutation_v1_provenance_immutable
BEFORE UPDATE OF actor_id, operation_id, operation_idempotency_key, audit_event_id
ON provider_account_mutation_idempotency
WHEN
  NEW.actor_id IS NOT OLD.actor_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.operation_idempotency_key IS NOT OLD.operation_idempotency_key
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
BEGIN
  SELECT RAISE(ABORT, 'provider account mutation audit provenance is immutable');
END;

-- Lifecycle actions were introduced before strict v1 envelopes. Preserve
-- historical rows, but make each new action bind its human actor and scoped
-- operation key to the exact terminal operation and staged compact audit.
ALTER TABLE provider_account_action_idempotency ADD COLUMN actor_id TEXT;
ALTER TABLE provider_account_action_idempotency ADD COLUMN operation_idempotency_key TEXT;

DROP TRIGGER provider_account_action_precondition_fence;
CREATE TRIGGER provider_account_action_precondition_fence
BEFORE INSERT ON provider_account_action_idempotency
WHEN
  NEW.actor_id IS NULL
  OR NEW.operation_idempotency_key IS NULL
  OR length(NEW.operation_idempotency_key) <> 64
  OR NEW.operation_idempotency_key GLOB '*[^a-f0-9]*'
  OR json_extract(NEW.response_json, '$.organizationId') IS NOT NEW.organization_id
  OR json_extract(NEW.response_json, '$.accountId') IS NOT NEW.account_id
  OR json_extract(NEW.response_json, '$.providerType') IS NOT NEW.provider_type
  OR json_extract(NEW.response_json, '$.action') IS NOT NEW.action
  OR json_extract(NEW.response_json, '$.revision') IS NOT NEW.result_revision
  OR json_extract(NEW.response_json, '$.operationId') IS NOT NEW.operation_id
  OR NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.organization_id = NEW.organization_id
      AND operation.type = 'provider-account.' || NEW.action
      AND operation.resource_type = 'provider-account'
      AND operation.resource_id = NEW.account_id
      AND operation.actor_id = NEW.actor_id
      AND operation.idempotency_key = NEW.operation_idempotency_key
      AND (
        (json_extract(NEW.response_json, '$.outcome') IN ('retryable_failure', 'permanent_failure')
          AND operation.status IN ('failed', 'failed_terminal'))
        OR (json_extract(NEW.response_json, '$.outcome') NOT IN ('retryable_failure', 'permanent_failure')
          AND operation.status = 'succeeded')
      )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM audit_events audit
    JOIN operations operation ON operation.id = NEW.operation_id
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'provider-account.' || NEW.action
      AND audit.target_type = 'provider-account'
      AND audit.target_id = NEW.account_id
      AND audit.correlation_id = operation.correlation_id
      AND audit.result = CASE
        WHEN json_extract(NEW.response_json, '$.outcome') IN ('retryable_failure', 'permanent_failure')
          THEN 'failed'
        ELSE 'succeeded'
      END
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
  SELECT RAISE(ABORT, 'provider account lifecycle requires exact v1 operation and audit provenance');
END;

CREATE TRIGGER provider_account_action_v1_provenance_immutable
BEFORE UPDATE OF actor_id, operation_idempotency_key, operation_id, audit_event_id
ON provider_account_action_idempotency
WHEN
  NEW.actor_id IS NOT OLD.actor_id
  OR NEW.operation_idempotency_key IS NOT OLD.operation_idempotency_key
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
BEGIN
  SELECT RAISE(ABORT, 'provider account lifecycle audit provenance is immutable');
END;

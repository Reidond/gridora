PRAGMA foreign_keys = ON;

-- Platform provider receipts predate strict operation provenance. Preserve
-- historical records, but require every new account/allocation mutation to
-- bind its deterministic terminal platform operation and staged v1 audit.
ALTER TABLE platform_provider_mutations ADD COLUMN operation_id TEXT;
ALTER TABLE platform_provider_mutations ADD COLUMN operation_idempotency_key TEXT;
ALTER TABLE platform_allocation_mutations ADD COLUMN operation_id TEXT;
ALTER TABLE platform_allocation_mutations ADD COLUMN operation_idempotency_key TEXT;

CREATE UNIQUE INDEX platform_provider_mutation_operation_once
  ON platform_provider_mutations(operation_id)
  WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX platform_provider_mutation_audit_once
  ON platform_provider_mutations(audit_event_id)
  WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX platform_allocation_mutation_operation_once
  ON platform_allocation_mutations(operation_id)
  WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX platform_allocation_mutation_audit_once
  ON platform_allocation_mutations(audit_event_id)
  WHERE operation_id IS NOT NULL;

DROP TRIGGER platform_provider_mutation_audit_guard;
DROP TRIGGER platform_allocation_mutation_audit_guard;

CREATE TRIGGER platform_provider_mutation_audit_guard
BEFORE INSERT ON platform_provider_mutations
WHEN
  NEW.operation_id IS NULL
  OR NEW.operation_idempotency_key IS NULL
  OR length(NEW.operation_idempotency_key) <> 64
  OR NEW.operation_idempotency_key GLOB '*[^a-f0-9]*'
  OR NOT EXISTS (
    SELECT 1
    FROM platform_operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.scope = 'platform'
      AND operation.type = 'platform.provider-account.' || NEW.action
      AND operation.resource_type = 'provider-account'
      AND operation.resource_id = NEW.account_id
      AND operation.actor_id = NEW.actor_id
      AND operation.status = 'succeeded'
      AND operation.progress = 100
      AND operation.idempotency_key = NEW.operation_idempotency_key
      AND operation.payload_fingerprint = NEW.request_fingerprint
  )
  OR NOT EXISTS (
    SELECT 1
    FROM global_audit_events audit
    JOIN platform_operations operation ON operation.id = NEW.operation_id
    WHERE audit.id = NEW.audit_event_id
      AND audit.scope = 'platform'
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'platform.provider-account.' || NEW.action
      AND audit.target_type = 'provider-account'
      AND audit.target_id = NEW.account_id
      AND audit.result = 'succeeded'
      AND audit.correlation_id = operation.correlation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'platform provider mutation requires exact v1 operation and audit provenance');
END;

CREATE TRIGGER platform_allocation_mutation_audit_guard
BEFORE INSERT ON platform_allocation_mutations
WHEN
  NEW.operation_id IS NULL
  OR NEW.operation_idempotency_key IS NULL
  OR length(NEW.operation_idempotency_key) <> 64
  OR NEW.operation_idempotency_key GLOB '*[^a-f0-9]*'
  OR NOT EXISTS (
    SELECT 1
    FROM platform_operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.scope = 'platform'
      AND operation.type = 'platform.provider-allocation.' || NEW.action
      AND operation.resource_type = 'provider-allocation'
      AND operation.resource_id = 'platform-allocation:' || NEW.organization_id || ':' || NEW.account_id
      AND operation.actor_id = NEW.actor_id
      AND operation.status = 'succeeded'
      AND operation.progress = 100
      AND operation.idempotency_key = NEW.operation_idempotency_key
      AND operation.payload_fingerprint = NEW.request_fingerprint
  )
  OR NOT EXISTS (
    SELECT 1
    FROM global_audit_events audit
    JOIN platform_operations operation ON operation.id = NEW.operation_id
    WHERE audit.id = NEW.audit_event_id
      AND audit.scope = 'platform'
      AND audit.actor_id = NEW.actor_id
      AND audit.action = 'platform.provider-allocation.' || NEW.action
      AND audit.target_type = 'provider-allocation'
      AND audit.target_id = 'platform-allocation:' || NEW.organization_id || ':' || NEW.account_id
      AND audit.result = 'succeeded'
      AND audit.correlation_id = operation.correlation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'platform allocation mutation requires exact v1 operation and audit provenance');
END;

CREATE TRIGGER platform_provider_mutation_v1_provenance_immutable
BEFORE UPDATE OF operation_id, operation_idempotency_key, audit_event_id, actor_id,
  request_fingerprint, action, account_id, idempotency_key
ON platform_provider_mutations
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.operation_idempotency_key IS NOT OLD.operation_idempotency_key
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.action IS NOT OLD.action
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'platform provider mutation audit provenance is immutable');
END;

CREATE TRIGGER platform_allocation_mutation_v1_provenance_immutable
BEFORE UPDATE OF operation_id, operation_idempotency_key, audit_event_id, actor_id,
  request_fingerprint, action, organization_id, account_id, idempotency_key
ON platform_allocation_mutations
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.operation_idempotency_key IS NOT OLD.operation_idempotency_key
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.action IS NOT OLD.action
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'platform allocation mutation audit provenance is immutable');
END;

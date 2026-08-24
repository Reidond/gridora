PRAGMA foreign_keys = ON;

-- A paid provider call cannot participate in a D1 transaction. This durable lease closes the
-- account/envelope rotation window between the pre-call exact read and provider-result commit.
-- Reconciliation must adopt or explicitly resolve the provider resource before releasing a lease.
CREATE TABLE node_provision_execution_leases (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_account_revision INTEGER NOT NULL CHECK (provider_account_revision > 0),
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  envelope_revision INTEGER NOT NULL CHECK (envelope_revision > 0),
  derivation_token_hash TEXT NOT NULL CHECK (
    length(derivation_token_hash) = 64 AND derivation_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  delivered_token_hash TEXT NOT NULL CHECK (
    length(delivered_token_hash) = 64 AND delivered_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  bootstrap_expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_id)
    REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND released_at IS NULL)
    OR (state = 'released' AND released_at IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX node_provision_execution_leases_account
  ON node_provision_execution_leases(provider_account_id, state, organization_id);

CREATE TRIGGER node_provision_execution_lease_insert_fence
BEFORE INSERT ON node_provision_execution_leases
WHEN NEW.state <> 'active'
  OR NEW.released_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM node_provision_acceptances acceptance
    JOIN operations operation
      ON operation.organization_id = acceptance.organization_id
     AND operation.id = acceptance.operation_id
    JOIN nodes node
      ON node.organization_id = acceptance.organization_id
     AND node.id = acceptance.node_id
    JOIN provider_accounts account
      ON account.id = acceptance.provider_account_id
    WHERE acceptance.organization_id = NEW.organization_id
      AND acceptance.operation_id = NEW.operation_id
      AND acceptance.node_id = NEW.node_id
      AND acceptance.provider_account_id = NEW.provider_account_id
      AND acceptance.provider_account_revision = NEW.provider_account_revision
      AND acceptance.provider_type = NEW.provider_type
      AND operation.resource_type = 'node'
      AND operation.resource_id = NEW.node_id
      AND operation.status = 'running'
      AND node.pending_lifecycle_operation_id = NEW.operation_id
      AND node.provider_instance_id IS NULL
      AND node.desired_state = 'provisioning'
      AND node.observed_state = 'unknown'
      AND node.observed_revision = 0
      AND EXISTS (
        SELECT 1 FROM node_bootstrap_token_reservations bootstrap
        WHERE bootstrap.organization_id = NEW.organization_id
          AND bootstrap.operation_id = NEW.operation_id
          AND bootstrap.node_id = NEW.node_id
          AND bootstrap.token_hash = NEW.delivered_token_hash
          AND bootstrap.state = 'materialized'
          AND bootstrap.expires_at = NEW.bootstrap_expires_at
      )
      AND account.provider_type = NEW.provider_type
      AND account.revision = NEW.provider_account_revision
      AND account.status = 'active'
      AND (
        (account.scope = 'platform' AND account.organization_id IS NULL)
        OR (account.scope = 'organization' AND account.organization_id = NEW.organization_id)
      )
      AND (
        account.scope = 'platform'
        OR EXISTS (
          SELECT 1 FROM secret_envelopes envelope
          WHERE envelope.organization_id = NEW.organization_id
            AND envelope.id = account.credential_reference
            AND envelope.scope_type = 'provider-account'
            AND envelope.scope_id = account.id
            AND envelope.revision = NEW.envelope_revision
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'node provision execution lease fence failed');
END;

CREATE TRIGGER node_provision_execution_lease_release_fence
BEFORE UPDATE ON node_provision_execution_leases
WHEN OLD.state <> 'active'
  OR NEW.state <> 'released'
  OR NEW.released_at IS NULL
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.provider_account_revision <> OLD.provider_account_revision
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.envelope_revision <> OLD.envelope_revision
  OR NEW.derivation_token_hash IS NOT OLD.derivation_token_hash
  OR NEW.delivered_token_hash IS NOT OLD.delivered_token_hash
  OR NEW.bootstrap_expires_at IS NOT OLD.bootstrap_expires_at
  OR NEW.acquired_at IS NOT OLD.acquired_at
  OR NOT EXISTS (
    SELECT 1
    FROM operations operation
    JOIN nodes node
      ON node.organization_id = operation.organization_id
     AND node.id = operation.resource_id
    JOIN audit_events audit
      ON audit.organization_id = operation.organization_id
     AND audit.target_type = 'node'
     AND audit.target_id = node.id
     AND audit.correlation_id = operation.correlation_id
     AND audit.created_at = NEW.released_at
    WHERE operation.organization_id = OLD.organization_id
      AND operation.id = OLD.operation_id
      AND operation.resource_type = 'node'
      AND operation.resource_id = OLD.node_id
      AND (
        (
          operation.status = 'waiting_external'
          AND node.provider_instance_id IS NOT NULL
          AND audit.action = 'node.provision.provider-created'
          AND audit.result = 'succeeded'
        )
        OR (
          operation.status = 'failed_terminal'
          AND audit.action = 'node.provision.provider-failed'
          AND audit.result = 'failed'
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'node provision execution lease release is invalid');
END;

-- The VM can boot before the provider create response returns. This operation-bound record makes
-- the delivered token usable before a provider instance ID exists. The first token-authenticated
-- registration binds one provider ID. Provider completion must later return the same ID.
CREATE TABLE node_provision_registration_bindings (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  delivered_token_hash TEXT NOT NULL CHECK (
    length(delivered_token_hash) = 64 AND delivered_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  provider_instance_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('materialized', 'bound', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  bound_at TEXT,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_provision_execution_leases(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (delivered_token_hash),
  UNIQUE (organization_id, node_id),
  CHECK (
    (state = 'materialized' AND provider_instance_id IS NULL AND bound_at IS NULL)
    OR (state = 'bound' AND provider_instance_id IS NOT NULL AND bound_at IS NOT NULL)
    OR state = 'revoked'
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX node_provision_registration_bindings_expiry
  ON node_provision_registration_bindings(state, expires_at, organization_id);

CREATE TRIGGER node_provision_registration_binding_insert_fence
BEFORE INSERT ON node_provision_registration_bindings
WHEN NEW.state <> 'materialized'
  OR NEW.provider_instance_id IS NOT NULL
  OR NEW.bound_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM node_provision_execution_leases lease
    JOIN node_bootstrap_token_reservations bootstrap
      ON bootstrap.organization_id = lease.organization_id
     AND bootstrap.operation_id = lease.operation_id
     AND bootstrap.node_id = lease.node_id
    WHERE lease.organization_id = NEW.organization_id
      AND lease.operation_id = NEW.operation_id
      AND lease.node_id = NEW.node_id
      AND lease.provider_type = NEW.provider_type
      AND lease.delivered_token_hash = NEW.delivered_token_hash
      AND lease.bootstrap_expires_at = NEW.expires_at
      AND lease.state = 'active'
      AND bootstrap.token_hash = NEW.delivered_token_hash
      AND bootstrap.state = 'materialized'
      AND bootstrap.expires_at = NEW.expires_at
  )
BEGIN
  SELECT RAISE(ABORT, 'node provision registration binding fence failed');
END;

CREATE TRIGGER node_provision_registration_binding_update_fence
BEFORE UPDATE ON node_provision_registration_bindings
WHEN OLD.state <> 'materialized'
  OR NEW.state <> 'bound'
  OR NEW.provider_instance_id IS NULL
  OR NEW.bound_at IS NULL
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.delivered_token_hash IS NOT OLD.delivered_token_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.node_id
      AND node.provider_type = NEW.provider_type
      AND node.provider_instance_id = NEW.provider_instance_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM node_registration_tokens registration
    WHERE registration.organization_id = NEW.organization_id
      AND registration.operation_id = NEW.operation_id
      AND registration.node_id = NEW.node_id
      AND registration.provider_instance_id = NEW.provider_instance_id
      AND registration.token_hash = NEW.delivered_token_hash
      AND registration.expires_at = NEW.expires_at
  )
BEGIN
  SELECT RAISE(ABORT, 'node provision registration bind is invalid');
END;

CREATE TRIGGER node_provision_registration_binding_immutable_delete
BEFORE DELETE ON node_provision_registration_bindings
BEGIN
  SELECT RAISE(ABORT, 'node provision registration binding cannot be deleted');
END;

CREATE TRIGGER node_provision_execution_lease_immutable_delete
BEFORE DELETE ON node_provision_execution_leases
BEGIN
  SELECT RAISE(ABORT, 'node provision execution lease cannot be deleted');
END;

-- Metadata/credential rotation and account retirement fail closed while a paid create can be in
-- flight. Platform secret backends must honor the same lease at their own opening boundary.
CREATE TRIGGER provider_account_node_execution_lease_update_guard
BEFORE UPDATE OF revision, status, credential_reference ON provider_accounts
WHEN EXISTS (
  SELECT 1 FROM node_provision_execution_leases lease
  WHERE lease.provider_account_id = OLD.id AND lease.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'provider account has an active node provision execution');
END;

CREATE TRIGGER provider_account_node_execution_lease_delete_guard
BEFORE DELETE ON provider_accounts
WHEN EXISTS (
  SELECT 1 FROM node_provision_execution_leases lease
  WHERE lease.provider_account_id = OLD.id AND lease.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'provider account has an active node provision execution');
END;

CREATE TRIGGER provider_envelope_node_execution_lease_update_guard
BEFORE UPDATE ON secret_envelopes
WHEN EXISTS (
  SELECT 1
  FROM node_provision_execution_leases lease
  JOIN provider_accounts account ON account.id = lease.provider_account_id
  WHERE lease.state = 'active'
    AND account.scope = 'organization'
    AND OLD.organization_id = lease.organization_id
    AND OLD.id = account.credential_reference
    AND OLD.scope_type = 'provider-account'
    AND OLD.scope_id = account.id
    AND OLD.revision = lease.envelope_revision
)
BEGIN
  SELECT RAISE(ABORT, 'provider envelope has an active node provision execution');
END;

CREATE TRIGGER provider_envelope_node_execution_lease_delete_guard
BEFORE DELETE ON secret_envelopes
WHEN EXISTS (
  SELECT 1
  FROM node_provision_execution_leases lease
  JOIN provider_accounts account ON account.id = lease.provider_account_id
  WHERE lease.state = 'active'
    AND account.scope = 'organization'
    AND OLD.organization_id = lease.organization_id
    AND OLD.id = account.credential_reference
    AND OLD.scope_type = 'provider-account'
    AND OLD.scope_id = account.id
    AND OLD.revision = lease.envelope_revision
)
BEGIN
  SELECT RAISE(ABORT, 'provider envelope has an active node provision execution');
END;

PRAGMA foreign_keys = ON;

-- Immutable commercial facts accepted before the provider request is sent. They are intentionally
-- separate from mutable node state so later catalog refreshes cannot rewrite the accepted terms.
CREATE TABLE node_provision_contracts (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  estimated_monthly_minor INTEGER NOT NULL CHECK (estimated_monthly_minor >= 0),
  billing_cadence TEXT NOT NULL CHECK (billing_cadence IN ('hourly', 'monthly', 'contract')),
  contract_months INTEGER NOT NULL CHECK (contract_months > 0),
  non_hourly_commitment_confirmed INTEGER NOT NULL CHECK (non_hourly_commitment_confirmed IN (0, 1)),
  catalog_refreshed_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, operation_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE node_provision_spend_reservations (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  estimated_monthly_minor INTEGER NOT NULL CHECK (estimated_monthly_minor >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  reserved_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, operation_id),
  CHECK ((state = 'active' AND released_at IS NULL) OR (state = 'released' AND released_at IS NOT NULL))
) WITHOUT ROWID, STRICT;

-- This is a pre-provider bootstrap reservation. It cannot use node_registration_tokens because a
-- provider instance ID does not exist yet. Only a deterministic token hash and key version persist.
CREATE TABLE node_bootstrap_token_reservations (
  organization_id TEXT NOT NULL,
  token_record_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'materialized', 'consumed', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, token_record_id),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (token_hash),
  UNIQUE (organization_id, node_id),
  UNIQUE (organization_id, operation_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX node_bootstrap_tokens_state
  ON node_bootstrap_token_reservations(state, expires_at, organization_id);

-- Final commit receipt. This row is inserted last in the atomic batch; its trigger re-reads every
-- mutable admission fact so a stale policy, allocation, catalog, image, usage, or spend snapshot
-- aborts the entire transaction.
CREATE TABLE node_provision_acceptances (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  node_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  workflow_start_record_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  bootstrap_token_record_id TEXT NOT NULL,
  bootstrap_key_version INTEGER NOT NULL CHECK (bootstrap_key_version > 0),
  provider_account_id TEXT NOT NULL,
  provider_account_revision INTEGER NOT NULL CHECK (provider_account_revision > 0),
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  allocation_revision INTEGER NOT NULL CHECK (allocation_revision > 0),
  allocation_max_active_nodes INTEGER NOT NULL CHECK (allocation_max_active_nodes >= 0),
  allocation_monthly_budget_minor INTEGER CHECK (
    allocation_monthly_budget_minor IS NULL OR allocation_monthly_budget_minor >= 0
  ),
  allocation_active_nodes_before INTEGER NOT NULL CHECK (allocation_active_nodes_before >= 0),
  region TEXT NOT NULL,
  plan TEXT NOT NULL,
  catalog_refreshed_at TEXT NOT NULL,
  catalog_valid_until_epoch_ms INTEGER NOT NULL CHECK (catalog_valid_until_epoch_ms > 0),
  image_id TEXT NOT NULL,
  image_version TEXT NOT NULL,
  image_checksum TEXT NOT NULL CHECK (
    length(image_checksum) = 71
      AND image_checksum GLOB 'sha256:*'
      AND substr(image_checksum, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_image_id TEXT NOT NULL,
  placement_mode TEXT NOT NULL CHECK (placement_mode IN ('shared', 'dedicated')),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  active_nodes_before INTEGER NOT NULL CHECK (active_nodes_before >= 0),
  dedicated_nodes_before INTEGER NOT NULL CHECK (dedicated_nodes_before >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  estimated_monthly_minor INTEGER NOT NULL CHECK (estimated_monthly_minor >= 0),
  billing_cadence TEXT NOT NULL CHECK (billing_cadence IN ('hourly', 'monthly', 'contract')),
  contract_months INTEGER NOT NULL CHECK (contract_months > 0),
  committed_monthly_before_minor INTEGER NOT NULL CHECK (committed_monthly_before_minor >= 0),
  projected_committed_monthly_minor INTEGER NOT NULL CHECK (projected_committed_monthly_minor >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id) REFERENCES lifecycle_workflow_starts(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bootstrap_token_record_id)
    REFERENCES node_bootstrap_token_reservations(organization_id, token_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id) REFERENCES outbox(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, node_id),
  UNIQUE (organization_id, operation_id),
  UNIQUE (workflow_start_record_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_provision_acceptance_fence
BEFORE INSERT ON node_provision_acceptances
WHEN
  NEW.projected_committed_monthly_minor <> NEW.committed_monthly_before_minor + NEW.estimated_monthly_minor
  OR NOT EXISTS (
    SELECT 1 FROM organizations organization
    JOIN organization_policies policy ON policy.organization_id = organization.id
    WHERE organization.id = NEW.organization_id
      AND organization.status = 'active'
      AND organization.policy_revision = NEW.policy_revision
      AND policy.revision = NEW.policy_revision
      AND json_extract(policy.policy_json, '$.organizationId') = NEW.organization_id
      AND json_extract(policy.policy_json, '$.revision') = NEW.policy_revision
  )
  OR NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    JOIN provider_allocations allocation
      ON allocation.organization_id = NEW.organization_id
     AND allocation.provider_account_id = account.id
    WHERE account.id = NEW.provider_account_id
      AND account.status = 'active'
      AND account.provider_type = NEW.provider_type
      AND account.revision = NEW.provider_account_revision
      AND (account.scope = 'platform' OR account.organization_id = NEW.organization_id)
      AND allocation.status = 'active'
      AND allocation.revision = NEW.allocation_revision
      AND allocation.max_active_nodes = NEW.allocation_max_active_nodes
      AND allocation.monthly_budget_minor IS NEW.allocation_monthly_budget_minor
      AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_regions_json) WHERE value = NEW.region)
      AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_plans_json) WHERE value = NEW.plan)
  )
  OR NOT EXISTS (
    SELECT 1 FROM provider_catalog catalog
    WHERE catalog.provider_type = NEW.provider_type
      AND catalog.region = NEW.region
      AND catalog.plan = NEW.plan
      AND catalog.currency = NEW.currency
      AND catalog.refreshed_at = NEW.catalog_refreshed_at
      AND COALESCE(catalog.monthly_price_minor, catalog.hourly_price_minor * 730) = NEW.estimated_monthly_minor
      AND json_extract(catalog.metadata_json, '$.schemaVersion') = 1
      AND json_extract(catalog.metadata_json, '$.billingCadence') = NEW.billing_cadence
      AND json_extract(catalog.metadata_json, '$.contractMonths') = NEW.contract_months
      AND json_extract(catalog.metadata_json, '$.validUntilEpochMilliseconds') = NEW.catalog_valid_until_epoch_ms
  )
  OR NOT EXISTS (
    SELECT 1 FROM node_images image
    WHERE image.id = NEW.image_id
      AND image.version = NEW.image_version
      AND image.checksum = NEW.image_checksum
      AND image.status = 'promoted'
      AND json_extract(
        image.provider_mappings_json,
        '$."' || NEW.provider_type || '"."' || NEW.region || '"'
      ) = NEW.provider_image_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.node_id
      AND node.provider_account_id = NEW.provider_account_id
      AND node.provider_type = NEW.provider_type
      AND node.region = NEW.region
      AND node.plan = NEW.plan
      AND node.image_id = NEW.image_id
      AND node.placement_mode = NEW.placement_mode
      AND node.desired_state = 'provisioning'
      AND node.observed_state = 'unknown'
      AND node.desired_revision = 2
      AND node.observed_revision = 0
      AND node.pending_lifecycle_operation_id = NEW.operation_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.organization_id = NEW.organization_id
      AND operation.id = NEW.operation_id
      AND operation.type = 'provision-node'
      AND operation.resource_type = 'node'
      AND operation.resource_id = NEW.node_id
      AND operation.status = 'queued'
      AND operation.idempotency_key = NEW.idempotency_key
  )
  OR NOT EXISTS (
    SELECT 1 FROM lifecycle_workflow_starts start
    WHERE start.organization_id = NEW.organization_id
      AND start.operation_id = NEW.operation_id
      AND start.start_record_id = NEW.workflow_start_record_id
      AND start.state = 'pending'
  )
  OR NOT EXISTS (
    SELECT 1 FROM lifecycle_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.operation_id = NEW.operation_id
      AND reservation.idempotency_key = NEW.idempotency_key
      AND reservation.resource_kind = 'node'
      AND reservation.resource_id = NEW.node_id
      AND json_extract(reservation.command_json, '$.kind') = 'provision-node'
      AND json_extract(reservation.command_json, '$.organizationId') = NEW.organization_id
      AND json_extract(reservation.command_json, '$.resourceId') = NEW.node_id
      AND json_extract(reservation.command_json, '$.expectedDesiredRevision') = 1
      AND json_extract(reservation.reservation_json, '$.previousRevision') = 1
      AND json_extract(reservation.reservation_json, '$.desiredRevision') = 2
  )
  OR NOT EXISTS (
    SELECT 1 FROM node_provision_contracts contract
    WHERE contract.organization_id = NEW.organization_id
      AND contract.node_id = NEW.node_id
      AND contract.operation_id = NEW.operation_id
      AND contract.provider_type = NEW.provider_type
      AND contract.currency = NEW.currency
      AND contract.estimated_monthly_minor = NEW.estimated_monthly_minor
      AND contract.billing_cadence = NEW.billing_cadence
      AND contract.contract_months = NEW.contract_months
      AND contract.catalog_refreshed_at = NEW.catalog_refreshed_at
      AND (
        NEW.provider_type <> 'contabo'
        OR NEW.billing_cadence = 'hourly'
        OR contract.non_hourly_commitment_confirmed = 1
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM node_bootstrap_token_reservations token
    WHERE token.organization_id = NEW.organization_id
      AND token.token_record_id = NEW.bootstrap_token_record_id
      AND token.node_id = NEW.node_id
      AND token.operation_id = NEW.operation_id
      AND token.key_version = NEW.bootstrap_key_version
      AND token.state = 'reserved'
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.actor_id = (SELECT actor_id FROM operations WHERE id = NEW.operation_id)
      AND audit.action = 'node.provision.accepted'
      AND audit.target_type = 'node'
      AND audit.target_id = NEW.node_id
      AND audit.result = 'succeeded'
  )
  OR NOT EXISTS (
    SELECT 1 FROM outbox event
    WHERE event.organization_id = NEW.organization_id
      AND event.id = NEW.outbox_event_id
      AND event.event_type = 'lifecycle.workflow-start.requested'
      AND event.aggregate_type = 'operation'
      AND event.aggregate_id = NEW.operation_id
      AND event.publish_state = 'pending'
      AND json_extract(event.payload_json, '$.operationId') = NEW.operation_id
      AND json_extract(event.payload_json, '$.workflowStartRecordId') = NEW.workflow_start_record_id
      AND json_extract(event.payload_json, '$.action') = 'provision-node'
  )
  OR (SELECT count(*) FROM nodes node
      WHERE node.organization_id = NEW.organization_id
        AND node.desired_state <> 'deleted'
        AND node.observed_state <> 'deleted') <> NEW.active_nodes_before + 1
  OR (SELECT count(*) FROM nodes node
      WHERE node.organization_id = NEW.organization_id
        AND node.placement_mode = 'dedicated'
        AND node.desired_state <> 'deleted'
        AND node.observed_state <> 'deleted') <>
      NEW.dedicated_nodes_before + CASE WHEN NEW.placement_mode = 'dedicated' THEN 1 ELSE 0 END
  OR (SELECT count(*) FROM nodes node
      WHERE node.organization_id = NEW.organization_id
        AND node.provider_account_id = NEW.provider_account_id
        AND node.desired_state <> 'deleted'
        AND node.observed_state <> 'deleted') <> NEW.allocation_active_nodes_before + 1
  OR NEW.allocation_active_nodes_before >= NEW.allocation_max_active_nodes
  OR (
    NEW.allocation_monthly_budget_minor IS NOT NULL
    AND NEW.projected_committed_monthly_minor > NEW.allocation_monthly_budget_minor
  )
  OR COALESCE((
    SELECT sum(reservation.estimated_monthly_minor)
    FROM node_provision_spend_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.state = 'active'
      AND reservation.node_id <> NEW.node_id
      AND reservation.currency = NEW.currency
  ), 0) <> NEW.committed_monthly_before_minor
  OR EXISTS (
    SELECT 1 FROM node_provision_spend_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.state = 'active'
      AND reservation.currency <> NEW.currency
  )
  OR NOT EXISTS (
    SELECT 1 FROM node_provision_spend_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.node_id = NEW.node_id
      AND reservation.operation_id = NEW.operation_id
      AND reservation.currency = NEW.currency
      AND reservation.estimated_monthly_minor = NEW.estimated_monthly_minor
      AND reservation.state = 'active'
  )
  OR json_extract(NEW.receipt_json, '$.organizationId') <> NEW.organization_id
  OR json_extract(NEW.receipt_json, '$.nodeId') <> NEW.node_id
  OR json_extract(NEW.receipt_json, '$.operationId') <> NEW.operation_id
  OR json_extract(NEW.receipt_json, '$.idempotencyKey') <> NEW.idempotency_key
  OR json_extract(NEW.receipt_json, '$.fingerprint') <> NEW.request_fingerprint
  OR json_extract(NEW.receipt_json, '$.providerType') <> NEW.provider_type
  OR json_extract(NEW.receipt_json, '$.workflowStart.id') <> NEW.workflow_start_record_id
BEGIN
  SELECT RAISE(ABORT, 'node provision acceptance fence failed');
END;

CREATE TRIGGER node_provision_contracts_immutable_update
BEFORE UPDATE ON node_provision_contracts
BEGIN SELECT RAISE(ABORT, 'node provision contract is immutable'); END;
CREATE TRIGGER node_provision_contracts_immutable_delete
BEFORE DELETE ON node_provision_contracts
BEGIN SELECT RAISE(ABORT, 'node provision contract is immutable'); END;
CREATE TRIGGER node_provision_acceptances_immutable_update
BEFORE UPDATE ON node_provision_acceptances
BEGIN SELECT RAISE(ABORT, 'node provision acceptance is immutable'); END;
CREATE TRIGGER node_provision_acceptances_immutable_delete
BEFORE DELETE ON node_provision_acceptances
BEGIN SELECT RAISE(ABORT, 'node provision acceptance is immutable'); END;

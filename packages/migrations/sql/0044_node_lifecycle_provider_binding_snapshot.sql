PRAGMA foreign_keys = ON;

-- Rebuild and retirement may reach a paid provider call long after HTTP acceptance.
-- Freeze the exact account/allocation/envelope and provider-instance identity at
-- acceptance; a Workflow must never follow mutable node/provider state later.
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_account_id TEXT;
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_account_scope TEXT CHECK (
  provider_account_scope IS NULL OR provider_account_scope IN ('platform', 'organization')
);
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_account_revision INTEGER CHECK (
  provider_account_revision IS NULL OR provider_account_revision > 0
);
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_allocation_revision INTEGER CHECK (
  provider_allocation_revision IS NULL OR provider_allocation_revision > 0
);
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_credential_reference TEXT;
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_credential_revision INTEGER CHECK (
  provider_credential_revision IS NULL OR provider_credential_revision > 0
);
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_type_snapshot TEXT CHECK (
  provider_type_snapshot IS NULL OR provider_type_snapshot IN ('ovhcloud', 'contabo')
);
ALTER TABLE node_lifecycle_runs ADD COLUMN provider_instance_id_snapshot TEXT;
ALTER TABLE node_lifecycle_runs ADD COLUMN target_provider_image_id TEXT;
ALTER TABLE node_lifecycle_runs ADD COLUMN target_image_version_snapshot TEXT;

-- Historical rows remain readable, but every new destructive acceptance has a
-- complete immutable binding. A custom provider image is required for rebuild:
-- a stock-image cloud-init digest alone is not the secret-free replay input for
-- an agent-safe rebuild, so that path remains rejected before a paid action.
CREATE TRIGGER node_lifecycle_provider_binding_acceptance_guard
BEFORE INSERT ON node_lifecycle_runs
WHEN NEW.action IN ('rebuild-node', 'retire-node')
 AND (
  NEW.provider_account_id IS NULL
  OR NEW.provider_account_scope IS NULL
  OR NEW.provider_account_revision IS NULL
  OR NEW.provider_allocation_revision IS NULL
  OR NEW.provider_credential_reference IS NULL
  OR NEW.provider_credential_revision IS NULL
  OR NEW.provider_type_snapshot IS NULL
  OR NEW.provider_instance_id_snapshot IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM nodes node
    JOIN provider_accounts account ON account.id = node.provider_account_id
    JOIN provider_allocations allocation
      ON allocation.organization_id = node.organization_id
     AND allocation.provider_account_id = account.id
    WHERE node.organization_id = NEW.organization_id
      AND node.id = NEW.node_id
      AND node.provider_account_id = NEW.provider_account_id
      AND node.provider_type = NEW.provider_type_snapshot
      AND node.provider_instance_id = NEW.provider_instance_id_snapshot
      AND account.scope = NEW.provider_account_scope
      AND account.revision = NEW.provider_account_revision
      AND account.credential_reference = NEW.provider_credential_reference
      AND account.provider_type = NEW.provider_type_snapshot
      AND account.status = 'active'
      AND allocation.revision = NEW.provider_allocation_revision
      AND allocation.status = 'active'
      AND (account.scope = 'platform' OR account.organization_id = NEW.organization_id)
      AND (
        (account.scope = 'organization' AND EXISTS (
          SELECT 1 FROM secret_envelopes envelope
          WHERE envelope.organization_id = NEW.organization_id
            AND envelope.id = NEW.provider_credential_reference
            AND envelope.scope_type = 'provider-account'
            AND envelope.scope_id = NEW.provider_account_id
            AND envelope.revision = NEW.provider_credential_revision
        ))
        OR (account.scope = 'platform' AND EXISTS (
          SELECT 1 FROM platform_secret_envelopes envelope
          WHERE envelope.id = NEW.provider_credential_reference
            AND envelope.scope_type = 'provider-account'
            AND envelope.scope_id = NEW.provider_account_id
            AND envelope.revision = NEW.provider_credential_revision
        ))
      )
  )
  OR (
    NEW.action = 'rebuild-node' AND (
      NEW.target_provider_image_id IS NULL
      OR NEW.target_image_version_snapshot IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM node_images image
        JOIN node_image_provider_registrations registration
          ON registration.image_id = image.id
        WHERE image.id = NEW.target_image_id
          AND image.version = NEW.target_image_version_snapshot
          AND image.status = 'promoted'
          AND registration.provider_account_id = NEW.provider_account_id
          AND registration.provider_type = NEW.provider_type_snapshot
          AND registration.region = (
            SELECT region FROM nodes
            WHERE organization_id = NEW.organization_id AND id = NEW.node_id
          )
          AND registration.mode = 'custom-image'
          AND registration.state = 'registered'
          AND registration.provider_image_id = NEW.target_provider_image_id
      )
    )
  )
  OR (
    NEW.action = 'retire-node' AND (
      NEW.target_provider_image_id IS NOT NULL OR NEW.target_image_version_snapshot IS NOT NULL
    )
  )
 )
BEGIN SELECT RAISE(ABORT, 'node lifecycle provider binding snapshot fence failed'); END;

CREATE TRIGGER node_lifecycle_provider_binding_snapshot_immutable
BEFORE UPDATE OF
  provider_account_id,
  provider_account_scope,
  provider_account_revision,
  provider_allocation_revision,
  provider_credential_reference,
  provider_credential_revision,
  provider_type_snapshot,
  provider_instance_id_snapshot,
  target_provider_image_id,
  target_image_version_snapshot
ON node_lifecycle_runs
WHEN NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.provider_account_scope IS NOT OLD.provider_account_scope
  OR NEW.provider_account_revision IS NOT OLD.provider_account_revision
  OR NEW.provider_allocation_revision IS NOT OLD.provider_allocation_revision
  OR NEW.provider_credential_reference IS NOT OLD.provider_credential_reference
  OR NEW.provider_credential_revision IS NOT OLD.provider_credential_revision
  OR NEW.provider_type_snapshot IS NOT OLD.provider_type_snapshot
  OR NEW.provider_instance_id_snapshot IS NOT OLD.provider_instance_id_snapshot
  OR NEW.target_provider_image_id IS NOT OLD.target_provider_image_id
  OR NEW.target_image_version_snapshot IS NOT OLD.target_image_version_snapshot
BEGIN SELECT RAISE(ABORT, 'node lifecycle provider binding snapshot is immutable'); END;

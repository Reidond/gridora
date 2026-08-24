PRAGMA foreign_keys = ON;

-- Version 1 stored a credential reference but not a verifier. Such a row must
-- not remain usable after this migration. New credentials use a SHA-256
-- verifier in automation_identity_credentials and are returned only once.
ALTER TABLE automation_identities
  ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json));
ALTER TABLE automation_identities
  ADD COLUMN expires_at TEXT;
ALTER TABLE automation_identities
  ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0 CHECK (credential_version >= 0);
ALTER TABLE automation_identities
  ADD COLUMN revoked_at TEXT;
ALTER TABLE automation_identities
  ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE automation_identities
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, created_at),
    updated_at = CASE WHEN updated_at = '' THEN created_at ELSE updated_at END,
    revision = revision + 1
WHERE status = 'active';

CREATE TABLE automation_identity_credentials (
  organization_id TEXT NOT NULL,
  automation_identity_id TEXT NOT NULL,
  id TEXT NOT NULL,
  credential_hash TEXT NOT NULL CHECK (
    length(credential_hash) = 64
    AND credential_hash NOT GLOB '*[^0-9a-f]*'
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, automation_identity_id)
    REFERENCES automation_identities(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, automation_identity_id, version)
) WITHOUT ROWID, STRICT;

CREATE UNIQUE INDEX automation_identity_credentials_one_active
  ON automation_identity_credentials(organization_id, automation_identity_id)
  WHERE status = 'active';
CREATE INDEX automation_identity_credentials_lookup
  ON automation_identity_credentials(organization_id, automation_identity_id, id, status);

CREATE TABLE automation_identity_mutations (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'rotate', 'revoke')),
  automation_identity_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  operation_id TEXT NOT NULL UNIQUE,
  audit_event_id TEXT NOT NULL UNIQUE,
  outbox_event_id TEXT NOT NULL UNIQUE,
  secret_delivery TEXT NOT NULL CHECK (secret_delivery IN ('sealed', 'none')),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, automation_identity_id)
    REFERENCES automation_identities(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (outbox_event_id) REFERENCES outbox(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX automation_identity_mutations_identity
  ON automation_identity_mutations(organization_id, automation_identity_id, created_at DESC);

-- Keep the existing public identity selectors immutable. A revoked identity
-- cannot be reactivated because a user must create a new credential instead.
CREATE TRIGGER automation_identity_identity_immutable
BEFORE UPDATE ON automation_identities
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.id IS NOT OLD.id
  OR NEW.client_id IS NOT OLD.client_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status = 'revoked' AND NEW.status <> 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'automation identity immutable field changed');
END;

-- Only active organization Owners and Administrators can create a usable
-- automation identity. The auth path repeats these status checks at request time.
CREATE TRIGGER automation_identity_active_insert_guard
BEFORE INSERT ON automation_identities
WHEN NEW.status = 'active' AND (
  NEW.credential_version <> 1
  OR NEW.expires_at IS NULL
  OR NEW.updated_at = ''
  OR json_type(NEW.scopes_json) <> 'array'
  OR json_array_length(NEW.scopes_json) < 1
  OR json_array_length(NEW.scopes_json) > 8
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.scopes_json)
    WHERE type <> 'text' OR value NOT IN (
      'inventory.read', 'servers.read', 'servers.manage', 'nodes.read',
      'backups.read', 'backups.manage', 'logs.read', 'operations.read'
    )
  )
  OR (SELECT COUNT(*) FROM json_each(NEW.scopes_json)) <>
     (SELECT COUNT(DISTINCT value) FROM json_each(NEW.scopes_json))
  OR NOT EXISTS (
    SELECT 1
    FROM organizations organization
    JOIN identities actor ON actor.id = NEW.created_by
    JOIN organization_memberships membership
      ON membership.organization_id = organization.id AND membership.identity_id = actor.id
    WHERE organization.id = NEW.organization_id
      AND organization.status = 'active'
      AND actor.status = 'active'
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'administrator')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'automation identity active insert fence failed');
END;

CREATE TRIGGER automation_identity_active_update_guard
BEFORE UPDATE OF status, scopes_json, expires_at, credential_version, credential_reference, updated_at
ON automation_identities
WHEN NEW.status = 'active' AND (
  NEW.credential_version < 1
  OR NEW.expires_at IS NULL
  OR NEW.updated_at = ''
  OR json_type(NEW.scopes_json) <> 'array'
  OR json_array_length(NEW.scopes_json) < 1
  OR json_array_length(NEW.scopes_json) > 8
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.scopes_json)
    WHERE type <> 'text' OR value NOT IN (
      'inventory.read', 'servers.read', 'servers.manage', 'nodes.read',
      'backups.read', 'backups.manage', 'logs.read', 'operations.read'
    )
  )
  OR (SELECT COUNT(*) FROM json_each(NEW.scopes_json)) <>
     (SELECT COUNT(DISTINCT value) FROM json_each(NEW.scopes_json))
)
BEGIN
  SELECT RAISE(ABORT, 'automation identity active update fence failed');
END;

CREATE TRIGGER automation_identity_credential_insert_guard
BEFORE INSERT ON automation_identity_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM automation_identities identity
  WHERE identity.organization_id = NEW.organization_id
    AND identity.id = NEW.automation_identity_id
    AND identity.credential_reference = NEW.id
    AND identity.credential_version = NEW.version
    AND identity.status = 'active'
    AND identity.expires_at = NEW.expires_at
)
OR NEW.status <> 'active'
OR NEW.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'automation credential identity fence failed');
END;

CREATE TRIGGER automation_identity_credential_immutable
BEFORE UPDATE ON automation_identity_credentials
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.automation_identity_id IS NOT OLD.automation_identity_id
  OR NEW.id IS NOT OLD.id
  OR NEW.credential_hash IS NOT OLD.credential_hash
  OR NEW.version IS NOT OLD.version
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.status = 'revoked' AND NEW.status <> 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'automation credential immutable field changed');
END;

-- Identity revocation is authoritative. A direct or API revocation immediately
-- disables every active verifier in the same D1 transaction.
CREATE TRIGGER automation_identity_revoke_credentials
AFTER UPDATE OF status ON automation_identities
WHEN OLD.status = 'active' AND NEW.status = 'revoked'
BEGIN
  UPDATE automation_identity_credentials
  SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, NEW.revoked_at),
      revision = revision + 1
  WHERE organization_id = NEW.organization_id
    AND automation_identity_id = NEW.id
    AND status = 'active';
END;

-- Removing or suspending the human membership that created an automation
-- identity revokes it immediately. This is a defense in depth rule; runtime
-- authentication also verifies organization and identity state every request.
CREATE TRIGGER automation_identity_creator_membership_suspended
AFTER UPDATE OF status ON organization_memberships
WHEN OLD.status = 'active' AND NEW.status <> 'active'
BEGIN
  UPDATE automation_identities
  SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      revision = revision + 1
  WHERE organization_id = NEW.organization_id
    AND created_by = NEW.identity_id
    AND status = 'active';
END;

CREATE TRIGGER automation_identity_creator_membership_removed
AFTER DELETE ON organization_memberships
BEGIN
  UPDATE automation_identities
  SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      revision = revision + 1
  WHERE organization_id = OLD.organization_id
    AND created_by = OLD.identity_id
    AND status = 'active';
END;

-- Idempotency records are written last in the same D1 transaction. They bind
-- the exact redacted response and all audit/outbox/operation evidence. A raw
-- credential or verifier cannot be put in a replay response.
CREATE TRIGGER automation_identity_mutation_fence
BEFORE INSERT ON automation_identity_mutations
WHEN json_extract(NEW.response_json, '$.organizationId') IS NOT NEW.organization_id
  OR json_extract(NEW.response_json, '$.id') IS NOT NEW.automation_identity_id
  OR json_extract(NEW.response_json, '$.revision') IS NOT NEW.result_revision
  OR json_type(NEW.response_json, '$.credential') IS NOT NULL
  OR json_type(NEW.response_json, '$.credentialHash') IS NOT NULL
  OR json_type(NEW.response_json, '$.credentialReference') IS NOT NULL
  OR (NEW.action IN ('create', 'rotate') AND NEW.secret_delivery <> 'sealed')
  OR (NEW.action = 'revoke' AND NEW.secret_delivery <> 'none')
  OR NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.organization_id = NEW.organization_id
      AND operation.resource_type = 'automation-identity'
      AND operation.resource_id = NEW.automation_identity_id
      AND operation.idempotency_key = NEW.idempotency_key
      AND operation.status = 'succeeded'
      AND operation.progress = 100
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.target_type = 'automation-identity'
      AND audit.target_id = NEW.automation_identity_id
      AND audit.action = 'automation-identity.' || NEW.action
      AND audit.result = 'succeeded'
  )
  OR NOT EXISTS (
    SELECT 1 FROM outbox event
    WHERE event.id = NEW.outbox_event_id
      AND event.organization_id = NEW.organization_id
      AND event.aggregate_type = 'automation-identity'
      AND event.aggregate_id = NEW.automation_identity_id
      AND event.event_type = 'automation-identity.' || NEW.action
  )
BEGIN
  SELECT RAISE(ABORT, 'automation identity mutation fence failed');
END;

-- Fixed windows are intentionally limited to active known selectors and one
-- shared unknown selector. Old windows are pruned on every authentication.
CREATE TABLE automation_identity_rate_windows (
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 7 AND 180),
  window_started_epoch_ms INTEGER NOT NULL CHECK (window_started_epoch_ms >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 0 AND request_count <= 1000),
  PRIMARY KEY (subject, window_started_epoch_ms)
) WITHOUT ROWID, STRICT;

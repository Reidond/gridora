PRAGMA foreign_keys = ON;

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL,
  access_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  signed_up_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
) STRICT;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting', 'deleted')),
  timezone TEXT NOT NULL,
  default_region TEXT NOT NULL,
  onboarding_step TEXT NOT NULL DEFAULT 'organization' CHECK (onboarding_step IN ('organization', 'provider', 'team', 'deployment', 'complete')),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE (id, slug)
) STRICT;

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'operator', 'viewer', 'automation')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  joined_at TEXT NOT NULL,
  invited_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id, identity_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (invited_by) REFERENCES identities(id) ON DELETE SET NULL
) WITHOUT ROWID, STRICT;

CREATE INDEX organization_memberships_identity ON organization_memberships(identity_id, status);
CREATE INDEX organization_memberships_owner ON organization_memberships(organization_id, role, status);

CREATE TABLE organization_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'operator', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  accepted_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (inviter_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (accepted_by) REFERENCES identities(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX organization_invitations_pending_email
  ON organization_invitations(organization_id, email)
  WHERE status = 'pending';
CREATE INDEX organization_invitations_expiry ON organization_invitations(status, expires_at);

CREATE TABLE organization_onboarding (
  organization_id TEXT PRIMARY KEY NOT NULL,
  current_step TEXT NOT NULL,
  completed_steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_steps_json)),
  completed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE organization_creation_idempotency (
  identity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (identity_id, idempotency_key),
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TABLE invitation_creation_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, invitation_id) REFERENCES organization_invitations(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

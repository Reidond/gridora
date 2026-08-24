PRAGMA foreign_keys = ON;

CREATE TABLE operations (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'queued', 'running', 'waiting_external', 'cancelling', 'cancelled', 'succeeded', 'failed', 'retrying', 'failed_terminal')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
) STRICT;

CREATE INDEX operations_resource ON operations(organization_id, resource_type, resource_id, created_at DESC);
CREATE INDEX operations_status ON operations(organization_id, status, updated_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'denied', 'failed')),
  correlation_id TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX audit_events_timeline ON audit_events(organization_id, created_at DESC);

-- Authentication happens before an organization exists. Keep those records in
-- an explicit platform scope instead of inventing a tenant organization.
CREATE TABLE global_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'platform'),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'denied', 'failed')),
  correlation_id TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX global_audit_events_timeline ON global_audit_events(created_at DESC);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  publish_state TEXT NOT NULL DEFAULT 'pending' CHECK (publish_state IN ('pending', 'publishing', 'delivered', 'failed', 'failed_terminal')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, id),
  CHECK (
    (publish_state = 'publishing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR publish_state <> 'publishing'
  )
) STRICT;

CREATE INDEX outbox_delivery ON outbox(publish_state, available_at, created_at);
CREATE UNIQUE INDEX outbox_invitation_accept_once
  ON outbox(organization_id, event_type, aggregate_id)
  WHERE event_type = 'organization.invitation.accepted';

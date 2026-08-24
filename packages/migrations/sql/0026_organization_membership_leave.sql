PRAGMA foreign_keys = ON;

-- A self-leave request is represented by one immutable receipt. The receipt
-- trigger performs membership removal, outbox creation, and audit creation in
-- the same SQLite transaction. A failed assertion aborts the complete write.
CREATE TABLE organization_membership_leave_receipts (
  organization_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  membership_revision INTEGER NOT NULL CHECK (membership_revision > 0),
  membership_role TEXT NOT NULL CHECK (membership_role IN ('owner', 'administrator', 'operator', 'viewer')),
  correlation_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL UNIQUE,
  left_at TEXT NOT NULL CHECK (julianday(left_at) IS NOT NULL),
  PRIMARY KEY (organization_id, identity_id, membership_revision),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER organization_membership_leave_receipt_immutable_update
BEFORE UPDATE ON organization_membership_leave_receipts
BEGIN
  SELECT RAISE(ABORT, 'organization membership leave receipt is immutable');
END;

CREATE TRIGGER organization_membership_leave_receipt_immutable_delete
BEFORE DELETE ON organization_membership_leave_receipts
BEGIN
  SELECT RAISE(ABORT, 'organization membership leave receipt is immutable');
END;

CREATE TRIGGER organization_membership_leave_apply
AFTER INSERT ON organization_membership_leave_receipts
BEGIN
  DELETE FROM organization_memberships
  WHERE organization_id = NEW.organization_id
    AND identity_id = NEW.identity_id
    AND revision = NEW.membership_revision
    AND role = NEW.membership_role
    AND status = 'active'
    AND (
      role <> 'owner'
      OR (
        SELECT COUNT(*)
        FROM organization_memberships
        WHERE organization_id = NEW.organization_id
          AND role = 'owner'
          AND status = 'active'
      ) > 1
    );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE organization_id = NEW.organization_id
      AND identity_id = NEW.identity_id
  ) THEN RAISE(ABORT, 'organization membership leave fence failed') END;

  INSERT INTO outbox
    (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
     publish_state, retry_count, available_at, created_at)
  VALUES (
    NEW.outbox_event_id,
    NEW.organization_id,
    'organization.membership.left',
    'organization_membership',
    NEW.identity_id,
    json_object('principalId', NEW.identity_id, 'role', NEW.membership_role),
    'pending',
    0,
    NEW.left_at,
    NEW.left_at
  );

  INSERT INTO audit_events
    (id, organization_id, actor_id, action, target_type, target_id, result,
     correlation_id, summary_json, created_at)
  VALUES (
    'audit-' || NEW.outbox_event_id,
    NEW.organization_id,
    NEW.identity_id,
    'organization.membership.leave',
    'organization_membership',
    NEW.identity_id,
    'succeeded',
    NEW.correlation_id,
    json_object(
      'identityId', NEW.identity_id,
      'beforeRole', NEW.membership_role,
      'afterMembership', NULL
    ),
    NEW.left_at
  );

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM outbox
    WHERE id = NEW.outbox_event_id
      AND organization_id = NEW.organization_id
      AND aggregate_id = NEW.identity_id
      AND event_type = 'organization.membership.left'
  ) OR NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE id = 'audit-' || NEW.outbox_event_id
      AND organization_id = NEW.organization_id
      AND actor_id = NEW.identity_id
      AND target_id = NEW.identity_id
      AND action = 'organization.membership.leave'
      AND result = 'succeeded'
  ) THEN RAISE(ABORT, 'organization membership leave evidence fence failed') END;
END;

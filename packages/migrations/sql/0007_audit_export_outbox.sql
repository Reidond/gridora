PRAGMA foreign_keys = ON;

-- The strict Queue contract requires an object summary. Existing rows are
-- validated without copying their contents into an error or another table.
CREATE TABLE IF NOT EXISTS audit_export_migration_guard (
  valid INTEGER NOT NULL
    CONSTRAINT audit_export_summary_policy CHECK (valid = 1)
) STRICT;

DELETE FROM audit_export_migration_guard;

INSERT INTO audit_export_migration_guard (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1 FROM audit_events WHERE json_type(summary_json) IS NOT 'object'
)
OR EXISTS (
  SELECT 1
  FROM audit_events AS audit, json_tree(audit.summary_json) AS entry
  WHERE typeof(entry.key) = 'text'
    AND (
      length(CAST(entry.key AS TEXT)) NOT BETWEEN 1 AND 128
      OR CAST(entry.key AS TEXT) GLOB '*[^A-Za-z0-9_-]*'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE 'authorization%'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE 'setcookie%'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) IN ('cookie', 'cookies', 'bearer')
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*password'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*passwd'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*secret'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*token'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*apikey'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*credential'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*credentials'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*privatekey'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*plaintextkey'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*datakey'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*wrappedkey'
      OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*rconpassword'
    )
);

DROP TABLE audit_export_migration_guard;

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_tenant_identity
ON audit_events(organization_id, id);

-- D1/SQLite has no supported cryptographic digest function. This durable
-- sequence gives every arbitrary audit ID a stable, path-safe outbox identity
-- without truncation or lossy character replacement.
CREATE TABLE IF NOT EXISTS audit_export_requests (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE,
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, audit_event_id)
    REFERENCES audit_events(organization_id, id) ON DELETE RESTRICT
) STRICT;

-- The durable request mapping is an immutable deduplication ledger. Preventing
-- deletion/update keeps an audit row bound to the same reserved outbox identity
-- even after delivery retries or migration re-entry.
CREATE TRIGGER IF NOT EXISTS audit_export_requests_immutable_update
BEFORE UPDATE ON audit_export_requests
BEGIN
  SELECT RAISE(ABORT, 'audit export request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_export_requests_immutable_delete
BEFORE DELETE ON audit_export_requests
BEGIN
  SELECT RAISE(ABORT, 'audit export request identity is immutable');
END;

-- On the first application the ledger is empty, so any pre-existing use of the
-- reserved namespace fails closed. On re-entry, only the exact row previously
-- derived from the immutable request and authoritative audit row is adopted.
CREATE TABLE IF NOT EXISTS audit_export_namespace_guard (
  valid INTEGER NOT NULL
    CONSTRAINT audit_export_namespace_policy CHECK (valid = 1)
) STRICT;

DELETE FROM audit_export_namespace_guard;

INSERT INTO audit_export_namespace_guard (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM outbox AS existing
  WHERE (
    existing.event_type = 'audit.export.requested'
    OR existing.aggregate_type = 'audit_event'
    OR (
      length(existing.id) = 33
      AND substr(existing.id, 1, 13) = 'audit-export-'
      AND substr(existing.id, 14) NOT GLOB '*[^0-9]*'
    )
    OR (
      length(existing.aggregate_id) = 32
      AND substr(existing.aggregate_id, 1, 12) = 'audit-event-'
      AND substr(existing.aggregate_id, 13) NOT GLOB '*[^0-9]*'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM audit_export_requests AS request
    JOIN audit_events AS audit
      ON audit.organization_id = request.organization_id
     AND audit.id = request.audit_event_id
    WHERE existing.id = printf('audit-export-%020d', request.sequence_id)
      AND existing.organization_id = request.organization_id
      AND existing.event_type = 'audit.export.requested'
      AND existing.aggregate_type = 'audit_event'
      AND existing.aggregate_id = printf('audit-event-%020d', request.sequence_id)
      AND existing.created_at = audit.created_at
      AND json_type(existing.payload_json) = 'object'
      AND (SELECT count(*) FROM json_each(existing.payload_json)) = 12
      AND json_extract(existing.payload_json, '$.id') = audit.id
      AND json_extract(existing.payload_json, '$.organizationId') = audit.organization_id
      AND json_extract(existing.payload_json, '$.partitionKey') = audit.organization_id || ':audit'
      AND json_extract(existing.payload_json, '$.exportRequestId') = existing.id
      AND json_extract(existing.payload_json, '$.actorId') = audit.actor_id
      AND json_extract(existing.payload_json, '$.action') = audit.action
      AND json_extract(existing.payload_json, '$.targetType') = audit.target_type
      AND json_extract(existing.payload_json, '$.targetId') = audit.target_id
      AND json_extract(existing.payload_json, '$.result') = audit.result
      AND json_extract(existing.payload_json, '$.correlationId') = audit.correlation_id
      AND json_extract(existing.payload_json, '$.summary') = json(audit.summary_json)
      AND json_extract(existing.payload_json, '$.createdAt') = audit.created_at
  )
);

DROP TABLE audit_export_namespace_guard;

-- Reserve the deterministic audit-export ID namespace. A pre-existing
-- collision fails the migration/backfill atomically; future non-audit writes
-- cannot claim it.
CREATE TRIGGER IF NOT EXISTS outbox_audit_export_namespace_guard
BEFORE INSERT ON outbox
WHEN (
  NEW.event_type = 'audit.export.requested'
  OR NEW.aggregate_type = 'audit_event'
  OR (
    length(NEW.id) = 33
    AND substr(NEW.id, 1, 13) = 'audit-export-'
    AND substr(NEW.id, 14) NOT GLOB '*[^0-9]*'
  )
  OR (
    length(NEW.aggregate_id) = 32
    AND substr(NEW.aggregate_id, 1, 12) = 'audit-event-'
    AND substr(NEW.aggregate_id, 13) NOT GLOB '*[^0-9]*'
  )
)
AND NOT EXISTS (
  SELECT 1
  FROM audit_export_requests AS request
  JOIN audit_events AS audit
    ON audit.organization_id = request.organization_id
   AND audit.id = request.audit_event_id
  WHERE NEW.id = printf('audit-export-%020d', request.sequence_id)
    AND NEW.organization_id = request.organization_id
    AND NEW.event_type = 'audit.export.requested'
    AND NEW.aggregate_type = 'audit_event'
    AND NEW.aggregate_id = printf('audit-event-%020d', request.sequence_id)
    AND NEW.publish_state = 'pending'
    AND NEW.retry_count = 0
    AND NEW.lease_owner IS NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_until IS NULL
    AND NEW.created_at = audit.created_at
    AND NEW.available_at = audit.created_at
    AND json_type(NEW.payload_json) = 'object'
    AND (SELECT count(*) FROM json_each(NEW.payload_json)) = 12
    AND json_extract(NEW.payload_json, '$.id') = audit.id
    AND json_extract(NEW.payload_json, '$.organizationId') = audit.organization_id
    AND json_extract(NEW.payload_json, '$.partitionKey') = audit.organization_id || ':audit'
    AND json_extract(NEW.payload_json, '$.exportRequestId') = NEW.id
    AND json_extract(NEW.payload_json, '$.actorId') = audit.actor_id
    AND json_extract(NEW.payload_json, '$.action') = audit.action
    AND json_extract(NEW.payload_json, '$.targetType') = audit.target_type
    AND json_extract(NEW.payload_json, '$.targetId') = audit.target_id
    AND json_extract(NEW.payload_json, '$.result') = audit.result
    AND json_extract(NEW.payload_json, '$.correlationId') = audit.correlation_id
    AND json_extract(NEW.payload_json, '$.summary') = json(audit.summary_json)
    AND json_extract(NEW.payload_json, '$.createdAt') = audit.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'audit export outbox identity is invalid');
END;

CREATE TRIGGER IF NOT EXISTS outbox_audit_export_identity_immutable
BEFORE UPDATE ON outbox
WHEN (
  OLD.event_type = 'audit.export.requested'
  OR OLD.aggregate_type = 'audit_event'
  OR NEW.event_type = 'audit.export.requested'
  OR NEW.aggregate_type = 'audit_event'
  OR (length(OLD.id) = 33 AND substr(OLD.id, 1, 13) = 'audit-export-' AND substr(OLD.id, 14) NOT GLOB '*[^0-9]*')
  OR (length(NEW.id) = 33 AND substr(NEW.id, 1, 13) = 'audit-export-' AND substr(NEW.id, 14) NOT GLOB '*[^0-9]*')
  OR (length(OLD.aggregate_id) = 32 AND substr(OLD.aggregate_id, 1, 12) = 'audit-event-' AND substr(OLD.aggregate_id, 13) NOT GLOB '*[^0-9]*')
  OR (length(NEW.aggregate_id) = 32 AND substr(NEW.aggregate_id, 1, 12) = 'audit-event-' AND substr(NEW.aggregate_id, 13) NOT GLOB '*[^0-9]*')
)
AND (
  NEW.id IS NOT OLD.id
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.aggregate_type IS NOT OLD.aggregate_type
  OR NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'audit export outbox identity is immutable');
END;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_audit_export_once
ON outbox(organization_id, event_type, aggregate_type, aggregate_id)
WHERE event_type = 'audit.export.requested' AND aggregate_type = 'audit_event';

CREATE TRIGGER IF NOT EXISTS audit_events_export_summary_guard
BEFORE INSERT ON audit_events
WHEN json_type(NEW.summary_json) IS NOT 'object'
  OR EXISTS (
    SELECT 1
    FROM json_tree(NEW.summary_json) AS entry
    WHERE typeof(entry.key) = 'text'
      AND (
        length(CAST(entry.key AS TEXT)) NOT BETWEEN 1 AND 128
        OR CAST(entry.key AS TEXT) GLOB '*[^A-Za-z0-9_-]*'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE 'authorization%'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE 'setcookie%'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) IN ('cookie', 'cookies', 'bearer')
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*password'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*passwd'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*secret'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*token'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*apikey'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*credential'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*credentials'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*privatekey'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*plaintextkey'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*datakey'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*wrappedkey'
        OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) GLOB '*rconpassword'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'audit summary violates export policy');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_export_immutable_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit event is immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_export_immutable_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit event is immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_enqueue_export
AFTER INSERT ON audit_events
BEGIN
  INSERT INTO audit_export_requests (organization_id, audit_event_id)
  VALUES (NEW.organization_id, NEW.id);

  INSERT INTO outbox
    (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
     publish_state, retry_count, available_at, created_at)
  SELECT
    printf('audit-export-%020d', sequence_id),
    NEW.organization_id,
    'audit.export.requested',
    'audit_event',
    printf('audit-event-%020d', sequence_id),
    json_object(
      'id', NEW.id,
      'organizationId', NEW.organization_id,
      'partitionKey', NEW.organization_id || ':audit',
      'exportRequestId', printf('audit-export-%020d', sequence_id),
      'actorId', NEW.actor_id,
      'action', NEW.action,
      'targetType', NEW.target_type,
      'targetId', NEW.target_id,
      'result', NEW.result,
      'correlationId', NEW.correlation_id,
      'summary', json(NEW.summary_json),
      'createdAt', NEW.created_at
    ),
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM audit_export_requests
  WHERE organization_id = NEW.organization_id AND audit_event_id = NEW.id;
END;

-- Stable, repeatable backfill for rows created before the trigger. Ordering
-- makes sequence assignment deterministic for this database snapshot.
INSERT INTO audit_export_requests (organization_id, audit_event_id)
SELECT audit.organization_id, audit.id
FROM audit_events AS audit
WHERE NOT EXISTS (
  SELECT 1
  FROM audit_export_requests AS request
  WHERE request.organization_id = audit.organization_id
    AND request.audit_event_id = audit.id
)
ORDER BY audit.created_at, audit.id;

INSERT INTO outbox
  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
   publish_state, retry_count, available_at, created_at)
SELECT
  printf('audit-export-%020d', request.sequence_id),
  audit.organization_id,
  'audit.export.requested',
  'audit_event',
  printf('audit-event-%020d', request.sequence_id),
  json_object(
    'id', audit.id,
    'organizationId', audit.organization_id,
    'partitionKey', audit.organization_id || ':audit',
    'exportRequestId', printf('audit-export-%020d', request.sequence_id),
    'actorId', audit.actor_id,
    'action', audit.action,
    'targetType', audit.target_type,
    'targetId', audit.target_id,
    'result', audit.result,
    'correlationId', audit.correlation_id,
    'summary', json(audit.summary_json),
    'createdAt', audit.created_at
  ),
  'pending',
  0,
  audit.created_at,
  audit.created_at
FROM audit_export_requests AS request
JOIN audit_events AS audit
  ON audit.organization_id = request.organization_id
 AND audit.id = request.audit_event_id
WHERE NOT EXISTS (
  SELECT 1
  FROM outbox AS existing
  WHERE existing.organization_id = request.organization_id
    AND existing.event_type = 'audit.export.requested'
    AND existing.aggregate_type = 'audit_event'
    AND existing.aggregate_id = printf('audit-event-%020d', request.sequence_id)
)
ORDER BY request.sequence_id;

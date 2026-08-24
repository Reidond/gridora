PRAGMA foreign_keys = ON;

-- Audit rows from the first pre-alpha iterations only contained a compact summary.
-- Keep a separate immutable envelope ledger so historical facts remain intact while
-- new writes use a complete, versioned evidence shape. A platform event never gets
-- a synthetic organization ID.
CREATE TABLE audit_event_envelopes (
  event_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('tenant', 'platform')),
  organization_id TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (0, 1)),
  capture_status TEXT NOT NULL CHECK (capture_status IN ('legacy', 'complete')),
  envelope_json TEXT NOT NULL CHECK (
    json_valid(envelope_json)
    AND json_type(envelope_json) = 'object'
    AND length(CAST(envelope_json AS BLOB)) <= 81920
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (scope = 'tenant' AND organization_id IS NOT NULL)
    OR (scope = 'platform' AND organization_id IS NULL)
  ),
  CHECK (
    (schema_version = 0 AND capture_status = 'legacy')
    OR (schema_version = 1 AND capture_status = 'complete')
  ),
  PRIMARY KEY (scope, event_id)
) STRICT;

CREATE INDEX audit_event_envelopes_tenant_timeline
  ON audit_event_envelopes(organization_id, created_at DESC, event_id)
  WHERE scope = 'tenant';
CREATE INDEX audit_event_envelopes_platform_timeline
  ON audit_event_envelopes(created_at DESC, event_id)
  WHERE scope = 'platform';

-- Platform actions need the same durable operation reference as tenant actions,
-- but cannot use the tenant-only `operations` table or invent an organization.
CREATE TABLE platform_operations (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'platform'),
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'queued', 'running', 'waiting_external', 'cancelling',
    'cancelled', 'succeeded', 'denied', 'failed', 'retrying', 'failed_terminal'
  )),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  idempotency_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (
    length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, idempotency_key),
  FOREIGN KEY (actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX platform_operations_timeline
  ON platform_operations(created_at DESC, id);

CREATE TRIGGER platform_operations_idempotency_conflict
BEFORE INSERT ON platform_operations
WHEN EXISTS (
  SELECT 1 FROM platform_operations existing
  WHERE existing.scope = NEW.scope
    AND existing.idempotency_key = NEW.idempotency_key
    AND existing.payload_fingerprint IS NOT NEW.payload_fingerprint
)
BEGIN
  SELECT RAISE(ABORT, 'platform operation idempotency payload conflict');
END;

CREATE TRIGGER platform_operations_identity_immutable_update
BEFORE UPDATE ON platform_operations
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.type IS NOT OLD.type
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.correlation_id IS NOT OLD.correlation_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.payload_fingerprint IS NOT OLD.payload_fingerprint
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'platform operation identity or revision is immutable');
END;

CREATE TRIGGER platform_operations_immutable_delete
BEFORE DELETE ON platform_operations
BEGIN
  SELECT RAISE(ABORT, 'platform operation is immutable');
END;

-- Non-human actor identifiers can differ from the legacy identity foreign key
-- used by operations and compact audit rows. This immutable registry keeps the
-- actor kind truthful without inventing an organization for platform actors.
CREATE TABLE audit_actor_bindings (
  scope TEXT NOT NULL CHECK (scope IN ('tenant', 'platform')),
  scope_key TEXT NOT NULL,
  organization_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'automation', 'machine', 'system', 'platform')),
  actor_id TEXT NOT NULL,
  operation_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_key, actor_type, actor_id),
  CHECK (
    (scope = 'tenant' AND organization_id IS NOT NULL AND scope_key = organization_id)
    OR (scope = 'platform' AND organization_id IS NULL AND scope_key = 'platform')
  ),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_actor_id) REFERENCES identities(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER audit_actor_bindings_valid
BEFORE INSERT ON audit_actor_bindings
WHEN
  (NEW.actor_type = 'human' AND NOT EXISTS (
    SELECT 1 FROM identities identity WHERE identity.id = NEW.actor_id AND identity.id = NEW.operation_actor_id
  ))
  OR (NEW.actor_type = 'automation' AND NOT EXISTS (
    SELECT 1 FROM automation_identities automation
    WHERE NEW.scope = 'tenant'
      AND automation.organization_id = NEW.organization_id
      AND automation.id = NEW.actor_id
      AND automation.created_by = NEW.operation_actor_id
  ))
  OR (NEW.actor_type = 'machine' AND NOT EXISTS (
    SELECT 1 FROM identities identity
    WHERE identity.id = NEW.actor_id
      AND identity.id = NEW.operation_actor_id
      AND identity.access_subject LIKE 'gridora-machine:%'
  ))
  OR (NEW.actor_type = 'system' AND NOT EXISTS (
    SELECT 1 FROM identities identity
    WHERE identity.id = NEW.operation_actor_id
      AND identity.access_subject LIKE 'system:%'
  ))
  OR (NEW.actor_type = 'platform' AND NOT EXISTS (
    SELECT 1 FROM platform_administrators administrator
    WHERE NEW.scope = 'platform'
      AND administrator.identity_id = NEW.actor_id
      AND administrator.identity_id = NEW.operation_actor_id
      AND administrator.status = 'active'
  ))
BEGIN
  SELECT RAISE(ABORT, 'audit actor binding is invalid');
END;

CREATE TRIGGER audit_actor_bindings_immutable_update
BEFORE UPDATE ON audit_actor_bindings
BEGIN
  SELECT RAISE(ABORT, 'audit actor binding is immutable');
END;

CREATE TRIGGER audit_actor_bindings_immutable_delete
BEFORE DELETE ON audit_actor_bindings
BEGIN
  SELECT RAISE(ABORT, 'audit actor binding is immutable');
END;

INSERT OR IGNORE INTO audit_actor_bindings
  (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
SELECT
  'tenant', scheduler.organization_id, scheduler.organization_id, 'system',
  scheduler.identity_id, scheduler.identity_id, scheduler.created_at
FROM policy_reconciliation_scheduler_identities scheduler;

CREATE TRIGGER audit_actor_binding_for_policy_scheduler
AFTER INSERT ON policy_reconciliation_scheduler_identities
BEGIN
  INSERT OR IGNORE INTO audit_actor_bindings
    (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
  VALUES ('tenant', NEW.organization_id, NEW.organization_id, 'system', NEW.identity_id, NEW.identity_id, NEW.created_at);
END;

-- Orphan reconciliation is also a durable scheduler boundary. Register its
-- immutable principal before any strict envelope can refer to it. Migration
-- 0030 repeats this INSERT defensively for backup retention; OR IGNORE makes
-- the two migration paths converge on one binding.
INSERT OR IGNORE INTO audit_actor_bindings
  (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
SELECT
  'tenant', scheduler.organization_id, scheduler.organization_id, 'system',
  scheduler.identity_id, scheduler.identity_id, scheduler.created_at
FROM orphan_reconciliation_scheduler_identities scheduler;

CREATE TRIGGER audit_actor_binding_for_orphan_scheduler
AFTER INSERT ON orphan_reconciliation_scheduler_identities
BEGIN
  INSERT OR IGNORE INTO audit_actor_bindings
    (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
  VALUES ('tenant', NEW.organization_id, NEW.organization_id, 'system', NEW.identity_id, NEW.identity_id, NEW.created_at);
END;

-- A v1 envelope is staged before the normal audit insert. The matching audit
-- trigger consumes it in the same D1 transaction. Staging cannot be edited or
-- discarded after acceptance, which makes accidental partial audit writes fail
-- closed while preserving normal response-loss/idempotency behaviour.
CREATE TABLE audit_envelope_staging (
  event_table TEXT NOT NULL CHECK (event_table IN ('tenant', 'platform')),
  event_id TEXT NOT NULL,
  organization_id TEXT,
  envelope_json TEXT NOT NULL CHECK (
    json_valid(envelope_json)
    AND json_type(envelope_json) = 'object'
    AND length(CAST(envelope_json AS BLOB)) <= 81920
  ),
  staged_at TEXT NOT NULL,
  PRIMARY KEY (event_table, event_id),
  CHECK (
    (event_table = 'tenant' AND organization_id IS NOT NULL)
    OR (event_table = 'platform' AND organization_id IS NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TRIGGER audit_envelope_staging_valid
BEFORE INSERT ON audit_envelope_staging
WHEN
  json_extract(NEW.envelope_json, '$.version') IS NOT 1
  OR json_extract(NEW.envelope_json, '$.captureStatus') IS NOT 'complete'
  OR json_extract(NEW.envelope_json, '$.scope') IS NOT
     CASE NEW.event_table WHEN 'tenant' THEN 'tenant' ELSE 'platform' END
  OR (
    NEW.event_table = 'tenant' AND (
      json_type(NEW.envelope_json, '$.organizationId') IS NOT 'text'
      OR json_extract(NEW.envelope_json, '$.organizationId') IS NOT NEW.organization_id
    )
  )
  OR (
    NEW.event_table = 'platform' AND json_type(NEW.envelope_json, '$.organizationId') IS NOT 'null'
  )
  -- SQLite accepts some invalid ISO-looking dates during date arithmetic. Keep
  -- the same UTC calendar contract at the SQL boundary so a raw staging write
  -- cannot bypass the Effect Schema decoder.
  OR json_type(NEW.envelope_json, '$.occurredAt') IS NOT 'text'
  OR (
    (
      length(json_extract(NEW.envelope_json, '$.occurredAt')) NOT IN (20, 24)
      OR NOT (
        (
          length(json_extract(NEW.envelope_json, '$.occurredAt')) = 20
          AND json_extract(NEW.envelope_json, '$.occurredAt') GLOB
            '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
        )
        OR (
          length(json_extract(NEW.envelope_json, '$.occurredAt')) = 24
          AND json_extract(NEW.envelope_json, '$.occurredAt') GLOB
            '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        )
      )
      OR CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
      OR CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 9, 2) AS INTEGER) NOT BETWEEN 1 AND
        CASE CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 6, 2) AS INTEGER)
          WHEN 1 THEN 31 WHEN 3 THEN 31 WHEN 5 THEN 31 WHEN 7 THEN 31
          WHEN 8 THEN 31 WHEN 10 THEN 31 WHEN 12 THEN 31
          WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
          WHEN 2 THEN CASE
            WHEN CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 1, 4) AS INTEGER) % 400 = 0
              OR (
                CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 1, 4) AS INTEGER) % 4 = 0
                AND CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 1, 4) AS INTEGER) % 100 <> 0
              )
            THEN 29 ELSE 28 END
        END
      OR CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
      OR CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
      OR CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59
    )
  )
  -- `staged_at` is the durable admission clock. Validate it independently so
  -- the export payload can always decode it, then apply the same five-minute
  -- bound used by audit-contracts and the Queue/R2 consumer. This compares two
  -- immutable values, not a delayed worker wall clock.
  OR (
    length(NEW.staged_at) NOT IN (20, 24)
    OR NOT (
      (length(NEW.staged_at) = 20 AND NEW.staged_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
      OR (length(NEW.staged_at) = 24 AND NEW.staged_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
    )
    OR CASE length(NEW.staged_at)
      WHEN 20 THEN strftime('%Y-%m-%dT%H:%M:%SZ', NEW.staged_at)
      WHEN 24 THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.staged_at)
    END IS NOT NEW.staged_at
  )
  -- Compare integer milliseconds, rather than Julian-day floating point
  -- values, so the exact five-minute admission boundary is deterministic.
  OR (
    CAST(strftime('%s', json_extract(NEW.envelope_json, '$.occurredAt')) AS INTEGER) * 1000
      + CASE length(json_extract(NEW.envelope_json, '$.occurredAt'))
          WHEN 24 THEN CAST(substr(json_extract(NEW.envelope_json, '$.occurredAt'), 21, 3) AS INTEGER)
          ELSE 0
        END
    > CAST(strftime('%s', NEW.staged_at) AS INTEGER) * 1000
      + CASE length(NEW.staged_at)
          WHEN 24 THEN CAST(substr(NEW.staged_at, 21, 3) AS INTEGER)
          ELSE 0
        END
      + 300000
  )
  OR COALESCE(json_extract(NEW.envelope_json, '$.actor.type'), '') NOT IN
       ('human', 'automation', 'machine', 'system', 'platform')
  OR json_type(NEW.envelope_json, '$.actor.id') IS NOT 'text'
  OR (
    NEW.event_table = 'tenant' AND (
      (
        json_extract(NEW.envelope_json, '$.actor.type') = 'human'
        AND NOT EXISTS (
          SELECT 1
          FROM identities identity
          JOIN organization_memberships membership
            ON membership.organization_id = NEW.organization_id
           AND membership.identity_id = identity.id
          WHERE identity.id = json_extract(NEW.envelope_json, '$.actor.id')
            AND identity.status = 'active'
            AND membership.status = 'active'
            AND membership.role <> 'automation'
        )
      )
      OR (
        json_extract(NEW.envelope_json, '$.actor.type') IN ('automation', 'machine', 'system')
        AND NOT EXISTS (
          SELECT 1 FROM audit_actor_bindings binding
          WHERE binding.scope = 'tenant'
            AND binding.scope_key = NEW.organization_id
            AND binding.actor_type = json_extract(NEW.envelope_json, '$.actor.type')
            AND binding.actor_id = json_extract(NEW.envelope_json, '$.actor.id')
        )
      )
      OR json_extract(NEW.envelope_json, '$.actor.type') = 'platform'
    )
  )
  OR (
    NEW.event_table = 'platform' AND (
      (
        json_extract(NEW.envelope_json, '$.actor.type') = 'human'
        AND NOT EXISTS (
          SELECT 1 FROM identities identity
          WHERE identity.id = json_extract(NEW.envelope_json, '$.actor.id')
            AND identity.status = 'active'
        )
      )
      OR (
        json_extract(NEW.envelope_json, '$.actor.type') = 'platform'
        AND NOT EXISTS (
          SELECT 1 FROM platform_administrators administrator
          WHERE administrator.identity_id = json_extract(NEW.envelope_json, '$.actor.id')
            AND administrator.status = 'active'
        )
      )
      OR (
        json_extract(NEW.envelope_json, '$.actor.type') IN ('automation', 'machine', 'system')
        AND NOT EXISTS (
          SELECT 1 FROM audit_actor_bindings binding
          WHERE binding.scope = 'platform'
            AND binding.scope_key = 'platform'
            AND binding.actor_type = json_extract(NEW.envelope_json, '$.actor.type')
            AND binding.actor_id = json_extract(NEW.envelope_json, '$.actor.id')
        )
      )
    )
  )
  OR json_type(NEW.envelope_json, '$.request.id') IS NOT 'text'
  OR json_type(NEW.envelope_json, '$.request.correlationId') IS NOT 'text'
  OR json_type(NEW.envelope_json, '$.action') IS NOT 'text'
  OR json_type(NEW.envelope_json, '$.target.type') IS NOT 'text'
  OR json_type(NEW.envelope_json, '$.target.id') IS NOT 'text'
  OR json_type(NEW.envelope_json, '$.before') IS NOT 'object'
  OR (
    (json_extract(NEW.envelope_json, '$.before.state') = 'captured' AND (
      json_type(NEW.envelope_json, '$.before.summary') IS NOT 'object'
      OR json_type(NEW.envelope_json, '$.before.reason') IS NOT NULL
    ))
    OR (json_extract(NEW.envelope_json, '$.before.state') = 'absent' AND (
      json_type(NEW.envelope_json, '$.before.reason') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.before.summary') IS NOT NULL
    ))
    OR COALESCE(json_extract(NEW.envelope_json, '$.before.state'), '') NOT IN ('captured', 'absent')
  )
  OR json_type(NEW.envelope_json, '$.after') IS NOT 'object'
  OR (
    (json_extract(NEW.envelope_json, '$.after.state') = 'captured' AND (
      json_type(NEW.envelope_json, '$.after.summary') IS NOT 'object'
      OR json_type(NEW.envelope_json, '$.after.reason') IS NOT NULL
    ))
    OR (json_extract(NEW.envelope_json, '$.after.state') = 'absent' AND (
      json_type(NEW.envelope_json, '$.after.reason') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.after.summary') IS NOT NULL
    ))
    OR COALESCE(json_extract(NEW.envelope_json, '$.after.state'), '') NOT IN ('captured', 'absent')
  )
  OR json_type(NEW.envelope_json, '$.operationId') IS NOT 'text'
  OR (
    NEW.event_table = 'tenant' AND NOT EXISTS (
      SELECT 1 FROM operations operation
      WHERE operation.organization_id = NEW.organization_id
        AND operation.id = json_extract(NEW.envelope_json, '$.operationId')
        AND operation.actor_id = CASE json_extract(NEW.envelope_json, '$.actor.type')
          WHEN 'human' THEN json_extract(NEW.envelope_json, '$.actor.id')
          ELSE (
            SELECT binding.operation_actor_id FROM audit_actor_bindings binding
            WHERE binding.scope = 'tenant'
              AND binding.scope_key = NEW.organization_id
              AND binding.actor_type = json_extract(NEW.envelope_json, '$.actor.type')
              AND binding.actor_id = json_extract(NEW.envelope_json, '$.actor.id')
          )
        END
        AND operation.resource_type = json_extract(NEW.envelope_json, '$.target.type')
        AND operation.resource_id = json_extract(NEW.envelope_json, '$.target.id')
        AND operation.correlation_id = json_extract(NEW.envelope_json, '$.request.correlationId')
        AND (
          (json_extract(NEW.envelope_json, '$.result') = 'succeeded'
            AND operation.status = 'succeeded')
          OR (json_extract(NEW.envelope_json, '$.result') = 'denied'
            AND operation.status IN ('denied', 'failed', 'failed_terminal'))
          OR (json_extract(NEW.envelope_json, '$.result') = 'failed'
            AND operation.status IN ('failed', 'failed_terminal'))
        )
    )
  )
  OR (
    NEW.event_table = 'platform' AND NOT EXISTS (
      SELECT 1 FROM platform_operations operation
      WHERE operation.id = json_extract(NEW.envelope_json, '$.operationId')
        AND operation.actor_id = CASE json_extract(NEW.envelope_json, '$.actor.type')
          WHEN 'human' THEN json_extract(NEW.envelope_json, '$.actor.id')
          WHEN 'platform' THEN json_extract(NEW.envelope_json, '$.actor.id')
          ELSE (
            SELECT binding.operation_actor_id FROM audit_actor_bindings binding
            WHERE binding.scope = 'platform'
              AND binding.scope_key = 'platform'
              AND binding.actor_type = json_extract(NEW.envelope_json, '$.actor.type')
              AND binding.actor_id = json_extract(NEW.envelope_json, '$.actor.id')
          )
        END
        AND operation.resource_type = json_extract(NEW.envelope_json, '$.target.type')
        AND operation.resource_id = json_extract(NEW.envelope_json, '$.target.id')
        AND operation.correlation_id = json_extract(NEW.envelope_json, '$.request.correlationId')
        AND (
          (json_extract(NEW.envelope_json, '$.result') = 'succeeded'
            AND operation.status = 'succeeded')
          OR (json_extract(NEW.envelope_json, '$.result') = 'denied'
            AND operation.status = 'denied')
          OR (json_extract(NEW.envelope_json, '$.result') = 'failed'
            AND operation.status IN ('failed', 'failed_terminal'))
        )
    )
  )
  OR json_type(NEW.envelope_json, '$.source') IS NOT 'object'
  OR COALESCE(json_extract(NEW.envelope_json, '$.source.origin'), '') NOT IN
       ('http', 'machine', 'scheduler', 'internal')
  -- Source origin is retained as immutable provenance. An HTTP request must
  -- carry complete Access evidence; a machine cannot invent it; scheduled and
  -- internal executions cannot invent request IP or Access evidence.
  OR (
    json_extract(NEW.envelope_json, '$.source.origin') = 'http' AND (
      json_extract(NEW.envelope_json, '$.source.access.state') IS NOT 'captured'
      OR json_type(NEW.envelope_json, '$.source.access.value.subject') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.source.access.value.issuer') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.source.access.value.email') IS NOT 'text'
      OR (
        json_extract(NEW.envelope_json, '$.actor.type') = 'human' AND (
          json_type(NEW.envelope_json, '$.source.access.value.identityId') IS NOT 'text'
          OR json_extract(NEW.envelope_json, '$.source.access.value.identityId') IS NOT
             json_extract(NEW.envelope_json, '$.actor.id')
          OR NOT EXISTS (
            SELECT 1 FROM identities identity
            WHERE identity.id = json_extract(NEW.envelope_json, '$.actor.id')
              AND identity.access_subject = json_extract(NEW.envelope_json, '$.source.access.value.subject')
              AND lower(identity.email) = lower(json_extract(NEW.envelope_json, '$.source.access.value.email'))
          )
        )
      )
    )
  )
  OR (
    json_extract(NEW.envelope_json, '$.source.origin') = 'machine'
    AND json_extract(NEW.envelope_json, '$.source.access.state') IS NOT 'not-available'
  )
  OR (
    json_extract(NEW.envelope_json, '$.source.origin') IN ('scheduler', 'internal')
    AND (
      json_extract(NEW.envelope_json, '$.source.ip.state') IS NOT 'not-available'
      OR json_extract(NEW.envelope_json, '$.source.access.state') IS NOT 'not-available'
    )
  )
  OR (
    (json_extract(NEW.envelope_json, '$.source.ip.state') = 'captured' AND (
      json_type(NEW.envelope_json, '$.source.ip.value') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.source.ip.reason') IS NOT NULL
    ))
    OR (json_extract(NEW.envelope_json, '$.source.ip.state') = 'not-available' AND (
      json_type(NEW.envelope_json, '$.source.ip.reason') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.source.ip.value') IS NOT NULL
    ))
    OR COALESCE(json_extract(NEW.envelope_json, '$.source.ip.state'), '') NOT IN ('captured', 'not-available')
  )
  OR (
    (json_extract(NEW.envelope_json, '$.source.access.state') = 'captured' AND (
      json_type(NEW.envelope_json, '$.source.access.value') IS NOT 'object'
      OR json_type(NEW.envelope_json, '$.source.access.reason') IS NOT NULL
      OR (json_type(NEW.envelope_json, '$.source.access.value.subject') IS NOT 'text'
        AND json_type(NEW.envelope_json, '$.source.access.value.subject') IS NOT 'null')
      OR (json_type(NEW.envelope_json, '$.source.access.value.identityId') IS NOT 'text'
        AND json_type(NEW.envelope_json, '$.source.access.value.identityId') IS NOT 'null')
      OR (json_type(NEW.envelope_json, '$.source.access.value.issuer') IS NOT 'text'
        AND json_type(NEW.envelope_json, '$.source.access.value.issuer') IS NOT 'null')
      OR (json_type(NEW.envelope_json, '$.source.access.value.email') IS NOT 'text'
        AND json_type(NEW.envelope_json, '$.source.access.value.email') IS NOT 'null')
    ))
    OR (json_extract(NEW.envelope_json, '$.source.access.state') = 'not-available' AND (
      json_type(NEW.envelope_json, '$.source.access.reason') IS NOT 'text'
      OR json_type(NEW.envelope_json, '$.source.access.value') IS NOT NULL
    ))
    OR COALESCE(json_extract(NEW.envelope_json, '$.source.access.state'), '') NOT IN ('captured', 'not-available')
  )
  OR COALESCE(json_extract(NEW.envelope_json, '$.result'), '') NOT IN ('succeeded', 'denied', 'failed')
  OR COALESCE(json_extract(NEW.envelope_json, '$.error.classification'), '') NOT IN
       ('none', 'authorization', 'validation', 'conflict', 'policy', 'provider', 'transport', 'timeout', 'unknown')
  OR (json_type(NEW.envelope_json, '$.error.code') IS NOT 'text'
      AND json_type(NEW.envelope_json, '$.error.code') IS NOT 'null')
  OR json_type(NEW.envelope_json, '$.forced') NOT IN ('true', 'false')
  OR json_type(NEW.envelope_json, '$.breakGlass') NOT IN ('true', 'false')
  OR (
    json_extract(NEW.envelope_json, '$.result') = 'succeeded'
    AND json_extract(NEW.envelope_json, '$.error.classification') IS NOT 'none'
  )
  OR (
    json_extract(NEW.envelope_json, '$.result') <> 'succeeded'
    AND json_extract(NEW.envelope_json, '$.error.classification') IS 'none'
  )
  -- Apply the same bounded canonical JSON limits before a raw SQL writer can
  -- commit an envelope that the Queue/R2 exporter would be unable to archive.
  OR (SELECT count(*) FROM json_tree(NEW.envelope_json)) > 4096
  OR EXISTS (
    SELECT 1
    FROM json_tree(NEW.envelope_json) AS entry
    WHERE
      (
        length(entry.fullkey) - length(replace(entry.fullkey, '.', ''))
        + length(entry.fullkey) - length(replace(entry.fullkey, '[', ''))
      ) > 12
      OR (entry.type = 'text' AND length(CAST(entry.value AS TEXT)) > 32768)
  )
  OR EXISTS (
    SELECT 1
    FROM json_tree(NEW.envelope_json) AS container
    WHERE
      (container.type = 'array' AND (
        SELECT count(*) FROM json_tree(NEW.envelope_json) AS child
        WHERE child.parent = container.id
      ) > 1024)
      OR (container.type = 'object' AND (
        SELECT count(*) FROM json_tree(NEW.envelope_json) AS child
        WHERE child.parent = container.id
      ) > 512)
  )
  OR COALESCE((
    SELECT SUM(
      CASE WHEN entry.type = 'text' THEN length(CAST(entry.value AS TEXT)) ELSE 0 END
      + CASE WHEN typeof(entry.key) = 'text' THEN length(CAST(entry.key AS TEXT)) ELSE 0 END
    )
    FROM json_tree(NEW.envelope_json) AS entry
  ), 0) > 131072
  -- Reject excess union properties as well as incompatible values. This keeps
  -- direct staging writes equivalent to Schema's onExcessProperty policy.
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json) AS field
    WHERE field.key NOT IN (
      'version', 'captureStatus', 'occurredAt', 'scope', 'organizationId',
      'actor', 'request', 'action', 'target', 'before', 'after', 'operationId',
      'source', 'result', 'error', 'forced', 'breakGlass'
    )
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.actor') AS field
    WHERE field.key NOT IN ('type', 'id')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.request') AS field
    WHERE field.key NOT IN ('id', 'correlationId')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.target') AS field
    WHERE field.key NOT IN ('type', 'id')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.before') AS field
    WHERE field.key NOT IN ('state', 'summary', 'reason')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.after') AS field
    WHERE field.key NOT IN ('state', 'summary', 'reason')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.source') AS field
    WHERE field.key NOT IN ('origin', 'ip', 'access')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.source.ip') AS field
    WHERE field.key NOT IN ('state', 'value', 'reason')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.source.access') AS field
    WHERE field.key NOT IN ('state', 'value', 'reason')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.source.access.value') AS field
    WHERE field.key NOT IN ('subject', 'identityId', 'issuer', 'email')
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.envelope_json, '$.error') AS field
    WHERE field.key NOT IN ('classification', 'code')
  )
  OR EXISTS (
    SELECT 1
    FROM json_tree(NEW.envelope_json) AS entry
    WHERE typeof(entry.key) = 'text'
      AND (
        length(CAST(entry.key AS TEXT)) NOT BETWEEN 1 AND 128
        OR CAST(entry.key AS TEXT) GLOB '*[^A-Za-z0-9_-]*'
        OR (
          (
            lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%authorization%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%setcookie%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) IN ('cookie', 'cookies', 'bearer')
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%password%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%passwd%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%secret%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%token%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%apikey%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%credential%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%privatekey%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%plaintextkey%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%datakey%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%wrappedkey%'
            OR lower(replace(replace(replace(replace(CAST(entry.key AS TEXT), '_', ''), '-', ''), '.', ''), ' ', '')) LIKE '%rconpassword%'
          )
          AND (entry.type IS NOT 'text' OR entry.value IS NOT '[REDACTED]')
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'audit envelope staging violates v1 policy');
END;

-- The TypeScript contract uses a semantic IP parser.  Keep raw D1 writers on
-- the same side of that boundary: accept IPv4, RFC 4291 IPv6, and an IPv4
-- tail only in the final IPv6 group.  The CASE branches deliberately check
-- the character alphabet before constructing JSON arrays from the segments.
CREATE TRIGGER audit_envelope_staging_source_ip_valid
BEFORE INSERT ON audit_envelope_staging
WHEN json_extract(NEW.envelope_json, '$.source.ip.state') = 'captured'
BEGIN
  SELECT CASE WHEN
    json_type(NEW.envelope_json, '$.source.ip.value') IS NOT 'text'
    OR length(json_extract(NEW.envelope_json, '$.source.ip.value')) NOT BETWEEN 3 AND 64
    OR (
      CASE
        -- IPv4 consists of exactly four decimal octets in range.
        WHEN instr(json_extract(NEW.envelope_json, '$.source.ip.value'), '.') > 0
          AND instr(json_extract(NEW.envelope_json, '$.source.ip.value'), ':') = 0
        THEN CASE
          WHEN json_extract(NEW.envelope_json, '$.source.ip.value') GLOB '*[^0-9.]*' THEN 1
          WHEN (
            SELECT count(*)
            FROM json_each(
              '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), '.', '","') || '"]'
            )
          ) <> 4 THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM json_each(
              '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), '.', '","') || '"]'
            ) AS octet
            WHERE length(octet.value) NOT BETWEEN 1 AND 3
              OR octet.value GLOB '*[^0-9]*'
              OR CAST(octet.value AS INTEGER) NOT BETWEEN 0 AND 255
          ) THEN 1
          ELSE 0
        END
        -- IPv6 accepts one compression marker at most. Each nonempty group is
        -- a 1-4 digit hexadecimal hextet, except an IPv4 tail in the final
        -- group. Its total uncompressed unit count is exactly eight.
        WHEN instr(json_extract(NEW.envelope_json, '$.source.ip.value'), ':') > 0
        THEN CASE
          WHEN json_extract(NEW.envelope_json, '$.source.ip.value') GLOB '*[^0-9A-Fa-f:.]*'
            OR json_extract(NEW.envelope_json, '$.source.ip.value') GLOB '*:::*'
            OR length(json_extract(NEW.envelope_json, '$.source.ip.value'))
               - length(replace(json_extract(NEW.envelope_json, '$.source.ip.value'), '::', '')) > 2
            OR (
              instr(json_extract(NEW.envelope_json, '$.source.ip.value'), '::') = 0
              AND (
                substr(json_extract(NEW.envelope_json, '$.source.ip.value'), 1, 1) = ':'
                OR substr(json_extract(NEW.envelope_json, '$.source.ip.value'), -1, 1) = ':'
              )
            )
            OR (
              instr(json_extract(NEW.envelope_json, '$.source.ip.value'), '::') > 0
              AND (
                (
                  substr(json_extract(NEW.envelope_json, '$.source.ip.value'), 1, 1) = ':'
                  AND substr(json_extract(NEW.envelope_json, '$.source.ip.value'), 1, 2) <> '::'
                )
                OR (
                  substr(json_extract(NEW.envelope_json, '$.source.ip.value'), -1, 1) = ':'
                  AND substr(json_extract(NEW.envelope_json, '$.source.ip.value'), -2, 2) <> '::'
                )
              )
            )
          THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM json_each(
              '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), ':', '","') || '"]'
            ) AS part
            WHERE part.value <> ''
              AND (
                (
                  instr(part.value, '.') > 0
                  AND (
                    part.key <> (
                      SELECT max(last_part.key)
                      FROM json_each(
                        '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), ':', '","') || '"]'
                      ) AS last_part
                    )
                    OR part.value GLOB '*[^0-9.]*'
                    OR (
                      SELECT count(*)
                      FROM json_each('["' || replace(part.value, '.', '","') || '"]')
                    ) <> 4
                    OR EXISTS (
                      SELECT 1
                      FROM json_each('["' || replace(part.value, '.', '","') || '"]') AS octet
                      WHERE length(octet.value) NOT BETWEEN 1 AND 3
                        OR octet.value GLOB '*[^0-9]*'
                        OR CAST(octet.value AS INTEGER) NOT BETWEEN 0 AND 255
                    )
                  )
                )
                OR (
                  instr(part.value, '.') = 0
                  AND (
                    length(part.value) NOT BETWEEN 1 AND 4
                    OR part.value GLOB '*[^0-9A-Fa-f]*'
                  )
                )
              )
          ) THEN 1
          WHEN (
            SELECT COALESCE(sum(CASE WHEN part.value = '' THEN 0 WHEN instr(part.value, '.') > 0 THEN 2 ELSE 1 END), 0)
            FROM json_each(
              '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), ':', '","') || '"]'
            ) AS part
          ) <> CASE
            WHEN instr(json_extract(NEW.envelope_json, '$.source.ip.value'), '::') > 0 THEN
              CASE WHEN (
                SELECT COALESCE(sum(CASE WHEN part.value = '' THEN 0 WHEN instr(part.value, '.') > 0 THEN 2 ELSE 1 END), 0)
                FROM json_each(
                  '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), ':', '","') || '"]'
                ) AS part
              ) < 8 THEN (
                SELECT COALESCE(sum(CASE WHEN part.value = '' THEN 0 WHEN instr(part.value, '.') > 0 THEN 2 ELSE 1 END), 0)
                FROM json_each(
                  '["' || replace(json_extract(NEW.envelope_json, '$.source.ip.value'), ':', '","') || '"]'
                ) AS part
              ) ELSE 8 END
            ELSE 8
          END THEN 1
          ELSE 0
        END
        ELSE 1
      END
    ) = 1
  THEN RAISE(ABORT, 'audit source IP is invalid') END;
END;

CREATE TRIGGER audit_envelope_staging_immutable_update
BEFORE UPDATE ON audit_envelope_staging
BEGIN
  SELECT RAISE(ABORT, 'audit envelope staging is immutable');
END;

CREATE TRIGGER audit_envelope_staging_delete_guard
BEFORE DELETE ON audit_envelope_staging
WHEN NOT EXISTS (
  SELECT 1 FROM audit_event_envelopes envelope
  WHERE envelope.event_id = OLD.event_id
    AND envelope.scope = CASE OLD.event_table WHEN 'tenant' THEN 'tenant' ELSE 'platform' END
    AND envelope.organization_id IS OLD.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit envelope staging cannot be discarded');
END;

CREATE TRIGGER audit_event_envelopes_valid
BEFORE INSERT ON audit_event_envelopes
WHEN
  json_extract(NEW.envelope_json, '$.version') IS NOT NEW.schema_version
  OR json_extract(NEW.envelope_json, '$.captureStatus') IS NOT NEW.capture_status
  OR json_extract(NEW.envelope_json, '$.scope') IS NOT NEW.scope
  OR (NEW.scope = 'tenant' AND json_extract(NEW.envelope_json, '$.organizationId') IS NOT NEW.organization_id)
  OR (NEW.scope = 'platform' AND json_type(NEW.envelope_json, '$.organizationId') IS NOT 'null')
  OR (
    NEW.schema_version = 0
    AND NOT (
      (NEW.scope = 'tenant' AND EXISTS (
        SELECT 1 FROM audit_events audit
        WHERE audit.id = NEW.event_id AND audit.organization_id = NEW.organization_id
      ))
      OR (NEW.scope = 'platform' AND EXISTS (
        SELECT 1 FROM global_audit_events audit WHERE audit.id = NEW.event_id
      ))
    )
  )
  OR (
    NEW.schema_version = 1 AND NEW.scope = 'tenant' AND NOT EXISTS (
      SELECT 1
      FROM audit_events audit
      WHERE audit.id = NEW.event_id
        AND audit.organization_id = NEW.organization_id
        AND audit.actor_id = CASE json_extract(NEW.envelope_json, '$.actor.type')
          WHEN 'human' THEN json_extract(NEW.envelope_json, '$.actor.id')
          ELSE (
            SELECT binding.operation_actor_id FROM audit_actor_bindings binding
            WHERE binding.scope = 'tenant'
              AND binding.scope_key = NEW.organization_id
              AND binding.actor_type = json_extract(NEW.envelope_json, '$.actor.type')
              AND binding.actor_id = json_extract(NEW.envelope_json, '$.actor.id')
          )
        END
        AND audit.action = json_extract(NEW.envelope_json, '$.action')
        AND audit.target_type = json_extract(NEW.envelope_json, '$.target.type')
        AND audit.target_id = json_extract(NEW.envelope_json, '$.target.id')
        AND audit.result = json_extract(NEW.envelope_json, '$.result')
        AND audit.correlation_id = json_extract(NEW.envelope_json, '$.request.correlationId')
        AND audit.created_at = json_extract(NEW.envelope_json, '$.occurredAt')
        AND (
          (
            json_extract(NEW.envelope_json, '$.after.state') = 'captured'
            AND NOT EXISTS (
              SELECT fullkey, type, atom FROM json_tree(json_extract(NEW.envelope_json, '$.after.summary'))
              EXCEPT
              SELECT fullkey, type, atom FROM json_tree(audit.summary_json)
            )
            AND NOT EXISTS (
              SELECT fullkey, type, atom FROM json_tree(audit.summary_json)
              EXCEPT
              SELECT fullkey, type, atom FROM json_tree(json_extract(NEW.envelope_json, '$.after.summary'))
            )
          )
          OR (
            json_extract(NEW.envelope_json, '$.after.state') = 'absent'
            AND json(audit.summary_json) = json_object(
              'state', 'absent',
              'reason', json_extract(NEW.envelope_json, '$.after.reason')
            )
          )
        )
    )
  )
  OR (
    NEW.schema_version = 1 AND NEW.scope = 'platform' AND NOT EXISTS (
      SELECT 1
      FROM global_audit_events audit
      WHERE audit.id = NEW.event_id
        AND audit.scope = 'platform'
        AND audit.actor_id = CASE json_extract(NEW.envelope_json, '$.actor.type')
          WHEN 'human' THEN json_extract(NEW.envelope_json, '$.actor.id')
          WHEN 'platform' THEN json_extract(NEW.envelope_json, '$.actor.id')
          ELSE (
            SELECT binding.operation_actor_id FROM audit_actor_bindings binding
            WHERE binding.scope = 'platform'
              AND binding.scope_key = 'platform'
              AND binding.actor_type = json_extract(NEW.envelope_json, '$.actor.type')
              AND binding.actor_id = json_extract(NEW.envelope_json, '$.actor.id')
          )
        END
        AND audit.action = json_extract(NEW.envelope_json, '$.action')
        AND audit.target_type = json_extract(NEW.envelope_json, '$.target.type')
        AND audit.target_id = json_extract(NEW.envelope_json, '$.target.id')
        AND audit.result = json_extract(NEW.envelope_json, '$.result')
        AND audit.correlation_id = json_extract(NEW.envelope_json, '$.request.correlationId')
        AND audit.created_at = json_extract(NEW.envelope_json, '$.occurredAt')
        AND (
          (
            json_extract(NEW.envelope_json, '$.after.state') = 'captured'
            AND NOT EXISTS (
              SELECT fullkey, type, atom FROM json_tree(json_extract(NEW.envelope_json, '$.after.summary'))
              EXCEPT
              SELECT fullkey, type, atom FROM json_tree(audit.summary_json)
            )
            AND NOT EXISTS (
              SELECT fullkey, type, atom FROM json_tree(audit.summary_json)
              EXCEPT
              SELECT fullkey, type, atom FROM json_tree(json_extract(NEW.envelope_json, '$.after.summary'))
            )
          )
          OR (
            json_extract(NEW.envelope_json, '$.after.state') = 'absent'
            AND json(audit.summary_json) = json_object(
              'state', 'absent',
              'reason', json_extract(NEW.envelope_json, '$.after.reason')
            )
          )
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'audit envelope does not match an authoritative audit event');
END;

CREATE TRIGGER audit_event_envelopes_immutable_update
BEFORE UPDATE ON audit_event_envelopes
BEGIN
  SELECT RAISE(ABORT, 'audit envelope is immutable');
END;

CREATE TRIGGER audit_event_envelopes_immutable_delete
BEFORE DELETE ON audit_event_envelopes
BEGIN
  SELECT RAISE(ABORT, 'audit envelope is immutable');
END;

-- Backfill is intentionally version zero. It has an explicit legacy status and
-- does not pretend that an old summary contains pre-state, request IP, Access
-- assertions, or an operation record.
INSERT INTO audit_event_envelopes
  (event_id, scope, organization_id, schema_version, capture_status, envelope_json, created_at)
SELECT
  audit.id,
  'tenant',
  audit.organization_id,
  0,
  'legacy',
  json_object(
    'version', 0,
    'captureStatus', 'legacy',
    'occurredAt', audit.created_at,
    'scope', 'tenant',
    'organizationId', audit.organization_id,
    'actor', json_object('type', 'human', 'id', audit.actor_id),
    'request', json_object('id', 'legacy:' || audit.id, 'correlationId', audit.correlation_id),
    'action', audit.action,
    'target', json_object('type', audit.target_type, 'id', audit.target_id),
    'before', json_object('state', 'not-available', 'reason', 'legacy-pre-state-unavailable'),
    'after', json_object('state', 'captured', 'summary', json(audit.summary_json)),
    'operationId', 'legacy:' || audit.id,
    'source', json_object(
      'origin', 'legacy',
      'ip', json_object('state', 'not-available', 'reason', 'legacy-source-ip-unavailable'),
      'access', json_object('state', 'not-available', 'reason', 'legacy-access-unavailable')
    ),
    'result', audit.result,
    'error', json_object('classification', 'unknown', 'code', null),
    'forced', json(false),
    'breakGlass', json(false)
  ),
  audit.created_at
FROM audit_events audit;

INSERT INTO audit_event_envelopes
  (event_id, scope, organization_id, schema_version, capture_status, envelope_json, created_at)
SELECT
  audit.id,
  'platform',
  NULL,
  0,
  'legacy',
  json_object(
    'version', 0,
    'captureStatus', 'legacy',
    'occurredAt', audit.created_at,
    'scope', 'platform',
    'organizationId', null,
    'actor', json_object(
      'type', CASE WHEN audit.actor_id IS NULL THEN 'system' ELSE 'human' END,
      'id', COALESCE(audit.actor_id, 'system:legacy-unknown')
    ),
    'request', json_object('id', 'legacy:' || audit.id, 'correlationId', audit.correlation_id),
    'action', audit.action,
    'target', json_object('type', audit.target_type, 'id', audit.target_id),
    'before', json_object('state', 'not-available', 'reason', 'legacy-pre-state-unavailable'),
    'after', json_object('state', 'captured', 'summary', json(audit.summary_json)),
    'operationId', 'legacy:' || audit.id,
    'source', json_object(
      'origin', 'legacy',
      'ip', json_object('state', 'not-available', 'reason', 'legacy-source-ip-unavailable'),
      'access', json_object('state', 'not-available', 'reason', 'legacy-access-unavailable')
    ),
    'result', audit.result,
    'error', json_object('classification', 'unknown', 'code', null),
    'forced', json(false),
    'breakGlass', json(false)
  ),
  audit.created_at
FROM global_audit_events audit;

-- The older tenant queue payload contained only compact audit columns. Replace
-- it while its old identity trigger is temporarily removed, then restore a
-- stronger exact-envelope identity fence below.
DROP TRIGGER IF EXISTS outbox_audit_export_namespace_guard;
DROP TRIGGER IF EXISTS outbox_audit_export_identity_immutable;
DROP TRIGGER IF EXISTS audit_events_enqueue_export;

UPDATE outbox
SET payload_json = (
  SELECT json_object(
    'version', 1,
    'scope', 'tenant',
    'id', audit.id,
    'organizationId', audit.organization_id,
    'partitionKey', audit.organization_id || ':audit',
    'exportRequestId', outbox.id,
    'admittedAt', envelope.created_at,
    'envelope', json(envelope.envelope_json)
  )
  FROM audit_export_requests request
  JOIN audit_events audit
    ON audit.organization_id = request.organization_id
   AND audit.id = request.audit_event_id
  JOIN audit_event_envelopes envelope
    ON envelope.event_id = audit.id
   AND envelope.scope = 'tenant'
   AND envelope.organization_id = audit.organization_id
  WHERE request.sequence_id = CAST(substr(outbox.id, 14) AS INTEGER)
    AND outbox.organization_id = audit.organization_id
)
WHERE event_type = 'audit.export.requested'
  AND aggregate_type = 'audit_event';

CREATE TRIGGER audit_events_enqueue_export
AFTER INSERT ON audit_events
BEGIN
  INSERT INTO audit_event_envelopes
    (event_id, scope, organization_id, schema_version, capture_status, envelope_json, created_at)
  SELECT
    staging.event_id,
    'tenant',
    staging.organization_id,
    1,
    json_extract(staging.envelope_json, '$.captureStatus'),
    staging.envelope_json,
    staging.staged_at
  FROM audit_envelope_staging staging
  WHERE staging.event_table = 'tenant'
    AND staging.event_id = NEW.id
    AND staging.organization_id = NEW.organization_id;

  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'audit event has no matching v1 envelope') END;

  DELETE FROM audit_envelope_staging
  WHERE event_table = 'tenant' AND event_id = NEW.id AND organization_id = NEW.organization_id;

  INSERT INTO audit_export_requests (organization_id, audit_event_id)
  VALUES (NEW.organization_id, NEW.id);

  INSERT INTO outbox
    (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
     publish_state, retry_count, available_at, created_at)
  SELECT
    printf('audit-export-%020d', request.sequence_id),
    NEW.organization_id,
    'audit.export.requested',
    'audit_event',
    printf('audit-event-%020d', request.sequence_id),
    json_object(
      'version', 1,
      'scope', 'tenant',
      'id', NEW.id,
      'organizationId', NEW.organization_id,
      'partitionKey', NEW.organization_id || ':audit',
      'exportRequestId', printf('audit-export-%020d', request.sequence_id),
      'admittedAt', envelope.created_at,
      'envelope', json(envelope.envelope_json)
    ),
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM audit_export_requests request
  JOIN audit_event_envelopes envelope
    ON envelope.event_id = NEW.id
   AND envelope.scope = 'tenant'
   AND envelope.organization_id = NEW.organization_id
  WHERE request.organization_id = NEW.organization_id
    AND request.audit_event_id = NEW.id;
END;

CREATE TRIGGER outbox_audit_export_namespace_guard
BEFORE INSERT ON outbox
WHEN NEW.event_type = 'audit.export.requested' OR NEW.aggregate_type = 'audit_event'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM audit_export_requests request
    JOIN audit_events audit
      ON audit.organization_id = request.organization_id
     AND audit.id = request.audit_event_id
    JOIN audit_event_envelopes envelope
      ON envelope.event_id = audit.id
     AND envelope.scope = 'tenant'
     AND envelope.organization_id = audit.organization_id
    WHERE NEW.id = printf('audit-export-%020d', request.sequence_id)
      AND NEW.organization_id = audit.organization_id
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
      AND json_extract(NEW.payload_json, '$.version') = 1
      AND json_extract(NEW.payload_json, '$.scope') = 'tenant'
      AND json_extract(NEW.payload_json, '$.id') = audit.id
      AND json_extract(NEW.payload_json, '$.organizationId') = audit.organization_id
      AND json_extract(NEW.payload_json, '$.partitionKey') = audit.organization_id || ':audit'
      AND json_extract(NEW.payload_json, '$.exportRequestId') = NEW.id
      AND json_extract(NEW.payload_json, '$.admittedAt') = envelope.created_at
      AND json( json_extract(NEW.payload_json, '$.envelope') ) = json(envelope.envelope_json)
  ) THEN RAISE(ABORT, 'audit export outbox identity is invalid') END;
END;

CREATE TRIGGER outbox_audit_export_identity_immutable
BEFORE UPDATE ON outbox
WHEN OLD.event_type = 'audit.export.requested' OR OLD.aggregate_type = 'audit_event'
BEGIN
  SELECT CASE WHEN
    NEW.id IS NOT OLD.id
    OR NEW.organization_id IS NOT OLD.organization_id
    OR NEW.event_type IS NOT OLD.event_type
    OR NEW.aggregate_type IS NOT OLD.aggregate_type
    OR NEW.aggregate_id IS NOT OLD.aggregate_id
    OR NEW.payload_json IS NOT OLD.payload_json
    OR NEW.created_at IS NOT OLD.created_at
  THEN RAISE(ABORT, 'audit export outbox identity is immutable') END;
END;

-- Platform audit export uses its own durable ledger. It has the same lease and
-- response-loss behaviour as tenant export without using a fake organization.
CREATE TABLE platform_audit_export_requests (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_event_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (audit_event_id) REFERENCES global_audit_events(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE platform_audit_export_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  publish_state TEXT NOT NULL DEFAULT 'pending' CHECK (publish_state IN ('pending', 'publishing', 'delivered', 'failed', 'failed_terminal')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (audit_event_id) REFERENCES global_audit_events(id) ON DELETE RESTRICT,
  CHECK (
    (publish_state = 'publishing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR publish_state <> 'publishing'
  )
) STRICT;

CREATE INDEX platform_audit_export_outbox_delivery
  ON platform_audit_export_outbox(publish_state, available_at, created_at);

CREATE TRIGGER platform_audit_export_outbox_immutable_update
BEFORE UPDATE ON platform_audit_export_outbox
BEGIN
  SELECT CASE WHEN
    NEW.id IS NOT OLD.id
    OR NEW.audit_event_id IS NOT OLD.audit_event_id
    OR NEW.payload_json IS NOT OLD.payload_json
    OR NEW.created_at IS NOT OLD.created_at
  THEN RAISE(ABORT, 'platform audit export identity is immutable') END;
END;

CREATE TRIGGER platform_audit_export_outbox_immutable_delete
BEFORE DELETE ON platform_audit_export_outbox
BEGIN
  SELECT RAISE(ABORT, 'platform audit export outbox is immutable');
END;

-- A platform audit has no organization column, but it still needs the same
-- producer fence as the tenant outbox.  Only the global-audit trigger can
-- create the exact durable export request for a platform envelope.  This
-- prevents a raw writer from creating a row that the R2 consumer would later
-- reject or archive under a misleading platform identity.
CREATE TRIGGER platform_audit_export_outbox_namespace_guard
BEFORE INSERT ON platform_audit_export_outbox
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM platform_audit_export_requests request
    JOIN global_audit_events audit ON audit.id = request.audit_event_id
    JOIN audit_event_envelopes envelope
      ON envelope.event_id = audit.id
     AND envelope.scope = 'platform'
     AND envelope.organization_id IS NULL
    WHERE NEW.id = printf('platform-audit-export-%020d', request.sequence_id)
      AND NEW.audit_event_id = audit.id
      AND NEW.publish_state = 'pending'
      AND NEW.retry_count = 0
      AND NEW.lease_owner IS NULL
      AND NEW.lease_token IS NULL
      AND NEW.lease_until IS NULL
      AND NEW.delivered_at IS NULL
      AND NEW.created_at = audit.created_at
      AND NEW.available_at = audit.created_at
      AND json_type(NEW.payload_json) = 'object'
      AND json_extract(NEW.payload_json, '$.version') = 1
      AND json_extract(NEW.payload_json, '$.scope') = 'platform'
      AND json_extract(NEW.payload_json, '$.id') = audit.id
      AND json_extract(NEW.payload_json, '$.organizationId') IS NULL
      AND json_extract(NEW.payload_json, '$.partitionKey') = 'platform:audit'
      AND json_extract(NEW.payload_json, '$.exportRequestId') = NEW.id
      AND json_extract(NEW.payload_json, '$.admittedAt') = envelope.created_at
      AND json(json_extract(NEW.payload_json, '$.envelope')) = json(envelope.envelope_json)
  ) THEN RAISE(ABORT, 'platform audit export outbox identity is invalid') END;
END;

INSERT INTO platform_audit_export_requests (audit_event_id)
SELECT audit.id FROM global_audit_events audit
ORDER BY audit.created_at, audit.id;

INSERT INTO platform_audit_export_outbox
  (id, audit_event_id, payload_json, publish_state, retry_count, available_at, created_at)
SELECT
  printf('platform-audit-export-%020d', request.sequence_id),
  audit.id,
  json_object(
    'version', 1,
    'scope', 'platform',
    'id', audit.id,
    'partitionKey', 'platform:audit',
    'exportRequestId', printf('platform-audit-export-%020d', request.sequence_id),
    'admittedAt', envelope.created_at,
    'envelope', json(envelope.envelope_json)
  ),
  'pending',
  0,
  audit.created_at,
  audit.created_at
FROM platform_audit_export_requests request
JOIN global_audit_events audit ON audit.id = request.audit_event_id
JOIN audit_event_envelopes envelope
  ON envelope.event_id = audit.id AND envelope.scope = 'platform'
WHERE NOT EXISTS (
  SELECT 1 FROM platform_audit_export_outbox existing
  WHERE existing.audit_event_id = audit.id
);

CREATE TRIGGER global_audit_events_enqueue_export
AFTER INSERT ON global_audit_events
BEGIN
  INSERT INTO audit_event_envelopes
    (event_id, scope, organization_id, schema_version, capture_status, envelope_json, created_at)
  SELECT
    staging.event_id,
    'platform',
    NULL,
    1,
    json_extract(staging.envelope_json, '$.captureStatus'),
    staging.envelope_json,
    staging.staged_at
  FROM audit_envelope_staging staging
  WHERE staging.event_table = 'platform' AND staging.event_id = NEW.id;

  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'platform audit event has no matching v1 envelope') END;

  DELETE FROM audit_envelope_staging
  WHERE event_table = 'platform' AND event_id = NEW.id;

  INSERT INTO platform_audit_export_requests (audit_event_id) VALUES (NEW.id);

  INSERT INTO platform_audit_export_outbox
    (id, audit_event_id, payload_json, publish_state, retry_count, available_at, created_at)
  SELECT
    printf('platform-audit-export-%020d', request.sequence_id),
    NEW.id,
    json_object(
      'version', 1,
      'scope', 'platform',
      'id', NEW.id,
      'partitionKey', 'platform:audit',
      'exportRequestId', printf('platform-audit-export-%020d', request.sequence_id),
      'admittedAt', envelope.created_at,
      'envelope', json(envelope.envelope_json)
    ),
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM platform_audit_export_requests request
  JOIN audit_event_envelopes envelope
    ON envelope.event_id = NEW.id AND envelope.scope = 'platform'
  WHERE request.audit_event_id = NEW.id;
END;

CREATE TRIGGER global_audit_events_immutable_update
BEFORE UPDATE ON global_audit_events
BEGIN
  SELECT RAISE(ABORT, 'platform audit event is immutable');
END;

CREATE TRIGGER global_audit_events_immutable_delete
BEFORE DELETE ON global_audit_events
BEGIN
  SELECT RAISE(ABORT, 'platform audit event is immutable');
END;

PRAGMA foreign_keys = ON;

-- A regular lifecycle termination can revoke a registration token without a
-- machine receipt.  A machine-accepted revoke must carry the exact terminal
-- machine operation that performed the NULL -> revoked transition.  Keeping
-- this fact on the token makes a legacy or racing revoke unable to be adopted
-- as a successful machine mutation merely because revoked_at is non-NULL.
ALTER TABLE node_registration_tokens
  ADD COLUMN machine_revocation_operation_id TEXT;

CREATE TRIGGER node_registration_tokens_machine_revocation_link_guard
BEFORE UPDATE OF machine_revocation_operation_id, revoked_at ON node_registration_tokens
WHEN (
  OLD.machine_revocation_operation_id IS NULL
  AND NEW.machine_revocation_operation_id IS NOT NULL
  AND (
    OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.machine_revocation_operation_id NOT LIKE 'operation:machine:registration-revoke:%'
    OR NOT EXISTS (
      SELECT 1
      FROM operations operation
      WHERE operation.organization_id = NEW.organization_id
        AND operation.id = NEW.machine_revocation_operation_id
        AND operation.type = 'agent.registration.revoke'
        AND operation.resource_type = 'node'
        AND operation.resource_id = NEW.node_id
        AND operation.status = 'succeeded'
        AND operation.progress = 100
    )
  )
)
OR (
  OLD.machine_revocation_operation_id IS NOT NULL
  AND (
    NEW.machine_revocation_operation_id IS NOT OLD.machine_revocation_operation_id
    OR NEW.revoked_at IS NOT OLD.revoked_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'machine registration revocation evidence is immutable');
END;

-- A machine request has no HTTP/Access provenance to inherit.  This receipt is
-- the durable response-loss authority for the machine-origin mutations that
-- are accepted after credential authentication: registration exchange/revoke,
-- node observations, command results, and the provision-ready completion
-- caused by an observation.  The compact audit row and its strict v1 envelope
-- are both required before the receipt becomes visible.
CREATE TABLE agent_machine_audit_receipts (
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'registration-exchange',
    'registration-revoke',
    'observation',
    'command-result',
    'node-runtime-completion'
  )),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  effect_key TEXT NOT NULL CHECK (length(effect_key) BETWEEN 1 AND 256),
  node_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  session_version INTEGER NOT NULL CHECK (session_version > 0),
  machine_identity_id TEXT NOT NULL,
  parent_operation_id TEXT,
  operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 160),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'failed')),
  observation_sequence INTEGER,
  observation_revision INTEGER,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 8192),
  accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, kind, idempotency_key),
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, audit_event_id),
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (machine_identity_id) REFERENCES identities(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, parent_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'observation' AND parent_operation_id IS NULL
      AND observation_sequence IS NOT NULL AND observation_sequence > 0
      AND observation_revision IS NOT NULL AND observation_revision > 0)
    OR
    (kind <> 'observation' AND observation_sequence IS NULL AND observation_revision IS NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX agent_machine_audit_receipts_node_time
  ON agent_machine_audit_receipts(organization_id, node_id, accepted_at DESC);

-- The receipt is deliberately inserted last in the D1 batch.  Every branch
-- below binds the canonical tenant/node/operation target, the credential
-- epoch, deterministic machine identity, terminal child operation, compact
-- audit event, and strict staged envelope.  A response-loss retry can only
-- adopt this exact immutable fact; it cannot turn a foreign or changed payload
-- into success.
CREATE TRIGGER agent_machine_audit_receipt_evidence_guard
BEFORE INSERT ON agent_machine_audit_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN node_credentials credential
    ON credential.organization_id = NEW.organization_id
   AND credential.node_id = NEW.node_id
   AND credential.id = NEW.credential_id
   AND credential.version = NEW.credential_version
   AND credential.status = 'active'
  JOIN agent_sessions session
    ON session.organization_id = credential.organization_id
   AND session.node_id = credential.node_id
   AND session.credential_id = credential.id
   AND session.session_version = NEW.session_version
   AND session.session_state = 'connected'
  JOIN machine_audit_identities machine_identity
    ON machine_identity.organization_id = credential.organization_id
   AND machine_identity.node_id = credential.node_id
   AND machine_identity.credential_id = credential.id
   AND machine_identity.credential_version = credential.version
   AND machine_identity.identity_id = NEW.machine_identity_id
  JOIN audit_actor_bindings actor_binding
    ON actor_binding.scope = 'tenant'
   AND actor_binding.scope_key = credential.organization_id
   AND actor_binding.organization_id = credential.organization_id
   AND actor_binding.actor_type = 'machine'
   AND actor_binding.actor_id = NEW.machine_identity_id
   AND actor_binding.operation_actor_id = NEW.machine_identity_id
  JOIN operations operation
    ON operation.organization_id = NEW.organization_id
   AND operation.id = NEW.operation_id
   AND operation.actor_id = NEW.machine_identity_id
   AND operation.resource_type = NEW.target_type
   AND operation.resource_id = NEW.target_id
   AND operation.type = CASE NEW.kind
     WHEN 'registration-exchange' THEN 'agent.registration.exchange'
     WHEN 'registration-revoke' THEN 'agent.registration.revoke'
     WHEN 'observation' THEN 'agent.observation'
     WHEN 'command-result' THEN 'agent.command.result'
     WHEN 'node-runtime-completion' THEN 'node.runtime.completion'
   END
   AND operation.status = CASE NEW.result WHEN 'succeeded' THEN 'succeeded' ELSE 'failed_terminal' END
  JOIN audit_events audit
    ON audit.id = NEW.audit_event_id
   AND audit.organization_id = operation.organization_id
   AND audit.actor_id = operation.actor_id
   AND audit.target_type = operation.resource_type
   AND audit.target_id = operation.resource_id
   AND audit.result = CASE NEW.result WHEN 'succeeded' THEN 'succeeded' ELSE 'failed' END
   AND audit.action = CASE NEW.kind
     WHEN 'registration-exchange' THEN 'node.agent.registration.exchanged'
     WHEN 'registration-revoke' THEN 'node.agent.registration.revoked'
     WHEN 'observation' THEN 'node.agent.observation.accepted'
     WHEN 'command-result' THEN 'agent.command.result.accepted'
     WHEN 'node-runtime-completion' THEN 'node.provision.ready'
   END
   AND audit.created_at = NEW.accepted_at
  JOIN audit_event_envelopes envelope
    ON envelope.event_id = audit.id
   AND envelope.scope = 'tenant'
   AND envelope.organization_id = audit.organization_id
   AND envelope.schema_version = 1
   AND envelope.capture_status = 'complete'
   AND json_extract(envelope.envelope_json, '$.actor.type') = 'machine'
   AND json_extract(envelope.envelope_json, '$.actor.id') = NEW.machine_identity_id
   AND json_extract(envelope.envelope_json, '$.action') = audit.action
   AND json_extract(envelope.envelope_json, '$.target.type') = NEW.target_type
   AND json_extract(envelope.envelope_json, '$.target.id') = NEW.target_id
   AND json_extract(envelope.envelope_json, '$.operationId') = NEW.operation_id
   AND json_extract(envelope.envelope_json, '$.source.origin') = 'machine'
   AND json_extract(envelope.envelope_json, '$.source.access.state') = 'not-available'
   AND json_extract(envelope.envelope_json, '$.result') = audit.result
  WHERE organization.id = NEW.organization_id
    AND organization.status = 'active'
)
OR (
  NEW.kind = 'observation' AND NOT EXISTS (
    SELECT 1
    FROM agent_observation_streams stream
    WHERE stream.organization_id = NEW.organization_id
      AND stream.node_id = NEW.node_id
      AND stream.credential_id = NEW.credential_id
      AND stream.credential_version = NEW.credential_version
      AND stream.session_version = NEW.session_version
      AND stream.last_fingerprint = NEW.effect_key
      AND stream.last_sequence = NEW.observation_sequence
      AND stream.last_observed_revision = NEW.observation_revision
  )
)
OR (
  NEW.kind = 'registration-exchange' AND NOT EXISTS (
    SELECT 1
    FROM node_registration_tokens registration
    WHERE registration.token_hash = NEW.effect_key
      AND registration.organization_id = NEW.organization_id
      AND registration.node_id = NEW.node_id
      AND registration.credential_id = NEW.credential_id
      AND registration.consumed_at IS NOT NULL
      AND registration.revoked_at IS NULL
  )
)
OR (
  NEW.kind = 'registration-revoke' AND NOT EXISTS (
    SELECT 1
    FROM node_registration_tokens registration
    WHERE registration.token_hash = NEW.effect_key
      AND registration.organization_id = NEW.organization_id
      AND registration.node_id = NEW.node_id
      -- The receipt is not a general acknowledgement that a token is
      -- revoked.  It is evidence of this accepted operation's own atomic
      -- transition.  This rejects legacy revocations and a competing writer
      -- even if that writer happened to use the same timestamp.
      AND registration.revoked_at = NEW.accepted_at
      AND registration.machine_revocation_operation_id = NEW.operation_id
  )
)
OR (
  NEW.kind IN ('registration-exchange', 'registration-revoke') AND NOT EXISTS (
    SELECT 1
    FROM node_registration_tokens registration
    WHERE registration.token_hash = NEW.effect_key
      AND registration.organization_id = NEW.organization_id
      AND registration.node_id = NEW.node_id
      AND registration.operation_id = NEW.parent_operation_id
  )
)
OR (
  NEW.kind = 'command-result' AND NOT (
    EXISTS (
      SELECT 1
      FROM game_command_deliveries delivery
      WHERE delivery.organization_id = NEW.organization_id
        AND delivery.operation_id = NEW.parent_operation_id
        AND delivery.command_id = NEW.effect_key
        AND delivery.state = CASE NEW.result WHEN 'succeeded' THEN 'completed' ELSE 'failed' END
    )
    OR EXISTS (
      SELECT 1
      FROM tunnel_credential_deliveries delivery
      WHERE delivery.organization_id = NEW.organization_id
        AND delivery.operation_id = NEW.parent_operation_id
        AND delivery.delivery_id = NEW.effect_key
        AND delivery.state IN ('acknowledged', 'revoked', 'failed')
    )
  )
)
OR (
  NEW.kind = 'node-runtime-completion' AND NOT EXISTS (
    SELECT 1
    FROM operations parent
    JOIN nodes node
      ON node.organization_id = parent.organization_id
     AND node.id = parent.resource_id
    WHERE parent.organization_id = NEW.organization_id
      AND parent.id = NEW.parent_operation_id
      AND parent.type = 'provision-node'
      AND parent.resource_type = 'node'
      AND parent.resource_id = NEW.node_id
      AND parent.status = 'succeeded'
      AND node.desired_state = 'ready'
      AND node.observed_state = 'ready'
  )
)
OR (
  NEW.kind IN ('registration-exchange', 'registration-revoke', 'node-runtime-completion')
  AND NOT EXISTS (
    SELECT 1
    FROM operations parent
    WHERE parent.organization_id = NEW.organization_id
      AND parent.id = NEW.parent_operation_id
      AND parent.resource_type = 'node'
      AND parent.resource_id = NEW.node_id
  )
)
OR (
  NEW.kind = 'command-result' AND NOT EXISTS (
    SELECT 1
    FROM operations parent
    WHERE parent.organization_id = NEW.organization_id
      AND parent.id = NEW.parent_operation_id
      AND parent.resource_type = NEW.target_type
      AND parent.resource_id = NEW.target_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'agent machine audit receipt evidence fence failed');
END;

CREATE TRIGGER agent_machine_audit_receipt_immutable_update
BEFORE UPDATE ON agent_machine_audit_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent machine audit receipt is immutable');
END;

CREATE TRIGGER agent_machine_audit_receipt_immutable_delete
BEFORE DELETE ON agent_machine_audit_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent machine audit receipt cannot be deleted');
END;

-- A terminal machine operation is part of the accepted receipt evidence.  It
-- must not be reopened or have its actor, target, correlation, idempotency, or
-- timestamps rewritten after the receipt becomes visible.
CREATE TRIGGER agent_machine_audit_operation_immutable_update
BEFORE UPDATE ON operations
WHEN EXISTS (
  SELECT 1
  FROM agent_machine_audit_receipts receipt
  WHERE receipt.organization_id = OLD.organization_id
    AND receipt.operation_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'agent machine audit operation is immutable');
END;

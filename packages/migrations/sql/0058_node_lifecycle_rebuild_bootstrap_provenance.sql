PRAGMA foreign_keys = ON;

-- A rebuild is not a new provision operation.  Freeze the promoted artifact
-- checksum at destructive acceptance so a later image/catalog mutation cannot
-- change the bytes or cloud-init identity sent to the provider.
ALTER TABLE node_lifecycle_runs
  ADD COLUMN target_image_checksum_snapshot TEXT CHECK (
    target_image_checksum_snapshot IS NULL OR (
      length(target_image_checksum_snapshot) = 71
      AND target_image_checksum_snapshot GLOB 'sha256:*'
      AND substr(target_image_checksum_snapshot, 8) NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE TRIGGER node_lifecycle_rebuild_checksum_snapshot_acceptance_guard
BEFORE INSERT ON node_lifecycle_runs
WHEN (
  NEW.action = 'rebuild-node' AND (
    NEW.target_image_checksum_snapshot IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM node_images image
      WHERE image.id = NEW.target_image_id
        AND image.version = NEW.target_image_version_snapshot
        AND image.checksum = NEW.target_image_checksum_snapshot
        AND image.status = 'promoted'
    )
  )
) OR (
  NEW.action <> 'rebuild-node' AND NEW.target_image_checksum_snapshot IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild checksum snapshot fence failed');
END;

CREATE TRIGGER node_lifecycle_rebuild_checksum_snapshot_immutable
BEFORE UPDATE OF target_image_checksum_snapshot ON node_lifecycle_runs
WHEN NEW.target_image_checksum_snapshot IS NOT OLD.target_image_checksum_snapshot
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild checksum snapshot is immutable');
END;

-- This is the one operation-bound handoff to the signed image helper after a
-- rebuild.  It is deliberately separate from node_provision_acceptances: a
-- reimage must not gain authority by pretending to be the original paid
-- provider-create operation.
CREATE TABLE node_lifecycle_rebuild_bootstraps (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  token_record_id TEXT NOT NULL,
  derivation_token_hash TEXT NOT NULL CHECK (
    length(derivation_token_hash) = 64 AND derivation_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  provider_instance_id TEXT NOT NULL,
  target_image_id TEXT NOT NULL,
  target_image_version TEXT NOT NULL,
  target_image_checksum TEXT NOT NULL CHECK (
    length(target_image_checksum) = 71
    AND target_image_checksum GLOB 'sha256:*'
    AND substr(target_image_checksum, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  target_provider_image_id TEXT NOT NULL,
  node_desired_revision INTEGER NOT NULL CHECK (node_desired_revision > 0),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'provider-rebuilding', 'awaiting-agent', 'blocked', 'ready'
  )),
  provider_observed_at TEXT,
  prepared_operation_id TEXT NOT NULL,
  prepared_audit_event_id TEXT NOT NULL,
  prepared_outbox_event_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (derivation_token_hash),
  UNIQUE (token_hash),
  UNIQUE (prepared_operation_id),
  UNIQUE (prepared_audit_event_id),
  UNIQUE (organization_id, prepared_outbox_event_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_lifecycle_runs(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (target_image_id) REFERENCES node_images(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, prepared_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (prepared_audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, prepared_outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'prepared' AND provider_observed_at IS NULL)
    OR (state IN ('provider-rebuilding', 'awaiting-agent', 'blocked')
      AND provider_observed_at IS NOT NULL)
    OR state = 'ready'
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX node_lifecycle_rebuild_bootstraps_state
  ON node_lifecycle_rebuild_bootstraps(organization_id, node_id, state, updated_at);

-- The terminal child operation/audit/outbox are part of preparation, so a
-- response-loss retry can adopt one immutable handoff without recreating a
-- token or passing mutable image/provider facts to the provider.
CREATE TRIGGER node_lifecycle_rebuild_bootstrap_insert_guard
BEFORE INSERT ON node_lifecycle_rebuild_bootstraps
WHEN NOT EXISTS (
  SELECT 1
  FROM node_lifecycle_runs run
  JOIN operations operation
    ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
  JOIN destructive_lifecycle_operations lifecycle
    ON lifecycle.organization_id = run.organization_id AND lifecycle.operation_id = run.operation_id
  JOIN operation_cancellation_facts facts
    ON facts.organization_id = run.organization_id AND facts.operation_id = run.operation_id
  JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
  JOIN node_images image ON image.id = run.target_image_id
  JOIN node_registration_tokens token
    ON token.organization_id = run.organization_id
   AND token.node_id = run.node_id
   AND token.operation_id = run.operation_id
  JOIN operations preparation
    ON preparation.organization_id = run.organization_id AND preparation.id = NEW.prepared_operation_id
  JOIN audit_events audit ON audit.id = NEW.prepared_audit_event_id
  JOIN outbox event
    ON event.organization_id = run.organization_id AND event.id = NEW.prepared_outbox_event_id
  JOIN audit_event_envelopes envelope ON envelope.event_id = audit.id
  WHERE run.organization_id = NEW.organization_id
    AND run.operation_id = NEW.operation_id
    AND run.node_id = NEW.node_id
    AND run.action = 'rebuild-node' AND run.state = 'rebuilding'
    AND lifecycle.action = 'rebuild-node' AND lifecycle.state = 'running'
    AND operation.type = 'rebuild-node' AND operation.resource_type = 'node'
    AND operation.resource_id = run.node_id AND operation.status = 'running'
    AND facts.phase = 'destructive-step-running'
    AND facts.active_step_ordinal = 2 AND facts.active_step_name = 'rebuild-provider-instance'
    AND node.pending_lifecycle_operation_id = run.operation_id
    AND node.desired_state = 'provisioning'
    AND node.desired_revision = NEW.node_desired_revision
    AND node.observed_state = 'unknown'
    AND node.image_id = NEW.target_image_id
    AND node.provider_type = NEW.provider_type
    AND node.provider_instance_id = NEW.provider_instance_id
    AND run.provider_type_snapshot = NEW.provider_type
    AND run.provider_instance_id_snapshot = NEW.provider_instance_id
    AND run.target_image_id = NEW.target_image_id
    AND run.target_image_version_snapshot = NEW.target_image_version
    AND run.target_image_checksum_snapshot = NEW.target_image_checksum
    AND run.target_provider_image_id = NEW.target_provider_image_id
    AND image.id = NEW.target_image_id AND image.version = NEW.target_image_version
    AND image.checksum = NEW.target_image_checksum AND image.status = 'promoted'
    AND token.token_hash = NEW.token_hash AND token.provider_instance_id = NEW.provider_instance_id
    AND token.expires_at = NEW.expires_at AND token.consumed_at IS NULL AND token.revoked_at IS NULL
    AND preparation.type = 'node.rebuild.bootstrap.prepared'
    AND preparation.resource_type = 'node' AND preparation.resource_id = run.node_id
    AND preparation.status = 'succeeded' AND preparation.progress = 100
    AND preparation.correlation_id = operation.correlation_id
    AND audit.organization_id = run.organization_id AND audit.actor_id = operation.actor_id
    AND audit.action = 'node.rebuild.bootstrap.prepared' AND audit.target_type = 'node'
    AND audit.target_id = run.node_id AND audit.result = 'succeeded'
    AND audit.correlation_id = operation.correlation_id AND audit.created_at = NEW.prepared_at
    AND envelope.scope = 'tenant' AND envelope.organization_id = run.organization_id
    AND envelope.schema_version = 1 AND envelope.capture_status = 'complete'
    AND json_extract(envelope.envelope_json, '$.operationId') = preparation.id
    AND json_extract(envelope.envelope_json, '$.source.origin') = 'machine'
    AND event.event_type = 'node.rebuild.bootstrap.prepared'
    AND event.aggregate_type = 'operation' AND event.aggregate_id = run.operation_id
    AND NOT EXISTS (
      SELECT 1 FROM node_credentials credential
      WHERE credential.organization_id = run.organization_id AND credential.node_id = run.node_id
        AND credential.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_sessions session
      WHERE session.organization_id = run.organization_id AND session.node_id = run.node_id
        AND session.session_state <> 'revoked'
    )
    AND NOT EXISTS (
      SELECT 1 FROM node_registration_tokens old_token
      WHERE old_token.organization_id = run.organization_id AND old_token.node_id = run.node_id
        AND old_token.token_hash <> NEW.token_hash AND old_token.revoked_at IS NULL
    )
)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild bootstrap provenance fence failed');
END;

CREATE TRIGGER node_lifecycle_rebuild_bootstrap_immutable_update
BEFORE UPDATE ON node_lifecycle_rebuild_bootstraps
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.token_record_id IS NOT OLD.token_record_id
  OR NEW.derivation_token_hash IS NOT OLD.derivation_token_hash
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.key_version <> OLD.key_version
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
  OR NEW.target_image_id IS NOT OLD.target_image_id
  OR NEW.target_image_version IS NOT OLD.target_image_version
  OR NEW.target_image_checksum IS NOT OLD.target_image_checksum
  OR NEW.target_provider_image_id IS NOT OLD.target_provider_image_id
  OR NEW.node_desired_revision <> OLD.node_desired_revision
  OR NEW.prepared_operation_id IS NOT OLD.prepared_operation_id
  OR NEW.prepared_audit_event_id IS NOT OLD.prepared_audit_event_id
  OR NEW.prepared_outbox_event_id IS NOT OLD.prepared_outbox_event_id
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.prepared_at IS NOT OLD.prepared_at
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.state = 'prepared' AND NEW.state NOT IN ('prepared', 'provider-rebuilding', 'awaiting-agent', 'blocked'))
  OR (OLD.state = 'provider-rebuilding' AND NEW.state NOT IN ('provider-rebuilding', 'awaiting-agent', 'blocked'))
  OR (OLD.state = 'awaiting-agent' AND NEW.state NOT IN ('awaiting-agent', 'blocked', 'ready'))
  OR (OLD.state IN ('blocked', 'ready') AND NEW.state <> OLD.state)
  OR (NEW.state = 'prepared' AND NEW.provider_observed_at IS NOT NULL)
  OR (NEW.state IN ('provider-rebuilding', 'awaiting-agent', 'blocked')
    AND NEW.provider_observed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild bootstrap transition fence failed');
END;

-- Immutable record of the exact new credential/session/observation that made
-- the rebuilt node ready. The row is inserted only in the final completion
-- batch; it is the recovery authority after a lost Workflow response.
CREATE TABLE node_lifecycle_rebuild_ready_receipts (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  session_version INTEGER NOT NULL CHECK (session_version > 0),
  observation_sequence INTEGER NOT NULL CHECK (observation_sequence > 0),
  observation_revision INTEGER NOT NULL CHECK (observation_revision > 0),
  observation_fingerprint TEXT NOT NULL CHECK (
    length(observation_fingerprint) = 64 AND observation_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  completion_operation_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (completion_operation_id),
  UNIQUE (audit_event_id),
  UNIQUE (organization_id, outbox_event_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES node_lifecycle_rebuild_bootstraps(organization_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, completion_operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outbox_event_id)
    REFERENCES outbox(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_lifecycle_rebuild_ready_receipt_immutable_update
BEFORE UPDATE ON node_lifecycle_rebuild_ready_receipts
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild ready receipt is immutable');
END;

CREATE TRIGGER node_lifecycle_rebuild_ready_receipt_immutable_delete
BEFORE DELETE ON node_lifecycle_rebuild_ready_receipts
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild ready receipt cannot be deleted');
END;

-- Cloudflare D1 enforces SQLITE_MAX_EXPR_DEPTH=100. Keep the receipt fence as
-- three independently failing guards rather than one left-deep AND tree. Every
-- guard is bound to the same immutable NEW coordinates; all three must pass.
CREATE TRIGGER node_lifecycle_rebuild_ready_receipt_authority_guard
BEFORE INSERT ON node_lifecycle_rebuild_ready_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM node_lifecycle_rebuild_bootstraps bootstrap
  JOIN node_lifecycle_runs run
    ON run.organization_id = bootstrap.organization_id AND run.operation_id = bootstrap.operation_id
  JOIN destructive_lifecycle_operations lifecycle
    ON lifecycle.organization_id = run.organization_id AND lifecycle.operation_id = run.operation_id
  JOIN operations operation
    ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
  JOIN operation_cancellation_facts facts
    ON facts.organization_id = run.organization_id AND facts.operation_id = run.operation_id
  JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
  JOIN node_registration_tokens token
    ON token.organization_id = bootstrap.organization_id
   AND token.node_id = bootstrap.node_id
   AND token.operation_id = bootstrap.operation_id
   AND token.token_hash = bootstrap.token_hash
  JOIN node_credentials credential
    ON credential.organization_id = token.organization_id
   AND credential.node_id = token.node_id AND credential.id = token.credential_id
  JOIN agent_sessions session
    ON session.organization_id = credential.organization_id
   AND session.node_id = credential.node_id AND session.credential_id = credential.id
  JOIN agent_observation_streams stream
    ON stream.organization_id = session.organization_id AND stream.node_id = session.node_id
  WHERE bootstrap.organization_id = NEW.organization_id
    AND bootstrap.operation_id = NEW.operation_id
    AND bootstrap.node_id = NEW.node_id
    AND bootstrap.state = 'awaiting-agent'
    AND run.action = 'rebuild-node' AND run.state = 'completed'
    AND lifecycle.action = 'rebuild-node' AND lifecycle.state = 'succeeded'
    AND operation.type = 'rebuild-node' AND operation.resource_type = 'node'
    AND operation.resource_id = bootstrap.node_id AND operation.status = 'succeeded'
    AND operation.progress = 100 AND facts.phase = 'terminal'
    AND node.pending_lifecycle_operation_id IS NULL
    AND node.desired_state = 'ready' AND node.observed_state = 'ready'
    AND node.desired_revision = bootstrap.node_desired_revision + 1
    AND node.observed_revision = NEW.observation_revision
    AND node.image_id = bootstrap.target_image_id
    AND node.provider_type = bootstrap.provider_type
    AND node.provider_instance_id = bootstrap.provider_instance_id
    AND token.expires_at = bootstrap.expires_at AND token.consumed_at IS NOT NULL
    AND token.revoked_at IS NULL AND token.credential_id = NEW.credential_id
    AND credential.status = 'active' AND credential.version = NEW.credential_version
    AND session.session_state = 'connected' AND session.session_version = NEW.session_version
    AND stream.credential_id = NEW.credential_id
    AND stream.credential_version = NEW.credential_version
    AND stream.session_version = NEW.session_version
    AND stream.last_sequence = NEW.observation_sequence
    AND stream.last_observed_revision = NEW.observation_revision
    AND stream.last_fingerprint = NEW.observation_fingerprint
    AND NOT EXISTS (
      SELECT 1 FROM node_credentials old_credential
      WHERE old_credential.organization_id = bootstrap.organization_id
        AND old_credential.node_id = bootstrap.node_id
        AND old_credential.id <> NEW.credential_id AND old_credential.status = 'active'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild ready receipt authority fence failed');
END;

CREATE TRIGGER node_lifecycle_rebuild_ready_receipt_observation_guard
BEFORE INSERT ON node_lifecycle_rebuild_ready_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM node_lifecycle_rebuild_bootstraps bootstrap
  JOIN agent_observation_streams stream
    ON stream.organization_id = bootstrap.organization_id AND stream.node_id = bootstrap.node_id
  JOIN agent_machine_audit_receipts observation
    ON observation.organization_id = stream.organization_id
   AND observation.kind = 'observation'
   AND observation.node_id = stream.node_id
   AND observation.credential_id = stream.credential_id
   AND observation.credential_version = stream.credential_version
   AND observation.session_version = stream.session_version
   AND observation.effect_key = stream.last_fingerprint
   AND observation.observation_sequence = stream.last_sequence
   AND observation.observation_revision = stream.last_observed_revision
   AND observation.result = 'succeeded'
  JOIN node_images image ON image.id = bootstrap.target_image_id
  JOIN agent_observation_aggregates agent
    ON agent.organization_id = stream.organization_id AND agent.node_id = stream.node_id
   AND agent.fact_kind = 'agent'
  JOIN agent_observation_aggregates image_fact
    ON image_fact.organization_id = stream.organization_id AND image_fact.node_id = stream.node_id
   AND image_fact.fact_kind = 'image'
  JOIN agent_observation_aggregates tunnel_fact
    ON tunnel_fact.organization_id = stream.organization_id AND tunnel_fact.node_id = stream.node_id
   AND tunnel_fact.fact_kind = 'tunnel'
  JOIN agent_observation_aggregates docker
    ON docker.organization_id = stream.organization_id AND docker.node_id = stream.node_id
   AND docker.fact_kind = 'docker'
  JOIN agent_observation_aggregates firewall
    ON firewall.organization_id = stream.organization_id AND firewall.node_id = stream.node_id
   AND firewall.fact_kind = 'firewall'
  JOIN agent_observation_aggregates capacity
    ON capacity.organization_id = stream.organization_id AND capacity.node_id = stream.node_id
   AND capacity.fact_kind = 'capacity'
  JOIN tunnels tunnel ON tunnel.organization_id = stream.organization_id AND tunnel.node_id = stream.node_id
  JOIN node_runtime_capacity runtime_capacity
    ON runtime_capacity.organization_id = stream.organization_id AND runtime_capacity.node_id = stream.node_id
  WHERE bootstrap.organization_id = NEW.organization_id
    AND bootstrap.operation_id = NEW.operation_id
    AND bootstrap.node_id = NEW.node_id
    AND bootstrap.state = 'awaiting-agent'
    AND stream.credential_id = NEW.credential_id
    AND stream.credential_version = NEW.credential_version
    AND stream.session_version = NEW.session_version
    AND stream.last_sequence = NEW.observation_sequence
    AND stream.last_observed_revision = NEW.observation_revision
    AND stream.last_fingerprint = NEW.observation_fingerprint
    AND image.version = bootstrap.target_image_version
    AND image.checksum = bootstrap.target_image_checksum AND image.status = 'promoted'
    AND agent.sequence = stream.last_sequence AND agent.observed_revision = stream.last_observed_revision
    AND json_extract(agent.summary_json, '$.ready') = 1
    AND image_fact.sequence = stream.last_sequence
    AND image_fact.observed_revision = stream.last_observed_revision
    AND json_extract(image_fact.summary_json, '$.ready') = 1
    AND json_extract(image_fact.summary_json, '$.signatureVerified') = 1
    AND json_extract(image_fact.summary_json, '$.imageId') = bootstrap.target_image_id
    AND json_extract(image_fact.summary_json, '$.imageVersion') = bootstrap.target_image_version
    AND json_extract(image_fact.summary_json, '$.checksum') = bootstrap.target_image_checksum
    AND tunnel_fact.sequence = stream.last_sequence
    AND tunnel_fact.observed_revision = stream.last_observed_revision
    AND json_extract(tunnel_fact.summary_json, '$.ready') = 1
    AND json_extract(tunnel_fact.summary_json, '$.state') = 'connected'
    AND tunnel.state = 'connected'
    AND docker.sequence = stream.last_sequence AND docker.observed_revision = stream.last_observed_revision
    AND json_extract(docker.summary_json, '$.ready') = 1
    AND json_extract(docker.summary_json, '$.storageDriver') = 'overlay2'
    AND json_extract(docker.summary_json, '$.projectQuotaReady') = 1
    AND json_extract(docker.summary_json, '$.privilegedContainers') = 0
    AND json_extract(docker.summary_json, '$.dockerSocketMounted') = 0
    AND firewall.sequence = stream.last_sequence
    AND firewall.observed_revision = stream.last_observed_revision
    AND json_extract(firewall.summary_json, '$.ready') = 1
    AND json_extract(firewall.summary_json, '$.defaultDeny') = 1
    AND capacity.sequence = stream.last_sequence
    AND capacity.observed_revision = stream.last_observed_revision
    AND runtime_capacity.agent_ready = 1 AND runtime_capacity.tunnel_ready = 1
    AND runtime_capacity.docker_ready = 1 AND runtime_capacity.firewall_ready = 1
    AND runtime_capacity.reported_at = NEW.completed_at
    AND runtime_capacity.architecture = json_extract(capacity.summary_json, '$.architecture')
    AND runtime_capacity.cpu_millis = json_extract(capacity.summary_json, '$.cpuMillis')
    AND runtime_capacity.ram_bytes = json_extract(capacity.summary_json, '$.ramBytes')
    AND runtime_capacity.disk_bytes = json_extract(capacity.summary_json, '$.diskBytes')
)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild ready receipt observation fence failed');
END;

CREATE TRIGGER node_lifecycle_rebuild_ready_receipt_completion_guard
BEFORE INSERT ON node_lifecycle_rebuild_ready_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM node_lifecycle_rebuild_bootstraps bootstrap
  JOIN node_lifecycle_runs run
    ON run.organization_id = bootstrap.organization_id AND run.operation_id = bootstrap.operation_id
  JOIN operations operation
    ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
  JOIN operations completion
    ON completion.organization_id = run.organization_id AND completion.id = NEW.completion_operation_id
  JOIN audit_events audit ON audit.id = NEW.audit_event_id
  JOIN audit_event_envelopes envelope ON envelope.event_id = audit.id
  JOIN outbox event
    ON event.organization_id = run.organization_id AND event.id = NEW.outbox_event_id
  WHERE bootstrap.organization_id = NEW.organization_id
    AND bootstrap.operation_id = NEW.operation_id
    AND bootstrap.node_id = NEW.node_id
    AND completion.type = 'node.rebuild.ready' AND completion.resource_type = 'node'
    AND completion.resource_id = bootstrap.node_id AND completion.status = 'succeeded'
    AND completion.progress = 100 AND completion.correlation_id = operation.correlation_id
    AND audit.organization_id = run.organization_id AND audit.actor_id = operation.actor_id
    AND audit.action = 'node.rebuild.ready' AND audit.target_type = 'node'
    AND audit.target_id = bootstrap.node_id AND audit.result = 'succeeded'
    AND audit.correlation_id = operation.correlation_id AND audit.created_at = NEW.completed_at
    AND envelope.scope = 'tenant' AND envelope.organization_id = run.organization_id
    AND envelope.schema_version = 1 AND envelope.capture_status = 'complete'
    AND json_extract(envelope.envelope_json, '$.operationId') = completion.id
    AND json_extract(envelope.envelope_json, '$.source.origin') = 'machine'
    AND event.event_type = 'node.rebuild.ready'
    AND event.aggregate_type = 'node' AND event.aggregate_id = bootstrap.node_id
    AND EXISTS (
      SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
      WHERE receipt.organization_id = run.organization_id AND receipt.operation_id = run.operation_id
        AND receipt.receipt_key = 'node-rebuild-ready'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild ready receipt completion fence failed');
END;

CREATE TRIGGER node_lifecycle_rebuild_bootstrap_ready_guard
BEFORE UPDATE OF state ON node_lifecycle_rebuild_bootstraps
WHEN NEW.state = 'ready' AND NOT EXISTS (
  SELECT 1
  FROM node_lifecycle_rebuild_ready_receipts receipt
  WHERE receipt.organization_id = NEW.organization_id AND receipt.operation_id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'node lifecycle rebuild ready state requires receipt');
END;

-- Keep the original provision authority and add the immutable rebuild
-- bootstrap authority. The observation fences below retain their exact port,
-- image-signature, and capacity checks; only the immutable image source is
-- generalized.
CREATE VIEW node_observation_image_authority AS
SELECT acceptance.organization_id,
  acceptance.node_id,
  acceptance.image_id,
  acceptance.image_version,
  acceptance.image_checksum,
  acceptance.provider_account_id,
  acceptance.provider_type,
  acceptance.region,
  acceptance.plan,
  acceptance.provider_image_id
FROM node_provision_acceptances acceptance
UNION ALL
SELECT bootstrap.organization_id,
  bootstrap.node_id,
  bootstrap.target_image_id AS image_id,
  bootstrap.target_image_version AS image_version,
  bootstrap.target_image_checksum AS image_checksum,
  node.provider_account_id,
  bootstrap.provider_type,
  node.region,
  node.plan,
  bootstrap.target_provider_image_id AS provider_image_id
FROM node_lifecycle_rebuild_bootstraps bootstrap
JOIN nodes node
  ON node.organization_id = bootstrap.organization_id AND node.id = bootstrap.node_id
WHERE bootstrap.state IN ('prepared', 'provider-rebuilding', 'awaiting-agent', 'ready')
  AND node.image_id = bootstrap.target_image_id
  AND node.provider_type = bootstrap.provider_type
  AND node.provider_instance_id = bootstrap.provider_instance_id;

DROP TRIGGER agent_observation_readiness_insert_fence;
DROP TRIGGER agent_observation_readiness_update_fence;

CREATE TRIGGER agent_observation_readiness_insert_fence
BEFORE INSERT ON agent_observation_streams
WHEN (NEW.observed_state = 'ready') IS NOT (NEW.capacity_published = 1)
  OR (NEW.capacity_published = 1 AND NOT (
    EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'agent' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1)
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      JOIN nodes node ON node.organization_id = fact.organization_id AND node.id = fact.node_id
      JOIN node_images image ON image.id = node.image_id
      JOIN node_observation_image_authority acceptance
        ON acceptance.organization_id = node.organization_id AND acceptance.node_id = node.id
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'image' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.signatureVerified') = 1
        AND json_extract(fact.summary_json, '$.imageId') = node.image_id
        AND json_extract(fact.summary_json, '$.imageVersion') = image.version
        AND json_extract(fact.summary_json, '$.checksum') = image.checksum
        AND image.status = 'promoted'
        AND json_valid(image.signature) AND json_type(image.signature) = 'object'
        AND (SELECT COUNT(*) FROM json_each(image.signature)) = 5
        AND NOT EXISTS (SELECT 1 FROM json_each(image.signature) member
          WHERE member.key NOT IN ('schemaVersion', 'algorithm',
            'buildIdentityManifestSha256', 'buildIdentitySignatureSha256',
            'buildIdentityPublicKeySha256'))
        AND json_type(image.signature, '$.schemaVersion') = 'integer'
        AND json_extract(image.signature, '$.schemaVersion') = 1
        AND json_type(image.signature, '$.algorithm') = 'text'
        AND json_extract(image.signature, '$.algorithm') = 'ed25519'
        AND json_extract(fact.summary_json, '$.buildIdentityManifestSha256') =
          json_extract(image.signature, '$.buildIdentityManifestSha256')
        AND json_extract(fact.summary_json, '$.buildIdentitySignatureSha256') =
          json_extract(image.signature, '$.buildIdentitySignatureSha256')
        AND json_extract(fact.summary_json, '$.buildIdentityPublicKeySha256') =
          json_extract(image.signature, '$.buildIdentityPublicKeySha256')
        AND length(json_extract(image.signature, '$.buildIdentityManifestSha256')) = 71
        AND json_extract(image.signature, '$.buildIdentityManifestSha256') GLOB 'sha256:*'
        AND substr(json_extract(image.signature, '$.buildIdentityManifestSha256'), 8)
          NOT GLOB '*[^0-9a-f]*'
        AND length(json_extract(image.signature, '$.buildIdentitySignatureSha256')) = 71
        AND json_extract(image.signature, '$.buildIdentitySignatureSha256') GLOB 'sha256:*'
        AND substr(json_extract(image.signature, '$.buildIdentitySignatureSha256'), 8)
          NOT GLOB '*[^0-9a-f]*'
        AND length(json_extract(image.signature, '$.buildIdentityPublicKeySha256')) = 71
        AND json_extract(image.signature, '$.buildIdentityPublicKeySha256') GLOB 'sha256:*'
        AND substr(json_extract(image.signature, '$.buildIdentityPublicKeySha256'), 8)
          NOT GLOB '*[^0-9a-f]*'
        AND acceptance.image_id = image.id
        AND acceptance.image_version = image.version
        AND acceptance.image_checksum = image.checksum
        AND acceptance.provider_account_id = node.provider_account_id
        AND acceptance.provider_type = node.provider_type
        AND acceptance.region = node.region AND acceptance.plan = node.plan
        AND json_extract(
          image.provider_mappings_json,
          '$."' || acceptance.provider_type || '"."' || acceptance.region || '"'
        ) = acceptance.provider_image_id)
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      JOIN tunnels tunnel ON tunnel.organization_id = fact.organization_id AND tunnel.node_id = fact.node_id
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'tunnel' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.state') = 'connected'
        AND tunnel.state = 'connected')
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'docker' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.storageDriver') = 'overlay2'
        AND json_extract(fact.summary_json, '$.projectQuotaReady') = 1
        AND json_extract(fact.summary_json, '$.privilegedContainers') = 0
        AND json_extract(fact.summary_json, '$.dockerSocketMounted') = 0)
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'firewall' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.defaultDeny') = 1
        AND json_type(fact.summary_json, '$.allowedTcpPorts') = 'array'
        AND json_type(fact.summary_json, '$.allowedUdpPorts') = 'array'
        AND json_array_length(json_extract(fact.summary_json, '$.allowedTcpPorts')) =
          (SELECT COUNT(*) FROM port_leases lease
           WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
             AND lease.protocol = 'tcp' AND lease.state <> 'released')
        AND json_array_length(json_extract(fact.summary_json, '$.allowedUdpPorts')) =
          (SELECT COUNT(*) FROM port_leases lease
           WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
             AND lease.protocol = 'udp' AND lease.state <> 'released')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedTcpPorts') reported
          GROUP BY reported.value HAVING COUNT(*) <> 1)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedUdpPorts') reported
          GROUP BY reported.value HAVING COUNT(*) <> 1)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedTcpPorts') reported
          WHERE reported.type <> 'integer' OR NOT EXISTS (
            SELECT 1 FROM port_leases lease
            WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
              AND lease.protocol = 'tcp' AND lease.state <> 'released'
              AND lease.public_port = reported.value))
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedUdpPorts') reported
          WHERE reported.type <> 'integer' OR NOT EXISTS (
            SELECT 1 FROM port_leases lease
            WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
              AND lease.protocol = 'udp' AND lease.state <> 'released'
              AND lease.public_port = reported.value)))
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      JOIN node_runtime_capacity capacity
        ON capacity.organization_id = fact.organization_id AND capacity.node_id = fact.node_id
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'capacity' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.architecture') = capacity.architecture
        AND json_extract(fact.summary_json, '$.cpuMillis') = capacity.cpu_millis
        AND json_extract(fact.summary_json, '$.ramBytes') = capacity.ram_bytes
        AND json_extract(fact.summary_json, '$.diskBytes') = capacity.disk_bytes)
  ))
BEGIN
  SELECT RAISE(ABORT, 'agent observation readiness fence failed');
END;

CREATE TRIGGER agent_observation_readiness_update_fence
BEFORE UPDATE ON agent_observation_streams
WHEN (NEW.observed_state = 'ready') IS NOT (NEW.capacity_published = 1)
  OR (NEW.capacity_published = 1 AND NOT (
    EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'agent' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1)
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      JOIN nodes node ON node.organization_id = fact.organization_id AND node.id = fact.node_id
      JOIN node_images image ON image.id = node.image_id
      JOIN node_observation_image_authority acceptance
        ON acceptance.organization_id = node.organization_id AND acceptance.node_id = node.id
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'image' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.signatureVerified') = 1
        AND json_extract(fact.summary_json, '$.imageId') = node.image_id
        AND json_extract(fact.summary_json, '$.imageVersion') = image.version
        AND json_extract(fact.summary_json, '$.checksum') = image.checksum
        AND image.status = 'promoted'
        AND json_valid(image.signature) AND json_type(image.signature) = 'object'
        AND (SELECT COUNT(*) FROM json_each(image.signature)) = 5
        AND NOT EXISTS (SELECT 1 FROM json_each(image.signature) member
          WHERE member.key NOT IN ('schemaVersion', 'algorithm',
            'buildIdentityManifestSha256', 'buildIdentitySignatureSha256',
            'buildIdentityPublicKeySha256'))
        AND json_type(image.signature, '$.schemaVersion') = 'integer'
        AND json_extract(image.signature, '$.schemaVersion') = 1
        AND json_type(image.signature, '$.algorithm') = 'text'
        AND json_extract(image.signature, '$.algorithm') = 'ed25519'
        AND json_extract(fact.summary_json, '$.buildIdentityManifestSha256') =
          json_extract(image.signature, '$.buildIdentityManifestSha256')
        AND json_extract(fact.summary_json, '$.buildIdentitySignatureSha256') =
          json_extract(image.signature, '$.buildIdentitySignatureSha256')
        AND json_extract(fact.summary_json, '$.buildIdentityPublicKeySha256') =
          json_extract(image.signature, '$.buildIdentityPublicKeySha256')
        AND length(json_extract(image.signature, '$.buildIdentityManifestSha256')) = 71
        AND json_extract(image.signature, '$.buildIdentityManifestSha256') GLOB 'sha256:*'
        AND substr(json_extract(image.signature, '$.buildIdentityManifestSha256'), 8)
          NOT GLOB '*[^0-9a-f]*'
        AND length(json_extract(image.signature, '$.buildIdentitySignatureSha256')) = 71
        AND json_extract(image.signature, '$.buildIdentitySignatureSha256') GLOB 'sha256:*'
        AND substr(json_extract(image.signature, '$.buildIdentitySignatureSha256'), 8)
          NOT GLOB '*[^0-9a-f]*'
        AND length(json_extract(image.signature, '$.buildIdentityPublicKeySha256')) = 71
        AND json_extract(image.signature, '$.buildIdentityPublicKeySha256') GLOB 'sha256:*'
        AND substr(json_extract(image.signature, '$.buildIdentityPublicKeySha256'), 8)
          NOT GLOB '*[^0-9a-f]*'
        AND acceptance.image_id = image.id
        AND acceptance.image_version = image.version
        AND acceptance.image_checksum = image.checksum
        AND acceptance.provider_account_id = node.provider_account_id
        AND acceptance.provider_type = node.provider_type
        AND acceptance.region = node.region AND acceptance.plan = node.plan
        AND json_extract(
          image.provider_mappings_json,
          '$."' || acceptance.provider_type || '"."' || acceptance.region || '"'
        ) = acceptance.provider_image_id)
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      JOIN tunnels tunnel ON tunnel.organization_id = fact.organization_id AND tunnel.node_id = fact.node_id
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'tunnel' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.state') = 'connected'
        AND tunnel.state = 'connected')
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'docker' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.storageDriver') = 'overlay2'
        AND json_extract(fact.summary_json, '$.projectQuotaReady') = 1
        AND json_extract(fact.summary_json, '$.privilegedContainers') = 0
        AND json_extract(fact.summary_json, '$.dockerSocketMounted') = 0)
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'firewall' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.ready') = 1
        AND json_extract(fact.summary_json, '$.defaultDeny') = 1
        AND json_type(fact.summary_json, '$.allowedTcpPorts') = 'array'
        AND json_type(fact.summary_json, '$.allowedUdpPorts') = 'array'
        AND json_array_length(json_extract(fact.summary_json, '$.allowedTcpPorts')) =
          (SELECT COUNT(*) FROM port_leases lease
           WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
             AND lease.protocol = 'tcp' AND lease.state <> 'released')
        AND json_array_length(json_extract(fact.summary_json, '$.allowedUdpPorts')) =
          (SELECT COUNT(*) FROM port_leases lease
           WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
             AND lease.protocol = 'udp' AND lease.state <> 'released')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedTcpPorts') reported
          GROUP BY reported.value HAVING COUNT(*) <> 1)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedUdpPorts') reported
          GROUP BY reported.value HAVING COUNT(*) <> 1)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedTcpPorts') reported
          WHERE reported.type <> 'integer' OR NOT EXISTS (
            SELECT 1 FROM port_leases lease
            WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
              AND lease.protocol = 'tcp' AND lease.state <> 'released'
              AND lease.public_port = reported.value))
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fact.summary_json, '$.allowedUdpPorts') reported
          WHERE reported.type <> 'integer' OR NOT EXISTS (
            SELECT 1 FROM port_leases lease
            WHERE lease.organization_id = fact.organization_id AND lease.node_id = fact.node_id
              AND lease.protocol = 'udp' AND lease.state <> 'released'
              AND lease.public_port = reported.value)))
    AND EXISTS (SELECT 1 FROM agent_observation_aggregates fact
      JOIN node_runtime_capacity capacity
        ON capacity.organization_id = fact.organization_id AND capacity.node_id = fact.node_id
      WHERE fact.organization_id = NEW.organization_id AND fact.node_id = NEW.node_id
        AND fact.fact_kind = 'capacity' AND fact.sequence = NEW.last_sequence
        AND json_extract(fact.summary_json, '$.architecture') = capacity.architecture
        AND json_extract(fact.summary_json, '$.cpuMillis') = capacity.cpu_millis
        AND json_extract(fact.summary_json, '$.ramBytes') = capacity.ram_bytes
        AND json_extract(fact.summary_json, '$.diskBytes') = capacity.disk_bytes)
  ))
BEGIN
  SELECT RAISE(ABORT, 'agent observation readiness fence failed');
END;

PRAGMA foreign_keys = ON;

-- A game observation is evidence for terminal completion, not terminal
-- completion itself.  Keeping the accepted operation pending lets the
-- completion receipt atomically advance its revision, clear the pending
-- pointer, and bind the audit evidence in one D1 transaction.
DROP TRIGGER IF EXISTS game_observation_operation_completion;
DROP TRIGGER IF EXISTS game_observation_reduction_apply;

CREATE TRIGGER game_observation_reduction_apply
AFTER INSERT ON game_observation_reductions
BEGIN
  UPDATE game_servers
  SET observed_state = NEW.observed_state,
      observed_revision = NEW.observed_revision,
      reconciliation_error = CASE
        WHEN NEW.observed_state = 'failed' THEN json_extract(NEW.observation_json, '$.error')
        ELSE NULL
      END,
      last_reconciled_at = NEW.observed_at,
      updated_at = NEW.observed_at
  WHERE organization_id = NEW.organization_id AND id = NEW.server_id
    AND observed_revision + 1 = NEW.observed_revision;
END;

-- Historical receipts predate the parent-operation terminalization fence, so
-- they deliberately retain an unknown parent revision.  New receipts must
-- provide a real revision through the insert fence below; using a fabricated
-- default would make an old child-completion record look like proof that its
-- original accepted operation was terminalized.
ALTER TABLE game_lifecycle_completion_receipts
  ADD COLUMN lifecycle_operation_revision INTEGER
    CHECK (lifecycle_operation_revision IS NULL OR lifecycle_operation_revision > 1);

-- The receipt's parent revision is an immutable proof that the original
-- accepted lifecycle operation, rather than only a synthetic child audit
-- operation, was terminalized by the completion transaction.
CREATE TRIGGER game_lifecycle_completion_receipt_parent_terminal_fence
BEFORE INSERT ON game_lifecycle_completion_receipts
WHEN NEW.step_name <> CASE WHEN NEW.action = 'create' THEN 'publish-endpoint' ELSE 'verify-observation' END
OR NOT EXISTS (
  SELECT 1
  FROM operations lifecycle
  JOIN game_servers server
    ON server.organization_id = lifecycle.organization_id
   AND server.id = NEW.server_id
  WHERE lifecycle.organization_id = NEW.organization_id
    AND lifecycle.id = NEW.lifecycle_operation_id
    AND lifecycle.resource_type = 'server'
    AND lifecycle.resource_id = NEW.server_id
    AND lifecycle.status = 'succeeded'
    AND lifecycle.progress = 100
    AND lifecycle.revision = NEW.lifecycle_operation_revision
    AND lifecycle.updated_at = NEW.created_at
    AND server.pending_lifecycle_operation_id IS NULL
    AND server.updated_at = NEW.created_at
    AND server.desired_revision = server.observed_revision
    AND server.desired_state = CASE NEW.action
      WHEN 'delete' THEN 'deleted'
      WHEN 'stop' THEN 'stopped'
      ELSE 'running'
    END
    AND server.observed_state = server.desired_state
    AND (
      (NEW.action = 'move' AND EXISTS (
        SELECT 1
        FROM game_lifecycle_moves move
        WHERE move.organization_id = lifecycle.organization_id
          AND move.operation_id = lifecycle.id
          AND move.server_id = NEW.server_id
          AND move.phase = 'released'
          AND server.observed_revision = move.expected_revision + 1
      ))
      OR
      (NEW.action <> 'move' AND EXISTS (
        SELECT 1
        FROM game_lifecycle_mutations mutation
        WHERE mutation.organization_id = lifecycle.organization_id
          AND mutation.operation_id = lifecycle.id
          AND mutation.server_id = NEW.server_id
          AND mutation.action = NEW.action
          AND server.observed_revision = mutation.expected_revision + 1
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle completion parent terminal fence failed');
END;

DROP TRIGGER IF EXISTS game_lifecycle_completion_receipt_immutable_update;
CREATE TRIGGER game_lifecycle_completion_receipt_immutable_update
BEFORE UPDATE ON game_lifecycle_completion_receipts
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.lifecycle_operation_id IS NOT OLD.lifecycle_operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.action IS NOT OLD.action
  OR NEW.step_name IS NOT OLD.step_name
  OR NEW.completion_operation_id IS NOT OLD.completion_operation_id
  OR NEW.completion_event_id IS NOT OLD.completion_event_id
  OR NEW.acceptance_audit_event_id IS NOT OLD.acceptance_audit_event_id
  OR NEW.evidence_json IS NOT OLD.evidence_json
  OR NEW.state IS NOT OLD.state
  OR NEW.lifecycle_operation_revision IS NOT OLD.lifecycle_operation_revision
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle completion receipt is immutable');
END;

-- Provider/agent discovery writes the node's actually reachable player
-- endpoint here.  Lifecycle acceptance snapshots this evidence; it never
-- substitutes an environment-wide DNS target or a placeholder string.
CREATE TABLE node_player_endpoints (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('A', 'AAAA')),
  target TEXT NOT NULL CHECK (
    length(target) BETWEEN 3 AND 255
    AND target <> 'pending'
    AND ((record_type = 'A' AND target GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*')
      OR (record_type = 'AAAA' AND instr(target, ':') > 0))
  ),
  source TEXT NOT NULL CHECK (source IN ('provider', 'agent')),
  observed_revision INTEGER NOT NULL CHECK (observed_revision > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id, record_type),
  FOREIGN KEY (organization_id, node_id, provider_instance_id)
    REFERENCES nodes(organization_id, id, provider_instance_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER node_player_endpoint_update_fence
BEFORE UPDATE ON node_player_endpoints
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
  OR NEW.record_type IS NOT OLD.record_type
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NEW.target = 'pending'
  OR NOT (
    (NEW.record_type = 'A' AND NEW.target GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*')
    OR (NEW.record_type = 'AAAA' AND instr(NEW.target, ':') > 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'node player endpoint update fence failed');
END;

-- A hostname publication is bound to the exact accepted deployment/node and
-- its provider-backed endpoint.  `zone_id` is recorded with the resulting
-- provider receipt rather than inferred from a shared target configuration.
CREATE TABLE game_lifecycle_dns_authorities (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('A', 'AAAA')),
  target TEXT NOT NULL CHECK (target <> 'pending'),
  endpoint_revision INTEGER NOT NULL CHECK (endpoint_revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, server_id, operation_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id, provider_instance_id)
    REFERENCES nodes(organization_id, id, provider_instance_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_dns_authority_scope_guard
BEFORE INSERT ON game_lifecycle_dns_authorities
WHEN NOT EXISTS (
  SELECT 1
  FROM operations lifecycle
  JOIN game_servers server
    ON server.organization_id = lifecycle.organization_id
   AND server.id = NEW.server_id
  JOIN game_lifecycle_mutations mutation
    ON mutation.organization_id = lifecycle.organization_id
   AND mutation.operation_id = lifecycle.id
   AND mutation.action = 'create'
  JOIN deployments deployment
    ON deployment.organization_id = lifecycle.organization_id
   AND deployment.id = NEW.deployment_id
   AND deployment.server_id = NEW.server_id
   AND deployment.node_id = NEW.node_id
  JOIN nodes node
    ON node.organization_id = lifecycle.organization_id
   AND node.id = NEW.node_id
   AND node.provider_instance_id = NEW.provider_instance_id
   AND node.desired_state = 'ready'
   AND node.observed_state = 'ready'
  JOIN node_player_endpoints endpoint
    ON endpoint.organization_id = node.organization_id
   AND endpoint.node_id = node.id
   AND endpoint.provider_instance_id = node.provider_instance_id
   AND endpoint.record_type = NEW.record_type
   AND endpoint.target = NEW.target
   AND endpoint.revision = NEW.endpoint_revision
  WHERE lifecycle.organization_id = NEW.organization_id
    AND lifecycle.id = NEW.operation_id
    AND lifecycle.type = 'server.create'
    AND lifecycle.resource_type = 'server'
    AND lifecycle.resource_id = NEW.server_id
    AND lifecycle.status = 'queued'
    AND server.pending_lifecycle_operation_id = NEW.operation_id
    AND server.domain = NEW.hostname
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle DNS authority fence failed');
END;

CREATE TRIGGER game_lifecycle_dns_authority_immutable_update
BEFORE UPDATE ON game_lifecycle_dns_authorities
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle DNS authority is immutable');
END;

CREATE TRIGGER game_lifecycle_dns_authority_immutable_delete
BEFORE DELETE ON game_lifecycle_dns_authorities
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle DNS authority is immutable');
END;

ALTER TABLE game_dns_lifecycle_receipts
  ADD COLUMN zone_id TEXT NOT NULL DEFAULT 'legacy-zone';

DROP TRIGGER IF EXISTS game_dns_lifecycle_receipt_scope_guard;
CREATE TRIGGER game_dns_lifecycle_receipt_scope_guard
BEFORE INSERT ON game_dns_lifecycle_receipts
WHEN length(NEW.zone_id) = 0
OR NOT EXISTS (
  SELECT 1
  FROM operations operation
  JOIN organizations organization ON organization.id = operation.organization_id
  WHERE operation.organization_id = NEW.organization_id
    AND operation.id = NEW.operation_id
    AND operation.resource_type = 'server'
    AND operation.resource_id = NEW.server_id
    AND organization.status IN ('active', 'deleting')
    AND (
      (NEW.action = 'publish' AND operation.type = 'server.create' AND NEW.state = 'active')
      OR (NEW.action = 'delete' AND operation.type = 'server.delete' AND NEW.state = 'deleted')
    )
)
OR NOT EXISTS (
  SELECT 1
  FROM dns_records record
  WHERE record.organization_id = NEW.organization_id
    AND record.server_id = NEW.server_id
    AND record.hostname = NEW.hostname
    AND record.target = NEW.target
    AND record.state = CASE NEW.action WHEN 'publish' THEN 'active' ELSE 'deleted' END
    AND record.proxy_mode = 'dns_only'
)
OR (NEW.action = 'publish' AND NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_dns_authorities authority
  WHERE authority.organization_id = NEW.organization_id
    AND authority.operation_id = NEW.operation_id
    AND authority.server_id = NEW.server_id
    AND authority.hostname = NEW.hostname
    AND authority.record_type = NEW.record_type
    AND authority.target = NEW.target
))
BEGIN
  SELECT RAISE(ABORT, 'game DNS receipt scope/evidence fence failed');
END;

DROP TRIGGER IF EXISTS game_dns_lifecycle_receipt_immutable;
CREATE TRIGGER game_dns_lifecycle_receipt_immutable
BEFORE UPDATE ON game_dns_lifecycle_receipts
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.action IS NOT OLD.action
  OR NEW.zone_id IS NOT OLD.zone_id
  OR NEW.hostname IS NOT OLD.hostname
  OR NEW.record_type IS NOT OLD.record_type
  OR NEW.target IS NOT OLD.target
  OR NEW.provider_record_id IS NOT OLD.provider_record_id
  OR NEW.provider_result_json IS NOT OLD.provider_result_json
  OR NEW.state IS NOT OLD.state
  OR NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'game DNS receipt is immutable');
END;

-- A move gets its own immutable external-effect record before a restore,
-- validation, endpoint transfer, or source release can run.  It retains exact
-- source/target node/provider/DNS coordinates so both adoption and reverse
-- compensation have no dependency on mutable current topology.
CREATE TABLE game_lifecycle_move_effects (
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  source_deployment_id TEXT NOT NULL,
  source_provider_instance_id TEXT NOT NULL,
  target_provider_instance_id TEXT NOT NULL,
  source_endpoint_revision INTEGER CHECK (source_endpoint_revision IS NULL OR source_endpoint_revision > 0),
  target_endpoint_revision INTEGER CHECK (target_endpoint_revision IS NULL OR target_endpoint_revision > 0),
  dns_zone_id TEXT,
  dns_record_id TEXT,
  dns_hostname TEXT,
  dns_record_type TEXT CHECK (dns_record_type IS NULL OR dns_record_type IN ('A', 'AAAA')),
  dns_provider_record_id TEXT,
  source_target TEXT,
  target_target TEXT,
  snapshot_json TEXT NOT NULL CHECK (
    json_valid(snapshot_json)
    AND json_type(snapshot_json) = 'object'
    AND length(CAST(snapshot_json AS BLOB)) <= 81920
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'cutover', 'released', 'rolled_back')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, effect_id),
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_node_id, source_provider_instance_id)
    REFERENCES nodes(organization_id, id, provider_instance_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_node_id, target_provider_instance_id)
    REFERENCES nodes(organization_id, id, provider_instance_id) ON DELETE RESTRICT,
  CHECK (source_node_id <> target_node_id),
  CHECK ((dns_zone_id IS NULL AND dns_record_id IS NULL AND dns_hostname IS NULL
      AND dns_record_type IS NULL AND dns_provider_record_id IS NULL
      AND source_target IS NULL AND target_target IS NULL)
    OR (dns_zone_id IS NOT NULL AND dns_record_id IS NOT NULL AND dns_hostname IS NOT NULL
      AND dns_record_type IS NOT NULL AND source_target IS NOT NULL AND target_target IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_move_effect_scope_guard
BEFORE INSERT ON game_lifecycle_move_effects
WHEN NEW.effect_id <> 'game-move-effect:' || NEW.operation_id
OR NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_moves move
  JOIN operations operation
    ON operation.organization_id = move.organization_id
   AND operation.id = move.operation_id
  JOIN nodes source
    ON source.organization_id = move.organization_id
   AND source.id = move.source_node_id
   AND source.provider_instance_id = NEW.source_provider_instance_id
  JOIN nodes target
    ON target.organization_id = move.organization_id
   AND target.id = move.target_node_id
   AND target.provider_instance_id = NEW.target_provider_instance_id
  LEFT JOIN node_player_endpoints source_endpoint
    ON source_endpoint.organization_id = source.organization_id
   AND source_endpoint.node_id = source.id
   AND source_endpoint.revision = NEW.source_endpoint_revision
  LEFT JOIN node_player_endpoints target_endpoint
    ON target_endpoint.organization_id = target.organization_id
   AND target_endpoint.node_id = target.id
   AND target_endpoint.record_type = source_endpoint.record_type
   AND target_endpoint.revision = NEW.target_endpoint_revision
  WHERE move.organization_id = NEW.organization_id
    AND move.operation_id = NEW.operation_id
    AND move.server_id = NEW.server_id
    AND move.source_node_id = NEW.source_node_id
    AND move.target_node_id = NEW.target_node_id
    AND move.source_deployment_id = NEW.source_deployment_id
    AND move.phase = 'reserved'
    AND operation.type = 'server.move'
    AND operation.resource_id = NEW.server_id
    AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')
    AND json_extract(NEW.snapshot_json, '$.effectId') = NEW.effect_id
    AND json_extract(NEW.snapshot_json, '$.source.nodeId') = NEW.source_node_id
    AND json_extract(NEW.snapshot_json, '$.target.nodeId') = NEW.target_node_id
    AND (
      NEW.dns_record_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM dns_records record
        WHERE record.organization_id = move.organization_id
          AND record.id = NEW.dns_record_id
          AND record.server_id = move.server_id
          AND record.hostname = NEW.dns_hostname
          AND record.target = NEW.source_target
          AND record.provider_record_id = NEW.dns_provider_record_id
          AND record.state = 'active'
          AND record.proxy_mode = 'dns_only'
          AND source_endpoint.record_type = NEW.dns_record_type
          AND source_endpoint.target = NEW.source_target
          AND target_endpoint.target = NEW.target_target
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move effect fence failed');
END;

CREATE TRIGGER game_lifecycle_move_effect_transition_fence
BEFORE UPDATE ON game_lifecycle_move_effects
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.effect_id IS NOT OLD.effect_id
  OR NEW.source_node_id IS NOT OLD.source_node_id
  OR NEW.target_node_id IS NOT OLD.target_node_id
  OR NEW.source_deployment_id IS NOT OLD.source_deployment_id
  OR NEW.source_provider_instance_id IS NOT OLD.source_provider_instance_id
  OR NEW.target_provider_instance_id IS NOT OLD.target_provider_instance_id
  OR NEW.source_endpoint_revision IS NOT OLD.source_endpoint_revision
  OR NEW.target_endpoint_revision IS NOT OLD.target_endpoint_revision
  OR NEW.dns_zone_id IS NOT OLD.dns_zone_id
  OR NEW.dns_record_id IS NOT OLD.dns_record_id
  OR NEW.dns_hostname IS NOT OLD.dns_hostname
  OR NEW.dns_record_type IS NOT OLD.dns_record_type
  OR NEW.dns_provider_record_id IS NOT OLD.dns_provider_record_id
  OR NEW.source_target IS NOT OLD.source_target
  OR NEW.target_target IS NOT OLD.target_target
  OR NEW.snapshot_json IS NOT OLD.snapshot_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.state = 'prepared' AND NEW.state IN ('cutover', 'rolled_back'))
    OR (OLD.state = 'cutover' AND NEW.state IN ('released', 'rolled_back'))
    OR (OLD.state = 'released' AND NEW.state = 'rolled_back')
    OR (OLD.state = 'rolled_back' AND NEW.state = 'rolled_back')
  )
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move effect transition fence failed');
END;

CREATE TABLE game_lifecycle_move_effect_receipts (
  organization_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('backup', 'restore', 'validate', 'cutover', 'release', 'rollback')),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json)
    AND json_type(receipt_json) = 'object'
    AND length(CAST(receipt_json AS BLOB)) <= 81920
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, effect_id, phase),
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES game_lifecycle_move_effects(organization_id, effect_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_move_effect_receipt_scope_guard
BEFORE INSERT ON game_lifecycle_move_effect_receipts
WHEN json_extract(NEW.receipt_json, '$.effectId') <> NEW.effect_id
OR NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_move_effects effect
  WHERE effect.organization_id = NEW.organization_id
    AND effect.effect_id = NEW.effect_id
    AND (
      (NEW.phase IN ('backup', 'restore', 'validate', 'cutover') AND effect.state = 'prepared')
      OR (NEW.phase = 'release' AND effect.state = 'cutover')
      OR (NEW.phase = 'rollback' AND effect.state IN ('prepared', 'cutover', 'released'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move effect receipt fence failed');
END;

CREATE TRIGGER game_lifecycle_move_effect_receipt_immutable_update
BEFORE UPDATE ON game_lifecycle_move_effect_receipts
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move effect receipt is immutable');
END;

CREATE TRIGGER game_lifecycle_move_effect_receipt_immutable_delete
BEFORE DELETE ON game_lifecycle_move_effect_receipts
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move effect receipt is immutable');
END;

-- Each DNS record's intended before/after tuple exists before Cloudflare is
-- invoked.  Forward and reverse provider responses are append-only receipts,
-- so a response-loss retry can adopt only this operation's exact record.
CREATE TABLE game_lifecycle_move_dns_effects (
  organization_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('A', 'AAAA')),
  provider_record_id TEXT,
  source_target TEXT NOT NULL,
  target_target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, effect_id, record_id),
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES game_lifecycle_move_effects(organization_id, effect_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_move_dns_effect_scope_guard
BEFORE INSERT ON game_lifecycle_move_dns_effects
WHEN NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_move_effects effect
  WHERE effect.organization_id = NEW.organization_id
    AND effect.effect_id = NEW.effect_id
    AND effect.state = 'prepared'
    AND effect.dns_zone_id = NEW.zone_id
    AND effect.dns_record_id = NEW.record_id
    AND effect.dns_hostname = NEW.hostname
    AND effect.dns_record_type = NEW.record_type
    AND effect.dns_provider_record_id IS NEW.provider_record_id
    AND effect.source_target = NEW.source_target
    AND effect.target_target = NEW.target_target
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move DNS effect fence failed');
END;

CREATE TRIGGER game_lifecycle_move_dns_effect_immutable_update
BEFORE UPDATE ON game_lifecycle_move_dns_effects
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move DNS effect is immutable');
END;

CREATE TRIGGER game_lifecycle_move_dns_effect_immutable_delete
BEFORE DELETE ON game_lifecycle_move_dns_effects
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move DNS effect is immutable');
END;

CREATE TABLE game_lifecycle_move_dns_receipts (
  organization_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('forward', 'rollback')),
  provider_record_id TEXT,
  provider_result_json TEXT NOT NULL CHECK (
    json_valid(provider_result_json)
    AND length(CAST(provider_result_json AS BLOB)) <= 81920
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, effect_id, record_id, direction),
  FOREIGN KEY (organization_id, effect_id, record_id)
    REFERENCES game_lifecycle_move_dns_effects(organization_id, effect_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_move_dns_receipt_scope_guard
BEFORE INSERT ON game_lifecycle_move_dns_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_move_effects effect
  JOIN game_lifecycle_move_dns_effects dns
    ON dns.organization_id = effect.organization_id
   AND dns.effect_id = effect.effect_id
   AND dns.record_id = NEW.record_id
  WHERE effect.organization_id = NEW.organization_id
    AND effect.effect_id = NEW.effect_id
    AND ((NEW.direction = 'forward' AND effect.state = 'prepared')
      OR (NEW.direction = 'rollback' AND effect.state IN ('prepared', 'cutover', 'released')))
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move DNS receipt fence failed');
END;

CREATE TRIGGER game_lifecycle_move_dns_receipt_immutable_update
BEFORE UPDATE ON game_lifecycle_move_dns_receipts
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move DNS receipt is immutable');
END;

CREATE TRIGGER game_lifecycle_move_dns_receipt_immutable_delete
BEFORE DELETE ON game_lifecycle_move_dns_receipts
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move DNS receipt is immutable');
END;

-- A phase is never the evidence for the physical move by itself.  The final
-- phase update is fenced against the exact immutable external-effect receipts
-- and the matching deployment/capacity/port coordinates.  As a result a
-- zero-row update in a multi-statement D1 batch cannot leave a truthful phase
-- pointing at an incomplete cutover or rollback.
CREATE TRIGGER game_lifecycle_move_physical_transition_fence
BEFORE UPDATE OF phase ON game_lifecycle_moves
WHEN (
  NEW.phase = 'cutover'
  AND (
    NOT EXISTS (
      SELECT 1
      FROM game_lifecycle_move_effects effect
      JOIN game_lifecycle_move_effect_receipts receipt
        ON receipt.organization_id = effect.organization_id
       AND receipt.effect_id = effect.effect_id
       AND receipt.phase = 'cutover'
      WHERE effect.organization_id = NEW.organization_id
        AND effect.operation_id = NEW.operation_id
        AND effect.state = 'cutover'
    )
    OR NOT EXISTS (
      SELECT 1 FROM deployments deployment
      WHERE deployment.organization_id = NEW.organization_id
        AND deployment.id = NEW.source_deployment_id
        AND deployment.server_id = NEW.server_id
        AND deployment.node_id = NEW.target_node_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM server_capacity_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.server_id = NEW.server_id
        AND reservation.node_id = NEW.target_node_id
        AND reservation.state = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM port_leases lease
      WHERE lease.organization_id = NEW.organization_id
        AND lease.server_id = NEW.server_id
        AND lease.state IN ('reserved', 'active')
        AND lease.node_id <> NEW.target_node_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM game_lifecycle_move_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.operation_id = NEW.operation_id
        AND reservation.server_id = NEW.server_id
        AND reservation.target_node_id = NEW.target_node_id
        AND reservation.state = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM game_lifecycle_move_dns_effects dns
      WHERE dns.organization_id = NEW.organization_id
        AND dns.effect_id = 'game-move-effect:' || NEW.operation_id
        AND NOT EXISTS (
          SELECT 1 FROM game_lifecycle_move_dns_receipts receipt
          WHERE receipt.organization_id = dns.organization_id
            AND receipt.effect_id = dns.effect_id
            AND receipt.record_id = dns.record_id
            AND receipt.direction = 'forward'
        )
    )
  )
)
OR (
  NEW.phase = 'released'
  AND (
    NOT EXISTS (
      SELECT 1
      FROM game_lifecycle_move_effects effect
      JOIN game_lifecycle_move_effect_receipts receipt
        ON receipt.organization_id = effect.organization_id
       AND receipt.effect_id = effect.effect_id
       AND receipt.phase = 'release'
      WHERE effect.organization_id = NEW.organization_id
        AND effect.operation_id = NEW.operation_id
        AND effect.state = 'released'
    )
    OR NOT EXISTS (
      SELECT 1 FROM deployments deployment
      WHERE deployment.organization_id = NEW.organization_id
        AND deployment.id = NEW.source_deployment_id
        AND deployment.server_id = NEW.server_id
        AND deployment.node_id = NEW.target_node_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM game_lifecycle_move_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.operation_id = NEW.operation_id
        AND reservation.server_id = NEW.server_id
        AND reservation.state = 'released'
    )
  )
)
OR (
  NEW.phase = 'rolled_back'
  AND (
    NOT EXISTS (
      SELECT 1
      FROM game_lifecycle_move_effects effect
      JOIN game_lifecycle_move_effect_receipts receipt
        ON receipt.organization_id = effect.organization_id
       AND receipt.effect_id = effect.effect_id
       AND receipt.phase = 'rollback'
      WHERE effect.organization_id = NEW.organization_id
        AND effect.operation_id = NEW.operation_id
        AND effect.state = 'rolled_back'
    )
    OR NOT EXISTS (
      SELECT 1 FROM game_lifecycle_move_reservations reservation
      WHERE reservation.organization_id = NEW.organization_id
        AND reservation.operation_id = NEW.operation_id
        AND reservation.server_id = NEW.server_id
        AND reservation.state = 'rolled_back'
    )
    OR (
      OLD.phase = 'cutover'
      AND (
        NOT EXISTS (
          SELECT 1 FROM deployments deployment
          WHERE deployment.organization_id = NEW.organization_id
            AND deployment.id = NEW.source_deployment_id
            AND deployment.server_id = NEW.server_id
            AND deployment.node_id = NEW.source_node_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM server_capacity_reservations reservation
          WHERE reservation.organization_id = NEW.organization_id
            AND reservation.server_id = NEW.server_id
            AND reservation.node_id = NEW.source_node_id
            AND reservation.state = 'active'
        )
        OR EXISTS (
          SELECT 1 FROM port_leases lease
          WHERE lease.organization_id = NEW.organization_id
            AND lease.server_id = NEW.server_id
            AND lease.state IN ('reserved', 'active')
            AND lease.node_id <> NEW.source_node_id
        )
      )
    )
    OR EXISTS (
      SELECT 1 FROM game_lifecycle_move_dns_effects dns
      WHERE dns.organization_id = NEW.organization_id
        AND dns.effect_id = 'game-move-effect:' || NEW.operation_id
        AND NOT EXISTS (
          SELECT 1 FROM game_lifecycle_move_dns_receipts receipt
          WHERE receipt.organization_id = dns.organization_id
            AND receipt.effect_id = dns.effect_id
            AND receipt.record_id = dns.record_id
            AND receipt.direction = 'rollback'
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move physical transition fence failed');
END;

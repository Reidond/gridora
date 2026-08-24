PRAGMA foreign_keys = ON;

-- One bounded cursor per node. This is not an event log. It replaces the prior current cursor.
CREATE TABLE agent_observation_streams (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  session_version INTEGER NOT NULL CHECK (session_version > 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
  last_observed_revision INTEGER NOT NULL CHECK (last_observed_revision > 0),
  last_fingerprint TEXT NOT NULL CHECK (
    length(last_fingerprint) = 64 AND last_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('bootstrapping', 'ready', 'degraded')),
  capacity_published INTEGER NOT NULL CHECK (capacity_published IN (0, 1)),
  last_event_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (organization_id, node_id),
  FOREIGN KEY (organization_id, node_id, credential_id)
    REFERENCES node_credentials(organization_id, node_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES agent_sessions(organization_id, node_id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

-- Seven fixed current aggregates per node. No raw logs, command output, environment, or secrets persist.
CREATE TABLE agent_observation_aggregates (
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK (
    fact_kind IN ('agent', 'image', 'tunnel', 'docker', 'firewall', 'capacity', 'metrics')
  ),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  observed_revision INTEGER NOT NULL CHECK (observed_revision > 0),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 4096),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id, fact_kind),
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER agent_observation_stream_insert_fence
BEFORE INSERT ON agent_observation_streams
WHEN (
    NOT EXISTS (SELECT 1 FROM agent_observation_streams existing
      WHERE existing.organization_id = NEW.organization_id AND existing.node_id = NEW.node_id)
    AND (NEW.last_sequence <> 1 OR NEW.revision <> 1)
  )
  OR NOT EXISTS (
    SELECT 1 FROM agent_sessions session
    JOIN node_credentials credential
      ON credential.organization_id = session.organization_id
     AND credential.node_id = session.node_id
     AND credential.id = session.credential_id
    WHERE session.organization_id = NEW.organization_id
      AND session.node_id = NEW.node_id
      AND session.credential_id = NEW.credential_id
      AND session.session_version = NEW.session_version
      AND session.session_state = 'connected'
      AND credential.status = 'active'
      AND credential.version = NEW.credential_version
  )
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id AND node.id = NEW.node_id
      AND node.observed_revision = NEW.last_observed_revision
      AND node.observed_state = NEW.observed_state
  )
  OR (SELECT COUNT(*) FROM agent_observation_aggregates aggregate
      WHERE aggregate.organization_id = NEW.organization_id AND aggregate.node_id = NEW.node_id
        AND aggregate.sequence = NEW.last_sequence
        AND aggregate.observed_revision = NEW.last_observed_revision
        AND aggregate.observed_at = NEW.last_event_at) <> 7
  OR (NEW.capacity_published = 1) IS NOT (
    NEW.observed_state = 'ready'
    AND EXISTS (SELECT 1 FROM node_runtime_capacity capacity
      WHERE capacity.organization_id = NEW.organization_id AND capacity.node_id = NEW.node_id
        AND capacity.reported_at = NEW.last_event_at
        AND capacity.agent_ready = 1 AND capacity.tunnel_ready = 1
        AND capacity.docker_ready = 1 AND capacity.firewall_ready = 1)
  )
BEGIN
  SELECT RAISE(ABORT, 'agent observation insert fence failed');
END;

CREATE TRIGGER agent_observation_stream_update_fence
BEFORE UPDATE ON agent_observation_streams
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.node_id IS NOT OLD.node_id
  OR NOT (
    (NEW.credential_id IS OLD.credential_id
      AND NEW.credential_version = OLD.credential_version
      AND NEW.session_version = OLD.session_version
      AND NEW.last_sequence = OLD.last_sequence + 1)
    OR
    (NEW.session_version = OLD.session_version + 1
      AND NEW.last_sequence = 1)
  )
  OR NEW.last_observed_revision <> OLD.last_observed_revision + 1
  OR NEW.revision <> OLD.revision + 1
  OR julianday(NEW.last_event_at) < julianday(OLD.last_event_at)
  OR NOT EXISTS (
    SELECT 1 FROM agent_sessions session
    JOIN node_credentials credential
      ON credential.organization_id = session.organization_id
     AND credential.node_id = session.node_id
     AND credential.id = session.credential_id
    WHERE session.organization_id = NEW.organization_id
      AND session.node_id = NEW.node_id
      AND session.credential_id = NEW.credential_id
      AND session.session_version = NEW.session_version
      AND session.session_state = 'connected'
      AND credential.status = 'active'
      AND credential.version = NEW.credential_version
  )
  OR NOT EXISTS (
    SELECT 1 FROM nodes node
    WHERE node.organization_id = NEW.organization_id AND node.id = NEW.node_id
      AND node.observed_revision = NEW.last_observed_revision
      AND node.observed_state = NEW.observed_state
  )
  OR (SELECT COUNT(*) FROM agent_observation_aggregates aggregate
      WHERE aggregate.organization_id = NEW.organization_id AND aggregate.node_id = NEW.node_id
        AND aggregate.sequence = NEW.last_sequence
        AND aggregate.observed_revision = NEW.last_observed_revision
        AND aggregate.observed_at = NEW.last_event_at) <> 7
  OR (NEW.capacity_published = 1) IS NOT (
    NEW.observed_state = 'ready'
    AND EXISTS (SELECT 1 FROM node_runtime_capacity capacity
      WHERE capacity.organization_id = NEW.organization_id AND capacity.node_id = NEW.node_id
        AND capacity.reported_at = NEW.last_event_at
        AND capacity.agent_ready = 1 AND capacity.tunnel_ready = 1
        AND capacity.docker_ready = 1 AND capacity.firewall_ready = 1)
  )
BEGIN
  SELECT RAISE(ABORT, 'agent observation update fence failed');
END;

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
      JOIN node_provision_acceptances acceptance
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
      JOIN node_provision_acceptances acceptance
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

CREATE TRIGGER agent_observation_stream_immutable_delete
BEFORE DELETE ON agent_observation_streams
BEGIN
  SELECT RAISE(ABORT, 'agent observation stream cannot be deleted');
END;

PRAGMA foreign_keys = ON;

-- A move restores on the target before its one authoritative deployment row
-- is cut over.  This record is deliberately not a deployment: its presence
-- proves the target is a non-authoritative staging location and keeps the
-- source deployment authoritative until the fenced cutover transaction.
CREATE TABLE game_lifecycle_move_target_stages (
  organization_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  source_deployment_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'staged', 'validated', 'committed', 'active', 'rolled_back'
  )),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, effect_id),
  UNIQUE (organization_id, stage_id),
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES game_lifecycle_move_effects(organization_id, effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operation_id)
    REFERENCES operations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, server_id)
    REFERENCES game_servers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_deployment_id)
    REFERENCES deployments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, target_node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_move_target_stage_scope_guard
BEFORE INSERT ON game_lifecycle_move_target_stages
WHEN NEW.state <> 'prepared'
OR NEW.revision <> 1
OR NEW.stage_id <> 'game-move-stage:' || NEW.effect_id
OR NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_move_effects effect
  JOIN game_lifecycle_moves move
    ON move.organization_id = effect.organization_id
   AND move.operation_id = effect.operation_id
   AND move.server_id = effect.server_id
  JOIN deployments source
    ON source.organization_id = effect.organization_id
   AND source.id = effect.source_deployment_id
   AND source.server_id = effect.server_id
  WHERE effect.organization_id = NEW.organization_id
    AND effect.effect_id = NEW.effect_id
    AND effect.operation_id = NEW.operation_id
    AND effect.server_id = NEW.server_id
    AND effect.source_deployment_id = NEW.source_deployment_id
    AND effect.target_node_id = NEW.target_node_id
    AND effect.state = 'prepared'
    AND move.phase = 'stopped'
    AND move.backup_id = NEW.backup_id
    -- The staging record may only be created while the D1 deployment still
    -- identifies the source.  It can never become an alternate authority.
    AND source.node_id = effect.source_node_id
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move target stage scope fence failed');
END;

-- Every physical agent command is durable before enqueue.  A retry reuses the
-- exact signed envelope and can adopt a terminal result after a lost D1 or DO
-- response, rather than inferring success from an unrelated current status.
CREATE TABLE game_lifecycle_move_physical_commands (
  organization_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'restore-stage', 'restore-validate', 'restore-commit', 'activate-target',
    'release-source', 'rollback-target', 'rollback-stage',
    'rollback-source-deploy', 'rollback-source-start'
  )),
  node_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (
    json_valid(command_json)
    AND json_type(command_json) = 'object'
    AND length(CAST(command_json AS BLOB)) <= 81920
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT CHECK (
    result_json IS NULL OR (
      json_valid(result_json)
      AND json_type(result_json) = 'object'
      AND length(CAST(result_json AS BLOB)) <= 81920
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, effect_id, action),
  UNIQUE (organization_id, command_id),
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES game_lifecycle_move_effects(organization_id, effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'pending' AND result_json IS NULL)
    OR (state IN ('succeeded', 'failed') AND result_json IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE TRIGGER game_lifecycle_move_physical_command_scope_guard
BEFORE INSERT ON game_lifecycle_move_physical_commands
WHEN NEW.state <> 'pending'
OR NEW.revision <> 1
OR json_extract(NEW.command_json, '$.commandId') <> NEW.command_id
OR json_extract(NEW.command_json, '$.organizationId') <> NEW.organization_id
OR json_extract(NEW.command_json, '$.nodeId') <> NEW.node_id
OR json_extract(NEW.command_json, '$.resourceId') <> NEW.resource_id
OR NOT EXISTS (
  SELECT 1
  FROM game_lifecycle_move_effects effect
  WHERE effect.organization_id = NEW.organization_id
    AND effect.effect_id = NEW.effect_id
    AND json_extract(NEW.command_json, '$.operationId') = effect.operation_id
    AND NEW.resource_id = effect.server_id
    AND (
      (
        NEW.action IN ('restore-stage', 'restore-validate', 'restore-commit',
                       'activate-target', 'rollback-target', 'rollback-stage')
        AND NEW.node_id = effect.target_node_id
      )
      OR (
        NEW.action IN ('release-source', 'rollback-source-deploy', 'rollback-source-start')
        AND NEW.node_id = effect.source_node_id
      )
    )
    AND (
      (NEW.action IN ('restore-stage', 'restore-validate', 'restore-commit', 'rollback-stage')
        AND json_extract(NEW.command_json, '$.type') = 'backup.restore'
        AND json_extract(NEW.command_json, '$.payload.targetServerId') = effect.server_id
        AND json_extract(NEW.command_json, '$.payload.manifest.organizationId') = effect.organization_id
        AND json_extract(NEW.command_json, '$.payload.manifest.serverId') = effect.server_id
        AND json_extract(NEW.command_json, '$.payload.phase') = CASE NEW.action
          WHEN 'restore-stage' THEN 'stage'
          WHEN 'restore-validate' THEN 'validate'
          WHEN 'restore-commit' THEN 'commit'
          WHEN 'rollback-stage' THEN 'rollback'
        END
        AND EXISTS (
          SELECT 1 FROM game_lifecycle_move_target_stages stage
          WHERE stage.organization_id = effect.organization_id
            AND stage.effect_id = effect.effect_id
            AND stage.backup_id = json_extract(NEW.command_json, '$.payload.manifest.backupId')
        ))
      OR (NEW.action = 'activate-target'
        AND json_extract(NEW.command_json, '$.type') = 'deployment.apply'
        AND json_extract(NEW.command_json, '$.payload.deploymentId') = effect.source_deployment_id
        AND json_extract(NEW.command_json, '$.payload.nodeId') = effect.target_node_id
        AND json_extract(NEW.command_json, '$.payload.operationId') = effect.operation_id)
      OR (NEW.action = 'rollback-source-deploy'
        AND json_extract(NEW.command_json, '$.type') = 'deployment.apply'
        AND json_extract(NEW.command_json, '$.payload.deploymentId') = effect.source_deployment_id
        AND json_extract(NEW.command_json, '$.payload.nodeId') = effect.source_node_id
        AND json_extract(NEW.command_json, '$.payload.operationId') = effect.operation_id)
      OR (NEW.action IN ('release-source', 'rollback-target')
        AND json_extract(NEW.command_json, '$.type') = 'deployment.remove'
        AND json_extract(NEW.command_json, '$.payload.deploymentId') = effect.source_deployment_id)
      OR (NEW.action = 'rollback-source-start'
        AND json_extract(NEW.command_json, '$.type') = 'server.start'
        AND json_extract(NEW.command_json, '$.payload.deploymentId') = effect.source_deployment_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move physical command scope fence failed');
END;

CREATE TRIGGER game_lifecycle_move_physical_command_transition_fence
BEFORE UPDATE ON game_lifecycle_move_physical_commands
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.effect_id IS NOT OLD.effect_id
  OR NEW.action IS NOT OLD.action
  OR NEW.node_id IS NOT OLD.node_id
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.command_id IS NOT OLD.command_id
  OR NEW.command_json IS NOT OLD.command_json
  OR NEW.command_fingerprint IS NOT OLD.command_fingerprint
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR OLD.state <> 'pending'
  OR NEW.state NOT IN ('succeeded', 'failed')
  OR NEW.result_json IS NULL
  OR json_extract(NEW.result_json, '$.commandId') <> OLD.command_id
  OR json_extract(NEW.result_json, '$.operationId') <> json_extract(OLD.command_json, '$.operationId')
  OR (
    (NEW.state = 'succeeded' AND json_extract(NEW.result_json, '$.status') <> 'succeeded')
    OR (NEW.state = 'failed' AND json_extract(NEW.result_json, '$.status') NOT IN ('failed', 'rejected'))
  )
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move physical command transition fence failed');
END;

CREATE TRIGGER game_lifecycle_move_target_stage_transition_fence
BEFORE UPDATE ON game_lifecycle_move_target_stages
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.effect_id IS NOT OLD.effect_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.server_id IS NOT OLD.server_id
  OR NEW.backup_id IS NOT OLD.backup_id
  OR NEW.stage_id IS NOT OLD.stage_id
  OR NEW.source_deployment_id IS NOT OLD.source_deployment_id
  OR NEW.target_node_id IS NOT OLD.target_node_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NOT (
    (OLD.state = 'prepared' AND NEW.state = 'staged'
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'restore-stage' AND command.state = 'succeeded'
      ))
    OR (OLD.state = 'staged' AND NEW.state = 'validated'
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'restore-validate' AND command.state = 'succeeded'
      ))
    OR (OLD.state = 'validated' AND NEW.state = 'committed'
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'restore-commit' AND command.state = 'succeeded'
      ))
    OR (OLD.state = 'committed' AND NEW.state = 'active'
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'activate-target' AND command.state = 'succeeded'
      ))
    OR (OLD.state IN ('prepared', 'staged', 'validated', 'committed', 'active')
      AND NEW.state = 'rolled_back'
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'rollback-stage' AND command.state = 'succeeded'
      )
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'rollback-source-deploy' AND command.state = 'succeeded'
      )
      AND EXISTS (
        SELECT 1 FROM game_lifecycle_move_physical_commands command
        WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
          AND command.action = 'rollback-source-start' AND command.state = 'succeeded'
      )
      AND (
        OLD.state NOT IN ('committed', 'active')
        OR EXISTS (
          SELECT 1 FROM game_lifecycle_move_physical_commands command
          WHERE command.organization_id = NEW.organization_id AND command.effect_id = NEW.effect_id
            AND command.action = 'rollback-target' AND command.state = 'succeeded'
        )
      ))
  )
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move target stage transition fence failed');
END;

CREATE TRIGGER game_lifecycle_move_target_stage_immutable_delete
BEFORE DELETE ON game_lifecycle_move_target_stages
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move target stage is immutable');
END;

CREATE TRIGGER game_lifecycle_move_physical_command_immutable_delete
BEFORE DELETE ON game_lifecycle_move_physical_commands
BEGIN
  SELECT RAISE(ABORT, 'game lifecycle move physical command is immutable');
END;

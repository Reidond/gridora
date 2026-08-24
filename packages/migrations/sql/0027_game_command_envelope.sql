PRAGMA foreign_keys = ON;

-- A delivery fingerprint alone cannot reconstruct the signed command after a
-- signing-key rotation.  Persist the exact signed envelope that was accepted
-- so response-loss retries re-enqueue the same command bytes and signature.
-- The column is nullable only for rows created before this migration; the
-- runtime fails closed for those non-terminal legacy rows instead of
-- re-signing them with a different key.
ALTER TABLE game_command_deliveries
  ADD COLUMN command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json));

CREATE TRIGGER game_command_delivery_envelope_insert_fence
BEFORE INSERT ON game_command_deliveries
WHEN NEW.command_json IS NULL
  OR json_extract(NEW.command_json, '$.commandId') IS NOT NEW.command_id
  OR json_extract(NEW.command_json, '$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.command_json, '$.organizationId') IS NOT NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'game command envelope scope mismatch');
END;

-- The signed command and its fingerprint are immutable acceptance facts.  A
-- retry may change delivery state/result/attempts only; changing the envelope,
-- identity coordinates, or digest would permit a different command to adopt
-- the original operation.
CREATE TRIGGER game_command_delivery_envelope_update_fence
BEFORE UPDATE OF organization_id, operation_id, command_id, step_name,
  command_fingerprint, command_json ON game_command_deliveries
WHEN NEW.organization_id IS NOT OLD.organization_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.command_id IS NOT OLD.command_id
  OR NEW.step_name IS NOT OLD.step_name
  OR NEW.command_fingerprint IS NOT OLD.command_fingerprint
  OR NEW.command_json IS NOT OLD.command_json
  OR NEW.command_json IS NULL
  OR json_extract(NEW.command_json, '$.commandId') IS NOT NEW.command_id
  OR json_extract(NEW.command_json, '$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.command_json, '$.organizationId') IS NOT NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'game command envelope is immutable');
END;

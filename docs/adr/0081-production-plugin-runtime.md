# ADR 0081: Stage reviewed plugin installation, activation, and health

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0005, ADR 0009, ADR 0027, ADR 0050, and ADR 0080

## Situation

A control-plane plan is not a running game server. The node must install the
reviewed Steam application, stage configuration and mods, validate them, switch
activation atomically, and report plugin-level health. A partial update must
not replace the last known-good runtime.

## Task

Run only build-time reviewed plugin plans in the isolated node runner. Make
installation and activation deterministic, bounded, disk-quota aware, and
rollback capable. Report game-specific process and protocol health.

## Execution

The signed command selects an exact registered plugin ID and version. The agent
constructs its install, configure, mod, validate, backup/restore, and health
plans from that registry. SteamCMD uses the plugin's fixed application ID and
login mode. No arbitrary shell string, runtime-loaded plugin, Docker socket, or
privileged game container is accepted.

Configuration and resolved mods are written to a staging revision. Validation
runs before activation. A successful switch preserves the prior revision until
plugin-level health succeeds; a failed validation or health check restores the
known-good revision. Migration 0061 binds accepted mod metadata and dependency
provenance to the lifecycle operation.

The agent reports process, protocol, build, container, and plugin health only
for the exact active deployment and revision. The control plane rejects stale
or foreign observation.

## Consequences

An operation cannot claim runtime success from container liveness alone.
Install and activation failures retain a rollback target and become explicit
terminal evidence. Real Steam, Workshop, game protocol, and VPS evidence is
still live-blocked.

## Verification

Agent runtime, executor, plugin testkit, Arma and reference plugin tests cover
signed installation, staged config/mod validation, rollback, backup/restore,
and plugin-level health parsing. Lifecycle and telemetry tests verify exact
deployment/revision fencing. Docker and image security tests verify isolation.

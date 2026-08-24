# ADR 0003: Node agent runs under systemd

- Status: Accepted
- Date: 2026-08-23

## Context

The agent controls host Docker and nftables. It must recover before game containers.

## Decision

The agent is a signed host binary managed by systemd, not a container. It is the
only component granted Docker control and runs as a dedicated locked user with a
minimal writable path set.

## Consequences

The agent can recover containers while the control plane is unavailable and can
apply host firewall rules. Upgrades use signed atomic replacement, health checks,
and automatic rollback to the previous binary.

## Alternatives

We rejected a privileged agent container. It would add a Docker bootstrap cycle.
We rejected an SSH command runner. It would expose a broad command surface.

## Verification

Inspect the systemd sandbox. Reboot a test image. Verify agent recovery and rollback.

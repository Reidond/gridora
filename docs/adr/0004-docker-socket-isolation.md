# ADR 0004: Docker socket isolation

- Status: Accepted
- Date: 2026-08-23

## Context

Docker socket access is equivalent to host control. A game process is untrusted.

## Decision

Only the systemd agent may open `/run/docker.sock`. Games, plugins, Traefik, and
install helpers never mount it. The agent translates validated deployment specs
into a fixed Docker API capability set; arbitrary API passthrough is forbidden.

## Consequences

Traefik consumes agent-generated file configuration. Security tests inspect every
container mount, capability, device, network, and published port before promotion.

## Alternatives

We rejected a read-only socket mount in Traefik. Docker API access still has risk.
We rejected user-submitted Compose. It can request unsafe host features.

## Verification

Inspect every created container. Fail when a non-agent mount targets the socket.

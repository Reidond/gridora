# ADR 0006: Traefik and direct protocol ports

- Status: Accepted
- Date: 2026-08-23

## Context

HTTP can use host routing. Many game UDP protocols cannot use host routing.

## Decision

Traefik terminates HTTP management traffic and may forward explicitly supported
TCP/UDP services. Game protocols use direct leased host ports by default. DNS is
DNS-only and the client-visible address always includes the port.

## Consequences

`NodeCoordinatorDO` serializes leases and nftables admits only active leases.
Traefik has no public dashboard and no Docker socket.

## Alternatives

We rejected mandatory Traefik forwarding. It adds no value for direct UDP ports.
We postponed Spectrum. It is optional and can add cost.

## Verification

Deploy two local test servers. Verify unique UDP leases and a closed dashboard.

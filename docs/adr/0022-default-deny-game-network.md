# ADR 0022: Default-deny game network

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0004

## Context

A dedicated Docker network does not deny Internet access by itself. A game or mod
can use an external route to scan or disclose data.

## Decision

The agent creates each default game network with `Internal` set to true and
`Attachable` set to false. It adopts an existing network only when these values and
the signed ownership labels match. A plugin that needs egress must use a separate,
validated network policy with an explicit destination, protocol, port, and lease.

## Consequences

The default game container has no external route. Install and update work must use a
separate controlled execution path. A network with the correct name but weaker
settings is a conflict.

## Alternatives

We rejected a normal bridge network with nftables as the only guard. A firewall
error can permit broad egress. We rejected an attachable default network. An
unrelated container can join it.

## Verification

Create a real container on the generated network. Inspect the network and container.
Confirm the non-root user, zero capabilities, read-only root, no Docker socket, one
owned volume, one published port, no external connection, `Internal: true`, and
`Attachable: false`.

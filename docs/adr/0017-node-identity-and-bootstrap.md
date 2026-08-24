# ADR 0017: Node identity and bootstrap credentials

- Status: Accepted
- Date: 2026-08-23

## Context

A new node needs one registration secret. The running agent needs a renewable
machine credential. Cloudflare Tunnel needs a different persistent token.

## Decision

The registration token is short-lived, hashed in D1, and bound to the organization,
node, provider instance, and operation. Exchange is atomic and idempotent. The agent
stores the node credential with mode `0600`, removes the registration file, and asks
the API to revoke stale registration material. The Tunnel token stays in its own
mode-`0600` file. The two services do not share credentials.

The agent accepts only the configured HTTPS control-plane host. A loopback HTTP
exception is explicit and is for development only.

## Consequences

A node can restart without bootstrap data. Credential rotation increments a session
version. Revocation invalidates the agent session and its realtime tickets.

## Alternatives

We rejected one shared environment file. It gives each process the other process's
secret. We rejected a permanent registration token. It cannot provide one-time
enrollment.

## Verification

Test expiry, wrong organization, wrong node, wrong provider instance, concurrent
exchange, lost exchange response, rotation, revocation, reboot, and foreign hosts.

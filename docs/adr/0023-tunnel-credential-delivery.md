# ADR 0023: Tunnel credential delivery

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0017

## Context

Provider user-data is not a safe store for a long-lived Cloudflare Tunnel token.
Cloud-init caches user-data on the node. A provider can also retain user-data after
the first boot. Anyone with a Tunnel token can run a connector for that Tunnel.

## Decision

Gridora does not put a Tunnel token in cloud-init user-data. The node image keeps
`cloudflared` stopped until a trusted credential delivery channel installs a
non-empty token file with the correct owner and mode.

The current cloud-init template fails closed because that delivery channel is not
implemented. A production node is not ready until the control plane delivers the
credential after agent registration and confirms the Tunnel connection. The token
file stays on the node so a reboot can reconnect. A retire or rebuild workflow must
revoke the token and remove the file.

Cloud-init removes cached user-data, compiled user-data, serialized datasource
state, sensitive runtime instance data, and cloud-init logs after it writes the bootstrap files. The
node then disables cloud-init for later boots so the provider cannot repopulate the
cache with the original user-data. The one-time registration token remains in its
restricted source file until the agent consumes and removes it.

## Consequences

A public or provider-retained user-data record cannot expose a long-lived Tunnel
token. A node cannot start its Tunnel until the secure delivery step succeeds. This
keeps the bootstrap incomplete instead of weakening the credential boundary.

## Alternatives

We rejected a Tunnel token in user-data. We rejected moving the same token to
another cloud-init field. We rejected a command-line token because process listings
can expose it.

## Verification

Render the cloud-init template and confirm that it has no Tunnel token field. Run
the cache cleanup behavior test and confirm that cloud-init cache files disappear.
Confirm that the installed token file remains for reboot. Confirm that the
`cloudflared` service does not start when the file is absent, empty, symlinked,
owned by another account, or readable by another account.

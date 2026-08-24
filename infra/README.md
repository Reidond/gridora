# Gridora infrastructure

This directory contains reviewable templates for the Cloudflare control plane and
the Ubuntu 24.04 node image. Nothing here provisions infrastructure merely by
being checked out.

- `cloudflare/` contains a Wrangler template and environment inventory contract.
- `packer/` builds the generic amd64 node image.
- `images/` contains cloud-init and host hardening assets.
- `docker/` contains the inspectable, least-privilege runtime baseline.
- `scripts/` creates and verifies supply-chain artifacts.

Production changes require a protected GitHub environment. Provider smoke tests
also require `live_test=true`, a hard expiry, and a cleanup owner. See
`docs/operations/release.md`.

`infra/images/systemd/gridora-agent.service` is the canonical production agent
unit. Application packages must not keep a second service definition.

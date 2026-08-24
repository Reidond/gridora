# Gridora

Gridora is a multi-organization game server operations platform. Its control plane
uses Cloudflare Workers, Durable Objects, Workflows, Queues, D1, and R2. Its node
agent operates isolated Steam dedicated servers on Ubuntu VPS nodes.

## Project status

This repository is a public pre-alpha implementation of
[PRODUCT.md](./PRODUCT.md). It contains local contracts, applications, Workers,
node-image templates, provider drivers, and behavioral tests. It does not claim a
live provider deployment or a production release.

The repository includes:

- public sign-in, sign-up, invitation, and first-organization setup flows;
- strict organization-scoped domain, repository, API, event, and credential models;
- an Effect 4 control plane with Hono only at the HTTP edge;
- Cloudflare Access assertion validation and one-time opaque authentication state;
- D1 migrations, idempotent operations, leased outbox delivery, and revision fences;
- a CLI and a signed-command Linux node agent with persistent SQLite command state;
- OVHcloud Public Cloud and Contabo provider drivers with uncertain-create safety;
- Arma Reforger and Valheim plugin implementations and conformance tests;
- Docker, Steam, backup, image, firewall, Tunnel, and supply-chain boundaries;
- architecture decision records and an STE implementation record.

## Requirements

- Node.js 24 or later
- pnpm 11.21.0
- Docker for the live container-boundary test
- macOS Keychain, or Linux Secret Service with `secret-tool`, for CLI login
- Wrangler authentication only for Cloudflare validation or deployment work

The CLI does not store refresh tokens in plaintext. It fails closed when the
operating-system credential store is unavailable. Windows packaging and its
credential-store adapter are not part of this pre-alpha build.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
GRIDORA_LIVE_DOCKER_SECURITY=1 pnpm exec vitest run tests/security/docker-boundaries.live.test.ts
pnpm audit --audit-level high
```

Run the web console locally:

```sh
pnpm --filter @gridora/web dev
```

Run a Worker locally only after you create an untracked `.dev.vars` file with test
values. Never use production provider, Tunnel, machine, invitation, or encryption
credentials for local development.

## Architecture and operations

- [Architecture decisions](./docs/adr/README.md)
- [STE implementation record](./docs/implementation/step-by-step.md)
- [Threat model](./docs/threat-model/README.md)
- [Operator runbooks](./docs/operations/)
- [Plugin authoring rules](./docs/plugin-authoring/README.md)
- [Infrastructure templates](./infra/README.md)

Live deployment requires an owned Cloudflare zone, Access applications, D1 and R2
resources, Queues, Durable Objects, Workflows, a verified Email Sending domain,
promoted node images, and explicitly approved provider credentials. Provider tests
must use a hard TTL and cleanup reconciliation.

## License

[MIT](./LICENSE)

# Gridora contributor instructions

## Architecture

- Treat `PRODUCT.md` as the product contract.
- Keep organization context explicit through routes, services, repositories,
  Durable Object names, queue partitions, R2 keys, provider metadata, and node
  credentials.
- Keep domain and provider contracts free of Cloudflare globals.
- Use Effect 4 for services, repositories, adapters, workflows, and typed
  errors. Run Effects only at application entry points.
- Use Hono only as the HTTP edge adapter. Effect Schema owns wire contracts.
- Keep SQL in `packages/db-d1` and migrations.
- Keep game-specific behavior inside its plugin package.
- Do not add ESLint, Prettier, an ORM, Kubernetes, arbitrary shell execution,
  dynamic `eval`, or runtime-loaded unreviewed plugins.

## Tooling

- Use the pinned Vite+ toolchain: `pnpm check`, `pnpm test`, and `pnpm build`.
- Use `wrangler.jsonc`, generate Worker bindings with Wrangler, and never
  commit secrets.
- When Python is necessary, use `uv` exclusively.

## Safety

- Never expose provider, Tunnel, Steam, machine, backup, or RCON secrets.
- Do not provision paid infrastructure in tests without an explicit live-test
  flag, hard TTL, and cleanup reconciliation.
- Do not make game containers privileged or mount the Docker socket.

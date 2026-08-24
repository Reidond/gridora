# Cloudflare runtime integration tests

This suite runs locally in the Workers runtime provided by
`@cloudflare/vitest-pool-workers`. It uses local SQLite-backed Durable Objects
and D1; it does not connect to or deploy anything on a Cloudflare account.

Run the behavioral suite separately from the default Node.js tests:

```sh
pnpm exec vitest run --config tests/cloudflare/vitest.config.ts
```

Type-check and format-check the harness with:

```sh
pnpm exec tsc --noEmit -p tests/cloudflare/tsconfig.json --pretty false
pnpm exec vp fmt --check tests/cloudflare
```

The D1 tests read and apply the repository's migrations through Cloudflare's
test helper. The backup integration composes an actual local D1 binding and R2
binding with the production adapters, then verifies encrypted upload and restore.
The harness exports the real API Worker and verifies its public contract and
problem boundary instead of a placeholder fetch handler.
Files intentionally use the
`.integration.ts` suffix so the root Node.js Vitest configuration does not
collect Workers-only modules.

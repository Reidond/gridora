# Spec: Rename an existing game server

- Size: Medium (manifest control, API, CLI, web, tests)
- Runnable now: yes
- STE step to add: Step 131 (renumber to the next free number on rebase)
- ADR to add: ADR 0107 — "Game server rename as a metadata-only durable operation"
- Branch: `spec/game-server-rename`

## Problem

`packages/game-server-manifest-control/src/index.ts` rejects `metadata.name` changes with "renaming an existing server is not implemented". PRODUCT.md FR-7 and FR-17 expect declarative manifests to converge; a name change is the smallest possible delta and today forces delete-and-recreate.

## Requirements

- R1. A manifest apply whose only delta is `metadata.name` produces a `rename` plan entry instead of an unsupported delta. Any other combined delta is still rejected (one durable lifecycle mutation per apply).
- R2. Rename is a durable operation (ADR 0067): it creates an operation record and a v1 audit envelope in the same D1 batch, is idempotent by client key (ADR 0021), and is fenced by the server revision (ADR 0037-style revision fence).
- R3. Rename changes display metadata only. It does not change endpoint, DNS, ports, plugin, node placement, or backup keys. Existing R2 keys and Durable Object names keep the server ID, not the name.
- R4. Name uniqueness is per organization; a conflict returns a 409 problem with `code: NAME_CONFLICT`. Validation reuses the existing create-time name schema.
- R5. Expose it through: the existing manifest apply route, a typed API route `POST /v1/organizations/:organization/game-servers/:serverId/actions/rename` (operator role), the generated client, the CLI (`gridora server rename`), and the web server page (an inline rename control next to the title).
- R6. Denial paths tested: viewer role, wrong organization, stale revision, name conflict, empty or invalid name, replayed idempotency key returns the original.

## Pointers

- `packages/game-server-manifest-control`, `packages/game-server-manifest-d1`
- `packages/game-lifecycle-control`, `packages/game-lifecycle-d1` for the operation and audit batch pattern.
- `apps/api/src/index.ts` for route registration and `mutation-audit-inventory.ts` (every mutating route must appear in the audit inventory test).
- `apps/cli/src/commands.ts`, `packages/generated-client`, `apps/web/pages/o/[slug]/servers/[id].vue`.
- `packages/migrations` if a unique index per organization is missing.

## Visual evidence

Take a before/after screenshot of the server page rename control with the web dev server and a local fake API mode if one exists (`apps/web/utils/gridora.ts`, `nuxt.config.ts` API mode). Attach to the PR with `gh pr comment --attach` (never commit image files) and reference the comment in the PR body. Skip with an explicit note if no local rendering path exists.

## Test requirements

- Unit tests for R1, R2, R4, R6; API contract test for R5; CLI test for the command.
- `pnpm check`, `pnpm test`, `pnpm build` pass.

## Deliverables

PR against `main` with code, ADR 0107, STE step, screenshots, and this spec copied to `.specs/game-server-rename/spec.md`.

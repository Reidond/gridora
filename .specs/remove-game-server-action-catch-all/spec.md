# Spec: Remove the 501 catch-all for game-server actions

- Size: Small
- Runnable now: yes
- STE step to add: Step 132 (renumber to the next free number on rebase)
- ADR: cite existing ADR 0065 ("Old public 501 routes are removed rather than advertised as supported behavior"). No new ADR.
- Branch: `spec/remove-game-server-action-catch-all`

## Problem

`apps/api/src/index.ts` registers `tenantNotImplemented('/v1/organizations/:organization/game-servers/:id/actions/*', ...)` which answers 501 for any unknown game-server action after authorizing the tenant. ADR 0065 decided that unimplemented public routes are removed, not advertised. It is also the last `501` in the API, and the OpenAPI generator in `apps/api/src/contracts.ts` still carries a `successStatus === 501` branch.

## Requirements

- R1. Remove the catch-all so unknown game-server actions return the standard 404 problem document. Registered actions (for example `actions/clone`) are unaffected.
- R2. Remove the now-dead 501 branches from `apps/api/src/contracts.ts` and `apps/api/src/mutation-audit-inventory.ts` only if no route declares `successStatus: 501` anymore; keep `notImplemented` for the internal Workflow-step and Queue-event guards, which are not public routes.
- R3. The web client in `apps/web/services/gridora-api.ts` still handles a 501 for backward compatibility; leave it.
- R4. Add tests: unknown action returns 404 for an authorized operator, and still returns 401/403 before 404 for an unauthenticated or foreign-organization caller (keep the tenant-authorization-before-404 property if it exists today; if it does not, document that the 404 is uniform and add a cross-organization test).

## Test requirements

- API tests for R1 and R4; OpenAPI snapshot updated if one exists.
- `pnpm check`, `pnpm test`, `pnpm build` pass.

## Deliverables

PR against `main` with code, STE step, and this spec copied to `.specs/remove-game-server-action-catch-all/spec.md`.

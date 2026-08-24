# Contributing to Gridora

Read `PRODUCT.md` and `AGENTS.md` before a change.

1. Create a focused branch.
2. Keep organization context explicit.
3. Put SQL only in `packages/db-d1` and migrations.
4. Keep game behavior in a plugin.
5. Add tests for each behavior and denial path.
6. Run `pnpm check`.
7. Run `pnpm test`.
8. Run `pnpm build`.
9. Add or supersede an ADR when a material architecture decision changes. Do
   not rewrite an accepted ADR.
10. Add the next sequential step to the STE implementation record. Use short
    sentences, active voice, one controlled status, explicit actions, evidence
    or a blocker, verification, and the controlling ADR.
11. Run `pnpm exec vitest run tests/architecture/documentation-record.test.ts`
    before publication.

Do not commit secrets. Do not run a paid provider test without the protected live
test gate, a hard expiry, and cleanup reconciliation.

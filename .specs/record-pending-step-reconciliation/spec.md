# Spec: Close the pending STE steps 109 and 111

- Size: Small (documentation with a verification run)
- Runnable now: yes
- STE step to add: Step 135 (renumber to the next free number on rebase)
- ADR: cite existing ADR 0084, 0085, and 0086. No new ADR.
- Branch: `spec/record-pending-step-reconciliation`

## Problem

`docs/implementation/step-by-step.md` defines `pending` as "the final repository-wide check is not recorded". Steps 109 and 111 still carry `Status: pending` even though later steps (128–130) record complete gates on the same code, and Step 110 already moved to `local`. The record must be truthful before a release step cites it.

## Requirements

- R1. Run the complete local gate (`pnpm check`, `pnpm test`, `pnpm build`, `pnpm wrangler:types:check`, `pnpm test:cloudflare`, `pnpm exec vitest run tests/architecture/documentation-record.test.ts`) on the branch and record the exact counts.
- R2. Change Step 109 and Step 111 from `pending` to `local`, and append one `- Verification:` line to each that cites the gate run from R1 and the commit SHA. Do not rewrite their existing Action, Result, Evidence, or Blocker lines.
- R3. Step 111's Blocker line still describes the Step 112 firewall repair as future work. Append one sentence stating that Steps 112–128 record the later repairs, so the reader is not misled. Keep the original sentence.
- R4. Add the new STE step describing this reconciliation, with Status `local`, the gate counts, and Decision ADR 0086.
- R5. Update the record header only if the meaning of `pending` needs a sentence about how a pending step is closed; otherwise leave it.

## Test requirements

- `tests/architecture/documentation-record.test.ts` passes.
- `pnpm check` passes (formatting of the markdown).

## Deliverables

PR against `main` with the record changes and this spec copied to `.specs/record-pending-step-reconciliation/spec.md`.

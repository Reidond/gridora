# Spec: Refresh pinned GitHub Actions and close orphaned Dependabot PRs

- Size: Small
- Runnable now: yes
- STE step to add: Step 134 (renumber to the next free number on rebase)
- ADR: cite existing ADR 0105. No new ADR.
- Branch: `spec/github-actions-pin-refresh`

## Problem

STE Step 130 deleted the Dependabot configuration, but six Dependabot PRs opened on 2026-08-24 are still open (#1 through #6). Their bumps were never applied to the SHA-pinned `uses:` lines in `.github/workflows/*.yml`.

## Requirements

- R1. Update every `uses:` pin in `.github/workflows/` to the release the Dependabot PRs proposed, as full commit SHAs with a `# vX.Y.Z` comment, verified against the upstream tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`: `actions/checkout` v7.0.1, `pnpm/action-setup` v6.0.10, `sigstore/cosign-installer` v4.1.2, `anchore/sbom-action/download-syft` v0.24.0. `actions/dependency-review-action` is no longer used; skip it.
- R2. Bump `vitest` to 4.1.11 in the root or package manifests where it is pinned, regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only` or a normal install, and keep `--frozen-lockfile` working.
- R3. Check each other pinned action for a newer release and bump it the same way only when the major version does not change; list any major bump you skipped.
- R4. After the PR is open, close Dependabot PRs #1–#6 with one comment each that links the replacement PR. Do not delete their branches.
- R5. Any test in `tests/architecture` that asserts action pins or versions is updated in the same change.

## Test requirements

- `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm build` pass.
- CI on the PR is green.

## Deliverables

PR against `main` with the bumps, STE step, and this spec copied to `.specs/github-actions-pin-refresh/spec.md`. Report the PR URL and the six closed PRs.

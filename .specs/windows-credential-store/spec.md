# Spec: Windows credential store and packaged CLI binary smoke test

- Size: Medium
- Runnable now: yes (fakes; no Windows host needed for unit tests)
- STE step to add: Step 133 (renumber to the next free number on rebase)
- ADR to add: ADR 0108 — "Windows CLI credential storage through the platform vault"
- Branch: `spec/windows-credential-store`

## Problem

`makeSystemCredentialStore` in `apps/cli/src/node-runtime.ts` supports `darwin` (`/usr/bin/security`) and `linux` (`secret-tool`) and fails closed on `win32`. STE Steps 26 and 95 record "Windows credential storage and packaged-binary smoke tests are not complete". README scopes them out of pre-alpha; PRODUCT.md FR-16 lists Windows among CLI targets.

## Requirements

- R1. On `win32`, store, read, and delete the refresh token through the Windows credential vault using `powershell.exe -NoProfile -NonInteractive -Command` and the WinRT `Windows.Security.Credentials.PasswordVault` API (resource `dev.gridora.cli`, user name = profile). No third-party module, no plaintext fallback, no token on the command line: pass the secret through stdin with the existing `runWithInput` seam.
- R2. Missing item reads return `undefined`; unavailable PowerShell or vault errors fail closed with the existing `keychain_*` failure codes and exit codes.
- R3. Profile names stay restricted to `[A-Za-z0-9._-]` and are never interpolated into a PowerShell string without single-quote escaping.
- R4. Unit tests with a fake `CredentialProcess` cover set, get, get-missing, delete, delete-missing, vault error, PowerShell absent, and the escaping of a hostile profile name.
- R5. Packaged-binary smoke: add a workspace script that builds the CLI with the existing `tsdown` build and runs `dist/main.mjs --version` and `--help` on the current platform, and add it to the CI `verify` job in `.github/workflows/ci.yml`. Keep it to the existing runner; do not add a Windows matrix leg.
- R6. Update README "Requirements" to name the Windows vault requirement.

## Test requirements

- R4 tests plus the existing `apps/cli/test/system-credential-store.test.ts` updated so `win32` is no longer the "unsupported" fixture.
- `pnpm check`, `pnpm test`, `pnpm build` pass; workflow test in `tests/architecture` updated if it asserts CI job steps.

## Deliverables

PR against `main` with code, ADR 0108, STE step, README update, and this spec copied to `.specs/windows-credential-store/spec.md`.

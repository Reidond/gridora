# ADR 0108: Windows CLI credential storage through the platform vault

- Status: Accepted
- Date: 2026-09-24
- Extends: ADR 0071

## Situation

ADR 0071 stores CLI refresh tokens in macOS Keychain or Linux Secret Service
and fails closed on every other platform. PRODUCT.md FR-16 lists Windows x64
among the CLI targets, so a Windows user could not keep a login. The CLI also
had no check that the packaged `tsdown` binary starts: the emitted
`dist/main.mjs` imported workspace packages that export TypeScript source, and
it failed with `ERR_MODULE_NOT_FOUND` before it printed help.

## Task

Store, read, and delete the Windows refresh token in the platform credential
vault without a third-party module, a plaintext fallback, or the token on a
command line. Keep the existing failure codes and exit codes. Prove on the
existing CI runner that the packaged binary starts and reports its version and
help.

## Execution

On `win32`, the CLI runs `powershell.exe -NoProfile -NonInteractive -Command`
with a fixed script. The script loads the WinRT
`Windows.Security.Credentials.PasswordVault` projection through Windows
PowerShell 5.1. PowerShell 7 does not load WinRT types, so the adapter names
`powershell.exe` and not `pwsh`. The resource is `dev.gridora.cli` and the user
name is the profile.

The profile must match `[A-Za-z0-9._-]` before any process starts. The script
also embeds the profile only as a single-quoted PowerShell literal. The literal
doubles the ASCII apostrophe and the four typographic single quotes that
PowerShell also accepts as delimiters.

`set` sends the token through standard input with the existing `runWithInput`
seam as base64 UTF-8 text. `get` returns base64 UTF-8 text. This keeps the
console code page from changing the token. The process arguments never contain
the token or its encoding.

The script exits with 44 only when `Retrieve` fails with "Element not found"
(HRESULT `0x80070490`). The CLI treats that exit as a missing item: `get`
returns `undefined` and `delete` succeeds. Every other vault failure exits 1
and maps to `keychain_read_failed`, `keychain_write_failed`, or
`keychain_delete_failed`. A missing `powershell.exe` maps to
`keychain_unavailable`. Each failure uses the authentication exit code.

The CLI build bundles `@gridora/*` workspace packages through
`apps/cli/tsdown.config.ts`. Registry dependencies stay external. The CLI
prints its package version for `--version`. `pnpm test:cli-smoke` builds the
CLI, runs `dist/main.mjs --version` and `--help` from an empty directory with an
empty configuration directory, and checks the output. The CI `verify` job runs
it on its existing Ubuntu runner.

## Consequences

Windows users can keep a CLI login in the Credential Locker of their Windows
account. Windows PowerShell 5.1 must be present on `PATH`; it ships with
supported Windows desktop and server releases. The adapter resolves
`powershell.exe` through `PATH`, like the Linux adapter resolves
`secret-tool`. Each credential operation starts one PowerShell process.

The Credential Locker is per Windows user and roams with that account when the
user enables credential roaming. The CLI does not add a plaintext fallback, so a
locked-down host without PowerShell cannot persist a login.

CI proves only that the packaged binary starts on Linux. It does not add a
Windows runner. A real Windows host has not executed the vault script, so the
Windows adapter remains unproven outside the injected process fake until a
Windows smoke run records evidence.

## Verification

Focused tests use an injected process adapter. They assert the exact
PowerShell argv and standard input for Windows set, get, and delete. They cover
missing-item get and delete, vault errors, absent PowerShell, a hostile profile
rejected before any process starts, and the escaping of every single-quote form
in a profile literal. The existing unsupported-platform test now uses
`freebsd`. A CLI test covers `--version`, help output, and an invalid profile.
The architecture workflow test asserts the CI smoke step and the single
Ubuntu runner. `pnpm test:cli-smoke`, `pnpm check`, `pnpm test`, and
`pnpm build` pass locally. No real Windows vault, Keychain, Secret Service
collection, Access grant, or user token was changed.

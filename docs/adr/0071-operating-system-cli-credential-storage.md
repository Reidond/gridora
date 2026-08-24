# ADR 0071: Store CLI refresh tokens in the operating-system credential store

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0007

## Situation

The CLI uses Cloudflare Access Managed OAuth. A refresh token can outlive one
CLI process. A plaintext file would expose the token to file-copy, backup, and
support workflows. A macOS-only implementation would also violate the Linux
CLI requirement.

## Task

Store each profile refresh token in a supported operating-system credential
store. Keep tokens out of process arguments and profile files. Reject an
unsafe profile name before a credential-store process starts. Fail closed when
the operating system has no supported store.

## Execution

The macOS adapter uses Keychain through `/usr/bin/security`. It sends the
encoded secret through process input. The Linux adapter uses Secret Service
through `secret-tool`. It sends the token through process input. Both adapters
use `dev.gridora.cli` as the fixed service and the validated profile name as
the account.

The CLI treats a missing item as an unauthenticated profile. It treats every
other credential-store failure as an authentication error. It does not add a
plaintext fallback. The profile file contains only non-secret configuration
and retains owner-only permissions.

## Consequences

Linux installations must provide a working Secret Service session and
`secret-tool`. macOS uses the user Keychain. An unsupported platform cannot
persist a login until Gridora adds a reviewed adapter. Access tokens remain
process memory only.

## Verification

Focused tests use an injected process adapter. They cover macOS read, write,
and remove; Linux read, write, and remove; missing items; unsafe profile names;
unsupported platforms; and the absence of token text in process arguments.
The CLI typecheck and 32 CLI tests pass locally. No real Keychain, Secret
Service collection, Access grant, or user token was changed.

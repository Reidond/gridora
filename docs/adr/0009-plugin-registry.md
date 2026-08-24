# ADR 0009: Build-time plugin registry

- Status: Accepted
- Date: 2026-08-23

## Context

Plugin code can create commands and network access. Runtime code loading expands risk.

## Decision

Release builds generate a registry from reviewed first-party plugin packages.
Runtime loading, dynamic evaluation, and cross-plugin imports are prohibited.

## Consequences

Plugin capabilities and compatibility are statically inspectable and signed with
the release. Third-party plugins require a future sandbox and signature ADR.

## Alternatives

We rejected remote JavaScript plugins. Review cannot control loaded code. We rejected
cross-plugin imports. They create hidden coupling.

## Verification

Generate the registry in CI. Check dependency boundaries. Run capability tests.

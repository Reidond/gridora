# ADR 0048: Separate platform provider authority and secrets

- Status: Accepted
- Date: 2026-08-23

## Situation

Gridora must provision through platform-owned provider accounts by default. An
organization membership is not platform authority, and a tenant secret envelope
cannot safely represent a global provider credential.

## Task

Define a durable Platform Administrator boundary, a separate encrypted platform
credential scope, exact tenant allocations, and a revision-fenced credential
opening contract for provider execution.

## Decision

Keep Platform Administrator grants in a global table tied to an active Gridora
identity. Keep platform provider secrets in their own envelope table and bind
AES-GCM and KEK wrapping to platform-scoped authenticated data. Commit account,
secret, audit, and idempotency facts in one D1 batch. Open credentials only when
the requested account and credential revisions still match an active,
organization-null platform account.

## Execution

- Authorize the active Access subject against `platform_administrators`; never
  derive platform authority from organization membership.
- Validate new and rotated credentials through the existing read-only provider
  validators before persistence.
- Encrypt credentials with a fresh data key and the existing narrow KEK port;
  clear caller, data-key, and plaintext buffers after use.
- Bind platform envelope AAD to the platform scope, provider-account type,
  envelope ID, and account ID.
- Revision-fence account changes, credential rotation, allocation changes, and
  idempotency replays.
- Write a `global_audit_events` row for every successful mutation in the same D1
  transaction as its mutation result.
- Reject account or envelope rotation/deletion while an active node execution
  lease references the account.
- Restrict allocations to an active organization, bounded region/plan lists,
  node quota, optional non-negative budget, and explicit active/disabled status.
- Include a credential digest, never credential material, in add/rotate request
  fingerprints.

## Consequences

Platform credentials cannot be reached through tenant envelope APIs or tenant
membership. Provider execution receives a narrow exact-revision opener. The
central Worker composes Platform Administrator routes separately from
organization authorization. OpenAPI and the generated client publish the strict
platform operations. No response contains credential material.

The local composition does not prove live Cloudflare Access, KEK, D1, or provider
behavior. These live boundaries stay fail-closed until operators configure and
verify them.

## Verification

- Migration tests apply the separate authority, envelope, mutation, audit, and
  lease guards.
- SQLite behavior tests cover response-loss replay, revision conflicts,
  allocation fencing, active-lease rejection, and secret-canary exclusion.
- Route tests cover platform authorization denial, strict input, and credential
  non-disclosure.
- Central API tests cover route composition. Generated-client tests cover each
  platform mutation contract.
- Package, API, and generated-client type checks pass locally.
- No deployed Platform Administrator grant, Cloudflare KEK, D1 mutation, live
  provider validation, allocation, credential open, or paid provider execution
  is recorded.

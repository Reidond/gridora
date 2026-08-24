# ADR 0014: Public authentication and local bootstrap

- Status: Accepted
- Date: 2026-08-23

## Context

Sign-in and sign-up have different account effects. Access can return the same identity.

## Decision

`/sign-in` and `/sign-up` are public intent pages that start distinct Access
authentication flows. After Access validation, sign-up atomically creates or
completes one local identity; sign-in requires an existing enabled identity. A
user without membership is routed to organization setup.

## Consequences

Gridora stores no passwords. Auth intent is signed, short-lived, audience-bound,
and CSRF protected. Duplicate callbacks are idempotent and audited.

## Alternatives

We rejected automatic account creation during sign-in. It bypasses sign-up policy.
We rejected Gridora passwords. Access already owns identity authentication.

## Verification

Replay each callback. Forge auth intent. Verify one identity and one audit record.

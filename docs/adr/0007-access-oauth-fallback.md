# ADR 0007: Cloudflare Access and Managed OAuth fallback

- Status: Accepted
- Date: 2026-08-23

## Context

Access proves identity. Gridora must also enforce local account and membership state.

## Decision

Access establishes human identity but never organization authorization. Web uses
an Access session; CLI uses Managed OAuth with PKCE. The OAuth adapter is isolated
behind a token service contract. If the beta service is unavailable, operators
disable new CLI login while existing short-lived sessions expire; static user API
keys are not introduced as a fallback.

## Consequences

Every request validates issuer, audience, expiry, and identity, then loads local
membership. Sign-in cannot silently create a local account.

## Alternatives

We rejected native passwords. They add credential storage risk. We rejected static
user API keys as the CLI fallback. They are easy to copy and hard to scope.

## Verification

Test wrong issuer, audience, expiry, intent, and membership. Test PKCE callbacks.

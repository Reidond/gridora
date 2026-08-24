# ADR 0016: One-time authentication state

- Status: Accepted
- Date: 2026-08-23

## Context

Gridora sends a user through Cloudflare Access. An invitation token and a display
name must not enter the identity-provider URL. A callback must not trust URL data.

## Decision

The API stores the complete intent in one Durable Object. The browser receives one
opaque state value and one `HttpOnly`, `Secure`, `SameSite` verifier cookie. The
external URL contains only the state value. The API consumes the state once and
deletes the stored secret data. The API accepts only approved local return paths.

## Consequences

The web application cannot complete an intent in another browser. A replay fails.
The API must keep Durable Object state available during the five-minute intent.

## Alternatives

We rejected signed query data. Query data can enter proxy, identity-provider, and
referrer logs. We rejected a state value without a separate browser verifier. It
does not prevent login cross-site request forgery.

## Verification

Test another browser, a replay, a changed return path, a missing cookie, and an
expired state. Confirm that the external URL contains only `state`.

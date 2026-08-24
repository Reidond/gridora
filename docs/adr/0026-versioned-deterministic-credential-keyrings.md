# ADR 0026: Versioned deterministic credential keyrings

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0017 and ADR 0025

## Context

An invitation create or node registration exchange can commit before its response
reaches the caller. A random replacement value would not match the hash in D1. A
key rotation can also make a committed invitation or registration response
unrecoverable if Gridora removes the old key immediately.

## Decision

Gridora derives invitation tokens and node credentials with HMAC-SHA-256. The
derivation input includes a fixed protocol label and the complete resource scope.
Invitation scope identifies the organization and idempotent invitation operation.
Node credential scope identifies the organization, node, provider instance, and
one-time registration token hash.

Gridora stores only the derived value hash. An outbox event stores the invitation
key version and derivation scope, not the bearer token. A lost-response retry
derives candidate values from the current key and one previous key, then selects
the value whose hash matches canonical state.

Each HMAC key must contain at least 32 bytes. Current and previous keys must be
different. Invitation key version names must be present and different. New values
use the current key only.

An operator must keep the previous invitation key for the maximum invitation,
outbox lease, Queue retry, and email remediation lifetime. An operator must keep
the previous node credential key until every registration exchange that can replay
has completed or expired. Removal before those limits is an availability failure.

## Consequences

A lost response does not require Gridora to store or return plaintext bearer values
from D1. One controlled key overlap preserves retries during rotation. Compromise
of an active HMAC key can reproduce every value in that key's scope, so the key
must remain outside source code, D1, logs, and Queue payloads.

The implementation supports one previous key. A rotation procedure must not start
a second rotation before the first overlap period ends.

## Alternatives

We rejected random value replacement after a lost response. It cannot match the
committed hash. We rejected plaintext bearer values in D1. We rejected immediate
old-key removal. We rejected an unbounded key list because it extends compromise
and operational ambiguity.

## Verification

Lose the invitation create response and the registration exchange response. Retry
with the same scope. Confirm that the returned value is stable. Rotate each key.
Confirm recovery with the previous key and issuance with the current key. Reject a
short key, equal keys, equal version names, an unknown version, and a changed scope.

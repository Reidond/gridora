# ADR 0021: Client mutation idempotency

- Status: Accepted
- Date: 2026-08-23

## Context

The API can commit a mutation before the client loses the response. A new key on
manual retry can create a second resource or a second provider charge.

## Decision

The web client assigns one opaque idempotency key to one logical submission. It
stores the key in session storage under a hash of the action and canonical request.
It keeps the key after a network error, an invalid success response, HTTP 408, HTTP
425, HTTP 429, or an HTTP 5xx response. It removes the key after a confirmed success
or a definitive client error.

Concurrent copies of the same submission use the same key. A later intentional
submission gets a new key after the first submission has a definitive result.

## Consequences

A page refresh can retry an uncertain request safely in the same browser tab. A
user cannot use the request body as the idempotency key. The server still must bind
the key to a request fingerprint and reject a changed payload.

## Alternatives

We rejected a new UUID in each API call. It does not survive a lost response. We
rejected a deterministic key with no lifecycle. It can replay an old intentional
operation forever.

## Verification

Lose the first response. Create a new client runner. Retry the request. Confirm that
both requests use one key. Confirm that success and definitive rejection rotate the
key. Confirm that concurrent copies use one key.

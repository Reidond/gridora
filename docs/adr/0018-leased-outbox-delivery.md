# ADR 0018: Leased outbox delivery

- Status: Accepted
- Date: 2026-08-23

## Context

D1 mutations and event publication cannot commit in one transaction. A process can
stop after publication and before it marks an event as delivered.

## Decision

The mutation writes its outbox event in the same D1 batch. A publisher claims rows
with a worker ID, a random lease token, and an expiry. Only that token can mark the
row delivered or failed. An expired lease can be reclaimed. Every downstream event
consumer uses the event ID for idempotency.

## Consequences

Delivery is at least once. A crash can publish an event again, but it cannot apply
the event twice. Membership removal always leaves a durable revocation event.

## Alternatives

We rejected direct publication after commit. A failed request can leave committed
state without an event. We rejected an unlocked pending-row scan. Concurrent workers
can publish the same row without fencing.

## Verification

Stop after publish and before mark. Reclaim the lease. Confirm one downstream state
change. Confirm that a stale worker cannot mark the row.

# ADR 0078: Adopt telemetry archive retry decisions after response loss

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0053, ADR 0066, and ADR 0070

## Situation

Telemetry archive reconciliation can commit a retry or terminal cleanup
decision and then lose the D1 response. Allocating another retry generation on
the next Queue delivery can duplicate R2 work, violate the generation fence,
or strand the already committed ledger row.

## Task

Make the retry ledger the authoritative response-loss boundary. A repeated
Queue delivery must adopt the exact committed decision before it allocates or
uploads anything new.

## Execution

The reconciler derives a deterministic decision identity from the organization,
node, stream, epoch, segment, generation, and attempt. It reads that identity
before mutable stream state. A D1 transaction records the retry decision,
watch lease, and archive generation fence. If the write response is lost, the
next delivery adopts the exact row and continues its recorded action. Changed
scope or payload is rejected.

Cleanup compacts only a terminal generation whose upload and live-log authority
are resolved. Pending decisions remain scheduled ahead of cleaned rows, and
bounded attempts prevent an infinite Queue loop.

## Consequences

Queue at-least-once delivery no longer creates multiple archive generations for
one retry decision. The path remains epoch-fenced and tenant-scoped. Local
tests do not prove a live Queue or R2 deployment.

## Verification

Telemetry archive reconciliation tests inject a response loss after the D1
commit, adopt the same decision, and compact the cleaned row. Runtime,
epoch-reservation, live-log authorization, R2 cleanup, migration, and mutation
inventory checks pass locally.

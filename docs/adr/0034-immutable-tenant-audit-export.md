# ADR 0034: Immutable tenant audit export

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013 and ADR 0018

## Situation

D1 is the authoritative relational audit store. D1 is not the long-term archive
for all audit events. A Queue can deliver the same event more than once. An R2
write response can be lost after R2 stores the object. An audit summary can also
contain a secret-shaped field that must not enter an outbox or Queue.

## Task

Gridora must export every tenant audit row once by identity. Gridora must preserve
the exact organization boundary. Gridora must reject unsafe summaries before
they enter the export path. A retry must adopt only the exact immutable archive
object. An old valid audit timestamp must not block export.

## Execution

Migration 0007 adds an immutable audit-event-to-export-request mapping. The
mapping uses one reserved sequence. Update and delete triggers reject changes to
the mapping. The outbox ID namespace for audit export is reserved. A migration
backfill and an `AFTER INSERT` trigger create the same strict outbox contract.

A D1 guard requires an object summary. The guard walks the complete JSON tree.
It rejects secret-shaped and unsafe property names before the audit row and
outbox row commit. Application code must still write only a bounded, secret-free
summary.

The outbox payload contains the authoritative audit row and its immutable export
request ID. The publisher validates the event type, tenant, partition, timestamp,
request ID, and strict payload. It rejects a changed, swapped, foreign, or unsafe
payload. It waits for the dedicated Queue send before it marks the outbox row as
delivered.

The archive consumer creates bounded canonical JSON. It applies recursive
secret-field redaction as a second defense. It derives the R2 path from the
organization, UTC date, and a SHA-256 identity for the organization and audit
event. It writes with an only-if-absent condition. After a lost response, it
adopts the object only when ownership metadata, size, checksum, and bytes match.

## Consequences

The same audit identity converges after Queue duplication and R2 response loss.
One organization cannot choose another organization path. A malformed or unsafe
audit summary fails the source transaction. This failure is intentional because
silent removal of audit evidence is not allowed.

The local migration, producer, and R2 adapter do not prove a live archive. A
release still needs a configured Queue, dead-letter policy, R2 lifecycle policy,
alerting, retention review, and a live replay exercise.

## Verification

Tests must cover atomic insert and outbox creation, deterministic backfill,
immutable mapping, namespace collision, old timestamps, organization partition,
swapped request identity, secret canaries, duplicate Queue delivery, failed Queue
send, conditional R2 creation, response-loss adoption, changed bytes, changed
metadata, bounded canonical JSON, and future-clock skew. A live test must prove
Queue retry, dead-letter visibility, R2 archive readback, and tenant retention.

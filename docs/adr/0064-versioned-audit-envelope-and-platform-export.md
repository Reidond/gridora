# ADR 0064: Use a complete versioned audit envelope and platform export

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0018, ADR 0021, ADR 0034, and ADR 0063

## Situation

The old audit row stored only a compact after-state summary. It did not always
store the request, source, before-state, durable operation, or error fact. A
platform event also needed a separate partition. It must not use a false
organization ID. A Queue consumer only knew the old tenant payload.

## Task

Gridora stores one versioned audit envelope for each post-migration mutation.
The envelope is complete. It records the timestamp, actor type and ID, scope,
organization when the scope is tenant, request ID, correlation ID, action,
target, before-state, after-state, operation ID, source facts, result, error
classification, forced flag, and break-glass flag.

Keep tenant and platform audit partitions separate. Reject incomplete,
inconsistent, oversized, or unredacted evidence before the compact audit row
commits. Make exact replay and export safe after a lost response.

## Execution

The writer creates the exact durable operation first. The writer stages the
complete envelope. The writer then inserts the compact audit row in the same
D1 transaction. A trigger checks the operation actor, target, correlation,
terminal result, compact row, envelope, and scope. A direct post-migration
audit insert fails. A retry can adopt the same immutable audit row and export
request. It cannot create a second row.

The platform has its own operation ledger, audit partition, durable export
outbox, Queue message, and R2 prefix. A platform event has a null organization
in the envelope. It has no tenant metadata and no fabricated tenant owner.

The envelope is redacted before staging. D1 rejects an unredacted secret-like
key, excess shape, invalid state union, invalid UTC calendar value, or data
that exceeds the canonical archive budget. R2 receives the complete envelope,
not a compact compatibility payload. Tenant audit views join and return the
full versioned envelope. Pre-0028 rows are marked `legacy`; they are not
called complete.

HTTP creates one validated request and correlation ID. The HTTP adapter puts
the ID, trusted Cloudflare IP, and validated Access facts into
`AuditRequestContext`. Repository effects use this context. Machine, scheduler,
and internal writers provide explicit source facts.

Each complete envelope stores one source origin. The origin is `http`,
`machine`, `scheduler`, or `internal`. A human HTTP envelope stores a captured
Access subject, issuer, email, and the same identity ID as the audit actor.
The SQL trigger checks the subject and email against the durable identity. A
machine envelope has no Access session. A scheduler or internal envelope has
no client IP and no Access session.

D1 uses the immutable staging time as the admission clock. It rejects an
occurrence time more than five minutes after that time. The export event stores
the same value as `admittedAt`. Queue and R2 check this durable pair. They do
not compare a delayed delivery with their current wall clock.

Policy reconciliation and orphan reconciliation create a terminal scheduler
operation, stage a v1 envelope, and insert the compact row in one D1 batch.
Their response-loss paths read the committed reconciliation result and do not
create another operation, audit row, or export request.

## Consequences

Every new mutation must create an exact durable operation and a complete v1
envelope. A writer cannot use a shared audit-record operation. A writer must
capture a real before-state or state that the resource was absent. A human HTTP
writer must retain validated Access source facts. Non-human writers must use an
immutable actor binding when their public actor ID differs from the compact-row
identity.

The stricter fence can reject an old writer until that writer is converted.
This is intentional. It prevents silent partial audit evidence. A legacy row
remains readable and exportable, but it remains visibly legacy.

The mutation inventory records the real owner, operation path, and audit path
for each completed or converting writer. It remains a release blocker while a
conversion is in progress. It does not assert zero conversions before every
owner has completed its work.

## Verification

Focused migration tests apply the real SQL. They cover legacy backfill,
tenant/platform ID collision, strict staging, exact-operation checks,
authoritative row mismatch, state unions, UTC calendar checks, redaction,
canonical bounds, immutability, response-loss adoption, platform outbox
immutability, platform partition isolation, source-origin spoofing, and the
durable timestamp admission boundary. Focused contract, Queue/R2, inventory,
policy, orphan, API, and web tests verify the v1 envelope path. No live Worker, D1
database, Queue, R2 bucket, Access policy, or game server was changed.

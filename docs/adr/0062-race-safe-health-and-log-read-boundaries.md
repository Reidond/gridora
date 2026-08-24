# ADR 0062: Keep health and log observation reads bounded and race-safe

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0002, ADR 0040, ADR 0041, and ADR 0053

## Situation

The observation packages persisted bounded health and log data, but the API did
not have a tenant-scoped current-health and history boundary. Equal-time health
writers could also both pass a pre-read before one conditional write lost the
race. Log queries accepted ambiguous parameters, live-ticket issue could create
a Durable Object for a synthetic server ID, and one server-wide membership
revision let one principal's membership revision deny another principal.
Malformed telemetry and failed stream opens also returned incorrect server
errors.

## Task

Add bounded viewer reads without weakening tenant isolation. Settle concurrent
health writes against the committed row. Allocate a live log stream only for a
current server. Bind membership revision to the principal, and return stable
client or availability errors at the HTTP boundary.

## Execution

The health repository exposes current snapshots and bounded hourly history.
Current and hourly writes use one conditional upsert. A zero-row write performs
an exact post-read: a newer committed sample wins, an identical sample is an
idempotent replay, and a different sample at the same timestamp is a conflict.

Health routes accept an authorized organization ID or immutable slug. They
reject unknown or repeated query fields, enforce canonical timestamps, cap the
time range and page size, and return current node or server health, hourly
history, and filtered alerts.

Log archive routes reject unknown and repeated query fields. Live-ticket issue
and upgrade verify the exact active organization/server scope before any
Durable Object call. The Durable Object stores the current membership revision
under the principal ID instead of one server-global key. Its fixed stream route
is registered before the archive wildcard.

Chunked telemetry uses a hard streaming byte cap. Malformed or oversized input
returns a typed 400 error before ingestion. A rejected stream open returns 503.
The API and infrastructure templates bind the log R2 bucket and live-log
Durable Object. Terraform declares separate backup and log buckets.

## Consequences

Readers cannot expand a query with repeated or unknown fields. A same-time
health race cannot report success for two different authoritative values. A
Viewer cannot allocate storage for a nonexistent server. Membership revision
changes revoke only the affected principal and do not deny other members.
Telemetry clients receive stable retry semantics.

## Verification

Focused tests cover current and hourly contenders, tenant-scoped current reads,
invalid ranges, repeated and unknown queries, nonexistent stream targets,
malformed and chunked-oversize telemetry, 503 stream recovery, per-principal
ticket initialization, and route precedence. Health D1 and realtime type checks
pass. Infrastructure contract tests cover the log bucket and Durable Object
bindings. The health and log route registrars remain intentionally absent from
the production API composition until the exact machine-authenticated ingestion
adapter is connected, so no live observation claim is made.

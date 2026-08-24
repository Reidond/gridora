# ADR 0066: Commit machine telemetry before best-effort live log publication

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0040, ADR 0041, ADR 0044, ADR 0053, and ADR 0062

## Situation

The health, archive, live-log, and agent telemetry packages had bounded local
contracts but no production composition. A node credential could otherwise be
used with a forged organization, node, or server body. A lost R2, D1, Queue,
or HTTP response could either duplicate a live frame or advance metadata for
bytes that were never durably written. Server and container health could also
be incorrectly inferred from an untrusted agent container list.

## Task

Accept a bounded machine telemetry sample only for the exact active credential
and connected session, preserve immutable log bytes before metadata, make a
lost response adopt only an exact completed receipt, and treat live delivery as
recoverable publication rather than archival truth. Expose bounded Viewer
health and archive reads plus a short-lived, one-time, exact-server stream.

## Execution

The Worker authenticates a credential into an organization, node, credential
version, and session version before it reads the body. The body organization
and node must equal that principal. A log batch has exactly one server and only
passes when its one authoritative deployment is `running` on that node. The
database, not a container name or body field, supplies the deployment ID.
Node health is aggregated deterministically into current and hourly records
and bounded alerts. No server or container health is derived from this
machine sample.

R2 receives canonical gzip NDJSON first. An existing object is adopted only
when its organization, node, server, archive identity, canonical bytes,
uncompressed digest, compressed digest, timestamps, entry count, and size all
match. Migration 0029 then commits the archive metadata, a server-scoped
watermark, node health aggregates and alerts, immutable receipt, pending live
publication, terminal operation, and staged v1 machine audit in one D1 batch.
The receipt binds the credential/session version, organization, node,
deployment, sample, sequence interval, archive identity/checksum/key, and
accepted time. A changed replay conflicts; an exact committed replay is
adopted even if the HTTP response was lost.

The audit operation, correlation, and receipt IDs use the public identifier
alphabet. A deterministic suspended machine audit identity binds the v1
machine actor to the compact operation/audit actor through
`audit_actor_bindings`. The envelope records captured or absent before/after
state and captures a validated Cloudflare edge IP only when the Worker runtime
provided trusted request metadata. Local or internal spoofed headers remain an
explicit unavailable source fact.

The Queue receives only the immutable archive identity and checksum after D1
commits. Its consumer re-reads the exact catalog record and R2 gzip object,
checks the archive sequence range, and publishes bounded entries to an
organization/server Durable Object. The Durable Object stores archive identity
and checksum with its event transaction, so a Queue retry or lost Queue
response cannot broadcast the same archive twice. Failure to publish live
data retries the Queue; it never makes the durable archive unavailable.

The API registers fixed `logs/stream` routes before the archive wildcard.
Tickets are short-lived, one-time, membership-revision fenced, and scoped to
one organization, server, and principal. Health and archive reads remain
Viewer-scoped and bounded. The generated client, CLI `logs` command, and web
server page use these real routes; console remains unavailable until a built-in
plugin declares console capability.

## Consequences

Machine telemetry cannot choose a tenant, node, or arbitrary server. Archive
read availability no longer depends on the live stream, and a live stream
cannot receive an archive twice from ordinary Queue retry. R2 is the byte
authority, D1 is the receipt and metadata authority, and the Durable Object is
only the bounded delivery authority. This adds one immutable machine identity
per credential version and retains bounded archive-dedupe evidence in the
Durable Object.

## Verification

Focused integration tests apply all migrations and cover exact R2-first
ingestion, operation schema decoding, edge-IP capture, forged tenant scope,
non-running deployment rejection, credential revocation, exact replay,
changed sequence conflict, concurrent ingestion, lost D1 response adoption,
archive metadata mismatch, decompression limits, route precedence, Viewer
reads, generated-client paths, and infrastructure log-bucket bindings.
Focused telemetry/API/log-R2/migration/realtime/generated-client/CLI/web
checks pass locally. No Worker, Queue, Durable Object, R2 bucket, D1 database,
Cloudflare Access policy, or game server has been deployed or changed.

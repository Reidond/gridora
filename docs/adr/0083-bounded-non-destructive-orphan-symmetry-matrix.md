# ADR 0083: Use a bounded non-destructive orphan symmetry matrix

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0039, ADR 0054, ADR 0064, ADR 0068, and ADR 0069

## Situation

The provider-node orphan scan compares D1 nodes with provider instances. It
does not compare the other copies of runtime state. A D1 deployment can exist
without an agent container. A node can report a port that belongs to another
server. D1 and provider DNS can disagree. Tunnel authority can become stale.
An R2 backup prefix can exist without D1 backup metadata, or D1 metadata can
refer to an absent prefix.

These differences can indicate data loss or tenant boundary failure. A scan
must make the difference visible. A scan must not treat the difference as
permission to delete an unknown container, DNS record, Tunnel, or R2 object.

## Task

Run one complete tenant-scoped symmetry check across the five runtime and
storage boundaries. Produce bounded, secret-free, high-severity evidence. Do
not grant the scan any external mutation capability.

## Execution

Use one tenant-scoped symmetry control for five resource kinds:

- deployment and agent container;
- D1 port lease and observed node port owner;
- D1 DNS authority and receipt and provider DNS record;
- D1 Tunnel and node management authority;
- D1 backup metadata and private R2 backup prefix.

The control accepts only read-only discovery ports. The ports do not expose a
delete, stop, update, put, or provider mutation method. Each page contains at
most 100 resources. One run reads at most five pages and 500 D1 authority
rows. The control rejects a foreign organization, a stale observation, an
invalid page completion marker, a repeated cursor, and an ambiguous authority
tuple.

The control reports missing, unmanaged, duplicate, foreign, mismatched,
missing-receipt, stale-receipt, and stale-authority states. Every finding has
severity `high`. Every finding has one fixed operator recommendation. Evidence
contains resource coordinates and fingerprints. It does not contain a provider
credential, Tunnel credential, machine credential, object body, DNS token, or
container environment.

Migration 0060 stores immutable scan runs and revisioned finding evidence. A
run has one terminal `succeeded` operation, one compact audit event, and one
complete version 1 audit envelope. The envelope states that the scheduler made
zero destructive actions. The immutable run stores the exact bounded finding
snapshot. The audit envelope binds its count and discovery fingerprint. The
run, audit data, and finding changes commit in one D1 batch. An exact retry
adopts the committed result after response loss. The repository re-reads and
fingerprints D1 authority before it writes.

A complete later scan can resolve finding metadata. It cannot delete finding
history. It cannot change an external resource. The evidence query is
tenant-scoped and paginated. It exposes only open, high-severity, secret-free
operator evidence.

The API runtime composes fixed read-only agent, DNS, Tunnel, and R2 sources.
The R2 source lists only the exact `organizations/<organization-id>/` prefix.
It groups manifest and chunk objects by the canonical backup prefix. It rejects
a returned key outside the tenant prefix and an invalid backup key. This
composition is a Queue or Workflow seam. It does not add a public unauthenticated
route.

## Consequences

Gridora can show symmetry failures without silently destroying an unknown
resource. An operator must inspect the evidence and use a separate accepted
lifecycle action for remediation. This makes automatic cleanup slower, but it
keeps ownership uncertainty fail-closed.

The generic agent, DNS, and Tunnel read ports still require production
adapters at the deployment root. The local implementation and fake adapters do
not prove a live provider, agent, Tunnel, DNS zone, R2 bucket, Queue, Workflow,
or D1 database.

## Verification

Control tests cover all five resource kinds, duplicate and foreign port
observations, missing containers, missing DNS receipts, Tunnel mismatch, R2
metadata/object asymmetry, pagination, exact replay, foreign scope, and cursor
failure. D1 tests cover complete version 1 audit evidence, atomic high-severity
finding persistence, response-loss adoption, metadata-only resolution,
immutable history, paginated evidence, and foreign actor rejection. API tests
cover fixed source ordering, composite cursors, bounded multi-page R2 grouping,
foreign R2 keys, and the absence of an R2 delete capability.

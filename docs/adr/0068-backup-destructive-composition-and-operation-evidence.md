# ADR 0068: Backup, destructive composition, and operation evidence

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0010, ADR 0015, ADR 0024, ADR 0030, ADR 0032, ADR 0051, ADR 0052, and ADR 0064

## Situation

Gridora had isolated backup, restore, cancellation, and destructive-lifecycle
packages, but the product requires real organization-scoped API, client, CLI,
web, D1, R2, Queue, Durable Object, Workflow, provider, and agent composition.
Manual backup alone is insufficient: scheduled policy, count-and-age retention,
restore cutover, response-loss adoption, and strict audit provenance are part of
the same contract. Organization deletion must not turn missing rows into false
physical deletion evidence. A retention transition to `expired` is likewise
not evidence that encrypted chunks and their manifest left private R2.

The shared operation page also exposed only the compact operation ledger. It
could not show real Workflow steps, retry attempts, waiting reasons, bounded
audit-derived logs, redacted provider references, recovery guidance, or a
terminal resource link. Empty placeholder timelines and a generic retry button
would misrepresent durable execution.

## Task

Compose backup, restore, scheduled backup, retention, operation cancellation,
and organization deletion through production ports. Preserve exact tenant,
actor, revision, request, correlation, idempotency, and audit coordinates from
HTTP acceptance through delayed execution. Require authoritative child
receipts for game-server DNS cleanup and node/provider/Tunnel retirement.

Add one generic, bounded operation-detail read model that projects only facts
already committed by game, backup, node, and destructive workflows. Do not
manufacture steps or logs, expose provider secrets, or advertise a retry action
without a typed mutation contract.

## Execution

Migration 0030 adds organization-scoped scheduled backup policy, an active
automation identity and membership fence, canonical UTC schedule instants,
deterministic dispatch coordinates, retry-safe claims, and count-and-age
retention. The scheduler starts or adopts the exact backup operation after a
lost response. Retention never prunes an active restore or source-preserved
artifact.

Migration 0052 turns scheduled retention into a crash-safe physical-deletion
protocol. Expiry preserves the catalog row; a deterministic scheduler claim
then fences the exact organization/server/backup prefix before any R2 call.
Encrypted chunks are deleted in bounded batches and the manifest is deleted
last. A retry adopts the same D1 claim and an exact empty prefix after response
loss. Only one atomic completion writes the operation-bound physical receipt,
marks the artifact and claim deleted, completes the operation, and emits the
strict-v1 audit and outbox evidence. The claim retains its original bounded
audit request context so delayed completion cannot substitute a later actor or
source. Foreign prefixes and active restores fail closed.

Migration 0054 closes the partial-upload and expiry races in that protocol.
An artifact in `creating` or `failed` may own encrypted R2 chunks even when no
manifest was published. Its deletion claim and immutable physical receipt now
bind the exact terminal create job and operation that owned the prefix; an
active create, reopened source job, changed source operation, foreign prefix,
or mismatched revision fails closed. Both retention selection and its atomic
state transition exclude an active physical-deletion claim, and a D1 trigger
prevents any other writer from expiring the claimed revision between an R2
delete and receipt commit. Organization deletion inventories every backup
state and cannot resolve an item, prepare a tombstone, or tombstone the tenant
until every data-owning artifact has exact physical evidence. R2 listing uses
an ordered `Set` so overlapping pages remain linear, bounded by unique keys,
and deterministic; chunks still precede the manifest.

Manual backup and restore routes use signed Workflows, signed agent commands,
chunked encrypted R2 objects, D1 manifests and receipts, checksum and manifest
verification, and source-preserving endpoint cutover. The agent validates a
staging tree before commit, retains the exact previous tree or an absent-source
marker through terminal validation, and deletes rollback material only in the
post-success finalize phase. Every failure after staging and before terminal
completion runs signed compensation ordinal 99 before a terminal compensated
failure can be written.

Migration 0048 persists immutable backup acceptance audit provenance, exact
workflow claim and terminal-audit receipts, immutable endpoint effects and
full source snapshots, per-record Cloudflare receipts, and exact rollback
effects. Cloudflare ownership and content must match either the planned source
or already-applied target state. Provider items are applied deterministically,
adopted after response loss, and compensated in reverse. Only after every
provider receipt exists does one D1 batch fence every DNS row, owner, provider
record, target, revision, effect, and endpoint receipt. Rollback restores both
provider and D1 state before a failed restore becomes terminal.
Cross-server restore obtains its target address only from exactly one active,
DNS-only target-server record in D1. There is no global environment fallback;
zero, duplicate, or invalid target evidence fails before the immutable effect
or any Cloudflare mutation is created.

Migration 0033 persists bounded canonical HTTP audit provenance for accepted
organization deletion. Migration 0035 persists cancellation provenance and
organization-deletion child linkage. Cancellation addresses only the exact
stored ResourceOperation Durable Object and Workflow instance and records
terminal companion operations for strict post-0028 audit envelopes. Migration
0048 makes completion and cancellation mutually exclusive: cancellation
acceptance fences the operation and backup job before inserting the request,
while finalization atomically aligns the operation, job, request, cancellation
facts, audit, outbox, and terminal receipt.
Organization deletion inventories child resources, accepts or adopts exact
game delete and node retire operations, and waits for their terminal evidence.
A game child resolves only after the cleanup repository proves a terminal
delete operation, no live DNS, and its operation-bound deleted-DNS receipt.
A node child resolves only when its deterministic child operation has the
operation-bound retirement receipt, provider and billing terminal facts,
Tunnel deletion, credential revocation, and node terminal state. Child rows
advance with the exact child operation and a one-row fence. Missing, foreign,
zero-row, or mismatched evidence remains waiting. Backups follow durable
retention, tenant credentials and reservations are cleaned, and the
organization tombstone is gated on all inventory rows and paid-resource truth.
Expired, failed, cancelled-creating, and in-flight deletion claims remain
inventory items. Under `delete-after-retention`, neither ready-to-tombstone nor
the organization tombstone can commit until each backup has an immutable
physical receipt whose claim, source owner when applicable, and deletion
operation are exact and terminal.

Migration 0043 adds a tenant-keyed operation projection. Triggers project real
destructive, game-command, backup, and node-runtime receipts into a bounded
step timeline; derive retry count and waiting reason; store only a redacted
provider-reference hint; and derive a final resource link only from a succeeded
operation. Audit-derived log rows retain only action, result, and time and are
immutable. The detail repository selects the newest 100 logs and then presents
those retained rows chronologically. Terminal operation transitions clear a
stale waiting reason. The repository limits steps and logs to 100 each and
checks exact cancellation facts. The API, generated client, and web detail
view use this projection. `retryAction` remains null because no generic typed
retry mutation exists.

Every HTTP audit uses its captured Access and edge request context. Scheduler
and internal work use explicit non-HTTP origins. Each successful v1 audit is
bound to an exact terminal operation; queued parent work is never described as
already succeeded.

## Consequences

Backup scheduling, retention, backup, restore, cancellation, and deletion
retries adopt exact durable facts instead of replaying side effects. Tenant
scope is explicit in D1, Workflow names, agent commands, R2 keys, Queue work,
child linkage, and operation reads. The UI shows only persisted progress and
truthful recovery guidance. Provider references are redacted before the read
model and no raw provider response or secret enters operation logs.

Organization deletion remains incomplete while any game DNS receipt, node
provider deletion or contract-end observation, Tunnel deletion receipt,
credential revocation, backup decision, or child terminal operation is absent.
The local implementation does not equate an accepted child Workflow with
cleanup completion. Live paid-provider execution remains separately controlled
and requires configured credentials and explicit authorization.

## Verification

The latest focused remediation run passes 92 of 92 tests across 16 files:
migrations 31 of 31, backup D1 18 of 18, backup R2 16 of 16, endpoint cutover 9
of 9, organization deletion runtime 8 of 8, organization-deletion provenance
7 of 7, and scheduled-backup consumer 3 of 3. It executes an exact claim,
physical chunks-first and manifest-last R2 deletion, a concurrent expiry
attempt, and the final immutable receipt; the claimed revision cannot be
stranded. It also deletes real failed-upload chunks through organization
deletion, proves exact source-job and source-operation receipts for failed and
cancelled partial uploads, rejects foreign prefixes, covers overlapping
multi-page R2 listings and the unique-key maximum, and proves missing or
duplicate restore target records cause no Cloudflare call. The backup D1,
backup R2, lifecycle-termination D1, and API TypeScript checks pass. This
lane's formatting check passes. Repository typecheck and lint both exit
successfully with one unrelated provider-account test warning about spreading
a class instance. This verification does not claim the full repository test or
build portions of `pnpm check`.
No live Worker, D1 migration, R2 bucket, Queue, Durable Object, Access policy,
provider account, Tunnel, node, DNS record, or game server was deployed or
changed. The node retirement executor still fails closed before provider or
Tunnel mutation because its immutable provider-binding snapshot adapter is not
yet composed; organization deletion therefore remains waiting on that exact
external cleanup evidence.

## Decision

Accept the source-preserving restore and reverse-compensating endpoint saga,
the single-winner cancellation fence, strict terminal backup audit, exact
operation-bound organization-deletion child receipts, and persisted operation
detail projection as the production contracts. Treat logical expiry or
terminal upload failure only as admission to the exact-prefix physical R2
deletion protocol, never as deletion evidence. Require exact D1 target DNS
authority for restore cutover. Keep organization deletion in the waiting state
until the node retirement executor supplies authoritative provider and Tunnel
cleanup evidence; neither accepted work nor resource absence is terminal
proof.

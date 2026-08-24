# ADR 0051: Authenticated backup and restore orchestration

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0006, ADR 0010, ADR 0024, ADR 0028, ADR 0030, ADR 0042, ADR 0044, and ADR 0050

## Situation

Gridora needed a durable backup boundary for server state without accepting
client-claimed deployment facts, plaintext keys, or upload acknowledgements as
proof of completion. Backup bytes are a manifest plus encrypted chunks in a
private organization prefix, while D1 must remain the source of truth for
ownership, revision, retention, operations, and restore eligibility.

Restore also has a stronger safety requirement than copying files. The source
server and original endpoints must remain available until the staged target has
passed plugin, build, configuration, mod, checksum, and health validation.
Same-server restore and staged cross-node restore must use the same durable
fence, and a failed cutover must leave the source intact and roll back the
staging attempt.

## Task

Implement manual and automation-triggered backup reservation, bounded
chunked encrypted private-R2 publication, wrapped per-backup data keys,
manifest/checksum verification, exact resumable replay, retention/list/create/
delete, and restore staging on a compatible same or different node. Derive
server, plugin, build, deployment, node, revision, and consistency facts from
tenant-scoped D1 and plugin capability data. Record every mutation as an
organization-scoped operation with audit, outbox, and durable Workflow-start
evidence where execution is asynchronous.

## Execution

The public create intent contains only schema version, requested categories,
and expiry. The server derives the deterministic backup ID from organization,
server, and idempotency key. A public request cannot select `scheduled`, a
node, build, plugin version, config revision, mod revision, or desired-state
revision. Automation context is the only source of a scheduled trigger.
Restore resolves the source server and metadata from the backup artifact; the
optional target server/node is checked against organization-scoped server,
deployment, node, plugin, and occupancy facts. A target deployment may be
staged inside the guarded Workflow, so same-server restore and cross-node
restore do not destroy the source reservation.

Migration 0018 adds backup job state, strict lowercase SHA-256 fingerprints,
artifact revisions, active-restore fencing, restore target checks, retention
policy state, ordered Workflow-step receipts, restore-cutover evidence, and
two-phase deletion claims. Reservation batches insert the
operation, backup job/artifact, audit event, outbox event, and
`lifecycle_workflow_starts` evidence together. Losing active-restore or
idempotency contenders roll back all side effects rather than leaving an
orphan operation or Workflow start. Expiration selects only newly eligible
artifacts with no active restore. Its candidate read and final conditional
update both enforce that rule. A restore completion SQL chain makes the
artifact transition a prerequisite for the job and operation transitions, so
a zero-row race cannot leave a false succeeded job. Retention uses the
organization automation principal instead of impersonating an Owner, and one
deleting or invalid tenant does not stop other eligible tenants.

The agent archives beneath the trusted server root with no-follow opens,
bounded disk policy, deterministic checksums, and a private mode-600 resumable
state file. Upload chunks are bounded to 64 KiB through 4 MiB and at most
65,536 chunks, making the reachable maximum exactly 256 GiB. The R2 transport
uses AES-256-GCM per chunk, organization/server/backup/operation AAD, a
wrapped per-backup key, and a manifest that is published only after every
chunk is present. A lost response adopts a remote chunk only after exact
index, byte-count, and checksum matching; a mismatch fails closed.

Deletion first claims and revision-fences the D1 artifact, then removes every
object below the exact private prefix with bounded listing and cursor-cycle
checks. Encrypted chunks are deleted in bounded batches and the manifest is a
separate final request. A lost response can adopt an empty prefix, but the
artifact is not marked deleted until the exact claim is completed. Active
restores block deletion claims. Delete failures remain retryable and produce
secret-free operation, audit, and outbox evidence.

Restore stages on the reserved target, validates plugin/build/config/mod state,
verifies the manifest and checksum, and waits for an authenticated monotonic
agent observation of the expected target. Endpoint cutover is atomic only
after validation and must report source preservation; rollback is attempted on
failure. The workflow executor rejects unsupported steps instead of treating
reserve, manifest verification, or retention deletion as successful no-ops.

Every Workflow step has an exact ordinal, fingerprint, revision, claim, and
effect identifier. A durable external adapter must adopt the same effect
identifier after response loss; it may not repeat a physical upload, agent
mutation, or cutover. Restore completion requires ordered staged, validated,
and committed cutover receipts plus source-preservation evidence. The final D1
trigger aborts the whole batch when a stale receipt or cutover revision loses,
so cutover cannot commit while its receipt remains claimed.

The public and internal API modules are intentionally isolated until the
composition root supplies the authoritative D1 loader, private-R2 deletion
capability, internal service authentication, signed Workflow executor, and
agent observation adapter. Migration 0030 adds daily per-server scheduling,
count-and-age retention, exact dispatch leases, and source-preserving endpoint
receipts. Internal responses redact R2 keys, request JSON, fingerprints, and
all secrets.
The internal route uses the canonical `/v1/internal` namespace. It reads at
most 64 KiB of raw bytes, authenticates the HMAC and nonce before decoding,
then applies an excess-property-rejecting schema. Replayed, oversized, or
misrouted requests fail before a Workflow step is loaded.

## Consequences

Backup and restore retries converge on exact durable jobs, revisions, claims,
checksums, and observations. Cross-tenant identifiers, caller-supplied
authoritative facts, foreign prefixes, corrupted chunks, stale revisions,
concurrent restores, active deletion races, unsupported Workflow steps, and
false completion acknowledgements fail closed. Plaintext data keys, provider
secrets, and raw game logs are not persisted or logged by these boundaries.

The deletion capability is intentionally separate from the ordinary R2 upload
port and is explicitly composed. Restore remains staged until live agent
observation and cutover evidence exist. The central API, generated client,
CLI, and web actions are composed; deployed migrations and live same-node or
cross-node execution still require environment verification.

## Verification

Behavior tests cover authoritative D1 fact derivation, minimal public intent,
scheduled-trigger fencing, deterministic request fingerprints, organization
scope, atomic create/restore acceptance, idempotency replay, losing-restore
side-effect rollback, exact completion evidence, running/cancel/failure
response-loss adoption, same-server and cross-node staging, deletion revision
claims, active-restore blocking, delete audit/outbox evidence, expiry replay,
bounded chunk upload, remote corruption, cancellation, no-follow path checks,
private resumable state, exact-prefix deletion, foreign-prefix refusal, cursor
cycles, partial-final-batch response loss, wrapped-key restore, manifest
verification, unsupported Workflow-step rejection, and observation-gated
restore completion.

Race tests place a restore between an expiry candidate read and write, remove
artifact eligibility immediately before completion, lose a step response,
repeat the exact effect identifier, reorder or skip a restore step, and make a
receipt lose after the cutover pre-read. They prove no partial terminal state,
one physical cutover, ordered adoption, and full D1 rollback. Route tests use a
real signed request and cover nonce replay and the raw-body size limit.

Focused backup-control, backup-D1, backup-R2, backup-workflow, migration, route,
and agent upload tests pass locally. Package type checks for the owned control,
D1, Workflow, R2, and route modules pass. The repository-wide type check is
clean.

Local verification also covers migration 0030, canonical scheduled dispatch
retry, registered scheduler identity fencing, count-and-age expiry, and exact
endpoint-cutover receipt adoption. Live verification remains pending for
deployed migrations/bindings and source-preserving execution on real nodes.

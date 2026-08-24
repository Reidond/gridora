# ADR 0070: Fence machine telemetry with epochs, reservations, and cleanup leases

- Status: Accepted
- Date: 2026-08-23
- Supersedes: the telemetry retry, live-stream, and archive-cleanup portions of ADR 0066
- Extends: ADR 0040, ADR 0041, ADR 0044, ADR 0053, ADR 0062, ADR 0064, and ADR 0066

## Situation

ADR 0066 composed production telemetry, but an independent security review
identified boundaries that were not yet durable enough for credential renewal,
server moves, membership revocation, and the R2/D1 cleanup crash window. In
particular, a pre-epoch live cursor could cross a deployment move, a stale
cleanup worker could race a completed receipt, and the agent did not yet use
its durable spool in the authenticated production loop. The follow-up review
also showed that a delayed ticket initializer could overwrite a newer
revocation, a conflicting same-sequence request could reach R2 before its
final epoch fence, and a machine-controlled sample timestamp could backdate
receipt/audit control-plane facts.

A post-remediation review found three remaining local race boundaries: the
live-log object attempted unsupported manual SQL transaction statements, a
lost response after durable revocation could skip non-durable socket cleanup on
an equal-generation retry, and stale file-spool recovery could unlink a fresh
contender's lock after reading an older pathname.

A further review found an R2/D1 boundary after the initial cleanup lease: a
pending archive could be marked cleaned after `HEAD` returned null while its
original R2 PUT was delayed, leaving late bytes without an accepting receipt or
cleanup owner. It also found that a stream had no durable bound on claimed
ticket rows, hibernatable sockets, or quiet socket lifetime.

The follow-up hardening review found that a finite upload watch was still not a
writer-termination proof: an R2 PUT can outlive any chosen grace period. It
also found that repeated failed uploads could consume one new generation per
retry while a fixed-size cron page prioritized cleaned rows over pending work.

## Task

Keep one exact machine payload durable until the authoritative receipt
acknowledges its exact contiguous log range. Fence every archive, queue event,
Durable Object, frame, and cursor to the authoritative deployment epoch.
Prevent stale live clients and stale cleanup workers from observing or deleting
new tenant data. Preserve complete v1 machine audit provenance.
Keep an in-flight immutable upload recoverable if its Worker loses ownership,
and bound every live-log nonce and socket without relying on later publication
traffic to wake the object.
Require an application cancellation boundary for every R2 upload and retain
its exact cleanup identity until the writer is provably settled. Bound failed
logical archive operations and ensure scheduled reconciliation services pending
work fairly during an R2 outage.

## Execution

The production agent writes the redacted log spool and a fully prepared
telemetry envelope in one file-locked transaction. It retries the byte-identical
envelope and removes entries only when the receipt names the authenticated
organization/node and exactly acknowledges the first and last pending sequence.
The ingress receipt adopts a matching organization/node payload identity after
credential or session renewal; it does not use a rotating credential as the
dedupe identity.

Migration 0037 makes the active deployment ID the immutable stream epoch.
The API resolves that ID from D1 instead of accepting it from the body. It
places epoch-qualified archive bytes under the organization/server path and
carries the same value through receipt metadata, Queue publication, Durable
Object name, ticket resource, WebSocket frame, and cursor. The web page and
CLI validate the canonical organization ID from the signed ticket/frame, not a
route slug. Server health is written only when a sampled labelled container
matches the authenticated node's exact running deployment.

Live tickets remain one-time and short-lived. The live object closes old
membership revisions and exposes revocation/suspension RPCs. A committed
membership revoke, leave, role change, or organization suspension outbox event
fans out to historical epoch rows and the current deployment, so no direct
socket call occurs inside the D1 mutation transaction.

Migration 0045 introduces an exact pending-archive cleanup lease. Cleanup
claims a pending identity in D1 before it heads or deletes R2. A receipt cannot
commit while a lease exists. A final receipt that commits first prevents the
claim and preserves the object. Migration 0046 adds an immutable retry
generation: when a cleanup lease has ever been claimed, a retry writes a new
archive ID and R2 key while retaining the old attempt as a tombstone. Thus a
worker stalled beyond its lease can delete only the generation it originally
claimed, never newly accepted bytes under the same logical log batch. This is a
bounded saga rather than a false cross-service transaction.

Migration 0055 initially proposed a finite upload lease and exact acceptance
fence for every new archive generation. That finite-expiry/`HEAD` design was
superseded before release by the amendment below; it remains in this record
only to explain the decision change, and is not current behavior or release
evidence.

### 2026-08-24 amendment: hard writer termination and bounded retry ledger

This amendment supersedes the preceding finite-watch portion of the 0055
description. The upload deadline now starts at the actual abortable R2 stream
boundary. The Worker passes the authenticated request signal to the adapter,
which supplies an erroring `ReadableStream` to R2 when either request
cancellation or the two-minute application deadline fires. Ingress also checks
the deadline after the R2 promise settles: a PUT whose completion arrives late
can never commit a receipt. If no bytes were consumed, the aborted stream
cannot produce an object; if R2 had already consumed bytes, the late object
remains an exact pending cleanup target and is never left untracked.

Time alone no longer clears an upload owner. A pending row stays
`upload_writer_state=unresolved` with its exact lease/key until the R2 promise
has settled. The success/receipt trigger or a failure path then records the
one-way `terminated` state. Cleanup can claim only an unclaimed intent or that
durably terminated writer; it cannot infer termination from a lease expiry,
`HEAD=null`, or scheduler time. A lost terminal D1 response is read back by
the exact row before cleanup proceeds.

The same unreleased migration makes the epoch reservation the bounded retry
ledger. It permits four immutable generations (zero through three), then marks
the logical operation quarantined. Terminal cleanup first records exponential
backoff (30 seconds, two minutes, ten minutes) or quarantine in that ledger,
then compacts the physical pending row only after exact R2 reconciliation. A
node has at most 32 unfinished reserved log operations, and the scheduler
orders pending work before cleaned compaction so a noisy R2 outage cannot starve
fresh recoverable work. A quarantined reservation is intentionally retained as
bounded operator-visible evidence rather than allocating another key.

Machine telemetry constructs an actual `machine` request context from the
Worker request. It records a semantically validated Cloudflare edge IP only
when Worker metadata proves the header came from the edge; Access evidence is
explicitly unavailable for bearer-machine traffic. Recursive NFKC-normalized
key redaction removes compound and camel-case secret-shaped values before log,
spool, audit, Queue, or R2 persistence.

Migration 0049 adds the authoritative pre-upload epoch reservation. The
reservation is keyed by organization, authenticated node, server, deployment
epoch, first/last sequence, and canonical log fingerprint. It is created before
the pending-upload row and before R2. A response lost after that D1 commit reads
back only the exact reservation; a changed or stale same-sequence body fails
before it can allocate cleanup work or object bytes. The terminal receipt turns
that exact reservation accepted in the same D1 transaction as the receipt,
archive, watermark, operation, staged envelope, compact audit row, and
publication intent.

The same migration replaces the legacy receipt constraint that equated
`accepted_at` with `health_sampled_at`. Health sample time remains immutable
machine evidence and is bounded to a 24-hour offline window with a five-minute
future allowance. Receipt, operation, audit event, staged envelope, and
adoption timestamps instead use the Worker acceptance clock.

Migration 0049 also materializes organization and membership live-log
authorization generations. The API reads those D1 facts into a ticket, and the
stream Durable Object accepts initialization only when the generation is not
older than its durable state. Equal or older active initialization cannot reopen
a revoked membership or suspended organization. A later regrant/reactivation
must carry a greater authority generation; organization deletion is terminal.
Committed outbox consumption reads those same tables before it synchronizes
every historical/current epoch object.

Live archive publication now uses the SQLite Durable Object
`storage.transactionSync` boundary for archive-id dedupe, event rows, sequence
watermark, and retention trimming; it never sends manual `BEGIN`, `COMMIT`, or
`ROLLBACK` SQL. Every outbound frame and ping response rechecks the socket's
signed organization/membership generations against the Durable Object's
durable authorization state. An exact repeated revoked, suspended, or deleted
authority fact replays ticket deletion and socket closure after an interrupted
first cleanup, while stale facts cannot evict a newer generation.

The live object stores no more than 64 ticket rows per stream and eight per
principal, with 32 hibernatable sockets per stream and four per principal. Each
accepted socket carries a durable last-activity attachment. A persisted alarm
derives the next ticket expiry or idle deadline, deletes nonce rows on close,
and closes/reclaims an inactive or no-longer-authorized socket even if no later
log publication arrives.

The agent file spool now serializes stale-lock recovery through an exclusive
recovery lease. It records the stale lock's owner token and kernel inode/device,
then revalidates both immediately before unlinking. A contender created during
that recovery observes the lease and relinquishes its own lock before entering
the spool critical section. This preserves the local-only, no-native-dependency
design while preventing an old stale reader from deleting a fresh process lock.

## Consequences

An old deployment can no longer share a log cursor or socket with its
replacement. An authenticated renewal can receive the original receipt only
for identical organization/node bytes. A conflicting or stale log range does
not create a pending upload or R2 object, even under concurrency. A cleanup
response loss can leave a bounded durable lease, but a delayed cleaner can
delete only its immutable tombstone generation and never an accepted retry.
An old ticket initializer cannot resurrect a revoked member or terminally
deleted organization. Live delivery stays best-effort; archive and health read
truth stay in D1/R2. The additional epoch, reservation, authorization,
adoption, generation, and cleanup records retain bounded operational evidence
and require scheduled reconciliation.

The original finite-watch consequence is superseded by the amendment below. A
deadline abort stops
future stream bytes, but no timer claims that a platform writer has ended. An
unresolved writer holds its exact key and one of the 32 bounded logical
operation slots. Once its R2 call settles, an exact terminal row permits either
receipt acceptance or R2 cleanup and bounded retry/quarantine compaction. This
trades automatic time-based deletion for a proof-based, tenant-fenced recovery
path and prevents both delayed-byte orphaning and unbounded retry-row growth.

The Durable Object now has a single supported atomic publication primitive and
does not rely on undocumented SQL transaction statements. A durable
authorization fence remains the admission and delivery boundary even when a
socket-close callback is lost; repeated authoritative revocation completes
best-effort cleanup without reopening access. File-spool recovery gains a small
sidecar lease and extra metadata checks, trading a short local retry delay for
ownership-safe stale-lock removal.

## Verification

Focused tests cover durable spool exact acknowledgement, nested canary
redaction, captured versus unavailable machine provenance, epoch-qualified
route/ticket/queue/DO behavior, canonical organization frame checks, server
health deployment validation, credential/session-renewal adoption, concurrent
and lost D1 response adoption, and cleanup lease races. The cleanup test proves
that a receipt committed before reconciliation prevents R2 deletion, a stale
owner cannot clean before its lease expires, and a cleaner resumed after expiry
cannot delete a newly accepted generation. The 0049 tests additionally prove
that a lost reservation response adopts only exact bytes, serial/concurrent
same-sequence conflicts leave one pending row and one R2 object, acceptance
timestamps do not equal an older sample, and a real Workers-runtime DO rejects
a delayed pre-revocation initializer while permitting only strictly newer
authority generations. A real Workers-runtime test additionally proves native
DO transaction publication, eviction/response-loss archive dedupe, and a
post-authorization-commit cleanup loss followed by exact retry; its real
WebSocket is closed by broadcast revalidation before a frame can send. A
cross-process file-spool race replaces an old lock between revalidation points
and proves the fresh token remains. Queue tests model a lost DO response and
prove retry produces one delivery. Focused API, agent, agent-telemetry,
migration, queue-consumer, realtime, log, generated-client, CLI, and web checks
are run locally before release handoff. No Cloudflare Worker, Queue, Durable
Object, R2 bucket, D1 database, Access policy, provider, or game server has
been deployed or changed.

The amendment replaces the finite-watch tests with deterministic stream and
ledger evidence: a PUT that begins reading only after its deadline receives an
aborted stream and writes no object even when the terminal D1 response is
lost; a PUT whose response is delayed after stream consumption cannot commit a
receipt and its exact object is retained until cleanup deletes it. Queue tests
prove an expired unresolved lease cannot be cleaned, terminal writers alone can
be compacted, 32 failed reservations are bounded, and pending R2-outage work is
scheduled before cleaned rows. Runtime tests drive four real ingress failures
through cleanup/backoff and prove the fifth attempt is quarantined with zero
physical pending rows. These are local tests only; no live Cloudflare resource
or provider evidence is claimed.

At this amendment, the focused local evidence passed migration tests (8 files,
31 tests), API tests including telemetry runtime (46 files, 251 tests), queue
consumer tests (10 files, 48 tests) and typecheck, log-R2 tests/typecheck (1
file, 7 tests), realtime tests/typecheck (3 files, 8 tests), agent-telemetry
tests/typecheck (2 files, 12 tests), agent tests/typecheck (11 files, 71
tests), and formatting of this ADR, Step 94, and the strict audit inventory.
The full API, Cloudflare integration, repository typecheck, and lint gates must
be rerun after concurrent backup-upload type work settles; its current failures
are outside this telemetry decision.

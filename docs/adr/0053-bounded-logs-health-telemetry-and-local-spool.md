# ADR 0053: Bounded logs, aggregate health, realtime delivery, and crash-safe local spool

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0002, ADR 0003, ADR 0013, ADR 0040, ADR 0041, ADR 0044, ADR 0050, ADR 0051, and ADR 0052

## Situation

Gridora needs organization-scoped game logs, live log delivery, server and node
health history, and bounded operational alerts. Log input can be large,
replayed, delayed, or secret-bearing. A response can be lost after a remote
write, so retry handling must prove whether the exact object already exists.

The control plane can be unavailable while a game server continues to run. The
agent therefore needs a local durable spool for observations and logs. The spool
must survive a process crash without exposing data through a symlink, weak file
permissions, or an unsafe concurrent update. None of these local or isolated
contracts may weaken organization, node, or server boundaries.

## Task

Implement bounded, tenant-bound log archive ingestion and retrieval with
redaction, retention, cursor pagination, time and byte limits, and response-loss
adoption. Persist aggregate health and bounded alert history in D1. Accept only
machine-observed fields from an exactly authenticated node and compose provider,
backup, and operation truth from control-plane facts. Add a one-time,
membership-rechecked realtime log stream and a crash-safe, ack-based agent spool.

## Execution

The log control and archive contracts validate organization, node, and server
scope before a write or read. They reject duplicate, missing, or out-of-order
sequence ranges, enforce monotonic per-node watermarks, use strict cursor and
time-range limits, and redact secret patterns before persistence. Public archive
metadata contains no R2 key or credential. D1 migration 0020 adds archive
catalog and watermark state, aggregate health history, bounded alerts, and
insert/update scope guards. The guards bind resource pairs to the authoritative
deployment and allow a server move only when the new deployment pair is the
current authoritative pair.

Archives use tenant-prefixed R2 keys and bounded gzip NDJSON. Retrieval performs
streaming decompression with a max-plus-one byte budget, bounded line and entry
parsing, and exact scope and digest checks. If the response is lost, a retry
adopts only the exact existing head and content; it never treats a different
object as success.

The realtime adapter issues a short-lived ticket for one organization and one
server. The live-log Durable Object rechecks audience, resource scope,
membership revision, expiry, and a single-use nonce in SQLite. It keeps a ring of
at most 512 events, 512 KiB, and ten minutes, and gives reconnecting clients at
most 128 events. Frames are limited to 64 KiB and buffered bytes to 256 KiB.
Backpressure closes a connection with 1013. Reconnect cursors report gaps or a
truncated backlog. Access and JWT headers are never forwarded to the stream.

Agent telemetry accepts only bounded machine observations, applies future-skew
limits, and redacts optional log batches before publication. The file-backed
spool is ack-based: it does not delete an item before acknowledgement. It
requires the exact expected UID, directory mode 0700, and artifact mode 0600.
Reads and syncs use opened descriptors and fstat checks, with O_NOFOLLOW-style
flags wherever Node provides them. Writes use an exclusive lock record with PID
and process start-time validation, then a temporary file, file fsync, atomic
rename, and directory fsync. Crash recovery validates current, previous, and
temporary artifacts and preserves bounded record, age, and disk limits. The
lockfile protocol is the portable fallback; without a native dependency Node
does not provide a portable advisory flock, so unknown lock-owner liveness fails
closed.

The implementation remains isolated from the central API index, shared API
contracts, generated client, CLI, web UI, and deployed Cloudflare bindings until
their owners compose and deploy those surfaces.

## Consequences

Logs and live streams are bounded, redacted, organization-scoped, and safe to
retry. Replay and response-loss evidence is explicit. Health storage remains an
aggregate rather than unlimited telemetry, and provider, backup, and operation
status cannot be forged by a node. A control-plane outage can be absorbed by a
bounded local spool, while clients must reconnect after retention or
backpressure limits.

The file spool depends on a private local filesystem and exact ownership and
mode checks. Its lockfile protocol is not a kernel advisory lock and cannot
claim protection from every external process without an OS-specific lock
helper. It therefore fails closed on unsafe ownership, permissions, symlinks,
or unknown lock-owner state. No deployed R2, D1, Durable Object, or production
filesystem evidence is implied by the local implementation.

## Verification

Local behavioral tests cover redaction canaries, cursor and tenant tampering,
R2 response-loss adoption and decompression limits, D1 sequence and watermark
replay/gap handling, health future and equal-time conflict handling, same-org
server moves, bounded alerts, realtime ticket replay and cross-tenant scope,
backpressure and reconnect gaps, and spool append/ack concurrency, crash
recovery, oversize and age limits, symlink resistance, exact UID and mode
checks, and redaction before storage.

The focused package checks and tests pass for the changed log, health, realtime,
API, and agent-telemetry modules. `pnpm typecheck` passes with no type errors,
and the focused file-spool lint passes. No deployed R2/D1/DO exercise,
production agent filesystem test, approved live reconnect test, or
control-plane outage run is recorded, so the implementation record remains
live-blocked.

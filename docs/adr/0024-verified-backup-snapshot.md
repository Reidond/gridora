# ADR 0024: Verified private backup snapshot and atomic cutover

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0010

## Situation

A restore cannot safely checksum, inspect, extract, and retain an archive by
reopening a mutable public path for every phase. A same-inventory archive swap can
otherwise change file contents after verification. Unbounded Zstandard expansion,
entry counts, or file sizes can exhaust a node before validation. Staging inside
the active server directory also cannot support an atomic directory swap.

## Task

The node agent must create deterministic local backups and restore only the exact
archive bytes covered by the signed checksum. It must reject unsafe paths and
entry types before extraction, bound resource use from the signed server disk
policy, and preserve or recover the active server directory across interruption.

## Execution

The agent writes deterministic USTAR with normalized ownership, modes, timestamps,
and sorted entries, then compresses it with Node's Zstandard implementation. It
does not invoke a shell or accept archive command arguments.

Restore opens the received archive with no-follow semantics once, copies and hashes
that inode into an agent-private file, and uses only that verified snapshot for
inventory, extraction, and the retained archive. The signed disk byte limit bounds
compressed bytes, expanded bytes, entry count, per-entry bytes, and aggregate file
bytes during streaming.

Only regular files and directories with canonical relative paths are accepted.
Extraction uses exclusive no-follow file creation in a fresh sibling staging
directory. Cutover renames the active directory to an operation-specific rollback
directory and renames staging into place. A persisted completion marker and the
rollback directory make retry after process or host interruption deterministic.

## Consequences

Archive output is reproducible for unchanged input, and restore cannot observe
different bytes between checksum and extraction. Restore needs temporary space for
the verified compressed snapshot, expanded archive, staging tree, and short-lived
rollback tree. Unsupported or over-policy archives fail before cutover.

The local adapter does not upload to R2, download from R2, encrypt backup content,
or deliver encryption credentials. Those remain control-plane and transport work
under ADR 0010. This decision must not be used as evidence that off-node backup
durability is complete.

## Verification

Behavioral tests cover deterministic roundtrip, corruption, traversal, absolute
paths, symlinks, hardlinks, devices, missing staging, interrupted cutover retry,
same-inventory content swapping, compressed and expanded size limits, entry-count
limits, per-entry limits, and aggregate limits.

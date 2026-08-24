# ADR 0030: Authenticated chunked R2 backups and wrapped backup keys

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0010, ADR 0024, and ADR 0028

## Situation

ADR 0024 protects the local archive bytes during restore. It does not provide
encrypted off-node storage. A single unbounded encryption operation is not safe
for large game data. A retry after an uncertain R2 response must not replace a
different backup object.

## Task

Gridora must encrypt a bounded stream, keep every R2 key inside one organization,
detect changed or reordered chunks, and adopt an existing object only when it is
the exact object from the same backup operation. The data key must not be stored in
plaintext in D1 or R2.

## Execution

Each backup receives a fresh 32-byte data key. The control plane wraps that key
with the versioned key-encryption adapter. Authenticated data binds the wrapped
key to the organization, server, backup, and key version. An atomic repository
creates or adopts one wrapped key for one backup ID. A concurrent request or a
lost response can return only the exact recorded key.

The R2 adapter converts the bounded producer stream into fixed-size encryption
chunks. Producer stream boundaries do not change the encrypted chunk layout. The
adapter encrypts each chunk with AES-256-GCM. It derives a unique nonce from the
backup scope, fixed chunk size, chunk index, and plaintext chunk checksum.
Authenticated data contains the same values. A changed chunk cannot reuse a nonce
for different plaintext. The manifest nonce also contains the checksum of the
complete manifest core. Object keys begin with
`organizations/{organization}/servers/{server}/backups/{backup}/`.

Gridora writes chunks through the Workers R2 binding with an
`If-None-Match: *` only-if-absent condition. A failed precondition returns no
new object and enters the same exact-adoption path as an uncertain response. An
uncertain write is adopted only after the stored bytes and owned checksum
metadata match exactly.
Gridora writes the authenticated manifest last. The manifest contains the ordered
chunk checksums, aggregate checksum, sizes, and encryption version. Restore does
not use a backup until the manifest and every chunk pass their bounds and
authentication checks.

The process clears plaintext data-key buffers after use. Errors do not contain
keys, plaintext, or provider response bodies.

## Consequences

R2 can store large encrypted backups without one large in-memory ciphertext.
Cross-organization key substitution, chunk reordering, truncation, and changed
retry objects fail authentication. Manifest-last publication gives readers one
clear completeness marker.

The production boundary includes a structural Workers R2 adapter and an Effect
D1 repository. Migration 0010 stores one immutable wrapped key for the exact
organization, server, and canonical backup. The schema rejects a key when the
backup belongs to another server. It also rejects update and delete operations.
The API composition uses the dedicated `BACKUPS` R2 binding and the same
versioned Secrets Store KEK layer as encrypted provider credentials.

These adapters are not proof that a Workflow and node agent stream an archive
through a configured Secrets Store binding and live R2 bucket.

## Verification

Tests must cover multi-chunk round trips, the same retry bytes with different
producer boundaries, changed authenticated chunk input, tampering, truncation,
reordering, cross-organization substitution, size limits, only-if-absent retry
adoption, concurrent key issuance, lost key-service response, wrong authenticated
data, old key versions, D1 result failures, backup/server scope substitution,
immutable key records, Workers R2 conditional mapping, and buffer cleanup. A live
release test must back up on one node and restore on another before off-node
durability is marked live.

The local Workers-runtime test must compose the production adapters with actual
workerd D1 and R2 bindings. It must upload more than one encrypted chunk, restore
the original bytes, inspect the immutable wrapped-key row, and deny a foreign
organization without exposing the stored object.

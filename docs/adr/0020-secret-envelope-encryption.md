# ADR 0020: Secret envelope encryption

- Status: Accepted
- Date: 2026-08-23

## Context

Provider, Steam, RCON, and machine credentials must not be plaintext in D1. A key
rotation must support one record at a time and must fence concurrent changes.

## Decision

Gridora creates one random AES-256-GCM data key for each secret. Authenticated data
binds the ciphertext to its organization, scope, and record ID. A key service wraps
the data key and records the key version. D1 stores ciphertext and wrapped keys only.
Decrypt, rotate, and delete operations require the exact organization scope.

Rotation opens the current record, generates a new data key, encrypts the plaintext
again, wraps the new data key with the active key-encryption key, and replaces the
record under an expected revision. The implementation does not claim a metadata-only
rewrap operation.

The in-memory key service is for tests only. Production uses the versioned
Cloudflare Secrets Store adapter from ADR 0028 or an equivalent external KMS
boundary.

## Consequences

A D1 export does not contain plaintext secrets. Rotation changes the ciphertext,
wrapped data key, key version, and revision for one record. The control plane must
keep the recorded old key versions available until every record that uses them has
rotated.

## Alternatives

We rejected plaintext D1 columns. We rejected one static application encryption key
without key versions. We rejected logging secret values during provider failures.

## Verification

Test wrong-organization denial, ciphertext changes, tampering, key rotation,
revision conflicts, and secret canaries in logs and errors.

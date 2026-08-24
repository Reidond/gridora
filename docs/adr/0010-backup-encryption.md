# ADR 0010: Backup encryption and key rotation

- Status: Accepted
- Date: 2026-08-23

## Context

Backups can contain private game data and secrets. R2 compromise must not expose them.

## Decision

Each backup uses a random data-encryption key and authenticated encryption. The
DEK is wrapped by an environment key; metadata includes algorithm, key version,
organization, server, and integrity digest. Plaintext keys and game secrets never
enter R2 metadata or logs.

## Consequences

Rotation re-wraps DEKs without downloading backup plaintext. Restore authorizes
the organization before unwrap and records an audit event. Retired keys remain
available until every retained backup is rewrapped or expires.

## Alternatives

We rejected one static backup key. It has a large blast radius. We rejected
server-side encryption alone. It shares the storage trust boundary.

## Verification

Restore with the correct organization key. Reject changed ciphertext and metadata.

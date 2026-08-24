# `@gridora/backup-r2`

R2 transport for encrypted Gridora server-state backups. A manifest-last commit makes partial
uploads invisible, independently authenticated chunks keep memory bounded, and all object keys are
derived from the organization context rather than caller-provided R2 paths.

The upload producer must emit chunks no larger than `maximumChunkBytes` (64 KiB to 4 MiB). The
transport rejects an oversized producer chunk. It then creates deterministic fixed-size encryption
chunks independent of the producer's stream boundaries. A retry with the same bytes therefore
reuses a nonce only for the same authenticated plaintext. Agent integration must use a bounded
`ReadableStream` source.

This package does not redistribute game installation binaries. Its manifest accepts only Gridora
state categories and records `game` as excluded.

The in-memory R2 and local wrapping-key implementations exist only in tests. Production integration
still requires a real Cloudflare R2 binding and a `BackupDataKeyPort` backed by Cloudflare KMS or
Secrets Store with idempotent per-backup key issuance and retained historical key versions.

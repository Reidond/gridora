# `@gridora/backup-key`

Production-shaped key issuance for `@gridora/backup-r2`. It generates a unique 256-bit data key,
wraps it through the existing secret-envelope KEK port, and adopts the atomically persisted wrapped
record on concurrent or lost-response retries.

This package intentionally contains no SQL. Production still requires an implementation of
`BackupKeyRepositoryPort` in `packages/db-d1` plus a migration, Worker composition with a live
Cloudflare KMS or Secrets Store `KekPort`, and lifecycle policy for retaining old KEK versions.

Returned plaintext buffers are caller-owned and must be zeroed after importing a non-extractable
cryptographic key. All non-returned temporary plaintext buffers are zeroed by this package.

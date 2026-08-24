# `@gridora/backup-key-d1`

Effect v4 D1 repository for immutable, organization-scoped wrapped backup data keys.

The repository inserts or adopts one exact record for the composite organization,
server, and backup identity. It never stores plaintext key material. Migration 0010
fences the key to the canonical backup and game server and rejects updates or deletes.

This adapter is a local production boundary. A live release still requires the backup
Workflow and agent stream to exercise D1, Secrets Store, and R2 together.

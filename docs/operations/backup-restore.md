# Backup and restore runbook

## Backup

1. Authorize the organization and server.
2. Ask the plugin for a consistent backup plan.
3. Create a random data-encryption key.
4. stop writes or create a consistent snapshot.
5. Encrypt the archive before upload.
6. Wrap the data-encryption key with the active environment key.
7. Store the object under `org/<organization-id>/server/<server-id>/backup/`.
8. Store the checksum, plugin version, and key version.
9. Verify the uploaded object.

## Restore

1. Authorize the target organization.
2. Keep the source server unchanged.
3. Verify the archive signature and checksum.
4. Unwrap the key inside the secret boundary.
5. Restore into a new server directory.
6. Run plugin validation and health checks.
7. Change the endpoint only after health passes.
8. Retain the source until the cutover policy expires.

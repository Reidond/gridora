# ADR 0077: Recover backup work with generation-fenced physical evidence

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0024, ADR 0051, ADR 0068, and ADR 0069

## Situation

A Worker can disappear after an R2 chunk, manifest, restore cutover, or delete
is committed but before D1 observes the response. Retention and organization
deletion can also race an upload. Retrying from mutable catalog state can leak
objects, delete the wrong generation, or claim completion without physical
evidence.

## Task

Make create, restore, retention deletion, abandoned-upload cleanup, and
organization deletion recoverable after Worker loss. Bind every physical
effect to the exact organization, server, backup, generation, operation, and
immutable acceptance provenance.

## Execution

The backup saga records operation-scoped physical effects and adopts exact
committed results. Upload generations have leases and immutable chunk/manifest
coordinates. A superseded or abandoned generation is cleaned only by its own
bounded claim. Retention keeps catalog evidence until the exact R2 objects are
confirmed absent. Restore preserves the source until verified cutover and has
an explicit rollback phase.

Organization deletion waits for the child backup deletion receipt and game DNS
cleanup receipt before it resolves its inventory item. Scheduling uses an
organization automation identity, deterministic slot identity, and the same
accept-or-adopt boundary. A terminal operation and version 1 envelope are
written only after physical completion evidence.

## Consequences

An isolate restart or lost response does not allocate a new upload generation,
repeat a destructive action, or erase catalog provenance. Cleanup remains
bounded and tenant-scoped. Live R2 and provider behavior still requires a
deployed environment and explicit production evidence.

## Verification

Backup D1/R2, upload route, Workflow, retention, abandoned-generation,
organization-deletion, migration, and Cloudflare integration tests inject
response loss and verify exact adoption, source preservation, bounded cleanup,
and terminal audit evidence. The checks use local D1/R2 doubles or Miniflare;
they make no live mutation.

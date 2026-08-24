# ADR 0101: Scope package inventory to the guest root

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0099

## Situation

Owner-approved exact-main run 32774531888 built the Ubuntu QCOW2 and passed
`qemu-img` validation. The stage-specific evidence lane then reported two paths
that ended in `var/lib/dpkg/status`. One path is the Node image package database.
The other path is inside a retained Docker filesystem layer. The prior suffix
match treated both paths as authoritative host package inventories.

No SBOM, signature, artifact upload, or provider smoke was accepted from the
failed run.

## Task

Count packages installed in the Node root filesystem without counting package
databases that belong to nested container layers.

## Execution

Accept only `var/lib/dpkg/status` or `./var/lib/dpkg/status` at the archive root.
Reject a missing or duplicate root-level package database. Ignore nested paths
that only share the same suffix. Continue to stream only the selected root-level
file and require a non-zero package count.

Add a regression archive that contains both the authoritative root package
database and a nested Docker-layer package database. Require the evidence count
to include only the two root packages.

## Consequences

The inventory describes the produced Node image instead of a bundled container
image. A nested layer cannot inflate or replace the host package count. The
complete rootfs archive remains the input to SBOM generation, vulnerability
scanning, checksums, signature verification, and promotion.

Run 32774531888 remains diagnostic evidence only. It produced no accepted
artifact or provider smoke result.

## Verification

Require Bash parsing, ShellCheck, focused artifact and documentation tests, the
complete repository gate, pull-request CI and Security, and a replacement
owner-approved exact-main image run. Release evidence still requires successful
artifact upload and separately approved simulated-provider smoke.

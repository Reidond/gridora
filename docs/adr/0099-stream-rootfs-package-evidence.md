# ADR 0099: Stream package evidence from the guest archive

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0098

## Situation

Owner-approved exact-main run 32769230700 passed the libguestfs appliance
preflight, built and validated the real Ubuntu QCOW2, and exported its root
filesystem archive. The evidence script then attempted to unpack that entire
archive as the unprivileged GitHub runner account.

A valid Linux root filesystem contains device nodes such as `/dev/null`,
`/dev/console`, and Docker's `backingFsBlockDev`. Recreating those entries
requires `mknod`, so the unprivileged extraction failed. The failure occurred
before SBOM generation or signing; no artifact was accepted and provider smoke
was correctly skipped.

## Task

Read the package inventory needed for evidence without recreating privileged
guest filesystem objects or weakening the requirement to scan and checksum the
complete exported rootfs archive.

## Execution

Retain the complete read-only libguestfs archive as the immutable SBOM,
vulnerability-scan, and checksum input. Validate every archive path as before,
require exactly one `var/lib/dpkg/status` member, and stream only that member to
a mode-0600 temporary file for package counting.

Do not extract the archive into a host directory. Add a behavioral fixture that
contains the host's real `/dev/null` device entry so an attempted full
unprivileged extraction regresses the test.

## Consequences

Evidence collection no longer requires `CAP_MKNOD`, root, or a privileged
container. Duplicate or missing package databases fail closed. The full rootfs
archive, including its special-file metadata, remains the exact artifact bound
to SBOM, scan, checksum, signature, and promotion evidence.

Run 32769230700 remains diagnostic evidence only. Its image was not signed or
uploaded, and its provider smoke lane did not run.

## Verification

Require Bash parsing, ShellCheck, focused artifact/image/documentation tests,
the complete repository gate, pull-request CI and Security, and a new
owner-approved exact-main image run. Release evidence still requires successful
rootfs extraction, SBOM and vulnerability checks, signature verification,
artifact upload, and the separately protected simulated provider smoke.

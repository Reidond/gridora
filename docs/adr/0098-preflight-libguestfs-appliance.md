# ADR 0098: Preflight the read-only libguestfs appliance

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0097

## Situation

Owner-approved exact-main run 32766678178 completed the real Ubuntu QCOW2
build and passed `qemu-img` validation. The subsequent supply-chain evidence
step failed before extraction because the unprivileged hosted-runner process
could not build the libguestfs supermin appliance from the host kernel.

The workflow installed `libguestfs-tools` and the running kernel's extra
modules, but Ubuntu kept `/boot/vmlinuz-$(uname -r)` unreadable to the runner
account. This host-only permission prevented read-only rootfs extraction after
the expensive image build. It did not indicate a guest provisioning defect,
and no unsigned artifact was uploaded or accepted.

## Task

Make the ephemeral signing runner's read-only extraction appliance available
before building the image, without weakening the produced image or bypassing
rootfs inspection.

## Execution

Select libguestfs' direct backend explicitly for the protected build job. After
the pinned host tooling is installed, make only the running host kernel image
world-readable on the disposable runner, prove it is readable, and run
`libguestfs-test-tool` before Packer starts.

Keep extraction, SBOM generation, vulnerability scanning, checksums, signing,
verification, and artifact upload fail-closed and unchanged.

## Consequences

An unusable host extraction appliance now fails in the short preflight instead
of after the QCOW2 build. The permission change affects only the ephemeral
GitHub runner's already installed kernel image; it does not modify the Gridora
guest artifact. A successful build still requires extraction and inspection of
the exact QCOW2 root filesystem before signing or upload.

Run 32766678178 remains diagnostic evidence only. Its QCOW2 was neither signed
nor uploaded, and its provider smoke lane was correctly skipped.

## Verification

Require workflow parsing, ShellCheck, focused image and documentation tests,
Packer formatting and validation, the complete repository gate, pull-request
CI and Security, and a new owner-approved exact-main image run. Release evidence
still requires rootfs extraction, SBOM and vulnerability checks, signature
verification, artifact upload, and the separately protected simulated provider
smoke.

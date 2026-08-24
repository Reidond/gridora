# ADR 0093: Create the Packer directory-upload destination explicitly

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0092

## Situation

Protected exact-main image run 32750636584 proved the explicit GRUB boot repair:
the pinned Ubuntu installer started, consumed autoinstall, installed the guest,
and accepted Packer's ephemeral SSH key. Packer connected over SSH after about
six minutes instead of reaching the former 30-minute timeout.

The first provisioner then failed with `scp: /tmp/gridora-image: Not a
directory`. Its source path ends in a slash, so Packer uploads the source
directory's contents and requires the destination directory to exist. Template
validation cannot prove that runtime guest filesystem precondition.

## Task

Create the one private temporary destination before the existing asset upload,
without changing the asset source, guest privileges, image identity, or any
later inspection and signing gate.

## Execution

Run an initial SSH shell provisioner as the unprivileged build user. Create
`/tmp/gridora-image` with mode `0700` using `install -d`. Keep the subsequent
file provisioner source ending in `/` and its destination unchanged so it
copies only the reviewed directory contents into that exact path.

Do not use a world-writable staging directory, sudo, a password, a host mount,
or a Docker socket. Do not treat successful SSH as a complete image build.

## Consequences

The file provisioner's destination type is deterministic before SCP starts.
Only the ephemeral build user can read the staged image assets until the
existing root provisioning script installs them with their reviewed owners and
modes.

The protected run still must complete every remaining provisioner, remove the
ephemeral SSH key, shut down, inspect the offline guest, generate and scan its
SBOM, sign the evidence, upload the artifact, and pass the separately approved
simulated provider smoke.

## Verification

Require the image-asset test to find the mode-0700 destination creation before
the file upload. Require pinned Packer formatting and validation, focused image
and documentation tests, the complete repository gate, pull-request CI and
Security, and a new owner-approved exact-main protected image run. The failed
run remains diagnostic evidence only.

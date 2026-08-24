# ADR 0095: Create the journald drop-in directory explicitly

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0094

## Situation

Protected exact-main image run 32756319958 proved that the ephemeral Packer
sudo grant works: Ubuntu autoinstall completed, SSH connected, every reviewed
input uploaded, Docker and the required packages installed, and all pinned
artifact checksums passed. The provisioner then exited inside the previously
unexercised immutable-configuration span.

An amd64 Ubuntu 24.04 reproduction proved the Node runtime, system identities,
signed agent-update manifest, signature, policy, and root-owned baseline state.
A second minimal Ubuntu reproduction exposed the missing filesystem
precondition: `/etc/systemd/journald.conf.d` is not guaranteed to exist, while
the provisioner installs `60-gridora.conf` into that directory.

## Task

Make installation of the reviewed journald policy deterministic on the minimal
Ubuntu image without weakening the policy or depending on package-created
optional directories.

## Execution

Create `/etc/systemd/journald.conf.d` with root ownership and mode `0755` in the
existing root directory-creation step before any immutable configuration is
installed. Continue to install `60-gridora.conf` with mode `0644` at its fixed
path.

## Consequences

The image build no longer depends on incidental host-image directory layout.
The journald policy remains a root-owned static drop-in, and a regression test
requires the directory creation to precede the policy installation.

This decision does not claim a completed image. A new protected exact-main
Packer build must still pass provisioning, offline inspection, scanning,
signing, artifact upload, and separately approved simulated provider smoke.

## Verification

Require the focused image and documentation tests, Packer validation, the full
repository gate, pull-request CI and Security, and a new owner-approved
exact-main image run. Accept only the new run's signed artifact and smoke
evidence; failed run 32756319958 is diagnostic evidence only.

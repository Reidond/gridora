# ADR 0094: Use and remove an ephemeral Packer sudo grant

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0092 and ADR 0093

## Situation

Protected exact-main image run 32753572704 completed Ubuntu autoinstall,
connected with the ephemeral SSH key, created the private upload directory, and
uploaded every reviewed input. The root provisioning script then stopped at its
first `sudo` command because the autoinstall build account has a locked password
and no noninteractive elevation rule.

The provisioner must install packages, system users, root-owned files, systemd
units, firewall policy, and image identity. Running the whole SSH communicator
as root would expand the remote-login boundary. Giving the build account a
permanent sudo grant would leave an avoidable privilege path in every image.

## Task

Permit only the ephemeral image-build account to elevate noninteractively while
Packer provisions the guest, validate that grant before first SSH, and remove it
with the ephemeral SSH key before shutdown.

## Execution

During autoinstall late commands, create `/etc/sudoers.d/90-gridora-packer` in
the target with mode `0440`, grant the `gridora` build account passwordless sudo,
and require `visudo -cf` to accept the file. Continue to authenticate Packer with
its one-run Ed25519 key rather than a password or root login.

Use one final `sudo sh -c` shutdown process. Inside that already elevated
process, remove both the build account's `authorized_keys` file and the temporary
sudoers file, then power off. A second sudo invocation after removing the grant
would be invalid and is therefore prohibited.

## Consequences

Provisioning receives the root boundary it already declares through explicit
`sudo` calls, while remote SSH remains a non-root key-authenticated session.
The completed image contains neither the build key nor its temporary elevation
rule. Offline image inspection remains responsible for proving both absences.

The workflow must still fail if autoinstall cannot create or validate the rule,
if any provisioning command fails, if shutdown cannot remove both credentials,
or if offline inspection, scanning, signing, upload, or simulated smoke fails.

## Verification

Require the image-asset contract to find the named grant, mode `0440`, `visudo`
validation, and one root shutdown command which removes both ephemeral access
paths before poweroff. Require pinned Packer formatting and validation, focused
image and documentation tests, the complete repository gate, pull-request CI
and Security, and a new owner-approved exact-main protected image run. Do not
accept failed runs as release evidence.

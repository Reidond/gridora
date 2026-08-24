# ADR 0092: Boot Ubuntu autoinstall without GRUB menu-position assumptions

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0084 and ADR 0091

## Situation

Protected exact-main image run 32745356422 passed validation, owner approval,
kernel firewall enforcement, project-quota enforcement, and all pinned input
checks. Its QEMU guest then failed after 30 minutes with `Timeout waiting for
SSH`. The log showed that Packer typed a command which moved down three GRUB
editor lines before appending the autoinstall arguments. It showed no completed
installer or reachable build account.

The number and order of editable GRUB lines are presentation details of the
pinned Ubuntu installer ISO. They are not a stable interface for selecting the
kernel command line. Increasing the SSH timeout cannot repair a guest that was
booted without the intended autoinstall datasource.

## Task

Boot the pinned Ubuntu installer through explicit GRUB commands, require DHCP
before the network datasource is read, and keep every existing image identity,
provisioning, inspection, signing, and simulated-provider gate unchanged.

## Execution

Enter the GRUB command console with `c`. Load `/casper/vmlinuz` with the
`autoinstall` and `ip=dhcp` arguments. Pass the Packer HTTP endpoint as one
quoted `nocloud-net` datasource value so GRUB does not interpret its semicolon
as a command separator. Load `/casper/initrd`, then boot.

Do not navigate by a count of menu lines, mutate the pinned ISO, enable password
login, expose SSH publicly, or weaken the 30-minute failure bound. Keep the
ephemeral key in the generated autoinstall document and remove it before image
shutdown as already required.

## Consequences

The boot contract now names the kernel, initrd, network requirement, and seed
URL directly. A future installer that removes those reviewed `/casper` paths
will fail explicitly instead of silently appending arguments to the wrong menu
line.

This repair still requires a new pull request and exact-main protected build.
It does not convert the failed run into image evidence, and it creates no
provider resource, production mutation, release tag, or proprietary game
installation.

## Verification

Require the image-asset test to find the explicit GRUB console, kernel, DHCP,
quoted datasource, initrd, and boot commands and to reject the old line-position
sequence. Require Packer formatting and validation, focused image and
documentation tests, the complete repository gate, pull-request CI and
Security, and a new owner-approved exact-main image run. Only a successful
artifact build may advance to the separately approved simulated provider smoke.

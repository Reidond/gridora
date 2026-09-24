# BUG: Node image build fails the pending-upgrade gate on Ubuntu phased updates

- Status: fixed-pending-image-run
- Found: 2026-09-24, protected image run 36030351131 (exact main, `build_local_image=true`)
- Owner: unassigned
- Spec: `.specs/image-phased-updates/spec.md`

## Symptom

`build-local` fails in "Build the local QCOW2 image" after 22 minutes with `image provisioning left pending package upgrades`. No artifact is produced. `provider-image-smoke` is skipped.

## Cause

`infra/packer/scripts/provision.sh` runs `apt-get dist-upgrade -y`, which honours Ubuntu phased updates and deferred five packages: `apparmor dmidecode libapparmor1 libaudit-common libaudit1` ("The following upgrades have been deferred due to phasing"). The Step 128 gate then runs `apt-get --simulate dist-upgrade` and finds `Inst` lines for those same packages, so it exits 1. The gate is correct; the upgrade step is incomplete.

## Fix

Include phased updates during image provisioning (see the spec). A promoted image must carry every published fix, not a phased subset chosen by machine-id hash.

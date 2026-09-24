# BUG: Node image build fails the pending-upgrade gate on Docker package drift

- Status: fixed-pending-image-run
- Found: 2026-09-24, protected image run 36040577564 (exact main `fbfdbd9`, `build_local_image=true`)
- Owner: unassigned
- Spec: `.specs/image-docker-pin-refresh/spec.md`

## Symptom

`build-local` fails in "Build the local QCOW2 image" after 8 minutes 39 seconds with
`image provisioning left pending package upgrades`. The Step 131 diagnostic lists five
pending installs, all from `Docker CE:noble`:

```
docker-ce-cli        5:29.7.2 -> 5:29.8.1
containerd.io        2.3.3    -> 2.3.5
docker-ce            5:29.7.2 -> 5:29.8.1
docker-buildx-plugin 0.36.1   -> 0.37.1
docker-compose-plugin 5.5.0   -> 5.5.1
```

Ubuntu's own packages report `0 not upgraded`, so the Step 131 phased-updates fix works.

## Cause

Step 128 (ADR 0103) pins exact Docker package versions in
`infra/packer/scripts/provision.sh` and `infra/scripts/validate-rootfs-package-policy.sh`
and also requires that `apt-get --simulate dist-upgrade` prints no `Inst` line. Docker
published newer packages to its `noble/stable` suite after 2026-08-25, so the exact pins
are now behind the repository and the gate refuses the image. Both rules are correct;
the pins must move.

## Fix

Bump the pins to the current signed Docker packages and fail the cheap `validate` job
early when the pins drift again, so the next drift costs seconds, not a protected build.

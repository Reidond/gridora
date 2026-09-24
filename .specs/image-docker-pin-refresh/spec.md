# Spec: Refresh the Docker package pins and detect pin drift before the image build

- Size: Small (two scripts, two tests, one workflow step, ADR amendment note, STE step)
- Runnable now: yes
- STE step to add: Step 138 (main ends at 137; renumber if taken on rebase)
- ADR: cite ADR 0103. No new ADR.
- Branch: `spec/image-docker-pin-refresh`

## Problem

See `tasks/BUG-image-docker-pin-drift.md`.

## Requirements

- R1. Set the Docker pins in `infra/packer/scripts/provision.sh` and
  `infra/scripts/validate-rootfs-package-policy.sh` to the current `noble/stable`
  versions, read from `https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages`
  at implementation time (on 2026-09-24 they were docker-ce and docker-ce-cli
  `5:29.8.1-1~ubuntu.24.04~noble`, containerd.io `2.3.5-1~ubuntu.24.04~noble`,
  docker-buildx-plugin `0.37.1-1~ubuntu.24.04~noble`, docker-compose-plugin
  `5.5.1-1~ubuntu.24.04~noble`). Keep the two files identical in their pin block.
- R2. Update `tests/image/image-assets.test.ts` and
  `tests/infrastructure/image-artifact-evidence.test.ts` to the same versions. Keep the
  test that requires the two scripts to agree, or add one if it does not exist.
- R3. Add a step to the `validate` job of `.github/workflows/image.yml` (it runs on every
  pull request) that downloads the Docker `Packages` index over HTTPS, extracts the
  newest version of each of the five packages, and fails with a clear message when any
  pin in `provision.sh` is behind. Put the logic in `infra/scripts/check-docker-pins.sh`
  so it can run locally, and cover it with a test that feeds a fake index. This makes
  the next drift fail in seconds on a pull request instead of eight minutes into a
  protected build.
- R4. The Docker Engine API compatibility check in `provision.sh` (`>= 1.43`) and the nine
  Docker-owned binary paths that the SBOM step filters stay unchanged unless the new
  packages move a binary; verify the paths against the package file lists
  (`dpkg -L` output in a clean `ubuntu:24.04` container with the Docker repository
  configured, if Docker is available locally; otherwise state that this was not verified).
- R5. Add one sentence to ADR 0103 under Consequences noting that exact pins must track
  the Docker repository and that the `validate` job now checks this. Keep the ADR
  Accepted; do not rewrite it.

## Out of scope

- Re-dispatching the protected image workflow (only runs on `main` after merge).
- Any change to the Grype gate, Traefik, cloudflared, snapd, or phased-updates handling.

## Test requirements

- `bash -n` and the pinned ShellCheck on changed scripts; the existing image asset and
  artifact evidence tests; the new pin-check test with a fake index.
- `pnpm check`, `pnpm test`, `pnpm build` pass.

## Deliverables

PR against `main` with the pin bump, drift check, ADR note, STE step, the bug task at
`tasks/BUG-image-docker-pin-drift.md` with `Status: fixed-pending-image-run`, and this
spec at `.specs/image-docker-pin-refresh/spec.md`.

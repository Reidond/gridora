# Spec: Include Ubuntu phased updates in node image provisioning

- Size: Small (one script, one test, ADR amendment note, STE step)
- Runnable now: yes
- STE step to add: next free number after main (131 if main still ends at 130)
- ADR: cite ADR 0103. No new ADR.
- Branch: `spec/image-phased-updates`

## Problem

See `tasks/BUG-image-phased-updates.md`. Ubuntu phases some stable updates by machine-id hash. `apt-get dist-upgrade` in `infra/packer/scripts/provision.sh` deferred `apparmor dmidecode libapparmor1 libaudit-common libaudit1`; the Step 128 gate (`apt-get --simulate dist-upgrade` must print no `Inst` line) then failed the build in protected run 36030351131.

## Requirements

- R1. Provisioning installs phased updates: write `/etc/apt/apt.conf.d/90gridora-phased-updates` containing `APT::Get::Always-Include-Phased-Updates "true";` before the first `apt-get update`, so every `apt-get` call in the script (upgrade, install, purge, and the simulate gate) sees the same policy. Keep the file in the image so the node's later unattended upgrades are not phased either; state this in the STE step and add one sentence to `docs/adr/0103-*.md` under Consequences (this is an amendment note, not a rewrite; keep the ADR accepted).
- R2. The pending-upgrade gate prints the pending package lines to stderr before exiting 1, so the next failure is diagnosable from the log without a rerun.
- R3. The rootfs package policy (`infra/scripts/validate-rootfs-package-policy.sh`) or its test asserts that the drop-in file exists in the extracted rootfs with the exact content, so a future edit cannot silently drop it.
- R4. Bash syntax and ShellCheck pass for the changed scripts; the existing image asset tests under `tests/infrastructure` and `tests/image` pass.

## Out of scope

- Re-dispatching the protected image workflow (only runs on `main` after merge).
- Any change to the Grype gate, Traefik, cloudflared, or snapd handling.

## Test requirements

- A unit test for R3 (extend the existing rootfs policy tests).
- `bash -n`, `shellcheck` at the repo's pinned version, `pnpm check`, `pnpm test`, `pnpm build` pass.

## Deliverables

PR against `main` with the script change, ADR note, STE step, the bug task file moved to `Status: fixed-pending-image-run`, and this spec copied to `.specs/image-phased-updates/spec.md`.

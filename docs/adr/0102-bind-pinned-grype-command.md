# ADR 0102: Bind the pinned Grype command explicitly

- Status: Accepted
- Date: 2026-08-25
- Extends: ADR 0100

## Situation

Owner-approved exact-main run 32777016896 built and validated the Ubuntu QCOW2.
It passed rootfs extraction and SBOM generation. The named vulnerability-scan
stage then failed because `anchore/scan-action/download-grype` installed pinned
Grype 0.110.0 in the hosted tool cache but did not add that directory to the
later shell step's `PATH`.

The action declares `cmd` as the absolute path to its downloaded executable.
The workflow did not consume that output. No signature, artifact upload, or
provider smoke was accepted from the failed run.

## Task

Run the exact scanner that the pinned download action resolved without relying
on an undocumented `PATH` side effect.

## Execution

Give the pinned download step a fixed identifier. Pass its declared `cmd`
output as the scanner command to `scan-artifact.sh`. Keep `grype` as the local
default when the optional command argument is absent. Require the selected
command to exist before scanning.

Preserve the canonical rootfs archive input, `high` fail threshold, and
`only-fixed` policy.

## Consequences

The protected job runs the downloaded pinned Grype binary by its resolved
absolute path. A missing or invalid action output fails closed. Local operators
can continue to run the script with a `grype` binary on `PATH`.

Run 32777016896 remains diagnostic evidence only. It produced no accepted
artifact or provider smoke result.

## Verification

Require workflow parsing, Bash parsing, ShellCheck, a workflow contract for the
download output, focused image and documentation tests, the complete repository
gate, pull-request CI and Security, and a replacement owner-approved exact-main
image run. Release evidence still requires signature, upload, and separately
approved simulated-provider smoke.

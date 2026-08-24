# ADR 0100: Make image evidence failures stage-specific

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0099

## Situation

Owner-approved exact-main run 32771824710 built and validated the Ubuntu QCOW2
and entered supply-chain evidence collection. It failed after approximately 40
seconds without a diagnostic message. The workflow combined rootfs export,
package inventory, SBOM generation, vulnerability policy, signing,
verification, and promotion-manifest generation in one Actions step, so the
record could not identify which fail-closed assertion stopped the run.

No artifact was uploaded or accepted, and provider smoke was correctly skipped.

## Task

Preserve every supply-chain gate while making its outcome independently
observable and actionable.

## Execution

Split the unchanged fail-closed sequence into named Actions steps for rootfs
evidence extraction, SBOM generation, vulnerability scanning, QCOW2 signing and
verification, and promotion-manifest generation. Preserve their order and use
the same files in the same protected job.

Replace silent package-inventory and SBOM assertions with bounded error
messages that reveal only counts or the failed evidence invariant, never image
contents or credentials.

## Consequences

GitHub now records the exact evidence boundary that failed. Later stages remain
unreachable after any failure, and artifact upload still occurs only after all
five stages succeed. No policy, identity, signature, or vulnerability threshold
is relaxed.

Run 32771824710 remains diagnostic evidence only. It produced no accepted
artifact or provider smoke result.

## Verification

Require Bash parsing, ShellCheck, workflow/order contracts, focused
artifact/image/documentation tests, the complete repository gate,
pull-request CI and Security, and a new owner-approved exact-main image run.
Release evidence still requires a successful signed artifact upload and the
separately protected simulated provider smoke.

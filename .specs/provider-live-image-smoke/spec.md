# Spec: Compose the paid provider image smoke lane (OVHcloud and Contabo)

- Size: Large (10+ files, new adapters, workflow change)
- Runnable now: yes (code, tests, workflow). Live execution: no (needs owner credentials).
- STE step to add: Step 136 (renumber to the next free number on rebase)
- ADR to add: ADR 0106 — "Paid provider image smoke with hard TTL and always-cleanup"
- Branch: `spec/provider-live-image-smoke`

## Problem

The release verifier (`infra/scripts/verify-release-image-evidence.sh`) requires a successful `provider-image-smoke` job. Today that job in `.github/workflows/image.yml` only accepts `provider_image_smoke_provider: simulated` and runs `pnpm test:arma-sim`. ADR 0065 and STE Step 89 record the gap: "The production OVHcloud/Contabo custom-image import, short-lived artifact locator, boot/agent-health observer, response-loss adoption, and provider image/node cleanup adapter are not yet composed." PRODUCT.md success criteria 1, 2, 4 and 5 cannot be proven on a real provider until this exists.

## Requirements

- R1. A new package `packages/provider-image-smoke` exposes an Effect service `runProviderImageSmoke(input)` that: (a) registers or adopts the signed QCOW2 as a provider custom image through the existing `@gridora/provider-image-registration` transport, (b) creates exactly one disposable node from it with an idempotency key derived from `{sourceCommit, artifactDigest, provider, region, runId}` (ADR 0008, ADR 0019), (c) observes boot and node-agent health through a bounded poll against the provider API and the existing agent readiness contract, (d) adopts an in-flight create after response loss instead of creating a second instance, (e) deletes the node and the custom image in an `always` cleanup that runs even when any earlier step failed, and (f) returns a typed evidence record.
- R2. A hard TTL (1–60 minutes) is enforced inside the service, not only in the workflow: when the deadline passes the service cancels, cleans up, and fails.
- R3. The evidence record contains provider, region, plan, provider image ID, node ID, boot duration, agent-health outcome, cleanup receipts for node and image, and never contains a credential, token, or raw provider response body.
- R4. Both drivers are supported through `OvhOpenStackApi` in `packages/provider-ovh-public-cloud` and `ContaboApi` in `packages/provider-contabo`. Add only the API operations they are missing for image import and image delete; keep the drivers translation-only (PRODUCT.md principle 3).
- R5. Every denial path is tested with fakes: image import failure, uncertain create, duplicate create prevented on retry, boot timeout, agent never healthy, cleanup failure surfaces as an operator-visible error, TTL expiry, credential absent.
- R6. `.github/workflows/image.yml` gains `provider_image_smoke_provider` choices `ovh` and `contabo` and a boolean input `live_test` (default `false`). A paid provider is accepted only when `live_test == true`; otherwise the job fails before any provider call. Provider credentials come from the `image-signing` environment secrets and are never echoed. The `simulated` path is unchanged.
- R7. `infra/scripts/run-provider-image-smoke.mjs` (or `.ts` executed with the pinned toolchain) is the CLI entry the workflow calls; it accepts only env inputs, prints the redacted evidence JSON to `$GITHUB_STEP_SUMMARY`, and exits non-zero on any failure or on any cleanup that did not confirm deletion.
- R8. No live provider request is made by any test in `pnpm test`.

## Pointers

- `packages/provider-image-registration/src/index.ts` — registerOrAdopt transport.
- `packages/provider-create-transports`, `packages/provider-retirement-transports`, `packages/provider-node-lifecycle-transports` — existing create/delete seams.
- `packages/orphan-provider-live/src/index.ts` — the only live HTTPS adapters today.
- `packages/node-provision-execution` — boot/agent-readiness contract.
- `docs/adr/0008`, `0019`, `0043`, `0046`, `0065` — controlling decisions.
- `tests/architecture/release-workflow.test.ts`, `tests/infrastructure/image-artifact-evidence.test.ts` — workflow tests to extend.

## Out of scope

- Running the live test. Do not dispatch the workflow with `live_test=true`.
- Image promotion after smoke (ADR 0012 flow stays as is).

## Test requirements

- Package unit tests for R1–R5 with fake provider APIs.
- Workflow test: `live_test=false` with `ovh` fails closed; `simulated` unchanged.
- `pnpm check`, `pnpm test`, `pnpm build` pass.

## Deliverables

- PR against `main` with the code, ADR 0106, STE step, and this spec copied to `.specs/provider-live-image-smoke/spec.md`.
- PR body lists the exact secrets the owner must add to `image-signing` before a live run (names only).

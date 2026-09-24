# ADR 0106: Paid provider image smoke with hard TTL and always-cleanup

- Status: Accepted
- Date: 2026-09-24
- Extends: ADR 0008, ADR 0019, ADR 0043, ADR 0046, ADR 0065, and ADR 0105

## Situation

The release verifier requires a successful `provider-image-smoke` job. That job
accepted only the `simulated` provider and ran the Docker VPS simulation. ADR
0065 and STE Step 89 recorded the gap: no production OVHcloud or Contabo
custom-image import, short-lived artifact locator, boot and agent-health
observer, response-loss adoption, or provider image and node cleanup adapter
was composed. PRODUCT.md success criteria 1, 2, 4, and 5 could not be proven on
a real provider.

## Task

Compose a paid smoke lane that registers the signed QCOW2 as a provider custom
image, boots exactly one disposable node from it, observes boot and agent
health, and always removes both resources. Keep the paid lane behind an
explicit live-test flag and a hard TTL. Never expose a credential, token,
artifact locator, or provider response body. Keep the `simulated` lane
unchanged.

## Execution

Add `packages/provider-image-smoke`. Its Effect service
`runProviderImageSmoke` depends on two ports:

- `ProviderImageSmokeDriver` translates one provider API into image list,
  import, observe, and delete, and node list, create, observe, and dispose.
  `makeOvhImageSmokeDriver` wraps `OvhOpenStackApi`, and
  `makeContaboImageSmokeDriver` wraps `ContaboApi`. The drivers add no smoke
  policy.
- `AgentHealthObserver` returns the latest `AgentHealthSample`. The service
  validates it with the existing agent-telemetry contract and requires the
  exact smoke organization and node, `docker: healthy`, and
  `firewall: ready`. The smoke issues no Tunnel credential, so Tunnel state is
  recorded but not required.

The service derives one idempotency identity from the SHA-256 of the source
commit, artifact digest, provider, region, and run coordinate (ADR 0008). The
operation, node, node name, and image registration IDs come from that
identity, so a retried run with the same coordinates adopts its earlier
resources. Image registration uses the existing
`@gridora/provider-image-registration` transport. Node creation uses the SDK
`createOrAdopt`. A lost response becomes adopt-only discovery for a bounded
number of attempts. No code path sends a second paid create (ADR 0019).

The TTL is 1 to 60 minutes and is enforced inside the service with
`Effect.timeoutOrElse`. When it expires, the running step is interrupted and
the run fails with stage `ttl`. Cleanup is uninterruptible, has its own
bounded budget, and runs after every outcome. It discovers nodes by the exact
smoke operation metadata and images by the exact registration ID, in addition
to the IDs that the run recorded. It disposes of the node before the image and
confirms each disposal by provider readback. A node, image, or cleanup failure
is returned as a typed `ProviderImageSmokeError` with a stage, a fixed code or
provider error tag, and both cleanup receipts.

OVHcloud nodes are deleted and confirmed by absence. Contabo has no immediate
deletion (`immediateDelete: false`), so a Contabo node is disposed by contract
cancellation and confirmed only when the provider reports a cancellation
date. The receipt says `cancellation-scheduled`, not `deleted`.

Add only the missing image operations to the drivers. `OvhOpenStackApi` gains
optional Glance `customImages`, `importImage` (a private QCOW2 image plus one
`web-download` import), `getImage`, and `deleteImage`, offered only when an
image endpoint is configured. `ContaboApi` gains optional `customImages`,
`importImage`, `getImage`, and `deleteImage`. Contabo images carry no metadata
map, so the ownership record is encoded in a bounded 255-character
description.

`infra/scripts/run-provider-image-smoke.mjs` runs the bundled CLI. The CLI
reads only environment inputs. It checks `GRIDORA_LIVE_TEST=true` first, then
the fixed secret names for the selected provider, before any provider request.
It prints the evidence or failure record to stdout and `$GITHUB_STEP_SUMMARY`
after it proves that no credential or locator value is present. It exits 0
only when the smoke passed and both cleanups are confirmed.

`.github/workflows/image.yml` adds the `ovh` and `contabo` choices and a
`live_test` boolean input that defaults to `false`. An unconditional first
step fails a paid provider without `live_test=true` before the artifact
download or any provider call. The job now uses the reviewer-free
`image-signing` environment for its secrets, and its timeout is 90 minutes to
cover the 60-minute TTL and the cleanup budget. The paid step uploads the
verified QCOW2 to a private R2 bucket, creates a presigned URL that expires
with the TTL, masks it, and runs the CLI. An `always()` step removes the R2
object.

The live composition has no agent-health source yet. The smoke node receives no
registration token, so it cannot report to the control plane, and the drivers
expose no console channel. The live observer fails closed with
`agent-health-source-unavailable`. A live run can therefore prove image
import, boot, adoption, and cleanup, but cannot pass the release gate until a
later decision composes an agent-health source.

## Consequences

A paid provider image smoke has one tested, fail-closed path with a hard TTL
and metadata-driven cleanup. No test in `pnpm test` makes a live provider
request; the service, drivers, CLI, and workflow gate are tested with fakes,
a virtual clock, and a parsed workflow.

The `simulated` lane keeps its validation and simulation steps. It now runs in
the `image-signing` environment, which ADR 0105 keeps reviewer-free, so it
does not wait for approval.

A cancelled GitHub job can stop the process before cleanup completes. The
exact smoke metadata (`platform-image-smoke` organization and
operation ID) lets orphan reconciliation (ADR 0008) report the residue. The
OVHcloud and Contabo HTTP adapters decode every server in the project or
account and fail on a server without Gridora metadata, so the smoke needs a
dedicated OVHcloud project and a dedicated Contabo account. One Contabo run
costs at least one contract period.

The release gate stays closed for paid providers until an agent-health source
exists. The `simulated` lane continues to satisfy the release verifier
unchanged.

## Verification

Package tests cover the passing path, idempotency derivation, image import
rejection, image import failure, lost image and node create responses,
adopt-only uncertainty without a second create, adoption of an earlier run's
resources, definite create rejection, boot timeout, agent never healthy,
degraded and foreign agent samples, an unavailable agent source, node and
image cleanup failures, TTL expiry, Contabo cancellation receipts, input
validation before any request, and secret redaction. CLI tests cover the
live-test gate, credential absence, the redacted failure report, withheld
reports, and exit codes. Driver tests cover the new Glance and Contabo image
requests. The workflow test proves that `ovh` and `contabo` fail before any
provider call without `live_test=true`, and that the `simulated` lane keeps its
steps. Run documentation integrity, `pnpm check`, `pnpm test`, and
`pnpm build`. No workflow was dispatched with `live_test=true`, and no
provider resource was created.

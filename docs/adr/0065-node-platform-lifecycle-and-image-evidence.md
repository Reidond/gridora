# ADR 0065: Compose node lifecycle control with fail-closed image evidence

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0043, ADR 0045, ADR 0049, ADR 0052, ADR 0057, and ADR 0058

## Situation

The API, Workflow, D1, CLI, web, and image packages each had bounded node
contracts. Their separate existence did not prove that a public node action
would use the exact provider account, terminal operation, audit envelope, or
Workflow. The node image build also scanned the opaque QCOW2 file directly and
used a firewall file that could erase Docker-managed rules. A successful
validation-only workflow could look like release evidence even when no provider
image had booted and cleaned up.

## Task

Compose the canonical organization node actions and platform image lifecycle
without weakening tenant, cancellation, response-loss, or audit fences. Prove
the filesystem inventory actually used for the image, preserve Docker
networking during Gridora firewall reload, and keep a release blocked until a
protected provider registration, boot, health, and cleanup run produces exact
evidence.

## Execution

Register only canonical node actions. Runtime start, stop, reboot, and
reconcile use the node-runtime ledger. Drain, uncordon, rebuild, and retire use
the destructive lifecycle ledger and fixed native Workflow binding. The CLI,
generated client, OpenAPI, and API-mode web controls send the typed action,
revision, and idempotency key, then refetch authoritative state. Old public
501 routes are removed rather than advertised as supported behavior.

Every accepted or completed node and provider mutation creates an exact durable
operation and complete v1 audit envelope in the same D1 batch. Delayed
Workflow writes use immutable accepted request provenance and a machine source
origin. A terminal retirement receipt is operation-bound: it requires the
specific successful retire child, provider deletion or contract-end with
stopped billing, credential revocation, explicit deleted Tunnel and node facts,
terminal cancellation facts, and exact atomic receipts. It never treats a
missing row as cleanup.

The image workflow exports the QCOW2 root filesystem as a read-only archive,
requires a non-empty dpkg package inventory, generates the SBOM and Grype scan
from that archive, binds all checksums to promotion evidence, and verifies the
Cosign bundle against the protected GitHub Actions identity. Gridora nftables
reload destroys only the `inet gridora` table. A privileged nested-Docker proof
checks that Docker chains and an allowed game port survive a reload while an
unleased game port remains denied.

`provider-image-smoke` is a protected manual-dispatch job after the exact
`build-local` artifact. It rejects missing explicit approval, TTL above 60
minutes, and provider, region, or plan values outside protected allowlists. It
downloads and cryptographically verifies the exact workflow artifact before
any live provider path. The current runtime has no production OVHcloud or
Contabo custom-image import, boot, response-loss adoption, or cleanup adapter.
The job therefore fails closed after artifact verification; it cannot emit a
success that implies a provider image ID, agent health, or cleanup result.

## Consequences

Node control has one typed route and operation boundary per action. A replay
can adopt its original operation and Workflow start, but cannot retarget a
provider account or child retire operation. Organization deletion stays waiting
until the exact child receipt exists.

The root filesystem evidence is representative of the promoted image rather
than an opaque disk-file scan. Docker's unrelated nftables rules survive
Gridora reload. A normal CI or validation-only image workflow remains
insufficient for release. The release verifier requires successful `validate`,
`build-local`, and `provider-image-smoke` jobs plus the exact non-expired
artifact; the currently missing production image adapter intentionally keeps
that condition unsatisfied.

## Verification

Focused lifecycle D1 tests cover exact child receipt success and foreign,
wrong-node, and wrong-operation rejection. The package type check passes.
Rootfs evidence, promotion-manifest, and release-workflow tests cover package
inventory, checksum binding, Cosign verification invocation, TTL/approval
configuration, and the named protected job. The firewall proof is defined as a
privileged CI test using real nested Docker; it has not provisioned a provider
resource. `pnpm lint` passes locally. No Worker, D1 database, R2 bucket,
provider image, node, Tunnel, credential, or live provider API call was
created or changed.

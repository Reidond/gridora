# ADR 0057: Platform node-image lifecycle and proof-bound provider registration

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0012, ADR 0037, ADR 0043, ADR 0045, ADR 0046, and ADR 0048

## Situation

Gridora needs a trusted platform image for each provider policy scope. A user
or an organization role must not select an image, provider account, or provider
credential for that platform action. A lost provider response can otherwise
create a paid image twice. A stale provider account can also create an image
after its credential changed.

Old image rows use candidate and retired names. They do not contain the build,
test, scan, SBOM, and signature facts that a new image needs. A stock Ubuntu
fallback can start a node, but it must not be reported as a promoted custom
image.

## Task

Keep one platform-owned image state machine. Require trusted immutable evidence
before a new image can enter it. Register a custom image through a leased,
adopt-only provider boundary. Keep all accepted operation, audit, outbox, and
Workflow-start facts atomic. Do not make a live provider or image call in this
implementation step.

## Execution

The state machine uses `building`, `testing`, `promoted`, `deprecated`, and
`revoked`. Migration 0023 maps an old candidate row to `testing` and an old
retired row to `deprecated`. It marks those bridge rows as legacy and
unattested. A bridge row cannot claim current provenance or promotion proof.

Only a Platform Administrator can accept an image command. The operation stores
the administrator revision. The final D1 guard checks that revision again. An
organization role cannot use this path. A policy scope stores the provider type,
account, region, and architecture. Those coordinates are immutable. A scope
update can change only its stated fallback policy. The final guard rejects a
different coordinate set.

The create command uses immutable source commit, architecture, artifact digest,
manifest digest, SBOM digest, build log digest, and signed evidence. The
evidence verifier pins a configured signer key digest. It verifies the signed
build manifest and test report for the exact image, artifact, source commit,
and architecture. It does not trust a caller-supplied pass result. An exact
accepted replay reads the durable receipt before it reads an external evidence
store. This keeps a signer rotation or a temporary evidence outage from
breaking a completed replay.

Image validation includes the agent input graph. It covers the transitive
plugin-registry, plugin SDK, contract, and game-plugin inputs. A tested image
must have scan and smoke-test proof. Promotion requires one compatible custom
provider registration for the same scope. The scope keeps one promoted image or
an explicit revision. Rollback uses the stored last-known-good image. Revoke
does not delete an image that a scope still uses.

An accepted command writes the lifecycle resource, platform audit event,
operation, outbox event, and Workflow-start record in one D1 batch. The
operation stores the exact audit event ID. It does not derive that ID from a
string pattern. The Workflow has one fixed instance ID and one signed exact
step. D1 compares every signed step coordinate with the stored operation before
it can claim work.

The step receipt has a claim ID, attempt, lease, recovery deadline, and a
one-way provider-dispatch mark. A local lookup or transport-resolution failure
releases only a proven pre-dispatch claim. It can retry custom-image creation.
The dispatch mark is written before the provider transport opens. A crash or
unknown result after that mark can only adopt an existing provider image. It
cannot send a second create request. An expired recovery deadline records a
redacted terminal reconciliation result.

Provider registration stores the exact platform account revision and credential
reference. It checks the active account again before it resolves a transport,
and D1 checks it again before settlement. A disabled account or a changed
credential therefore prevents a provider call. OVHcloud and Contabo use narrow
registration and adoption transport seams. They have local contract tests. No
live transport is composed by this decision.

Each uncertain provider result stores the exact post-update registration
revision in its receipt. A later bounded adoption poll can store another
uncertain result. The final D1 guard binds the receipt, registration, and
operation in the same batch. This prevents a partial result when a competing
registration transition wins.

The stock Ubuntu plus fixed cloud-init mode is accepted only when the scope
allows it. It stores `degraded` and the exact cloud-init digest. It is never a
custom registration and it is never reported as promoted.

## Consequences

Platform image actions have a separate authority from organization actions.
Provider-image create is bounded by a durable receipt and a current account
fence. A response loss can be adopted only through the stored provider
coordinates. A definite provider failure becomes a redacted terminal result.

This decision adds D1 state and local execution contracts. It does not compose
the central API entry point, generated client, CLI, web UI, Cloudflare Workflow
binding, provider credential resolver, or a live provider transport. The
isolated platform route module is not registered by the central API entry
point. This decision does not create, import, promote, roll back, revoke, or
delete a real provider image.

## Verification

Local tests cover forged platform scope, stale administrator revision, exact
idempotent replay, response-loss Workflow adoption, forged signed-step scope,
trusted evidence signer pinning, revoked-image selection, in-use delete refusal,
provider account disable and credential rotation before dispatch, a crash after
dispatch, repeated uncertain adoption polling, terminal provider failure, and
the receipt/registration race fence. The OVHcloud and Contabo transport seams
also have local contract tests.

Focused checks and tests cover node-image control, D1, execution, Workflow,
provider registration, and migrations. A Packer validation path now supplies
only synthetic update evidence in CI. It does not run a Packer image build or a
provider call. No D1 migration, Workflow, provider account, provider image, or
Cloudflare resource was deployed or used live.

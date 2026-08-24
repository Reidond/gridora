# ADR 0052: Destructive lifecycle cancellation and provider-retirement truth

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0002, ADR 0008, ADR 0011, ADR 0013, ADR 0015, ADR 0018, ADR 0021, ADR 0032, ADR 0038, ADR 0043, ADR 0046, ADR 0049, ADR 0050, and ADR 0051

## Situation

Node drain, rebuild, retirement, organization deletion, generic operation
cancellation, provider billing, Durable Object coordination, and Workflow
retries had to become one truthful lifecycle rather than unrelated state
changes. A provider POST acknowledgement is not deletion proof, and an
ambiguous paid-provider result must remain visible and exclusive until it is
reconciled. Similarly, an outbox event is not evidence that the exact
Workflow started, a successful transport call is not cancellation delivery,
and a retry after a crashed signed step must not repeat a paid mutation.

Organization deletion has the strongest compound requirement. It must freeze
the tenant before collecting an inventory, retain or delete backups according
to its durable policy, drain workloads, retire paid nodes, revoke tenant
credentials, remove tenant networking, release reservations, and retain a
tombstone. It must never report a deleted organization while a paid or
ambiguous resource remains unresolved.

## Task

Implement an organization-fenced destructive lifecycle for node
`drain-node`, `leave-drain`, `rebuild-node`, and `retire-node`, organization
deletion, and cancellation of registered generic operations. Persist the
exact ResourceOperation Durable Object name and Workflow binding/instance for
each cancellable operation; no type-derived fallback is allowed. Require
durable, tenant-scoped evidence for every destructive admission, cancellation
delivery, provider observation, and terminal outcome.

## Execution

Migration 0019 adds a SHA-256-only destructive request ledger, exact
cancellation facts, Workflow-start records, signed-step receipts, node runs,
organization-deletion runs/inventory/tombstones, cancellation compensation,
and atomic audit/outbox receipt fences. Canonical request JSON is used only to
derive a bounded SHA-256 fingerprint and is never stored. Acceptance commits
the operation, immutable exact Workflow-start identity, audit, outbox, and
receipt in one transaction; response loss adopts only matching durable facts.

Node lifecycle acceptance records the current deployment inventory instead of
requiring an already empty node. Drain resolution proves each deployment was
moved or actually deleted. The hard provider-action trigger then rejects
rebuild or retirement until no deployment or pending affected-server record
remains and required backup evidence is available. Blocked or ambiguous
rebuild/retirement runs continue to own the node, preventing a second paid
destructive run. Node credentials, sessions, and registration tokens are
revoked before terminal retirement.

The provider transport preserves observed truth. OVH retirement is
`deleted-confirmed` only after a post-delete not-found observation; a timeout
performs a read and becomes `ambiguous` if that read cannot prove deletion.
Contabo first performs secure wipe and stop, then requests cancellation at the
earliest contract date. It records `cancel-scheduled` only with both concrete
cancellation and billing-stop dates; secure wipe alone is never represented as
immediate deletion. Contract end or confirmed deletion is required before
billing is `stopped` and node retirement can finalize.

Organization deletion changes the organization to `deleting` atomically with
its owner-authorized operation. Inventory materializes nodes, servers,
deployments, backups, Tunnels, DNS, credentials, sessions, automation
identities, provider accounts, capacity reservations, and port leases. The
workflow must resolve or retain every item with physical evidence, fail closed
when required backup evidence is absent, and keep any ambiguous or paid item
unresolved. It revokes credentials, releases tenant-only reservations, gates
network cleanup on actual deleted DNS/Tunnel state, and writes a retention
tombstone only after all guards confirm no paid provider resource, active
operation, or unresolved inventory remains.

Cancellation is authorized for Owner or Administrator roles and is fenced by
organization, operation revision, idempotency key, stored policy, and stored
phase. It is allowed only before a destructive step or between steps as the
durable policy permits; terminal, running, destructive-running, and unbound
operations fail closed. The cancellation request is committed before either
signal. The ResourceOperation Durable Object and exact Workflow instance must
each acknowledge their stored identity. D1 records the independent delivery
bits with deterministic audit/outbox/atomic evidence, and callers receive
only the committed state, never a transient transport success.

Signed Workflow steps use opaque claim IDs, monotonic attempts, and expiring
leases. Before side-effect completion, the executor writes an exact,
non-secret provider or agent effect receipt. An expired lease calls its
side-effect-specific observer: an exact applied effect is adopted, a definitely
unapplied effect transfers to a new fenced claim, and unknown provider truth
returns reconciliation-required without execution. Completion requires both
the exact effect receipt and a facts-revision dependency chain. A final D1
completion receipt trigger aborts the whole batch if either the facts update
or receipt update affected zero rows, so cancellation/revision races cannot
commit a completed step with stale `*-step-running` facts.

The public Hono registration is composed with authoritative authorization, D1
repositories, exact DO names, and Workflow bindings. Organization deletion
acceptance is Owner-only, slug/revision confirmed, audit-context preserving,
and starts or adopts only its recorded Workflow identity. Its signed cleanup
executor inventories every resource, completes an already-empty or
authoritatively pre-cleaned organization, and fails closed while server,
deployment, backup, node, DNS, or Tunnel items lack their own terminal receipt.
Every delayed human-derived step reuses the bounded immutable HTTP provenance
stored at acceptance and stages a terminal child operation before its post-0028
audit envelope. Cancellation signals the stored
ResourceOperation and exact Workflow binding/type. Provider ownership
observers and credentials remain explicit runtime dependencies.

## Consequences

Destructive retries converge on exact tenant facts, immutable Workflow
metadata, provider observations, durable effect receipts, and audit/outbox
evidence. Cross-tenant identifiers, stale revisions, non-owner organization
deletion, last-owner bypasses, cancellation after a destructive step,
successful-false signal acknowledgements, response loss, concurrent runs,
missing backup proof, stale leases, and ambiguous paid-provider state fail
closed. A cancellation or cleanup action releases only reservations and
credentials belonging to the exact organization and operation.

This decision intentionally leaves node start, stop, reboot, and observation
reconcile as separate non-destructive operation surfaces. API, generated
client, CLI, web cleanup confirmation, Durable Object cancellation, and
Workflow bindings preserve stored exact identifiers. Deployed D1 and live paid
retirement still require provider ownership evidence and explicit approval.

## Verification

Focused behavioral tests cover cancellation false acknowledgements, durable
response-loss adoption, SHA-only request fingerprints, exact signed Workflow
adoption, applied/not-applied/unknown expired-step recovery, D1 effect receipt
response loss, facts-revision completion barriers, provider truth for OVH and
Contabo, and public route tenant/internal-field fences. The D1 test simulates
a competing facts revision after completion pre-read and proves the batch
leaves the step running with active facts and no completion receipt.

`pnpm --filter @gridora/lifecycle-termination-control test`,
`pnpm --filter @gridora/lifecycle-termination-workflow test`,
`pnpm --filter @gridora/lifecycle-termination-d1 test`, and
`pnpm --filter @gridora/provider-retirement-transports test` pass locally;
the focused sets contain 4, 3, 3, and 3 tests respectively. Owned package
type checks pass, migration 0019 parses through the registered migration
sequence, and lint has no warning in the owned lifecycle packages. The
concurrent backup-route API type diagnostics have cleared. The local delayed
empty-organization path is covered through inventory, credential revocation,
reservation release, ready-to-tombstone, and final tombstone with six strict v1
audits. Non-empty organizations remain reconciliation-gated on terminal child
receipts; parent dispatch never substitutes for physical deletion. No deployed
migration, provider credential, signed live Workflow, or approved paid
create-and-retire cleanup evidence exists yet.

# `@gridora/policy-d1`

D1 adapters for `@gridora/policy-control`. The package reads organization policy with a three-way
revision fence (`organizations.policy_revision`, `organization_policies.revision`, and embedded
policy revision), and resolves one transactionally batched, organization-scoped admission snapshot
from provider allocations/catalog, nodes, node capacity, game servers/deployments, backups, and
operations.

Prices and accumulated monthly commitments are estimates in safe integer minor units. A missing,
malformed, or stale requested price fails closed. Existing paid nodes with missing catalog prices or
an in-flight node operation that has no corresponding node row also fail the facts read rather than
under-counting commitment.

The current inventory schema does not persist an immutable Contabo contract duration on each node or
provider instance. Catalog metadata is mutable and therefore is not evidence of the accepted
commitment. New Contabo admission consequently returns unknown price/commitment facts and fails
closed until lifecycle reservation persists node-specific contract terms.

## Atomicity gate

D1 `batch` gives one consistent pre-admission read snapshot. A read by itself still does **not**
authorize a paid provider action. The node-provision acceptance path now re-checks the authoritative
facts and, in its acceptance transaction, fences the policy revision and records the admitted
spend/node reservation before its Workflow can contact a provider. The game lifecycle acceptance
path likewise records its capacity and port reservation with its revision fences.

`POST /game-servers/apply` is a durable parent orchestration acceptance rather than a second
provider implementation. It persists the reviewed plan, audit envelope, idempotency fingerprint,
and immutable child-operation slots. When a plan needs new capacity, its Workflow invokes the
existing node-provision acceptance, waits for node desired/observed state plus fresh agent, tunnel,
Docker, firewall, and capacity evidence, then invokes the existing game lifecycle reservation. The
parent does not treat provider-instance creation as node readiness, and it never turns a planning
read into a provider mutation.

Those child reservations are intentionally separate transactions: an existing-node server plan does
not reserve a provider spend slot, while a new-node plan must be re-admitted at node acceptance and
then re-fenced at game reservation. Response-loss replay adopts those exact parent/child operations;
it does not start a duplicate paid request.

Further composition requires:

- D1-backed policy mutation with Owner authorization, optimistic revision update, and audit event;
- reconciliation/release of any accepted reservation on provider failure, cancellation, or orphan
  adoption (the existing child lifecycle controls own those state transitions);
- a provider-catalog refresher that records explicit freshness and contract metadata.

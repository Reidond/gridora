# ADR 0069: Game lifecycle completion and move composition

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0032, ADR 0034, ADR 0036, ADR 0050, ADR 0051, ADR 0064, and ADR 0068

## Situation

Gridora accepted game-server mutations and dispatched durable Workflow steps, but
the final agent observation or DNS receipt did not create one terminal v1 audit
fact. A provider response or a queued command could therefore look complete to a
replay. Server move also needed one operation-bound reservation, backup, restore,
cutover, release, and observation path.

## Task

Make every game lifecycle action finish only after exact command, provider, DNS,
backup, move, and observation evidence exists. Preserve the HTTP request, Access
claims, source origin, correlation, actor, tenant, server, and accepted operation
coordinates across delayed Workflow execution and response loss. Keep the public
server and move routes on the same D1 and Workflow fences.

## Execution

Migration 0051 keeps an observation as evidence only. The completion batch now
transitions the original accepted lifecycle operation to `succeeded`, progress
100, and its exact next revision, clears the server pending-operation pointer,
stages the v1 completion envelope and compact audit, and inserts the immutable
receipt with that original-operation revision. A response lost after commit is
adopted only by reading this exact terminal state. Historical completion receipts
carry no fabricated parent revision and do not prove the new guarantee.

Organization deletion reads the original delete operation, its terminal progress
and revision, the matching completion receipt, and the operation-bound deleted
DNS receipt. It cannot infer deletion from a child audit operation or a provider
response alone.

Domain acceptance snapshots the selected deployment node's provider/agent
player endpoint in `game_lifecycle_dns_authorities`. The runtime resolver and
receipt recorder use that same immutable hostname, A/AAAA type, target, and
explicit zone ID for the provider call and D1 receipt. A missing or changed
authoritative endpoint fails closed; neither `pending` nor a Worker-wide target
is a valid authority.

Moves persist a separate immutable effect before source-affecting work. It
contains source and target node/provider coordinates, deployment and lease
identity, and any exact DNS source/target tuple. Migration 0056 adds a distinct
target staging record and physical-command ledger. Target restore, validation,
and data commit use the immutable effect but do not change the authoritative
deployment row. Only an exact target activation and D1 cutover make the target
authoritative.

The native move adapter persists one signed command envelope and terminal result
for backup restore stage, validation, commit, target activation, source release,
and every reverse action. A post-stop failure invokes physical compensation.
It recreates and starts the immutable source even if target cleanup or DNS
rollback has failed. It records `rolled_back` only after exact reverse
DNS/provider, target-data, target-agent, and source-agent evidence succeeds.
The Workflow payload comparator retains accepted source coordinates while it
excludes mutable move phase, source-preserved, and backup progress values. A
retry therefore does not self-invalidate after a real cutover.

DNS teardown reads the immutable publish receipt zone, provider record ID,
record type, and target. An absent record in a different current zone cannot
prove deletion. The provider adapter rejects an absent exact record, a changed
provider ID, or a changed target before it sends DELETE.

The generated client, CLI, and web UI now submit the same typed move request:
target node ID, expected server revision, and required backup policy. Web retry
uses the operation idempotency key and displays no optimistic node relocation.

## Consequences

Queued commands, responsive nodes, child completion operations, and provider
acknowledgements cannot by themselves produce a succeeded game lifecycle
operation. Workflow retries adopt immutable command, DNS, move, and completion
facts. Cross-tenant, foreign-server, stale-provenance, altered-evidence, absent
endpoint, incomplete reverse-cutover, and mutable-progress replay writes fail
closed at the D1 boundary.

The local implementation still requires configured Cloudflare, backup, agent,
Workflow, and provider bindings for live execution. No paid provider, DNS zone,
node, game server, or production Worker was changed by this implementation.

## Verification

Focused local verification on 2026-08-24: migrations pass 8 files / 31 tests
with the full registered inventory and foreign keys enabled; game-lifecycle D1
passes 14/14; execution passes 13/13; Cloudflare control passes 14/14; and the
direct runtime suite passes 12/12. The runtime paths prove response-loss command
adoption, non-authoritative target staging, accepted-source replay after a real
cutover, restore/validate/cutover/release failure compensation, stop-transition
source restart, immutable DNS delete authority, and exact D1 rollback fencing.
The package type checks for migrations, game lifecycle D1, execution, and
Cloudflare control pass. The broader API check is currently blocked by concurrent
backup-upload and telemetry contract changes outside this decision; it is not
treated as game-lifecycle evidence. These are local D1 and provider-boundary
simulations only. No live Cloudflare, provider, node, backup, game server, or
production Worker mutation is claimed.

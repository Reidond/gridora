# ADR 0035: Organization policy admission

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0013, and ADR 0032

## Situation

An organization can restrict providers, regions, plans, capacity, budget,
backups, updates, maintenance windows, temporary nodes, idle resources, and
provider commitments. A client request is not an authoritative source for these
rules. A stale price or an incomplete usage snapshot can undercount a paid
commitment.

## Task

Gridora must read one versioned organization policy. Gridora must read facts for
the same organization and resource. Gridora must reject an operation when a hard
rule is not satisfied. Gridora must record a soft-budget warning before it starts
work. Gridora must not describe an estimate as a provider invoice.

## Execution

The policy schema uses one fixed `v1` format. Money uses integer ISO currency
minor units. The evaluator uses only injected policy, usage, price, time, and
resource facts. Unknown, malformed, foreign, stale, or overflowing facts fail
closed.

The D1 adapter reads the organization policy with three matching revisions. It
reads the usage and resource facts in one D1 batch. The resource kind selects one
exact node or server query. Existing paid nodes require a fresh catalog estimate.
A new Contabo admission fails closed until the node schema can store immutable
contract terms.

A destructive node action checks every live server on that node. An empty node
does not require a backup. Every hosted live server must have an available backup
at the required revision when policy requires a backup.

The evaluator distinguishes hard denials from soft warnings. Automatic updates
must match the configured update class and UTC maintenance window. The idle
reconciler returns a deterministic action proposal. It does not perform the
action.

Organization creation constructs the revision-1 policy before it opens the D1
unit of work. The unit of work writes the organization, Owner membership,
onboarding state, terms acceptance, policy, audit, outbox, and idempotency record
in one batch. The initial policy has empty provider and plan allow-lists. It has
zero capacity, soft-budget, and hard-budget limits. It has no currency unless
setup supplied a valid warning amount and currency pair. A setup warning does
not authorize spending.

The API exports organization-scoped policy GET and optimistic-revision PUT
operations. An active Viewer can read the policy. An Administrator can change
operational policy. An Owner must authorize changes to `monthlyBudget` or
`nonHourlyCommitment`. PUT uses an idempotency fingerprint, revision fencing,
one append-only audit event, and an exact persisted-value check. The generated
client and organization settings page use the same full v1 wire contract.

## Consequences

The client cannot bypass policy with a supplied price, count, resource kind, or
policy value. The same policy logic can protect an HTTP request, a Workflow, and
a reconciler.

A D1 batch is only a consistent pre-admission snapshot. It is not a spend or
capacity reservation. Two paid creates can observe the same available capacity.
Gridora must keep node and server creation disabled until one lifecycle
transaction fences the policy revision and writes the spend and capacity
reservation.

## Verification

Tests must cover strict schema decoding, organization and revision fences,
node/server ID collisions, provider and region rules, stale and missing prices,
safe integer overflow, soft and hard budgets, non-hourly commitments, Contabo
unknown terms, capacity, placement, update classes, UTC window wrap, idle action
proposals, temporary expiry, and backup coverage for every hosted server. API
tests must cover role, tenant, idempotency, and optimistic policy revision rules.
Exported-Worker tests must also prove that organization creation stores the
exact initial policy and that node and server creation remain unavailable.

# ADR 0058: Exact non-destructive node runtime lifecycle

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0013, ADR 0018, ADR 0021, ADR 0032, ADR 0037, ADR 0038, ADR 0043, ADR 0048, and ADR 0049

## Situation

Start, stop, reboot, and reconcile can change a paid VPS. A request success is
not proof that a provider changed the VPS. A worker can lose a lease response,
crash before its provider call, lose its response after a dispatch mark, or
lose provider observation after a provider accepted the action. Two accounts
of the same provider can use different credentials. A retry must not send the
action through the wrong account or perform a second action without evidence.

## Task

Add organization-fenced, non-destructive node lifecycle intent and execution
for start, stop, reboot, and reconcile. Bind each action to the exact provider
account, allocation, credential reference, and revisions. Use leases, durable
receipts, provider observation, audit, and outbox records to preserve truthful
state during concurrency and response loss.

## Execution

Migration 0024 stores lifecycle intents, Workflow-start records, executions,
dispatch marks, observations, and final execution receipts. Acceptance atomically
writes the node desired-state transition, operation, workflow-start record,
execution, audit record, outbox record, and idempotency receipt. It requires an
active organization, an allowed Owner, Administrator, or Operator role, the
expected node revision, and an explicit provider capability. A public intent
does not select a provider ID or credential.

Acceptance captures the exact provider account, allocation, credential
reference, provider type, provider instance, and their revisions. Claim and
commit fences recheck the active account, allocation, credential envelope, and
exact revisions. The transport opens only the matching credential-scoped
adapter and verifies Gridora ownership metadata. It cannot select one global
adapter for two accounts of the same provider.

An executor first leases the exact operation. It writes a durable dispatch mark
before a provider action. If a worker loses the lease result or crashes before
this mark, an expired lease can be claimed later and dispatched once. If an
exact dispatch mark exists, a retry observes only and does not repeat the
action. A final D1 receipt fence aborts the whole batch when the node,
operation, execution, observation, audit, or outbox revision is stale.

Only a provider-specific receipt that proves non-application can unlock a
start or stop action. A reboot is never inferred from a request success or a
normal active observation. An unknown dispatch result or an error after a
successful or ambiguous provider call becomes an unknown observation and a
bounded reconciliation state. It never rolls back desired state as a proven
non-action. Reconcile performs observation only and compares desired and
observed state.

The packages are isolated. They are not yet connected to the central API,
Worker, Workflow, CLI, web application, generated client, provider secret
resolver, or a deployed D1 database.

## Consequences

The system can distinguish a retry that may dispatch from one that must only
observe. It keeps the correct provider account and credential binding during a
rotation or allocation change. A stale tenant, revision, role, lease, account,
allocation, or credential request fails closed. A definite pre-dispatch
provider rejection atomically clears the pending node action and restores the
prior desired state. A post-dispatch failure remains visible for reconciliation
instead of claiming that the action did not happen.

This decision does not authorize live provider calls. A deployment must supply
the exact encrypted credential resolver, D1 migration, Worker and Workflow
bindings, and approved bounded non-production provider evidence before it can
claim an end-to-end node lifecycle.

## Verification

Focused control, D1, executor, and provider-transport tests cover exact tenant
and revision fences, role demotion, capability denial, provider account
selection, credential and allocation revision changes, lease recovery before
the dispatch mark, response loss after the dispatch mark, action-requested
observation, definite non-application, reboot manual reconciliation, and
post-dispatch observation failure. The focused package checks and tests pass
locally. Migration 0024 is registered and applies in the local D1 lifecycle
test sequence. A security reread found no remaining High or Medium issue in
this isolated slice. No migration, provider credential, provider call, Worker,
Workflow, or live node action was deployed or run.

# ADR 0054: Schedule read-only orphan reconciliation

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0018, ADR 0034, ADR 0037, ADR 0039, and ADR 0048

## Situation

ADR 0039 defines safe orphan discovery. It did not define the active path from
a cron trigger to a durable Workflow and then to the real discovery runtime.
Without this path, an active allocation can be missed. A queue retry can also
start more than one run, or a changed credential can be used after discovery.

An orphan check can find a resource that has Gridora ownership data but no D1
node. It is an alert. It is not permission to delete, stop, or change a
provider resource.

## Task

Run one bounded, tenant-scoped, read-only reconciliation for each exact active
provider allocation. Use only D1 allocation and account state. Use a durable
lease and deterministic Workflow ID. Keep provider credentials and provider
responses out of cron, queue, Workflow input, logs, events, and audit data.
Reject a forged tenant task, an expired lease, a disabled allocation, and a
credential that changed during discovery. Keep every finding, audit event,
export request, and replay result atomic.

## Execution

Migration 0021 adds a protected automation identity for each organization. It
adds a schedule lease for one organization, provider account, and schedule
slot. It also adds a final D1 trigger that checks active organization,
allocation, account, automation membership, credential reference, and
credential revision before a reconciliation run can be inserted.

The queue Worker owns the ten-minute cron. It reads at most 25 active D1
allocations. It derives one task ID, run ID, idempotency key, workflow ID, and
lease token from the exact tenant tuple and time slot. The task has no provider
credential. The Worker writes the lease before it sends the queue message.
It can renew an expired pending or running lease. It does not enumerate a
provider account without an active allocation.

The queue consumer moves the exact D1 lease to running before it creates the
Workflow. If a create response is lost, it adopts only the same deterministic
Workflow ID. The Workflow has one fixed durable step. It signs one internal
request for the exact organization and task. The API checks the signature,
nonce, route, tenant header, task ID, lease, and current D1 scope before it
opens a credential.

The API composes the real orphan runtime with the live OVHcloud and Contabo
list-only adapters. The adapters use fixed endpoints, bounded responses, and
one bounded page. They do not receive a provider mutation capability. The
runtime records the exact credential reference and revision that it opened.
The repository checks that value before it builds writes. The D1 run insert
trigger checks it again in the final atomic batch. A changed or disabled scope
therefore rolls back the finding, run, audit event, and export request.

The runtime can only record high-severity orphan findings. It publishes a
secret-free organization event after a persisted result and before it marks the
lease complete. It never deletes a provider resource. A lost event or complete
response retries the exact durable task and uses the existing D1 result.

## Consequences

The normal cron path now reaches active orphan discovery. It is bounded by 25
allocations per tick and a 15-minute lease. A delayed queue message can wait
for a lease to expire. This is safer than starting an unbounded second run.

This is local implementation evidence. It is not live evidence. A deployed D1
migration, queue binding, Workflow binding, internal request secret, KEK,
encrypted provider credentials, and approved non-production provider account
are still required for a live check. The implementation must not be changed to
delete a provider resource without a later explicit decision.

## Verification

Local tests cover exact active allocation enumeration, a 25-item bound,
forged-tenant rejection, D1 response loss, Workflow create response loss,
durable replay, signed route and tenant binding, provider continuation refusal,
foreign provider ownership, disabled allocation after discovery, and credential
rotation after discovery. The last two tests prove that no finding, run, or
audit event is persisted under stale authority.

Focused local package type checks and tests pass for `orphan-schedule`,
`orphan-provider-live`, `orphan-control`, `orphan-d1`, `queue-consumers`,
`workflows`, `api`, and `migrations`. `wrangler types` also generated the
queue Worker binding type from the local configuration. No live provider call,
secret read, D1 migration, queue delivery, or Workflow run was performed.

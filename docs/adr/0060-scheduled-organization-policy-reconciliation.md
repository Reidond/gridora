# ADR 0060: Scheduled organization policy reconciliation with fenced lifecycle acceptance

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0018, ADR 0021, ADR 0035, ADR 0038, ADR 0050, ADR 0052, ADR 0054, ADR 0056, ADR 0058, and ADR 0059

## Situation

An organization policy can require action when a temporary node expires, a
server is idle, or an approved update is inside a maintenance window. A cron
task can run after a policy, membership, lease, health fact, candidate, or
resource revision changes. A queue response can be lost. A Workflow can run
again. An automatic action must not use a client credential, scan all tenants,
or report a provider, agent, or game result that it does not have.

## Task

Schedule a bounded reconciliation for active organizations. Keep the exact
organization, scheduler identity, policy revision, resource revision, lease,
and idempotency data in D1. Submit only a current action to the existing node
or game lifecycle acceptance boundary. Record audit and outbox evidence. Do
not silently delete a resource or claim that a request changed a provider,
node, or game server.

## Execution

Migration 0025 adds one immutable scheduler automation identity per
organization, a bounded schedule cursor, tenant leases, runs, action receipts,
approved update candidates, and player activity derived only from positive
authoritative health observations. It adds the nullable immutable temporary
node expiry fact. A NULL expiry is not actionable. Node acceptance writes an
expiry only when the accepted temporary lifetime requires one.

The queue worker reads a fixed D1 page of current organizations. It creates a
deterministic task ID, idempotency key, Workflow ID, and lease token from the
organization, scheduler identity, policy revision, and schedule slot. Queue
and Workflow retries adopt the same durable task. The signed internal route
checks the raw request, fixed Workflow name, tenant header, idempotency header,
and live lease before it loads a bounded D1 snapshot.

The planner can request node retirement after an immutable expiry, server stop
or delete after current zero-player health and idle facts, and an update only
for an approved candidate inside the current maintenance rule. It stores the
exact server configuration and mod revisions for an update. The final D1
triggers recheck the organization, policy, scheduler identity, active
automation membership, lease, resource, health, candidate, maintenance window,
and action receipt. A change rolls back the run, action, audit, and outbox
batch.

The executor uses the existing destructive node lifecycle control only for the
fixed scheduler `retire-node` exception. It uses the existing game lifecycle
repository for stop, delete, and update acceptance. The game mutation trigger
checks the exact action ID, policy and resource revision, config and mod
revision, candidate, lease, and accepted mutation payload. An action becomes
accepted only after the matching normal lifecycle receipt exists. The receipt
means that a lifecycle request was accepted or needs reconciliation. It does
not mean that a provider, agent, or game process completed work.

## Consequences

The scheduler has no provider credential and no client-selected tenant input.
It reads at most the configured D1 page and resource bounds. A forged tenant,
expired lease, replay with a different task, stale policy, stale resource,
revoked scheduler membership, or changed update revision fails closed.

An idle delete remains visible through its policy action, normal lifecycle
operation, audit event, and outbox event. The scheduler never directly calls a
provider or agent and never changes a resource into a completed deletion. The
normal lifecycle and backup controls retain their existing evidence and backup
rules. The internal API route is composed with the global signed-request and
nonce guard. A live service still needs Cloudflare bindings and approved
non-production evidence before it can execute this path.

## Verification

Focused local tests cover bounded tenant selection, deterministic task
derivation, queue and Workflow replay adoption, forged tenant rejection,
temporary expiry, idle health facts, maintenance-gated update planning, final
policy and resource races, update config/mod revision fencing, lifecycle action
submission, response-loss readback, and the signed internal route. The
migration, policy scheduler, policy control, policy D1, queue consumer,
API-route focused checks are recorded in Step 84. The policy-specific Workflow
test passes. The shared Workflow package compiler has separate concurrent
node-image diagnostics outside this composition. No provider credential,
provider call, agent action, Cloudflare queue, Workflow, D1 database, or live
resource was used.

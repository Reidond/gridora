# ADR 0015: Organization deletion and paid-resource cleanup

- Status: Accepted
- Date: 2026-08-23

## Context

An organization can own paid resources and retained backups. One database delete is unsafe.

## Decision

Deletion is a durable, reviewable operation: freeze mutations, inventory paid
resources, enforce backup policy, drain servers, retire nodes, confirm provider
cancellation semantics, revoke credentials, tombstone tenant data, then expire it
under retention policy. Force steps require reason and Owner confirmation.

## Consequences

An organization is not reported deleted while paid or ambiguous resources remain.
Audit and minimal billing evidence outlive operational data according to policy;
reconciliation continues until every external resource is accounted for.

## Alternatives

We rejected immediate row deletion. It can orphan paid servers. We rejected silent
best-effort cleanup. Operators need explicit unresolved states.

## Verification

Inject failures at each cleanup step. Resume the Workflow. Keep unknown resources.

# ADR 0032: Atomic lifecycle reservation and deterministic Workflow start

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0018, ADR 0019, and ADR 0021

## Situation

An HTTP success cannot mean that a VPS or game process changed. It can only mean
that Gridora durably accepted a lifecycle request. A database commit can succeed
while a Cloudflare Workflow start response is lost. A retry must not reserve a
second desired revision or create a second Workflow instance.

## Task

Gridora must bind one client idempotency key to the exact tenant, actor, resource,
action, expected revision, and payload. It must reserve desired state and create
all acceptance evidence in one transaction. Workflow start must use one stable
instance ID and support exact adoption after response loss.

## Execution

The lifecycle service first adopts an exact prior reservation. For a new request,
it reads the resource only inside the organization, checks the expected desired
revision, checks the state transition, and runs policy admission.

One D1 transaction advances the desired revision and state, creates the queued
operation, binds the request fingerprint, writes the lifecycle reservation,
writes the secret-free audit event, and creates a pending Workflow-start record
and publication event. A compare-and-set failure rolls back the complete batch.

The API selects a fixed Workflow binding from an allow-list for the action. It
does not accept a binding name or Workflow instance ID from HTTP. The adapter uses
the operation ID as the only Workflow instance ID. It sends the complete canonical
organization, actor, resource, correlation, fingerprint, and revision metadata.
An existing instance is adopted only when authoritative D1 start metadata matches.

If start or start acknowledgement is uncertain, the API returns
`pending-reconciliation`. It does not return lifecycle completion. A reconciler
retries the same operation ID. A different instance, organization, fingerprint,
or revision is a mismatch and is never adopted.

Creation of a new node or game-server row needs a separate atomic materialization
contract. Existing-resource reservation must not be presented as that contract.

## Consequences

An accepted mutation is durable even when Workflow start is temporarily
unavailable. The operation ID connects the HTTP request, D1 state, Workflow,
provider or agent work, and audit. Resource revisions serialize incompatible
changes, and an idempotency key cannot be reused for changed input.

This decision does not make a provider, Steam, Docker, backup, or game action live.
Each Workflow step still needs a real adapter and final-state reconciliation.

## Verification

Tests must prove exact replay, changed-fingerprint conflict, stale-revision
conflict, concurrent reservation rollback, cross-organization non-disclosure,
atomic audit/start evidence, fixed binding selection, first start, exact adoption,
lost response, mismatched handle rejection, terminal rejection, and pending-start
reconciliation. HTTP tests must confirm that unsupported create materialization
still returns `501` with no database effects.

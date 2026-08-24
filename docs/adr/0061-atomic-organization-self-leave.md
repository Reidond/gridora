# ADR 0061: Use an atomic receipt for organization self-leave

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0018, ADR 0021, and ADR 0041

## Situation

The product lets a user leave an organization but protects the final Owner.
Administrator removal cannot implement this contract because an Operator or a
Viewer must be able to remove their own membership. A successful membership
delete can also lose its HTTP response. The retry then has no live membership
with which to pass ordinary organization authorization. Existing realtime
connections must stop receiving organization events after either removal or
self-leave.

## Task

Implement self-leave without weakening administrator-only member removal.
Protect the final Owner at commit time. Commit the membership deletion, audit
event, and outbox event atomically. Adopt an exact successful retry without a
live membership, and revoke existing organization event sockets immediately.

## Execution

Migration 0026 adds an immutable self-leave receipt. One guarded insert binds
the organization, Access identity, membership revision, current human role,
correlation ID, event ID, and timestamp. Its trigger deletes that exact active
membership only when the organization is active and another active Owner
exists if the actor is an Owner. The same trigger writes the audit and outbox
evidence and aborts the complete transaction if any final evidence is absent.

The API authenticates the active global Access identity and parses the exact
expected membership revision. It checks for a receipt bound to that identity,
revision, and organization ID or immutable slug before it requires a current
membership. An exact prior receipt returns the same 204 result. A new request
must still pass live organization authorization. The receipt lookup cannot be
used to inspect another identity or organization.

The self-leave event uses the immediate OrganizationEvents publisher. The
realtime coordinator treats `organization.membership.left` and administrator
`organization.membership.revoked` events identically and closes every socket
tagged for the affected principal.

The generated client, CLI, and web settings page use
`POST /v1/organizations/:organization/actions/leave` with an expected
membership revision. The browser removes the departed organization from local
state only after the API succeeds.

## Consequences

An Administrator, Operator, or Viewer can leave without gaining member-removal
authority. An Owner can leave only when another active Owner remains. A lost
204 response does not strand the client or duplicate evidence. Existing
organization event connections are closed after the revocation event. The
global human identity remains available for other organizations.

## Verification

SQLite tests cover final-Owner and stale-revision rejection, atomic membership,
audit, and outbox effects, ID-and-slug receipt lookup, response-loss replay, and
single evidence records. An API route test returns 204 twice from the exact
receipt without a membership query. Queue and realtime tests cover the
self-leave event and principal socket closure. Generated-client, CLI, and web
checks cover the canonical route and revision body. No live Worker, D1
migration, Queue, Durable Object, or Cloudflare Access policy was deployed.

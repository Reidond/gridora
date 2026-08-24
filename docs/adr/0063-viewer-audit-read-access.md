# ADR 0063: Give Viewers tenant-scoped audit read access

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013 and ADR 0034

## Situation

The product role matrix gives a Viewer read-only access to audit history. The
central audit inventory routes instead required an Administrator. The D1
inventory query was already scoped by the authorized organization context, so
the extra role requirement denied a specified read without adding tenant
isolation.

## Task

Permit a Viewer to list and read audit events for the active organization.
Preserve the existing organization predicate, non-disclosing detail behavior,
append-only writes, exports, and all mutation role requirements.

## Execution

The API registers audit inventory with the Viewer minimum role. Authorization
still resolves one active identity and membership for the organization ID or
immutable slug. The inventory repository still includes the organization ID in
every list and detail predicate. No audit append, export, retention, or
administrative mutation permission changed.

## Consequences

Viewer behavior matches the product role matrix. A Viewer can inspect its
organization's operational history but cannot read another tenant's events or
perform a mutation. Administrator and Owner access is unchanged.

## Verification

The inventory HTTP test changes the active membership to Viewer, inserts one
local and one foreign audit event, receives only the local event, and returns a
successful response. The test uses the real central Hono route, Access JWT
verification, authorization service, D1 repository, and tenant predicate. No
live Worker, Access policy, or D1 database was used.

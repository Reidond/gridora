# ADR 0036: Authoritative D1 server planning

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0009, ADR 0032, and ADR 0035

## Situation

A game-server plan selects a plugin version, a node, resource capacity, ports,
and placement facts. A client cannot be authoritative for a provider account,
an allocation, an operation ID, a server ID, a deployment ID, a plugin
version, node health, available capacity, or current budget usage. Separate
reads can become stale before a later create transaction. A plan must not
reserve capacity or imply that paid infrastructure or a game server exists.

## Task

Gridora must accept one strict, tenant-scoped planning intent. Gridora must read
the active plugin contract, organization policy, budget usage, provider
allocation, provider catalog, node health, capacity reservations, deployments,
and port leases from D1. Gridora must select only a node owned by the authorized
organization. Gridora must keep planning read-only. Gridora must keep server
creation unavailable until a complete provider and agent Workflow can execute
the accepted reservation.

## Execution

The public plan body contains the schema version, server name, plugin ID,
placement mode, and resource request. Strict Effect Schema decoding rejects
excess client-selected server, deployment, operation, provider-account, and
allocation identifiers.

An active Operator, Administrator, or Owner can call the organization-scoped
plan route. The route resolves the organization by ID or slug through the
existing authorization service. It passes the authorized organization, actor,
role, and correlation ID to the Effect control.

Migration 0013 stores one reviewed active plugin version and plan contract. It
stores versioned node runtime capacity and health facts. It stores capacity and
create reservations for the later create transaction. Revision triggers require
monotonic plugin-channel and capacity updates.

The D1 repository reads the policy, estimated committed spend, active plugin
contract, provider allocation, provider catalog, node runtime report, existing
deployments, capacity reservations, and live port leases. Every candidate query
includes the organization ID. A foreign organization is never a fallback.

The planner rejects a disabled plugin, incompatible architecture, stale health
report, stale catalog, draining or unready node, unaccounted legacy deployment,
insufficient capacity, occupied fixed port, disallowed provider, region, or
plan, and policy resource or server-count violation. A valid result reports the
selected node, active plugin version, resource and port plan, human-readable
placement explanation, and any policy warning. It states that no new paid
infrastructure is created by the plan.

The HTTP operation is `POST
/v1/organizations/{organization}/game-servers/plan`. It returns a plan and does
not require an idempotency key because it writes no state. The generated client
uses the same request and response schemas. The create-server route remains a
501 capability gate.

The migration also defines commit-time fences for the future create
reservation. Those fences re-read policy, plugin, node, allocation, catalog,
health, capacity, deployment, and port facts. They are not invoked by the
read-only plan route.

## Consequences

A plan is safe to preview and can become stale immediately after it is returned.
It is not a reservation, an invoice, an operation, or evidence that a server is
running. A future create request must re-plan and pass the atomic D1 fences.

Planning fails closed until reviewed plugin-channel data, fresh node runtime
capacity, complete allocation data, current provider catalog data, and capacity
records for existing deployments exist. Existing deployments without capacity
reservations require an explicit backfill.

Server creation remains unavailable. A production create route requires a
composed Workflow that can consume the pending reservation, execute fixed
provider and agent operations, reconcile uncertain results, release failed
reservations, and report only authoritative observed state.

## Verification

Tests must prove strict request decoding, Operator authorization, organization
isolation, read-only HTTP behavior, active plugin-version selection, policy and
resource enforcement, stale health and catalog rejection, fixed-port conflict,
capacity accounting, deterministic placement, OpenAPI publication, and
generated-client decoding. SQLite tests must apply migration 0013 and preserve
the exact transaction fences. Create-server HTTP tests must continue to return
501 until the Workflow gate is removed by a later accepted decision.

# ADR 0027: Fail-closed game disk quota

- Status: Superseded
- Date: 2026-08-23
- Extends: ADR 0004
- Superseded by: ADR 0029

## Context

Every deployment specification has a disk limit. Docker CPU, memory, and process
limits do not enforce a byte limit on an ordinary bind-mounted host directory. A
reported but unenforced disk limit can let one game server consume the node disk
and affect other servers.

## Decision

Gridora treats disk quota as a required enforcement boundary. The node must map the
signed disk limit to a supported filesystem quota mechanism before it changes a
Docker network or container. The node must verify the effective limit after it
applies the quota.

The current runtime has no supported quota adapter. It marks the generated disk
policy as not enforced and rejects Docker apply before any Docker mutation. The
runtime must not replace this rejection with documentation, monitoring, free-space
checks, or best-effort cleanup.

A future quota adapter must bind the quota to the organization and server storage
root. It must reject a foreign, missing, weaker, or unverifiable quota. The adapter
must have behavioral tests on the filesystem used by the promoted node image.

## Consequences

Current game deployment fails closed. This is an explicit live blocker, not an MVP
or production capability. CPU, memory, process, network, mount, and container
security tests remain useful, but they do not prove a deployable game runtime.

A supported project-quota or equivalent adapter can remove the blocker after image
tests prove allocation, restart persistence, resize, release, and exhaustion
behavior.

## Alternatives

We rejected a requested limit in labels only. We rejected periodic directory size
checks. Both options allow the workload to exceed the limit between checks. We
rejected free-space checks as quota enforcement because they do not isolate one
server from another.

## Verification

Run Docker apply without a quota adapter. Confirm rejection before network or
container creation. Install a supported adapter on a test image. Apply the quota,
restart the node, exhaust the limit, resize the limit, and remove the server. Confirm
that another server cannot change or consume the assigned quota.

## Supersession

ADR 0029 keeps the fail-closed rule and supplies a dedicated ext4 project-quota
filesystem and exact readback adapter. This record remains the reason that a
requested Docker disk value alone is not an enforcement proof.

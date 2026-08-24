# ADR 0082: Lease plugin egress and fence failed-node cleanup

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0022, ADR 0050, ADR 0065, ADR 0069, and ADR 0081

## Situation

Steam and approved plugin endpoints require temporary outbound access, while
the default game network is deny-all. A failed node can also make normal stop
and remove commands impossible. Treating either condition as permission for
open egress or invented agent receipts would weaken the security and audit
boundaries.

## Task

Grant only a bounded root-owned egress lease for reviewed plugin destinations.
Allow forced server cleanup only when an exact active rebuild or retirement
inventory proves the node failed, and complete it only after control-plane
resources are physically released.

## Execution

The image creates one fixed Docker bridge and nftables set. The unprivileged
agent asks a root-only socket helper for an exact interface, address, protocol,
port, and TTL tuple. The helper validates bounds, installs an nftables element
with timeout, and supports idempotent release. The game container receives no
host network, privileged mode, or Docker socket.

Normal draft, schedule, validate, clone, update, move, and delete actions use
the declarative and lifecycle repositories. `validate-files` maps to the real
Steam/plugin validation path rather than a synthetic success.

Migration 0062 permits forced cleanup only for a server/deployment on the exact
failed node named by an active rebuild or retirement run. The Workflow records
an authorization receipt, skips unreachable agent stop/remove without creating
fake command receipts, releases ports and DNS, marks the deployment and node
inventory item deleted, and only then completes the lifecycle operation. Exact
retries adopt the receipt; foreign scope is rejected.

## Consequences

Required game distribution access is narrow and time-limited. Failed hardware
can be reconciled without pretending an unreachable agent acted. The local
proof does not establish a production nftables kernel, Steam endpoint, DNS
zone, or failed VPS execution.

## Verification

Image, infrastructure, agent, and security tests verify the bridge, root-only
lease helper, tuple bounds, nftables commands, timeout, and release. Lifecycle
runtime tests drive an accepted forced delete through authorization, port/DNS
cleanup, terminal observation, audit completion, response-loss adoption, and
foreign-node rejection.

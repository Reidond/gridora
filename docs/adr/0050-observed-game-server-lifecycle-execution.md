# ADR 0050: Observed game-server lifecycle execution and isolated plugin jobs

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0004, ADR 0005, ADR 0006, ADR 0009, ADR 0022, ADR 0027, ADR 0029, ADR 0032, ADR 0036, ADR 0042, ADR 0044, and ADR 0049

## Situation

The game lifecycle had authoritative planning and agent observation contracts,
but create, delete, start, stop, restart, update, configuration, and mod
operations were not yet one durable execution boundary. A queued command could
be mistaken for success, a node response could be mistaken for game health,
and an installer process could inherit host control through the agent's Docker
socket or credentials.

## Task

Execute one organization-scoped game operation from an atomic D1 acceptance to
an exact agent command and an authoritative game observation. Preserve replay,
revision, capacity, lease, backup, DNS, and audit evidence. Run SteamCMD,
updates, and mod installers in an isolated digest-pinned container without
host control, and make configuration cutover safe against path substitution.

## Execution

The public mutation contains no deployment identity or workload image. Control
derives the active deployment from tenant D1, resolves the immutable build-time
plugin catalog, validates the exact organization and dedicated reservation,
allocates free TCP/UDP leases, validates the requested DNS name, and gates
Steam credential references by organization and scope. WebCrypto fingerprints
the canonical accepted mutation.

Migration 0017 persists the mutation fence, command delivery/replay state,
append-only observation reductions, and Steam-reference ownership triggers.
The D1 repository writes the operation, desired revision, deployment or
capacity reservation, leases, audit, outbox, and durable Workflow-start facts
atomically. A configuration or mod revision must be proven by the fenced write;
stale zero-row revisions cannot be accepted.

An idempotent replay joins the exact operation and Workflow-start rows. It
returns the persisted actor, current operation state, and current Workflow
state. It does not invent a replay actor or reset a progressed operation to
queued. The no-domain step proves that the exact pending operation owns the
server, the server domain is null, its Workflow is active, and no live DNS row
exists. A missing DNS row alone is not sufficient evidence.

Each Workflow step is organization, server, operation, and step bound. Agent
steps return success only after the exact signed command reaches a terminal
success result, or a durable replay adopts that exact result. Completion then
requires the tenant-scoped observation reduction at the next revision and the
expected running, stopped, or deleted state. A responsive node probe alone is
not game health evidence. Reserve, release, backup, and DNS steps require
persisted evidence; an omitted domain requires an explicit tenant-scoped
no-record proof.

The node agent resolves only the signed build registry. It stages rendered
configuration through no-follow directory descriptors, exclusive temporary
files, fsync, and per-file atomic rename while serializing each server's
writer and installer jobs. The node quota tree supplies fixed direct children;
isolated plugin jobs receive only the reviewed server mounts as UID/GID
10001, a read-only root filesystem, dropped capabilities, no host namespace,
no agent/provider secrets, no Docker socket, bounded resources, and a
digest-pinned executable image. The fixed `gridora-plugin-egress` network is
admitted only with the `gridora-plugin-egress-v1` policy label; the node's
root-owned firewall remains the destination allow-list authority.

Endpoint publication uses the Cloudflare control adapter for ownership-checked
DNS-only A/AAAA records and returns the actual leased host and port values.
Teardown removes only the organization/server-owned record. Isolated job
cleanup is an ensured operation: response loss, timeout, decode failure, or
cancellation attempts to inspect and force-delete only the exact canonical
container, never a foreign same-name container.
Adoption also rejects structured mounts, device cgroup rules, published ports,
restart policies, and other host escalation fields. Checking legacy bind
mounts alone is not an acceptable Docker boundary.

## Consequences

An accepted operation is durable and replayable, and false coordinator success
cannot advance a lifecycle. Cross-tenant placement, lease collisions, stale
revisions, foreign deployment IDs, plugin drift, unauthorized credentials,
foreign DNS, and hostile same-name containers fail closed. A compromised
installer is constrained to the reviewed image, UID, mounts, resources, and
root-provisioned egress policy.

The agent's Docker socket is still a narrow host capability and must remain
accessible only to the fixed adapter. The egress network and nftables lease
service must be provisioned and observed by the promoted node image; a named
Docker network by itself is not proof of destination filtering. Central API
and Worker composition must invoke this step contract and map the canonical
step names before the product can claim a deployed end-to-end lifecycle.

## Verification

Behavior tests cover exact tenant placement, reviewed image derivation,
dedicated reservation, domain and port validation, credential scope,
deployment/server identity binding, D1 atomic fences, observation scope and
revision, command terminal/replay behavior, rejected commands, required
coordinator evidence, optional-domain absence, DNS ownership, quota modes,
isolated container shape, full adoption identity, hostile same-name devices,
secret redaction, symlink rejection, top-level config rendering, and
per-server serialization. Focused control, D1, execution, Docker-runtime,
agent, migration, and Cloudflare-control tests pass locally; the root type
check is clean. Replay tests advance the stored operation and Workflow before
retry. No-domain tests reject a wrong operation, configured domain, and live
DNS row. Hostile Docker tests reject a Docker-socket structured mount, device
rules, port publication, and restart policy. The opt-in repository live Docker
workload-boundary test `tests/security/docker-boundaries.live.test.ts` ran
successfully and cleaned up its container and network. The ensured
timeout/cancellation cleanup path remains live-node release evidence.

Live Docker packet isolation, a prepared quota tree, a promoted digest-pinned
plugin image, deployed API/internal Workflow adapters, and an approved
create-to-observation-and-delete run remain live evidence requirements.

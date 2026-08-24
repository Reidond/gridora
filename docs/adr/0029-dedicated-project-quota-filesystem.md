# ADR 0029: Dedicated project-quota filesystem

- Status: Accepted
- Date: 2026-08-23
- Supersedes: ADR 0027

## Situation

ADR 0027 required the node to reject a game deployment when it could not prove a
disk quota. The promoted Ubuntu image cannot safely enable the ext4 project-quota
feature on a mounted provider root filesystem. A bind-mounted game directory does
not get a byte limit from Docker CPU, memory, or process settings.

## Task

The node must enforce the signed disk limit before Docker changes a network or a
container. The mechanism must work without changing the mounted provider root
filesystem. The node must detect a missing, foreign, weaker, or unverifiable
limit.

## Execution

On first boot, Gridora creates one root-owned backing file under
`/var/lib/gridora`. It uses `fallocate` so the host filesystem reserves the
space. It keeps the larger of 20 percent of the host filesystem or 4 GiB outside
the backing file. It requires at least 4 GiB for the new filesystem.

Gridora creates ext4 with the `quota` and `project` features while the backing
file is offline. On each later boot, it checks the file, checks the ext4 features,
runs `e2fsck -p`, and mounts the file through a loop device with `nodev`, `nosuid`,
and `prjquota`. The mount must exist before the quota socket, Docker operations,
or the agent can start.

A small root service accepts one bounded Unix-socket request. The request contains
only a server ID, a byte limit, and canonical server mount paths. The service
assigns a persistent collision-free project ID. It refuses aggregate reservations
above 90 percent of the dedicated filesystem. It applies the project ID and hard
limit with fixed command paths. It then reads the project ID with `lsattr` and the
hard limit with `repquota` in a fixed CSV format. It returns an enforcement proof
only when both values exactly match the request.

The unprivileged agent accepts only the exact versioned proof. Docker apply stops
before its first Docker API request when the helper refuses the request or the
proof is different.

## Consequences

One server cannot consume another server's reserved disk space. The preallocated
backing file prevents loop-filesystem growth from exhausting the provider root
filesystem. The design reserves host space that cannot be used by other services.
The initial capacity calculation is fixed until an explicit resize procedure is
designed.

This decision provides a local adapter and image template. It does not prove that
a promoted provider image preserves quotas across a real reboot. That proof stays
a release gate.

## Verification

Unit tests must reject unsafe paths, corrupt project-ID state, capacity overflow,
wrong filesystem features, a foreign loop device, missing readback, ambiguous
readback, and a weaker limit. A Linux behavior test must write as the game UID and
observe `EDQUOT`. A promoted-image test must prove first boot, reboot, resize,
release, exhaustion, recovery, and full ordering before this capability is live.

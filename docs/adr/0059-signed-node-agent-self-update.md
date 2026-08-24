# ADR 0059: Signed node-agent self-update and immutable rollback authority

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0003, ADR 0012, ADR 0017, and ADR 0045

## Situation

The node agent needs security updates without giving its unprivileged process
write access to `/usr/local/bin`, a root-owned release path, or a generic root
command channel. A command signature alone is insufficient: a stale but valid
release can be a downgrade, an artifact URL can redirect, a staged path can be
replaced by a symlink, and a restart can succeed just before the caller loses
its response. A failed candidate must not leave a node unavailable or cause a
second activation after a crash.

## Task

Accept a signed, architecture-bound agent release only from a fixed HTTPS
allowlist. Stage it with bounded no-follow filesystem operations. Use a
separate immutable root helper for fixed-path activation, systemd-backed health
probation, exact rollback, durable replay evidence, monotonic anti-downgrade
state, and bounded release retention.

## Execution

`agent.self-update` binds a signed command to the organization, node,
operation, delivery ID, and a separately Ed25519-signed release manifest. The
canonical manifest binds version, release sequence, security epoch,
architecture, HTTPS source, SHA-256, byte size, and exact agent/control-plane
API compatibility. The agent reads only root-owned policy and public-key files,
rejects redirects and non-allowlisted sources, bounds downloads, verifies both
signatures and the digest, and stages only digest-derived filenames in an
agent-owned `0700` directory using no-follow exclusive writes, mode `0600`,
file fsync, rename, and directory fsync.

The agent sends the root helper only an exact digest/version/architecture and
command/operation tuple. It never sends a source URL, shell fragment, or
filesystem path. The image-baked helper re-verifies the staged manifest and
artifact through opened descriptors, copies it to a root-owned release, writes
an activating receipt before changing `current`, and serializes all execution
with an exclusive root lock. It requires repeated `systemctl is-active` checks
and matching fixed health receipts over a bounded probation interval before it
persists active state. A missing receipt after a helper crash is unknown and
rolls back to the exact previous release; an exact receipt adopts success
without another restart.

Packer verifies and atomically seeds the signed baseline release, `current`
link, and root state before enabling the socket. The mutable agent service uses
a root-owned fixed launcher, while setup and the root socket helper always run
the immutable baked `/usr/local/bin/gridora-agent`. Root state persists the
highest accepted signed release sequence and security epoch floor. Only an
internal rollback may select the prior release. Durable completion retains only
the active and previous releases and safely garbage-collects older verified
release directories.

## Consequences

A compromise of the unprivileged agent cannot overwrite a root executable or
turn the helper into a path/command executor. A valid historical release cannot
be activated as a normal update after its sequence or security epoch falls
behind the persisted floor. The release signer still authorizes agent code, so
its key requires the same protected release process as other deployment
signing authority. The immutable helper must remain backward-compatible with
the manifest protocol until a separately reviewed image promotion replaces it.

An activation result can remain pending after response loss rather than being
reported as failed or successful without evidence. Replaying the same signed
command eventually adopts the durable exact outcome. This is local behavior
evidence; it is not a deployed node-image or live update result.

## Verification

Focused local agent tests cover first staging, signature and source binding,
hostile symlink collision, UID/mode evidence, concurrent helper requests,
systemd-active probation, failed-health rollback, post-restart crash adoption,
unknown-outcome rollback without candidate retry, response-loss command replay,
anti-downgrade rejection, and two-release garbage collection. The image
provisioning script validates shell syntax and runs `systemd-analyze verify`
inside the Ubuntu image build. Local commands passed for the agent and protocol
type checks/tests and agent bundle build. The concurrent API type check has
unrelated `GameLifecycleD1Client` and log-monitoring diagnostics, so it is not
claimed as evidence for this ADR. No release key, image build, privileged
service, update socket, or live node update was deployed or invoked.

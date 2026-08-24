# ADR 0044: Crash-safe agent observation publication

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0003, ADR 0017, ADR 0023, ADR 0029, ADR 0033, and ADR 0040

## Situation

The control plane accepts one strict, machine-authenticated node observation at
the next session sequence and node observed revision. The node agent can lose an
HTTP response after D1 commits. The agent can also restart between preparing an
event and receiving its receipt. Retrying a newly sampled payload at the same
cursor would make the result ambiguous. Advancing the cursor without a receipt
would skip evidence.

The event requires the authenticated session version. The existing legacy
credential file contains only a bearer secret. Guessing session version one
would let a stale process claim a current session. Registration also requires
the RSA-OAEP public key owned by the root-only Tunnel credential installer. The
Ed25519 command-signing key has a different role and cannot be reused.

Readiness facts must come from the running node. Constants, desired
configuration, and package-time assumptions are not observations. Some facts,
such as the promoted image checksum and signature result, require signed
image-build evidence with coordinates that the control plane can compare.

## Task

The agent must publish bounded observation events without replaying, skipping,
or inventing a cursor. It must retain an exact event through response loss and
restart. It must refresh a stale uncommitted event only after the server proves
that the event did not commit. It must keep credentials out of observation
state, bodies, errors, and logs. It must leave readiness closed when any
authoritative fact cannot be proved.

## Execution

The registration response adds the credential ID, credential version, and
session version beside the bearer credential. The agent writes those values and
the credential in one root-private JSON file using create-exclusive temporary
file creation, file sync, atomic rename, and directory sync. It still reads a
legacy raw credential file. A legacy file can poll commands, but it cannot emit
observations because it has no authoritative session coordinates.

The one-time registration token remains on disk while the exchange result is
ambiguous. A successful response or an exact server replay first completes the
full authentication-file sync sequence. Only then does the agent unlink the
token and sync the bootstrap directory. It then atomically writes and syncs the
non-secret `/var/lib/gridora/agent/registration-complete` marker. The strict
marker binds organization, node, credential ID, credential version, and session
version, but contains no credential. A restart validates exact marker equality.
It repairs a missing marker after a crash, but rejects a mismatched marker.

A restart with both authentication and a stale token revokes that token through
the authenticated endpoint, unlinks it, syncs the directory, and replaces the
marker. Image cleanup does not remove the token. It waits until the strict
authentication file and completion marker agree with the expected organization
and node and the token is absent before it erases non-secret bootstrap evidence.

Before registration, the unprivileged agent asks the fixed root Tunnel installer
socket for its `rsa-oaep-spki-v1` public key. The agent includes that key in the
registration request. It continues to read the independent Ed25519 public key
only for control-plane command verification.

An Effect service owns publication. A long-lived Effect semaphore serializes the
whole prepare, send, and accept operation in one process. A second semaphore in
the file-state adapter protects individual state transitions. The state file
contains only credential coordinates, the last accepted sequence, the last
observed revision, and an optional pending event. It never contains the bearer
credential.

The agent samples facts before it allocates a new cursor. It then writes the
entire pending event before sending it. A network failure or lost response leaves
that byte-equivalent event pending. Restart reloads and sends the same event. An
exact server replay must compare the credential, session, sequence, observed
revision, and canonical payload fingerprint before returning the stored receipt.

The server performs exact replay adoption before its freshness check. When a
pending event is stale and no exact commit exists, the server probes the durable
cursor. Only a machine-readable `agent_observation_not_committed` response may
authorize the agent to resample facts and time at the same sequence and observed
revision. The HTTP Problem code is `AGENT_OBSERVATION_NOT_COMMITTED`. An
ambiguous network error never authorizes replacement. A second
refresh response fails closed instead of creating an unbounded loop.

An authenticated session rollover resets sequence to one and preserves the last
accepted observed revision. A backwards or inconsistent authentication record
fails closed.

The live probe uses fixed, bounded sources. It reads an image attestation created
only after bootstrap verifies the image-baked signed build identity, plus the
installed image version. This is signed build identity, not a measured-boot
claim. The strict attestation carries the manifest, detached signature, and
public-key SHA-256 coordinates. The emitted image fact carries the same three
coordinates. D1 publishes readiness only when they equal the exact promoted
`node_images.signature` object. That object has schema version one, Ed25519 as
its algorithm, exactly those three digest properties, and no extra properties.
D1 also requires the immutable provision acceptance, provider image mapping,
and exact live TCP and UDP leases to agree with the ready snapshot.

The probe reads cloudflared's loopback readiness endpoint. It uses bounded
Docker Unix-socket calls for engine, storage driver, container privilege, socket
mounts, and restart counts. It reads the exact project-quota mount, `/proc`
network counters, and host capacity.

The unprivileged agent does not execute `nft` and does not receive
`CAP_NET_ADMIN`. It connects without a request body to the fixed root-owned
`/run/gridora/firewall-observation.sock`. The socket-activated helper owns the
only fixed nftables read. It returns a newline-terminated, strictly decoded
proof containing default-deny state, two sorted bounded leased-port arrays, and
the ruleset digest. The client verifies the root-owned non-writable directory,
the root-owned `0660` socket, a 5-second timeout, a 16 KiB body limit, exact JSON
properties, the digest shape, port bounds, sort order, uniqueness, and readiness
consistency. It cannot send a command or argument to the helper.

The probes cap Docker bodies, container count, firewall proof, ports, and
timeouts. If a required source is absent, malformed, unbounded, inaccessible,
or inconsistent, the probe returns no event and the node remains unready.

The command loop attempts one observation before each bounded long poll.
Observation failure does not stop command processing. The log records only a
fixed readiness-closed message. It does not include the event, response body,
credential, environment, or command output.

## Consequences

A process restart or lost receipt cannot silently advance the local cursor. Two
concurrent publisher calls cannot create two payloads at one cursor. Credential
and session rollover remain explicit. The registration exchange now matches the
installer-key contract without conflating cryptographic roles.

Publication can intentionally remain disabled on an upgraded legacy node until
it receives authoritative registration metadata. A node can also remain
bootstrapping when a live probe lacks access to a required source. This is safer
than claiming readiness from desired configuration.

The production image must install `/etc/gridora/image-attestation.json` from the
promoted image evidence and the fixed root firewall observation socket/helper.
Legacy opaque signatures, malformed or extra signature properties, mismatched
build-identity digests, retired images, provider-coordinate drift, and firewall
port drift keep readiness closed and roll back the observation snapshot.
The API maps the typed not-committed result to the documented machine-readable
conflict. Multi-process publication is not supported; systemd must keep one agent
process per node. Cross-process locking is required before that constraint can
change.

## Verification

Behavior tests cover registration payload compatibility, atomic authentication
metadata, token preservation during response loss, token removal and completion
marker after exact replay, marker validation on reboot, legacy fail-closed
behavior, response loss, restart replay, explicit
not-committed refresh, session rollover, concurrent publication, receipt
coordinates, fact-probe failure, and secret canaries. Type checking covers the
strict observation and registration contracts.

The local D1 transaction tests prove exact build-identity comparison, accepted
provider mapping, exact live port leases, and atomic rollback for missing,
extra, or duplicate ports; opaque, missing, extra, malformed, or mismatched
signature evidence; retired images; and provider or acceptance drift.

Local tests do not prove a promoted image attestation on a booted node, live
helper nftables output, a deployed D1 replay fingerprint, a live Tunnel, or a
bearer-authenticated ready transition. Those remain live blockers.

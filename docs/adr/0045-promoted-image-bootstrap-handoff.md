# ADR 0045: Promoted image bootstrap handoff

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0012, ADR 0017, ADR 0023, ADR 0043, and ADR 0044

## Situation

The provider API receives cloud-init before it returns the provider instance ID.
The control plane therefore cannot render a final agent configuration before the
machine exists. User-data also contains one short-lived registration token and
is copied into cloud-init state and logs. The unprivileged agent needs a durable
configuration, the Ed25519 command-verification public key, and the token, but it
must never receive a private signing key, provider credential, Tunnel token, or
an arbitrary metadata endpoint.

The agent must also report the installed image and the active firewall. A boolean
in user-data is not signature proof. Reading nftables directly requires
`CAP_NET_ADMIN`, which also authorizes mutation and is too much authority for the
agent.

## Task

The promoted image must turn one immutable, bounded reservation into the exact
agent files. It must derive the provider instance ID from a provider-owned local
fact, reject malformed or conflicting facts, preserve registration retries, and
erase extra token copies only after a durable handoff. It must publish a strict
firewall observation without giving the agent a mutation capability. Bootstrap
retries and reboots must not create a second identity or weaken file ownership.

## Execution

Cloud-init writes only `/var/lib/gridora/bootstrap/reservation.json` as
`root:root` mode `0600`. The JSON has 18 exact fields: schema version,
organization, node, operation, provider type, provider image ID, Gridora image
ID, image version, immutable image checksum, control-plane URL and host policy,
agent version, Docker socket, poll interval, registration expiry and token, and
the Ed25519 public-key PEM. The checksum comes from immutable provision
acceptance. A public request or generic runtime setting cannot override it.

`gridora-node-bootstrap.service` runs as root after `cloud-final.service`. The
helper rejects excess fields, oversized files, symlinks, malformed identifiers,
expired tokens, non-HTTPS origins, non-Ed25519 keys, and an image version that
does not equal `/etc/gridora/image-version`. It never contacts a metadata URL.
It reads cloud-init's cached, standardized `v1.instance_id`, and it requires the
same value in `/var/lib/cloud/data/instance-id`. OVHcloud requires an OpenStack
or ConfigDrive fact and a UUID instance ID. Contabo accepts only the documented
cloud-init datasource set and a positive decimal API instance ID. A provider
whose promoted image does not expose those exact facts remains fail-closed.

The helper atomically writes and syncs `/etc/gridora/agent.json`, the Ed25519
public key, `/etc/gridora/image-attestation.json`, the agent-owned one-time token,
and a non-secret completion record. The image attestation has the exact accepted
Gridora image ID, version, and `sha256` checksum. Before setting
`signatureVerified: true`, it verifies a strict baked build-identity manifest
and detached Ed25519 signature with the baked public key. The signed manifest
pins the source commit, image version, architecture, and the agent, cloudflared,
Node.js, Traefik, and Ubuntu input checksums. Provisioning verifies those values
before installing the manifest, signature, and public key root-owned and
read-only. None comes from cloud-init or user-data. The helper re-verifies the
signature and matches the signed version to the reservation. This proves
reviewed build identity; it is not hardware measurement of the running disk.
The local attestation carries SHA-256 coordinates for the exact baked manifest,
detached signature, and public key. The image workflow publishes the same three
digests and artifacts in promotion evidence. Its canonical signature object has
exactly schema version one, algorithm `ed25519`, and the three named SHA-256
coordinates; it accepts no extra field. Server-side readiness also fences
those coordinates, the final post-Packer artifact checksum, provider-image
mapping, signature evidence, and promotion status in D1.

The bootstrap oneshot does not synchronously start its ordered dependent.
Packer enables the bootstrap, agent, and cleanup units. Systemd starts the agent
only after the bootstrap oneshot exits, avoiding a dependency deadlock. The
post-agent cleanup unit retries until the exact agent authentication file is
durable and the dedicated token is absent. Only the agent removes that token
after it writes authentication and syncs the parent directory. Cleanup strictly
matches the authentication organization and node to the non-secret handoff,
then erases the root reservation and cloud-init user-data, sensitive instance
data, and logs. This preserves an ambiguous registration retry.

The bootstrap directory remains agent-owned mode `0700` because the current
agent must unlink its own token. That narrow authority can cause self-denial of
service after compromise, but cannot replace root-owned `/etc/gridora` files or
the sticky control-plane identity. Moving deletion to a fixed root broker can
supersede this tradeoff.

The agent receives no `CAP_NET_ADMIN`. A root-owned, socket-activated helper
accepts no request bytes or arguments and runs only
`nft --json list table inet gridora`. It bounds the command, document, ports,
time, memory, and response. It normalizes and matches the whole table to the
fixed table, set, chain, hook, priority, policy, and rule graph. An extra chain,
set, hook, rule, broad accept, or anonymous rule fails closed. It returns one strict newline-terminated proof with
the input and forward default-deny result, the two exact leased-port sets, and a
ruleset checksum. The socket is `root:gridora-agent` mode `0660` under a
root-owned mode `0755` directory. Invalid or ambiguous nftables output closes
without a partial proof.

## Consequences

Provider identity is not selected by user-data, and the agent receives only the
public signing key. A crash before atomic handoff keeps the root reservation for
retry. A crash after handoff can adopt the synced completion. Cloud-init no
longer starts the agent or deletes its token inline. The agent cannot mutate the
firewall through the observation interface.

This is signed build-identity evidence, not hardware-measured runtime
attestation, a promoted result, or a live provider result. Contabo's
numeric standardized instance ID, OVHcloud's OpenStack identity, systemd
ordering, final artifact promotion, server-side image revalidation, and the full
registration lifetime still require disposable live-node verification.

## Verification

Behavior tests execute the root helper inside an isolated root. They cover the
exact OVHcloud identity, strict files and modes, command-key rejection, wrong
build identity, wrong identity key, invalid identity signature, conflicting and
malformed IDs, symlink refusal, atomic retry, delayed registration, token
preservation, cache cleanup, and the systemd ordering graph. Separate behavior tests execute the
fixed firewall helper with representative nftables JSON and reject missing,
invalid, or unbounded leased sets. Image build validation must also run
`bash -n`, ShellCheck, and `systemd-analyze verify` in Linux. No test in this
record is live provider or image-promotion evidence.

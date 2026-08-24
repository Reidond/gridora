# Node image contract

Build the image only from reviewed inputs. Supply an Ubuntu ISO URL and its
SHA-256 checksum. The image workflow downloads fixed Node.js, cloudflared, and
Traefik versions. It checks every digest before Packer sends a file to the guest.
Packer checks each transferred digest again before installation.

Do not put a provider, Tunnel, Steam, backup, RCON, or machine credential in the
image. Cloud-init accepts one bounded, root-owned reservation with a short-lived
agent registration token and the Ed25519 command-signing public key. It never
accepts a private signing key or Tunnel token. `gridora-node-bootstrap.service`
derives the provider instance ID only from cloud-init's cached standardized
instance data, checks it against cloud-init's cached instance ID, validates the
promoted image version, and atomically writes the agent files. It also writes a
root-owned image attestation from the immutable accepted image ID, version, and
checksum. It sets `signatureVerified` true only after it verifies the baked,
strict build-identity manifest with its baked Ed25519 public key and matches the
signed version to the reservation. This proves the reviewed build identity, not
hardware measurement of the running disk. Server-side readiness also matches
the final post-Packer artifact checksum and promotion status in D1. The `cloudflared` unit stays stopped until the root tunnel
installer decrypts a node-bound envelope. The installer writes
`/var/lib/gridora/tunnel/credential` as `root:root` with mode `0600`. The unit uses
systemd `LoadCredential` to copy the token into its private credential directory.
The unprivileged agent only relays the sealed envelope through the restricted
installer socket.

The agent has no `CAP_NET_ADMIN`. It observes only the exact `inet gridora`
table through `/run/gridora/firewall-observation.sock`. The socket starts a
root-owned helper with one fixed nftables read command. The helper accepts no
arguments or request body and returns one bounded JSON firewall fact. Its
capability cannot be used by the agent for firewall mutations.

The bootstrap helper exits after it syncs the handoff, and systemd then starts
the ordered agent. The agent durably writes authentication, removes its own
registration token, syncs the directory, and atomically writes the strict
`registration-complete` marker. A path unit then validates the marker and
authentication coordinates before it removes the root reservation and
cloud-init's cached user-data, sensitive datasource state, and logs. It disables
cloud-init for later boots so the provider cannot repopulate the cache.

The token file remains after a successful secure delivery. This lets systemd
start the Tunnel again after a reboot. A revoke command stops `cloudflared`,
removes the local token, and records the new revision. The control plane must
also invalidate the remote Cloudflare token.

## Signed agent update and rollback runbook

The node image seeds a verified baseline agent release before it enables the
agent service. Packer receives three reviewed, public inputs in addition to the
agent artifact: a root-owned update policy, the Ed25519 release-signing public
key, and a signed baseline manifest. It verifies the manifest's canonical
signature, exact artifact SHA-256 and byte length, architecture, API
compatibility, release sequence, security epoch, and policy-approved HTTPS
host. It then atomically initializes:

- `/var/lib/gridora/agent-updates/releases/<sha256>/gridora-agent` and its
  signed `release.json`, owned by `root:root`;
- the root-owned `current` link and `root-state.json` high-water record;
- agent-owned `staged` and `health` directories (both `0700`).

Do not enable the update socket on an image without that baseline. The regular
agent runs through the immutable `gridora-agent-current` launcher, which only
executes the fixed root-owned `current` target. The update socket and setup
units instead run the image-baked `/usr/local/bin/gridora-agent` helper; a
signed mutable agent artifact never becomes a root helper executable.

For every update, the control plane signs an `agent.self-update` command and
the release signer independently signs a manifest containing the version,
architecture, HTTPS source, digest, byte size, API compatibility, release
sequence, and security epoch. The agent verifies both signatures, the static
host allowlist, compatibility, size, digest, and no-follow staging metadata.
It sends the root helper only the digest-bound fixed activation request—never a
path, URL, or shell fragment.

The helper serializes activation, copies the verified staged artifact into a
root-owned release, persists an activating record, atomically replaces
`current`, restarts the fixed service, and requires continuous systemd-active
and exact agent-health receipts through probation. A failed or unknown
probation rolls back to the exact previous release and restarts it. If a
response is lost after a restart, retry the identical signed command: the root
state and health receipt adopt the exact outcome without repeating activation.
Only an internal rollback may move to the prior release; new releases must
strictly exceed the persisted signed release sequence and meet the persisted
security epoch floor. After durable completion, only active and previous
releases are retained.

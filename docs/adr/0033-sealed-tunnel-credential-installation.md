# ADR 0033: Sealed Tunnel credential installation

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0017, ADR 0020, and ADR 0023

## Situation

The control plane must deliver a long-lived Cloudflare Tunnel credential after
node registration. Cloud-init, provider user-data, D1, a Queue, the unprivileged
agent, and agent logs are not plaintext delivery channels. The persistent source
file must be root-owned, but `cloudflared` runs as an unprivileged user.

## Task

Gridora must bind one credential to one organization, node, Tunnel, operation,
and revision. Only a small root process can open the credential. Installation,
rotation, response-loss recovery, activation, and revocation must use fixed paths
and fixed commands. An acknowledgement must not contain credential material.

## Execution

The root installer creates one RSA-OAEP-3072 key pair on the node. The private
PKCS8 value stays in a root-owned `0600` file. The public SPKI value can leave the
installer and register with the control plane.

For each delivery, the control plane creates a fresh 32-byte AES key and 96-bit
IV. It encrypts the Tunnel credential with AES-256-GCM. Length-framed
authenticated data contains the format, organization, node, Tunnel, operation,
and revision. RSA-OAEP with SHA-256 wraps the AES key. The signed agent command
contains only the versioned sealed envelope.

The public API accepts only the action and expected prior revision. It derives
the operation and delivery identities from the organization, actor, exact node
and Tunnel route, and idempotency key. Before any token action, the Cloudflare
adapter verifies the exact Tunnel ID, Cloudflare-managed source, and canonical
Gridora resource name. D1 commits the operation, delivery reservation, audit,
and sealed-command outbox state atomically. Queue delivery reloads that
authoritative command before it reaches the node coordinator.

The unprivileged agent relays the sealed envelope over one root-owned Unix socket.
The root service starts from systemd socket file descriptor 3. It accepts only a
bounded strict install, revoke, or public-key request. It opens the private key and
plaintext only inside its process.

For install, the service writes a durable `installing` state, writes only
`/var/lib/gridora/tunnel/credential` through a no-follow exclusive temporary file,
sets root ownership and mode `0600`, calls file and directory `fsync`, and uses an
atomic rename. It then runs fixed `systemctl restart` and `is-active` arguments.
It records `active` only after the health check succeeds.

For revoke, the service records `revoking`, stops the fixed service, verifies that
it is inactive, removes the credential, syncs the directory, and records
`revoked`. Revision and delivery IDs make retries deterministic. A transitional
state resumes the same command after process or response loss.

The `cloudflared` service uses systemd `LoadCredential` to copy the root source
into an ephemeral service credential directory. The connector reads that copy and
does not receive access to the persistent root file.

## Consequences

The unprivileged agent cannot decrypt a captured command. A command for another
node, scope, operation, or revision fails authentication. Plaintext exists only
temporarily in the root installer and in the required root/systemd credential
files. JavaScript string input on the control plane cannot be zeroed, so the API
must not log, retain, or reuse that string.

The local composition includes atomic public-key registration, API sealing,
signed command dispatch, a bounded root installer, systemd units, token rotation,
connection invalidation, acknowledgement, and revoke. A configured Secrets Store
keyring, real Cloudflare Tunnel, promoted-image boot, retire workflow, and live
Tunnel health result remain release gates.

## Verification

Tests must cover different ciphertext for the same credential, cross-node open,
changed authenticated data, ciphertext tamper, wrong key, key-file permissions,
unsafe directories and symlinks, bounded socket input, fixed systemd commands,
atomic file metadata, install and revoke response loss, interrupted transitional
state, revision replay, rotation, token-free acknowledgement, and byte cleanup.
A promoted-node test must prove registration, delivery, reboot reconnect, rotation,
revocation, and absence of public management ports.

# ADR 0038: Atomic node provision acceptance

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0017, ADR 0019, ADR 0032, ADR 0035, and ADR 0037

## Situation

A public node request can cause a paid provider action. The client must not
select a provider account, a provider type, a price, a provider plan ID, an
image ID, or a credential. A policy check alone does not reserve capacity or
spend. Two requests can read the same available values. A provider create can
succeed when its response is lost.

## Task

Gridora must accept one client-safe intent. Gridora must select every paid fact
from authoritative organization data. Gridora must bind one idempotency key to
one exact request. Gridora must commit the node, commercial facts, operation,
Workflow start, audit evidence, and publication evidence as one unit. Gridora
must not report a provider resource before a provider returns an owned result.
Gridora must not store a plaintext bootstrap value.

## Execution

The public intent contains only the placement mode, the temporary lifetime, and
the non-hourly commitment confirmation. The control rejects excess fields. The
control authorizes an Owner or Administrator before it reads a replay.

The control includes the organization, actor, and exact intent in a canonical
SHA-256 fingerprint. The control derives the node, operation, Workflow-start,
audit, outbox, and bootstrap-token record IDs from the organization, actor,
idempotency key, and fingerprint. The same request produces the same IDs.

The repository reads an exact replay before it reads current admission facts.
A replay with the same fingerprint adopts the stored result. A replay with a
different fingerprint fails. An exact replay can succeed after the current
allocation or provider account becomes unavailable. It does not create a new
paid operation.

The D1 facts adapter selects one active provider account from an active
organization allocation. It selects an allowed catalog row and a promoted image
mapping. It decodes the policy, catalog metadata, and provider image mapping with
strict schemas. It computes usage and committed spend in integer currency minor
units. The Effect policy adapter evaluates the current organization policy.

Migration 0012 creates the acceptance receipt, immutable commercial contract,
active spend reservation, and bootstrap-token reservation. The atomic batch
creates the provisioning node, queued operation, pending Workflow-start record,
lifecycle reservation, immutable contract, spend reservation, hashed bootstrap
reservation, audit event, Workflow-start outbox event, and final acceptance
receipt. The final insert trigger re-reads the exact policy revision, provider
account revision, allocation revision and count, catalog price and freshness,
image version and provider mapping, organization usage, and committed spend. A
changed fact aborts the full batch. Concurrent stale snapshots cannot both pass.

Contabo billing cadence, contract months, price, catalog time, and explicit
commitment confirmation are stored in an immutable contract row. A later
catalog refresh cannot rewrite the accepted terms.

The bootstrap secret contract uses a versioned HMAC keyring. It derives the
same short-lived value from the exact organization, node, operation, and token
record coordinates. D1 stores only the key version and SHA-256 token hash. A
provider workflow can rederive the bytes for one use and must clear the bytes.

The provider runtime selects OVHcloud or Contabo only from the authoritative
account type. It strictly decodes the decrypted credential bytes. It accepts
only the fixed provider authentication and API endpoints. It gives credentials
and the immutable accepted commercial terms to one injected provider transport.
It rejects a changed account revision before the transport runs. It clears the
decrypted input bytes after success, failure, or interruption. It accepts a
provider result only when the organization, node, operation, region, plan,
name, and image version match the reservation.

The provider request starts only after the D1 commit. The operation ID remains
the provider adoption key and the Workflow instance ID. An uncertain create
uses `adopt_only`. It does not derive a second identity or send a blind second
paid create.

## Consequences

The client cannot substitute a cheaper policy estimate with a different paid
provider request. A denial leaves no operation. A stale acceptance leaves no
partial node, audit, or outbox row. An exact HTTP retry does not repeat current
admission and does not create a second operation.

The acceptance transaction does not prove that a provider credential works. It
does not prove that a provider created a server. It does not make the public API
route available. API composition must load the provider account and encrypted
envelope from the accepted receipt. Workflow composition must rederive the
bootstrap bytes, inject only the fixed provider transport, persist the provider
instance result, and reconcile an uncertain create. Production still needs live
credentials, a promoted provider image, a D1 deployment, a Workflow binding,
and a cleanup run with an approved TTL.

## Verification

Tests must cover strict client intent, deterministic identity, key rotation,
exact replay before current admission, changed-fingerprint conflict, denial
without an operation, response-loss reconciliation, tenant scope, policy and
revision fences, catalog and image fences, concurrent capacity acceptance,
immutable Contabo terms, strict stored receipt decoding, exact Workflow-start
updates, fixed provider dispatch, endpoint substitution, provider ownership
mismatch, adopt-only forwarding, and plaintext byte cleanup after failure and
interruption. SQLite tests must prove transaction rollback. Mock transports do
not count as live provider evidence.

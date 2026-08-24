# ADR 0039: Use bounded read-only provider discovery for orphan reconciliation

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0019, ADR 0020, ADR 0034, ADR 0037, and ADR 0038

## Situation

A provider can contain a Gridora-labeled VPS that D1 does not contain. A lost
provider response can also make a valid VPS look unknown to the control plane.
Automatic deletion would turn an observation error into data loss and a billing
incident.

Provider credentials are encrypted. Provider list responses are untrusted.
Organizations, provider accounts, and provider types are security boundaries.
Operation history can contain many actions for one node. It cannot define the
provider ownership identity by itself.

## Task

Gridora must discover owned provider nodes without receiving a provider mutation
capability. Gridora must bind discovery to one active tenant allocation and one
encrypted provider account. Gridora must reject ambiguous, stale, malformed,
foreign, or unbounded observations. Gridora must preserve an exact committed
result after response loss. Gridora must never delete a provider resource during
orphan reconciliation.

## Execution

The runtime MUST verify the active identity, membership, allocation,
organization, provider account, and provider type in D1 before provider
discovery starts.

The runtime MUST open an organization account from its exact tenant envelope.
It MUST open a platform account only through an injected encrypted platform
secret port keyed by the exact account ID and provider type. The D1 allocation
MUST NOT broaden platform secret access. The runtime MUST clear the plaintext
byte buffer after success, failure, or interruption.

The discovery component MUST accept only a `listNodes` function. It MUST NOT
accept create, update, stop, rebuild, retire, or delete capabilities.

The discovery component MUST use the reviewed OVHcloud or Contabo adapter. It
MUST select the adapter from the authoritative provider-account type. It MUST
reject malformed credentials, unsafe endpoints, malformed nodes, duplicate
provider IDs, foreign ownership, and more than 200 nodes.

The snapshot MUST be complete and untruncated. The runtime MUST NOT treat
absence from a list response as provider-removal evidence.

D1 MUST reject a new snapshot when its observation time is older than or equal
to the last accepted snapshot for the same organization, provider account, and
provider type. Only an exact idempotency replay can reuse that observation time.

Provider ownership MUST use the immutable node provision acceptance operation.
A legacy node without an acceptance can use a successful `node.provision`
operation only when exactly one such operation exists. Other operation history
MUST NOT create authority. Ambiguous legacy provision history MUST fail closed.

Reconciliation MAY open, update, or resolve a high-severity finding. It MUST
write the finding, audit event, export request, and replay result atomically. It
MUST NOT mutate or delete a provider resource.

## Consequences

Orphan detection is safe to retry after a lost D1 response. A repeated request
returns the committed result. A distinct snapshot with an equal timestamp is
rejected.

Provider inventory above the bound requires a future bounded pagination design.
The platform secret port is an injected contract. The central Worker still must
bind it to an audited encrypted platform secret store. Live execution still
requires approved credentials, deployed migrations, a Secrets Store KEK,
provider connectivity, and a signed internal Workflow or Queue caller.

## Verification

Tests must cover organization, account, and provider rebinding; malformed and
unsafe credentials; malformed, duplicate, foreign, and over-limit provider
responses; fixed OVHcloud and Contabo dispatch; secret-canary exclusion; byte
cleanup after provider failure and interruption; exact replay; D1 response loss;
equal and older observation rejection; unrelated operation history above 200
rows; ambiguous legacy provision history; atomic audit persistence; and the
platform allocation, organization envelope, foreign allocation, and absence of
provider mutation and removal evidence. Mock provider responses do not count as
live provider evidence.

# ADR 0043: Leased node provider execution

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0017, ADR 0019, ADR 0020, ADR 0032, ADR 0037, and ADR 0038

## Situation

Node provision acceptance commits before Gridora sends a paid provider request.
The accepted record contains immutable provider, image, placement, and commercial
facts. It does not contain a provider instance ID. Gridora must open one exact
credential envelope and send one provider request after that commit.

A provider can create the instance and lose its response. D1 can commit the
provider result and lose its response. An account or credential rotation can
also race the paid request. A Workflow timestamp can be old. Any of these cases
can create an untracked paid resource if execution retries a create or refuses
to record an owned provider result.

## Task

Gridora must execute only one exact accepted reservation. Gridora must prevent
account and credential rotation while a paid request can be in flight. Gridora
must preserve adopt-only recovery. Gridora must materialize the registration
token before the VM can boot without storing its plaintext. Gridora must record provider ownership,
audit evidence, and publication evidence in one transaction. Gridora must not
mark the node ready from a provider response.

## Execution

The internal execution request contains only the organization ID, operation ID,
and attempt time. The service strictly validates the request. It compares the
attempt time with an injected trusted clock. The first execution creates a fresh
registration lifetime from that clock. A retry checks the durable materialized
expiry before it opens a secret and again immediately before the provider call.
A stale, future-skewed, or expired retry makes no provider call.

The service reads an existing completion first. It then loads the exact
`NodeProvisionExecutionReservationPort` coordinates from tenant-scoped D1. It
does not reconstruct commercial facts from a current catalog.

An injected secret-opening port reads the exact provider account and credential
envelope. It opens that exact envelope. It reads the same revisions again before
it returns. The returned account ID, type, scope, organization, status, and
revision must match the accepted reservation. The service clears the credential
byte buffer on success, failure, or interruption.

Migration 0015 adds one durable execution lease and one provisional registration
binding. Before the paid call, the first queued attempt changes the operation to
running, replaces the derivation hash with the delivered-token hash, starts the
fresh registration lifetime, inserts the lease, and inserts an unbound provisional
registration record in one D1 transaction. The lease records the accepted account
revision and opened envelope revision. D1 blocks
account update, account deletion, envelope update, and envelope deletion while
the lease is active. Organization accounts require the exact D1 envelope.
Platform accounts require an exact injected platform-secret implementation and
use the tenant allocation and acceptance as their authorization boundary.

The queued attempt uses `create_or_adopt`. Every running or retrying attempt
requires the same active lease and uses `adopt_only`. It uses the operation ID as
the only provider adoption identity. An empty provider discovery result after an
uncertain create stays uncertain. The retry delay increases from five seconds to
five minutes and does not pass the durable registration deadline. The retry does
not send another paid create. An uncertain provider response keeps the lease
active and changes the operation to retrying. Deadline exhaustion records a
reconciliation-required node condition, audit event, and outbox event. It keeps
the lease active. A definite terminal failure releases the lease in the same
guarded audit and publication transaction. Any failure that lacks proof of
provider absence keeps the lease active for explicit orphan reconciliation.
Gridora does not unlock rotation by assuming that no resource exists.

The versioned registration-token service rederives the exact accepted bytes. The
executor encodes those bytes as a deterministic lowercase hexadecimal token for
the agent file and hashes the UTF-8 token. The pre-call transaction stores only
that hash. An early token-authenticated registration may bind the first provider
instance ID and insert the existing `node_registration_tokens` row. Otherwise,
the provider-result transaction performs the same bind. Provider completion must
exact-match an earlier bind. D1 never stores the token.

Cloud-init writes only one root-owned mode `0600` immutable reservation manifest.
The manifest contains the accepted image ID, provider image ID, version, and
promoted checksum plus trusted control-plane, agent, Docker, polling, expiry, and
Ed25519 public-key inputs. It contains no private signing key and no Tunnel token.
It does not synchronously start the bootstrap service: the promoted image enables
the service and orders it after `cloud-final`. The image helper derives the
provider instance ID from allowlisted cached instance data before it writes the
final agent configuration. The executor clears token and cloud-init byte buffers
on success, failure, or interruption. JavaScript and provider APIs use immutable
strings at their boundary; Gridora does not persist or log those strings.

The executor gives `ProviderCreateRuntime` the immutable accepted provider
image and commercial terms. The runtime selects OVHcloud or Contabo from the
authoritative account type. It accepts only a provider result with the exact
Gridora organization, node, operation, name, region, plan, and image metadata.

One D1 transaction sets or exact-matches the first provider instance ID, keeps
desired state at `provisioning`, sets observed state to `provisioning` at observed
revision zero, ensures exactly one matching registration-token row, changes the operation to
`waiting_external`, writes immutable audit and outbox evidence, and releases the
execution lease. The transaction stores no provider address, credential,
bootstrap token, or cloud-init document. It keeps the pending lifecycle
operation. Authenticated agent, image, Tunnel, firewall, Docker, quota, and
capacity observations own the later ready transition and final operation
completion.

The completion read verifies the node, operation, token, registration row, and
outbox payload. A lost D1 response adopts that exact completion. A different
provider instance ID conflicts. A provider-result transaction failure rolls back
all of its writes, keeps the already materialized registration reservation and
provisional binding, keeps the operation running, and keeps the execution lease
active for adopt-only recovery.

## Consequences

Account or credential rotation cannot strand an in-flight organization-provider
create. A retry cannot issue a second paid create. A provider result does not
claim node readiness. The registration exchange receives a hash for the exact
text written to the image. Audit and Queue data remain secret-free.

An active unresolved lease intentionally blocks account rotation. An operator or
orphan reconciler must prove adoption or cleanup before a future release path can
unlock it. A platform secret backend enforces the same lease through the shared
D1 lease guard.

The public create-node route accepts only the strict product intent. It does not
accept provider selection facts or credential facts. The central Worker composes
the D1 reservation port, trusted clock, exact organization or platform secret
port, registration-token keyring, fixed cloud-init renderer, provider runtime,
and D1 execution repository. The signed Workflow runs one exact provision step.
It retries uncertain work only through `adopt_only`. It does not select a
Workflow, provider, account, image, or operation from an arbitrary request.

The registration exchange uses one D1 transaction for provisional provider bind,
token consumption, credential and session issuance, installer state, audit, and
outbox evidence. A lost response can replay only the exact committed result.

Production still needs migration 0015 deployment, reviewed provider credentials,
a promoted image that implements the ADR 0045 helper contract, and a deployed
signed Workflow route. Production also needs a tested bootstrap lifetime, agent
and Tunnel readiness composition, orphan resolution, temporary-node expiry,
provider cleanup, and one approved live create-and-delete run. Local route and
Workflow composition is not live provider evidence.

## Verification

Behavioral tests cover strict public intent, exact Workflow metadata, exact
provider facts, platform and organization account scope, wrong account revisions,
foreign provider ownership, immutable Contabo terms, provider response loss, D1
response loss, adopt-only replay, delayed provider visibility, recovery deadline
exhaustion, rotation blocking, lease release after exact completion, delayed
attempts after bootstrap expiry, transaction rollback, registration response
loss, token expiry, wrong-provider bind, concurrent exchange, secret canaries,
and byte cleanup after failure and interruption. SQLite tests apply migrations
0001 through 0016. Mock provider transports are not live provider evidence.

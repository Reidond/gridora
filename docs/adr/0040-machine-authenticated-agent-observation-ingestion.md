# ADR 0040: Machine-authenticated agent observation ingestion

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0002, ADR 0003, ADR 0017, ADR 0022, ADR 0027, ADR 0029, and ADR 0036

## Situation

The placement planner reads `node_runtime_capacity`. An untrusted or stale
agent report must not make a node eligible for placement. A raw telemetry log
can grow without a bound. A raw log can also contain command output,
environment data, or secrets. The current registration protocol authenticates
the agent with a random bearer credential over HTTPS. It stores the credential
hash. It does not register a signing public key. The installer RSA-OAEP key is
an encryption key. It is not an agent event signing key.

## Task

Gridora must accept one strict observation for one organization, node,
credential, and agent session version. Gridora must return the original receipt
for an exact replay and reject foreign, changed, out-of-order, oversized, and incomplete observations. Gridora must
publish capacity only when every readiness fact is current and tenant-bound.
Gridora must store fixed current aggregates. Gridora must not store raw logs or
secrets. Gridora must use the authentication system that the agent can execute.

## Execution

The route authenticates the HTTPS request with the existing node bearer
credential. The database adapter receives the resulting
`AgentCredentialPrincipal`. The wire body does not contain a credential,
signature, public key, or invented session ID. The control compares the body
organization, node, and session version with the authenticated principal.
Credential ID and credential version come only from the principal.

The body uses `agent.gridora.dev/v1alpha1`. The schema rejects excess fields.
The schema limits identifiers, versions, port counts, integers, and the total
canonical body size. The control accepts a report at most two minutes old and
at most thirty seconds in the future. The control rejects usage that exceeds
reported capacity.

The control computes a SHA-256 fingerprint over the canonical strict event. The
stream cursor stores only that fingerprint and the original secret-free
receipt fields. It does not store a second event body. Before freshness
validation, the repository compares the organization, node, credential ID and
version, session version, sequence, observed revision, and fingerprint with the
current cursor. An exact match returns the original receipt without a write.
A match at the same cursor with different coordinates or facts fails.

A stale non-replay does not receive an ambiguous freshness error. D1 must first
prove that the active machine credential and session are at exactly the prior
sequence and observed revision. The control then returns the typed
`agent_observation_not_committed` result. The emitter may refresh time and facts
at that same next cursor. A missing first-event cursor is allowed only when the
node observed revision is exactly one less. An advanced or different cursor
fails as a conflict.

One event contains the agent, promoted image, Tunnel, Docker, firewall,
capacity, and bounded metrics facts. It contains no log line, command output,
environment variable, arbitrary label, or arbitrary metric name. The seven
aggregate rows replace the prior seven rows for the node. The storage bound is
seven rows per node and 4096 JSON characters per row.

Migration 0014 creates one stream cursor per node and seven fixed aggregate
slots. The D1 batch writes the seven aggregates, updates or withdraws runtime
capacity, updates the node observation, and advances the stream cursor. The
final stream write is the transaction fence. A rejected fence rolls back every
earlier statement.

The first stream report must use sequence one. A report in the same session
must use the next sequence. A new authenticated session version must be exactly
one greater and resets the sequence to one. Every newly accepted report
advances the node observed revision by exactly one. An exact replay does not
advance it. A skipped sequence, a skipped revision, an old session, a revoked
credential, or a foreign coordinate aborts the transaction. A batch conflict
or lost D1 response causes one post-conflict replay read, so a concurrent
identical event adopts the committed receipt.

The readiness fence checks the active credential and connected agent session.
It checks the promoted node image ID, version, checksum, and verified build
identity. The promoted signature is one exact schema-one Ed25519 JSON object.
It contains only the manifest, detached-signature, and public-key SHA-256
coordinates beside its schema and algorithm. Each reported coordinate must
equal the stored coordinate. Opaque, malformed, missing, extra, or mismatched
signature evidence fails the transaction. The accepted provider and provider
image mapping must still match the node and image.

The fence checks the authoritative tenant Tunnel row. It requires `overlay2`,
project quota, zero privileged containers, no Docker socket mount, and a
default-deny firewall. The reported TCP and UDP arrays must each equal the
current non-released port leases without missing, extra, or duplicate ports. It
publishes `node_runtime_capacity` only when every check succeeds. A fully ready report
for an ordinary provisioning row remains bootstrapping without capacity. When
the exact node provision acceptance has a provider instance, materialized
bootstrap token, consumed registration token, active credential and session,
provider-created evidence, and a waiting-external provision operation, the
same atomic batch records ready audit and outbox evidence, completes the
operation, changes desired and observed state to ready, advances the desired
revision, clears the pending operation, and publishes capacity. It does not
touch the provider execution lease, which provider-result commit already
released. A failed readiness fact withdraws existing runtime capacity and sets
the node to bootstrapping or degraded. The planner therefore fails closed.

The reported agent version is a bounded observation. Registration records the
initial version, but the current protocol has no authenticated version-upgrade
mutation. The readiness fence does not compare a later report with that
immutable initial string. Credential and session versions remain authoritative.

The exact route composition is:

1. Register `POST /v1/agent/events` with `apiEffectHandler`.
2. Call the existing `agentCredential(context)` before parsing or using facts.
3. Parse the JSON body with the existing bounded request parser.
4. Call `AgentObservationControl.ingest(principal, body)`.
5. Map validation to the existing request-validation problem, scope failure to
   the existing authorization problem, conflict to the existing conflict
   problem, and D1 failure to the existing persistence problem.
6. Return the secret-free receipt with status 200.

The API runtime must provide `AgentObservationClock`,
`AgentObservationRepository`, and `AgentObservationControl`. The repository is
`makeAgentObservationRepositoryD1(context.env.DB)`. The existing
`AgentCredentialPrincipal` is structurally compatible with the control input.

## Consequences

The planner cannot use a partially ready or stale node report. A database
caller cannot publish ready capacity without the active tenant session, image,
Tunnel, Docker, and firewall facts. Storage use does not grow with event count.
The API does not claim end-to-end body signatures that the current agent cannot
produce.

Bearer authentication depends on TLS and secure credential storage. A future
message-signing design requires a separate signing key pair, registration of
the public key, agent signer code, rotation, revocation, and canonicalization
compatibility. The RSA-OAEP installer key must not be reused for that purpose.

The central API composes the control and bearer-authenticated route locally.
The OpenAPI contract exports the strict body and secret-free receipt. The
executable node agent publishes the body with its authenticated session
coordinates and crash-safe cursor state. No live D1 migration, authenticated
agent event, Tunnel, Docker, firewall, capacity, or planner eligibility result
is recorded.

## Verification

Tests must prove strict decoding, principal compatibility, exact replay without
writes, response-loss adoption, concurrent duplicate adoption, stale committed
replay, D1-proven stale non-commit, changed-payload rejection, exact sequence
and observed-revision fences, cross-tenant rejection, readiness publication,
provisioning without ownership evidence, accepted-provider-registration
completion, readiness withdrawal, authoritative Tunnel failure, agent upgrade
reporting, session rollover, bounded aggregate replacement, exact promoted
signature coordinates, exact live TCP and UDP leases, and full transaction
rollback. API contract tests prove the exported route and machine-authentication
boundary. Agent tests prove executable strict-body publication.
Mocked bearer authentication and SQLite transactions do not count as a live
agent or deployed D1 result.

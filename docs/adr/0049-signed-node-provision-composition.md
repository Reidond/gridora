# ADR 0049: Compose signed node provision execution

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0032, ADR 0038, ADR 0043, ADR 0045, ADR 0046, and ADR 0048

## Situation

Gridora had separate contracts for node acceptance, provider execution,
registration, and platform credentials. The central Worker did not connect all
of these contracts. A public request could not safely reach the exact accepted
provider operation.

## Task

Connect the public node intent to one accepted and signed provider execution.
Keep platform authority separate from organization authority. Use one atomic
registration exchange. Do not expose a credential. Do not send a second paid
create after an uncertain provider result.

## Execution

The public route accepts `CreateNodeIntent`. The intent contains the schema
version, placement mode, temporary lifetime, and non-hourly commitment
confirmation. It does not contain a provider, account, region, plan, image,
price, credential, or client-selected name. Effect Schema rejects unknown fields.

Organization authorization permits an Owner or Administrator. The node provision
control selects the accepted policy, account, allocation, image, commercial
terms, node ID, operation ID, and Workflow ID. One D1 transaction writes the
acceptance, node, operation, reservation, audit event, outbox event, and Workflow
start record.

The central Worker starts only the deterministic provision Workflow. A response
loss can adopt an existing Workflow only when its immutable metadata and durable
start ledger are exact. The Workflow sends one signed internal step named
`create-or-adopt-instance`. The internal route verifies the signature, Workflow
name, instance ID, operation ID, node ID, organization ID, step name, and step
ordinal.

The execution service opens the exact accepted organization or platform
credential revision. The opener verifies the account after it opens the secret.
It clears plaintext bytes on every failure. It transfers the bytes only after
all checks pass. Platform Administrator route authorization does not use an
organization membership.

The execution service renders the fixed cloud-init manifest and selects the real
OVHcloud or Contabo transport from the accepted account type. A first attempt can
send one paid create. Every later attempt is adopt-only. Empty provider discovery
after an uncertain create stays uncertain. A durable attempt number sets an
increasing retry delay. The retry schedule does not pass the durable registration
deadline. Deadline exhaustion keeps the lease active and records
reconciliation-required audit and outbox evidence.

The early agent registration path uses one D1 transaction. The transaction binds
the provisional provider instance ID, consumes the token, issues the credential,
session, and installer state, and writes audit and outbox evidence. Exact replay
after response loss returns the committed result. Expired, foreign-provider,
wrong-node, wrong-operation, and concurrent conflicts fail closed. Responses do
not contain provider credentials.

The generated client and CLI use the same strict public node intent. The CLI
requires an idempotency key. It does not accept provider selection facts.

## Consequences

One public request can reach one accepted provider execution without trusting
provider selection from the client. A Workflow retry cannot send a second paid
create. A provider response does not mark the node ready. Authenticated agent
observations still own readiness.

An unresolved uncertain create keeps its lease. This can block account rotation.
An operator or the read-only orphan reconciler must prove the provider state
before a later cleanup path can release the lease.

Local composition does not prove a deployed Workflow, provider credential,
promoted image, agent registration, Tunnel readiness, or provider cleanup.

## Verification

Route tests reject provider fields and accept the strict intent. Workflow tests
prove exact metadata adoption and reject wrong metadata. Credential tests prove
plaintext cleanup after a post-open read failure. Provider tests prove one paid
POST, multiple empty adopt-only polls, delayed adoption, bounded deadline
handling, and no second POST. D1 tests prove atomic registration replay, expiry,
wrong-provider rejection, and concurrency. API, Workflow, generated-client, CLI,
provider, and D1 type checks and focused tests pass locally.

Production verification still requires deployed migrations and secrets, a
promoted image, a signed Workflow run, one approved live create-and-delete run,
bootstrap and Tunnel evidence, and cleanup reconciliation.

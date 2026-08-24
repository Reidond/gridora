# ADR 0056: Automation identities and one-time credentials

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0014, ADR 0018, ADR 0020, and ADR 0021

## Situation

An unattended CI job or external integration needs organization-scoped access.
It must not reuse a human Access session or gain human organization authority.
A bearer credential can be copied, replayed, logged, or used after its owner
is removed. A delayed administrator role change can also allow a stale request
to create, rotate, or revoke a credential.

## Task

Add revocable automation identities with high-entropy, one-time credentials.
Limit each identity to explicit non-administrative scopes. Require an active
Owner or Administrator for credential management. Preserve exact revision,
idempotency, audit, and outbox evidence for every write.

## Execution

Migration 0022 stores an organization-scoped identity, its credential hash,
expiry, state, scopes, last-use metadata, and durable mutation receipts. The
plain credential is generated with high entropy and is returned only for a new
credential or rotation. The database and normal API lists keep only redacted
credential evidence. They do not retain the plain credential or expose its
hash through the API.

The authenticator hashes a presented credential and compares it in constant
time. It rechecks the organization, identity, credential, creator, and
membership state before it grants a machine principal. It applies bounded
rate-limit and replay behavior and records last use without placing a secret
in logs, audit records, outbox records, or responses that list identities.

The scope map is explicit and default-deny. It permits selected inventory,
server, node, backup, log, and operation actions only. It does not permit an
organization role change, policy change, wildcard scope, or destructive
administration. An automation credential is a separate machine principal; it
cannot become a human Access identity or increase a human role.

Create, rotate, and revoke use an atomic D1 receipt that binds the
organization, actor, expected revision, idempotency key, audit record, and
outbox record. The final D1 fence checks that the organization is active and
that the actor still has an active Owner or Administrator membership, including
the expected membership revision when supplied. A demotion after authorization
therefore rejects the mutation. Revocation is checked again during credential
authentication and use, so it takes effect immediately.

The HTTP route and auth adapters remain separate from human Cloudflare Access
authentication. They are not yet registered in the central API composition.
The later composition root must select the D1 layer and retain this separation.

## Consequences

An organization can use narrowly scoped credentials without sharing a human
session. A lost create or rotate response can adopt only the same durable
receipt, and a stale, forged-tenant, disabled-organization, expired, revoked,
or demoted-actor request fails closed. Credential material is available only
at the one safe return point and cannot be recovered from ordinary data or
logs.

This decision does not deploy a route, D1 migration, Access policy, or
credential. It also does not add a CLI, web screen, generated client, or a
live secret store integration.

## Verification

Focused control, authentication, and D1 tests cover forged tenant input,
stale rotate and revoke requests, response loss and exact replay, disabled
organizations, immediate revocation, a demotion between authorization and the
final D1 write, scope denial, rate limits, and secret redaction. The focused
package type checks and tests pass locally. No D1 migration, Worker route,
Cloudflare Access policy, or production credential was deployed or exercised.

# ADR 0047: Access-authenticated existing-identity invitation acceptance

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0014, ADR 0016, ADR 0021, and ADR 0026

## Situation

Gridora already accepts a first invitation during the signed authentication
intent flow. That flow can create an identity and a membership atomically, so it
is required for a new user. The product contract also defines
`POST /v1/invitations/:token/actions/accept` so an existing Gridora identity can
add another organization membership without creating another identity.

The route token is a bearer capability. Accepting it without Cloudflare Access,
using an email supplied by the request, accepting a token from the body, or
returning a replay as success would weaken the existing invitation transaction.
The plaintext token must not be persisted or included in application logs or
responses.

## Task

Implement the explicit acceptance route for an already Access-authenticated,
active local identity. Require the current authenticated email, the persisted
identity email, and the invitation email to match. Reuse the existing
organization service and D1 unit of work so expiry, revocation, prior acceptance,
membership conflicts, audit, outbox, and concurrent acceptance keep one
authoritative behavior. Preserve the separate authentication-intent completion
path for users without a local identity.

## Execution

The shared API middleware verifies the Cloudflare Access assertion and CSRF
origin before the route runs. The central composition resolves the active local
identity by Access subject, decodes the current Access email, and rejects a
mismatch with the persisted identity email. The route accepts one lowercase
64-character hexadecimal token from the path only. It reads no request body and
declares no idempotency header.

The route passes the authenticated identity and path token directly to
`OrganizationService.acceptInvitation`. The service hashes the token and checks
the pending invitation, expiry, revocation, prior acceptance, and normalized
invitation email. The existing D1 unit of work inserts the membership, consumes
the invitation, and writes audit and outbox evidence atomically. A duplicate or
losing concurrent request remains an invitation rejection; the HTTP adapter
does not synthesize a successful replay.

The success response contains only the strict organization-membership contract
and carries private `no-store`, `no-cache`, and no-referrer controls. The
OpenAPI document publishes the exact path-token bounds and no request body. The
generated client URL-encodes the path component and sends browser credentials,
but it does not copy the token into a body, idempotency header, or result.

## Consequences

An existing identity can add a second organization membership through the
product route without entering organization setup or creating another identity.
A new or unknown identity still cannot mutate membership through this route and
must complete the one-time authentication intent. Email changes that have not
been reconciled between Access and the local identity fail closed.

The route intentionally has no generic mutation idempotency key. The invitation
token and atomic consume are the one-time operation boundary, and preserving an
`accepted` rejection prevents an expired or revoked capability from becoming a
false replay success. The token remains present in the product-mandated URL.
Gridora therefore disables Cloudflare's automatic API invocation logs so the
raw request URL is not persisted; application-owned structured logs remain
enabled and recursively redact secret-shaped fields.

## Verification

Route tests prove that only the path token reaches the service, malformed tokens
fail before lookup, an unknown local identity cannot mutate membership, all five
invitation rejection classes remain errors, and successful responses expose no
token and are not cacheable. A centrally composed Access and SQLite-D1 test
accepts an existing identity once and rejects the replay. Contract tests prove
the strict OpenAPI path schema, absent body, absent idempotency header, and
removal from unsupported boundaries. Generated-client tests prove the exact
credentialed POST without a body or idempotency key. Existing D1 tests continue
to cover concurrent acceptance, rollback, audit, outbox, and identity atomicity.
An infrastructure security test pins `observability.logs.invocation_logs` to
`false` for the API Worker.

These are local tests. No deployed Access policy, production log-retention
inspection, live D1 transaction, invitation email link, browser session, or
multi-organization switch after acceptance is recorded.

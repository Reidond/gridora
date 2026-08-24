# ADR 0041: Tenant-bound organization realtime authorization

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0001, ADR 0002, ADR 0013, and ADR 0017

## Situation

An organization event stream can disclose operations, membership changes, node
state, and game-server state. A browser WebSocket cannot rely on a route slug,
an unverified query parameter, or an earlier dashboard authorization. A valid
Access session can also outlive a changed or revoked organization membership.
Forwarding the Access assertion or browser cookies into a Durable Object would
unnecessarily widen the credential boundary.

## Task

Gridora must authorize a browser twice: when it requests a realtime ticket and
when it upgrades the WebSocket. The ticket must name one organization, actor,
membership revision, audience, and resource. The upgrade must reach only the
Durable Object for that resolved organization. A ticket must be short-lived and
must not be reusable. Realtime delivery must not introduce polling.

## Execution

The API route module requires an injected authorization function that validates
Cloudflare Access, resolves the organization route parameter, and reads the
current active Viewer-or-higher membership. The authorization result includes
the canonical organization ID, actor identity ID, and membership revision.

`POST /v1/organizations/:organization/events/ticket` signs an existing
`RealtimeTicketClaims` value with the configured realtime HMAC secret. It fixes
the audience to `console`, the resource type to `organization`, the resource ID
to the canonical organization ID, the machine ID to null, and `sessionVersion`
to the current membership revision. Expiry is exactly 60 seconds after issuance
and the nonce is a random version-4 UUID. The response is private and `no-store`.

`GET /v1/organizations/:organization/events` invokes the authorization function
again for a WebSocket upgrade. It rejects a non-upgrade request, duplicate or
extra query parameters, a malformed or expired ticket, a foreign organization,
a different actor, and a changed membership revision before it resolves a
Durable Object. It selects only `${organizationId}:events`, initializes that
object with the same canonical organization ID, and forwards a new internal
request containing only the WebSocket upgrade header and the ticket. It does not
forward an Access JWT, cookies, browser headers, or unrelated query values.

`OrganizationEventsDO` remains the final ticket verifier. Its SQL nonce primary
key consumes a valid ticket once. The API returns the Durable Object upgrade
response directly so the WebSocket pair is not lost by response reconstruction.
The event path does not add a polling fallback.

## Consequences

A route slug and resource ID are never sufficient authority. Membership changes
invalidate older tickets because the upgrade compares the signed revision with
the current membership revision. Organization A cannot select or initialize
organization B's coordinator through this route. Access credentials stay at the
API boundary.

The central API registers the route with the shared Access and membership
repositories. OpenAPI and the generated client expose ticket issue and exact
WebSocket URL construction. The web shell opens the organization-bound socket,
invalidates only caches named by a validated event, obtains a new one-time
ticket after bounded exponential reconnect delay, and closes the old socket
when organization context changes. A live claim still requires a deployed
`REALTIME_TICKET_SECRET`, the `ORGANIZATION_EVENTS` binding, and a browser
WebSocket run against the deployed route.

## Verification

Route tests decode a real signed ticket and assert the organization, actor,
console audience, organization resource, membership revision, 60-second expiry,
and unique nonce. They prove Access and tenant denial, second authorization on
upgrade, exact Durable Object naming and initialization, sanitized forwarding,
changed-revision and expired-ticket denial, ambiguous-query denial, replay
rejection at the coordinator boundary, and secret canaries absent from errors
and forwarded headers. The route test uses a behavioral coordinator port that
consumes one nonce and returns the coordinator's generic replay rejection. The
existing workerd test proves Durable Object tenant partitioning. API contract,
generated-client, and browser-service tests prove the composed paths, strict
URL construction, scoped invalidation, reconnect, and organization-switch
cleanup. A deployed browser upgrade and replay attempt remain required live
evidence.

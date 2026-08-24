# ADR 0073: Use one multi-domain Access application for browser composition

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0007, ADR 0014, and ADR 0021

## Situation

The console makes credentialed browser requests to a separate API hostname.
Cloudflare Access issues one application cookie for each protected domain. Two
independent Access applications do not establish the API-domain cookie when a
user signs in to the console. The first SPA request can therefore fail before it
reaches Gridora.

## Task

Establish the console and API application cookies in one login flow. Keep the
public authentication-intent path and machine and internal protocols outside the
human login redirect. Keep origin authentication fail closed.

## Execution

Define one self-hosted Access application with the concrete console and API
hostnames as public destinations. Use the new-application eager cookie behavior.
Use one audience for API JWT validation. Keep bounded credentialed CORS on the
same application. Keep more-specific bypass applications for authentication
intents, agent traffic, and internal HMAC traffic. The Worker still authenticates
every bypassed protocol.

Enable Managed OAuth and dynamic loopback registration on the multi-domain
application. Do not create a second API application. Do not import an older
application as production evidence unless an operator first proves eager cookie
behavior with a clean browser profile.

## Consequences

One Access policy and one audience protect both human browser destinations. A
console login can establish the API cookie before the SPA calls the API. A policy
change affects both destinations and needs one review. A future split requires a
same-origin proxy or linked-token design and a new decision.

## Verification

Terraform provider schema inspection confirms public `destinations` support in
the pinned provider. A focused infrastructure test requires one multi-domain
application and both hostnames. Terraform format, validation, and the default
zero-resource plan pass locally. No Access application, cookie, domain, or policy
was created or changed. Live eager-cookie browser verification remains blocked.

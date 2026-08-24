# ADR 0055: Use the open registration default and truthful slug validation

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0014, ADR 0031, and ADR 0047

## Situation

The product specification makes open registration the default. The checked API
and infrastructure configurations used invitation-only registration instead.
The organization setup page also described a locally valid slug as available,
although only the server and D1 can prove that the slug is unique.

## Task

Use the specified open registration default without removing the protected
invitation-only and closed modes. Describe local slug validation truthfully.
Keep the server-side policy and the atomic D1 organization-and-Owner write as
the authority for every setup request.

## Execution

The API and infrastructure configuration defaults use `open`. The runtime still
decodes `open`, `invitation-only`, and `closed`, rejects an invalid value, and
allows an operator to select a protected mode explicitly.

The setup page checks only the slug syntax before submission. Its helper text
states that availability is checked when the form is submitted. The setup API
then applies the current registration policy and uses the D1 unique constraint
and atomic organization-and-Owner transaction as the final authority.

## Consequences

A new checked deployment follows the product default. An operator can still
disable public registration without changing application code. The browser no
longer claims to have evidence that it does not have. A concurrent slug conflict
is reported from the authoritative server write.

## Verification

Local web tests cover the helper text. Registration policy unit and HTTP tests
cover all three modes and invalid configuration. The checked Worker and
infrastructure configuration files use the open default. No Worker, Access
policy, or D1 migration was deployed, and no live concurrent setup run was
performed.

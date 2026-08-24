# ADR 0011: Contabo cancellation and secure wipe

- Status: Accepted
- Date: 2026-08-23

## Context

Contabo cancellation can outlive instance retirement. The state must stay clear.

## Decision

Contabo retirement and billing cancellation are separate states. Gridora stops
placement, optionally backs up, revokes credentials, wipes Gridora data when the
provider permits, submits cancellation, and records the effective contract date.

## Consequences

The UI never promises immediate billing termination. Failed wipe or cancellation
creates operator work and preserves evidence without exposing secrets.

## Alternatives

We rejected one `deleted` state. It would hide billing obligations. We rejected
automatic forced wipe after an ambiguous response.

## Verification

Test each capability response. Check UI text and audit state for effective dates.

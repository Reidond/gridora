# ADR 0002: D1 canonical state and Durable Object coordination

- Status: Accepted
- Date: 2026-08-23

## Context

D1 supports relational queries. Durable Objects serialize contested updates.
Two canonical stores would create conflict.

## Decision

D1 is the canonical relational record. Durable Objects serialize contested node,
operation, and organization-event activity but store only coordination state that
can be rebuilt. Every DO name includes the organization and resource identifier.

## Consequences

DO recovery reconciles from D1. A successful mutation writes canonical state and
an outbox event atomically before acknowledging. DO storage is never queried as a
cross-organization index.

## Alternatives

We rejected Durable Objects as the canonical database. Cross-resource queries
would become complex. We rejected D1 without coordination. Port races would remain.

## Verification

Force a DO restart. Rebuild its state from D1. Run concurrent port lease tests.

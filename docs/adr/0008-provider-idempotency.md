# ADR 0008: Provider idempotency and orphan adoption

- Status: Accepted
- Date: 2026-08-23

## Context

A provider can create a server and lose the response. A blind retry can double cost.

## Decision

Every create operation carries immutable Gridora operation, organization, and node
metadata. After an ambiguous response, the Workflow discovers by that metadata
before retrying create. Reconciliation reports unknown managed instances as
high-severity orphans and never deletes them automatically.

## Consequences

Provider drivers expose discovery and normalized ambiguity. Contract tests inject
lost responses and require exactly one adopted instance.

## Alternatives

We rejected retry-only logic. It can create duplicates. We rejected automatic orphan
deletion. An orphan can contain active customer data.

## Verification

Drop each create response after provider success. Require one discovered instance.

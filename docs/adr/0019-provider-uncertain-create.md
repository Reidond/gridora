# ADR 0019: Provider uncertain-create state

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008

## Context

A provider can accept a paid instance create and lose the response. Its list API can
remain stale after the create. One empty list result is not proof that no instance
exists.

## Decision

Gridora sends at most one create for one operation. After a lost response, the driver
polls for exact organization and operation ownership metadata. If the resource is
still not visible, the driver returns a durable `adopt_only` uncertain state. A retry
can discover and adopt, but it cannot send another create. Ambiguous matches fail.

## Consequences

An uncertain operation can wait for reconciliation. It does not silently create a
second paid resource. An operator can inspect ambiguity before cleanup.

## Alternatives

We rejected immediate create after one empty list. Provider inventory can be
eventually consistent. We rejected automatic deletion of duplicates.

## Verification

Make create succeed and lose its response. Return several stale empty lists. Confirm
one create only, then adopt the exact instance when it becomes visible.

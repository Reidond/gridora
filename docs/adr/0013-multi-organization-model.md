# ADR 0013: Multi-organization isolation model

- Status: Accepted
- Date: 2026-08-23

## Context

One identity can join several organizations. A resource ID does not identify its tenant.

## Decision

Identity is global; membership and role belong to an organization. Organization
context is explicit in route, service input, repository method, SQL predicate,
DO name, queue partition, R2 key, provider metadata, and node credential. A node
belongs to exactly one organization.

## Consequences

Resource IDs alone never grant access. Cross-tenant denial is non-disclosing and
adversarial tests cover APIs, streams, caches, operations, and timing. Final Owner
mutations use serialized or transactional enforcement.

## Alternatives

We rejected implicit current-organization state. It can cross request boundaries.
We rejected shared nodes across organizations. They increase isolation risk.

## Verification

Run the full cross-organization matrix. Race two final Owner mutations.

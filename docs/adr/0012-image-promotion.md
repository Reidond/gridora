# ADR 0012: Node image promotion and rollback

- Status: Accepted
- Date: 2026-08-23

## Context

A broken node image can block every new server. Provider regions use different IDs.

## Decision

Images progress from immutable build artifact to scanned candidate, disposable
smoke test, and explicitly promoted provider image. Promotion requires checksum,
SBOM, signature, test evidence, and the prior image ID.

## Consequences

Provider-region mappings are versioned. A failed rollout stops new placement and
reverts the promoted mapping; existing nodes are drained or rebuilt, never
silently mutated in place.

## Alternatives

We rejected mutable image tags. They prevent exact rollback. We rejected promotion
from a build result without smoke evidence.

## Verification

Validate the signed manifest. Boot a disposable node. Roll back the region mapping.

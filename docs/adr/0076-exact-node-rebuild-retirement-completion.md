# ADR 0076: Complete node rebuild and retirement with exact terminal evidence

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0052, ADR 0058, ADR 0064, and ADR 0065

## Situation

Node rebuild and retirement cross a paid provider boundary and can outlive the
HTTP request that accepted them. A successful provider response is not enough
to prove that the exact accepted operation completed, and retrying an ambiguous
provider mutation can rebuild or retire the wrong instance.

## Task

Bind every rebuild and retirement to an immutable provider, credential,
allocation, instance, image, request, actor, and organization snapshot. Adopt
ambiguous physical effects and finish with one canonical terminal operation and
version 1 audit envelope.

## Execution

The acceptance repository freezes the provider account and allocation
revisions, credential-envelope revision, provider instance identity, and, for a
rebuild, the promoted custom-image registration. Migration 0044 rejects an
incomplete or mutable binding. Migration 0058 binds the rebuilt agent bootstrap
and observation to that accepted image and operation.

Provider execution uses the operation-scoped effect ledger. A retry observes or
adopts the same physical effect; it does not issue an unbounded second mutation.
The runtime waits for exact retirement or rebuilt-agent evidence before it
marks the operation terminal. `rebuildNode` and `retireNode` then write the
canonical node target, request provenance, result, and completion state through
the strict audit path.

## Consequences

A terminal success means the exact accepted provider action and required node
observation completed. Missing custom-image, stale account/allocation,
credential drift, foreign instance evidence, or uncertain provider state fails
closed. This local composition does not prove a live paid-provider action.

## Verification

Node lifecycle D1, provider runtime, Workflow, cancellation, audit inventory,
and migration tests cover drift rejection, response-loss adoption, rebuild
bootstrap provenance, retirement truth, and terminal envelopes. Package checks
and the focused runtime tests pass locally without a provider call.

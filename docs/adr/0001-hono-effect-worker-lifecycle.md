# ADR 0001: Hono and Effect lifecycle on Workers

- Status: Accepted
- Date: 2026-08-23

## Context

Workers can reuse module state. Request state must not leak between requests.
Hono and Effect need one clear runtime boundary.

## Decision

Hono owns HTTP routing and extraction only. Each request is decoded with Effect
Schema, supplied to a request-scoped Effect program, and run exactly once at the
Worker entrypoint. Long-lived Layers may be memoized only when they contain no
request or organization state. Background work is passed to a Queue or Workflow;
bounded post-response work uses `ctx.waitUntil`.

## Consequences

Domain services remain portable and typed errors map to one error envelope.
Tests must prove interruption, finalizer execution, and absence of cross-request
state. Effect runtimes must never be started inside repositories or plugins.

## Alternatives

We rejected Hono domain handlers. They would split service behavior across layers.
We rejected one Effect runtime per repository call. It would break composition.

## Verification

Run bridge tests with concurrent organizations. Check finalizers after interruption.

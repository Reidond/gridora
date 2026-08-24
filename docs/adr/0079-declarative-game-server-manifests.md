# ADR 0079: Use immutable declarative game-server manifests and one-shot schedules

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0036, ADR 0042, ADR 0050, and ADR 0072

## Situation

Users need to validate, export, save, schedule, clone, and apply a desired game
server definition. A client-supplied deployment, provider account, image, or
resolved placement would bypass authoritative planning. A scheduled create can
also be delivered more than once or lose its dispatch response.

## Task

Define one versioned desired-state manifest that contains only public intent.
Persist drafts immutably, schedule a draft once, and resolve all provider,
image, catalog, placement, and deployment facts on the server.

## Execution

`GameServer` `v1alpha1` carries organization, name, optional existing server
identity, plugin, resources, placement intent, endpoint, update/backup policy,
configuration, and mods. Effect Schema validates the wire contract. Export is
reconstructed from D1 desired state; internal revisions and resolved provider
facts never enter the public document.

Draft creation writes an immutable canonical manifest with a strict terminal
operation and version 1 audit envelope. One draft can receive one accepted
schedule. The Queue consumer claims due schedules with a lease, derives the
fixed `scheduled-game:<schedule-id>` idempotency key, and dispatches through a
signed internal route using the organization automation membership. An exact
retry adopts the same schedule and server-provision operation.

Clone reads the source desired state on the server, stores its provenance, and
submits a new authoritative server plan. Apply of an existing server is
revision-fenced. CLI and web accept manifest files but cannot select a provider,
image, deployment, or secret.

## Consequences

The document is portable desired intent, not an infrastructure snapshot.
Validation is side-effect free; draft, schedule, clone, and apply mutations are
audited and idempotent. Production scheduling still requires deployed Queue,
Workflow, D1, Access, and internal-signing configuration.

## Verification

Manifest control/D1 tests prove canonical round trips, cross-payload replay
denial, draft and schedule response-loss adoption, and one-shot scheduling.
Queue tests prove exact dispatch adoption. API, generated client, CLI, and web
checks cover validate, export, draft, schedule, clone, plan, and apply surfaces.

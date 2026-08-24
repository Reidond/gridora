# ADR 0072: Compose no-fit server deployment through one durable parent plan

- Status: Accepted
- Date: 2026-08-23
- Updated: 2026-08-24
- Extends: ADR 0021, ADR 0032, ADR 0035, ADR 0036, ADR 0038, ADR 0049, ADR 0050, ADR 0051, ADR 0052, ADR 0064, and ADR 0069

## Situation

A game-server request can have no organization-owned ready node that fits its
reviewed plugin contract. Returning a client-selected provider, image, node, or
an HTTP-only `501` would either bypass policy or lose the durable relationship
between paid infrastructure, capacity readiness, game deployment, and recovery.
The console and CLI also need one declarative input that maps to the exact
server planning and game deployment contracts. A local billing checkbox alone
is not a policy input and cannot safely authorize a non-hourly provider offer.
A preview also cannot authorize an apply if a mutable provider catalogue, price,
or selection changes between those two requests.

## Task

Accept a no-fit deployment as one organization-scoped, idempotent parent
operation. Report the authoritative provider, region, plan, billing, DNS, mod,
backup, and downtime implications before acceptance. Reuse the existing node
provision and game lifecycle controls, wait for authoritative node readiness,
and compensate only a temporary node created by this parent when deployment
fails. Preserve complete v1 audit evidence and response-loss adoption.

## Execution

`ServerCreateIntent` is the canonical plan input and is paired with
`GameCreateIntent` in `ServerApplyIntent`. The CLI manifest and web adapter
produce these exact contracts. The core web form uses plugin capabilities and a
schema-decoded configuration/mod document; it does not contain game-name,
provider, image, or node-selection branches. Its non-hourly acknowledgement is
part of the canonical server intent. Legacy v1 payloads decode to an explicit
`false` acknowledgement rather than silently accepting a commitment.

When the existing D1 planner reports no capacity, the read-only preview derives
the provider account, allocation, catalog, image mapping, region, plan, and
commercial terms from authoritative node-provision facts. It invokes the same
policy admission as node provision, so an Owner or Administrator must provide
the required non-hourly acknowledgement before a plan that can create paid
infrastructure is accepted. The returned plan names the actual selected
provider, region, plan, pricing and operational implications; it never accepts
those values from the client. The console requests an acknowledgement only for
a reviewed monthly or contract offer that policy marks as requiring it. Its
review shows the exact billing cadence and term; an hourly offer needs no
commercial acknowledgement.

For a no-fit apply, `reviewNodeProvision` produces one exact internal snapshot
of the reviewed account and account revision, allocation revision and limits,
catalog freshness and validity, image mapping and checksum, policy and usage
(including the observation timestamp), price receipt, and billing receipt.
Its `selectionDigest` intentionally excludes only the usage sampling clock.
Migration 0042 stores that snapshot in immutable `plan_json` and decodes it
strictly for the parent Workflow. Public plan and apply responses project the
snapshot and digest away. The Workflow calls node control's internal
`submitAccepted(command, reviewed)` adapter, which recomputes the digest,
checks an idempotent replay before mutable reads, and validates the exact facts
without ranking or substituting another account, region, plan, catalog item, or
image. A fact, billing, or plugin-channel drift is rejected rather than
silently replanned.

For a policy-required, non-hourly commercial offer, preview also returns a
64-hex opaque HMAC proof. Its signed canonical scope binds the schema version,
organization, actor, role and membership revision; server name, plugin,
placement, and resources; exact plugin channel; provider, region, plan,
currency, price, cadence, term, and committed totals; the private reviewed
selection digest; and the catalogue-validity expiry. The API-only
`SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET` is a distinct 32-byte-or-longer
runtime secret. It is never placed in configuration examples, client code,
Workflow input, audit, or D1. Apply rebuilds the current authoritative review,
checks expiry, and uses Web Crypto HMAC verification to compare the opaque
proof. A malformed, altered, cross-organization, cross-actor, expired, or
changed-offer proof returns the dedicated HTTP `409 COMMERCIAL_REVIEW_REQUIRED`
problem rather than selecting a replacement offer. The public envelope never
contains the private snapshot or its digest. Hourly offers receive neither a
commercial proof nor a commercial-consent requirement.

If fresh node-policy admission reports `price_stale` while an apply carries a
commercial proof, the runtime treats that as the same review-required conflict:
the proof cannot authorize an offer that no longer has current pricing. A
first-time preview without a proof remains a truthful `503` because no current
offer can be shown. Other facts, policy, or infrastructure failures remain
their existing availability or validation errors rather than being relabelled
as commercial review conflicts.

Migration 0042 records the durable `server-provision-plan` parent, its exact
accepted node-provision, game-deployment, and optional retirement child IDs.
The acceptance batch writes the queued parent, an accepted terminal companion
operation, strict v1 audit envelope, compact audit event, Workflow start record,
outbox request, immutable request context, intent, plan, and idempotency
fingerprint together. Parent-to-child fences reject foreign organization, node,
or operation links; compensation IDs are immutable once stored.

`ServerProvisionPlanWorkflow` calls the signed internal Worker adapter. It
starts or adopts the canonical node-provision operation with its derived child
key and reviewed snapshot, then waits for node desired and observed readiness
plus fresh agent, Tunnel, Docker, firewall, and capacity evidence. Provider
creation alone is not readiness. Only then does it reserve and deploy the game
through the existing game lifecycle control and wait for its exact terminal
operation. The accepted plugin ID, version, and channel revision constrain the
game catalog at deployment; a changed channel is a failed parent path, not a
new plugin selection.

If any terminal failure, non-completed result, execution error, or bounded
readiness/game-observation timeout occurs after this parent has durably linked
a created node, the parent uses the canonical destructive node-retirement
boundary with the accepted actor, membership revision, correlation, revision
fence, required backup policy, and deterministic parent-scoped idempotency key.
It persists and verifies the exact retirement child before starting or adopting
its Workflow, then waits for terminal evidence. The parent reaches a failed
terminal state only after node-provider, credential, billing, lifecycle,
observation, and operation-bound receipt evidence proves compensation. An
existing selected node never enters this compensation path.

## Consequences

No-fit deployment is no longer a local `501` or a provider mutation hidden in
the server planner. A response loss at parent acceptance, review-bound node
acceptance, game acceptance, retirement acceptance, or Workflow start adopts
the same immutable operation instead of making another paid resource. A pending
provider create, agent registration, capacity report, game observation, or
retirement start is truthful waiting state rather than a false deployment or
cleanup success. Apply responses expose whether the parent Workflow was
`started` or is `pending-reconciliation`; the generated client and console
retain that state.

The console recognizes `COMMERCIAL_REVIEW_REQUIRED` as a stop condition. It
clears the proof and acknowledgement, returns to configuration, and requires
an explicit fresh preview; it never silently resubmits against a changed offer.
CLI manifests may carry only the opaque proof, never reviewed provider facts.
Rotating the dedicated HMAC secret safely invalidates outstanding proofs and
requires a new preview.

The system retains a bounded durable parent run and child linkage for every
automatic plan. This adds migration and Workflow coordination, but keeps
provider mutation solely in node-provision execution and game reservation solely
in game lifecycle. Backup restore clients use schema version 1 and may name a
different server or node; compatibility remains verified at the API boundary.

## Verification

Focused server-plan-control and server-plan-d1 checks and tests pass, including
direct runtime decoding of the internal reviewed snapshot and proof that public
plans exclude it. Server-plan-d1 coverage includes strict parent-plan
decoding, persistence of the observation timestamp/digest, public projection,
strict terminal audit, foreign retirement-child rejection, and
committed-response-loss adoption of the exact compensation link. Node-control
and node-provision D1 focused checks cover review-bound digest replay,
alternate-account rejection, and response-loss adoption before any provider
side effect.

Commercial-review tests prove an unchanged proof accepts while a previewed
offer that changes before apply, a malformed or altered proof, cross-tenant or
cross-actor reuse, and catalogue expiry all fail before durable acceptance. The
Hono effect bridge maps only the typed conflict to `409
COMMERCIAL_REVIEW_REQUIRED`, retains generic conflicts as `CONFLICT`, and does
not expose private reviewed-node evidence. Generated-client, CLI, and web tests
retain the opaque proof where applicable; the web adapter treats only the
dedicated code as a required explicit re-preview.

The API integration test uses the actual D1 preview and node-policy admission
path: it previews a valid monthly offer, changes the authoritative catalogue to
expired, confirms a fresh preview remains `503`, and proves applying the first
proof returns `409 COMMERCIAL_REVIEW_REQUIRED` without an operation or Workflow
start. The web recovery model clears the reviewed plan and acknowledgement and
requires an explicit preview after that public problem.

The parent Workflow check and 29 focused tests pass, including injected
reservation errors, terminal readiness failure, non-completed reservation,
readiness timeout, failed game deployment, and exhausted compensation evidence.
Focused API route/runtime tests pass. Generated-client, CLI, and web checks and
focused tests pass, including `workflowState`, proof forwarding, exact hourly,
monthly, and contract review terms, and fresh-preview handling. Migration check
and 31 tests, the 11-test infrastructure-boundary suite, and Wrangler type
freshness pass. The rendered six-Worker staging configuration, API dry run, and
Workflow dry run enumerate `SERVER_PROVISION_PLAN` without deploying.

No provider account, provider API request, paid node, game server, DNS record,
backup object, Cloudflare Worker, Workflow, Queue, Durable Object, or D1
database was changed. Live proof remains blocked on configured credentials,
explicit deployment approval, and a controlled cleanup reconciliation. This
record claims the focused local evidence above; repository-wide aggregate gates
remain an integration responsibility because concurrent game and backup lanes
continue to change outside this decision.

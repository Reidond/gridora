# ADR 0042: Authoritative game desired-state preview

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0002, ADR 0009, ADR 0032, and ADR 0036

## Situation

A configuration or mod preview can expose secret references. It can also use a
foreign server, a client-selected plugin, stale revisions, or incomplete mod
metadata. A runtime plugin import can bypass build review. A Workshop lookup can
make one preview depend on an external response. A preview must not write a
configuration, reserve an operation, call a provider, or call an agent.

## Task

Gridora must read the server, latest configuration revision, and current mod set
from tenant-scoped D1 queries. Gridora must select the plugin from the server's
stored plugin ID and version. Gridora must use only the reviewed build-time
plugin registry. Gridora must redact all secret values and references. Gridora
must calculate configuration and mod plans without a state write or network
fetch. Gridora must report missing external dependency metadata.

## Execution

The D1 repository uses the organization ID and server ID in one query. The query
selects the maximum stored configuration revision for that tenant and server. It
reads the one current mod-set row when the row exists. It does not run a write
statement. A foreign organization gets the same not-found result as a missing
server.

The control selects the exact `pluginId@pluginVersion` key from the generated
build-time registry. The request cannot select a plugin ID or plugin version. An
unknown key fails closed. A configuration schema-version mismatch also fails
closed. The core control uses the generic plugin control facet and generic
`DesiredMod` values. It does not import an Arma configuration type or an Arma
runtime function.

The configuration read validates the stored configuration with the selected
plugin. It replaces secret and credential values with a redaction marker. It
returns secret-field state without the stored reference. The configuration
preview checks the latest revision. It invokes plugin validation,
normalization, and deployment planning. It returns a redacted normalized
configuration, a redacted diff, and a side-effect-free deployment plan.

The mod plan checks the latest configuration and mod revisions. It accepts only
generic desired mod fields. The selected plugin must declare the `mods`
capability. Arma can return a deterministic offline plan. Valheim fails the
capability check. The Arma result marks versions and dependencies as unresolved
when external dependency metadata is absent. The control does not fetch Steam
or Workshop data.

The HTTP adapter defines these read-only operations:

- `GET /v1/organizations/{organization}/game-servers/{serverId}/config`
- `POST /v1/organizations/{organization}/game-servers/{serverId}/config/plan`
- `POST /v1/organizations/{organization}/game-servers/{serverId}/mods/plan`

A Viewer can read the redacted configuration. An Operator, Administrator, or
Owner can request a preview. The routes require the shared organization
authorization service before they call the control.

## Consequences

A preview is not an applied configuration, a resolved mod set, an operation, or
proof of agent state. External mod metadata can change after the response. A
later apply or sync command must re-read revisions and use an atomic operation
and Workflow boundary.

Configuration apply and mod sync remain unavailable. Their routes must return
501 until a composed agent Workflow can persist an accepted operation, deliver
the desired state, observe the agent result, and reconcile a lost response.

The central API registers these routes. OpenAPI and the generated client expose
the exact read and preview contracts. This composition does not change the
side-effect-free boundary.

## Verification

Tests must use real SQLite behavior. Tests must prove the latest configuration
read, tenant isolation, exact plugin-version selection, strict excess-property
rejection, revision conflict, Arma offline planning, Valheim capability
failure, unresolved external metadata, and zero database writes. Secret canary
tests must scan the full serialized response. A network-fetch spy must remain
unused. API integration and generated-client tests prove Viewer and Operator
authorization and the composed contracts.

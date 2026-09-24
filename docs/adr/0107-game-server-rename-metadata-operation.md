# ADR 0107: Game server rename as a metadata-only durable operation

- Status: Accepted
- Date: 2026-09-24
- Extends: ADR 0021, ADR 0037, ADR 0067, and ADR 0079

## Situation

Manifest planning rejected every `metadata.name` change with "renaming an
existing server is not implemented". A declarative manifest could not converge
on a new display name, so a name change forced delete-and-recreate. The API,
CLI, and web console also had no rename path.

The server name is display metadata. Endpoint, DNS, ports, plugin, placement,
backup keys, R2 keys, and Durable Object names already use the immutable server
ID. `game_servers` already has `UNIQUE (organization_id, name)`.

## Task

Make rename one durable, idempotent, revision-fenced mutation that changes only
the display name. Keep the one-mutation-per-manifest-apply rule. Expose rename
through the manifest apply route, a typed action route, the generated client,
the CLI, and the web server page.

## Execution

Manifest planning emits a `rename` entry when `metadata.name` is the only delta
for a server resolved by `metadata.serverId`. A rename combined with any other
delta is an unsupported plan. A manifest without `metadata.serverId` still
resolves by name, so a new name without a server ID plans a create.

The rename name reuses the create-time `ServerCreateIntent.name` schema: 1 to
96 characters, no control characters, and no leading or trailing whitespace.
The typed route is `POST /v1/organizations/:organization/game-servers/:serverId/actions/rename`
with `{ name, expectedRevision }`, an `Idempotency-Key`, and the Operator role.
It is registered before the `actions/*` 501 fallback.

The D1 repository reads the exact receipt first. An equal key, actor, action,
and SHA-256 fingerprint adopts the original result. A different fingerprint is
an idempotency conflict. A new request fails with a revision conflict when the
desired revision differs or a lifecycle operation is pending, because lifecycle
completion requires `desired_revision = observed_revision`. It fails with a
name conflict when another row in the organization holds the name, including a
deleted row that still reserves it.

One D1 batch writes a terminal `server.manifest.rename` operation, the new
name and next desired revision on `game_servers`, the next desired-spec
revision and source operation without changing `spec_json`, the staged v1 audit
envelope, the compact `game-server.manifest.rename.accepted` audit row, and the
`game_server_manifest_mutations` receipt. Migration 0064 extends the receipt
insert guard to accept exactly the policy pair or the rename pair. If the batch
fails, the repository adopts a committed receipt, maps a winning concurrent
name claim to a name conflict, or maps a changed revision to a revision
conflict.

The API maps a name conflict to HTTP 409 with problem code `NAME_CONFLICT`.
An unchanged name and an invalid name are HTTP 400. The typed route returns the
completed acceptance with `workflowState: not-required`; manifest apply returns
the same acceptance as `kind: rename`.

## Consequences

A rename never starts a Workflow, touches a provider, or changes runtime
configuration. A lost response adopts the original operation. A rename advances
the desired revision, so a client holding the old revision must re-read before
its next mutation. A rename waits until an active lifecycle operation finishes.

Name uniqueness is exact and case-sensitive because it uses the existing D1
constraint. Deleted servers continue to reserve their names.

The CLI command is `gridora servers rename <server> --name <name>
--expected-revision <revision>`, which follows the existing plural `servers`
command group in PRODUCT.md.

## Verification

Control tests cover the rename plan entry, rejected combined deltas, and the
create-time name contract. D1 tests execute the real migrations and cover the
atomic batch, unchanged endpoint, placement, plugin, spec, and backup schedule,
the operation and v1 audit envelope, response-loss adoption, exact replay,
changed-payload, cross-actor, and cross-action key reuse, stale revision,
pending lifecycle fence, same-organization name conflict, other-organization
name reuse, a concurrent UNIQUE-constraint win, an unchanged name, and a
foreign-organization server. Route tests cover the OpenAPI contract, viewer
and foreign-organization denial, cross-tenant server lookup, stale revision,
`NAME_CONFLICT`, invalid names, replay, and manifest rename planning and apply.
Composed API, problem mapping, generated client, and CLI tests cover the
remaining edges. No live Worker, D1 database, or game server was changed.

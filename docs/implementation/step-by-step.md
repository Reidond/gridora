# Implementation record

This record uses Simplified Technical English (STE). Each step names its evidence.
The status `local` means that code and focused local evidence exist. The status
does not mean that a live service used the code. The status `template` means that a
reviewable deployment or image template exists. The status `live-blocked` means
that a required live dependency, approval, or production adapter does not exist.
The status `pending` means that the final repository-wide check is not recorded.

This record describes a public pre-alpha implementation and a live production
Cloudflare control plane. This record does not claim a promoted provider image,
a paid provider deployment, a real Steam or Arma Reforger installation, a sent
invitation email, or a published GitHub production release unless a later step
records that evidence.

Each material step has one `Decision` entry. The entry points to the ADR that
controls the implementation. A procedural step can use an ADR that controls its
release or evidence boundary. The short sentences, active voice, explicit status,
and fixed terms are part of the STE rule for this record.

## Step 1: Record the product contract

- Status: local
- Action: Keep the product contract in the repository.
- Action: Use Gridora as the product, repository, CLI, package, agent, and API name.
- Evidence: `PRODUCT.md`
- Decision: ADR 0001 through ADR 0015 translate the product architecture into
  repository decisions.

## Step 2: Create the public repository

- Status: local
- Action: Create the public GitHub repository.
- Action: Add the MIT license.
- Action: Push initial commit `bbc2d43` to `main`.
- Evidence: `LICENSE`
- Evidence: `https://github.com/Reidond/gridora`
- Decision: ADR 0012 controls later publication and release evidence.

## Step 3: Define the workspace and toolchain

- Status: local
- Action: Define the pnpm workspace.
- Action: Pin Node.js 24, pnpm 11.21.0, Effect 4, and the Vite+ toolchain.
- Action: Define the check, test, build, format, lint, and Worker type commands.
- Evidence: `package.json`
- Evidence: `pnpm-workspace.yaml`
- Evidence: `vite.config.ts`
- Evidence: `tsconfig.base.json`
- Decision: ADR 0001 controls the application runtime and HTTP boundary.

## Step 4: Define organization-safe domain values

- Status: local
- Action: Define branded identity, organization, operation, and resource values.
- Action: Put the organization ID in every tenant key.
- Action: Keep Cloudflare globals out of the domain package.
- Evidence: `packages/domain/src/index.ts`
- Test: `packages/domain/test/tenant-keys.test.ts`
- Decision: ADR 0013.

## Step 5: Define wire contracts

- Status: local
- Action: Use Effect Schema for public API and agent wire data.
- Action: Define organization setup, invitation, mutation, and problem contracts.
- Action: Define signed agent commands with revision and idempotency fields.
- Evidence: `packages/contracts/src/index.ts`
- Evidence: `packages/agent-protocol/src/index.ts`
- Test: `packages/agent-protocol/test/protocol.test.ts`
- Decision: ADR 0001 and ADR 0017.

## Step 6: Define application and repository boundaries

- Status: local
- Action: Define authorization and application services with Effect 4.
- Action: Define tenant-scoped repository contracts.
- Action: Keep SQL in the D1 adapter packages and migration files.
- Evidence: `packages/application/src/index.ts`
- Evidence: `packages/db-contracts/src/index.ts`
- Evidence: `packages/inventory-contracts/src/index.ts`
- Test: `packages/application/test/authorization.test.ts`
- Decision: ADR 0001, ADR 0002, and ADR 0013.

## Step 7: Add the identity and organization schema

- Status: local
- Action: Add identity, organization, membership, invitation, operation, and outbox tables.
- Action: Add revision and idempotency fields.
- Action: Add tenant audit and global identity audit tables.
- Evidence: `packages/migrations/sql/0001_identity_organizations.sql`
- Evidence: `packages/migrations/sql/0002_operations_outbox.sql`
- Test: `packages/migrations/test/schema.test.ts`
- Evidence: `packages/migrations/sql/0030_scheduled_backups.sql`
- Evidence: `apps/api/src/backup-workflow-runtime.ts`
- Evidence: `workers/queue-consumers/src/backup-schedule.ts`
- Test: `workers/queue-consumers/test/backup-schedule.test.ts`
- Decision: ADR 0002, ADR 0013, and ADR 0014.

## Step 8: Add the operations inventory schema

- Status: local
- Action: Add provider account and allocation tables.
- Action: Add node, image, capacity, Tunnel, plugin, server, deployment, port, backup, and secret tables.
- Action: Add organization scope checks and foreign keys.
- Action: Add indexes for reconciliation and inventory reads.
- Evidence: `packages/migrations/sql/0003_mvp_inventory.sql`
- Test: `packages/migrations/test/schema.test.ts`
- Decision: ADR 0002 and ADR 0013.

## Step 9: Implement D1 identity and organization transactions

- Status: local
- Action: Create or update the identity, membership, audit event, and outbox event in atomic D1 batches.
- Action: Reject an idempotency key when its request fingerprint changes.
- Action: Fence membership, invitation, and ownership changes with revisions.
- Action: Prevent removal of the final Owner.
- Evidence: `packages/db-d1/src/index.ts`
- Test: `packages/db-d1/test/idempotency.test.ts`
- Test: `packages/db-d1/test/invitation-identity-atomic.test.ts`
- Test: `packages/db-d1/test/membership-sql.test.ts`
- Decision: ADR 0013, ADR 0014, and ADR 0018.

## Step 10: Implement inventory reads

- Status: local
- Action: Read provider accounts, allocations, images, nodes, servers, backups, operations, and audit events by organization.
- Action: Return no row for a resource in another organization.
- Evidence: `packages/inventory-d1/src/index.ts`
- Test: `packages/inventory-d1/test/inventory.test.ts`
- Test: `apps/api/test/inventory-http.test.ts`
- Decision: ADR 0013.

## Step 11: Validate Cloudflare Access assertions

- Status: local
- Action: Validate the Access issuer, audience, expiry, subject, and email.
- Action: Cache JWKS data for a bounded time.
- Action: Require an active local identity after Access validation.
- Action: Load organization membership before authorization.
- Evidence: `packages/auth-cloudflare-access/src/index.ts`
- Test: `packages/auth-cloudflare-access/test/access-jwt.test.ts`
- Decision: ADR 0007 and ADR 0014.

## Step 12: Protect authentication intent

- Status: local
- Action: Store the complete authentication intent in a Durable Object.
- Action: Give the browser an opaque state value and a verifier cookie.
- Action: Consume the state once.
- Action: Allow only approved local return paths.
- Action: Keep invitation tokens and display names out of the Access URL.
- Evidence: `packages/auth-cloudflare-access/src/intent.ts`
- Evidence: `apps/api/src/index.ts`
- Test: `packages/auth-cloudflare-access/test/intent.test.ts`
- Decision: ADR 0016.

## Step 13: Implement sign-in, sign-up, and invitation acceptance

- Status: local
- Action: Keep sign-in and sign-up as different intents.
- Action: Do not create a local identity during sign-in.
- Action: Create the invited identity and membership in one transaction.
- Action: Match the Access email to the invitation email.
- Action: Reject a replayed or expired intent.
- Evidence: `apps/api/src/index.ts`
- Evidence: `packages/identity/src/index.ts`
- Evidence: `packages/organizations/src/index.ts`
- Test: `apps/api/test/app.test.ts`
- Test: `packages/db-d1/test/invitation-identity-atomic.test.ts`
- Decision: ADR 0014 and ADR 0016.

## Step 14: Implement first organization setup

- Status: local
- Action: Create the organization and initial Owner membership atomically.
- Action: Store the budget threshold in integer minor units.
- Action: Require an ISO currency when a budget threshold exists.
- Action: Create initial Viewer invitations in the same transaction.
- Action: Write audit and outbox events before the transaction returns.
- Evidence: `packages/organizations/src/index.ts`
- Evidence: `packages/db-d1/src/index.ts`
- Test: `packages/db-d1/test/invitation-identity-atomic.test.ts`
- Decision: ADR 0013, ADR 0014, and ADR 0018.

## Step 15: Use versioned deterministic credentials

- Status: local
- Action: Derive invitation tokens and node credentials with HMAC-SHA-256.
- Action: Bind each value to its resource scope.
- Action: Store only the invitation token hash or node credential hash.
- Action: Keep one previous key during an overlap period.
- Action: Reject short, missing, equal, or ambiguous key settings.
- Evidence: `apps/api/src/index.ts`
- Test: `apps/api/test/app.test.ts`
- Decision: ADR 0026.

## Step 16: Implement the HTTP edge

- Status: local
- Action: Use Hono for HTTP routing and extraction only.
- Action: Run one request-scoped Effect program at the Worker boundary.
- Action: Return one structured problem envelope for typed errors.
- Action: Add CORS, return-path, and rate-limit checks.
- Action: Add structured trace fields and recursive secret-field redaction.
- Evidence: `packages/http-hono-effect/src/index.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `packages/observability/src/index.ts`
- Test: `packages/http-hono-effect/test/bridge.test.ts`
- Test: `apps/api/test/app.test.ts`
- Decision: ADR 0001.

## Step 17: Publish the static plugin registry

- Status: local
- Action: Register Arma Reforger and Valheim at build time.
- Action: Publish plugin metadata through read-only API routes.
- Action: Do not load unreviewed runtime code.
- Action: Generate the registry from one reviewed source list.
- Action: Fail verification when generated output is stale.
- Action: Keep concrete game imports inside the registry package.
- Evidence: `apps/api/src/index.ts`
- Evidence: `packages/plugin-registry/registry.sources.json`
- Evidence: `packages/plugin-registry/scripts/generate.mjs`
- Evidence: `plugins/games/arma-reforger/`
- Evidence: `plugins/games/second-reference-game/`
- Test: `packages/plugin-registry/test/registry.test.ts`
- Test: `tests/architecture/dependency-boundaries.test.ts`
- Decision: ADR 0009.

## Step 18: Add organization inventory and team routes

- Status: local
- Action: Add organization-scoped inventory list and get routes.
- Action: Add member role, member removal, ownership transfer, and invitation revocation routes.
- Action: Require role checks and expected revisions.
- Action: Publish an OpenAPI 3.1 document from the Effect Schema route table.
- Action: Provide an organization-aware generated client with response decoding.
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Test: `apps/api/test/inventory-http.test.ts`
- Test: `apps/api/test/app.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Decision: ADR 0013.

## Step 19: Build durable lifecycle acceptance

- Status: local
- Action: Bind each mutation key to the organization, actor, route, resource, and request fingerprint.
- Action: Fence an existing resource with its desired revision.
- Action: Change desired state and create the operation, audit event, start record,
  publication event, and idempotency record in one D1 transaction.
- Action: Reject a second nonterminal operation for the same resource.
- Action: Use the operation ID as the only Workflow instance ID.
- Action: Return `pending-reconciliation` after an uncertain start response.
- Action: Keep create-node and create-server materialization outside this adapter.
- Evidence: `packages/lifecycle-control/src/index.ts`
- Evidence: `packages/lifecycle-d1/src/index.ts`
- Evidence: `packages/lifecycle-workflow-cloudflare/src/index.ts`
- Evidence: `packages/migrations/sql/0006_lifecycle_reservations.sql`
- Test: `packages/lifecycle-control/test/lifecycle-control.test.ts`
- Test: `packages/lifecycle-d1/test/index.test.ts`
- Test: `packages/lifecycle-workflow-cloudflare/test/index.test.ts`
- Decision: ADR 0018, ADR 0021, and ADR 0032.

## Step 20: Keep incomplete workflow capabilities explicit

- Status: live-blocked
- Action: Return an explicit `501` problem for unsupported internal workflow steps.
- Action: Keep public lifecycle routes at authorized `501` while their Workflow
  plans still reach an unsupported internal step.
- Action: Do not report an external resource change when only an operation record exists.
- Action: Keep full node, server, mod, backup, restore, move, and deletion execution blocked until each step has a real adapter.
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Blocker: Most provider and game lifecycle Workflow steps do not have a live control-plane implementation.
- Decision: ADR 0032.

## Step 21: Coordinate contested state with Durable Objects

- Status: local
- Action: Partition node, operation, and organization event coordination by organization and resource.
- Action: Issue short-lived realtime tickets.
- Action: Fence sessions, locks, revisions, and replayed messages.
- Evidence: `workers/realtime/src/index.ts`
- Evidence: `workers/realtime/src/coordinator-invariants.ts`
- Test: `workers/realtime/test/coordinator.test.ts`
- Test: `workers/realtime/test/ticket.test.ts`
- Decision: ADR 0002 and ADR 0013.

## Step 22: Implement agent registration and command transport

- Status: local
- Action: Bind a registration token to the organization, node, provider instance, and operation.
- Action: Bind the node installer's RSA-OAEP-3072 public key and fingerprint to
  the same atomic registration exchange.
- Action: Exchange the registration token atomically.
- Action: Return the same derived node credential after a lost exchange response.
- Action: Add long polling, command results, realtime tickets, locks, and replay checks.
- Evidence: `apps/api/src/index.ts`
- Evidence: `packages/db-d1/src/index.ts`
- Evidence: `packages/agent-protocol/src/index.ts`
- Test: `packages/db-d1/test/agent-outbox.test.ts`
- Test: `apps/api/test/tunnel-delivery.test.ts`
- Test: `apps/agent/test/transport.test.ts`
- Decision: ADR 0017 and ADR 0026.

## Step 23: Implement leased outbox publication

- Status: local
- Action: Claim an outbox row with a worker ID, lease token, and expiry.
- Action: Let only the current lease token mark delivery or failure.
- Action: Reclaim an expired lease.
- Action: Drain more than one page of pending events.
- Action: Use the event ID as the downstream idempotency key.
- Action: Create an immutable audit export request in the audit insert transaction.
- Action: Send the authoritative audit row to its dedicated tenant partition.
- Evidence: `packages/db-d1/src/index.ts`
- Evidence: `workers/queue-consumers/src/index.ts`
- Evidence: `packages/migrations/sql/0007_audit_export_outbox.sql`
- Test: `workers/queue-consumers/test/outbox-publisher.test.ts`
- Test: `packages/migrations/test/audit-export-outbox.test.ts`
- Decision: ADR 0018 and ADR 0034.

## Step 24: Deliver invitation events to the email binding

- Status: template
- Action: Store token derivation scope and key version in the outbox event.
- Action: Do not store the plaintext invitation token in D1 or a Queue payload.
- Action: Rebuild the token only when the Queue Worker builds the message.
- Action: Send text and escaped HTML through a restricted `SendEmail` binding.
- Action: Retry transient service errors.
- Action: Record permanent service errors for remediation.
- Evidence: `workers/queue-consumers/src/invitation-email.ts`
- Evidence: `workers/queue-consumers/wrangler.jsonc`
- Test: `workers/queue-consumers/test/invitation-email.test.ts`
- Decision: ADR 0025 and ADR 0026.

## Step 25: Keep invitation email live delivery blocked

- Status: live-blocked
- Action: Use `invitations@gridora.example` only as a non-live placeholder.
- Action: Require a verified sender domain before deployment.
- Action: Keep old invitation keys for the maximum invitation and outbox lifetime.
- Action: Accept the documented at-least-once duplicate window.
- Action: Show token-free terminal remediation records only to an Owner or
  Administrator in the organization console.
- Action: Do not silently resend or reissue an invitation from a read action.
- Blocker: The Cloudflare account has no configured Email Sending subdomain.
- Evidence: `apps/web/pages/o/[slug]/invitations.vue`
- Evidence: `apps/api/src/index.ts`
- Decision: ADR 0025.

## Step 26: Define durable Workflow plans

- Status: local
- Action: Define plans for organization deletion, node lifecycle, game lifecycle, image registration, backup, restore, move, and orphan reconciliation.
- Action: Persist the current step and resource revision.
- Action: Sign internal Workflow requests.
- Evidence: `workers/workflows/src/index.ts`
- Evidence: `workers/workflows/src/workflow-plan.ts`
- Test: `workers/workflows/test/workflow-plan.test.ts`
- Decision: ADR 0015 and ADR 0018.

## Step 27: Preserve uncertain provider create state

- Status: local
- Action: Send at most one create request for one operation.
- Action: Poll exact ownership metadata after a lost response.
- Action: Use an injected scheduler with bounded backoff.
- Action: Return and persist `adopt_only` with `nextAttemptAt` when discovery stays stale.
- Action: Use durable Workflow sleep before the next adoption attempt.
- Evidence: `packages/provider-sdk/src/index.ts`
- Evidence: `workers/workflows/src/workflow-plan.ts`
- Test: `packages/provider-sdk/src/index.test.ts`
- Test: `workers/workflows/test/workflow-plan.test.ts`
- Decision: ADR 0008 and ADR 0019.

## Step 28: Implement provider adapters

- Status: local
- Action: Implement fixed HTTP operations for OVHcloud Public Cloud and Contabo.
- Action: Normalize authentication, rate-limit, not-found, conflict, and ambiguous errors.
- Action: Bind provider ownership metadata to the organization, operation, and canonical node ID.
- Action: Keep retirement and provider cancellation as different operations.
- Evidence: `packages/provider-ovh-public-cloud/src/`
- Evidence: `packages/provider-contabo/src/`
- Test: `packages/provider-ovh-public-cloud/src/http.test.ts`
- Test: `packages/provider-contabo/src/http.test.ts`
- Test: `tests/provider-contract/provider-contract.test.ts`
- Decision: ADR 0008, ADR 0011, and ADR 0019.

## Step 29: Keep provider use live-blocked

- Status: live-blocked
- Action: Do not run provider calls without explicit approval and a hard TTL.
- Action: Do not claim a node create, adoption, retirement, cancellation, or cleanup.
- Blocker: No approved provider account, provider credential, TTL, or cleanup run exists.
- Evidence: `.github/workflows/provider-contract.yml`
- Decision: ADR 0008, ADR 0011, and ADR 0019.

## Step 30: Implement placement, operation, and policy plans

- Status: local
- Action: Evaluate organization allocation, region, plan, capacity, and placement rules.
- Action: Keep a node in one organization.
- Action: Define idempotent operation steps and compensation boundaries.
- Action: Decode one strict versioned organization policy.
- Action: Fail closed on provider, region, plan, count, resource, price, hard
  budget, backup, contract, commitment, and automatic-update limits.
- Action: Record a soft budget result as a warning, not as an invoice value.
- Action: Keep paid-action admission blocked until the D1 usage and spend
  reservation is atomic with lifecycle acceptance.
- Action: Construct the strict revision-1 policy before organization creation.
- Action: Store the organization and policy in one D1 unit of work.
- Action: Store a setup budget warning only when amount and currency are valid.
- Action: Keep every paid-creation gate closed in the initial policy.
- Action: Export tenant-scoped policy GET and optimistic PUT operations.
- Action: Allow an Administrator to change operational policy.
- Action: Require an Owner for budget and non-hourly commitment changes.
- Action: Use the full v1 policy contract in the generated client and settings page.
- Evidence: `packages/scheduler/src/index.ts`
- Evidence: `packages/orchestration/src/index.ts`
- Evidence: `packages/policy-control/src/index.ts`
- Evidence: `packages/policy-d1/src/index.ts`
- Evidence: `apps/api/src/policy-routes.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Evidence: `apps/web/pages/o/[slug]/settings.vue`
- Test: `packages/scheduler/src/index.test.ts`
- Test: `packages/orchestration/src/index.test.ts`
- Test: `packages/policy-control/test/`
- Test: `packages/policy-d1/test/`
- Test: `apps/api/test/policy-http.test.ts`
- Test: `apps/api/test/policy-routes.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Decision: ADR 0008, ADR 0013, and ADR 0035.

## Step 31: Implement the CLI

- Status: local
- Action: Add authentication, profile, manifest, request, command, and output modules.
- Action: Keep the organization in every organization command path.
- Action: Forward idempotency keys and revision values.
- Action: Store refresh tokens in macOS Keychain or Linux Secret Service.
- Action: Send credentials through process input and never through process arguments.
- Action: Fail closed when the operating system has no supported credential store.
- Action: Validate profile names before a credential-store process starts.
- Evidence: `apps/cli/src/`
- Test: `apps/cli/test/cli.test.ts`
- Test: `apps/cli/test/system-credential-store.test.ts`
- Verification: The CLI typecheck and 32 CLI tests pass locally.
- Blocker: Windows credential storage and packaged-binary smoke tests are not complete.
- Decision: ADR 0007, ADR 0013, ADR 0021, and ADR 0071.

## Step 32: Implement the node agent

- Status: local
- Action: Validate the command signature, organization, node, operation, revision, expiry, and allowed path.
- Action: Persist command state in SQLite.
- Action: Process a duplicate command once.
- Action: Do not send a terminal result for a duplicate command that is still busy.
- Action: Expose only fixed Docker, Steam, backup, and service operations.
- Evidence: `apps/agent/src/`
- Test: `apps/agent/test/agent.test.ts`
- Test: `apps/agent/test/file-command-state.test.ts`
- Test: `apps/agent/test/transport.test.ts`
- Decision: ADR 0003, ADR 0004, and ADR 0017.

## Step 33: Generate safe Docker plans

- Status: local
- Action: Require a digest-pinned image.
- Action: Run the game as user `10001:10001`.
- Action: Use a read-only root filesystem.
- Action: Drop all capabilities.
- Action: Enable `no-new-privileges`.
- Action: Reject the Docker socket, devices, foreign mounts, duplicate ports, and foreign labels.
- Action: Create an internal and non-attachable network.
- Action: Reject adoption when the existing container has a weaker log driver or log limit.
- Evidence: `packages/docker-runtime/src/index.ts`
- Test: `packages/docker-runtime/test/docker-plan.test.ts`
- Test: `tests/security/docker-boundaries.live.test.ts`
- Decision: ADR 0004 and ADR 0022.

## Step 34: Validate bind sources before Docker changes

- Status: local
- Action: Resolve each bind source before a Docker API call.
- Action: Reject symlinks and paths outside the trusted server root.
- Action: Reject a replaceable or untrusted parent directory.
- Action: Accept only the configured trusted owner IDs.
- Evidence: `packages/docker-runtime/src/index.ts`
- Test: `packages/docker-runtime/test/docker-plan.test.ts`
- Decision: ADR 0004.

## Step 35: Enforce disk quota through a dedicated filesystem

- Status: local
- Action: Check disk quota support before a Docker mutation.
- Action: Create ext4 project quotas on an offline, preallocated backing file.
- Action: Mount the file with `nodev`, `nosuid`, and `prjquota` before the quota
  socket, Docker mutation, or agent starts.
- Action: Assign a persistent project ID through a bounded root-only Unix socket.
- Action: Apply the byte limit with fixed commands.
- Action: Read the exact project ID and hard limit back with `lsattr` and
  `repquota` before a proof returns.
- Action: Reject every deployment when the node has no exact quota proof.
- Action: Do not treat a requested disk limit as an enforced disk limit.
- Evidence: `packages/docker-runtime/src/index.ts`
- Evidence: `packages/docker-runtime/src/quota.ts`
- Evidence: `infra/images/systemd/gridora-quota-filesystem.service`
- Evidence: `infra/images/systemd/gridora-quota.socket`
- Test: `packages/docker-runtime/test/docker-plan.test.ts`
- Test: `packages/docker-runtime/test/project-quota.test.ts`
- Test: `tests/security/docker-boundaries.live.test.ts`
- Test: `.github/workflows/image.yml`
- Blocker: No promoted QCOW2 image has proved first boot, clean unmount, reboot,
  quota persistence, resize, release, and game-UID exhaustion.
- Decision: ADR 0027 and ADR 0029.

## Step 36: Define Steam installation plans

- Status: local
- Action: Use fixed executable and argument arrays.
- Action: Do not build shell command strings.
- Action: Install publisher files with SteamCMD on the assigned node.
- Action: Keep game binaries out of generic images and backups.
- Evidence: `packages/steam-runtime/src/index.ts`
- Test: `packages/steam-runtime/test/steam-plan.test.ts`
- Decision: ADR 0005.

## Step 37: Implement game plugins

- Status: local
- Action: Implement Arma Reforger and Valheim plugin packages.
- Action: Define resources, ports, install files, config files, mods, health checks, activation, restore, and rollback plans.
- Action: Keep game behavior inside its plugin package.
- Action: Run plugin conformance checks.
- Evidence: `plugins/games/arma-reforger/`
- Evidence: `plugins/games/second-reference-game/`
- Evidence: `packages/plugin-testkit/`
- Test: `plugins/games/arma-reforger/src/index.test.ts`
- Test: `plugins/games/second-reference-game/src/index.test.ts`
- Decision: ADR 0005 and ADR 0009.

## Step 38: Keep game execution live-blocked

- Status: live-blocked
- Action: Do not claim a Steam download, game start, mod sync, health check, or RCON operation.
- Action: Require a promoted node image with verified quota persistence first.
- Blocker: No live node or promoted image used the plugin plans.
- Blocker: No live game container used the local project-quota adapter.
- Decision: ADR 0004, ADR 0005, ADR 0009, and ADR 0029.

## Step 39: Create deterministic local backup archives

- Status: local
- Action: Write sorted USTAR entries with normalized metadata.
- Action: Compress the archive with the Node.js Zstandard adapter.
- Action: Do not invoke a shell.
- Action: Bind compressed and expanded limits to signed `diskBytes`.
- Evidence: `apps/agent/src/backup-archive.ts`
- Evidence: `packages/backup-runtime/src/index.ts`
- Test: `apps/agent/test/backup-archive.test.ts`
- Test: `packages/backup-runtime/test/backup-plan.test.ts`
- Decision: ADR 0010 and ADR 0024.

## Step 40: Restore from one verified private snapshot

- Status: local
- Action: Open the public archive once with no-follow behavior.
- Action: Copy and hash the same inode into an agent-private snapshot.
- Action: Inspect, extract, and retain only the private snapshot.
- Action: Reject traversal, links, devices, oversized entries, too many entries, and excess aggregate bytes.
- Action: Extract into a sibling staging directory.
- Action: Use atomic rename, a rollback directory, and a completion marker for cutover.
- Evidence: `apps/agent/src/backup-archive.ts`
- Test: `apps/agent/test/backup-archive.test.ts`
- Decision: ADR 0024.

## Step 41: Define encrypted off-node backup transport

- Status: live-blocked
- Action: Derive every R2 key from the organization, server, and backup.
- Action: Re-chunk the bounded producer stream into a fixed encryption layout.
- Action: Bind each unique AES-GCM nonce to the scope, chunk index, chunk size,
  and plaintext checksum.
- Action: Write the authenticated manifest last.
- Action: Adopt an uncertain R2 write only when owned metadata and bytes match.
- Action: Create one random backup data key and wrap it with the versioned KEK.
- Action: Adopt an exact concurrent key record after a lost response.
- Action: Map create-only writes to the Workers R2 binding with
  `If-None-Match: *` and treat a failed precondition as an adoption candidate.
- Action: Persist only the wrapped key in D1 for the exact organization, server,
  and canonical backup.
- Action: Make wrapped backup-key rows immutable.
- Action: Do not claim an R2 upload, an R2 download, an encrypted off-node restore,
  or production backup key delivery.
- Evidence: `packages/backup-r2/src/index.ts`
- Evidence: `packages/backup-key/src/index.ts`
- Evidence: `packages/backup-key-d1/src/index.ts`
- Evidence: `packages/migrations/sql/0010_backup_wrapped_keys.sql`
- Evidence: `apps/api/src/backup-runtime.ts`
- Evidence: `apps/api/wrangler.jsonc`
- Test: `packages/backup-r2/test/backup-r2.test.ts`
- Test: `packages/backup-r2/test/cloudflare-r2-adapter.test.ts`
- Test: `packages/backup-key/test/backup-key.test.ts`
- Test: `packages/backup-key-d1/test/backup-key-d1.test.ts`
- Test: `tests/cloudflare/backup-d1-r2.integration.ts`
- Blocker: No Workflow-to-agent streaming composition connects the local archive
  to the configured API backup layer and a live R2 bucket.
- Decision: ADR 0010, ADR 0024, and ADR 0030.

## Step 42: Encrypt stored secrets with envelopes

- Status: local
- Action: Generate a random AES-256-GCM data key for each secret.
- Action: Bind authenticated data to the organization, scope, and record ID.
- Action: Store only ciphertext, a wrapped data key, and a key version in D1.
- Action: Report a stored envelope only after D1 confirms one successful write.
- Action: Fence rotation and deletion with revisions.
- Action: Redact secret canaries from errors and logs.
- Evidence: `packages/secret-envelope/src/index.ts`
- Evidence: `packages/secret-envelope-d1/src/index.ts`
- Evidence: `packages/secret-kek-cloudflare/src/index.ts`
- Test: `packages/secret-envelope-d1/test/secret-envelope.test.ts`
- Test: `packages/secret-kek-cloudflare/test/kek.test.ts`
- Decision: ADR 0020 and ADR 0028.

## Step 43: Compose provider secret access and keep the live key gate

- Status: live-blocked
- Action: Use the in-memory key service for secret-envelope service tests only.
- Action: Use the Cloudflare adapter to wrap and unwrap 32-byte data keys with versioned Secrets Store bindings.
- Action: Permit provider credential creation and rotation only for an Owner and
  only when the server-side BYOP feature is enabled.
- Action: Keep provider type immutable.
- Action: Commit provider metadata, encrypted envelope, idempotency result, and
  secret-free audit in one D1 transaction.
- Action: Keep a new provider account disabled until live validation succeeds.
- Action: Do not store a production key-encryption key in source code, D1, or Worker variables.
- Evidence: `apps/api/src/index.ts`
- Evidence: `packages/db-d1/src/index.ts`
- Evidence: `packages/migrations/sql/0004_provider_account_credentials.sql`
- Test: `apps/api/test/inventory-http.test.ts`
- Blocker: No live Secrets Store binding or key rotation evidence exists.
- Decision: ADR 0020 and ADR 0028.

## Step 44: Implement the web authentication and setup pages

- Status: local
- Action: Add public sign-in and sign-up pages.
- Action: Add an opaque invitation route.
- Action: Add the required first organization setup page.
- Action: Convert budget currency values to integer minor units.
- Action: Normalize and remove duplicate initial invitation email addresses.
- Evidence: `apps/web/pages/sign-in.vue`
- Evidence: `apps/web/pages/sign-up.vue`
- Evidence: `apps/web/pages/invitations/[token].vue`
- Evidence: `apps/web/pages/setup/organization.vue`
- Test: `apps/web/tests/onboarding-contract.test.ts`
- Test: `apps/web/tests/organization-setup.test.ts`
- Decision: ADR 0014 and ADR 0016.

## Step 45: Implement the organization console

- Status: local
- Action: Add the organization switcher.
- Action: Add overview, provider, image, node, server, operation, backup, member, audit, and settings pages.
- Action: Add member removal, role change, ownership transfer, invitation creation, and invitation revocation controls.
- Action: Add an Owner and Administrator view for token-free invitation email
  remediation records.
- Action: Disable an action when the API capability remains unsupported.
- Action: Do not invent provider health, node health, cost, log, or game status.
- Action: Refresh data after a revision conflict.
- Evidence: `apps/web/pages/o/[slug]/`
- Evidence: `apps/web/components/OrganizationSwitcher.vue`
- Evidence: `apps/web/services/gridora-api.ts`
- Test: `apps/web/tests/api-view-model.test.ts`
- Test: `apps/web/tests/onboarding-contract.test.ts`
- Decision: ADR 0013, ADR 0014, ADR 0021, and ADR 0025.

## Step 46: Preserve web mutation idempotency

- Status: local
- Action: Hash the logical action and canonical request for a session storage key.
- Action: Reuse one opaque idempotency key after a network error or uncertain HTTP response.
- Action: Share the key between concurrent copies of the same submission.
- Action: Remove the key after a confirmed success or definitive client error.
- Evidence: `apps/web/services/idempotent-mutation.ts`
- Test: `apps/web/tests/idempotent-mutation.test.ts`
- Decision: ADR 0021.

## Step 47: Define Cloudflare resources

- Status: template
- Action: Define D1, R2, Queue, Durable Object, Workflow, cron, service, and restricted email bindings.
- Action: Keep staging and production settings separate.
- Action: Keep secret values out of Wrangler files.
- Action: Make Terraform create zero resources by default.
- Action: Define owned DNS, Tunnel, and Access resource reconciliation operations.
- Action: Reject foreign or ambiguous Cloudflare resources.
- Action: Define a separate Worker Assets bundle for the Nuxt console.
- Action: Enable the Nitro Cloudflare Node compatibility adapter.
- Action: Bind notification remediation and immutable audit archive buckets.
- Action: Bind private tenant-prefixed backup and log buckets in the API and
  Terraform templates.
- Action: Bind the live-log Durable Object through the API to the realtime
  Worker.
- Action: Define one opt-in multi-domain Access application for the concrete
  console and API hostnames. Use the new-application eager cookie behavior so
  the console login also creates the API application cookie. Enable Managed
  OAuth with dynamic loopback registration on this application.
- Action: Give the public authentication-intent path and the machine and
  internal protocol paths more-specific Access applications. Keep their
  origin authentication fail closed.
- Action: Restrict credentialed API CORS to the configured public app and
  console origins.
- Action: Define the policy reconciliation Queue and dead-letter Queue that the
  checked Worker configuration consumes.
- Evidence: `apps/api/wrangler.jsonc`
- Evidence: `workers/realtime/wrangler.jsonc`
- Evidence: `workers/workflows/wrangler.jsonc`
- Evidence: `workers/queue-consumers/wrangler.jsonc`
- Evidence: `apps/web/wrangler.jsonc`
- Evidence: `infra/cloudflare/wrangler.template.jsonc`
- Evidence: `infra/cloudflare/terraform/`
- Evidence: `packages/cloudflare-control/src/index.ts`
- Test: `tests/security/infra-boundaries.test.ts`
- Test: `packages/cloudflare-control/src/index.test.ts`
- Verification: Terraform 1.10 with Cloudflare provider 5.23 validates the
  template. The default staging plan creates no resources. The infrastructure
  security test passes locally.
- Blocker: No Access application, DNS record, Worker route, or Cloudflare
  resource was created in an account.
- Decision: ADR 0002, ADR 0007, ADR 0014, and ADR 0034.

## Step 48: Define secure node bootstrap

- Status: template
- Action: Put the short-lived agent registration value in a root-only file.
- Action: Do not put a long-lived Tunnel token in cloud-init user-data.
- Action: Remove sensitive cloud-init cache data after bootstrap.
- Action: Keep `cloudflared` stopped until a trusted channel writes a valid token file.
- Evidence: `infra/images/cloud-init/node-bootstrap.yaml.tmpl`
- Evidence: `infra/images/clean-cloud-init-sensitive-cache`
- Evidence: `infra/images/validate-cloudflared-token`
- Test: `tests/image/bootstrap-integration.test.ts`
- Test: `tests/image/cloud-init-cache-cleanup.test.ts`
- Decision: ADR 0017 and ADR 0023.

## Step 49: Define sealed Tunnel credential delivery

- Status: live-blocked
- Action: Fail node readiness when the Tunnel token file is absent or unsafe.
- Action: Bind a sealed install or revoke command to the organization, node,
  Tunnel, operation, revision, and expiry.
- Action: Derive operation and delivery identities from the tenant, actor, exact
  route coordinates, and idempotency key; do not accept a client operation ID.
- Action: Verify the remote Tunnel ID, Cloudflare-managed source, and canonical
  Gridora resource name before issuing, rotating, or revoking a credential.
- Action: Persist and queue only the signed sealed command.
- Action: Reload the authoritative D1 command before delivery to the node coordinator.
- Action: Give plaintext only to a bounded privileged installer.
- Action: Install one root-owned `0600` file with file and directory `fsync` and
  atomic rename.
- Action: Pass the root file to unprivileged `cloudflared` through systemd
  `LoadCredential`.
- Action: Return a token-free health acknowledgement.
- Evidence: `packages/tunnel-credential/src/index.ts`
- Evidence: `packages/tunnel-installer/src/index.ts`
- Evidence: `apps/api/src/tunnel-delivery.ts`
- Evidence: `infra/images/systemd/gridora-tunnel-installer.socket`
- Evidence: `infra/images/systemd/gridora-tunnel-installer.service`
- Evidence: `infra/images/systemd/cloudflared.service`
- Evidence: `infra/images/validate-cloudflared-token`
- Test: `packages/tunnel-credential/test/tunnel-credential.test.ts`
- Test: `packages/tunnel-installer/test/installer.test.ts`
- Test: `apps/agent/test/tunnel-command.test.ts`
- Test: `apps/api/test/tunnel-delivery.test.ts`
- Test: `tests/image/image-assets.test.ts`
- Blocker: No real Secrets Store Tunnel token/signing key, Cloudflare Tunnel,
  promoted image boot, or live readiness check was used.
- Decision: ADR 0023 and ADR 0033.

## Step 50: Harden the node image template

- Status: template
- Action: Define a pinned Ubuntu 24.04 amd64 QEMU image build.
- Action: Verify the agent, Node.js, cloudflared, and Traefik inputs.
- Action: Lock password login and direct root login.
- Action: Add systemd sandboxes, journald limits, kernel settings, and recovery checks.
- Action: Set the nftables input and forward policies to deny.
- Action: Keep SSH and Docker ports closed.
- Evidence: `infra/packer/gridora-node.pkr.hcl`
- Evidence: `infra/packer/scripts/provision.sh`
- Evidence: `infra/images/systemd/`
- Evidence: `infra/images/nftables/gridora.nft`
- Test: `tests/image/image-assets.test.ts`
- Decision: ADR 0003, ADR 0006, and ADR 0012.

## Step 51: Define image supply-chain evidence

- Status: template
- Action: Generate an SPDX SBOM with Syft.
- Action: Scan the artifact with Grype.
- Action: Sign the artifact with Sigstore Cosign.
- Action: Record source inputs, checksums, test logs, scan logs, and rollback image ID.
- Action: Keep the image build on an explicit self-hosted KVM runner.
- Evidence: `infra/scripts/`
- Evidence: `infra/images/promotion-manifest.example.json`
- Evidence: `.github/workflows/image.yml`
- Decision: ADR 0012.

## Step 52: Define continuous verification

- Status: template
- Action: Run checks, tests, builds, Worker dry runs, and a behavioral Docker boundary test in CI.
- Action: Run dependency review, dependency audit, Trivy, and Terraform validation.
- Action: Keep live provider tests behind a protected environment and an explicit flag.
- Action: Pin security-sensitive GitHub Actions by commit.
- Action: Run D1 and SQLite Durable Object behavior in the Cloudflare workerd
  runtime.
- Action: Export the real API Worker in the workerd harness.
- Action: Exercise the generated API contract, problem boundary, D1 leases, and
  authenticated D1/R2 backup round trip as runtime behavior.
- Action: Build the Nuxt Cloudflare artifact before its Worker dry run.
- Evidence: `.github/workflows/ci.yml`
- Evidence: `.github/workflows/security.yml`
- Evidence: `.github/workflows/provider-contract.yml`
- Evidence: `tests/cloudflare/`
- Test: `tests/cloudflare/api-worker.integration.ts`
- Test: `tests/cloudflare/backup-d1-r2.integration.ts`
- Decision: ADR 0012.

## Step 53: Define release controls

- Status: template
- Action: Require a semantic version tag on the protected `main` branch.
- Action: Require successful `CI` and `Security` push workflows for the exact
  tag commit.
- Action: Require one protected manual Node image run for the exact commit.
  Require successful validation, image build, provider boot and cleanup jobs,
  and a non-expired immutable image artifact. Do not accept a validation-only
  push run as image evidence.
- Action: Require strict main-branch checks and at least one approving review.
- Action: Require stale-review dismissal or approval of the last push, and bind
  an approving review to the pull request's final head commit.
- Action: Verify that the tag commit is the merge result of an approved pull
  request into `main`.
- Action: Verify required reviewers on the protected release environment.
- Action: Verify an active tag ruleset restricts version-tag updates and
  deletions.
- Action: Re-resolve the remote tag before the build and immediately before
  publication.
- Action: Keep release publication behind the protected `production-release` environment.
- Action: Build a reproducible source archive.
- Action: Create a checksum file.
- Action: Sign the archive with GitHub OIDC and Cosign.
- Evidence: `.github/workflows/release.yml`
- Evidence: `docs/operations/release.md`
- Decision: ADR 0012.

## Step 54: Define operator procedures

- Status: local
- Action: Document node bootstrap, incident response, backup and restore, provider retirement, and release procedures.
- Action: Keep Contabo cancellation separate from server retirement.
- Action: Keep unknown provider resources during incident review.
- Evidence: `docs/operations/`
- Decision: ADR 0010, ADR 0011, ADR 0012, and ADR 0015.

## Step 55: Define plugin and project rules

- Status: local
- Action: Document plugin capabilities, license review, test rules, and prohibited runtime loading.
- Action: Document contribution, conduct, and private vulnerability report rules.
- Evidence: `docs/plugin-authoring/README.md`
- Evidence: `CONTRIBUTING.md`
- Evidence: `CODE_OF_CONDUCT.md`
- Evidence: `SECURITY.md`
- Decision: ADR 0005 and ADR 0009.

## Step 56: Record architecture decisions

- Status: local
- Action: Record the decisions in ADR 0001 through the highest ADR in the index.
- Action: Keep accepted ADR history immutable.
- Action: Add a superseding ADR when a decision changes.
- Evidence: `docs/adr/`
- Decision: ADR 0012 requires retained decision and release evidence. The ADR
  index defines the record process.

## Step 57: Complete repository-wide verification

- Status: local
- Action: Run `pnpm install --frozen-lockfile`.
- Action: Run `pnpm format`.
- Action: Run `pnpm lint`.
- Action: Run `pnpm check`.
- Action: Run `pnpm test`.
- Action: Run `pnpm test:cloudflare` in workerd.
- Action: Run `pnpm build`.
- Action: Run all Worker type generation and dry-run commands.
- Action: Run the real Docker boundary test with `GRIDORA_LIVE_DOCKER_SECURITY=1`.
- Action: Run the Terraform non-provisioning plan.
- Action: Run the dependency audit.
- Action: Record the exact final results before publication of the implementation commit.
- Evidence: The final repository-wide result is not recorded in this document yet.
- Decision: ADR 0012.

## Step 58: Publish the implementation commit

- Status: local
- Action: Commit the reviewed implementation after step 57 passes.
- Action: Push the commit to the public `main` branch.
- Action: Check the GitHub Actions result.
- Evidence: Only initial commit `bbc2d43` is confirmed in this record.
- Decision: ADR 0012.

## Step 59: Build and promote a node image

- Status: live-blocked
- Action: Build an image only on an approved KVM runner.
- Action: Require complete SBOM, scan, signature, boot, recovery, and rollback evidence.
- Action: Promote an immutable image ID only after every gate passes.
- Blocker: No built or promoted node image evidence exists.
- Decision: ADR 0012 and ADR 0029.

## Step 60: Deploy and release Gridora

- Status: live-blocked
- Action: Require an owned Cloudflare zone and Access applications.
- Action: Require approved D1, R2, Queue, Durable Object, Workflow, and Email Sending resources.
- Action: Require a live Secrets Store keyring, a complete Tunnel credential
  channel, a promoted image with quota persistence, and approved provider
  credentials.
- Action: Publish a signed release only after all protected checks pass.
- Action: Record the release, deployment, provider, node, game, backup, and email evidence.
- Blocker: The required production systems and approvals do not exist in this record.
- Decision: ADR 0012, ADR 0029, ADR 0030, ADR 0032, and ADR 0033.

## Step 61: Define atomic node provision acceptance

- Status: live-blocked
- Action: Accept only placement, temporary lifetime, and commitment confirmation from the client.
- Action: Reject client provider types, prices, provider IDs, image IDs, and credentials.
- Action: Derive the request fingerprint and every acceptance identity from exact tenant coordinates.
- Action: Read an exact replay before current provider and policy facts.
- Action: Select the provider account, allocation, catalog row, and promoted image from D1.
- Action: Evaluate the current organization policy with Effect.
- Action: Write the node, immutable contract, spend reservation, operation,
  lifecycle reservation, Workflow start, bootstrap-token hash, audit event,
  outbox event, and acceptance receipt in one D1 transaction.
- Action: Re-read policy, allocation, catalog, image, usage, and spend facts in
  the final transaction fence.
- Action: Abort every row when one fact changed.
- Action: Keep Contabo contract facts immutable.
- Action: Store only the bootstrap-token key version and hash.
- Action: Select OVHcloud or Contabo only from the authoritative account type.
- Action: Give the provider transport the immutable accepted price, cadence, and contract term.
- Action: Reject a provider endpoint that is not in the fixed allow-list.
- Action: Clear decrypted credential bytes after success, failure, or interruption.
- Action: Use the operation ID for exact provider adoption after a lost response.
- Evidence: `packages/node-provision-control/src/index.ts`
- Evidence: `packages/node-provision-d1/src/index.ts`
- Evidence: `packages/provider-runtime/src/index.ts`
- Evidence: `packages/migrations/sql/0012_node_provision_acceptance.sql`
- Test: `packages/node-provision-control/test/index.test.ts`
- Test: `packages/node-provision-d1/test/index.test.ts`
- Test: `packages/provider-runtime/test/index.test.ts`
- Blocker: The API does not expose the intent contract or compose this control.
- Blocker: The Workflow does not open a live provider envelope or persist a live provider instance.
- Blocker: No approved provider credential, promoted provider image, D1 deployment,
  Workflow binding, paid create, bootstrap, TTL cleanup, or orphan reconciliation run exists.
- Decision: ADR 0038.

## Step 62: Export authoritative game-server planning

- Status: local
- Action: Accept only the strict server name, plugin ID, placement mode, and resource request.
- Action: Reject client server, deployment, operation, provider-account, allocation, and plugin-version IDs.
- Action: Require an active Operator, Administrator, or Owner membership in the route organization.
- Action: Read the active plugin contract, organization policy, budget usage,
  provider allocation, provider catalog, node health, capacity, deployments,
  and port leases from tenant-scoped D1 queries.
- Action: Reject foreign, stale, incomplete, incompatible, over-capacity, and port-conflicting facts.
- Action: Return a read-only placement decision that does not reserve resources or claim paid work.
- Action: Publish the strict request and response through OpenAPI and the generated client.
- Action: Apply migration 0013 for plugin channels, runtime capacity, and future atomic reservation fences.
- Evidence: `packages/server-plan-control/src/index.ts`
- Evidence: `packages/server-plan-d1/src/index.ts`
- Evidence: `packages/migrations/sql/0013_server_plan.sql`
- Evidence: `apps/api/src/server-plan-routes.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Test: `packages/server-plan-control/test/server-plan-control.test.ts`
- Test: `packages/server-plan-d1/test/server-plan-d1.test.ts`
- Test: `apps/api/test/server-plan-routes.test.ts`
- Blocker: The create-server route remains 501 because no complete provider and agent Workflow consumes the reservation.
- Blocker: No live D1 migration, reviewed plugin-channel population, fresh node
  capacity ingestion, legacy capacity backfill, or live planning request is recorded.
- Decision: ADR 0036.

## Step 63: Compose bounded orphan-provider reconciliation

- Status: local
- Action: Verify the active identity, membership, allocation, organization,
  provider account, and provider type in D1 before provider discovery.
- Action: Open an organization account from the exact tenant envelope.
- Action: Open a platform account only through an injected encrypted platform
  secret port keyed by the exact account ID and provider type.
- Action: Clear plaintext credential bytes after success, failure, or interruption.
- Action: Select OVHcloud or Contabo from the authoritative account type.
- Action: Give discovery only the existing provider `listNodes` function.
- Action: Do not give discovery a provider mutation capability.
- Action: Reject malformed credentials, unsafe endpoints, malformed responses,
  duplicate provider IDs, foreign ownership, and more than 200 nodes.
- Action: Mark the snapshot complete and untruncated.
- Action: Do not create provider-removal evidence from list absence.
- Action: Use the immutable node provision acceptance operation as provider ownership.
- Action: Use one successful legacy `node.provision` operation only when it is exact and unique.
- Action: Reject equal or older observation times for distinct runs.
- Action: Preserve exact idempotency replay after a lost D1 response.
- Action: Write findings, audit events, export requests, and replay results atomically.
- Action: Never stop, rebuild, retire, or delete a discovered provider resource.
- Evidence: `packages/orphan-provider-discovery/src/index.ts`
- Evidence: `packages/orphan-d1/src/index.ts`
- Evidence: `apps/api/src/orphan-runtime.ts`
- Test: `packages/orphan-provider-discovery/test/index.test.ts`
- Test: `packages/orphan-d1/test/index.test.ts`
- Test: `apps/api/test/orphan-runtime.test.ts`
- Blocker: No signed internal Queue or Workflow handler calls the runtime.
- Blocker: The central Worker does not bind the platform credential port to an
  audited encrypted platform secret store.
- Blocker: No approved live provider credential, deployed D1 schema, Secrets
  Store KEK, provider response, or scheduled reconciliation run is recorded.
- Decision: ADR 0039.

## Step 64: Define fail-closed agent observation ingestion

- Status: live-blocked
- Action: Authenticate the request with the existing hashed node bearer credential over HTTPS.
- Action: Bind the body organization, node, and session version to the authenticated principal.
- Action: Take the credential ID and version only from the authenticated principal.
- Action: Reject excess fields, oversized bodies, unproven stale cursors, future time, and usage above capacity.
- Action: Fingerprint the canonical strict body with SHA-256 and store only the current fingerprint.
- Action: Return the original receipt without writes for an exact current-cursor replay.
- Action: Reject changed facts or machine coordinates at the committed cursor.
- Action: Re-read an exact replay after a batch conflict or lost D1 response.
- Action: Return `agent_observation_not_committed` for a stale pending event only after D1
  proves the active machine session remains at the exact prior cursor.
- Action: Require the next sequence and the next observed revision.
- Action: Reset sequence only for the exact next authenticated session version.
- Action: Ingest agent, image, Tunnel, Docker, firewall, capacity, and bounded metric facts.
- Action: Replace seven fixed current aggregates instead of appending raw telemetry.
- Action: Store no command output, environment data, arbitrary labels, logs, or secrets.
- Action: Check the active credential and connected tenant session in the final D1 fence.
- Action: Check the promoted node image and authoritative tenant Tunnel in the final D1 fence.
- Action: Require one exact schema-one Ed25519 promoted signature object with no extra properties.
- Action: Match the reported manifest, detached-signature, and public-key SHA-256 coordinates.
- Action: Match the immutable provision acceptance and provider image mapping.
- Action: Match reported TCP and UDP ports exactly to current non-released leases.
- Action: Require `overlay2`, project quota, zero privileged containers, no Docker socket mount,
  and a default-deny firewall before publishing capacity.
- Action: Update the node observation and `node_runtime_capacity` in one transaction.
- Action: Accept a fully ready provisioning report as bootstrapping without placement capacity.
- Action: Complete an accepted provider-created and registered node only when its exact
  provision operation is waiting externally and every tenant readiness fence holds.
- Action: Record ready audit and outbox evidence, complete the operation, advance desired
  state and revision, clear the pending operation, and publish capacity in one batch.
- Action: Leave the already released provider execution lease unchanged.
- Action: Treat agent version as a bounded observation until an authenticated upgrade mutation exists.
- Action: Withdraw capacity when any readiness fact fails.
- Action: Roll back every aggregate and node change when the final stream cursor rejects.
- Action: Compose `POST /v1/agent/events` with the existing `agentCredential` boundary.
- Evidence: `packages/agent-observation-control/src/index.ts`
- Evidence: `packages/agent-observation-d1/src/index.ts`
- Evidence: `packages/migrations/sql/0014_agent_observation_ingestion.sql`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/agent/src/observation.ts`
- Evidence: `apps/agent/src/observation-node.ts`
- Test: `packages/agent-observation-control/test/index.test.ts`
- Test: `packages/agent-observation-d1/test/index.test.ts`
- Test: `apps/api/test/observation-realtime-contracts.test.ts`
- Test: `apps/api/test/composed-boundaries.test.ts`
- Test: `apps/agent/test/observation.test.ts`
- Blocker: No live D1 migration, bearer-authenticated event, readiness transition,
  capacity publication, or planner eligibility result is recorded.
- Decision: ADR 0040.

## Step 65: Authorize organization realtime events

- Status: local
- Action: Reserve `POST /v1/organizations/:organization/events/ticket` for
  ticket issuance and `GET /v1/organizations/:organization/events` for the
  WebSocket upgrade.
- Action: Require Cloudflare Access authentication and a current active
  Viewer-or-higher membership for ticket issuance.
- Action: Resolve the route slug to the canonical organization ID before signing.
- Action: Bind the ticket to the organization, actor, membership revision,
  console audience, organization resource, 60-second expiry, and random nonce.
- Action: Return the bearer ticket only in a private `no-store` response.
- Action: Authorize the organization and read the membership revision again on
  every WebSocket upgrade.
- Action: Reject non-upgrades, malformed, duplicate, expired, foreign,
  wrong-actor, and stale-membership tickets before Durable Object resolution.
- Action: Select and initialize only `${organizationId}:events`.
- Action: Forward only the ticket and WebSocket upgrade header; do not forward
  Access assertions, cookies, browser headers, or unrelated query parameters.
- Action: Let `OrganizationEventsDO` verify the ticket again and consume its
  nonce once in Durable Object storage.
- Action: Do not add a polling fallback.
- Evidence: `apps/api/src/organization-events-routes.ts`
- Evidence: `workers/realtime/src/ticket.ts`
- Evidence: `workers/realtime/src/index.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Evidence: `apps/web/services/organization-realtime.ts`
- Evidence: `apps/web/composables/useOrganizationRealtime.ts`
- Test: `apps/api/test/organization-events-routes.test.ts`
- Test: `workers/realtime/test/ticket.test.ts`
- Test: `tests/cloudflare/organization-events.integration.ts`
- Test: `apps/api/test/observation-realtime-contracts.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Test: `apps/web/tests/organization-realtime.test.ts`
- Blocker: No deployed Access session, realtime signing secret, Durable Object
  binding, WebSocket upgrade, replay attempt, or browser event delivery is recorded.
- Decision: ADR 0041.

## Step 66: Preview authoritative game desired state

- Status: local
- Action: Read the server, latest configuration revision, and current mod set
  with the organization ID and server ID in the D1 query.
- Action: Select the exact built-in plugin ID and version from the fixed
  build-time registry.
- Action: Do not accept a plugin ID or plugin version in a preview request.
- Action: Validate, normalize, and plan a configuration with the selected
  plugin control facet.
- Action: Redact secret values and secret references from the configuration,
  diff, deployment plan, and full HTTP response.
- Action: Accept only generic desired mod fields.
- Action: Plan Arma mods without a Steam or Workshop network request.
- Action: Mark mod versions and dependencies unresolved when external metadata
  is absent.
- Action: Reject Valheim mod planning because the plugin does not declare the
  mods capability.
- Action: Reject a foreign tenant, unknown plugin version, stale revision, and
  excess request property.
- Action: Do not write D1 state, create an operation, call a provider, or call
  an agent.
- Evidence: `packages/game-desired-state-control/src/index.ts`
- Evidence: `apps/api/src/game-desired-state-routes.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Test: `packages/game-desired-state-control/test/game-desired-state-control.test.ts`
- Test: `apps/api/test/game-desired-state-routes.test.ts`
- Test: `apps/api/test/desired-state-contracts.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Blocker: Configuration apply and mod sync remain 501 until an agent Workflow
  can accept, deliver, observe, and reconcile the desired state.
- Blocker: No deployed D1 binding, live server configuration, Workshop metadata
  snapshot, or live preview request is recorded.
- Decision: ADR 0042.

## Step 67: Execute accepted node provider work with a lease

- Status: live-blocked
- Action: Accept only the organization ID, operation ID, and bounded attempt time from an internal Workflow.
- Action: Read an exact durable completion before opening a secret or calling a provider.
- Action: Load the immutable node provision execution reservation from tenant-scoped D1.
- Action: Compare the attempt with an injected trusted clock and create a fresh bounded registration lifetime.
- Action: Reject a retry whose durable materialized registration lifetime expired before another provider call.
- Action: Open the exact provider account and credential envelope revision.
- Action: Reject a changed account, provider type, provider scope, organization, status, or revision.
- Action: Before the paid call, atomically materialize the delivered-token hash, fresh expiry, execution lease, and unbound provider-identity record.
- Action: Block provider account and organization-envelope rotation while the lease is active.
- Action: Use `create_or_adopt` only for the first queued attempt.
- Action: Use `adopt_only` for every running or retrying attempt.
- Action: Use the operation ID as the only provider adoption identity.
- Action: Keep an empty adopt-only discovery result uncertain and do not send
  another paid create.
- Action: Increase the adopt-only retry delay from the durable attempt number
  without passing the durable registration deadline.
- Action: Rederive the accepted registration token with the versioned keyring.
- Action: Build the exact ADR 0045 manifest from immutable image ID, provider image ID, version, promoted checksum, and trusted runtime configuration.
- Action: Write only the root reservation from cloud-init and rely on the enabled after-`cloud-final` bootstrap unit; do not synchronously start it.
- Action: Clear credential, registration-token, and cloud-init byte buffers on every exit.
- Action: Dispatch OVHcloud or Contabo only from the authoritative account type.
- Action: Preserve the accepted Contabo price, cadence, contract term, and confirmation.
- Action: Accept only exact Gridora-owned provider metadata.
- Action: Permit the first token-authenticated boot to bind one provider instance ID before the provider response.
- Action: Atomically set or exact-match that provider instance ID and ensure one matching existing registration-token row.
- Action: Atomically write audit and outbox evidence and move the operation to `waiting_external`.
- Action: Release the execution lease only with the exact committed provider result.
- Action: Keep the node in provisioning until authenticated agent, image, Tunnel, and runtime facts prove readiness.
- Action: Adopt an exact D1 completion after a lost response.
- Action: Keep an uncertain execution lease active for adopt-only or orphan reconciliation.
- Action: Record a reconciliation-required node condition, audit event, and
  outbox event when the uncertain recovery deadline is exhausted.
- Action: Release the execution lease in the guarded failure transaction only for a definite terminal provider failure.
- Evidence: `packages/node-provision-execution/src/index.ts`
- Evidence: `packages/node-provision-execution-d1/src/index.ts`
- Evidence: `apps/api/src/node-provision-runtime.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `workers/workflows/src/index.ts`
- Evidence: `workers/workflows/src/workflow-plan.ts`
- Evidence: `packages/migrations/sql/0015_node_provision_execution_lease.sql`
- Test: `packages/node-provision-execution/test/index.test.ts`
- Test: `packages/node-provision-execution-d1/test/index.test.ts`
- Test: `apps/api/test/node-provision-runtime.test.ts`
- Test: `packages/provider-create-transports/test/index.test.ts`
- Test: `workers/workflows/test/index.test.ts`
- Test: `packages/migrations/test/schema.test.ts`
- Verification: The central Worker composes the signed provision step, exact
  credential opener, provider transports, cloud-init renderer, D1 execution
  repository, and atomic early registration exchange. Focused API, provider,
  Workflow, execution, and D1 tests pass locally.
- Blocker: No promoted image has booted the exact renderer manifest through the ADR 0045 helper.
- Blocker: No approved live provider credential, paid create, bootstrap lifetime, agent/Tunnel readiness,
  orphan resolution, temporary-node expiry, or provider cleanup run is recorded.
- Decision: ADR 0043.

## Step 68: Publish crash-safe node observations

- Status: live-blocked
- Action: Read the RSA-OAEP installer public key from the fixed root Tunnel installer socket.
- Action: Send that installer key in registration without reusing the Ed25519 command-signing key.
- Action: Receive the credential ID, credential version, and session version from registration.
- Action: Persist the credential and its authoritative metadata in one root-private atomic file.
- Action: Preserve the one-time token when the registration response is ambiguous.
- Action: Delete the token and sync its directory only after the authentication file is durable.
- Action: Atomically write a secret-free registration-complete marker after token deletion.
- Action: Validate exact marker and authentication coordinates on reboot.
- Action: Make image cleanup wait for matching authentication and marker files and token absence.
- Action: Let legacy credential-only nodes poll commands but disable their observation publisher.
- Action: Serialize the complete prepare, send, and receipt transition with an Effect semaphore.
- Action: Sample authoritative facts before allocating the next cursor.
- Action: Persist the exact pending event before the HTTP request.
- Action: Retry the exact pending event after an ambiguous transport failure or restart.
- Action: Accept only an exact receipt for the pending organization, node, sequence, and revision.
- Action: Refresh time and facts at the same cursor only after the server proves
  `agent_observation_not_committed` from its durable cursor.
- Action: Reset sequence to one only for an authoritative next session version.
- Action: Preserve the next observed revision across a session rollover.
- Action: Bound Docker bodies, container inventory, firewall proofs, ports, and timeouts.
- Action: Inspect the image attestation, installed image version, Tunnel readiness,
  Docker engine and containers, project-quota mount, root-helper firewall proof, capacity,
  network counters, load, and restart counters from local runtime sources.
- Action: Accept image readiness only from a verified image-baked signed build identity.
- Action: Publish the manifest, detached signature, and public-key SHA-256 coordinates.
- Action: Match those coordinates to one exact schema-one Ed25519 promoted-image signature object.
- Action: Reject opaque, malformed, missing, extra, mismatched, or retired image evidence.
- Action: Match the ready image to the immutable provision acceptance and provider image mapping.
- Action: Match reported TCP and UDP ports exactly to current non-released leases.
- Action: Do not describe signed build identity as measured boot.
- Action: Read firewall state only through the root-owned fixed-operation
  `/run/gridora/firewall-observation.sock` protocol.
- Action: Give the unprivileged agent no nft command, arbitrary helper argument, or `CAP_NET_ADMIN`.
- Action: Require one strict newline-terminated proof with bounded sorted unique ports.
- Action: Publish no event when one required fact cannot be proved.
- Action: Keep the bearer credential out of the event, state file, response error, and log.
- Action: Keep command polling active when observation publication fails.
- Evidence: `apps/agent/src/observation.ts`
- Evidence: `apps/agent/src/observation-node.ts`
- Evidence: `apps/agent/src/transport.ts`
- Evidence: `apps/agent/src/runtime.ts`
- Evidence: `apps/agent/src/main.ts`
- Evidence: `packages/agent-observation-control/src/index.ts`
- Evidence: `packages/agent-observation-d1/src/index.ts`
- Evidence: `packages/migrations/sql/0014_agent_observation_ingestion.sql`
- Test: `apps/agent/test/observation.test.ts`
- Test: `apps/agent/test/observation-node.test.ts`
- Test: `apps/agent/test/transport.test.ts`
- Test: `packages/agent-observation-control/test/index.test.ts`
- Test: `packages/agent-observation-d1/test/index.test.ts`
- Blocker: No promoted image has proved `/etc/gridora/image-attestation.json` on a live node.
- Blocker: The production image and a live node have not proved the root firewall
  helper against the active nftables ruleset.
- Blocker: No deployed D1 fingerprint replay, live response-loss recovery, agent
  restart, Tunnel readiness, firewall observation, capacity publication, or ready
  transition is recorded.
- Decision: ADR 0044.

## Step 69: Complete the promoted-image bootstrap handoff

- Status: live-blocked
- Action: Write one exact root-owned mode `0600` reservation from cloud-init.
- Action: Accept immutable organization, node, operation, provider, image,
  control-plane, agent, registration, and Ed25519 public-key facts only.
- Action: Reject excess fields, oversized files, symlinks, path traversal,
  malformed identifiers, an expired token, and a non-HTTPS control plane.
- Action: Validate the accepted image version against the installed image.
- Action: Read the provider instance ID only from cloud-init's cached standardized
  instance data and its matching cached instance-ID file.
- Action: Require OpenStack UUID facts for OVHcloud and positive decimal facts
  from an allowlisted cloud-init datasource for Contabo.
- Action: Contact no metadata URL during the handoff.
- Action: Validate that the command-signing key is an Ed25519 public SPKI.
- Action: Write and sync the agent configuration, public key, registration token,
  image attestation, and non-secret completion record atomically.
- Action: Carry only the exact immutable accepted image ID, version, and checksum
  into the local image attestation.
- Action: Verify the strict baked build-identity manifest and detached Ed25519
  signature with the baked public key before setting `signatureVerified` true.
- Action: Match the signed source, version, architecture, and pinned build-input
  checksums during provisioning and match the signed version during bootstrap.
- Action: Accept no identity manifest, signature, or verification key from user-data.
- Action: Report the exact baked manifest, detached-signature, and public-key
  SHA-256 coordinates and publish the same coordinates in image evidence.
- Action: Treat signed build identity as distinct from hardware runtime measurement.
- Action: Exit the bootstrap oneshot before systemd starts the ordered agent.
- Action: Retry post-agent cleanup until the exact authentication file is
  durable and the registration token is absent.
- Action: Match the authentication organization and node to the non-secret handoff.
- Action: Erase the root reservation and cloud-init copies only after that proof.
- Action: Preserve the dedicated registration token for the agent's durable
  authentication exchange and make the agent its only remover.
- Action: Give the agent no nftables binary authority or `CAP_NET_ADMIN`.
- Action: Expose only one bounded, fixed-table nftables read through a root-owned
  socket that accepts no request or arguments.
- Action: Match the complete normalized table, set, chain, hook, priority,
  policy, and allowed-rule graph before reporting firewall readiness.
- Action: Reject extra chains, sets, hooks, rules, broad accepts, and anonymous rules.
- Action: Close the firewall proof without partial facts on malformed, missing,
  ambiguous, or unbounded nftables output.
- Evidence: `infra/images/gridora-node-bootstrap`
- Evidence: `infra/images/gridora-node-bootstrap-cleanup`
- Evidence: `infra/images/gridora-firewall-observation`
- Evidence: `infra/images/create-image-promotion-manifest`
- Evidence: `infra/images/systemd/gridora-node-bootstrap.service`
- Evidence: `infra/images/systemd/gridora-node-bootstrap-cleanup.service`
- Evidence: `infra/images/systemd/gridora-node-bootstrap-cleanup.path`
- Evidence: `infra/images/systemd/gridora-firewall-observation.socket`
- Evidence: `infra/images/systemd/gridora-firewall-observation@.service`
- Evidence: `infra/packer/gridora-node.pkr.hcl`
- Evidence: `.github/workflows/image.yml`
- Test: `tests/infrastructure/node-bootstrap.test.ts`
- Test: `tests/infrastructure/firewall-observation.test.ts`
- Test: `tests/infrastructure/image-promotion-manifest.test.ts`
- Blocker: No promoted image has booted with the exact renderer output.
- Blocker: The protected `image-signing` environment, private signing-key
  secret, and matching public-key variable are not configured or verified here.
- Blocker: No live OVHcloud or Contabo instance-data sample proves the provider
  instance ID contract.
- Blocker: No live systemd handoff, registration lifetime, cloud-init cleanup,
  nftables proof, server-side promoted-image recheck, or ready transition is recorded.
- Blocker: No hardware runtime measurement independently proves that the booted
  provider disk is the final post-Packer signed QCOW2 artifact.
- Decision: ADR 0045.

## Step 70: Implement bounded provider create transports

- Status: local
- Situation: The accepted node execution path had provider-runtime ports but no
  authenticated production transport, and an ambiguous paid POST could not be
  retried safely.
- Task: Implement OVHcloud Public Cloud and Contabo create-or-adopt transports
  without permitting a duplicate paid create.
- Action: Keep every production provider mutation behind the accepted leased
  execution boundary and an exact encrypted credential revision.
- Execution: Authenticate OVHcloud with a Keystone application credential and
  select one exact regional public Nova and Neutron catalog endpoint.
- Execution: Authenticate Contabo at its exact OAuth endpoint and use only its
  exact HTTPS instance API.
- Execution: Disable redirects and bound time, request bytes, response bytes,
  UTF-8, JSON depth, JSON nodes, discovery pages, and ownership candidates.
- Execution: Map Contabo period only from confirmed immutable commercial terms
  and do not infer provider prices.
- Execution: Discover exact organization, node, operation, image, plan, region,
  name, and image-version ownership before creation.
- Execution: Require valid finite pagination before treating a discovery scan
  as complete.
- Execution: Send a paid create at most once and convert every non-definitive
  outcome to an adopt-only uncertain result.
- Execution: Normalize provider errors without exposing credentials or response
  bodies.
- Evidence: `packages/provider-create-transports/src/index.ts`
- Evidence: `packages/provider-create-transports/package.json`
- Test: `packages/provider-create-transports/test/index.test.ts`
- Verification: Seventeen focused transport behaviors, package type checking,
  lint, formatting, and diff checks pass; an independent security review found
  no remaining high- or medium-severity issue in this slice.
- Blocker: No authorized live OVHcloud or Contabo credential, billing
  allocation, paid create, adopt, cleanup, or provider-side trace was used.
- Decision: ADR 0046.

## Step 71: Accept an invitation for an existing identity

- Status: local
- Situation: The first-invitation authentication completion could create a new
  identity and membership atomically, but the explicit product route for an
  existing identity still returned 501.
- Task: Let an already Access-authenticated active Gridora identity accept one
  email-bound invitation without creating another identity or weakening the
  existing atomic invitation rules.
- Action: Replace the authorized 501 boundary with the existing atomic
  organization-service invitation acceptance.
- Execution: Verify Cloudflare Access and CSRF through the shared API middleware.
- Execution: Resolve the active local identity by the authenticated Access subject.
- Execution: Require the current Access email to match the persisted identity email.
- Execution: Accept one lowercase 64-character hexadecimal token from the path only.
- Execution: Read no token from a request body, header, cookie, or query parameter.
- Execution: Pass the authenticated identity and token to
  `OrganizationService.acceptInvitation`.
- Execution: Preserve the service's invalid, expired, revoked, accepted, email
  mismatch, existing-membership, and concurrent-consumption behavior.
- Execution: Keep membership insertion, invitation consumption, audit, and
  outbox evidence in the existing atomic D1 unit of work.
- Execution: Return only the strict membership contract with private no-store,
  no-cache, and no-referrer controls.
- Execution: Publish the exact bounded path schema with no request body and no
  generic idempotency header in OpenAPI.
- Execution: Add a generated client method that sends the token only in the
  encoded product path.
- Execution: Keep unknown or new identities on the signed authentication-intent
  completion flow; do not add unauthenticated membership mutation.
- Execution: Do not log, persist, return, or copy the plaintext token beyond the
  product-mandated request path.
- Execution: Disable automatic Cloudflare API invocation logs because they can
  persist the raw path; retain only application-owned structured logs with
  recursive secret-field redaction.
- Evidence: `apps/api/src/invitation-acceptance-routes.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Test: `apps/api/test/invitation-acceptance-routes.test.ts`
- Test: `apps/api/test/invitation-acceptance-contract.test.ts`
- Test: `apps/api/test/composed-boundaries.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Test: `packages/db-d1/test/invitation-sql.test.ts`
- Test: `packages/db-d1/test/invitation-identity-atomic.test.ts`
- Test: `tests/security/infra-boundaries.test.ts`
- Verification: All 104 API tests, all 10 generated-client tests, API and client
  type checks, focused lint, formatting, and documentation integrity pass locally.
- Blocker: No deployed Access assertion, production log-retention inspection,
  live D1 acceptance, invitation email link, browser session, or organization
  switch after acceptance is recorded.
- Decision: ADR 0047.

## Step 72: Establish platform-owned provider account control

- Status: local
- Situation: The default provider path required global platform-owned accounts,
  but only organization-owned credentials and memberships had an executable
  control model.
- Task: Add independently authorized platform accounts, encrypted credentials,
  tenant allocations, and an exact credential-opening boundary without treating
  an organization role as platform authority.
- Action: Persist active or suspended Platform Administrator grants against an
  active global Gridora identity.
- Execution: Read no organization membership when authorizing a platform route.
- Execution: Keep platform secret envelopes separate from tenant envelopes and
  bind encryption to platform-scoped authenticated data.
- Execution: Reuse the narrow Cloudflare KEK port without exposing KEK or
  plaintext provider credentials.
- Execution: Validate add and rotate credentials through the existing read-only
  OVHcloud or Contabo validator before persistence.
- Execution: Commit account metadata, encrypted secret, global audit, and
  idempotency evidence atomically in D1.
- Execution: Hash credential bytes into the request fingerprint without
  persisting or returning the bytes.
- Execution: Clear caller credential, plaintext, and data-key buffers.
- Execution: Fence account, credential, allocation, and replay revisions.
- Execution: Reject rotation or removal while an active node execution lease
  references the provider account.
- Execution: Bound tenant allocation regions, plans, active-node quota, optional
  monthly budget, and active or disabled status.
- Execution: Open a credential only for an active organization-null platform
  account with exact account and credential revisions.
- Evidence: `packages/platform-authority/src/index.ts`
- Evidence: `packages/platform-secret-envelope/src/index.ts`
- Evidence: `packages/platform-provider-control/src/index.ts`
- Evidence: `packages/platform-provider-d1/src/index.ts`
- Evidence: `packages/migrations/sql/0016_platform_provider_control.sql`
- Evidence: `apps/api/src/platform-provider-routes.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Test: `packages/platform-authority/test/platform-authority.test.ts`
- Test: `packages/platform-provider-d1/test/platform-provider-d1.test.ts`
- Test: `apps/api/test/platform-provider-routes.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Verification: The central Worker composes platform authority, control, route,
  secret, and exact credential-opening services separately from organization
  authorization. OpenAPI and the generated client publish the strict platform
  operations. Focused authority, D1, route, client, migration, and type checks
  pass locally.
- Blocker: No deployed Access Platform Administrator grant, Cloudflare Secrets
  Store KEK, D1 mutation, live provider validation, allocation, credential open,
  or paid provider execution is recorded.
- Decision: ADR 0048.

## Step 73: Compose strict node creation and signed provider execution

- Status: live-blocked
- Situation: Node acceptance, leased provider execution, provider transports,
  platform credentials, and early registration existed as separate boundaries.
- Task: Connect one strict public node intent to one exact signed provider step
  and one atomic early registration exchange.
- Action: Replace the public node-create placeholder with `CreateNodeIntent`.
- Execution: Accept the schema version, placement mode, temporary lifetime, and
  non-hourly commitment confirmation only.
- Execution: Reject provider, account, region, plan, image, price, credential,
  and every unknown client field.
- Execution: Authorize the organization role before node acceptance.
- Execution: Commit the accepted node, operation, reservation, audit, outbox,
  and deterministic Workflow start facts atomically.
- Execution: Start or adopt a Workflow only after exact immutable metadata and
  durable start-ledger verification.
- Execution: Dispatch only the signed `create-or-adopt-instance` step for the
  exact provision Workflow, instance, organization, node, operation, and ordinal.
- Execution: Open only the accepted organization or platform credential
  revision and check the account again after the secret is open.
- Execution: Clear credential bytes after every failed post-open check.
- Execution: Select OVHcloud or Contabo from the accepted account type and send
  the fixed cloud-init document.
- Execution: Permit one paid create and make every ambiguous retry adopt-only.
- Execution: Keep empty provider visibility uncertain and schedule retries from
  the durable attempt without passing the registration deadline.
- Execution: Keep the execution lease active and record reconciliation-required
  evidence when the uncertain recovery deadline is exhausted.
- Execution: Bind the first provider instance ID, consume the registration
  token, issue the node credential and session, record installer state, and write
  audit and outbox evidence in one D1 transaction.
- Execution: Return the exact committed registration result after response loss.
- Execution: Reject token expiry, wrong provider, wrong node, wrong operation,
  wrong Workflow metadata, and concurrent conflicts without exposing a secret.
- Execution: Publish the strict node-create and platform contracts in OpenAPI,
  the generated client, and the CLI.
- Execution: Keep readiness under authenticated agent observations.
- Evidence: `apps/api/src/node-provision-runtime.ts`
- Evidence: `apps/api/src/index.ts`
- Evidence: `apps/api/src/contracts.ts`
- Evidence: `workers/workflows/src/index.ts`
- Evidence: `workers/workflows/src/workflow-plan.ts`
- Evidence: `packages/provider-create-transports/src/index.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Evidence: `apps/cli/src/commands.ts`
- Test: `apps/api/test/node-provision-runtime.test.ts`
- Test: `apps/api/test/node-provision-routes.test.ts`
- Test: `packages/provider-create-transports/test/index.test.ts`
- Test: `workers/workflows/test/index.test.ts`
- Test: `packages/node-provision-execution-d1/test/index.test.ts`
- Test: `packages/generated-client/test/client.test.ts`
- Test: `apps/cli/test/commands.test.ts`
- Verification: Focused API, Workflow, provider, execution, D1, generated-client,
  and CLI checks pass locally. Tests prove exact Workflow adoption, one paid
  POST, delayed adopt-only visibility, recovery exhaustion, atomic registration
  replay, strict public input, and credential cleanup after a post-open failure.
- Blocker: No deployed migration, registration token secret, provider credential,
  promoted image, signed Workflow run, live bootstrap, Tunnel readiness, or
  approved provider create-and-delete cleanup run is recorded.
- Decision: ADR 0049.

## Step 74: Execute observed game-server lifecycle operations in isolated jobs

- Status: live-blocked
- Situation: Game-server planning, node observations, Docker/quota boundaries,
  DNS control, and signed agent commands existed as separate contracts. A
  queued command could be reported as success before the game changed state,
  and a plugin installer could otherwise inherit host control from the agent.
- Task: Implement create, delete, start, stop, restart, update, configuration,
  and mod lifecycle execution with durable D1 fences, exact leases, replay,
  authoritative observations, DNS intent, and isolated installer execution.
- Action: Keep public mutation intents free of deployment IDs and workload image
  fields; derive the active deployment and immutable runtime/installer images
  from the tenant-scoped D1 state and signed build-time plugin registry.
- Action: Require exact organization equality during placement, a fresh
  dedicated reservation for dedicated mode, validated DNS names, authoritative
  free TCP/UDP lease allocation, and organization-scoped Steam credential
  references.
- Action: Add migration 0017 for lifecycle mutation fences, command delivery
  replay, observation reductions, and Steam-reference ownership triggers.
- Action: Commit operation, desired revision, deployment or capacity
  reservation, exact leases, audit, outbox, and durable Workflow-start facts in
  one D1 transaction; reject stale configuration or mod revisions unless the
  fenced write is proven.
- Action: Require each agent step to return the exact terminal command result,
  or adopt the exact durable result after response loss, before advancing the
  Workflow.
- Action: Complete only from the tenant/server/operation-bound observation
  reduction at the expected revision and expected terminal state; never use a
  node liveness probe as game health evidence.
- Action: Return the persisted actor and current operation and Workflow state
  on replay; do not fabricate queued state after an operation has progressed.
- Action: Require persisted reservation, release, backup, and DNS evidence;
  treat an omitted domain as an exact pending-operation, null-domain, active
  Workflow, tenant-scoped no-record proof.
- Action: Render configuration beneath stable no-follow directory descriptors,
  write exclusive fsynced temporary files, rename each file atomically, reject
  symlink evidence, and serialize each server's writer against isolated jobs.
- Action: Run SteamCMD, update, and mod plans only in a digest-pinned,
  UID/GID-10001 container with a read-only root, fixed server mounts, bounded
  resources, dropped capabilities, no host namespace, no agent/provider
  secrets, no Docker socket, and the labelled root-provisioned egress policy.
- Action: Ensure response loss, timeout, decode failure, and cancellation try
  to remove only the exact canonical helper container; reject foreign same-name
  containers by full identity and host-shape comparison, including structured
  mounts, device rules, port publication, and restart policy.
- Action: Publish and tear down only organization/server-owned DNS-only A/AAAA
  records through the Cloudflare control boundary and return the actual leased
  host and ports.
- Evidence: `packages/migrations/sql/0017_game_server_lifecycle_execution.sql`
- Evidence: `packages/game-lifecycle-control/src/index.ts`
- Evidence: `packages/game-lifecycle-d1/src/index.ts`
- Evidence: `packages/game-lifecycle-execution/src/index.ts`
- Evidence: `packages/game-lifecycle-execution/src/workflow.ts`
- Evidence: `packages/agent-protocol/src/index.ts`
- Evidence: `apps/agent/src/game-runtime.ts`
- Evidence: `apps/agent/src/executor.ts`
- Evidence: `apps/agent/src/validation.ts`
- Evidence: `packages/docker-runtime/src/isolated.ts`
- Evidence: `packages/docker-runtime/src/quota.ts`
- Evidence: `infra/docker/game-service-egress.example.yaml`
- Evidence: `infra/images/nftables/gridora.nft`
- Test: `packages/game-lifecycle-control/test/index.test.ts`
- Test: `packages/game-lifecycle-d1/test/index.test.ts`
- Test: `packages/game-lifecycle-execution/test/index.test.ts`
- Test: `packages/docker-runtime/test/isolated.test.ts`
- Test: `packages/docker-runtime/test/project-quota.test.ts`
- Test: `apps/agent/test/game-runtime.test.ts`
- Test: `apps/agent/test/agent.test.ts`
- Verification: Focused control, D1, execution, Docker-runtime, agent,
  migration, and Cloudflare-control tests pass locally. The root TypeScript
  check is clean. Tests prove cross-tenant rejection, image immutability,
  dedicated reservation, collision-free leases, stale-write fencing, command
  terminal/replay handling, observation binding, DNS ownership, quota shape,
  isolated container admission, hostile same-name rejection, symlink failure,
  top-level rendering, exact progressed replay, exact no-domain evidence, and
  cleanup-admission behavior. The opt-in repository live Docker
  workload-boundary test `tests/security/docker-boundaries.live.test.ts`
  passed and left no container or network. The ensured timeout/cancellation
  finalizer still needs live-node evidence.
- Blocker: No live Docker packet test has run with a prepared quota tree and
  reviewed digest-pinned plugin image. The root-owned egress/firewall policy,
  deployed API/internal Workflow adapter mapping, and an approved live
  create-to-observation-and-delete run still require environment evidence.
- Decision: ADR 0050.

## Step 75: Orchestrate encrypted backup and source-preserving restore

- Status: live-blocked
- Situation: Backup metadata, private-R2 encryption, node archive handling,
  and restore staging were separate boundaries. Public input could otherwise
  claim authoritative plugin, build, node, revision, or scheduled facts, and
  a lost response could leave an artifact or deletion claim in a false state.
- Task: Implement organization-scoped manual and scheduled backup
  reservation, bounded resumable encrypted upload, manifest/checksum proof,
  retention/list/create/delete, and same-node or cross-node restore with
  validation, atomic cutover, source preservation, rollback, cancellation,
  response-loss adoption, and audit evidence.
- Action: Keep public create input to schema version, includes, and expiry;
  derive backup ID, trigger, server, deployment, node, plugin, build, config,
  mod, desired-state, and consistency facts from D1 and the plugin capability
  manifest. Resolve restore source metadata from the backup artifact and check
  target server, target node, plugin compatibility, capacity, and occupancy
  inside the organization boundary.
- Action: Add migration 0018 for backup revisions/jobs, strict 64-hex
  fingerprints, active-restore fences, ordered step receipts, staged restore
  targets, cutover evidence, retention policy, and two-phase deletion claims.
  Gate operation, backup job/artifact,
  audit, outbox, and Workflow-start writes atomically; a losing idempotency or
  active-restore contender leaves no orphan operation or evidence.
- Action: Use the node's no-follow archive and bounded filesystem policy, a
  private mode-600 resumable state record, 64 KiB–4 MiB chunks, and at most
  65,536 chunks. Keep the reachable maximum exactly 256 GiB. Adopt a remote
  chunk only when index, byte count, and SHA-256 match; never store or log a
  plaintext data key.
- Action: Publish a private R2 manifest only after every encrypted chunk is
  present. Wrap a unique per-backup AES-256-GCM data key and bind each chunk
  to organization, server, backup, operation, plaintext checksum, chunk size,
  and index. Verify the manifest, all checksums, and key scope before restore.
- Action: Claim and revision-fence deletion in D1 before R2 mutation; list and
  delete only the bounded exact prefix, delete chunks before a separate final
  manifest request, reject foreign keys/cursor cycles, and complete the D1
  deletion only after the exact-prefix receipt. Record accepted, failed, and
  completed delete operation/audit/outbox evidence.
- Action: Stage same-server or cross-node restore without replacing the
  source. Validate plugin/build/config/mod state and health, require an
  authenticated monotonic agent observation, cut over endpoints only after
  success, and roll back failed staging while preserving the source.
- Action: Lease each exact ordinal and fingerprint. Require durable external
  adapters to adopt one effect identifier after response loss. Commit cutover
  only through ordered staged, validated, committed, and source-preserved
  receipts with a final D1 abort fence.
- Action: Exclude active restores at both retention candidate and update time.
  Use an organization automation principal for scheduled expiry and isolate an
  invalid or deleting tenant from other retention candidates.
- Action: Authenticate at most 64 KiB of raw internal request bytes and its
  nonce before strict JSON decoding on the canonical `/v1/internal` route.
- Evidence: `packages/migrations/sql/0018_backup_orchestration.sql`
- Evidence: `packages/backup-control/src/index.ts`
- Evidence: `packages/backup-d1/src/index.ts`
- Evidence: `packages/backup-r2/src/index.ts`
- Evidence: `packages/backup-key/src/index.ts`
- Evidence: `packages/backup-key-d1/src/index.ts`
- Evidence: `packages/backup-runtime/src/index.ts`
- Evidence: `packages/backup-workflow/src/index.ts`
- Evidence: `apps/agent/src/backup-archive.ts`
- Evidence: `apps/agent/src/backup-upload.ts`
- Evidence: `apps/api/src/backup-routes.ts`
- Evidence: `apps/api/src/backup-workflow-routes.ts`
- Test: `packages/backup-d1/test/backup-d1.test.ts`
- Test: `packages/backup-r2/test/backup-r2.test.ts`
- Test: `packages/backup-r2/test/deletion.test.ts`
- Test: `packages/backup-workflow/test/backup-workflow.test.ts`
- Test: `apps/agent/test/backup-upload.test.ts`
- Test: `packages/migrations/test/schema.test.ts`
- Verification: Focused backup-control, backup-D1, backup-R2, backup-workflow,
  migration, and agent upload tests pass locally. Tests prove exact
  idempotency/revision replay, cross-tenant isolation, active-restore and
  delete races, audit/outbox evidence, expiry replay, chunk corruption and
  cancellation handling, prefix deletion safety, cursor-cycle rejection,
  wrapped-key manifest integrity, ordered effect-id replay, cutover rollback,
  signed-route replay and size rejection, unsupported-step rejection, and
  observation-gated restore completion. The repository type check is clean.
- Blocker: Deployed migrations/bindings and an approved live-node same-node or
  cross-node cutover/rollback run remain pending. No live credentials or paid
  infrastructure were used.
- Decision: ADR 0051.

## Step 76: Compose destructive drain, retirement, cancellation, and organization tombstoning

- Status: live-blocked
- Situation: Node lifecycle, provider retirement, organization cleanup, generic
  operation cancellation, Durable Object coordination, and signed Workflow
  steps could each claim success without proof of the other boundaries. A
  timeout after a paid provider mutation or a step crash could otherwise either
  repeat the mutation or leave a permanently opaque run.
- Task: Add organization-scoped drain, rebuild, retirement, deletion, and
  cancellation controls that preserve exact provider truth, exact Workflow/DO
  identity, backup/deployment evidence, credential/network cleanup, and a
  retention tombstone.
- Action: Add migration 0019 for SHA-only destructive intent, exact
  cancellation facts, durable Workflow starts, signed-step leases/effect
  receipts, node run/drain records, organization-deletion inventory and
  tombstones, compensation, and atomic evidence receipts.
- Action: Accept an active deployment inventory for drain; do not require an
  empty node at acceptance. Require moved/deleted deployment evidence and the
  configured backup proof before the provider destructive-action claim.
- Action: Keep blocked and ambiguous rebuild/retire runs exclusive for their
  node. Revoke only tenant-owned node credentials, sessions, and registration
  tokens before final retirement.
- Action: Treat OVH deletion as confirmed only after post-delete absence. For
  Contabo secure-wipe-and-stop first, then request earliest-date cancellation;
  record scheduled billing until an exact date and never invent immediate
  deletion.
- Action: Freeze organization mutation, inventory paid and non-paid resources,
  enforce backup retain/delete policy, drain servers, retire nodes, revoke
  credentials, remove DNS/Tunnels, release reservations, and tombstone only
  after physical resolution of every guarded resource.
- Action: Commit cancellation before signaling the stored ResourceOperation DO
  and exact Workflow. Persist each acknowledgement bit with deterministic
  audit/outbox evidence and return only the durable state. Reject unbound,
  terminal, running, destructive-running, cross-tenant, stale, or policy-barred
  cancellation.
- Action: Require signed steps to use opaque expiring claims and exact
  provider/agent effect receipts. On expiry, observe the prior claim: adopt
  exact application, retry only definite non-application, and leave unknown
  paid-provider truth reconciliation-required. Complete only through the
  facts-revision and final completion-receipt transaction fence.
- Evidence: `packages/migrations/sql/0019_destructive_lifecycle_termination.sql`
- Evidence: `packages/lifecycle-termination-control/src/index.ts`
- Evidence: `packages/lifecycle-termination-d1/src/index.ts`
- Evidence: `packages/lifecycle-termination-workflow/src/index.ts`
- Evidence: `packages/provider-retirement-transports/src/index.ts`
- Evidence: `apps/api/src/destructive-lifecycle-routes.ts`
- Test: `packages/lifecycle-termination-control/test/index.test.ts`
- Test: `packages/lifecycle-termination-workflow/test/index.test.ts`
- Test: `packages/lifecycle-termination-d1/test/workflow-step-recovery.test.ts`
- Test: `packages/provider-retirement-transports/test/index.test.ts`
- Test: `apps/api/test/destructive-lifecycle-routes.test.ts`
- Verification: Focused control, signed Workflow, D1, and provider behavioral
  tests pass locally (13 tests total). They prove response-loss adoption,
  successful-false cancellation handling, exact expiry observation, one retry
  only after definite non-application, unknown-provider no-execution,
  completion rollback on a competing facts revision, OVH post-delete proof,
  Contabo scheduled billing, and public cross-tenant/internal-field rejection.
- Evidence: `apps/api/src/cancellation-runtime.ts`
- Evidence: `apps/api/src/organization-deletion-runtime.ts`
- Evidence: `packages/generated-client/src/index.ts`
- Evidence: `apps/web/pages/o/[slug]/settings.vue`
- Verification: Migration 0033 persists bounded immutable HTTP audit
  provenance. Delayed execution tests cover exact replay, tamper and oversize
  rejection, empty inventory, credential revocation, reservation release,
  ready-to-tombstone, final tombstone, and six operation-bound strict-v1 audit
  envelopes. The signed parent executor completes an empty or authoritatively
  pre-cleaned organization and fails closed while any server, deployment,
  backup, node, DNS, or Tunnel item lacks a terminal child receipt.
- Blocker: No deployed migration, provider credential, approved paid
  retirement cleanup, non-empty child cleanup run, or live organization
  tombstone run is recorded. Parent Workflow dispatch is not physical deletion
  evidence and does not bypass these gates.
- Decision: ADR 0052.

## Step 77: Deliver bounded logs, health aggregates, telemetry, realtime streams, and a crash-safe local spool

- Status: live-blocked
- Situation: Operators need tenant-scoped archive logs, live logs, node and
  server health, and bounded alerts. Log delivery can be delayed or replayed,
  the control plane can be offline, and local agent files can be attacked by
  symlinks, weak ownership, weak modes, or concurrent writers.
- Task: Add strict archive and live-log boundaries, aggregate health and alert
  persistence, machine-only telemetry publication, and an ack-based local
  spool that remains safe during retries, crashes, and control-plane outages.
- Action: Enforce organization, node, and server scope in log contracts and D1
  watermarks. Reject duplicate, missing, and out-of-order ranges. Redact
  secret patterns before persistence. Keep cursors, time ranges, entry sizes,
  batch sizes, and archive responses bounded. Keep R2 keys private.
- Action: Store gzip NDJSON under tenant-prefixed R2 keys. Read archives with
  streaming decompression and a max-plus-one byte budget. Adopt a retry only
  when the existing head and content match the exact response-loss digest.
- Action: Store aggregate health and bounded alerts in migration 0020. Bind
  every resource pair to the authoritative deployment on insert and update,
  allow an authoritative server move, and keep provider, backup, and operation
  truth in the control plane. Accept only machine-observed fields from the
  authenticated node.
- Action: Use one-time, short-lived, membership-revision-checked realtime
  tickets. Keep a bounded Durable Object ring and reconnect backlog. Apply
  frame and buffered-byte limits, report cursor gaps, and close on backpressure
  with 1013. Forward no Access or JWT credential.
- Action: Use the file spool only after exact expected UID validation. Require
  directory mode 0700 and artifact mode 0600. Use opened-fd fstat checks,
  O_NOFOLLOW-style flags, exclusive PID/start-time lock records, atomic
  temp-write plus file fsync, rename, and directory fsync. Recover crash
  artifacts and remove records only after acknowledgement.
- Evidence: `packages/log-control/src/index.ts`,
  `packages/log-d1/src/index.ts`, `packages/log-r2/src/index.ts`,
  `packages/health-control/src/index.ts`, `packages/health-d1/src/index.ts`,
  `packages/migrations/sql/0020_logs_health_aggregates.sql`,
  `packages/agent-telemetry/src/index.ts`,
  `packages/agent-telemetry/src/file-spool.ts`,
  `workers/realtime/src/live-log-stream.ts`,
  `workers/realtime/src/live-log-invariants.ts`,
  `apps/api/src/log-monitoring-routes.ts`, and
  `apps/api/src/log-monitoring-realtime.ts`.
- Test: `packages/log-control/test/index.test.ts`,
  `packages/log-d1/test/index.test.ts`, `packages/log-r2/test/index.test.ts`,
  `packages/health-control/test/index.test.ts`,
  `packages/health-d1/test/index.test.ts`,
  `packages/agent-telemetry/test/index.test.ts`,
  `packages/agent-telemetry/test/file-spool.test.ts`,
  `workers/realtime/test/live-log.test.ts`,
  `apps/api/test/log-monitoring-routes.test.ts`, and
  `apps/api/test/log-monitoring-realtime.test.ts` cover redaction, replay,
  response loss, cursor and tenant isolation, health conflicts and moves,
  ticket replay, bounded backpressure, reconnect gaps, and spool concurrency,
  crash, oversize, age, symlink, UID, and mode behavior.
- Verification: Local focused checks pass, including the agent-telemetry
  package check and tests, realtime check/build/tests, API log tests, and root
  `pnpm typecheck` with no type errors. The focused file-spool lint also passes.
  No deployed R2, D1, or Durable Object test and no production agent
  filesystem, live reconnect, or control-plane outage run has been performed.
- Blocker: Deployment composition and live evidence remain pending. The
  central API index, shared contracts, generated client, CLI, web UI, Cloudflare
  bindings, and approved production filesystem exercise are outside this step.
- Decision: ADR 0053.

## Step 78: Schedule read-only orphan reconciliation

- Status: live-blocked
- Situation: Orphan discovery could validate a bounded provider list, but it
  had no active path from a cron trigger to a durable Workflow and the real
  provider runtime. A queue retry, lost create response, disabled allocation,
  or credential rotation could otherwise start the wrong work or write stale
  tenant evidence.
- Task: Schedule one bounded, tenant-scoped, read-only orphan reconciliation
  for each exact active provider allocation. Preserve deterministic retry and
  Workflow adoption. Record high-severity findings, audit data, and events.
  Never delete or otherwise change a provider resource.
- Action: Add migration 0021 for one protected scheduler automation principal
  per organization and for one D1 schedule lease per organization, provider
  account, and schedule slot. Derive task, run, idempotency, Workflow, and
  lease identifiers from this exact tuple. Keep provider credentials and
  provider responses out of cron, queue, Workflow input, events, and logs.
- Action: Make the queue Worker own the ten-minute cron. Read at most 25
  active allocations. Persist the lease before queue send. Move the exact
  lease to running before Workflow create. On a lost create response, adopt
  only the same deterministic Workflow ID. Do not enumerate an account without
  an active allocation.
- Action: Run one fixed Workflow step. Sign its exact task and organization for
  the internal API route. Recheck the signed route, nonce, tenant header,
  idempotency key, running lease, active organization, allocation, account,
  scheduler automation principal, and automation membership before credentials
  are opened.
- Action: Use the live OVHcloud and Contabo list-only adapters. Use fixed HTTPS
  endpoints, a bounded response, one bounded page, and at most 200 nodes.
  Reject pagination, continuation, malformed ownership, foreign tenant data,
  and provider mutation capability. Do not use a delete, stop, create, update,
  rebuild, or retire provider operation.
- Action: Bind each discovery plan to its exact credential reference and
  revision. Check active allocation, account, organization, scheduler
  automation principal, membership, and credential state before writes. Make a
  final D1 run-insert trigger check the same facts inside the final atomic
  batch. If an allocation is disabled or a credential rotates after discovery,
  roll back the finding, run, audit, and export data.
- Action: Write only high-severity orphan findings. Publish a secret-free
  organization event after the persisted result and before task completion.
  Reuse the durable result after response loss. Do not delete a provider
  resource as part of reconciliation.
- Evidence: `packages/migrations/sql/0021_scheduled_orphan_reconciliation.sql`,
  `packages/orphan-schedule/src/index.ts`,
  `packages/orphan-provider-live/src/index.ts`,
  `packages/orphan-d1/src/index.ts`, `apps/api/src/orphan-runtime.ts`,
  `apps/api/src/index.ts`, `workers/queue-consumers/src/index.ts`, and
  `workers/workflows/src/orphan-reconciliation.ts`.
- Test: `packages/orphan-schedule/test/index.test.ts`,
  `packages/orphan-provider-live/test/index.test.ts`,
  `packages/orphan-d1/test/index.test.ts`,
  `workers/queue-consumers/test/orphan-reconciliation.test.ts`,
  `workers/workflows/test/orphan-reconciliation.test.ts`, and
  `apps/api/test/orphan-composition.test.ts`.
- Verification: Focused orphan package, migration, queue, Workflow, and API
  tests and type checks pass locally. Tests prove active-allocation selection,
  25-item bound, forged-tenant rejection, D1 and Workflow response-loss
  adoption, signed route and tenant binding, fixed bounded provider discovery,
  high finding/audit/event output, no provider DELETE request, and rollback
  when allocation state or credential revision changes before final commit.
  Queue, Workflow, and API Worker dry-run builds pass locally.
- Blocker: No deployed migration 0021, queue binding, Workflow binding,
  internal request secret, KEK, encrypted provider credential, or approved
  non-production provider account has been used. No live provider listing,
  queue delivery, Workflow execution, D1 migration, or production event is
  recorded.
- Decision: ADR 0054.

## Step 79: Align registration defaults and state slug evidence truthfully

- Status: live-blocked
- Action: Set the checked API and infrastructure registration default to
  `open`. Keep `invitation-only` and `closed` as explicit protected operator
  choices. Reject an invalid configured value.
- Action: Validate slug syntax in the browser. State that availability is
  checked on submit. Use the setup API, current registration policy, D1 unique
  constraint, and atomic organization-and-initial-Owner write as the authority.
- Evidence: `apps/api/wrangler.jsonc`, `infra/cloudflare/wrangler.api.jsonc`,
  the registration policy and organization setup handlers, and the setup-page
  helper text.
- Test: Registration policy unit and HTTP tests cover open,
  invitation-only, closed, and invalid modes. Web tests cover the truthful slug
  helper text.
- Verification: The relevant local tests and type checks pass. The checked
  configurations use `open`, and the UI does not claim local availability.
- Blocker: No Worker or Cloudflare Access policy was deployed. No production D1
  database or concurrent live organization setup was used.
- Decision: ADR 0055.

## Step 80: Add organization-scoped automation identities

- Status: live-blocked
- Situation: An unattended CI job or external integration needs limited
  organization access. It must not reuse a human Access session, keep a plain
  credential, or gain a human administrator role.
- Task: Add revocable automation identities with high-entropy one-time
  credentials, explicit scopes, expiry, last-use data, immediate revocation,
  and exact mutation evidence.
- Action: Store only a credential hash and redacted evidence in migration 0022.
  Return the plain credential only at create or rotate. Do not place it in a
  list response, audit record, outbox record, replay receipt, or log.
- Action: Authenticate a machine credential with a constant-time hash
  comparison. Recheck active organization, identity, credential, creator, and
  membership state. Apply bounded rate-limit and replay behavior. Keep machine
  credential authentication separate from human Cloudflare Access.
- Action: Use a default-deny scope map. Permit only named inventory, server,
  node, backup, log, and operation actions. Deny wildcard scope, organization
  administration, policy changes, destructive administration, and human role
  escalation.
- Action: Require an active Owner or Administrator for create, rotate, and
  revoke. In one D1 batch, bind organization, actor, actor membership revision,
  identity revision, idempotency key, audit, and outbox data. Reject a request
  if a role demotion or organization disable occurs before the final write.
- Evidence: `packages/migrations/sql/0022_automation_identity_credentials.sql`,
  `packages/automation-identity-control/src/index.ts`,
  `packages/automation-identity-auth/src/index.ts`,
  `packages/automation-identity-d1/src/index.ts`,
  `apps/api/src/automation-identity-routes.ts`, and
  `apps/api/src/automation-identity-auth.ts`.
- Test: The automation identity control, authentication, and D1 tests cover
  scope denial, forged tenant input, expiry, immediate revocation, stale
  rotate/revoke, demotion before final write, disabled organization, response
  loss, exact replay, rate limits, and credential redaction.
- Verification: Focused package checks and tests pass locally. The route
  adapters remain isolated, so this is local behavior evidence only.
- Blocker: The central API does not yet register these route adapters or select
  their D1 layer. No D1 migration, Worker route, Cloudflare Access policy, live
  credential, CLI, web screen, or generated client was deployed or exercised.
- Decision: ADR 0056.

## Step 81: Control platform node images and provider registration

- Status: live-blocked
- Situation: A platform image can reach a provider account. A lost response,
  stale account, forged policy scope, or repeated visibility delay can otherwise
  create a paid image twice or report a false promoted result.
- Task: Add a platform-only image lifecycle with immutable proof, one exact
  signed Workflow step, leased provider registration, adoption after uncertain
  results, atomic audit/outbox facts, safe promotion and rollback, and explicit
  degraded fallback handling.
- Action: Add migration 0023. Bridge old candidate and retired rows without
  claiming current proof. Use `building`, `testing`, `promoted`, `deprecated`,
  and `revoked`. Keep the provider type, account, region, and architecture
  immutable for each policy scope.
- Action: Require a Platform Administrator revision and trusted build, scan,
  test, SBOM, signature, source commit, architecture, and artifact evidence.
  Pin the trusted signer. Do not trust caller pass flags. Validate the agent
  input graph through plugin-registry, plugin SDK, contracts, and game-plugin
  inputs.
- Action: Write the resource, audit event, operation, outbox event, and
  Workflow-start fact in one D1 batch. Bind the signed Workflow body to the
  exact stored operation. Use one deterministic native Workflow ID. Adopt that
  exact ID when a native create response is lost.
- Action: Store a receipt claim ID, lease, recovery deadline, and one-way
  provider-dispatch mark. Retry a local pre-dispatch failure. After dispatch,
  use adoption only. Record a redacted terminal failure after a definite
  provider error or an expired recovery window.
- Action: Pin and recheck the active platform provider account revision and
  credential reference before provider dispatch and settlement. Use bounded
  OVHcloud and Contabo registration/adoption seams. Do not compose a live
  provider transport.
- Action: Store each uncertain result with its exact post-update registration
  revision. Bind the final receipt, registration, and operation update in one
  D1 batch. This allows more than one bounded adoption poll and rejects a
  competing registration transition.
- Action: Allow stock Ubuntu plus fixed cloud-init only when the scope policy
  permits it. Store it as degraded. Never report it as a promoted custom image.
  Do not delete an image that an active scope uses.
- Evidence: `packages/migrations/sql/0023_node_image_lifecycle.sql`,
  `packages/node-image-control/src/index.ts`,
  `packages/node-image-d1/src/index.ts`,
  `packages/node-image-execution/src/index.ts`,
  `packages/node-image-workflow/src/index.ts`, and
  `packages/provider-image-registration/src/index.ts`. The isolated HTTP
  boundary is `apps/api/src/node-image-routes.ts`.
- Test: Focused tests cover signer pinning, forged scope, stale platform
  authority, replay, signed-step scope, response-loss Workflow adoption,
  account disable/rotation before dispatch, crash recovery, pre-dispatch
  release, uncertain polling, terminal result, in-use refusal, revoked-image
  selection, and D1 race rollback. OVHcloud and Contabo transport contract
  tests cover fixed registration/adoption inputs.
- Verification: Focused node-image control, D1, execution, Workflow, provider
  registration, and migration checks/tests pass locally. The image workflow
  validates synthetic signed update inputs and protected build-input wiring. It
  does not create a Packer image or a provider resource.
- Blocker: The central API entry point, generated client, CLI, web UI,
  Cloudflare Workflow binding, provider credential resolver, D1 migration, and
  live OVHcloud or Contabo transport remain uncomposed or unapproved. No live
  provider image was created, promoted, rolled back, revoked, or deleted.
- Decision: ADR 0057.

## Step 82: Add exact non-destructive node runtime lifecycle execution

- Status: live-blocked
- Situation: Start, stop, reboot, and reconcile can change a paid VPS. A
  provider success response does not prove the VPS changed. A worker can lose a
  claim response, crash before dispatch, or fail while it observes a request
  that the provider may already have accepted.
- Task: Add organization-fenced start, stop, reboot, and reconcile intent and
  execution. Bind every action to the exact provider account, allocation,
  credential reference, revisions, lease, idempotency key, audit, outbox, and
  Workflow-start data.
- Action: Use migration 0024 to atomically accept node desired state,
  operation, workflow-start, execution, audit, outbox, and idempotency data.
  Require an active organization, allowed Owner/Administrator/Operator role,
  exact node revision, and explicit provider capability. Do not accept a
  provider ID or credential in the public intent.
- Action: Capture and recheck provider account, allocation, credential
  reference, provider type, provider instance, and exact revisions. Open only
  a credential-scoped provider adapter for that stored binding. Do not use a
  global same-provider adapter.
- Action: Lease an exact execution and write a durable dispatch mark before a
  provider action. If a lease expires before a dispatch mark, a later worker
  may dispatch once. If a dispatch mark exists, a later worker observes only.
  Use final D1 receipt guards so a stale node, operation, lease, observation,
  audit, or outbox write aborts the full batch.
- Action: Treat only a provider-specific proof of non-application as a safe
  start/stop unlock. Never infer reboot from request success or normal active
  observation. Keep an ambiguous delivery or a post-dispatch observation error
  in reconciliation; do not roll the node back as a proven non-action.
- Evidence: `packages/migrations/sql/0024_node_runtime_lifecycle.sql`,
  `packages/node-runtime-lifecycle-control/src/index.ts`,
  `packages/node-runtime-lifecycle-d1/src/index.ts`,
  `packages/node-runtime-lifecycle-execution/src/index.ts`, and
  `packages/provider-node-lifecycle-transports/src/index.ts`.
- Test: Focused tests cover tenant, role, revision, provider capability, exact
  account selection, account/allocation/credential revision changes, claim and
  dispatch response loss, crash before dispatch mark, action-requested
  observation, definite non-application, reboot manual reconciliation, and a
  post-dispatch observation authentication failure.
- Verification: Focused package checks and tests pass locally. Migration 0024
  applies through the registered local sequence. A security reread found no
  remaining High or Medium issue in this isolated slice.
- Blocker: The central API, Worker, Workflow, CLI, web application, generated
  client, exact credential resolver, and live provider binding are not yet
  composed. No D1 migration, provider credential, provider action, Workflow,
  or live node was used.
- Decision: ADR 0058.

## Step 83: Stage signed node-agent updates through immutable root rollback authority

- Status: live-blocked
- Situation: The node agent needs security updates, but an unprivileged agent
  must not overwrite `/usr/local/bin`, select a root filesystem path, or make a
  root helper execute a caller-controlled command. A signed historical binary,
  redirect, symlink, lost restart response, or failed health check can otherwise
  downgrade or strand a node.
- Task: Add a separately signed, digest-bound node-agent update command with
  bounded staging, immutable privileged activation, continuous health
  probation, exact rollback, response-loss adoption, and monotonic release
  floors.
- Action: Bind `agent.self-update` to the signed organization/node/operation
  command and an Ed25519-signed manifest containing version, release sequence,
  security epoch, architecture, HTTPS source, SHA-256, byte size, and exact API
  compatibility. Reject a non-HTTPS source, redirect, non-allowlisted host,
  oversized artifact, bad signature, incompatible architecture/API, and stale
  sequence or epoch.
- Action: Stage only digest-derived fixed filenames under the agent-owned
  `0700` staging directory. Require no-follow exclusive writes, mode `0600`,
  exact UID/GID, SHA-256, file fsync, rename, and directory fsync. Send the root
  helper only the digest-bound activation tuple, never a URL, path, or shell
  input.
- Action: Make the image-baked root helper re-verify the fixed staged artifact,
  serialize activation with a root lock, persist activating intent, atomically
  update `current`, and require continuous `systemctl is-active` plus exact
  health receipts through probation. Adopt an exact post-crash receipt with no
  second activation; otherwise roll back to the exact prior release. Keep
  active/previous releases and safely collect older verified releases.
- Action: Have Packer verify and atomically seed the signed baseline release,
  current link, and anti-downgrade root state before it enables the agent. Run
  mutable agent code through a fixed root-owned launcher; run setup and socket
  helper code only from the immutable baked binary.
- Evidence: `packages/agent-protocol/src/index.ts`,
  `apps/agent/src/self-update.ts`,
  `apps/agent/src/agent-update-helper.ts`,
  `apps/agent/src/self-update-health.ts`,
  `infra/images/systemd/gridora-agent-update*.service`,
  `infra/images/systemd/gridora-agent-update.socket`,
  `infra/images/gridora-agent-current`, and
  `infra/packer/scripts/provision.sh`.
- Test: `apps/agent/test/self-update.test.ts` covers first stage, hostile path,
  concurrent activation, active probation, rollback, crash adoption, unknown
  outcome, response loss, downgrade rejection, and retention. Existing agent
  transport tests cover the image service contract.
- Verification: Focused agent and protocol type checks/tests and the agent
  bundle build pass locally. `bash -n` passes for the launcher and Packer
  provision script. The Packer script runs `systemd-analyze verify` during an
  actual Ubuntu image build. The concurrent API type check is currently blocked
  by unrelated `GameLifecycleD1Client` and log-monitoring diagnostics outside
  this step.
- Blocker: No protected release-signing key, signed production manifest,
  Packer image, systemd service, socket, or live node update has been approved
  or run. Live probation and rollback evidence requires an explicitly approved
  non-production node with bounded cleanup.
- Decision: ADR 0059.

## Step 84: Reconcile scheduled organization policy actions

- Status: live-blocked
- Situation: A temporary node can expire. A server can remain idle. An approved
  update can enter a maintenance window. A cron task can run after the policy,
  lease, automation membership, resource, health fact, or update revision
  changes. A retry can otherwise target a different tenant or repeat a request.
- Task: Add bounded automatic policy reconciliation. Keep the exact tenant,
  policy revision, resource revision, automation identity, lease, idempotency
  key, and lifecycle receipt. Do not claim a provider, node, or game result.
- Action: Add migration 0025. Store immutable temporary-node expiry facts,
  scheduler automation identities, bounded D1 schedule leases, runs, policy
  actions, update candidates, activity facts, and final authority triggers.
  Keep a NULL expiry non-actionable.
- Action: Derive a deterministic task, lease token, run ID, idempotency key,
  and Workflow ID from one organization and schedule slot. Use a bounded D1
  page. Start or adopt only the same Workflow. Reject a forged tenant, stale
  policy, expired lease, replay mismatch, revoked scheduler membership, or
  changed resource.
- Action: Plan temporary node retirement, idle shutdown or delete, and
  maintenance-window-gated approved updates from current D1 facts. Store exact
  config and mod revisions for updates. Recheck all facts in final D1 triggers
  before normal node or game lifecycle acceptance.
- Action: Send node retirement only through the immutable scheduler
  `retire-node` exception. Send server stop, delete, and update only through
  the existing game lifecycle repository. Write audit and outbox evidence. An
  accepted action is not a completed provider, agent, or game action. Never
  silently delete a resource.
- Evidence: `packages/migrations/sql/0025_scheduled_policy_reconciliation.sql`,
  `packages/policy-schedule/src/index.ts`,
  `packages/policy-reconciliation-control/src/index.ts`,
  `packages/policy-reconciliation-d1/src/index.ts`,
  `workers/queue-consumers/src/policy-reconciliation.ts`,
  `workers/workflows/src/policy-reconciliation.ts`, and
  `apps/api/src/policy-reconciliation-routes.ts`.
- Test: Focused tests cover bounded scheduling, deterministic replay adoption,
  forged tenant input, temporary expiry, idle health facts, maintenance
  windows, stale policy/resource rollback, exact update config/mod revisions,
  and exact lifecycle acceptance bindings.
- Verification: The focused migration, policy schedule, policy control, policy
  D1, queue consumer, and signed API-route checks pass locally. The
  policy-specific Workflow test passes locally. The shared Workflow package
  compiler has separate concurrent node-image diagnostics outside this policy
  composition. The central API registers the route with the existing global
  signed-request and replay-nonce guard, real D1 stores, lifecycle boundaries,
  and organization event publication.
- Blocker: No live Cloudflare queue, Workflow, D1 database, provider
  credential, provider call, agent action, or resource change was approved or
  run. A live test needs an approved non-production organization and bounded
  cleanup.
- Decision: ADR 0060.

## Step 85: Make organization self-leave atomic and replay-safe

- Status: live-blocked
- Situation: A user must be able to leave an organization without receiving
  administrator authority. The final Owner must remain protected. A lost 204
  response occurs after the membership is gone, so ordinary membership
  authorization cannot validate the retry. Existing realtime sockets must stop
  receiving tenant events after access is removed.
- Task: Delete only the authenticated user's exact membership. Commit the
  audit and outbox evidence in the same transaction. Adopt an exact prior
  success. Close the affected principal's organization event sockets.
- Action: Add migration 0026 and its immutable leave receipt. Bind the receipt
  to the organization, Access identity, expected membership revision, current
  human role, correlation ID, event ID, and timestamp. Delete the membership
  only when it is active and another active Owner remains when required.
- Action: Authenticate the global Access identity before receipt lookup. Return
  204 for an exact organization, identity, and revision receipt. Require a live
  organization membership for every new leave request.
- Action: Publish `organization.membership.left` through the immediate
  OrganizationEvents path. Close all sockets tagged for the affected principal
  in the same way as administrator revocation.
- Action: Use the canonical `/actions/leave` route in the generated client,
  CLI, and web settings page. Remove the organization from browser state only
  after the API succeeds.
- Evidence: `packages/migrations/sql/0026_organization_membership_leave.sql`,
  the membership repository and service, the API route, queue consumer,
  realtime coordinator, generated client, CLI, and web settings page.
- Test: D1 tests cover final-Owner protection, stale revisions, atomic evidence,
  and exact replay. The API route test adopts a lost 204 without a membership
  query. Queue and realtime tests cover immediate socket revocation. Client,
  CLI, and web checks cover the exact route and revision body.
- Verification: The focused API, D1, migration, queue, realtime, generated
  client, CLI, and web checks pass locally. The security reread found no
  remaining HIGH or MEDIUM issue in this slice.
- Blocker: No Worker, D1 migration, Queue, Durable Object, or Cloudflare Access
  policy was deployed. No live organization membership was removed.
- Decision: ADR 0061.

## Step 86: Bound health and log observation reads

- Status: live-blocked
- Situation: Observation storage needed a tenant-scoped current and history API.
  Same-time health writers, ambiguous query fields, synthetic live-stream
  targets, and a server-global membership revision could produce conflicting
  state, unnecessary Durable Objects, or cross-principal denial.
- Task: Settle observation races at the committed row. Bound every read and
  telemetry body. Bind live authorization to the exact server and principal.
- Action: Add current-health reads and bounded hourly history. Use a conditional
  upsert followed by an exact authoritative post-read when the write changes no
  row. Accept only identical replays or a newer committed sample.
- Action: Reject unknown and repeated health and log query fields. Enforce page,
  timestamp, range, identifier, archive, and tenant limits.
- Action: Verify the active organization/server before live-ticket issue or
  upgrade. Store membership revision per principal in the live-log Durable
  Object. Register the fixed stream route before the archive wildcard.
- Action: Map malformed or chunked-oversize telemetry to 400 and a failed stream
  open to 503. Bind the log R2 bucket and live-log Durable Object in checked
  Worker and infrastructure templates.
- Evidence: The health control and D1 packages, API health and log registrars,
  live-log composition and Durable Object, Wrangler files, and Terraform bucket
  declarations.
- Test: Focused tests cover same-time contenders, tenant reads, query ambiguity,
  synthetic servers, telemetry byte bounds, stream failure, principal revisions,
  and infrastructure bindings.
- Verification: The focused tests and health D1 and realtime type checks pass
  locally. Security review found no remaining HIGH or MEDIUM issue in the
  isolated observation slice.
- Blocker: The production API does not register these routes until the exact
  machine-authenticated D1/R2 ingestion adapter is composed. No Worker, D1, R2,
  or Durable Object was deployed.
- Decision: ADR 0062.

## Step 87: Permit Viewer audit history reads

- Status: live-blocked
- Situation: The product grants Viewers read-only audit history, but the API
  required an Administrator for the audit inventory routes.
- Task: Match the role contract without weakening tenant isolation or audit
  mutation controls.
- Action: Set the central audit list and detail routes to the Viewer minimum
  role. Keep the active membership check and organization predicate on every
  repository read.
- Evidence: The audit inventory registration in `apps/api/src/index.ts` and the
  organization-scoped D1 inventory repository.
- Test: The inventory HTTP test uses a real Access-authenticated Viewer, inserts
  one local and one foreign audit event, and receives only the local event.
- Verification: The focused central inventory HTTP test passes locally.
- Blocker: No live Worker, Access policy, or D1 database was used.
- Decision: ADR 0063.

## Step 88: Record complete immutable audit evidence

- Status: live-blocked
- Situation: Compact audit rows did not carry all mutation evidence. Platform
  events needed export without a false tenant owner. Some old writers could
  write a row without an exact operation or a complete envelope.
- Task: Store complete versioned audit evidence. Bind each new audit event to
  the exact operation. Export tenant and platform evidence to separate R2
  partitions. Keep old evidence visible as legacy.
- Action: Add migration 0028. Add immutable tenant and platform envelopes,
  platform operations, actor bindings, strict staging, and immutable export
  outboxes. Reject direct post-migration compact audit inserts.
- Action: Check the staged envelope against the operation and compact audit
  row. Check scope, organization, actor, action, target, correlation, result,
  timestamp, and after-state. Require a terminal succeeded operation for a
  succeeded audit result.
- Action: Redact secret-shaped data before D1, Queue, and R2. Reject raw SQL
  envelopes that have a secret value, invalid union, invalid calendar value,
  excess property, or data over the archive budget.
- Action: Add one HTTP request context. Use one safe request ID and correlation
  ID for the response, operation, audit, and log. Store trusted Cloudflare IP
  and validated Access facts when they exist. Require explicit machine or
  scheduler source facts for non-HTTP work.
- Action: Store one source origin in each complete envelope. Use `http`,
  `machine`, `scheduler`, or `internal`. For a human HTTP event, require the
  Access subject, issuer, email, and identity ID. Check the subject and email
  against the durable identity. For a machine event, do not store an Access
  session. For a scheduler or internal event, do not store client IP or Access
  evidence.
- Action: Use the immutable staging time as the admission clock. Reject an
  event more than five minutes after this time. Store the same value as
  `admittedAt` in the Queue message. Queue and R2 use this pair. They do not
  use the later Queue worker clock.
- Action: For policy and orphan reconciliation, write a terminal scheduler
  operation, a staged v1 envelope, and the compact audit row in one D1 batch.
  On a lost D1 response, read the committed run. Do not write a second audit
  operation or a second audit row.
- Action: Send full v1 tenant and platform messages to Queue. Lease platform
  outbox rows. Archive tenant evidence under the organization prefix and
  platform evidence under the platform prefix. Adopt an exact R2 object after
  a lost response.
- Action: Join the full envelope in tenant audit inventory reads. Show schema
  version and capture status in the API, generated client, and web audit view.
- Evidence: `packages/audit-contracts`, migration 0028, `packages/audit-d1`,
  the Queue audit exporter, inventory contracts and repository, HTTP request
  middleware, generated client, and web audit page.
- Test: Migration tests cover v1/legacy evidence, tenant/platform isolation,
  operation and row mismatches, actor spoofing, state unions, timestamps,
  redaction, bounds, immutability, and response loss. Queue tests cover tenant
  and platform producer-to-R2 export and R2 response loss. Inventory tests
  return complete v1 detail and label legacy evidence.
- Verification: Focused local tests and type checks are required before release.
  The mutation inventory lists each HTTP, platform, machine, and scheduler
  writer and records the real owner, operation path, and audit path. It keeps
  a conversion as a release blocker. It does not claim zero conversions before
  all owners complete their work.
- Blocker: No live Worker, D1 database, Queue, R2 bucket, Access policy, or
  game server was deployed or changed.
- Decision: ADR 0064.

## Step 89: Compose node lifecycle control and image release evidence

- Status: live-blocked
- Situation: Node runtime, destructive lifecycle, image, provider, and UI
  packages had local contracts but did not by themselves prove canonical public
  actions, exact terminal cleanup, representative image evidence, or a
  provider-backed release artifact.
- Task: Compose the typed node control surfaces and exact D1/Workflow paths.
  Preserve strict v1 audit evidence, response-loss adoption, cancellation, and
  tenant fencing. Make the image evidence and firewall checks representative of
  the produced node image. Keep release blocked until protected provider smoke
  evidence is real.
- Action: Register canonical node start, stop, reboot, reconcile, drain,
  uncordon, rebuild, and delete/retire contracts with revision and idempotency
  fences. Use the node-runtime or destructive lifecycle ledger as applicable.
  Refetch authoritative state in the web API mode and remove obsolete public
  501 fallbacks.
- Action: Bind every accepted or completed node/provider mutation to an exact
  durable operation and staged complete v1 audit envelope. Preserve the
  immutable HTTP request provenance for delayed machine Workflow writes. Export
  an operation-bound retirement receipt only after exact provider terminal,
  stopped-billing, credential revocation, explicit Tunnel/node deletion, and
  cancellation/atomic receipt facts exist.
- Action: Extract a read-only rootfs archive from the QCOW2. Require a
  non-empty package inventory, SBOM/scan binding, and Cosign verification.
  Replace global nftables flush with Gridora-table-only replacement and exercise
  a privileged Docker reload proof with allowed and denied game ports.
- Action: Define the protected `provider-image-smoke` manual-dispatch job after
  the exact signed `build-local` artifact. Require explicit approval, a TTL of
  at most 60 minutes, and protected provider, region, and plan allowlists.
  Verify the exact artifact before any live provider action. Fail closed until
  a production adapter can register, boot, observe agent health, adopt a lost
  response, and reconcile cleanup.
- Evidence: `apps/api/src/node-termination-runtime.ts`, the node runtime and
  lifecycle route/control/D1/workflow packages, migration 0044, the
  operation-bound receipt export, `infra/images/nftables/gridora.nft`, image
  evidence scripts, `.github/workflows/image.yml`, ADR 0065, and the release
  evidence test.
- Verification: `pnpm --filter @gridora/lifecycle-termination-d1 test` passes
  9 tests; its package check passes. Image artifact, manifest, and release
  workflow tests pass 8 tests. `pnpm lint` passes. The real privileged CI
  Docker proof and a protected provider run remain unexecuted locally.
- Blocker: The production OVHcloud/Contabo custom-image import, short-lived
  artifact locator, boot/agent-health observer, response-loss adoption, and
  provider image/node cleanup adapter are not yet composed. The protected
  smoke job intentionally fails rather than claim a provider image ID or
  cleanup evidence. No live Cloudflare or provider resource was created.
- Decision: ADR 0065.

## Step 90: Compose production machine telemetry and log publication

- Status: live-blocked
- Situation: The bounded health, log, R2, Queue, Durable Object, and agent
  telemetry packages existed independently. Production composition had to
  prove exact machine scope, archive bytes before metadata, atomic receipt and
  audit evidence, and retry-safe live delivery without claiming a deployed
  service.
- Task: Register the real health/archive/live-log/telemetry API, client, CLI,
  web, R2, Queue, and Durable Object boundaries. Accept only the exact active
  credential/session and active deployment on its authenticated node. Preserve
  archive truth when live delivery fails.
- Action: Add migration 0029. Persist a machine audit identity, server-scoped
  log watermark, immutable ingestion receipt, and pending live-publication
  record. Bind each receipt to credential and session version, organization,
  node, server/deployment, health sample, log range, archive identity/checksum
  and key, operation, audit event, and accepted time. Guard every fact at D1
  commit; a changed replay conflicts and an exact lost response is adopted.
- Action: Archive canonical bounded gzip bytes to an organization/server R2
  path first. Adopt an existing object only if all immutable content and
  metadata match exactly. In the final D1 batch write archive metadata and
  watermark, deterministic node health aggregates/alerts, receipt, pending
  publication, completed machine operation, actor binding, staged v1 audit,
  and audit row. Do not infer server or container health from a node telemetry
  body.
- Action: Send only immutable archive identity/checksum to Queue. The consumer
  re-reads exact D1/R2 evidence and sends bounded entries to the exact
  organization/server Durable Object. The Durable Object atomically records
  archive identity before broadcast so Queue retry or response loss cannot
  replay a live archive. Archive read remains available if live publication
  fails.
- Action: Register fixed `/logs/stream` paths before the archive wildcard.
  Issue a one-time, short-lived, membership-revision fenced ticket for one
  server. Add bounded Viewer health/archive reads and real generated-client,
  CLI `logs`, and web observability behavior. Keep `console` unsupported only
  because no current built-in plugin declares console capability.
- Evidence: `packages/migrations/sql/0029_telemetry_ingestion_receipts.sql`,
  `apps/api/src/telemetry-runtime.ts`, health/log route registrars and central
  registration, log R2/control/D1 packages, queue consumer, live-log Durable
  Object, Worker bindings, generated client, CLI, web server page, and ADR 0066.
- Test: Focused tests cover Viewer tenant reads, forged body scope, inactive
  deployment, revoked credential, duplicate and changed replay, concurrent and
  lost D1 response adoption, exact R2 metadata adoption, decompression limits,
  edge IP capture and local-header rejection, operation schema decoding,
  fixed stream precedence, client route encoding, and infrastructure log R2
  bindings.
- Verification: Focused telemetry, migration, log R2, route-contract,
  realtime, generated-client, CLI, web, and infrastructure checks are run
  locally. Central typecheck status must be read with concurrent package errors
  separated from this slice. A fresh HIGH/MEDIUM security review is required
  before release handoff.
- Blocker: No Worker, D1 migration, R2 bucket, Queue, Durable Object, access
  policy, provider resource, node, or game server was deployed or changed.
- Decision: ADR 0066.

## Step 91: Bind core mutations to durable operations

- Status: live-blocked
- Situation: Core identity and organization mutations did not always create an
  exact operation or return a replayable operation response.
- Task: Make each core mutation idempotent by organization, actor, action,
  target, and canonical payload. Commit complete FR-18 evidence atomically.
- Action: Add migrations 0031 and 0038. Store immutable tenant, bootstrap,
  and platform sign-up receipts. Reference identities instead of removable
  memberships. Bound the client key and stored JSON at the D1 boundary.
- Execution: Write the resource change, outbox event, completed operation,
  staged audit envelope, audit row, and receipt in one D1 transaction. Stage a
  self-leave audit before the membership is removed.
- Execution: Return `MutationCompleted` for synchronous core mutations. Keep
  `MutationAccepted` for queued work. Read authoritative state after completed
  responses. Do not return an invitation token or token hash.
- Execution: Use terminal platform operations and complete platform audits for
  sign-up and sign-in. Use a platform bootstrap operation for organization
  creation. Use terminal tenant operations for invitation acceptance and human
  policy updates. Retain a consumed authentication intent only until its
  original expiry and only for exact replay by the bound Access subject.
- Execution: Read the original registration-policy decision before mutable
  identity or invitation facts are evaluated again. Adopt it only for the same
  protected authentication state and intent. Read the invitation acceptance
  receipt before rejecting an already accepted invitation. Reject a new key.
- Execution: Add revision-fenced organization profile update, safe invitation
  resend, and an audited last-organization preference used by web and CLI
  switchers. Keep the slug immutable and keep authorization out of the
  preference. Expose the current Cloudflare Access session as a read-only,
  no-store boundary and direct sign-out to Access.
- Consequences: A response-loss retry adopts the original completed operation;
  a changed payload conflicts without a second mutation. Historical receipts
  do not pin membership rows. Resend delivery keeps token material inside its
  derivation/outbox boundary, and switching never creates global authorization
  state.
- Evidence: `packages/migrations/sql/0031_core_mutation_operations.sql`,
  `packages/migrations/sql/0038_identity_preferences.sql`, core D1 repositories,
  organization and identity services, central API routes, generated client,
  CLI, and web adapter.
- Verification: Focused migration and D1 tests cover key boundaries, actor and
  action scoping, response tampering, same-payload replay, changed-payload
  conflict, exact operation linkage, self-leave after membership removal,
  immutable profile slug, resend token non-disclosure, switch preference
  evidence, sign-up/sign-in adoption, protected-state policy replay, and exact
  invitation-acceptance response-loss adoption. The focused registration,
  invitation, policy, and D1 suites pass 70 of 70. Contract, client, CLI, web,
  and API checks are run locally with shared-workspace failures attributed to
  their owning package.
- Blocker: No Worker or D1 migration was deployed. No live Access request,
  invitation email, organization policy, membership, ownership, profile, or
  preference state was changed.
- Decision: ADR 0067.

## Step 92: Compose backup and destructive lifecycle evidence

- Status: live-blocked
- Situation: Backup, restore, scheduled retention, cancellation, organization
  deletion, and operation progress were implemented in separate slices. The
  product requires one tenant-safe composition and must never represent
  accepted child work, missing resources, or provider acknowledgements as
  completed physical cleanup.
- Task: Compose the exact production ports locally, preserve strict v1 audit
  provenance, expose the supported API, client, CLI, and web actions, and
  project only real operation progress. Keep deployment and live paid-resource
  changes controlled separately.
- Action: Add migration 0030 for canonical UTC backup schedules, registered
  automation identity fencing, deterministic response-loss adoption, and
  count-and-age retention that preserves active restores and retained sources.
- Action: Compose manual backup and restore through signed agent commands,
  encrypted chunked R2 objects, D1 manifests and receipts, signed Workflows,
  and source-preserving endpoint cutover. Keep agent rollback material through
  terminal validation, finalize it only after success, and execute signed
  compensation on every post-stage pre-terminal failure.
- Action: Add migration 0048 for immutable backup acceptance provenance,
  terminal strict-v1 audit receipts, mutually exclusive completion and
  cancellation, immutable cutover snapshots, per-record Cloudflare receipts,
  exact provider and D1 rollback fences, and terminal waiting-reason cleanup.
- Action: Add migration 0052 for immutable deletion provenance and an exact
  operation-bound physical R2 receipt. Preserve expired inventory, claim or
  adopt the deterministic scheduler deletion, delete bounded chunks before the
  manifest, and atomically finish the artifact, claim, operation, audit,
  outbox, and receipt only after exact-prefix deletion succeeds.
- Action: Add migration 0054 to bind failed and cancelled partial-upload
  cleanup to the exact terminal create job and operation. Fence an active
  create, immutable source ownership, and the claimed artifact revision. Block
  concurrent expiry in both repository SQL and a D1 trigger between physical
  R2 deletion and terminal receipt commit.
- Action: Keep every data-owning backup state, including expired, failed,
  cancelled-creating, and deleting artifacts, in organization-deletion
  inventory. Require the exact terminal physical receipt before resolving the
  item, preparing the tombstone, or deleting the organization. Treat missing,
  foreign-prefix, active-upload, or response-ambiguous evidence as waiting.
- Action: Deduplicate overlapping R2 listing pages with an ordered `Set`, bound
  the deletion by unique keys and page count, delete chunks in deterministic
  batches, and keep the manifest last.
- Action: Transfer each DNS record only from its exact owner and content to the
  exact target owner and content. Adopt a lost provider or D1 response, reject
  stale or foreign state, and compensate completed provider items in reverse
  before a failed restore becomes terminal.
- Action: Remove the environment-wide DNS target fallback. Require exactly one
  active DNS-only D1 target-server record before planning a cross-server
  cutover; reject zero, duplicate, or invalid target evidence before any
  Cloudflare call.
- Action: Add migrations 0033 and 0035 for bounded organization-deletion and
  cancellation provenance plus exact child-operation linkage. Reuse captured
  HTTP evidence for human-derived child audits and explicit scheduler or
  internal origins for non-HTTP work.
- Action: Require the operation-bound game cleanup receipt before resolving a
  deleted server. Keep missing or foreign DNS evidence waiting. Adopt exact
  node retire children and require the exact deterministic child operation,
  provider and billing terminal facts, Tunnel deletion, credential revocation,
  and operation-bound retirement receipt before resolving the item. Fence the
  succeeded child row by child operation and row count.
- Action: Add migration 0043 and a generic operation-detail repository. Project
  real workflow steps, retry count, waiting reason, bounded immutable audit
  logs, redacted provider hints, recovery guidance, exact cancellability, and
  a succeeded-resource link. Select the newest 100 persisted logs for a
  chronological display and clear stale waiting text on terminal operations.
  Keep the generic retry action null because no typed retry mutation is
  supported.
- Evidence: Backup R2, control, D1, and Workflow packages; scheduled-backup
  Queue consumer; cancellation and lifecycle-termination packages;
  organization deletion runtime; game cleanup receipt repository; migrations
  0030, 0033, 0035, 0043, 0048, 0052, and 0054; operation detail contracts, D1
  repository, API, generated client, CLI, and web detail page.
- Verification: The latest focused remediation run passes 92 of 92 tests
  across 16 files: migrations 31 of 31, backup D1 18 of 18, backup R2 16 of
  16, endpoint cutover 9 of 9, organization deletion runtime 8 of 8,
  organization-deletion provenance 7 of 7, and scheduled-backup consumer 3 of 3. The tests execute claim, physical R2 deletion, concurrent expiry, and
  terminal receipt commit; delete real failed-upload chunks through
  organization deletion; prove failed and cancelled source-owner fencing;
  reject foreign prefixes; cover overlapping multi-page listings and the
  unique-key maximum; and prove zero or duplicate target DNS rows cause no
  Cloudflare call. Backup D1, backup R2, lifecycle-termination D1, and API
  TypeScript checks pass. This lane's formatting check passes. Repository
  typecheck and lint both exit successfully with one unrelated provider-account
  test warning about spreading a class instance. This record does not claim the
  full repository test or full repository build portions of `pnpm check`.
- Blocker: No live Cloudflare or provider credentials were used and nothing was
  deployed. A nonempty organization must continue waiting until the node
  retirement executor supplies authoritative provider deletion or contract-end,
  Tunnel deletion, credential revocation, and terminal receipt evidence. The
  current node retirement executor intentionally fails closed before provider
  or Tunnel mutation until its immutable provider-binding snapshot adapter is
  composed; this step does not claim those local or live facts.
- Decision: ADR 0068.

## Step 93: Compose truthful game lifecycle terminalization and move cutover

- Status: local
- Situation: A child completion audit could previously look terminal while the
  original accepted lifecycle operation remained non-terminal. DNS authority
  could be configured globally rather than from the accepted deployment, and a
  stopped source move could record rollback without proving physical reverse
  cutover.
- Task: Make the original accepted operation the authoritative terminal fact;
  bind exact audit/DNS/move evidence to its revision; and make every post-stop
  move failure compensate through immutable source/target effect evidence.
- Action: Add migration 0051. Completion atomically advances the original
  operation to succeeded/progress 100/next revision, clears the pending pointer,
  writes the v1 audit evidence and receipt, and adopts only the exact committed
  state after a response loss. Deletion cleanup requires that real parent
  terminal state plus the operation-bound DNS deletion receipt.
- Action: Snapshot per-server DNS authority at accepted create from the selected
  ready node's provider/agent player endpoint. The resolver and receipt recorder
  preserve exact zone, hostname, type, target, and provider receipt; they fail
  closed without this authority and do not accept `pending` or a shared target.
- Action: Persist a move effect before backup/restore. Add migration 0056 with a
  non-authoritative target staging record and an immutable physical-command
  ledger. Stage, validate, and commit target data without moving the deployment
  row. Activate the target only during fenced cutover.
- Action: Record effect-bound backup, restore, validation, cutover, release,
  and rollback receipts. Use exact signed command/result evidence for source and
  target work. On each post-stop failure, restart the source and reverse target
  data, agent, and DNS work before D1 records rollback.
- Action: Compare a Workflow retry with accepted source coordinates. Ignore only
  mutable move phase, source-preserved, and backup progress. Delete DNS from the
  immutable publish receipt zone, provider record ID, type, and target.
- Action: Add typed `moveGameServer` parity to generated client, CLI (`servers
move … --node … --expected-revision …`), and web target-node UI. Web requests
  reuse the operation idempotency key and do not optimistically relocate a
  server.
- Evidence: `packages/migrations/sql/0051_game_lifecycle_terminal_move_dns_repair.sql`,
  `packages/game-lifecycle-d1/src/index.ts`, and
  `packages/game-lifecycle-execution/src/workflow.ts`.
- Evidence: `apps/api/src/game-lifecycle-runtime.ts`,
  `apps/api/src/game-move-native-adapter.ts`, and
  `packages/migrations/sql/0056_game_move_target_staging_evidence.sql`. Central
  API composition supplies the configured bindings without a game-wide DNS
  target fallback.
- Verification: Full migration inventory passes 8 files / 31 tests. Game
  lifecycle D1 passes 14/14. Execution passes 13/13. Cloudflare control passes
  14/14. Direct game runtime passes 12/12. The runtime tests cover actual
  cutover replay, response loss, source restart after a lost stop transition,
  and restore, validation, cutover, and release compensation. Migration, D1,
  execution, and Cloudflare-control type checks pass. The broader API type check
  is blocked by concurrent backup-upload and telemetry contract changes and is
  not claimed here.
- Blocker: No live Cloudflare DNS, backup, provider, node, agent, or Worker
  binding was used. A live release still requires configured bindings and
  explicit deployment approval.
- Decision: ADR 0069.

## Step 94: Remediate epoch-fenced telemetry, live revocation, and archive cleanup

- Status: live-blocked
- Situation: Production telemetry composition needed a security remediation for
  durable agent publication, credential/session renewal, deployment moves,
  live-log revocation, provenance, and the R2/D1 archive-cleanup crash window.
- Task: Preserve only exact machine payloads and archive bytes, prevent old
  deployment or membership state from reaching a current live stream, and keep
  complete v1 machine audit evidence accurate without claiming a live rollout.
- Action: Use the production authenticated agent loop with the file-locked
  telemetry spool. Persist the exact prepared payload before send and remove
  only the receipt's exact contiguous range. Reuse a completed payload receipt
  only within the same organization and node after a credential/session renewal.
- Action: Add migration 0037 for deployment stream epochs, migration 0045 for
  pending-archive cleanup leases, and migration 0046 for immutable retry
  generations. Carry the exact epoch through R2 paths, D1
  receipt/watermark/publication rows, Queue, Durable Object names, tickets,
  frames, and cursors. A cleanup claim fences final receipt acceptance; a retry
  after any cleanup claim uses a distinct archive ID/R2 key, so a stale owner
  can delete only its old tombstone generation.
- Action: Derive server health only from a labelled container that matches the
  authenticated node's current running deployment. Use recursive normalized
  redaction for compound/camel-case secret fields. Pass a real `machine` audit
  request context with trusted edge-IP capture or explicit unavailability.
- Action: Consume committed membership revoke, leave, role-update, and
  organization-suspension outbox events to close epoch-scoped live sockets.
  Validate canonical organization IDs and epochs in web/CLI frames rather than
  trusting an organization slug.
- Action: Add migration 0049 to reserve the exact authenticated
  organization/node/server/deployment epoch sequence and fingerprint before a
  pending upload or R2 write. Adopt a response-lost reservation only when its
  immutable values match; changed or stale same-sequence payloads fail before
  they can amplify R2 or cleanup work. Materialize membership/organization
  authorization generations so a delayed ticket initializer cannot restore a
  revoked membership or suspended/deleted organization. Keep deletion terminal.
- Action: Stamp the receipt, operation, audit event, staged envelope, and
  adoption at Worker acceptance time. Keep `sampledAt` as bounded health
  evidence only (24-hour offline history and five-minute future tolerance), so
  an agent cannot backdate control-plane audit facts.
- Action: Use `storage.transactionSync` for live-log archive publication rather
  than manual SQL transaction commands. Revalidate every connected socket's
  durable organization/membership generation before sending a log frame or
  pong. Replay exact revoked, suspended, and deleted outbox authority cleanup
  after a post-commit response loss. Recover a stale agent spool lock only
  while an exclusive recovery lease holds, and revalidate its token and
  inode/device immediately before unlinking.
- Action: Amend unreleased migration 0055 so the archive deadline starts at
  the actual abortable R2 stream boundary and is joined to the authenticated
  Worker request signal. Do not treat lease expiry, `HEAD=null`, or a grace
  timer as writer termination. An unresolved writer retains its exact key; only
  a settled R2 result records the one-way terminal state. A post-deadline R2
  response cannot commit a receipt and its exact bytes remain cleanup-owned.
  Record failed attempts in the existing epoch reservation with four immutable
  generations, 30-second/two-minute/ten-minute backoff, then quarantine; cap
  each node at 32 unfinished operations, prioritize pending reconciliation
  ahead of cleaned compaction, and compact a physical row only after exact
  cleanup plus the durable ledger outcome. Bound durable live tickets and
  hibernatable sockets per stream and principal, persist socket activity, and
  use a Durable Object alarm to reclaim expired tickets and idle/unauthorized
  sockets without a later publication.
- Evidence: `packages/agent-telemetry`, `apps/agent/src/telemetry.ts`,
  `apps/api/src/telemetry-runtime.ts`, migrations 0037, 0045, 0046, and 0049,
  `packages/migrations/sql/0055_telemetry_archive_upload_watch_fence.sql`,
  `workers/realtime`, `workers/queue-consumers`, route/client/CLI/web adapters,
  the strict audit inventory, and ADR 0070.
- Test: Focused tests cover durable exact acknowledgement, canary redaction,
  captured/unavailable edge provenance, forged deployment health, renewal
  adoption, concurrent/lost D1 response adoption, epoch-bound publication,
  authoritative pre-upload reservation with serial/concurrent conflict bucket
  bounds, acceptance-time audit timestamps, and a real DO delayed-initialize
  revocation race. It also covers the receipt-before-cleanup, stale-lease, and
  expiry/rearm/accept race where a delayed cleaner cannot delete the accepted
  next-generation object. It also covers an R2 stream delayed past its hard
  deadline (including a lost terminal D1 response), a late completion after
  stream consumption that is receipt-fenced then exactly cleaned, four
  generation-bound outage retries followed by quarantine, and a 32-operation
  saturated queue page that still services pending work before cleaned rows. A
  real Workers DO test proves native transaction
  archive persistence plus eviction/response-loss dedupe and injects loss
  after revocation persistence before socket cleanup; broadcast revalidation
  closes the real socket and exact retry clears tickets. A cross-process spool
  race replaces a stale pathname between revalidation points and proves the
  fresh lock remains. Queue retry tests prove a lost DO response produces one
  live delivery. Archive tests cover crash-before-PUT only through an
  unclaimed, exact-key intent and prove no cleanup acts on an unresolved
  writer. A PUT delayed past the hard stream deadline is aborted before it
  writes, while a completion delayed after stream consumption is receipt-fenced
  and its exact bytes remain until terminal cleanup. Real Workers tests fill a
  stream ticket cap, reject an over-cap principal socket, and run the persisted
  idle alarm to reclaim its socket and nonce row.
- Verification: Focused local evidence passed migration tests (8 files/31
  tests), API tests including telemetry runtime (46 files/251 tests), queue
  consumer tests (10 files/48 tests) and typecheck, log-R2 tests/typecheck (1
  file/7 tests), realtime tests/typecheck (3 files/8 tests), agent-telemetry
  tests/typecheck (2 files/12 tests), agent tests/typecheck (11 files/71
  tests), and formatting of ADR 0070, this step, and the strict audit
  inventory. At this checkpoint, `pnpm --filter @gridora/api check`,
  `pnpm test:cloudflare`, repository `pnpm typecheck`, and `pnpm lint` remain
  blocked by concurrent backup-upload type work, not telemetry. Rerun those
  gates after that work settles; a fresh independent security review is
  required before release handoff.
- Blocker: No Cloudflare Worker, Queue, Durable Object, R2 bucket, D1 database,
  Access policy, provider resource, node, or game server was deployed or
  changed. Live-provider/Cloudflare evidence is intentionally not claimed.
- Decision: ADR 0070.

## Step 95: Protect CLI refresh tokens with operating-system storage

- Status: local
- Situation: The CLI needed a durable refresh token, but a plaintext profile
  file would expose the token to file copies, backups, and support bundles.
- Task: Store the refresh token in a supported operating-system credential
  store. Keep the token out of process arguments and fail closed elsewhere.
- Action: Use macOS Keychain through `/usr/bin/security`. Store an encoded value
  through process input. Use Linux Secret Service through `secret-tool`. Send
  the token through process input. Do not add a plaintext fallback.
- Action: Validate the profile name before a credential process starts. Treat a
  missing item as an unauthenticated profile. Treat every other store failure as
  an authentication error. Keep only non-secret profile data in owner-only
  files.
- Evidence: `apps/cli/src/node-runtime.ts`, the CLI requirements in `README.md`,
  and ADR 0071.
- Test: The injected process-adapter test covers macOS and Linux read, write,
  remove, missing-item, unsafe-profile, unsupported-platform, and secret-not-in-
  arguments behavior.
- Verification: The CLI typecheck and 32 CLI tests pass locally.
- Blocker: A real Keychain and Secret Service collection were not changed. A
  Windows credential-store adapter and packaged-binary smoke test are not part
  of this pre-alpha build.
- Decision: ADR 0071.

## Step 96: Compose durable no-fit server plan and apply

- Status: local
- Situation: A game-server request with no ready organization-owned capacity
  needed a truthful plan and a durable path to policy-admitted infrastructure,
  rather than a client-selected provider or local `501` response.
- Task: Use one declarative server/game request for web and CLI, accept an
  idempotent parent operation, wait for authoritative capacity readiness before
  game reservation, and retire only infrastructure created by that parent after
  a deployment failure.
- Action: Decode the canonical server intent, including the explicit
  non-hourly commitment acknowledgement, and pair it with the exact game intent
  for apply. Use plugin capability/schema-driven web fields and generated-client
  requests. Keep provider, image, and node selection in authoritative D1 facts.
- Action: Persist the exact internal reviewed node-provision snapshot in the
  immutable 0042 parent plan: provider account/revision, allocation revision
  and limits, region/plan/catalog/image fences, policy and usage including its
  observation timestamp, billing receipt, and selection digest. Strictly decode
  it only for the Workflow; project it out of public plan/apply responses.
- Action: Start or adopt node control through `submitAccepted(command, reviewed)`
  with the deterministic parent child key. The node adapter verifies the digest,
  adopts an exact replay before mutable reads, and rejects account, allocation,
  catalog, image, policy/usage, or billing drift instead of re-planning.
- Action: Fence game deployment to the accepted plugin ID, version, and channel
  revision. Wait for desired and observed node state plus fresh agent, Tunnel,
  Docker, firewall, and capacity evidence. For an automatic node only, every
  later error, terminal result, non-completed result, or bounded observation
  timeout starts/adopts and waits for the exact canonical retirement child
  before parent terminal failure.
- Action: Show the exact reviewed billing cadence and term in web review. Ask
  for consent only for policy-required monthly/contract offers, not hourly
  billing. Preserve the public `workflowState` through the generated client,
  API adapter, and web mutation result.
- Action: For a policy-required non-hourly offer, return an opaque 64-hex HMAC
  review proof scoped to the actor, organization, canonical request, exact
  provider/region/plan/plugin channel/billing terms, reviewed selection digest,
  and catalogue expiry. Keep the private review evidence out of public
  envelopes. Verify it with the dedicated API-only
  `SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET`; reject malformed, expired,
  altered, cross-scope, or stale proofs as `409 COMMERCIAL_REVIEW_REQUIRED`.
  The console must clear the proof and force an explicit fresh preview rather
  than silently retrying against changed mutable facts. If fresh policy
  admission reports `price_stale` on an apply that carries the proof, map it to
  that same review-required conflict; a first-time preview without a proof
  remains a truthful availability failure and unrelated infrastructure errors
  retain their existing mappings.
- Evidence: `packages/server-plan-control`, `packages/server-plan-d1`,
  migration 0042, `apps/api/src/server-provision-runtime.ts`,
  `workers/workflows/src/server-provision-plan.ts`, generated client, CLI, web
  server apply, and backup restore adapters.
- Test: Server-plan control proves strict internal snapshot decoding/public
  projection; server-plan D1 proves durable observation-clock/digest evidence,
  strict terminal audit, foreign-child rejection, and response-loss adoption.
  Node control/D1 prove review-bound replay and drift rejection. Commercial
  review tests prove unchanged acceptance and stale offer, altered proof,
  cross-organization/actor, and expiry rejection before acceptance; the Hono
  bridge exposes only `COMMERCIAL_REVIEW_REQUIRED` for that typed conflict. An
  actual D1 preview/admission test starts with valid offer A, expires its
  authoritative catalogue facts, observes fresh-preview `503`, and proves
  apply with A's proof is `409` before an operation or Workflow starts.
  Workflow
  failure injection proves readiness failure/timeout, reservation failure, game
  failure, and exhausted compensation evidence retire only the parent-created
  node. Generated-client/CLI/web tests prove opaque-proof forwarding,
  `workflowState`, hourly opt-out, and exact monthly/contract terms.
- Verification: Server-plan-control, server-plan-d1, http-hono-effect,
  generated-client, CLI, and web checks and focused behavior tests pass.
  Focused API route/runtime tests pass, including the `409
COMMERCIAL_REVIEW_REQUIRED` public envelope. Workflow check and 29 tests,
  migration check and 31 tests, the 11-test infrastructure-boundary suite,
  Wrangler type freshness, rendered six-Worker dry runs, and API/Workflow
  dry-run builds all pass locally. Dry runs list `SERVER_PROVISION_PLAN` and
  make no deployment.
- Blocker: No provider account, paid infrastructure, game server, Cloudflare
  Worker, Workflow, Queue, Durable Object, DNS record, backup, or D1 database
  was changed. Live execution requires configured credentials, explicit
  deployment approval, and cleanup reconciliation. Repository-wide aggregate
  gates remain an integration rerun while concurrent game/backup lanes change;
  this step records only the focused evidence named above.
- Decision: ADR 0072.

## Step 97: Compose one browser Access session for console and API

- Status: live-blocked
- Situation: The console calls a separate API hostname. Two independent
  Cloudflare Access applications issue independent cookies. A console login
  could therefore leave the first credentialed API request unauthenticated.
- Task: Establish the console and API application cookies in one human login
  flow. Keep public authentication intents, machine traffic, and internal
  service traffic outside the human redirect without weakening their protocol
  authentication.
- Action: Define one self-hosted Access application with concrete console and
  API destinations. Enable the new-application eager cookie behavior. Use its
  one audience for API JWT validation and one ordered human policy set.
- Action: Keep more-specific Access applications for the public authentication
  intent, agent, and internal routes. The public route verifies signed state.
  The agent route verifies machine credentials. The internal route verifies
  its HMAC request. Keep credentialed CORS restricted to the configured public
  application origin.
- Action: Enable Managed OAuth and dynamic loopback registration on the shared
  human application. Do not create a second API application. Require a clean
  browser-profile test before an existing Access application can be treated as
  production evidence.
- Evidence: `infra/cloudflare/terraform/access.tf`, the environment variables,
  the focused Access composition test, and ADR 0073.
- Verification: The pinned Terraform provider schema supports multiple public
  destinations. Terraform format and validation pass. The default plan creates
  zero resources. The focused test requires one human application with both
  hostnames and keeps the specific protocol applications ordered separately.
- Blocker: No Cloudflare account, Access application, policy, domain, cookie,
  OAuth client, or browser session was changed. Live eager-cookie behavior is
  not proven until an operator supplies the account configuration and approves
  a clean-profile test.
- Decision: ADR 0073.

## Step 98: Render environment-safe Cloudflare bindings and lock Terraform state

- Status: live-blocked
- Situation: Checked-in Worker configs used local names while Terraform used
  environment names. A direct staging or production deployment could bind a
  Worker to the wrong D1 database, Queue, R2 bucket, Workflow, Durable Object,
  service, or Secrets Store. The CORS policy also needed exact public, console,
  agent, and internal boundaries. Remote Terraform state needs a real lock but
  the repository has no R2 state bucket or scoped credential.
- Task: Create one non-secret staging or production binding contract. Validate
  every rendered Worker config. Reject stale generated Worker types. Allow only
  the public authentication-intent POST and authorized console human routes in
  credentialed browser CORS. Keep agent and internal protocols non-browser.
- Action: Use `gridora-<environment>` for all D1, R2, Queue, Worker, Workflow,
  Durable Object, and service names. Export the non-secret Terraform contract.
  Keep the staging Terraform hostnames equal to the staging renderer input.
- Action: Render all six Worker configs from a validated environment file.
  Require exact environment prefix, IDs, hostnames, sender domain, and runtime
  values. Render invitation links to the public application origin.
- Action: Make the hostname contract exact. `api`, `app`, `console`, and
  `nodes` must be direct labels under the declared zone in production and under
  `staging.<zone>` in staging. Set `workers_dev=false` and `preview_urls=false`
  in every source and rendered config. Attach only exact custom-domain routes
  to API and Web; remove all routes from Realtime, Workflows, and Queue
  consumers.
- Action: Make CORS route-scoped in the API Worker. Permit the public origin
  only on `POST /v1/auth/intents`. Permit the console origin on human routes.
  Reject a browser Origin on agent or internal routes. Return no CORS header on
  denied, agent, or internal paths.
- Action: Generate every Worker declaration with pinned Wrangler. Check each
  declaration in CI and Security. Render the staging fixture and dry-run every
  rendered config. Parse the default Terraform plan JSON and reject any resource
  action.
- Action: Use an ignored partial S3 backend declaration only for a protected
  remote run. Require a valid R2 account ID, state bucket, and R2 credentials.
  Fix the state key by environment. Enable `use_lockfile=true`. Keep CI on
  credential-free `terraform init -backend=false`.
- Evidence: `infra/cloudflare/terraform`, `infra/scripts`, the rendered
  Wrangler declarations, API edge middleware, CI and Security workflows, and
  ADR 0074.
- Test: Focused API tests cover allowed and denied preflight and response CORS,
  CSRF rejection, and signed internal browser-origin rejection. Binding tests
  cover exact staging names, production and foreign-zone hostname rejection,
  API/Web custom-domain routes, route-free service Workers, offline and
  protected state initialization, and a rejected Terraform resource action.
- Verification: Run the focused API and binding Vitest files, the API and Queue
  Worker type checks, `pnpm wrangler:types:check`, six rendered Wrangler
  dry-runs, Terraform format and validation, staging production-hostname
  rejection, and the zero-resource plan JSON assertion. No resource is created
  by these checks.
- Blocker: No protected R2 state bucket, scoped R2 credential, Cloudflare
  account, custom hostname, Access audience, D1 ID, Secrets Store ID, Worker,
  Access application, or Terraform resource was created or changed. A locked
  remote-state plan and live deployment require operator-owned protected inputs
  and explicit approval.
- Decision: ADR 0074.

## Step 99: Require artifact-bearing Node image release evidence

- Status: live-blocked
- Situation: A Node image workflow can pass its source validation while the
  protected image build is skipped. A release check that reads only the
  workflow conclusion could therefore accept a commit with no QCOW2 artifact,
  signature, root-filesystem scan, provider boot, or cleanup evidence.
- Task: Bind a production release to one successful protected image run for the
  exact release commit. Reject validation-only success and missing or expired
  artifacts.
- Action: Require a manual Node image workflow run on the exact `main` commit.
  Require successful `validate`, `build-local`, and `provider-image-smoke`
  jobs. Require the exact artifact name for the run attempt, a nonexpired
  artifact, and a nonzero artifact size.
- Action: Requery that exact manual run attempt, its named jobs, and its
  nonexpired positive-size artifact after `production-release` approval and
  again immediately after final remote-tag re-resolution in the publication
  step, directly before `gh release create`. Require GitHub to associate the
  artifact with the exact `main` SHA; a prior approval-time result is not
  enough.
- Action: Make the build verify the image checksum, exported root-filesystem
  SBOM and vulnerability scan, and cryptographic signature before upload. Keep
  the provider smoke job fail closed until a production import, boot, agent
  health, response-loss adoption, and cleanup adapter is available.
- Action: Keep exact-commit CI and Security results as separate requirements.
  Do not accept the validation-only push run. Do not create a version tag or
  release when protected image or provider evidence is absent.
- Evidence: `.github/workflows/release.yml`, `.github/workflows/image.yml`,
  `tests/architecture/release-workflow.test.ts`, and ADR 0075.
- Verification: The release workflow parses as valid YAML. The focused tests
  require the exact commit, manual event, branch, named successful jobs, run
  attempt, artifact name, expiry, and positive size before and after approval.
  They require the final check to have no intervening networked step before
  publication and require the protected provider smoke job to fail closed
  without the production adapter.
- Blocker: No protected KVM image run, signing environment, provider account,
  paid test instance, successful cleanup receipt, image artifact, tag, or
  GitHub release exists. A source-only pre-alpha push does not satisfy this
  production release gate.
- Decision: ADR 0075.

## Step 100: Complete node rebuild and retirement through strict terminal evidence

- Status: local
- Situation: Rebuild and retirement can outlive the accepting request and cross
  a paid provider boundary. A lost provider response cannot authorize an
  unbounded second mutation, and provider success alone is not terminal node
  evidence.
- Task: Freeze the exact provider and image binding, adopt ambiguous physical
  effects, and complete `rebuildNode` and `retireNode` with canonical version 1
  audit evidence.
- Action: Snapshot account, allocation, credential-envelope, provider instance,
  and custom-image registration revisions at acceptance. Use the provider effect
  ledger to issue or adopt one exact mutation. Wait for retirement or rebuilt
  agent/bootstrap observation before writing the terminal operation and node
  target envelope.
- Result: Both strict-audit inventory entries are `complete-v1`; drift, foreign
  evidence, and uncertain completion fail closed.
- Evidence: Migrations 0044 and 0058, node-runtime lifecycle D1/control,
  `apps/api/src/provider-node-lifecycle-runtime.ts`, Workflow composition, and
  the mutation audit inventory.
- Verification: Focused lifecycle D1, provider runtime, Workflow, cancellation,
  migration, and audit inventory tests pass locally, including provider
  response-loss adoption and rebuild bootstrap provenance.
- Blocker: No paid provider rebuild or retirement, custom-image boot, or live
  agent re-enrolment was executed. Those require explicit live credentials,
  cleanup reconciliation, and deployment approval.
- Decision: ADR 0076.

## Step 101: Recover backup, retention, and organization cleanup after Worker loss

- Status: local
- Situation: A Worker can disappear after an R2 upload, restore, or delete is
  committed but before D1 receives the result. Retention and organization
  deletion can race an unfinished upload.
- Task: Make every physical backup effect adoptable and prevent catalog or
  organization cleanup from advancing without exact object/DNS evidence.
- Action: Fence upload generations with leases, persist operation-scoped
  physical effect receipts, preserve restore sources until verified cutover,
  clean abandoned generations by their exact claim, and retain catalog rows
  until bounded R2 absence is proven. Require child backup and game DNS cleanup
  receipts before organization inventory succeeds.
- Result: Response loss cannot allocate another generation, repeat a
  destructive action, or erase the provenance needed to resume safely.
- Evidence: Migrations 0048, 0052, 0054, and 0057; backup D1/R2, API upload,
  Workflow, retention, and organization-deletion runtimes.
- Verification: Focused backup, restore, upload, retention, abandoned cleanup,
  organization deletion, migration, and Cloudflare integration tests inject
  response loss and pass locally.
- Blocker: No production R2 bucket, D1 database, Queue, Workflow, or game server
  was changed. Live object and cleanup proof requires an approved deployment.
- Decision: ADR 0077.

## Step 102: Adopt telemetry archive retry decisions after response loss

- Status: local
- Situation: Queue redelivery after a committed but response-lost retry
  decision could allocate a duplicate archive generation or strand the existing
  retry ledger row.
- Task: Make the exact retry ledger row authoritative before any mutable stream
  read, upload, or new generation allocation.
- Action: Derive the decision from organization, node, stream, epoch, segment,
  generation, and attempt. Persist its generation/watch fence atomically. On
  redelivery, read and adopt that exact decision; reject changed scope or
  payload. Compact only terminal cleaned rows after upload and live-log
  authority are resolved.
- Result: At-least-once delivery produces one archive decision and one bounded
  generation path, even when the terminal D1 response is lost.
- Evidence: Telemetry migrations 0037, 0045, 0046, 0049, and 0055;
  `workers/queue-consumers/src/telemetry-archive-reconciliation.ts`; telemetry
  runtime and mutation inventory.
- Verification: The focused reconciliation test loses the post-commit response,
  adopts the exact decision, and compacts the cleaned row. Telemetry package and
  migration checks pass locally.
- Blocker: No live Queue, R2 object, Durable Object, or telemetry stream was
  changed. Live epoch and archive evidence requires deployment approval.
- Decision: ADR 0078.

## Step 103: Expose declarative manifests, drafts, schedules, export, and clone

- Status: local
- Situation: A portable desired-state document must not let a client select an
  internal provider, image, deployment, or resolved placement. Scheduled create
  is at-least-once and can lose its dispatch response.
- Task: Provide one schema-owned manifest surface with immutable drafts,
  one-shot scheduling, authoritative apply/clone planning, and generated client,
  CLI, and web parity.
- Action: Validate and canonicalize `GameServer` `v1alpha1`. Reconstruct exports
  from D1 desired state. Persist drafts and schedule acceptance with strict
  audit envelopes. Claim due schedules with a bounded lease and dispatch the
  fixed `scheduled-game:<schedule-id>` identity through the signed internal
  route. Clone by reading the source desired state on the server before planning
  the new server.
- Result: Validate is side-effect free; draft, schedule, clone, and apply are
  tenant-scoped, audited, idempotent, and incapable of carrying internal
  infrastructure selection from the client.
- Evidence: `packages/game-server-manifest-control`,
  `packages/game-server-manifest-d1`, migrations 0059 and 0063, API manifest
  routes, generated client, CLI, web, and game schedule Queue consumer.
- Verification: Manifest D1 tests pass with response-loss and replay-conflict
  coverage. Queue schedule tests prove exact adoption. Focused API, generated
  client, CLI, web, and migration checks pass locally.
- Blocker: No production schedule, Queue, Workflow, provider allocation, or
  game server was created. Live dispatch needs the deployed internal-signing
  and automation-identity configuration.
- Decision: ADR 0079.

## Step 104: Resolve Arma Reforger metadata through a bounded plugin adapter

- Status: local
- Situation: Arma server create accepted a requested mod without resolving a
  compatible dependency graph. The public typed source is a third-party API.
  It must not make preview planning depend on a network request.
- Action: Call only the fixed Reforger Mods V2 detail endpoint for canonical
  Arma Workshop IDs. Reject another source, URL, redirect, bad response,
  private or unpublished dependency, invalid version, and oversized graph.
- Action: Bound each credential-free request by timeout, response bytes, JSON
  work, direct dependencies, resolved dependencies, retries, and Retry-After.
  Repeat only the original endpoint after `202` or `503`. Do not follow a job
  or resource URL from an upstream response.
- Action: Use the one-hour process-local ETag cache. Carry endpoint, body
  digest, cache state, and source headers in the generic plan-local provenance.
  Return typed rate-limit, quota, source, timeout, and compatibility failures.
- Action: Resolve live metadata only during create acceptance. Keep previews
  deterministic and offline. Pass the expanded verified dependency plan to the
  existing signed plan path.
- Evidence: `plugins/games/arma-reforger/src/mod-metadata.ts`,
  `plugins/games/arma-reforger/src/index.ts`,
  `packages/plugin-sdk-control/src/index.ts`, and
  `packages/game-lifecycle-control/src/index.ts`.
- Test: `plugins/games/arma-reforger/src/mod-metadata.test.ts` and
  `packages/game-lifecycle-control/test/index.test.ts` prove fixed-origin
  resolution, cache/provenance, bounded failures, offline planning, and
  create-plan dependency expansion.
- Verification: The focused Arma plugin and lifecycle-control tests and type
  checks pass locally. Root typecheck has no game diagnostics; an unrelated
  backup test exact-optional-type error remains outside this step.
- Blocker: No live third-party API, Bohemia, Steam, agent, provider, or
  Cloudflare request was made. The metadata provenance is plan-local; a durable
  operation receipt needs a coordinated later schema decision. Installation,
  activation, and runtime health remain separate work.
- Decision: ADR 0080.

## Step 105: Install, activate, roll back, and health-check reviewed plugins

- Status: local
- Situation: A planned deployment is not complete until the node installs the
  reviewed game build, activates validated configuration and mods, and observes
  plugin-level health. A partial activation must retain a known-good rollback.
- Task: Compose the production agent path without arbitrary shell execution,
  runtime-loaded plugins, privileged containers, or Docker socket access.
- Action: Resolve an exact build-time plugin ID and version from the signed
  command. Run its fixed Steam install plan, stage configuration and immutable
  resolved mod metadata, validate before activation, retain the prior revision,
  and roll back a failed activation or health check. Report process, protocol,
  build, container, plugin, deployment, and revision evidence.
- Result: Container liveness alone cannot complete a game operation. A failed
  install, config, mod, validation, or health stage preserves an explicit
  rollback target and terminal error evidence.
- Evidence: Agent game runtime and executor, plugin SDK/testkit, Arma and second
  reference plugins, migration 0061, lifecycle execution, and telemetry health
  ingestion.
- Verification: Focused agent, plugin, lifecycle, telemetry, Docker isolation,
  and image tests cover signed installation, staging, validation, rollback,
  restore validation, and plugin-level health locally.
- Blocker: No live SteamCMD, Workshop download, Arma process, game protocol,
  provider node, or Cloudflare service was used. Production runtime evidence
  needs approved credentials, deployment, and cleanup reconciliation.
- Decision: ADR 0081.

## Step 106: Lease plugin egress and reconcile unreachable failed-node servers

- Status: local
- Situation: Reviewed distribution endpoints need narrow outbound access while
  game networking is default-deny. A failed node cannot produce normal stop or
  remove receipts, but its ports, DNS, deployment, and lifecycle inventory still
  need truthful reconciliation.
- Task: Grant bounded root-owned egress without host privilege and add explicit
  validate and forced-cleanup lifecycle actions without inventing agent success.
- Action: Use one fixed plugin bridge and a root-only socket helper that leases
  exact address/protocol/port nftables tuples with TTL and idempotent release.
  Route `validate-files` through real plugin validation. Authorize forced cleanup
  only for the exact server on a failed node in an active rebuild or retirement
  run. Record a receipt, skip unreachable agent stop/remove without fake command
  receipts, release ports and DNS, resolve deployment/inventory, then write the
  terminal lifecycle evidence.
- Result: Distribution egress is narrow and temporary. Failed hardware can be
  cleaned without claiming that an unreachable agent acted or accepting a
  foreign server/node pair.
- Evidence: Plugin egress image assets and agent adapter, migration 0062,
  lifecycle control/execution/D1/runtime, API aliases, generated client, CLI,
  and web server controls.
- Verification: Infrastructure and security tests verify the nftables lease
  tuple and release. The API runtime test drives an accepted forced delete
  through exact failed-node authorization, port/DNS cleanup, terminal audit,
  response-loss adoption, and foreign-scope denial.
- Blocker: No production nftables rule, Steam endpoint, DNS record, failed VPS,
  or game server was changed. Live proof requires an approved node image and
  deployed lifecycle stack.
- Decision: ADR 0082.

## Step 107: Reconcile runtime and storage symmetry without deletion

- Status: local
- Situation: The provider-node orphan scan did not compare D1 deployments with
  agent containers, D1 port leases with observed port owners, D1 DNS receipts
  with provider records, Tunnel state with node management authority, or D1
  backup metadata with R2 objects.
- Task: Run one tenant-scoped, bounded, read-only symmetry scan. Record
  actionable evidence. Do not silently delete or change an unknown external
  resource.
- Action: Compare five fixed resource kinds. Report missing, unmanaged,
  duplicate, foreign, fingerprint mismatch, missing receipt, stale receipt,
  and stale authority. Mark every finding as high severity. Attach one fixed
  inspection recommendation for the resource kind.
- Action: Read at most five pages of 100 observed resources and 500 D1
  authority resources. Reject foreign scope, stale data, repeated cursors,
  incomplete pages, invalid R2 keys, and ambiguous D1 authority. Fingerprint
  D1 authority again before the atomic write.
- Action: Give discovery ports read methods only. Do not give them stop,
  delete, update, put, or provider mutation methods. List R2 only below the
  exact organization prefix. Group backup chunks and the manifest by the
  canonical backup prefix.
- Action: Write one immutable scan run, one terminal operation, one compact
  audit event, one complete version 1 envelope, and the finding transitions in
  one D1 batch. Keep the exact bounded finding snapshot in the immutable run.
  Bind its count and discovery fingerprint in the audit envelope. State
  `destructiveActions: 0` in audit evidence. Adopt the same committed run after
  a lost D1 response. Resolve only finding metadata after a later complete clean
  scan. Keep finding history immutable.
- Action: Expose open evidence through a tenant-scoped, bounded D1 query. The
  evidence contains resource coordinates, fingerprints, reason, revision, and
  recommendation. It does not contain credentials, object bodies, DNS tokens,
  container environments, or provider responses.
- Evidence: `packages/orphan-control/src/symmetry.ts`,
  `packages/orphan-d1/src/symmetry.ts`, migration 0060,
  `apps/api/src/orphan-symmetry-runtime.ts`, focused tests, and ADR 0083.
- Test: Control tests cover the complete matrix, page bounds, cursor failure,
  foreign scope, and replay before discovery. D1 tests cover strict version 1
  audit, atomic response-loss adoption, evidence pagination, safe resolution,
  immutable history, and foreign actor rejection. API tests cover fixed source
  order, composite cursors, paginated R2 prefix grouping, foreign R2 rejection,
  and the read-only bucket contract.
- Verification: Orphan control check and 9 tests pass. Orphan D1 check and 18
  tests pass. The focused API runtime test has 4 passing tests. Migration
  registration is sequential through 0060. Migration check and 31 tests pass.
  Repository-wide gates remain for the final integration run.
- Blocker: No live agent inventory, provider DNS record, Tunnel, R2 object,
  Queue, Workflow, Worker, or D1 database was read, changed, or deleted. Live
  evidence requires reviewed production read adapters and deployment approval.
- Decision: ADR 0083.

## Step 108: Publish and harden the clean-runner release candidate

- Status: local
- Situation: The first public Actions run rejected three assumptions hidden by
  a warm local checkout: Nuxt output did not exist before the Worker type check,
  the Terraform lock lacked the Linux AMD64 provider package hash, and the
  disposable systemd root omitted installed image helpers and nftables.
- Task: Correct the release harness, prove each failure with the same pinned
  Linux tools, and only then select required checks and enable repository
  governance.
- Action: Build before Wrangler checks. Lock Cloudflare provider 5.23.0 for
  Darwin ARM64 and Linux AMD64. Install the three committed helper scripts and
  a validation-only nftables unit before `systemd-analyze verify`. Build one
  tool image from the pinned Ubuntu digest before privilege is granted, then
  run the firewall and quota validation containers as UID/GID 0 without APT
  mutations on the protected self-hosted KVM image-builder. Do not claim those
  kernel capabilities from the hosted push runner. Create the four workflow
  environments with a required reviewer and no credentials. Run the Node image
  validation on every pull request before making its successful `validate`
  context mandatory.
- Result: The exact Wrangler binding check, Linux Terraform initialization and
  validation, and Ubuntu cloud-init/systemd verification pass locally and on
  GitHub. CI, Security, and Node image are green on the same public commit. The
  environment review boundary exists without triggering a deployment.
- Evidence: `.github/workflows/ci.yml`, `.github/workflows/image.yml`, the
  Terraform dependency lock, initial failure runs 32718878591, 32718878578, and
  32718878568, successful runs 32721570059, 32721570106, and 32721570062, and
  the four repository environments.
- Verification: Local reproduction uses Wrangler 4.125.0, the pinned Terraform
  image digest, and the pinned Ubuntu image digest. GitHub check runs `verify`,
  `cloudflare-config`, `dependency-and-secret-scan`, and `validate` succeed on
  commit `0a049ed38a98739313ed686403382a24a694ecfa`. Branch and version-tag
  protection are activated only after this evidence record is final on `main`,
  then read back through the GitHub API.
- Blocker: No live provider test, image signing, provider image smoke, Worker,
  D1, R2, Queue, Workflow, DNS, Tunnel, VPS, or production release was run.
  Those operations still require reviewed credentials and an explicit live
  deployment decision.
- Decision: ADR 0084.

## Step 109: Simulate one Arma node and deploy the protected production control plane

- Status: pending
- Situation: Local fakes did not exercise the Docker Engine API, UDP health,
  configuration rollback, or Docker log framing. No live Cloudflare environment
  served the selected `gridora.coasts.red` product namespace.
- Task: Prove the node orchestration boundary without paid infrastructure or
  proprietary game content. Deploy the production Cloudflare control plane only
  after Access, tenant resources, migrations, and secrets exist.
- Action: Run a rootful nested Docker daemon inside one disposable privileged
  simulated VPS container. Load the node image's nftables policy. Run only the
  nested game container as an unprivileged user. Install a deterministic fake
  game through the production Arma plugin. Apply config and mods. Start the
  server. Verify UDP and plugin health. Update it. Roll back invalid config.
  Stop it. Remove all nested resources with the disposable outer boundary.
- Action: Correct the Arma install root and config path. Add exact Engine API
  `ExposedPorts`. Keep the tenant bridge publishable and the nftables forward
  policy default-deny. Decode multiplexed Docker logs. Require exact image,
  digest, environment, port, and network evidence before adoption.
- Action: Set the production public, console, API, and node names to
  `gridora.coasts.red`, `console.gridora.coasts.red`,
  `api.gridora.coasts.red`, and `nodes.gridora.coasts.red`. Keep staging under a
  separate namespace and resource prefix.
- Action: Create one shared console and API Access application. Enable exact
  credentialed CORS, HTTP-only binding cookies, eager redirect cookies, and
  Managed OAuth. Use a 15-minute access token and a two-week refresh grant.
- Action: Create three more-specific applications. Bypass the browser login only
  for `/v1/auth/intents`, `/v1/agent/*`, and `/v1/internal/*`. Keep the exact
  Worker authentication checks on each path.
- Action: Create production-only D1, R2, Queue, dead-letter Queue, Secrets Store,
  and Worker resources. Use a DNS token restricted to DNS Write on `coasts.red`.
  Use a separate Cloudflare Tunnel Write token. Give both tokens a one-year
  expiry. Do not print their values. Remove every local token and private-key
  upload file after Secrets Store activation.
- Action: Change five trigger assertions to the D1-compatible
  `SELECT RAISE(...) WHERE ...` form. Add a regression test. Apply all 63
  migrations before traffic.
- Action: Deploy realtime, a route-free API bootstrap, 23 Workflows, Queue
  consumers, the complete API, and the web Worker in dependency order. Retry one
  transient Queue consumer attachment after a Cloudflare 503. Keep the same
  Worker secrets during the retry.
- Result: Production Worker versions are realtime
  `685e0e39-6f8a-46e8-a3ea-dec227f5a1f5`, workflows
  `8b9378e2-1506-4fde-96cc-ea169072156e`, Queue consumers
  `50ca84d9-6561-4bbe-b7db-26f2b76813cb`, API
  `1cadb2f8-7620-4694-aa0f-ee38edc004d0`, and web
  `5fa6d054-c921-42c2-8698-dc2843ac1d9c`.
- Evidence: `infra/simulation/arma-vps`,
  `infra/scripts/run-simulated-arma-vps.sh`, Docker runtime and Arma plugin
  tests, migration 0026/0028/0030/0031/0055 repairs, production D1
  `dda23e01-30d4-406c-8a34-164f62d9cbd4`, and ADR 0085.
- Verification: `pnpm test:arma-sim` passes. Docker runtime tests pass. Arma
  plugin tests pass. The final `pnpm run ci` gate reports 890 formatted files,
  zero lint or type errors across 522 files, 226 passing test files with 1,494
  passing tests, and 112 successful package or application builds. The live
  Docker boundary, Cloudflare tests, generated bindings, CI and production
  Worker dry-runs, Terraform validation and no-resource default plan, package
  audit, and CI-profile Trivy scan pass.
- Verification: The production D1 reports 63 migrations in WEUR. The five
  production Secrets Store entries are active. Email Sending is enabled for
  `mail.gridora.coasts.red`; MX, SPF, DKIM, and reject-DMARC resolve publicly.
- Verification: Public sign-in and sign-up return HTML. The console and ordinary
  API reject a request without Access. The invalid auth intent returns a Gridora
  400 response and allows only `https://gridora.coasts.red`. The unauthenticated
  agent and internal requests reach Gridora and fail closed. A clean browser
  reaches the Cloudflare Access sign-in page for the production console.
- Constraint: The simulation does not install SteamCMD or Arma Reforger. It does
  not boot a signed provider image or create a paid VPS. The protected image
  workflow and simulated provider smoke remain separate release evidence.
- Decision: ADR 0085.

## Step 110: Publish the protected production release candidate

- Status: local
- Situation: The public repository still contained only the earlier pre-alpha
  implementation. The live Cloudflare deployment and Docker VPS evidence needed
  one reviewable source commit and one protected pull request.
- Task: Publish the exact release candidate without bypassing main pull-request,
  required checks, tag rules, or release-environment approval.
- Action: Commit the implementation as `341bb4f`. Push branch
  `release/live-staging-arma-simulation`. Open public pull request 7 against
  `main`.
- Action: Re-read main protection. Initially require a current approving review,
  strict status checks, and enforcement for administrators. Re-read the
  production release environment. Initially disable self-review and
  administrator bypass.
- Action: Enable the GitHub dependency graph after the first dependency-review
  job reports that the new repository does not support the check. Re-run only
  the failed Security job. Keep dependency review enabled.
- Evidence: GitHub pull request 7 and commit `341bb4f` in public repository
  `Reidond/gridora`.
- Verification: The remote branch contains the reviewed source commit. GitHub
  reports required main checks `verify`, `cloudflare-config`,
  `dependency-and-secret-scan`, and `validate` with strict review enforcement.
- Verification: CI, Security, dependency review, Trivy, and Node image
  validation pass on the published release candidate. The pull request is
  mergeable. GitHub reports `REVIEW_REQUIRED` as the only merge gate.
- Blocker: The initial independent-review model cannot complete in a repository
  with one collaborator because GitHub does not count the author's own pull
  request review. Step 111 records the owner's explicit replacement decision.
- Decision: ADR 0084.

## Step 111: Adopt truthful single-owner approval and ephemeral release evidence

- Status: pending
- Situation: Gridora has one repository owner and no independent collaborator.
  GitHub cannot count the author as the approving reviewer of their own pull
  request, but it can require an explicit deployment approval from that owner
  when self-review is allowed on a protected environment.
- Task: Let the owner approve signing, simulated provider smoke, and production
  publication without weakening automated correctness or security gates.
- Action: Keep pull requests mandatory and set the required approving review
  count to zero. Keep strict required status checks, administrator enforcement,
  linear history, conversation resolution, and the force-push and deletion
  prohibitions. Do not manufacture an approval record.
- Action: Keep the repository owner as required reviewer for `image-signing`,
  `provider-image-smoke`, and `production-release`. Allow self-review and disable
  administrator bypass so each protected deployment still needs an explicit
  approval.
- Action: Replace the long-lived release-evidence secret with GitHub's ephemeral
  per-job token. Prove the remote semantic tag, exact merged pull-request commit
  on `main`, exact push CI and Security runs, and exact protected signed image
  and simulated-provider evidence before publication.
- Result: The only human owner can approve every protected deployment. The
  release cannot proceed through a direct branch push, missing required check,
  stale commit, validation-only image run, expired image artifact, mutable tag,
  or unapproved environment.
- Evidence: `.github/workflows/release.yml`,
  `tests/architecture/release-workflow.test.ts`, the three protected GitHub
  environments, main branch protection, and version-tag ruleset 21286351.
- Verification: The release-workflow and documentation tests pass 6 tests. The
  complete `pnpm run ci` gate reports 891 correctly formatted files, zero lint
  or type errors across 522 files, 226 passing test files with 1,494 passing
  tests, and 112 successful builds. GitHub reports zero required approvals, all
  four strict check contexts, administrator enforcement, linear history,
  conversation resolution, and no force push or deletion. All three
  environments require Reidond, allow self-review, and prohibit administrator
  bypass. Tag ruleset 21286351 is active for `refs/tags/v*`, prohibits updates
  and deletions, has no exclusions or bypass actors, and reports that the
  current user can never bypass it.
- Blocker: Pull request 7 merged as `6c8af4f`. Protected image run 32740307775
  stopped before image construction because the Linux KVM firewall probe used
  same-bridge layer-2 traffic. Step 112 corrects that test boundary. The signed
  image, simulated-provider smoke, semantic tag, and release remain.
- Decision: ADR 0086.

## Step 112: Prove leased ingress through Docker DNAT on Linux KVM

- Status: local
- Situation: Protected Node image run 32740307775 passed validation and owner
  approval, then rejected the firewall preflight with `An unleased game port
remained reachable.` The probe connected directly between two containers on
  one Linux bridge. Same-bridge layer-2 forwarding does not have to enter the
  host's inet forward hook, so the probe was not testing external ingress.
- Task: Exercise the production boundary that the nftables policy controls:
  traffic entering a Docker-published host port and crossing host DNAT into the
  per-server bridge.
- Action: Create separate source and target Docker bridges. Publish the leased
  and unleased target ports on the nested host. Resolve the source bridge's host
  gateway. Probe both published ports from the separate source bridge. Require
  the leased port to return the expected body, the unleased port to time out,
  and the leased port to remain reachable after the Gridora table reloads while
  Docker's chains survive.
- Result: The integration proof no longer mistakes same-bridge peer traffic for
  host ingress. It checks Docker DNAT plus the Gridora forward policy on both an
  accepted and rejected port without weakening the default-deny ruleset.
- Evidence: `infra/scripts/validate-firewall-docker-networking.sh`,
  `tests/image/image-assets.test.ts`, failed protected run 32740307775, and ADR 0087.
- Verification: The fixed integration script passes in the pinned privileged
  validation container on the local Docker engine. The expected unleased probe
  times out, the leased probe succeeds before and after reload, and the
  validation image test asserts separate bridges and published ports. The
  complete `pnpm run ci` gate reports 892 correctly formatted files, zero lint
  or type errors across 522 files, 226 passing test files with 1,494 passing
  tests, and 112 successful builds.
- Blocker: Pull request 8 merged as `765bb3a`. The corrected firewall proof
  passed in protected run 32741854152, then the separate project-quota proof
  failed because the hosted privileged container could not discover an implicit
  loop device. Step 113 makes that allocation explicit and moves both kernel
  proofs before merge. The image, smoke, tag, and release remain.
- Decision: ADR 0087.

## Step 113: Allocate quota loop devices explicitly before protected signing

- Status: local
- Situation: Protected run 32741854152 proved the corrected leased and unleased
  firewall paths, then failed at `mount -o loop` with `mount(2) system call
failed: No such process.` GitHub's hosted privileged container did not expose
  reliable implicit loop-device discovery. The same non-secret kernel proof was
  unnecessarily delayed until after merge and image-signing approval.
- Task: Make the ext4 project-quota proof independent of container udev device
  population and run both privileged kernel proofs as required pull-request
  evidence before any signing environment is entered.
- Action: In the disposable privileged container, create the standard loop
  control character node and loop block-device nodes only when absent. Attach
  the preallocated ext4 image with explicit `losetup --find --show`. Mount the
  returned device with `prjquota`. Always unmount and detach that exact device.
- Action: Run the pinned validation image's firewall and project-quota scripts
  in the public `validate` job for pull requests, main pushes, and dispatches.
  Repeat the same proof in the owner-approved artifact build. Do not pass
  secrets, a host Docker socket, or a game container into either proof.
- Result: Missing loop nodes cannot masquerade as a quota failure. Native Linux
  firewall and quota capabilities must pass before a correction can merge, and
  the protected build repeats them before it reads signing inputs.
- Evidence: `infra/scripts/validate-project-quota.sh`,
  `.github/workflows/image.yml`, `tests/image/image-assets.test.ts`, protected
  run 32741854152, and ADR 0088.
- Verification: Bash syntax and ShellCheck pass. The pinned privileged
  validation container creates, mounts, enforces, unmounts, and detaches the
  explicit loop-backed ext4 project-quota filesystem locally. A four-megabyte
  unprivileged write is rejected at the one-megabyte hard limit with `Disk quota
exceeded`. The image asset test requires explicit loop setup, both executable
  workflow proofs, and both static script checks. The complete `pnpm run ci`
  gate reports 893 correctly formatted files, zero lint or type errors across
  522 files, 226 passing test files with 1,495 passing tests, and 112 successful
  builds.
- Blocker: Pull request 9 run 32742770930 attached an explicit loop device but
  the hosted kernel still rejected the nested-container mount with `mount(2)
system call failed: No such process.` Step 114 moves only this quota proof to
  the ephemeral host's private mount namespace. The image, smoke, tag, and
  release remain.
- Decision: ADR 0088.

## Step 114: Prove project quotas in a private host mount namespace

- Status: local
- Situation: Pull request 9 proved that a GitHub-hosted privileged container
  can allocate an explicit loop device yet still cannot mount it. The firewall
  integration proof passed in the same job. Repeating device-node changes
  cannot correct a mount boundary imposed by the host kernel.
- Task: Exercise ext4 project-quota enforcement on the ephemeral Ubuntu host
  without leaking mounts, loop devices, files, or elevated state into later
  workflow steps.
- Action: Install Ubuntu's `quota` userspace tools on the ephemeral runner. Run
  the quota script as root through `unshare --mount --propagation private` so
  the loop-backed mount exists only in a private mount namespace. Keep the
  Docker and nftables firewall proof in the pinned privileged validation image.
- Action: Allocate the filesystem image and mount directory below one
  `mktemp -d` root. On every exit, unmount, detach the exact loop device, remove
  only device nodes created by the proof, and delete the validated temporary
  root. Repeat the same host-isolated quota proof before the approved image
  build.
- Result: Pull requests must prove the real hosted Linux quota boundary before
  merge. The protected build repeats it on its own runner, while neither proof
  changes the host mount namespace or uses a repository secret, Docker socket,
  game container, provider resource, or production system.
- Evidence: `infra/scripts/validate-project-quota.sh`,
  `.github/workflows/image.yml`, `tests/image/image-assets.test.ts`, failed pull
  request run 32742770930, and ADR 0089.
- Verification: Bash syntax, ShellCheck, the image-asset contract test, local
  Docker quota enforcement, and the complete repository gate must pass. Pull
  request 9 must then pass the native Ubuntu `validate` job before merge.
- Blocker: Pull request 9 run 32743694394 reached the host mount boundary but
  returned the same `ESRCH` because Ubuntu's version-2 quota format module was
  not loaded. Step 115 loads and verifies that module before the proof. The
  image, smoke, tag, and release remain.
- Decision: ADR 0089.

## Step 115: Load the hosted kernel's quota format before mounting

- Status: local
- Situation: Pull request 9 run 32743694394 moved the proof onto the Ubuntu host
  and attached its loop device, but ext4 again returned `No such process` while
  mounting the quota-enabled filesystem. Linux returns `ESRCH` when a filesystem
  enables version-2 quota metadata before the `quota_v2` format module is loaded.
  Local Docker succeeded because its Linux host had already loaded that module.
- Task: Make the hosted kernel's quota-format dependency explicit and keep the
  filesystem mount plus hard-limit rejection as the authoritative proof.
- Action: Before each private mount-namespace proof, run `modprobe quota_v2` as
  root and require `/sys/module/quota_v2` to exist. Do this in both public pull-
  request validation and the owner-approved protected image build.
- Result: A missing kernel quota module fails with a precise dependency error.
  A present module is not sufficient by itself: the workflow must still create
  and mount the ext4 filesystem, read back the exact project limit, and observe
  the oversized unprivileged write fail.
- Evidence: `.github/workflows/image.yml`,
  `tests/image/image-assets.test.ts`, failed pull-request run 32743694394, Linux
  quota format-module behavior, and ADR 0090.
- Verification: The image-asset test requires two explicit module loads, two
  sysfs assertions, and two private host quota proofs. The focused tests and
  complete repository gate must pass, then pull request 9 must prove the path
  on GitHub's Ubuntu 24.04 runner before merge.
- Blocker: Pull request 9 run 32744210002 reported `Module quota_v2 not found in
directory /lib/modules/6.17.0-1022-azure`. Step 116 installs the matching
  Ubuntu extra-module package before the explicit load. The image, smoke, tag,
  and release remain.
- Decision: ADR 0090.

## Step 116: Install the runner kernel's matching quota module package

- Status: local
- Situation: Pull request 9 run 32744210002 proved that the Ubuntu runner's base
  module set does not include `quota_v2` for its exact Azure kernel. The explicit
  load failed before any filesystem mount, which replaced the ambiguous `ESRCH`
  with the real missing-package boundary.
- Task: Supply the stock Ubuntu quota format module that matches the running
  ephemeral kernel without pinning a stale kernel release or bypassing the
  behavioral quota proof.
- Action: After `apt-get update`, install `linux-modules-extra-$(uname -r)` with
  `--no-install-recommends` alongside the `quota` userspace package. Use the same
  exact-running-kernel expression in public validation and the protected image
  build. Then require `modprobe quota_v2` and its sysfs entry before mounting.
- Result: The proof follows GitHub's current Ubuntu Azure kernel instead of
  assuming its optional modules are preinstalled. Package installation affects
  only the ephemeral runner, is credential-free, and still cannot pass without
  the exact project-ID, hard-limit readback, and rejected oversized write.
- Evidence: `.github/workflows/image.yml`,
  `tests/image/image-assets.test.ts`, failed pull-request run 32744210002, and
  ADR 0091.
- Verification: The image-asset test requires two matching-kernel package
  installations, two module loads, two sysfs assertions, and two private quota
  executions. Focused tests and the complete repository gate must pass, then
  pull request 9 must prove quota enforcement on GitHub's Ubuntu runner.
- Blocker: Merge only after the native proof is green, rerun the exact main image
  workflow, approve signing and simulated smoke, then complete the protected
  semantic release.
- Decision: ADR 0091.

## Step 117: Boot the pinned Ubuntu installer through explicit GRUB commands

- Status: local
- Situation: Owner-approved exact-main image run 32745356422 passed every
  validation and pinned-input step, then timed out waiting for guest SSH. The
  failed Packer command depended on moving down three lines in the Ubuntu GRUB
  editor before appending autoinstall arguments. No provider smoke approval was
  available because the artifact-producing job did not succeed.
- Task: Remove the installer-menu layout dependency without extending the SSH
  timeout or weakening image, signing, smoke, or release evidence.
- Action: Enter the GRUB command console, load `/casper/vmlinuz` with
  `autoinstall`, `ip=dhcp`, and the quoted `nocloud-net` Packer HTTP seed, load
  `/casper/initrd`, and boot. Keep the generated ephemeral SSH key and its
  pre-shutdown removal unchanged.
- Result: The build names the pinned ISO's kernel and initrd paths directly and
  cannot silently append its datasource to an unrelated GRUB line. GitHub will
  expose the next single-owner approval only after a replacement exact-main
  image artifact succeeds.
- Evidence: `infra/packer/gridora-node.pkr.hcl`,
  `tests/image/image-assets.test.ts`, failed protected run 32745356422, and ADR 0092.
- Verification: Require Packer formatting and validation, the focused image and
  documentation tests, the complete repository gate, pull-request CI and
  Security, then a new exact-main image build plus separately approved
  simulated provider smoke. Pinned Packer 1.14.2 formatting and validation pass
  in its official container. The focused records pass 17 tests. The complete
  local gate reports 897 correctly formatted files, zero lint or type errors
  across 522 files, 226 passing test files with 1,496 passing tests, and 112
  successful builds.
- Blocker: Merge the reviewed repair before rerunning protected signing. The
  failed run is not release evidence and no version tag may be published from
  it.
- Decision: ADR 0092.

## Step 118: Create the guest asset-upload directory before SCP

- Status: local
- Situation: Protected exact-main run 32750636584 proved Step 117 by completing
  Ubuntu autoinstall and accepting Packer's ephemeral SSH key after about six
  minutes. Its first file provisioner then failed with `scp:
/tmp/gridora-image: Not a directory` because a content-only directory upload
  requires its guest destination to exist first.
- Task: Satisfy the exact SCP destination precondition without changing the
  reviewed asset source or weakening any later image gate.
- Action: Before the asset file provisioner, run `install -d -m 0700
/tmp/gridora-image` as the unprivileged build user. Preserve the source's
  trailing slash and the exact destination so Packer copies the reviewed
  contents into that private directory.
- Result: The upload cannot confuse a nonexistent path for a file destination,
  and staged image assets remain readable only by the ephemeral build user
  until the existing root provisioning script installs them.
- Evidence: `infra/packer/gridora-node.pkr.hcl`,
  `tests/image/image-assets.test.ts`, failed protected run 32750636584, and ADR 0093.
- Verification: Require pinned Packer formatting and validation, focused image
  and documentation tests, the complete repository gate, pull-request CI and
  Security, then a new exact-main protected build and separately approved
  simulated smoke. Packer 1.14.2 formatting and validation pass with QEMU plugin
  1.1.6. The focused records pass 18 tests. The complete local gate reports 898
  correctly formatted files, zero lint or type errors across 522 files, 226
  passing test files with 1,497 passing tests, and 112 successful builds.
- Blocker: The successful SSH connection proves the boot repair but not a
  complete image. Do not tag or release until the replacement run produces and
  validates the signed artifact.
- Decision: ADR 0093.

## Step 119: Bound Packer sudo to the ephemeral image-build session

- Status: local
- Situation: Protected exact-main run 32753572704 passed autoinstall, SSH,
  private destination creation, and every artifact upload. The provisioning
  script then failed at its first `sudo` because the locked-password build user
  had no noninteractive elevation rule.
- Task: Permit the declared root provisioning actions without enabling root SSH,
  adding a reusable password, or leaving permanent build-user elevation in the
  image.
- Action: In autoinstall late commands, create mode-0440
  `/etc/sudoers.d/90-gridora-packer` for only the `gridora` build account and
  require `visudo -cf` to validate it. Keep Ed25519 key authentication. At
  shutdown, enter one root shell, remove both the ephemeral authorized key and
  sudoers file, then power off without a second sudo call.
- Result: Packer can execute the reviewed script's explicit root operations,
  while the offline image is required to contain neither remote build access
  path.
- Evidence: `infra/packer/http/user-data.pkrtpl.hcl`,
  `infra/packer/gridora-node.pkr.hcl`, `tests/image/image-assets.test.ts`, failed
  protected run 32753572704, and ADR 0094.
- Verification: Require pinned Packer formatting and validation, cloud-init
  schema validation, focused image and documentation tests, the complete
  repository gate, pull-request CI and Security, then a new exact-main protected
  build and separately approved simulated smoke. Packer 1.14.2 formatting and
  validation pass with QEMU plugin 1.1.6, the user-data parses as YAML, and the
  focused records pass 19 tests. An initial full run hit two unrelated fixed
  five-second timeouts; both tests passed immediately in isolation (6 tests and
  1 test). A clean complete rerun reports 899 correctly formatted files, zero
  lint or type errors across 522 files, 226 passing test files with 1,498
  passing tests, and 112 successful builds.
- Blocker: The successful upload proves Steps 117 and 118 but not complete
  provisioning or credential removal. Do not tag or release until offline image
  inspection and signed artifact evidence pass.
- Decision: ADR 0094.

## Step 120: Create the minimal guest journald drop-in directory

- Status: local
- Situation: Protected exact-main run 32756319958 passed autoinstall, SSH,
  private upload, noninteractive root elevation, package installation, Docker
  setup, and every pinned checksum. The provisioner then failed inside the
  first complete immutable-configuration pass. An amd64 Ubuntu reproduction
  proved the Node and signed update-state span, then exposed that the minimal
  guest does not guarantee `/etc/systemd/journald.conf.d` before Gridora writes
  its logging drop-in there.
- Task: Remove the undeclared filesystem precondition without weakening or
  relocating the immutable journald policy.
- Action: Add `/etc/systemd/journald.conf.d` to the root-owned mode-0755
  directory-creation step and require the image contract test to prove that
  creation occurs before `60-gridora.conf` is installed.
- Result: Minimal Ubuntu guests receive the fixed root-owned logging policy
  deterministically instead of depending on an optional package-created
  directory.
- Evidence: `infra/packer/scripts/provision.sh`,
  `tests/image/image-assets.test.ts`, failed protected run 32756319958, amd64
  Ubuntu 24.04 provisioner reproductions, and ADR 0095.
- Verification: Require Packer formatting and validation, focused image and
  documentation tests, the complete repository gate, pull-request CI and
  Security, then a new exact-main protected build and separately approved
  simulated provider smoke. Packer 1.14.2 formatting and validation pass with
  QEMU plugin 1.1.6, the focused records pass 20 tests, and the complete local
  gate reports 900 correctly formatted files, zero lint or type errors across
  522 files, 226 passing test files with 1,499 passing tests, and 112 successful
  builds.
- Blocker: The prior run remains diagnostic only. Do not tag or release until a
  replacement run produces and validates the signed QCOW2 artifact.
- Decision: ADR 0095.

## Step 121: Scope signed agent manifest validation in the guest

- Status: local
- Situation: Owner-approved exact-main run 32759392984 reached the real Ubuntu
  provisioner and failed after every pinned checksum. Diagnostic run
  32761299089 identified the monolithic signed agent-update manifest assertion.
  Protected safe-shape run 32762605028 proved that the manifest's allowlisted
  keys, types, sequence, epoch, timestamp, signature encoding, checksum, HTTPS
  source, and compatibility values were valid. The remaining defect was the
  assertion's ambiguous nested `jq` pipe scope.
- Task: Preserve the strict signed-manifest boundary while making its execution
  deterministic and its failures diagnosable.
- Action: Parenthesize the `source` and `compatibility` object scopes, split
  every type, equality, range, and format check into an explicit assertion,
  rename the top-level allowlist variable, and report the exact failed guest
  line and command through a ShellCheck-clean `ERR` trap.
- Result: The guest evaluates valid signed manifests without scope ambiguity and
  continues to reject unknown fields, wrong types, non-integral counters,
  checksum or compatibility mismatches, invalid source URLs, and malformed
  signatures. Future failures identify their exact non-secret command.
- Evidence: `infra/packer/scripts/provision.sh`,
  `tests/image/image-assets.test.ts`, exact-main failed run 32759392984,
  diagnostic run 32761299089, safe-shape diagnostic run 32762605028, and ADR 0096.
- Verification: Require Bash parsing, ShellCheck, focused image and
  documentation tests, Packer 1.14.2 formatting and validation with QEMU plugin
  1.1.6, the complete repository gate, pull-request CI and Security, then a new
  owner-approved exact-main image build and separately approved simulated
  provider smoke. Bash, ShellCheck, the 21 focused tests, and Packer validation
  pass locally. The complete gate reports 901 correctly formatted files, zero
  lint or type errors across 522 files, 226 passing test files with 1,500
  passing tests, and 112 successful builds.
- Blocker: Diagnostic runs are not release evidence. Do not tag or release until
  an exact-main replacement produces, inspects, scans, signs, and uploads the
  QCOW2 artifact and the protected simulated smoke succeeds.
- Decision: ADR 0096.

## Step 122: Install fixed unit executables before verification

- Status: local
- Situation: Owner-approved exact-main run 32764415965 accepted the signed
  baseline update manifest and advanced to systemd verification. The verifier
  rejected the plugin-egress network and lease units because their fixed
  `/usr/local/libexec/gridora` helpers were installed later, even though the
  containerized unit lane already verifies the same units with those helpers
  present.
- Task: Give the real guest verifier the complete immutable filesystem contract
  without weakening any unit or execution policy.
- Action: Move the unchanged `systemd-analyze verify` command after all fixed
  unit helper installations and require both plugin-egress helper paths to
  precede verification in the image contract test.
- Result: The guest verifies units only after every referenced executable exists
  with its final mode and path. Missing or invalid executables continue to fail
  closed.
- Evidence: `infra/packer/scripts/provision.sh`,
  `tests/image/image-assets.test.ts`, failed exact-main run 32764415965, and ADR 0097.
- Verification: Require Bash parsing, ShellCheck, focused image and
  documentation tests, Packer 1.14.2 formatting and validation with QEMU plugin
  1.1.6, the complete repository gate, pull-request CI and Security, then a new
  owner-approved exact-main build and separately approved simulated provider
  smoke. Bash, ShellCheck, and 22 focused tests pass locally. The complete gate
  reports 902 correctly formatted files, zero lint or type errors across 522
  files, 226 passing test files with 1,501 passing tests, and 112 successful
  builds.
- Blocker: Run 32764415965 created no artifact and is not release evidence. Do
  not tag or release until the replacement run completes the image and smoke
  lanes.
- Decision: ADR 0097.

## Step 123: Preflight the read-only libguestfs appliance

- Status: local
- Situation: Owner-approved exact-main run 32766678178 completed the Ubuntu
  QCOW2 build and passed `qemu-img` validation, then failed before rootfs
  extraction because the hosted runner's unprivileged libguestfs process could
  not build its supermin appliance from the unreadable host kernel image.
- Task: Fail early when the ephemeral signing runner cannot inspect the image,
  while preserving mandatory read-only rootfs evidence and signing controls.
- Action: Select the direct libguestfs backend, make only the running ephemeral
  host kernel image readable after package installation, assert that access,
  and run `libguestfs-test-tool` before Packer starts.
- Result: The protected job proves its extraction appliance before spending
  time building the QCOW2. The produced guest remains unchanged, and extraction,
  SBOM generation, scanning, signing, verification, and upload remain
  fail-closed.
- Evidence: `.github/workflows/image.yml`,
  `tests/image/image-assets.test.ts`, failed protected run 32766678178, and ADR 0098.
- Verification: Require workflow parsing, ShellCheck, focused image and
  documentation tests, Packer 1.14.2 formatting and validation with QEMU plugin
  1.1.6, the complete repository gate, pull-request CI and Security, then a new
  owner-approved exact-main build and separately approved simulated provider
  smoke. The focused records pass 22 tests. The complete local gate reports 903
  correctly formatted files, zero lint or type errors across 522 files, 226
  passing test files with 1,501 passing tests, and 112 successful builds.
- Blocker: Run 32766678178 produced no accepted artifact. Do not tag or release
  until the replacement run completes the evidence and smoke lanes.
- Decision: ADR 0098.

## Step 124: Stream package evidence without recreating device nodes

- Status: local
- Situation: Owner-approved exact-main run 32769230700 passed the libguestfs
  preflight, built and validated the Ubuntu QCOW2, and exported its rootfs. The
  evidence script then failed because full unprivileged extraction tried to
  recreate legitimate guest device nodes such as `/dev/null` and Docker's
  `backingFsBlockDev`.
- Task: Read the guest package inventory without host root or `CAP_MKNOD`, while
  preserving the complete archive as mandatory supply-chain evidence.
- Action: Validate the archive listing, require exactly one
  `var/lib/dpkg/status` member, and stream only that file for package counting.
  Keep the complete rootfs archive as the SBOM, vulnerability-scan, checksum,
  signature, and promotion input. Add a regression fixture containing a real
  `/dev/null` device entry.
- Result: The unprivileged evidence lane does not recreate guest special files,
  while missing, duplicate, empty, or malformed package inventories still fail
  closed.
- Evidence: `infra/scripts/extract-rootfs-evidence.sh`,
  `tests/infrastructure/image-artifact-evidence.test.ts`, failed protected run
  32769230700, and ADR 0099.
- Verification: Require Bash parsing, ShellCheck, focused
  artifact/image/documentation tests, the complete repository gate,
  pull-request CI and Security, then a new owner-approved exact-main build and
  separately approved simulated provider smoke. Bash and ShellCheck pass, and
  the focused records pass 26 tests. The complete local gate reports 904
  correctly formatted files, zero lint or type errors across 522 files, 226
  passing test files with 1,501 passing tests, and 112 successful builds.
- Blocker: Run 32769230700 produced no accepted artifact. Do not tag or release
  until the replacement run completes the evidence and smoke lanes.
- Decision: ADR 0099.

## Step 125: Make protected image evidence failures stage-specific

- Status: local
- Situation: Owner-approved exact-main run 32771824710 built and validated the
  QCOW2 but failed silently inside one combined evidence step. The log could not
  distinguish rootfs inventory, SBOM, vulnerability policy, signing,
  verification, or promotion-manifest assertions.
- Task: Preserve every supply-chain gate while making failures independently
  observable and actionable.
- Action: Split the existing ordered sequence into named extraction, SBOM,
  scan, sign-and-verify, and promotion-manifest Actions steps. Add bounded error
  messages for silent package-inventory and SBOM invariants.
- Result: GitHub records the exact failed boundary, later stages remain fenced,
  and upload still occurs only after all evidence stages succeed. No scan,
  identity, signature, or promotion rule is weakened.
- Evidence: `.github/workflows/image.yml`,
  `infra/scripts/extract-rootfs-evidence.sh`,
  `infra/scripts/generate-sbom.sh`, `tests/image/image-assets.test.ts`, failed
  protected run 32771824710, and ADR 0100.
- Verification: Require Bash parsing, ShellCheck, focused
  artifact/image/documentation tests, the complete repository gate,
  pull-request CI and Security, then a new owner-approved exact-main build and
  separately approved simulated provider smoke. Bash and ShellCheck pass, and
  the focused records pass 27 tests. The complete local gate reports 905
  correctly formatted files, zero lint or type errors across 522 files, 226
  passing test files with 1,502 passing tests, and 112 successful builds.
- Blocker: Run 32771824710 produced no accepted artifact. Do not tag or release
  until the replacement run completes every evidence and smoke lane.
- Decision: ADR 0100.

## Step 126: Scope package inventory to the Node root filesystem

- Status: local
- Situation: Owner-approved exact-main run 32774531888 built and validated the
  QCOW2. The separated extraction stage then found two archive paths that ended
  in `var/lib/dpkg/status`. The Node root had one package database, and a Docker
  filesystem layer retained another package database below its nested root.
- Task: Measure packages installed in the Node image without treating a nested
  container layer as a second host package inventory.
- Action: Match only `var/lib/dpkg/status` or `./var/lib/dpkg/status` at the
  archive root. Continue to reject a missing or duplicate root-level database.
  Ignore nested paths that only share the suffix.
- Action: Add a regression archive with a root package database and a nested
  Docker-layer package database. Require evidence to count only the two root
  packages.
- Result: Rootfs evidence describes the Node operating system. Nested container
  contents remain covered by the complete archive SBOM, scan, checksum, and
  signature without corrupting the host package count.
- Evidence: `infra/scripts/extract-rootfs-evidence.sh`,
  `tests/infrastructure/image-artifact-evidence.test.ts`, failed protected run
  32774531888, and ADR 0101.
- Verification: Require Bash parsing, ShellCheck, focused artifact and
  documentation tests, the complete repository gate, pull-request CI and
  Security, then a replacement owner-approved exact-main build and separately
  approved simulated-provider smoke.
- Blocker: Run 32774531888 uploaded no accepted artifact. Do not tag or release
  until the replacement run passes extraction, SBOM, scan, signing, upload, and
  provider smoke.
- Decision: ADR 0101.

## Step 127: Bind the pinned rootfs scanner command

- Status: local
- Situation: Owner-approved exact-main run 32777016896 built and validated the
  QCOW2. Rootfs extraction and SBOM generation passed. The scan stage then
  reported `grype is required`. The pinned download action installed Grype
  0.110.0 in the hosted tool cache and exposed its absolute path as the `cmd`
  output, but it did not add that path to the later shell environment.
- Task: Run the exact downloaded scanner without relying on a mutable or absent
  `PATH` side effect.
- Action: Give the pinned Grype download step a fixed identifier. Pass its
  declared `cmd` output to the scan script. Keep `grype` as the local default
  when an explicit command is not supplied.
- Action: Require the selected command to exist. Preserve the canonical rootfs
  archive, `high` failure threshold, and `only-fixed` rule.
- Result: The protected scan invokes the pinned hosted-tool-cache binary by its
  resolved absolute path. A missing output fails closed before signing.
- Evidence: `.github/workflows/image.yml`, `infra/scripts/scan-artifact.sh`,
  `tests/image/image-assets.test.ts`, failed protected run 32777016896, and ADR 0102.
- Verification: Require workflow parsing, Bash parsing, ShellCheck, focused
  image and documentation tests, the complete repository gate, pull-request CI
  and Security, then a replacement owner-approved exact-main build and
  separately approved simulated-provider smoke.
- Blocker: Run 32777016896 uploaded no accepted artifact. Do not tag or release
  until the replacement run passes scan, signing, upload, and provider smoke.
- Decision: ADR 0102.

## Step 128: Bind image scanning to signed package facts

- Status: local
- Situation: Owner-approved exact-main run 32779717636 built the QCOW2 and
  reached the real vulnerability gate. Grype found fixed High vulnerabilities.
  It also read a generic kernel version and stale module versions inside
  stripped Docker package binaries. The run produced no accepted artifact.
- Task: Keep the High-or-Critical gate and give it authoritative package and
  binary evidence.
- Action: Upgrade Ubuntu fully. Install exact Docker 29.7.2, containerd 2.3.3,
  Buildx 0.36.1, and Compose 5.5.0 packages from Docker's signed Noble
  repository. Verify the key fingerprint, source, versions, owned paths, and
  absence of pending upgrades.
- Action: Protected run 32786521368 showed that a minimal Ubuntu guest has no
  default GnuPG home. Inspect the repository key in a dedicated mode-0700
  temporary GnuPG home. Delete that directory after the fingerprint matches.
- Action: Build cloudflared 2026.8.2 from exact commit
  `733bfb939963e150dcf5c4faddb1603f744fbc98` with its vendored dependencies and
  Go 1.27.0. Record the source, toolchain, and artifact digest.
- Action: Pin Syft 1.51.0 and Grype 0.117.0. Omit the generic kernel cataloger.
  Remove Go-module facts only for nine exact Docker-package-owned binary paths.
  Keep the five Debian packages in the SPDX document. Scan that validated SPDX
  document with the unchanged `high` and `only-fixed` rule.
- Result: Ubuntu kernel evidence comes from Ubuntu package records. Docker
  evidence comes from exact signed packages and ownership lists. cloudflared
  uses the current Go toolchain. There is no vulnerability-ID suppression and
  no lower severity threshold.
- Evidence: `.github/workflows/image.yml`,
  `infra/packer/scripts/provision.sh`,
  `infra/scripts/validate-rootfs-package-policy.sh`,
  `infra/scripts/generate-sbom.sh`, `infra/scripts/scan-artifact.sh`, protected
  runs 32779717636 and 32786521368, and ADR 0103.
- Verification: Require Bash parsing, ShellCheck, focused policy, SBOM, scan,
  image, workflow, and documentation tests, Packer formatting and validation,
  the complete repository gate, pull-request CI and Security, then a new
  owner-approved exact-main build and separately approved simulated-provider
  smoke. Local proof includes Bash and ShellCheck, Packer 1.14.2 formatting and
  validation, 42 focused tests, 909 formatted files, zero lint or type errors
  across 522 files, 226 passing test files with 1,507 passing tests, and 112
  successful builds. The dependency audit and Trivy High-or-Critical fixed
  vulnerability and secret scan also pass. The GnuPG repair passes Bash,
  pinned ShellCheck, all 22 image-asset tests, and a clean Ubuntu 24.04
  container check that verifies the exact fingerprint and temporary-keyring
  removal.
- Blocker: Do not tag or release until the replacement run signs and uploads
  the image and completes provider smoke.
- Decision: ADR 0103.

## Step 129: Bind public entry to the protected console

- Status: local
- Situation: Production browser QA showed that sign-in and sign-up rendered,
  but `https://gridora.coasts.red/` called `/v1/auth/bootstrap` on the web
  Worker. The response was SPA HTML, and the console displayed `Unexpected
token '<'` because the deployed Nuxt runtime had an empty API base.
- Task: Give the public application exact environment origins and prevent it
  from loading an authenticated console route before Cloudflare Access.
- Action: Add explicit Nuxt public bindings for the API base, API mode, Access
  completion URL, and public application origin. Render those values from the
  validated Cloudflare environment contract. Send non-public routes on the
  public hostname to sign-in with a bounded same-origin return path.
- Result: The public hostname serves sign-in, sign-up, legal, and invitation
  entry routes. Authentication completes on `console.gridora.coasts.red`, and
  authenticated API requests use `api.gridora.coasts.red`. A local rendered
  Worker injects the staging equivalents into a build that has empty defaults.
- Evidence: `apps/web/wrangler.jsonc`, `apps/web/nuxt.config.ts`,
  `apps/web/middleware/bootstrap.global.ts`, `apps/web/utils/gridora.ts`,
  `infra/scripts/render-cloudflare-environment.mjs`, production Playwright QA,
  production Worker version `1a2abd78-74ac-4729-8e4f-714f28d719ef`, and ADR 0104.
- Verification: Require the focused environment and onboarding tests, Nuxt
  build, local rendered-Worker response inspection, complete repository gate,
  pull-request CI and Security, production deployment, then desktop and mobile
  browser QA with zero console errors. The local focused suite passes 42 tests,
  the Cloudflare runtime suite passes 11 tests, and the complete gate passes
  with the counts recorded in Step 128. The Docker VPS Arma lifecycle passes
  install, configure, start, probe, update, rollback, and stop. Live desktop
  and mobile QA confirms the public sign-in and sign-up routes, exact API and
  Access completion origins, the protected console redirect, exact API CORS,
  and zero Gridora console errors.
- Blocker: None for the public-entry repair. Release admission remains in Step 128.
- Decision: ADR 0104.

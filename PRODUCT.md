# PRODUCT.md — Gridora

> **Product category:** Game server operations platform  

> **Status:** Draft for implementation  
> **Version:** 0.2  
> **Last updated:** 2026-08-23  
> **Primary scope:** Linux Steam dedicated servers, OVHcloud Public Cloud, Contabo, and a Cloudflare-native control plane  
> **Working repository slug:** `gridora`  
> **CLI name:** `gridora`

---

## 1. Product summary

Gridora is a multi-organization, self-hosted or operator-hosted control plane for provisioning VPS infrastructure and running one or more Steam-based dedicated game servers as isolated Linux Docker workloads.

The product consists of:

- public sign-in and sign-up pages plus an authenticated Nuxt web dashboard;
- first-run organization setup, membership, invitations, and organization switching;
- a programmatic CLI;
- a Cloudflare-hosted API and orchestration control plane;
- the `gridora-agent` installed on every managed VPS;
- provider drivers for OVHcloud Public Cloud and Contabo;
- an immutable VPS image pipeline;
- a versioned plugin SDK for game-specific installation, configuration, monitoring, backup, and mod workflows.

An operator can create a VPS, deploy a game server, attach a domain, monitor it, update it, manage its mods, back it up, move it to another VPS, and delete it without manually logging in to the host.

The system supports both placement modes:

1. **Dedicated placement:** one game server per VPS.
2. **Shared placement:** multiple isolated game-server containers on one VPS, subject to CPU, memory, disk, and port constraints.

The control plane runs primarily on Cloudflare. Game processes and player traffic run on conventional VPS infrastructure.

### 1.1 Product promise

A new user must be able to sign up, create a first organization, become its Owner, and reach an organization-scoped dashboard without administrator intervention.

A fresh organization Owner should then be able to go from available provider capacity to a running game server through either:

```bash
gridora auth login
gridora servers apply -f server.yaml --wait
```

or a guided web wizard, without manually:

- creating a VPS;
- installing Docker;
- configuring a firewall;
- installing SteamCMD;
- writing Docker Compose;
- configuring Cloudflare Tunnel;
- allocating ports;
- creating DNS records;
- installing mods;
- setting up monitoring.

### 1.2 Reference architecture

```text
                         CONTROL PLANE
┌───────────────────────────────────────────────────────────────────────┐
│ Cloudflare                                                            │
│                                                                       │
│  Public web routes                                                    │
│      ├── app.gridora.example/sign-in ── authentication entry page       │
│      └── app.gridora.example/sign-up ── registration entry page         │
│                                                                       │
│  Cloudflare Access                                                    │
│      │                                                                │
│      ├── console.gridora.example ── authenticated Nuxt dashboard       │
│      ├── api.gridora.example ───── Hono Worker + Effect application    │
│      └── *.mgmt.gridora.example ── Access-protected Tunnel origins     │
│                                                                       │
│  Durable Objects     Workflows       Queues                           │
│  - node sessions     - provision     - agent events                   │
│  - resource locks    - deploy        - telemetry                      │
│  - live events       - update        - audit/export                   │
│                      - backup/restore                                  │
│                                                                       │
│  D1                    R2                    Cloudflare DNS             │
│  - desired state       - backups            - player records          │
│  - inventory           - logs               - management records      │
│  - operations          - image artifacts                              │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTPS/WebSocket through Tunnel
                                │ provider APIs
                                ▼
                         GAME DATA PLANE
┌───────────────────────────────────────────────────────────────────────┐
│ OVHcloud Public Cloud or Contabo VPS                                  │
│                                                                       │
│  cloudflared     node agent      Traefik                              │
│       │               │              │                                │
│       │               ├── Docker API │                                │
│       │               ├── metrics    ├── HTTP/TCP/UDP entrypoints     │
│       │               └── logs       └── game-specific web UIs        │
│       │                                                               │
│       ├── game-server-a container + persistent volumes                │
│       ├── game-server-b container + persistent volumes                │
│       └── install/update/mod/backup jobs                               │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ public DNS-only A/AAAA + allocated ports
                                ▼
                              Players
```

---

## 2. Problem statement

Hosting a dedicated game server generally requires knowledge spanning cloud provider APIs, Linux, networking, Docker, SteamCMD, game-specific configuration, firewall rules, DNS, backups, monitoring, and mod ecosystems.

Existing generic container panels often fail in one or more of these areas:

- they assume infrastructure already exists;
- they do not own the complete VPS lifecycle;
- they expose management ports directly;
- they mix game-specific behavior into the platform core;
- they cannot model provider-specific billing and deletion semantics;
- they treat Docker templates as a sufficient plugin system;
- they do not safely coordinate retries across paid infrastructure operations;
- they cannot place multiple servers on one VPS without port conflicts;
- they provide only process-level health rather than game-protocol health;
- their mod support is either absent or hard-coded.

This product solves the complete lifecycle as one desired-state system.

---

## 3. Goals

### G-1 — End-to-end infrastructure ownership

The platform must create, bootstrap, manage, drain, rebuild, and retire VPS nodes through provider APIs.

### G-2 — Secure-by-default management

No node-agent, Docker, Traefik dashboard, RCON, SSH, or game administration endpoint may need a publicly open management port. Management traffic must traverse Cloudflare Tunnel and Cloudflare Access.

### G-3 — Provider-independent placement

A game-server deployment must target OVHcloud, Contabo, a named node, an automatically selected shared node, or a newly provisioned dedicated node through one domain model.

### G-4 — Robust game plugin isolation

All game-specific installation, configuration, health, query, backup, mod, and custom UI behavior must live in a versioned plugin package. Adding a second game must not require edits to core scheduling, provider, authentication, database, or orchestration packages.

### G-5 — Safe paid-resource orchestration

Provisioning and deletion must be durable, retryable, idempotent, auditable, and protected by spending limits.

### G-6 — Declarative and programmatic operation

All core dashboard actions must be available through a stable API and CLI. Users must be able to export, plan, and apply declarative game-server manifests.

### G-7 — Low control-plane cost

Stateless applications must run on Cloudflare Workers or Worker Assets. Durable Objects must be used only where serialized state or real-time coordination is needed. Long-running provider workflows must use Cloudflare Workflows.

### G-8 — Steam-compatible packaging

The platform must automate SteamCMD installation and updates without assuming that proprietary game binaries may be redistributed inside a public OCI image.

### G-9 — First-class multi-organization tenancy

A user must be able to belong to multiple organizations, create and switch organizations, accept invitations, and operate only on resources authorized by an organization membership. Tenant isolation must be enforced in routes, services, repositories, Durable Object names, R2 keys, provider metadata, and node assignments.

---

## 4. Non-goals for the first production release

The following are explicitly outside the first production release:

- running game processes inside Cloudflare Workers, Durable Objects, or Cloudflare Containers;
- transparently proxying arbitrary player UDP traffic through Cloudflare Tunnel;
- Windows-native dedicated servers;
- Proton or Wine compatibility;
- Kubernetes;
- live migration without downtime;
- placing deployments from different organizations on the same VPS node;
- arbitrary user-supplied Docker images or shell commands;
- unreviewed third-party plugins loaded dynamically in Cloudflare Workers;
- customer subscription billing, invoicing, taxes, or provider-cost resale;
- a public game-server marketplace;
- automatic DDoS mitigation beyond the VPS provider’s included protection;
- bypassing Steam, publisher, Workshop, or mod licensing terms;
- storing plaintext Steam passwords;
- guaranteeing a hostname-only connection for protocols that require an explicit port;
- replacing game-specific anti-cheat or moderation systems.

Proton support, third-party plugins, autoscaling, customer billing, and Cloudflare Spectrum integration may be added later behind explicit capability and security reviews.

---

## 5. Product principles

1. **Desired state over remote scripts.** The control plane records what should exist; workflows and the node agent reconcile reality toward it.
2. **Core knows capabilities, not games.** The core works with contracts such as `InstallPlan`, `PortRequest`, `ModSet`, and `HealthReport`.
3. **Provider drivers translate; workflows decide.** A provider package maps an external API into typed operations. It does not contain scheduling or product policy.
4. **Management is private; player traffic is explicit.** Cloudflare Tunnel protects management. Game ports are deliberately allocated and opened.
5. **Immutable node images; disposable nodes.** Configuration drift is repaired by rebuilding or reconciling from a versioned image.
6. **Every paid action is idempotent.** A retry must never silently create a second VPS.
7. **No hidden global state.** Every operation has an organization, resource, correlation ID, actor, and audit trail.
8. **Plugins are versioned products.** Plugin compatibility, migration, capabilities, and test conformance are first-class.
9. **A stopped process is not necessarily a healthy game server.** Health must combine provider, node, container, and game-protocol signals.
10. **Security boundaries are explicit.** Game containers never receive provider credentials or unrestricted Docker access.
11. **Organization is a security boundary.** Every tenant-owned resource has one organization, and organization context is explicit rather than inferred from mutable global session state.

---

## 6. Users, organizations, and roles

Gridora supports multiple organizations from the first production release. A human identity can belong to zero, one, or many organizations. Roles are assigned through organization memberships and never globally implied by an email address.

### 6.1 Organization roles

| Role | Capabilities |
|---|---|
| **Owner** | Full organization control; ownership transfer; members; policy; budgets; destructive actions; organization deletion |
| **Administrator** | Manage nodes, servers, plugins, backups, DNS, organization settings, invitations, and operational policy |
| **Operator** | Deploy, configure, start, stop, restart, update, back up, restore, and view logs |
| **Viewer** | Read-only access to inventory, status, logs, operations, and audit history |
| **Automation identity** | Organization-scoped API access for CI or external automation; no interactive login |

A separate internal **Platform Administrator** role can manage platform-owned provider accounts, image promotion, global plugin availability, abuse controls, and organization suspension. Platform administration does not implicitly grant ordinary organization membership and must be separately audited.

### 6.2 Organization invariants

- Every node, game server, deployment, port lease, DNS record, mod set, backup, operation, policy, secret, and audit event belongs to exactly one organization unless explicitly documented as platform-global.
- A VPS node may host several game servers, but all deployments on that node must belong to the same organization.
- A user may switch between organizations without signing out.
- Every organization must retain at least one Owner.
- An Owner cannot leave or be removed when they are the final Owner.
- Organization slugs are globally unique, immutable by default, and used in human-readable URLs.
- Organization deletion is a durable, audited process that blocks until paid infrastructure, active deployments, credentials, tunnels, DNS, and retention obligations are resolved.

Provider credentials are platform-owned by default and exposed to organizations only through allocation policy. The architecture also supports organization-owned provider accounts behind a feature flag; ordinary users never receive raw platform credentials.

### 6.3 Human identity lifecycle

A human identity is global to Gridora and is linked to a Cloudflare Access subject. Organization authorization comes exclusively from memberships. A newly authenticated identity may have no memberships and must then be directed to the first-organization setup page or an invitation acceptance flow.

### 6.4 Machine identities

The system has separate machine identities for:

- each VPS node, scoped to one organization and one node;
- the control-plane Worker calling an Access-protected node endpoint;
- organization automation clients;
- CI/CD;
- image-build automation;
- optional external API integrations.

Machine identities must not reuse human OAuth credentials and must never be valid across organizations unless explicitly issued as a platform identity.

---

## 7. Terminology

| Term | Meaning |
|---|---|
| **Identity** | A global human or machine principal authenticated by Cloudflare Access or a scoped machine credential |
| **Organization** | The top-level tenant and security boundary for users, policies, infrastructure, servers, and billing controls |
| **Membership** | The relationship assigning one identity a role in one organization |
| **Invitation** | A time-limited request for an identity to join an organization with a specified role |
| **Node** | A managed VPS instance assigned to exactly one organization and capable of running game-server deployments |
| **Game server** | The logical desired configuration of a game server |
| **Deployment** | A concrete installation of a game server on a node |
| **Plugin** | A versioned package implementing one game or a cross-cutting capability |
| **Provider** | An infrastructure provider such as OVHcloud Public Cloud or Contabo |
| **Operation** | A durable lifecycle action such as provisioning, deploying, updating, or restoring |
| **Desired state** | State requested by the control plane |
| **Observed state** | State reported by provider APIs and the node agent |
| **Port lease** | An exclusive assignment of a protocol/port tuple on a node |
| **Node image** | A versioned OS image containing the platform prerequisites |
| **Mod provider** | A plugin capability that resolves and installs game modifications |
| **Management endpoint** | An Access-protected HTTP/WebSocket endpoint reached through Tunnel |
| **Player endpoint** | A public TCP or UDP address used by game clients |

---

## 8. Success criteria

The first production release is successful when all of the following are true:

1. An OVHcloud node can be created, registered, used, drained, and deleted without SSH.
2. A Contabo node can be created and managed with correct monthly-contract and cancellation behavior.
3. A game server can run in dedicated and shared placement modes.
4. A retry during node provisioning cannot create two paid instances.
5. A node exposes no management port to the public Internet.
6. Web and CLI users authenticate through Cloudflare Access.
7. The CLI can create, inspect, update, start, stop, back up, restore, and delete a game server.
8. An Arma Reforger plugin can install the server, render configuration, monitor status, and manage its mod set.
9. A second Linux-native Steam game plugin can be added without changing the core domain or provider packages.
10. Plugin conformance tests run in CI.
11. An orphaned provider instance is detected by reconciliation and surfaced to an administrator.
12. Deleting a game server releases its ports and DNS only after its deployment has stopped or the operation has entered a documented forced-cleanup state.
13. Every mutating action produces an audit event and an operation record.
14. The dashboard can stream operation progress and server logs in near real time.
15. The system enforces maximum active-node, plan, region, and spending policies.
16. A new user can complete sign-up and create a first organization through the web without manual database or Cloudflare changes.
17. A user can belong to and switch between multiple organizations while preserving strict data and command isolation.
18. Owners and Administrators can invite members, assign roles, revoke access, and audit membership changes.
19. Automated cross-organization access tests prove that a valid identity in one organization cannot read, mutate, stream, or infer another organization’s resources.

### 8.1 Initial service targets

These are product targets, not provider guarantees:

- P95 API read latency below 500 ms excluding provider calls.
- P95 command acknowledgement from an online node below 5 seconds.
- Node health considered stale after 60 seconds without a heartbeat.
- Reconciliation detects unmanaged drift within 10 minutes.
- P95 OVHcloud node readiness below 10 minutes when using a promoted custom image.
- P95 Contabo node readiness below 20 minutes when using a promoted custom image.
- No duplicate infrastructure after retry, timeout, or Worker restart test suites.
- At least 99% successful command delivery to nodes that remained online for the full command timeout.
- Recovery point objective for game data determined per plugin, with a default daily backup policy.
- Recovery time target below 30 minutes for a tested backup on a ready node.

---

## 9. System boundaries and deployment topology

### 9.1 Cloudflare control plane

The Cloudflare deployment contains:

- **Web application:** public sign-in/sign-up routes plus an authenticated, organization-scoped Nuxt 4 dashboard served through Worker Assets.
- **API Worker:** Hono edge adapter invoking Effect application services.
- **Durable Objects:** per-node coordination, per-resource serialization, and live event fan-out.
- **Workflows:** durable multi-step infrastructure and game lifecycle operations.
- **Queues:** at-least-once event delivery, telemetry buffering, audit export, and reconciliation work.
- **D1:** relational canonical metadata and desired state.
- **R2:** compressed logs, backups, node-image artifacts, checksums, and large operation artifacts.
- **Cloudflare Access:** human and machine authentication.
- **Cloudflare Tunnel:** outbound-only connectivity from managed nodes.
- **Cloudflare DNS:** player and management records.
- **Worker secrets:** root cryptographic material and platform-wide deployment secrets.

### 9.2 VPS data plane

Each node contains:

- Ubuntu 24.04 LTS x86_64;
- Docker Engine and Compose plugin;
- Traefik;
- `cloudflared`;
- the node agent;
- host firewall configuration;
- persistent server directories;
- optional node-local Steam download cache;
- game-server containers;
- short-lived installer, updater, mod, validation, and backup jobs.

### 9.3 Components that do not run on Cloudflare

The following do not run in Durable Objects:

- game processes;
- SteamCMD installation jobs;
- the node agent;
- Traefik;
- the CLI;
- image building;
- provider-side VMs.

Durable Objects are coordination primitives, not generic VPS replacements. Stateless routes remain Workers, while durable multi-step tasks remain Workflows.

---

## 10. Key architecture decisions

### AD-1 — Cloudflare-native control plane, VPS-native game plane

The control plane is serverless and inexpensive. Player-facing workloads remain on Linux VPS instances because they require arbitrary TCP/UDP listeners, sustained CPU, persistent local data, and game-specific native binaries.

### AD-2 — Hono is the HTTP edge adapter; Effect is the application runtime

Hono is retained because it has first-class Cloudflare Worker and Durable Object support and uses Web Standard request/response primitives.

Hono must not become the domain framework. Its responsibilities are limited to:

- routing;
- request metadata;
- Access authentication middleware;
- request body and size limits;
- response headers;
- conversion between HTTP and typed application commands;
- WebSocket upgrade entrypoints.

All business logic, typed errors, repositories, workflows, provider drivers, scheduling rules, and plugin contracts use Effect 4 services and Layers.

A small internal package, `@gridora/http-hono-effect`, must:

- create or retrieve a managed Effect runtime for the Worker isolate;
- provide native Worker bindings through Layers;
- run one Effect program per request;
- map typed domain errors to a consistent HTTP error format;
- connect `ExecutionContext.waitUntil` only to explicitly non-durable background effects;
- expose test helpers for Hono request tests and Effect service substitution.

The application must not depend on a third-party Hono–Effect bridge unless it passes the same compatibility suite.

### AD-3 — Effect Schema is canonical

Effect Schema defines:

- API request and response contracts;
- CLI manifests;
- plugin configuration;
- provider request normalization;
- event payloads;
- database value decoding;
- operation progress data.

OpenAPI and generated clients are derived from the canonical schemas. Hono route types are adapters, not the source of truth.

### AD-4 — D1 is canonical relational state

D1 stores inventory, desired state, operations, policy, leases, and audit metadata. SQL is accessed only through repository interfaces implemented using `@effect/sql-d1` and the native Worker `D1Database` binding.

Large logs, backup archives, image files, and high-frequency raw telemetry do not belong in D1.

### AD-5 — Durable Objects serialize contested resources

Durable Objects are used for:

- node command sequencing;
- live node sessions;
- exclusive server-operation locks;
- port-allocation locks;
- event fan-out to dashboards;
- short-lived status aggregation.

D1 remains the canonical cross-object inventory. A Durable Object must persist any state required after hibernation.

### AD-6 — Workflows own durable operations

HTTP handlers never wait for an entire VPS or game deployment.

A mutating request:

1. validates authorization and policy;
2. inserts an `operations` row with an idempotency key;
3. starts or resumes a Workflow using the operation ID;
4. returns `202 Accepted`;
5. streams progress through Durable Objects or polling.

### AD-7 — Generic runtime images do not redistribute game binaries

Public OCI images include SteamCMD, runtime dependencies, wrappers, and agent tooling, but not proprietary dedicated-server files unless redistribution is explicitly permitted.

A game plugin runs SteamCMD in an installer/update job and writes the downloaded files into persistent storage. The runtime container mounts those files.

### AD-8 — Plugins are build-time registered in the first release

Cloudflare Workers cannot safely load arbitrary untrusted JavaScript packages at runtime. First-party plugins are workspace packages included through a generated registry at build time.

A new plugin requires a build and deployment but must require no core source changes. Future third-party plugins may use signed OCI sidecars or a constrained WASM runtime after a separate security design.

### AD-9 — Player protocols are not assumed to be hostname-routable

HTTP can be routed by hostname. Most raw game protocols cannot.

Every plugin declares its TCP/UDP port requirements. On a shared VPS, each game server receives unique host ports. DNS names can point multiple game servers to the same IP, but users may still connect with `hostname:port`. SRV records are created only when a plugin declares that the game client supports them.

### AD-10 — Traefik is installed, but direct port publishing remains available

Traefik manages:

- HTTP/HTTPS game administration interfaces;
- optional TCP/UDP entrypoints;
- TLS for compatible endpoints;
- generated routing for plugin-defined web interfaces.

A plugin may request direct Docker host-port publishing for latency-sensitive or protocol-sensitive game traffic. Direct publishing is the default for raw player UDP unless the plugin’s conformance tests approve Traefik proxying.

### AD-11 — Provider deletion semantics stay visible

OVHcloud hourly instances and Contabo monthly contracts do not share the same cost or deletion model. The domain model exposes provider capabilities and lifecycle semantics rather than pretending they are identical.

### AD-12 — Organization context is explicit and defense-in-depth

Organization isolation is enforced at every layer. Organization-owned API routes include the organization identifier, application services require an authorized `OrganizationContext`, repositories require an `OrganizationId`, D1 uniqueness constraints include the organization where relevant, R2 keys and Durable Object names are organization-prefixed, provider resources are tagged with the organization ID, and node credentials are scoped to a single organization.

The application must never authorize a request solely from a client-provided organization slug or a remembered “current organization.” It resolves the organization, verifies membership and role, and then constructs the organization context used by all downstream services.

---

## 11. Functional requirements

### FR-1 — Authentication, account lifecycle, and organization onboarding

1. Gridora must provide public `/sign-in` and `/sign-up` pages with distinct copy and intent, even though both delegate identity verification to Cloudflare Access.
2. Gridora must not store passwords. Authentication methods are configured through Cloudflare Access identity providers.
3. The authenticated dashboard and API must be protected by Cloudflare Access.
4. The API must validate the Access JWT signature, issuer, audience, expiry, and identity claims.
5. On successful authentication, Gridora must resolve or create the local identity according to sign-in, sign-up, or invitation intent.
6. A sign-in attempt for an authenticated Access identity with no Gridora account must route to sign-up completion rather than silently creating an account.
7. A sign-up attempt must create the local identity idempotently and route the user to an invitation or first-organization setup flow.
8. Open sign-up is the default product mode; deployments may configure invitation-only or disabled sign-up without removing the sign-up page.
9. A newly registered user with no accepted invitation and no membership must be redirected to `/setup/organization` before accessing the dashboard.
10. The first-organization setup page must collect at least organization name, unique slug, timezone, default region preference, and acceptance of required terms.
11. Creating an organization and its initial Owner membership must be atomic and idempotent.
12. A user can create additional organizations from the organization switcher when platform policy permits.
13. Owners and Administrators can invite users by email, choose an allowed role, revoke pending invitations, resend invitations, and remove or change members subject to last-Owner protection.
14. Invitation tokens must be single-purpose, time-limited, stored only as hashes, and invalidated after acceptance or revocation.
15. A signed-in user can list and switch among all organizations where they have active membership.
16. Every organization-scoped API operation must resolve an organization, identity, membership, and role before application logic runs.
17. Authorization must be enforced in Effect application services and repository boundaries, not only in route middleware or UI state.
18. Membership, invitation, ownership, sign-up, sign-in, organization creation, switching, suspension, and deletion events must be audited.
19. The CLI must use Cloudflare Access Managed OAuth with Authorization Code and PKCE.
20. CLI tokens must be stored in the operating-system credential store.
21. The node agent must use machine authentication separate from human OAuth and scoped to one organization and node.
22. Automation identities must support organization-scoped, revocable credentials.
23. Destructive operations must require an Owner or Administrator unless policy explicitly delegates them.
24. Suspended identities or organizations must immediately lose authorization for new requests while preserving an auditable state.

### FR-2 — Provider accounts

1. Provider accounts have an explicit scope: `platform` or `organization`.
2. Platform Administrators can add, validate, disable, rotate, and remove platform-owned provider credentials.
3. Organization Owners can manage organization-owned provider credentials only when bring-your-own-provider mode is enabled.
4. Organizations may use platform-owned provider capacity only through an explicit allocation policy; they never receive the underlying credentials.
5. Credentials are encrypted before storage and access is audited.
6. A validation action must verify authentication and list accessible regions or projects without creating resources.
7. Provider plan and region metadata must be cached with a refresh timestamp and filtered by organization policy.
8. The UI must show provider capabilities, allocation source, and billing semantics without exposing credentials.
9. Provider accounts can be restricted to organizations, regions, plans, and maximum active nodes.
10. A disabled provider account cannot be used for new operations but existing nodes remain visible and manageable when possible.
11. Provider API errors must be normalized into typed categories.

### FR-3 — Node-image lifecycle

1. The image pipeline must build an immutable x86_64 QCOW2 image from a pinned Ubuntu 24.04 LTS base.
2. The image must include Docker, Compose, Traefik, cloudflared, the node bootstrap/agent, firewall tooling, time synchronization, and backup utilities.
3. The image build must emit a manifest, checksum, SBOM, build log, and signature.
4. Images must be scanned before promotion.
5. Images have states: `building`, `testing`, `promoted`, `deprecated`, and `revoked`.
6. A promoted image must be registered with each supported provider and region before it is selectable.
7. A node records the exact image version used.
8. Secrets must never be baked into the image.
9. A stock-image plus cloud-init fallback must exist for provider/image outages.
10. Image replacement must be supported through node drain and rebuild, not in-place undocumented mutation.

### FR-4 — VPS node lifecycle

The platform must support:

- create;
- inspect;
- start;
- stop;
- reboot;
- rebuild/reinstall;
- enter and leave drain mode;
- reconcile;
- retire;
- delete or schedule cancellation;
- revoke Tunnel and machine credentials;
- remove or preserve DNS according to policy.

Every node belongs to exactly one organization. A shared node may host multiple game servers only from that organization.

A node is not `ready` until:

- the provider reports it active;
- the agent has registered;
- the Tunnel is healthy;
- Docker is healthy;
- the expected image version is reported;
- capacity and network facts are reported;
- required firewall policy is applied.

### FR-5 — Placement and scheduling

A game server can request:

- `auto`;
- `shared`;
- `dedicated`;
- `pinned` to a specific node;
- a preferred provider;
- a preferred region;
- a required architecture;
- minimum and maximum CPU, RAM, and disk;
- labels and anti-affinity;
- a maximum acceptable estimated cost.

The scheduler must:

1. reject incompatible nodes;
2. reserve capacity;
3. reserve ports atomically;
4. prefer nodes with the required game files cached when policy allows;
5. obey drain state;
6. obey organization and provider quotas;
7. reject every node assigned to a different organization;
8. record a human-readable placement explanation;
9. provision a new node when no existing node fits and policy permits;
10. release reservations after failed or cancelled operations;
11. prevent two concurrent deployments from acquiring the same port.

### FR-6 — Game plugin catalog

The web and CLI must list:

- plugin ID;
- display name;
- plugin version;
- plugin API version;
- supported OS and architecture;
- Steam App ID;
- login requirements;
- default resources;
- required ports;
- mod capabilities;
- backup capabilities;
- health capabilities;
- supported configuration schema version;
- known limitations.

Disabled or incompatible plugins cannot create new deployments, but existing deployments remain manageable according to compatibility policy.

### FR-7 — Game-server lifecycle

The system must support:

- create draft;
- validate;
- plan;
- schedule;
- install;
- configure;
- start;
- stop;
- restart;
- update;
- validate files;
- back up;
- restore;
- move with downtime;
- clone;
- delete;
- force cleanup after a failed node.

Every transition is an operation with progress, logs, cancellation policy, and audit metadata.

### FR-8 — Configuration

1. Plugins provide a versioned typed configuration schema.
2. The dashboard generates a default form from the schema.
3. Plugins may add custom UI contributions for complex settings.
4. Configuration changes support preview/diff before apply.
5. Secrets are represented as references, never returned as plaintext after creation.
6. The plugin decides whether a change requires hot reload, game restart, container restart, reinstall, or rejection.
7. Configuration is rendered into a staging directory and validated before activation.
8. The previous known-good configuration is retained for rollback.
9. Every applied configuration has a version and actor.
10. Raw arbitrary launch arguments are disabled by default and Owner-gated if enabled.

### FR-9 — Steam installation and updates

1. Plugins declare a Steam dedicated-server App ID.
2. Supported login modes are `anonymous` and `credentialed`.
3. Anonymous mode is preferred.
4. Credentialed mode is feature-gated until secure Steam Guard handling is implemented.
5. SteamCMD runs as an unprivileged user.
6. Installation writes into a persistent server-data volume.
7. The product records the installed build identifier when available.
8. Updates can be automatic, scheduled, or manual.
9. An update can require backup-before-update.
10. A failed update must leave a diagnosable state and attempt rollback when the plugin supports it.
11. Game files must not be uploaded to R2 or a public OCI registry unless redistribution rights are confirmed.
12. Node-local download caching may be used without treating the cache as a backup.

### FR-10 — Mod management

The generic core must support:

- a desired mod set;
- source/provider;
- mod identifier;
- requested version or channel;
- resolved version;
- dependency graph;
- load order;
- compatibility status;
- installation plan;
- staged activation;
- rollback;
- configuration contribution;
- provenance and license metadata when available.

A game plugin may implement one or more `ModProviderAdapter` capabilities.

For Arma Reforger, the plugin must be able to own all logic for:

- importing a supported Workshop or Workbench web-page reference;
- extracting the mod identity;
- resolving metadata using supported endpoints;
- resolving dependencies when data is available;
- producing the server configuration fragment;
- staging mod downloads;
- validating the installed mod set;
- showing game-specific errors and compatibility warnings.

No Arma-specific URL, field, API, filesystem path, or UI component may appear in a core package.

### FR-11 — Monitoring and health

Health is hierarchical:

```text
provider health
  └── node health
       └── Docker/container health
            └── game process health
                 └── game protocol/query health
```

The platform must expose:

- provider state;
- agent last seen;
- Tunnel state;
- node CPU, RAM, disk, load, and network;
- container state, health, restart count, and resource use;
- game process status;
- query status;
- map/scenario;
- player count when supported;
- version/build;
- mod-set status;
- last successful backup;
- current operation;
- actionable degradation reason.

A running container is not enough to mark a game server healthy.

### FR-12 — Logs and console

1. Users can stream current logs through the web dashboard and CLI.
2. Streaming uses a node/session Durable Object and WebSocket.
3. The agent redacts known secrets before transmission.
4. Logs can be filtered by server, component, level, and time.
5. Archived logs are compressed and stored in R2 according to retention policy.
6. Plugins may provide structured log parsing.
7. RCON or in-game console support is a plugin capability.
8. Arbitrary host shell access is not part of the normal product UI.
9. Break-glass SSH is an Owner-only separately audited procedure.

### FR-13 — Backup and restore

1. Plugins declare data paths, exclusion paths, quiesce hooks, and restore validation.
2. Backups include metadata: plugin, game build, config version, mod-set version, node, timestamp, size, checksum, and encryption key version.
3. Backups are streamed to R2 and encrypted.
4. A backup can be crash-consistent or plugin-quiesced; the UI must show which.
5. Retention policies support count and age.
6. Restore can target the same or another compatible node.
7. Restore must stage and validate before replacing active data.
8. Backup deletion is audited.
9. A node deletion workflow must enforce configured backup policy.
10. Cross-node “move” is implemented as stop, backup/snapshot, deploy, restore, validate, DNS/port switch, and cleanup.

### FR-14 — DNS and endpoints

1. Each game server can receive a stable slug and domain.
2. Player records use DNS-only A/AAAA records unless Spectrum is explicitly configured.
3. Multiple game domains may point to one shared-node IP.
4. The UI always displays the actual required `host:port`.
5. SRV records are created only for plugins that declare client support.
6. HTTP administration endpoints can use hostname routing through Traefik and Tunnel.
7. DNS records have an owner resource ID for deterministic cleanup.
8. DNS changes are part of operation progress and reconciliation.
9. A stale DNS record is detected and surfaced.
10. Cloudflare proxy status must never be silently enabled for unsupported raw game traffic.

### FR-15 — Web dashboard

The web application must provide:

- public sign-in and sign-up pages;
- invitation acceptance and expired-invitation pages;
- a required first-organization setup page;
- an organization switcher visible throughout the authenticated application;
- organization profile, members, invitations, roles, settings, and deletion controls;
- overview;
- game servers;
- nodes;
- create/deploy wizard;
- plugin catalog;
- mods;
- live operations;
- logs and console;
- backups;
- provider allocation or provider accounts according to role and feature flags;
- node images where authorized;
- policies and quotas;
- audit log;
- user profile and sessions;
- settings.

Authenticated application URLs must include the organization slug, for example `/o/night-watch/servers`, so bookmarks and browser history preserve tenant context. Switching organizations must navigate to the equivalent permitted destination or the target organization overview.

The create wizard must show:

- selected game;
- plugin version;
- placement mode;
- provider/region/plan or auto-placement;
- resource requirements;
- estimated monthly or hourly cost when available;
- ports;
- domain;
- configuration;
- mods;
- backup policy;
- restart/update policy;
- provider-specific billing warning;
- final plan and confirmation.

### FR-16 — CLI

The CLI must support interactive and non-interactive use.

Core command tree:

```text
gridora auth login
gridora auth logout
gridora auth status

gridora organizations list
gridora organizations create
gridora organizations show <organization>
gridora organizations switch <organization>
gridora organizations members list <organization>
gridora organizations members update <organization> <member>
gridora organizations members remove <organization> <member>
gridora organizations invitations create <organization>
gridora organizations invitations list <organization>
gridora organizations invitations revoke <organization> <invitation>
gridora organizations leave <organization>

gridora plugins list
gridora plugins show <plugin>

gridora providers list
gridora providers test <provider-account>
gridora providers refresh <provider-account>

gridora nodes list
gridora nodes create
gridora nodes show <node>
gridora nodes drain <node>
gridora nodes uncordon <node>
gridora nodes start|stop|reboot <node>
gridora nodes rebuild <node>
gridora nodes delete <node>

gridora servers list
gridora servers plan -f server.yaml
gridora servers apply -f server.yaml
gridora servers show <server>
gridora servers start|stop|restart <server>
gridora servers update <server>
gridora servers move <server> --node <node>
gridora servers delete <server>

gridora servers config get <server>
gridora servers config diff <server> -f config.yaml
gridora servers config apply <server> -f config.yaml

gridora mods list <server>
gridora mods plan <server> -f mods.yaml
gridora mods sync <server> -f mods.yaml

gridora logs <server> --follow
gridora console <server>

gridora backups list <server>
gridora backups create <server>
gridora backups restore <backup>

gridora operations list
gridora operations show <operation>
gridora operations watch <operation>
gridora operations cancel <operation>
```

CLI requirements:

- `--output table|json|yaml`;
- `--wait`;
- `--timeout`;
- `--idempotency-key`;
- `--organization <id-or-slug>` on every organization-scoped command;
- a locally stored active organization per CLI profile, used only as a client default and always re-authorized by the API;
- stable exit codes;
- no ANSI when output is redirected;
- OS keychain token storage;
- OAuth loopback callback with PKCE;
- browser launch plus a printable URL fallback;
- no provider or Steam secret output;
- machine-readable error envelope;
- generated API client from the canonical contract.

### FR-17 — Declarative manifests

Example:

```yaml
apiVersion: games.gridora.example/v1alpha1
kind: GameServer
metadata:
  name: eastern-front
  organization: night-watch
spec:
  plugin:
    id: arma-reforger
    version: 1.0.0
  placement:
    mode: shared
    providerPreference:
      - ovh-public-cloud
      - contabo
    regionPreference:
      - EU-WEST
    resources:
      cpu: 4
      memoryMiB: 8192
      diskGiB: 80
  endpoint:
    hostname: eastern-front.night-watch.games.gridora.example
  updatePolicy:
    mode: manual
    backupBeforeUpdate: true
  backupPolicy:
    schedule: "0 4 * * *"
    retainCount: 7
  config:
    name: Eastern Front
    maxPlayers: 16
  mods:
    - source: arma-workshop
      reference: "plugin-specific-reference"
```

`plan` must report:

- create/update/delete actions;
- placement decision;
- new paid infrastructure;
- port changes;
- DNS changes;
- restart/downtime;
- mod changes;
- backup implications;
- provider billing warnings.

### FR-18 — Audit

Every mutating action must record:

- timestamp;
- actor type and ID;
- organization;
- request/correlation ID;
- action;
- target type and ID;
- before/after summary;
- operation ID;
- source IP and Access identity metadata when available;
- result;
- error classification;
- forced or break-glass flag.

Audit events are append-only at the application layer and periodically exported to R2.

### FR-19 — Policies and cost controls

Policies are defined per organization unless explicitly platform-global. The platform must support:

- allowed providers;
- allowed regions;
- allowed plans;
- maximum active nodes;
- maximum dedicated nodes;
- maximum servers per node;
- maximum CPU/RAM/disk per deployment;
- monthly soft and hard budget;
- automatic expiry for temporary nodes;
- idle shutdown or deletion policy;
- required backup before deletion;
- maintenance windows;
- automatic-update policy;
- maximum Contabo contract period;
- explicit confirmation for non-hourly commitments.

Provider-reported prices are estimates. The provider invoice remains authoritative.

---

## 12. Steam and container packaging model

### 12.1 Three-part workload

Each deployment uses three conceptual artifacts:

1. **Installer/updater image**
   - contains SteamCMD and generic scripts;
   - downloads or updates the game into persistent storage;
   - exits after validation.

2. **Plugin runtime image**
   - contains only redistributable runtime dependencies and entrypoint logic;
   - mounts installed game files;
   - launches the dedicated server as an unprivileged user.

3. **Persistent server data**
   - game files;
   - configuration;
   - saves/profile;
   - mods;
   - staged updates;
   - local backup staging.

### 12.2 Filesystem convention

```text
/var/lib/gridora/
  servers/
    <server-id>/
      game/          # Steam-installed server files
      config/        # rendered configuration
      data/          # saves/profile/runtime data
      mods/          # installed mods
      staging/       # atomic update/config staging
      backups/       # temporary local backup staging
      state/         # agent/plugin local state
```

Each directory has a plugin-declared ownership and backup policy.

### 12.3 Container requirements

Game containers must:

- run as a non-root UID/GID unless the plugin documents an unavoidable exception;
- drop Linux capabilities by default;
- not run privileged;
- not mount the Docker socket;
- have explicit CPU, memory, PID, and disk policies;
- have bounded log rotation;
- have a stop grace period;
- receive only required secrets;
- use a dedicated Docker network;
- have immutable first-party image digests;
- expose only leased ports;
- be labeled with organization, server, deployment, plugin, and operation IDs.

### 12.4 Generated deployment specification

The control plane produces a signed, normalized `DeploymentSpec`. The node agent validates:

- signature;
- organization;
- node target;
- plugin API version;
- plugin version;
- allowed image digests;
- leased ports;
- permitted mount roots;
- resource limits;
- command expiry;
- operation ID.

The agent, not the user, renders Docker Compose or Docker API calls from this specification.

### 12.5 Steam credentials

Initial support:

- anonymous SteamCMD downloads;
- encrypted credential references in the domain model;
- no plaintext password retrieval;
- no credential in generated Compose files or logs.

Credentialed Steam support is not considered production-ready until the product has a secure Steam Guard flow and operational policy for account lockout, session expiry, and publisher terms.

---

## 13. Plugin system

### 13.1 Plugin goals

The plugin system must allow a game to define all of its specialized behavior without leaking that behavior into core packages.

A plugin may contribute:

- identity and metadata;
- Steam installation metadata;
- compatibility constraints;
- default resources;
- ports and protocols;
- config schema and defaults;
- configuration renderer;
- launch plan;
- stop/reload behavior;
- health checks;
- game query protocol;
- log parser;
- console/RCON adapter;
- backup hooks;
- restore validation;
- update strategy;
- mod providers;
- custom dashboard components;
- custom dashboard pages;
- CLI manifest schema;
- plugin-owned migrations;
- documentation and diagnostics.

### 13.2 Four plugin facets

Each game plugin is split into four facets.

#### Manifest facet

Pure data and schemas safe to consume everywhere:

- IDs;
- versions;
- capabilities;
- resources;
- ports;
- config schema;
- compatibility;
- UI metadata.

#### Control facet

Runs in Cloudflare:

- validation;
- deployment-plan generation;
- desired-state normalization;
- scheduler constraints;
- mod metadata resolution;
- workflow hooks that do not require local game files;
- API and audit redaction rules.

#### Agent facet

Runs on the VPS:

- filesystem operations;
- SteamCMD command generation;
- config rendering;
- process launch;
- game query;
- log parsing;
- mod installation;
- backup and restore hooks;
- local validation.

#### UI facet

Runs in Nuxt:

- custom form fields;
- mod browser/import flow;
- status panels;
- diagnostics;
- plugin-specific pages.

Most plugins should use schema-generated forms. Custom Vue code is reserved for workflows that cannot be represented safely as ordinary fields.

### 13.3 Workspace layout

```text
plugins/
  games/
    arma-reforger/
      package.json
      manifest/
      schemas/
      control/
      agent/
      ui/
      migrations/
      tests/
      fixtures/
      README.md
```

Published internal packages may be split further:

```text
@gridora/plugin-arma-reforger-manifest
@gridora/plugin-arma-reforger-control
@gridora/plugin-arma-reforger-agent
@gridora/plugin-arma-reforger-ui
```

### 13.4 Plugin SDK packages

```text
@gridora/plugin-sdk
@gridora/plugin-sdk-control
@gridora/plugin-sdk-agent
@gridora/plugin-sdk-ui
@gridora/plugin-testkit
```

### 13.5 Illustrative manifest contract

```ts
export interface GamePluginManifest {
  readonly apiVersion: "gridora.plugin/v1alpha1"
  readonly id: string
  readonly version: string
  readonly displayName: string

  readonly compatibility: {
    readonly os: readonly ["linux"]
    readonly architectures: readonly ("amd64" | "arm64")[]
    readonly nativeLinux: boolean
    readonly requiresProton: boolean
  }

  readonly steam: {
    readonly appId: number
    readonly loginMode: "anonymous" | "credentialed"
    readonly branchSupport: boolean
    readonly installDirectory: string
  }

  readonly resources: {
    readonly minimum: ResourceRequest
    readonly recommended: ResourceRequest
    readonly sharedNodeAllowed: boolean
  }

  readonly ports: readonly PortDefinition[]
  readonly configSchemaVersion: number
  readonly capabilities: readonly PluginCapability[]
}
```

### 13.6 Capability interfaces

The SDK defines narrowly scoped capabilities:

```text
InstallAdapter
UpdateAdapter
LifecycleAdapter
ConfigAdapter
HealthAdapter
QueryAdapter
LogAdapter
ConsoleAdapter
BackupAdapter
RestoreAdapter
ModProviderAdapter
PortDefinition
ResourcePolicy
UiContribution
DiagnosticAdapter
```

A plugin declares only the capabilities it implements. The dashboard and CLI hide unsupported actions.

### 13.7 Versioning and compatibility

Every plugin declares:

- `pluginVersion`;
- `pluginApiVersion`;
- supported agent API range;
- supported control-plane API range;
- configuration schema version;
- migration functions;
- data format version.

Before a deployment, the control plane verifies that the node agent contains a compatible agent facet. If not, the agent is upgraded or the deployment is blocked.

Plugin configuration migrations must be:

- deterministic;
- version-by-version;
- reversible where practical;
- tested with fixtures;
- visible in a plan.

### 13.8 Registry generation

A Vite+ task generates three registries:

- control registry;
- agent registry;
- UI registry.

The generator validates:

- unique IDs;
- unique versions;
- dependency boundaries;
- schema compatibility;
- required exports;
- migration continuity;
- test fixture presence.

No plugin may import another game plugin. Shared behavior belongs in a generic SDK package.

### 13.9 Plugin permissions

Each agent facet declares required permissions:

- filesystem roots;
- allowed executable names;
- allowed network destinations;
- Docker actions;
- secret categories;
- port protocols;
- backup access;
- mod source domains.

The agent rejects an operation that exceeds the promoted plugin permission manifest.

### 13.10 Third-party plugin future

The first release supports reviewed, first-party, build-time plugins only.

A future third-party design may use:

- signed OCI sidecars for agent logic;
- WASM for pure validation/transformation;
- JSON Schema for UI;
- explicit capability grants;
- signature and publisher trust;
- resource and network sandboxing.

Dynamic `eval`, remote JavaScript imports, and unreviewed Worker code are forbidden.

---

## 14. Arma Reforger reference plugin

Arma Reforger is the reference plugin used to prove the architecture, not a special case in core.

The plugin owns:

- Steam server App ID and installation;
- Linux runtime dependencies;
- server JSON/config schema;
- scenario configuration;
- game-specific launch arguments;
- player and query ports;
- process health;
- log parsing;
- status/query integration;
- profile and save paths;
- mod fields and load order;
- Workbench/Workshop reference import;
- mod dependency and compatibility messages;
- generated server mod configuration;
- backup and restore hooks;
- custom mod-management UI.

### 14.1 Workbench web-page integration

The Arma plugin may provide a custom UI page that:

1. accepts a supported Workbench/Workshop URL or reference;
2. parses and validates it;
3. retrieves metadata through a documented/supported mechanism;
4. resolves the mod identity and dependencies when possible;
5. previews changes to the desired mod set;
6. shows source, version, size, compatibility, and warnings;
7. generates a mod install plan;
8. stages downloads;
9. validates activation;
10. rolls back on failure.

This integration must be isolated entirely under the Arma plugin. If the source page or API changes, only the plugin is updated.

### 14.2 Acceptance test for plugin isolation

The second reference game plugin must compile and pass deployment tests after deleting the Arma plugin package from the workspace. Core tests must still pass.

---

## 15. VPS node image and bootstrap

### 15.1 Base image

Default:

- Ubuntu 24.04 LTS;
- x86_64/amd64;
- cloud-init enabled;
- no password SSH;
- root SSH disabled;
- a dedicated `gridora` administration user;
- automatic time synchronization;
- unattended security-update download;
- controlled reboot only in a maintenance window.

### 15.2 Preinstalled components

The promoted image includes:

- Docker Engine;
- Docker Compose plugin;
- Traefik;
- cloudflared;
- node agent or bootstrap agent;
- nftables/compatible firewall tooling;
- `curl`, `jq`, `ca-certificates`, `zstd`, `tar`, and health diagnostics;
- journald limits;
- disk and filesystem prerequisites;
- trusted first-party OCI signing roots;
- systemd units for agent, Tunnel, and recovery.

### 15.3 Image pipeline

```text
Pinned Ubuntu source
  → Packer build
  → package installation
  → hardening
  → unit/image tests
  → vulnerability scan
  → SBOM
  → checksum and signature
  → QCOW2 artifact in private R2
  → provider registration
  → disposable smoke-test node
  → promotion
```

Image naming:

```text
gridora-node-2026-08-23.1-amd64
```

### 15.4 Provider registration

#### OVHcloud Public Cloud

- upload/register the QCOW2 image through OpenStack image APIs;
- copy/register per supported region as needed;
- record the OpenStack image ID by region.

#### Contabo

- create a custom image through the Contabo API using a short-lived signed download URL;
- poll image import status;
- record the Contabo image ID;
- verify custom-image cloud-init support in the image itself.

### 15.5 Bootstrap data

Cloud-init contains only per-node bootstrap data:

- node ID;
- organization ID;
- operation ID;
- one-time registration token;
- Tunnel token or connector credential;
- control-plane URLs;
- expected image version;
- optional SSH public key;
- initial labels.

The registration token:

- is single-use;
- expires quickly;
- is scoped to the expected provider instance ID;
- cannot manage other nodes;
- is invalidated immediately after registration.

### 15.6 Bootstrap sequence

```text
provider creates node
  → node boots promoted image
  → cloudflared connects outbound
  → agent registers with one-time token
  → control plane verifies provider instance identity
  → node creates or receives long-lived machine identity
  → bootstrap token is revoked
  → agent reports capabilities and health
  → firewall and DNS are reconciled
  → node becomes ready
```

---

## 16. Provider abstraction

### 16.1 Package boundaries

```text
@gridora/provider-sdk
@gridora/provider-ovh-public-cloud
@gridora/provider-contabo
```

The SDK contains domain contracts and typed errors. Provider packages contain API clients and translations only.

### 16.2 Required provider capabilities

```ts
export interface ComputeProvider {
  readonly capabilities: ProviderCapabilities

  listRegions(input: ListRegionsInput): ProviderEffect<readonly Region[]>
  listPlans(input: ListPlansInput): ProviderEffect<readonly Plan[]>
  listImages(input: ListImagesInput): ProviderEffect<readonly ProviderImage[]>

  createNode(input: CreateNodeInput): ProviderEffect<ProviderNode>
  getNode(input: GetNodeInput): ProviderEffect<ProviderNode>
  listNodes(input: ListNodesInput): ProviderEffect<readonly ProviderNode[]>

  startNode(input: NodeActionInput): ProviderEffect<void>
  stopNode(input: NodeActionInput): ProviderEffect<void>
  rebootNode(input: NodeActionInput): ProviderEffect<void>
  rebuildNode(input: RebuildNodeInput): ProviderEffect<void>
  retireNode(input: RetireNodeInput): ProviderEffect<RetirementResult>

  createSnapshot(input: CreateSnapshotInput): ProviderEffect<ProviderSnapshot>
  deleteSnapshot(input: DeleteSnapshotInput): ProviderEffect<void>

  applyFirewall(input: ApplyFirewallInput): ProviderEffect<FirewallResult>
}
```

`ProviderEffect` is an Effect value with normalized provider errors and injected provider dependencies.

### 16.3 Provider capabilities

```ts
export interface ProviderCapabilities {
  readonly hourlyBilling: boolean
  readonly immediateDelete: boolean
  readonly scheduledCancellation: boolean
  readonly cloudInit: boolean
  readonly customImages: boolean
  readonly snapshots: boolean
  readonly nativeFirewall: boolean
  readonly privateNetworking: boolean
  readonly floatingIp: boolean
  readonly rebuild: boolean
}
```

### 16.4 Normalized errors

Provider packages map errors into:

- `ProviderAuthenticationError`;
- `ProviderAuthorizationError`;
- `ProviderValidationError`;
- `ProviderQuotaError`;
- `ProviderNotFoundError`;
- `ProviderConflictError`;
- `ProviderRateLimitError`;
- `ProviderTemporaryError`;
- `ProviderBillingActionRequiredError`;
- `ProviderUnsupportedCapabilityError`;
- `ProviderUnknownError`.

Only retryable categories are retried automatically.

### 16.5 OVHcloud Public Cloud driver

The OVH package uses OpenStack APIs for:

- instance lifecycle;
- flavors;
- regions;
- images;
- cloud-init user data;
- security groups;
- snapshots/volumes where supported;
- server metadata and tags.

The driver must use a product idempotency record plus provider metadata/tagging. If a create call times out, the workflow searches for an existing instance with the operation ID before retrying.

Suggested metadata:

```text
managed-by=gridora
organization-id=<id>
node-id=<id>
operation-id=<id>
image-version=<version>
```

### 16.6 Contabo driver

The Contabo package uses its REST API for:

- instance creation;
- image selection;
- cloud-init `userData`;
- start, stop, restart, shutdown, rescue, and rebuild capabilities;
- snapshots;
- custom image import;
- optional firewall management;
- cancellation.

Contabo nodes must preserve their contract period and cancellation date in the domain model.

A Contabo “delete” action is modeled as one of:

- `cancel_at_earliest_date`;
- `secure_wipe_and_stop`;
- `cancel_scheduled`;
- `contract_ended`.

The UI must not claim that cancellation immediately stops billing.

If native firewall use requires a paid add-on, policy must choose between:

- purchasing/using the add-on;
- applying the host firewall only;
- rejecting the plan as non-compliant.

### 16.7 Capability matrix

| Capability | OVHcloud Public Cloud | Contabo |
|---|---:|---:|
| API create/manage | Yes | Yes |
| Cloud-init | Yes | Yes |
| Custom image | Yes | Yes, QCOW2/ISO import |
| Hourly/disposable mode | Yes, on eligible Public Cloud instances | No; monthly contract semantics |
| Immediate infrastructure deletion | Yes | Not equivalent to hourly deletion |
| Native firewall/security group | Yes | Available with provider-specific conditions/add-on |
| Snapshot support | Yes | Yes |
| Provider-neutral custom image pipeline | Yes | Yes |
| Best use | Elastic or temporary nodes | Cheap persistent nodes |

---

## 17. Scheduling and capacity

### 17.1 Capacity model

Each node reports:

- logical CPU;
- memory;
- total and free disk;
- architecture;
- kernel and Docker versions;
- image version;
- provider;
- region;
- network addresses;
- current port leases;
- current deployments;
- labels;
- drain state;
- game/depot cache facts.

Each deployment requests:

- CPU reservation and limit;
- memory reservation and limit;
- disk reservation;
- required ports;
- minimum image/agent/plugin version;
- architecture;
- dedicated/shared policy;
- labels;
- region/provider preferences.

### 17.2 Admission rules

Default policy:

- memory is not overcommitted;
- disk is not overcommitted;
- CPU overcommit is disabled initially;
- host reserves configurable system headroom;
- a plugin can require dedicated placement;
- a node in drain mode accepts no new deployments;
- a port/protocol tuple is exclusive;
- a server cannot be placed on an incompatible agent/plugin version.

### 17.3 Scoring

After hard constraints pass, the scheduler scores candidates using:

- preferred provider;
- preferred region;
- available headroom;
- lower estimated marginal cost;
- existing Steam/game cache;
- balanced utilization;
- anti-affinity;
- fewer port translations;
- operator labels.

The placement record stores the score factors and rejected alternatives.

### 17.4 Auto-provision

If no node fits:

1. determine eligible provider/region/plan combinations;
2. estimate cost and contract implications;
3. enforce budget policy;
4. reserve an operation idempotency key;
5. provision a node;
6. wait for readiness;
7. deploy the game server.

### 17.5 Drain and move

Drain mode:

- blocks new placement;
- lists affected game servers;
- optionally moves deployments sequentially;
- honors backup and downtime policy;
- completes only when no active deployment remains or an administrator forces it.

Live migration is not required. Moves are backup/restore operations with downtime.

---

## 18. Networking, domains, and reverse proxy

### 18.1 Management networking

Each node receives one remotely managed Cloudflare Tunnel.

Suggested hostname:

```text
node-<node-id>.mgmt.gridora.example
```

The Tunnel exposes only the node-agent HTTP/WebSocket service on loopback or a private Docker network.

Cloudflare Access applies a Service Auth policy. The origin additionally verifies a signed control-plane request to prevent a stolen generic service credential from controlling every node.

The agent may also initiate an outbound heartbeat/event stream to the API. This improves liveness detection but does not replace Tunnel as the managed node endpoint.

### 18.2 Player networking

Player traffic follows:

```text
player
  → DNS-only A/AAAA
  → VPS public IP
  → allocated host TCP/UDP port
  → game container
```

Cloudflare proxying is disabled for player records by default.

Cloudflare Spectrum is an optional future capability, not a dependency.

### 18.3 Domain model

Example:

```text
eastern-front.night-watch.games.gridora.example  A  203.0.113.10  DNS only
```

On a shared node:

```text
server-a.night-watch.games.gridora.example → 203.0.113.10:2001/udp
server-b.night-watch.games.gridora.example → 203.0.113.10:2101/udp
```

DNS itself does not encode those ports. The UI and CLI must always expose the actual connection address.

### 18.4 Traefik

Traefik is responsible for:

- HTTP/HTTPS plugin administration pages;
- TLS termination where applicable;
- optional TCP/UDP forwarding;
- Docker-driven route discovery from agent-generated labels;
- local routing behind Tunnel.

Traefik’s dashboard must be disabled or bound only to an Access-protected management route.

Because UDP cannot be multiplexed by HTTP host/path semantics, every UDP game endpoint receives a distinct entrypoint/port. A plugin can bypass Traefik and publish the leased port directly.

### 18.5 Port allocator

A `NodeCoordinatorDO` serializes allocations for each node.

A port lease contains:

- node ID;
- server/deployment ID;
- protocol;
- public port;
- container port;
- purpose: player/query/RCON/admin;
- state;
- created and released timestamps;
- operation ID.

Lease flow:

```text
requested
  → reserved
  → applied
  → active
  → releasing
  → released
```

Stale reservations are reclaimed only after checking the node’s observed Docker/network state.

### 18.6 Firewall policy

Default inbound policy is deny.

Allowed inbound traffic:

- active player/query ports;
- optional ICMP;
- explicitly configured public web endpoints;
- break-glass SSH from an allowlist, disabled by default.

Management does not require public SSH or agent ports.

---

## 19. Node agent

### 19.1 Responsibilities

The agent:

- registers the node;
- reports inventory and health;
- validates signed deployment specs;
- manages Docker containers, networks, volumes, and jobs;
- manages Traefik dynamic configuration;
- applies host firewall rules;
- executes plugin agent capabilities;
- streams logs;
- runs game queries;
- stages config and mod changes;
- creates and restores backups;
- reconciles desired and observed state;
- reports operation progress;
- upgrades itself safely.

The agent does not:

- call OVHcloud or Contabo APIs;
- possess provider credentials;
- make scheduling decisions;
- execute arbitrary user shell;
- load untrusted JavaScript;
- expose the Docker socket to game containers.

### 19.2 Deployment model

The agent may run as:

- a hardened systemd service with access to the Docker socket; or
- a dedicated container with a restricted Docker socket proxy.

The preferred first implementation is a systemd-managed agent because it must survive and repair Docker-level failures. Its build remains TypeScript/Effect and is bundled for a pinned Node.js runtime.

### 19.3 Local state

The agent stores only reconstructible or node-local state:

- last applied deployment-spec hashes;
- command sequence acknowledgements;
- plugin local state;
- cached health;
- local operation logs;
- backup staging;
- cache metadata.

D1 remains the canonical control-plane state.

### 19.4 Command protocol

Each command contains:

- command ID;
- operation ID;
- node ID;
- resource ID;
- command type;
- payload schema version;
- plugin ID/version when applicable;
- issued time;
- expiry;
- idempotency key;
- expected prior revision;
- signature.

The agent stores completed command IDs and returns the prior result on duplicate delivery.

### 19.5 Agent update

Agent updates are:

1. staged;
2. signature-verified;
3. compatibility-checked;
4. health-checked;
5. activated with rollback;
6. reported to the control plane.

Nodes can be blocked from new deployments when below the minimum supported agent version.

---

## 20. Cloudflare application architecture

### 20.1 Web

`apps/web` contains two route groups:

1. **Public authentication shell** — sign-in, sign-up, invitation status, legal links, and authentication errors.
2. **Authenticated organization application** — onboarding, organization switcher, dashboard, infrastructure, servers, and administration.

Technology:

- Nuxt 4;
- Nuxt UI;
- Tailwind;
- TanStack Query for server state;
- TanStack Table where complex tabular UI is needed;
- generated API client;
- build-time plugin UI registry.

The public authentication shell may be hosted at `app.gridora.example`. The authenticated application is hosted at `console.gridora.example` and protected by Cloudflare Access. Public sign-in and sign-up calls-to-action redirect to an Access-protected completion route carrying a short-lived, integrity-protected intent value.

Default dashboard rendering mode is a client-rendered private application served through Worker Assets. SSR is optional for public authentication routes or pages that materially benefit from it; general dashboard SEO is not a requirement.

Authenticated routes use `/o/:organizationSlug/...`. The slug is navigation context only; the API resolves it to an organization ID and verifies membership on every request.

Nuxt’s router remains the application router. TanStack Router is not introduced.

### 20.2 API

`apps/api`:

- Hono Worker;
- Access middleware;
- Effect runtime bridge;
- OpenAPI endpoint;
- API routes;
- service bindings;
- Durable Object class exports when deployment topology permits.

The API Worker must not perform long provider polling loops.

### 20.3 Workflows

Initial Workflow definitions:

```text
DeleteOrganizationWorkflow
ProvisionNodeWorkflow
RebuildNodeWorkflow
RetireNodeWorkflow
DeployGameServerWorkflow
UpdateGameServerWorkflow
ApplyGameConfigWorkflow
SyncModsWorkflow
BackupGameServerWorkflow
RestoreGameServerWorkflow
MoveGameServerWorkflow
DeleteGameServerWorkflow
RegisterProviderImageWorkflow
ReconcileOrphanWorkflow
```

Each external call is an individually named step with typed retry classification.

### 20.4 Queues

Initial queues:

```text
agent-events
telemetry
audit-export
reconciliation
notifications
```

Consumers must be idempotent because delivery is at least once.

### 20.5 Durable Objects

#### `NodeCoordinatorDO`

One instance per node:

- command sequencing;
- active agent WebSocket/session;
- port lease serialization;
- short-lived capacity reservation;
- node event stream;
- command acknowledgements.

#### `ResourceOperationDO`

One instance per mutable resource:

- exclusive mutation lock;
- current operation reference;
- cancellation signal;
- revision checks.

#### `OrganizationEventsDO`

One instance per organization:

- dashboard event fan-out;
- operation progress;
- live status changes;
- WebSocket hibernation.

Durable Object storage holds only coordination data needed after hibernation. Canonical resource records remain in D1.

### 20.6 Service bindings

Where practical:

- web gateway calls API through a Service Binding;
- API calls Workflow and Durable Object bindings directly;
- internal Workers avoid public HTTP round trips.

### 20.7 Scheduled reconciliation

Cron-triggered reconciliation:

- compares D1 nodes with provider inventories;
- compares desired deployments with agent Docker inventory;
- finds expired port reservations;
- finds stale DNS;
- verifies Tunnel and credential state;
- checks expired temporary nodes;
- expires stale organization invitations;
- checks organization deletion and suspension cleanup;
- enforces backup retention;
- exports audit records;
- surfaces unresolved drift rather than silently deleting paid resources.

---

## 21. Data architecture and repository pattern

### 21.1 Database rules

1. Every organization-scoped table has a non-null `organization_id`; uniqueness and foreign-key relationships include the organization boundary where applicable.
2. Repository methods for organization-owned data require an `OrganizationId` or authorized `OrganizationContext`; there is no unscoped list method in ordinary application services.
3. The Worker receives D1 as a native `D1Database` binding.
4. `@gridora/db-d1` builds the Effect SQL Layer from that binding.
5. Domain services depend only on repository interfaces.
6. SQL statements live only in D1 repository implementations and migrations.
7. Database rows are decoded into domain values.
8. Repository methods return typed domain errors.
9. D1 batching is used for atomic multi-statement changes where supported.
10. Cross-provider side effects are never treated as part of a database transaction.
11. Every mutable aggregate has a revision for optimistic concurrency.
12. Migrations are applied through a controlled CI/CD step.
13. R2 object keys use an `organizations/<organization-id>/...` prefix for tenant-owned artifacts.
14. Durable Object names and Queue event partition keys include the organization ID for tenant-owned resources.

### 21.2 Packages

```text
@gridora/db-contracts
@gridora/db-d1
@gridora/repositories
@gridora/migrations
```

### 21.3 Repository interfaces

Initial repositories:

```text
OrganizationRepository
OrganizationMembershipRepository
OrganizationInvitationRepository
OrganizationOnboardingRepository
IdentityRepository
ProviderAccountRepository
ProviderAllocationRepository
ProviderCatalogRepository
NodeImageRepository
NodeRepository
NodeCapacityRepository
TunnelRepository
GamePluginRepository
GameServerRepository
DeploymentRepository
PortLeaseRepository
DnsRecordRepository
ModSetRepository
OperationRepository
BackupRepository
AgentSessionRepository
HealthSnapshotRepository
AuditRepository
SecretEnvelopeRepository
OutboxRepository
```

### 21.4 Core entities

| Entity | Important fields |
|---|---|
| `organizations` | ID, name, unique slug, status, timezone, default region, onboarding state, policy revision, created time |
| `identities` | Access subject, email, display name, status, sign-up time, last login |
| `organization_memberships` | organization, identity, role, status, joined time, invited by |
| `organization_invitations` | organization, email, role, hashed token, expiry, inviter, status |
| `organization_onboarding` | organization, current step, completed steps, completion time |
| `provider_accounts` | scope, organization when scoped, provider type, encrypted credential reference, status |
| `provider_allocations` | organization, platform provider account, allowed regions/plans, quotas, status |
| `provider_catalog` | provider, region, plan, price estimate, refreshed time |
| `node_images` | version, checksum, signature, provider image mappings, status |
| `nodes` | organization, provider instance, region, plan, image, desired/observed state, revision |
| `node_capacity` | CPU, RAM, disk, reservations, observed use |
| `tunnels` | node, Tunnel ID, hostname, state, credential reference |
| `game_plugins` | ID, version, API version, status, capability manifest |
| `game_servers` | organization, plugin, desired state, placement policy, domain |
| `deployments` | organization, server, node, revision, installed build, observed state |
| `port_leases` | organization, node, protocol, public/container ports, owner, state |
| `dns_records` | organization, record ID, hostname, target, proxy mode, owner |
| `mod_sets` | server, schema version, desired/resolved revisions |
| `operations` | organization, type, resource, actor, status, progress, idempotency key |
| `backups` | organization, server, R2 key, checksum, encryption version, metadata |
| `agent_sessions` | node, version, last seen, session state |
| `health_snapshots` | resource, status, summary, sampled time |
| `audit_events` | actor, action, target, result, before/after summary |
| `secret_envelopes` | encrypted payload, key version, scope |
| `outbox` | event type, payload, publish state, retry count |

### 21.5 Secret storage

Per-record secrets are encrypted using envelope encryption:

- root/master key stored as a Worker secret;
- data encryption key per secret or secret group;
- ciphertext and key version stored in D1;
- plaintext exists only in memory for the shortest required operation;
- secret values are redacted from Effect errors, logs, traces, audit diffs, and API responses.

### 21.6 Outbox

A D1 outbox prevents state changes from depending on an unreliable immediate queue publish.

Flow:

1. transaction writes domain change and outbox event;
2. publisher sends the event to a Queue;
3. publisher marks the event delivered;
4. reconciliation retries undelivered events;
5. consumers deduplicate by event ID.

---

## 22. State machines

### 22.1 Identity and organization onboarding state

```text
Access authenticated
  → local_identity_missing
  → sign_up_required | invitation_available

sign_up_required
  → identity_created
  → organization_setup_required
  → organization_creating
  → active

invitation_available
  → invitation_accepting
  → membership_active
  → active

active
  → suspended | organization_switch
```

Organization setup is complete only after the organization row and initial Owner membership are committed atomically. Optional infrastructure and team steps may remain incomplete without weakening the tenant boundary.

### 22.2 Node state

```text
requested
  → provisioning
  → booting
  → registering
  → ready
  → degraded
  → ready

ready/degraded
  → draining
  → drained
  → retiring
  → deleting | cancel_scheduled
  → deleted | contract_ended

any non-terminal state
  → failed
```

`cancel_scheduled` is important for providers where API cancellation is not immediate deletion.

### 22.3 Game server state

```text
draft
  → planning
  → scheduled
  → installing
  → configuring
  → starting
  → running

running
  → stopping
  → stopped
  → starting

running/stopped
  → updating
  → configuring
  → starting | stopped

running/stopped
  → backing_up
  → previous_state

stopped
  → restoring
  → validating
  → stopped | starting

any active state
  → failed
  → repairing
  → prior desired state

stopped/failed
  → deleting
  → deleted
```

### 22.4 Operation state

```text
requested
  → queued
  → running
  → waiting_external
  → running
  → succeeded

running/waiting_external
  → cancelling
  → cancelled

any non-terminal state
  → failed
  → retrying
  → running | failed_terminal
```

### 22.5 Desired versus observed state

Examples:

```text
desired: running
observed: stopped
action: start or surface a blocked reason

desired: deleted
observed: provider instance still exists
action: resume retirement workflow or flag billing risk

desired deployment revision: 12
observed revision: 11
action: apply revision 12
```

No UI action should directly mutate observed state without first recording desired state and an operation.

---

## 23. API design

### 23.1 Style

- versioned REST under `/v1`;
- public identity bootstrap endpoints under `/v1/auth`;
- organization-owned resources nested under `/v1/organizations/:organizationIdOrSlug`;
- no organization-scoped resource endpoint that relies only on a mutable server-side “current organization”;
- JSON;
- Effect Schema validation;
- OpenAPI generation;
- generated TypeScript client;
- `application/problem+json`-style errors;
- idempotency header for mutations;
- cursor pagination;
- ETag/revision for contested updates;
- WebSocket for live events and logs;
- request and correlation IDs.

### 23.2 Representative endpoints

```text
GET    /v1/auth/bootstrap
POST   /v1/auth/sign-up/complete
GET    /v1/me
GET    /v1/me/organizations

POST   /v1/organizations
GET    /v1/organizations/:organization
GET    /v1/organizations/:organization/members
PATCH  /v1/organizations/:organization/members/:identity
DELETE /v1/organizations/:organization/members/:identity
GET    /v1/organizations/:organization/invitations
POST   /v1/organizations/:organization/invitations
DELETE /v1/organizations/:organization/invitations/:invitation
POST   /v1/invitations/:token/actions/accept
POST   /v1/organizations/:organization/actions/leave
POST   /v1/organizations/:organization/actions/transfer-ownership
DELETE /v1/organizations/:organization

GET    /v1/plugins
GET    /v1/plugins/:id

GET    /v1/organizations/:organization/provider-allocations
GET    /v1/organizations/:organization/provider-accounts
POST   /v1/organizations/:organization/provider-accounts
POST   /v1/organizations/:organization/provider-accounts/:id/test
POST   /v1/organizations/:organization/provider-accounts/:id/refresh

GET    /v1/organizations/:organization/nodes
POST   /v1/organizations/:organization/nodes
GET    /v1/organizations/:organization/nodes/:id
POST   /v1/organizations/:organization/nodes/:id/actions/drain
POST   /v1/organizations/:organization/nodes/:id/actions/reboot
DELETE /v1/organizations/:organization/nodes/:id

GET    /v1/organizations/:organization/game-servers
POST   /v1/organizations/:organization/game-servers/plan
POST   /v1/organizations/:organization/game-servers
GET    /v1/organizations/:organization/game-servers/:id
PATCH  /v1/organizations/:organization/game-servers/:id
POST   /v1/organizations/:organization/game-servers/:id/actions/start
POST   /v1/organizations/:organization/game-servers/:id/actions/stop
POST   /v1/organizations/:organization/game-servers/:id/actions/update
POST   /v1/organizations/:organization/game-servers/:id/actions/move
DELETE /v1/organizations/:organization/game-servers/:id

GET    /v1/organizations/:organization/game-servers/:id/mods
POST   /v1/organizations/:organization/game-servers/:id/mods/plan
PUT    /v1/organizations/:organization/game-servers/:id/mods
GET    /v1/organizations/:organization/game-servers/:id/logs
GET    /v1/organizations/:organization/game-servers/:id/logs/stream

GET    /v1/organizations/:organization/backups
POST   /v1/organizations/:organization/game-servers/:id/backups
POST   /v1/organizations/:organization/backups/:id/actions/restore

GET    /v1/organizations/:organization/operations
GET    /v1/organizations/:organization/operations/:id
POST   /v1/organizations/:organization/operations/:id/actions/cancel
GET    /v1/organizations/:organization/events
GET    /v1/organizations/:organization/audit-events
```

### 23.3 Mutation response

```json
{
  "operationId": "op_...",
  "resourceId": "srv_...",
  "status": "queued",
  "links": {
    "operation": "/v1/organizations/night-watch/operations/op_..."
  }
}
```

### 23.4 Error envelope

```json
{
  "type": "https://errors.gridora.example/port-conflict",
  "title": "Port allocation conflict",
  "status": 409,
  "code": "PORT_CONFLICT",
  "detail": "UDP port 2001 is already leased on node node_123.",
  "requestId": "req_...",
  "operationId": "op_...",
  "retryable": false,
  "fields": []
}
```

### 23.5 Idempotency

Mutating requests accept:

```text
Idempotency-Key: <opaque client-generated key>
```

The uniqueness scope is:

```text
organization + actor/client + route/action + key
```

A duplicate request returns the original operation unless the payload hash differs, in which case it returns a conflict.

---

## 24. Authentication and organization onboarding design

### 24.1 Public sign-in and sign-up pages

Gridora provides two public routes:

```text
https://app.gridora.example/sign-in
https://app.gridora.example/sign-up
```

The pages are native Gridora/Nuxt UI pages and must include product branding, legal links, loading/error states, and a clear distinction between returning-user sign-in and new-account sign-up. They do not collect or store passwords.

Both pages initiate Cloudflare Access authentication by redirecting to a protected completion route. The redirect carries a short-lived, signed intent indicating `sign-in`, `sign-up`, or `accept-invitation` and a validated return target.

### 24.2 Access session and local identity bootstrap

- Cloudflare Access protects `console.gridora.example` and `api.gridora.example`.
- Prefer one multi-domain Access application when both domains share policy.
- Access policy may allow any user authenticated by an approved identity provider; Gridora membership and role checks remain the application authorization boundary.
- The API validates `Cf-Access-Jwt-Assertion` and derives a stable external identity key from validated claims.
- Access proves identity; Gridora owns account status, organization membership, authorization, and onboarding state.
- A local identity is upserted only through an allowed sign-up, invitation, or existing-account sign-in path.
- `/v1/auth/bootstrap` returns identity status, pending invitations, memberships, last-used organization, and required next route.

Bootstrap routing:

```text
no local identity + sign-in intent
  → /sign-up?reason=account-not-found

no local identity + sign-up intent
  → create identity
  → pending invitation or /setup/organization

identity + pending required invitation
  → /invitations/<token>

identity + no memberships
  → /setup/organization

identity + one membership
  → /o/<slug>/overview

identity + multiple memberships
  → last active organization or organization chooser
```

### 24.3 First organization setup

The required first setup route is:

```text
https://console.gridora.example/setup/organization
```

It is shown to authenticated users with no active membership and contains one primary form with:

- organization display name;
- globally unique slug with live validation;
- timezone;
- default deployment region preference;
- required legal/acceptable-use acceptance;
- optional initial team invitations;
- optional budget warning threshold.

Submission performs one idempotent transaction that creates the organization, creates the user’s Owner membership, records terms acceptance, initializes default policy, and marks the mandatory onboarding step complete. Failure leaves neither an ownerless organization nor a membership without an organization.

After creation, the user enters `/o/<slug>/overview`. A non-blocking setup checklist may then guide provider allocation, domain settings, team invitations, and the first game-server deployment.

### 24.4 Memberships and invitations

- Invitations are scoped to one organization and one proposed role.
- Invitation acceptance requires the authenticated Access email to match the invitation email unless an Owner explicitly reissues it.
- Existing Gridora users can accept an invitation and add another membership without creating another identity.
- New users entering through an invitation complete sign-up and accept the invitation before being asked to create an organization.
- Owners and Administrators can revoke pending invitations and manage roles, but only Owners can transfer ownership or delete the organization.
- Last-Owner protection is enforced transactionally.
- Removing a membership immediately invalidates organization authorization, active organization WebSockets, and organization-scoped automation credentials owned by that membership where applicable.

### 24.5 Organization switching

The web organization switcher lists active memberships and navigates to `/o/<slug>`. The last-used organization is a preference only and never substitutes for authorization.

The API constructs an `OrganizationContext` containing:

- organization ID and slug;
- identity ID;
- membership ID and role;
- organization status and policy revision;
- request and correlation IDs.

Every organization-owned application service requires this context.

### 24.6 CLI

`gridora auth login`:

1. discovers the Access-protected resource metadata;
2. dynamically registers the public client when required;
3. starts Authorization Code with PKCE;
4. opens the browser;
5. listens on a loopback callback;
6. exchanges the code for access and refresh tokens;
7. stores tokens in the OS keychain;
8. calls `/v1/auth/bootstrap`;
9. prompts for an organization when several memberships exist;
10. stores the selected organization as the profile default;
11. prints the active identity and organization.

The CLI must handle:

- token refresh;
- token revocation;
- multiple profiles;
- multiple organization memberships;
- `gridora organizations switch`;
- `--organization` overrides;
- non-default API origins;
- logout;
- expired dynamic registration;
- browser-open failure.

Managed OAuth is treated as a replaceable auth adapter because it may evolve while in beta.

### 24.7 Node machine authentication

Node bootstrap uses a short-lived one-time token bound to the expected organization, node ID, provider instance ID, and operation ID.

After registration:

- the node has a unique machine credential scoped to one organization and node;
- agent-to-control requests are authenticated;
- control-to-node requests pass Cloudflare Access Service Auth and a signed command;
- credentials are individually revocable;
- rotation can occur without rebuilding the node;
- a retired node’s credentials and Tunnel are revoked.

### 24.8 CI automation

CI uses a dedicated organization automation identity or Access service token with narrowly scoped application authorization. It does not reuse a user’s CLI refresh token. Platform release automation uses a separate platform identity.

---

## 25. Web dashboard UX

### 25.1 Public authentication pages

#### Sign in

The sign-in page is optimized for returning users and includes:

- “Sign in to Gridora” heading;
- Cloudflare Access continuation action;
- invitation-aware return handling;
- link to sign up;
- account-not-found guidance;
- authentication and denied-access error states.

#### Sign up

The sign-up page is optimized for new users and includes:

- “Create your Gridora account” heading;
- concise explanation that authentication is handled by the configured identity provider;
- Cloudflare Access continuation action;
- link to sign in;
- terms and privacy links;
- open, invitation-only, or disabled sign-up state;
- duplicate-account and invitation guidance.

### 25.2 First organization setup page

`/setup/organization` is a focused, responsive page shown before the main dashboard when the user has no active organization membership.

Required fields:

```text
Organization name
Organization slug
Timezone
Default deployment region
Terms acceptance
```

Optional fields:

```text
Initial member invitations
Budget warning threshold
```

The page must:

- validate slug availability without reserving it indefinitely;
- clearly state that the user becomes the Owner;
- prevent duplicate submission;
- recover safely after refresh;
- show actionable field and server errors;
- redirect to the new organization overview after success.

### 25.3 Organization application shell

The authenticated shell includes:

- organization switcher;
- current organization name and status;
- user menu;
- global operation indicator;
- role-aware navigation;
- organization-scoped search;
- setup checklist until optional onboarding tasks are complete.

The organization switcher supports:

- searching memberships;
- switching without signing out;
- creating another organization when allowed;
- opening organization settings;
- indicating suspended or inaccessible organizations without exposing their resources.

### 25.4 Navigation

```text
Overview
Game Servers
Nodes
Operations
Plugins
Backups
Providers
Node Images
Members
Invitations
Audit
Organization Settings
```

Navigation items are hidden or disabled according to organization role and platform capability, but API authorization remains authoritative.

### 25.5 Overview

Shows:

- running, stopped, degraded, and failed game servers;
- ready and degraded nodes;
- current operations;
- aggregate reserved capacity;
- provider distribution;
- organization budget status;
- stale backups;
- pending cancellations;
- pending member invitations;
- optional setup checklist;
- orphan/drift warnings.

### 25.6 Members and invitations

The organization administration area provides:

- member list with role and join source;
- invite form;
- pending, accepted, expired, and revoked invitations;
- role changes;
- member removal;
- ownership transfer;
- clear last-Owner protection;
- audit links for each change.

### 25.7 Server details

Tabs:

```text
Overview
Configuration
Mods
Players/Status
Logs
Console
Backups
Networking
Operations
Audit
```

Plugin UI contributions may add tabs under a namespaced route.

### 25.8 Node details

Shows:

- organization ownership;
- provider facts;
- plan and estimated cost;
- contract/cancellation state;
- public/private addresses;
- image and agent versions;
- Tunnel state;
- CPU/RAM/disk;
- deployments;
- port leases;
- firewall state;
- operation history;
- drain action;
- rebuild/retire actions.

### 25.9 Operation UX

Operations are never represented as a blocking spinner alone.

The UI shows:

- current step;
- completed steps;
- retry count;
- waiting reason;
- provider request ID;
- elapsed time;
- logs;
- cancellation availability;
- recovery action;
- final resource link.

### 25.10 Destructive confirmation

Deleting or retiring requires:

- the organization and resource name;
- provider billing consequence;
- backup status;
- affected domains and deployments;
- typed confirmation for high-impact actions;
- explicit force flag when bypassing policy.

Organization deletion additionally requires:

- Owner role;
- no unresolved ownership transfer;
- an inventory of all paid resources and retained backups;
- a typed organization slug;
- a durable cleanup operation rather than immediate row deletion.

---

## 26. Monitoring and observability

### 26.1 Metrics

Agent samples:

- host CPU;
- load;
- memory;
- disk;
- disk inode use;
- network;
- Docker health;
- per-container CPU/memory/network;
- restart count;
- game-specific metrics.

Current status is kept in the node coordinator and periodically persisted. Lower-frequency historical aggregates are retained in D1 for the MVP. Raw or larger metric artifacts may move to a dedicated analytics store later.

### 26.2 Logs

Sources:

- agent;
- cloudflared;
- Traefik;
- Docker events;
- game stdout/stderr;
- install/update jobs;
- plugin health/query;
- provider workflow logs.

Logs include:

- timestamp;
- organization;
- node;
- server;
- operation;
- component;
- level;
- message;
- structured plugin fields.

### 26.3 Tracing

Effect spans include:

- request ID;
- operation ID;
- workflow ID;
- provider request ID;
- node ID;
- server ID;
- plugin ID/version.

Secrets and high-cardinality player identifiers must be redacted.

### 26.4 Alerts

Initial in-product alerts:

- node offline;
- Tunnel offline;
- disk low;
- game unhealthy;
- crash loop;
- backup stale;
- update failed;
- provider cancellation pending;
- provider orphan;
- agent/image unsupported;
- budget threshold reached.

External notifications are a later pluggable capability.

---

## 27. Reliability and reconciliation

### 27.1 Idempotent external actions

Every provider or node action carries an operation ID.

On uncertain failure:

1. do not immediately repeat create;
2. query provider or node inventory by metadata/operation ID;
3. adopt an existing matching resource;
4. retry only if no matching resource exists;
5. surface ambiguity if identity cannot be proven.

### 27.2 Compensation

Workflows define compensating steps, for example:

```text
reserve capacity
  → reserve ports
  → install
  → configure
  → start
```

If installation fails:

- stop/remove partial container;
- release staged data according to plugin policy;
- release ports;
- release capacity;
- retain diagnostic logs;
- mark operation failed.

A compensation must never delete a resource it did not create or positively identify.

### 27.3 Orphan detection

The reconciler identifies:

- provider instances tagged as managed but absent from D1;
- D1 nodes absent from provider inventory;
- Docker deployments absent from D1;
- D1 deployments absent from Docker;
- duplicate port leases;
- stale DNS;
- stale Tunnel records;
- expired temporary nodes;
- completed Contabo contract dates;
- R2 backups without metadata and vice versa.

Unknown paid instances are never auto-deleted by default. They are quarantined and require policy or owner action.

### 27.4 Degraded mode

If Cloudflare control services are temporarily unavailable:

- running game containers continue;
- agent keeps local desired state;
- agent does not execute expired commands;
- local restart policy remains active;
- logs are buffered within limits;
- the node reconnects and reconciles later.

---

## 28. Security requirements

### 28.1 Network security

- no public agent port;
- no public Docker socket;
- no public Traefik dashboard;
- SSH disabled publicly by default;
- default-deny host firewall;
- only leased game ports opened;
- management through Tunnel and Access;
- raw game DNS records remain DNS-only;
- optional provider firewall mirrors host rules.

### 28.2 Application security

- Access JWT validation at the API;
- explicit organization context and membership authorization in Effect services;
- organization-scoped repository contracts and identifiers;
- protection against cross-organization IDOR, WebSocket subscription, cache-key, R2-key, and operation-ID leakage;
- domain authorization in Effect services;
- CSRF protection for cookie-authenticated mutations;
- request body limits;
- rate limiting;
- idempotency;
- strict schema decoding;
- no arbitrary shell fields;
- path traversal protection;
- SSRF protection for mod/image URLs;
- allowlisted plugin network domains;
- audit of secret and role operations.

### 28.3 Supply chain

- pinned OCI image digests;
- signed first-party images;
- SBOM for node and container images;
- vulnerability scanning;
- dependency lockfile;
- exact versions for pre-stable dependencies;
- protected release workflow;
- provenance for plugin builds;
- rollback to prior image/plugin/agent.

### 28.4 Docker boundary

Only the agent can control Docker.

Game containers:

- cannot mount `/var/run/docker.sock`;
- cannot mount host root;
- cannot add arbitrary devices;
- cannot request privileged mode;
- cannot join the agent network unless required;
- receive only their own volumes and secrets.

### 28.5 Plugin security

- first-party reviewed plugins only;
- generated registry;
- permission manifest;
- no dynamic eval;
- no cross-plugin import;
- signed deployment specs;
- schema validation on both control and agent sides;
- plugin-specific redaction rules;
- plugin testkit security cases.

### 28.6 Secret security

Secrets include:

- provider credentials;
- Cloudflare API credentials;
- Tunnel credentials;
- Access service tokens;
- node machine credentials;
- Steam credentials;
- RCON passwords;
- backup encryption keys.

Requirements:

- encrypted at rest;
- never logged;
- never included in operation diff;
- scoped;
- rotatable;
- revocable;
- not returned after creation;
- transmitted only over authenticated TLS;
- removed from node on retirement.

### 28.7 Abuse and licensing

Before enabling a plugin, maintainers must document:

- dedicated-server distribution method;
- anonymous versus credentialed Steam requirement;
- publisher terms;
- mod source terms;
- redistribution restrictions;
- server listing or token requirements;
- anti-cheat implications.

The product automates legitimate server administration and must not bypass access control or licensing.

---

## 29. Non-functional requirements

### NFR-1 — Portability

Core domain and provider interfaces must not import Cloudflare globals. Cloudflare adapters provide bindings through Layers.

### NFR-2 — Scalability

The architecture must support at least:

- 1,000 managed nodes;
- 10,000 game-server records;
- 10,000 organizations and 100,000 organization memberships;
- 100 concurrent infrastructure operations;
- 1,000 dashboard WebSocket clients across organizations;

without redesigning the domain model. Initial quotas may be lower.

### NFR-3 — Cost efficiency

- dashboard static assets should not invoke SSR unnecessarily;
- Durable Objects hibernate when idle;
- provider polling uses bounded schedules and backoff;
- high-frequency logs do not enter D1;
- queues batch telemetry;
- reconciliation avoids scanning every resource on every request.

### NFR-4 — Accessibility

The dashboard targets WCAG 2.1 AA for keyboard navigation, focus, labels, contrast, and status announcements.

### NFR-5 — Browser and platform support

Web:

- current major Chrome, Firefox, Safari, and Edge.

CLI:

- macOS arm64/x64;
- Linux x64;
- Windows x64 when packaging is ready, even though managed game nodes remain Linux.

### NFR-6 — Upgrade safety

Database, plugin, agent, image, and API versions must have explicit compatibility checks and rollback paths.

### NFR-7 — Observability

Every operation must be traceable from API request to Workflow, provider call, node command, and final audit event.

---

## 30. Technology decisions

### 30.1 Frontend

- Nuxt 4, pinned to the latest approved security patch in the 4.x line;
- public sign-in/sign-up routes and an authenticated organization-scoped dashboard in the same application workspace;
- Nuxt UI 4;
- Tailwind through the Nuxt UI integration;
- TanStack Query for API/cache state;
- TanStack Table for advanced inventory tables;
- Effect Schema-derived client types;
- no TanStack Router;
- no duplicate Nuxt server API implementation.

### 30.2 TypeScript and Effect

- TypeScript 7;
- Effect 4;
- `@effect/sql-d1`;
- `@effect/opentelemetry`;
- Effect testing integration;
- Effect Schema as the canonical contract.

Effect 4 is currently release-candidate software. The repository must:

- pin exact Effect package versions;
- maintain a compatibility test suite;
- prohibit unattended major/pre-release upgrades;
- track stable Effect 4 release;
- perform the stable migration in a dedicated change;
- block a production general-availability tag unless the remaining RC risk is explicitly accepted.

### 30.3 HTTP

- Hono as the Cloudflare HTTP adapter;
- internal `http-hono-effect` bridge;
- Hono’s Cloudflare and Durable Object integration;
- OpenAPI generated from Effect-owned contracts;
- Web Standard `Request`, `Response`, and `WebSocket`.

There is no requirement to adopt Hono RPC as the canonical API contract.

### 30.4 Monorepo tooling

- Vite+;
- Vite;
- Vitest;
- Oxlint;
- Oxfmt;
- Rolldown/tsdown as provided by the approved Vite+ toolchain;
- one root toolchain configuration;
- task graph and cache;
- no ESLint;
- no Prettier.

Vite+ is pre-1.0 beta software. Pin its version and keep CI capable of running the underlying tools directly during an emergency rollback.

### 30.5 Cloudflare

- Workers and Worker Assets;
- Durable Objects;
- Workflows;
- Queues;
- D1;
- R2;
- Access;
- Tunnel;
- DNS;
- Wrangler;
- `@cloudflare/vitest-pool-workers`.

### 30.6 VPS/runtime

- Ubuntu 24.04 LTS;
- Docker Engine and Compose;
- Traefik;
- SteamCMD;
- cloudflared;
- Packer;
- systemd;
- nftables-compatible firewall;
- OCI image signing and SBOM tooling.

### 30.7 Database

- D1 native Worker binding;
- Effect SQL D1 package;
- repository pattern;
- handwritten migrations and SQL;
- no ORM types leaking into domain;
- no requirement for Drizzle, Prisma, or Kysely.

---

## 31. Monorepo layout

```text
.
├── apps/
│   ├── web/                         # Nuxt dashboard
│   ├── api/                         # Hono Worker and API entrypoint
│   ├── cli/                         # gridora
│   └── agent/                       # VPS node agent
│
├── workers/
│   ├── workflows/                   # Cloudflare Workflow definitions
│   ├── queue-consumers/             # telemetry, audit, reconciliation
│   └── realtime/                    # Durable Object implementations
│
├── packages/
│   ├── domain/                      # entities, value objects, policies
│   ├── contracts/                   # Effect Schemas, events, API contracts
│   ├── application/                 # use cases and Effect services
│   ├── identity/                       # local identity and Access mapping
│   ├── organizations/                  # membership, invitations, onboarding
│   ├── http-hono-effect/            # Hono ↔ Effect bridge
│   ├── auth-cloudflare-access/      # JWT/OAuth/service-auth adapters
│   ├── db-contracts/                # repository interfaces
│   ├── db-d1/                       # Effect SQL D1 implementations
│   ├── migrations/
│   ├── provider-sdk/
│   ├── provider-ovh-public-cloud/
│   ├── provider-contabo/
│   ├── cloudflare-control/          # DNS, Tunnel, Access APIs
│   ├── scheduler/
│   ├── orchestration/
│   ├── agent-protocol/
│   ├── docker-runtime/
│   ├── steam-runtime/
│   ├── backup-runtime/
│   ├── observability/
│   ├── generated-client/
│   ├── plugin-sdk/
│   ├── plugin-sdk-control/
│   ├── plugin-sdk-agent/
│   ├── plugin-sdk-ui/
│   └── plugin-testkit/
│
├── plugins/
│   └── games/
│       ├── arma-reforger/
│       └── second-reference-game/
│
├── infra/
│   ├── cloudflare/
│   ├── packer/
│   ├── images/
│   ├── docker/
│   └── scripts/
│
├── tests/
│   ├── e2e/
│   ├── provider-contract/
│   ├── image/
│   ├── security/
│   └── fixtures/
│
├── docs/
│   ├── adr/
│   ├── plugin-authoring/
│   ├── operations/
│   └── threat-model/
│
├── vite.config.ts
├── package.json
├── tsconfig.json
├── wrangler.jsonc
└── PRODUCT.md
```

### 31.1 Dependency direction

```text
domain
  ↑
contracts / application
  ↑
adapters: D1, providers, Hono, Cloudflare, Docker
  ↑
apps and workers
```

Game plugins depend on SDK contracts, not on another plugin or provider package.

Provider packages cannot depend on game plugins.

The web cannot import agent implementations.

The agent cannot import Cloudflare Worker entrypoints.

These boundaries are enforced with package exports, Oxlint rules, and graph tests.

---

## 32. Testing strategy

### 32.1 Unit tests

- domain value objects;
- organization slug, membership, invitation, last-Owner, and onboarding rules;
- scheduling;
- cost policy;
- state machines;
- schema decoding;
- plugin config migrations;
- provider error mapping;
- command idempotency;
- secret redaction.

### 32.2 Repository tests

Run every repository contract against:

- local D1/Workers test environment;
- migration-upgraded schema;
- transaction/batch cases;
- concurrent revision conflicts;
- cross-organization query denial and uniqueness constraints;
- atomic organization plus Owner creation;
- invitation replay and expiry;
- outbox retry.

### 32.3 Provider contract tests

A shared test suite runs against both drivers:

- list regions/plans/images;
- create;
- find by operation metadata;
- start/stop/reboot;
- rebuild where supported;
- snapshot;
- firewall/security group;
- retire;
- ambiguous timeout recovery;
- quota and auth error normalization.

Real-provider tests use tightly restricted accounts, cheapest approved resources, hard TTLs, and cleanup reconciliation.

### 32.4 Plugin conformance tests

Each plugin must pass:

- manifest validation;
- install-plan generation;
- clean install;
- repeated install idempotency;
- update;
- invalid config rejection;
- config render golden test;
- start/stop;
- health success/failure;
- log parser;
- backup;
- restore;
- mod plan;
- duplicate mod handling;
- path traversal attack;
- secret redaction;
- resource/port declaration;
- agent/control version compatibility.

### 32.5 Node-image tests

- boots on OVHcloud;
- boots on Contabo;
- cloud-init registration;
- Docker healthy;
- agent healthy;
- Tunnel healthy;
- firewall default deny;
- no public management port;
- reboot persistence;
- disk layout;
- image signature/version report.

### 32.6 Cloudflare integration tests

- Access JWT validation;
- Managed OAuth adapter;
- Hono–Effect bridge;
- D1 binding;
- Durable Object hibernation/recovery;
- Workflow retry and resume;
- Queue duplicate delivery;
- Service Bindings;
- WebSocket event fan-out.

### 32.7 End-to-end scenarios

1. Public sign-up, first organization setup, and Owner dashboard entry.
2. Invitation acceptance by a new user and an existing user.
3. One identity switching between two organizations without data leakage.
4. Cross-organization resource-ID and WebSocket access denial.
5. OVH dedicated Arma server from web.
6. OVH shared node with two servers and non-conflicting UDP ports.
7. Contabo persistent node with cancellation warning.
8. CLI OAuth login and declarative apply.
9. Failed provider response after instance creation.
10. Agent disconnect during deployment.
11. Game crash loop.
12. Mod update with rollback.
13. Backup and restore to another node.
14. Node drain and move.
15. Orphan provider instance detection.
16. Delete with required backup.
17. Role authorization denial.
18. Expired bootstrap token.
19. Revoked node credential.

### 32.8 Security tests

- SSRF;
- path traversal;
- command injection;
- malicious config;
- forged Access JWT;
- unauthorized sign-up completion and forged auth intent;
- cross-organization IDOR and stream subscription;
- invitation token replay, expiry, and email mismatch;
- last-Owner removal race;
- wrong audience;
- replayed node command;
- stolen/expired bootstrap token;
- Docker socket exposure;
- plugin capability escalation;
- secret leakage;
- cross-organization access;
- forced deletion audit;
- dependency and image scanning.

---

## 33. Delivery phases

### Phase 0 — Foundations

Deliver:

- Vite+ monorepo;
- TypeScript 7;
- pinned Effect 4;
- Hono–Effect bridge;
- multi-organization domain model and tenant-scoped repository contracts;
- D1 repositories and migrations;
- public sign-in and sign-up pages;
- Access web authentication and local identity bootstrap;
- first organization setup page;
- membership, invitation, organization switching, and last-Owner rules;
- CLI Managed OAuth and organization selection proof;
- operation model;
- basic Durable Object and Workflow test harness.

Exit criteria:

- a new user can sign up, create an organization, and enter its dashboard;
- one user can switch between two organizations while cross-organization tests remain denied;
- web and CLI call the same authenticated API with explicit organization context;
- an idempotent sample Workflow survives a forced retry;
- repository and Access tests pass in the Worker test environment.

### Phase 1 — Node provisioning

Deliver:

- Packer image;
- node agent;
- Cloudflare Tunnel automation;
- OVHcloud driver;
- Contabo driver;
- node inventory;
- node lifecycle;
- provider policies;
- reconciliation;
- node dashboard and CLI.

Exit criteria:

- both providers can create a ready node;
- no public management port;
- uncertain create timeout does not duplicate a node;
- Contabo cancellation is represented accurately.

### Phase 2 — Generic game runtime

Deliver:

- Steam installer/runtime model;
- Docker orchestration;
- port allocator;
- Traefik integration;
- DNS;
- scheduler;
- shared and dedicated placement;
- logs and base monitoring;
- server lifecycle API/CLI/UI.

Exit criteria:

- a generic test plugin runs two isolated servers on one node;
- dedicated mode provisions and tears down its own OVH node;
- port conflict tests pass.

### Phase 3 — Arma Reforger plugin

Deliver:

- installation;
- configuration;
- lifecycle;
- health/query;
- logs;
- backups;
- mods;
- Workbench/Workshop import UI;
- plugin-specific diagnostics.

Exit criteria:

- end-to-end deployment on both providers;
- mod-set plan/apply/rollback;
- backup/restore to another compatible node;
- no Arma code in core packages.

### Phase 4 — Plugin proof and hardening

Deliver:

- second Linux-native Steam game plugin;
- plugin authoring documentation;
- plugin testkit;
- image/agent upgrade;
- audit export;
- security review;
- operational runbooks;
- cost controls;
- failure-injection tests.

Exit criteria:

- second plugin requires no core domain/provider edits;
- all production acceptance criteria pass;
- remaining pre-release dependency risks are explicitly accepted or removed.

---

## 34. MVP scope

The MVP includes:

- first-class support for multiple organizations;
- public sign-in and sign-up pages backed by Cloudflare Access identity;
- first-organization setup page;
- users with memberships in several organizations;
- organization creation and switching;
- member invitations, acceptance, revocation, role management, removal, and last-Owner protection;
- organization-scoped URLs, API routes, repositories, events, R2 keys, node credentials, policies, quotas, and audit;
- platform-owned OVHcloud and Contabo accounts allocated to organizations by policy;
- one Cloudflare account and zone;
- Linux amd64 nodes assigned to one organization each;
- promoted Ubuntu node image;
- web dashboard;
- CLI with organization selection and switching;
- OVH and Contabo node lifecycle;
- shared and dedicated placement within one organization;
- Steam anonymous installation;
- Arma Reforger plugin;
- one second minimal reference plugin;
- configuration;
- manual updates;
- mod management for Arma;
- status, logs, and basic historical health;
- manual and scheduled backups;
- DNS;
- Access authentication;
- Tunnel management;
- audit;
- organization spending and node-count guardrails.

Customer subscription billing, provider-cost resale, and cross-organization node sharing remain outside the MVP.

---

## 35. Acceptance criteria

### AC-1 — OVH provisioning

Given valid OVHcloud credentials and an allowed plan, when an administrator creates a node, then:

- exactly one instance exists;
- it uses the promoted image;
- the agent registers;
- Tunnel is healthy;
- no management port is public;
- the node becomes ready;
- the operation and audit records are complete.

### AC-2 — Contabo provisioning

Given valid Contabo credentials, when an administrator creates a node, then:

- the requested product, region, image, and contract period are recorded;
- cloud-init registers the node;
- cancellation semantics are shown;
- retirement does not falsely claim immediate billing termination.

### AC-3 — Shared placement

Given a ready node with capacity, when two compatible game servers are deployed, then:

- both run in isolated containers;
- resources are reserved;
- ports do not conflict;
- both domains resolve to the node;
- the UI displays distinct connection ports;
- deleting one does not interrupt the other.

### AC-4 — Dedicated placement

Given `placement.mode=dedicated`, when a server is created, then:

- a new eligible node is provisioned;
- only that server is placed there;
- deletion follows backup and provider retirement policy.

### AC-5 — Idempotent retry

Given a provider create request succeeds but the response is lost, when the Workflow retries, then it adopts the existing tagged instance instead of creating another.

### AC-6 — Authentication and sign-up

Given a user without a valid Access session, authenticated web/API access is denied.

Given a new user on `/sign-up`, after successful Access authentication the local identity is created exactly once and the user is routed to first organization setup.

Given an unknown user on `/sign-in`, Gridora does not silently create an account and instead offers sign-up completion.

Given `gridora auth login`, the user completes PKCE login and the CLI can call `/v1/auth/bootstrap` without a copied static API key.

### AC-7 — Plugin isolation

Given a new game plugin, implementation requires only SDK packages, its own workspace, generated registry output, and migrations. No core provider, scheduler, auth, or repository interface is modified solely for that game.

### AC-8 — Arma mods

Given a valid supported Arma mod reference, the Arma plugin produces a preview, resolves available metadata/dependencies, stages installation, applies configuration, restarts when required, verifies health, and rolls back on activation failure.

### AC-9 — Backup/restore

Given a healthy backup, restore to another compatible node recreates configuration, data, and mod state, passes plugin validation, and updates endpoint state without losing the original until cutover succeeds.

### AC-10 — Offline control plane

Given the control plane is temporarily unreachable, running game servers continue. When connectivity returns, the agent reconnects and observed state is reconciled.

### AC-11 — Security

Automated tests confirm that game containers cannot access the Docker socket, provider credentials, another server’s volumes, or unleased host ports.

### AC-12 — Orphan detection

Given a managed provider instance absent from D1, reconciliation creates a high-severity orphan finding and does not silently delete it.

### AC-13 — Organization onboarding

Given an authenticated user with no memberships, submitting the first organization setup page creates exactly one organization and one Owner membership atomically, then redirects to the organization overview.

Given a refresh or duplicate submission, no duplicate organization or membership is created.

### AC-14 — Multiple organizations and isolation

Given one user with memberships in two organizations, the user can switch between them and each URL, API response, event stream, CLI command, and audit view reflects the selected organization.

Given a valid resource ID from another organization, the user receives a non-disclosing authorization or not-found response and no data, logs, status, timing detail, or mutation crosses the tenant boundary.

### AC-15 — Invitations and ownership safety

Given a valid invitation, a new or existing user can accept it once and receives the intended organization role.

An expired, revoked, replayed, or email-mismatched invitation is rejected. The final Owner cannot leave, be removed, or be demoted until ownership is transferred or another Owner exists.

---

## 36. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Effect 4 is still RC | Pin exact versions, compatibility suite, stable-release gate |
| Vite+ is pre-1.0 beta | Pin version, preserve direct underlying commands, isolate config |
| Cloudflare Managed OAuth is beta | Adapter boundary, token-flow tests, fallback operational procedure |
| Broad Access authentication is mistaken for tenant authorization | Access proves identity only; Gridora verifies organization membership and role on every request |
| Cross-organization data leakage | Explicit tenant context, scoped repositories/keys, same-organization node invariant, and adversarial isolation tests |
| Open sign-up abuse | Rate limits, verified Access identities, configurable sign-up mode, audit, suspension, and abuse controls |
| Contabo cancellation is not elastic deletion | Explicit capability and state model; UI warning; no hourly assumptions |
| UDP cannot be routed by hostname like HTTP | Unique port leases; display `host:port`; optional SRV/Spectrum |
| Steam credentials and Guard are complex | Anonymous-first MVP; credentialed mode feature-gated |
| Game binaries may not be redistributable | SteamCMD install on node; no central binary redistribution |
| Workshop/Workbench interfaces may change | Keep integration inside plugin; contract tests and feature flags |
| Docker socket compromise has host impact | Hardened agent, no game access, signed commands/specs, restricted operations |
| Shared nodes create noisy-neighbor risk | reservations/limits, headroom, dedicated mode, health alerts |
| Provider API timeout creates ambiguity | operation metadata, discovery before retry, reconciliation |
| Plugin UI cannot be loaded as arbitrary remote code | build-time first-party registry; future sandboxed model |
| D1 is unsuitable for unbounded logs/metrics | R2 archives, bounded aggregates, retention |
| Custom images differ by provider/region | registration matrix, smoke tests, stock-image fallback |
| Mod content may carry security or licensing risk | source allowlists, checksums, provenance, plugin policy |
| Public game ports remain attackable | provider DDoS options, firewall, rate controls where protocol permits, optional Spectrum |

---

## 37. Open product questions

These do not block initial architecture; defaults are stated.

1. **Identity providers:** begin with the approved Cloudflare Access providers configured by the operator; keep provider presentation dynamic rather than hard-coded in Gridora.
2. **Provider ownership:** default to platform-owned provider accounts; bring-your-own-provider credentials may be added behind an organization feature flag.
3. **Domain ownership:** default to one operator-managed Cloudflare zone with organization slugs in generated hostnames.
4. **Container registry:** default to a private OCI registry such as GHCR; keep registry configuration replaceable.
5. **Second reference game:** select one Linux-native anonymous-SteamCMD server with simple mod-free deployment to validate isolation.
6. **Steam credentialed mode:** remain disabled until a secure operational flow is approved.
7. **Spectrum:** remain optional and outside MVP.
8. **Historical metrics store:** begin with bounded D1 aggregates and R2 logs; revisit when usage justifies a dedicated analytics service.
9. **Third-party plugins:** postpone until signed/sandboxed execution is designed.
10. **Public customer billing:** postpone until infrastructure operations and provider reconciliation are proven.

---

## 38. Definition of done

The product reaches first production release only when:

- the architecture and threat model are reviewed;
- both provider drivers pass shared contract tests;
- promoted node images boot and register on both providers;
- public sign-in and sign-up pages use Cloudflare Access for identity without storing passwords;
- first organization setup creates an organization and Owner atomically;
- users can belong to and switch among multiple organizations;
- invitations, membership roles, ownership transfer, and last-Owner protection are complete;
- organization isolation is enforced and proven through adversarial tests;
- web and CLI use Cloudflare Access with explicit organization context;
- all mutations are operations with idempotency;
- Workflows own long-running actions;
- D1 access goes through Effect repositories;
- no management port is publicly required;
- shared and dedicated placements pass end-to-end tests;
- Arma Reforger and a second reference plugin pass conformance;
- Arma-specific mod code is isolated;
- backups restore successfully across nodes;
- provider, node, Docker, and game health are independently visible;
- audit and spending controls are active;
- orphan reconciliation is active;
- secrets are encrypted and redacted;
- dependency, image, and plugin security scans pass;
- rollback procedures exist for control plane, agent, node image, and plugin;
- Effect 4, Vite+, and Managed OAuth maturity risks are either resolved or explicitly accepted for the release.

---

## Appendix A — Core plugin data contracts

```ts
export interface ResourceRequest {
  readonly cpu: number
  readonly memoryMiB: number
  readonly diskGiB: number
}

export interface PortDefinition {
  readonly id: string
  readonly purpose: "player" | "query" | "rcon" | "admin"
  readonly protocol: "tcp" | "udp" | "tcp+udp"
  readonly containerPort: number
  readonly preferredPublicPort?: number
  readonly public: boolean
  readonly proxyMode: "direct" | "traefik" | "tunnel"
}

export interface InstallPlan {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly steps: readonly InstallStep[]
  readonly requiredImages: readonly ImageReference[]
  readonly requiredSecrets: readonly SecretRequirement[]
  readonly estimatedDownloadBytes?: number
}

export interface HealthReport {
  readonly status: "healthy" | "degraded" | "unhealthy" | "unknown"
  readonly process: ComponentHealth
  readonly query?: ComponentHealth
  readonly configuration?: ComponentHealth
  readonly mods?: ComponentHealth
  readonly facts: Readonly<Record<string, unknown>>
  readonly reasons: readonly HealthReason[]
}

export interface DesiredModSet {
  readonly schemaVersion: number
  readonly items: readonly ModReference[]
  readonly loadOrder?: readonly string[]
}

export interface ResolvedModSet {
  readonly sourceRevision: string
  readonly items: readonly ResolvedMod[]
  readonly dependencyGraph: readonly ModDependency[]
  readonly warnings: readonly ModWarning[]
}
```

---

## Appendix B — Generated Docker topology example

This is illustrative. Users do not submit arbitrary Compose directly.

```yaml
services:
  game:
    image: ghcr.io/example/game-runtime@sha256:...
    user: "10001:10001"
    restart: unless-stopped
    stop_grace_period: 60s
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - /var/lib/gridora/servers/srv_123/game:/opt/game:ro
      - /var/lib/gridora/servers/srv_123/config:/opt/config:ro
      - /var/lib/gridora/servers/srv_123/data:/opt/data
      - /var/lib/gridora/servers/srv_123/mods:/opt/mods:ro
    ports:
      - "2001:2001/udp"
    deploy:
      resources:
        limits:
          cpus: "4"
          memory: 8G
    labels:
      gridora.managed: "true"
      gridora.server-id: "srv_123"
      gridora.plugin-id: "arma-reforger"
      gridora.deployment-revision: "12"
```

The actual implementation may use the Docker API rather than invoking Compose, but the generated model must remain inspectable.

---

## Appendix C — Operation workflow example

```text
DeployGameServerWorkflow(op_123)

1. load-and-validate-request
2. acquire-resource-lock
3. resolve-plugin-version
4. calculate-placement
5. reserve-capacity
6. reserve-ports
7. ensure-node-ready
8. create-dns-plan
9. send-install-command
10. wait-for-install-result
11. send-config-command
12. apply-network-and-firewall
13. send-start-command
14. wait-for-game-health
15. apply-dns
16. mark-deployment-running
17. emit-audit-and-events
18. release-resource-lock
```

Compensation runs in reverse for owned resources when safe.

---

## Appendix D — CLI exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | Unclassified failure |
| 2 | Invalid CLI input or manifest |
| 3 | Authentication required or expired |
| 4 | Authorization denied |
| 5 | Resource not found |
| 6 | Conflict or revision mismatch |
| 7 | Policy or budget rejection |
| 8 | Provider failure |
| 9 | Node/agent unavailable |
| 10 | Operation failed |
| 11 | Operation timed out locally but may still be running |
| 12 | Partial success requiring inspection |

---

## Appendix E — Required architecture decision records

Before implementation reaches Phase 2, create ADRs for:

1. Hono–Effect runtime lifecycle on Workers.
2. D1 canonical state versus Durable Object coordination state.
3. Node agent systemd versus container deployment.
4. Docker socket access and isolation.
5. Steam binary distribution policy.
6. Traefik versus direct port publication by protocol.
7. Cloudflare Access Managed OAuth and fallback strategy.
8. Provider idempotency and orphan adoption.
9. Plugin build-time registry and future third-party sandbox.
10. Backup encryption and key rotation.
11. Contabo cancellation and secure wipe.
12. Node-image promotion and rollback.
13. Multi-organization identity, membership, invitation, and tenant-isolation model.
14. Public sign-in/sign-up with Cloudflare Access and local account bootstrap.
15. Organization deletion, retention, and paid-resource cleanup..

# ADR 0085: Simulate the node boundary and protect production ingress

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0004, ADR 0005, ADR 0073, ADR 0074, and ADR 0084

## Situation

Gridora needed executable evidence for the Arma Reforger deployment path before
an operator could use a paid VPS or distribute Steam and Bohemia Interactive
content. The existing local fakes did not exercise the Docker Engine API,
nested container lifecycle, UDP health, configuration rollback, or log framing.

The release candidate also had no live Cloudflare environment. The public
product hostname had to be `gridora.coasts.red`. A production deployment could
not attach that hostname until Access protected the console and API, the
origin-authenticated paths had narrower policies, and all environment bindings
used production-only resources and secrets.

## Task

Prove the complete node orchestration boundary without paid infrastructure or
proprietary game content. Deploy the production Cloudflare control plane only
after exact Access, resource, migration, secret, and hostname fences exist.

## Execution

Run one disposable privileged Docker container as a simulated VPS. Run a
rootful nested Docker daemon inside that disposable boundary, load the node
image's nftables policy, and run only the nested game container as an
unprivileged user. Use a purpose-built fake Steam and Arma tool at the plugin
boundary. Exercise the production plugin and Docker adapter against that daemon.
Do not mount the host Docker socket into a game container.
Do not label this test as a real Arma installation, a Steam distribution test,
a signed node-image boot, or a paid-provider test.

Keep the simulated tool contract narrow. It installs a deterministic fake
server, accepts the generated Arma configuration and mod manifest, listens on
the planned UDP ports, reports plugin health, emits Docker logs, accepts an
update, and supports configuration rollback. The test must remove every nested
container and network that it creates.

Require the Docker adapter to expose every planned port in the Engine API
container configuration. Keep the tenant bridge non-internal so Docker can
publish host ports. Keep the nftables forward policy default-deny. Decode Docker
log multiplex frames before returning logs. Adopt an existing container only
after image, digest, environment, port, and network evidence match the accepted
plan.

Use `gridora.coasts.red` as the production public app. Use
`console.gridora.coasts.red`, `api.gridora.coasts.red`, and
`nodes.gridora.coasts.red` for the production console, API, and node namespace.
Keep staging below `staging.gridora.coasts.red`. Prefix every Cloudflare
resource and Secrets Store name with its environment.

Create one production Access application for the console and API. Allow all
authenticated identities because Gridora enforces registration and organization
membership after authentication. Enable HTTP-only binding cookies, eager
multi-host cookies, exact credentialed CORS, and Managed OAuth with 15-minute
access tokens and a two-week grant. Add more-specific bypass applications for
only `/v1/auth/intents`, `/v1/agent/*`, and `/v1/internal/*`. Keep Worker-side
one-time state, machine credentials, signed commands, and internal HMAC checks
on those paths.

Use an account-owned DNS token with DNS Write only on `coasts.red`. Use a
separate account-owned Cloudflare Tunnel Write token. Expire both tokens after
one year. Store the values only in Cloudflare Secrets Store. Store production
provider KEKs and the agent command private key in the same store under
production-only names. Keep public keys and key digests in the rendered Worker
configuration.

Create a production D1 database, five R2 buckets, seven queues, and seven dead
letter queues. Apply every registered migration before public routing. Use the
D1-compatible trigger assertion form `SELECT RAISE(...) WHERE ...`; do not use a
trigger-body `CASE ... END` that the remote statement splitter can terminate
early.

Deploy realtime first. Deploy an API bootstrap without public routes or
Workflow bindings. Deploy Workflows and Queue consumers. Retry a partial Queue
trigger update without changing secrets. Deploy the complete API only after the
Access applications and Workflows exist. Deploy the web Worker last. Keep
`workers.dev` and preview URLs disabled.

## Consequences

The local acceptance test now crosses the real Docker API and UDP boundary with
the production default-deny nftables forward table loaded. It can detect
incorrect install paths, missing `ExposedPorts`, invalid internal networks, log
framing errors, unsafe adoption, and rollback defects without using paid
infrastructure or proprietary game content.

The production Cloudflare control plane is reachable on the reviewed namespace.
Public sign-in and sign-up pages remain public. Access protects the console and
ordinary API routes. The three more-specific paths reach Gridora's own
fail-closed authentication middleware.

This decision does not prove that a signed Ubuntu image boots at a provider. It
does not prove SteamCMD or Arma Reforger licensing, installation, performance,
or protocol compatibility. A protected image build and a simulated provider
smoke can use this harness. A real provider and real game test still require
separate credentials, publisher approval, a hard TTL, and cleanup evidence.

## Verification

Run `pnpm test:arma-sim`. Run the Docker runtime and Arma plugin checks and
tests. Run the migration schema tests. Apply all 63 migrations to the production
D1 database and query `d1_migrations`.

Read the Access application list. Verify the shared audience and the four exact
destinations. Read the Secrets Store inventory without reading values. Read the
Email Sending configuration and resolve its MX, SPF, DKIM, and DMARC records.

Read the five production Worker deployment statuses. Request the public auth
pages. Request an ordinary console and API route without an Access session and
require rejection. Send an invalid public auth intent and require a Gridora
problem response with the exact production CORS origin. Request the agent and
internal paths without credentials and require Gridora rejection.

# Cloudflare environment binding contract

The checked-in `wrangler.jsonc` files are local build contracts. Do not deploy
them directly. Render one environment contract before any staging or production
deployment. The renderer replaces every D1, R2, Queue, Workflow, Durable
Object, service, Access, DNS, sender, and Secrets Store placeholder with the
reviewed value for that environment.

```sh
node infra/scripts/render-cloudflare-environment.mjs \
  --environment-file /protected/gridora-staging.json \
  --out-dir "$(mktemp -d)"
```

The input shape is in `environment.example.json`. It contains no secret value.
Keep a real input file outside the repository. The renderer accepts only
`staging` or `production`. It requires the exact resource prefix
`gridora-<environment>`. It rejects placeholders, invalid IDs, unsafe origin
values, a sender outside the configured DNS zone, and any hostname that is not
the exact hostname for its declared environment and zone. It renders all six
Worker configs, including the template used for schema comparison.

Terraform and the renderer share this name rule:

| Resource        | Staging name                | Production name                |
| --------------- | --------------------------- | ------------------------------ |
| D1 database     | `gridora-staging`           | `gridora-production`           |
| R2 or Queue `x` | `gridora-staging-x`         | `gridora-production-x`         |
| API Worker      | `gridora-staging-api`       | `gridora-production-api`       |
| Realtime Worker | `gridora-staging-realtime`  | `gridora-production-realtime`  |
| Workflow Worker | `gridora-staging-workflows` | `gridora-production-workflows` |

Read the non-secret `environment_binding_contract` Terraform output after a
reviewed apply. Copy its D1 ID, names, and Access audience into the protected
environment input. The renderer cannot invent a resource ID or Access audience.
It fails closed until an operator supplies them.

## Worker ingress and hostname fence

Every checked-in deployable Worker config sets `workers_dev: false` and
`preview_urls: false`. The renderer repeats both settings; neither the default
Workers subdomain nor a version preview URL is an approved production ingress.
Only rendered configs attach custom domains:

| Rendered config                      | Exact custom domains                                                                                                   | Other public route |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------ |
| API template and API Worker          | `api.<environment>.gridora.example` (or `api.gridora.example` in production)                                           | None               |
| Web Worker                           | `app.<environment>.gridora.example` and `console.<environment>.gridora.example` (without `.environment` in production) | None               |
| Realtime, Workflows, Queue consumers | None                                                                                                                   | None               |

The API and Web entries are Wrangler `custom_domain` routes, not wildcards.
Realtime, Workflows, and Queue consumers remain service, Durable Object,
Workflow, Queue, or scheduled-event entrypoints and the renderer removes both
`route` and `routes` from their output.

`zoneName` in the renderer and `zone_name` in Terraform declare the managed
zone. The required hostnames are exactly `api`, `app`, `console`, and `nodes`
under that zone in production, or those labels followed by `.staging` in
staging. Terraform validates the same four hostnames, including the DNS target,
before planning. A staging file cannot substitute any production hostname or a
hostname from another zone.

## Terraform state

Terraform uses a partial S3 backend because a backend cannot use Terraform
variables. The protected wrapper creates the ignored, non-secret
`terraform/backend.remote.tf` only for a remote run. CI uses no state backend
and needs no credential:

```sh
infra/scripts/terraform-init.sh offline
```

Protected staging or production runs use the Cloudflare R2 S3 endpoint and an
S3 lockfile:

```sh
export GRIDORA_TERRAFORM_STATE_BUCKET='reviewed-state-bucket'
export GRIDORA_R2_ACCOUNT_ID='reviewed-r2-account-id'
export AWS_ACCESS_KEY_ID='scoped-r2-access-key-id'
export AWS_SECRET_ACCESS_KEY='scoped-r2-secret-access-key'
infra/scripts/terraform-init.sh remote staging
```

The wrapper derives the state path as
`gridora/<environment>/terraform.tfstate`, enables `use_lockfile=true`, and
uses `AWS_ENDPOINT_URL_S3` for R2. It never accepts a state key from the caller.
It validates the account ID and R2 bucket-name shape before it builds the R2
endpoint. The R2 credential must be scoped to the state bucket. It may read and
write the state object. It may read, write, and delete its `.tflock` object. The
state bucket must exist before the first remote init. Do not put either R2 credential in a
Terraform file, a `-backend-config` flag, a plan, or a Worker config. See
`terraform/backend.r2.hcl.example` for the complete non-secret backend shape.

Do not add a backend block to a checked-in Terraform file. That would make the
credential-free CI plan require a live R2 account. The offline wrapper refuses
to run if a prior remote backend declaration is present; use a clean checkout
for CI-style validation.

No protected R2 state bucket, scoped R2 credential, D1 ID, Secrets Store ID,
Access audience, or custom domain is available in this repository. Remote-state
initialization and a locked live plan remain external operator steps.

The API contract includes one D1 database; private artifact, backup, log, and
notification-remediation R2 buckets; Queue producers; Durable Object bindings;
and Workflow bindings. The Queue consumer also uses the immutable audit archive,
six consumer queues, and six dead-letter queues. Terraform defines every private
R2 bucket, including backups and logs, and creates foundation resources only when
an operator sets `enable_resource_creation=true`.

Create resources with an operator identity. Deploy with a restricted CI token.
Set each required secret through the interactive Wrangler prompt. The API needs
`INTERNAL_SERVICE_SECRET`, `SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET`, `REALTIME_TICKET_SECRET`,
`INVITATION_TOKEN_SECRET`, `NODE_CREDENTIAL_SECRET`, and
`NODE_REGISTRATION_TOKEN_SECRET`. The workflow and queue Workers need
`INTERNAL_SERVICE_SECRET`. The realtime Worker needs `REALTIME_TICKET_SECRET`.

`SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET` is a dedicated, random 32-byte-or-
longer API-only HMAC key. It authenticates the opaque preview-to-apply commercial
review proof; it must not reuse `INTERNAL_SERVICE_SECRET`, appear in an
environment example, or be copied to the console, CLI, workflow, Queue, audit,
or D1 record. Rotating it invalidates outstanding commercial reviews, which is
safe: the user must request a fresh plan before apply. Record only that the
binding was set and rotated, never its value or an HMAC token.

The Queue consumer has the `INVITATION_EMAIL` Email Sending binding. The binding
can send only from `invitations@gridora.example` in the checked-in example. Replace
that address with one sender on the onboarded production domain. Do not add a
Cloudflare API key. The Worker binding provides the restricted send capability.
Invitation links use the public-app origin. They must not use the console origin
because invitation acceptance creates a public authentication intent.

Safe validation renders the non-secret staging fixture first. It then validates
every rendered Worker configuration. It does not create or update a remote
resource.

```sh
render_dir="$(mktemp -d)"
node infra/scripts/render-cloudflare-environment.mjs \
  --environment-file infra/cloudflare/environment.ci.json \
  --out-dir "$render_dir"
find "$render_dir" -type f \( -name wrangler.jsonc -o -name wrangler.template.jsonc \) \
  -print | sort | while IFS= read -r config; do
  pnpm exec wrangler deploy --dry-run --config "$config"
done
```

CI also runs `pnpm wrangler:types:check`. That command compares every checked-in
Worker configuration with its generated declaration. It catches a new binding
before a Worker type check can silently use a stale declaration.

The Security workflow runs the default Terraform plan after offline init. It
parses Terraform's JSON plan and fails if any resource action appears. Output
values are allowed because they describe the rendered binding contract. It also
plans each production-hostname override against the staging file and requires
Terraform variable validation to reject it.

The `terraform/` directory defines D1, R2, Queue, and optional Access application
resources. Its default plan creates no resource. Set `enable_resource_creation=true`
only in a protected environment. Set `enable_access_applications=true` only after
the console and API custom domains exist. One multi-domain Access application
protects both concrete hostnames. A new application uses Access eager cookie
redirects so a console login also establishes the API-domain application cookie
before the SPA makes a credentialed cross-origin request. The same application
enables Managed OAuth, dynamic loopback client registration, a 15-minute access
token, and a two-week refresh grant for the CLI. The application uses the
configured Access identity providers and requires an authenticated identity.
Open Gridora registration is still enforced by the application registration
mode. Do not split the console and API into separate Access applications without
adding and testing a linked-token or same-origin proxy design.

One more-specific public Access application bypasses human login for the
`/v1/auth/intents` path. Access paths do not encode an HTTP method. Its CORS
policy permits only a public-origin `POST`. The Worker permits unauthenticated
public traffic only for that exact `POST`. Other methods still require the
normal API authentication path. Two more-specific non-browser applications
bypass the human login transport for `/v1/agent/*` and `/v1/internal/*`. They
advertise no browser CORS. The console application allows credentialed CORS only
from the console origin for human routes, excluding the public intent path. The
Worker repeats the route and origin checks before it handles the request. The
Worker authenticates every bypassed protocol with one-time state, node or agent
credentials, signed commands, or internal HMAC. Keep the Access path list equal
to the fail-closed authentication middleware when routes change.

Supply the API token through `CLOUDFLARE_API_TOKEN`. Review the saved plan before
apply. D1, R2, and Queue resources use `prevent_destroy`. Change every related
Worker resource name and Service Binding together when you add an environment
prefix. Copy the shared API audience output to `ACCESS_AUDIENCE`; never guess it.
Verify the eager cookie redirect with a clean browser profile before production.
The pinned Cloudflare Terraform provider does not expose an eager-cookie
override. An imported older application is not acceptable evidence.

Per-node Tunnel and DNS resources belong to application workflows. Terraform does
not create them. The node cloud-init template does not contain a Tunnel token. A
separate trusted channel must install `/etc/gridora/cloudflared-token` after agent
registration. Until that channel exists, the Tunnel service fails closed.

Email Sending is a live deployment gate. The current Cloudflare account has no
sending domain. Do not send an invitation until an operator completes these steps:

1. Onboard the selected domain in Cloudflare Email Sending.
2. Verify the `cf-bounce` MX and SPF records.
3. Verify the sending DKIM record.
4. Add and verify a DMARC policy. Start with monitoring when the domain is new.
5. Replace the example sender in the Queue consumer Wrangler file.
6. Run `pnpm exec wrangler email sending list` and confirm the domain.
7. Deploy the Worker and send one transactional test to an address that you own.

CI does not use `remote: true`. CI does not send an email.

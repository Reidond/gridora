# ADR 0074: Render environment-specific Cloudflare bindings and lock Terraform state

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0073

## Situation

The checked-in Wrangler files use local resource names. Terraform creates
environment-scoped resource names. A direct deployment could bind a staging
Worker to a production resource or to a stale local name. Terraform state also
needs a remote backend for a live plan. The repository has no state bucket or
R2 credential.

Browser CORS needed the same narrow contract. A public application must not
gain access to human, agent, or internal routes. An agent or internal request
must not become browser-readable.

## Task

Create one reviewed binding contract for staging and production. Keep CI able to
validate Terraform and Workers without credentials. Lock remote state when an
operator runs a live Terraform plan. Limit credentialed browser CORS by exact
origin, route, method, and request header.

## Execution

Use `gridora-<environment>` as the name prefix. Terraform exposes the
non-secret names through `environment_binding_contract`. The renderer accepts
only `staging` or `production`. It requires the matching prefix. It validates
IDs, hostnames, origins, sender domain, public key data, and non-secret runtime
values. It renders every Worker config from the local source config. A staging
or production deployment must use rendered config only.

Treat `zoneName` and Terraform `zone_name` as the managed zone contract. The
only accepted production hostnames are `api`, `app`, `console`, and `nodes`
directly under that zone. Staging must use those labels directly below
`staging.<zone>`. The renderer and Terraform variable validations both reject a
production or foreign-zone hostname in a staging contract. API configs render
one exact `custom_domain` route for the API hostname. The Web config renders
two exact `custom_domain` routes for the public and console hostnames. Every
source and rendered config sets `workers_dev=false` and `preview_urls=false`.
Realtime, Workflows, and Queue consumer configs have neither `route` nor
`routes`; their ingress is only service, Durable Object, Workflow, Queue, or
scheduled-event based.

Run pinned Wrangler type generation for every Worker config. Check each
generated declaration in CI. Run a rendered-config Wrangler dry run in the
security workflow. This catches a binding name or type drift before deployment.

Allow the public origin to use credentialed CORS only for `POST
/v1/auth/intents`. Allow the console origin only for human API routes. Exclude
the public intent path from console CORS. Return no browser CORS headers for
agent and internal paths. Cloudflare Access matches the public path but not its
HTTP method. The Worker therefore allows unauthenticated public traffic only on
the exact POST.

Keep the S3 backend type out of checked-in Terraform. The protected init wrapper
creates an ignored non-secret backend declaration for a remote run. It requires
the state bucket, R2 account ID, and R2 S3 credentials. It fixes the state key
to `gridora/<environment>/terraform.tfstate`. It uses the R2 S3 endpoint and
`use_lockfile=true`. The S3 backend uses a state lockfile as documented by
[Terraform](https://developer.hashicorp.com/terraform/language/backend/s3).
Cloudflare R2 supports the S3-compatible conditional operations required for
the lockfile protocol as documented by
[Cloudflare](https://developers.cloudflare.com/r2/api/s3/api/). CI uses
`terraform init -backend=false`. It does not need remote-state credentials.

## Consequences

One input file binds all six Workers to one environment. The input file contains
protected identifiers but no secret value. A malformed or cross-environment
input fails before Wrangler runs. A new binding changes generated types and
fails CI until it is reviewed.

The custom-domain fence prevents a default Workers subdomain, preview URL,
wildcard route, staging-to-production hostname swap, or foreign zone from
becoming an alternate browser ingress. A source config without rendered routes
has no public route and therefore cannot substitute for the reviewed deploy
artifact.

Remote state is not usable until an operator creates the bucket and provides a
bucket-scoped R2 credential. The credential needs state-object read and write
access. It also needs read, write, and delete access to the adjacent `.tflock`
object. The wrapper does not create the bucket. The wrapper does not apply
Terraform. A missing protected input fails closed.

The public path is exposed through Access only at path granularity. The Worker
remains the method-level authorization boundary. A future public route needs a
new explicit origin and method rule. A future extra Worker config is discovered
by the type scripts under `apps/` and `workers/`.

## Verification

Focused API tests cover allowed and denied preflight requests, allowed response
headers, public-route denial, internal-route denial, and CSRF rejection. Focused
binding tests render the exact staging names and reject a production prefix in a
staging input. They also prove credential-free offline initialization and
fail-closed remote initialization. The generated type check covers every
checked-in config and the historical root declaration. Terraform format,
validation, and its default zero-resource plan run after offline initialization.
The Security workflow parses the plan JSON and rejects every resource action.
Focused renderer tests require exact API, public, console, and DNS hostnames,
then reject production and foreign-zone staging substitutions. They require
only the reviewed custom-domain routes for API and Web and no route for the
three service/event Workers. The Terraform gate attempts each production
hostname override against the staging input and requires validation to fail.

No R2 state bucket, Cloudflare resource, Access application, custom domain, or
Worker deployment was created or changed. A locked remote-state plan remains
blocked on protected operator inputs.

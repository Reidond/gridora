# ADR 0080: Bind Arma Reforger mod metadata to a bounded third-party V2 adapter

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0005, ADR 0009, ADR 0042, and ADR 0050

## Situation

An accepted Arma Reforger server create needs the complete, compatible mod
dependency graph before it can produce the signed agent plan. The prior control
path accepted a requested mod ID without resolving its dependencies or recording
where its version came from. The only currently supported typed source is the
public Reforger Mods V2 detail API. It is an independent third-party service,
not a Bohemia Interactive endpoint. It must not turn a user-supplied Workshop
URL, an upstream link, or a refresh job URL into an outbound request.

ADR 0042 keeps preview planning deterministic and network-free. A live lookup
must therefore be an explicit create-acceptance boundary, not an accidental
plugin planning side effect.

## Task

Resolve Arma Reforger Workshop mod metadata through one reviewed plugin-owned
HTTP adapter. Bound the source, request time, response size, parsing work,
dependency graph, retries, and cache use. Carry an exact generic dependency
graph and provenance in the accepted in-memory deployment plan. Return stable,
typed failures when the source is unavailable or unsuitable. Do not scrape
Workshop pages or use an API key, Steam credential, or other secret.

## Execution

The Arma plugin accepts only canonical 16-hex-character mod IDs with source
`reforger.armaplatform.com`. It constructs only
`https://api.reforgermods.net/v2/mods/{id}`. It rejects an invalid source,
identifier, response identity, Workshop URL, private mod, unpublished
dependency, duplicate dependency, invalid requested version, or graph above
the reviewed bounds. The generic SDK receives only normalized dependency and
provenance values. It contains no Arma endpoint or response-field knowledge.

The adapter sends a credential-free GET with fixed client identity headers. It
uses `credentials: omit` and rejects redirects. It sends no `Authorization` or
API-key header. A request has a five-second default timeout, a ten-second hard
timeout maximum, a 256 KiB body bound, JSON depth and node bounds, at most 256
direct dependencies, and at most 512 resolved mods.

A `202 Accepted` or `503` response can cause at most two cancellable retries.
The adapter honours a numeric `Retry-After` only up to five seconds and repeats
the same fixed detail endpoint. It never follows a supplied job or resource
URL. `429` distinguishes daily quota exhaustion from a minute rate limit. Bad
responses, 404, source failure, timeout, and incompatible metadata have stable
plugin error codes.

The adapter keeps a one-hour positive process-local cache. It uses an ETag for
stale revalidation and retains the exact endpoint, ETag, body SHA-256,
upstream-cache headers, Workshop-origin headers, fetch time, expiry, and cache
state for every resolved detail. Obsolete and unlisted metadata become explicit
warnings. A requested version must equal the verified current version.

Create acceptance invokes the optional generic plugin metadata resolver and
passes its result to the plugin plan. Preview callers do not pass it, so Arma
returns a deterministic `offline` result and performs no network request. The
existing accepted plan persists the resolved mod IDs and verified versions. The
metadata provenance remains in the in-memory control plan; this ADR does not
add a schema, operation receipt, or audit persistence claim for it.

The supported source contract is documented by the third-party [Reforger Mods
API overview](https://reforgermods.net/arma-reforger-mods-api/) and its [V2
detail reference](https://reforgermods.net/arma-reforger-mods-api/v2/). Those
references are not evidence of Bohemia affiliation.

## Consequences

An accepted Arma create either carries a bounded resolved dependency set or
fails before an agent command is issued. A preview stays deterministic and
cannot consume upstream quota. No API key, Steam credential, Workshop HTML,
upstream redirect, or upstream job URL enters the adapter path.

This metadata check proves neither a mod download nor a valid runtime
activation. The signed installer, staged config/mod activation, and health
validation are separate ADR 0081 work; bounded runtime egress is ADR 0082. A
later operation-bound provenance receipt requires a coordinated schema
decision; the plan-local provenance here must not be presented as durable audit
evidence.

## Verification

Focused plugin tests prove the fixed V2 paths, credential-free identity
headers, transitive dependency resolution, SHA-256/ETag provenance, cache
adoption, bounded same-origin `202` polling, response-size and timeout bounds,
quota/rate-limit/upstream mappings, malformed and unsupported-source rejection,
compatibility warnings, and deterministic offline planning. Lifecycle-control
tests prove create acceptance invokes the plugin-owned resolver and carries the
expanded verified dependency set to the signed plan. The plugin SDK, Arma
plugin, and lifecycle control type checks pass locally.

No live Reforger Mods request, Bohemia request, Steam request, agent command,
provider mutation, Cloudflare mutation, schema migration, or production
deployment was made for this decision.

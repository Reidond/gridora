# ADR 0046: Bounded provider create transports with adopt-only ambiguity recovery

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0019, ADR 0037, ADR 0038, and ADR 0043

## Situation

Node provisioning has immutable accepted facts and provider-runtime ports, but
those ports need production transports. A generic retry after a paid create
response is lost can duplicate infrastructure. Authentication catalogs,
pagination, redirects, response bodies, and provider resource fields are all
external input. Gridora must not turn an incomplete discovery result into proof
that no owned instance exists.

## Task

Gridora must authenticate to OVHcloud Public Cloud and Contabo, discover an
exact existing Gridora-owned node before creation, issue at most one paid create
request, and convert every ambiguous paid outcome into adopt-only recovery. The
transports must preserve immutable tenant ownership, accepted commercial terms,
secret containment, cancellation, bounded input, and strict endpoint policy.

## Execution

The OVHcloud transport authenticates with a Keystone application credential at
the exact HTTPS token endpoint. It selects exactly one public Nova endpoint and
one public Neutron endpoint for the accepted region from the returned catalog.
Both endpoints must be on an allowlisted OVHcloud host, and the compute endpoint
must contain the accepted project. Discovery scans bounded Nova detail pages and
accepts only the exact name, region, flavor, image, organization, node,
operation, and image-version metadata. Creation sends those fields and the
bounded base64 cloud-init document once, then validates the exact returned
server detail.

The Contabo transport authenticates at the exact OAuth endpoint and uses only
the exact HTTPS instance API. It supplies bounded UUID request identifiers and
the operation identifier as the trace coordinate. A deterministic encoded
display name carries the immutable ownership coordinates. The accepted billing
cadence, confirmed commitment, and one-, twelve-, or twenty-four-month term are
the only source of the provider `period`; the transport does not infer prices.
Discovery requires explicit, valid, finite pagination evidence and scans at
most five pages. Missing, malformed, zero, or excessive pagination fails closed
before creation.

Every request disables redirects, composes cancellation with a fixed timeout,
bounds request and response bytes, rejects malformed UTF-8 and JSON, and bounds
JSON depth and node count. Provider response details and credentials never enter
typed errors. A transport failure, redirect, server error, malformed success,
or uncertain follow-up after the paid POST becomes
`ProviderCreateUncertainError` with `adopt_only`. No code in either transport
repeats a paid POST. A later attempt may only adopt one exact owned resource.

## Consequences

Authentication and bounded discovery can be retried by orchestration, while a
paid create cannot. Incomplete discovery sacrifices liveness instead of risking
a duplicate charge. Commercial terms stay traceable to immutable acceptance,
and provider data cannot redirect Gridora to an arbitrary host.

The transports do not make the public node-create route executable by
themselves. The signed Workflow, exact credential opener, lease repository,
bootstrap image, and observation-driven ready transition must be composed.
Authorized live accounts are still needed to prove provider contract behavior,
create/adopt recovery, cleanup, and provider-side observability.

## Verification

Behavioral fetch tests cover both authentication protocols, exact creation
metadata, existing-resource adoption, lost-response recovery, state mapping,
catalog and host rejection, redirect refusal, oversized and malformed JSON,
secret canaries, cancellation, commercial-term mapping, fail-closed pagination,
foreign ownership, and server-error uncertainty. Package type checking, lint,
formatting, and diff checks pass. These mocked transports are not live provider
evidence.

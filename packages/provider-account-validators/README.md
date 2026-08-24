# Provider account validators

This package turns opened provider credential bytes into the concrete read-only
validators required by `@gridora/provider-account-control`.

```ts
import {
  makeContaboProviderAccountValidator,
  makeOvhProviderAccountValidator,
} from '@gridora/provider-account-validators'
import { ProviderAccountControlLayer } from '@gridora/provider-account-control'

const providerAccountControl = ProviderAccountControlLayer({
  repository,
  secrets,
  ovh: makeOvhProviderAccountValidator(),
  contabo: makeContaboProviderAccountValidator(),
})
```

The caller continues to own and zero the credential buffer after `validate`
finishes. The validators decode that buffer with the exact credential schema and
never include a credential, provider response body, token, or endpoint in a typed
error. Configured URLs must be HTTPS without embedded credentials, queries, or
fragments. They are also pinned to the documented OVHcloud (`cloud.ovh.net` or
`cloud.ovh.us`) and Contabo origins so user-controlled credentials cannot be sent
to an arbitrary HTTPS host.

Each request has a timeout, a one-MiB response cap, bounded JSON depth and node
count, and disabled redirects. Discovery follows at most eight pages and caps
the normalized snapshot at its domain limits. Unexpected success statuses,
malformed provider bodies, and provider schema violations are classified as
provider protocol failures, not as bad credentials. Production uses the native
`fetch` abort contract; any injected fetch implementation must honor the supplied
`AbortSignal` to release its own transport after the validator deadline settles.

OVH OpenStack application credentials prove the project, service catalog,
regions, compute endpoint, and readable flavors. Flavor pagination follows the
last-seen marker until an empty page. Nova flavors do not expose a currency or
price. This validator therefore returns an empty OVH price catalog instead of
inventing billing data. Production composition still needs an OVH billing-catalog
adapter with account-country/currency evidence. The validated flavor dimensions
cannot be placed in `ProviderDiscoverySnapshot.catalog` without also fabricating
that contract's required billing currency.

Contabo validation uses the documented password grant, proves compute `GET`
permission with one bounded instance-list page, and discovers compute-capable
`regionSlug` values through the paginated `/v1/data-centers` endpoint. The public
API does not expose an account-wide provisioning-product endpoint with explicit
billing currency. Its documented product endpoint is specific to an existing
instance's upgrade offers. The validator therefore returns an empty Contabo price
catalog and never calls fictional global region or product routes.

Live gates remain read-only contract tests against non-production accounts,
confirmation that `/v1/data-centers` reflects provisionable account geography,
separate approved catalog adapters with explicit plan, region, currency, price,
and contract evidence, and observability around bounded provider calls. An empty
price catalog must keep plan selection/provisioning disabled; it is not evidence
that a plan is available or priced. These validators prove account access and
geography only; they are not a production-ready paid-plan catalog.

# Contabo provider boundary

Contract assumptions verified on 2026-08-23 against Contabo's official [Compute Management API](https://api.contabo.com/).

- Instance create and reinstall accept Cloud-Init `userData`; actions include start, stop, restart and reinstall.
- Snapshot routes are scoped below `/v1/compute/instances/{instanceId}/snapshots`.
- Cancellation is a dated `POST /v1/compute/instances/{instanceId}/cancel`; it is not modeled as immediate deletion or immediate end of billing.
- Firewall rules are a separate `/v1/firewalls/{firewallId}` resource and instance attachment is explicit. The adapter port therefore represents reconcile-and-attach, not a fictional instance firewall endpoint.
- `x-request-id` is required by mutation endpoints. The concrete HTTP adapter requires a request-ID factory; the application composition binds it to the current Gridora operation ID.
- `secure_wipe_and_stop` is a Gridora orchestration result (agent wipe plus stop); it does not claim to be a Contabo cancellation endpoint and never reports billing stopped.
- Firewall reconciliation first fetches the dedicated firewall, requires its exact Gridora ownership description, preserves rules with other display names, replaces only Gridora-owned rules, and then attaches the instance.
- `makeContaboOAuthHttpClient` performs the official password grant with client credentials and API user credentials, caches the short-lived bearer token in its closure, propagates cancellation, and never includes credential values in errors.
- List adapters consume every `_pagination.totalPages` page. The initial implementation encodes adoption metadata into the provider-visible `displayName` because instance creation does not accept an inline tag assignment; deployments should prevent manual renames and reconcile Contabo tag assignments as an additional inventory signal.

Tests use only deterministic fakes and do not call Contabo or create paid resources.

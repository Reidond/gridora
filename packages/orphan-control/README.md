# Orphan control boundary

This package detects provider resources that claim exact Gridora ownership but
have no matching authoritative resource. It creates a high-severity finding. It
does not delete, stop, rebuild, or modify a provider resource.

The central API, scheduled trigger, provider-account registry, and live provider
discovery integration remain required. A live provider test must prove complete
pagination, tenant scope, stale-snapshot rejection, and response-loss replay.

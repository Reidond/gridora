# `@gridora/orphan-d1`

This package is the D1 persistence adapter for tenant-scoped orphan findings. It
loads only authoritative node records from the requested organization and
provider allocation, then stores finding changes, their high-severity audit
events, and the reconciliation replay record in one D1 batch.

The adapter never calls a provider and has no delete, stop, rebuild, or general
provider-mutation capability. Central API composition, scheduled workflow
registration, provider-driver lookup, and live provider discovery remain to be
wired by their owning packages.

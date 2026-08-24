# Provider orphan discovery

This package opens one tenant-bound provider credential envelope for one
reconciliation run, obtains only a `listNodes` function, and converts a complete
provider listing into the strict orphan-control snapshot contract.

The package cannot receive a create, update, stop, rebuild, retire, or delete
capability. It clears opened credential bytes on success, failure, and
interruption. It reports observations only. It never creates provider-removal
evidence from absence in a list response.

Live execution still requires an approved provider account, deployed D1 schema,
Secrets Store KEK, provider connectivity, and a signed internal Workflow or
Queue caller.

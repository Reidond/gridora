# `@gridora/policy-control`

Organization-scoped admission policy and estimated-cost controls for Gridora FR-19.

The package owns a strict versioned policy schema, a deterministic evaluator, Effect ports for
authoritative policy/usage/pricing/clock inputs, and a structurally compatible lifecycle admission
adapter. Hard constraints fail closed. Crossing the soft monthly budget returns a distinct warning;
it never silently becomes an allow or an invoice assertion.

All money is an integer in ISO-currency minor units. Provider prices and accumulated spend supplied
to this package are estimates used for admission only. Provider invoices remain authoritative.

`makeInitialOrganizationPolicy` emits the exact strict revision-1 onboarding contract. It preserves
an optional setup warning as `monthlyBudget.setupWarningMinor` and its currency, but keeps
`softLimitMinor`, `hardLimitMinor`, active/dedicated node limits, provider allow-list, and plan
allow-list at zero/empty. Missing warning currency is serialized as `null`; no invoice currency is
invented. Every capacity field is zero, so the initial policy cannot authorize paid creation until
an Owner or Administrator explicitly configures the allow-lists, capacity, currency, and hard
budget.

## Production composition gates

- Compose the implemented organization-scoped D1 policy repository and isolated GET/PUT route
  registration into the API entry point.
- Incorporate an atomic spend/capacity reservation in paid lifecycle transactions. The implemented
  pre-admission D1 snapshot is consistent and tenant-scoped, but a read alone cannot reserve budget
  or capacity against a concurrent create.
- Compose provider price-cache adapters with freshness timestamps and explicit unknown-price state;
  the adapter fails closed where immutable node-specific contract duration is unavailable.
- Map `PolicyAdmissionDeniedError` to lifecycle-control's `PolicyDeniedError`, and persist soft-budget
  warnings before starting a workflow.
- Reconcile estimates with provider billing exports for display only; never reinterpret estimates as
  provider invoices.

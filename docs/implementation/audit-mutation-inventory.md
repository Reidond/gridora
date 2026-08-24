# Audit mutation inventory

Status date: 2026-08-23.

This inventory is generated from the executable API route contract by
`apps/api/src/mutation-audit-inventory.ts`. Its test fails when a
`mutation: true` route has no entry, when an entry names a removed route, or
when a route marked as side-effect free does not return 501. It is an inventory
check. It does not replace end-to-end mutation tests.

`conversion-in-progress` is a release blocker. It does not mean that a legacy
compact audit insert is accepted. The migration rejects that insert. The owner
must convert the writer to an exact operation, scoped idempotency record, and
complete v1 staged audit in one transaction.

## HTTP routes

| Owner              | Routes                                                                                                             | Required evidence                                                                                      | Current state               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| Core               | `createOrganization`, `updateOrganizationPolicy`, invitation, membership, and ownership routes                     | Tenant or platform durable operation, scoped idempotency receipt, complete v1 audit                    | conversion-in-progress      |
| Node/platform      | Platform provider account and allocation routes, tunnel delivery, tenant provider account routes, and `createNode` | Exact platform or tenant operation, scoped idempotency, complete v1 audit                              | conversion-in-progress      |
| Game               | Game create, delete, patch, action, config, and mods routes                                                        | Exact tenant operation, scoped idempotency, complete v1 audit                                          | conversion-in-progress      |
| Backup/destructive | Backup, restore, cancellation, and organization deletion routes                                                    | Exact tenant operation, scoped idempotency/child receipt, immutable HTTP provenance, complete v1 audit | complete-v1                 |
| Audit              | Retire, rebuild, drain, reboot, and move routes                                                                    | No operation and no audit because the declared route returns 501 before a state change                 | blocked-before-side-effects |

## Non-HTTP and machine boundaries

| Owner              | Boundary                                                             | Required evidence                                                                                                                                                                                                                                                                  | Current state          |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Core               | Authentication completion and sign-up completion                     | Platform operation and complete v1 audit                                                                                                                                                                                                                                           | conversion-in-progress |
| Node/platform      | Registration exchange/revocation, agent events, agent command result | Machine operation, actor binding when needed, complete v1 audit                                                                                                                                                                                                                    | conversion-in-progress |
| Node/platform      | Telemetry acceptance                                                 | Exact machine operation, actor binding, authoritative epoch reservation, immutable receipt/adoption, abortable deadline-fenced R2 attempt, proof-based terminal cleanup, bounded retry/quarantine ledger, acceptance-time machine request provenance, and complete v1 staged audit | complete-v1            |
| Audit              | Scheduled policy and orphan reconciliation                           | Scheduler operation, actor binding, complete v1 audit                                                                                                                                                                                                                              | conversion-in-progress |
| Backup/destructive | Backup workflow completion                                           | Immutable acceptance provenance, exact terminal workflow operation/receipt, atomic complete v1 audit, compact row, outbox, and response-loss adoption                                                                                                                              | complete-v1            |
| Node/platform      | Node runtime lifecycle completion                                    | Workflow operation and complete v1 audit                                                                                                                                                                                                                                           | conversion-in-progress |
| Game               | Game lifecycle completion                                            | Workflow operation and complete v1 audit                                                                                                                                                                                                                                           | conversion-in-progress |

## Exact current gap

The machine-checked route list remains the source of truth for declared HTTP
mutations. Entries marked `conversion-in-progress` remain release blockers
until their owner has a focused operation, idempotency, audit, and response-loss
test. Backup, restore, cancellation, organization deletion, backup Workflow
completion, and telemetry are marked complete-v1. Backup Workflow completion
retains that state only while migration 0048, the terminal receipt, the exact
terminal audit operation, staged envelope, compact row, outbox, and response-loss
adoption remain one fenced transaction. Telemetry retains that state
only because its terminal receipt, operation, actor binding, epoch reservation,
staged v1 envelope, compact row, response-loss adoption, and matching
generation-exact upload acceptance fence are committed as one exact evidence
transaction. An abortable R2 stream deadline prevents further bytes after the
actual request boundary, while an unresolved writer retains its exact immutable
key until a settled terminal state proves cleanup is safe. The reservation
ledger bounds retries to four immutable generations, then quarantines the
operation; the per-node unfinished-operation cap and pending-first scheduler
avoid retry-row amplification and cleaned-row starvation during an outage. Receipt/audit
acceptance time is control-plane owned while machine sampled time remains
bounded evidence. This document intentionally does not claim that the full
product is release-complete.

## Compact writer source inventory

This is a current source inventory only. It is not an acceptance test. A
post-0028 compact insert without a preceding complete staged envelope now fails
at D1. The owner still must prove its operation and response-loss behavior.

| Owner              | Current compact insert modules                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core               | `packages/db-d1`, `packages/automation-identity-d1`                                                                                                                                                                                                                                                            |
| Node/platform      | `apps/api/src/tunnel-delivery.ts`, `apps/api/src/telemetry-runtime.ts`, `packages/agent-observation-d1`, `packages/provider-account-d1`, `packages/platform-provider-d1`, `packages/node-image-d1`, `packages/node-provision-d1`, `packages/node-provision-execution-d1`, `packages/node-runtime-lifecycle-d1` |
| Game               | `packages/game-lifecycle-d1`                                                                                                                                                                                                                                                                                   |
| Backup/destructive | `packages/lifecycle-d1` and node-owned lifecycle writers in `packages/lifecycle-termination-d1` remain inventoried separately; the backup, cancellation, and organization-deletion paths stage complete-v1 envelopes before post-0028 audit inserts.                                                           |
| Audit/scheduler    | `packages/policy-d1`, `packages/policy-reconciliation-d1`, `packages/orphan-d1`, `packages/server-plan-d1`                                                                                                                                                                                                     |
| Historical only    | migration 0026 and migration/test fixtures run before the 0028 fence or deliberately exercise it                                                                                                                                                                                                               |

The API test fixture and inventory fixture use an explicit complete staged
envelope. They are not production writer exemptions.

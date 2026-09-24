# Test Plan: {task-name}

> Replace all `{placeholders}` with actual content. Delete instructional comments after filling in.
>
> **Section guide**:
>
> - `Test Conditions and Cases` — **Medium tasks only**. Large tasks keep this in `test-cases.md`
>   and link to it; delete the inline block below.
> - `Ownership` column — omit entirely unless distinct parties write the tests at different levels.
>   A column filled with the same name throughout is ceremony.
> - All other sections are mandatory.
>
> **Vocabulary**: a _test scenario_ here means an execution sequence — a test script or procedure
> that runs several cases in order. It sits **downstream** of the test case, not above it.
>
> **Lifetime**: this is a build-time artifact. When the work ships it is deleted with the spec and
> the tests become the truth. Do not maintain it afterwards.

## Scope

### In Test Scope

- {What this plan covers — features, flows, layers}

### Out of Test Scope

- {Excluded area} — {why: covered by {id}, accepted risk, or belongs to another spec}

## Test Levels

<!-- Use the project's own level names. Where a language pack ships a test-type decision table,
     that table is authoritative — read the pack's testing conventions reference and use its
     names verbatim, so the plan and the suite agree. -->

| Level   | What it proves here                              | Case count | Harness / base class                                    | Ownership                  |
| ------- | ------------------------------------------------ | ---------- | ------------------------------------------------------- | -------------------------- |
| {level} | {the assertions this level owns in this feature} | {N}        | {base class, decorator, or runner the project requires} | {omit column if one party} |

<!-- Every case has exactly ONE owning level. A case at two levels is duplication unless it is a
     deliberate smoke case or a contract pinned on both sides — and then it says so. -->

## Test Conditions and Cases

<!-- MEDIUM TASKS: fill in inline, using the same structure as `.ai/templates/test-cases.md`
     (condition heading with source id → named technique → risk band → owning level → case table
     with cited expected results).
     LARGE TASKS: delete this block and link instead. -->

**Large tasks:** see [test-cases.md](test-cases.md) — {N} conditions, {N} cases.

**Medium tasks:** {inline condition blocks here}

## Test Scenarios (execution sequences)

<!-- A scenario runs several cases in order as one flow. Use scenarios where the cases share
     expensive setup, or where the order is itself part of what is being verified.
     Not every case needs to belong to a scenario. -->

### TS-01 — {Sequence name}

- **Purpose**: {what running these in sequence proves that running them separately does not}
- **Level**: {level}
- **Preconditions**: {environment and data state before step 1}
- **Cases in order**: TC-{nn} → TC-{nn} → TC-{nn}
- **Postconditions**: {state guaranteed after the sequence, including on failure}

## Test Data and Environment

<!-- Decided here so implementation does not improvise it. Name the project's real fixtures and
     factories rather than describing them generically. -->

| Need                          | Provided by                                 | Notes                                                                    |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| {External dependency to stub} | {the project's DI override or fixture name} | {behavior the stub must exhibit}                                         |
| {Seeded records}              | {factory name}                              | {quantity, key field values}                                             |
| {Auth state}                  | {token fixture or helper}                   | {role, expiry — recompute relative to run time, never a frozen absolute} |

**Banned test categories in this project**: {list any — e.g. performance or load tests — read from
the project's testing conventions. Requirements that fall into a banned category must be assigned
`observability` or `manual` in the Verification Methods table, never `automated`.}

## Verification Methods for Non-Functional Requirements

| ID         | Requirement   | Target           | Method                                                        | Where it is observed                      |
| ---------- | ------------- | ---------------- | ------------------------------------------------------------- | ----------------------------------------- |
| `NFR-{nn}` | {requirement} | {numeric target} | {automated \| observability \| manual \| accepted-unverified} | {test id, metric name, or checklist item} |

## Entry and Exit Criteria

**Entry** — verification work may begin when:

- [ ] `requirements.md` and `design.md` are approved
- [ ] Every case is grounded (zero `[UNGROUNDED]`)
- [ ] Test data and environment needs above are available

**Exit** — verification is complete when:

- [ ] Every case at every level passes
- [ ] Every `NFR-` has its method satisfied (test green, metric emitting, or checklist signed)
- [ ] Non-coverage rows are unchanged, or changes are approved
- [ ] {any project-specific gate — lint, type check, coverage floor}

## Traceability Matrix

<!-- Generated from the case list, not maintained by hand alongside it. A requirement mapped to a
     case that never ran is the appearance of coverage without the substance. -->

| Requirement | Cases            | Level   | Method        | Status                          |
| ----------- | ---------------- | ------- | ------------- | ------------------------------- |
| `AC-{nn}`   | TC-{nn}, TC-{nn} | {level} | automated     | {Planned \| Written \| Passing} |
| `NFR-{nn}`  | —                | —       | observability | {Planned \| Instrumented}       |

**Every requirement id appears exactly once in this table.** An id with no row is untraced; an id
with no cases and no method is unverified — say which, and why, in Non-Coverage.

## Non-Coverage

<!-- Medium tasks only; Large tasks keep this in test-cases.md. -->

| Condition         | Risk band | Why not covered |
| ----------------- | --------- | --------------- |
| {condition or id} | {band}    | {one sentence}  |

## Reconciliation with tasks.md

<!-- This plan is authored in parallel with `tasks.md`, so neither knows about the other until
     this pass runs. It runs in both directions, and it is this stage's completion gate.
     Re-run it after ANY amendment to either document — an amendment silently re-opens it. -->

**Status**: {Complete | Pending — `tasks.md` does not exist yet}

| Direction     | Check                                                                            | Result   |
| ------------- | -------------------------------------------------------------------------------- | -------- |
| Cases → tasks | Every `TC-` has an implementing task, or a named party outside this spec's scope | {N of N} |
| Tasks → cases | Every task's `Test requirements` field cites `TC-` ids rather than prose         | {N of N} |

**Unowned cases**: {list any `TC-` with no implementing task, or "None"}

**Tasks with un-backfilled test requirements**: {list any, or "None"}

## Open Gaps

| Item | Problem                        | Needs                           |
| ---- | ------------------------------ | ------------------------------- |
| {id} | {what is missing or ambiguous} | {decision needed from the user} |

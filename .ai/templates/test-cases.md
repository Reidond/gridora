# Test Cases: {task-name}

> Replace all `{placeholders}` with actual content. Delete instructional comments after filling in.
>
> **Large tasks only.** Medium tasks carry this content inline in `test-plan.md`.
>
> **This document does not restate requirements.** Every condition cites an `AC-`/`UC-`/`NFR-` id
> from `requirements.md`; every expected result cites the id it derives from. Copying Given/When/Then
> text here creates a second source of truth that drifts on the first requirement edit.
>
> **Vocabulary**: condition = what must be proven (no inputs, no expected result) → case = inputs +
> expected result (`TC-` id). Execution sequences (`TS-` ids) live in `test-plan.md`.

## Source Documents

| Document          | Version / date read | Notes                                                              |
| ----------------- | ------------------- | ------------------------------------------------------------------ |
| `requirements.md` | {date}              | {any ids assigned in place, if the doc predated the id convention} |
| `design.md`       | {date}              | Risk scores taken from its Risk Assessment table                   |

## Coverage Summary

<!-- Fill this in last. It is the reader's map, not a target to hit. -->

|                                     | Count                            |
| ----------------------------------- | -------------------------------- |
| Conditions harvested                | {N}                              |
| Cases derived                       | {N}                              |
| Conditions deliberately not covered | {N} — see Non-Coverage           |
| Cases marked `[UNGROUNDED]`         | {N} — must be 0 to pass the gate |

## Test Conditions and Cases

<!-- One block per condition. The condition heading cites its source id. The technique is named,
     not implied — a condition with no named technique had no analysis applied to it.
     See the test-planner skill's references/design-techniques.md for selection. -->

### C-01 — {What must be proven, one sentence} (`AC-{nn}`)

- **Technique**: {Equivalence Partitioning + BVA | Decision table | State transition | Pairwise}
- **Risk band**: {High | Medium | Low} — Likelihood {L}, Impact {I} per `design.md`
- **Owning level**: {level name from the project's own test-type table}
- **Excluded levels**: {level} ({one-clause reason}); {level} ({reason})

| ID    | Preconditions          | Input / action                 | Expected result                    | Source    |
| ----- | ---------------------- | ------------------------------ | ---------------------------------- | --------- |
| TC-01 | {state that must hold} | {concrete input, exact values} | {observable outcome, exact values} | `AC-{nn}` |
| TC-02 | {state}                | {boundary or error input}      | {expected failure behavior}        | `AC-{nn}` |

<!-- Expected results must be exact. "responds quickly" is not an expected result;
     "responds within 500ms (NFR-02)" is. A value the spec does not fix is a requirements gap:
     mark the case [UNGROUNDED], state what is missing, and surface it at the STOP gate.
     Never fill it with a plausible number. -->

### C-02 — {What must be proven} (`UC-{nn}` exception flow E1)

- **Technique**: {technique}
- **Risk band**: {band}
- **Owning level**: {level}
- **Excluded levels**: {level} ({reason})

| ID    | Preconditions | Input / action | Expected result | Source       |
| ----- | ------------- | -------------- | --------------- | ------------ |
| TC-03 | {state}       | {input}        | {outcome}       | `UC-{nn}` E1 |

<!-- Add one block per condition. Conditions come from: every Gherkin Scenario, every Use Case
     main/alternative/exception flow, every NFR, and the adversarial-five answers (auth,
     malformed input, dependency unavailable, concurrent race, dropped connection). -->

## Non-Functional Conditions

<!-- NFRs get a verification METHOD, not automatically a test. Check the project's testing
     conventions for banned test categories before assigning `automated` to any performance,
     load, or throughput requirement — assigning a test the conventions forbid produces work
     that must be deleted on sight. -->

| ID       | Requirement   | Target           | Method                                                        | Where it is observed                      |
| -------- | ------------- | ---------------- | ------------------------------------------------------------- | ----------------------------------------- |
| `NFR-01` | {requirement} | {numeric target} | {automated \| observability \| manual \| accepted-unverified} | {test id, metric name, or checklist item} |

## Non-Coverage

<!-- What was deliberately not tested. This is an output of the document, not an omission from it.
     A reader must be able to disagree with each decision, which means seeing it. -->

| Condition         | Risk band   | Why not covered                                                    |
| ----------------- | ----------- | ------------------------------------------------------------------ |
| {condition or id} | {Low × Low} | {one sentence — cost, accepted risk, or covered elsewhere by {id}} |

## Open Gaps

<!-- Cases that could not be grounded, and requirements ambiguities this analysis surfaced.
     Empty is the goal. Non-empty is fine — it is what the STOP gate is for. -->

| Item      | Problem                                              | Needs                           |
| --------- | ---------------------------------------------------- | ------------------------------- |
| `TC-{nn}` | `[UNGROUNDED]` — {which value the spec does not fix} | {decision needed from the user} |

# Gridora contributor instructions

## Architecture

- Treat `PRODUCT.md` as the product contract.
- Keep organization context explicit through routes, services, repositories,
  Durable Object names, queue partitions, R2 keys, provider metadata, and node
  credentials.
- Keep domain and provider contracts free of Cloudflare globals.
- Use Effect 4 for services, repositories, adapters, workflows, and typed
  errors. Run Effects only at application entry points.
- Use Hono only as the HTTP edge adapter. Effect Schema owns wire contracts.
- Keep SQL in `packages/db-d1` and migrations.
- Keep game-specific behavior inside its plugin package.
- Do not add ESLint, Prettier, an ORM, Kubernetes, arbitrary shell execution,
  dynamic `eval`, or runtime-loaded unreviewed plugins.

## Tooling

- Use the pinned Vite+ toolchain: `pnpm check`, `pnpm test`, and `pnpm build`.
- Use `wrangler.jsonc`, generate Worker bindings with Wrangler, and never
  commit secrets.
- When Python is necessary, use `uv` exclusively.

## Safety

- Never expose provider, Tunnel, Steam, machine, backup, or RCON secrets.
- Do not provision paid infrastructure in tests without an explicit live-test
  flag, hard TTL, and cleanup reconciliation.
- Do not make game containers privileged or mount the Docker socket.

## Commands

<!-- lemmi-ai-kit:begin commands (generated from project detection — edit freely; kit-setup refresh updates this block) -->

Run from the repository root (pnpm workspace, Node 24+). CI (`.github/workflows/ci.yml`) is the source of truth.

```bash
pnpm install --frozen-lockfile   # dependency sync
pnpm check                       # vp check: format + lint + type-check
pnpm test                        # vp test --run
pnpm build                       # vp run -r build
pnpm lint                        # vp lint
pnpm format                      # vp fmt --check
pnpm format:write                # apply formatting
pnpm typecheck                   # vp check --no-fmt --no-lint
pnpm wrangler:types              # regenerate Worker binding declarations
pnpm wrangler:types:check        # verify committed Worker bindings (run after pnpm build)
pnpm test:cloudflare             # Cloudflare runtime-boundary tests
pnpm test:arma-sim               # Arma Reforger lifecycle on a simulated VPS
pnpm exec vitest run tests/architecture/documentation-record.test.ts   # ADR/STE record integrity
```

<!-- lemmi-ai-kit:end commands -->

## Conventions

<!-- lemmi-ai-kit:begin conventions (generated from project detection — edit freely; kit-setup refresh updates this block) -->

- pnpm workspace monorepo (`pnpm-workspace.yaml`): `apps/*`, `packages/*`, `plugins/games/*`, `workers/*`.
- `apps/`: `agent`, `api`, `cli`, `web` (Nuxt, deployed as a Worker).
- `workers/`: `queue-consumers`, `realtime`, `workflows`.
- `packages/`: domain, contracts, control services, D1/R2 adapters, provider adapters, the plugin SDK, and migrations.
- `plugins/games/`: one package per game (`arma-reforger`, `second-reference-game`).
- `infra/`: Cloudflare environment, Docker, Packer images, scripts, and simulation.
- `tests/`: cross-package suites (`architecture`, `cloudflare`, `e2e`, `image`, `infrastructure`, `provider-contract`, `security`).
- `docs/`: ADRs (`docs/adr/`), the STE implementation record (`docs/implementation/step-by-step.md`), operations, plugin authoring, and threat model.
- Each Worker has its own `wrangler.jsonc`; binding declarations are generated, not hand-written.

<!-- lemmi-ai-kit:end conventions -->

### Task documents (`tasks/`)

- One task per markdown file; keep focused on a single problem.
- Prefixes: `TECH-` (design), `STRUCT-` (refactor), `PROD-` (runtime), `BUG-` (fix), `FEATURE-` (new work).

### AI provider knowledge

**Rule: Always fetch official docs before answering questions about AI model internals.**

Never rely on in-memory training knowledge for AI provider specifics. Model IDs, API
parameters, event schemas, audio formats, rate limits, and capabilities change between
releases. Stale answers cause bugs that are hard to trace.

Prefer authoritative, auth-free sources (fetch with `WebFetch` before answering) — e.g.
provider docs pages and, when docs pages are unreliable, raw SDK type source files
(for OpenAI: `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/...`).

See the `ai-docs-lookup` skill for the full lookup process.

## AI Development Workflows

Only workflows from enabled native plugins are available. Core provides development
and learning workflows; research, orchestration and skill-authoring are optional
plugins. If a selected route requires a missing pack, report its native installation
prerequisite before dependent work. Never silently skip a required step.

### Pipeline Overview

```
PRE-PLANNING                PLANNING                    IMPLEMENTATION              COMPLETION
────────────                ─────────                   ──────────────              ──────────
/lemmi-ai-kit-core:product-brief              /lemmi-ai-kit-core:spec-driven-dev            [auto-loaded]               /lemmi-ai-kit-core:post-task-review
(task)                      (workflow)                  convention skills           (workflow)
   │                           │                            │                          │
   └─→ tasks/FEATURE-*         ├─→ test-planner             │                          ├─→ task-learnings
                               │   (task)                   │                          │   (task)
                               │                            │                          │
                               ├─→ plan-critic                                        └─→ /lemmi-ai-kit-core:commit-message
                               │   (review)                                               (task)
                               │
                               └─→ .specs/{name}/
                                   (state files)

SKILL CREATION                          PERIODIC (weekly/biweekly)
──────────────                          ──────────────────────────
/lemmi-ai-kit-skill-authoring:skill-creation-workflow                /lemmi-ai-kit-core:learning-consolidator
(workflow)                              (workflow)
   │                                       │
   ├─→ skill-researcher                    ├─→ Analyze .ai/learnings.md entries
   │   (task)                              ├─→ Promote to AGENTS.md / skills
   │                                       └─→ Clean up processed entries
   ├─→ /lemmi-ai-kit-skill-authoring:skill-creator
   │   (task)                           /lemmi-ai-kit-core:session-retrospective
   │                                    (task)
   └─→ skill-content-reviewer              │
       (review)                            ├─→ Extract session data (Python)
                                           ├─→ Analyze patterns & feedback
                                           ├─→ .ai/retrospectives/ report
                                           └─→ feeds /lemmi-ai-kit-core:learning-consolidator
```

### Task completion checklist (mandatory)

When a task is complete, ALWAYS perform these steps before considering it done:

1. **Post-task review** (major tasks: 3+ files, new feature, spec completion) — Run the full review, Step 0 through Step 9: blast radius (0), code review (1–6), documentation impact (7), learnings extraction (8), close self-challenge (9). The `post-task-review` skill is the authority on its own step list; do not restate a step COUNT here, it goes stale.
2. **Learnings extraction** (all tasks) — Extract project-level findings and append to `.ai/learnings.md`. See the `task-learnings` skill.
3. **Documentation updates** — If any modified files affect docs (per `references/doc-impact-matrix.md` in the `post-task-review` skill), update the affected documentation.
4. **Rebuild/restart** — <!-- lemmi-ai-kit:begin restart (generated from project detection — edit freely; kit-setup refresh updates this block) -->
   Not needed — the standard verification loop (`pnpm check`, `pnpm test`, `pnpm build`) runs no long-lived services.
   <!-- lemmi-ai-kit:end restart -->

### Learnings system

- `.ai/learnings.md` is a **lean intake buffer**, not the knowledge store. Before a task, draw on: the always-loaded `AGENTS.md` rules; the relevant skills (plugin or project-local); and — **when working in a subsystem, that subsystem's code-adjacent module/feature `README.md`**, where its specific conventions and gotchas live. Skim `.ai/learnings.md` itself only for not-yet-promoted intake entries.
- After completing a task, extract and record new learnings using the `task-learnings` skill — it appends to the `.ai/learnings.md` intake buffer under the matching category.
- If a finding reveals a convention gap, write it straight to its home: a universal rule → `AGENTS.md`; a cross-cutting pattern → the relevant skill; a subsystem gotcha → the module/feature README; an invariant guard a future edit could break → a co-located code comment.
- Periodically (~weekly) run `/lemmi-ai-kit-core:learning-consolidator` to drain accumulated intake entries into rules, skills, READMEs, and comments, then remove the promoted source entries.
- See the `task-learnings` skill for the full extraction process.

### Product brief (pre-planning)

Uses: product-brief (task)

- For new product ideas that need shaping before implementation, run `/lemmi-ai-kit-core:product-brief` first.
- The skill researches the codebase, challenges assumptions (2-3 mandatory), then writes a team-readable task description to `tasks/FEATURE-*.md` with production-ready UX content.
- Hand off to `/lemmi-ai-kit-core:spec-driven-dev` when the brief is approved and the team is ready to implement.

### Spec-driven development

Uses: spec-driven-dev (workflow), test-planner (task), plan-critic (review)

- Auto-detect task size before implementation using scope analysis.
- Small tasks (1–3 files, single concern): implement directly.
- Medium tasks (4–10 files, new components): create a lightweight spec in `.specs/{task-name}/spec.md`.
- Large tasks (10+ files, multi-feature, architectural): create full spec (requirements.md, design.md, tasks.md, test-cases.md + test-plan.md) in `.specs/{task-name}/`.
- Large tasks: present requirements → approval → design → approval → then tasks and the verification plan **in parallel**, each with its own approval → implement.
- Verification planning (`test-planner`) runs for Medium and Large tasks whose design touches executable code; skip it otherwise and say so. It harvests conditions by id from requirements rather than restating scenarios, gives every case exactly one owning test level, and assigns each NFR a verification method (automated / observability / manual / accepted-unverified).
- Because tasks and the verification plan are written in parallel, reconcile them before implementing: every `TC-` needs an implementing task, and every task's `Test requirements` field cites `TC-` ids rather than prose.
- At each spec gate, iterate if the user requests changes. Challenge changes that are technically unsound or contradict prior approvals — once, with reasoning — then defer to the user.
- All spec documents must be written to `.specs/{task-name}/` as actual files. IDE-specific plan tools do not substitute for file creation.
- Large tasks with natural phase boundaries: use phased execution with intermediate quality gates to reduce context load and catch drift early.
- Templates live in `.ai/templates/`. See the `spec-driven-dev` skill for the full pipeline.

### Post-task review

Uses: post-task-review (workflow), task-learnings (task), commit-message (task)

- Run the full post-task review for all major tasks (3+ files modified, new features, spec completions).
- Steps 1–6: code review and convention compliance (see the `post-task-review` skill).
- Step 7: documentation impact analysis — check and update affected docs.
- Step 8: learnings extraction — capture and record project knowledge.

### Plan self-review (plan-critic)

Uses: plan-critic (review) — **universal, not limited to spec-driven-dev**

- **Before presenting ANY plan, spec, or design document to the user**, run the plan-critic self-review. This applies to bug-fix plans, feature specs, refactoring plans, and any other structured plan.
- Invoke the `plan-critic` skill after writing: `spec.md` (medium tasks), `design.md` (large tasks), `tasks.md` (large tasks, completeness-only), `test-cases.md` / `test-plan.md` (Dimension 6 plus the citation check), or any bug-fix/task plan.
- Resolve all Blocker and Major findings silently before presenting. Minor findings are fixed without mention.
- If any Blockers or Questions cannot be resolved without user input, surface them prominently at the top of the presented document — do not suppress them.

### Orchestration and delegation

Uses: orchestrate (workflow), agent-delegate (task)

- With Orchestration enabled, use `/lemmi-ai-kit-orchestration:orchestrate` for large decomposable tasks: the main model plans and judges;
  scoped subtasks go to cheaper native subagents (Opus for reasoning, Sonnet for mechanical
  work) and external CLI peers (codex, cursor-agent, grok) in parallel.
- Delegation through that plugin uses its brief contract (one concern, inlined context, self-checkable
  definition of done, short report) — see `references/brief-template.md` in the `orchestrate` skill.
- A worker's summary is a claim: verify the actual output against the definition of done before
  merging. For high-stakes decisions, task independent workers in parallel without showing them
  each other's answers, then synthesize.
- Keep single-agent when judgment is the work or the subtasks can't be crisply named.
- With Core alone, work in one agent. If the user requests an Orchestration workflow,
  report `lemmi-ai-kit-orchestration@lemmi` as a prerequisite before that workflow starts.

### Parallel research source planning

Uses: research-source-planner (task), research-source-claim (task), parallel-deep-research (workflow)

- These routes apply when Research is enabled. With Core alone, use a single-agent
  lookup; if the user requests this parallel workflow, report `lemmi-ai-kit-research@lemmi`
  as a prerequisite before starting it.
- **One-command path:** `/lemmi-ai-kit-research:parallel-deep-research <question>` runs the whole flow automatically — scope → plan sources (planner) → fan out one sub-agent per owner (claim protocol) → synthesize a cited report.
- **Manual path / pre-step:** before any hand-rolled parallel/multi-session fan-out, run `/lemmi-ai-kit-research:research-source-planner <question>` first. It builds a deduplicated `source-manifest.md` that assigns each source to exactly one owner.
- Each fan-out worker then follows `research-source-claim`: workers touch ONLY their assigned rows.
- Skip for single-agent lookups (1 owner → no overlap to prevent).

## Do not

### AI workflow rules (universal)

- Invoke a Workflow Skill from within another Workflow Skill (max 1 level of skill nesting).
- Auto-invoke side-effect skills that take outward or destructive action (commit, deploy, review, branch-switch) without an explicit user request. **Standing exception:** the model MAY proactively run `session-retrospective` and `learning-consolidator` — the retrospective only writes a report, and the consolidator presents its plan and waits for approval before editing any rule, skill, or learning, so the destructive step stays gated.
- Hardcode an absolute local path — a drive-letter path, `/Users/…`, `/home/…`, or a per-machine session directory — in a shared skill, script, or doc. These are machine-specific, so a hardcoded path works for exactly ONE person. Derive at runtime instead: relative to the referring file, repo-root-relative, `${CLAUDE_SKILL_DIR}`, or `Path(__file__)` / `Path.home()`. Enforced by the skill-reviewer portability check.
- Build scope the task didn't ask for. Volunteering speculative features, fallbacks, or examples "just in case" is over-engineering — surface optional scope as a decision in the plan and implement it only on approval.
- Merge a sub-agent's (Agent/Task) returned summary as if it were verified — its change-log is a **claim**, not verification. For delegated multi-file work: keep coupled/load-bearing pieces in the main thread, inline the source-of-truth into each brief so the sub-agent can't drift, and ALWAYS read each sub-agent's actual output files and reconcile them against the source-of-truth before integrating.
- Edit a file you read earlier in the session without re-reading it first when it may have changed since — a file open in the IDE, touched by a linter/formatter, edited as part of a sibling change, or an append-only log (`.ai/*.md`). For append-heavy markdown, copy an Edit's `old_string` verbatim from a fresh Read of the target region — never reconstruct it from memory.
- `Read` a conventional or assumed path before confirming it exists — `Glob`/verify first.
- Verify a structured-config value (YAML frontmatter key, JSON field, enum membership) with a whole-file substring grep — parse the structure or scope the match to the structural region instead. A content grep also matches files that merely _document_ the key.
- Start implementing bug fixes without presenting a brief plan first — even for "quick" fixes. If the fix touches more than 1 file or involves data flow changes, write a plan and get approval before coding.
- Treat task docs as runtime configuration, or let tasks drift from current implementation without updating status.

### Project rules

The kit-shipped sections above are refreshed when the kit updates (only inside
their marked blocks); the Gridora sections at the top of this file are hand-written. **Nothing below it is ever generated, overwritten, or reordered** —
`kit-setup refresh` rewrites only its own marked blocks — which is what makes this
the one place in the file a convention can safely live.

A rule belongs here when it is a do-not, specific to THIS repository, that a
newcomer would otherwise learn by breaking something. Three near-misses go
elsewhere instead: a universal rule belongs in the sections above or in a skill; a
single subsystem's gotcha belongs in that subsystem's README, next to the code it
constrains; and one still being argued about stays in `.ai/learnings.md` until it
settles.

State the rule and its reason in the same breath. A rule with no reason attached
is dropped the first time it is inconvenient, and nobody can tell later whether
dropping it was fine.

Rules arrive two ways: by promotion, when `/lemmi-ai-kit-core:learning-consolidator` drains an entry
`task-learnings` put in `.ai/learnings.md`, or by hand the moment one is known —
from an existing `CONTRIBUTING.md`, a house style, or a decision made in review.

<!-- lemmi-ai-kit:begin project-rules (generated from project detection — edit freely; kit-setup refresh updates this block) -->

- Do not rewrite an accepted ADR; add a new ADR or supersede it when a material
  architecture decision changes. Accepted ADRs are the decision history.
- Do not publish a change without adding the next sequential step to the STE
  implementation record (`docs/implementation/step-by-step.md`): short sentences,
  active voice, one controlled status, explicit actions, evidence or a blocker,
  verification, and the controlling ADR. The record is checked by
  `tests/architecture/documentation-record.test.ts` — run it before publication.
- Do not change behavior without tests for the behavior and each denial path
  (`CONTRIBUTING.md`).

<!-- lemmi-ai-kit:end project-rules -->

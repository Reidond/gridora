# CLAUDE.md

@AGENTS.md

## Skills

This is a catalog, not an installation record. Invoke only skills from enabled
plugins in the host's inventory. Install an optional pack through the native plugin
manager when its workflow is needed; this file does not activate it.

### User-Invocable (use with `/skill-name`)

- `/lemmi-ai-kit-core:kit-setup` — Seed or refresh project-owned AGENTS.md/CLAUDE.md/.ai files from plugin templates, placeholders filled from the detected project
- `/lemmi-ai-kit-core:commit-message` — Generate conventional commit messages from the working diff
- `/lemmi-ai-kit-core:branch-switch` — Safely stash, switch branch, and re-apply with conflict detection
- `/lemmi-ai-kit-core:spec-driven-dev` — Spec-driven development pipeline with task-size detection and requirements/design/tasks/verification gates
- `/lemmi-ai-kit-core:test-planner` — Derive a verification plan from an approved spec: conditions by id, one owning test level per case, a verification method per NFR
- `/lemmi-ai-kit-core:post-task-review` — Post-task review pipeline: blast radius, code review, documentation impact, learnings extraction, and a mandatory close self-challenge
- `/lemmi-ai-kit-core:learning-consolidator` — Periodically drain .ai/learnings.md intake into rules, skills, READMEs, and comments
- `/lemmi-ai-kit-core:session-retrospective` — Analyze Claude Code session history for behavioral patterns and workflow friction
- `/lemmi-ai-kit-core:product-brief` — Shape a product idea into a team-readable task brief with assumption challenges and UX content
- `/lemmi-ai-kit-core:analyze-logs` — Root-cause analysis from structured or plain application logs — platform examples are GCP and Docker, the method is not — with task file creation
- `/lemmi-ai-kit-core:metric-validity-check` — Test whether a metric, score or judge tracks a user-visible outcome before its number drives a decision: join the label to the artifact, report the seven linkage diagnostics, run a known-groups test over every metric, and return SEPARATES / DOES NOT SEPARATE / UNDERPOWERED / SUSPECT
- `/lemmi-ai-kit-core:flow-mapping` — Map runtime scenarios, callers and invariants; validate Python flow documents and reconcile cross-flow findings

### Auto-Loaded by Claude (background knowledge)

- ai-docs-lookup — Fetch official AI provider docs before answering questions about model internals
- vertical-slice — Vertical slice architecture patterns for feature-oriented codebases

### Internal Pipeline Skills (invoked by workflows or directly by the model; hidden from the `/` menu)

- plan-critic — Self-review specs and plans for gaps before presenting them
- task-learnings — Extract and record project learnings after task completion
- ai-changelog — Append structured entries to the AI infrastructure changelog
- consolidation-critic — Adversarial gate on a consolidation plan before it executes: challenges every promotion, archive and new-skill proposal, and audits that no drained entry lost its knowledge
- hypothesis-validator — Close the improvement-hypothesis loop: window guardrail, evidence for and against, CONFIRMED/REFUTED/INCONCLUSIVE/SUPERSEDED verdicts, a ledger-state report each pass (terminal entries stay put; no archive) and meta-synthesis
- ai-improvement-tracker — Record testable improvement hypotheses for AI infrastructure changes

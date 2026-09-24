# Stacked PR Workflow

Hard-won mechanics for maintaining a stacked-PR chain in this repo (the deepest so far was 11
PRs, #373–#383). Both rules below cost real work to learn; each has a trap that silently drops a
commit or closes a PR.

## Native stacks first (`gh stack`, public preview 2026-07-30)

GitHub now ships stacked PRs natively: the `gh stack` CLI extension, a REST/webhook surface,
automatic cascade + retarget when a bottom PR merges, and whole-stack merges. **Prefer the native
path; the manual sections below are the fallback** — and the verification rules stay mandatory
either way.

**Prerequisites (probe once per session):** `gh --version` succeeds and `gh extension list`
shows `gh-stack`. Missing → use the manual workflow below and say which path you used. Install
(interactive, user-run): `winget install GitHub.cli`, `gh auth login`,
`gh extension install github/gh-stack`.

| Intent                                      | Command                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a stack (trunk is `dev` in this repo) | `gh stack init --base dev [branches...]`                                                                                                                                                                                                                                                                                                                                                                                    |
| New layer on top                            | `gh stack add [-m <msg>]` (run from the top branch)                                                                                                                                                                                                                                                                                                                                                                         |
| Open/update the PRs                         | `gh stack submit` — **draft is NOT the default on the interactive path.** Verified against the CLI: in the editor "new PRs default to ready for review; switch any to draft with the CREATE AS toggle". Only `--auto` creates drafts ("with `--auto`, new PRs are created as drafts unless you pass `--open`"). To honour this repo's early-draft rule, either toggle each PR in the editor or use `gh stack submit --auto` |
| Absorb a mid-stack fix                      | commit on the owning branch; cascade at a boundary via `gh stack sync`                                                                                                                                                                                                                                                                                                                                                      |
| Cascade + push + PR sync                    | `gh stack sync` (fetch, trunk FF, cascading rebase, per-branch `--force-with-lease`, PR sync)                                                                                                                                                                                                                                                                                                                               |
| Conflict recovery                           | **start** `gh stack rebase`, then `--continue` / `--abort` — a `sync` that hit a conflict has already rolled every branch back, so there is nothing to continue (see below). **The often-quoted "exit code 3 = conflict" mapping is UNVERIFIED**: `gh stack rebase --help` documents no exit codes. Branch on the command's output, not a remembered code.                                                                  |
| Inspect state (agent-friendly)              | `gh stack view --json`                                                                                                                                                                                                                                                                                                                                                                                                      |
| Restructure layers                          | `gh stack modify` (clean tree required)                                                                                                                                                                                                                                                                                                                                                                                     |
| Adopt branches made by other tooling        | `gh stack link`                                                                                                                                                                                                                                                                                                                                                                                                             |

**Drafts are not the default on the interactive path.** `gh stack submit --help`: _"In the
editor, new PRs default to ready for review; switch any to draft with the CREATE AS toggle.
With `--auto`, new PRs are created as drafts unless you pass `--open`."_ So the two paths
disagree, and the one a human types is the one that publishes. Since `parallel-session-safety`
§10 requires layer PRs to open as drafts at a session boundary, use `--auto` (which is also
what a non-interactive terminal falls back to) or set the Draft toggle explicitly before
Ctrl+S. Do not rely on "submit defaults to draft" — it does not.

**After `gh stack sync` reports a conflict there is no rebase in progress.** Its help is
explicit: _"If a rebase conflict is detected, all branches are restored to their original state
and you are advised to run `gh stack rebase` to resolve conflicts interactively."_ The rollback
is the point — `sync` is atomic. So `gh stack rebase --continue` at that moment fails with
nothing to continue; the sequence is **`gh stack rebase` first** (which re-runs the cascade and
stops at the conflict, leaving a live rebase), resolve, then `gh stack rebase --continue`, and
`--abort` to unwind. Re-run `gh stack sync` afterwards to push and re-sync PR state.

**Superseded on the native path:** the hand-rolled `--update-refs --onto` cascade below
(`gh stack sync` runs it, with `--continue`/`--abort` recovery), and _manual_ base retargeting —
merging the bottom PR auto-rebases the remaining branches and retargets the next PR to trunk. The
base-lock 422 documented below still stands, but on the native path you never need to retarget by
hand, so it stops being a workflow step and becomes a guardrail.

**Still mandatory with the native path:**

- Verify the remote chain link by link after every sync/push (section below) — `gh stack`'s
  success output is a claim, exactly like a push report.
- Zero-conflict-marker assertion after any conflicted cascade; `own-commits >= 1` per moved
  branch; backup tags until merge.
- **Session discipline:** cascades and outward actions (`sync` / `rebase` / `modify` / `merge` /
  `submit` / any push) are user-authorized boundary operations — never from a session mid-layer.
  Sessions may run `gh stack` commands only on a clean tree within their pinned layer. Layer PRs
  open as drafts at the session-end boundary. See `parallel-session-safety` §10; topology
  planning (stacked spine vs sibling leaves, risk class, review lane) is the **`stacked-pr-planner`**
  skill, invoked by `orchestrate`'s plan step for a single session's work and by
  **`initiative-planner`** step 2 for anything spanning several sessions. Review and comment
  resolution on the resulting
  PRs: `pr-review-concise` and `pr-comment-resolver` — the latter owns the rule that a fix goes in
  the branch that owns the code, never in a new top-of-stack PR.

**Preview caveats:** same-repo branches only (no cross-fork); public-preview semantics may
change; keep `gh-stack` extension versions roughly aligned across the team.

## Propagating a mid-stack fix

A review comment belongs on the PR that **owns** the code, and every descendant then has to absorb
it. Work bottom-up, one fix at a time:

```bash
git checkout <owning-branch>
OLD=$(git rev-parse HEAD)      # capture the tip BEFORE committing — this is the rebase base
# ...edit + commit...
git rebase --update-refs --onto <owning-branch> "$OLD" <top-branch>
```

`--update-refs` replays every descendant onto the new owning tip **and moves all intermediate
branch refs in one pass**. Never hand-rebase each descendant. Force-push the moved branches with
`--force-with-lease`.

> **Trap — a silently dropped commit.** Do NOT use the descendant's OWN tip as the rebase base when
> `local == origin`: the replay range is empty and the branch collapses onto its parent, losing its
> commit with no error. This is why `OLD` is captured explicitly _before_ the commit rather than
> derived afterwards.

**Guard before any force-push** — a per-branch integrity check: `own-commits >= 1` and
`behind-dev == 0`. Run it for every branch the rebase moved, not just the one you edited.

## Work the layers in ONE direction

`git rebase --update-refs <base> <tip>` replays only `merge-base(<base>, <tip>)..<tip>` — a commit
reachable only from a branch ref OUTSIDE that range is not protected by `--update-refs`.
Committing at layer N and then cascading from a layer BELOW N puts N's fresh commit outside the
replayed range: the rebase rebuilds N's layer from the tip's history and moves N's ref past the
commit. This bit twice in one session, in both possible shapes — a LOST commit (not an ancestor
of anything; found only because the test suite failed) and a STRANDED ref (N left pointing at a
dangling commit, so N+1 no longer descended from it — a broken PR chain caught seconds before
push). Neither produces any git warning; `rebase --continue` and `push --dry-run` both report
success.

So: after committing at layer N, cascade upward from N **before** touching any layer below it.

**That rule covers ONE fix. A review sweep produces fixes at MANY layers, and the obvious generalization is wrong.** Committing at every layer and then running a single `rebase --update-refs` from the bottom does NOT carry them: each fix commit sits on its own branch ref _outside_ the replayed range, so the rebase replays the OLD chain onto the new base and silently drops every fix. Measured: one such pass exited **0**, reported success, and moved 4 refs — none of the 11 intended. The correct form is N sequential rebases, bottom-to-top, one per layer:

```bash
# for each (base, layer) pair, in bottom-to-top order:
git rebase --onto <base> origin/<base> <layer>     # replays only that layer's own commits
```

**Then assert the fixes actually arrived** — the rebase's exit code will not tell you:

```bash
git log --oneline origin/dev..<top> | grep -c '<your fix marker>'   # must equal the number of layers you fixed
```

> **`--update-refs` also moves branches you never named.** It updates _every_ ref pointing into the replayed range, not just your stack layers — one cascade here moved three unrelated branches (two of them old review-fix branches) under a success banner. Snapshot before, diff after, restore anything unintended:
>
> ```bash
> git branch --format='%(objectname) %(refname:short)' | sort > .ai/tmp/refs-before
> # ...cascade...
> git branch --format='%(objectname) %(refname:short)' | sort | diff .ai/tmp/refs-before -
> ```

Run the fast suite after the FIRST layer of a stacked change, not after the last — one session
landed 13 commits before its first suite run, which then found 14 failures + 4 errors the static
gates had missed. After any conflicted cascade, assert conflict markers are ZERO at **every**
layer before continuing: a marker committed at layer N is replayed into every layer above it.
`git rebase --continue` does not check content, and `git diff --check` inspects only _uncommitted_
changes — it does flag leftover markers if you run it before staging, but once the marker is
committed both are silent (see the AGENTS.md gate-verdict rule for the `grep -c`
count-read-as-clean trap). Keep pre-work backup tags until merge — a lost commit is recoverable
only while the object survives.

**Do not begin a cascade you cannot finish and verify in one sitting.** A completed cascade and an
untouched stack are both safe states; a half-replayed chain is neither — branches sit at intermediate
SHAs, a conflicted rebase holds the tree, and the next session inherits a shape no document describes.
Before starting, confirm you can reach the end: every affected branch free of other worktrees, backup
tags taken, and enough remaining budget for the conflicts plus the remote link-by-link verification.
If any of that is missing, stop while the stack is still untouched — that is the cheap outcome. If you
are already mid-cascade and must stop, `git rebase --abort` and restore every branch from its backup
tag rather than leaving partial progress.

## Verify the chain on the REMOTE, link by link

"Each branch exists" and a correct-looking local chain prove nothing about remote topology. A
rejected `--force-with-lease` leaves the old SHA on the remote and does not announce itself to a
later session — one audited push table recorded a branch as force-pushed while the remote still
held a commit stacked on a branch deliberately rebased OUT of the line; merging that chain would
have landed another developer's parked WIP on `dev`. Exactly one link was broken, so spot-checks
passed.

Before any push of — or PR action on — a stacked chain:

```bash
git fetch --prune origin                          # REQUIRED: this is what updates origin/*
git merge-base --is-ancestor origin/<lower> origin/<upper>   # for EVERY adjacent pair
```

**`git ls-remote` is not a substitute for the fetch, and pairing the two is the trap.**
`ls-remote` queries the remote and PRINTS SHAs; it does not write `refs/remotes/origin/*`. So
the old form here — `ls-remote` followed by ancestry checks "using `origin/` refs" — read fresh
truth to the screen and then tested _stale local copies_, which is precisely the mistake this
section exists to catch. The stale chain passes, too: before someone else's cascade rewrote it,
the old chain was internally consistent, so every adjacent pair still answers "ancestor". Fetch
first, or compare against the OIDs `ls-remote` actually printed — never mix the two.

Re-verify after every force-push rather than trusting the push's own report. A `push --dry-run`
confirms the push would be _accepted_, not that the chain is _connected_.

**Ancestry is necessary and not sufficient — also assert remote SHA == local SHA, per branch.**
A rejected push leaves the old ref in place, and the _old_ chain is internally consistent, so every
adjacent pair still answers "ancestor" while three branches sit on the pre-sync base. Measured: a
stack sync reported success having stranded three branches, and the tell only surfaced when a PR
opened from one of them showed **19 commits / 100 files** for a change that was really
**1 commit / 9 files**, because head and base had diverged.

```bash
git rev-parse <branch> origin/<branch>     # the two SHAs must be identical, per branch
```

Stop at the first failing pair. Pushing a higher layer onto a broken link buries the break.

## Cascading a stack after fixes land at the bottom

**Switch to `--onto` at the first branch whose base needed a conflict resolution.** A plain
`git rebase <base>` relies on patch-id matching to skip commits already present upstream, which
holds only while the lower branch was rewritten _mechanically_. Resolving a conflict **changes the
patch**, so its patch-id no longer matches the copy the upper branch carries; git then replays the
lower branch's old commit on top of the new one and conflicts against your own resolution. Measured
on a 13-branch cascade: the first five rebased cleanly and the sixth blew up.

```bash
git rebase --onto <newbase> <old-base-tip> <branch>
```

**Derive `<old-base-tip>` from `git merge-base`, not from a pre-cascade tag, whenever a link was
already broken.** If an upper branch had forked from an older tip, the tag is not the true fork
point — using it replayed 16 commits where 4 were expected. `git merge-base <lower-tip> <upper-tip>`
(both pre-cascade) is the honest answer.

**Cheap proof that nothing duplicated:** `git rev-list --count <base>..<branch>` against its
pre-cascade count. An unchanged count is the check; a grown one is the alarm.

### A branch whose own tip is a merge commit must be MERGED, not rebased

`git rebase` does not preserve merge structure — it replays both sides of an existing merge commit
as one flat sequence, so content the merge already brought in gets replayed a second time out of
context. The symptom is a **false conflict** in which a later commit's entire diff appears to already
exist in "ours".

```bash
git log --format='%H %P' -1 <tip>    # two parents = the tip is a merge; do not plain-rebase
```

Use `git merge <new-upstream>` instead: a real 3-way merge against the true historical merge-base. It
resolves cleanly in this shape, and because the result's first parent is the branch's own unchanged
tip, it often pushes as a **fast-forward** rather than a force-push.

### Dropping exactly one isolated commit, without an interactive rebase

Pass the unwanted commit **itself** (not its parent) as the `<upstream>` argument — the replay
covers only commits strictly after it:

```bash
git rebase --onto <newbase> <the-unwanted-commit> <branch>
```

Confirm two things first, or this silently drops work: (a) nothing later depends on what the commit
introduced (`git grep` for its content across the full range), and (b) the very next commit still
applies with its original content (`git show --stat` after). Used to excise a redundant migration
merge-revision from a 14-branch scripted sync where `git rebase -i` was not an option.

### Separate FIXING from CASCADING into different sessions

Having each branch fix _and_ cascade across a 14-deep stack costs ~48 force-pushes, and every cascade
rewrites the branches the next session was briefed against — so each brief goes stale before it is
used. Fix-only sessions that commit but **never push**, followed by a single cascade session, cost
~13. Tell the fix sessions _why_ they must not push, or they will helpfully push.

## Collapsing a stack

Advancing a root PR's head branch past a child's head makes **GitHub automatically mark that direct
child as merged**. Deeper descendants stay open, because their own direct base branches have not
moved.

So after advancing the root:

1. Refresh **every** child's state immediately — do not assume the stack is unchanged.
2. Treat an auto-merged direct child as complete.
3. Close only the descendants that remain open; preserve their branches and discussions.
4. Guard the root update with an exact `--force-with-lease`.

## Base retargeting is a MANUAL step

GitHub's stacked-PR feature LOCKS base branches: `PATCH /pulls/{n}` returns 422 (`"Cannot change
the base branch because the pull request is part of a stack."`) and the GraphQL
`updatePullRequest` mutation silently no-ops (returns null, base unchanged). Closing the PR below
does NOT release the lock — only the web UI can change the base. When planning stack surgery,
write base retargeting into the hand-off as an explicit manual step. Symptom if skipped: the PR
shows a huge wrong diff (44 files instead of 1 in the observed case), because GitHub diffs
against a base that is no longer an ancestor — the branch content is fine, only the PR pointer is
stale. Related: a platform refusal message names a precondition, not a permanent verdict (AGENTS.md
rule) — e.g. a "branch was force-pushed or recreated" reopen-refusal clears once the branch is
force-pushed back to the exact commit the PR was closed at.

## Is it merged? Is it safe to delete?

After a stack is **rebased or squash-merged**, no single git check answers this — triangulate.
Deciding whether 21 branches and 26 backup tags from a replayed stack were safe to delete, all
three standard checks disagreed and each was wrong on its own:

- `git merge-base --is-ancestor` said **none** of the 21 were merged — the rebase changed every
  SHA. Trusting it alone means never deleting anything.
- `git cherry` (patch-id) got the bulk right but produced **5 false positives** where a different
  rebase base shifted hunk offsets and blob hashes.
- `git branch -d` refused 3 provably-safe branches, and its refusal carries its own exoneration
  one line **above** the error: `warning: not deleting branch '…' that is not yet merged to
'refs/remotes/origin/…', even though it is merged to HEAD`. That fires for every branch whose PR
  merged while its remote-tracking ref went stale, so reading only the `error:` line misclassifies
  it.

To prove a rebased branch is safe to delete: (1) `git cherry -v origin/dev <ref>` for the bulk
verdict; (2) for each `+` commit, find the same-subject commit on dev and diff the two patch
bodies — base drift shows up ONLY as blob hashes and `@@` offsets, real divergence shows as
content; (3) run `git branch -d` and read the whole message, not the error line; (4) for anything
the branch uniquely added, check file-level survival on the integration branch. Finish with
`git branch --list '<glob>'` — globbing after a hand-written delete list is a discovery step, and
it surfaced 5 sibling branches the list had missed.

**"Did this work land?" is a different question from "is this commit an ancestor?"** Under
squash-merge the same `--is-ancestor` false-negative misleads about _shipping_: three successive
passes read `git merge-base --is-ancestor <sha> origin/dev` → false and wrote "nothing is merged"
onto two boards, when all twelve stack PRs had merged hours earlier and the code was in `dev`. For
landing, the authoritative check is **content, not ancestry**: `git grep -l <symbol> origin/dev`.
Any history rewrite — rebase or squash — makes ancestry a different question from the one asked.

**A commit's own subject states its status at authoring time; its disposition lives in the commit
that landed it.** `wip(stalls): park … with handoff` reads as outstanding work, but dev's
One such commit opens "Splits <OID>" and adjudicates it piece by piece — two parts LANDED,
one deliberately NOT (review found it unsafe, so it was divided rather than taken or dropped
whole); 9 of the WIP's 10 files were already on dev. Nothing in the WIP commit could have said
this: its subject was written before the review existed. To decide whether commit X is outstanding,
search the LANDED history for a commit referencing it (`git log --grep=<short-sha>
<integration-branch>`) and read its body — never X's own subject. `wip`/`park`/`temp`/`hotfix` are
self-reported status, and self-reported status ages in exactly the direction that makes safe
cleanup look risky.

## Related

- `AGENTS.md` — branch and commit conventions.
- A stale PR's green CI check is not evidence its tests pass if the run predates the 2026-05 CI
  repair; see the project's installed testing-conventions skill.

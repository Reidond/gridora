# ADR 0086: Use truthful single-owner approval with mandatory automation

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0074, ADR 0075, and ADR 0084

## Situation

Gridora's public repository has one owner and no independent collaborator.
GitHub does not count a pull-request author's approval of their own change. The
initial release policy therefore made a release impossible while presenting an
independent-review control that the repository could not actually satisfy.

The owner explicitly chose to approve protected deployments personally. That
choice must not turn into a fabricated pull-request approval, a direct push to
`main`, an administrator bypass, a long-lived release token, or a reduction in
automated correctness and security evidence.

## Task

Define a release policy that one owner can execute truthfully while keeping the
release commit, signed Node image, simulated-provider evidence, tag, and
published assets immutable and mechanically verified.

## Execution

Keep pull requests mandatory on `main` and require zero approving reviews. Keep
required status checks strict and enforced for administrators. Keep linear
history and conversation resolution. Prohibit force pushes and branch deletion.

Keep the repository owner as the required reviewer for the `image-signing`,
`provider-image-smoke`, and `production-release` environments. Allow that owner
to approve a deployment they initiated because no second reviewer exists.
Disable administrator bypass so an explicit approval remains necessary.

Use GitHub's ephemeral per-job token for release evidence. Grant the evidence
job only Actions, Contents, and Pull Requests read permissions. Verify that the
remote semantic version tag resolves to the workflow commit, the commit remains
on `main`, and it is the exact merge result of a pull request into `main`.
Require successful CI and Security push workflows for that exact commit.
Require a protected artifact-bearing Node image workflow dispatch for the same
commit, with valid signing evidence, a non-expired artifact, and successful
simulated-provider smoke. Re-resolve the remote tag after the production
approval and immediately before publication.

Keep active version-tag update and deletion restrictions without bypass actors.
Read branch, tag, and environment controls through the administrator API before
tagging and record the non-secret result in the STE evidence. Do not grant the
workflow Administration or Environments access merely to re-attest controls
that GitHub enforces.

## Consequences

The owner can approve every protected deployment and publish without adding a
nominal collaborator. The repository retains an explicit human checkpoint for
signing, simulated provider smoke, and release publication. The release remains
blocked by exact-commit automated gates and protected tags.

There is no separation of duties for the human approval. This is an accepted
single-owner tradeoff, not an independent review. If another maintainer joins,
the project can restore one required pull-request approval and prevent
self-review without changing artifact or workflow evidence contracts.

## Verification

Run the release-workflow architecture test and complete repository CI. Read
back main branch protection and require zero approvals with strict checks and
administrator enforcement. Read all three protected environments and require
the owner reviewer, self-review allowed, and administrator bypass disabled.
Read tag ruleset 21286351 and require active update and deletion restrictions
without bypass actors. Merge the green pull request, approve the exact signed
image and simulated-provider jobs, create the protected semantic tag, approve
production publication, and verify the immutable release assets and signatures.

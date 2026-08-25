# ADR 0105: Simplify single-maintainer GitHub governance

- Status: Accepted
- Date: 2026-08-25
- Supersedes: ADR 0086 and the workflow-proliferation parts of ADR 0084

## Situation

Gridora has one maintainer. Five workflows produced duplicate pull-request and
push runs, a scheduled security run, Dependabot pull requests, CODEOWNERS review
requests, four required branch checks, and four environment gates that asked the
same maintainer to approve their own work. Those controls created review noise
without adding an independent decision maker.

The repository still needs fast feedback for ordinary changes and exact
artifact evidence for releases. Runtime tenant isolation, secret scoping,
bounded provider execution, image provenance, and release immutability are
product properties rather than code-review bureaucracy.

## Task

Make GitHub proportionate to a single-maintainer public repository. Keep one
routine result, remove self-review and automated security-review notifications,
and retain heavyweight artifact work only when the maintainer explicitly asks
for it.

## Execution

Keep `CI` as the only workflow triggered by pull requests and pushes to `main`.
It has one `verify` job that owns the repository checks, builds, Cloudflare
dry-runs, Docker boundary proof, and simulated Arma lifecycle.

Delete the separate Security and Provider contracts workflows. The provider
simulation remains in the normal test suite. Do not enable a paid-provider
mutation from CI. Delete CODEOWNERS and the weekly Dependabot configuration.
Disable GitHub secret scanning, push protection, and vulnerability-alert
notifications for this repository.

Make the Node image workflow manual-only and keep Release tag-only. A manual
image run validates, builds, signs, scans, and exercises the disposable Docker
VPS simulation without a second approval checkbox or environment review. A
release requires only exact-commit CI and signed image evidence; it no longer
requires a pull-request merge or a separate Security workflow.

Remove `main` branch protection so the owner can push directly or use a pull
request by choice. Keep the version-tag update and deletion ruleset because it
is silent during development and makes published release identities immutable.
Keep only the non-empty `image-signing` environment to scope its variables and
secrets, with an empty reviewer list and zero wait time. Remove the three empty
provider and release environments.

## Consequences

Ordinary work produces one GitHub Actions notification instead of overlapping
CI, Security, provider, and image results. The owner is never asked to approve
their own branch, image, provider simulation, or release deployment. Direct
pushes to `main` are permitted.

Repository-level dependency, secret, and code-security alerts are not an
automated review channel. Artifact-specific validation remains inside explicit
image and release runs, and runtime authorization and tenant-isolation tests
remain part of CI. A future multi-maintainer team can adopt a new ADR and add
review gates when there is an actual independent reviewer.

## Verification

Require exactly `ci.yml`, `image.yml`, and `release.yml`. Parse all three
workflows. Assert that only CI has pull-request or `main` push triggers, Node
image has only `workflow_dispatch`, and Release has only version-tag push.
Require the release verifier to depend on exact-commit CI and image evidence but
not Security or pull-request provenance. Run documentation integrity, the
focused workflow tests, and the complete repository gate.

After publication, read back GitHub Actions, branch protection, repository
security settings, tag rules, and all environment protection rules. Confirm one
routine workflow, no `main` protection, disabled security alerts, immutable
version tags, and only a reviewer-free `image-signing` environment.

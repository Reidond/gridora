# ADR 0075: Require artifact-bearing Node image release evidence

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0012, ADR 0045, and ADR 0057

## Situation

The Node image workflow runs validation on every `main` push. The protected
QCOW2 build runs only after an explicit manual dispatch. GitHub reports a
workflow as successful when validation succeeds and the protected build is
skipped. A release check that reads only the workflow conclusion can therefore
accept a commit that has no image artifact, signature, scan, provider boot, or
cleanup evidence.

## Task

Make release evidence distinguish template validation from a built and tested
image. Bind the evidence to the exact release commit. Keep provider cost and
cleanup controls explicit.

## Execution

Require a successful protected manual Node image run for the exact `main`
commit. Inspect its jobs. Require successful validation, `build-local`, and
`provider-image-smoke` jobs. Require the exact non-expired artifact name for the
workflow run and attempt. The build job must verify the image checksum, root
filesystem SBOM and scan, and cryptographic signature before upload. The
provider job must record boot and agent health and complete cleanup within the
approved lifetime.

Use one fail-closed evidence helper before release approval, again after the
`production-release` environment approval, and a final time in the publication
step immediately after its final remote-tag re-resolution and immediately
before `gh release create`. Each execution selects only a completed, successful
`workflow_dispatch` run on `main` for the exact tag SHA. It queries the named
jobs through the selected run-attempt endpoint, then requires the attempt-named
artifact to be nonexpired, positive in size, and bound by the GitHub API to that
same run, branch, and SHA. The release job receives only `actions: read` in
addition to its publication permissions for these rechecks.

Keep CI and Security push runs as separate exact-commit requirements. Do not
accept the validation-only Node image push run. Do not publish a version tag
when protected image or provider evidence is unavailable.

## Consequences

A source-only pre-alpha commit can pass normal CI without claiming an image
release. A production release is blocked until a protected KVM runner, signing
environment, provider credentials, approved cost lifetime, boot proof, and
cleanup proof exist. Release verification reads job and artifact evidence, not
only a workflow-level conclusion.

Approval does not freeze GitHub Actions artifacts. An artifact that expires,
is replaced by a rerun, or loses its run/SHA association while a release waits
for approval or while archive/signing work runs blocks publication rather than
relying on an earlier read.

## Verification

The release workflow parses as valid YAML and checks the exact commit, manual
event, branch, successful named jobs, run attempt, artifact name, expiry, and
nonzero artifact size before approval, after approval, and immediately before
publication. The workflow test requires no networked shell step between the
final evidence helper and release creation. The focused helper test rejects an
expired, zero-byte, wrong-attempt, wrong-SHA, or incomplete-job result. The
`provider-image-smoke` job is defined and fails
closed until a production import, boot, response-loss adoption, and cleanup
adapter exists. No successful protected provider run or artifact exists yet,
so release remains blocked. No image, provider resource, tag, or release was
created.

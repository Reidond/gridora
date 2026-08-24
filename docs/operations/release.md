# Release and rollback runbook

## Release evidence

1. Merge the release commit through an approved pull request into the protected
   `main` branch.
2. Require strict status checks, at least one approving review, and either stale
   review dismissal or approval of the last push on `main`.
3. Wait for successful `CI` and `Security` push workflows on the exact release
   commit.
4. Dispatch the protected Node image workflow from that exact `main` commit.
   Set `build_local_image=true`. Require successful validation, local image
   build, provider boot and cleanup evidence, and the exact non-expired image
   artifact. A validation-only push run is not release evidence.
5. Configure `production-release` with at least one required reviewer and
   prevent self-review.
6. Configure an active tag ruleset for `refs/tags/v*`, with no exclusions, that
   restricts both updates and deletions. Do not configure bypass actors.
7. Create a semantic version tag such as `v0.1.0` on that commit.
8. Push the tag.
9. Approve the `production-release` environment only after the evidence job
   passes.
10. Publish the signed archive for the exact tag commit.

Store a short-lived GitHub App installation token in the
`RELEASE_EVIDENCE_TOKEN` Actions secret before starting the release. The app
must be installed only on this repository and have read-only repository
permissions:

- Administration: read, for branch protection.
- Pull requests: read, for the final head approval.
- Environments: read, for environment protection.
- Contents: read, for commits, comparisons, and remote tag dereferencing.
- Metadata: read, for repository metadata and rulesets.

The workflow reads environment protection through GraphQL so the evidence app
does not need Actions permission. Workflow-run queries use the job's restricted
`GITHUB_TOKEN` instead.

Do not grant the evidence app a write permission. Installation tokens expire
after one hour. Refresh the secret and rerun the workflow if the token expires
while the release waits for approval.

The `/installation/repositories` check proves that the secret is an installation
token and can access only this repository. GitHub does not provide an endpoint
that introspects an already-minted installation token's permission levels; the
permission set is returned only when the token is minted. Configure the app with
only the permissions above and retain the non-secret minting response as release
evidence.

The release workflow fails closed when the tag is not on `main`, branch
protection does not require strict checks and an approving review, or any
required workflow is missing, incomplete, or unsuccessful. The tag commit must
be the merge result of an approved pull request, and the approving review must
target the pull request's final head commit. A pull-request, scheduled, manual,
or different-commit workflow run does not satisfy this gate. The workflow
dereferences the remote tag before building and again immediately before
publication.

GitHub's read-only ruleset API exposes active update and deletion restrictions,
but it deliberately omits `bypass_actors` unless the caller has ruleset write
access. The workflow therefore proves that the rules apply to the version tag,
but it cannot attest that the bypass list is empty. Keep the bypass list empty
and review that setting during release approval; granting write access to the
evidence app would weaken the evidence boundary.

## Control plane

1. Run `pnpm check`, `pnpm test`, and `pnpm build`.
2. Run the dependency and secret scans.
3. Run `wrangler deploy --dry-run` for each Worker.
4. Deploy to staging with a staging environment token.
5. Run the local and staging smoke suites.
6. Approve the protected production environment.
7. Deploy one immutable version.
8. Verify authentication, organization isolation, and one read-only API call.
9. Roll back with Wrangler version rollback when a gate fails.

## Node image

1. Build from a pinned Ubuntu source.
2. Generate a checksum and an SPDX SBOM.
3. Run a vulnerability scan.
4. Sign the artifact and provenance.
5. Run local image tests.
6. Build on the approved self-hosted KVM runner.
7. Set a hard expiry before a provider smoke test.
8. Create one disposable node only when `live_test` is true.
9. Destroy the node in an `always` cleanup step.
10. Record provider-region image IDs.
11. Promote only with the prior image ID in the manifest.

The checked-in workflows do not enable paid live tests by default.

# Release and rollback runbook

## Release evidence

1. Merge the release commit through a pull request into the protected `main`
   branch.
2. For the single-owner repository, require zero approving reviews while
   retaining strict status checks, administrator enforcement, linear history,
   conversation resolution, and prohibitions on force pushes and deletion.
3. Wait for successful `CI` and `Security` push workflows on the exact release
   commit.
4. Dispatch the protected Node image workflow from that exact `main` commit.
   Set `build_local_image=true`. Require successful validation, local image
   build, provider boot and cleanup evidence, and the exact non-expired image
   artifact. A validation-only push run is not release evidence.
5. Configure `image-signing`, `provider-image-smoke`, and `production-release`
   with the repository owner as a required reviewer. Allow that reviewer to
   approve their own deployment because there is no second collaborator.
   Disable administrator bypass.
6. Configure an active tag ruleset for `refs/tags/v*`, with no exclusions, that
   restricts both updates and deletions. Do not configure bypass actors.
7. Create a semantic version tag such as `v0.1.0` on that commit.
8. Push the tag.
9. Approve the `production-release` environment only after the evidence job
   passes.
10. Publish the signed archive for the exact tag commit.

The evidence job uses GitHub's ephemeral per-job token with only Actions,
Contents, and Pull Requests read permissions. Do not create or store a personal
access token or long-lived GitHub App token for release evidence.

The release workflow fails closed when the tag is not on `main`, the commit is
not the exact merge result of a pull request into `main`, or any required
workflow is missing, incomplete, or unsuccessful. A pull-request, scheduled,
manual, or different-commit workflow run does not satisfy the CI or Security
gate. The protected artifact-bearing Node image run is intentionally manual and
must target the exact release commit. The workflow dereferences the remote tag
before building and again immediately before publication.

Read back branch protection, version-tag rules, and environment protection with
an administrator credential before tagging. Record that non-secret evidence in
the STE release step. The release job does not grant its ephemeral token
Administration or Environments permissions merely to re-attest GitHub settings
that GitHub itself enforces.

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

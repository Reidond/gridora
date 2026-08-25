# Release and rollback runbook

## Release evidence

1. Push the release commit to `main`, directly or through a pull request.
2. Wait for the single `CI` workflow on the exact release commit. It is an
   advisory signal for the owner, not a branch-protection or review gate.
3. Dispatch the manual Node image workflow from that exact `main` commit.
   Set `build_local_image=true`. Require successful validation, local image
   build, provider boot and cleanup evidence, and the exact non-expired image
   artifact. The workflow starts when dispatched and does not wait for an
   environment reviewer.
4. Keep only `image-signing` as a scoped variable and secret boundary because
   it contains the signing inputs. Configure no required reviewers or wait
   timers. The smoke and release jobs need no environment.
5. Keep the active tag ruleset for `refs/tags/v*`, with no exclusions, that
   restricts both updates and deletions. Do not configure bypass actors.
6. Create and push a semantic version tag such as `v0.1.0` on that commit.
7. Let the tag-triggered release workflow verify the successful exact-commit
   CI and image evidence, then publish the signed archive.

The evidence job uses GitHub's ephemeral per-job token with only Actions and
Contents read permissions. Do not create or store a personal access token or
long-lived GitHub App token for release evidence.

The release workflow fails closed when the tag is not on `main` or exact-commit
CI or image evidence is missing, incomplete, or unsuccessful. A pull-request or
different-commit CI run does not satisfy the release gate. The artifact-bearing
Node image run is intentionally manual and must target the exact release
commit. The workflow dereferences the remote tag before building and again
immediately before publication.

Read back the version-tag rules and confirm that `image-signing` has no required
reviewer before tagging. Record that non-secret evidence in the STE release
step.

## Control plane

1. Run `pnpm check`, `pnpm test`, and `pnpm build`.
2. Run `wrangler deploy --dry-run` for each Worker.
3. Deploy to staging with a staging environment token.
4. Run the local and staging smoke suites.
5. Deploy one immutable version.
6. Verify authentication, organization isolation, and one read-only API call.
7. Roll back with Wrangler version rollback when a gate fails.

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

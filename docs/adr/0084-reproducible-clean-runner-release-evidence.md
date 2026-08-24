# ADR 0084: Make release evidence reproducible on clean Linux runners

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0074 and ADR 0075

## Situation

The first public GitHub Actions run exposed three differences between a warm
developer checkout and a clean Linux runner. Wrangler generated the Nuxt
Worker `mainModule` type only after the Nuxt output existed. The Terraform
provider lock contained a valid macOS package checksum but not the Linux AMD64
package checksum used by GitHub. The systemd validation container omitted
three image helpers and a stand-in `nftables.service` even though the built
image installs those helpers and that service.

These were release-evidence failures. Ignoring or rerunning them would not
prove that a clean clone can reproduce the committed configuration.

## Task

Make the same pinned build, binding, provider, and image checks pass from a
clean Linux runner without weakening a runtime boundary or performing a live
deployment.

## Execution

Build the workspace before checking generated Worker declarations. The Nuxt
build creates the exact module referenced by the committed web Worker type, so
Wrangler sees one deterministic module surface in local and GitHub checks.

Lock Cloudflare provider 5.23.0 for both Darwin ARM64 and Linux AMD64. Keep the
version constraint, signed provider archive hashes, and both platform package
hashes in the committed Terraform lockfile. Continue using read-only lockfile
initialization in validation and deployment workflows.

Make the image validation root reflect the image provisioner. Install the
committed agent-current, plugin-egress-network, and plugin-egress-lease helpers
at their production paths. Add no-op Docker and nftables unit definitions only
inside the disposable validation container. Then run `systemd-analyze verify`
against the committed services, sockets, and paths.

Use the successful check-run names from the published commit as the source of
truth for branch protection. Gate every workflow environment that can reach a
live provider, sign an image, run provider image smoke, or publish a production
release with a required reviewer. Protect version tags separately from the
main branch. Do not add credentials or invoke a deployment as part of this
decision.

## Consequences

A warm local build can no longer conceal a clean-runner type mismatch. A
platform-specific Terraform package cannot bypass the committed dependency
lock. Systemd verification covers every executable and service dependency
that the provisioned node image supplies.

The build occurs earlier in CI, and the lockfile carries two additional
platform hashes. Environment review and repository rules intentionally make
live releases require an explicit GitHub action after code verification.

## Verification

Reproduce the binding check after a complete workspace build. Initialize and
validate Terraform in the pinned Linux image with the committed read-only
lockfile. Run the cloud-init and systemd verification in the pinned Ubuntu
image. Publish the correction, require the exact successful GitHub check
contexts, and re-read branch, tag, and environment rules through the GitHub
API.

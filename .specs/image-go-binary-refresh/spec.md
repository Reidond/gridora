# Spec: Rebuild Traefik and cloudflared from current sources so the image scan passes

- Size: Medium (workflow build steps, manifest inputs, tests, ADR note, STE step)
- Runnable now: yes (local Linux amd64 cross-build and scan; no live run)
- STE step to add: Step 139 (main ends at 138; renumber if taken on rebase)
- ADR: cite ADR 0103. No new ADR.
- Branch: `spec/image-go-binary-refresh`

## Problem

See `tasks/BUG-image-go-module-vulnerabilities.md`.

## Facts gathered on 2026-09-24

- Traefik `v3.7.13` (released 2026-09-04) is annotated tag → commit
  `fc92cc118a0557a029c7019d5ee06665127b0f13`. Its `go.mod` already has
  `google.golang.org/grpc v1.83.2`, `golang.org/x/crypto v0.56.0`,
  `go.etcd.io/etcd/client/pkg/v3 v3.6.14`, `github.com/valyala/fasthttp v1.73.0`,
  `github.com/andybalholm/brotli v1.2.2`, `github.com/klauspost/compress v1.19.1`, and
  `go 1.26.0`. The Step 128 module patch (etcd, fasthttp, brotli) is therefore already
  upstream.
- cloudflared `2026.9.3` (released 2026-09-24) is annotated tag → commit
  `96d39adbc812dc7363834bda908970c1a2560a72`. Its `go.mod` has
  `google.golang.org/grpc v1.83.2` (indirect) but `golang.org/x/crypto v0.55.0`, which
  GO-2026-6354 and GO-2026-6355 flag as High until 0.56.0. There is no `vendor/` directory
  at that commit.
- The workflow builds both with Go `1.27.0`, verifies `go version -m` output, records the
  source commit, Go version, patch SHA-256 and binary digest into the identity and
  promotion manifests, and pins Syft 1.51.0 and Grype 0.117.0 with
  `--fail-on high --only-fixed` (`infra/scripts/scan-artifact.sh`).

## Requirements

- R1. Traefik: build from exact commit `fc92cc118a0557a029c7019d5ee06665127b0f13` with
  Go 1.27.0. If the unpatched upstream binary passes Grype at High with `--only-fixed`,
  ship it as version `v3.7.13`, delete the module-patch step, and remove
  `TRAEFIK_PATCH_SHA256` from the workflow, identity JSON, promotion manifest, and tests.
  If any High remains, apply the smallest fenced module diff (same SHA-256 fence
  mechanism as today) and name it `v3.7.13-gridora.1`. Keep the
  `go version -m` assertion for `go.etcd.io/etcd/client/pkg/v3 v3.6.14`.
- R2. cloudflared: build from exact commit `96d39adbc812dc7363834bda908970c1a2560a72`
  with Go 1.27.0, version string `2026.9.3`. Add a fenced module diff that runs
  `go get golang.org/x/crypto@v0.56.0 && go mod tidy` and fences the resulting
  `go.mod`/`go.sum` diff with a SHA-256 the workflow verifies before building (mirror the
  Traefik patch step). Assert `go version -m` shows `golang.org/x/crypto v0.56.0` and
  `google.golang.org/grpc v1.83.2`. Record `cloudflaredPatchSha256` in the identity and
  promotion manifests next to `cloudflaredSourceCommit`.
- R3. Local proof: cross-build both binaries for linux/amd64 (native Go 1.27.0 if
  installed, otherwise the `golang:1.27.0` container), then run pinned Syft 1.51.0 and
  Grype 0.117.0 on each binary with the repository's exact rule. Both must report zero
  High-or-Critical fixed findings. Record commands, digests, and results in the STE step.
  If a tool cannot run locally, say exactly which and why; do not claim a pass.
- R4. Update every assertion of the old values: `tests/image/image-assets.test.ts` (refs,
  patch SHA, versions), `tests/infrastructure/image-artifact-evidence.test.ts`
  (`Package: cloudflared` version), the `actions/checkout` `ref:` lines for both vendored
  sources, and the manifest `--arg` lines in `.github/workflows/image.yml`.
- R5. Add one sentence to ADR 0103 under Consequences: the Traefik and cloudflared source
  commits track upstream releases and are re-pinned whenever the scan gate finds a fixed
  High in them. Keep the ADR Accepted; do not rewrite it.
- R6. Do not suppress, waive, or lower the severity of any finding. Medium and Low
  findings stay visible in the scan log.

## Out of scope

- Changing the Grype rule, Docker package pins, phased-updates handling, or the SBOM
  cataloger configuration.
- Re-dispatching the protected image workflow (only runs on `main` after merge).

## Test requirements

- ShellCheck (pinned 0.9.0) on any changed script; `pnpm exec vitest run tests/image
tests/infrastructure/image-artifact-evidence.test.ts tests/architecture`; `pnpm check`,
  `pnpm test`, `pnpm build`.

## Deliverables

PR against `main` with the workflow changes, fenced cloudflared diff, test updates, ADR
note, STE Step 139, the bug task at `tasks/BUG-image-go-module-vulnerabilities.md` with
`Status: fixed-pending-image-run`, and this spec at `.specs/image-go-binary-refresh/spec.md`.

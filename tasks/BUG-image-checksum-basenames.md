# BUG: Downloaded image artifact fails checksum verification in the smoke job

- Status: fixed (protected image run 36062117204 succeeded on 2026-09-24)
- Found: 2026-09-24, protected image run 36056915150 (exact main `164d473`, `build_local_image=true`)
- Owner: unassigned
- Spec: `.specs/image-checksum-basenames/spec.md`

## Symptom

`build-local` produced, scanned, signed, and uploaded the first Node image artifact.
`provider-image-smoke` downloaded it, then failed "Verify the exact signed artifact
selected for smoke" with `sha256sum: dist/image-36056915150.1/...qcow2: No such file
or directory` and `FAILED open or read` for the image and the rootfs archive.

## Cause

The build job wrote the checksum file with `sha256sum "$IMAGE_PATH" ...`, so each line
carries the build job's relative path `dist/image-<run>.<attempt>/<file>`. The
artifact download places the files flat in a temporary directory, and
`infra/scripts/verify-artifact.sh` runs `sha256sum --check` from the repository root,
where those paths do not exist. The step had never run before because no earlier run
produced an artifact.

## Fix

Write basenames into the checksum file and verify it from its own directory, so the
same file checks out in the build job, the smoke job, and any later download.

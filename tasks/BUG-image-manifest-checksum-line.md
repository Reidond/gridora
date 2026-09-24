# BUG: Image promotion manifest step reads two checksum lines as one digest

- Status: fixed (protected image run 36062117204 succeeded on 2026-09-24)
- Found: 2026-09-24, protected image run 36052431439 (exact main `1ea272c`, `build_local_image=true`)
- Owner: unassigned
- Spec: `.specs/image-manifest-checksum-line/spec.md`

## Symptom

`build-local` passed image construction, rootfs evidence, package policy, SBOM, the
Grype gate, and Cosign signing for the first time, then failed step 28 "Create the image
promotion manifest" with exit code 1 and no message.

## Cause

Step 22 writes `sha256sum "$IMAGE_PATH" "$IMAGE_PATH.rootfs.tar" > "$IMAGE_PATH.sha256"`,
two lines. Step 28 ran `cut -d ' ' -f 1` over the whole file, so
`GRIDORA_IMAGE_SHA256` held two digests joined by a newline. The manifest script's
`^[a-f0-9]{64}$` check failed under `set -e` without printing which value was wrong.
The step had never executed in CI before because every earlier run stopped at an
earlier gate.

## Fix

Select the image's own checksum line by path, make the script name the malformed
coordinate on stderr, and add tests for both.

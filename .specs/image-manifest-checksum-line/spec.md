# Spec: Select the image checksum line for the promotion manifest

- Size: Small (one workflow step, one script, two tests, STE step)
- STE step: Step 140
- ADR: cite ADR 0065 (promotion evidence). No new ADR.
- Branch: `spec/image-manifest-checksum-line`

## Requirements

- R1. The "Create the image promotion manifest" step derives `image_sha` from the line
  of `$IMAGE_PATH.sha256` whose path equals `$IMAGE_PATH`, and fails with a message if
  that does not yield exactly one 64-hex digest.
- R2. `infra/images/create-image-promotion-manifest` reports the name of any missing or
  malformed coordinate on stderr before exiting 1.
- R3. Tests: the manifest test rejects a two-line `GRIDORA_IMAGE_SHA256` and asserts the
  named message; the image-assets test asserts the workflow selects by path and no
  longer cuts the whole file.
- R4. No change to what is hashed, signed, scanned, or uploaded.

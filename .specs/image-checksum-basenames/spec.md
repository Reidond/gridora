# Spec: Make the image checksum file portable across jobs

- Size: Small (one workflow step, one script, two tests, STE step)
- STE step: Step 141
- ADR: cite ADR 0065 (release evidence). No new ADR.
- Branch: `spec/image-checksum-basenames`

## Requirements

- R1. The build job writes `<image>.sha256` with basenames by running `sha256sum` inside
  the image directory. The promotion-manifest step selects the image line by basename.
- R2. `infra/scripts/verify-artifact.sh` runs `sha256sum --check` from the checksum
  file's directory, so verification succeeds from any working directory.
- R3. Tests: the evidence test writes a basename checksum fixture and runs the verifier
  from a different working directory; the image-assets test requires the basename write
  and forbids the path-based write.
- R4. No change to what is hashed, signed, scanned, or uploaded.

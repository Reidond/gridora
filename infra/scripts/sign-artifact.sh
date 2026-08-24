#!/usr/bin/env bash
set -euo pipefail

artifact=${1:?usage: sign-artifact.sh ARTIFACT}
command -v cosign >/dev/null || { echo "cosign is required" >&2; exit 2; }

# Keyless signing is allowed only in protected CI. Local callers must provide a
# key reference; this script never accepts key material as an argument.
if [[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" ]]; then
  cosign sign-blob --yes --bundle "${artifact}.sigstore.json" "${artifact}"
else
  test -n "${COSIGN_KEY_REF:-}" || { echo "set COSIGN_KEY_REF to a key URI" >&2; exit 2; }
  cosign sign-blob --key "${COSIGN_KEY_REF}" --bundle "${artifact}.sigstore.json" "${artifact}"
fi

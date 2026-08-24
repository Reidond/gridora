#!/usr/bin/env bash
set -euo pipefail

manifest=${1:?usage: promote-image.sh MANIFEST}
test "${GRIDORA_PROMOTION_APPROVED:-false}" = "true" || {
  echo "promotion refused: protected approval was not supplied" >&2
  exit 3
}
jq -e '
  .schemaVersion == 1 and
  (.image.version | type == "string") and
  (.image.sha256 | test("^[a-f0-9]{64}$")) and
  (.tests.image == "passed") and
  (.tests.security == "passed") and
  (.rollback.imageId | type == "string")
' "${manifest}" >/dev/null
echo "promotion manifest validated; provider registration is performed by the protected release job"

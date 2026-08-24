#!/usr/bin/env bash
set -euo pipefail

sbom=${1:?usage: scan-artifact.sh SBOM [GRYPE_COMMAND]}
grype_command=${2:-grype}
command -v "${grype_command}" >/dev/null || { echo "grype is required" >&2; exit 2; }
[[ -s "${sbom}" ]]
# Scan the policy-validated SBOM bound to the canonical rootfs evidence. This
# prevents Grype from silently recataloging the archive with a different set
# of synthetic packages.
"${grype_command}" "sbom:${sbom}" --fail-on high --only-fixed

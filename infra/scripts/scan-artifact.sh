#!/usr/bin/env bash
set -euo pipefail

rootfs_archive=${1:?usage: scan-artifact.sh ROOTFS_ARCHIVE [GRYPE_COMMAND]}
grype_command=${2:-grype}
command -v "${grype_command}" >/dev/null || { echo "grype is required" >&2; exit 2; }
[[ -s "${rootfs_archive}" ]]
# Scan the same canonical rootfs archive used for the SBOM, never the opaque
# QCOW2 container.
"${grype_command}" "${rootfs_archive}" --fail-on high --only-fixed

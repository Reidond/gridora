#!/usr/bin/env bash
set -euo pipefail

rootfs_archive=${1:?usage: generate-sbom.sh ROOTFS_ARCHIVE OUTPUT ROOTFS_EVIDENCE}
output=${2:?usage: generate-sbom.sh ROOTFS_ARCHIVE OUTPUT ROOTFS_EVIDENCE}
rootfs_evidence=${3:?usage: generate-sbom.sh ROOTFS_ARCHIVE OUTPUT ROOTFS_EVIDENCE}

command -v syft >/dev/null || { echo "syft is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
[[ -s "${rootfs_archive}" ]] || { echo 'rootfs archive is empty' >&2; exit 1; }
[[ -s "${rootfs_evidence}" ]] || { echo 'rootfs evidence is empty' >&2; exit 1; }
# Syft understands a filesystem tar archive. Do not point it at the QCOW2: a
# raw virtual disk can produce an empty, non-representative package catalogue.
syft "${rootfs_archive}" -o "spdx-json=${output}"
if ! jq -e '(.spdxVersion | startswith("SPDX-")) and (.packages | type == "array" and length > 0)' \
  "${output}" >/dev/null; then
  echo 'generated SPDX SBOM contains no packages' >&2
  exit 1
fi

rootfs_sha=$(sha256sum "${rootfs_archive}" | cut -d ' ' -f 1)
sbom_sha=$(sha256sum "${output}" | cut -d ' ' -f 1)
package_count=$(jq '.packages | length' "${output}")
work=$(mktemp "${rootfs_evidence}.XXXXXX")
trap 'rm -f "${work}"' EXIT
if ! jq -e \
  --arg rootfsArchive "$(basename "${rootfs_archive}")" \
  --arg rootfsArchiveSha256 "sha256:${rootfs_sha}" \
  --arg sbom "$(basename "${output}")" \
  --arg sbomSha256 "sha256:${sbom_sha}" \
  --argjson packageCount "${package_count}" '
  select(
    .schemaVersion == 1 and
    .rootfsArchive.name == $rootfsArchive and
    .rootfsArchive.sha256 == $rootfsArchiveSha256 and
    (.rootfsArchive.inventory.packageCount | type == "number" and . >= 1)
  ) | . + {sbom: {name: $sbom, sha256: $sbomSha256, packageCount: $packageCount}}
' "${rootfs_evidence}" >"${work}"; then
  echo 'generated SBOM does not match the rootfs evidence envelope' >&2
  exit 1
fi
mv "${work}" "${rootfs_evidence}"

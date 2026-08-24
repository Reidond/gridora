#!/usr/bin/env bash
set -euo pipefail

rootfs_archive=${1:?usage: generate-sbom.sh ROOTFS_ARCHIVE OUTPUT ROOTFS_EVIDENCE}
output=${2:?usage: generate-sbom.sh ROOTFS_ARCHIVE OUTPUT ROOTFS_EVIDENCE}
rootfs_evidence=${3:?usage: generate-sbom.sh ROOTFS_ARCHIVE OUTPUT ROOTFS_EVIDENCE}

command -v syft >/dev/null || { echo "syft is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
[[ -s "${rootfs_archive}" ]] || { echo 'rootfs archive is empty' >&2; exit 1; }
[[ -s "${rootfs_evidence}" ]] || { echo 'rootfs evidence is empty' >&2; exit 1; }
jq -e '
  .packagePolicy.schemaVersion == 1 and
  .packagePolicy.catalogerOverrides == [{
    name:"linux-kernel-cataloger",
    replacementEvidence:"ubuntu-dpkg-package-inventory"
  }] and
  (.packagePolicy.packages | type == "array" and length == 5 and
    all(.[]; (.managedGoBinaryPaths | type == "array" and length >= 1)))
' "${rootfs_evidence}" >/dev/null || {
  echo 'rootfs package policy is missing or invalid' >&2
  exit 1
}
# Syft understands a filesystem tar archive. Do not point it at the QCOW2: a
# raw virtual disk can produce an empty, non-representative package catalogue.
work_dir=$(mktemp -d)
evidence_work=''
cleanup() {
  rm -rf "${work_dir}"
  if [[ -n "${evidence_work}" ]]; then
    rm -f "${evidence_work}"
  fi
}
trap cleanup EXIT
raw_output="${work_dir}/rootfs.spdx.json"
syft "${rootfs_archive}" --select-catalogers=-linux-kernel-cataloger \
  -o "spdx-json=${raw_output}"
# Docker's signed Debian packages are the authoritative version and ownership
# evidence for their stripped Go binaries. Syft records stale embedded module
# strings for those files (for example, Docker 29 can advertise module v28).
# Remove only Go-module facts whose exact source path is proven in the package
# policy. The five Debian packages remain in the SBOM and the Grype input.
jq --slurpfile evidence "${rootfs_evidence}" '
  ($evidence[0].packagePolicy.packages |
    map(.managedGoBinaryPaths[]) | map(ltrimstr("/"))) as $managedPaths |
  [.packages[] |
    select((.sourceInfo // "") | startswith("acquired package info from go module information: ")) |
    select(((.sourceInfo | sub("^acquired package info from go module information: "; "") |
      ltrimstr("./") | ltrimstr("/")) as $path | $managedPaths | index($path) != null)) |
    .SPDXID] as $removedIds |
  .packages |= map(select(.SPDXID as $id | $removedIds | index($id) == null)) |
  .relationships |= map(select(
    (.spdxElementId as $id | $removedIds | index($id) == null) and
    (.relatedSpdxElement as $id | $removedIds | index($id) == null)
  ))
' "${raw_output}" >"${output}"
if ! jq -e '(.spdxVersion | startswith("SPDX-")) and (.packages | type == "array" and length > 0)' \
  "${output}" >/dev/null; then
  echo 'generated SPDX SBOM contains no packages' >&2
  exit 1
fi
if ! jq -e --slurpfile evidence "${rootfs_evidence}" '
  . as $document |
  ($evidence[0].packagePolicy.packages |
    map(.managedGoBinaryPaths[]) | map(ltrimstr("/"))) as $managedPaths |
  ($evidence[0].packagePolicy.packages |
    all(.[]; . as $policy |
      any($document.packages[]; .name == $policy.name and .versionInfo == $policy.version))) and
  ($document.packages | all(.[];
    .name != "linux-kernel" and
    ((((.sourceInfo // "") |
      startswith("acquired package info from go module information: ")) | not) or
      ((.sourceInfo | sub("^acquired package info from go module information: "; "") |
        ltrimstr("./") | ltrimstr("/")) as $path |
        ($managedPaths | index($path) == null))))
  )
' "${output}" >/dev/null; then
  echo 'generated SBOM does not preserve the verified package policy' >&2
  exit 1
fi

rootfs_sha=$(sha256sum "${rootfs_archive}" | cut -d ' ' -f 1)
sbom_sha=$(sha256sum "${output}" | cut -d ' ' -f 1)
package_count=$(jq '.packages | length' "${output}")
evidence_work=$(mktemp "${rootfs_evidence}.XXXXXX")
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
' "${rootfs_evidence}" >"${evidence_work}"; then
  echo 'generated SBOM does not match the rootfs evidence envelope' >&2
  exit 1
fi
mv "${evidence_work}" "${rootfs_evidence}"
evidence_work=''

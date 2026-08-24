#!/usr/bin/env bash
set -euo pipefail

artifact=${1:?usage: extract-rootfs-evidence.sh ARTIFACT ROOTFS_ARCHIVE EVIDENCE}
rootfs_archive=${2:?usage: extract-rootfs-evidence.sh ARTIFACT ROOTFS_ARCHIVE EVIDENCE}
evidence=${3:?usage: extract-rootfs-evidence.sh ARTIFACT ROOTFS_ARCHIVE EVIDENCE}

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 2; }
tar_command=${GRIDORA_TAR_COMMAND:-tar}
virt_tar_out=${GRIDORA_VIRT_TAR_OUT:-virt-tar-out}
command -v "${tar_command}" >/dev/null || { echo "tar is required" >&2; exit 2; }
command -v "${virt_tar_out}" >/dev/null || { echo "virt-tar-out is required" >&2; exit 2; }

[[ -f "${artifact}" && -s "${artifact}" ]]
umask 077
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT
archive_listing="${work}/rootfs.list"
status_file="${work}/dpkg-status"

# libguestfs discovers the guest root read-only and writes a filesystem archive.
# Scanning the QCOW2 itself can silently catalogue no guest packages; this archive
# is the exact rootfs evidence that is subsequently scanned and checksummed.
"${virt_tar_out}" --format=qcow2 -a "${artifact}" / "${rootfs_archive}"
[[ -s "${rootfs_archive}" ]]
"${tar_command}" -tf "${rootfs_archive}" >"${archive_listing}"
[[ -s "${archive_listing}" ]]
if awk 'index($0, "/") == 1 || $0 ~ "(^|/)[.][.]($|/)" { exit 1 }' "${archive_listing}"; then
  :
else
  echo "rootfs archive contains an unsafe path" >&2
  exit 1
fi
status_path_count=$(awk '$0 ~ "(^|/)var/lib/dpkg/status$" { count += 1 } END { print count + 0 }' "${archive_listing}")
[[ "${status_path_count}" == 1 ]]
status_path=$(awk '$0 ~ "(^|/)var/lib/dpkg/status$" { print; exit }' "${archive_listing}")
[[ -n "${status_path}" ]]
# Stream only the package database. Extracting an otherwise valid guest rootfs
# as an unprivileged runner would try to recreate device nodes such as /dev/null.
"${tar_command}" --extract --to-stdout --file "${rootfs_archive}" -- "${status_path}" >"${status_file}"
[[ -s "${status_file}" ]]
package_count=$(awk '/^Package: / { count += 1 } END { print count + 0 }' "${status_file}")
[[ "${package_count}" =~ ^[1-9][0-9]*$ ]]

artifact_sha=$(sha256sum "${artifact}" | cut -d ' ' -f 1)
rootfs_sha=$(sha256sum "${rootfs_archive}" | cut -d ' ' -f 1)
jq -n \
  --arg artifact "$(basename "${artifact}")" \
  --arg artifactSha256 "sha256:${artifact_sha}" \
  --arg rootfsArchive "$(basename "${rootfs_archive}")" \
  --arg rootfsArchiveSha256 "sha256:${rootfs_sha}" \
  --argjson packageCount "${package_count}" '
  {
    schemaVersion: 1,
    artifact: {name: $artifact, sha256: $artifactSha256},
    rootfsArchive: {
      name: $rootfsArchive,
      sha256: $rootfsArchiveSha256,
      inventory: {format: "dpkg-status", packageCount: $packageCount}
    }
  }' >"${evidence}"

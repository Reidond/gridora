#!/usr/bin/env bash
set -euo pipefail

rootfs_archive=${1:?usage: validate-rootfs-package-policy.sh ROOTFS_ARCHIVE ROOTFS_EVIDENCE}
rootfs_evidence=${2:?usage: validate-rootfs-package-policy.sh ROOTFS_ARCHIVE ROOTFS_EVIDENCE}

tar_command=${GRIDORA_TAR_COMMAND:-tar}
gpg_command=${GRIDORA_GPG_COMMAND:-gpg}
command -v "${tar_command}" >/dev/null || { echo 'tar is required' >&2; exit 2; }
command -v "${gpg_command}" >/dev/null || { echo 'gpg is required' >&2; exit 2; }
command -v jq >/dev/null || { echo 'jq is required' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 2; }
[[ -s "${rootfs_archive}" ]]
[[ -s "${rootfs_evidence}" ]]

readonly docker_repository_key_fingerprint='9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
readonly docker_ce_version='5:29.7.2-1~ubuntu.24.04~noble'
readonly docker_ce_cli_version='5:29.7.2-1~ubuntu.24.04~noble'
readonly containerd_io_version='2.3.3-1~ubuntu.24.04~noble'
readonly docker_buildx_version='0.36.1-1~ubuntu.24.04~noble'
readonly docker_compose_version='5.5.0-1~ubuntu.24.04~noble'

umask 077
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT
archive_listing="${work}/rootfs.list"
status_file="${work}/dpkg-status"
key_file="${work}/docker.asc"
source_file="${work}/docker.sources"
"${tar_command}" -tf "${rootfs_archive}" >"${archive_listing}"

archive_member() {
  local pattern=${1:?archive member pattern is required}
  local label=${2:?archive member label is required}
  local matches
  local count
  matches=$(awk -v pattern="${pattern}" '$0 ~ pattern { print }' "${archive_listing}")
  count=$(awk 'NF { count += 1 } END { print count + 0 }' <<<"${matches}")
  if [[ "${count}" != 1 ]]; then
    printf 'rootfs archive must contain exactly one %s; found %s\n' "${label}" "${count}" >&2
    exit 1
  fi
  printf '%s\n' "${matches}"
}

stream_member() {
  local pattern=${1:?archive member pattern is required}
  local label=${2:?archive member label is required}
  local output=${3:?archive member output is required}
  local member
  member=$(archive_member "${pattern}" "${label}")
  "${tar_command}" --extract --to-stdout --file "${rootfs_archive}" -- "${member}" >"${output}"
  [[ -s "${output}" ]] || { printf '%s is empty\n' "${label}" >&2; exit 1; }
}

stream_member '^([.]/)?var/lib/dpkg/status$' 'root dpkg status file' "${status_file}"
stream_member '^([.]/)?etc/apt/keyrings/docker[.]asc$' 'Docker repository key' "${key_file}"
stream_member '^([.]/)?etc/apt/sources[.]list[.]d/docker[.]sources$' \
  'Docker repository source' "${source_file}"

expected_source=$(printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/ubuntu' \
  'Suites: noble' \
  'Components: stable' \
  'Signed-By: /etc/apt/keyrings/docker.asc')
test "$(sed -e 's/[[:space:]]*$//' "${source_file}")" = "${expected_source}"

install -d -m 0700 "${work}/gnupg"
docker_repository_fingerprint=$(GNUPGHOME="${work}/gnupg" "${gpg_command}" \
  --batch --no-options --with-colons --import-options show-only --import "${key_file}" 2>/dev/null |
  awk -F: '$1 == "fpr" { print $10; exit }')
test "${docker_repository_fingerprint}" = "${docker_repository_key_fingerprint}"

package_version() {
  local package=${1:?package name is required}
  awk -v RS='' -v package="${package}" '
    {
      found_package = ""
      found_version = ""
      line_count = split($0, lines, "\n")
      for (line_number = 1; line_number <= line_count; line_number += 1) {
        if (lines[line_number] == "Package: " package) found_package = package
        if (lines[line_number] ~ /^Version: /) found_version = substr(lines[line_number], 10)
      }
      if (found_package == package) {
        count += 1
        version = found_version
      }
    }
    END {
      if (count != 1 || version == "") exit 1
      print version
    }
  ' "${status_file}"
}

validate_package() {
  local package=${1:?package name is required}
  local expected_version=${2:?expected package version is required}
  shift 2
  local list_file="${work}/${package}.list"
  local path
  stream_member "^([.]/)?var/lib/dpkg/info/${package//./[.]}[.]list$" \
    "${package} ownership list" "${list_file}"
  test "$(package_version "${package}")" = "${expected_version}"
  for path in "$@"; do
    grep -Fx -- "${path}" "${list_file}" >/dev/null || {
      printf '%s does not own required path %s\n' "${package}" "${path}" >&2
      exit 1
    }
  done
}

validate_package containerd.io "${containerd_io_version}" \
  /usr/bin/containerd /usr/bin/containerd-shim-runc-v2 /usr/bin/ctr /usr/bin/runc
validate_package docker-ce "${docker_ce_version}" /usr/bin/docker-proxy /usr/bin/dockerd
validate_package docker-ce-cli "${docker_ce_cli_version}" /usr/bin/docker
validate_package docker-buildx-plugin "${docker_buildx_version}" \
  /usr/libexec/docker/cli-plugins/docker-buildx
validate_package docker-compose-plugin "${docker_compose_version}" \
  /usr/libexec/docker/cli-plugins/docker-compose

rootfs_sha=$(sha256sum "${rootfs_archive}" | cut -d ' ' -f 1)
jq -e --arg rootfsSha256 "sha256:${rootfs_sha}" '
  .schemaVersion == 1 and .rootfsArchive.sha256 == $rootfsSha256 and
  .rootfsArchive.inventory.format == "dpkg-status"
' "${rootfs_evidence}" >/dev/null

updated_evidence="${work}/rootfs-evidence.json"
jq \
  --arg fingerprint "${docker_repository_key_fingerprint}" \
  --arg dockerCe "${docker_ce_version}" \
  --arg dockerCeCli "${docker_ce_cli_version}" \
  --arg containerd "${containerd_io_version}" \
  --arg buildx "${docker_buildx_version}" \
  --arg compose "${docker_compose_version}" '
  . + {
    packagePolicy: {
      schemaVersion: 1,
      distribution: "ubuntu:24.04",
      repository: {
        uri: "https://download.docker.com/linux/ubuntu",
        suite: "noble",
        keyFingerprint: $fingerprint
      },
      packages: [
        {name:"containerd.io", version:$containerd,
          managedGoBinaryPaths:["/usr/bin/containerd","/usr/bin/containerd-shim-runc-v2","/usr/bin/ctr","/usr/bin/runc"]},
        {name:"docker-ce", version:$dockerCe,
          managedGoBinaryPaths:["/usr/bin/docker-proxy","/usr/bin/dockerd"]},
        {name:"docker-ce-cli", version:$dockerCeCli,
          managedGoBinaryPaths:["/usr/bin/docker"]},
        {name:"docker-buildx-plugin", version:$buildx,
          managedGoBinaryPaths:["/usr/libexec/docker/cli-plugins/docker-buildx"]},
        {name:"docker-compose-plugin", version:$compose,
          managedGoBinaryPaths:["/usr/libexec/docker/cli-plugins/docker-compose"]}
      ],
      catalogerOverrides: [{
        name: "linux-kernel-cataloger",
        replacementEvidence: "ubuntu-dpkg-package-inventory"
      }]
    }
  }
' "${rootfs_evidence}" >"${updated_evidence}"
mv "${updated_evidence}" "${rootfs_evidence}"

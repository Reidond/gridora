#!/usr/bin/env bash
set -euo pipefail

# Fail when an exact Docker package pin in provision.sh is behind the newest
# version in Docker's noble/stable index. The image build requires both the
# exact pins and zero pending upgrades (ADR 0103), so a stale pin otherwise
# fails only after the protected QCOW2 build has run for several minutes.
#
# Usage: check-docker-pins.sh [PACKAGES_INDEX]
# Without an argument, the script downloads the amd64 index over HTTPS. This is
# an early drift signal only; APT still verifies the signed repository during
# the image build.

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
pin_source=${GRIDORA_DOCKER_PIN_SOURCE:-"${script_dir}/../packer/scripts/provision.sh"}
curl_command=${GRIDORA_CURL_COMMAND:-curl}
readonly index_url='https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages'

[[ $# -le 1 ]] || { echo 'usage: check-docker-pins.sh [PACKAGES_INDEX]' >&2; exit 2; }
[[ -r "${pin_source}" ]] || { printf 'Docker pin source %s is not readable\n' "${pin_source}" >&2; exit 2; }

umask 077
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT
index="${work}/Packages"

if [[ $# -eq 1 ]]; then
  [[ -r "$1" ]] || { printf 'Docker package index %s is not readable\n' "$1" >&2; exit 2; }
  cp -- "$1" "${index}"
else
  command -v "${curl_command}" >/dev/null || { echo 'curl is required' >&2; exit 2; }
  "${curl_command}" --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
    --output "${index}" "${index_url}" || {
    printf 'could not download the Docker package index from %s\n' "${index_url}" >&2
    exit 1
  }
fi
grep -q '^Package: ' "${index}" || { echo 'Docker package index contains no packages' >&2; exit 1; }

pinned_version() {
  local variable=${1:?pin variable is required}
  local values
  local count
  values=$(sed -n "s/^readonly ${variable}='\\([^']*\\)'\$/\\1/p" "${pin_source}")
  count=$(awk 'NF { count += 1 } END { print count + 0 }' <<<"${values}")
  if [[ "${count}" != 1 ]]; then
    printf '%s must define exactly one %s pin; found %s\n' "${pin_source}" "${variable}" "${count}" >&2
    exit 2
  fi
  printf '%s\n' "${values}"
}

# Prints "missing", "unpublished NEWEST", "behind NEWEST", or "current".
# Versions compare with the Debian policy algorithm (epoch, upstream version,
# Debian revision; "~" sorts before everything, digit runs compare numerically).
index_state() {
  local package=${1:?package name is required}
  local pinned=${2:?pinned version is required}
  awk -v RS='' -v package="${package}" -v pinned="${pinned}" '
    function order(character) {
      if (character == "~") return -1
      if (character == "" || character ~ /[0-9]/) return 0
      if (character ~ /[A-Za-z]/) return code[character]
      return code[character] + 256
    }
    function compare_part(left, right,    left_order, right_order, left_digits, right_digits) {
      while (left != "" || right != "") {
        while ((left != "" && substr(left, 1, 1) !~ /[0-9]/) ||
               (right != "" && substr(right, 1, 1) !~ /[0-9]/)) {
          left_order = order(substr(left, 1, 1))
          right_order = order(substr(right, 1, 1))
          if (left_order != right_order) return left_order < right_order ? -1 : 1
          left = substr(left, 2)
          right = substr(right, 2)
        }
        while (substr(left, 1, 1) == "0") left = substr(left, 2)
        while (substr(right, 1, 1) == "0") right = substr(right, 2)
        left_digits = ""
        while (left != "" && substr(left, 1, 1) ~ /[0-9]/) {
          left_digits = left_digits substr(left, 1, 1)
          left = substr(left, 2)
        }
        right_digits = ""
        while (right != "" && substr(right, 1, 1) ~ /[0-9]/) {
          right_digits = right_digits substr(right, 1, 1)
          right = substr(right, 2)
        }
        if (length(left_digits) != length(right_digits)) {
          return length(left_digits) < length(right_digits) ? -1 : 1
        }
        # Equal-length digit strings compare lexically in numeric order.
        if (left_digits != right_digits) return left_digits < right_digits ? -1 : 1
      }
      return 0
    }
    function split_version(version, parts,    separator) {
      parts["epoch"] = 0
      separator = index(version, ":")
      if (separator > 0) {
        parts["epoch"] = substr(version, 1, separator - 1) + 0
        version = substr(version, separator + 1)
      }
      parts["revision"] = ""
      if (match(version, /-[^-]*$/)) {
        parts["revision"] = substr(version, RSTART + 1)
        version = substr(version, 1, RSTART - 1)
      }
      parts["upstream"] = version
    }
    function compare_versions(left, right,    left_parts, right_parts, result) {
      split_version(left, left_parts)
      split_version(right, right_parts)
      if (left_parts["epoch"] != right_parts["epoch"]) {
        return left_parts["epoch"] < right_parts["epoch"] ? -1 : 1
      }
      result = compare_part(left_parts["upstream"], right_parts["upstream"])
      if (result != 0) return result
      return compare_part(left_parts["revision"], right_parts["revision"])
    }
    BEGIN {
      for (value = 1; value < 256; value += 1) code[sprintf("%c", value)] = value
    }
    {
      found_package = ""
      found_version = ""
      line_count = split($0, lines, "\n")
      for (line_number = 1; line_number <= line_count; line_number += 1) {
        if (lines[line_number] == "Package: " package) found_package = package
        if (lines[line_number] ~ /^Version: /) found_version = substr(lines[line_number], 10)
      }
      if (found_package != package || found_version == "") next
      count += 1
      if (found_version == pinned) published = 1
      if (newest == "" || compare_versions(found_version, newest) > 0) newest = found_version
    }
    END {
      if (count == 0) print "missing"
      else if (!published) print "unpublished " newest
      else if (compare_versions(newest, pinned) > 0) print "behind " newest
      else print "current"
    }
  ' "${index}"
}

failed=0
check_pin() {
  local package=${1:?package name is required}
  local variable=${2:?pin variable is required}
  local pinned
  local state
  pinned=$(pinned_version "${variable}")
  state=$(index_state "${package}" "${pinned}")
  case "${state}" in
    current)
      printf '%s %s is the newest published version\n' "${package}" "${pinned}"
      ;;
    missing)
      printf '%s is not in the Docker package index\n' "${package}" >&2
      failed=1
      ;;
    unpublished\ *)
      printf '%s pin %s is not in the Docker package index; newest is %s\n' \
        "${package}" "${pinned}" "${state#unpublished }" >&2
      failed=1
      ;;
    behind\ *)
      printf '%s pin %s is behind the newest published version %s\n' \
        "${package}" "${pinned}" "${state#behind }" >&2
      failed=1
      ;;
    *)
      printf 'could not compare %s pin %s\n' "${package}" "${pinned}" >&2
      failed=1
      ;;
  esac
}

check_pin containerd.io containerd_io_version
check_pin docker-ce docker_ce_version
check_pin docker-ce-cli docker_ce_cli_version
check_pin docker-buildx-plugin docker_buildx_version
check_pin docker-compose-plugin docker_compose_version

if [[ "${failed}" != 0 ]]; then
  echo 'Update the exact Docker pins in infra/packer/scripts/provision.sh and infra/scripts/validate-rootfs-package-policy.sh.' >&2
  exit 1
fi

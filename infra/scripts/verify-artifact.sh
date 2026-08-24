#!/usr/bin/env bash
set -euo pipefail

artifact=${1:?usage: verify-artifact.sh ARTIFACT CHECKSUMS SBOM ROOTFS_ARCHIVE ROOTFS_EVIDENCE}
checksums=${2:?usage: verify-artifact.sh ARTIFACT CHECKSUMS SBOM ROOTFS_ARCHIVE ROOTFS_EVIDENCE}
sbom=${3:?usage: verify-artifact.sh ARTIFACT CHECKSUMS SBOM ROOTFS_ARCHIVE ROOTFS_EVIDENCE}
rootfs_archive=${4:?usage: verify-artifact.sh ARTIFACT CHECKSUMS SBOM ROOTFS_ARCHIVE ROOTFS_EVIDENCE}
rootfs_evidence=${5:?usage: verify-artifact.sh ARTIFACT CHECKSUMS SBOM ROOTFS_ARCHIVE ROOTFS_EVIDENCE}

command -v cosign >/dev/null || { echo "cosign is required" >&2; exit 2; }
sha256sum --check "${checksums}"
test -s "${sbom}"
test -s "${rootfs_archive}"
test -s "${rootfs_evidence}"
test -s "${artifact}.sigstore.json"
jq -e '(.spdxVersion | startswith("SPDX-")) and (.packages | type == "array" and length > 0)' \
  "${sbom}" >/dev/null

artifact_sha=$(sha256sum "${artifact}" | cut -d ' ' -f 1)
rootfs_sha=$(sha256sum "${rootfs_archive}" | cut -d ' ' -f 1)
sbom_sha=$(sha256sum "${sbom}" | cut -d ' ' -f 1)
package_count=$(jq '.packages | length' "${sbom}")
jq -e \
  --arg artifact "$(basename "${artifact}")" \
  --arg artifactSha256 "sha256:${artifact_sha}" \
  --arg rootfsArchive "$(basename "${rootfs_archive}")" \
  --arg rootfsArchiveSha256 "sha256:${rootfs_sha}" \
  --arg sbom "$(basename "${sbom}")" \
  --arg sbomSha256 "sha256:${sbom_sha}" \
  --argjson packageCount "${package_count}" '
  .schemaVersion == 1 and
  .artifact == {name: $artifact, sha256: $artifactSha256} and
  .rootfsArchive.name == $rootfsArchive and
  .rootfsArchive.sha256 == $rootfsArchiveSha256 and
  .rootfsArchive.inventory.format == "dpkg-status" and
  (.rootfsArchive.inventory.packageCount | type == "number" and . >= 1) and
  .packagePolicy.schemaVersion == 1 and
  .packagePolicy.distribution == "ubuntu:24.04" and
  .packagePolicy.repository == {
    uri:"https://download.docker.com/linux/ubuntu",
    suite:"noble",
    keyFingerprint:"9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
  } and
  [.packagePolicy.packages[].name] == [
    "containerd.io","docker-ce","docker-ce-cli","docker-buildx-plugin","docker-compose-plugin"
  ] and
  ([.packagePolicy.packages[].managedGoBinaryPaths[]] | length) == 9 and
  .packagePolicy.catalogerOverrides == [{
    name:"linux-kernel-cataloger",
    replacementEvidence:"ubuntu-dpkg-package-inventory"
  }] and
  .sbom == {name: $sbom, sha256: $sbomSha256, packageCount: $packageCount}
' "${rootfs_evidence}" >/dev/null

# A bundle being present is not evidence.  Verify its cryptographic signature
# against the protected GitHub Actions identity, or an explicitly supplied
# public verification key for a non-CI, review-only invocation.
if [[ -n "${COSIGN_PUBLIC_KEY_REF:-}" ]]; then
  cosign verify-blob --key "${COSIGN_PUBLIC_KEY_REF}" --bundle "${artifact}.sigstore.json" "${artifact}"
else
  [[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" ]]
  [[ "${GITHUB_REF:-}" == "refs/heads/main" ]]
  [[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
  cosign verify-blob \
    --certificate-identity "https://github.com/${GITHUB_REPOSITORY}/.github/workflows/image.yml@${GITHUB_REF}" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --bundle "${artifact}.sigstore.json" \
    "${artifact}"
fi

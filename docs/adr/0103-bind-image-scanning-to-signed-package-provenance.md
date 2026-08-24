# ADR 0103: Bind image scanning to signed package provenance

- Status: Accepted
- Date: 2026-08-25
- Extends: ADR 0102

## Situation

Owner-approved exact-main run 32779717636 built and validated the Ubuntu QCOW2,
extracted its root filesystem, generated the SBOM, and ran Grype. The scan then
failed on fixed High findings. This was the first protected run to reach the
real vulnerability policy.

The evidence had three different meanings. The Ubuntu kernel cataloger created
a generic `linux-kernel` package from the version string even though Ubuntu
ships and fixes the kernel through signed Debian packages. Ubuntu's Docker
packages were not current. The current official Docker 29.7.2 Debian packages
contain stripped Go binaries whose embedded module strings can be older than
the package, including a Docker 29 binary that reports module version 28.5.2.
Cloudflare's current cloudflared 2026.8.2 release binary was built with an older
Go standard library.

No artifact from the failed run was signed, uploaded, accepted by provider
smoke, or admitted to a release.

Replacement run 32786521368 then failed before Docker installation because the
minimal Ubuntu guest did not have a GnuPG home directory. GnuPG exited before
it inspected the downloaded repository key. This run also produced no image
artifact.

Replacement run 32788506869 passed image construction, QCOW2 integrity,
root-filesystem extraction, package-policy validation, and SBOM generation.
The unchanged Grype gate then found Go 1.22.2, `golang.org/x/crypto` 0.23.0,
and related module evidence. A clean Ubuntu 24.04 reproduction mapped every
matching fact to binaries owned by `snapd` 2.76.3+ubuntu24.04. Gridora does not
use Snap for Docker, cloudflared, Traefik, the node runtime, the agent, or game
workloads.

## Task

Keep the High-or-Critical fixed-vulnerability gate. Give the scanner one
authoritative, reproducible inventory for Ubuntu packages, current signed
Docker packages, and binaries built outside the Ubuntu archive.

## Execution

Upgrade the Ubuntu guest completely before installing runtime packages. Install
exact Docker 29.7.2, containerd 2.3.3, Buildx 0.36.1, and Compose 5.5.0 packages
from Docker's HTTPS Ubuntu repository. Verify the repository key fingerprint,
the Noble source definition, every installed package version, and the absence
of pending upgrades.

Inspect the repository key in a dedicated mode-0700 temporary GnuPG home.
Delete that directory after the fingerprint matches. Do not depend on a user
keyring in the minimal image, and do not import the Docker key into a persistent
user keyring.

Purge `snapd` after the complete Ubuntu upgrade and required base-package
installation. Prove that its package record, client, and daemon are absent.
Do not run `apt autoremove`: systemd, AppArmor, udev, and SSH packages that the
node still needs can be marked automatic on the installation media. This is an
image-minimization decision, not a scanner waiver.

Build cloudflared 2026.8.2 from exact source commit
`733bfb939963e150dcf5c4faddb1603f744fbc98`. Use its vendored dependency tree
and Go 1.27.0. Record the resulting binary digest, source commit, and Go version
in build evidence.

Pin Syft 1.51.0 and Grype 0.117.0. Before SBOM generation, read the guest's
Docker repository key, source definition, Debian package database, and package
ownership lists directly from the canonical rootfs archive. Add the verified
policy to rootfs evidence.

Do not use Syft's generic Linux-kernel cataloger. Ubuntu Debian package records
remain in the SBOM and Grype input. Remove embedded Go-module facts only when
the policy proves that one of the five exact Docker packages owns the exact
binary path. Preserve the owning Debian packages. Scan the policy-validated
SPDX document so Grype cannot silently create a different synthetic inventory.

## Consequences

The release does not suppress vulnerability identifiers or lower the severity
threshold. Kernel fixes are evaluated through Ubuntu package versions. Docker
runtime versions and ownership are proven through the signed Docker repository
and guest package database. The nine scoped Docker binaries do not produce
false matches from stale embedded module strings, but their five owning Debian
packages remain visible. cloudflared is built with a non-vulnerable current Go
toolchain from immutable reviewed source.
The unused Snap daemon and its embedded stale Go-module inventory are absent
from the node image, reducing both attack surface and false package identity.

Changing a repository key, source, package version, owned path, cataloger
override, cloudflared source commit, or Go version fails before signing. The
package policy is included in rootfs evidence and therefore in promotion
evidence.

## Verification

Require Bash parsing, ShellCheck, workflow parsing, focused rootfs policy,
SBOM, scan, image, and documentation tests, Packer formatting and validation,
the complete repository gate, pull-request CI and Security, then a replacement
owner-approved exact-main image run. The final proof must also include Cosign
signing, artifact upload, and separately approved simulated-provider smoke.
The GnuPG correction must also pass in a clean Ubuntu 24.04 container and prove
that the temporary keyring is absent after verification.
The Snap correction must reproduce the exact module-to-binary ownership map,
prove that a purge removes only `snapd`, retain systemd, AppArmor, udev, and SSH,
and yield no Snap-owned Go facts before the next protected build.

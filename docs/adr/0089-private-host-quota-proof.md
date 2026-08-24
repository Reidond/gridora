# ADR 0089: Prove project quotas in a private host mount namespace

- Status: Accepted
- Date: 2026-08-24
- Supersedes: The project-quota container boundary in ADR 0088
- Extends: ADR 0027, ADR 0029, ADR 0084, and ADR 0088

## Situation

Pull request 9 allocated an explicit loop device inside GitHub's privileged
validation container, but the host kernel rejected the subsequent ext4 mount
with `mount(2) system call failed: No such process`. The firewall proof passed
in that same container. The quota failure therefore belongs to the nested mount
boundary, not device discovery or Gridora's quota policy.

The Ubuntu 24.04 GitHub-hosted runner is an ephemeral virtual machine. It can
exercise its own loop, ext4, project-quota, and mount kernel paths directly.
That proof still must not leak a mount or disposable filesystem into later
steps, and it must run before merge and again before protected signing.

## Task

Move only the project-quota integration proof from the privileged validation
container to the ephemeral Ubuntu host. Isolate all mounts in a private mount
namespace, preserve deterministic userspace dependencies, and retain exact
cleanup and fail-closed assertions.

## Execution

Install Ubuntu's `quota` package on the ephemeral runner. Invoke the proof as
root through `unshare --mount --propagation private`. Create its image and mount
directory below a unique `mktemp -d` root. Attach the image with
`losetup --find --show`, mount the returned device with `nodev`, `nosuid`, and
`prjquota`, write and read back project ID 1000000000 with a one-megabyte hard
limit, and require an unprivileged four-megabyte write to fail.

On every exit, unmount the private mount, detach only the selected loop device,
remove only loop nodes the proof created, and remove only the validated
temporary root. Keep the Docker/nftables integration proof in the pinned
privileged validation image because that test intentionally needs nested Docker
network topology. Run both boundaries in public pull-request validation and
repeat them on the protected build runner before signing inputs are consumed.

## Consequences

The quota proof now exercises the GitHub-hosted Linux VM's real filesystem and
quota kernel boundary instead of a nested-container mount path the host refuses.
Its mount is invisible outside the private namespace, and its loop device and
temporary files are removed. Installing one named Ubuntu package mutates only
the disposable runner and does not introduce a repository secret or external
resource.

The pinned validation image remains the source of shell tooling and static
checks but no longer claims that arbitrary privileged containers can mount loop
filesystems on every hosted kernel. A green pull request is required before the
same proof can reach the owner-approved image build.

## Verification

Require Bash syntax and ShellCheck for the script. Require the asset test to
assert private host mount namespaces in both workflow jobs, named quota tooling,
unique temporary-root cleanup, explicit loop attachment, and the absence of a
containerized quota execution. Require GitHub's Ubuntu 24.04 `validate` job to
enforce the exact project ID and hard limit and observe `Disk quota exceeded`
before pull request 9 may merge. Repeat the proof in the protected build on the
exact merged commit.

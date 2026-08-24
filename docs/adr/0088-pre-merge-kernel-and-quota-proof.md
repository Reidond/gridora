# ADR 0088: Run explicit quota and firewall proofs before merge

- Status: Superseded
- Date: 2026-08-24
- Supersedes: The protected-build-only kernel-preflight placement in ADR 0084
- Extends: ADR 0027, ADR 0065, and ADR 0087
- Superseded by: ADR 0089 for the project-quota execution boundary

## Situation

After ADR 0087 corrected the firewall topology, the next owner-approved image
run passed the native Linux firewall proof. The following project-quota proof
failed before image construction because `mount -o loop` could not discover a
loop device inside the hosted privileged container. The container had the
required userspace tools and privileges, but its `/dev` population differed
from the local Docker environment.

Both kernel proofs are deterministic and need no signing key, provider
credential, or production resource. Running them only after merge and protected
environment approval delayed useful Linux evidence and caused avoidable release
iterations.

## Task

Make loop-backed ext4 quota setup deterministic inside the disposable
privileged boundary. Require both non-secret kernel proofs on pull requests and
repeat them before the protected artifact build consumes signing inputs.

## Execution

Create `/dev/loop-control` with the standard character-device major and minor
only when it is absent. Create loop block-device nodes 0 through 63 only when
absent. Attach the preallocated ext4 image explicitly with
`losetup --find --show`, mount that returned device with `nodev`, `nosuid`, and
`prjquota`, enforce and read back the project limit, and require an unprivileged
write above the hard limit to fail. On every exit, unmount and detach only the
device allocated by the proof.

After building the pinned validation tool image, run the firewall and quota
scripts as UID and GID zero in separate disposable privileged containers in the
`validate` job. This job runs for pull requests, main pushes, and manual image
dispatches and receives no repository or environment secrets. Keep the same two
steps in `build-local` after owner approval, before installing signing tools or
reading protected signing inputs.

## Consequences

The required `validate` context now carries native hosted-Linux firewall and
quota evidence before merge. The protected build still repeats that evidence,
so the signing boundary does not rely on a previous runner. A missing device
node no longer changes the meaning of the quota test, and cleanup does not
detach a foreign loop device.

Pull-request validation takes longer and intentionally uses privileged
containers on an ephemeral GitHub-hosted runner. It does not mount the host
Docker socket, run a game container, access a secret, or mutate an external
resource.

## Verification

Run Bash syntax and ShellCheck for the quota script. Run it through the pinned
validation image as root in one disposable privileged container. Require the
loop-backed ext4 filesystem to report the exact project ID and one-megabyte hard
limit, reject a four-megabyte write, unmount, and detach. Require the image asset
test to assert explicit loop allocation, both executable workflow proofs, and
both static script checks. Publish the change through a pull request and require
GitHub's native Linux `validate` job to execute both kernel proofs successfully
before merge.

Pull request 9 disproved the quota-container assumption: explicit loop-device
attachment succeeded, but the host kernel still rejected the mount from inside
the privileged container with `mount(2) system call failed: No such process`.
ADR 0089 retains the pre-merge proof requirement and moves only the quota proof
to an isolated host mount namespace.

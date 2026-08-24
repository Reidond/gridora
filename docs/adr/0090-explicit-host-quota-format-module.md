# ADR 0090: Load the host quota format before the filesystem proof

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0027, ADR 0029, ADR 0089

## Situation

Pull request 9 run 32743694394 executed the project-quota script directly on the
GitHub-hosted Ubuntu 24.04 virtual machine in a private mount namespace. Loop
attachment succeeded, but mounting the ext4 filesystem still returned
`mount(2) system call failed: No such process`.

Linux uses `ESRCH`, rendered as `No such process`, when a filesystem enables
version-2 quota metadata but the `quota_v2` format module is not active. This
matches the observed boundary: the same filesystem and script pass against a
local Linux host whose quota modules are already loaded.

## Task

Declare and verify the hosted kernel's quota-format dependency before the
project-quota proof. Do not treat module presence as quota-enforcement evidence.

## Execution

Run `modprobe quota_v2` as root immediately before each host-isolated quota
proof. Require `/sys/module/quota_v2` to exist after the command. Repeat this in
the public `validate` job and protected `build-local` job so neither runner
inherits an unstated module-loading assumption.

Continue into the private mount namespace only after that assertion. The proof
must still create the quota-enabled ext4 filesystem, attach and mount it with
`prjquota`, assign project ID 1000000000, set and read back the one-megabyte hard
limit, and reject an unprivileged four-megabyte write. Those behavioral checks,
not module presence, decide success.

## Consequences

The hosted runner now reports a missing module directly instead of surfacing an
ambiguous ext4 `ESRCH`. Loading a stock kernel module mutates only the ephemeral
runner and consumes no credential or external resource. The module can remain
loaded for the runner's lifetime because the private filesystem mount, loop
device, and files are still removed by the proof.

The actual node image continues to prove quota enforcement during its build and
smoke paths. This decision does not substitute configuration inspection for a
write-boundary test and does not weaken fail-closed deployment behavior.

## Verification

Require the image-asset contract test to find exactly two module loads, two
sysfs presence assertions, and two host mount-namespace executions. Require the
focused tests and complete repository gate to pass. Require pull request 9's
Ubuntu 24.04 `validate` job to mount the filesystem and observe `Disk quota
exceeded` before merge.

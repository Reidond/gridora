# ADR 0091: Install the matching runner quota module package

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0089 and ADR 0090

## Situation

Pull request 9 run 32744210002 made the quota format dependency explicit, then
failed with `Module quota_v2 not found in directory
/lib/modules/6.17.0-1022-azure`. GitHub's Ubuntu 24.04 runner uses an Azure kernel
whose base module package omits this optional quota format module.

The package cannot be pinned to one observed kernel release because GitHub
updates hosted runner kernels. Ubuntu publishes optional modules in the package
whose version is the exact `uname -r` of the running kernel.

## Task

Install the stock optional-module package matching the ephemeral runner kernel
before loading `quota_v2`. Keep all subsequent behavioral gates unchanged.

## Execution

Run `apt-get update`, then install `quota` and
`linux-modules-extra-$(uname -r)` with `--no-install-recommends` in public
validation. Include the same matching-kernel package with the protected build's
existing read-only guest extraction tools. Only then run `modprobe quota_v2`,
assert `/sys/module/quota_v2`, and enter the private mount namespace.

Do not accept package installation or module presence as completion. The proof
must still mount the generated quota-enabled ext4 filesystem, write and read
back project ID 1000000000 and its one-megabyte hard limit, and observe the
unprivileged oversized write fail with `Disk quota exceeded`.

## Consequences

The workflow follows GitHub's rolling Ubuntu Azure kernel without hard-coding a
stale release. It downloads a signed Ubuntu package onto an ephemeral runner
and does not change the repository, production, provider, or Cloudflare state.
The protected runner repeats the dependency installation rather than trusting
the pull-request machine.

This adds package-download time to image validation. A missing repository
package, module-load error, filesystem-mount error, quota mismatch, or permitted
oversized write all remain hard failures before merge and signing.

## Verification

Require the image-asset contract test to find exactly two matching-kernel
package expressions, two module loads, two sysfs assertions, and two private
mount-namespace proofs. Require focused and full local gates, then require pull
request 9's Ubuntu 24.04 `validate` job to observe real project-quota enforcement
before merge.

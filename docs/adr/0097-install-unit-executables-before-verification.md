# ADR 0097: Install unit executables before systemd verification

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0096

## Situation

Owner-approved exact-main run 32764415965 proved the explicitly scoped signed
agent-update manifest boundary from ADR 0096: the guest accepted the manifest
and advanced through immutable state installation to systemd unit validation.

`systemd-analyze verify` then rejected `gridora-plugin-egress-network.service`
and `gridora-plugin-egress-lease@.service`. Both units reference fixed helpers
under `/usr/local/libexec/gridora`, but the provisioner invoked the verifier
before installing those helpers. The units and helpers had already passed the
containerized validation lane because that lane installs all referenced
executables before verification. The real image order did not preserve that
precondition.

## Task

Make the real guest's systemd verification evaluate the same complete
filesystem contract as required at runtime.

## Execution

Install every fixed helper referenced by the selected agent, update, and plugin
egress units before invoking `systemd-analyze verify`. Keep unit installation,
helper modes, paths, contents, and the strict verifier set unchanged.

Add an image contract test that requires both plugin-egress helper installation
commands to precede systemd verification.

## Consequences

The verifier no longer rejects valid units because their immutable executables
are absent at verification time. A missing, non-executable, or incompatible
helper still fails the build. No service is started and no privilege boundary
is weakened by this ordering change.

Run 32764415965 remains diagnostic evidence only; it did not produce an image
artifact or provider smoke result.

## Verification

Require Bash parsing, ShellCheck, focused image and documentation tests, Packer
formatting and validation, the complete repository gate, pull-request CI and
Security, and a new owner-approved exact-main image run. Release evidence still
requires offline QCOW2 inspection, supply-chain scanning and signing, artifact
upload, and the separately protected simulated provider smoke.

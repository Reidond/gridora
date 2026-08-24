# ADR 0096: Scope agent-update manifest validation explicitly

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0095

## Situation

Owner-approved exact-main image run 32759392984 passed validation, Ubuntu
autoinstall, SSH, the private upload boundary, package and Docker installation,
and every pinned artifact checksum. It then failed in an otherwise silent guest
assertion before immutable configuration was installed.

Diagnostic run 32761299089 added line-specific failure reporting and identified
the rejected command as the monolithic `jq` assertion for the signed baseline
agent-update manifest. Protected diagnostic run 32762605028 reported only safe
manifest metadata: the exact top-level, source, and compatibility keys; the
expected API and architecture; valid numeric sequence and epoch; a valid
timestamp; an 88-character base64 signature; an exact agent checksum; an HTTPS
source; and the required compatibility values. The manifest was valid, but the
guest assertion combined nested object pipes with unparenthesized boolean
expressions, leaving evaluation scope dependent on `jq` operator precedence.

## Task

Make the signed manifest acceptance boundary deterministic in the real Ubuntu
guest and make future provisioner failures identify their exact command without
printing secret material.

## Execution

Keep the strict allowlist and all existing value constraints. Express every
type, equality, range, and regular-expression assertion independently. Enter
the `source` and `compatibility` objects through explicitly parenthesized pipes,
and evaluate their fields only inside those scopes. Rename the top-level key
allowlist variable so it cannot be confused with `jq`'s `keys` builtin.

Install a shell `ERR` trap that reports the failed provisioner line, exit code,
and command. The provisioner receives checksums and public verification inputs,
not private signing keys, so this diagnostic does not widen secret exposure.

## Consequences

Valid signed baseline manifests have one unambiguous evaluation path in the
Ubuntu image. Unknown fields, wrong types, non-integral counters, checksum
mismatches, oversized artifacts, non-HTTPS sources, invalid signatures, and
incompatible API versions still fail closed. Future protected failures produce
actionable line evidence instead of an undifferentiated exit status.

The diagnostic branch condition and safe-shape reporting step are not part of
the release change. Runs 32761299089 and 32762605028 are diagnostic evidence,
not image or release evidence.

## Verification

Require Bash parsing, ShellCheck, the focused image and documentation tests,
Packer formatting and validation, the complete repository gate, pull-request
CI and Security, and a new owner-approved exact-main image run. Accept a release
only after the replacement run completes image inspection, supply-chain
scanning and signing, artifact upload, and the separately protected simulated
provider smoke.

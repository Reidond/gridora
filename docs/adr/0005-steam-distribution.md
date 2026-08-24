# ADR 0005: Steam binary distribution policy

- Status: Accepted
- Date: 2026-08-23

## Context

Game publishers control binary distribution. Gridora must respect those terms.

## Decision

Generic images and Gridora OCI images contain no game binaries. SteamCMD installs
the publisher-provided dedicated server on an assigned node. Anonymous login is
the MVP default; credentialed installs remain disabled until a reviewed secret and
Steam Guard procedure exists.

## Consequences

Backups exclude redistributable binaries and restore by reinstalling the pinned
app revision. Each plugin documents publisher and mod terms.

## Alternatives

We rejected central game archives. They can violate redistribution terms.
We postponed credentialed Steam. Its secret and Guard flow needs separate review.

## Verification

Scan image contents. Run a clean SteamCMD install. Review each plugin license note.

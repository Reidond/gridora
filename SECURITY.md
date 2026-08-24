# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability. Use GitHub private vulnerability
reporting for this repository. Include the affected version, impact, and a small
reproduction. Do not include real provider, Tunnel, Steam, machine, backup, or
RCON secrets.

Maintainers will acknowledge a valid report within three business days. They will
give status updates at least every seven business days until resolution.

## Supported versions

Gridora is pre-release. Only the current `main` branch receives security fixes.

## Security baseline

The project requires organization isolation, scoped credentials, signed images,
SBOMs, dependency and image scans, default-deny node firewalls, and no Docker
socket in a game container. See `docs/threat-model/README.md`.

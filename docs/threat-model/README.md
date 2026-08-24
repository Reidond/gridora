# Gridora threat model

## Scope

This model covers the Cloudflare control plane, the node agent, provider APIs,
game containers, backups, plugins, and operator workflows. Cloudflare, hosting
providers, Steam, game publishers, and the OCI registry are external systems.

## Assets

- Organization data and membership are confidential.
- Provider and Cloudflare credentials can create paid resources.
- Node credentials can control game workloads.
- Backup keys protect customer data.
- Audit records support incident review.
- Build provenance protects the software supply chain.

## Trust boundaries

1. An Access identity enters the public API boundary.
2. An API request enters an organization service boundary.
3. A Workflow enters a provider API boundary.
4. A signed command enters a node through Tunnel and Access.
5. The agent enters the Docker control boundary.
6. A game container enters the public player network.
7. A backup enters R2 after client-side encryption.

## Threats and controls

| Threat                   | Required control                                            | Verification                   |
| ------------------------ | ----------------------------------------------------------- | ------------------------------ |
| Forged identity token    | Verify issuer, audience, signature, expiry, and intent      | forged JWT tests               |
| Cross-organization IDOR  | Load membership and scope each repository query             | isolation matrix tests         |
| Invitation replay        | Store a one-way token digest and consume once               | replay and race tests          |
| Provider create replay   | Discover by operation metadata before retry                 | provider contract tests        |
| SSRF through a mod URL   | Allow HTTPS hosts and block private or reserved targets     | SSRF corpus                    |
| Path traversal           | Resolve under an organization and server root               | traversal corpus               |
| Command injection        | Use typed commands and fixed arguments                      | metacharacter corpus           |
| Docker host takeover     | Give the Docker socket only to the agent                    | image and container inspection |
| Stolen bootstrap token   | Bind it to node and provider instance; expire and revoke it | replay test                    |
| Secret disclosure        | Redact at every log and operation boundary                  | canary secret scan             |
| Malicious plugin         | Use a reviewed build-time registry and capability manifest  | plugin conformance tests       |
| Backup theft             | Encrypt before upload and wrap a per-backup key             | restore and key-rotation tests |
| Supply-chain replacement | Pin digests, create an SBOM, sign, and verify               | release workflow               |
| Public management access | Use outbound Tunnel and default-deny nftables               | image network test             |

## Residual risks

The agent controls Docker and has high impact on one node. A provider credential
can create cost. A public game port can receive denial-of-service traffic. The
operator must use scoped credentials, quotas, alerts, and fast revocation.

## Review triggers

Review this model after a new provider, plugin capability, identity flow, secret
store, or third-party plugin model. Review it after each security incident.

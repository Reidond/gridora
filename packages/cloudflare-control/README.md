# Cloudflare control API boundary

Contract assumptions verified on 2026-08-23 against Cloudflare's official [DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/) and [Access Applications API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications).

- DNS reconciliation lists by exact type and name, then uses the record ID returned by Cloudflare for overwrite or deletion.
- Gridora adopts only records whose comment exactly matches its organization and owner resource marker. A colliding human-owned record is preserved and reported as a conflict.
- Player A/AAAA records are always DNS-only (`proxied: false`).
- Self-hosted Access application creation sends `type`, `name`, and `domain`; Cloudflare generates the audience tag (`aud`) and returns it in the application response.
- The tunnel create API does not expose writable metadata. Gridora therefore stores the organization and owner resource in a canonical tunnel name, fetches the tunnel by its Cloudflare-returned ID before deletion, and requires the exact ownership name before it will delete.
- Tunnel and Access application creation list before creating, adopt a single exact canonical ownership match, and fail closed on ambiguous or foreign matches. Access applications use the exact protected domain plus canonical ownership name and `self_hosted` type as the adoption identity.

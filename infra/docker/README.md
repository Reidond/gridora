# Docker runtime assets

Gridora runs Traefik as one host systemd service. It does not also run a Traefik
container. The agent writes Traefik file-provider configuration.

`game-service.example.yaml` is the default profile. Its Docker network has no
external route. A plugin must declare each required network host and port.

`game-service-egress.example.yaml` is a permissioned profile. The agent can use
it only after schema validation. The agent resolves an approved host. The agent
rejects private and reserved addresses. The agent adds the result to an nftables
egress set. Each set item includes the server network interface, IP, protocol, and
port. One plugin cannot use another plugin's lease. The agent applies a short lease.
The agent refreshes DNS under policy.
The agent removes the lease after the operation. A raw URL or IP from user config
does not grant network access.

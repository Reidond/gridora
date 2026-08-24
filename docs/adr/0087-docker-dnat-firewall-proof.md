# ADR 0087: Test the node firewall through Docker host DNAT

- Status: Accepted
- Date: 2026-08-24
- Extends: ADR 0023, ADR 0065, ADR 0084, and ADR 0085

## Situation

The first owner-approved artifact-bearing Node image run passed the image
validation job but failed before image construction. Its privileged firewall
probe put the allowed service, denied service, and probe container on one Linux
bridge and connected directly to each service's bridge address. The unleased
service remained reachable.

Linux can switch same-bridge peers at layer 2 without traversing an inet forward
hook. The result was accurate for that topology but did not represent Gridora's
production ingress path. Every game server has its own Docker bridge and exposes
reviewed ports through Docker host port bindings. The host firewall governs the
forwarded packet after Docker DNAT.

## Task

Make the privileged KVM proof exercise the exact host ingress boundary without
disabling Docker's networking, adding a broad accept rule, or treating a local
same-bridge artifact as a production firewall defect.

## Execution

Create one target bridge for the two service containers and a different source
bridge for the probe. Publish TCP ports 2302 and 2303 on the nested Docker host.
Resolve the source bridge's host gateway and send probes to the published host
ports from the source bridge. The path enters Docker's host DNAT and then the
Gridora inet forward hook before reaching the target bridge.

Add only port 2302 to `leased_tcp_ports`. Require 2302 to return the exact
expected response and require 2303 to time out. Reload only the Gridora nftables
table, restore the exact lease, verify Docker's chains still exist, and require
2302 to remain reachable. Keep the root, privileged, disposable-container
boundary for this kernel proof.

## Consequences

The check now proves leased and unleased published ingress on native Linux and
Docker Desktop without depending on bridge-netfilter behavior for peer traffic.
It continues to fail if Docker DNAT disappears, the Gridora forward policy is
not loaded, an unleased published port is accepted, a leased port is rejected,
or a Gridora table reload destroys Docker's chains.

The proof does not claim that two arbitrary peers on one Docker bridge are
filtered by the host inet chain. Gridora creates one non-attachable bridge per
server, so that topology is not the game-server ingress boundary.

## Verification

Build the pinned validation tool image and run
`validate-firewall-docker-networking.sh` as UID and GID zero in a disposable
privileged container. Observe the leased response, the expected unleased
timeout, and the successful post-reload leased response. Run the image asset
test, repository checks, protected pull-request checks, and the owner-approved
artifact-bearing image workflow on the exact merged main commit.

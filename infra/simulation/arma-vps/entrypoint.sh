#!/bin/sh
set -eu

dockerd \
  --host=unix:///var/run/docker.sock \
  --storage-driver=vfs \
  --iptables=true \
  >/tmp/gridora-simulated-vps-dockerd.log 2>&1 &
dockerd_pid=$!

cleanup() {
  kill "$dockerd_pid" 2>/dev/null || true
  wait "$dockerd_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    tail -n 200 /tmp/gridora-simulated-vps-dockerd.log >&2
    exit 1
  fi
  sleep 1
done

# Load the same host-owned default-deny forwarding table as the node image.
# Docker's DNAT exposes container ports to this chain, so both host and
# container port numbers are leased for this deliberately non-identical test
# mapping. The fake game does not need any outbound lease.
nft -f /opt/gridora/infra/images/nftables/gridora.nft
nft add element inet gridora leased_udp_ports '{ 2001, 17777, 31777, 32001 }'
install -d -m 0755 /run/gridora-simulated-vps
nft list table inet gridora > /run/gridora-simulated-vps/firewall.rules
chmod 0444 /run/gridora-simulated-vps/firewall.rules

docker build \
  --file /opt/gridora/infra/simulation/arma-vps/fake-game/Dockerfile \
  --tag gridora-simulated-arma:acceptance \
  /opt/gridora/infra/simulation/arma-vps/fake-game

plugin_image=$(docker image inspect gridora-simulated-arma:acceptance --format '{{.Id}}')
case "$plugin_image" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo 'simulated Arma image did not resolve to a sha256 Docker image ID' >&2
    exit 1
    ;;
esac

docker network create \
  --label dev.gridora.network=plugin-egress \
  --label dev.gridora.network-policy=gridora-plugin-egress-v1 \
  --opt com.docker.network.bridge.name=gridora-egress0 \
  gridora-plugin-egress >/dev/null

server_root=/var/lib/gridora/servers/server-acceptance
install -d -o root -g 10001 -m 0750 "$server_root"
for child in game config data mods staging backups state; do
  install -d -o 10001 -g 10001 -m 0770 "$server_root/$child"
done
chmod 2770 "$server_root/staging"

chown root:10001 /var/run/docker.sock
chmod 0660 /var/run/docker.sock

export GRIDORA_SIMULATED_ARMA_IMAGE="$plugin_image"
setpriv --reuid=10001 --regid=10001 --clear-groups \
  /opt/gridora/node_modules/.bin/vitest run \
  --configLoader runner \
  tests/infrastructure/simulated-arma-vps.test.ts

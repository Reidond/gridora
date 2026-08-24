#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'The firewall integration proof requires root.' >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly root
readonly probe_image='busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662'

dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs --iptables=true --ip-masq=true \
  >/tmp/gridora-dockerd.log 2>&1 &
readonly dockerd_pid=$!

cleanup() {
  kill "$dockerd_pid" 2>/dev/null || true
  wait "$dockerd_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _attempt in {1..45}; do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  cat /tmp/gridora-dockerd.log >&2
  exit 1
fi

docker pull "$probe_image" >/dev/null
docker network create gridora-firewall-target >/dev/null
docker network create gridora-firewall-source >/dev/null
source_gateway="$(docker network inspect \
  -f '{{(index .IPAM.Config 0).Gateway}}' gridora-firewall-source)"
readonly source_gateway
docker run -d --name gridora-firewall-allowed --network gridora-firewall-target \
  --publish 2302:2302 "$probe_image" \
  sh -c 'mkdir /www; printf ok >/www/index.html; exec httpd -f -p 2302 -h /www' >/dev/null
docker run -d --name gridora-firewall-denied --network gridora-firewall-target \
  --publish 2303:2303 "$probe_image" \
  sh -c 'mkdir /www; printf denied >/www/index.html; exec httpd -f -p 2303 -h /www' >/dev/null
sleep 1

ruleset="$(nft list ruleset)"
grep -Eq 'chain DOCKER|chain docker-forward' <<<"$ruleset"
nft -f "$root/infra/images/nftables/gridora.nft"
nft add element inet gridora leased_tcp_ports '{ 2302 }'
# Probe a published port from a separate bridge. This crosses Docker's host
# DNAT and the Gridora forward hook. Direct peers on one Linux bridge can use
# layer 2 and never enter an inet forward hook, so they are not an ingress test.
allowed="$(timeout 8 docker run --rm --network gridora-firewall-source "$probe_image" \
  wget -qO- -T 3 "http://${source_gateway}:2302")"
test "$allowed" = ok
if timeout 6 docker run --rm --network gridora-firewall-source "$probe_image" \
  wget -qO- -T 3 "http://${source_gateway}:2303"; then
  printf '%s\n' 'An unleased game port remained reachable.' >&2
  exit 1
fi

# A second reload exercises the cloud-init path after Docker has installed its
# chains. The leased port must remain usable and Docker's chains must survive.
nft -f "$root/infra/images/nftables/gridora.nft"
nft add element inet gridora leased_tcp_ports '{ 2302 }'
ruleset="$(nft list ruleset)"
grep -Eq 'chain DOCKER|chain docker-forward' <<<"$ruleset"
allowed_after_reload="$(timeout 8 docker run --rm --network gridora-firewall-source "$probe_image" \
  wget -qO- -T 3 "http://${source_gateway}:2302")"
test "$allowed_after_reload" = ok

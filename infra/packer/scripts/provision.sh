#!/usr/bin/env bash
set -euo pipefail

report_failure() {
  local status=$?
  local failed_line=${BASH_LINENO[0]}
  local failed_command=${BASH_COMMAND}
  printf 'gridora image provisioning failed at line %s (exit %s): %s\n' \
    "${failed_line}" "${status}" "${failed_command}" >&2
  exit "${status}"
}

trap report_failure ERR

test -n "${GRIDORA_IMAGE_VERSION:-}"
test -n "${GRIDORA_NODE_VERSION:-}"
[[ "${GRIDORA_SOURCE_COMMIT:-}" =~ ^[a-f0-9]{40}$ ]]
[[ "${GRIDORA_NODE_ARCHIVE_CHECKSUM:-}" =~ ^[a-f0-9]{64}$ ]]
[[ "${GRIDORA_AGENT_BINARY_CHECKSUM:-}" =~ ^[a-f0-9]{64}$ ]]
[[ "${GRIDORA_CLOUDFLARED_BINARY_CHECKSUM:-}" =~ ^[a-f0-9]{64}$ ]]
[[ "${GRIDORA_TRAEFIK_BINARY_CHECKSUM:-}" =~ ^[a-f0-9]{64}$ ]]
[[ "${GRIDORA_UBUNTU_ISO_CHECKSUM:-}" =~ ^[a-f0-9]{64}$ ]]

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates cloud-init curl docker.io docker-compose-v2 e2fsprogs jq nftables openssl quota tar \
  unattended-upgrades zstd
sudo systemctl start docker
sudo docker version --format '{{.Server.APIVersion}}' | awk -F. '
  NF == 2 && ($1 > 1 || ($1 == 1 && $2 >= 43)) { compatible = 1 }
  END { exit !compatible }
'

sudo install -d -m 0755 \
  /etc/gridora /etc/systemd/journald.conf.d /opt/gridora /var/lib/gridora /var/log/gridora
jq -e \
  --arg version "${GRIDORA_IMAGE_VERSION}" \
  --arg sourceCommit "${GRIDORA_SOURCE_COMMIT}" \
  --arg agent "${GRIDORA_AGENT_BINARY_CHECKSUM}" \
  --arg cloudflared "${GRIDORA_CLOUDFLARED_BINARY_CHECKSUM}" \
  --arg node "${GRIDORA_NODE_ARCHIVE_CHECKSUM}" \
  --arg traefik "${GRIDORA_TRAEFIK_BINARY_CHECKSUM}" \
  --arg ubuntu "${GRIDORA_UBUNTU_ISO_CHECKSUM}" '
    type == "object" and
    keys == ["architecture","imageVersion","inputs","schemaVersion","sourceCommit"] and
    .schemaVersion == 1 and .architecture == "amd64" and
    .imageVersion == $version and .sourceCommit == $sourceCommit and
    (.inputs | keys == ["agentSha256","cloudflaredSha256","nodeArchiveSha256","traefikSha256","ubuntuIsoSha256"]) and
    .inputs == {agentSha256:$agent,cloudflaredSha256:$cloudflared,
      nodeArchiveSha256:$node,traefikSha256:$traefik,ubuntuIsoSha256:$ubuntu}
  ' /tmp/gridora-image-identity.json >/dev/null
openssl pkey -pubin -in /tmp/gridora-image-identity-public.pem -outform DER \
  -out /tmp/gridora-image-identity-public.der
test "$(wc -c </tmp/gridora-image-identity-public.der | tr -d '[:space:]')" = 44
test "$(od -An -tx1 -N12 /tmp/gridora-image-identity-public.der | tr -d ' \n')" = 302a300506032b6570032100
openssl pkeyutl -verify -pubin -inkey /tmp/gridora-image-identity-public.pem -rawin \
  -in /tmp/gridora-image-identity.json -sigfile /tmp/gridora-image-identity.sig >/dev/null
printf '%s  %s\n' "${GRIDORA_NODE_ARCHIVE_CHECKSUM}" /tmp/node-runtime.tar.xz | sha256sum --check --strict
printf '%s  %s\n' "${GRIDORA_AGENT_BINARY_CHECKSUM}" /tmp/gridora-agent | sha256sum --check --strict
printf '%s  %s\n' "${GRIDORA_CLOUDFLARED_BINARY_CHECKSUM}" /tmp/cloudflared | sha256sum --check --strict
printf '%s  %s\n' "${GRIDORA_TRAEFIK_BINARY_CHECKSUM}" /tmp/traefik | sha256sum --check --strict
sudo install -d -m 0755 "/opt/gridora/node-${GRIDORA_NODE_VERSION}"
sudo tar --extract --xz --file /tmp/node-runtime.tar.xz \
  --directory "/opt/gridora/node-${GRIDORA_NODE_VERSION}" --strip-components=1 \
  --no-same-owner --no-same-permissions
sudo ln -s "/opt/gridora/node-${GRIDORA_NODE_VERSION}/bin/node" /usr/local/bin/node
test "$(node --version)" = "v${GRIDORA_NODE_VERSION}"
sudo install -d -m 0755 /etc/traefik/dynamic /usr/local/libexec/gridora
sudo groupadd --gid 10001 gridora-data
sudo groupadd --system gridora-agent
sudo useradd --system --gid gridora-agent --home-dir /var/lib/gridora --shell /usr/sbin/nologin gridora-agent
sudo groupadd --system cloudflared
sudo useradd --system --gid cloudflared --home-dir /nonexistent --shell /usr/sbin/nologin cloudflared
sudo groupadd --system gridora-traefik
sudo useradd --system --gid gridora-traefik --home-dir /nonexistent --shell /usr/sbin/nologin gridora-traefik
sudo usermod -aG docker,gridora-data gridora-agent
sudo chown root:gridora-agent /var/lib/gridora
sudo chmod 0750 /var/lib/gridora
sudo chown -R gridora-agent:gridora-agent /var/log/gridora
sudo install -d -o gridora-agent -g gridora-agent -m 0700 \
  /var/lib/gridora/agent /var/lib/gridora/bootstrap
sudo install -d -o root -g gridora-agent -m 2770 /var/lib/gridora/servers
sudo install -d -o root -g root -m 0700 /var/lib/gridora/quota

# The baked agent is also release zero for the root-owned update boundary. The
# manifest is independently Ed25519-signed; the unprivileged runtime never
# supplies this key, policy, state, or a path for activation.
test -s /tmp/gridora-agent-update-manifest.json
test -s /tmp/gridora-agent-release-signing-public.pem
test -s /tmp/gridora-agent-update-policy.json
agent_update_keys='["apiVersion","architecture","compatibility","issuedAt","releaseSequence","securityEpoch","signature","source","version"]'
agent_update_source_keys='["sha256","sizeBytes","url"]'
agent_update_compatibility_keys='["commandApiVersion","maximumControlPlaneApiVersion","minimumControlPlaneApiVersion"]'
jq -e \
  --argjson keys "${agent_update_keys}" \
  --argjson sourceKeys "${agent_update_source_keys}" \
  --argjson compatibilityKeys "${agent_update_compatibility_keys}" \
  --arg checksum "sha256:${GRIDORA_AGENT_BINARY_CHECKSUM}" '
    type == "object" and keys == $keys and
    .apiVersion == "agent-update.gridora.dev/v1alpha1" and
    (.version | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$")) and
    .architecture == "amd64" and
    (.releaseSequence | type == "number" and floor == . and . >= 1) and
    (.securityEpoch | type == "number" and floor == . and . >= 1) and
    (.issuedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) and
    (.signature | type == "string" and test("^[A-Za-z0-9+/]+={0,2}$")) and
    (.source | type == "object" and keys == $sourceKeys and
      .sha256 == $checksum and .sizeBytes > 0 and .sizeBytes <= 134217728 and
      .url | type == "string" and test("^https://")) and
    (.compatibility | type == "object" and keys == $compatibilityKeys and
      .commandApiVersion == "agent.gridora.dev/v1alpha1" and
      .minimumControlPlaneApiVersion == "agent.gridora.dev/v1alpha1" and
      .maximumControlPlaneApiVersion == "agent.gridora.dev/v1alpha1")
  ' /tmp/gridora-agent-update-manifest.json >/dev/null
agent_update_size=$(jq -r '.source.sizeBytes' /tmp/gridora-agent-update-manifest.json)
[[ "${agent_update_size}" == "$(wc -c </tmp/gridora-agent | tr -d '[:space:]')" ]] ||
  { printf '%s\n' 'baked agent update size does not match' >&2; exit 1; }
openssl pkey -pubin -in /tmp/gridora-agent-release-signing-public.pem -outform DER \
  -out /tmp/gridora-agent-release-signing-public.der
test "$(wc -c </tmp/gridora-agent-release-signing-public.der | tr -d '[:space:]')" = 44
test "$(od -An -tx1 -N12 /tmp/gridora-agent-release-signing-public.der | tr -d ' \n')" = 302a300506032b6570032100
jq -cS 'del(.signature)' /tmp/gridora-agent-update-manifest.json | tr -d '\n' \
  > /tmp/gridora-agent-update-manifest.unsigned
jq -r '.signature' /tmp/gridora-agent-update-manifest.json | base64 --decode \
  > /tmp/gridora-agent-update-manifest.sig
openssl pkeyutl -verify -pubin -inkey /tmp/gridora-agent-release-signing-public.pem -rawin \
  -in /tmp/gridora-agent-update-manifest.unsigned -sigfile /tmp/gridora-agent-update-manifest.sig >/dev/null
jq -e '
  type == "object" and keys == ["allowedArtifactHosts","commandApiVersion","controlPlaneApiVersion","maximumArtifactBytes","schemaVersion"] and
  .schemaVersion == 1 and .commandApiVersion == "agent.gridora.dev/v1alpha1" and
  .controlPlaneApiVersion == "agent.gridora.dev/v1alpha1" and
  (.maximumArtifactBytes | type == "number" and floor == . and . >= 1 and . <= 134217728) and
  (.allowedArtifactHosts | type == "array" and length >= 1 and length <= 16 and
    all(.[]; type == "string" and test("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")))
' /tmp/gridora-agent-update-policy.json >/dev/null
agent_update_host=$(jq -r '.source.url | capture("^https://(?<host>[A-Za-z0-9.-]+)").host | ascii_downcase' /tmp/gridora-agent-update-manifest.json)
jq -e --arg host "${agent_update_host}" '.allowedArtifactHosts | index($host) != null' \
  /tmp/gridora-agent-update-policy.json >/dev/null
agent_update_version=$(jq -r '.version' /tmp/gridora-agent-update-manifest.json)
agent_update_sequence=$(jq -r '.releaseSequence' /tmp/gridora-agent-update-manifest.json)
agent_update_epoch=$(jq -r '.securityEpoch' /tmp/gridora-agent-update-manifest.json)
agent_update_suffix=${GRIDORA_AGENT_BINARY_CHECKSUM}
sudo install -d -o root -g root -m 0755 /var/lib/gridora/agent-updates /var/lib/gridora/agent-updates/releases
sudo install -d -o gridora-agent -g gridora-agent -m 0700 \
  /var/lib/gridora/agent-updates/staged /var/lib/gridora/agent-updates/health
sudo install -d -o root -g root -m 0755 "/var/lib/gridora/agent-updates/releases/${agent_update_suffix}"
sudo install -o root -g root -m 0755 /tmp/gridora-agent \
  "/var/lib/gridora/agent-updates/releases/${agent_update_suffix}/gridora-agent"
jq -cS . /tmp/gridora-agent-update-manifest.json > /tmp/gridora-agent-update-manifest.canonical
sudo install -o root -g root -m 0644 /tmp/gridora-agent-update-manifest.canonical \
  "/var/lib/gridora/agent-updates/releases/${agent_update_suffix}/release.json"
sudo ln -s "releases/${agent_update_suffix}" /var/lib/gridora/agent-updates/.current.initial
sudo mv -T /var/lib/gridora/agent-updates/.current.initial /var/lib/gridora/agent-updates/current
agent_update_state_tmp=$(mktemp /tmp/gridora-agent-update-state.XXXXXX)
jq -cn \
  --arg version "${agent_update_version}" \
  --arg digest "sha256:${GRIDORA_AGENT_BINARY_CHECKSUM}" \
  --argjson sequence "${agent_update_sequence}" \
  --argjson epoch "${agent_update_epoch}" \
  '{version:1,phase:"active",active:{version:$version,digest:$digest,releaseSequence:$sequence,securityEpoch:$epoch},previous:null,activation:null,outcomes:[],highestReleaseSequence:$sequence,minimumSecurityEpoch:$epoch}' \
  > "${agent_update_state_tmp}"
sudo install -o root -g root -m 0600 "${agent_update_state_tmp}" \
  /var/lib/gridora/agent-updates/.root-state.initial
sudo mv -T /var/lib/gridora/agent-updates/.root-state.initial /var/lib/gridora/agent-updates/root-state.json
sudo sync -f /var/lib/gridora/agent-updates
rm -f "${agent_update_state_tmp}"
sudo install -o root -g root -m 0444 /tmp/gridora-agent-release-signing-public.pem \
  /etc/gridora/agent-release-signing-public.pem
sudo install -o root -g root -m 0444 /tmp/gridora-agent-update-policy.json \
  /etc/gridora/agent-update-policy.json
sudo install -m 0755 /tmp/gridora-agent /usr/local/bin/gridora-agent
sudo install -o root -g root -m 0755 /tmp/gridora-image/gridora-agent-current \
  /usr/local/libexec/gridora/gridora-agent-current
bash -n /usr/local/libexec/gridora/gridora-agent-current
sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
sudo install -m 0755 /tmp/traefik /usr/local/bin/traefik
sudo install -m 0644 /tmp/gridora-image/sysctl.d/60-gridora.conf /etc/sysctl.d/60-gridora.conf
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-agent.service /etc/systemd/system/gridora-agent.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-agent-update-setup.service /etc/systemd/system/gridora-agent-update-setup.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-agent-update.service /etc/systemd/system/gridora-agent-update.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-agent-update.socket /etc/systemd/system/gridora-agent-update.socket
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-node-bootstrap.service /etc/systemd/system/gridora-node-bootstrap.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-node-bootstrap-cleanup.service /etc/systemd/system/gridora-node-bootstrap-cleanup.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-node-bootstrap-cleanup.path /etc/systemd/system/gridora-node-bootstrap-cleanup.path
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-firewall-observation.socket /etc/systemd/system/gridora-firewall-observation.socket
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-firewall-observation@.service /etc/systemd/system/gridora-firewall-observation@.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-plugin-egress-network.service /etc/systemd/system/gridora-plugin-egress-network.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-plugin-egress-lease.socket /etc/systemd/system/gridora-plugin-egress-lease.socket
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-plugin-egress-lease@.service /etc/systemd/system/gridora-plugin-egress-lease@.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-quota-filesystem.service /etc/systemd/system/gridora-quota-filesystem.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-quota.service /etc/systemd/system/gridora-quota.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-quota.socket /etc/systemd/system/gridora-quota.socket
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-tunnel-installer.service /etc/systemd/system/gridora-tunnel-installer.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-tunnel-installer.socket /etc/systemd/system/gridora-tunnel-installer.socket
sudo install -m 0644 /tmp/gridora-image/systemd/cloudflared.service /etc/systemd/system/cloudflared.service
sudo install -m 0644 /tmp/gridora-image/systemd/gridora-recovery.service /etc/systemd/system/gridora-recovery.service
sudo install -m 0644 /tmp/gridora-image/systemd/traefik.service /etc/systemd/system/traefik.service
sudo systemd-analyze verify \
  /etc/systemd/system/gridora-agent.service \
  /etc/systemd/system/gridora-agent-update-setup.service \
  /etc/systemd/system/gridora-agent-update.service \
  /etc/systemd/system/gridora-agent-update.socket \
  /etc/systemd/system/gridora-plugin-egress-network.service \
  /etc/systemd/system/gridora-plugin-egress-lease.socket \
  /etc/systemd/system/gridora-plugin-egress-lease@.service
sudo install -m 0644 /tmp/gridora-image/nftables/gridora.nft /etc/nftables.conf
sudo install -m 0644 /tmp/gridora-image/journald/60-gridora.conf /etc/systemd/journald.conf.d/60-gridora.conf
sudo install -m 0644 /tmp/gridora-image/traefik/traefik.yaml /etc/traefik/traefik.yaml
sudo install -m 0755 /tmp/gridora-image/recovery-check /usr/local/libexec/gridora/recovery-check
sudo install -m 0755 /tmp/gridora-image/clean-cloud-init-sensitive-cache /usr/local/libexec/gridora/clean-cloud-init-sensitive-cache
sudo install -m 0755 /tmp/gridora-image/gridora-node-bootstrap /usr/local/libexec/gridora/gridora-node-bootstrap
sudo install -m 0755 /tmp/gridora-image/gridora-node-bootstrap-cleanup /usr/local/libexec/gridora/gridora-node-bootstrap-cleanup
sudo install -m 0755 /tmp/gridora-image/gridora-firewall-observation /usr/local/libexec/gridora/gridora-firewall-observation
sudo install -m 0755 /tmp/gridora-image/gridora-plugin-egress-network /usr/local/libexec/gridora/gridora-plugin-egress-network
sudo install -m 0755 /tmp/gridora-image/gridora-plugin-egress-lease /usr/local/libexec/gridora/gridora-plugin-egress-lease
sudo install -m 0755 /tmp/gridora-image/validate-cloudflared-token /usr/local/libexec/gridora/validate-cloudflared-token
printf '%s\n' "${GRIDORA_IMAGE_VERSION}" | sudo tee /etc/gridora/image-version >/dev/null
sudo install -o root -g root -m 0444 /tmp/gridora-image-identity.json /etc/gridora/image-identity.json
sudo install -o root -g root -m 0444 /tmp/gridora-image-identity.sig /etc/gridora/image-identity.sig
sudo install -o root -g root -m 0444 /tmp/gridora-image-identity-public.pem /etc/gridora/image-identity-public.pem

sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/* /tmp/gridora-image /tmp/gridora-agent /tmp/cloudflared /tmp/traefik /tmp/node-runtime.tar.xz \
  /tmp/gridora-image-identity.json /tmp/gridora-image-identity.sig /tmp/gridora-image-identity-public.pem
sudo rm -f /tmp/gridora-image-identity-public.der /tmp/gridora-agent-release-signing-public.der \
  /tmp/gridora-agent-update-manifest.unsigned /tmp/gridora-agent-update-manifest.sig \
  /tmp/gridora-agent-update-manifest.canonical /tmp/gridora-agent-update-manifest.json \
  /tmp/gridora-agent-release-signing-public.pem /tmp/gridora-agent-update-policy.json

sudo usermod --lock root
sudo passwd --lock gridora
printf '%s\n' \
  'PermitRootLogin no' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' |
  sudo tee /etc/ssh/sshd_config.d/60-gridora.conf >/dev/null
sudo sshd -t
sudo systemctl enable docker nftables gridora-node-bootstrap gridora-agent gridora-node-bootstrap-cleanup.path gridora-quota-filesystem gridora-quota.socket \
  gridora-tunnel-installer.socket gridora-agent-update-setup gridora-agent-update.socket gridora-firewall-observation.socket \
  gridora-plugin-egress-network gridora-plugin-egress-lease.socket cloudflared gridora-recovery traefik
sudo cloud-init clean --logs --machine-id

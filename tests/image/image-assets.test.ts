import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

const asset = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('node image assets', () => {
  it('uses a default-deny host firewall', () => {
    const rules = asset('infra/images/nftables/gridora.nft')
    const integration = asset('infra/scripts/validate-firewall-docker-networking.sh')
    expect(rules).toContain('chain input')
    expect(rules).toContain('policy drop')
    expect(rules).not.toMatch(/tcp dport (22|2375|2376) accept/)
    expect(integration).toContain('gridora-firewall-target')
    expect(integration).toContain('gridora-firewall-source')
    expect(integration).toContain('--publish 2302:2302')
    expect(integration).toContain('--publish 2303:2303')
    expect(integration).toContain('http://${source_gateway}:2302')
    expect(integration).toContain('http://${source_gateway}:2303')
    expect(integration).not.toContain('http://${allowed_ip}:2302')
  })

  it('runs the project-quota proof on the host in a private mount namespace', () => {
    const quota = asset('infra/scripts/validate-project-quota.sh')
    const workflow = asset('.github/workflows/image.yml')
    expect(quota).toContain('mknod -m 0600 /dev/loop-control c 10 237')
    expect(quota).toContain('mknod -m 0600 "/dev/loop${index}" b 7 "$index"')
    expect(quota).toContain('losetup --find --show "$image"')
    expect(quota).toContain('losetup --detach "$loop_device"')
    expect(quota).toContain('mktemp -d "${TMPDIR:-/tmp}/gridora-project-quota.XXXXXX"')
    expect(quota).toContain('rm -rf -- "$proof_root"')
    expect(quota).not.toContain('mount -o loop,')
    expect(workflow.match(/validate-project-quota\.sh/g)).toHaveLength(4)
    expect(workflow.match(/sudo unshare --mount --propagation private/g)).toHaveLength(2)
    expect(workflow.match(/sudo modprobe quota_v2/g)).toHaveLength(2)
    expect(workflow.match(/test -d \/sys\/module\/quota_v2/g)).toHaveLength(2)
    expect(workflow.match(/linux-modules-extra-\$\(uname -r\)/g)).toHaveLength(2)
    expect(workflow).toContain('libguestfs-tools qemu-system-x86 qemu-utils quota')
    expect(workflow).toContain('LIBGUESTFS_BACKEND: direct')
    expect(workflow).toContain('kernel_image="/boot/vmlinuz-$(uname -r)"')
    expect(workflow).toContain('sudo chmod 0644 "$kernel_image"')
    expect(workflow).toContain('test -r "$kernel_image"')
    expect(workflow.indexOf('libguestfs-test-tool')).toBeLessThan(
      workflow.indexOf('- name: Build the local QCOW2 image'),
    )
    expect(workflow).not.toMatch(
      /gridora-node-validation:ci \\\n\s+\/workspace\/infra\/scripts\/validate-project-quota\.sh/,
    )
    expect(workflow).toContain('Prove privileged node kernel boundaries on the hosted runner')
  })

  it('keeps each protected image evidence boundary independently observable', () => {
    const workflow = asset('.github/workflows/image.yml')
    const stages = [
      'Extract rootfs evidence',
      'Validate signed rootfs package policy',
      'Generate rootfs SBOM',
      'Scan policy-validated rootfs SBOM',
      'Sign and verify the QCOW2 artifact',
      'Create the image promotion manifest',
    ]
    const indexes = stages.map((stage) => workflow.indexOf(`- name: ${stage}`))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
    expect(workflow).not.toContain('- name: Create and scan supply-chain evidence')
  })

  it('writes basename checksums and selects the image line by basename', () => {
    const workflow = asset('.github/workflows/image.yml')
    expect(workflow).toContain(
      `image_sha=$(awk -v name="$(basename "$IMAGE_PATH")" '$2 == name { print $1 }' "$IMAGE_PATH.sha256")`,
    )
    expect(workflow).not.toContain(`image_sha=$(cut -d ' ' -f 1 "$IMAGE_PATH.sha256")`)
    expect(workflow).toContain('sha256sum "$image" "$image.rootfs.tar" > "$image.sha256"')
    expect(workflow).not.toContain(
      'sha256sum "$IMAGE_PATH" "$IMAGE_PATH.rootfs.tar" > "$IMAGE_PATH.sha256"',
    )
  })

  it('passes the pinned Grype command output into the rootfs scanner', () => {
    const workflow = asset('.github/workflows/image.yml')
    const scanner = asset('infra/scripts/scan-artifact.sh')
    expect(workflow).toContain('- id: download-grype')
    expect(workflow).toContain('grype-version: v0.117.0')
    expect(workflow).toContain('syft-version: v1.51.0')
    expect(workflow).toContain('${{ steps.download-grype.outputs.cmd }}')
    expect(scanner).toContain('grype_command=${2:-grype}')
    expect(scanner).toContain('"${grype_command}" "sbom:${sbom}" --fail-on high --only-fixed')
  })

  it('builds cloudflared from the exact release source with the fixed Go toolchain', () => {
    const workflow = asset('.github/workflows/image.yml')
    expect(workflow).toContain('repository: cloudflare/cloudflared')
    expect(workflow).toContain('ref: 96d39adbc812dc7363834bda908970c1a2560a72')
    expect(workflow).toContain(
      'CLOUDFLARED_SOURCE_COMMIT: 96d39adbc812dc7363834bda908970c1a2560a72',
    )
    expect(workflow).toContain('CLOUDFLARED_VERSION: 2026.9.3')
    expect(workflow).toContain('CLOUDFLARED_BUILD_TIME: 2026-09-24T15:31:10Z')
    expect(workflow).toContain("go-version: '1.27.0'")
    expect(workflow).toContain('CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build')
    expect(workflow).toContain('-mod=readonly')
    expect(workflow).toContain('-buildvcs=false')
    expect(workflow).not.toContain('-mod=vendor')
    expect(workflow).not.toContain('733bfb939963e150dcf5c4faddb1603f744fbc98')
    expect(workflow).not.toContain('cloudflared/releases/download')
  })

  it('fences the cloudflared module update before the build', () => {
    const workflow = asset('.github/workflows/image.yml')
    const start = workflow.indexOf(
      '- name: Build cloudflared from exact reviewed source and fixed modules',
    )
    const end = workflow.indexOf('- name: Build Traefik from exact reviewed source')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const step = workflow.slice(start, end)
    const fence = step.indexOf('test "$patch_sha" = "$CLOUDFLARED_PATCH_SHA256"')
    const build = step.indexOf('CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build')
    expect(step).toContain(
      'CLOUDFLARED_PATCH_SHA256: 78cdbc62c6a6fbd61c8868e9b3be76391f2487d226c3b663922806defc86d068',
    )
    expect(step).toContain('go get golang.org/x/crypto@v0.56.0')
    expect(step).toContain('go mod tidy')
    expect(step).toContain(`test "$(git diff --name-only)" = $'go.mod\\ngo.sum'`)
    expect(step).toContain("patch_sha=$(cat go.mod go.sum | sha256sum | cut -d ' ' -f 1)")
    expect(step).toContain('go mod verify')
    expect(fence).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(fence)
    expect(step).toContain(`test "$(go list -m -f '{{.Version}}' golang.org/x/crypto)" = v0.56.0`)
    expect(step).toContain(
      `test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = v1.83.2`,
    )
    expect(step).toContain(
      `go version -m "$RUNNER_TEMP/cloudflared" | grep -F $'\\tdep\\tgolang.org/x/crypto\\tv0.56.0\\t'`,
    )
    expect(step).toContain(
      `go version -m "$RUNNER_TEMP/cloudflared" | grep -F $'\\tdep\\tgoogle.golang.org/grpc\\tv1.83.2\\t'`,
    )
    expect(workflow).toContain(
      '--arg cloudflaredPatchSha256 78cdbc62c6a6fbd61c8868e9b3be76391f2487d226c3b663922806defc86d068',
    )
    expect(workflow).toContain(
      '--arg cloudflaredSourceCommit 96d39adbc812dc7363834bda908970c1a2560a72',
    )
    expect(workflow).toContain('cloudflaredPatchSha256: $cloudflaredPatchSha256')
  })

  it('builds Traefik from the exact unpatched release source', () => {
    const workflow = asset('.github/workflows/image.yml')
    const start = workflow.indexOf('- name: Build Traefik from exact reviewed source')
    const end = workflow.indexOf('- name: Validate the pinned Ubuntu source')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const step = workflow.slice(start, end)
    expect(workflow).toContain('repository: traefik/traefik')
    expect(workflow).toContain('ref: fc92cc118a0557a029c7019d5ee06665127b0f13')
    expect(step).toContain('TRAEFIK_SOURCE_COMMIT: fc92cc118a0557a029c7019d5ee06665127b0f13')
    expect(step).toContain('TRAEFIK_VERSION: v3.7.13')
    expect(step).toContain('TRAEFIK_BUILD_DATE: 2026-09-04T08:48:05Z')
    expect(step).toContain('go mod verify')
    expect(step).toContain(
      `go version -m "$RUNNER_TEMP/traefik" | grep -F $'\\tdep\\tgo.etcd.io/etcd/client/pkg/v3\\tv3.6.14\\t'`,
    )
    expect(step).toContain(
      `go version -m "$RUNNER_TEMP/traefik" | grep -F $'\\tdep\\tgolang.org/x/crypto\\tv0.56.0\\t'`,
    )
    expect(step).toContain(
      `go version -m "$RUNNER_TEMP/traefik" | grep -F $'\\tdep\\tgoogle.golang.org/grpc\\tv1.83.2\\t'`,
    )
    expect(step).not.toContain('go get')
    expect(step).not.toContain('git diff')
    expect(workflow).toContain('--arg traefikSourceCommit fc92cc118a0557a029c7019d5ee06665127b0f13')
    expect(workflow).toContain('--arg traefikVersion v3.7.13')
    expect(workflow).toContain('traefikGoVersion: $traefikGoVersion')
    expect(workflow).not.toContain('TRAEFIK_PATCH_SHA256')
    expect(workflow).not.toContain('traefikPatchSha256')
    expect(workflow).not.toContain('faa1eb590646aed94e561e24a59be0c47353ae95')
    expect(workflow).not.toContain('gridora.1')
    expect(workflow).not.toContain('traefik/traefik/releases/download')
    expect(workflow).not.toContain('traefikArchiveSha256')
  })

  it('hardens the agent systemd unit', () => {
    const unit = asset('infra/images/systemd/gridora-agent.service')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(unit).toContain('ProtectSystem=strict')
    expect(unit).toContain('User=gridora-agent')
    expect(unit).toContain('Type=simple')
    expect(unit).not.toContain('Type=notify')
  })

  it('does not put the long-lived Tunnel token in provider user-data', () => {
    const cloudInit = asset('infra/images/cloud-init/node-bootstrap.yaml.tmpl')
    expect(cloudInit).toContain('permissions: "0600"')
    expect(cloudInit).not.toContain('${tunnel_token}')
    expect(cloudInit).not.toContain('path: /etc/gridora/cloudflared-token')
    expect(cloudInit).toContain('/var/lib/gridora/bootstrap/reservation.json')
    expect(asset('infra/images/systemd/gridora-node-bootstrap-cleanup.service')).toContain(
      'gridora-node-bootstrap-cleanup',
    )
  })

  it('fails the Tunnel service closed until a secure channel installs its token', () => {
    const unit = asset('infra/images/systemd/cloudflared.service')
    const validation = asset('infra/images/validate-cloudflared-token')
    expect(unit).toContain('ConditionPathExists=/var/lib/gridora/tunnel/credential')
    expect(unit).toContain('LoadCredential=tunnel-token:/var/lib/gridora/tunnel/credential')
    expect(unit).toContain('ExecStartPre=+/usr/local/libexec/gridora/validate-cloudflared-token')
    expect(unit).toContain('--token-file ${CREDENTIALS_DIRECTORY}/tunnel-token')
    expect(unit).toContain('--metrics 127.0.0.1:20000')
    expect(unit).toContain('User=cloudflared')
    expect(validation).toContain('root:root')
    expect(validation).toContain('= 600')
    expect(unit).not.toContain('/etc/gridora/cloudflared-token')
  })

  it('installs a socket-activated root Tunnel installer for only the agent group', () => {
    const socket = asset('infra/images/systemd/gridora-tunnel-installer.socket')
    const service = asset('infra/images/systemd/gridora-tunnel-installer.service')
    const agent = asset('infra/images/systemd/gridora-agent.service')
    const provision = asset('infra/packer/scripts/provision.sh')
    expect(socket).toContain('SocketUser=root')
    expect(socket).toContain('SocketGroup=gridora-agent')
    expect(socket).toContain('SocketMode=0660')
    expect(socket).toContain('RemoveOnStop=true')
    expect(service).toContain('User=root')
    expect(service).toContain('tunnel-installer --listen-fd 3')
    expect(service).toContain('StateDirectoryMode=0700')
    expect(service).toContain('IPAddressAllow=localhost')
    expect(agent).toContain('gridora-tunnel-installer.socket')
    expect(provision).toContain('systemd/gridora-tunnel-installer.service')
    expect(provision).toContain('systemd/gridora-tunnel-installer.socket')
    expect(provision).toContain('gridora-tunnel-installer.socket')
    expect(provision).not.toContain('gridora-tunnel-installer.service cloudflared')
  })

  it('isolates fixed firewall observation from the unprivileged agent', () => {
    const agent = asset('infra/images/systemd/gridora-agent.service')
    const socket = asset('infra/images/systemd/gridora-firewall-observation.socket')
    const service = asset('infra/images/systemd/gridora-firewall-observation@.service')
    expect(agent).not.toContain('CAP_NET_ADMIN')
    expect(socket).toContain('SocketGroup=gridora-agent')
    expect(socket).toContain('SocketMode=0660')
    expect(socket).toContain('DirectoryMode=0755')
    expect(service).toContain('CapabilityBoundingSet=CAP_NET_ADMIN')
    expect(service).toContain('gridora-firewall-observation')
  })

  it('provisions one fixed plugin egress bridge and a bounded root lease helper', () => {
    const network = asset('infra/images/gridora-plugin-egress-network')
    const helper = asset('infra/images/gridora-plugin-egress-lease')
    const socket = asset('infra/images/systemd/gridora-plugin-egress-lease.socket')
    const service = asset('infra/images/systemd/gridora-plugin-egress-lease@.service')
    const agent = asset('infra/images/systemd/gridora-agent.service')
    expect(network).toContain('com.docker.network.bridge.name=gridora-egress0')
    expect(network).toContain('dev.gridora.network-policy=gridora-plugin-egress-v1')
    expect(helper).toContain('permitted_game_egress_v4')
    expect(helper).toContain('timeout 65m')
    expect(socket).toContain('SocketGroup=gridora-agent')
    expect(socket).toContain('SocketMode=0660')
    expect(service).toContain('CapabilityBoundingSet=CAP_NET_ADMIN')
    expect(agent).toContain('gridora-plugin-egress-network.service')
    expect(agent).not.toContain('AmbientCapabilities=CAP_NET_ADMIN')
  })

  it('runs one host Traefik service without the Docker socket', () => {
    const unit = asset('infra/images/systemd/traefik.service')
    const config = asset('infra/images/traefik/traefik.yaml')
    expect(unit).toContain('/usr/local/bin/traefik')
    expect(config).not.toContain('providers:\n  docker:')
    expect(config).not.toContain('/var/run/docker.sock')
  })

  it('installs Docker before it adds the agent to the Docker group', () => {
    const provision = asset('infra/packer/scripts/provision.sh')
    expect(provision.indexOf('apt-get install')).toBeLessThan(
      provision.indexOf('usermod -aG docker'),
    )
  })

  it('installs the exact signed Docker package policy after a complete Ubuntu upgrade', () => {
    const provision = asset('infra/packer/scripts/provision.sh')
    const policy = asset('infra/scripts/validate-rootfs-package-policy.sh')
    expect(provision).toContain('apt-get dist-upgrade -y --no-install-recommends')
    expect(provision).toContain('apt-get purge -y snapd')
    expect(provision).toContain("dpkg-query -W -f='${db:Status-Status}' snapd")
    expect(provision).toContain('"${snapd_status}" == not-installed')
    expect(provision).toContain('test ! -e /usr/bin/snap')
    expect(provision).toContain('test ! -e /usr/lib/snapd/snapd')
    expect(provision).not.toContain('apt-get autoremove')
    expect(provision.indexOf('apt-get dist-upgrade')).toBeLessThan(
      provision.indexOf('apt-get purge -y snapd'),
    )
    expect(provision.indexOf('apt-get purge -y snapd')).toBeLessThan(
      provision.indexOf('https://download.docker.com/linux/ubuntu/gpg'),
    )
    expect(provision).toContain('https://download.docker.com/linux/ubuntu/gpg')
    expect(provision).toContain('9DC858229FC7DD38854AE2D88D81803C0EBFCD88')
    expect(provision).toContain('install -d -m 0700 /tmp/gridora-docker-key-check')
    expect(provision).toContain('GNUPGHOME=/tmp/gridora-docker-key-check')
    expect(provision).toContain('find /tmp/gridora-docker-key-check -depth -delete')
    expect(provision).toContain("docker_ce_version='5:29.8.1-1~ubuntu.24.04~noble'")
    expect(provision).toContain("docker_ce_cli_version='5:29.8.1-1~ubuntu.24.04~noble'")
    expect(provision).toContain("containerd_io_version='2.3.5-1~ubuntu.24.04~noble'")
    expect(provision).toContain("docker_buildx_version='0.37.1-1~ubuntu.24.04~noble'")
    expect(provision).toContain("docker_compose_version='5.5.1-1~ubuntu.24.04~noble'")
    expect(provision).toContain('apt-get --simulate dist-upgrade')
    expect(provision).not.toMatch(/\bdocker\.io\b/)
    expect(provision).not.toContain('docker-compose-v2')
    expect(policy).toContain('replacementEvidence: "ubuntu-dpkg-package-inventory"')
    expect(policy).toContain('/usr/libexec/docker/cli-plugins/docker-compose')
  })

  it('keeps one Docker pin block in the image build and the rootfs package policy', () => {
    const pinBlock = (source: string) =>
      source
        .split('\n')
        .filter((line) =>
          /^readonly (docker_repository_key_fingerprint|docker_ce_version|docker_ce_cli_version|containerd_io_version|docker_buildx_version|docker_compose_version)=/.test(
            line,
          ),
        )
    const provisionPins = pinBlock(asset('infra/packer/scripts/provision.sh'))
    const policyPins = pinBlock(asset('infra/scripts/validate-rootfs-package-policy.sh'))
    expect(provisionPins).toHaveLength(6)
    expect(policyPins).toEqual(provisionPins)
  })

  it('checks Docker pin drift in the image validate job before any image build', () => {
    const source = asset('.github/workflows/image.yml')
    const workflow = parseDocument(source).toJS() as {
      jobs: Record<string, { needs?: string; steps: { name?: string; run?: string }[] }>
    }
    const validate = workflow.jobs.validate!.steps
    const checkIndex = validate.findIndex(
      (step) => step.run === 'bash infra/scripts/check-docker-pins.sh',
    )
    expect(validate[checkIndex]?.name).toBe(
      'Check Docker package pins against the Docker repository index',
    )
    // The check needs only the checkout, so it fails before tool setup.
    expect(checkIndex).toBe(1)
    expect(workflow.jobs['build-local']!.needs).toBe('validate')
    expect(source.match(/infra\/scripts\/check-docker-pins\.sh/g)).toHaveLength(3)
    const check = asset('infra/scripts/check-docker-pins.sh')
    expect(check).toContain(
      "readonly index_url='https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages'",
    )
    expect(check).toContain("--proto '=https' --tlsv1.2")
  })

  it('includes Ubuntu phased updates before any apt call and reports pending upgrades', () => {
    const provision = asset('infra/packer/scripts/provision.sh')
    const dropIn = '/etc/apt/apt.conf.d/90gridora-phased-updates'
    expect(provision).toContain(
      `printf '%s\\n' 'APT::Get::Always-Include-Phased-Updates "true";' |\n  sudo tee ${dropIn} >/dev/null`,
    )
    expect(provision).toContain(`sudo chmod 0644 ${dropIn}`)
    expect(provision.indexOf(dropIn)).toBeGreaterThan(-1)
    expect(provision.indexOf(dropIn)).toBeLessThan(provision.indexOf('sudo apt-get'))
    expect(provision).not.toContain('Never-Include-Phased-Updates')
    expect(provision).not.toContain('APT::Machine-ID')
    expect(provision).not.toMatch(new RegExp(`rm [^\\n]*${dropIn}`))
    expect(provision).toContain(
      "pending_upgrades=$(sudo apt-get --simulate dist-upgrade | awk '/^Inst / { print }')",
    )
    expect(provision).toContain(
      "echo 'image provisioning left pending package upgrades' >&2\n  printf '%s\\n' \"${pending_upgrades}\" >&2\n  exit 1",
    )
  })

  it('creates the journald drop-in directory before installing its policy', () => {
    const provision = asset('infra/packer/scripts/provision.sh')
    const directory = '/etc/systemd/journald.conf.d /opt/gridora'
    const policy = '/etc/systemd/journald.conf.d/60-gridora.conf'
    expect(provision).toContain(directory)
    expect(provision.indexOf(directory)).toBeLessThan(provision.indexOf(policy))
  })

  it('keeps signed agent manifest validation explicitly scoped and diagnosable', () => {
    const provision = asset('infra/packer/scripts/provision.sh')
    expect(provision).toContain('local failed_line=${BASH_LINENO[0]}')
    expect(provision).toContain('gridora image provisioning failed at line %s')
    expect(provision).toContain('agent_update_top_level_keys=')
    expect(provision).toContain('(.source |\n      (type == "object")')
    expect(provision).toContain('((.url | type) == "string")')
    expect(provision).toContain('(.compatibility |\n      (type == "object")')
    expect(provision).not.toContain('.url | type == "string" and')
  })

  it('installs unit executables before systemd verifies their units', () => {
    const provision = asset('infra/packer/scripts/provision.sh')
    const verify = 'systemd-analyze verify'
    expect(provision.indexOf('gridora-plugin-egress-network /usr/local/libexec')).toBeLessThan(
      provision.indexOf(verify),
    )
    expect(provision.indexOf('gridora-plugin-egress-lease /usr/local/libexec')).toBeLessThan(
      provision.indexOf(verify),
    )
  })

  it('removes the ephemeral Packer SSH key', () => {
    const packer = asset('infra/packer/gridora-node.pkr.hcl')
    expect(packer).toContain('rm -f /home/gridora/.ssh/authorized_keys')
    expect(packer.indexOf('rm -f /home/gridora/.ssh/authorized_keys')).toBeLessThan(
      packer.indexOf('shutdown -P now'),
    )
  })

  it('removes the validated temporary Packer sudo grant in the shutdown root process', () => {
    const packer = asset('infra/packer/gridora-node.pkr.hcl')
    const userData = asset('infra/packer/http/user-data.pkrtpl.hcl')
    const userDataDocument = parseDocument(userData)
    expect(userDataDocument.errors).toEqual([])
    expect(userData).toContain('gridora ALL=(ALL) NOPASSWD:ALL')
    expect(userData).toContain('chmod 0440 /etc/sudoers.d/90-gridora-packer')
    expect(userData).toContain('visudo -cf /etc/sudoers.d/90-gridora-packer')
    expect(packer).toContain("sudo sh -c 'rm -f")
    expect(packer).toContain('/etc/sudoers.d/90-gridora-packer && shutdown -P now')
  })

  it('uses the existing Packer user-data template', () => {
    const packer = asset('infra/packer/gridora-node.pkr.hcl')
    expect(packer).toContain('templatefile("http/user-data.pkrtpl.hcl"')
    expect(asset('infra/packer/http/user-data.pkrtpl.hcl')).toContain('authorized-keys')
  })

  it('boots the pinned installer without depending on GRUB menu line positions', () => {
    const packer = asset('infra/packer/gridora-node.pkr.hcl')
    expect(packer).toContain('"c<wait>"')
    expect(packer).toContain('linux /casper/vmlinuz autoinstall ip=dhcp')
    expect(packer).toContain('ds=\\"nocloud-net;s=http://{{ .HTTPIP }}:{{ .HTTPPort }}/\\" ---')
    expect(packer).toContain('initrd /casper/initrd<enter><wait>')
    expect(packer).toContain('boot<enter>')
    expect(packer).not.toContain('<down><down><down><end>')
  })

  it('creates the private image-asset upload destination before copying its contents', () => {
    const packer = asset('infra/packer/gridora-node.pkr.hcl')
    const createDestination = 'install -d -m 0700 /tmp/gridora-image'
    const uploadDestination = 'destination = "/tmp/gridora-image"'
    expect(packer).toContain(createDestination)
    expect(packer.indexOf(createDestination)).toBeLessThan(packer.indexOf(uploadDestination))
  })
})

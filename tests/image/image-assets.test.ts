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
      'Generate rootfs SBOM',
      'Scan rootfs archive',
      'Sign and verify the QCOW2 artifact',
      'Create the image promotion manifest',
    ]
    const indexes = stages.map((stage) => workflow.indexOf(`- name: ${stage}`))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
    expect(workflow).not.toContain('- name: Create and scan supply-chain evidence')
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

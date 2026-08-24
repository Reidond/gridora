import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface ContainerInspection {
  readonly Config: { readonly User: string }
  readonly HostConfig: {
    readonly Privileged: boolean
    readonly ReadonlyRootfs: boolean
    readonly CapDrop: ReadonlyArray<string> | null
    readonly SecurityOpt: ReadonlyArray<string> | null
    readonly Devices: ReadonlyArray<unknown> | null
    readonly Binds: ReadonlyArray<string> | null
    readonly PortBindings: Readonly<
      Record<string, ReadonlyArray<{ readonly HostIp: string; readonly HostPort: string }> | null>
    >
  }
  readonly Mounts: ReadonlyArray<unknown>
}

interface NetworkInspection {
  readonly Internal: boolean
  readonly Attachable: boolean
}

const run = (file: string, args: ReadonlyArray<string>): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error !== null && error.code === undefined) {
        reject(error)
        return
      }
      resolve({
        code: error === null ? 0 : Number(error.code),
        stdout,
        stderr,
      })
    })
  })

const requireSuccess = async (file: string, args: ReadonlyArray<string>): Promise<string> => {
  const result = await run(file, args)
  if (result.code !== 0) {
    throw new Error(`${file} failed (${result.code}): ${result.stderr}`)
  }
  return result.stdout.trim()
}

const liveDocker = process.env.GRIDORA_LIVE_DOCKER_SECURITY === '1'
const ubuntuImage = 'ubuntu@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea'

describe.skipIf(!liveDocker)('live Docker workload boundary', () => {
  it('enforces the sandbox on a real container', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
    const containerName = `gridora-security-${suffix}`
    const networkName = `gridora-security-${suffix}`
    const directory = await mkdtemp(join(tmpdir(), 'gridora-security-'))
    const ownedDirectory = join(directory, 'owned')
    const foreignDirectory = join(directory, 'foreign')

    await mkdir(ownedDirectory)
    await mkdir(foreignDirectory)
    await writeFile(join(ownedDirectory, 'owned.txt'), 'owned\n', { mode: 0o600 })
    await writeFile(join(foreignDirectory, 'foreign.txt'), 'foreign\n', { mode: 0o600 })

    try {
      if ((await run('docker', ['image', 'inspect', ubuntuImage])).code !== 0) {
        await requireSuccess('docker', ['pull', ubuntuImage])
      }
      await requireSuccess('docker', [
        'network',
        'create',
        '--internal',
        '--label',
        'dev.gridora.organization=security-org',
        networkName,
      ])
      await requireSuccess('docker', [
        'create',
        '--name',
        containerName,
        '--network',
        networkName,
        '--user',
        '10001:10001',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--memory',
        '256m',
        '--cpus',
        '0.5',
        '--pids-limit',
        '64',
        '--log-driver',
        'local',
        '--log-opt',
        'max-size=10m',
        '--log-opt',
        'max-file=5',
        '--stop-timeout',
        '60',
        '--volume',
        `${ownedDirectory}:/game/data:ro`,
        '--publish',
        '127.0.0.1::8080/tcp',
        '--label',
        'dev.gridora.organization=security-org',
        '--label',
        'dev.gridora.server=security-server',
        ubuntuImage,
        'sleep',
        'infinity',
      ])
      await requireSuccess('docker', ['start', containerName])

      const containers = JSON.parse(
        await requireSuccess('docker', ['inspect', containerName]),
      ) as ReadonlyArray<ContainerInspection>
      const networks = JSON.parse(
        await requireSuccess('docker', ['network', 'inspect', networkName]),
      ) as ReadonlyArray<NetworkInspection>
      const container = containers[0]
      const network = networks[0]
      if (container === undefined || network === undefined) {
        throw new Error('Docker inspect returned no object')
      }

      expect(container.Config.User).toBe('10001:10001')
      expect(container.HostConfig.Privileged).toBe(false)
      expect(container.HostConfig.ReadonlyRootfs).toBe(true)
      expect(container.HostConfig.CapDrop).toEqual(['ALL'])
      expect(container.HostConfig.SecurityOpt).toContain('no-new-privileges:true')
      expect(container.HostConfig.Devices ?? []).toEqual([])
      expect(container.HostConfig.Binds).toEqual([`${ownedDirectory}:/game/data:ro`])
      expect(JSON.stringify(container.Mounts)).not.toContain(foreignDirectory)
      expect(JSON.stringify(container.Mounts)).not.toContain('/var/run/docker.sock')
      expect(Object.keys(container.HostConfig.PortBindings)).toEqual(['8080/tcp'])
      expect(container.HostConfig.PortBindings['8080/tcp']).toEqual([
        expect.objectContaining({ HostIp: '127.0.0.1' }),
      ])
      // This fixture proves the stricter isolated-job boundary. Game-server
      // bridges are non-internal and are covered by the VPS simulation with
      // Gridora's default-deny nftables forward policy loaded.
      expect(network.Internal).toBe(true)
      expect(network.Attachable).toBe(false)

      expect(await requireSuccess('docker', ['exec', containerName, 'id', '-u'])).toBe('10001')
      expect(
        await requireSuccess('docker', [
          'exec',
          containerName,
          'sh',
          '-c',
          "grep '^CapEff:' /proc/self/status && grep '^NoNewPrivs:' /proc/self/status",
        ]),
      ).toMatch(/CapEff:\s+0{16}[\s\S]*NoNewPrivs:\s+1/)
      await requireSuccess('docker', ['exec', containerName, 'test', '-f', '/game/data/owned.txt'])
      await requireSuccess('docker', [
        'exec',
        containerName,
        'test',
        '!',
        '-e',
        '/var/run/docker.sock',
      ])
      expect(
        (await run('docker', ['exec', containerName, 'touch', '/etc/gridora-write-test'])).code,
      ).not.toBe(0)
      expect(
        (
          await run('docker', [
            'exec',
            containerName,
            'bash',
            '-c',
            "timeout 3 bash -c 'cat </dev/null >/dev/tcp/1.1.1.1/80'",
          ])
        ).code,
      ).not.toBe(0)
    } finally {
      await run('docker', ['rm', '--force', containerName])
      await run('docker', ['network', 'rm', networkName])
      await rm(directory, { recursive: true, force: true })
    }
  }, 45_000)
})

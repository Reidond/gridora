import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  sealTunnelCredential,
  type TunnelCredentialInstallPayload,
} from '@gridora/tunnel-credential'
import {
  createRootTunnelInstallerWithOptions,
  createTunnelInstallerHttpServer,
  makeTunnelInstallerClient,
  provisionTunnelCredentialNodeKey,
  type TunnelCommandRunner,
  type TunnelInstallerOptions,
  type TunnelSystemctlArguments,
} from '../src/index.js'

const uid = process.getuid!()
const gid = process.getgid!()
const now = '2026-08-23T10:00:00Z'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

interface Harness {
  options: TunnelInstallerOptions
  readonly calls: Array<{ readonly command: string; readonly args: TunnelSystemctlArguments }>
  active: boolean
  ready: boolean
  readyChecks: number
}

const makeHarness = async (): Promise<Harness> => {
  const parent = await mkdtemp(join(tmpdir(), 'gridora-tunnel-installer-'))
  temporaryDirectories.push(parent)
  const directory = join(parent, 'tunnel')
  const calls: Array<{ readonly command: string; readonly args: TunnelSystemctlArguments }> = []
  const harness: Harness = {
    active: false,
    ready: true,
    readyChecks: 0,
    calls,
    options: undefined as never,
  }
  const runner: TunnelCommandRunner = {
    async run(command, args) {
      calls.push({ command, args })
      if (args[0] === 'restart') harness.active = true
      if (args[0] === 'stop') harness.active = false
      if (args[0] === 'is-active' && !harness.active) throw new Error('inactive')
      if (args[0] === 'show') return harness.active ? 'active\n' : 'inactive\n'
      return ''
    },
  }
  harness.options = {
    paths: {
      directory,
      credential: join(directory, 'credential'),
      state: join(directory, 'installer-state.json'),
      privateKey: join(directory, 'node-private-key'),
      publicKey: join(directory, 'node-public-key'),
    },
    rootUid: uid,
    rootGid: gid,
    commandRunner: runner,
    healthProbe: {
      async ready() {
        harness.readyChecks += 1
        if (!harness.ready) throw new Error('not connected')
      },
    },
  }
  return harness
}

const command = async (
  publicKey: string,
  overrides: Partial<TunnelCredentialInstallPayload> = {},
) => {
  const coordinates = {
    organizationId: 'org-a',
    nodeId: 'node-a',
    tunnelId: 'tunnel-a',
    operationId: 'operation-a',
    revision: 1,
  }
  const sealedCredential = await Effect.runPromise(
    sealTunnelCredential(publicKey, coordinates, 'top-secret-tunnel-token'),
  )
  return {
    apiVersion: 'tunnel.gridora.dev/v1alpha1' as const,
    action: 'install' as const,
    deliveryId: 'delivery-a',
    ...coordinates,
    expectedPriorRevision: 0,
    expiresAt: '2030-08-23T11:00:00Z',
    sealedCredential,
    destination: {
      path: '/var/lib/gridora/tunnel/credential' as const,
      owner: 'root' as const,
      group: 'root' as const,
      mode: '0600' as const,
    },
    ...overrides,
  }
}

describe('root tunnel credential installer', () => {
  it('opens only inside the installer, atomically persists 0600, and uses fixed systemctl calls', async () => {
    const harness = await makeHarness()
    const publicKey = await provisionTunnelCredentialNodeKey(harness.options)
    const installer = createRootTunnelInstallerWithOptions(harness.options)
    const payload = await command(publicKey)
    const result = await installer.execute(payload, now)

    expect(result).toMatchObject({ status: 'active', healthy: true, duplicate: false })
    expect(await readFile(harness.options.paths.credential, 'utf8')).toBe('top-secret-tunnel-token')
    const metadata = await lstat(harness.options.paths.credential)
    expect(metadata.mode & 0o7777).toBe(0o600)
    expect(metadata.uid).toBe(uid)
    expect(metadata.gid).toBe(gid)
    expect(await readFile(harness.options.paths.state, 'utf8')).not.toContain(
      'top-secret-tunnel-token',
    )
    expect(harness.calls).toEqual([
      { command: '/usr/bin/systemctl', args: ['restart', 'cloudflared.service'] },
      {
        command: '/usr/bin/systemctl',
        args: ['is-active', '--quiet', 'cloudflared.service'],
      },
    ])
    expect(harness.readyChecks).toBe(1)
  })

  it('rejects cross-node ciphertext and tampering without activating or persisting secret data', async () => {
    for (const mutation of ['scope', 'tamper'] as const) {
      const harness = await makeHarness()
      const publicKey = await provisionTunnelCredentialNodeKey(harness.options)
      const installer = createRootTunnelInstallerWithOptions(harness.options)
      const original = await command(publicKey)
      const payload =
        mutation === 'scope'
          ? { ...original, nodeId: 'node-b' }
          : {
              ...original,
              sealedCredential: `${original.sealedCredential.slice(0, -1)}${original.sealedCredential.endsWith('A') ? 'B' : 'A'}`,
            }
      await expect(installer.execute(payload, now)).rejects.toMatchObject({
        message: 'tunnel credential installer operation failed',
      })
      expect(harness.calls).toEqual([])
      await expect(readFile(harness.options.paths.credential)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(harness.options.paths.state)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('deduplicates replay and recovers when the first acknowledgement is lost', async () => {
    const harness = await makeHarness()
    const publicKey = await provisionTunnelCredentialNodeKey(harness.options)
    const installer = createRootTunnelInstallerWithOptions(harness.options)
    const payload = await command(publicKey)
    await installer.execute(payload, now) // The caller loses this response.
    const restartedInstaller = createRootTunnelInstallerWithOptions(harness.options)
    await expect(restartedInstaller.execute(payload, now)).resolves.toMatchObject({
      duplicate: true,
    })
    expect(harness.calls.filter(({ args }) => args[0] === 'restart')).toHaveLength(1)
    expect(harness.readyChecks).toBe(2)
    await expect(
      installer.execute({ ...payload, deliveryId: 'different-delivery' }, now),
    ).rejects.toMatchObject({ code: 'replay_rejected' })
  })

  it('does not acknowledge health until the cloudflared readiness endpoint is connected', async () => {
    const harness = await makeHarness()
    const publicKey = await provisionTunnelCredentialNodeKey(harness.options)
    const installer = createRootTunnelInstallerWithOptions(harness.options)
    const payload = await command(publicKey)
    harness.ready = false
    await expect(installer.execute(payload, now)).rejects.toMatchObject({
      code: 'activation_failed',
    })
    expect(JSON.parse(await readFile(harness.options.paths.state, 'utf8'))).toMatchObject({
      phase: 'installing',
    })
    harness.ready = true
    await expect(installer.execute(payload, now)).resolves.toMatchObject({
      status: 'active',
      healthChecked: true,
      healthy: true,
    })
  })

  it('rejects a symlink directory, credential symlink, unsafe key permissions, and a variable path', async () => {
    const symlinkHarness = await makeHarness()
    const target = join(dirname(symlinkHarness.options.paths.directory), 'target')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, symlinkHarness.options.paths.directory)
    await expect(provisionTunnelCredentialNodeKey(symlinkHarness.options)).rejects.toMatchObject({
      code: 'unsafe_filesystem',
    })

    const credentialHarness = await makeHarness()
    const publicKey = await provisionTunnelCredentialNodeKey(credentialHarness.options)
    const payload = await command(publicKey)
    await symlink('/tmp', credentialHarness.options.paths.credential)
    await expect(
      createRootTunnelInstallerWithOptions(credentialHarness.options).execute(payload, now),
    ).rejects.toMatchObject({ message: 'tunnel credential installer operation failed' })

    const permissionHarness = await makeHarness()
    const permissionKey = await provisionTunnelCredentialNodeKey(permissionHarness.options)
    await chmod(permissionHarness.options.paths.privateKey, 0o644)
    await expect(
      createRootTunnelInstallerWithOptions(permissionHarness.options).execute(
        await command(permissionKey),
        now,
      ),
    ).rejects.toMatchObject({ code: 'unsafe_filesystem' })

    const pathHarness = await makeHarness()
    const pathKey = await provisionTunnelCredentialNodeKey(pathHarness.options)
    await expect(
      createRootTunnelInstallerWithOptions(pathHarness.options).execute(
        {
          ...(await command(pathKey)),
          destination: {
            path: '/tmp/stolen-token',
            owner: 'root',
            group: 'root',
            mode: '0600',
          },
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      createRootTunnelInstallerWithOptions(pathHarness.options).execute(
        { ...(await command(pathKey)), ignored: 'field' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('revokes by stopping cloudflared before removing the credential and fences the old install', async () => {
    const harness = await makeHarness()
    const publicKey = await provisionTunnelCredentialNodeKey(harness.options)
    const installer = createRootTunnelInstallerWithOptions(harness.options)
    const install = await command(publicKey)
    await installer.execute(install, now)
    const revoke = {
      apiVersion: 'tunnel.gridora.dev/v1alpha1' as const,
      action: 'revoke' as const,
      deliveryId: 'delivery-revoke',
      organizationId: install.organizationId,
      nodeId: install.nodeId,
      tunnelId: install.tunnelId,
      operationId: 'operation-revoke',
      revision: 2,
      expectedPriorRevision: 1,
      expiresAt: install.expiresAt,
    }
    await expect(installer.execute(revoke, now)).resolves.toMatchObject({
      status: 'revoked',
      healthy: false,
    })
    expect(harness.active).toBe(false)
    await expect(readFile(harness.options.paths.credential)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(harness.calls.at(-2)).toEqual({
      command: '/usr/bin/systemctl',
      args: ['stop', 'cloudflared.service'],
    })
    expect(harness.calls.at(-1)).toEqual({
      command: '/usr/bin/systemctl',
      args: ['show', '--property=ActiveState', '--value', 'cloudflared.service'],
    })
    await expect(installer.execute(install, now)).rejects.toMatchObject({
      code: 'revision_conflict',
    })
  })

  it('round-trips sealed requests over the bounded Unix-socket HTTP adapter', async () => {
    const harness = await makeHarness()
    const installer = createRootTunnelInstallerWithOptions(harness.options)
    const socketPath = join(dirname(harness.options.paths.directory), 'installer.sock')
    const server = createTunnelInstallerHttpServer(installer)
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, resolveListen)
    })
    try {
      const client = makeTunnelInstallerClient(socketPath)
      const publicKey = await client.publicKey()
      const result = await Effect.runPromise(client.install(await command(publicKey)))
      expect(result).toMatchObject({ activated: true, healthy: true, owner: 'root', mode: '0600' })
      expect(JSON.stringify(result)).not.toContain('top-secret-tunnel-token')
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await unlink(socketPath).catch(() => undefined)
    }
  })

  it('rejects a socket response that omits root-generated safety proof', async () => {
    const harness = await makeHarness()
    const socketPath = join(dirname(harness.options.paths.directory), 'u.sock')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          organizationId: 'org-a',
          nodeId: 'node-a',
          tunnelId: 'tunnel-a',
          operationId: 'operation-a',
          deliveryId: 'delivery-a',
          revision: 1,
          status: 'active',
          duplicate: false,
          healthy: true,
          acknowledgedAt: now,
        }),
      )
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, resolveListen)
    })
    try {
      const publicKey = await provisionTunnelCredentialNodeKey(harness.options)
      await expect(
        Effect.runPromise(makeTunnelInstallerClient(socketPath).install(await command(publicKey))),
      ).rejects.toMatchObject({ code: 'install-failed' })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await unlink(socketPath).catch(() => undefined)
    }
  })
})

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const helper = resolve(process.cwd(), 'infra/images/gridora-node-bootstrap')
const cacheCleanup = resolve(process.cwd(), 'infra/images/clean-cloud-init-sensitive-cache')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const makePublicKey = async (root: string): Promise<{ publicKey: string; privateKey: string }> => {
  const privateKey = join(root, 'test-private.pem')
  const publicKey = join(root, 'test-public.pem')
  await execute('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', privateKey])
  await execute('openssl', ['pkey', '-in', privateKey, '-pubout', '-out', publicKey])
  return { publicKey: await readFile(publicKey, 'utf8'), privateKey }
}

const setup = async (
  provider: 'ovhcloud' | 'contabo' = 'ovhcloud',
  instanceId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
) => {
  const root = await mkdtemp(join(tmpdir(), 'gridora-bootstrap-'))
  roots.push(root)
  const paths = [
    'etc/gridora',
    'etc/cloud',
    'var/lib/gridora/bootstrap',
    'var/lib/cloud/data',
    'var/lib/cloud/instances/current',
    'run/cloud-init',
    'var/log',
  ]
  await Promise.all(paths.map((path) => mkdir(join(root, path), { recursive: true })))
  const key = await makePublicKey(root)
  const platform = provider === 'ovhcloud' ? 'openstack' : 'nocloud'
  const reservation = {
    schemaVersion: 1,
    organizationId: 'org-a',
    nodeId: 'node-a',
    operationId: 'operation-a',
    providerType: provider,
    providerImageId: 'provider-image-a',
    imageId: 'image-a',
    imageVersion: '2026.08.23',
    imageChecksum: `sha256:${'a'.repeat(64)}`,
    controlPlaneUrl: 'https://api.gridora.example',
    expectedControlPlaneHost: 'api.gridora.example',
    allowLoopbackHttp: false,
    agentVersion: '0.1.0',
    dockerSocket: '/var/run/docker.sock',
    pollWaitSeconds: 20,
    registrationExpiresAt: '2099-08-23T12:00:00Z',
    registrationToken: 'b'.repeat(64),
    commandSigningPublicKeyPem: key.publicKey,
  }
  const identity = {
    schemaVersion: 1,
    imageVersion: reservation.imageVersion,
    sourceCommit: 'd'.repeat(40),
    architecture: 'amd64',
    inputs: {
      agentSha256: '1'.repeat(64),
      cloudflaredSha256: '2'.repeat(64),
      nodeArchiveSha256: '3'.repeat(64),
      traefikSha256: '4'.repeat(64),
      ubuntuIsoSha256: '5'.repeat(64),
    },
  }
  const identityPath = join(root, 'etc/gridora/image-identity.json')
  const identitySignature = join(root, 'etc/gridora/image-identity.sig')
  await writeFile(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o444 })
  await writeFile(join(root, 'etc/gridora/image-identity-public.pem'), key.publicKey, {
    mode: 0o444,
  })
  await execute('openssl', [
    'pkeyutl',
    '-sign',
    '-inkey',
    key.privateKey,
    '-rawin',
    '-in',
    identityPath,
    '-out',
    identitySignature,
  ])
  await chmod(identitySignature, 0o444)
  const reservationPath = join(root, 'var/lib/gridora/bootstrap/reservation.json')
  await writeFile(reservationPath, `${JSON.stringify(reservation)}\n`, { mode: 0o600 })
  await chmod(reservationPath, 0o600)
  await writeFile(join(root, 'etc/gridora/image-version'), '2026.08.23\n', { mode: 0o644 })
  await writeFile(
    join(root, 'run/cloud-init/instance-data.json'),
    `${JSON.stringify({ v1: { instance_id: instanceId, platform, cloud_name: platform } })}\n`,
    { mode: 0o644 },
  )
  await writeFile(join(root, 'var/lib/cloud/data/instance-id'), `${instanceId}\n`, {
    mode: 0o644,
  })
  await writeFile(
    join(root, 'var/lib/cloud/instances/current/user-data.txt'),
    `cached-secret=${reservation.registrationToken}\n`,
    { mode: 0o600 },
  )
  await writeFile(
    join(root, 'run/cloud-init/instance-data-sensitive.json'),
    `{"secret":"${reservation.registrationToken}"}\n`,
    { mode: 0o600 },
  )
  await writeFile(join(root, 'var/log/cloud-init.log'), `token=${reservation.registrationToken}\n`)
  await writeFile(join(root, 'var/log/cloud-init-output.log'), 'bootstrap output\n')
  return { root, reservation, reservationPath }
}

const runBootstrap = async (root: string) =>
  execute(helper, [], {
    env: {
      ...process.env,
      GRIDORA_TEST_ROOT: root,
      GRIDORA_TEST_AGENT_UID: String(process.getuid?.() ?? 0),
      GRIDORA_TEST_AGENT_GID: String(process.getgid?.() ?? 0),
    },
  })

const runCleanup = async (root: string) =>
  execute(resolve(process.cwd(), 'infra/images/gridora-node-bootstrap-cleanup'), [], {
    env: {
      ...process.env,
      GRIDORA_TEST_ROOT: root,
      GRIDORA_TEST_AGENT_UID: String(process.getuid?.() ?? 0),
      GRIDORA_TEST_CLEANUP_HELPER: cacheCleanup,
    },
  })

const completeRegistration = async (root: string) => {
  const token = join(root, 'var/lib/gridora/bootstrap/registration-token')
  const authentication = join(root, 'var/lib/gridora/agent/node-credential')
  await mkdir(join(root, 'var/lib/gridora/agent'), { recursive: true })
  await writeFile(
    authentication,
    `${JSON.stringify({
      schemaVersion: 1,
      organizationId: 'org-a',
      nodeId: 'node-a',
      nodeCredential: 'c'.repeat(64),
      credentialId: 'credential-a',
      credentialVersion: 1,
      sessionVersion: 1,
    })}\n`,
    { mode: 0o600 },
  )
  await chmod(authentication, 0o600)
  await rm(token)
  await writeFile(
    join(root, 'var/lib/gridora/agent/registration-complete'),
    `${JSON.stringify({
      schemaVersion: 1,
      organizationId: 'org-a',
      nodeId: 'node-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
      sessionVersion: 1,
    })}\n`,
    { mode: 0o600 },
  )
}

const runHandoff = async (root: string) => {
  try {
    await runBootstrap(root)
  } catch (cause) {
    throw new Error(`bootstrap stage failed: ${String(cause)}`, { cause })
  }
  try {
    await completeRegistration(root)
    await runCleanup(root)
  } catch (cause) {
    throw new Error(`cleanup stage failed: ${String(cause)}`, { cause })
  }
}

describe('promoted image bootstrap handoff', () => {
  it('derives the provider identity and atomically hands bounded files to the agent', async () => {
    const { root, reservation, reservationPath } = await setup()

    await runHandoff(root)

    const configPath = join(root, 'etc/gridora/agent.json')
    const tokenPath = join(root, 'var/lib/gridora/bootstrap/registration-token')
    const publicPath = join(root, 'etc/gridora/command-signing-public.pem')
    const attestationPath = join(root, 'etc/gridora/image-attestation.json')
    const [config, publicKey, attestation, configStat, attestationStat] = await Promise.all([
      readFile(configPath, 'utf8').then(JSON.parse),
      readFile(publicPath, 'utf8'),
      readFile(attestationPath, 'utf8').then(JSON.parse),
      stat(configPath),
      stat(attestationPath),
    ])

    expect(config).toMatchObject({
      apiVersion: 'agent.gridora.dev/v1alpha1',
      organizationId: reservation.organizationId,
      nodeId: reservation.nodeId,
      providerInstanceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      registrationTokenFile: '/var/lib/gridora/bootstrap/registration-token',
      signingPublicKeyFile: '/etc/gridora/command-signing-public.pem',
    })
    await expect(access(tokenPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(publicKey).toContain('BEGIN PUBLIC KEY')
    expect(publicKey).not.toContain('PRIVATE KEY')
    expect(attestation).toEqual({
      schemaVersion: 1,
      imageId: reservation.imageId,
      imageVersion: reservation.imageVersion,
      checksum: reservation.imageChecksum,
      signatureVerified: true,
      buildIdentityManifestSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      buildIdentitySignatureSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      buildIdentityPublicKeySha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(configStat.mode & 0o777).toBe(0o600)
    expect(attestationStat.mode & 0o777).toBe(0o444)
    await expect(access(reservationPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(join(root, 'var/lib/cloud/instances/current/user-data.txt'), constants.F_OK),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed for malformed or conflicting provider instance IDs without a handoff', async () => {
    const malformed = await setup('contabo', '../123')
    await expect(runBootstrap(malformed.root)).rejects.toMatchObject({ stderr: expect.any(String) })
    await expect(
      access(join(malformed.root, 'etc/gridora/agent.json'), constants.F_OK),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const conflicting = await setup()
    await writeFile(join(conflicting.root, 'var/lib/cloud/data/instance-id'), 'another-id\n')
    await expect(runBootstrap(conflicting.root)).rejects.toMatchObject({
      stderr: expect.any(String),
    })
    await expect(
      access(join(conflicting.root, 'etc/gridora/agent.json'), constants.F_OK),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed for a wrong or tampered signed image identity', async () => {
    const wrong = await setup()
    const identityPath = join(wrong.root, 'etc/gridora/image-identity.json')
    const source = JSON.parse(await readFile(identityPath, 'utf8')) as Record<string, unknown>
    await chmod(identityPath, 0o600)
    await writeFile(identityPath, `${JSON.stringify({ ...source, imageVersion: 'wrong' })}\n`)
    await chmod(identityPath, 0o444)
    await expect(runBootstrap(wrong.root)).rejects.toMatchObject({ stderr: expect.any(String) })

    const tampered = await setup()
    const signaturePath = join(tampered.root, 'etc/gridora/image-identity.sig')
    await chmod(signaturePath, 0o600)
    await writeFile(signaturePath, 'not-a-signature\n')
    await chmod(signaturePath, 0o444)
    await expect(runBootstrap(tampered.root)).rejects.toMatchObject({ stderr: expect.any(String) })

    const wrongKey = await setup()
    const replacement = await makePublicKey(wrongKey.root)
    const publicPath = join(wrongKey.root, 'etc/gridora/image-identity-public.pem')
    await chmod(publicPath, 0o600)
    await writeFile(publicPath, replacement.publicKey)
    await chmod(publicPath, 0o444)
    await expect(runBootstrap(wrongKey.root)).rejects.toMatchObject({ stderr: expect.any(String) })
  })

  it('rejects a symlink destination and does not traverse outside the test root', async () => {
    const { root } = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'gridora-bootstrap-outside-'))
    roots.push(outside)
    const outsideConfig = join(outside, 'agent.json')
    await writeFile(outsideConfig, 'do-not-replace\n')
    await symlink(outsideConfig, join(root, 'etc/gridora/agent.json'))

    await expect(runBootstrap(root)).rejects.toMatchObject({ stderr: expect.any(String) })
    expect(await readFile(outsideConfig, 'utf8')).toBe('do-not-replace\n')
    expect((await lstat(join(root, 'etc/gridora/agent.json'))).isSymbolicLink()).toBe(true)
  })

  it('retries idempotently without recreating or exposing the one-time token', async () => {
    const { root, reservation } = await setup()
    await runHandoff(root)
    const firstConfig = await readFile(join(root, 'etc/gridora/agent.json'), 'utf8')
    await runBootstrap(root)
    await runCleanup(root)
    const secondConfig = await readFile(join(root, 'etc/gridora/agent.json'), 'utf8')

    expect(secondConfig).toBe(firstConfig)
    await expect(
      access(join(root, 'var/lib/gridora/bootstrap/registration-token'), constants.F_OK),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const persistentFiles = [
      'etc/gridora/agent.json',
      'etc/gridora/command-signing-public.pem',
      'etc/gridora/image-attestation.json',
      'var/lib/gridora/bootstrap/handoff.complete',
    ]
    for (const path of persistentFiles)
      expect(await readFile(join(root, path), 'utf8')).not.toContain(reservation.registrationToken)
  })

  it('preserves every registration source until the agent has durably consumed the token', async () => {
    const { root, reservationPath, reservation } = await setup()
    await runBootstrap(root)

    await expect(runCleanup(root)).rejects.toMatchObject({ stderr: expect.any(String) })
    expect(await readFile(reservationPath, 'utf8')).toContain(reservation.registrationToken)
    expect(await readFile(join(root, 'var/lib/gridora/bootstrap/registration-token'), 'utf8')).toBe(
      `${reservation.registrationToken}\n`,
    )
    expect(
      await readFile(join(root, 'var/lib/cloud/instances/current/user-data.txt'), 'utf8'),
    ).toContain(reservation.registrationToken)

    await completeRegistration(root)
    await runCleanup(root)
    await expect(access(reservationPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('orders cloud-final before bootstrap and bootstrap before the agent', async () => {
    const unitFiles = [
      'infra/images/systemd/gridora-node-bootstrap.service',
      'infra/images/systemd/gridora-agent.service',
      'infra/images/systemd/gridora-node-bootstrap-cleanup.service',
    ]
    const edges = new Map<string, Set<string>>()
    const add = (before: string, after: string) => {
      const next = edges.get(before) ?? new Set<string>()
      next.add(after)
      edges.set(before, next)
    }
    for (const file of unitFiles) {
      const unit = basename(file)
      const source = await readFile(resolve(process.cwd(), file), 'utf8')
      for (const line of source.split('\n')) {
        if (line.startsWith('After='))
          for (const dependency of line.slice('After='.length).split(/\s+/)) add(dependency, unit)
        if (line.startsWith('Before='))
          for (const dependency of line.slice('Before='.length).split(/\s+/)) add(unit, dependency)
      }
    }
    const reachable = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true
      if (seen.has(from)) return false
      seen.add(from)
      return [...(edges.get(from) ?? [])].some((next) => reachable(next, target, seen))
    }

    expect(reachable('cloud-final.service', 'gridora-node-bootstrap.service')).toBe(true)
    expect(reachable('gridora-node-bootstrap.service', 'gridora-agent.service')).toBe(true)
    expect(reachable('gridora-agent.service', 'gridora-node-bootstrap.service')).toBe(false)
    const pathUnit = await readFile(
      resolve(process.cwd(), 'infra/images/systemd/gridora-node-bootstrap-cleanup.path'),
      'utf8',
    )
    expect(pathUnit).toContain('PathExists=/var/lib/gridora/agent/registration-complete')
  })
})

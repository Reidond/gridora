import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectFirewallFromSocket, inspectImageAttestation } from '../src/observation-node.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const withProofServer = async <A>(
  response: string,
  run: (socketPath: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), 'gridora-firewall-proof-'))
  temporary.push(directory)
  const socketPath = join(directory, 'firewall-observation.sock')
  const server = createServer((socket) => socket.end(response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o660)
  try {
    return await run(socketPath)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }
}

describe('root firewall observation client', () => {
  it('accepts one exact bounded proof from the fixed-operation Unix protocol', async () => {
    const proof = `${JSON.stringify({
      schemaVersion: 1,
      defaultDeny: true,
      allowedTcpPorts: [22, 2302],
      allowedUdpPorts: [2001, 2302],
      rulesetSha256: `sha256:${'a'.repeat(64)}`,
      ready: true,
    })}\n`
    await expect(
      withProofServer(proof, (socketPath) =>
        inspectFirewallFromSocket({
          socketPath,
          expectedOwnerUid: process.getuid?.() ?? -1,
        }),
      ),
    ).resolves.toEqual({
      defaultDeny: true,
      allowedTcpPorts: [22, 2302],
      allowedUdpPorts: [2001, 2302],
      ready: true,
    })
  })

  it('rejects excess fields, unsorted ports, invalid framing, and oversized responses', async () => {
    const invalid = [
      `${JSON.stringify({
        schemaVersion: 1,
        defaultDeny: true,
        allowedTcpPorts: [2302, 22],
        allowedUdpPorts: [],
        rulesetSha256: `sha256:${'a'.repeat(64)}`,
        ready: true,
      })}\n`,
      `${JSON.stringify({
        schemaVersion: 1,
        defaultDeny: true,
        allowedTcpPorts: [],
        allowedUdpPorts: [],
        rulesetSha256: `sha256:${'a'.repeat(64)}`,
        ready: true,
        ignored: true,
      })}\n`,
      JSON.stringify({
        schemaVersion: 1,
        defaultDeny: true,
        allowedTcpPorts: [],
        allowedUdpPorts: [],
        rulesetSha256: `sha256:${'a'.repeat(64)}`,
        ready: true,
      }),
      `${'x'.repeat(17 * 1024)}\n`,
    ]
    for (const response of invalid)
      await expect(
        withProofServer(response, (socketPath) =>
          inspectFirewallFromSocket({
            socketPath,
            expectedOwnerUid: process.getuid?.() ?? -1,
          }),
        ),
      ).rejects.toBeDefined()
  })
})

describe('promoted image attestation probe', () => {
  it('requires a root-owned verified attestation matching the installed version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-image-proof-'))
    temporary.push(directory)
    const attestationPath = join(directory, 'image-attestation.json')
    const versionPath = join(directory, 'image-version')
    await writeFile(
      attestationPath,
      JSON.stringify({
        schemaVersion: 1,
        imageId: 'image-a',
        imageVersion: '2026.08.23',
        checksum: `sha256:${'a'.repeat(64)}`,
        signatureVerified: true,
        buildIdentityManifestSha256: `sha256:${'b'.repeat(64)}`,
        buildIdentitySignatureSha256: `sha256:${'c'.repeat(64)}`,
        buildIdentityPublicKeySha256: `sha256:${'d'.repeat(64)}`,
      }),
      { mode: 0o444 },
    )
    await writeFile(versionPath, '2026.08.23\n', { mode: 0o444 })
    const options = {
      attestationPath,
      versionPath,
      expectedOwnerUid: process.getuid?.() ?? -1,
    }
    await expect(inspectImageAttestation(options)).resolves.toMatchObject({
      imageId: 'image-a',
      signatureVerified: true,
      buildIdentityManifestSha256: `sha256:${'b'.repeat(64)}`,
      buildIdentitySignatureSha256: `sha256:${'c'.repeat(64)}`,
      buildIdentityPublicKeySha256: `sha256:${'d'.repeat(64)}`,
      ready: true,
    })
    await chmod(versionPath, 0o644)
    await writeFile(versionPath, 'different-version\n')
    await chmod(versionPath, 0o444)
    await expect(inspectImageAttestation(options)).rejects.toBeDefined()
  })

  it('rejects an unverified or malformed image identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-image-proof-'))
    temporary.push(directory)
    const attestationPath = join(directory, 'image-attestation.json')
    const versionPath = join(directory, 'image-version')
    await writeFile(
      attestationPath,
      JSON.stringify({
        schemaVersion: 1,
        imageId: 'image-a',
        imageVersion: '2026.08.23',
        checksum: `sha256:${'a'.repeat(64)}`,
        signatureVerified: false,
        buildIdentityManifestSha256: `sha256:${'b'.repeat(64)}`,
        buildIdentitySignatureSha256: `sha256:${'c'.repeat(64)}`,
        buildIdentityPublicKeySha256: `sha256:${'d'.repeat(64)}`,
      }),
      { mode: 0o444 },
    )
    await writeFile(versionPath, '2026.08.23\n', { mode: 0o444 })
    await expect(
      inspectImageAttestation({
        attestationPath,
        versionPath,
        expectedOwnerUid: process.getuid?.() ?? -1,
      }),
    ).rejects.toBeDefined()
  })
})

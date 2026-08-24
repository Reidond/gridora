import { beforeAll, describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  generateTunnelCredentialNodeKeyPair,
  sealTunnelCredential,
  withOpenedTunnelCredential,
  type TunnelCredentialEnvelopeCoordinates,
  type TunnelCredentialNodeKeyPair,
} from '../src/index.js'

const coordinates: TunnelCredentialEnvelopeCoordinates = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  tunnelId: 'tunnel-a',
  operationId: 'operation-a',
  revision: 1,
}
let nodeA: TunnelCredentialNodeKeyPair
let nodeB: TunnelCredentialNodeKeyPair

beforeAll(async () => {
  ;[nodeA, nodeB] = await Promise.all([
    Effect.runPromise(generateTunnelCredentialNodeKeyPair()),
    Effect.runPromise(generateTunnelCredentialNodeKeyPair()),
  ])
})

const open = (key: string, scope: TunnelCredentialEnvelopeCoordinates, envelope: string) =>
  Effect.runPromise(
    withOpenedTunnelCredential(key, scope, envelope, (plaintext) =>
      Effect.succeed(new TextDecoder().decode(plaintext)),
    ),
  )

describe('node-specific tunnel credential envelope', () => {
  it('round-trips with coordinate-bound authenticated data', async () => {
    const envelope = await Effect.runPromise(
      sealTunnelCredential(nodeA.publicKey, coordinates, 'secret-tunnel-token'),
    )
    expect(envelope).not.toContain('secret-tunnel-token')
    await expect(open(nodeA.privateKey, coordinates, envelope)).resolves.toBe('secret-tunnel-token')
  })

  it('rejects ciphertext for another node key or authenticated scope', async () => {
    const envelope = await Effect.runPromise(
      sealTunnelCredential(nodeA.publicKey, coordinates, 'secret-tunnel-token'),
    )
    await expect(open(nodeB.privateKey, coordinates, envelope)).rejects.toMatchObject({
      message: 'tunnel credential envelope operation failed',
    })
    await expect(
      open(nodeA.privateKey, { ...coordinates, nodeId: 'node-b' }, envelope),
    ).rejects.toMatchObject({ message: 'tunnel credential envelope operation failed' })
    await expect(
      open(nodeA.privateKey, { ...coordinates, revision: 2 }, envelope),
    ).rejects.toMatchObject({ message: 'tunnel credential envelope operation failed' })
  })

  it('rejects tampering with a generic error that does not disclose credential material', async () => {
    const envelope = await Effect.runPromise(
      sealTunnelCredential(nodeA.publicKey, coordinates, 'never-render-this-token'),
    )
    const tail = envelope.at(-1)
    const tampered = `${envelope.slice(0, -1)}${tail === 'A' ? 'B' : 'A'}`
    let caught: unknown
    try {
      await open(nodeA.privateKey, coordinates, tampered)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ message: 'tunnel credential envelope operation failed' })
    expect(JSON.stringify(caught)).not.toContain('never-render-this-token')
  })
})

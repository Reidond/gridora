import { canonicalCommandPayload } from '@gridora/agent-protocol'
import { describe, expect, it } from 'vitest'
import {
  ed25519CommandSigner,
  produceSignedAgentCommand,
  type CommandSigner,
  type LifecycleCommandEnvelope,
} from '../src/command-producer.js'

const envelope: LifecycleCommandEnvelope = {
  operationId: 'op-backup-1',
  organizationId: 'org-1',
  nodeId: 'node-1',
  resourceId: 'server-1',
  stepId: 'stream-encrypted-backup',
  issuedAt: '2026-08-23T12:00:00.000Z',
  expiresAt: '2026-08-23T12:10:00.000Z',
  expectedPriorRevision: 4,
  plugin: { id: 'arma-reforger', version: '1.0.0' },
}

const digestSigner: CommandSigner = async (canonicalPayload) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const backupSpec = (diskBytes: number) => ({
  type: 'backup.create' as const,
  payload: {
    backupId: 'backup-1',
    pluginId: 'arma-reforger',
    pluginVersion: '1.0.0',
    consistency: 'plugin-quiesced' as const,
    files: ['config', 'data', 'mods', 'state'] as const,
    diskBytes,
  },
})

describe('lifecycle AgentCommand producer', () => {
  it('produces an idempotent signed backup command whose signature covers diskBytes', async () => {
    const first = await produceSignedAgentCommand(envelope, backupSpec(8 * 1024 ** 3), digestSigner)
    const replay = await produceSignedAgentCommand(
      envelope,
      backupSpec(8 * 1024 ** 3),
      digestSigner,
    )
    expect(replay).toEqual(first)
    expect(first.type).toBe('backup.create')
    expect(first.payload).toMatchObject({ diskBytes: 8 * 1024 ** 3 })
    expect(canonicalCommandPayload(first)).toContain(`"diskBytes":${8 * 1024 ** 3}`)
    expect(first.signature).toBe(await digestSigner(canonicalCommandPayload(first)))
  })

  it('keeps the logical command identity stable but exposes payload drift to coordinator fencing', async () => {
    const original = await produceSignedAgentCommand(
      envelope,
      backupSpec(8 * 1024 ** 3),
      digestSigner,
    )
    const changed = await produceSignedAgentCommand(
      envelope,
      backupSpec(16 * 1024 ** 3),
      digestSigner,
    )
    expect(changed.commandId).toBe(original.commandId)
    expect(changed.idempotencyKey).toBe(original.idempotencyKey)
    expect(changed.signature).not.toBe(original.signature)
    expect(canonicalCommandPayload(changed)).not.toBe(canonicalCommandPayload(original))
  })

  it('rejects an invalid disk budget before signing', async () => {
    let signed = false
    await expect(
      produceSignedAgentCommand(envelope, backupSpec(0), async () => {
        signed = true
        return 'x'.repeat(64)
      }),
    ).rejects.toBeDefined()
    expect(signed).toBe(false)
  })

  it('emits valid canonical JSON for commands without an optional plugin', async () => {
    const command = await produceSignedAgentCommand(
      { ...envelope, plugin: undefined },
      {
        type: 'health.inspect',
        payload: {},
      },
      digestSigner,
    )
    expect(() => JSON.parse(canonicalCommandPayload(command))).not.toThrow()
    expect(command).not.toHaveProperty('plugin')
  })

  it('rejects deployment payloads that are not bound to the workflow target', async () => {
    await expect(
      produceSignedAgentCommand(
        envelope,
        {
          type: 'deployment.apply',
          payload: {
            apiVersion: 'agent.gridora.dev/v1alpha1',
            organizationId: 'other-org',
            nodeId: 'node-1',
            serverId: 'server-1',
            deploymentId: 'deployment-1',
            operationId: 'op-backup-1',
            revision: 1,
            plugin: {
              id: 'arma-reforger',
              version: '1.0.0',
              apiVersion: 'gridora.plugin/v1alpha1',
            },
            image: { installer: `sha256:${'a'.repeat(64)}`, runtime: `sha256:${'b'.repeat(64)}` },
            ports: [],
            mounts: [],
            resources: { cpu: 1, memoryMiB: 1024, pids: 256, diskGiB: 20 },
            expiresAt: '2026-08-23T12:10:00.000Z',
          },
        },
        digestSigner,
      ),
    ).rejects.toThrow('not bound')
  })

  it('creates a real Ed25519 signer compatible with the signed canonical bytes', async () => {
    const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    if (!('privateKey' in generated)) throw new Error('Expected an Ed25519 key pair')
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey))
    let binary = ''
    for (const byte of pkcs8) binary += String.fromCharCode(byte)
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`
    const signer = await ed25519CommandSigner(pem)
    const canonical = 'signed lifecycle command bytes'
    const signature = Uint8Array.from(atob(await signer(canonical)), (character) =>
      character.charCodeAt(0),
    )
    await expect(
      crypto.subtle.verify(
        { name: 'Ed25519' },
        generated.publicKey,
        signature,
        new TextEncoder().encode(canonical),
      ),
    ).resolves.toBe(true)
  })
})

import { generateKeyPairSync, sign } from 'node:crypto'
import { BackupExecutor } from '@gridora/backup-runtime'
import { canonicalCommandPayload, type AgentCommand } from '@gridora/agent-protocol'
import { DockerEngine } from '@gridora/docker-runtime'
import {
  AtomicCredentialInstallerLayer,
  type AtomicCredentialInstallerShape,
  type TunnelCredentialInstallPayload,
  type TunnelCredentialRevokePayload,
} from '@gridora/tunnel-credential'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { CommandExecutorLive } from '../src/executor.js'
import { NodeHealthProbe, healthStatus } from '../src/health.js'
import { handleCommand } from '../src/processor.js'
import {
  AgentSelfUpdate,
  BackupArchiveUploader,
  Ed25519SignatureVerifier,
  FixedAgentClock,
  MemoryCommandState,
} from '../src/services.js'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const now = new Date('2026-08-23T10:00:00Z')
const sealedCredential = `v1.${'A'.repeat(32)}.${'B'.repeat(16)}.${'C'.repeat(48)}`

const signCommand = (command: AgentCommand): AgentCommand => ({
  ...command,
  signature: sign(null, Buffer.from(canonicalCommandPayload(command)), keys.privateKey).toString(
    'base64',
  ),
})

const installCommand = (): AgentCommand => {
  const payload: TunnelCredentialInstallPayload = {
    apiVersion: 'tunnel.gridora.dev/v1alpha1',
    action: 'install',
    deliveryId: 'tunnel-command-1',
    organizationId: 'org-1',
    nodeId: 'node-1',
    tunnelId: 'tunnel-1',
    operationId: 'tunnel-operation-1',
    revision: 1,
    expectedPriorRevision: 0,
    expiresAt: '2026-08-23T11:00:00Z',
    sealedCredential,
    destination: {
      path: '/var/lib/gridora/tunnel/credential',
      owner: 'root',
      group: 'root',
      mode: '0600',
    },
  }
  return signCommand({
    apiVersion: 'agent.gridora.dev/v1alpha1',
    commandId: payload.deliveryId,
    operationId: payload.operationId,
    organizationId: payload.organizationId,
    nodeId: payload.nodeId,
    resourceId: payload.tunnelId,
    type: 'tunnel.credential.install',
    payloadSchemaVersion: 1,
    issuedAt: '2026-08-23T09:00:00Z',
    expiresAt: payload.expiresAt,
    idempotencyKey: payload.deliveryId,
    expectedPriorRevision: payload.expectedPriorRevision,
    payload,
    signature: 'pending-signature'.repeat(3),
  })
}

const revokeCommand = (): AgentCommand => {
  const payload: TunnelCredentialRevokePayload = {
    apiVersion: 'tunnel.gridora.dev/v1alpha1',
    action: 'revoke',
    deliveryId: 'tunnel-command-2',
    organizationId: 'org-1',
    nodeId: 'node-1',
    tunnelId: 'tunnel-1',
    operationId: 'tunnel-operation-2',
    revision: 2,
    expectedPriorRevision: 1,
    expiresAt: '2026-08-23T11:00:00Z',
  }
  return signCommand({
    apiVersion: 'agent.gridora.dev/v1alpha1',
    commandId: payload.deliveryId,
    operationId: payload.operationId,
    organizationId: payload.organizationId,
    nodeId: payload.nodeId,
    resourceId: payload.tunnelId,
    type: 'tunnel.credential.revoke',
    payloadSchemaVersion: 1,
    issuedAt: '2026-08-23T09:00:00Z',
    expiresAt: payload.expiresAt,
    idempotencyKey: payload.deliveryId,
    expectedPriorRevision: payload.expectedPriorRevision,
    payload,
    signature: 'pending-signature'.repeat(3),
  })
}

const harness = () => {
  const installed: TunnelCredentialInstallPayload[] = []
  const revoked: TunnelCredentialRevokePayload[] = []
  const installer: AtomicCredentialInstallerShape = {
    install: (command) =>
      Effect.sync(() => {
        installed.push(command)
        return {
          organizationId: command.organizationId,
          nodeId: command.nodeId,
          tunnelId: command.tunnelId,
          operationId: command.operationId,
          deliveryId: command.deliveryId,
          revision: command.revision,
          owner: 'root',
          group: 'root',
          mode: '0600',
          usedAtomicRename: true,
          fsyncedFile: true,
          fsyncedDirectory: true,
          activated: true,
          healthChecked: true,
          healthy: true,
          alreadyInstalled: false,
        }
      }),
    revoke: (command) =>
      Effect.sync(() => {
        revoked.push(command)
        return { removed: true, activationStopped: true, alreadyRevoked: false }
      }),
  }
  const executor = CommandExecutorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DockerEngine, {
          apply: () => Effect.die('unused'),
          start: () => Effect.die('unused'),
          stop: () => Effect.die('unused'),
          remove: () => Effect.die('unused'),
        }),
        Layer.succeed(BackupExecutor, {
          create: () => Effect.die('unused'),
          stageRestore: () => Effect.die('unused'),
          commitRestore: () => Effect.die('unused'),
          rollbackRestore: () => Effect.die('unused'),
          finalizeRestore: () => Effect.die('unused'),
          restore: () => Effect.die('unused'),
        }),
        Layer.succeed(BackupArchiveUploader, {
          upload: () => Effect.die('unused'),
          download: () => Effect.die('unused'),
        }),
        AtomicCredentialInstallerLayer(installer),
        Layer.succeed(NodeHealthProbe, {
          inspect: Effect.succeed(
            healthStatus({
              version: 'test',
              organizationId: 'org-1',
              nodeId: 'node-1',
              docker: { reachable: true },
              disk: { availableBytes: 90, totalBytes: 100 },
              checkedAt: now.toISOString(),
            }),
          ),
        }),
        Layer.succeed(AgentSelfUpdate, {
          apply: () => Effect.die('unused'),
        }),
      ),
    ),
  )
  const layer = Layer.mergeAll(
    FixedAgentClock(now),
    Ed25519SignatureVerifier(publicKey),
    MemoryCommandState(),
    executor,
  )
  const run = (command: unknown) =>
    Effect.runPromise(
      handleCommand(command, { organizationId: 'org-1', nodeId: 'node-1' }).pipe(
        Effect.provide(layer),
      ),
    )
  return { installed, revoked, run }
}

describe('signed tunnel credential command dispatch', () => {
  it('forwards only the sealed install payload and persistently deduplicates delivery', async () => {
    const test = harness()
    const command = installCommand()
    const first = await test.run(command)
    expect(first).toMatchObject({
      status: 'succeeded',
      revision: 1,
      code: 'tunnel-credential-installed',
    })
    expect(test.installed).toEqual([command.payload])
    expect(JSON.stringify(first)).not.toContain(sealedCredential)
    await expect(test.run(command)).resolves.toMatchObject({ duplicate: true })
    expect(test.installed).toHaveLength(1)
  })

  it('dispatches a bound revoke after the install revision', async () => {
    const test = harness()
    await test.run(installCommand())
    await expect(test.run(revokeCommand())).resolves.toMatchObject({
      status: 'succeeded',
      revision: 2,
      code: 'tunnel-credential-revoked',
    })
    expect(test.revoked).toHaveLength(1)
  })

  it('rejects tampering, cross-tunnel binding, and excess payload fields before dispatch', async () => {
    const tamperedTest = harness()
    const signed = installCommand()
    await expect(
      tamperedTest.run({
        ...signed,
        payload: { ...(signed.payload as object), sealedCredential: `${sealedCredential}A` },
      }),
    ).rejects.toMatchObject({ code: 'invalid-signature' })
    expect(tamperedTest.installed).toHaveLength(0)

    for (const payloadChange of [{ tunnelId: 'tunnel-2' }, { ignored: true }]) {
      const test = harness()
      const original = installCommand()
      const rebound = signCommand({
        ...original,
        payload: { ...(original.payload as object), ...payloadChange },
      })
      await expect(test.run(rebound)).resolves.toMatchObject({ status: 'rejected' })
      expect(test.installed).toHaveLength(0)
    }
  })
})

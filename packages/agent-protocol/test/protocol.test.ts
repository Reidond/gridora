import { describe, expect, it } from 'vitest'
import { Effect, Schema } from 'effect'
import {
  BackupCreatePayload,
  canonicalJson,
  decodeDeploymentSpec,
  decodeTunnelCredentialAgentCommand,
} from '../src/index.js'

describe('canonicalJson', () => {
  it('is stable across object key order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
    )
  })
  it('rejects lexical traversal before a deployment reaches the runtime', async () => {
    await expect(
      Effect.runPromise(
        decodeDeploymentSpec({
          apiVersion: 'agent.gridora.dev/v1alpha1',
          organizationId: 'org',
          nodeId: 'node',
          serverId: 'server',
          deploymentId: 'deployment',
          operationId: 'operation',
          revision: 1,
          plugin: { id: 'game', version: '1', apiVersion: 'gridora.plugin/v1alpha1' },
          image: { installer: `sha256:${'a'.repeat(64)}`, runtime: `sha256:${'b'.repeat(64)}` },
          ports: [],
          mounts: [
            {
              source: '/var/lib/gridora/servers/server/game/../../other/data',
              target: '/game',
              readOnly: false,
            },
          ],
          resources: { cpu: 1, memoryMiB: 128, pids: 16, diskGiB: 1 },
          expiresAt: '2026-08-24T00:00:00Z',
        }),
      ),
    ).rejects.toBeDefined()
  })
  it('requires the signed server disk policy on backup commands', async () => {
    const command = {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: 'command',
      operationId: 'operation',
      organizationId: 'org',
      nodeId: 'node',
      resourceId: 'server',
      type: 'backup.create',
      payloadSchemaVersion: 1,
      issuedAt: '2026-08-23T09:00:00Z',
      expiresAt: '2026-08-23T11:00:00Z',
      idempotencyKey: 'idem',
      expectedPriorRevision: 1,
      payload: {
        backupId: 'backup',
        pluginId: 'game',
        pluginVersion: '1',
        consistency: 'crash-consistent',
        files: ['data'],
      },
      signature: 's'.repeat(64),
    }
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(BackupCreatePayload)(command.payload)),
    ).rejects.toBeDefined()
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(BackupCreatePayload)({ ...command.payload, diskBytes: 1024 }),
      ),
    ).resolves.toBeDefined()
  })
  it('accepts only exact sealed tunnel install and revoke command variants', async () => {
    const common = {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: 'delivery-1',
      operationId: 'operation-1',
      organizationId: 'org-1',
      nodeId: 'node-1',
      resourceId: 'tunnel-1',
      payloadSchemaVersion: 1,
      issuedAt: '2026-08-23T09:00:00Z',
      expiresAt: '2026-08-23T11:00:00Z',
      idempotencyKey: 'delivery-1',
      expectedPriorRevision: 0,
      signature: 's'.repeat(64),
    }
    const install = {
      ...common,
      type: 'tunnel.credential.install',
      payload: {
        apiVersion: 'tunnel.gridora.dev/v1alpha1',
        action: 'install',
        deliveryId: common.commandId,
        organizationId: common.organizationId,
        nodeId: common.nodeId,
        tunnelId: common.resourceId,
        operationId: common.operationId,
        revision: 1,
        expectedPriorRevision: 0,
        expiresAt: common.expiresAt,
        sealedCredential: `v1.${'A'.repeat(32)}.${'B'.repeat(16)}.${'C'.repeat(48)}`,
        destination: {
          path: '/var/lib/gridora/tunnel/credential',
          owner: 'root',
          group: 'root',
          mode: '0600',
        },
      },
    }
    await expect(
      Effect.runPromise(decodeTunnelCredentialAgentCommand(install)),
    ).resolves.toMatchObject({ type: 'tunnel.credential.install' })
    await expect(
      Effect.runPromise(
        decodeTunnelCredentialAgentCommand({
          ...install,
          payload: { ...install.payload, action: 'revoke' },
        }),
      ),
    ).rejects.toBeDefined()
    await expect(
      Effect.runPromise(decodeTunnelCredentialAgentCommand({ ...install, ignored: true })),
    ).rejects.toBeDefined()

    const revoke = {
      ...common,
      commandId: 'delivery-2',
      operationId: 'operation-2',
      type: 'tunnel.credential.revoke',
      expectedPriorRevision: 1,
      payload: {
        apiVersion: 'tunnel.gridora.dev/v1alpha1',
        action: 'revoke',
        deliveryId: 'delivery-2',
        organizationId: common.organizationId,
        nodeId: common.nodeId,
        tunnelId: common.resourceId,
        operationId: 'operation-2',
        revision: 2,
        expectedPriorRevision: 1,
        expiresAt: common.expiresAt,
      },
    }
    await expect(
      Effect.runPromise(decodeTunnelCredentialAgentCommand(revoke)),
    ).resolves.toMatchObject({ type: 'tunnel.credential.revoke' })
  })
})

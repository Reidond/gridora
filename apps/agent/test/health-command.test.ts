import { BackupExecutor } from '@gridora/backup-runtime'
import type { AgentCommand } from '@gridora/agent-protocol'
import { DockerEngine } from '@gridora/docker-runtime'
import { AtomicCredentialInstallerLayer } from '@gridora/tunnel-credential'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { CommandExecutorLive } from '../src/executor.js'
import { NodeHealthProbe, healthStatus, type AgentHealth } from '../src/health.js'
import { AgentSelfUpdate, BackupArchiveUploader, CommandExecutor } from '../src/services.js'

const command: AgentCommand = {
  apiVersion: 'agent.gridora.dev/v1alpha1',
  commandId: 'health-1',
  operationId: 'health-operation-1',
  organizationId: 'org-1',
  nodeId: 'node-1',
  resourceId: 'node-1',
  type: 'health.inspect',
  payloadSchemaVersion: 1,
  issuedAt: '2026-08-23T09:00:00Z',
  expiresAt: '2026-08-23T11:00:00Z',
  idempotencyKey: 'health-1',
  expectedPriorRevision: null,
  payload: {},
  signature: 's'.repeat(64),
}

const execute = (health: AgentHealth) => {
  const dependencies = Layer.mergeAll(
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
    AtomicCredentialInstallerLayer({
      install: () => Effect.die('unused'),
      revoke: () => Effect.die('unused'),
    }),
    Layer.succeed(NodeHealthProbe, { inspect: Effect.succeed(health) }),
    Layer.succeed(AgentSelfUpdate, {
      apply: () => Effect.die('unused'),
    }),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* CommandExecutor).execute(command)
    }).pipe(Effect.provide(CommandExecutorLive.pipe(Layer.provide(dependencies)))),
  )
}

const observed = (docker: AgentHealth['docker'], disk: AgentHealth['disk']): AgentHealth =>
  healthStatus({
    version: 'test',
    organizationId: 'org-1',
    nodeId: 'node-1',
    docker,
    disk,
    checkedAt: '2026-08-23T10:00:00Z',
  })

describe('health.inspect execution', () => {
  it('reports agent responsiveness separately from unavailable Docker and game health', async () => {
    await expect(
      execute(observed({ reachable: false }, { availableBytes: 90, totalBytes: 100 })),
    ).resolves.toEqual({
      revision: null,
      code: 'agent-responsive-node-unhealthy',
      message: 'agent is responsive; node health is unhealthy; game health was not inspected',
    })
  })

  it('reports low disk as degraded without claiming game health', async () => {
    await expect(
      execute(observed({ reachable: true }, { availableBytes: 9, totalBytes: 100 })),
    ).resolves.toEqual({
      revision: null,
      code: 'agent-responsive-node-degraded',
      message: 'agent is responsive; node health is degraded; game health was not inspected',
    })
  })
})

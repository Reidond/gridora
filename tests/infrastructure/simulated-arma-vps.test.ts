import { readFile } from 'node:fs/promises'
import dgram from 'node:dgram'
import { Effect } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'
import {
  makeGameRuntime,
  NodeGameFileWriter,
  NodeGameModWriter,
  NodeGameProcessRunner,
} from '../../apps/agent/src/game-runtime.js'
import {
  createContainerPlan,
  DockerEngine,
  NodeDockerEngine,
  PROJECT_QUOTA_API_VERSION,
  type ProjectQuotaClient,
} from '../../packages/docker-runtime/src/index.js'
import type { DeploymentSpec } from '../../packages/agent-protocol/src/index.js'

const image = process.env.GRIDORA_SIMULATED_ARMA_IMAGE
const enabled = image !== undefined
const serverId = 'server-acceptance'
const serverRoot = `/var/lib/gridora/servers/${serverId}`
const organizationId = 'organization-acceptance'
const deploymentId = 'deployment-acceptance'

const quota: ProjectQuotaClient = {
  ensure: (request) =>
    Promise.resolve({
      apiVersion: PROJECT_QUOTA_API_VERSION,
      serverId: request.serverId,
      root: `/var/lib/gridora/servers/${request.serverId}`,
      projectId: 42001,
      hardBytes: request.requestedBytes,
      method: 'ext4-project-quota',
      enforced: true,
    }),
}

const docker = <A>(effect: Effect.Effect<A, unknown, DockerEngine>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeDockerEngine('/var/run/docker.sock', quota))))

const udpRoundTrip = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const finish = (result: { readonly value: string } | { readonly error: Error }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(retry)
      socket.close()
      if ('error' in result) reject(result.error)
      else resolve(result.value)
    }
    const timeout = setTimeout(() => {
      finish({ error: new Error(`UDP ${port} did not answer`) })
    }, 5_000)
    socket.once('error', (error) => {
      finish({ error })
    })
    socket.once('message', (message) => {
      finish({ value: message.toString('utf8') })
    })
    const send = () => socket.send(Buffer.from('probe'), port, '127.0.0.1')
    const retry = setInterval(send, 100)
    send()
  })

describe.skipIf(!enabled)('simulated Arma VPS acceptance', () => {
  const actualRunner = NodeGameProcessRunner('/var/run/docker.sock', {
    acquire: () => Effect.succeed({ release: Effect.void }),
  })
  const processRunner = {
    run: (
      plan: Parameters<typeof actualRunner.run>[0],
      input: Parameters<typeof actualRunner.run>[1],
    ) => actualRunner.run(plan, { ...input, image: image! }),
  }
  const runtime = makeGameRuntime(
    processRunner,
    NodeGameFileWriter('/var/lib/gridora/servers'),
    NodeGameModWriter('/var/lib/gridora/servers'),
  )
  const spec: DeploymentSpec = {
    apiVersion: 'agent.gridora.dev/v1alpha1',
    organizationId,
    nodeId: 'node-acceptance',
    serverId,
    deploymentId,
    operationId: 'install-acceptance',
    revision: 1,
    plugin: {
      id: 'arma-reforger',
      version: '0.1.0',
      apiVersion: 'gridora.plugin/v1alpha1',
    },
    image: { installer: image!, runtime: image! },
    ports: [
      { host: 32_001, container: 2_001, protocol: 'udp' },
      { host: 31_777, container: 17_777, protocol: 'udp' },
    ],
    mounts: ['game', 'config', 'data', 'mods', 'staging', 'backups', 'state'].map((name) => ({
      source: `${serverRoot}/${name}`,
      target: `/work/${name}`,
      readOnly: false,
    })),
    resources: { cpu: 1, memoryMiB: 256, pids: 64, diskGiB: 1 },
    expiresAt: '2026-08-25T00:00:00Z',
  }

  afterAll(async () => {
    await docker(
      Effect.gen(function* () {
        const engine = yield* DockerEngine
        yield* engine.stop({ organizationId, serverId, deploymentId }).pipe(Effect.ignore)
        yield* engine.remove({ organizationId, serverId, deploymentId }).pipe(Effect.ignore)
      }),
    )
  })

  it('installs, configures, starts, probes, updates, rolls back, and stops the reviewed plugin', async () => {
    await expect(readFile('/run/gridora-simulated-vps/firewall.rules', 'utf8')).resolves.toMatch(
      /chain forward[\s\S]*policy drop/,
    )
    await expect(readFile('/run/gridora-simulated-vps/firewall.rules', 'utf8')).resolves.toContain(
      'permitted_game_egress_v4',
    )
    await expect(Effect.runPromise(runtime.install(spec))).resolves.toMatchObject({
      revision: 1,
      code: 'plugin-installed-build-1874900001',
    })
    await expect(
      Effect.runPromise(
        runtime.applyConfig(serverId, {
          operationId: 'config-acceptance-1',
          serverId,
          deploymentId,
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          configRevision: 1,
          config: {
            name: 'Gridora acceptance',
            scenarioId: 'Conflict',
            maxPlayers: 32,
            visible: false,
            crossPlatform: true,
          },
        }),
      ),
    ).resolves.toMatchObject({ code: 'config-activated', revision: 1 })
    await expect(
      Effect.runPromise(
        runtime.syncMods(serverId, {
          operationId: 'mods-acceptance-1',
          serverId,
          deploymentId,
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          image: image!,
          modRevision: 1,
          mods: [
            {
              source: 'reforger.armaplatform.com',
              id: 'A1B2C3D4E5F60708',
              loadOrder: 1,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ code: 'mods-activated', revision: 1 })

    await docker(
      Effect.gen(function* () {
        const engine = yield* DockerEngine
        yield* engine.apply(createContainerPlan(spec))
      }),
    )

    await expect(udpRoundTrip(32_001)).resolves.toBe('GRIDORA_ARMA_ACCEPTANCE:probe')
    await expect(udpRoundTrip(31_777)).resolves.toBe('GRIDORA_ARMA_ACCEPTANCE:probe')
    await expect(
      Effect.runPromise(
        runtime.inspectHealth(serverId, 'arma-reforger', '0.1.0', 'health-acceptance-1'),
      ),
    ).resolves.toMatchObject({
      status: 'healthy',
      protocol: true,
      build: '1874900001',
      scenario: 'Conflict',
    })

    await expect(
      Effect.runPromise(
        runtime.update(serverId, {
          operationId: 'update-acceptance-1',
          serverId,
          deploymentId,
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          image: image!,
          backupBeforeUpdate: true,
        }),
      ),
    ).resolves.toMatchObject({ code: 'updated-after-backup' })

    await expect(
      Effect.runPromise(
        runtime.applyConfig(serverId, {
          operationId: 'config-acceptance-2',
          serverId,
          deploymentId,
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          configRevision: 2,
          config: {
            name: 'FAIL_VALIDATION',
            scenarioId: 'Conflict',
            maxPlayers: 32,
            visible: false,
            crossPlatform: true,
          },
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'AgentError' })
    await expect(readFile(`${serverRoot}/state/active-config-revision`, 'utf8')).resolves.toBe(
      '1\n',
    )
    await expect(readFile(`${serverRoot}/config/config/server.json`, 'utf8')).resolves.toContain(
      'Gridora acceptance',
    )

    await docker(
      Effect.gen(function* () {
        const engine = yield* DockerEngine
        yield* engine.stop({ organizationId, serverId, deploymentId })
      }),
    )
    await expect(udpRoundTrip(32_001)).rejects.toThrow('did not answer')
    await docker(
      Effect.gen(function* () {
        const engine = yield* DockerEngine
        yield* engine.start({ organizationId, serverId, deploymentId })
      }),
    )
    await expect(udpRoundTrip(32_001)).resolves.toBe('GRIDORA_ARMA_ACCEPTANCE:probe')
  }, 120_000)
})

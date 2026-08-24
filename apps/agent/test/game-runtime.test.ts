import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  makeGameRuntime,
  NodeGameFileWriter,
  NodeGameModWriter,
  type GameProcessRunner,
} from '../src/game-runtime.js'
import { AgentError } from '../src/errors.js'
import type {
  ConfigApplyPayload,
  ModSyncPayload,
  ServerUpdatePayload,
} from '@gridora/agent-protocol'

const config: ConfigApplyPayload = {
  operationId: 'operation-a',
  serverId: 'server-a',
  deploymentId: 'server-a',
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  configRevision: 2,
  config: {
    name: 'Frontline',
    scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
    maxPlayers: 32,
    visible: true,
    crossPlatform: true,
  },
}

const mods: ModSyncPayload = {
  operationId: 'operation-a',
  serverId: 'server-a',
  deploymentId: 'server-a',
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  modRevision: 2,
  mods: [{ source: 'reforger.armaplatform.com', id: 'mission-pack', loadOrder: 1 }],
}

const update: ServerUpdatePayload = {
  operationId: 'operation-a',
  serverId: 'server-a',
  deploymentId: 'server-a',
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  image: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  backupBeforeUpdate: true,
}

const noopWriter = {
  activeRevision: () => Effect.succeed(null),
  prepare: () =>
    Effect.succeed({
      root: '/var/lib/gridora/servers/server-a/staging/config-2',
      promote: Effect.succeed('promoted' as const),
      discard: Effect.void,
    }),
  stage: () => Effect.void,
}

const noopModWriter = {
  activeRevision: () => Effect.succeed(null),
  prepare: () =>
    Effect.succeed({
      root: '/var/lib/gridora/servers/server-a/staging/mods-2',
      writableStagingRelative: 'mods-2',
      promote: Effect.succeed('promoted' as const),
      discard: Effect.void,
    }),
}

describe('agent game runtime', () => {
  it('stages plugin configuration through an existing shared direct-child root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-game-runtime-'))
    try {
      const serverRoot = join(root, 'server-a')
      await Promise.all(
        ['config', 'staging', 'game', 'data', 'mods', 'state', 'backups'].map((name) =>
          mkdir(join(serverRoot, name), { recursive: true }),
        ),
      )
      const runtime = makeGameRuntime(
        { run: () => Effect.succeed({ output: '' }) },
        NodeGameFileWriter(root, '/var/lib/gridora/servers'),
        noopModWriter,
      )
      await expect(
        Effect.runPromise(runtime.applyConfig('server-a', config)),
      ).resolves.toMatchObject({
        revision: 2,
        code: 'config-activated',
      })
      const rendered = await readFile(join(serverRoot, 'config', 'config', 'server.json'), 'utf8')
      expect(rendered).toContain('Frontline')
      expect(rendered).not.toContain('gridora-game-runtime')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders a top-level file without losing the exact staging root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-game-runtime-top-level-'))
    try {
      const serverRoot = join(root, 'server-a')
      await Promise.all(
        ['config', 'staging', 'game', 'data', 'mods', 'state', 'backups'].map((name) =>
          mkdir(join(serverRoot, name), { recursive: true }),
        ),
      )
      await expect(
        Effect.runPromise(
          NodeGameFileWriter(root).stage('server-a', 3, [
            {
              relativePath: 'server.cfg',
              content: 'bind=0.0.0.0\n',
              mode: 0o640,
              secret: false,
            },
          ]),
        ),
      ).resolves.toBeUndefined()
      await expect(readFile(join(serverRoot, 'config', 'server.cfg'), 'utf8')).resolves.toBe(
        'bind=0.0.0.0\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a pre-existing symlink in a rendered directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-game-runtime-symlink-'))
    try {
      const serverRoot = join(root, 'server-a')
      await Promise.all(
        ['config', 'staging', 'game', 'data', 'mods', 'state', 'backups'].map((name) =>
          mkdir(join(serverRoot, name), { recursive: true }),
        ),
      )
      const outside = join(root, 'outside')
      await mkdir(outside)
      const { symlink } = await import('node:fs/promises')
      await symlink(outside, join(serverRoot, 'staging', 'config-4'))
      await expect(
        Effect.runPromise(
          NodeGameFileWriter(root).stage('server-a', 4, [
            {
              relativePath: 'server.cfg',
              content: 'unsafe',
              mode: 0o640,
              secret: false,
            },
          ]),
        ),
      ).rejects.toMatchObject({ _tag: 'AgentError' })
      await expect(readFile(join(outside, 'server.cfg'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('promotes only a validated staged mod tree and retains the prior known-good set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-game-mod-runtime-'))
    try {
      const serverRoot = join(root, 'server-a')
      await Promise.all(
        ['config', 'staging', 'game', 'data', 'mods', 'state', 'backups'].map((name) =>
          mkdir(join(serverRoot, name), { recursive: true }),
        ),
      )
      await writeFile(join(serverRoot, 'mods', 'old.pak'), 'known-good')
      await writeFile(join(serverRoot, 'state', 'active-mod-revision'), '1\n')
      const writer = NodeGameModWriter(root, '/var/lib/gridora/servers')
      const prepared = await Effect.runPromise(writer.prepare('server-a', 2))
      expect(prepared.root).toBe('/var/lib/gridora/servers/server-a/staging/mods-2')
      await writeFile(join(serverRoot, 'staging', 'mods-2', 'new.pak'), 'validated')
      await expect(Effect.runPromise(prepared.promote)).resolves.toBe('promoted')
      await expect(readFile(join(serverRoot, 'mods', 'new.pak'), 'utf8')).resolves.toBe('validated')
      await expect(
        readFile(join(serverRoot, 'staging', 'mods-known-good-1', 'old.pak'), 'utf8'),
      ).resolves.toBe('known-good')
      await expect(readFile(join(serverRoot, 'mods', 'old.pak'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const retry = await Effect.runPromise(writer.prepare('server-a', 2))
      await expect(Effect.runPromise(retry.promote)).resolves.toBe('adopted')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs only build-time plugin plans and never accepts an unknown plugin key', async () => {
    const executed: string[] = []
    const processRunner: GameProcessRunner = {
      run: (plan) =>
        Effect.sync(() => {
          executed.push(plan.executable)
          return { output: 'ok' }
        }),
    }
    const runtime = makeGameRuntime(
      processRunner,
      {
        ...noopWriter,
      },
      noopModWriter,
    )
    await expect(Effect.runPromise(runtime.syncMods('server-a', mods))).resolves.toMatchObject({
      revision: 2,
      code: 'mods-activated',
    })
    expect(executed).toEqual(['ArmaReforgerServer', 'gridora-game-query'])
    await expect(Effect.runPromise(runtime.update('server-a', update))).resolves.toMatchObject({
      code: 'updated-after-backup',
    })
    expect(executed).toEqual(['ArmaReforgerServer', 'gridora-game-query', 'steamcmd'])
    await expect(
      Effect.runPromise(runtime.syncMods('server-a', { ...mods, pluginVersion: '9.9.9' })),
    ).rejects.toMatchObject({
      _tag: 'AgentError',
    })
  })

  it('binds restore validation to the promoted digest and exact staged operation root', async () => {
    const observed: Array<{
      readonly planRoot: string
      readonly image: string
      readonly backupId?: string
    }> = []
    const runtime = makeGameRuntime(
      {
        run: (plan, input) =>
          Effect.sync(() => {
            observed.push({
              planRoot: plan.workingDirectory,
              image: input.image,
              ...(input.restoreValidationBackupId === undefined
                ? {}
                : { backupId: input.restoreValidationBackupId }),
            })
            return { output: 'valid' }
          }),
      },
      noopWriter,
      noopModWriter,
    )
    const root = '/var/lib/gridora/servers/.gridora-restore-server-a-backup-a'
    await expect(
      Effect.runPromise(
        runtime.validateRestore(
          'server-a',
          'arma-reforger',
          '0.1.0',
          'operation-a',
          'backup-a',
          root,
        ),
      ),
    ).resolves.toBeUndefined()
    expect(observed).toEqual([
      {
        planRoot: root,
        image: 'sha256:69e0cc046f1a87d56cd7c07732908359c9ba0bc9aafb35ed7adae9f4b81b7784',
        backupId: 'backup-a',
      },
    ])

    await expect(
      Effect.runPromise(
        runtime.validateRestore(
          'server-a',
          'arma-reforger',
          '0.1.0',
          'operation-a',
          'backup-a',
          '/var/lib/gridora/servers/server-a/../foreign',
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'AgentError' })
    expect(observed).toHaveLength(1)
  })

  it('runs signed install and plugin-level health plans through the isolated runner', async () => {
    const observed: Array<{ executable: string; image: string }> = []
    const runtime = makeGameRuntime(
      {
        run: (plan, input) =>
          Effect.sync(() => {
            observed.push({ executable: plan.executable, image: input.image })
            return {
              output:
                plan.executable === 'gridora-game-query'
                  ? 'OK players=3 scenario=Frontline build=165432'
                  : 'Success! buildid: 165432',
            }
          }),
      },
      noopWriter,
      noopModWriter,
    )
    await expect(
      Effect.runPromise(
        runtime.install({
          apiVersion: 'agent.gridora.dev/v1alpha1',
          organizationId: 'org-a',
          nodeId: 'node-a',
          serverId: 'server-a',
          deploymentId: 'deployment-a',
          operationId: 'operation-a',
          revision: 1,
          plugin: {
            id: 'arma-reforger',
            version: '0.1.0',
            apiVersion: 'gridora.plugin/v1alpha1',
          },
          image: {
            installer: `sha256:${'a'.repeat(64)}`,
            runtime: `sha256:${'b'.repeat(64)}`,
          },
          ports: [],
          mounts: [],
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20, pids: 256 },
          expiresAt: '2026-08-24T12:00:00Z',
        }),
      ),
    ).resolves.toMatchObject({ code: 'plugin-installed-build-165432' })
    await expect(
      Effect.runPromise(
        runtime.inspectHealth('server-a', 'arma-reforger', '0.1.0', 'health-operation'),
      ),
    ).resolves.toMatchObject({ status: 'healthy', protocol: true, build: '165432' })
    expect(observed).toEqual([
      { executable: 'steamcmd', image: `sha256:${'a'.repeat(64)}` },
      {
        executable: 'gridora-game-query',
        image: 'sha256:69e0cc046f1a87d56cd7c07732908359c9ba0bc9aafb35ed7adae9f4b81b7784',
      },
    ])
  })

  it('does not promote a rendered config when plugin validation fails', async () => {
    let promoted = false
    let discarded = false
    const runtime = makeGameRuntime(
      {
        run: () =>
          Effect.fail(
            new AgentError({
              code: 'execution-failed',
              message: 'invalid staged config',
            }),
          ),
      },
      {
        activeRevision: () => Effect.succeed(1),
        prepare: () =>
          Effect.succeed({
            root: '/var/lib/gridora/servers/server-a/staging/config-2',
            promote: Effect.sync(() => {
              promoted = true
              return 'promoted' as const
            }),
            discard: Effect.sync(() => {
              discarded = true
            }),
          }),
        stage: () => Effect.void,
      },
      noopModWriter,
    )
    await expect(Effect.runPromise(runtime.applyConfig('server-a', config))).rejects.toMatchObject({
      _tag: 'AgentError',
    })
    expect(promoted).toBe(false)
    expect(discarded).toBe(true)
  })
})

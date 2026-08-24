import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { runConformance } from '@gridora/plugin-testkit'
import { agent, parseModReference, plugin, resolveArmaMods, runtime } from './index.js'
describe('Arma Reforger plugin', () => {
  it('passes plugin conformance', async () =>
    expect((await Effect.runPromise(runConformance(plugin))).passed).toBe(true))
  it('keeps source parsing isolated and rejects foreign domains', async () =>
    expect(
      (await Effect.runPromise(Effect.result(parseModReference('https://example.com/workshop/x'))))
        ._tag,
    ).toBe('Failure'))
  it('reports protocol failure independently from process', () =>
    expect(agent.parseHealth('timeout')).toMatchObject({
      process: true,
      protocol: false,
      status: 'unhealthy',
    }))
  it('installs Steam content only into the mounted game directory', async () => {
    const plan = await Effect.runPromise(agent.installPlan('/var/lib/gridora/servers/fixture'))
    expect(plan.workingDirectory).toBe('/var/lib/gridora/servers/fixture/game')
    expect(plan.arguments).toContain('/var/lib/gridora/servers/fixture/game')
  })
  it('validates and launches the exact rendered configuration path', async () => {
    const root = '/var/lib/gridora/servers/fixture'
    const launch = await Effect.runPromise(agent.launchPlan(root, `${root}/config`))
    const activation = await Effect.runPromise(
      runtime.activationPlan(root, `${root}/staging/config-1`),
    )
    expect(launch.arguments).toContain(`${root}/config/config/server.json`)
    expect(activation[0]?.arguments).toContain(`${root}/staging/config-1/config/server.json`)
  })
  it('redacts password logs', () =>
    expect(agent.parseLog('password=secret').message).not.toContain('secret'))
  it('orders transitive dependencies before requested mods', async () => {
    const result = await Effect.runPromise(
      resolveArmaMods(
        [{ source: 'reforger.armaplatform.com', id: 'mission', loadOrder: 10 }],
        [
          {
            source: 'reforger.armaplatform.com',
            id: 'mission',
            dependencies: ['framework'],
          },
          {
            source: 'reforger.armaplatform.com',
            id: 'framework',
            dependencies: ['core'],
          },
          { source: 'reforger.armaplatform.com', id: 'core', dependencies: [] },
        ],
      ),
    )
    expect(result.map(({ id }) => id)).toEqual(['core', 'framework', 'mission'])
  })
  it('fails closed on dependency cycles and incomplete metadata', async () => {
    const desired = [{ source: 'reforger.armaplatform.com', id: 'mission', loadOrder: 1 }]
    for (const catalog of [
      [
        { source: 'reforger.armaplatform.com', id: 'mission', dependencies: ['framework'] },
        { source: 'reforger.armaplatform.com', id: 'framework', dependencies: ['mission'] },
      ],
      [{ source: 'reforger.armaplatform.com', id: 'mission', dependencies: ['missing'] }],
    ]) {
      expect((await Effect.runPromise(Effect.result(resolveArmaMods(desired, catalog))))._tag).toBe(
        'Failure',
      )
    }
  })
  it('rejects URL credentials, non-HTTPS sources, and mod argv injection', async () => {
    for (const reference of [
      'http://reforger.armaplatform.com/workshop/x',
      'https://user:password@reforger.armaplatform.com/workshop/x',
    ]) {
      expect((await Effect.runPromise(Effect.result(parseModReference(reference))))._tag).toBe(
        'Failure',
      )
    }
    expect(
      (
        await Effect.runPromise(
          Effect.result(
            agent.modInstallPlan!('/var/lib/gridora/servers/fixture', [
              { id: '--profile', version: '1' },
            ]),
          ),
        )
      )._tag,
    ).toBe('Failure')
    expect(
      (
        await Effect.runPromise(
          Effect.result(runtime.validateBackupManifest(['../profile', 'config/server.json'])),
        )
      )._tag,
    ).toBe('Failure')
  })
})

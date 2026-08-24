import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifest = (path: string): PackageManifest =>
  JSON.parse(readFileSync(`${root}${path}/package.json`, 'utf8')) as PackageManifest
const dependencies = (value: PackageManifest): ReadonlyArray<string> =>
  Object.keys(value.dependencies ?? {})

describe('workspace dependency boundaries', () => {
  it.each([
    'packages/domain',
    'packages/application',
    'packages/auth-cloudflare-access',
    'packages/db-contracts',
    'packages/provider-sdk',
    'packages/scheduler',
  ])('%s does not depend on a concrete game plugin', (path) => {
    expect(
      dependencies(manifest(path)).filter((name) => name.startsWith('@gridora/plugin-')),
    ).toEqual([])
  })

  it.each(['plugins/games/arma-reforger', 'plugins/games/second-reference-game'])(
    '%s depends only on SDK and runtime boundaries',
    (path) => {
      const forbidden = dependencies(manifest(path)).filter(
        (name) =>
          name.startsWith('@gridora/') &&
          ![
            '@gridora/plugin-sdk',
            '@gridora/plugin-sdk-agent',
            '@gridora/plugin-sdk-control',
            '@gridora/plugin-sdk-ui',
            '@gridora/plugin-testkit',
            '@gridora/steam-runtime',
          ].includes(name),
      )
      expect(forbidden).toEqual([])
    },
  )

  it('keeps concrete plugin imports in the generated registry boundary', () => {
    const registry = manifest('packages/plugin-registry')
    expect(dependencies(registry).filter((name) => name.startsWith('@gridora/plugin-'))).toEqual([
      '@gridora/plugin-arma-reforger',
      '@gridora/plugin-sdk',
      '@gridora/plugin-valheim',
    ])
    const api = dependencies(manifest('apps/api'))
    expect(api).toContain('@gridora/plugin-registry')
    expect(api).not.toContain('@gridora/plugin-arma-reforger')
    expect(api).not.toContain('@gridora/plugin-valheim')
    expect(dependencies(manifest('packages/generated-client'))).not.toContain('@gridora/api')
  })
})

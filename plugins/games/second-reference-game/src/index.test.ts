import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { runConformance } from '@gridora/plugin-testkit'
import { manifest, plugin, runtime } from './index.js'
describe('second reference plugin', () => {
  it('is native Linux and anonymous Steam', () => {
    expect(manifest.compatibility).toMatchObject({ nativeLinux: true, requiresProton: false })
    expect(manifest.steam.loginMode).toBe('anonymous')
  })
  it('passes independently of the Arma package', async () =>
    expect((await Effect.runPromise(runConformance(plugin))).passed).toBe(true))
  it('rejects mods and unsafe restore manifests for the no-mod reference plugin', async () => {
    expect(
      (
        await Effect.runPromise(
          Effect.result(
            runtime.resolveMods([{ source: 'foreign.example', id: 'mod', loadOrder: 0 }], []),
          ),
        )
      )._tag,
    ).toBe('Failure')
    expect(
      (
        await Effect.runPromise(
          Effect.result(runtime.validateBackupManifest(['../../etc', 'config/server.env'])),
        )
      )._tag,
    ).toBe('Failure')
  })
})

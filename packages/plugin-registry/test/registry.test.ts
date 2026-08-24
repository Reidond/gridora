import { describe, expect, it } from 'vitest'
import { apiPluginManifests, findApiPluginManifest, pluginRegistry } from '../src/index.js'

describe('generated first-party plugin registry', () => {
  it('registers both reviewed plugin bundles from their canonical manifests', () => {
    expect([...pluginRegistry.keys()]).toEqual(['arma-reforger@0.1.0', 'valheim@0.1.0'])
    expect(apiPluginManifests).toMatchObject([
      { id: 'arma-reforger', version: '0.1.0', apiVersion: 'gridora.plugin/v1alpha1' },
      { id: 'valheim', version: '0.1.0', apiVersion: 'gridora.plugin/v1alpha1' },
    ])
    expect(findApiPluginManifest('arma-reforger')?.capabilities).toContain('mods')
    expect(findApiPluginManifest('missing')).toBeUndefined()
  })
})

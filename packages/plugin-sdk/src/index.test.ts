import { describe, expect, it } from 'vitest'
import {
  defineRegistry,
  PLUGIN_API_VERSION,
  validatePluginBundle,
  type PluginBundle,
} from './index.js'
const bundle: PluginBundle = {
  manifest: {
    apiVersion: PLUGIN_API_VERSION,
    id: 'test-game',
    version: '1.0.0',
    displayName: 'Test',
    compatibility: {
      os: ['linux'],
      architectures: ['amd64'],
      nativeLinux: true,
      requiresProton: false,
    },
    steam: {
      appId: 1,
      loginMode: 'anonymous',
      branchSupport: false,
      installDirectory: '/var/lib/gridora/servers/test/game',
    },
    resources: {
      minimum: { cpu: 1, memoryMiB: 1, diskGiB: 1 },
      recommended: { cpu: 2, memoryMiB: 2, diskGiB: 2 },
      sharedNodeAllowed: true,
    },
    ports: [],
    configSchemaVersion: 1,
    dataFormatVersion: 1,
    supportedAgentApi: '^1.0.0',
    supportedControlApi: '^1.0.0',
    restoreValidationImageDigest: `sha256:${'a'.repeat(64)}`,
    capabilities: ['install'],
    knownLimitations: [],
  },
  permissions: {
    filesystemRoots: ['/var/lib/gridora/servers'],
    executableNames: ['steamcmd'],
    networkDestinations: [],
    dockerActions: [],
    secretCategories: [],
    portProtocols: [],
    backupRoots: [],
    modSourceDomains: [],
  },
}
describe('plugin registry', () => {
  it('validates and registers unique build-time plugins', () => {
    expect(validatePluginBundle(bundle)).toEqual([])
    expect(defineRegistry([bundle]).size).toBe(1)
  })
  it('rejects permission traversal', () =>
    expect(
      validatePluginBundle({
        ...bundle,
        permissions: { ...bundle.permissions, filesystemRoots: ['../etc'] },
      })[0]?._tag,
    ).toBe('PluginManifestError'))
})

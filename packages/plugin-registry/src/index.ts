import type { PluginManifest } from '@gridora/contracts'
import { defineRegistry } from '@gridora/plugin-sdk'
import { generatedPluginBundles } from './registry.generated.js'

/** The generated list is reviewed at build time. Runtime plugin loading is forbidden. */
export const pluginRegistry = defineRegistry(generatedPluginBundles)

const capabilityMap: Readonly<Record<string, string>> = {
  install: 'deploy',
  update: 'update',
  lifecycle: 'lifecycle',
  config: 'config',
  health: 'health',
  query: 'query',
  logs: 'logs',
  console: 'console',
  backup: 'backup',
  restore: 'restore',
  mods: 'mods',
  diagnostics: 'diagnostics',
  'custom-ui': 'custom-ui',
}

const toApiManifest = (
  bundle: (typeof generatedPluginBundles)[number],
): typeof PluginManifest.Type => ({
  id: bundle.manifest.id,
  displayName: bundle.manifest.displayName,
  game: bundle.manifest.displayName,
  apiVersion: bundle.manifest.apiVersion,
  version: bundle.manifest.version,
  capabilities: [
    ...new Set(bundle.manifest.capabilities.map((item) => capabilityMap[item] ?? item)),
  ],
})

export const apiPluginManifests: ReadonlyArray<typeof PluginManifest.Type> =
  generatedPluginBundles.map(toApiManifest)

export const findApiPluginManifest = (id: string): typeof PluginManifest.Type | undefined =>
  apiPluginManifests.find((manifest) => manifest.id === id)

/** Reviewed local runtime facets are generated with the same immutable build registry. */
export const findPluginRuntime = (id: string, version: string) =>
  generatedPluginBundles.find(
    (bundle) => bundle.manifest.id === id && bundle.manifest.version === version,
  )?.runtime

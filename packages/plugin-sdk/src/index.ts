import { Schema } from 'effect'

export const PLUGIN_API_VERSION = 'gridora.plugin/v1alpha1' as const
export type PluginCapability =
  | 'install'
  | 'update'
  | 'lifecycle'
  | 'config'
  | 'health'
  | 'query'
  | 'logs'
  | 'console'
  | 'backup'
  | 'restore'
  | 'mods'
  | 'diagnostics'
  | 'custom-ui'
export interface ResourceRequest {
  readonly cpu: number
  readonly memoryMiB: number
  readonly diskGiB: number
}
export interface PortDefinition {
  readonly name: string
  readonly protocol: 'tcp' | 'udp'
  readonly containerPort: number
  readonly count?: number
  readonly required: boolean
  readonly playerFacing: boolean
  readonly supportsSrv: boolean
}
export interface GamePluginManifest {
  readonly apiVersion: typeof PLUGIN_API_VERSION
  readonly id: string
  readonly version: string
  readonly displayName: string
  readonly compatibility: {
    readonly os: readonly ['linux']
    readonly architectures: readonly ('amd64' | 'arm64')[]
    readonly nativeLinux: boolean
    readonly requiresProton: false
  }
  readonly steam: {
    readonly appId: number
    readonly loginMode: 'anonymous' | 'credentialed'
    readonly branchSupport: boolean
    readonly installDirectory: string
  }
  readonly resources: {
    readonly minimum: ResourceRequest
    readonly recommended: ResourceRequest
    readonly sharedNodeAllowed: boolean
  }
  readonly ports: readonly PortDefinition[]
  readonly configSchemaVersion: number
  readonly dataFormatVersion: number
  readonly supportedAgentApi: string
  readonly supportedControlApi: string
  /** Digest-pinned helper promoted with this reviewed plugin build. It is the
   * only image allowed to validate staged restore contents. */
  readonly restoreValidationImageDigest: `sha256:${string}`
  readonly capabilities: readonly PluginCapability[]
  readonly knownLimitations: readonly string[]
}
export interface PluginPermissionManifest {
  readonly filesystemRoots: readonly string[]
  readonly executableNames: readonly string[]
  readonly networkDestinations: readonly string[]
  readonly dockerActions: readonly ('create' | 'start' | 'stop' | 'remove' | 'inspect' | 'logs')[]
  readonly secretCategories: readonly string[]
  readonly portProtocols: readonly ('tcp' | 'udp')[]
  readonly backupRoots: readonly string[]
  readonly modSourceDomains: readonly string[]
}
export interface PluginBundle<M extends GamePluginManifest = GamePluginManifest> {
  readonly manifest: M
  readonly permissions: PluginPermissionManifest
}
export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()(
  'PluginManifestError',
  { pluginId: Schema.String, message: Schema.String },
) {}
const hasTraversal = (path: string) => path.split('/').includes('..')
export const validatePluginBundle = (bundle: PluginBundle): readonly PluginManifestError[] => {
  const errors: PluginManifestError[] = []
  const { manifest, permissions } = bundle
  if (manifest.apiVersion !== PLUGIN_API_VERSION)
    errors.push(
      new PluginManifestError({ pluginId: manifest.id, message: 'unsupported plugin API version' }),
    )
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id))
    errors.push(new PluginManifestError({ pluginId: manifest.id, message: 'invalid plugin ID' }))
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version))
    errors.push(
      new PluginManifestError({ pluginId: manifest.id, message: 'invalid semantic version' }),
    )
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.restoreValidationImageDigest))
    errors.push(
      new PluginManifestError({
        pluginId: manifest.id,
        message: 'restore validation image must be digest pinned',
      }),
    )
  if (!manifest.compatibility.nativeLinux || manifest.compatibility.requiresProton)
    errors.push(
      new PluginManifestError({
        pluginId: manifest.id,
        message: 'first release requires native Linux without Proton',
      }),
    )
  if ([...permissions.filesystemRoots, ...permissions.backupRoots].some(hasTraversal))
    errors.push(
      new PluginManifestError({
        pluginId: manifest.id,
        message: 'permission path traversal is forbidden',
      }),
    )
  if (
    new Set(manifest.ports.map((p) => `${p.protocol}:${p.containerPort}`)).size !==
    manifest.ports.length
  )
    errors.push(
      new PluginManifestError({ pluginId: manifest.id, message: 'duplicate port declaration' }),
    )
  return errors
}
export const defineRegistry = <T extends PluginBundle>(
  bundles: readonly T[],
): ReadonlyMap<string, T> => {
  const map = new Map<string, T>()
  for (const bundle of bundles) {
    const errors = validatePluginBundle(bundle)
    if (errors.length > 0) throw errors[0]
    const key = `${bundle.manifest.id}@${bundle.manifest.version}`
    if (map.has(key))
      throw new PluginManifestError({
        pluginId: bundle.manifest.id,
        message: `duplicate registry key ${key}`,
      })
    map.set(key, bundle)
  }
  return map
}

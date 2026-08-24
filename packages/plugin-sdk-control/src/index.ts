import { Effect, Schema } from 'effect'
import type { GamePluginManifest, PluginBundle, ResourceRequest } from '@gridora/plugin-sdk'
export class PluginControlError extends Schema.TaggedError<PluginControlError>()(
  'PluginControlError',
  {
    pluginId: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    /** Stable machine code for a reviewed plugin-owned control failure. */
    code: Schema.optional(Schema.String),
    /** A bounded public-provider retry hint. It never authorizes an unbounded retry. */
    retryAfterSeconds: Schema.optional(Schema.Number),
  },
) {}
export interface DesiredMod {
  readonly source: string
  readonly id: string
  readonly requestedVersion?: string
  readonly loadOrder: number
}
export interface ResolvedMod extends DesiredMod {
  readonly resolvedVersion?: string
  readonly dependencies: readonly string[]
  readonly warnings: readonly string[]
  readonly sourceUrl?: string
}
/**
 * Plugin-owned metadata normalized from a reviewed external source. The core
 * only understands this generic graph; it never imports game-specific URLs or
 * provider fields.
 */
export interface ModDependencyMetadata {
  readonly source: string
  readonly id: string
  readonly version?: string
  readonly dependencies: readonly string[]
  readonly sourceUrl?: string
  readonly warnings?: readonly string[]
}
export interface ModMetadataProvenance {
  /** A stable plugin-owned source label, not an assertion of first-party ownership. */
  readonly provider: string
  /** Exact allowed endpoint used for this metadata object. */
  readonly endpoint: string
  readonly fetchedAt: string
  readonly expiresAt: string
  readonly cache: 'upstream' | 'memory' | 'revalidated'
  readonly bodySha256: string
  readonly etag?: string
  readonly upstreamCache?: 'HIT' | 'MISS' | 'STALE'
  readonly workshopSource?: string
  readonly workshopOrigin?: string
}
export interface ModMetadataResolution {
  /** Offline is explicit and deterministic; it is never presented as a live resolution. */
  readonly state: 'resolved' | 'offline'
  readonly catalog: readonly ModDependencyMetadata[]
  readonly provenance: readonly ModMetadataProvenance[]
  readonly warnings: readonly string[]
}
export interface DeploymentPlanningOptions {
  /**
   * Supplied only by a plugin-owned live metadata resolver at an acceptance
   * boundary. Omit it for deterministic, network-free preview planning.
   */
  readonly modMetadata?: ModMetadataResolution
}
export interface DeploymentPlan {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly resources: ResourceRequest
  readonly ports: GamePluginManifest['ports']
  readonly install: {
    readonly appId: number
    readonly loginMode: 'anonymous' | 'credentialed'
    readonly branch?: string
  }
  readonly config: unknown
  readonly mods: readonly ResolvedMod[]
  /** Immutable provenance for a live metadata-assisted plan when present. */
  readonly modMetadata?: ModMetadataResolution
  readonly steps: readonly string[]
}
export interface ControlFacet<C = unknown> {
  readonly validateConfig: (input: unknown) => Effect.Effect<C, PluginControlError>
  readonly normalizeDesiredState: (
    config: C,
    mods: readonly DesiredMod[],
  ) => Effect.Effect<
    { readonly config: C; readonly mods: readonly DesiredMod[] },
    PluginControlError
  >
  readonly planDeployment: (
    config: C,
    mods: readonly DesiredMod[],
    options?: DeploymentPlanningOptions,
  ) => Effect.Effect<DeploymentPlan, PluginControlError>
  /**
   * Optional plugin-owned live metadata boundary. The generic caller can use
   * the result without learning a game's provider URL or response shape.
   */
  readonly resolveModMetadata?: (
    mods: readonly DesiredMod[],
  ) => Effect.Effect<ModMetadataResolution, PluginControlError>
  readonly resolveModReference?: (
    reference: string,
  ) => Effect.Effect<ResolvedMod, PluginControlError>
  readonly redactAudit: (input: unknown) => unknown
}
export interface ControlPlugin<C = unknown> extends PluginBundle {
  readonly control: ControlFacet<C>
}
export const defineControlRegistry = <T extends ControlPlugin>(
  plugins: readonly T[],
): ReadonlyMap<string, T['control']> =>
  new Map(plugins.map((p) => [`${p.manifest.id}@${p.manifest.version}`, p.control]))

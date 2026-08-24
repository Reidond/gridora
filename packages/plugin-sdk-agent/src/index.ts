import { Effect, Schema } from 'effect'
import type { PluginBundle, PluginPermissionManifest } from '@gridora/plugin-sdk'
export class PluginAgentError extends Schema.TaggedError<PluginAgentError>()('PluginAgentError', {
  pluginId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}
export interface ExecutablePlan {
  readonly executable: string
  readonly arguments: readonly string[]
  readonly workingDirectory: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutSeconds: number
}
export interface FileRender {
  readonly relativePath: string
  readonly content: string
  readonly mode: number
  readonly secret: boolean
}
export interface HealthReport {
  readonly status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  readonly process: boolean
  readonly protocol: boolean
  readonly players?: number
  readonly scenario?: string
  readonly build?: string
  readonly reasons: readonly string[]
}
export interface BackupPlan {
  readonly roots: readonly string[]
  readonly exclude: readonly string[]
  readonly consistency: 'crash-consistent' | 'plugin-quiesced'
  readonly quiesce?: ExecutablePlan
  readonly resume?: ExecutablePlan
  readonly validateRestore: readonly string[]
}
export interface AgentFacet<C = unknown> {
  readonly installPlan: (installRoot: string) => Effect.Effect<ExecutablePlan, PluginAgentError>
  readonly updatePlan: (installRoot: string) => Effect.Effect<ExecutablePlan, PluginAgentError>
  readonly renderConfig: (config: C) => Effect.Effect<readonly FileRender[], PluginAgentError>
  readonly launchPlan: (
    installRoot: string,
    configRoot: string,
  ) => Effect.Effect<ExecutablePlan, PluginAgentError>
  readonly healthPlan: (installRoot: string) => Effect.Effect<ExecutablePlan, PluginAgentError>
  readonly parseHealth: (output: string) => HealthReport
  readonly parseLog: (line: string) => {
    readonly level: 'debug' | 'info' | 'warn' | 'error'
    readonly message: string
  }
  readonly backupPlan: (serverRoot: string) => BackupPlan
  readonly modInstallPlan?: (
    serverRoot: string,
    mods: readonly { readonly id: string; readonly version?: string }[],
  ) => Effect.Effect<readonly ExecutablePlan[], PluginAgentError>
}
export interface AgentPlugin<C = unknown> extends PluginBundle {
  readonly agent: AgentFacet<C>
}
export const assertExecutableAllowed = (
  permissions: PluginPermissionManifest,
  plan: ExecutablePlan,
): Effect.Effect<ExecutablePlan, PluginAgentError> =>
  permissions.executableNames.includes(plan.executable)
    ? Effect.succeed(plan)
    : Effect.fail(
        new PluginAgentError({
          pluginId: 'permission-check',
          operation: 'execute',
          message: `executable ${plan.executable} is not permitted`,
        }),
      )
export const defineAgentRegistry = <T extends AgentPlugin>(
  plugins: readonly T[],
): ReadonlyMap<string, T['agent']> =>
  new Map(plugins.map((p) => [`${p.manifest.id}@${p.manifest.version}`, p.agent]))

import { Effect } from 'effect'
import { validatePluginBundle, type PluginBundle } from '@gridora/plugin-sdk'
import type { AgentFacet } from '@gridora/plugin-sdk-agent'
import type { ExecutablePlan, PluginAgentError } from '@gridora/plugin-sdk-agent'
import type {
  ControlFacet,
  DesiredMod,
  PluginControlError,
  ResolvedMod,
} from '@gridora/plugin-sdk-control'

export interface ModDependencyMetadata {
  readonly id: string
  readonly source: string
  readonly version?: string
  readonly dependencies: readonly string[]
}
export interface LocalPluginRuntimeFacet {
  readonly resolveMods: (
    desired: readonly DesiredMod[],
    catalog: readonly ModDependencyMetadata[],
  ) => Effect.Effect<readonly ResolvedMod[], PluginControlError>
  readonly activationPlan: (
    serverRoot: string,
    configRoot: string,
  ) => Effect.Effect<readonly ExecutablePlan[], PluginAgentError>
  readonly modValidationPlan?: (
    serverRoot: string,
    stagedModsRoot: string,
  ) => Effect.Effect<ExecutablePlan, PluginAgentError>
  readonly restoreValidationPlan: (
    serverRoot: string,
  ) => Effect.Effect<ExecutablePlan, PluginAgentError>
  readonly validateBackupManifest: (
    paths: readonly string[],
  ) => Effect.Effect<void, PluginAgentError>
  readonly rollback: {
    readonly installStrategy: 'immutable-release'
    readonly configStrategy: 'atomic-revision'
    readonly retainReleases: number
    readonly dataRollback: 'restore-required' | 'backward-compatible'
  }
  readonly liveExecution: {
    readonly gated: true
    readonly requiredEvidence: readonly string[]
  }
}
export interface ConformancePlugin<C = unknown> extends PluginBundle {
  readonly control: ControlFacet<C>
  readonly agent: AgentFacet<C>
  readonly runtime: LocalPluginRuntimeFacet
  readonly fixture: {
    readonly validConfig: unknown
    readonly invalidConfig: unknown
    readonly expectedConfigFiles: readonly string[]
    readonly expectedConfigFragments: readonly string[]
    readonly healthyOutput: string
    readonly secretLogLine: string
    readonly dependencyGraph: {
      readonly desired: readonly DesiredMod[]
      readonly catalog: readonly ModDependencyMetadata[]
      readonly expectedOrder: readonly string[]
    }
  }
}
export interface ConformanceReport {
  readonly pluginId: string
  readonly passed: boolean
  readonly checks: readonly {
    readonly name: string
    readonly passed: boolean
    readonly detail?: string
  }[]
}
const successful = (name: string, passed: boolean, detail?: string) => ({
  name,
  passed,
  ...(detail === undefined ? {} : { detail }),
})
export const runConformance = <C>(
  plugin: ConformancePlugin<C>,
): Effect.Effect<ConformanceReport, never> =>
  Effect.gen(function* () {
    const checks: { name: string; passed: boolean; detail?: string }[] = []
    checks.push(successful('manifest', validatePluginBundle(plugin).length === 0))
    const decoded = yield* Effect.result(plugin.control.validateConfig(plugin.fixture.validConfig))
    checks.push(successful('valid config', decoded._tag === 'Success'))
    const invalid = yield* Effect.result(
      plugin.control.validateConfig(plugin.fixture.invalidConfig),
    )
    checks.push(successful('invalid config rejection', invalid._tag === 'Failure'))
    if (decoded._tag === 'Success') {
      const rendered = yield* Effect.result(plugin.agent.renderConfig(decoded.success))
      checks.push(
        successful(
          'config render',
          rendered._tag === 'Success' &&
            plugin.fixture.expectedConfigFiles.every((path) =>
              rendered.success.some((f) => f.relativePath === path),
            ) &&
            plugin.fixture.expectedConfigFragments.every((fragment) =>
              rendered.success.some((file) => file.content.includes(fragment)),
            ),
        ),
      )
      const renderedAgain = yield* Effect.result(plugin.agent.renderConfig(decoded.success))
      checks.push(
        successful(
          'deterministic config generation',
          rendered._tag === 'Success' &&
            renderedAgain._tag === 'Success' &&
            JSON.stringify(rendered.success) === JSON.stringify(renderedAgain.success),
        ),
      )
      const first = yield* Effect.result(
        plugin.agent.installPlan('/var/lib/gridora/servers/fixture'),
      )
      const second = yield* Effect.result(
        plugin.agent.installPlan('/var/lib/gridora/servers/fixture'),
      )
      checks.push(
        successful(
          'idempotent install plan',
          first._tag === 'Success' &&
            second._tag === 'Success' &&
            JSON.stringify(first) === JSON.stringify(second),
        ),
      )
      const plan = yield* Effect.result(plugin.control.planDeployment(decoded.success, []))
      checks.push(successful('deployment plan', plan._tag === 'Success'))
    }
    const unsafePaths = [
      '../../etc',
      '/var/lib/gridora/servers/test/../escape',
      '/var/lib/gridora/servers/test/./data',
      '/var/lib/gridora/servers/test\0escape',
    ]
    const unsafeResults = yield* Effect.forEach(unsafePaths, (path) =>
      Effect.result(plugin.agent.installPlan(path)),
    )
    checks.push(
      successful(
        'path traversal rejection',
        unsafeResults.every((result) => result._tag === 'Failure'),
      ),
    )
    const update = yield* Effect.result(plugin.agent.updatePlan('/var/lib/gridora/servers/fixture'))
    checks.push(successful('update plan', update._tag === 'Success'))
    checks.push(
      successful(
        'fixed argv Steam plan',
        update._tag === 'Success' &&
          update.success.executable === 'steamcmd' &&
          update.success.arguments.includes('+app_update') &&
          !('shell' in update.success),
      ),
    )
    const launch = yield* Effect.result(
      plugin.agent.launchPlan(
        '/var/lib/gridora/servers/fixture',
        '/var/lib/gridora/servers/fixture/config',
      ),
    )
    checks.push(successful('lifecycle launch plan', launch._tag === 'Success'))
    const activation = yield* Effect.result(
      plugin.runtime.activationPlan(
        '/var/lib/gridora/servers/fixture',
        '/var/lib/gridora/servers/fixture/config',
      ),
    )
    checks.push(
      successful(
        'activation validation plan',
        activation._tag === 'Success' &&
          activation.success.length >= 2 &&
          activation.success.every(
            (plan) =>
              plugin.permissions.executableNames.includes(plan.executable) && !('shell' in plan),
          ),
      ),
    )
    if (plugin.manifest.capabilities.includes('mods')) {
      const declaredModValidation = plugin.runtime.modValidationPlan?.(
        '/var/lib/gridora/servers/fixture',
        '/var/lib/gridora/servers/fixture/staging/mods-2',
      )
      const modValidation =
        declaredModValidation === undefined
          ? undefined
          : yield* Effect.result(declaredModValidation)
      checks.push(
        successful(
          'staged mod validation plan',
          modValidation?._tag === 'Success' &&
            plugin.permissions.executableNames.includes(modValidation.success.executable),
        ),
      )
    }
    const healthy = plugin.agent.parseHealth(plugin.fixture.healthyOutput)
    const unhealthy = plugin.agent.parseHealth('GRIDORA_CONFORMANCE_QUERY_FAILURE')
    checks.push(
      successful(
        'protocol health success and failure',
        healthy.status === 'healthy' &&
          healthy.protocol &&
          unhealthy.status !== 'healthy' &&
          !unhealthy.protocol,
      ),
    )
    checks.push(
      successful(
        'log secret redaction',
        !plugin.agent.parseLog(plugin.fixture.secretLogLine).message.includes('conformance-secret'),
      ),
    )
    const backup = plugin.agent.backupPlan('/var/lib/gridora/servers/fixture')
    const validBackup = yield* Effect.result(
      plugin.runtime.validateBackupManifest(backup.validateRestore),
    )
    const invalidBackup = yield* Effect.result(
      plugin.runtime.validateBackupManifest(['../../etc/shadow']),
    )
    const restoreValidation = yield* Effect.result(
      plugin.runtime.restoreValidationPlan('/var/lib/gridora/servers/fixture'),
    )
    checks.push(
      successful(
        'backup and restore declarations',
        backup.roots.length > 0 &&
          backup.validateRestore.length > 0 &&
          backup.roots.every((root) => root.startsWith('/var/lib/gridora/servers/fixture')) &&
          validBackup._tag === 'Success' &&
          invalidBackup._tag === 'Failure' &&
          restoreValidation._tag === 'Success',
      ),
    )
    if (decoded._tag === 'Success') {
      const normalized = yield* Effect.result(
        plugin.control.normalizeDesiredState(decoded.success, [
          { source: 'fixture', id: 'duplicate', loadOrder: 1 },
          { source: 'fixture', id: 'duplicate', loadOrder: 1 },
        ]),
      )
      checks.push(
        successful(
          'duplicate mod normalization',
          normalized._tag === 'Success' &&
            (plugin.manifest.capabilities.includes('mods')
              ? normalized.success.mods.length === 1
              : normalized.success.mods.length === 0),
        ),
      )
    }
    const dependencies = yield* Effect.result(
      plugin.runtime.resolveMods(
        plugin.fixture.dependencyGraph.desired,
        plugin.fixture.dependencyGraph.catalog,
      ),
    )
    checks.push(
      successful(
        'dependency-aware mod resolution',
        dependencies._tag === 'Success' &&
          dependencies.success.map((mod) => mod.id).join(',') ===
            plugin.fixture.dependencyGraph.expectedOrder.join(','),
      ),
    )
    checks.push(
      successful(
        'rollback metadata and live gate',
        plugin.runtime.rollback.retainReleases >= 2 &&
          plugin.runtime.liveExecution.gated &&
          plugin.runtime.liveExecution.requiredEvidence.length > 0,
      ),
    )
    checks.push(
      successful(
        'resource and ports',
        plugin.manifest.resources.minimum.memoryMiB > 0 && plugin.manifest.ports.length > 0,
      ),
    )
    checks.push(
      successful(
        'permission manifest',
        plugin.permissions.executableNames.length > 0 &&
          plugin.permissions.filesystemRoots.length > 0 &&
          plugin.permissions.filesystemRoots.every((root) => root.startsWith('/var/lib/gridora/')),
      ),
    )
    checks.push(
      successful(
        'version compatibility',
        plugin.manifest.supportedAgentApi.length > 0 &&
          plugin.manifest.supportedControlApi.length > 0,
      ),
    )
    return { pluginId: plugin.manifest.id, passed: checks.every((c) => c.passed), checks }
  })

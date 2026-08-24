import { Effect, Schema } from 'effect'
import {
  PLUGIN_API_VERSION,
  type GamePluginManifest,
  type PluginPermissionManifest,
} from '@gridora/plugin-sdk'
import {
  PluginControlError,
  type ControlFacet,
  type DesiredMod,
  type ModDependencyMetadata,
  type ModMetadataResolution,
  type ResolvedMod,
} from '@gridora/plugin-sdk-control'
import {
  PluginAgentError,
  type AgentFacet,
  type ExecutablePlan,
  type HealthReport,
} from '@gridora/plugin-sdk-agent'
import type { UiFacet } from '@gridora/plugin-sdk-ui'
import { createSteamAppPlan } from '@gridora/steam-runtime'
import type { LocalPluginRuntimeFacet } from '@gridora/plugin-testkit'
import {
  ARMA_REFORGER_WORKSHOP_SOURCE,
  makeArmaReforgerModMetadataResolver,
  offlineArmaReforgerModMetadata,
  type ArmaReforgerModMetadataResolver,
} from './mod-metadata.js'

export const ArmaConfigSchema = Schema.Struct({
  name: Schema.String,
  scenarioId: Schema.String,
  maxPlayers: Schema.Number,
  passwordSecretRef: Schema.optional(Schema.String),
  visible: Schema.Boolean,
  crossPlatform: Schema.Boolean,
})
export type ArmaConfig = typeof ArmaConfigSchema.Type
export const manifest = {
  apiVersion: PLUGIN_API_VERSION,
  id: 'arma-reforger',
  version: '0.1.0',
  displayName: 'Arma Reforger',
  compatibility: {
    os: ['linux'],
    architectures: ['amd64'],
    nativeLinux: true,
    requiresProton: false,
  },
  steam: {
    appId: 1874900,
    loginMode: 'anonymous',
    branchSupport: true,
    installDirectory: '/var/lib/gridora/servers/{serverId}/game',
  },
  resources: {
    minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
    recommended: { cpu: 4, memoryMiB: 8192, diskGiB: 40 },
    sharedNodeAllowed: true,
  },
  ports: [
    {
      name: 'game',
      protocol: 'udp',
      containerPort: 2001,
      required: true,
      playerFacing: true,
      supportsSrv: false,
    },
    {
      name: 'query',
      protocol: 'udp',
      containerPort: 17777,
      required: true,
      playerFacing: true,
      supportsSrv: false,
    },
  ],
  configSchemaVersion: 1,
  dataFormatVersion: 1,
  supportedAgentApi: '^1.0.0',
  supportedControlApi: '^1.0.0',
  restoreValidationImageDigest:
    'sha256:69e0cc046f1a87d56cd7c07732908359c9ba0bc9aafb35ed7adae9f4b81b7784',
  capabilities: [
    'install',
    'update',
    'lifecycle',
    'config',
    'health',
    'query',
    'logs',
    'backup',
    'restore',
    'mods',
    'diagnostics',
    'custom-ui',
  ],
  knownLimitations: [
    'Workshop metadata availability can limit dependency resolution',
    'Credentialed Steam branches are feature-gated',
  ],
} as const satisfies GamePluginManifest
export const permissions = {
  filesystemRoots: ['/var/lib/gridora/servers'],
  executableNames: ['steamcmd', 'ArmaReforgerServer', 'gridora-game-query'],
  networkDestinations: ['api.steampowered.com', 'steamcommunity.com', 'reforger.armaplatform.com'],
  dockerActions: ['create', 'start', 'stop', 'remove', 'inspect', 'logs'],
  secretCategories: ['game-password'],
  portProtocols: ['udp'],
  backupRoots: ['/var/lib/gridora/servers'],
  modSourceDomains: ['reforger.armaplatform.com', 'steamcommunity.com'],
} as const satisfies PluginPermissionManifest
const error = (operation: string, message: string) =>
  new PluginControlError({ pluginId: manifest.id, operation, message })
const workshopId = /^[A-Fa-f0-9]{16}$/
const canonicalModId = (source: string, id: string): string =>
  source === ARMA_REFORGER_WORKSHOP_SOURCE && workshopId.test(id) ? id.toUpperCase() : id
export const validateConfig = (input: unknown): Effect.Effect<ArmaConfig, PluginControlError> => {
  return Effect.flatMap(
    Effect.mapError(Schema.decodeUnknownEffect(ArmaConfigSchema)(input), () =>
      error('validateConfig', 'configuration does not match the Arma schema'),
    ),
    (config) =>
      config.name.length > 0 &&
      config.scenarioId.length > 0 &&
      Number.isInteger(config.maxPlayers) &&
      config.maxPlayers >= 1 &&
      config.maxPlayers <= 128
        ? Effect.succeed(config)
        : Effect.fail(
            error('validateConfig', 'name, scenarioId, and maxPlayers (1-128) are required'),
          ),
  )
}
export const parseModReference = (
  reference: string,
): Effect.Effect<ResolvedMod, PluginControlError> => {
  try {
    const url = new URL(reference)
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      (url.hostname !== 'reforger.armaplatform.com' && url.hostname !== 'steamcommunity.com')
    )
      return Effect.fail(error('resolveModReference', 'unsupported mod source domain'))
    const parts = url.pathname.split('/').filter(Boolean)
    const suppliedId = parts.at(-1)
    if (suppliedId === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(suppliedId))
      return Effect.fail(error('resolveModReference', 'mod identity is missing or invalid'))
    const id =
      url.hostname === ARMA_REFORGER_WORKSHOP_SOURCE
        ? /^([A-Fa-f0-9]{16})(?:-[A-Za-z0-9][A-Za-z0-9_-]*)?$/.exec(suppliedId)?.[1]
        : suppliedId
    if (id === undefined)
      return Effect.fail(
        error('resolveModReference', 'Arma Workshop reference must carry a 16-character mod ID'),
      )
    return Effect.succeed({
      source: url.hostname,
      id: canonicalModId(url.hostname, id),
      loadOrder: 0,
      dependencies: [],
      warnings:
        url.hostname === ARMA_REFORGER_WORKSHOP_SOURCE
          ? ['Dependency metadata must be confirmed during staging']
          : ['Steam references cannot use the supported Arma metadata endpoint'],
      sourceUrl: url.toString(),
    })
  } catch {
    return Effect.fail(error('resolveModReference', 'invalid mod URL'))
  }
}
export const resolveArmaMods = (
  desired: readonly DesiredMod[],
  catalog: readonly ModDependencyMetadata[],
): Effect.Effect<readonly ResolvedMod[], PluginControlError> =>
  Effect.gen(function* () {
    const canonicalDesired = desired.map((mod) => ({
      ...mod,
      id: canonicalModId(mod.source, mod.id),
    }))
    const canonicalCatalog = catalog.map((entry) => ({
      ...entry,
      id: canonicalModId(entry.source, entry.id),
      dependencies: entry.dependencies.map((dependency) =>
        canonicalModId(entry.source, dependency),
      ),
    }))
    const allowed = new Set<string>(permissions.modSourceDomains)
    if (
      canonicalDesired.some((mod) => !allowed.has(mod.source)) ||
      canonicalCatalog.some((entry) => !allowed.has(entry.source))
    )
      return yield* error('resolveMods', 'mod source is not allowlisted')
    if (
      canonicalDesired.some((mod) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mod.id)) ||
      canonicalCatalog.some(
        (entry) =>
          !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.id) ||
          entry.dependencies.some((dependency) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(dependency)),
      )
    )
      return yield* error('resolveMods', 'mod identity is invalid')
    const metadata = new Map(
      canonicalCatalog.map((entry) => [`${entry.source}:${entry.id}`, entry]),
    )
    if (metadata.size !== canonicalCatalog.length)
      return yield* error('resolveMods', 'duplicate dependency metadata')
    const requested = [...canonicalDesired]
      .sort((a, b) => a.loadOrder - b.loadOrder || a.id.localeCompare(b.id))
      .filter(
        (mod, index, all) =>
          all.findIndex(
            (candidate) => candidate.source === mod.source && candidate.id === mod.id,
          ) === index,
      )
    const result: ResolvedMod[] = []
    const complete = new Set<string>()
    const visiting = new Set<string>()
    const visit = (
      source: string,
      id: string,
      root: DesiredMod,
    ): Effect.Effect<void, PluginControlError> =>
      Effect.gen(function* () {
        const key = `${source}:${id}`
        if (complete.has(key)) return
        if (visiting.has(key)) return yield* error('resolveMods', 'mod dependency cycle detected')
        visiting.add(key)
        const entry = metadata.get(key)
        if (id !== root.id && entry === undefined)
          return yield* error('resolveMods', 'mod dependency metadata is incomplete')
        const dependencies = [...(entry?.dependencies ?? [])].sort()
        for (const dependency of dependencies) yield* visit(source, dependency, root)
        visiting.delete(key)
        complete.add(key)
        result.push({
          source,
          id,
          loadOrder: id === root.id ? root.loadOrder : 0,
          ...(id === root.id && root.requestedVersion !== undefined
            ? { requestedVersion: root.requestedVersion }
            : {}),
          ...(entry?.version === undefined ? {} : { resolvedVersion: entry.version }),
          dependencies,
          warnings:
            entry === undefined
              ? ['Dependency metadata unavailable; staged validation required']
              : [...(entry.warnings ?? [])],
          ...(entry?.sourceUrl === undefined ? {} : { sourceUrl: entry.sourceUrl }),
        })
      })
    for (const mod of requested) yield* visit(mod.source, mod.id, mod)
    return result
  })
export const makeArmaControl = (
  metadataResolver: ArmaReforgerModMetadataResolver = makeArmaReforgerModMetadataResolver(),
): ControlFacet<ArmaConfig> => ({
  validateConfig,
  normalizeDesiredState: (config, mods) =>
    Effect.succeed({
      config,
      mods: [...mods]
        .map((mod) => ({ ...mod, id: canonicalModId(mod.source, mod.id) }))
        .sort((a, b) => a.loadOrder - b.loadOrder || a.id.localeCompare(b.id))
        .filter(
          (m, index, all) => all.findIndex((x) => x.source === m.source && x.id === m.id) === index,
        ),
    }),
  planDeployment: (config, mods, options) => {
    // Preview callers omit this value by design. They retain the deterministic
    // offline plan from ADR 0042 and never invoke the external resolver.
    const metadata: ModMetadataResolution = options?.modMetadata ?? offlineArmaReforgerModMetadata()
    return Effect.map(resolveArmaMods(mods, metadata.catalog), (resolved) => ({
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      resources: manifest.resources.recommended,
      ports: manifest.ports,
      install: { appId: manifest.steam.appId, loginMode: manifest.steam.loginMode },
      config,
      mods: resolved.map((mod) => ({
        ...mod,
        warnings:
          metadata.warnings.length === 0 ? mod.warnings : [...mod.warnings, ...metadata.warnings],
      })),
      modMetadata: metadata,
      steps: [
        'steam-install',
        'render-server-json',
        'stage-mods',
        'validate-config',
        'start',
        'query-health',
      ],
    }))
  },
  resolveModMetadata: metadataResolver.resolve,
  resolveModReference: parseModReference,
  redactAudit: (input) =>
    typeof input === 'object' && input !== null && 'passwordSecretRef' in input
      ? { ...input, passwordSecretRef: '[secret-reference]' }
      : input,
})

/** The reviewed registry exposes live metadata only through the explicit control facet method. */
export const control = makeArmaControl()
const validRoot = (root: string) =>
  root.startsWith('/var/lib/gridora/servers/') &&
  !root.includes('\0') &&
  root
    .split('/')
    .every(
      (segment, index) => index === 0 || (segment !== '' && segment !== '.' && segment !== '..'),
    )
const agentError = (operation: string, message: string) =>
  new PluginAgentError({ pluginId: manifest.id, operation, message })
const steamPlan = (root: string): Effect.Effect<ExecutablePlan, PluginAgentError> =>
  Effect.try({
    try: () => {
      const plan = createSteamAppPlan({
        installRoot: root,
        appId: manifest.steam.appId,
        validate: true,
        operation: 'update',
        credentialMode: 'anonymous',
      })
      return {
        executable: 'steamcmd',
        arguments: plan.argv,
        workingDirectory: plan.cwd,
        environment: plan.environment,
        timeoutSeconds: plan.timeoutSeconds,
      }
    },
    catch: () => agentError('steam', 'install root or Steam request is unsafe'),
  })
export const agent: AgentFacet<ArmaConfig> = {
  installPlan: steamPlan,
  updatePlan: steamPlan,
  renderConfig: (config) =>
    Effect.succeed([
      {
        relativePath: 'config/server.json',
        content: JSON.stringify(
          {
            bindAddress: '0.0.0.0',
            bindPort: 2001,
            publicAddress: '',
            publicPort: 2001,
            a2s: { address: '0.0.0.0', port: 17777 },
            game: {
              name: config.name,
              scenarioId: config.scenarioId,
              maxPlayers: config.maxPlayers,
              visible: config.visible,
              crossPlatform: config.crossPlatform,
              ...(config.passwordSecretRef === undefined
                ? {}
                : { password: { secretRef: config.passwordSecretRef } }),
              mods: [],
            },
          },
          null,
          2,
        ),
        mode: 0o640,
        secret: config.passwordSecretRef !== undefined,
      },
    ]),
  launchPlan: (root, configRoot) =>
    validRoot(root) && validRoot(configRoot)
      ? Effect.succeed({
          executable: 'ArmaReforgerServer',
          arguments: ['-config', `${configRoot}/server.json`, '-profile', `${root}/profile`],
          workingDirectory: root,
          environment: {},
          timeoutSeconds: 30,
        })
      : Effect.fail(agentError('launch', 'path outside server sandbox')),
  healthPlan: (root) =>
    validRoot(root)
      ? Effect.succeed({
          executable: 'gridora-game-query',
          arguments: ['arma-reforger', '--address', '127.0.0.1:17777'],
          workingDirectory: root,
          environment: {},
          timeoutSeconds: 10,
        })
      : Effect.fail(agentError('health', 'path outside server sandbox')),
  parseHealth: (output): HealthReport => {
    const match = /^OK players=(\d+) scenario=(.+) build=(\S+)$/.exec(output.trim())
    return match === null
      ? { status: 'unhealthy', process: true, protocol: false, reasons: ['game query failed'] }
      : {
          status: 'healthy',
          process: true,
          protocol: true,
          players: Number(match[1]),
          scenario: match[2]!,
          build: match[3]!,
          reasons: [],
        }
  },
  parseLog: (line) => ({
    level: /error|fatal/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info',
    message: line.replace(/password\s*=\s*\S+/gi, 'password=[redacted]'),
  }),
  backupPlan: (root) => ({
    roots: [`${root}/profile`, `${root}/config`],
    exclude: [`${root}/game`],
    consistency: 'crash-consistent',
    validateRestore: ['config/server.json', 'profile'],
  }),
  modInstallPlan: (root, mods) =>
    validRoot(root) &&
    mods.every(
      (mod) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mod.id) &&
        (mod.version === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mod.version)),
    )
      ? Effect.succeed(
          mods.map((mod) => ({
            executable: 'ArmaReforgerServer',
            arguments: [
              '-downloadMod',
              mod.id,
              ...(mod.version === undefined ? [] : ['-modVersion', mod.version]),
              '-profile',
              `${root}/profile`,
            ],
            workingDirectory: root,
            environment: {},
            timeoutSeconds: 1800,
          })),
        )
      : Effect.fail(agentError('mods', 'path outside server sandbox')),
}
const safeRelativeManifest = (paths: readonly string[], required: readonly string[]) =>
  paths.every(
    (path) =>
      !path.includes('\0') &&
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  ) && required.every((path) => paths.includes(path))

export const runtime: LocalPluginRuntimeFacet = {
  resolveMods: resolveArmaMods,
  activationPlan: (root, configRoot) =>
    validRoot(root) && validRoot(configRoot)
      ? Effect.succeed([
          {
            executable: 'gridora-game-query',
            arguments: [
              'validate-config',
              '--plugin',
              manifest.id,
              '--path',
              `${configRoot}/server.json`,
            ],
            workingDirectory: root,
            environment: {},
            timeoutSeconds: 10,
          },
          {
            executable: 'gridora-game-query',
            arguments: ['arma-reforger', '--address', '127.0.0.1:17777'],
            workingDirectory: root,
            environment: {},
            timeoutSeconds: 10,
          },
        ])
      : Effect.fail(agentError('activate', 'path outside server sandbox')),
  modValidationPlan: (root, stagedModsRoot) =>
    validRoot(root) && validRoot(stagedModsRoot)
      ? Effect.succeed({
          executable: 'gridora-game-query',
          arguments: ['validate-mods', '--plugin', manifest.id, '--root', stagedModsRoot],
          workingDirectory: root,
          environment: {},
          timeoutSeconds: 30,
        })
      : Effect.fail(agentError('mods', 'path outside server sandbox')),
  restoreValidationPlan: (root) =>
    validRoot(root)
      ? Effect.succeed({
          executable: 'gridora-game-query',
          arguments: ['validate-restore', '--plugin', manifest.id, '--root', root],
          workingDirectory: root,
          environment: {},
          timeoutSeconds: 30,
        })
      : Effect.fail(agentError('restore', 'path outside server sandbox')),
  validateBackupManifest: (paths) =>
    safeRelativeManifest(paths, ['config/server.json', 'profile'])
      ? Effect.void
      : Effect.fail(agentError('backup', 'backup manifest is incomplete or unsafe')),
  rollback: {
    installStrategy: 'immutable-release',
    configStrategy: 'atomic-revision',
    retainReleases: 2,
    dataRollback: 'restore-required',
  },
  liveExecution: {
    gated: true,
    requiredEvidence: [
      'SteamCMD anonymous install exit zero',
      'Arma server process stays running',
      'loopback query reports expected build and scenario',
      'backup restore validates on a disposable server root',
    ],
  },
}
export const ui: UiFacet = {
  fields: [
    { path: 'name', label: 'Server name', kind: 'text', required: true },
    { path: 'scenarioId', label: 'Scenario', kind: 'text', required: true },
    { path: 'maxPlayers', label: 'Maximum players', kind: 'number', required: true },
    { path: 'passwordSecretRef', label: 'Password', kind: 'secret-reference', required: false },
  ],
  contributions: [
    {
      id: 'mod-import',
      title: 'Workshop / Workbench mods',
      routeSuffix: 'mods',
      componentExport: 'ArmaModManager',
      requiredCapability: 'mods',
    },
  ],
}
export const plugin = {
  manifest,
  permissions,
  control,
  agent,
  runtime,
  ui,
  fixture: {
    validConfig: {
      name: 'Gridora',
      scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
      maxPlayers: 32,
      visible: true,
      crossPlatform: true,
    },
    invalidConfig: { name: '', maxPlayers: 999 },
    expectedConfigFiles: ['config/server.json'],
    expectedConfigFragments: ['"scenarioId"', '"maxPlayers": 32'],
    healthyOutput: 'OK players=4 scenario=Conflict build=12345',
    secretLogLine: 'password=conformance-secret',
    dependencyGraph: {
      desired: [{ source: 'reforger.armaplatform.com', id: 'mission-pack', loadOrder: 10 }],
      catalog: [
        {
          source: 'reforger.armaplatform.com',
          id: 'mission-pack',
          version: '2',
          dependencies: ['framework'],
        },
        {
          source: 'reforger.armaplatform.com',
          id: 'framework',
          version: '1',
          dependencies: [],
        },
      ],
      expectedOrder: ['framework', 'mission-pack'],
    },
  },
}

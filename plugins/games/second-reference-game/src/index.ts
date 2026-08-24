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
  type ResolvedMod,
} from '@gridora/plugin-sdk-control'
import { PluginAgentError, type AgentFacet, type ExecutablePlan } from '@gridora/plugin-sdk-agent'
import type { UiFacet } from '@gridora/plugin-sdk-ui'
import type { LocalPluginRuntimeFacet } from '@gridora/plugin-testkit'
import { createSteamAppPlan } from '@gridora/steam-runtime'

export const ValheimConfigSchema = Schema.Struct({
  name: Schema.String,
  world: Schema.String,
  passwordSecretRef: Schema.String,
  public: Schema.Boolean,
})
export type ValheimConfig = typeof ValheimConfigSchema.Type
export const manifest = {
  apiVersion: PLUGIN_API_VERSION,
  id: 'valheim',
  version: '0.1.0',
  displayName: 'Valheim Dedicated Server',
  compatibility: {
    os: ['linux'],
    architectures: ['amd64'],
    nativeLinux: true,
    requiresProton: false,
  },
  steam: {
    appId: 896660,
    loginMode: 'anonymous',
    branchSupport: false,
    installDirectory: '/var/lib/gridora/servers/{serverId}/game',
  },
  resources: {
    minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 5 },
    recommended: { cpu: 4, memoryMiB: 8192, diskGiB: 20 },
    sharedNodeAllowed: true,
  },
  ports: [
    {
      name: 'game',
      protocol: 'udp',
      containerPort: 2456,
      count: 3,
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
    'sha256:416241e5c762057f93e843ea1a895c1eab25674fef04cafc538d24d24555fd5b',
  capabilities: ['install', 'update', 'lifecycle', 'config', 'health', 'logs', 'backup', 'restore'],
  knownLimitations: [
    'The game requires a three-port UDP range',
    'Password must be provided through a secret reference',
  ],
} as const satisfies GamePluginManifest
export const permissions = {
  filesystemRoots: ['/var/lib/gridora/servers'],
  executableNames: ['steamcmd', 'valheim_server.x86_64', 'gridora-game-query'],
  networkDestinations: ['api.steampowered.com'],
  dockerActions: ['create', 'start', 'stop', 'remove', 'inspect', 'logs'],
  secretCategories: ['game-password'],
  portProtocols: ['udp'],
  backupRoots: ['/var/lib/gridora/servers'],
  modSourceDomains: [],
} as const satisfies PluginPermissionManifest
const controlError = (op: string, message: string) =>
  new PluginControlError({ pluginId: manifest.id, operation: op, message })
export const validateConfig = (
  input: unknown,
): Effect.Effect<ValheimConfig, PluginControlError> => {
  return Effect.flatMap(
    Effect.mapError(Schema.decodeUnknownEffect(ValheimConfigSchema)(input), () =>
      controlError('validateConfig', 'configuration does not match the Valheim schema'),
    ),
    (config) =>
      config.name.length > 0 && config.world.length > 0 && config.passwordSecretRef.length > 0
        ? Effect.succeed(config)
        : Effect.fail(
            controlError('validateConfig', 'name, world, and passwordSecretRef must be non-empty'),
          ),
  )
}
export const control: ControlFacet<ValheimConfig> = {
  validateConfig,
  normalizeDesiredState: (config) => Effect.succeed({ config, mods: [] }),
  planDeployment: (config) =>
    Effect.succeed({
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      resources: manifest.resources.recommended,
      ports: manifest.ports,
      install: { appId: manifest.steam.appId, loginMode: manifest.steam.loginMode },
      config,
      mods: [],
      steps: ['steam-install', 'render-environment', 'start', 'query-health'],
    }),
  redactAudit: (input) =>
    typeof input === 'object' && input !== null && 'passwordSecretRef' in input
      ? { ...input, passwordSecretRef: '[secret-reference]' }
      : input,
}
const safe = (root: string) =>
  root.startsWith('/var/lib/gridora/servers/') &&
  !root.includes('\0') &&
  root
    .split('/')
    .every(
      (segment, index) => index === 0 || (segment !== '' && segment !== '.' && segment !== '..'),
    )
const agentError = (op: string) =>
  new PluginAgentError({
    pluginId: manifest.id,
    operation: op,
    message: 'path outside server sandbox',
  })
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
    catch: () => agentError('steam'),
  })
export const agent: AgentFacet<ValheimConfig> = {
  installPlan: steamPlan,
  updatePlan: steamPlan,
  renderConfig: (config) =>
    Effect.succeed([
      {
        relativePath: 'config/server.env',
        content: `SERVER_NAME=${JSON.stringify(config.name)}\nWORLD_NAME=${JSON.stringify(config.world)}\nPASSWORD_SECRET_REF=${JSON.stringify(config.passwordSecretRef)}\nPUBLIC=${config.public ? '1' : '0'}\n`,
        mode: 0o640,
        secret: true,
      },
    ]),
  launchPlan: (root, configRoot) =>
    safe(root) && safe(configRoot)
      ? Effect.succeed({
          executable: 'valheim_server.x86_64',
          arguments: [
            '-name',
            '${SERVER_NAME}',
            '-world',
            '${WORLD_NAME}',
            '-password',
            '${RESOLVED_GAME_PASSWORD}',
            '-port',
            '2456',
            '-public',
            '${PUBLIC}',
          ],
          workingDirectory: root,
          environment: { GRIDORA_ENV_FILE: `${configRoot}/server.env` },
          timeoutSeconds: 30,
        })
      : Effect.fail(agentError('launch')),
  healthPlan: (root) =>
    safe(root)
      ? Effect.succeed({
          executable: 'gridora-game-query',
          arguments: ['a2s', '--address', '127.0.0.1:2457'],
          workingDirectory: root,
          environment: {},
          timeoutSeconds: 10,
        })
      : Effect.fail(agentError('health')),
  parseHealth: (output) =>
    output.startsWith('OK')
      ? { status: 'healthy', process: true, protocol: true, reasons: [] }
      : { status: 'unhealthy', process: true, protocol: false, reasons: ['A2S query failed'] },
  parseLog: (line) => ({
    level: /error/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info',
    message: line.replace(/password\s+\S+/gi, 'password [redacted]'),
  }),
  backupPlan: (root) => ({
    roots: [`${root}/data/worlds_local`, `${root}/config`],
    exclude: [`${root}/game`],
    consistency: 'crash-consistent',
    validateRestore: ['data/worlds_local', 'config/server.env'],
  }),
}
const resolveNoMods = (
  desired: readonly DesiredMod[],
): Effect.Effect<readonly ResolvedMod[], PluginControlError> =>
  desired.length === 0
    ? Effect.succeed([])
    : Effect.fail(controlError('resolveMods', 'this plugin does not accept mods'))
const validBackupManifest = (paths: readonly string[]) =>
  paths.every(
    (path) =>
      !path.includes('\0') &&
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  ) && ['data/worlds_local', 'config/server.env'].every((required) => paths.includes(required))
export const runtime: LocalPluginRuntimeFacet = {
  resolveMods: (desired) => resolveNoMods(desired),
  activationPlan: (root, configRoot) =>
    safe(root) && safe(configRoot)
      ? Effect.succeed([
          {
            executable: 'gridora-game-query',
            arguments: [
              'validate-config',
              '--plugin',
              manifest.id,
              '--path',
              `${configRoot}/server.env`,
            ],
            workingDirectory: root,
            environment: {},
            timeoutSeconds: 10,
          },
          {
            executable: 'gridora-game-query',
            arguments: ['a2s', '--address', '127.0.0.1:2457'],
            workingDirectory: root,
            environment: {},
            timeoutSeconds: 10,
          },
        ])
      : Effect.fail(agentError('activate')),
  restoreValidationPlan: (root) =>
    safe(root)
      ? Effect.succeed({
          executable: 'gridora-game-query',
          arguments: ['validate-restore', '--plugin', manifest.id, '--root', root],
          workingDirectory: root,
          environment: {},
          timeoutSeconds: 30,
        })
      : Effect.fail(agentError('restore')),
  validateBackupManifest: (paths) =>
    validBackupManifest(paths) ? Effect.void : Effect.fail(agentError('backup')),
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
      'Valheim process stays running',
      'loopback A2S query succeeds across the allocated port range',
      'world restore validates on a disposable server root',
    ],
  },
}
export const ui: UiFacet = {
  fields: [
    { path: 'name', label: 'Server name', kind: 'text', required: true },
    { path: 'world', label: 'World', kind: 'text', required: true },
    { path: 'passwordSecretRef', label: 'Password', kind: 'secret-reference', required: true },
  ],
  contributions: [],
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
      name: 'Gridora Valheim',
      world: 'gridora',
      passwordSecretRef: 'secret://game/password',
      public: true,
    },
    invalidConfig: { name: '' },
    expectedConfigFiles: ['config/server.env'],
    expectedConfigFragments: ['WORLD_NAME="gridora"', 'PASSWORD_SECRET_REF'],
    healthyOutput: 'OK players=2',
    secretLogLine: 'password conformance-secret',
    dependencyGraph: { desired: [], catalog: [], expectedOrder: [] },
  },
}

import { Context, Effect, Layer, Schema } from 'effect'
import { pluginRegistry } from '@gridora/plugin-registry'
import type {
  ControlPlugin,
  DeploymentPlan,
  DesiredMod,
  PluginControlError,
} from '@gridora/plugin-sdk-control'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

export const DesiredModInput = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  id: Identifier,
  requestedVersion: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
})
export type DesiredModInput = typeof DesiredModInput.Type

export const ConfigPreviewInput = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedConfigRevision: PositiveRevision,
  config: JsonObject,
})
export type ConfigPreviewInput = typeof ConfigPreviewInput.Type

export const ModsPlanInput = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedConfigRevision: PositiveRevision,
  expectedModRevision: Revision,
  desiredMods: Schema.Array(DesiredModInput).check(Schema.isMaxLength(256)),
})
export type ModsPlanInput = typeof ModsPlanInput.Type

export const decodeConfigPreviewInput = (input: unknown) =>
  Schema.decodeUnknownEffect(ConfigPreviewInput, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new DesiredStateValidationError({
          code: 'invalid_config_preview',
          message: 'Configuration preview does not match schema version 1',
        }),
    ),
  )

export const decodeModsPlanInput = (input: unknown) =>
  Schema.decodeUnknownEffect(ModsPlanInput, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new DesiredStateValidationError({
          code: 'invalid_mods_plan',
          message: 'Mod plan does not match schema version 1',
        }),
    ),
  )

export class DesiredStateValidationError extends Schema.TaggedError<DesiredStateValidationError>()(
  'DesiredStateValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class DesiredStateNotFoundError extends Schema.TaggedError<DesiredStateNotFoundError>()(
  'DesiredStateNotFoundError',
  { serverId: Schema.String },
) {}
export class DesiredStateRevisionConflictError extends Schema.TaggedError<DesiredStateRevisionConflictError>()(
  'DesiredStateRevisionConflictError',
  { resource: Schema.String, expected: Schema.Number, actual: Schema.Number },
) {}
export class DesiredStatePluginUnavailableError extends Schema.TaggedError<DesiredStatePluginUnavailableError>()(
  'DesiredStatePluginUnavailableError',
  { pluginId: Schema.String, pluginVersion: Schema.String },
) {}
export class DesiredStateCapabilityError extends Schema.TaggedError<DesiredStateCapabilityError>()(
  'DesiredStateCapabilityError',
  { pluginId: Schema.String, capability: Schema.String },
) {}
export class DesiredStatePersistenceError extends Schema.TaggedError<DesiredStatePersistenceError>()(
  'DesiredStatePersistenceError',
  { operation: Schema.String, message: Schema.String },
) {}

export type DesiredStateControlError =
  | DesiredStateValidationError
  | DesiredStateNotFoundError
  | DesiredStateRevisionConflictError
  | DesiredStatePluginUnavailableError
  | DesiredStateCapabilityError
  | DesiredStatePersistenceError

export interface PersistedGameDesiredState {
  readonly organizationId: string
  readonly serverId: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly activeConfigRevision: number
  readonly configRevision: number
  readonly configSchemaVersion: number
  readonly config: Readonly<Record<string, unknown>>
  readonly modSchemaVersion: number | null
  readonly modRevision: number
  readonly desiredModRevision: number
  readonly resolvedModRevision: number
  readonly desiredMods: readonly DesiredMod[]
  readonly resolvedMods: readonly unknown[]
  readonly observedState: string
  readonly reconciliationError: string | null
}

export interface GameDesiredStateRepositoryShape {
  readonly read: (
    organizationId: string,
    serverId: string,
  ) => Effect.Effect<
    PersistedGameDesiredState,
    DesiredStateNotFoundError | DesiredStatePersistenceError
  >
}
export class GameDesiredStateRepository extends Context.Service<
  GameDesiredStateRepository,
  GameDesiredStateRepositoryShape
>()('@gridora/game-desired-state-control/GameDesiredStateRepository') {}
export const GameDesiredStateRepositoryLayer = (repository: GameDesiredStateRepositoryShape) =>
  Layer.succeed(GameDesiredStateRepository, repository)

export interface GameDesiredStateD1Statement {
  bind(...values: ReadonlyArray<unknown>): GameDesiredStateD1Statement
  first(): Promise<unknown>
}
export interface GameDesiredStateD1Database {
  prepare(sql: string): GameDesiredStateD1Statement
}
export class GameDesiredStateD1Client extends Context.Service<
  GameDesiredStateD1Client,
  GameDesiredStateD1Database
>()('@gridora/game-desired-state-control/GameDesiredStateD1Client') {}
export const GameDesiredStateD1ClientLayer = (database: GameDesiredStateD1Database) =>
  Layer.succeed(GameDesiredStateD1Client, database)

const authoritativeDesiredStateSelect = `
SELECT
  server.organization_id AS organizationId,
  server.id AS serverId,
  server.plugin_id AS pluginId,
  server.plugin_version AS pluginVersion,
  server.active_config_revision AS activeConfigRevision,
  config.revision AS configRevision,
  config.schema_version AS configSchemaVersion,
  config.config_json AS configJson,
  mods.schema_version AS modSchemaVersion,
  mods.revision AS modRevision,
  mods.desired_revision AS desiredModRevision,
  mods.resolved_revision AS resolvedModRevision,
  mods.desired_json AS desiredModsJson,
  mods.resolved_json AS resolvedModsJson,
  server.observed_state AS observedState,
  server.reconciliation_error AS reconciliationError
FROM game_servers AS server
JOIN game_server_config_revisions AS config
  ON config.organization_id = server.organization_id
 AND config.server_id = server.id
 AND config.revision = (
   SELECT MAX(latest.revision)
   FROM game_server_config_revisions AS latest
   WHERE latest.organization_id = server.organization_id
     AND latest.server_id = server.id
 )
LEFT JOIN mod_sets AS mods
  ON mods.organization_id = server.organization_id
 AND mods.server_id = server.id
WHERE server.organization_id = ?
  AND server.id = ?
  AND server.desired_state <> 'deleted'
LIMIT 1`

const object = (input: unknown): Record<string, unknown> | undefined =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
const text = (row: Record<string, unknown>, key: string) =>
  typeof row[key] === 'string' ? (row[key] as string) : undefined
const integer = (row: Record<string, unknown>, key: string) =>
  typeof row[key] === 'number' && Number.isInteger(row[key]) ? (row[key] as number) : undefined
const nullableInteger = (row: Record<string, unknown>, key: string) =>
  row[key] === null ? null : integer(row, key)
const parseJson = (operation: string, value: unknown) =>
  Effect.try({
    try: () => JSON.parse(String(value)) as unknown,
    catch: () => new DesiredStatePersistenceError({ operation, message: 'Stored JSON is invalid' }),
  })

const persistence = (operation: string, message: string) =>
  new DesiredStatePersistenceError({ operation, message })

export const makeGameDesiredStateRepositoryD1 = (
  database: GameDesiredStateD1Database,
): GameDesiredStateRepositoryShape => ({
  read: (organizationId, serverId) =>
    Effect.gen(function* () {
      const value = yield* Effect.tryPromise({
        try: () =>
          database.prepare(authoritativeDesiredStateSelect).bind(organizationId, serverId).first(),
        catch: () => persistence('game-desired-state.read', 'Authoritative state read failed'),
      })
      const row = object(value)
      if (row === undefined) return yield* new DesiredStateNotFoundError({ serverId })
      const storedOrganizationId = text(row, 'organizationId')
      const storedServerId = text(row, 'serverId')
      const pluginId = text(row, 'pluginId')
      const pluginVersion = text(row, 'pluginVersion')
      const activeConfigRevision = integer(row, 'activeConfigRevision')
      const configRevision = integer(row, 'configRevision')
      const configSchemaVersion = integer(row, 'configSchemaVersion')
      const modSchemaVersion = nullableInteger(row, 'modSchemaVersion')
      const modRevision = row.modRevision === null ? 0 : integer(row, 'modRevision')
      const desiredModRevision =
        row.desiredModRevision === null ? 0 : integer(row, 'desiredModRevision')
      const resolvedModRevision =
        row.resolvedModRevision === null ? 0 : integer(row, 'resolvedModRevision')
      const observedState = text(row, 'observedState')
      const reconciliationError =
        row.reconciliationError === null ? null : text(row, 'reconciliationError')
      if (
        storedOrganizationId !== organizationId ||
        storedServerId !== serverId ||
        pluginId === undefined ||
        pluginVersion === undefined ||
        activeConfigRevision === undefined ||
        configRevision === undefined ||
        configSchemaVersion === undefined ||
        modSchemaVersion === undefined ||
        modRevision === undefined ||
        desiredModRevision === undefined ||
        resolvedModRevision === undefined ||
        observedState === undefined ||
        (row.reconciliationError !== null &&
          row.reconciliationError !== undefined &&
          reconciliationError === undefined)
      )
        return yield* persistence('game-desired-state.decode', 'Stored state is incomplete')
      const configUnknown = yield* parseJson('game-desired-state.config-json', row.configJson)
      const config = object(configUnknown)
      if (config === undefined)
        return yield* persistence(
          'game-desired-state.config-json',
          'Stored config is not an object',
        )
      const desiredModsUnknown =
        row.desiredModsJson === null
          ? []
          : yield* parseJson('game-desired-state.mods-json', row.desiredModsJson)
      const desiredMods = yield* Schema.decodeUnknownEffect(Schema.Array(DesiredModInput), {
        onExcessProperty: 'error',
      })(desiredModsUnknown).pipe(
        Effect.mapError(() =>
          persistence('game-desired-state.mods-json', 'Stored desired mods are invalid'),
        ),
      )
      const normalizedDesiredMods: readonly DesiredMod[] = desiredMods.map((mod) => ({
        source: mod.source,
        id: mod.id,
        loadOrder: mod.loadOrder,
        ...(mod.requestedVersion === undefined ? {} : { requestedVersion: mod.requestedVersion }),
      }))
      const resolvedModsUnknown =
        row.resolvedModsJson === null || row.resolvedModsJson === undefined
          ? []
          : yield* parseJson('game-desired-state.resolved-mods-json', row.resolvedModsJson)
      const resolvedMods = Array.isArray(resolvedModsUnknown)
        ? resolvedModsUnknown
        : yield* persistence(
            'game-desired-state.resolved-mods-json',
            'Stored resolved mods are not an array',
          )
      return {
        organizationId,
        serverId,
        pluginId,
        pluginVersion,
        activeConfigRevision,
        configRevision,
        configSchemaVersion,
        config,
        modSchemaVersion,
        modRevision,
        desiredModRevision,
        resolvedModRevision,
        desiredMods: normalizedDesiredMods,
        resolvedMods,
        observedState,
        reconciliationError: reconciliationError ?? null,
      }
    }),
})

export const makeGameDesiredStateRepositoryD1FromContext = Effect.gen(function* () {
  const database = yield* GameDesiredStateD1Client
  return makeGameDesiredStateRepositoryD1(database)
})
export const GameDesiredStateRepositoryD1Live = Layer.effect(
  GameDesiredStateRepository,
  makeGameDesiredStateRepositoryD1FromContext,
)

export interface RedactedSecretField {
  readonly path: string
  readonly state: 'configured'
}

export const GameConfigReadResponse = Schema.Struct({
  organizationId: Identifier,
  serverId: Identifier,
  plugin: Schema.Struct({ id: Identifier, version: Identifier }),
  revision: PositiveRevision,
  activeRevision: PositiveRevision,
  schemaVersion: PositiveRevision,
  config: Schema.Json,
  secretFields: Schema.Array(
    Schema.Struct({ path: Schema.String, state: Schema.Literal('configured') }),
  ),
  readOnly: Schema.Literal(true),
})
export type GameConfigReadResponse = typeof GameConfigReadResponse.Type

export const GameModsReadResponse = Schema.Struct({
  organizationId: Identifier,
  serverId: Identifier,
  plugin: Schema.Struct({ id: Identifier, version: Identifier }),
  desiredRevision: Revision,
  resolvedRevision: Revision,
  state: Schema.Literals(['resolved', 'pending', 'failed']),
  error: Schema.NullOr(Schema.String),
  desiredMods: Schema.Array(
    Schema.Struct({
      source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
      id: Identifier,
      requestedVersion: Schema.NullOr(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      ),
      loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    }),
  ),
  /** Resolved mod records are plugin-owned data, returned only from tenant D1. */
  resolvedMods: Schema.Array(Schema.Unknown),
  readOnly: Schema.Literal(true),
})
export type GameModsReadResponse = typeof GameModsReadResponse.Type

const PluginResponse = Schema.Struct({ id: Identifier, version: Identifier })
const SecretFieldsResponse = Schema.Array(
  Schema.Struct({ path: Schema.String, state: Schema.Literal('configured') }),
)

export const GameExternalMetadataResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal('complete'), reason: Schema.Null }),
  Schema.Struct({
    status: Schema.Literal('unresolved'),
    reason: Schema.Literal('external_dependency_metadata_unavailable'),
  }),
])
export type GameExternalMetadataResponse = typeof GameExternalMetadataResponse.Type

export const GameModResolutionResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('resolved'),
    reason: Schema.Null,
    resolvedVersion: Schema.String,
    dependencies: Schema.Array(Identifier),
  }),
  Schema.Struct({
    status: Schema.Literal('unresolved'),
    reason: Schema.Literal('external_dependency_metadata_unavailable'),
    resolvedVersion: Schema.Null,
    dependencies: Schema.Null,
  }),
])
export type GameModResolutionResponse = typeof GameModResolutionResponse.Type

export const GameDesiredModResponse = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  id: Identifier,
  requestedVersion: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
})
export type GameDesiredModResponse = typeof GameDesiredModResponse.Type

export const GamePlannedModResponse = Schema.Struct({
  ...GameDesiredModResponse.fields,
  resolution: GameModResolutionResponse,
  warnings: Schema.Array(Schema.String),
})
export type GamePlannedModResponse = typeof GamePlannedModResponse.Type

export const GameDeploymentPreviewResponse = Schema.Struct({
  pluginId: Identifier,
  pluginVersion: Identifier,
  resources: Schema.Struct({
    cpu: Schema.Number.check(Schema.isGreaterThan(0)),
    memoryMiB: Schema.Number.check(Schema.isGreaterThan(0)),
    diskGiB: Schema.Number.check(Schema.isGreaterThan(0)),
  }),
  ports: Schema.Array(
    Schema.Struct({
      name: Identifier,
      protocol: Schema.Literals(['tcp', 'udp']),
      containerPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      count: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      required: Schema.Boolean,
      playerFacing: Schema.Boolean,
      supportsSrv: Schema.Boolean,
    }),
  ),
  install: Schema.Struct({
    appId: Schema.Int.check(Schema.isGreaterThan(0)),
    loginMode: Schema.Literals(['anonymous', 'credentialed']),
    branch: Schema.optional(Schema.String),
  }),
  config: Schema.Json,
  secretFields: SecretFieldsResponse,
  mods: Schema.Array(GamePlannedModResponse),
  steps: Schema.Array(Schema.String),
  sideEffects: Schema.Literal(false),
})
export type GameDeploymentPreviewResponse = typeof GameDeploymentPreviewResponse.Type

export const GameConfigDiffEntryResponse = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(['added', 'removed', 'changed']),
  before: Schema.optional(Schema.Json),
  after: Schema.optional(Schema.Json),
})
export type GameConfigDiffEntryResponse = typeof GameConfigDiffEntryResponse.Type

export const GameConfigPreviewResponse = Schema.Struct({
  organizationId: Identifier,
  serverId: Identifier,
  plugin: PluginResponse,
  baseConfigRevision: PositiveRevision,
  outcome: Schema.Literals(['no-change', 'change']),
  normalizedConfig: Schema.Json,
  secretFields: SecretFieldsResponse,
  diff: Schema.Array(GameConfigDiffEntryResponse),
  deployment: GameDeploymentPreviewResponse,
  externalMetadata: GameExternalMetadataResponse,
  sideEffects: Schema.Literal(false),
})
export type GameConfigPreviewResponse = typeof GameConfigPreviewResponse.Type

export const GameModsPlanResponse = Schema.Struct({
  organizationId: Identifier,
  serverId: Identifier,
  plugin: PluginResponse,
  baseConfigRevision: PositiveRevision,
  baseModRevision: Revision,
  desiredMods: Schema.Array(GameDesiredModResponse),
  plannedMods: Schema.Array(GamePlannedModResponse),
  externalMetadata: GameExternalMetadataResponse,
  networkFetches: Schema.Literal(0),
  sideEffects: Schema.Literal(false),
})
export type GameModsPlanResponse = typeof GameModsPlanResponse.Type

export interface RedactedValue {
  readonly value: unknown
  readonly secretFields: readonly RedactedSecretField[]
}

const secretKey = /(?:secret|password|token|credential|private[-_]?key)/i
const redact = (input: unknown): RedactedValue => {
  const secretFields: RedactedSecretField[] = []
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}/${index}`))
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
        if (secretKey.test(key)) {
          if (entry !== undefined && entry !== null && entry !== '')
            secretFields.push({ path: childPath, state: 'configured' })
          return [key, entry === undefined || entry === null || entry === '' ? null : '[redacted]']
        }
        return [key, visit(entry, childPath)]
      }),
    )
  }
  return { value: visit(input, ''), secretFields }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export interface ConfigDiffEntry {
  readonly path: string
  readonly change: 'added' | 'removed' | 'changed'
  readonly before?: unknown
  readonly after?: unknown
}
const diff = (before: unknown, after: unknown, path = ''): readonly ConfigDiffEntry[] => {
  if (canonical(before) === canonical(after)) return []
  const beforeObject = object(before)
  const afterObject = object(after)
  if (beforeObject !== undefined && afterObject !== undefined) {
    const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort()
    return keys.flatMap((key) => {
      const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
      if (!(key in beforeObject))
        return [{ path: childPath, change: 'added', after: afterObject[key] }]
      if (!(key in afterObject))
        return [{ path: childPath, change: 'removed', before: beforeObject[key] }]
      return diff(beforeObject[key], afterObject[key], childPath)
    })
  }
  return [{ path: path || '/', change: 'changed', before, after }]
}

const publicDiff = (before: unknown, after: unknown): readonly ConfigDiffEntry[] =>
  diff(before, after).map((entry) => {
    const finalSegment = entry.path.split('/').at(-1)?.replaceAll('~1', '/').replaceAll('~0', '~')
    const hidesValue = finalSegment !== undefined && secretKey.test(finalSegment)
    return {
      path: entry.path,
      change: entry.change,
      ...('before' in entry
        ? { before: hidesValue ? '[redacted]' : redact(entry.before).value }
        : {}),
      ...('after' in entry ? { after: hidesValue ? '[redacted]' : redact(entry.after).value } : {}),
    }
  })

const selectPlugin = (state: PersistedGameDesiredState) => {
  const plugin = pluginRegistry.get(`${state.pluginId}@${state.pluginVersion}`) as
    | ControlPlugin
    | undefined
  if (plugin === undefined)
    return Effect.fail(
      new DesiredStatePluginUnavailableError({
        pluginId: state.pluginId,
        pluginVersion: state.pluginVersion,
      }),
    )
  if (plugin.manifest.configSchemaVersion !== state.configSchemaVersion)
    return Effect.fail(
      persistence(
        'game-desired-state.plugin-schema',
        'Plugin config schema version is incompatible',
      ),
    )
  return Effect.succeed(plugin)
}

const pluginFailure = (_error: PluginControlError) =>
  new DesiredStateValidationError({
    code: 'plugin_validation_failed',
    message: 'The desired state is not valid for the authoritative game plugin',
  })

const checkConfigRevision = (state: PersistedGameDesiredState, expected: number) =>
  expected === state.configRevision
    ? Effect.void
    : Effect.fail(
        new DesiredStateRevisionConflictError({
          resource: 'game-server-config',
          expected,
          actual: state.configRevision,
        }),
      )
const checkModRevision = (state: PersistedGameDesiredState, expected: number) =>
  expected === state.modRevision
    ? Effect.void
    : Effect.fail(
        new DesiredStateRevisionConflictError({
          resource: 'game-server-mods',
          expected,
          actual: state.modRevision,
        }),
      )

const publicPlan = (plan: DeploymentPlan) => {
  const config = redact(plan.config)
  return {
    pluginId: plan.pluginId,
    pluginVersion: plan.pluginVersion,
    resources: plan.resources,
    ports: plan.ports,
    install: plan.install,
    config: config.value,
    secretFields: config.secretFields,
    mods: plan.mods.map((mod) => ({
      source: mod.source,
      id: mod.id,
      requestedVersion: mod.requestedVersion ?? null,
      loadOrder: mod.loadOrder,
      resolution:
        mod.resolvedVersion === undefined
          ? {
              status: 'unresolved' as const,
              reason: 'external_dependency_metadata_unavailable' as const,
              resolvedVersion: null,
              dependencies: null,
            }
          : {
              status: 'resolved' as const,
              reason: null,
              resolvedVersion: mod.resolvedVersion,
              dependencies: mod.dependencies,
            },
      warnings: mod.warnings,
    })),
    steps: plan.steps,
    sideEffects: false as const,
  }
}

const decodeResponse = <S extends Schema.Top>(schema: S, operation: string, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(() =>
      persistence(operation, 'Generated response does not match the public response contract'),
    ),
  )

export interface GameDesiredStateControlShape {
  readonly getConfig: (
    organizationId: string,
    serverId: string,
  ) => Effect.Effect<GameConfigReadResponse, DesiredStateControlError>
  readonly previewConfig: (
    organizationId: string,
    serverId: string,
    input: unknown,
  ) => Effect.Effect<GameConfigPreviewResponse, DesiredStateControlError>
  readonly getMods: (
    organizationId: string,
    serverId: string,
  ) => Effect.Effect<GameModsReadResponse, DesiredStateControlError>
  readonly planMods: (
    organizationId: string,
    serverId: string,
    input: unknown,
  ) => Effect.Effect<GameModsPlanResponse, DesiredStateControlError>
}
export class GameDesiredStateControl extends Context.Service<
  GameDesiredStateControl,
  GameDesiredStateControlShape
>()('@gridora/game-desired-state-control/GameDesiredStateControl') {}

export const makeGameDesiredStateControl = Effect.gen(function* () {
  const repository = yield* GameDesiredStateRepository
  const load = (organizationId: string, serverId: string) =>
    Effect.gen(function* () {
      const state = yield* repository.read(organizationId, serverId)
      const plugin = yield* selectPlugin(state)
      return { state, plugin }
    })
  return {
    getConfig: (organizationId, serverId) =>
      Effect.gen(function* () {
        const { state, plugin } = yield* load(organizationId, serverId)
        const validated = yield* plugin.control
          .validateConfig(state.config)
          .pipe(Effect.mapError(pluginFailure))
        const redacted = redact(plugin.control.redactAudit(validated))
        return yield* decodeResponse(GameConfigReadResponse, 'game-desired-state.config-response', {
          organizationId,
          serverId,
          plugin: { id: state.pluginId, version: state.pluginVersion },
          revision: state.configRevision,
          activeRevision: state.activeConfigRevision,
          schemaVersion: state.configSchemaVersion,
          config: redacted.value,
          secretFields: redacted.secretFields,
          readOnly: true as const,
        })
      }),
    getMods: (organizationId, serverId) =>
      Effect.gen(function* () {
        const { state, plugin } = yield* load(organizationId, serverId)
        if (!plugin.manifest.capabilities.includes('mods'))
          return yield* new DesiredStateCapabilityError({
            pluginId: state.pluginId,
            capability: 'mods',
          })
        const desiredMods = state.desiredMods.map((mod) => ({
          source: mod.source,
          id: mod.id,
          requestedVersion: mod.requestedVersion ?? null,
          loadOrder: mod.loadOrder,
        }))
        const failed = state.observedState === 'failed' || state.reconciliationError !== null
        return yield* decodeResponse(
          GameModsReadResponse,
          'game-desired-state.mods-read-response',
          {
            organizationId,
            serverId,
            plugin: { id: state.pluginId, version: state.pluginVersion },
            desiredRevision: state.desiredModRevision,
            resolvedRevision: state.resolvedModRevision,
            state: failed
              ? ('failed' as const)
              : state.resolvedModRevision === state.desiredModRevision
                ? ('resolved' as const)
                : ('pending' as const),
            // D1 reconciliation errors may contain provider/agent details.  The
            // public read exposes only a stable state code; diagnostic detail
            // remains in tenant-scoped operation/audit records.
            error: failed ? 'authoritative_observation_failed' : null,
            desiredMods,
            resolvedMods: state.resolvedMods,
            readOnly: true as const,
          },
        )
      }),
    previewConfig: (organizationId, serverId, input) =>
      Effect.gen(function* () {
        const decoded = yield* decodeConfigPreviewInput(input)
        const { state, plugin } = yield* load(organizationId, serverId)
        yield* checkConfigRevision(state, decoded.expectedConfigRevision)
        const validated = yield* plugin.control
          .validateConfig(decoded.config)
          .pipe(Effect.mapError(pluginFailure))
        const normalized = yield* plugin.control
          .normalizeDesiredState(validated, state.desiredMods)
          .pipe(Effect.mapError(pluginFailure))
        const deployment = yield* plugin.control
          .planDeployment(normalized.config, normalized.mods)
          .pipe(Effect.mapError(pluginFailure))
        const afterRedaction = redact(plugin.control.redactAudit(normalized.config))
        return yield* decodeResponse(
          GameConfigPreviewResponse,
          'game-desired-state.config-preview-response',
          {
            organizationId,
            serverId,
            plugin: { id: state.pluginId, version: state.pluginVersion },
            baseConfigRevision: state.configRevision,
            outcome:
              canonical(state.config) === canonical(normalized.config) ? 'no-change' : 'change',
            normalizedConfig: afterRedaction.value,
            secretFields: afterRedaction.secretFields,
            diff: publicDiff(state.config, normalized.config),
            deployment: publicPlan(deployment),
            externalMetadata: deployment.mods.some((mod) => mod.resolvedVersion === undefined)
              ? {
                  status: 'unresolved' as const,
                  reason: 'external_dependency_metadata_unavailable' as const,
                }
              : { status: 'complete' as const, reason: null },
            sideEffects: false as const,
          },
        )
      }),
    planMods: (organizationId, serverId, input) =>
      Effect.gen(function* () {
        const decoded = yield* decodeModsPlanInput(input)
        const { state, plugin } = yield* load(organizationId, serverId)
        yield* checkConfigRevision(state, decoded.expectedConfigRevision)
        yield* checkModRevision(state, decoded.expectedModRevision)
        if (!plugin.manifest.capabilities.includes('mods'))
          return yield* new DesiredStateCapabilityError({
            pluginId: state.pluginId,
            capability: 'mods',
          })
        const config = yield* plugin.control
          .validateConfig(state.config)
          .pipe(Effect.mapError(pluginFailure))
        const normalized = yield* plugin.control
          .normalizeDesiredState(
            config,
            decoded.desiredMods.map((mod) => ({
              source: mod.source,
              id: mod.id,
              loadOrder: mod.loadOrder,
              ...(mod.requestedVersion === undefined
                ? {}
                : { requestedVersion: mod.requestedVersion }),
            })),
          )
          .pipe(Effect.mapError(pluginFailure))
        const deployment = yield* plugin.control
          .planDeployment(normalized.config, normalized.mods)
          .pipe(Effect.mapError(pluginFailure))
        return yield* decodeResponse(GameModsPlanResponse, 'game-desired-state.mods-response', {
          organizationId,
          serverId,
          plugin: { id: state.pluginId, version: state.pluginVersion },
          baseConfigRevision: state.configRevision,
          baseModRevision: state.modRevision,
          desiredMods: normalized.mods.map((mod) => ({
            source: mod.source,
            id: mod.id,
            requestedVersion: mod.requestedVersion ?? null,
            loadOrder: mod.loadOrder,
          })),
          plannedMods: publicPlan(deployment).mods,
          externalMetadata:
            normalized.mods.length === 0
              ? { status: 'complete' as const, reason: null }
              : {
                  status: 'unresolved' as const,
                  reason: 'external_dependency_metadata_unavailable' as const,
                },
          networkFetches: 0 as const,
          sideEffects: false as const,
        })
      }),
  } satisfies GameDesiredStateControlShape
})

export const GameDesiredStateControlLive = Layer.effect(
  GameDesiredStateControl,
  makeGameDesiredStateControl,
)

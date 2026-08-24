import { Effect, Schema } from 'effect'
import type { AuditActorType, AuditRequestContextValue } from '@gridora/audit-contracts'
import { pluginRegistry } from '@gridora/plugin-registry'
import type { ControlFacet, DesiredMod, DeploymentPlan } from '@gridora/plugin-sdk-control'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

export const GameResourceRequest = Schema.Struct({
  cpu: Schema.Number.check(Schema.isGreaterThan(0)),
  memoryMiB: Schema.Int.check(Schema.isGreaterThanOrEqualTo(128)),
  diskGiB: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type GameResourceRequest = typeof GameResourceRequest.Type

export const GamePlacementIntent = Schema.Struct({
  mode: Schema.Literals(['shared', 'dedicated']),
  nodeId: Schema.optional(Identifier),
})
export type GamePlacementIntent = typeof GamePlacementIntent.Type

export const GamePortLeaseIntent = Schema.Struct({
  protocol: Schema.Literals(['tcp', 'udp']),
  containerPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  publicPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
export type GamePortLeaseIntent = typeof GamePortLeaseIntent.Type

/**
 * A desired update policy controls future lifecycle requests. It is not an
 * instruction to start an update at manifest apply time.
 */
export const GameUpdatePolicy = Schema.Struct({
  mode: Schema.Literals(['manual', 'automatic']),
  backupBeforeUpdate: Schema.Boolean,
})
export type GameUpdatePolicy = typeof GameUpdatePolicy.Type
export const GameUpdatePolicyInput = Schema.Struct({
  mode: Schema.optional(GameUpdatePolicy.fields.mode),
  backupBeforeUpdate: Schema.optional(Schema.Boolean),
})
export type GameUpdatePolicyInput = typeof GameUpdatePolicyInput.Type
export const DefaultGameUpdatePolicy: GameUpdatePolicy = {
  mode: 'manual',
  backupBeforeUpdate: true,
}
export const normalizeGameUpdatePolicy = (
  input: GameUpdatePolicyInput | undefined,
): GameUpdatePolicy => ({
  mode: input?.mode ?? DefaultGameUpdatePolicy.mode,
  backupBeforeUpdate: input?.backupBeforeUpdate ?? DefaultGameUpdatePolicy.backupBeforeUpdate,
})

/**
 * A desired backup policy controls scheduled/future backup behavior. It does
 * not execute a backup merely because a manifest is accepted.
 */
export const GameBackupPolicy = Schema.Struct({
  schedule: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  retainCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
})
export type GameBackupPolicy = typeof GameBackupPolicy.Type
export const GameBackupPolicyInput = Schema.Struct({
  schedule: Schema.optional(GameBackupPolicy.fields.schedule),
  retainCount: Schema.optional(GameBackupPolicy.fields.retainCount),
})
export type GameBackupPolicyInput = typeof GameBackupPolicyInput.Type
export const DefaultGameBackupPolicy: GameBackupPolicy = {
  schedule: '0 4 * * *',
  retainCount: 7,
}
export const normalizeGameBackupPolicy = (
  input: GameBackupPolicyInput | undefined,
): GameBackupPolicy => ({
  schedule: input?.schedule ?? DefaultGameBackupPolicy.schedule,
  retainCount: input?.retainCount ?? DefaultGameBackupPolicy.retainCount,
})

export const GameCreateIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Name,
  pluginId: Identifier,
  placement: GamePlacementIntent,
  resources: Schema.optional(GameResourceRequest),
  config: JsonObject,
  mods: Schema.Array(
    Schema.Struct({
      source: Identifier,
      id: Identifier,
      requestedVersion: Schema.optional(Identifier),
      loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    }),
  ).check(Schema.isMaxLength(256)),
  domain: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253))),
  steamCredentialRef: Schema.optional(Identifier),
  /** Explicitly persisted with defaults at lifecycle acceptance. */
  updatePolicy: Schema.optional(GameUpdatePolicyInput),
  /** Explicitly persisted with defaults at lifecycle acceptance. */
  backupPolicy: Schema.optional(GameBackupPolicyInput),
})
export type GameCreateIntent = typeof GameCreateIntent.Type

export const GameStateIntent = Schema.Struct({
  action: Schema.Literals(['start', 'stop', 'restart']),
})
export type GameStateIntent = typeof GameStateIntent.Type

export const GameUpdateIntent = Schema.Struct({
  action: Schema.Literal('update'),
  expectedConfigRevision: PositiveRevision,
  expectedModRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  backupBeforeUpdate: Schema.Boolean,
})
export type GameUpdateIntent = typeof GameUpdateIntent.Type

export const GameConfigApplyIntent = Schema.Struct({
  action: Schema.Literal('apply-config'),
  expectedConfigRevision: PositiveRevision,
  config: JsonObject,
})
export type GameConfigApplyIntent = typeof GameConfigApplyIntent.Type

export const GameModsSyncIntent = Schema.Struct({
  action: Schema.Literal('sync-mods'),
  expectedConfigRevision: PositiveRevision,
  expectedModRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mods: Schema.Array(
    Schema.Struct({
      source: Identifier,
      id: Identifier,
      requestedVersion: Schema.optional(Identifier),
      loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    }),
  ).check(Schema.isMaxLength(256)),
})
export type GameModsSyncIntent = typeof GameModsSyncIntent.Type

export const GameDeleteIntent = Schema.Struct({
  action: Schema.Literal('delete'),
  backupPolicy: Schema.Literals(['required', 'skip-authorized']),
  /** Administrator-only recovery path for a deployment stranded on a node
   * that is already inside an authoritative rebuild/retire lifecycle. */
  forcedCleanup: Schema.optional(Schema.Literal(true)),
})
export type GameDeleteIntent = typeof GameDeleteIntent.Type

/** Moving is a distinct operation: the source is preserved behind a verified
 * backup until the target observation and endpoint cutover are committed. */
export const GameMoveIntent = Schema.Struct({
  action: Schema.Literal('move'),
  targetNodeId: Identifier,
  backupPolicy: Schema.Literal('required'),
})
export type GameMoveIntent = typeof GameMoveIntent.Type

export const GameMutationIntent = Schema.Union([
  GameStateIntent,
  GameUpdateIntent,
  GameConfigApplyIntent,
  GameModsSyncIntent,
  GameDeleteIntent,
  GameMoveIntent,
])
export type GameMutationIntent = typeof GameMutationIntent.Type

export const decodeGameCreateIntent = (input: unknown) =>
  Schema.decodeUnknownEffect(GameCreateIntent, { onExcessProperty: 'error' })(input)
export const decodeGameMutationIntent = (input: unknown) =>
  Schema.decodeUnknownEffect(GameMutationIntent, { onExcessProperty: 'error' })(input)

export interface GameNodeFact {
  readonly organizationId: string
  readonly nodeId: string
  readonly placementMode: 'shared' | 'dedicated'
  readonly provider: string
  readonly region: string
  readonly plan: string
  readonly architecture: 'amd64' | 'arm64'
  readonly ready: boolean
  /** Revision coordinates copied into the atomic create reservation fence. */
  readonly policyRevision: number
  readonly nodeDesiredRevision: number
  readonly capacityRevision: number
  readonly allocationRevision: number
  readonly catalogRefreshedAt: string
  readonly capacity: GameResourceRequest
  readonly reserved: GameResourceRequest
  readonly livePorts: readonly {
    protocol: 'tcp' | 'udp'
    publicPort: number
  }[]
  /** A dedicated node is selectable only when D1 has created this reservation. */
  readonly dedicatedReservationId?: string
  readonly portRange?: { readonly start: number; readonly end: number }
}

export interface PluginImageContract {
  readonly installer: string
  readonly runtime: string
}

/** Immutable, reviewed catalog materialized from the generated plugin registry and image catalog. */
export interface GamePluginCatalogEntry {
  readonly pluginId: string
  readonly activeVersion: string
  readonly selectionRevision: number
  readonly image: PluginImageContract
}

export interface GameDeploymentPlan {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly nodeId: string
  readonly placementMode: 'shared' | 'dedicated'
  readonly resources: GameResourceRequest
  readonly ports: readonly GamePortLeaseIntent[]
  readonly image: PluginImageContract
  readonly loginMode: 'anonymous' | 'credentialed'
  readonly steamCredentialRef?: string
  readonly domain?: string
  readonly config: Readonly<Record<string, unknown>>
  readonly mods: readonly DesiredMod[]
  readonly controlPlan: DeploymentPlan
  /** Exact revision receipt required by server_create_reservation_fence. */
  readonly policyRevision: number
  readonly pluginSelectionRevision: number
  readonly nodeDesiredRevision: number
  readonly capacityRevision: number
  readonly allocationRevision: number
  readonly catalogRefreshedAt: string
}

export class GameLifecycleValidationError extends Schema.TaggedError<GameLifecycleValidationError>()(
  'GameLifecycleValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class GamePluginUnavailableError extends Schema.TaggedError<GamePluginUnavailableError>()(
  'GamePluginUnavailableError',
  { pluginId: Schema.String, pluginVersion: Schema.String },
) {}
export class GamePlacementError extends Schema.TaggedError<GamePlacementError>()(
  'GamePlacementError',
  { code: Schema.String, message: Schema.String },
) {}

export type GamePlanError =
  | GameLifecycleValidationError
  | GamePluginUnavailableError
  | GamePlacementError

/** Canonical mutation binding. Secret values must never be part of this input. */
export const canonicalGameMutationPayload = (value: unknown): string => canonicalJson(value)

/** Worker-safe digest; callers must await this at an Effect/application boundary. */
export const canonicalGameMutationFingerprint = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalGameMutationPayload(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

const resource = (requested: GameResourceRequest | undefined, fallback: GameResourceRequest) =>
  requested ?? fallback

const enough = (available: number, reserved: number, requested: number): boolean =>
  requested > 0 && reserved + requested <= available

const selectNode = (
  organizationId: string,
  intent: GameCreateIntent,
  candidates: readonly GameNodeFact[],
): Effect.Effect<GameNodeFact, GamePlacementError> => {
  const filtered = candidates
    .filter((candidate) => candidate.organizationId === organizationId)
    .filter((candidate) => candidate.ready)
    .filter((candidate) => candidate.placementMode === intent.placement.mode)
    .filter(
      (candidate) =>
        intent.placement.mode !== 'dedicated' || candidate.dedicatedReservationId !== undefined,
    )
    .filter(
      (candidate) =>
        intent.placement.nodeId === undefined || candidate.nodeId === intent.placement.nodeId,
    )
  if (filtered.length === 0)
    return Effect.fail(
      new GamePlacementError({
        code: intent.placement.nodeId === undefined ? 'no-capacity' : 'node-unavailable',
        message: 'No ready organization-owned node satisfies the placement intent',
      }),
    )
  const ordered = [...filtered].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  const first = ordered.find((candidate) => {
    const requested = resource(intent.resources, {
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 20,
    })
    return (
      enough(candidate.capacity.cpu, candidate.reserved.cpu, requested.cpu) &&
      enough(candidate.capacity.memoryMiB, candidate.reserved.memoryMiB, requested.memoryMiB) &&
      enough(candidate.capacity.diskGiB, candidate.reserved.diskGiB, requested.diskGiB)
    )
  })
  return first === undefined
    ? Effect.fail(
        new GamePlacementError({
          code: 'insufficient-capacity',
          message: 'The selected placement has insufficient CPU, memory, or disk capacity',
        }),
      )
    : Effect.succeed(first)
}

const resolvePlugin = (
  pluginId: string,
  pluginVersion: string,
): Effect.Effect<ControlFacet, GamePluginUnavailableError> => {
  const key = `${pluginId}@${pluginVersion}`
  const bundle = pluginRegistry.get(key)
  if (bundle === undefined || !('control' in bundle))
    return Effect.fail(new GamePluginUnavailableError({ pluginId, pluginVersion }))
  return Effect.succeed(bundle.control as ControlFacet)
}

const validatePorts = (
  node: GameNodeFact,
  ports: readonly GamePortLeaseIntent[],
): Effect.Effect<readonly GamePortLeaseIntent[], GamePlacementError> => {
  const keys = new Set<string>()
  for (const port of ports) {
    const key = `${port.protocol}:${port.publicPort}`
    if (
      keys.has(key) ||
      node.livePorts.some((live) => `${live.protocol}:${live.publicPort}` === key)
    )
      return Effect.fail(
        new GamePlacementError({
          code: 'port-conflict',
          message: `Port ${key} is already leased`,
        }),
      )
    keys.add(key)
  }
  return Effect.succeed(ports)
}

const hostname = (value: string): boolean =>
  value.length <= 253 &&
  !value.endsWith('.') &&
  value
    .split('.')
    .every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )

const allocatePorts = (
  node: GameNodeFact,
  declarations: readonly {
    readonly protocol: 'tcp' | 'udp'
    readonly containerPort: number
    readonly name: string
  }[],
): Effect.Effect<readonly GamePortLeaseIntent[], GamePlacementError> => {
  const used = new Set(node.livePorts.map((port) => `${port.protocol}:${port.publicPort}`))
  const range = node.portRange ?? { start: 20_000, end: 60_000 }
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end > 65_535 ||
    range.start > range.end
  )
    return Effect.fail(
      new GamePlacementError({
        code: 'invalid-port-range',
        message: 'Node port allocator range is invalid',
      }),
    )
  const result: GamePortLeaseIntent[] = []
  for (const declaration of declarations) {
    let selected: number | undefined
    for (let port = range.start; port <= range.end; port += 1) {
      if (!used.has(`${declaration.protocol}:${port}`)) {
        selected = port
        break
      }
    }
    if (selected === undefined)
      return Effect.fail(
        new GamePlacementError({
          code: 'port-conflict',
          message: 'Node has no free port for the plugin declaration',
        }),
      )
    used.add(`${declaration.protocol}:${selected}`)
    result.push({
      protocol: declaration.protocol,
      containerPort: declaration.containerPort,
      publicPort: selected,
      purpose: declaration.name,
    })
  }
  return validatePorts(node, result)
}

/** Pure plan builder. The registry is the generated build-time registry; no runtime import is accepted. */
export const planGameServer = (
  organizationId: string,
  intent: GameCreateIntent,
  nodeCandidates: readonly GameNodeFact[],
  catalog: readonly GamePluginCatalogEntry[],
): Effect.Effect<GameDeploymentPlan, GamePlanError> =>
  Effect.gen(function* () {
    if (organizationId.length === 0)
      return yield* new GameLifecycleValidationError({
        code: 'organization-required',
        message: 'Organization is required',
      })
    const catalogEntry = catalog.find((entry) => entry.pluginId === intent.pluginId)
    if (catalogEntry === undefined)
      return yield* new GamePluginUnavailableError({
        pluginId: intent.pluginId,
        pluginVersion: 'active',
      })
    const plugin = yield* resolvePlugin(intent.pluginId, catalogEntry.activeVersion)
    const node = yield* selectNode(organizationId, intent, nodeCandidates)
    const config = yield* plugin.validateConfig(intent.config).pipe(
      Effect.mapError(
        (error) =>
          new GameLifecycleValidationError({
            code: 'invalid-config',
            message: error.message,
          }),
      ),
    )
    const desiredMods: readonly DesiredMod[] = intent.mods.map((mod) => ({
      source: mod.source,
      id: mod.id,
      loadOrder: mod.loadOrder,
      ...(mod.requestedVersion === undefined ? {} : { requestedVersion: mod.requestedVersion }),
    }))
    const normalized = yield* plugin.normalizeDesiredState(config, desiredMods).pipe(
      Effect.mapError(
        (error) =>
          new GameLifecycleValidationError({
            code: 'invalid-desired-state',
            message: error.message,
          }),
      ),
    )
    // Live metadata is a plugin-owned acceptance boundary. Preview callers
    // deliberately omit it and remain deterministic/offline; the generic core
    // does not know a game's upstream URL, response fields, or cache shape.
    const metadata =
      plugin.resolveModMetadata === undefined
        ? undefined
        : yield* plugin.resolveModMetadata(normalized.mods).pipe(
            Effect.mapError(
              (error) =>
                new GameLifecycleValidationError({
                  code: 'mod-metadata-resolution-failed',
                  message: error.message,
                }),
            ),
          )
    const deployment = yield* (
      metadata === undefined
        ? plugin.planDeployment(normalized.config, normalized.mods)
        : plugin.planDeployment(normalized.config, normalized.mods, {
            modMetadata: metadata,
          })
    ).pipe(
      Effect.mapError(
        (error) =>
          new GameLifecycleValidationError({
            code: 'deployment-plan-failed',
            message: error.message,
          }),
      ),
    )
    if (
      !/^sha256:[a-f0-9]{64}$/.test(catalogEntry.image.installer) ||
      !/^sha256:[a-f0-9]{64}$/.test(catalogEntry.image.runtime)
    )
      return yield* new GameLifecycleValidationError({
        code: 'invalid-image-catalog',
        message: 'Reviewed plugin images must be digest pinned',
      })
    if (intent.domain !== undefined && !hostname(intent.domain.toLowerCase()))
      return yield* new GameLifecycleValidationError({
        code: 'invalid-domain',
        message: 'Domain is not a canonical DNS hostname',
      })
    const ports = yield* allocatePorts(node, deployment.ports)
    if (intent.steamCredentialRef !== undefined && deployment.install.loginMode !== 'credentialed')
      return yield* new GameLifecycleValidationError({
        code: 'credential-not-needed',
        message: 'An anonymous plugin must not receive a Steam credential reference',
      })
    if (deployment.install.loginMode === 'credentialed' && intent.steamCredentialRef === undefined)
      return yield* new GameLifecycleValidationError({
        code: 'credential-required',
        message: 'Credentialed Steam installation requires a secret reference',
      })
    return {
      pluginId: intent.pluginId,
      pluginVersion: catalogEntry.activeVersion,
      nodeId: node.nodeId,
      placementMode: node.placementMode,
      resources: resource(intent.resources, deployment.resources),
      ports,
      image: catalogEntry.image,
      loginMode: deployment.install.loginMode,
      ...(intent.steamCredentialRef === undefined
        ? {}
        : { steamCredentialRef: intent.steamCredentialRef }),
      ...(intent.domain === undefined ? {} : { domain: intent.domain }),
      config: normalized.config as Readonly<Record<string, unknown>>,
      // The accepted plan carries the exact metadata-expanded dependency set.
      // Dependencies use their verified resolved version when the user did not
      // explicitly pin one, so the signed agent command cannot silently fetch
      // an unrelated latest dependency after the control-plane resolution.
      mods: deployment.mods.map((mod) => {
        const requestedVersion = mod.requestedVersion ?? mod.resolvedVersion
        return {
          source: mod.source,
          id: mod.id,
          loadOrder: mod.loadOrder,
          ...(requestedVersion === undefined ? {} : { requestedVersion }),
        }
      }),
      controlPlan: deployment,
      policyRevision: node.policyRevision,
      pluginSelectionRevision: catalogEntry.selectionRevision,
      nodeDesiredRevision: node.nodeDesiredRevision,
      capacityRevision: node.capacityRevision,
      allocationRevision: node.allocationRevision,
      catalogRefreshedAt: node.catalogRefreshedAt,
    }
  })

export interface GameLifecycleOperation {
  readonly organizationId: string
  readonly actorId: string
  readonly operationId: string
  readonly serverId: string
  readonly action:
    | 'create'
    | 'delete'
    | 'start'
    | 'stop'
    | 'restart'
    | 'update'
    | 'apply-config'
    | 'sync-mods'
    | 'move'
  readonly expectedRevision: number
  readonly fingerprint: string
  readonly state:
    | 'requested'
    | 'queued'
    | 'running'
    | 'waiting_external'
    | 'cancelling'
    | 'cancelled'
    | 'succeeded'
    | 'failed'
    | 'retrying'
    | 'failed_terminal'
}

export interface GameMutationAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly operation: GameLifecycleOperation
  readonly workflowState: 'started' | 'pending-reconciliation'
}

export interface GameLifecycleRepository {
  readonly findIdempotent: (
    organizationId: string,
    idempotencyKey: string,
    fingerprint: string,
  ) => Effect.Effect<GameMutationAcceptance | null, Error>
  readonly create: (input: {
    organizationId: string
    actorId: string
    /** Canonical request provenance captured at the HTTP/internal boundary. */
    auditRequestContext: AuditRequestContextValue
    auditActorType: AuditActorType
    idempotencyKey: string
    correlationId: string
    intent: GameCreateIntent
    plan: GameDeploymentPlan
  }) => Effect.Effect<GameMutationAcceptance, Error>
  readonly mutate: (input: {
    organizationId: string
    actorId: string
    /** Canonical request provenance captured at the HTTP/internal boundary. */
    auditRequestContext: AuditRequestContextValue
    auditActorType: AuditActorType
    idempotencyKey: string
    correlationId: string
    serverId: string
    expectedRevision: number
    intent: GameMutationIntent
    /** Internal policy scheduler proof; public HTTP mutation schemas omit it. */
    policyReconciliationActionId?: string
  }) => Effect.Effect<GameMutationAcceptance, Error>
}

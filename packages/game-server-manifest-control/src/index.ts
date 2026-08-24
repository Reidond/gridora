import { Effect, Schema } from 'effect'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import {
  DefaultGameBackupPolicy,
  DefaultGameUpdatePolicy,
  GameBackupPolicy,
  GameBackupPolicyInput,
  GameCreateIntent,
  type GameCreateIntent as GameCreateIntentType,
  type GameDeploymentPlan,
  GameUpdatePolicy,
  GameUpdatePolicyInput,
  normalizeGameBackupPolicy,
  normalizeGameUpdatePolicy,
} from '@gridora/game-lifecycle-control'
import {
  ServerResourceRequest,
  ServerApplyPlanSchema,
  ServerProvisionAcceptanceSchema,
  type ServerCreateIntent as ServerCreateIntentType,
} from '@gridora/server-plan-control'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
const Domain = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253))
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

export const GameServerManifestApiVersion = 'games.gridora.example/v1alpha1' as const

/**
 * A public manifest deliberately carries desired state only. It never carries
 * a provider selection, image, capacity observation, commercial review proof,
 * access token, secret material, or runtime receipt.
 */
export const GameServerManifestResources = ServerResourceRequest
export type GameServerManifestResources = typeof GameServerManifestResources.Type

export const GameServerManifestPlacement = Schema.Struct({
  mode: Schema.Literals(['auto', 'shared', 'dedicated']),
  nodeId: Schema.optional(Identifier),
})
export type GameServerManifestPlacement = typeof GameServerManifestPlacement.Type

const StoredPlacement = Schema.Struct({
  mode: Schema.Literals(['shared', 'dedicated']),
  nodeId: Identifier,
})

const EndpointInput = Schema.Struct({
  domain: Schema.optional(Domain),
  /** Accepted only for compatibility; exports write the canonical domain spelling. */
  hostname: Schema.optional(Domain),
})
const Endpoint = Schema.Struct({ domain: Schema.optional(Domain) })

export const GameServerManifestMetadata = Schema.Struct({
  name: Name,
  organization: Identifier,
  /** Immutable server identity emitted by export for an exact no-op fence. */
  serverId: Schema.optional(Identifier),
})
export type GameServerManifestMetadata = typeof GameServerManifestMetadata.Type

const Plugin = Schema.Struct({
  id: Identifier,
  version: Schema.String.check(Schema.isMinLength(1)),
})
const BillingInput = Schema.Struct({
  nonHourlyCommitmentConfirmed: Schema.Boolean,
  /** Opaque proof is valid only for the create plan/apply handoff; export omits it. */
  commercialReviewToken: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
})

const ManifestSpecInput = Schema.Struct({
  plugin: Plugin,
  placement: GameServerManifestPlacement,
  resources: GameServerManifestResources,
  billing: Schema.optional(BillingInput),
  endpoint: EndpointInput,
  updatePolicy: Schema.optional(GameUpdatePolicyInput),
  backupPolicy: Schema.optional(GameBackupPolicyInput),
  config: JsonObject,
  mods: GameCreateIntent.fields.mods,
  /** Tenant-authorized opaque reference only; never credential material. */
  steamCredentialRef: Schema.optional(Identifier),
})

export const GameServerManifestInput = Schema.Struct({
  apiVersion: Schema.Literal(GameServerManifestApiVersion),
  kind: Schema.Literal('GameServer'),
  metadata: GameServerManifestMetadata,
  spec: ManifestSpecInput,
})
export type GameServerManifestInput = typeof GameServerManifestInput.Type

export const GameServerManifestSpec = Schema.Struct({
  plugin: Plugin,
  placement: GameServerManifestPlacement,
  resources: GameServerManifestResources,
  /** Export never includes the one-time commercial proof. */
  billing: Schema.optional(Schema.Struct({ nonHourlyCommitmentConfirmed: Schema.Boolean })),
  endpoint: Endpoint,
  updatePolicy: GameUpdatePolicy,
  backupPolicy: GameBackupPolicy,
  config: JsonObject,
  mods: GameCreateIntent.fields.mods,
  steamCredentialRef: Schema.optional(Identifier),
})
export type GameServerManifestSpec = typeof GameServerManifestSpec.Type

export const GameServerManifest = Schema.Struct({
  apiVersion: Schema.Literal(GameServerManifestApiVersion),
  kind: Schema.Literal('GameServer'),
  metadata: GameServerManifestMetadata,
  spec: GameServerManifestSpec,
})
export type GameServerManifest = typeof GameServerManifest.Type

/** Internal persisted desired state. The concrete selected node is essential for exact no-op comparison. */
export const GameServerDesiredSpec = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  plugin: Plugin,
  placement: StoredPlacement,
  resources: GameServerManifestResources,
  endpoint: Endpoint,
  updatePolicy: GameUpdatePolicy,
  backupPolicy: GameBackupPolicy,
  config: JsonObject,
  mods: GameCreateIntent.fields.mods,
  steamCredentialRef: Schema.optional(Identifier),
})
export type GameServerDesiredSpec = typeof GameServerDesiredSpec.Type

export class GameServerManifestValidationError extends Schema.TaggedError<GameServerManifestValidationError>()(
  'GameServerManifestValidationError',
  { code: Schema.String, message: Schema.String },
) {}

const endpointFor = (
  input: typeof EndpointInput.Type,
): Effect.Effect<typeof Endpoint.Type, GameServerManifestValidationError> => {
  if (
    input.domain !== undefined &&
    input.hostname !== undefined &&
    input.domain.toLowerCase() !== input.hostname.toLowerCase()
  )
    return Effect.fail(
      new GameServerManifestValidationError({
        code: 'endpoint_conflict',
        message: 'endpoint.domain and endpoint.hostname must name the same endpoint',
      }),
    )
  const domain = input.domain ?? input.hostname
  const endpoint: typeof Endpoint.Type =
    domain === undefined ? {} : { domain: domain.toLowerCase() }
  return Effect.succeed(endpoint)
}

/** Decode legacy-compatible input once, then retain only normalized v1 desired state. */
export const normalizeGameServerManifest = (
  input: GameServerManifestInput,
): Effect.Effect<GameServerManifest, GameServerManifestValidationError> =>
  endpointFor(input.spec.endpoint).pipe(
    Effect.map((endpoint) => ({
      apiVersion: GameServerManifestApiVersion,
      kind: 'GameServer' as const,
      metadata: input.metadata,
      spec: {
        plugin: input.spec.plugin,
        placement: input.spec.placement,
        resources: input.spec.resources,
        ...(input.spec.billing === undefined
          ? {}
          : {
              billing: {
                nonHourlyCommitmentConfirmed: input.spec.billing.nonHourlyCommitmentConfirmed,
              },
            }),
        endpoint,
        updatePolicy: normalizeGameUpdatePolicy(input.spec.updatePolicy),
        backupPolicy: normalizeGameBackupPolicy(input.spec.backupPolicy),
        config: input.spec.config,
        mods: input.spec.mods,
        ...(input.spec.steamCredentialRef === undefined
          ? {}
          : { steamCredentialRef: input.spec.steamCredentialRef }),
      },
    })),
  )

export const decodeGameServerManifestInput = (input: unknown) =>
  Schema.decodeUnknownEffect(GameServerManifestInput, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new GameServerManifestValidationError({
          code: 'invalid_manifest',
          message: 'manifest does not match the GameServer v1alpha1 contract',
        }),
    ),
  )

export const decodeGameServerManifest = (input: unknown) =>
  decodeGameServerManifestInput(input).pipe(Effect.flatMap(normalizeGameServerManifest))

/**
 * The review proof is accepted only on a create apply handoff. Normalization
 * deliberately discards it so desired-state exports can never replay it.
 */
export const commercialReviewTokenFromManifestInput = (
  input: GameServerManifestInput,
): string | undefined => input.spec.billing?.commercialReviewToken

const exactInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} cannot be represented by the declarative manifest`)
  return value
}

/** Writes explicit policy defaults at acceptance, never at export time. */
export const desiredSpecFromAcceptedCreate = (input: {
  readonly intent: GameCreateIntentType
  readonly plan: GameDeploymentPlan
}): GameServerDesiredSpec => ({
  schemaVersion: 1,
  plugin: { id: input.plan.pluginId, version: input.plan.pluginVersion },
  placement: { mode: input.plan.placementMode, nodeId: input.plan.nodeId },
  resources: {
    cpuMillis: exactInteger(Math.round(input.plan.resources.cpu * 1_000), 'CPU'),
    ramBytes: exactInteger(Math.round(input.plan.resources.memoryMiB * 1024 * 1024), 'memory'),
    diskBytes: exactInteger(Math.round(input.plan.resources.diskGiB * 1024 * 1024 * 1024), 'disk'),
  },
  ...(input.plan.domain === undefined
    ? { endpoint: {} }
    : { endpoint: { domain: input.plan.domain } }),
  updatePolicy: normalizeGameUpdatePolicy(input.intent.updatePolicy),
  backupPolicy: normalizeGameBackupPolicy(input.intent.backupPolicy),
  config: input.plan.config,
  mods: input.plan.mods,
  ...(input.plan.steamCredentialRef === undefined
    ? {}
    : { steamCredentialRef: input.plan.steamCredentialRef }),
})

export const manifestFromDesiredSpec = (input: {
  readonly organization: string
  readonly serverId: string
  readonly name: string
  readonly spec: GameServerDesiredSpec
}): GameServerManifest => ({
  apiVersion: GameServerManifestApiVersion,
  kind: 'GameServer',
  metadata: { name: input.name, organization: input.organization, serverId: input.serverId },
  spec: {
    plugin: input.spec.plugin,
    placement: input.spec.placement,
    resources: input.spec.resources,
    endpoint: input.spec.endpoint,
    updatePolicy: input.spec.updatePolicy,
    backupPolicy: input.spec.backupPolicy,
    config: input.spec.config,
    mods: input.spec.mods,
    ...(input.spec.steamCredentialRef === undefined
      ? {}
      : { steamCredentialRef: input.spec.steamCredentialRef }),
  },
})

/** Exact scheduler input used only when a manifest creates a new server. */
export const manifestToServerCreateIntent = (
  manifest: GameServerManifest,
): ServerCreateIntentType => ({
  schemaVersion: 1,
  name: manifest.metadata.name,
  pluginId: manifest.spec.plugin.id,
  placementMode: manifest.spec.placement.mode,
  resources: manifest.spec.resources,
  nonHourlyCommitmentConfirmed: manifest.spec.billing?.nonHourlyCommitmentConfirmed ?? false,
})

/** Exact plugin input paired with the scheduler contract for a new server. */
export const manifestToGameCreateIntent = (manifest: GameServerManifest): GameCreateIntentType => {
  const placementMode =
    manifest.spec.placement.mode === 'auto' ? 'shared' : manifest.spec.placement.mode
  return {
    schemaVersion: 1,
    name: manifest.metadata.name,
    pluginId: manifest.spec.plugin.id,
    placement: {
      mode: placementMode,
      ...(manifest.spec.placement.mode === 'auto' || manifest.spec.placement.nodeId === undefined
        ? {}
        : { nodeId: manifest.spec.placement.nodeId }),
    },
    resources: {
      cpu: manifest.spec.resources.cpuMillis / 1_000,
      memoryMiB: manifest.spec.resources.ramBytes / (1024 * 1024),
      diskGiB: manifest.spec.resources.diskBytes / (1024 * 1024 * 1024),
    },
    config: manifest.spec.config,
    mods: manifest.spec.mods,
    ...(manifest.spec.endpoint.domain === undefined
      ? {}
      : { domain: manifest.spec.endpoint.domain }),
    ...(manifest.spec.steamCredentialRef === undefined
      ? {}
      : { steamCredentialRef: manifest.spec.steamCredentialRef }),
    updatePolicy: manifest.spec.updatePolicy,
    backupPolicy: manifest.spec.backupPolicy,
  }
}

export const manifestToServerApplyIntent = (
  manifest: GameServerManifest,
  commercialReviewToken?: string,
) => ({
  schemaVersion: 1 as const,
  server: manifestToServerCreateIntent(manifest),
  game: manifestToGameCreateIntent(manifest),
  ...(commercialReviewToken === undefined ? {} : { commercialReviewToken }),
})

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    )
  return value
}

export const canonicalGameServerManifest = (manifest: GameServerManifest): string =>
  JSON.stringify(canonical(manifest))
export const canonicalGameServerDesiredSpec = (spec: GameServerDesiredSpec): string =>
  JSON.stringify(canonical(spec))

export const GameServerManifestUnsupportedDelta = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
})
export type GameServerManifestUnsupportedDelta = typeof GameServerManifestUnsupportedDelta.Type

export const ExistingGameServerManifestPlan = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('no-op'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
  }),
  Schema.Struct({
    kind: Schema.Literal('apply-config'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
    expectedConfigRevision: PositiveRevision,
  }),
  Schema.Struct({
    kind: Schema.Literal('sync-mods'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
    expectedConfigRevision: PositiveRevision,
    expectedModRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal('move'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
    targetNodeId: Identifier,
  }),
  Schema.Struct({
    kind: Schema.Literal('update-policies'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
  }),
  Schema.Struct({
    kind: Schema.Literal('unsupported-plan'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
    unsupported: Schema.Array(GameServerManifestUnsupportedDelta).check(Schema.isMinLength(1)),
  }),
])
export type ExistingGameServerManifestPlan = typeof ExistingGameServerManifestPlan.Type

/** A create decision is the existing server-plan contract, wrapped to keep manifest planning unambiguous. */
export const GameServerManifestCreatePlan = Schema.Struct({
  kind: Schema.Literal('create'),
  plan: ServerApplyPlanSchema,
})
export const GameServerManifestPlanResponse = Schema.Union([
  GameServerManifestCreatePlan,
  ExistingGameServerManifestPlan,
])
export type GameServerManifestPlanResponse = typeof GameServerManifestPlanResponse.Type

const GameLifecycleManifestAcceptance = Schema.Struct({
  operationId: Identifier,
  serverId: Identifier,
  state: Schema.Literals([
    'requested',
    'queued',
    'running',
    'waiting_external',
    'cancelling',
    'cancelled',
    'succeeded',
    'failed',
    'retrying',
    'failed_terminal',
  ]),
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
})
const GameServerManifestPolicyAcceptance = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  operationId: Identifier,
  serverId: Identifier,
  expectedRevision: PositiveRevision,
  desiredRevision: PositiveRevision,
  state: Schema.Literal('succeeded'),
})
export const GameServerManifestApplyResponse = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('no-op'),
    serverId: Identifier,
    desiredRevision: PositiveRevision,
    workflowState: Schema.Literal('not-required'),
  }),
  Schema.Struct({
    kind: Schema.Literal('lifecycle'),
    acceptance: GameLifecycleManifestAcceptance,
  }),
  Schema.Struct({
    kind: Schema.Literal('policy-update'),
    acceptance: GameServerManifestPolicyAcceptance,
    workflowState: Schema.Literal('not-required'),
  }),
  Schema.Struct({
    kind: Schema.Literal('server-provision'),
    acceptance: ServerProvisionAcceptanceSchema,
  }),
])
export type GameServerManifestApplyResponse = typeof GameServerManifestApplyResponse.Type

export const GameServerDraft = Schema.Struct({
  id: Identifier,
  organizationId: Identifier,
  actorId: Identifier,
  manifest: GameServerManifest,
  sourceServerId: Schema.optional(Identifier),
  state: Schema.Literals(['draft', 'scheduled', 'materialized', 'cancelled']),
  revision: PositiveRevision,
  operationId: Identifier,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type GameServerDraft = typeof GameServerDraft.Type

export const GameServerDraftSchedule = Schema.Struct({
  id: Identifier,
  organizationId: Identifier,
  draftId: Identifier,
  scheduledFor: Schema.String,
  state: Schema.Literals([
    'scheduled',
    'dispatching',
    'retrying',
    'accepted',
    'failed',
    'cancelled',
  ]),
  revision: PositiveRevision,
  operationId: Identifier,
  targetOperationId: Schema.optional(Identifier),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type GameServerDraftSchedule = typeof GameServerDraftSchedule.Type

export const GameServerManifestValidationResponse = Schema.Struct({
  valid: Schema.Literal(true),
  manifest: GameServerManifest,
})

export const GameServerDraftCreateResponse = Schema.Struct({ draft: GameServerDraft })
export const GameServerDraftScheduleResponse = Schema.Struct({ schedule: GameServerDraftSchedule })
export const GameServerDraftScheduleInput = Schema.Struct({
  expectedRevision: PositiveRevision,
  scheduledFor: Schema.String,
})
export const GameServerCloneInput = Schema.Struct({
  name: Name,
  placement: Schema.optional(GameServerManifestPlacement),
  domain: Schema.optional(Domain),
})
export const GameServerCloneResponse = Schema.Struct({
  sourceServerId: Identifier,
  cloneDraftId: Identifier,
  acceptance: ServerProvisionAcceptanceSchema,
})

export interface GameServerDraftCreateCommand {
  readonly organizationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly auditRequestContext: AuditRequestContextValue
  readonly idempotencyKey: string
  readonly manifest: GameServerManifest
  readonly sourceServerId?: string
}

export interface GameServerDraftScheduleCommand {
  readonly organizationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly auditRequestContext: AuditRequestContextValue
  readonly idempotencyKey: string
  readonly draftId: string
  readonly expectedRevision: number
  readonly scheduledFor: string
}

export interface GameServerDraftRepository {
  readonly create: (
    command: GameServerDraftCreateCommand,
  ) => Effect.Effect<GameServerDraft, GameServerManifestRepositoryError>
  readonly read: (
    organizationId: string,
    draftId: string,
  ) => Effect.Effect<GameServerDraft, GameServerManifestRepositoryError>
  readonly schedule: (
    command: GameServerDraftScheduleCommand,
  ) => Effect.Effect<GameServerDraftSchedule, GameServerManifestRepositoryError>
}

export interface ExistingGameServerManifestState {
  readonly serverId: string
  readonly name: string
  readonly desiredRevision: number
  readonly configRevision: number
  readonly modRevision: number
  readonly spec: GameServerDesiredSpec
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

/**
 * Classifies existing-server changes without ever falling through to a create.
 * Only one durable lifecycle mutation is allowed per manifest apply. Combined
 * deltas are rejected before an operation, provider, or runtime side effect.
 */
export const planExistingGameServerManifest = (
  current: ExistingGameServerManifestState,
  requested: GameServerManifest,
): ExistingGameServerManifestPlan => {
  const unsupported: GameServerManifestUnsupportedDelta[] = []
  if (requested.metadata.name !== current.name)
    unsupported.push({
      path: 'metadata.name',
      reason: 'renaming an existing server is not implemented',
    })
  if (!same(requested.spec.plugin, current.spec.plugin))
    unsupported.push({
      path: 'spec.plugin',
      reason: 'plugin changes require a dedicated upgrade workflow',
    })
  if (!same(requested.spec.resources, current.spec.resources))
    unsupported.push({
      path: 'spec.resources',
      reason: 'resource changes require a dedicated resize workflow',
    })
  if (!same(requested.spec.endpoint, current.spec.endpoint))
    unsupported.push({
      path: 'spec.endpoint',
      reason: 'endpoint changes require a dedicated DNS workflow',
    })
  if (requested.spec.steamCredentialRef !== current.spec.steamCredentialRef)
    unsupported.push({
      path: 'spec.steamCredentialRef',
      reason: 'credential-reference changes require a dedicated credential lifecycle workflow',
    })

  const configChanged = !same(requested.spec.config, current.spec.config)
  const modsChanged = !same(requested.spec.mods, current.spec.mods)
  const policiesChanged =
    !same(requested.spec.updatePolicy, current.spec.updatePolicy) ||
    !same(requested.spec.backupPolicy, current.spec.backupPolicy)
  const placementChanged = !same(requested.spec.placement, current.spec.placement)
  const changeCount = [configChanged, modsChanged, policiesChanged, placementChanged].filter(
    Boolean,
  ).length

  if (unsupported.length > 0 || changeCount > 1)
    return {
      kind: 'unsupported-plan',
      serverId: current.serverId,
      desiredRevision: current.desiredRevision,
      unsupported: [
        ...unsupported,
        ...(changeCount <= 1
          ? []
          : [
              {
                path: 'spec',
                reason: 'one manifest apply cannot safely compose multiple lifecycle mutations',
              },
            ]),
      ],
    }
  if (!configChanged && !modsChanged && !policiesChanged && !placementChanged)
    return { kind: 'no-op', serverId: current.serverId, desiredRevision: current.desiredRevision }
  if (configChanged)
    return {
      kind: 'apply-config',
      serverId: current.serverId,
      desiredRevision: current.desiredRevision,
      expectedConfigRevision: current.configRevision,
    }
  if (modsChanged)
    return {
      kind: 'sync-mods',
      serverId: current.serverId,
      desiredRevision: current.desiredRevision,
      expectedConfigRevision: current.configRevision,
      expectedModRevision: current.modRevision,
    }
  if (policiesChanged)
    return {
      kind: 'update-policies',
      serverId: current.serverId,
      desiredRevision: current.desiredRevision,
    }
  const targetNodeId = requested.spec.placement.nodeId
  if (targetNodeId === undefined || requested.spec.placement.mode === 'auto')
    return {
      kind: 'unsupported-plan',
      serverId: current.serverId,
      desiredRevision: current.desiredRevision,
      unsupported: [
        {
          path: 'spec.placement',
          reason: 'an existing-server move requires one explicit organization-owned target node',
        },
      ],
    }
  return {
    kind: 'move',
    serverId: current.serverId,
    desiredRevision: current.desiredRevision,
    targetNodeId,
  }
}

/** Explicit defaults are exported from the control contract for documentation and tests. */
export const defaultGameServerManifestPolicies = {
  updatePolicy: DefaultGameUpdatePolicy,
  backupPolicy: DefaultGameBackupPolicy,
} as const

/** Read/acceptance failures retain stable typed codes at the API boundary. */
export class GameServerManifestNotFoundError extends Schema.TaggedError<GameServerManifestNotFoundError>()(
  'GameServerManifestNotFoundError',
  { server: Schema.String },
) {}
export class GameServerManifestIdempotencyConflictError extends Schema.TaggedError<GameServerManifestIdempotencyConflictError>()(
  'GameServerManifestIdempotencyConflictError',
  { idempotencyKey: Schema.String },
) {}
export class GameServerManifestRevisionConflictError extends Schema.TaggedError<GameServerManifestRevisionConflictError>()(
  'GameServerManifestRevisionConflictError',
  { serverId: Schema.String, expectedRevision: PositiveRevision },
) {}
export class GameServerManifestPersistenceError extends Schema.TaggedError<GameServerManifestPersistenceError>()(
  'GameServerManifestPersistenceError',
  { operation: Schema.String, message: Schema.String },
) {}

export interface GameServerManifestStoredState extends ExistingGameServerManifestState {
  readonly organizationId: string
  readonly sourceOperationId: string
}

export interface GameServerManifestPolicyUpdateCommand {
  readonly organizationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly auditRequestContext: AuditRequestContextValue
  readonly idempotencyKey: string
  readonly serverId: string
  readonly expectedRevision: number
  readonly updatePolicy: GameUpdatePolicy
  readonly backupPolicy: GameBackupPolicy
}

export interface GameServerManifestPolicyUpdateAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly operationId: string
  readonly serverId: string
  readonly expectedRevision: number
  readonly desiredRevision: number
  readonly state: 'succeeded'
}

export type GameServerManifestRepositoryError =
  | GameServerManifestNotFoundError
  | GameServerManifestIdempotencyConflictError
  | GameServerManifestRevisionConflictError
  | GameServerManifestPersistenceError

/**
 * Authoritative projection and policy-only acceptance boundary. The D1
 * implementation is deliberately separate from game lifecycle execution:
 * policy changes control future work and must not claim a runtime effect.
 */
export interface GameServerManifestRepository {
  readonly readById: (
    organizationId: string,
    serverId: string,
  ) => Effect.Effect<GameServerManifestStoredState, GameServerManifestRepositoryError>
  readonly readByName: (
    organizationId: string,
    name: string,
  ) => Effect.Effect<GameServerManifestStoredState | null, GameServerManifestPersistenceError>
  readonly acceptPolicyUpdate: (
    command: GameServerManifestPolicyUpdateCommand,
  ) => Effect.Effect<GameServerManifestPolicyUpdateAcceptance, GameServerManifestRepositoryError>
}

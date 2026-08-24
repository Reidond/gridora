import { Context, Effect, Layer, Schema } from 'effect'
import {
  evaluatePolicyAdmission,
  type OrganizationPolicyV1,
  type OrganizationUsage,
  type PolicyWarning,
} from '@gridora/policy-control'
import {
  ServerCreateIntent as ServerCreateIntentSchema,
  ServerResourceRequest as ServerResourceRequestSchema,
  type ServerCreateIntent as ServerCreateIntentType,
  type ServerResourceRequest as ServerResourceRequestType,
} from './server-intent.js'

export { ServerCreateIntent, ServerResourceRequest } from './server-intent.js'
export { ServerPlanDecisionSchema } from './server-plan-decision.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
export const decodeServerCreateIntent = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerCreateIntentSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new ServerPlanValidationError({
          code: 'invalid_server_create_intent',
          message: 'Server create intent does not match schema version 1',
        }),
    ),
  )

export interface ServerPlanContext {
  readonly organizationId: string
  readonly actorId: string
  readonly actorRole: 'owner' | 'administrator' | 'operator' | 'viewer'
  readonly correlationId: string
  /**
   * The edge authorization fence for mutations. It is deliberately not part
   * of a request fingerprint: an otherwise identical retry must remain
   * adoptable, while the durable acceptance still rechecks this revision.
   */
  readonly actorMembershipRevision?: number
}
export interface ServerPlanRequest {
  readonly context: ServerPlanContext
  readonly intent: ServerCreateIntentType
}
export interface ServerCreateCommand extends ServerPlanRequest {
  readonly idempotencyKey: string
}

export type Architecture = 'amd64' | 'arm64'
export interface PluginPortContract {
  readonly name: string
  readonly protocol: 'tcp' | 'udp'
  readonly containerPort: number
  readonly preferredPublicPort: number | null
}
export const PluginPlanContractSchema = Schema.Struct({
  architecture: Schema.Literals(['amd64', 'arm64']),
  sharedNodeAllowed: Schema.Boolean,
  minimum: ServerResourceRequestSchema,
  maximum: ServerResourceRequestSchema,
  ports: Schema.Array(
    Schema.Struct({
      name: Identifier,
      protocol: Schema.Literals(['tcp', 'udp']),
      containerPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      preferredPublicPort: Schema.NullOr(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      ),
    }),
  ),
})
export interface PluginPlanContract {
  readonly architecture: Architecture
  readonly sharedNodeAllowed: boolean
  readonly minimum: ServerResourceRequestType
  readonly maximum: ServerResourceRequestType
  readonly ports: readonly PluginPortContract[]
}
export interface AuthoritativePluginSelection {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly selectionRevision: number
  readonly contract: PluginPlanContract
}
export interface ExistingPortLease {
  readonly protocol: 'tcp' | 'udp'
  readonly publicPort: number
}
export interface ServerNodeCandidate {
  readonly nodeId: string
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly region: string
  readonly plan: string
  readonly placementMode: 'shared' | 'dedicated'
  readonly desiredRevision: number
  readonly capacityRevision: number
  readonly allocationRevision: number
  readonly catalogRefreshedAt: string
  readonly capacityReportedAt: string
  readonly architecture: Architecture
  readonly healthy: boolean
  readonly capacity: ServerResourceRequestType
  readonly reserved: ServerResourceRequestType
  readonly serverCount: number
  readonly reservationCount: number
  readonly ports: readonly ExistingPortLease[]
}
export interface ServerPlanFacts {
  readonly organizationId: string
  readonly policy: OrganizationPolicyV1
  readonly usage: OrganizationUsage
  readonly plugin: AuthoritativePluginSelection
  readonly nodes: readonly ServerNodeCandidate[]
}
export interface PlannedPortLease extends PluginPortContract {
  readonly publicPort: number
}
export interface ServerPlanCandidateExplanation {
  readonly nodeId: string
  readonly accepted: boolean
  readonly reasons: readonly string[]
  readonly score: number
}
export interface ServerPlanDecision {
  readonly kind: 'existing-node'
  readonly pluginId: string
  readonly pluginVersion: string
  readonly placementMode: 'shared' | 'dedicated'
  readonly nodeId: string
  readonly resources: ServerResourceRequestType
  readonly ports: readonly PlannedPortLease[]
  readonly newPaidInfrastructure: false
  readonly estimatedMonthlyIncreaseMinor: 0
  readonly explanation: string
  readonly warnings: readonly PolicyWarning[]
  readonly candidates: readonly ServerPlanCandidateExplanation[]
}
export interface ServerPlanFences {
  readonly policyRevision: number
  readonly pluginSelectionRevision: number
  readonly nodeDesiredRevision: number
  readonly capacityRevision: number
  readonly allocationRevision: number
  readonly catalogRefreshedAt: string
}
export interface PreparedServerCreate {
  readonly decision: ServerPlanDecision
  readonly fences: ServerPlanFences
}
export interface ServerCreateIdentity {
  readonly serverId: string
  readonly deploymentId: string
  readonly operationId: string
  readonly reservationId: string
  readonly capacityReservationId: string
  readonly workflowStartRecordId: string
  readonly auditEventId: string
  readonly outboxEventId: string
  readonly portLeaseIds: readonly string[]
}
export interface ServerCreateAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly organizationId: string
  readonly serverId: string
  readonly deploymentId: string
  readonly operationId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly state: 'queued'
  readonly plan: ServerPlanDecision
}
export interface ServerCreateAtomicInput {
  readonly command: ServerCreateCommand
  readonly fingerprint: string
  readonly identity: ServerCreateIdentity
  readonly prepared: PreparedServerCreate
  readonly now: string
}

export class ServerPlanValidationError extends Schema.TaggedError<ServerPlanValidationError>()(
  'ServerPlanValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class ServerPlanAuthorizationError extends Schema.TaggedError<ServerPlanAuthorizationError>()(
  'ServerPlanAuthorizationError',
  { code: Schema.Literal('operator_required') },
) {}
export class ServerPlanFactsUnavailableError extends Schema.TaggedError<ServerPlanFactsUnavailableError>()(
  'ServerPlanFactsUnavailableError',
  { operation: Schema.String, message: Schema.String },
) {}
export class ServerPlacementRejectedError extends Schema.TaggedError<ServerPlacementRejectedError>()(
  'ServerPlacementRejectedError',
  { code: Schema.String, message: Schema.String, reasons: Schema.Array(Schema.String) },
) {}
export class ServerPlanIdempotencyConflictError extends Schema.TaggedError<ServerPlanIdempotencyConflictError>()(
  'ServerPlanIdempotencyConflictError',
  { idempotencyKey: Schema.String },
) {}
export class ServerPlanConcurrencyError extends Schema.TaggedError<ServerPlanConcurrencyError>()(
  'ServerPlanConcurrencyError',
  { code: Schema.String },
) {}
export class ServerPlanPersistenceError extends Schema.TaggedError<ServerPlanPersistenceError>()(
  'ServerPlanPersistenceError',
  { operation: Schema.String, message: Schema.String },
) {}

export type ServerPlanError =
  | ServerPlanValidationError
  | ServerPlanAuthorizationError
  | ServerPlanFactsUnavailableError
  | ServerPlacementRejectedError
  | ServerPlanPersistenceError
export type ServerCreateError =
  | ServerPlanError
  | ServerPlanIdempotencyConflictError
  | ServerPlanConcurrencyError
  | ServerPlanPersistenceError

export interface ServerPlanRepositoryShape {
  readonly findReplay: (
    organizationId: string,
    idempotencyKey: string,
    fingerprint: string,
  ) => Effect.Effect<
    ServerCreateAcceptance | null,
    ServerPlanIdempotencyConflictError | ServerPlanPersistenceError
  >
  /** All policy, plugin, node, allocation, catalog, health, capacity, port, and budget facts are read here. */
  readonly readFacts: (
    organizationId: string,
    pluginId: string,
  ) => Effect.Effect<ServerPlanFacts, ServerPlanFactsUnavailableError | ServerPlanPersistenceError>
  readonly acceptAtomic: (
    input: ServerCreateAtomicInput,
  ) => Effect.Effect<
    ServerCreateAcceptance,
    ServerPlanIdempotencyConflictError | ServerPlanConcurrencyError | ServerPlanPersistenceError
  >
}
export class ServerPlanRepository extends Context.Service<
  ServerPlanRepository,
  ServerPlanRepositoryShape
>()('@gridora/server-plan-control/ServerPlanRepository') {}
export const ServerPlanRepositoryLayer = (repository: ServerPlanRepositoryShape) =>
  Layer.succeed(ServerPlanRepository, repository)

export interface ServerPlanClockShape {
  readonly now: Effect.Effect<{ readonly iso: string; readonly epochMilliseconds: number }>
}
export class ServerPlanClock extends Context.Service<ServerPlanClock, ServerPlanClockShape>()(
  '@gridora/server-plan-control/ServerPlanClock',
) {}
export const ServerPlanClockLayer = (clock: ServerPlanClockShape) =>
  Layer.succeed(ServerPlanClock, clock)

export interface ServerCreateIdentityPortShape {
  readonly fingerprint: (
    command: ServerCreateCommand,
  ) => Effect.Effect<string, ServerPlanValidationError>
  readonly derive: (
    command: ServerCreateCommand,
    fingerprint: string,
    portCount: number,
  ) => Effect.Effect<ServerCreateIdentity, ServerPlanValidationError>
}
export class ServerCreateIdentityPort extends Context.Service<
  ServerCreateIdentityPort,
  ServerCreateIdentityPortShape
>()('@gridora/server-plan-control/ServerCreateIdentityPort') {}
export const ServerCreateIdentityPortLayer = (identity: ServerCreateIdentityPortShape) =>
  Layer.succeed(ServerCreateIdentityPort, identity)

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
export const canonicalServerCreateCommand = (command: ServerCreateCommand): string =>
  JSON.stringify(
    canonical({
      organizationId: command.context.organizationId,
      actorId: command.context.actorId,
      intent: command.intent,
    }),
  )
const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const digest = (value: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', buffer(new TextEncoder().encode(value))),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () =>
      new ServerPlanValidationError({
        code: 'identity_derivation_failed',
        message: 'Server create identity could not be derived',
      }),
  })
export const makeWebCryptoServerCreateIdentity = (): ServerCreateIdentityPortShape => ({
  fingerprint: (command) => digest(canonicalServerCreateCommand(command)),
  derive: (command, fingerprint, portCount) =>
    Effect.map(
      digest(
        `gridora:server-create:v1:${command.context.organizationId}:${command.context.actorId}:${command.idempotencyKey}:${fingerprint}`,
      ),
      (scope): ServerCreateIdentity => {
        const prefix = scope.slice(0, 24)
        return {
          serverId: `server_${prefix}`,
          deploymentId: `deployment_${prefix}`,
          operationId: `op_${prefix}`,
          reservationId: `server-reservation_${prefix}`,
          capacityReservationId: `capacity-reservation_${prefix}`,
          workflowStartRecordId: `workflow-start:op_${prefix}`,
          auditEventId: `audit_server_${prefix}`,
          outboxEventId: `outbox_server_${prefix}`,
          portLeaseIds: Array.from(
            { length: portCount },
            (_, index) => `port_${prefix}_${index + 1}`,
          ),
        }
      },
    ),
})

const safeAdd = (left: number, right: number): number | undefined => {
  const value = left + right
  return Number.isSafeInteger(value) ? value : undefined
}
const within = (request: ServerResourceRequestType, limit: ServerResourceRequestType): boolean =>
  request.cpuMillis <= limit.cpuMillis &&
  request.ramBytes <= limit.ramBytes &&
  request.diskBytes <= limit.diskBytes
const atLeast = (request: ServerResourceRequestType, minimum: ServerResourceRequestType): boolean =>
  request.cpuMillis >= minimum.cpuMillis &&
  request.ramBytes >= minimum.ramBytes &&
  request.diskBytes >= minimum.diskBytes

const allocatePorts = (
  contract: readonly PluginPortContract[],
  usedPorts: readonly ExistingPortLease[],
): readonly PlannedPortLease[] | undefined => {
  const used = new Set(usedPorts.map((port) => `${port.protocol}:${port.publicPort}`))
  const output: PlannedPortLease[] = []
  for (const requested of contract) {
    let selected = requested.preferredPublicPort ?? 20_000
    if (requested.preferredPublicPort === null) {
      while (selected <= 65_535 && used.has(`${requested.protocol}:${selected}`)) selected += 1
    }
    if (selected > 65_535 || used.has(`${requested.protocol}:${selected}`)) return undefined
    used.add(`${requested.protocol}:${selected}`)
    output.push({ ...requested, publicPort: selected })
  }
  return output
}

export const evaluateServerPlan = (
  request: ServerPlanRequest,
  facts: ServerPlanFacts,
  nowEpochMilliseconds: number,
): Effect.Effect<PreparedServerCreate, ServerPlacementRejectedError> => {
  if (facts.organizationId !== request.context.organizationId)
    return Effect.fail(
      new ServerPlacementRejectedError({
        code: 'tenant_fact_mismatch',
        message: 'Authoritative planning facts do not belong to this organization',
        reasons: [],
      }),
    )
  if (facts.plugin.pluginId !== request.intent.pluginId)
    return Effect.fail(
      new ServerPlacementRejectedError({
        code: 'plugin_fact_mismatch',
        message: 'Authoritative plugin selection does not match the requested plugin',
        reasons: [],
      }),
    )
  if (!atLeast(request.intent.resources, facts.plugin.contract.minimum))
    return Effect.fail(
      new ServerPlacementRejectedError({
        code: 'plugin_resource_minimum',
        message: 'Requested resources are below the active plugin minimum',
        reasons: [],
      }),
    )
  if (!within(request.intent.resources, facts.plugin.contract.maximum))
    return Effect.fail(
      new ServerPlacementRejectedError({
        code: 'plugin_resource_maximum',
        message: 'Requested resources exceed the active plugin maximum',
        reasons: [],
      }),
    )

  const evaluated = facts.nodes.map((node) => {
    const reasons: string[] = []
    if (!node.healthy) reasons.push('node is not fully ready')
    const capacityAge = nowEpochMilliseconds - Date.parse(node.capacityReportedAt)
    if (!Number.isFinite(capacityAge) || capacityAge < -60_000 || capacityAge > 300_000)
      reasons.push('node capacity or health report is stale')
    const catalogAge = nowEpochMilliseconds - Date.parse(node.catalogRefreshedAt)
    if (!Number.isFinite(catalogAge) || catalogAge < -60_000 || catalogAge > 86_400_000)
      reasons.push('provider catalog facts are stale')
    if (node.architecture !== facts.plugin.contract.architecture)
      reasons.push('architecture mismatch')
    if (node.serverCount !== node.reservationCount)
      reasons.push('unaccounted legacy deployment capacity')
    if (request.intent.placementMode === 'shared' && node.placementMode !== 'shared')
      reasons.push('shared placement required')
    if (request.intent.placementMode === 'dedicated' && node.placementMode !== 'dedicated')
      reasons.push('dedicated placement required')
    if (node.placementMode === 'shared' && !facts.plugin.contract.sharedNodeAllowed)
      reasons.push('plugin forbids shared placement')
    if (node.placementMode === 'dedicated' && node.serverCount !== 0)
      reasons.push('dedicated node is not empty')
    const cpu = safeAdd(node.reserved.cpuMillis, request.intent.resources.cpuMillis)
    const ram = safeAdd(node.reserved.ramBytes, request.intent.resources.ramBytes)
    const disk = safeAdd(node.reserved.diskBytes, request.intent.resources.diskBytes)
    if (cpu === undefined || cpu > node.capacity.cpuMillis) reasons.push('insufficient cpu')
    if (ram === undefined || ram > node.capacity.ramBytes) reasons.push('insufficient memory')
    if (disk === undefined || disk > node.capacity.diskBytes) reasons.push('insufficient disk')
    const ports = allocatePorts(facts.plugin.contract.ports, node.ports)
    if (ports === undefined) reasons.push('required port unavailable')
    const headroom =
      (node.capacity.cpuMillis - node.reserved.cpuMillis - request.intent.resources.cpuMillis) /
        node.capacity.cpuMillis +
      (node.capacity.ramBytes - node.reserved.ramBytes - request.intent.resources.ramBytes) /
        node.capacity.ramBytes +
      (node.capacity.diskBytes - node.reserved.diskBytes - request.intent.resources.diskBytes) /
        node.capacity.diskBytes
    return {
      node,
      ports,
      explanation: {
        nodeId: node.nodeId,
        accepted: reasons.length === 0,
        reasons,
        score: reasons.length === 0 ? headroom : -1,
      } satisfies ServerPlanCandidateExplanation,
    }
  })
  evaluated.sort(
    (left, right) =>
      right.explanation.score - left.explanation.score ||
      left.node.nodeId.localeCompare(right.node.nodeId),
  )
  const winner = evaluated.find((candidate) => candidate.explanation.accepted)
  if (winner === undefined || winner.ports === undefined)
    return Effect.fail(
      new ServerPlacementRejectedError({
        code: 'no_existing_node_fit',
        message:
          'No existing ready node can safely accept this server; node provisioning is required',
        reasons: evaluated.flatMap((item) =>
          item.explanation.reasons.map((reason) => `${item.node.nodeId}: ${reason}`),
        ),
      }),
    )

  const policyDecision = evaluatePolicyAdmission({
    policy: facts.policy,
    request: {
      organizationId: request.context.organizationId,
      action: 'deploy-server',
      provider: winner.node.providerType,
      region: winner.node.region,
      plan: winner.node.plan,
      dedicatedNode: winner.node.placementMode === 'dedicated',
      targetNodeId: winner.node.nodeId,
      resources: request.intent.resources,
      temporaryNodeLifetimeHours: null,
      destructiveBackup: 'not-applicable',
      nonHourlyCommitmentConfirmed: request.intent.nonHourlyCommitmentConfirmed,
      updateContext: { mode: 'not-applicable', category: 'not-applicable' },
    },
    usage: facts.usage,
    price: { status: 'unknown' },
    nowEpochMilliseconds,
  })
  if (policyDecision.outcome === 'deny')
    return Effect.fail(
      new ServerPlacementRejectedError({
        code: policyDecision.violations[0]?.code ?? 'policy_denied',
        message: policyDecision.violations[0]?.message ?? 'Organization policy denied placement',
        reasons: policyDecision.violations.map((violation) => violation.message),
      }),
    )
  const placementMode = winner.node.placementMode
  return Effect.succeed({
    decision: {
      kind: 'existing-node',
      pluginId: facts.plugin.pluginId,
      pluginVersion: facts.plugin.pluginVersion,
      placementMode,
      nodeId: winner.node.nodeId,
      resources: request.intent.resources,
      ports: winner.ports,
      newPaidInfrastructure: false,
      estimatedMonthlyIncreaseMinor: 0,
      explanation: `Selected ready ${placementMode} node ${winner.node.nodeId}; no paid infrastructure will be created by this reservation`,
      warnings: policyDecision.warnings,
      candidates: evaluated.map((candidate) => candidate.explanation),
    },
    fences: {
      policyRevision: facts.policy.revision,
      pluginSelectionRevision: facts.plugin.selectionRevision,
      nodeDesiredRevision: winner.node.desiredRevision,
      capacityRevision: winner.node.capacityRevision,
      allocationRevision: winner.node.allocationRevision,
      catalogRefreshedAt: winner.node.catalogRefreshedAt,
    },
  })
}

const authorize = (context: ServerPlanContext) =>
  context.actorRole === 'viewer'
    ? Effect.fail(new ServerPlanAuthorizationError({ code: 'operator_required' }))
    : Effect.void

const ContextContract = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  actorRole: Schema.Literals(['owner', 'administrator', 'operator', 'viewer']),
  correlationId: Identifier,
})
const PlanRequestContract = Schema.Struct({
  context: ContextContract,
  intent: ServerCreateIntentSchema,
})
const CreateCommandContract = Schema.Struct({
  context: ContextContract,
  intent: ServerCreateIntentSchema,
  idempotencyKey: IdempotencyKey,
})
const decodePlanRequest = (value: ServerPlanRequest) =>
  Schema.decodeUnknownEffect(PlanRequestContract, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError(
      () =>
        new ServerPlanValidationError({
          code: 'invalid_plan_request',
          message: 'Plan request is invalid',
        }),
    ),
  )
const decodeCreateCommand = (value: ServerCreateCommand) =>
  Schema.decodeUnknownEffect(CreateCommandContract, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError(
      () =>
        new ServerPlanValidationError({
          code: 'invalid_create_command',
          message: 'Create command is invalid',
        }),
    ),
  )

export interface ServerPlanControlShape {
  readonly plan: (request: ServerPlanRequest) => Effect.Effect<ServerPlanDecision, ServerPlanError>
  readonly create: (
    command: ServerCreateCommand,
  ) => Effect.Effect<ServerCreateAcceptance, ServerCreateError>
}
export class ServerPlanControl extends Context.Service<ServerPlanControl, ServerPlanControlShape>()(
  '@gridora/server-plan-control/ServerPlanControl',
) {}

export const makeServerPlanControl = Effect.gen(function* () {
  const repository = yield* ServerPlanRepository
  const clock = yield* ServerPlanClock
  const identity = yield* ServerCreateIdentityPort
  const prepare = (request: ServerPlanRequest) =>
    Effect.gen(function* () {
      const decoded = yield* decodePlanRequest(request)
      yield* authorize(decoded.context)
      const facts = yield* repository.readFacts(
        decoded.context.organizationId,
        decoded.intent.pluginId,
      )
      const time = yield* clock.now
      return yield* evaluateServerPlan(decoded, facts, time.epochMilliseconds)
    })
  return {
    plan: (request) => Effect.map(prepare(request), (prepared) => prepared.decision),
    create: (command) =>
      Effect.gen(function* () {
        const decoded = yield* decodeCreateCommand(command)
        yield* authorize(decoded.context)
        const fingerprint = yield* identity.fingerprint(decoded)
        const replay = yield* repository.findReplay(
          decoded.context.organizationId,
          decoded.idempotencyKey,
          fingerprint,
        )
        if (replay !== null) return replay
        const prepared = yield* prepare({ context: decoded.context, intent: decoded.intent })
        const ids = yield* identity.derive(decoded, fingerprint, prepared.decision.ports.length)
        const time = yield* clock.now
        return yield* repository.acceptAtomic({
          command: decoded,
          fingerprint,
          identity: ids,
          prepared,
          now: time.iso,
        })
      }),
  } satisfies ServerPlanControlShape
})
export const ServerPlanControlLive = Layer.effect(ServerPlanControl, makeServerPlanControl)

export * from './provisioning.js'

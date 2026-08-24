import { Context, Effect, Layer, Schema } from 'effect'

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
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)

export const NodeRuntimeLifecycleAction = Schema.Literals(['start', 'stop', 'reboot', 'reconcile'])
export type NodeRuntimeLifecycleAction = typeof NodeRuntimeLifecycleAction.Type

export const NodeRuntimeLifecycleRole = Schema.Literals([
  'owner',
  'administrator',
  'operator',
  'viewer',
  'automation',
])
export type NodeRuntimeLifecycleRole = typeof NodeRuntimeLifecycleRole.Type

export const NodeRuntimeDesiredState = Schema.Literals([
  'provisioning',
  'ready',
  'draining',
  'stopped',
  'deleted',
])
export type NodeRuntimeDesiredState = typeof NodeRuntimeDesiredState.Type

export const NodeRuntimeObservedState = Schema.Literals([
  'unknown',
  'provisioning',
  'bootstrapping',
  'ready',
  'degraded',
  'offline',
  'deleting',
  'deleted',
  'failed',
])
export type NodeRuntimeObservedState = typeof NodeRuntimeObservedState.Type

/**
 * The public intent never accepts a target state, provider identifier, or provider credential.
 * The repository loads those facts from the organization-scoped node record.
 */
export const NodeRuntimeLifecycleIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  action: NodeRuntimeLifecycleAction,
  expectedDesiredRevision: Revision,
})
export type NodeRuntimeLifecycleIntent = typeof NodeRuntimeLifecycleIntent.Type

export interface NodeRuntimeLifecycleCommand {
  readonly organizationId: string
  readonly actorId: string
  readonly actorRole: NodeRuntimeLifecycleRole
  /** Optional Access authorization snapshot. D1 verifies it at mutation time when available. */
  readonly actorMembershipRevision?: number
  readonly nodeId: string
  readonly idempotencyKey: string
  readonly correlationId: string
  readonly intent: NodeRuntimeLifecycleIntent
}

export interface NodeRuntimeLifecycleNode {
  readonly organizationId: string
  readonly nodeId: string
  readonly providerAccountId: string
  /** Immutable execution coordinates captured from active account/allocation/credential records. */
  readonly providerAccountScope: 'platform' | 'organization'
  readonly providerAccountRevision: number
  readonly providerAllocationRevision: number
  readonly providerCredentialReference: string
  readonly providerCredentialRevision: number
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerInstanceId: string | null
  readonly desiredState: NodeRuntimeDesiredState
  readonly observedState: NodeRuntimeObservedState
  readonly desiredRevision: number
  readonly observedRevision: number
  readonly pendingLifecycleOperationId: string | null
}

export interface NodeRuntimeLifecycleTransition {
  readonly previousDesiredState: NodeRuntimeDesiredState
  readonly previousDesiredRevision: number
  readonly desiredState: 'ready' | 'stopped'
  readonly desiredRevision: number
}

export interface NodeRuntimeLifecycleWorkflowStart {
  readonly id: string
  readonly state: 'pending' | 'started' | 'adopted'
  readonly attempts: number
  readonly lastError: string | null
}

export interface NodeRuntimeLifecycleAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly organizationId: string
  readonly nodeId: string
  readonly action: NodeRuntimeLifecycleAction
  readonly operationId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly transition: NodeRuntimeLifecycleTransition
  readonly workflowStart: NodeRuntimeLifecycleWorkflowStart
}

export interface NodeRuntimeLifecycleIdentity {
  readonly operationId: string
  /** Terminal, fact-specific operation used only to evidence accepted intent in v1 audit. */
  readonly auditOperationId: string
  readonly workflowStartRecordId: string
  readonly auditEventId: string
  readonly outboxEventId: string
}

export interface NodeRuntimeLifecycleAtomicInput {
  readonly command: NodeRuntimeLifecycleCommand
  readonly node: NodeRuntimeLifecycleNode
  readonly transition: NodeRuntimeLifecycleTransition
  readonly identity: NodeRuntimeLifecycleIdentity
  readonly fingerprint: string
  readonly now: string
}

export class NodeRuntimeLifecycleValidationError extends Schema.TaggedError<NodeRuntimeLifecycleValidationError>()(
  'NodeRuntimeLifecycleValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class NodeRuntimeLifecycleAuthorizationError extends Schema.TaggedError<NodeRuntimeLifecycleAuthorizationError>()(
  'NodeRuntimeLifecycleAuthorizationError',
  { code: Schema.Literal('operator_required') },
) {}
export class NodeRuntimeLifecycleNotFoundError extends Schema.TaggedError<NodeRuntimeLifecycleNotFoundError>()(
  'NodeRuntimeLifecycleNotFoundError',
  { nodeId: Schema.String },
) {}
export class NodeRuntimeLifecycleConflictError extends Schema.TaggedError<NodeRuntimeLifecycleConflictError>()(
  'NodeRuntimeLifecycleConflictError',
  {
    code: Schema.Literals([
      'idempotency_payload_mismatch',
      'desired_revision_mismatch',
      'invalid_desired_state',
      'node_busy',
      'provider_instance_missing',
      'provider_binding_unavailable',
    ]),
  },
) {}
export class NodeRuntimeLifecycleCapabilityError extends Schema.TaggedError<NodeRuntimeLifecycleCapabilityError>()(
  'NodeRuntimeLifecycleCapabilityError',
  { action: NodeRuntimeLifecycleAction, providerType: Schema.Literals(['ovhcloud', 'contabo']) },
) {}
export class NodeRuntimeLifecyclePersistenceError extends Schema.TaggedError<NodeRuntimeLifecyclePersistenceError>()(
  'NodeRuntimeLifecyclePersistenceError',
  { operation: Schema.String },
) {}
export class NodeRuntimeLifecycleWorkflowStartError extends Schema.TaggedError<NodeRuntimeLifecycleWorkflowStartError>()(
  'NodeRuntimeLifecycleWorkflowStartError',
  { operationId: Schema.String, message: Schema.String },
) {}

export type NodeRuntimeLifecycleControlError =
  | NodeRuntimeLifecycleValidationError
  | NodeRuntimeLifecycleAuthorizationError
  | NodeRuntimeLifecycleNotFoundError
  | NodeRuntimeLifecycleConflictError
  | NodeRuntimeLifecycleCapabilityError
  | NodeRuntimeLifecyclePersistenceError

export interface NodeRuntimeLifecycleRepositoryShape {
  /** Exact replay is checked before the current node state is read. */
  readonly findReplay: (input: {
    readonly organizationId: string
    readonly idempotencyKey: string
    readonly fingerprint: string
  }) => Effect.Effect<
    NodeRuntimeLifecycleAcceptance | null,
    NodeRuntimeLifecycleConflictError | NodeRuntimeLifecyclePersistenceError
  >
  /** This records the node transition, operation, audit event, outbox event, and Workflow start in one batch. */
  readonly acceptAtomic: (
    input: NodeRuntimeLifecycleAtomicInput,
  ) => Effect.Effect<
    NodeRuntimeLifecycleAcceptance,
    | NodeRuntimeLifecycleAuthorizationError
    | NodeRuntimeLifecycleNotFoundError
    | NodeRuntimeLifecycleConflictError
    | NodeRuntimeLifecyclePersistenceError
  >
  readonly getNode: (
    organizationId: string,
    nodeId: string,
  ) => Effect.Effect<
    NodeRuntimeLifecycleNode,
    | NodeRuntimeLifecycleNotFoundError
    | NodeRuntimeLifecycleConflictError
    | NodeRuntimeLifecyclePersistenceError
  >
  readonly markWorkflowStarted: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<void, NodeRuntimeLifecyclePersistenceError>
  /** A lost native create response is adopted only after the fixed instance ID is observed. */
  readonly markWorkflowAdopted: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<void, NodeRuntimeLifecyclePersistenceError>
  readonly recordWorkflowStartFailure: (
    organizationId: string,
    operationId: string,
    message: string,
  ) => Effect.Effect<void, NodeRuntimeLifecyclePersistenceError>
}
export class NodeRuntimeLifecycleRepository extends Context.Service<
  NodeRuntimeLifecycleRepository,
  NodeRuntimeLifecycleRepositoryShape
>()('@gridora/node-runtime-lifecycle-control/NodeRuntimeLifecycleRepository') {}
export const NodeRuntimeLifecycleRepositoryLayer = (
  repository: NodeRuntimeLifecycleRepositoryShape,
) => Layer.succeed(NodeRuntimeLifecycleRepository, repository)

/** Provider transport has its own check too; this admission check avoids accepting impossible intents. */
export interface NodeRuntimeLifecycleCapabilityPortShape {
  readonly assertSupported: (input: {
    readonly providerType: 'ovhcloud' | 'contabo'
    readonly action: NodeRuntimeLifecycleAction
  }) => Effect.Effect<void, NodeRuntimeLifecycleCapabilityError>
}
export class NodeRuntimeLifecycleCapabilityPort extends Context.Service<
  NodeRuntimeLifecycleCapabilityPort,
  NodeRuntimeLifecycleCapabilityPortShape
>()('@gridora/node-runtime-lifecycle-control/NodeRuntimeLifecycleCapabilityPort') {}
export const NodeRuntimeLifecycleCapabilityPortLayer = (
  port: NodeRuntimeLifecycleCapabilityPortShape,
) => Layer.succeed(NodeRuntimeLifecycleCapabilityPort, port)

export interface NodeRuntimeLifecycleIdentityPortShape {
  readonly fingerprint: (
    command: NodeRuntimeLifecycleCommand,
  ) => Effect.Effect<string, NodeRuntimeLifecycleValidationError>
  readonly derive: (
    command: NodeRuntimeLifecycleCommand,
    fingerprint: string,
  ) => Effect.Effect<NodeRuntimeLifecycleIdentity, NodeRuntimeLifecycleValidationError>
}
export class NodeRuntimeLifecycleIdentityPort extends Context.Service<
  NodeRuntimeLifecycleIdentityPort,
  NodeRuntimeLifecycleIdentityPortShape
>()('@gridora/node-runtime-lifecycle-control/NodeRuntimeLifecycleIdentityPort') {}
export const NodeRuntimeLifecycleIdentityPortLayer = (
  port: NodeRuntimeLifecycleIdentityPortShape,
) => Layer.succeed(NodeRuntimeLifecycleIdentityPort, port)

export interface NodeRuntimeLifecycleClockShape {
  readonly now: Effect.Effect<{ readonly iso: string }>
}
export class NodeRuntimeLifecycleClock extends Context.Service<
  NodeRuntimeLifecycleClock,
  NodeRuntimeLifecycleClockShape
>()('@gridora/node-runtime-lifecycle-control/NodeRuntimeLifecycleClock') {}
export const NodeRuntimeLifecycleClockLayer = (clock: NodeRuntimeLifecycleClockShape) =>
  Layer.succeed(NodeRuntimeLifecycleClock, clock)

export interface NodeRuntimeLifecycleWorkflowStarterShape {
  readonly start: (
    acceptance: NodeRuntimeLifecycleAcceptance,
  ) => Effect.Effect<void, NodeRuntimeLifecycleWorkflowStartError>
}
export class NodeRuntimeLifecycleWorkflowStarter extends Context.Service<
  NodeRuntimeLifecycleWorkflowStarter,
  NodeRuntimeLifecycleWorkflowStarterShape
>()('@gridora/node-runtime-lifecycle-control/NodeRuntimeLifecycleWorkflowStarter') {}
export const NodeRuntimeLifecycleWorkflowStarterLayer = (
  starter: NodeRuntimeLifecycleWorkflowStarterShape,
) => Layer.succeed(NodeRuntimeLifecycleWorkflowStarter, starter)

const CommandContract = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  actorRole: NodeRuntimeLifecycleRole,
  actorMembershipRevision: Schema.optional(Revision),
  nodeId: Identifier,
  idempotencyKey: IdempotencyKey,
  correlationId: Identifier,
  intent: NodeRuntimeLifecycleIntent,
})

const validateCommand = (command: NodeRuntimeLifecycleCommand) =>
  Schema.decodeUnknownEffect(CommandContract, { onExcessProperty: 'error' })(command).pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new NodeRuntimeLifecycleValidationError({
          code: 'invalid_node_runtime_lifecycle_command',
          message: 'Node runtime lifecycle command is invalid',
        }),
    ),
  )

const requireOperator = (role: NodeRuntimeLifecycleRole) =>
  role === 'owner' || role === 'administrator' || role === 'operator'
    ? Effect.void
    : Effect.fail(new NodeRuntimeLifecycleAuthorizationError({ code: 'operator_required' }))

export const transitionFor = (
  node: NodeRuntimeLifecycleNode,
  intent: NodeRuntimeLifecycleIntent,
): Effect.Effect<NodeRuntimeLifecycleTransition, NodeRuntimeLifecycleConflictError> => {
  if (node.desiredRevision !== intent.expectedDesiredRevision)
    return Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'desired_revision_mismatch' }))
  if (node.pendingLifecycleOperationId !== null)
    return Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'node_busy' }))
  if (node.providerInstanceId === null)
    return Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'provider_instance_missing' }))

  const next = (desiredState: 'ready' | 'stopped'): NodeRuntimeLifecycleTransition => ({
    previousDesiredState: node.desiredState,
    previousDesiredRevision: node.desiredRevision,
    desiredState,
    desiredRevision: node.desiredRevision + 1,
  })
  switch (intent.action) {
    case 'start':
      return node.desiredState === 'stopped'
        ? Effect.succeed(next('ready'))
        : Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'invalid_desired_state' }))
    case 'stop':
      return node.desiredState === 'ready'
        ? Effect.succeed(next('stopped'))
        : Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'invalid_desired_state' }))
    case 'reboot':
      return node.desiredState === 'ready'
        ? Effect.succeed(next('ready'))
        : Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'invalid_desired_state' }))
    case 'reconcile':
      return node.desiredState === 'ready' || node.desiredState === 'stopped'
        ? Effect.succeed(next(node.desiredState))
        : Effect.fail(new NodeRuntimeLifecycleConflictError({ code: 'invalid_desired_state' }))
  }
}

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

/** Role and membership freshness are authorization facts, not an idempotency payload. */
export const canonicalNodeRuntimeLifecycleIntent = (command: NodeRuntimeLifecycleCommand): string =>
  JSON.stringify(
    canonical({
      organizationId: command.organizationId,
      actorId: command.actorId,
      nodeId: command.nodeId,
      intent: command.intent,
    }),
  )

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const sha256 = (value: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest('SHA-256', buffer(new TextEncoder().encode(value)))
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      )
    },
    catch: () =>
      new NodeRuntimeLifecycleValidationError({
        code: 'identity_derivation_failed',
        message: 'Node runtime lifecycle identity could not be derived',
      }),
  })

export const makeWebCryptoNodeRuntimeLifecycleIdentity =
  (): NodeRuntimeLifecycleIdentityPortShape => ({
    fingerprint: (command) => sha256(canonicalNodeRuntimeLifecycleIntent(command)),
    derive: (command, fingerprint) =>
      sha256(
        `gridora:node-runtime-lifecycle:v1:${command.organizationId}:${command.actorId}:${command.idempotencyKey}:${fingerprint}`,
      ).pipe(
        Effect.map((scope) => ({
          operationId: `op_node_runtime_${scope.slice(0, 24)}`,
          auditOperationId: `audit_op_node_runtime_${scope.slice(0, 24)}`,
          workflowStartRecordId: `workflow-start:op_node_runtime_${scope.slice(0, 24)}`,
          auditEventId: `audit_node_runtime_${scope.slice(0, 24)}`,
          outboxEventId: `outbox_node_runtime_${scope.slice(0, 24)}`,
        })),
      ),
  })

const startAccepted = (
  repository: NodeRuntimeLifecycleRepositoryShape,
  workflows: NodeRuntimeLifecycleWorkflowStarterShape,
  acceptance: NodeRuntimeLifecycleAcceptance,
) =>
  acceptance.workflowStart.state === 'started' || acceptance.workflowStart.state === 'adopted'
    ? Effect.succeed(true)
    : workflows.start(acceptance).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            repository
              .recordWorkflowStartFailure(
                acceptance.organizationId,
                acceptance.operationId,
                error.message,
              )
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.as(false),
              ),
          onSuccess: () =>
            repository
              .markWorkflowStarted(acceptance.organizationId, acceptance.operationId)
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
        }),
      )

export interface NodeRuntimeLifecycleControlShape {
  readonly submit: (
    command: NodeRuntimeLifecycleCommand,
  ) => Effect.Effect<NodeRuntimeLifecycleResult, NodeRuntimeLifecycleControlError>
}
export class NodeRuntimeLifecycleControl extends Context.Service<
  NodeRuntimeLifecycleControl,
  NodeRuntimeLifecycleControlShape
>()('@gridora/node-runtime-lifecycle-control/NodeRuntimeLifecycleControl') {}

export interface NodeRuntimeLifecycleResult {
  readonly disposition: 'created' | 'adopted'
  readonly nodeId: string
  readonly action: NodeRuntimeLifecycleAction
  readonly operationId: string
  readonly transition: NodeRuntimeLifecycleTransition
  readonly workflowState: 'started' | 'pending-reconciliation'
}

export const makeNodeRuntimeLifecycleControl = (dependencies: {
  readonly repository: NodeRuntimeLifecycleRepositoryShape
  readonly capabilities: NodeRuntimeLifecycleCapabilityPortShape
  readonly identities: NodeRuntimeLifecycleIdentityPortShape
  readonly clock: NodeRuntimeLifecycleClockShape
  readonly workflows: NodeRuntimeLifecycleWorkflowStarterShape
}): NodeRuntimeLifecycleControlShape => ({
  submit: (command) =>
    Effect.gen(function* () {
      yield* validateCommand(command)
      yield* requireOperator(command.actorRole)
      const fingerprint = yield* dependencies.identities.fingerprint(command)
      const replay = yield* dependencies.repository.findReplay({
        organizationId: command.organizationId,
        idempotencyKey: command.idempotencyKey,
        fingerprint,
      })
      const accepted = yield* Effect.gen(function* () {
        if (replay !== null) return { ...replay, disposition: 'adopted' as const }
        const node = yield* dependencies.repository.getNode(command.organizationId, command.nodeId)
        const transition = yield* transitionFor(node, command.intent)
        yield* dependencies.capabilities.assertSupported({
          providerType: node.providerType,
          action: command.intent.action,
        })
        const identity = yield* dependencies.identities.derive(command, fingerprint)
        const now = yield* dependencies.clock.now
        return yield* dependencies.repository.acceptAtomic({
          command,
          node,
          transition,
          identity,
          fingerprint,
          now: now.iso,
        })
      })
      const started = yield* startAccepted(
        dependencies.repository,
        dependencies.workflows,
        accepted,
      )
      return {
        disposition: accepted.disposition,
        nodeId: accepted.nodeId,
        action: accepted.action,
        operationId: accepted.operationId,
        transition: accepted.transition,
        workflowState: started ? ('started' as const) : ('pending-reconciliation' as const),
      }
    }),
})

export const NodeRuntimeLifecycleControlLive = Layer.effect(
  NodeRuntimeLifecycleControl,
  Effect.gen(function* () {
    return NodeRuntimeLifecycleControl.of(
      makeNodeRuntimeLifecycleControl({
        repository: yield* NodeRuntimeLifecycleRepository,
        capabilities: yield* NodeRuntimeLifecycleCapabilityPort,
        identities: yield* NodeRuntimeLifecycleIdentityPort,
        clock: yield* NodeRuntimeLifecycleClock,
        workflows: yield* NodeRuntimeLifecycleWorkflowStarter,
      }),
    )
  }),
)

export const NodeRuntimeLifecycleAcceptanceContract = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  organizationId: Identifier,
  nodeId: Identifier,
  action: NodeRuntimeLifecycleAction,
  operationId: Identifier,
  idempotencyKey: IdempotencyKey,
  fingerprint: Sha256,
  transition: Schema.Struct({
    previousDesiredState: NodeRuntimeDesiredState,
    previousDesiredRevision: Revision,
    desiredState: Schema.Literals(['ready', 'stopped']),
    desiredRevision: Revision,
  }),
  workflowStart: Schema.Struct({
    id: Identifier,
    state: Schema.Literals(['pending', 'started', 'adopted']),
    attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    lastError: Schema.NullOr(Schema.String),
  }),
})

export const NodeRuntimeLifecycleTimestamp = Timestamp

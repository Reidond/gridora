import { Context, Effect, Layer, Schema } from 'effect'
import {
  OrganizationPolicyV1,
  OrganizationUsage,
  evaluateIdlePolicy,
  evaluatePolicyAdmission,
  type AdmissionRequest,
  type OrganizationPolicyV1 as OrganizationPolicy,
  type OrganizationUsage as Usage,
} from '@gridora/policy-control'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))

export const POLICY_RECONCILIATION_MAX_NODES = 100
export const POLICY_RECONCILIATION_MAX_SERVERS = 100
export const POLICY_RECONCILIATION_MAX_ACTIONS = 100
export const POLICY_RECONCILIATION_MAX_SNAPSHOT_AGE_MILLISECONDS = 5 * 60_000

export const PolicyReconciliationRequest = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  policyRevision: PositiveRevision,
  scheduleSlot: Timestamp,
  runId: Identifier,
  idempotencyKey: Identifier,
  /** Opaque lease proof from the deterministic scheduler task; never a credential. */
  leaseToken: Identifier,
})
export type PolicyReconciliationRequest = typeof PolicyReconciliationRequest.Type

export const PolicyNodeSnapshot = Schema.Struct({
  organizationId: Identifier,
  nodeId: Identifier,
  desiredRevision: PositiveRevision,
  desiredState: Schema.Literals(['provisioning', 'ready', 'draining', 'stopped', 'deleted']),
  observedState: Schema.Literals([
    'unknown',
    'provisioning',
    'bootstrapping',
    'ready',
    'degraded',
    'offline',
    'deleting',
    'deleted',
    'failed',
  ]),
  /** NULL is deliberately non-actionable for nodes created before expiry persistence existed. */
  temporaryExpiresAt: Schema.NullOr(Timestamp),
})
export type PolicyNodeSnapshot = typeof PolicyNodeSnapshot.Type

export const PolicyUpdateCandidate = Schema.Struct({
  id: Identifier,
  revision: PositiveRevision,
  category: Schema.Literals(['security', 'feature']),
  targetVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type PolicyUpdateCandidate = typeof PolicyUpdateCandidate.Type

export const PolicyServerSnapshot = Schema.Struct({
  organizationId: Identifier,
  serverId: Identifier,
  desiredRevision: PositiveRevision,
  desiredState: Schema.Literals(['running', 'stopped', 'deleted']),
  observedState: Schema.Literals([
    'unknown',
    'planning',
    'installing',
    'starting',
    'running',
    'stopping',
    'stopped',
    'updating',
    'backing_up',
    'restoring',
    'moving',
    'repairing',
    'deleting',
    'deleted',
    'failed',
  ]),
  activeConfigRevision: PositiveRevision,
  desiredModRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pendingLifecycleOperationId: Schema.NullOr(Identifier),
  /** Last sampled time at which an authoritative health reduction showed players. */
  lastActivityAt: Schema.NullOr(Timestamp),
  /** The current authoritative health reduction. NULL means idle automation is non-actionable. */
  healthSampledAt: Schema.NullOr(Timestamp),
  healthRevision: Schema.NullOr(PositiveRevision),
  currentPlayerCount: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** A trusted candidate is supplied by a reviewed release intake, never by a cron payload. */
  updateCandidate: Schema.NullOr(PolicyUpdateCandidate),
})
export type PolicyServerSnapshot = typeof PolicyServerSnapshot.Type

export const PolicyReconciliationSnapshot = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  policyRevision: PositiveRevision,
  observedAt: Timestamp,
  policy: OrganizationPolicyV1,
  usage: OrganizationUsage,
  nodes: Schema.Array(PolicyNodeSnapshot).check(
    Schema.isMaxLength(POLICY_RECONCILIATION_MAX_NODES),
  ),
  servers: Schema.Array(PolicyServerSnapshot).check(
    Schema.isMaxLength(POLICY_RECONCILIATION_MAX_SERVERS),
  ),
})
export type PolicyReconciliationSnapshot = typeof PolicyReconciliationSnapshot.Type

export const PolicyReconciliationActionKind = Schema.Literals([
  'retire-node',
  'shutdown-server',
  'delete-server',
  'update-server',
])
export type PolicyReconciliationActionKind = typeof PolicyReconciliationActionKind.Type

export const PolicyReconciliationActionReason = Schema.Literals([
  'temporary-node-expired',
  'idle-threshold-reached',
  'automatic-update-eligible',
])
export type PolicyReconciliationActionReason = typeof PolicyReconciliationActionReason.Type

/**
 * A planned action is an accepted command request only. It is never evidence
 * that a provider, node agent, or game process changed state.
 */
export const PolicyReconciliationAction = Schema.Struct({
  id: Identifier,
  organizationId: Identifier,
  actorId: Identifier,
  runId: Identifier,
  policyRevision: PositiveRevision,
  resourceKind: Schema.Literals(['node', 'server']),
  resourceId: Identifier,
  resourceRevision: PositiveRevision,
  kind: PolicyReconciliationActionKind,
  reason: PolicyReconciliationActionReason,
  idempotencyKey: Identifier,
  correlationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  /** The immutable expiry accepted with the node. It is present only for retire-node. */
  resourceExpiresAt: Schema.NullOr(Timestamp),
  /** Exact health/activity facts used only by an idle action. */
  activityLastAt: Schema.NullOr(Timestamp),
  healthSampledAt: Schema.NullOr(Timestamp),
  healthRevision: Schema.NullOr(PositiveRevision),
  /** Exact configuration facts accepted by an automatic update. */
  configRevision: Schema.NullOr(PositiveRevision),
  modRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  updateCandidateId: Schema.NullOr(Identifier),
  updateCandidateRevision: Schema.NullOr(PositiveRevision),
  updateCategory: Schema.NullOr(Schema.Literals(['security', 'feature'])),
  updateTargetVersion: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
})
export type PolicyReconciliationAction = typeof PolicyReconciliationAction.Type

export const PolicyReconciliationPlan = Schema.Struct({
  ...PolicyReconciliationRequest.fields,
  observedAt: Timestamp,
  snapshotFingerprint: Digest,
  actions: Schema.Array(PolicyReconciliationAction).check(
    Schema.isMaxLength(POLICY_RECONCILIATION_MAX_ACTIONS),
  ),
})
export type PolicyReconciliationPlan = typeof PolicyReconciliationPlan.Type

export const PolicyActionDispatchState = Schema.Literals([
  'pending',
  'accepted',
  'pending-reconciliation',
  'rejected-stale',
  'rejected-policy',
])
export type PolicyActionDispatchState = typeof PolicyActionDispatchState.Type

export const PolicyReconciliationActionRecord = Schema.Struct({
  ...PolicyReconciliationAction.fields,
  dispatchState: PolicyActionDispatchState,
  operationId: Schema.NullOr(Identifier),
})
export type PolicyReconciliationActionRecord = typeof PolicyReconciliationActionRecord.Type

export const PolicyReconciliationResult = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  policyRevision: PositiveRevision,
  runId: Identifier,
  idempotencyKey: Identifier,
  snapshotFingerprint: Digest,
  actions: Schema.Array(PolicyReconciliationActionRecord).check(
    Schema.isMaxLength(POLICY_RECONCILIATION_MAX_ACTIONS),
  ),
  replayed: Schema.Boolean,
})
export type PolicyReconciliationResult = typeof PolicyReconciliationResult.Type

export const PolicyActionDispatch = Schema.Struct({
  actionId: Identifier,
  operationId: Identifier,
  disposition: Schema.Literals(['accepted', 'adopted']),
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
})
export type PolicyActionDispatch = typeof PolicyActionDispatch.Type

export class PolicyReconciliationError extends Schema.TaggedError<PolicyReconciliationError>()(
  'PolicyReconciliationError',
  {
    code: Schema.Literals([
      'invalid-request',
      'invalid-scope',
      'stale-policy',
      'stale-resource',
      'stale-snapshot',
      'unbounded-snapshot',
      'idempotency-conflict',
      'persistence-failed',
    ]),
    operation: Schema.String,
    message: Schema.Literal('policy reconciliation failed'),
  },
) {}

export class PolicyActionExecutionError extends Schema.TaggedError<PolicyActionExecutionError>()(
  'PolicyActionExecutionError',
  {
    code: Schema.Literals(['stale-resource', 'policy-rejected', 'unavailable']),
    operation: Schema.String,
  },
) {}

const failure = (
  operation: string,
  code: (typeof PolicyReconciliationError.Type)['code'],
): PolicyReconciliationError =>
  new PolicyReconciliationError({ operation, code, message: 'policy reconciliation failed' })

export interface PolicyReconciliationRepositoryShape {
  /** Exact replay is checked before a current snapshot is loaded. */
  readonly findReplay: (
    request: PolicyReconciliationRequest,
  ) => Effect.Effect<PolicyReconciliationResult | null, PolicyReconciliationError>
  /** Returns only tenant-scoped, bounded, authoritative D1 facts. */
  readonly loadSnapshot: (
    request: PolicyReconciliationRequest,
  ) => Effect.Effect<PolicyReconciliationSnapshot, PolicyReconciliationError>
  /**
   * One D1 transaction persists the run, every action request, audit records,
   * and outbox records. Its final trigger rechecks policy, actor, lease, and
   * resource revisions.
   */
  readonly applyAtomic: (
    plan: PolicyReconciliationPlan,
  ) => Effect.Effect<PolicyReconciliationResult, PolicyReconciliationError>
  /** Final D1 authority fence immediately before a real lifecycle boundary. */
  readonly assertDispatchAuthority: (
    action: PolicyReconciliationActionRecord,
  ) => Effect.Effect<void, PolicyReconciliationError>
  /** Persists acceptance only; it never changes the action into successful execution. */
  readonly markDispatch: (
    action: PolicyReconciliationActionRecord,
    dispatch: PolicyActionDispatch,
  ) => Effect.Effect<PolicyReconciliationActionRecord, PolicyReconciliationError>
  readonly markRejected: (
    action: PolicyReconciliationActionRecord,
    state: 'rejected-stale' | 'rejected-policy',
  ) => Effect.Effect<PolicyReconciliationActionRecord, PolicyReconciliationError>
}
export class PolicyReconciliationRepository extends Context.Service<
  PolicyReconciliationRepository,
  PolicyReconciliationRepositoryShape
>()('@gridora/policy-reconciliation-control/PolicyReconciliationRepository') {}
export const PolicyReconciliationRepositoryLayer = (
  repository: PolicyReconciliationRepositoryShape,
) => Layer.succeed(PolicyReconciliationRepository, repository)

/** This port only submits to existing lifecycle controls; it cannot report provider or agent success. */
export interface PolicyActionExecutorShape {
  readonly dispatch: (
    action: PolicyReconciliationActionRecord,
  ) => Effect.Effect<PolicyActionDispatch, PolicyActionExecutionError>
}
export class PolicyActionExecutor extends Context.Service<
  PolicyActionExecutor,
  PolicyActionExecutorShape
>()('@gridora/policy-reconciliation-control/PolicyActionExecutor') {}
export const PolicyActionExecutorLayer = (executor: PolicyActionExecutorShape) =>
  Layer.succeed(PolicyActionExecutor, executor)

export interface PolicyReconciliationClockShape {
  readonly now: Effect.Effect<Date, PolicyReconciliationError>
}
export class PolicyReconciliationClock extends Context.Service<
  PolicyReconciliationClock,
  PolicyReconciliationClockShape
>()('@gridora/policy-reconciliation-control/PolicyReconciliationClock') {}
export const PolicyReconciliationClockLayer = (clock: PolicyReconciliationClockShape) =>
  Layer.succeed(PolicyReconciliationClock, clock)

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

const sha256 = (operation: string, value: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value))),
      )
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => failure(operation, 'persistence-failed'),
  })

const exactEpoch = (value: string): number | undefined => {
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const stableServer = (server: PolicyServerSnapshot): boolean =>
  server.desiredState === 'running' &&
  server.observedState === 'running' &&
  server.pendingLifecycleOperationId === null

const actionShapeIsCoherent = (action: PolicyReconciliationAction): boolean => {
  if (action.kind === 'retire-node')
    return (
      action.resourceKind === 'node' &&
      action.reason === 'temporary-node-expired' &&
      action.resourceExpiresAt !== null &&
      action.activityLastAt === null &&
      action.healthSampledAt === null &&
      action.healthRevision === null &&
      action.configRevision === null &&
      action.modRevision === null &&
      action.updateCandidateId === null &&
      action.updateCandidateRevision === null &&
      action.updateCategory === null &&
      action.updateTargetVersion === null
    )
  if (action.kind === 'shutdown-server' || action.kind === 'delete-server')
    return (
      action.resourceKind === 'server' &&
      action.reason === 'idle-threshold-reached' &&
      action.resourceExpiresAt === null &&
      action.activityLastAt !== null &&
      action.healthSampledAt !== null &&
      action.healthRevision !== null &&
      action.configRevision === null &&
      action.modRevision === null &&
      action.updateCandidateId === null &&
      action.updateCandidateRevision === null &&
      action.updateCategory === null &&
      action.updateTargetVersion === null
    )
  return (
    action.resourceKind === 'server' &&
    action.reason === 'automatic-update-eligible' &&
    action.resourceExpiresAt === null &&
    action.activityLastAt === null &&
    action.healthSampledAt === null &&
    action.healthRevision === null &&
    action.configRevision !== null &&
    action.modRevision !== null &&
    action.updateCandidateId !== null &&
    action.updateCandidateRevision !== null &&
    action.updateCategory !== null &&
    action.updateTargetVersion !== null
  )
}

const assertSnapshot = (
  request: PolicyReconciliationRequest,
  snapshot: PolicyReconciliationSnapshot,
  now: Date,
): Effect.Effect<void, PolicyReconciliationError> => {
  const nowEpoch = now.getTime()
  const observedAt = exactEpoch(snapshot.observedAt)
  if (
    snapshot.organizationId !== request.organizationId ||
    snapshot.actorId !== request.actorId ||
    snapshot.policyRevision !== request.policyRevision ||
    snapshot.policy.organizationId !== request.organizationId ||
    snapshot.policy.revision !== request.policyRevision ||
    snapshot.usage.organizationId !== request.organizationId
  )
    return Effect.fail(failure('policy-reconciliation.snapshot.scope', 'invalid-scope'))
  if (
    !Number.isSafeInteger(nowEpoch) ||
    observedAt === undefined ||
    observedAt > nowEpoch ||
    nowEpoch - observedAt > POLICY_RECONCILIATION_MAX_SNAPSHOT_AGE_MILLISECONDS
  )
    return Effect.fail(failure('policy-reconciliation.snapshot.age', 'stale-snapshot'))
  if (
    snapshot.nodes.length > POLICY_RECONCILIATION_MAX_NODES ||
    snapshot.servers.length > POLICY_RECONCILIATION_MAX_SERVERS
  )
    return Effect.fail(failure('policy-reconciliation.snapshot.bound', 'unbounded-snapshot'))
  const resources = new Set<string>()
  for (const node of snapshot.nodes) {
    const key = `node\u0000${node.nodeId}`
    if (
      node.organizationId !== request.organizationId ||
      resources.has(key) ||
      node.desiredRevision < 1 ||
      (node.temporaryExpiresAt !== null && exactEpoch(node.temporaryExpiresAt) === undefined)
    )
      return Effect.fail(failure('policy-reconciliation.snapshot.node', 'invalid-scope'))
    resources.add(key)
  }
  for (const server of snapshot.servers) {
    const key = `server\u0000${server.serverId}`
    if (
      server.organizationId !== request.organizationId ||
      resources.has(key) ||
      server.desiredRevision < 1 ||
      (server.lastActivityAt !== null && exactEpoch(server.lastActivityAt) === undefined) ||
      (server.healthSampledAt !== null && exactEpoch(server.healthSampledAt) === undefined) ||
      (server.healthSampledAt === null) !== (server.healthRevision === null) ||
      (server.healthSampledAt === null) !== (server.currentPlayerCount === null)
    )
      return Effect.fail(failure('policy-reconciliation.snapshot.server', 'invalid-scope'))
    resources.add(key)
  }
  return Effect.void
}

const automaticUpdateRequest = (
  organizationId: string,
  category: 'security' | 'feature',
): AdmissionRequest => ({
  organizationId,
  action: 'update-server',
  provider: null,
  region: null,
  plan: null,
  dedicatedNode: false,
  targetNodeId: null,
  resources: null,
  temporaryNodeLifetimeHours: null,
  destructiveBackup: 'not-applicable',
  nonHourlyCommitmentConfirmed: false,
  updateContext: { mode: 'automatic', category },
})

const actionIdentity = (
  request: PolicyReconciliationRequest,
  input: {
    readonly resourceKind: 'node' | 'server'
    readonly resourceId: string
    readonly resourceRevision: number
    readonly kind: PolicyReconciliationActionKind
    readonly reason: PolicyReconciliationActionReason
    readonly updateCandidate: PolicyUpdateCandidate | null
    readonly resourceExpiresAt: string | null
    readonly activityLastAt: string | null
    readonly healthSampledAt: string | null
    readonly healthRevision: number | null
    readonly configRevision: number | null
    readonly modRevision: number | null
  },
) =>
  sha256('policy-reconciliation.action.identity', {
    schemaVersion: 1,
    request,
    ...input,
  }).pipe(
    Effect.map((digest) => ({
      id: `policy-action-${digest}`,
      idempotencyKey: `policy-action-idempotency-${digest}`,
    })),
  )

const makeAction = (
  request: PolicyReconciliationRequest,
  input: {
    readonly resourceKind: 'node' | 'server'
    readonly resourceId: string
    readonly resourceRevision: number
    readonly kind: PolicyReconciliationActionKind
    readonly reason: PolicyReconciliationActionReason
    readonly updateCandidate: PolicyUpdateCandidate | null
    readonly resourceExpiresAt: string | null
    readonly activityLastAt: string | null
    readonly healthSampledAt: string | null
    readonly healthRevision: number | null
    readonly configRevision: number | null
    readonly modRevision: number | null
  },
): Effect.Effect<PolicyReconciliationAction, PolicyReconciliationError> =>
  actionIdentity(request, input).pipe(
    Effect.flatMap((identity) =>
      Schema.decodeUnknownEffect(PolicyReconciliationAction, { onExcessProperty: 'error' })({
        ...identity,
        organizationId: request.organizationId,
        actorId: request.actorId,
        runId: request.runId,
        policyRevision: request.policyRevision,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        resourceRevision: input.resourceRevision,
        kind: input.kind,
        reason: input.reason,
        // CorrelationId is an externally decoded domain identifier. Keep the
        // deterministic scheduler/run relationship, but use the same
        // identifier alphabet as public operation lookups.
        correlationId: `policy-reconciliation-${request.runId}`,
        resourceExpiresAt: input.resourceExpiresAt,
        activityLastAt: input.activityLastAt,
        healthSampledAt: input.healthSampledAt,
        healthRevision: input.healthRevision,
        configRevision: input.configRevision,
        modRevision: input.modRevision,
        updateCandidateId: input.updateCandidate?.id ?? null,
        updateCandidateRevision: input.updateCandidate?.revision ?? null,
        updateCategory: input.updateCandidate?.category ?? null,
        updateTargetVersion: input.updateCandidate?.targetVersion ?? null,
      }).pipe(
        Effect.mapError(() => failure('policy-reconciliation.action.decode', 'invalid-scope')),
        Effect.flatMap((action) =>
          actionShapeIsCoherent(action)
            ? Effect.succeed(action)
            : Effect.fail(failure('policy-reconciliation.action.coherence', 'invalid-scope')),
        ),
      ),
    ),
  )

const planActions = (
  request: PolicyReconciliationRequest,
  snapshot: PolicyReconciliationSnapshot,
  now: Date,
): Effect.Effect<readonly PolicyReconciliationAction[], PolicyReconciliationError> =>
  Effect.gen(function* () {
    const nowEpoch = now.getTime()
    const actions: PolicyReconciliationAction[] = []
    const selectedServers = new Set<string>()
    for (const node of [...snapshot.nodes].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    )) {
      if (actions.length >= POLICY_RECONCILIATION_MAX_ACTIONS) break
      const expiresAt =
        node.temporaryExpiresAt === null ? undefined : exactEpoch(node.temporaryExpiresAt)
      if (
        !snapshot.policy.temporaryNodes.automaticExpiryRequired ||
        expiresAt === undefined ||
        expiresAt > nowEpoch ||
        node.desiredState === 'deleted' ||
        node.observedState === 'deleted' ||
        node.desiredState === 'draining'
      )
        continue
      actions.push(
        yield* makeAction(request, {
          resourceKind: 'node',
          resourceId: node.nodeId,
          resourceRevision: node.desiredRevision,
          kind: 'retire-node',
          reason: 'temporary-node-expired',
          updateCandidate: null,
          resourceExpiresAt: node.temporaryExpiresAt,
          activityLastAt: null,
          healthSampledAt: null,
          healthRevision: null,
          configRevision: null,
          modRevision: null,
        }),
      )
    }
    for (const server of [...snapshot.servers].sort((left, right) =>
      left.serverId.localeCompare(right.serverId),
    )) {
      if (actions.length >= POLICY_RECONCILIATION_MAX_ACTIONS) break
      if (
        !stableServer(server) ||
        server.lastActivityAt === null ||
        server.healthSampledAt === null ||
        server.healthRevision === null ||
        server.currentPlayerCount !== 0
      )
        continue
      const lastActivity = exactEpoch(server.lastActivityAt)
      const healthSampledAt = exactEpoch(server.healthSampledAt)
      if (
        healthSampledAt === undefined ||
        healthSampledAt > nowEpoch ||
        nowEpoch - healthSampledAt > POLICY_RECONCILIATION_MAX_SNAPSHOT_AGE_MILLISECONDS
      )
        continue
      if (lastActivity === undefined)
        return yield* failure('policy-reconciliation.idle.timestamp', 'stale-resource')
      const decision = evaluateIdlePolicy({
        policy: snapshot.policy,
        nowEpochMilliseconds: nowEpoch,
        lastActivityEpochMilliseconds: lastActivity,
      })
      if (decision.action === 'none') continue
      const kind = decision.action === 'shutdown' ? 'shutdown-server' : 'delete-server'
      actions.push(
        yield* makeAction(request, {
          resourceKind: 'server',
          resourceId: server.serverId,
          resourceRevision: server.desiredRevision,
          kind,
          reason: 'idle-threshold-reached',
          updateCandidate: null,
          resourceExpiresAt: null,
          activityLastAt: server.lastActivityAt,
          healthSampledAt: server.healthSampledAt,
          healthRevision: server.healthRevision,
          configRevision: null,
          modRevision: null,
        }),
      )
      selectedServers.add(server.serverId)
    }
    for (const server of [...snapshot.servers].sort((left, right) =>
      left.serverId.localeCompare(right.serverId),
    )) {
      if (actions.length >= POLICY_RECONCILIATION_MAX_ACTIONS) break
      if (
        !stableServer(server) ||
        selectedServers.has(server.serverId) ||
        server.updateCandidate === null
      )
        continue
      const decision = evaluatePolicyAdmission({
        policy: snapshot.policy,
        request: automaticUpdateRequest(request.organizationId, server.updateCandidate.category),
        usage: snapshot.usage,
        price: { status: 'unknown' },
        nowEpochMilliseconds: nowEpoch,
      })
      if (decision.outcome === 'deny') continue
      actions.push(
        yield* makeAction(request, {
          resourceKind: 'server',
          resourceId: server.serverId,
          resourceRevision: server.desiredRevision,
          kind: 'update-server',
          reason: 'automatic-update-eligible',
          updateCandidate: server.updateCandidate,
          resourceExpiresAt: null,
          activityLastAt: null,
          healthSampledAt: null,
          healthRevision: null,
          configRevision: server.activeConfigRevision,
          modRevision: server.desiredModRevision,
        }),
      )
      selectedServers.add(server.serverId)
    }
    return actions.sort((left, right) => left.id.localeCompare(right.id))
  })

const decodeRequest = (input: unknown) =>
  Schema.decodeUnknownEffect(PolicyReconciliationRequest, { onExcessProperty: 'error' })(
    input,
  ).pipe(Effect.mapError(() => failure('policy-reconciliation.request.decode', 'invalid-request')))

const decodeSnapshot = (input: unknown) =>
  Schema.decodeUnknownEffect(PolicyReconciliationSnapshot, { onExcessProperty: 'error' })(
    input,
  ).pipe(Effect.mapError(() => failure('policy-reconciliation.snapshot.decode', 'invalid-scope')))

const decodeResult = (input: unknown) =>
  Schema.decodeUnknownEffect(PolicyReconciliationResult, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(() => failure('policy-reconciliation.result.decode', 'persistence-failed')),
  )

const actionRecordMatches = (
  record: PolicyReconciliationActionRecord,
  action: PolicyActionDispatch,
): boolean => record.id === action.actionId && action.operationId.length > 0

const dispatchActions = (
  result: PolicyReconciliationResult,
  repository: PolicyReconciliationRepositoryShape,
  executor: PolicyActionExecutorShape,
): Effect.Effect<PolicyReconciliationResult, PolicyReconciliationError> =>
  Effect.gen(function* () {
    const records: PolicyReconciliationActionRecord[] = []
    for (const record of result.actions) {
      if (record.dispatchState !== 'pending') {
        records.push(record)
        continue
      }
      const authority = yield* Effect.result(repository.assertDispatchAuthority(record))
      if (authority._tag === 'Failure') {
        const error = authority.failure
        if (error.code === 'stale-policy' || error.code === 'stale-resource') {
          records.push(yield* repository.markRejected(record, 'rejected-stale'))
          continue
        }
        return yield* error
      }
      const dispatched = yield* Effect.result(executor.dispatch(record))
      if (dispatched._tag === 'Failure') {
        if (dispatched.failure.code === 'stale-resource') {
          records.push(yield* repository.markRejected(record, 'rejected-stale'))
          continue
        }
        if (dispatched.failure.code === 'policy-rejected') {
          records.push(yield* repository.markRejected(record, 'rejected-policy'))
          continue
        }
        return yield* failure('policy-reconciliation.dispatch.unavailable', 'persistence-failed')
      }
      if (!actionRecordMatches(record, dispatched.success))
        return yield* failure('policy-reconciliation.dispatch.binding', 'invalid-scope')
      records.push(yield* repository.markDispatch(record, dispatched.success))
    }
    return yield* decodeResult({ ...result, actions: records })
  })

export interface PolicyReconciliationControlShape {
  readonly reconcile: (
    request: unknown,
  ) => Effect.Effect<PolicyReconciliationResult, PolicyReconciliationError>
}
export class PolicyReconciliationControl extends Context.Service<
  PolicyReconciliationControl,
  PolicyReconciliationControlShape
>()('@gridora/policy-reconciliation-control/PolicyReconciliationControl') {}

export const makePolicyReconciliationControl = (dependencies: {
  readonly repository: PolicyReconciliationRepositoryShape
  readonly executor: PolicyActionExecutorShape
  readonly clock: PolicyReconciliationClockShape
}): PolicyReconciliationControlShape => ({
  reconcile: (input) =>
    Effect.gen(function* () {
      const request = yield* decodeRequest(input)
      const replay = yield* dependencies.repository.findReplay(request)
      if (replay !== null)
        return yield* dispatchActions(
          yield* decodeResult({ ...replay, replayed: true }),
          dependencies.repository,
          dependencies.executor,
        )
      const [now, snapshotValue] = yield* Effect.all([
        dependencies.clock.now,
        dependencies.repository.loadSnapshot(request),
      ])
      const snapshot = yield* decodeSnapshot(snapshotValue)
      yield* assertSnapshot(request, snapshot, now)
      const actions = yield* planActions(request, snapshot, now)
      const snapshotFingerprint = `sha256:${yield* sha256('policy-reconciliation.snapshot.fingerprint', snapshot)}`
      const accepted = yield* dependencies.repository.applyAtomic({
        ...request,
        observedAt: snapshot.observedAt,
        snapshotFingerprint,
        actions,
      })
      return yield* dispatchActions(accepted, dependencies.repository, dependencies.executor)
    }),
})

export const PolicyReconciliationControlLive = Layer.effect(
  PolicyReconciliationControl,
  Effect.gen(function* () {
    return PolicyReconciliationControl.of(
      makePolicyReconciliationControl({
        repository: yield* PolicyReconciliationRepository,
        executor: yield* PolicyActionExecutor,
        clock: yield* PolicyReconciliationClock,
      }),
    )
  }),
)

/** Exposed for D1 adapters and focused tests; it never performs a side effect. */
export const planPolicyReconciliation = (
  request: PolicyReconciliationRequest,
  snapshot: PolicyReconciliationSnapshot,
  now: Date,
): Effect.Effect<readonly PolicyReconciliationAction[], PolicyReconciliationError> =>
  assertSnapshot(request, snapshot, now).pipe(
    Effect.flatMap(() => planActions(request, snapshot, now)),
  )

export const isPolicyReconciliationActionCoherent = actionShapeIsCoherent
export type { OrganizationPolicy, Usage }

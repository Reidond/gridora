import { Context, Effect, Layer, Schema } from 'effect'
import {
  AuditRequestContext,
  AuditRequestContextValue,
  auditEventSummaryJson,
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  completeAuditEnvelopeFromRequestContext,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  canonicalResourceOperationDoName,
  type CancellationPhase,
  type CancellationSignalInput,
  type CancellationRequest,
  type NodeLifecycleAcceptance,
  type NodeLifecycleCommand,
  type NodeProviderRetirementReceipt,
  type NodeRebuildBootstrap,
  type NodeTerminationAffectedServer,
  type OperationCancellationFacts,
  type OperationCancellationFactsRepositoryShape,
  type OrganizationDeletionAcceptance,
  type OrganizationDeletionInventory,
  type OrganizationDeletionRepositoryShape,
  OrganizationDeletionRepository,
  type NodeTerminationRepositoryShape,
  NodeTerminationRepository,
  type Sha256Fingerprint,
  type TerminationOperation,
  TerminationAuthorizationError,
  TerminationConflictError,
  type TerminationRepositoryShape,
  TerminationPersistenceError,
  type TerminationWorkflowStart,
  type TerminationWorkflowStartRepositoryShape,
  type WorkflowStepEffectReceipt,
  type WorkflowStepLease,
  type WorkflowStepRepositoryShape,
  WorkflowStepRepository,
} from '@gridora/lifecycle-termination-control'

export interface LifecycleTerminationD1Result {
  readonly success?: boolean
  readonly meta?: { readonly changes?: number }
}
export interface LifecycleTerminationD1AllResult {
  readonly results: ReadonlyArray<unknown>
}
export interface LifecycleTerminationD1Statement {
  bind(...values: ReadonlyArray<unknown>): LifecycleTerminationD1Statement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ readonly results: ReadonlyArray<T> }>
}
export interface LifecycleTerminationD1Database {
  prepare(sql: string): LifecycleTerminationD1Statement
  batch(
    statements: ReadonlyArray<LifecycleTerminationD1Statement>,
  ): Promise<ReadonlyArray<LifecycleTerminationD1Result>>
}

export class LifecycleTerminationD1Client extends Context.Service<
  LifecycleTerminationD1Client,
  LifecycleTerminationD1Database
>()('@gridora/lifecycle-termination-d1/LifecycleTerminationD1Client') {}
export const LifecycleTerminationD1ClientLayer = (database: LifecycleTerminationD1Database) =>
  Layer.succeed(LifecycleTerminationD1Client, database)

export interface LifecycleTerminationD1Options {
  readonly now: () => string
  readonly operationId: () => string
  readonly auditEventId: () => string
  readonly outboxEventId: () => string
  readonly workflowStartRecordId: (operationId: string) => string
  readonly auditRequestContext: AuditRequestContextValue
}

const defaults: LifecycleTerminationD1Options = {
  now: () => new Date().toISOString(),
  operationId: () => crypto.randomUUID(),
  auditEventId: () => crypto.randomUUID(),
  outboxEventId: () => crypto.randomUUID(),
  workflowStartRecordId: (operationId) => `termination-workflow-start:${operationId}`,
  auditRequestContext: {
    origin: 'internal',
    requestId: 'termination-internal',
    correlationId: 'termination-internal',
    source: {
      ip: { state: 'not-available', reason: 'internal lifecycle execution has no network source' },
      access: {
        state: 'not-available',
        reason: 'internal lifecycle execution has no Access assertion',
      },
    },
  },
}

const stageTerminationAudit = (
  database: LifecycleTerminationD1Database,
  input: {
    readonly eventId: string
    readonly organizationId: string
    readonly operationId: string
    readonly actorId: string
    readonly actorType: 'human' | 'system'
    readonly correlationId: string
    readonly action: string
    readonly targetType: string
    readonly targetId: string
    readonly before: Readonly<Record<string, unknown>>
    readonly after: Readonly<Record<string, unknown>>
    readonly now: string
    readonly request: AuditRequestContextValue
  },
): Effect.Effect<
  { readonly statement: LifecycleTerminationD1Statement; readonly summaryJson: string },
  TerminationPersistenceError
> =>
  Effect.gen(function* () {
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.organizationId,
      actor: { type: input.actorType, id: input.actorId },
      action: input.action,
      target: { type: input.targetType, id: input.targetId },
      before: { state: 'captured', summary: input.before },
      after: { state: 'captured', summary: input.after },
      operationId: input.operationId,
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.provideService(AuditRequestContext, {
        ...input.request,
        // The command correlation is the immutable operation correlation.
        correlationId: input.correlationId,
      }),
      Effect.mapError((cause) => persistence('termination.audit-envelope.complete', cause)),
    )
    const stage = yield* stageAuditEnvelope('tenant', input.eventId, envelope, input.now).pipe(
      Effect.mapError((cause) => persistence('termination.audit-envelope.stage', cause)),
    )
    return {
      statement: database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const persistence = (operation: string, cause: unknown) =>
  new TerminationPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const attempt = <A>(operation: string, execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => persistence(operation, cause) })
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const integer = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] : undefined
const booleanInteger = (row: Record<string, unknown>, key: string): boolean | undefined =>
  row[key] === 0 ? false : row[key] === 1 ? true : undefined
const sha256 = (value: string): value is Sha256Fingerprint => /^[a-f0-9]{64}$/.test(value)

const failConflict = (code: string) => Effect.fail(new TerminationConflictError({ code }))

const decodePolicy = (value: unknown): OperationCancellationFacts['policy'] | undefined =>
  value === 'before-destructive-step' || value === 'between-steps' || value === 'not-cancellable'
    ? value
    : undefined
const decodePhase = (value: unknown): CancellationPhase | undefined =>
  value === 'before-destructive-step' ||
  value === 'between-steps' ||
  value === 'step-running' ||
  value === 'destructive-step-running' ||
  value === 'terminal'
    ? value
    : undefined
const normalizeOperationState = (value: unknown): TerminationOperation['state'] | undefined => {
  switch (value) {
    case 'queued':
    case 'running':
    case 'blocked':
    case 'cancelling':
    case 'cancelled':
    case 'succeeded':
    case 'failed':
    case 'retrying':
    case 'failed-terminal':
      return value
    case 'waiting_external':
    case 'waiting-external':
      return 'waiting-external'
    case 'failed_terminal':
      return 'failed-terminal'
    default:
      return undefined
  }
}

const decodeOperation = (
  value: unknown,
): Effect.Effect<TerminationOperation, TerminationPersistenceError> => {
  const row = object(value)
  if (row === undefined)
    return Effect.fail(persistence('termination.operation.decode', 'invalid row'))
  const id = text(row, 'operationId')
  const organizationId = text(row, 'organizationId')
  const actorId = text(row, 'actorId')
  const action = text(row, 'action')
  const resourceType = text(row, 'resourceType')
  const resourceId = text(row, 'resourceId')
  const policy = decodePolicy(row.cancellationPolicy)
  const revision = integer(row, 'operationRevision')
  const state = normalizeOperationState(row.operationState)
  if (
    id === undefined ||
    organizationId === undefined ||
    actorId === undefined ||
    action === undefined ||
    resourceType === undefined ||
    resourceId === undefined ||
    policy === undefined ||
    revision === undefined ||
    revision < 1 ||
    state === undefined
  )
    return Effect.fail(persistence('termination.operation.decode', 'invalid operation fields'))
  return Effect.succeed({
    id,
    organizationId,
    actorId,
    action,
    resourceType,
    resourceId,
    cancellationPolicy: policy,
    revision,
    state,
  })
}

const decodeFacts = (
  value: unknown,
): Effect.Effect<OperationCancellationFacts, TerminationPersistenceError> => {
  const row = object(value)
  if (row === undefined) return Effect.fail(persistence('termination.facts.decode', 'invalid row'))
  const organizationId = text(row, 'organizationId')
  const operationId = text(row, 'operationId')
  const resourceType = text(row, 'resourceType')
  const resourceId = text(row, 'resourceId')
  const resourceOperationDoName = text(row, 'resourceOperationDoName')
  const workflowBinding = text(row, 'workflowBinding')
  const workflowType = text(row, 'workflowType')
  const workflowInstanceId = text(row, 'workflowInstanceId')
  const policy = decodePolicy(row.cancellationPolicy)
  const phase = decodePhase(row.phase)
  const activeStepName = text(row, 'activeStepName')
  const activeStepOrdinal = integer(row, 'activeStepOrdinal')
  const revision = integer(row, 'factsRevision')
  if (
    organizationId === undefined ||
    operationId === undefined ||
    resourceType === undefined ||
    resourceId === undefined ||
    resourceOperationDoName === undefined ||
    workflowBinding === undefined ||
    workflowType === undefined ||
    workflowInstanceId !== operationId ||
    policy === undefined ||
    phase === undefined ||
    (activeStepName === undefined) !== (activeStepOrdinal === undefined) ||
    (activeStepOrdinal !== undefined && activeStepOrdinal < 0) ||
    revision === undefined ||
    revision < 1
  )
    return Effect.fail(persistence('termination.facts.decode', 'invalid cancellation facts'))
  return Effect.succeed({
    organizationId,
    operationId,
    resourceType,
    resourceId,
    resourceOperationDoName,
    workflowBinding,
    workflowType,
    workflowInstanceId,
    policy,
    phase,
    ...(activeStepName === undefined || activeStepOrdinal === undefined
      ? {}
      : { activeStepName, activeStepOrdinal }),
    revision,
  })
}

const decodeCancellationRequest = (
  value: unknown,
  disposition: 'created' | 'adopted',
): Effect.Effect<CancellationRequest, TerminationPersistenceError> =>
  Effect.gen(function* () {
    const row = object(value)
    if (row === undefined)
      return yield* Effect.fail(
        persistence('termination.cancellation.decode', 'invalid request row'),
      )
    const operation = yield* decodeOperation(row)
    const facts = yield* decodeFacts(row)
    const fingerprint = text(row, 'cancellationFingerprint')
    const state = text(row, 'cancellationState')
    const doSignalled = booleanInteger(row, 'resourceOperationSignalled')
    const workflowSignalled = booleanInteger(row, 'workflowSignalled')
    if (
      fingerprint === undefined ||
      !sha256(fingerprint) ||
      (state !== 'requested' &&
        state !== 'delivery-pending' &&
        state !== 'signalled' &&
        state !== 'cancelled' &&
        state !== 'rejected') ||
      doSignalled === undefined ||
      workflowSignalled === undefined ||
      facts.organizationId !== operation.organizationId ||
      facts.operationId !== operation.id
    )
      return yield* Effect.fail(
        persistence('termination.cancellation.decode', 'invalid request fields'),
      )
    return {
      disposition,
      operation,
      facts,
      signalState:
        state === 'cancelled'
          ? 'cancelled'
          : doSignalled && workflowSignalled && state === 'signalled'
            ? 'delivered'
            : 'pending-delivery',
    }
  })

const decodeStart = (
  value: unknown,
): Effect.Effect<TerminationWorkflowStart, TerminationPersistenceError> => {
  const row = object(value)
  if (row === undefined)
    return Effect.fail(persistence('termination.workflow-start.decode', 'invalid row'))
  const id = text(row, 'startRecordId')
  const organizationId = text(row, 'organizationId')
  const operationId = text(row, 'operationId')
  const workflowType = text(row, 'workflowType')
  const workflowInstanceId = text(row, 'workflowInstanceId')
  const paramsFingerprint = text(row, 'paramsFingerprint')
  const state = text(row, 'startState')
  const attempts = integer(row, 'startAttempts')
  if (
    id === undefined ||
    organizationId === undefined ||
    operationId === undefined ||
    workflowType === undefined ||
    workflowInstanceId !== operationId ||
    paramsFingerprint === undefined ||
    !sha256(paramsFingerprint) ||
    (state !== 'pending' && state !== 'started' && state !== 'adopted') ||
    attempts === undefined ||
    attempts < 0
  )
    return Effect.fail(persistence('termination.workflow-start.decode', 'invalid start record'))
  return Effect.succeed({
    id,
    organizationId,
    operationId,
    workflowType,
    workflowInstanceId,
    paramsFingerprint,
    state,
    attempts,
    lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null,
  })
}

const factsSelect = `SELECT organization_id AS organizationId, operation_id AS operationId,
 resource_type AS resourceType, resource_id AS resourceId,
 resource_operation_do_name AS resourceOperationDoName, workflow_binding AS workflowBinding,
 workflow_type AS workflowType, workflow_instance_id AS workflowInstanceId,
 cancellation_policy AS cancellationPolicy, phase, revision AS factsRevision
 , active_step_name AS activeStepName, active_step_ordinal AS activeStepOrdinal
 FROM operation_cancellation_facts`

const operationFactsSelect = `SELECT operation.id AS operationId,
 operation.organization_id AS organizationId, operation.actor_id AS actorId, operation.type AS action,
 operation.resource_type AS resourceType, operation.resource_id AS resourceId,
 operation.revision AS operationRevision, operation.status AS operationState,
 facts.cancellation_policy AS cancellationPolicy,
 facts.resource_operation_do_name AS resourceOperationDoName, facts.workflow_binding AS workflowBinding,
 facts.workflow_type AS workflowType, facts.workflow_instance_id AS workflowInstanceId,
 facts.phase, facts.revision AS factsRevision,
 facts.active_step_name AS activeStepName, facts.active_step_ordinal AS activeStepOrdinal
 FROM operations operation
 JOIN operation_cancellation_facts facts
   ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.id`

const cancellationRequestSelect = `SELECT operation.id AS operationId,
 operation.organization_id AS organizationId, operation.actor_id AS actorId, operation.type AS action,
 operation.resource_type AS resourceType, operation.resource_id AS resourceId,
 operation.revision AS operationRevision, operation.status AS operationState,
 facts.cancellation_policy AS cancellationPolicy,
 facts.resource_operation_do_name AS resourceOperationDoName, facts.workflow_binding AS workflowBinding,
 facts.workflow_type AS workflowType, facts.workflow_instance_id AS workflowInstanceId,
 facts.phase, facts.revision AS factsRevision,
 request.idempotency_key AS cancellationIdempotencyKey,
 request.request_fingerprint AS cancellationFingerprint,
 request.state AS cancellationState,
 request.resource_operation_signalled AS resourceOperationSignalled,
 request.workflow_signalled AS workflowSignalled
 FROM operations operation
 JOIN operation_cancellation_facts facts
   ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.id
 JOIN operation_cancellation_requests request
   ON request.organization_id = operation.organization_id AND request.operation_id = operation.id`

const destructiveAcceptanceSelect = `SELECT lifecycle.operation_id AS operationId,
 lifecycle.organization_id AS organizationId, lifecycle.actor_id AS actorId, lifecycle.action,
 lifecycle.resource_type AS resourceType, lifecycle.resource_id AS resourceId,
 lifecycle.cancellation_policy AS cancellationPolicy, lifecycle.revision AS operationRevision,
 lifecycle.state AS operationState, lifecycle.request_fingerprint AS requestFingerprint,
 facts.resource_operation_do_name AS resourceOperationDoName, facts.workflow_binding AS workflowBinding,
 facts.workflow_type AS factsWorkflowType, facts.workflow_instance_id AS factsWorkflowInstanceId,
 facts.phase, facts.revision AS factsRevision,
 facts.active_step_name AS activeStepName, facts.active_step_ordinal AS activeStepOrdinal,
 start.start_record_id AS startRecordId, start.workflow_type AS startWorkflowType,
 start.workflow_instance_id AS startWorkflowInstanceId, start.params_fingerprint AS paramsFingerprint,
 start.state AS startState, start.attempts AS startAttempts, start.last_error_code AS lastErrorCode,
 (SELECT run.node_id FROM node_lifecycle_runs run
   WHERE run.organization_id = lifecycle.organization_id AND run.operation_id = lifecycle.operation_id) AS nodeId,
 (SELECT run.previous_desired_revision FROM node_lifecycle_runs run
   WHERE run.organization_id = lifecycle.organization_id AND run.operation_id = lifecycle.operation_id) AS previousNodeRevision,
 (SELECT run.desired_revision FROM node_lifecycle_runs run
   WHERE run.organization_id = lifecycle.organization_id AND run.operation_id = lifecycle.operation_id) AS desiredNodeRevision,
 COALESCE(
   (SELECT run.state FROM node_lifecycle_runs run
     WHERE run.organization_id = lifecycle.organization_id AND run.operation_id = lifecycle.operation_id),
   (SELECT run.state FROM organization_deletion_runs run
     WHERE run.organization_id = lifecycle.organization_id AND run.operation_id = lifecycle.operation_id)
 ) AS runState,
 (SELECT run.requested_slug FROM organization_deletion_runs run
   WHERE run.organization_id = lifecycle.organization_id AND run.operation_id = lifecycle.operation_id) AS requestedSlug
 FROM destructive_lifecycle_operations lifecycle
 JOIN operation_cancellation_facts facts
   ON facts.organization_id = lifecycle.organization_id AND facts.operation_id = lifecycle.operation_id
 JOIN termination_workflow_starts start
   ON start.organization_id = lifecycle.organization_id AND start.operation_id = lifecycle.operation_id`

const nodeWorkflow = (action: NodeLifecycleCommand['action']) => {
  switch (action) {
    case 'drain-node':
      return { binding: 'DRAIN_NODE', type: 'DrainNodeWorkflow', policy: 'between-steps' as const }
    case 'leave-drain':
      return {
        binding: 'LEAVE_DRAIN_NODE',
        type: 'LeaveDrainNodeWorkflow',
        policy: 'between-steps' as const,
      }
    case 'rebuild-node':
      return {
        binding: 'REBUILD_NODE',
        type: 'RebuildNodeWorkflow',
        policy: 'before-destructive-step' as const,
      }
    case 'retire-node':
      return {
        binding: 'RETIRE_NODE',
        type: 'RetireNodeWorkflow',
        policy: 'before-destructive-step' as const,
      }
  }
}

const activeHumanNodeActorFence = `EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN identities actor ON actor.id = ?
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = actor.id
  WHERE organization.id = ? AND organization.status = 'active' AND actor.status = 'active'
    AND membership.status = 'active' AND membership.role IN ('owner', 'administrator')
    AND (? IS NULL OR membership.revision = ?)
)`

const activeHumanNodeActorBindings = (command: NodeLifecycleCommand) => {
  const revision = command.actorMembershipRevision ?? null
  return [command.actorId, command.organizationId, revision, revision] as const
}

/**
 * The scheduler path is constrained by its dedicated migration-0025 fences.
 * Every public node lifecycle mutation rechecks active membership in the
 * acceptance transaction so a revocation racing an HTTP request cannot win.
 */
const requireActiveHumanNodeActor = (
  database: LifecycleTerminationD1Database,
  command: NodeLifecycleCommand,
) =>
  command.organizationDeletionOperationId !== undefined
    ? attempt('termination.node.organization-deletion-actor.fence', () =>
        database
          .prepare(`SELECT 1 AS allowed FROM organization_deletion_runs run
          JOIN organizations organization ON organization.id = run.organization_id
          JOIN operations operation
            ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
          WHERE run.organization_id = ? AND run.operation_id = ? AND run.actor_id = ?
            AND organization.status = 'deleting'
            AND operation.type = 'delete-organization'
            AND operation.status IN ('queued', 'running', 'waiting_external')`)
          .bind(command.organizationId, command.organizationDeletionOperationId, command.actorId)
          .first(),
      ).pipe(
        Effect.flatMap((allowed) =>
          allowed === null
            ? Effect.fail(new TerminationAuthorizationError({ code: 'administrator_required' }))
            : Effect.void,
        ),
      )
    : command.policySchedulerRetire === undefined
      ? attempt('termination.node.actor.fence', () =>
          database
            .prepare(`SELECT 1 AS allowed WHERE ${activeHumanNodeActorFence}`)
            .bind(...activeHumanNodeActorBindings(command))
            .first(),
        ).pipe(
          Effect.flatMap((allowed) =>
            allowed === null
              ? Effect.fail(new TerminationAuthorizationError({ code: 'administrator_required' }))
              : Effect.void,
          ),
        )
      : Effect.void

const currentNode = (
  database: LifecycleTerminationD1Database,
  organizationId: string,
  nodeId: string,
) =>
  attempt('termination.node.load', () =>
    database
      .prepare(`SELECT desired_state AS desiredState, desired_revision AS desiredRevision
        FROM nodes WHERE organization_id = ? AND id = ?`)
      .bind(organizationId, nodeId)
      .first(),
  ).pipe(
    Effect.flatMap((value) => {
      const row = object(value)
      const desiredState = row === undefined ? undefined : text(row, 'desiredState')
      const desiredRevision = row === undefined ? undefined : integer(row, 'desiredRevision')
      return desiredState === undefined || desiredRevision === undefined || desiredRevision < 1
        ? failConflict('node_not_found_or_cross_tenant')
        : Effect.succeed({ desiredState, desiredRevision })
    }),
  )

/**
 * The destructive Workflow may run after provider credentials rotate.  This
 * read captures the exact mutable coordinates that the migration-0044 insert
 * trigger rechecks atomically with acceptance.  It deliberately excludes the
 * credential value and records only the envelope identity/revision.
 */
interface NodeLifecycleProviderSnapshot {
  readonly providerAccountId: string
  readonly providerAccountScope: 'platform' | 'organization'
  readonly providerAccountRevision: number
  readonly providerAllocationRevision: number
  readonly providerCredentialReference: string
  readonly providerCredentialRevision: number
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerInstanceId: string
  readonly targetProviderImageId?: string
  readonly targetImageVersion?: string
  readonly targetImageChecksum?: string
}

const loadNodeLifecycleProviderSnapshot = (
  database: LifecycleTerminationD1Database,
  input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly desiredRevision: number
    readonly action: NodeLifecycleCommand['action']
    readonly targetImageId?: string
  },
): Effect.Effect<
  NodeLifecycleProviderSnapshot,
  TerminationConflictError | TerminationPersistenceError
> =>
  Effect.gen(function* () {
    const raw = yield* attempt('termination.node.provider-snapshot.load', () =>
      database
        .prepare(`SELECT account.id AS providerAccountId, account.scope AS providerAccountScope,
          account.revision AS providerAccountRevision, allocation.revision AS providerAllocationRevision,
          account.credential_reference AS providerCredentialReference,
          CASE account.scope WHEN 'organization' THEN tenantEnvelope.revision ELSE platformEnvelope.revision END
            AS providerCredentialRevision,
          node.provider_type AS providerType, node.provider_instance_id AS providerInstanceId,
          target.version AS targetImageVersion, target.checksum AS targetImageChecksum,
          registration.provider_image_id AS targetProviderImageId
          FROM nodes node
          JOIN provider_accounts account
            ON account.id = node.provider_account_id AND account.provider_type = node.provider_type
          JOIN provider_allocations allocation
            ON allocation.organization_id = node.organization_id AND allocation.provider_account_id = account.id
          LEFT JOIN secret_envelopes tenantEnvelope
            ON account.scope = 'organization' AND tenantEnvelope.organization_id = node.organization_id
           AND tenantEnvelope.id = account.credential_reference
           AND tenantEnvelope.scope_type = 'provider-account' AND tenantEnvelope.scope_id = account.id
          LEFT JOIN platform_secret_envelopes platformEnvelope
            ON account.scope = 'platform' AND platformEnvelope.id = account.credential_reference
           AND platformEnvelope.scope_type = 'provider-account' AND platformEnvelope.scope_id = account.id
          LEFT JOIN node_images target ON target.id = ? AND target.status = 'promoted'
          LEFT JOIN node_image_provider_registrations registration
            ON registration.image_id = target.id
           AND registration.provider_account_id = account.id
           AND registration.provider_type = node.provider_type
           AND registration.region = node.region
           AND registration.mode = 'custom-image' AND registration.state = 'registered'
          WHERE node.organization_id = ? AND node.id = ? AND node.desired_revision = ?
            AND node.provider_instance_id IS NOT NULL
            AND account.status = 'active' AND allocation.status = 'active'
            AND (account.scope = 'platform' OR account.organization_id = node.organization_id)
            AND ((account.scope = 'organization' AND tenantEnvelope.revision IS NOT NULL)
              OR (account.scope = 'platform' AND platformEnvelope.revision IS NOT NULL))`)
        .bind(
          input.targetImageId ?? null,
          input.organizationId,
          input.nodeId,
          input.desiredRevision,
        )
        .first(),
    )
    const row = object(raw)
    if (row === undefined) return yield* failConflict('node_provider_binding_unavailable')
    const providerAccountId = text(row, 'providerAccountId')
    const providerAccountScope = text(row, 'providerAccountScope')
    const providerAccountRevision = integer(row, 'providerAccountRevision')
    const providerAllocationRevision = integer(row, 'providerAllocationRevision')
    const providerCredentialReference = text(row, 'providerCredentialReference')
    const providerCredentialRevision = integer(row, 'providerCredentialRevision')
    const providerType = text(row, 'providerType')
    const providerInstanceId = text(row, 'providerInstanceId')
    if (
      providerAccountId === undefined ||
      (providerAccountScope !== 'platform' && providerAccountScope !== 'organization') ||
      providerAccountRevision === undefined ||
      providerAccountRevision < 1 ||
      providerAllocationRevision === undefined ||
      providerAllocationRevision < 1 ||
      providerCredentialReference === undefined ||
      providerCredentialRevision === undefined ||
      providerCredentialRevision < 1 ||
      (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
      providerInstanceId === undefined
    )
      return yield* failConflict('node_provider_binding_unavailable')
    if (input.action === 'rebuild-node') {
      const targetProviderImageId = text(row, 'targetProviderImageId')
      const targetImageVersion = text(row, 'targetImageVersion')
      const targetImageChecksum = text(row, 'targetImageChecksum')
      if (
        targetProviderImageId === undefined ||
        targetImageVersion === undefined ||
        targetImageChecksum === undefined
      )
        return yield* failConflict('node_rebuild_image_binding_unavailable')
      return {
        providerAccountId,
        providerAccountScope,
        providerAccountRevision,
        providerAllocationRevision,
        providerCredentialReference,
        providerCredentialRevision,
        providerType,
        providerInstanceId,
        targetProviderImageId,
        targetImageVersion,
        targetImageChecksum,
      }
    }
    return {
      providerAccountId,
      providerAccountScope,
      providerAccountRevision,
      providerAllocationRevision,
      providerCredentialReference,
      providerCredentialRevision,
      providerType,
      providerInstanceId,
    }
  })

const activeDeployments = (
  database: LifecycleTerminationD1Database,
  organizationId: string,
  nodeId: string,
) =>
  attempt('termination.node.active-deployments', () =>
    database
      .prepare(`SELECT id AS deploymentId, server_id AS serverId, desired_revision AS desiredRevision
        FROM deployments WHERE organization_id = ? AND node_id = ? AND observed_state <> 'deleted'
        ORDER BY id`)
      .bind(organizationId, nodeId)
      .all(),
  ).pipe(
    Effect.flatMap((result) =>
      Effect.forEach(result.results, (value) => {
        const row = object(value)
        const deploymentId = row === undefined ? undefined : text(row, 'deploymentId')
        const serverId = row === undefined ? undefined : text(row, 'serverId')
        const desiredRevision = row === undefined ? undefined : integer(row, 'desiredRevision')
        return deploymentId === undefined ||
          serverId === undefined ||
          desiredRevision === undefined ||
          desiredRevision < 1
          ? Effect.fail(
              persistence('termination.node.active-deployments', 'invalid deployment row'),
            )
          : Effect.succeed({ deploymentId, serverId, desiredRevision })
      }),
    ),
  )

const decodeDestructiveAcceptance = (value: unknown) =>
  Effect.gen(function* () {
    const row = object(value)
    if (row === undefined)
      return yield* Effect.fail(
        persistence('termination.acceptance.decode', 'invalid acceptance row'),
      )
    const operation = yield* decodeOperation(row)
    const facts = yield* decodeFacts({
      ...row,
      workflowType: row.factsWorkflowType,
      workflowInstanceId: row.factsWorkflowInstanceId,
    })
    const workflowStart = yield* decodeStart({
      ...row,
      workflowType: row.startWorkflowType,
      workflowInstanceId: row.startWorkflowInstanceId,
    })
    if (
      facts.organizationId !== operation.organizationId ||
      facts.operationId !== operation.id ||
      workflowStart.organizationId !== operation.organizationId ||
      workflowStart.operationId !== operation.id ||
      workflowStart.paramsFingerprint !== text(row, 'requestFingerprint')
    )
      return yield* Effect.fail(
        persistence('termination.acceptance.decode', 'acceptance identity mismatch'),
      )
    return { operation, facts, workflowStart, row }
  })

const nodeAcceptanceQuery = destructiveAcceptanceSelect
const organizationAcceptanceQuery = destructiveAcceptanceSelect

const loadCancellationAuditContext = (
  database: LifecycleTerminationD1Database,
  organizationId: string,
  operationId: string,
) =>
  Effect.gen(function* () {
    const raw = yield* attempt('termination.cancellation.audit-context', () =>
      database
        .prepare(`SELECT request.actor_id AS actorId,
          operation.correlation_id AS correlationId,
          operation.resource_type AS resourceType, operation.resource_id AS resourceId,
          request.audit_request_context_json AS auditRequestContext
        FROM operation_cancellation_requests request JOIN operations operation
          ON operation.organization_id = request.organization_id AND operation.id = request.operation_id
        WHERE request.organization_id = ? AND request.operation_id = ?`)
        .bind(organizationId, operationId)
        .first(),
    )
    const row = object(raw)
    const actorId = row === undefined ? undefined : text(row, 'actorId')
    const correlationId = row === undefined ? undefined : text(row, 'correlationId')
    const resourceType = row === undefined ? undefined : text(row, 'resourceType')
    const resourceId = row === undefined ? undefined : text(row, 'resourceId')
    const encoded = row === undefined ? undefined : text(row, 'auditRequestContext')
    if (
      actorId === undefined ||
      correlationId === undefined ||
      resourceType === undefined ||
      resourceId === undefined ||
      encoded === undefined
    )
      return yield* persistence(
        'termination.cancellation.audit-context',
        'cancellation audit provenance is unavailable',
      )
    const request = yield* Effect.try({
      try: () => JSON.parse(encoded) as unknown,
      catch: (cause) => persistence('termination.cancellation.audit-context', cause),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(AuditRequestContextValue, { onExcessProperty: 'error' })(
          value,
        ).pipe(
          Effect.mapError((cause) => persistence('termination.cancellation.audit-context', cause)),
        ),
      ),
    )
    return { actorId, correlationId, resourceType, resourceId, request }
  })

const decodeNodeAcceptance = (value: unknown, disposition: 'created' | 'adopted') =>
  decodeDestructiveAcceptance(value).pipe(
    Effect.flatMap(({ operation, workflowStart, row }) => {
      const nodeId = text(row, 'nodeId')
      const previousNodeRevision = integer(row, 'previousNodeRevision')
      const desiredNodeRevision = integer(row, 'desiredNodeRevision')
      const state = text(row, 'runState')
      if (
        nodeId === undefined ||
        previousNodeRevision === undefined ||
        desiredNodeRevision === undefined ||
        previousNodeRevision < 1 ||
        desiredNodeRevision !== previousNodeRevision + 1 ||
        ![
          'accepted',
          'draining',
          'drained',
          'drained-forced',
          'rebuilding',
          'awaiting-agent',
          'retiring',
          'awaiting-provider-confirmation',
          'cancel-scheduled',
          'blocked',
          'cancelled',
          'completed',
        ].includes(state ?? '')
      )
        return Effect.fail(persistence('termination.node-acceptance.decode', 'invalid run row'))
      return Effect.succeed({
        disposition,
        operation,
        nodeId,
        previousNodeRevision,
        desiredNodeRevision,
        state: state as NodeLifecycleAcceptance['state'],
        workflowStart,
      })
    }),
  )

const decodeOrganizationAcceptance = (value: unknown, disposition: 'created' | 'adopted') =>
  decodeDestructiveAcceptance(value).pipe(
    Effect.flatMap(({ operation, workflowStart, row }) => {
      const requestedSlug = text(row, 'requestedSlug')
      const state = text(row, 'runState')
      if (
        requestedSlug === undefined ||
        ![
          'accepted',
          'inventorying',
          'draining',
          'retiring',
          'revoking',
          'cleaning-networking',
          'blocked',
          'ready-to-tombstone',
          'tombstoned',
          'cancelled',
        ].includes(state ?? '')
      )
        return Effect.fail(
          persistence('termination.organization-acceptance.decode', 'invalid deletion run'),
        )
      return Effect.succeed({
        disposition,
        operation,
        requestedSlug,
        state: state as OrganizationDeletionAcceptance['state'],
        workflowStart,
      })
    }),
  )

export const makeTerminationD1Repository = (
  database: LifecycleTerminationD1Database,
  options: Partial<LifecycleTerminationD1Options> = {},
): TerminationRepositoryShape => {
  const configured = { ...defaults, ...options }

  const loadNodeAcceptance = (
    organizationId: string,
    idempotencyKey: string,
    disposition: 'created' | 'adopted',
  ): Effect.Effect<NodeLifecycleAcceptance | null, TerminationPersistenceError> =>
    Effect.flatMap(
      attempt('termination.node-acceptance.load', () =>
        database
          .prepare(
            `${nodeAcceptanceQuery} WHERE lifecycle.organization_id = ? AND lifecycle.idempotency_key = ?`,
          )
          .bind(organizationId, idempotencyKey)
          .first(),
      ),
      (row) => (row === null ? Effect.succeed(null) : decodeNodeAcceptance(row, disposition)),
    )

  const loadOrganizationAcceptance = (
    organizationId: string,
    idempotencyKey: string,
    disposition: 'created' | 'adopted',
  ): Effect.Effect<OrganizationDeletionAcceptance | null, TerminationPersistenceError> =>
    Effect.flatMap(
      attempt('termination.organization-acceptance.load', () =>
        database
          .prepare(
            `${organizationAcceptanceQuery} WHERE lifecycle.organization_id = ? AND lifecycle.idempotency_key = ?`,
          )
          .bind(organizationId, idempotencyKey)
          .first(),
      ),
      (row) =>
        row === null ? Effect.succeed(null) : decodeOrganizationAcceptance(row, disposition),
    )

  const acceptNodeLifecycle: TerminationRepositoryShape['acceptNodeLifecycle'] = (
    command,
    fingerprint,
  ) =>
    Effect.gen(function* () {
      if (!sha256(fingerprint)) return yield* failConflict('invalid_request_fingerprint')
      yield* requireActiveHumanNodeActor(database, command)
      const auditRequestContextJson = JSON.stringify({
        ...configured.auditRequestContext,
        correlationId: command.correlationId,
      })
      if (auditRequestContextJson.length < 2 || auditRequestContextJson.length > 8192)
        return yield* failConflict('node_lifecycle_audit_provenance_invalid')
      const prior = yield* loadNodeAcceptance(
        command.organizationId,
        command.idempotencyKey,
        'adopted',
      )
      if (prior !== null) {
        const stored = yield* attempt('termination.node-acceptance.fingerprint', () =>
          database
            .prepare(`SELECT lifecycle.request_fingerprint AS fingerprint,
              run.audit_request_context_json AS auditRequestContext
              FROM destructive_lifecycle_operations lifecycle
              JOIN node_lifecycle_runs run
                ON run.organization_id = lifecycle.organization_id
               AND run.operation_id = lifecycle.operation_id
              WHERE lifecycle.organization_id = ? AND lifecycle.operation_id = ?`)
            .bind(command.organizationId, prior.operation.id)
            .first(),
        )
        if (
          object(stored) === undefined ||
          text(object(stored)!, 'fingerprint') !== fingerprint ||
          text(object(stored)!, 'auditRequestContext') !== auditRequestContextJson
        )
          return yield* failConflict('idempotency_key_reused')
        return prior
      }
      const node = yield* currentNode(database, command.organizationId, command.nodeId)
      if (
        (command.action === 'leave-drain' && node.desiredState !== 'draining') ||
        (command.action !== 'leave-drain' && node.desiredState === 'deleted')
      )
        return yield* failConflict('invalid_node_lifecycle_state')
      if (node.desiredRevision !== command.expectedNodeRevision)
        return yield* failConflict('node_revision_conflict')

      const providerSnapshot =
        command.action === 'rebuild-node' || command.action === 'retire-node'
          ? yield* loadNodeLifecycleProviderSnapshot(database, {
              organizationId: command.organizationId,
              nodeId: command.nodeId,
              desiredRevision: command.expectedNodeRevision,
              action: command.action,
              ...(command.targetImageId === undefined
                ? {}
                : { targetImageId: command.targetImageId }),
            })
          : undefined

      const affected = yield* activeDeployments(database, command.organizationId, command.nodeId)
      const operationId = configured.operationId()
      // This terminal child records only the completed acceptance fact. The
      // parent lifecycle operation remains queued until Workflow execution.
      const acceptanceOperationId = `${operationId}-acceptance`
      const now = configured.now()
      const auditEventId = configured.auditEventId()
      const outboxEventId = configured.outboxEventId()
      const startRecordId = configured.workflowStartRecordId(operationId)
      const workflow = nodeWorkflow(command.action)
      const desiredState = command.action === 'leave-drain' ? 'ready' : 'draining'
      const initialState = command.action === 'leave-drain' ? 'accepted' : 'draining'
      const resourceOperationDoName = canonicalResourceOperationDoName(
        command.organizationId,
        'node',
        command.nodeId,
      )
      const updateNode = database
        .prepare(`UPDATE nodes SET desired_state = ?, desired_revision = ?,
          pending_lifecycle_operation_id = ?, updated_at = ?
          WHERE organization_id = ? AND id = ? AND desired_revision = ?
            AND desired_state <> 'deleted'
            AND NOT EXISTS (
              SELECT 1 FROM operations active
              WHERE active.organization_id = ? AND active.resource_type = 'node'
                AND active.resource_id = ?
                AND active.status IN ('requested', 'queued', 'running', 'waiting_external', 'cancelling', 'retrying')
            )
            AND (? = 1 OR ${activeHumanNodeActorFence})`)
        .bind(
          desiredState,
          command.expectedNodeRevision + 1,
          operationId,
          now,
          command.organizationId,
          command.nodeId,
          command.expectedNodeRevision,
          command.organizationId,
          command.nodeId,
          command.policySchedulerRetire === undefined &&
            command.organizationDeletionOperationId === undefined
            ? 0
            : 1,
          ...activeHumanNodeActorBindings(command),
        )
      const operationInsert = database
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          SELECT ?, ?, ?, 'node', ?, ?, 'queued', 0, ?, ?, 1, ?, ?
          FROM nodes WHERE organization_id = ? AND id = ?
            AND pending_lifecycle_operation_id = ? AND desired_revision = ?`)
        .bind(
          operationId,
          command.organizationId,
          command.action,
          command.nodeId,
          command.actorId,
          command.idempotencyKey,
          command.correlationId,
          now,
          now,
          command.organizationId,
          command.nodeId,
          operationId,
          command.expectedNodeRevision + 1,
        )
      const acceptanceOperationInsert = database
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          SELECT ?, ?, ?, 'node', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?
          FROM operations lifecycle
          WHERE lifecycle.organization_id = ? AND lifecycle.id = ?
            AND lifecycle.type = ? AND lifecycle.status = 'queued'`)
        .bind(
          acceptanceOperationId,
          command.organizationId,
          `node.${command.action}.accepted`,
          command.nodeId,
          command.actorId,
          `audit-acceptance-${operationId}`,
          command.correlationId,
          now,
          now,
          command.organizationId,
          operationId,
          command.action,
        )
      const lifecycleInsert = database
        .prepare(`INSERT INTO destructive_lifecycle_operations
          (organization_id, operation_id, action, resource_type, resource_id, actor_id,
           idempotency_key, request_fingerprint, cancellation_policy,
           organization_deletion_operation_id, policy_reconciliation_action_id,
           state, revision, accepted_at, updated_at)
          VALUES (?, ?, ?, 'node', ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          command.action,
          command.nodeId,
          command.actorId,
          command.idempotencyKey,
          fingerprint,
          workflow.policy,
          command.organizationDeletionOperationId ?? null,
          command.policySchedulerRetire?.actionId ?? null,
          now,
          now,
        )
      const factsInsert = database
        .prepare(`INSERT INTO operation_cancellation_facts
          (organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
           workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
           active_step_ordinal, active_step_name, revision, registered_at, updated_at)
          VALUES (?, ?, 'node', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          command.nodeId,
          resourceOperationDoName,
          workflow.binding,
          workflow.type,
          operationId,
          workflow.policy,
          workflow.policy === 'between-steps' ? 'between-steps' : 'before-destructive-step',
          now,
          now,
        )
      const startInsert = database
        .prepare(`INSERT INTO termination_workflow_starts
          (organization_id, operation_id, start_record_id, workflow_type, workflow_instance_id,
           params_fingerprint, state, attempts, last_error_code, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          startRecordId,
          workflow.type,
          operationId,
          fingerprint,
          now,
          now,
        )
      const runInsert = database
        .prepare(`INSERT INTO node_lifecycle_runs
          (organization_id, operation_id, node_id, action, previous_desired_state,
           previous_desired_revision, desired_revision, force_requested, backup_policy,
           target_image_id, state, provider_retirement_state, billing_state, cancellation_date,
           billing_stops_at, provider_request_reference, blocked_reason, created_at, updated_at,
           audit_request_context_json, provider_account_id, provider_account_scope,
           provider_account_revision, provider_allocation_revision, provider_credential_reference,
           provider_credential_revision, provider_type_snapshot, provider_instance_id_snapshot,
           target_provider_image_id, target_image_version_snapshot, target_image_checksum_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not-started', 'not-applicable',
            NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          command.nodeId,
          command.action,
          node.desiredState,
          command.expectedNodeRevision,
          command.expectedNodeRevision + 1,
          command.force ? 1 : 0,
          command.backupPolicy,
          command.targetImageId ?? null,
          initialState,
          now,
          now,
          auditRequestContextJson,
          providerSnapshot?.providerAccountId ?? null,
          providerSnapshot?.providerAccountScope ?? null,
          providerSnapshot?.providerAccountRevision ?? null,
          providerSnapshot?.providerAllocationRevision ?? null,
          providerSnapshot?.providerCredentialReference ?? null,
          providerSnapshot?.providerCredentialRevision ?? null,
          providerSnapshot?.providerType ?? null,
          providerSnapshot?.providerInstanceId ?? null,
          providerSnapshot?.targetProviderImageId ?? null,
          providerSnapshot?.targetImageVersion ?? null,
          providerSnapshot?.targetImageChecksum ?? null,
        )
      const affectedInserts = affected.map((deployment) =>
        database
          .prepare(`INSERT INTO node_lifecycle_affected_servers
            (organization_id, operation_id, server_id, deployment_id, desired_revision, state, resolved_at)
            VALUES (?, ?, ?, ?, ?, 'pending', NULL)`)
          .bind(
            command.organizationId,
            operationId,
            deployment.serverId,
            deployment.deploymentId,
            deployment.desiredRevision,
          ),
      )
      const nodeAcceptanceAfter = {
        operationId,
        previousNodeRevision: command.expectedNodeRevision,
        desiredNodeRevision: command.expectedNodeRevision + 1,
        affectedDeployments: affected.length,
        backupPolicy: command.backupPolicy,
        workflowStartRecordId: startRecordId,
        ...(providerSnapshot === undefined
          ? {}
          : {
              providerBinding: {
                providerAccountId: providerSnapshot.providerAccountId,
                providerAccountRevision: providerSnapshot.providerAccountRevision,
                providerAllocationRevision: providerSnapshot.providerAllocationRevision,
                providerCredentialRevision: providerSnapshot.providerCredentialRevision,
                providerType: providerSnapshot.providerType,
                providerInstanceId: providerSnapshot.providerInstanceId,
                ...(providerSnapshot.targetProviderImageId === undefined
                  ? {}
                  : { targetProviderImageId: providerSnapshot.targetProviderImageId }),
              },
            }),
      }
      const auditStage = yield* stageTerminationAudit(database, {
        eventId: auditEventId,
        organizationId: command.organizationId,
        operationId: acceptanceOperationId,
        actorId: command.actorId,
        actorType: command.policySchedulerRetire === undefined ? 'human' : 'system',
        correlationId: command.correlationId,
        action: `node.${command.action}.accepted`,
        targetType: 'node',
        targetId: command.nodeId,
        before: {
          desiredState: node.desiredState,
          desiredRevision: command.expectedNodeRevision,
        },
        after: nodeAcceptanceAfter,
        now,
        request: configured.auditRequestContext,
      })
      const auditInsert = database
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, acceptance.organization_id, acceptance.actor_id, ?, 'node', acceptance.resource_id,
            'succeeded', acceptance.correlation_id, ?, ?
          FROM operations acceptance
          JOIN operations lifecycle
            ON lifecycle.organization_id = acceptance.organization_id
          WHERE acceptance.organization_id = ? AND acceptance.id = ?
            AND acceptance.type = ? AND acceptance.status = 'succeeded'
            AND lifecycle.id = ? AND lifecycle.status = 'queued'`)
        .bind(
          auditEventId,
          `node.${command.action}.accepted`,
          auditStage.summaryJson,
          now,
          command.organizationId,
          acceptanceOperationId,
          `node.${command.action}.accepted`,
          operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'destructive-lifecycle.workflow-start.requested', 'operation', ?, ?,
            'pending', 0, ?, ?)`)
        .bind(
          outboxEventId,
          command.organizationId,
          operationId,
          JSON.stringify({
            operationId,
            workflowStartRecordId: startRecordId,
            workflowType: workflow.type,
            workflowBinding: workflow.binding,
            workflowInstanceId: operationId,
          }),
          now,
          now,
        )
      const receiptInsert = database
        .prepare(`INSERT INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'node-accepted', ?, ?, ?, ?)`)
        .bind(command.organizationId, operationId, startRecordId, auditEventId, outboxEventId, now)

      const result = yield* Effect.result(
        attempt('termination.node-acceptance.atomic', () =>
          database.batch([
            updateNode,
            operationInsert,
            acceptanceOperationInsert,
            lifecycleInsert,
            factsInsert,
            startInsert,
            runInsert,
            ...affectedInserts,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (result._tag === 'Failure') {
        const replay = yield* loadNodeAcceptance(
          command.organizationId,
          command.idempotencyKey,
          'adopted',
        )
        if (replay !== null) return replay
        return yield* result.failure
      }
      const created = yield* loadNodeAcceptance(
        command.organizationId,
        command.idempotencyKey,
        'created',
      )
      return created === null
        ? yield* Effect.fail(
            persistence('termination.node-acceptance.atomic', 'accepted row missing'),
          )
        : created
    })

  const acceptOrganizationDeletion: TerminationRepositoryShape['acceptOrganizationDeletion'] = (
    command,
    fingerprint,
  ) =>
    Effect.gen(function* () {
      if (!sha256(fingerprint)) return yield* failConflict('invalid_request_fingerprint')
      const auditRequestContextJson = JSON.stringify({
        ...configured.auditRequestContext,
        correlationId: command.correlationId,
      })
      if (auditRequestContextJson.length < 2 || auditRequestContextJson.length > 8192)
        return yield* failConflict('organization_deletion_audit_provenance_invalid')
      const prior = yield* loadOrganizationAcceptance(
        command.organizationId,
        command.idempotencyKey,
        'adopted',
      )
      if (prior !== null) {
        const stored = yield* attempt('termination.organization-acceptance.fingerprint', () =>
          database
            .prepare(`SELECT lifecycle.request_fingerprint AS fingerprint,
              run.audit_request_context_json AS auditRequestContext
              FROM destructive_lifecycle_operations lifecycle
              JOIN organization_deletion_runs run
                ON run.organization_id = lifecycle.organization_id
               AND run.operation_id = lifecycle.operation_id
              WHERE lifecycle.organization_id = ? AND lifecycle.operation_id = ?`)
            .bind(command.organizationId, prior.operation.id)
            .first(),
        )
        if (
          object(stored) === undefined ||
          text(object(stored)!, 'fingerprint') !== fingerprint ||
          text(object(stored)!, 'auditRequestContext') !== auditRequestContextJson
        )
          return yield* failConflict('idempotency_key_reused')
        return prior
      }
      const organization = yield* attempt('termination.organization.load', () =>
        database
          .prepare(`SELECT slug, status, revision FROM organizations WHERE id = ?`)
          .bind(command.organizationId)
          .first(),
      )
      const organizationRow = object(organization)
      const slug = organizationRow === undefined ? undefined : text(organizationRow, 'slug')
      const status = organizationRow === undefined ? undefined : text(organizationRow, 'status')
      const revision =
        organizationRow === undefined ? undefined : integer(organizationRow, 'revision')
      if (
        slug !== command.typedSlug ||
        status !== 'active' ||
        revision !== command.expectedOrganizationRevision
      )
        return yield* failConflict('organization_revision_or_confirmation_conflict')

      const operationId = configured.operationId()
      const acceptanceOperationId = `${operationId}-acceptance`
      const now = configured.now()
      const auditEventId = configured.auditEventId()
      const outboxEventId = configured.outboxEventId()
      const startRecordId = configured.workflowStartRecordId(operationId)
      const resourceOperationDoName = canonicalResourceOperationDoName(
        command.organizationId,
        'organization',
        command.organizationId,
      )
      const updateOrganization = database
        .prepare(`UPDATE organizations SET status = 'deleting', revision = revision + 1
          WHERE id = ? AND slug = ? AND status = 'active' AND revision = ?`)
        .bind(command.organizationId, command.typedSlug, command.expectedOrganizationRevision)
      const operationInsert = database
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          SELECT ?, id, 'delete-organization', 'organization', id, ?, 'queued', 0, ?, ?, 1, ?, ?
          FROM organizations WHERE id = ? AND status = 'deleting' AND revision = ?`)
        .bind(
          operationId,
          command.actorId,
          command.idempotencyKey,
          command.correlationId,
          now,
          now,
          command.organizationId,
          command.expectedOrganizationRevision + 1,
        )
      const acceptanceOperationInsert = database
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          SELECT ?, id, 'delete-organization-acceptance', 'organization', id, ?,
            'succeeded', 100, ?, ?, 1, ?, ?
          FROM organizations WHERE id = ? AND status = 'deleting' AND revision = ?`)
        .bind(
          acceptanceOperationId,
          command.actorId,
          `${command.idempotencyKey}-acceptance`,
          command.correlationId,
          now,
          now,
          command.organizationId,
          command.expectedOrganizationRevision + 1,
        )
      const lifecycleInsert = database
        .prepare(`INSERT INTO destructive_lifecycle_operations
          (organization_id, operation_id, action, resource_type, resource_id, actor_id,
           idempotency_key, request_fingerprint, cancellation_policy,
           organization_deletion_operation_id, state, revision, accepted_at, updated_at)
          VALUES (?, ?, 'delete-organization', 'organization', ?, ?, ?, ?,
            'before-destructive-step', NULL, 'queued', 1, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          command.organizationId,
          command.actorId,
          command.idempotencyKey,
          fingerprint,
          now,
          now,
        )
      const factsInsert = database
        .prepare(`INSERT INTO operation_cancellation_facts
          (organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
           workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
           active_step_ordinal, active_step_name, revision, registered_at, updated_at)
          VALUES (?, ?, 'organization', ?, ?, 'DELETE_ORGANIZATION', 'DeleteOrganizationWorkflow', ?,
            'before-destructive-step', 'before-destructive-step', NULL, NULL, 1, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          command.organizationId,
          resourceOperationDoName,
          operationId,
          now,
          now,
        )
      const startInsert = database
        .prepare(`INSERT INTO termination_workflow_starts
          (organization_id, operation_id, start_record_id, workflow_type, workflow_instance_id,
           params_fingerprint, state, attempts, last_error_code, created_at, updated_at)
          VALUES (?, ?, ?, 'DeleteOrganizationWorkflow', ?, ?, 'pending', 0, NULL, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          startRecordId,
          operationId,
          fingerprint,
          now,
          now,
        )
      const runInsert = database
        .prepare(`INSERT INTO organization_deletion_runs
          (organization_id, operation_id, actor_id, requested_slug, previous_revision,
           deleting_revision, backup_policy, state, blocked_reason, created_at, updated_at,
           audit_request_context_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, ?, ?)`)
        .bind(
          command.organizationId,
          operationId,
          command.actorId,
          command.typedSlug,
          command.expectedOrganizationRevision,
          command.expectedOrganizationRevision + 1,
          command.backupPolicy,
          now,
          now,
          auditRequestContextJson,
        )
      const auditStage = yield* stageTerminationAudit(database, {
        eventId: auditEventId,
        organizationId: command.organizationId,
        operationId: acceptanceOperationId,
        actorId: command.actorId,
        actorType: 'human',
        correlationId: command.correlationId,
        action: 'organization.delete.accepted',
        targetType: 'organization',
        targetId: command.organizationId,
        before: { status: 'active', revision: command.expectedOrganizationRevision },
        after: {
          operationId,
          backupPolicy: command.backupPolicy,
          workflowStartRecordId: startRecordId,
        },
        now,
        request: configured.auditRequestContext,
      })
      const auditInsert = database
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, 'organization.delete.accepted', 'organization', ?, 'succeeded', ?, ?, ?)`)
        .bind(
          auditEventId,
          command.organizationId,
          command.actorId,
          command.organizationId,
          command.correlationId,
          auditStage.summaryJson,
          now,
        )
      const outboxInsert = database
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'destructive-lifecycle.workflow-start.requested', 'operation', ?, ?,
            'pending', 0, ?, ?)`)
        .bind(
          outboxEventId,
          command.organizationId,
          operationId,
          JSON.stringify({
            operationId,
            workflowStartRecordId: startRecordId,
            workflowType: 'DeleteOrganizationWorkflow',
            workflowBinding: 'DELETE_ORGANIZATION',
            workflowInstanceId: operationId,
          }),
          now,
          now,
        )
      const receiptInsert = database
        .prepare(`INSERT INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'organization-accepted', ?, ?, ?, ?)`)
        .bind(command.organizationId, operationId, startRecordId, auditEventId, outboxEventId, now)
      const result = yield* Effect.result(
        attempt('termination.organization-acceptance.atomic', () =>
          database.batch([
            updateOrganization,
            operationInsert,
            acceptanceOperationInsert,
            lifecycleInsert,
            factsInsert,
            startInsert,
            runInsert,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (result._tag === 'Failure') {
        const replay = yield* loadOrganizationAcceptance(
          command.organizationId,
          command.idempotencyKey,
          'adopted',
        )
        if (replay !== null) {
          const provenance = yield* attempt('termination.organization-acceptance.provenance', () =>
            database
              .prepare(`SELECT audit_request_context_json AS auditRequestContext
              FROM organization_deletion_runs WHERE organization_id = ? AND operation_id = ?`)
              .bind(command.organizationId, replay.operation.id)
              .first(),
          )
          if (
            object(provenance) !== undefined &&
            text(object(provenance)!, 'auditRequestContext') === auditRequestContextJson
          )
            return replay
          return yield* failConflict('idempotency_key_reused')
        }
        return yield* result.failure
      }
      const created = yield* loadOrganizationAcceptance(
        command.organizationId,
        command.idempotencyKey,
        'created',
      )
      return created === null
        ? yield* Effect.fail(
            persistence('termination.organization-acceptance.atomic', 'accepted row missing'),
          )
        : created
    })

  const loadCancellationByIdempotency = (
    organizationId: string,
    idempotencyKey: string,
    disposition: 'created' | 'adopted',
  ): Effect.Effect<CancellationRequest | null, TerminationPersistenceError> =>
    Effect.flatMap(
      attempt('termination.cancellation.load-by-idempotency', () =>
        database
          .prepare(
            `${cancellationRequestSelect} WHERE request.organization_id = ? AND request.idempotency_key = ?`,
          )
          .bind(organizationId, idempotencyKey)
          .first(),
      ),
      (row) => (row === null ? Effect.succeed(null) : decodeCancellationRequest(row, disposition)),
    )

  const loadCancellationByOperation = (
    organizationId: string,
    operationId: string,
    disposition: 'created' | 'adopted',
  ): Effect.Effect<CancellationRequest | null, TerminationPersistenceError> =>
    Effect.flatMap(
      attempt('termination.cancellation.load-by-operation', () =>
        database
          .prepare(
            `${cancellationRequestSelect} WHERE request.organization_id = ? AND request.operation_id = ?`,
          )
          .bind(organizationId, operationId)
          .first(),
      ),
      (row) => (row === null ? Effect.succeed(null) : decodeCancellationRequest(row, disposition)),
    )

  const requestCancellation: TerminationRepositoryShape['requestCancellation'] = (
    command,
    fingerprint,
  ) =>
    Effect.gen(function* () {
      if (!sha256(fingerprint)) return yield* failConflict('invalid_request_fingerprint')
      const auditRequestContextJson = JSON.stringify({
        ...configured.auditRequestContext,
        correlationId: command.correlationId,
      })
      if (auditRequestContextJson.length < 2 || auditRequestContextJson.length > 8192)
        return yield* failConflict('cancellation_audit_provenance_invalid')
      const replay = yield* loadCancellationByIdempotency(
        command.organizationId,
        command.idempotencyKey,
        'adopted',
      )
      if (replay !== null) {
        const stored = yield* attempt('termination.cancellation.replay-fingerprint', () =>
          database
            .prepare(`SELECT request_fingerprint AS fingerprint,
              audit_request_context_json AS auditRequestContext
              FROM operation_cancellation_requests
              WHERE organization_id = ? AND idempotency_key = ?`)
            .bind(command.organizationId, command.idempotencyKey)
            .first(),
        )
        if (
          object(stored) === undefined ||
          text(object(stored)!, 'fingerprint') !== fingerprint ||
          text(object(stored)!, 'auditRequestContext') !== auditRequestContextJson
        )
          return yield* failConflict('idempotency_key_reused')
        return replay
      }
      const existingOperationRequest = yield* loadCancellationByOperation(
        command.organizationId,
        command.operationId,
        'adopted',
      )
      if (existingOperationRequest !== null)
        return yield* failConflict('cancellation_already_requested')
      const context = yield* attempt('termination.cancellation.context', () =>
        database
          .prepare(
            `${operationFactsSelect} WHERE operation.organization_id = ? AND operation.id = ?`,
          )
          .bind(command.organizationId, command.operationId)
          .first(),
      )
      if (context === null) return yield* failConflict('operation_not_cancellable')
      const operation = yield* decodeOperation(context)
      const facts = yield* decodeFacts(context)
      if (
        operation.revision !== command.expectedOperationRevision ||
        facts.workflowBinding === 'unbound' ||
        facts.workflowInstanceId !== operation.id ||
        facts.policy === 'not-cancellable' ||
        (facts.policy === 'before-destructive-step' && facts.phase !== 'before-destructive-step') ||
        (facts.policy === 'between-steps' && facts.phase !== 'between-steps')
      )
        return yield* failConflict('operation_cancellation_not_allowed')
      const now = configured.now()
      const auditEventId = configured.auditEventId()
      const outboxEventId = configured.outboxEventId()
      const auditOperationId = `${auditEventId}-operation`
      const updateOperation = database
        .prepare(`UPDATE operations SET status = 'cancelling', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND revision = ?
            AND status IN ('queued', 'running', 'waiting_external', 'retrying')
            AND EXISTS (
              SELECT 1 FROM operation_cancellation_facts facts
              WHERE facts.organization_id = operations.organization_id
                AND facts.operation_id = operations.id
                AND facts.workflow_binding <> 'unbound'
                AND facts.workflow_instance_id = operations.id
                AND ((facts.cancellation_policy = 'before-destructive-step'
                      AND facts.phase = 'before-destructive-step')
                  OR (facts.cancellation_policy = 'between-steps'
                      AND facts.phase = 'between-steps'))
            )`)
        .bind(now, command.organizationId, command.operationId, command.expectedOperationRevision)
      const updateDestructive = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'cancelling', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
        .bind(now, command.organizationId, command.operationId)
      const updateBackupJob = database
        .prepare(`UPDATE backup_jobs
          SET state = 'cancelling', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('reserved', 'running', 'waiting_external')
            AND EXISTS (
              SELECT 1 FROM operations operation
              WHERE operation.organization_id = backup_jobs.organization_id
                AND operation.id = backup_jobs.operation_id
                AND operation.status = 'cancelling' AND operation.revision = ?
            )`)
        .bind(
          now,
          command.organizationId,
          command.operationId,
          command.expectedOperationRevision + 1,
        )
      const requestInsert = database
        .prepare(`INSERT INTO operation_cancellation_requests
          (organization_id, operation_id, idempotency_key, request_fingerprint, actor_id,
           expected_operation_revision, requested_revision, policy, state,
           resource_operation_signalled, workflow_signalled, requested_at, delivered_at,
           audit_request_context_json)
          SELECT facts.organization_id, facts.operation_id, ?, ?, ?, ?, ?, facts.cancellation_policy,
            'requested', 0, 0, ?, NULL, ?
          FROM operation_cancellation_facts facts
          JOIN operations operation
            ON operation.organization_id = facts.organization_id AND operation.id = facts.operation_id
          WHERE facts.organization_id = ? AND facts.operation_id = ?
            AND operation.status = 'cancelling' AND operation.revision = ?`)
        .bind(
          command.idempotencyKey,
          fingerprint,
          command.actorId,
          command.expectedOperationRevision,
          command.expectedOperationRevision + 1,
          now,
          auditRequestContextJson,
          command.organizationId,
          command.operationId,
          command.expectedOperationRevision + 1,
        )
      const auditOperationInsert = database
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'operation-cancellation-requested', ?, ?, ?, 'succeeded', 100,
            ?, ?, 1, ?, ?)`)
        .bind(
          auditOperationId,
          command.organizationId,
          operation.resourceType,
          operation.resourceId,
          command.actorId,
          auditOperationId,
          command.correlationId,
          now,
          now,
        )
      const auditStage = yield* stageTerminationAudit(database, {
        eventId: auditEventId,
        organizationId: command.organizationId,
        operationId: auditOperationId,
        actorId: command.actorId,
        actorType: 'human',
        correlationId: command.correlationId,
        action: 'operation.cancellation.requested',
        targetType: operation.resourceType,
        targetId: operation.resourceId,
        before: { status: operation.state, revision: operation.revision },
        after: { status: 'cancelling', operationId: command.operationId },
        now,
        request: configured.auditRequestContext,
      })
      const auditInsert = database
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, ?, 'operation.cancellation.requested',
            operation.resource_type, operation.resource_id, 'succeeded', ?, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?
            AND operation.status = 'cancelling' AND operation.revision = ?`)
        .bind(
          auditEventId,
          command.actorId,
          command.correlationId,
          auditStage.summaryJson,
          now,
          command.organizationId,
          command.operationId,
          command.expectedOperationRevision + 1,
        )
      const outboxInsert = database
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          SELECT ?, operation.organization_id, 'operation.cancellation.requested', 'operation', operation.id,
            ?, 'pending', 0, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?
            AND operation.status = 'cancelling' AND operation.revision = ?`)
        .bind(
          outboxEventId,
          JSON.stringify({ operationId: command.operationId }),
          now,
          now,
          command.organizationId,
          command.operationId,
          command.expectedOperationRevision + 1,
        )
      const receiptInsert = database
        .prepare(`INSERT INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'cancellation-requested', NULL, ?, ?, ?)`)
        .bind(command.organizationId, command.operationId, auditEventId, outboxEventId, now)
      const committed = yield* Effect.result(
        attempt('termination.cancellation.atomic', () =>
          database.batch([
            updateOperation,
            updateDestructive,
            updateBackupJob,
            requestInsert,
            auditOperationInsert,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* loadCancellationByIdempotency(
          command.organizationId,
          command.idempotencyKey,
          'adopted',
        )
        if (adopted !== null) return adopted
        return yield* committed.failure
      }
      const created = yield* loadCancellationByIdempotency(
        command.organizationId,
        command.idempotencyKey,
        'created',
      )
      return created === null
        ? yield* Effect.fail(persistence('termination.cancellation.atomic', 'request missing'))
        : created
    })

  const recordCancellationSignal: TerminationRepositoryShape['recordCancellationSignal'] = (
    input,
    receipt,
  ) =>
    Effect.gen(function* () {
      const loadExact = () =>
        Effect.flatMap(
          attempt('termination.cancellation.signal.load', () =>
            database
              .prepare(
                `${cancellationRequestSelect} WHERE request.organization_id = ? AND request.operation_id = ?`,
              )
              .bind(input.organizationId, input.operationId)
              .first(),
          ),
          (row) =>
            row === null
              ? Effect.fail(persistence('termination.cancellation.signal.load', 'request missing'))
              : Effect.gen(function* () {
                  const request = yield* decodeCancellationRequest(row, 'adopted')
                  const raw = object(row)
                  const state = raw === undefined ? undefined : text(raw, 'cancellationState')
                  const resourceOperationSignalled =
                    raw === undefined
                      ? undefined
                      : booleanInteger(raw, 'resourceOperationSignalled')
                  const workflowSignalled =
                    raw === undefined ? undefined : booleanInteger(raw, 'workflowSignalled')
                  if (
                    state === undefined ||
                    resourceOperationSignalled === undefined ||
                    workflowSignalled === undefined ||
                    !cancellationInputMatches(request.facts, input)
                  )
                    return yield* Effect.fail(
                      persistence(
                        'termination.cancellation.signal.load',
                        'exact signal target mismatch',
                      ),
                    )
                  return { request, state, resourceOperationSignalled, workflowSignalled }
                }),
        )

      const evidenceExists = (
        receiptKey: 'cancellation-signalled' | 'cancellation-delivery-pending',
        auditEventId: string,
        outboxEventId: string,
      ) =>
        Effect.flatMap(
          attempt('termination.cancellation.signal.evidence', () =>
            database
              .prepare(`SELECT receipt.receipt_key AS receiptKey
                FROM destructive_lifecycle_atomic_receipts receipt
                JOIN audit_events audit ON audit.id = receipt.audit_event_id
                JOIN outbox event
                  ON event.organization_id = receipt.organization_id AND event.id = receipt.outbox_event_id
                WHERE receipt.organization_id = ? AND receipt.operation_id = ?
                  AND receipt.receipt_key = ? AND receipt.audit_event_id = ?
                  AND receipt.outbox_event_id = ?`)
              .bind(
                input.organizationId,
                input.operationId,
                receiptKey,
                auditEventId,
                outboxEventId,
              )
              .first(),
          ),
          (row) =>
            row === null
              ? Effect.fail(
                  persistence(
                    'termination.cancellation.signal.evidence',
                    'atomic evidence missing',
                  ),
                )
              : Effect.void,
        )

      const before = yield* loadExact()
      if (before.state === 'cancelled') return before.request

      const resourceOperationSignalled =
        before.resourceOperationSignalled || receipt.resourceOperationSignalled
      const workflowSignalled = before.workflowSignalled || receipt.workflowSignalled
      const targetState =
        resourceOperationSignalled && workflowSignalled
          ? ('signalled' as const)
          : ('delivery-pending' as const)
      const receiptKey =
        targetState === 'signalled'
          ? ('cancellation-signalled' as const)
          : ('cancellation-delivery-pending' as const)
      // These evidence ids are deliberately deterministic: a lost response adopts the exact same
      // audit/outbox/receipt triple instead of minting duplicate evidence on every retry.
      const auditEventId = `termination-cancellation-signal:${input.organizationId}:${input.operationId}:${targetState}:audit`
      const outboxEventId = `termination-cancellation-signal:${input.organizationId}:${input.operationId}:${targetState}:outbox`
      const now = configured.now()
      const audit = yield* loadCancellationAuditContext(
        database,
        input.organizationId,
        input.operationId,
      )
      const auditOperationId = `${auditEventId}-operation`
      const auditOperationInsert = database
        .prepare(`INSERT OR IGNORE INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'operation-cancellation-signal-recorded', ?, ?, ?, 'succeeded', 100,
            ?, ?, 1, ?, ?)`)
        .bind(
          auditOperationId,
          input.organizationId,
          audit.resourceType,
          audit.resourceId,
          audit.actorId,
          auditOperationId,
          audit.correlationId,
          now,
          now,
        )
      const auditStage = yield* stageTerminationAudit(database, {
        eventId: auditEventId,
        organizationId: input.organizationId,
        operationId: auditOperationId,
        actorId: audit.actorId,
        actorType: 'human',
        correlationId: audit.correlationId,
        action: 'operation.cancellation.signal-recorded',
        targetType: audit.resourceType,
        targetId: audit.resourceId,
        before: {
          state: before.state,
          resourceOperationSignalled: before.resourceOperationSignalled,
          workflowSignalled: before.workflowSignalled,
        },
        after: { state: targetState, resourceOperationSignalled, workflowSignalled },
        now,
        request: audit.request,
      })
      const requiresMutation =
        before.resourceOperationSignalled !== resourceOperationSignalled ||
        before.workflowSignalled !== workflowSignalled ||
        before.state !== targetState
      const update = database
        .prepare(`UPDATE operation_cancellation_requests
          SET resource_operation_signalled = ?, workflow_signalled = ?, state = ?,
              delivered_at = CASE WHEN ? = 'signalled' THEN ? ELSE NULL END
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('requested', 'delivery-pending', 'signalled')
            AND resource_operation_signalled = ? AND workflow_signalled = ?
            AND EXISTS (
              SELECT 1 FROM operation_cancellation_facts facts
              WHERE facts.organization_id = operation_cancellation_requests.organization_id
                AND facts.operation_id = operation_cancellation_requests.operation_id
                AND facts.resource_type = ? AND facts.resource_id = ?
                AND facts.resource_operation_do_name = ?
                AND facts.workflow_binding = ? AND facts.workflow_type = ?
                AND facts.workflow_instance_id = ?
            )`)
        .bind(
          resourceOperationSignalled ? 1 : 0,
          workflowSignalled ? 1 : 0,
          targetState,
          targetState,
          now,
          input.organizationId,
          input.operationId,
          before.resourceOperationSignalled ? 1 : 0,
          before.workflowSignalled ? 1 : 0,
          input.resourceType,
          input.resourceId,
          input.resourceOperationDoName,
          input.workflowBinding,
          input.workflowType,
          input.workflowInstanceId,
        )
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, ?, 'operation.cancellation.signal-recorded',
            operation.resource_type, operation.resource_id, 'succeeded', ?, ?, ?
          FROM operations operation
          JOIN operation_cancellation_requests request
            ON request.organization_id = operation.organization_id AND request.operation_id = operation.id
          JOIN operation_cancellation_facts facts
            ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.id
          WHERE operation.organization_id = ? AND operation.id = ? AND request.state = ?
            AND facts.resource_type = ? AND facts.resource_id = ?
            AND facts.resource_operation_do_name = ? AND facts.workflow_binding = ?
            AND facts.workflow_type = ? AND facts.workflow_instance_id = ?`)
        .bind(
          auditEventId,
          audit.actorId,
          audit.correlationId,
          auditStage.summaryJson,
          now,
          input.organizationId,
          input.operationId,
          targetState,
          input.resourceType,
          input.resourceId,
          input.resourceOperationDoName,
          input.workflowBinding,
          input.workflowType,
          input.workflowInstanceId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          SELECT ?, operation.organization_id, 'operation.cancellation.signal-recorded',
            'operation', operation.id, ?, 'pending', 0, ?, ?
          FROM operations operation
          JOIN operation_cancellation_requests request
            ON request.organization_id = operation.organization_id AND request.operation_id = operation.id
          JOIN operation_cancellation_facts facts
            ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.id
          WHERE operation.organization_id = ? AND operation.id = ? AND request.state = ?
            AND facts.resource_type = ? AND facts.resource_id = ?
            AND facts.resource_operation_do_name = ? AND facts.workflow_binding = ?
            AND facts.workflow_type = ? AND facts.workflow_instance_id = ?`)
        .bind(
          outboxEventId,
          JSON.stringify({ operationId: input.operationId, state: targetState }),
          now,
          now,
          input.organizationId,
          input.operationId,
          targetState,
          input.resourceType,
          input.resourceId,
          input.resourceOperationDoName,
          input.workflowBinding,
          input.workflowType,
          input.workflowInstanceId,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          SELECT ?, ?, ?, NULL, ?, ?, ?
          FROM operation_cancellation_requests request
          WHERE request.organization_id = ? AND request.operation_id = ? AND request.state = ?`)
        .bind(
          input.organizationId,
          input.operationId,
          receiptKey,
          auditEventId,
          outboxEventId,
          now,
          input.organizationId,
          input.operationId,
          targetState,
        )
      const batchResult = yield* Effect.result(
        attempt('termination.cancellation.record-signal', () =>
          database.batch([
            update,
            auditOperationInsert,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (batchResult._tag === 'Success') {
        const results = batchResult.success
        if (
          results.length !== 6 ||
          results.some(
            (result: LifecycleTerminationD1Result) =>
              result.success !== true ||
              result.meta?.changes === undefined ||
              result.meta.changes < 0 ||
              result.meta.changes > 1,
          ) ||
          (requiresMutation && results[0]?.meta?.changes !== 1)
        )
          return yield* Effect.fail(
            persistence('termination.cancellation.record-signal', 'unexpected write result'),
          )
      }
      // Whether the network response was lost or not, adopt only a committed exact D1 state. This
      // lets callers retry a pending delivery but can never report transient transport success.
      const durable = yield* loadExact()
      if (durable.state === 'cancelled') return durable.request
      if (
        durable.resourceOperationSignalled !== resourceOperationSignalled ||
        durable.workflowSignalled !== workflowSignalled ||
        durable.state !== targetState
      )
        return yield* Effect.fail(
          persistence(
            'termination.cancellation.record-signal',
            'durable signal state was not adopted',
          ),
        )
      yield* evidenceExists(receiptKey, auditEventId, outboxEventId)
      return durable.request
    })

  return {
    acceptNodeLifecycle,
    acceptOrganizationDeletion,
    requestCancellation,
    recordCancellationSignal,
  }
}

const factsEqual = (left: OperationCancellationFacts, right: OperationCancellationFacts): boolean =>
  left.organizationId === right.organizationId &&
  left.operationId === right.operationId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.resourceOperationDoName === right.resourceOperationDoName &&
  left.workflowBinding === right.workflowBinding &&
  left.workflowType === right.workflowType &&
  left.workflowInstanceId === right.workflowInstanceId &&
  left.policy === right.policy &&
  left.phase === right.phase &&
  left.activeStepName === right.activeStepName &&
  left.activeStepOrdinal === right.activeStepOrdinal

const cancellationInputMatches = (
  facts: OperationCancellationFacts,
  input: CancellationSignalInput,
): boolean =>
  facts.organizationId === input.organizationId &&
  facts.operationId === input.operationId &&
  facts.resourceType === input.resourceType &&
  facts.resourceId === input.resourceId &&
  facts.resourceOperationDoName === input.resourceOperationDoName &&
  facts.workflowBinding === input.workflowBinding &&
  facts.workflowType === input.workflowType &&
  facts.workflowInstanceId === input.workflowInstanceId

export const makeOperationCancellationFactsD1Repository = (
  database: LifecycleTerminationD1Database,
  options: Partial<Pick<LifecycleTerminationD1Options, 'now'>> = {},
): OperationCancellationFactsRepositoryShape => {
  const now = options.now ?? defaults.now
  const get: OperationCancellationFactsRepositoryShape['get'] = (input) =>
    Effect.flatMap(
      attempt('termination.facts.get', () =>
        database
          .prepare(`${factsSelect} WHERE organization_id = ? AND operation_id = ?`)
          .bind(input.organizationId, input.operationId)
          .first(),
      ),
      (row) => (row === null ? Effect.succeed(null) : decodeFacts(row)),
    )

  const register: OperationCancellationFactsRepositoryShape['register'] = (facts) =>
    Effect.gen(function* () {
      if (facts.workflowInstanceId !== facts.operationId || facts.revision !== 1)
        return yield* failConflict('invalid_cancellation_facts_identity')
      const existing = yield* get({
        organizationId: facts.organizationId,
        operationId: facts.operationId,
      })
      if (existing !== null)
        return factsEqual(existing, facts)
          ? existing
          : yield* failConflict('cancellation_facts_already_registered')
      const timestamp = now()
      const insert = database
        .prepare(`INSERT INTO operation_cancellation_facts
          (organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
           workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
           active_step_ordinal, active_step_name, revision, registered_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?
          FROM operations operation
          WHERE operation.organization_id = ? AND operation.id = ?
            AND operation.resource_type = ? AND operation.resource_id = ?
            AND operation.status IN ('queued', 'running', 'waiting_external', 'retrying')`)
        .bind(
          facts.organizationId,
          facts.operationId,
          facts.resourceType,
          facts.resourceId,
          facts.resourceOperationDoName,
          facts.workflowBinding,
          facts.workflowType,
          facts.workflowInstanceId,
          facts.policy,
          facts.phase,
          timestamp,
          timestamp,
          facts.organizationId,
          facts.operationId,
          facts.resourceType,
          facts.resourceId,
        )
      const outcome = yield* Effect.result(
        attempt('termination.facts.register', () => database.batch([insert])),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* get({
          organizationId: facts.organizationId,
          operationId: facts.operationId,
        })
        if (adopted !== null)
          return factsEqual(adopted, facts)
            ? adopted
            : yield* failConflict('cancellation_facts_already_registered')
        return yield* outcome.failure
      }
      const registered = yield* get({
        organizationId: facts.organizationId,
        operationId: facts.operationId,
      })
      return registered === null
        ? yield* failConflict('cancellation_facts_operation_not_eligible')
        : registered
    })

  const advancePhase: OperationCancellationFactsRepositoryShape['advancePhase'] = (input) =>
    Effect.gen(function* () {
      const timestamp = input.now
      const update = database
        .prepare(`UPDATE operation_cancellation_facts
          SET phase = ?, active_step_name = ?, active_step_ordinal = ?, revision = revision + 1,
              updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND revision = ?
            AND NOT EXISTS (
              SELECT 1 FROM operations operation
              WHERE operation.organization_id = operation_cancellation_facts.organization_id
                AND operation.id = operation_cancellation_facts.operation_id
                AND operation.status IN ('cancelling', 'cancelled', 'succeeded', 'failed', 'failed_terminal')
            )`)
        .bind(
          input.phase,
          input.activeStepName ?? null,
          input.activeStepOrdinal ?? null,
          timestamp,
          input.organizationId,
          input.operationId,
          input.expectedRevision,
        )
      yield* attempt('termination.facts.advance-phase', () => database.batch([update]))
      const updated = yield* get({
        organizationId: input.organizationId,
        operationId: input.operationId,
      })
      if (
        updated === null ||
        updated.revision !== input.expectedRevision + 1 ||
        updated.phase !== input.phase
      )
        return yield* failConflict('cancellation_facts_revision_conflict')
      return updated
    })

  return { get, register, advancePhase }
}

export const makeTerminationWorkflowStartD1Repository = (
  database: LifecycleTerminationD1Database,
): TerminationWorkflowStartRepositoryShape => {
  const loadExact: TerminationWorkflowStartRepositoryShape['loadExact'] = (input) =>
    Effect.gen(function* () {
      const row = yield* attempt('termination.workflow-start.load', () =>
        database
          .prepare(`SELECT organization_id AS organizationId, operation_id AS operationId,
            start_record_id AS startRecordId, workflow_type AS workflowType,
            workflow_instance_id AS workflowInstanceId, params_fingerprint AS paramsFingerprint,
            state AS startState, attempts AS startAttempts, last_error_code AS lastErrorCode
            FROM termination_workflow_starts
            WHERE organization_id = ? AND operation_id = ? AND start_record_id = ?`)
          .bind(input.organizationId, input.operationId, input.startRecordId)
          .first(),
      )
      if (row === null) return yield* failConflict('workflow_start_not_found_or_cross_tenant')
      return yield* decodeStart(row)
    })
  const markStartedOrAdopted: TerminationWorkflowStartRepositoryShape['markStartedOrAdopted'] = (
    input,
  ) =>
    Effect.gen(function* () {
      const update = database
        .prepare(`UPDATE termination_workflow_starts
          SET state = ?, attempts = attempts + 1, last_error_code = NULL, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND start_record_id = ?
            AND state IN ('pending', 'started', 'adopted')`)
        .bind(input.state, input.now, input.organizationId, input.operationId, input.startRecordId)
      yield* attempt('termination.workflow-start.mark', () => database.batch([update]))
      const record = yield* loadExact(input)
      if (record.state !== input.state) return yield* failConflict('workflow_start_state_conflict')
    })
  const recordStartFailure: TerminationWorkflowStartRepositoryShape['recordStartFailure'] = (
    input,
  ) =>
    Effect.gen(function* () {
      const update = database
        .prepare(`UPDATE termination_workflow_starts
          SET attempts = attempts + 1, last_error_code = ?, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND start_record_id = ?
            AND state = 'pending'`)
        .bind(
          input.code.slice(0, 128),
          input.now,
          input.organizationId,
          input.operationId,
          input.startRecordId,
        )
      yield* attempt('termination.workflow-start.record-failure', () => database.batch([update]))
      yield* loadExact(input)
    })
  return { loadExact, markStartedOrAdopted, recordStartFailure }
}

const stepReceiptState = (
  row: unknown,
): {
  readonly stepName: string
  readonly destructive: boolean
  readonly state: 'running' | 'completed' | 'cancelled'
  readonly lease: WorkflowStepLease
  readonly factsRevision: number
} | null => {
  const record = object(row)
  const stepName = record === undefined ? undefined : text(record, 'stepName')
  const destructive = record === undefined ? undefined : booleanInteger(record, 'destructive')
  const state = record === undefined ? undefined : text(record, 'state')
  const claimId = record === undefined ? undefined : text(record, 'claimId')
  const attempt = record === undefined ? undefined : integer(record, 'claimAttempt')
  const factsRevision = record === undefined ? undefined : integer(record, 'factsRevision')
  const expiresAt = record === undefined ? undefined : text(record, 'leaseExpiresAt')
  if (
    stepName === undefined ||
    destructive === undefined ||
    claimId === undefined ||
    claimId.length < 16 ||
    attempt === undefined ||
    attempt < 1 ||
    factsRevision === undefined ||
    factsRevision < 1 ||
    (state !== 'running' && state !== 'completed' && state !== 'cancelled') ||
    (state === 'running' && expiresAt === undefined) ||
    (state !== 'running' && expiresAt !== undefined)
  )
    return null
  return {
    stepName,
    destructive,
    state,
    lease: { claimId, attempt, expiresAt: expiresAt ?? '' },
    factsRevision,
  }
}

const stepEffectReceipt = (row: unknown): WorkflowStepEffectReceipt | null => {
  if (row === null) return null
  const record = object(row)
  const effectId = record === undefined ? undefined : text(record, 'effectId')
  const outcomeFingerprint = record === undefined ? undefined : text(record, 'outcomeFingerprint')
  return effectId === undefined || outcomeFingerprint === undefined || !sha256(outcomeFingerprint)
    ? null
    : { effectId, outcomeFingerprint }
}

const validClaimId = (value: string): boolean => value.length >= 16 && value.length <= 256
const validEffectId = (value: string): boolean => value.length >= 1 && value.length <= 512
const isExpired = (lease: WorkflowStepLease, now: string): boolean => lease.expiresAt <= now
const validNewLease = (claimId: string, expiresAt: string, now: string): boolean =>
  validClaimId(claimId) && expiresAt > now
const sameLease = (left: WorkflowStepLease, right: WorkflowStepLease): boolean =>
  left.claimId === right.claimId &&
  left.attempt === right.attempt &&
  left.expiresAt === right.expiresAt
const sameLeaseIdentity = (left: WorkflowStepLease, right: WorkflowStepLease): boolean =>
  left.claimId === right.claimId && left.attempt === right.attempt
const sameEffectReceipt = (
  left: WorkflowStepEffectReceipt,
  right: WorkflowStepEffectReceipt,
): boolean =>
  left.effectId === right.effectId && left.outcomeFingerprint === right.outcomeFingerprint

const mayClaimStep = (facts: OperationCancellationFacts): boolean =>
  (facts.policy === 'before-destructive-step' && facts.phase === 'before-destructive-step') ||
  (facts.policy === 'between-steps' && facts.phase === 'between-steps')

/**
 * D1 implementation of the signed workflow-step fence. The workflow executor asks this repository
 * immediately before a side effect; cancellation and step claims are mutually exclusive through
 * the migration trigger as well as these revision predicates.
 */
export const makeWorkflowStepD1Repository = (
  database: LifecycleTerminationD1Database,
): WorkflowStepRepositoryShape => {
  const loadContext = (organizationId: string, operationId: string) =>
    Effect.flatMap(
      attempt('termination.step.context', () =>
        database
          .prepare(
            `${operationFactsSelect} WHERE operation.organization_id = ? AND operation.id = ?`,
          )
          .bind(organizationId, operationId)
          .first(),
      ),
      (row) =>
        row === null
          ? Effect.fail(persistence('termination.step.context', 'operation facts missing'))
          : Effect.gen(function* () {
              const operation = yield* decodeOperation(row)
              const facts = yield* decodeFacts(row)
              return { operation, facts }
            }),
    )

  const loadStep = (organizationId: string, operationId: string, ordinal: number) =>
    Effect.flatMap(
      attempt('termination.step.load', () =>
        database
          .prepare(`SELECT step_name AS stepName, destructive, state, claim_id AS claimId,
            claim_attempt AS claimAttempt, facts_revision AS factsRevision,
            lease_expires_at AS leaseExpiresAt
            FROM operation_cancellation_step_receipts
            WHERE organization_id = ? AND operation_id = ? AND ordinal = ?`)
          .bind(organizationId, operationId, ordinal)
          .first(),
      ),
      (row) => {
        if (row === null) return Effect.succeed(null)
        const decoded = stepReceiptState(row)
        return decoded === null
          ? Effect.fail(persistence('termination.step.load', 'invalid step receipt'))
          : Effect.succeed(decoded)
      },
    )

  const loadEffectReceipt = (organizationId: string, operationId: string, ordinal: number) =>
    Effect.flatMap(
      attempt('termination.step.effect-receipt.load', () =>
        database
          .prepare(`SELECT effect_id AS effectId, outcome_fingerprint AS outcomeFingerprint
            FROM operation_cancellation_step_effect_receipts
            WHERE organization_id = ? AND operation_id = ? AND ordinal = ?`)
          .bind(organizationId, operationId, ordinal)
          .first(),
      ),
      (row) => {
        if (row === null) return Effect.succeed(null)
        const decoded = stepEffectReceipt(row)
        return decoded === null
          ? Effect.fail(
              persistence('termination.step.effect-receipt.load', 'invalid effect receipt'),
            )
          : Effect.succeed(decoded)
      },
    )

  const completionReceiptExists = (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly ordinal: number
    readonly lease: WorkflowStepLease
    readonly factsRevision: number
  }) =>
    Effect.flatMap(
      attempt('termination.step.completion-receipt.load', () =>
        database
          .prepare(`SELECT 1 AS present FROM operation_cancellation_step_completion_receipts
            WHERE organization_id = ? AND operation_id = ? AND ordinal = ?
              AND claim_id = ? AND claim_attempt = ? AND facts_revision = ?`)
          .bind(
            input.organizationId,
            input.operationId,
            input.ordinal,
            input.lease.claimId,
            input.lease.attempt,
            input.factsRevision,
          )
          .first(),
      ),
      (row) => Effect.succeed(row !== null),
    )

  const cancellationExists = (organizationId: string, operationId: string) =>
    Effect.flatMap(
      attempt('termination.step.cancellation', () =>
        database
          .prepare(`SELECT state FROM operation_cancellation_requests
            WHERE organization_id = ? AND operation_id = ?`)
          .bind(organizationId, operationId)
          .first(),
      ),
      (row) => Effect.succeed(row !== null),
    )

  const claimStep: WorkflowStepRepositoryShape['claimStep'] = (input) =>
    Effect.gen(function* () {
      const context = yield* loadContext(input.organizationId, input.operationId)
      if (
        context.facts.workflowType !== input.workflowType ||
        context.facts.workflowInstanceId !== input.workflowInstanceId
      )
        return yield* failConflict('workflow_step_binding_mismatch')
      const existing = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      if (existing !== null) {
        if (existing.stepName !== input.stepName || existing.destructive !== input.destructive)
          return yield* failConflict('workflow_step_identity_conflict')
        if (existing.state === 'completed')
          return {
            disposition: 'already-completed' as const,
            operation: context.operation,
            facts: context.facts,
          }
        if (existing.state === 'cancelled')
          return {
            disposition: 'cancelled' as const,
            operation: context.operation,
            facts: context.facts,
          }
        const effectReceipt = yield* loadEffectReceipt(
          input.organizationId,
          input.operationId,
          input.ordinal,
        )
        if (effectReceipt !== null)
          return {
            disposition: 'effect-adopted' as const,
            operation: context.operation,
            facts: context.facts,
            lease: existing.lease,
            effectReceipt,
          }
        return {
          disposition: isExpired(existing.lease, input.now)
            ? ('reconciliation-required' as const)
            : ('in-progress' as const),
          operation: context.operation,
          facts: context.facts,
          lease: existing.lease,
        }
      }
      if (
        context.operation.state === 'cancelling' ||
        context.operation.state === 'cancelled' ||
        (yield* cancellationExists(input.organizationId, input.operationId))
      )
        return {
          disposition: 'cancelled' as const,
          operation: context.operation,
          facts: context.facts,
        }
      if (!mayClaimStep(context.facts))
        return yield* failConflict('workflow_step_not_cancellable_phase')
      if (!validNewLease(input.claimId, input.leaseExpiresAt, input.now))
        return yield* failConflict('workflow_step_invalid_lease')
      const phase = input.destructive ? 'destructive-step-running' : 'step-running'
      const factsUpdate = database
        .prepare(`UPDATE operation_cancellation_facts
          SET phase = ?, active_step_name = ?, active_step_ordinal = ?, revision = revision + 1,
              updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND revision = ?
            AND phase IN ('before-destructive-step', 'between-steps')
            AND NOT EXISTS (
              SELECT 1 FROM operation_cancellation_requests request
              WHERE request.organization_id = operation_cancellation_facts.organization_id
                AND request.operation_id = operation_cancellation_facts.operation_id
            )`)
        .bind(
          phase,
          input.stepName,
          input.ordinal,
          input.now,
          input.organizationId,
          input.operationId,
          context.facts.revision,
        )
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ?
            AND status IN ('queued', 'running', 'waiting_external', 'retrying')
            AND NOT EXISTS (
              SELECT 1 FROM operation_cancellation_requests request
              WHERE request.organization_id = operations.organization_id AND request.operation_id = operations.id
            )`)
        .bind(input.now, input.organizationId, input.operationId)
      const receiptInsert = database
        .prepare(`INSERT INTO operation_cancellation_step_receipts
          (organization_id, operation_id, ordinal, step_name, destructive, state, claim_id,
           claim_attempt, facts_revision, lease_expires_at, started_at, completed_at)
          VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, NULL)`)
        .bind(
          input.organizationId,
          input.operationId,
          input.ordinal,
          input.stepName,
          input.destructive ? 1 : 0,
          input.claimId,
          context.facts.revision + 1,
          input.leaseExpiresAt,
          input.now,
        )
      const result = yield* Effect.result(
        attempt('termination.step.claim', () =>
          // The receipt insert trigger observes the preceding exact phase/status writes. If a
          // revision/cancellation race loses, it aborts the entire batch rather than leaving a
          // running claim that an executor might mistake for permission to mutate a provider.
          database.batch([factsUpdate, operationUpdate, receiptInsert]),
        ),
      )
      if (result._tag === 'Failure') {
        const after = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
        if (
          after !== null &&
          after.stepName === input.stepName &&
          after.destructive === input.destructive
        ) {
          const effectReceipt = yield* loadEffectReceipt(
            input.organizationId,
            input.operationId,
            input.ordinal,
          )
          if (after.state === 'completed')
            return {
              disposition: 'already-completed' as const,
              operation: context.operation,
              facts: context.facts,
            }
          if (after.state === 'cancelled')
            return {
              disposition: 'cancelled' as const,
              operation: context.operation,
              facts: context.facts,
            }
          if (effectReceipt !== null)
            return {
              disposition: 'effect-adopted' as const,
              operation: context.operation,
              facts: context.facts,
              lease: after.lease,
              effectReceipt,
            }
          return {
            disposition: sameLease(after.lease, {
              claimId: input.claimId,
              attempt: 1,
              expiresAt: input.leaseExpiresAt,
            })
              ? ('execute' as const)
              : isExpired(after.lease, input.now)
                ? ('reconciliation-required' as const)
                : ('in-progress' as const),
            operation: context.operation,
            facts: context.facts,
            lease: after.lease,
          }
        }
        if (yield* cancellationExists(input.organizationId, input.operationId))
          return {
            disposition: 'cancelled' as const,
            operation: context.operation,
            facts: context.facts,
          }
        return yield* result.failure
      }
      const claimed = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      const after = yield* loadContext(input.organizationId, input.operationId)
      const expectedLease: WorkflowStepLease = {
        claimId: input.claimId,
        attempt: 1,
        expiresAt: input.leaseExpiresAt,
      }
      if (
        claimed === null ||
        claimed.stepName !== input.stepName ||
        claimed.destructive !== input.destructive ||
        claimed.state !== 'running' ||
        claimed.factsRevision !== context.facts.revision + 1 ||
        !sameLease(claimed.lease, expectedLease) ||
        after.facts.phase !== phase ||
        after.facts.activeStepName !== input.stepName ||
        after.facts.activeStepOrdinal !== input.ordinal
      )
        return yield* failConflict('workflow_step_claim_not_adopted')
      return {
        disposition: 'execute' as const,
        operation: after.operation,
        facts: after.facts,
        lease: claimed.lease,
      }
    })

  const resolveExpiredStepClaim: WorkflowStepRepositoryShape['resolveExpiredStepClaim'] = (input) =>
    Effect.gen(function* () {
      if (
        !validClaimId(input.previousLease.claimId) ||
        input.previousLease.attempt < 1 ||
        !validNewLease(input.nextClaimId, input.nextLeaseExpiresAt, input.now)
      )
        return yield* failConflict('workflow_step_invalid_lease')
      const context = yield* loadContext(input.organizationId, input.operationId)
      const step = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      if (
        step === null ||
        step.stepName !== input.stepName ||
        step.destructive !== input.destructive
      )
        return yield* failConflict('workflow_step_not_claimed')
      if (step.state === 'completed')
        return {
          disposition: 'already-completed' as const,
          operation: context.operation,
          facts: context.facts,
        }
      if (step.state === 'cancelled')
        return {
          disposition: 'cancelled' as const,
          operation: context.operation,
          facts: context.facts,
        }
      if (!sameLease(step.lease, input.previousLease))
        return {
          disposition: 'in-progress' as const,
          operation: context.operation,
          facts: context.facts,
          lease: step.lease,
        }
      const storedEffect = yield* loadEffectReceipt(
        input.organizationId,
        input.operationId,
        input.ordinal,
      )
      if (storedEffect !== null)
        return {
          disposition: 'effect-adopted' as const,
          operation: context.operation,
          facts: context.facts,
          lease: step.lease,
          effectReceipt: storedEffect,
        }
      if (!isExpired(step.lease, input.now))
        return {
          disposition: 'in-progress' as const,
          operation: context.operation,
          facts: context.facts,
          lease: step.lease,
        }
      if (input.observation.state === 'unknown')
        return {
          disposition: 'reconciliation-required' as const,
          operation: context.operation,
          facts: context.facts,
          lease: step.lease,
        }
      if (input.observation.state === 'applied') {
        const receipt = input.observation.receipt
        if (!validEffectId(receipt.effectId) || !sha256(receipt.outcomeFingerprint))
          return yield* failConflict('workflow_step_invalid_effect_receipt')
        const insert = database
          .prepare(`INSERT INTO operation_cancellation_step_effect_receipts
            (organization_id, operation_id, ordinal, claim_id, claim_attempt, effect_id,
             outcome_fingerprint, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            input.ordinal,
            step.lease.claimId,
            step.lease.attempt,
            receipt.effectId,
            receipt.outcomeFingerprint,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.step.resolve-expired.applied', () => database.batch([insert])),
        )
        if (outcome._tag === 'Failure') {
          const adopted = yield* loadEffectReceipt(
            input.organizationId,
            input.operationId,
            input.ordinal,
          )
          if (adopted !== null && sameEffectReceipt(adopted, receipt))
            return {
              disposition: 'effect-adopted' as const,
              operation: context.operation,
              facts: context.facts,
              lease: step.lease,
              effectReceipt: adopted,
            }
          return yield* outcome.failure
        }
        const adopted = yield* loadEffectReceipt(
          input.organizationId,
          input.operationId,
          input.ordinal,
        )
        if (adopted === null || !sameEffectReceipt(adopted, receipt))
          return yield* failConflict('workflow_step_effect_receipt_not_adopted')
        return {
          disposition: 'effect-adopted' as const,
          operation: context.operation,
          facts: context.facts,
          lease: step.lease,
          effectReceipt: adopted,
        }
      }
      // Reassignment happens only after the observer has proved that the exact prior claim did
      // not apply. The where clause protects against a concurrent observer/adopter and an already
      // committed effect receipt, so a provider call is never reissued on ambiguous truth.
      const update = database
        .prepare(`UPDATE operation_cancellation_step_receipts
          SET claim_id = ?, claim_attempt = claim_attempt + 1, lease_expires_at = ?
          WHERE organization_id = ? AND operation_id = ? AND ordinal = ?
            AND state = 'running' AND step_name = ? AND destructive = ?
            AND claim_id = ? AND claim_attempt = ? AND lease_expires_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM operation_cancellation_step_effect_receipts effect
              WHERE effect.organization_id = operation_cancellation_step_receipts.organization_id
                AND effect.operation_id = operation_cancellation_step_receipts.operation_id
                AND effect.ordinal = operation_cancellation_step_receipts.ordinal
            )`)
        .bind(
          input.nextClaimId,
          input.nextLeaseExpiresAt,
          input.organizationId,
          input.operationId,
          input.ordinal,
          input.stepName,
          input.destructive ? 1 : 0,
          input.previousLease.claimId,
          input.previousLease.attempt,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.step.resolve-expired.not-applied', () => database.batch([update])),
      )
      const expectedLease: WorkflowStepLease = {
        claimId: input.nextClaimId,
        attempt: input.previousLease.attempt + 1,
        expiresAt: input.nextLeaseExpiresAt,
      }
      const after = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      if (
        after !== null &&
        after.state === 'running' &&
        after.stepName === input.stepName &&
        after.destructive === input.destructive &&
        sameLease(after.lease, expectedLease)
      )
        return {
          disposition: 'execute' as const,
          operation: context.operation,
          facts: context.facts,
          lease: after.lease,
        }
      const adoptedEffect = yield* loadEffectReceipt(
        input.organizationId,
        input.operationId,
        input.ordinal,
      )
      if (after !== null && adoptedEffect !== null)
        return {
          disposition: 'effect-adopted' as const,
          operation: context.operation,
          facts: context.facts,
          lease: after.lease,
          effectReceipt: adoptedEffect,
        }
      if (outcome._tag === 'Failure') return yield* outcome.failure
      if (after !== null && after.state === 'running')
        return {
          disposition: isExpired(after.lease, input.now)
            ? ('reconciliation-required' as const)
            : ('in-progress' as const),
          operation: context.operation,
          facts: context.facts,
          lease: after.lease,
        }
      return yield* failConflict('workflow_step_reclaim_not_adopted')
    })

  const recordStepEffectReceipt: WorkflowStepRepositoryShape['recordStepEffectReceipt'] = (input) =>
    Effect.gen(function* () {
      if (
        !validClaimId(input.lease.claimId) ||
        input.lease.attempt < 1 ||
        !validEffectId(input.receipt.effectId) ||
        !sha256(input.receipt.outcomeFingerprint)
      )
        return yield* failConflict('workflow_step_invalid_effect_receipt')
      const step = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      if (
        step === null ||
        step.stepName !== input.stepName ||
        step.state !== 'running' ||
        !sameLease(step.lease, input.lease)
      )
        return yield* failConflict('workflow_step_effect_receipt_claim_mismatch')
      const prior = yield* loadEffectReceipt(input.organizationId, input.operationId, input.ordinal)
      if (prior !== null)
        return sameEffectReceipt(prior, input.receipt)
          ? prior
          : yield* failConflict('workflow_step_effect_receipt_conflict')
      const insert = database
        .prepare(`INSERT INTO operation_cancellation_step_effect_receipts
          (organization_id, operation_id, ordinal, claim_id, claim_attempt, effect_id,
           outcome_fingerprint, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          input.ordinal,
          input.lease.claimId,
          input.lease.attempt,
          input.receipt.effectId,
          input.receipt.outcomeFingerprint,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.step.effect-receipt.record', () => database.batch([insert])),
      )
      const stored = yield* loadEffectReceipt(
        input.organizationId,
        input.operationId,
        input.ordinal,
      )
      if (stored !== null && sameEffectReceipt(stored, input.receipt)) return stored
      if (outcome._tag === 'Failure') return yield* outcome.failure
      return yield* failConflict('workflow_step_effect_receipt_not_adopted')
    })

  const completeStep: WorkflowStepRepositoryShape['completeStep'] = (input) =>
    Effect.gen(function* () {
      const context = yield* loadContext(input.organizationId, input.operationId)
      const receipt = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      if (receipt === null || receipt.stepName !== input.stepName)
        return yield* failConflict('workflow_step_not_claimed')
      if (!sameLeaseIdentity(receipt.lease, input.lease))
        return yield* failConflict('workflow_step_completion_claim_mismatch')
      if (receipt.state === 'completed') {
        const completed = yield* completionReceiptExists({
          organizationId: input.organizationId,
          operationId: input.operationId,
          ordinal: input.ordinal,
          lease: input.lease,
          factsRevision: receipt.factsRevision + 1,
        })
        if (completed) return
        return yield* failConflict('workflow_step_completion_receipt_missing')
      }
      if (
        receipt.state === 'cancelled' ||
        context.operation.state === 'cancelling' ||
        context.operation.state === 'cancelled' ||
        (yield* cancellationExists(input.organizationId, input.operationId))
      )
        return yield* failConflict('workflow_step_cancelled')
      const effectReceipt = yield* loadEffectReceipt(
        input.organizationId,
        input.operationId,
        input.ordinal,
      )
      if (effectReceipt === null)
        return yield* failConflict('workflow_step_completion_evidence_missing')
      if (context.facts.revision !== receipt.factsRevision)
        return yield* failConflict('workflow_step_completion_facts_revision_conflict')
      const phase =
        context.operation.state === 'succeeded'
          ? 'terminal'
          : receipt.destructive
            ? 'destructive-step-running'
            : context.facts.policy === 'before-destructive-step'
              ? 'before-destructive-step'
              : 'between-steps'
      const receiptUpdate = database
        .prepare(`UPDATE operation_cancellation_step_receipts
          SET state = 'completed', lease_expires_at = NULL, completed_at = ?
          WHERE organization_id = ? AND operation_id = ? AND ordinal = ? AND step_name = ?
            AND state = 'running' AND claim_id = ? AND claim_attempt = ?`)
        .bind(
          input.now,
          input.organizationId,
          input.operationId,
          input.ordinal,
          input.stepName,
          input.lease.claimId,
          input.lease.attempt,
        )
      const factsUpdate = database
        .prepare(`UPDATE operation_cancellation_facts
          SET phase = ?, active_step_name = NULL, active_step_ordinal = NULL, revision = revision + 1,
              updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND revision = ?
            AND active_step_name = ? AND active_step_ordinal = ? AND phase IN ('step-running', 'destructive-step-running')
            AND NOT EXISTS (
              SELECT 1 FROM operation_cancellation_requests request
              WHERE request.organization_id = operation_cancellation_facts.organization_id
                AND request.operation_id = operation_cancellation_facts.operation_id
            )`)
        .bind(
          phase,
          input.now,
          input.organizationId,
          input.operationId,
          context.facts.revision,
          input.stepName,
          input.ordinal,
        )
      const completionReceiptInsert = database
        .prepare(`INSERT INTO operation_cancellation_step_completion_receipts
          (organization_id, operation_id, ordinal, claim_id, claim_attempt, facts_revision, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          input.ordinal,
          input.lease.claimId,
          input.lease.attempt,
          receipt.factsRevision + 1,
          input.now,
        )
      const result = yield* Effect.result(
        attempt('termination.step.complete', () =>
          // The completion-receipt trigger is an explicit batch assertion. It sees the facts
          // transition, completed step, and exact effect evidence together; a zero-change race
          // on either update aborts the whole transaction instead of committing a partial state.
          database.batch([factsUpdate, receiptUpdate, completionReceiptInsert]),
        ),
      )
      if (result._tag === 'Failure') {
        const after = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
        if (
          after?.state === 'completed' &&
          after.stepName === input.stepName &&
          sameLeaseIdentity(after.lease, input.lease) &&
          (yield* completionReceiptExists({
            organizationId: input.organizationId,
            operationId: input.operationId,
            ordinal: input.ordinal,
            lease: input.lease,
            factsRevision: after.factsRevision + 1,
          }))
        )
          return
        return yield* result.failure
      }
      const after = yield* loadStep(input.organizationId, input.operationId, input.ordinal)
      if (
        after?.state !== 'completed' ||
        !sameLeaseIdentity(after.lease, input.lease) ||
        !(yield* completionReceiptExists({
          organizationId: input.organizationId,
          operationId: input.operationId,
          ordinal: input.ordinal,
          lease: input.lease,
          factsRevision: after.factsRevision + 1,
        }))
      )
        return yield* failConflict('workflow_step_completion_not_adopted')
    })

  const finalizeCancellation: WorkflowStepRepositoryShape['finalizeCancellation'] = (input) =>
    Effect.gen(function* () {
      const loaded = yield* attempt('termination.cancellation.finalize.load', () =>
        database
          .prepare(
            `${cancellationRequestSelect} WHERE request.organization_id = ? AND request.operation_id = ?`,
          )
          .bind(input.organizationId, input.operationId)
          .first(),
      )
      if (loaded === null) return yield* failConflict('cancellation_not_requested')
      const request = yield* decodeCancellationRequest(loaded, 'adopted')
      const raw = object(loaded)
      const state = raw === undefined ? undefined : text(raw, 'cancellationState')
      if (state === undefined)
        return yield* Effect.fail(
          persistence('termination.cancellation.finalize.load', 'invalid state'),
        )
      if (state === 'cancelled') return
      if (request.operation.state !== 'cancelling')
        return yield* failConflict('cancellation_operation_state_conflict')
      const auditEventId = `termination-cancellation-finalized:${input.organizationId}:${input.operationId}:audit`
      const outboxEventId = `termination-cancellation-finalized:${input.organizationId}:${input.operationId}:outbox`
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'cancelled', progress = 100, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status = 'cancelling'`)
        .bind(input.now, input.organizationId, input.operationId)
      const backupJobUpdate = database
        .prepare(`UPDATE backup_jobs
          SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?),
              revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state = 'cancelling'
            AND EXISTS (
              SELECT 1 FROM operation_cancellation_requests request
              WHERE request.organization_id = backup_jobs.organization_id
                AND request.operation_id = backup_jobs.operation_id
                AND request.state IN ('requested', 'delivery-pending', 'signalled')
            )`)
        .bind(input.now, input.now, input.organizationId, input.operationId)
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'cancelled', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state = 'cancelling'`)
        .bind(input.now, input.organizationId, input.operationId)
      const factsUpdate = database
        .prepare(`UPDATE operation_cancellation_facts
          SET phase = 'terminal', active_step_name = NULL, active_step_ordinal = NULL,
              revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND revision = ?
            AND NOT EXISTS (
              SELECT 1 FROM operation_cancellation_step_receipts step
              WHERE step.organization_id = operation_cancellation_facts.organization_id
                AND step.operation_id = operation_cancellation_facts.operation_id
                AND step.state = 'running'
            )`)
        .bind(input.now, input.organizationId, input.operationId, request.facts.revision)
      const requestUpdate = database
        .prepare(`UPDATE operation_cancellation_requests
          SET state = 'cancelled', delivered_at = NULL
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('requested', 'delivery-pending', 'signalled')`)
        .bind(input.organizationId, input.operationId)
      const stepUpdate = database
        .prepare(`UPDATE operation_cancellation_step_receipts
          SET state = 'cancelled', lease_expires_at = NULL, completed_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state = 'running'`)
        .bind(input.now, input.organizationId, input.operationId)
      const spendRelease = database
        .prepare(`UPDATE node_provision_spend_reservations
          SET state = 'released', released_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state = 'active'`)
        .bind(input.now, input.organizationId, input.operationId)
      const bootstrapRelease = database
        .prepare(`UPDATE node_bootstrap_token_reservations
          SET state = 'revoked', updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state IN ('reserved', 'materialized')`)
        .bind(input.now, input.organizationId, input.operationId)
      const capacityRelease = database
        .prepare(`UPDATE server_capacity_reservations SET state = 'released'
          WHERE organization_id = ? AND operation_id = ? AND state IN ('reserved', 'releasing')`)
        .bind(input.organizationId, input.operationId)
      const portRelease = database
        .prepare(`UPDATE port_leases SET state = 'released', revision = revision + 1
          WHERE organization_id = ? AND operation_id = ? AND state IN ('reserved', 'releasing')`)
        .bind(input.organizationId, input.operationId)
      const compensationKinds = [
        'node-spend',
        'node-bootstrap',
        'server-capacity',
        'port-lease',
      ] as const
      const compensationInserts = compensationKinds.map((kind) =>
        database
          .prepare(`INSERT OR IGNORE INTO operation_cancellation_compensation_receipts
            (organization_id, operation_id, kind, evidence_json, completed_at)
            VALUES (?, ?, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            kind,
            JSON.stringify({ operationId: input.operationId, kind, releasedAt: input.now }),
            input.now,
          ),
      )
      const audit = yield* loadCancellationAuditContext(
        database,
        input.organizationId,
        input.operationId,
      )
      const auditOperationId = `${auditEventId}-operation`
      const auditOperationInsert = database
        .prepare(`INSERT OR IGNORE INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'operation-cancellation-finalized', ?, ?, ?, 'succeeded', 100,
            ?, ?, 1, ?, ?)`)
        .bind(
          auditOperationId,
          input.organizationId,
          audit.resourceType,
          audit.resourceId,
          audit.actorId,
          auditOperationId,
          audit.correlationId,
          input.now,
          input.now,
        )
      const auditStage = yield* stageTerminationAudit(database, {
        eventId: auditEventId,
        organizationId: input.organizationId,
        operationId: auditOperationId,
        actorId: audit.actorId,
        actorType: 'human',
        correlationId: audit.correlationId,
        action: 'operation.cancellation.finalized',
        targetType: audit.resourceType,
        targetId: audit.resourceId,
        before: { status: request.operation.state, cancellationState: state },
        after: { status: 'cancelled', operationId: input.operationId },
        now: input.now,
        request: audit.request,
      })
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, ?, 'operation.cancellation.finalized',
            operation.resource_type, operation.resource_id, 'succeeded', ?, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?
            AND operation.status = 'cancelled'`)
        .bind(
          auditEventId,
          audit.actorId,
          audit.correlationId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          SELECT ?, operation.organization_id, 'operation.cancellation.finalized',
            'operation', operation.id, ?, 'pending', 0, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?
            AND operation.status = 'cancelled'`)
        .bind(
          outboxEventId,
          JSON.stringify({ operationId: input.operationId }),
          input.now,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'cancellation-finalized', NULL, ?, ?, ?)`)
        .bind(input.organizationId, input.operationId, auditEventId, outboxEventId, input.now)
      const outcome = yield* Effect.result(
        attempt('termination.cancellation.finalize', () =>
          database.batch([
            backupJobUpdate,
            operationUpdate,
            lifecycleUpdate,
            factsUpdate,
            requestUpdate,
            stepUpdate,
            spendRelease,
            bootstrapRelease,
            capacityRelease,
            portRelease,
            ...compensationInserts,
            auditOperationInsert,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* attempt('termination.cancellation.finalize.adopt', () =>
          database
            .prepare(`SELECT state FROM operation_cancellation_requests
              WHERE organization_id = ? AND operation_id = ?`)
            .bind(input.organizationId, input.operationId)
            .first(),
        )
        if (object(adopted) !== undefined && text(object(adopted)!, 'state') === 'cancelled') return
        return yield* outcome.failure
      }
      const finalized = yield* attempt('termination.cancellation.finalize.verify', () =>
        database
          .prepare(`SELECT request.state AS requestState, operation.status AS operationState
            FROM operation_cancellation_requests request
            JOIN operations operation
              ON operation.organization_id = request.organization_id AND operation.id = request.operation_id
            WHERE request.organization_id = ? AND request.operation_id = ?`)
          .bind(input.organizationId, input.operationId)
          .first(),
      )
      const finalizedRow = object(finalized)
      if (
        finalizedRow === undefined ||
        text(finalizedRow, 'requestState') !== 'cancelled' ||
        text(finalizedRow, 'operationState') !== 'cancelled'
      )
        return yield* failConflict('cancellation_finalization_not_adopted')
    })

  return {
    claimStep,
    resolveExpiredStepClaim,
    recordStepEffectReceipt,
    completeStep,
    finalizeCancellation,
  }
}

export const WorkflowStepD1RepositoryLayer = (repository: WorkflowStepRepositoryShape) =>
  Layer.succeed(WorkflowStepRepository, repository)

interface NodeRunRecord {
  readonly organizationId: string
  readonly operationId: string
  readonly nodeId: string
  readonly action: NodeLifecycleCommand['action']
  readonly force: boolean
  readonly backupPolicy: 'required' | 'skip-authorized'
  readonly state: NodeLifecycleAcceptance['state']
  readonly providerRetirementState: NodeProviderRetirementReceipt['state']
  readonly billingState: NodeProviderRetirementReceipt['billingState']
}

const decodeNodeRun = (
  value: unknown,
): Effect.Effect<NodeRunRecord, TerminationPersistenceError> => {
  const row = object(value)
  const organizationId = row === undefined ? undefined : text(row, 'organizationId')
  const operationId = row === undefined ? undefined : text(row, 'operationId')
  const nodeId = row === undefined ? undefined : text(row, 'nodeId')
  const action = row === undefined ? undefined : text(row, 'action')
  const force = row === undefined ? undefined : booleanInteger(row, 'forceRequested')
  const backupPolicy = row === undefined ? undefined : text(row, 'backupPolicy')
  const state = row === undefined ? undefined : text(row, 'runState')
  const providerRetirementState =
    row === undefined ? undefined : text(row, 'providerRetirementState')
  const billingState = row === undefined ? undefined : text(row, 'billingState')
  if (
    organizationId === undefined ||
    operationId === undefined ||
    nodeId === undefined ||
    (action !== 'drain-node' &&
      action !== 'leave-drain' &&
      action !== 'rebuild-node' &&
      action !== 'retire-node') ||
    force === undefined ||
    (backupPolicy !== 'required' && backupPolicy !== 'skip-authorized') ||
    ![
      'accepted',
      'draining',
      'drained',
      'drained-forced',
      'rebuilding',
      'awaiting-agent',
      'retiring',
      'awaiting-provider-confirmation',
      'cancel-scheduled',
      'blocked',
      'cancelled',
      'completed',
    ].includes(state ?? '') ||
    ![
      'not-started',
      'delete-requested',
      'deleted-confirmed',
      'secure-wipe-completed',
      'cancel-scheduled',
      'contract-ended',
      'ambiguous',
    ].includes(providerRetirementState ?? '') ||
    !['not-applicable', 'unknown', 'stopped', 'continues-until-cancellation'].includes(
      billingState ?? '',
    )
  )
    return Effect.fail(persistence('termination.node-run.decode', 'invalid node lifecycle run'))
  return Effect.succeed({
    organizationId,
    operationId,
    nodeId,
    action,
    force,
    backupPolicy,
    state: state as NodeLifecycleAcceptance['state'],
    providerRetirementState: providerRetirementState as NodeProviderRetirementReceipt['state'],
    billingState: billingState as NodeProviderRetirementReceipt['billingState'],
  })
}

const nodeRunSelect = `SELECT organization_id AS organizationId, operation_id AS operationId,
  node_id AS nodeId, action, force_requested AS forceRequested, backup_policy AS backupPolicy,
  state AS runState, provider_retirement_state AS providerRetirementState,
  billing_state AS billingState
  FROM node_lifecycle_runs`

const nodeRebuildBootstrapSelect = `SELECT organization_id AS organizationId,
  operation_id AS operationId, node_id AS nodeId, token_record_id AS tokenRecordId,
  derivation_token_hash AS derivationTokenHash, token_hash AS tokenHash,
  key_version AS keyVersion, provider_type AS providerType,
  provider_instance_id AS providerInstanceId, target_image_id AS imageId,
  target_image_version AS imageVersion, target_image_checksum AS imageChecksum,
  target_provider_image_id AS providerImageId, node_desired_revision AS nodeDesiredRevision,
  state, expires_at AS expiresAt
  FROM node_lifecycle_rebuild_bootstraps`

const decodeNodeRebuildBootstrap = (
  value: unknown,
  disposition: NodeRebuildBootstrap['disposition'],
): Effect.Effect<NodeRebuildBootstrap, TerminationPersistenceError> => {
  const row = object(value)
  const organizationId = row === undefined ? undefined : text(row, 'organizationId')
  const operationId = row === undefined ? undefined : text(row, 'operationId')
  const nodeId = row === undefined ? undefined : text(row, 'nodeId')
  const tokenRecordId = row === undefined ? undefined : text(row, 'tokenRecordId')
  const derivationTokenHash = row === undefined ? undefined : text(row, 'derivationTokenHash')
  const tokenHash = row === undefined ? undefined : text(row, 'tokenHash')
  const keyVersion = row === undefined ? undefined : integer(row, 'keyVersion')
  const providerType = row === undefined ? undefined : text(row, 'providerType')
  const providerInstanceId = row === undefined ? undefined : text(row, 'providerInstanceId')
  const imageId = row === undefined ? undefined : text(row, 'imageId')
  const imageVersion = row === undefined ? undefined : text(row, 'imageVersion')
  const imageChecksum = row === undefined ? undefined : text(row, 'imageChecksum')
  const providerImageId = row === undefined ? undefined : text(row, 'providerImageId')
  const nodeDesiredRevision = row === undefined ? undefined : integer(row, 'nodeDesiredRevision')
  const state = row === undefined ? undefined : text(row, 'state')
  const expiresAt = row === undefined ? undefined : text(row, 'expiresAt')
  if (
    organizationId === undefined ||
    operationId === undefined ||
    nodeId === undefined ||
    tokenRecordId === undefined ||
    derivationTokenHash === undefined ||
    !sha256(derivationTokenHash) ||
    tokenHash === undefined ||
    !sha256(tokenHash) ||
    keyVersion === undefined ||
    keyVersion < 1 ||
    (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
    providerInstanceId === undefined ||
    imageId === undefined ||
    imageVersion === undefined ||
    imageChecksum === undefined ||
    !/^sha256:[a-f0-9]{64}$/.test(imageChecksum) ||
    providerImageId === undefined ||
    nodeDesiredRevision === undefined ||
    nodeDesiredRevision < 1 ||
    (state !== 'prepared' &&
      state !== 'provider-rebuilding' &&
      state !== 'awaiting-agent' &&
      state !== 'blocked' &&
      state !== 'ready') ||
    expiresAt === undefined
  )
    return Effect.fail(
      persistence('termination.node-rebuild-bootstrap.decode', 'invalid rebuild bootstrap'),
    )
  return Effect.succeed({
    disposition,
    organizationId,
    operationId,
    nodeId,
    tokenRecordId,
    derivationTokenHash,
    tokenHash,
    keyVersion,
    providerType,
    providerInstanceId,
    imageId,
    imageVersion,
    imageChecksum,
    providerImageId,
    nodeDesiredRevision,
    state,
    expiresAt,
  })
}

interface NodeRebuildPreparationAuthority {
  readonly nodeDesiredRevision: number
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerInstanceId: string
  readonly imageId: string
  readonly imageVersion: string
  readonly imageChecksum: string
  readonly providerImageId: string
}

const nodeRebuildPreparationAuthoritySelect = `SELECT
  node.desired_revision AS nodeDesiredRevision,
  run.provider_type_snapshot AS providerType,
  run.provider_instance_id_snapshot AS providerInstanceId,
  run.target_image_id AS imageId,
  run.target_image_version_snapshot AS imageVersion,
  run.target_image_checksum_snapshot AS imageChecksum,
  run.target_provider_image_id AS providerImageId
FROM node_lifecycle_runs run
JOIN destructive_lifecycle_operations lifecycle
  ON lifecycle.organization_id = run.organization_id AND lifecycle.operation_id = run.operation_id
JOIN operations operation
  ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
JOIN operation_cancellation_facts facts
  ON facts.organization_id = run.organization_id AND facts.operation_id = run.operation_id
JOIN nodes node
  ON node.organization_id = run.organization_id AND node.id = run.node_id
JOIN node_images image
  ON image.id = run.target_image_id
WHERE run.organization_id = ? AND run.operation_id = ? AND run.node_id = ?
  AND run.action = 'rebuild-node' AND run.state = 'rebuilding'
  AND lifecycle.action = 'rebuild-node' AND lifecycle.state = 'running'
  AND operation.type = 'rebuild-node' AND operation.resource_type = 'node'
  AND operation.resource_id = run.node_id AND operation.status = 'running'
  AND facts.phase = 'destructive-step-running'
  AND facts.active_step_ordinal = 2 AND facts.active_step_name = 'rebuild-provider-instance'
  AND node.pending_lifecycle_operation_id = run.operation_id
  AND node.desired_state = 'draining' AND node.desired_revision = run.desired_revision
  AND node.provider_type = run.provider_type_snapshot
  AND node.provider_instance_id = run.provider_instance_id_snapshot
  AND image.status = 'promoted' AND image.version = run.target_image_version_snapshot
  AND image.checksum = run.target_image_checksum_snapshot`

const decodeNodeRebuildPreparationAuthority = (
  value: unknown,
): Effect.Effect<NodeRebuildPreparationAuthority, TerminationPersistenceError> => {
  const row = object(value)
  const nodeDesiredRevision = row === undefined ? undefined : integer(row, 'nodeDesiredRevision')
  const providerType = row === undefined ? undefined : text(row, 'providerType')
  const providerInstanceId = row === undefined ? undefined : text(row, 'providerInstanceId')
  const imageId = row === undefined ? undefined : text(row, 'imageId')
  const imageVersion = row === undefined ? undefined : text(row, 'imageVersion')
  const imageChecksum = row === undefined ? undefined : text(row, 'imageChecksum')
  const providerImageId = row === undefined ? undefined : text(row, 'providerImageId')
  if (
    nodeDesiredRevision === undefined ||
    nodeDesiredRevision < 1 ||
    (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
    providerInstanceId === undefined ||
    imageId === undefined ||
    imageVersion === undefined ||
    imageChecksum === undefined ||
    !/^sha256:[a-f0-9]{64}$/.test(imageChecksum) ||
    providerImageId === undefined
  )
    return Effect.fail(
      persistence(
        'termination.node-rebuild-bootstrap.authority.decode',
        'invalid rebuild authority',
      ),
    )
  return Effect.succeed({
    nodeDesiredRevision,
    providerType,
    providerInstanceId,
    imageId,
    imageVersion,
    imageChecksum,
    providerImageId,
  })
}

interface NodeRebuildReadyObservation {
  readonly credentialId: string
  readonly credentialVersion: number
  readonly sessionVersion: number
  readonly observationSequence: number
  readonly observationRevision: number
  readonly observationFingerprint: string
}

const nodeRebuildReadyObservationSelect = `SELECT credential.id AS credentialId,
  credential.version AS credentialVersion, session.session_version AS sessionVersion,
  stream.last_sequence AS observationSequence,
  stream.last_observed_revision AS observationRevision,
  stream.last_fingerprint AS observationFingerprint
FROM node_lifecycle_rebuild_bootstraps bootstrap
JOIN node_registration_tokens token
  ON token.organization_id = bootstrap.organization_id AND token.node_id = bootstrap.node_id
 AND token.operation_id = bootstrap.operation_id AND token.token_hash = bootstrap.token_hash
JOIN node_credentials credential
  ON credential.organization_id = token.organization_id AND credential.node_id = token.node_id
 AND credential.id = token.credential_id
JOIN agent_sessions session
  ON session.organization_id = credential.organization_id AND session.node_id = credential.node_id
 AND session.credential_id = credential.id
JOIN agent_observation_streams stream
  ON stream.organization_id = credential.organization_id AND stream.node_id = credential.node_id
WHERE bootstrap.organization_id = ? AND bootstrap.operation_id = ? AND bootstrap.node_id = ?
  AND bootstrap.state = 'awaiting-agent'
  AND token.consumed_at IS NOT NULL AND token.revoked_at IS NULL
  AND credential.status = 'active' AND session.session_state = 'connected'
  AND stream.credential_id = credential.id AND stream.credential_version = credential.version
  AND stream.session_version = session.session_version`

const decodeNodeRebuildReadyObservation = (
  value: unknown,
): Effect.Effect<NodeRebuildReadyObservation, TerminationPersistenceError> => {
  const row = object(value)
  const credentialId = row === undefined ? undefined : text(row, 'credentialId')
  const credentialVersion = row === undefined ? undefined : integer(row, 'credentialVersion')
  const sessionVersion = row === undefined ? undefined : integer(row, 'sessionVersion')
  const observationSequence = row === undefined ? undefined : integer(row, 'observationSequence')
  const observationRevision = row === undefined ? undefined : integer(row, 'observationRevision')
  const observationFingerprint = row === undefined ? undefined : text(row, 'observationFingerprint')
  if (
    credentialId === undefined ||
    credentialVersion === undefined ||
    credentialVersion < 2 ||
    sessionVersion === undefined ||
    sessionVersion < 2 ||
    observationSequence === undefined ||
    observationSequence < 1 ||
    observationRevision === undefined ||
    observationRevision < 1 ||
    observationFingerprint === undefined ||
    !sha256(observationFingerprint)
  )
    return Effect.fail(
      persistence(
        'termination.node-rebuild-ready.observation.decode',
        'invalid rebuild ready observation',
      ),
    )
  return Effect.succeed({
    credentialId,
    credentialVersion,
    sessionVersion,
    observationSequence,
    observationRevision,
    observationFingerprint,
  })
}

/**
 * This is intentionally a read-only, operation-bound receipt.  Organization
 * deletion must not infer a retired node from a missing provider row or from a
 * node's observed state alone: every fact below is tied to the exact child
 * RETIRE_NODE operation that it deterministically created.
 */
export interface DeletedRetirementReceipt {
  readonly organizationId: string
  readonly nodeId: string
  readonly childOperationId: string
  readonly parentOrganizationDeletionOperationId: string
  readonly providerTerminalState: 'deleted-confirmed' | 'contract-ended'
}

export const requireDeletedRetirementReceipt = (
  database: LifecycleTerminationD1Database,
  input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly childOperationId: string
  },
): Effect.Effect<
  DeletedRetirementReceipt,
  TerminationPersistenceError | TerminationConflictError
> =>
  Effect.gen(function* () {
    const raw = yield* attempt('termination.node-retirement-receipt.load', () =>
      database
        .prepare(`SELECT operation.organization_id AS organizationId,
          operation.resource_id AS nodeId,
          operation.id AS childOperationId,
          lifecycle.organization_deletion_operation_id AS parentOperationId,
          run.provider_retirement_state AS providerTerminalState
          FROM operations operation
          JOIN destructive_lifecycle_operations lifecycle
            ON lifecycle.organization_id = operation.organization_id
           AND lifecycle.operation_id = operation.id
          JOIN node_lifecycle_runs run
            ON run.organization_id = operation.organization_id
           AND run.operation_id = operation.id
          JOIN operation_cancellation_facts facts
            ON facts.organization_id = operation.organization_id
           AND facts.operation_id = operation.id
          JOIN organization_deletion_child_operations child
            ON child.organization_id = operation.organization_id
           AND child.parent_operation_id = lifecycle.organization_deletion_operation_id
           AND child.kind = 'node'
           AND child.resource_id = operation.resource_id
           AND child.child_operation_id = operation.id
          JOIN nodes node
            ON node.organization_id = operation.organization_id
           AND node.id = operation.resource_id
          JOIN tunnels tunnel
            ON tunnel.organization_id = operation.organization_id
           AND tunnel.node_id = operation.resource_id
          WHERE operation.organization_id = ?
            AND operation.id = ?
            AND operation.resource_id = ?
            AND operation.type = 'retire-node'
            AND operation.resource_type = 'node'
            AND operation.status = 'succeeded'
            AND lifecycle.action = 'retire-node'
            AND lifecycle.resource_type = 'node'
            AND lifecycle.resource_id = operation.resource_id
            AND lifecycle.state = 'succeeded'
            AND lifecycle.organization_deletion_operation_id IS NOT NULL
            AND run.node_id = operation.resource_id
            AND run.action = 'retire-node'
            AND run.state = 'completed'
            AND run.provider_retirement_state IN ('deleted-confirmed', 'contract-ended')
            AND run.billing_state = 'stopped'
            AND facts.phase = 'terminal'
            AND node.desired_state = 'deleted'
            AND node.observed_state = 'deleted'
            AND node.pending_lifecycle_operation_id IS NULL
            AND tunnel.state = 'deleted'
            AND EXISTS (
              SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
              WHERE receipt.organization_id = operation.organization_id
                AND receipt.operation_id = operation.id
                AND receipt.receipt_key = 'node-retirement-finalized'
            )
            AND EXISTS (
              SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
              WHERE receipt.organization_id = operation.organization_id
                AND receipt.operation_id = operation.id
                AND receipt.receipt_key = 'node-credentials-revoked'
            )
            AND EXISTS (
              SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
              WHERE receipt.organization_id = operation.organization_id
                AND receipt.operation_id = operation.id
                AND receipt.receipt_key = 'node-tunnel-deleted'
            )
            AND EXISTS (
              SELECT 1 FROM destructive_lifecycle_atomic_receipts receipt
              WHERE receipt.organization_id = operation.organization_id
                AND receipt.operation_id = operation.id
                AND receipt.receipt_key =
                  CASE run.provider_retirement_state
                    WHEN 'deleted-confirmed' THEN 'node-provider-deleted-confirmed'
                    WHEN 'contract-ended' THEN 'node-provider-contract-ended'
                  END
            )
            AND NOT EXISTS (
              SELECT 1 FROM node_credentials credential
              WHERE credential.organization_id = operation.organization_id
                AND credential.node_id = operation.resource_id
                AND credential.status <> 'revoked'
            )
            AND NOT EXISTS (
              SELECT 1 FROM agent_sessions session
              WHERE session.organization_id = operation.organization_id
                AND session.node_id = operation.resource_id
                AND session.session_state <> 'revoked'
            )
            AND NOT EXISTS (
              SELECT 1 FROM node_registration_tokens token
              WHERE token.organization_id = operation.organization_id
                AND token.node_id = operation.resource_id
                AND token.revoked_at IS NULL
            )`)
        .bind(input.organizationId, input.childOperationId, input.nodeId)
        .first(),
    )
    const found = object(raw)
    const organizationId = found === undefined ? undefined : text(found, 'organizationId')
    const nodeId = found === undefined ? undefined : text(found, 'nodeId')
    const childOperationId = found === undefined ? undefined : text(found, 'childOperationId')
    const parentOperationId = found === undefined ? undefined : text(found, 'parentOperationId')
    const providerTerminalState =
      found === undefined ? undefined : text(found, 'providerTerminalState')
    if (
      organizationId !== input.organizationId ||
      nodeId !== input.nodeId ||
      childOperationId !== input.childOperationId ||
      parentOperationId === undefined ||
      (providerTerminalState !== 'deleted-confirmed' && providerTerminalState !== 'contract-ended')
    )
      return yield* failConflict('node_retirement_receipt_unavailable')
    return {
      organizationId,
      nodeId,
      childOperationId,
      parentOrganizationDeletionOperationId: parentOperationId,
      providerTerminalState,
    }
  })

const numberValue = (
  value: unknown,
  operation: string,
): Effect.Effect<number, TerminationPersistenceError> => {
  const row = object(value)
  const count = row === undefined ? undefined : integer(row, 'count')
  return count === undefined || count < 0
    ? Effect.fail(persistence(operation, 'invalid count'))
    : Effect.succeed(count)
}

const evidenceIds = (prefix: string, organizationId: string, operationId: string) => ({
  auditEventId: `${prefix}:${organizationId}:${operationId}:audit`,
  outboxEventId: `${prefix}:${organizationId}:${operationId}:outbox`,
})

/**
 * Workflow execution is a machine boundary, but its authoritative actor and
 * correlation remain those of the immutable HTTP acceptance. Decode the
 * persisted edge context before writing a terminal child audit operation; it
 * is a provenance fence, not a reason to mislabel the Workflow as HTTP.
 */
const stageNodeLifecycleAudit = (
  database: LifecycleTerminationD1Database,
  input: {
    readonly eventId: string
    readonly parentOperationId: string
    readonly organizationId: string
    readonly nodeId: string
    readonly kind: string
    readonly action: string
    readonly before: Readonly<Record<string, unknown>>
    readonly after: Readonly<Record<string, unknown>>
    readonly now: string
  },
) =>
  Effect.gen(function* () {
    const raw = yield* attempt('termination.node-audit.context', () =>
      database
        .prepare(`SELECT operation.actor_id AS actorId, operation.correlation_id AS correlationId,
          lifecycle.policy_reconciliation_action_id AS policyActionId,
          run.audit_request_context_json AS auditRequestContext
          FROM operations operation
          JOIN destructive_lifecycle_operations lifecycle
            ON lifecycle.organization_id = operation.organization_id
           AND lifecycle.operation_id = operation.id
          JOIN node_lifecycle_runs run
            ON run.organization_id = operation.organization_id AND run.operation_id = operation.id
          WHERE operation.organization_id = ? AND operation.id = ? AND run.node_id = ?`)
        .bind(input.organizationId, input.parentOperationId, input.nodeId)
        .first(),
    )
    const context = object(raw)
    const actorId = context === undefined ? undefined : text(context, 'actorId')
    const correlationId = context === undefined ? undefined : text(context, 'correlationId')
    const encoded = context === undefined ? undefined : text(context, 'auditRequestContext')
    const policyActionId = context?.policyActionId
    if (
      actorId === undefined ||
      correlationId === undefined ||
      encoded === undefined ||
      (policyActionId !== null && typeof policyActionId !== 'string')
    )
      return yield* persistence(
        'termination.node-audit.context',
        'node lifecycle audit provenance is unavailable',
      )
    const persisted = yield* Effect.try({
      try: () => JSON.parse(encoded) as unknown,
      catch: (cause) => persistence('termination.node-audit.context', cause),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(AuditRequestContextValue, {
          onExcessProperty: 'error',
        })(value).pipe(
          Effect.mapError((cause) => persistence('termination.node-audit.context', cause)),
        ),
      ),
    )
    if (persisted.correlationId !== correlationId)
      return yield* persistence(
        'termination.node-audit.context',
        'node lifecycle audit provenance correlation does not match the operation',
      )
    const childOperationId = `${input.parentOperationId}-audit-${input.kind}`
    const operation = database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'node', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
      .bind(
        childOperationId,
        input.organizationId,
        input.action,
        input.nodeId,
        actorId,
        `node-lifecycle-audit-${input.kind}:${input.parentOperationId}`,
        correlationId,
        input.now,
        input.now,
      )
    const staged = yield* stageTerminationAudit(database, {
      eventId: input.eventId,
      organizationId: input.organizationId,
      operationId: childOperationId,
      actorId,
      actorType: policyActionId === null ? 'human' : 'system',
      correlationId,
      action: input.action,
      targetType: 'node',
      targetId: input.nodeId,
      before: input.before,
      after: input.after,
      now: input.now,
      request: {
        origin: 'machine',
        requestId: `node-lifecycle-workflow-${childOperationId}`,
        correlationId,
        source: {
          ip: { state: 'not-available', reason: 'node lifecycle Workflow has no client IP' },
          access: {
            state: 'not-available',
            reason: 'node lifecycle Workflow has no Access assertion',
          },
        },
      },
    })
    return { operation, ...staged }
  })

/** Node drain/rebuild/retire state is stored here; provider calls remain outside D1 and can only be
 * claimed after the hard database evidence guard has accepted the exact preconditions. */
export const makeNodeTerminationD1Repository = (
  database: LifecycleTerminationD1Database,
): NodeTerminationRepositoryShape => {
  const loadRun = (organizationId: string, operationId: string, nodeId?: string) =>
    Effect.flatMap(
      attempt('termination.node-run.load', () => {
        const statement = database.prepare(
          `${nodeRunSelect} WHERE organization_id = ? AND operation_id = ?${nodeId === undefined ? '' : ' AND node_id = ?'}`,
        )
        return nodeId === undefined
          ? statement.bind(organizationId, operationId).first()
          : statement.bind(organizationId, operationId, nodeId).first()
      }),
      (row) =>
        row === null
          ? Effect.fail(persistence('termination.node-run.load', 'run not found or cross tenant'))
          : decodeNodeRun(row),
    )

  const loadRebuildBootstrap = (
    organizationId: string,
    operationId: string,
    nodeId: string,
    disposition: NodeRebuildBootstrap['disposition'] = 'adopted',
  ) =>
    Effect.flatMap(
      attempt('termination.node-rebuild-bootstrap.load', () =>
        database
          .prepare(
            `${nodeRebuildBootstrapSelect} WHERE organization_id = ? AND operation_id = ? AND node_id = ?`,
          )
          .bind(organizationId, operationId, nodeId)
          .first(),
      ),
      (row) =>
        row === null
          ? Effect.succeed(null)
          : Effect.map(decodeNodeRebuildBootstrap(row, disposition), (value) => value),
    )

  const loadRebuildPreparationAuthority = (
    organizationId: string,
    operationId: string,
    nodeId: string,
  ) =>
    Effect.flatMap(
      attempt('termination.node-rebuild-bootstrap.authority.load', () =>
        database
          .prepare(nodeRebuildPreparationAuthoritySelect)
          .bind(organizationId, operationId, nodeId)
          .first(),
      ),
      (row) =>
        row === null
          ? Effect.fail(
              persistence(
                'termination.node-rebuild-bootstrap.authority.load',
                'rebuild authority is unavailable',
              ),
            )
          : decodeNodeRebuildPreparationAuthority(row),
    )

  const loadRebuildReadyObservation = (
    organizationId: string,
    operationId: string,
    nodeId: string,
  ) =>
    Effect.flatMap(
      attempt('termination.node-rebuild-ready.observation.load', () =>
        database
          .prepare(nodeRebuildReadyObservationSelect)
          .bind(organizationId, operationId, nodeId)
          .first(),
      ),
      (row) =>
        row === null
          ? Effect.fail(
              persistence(
                'termination.node-rebuild-ready.observation.load',
                'rebuild agent observation is unavailable',
              ),
            )
          : decodeNodeRebuildReadyObservation(row),
    )

  const loadFacts = (organizationId: string, operationId: string) =>
    Effect.flatMap(
      attempt('termination.node-run.facts', () =>
        database
          .prepare(
            `${operationFactsSelect} WHERE operation.organization_id = ? AND operation.id = ?`,
          )
          .bind(organizationId, operationId)
          .first(),
      ),
      (row) =>
        row === null
          ? Effect.fail(persistence('termination.node-run.facts', 'facts not found'))
          : Effect.gen(function* () {
              const operation = yield* decodeOperation(row)
              const facts = yield* decodeFacts(row)
              return { operation, facts }
            }),
    )

  const activeCount = (organizationId: string, nodeId: string) =>
    attempt('termination.node-run.active-count', () =>
      database
        .prepare(`SELECT COUNT(*) AS count FROM deployments
          WHERE organization_id = ? AND node_id = ? AND observed_state <> 'deleted'`)
        .bind(organizationId, nodeId)
        .first(),
    ).pipe(Effect.flatMap((row) => numberValue(row, 'termination.node-run.active-count')))

  const pendingAffectedCount = (organizationId: string, operationId: string) =>
    attempt('termination.node-run.pending-affected-count', () =>
      database
        .prepare(`SELECT COUNT(*) AS count FROM node_lifecycle_affected_servers
          WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`)
        .bind(organizationId, operationId)
        .first(),
    ).pipe(Effect.flatMap((row) => numberValue(row, 'termination.node-run.pending-affected-count')))

  const missingBackupCount = (organizationId: string, operationId: string) =>
    attempt('termination.node-run.missing-backup-count', () =>
      database
        .prepare(`SELECT COUNT(*) AS count
          FROM node_lifecycle_affected_servers affected
          WHERE affected.organization_id = ? AND affected.operation_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM backups backup
              WHERE backup.organization_id = affected.organization_id
                AND backup.server_id = affected.server_id AND backup.state = 'available'
                AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
                AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER)
                  >= affected.desired_revision
            )`)
        .bind(organizationId, operationId)
        .first(),
    ).pipe(Effect.flatMap((row) => numberValue(row, 'termination.node-run.missing-backup-count')))

  const listAffectedServers: NodeTerminationRepositoryShape['listAffectedServers'] = (input) =>
    Effect.flatMap(
      attempt('termination.node-run.list-affected', () =>
        database
          .prepare(`SELECT server_id AS serverId, deployment_id AS deploymentId,
            desired_revision AS desiredRevision, state
            FROM node_lifecycle_affected_servers
            WHERE organization_id = ? AND operation_id = ? ORDER BY server_id`)
          .bind(input.organizationId, input.operationId)
          .all(),
      ),
      (result) =>
        Effect.forEach(result.results, (value) => {
          const row = object(value)
          const serverId = row === undefined ? undefined : text(row, 'serverId')
          const deploymentId = row === undefined ? undefined : text(row, 'deploymentId')
          const desiredRevision = row === undefined ? undefined : integer(row, 'desiredRevision')
          const state = row === undefined ? undefined : text(row, 'state')
          return serverId === undefined ||
            deploymentId === undefined ||
            desiredRevision === undefined ||
            desiredRevision < 1 ||
            (state !== 'pending' && state !== 'moved' && state !== 'deleted')
            ? Effect.fail(
                persistence('termination.node-run.list-affected', 'invalid affected server'),
              )
            : Effect.succeed({
                serverId,
                deploymentId,
                desiredRevision,
                state: state as NodeTerminationAffectedServer['state'],
              })
        }),
    )

  const markAffectedServerResolved: NodeTerminationRepositoryShape['markAffectedServerResolved'] = (
    input,
  ) =>
    Effect.gen(function* () {
      const existing = yield* listAffectedServers({
        organizationId: input.organizationId,
        operationId: input.operationId,
      })
      const affected = existing.find((item) => item.serverId === input.serverId)
      if (affected === undefined)
        return yield* failConflict('affected_server_not_found_or_cross_tenant')
      if (affected.state === input.disposition) return
      if (affected.state !== 'pending')
        return yield* failConflict('affected_server_resolution_conflict')
      const update = database
        .prepare(`UPDATE node_lifecycle_affected_servers
          SET state = ?, resolved_at = ?
          WHERE organization_id = ? AND operation_id = ? AND server_id = ? AND state = 'pending'`)
        .bind(input.disposition, input.now, input.organizationId, input.operationId, input.serverId)
      const outcome = yield* Effect.result(
        attempt('termination.node-run.resolve-affected', () => database.batch([update])),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* listAffectedServers({
          organizationId: input.organizationId,
          operationId: input.operationId,
        })
        if (
          adopted.some(
            (item) => item.serverId === input.serverId && item.state === input.disposition,
          )
        )
          return
        return yield* outcome.failure
      }
      const adopted = yield* listAffectedServers({
        organizationId: input.organizationId,
        operationId: input.operationId,
      })
      if (
        !adopted.some(
          (item) => item.serverId === input.serverId && item.state === input.disposition,
        )
      )
        return yield* failConflict('affected_server_resolution_not_adopted')
    })

  const completeNodeDrain: NodeTerminationRepositoryShape['completeNodeDrain'] = (input) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (run.state === 'cancelled' || run.state === 'completed') return { state: run.state }
      const active = yield* activeCount(input.organizationId, input.nodeId)
      const pending = yield* pendingAffectedCount(input.organizationId, input.operationId)
      const isStandaloneDrain = run.action === 'drain-node' || run.action === 'leave-drain'
      const target =
        run.action === 'leave-drain'
          ? ('completed' as const)
          : active === 0 && pending === 0
            ? isStandaloneDrain
              ? ('completed' as const)
              : ('drained' as const)
            : run.force
              ? isStandaloneDrain
                ? ('completed' as const)
                : ('drained-forced' as const)
              : ('blocked' as const)
      const operationState =
        target === 'completed' ? 'succeeded' : target === 'blocked' ? 'waiting_external' : 'running'
      const lifecycleState =
        target === 'completed' ? 'succeeded' : target === 'blocked' ? 'blocked' : 'running'
      const event = evidenceIds(
        `termination-node-drain-${target}`,
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageNodeLifecycleAudit(database, {
        eventId: event.auditEventId,
        parentOperationId: input.operationId,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        kind: `drain-${target}`,
        action: 'node.drain.transition',
        before: {
          state: run.state,
          activeDeployments: active,
          pendingAffected: pending,
        },
        after: {
          state: target,
          activeDeployments: active,
          pendingAffected: pending,
        },
        now: input.now,
      })
      const runUpdate = database
        .prepare(`UPDATE node_lifecycle_runs
          SET state = ?, blocked_reason = ?, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND node_id = ?
            AND state IN ('accepted', 'draining', 'blocked', 'drained-forced')`)
        .bind(
          target,
          target === 'blocked' ? 'active-deployments' : null,
          input.now,
          input.organizationId,
          input.operationId,
          input.nodeId,
        )
      const nodeUpdates =
        target === 'completed'
          ? [
              database
                .prepare(`UPDATE nodes SET pending_lifecycle_operation_id = NULL, updated_at = ?
                  WHERE organization_id = ? AND id = ? AND pending_lifecycle_operation_id = ?`)
                .bind(input.now, input.organizationId, input.nodeId, input.operationId),
            ]
          : []
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
        .bind(lifecycleState, input.now, input.organizationId, input.operationId)
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = ?, progress = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ?
            AND status IN ('queued', 'running', 'waiting_external', 'retrying')`)
        .bind(
          operationState,
          target === 'completed' ? 100 : 40,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'node.drain.transition',
            'node', ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          input.nodeId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'node.drain.transitioned', 'operation', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.operationId,
          JSON.stringify({ nodeId: input.nodeId, state: target }),
          input.now,
          input.now,
        )
      const receiptKey = target === 'blocked' ? 'node-drain-blocked' : 'node-drain-completed'
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          receiptKey,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.node-run.complete-drain', () =>
          database.batch([
            ...nodeUpdates,
            runUpdate,
            lifecycleUpdate,
            operationUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        if (adopted.state === target) return { state: adopted.state }
        return yield* outcome.failure
      }
      const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (adopted.state !== target) return yield* failConflict('node_drain_transition_not_adopted')
      return { state: adopted.state }
    })

  const claimNodeProviderDestructiveAction: NodeTerminationRepositoryShape['claimNodeProviderDestructiveAction'] =
    (input) =>
      Effect.gen(function* () {
        const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        const context = yield* loadFacts(input.organizationId, input.operationId)
        if (context.operation.state === 'cancelling' || context.operation.state === 'cancelled')
          return { disposition: 'cancelled' as const, state: run.state }
        const cancellation = yield* attempt('termination.node-run.cancellation', () =>
          database
            .prepare(`SELECT 1 AS present FROM operation_cancellation_requests
            WHERE organization_id = ? AND operation_id = ?`)
            .bind(input.organizationId, input.operationId)
            .first(),
        )
        if (cancellation !== null) return { disposition: 'cancelled' as const, state: run.state }
        if (run.action !== 'rebuild-node' && run.action !== 'retire-node')
          return yield* failConflict('node_provider_action_not_destructive')
        if (run.state !== 'drained' && run.state !== 'drained-forced')
          return {
            disposition: 'blocked' as const,
            state: run.state,
            reason: 'not-drained' as const,
          }
        if (context.facts.phase !== 'destructive-step-running')
          return yield* failConflict('node_provider_step_not_claimed')
        const active = yield* activeCount(input.organizationId, input.nodeId)
        const pending = yield* pendingAffectedCount(input.organizationId, input.operationId)
        if (active > 0 || pending > 0)
          return {
            disposition: 'blocked' as const,
            state: run.state,
            reason: 'active-deployments' as const,
          }
        if (
          run.backupPolicy === 'required' &&
          (yield* missingBackupCount(input.organizationId, input.operationId)) > 0
        )
          return {
            disposition: 'blocked' as const,
            state: run.state,
            reason: 'backup-evidence-missing' as const,
          }
        const target = run.action === 'rebuild-node' ? 'rebuilding' : 'retiring'
        const event = evidenceIds(
          'termination-node-provider-action-claimed',
          input.organizationId,
          input.operationId,
        )
        const auditStage = yield* stageNodeLifecycleAudit(database, {
          eventId: event.auditEventId,
          parentOperationId: input.operationId,
          organizationId: input.organizationId,
          nodeId: input.nodeId,
          kind: 'provider-action-claimed',
          action: 'node.provider.action.claimed',
          before: {
            state: run.state,
            activeDeployments: active,
            pendingAffected: pending,
            backupPolicy: run.backupPolicy,
          },
          after: {
            state: target,
            providerAction: run.action === 'rebuild-node' ? 'rebuild' : 'retire',
          },
          now: input.now,
        })
        const runUpdate = database
          .prepare(`UPDATE node_lifecycle_runs SET state = ?, blocked_reason = NULL, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND node_id = ?
            AND state IN ('drained', 'drained-forced')`)
          .bind(target, input.now, input.organizationId, input.operationId, input.nodeId)
        const lifecycleUpdate = database
          .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state IN ('queued', 'running', 'blocked')`)
          .bind(input.now, input.organizationId, input.operationId)
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external', 'retrying')`)
          .bind(input.now, input.organizationId, input.operationId)
        const auditInsert = database
          .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'node.provider.action.claimed',
            'node', ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(
            event.auditEventId,
            input.nodeId,
            auditStage.summaryJson,
            input.now,
            input.organizationId,
            input.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'node.provider.action.claimed', 'operation', ?, ?, 'pending', 0, ?, ?)`)
          .bind(
            event.outboxEventId,
            input.organizationId,
            input.operationId,
            JSON.stringify({ nodeId: input.nodeId, action: run.action, state: target }),
            input.now,
            input.now,
          )
        const receiptInsert = database
          .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'node-provider-action-claimed', NULL, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            event.auditEventId,
            event.outboxEventId,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.node-run.claim-provider-action', () =>
            database.batch([
              runUpdate,
              lifecycleUpdate,
              operationUpdate,
              auditStage.operation,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
            ]),
          ),
        )
        if (outcome._tag === 'Failure') {
          const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
          if (adopted.state === target)
            return { disposition: 'execute' as const, state: adopted.state }
          return yield* outcome.failure
        }
        const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        return adopted.state === target
          ? { disposition: 'execute' as const, state: adopted.state }
          : yield* failConflict('node_provider_action_claim_not_adopted')
      })

  const prepareNodeRebuildBootstrap: NodeTerminationRepositoryShape['prepareNodeRebuildBootstrap'] =
    (input) =>
      Effect.gen(function* () {
        const expiresAt = Date.parse(input.expiresAt)
        const preparedAt = Date.parse(input.now)
        if (
          !sha256(input.derivationTokenHash) ||
          !sha256(input.tokenHash) ||
          !Number.isSafeInteger(input.keyVersion) ||
          input.keyVersion < 1 ||
          input.tokenRecordId.length < 1 ||
          input.tokenRecordId.length > 256 ||
          !Number.isFinite(expiresAt) ||
          !Number.isFinite(preparedAt) ||
          expiresAt <= preparedAt
        )
          return yield* failConflict('node_rebuild_bootstrap_input_invalid')
        const existing = yield* loadRebuildBootstrap(
          input.organizationId,
          input.operationId,
          input.nodeId,
        )
        if (existing !== null) {
          if (
            existing.tokenRecordId !== input.tokenRecordId ||
            existing.derivationTokenHash !== input.derivationTokenHash ||
            existing.tokenHash !== input.tokenHash ||
            existing.keyVersion !== input.keyVersion ||
            existing.expiresAt !== input.expiresAt
          )
            return yield* failConflict('node_rebuild_bootstrap_replay_mismatch')
          return existing
        }
        const authority = yield* loadRebuildPreparationAuthority(
          input.organizationId,
          input.operationId,
          input.nodeId,
        )
        const event = evidenceIds(
          'termination-node-rebuild-bootstrap-prepared',
          input.organizationId,
          input.operationId,
        )
        const auditStage = yield* stageNodeLifecycleAudit(database, {
          eventId: event.auditEventId,
          parentOperationId: input.operationId,
          organizationId: input.organizationId,
          nodeId: input.nodeId,
          kind: 'rebuild-bootstrap-prepared',
          action: 'node.rebuild.bootstrap.prepared',
          before: {
            desiredState: 'draining',
            desiredRevision: authority.nodeDesiredRevision,
            credentialEpoch: 'active',
          },
          after: {
            desiredState: 'provisioning',
            desiredRevision: authority.nodeDesiredRevision + 1,
            tokenRecordId: input.tokenRecordId,
            keyVersion: input.keyVersion,
            expiresAt: input.expiresAt,
            imageId: authority.imageId,
            imageVersion: authority.imageVersion,
            imageChecksum: authority.imageChecksum,
            providerImageId: authority.providerImageId,
          },
          now: input.now,
        })
        const credentials = database
          .prepare(`UPDATE node_credentials SET status = 'revoked', revoked_at = ?
            WHERE organization_id = ? AND node_id = ? AND status = 'active'`)
          .bind(input.now, input.organizationId, input.nodeId)
        const sessions = database
          .prepare(`UPDATE agent_sessions SET session_state = 'revoked', revision = revision + 1
            WHERE organization_id = ? AND node_id = ? AND session_state <> 'revoked'`)
          .bind(input.organizationId, input.nodeId)
        const tokens = database
          .prepare(`UPDATE node_registration_tokens SET revoked_at = ?
            WHERE organization_id = ? AND node_id = ? AND revoked_at IS NULL`)
          .bind(input.now, input.organizationId, input.nodeId)
        const installer = database
          .prepare(`UPDATE node_installer_keys SET status = 'revoked', revoked_at = ?,
            revision = revision + 1
            WHERE organization_id = ? AND node_id = ? AND status = 'active'`)
          .bind(input.now, input.organizationId, input.nodeId)
        const nodeUpdate = database
          .prepare(`UPDATE nodes SET desired_state = 'provisioning', desired_revision = ?,
            observed_state = 'unknown', image_id = ?, reconciliation_error = 'rebuild-awaiting-agent',
            last_reconciled_at = NULL, updated_at = ?
            WHERE organization_id = ? AND id = ? AND desired_state = 'draining'
              AND desired_revision = ? AND pending_lifecycle_operation_id = ?`)
          .bind(
            authority.nodeDesiredRevision + 1,
            authority.imageId,
            input.now,
            input.organizationId,
            input.nodeId,
            authority.nodeDesiredRevision,
            input.operationId,
          )
        const tokenInsert = database
          .prepare(`INSERT INTO node_registration_tokens
            (token_hash, organization_id, node_id, provider_instance_id, operation_id, credential_id,
             expires_at, consumed_at, revoked_at, issued_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`)
          .bind(
            input.tokenHash,
            input.organizationId,
            input.nodeId,
            authority.providerInstanceId,
            input.operationId,
            input.expiresAt,
            input.now,
          )
        const auditInsert = database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, operation.organization_id, operation.actor_id, 'node.rebuild.bootstrap.prepared',
              'node', ?, 'succeeded', operation.correlation_id, ?, ?
            FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(
            event.auditEventId,
            input.nodeId,
            auditStage.summaryJson,
            input.now,
            input.organizationId,
            input.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, created_at)
            VALUES (?, ?, 'node.rebuild.bootstrap.prepared', 'operation', ?, ?, 'pending', 0, ?, ?)`)
          .bind(
            event.outboxEventId,
            input.organizationId,
            input.operationId,
            JSON.stringify({
              nodeId: input.nodeId,
              state: 'prepared',
              imageId: authority.imageId,
              imageChecksum: authority.imageChecksum,
            }),
            input.now,
            input.now,
          )
        const receiptInsert = database
          .prepare(`INSERT INTO destructive_lifecycle_atomic_receipts
            (organization_id, operation_id, receipt_key, workflow_start_record_id,
             audit_event_id, outbox_event_id, created_at)
            VALUES (?, ?, 'node-rebuild-bootstrap-prepared', NULL, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            event.auditEventId,
            event.outboxEventId,
            input.now,
          )
        const bootstrapInsert = database
          .prepare(`INSERT INTO node_lifecycle_rebuild_bootstraps
            (organization_id, operation_id, node_id, token_record_id, derivation_token_hash,
             token_hash, key_version,
             provider_type, provider_instance_id, target_image_id, target_image_version,
             target_image_checksum, target_provider_image_id, node_desired_revision, state,
             provider_observed_at, prepared_operation_id, prepared_audit_event_id,
             prepared_outbox_event_id, expires_at, prepared_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, ?, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            input.nodeId,
            input.tokenRecordId,
            input.derivationTokenHash,
            input.tokenHash,
            input.keyVersion,
            authority.providerType,
            authority.providerInstanceId,
            authority.imageId,
            authority.imageVersion,
            authority.imageChecksum,
            authority.providerImageId,
            authority.nodeDesiredRevision + 1,
            `${input.operationId}-audit-rebuild-bootstrap-prepared`,
            event.auditEventId,
            event.outboxEventId,
            input.expiresAt,
            input.now,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.node-rebuild-bootstrap.prepare', () =>
            database.batch([
              credentials,
              sessions,
              tokens,
              installer,
              nodeUpdate,
              tokenInsert,
              auditStage.operation,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
              bootstrapInsert,
            ]),
          ),
        )
        const adopted = yield* loadRebuildBootstrap(
          input.organizationId,
          input.operationId,
          input.nodeId,
        )
        if (adopted !== null) {
          if (
            adopted.tokenRecordId !== input.tokenRecordId ||
            adopted.derivationTokenHash !== input.derivationTokenHash ||
            adopted.tokenHash !== input.tokenHash ||
            adopted.keyVersion !== input.keyVersion ||
            adopted.expiresAt !== input.expiresAt
          )
            return yield* failConflict('node_rebuild_bootstrap_replay_mismatch')
          return outcome._tag === 'Success'
            ? { ...adopted, disposition: 'prepared' as const }
            : adopted
        }
        if (outcome._tag === 'Failure') return yield* outcome.failure
        return yield* failConflict('node_rebuild_bootstrap_not_adopted')
      })

  const recordNodeProviderRebuildObservation: NodeTerminationRepositoryShape['recordNodeProviderRebuildObservation'] =
    (input) =>
      Effect.gen(function* () {
        const bootstrap = yield* loadRebuildBootstrap(
          input.organizationId,
          input.operationId,
          input.nodeId,
        )
        if (bootstrap === null) return yield* failConflict('node_rebuild_bootstrap_unavailable')
        const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        if (run.action !== 'rebuild-node')
          return yield* failConflict('node_rebuild_observation_wrong_action')
        const target =
          input.observation.state === 'active'
            ? ('awaiting-agent' as const)
            : input.observation.state === 'rebuilding'
              ? ('provider-rebuilding' as const)
              : ('blocked' as const)
        if (bootstrap.state === 'ready' || bootstrap.state === target) return bootstrap
        if (bootstrap.state === 'blocked') return bootstrap
        const lifecycleState = target === 'blocked' ? 'blocked' : 'running'
        const operationState = target === 'blocked' ? 'waiting_external' : 'running'
        const runState = target === 'awaiting-agent' ? 'awaiting-agent' : 'rebuilding'
        const event = evidenceIds(
          `termination-node-provider-rebuild-${target}`,
          input.organizationId,
          input.operationId,
        )
        const auditStage = yield* stageNodeLifecycleAudit(database, {
          eventId: event.auditEventId,
          parentOperationId: input.operationId,
          organizationId: input.organizationId,
          nodeId: input.nodeId,
          kind: `provider-rebuild-${target}`,
          action: 'node.provider.rebuild.observed',
          before: { bootstrapState: bootstrap.state, runState: run.state },
          after: {
            bootstrapState: target,
            runState,
            providerState: input.observation.state,
          },
          now: input.now,
        })
        const bootstrapUpdate = database
          .prepare(`UPDATE node_lifecycle_rebuild_bootstraps
            SET state = ?, provider_observed_at = ?, updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND node_id = ? AND state = ?`)
          .bind(
            target,
            input.now,
            input.now,
            input.organizationId,
            input.operationId,
            input.nodeId,
            bootstrap.state,
          )
        const runUpdate = database
          .prepare(`UPDATE node_lifecycle_runs SET state = ?,
            blocked_reason = CASE WHEN ? = 'blocked' THEN 'provider-rebuild-state-ambiguous' ELSE NULL END,
            updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND node_id = ? AND action = 'rebuild-node'
              AND state IN ('rebuilding', 'awaiting-agent')`)
          .bind(runState, target, input.now, input.organizationId, input.operationId, input.nodeId)
        const lifecycleUpdate = database
          .prepare(`UPDATE destructive_lifecycle_operations
            SET state = ?, revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND operation_id = ? AND state IN ('running', 'blocked')`)
          .bind(lifecycleState, input.now, input.organizationId, input.operationId)
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = ?, revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND id = ?
              AND status IN ('running', 'waiting_external', 'retrying')`)
          .bind(operationState, input.now, input.organizationId, input.operationId)
        const auditInsert = database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, operation.organization_id, operation.actor_id, 'node.provider.rebuild.observed',
              'node', ?, 'succeeded', operation.correlation_id, ?, ?
            FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(
            event.auditEventId,
            input.nodeId,
            auditStage.summaryJson,
            input.now,
            input.organizationId,
            input.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, created_at)
            VALUES (?, ?, 'node.provider.rebuild.observed', 'operation', ?, ?, 'pending', 0, ?, ?)`)
          .bind(
            event.outboxEventId,
            input.organizationId,
            input.operationId,
            JSON.stringify({
              nodeId: input.nodeId,
              providerState: input.observation.state,
              state: target,
            }),
            input.now,
            input.now,
          )
        const receiptInsert = database
          .prepare(`INSERT INTO destructive_lifecycle_atomic_receipts
            (organization_id, operation_id, receipt_key, workflow_start_record_id,
             audit_event_id, outbox_event_id, created_at)
            VALUES (?, ?, ?, NULL, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            `node-provider-rebuild-${target}`,
            event.auditEventId,
            event.outboxEventId,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.node-rebuild-provider-observation.record', () =>
            database.batch([
              bootstrapUpdate,
              runUpdate,
              lifecycleUpdate,
              operationUpdate,
              auditStage.operation,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
            ]),
          ),
        )
        const adopted = yield* loadRebuildBootstrap(
          input.organizationId,
          input.operationId,
          input.nodeId,
        )
        if (adopted !== null && adopted.state === target) return adopted
        if (outcome._tag === 'Failure') return yield* outcome.failure
        return yield* failConflict('node_rebuild_provider_observation_not_adopted')
      })

  const completeNodeRebuild: NodeTerminationRepositoryShape['completeNodeRebuild'] = (input) =>
    Effect.gen(function* () {
      const bootstrap = yield* loadRebuildBootstrap(
        input.organizationId,
        input.operationId,
        input.nodeId,
      )
      if (bootstrap === null) return yield* failConflict('node_rebuild_bootstrap_unavailable')
      const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (run.action !== 'rebuild-node')
        return yield* failConflict('node_rebuild_completion_wrong_action')
      if (bootstrap.state === 'ready') {
        if (run.state === 'completed') return { state: 'completed' as const }
        return yield* failConflict('node_rebuild_ready_receipt_incomplete')
      }
      if (bootstrap.state !== 'awaiting-agent')
        return yield* failConflict('node_rebuild_agent_readiness_pending')
      const observation = yield* loadRebuildReadyObservation(
        input.organizationId,
        input.operationId,
        input.nodeId,
      )
      const facts = yield* loadFacts(input.organizationId, input.operationId)
      if (facts.facts.phase !== 'destructive-step-running')
        return yield* failConflict('node_rebuild_completion_step_not_active')
      const event = evidenceIds(
        'termination-node-rebuild-ready',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageNodeLifecycleAudit(database, {
        eventId: event.auditEventId,
        parentOperationId: input.operationId,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        kind: 'rebuild-ready',
        action: 'node.rebuild.ready',
        before: {
          state: run.state,
          bootstrapState: bootstrap.state,
          desiredRevision: bootstrap.nodeDesiredRevision,
        },
        after: {
          state: 'completed',
          desiredState: 'ready',
          desiredRevision: bootstrap.nodeDesiredRevision + 1,
          observationRevision: observation.observationRevision,
          imageId: bootstrap.imageId,
          imageVersion: bootstrap.imageVersion,
          imageChecksum: bootstrap.imageChecksum,
        },
        now: input.now,
      })
      const nodeUpdate = database
        .prepare(`UPDATE nodes
          SET desired_state = 'ready', desired_revision = ?, observed_state = 'ready',
              observed_revision = ?, pending_lifecycle_operation_id = NULL,
              reconciliation_error = NULL, last_reconciled_at = ?, updated_at = ?
          WHERE organization_id = ? AND id = ? AND desired_state = 'provisioning'
            AND desired_revision = ? AND observed_revision = ?
            AND pending_lifecycle_operation_id = ? AND image_id = ?`)
        .bind(
          bootstrap.nodeDesiredRevision + 1,
          observation.observationRevision,
          input.now,
          input.now,
          input.organizationId,
          input.nodeId,
          bootstrap.nodeDesiredRevision,
          observation.observationRevision,
          input.operationId,
          bootstrap.imageId,
        )
      const capacityUpsert = database
        .prepare(`INSERT INTO node_runtime_capacity
          (organization_id, node_id, architecture, cpu_millis, ram_bytes, disk_bytes,
           agent_ready, tunnel_ready, docker_ready, firewall_ready, reported_at, revision)
          SELECT aggregate.organization_id, aggregate.node_id,
            json_extract(aggregate.summary_json, '$.architecture'),
            json_extract(aggregate.summary_json, '$.cpuMillis'),
            json_extract(aggregate.summary_json, '$.ramBytes'),
            json_extract(aggregate.summary_json, '$.diskBytes'),
            1, 1, 1, 1, ?, 1
          FROM agent_observation_aggregates aggregate
          WHERE aggregate.organization_id = ? AND aggregate.node_id = ?
            AND aggregate.fact_kind = 'capacity' AND aggregate.sequence = ?
            AND aggregate.observed_revision = ?
          ON CONFLICT (organization_id, node_id) DO UPDATE SET
            architecture = excluded.architecture,
            cpu_millis = excluded.cpu_millis,
            ram_bytes = excluded.ram_bytes,
            disk_bytes = excluded.disk_bytes,
            agent_ready = 1, tunnel_ready = 1, docker_ready = 1, firewall_ready = 1,
            reported_at = excluded.reported_at, revision = node_runtime_capacity.revision + 1`)
        .bind(
          input.now,
          input.organizationId,
          input.nodeId,
          observation.observationSequence,
          observation.observationRevision,
        )
      const runUpdate = database
        .prepare(`UPDATE node_lifecycle_runs SET state = 'completed', blocked_reason = NULL,
          updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND node_id = ?
            AND action = 'rebuild-node' AND state = 'awaiting-agent'`)
        .bind(input.now, input.organizationId, input.operationId, input.nodeId)
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'succeeded', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state = 'running'`)
        .bind(input.now, input.organizationId, input.operationId)
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'succeeded', progress = 100,
          revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status = 'running'`)
        .bind(input.now, input.organizationId, input.operationId)
      const factsUpdate = database
        .prepare(`UPDATE operation_cancellation_facts
          SET phase = 'terminal', active_step_name = NULL, active_step_ordinal = NULL,
              revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND revision = ?
            AND phase = 'destructive-step-running'`)
        .bind(input.now, input.organizationId, input.operationId, facts.facts.revision)
      const auditInsert = database
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'node.rebuild.ready',
            'node', ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          input.nodeId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'node.rebuild.ready', 'node', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.nodeId,
          JSON.stringify({
            nodeId: input.nodeId,
            operationId: input.operationId,
            observationRevision: observation.observationRevision,
            imageId: bootstrap.imageId,
            imageChecksum: bootstrap.imageChecksum,
          }),
          input.now,
          input.now,
        )
      const receiptInsert = database
        .prepare(`INSERT INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'node-rebuild-ready', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const readyReceiptInsert = database
        .prepare(`INSERT INTO node_lifecycle_rebuild_ready_receipts
          (organization_id, operation_id, node_id, credential_id, credential_version,
           session_version, observation_sequence, observation_revision, observation_fingerprint,
           completion_operation_id, audit_event_id, outbox_event_id, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          input.nodeId,
          observation.credentialId,
          observation.credentialVersion,
          observation.sessionVersion,
          observation.observationSequence,
          observation.observationRevision,
          observation.observationFingerprint,
          `${input.operationId}-audit-rebuild-ready`,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const bootstrapUpdate = database
        .prepare(`UPDATE node_lifecycle_rebuild_bootstraps SET state = 'ready', updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND node_id = ? AND state = 'awaiting-agent'`)
        .bind(input.now, input.organizationId, input.operationId, input.nodeId)
      const outcome = yield* Effect.result(
        attempt('termination.node-rebuild.complete', () =>
          database.batch([
            nodeUpdate,
            capacityUpsert,
            runUpdate,
            lifecycleUpdate,
            operationUpdate,
            factsUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
            readyReceiptInsert,
            bootstrapUpdate,
          ]),
        ),
      )
      const adoptedBootstrap = yield* loadRebuildBootstrap(
        input.organizationId,
        input.operationId,
        input.nodeId,
      )
      const adoptedRun = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (adoptedBootstrap?.state === 'ready' && adoptedRun.state === 'completed')
        return { state: 'completed' as const }
      if (outcome._tag === 'Failure') return yield* outcome.failure
      return yield* failConflict('node_rebuild_completion_not_adopted')
    })

  const recordNodeProviderRetirement: NodeTerminationRepositoryShape['recordNodeProviderRetirement'] =
    (input) =>
      Effect.gen(function* () {
        const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        if (run.action !== 'retire-node')
          return yield* failConflict('node_retirement_receipt_wrong_action')
        const receipt = input.receipt
        if (
          (receipt.state === 'cancel-scheduled' &&
            (receipt.billingState !== 'continues-until-cancellation' ||
              receipt.cancellationDate === undefined ||
              receipt.billingStopsAt === undefined)) ||
          ((receipt.state === 'deleted-confirmed' || receipt.state === 'contract-ended') &&
            receipt.billingState !== 'stopped')
        )
          return yield* failConflict('provider_retirement_billing_truth_missing')
        const target =
          receipt.state === 'cancel-scheduled'
            ? 'cancel-scheduled'
            : receipt.state === 'ambiguous'
              ? 'blocked'
              : receipt.state === 'delete-requested'
                ? 'awaiting-provider-confirmation'
                : 'retiring'
        const lifecycleState =
          target === 'blocked'
            ? 'blocked'
            : target === 'cancel-scheduled'
              ? 'waiting-external'
              : 'running'
        const operationState =
          target === 'blocked' || target === 'cancel-scheduled' ? 'waiting_external' : 'running'
        const event = evidenceIds(
          `termination-node-provider-${receipt.state}`,
          input.organizationId,
          input.operationId,
        )
        const auditStage = yield* stageNodeLifecycleAudit(database, {
          eventId: event.auditEventId,
          parentOperationId: input.operationId,
          organizationId: input.organizationId,
          nodeId: input.nodeId,
          kind: `provider-retirement-${receipt.state}`,
          action: 'node.provider.retirement-observed',
          before: {
            state: run.state,
            providerRetirementState: run.providerRetirementState,
            billingState: run.billingState,
          },
          after: {
            state: target,
            providerRetirementState: receipt.state,
            billingState: receipt.billingState,
            cancellationDate: receipt.cancellationDate ?? null,
            billingStopsAt: receipt.billingStopsAt ?? null,
            providerRequestReference: receipt.providerRequestReference ?? null,
          },
          now: input.now,
        })
        const runUpdate = database
          .prepare(`UPDATE node_lifecycle_runs
          SET state = ?, provider_retirement_state = ?, billing_state = ?, cancellation_date = ?,
              billing_stops_at = ?, provider_request_reference = ?,
              blocked_reason = CASE WHEN ? = 'blocked' THEN 'provider-state-ambiguous' ELSE NULL END,
              updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND node_id = ?
            AND action = 'retire-node'
            AND state IN ('retiring', 'awaiting-provider-confirmation', 'cancel-scheduled', 'blocked')`)
          .bind(
            target,
            receipt.state,
            receipt.billingState,
            receipt.cancellationDate ?? null,
            receipt.billingStopsAt ?? null,
            receipt.providerRequestReference ?? null,
            target,
            input.now,
            input.organizationId,
            input.operationId,
            input.nodeId,
          )
        const lifecycleUpdate = database
          .prepare(`UPDATE destructive_lifecycle_operations
          SET state = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
          .bind(lifecycleState, input.now, input.organizationId, input.operationId)
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = ?, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ?
            AND status IN ('queued', 'running', 'waiting_external', 'retrying')`)
          .bind(operationState, input.now, input.organizationId, input.operationId)
        const auditInsert = database
          .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'node.provider.retirement-observed',
            'node', ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(
            event.auditEventId,
            input.nodeId,
            auditStage.summaryJson,
            input.now,
            input.organizationId,
            input.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'node.provider.retirement-observed', 'operation', ?, ?, 'pending', 0, ?, ?)`)
          .bind(
            event.outboxEventId,
            input.organizationId,
            input.operationId,
            JSON.stringify({ nodeId: input.nodeId, state: receipt.state }),
            input.now,
            input.now,
          )
        const receiptInsert = database
          .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            `node-provider-${receipt.state}`,
            event.auditEventId,
            event.outboxEventId,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.node-run.record-provider-retirement', () =>
            database.batch([
              runUpdate,
              lifecycleUpdate,
              operationUpdate,
              auditStage.operation,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
            ]),
          ),
        )
        if (outcome._tag === 'Failure') {
          const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
          if (
            adopted.providerRetirementState === receipt.state &&
            adopted.billingState === receipt.billingState
          )
            return
          return yield* outcome.failure
        }
        const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        if (
          adopted.providerRetirementState !== receipt.state ||
          adopted.billingState !== receipt.billingState
        )
          return yield* failConflict('provider_retirement_receipt_not_adopted')
      })

  const revokeNodeCredentials: NodeTerminationRepositoryShape['revokeNodeCredentials'] = (input) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (run.action !== 'retire-node')
        return yield* failConflict('node_credential_revoke_wrong_action')
      const event = evidenceIds(
        'termination-node-credentials-revoked',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageNodeLifecycleAudit(database, {
        eventId: event.auditEventId,
        parentOperationId: input.operationId,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        kind: 'credentials-revoked',
        action: 'node.credentials.revoked',
        before: {
          state: run.state,
          credentialRevocation: 'pending',
        },
        after: {
          state: run.state,
          credentialRevocation: 'completed',
        },
        now: input.now,
      })
      const credentials = database
        .prepare(`UPDATE node_credentials SET status = 'revoked', revoked_at = ?
          WHERE organization_id = ? AND node_id = ? AND status = 'active'`)
        .bind(input.now, input.organizationId, input.nodeId)
      const sessions = database
        .prepare(`UPDATE agent_sessions SET session_state = 'revoked', revision = revision + 1
          WHERE organization_id = ? AND node_id = ? AND session_state <> 'revoked'`)
        .bind(input.organizationId, input.nodeId)
      const tokens = database
        .prepare(`UPDATE node_registration_tokens SET revoked_at = ?
          WHERE organization_id = ? AND node_id = ? AND revoked_at IS NULL`)
        .bind(input.now, input.organizationId, input.nodeId)
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'node.credentials.revoked',
            'node', ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          input.nodeId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'node.credentials.revoked', 'operation', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.operationId,
          JSON.stringify({ nodeId: input.nodeId }),
          input.now,
          input.now,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'node-credentials-revoked', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.node-run.revoke-credentials', () =>
          database.batch([
            credentials,
            sessions,
            tokens,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const active = yield* attempt('termination.node-run.revoke-credentials.adopt', () =>
          database
            .prepare(`SELECT
              (SELECT COUNT(*) FROM node_credentials WHERE organization_id = ? AND node_id = ? AND status = 'active') +
              (SELECT COUNT(*) FROM agent_sessions WHERE organization_id = ? AND node_id = ? AND session_state <> 'revoked') +
              (SELECT COUNT(*) FROM node_registration_tokens WHERE organization_id = ? AND node_id = ? AND revoked_at IS NULL)
              AS count`)
            .bind(
              input.organizationId,
              input.nodeId,
              input.organizationId,
              input.nodeId,
              input.organizationId,
              input.nodeId,
            )
            .first(),
        ).pipe(
          Effect.flatMap((row) =>
            numberValue(row, 'termination.node-run.revoke-credentials.adopt'),
          ),
        )
        if (active === 0) return
        return yield* outcome.failure
      }
      const active = yield* attempt('termination.node-run.revoke-credentials.verify', () =>
        database
          .prepare(`SELECT
            (SELECT COUNT(*) FROM node_credentials WHERE organization_id = ? AND node_id = ? AND status = 'active') +
            (SELECT COUNT(*) FROM agent_sessions WHERE organization_id = ? AND node_id = ? AND session_state <> 'revoked') +
            (SELECT COUNT(*) FROM node_registration_tokens WHERE organization_id = ? AND node_id = ? AND revoked_at IS NULL)
            AS count`)
          .bind(
            input.organizationId,
            input.nodeId,
            input.organizationId,
            input.nodeId,
            input.organizationId,
            input.nodeId,
          )
          .first(),
      ).pipe(
        Effect.flatMap((row) => numberValue(row, 'termination.node-run.revoke-credentials.verify')),
      )
      if (active !== 0) return yield* failConflict('node_credential_revoke_not_adopted')
    })

  const recordNodeTunnelDeleted: NodeTerminationRepositoryShape['recordNodeTunnelDeleted'] = (
    input,
  ) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (run.action !== 'retire-node')
        return yield* failConflict('node_tunnel_delete_wrong_action')
      const current = yield* attempt('termination.node-run.tunnel.load', () =>
        database
          .prepare(`SELECT tunnel_id AS tunnelId, state, revision
              FROM tunnels WHERE organization_id = ? AND node_id = ?`)
          .bind(input.organizationId, input.nodeId)
          .first(),
      )
      const tunnel = object(current)
      const tunnelId = tunnel === undefined ? undefined : text(tunnel, 'tunnelId')
      const state = tunnel === undefined ? undefined : text(tunnel, 'state')
      const revision = tunnel === undefined ? undefined : integer(tunnel, 'revision')
      if (
        tunnelId !== input.tunnelId ||
        revision === undefined ||
        revision < 1 ||
        (state !== 'pending' &&
          state !== 'connected' &&
          state !== 'degraded' &&
          state !== 'failed' &&
          state !== 'deleted')
      )
        return yield* failConflict('node_tunnel_binding_unavailable')
      const receiptPresent = () =>
        attempt('termination.node-run.tunnel.receipt', () =>
          database
            .prepare(`SELECT 1 AS present FROM destructive_lifecycle_atomic_receipts
                WHERE organization_id = ? AND operation_id = ? AND receipt_key = 'node-tunnel-deleted'`)
            .bind(input.organizationId, input.operationId)
            .first(),
        ).pipe(
          Effect.flatMap((value) =>
            object(value)?.present === 1
              ? Effect.void
              : Effect.fail(
                  new TerminationConflictError({ code: 'node_tunnel_delete_receipt_unavailable' }),
                ),
          ),
        )
      if (state === 'deleted') {
        if (revision !== input.expectedTunnelRevision + 1)
          return yield* failConflict('node_tunnel_revision_conflict')
        yield* receiptPresent()
        return
      }
      if (revision !== input.expectedTunnelRevision)
        return yield* failConflict('node_tunnel_revision_conflict')
      const event = evidenceIds(
        'termination-node-tunnel-deleted',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageNodeLifecycleAudit(database, {
        eventId: event.auditEventId,
        parentOperationId: input.operationId,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        kind: 'tunnel-deleted',
        action: 'node.tunnel.deleted',
        before: { state, tunnelId, revision },
        after: { state: 'deleted', tunnelId, revision: revision + 1 },
        now: input.now,
      })
      const tunnelUpdate = database
        .prepare(`UPDATE tunnels SET state = 'deleted', revision = revision + 1
            WHERE organization_id = ? AND node_id = ? AND tunnel_id = ? AND revision = ?
              AND state IN ('pending', 'connected', 'degraded', 'failed')`)
        .bind(input.organizationId, input.nodeId, input.tunnelId, input.expectedTunnelRevision)
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            SELECT ?, operation.organization_id, operation.actor_id, 'node.tunnel.deleted',
              'node', ?, 'succeeded', operation.correlation_id, ?, ?
            FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          input.nodeId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
             publish_state, retry_count, available_at, created_at)
            VALUES (?, ?, 'node.tunnel.deleted', 'operation', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.operationId,
          JSON.stringify({ nodeId: input.nodeId, tunnelId: input.tunnelId }),
          input.now,
          input.now,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
            (organization_id, operation_id, receipt_key, workflow_start_record_id,
             audit_event_id, outbox_event_id, created_at)
            VALUES (?, ?, 'node-tunnel-deleted', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.node-run.record-tunnel-deleted', () =>
          database.batch([
            tunnelUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* attempt('termination.node-run.tunnel.adopt', () =>
          database
            .prepare(`SELECT tunnel_id AS tunnelId, state, revision FROM tunnels
                WHERE organization_id = ? AND node_id = ?`)
            .bind(input.organizationId, input.nodeId)
            .first(),
        )
        const adoptedTunnel = object(adopted)
        if (
          text(adoptedTunnel ?? {}, 'tunnelId') === input.tunnelId &&
          text(adoptedTunnel ?? {}, 'state') === 'deleted' &&
          integer(adoptedTunnel ?? {}, 'revision') === input.expectedTunnelRevision + 1
        ) {
          yield* receiptPresent()
          return
        }
        return yield* outcome.failure
      }
      const adopted = yield* attempt('termination.node-run.tunnel.verify', () =>
        database
          .prepare(`SELECT tunnel_id AS tunnelId, state, revision FROM tunnels
              WHERE organization_id = ? AND node_id = ?`)
          .bind(input.organizationId, input.nodeId)
          .first(),
      )
      const adoptedTunnel = object(adopted)
      if (
        text(adoptedTunnel ?? {}, 'tunnelId') !== input.tunnelId ||
        text(adoptedTunnel ?? {}, 'state') !== 'deleted' ||
        integer(adoptedTunnel ?? {}, 'revision') !== input.expectedTunnelRevision + 1
      )
        return yield* failConflict('node_tunnel_delete_not_adopted')
      yield* receiptPresent()
    })

  const finalizeNodeRetirement: NodeTerminationRepositoryShape['finalizeNodeRetirement'] = (
    input,
  ) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (run.action !== 'retire-node')
        return yield* failConflict('node_retirement_finalize_wrong_action')
      if (run.state === 'completed') return
      if (
        run.providerRetirementState !== 'deleted-confirmed' &&
        run.providerRetirementState !== 'contract-ended'
      )
        return yield* failConflict('node_retirement_provider_not_confirmed')
      const cleanup = yield* attempt('termination.node-run.finalize.cleanup', () =>
        database
          .prepare(`SELECT
            EXISTS (
              SELECT 1 FROM tunnels WHERE organization_id = ? AND node_id = ? AND state = 'deleted'
            ) AS tunnelDeleted,
            EXISTS (
              SELECT 1 FROM destructive_lifecycle_atomic_receipts
              WHERE organization_id = ? AND operation_id = ? AND receipt_key = 'node-tunnel-deleted'
            ) AS tunnelReceipt,
            EXISTS (
              SELECT 1 FROM destructive_lifecycle_atomic_receipts
              WHERE organization_id = ? AND operation_id = ? AND receipt_key = 'node-credentials-revoked'
            ) AS credentialReceipt`)
          .bind(
            input.organizationId,
            input.nodeId,
            input.organizationId,
            input.operationId,
            input.organizationId,
            input.operationId,
          )
          .first(),
      )
      const cleanupFacts = object(cleanup)
      if (
        cleanupFacts === undefined ||
        integer(cleanupFacts, 'tunnelDeleted') !== 1 ||
        integer(cleanupFacts, 'tunnelReceipt') !== 1 ||
        integer(cleanupFacts, 'credentialReceipt') !== 1
      )
        return yield* failConflict('node_retirement_cleanup_not_confirmed')
      const facts = yield* loadFacts(input.organizationId, input.operationId)
      const event = evidenceIds(
        'termination-node-retirement-finalized',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageNodeLifecycleAudit(database, {
        eventId: event.auditEventId,
        parentOperationId: input.operationId,
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        kind: 'retirement-finalized',
        action: 'node.retirement.finalized',
        before: {
          state: run.state,
          providerRetirementState: run.providerRetirementState,
          billingState: run.billingState,
        },
        after: {
          state: 'completed',
          providerRetirementState: run.providerRetirementState,
          billingState: run.billingState,
          desiredState: 'deleted',
          observedState: 'deleted',
        },
        now: input.now,
      })
      const nodeUpdate = database
        .prepare(`UPDATE nodes SET desired_state = 'deleted', desired_revision = desired_revision + 1,
          observed_state = 'deleted', observed_revision = desired_revision + 1,
          pending_lifecycle_operation_id = NULL, updated_at = ?
          WHERE organization_id = ? AND id = ? AND pending_lifecycle_operation_id = ?`)
        .bind(input.now, input.organizationId, input.nodeId, input.operationId)
      const runUpdate = database
        .prepare(`UPDATE node_lifecycle_runs SET state = 'completed', blocked_reason = NULL, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND node_id = ? AND action = 'retire-node'
            AND provider_retirement_state IN ('deleted-confirmed', 'contract-ended')
            AND billing_state = 'stopped'
            AND state IN ('retiring', 'awaiting-provider-confirmation')`)
        .bind(input.now, input.organizationId, input.operationId, input.nodeId)
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'succeeded', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
        .bind(input.now, input.organizationId, input.operationId)
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ?
            AND status IN ('queued', 'running', 'waiting_external', 'retrying')`)
        .bind(input.now, input.organizationId, input.operationId)
      const factsUpdate = database
        .prepare(`UPDATE operation_cancellation_facts
          SET phase = 'terminal', active_step_name = NULL, active_step_ordinal = NULL,
              revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND revision = ?`)
        .bind(input.now, input.organizationId, input.operationId, facts.facts.revision)
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'node.retirement.finalized',
            'node', ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          input.nodeId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'node.retirement.finalized', 'operation', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.operationId,
          JSON.stringify({ nodeId: input.nodeId }),
          input.now,
          input.now,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'node-retirement-finalized', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.node-run.finalize-retirement', () =>
          database.batch([
            nodeUpdate,
            runUpdate,
            lifecycleUpdate,
            operationUpdate,
            factsUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
        if (adopted.state === 'completed') return
        return yield* outcome.failure
      }
      const adopted = yield* loadRun(input.organizationId, input.operationId, input.nodeId)
      if (adopted.state !== 'completed')
        return yield* failConflict('node_retirement_finalization_not_adopted')
    })

  return {
    listAffectedServers,
    markAffectedServerResolved,
    completeNodeDrain,
    claimNodeProviderDestructiveAction,
    prepareNodeRebuildBootstrap,
    loadNodeRebuildBootstrap: (input) =>
      loadRebuildBootstrap(input.organizationId, input.operationId, input.nodeId),
    recordNodeProviderRebuildObservation,
    completeNodeRebuild,
    recordNodeProviderRetirement,
    recordNodeTunnelDeleted,
    revokeNodeCredentials,
    finalizeNodeRetirement,
  }
}

export const NodeTerminationD1RepositoryLayer = (repository: NodeTerminationRepositoryShape) =>
  Layer.succeed(NodeTerminationRepository, repository)

interface OrganizationDeletionRunRecord {
  readonly organizationId: string
  readonly operationId: string
  readonly backupPolicy: 'retain' | 'delete-after-retention'
  readonly state: OrganizationDeletionAcceptance['state']
  readonly blockedReason?: string
}

const organizationDeletionRunSelect = `SELECT organization_id AS organizationId, operation_id AS operationId,
  backup_policy AS backupPolicy, state AS runState, blocked_reason AS blockedReason
  FROM organization_deletion_runs`

const decodeOrganizationDeletionRun = (
  value: unknown,
): Effect.Effect<OrganizationDeletionRunRecord, TerminationPersistenceError> => {
  const row = object(value)
  const organizationId = row === undefined ? undefined : text(row, 'organizationId')
  const operationId = row === undefined ? undefined : text(row, 'operationId')
  const backupPolicy = row === undefined ? undefined : text(row, 'backupPolicy')
  const state = row === undefined ? undefined : text(row, 'runState')
  const blockedReason = row === undefined ? undefined : text(row, 'blockedReason')
  if (
    organizationId === undefined ||
    operationId === undefined ||
    (backupPolicy !== 'retain' && backupPolicy !== 'delete-after-retention') ||
    ![
      'accepted',
      'inventorying',
      'draining',
      'retiring',
      'revoking',
      'cleaning-networking',
      'blocked',
      'ready-to-tombstone',
      'tombstoned',
      'cancelled',
    ].includes(state ?? '')
  )
    return Effect.fail(persistence('termination.organization-run.decode', 'invalid deletion run'))
  return Effect.succeed({
    organizationId,
    operationId,
    backupPolicy,
    state: state as OrganizationDeletionAcceptance['state'],
    ...(blockedReason === undefined ? {} : { blockedReason }),
  })
}

const decodeDeletionInventory = (
  value: unknown,
): Effect.Effect<OrganizationDeletionInventory, TerminationPersistenceError> => {
  const row = object(value)
  const unresolvedPaidResources =
    row === undefined ? undefined : integer(row, 'unresolvedPaidResources')
  const unresolvedResources = row === undefined ? undefined : integer(row, 'unresolvedResources')
  const retainedBackups = row === undefined ? undefined : integer(row, 'retainedBackups')
  const blockedReason = row === undefined ? undefined : text(row, 'blockedReason')
  if (
    unresolvedPaidResources === undefined ||
    unresolvedResources === undefined ||
    retainedBackups === undefined ||
    unresolvedPaidResources < 0 ||
    unresolvedResources < 0 ||
    retainedBackups < 0
  )
    return Effect.fail(
      persistence('termination.organization-inventory.decode', 'invalid inventory count'),
    )
  return Effect.succeed({
    unresolvedPaidResources,
    unresolvedResources,
    retainedBackups,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  })
}

/**
 * Organization deletion is intentionally an inventory-and-tombstone protocol. Physical cleanup
 * is performed by exact tenant-scoped workflow actions, and the final D1 guard refuses deletion
 * until every paid or ambiguous resource has durable resolution evidence.
 */
export const makeOrganizationDeletionD1Repository = (
  database: LifecycleTerminationD1Database,
): OrganizationDeletionRepositoryShape => {
  const loadRun = (organizationId: string, operationId: string) =>
    Effect.flatMap(
      attempt('termination.organization-run.load', () =>
        database
          .prepare(
            `${organizationDeletionRunSelect} WHERE organization_id = ? AND operation_id = ?`,
          )
          .bind(organizationId, operationId)
          .first(),
      ),
      (row) =>
        row === null
          ? Effect.fail(
              persistence('termination.organization-run.load', 'run not found or cross tenant'),
            )
          : decodeOrganizationDeletionRun(row),
    )

  const inventorySummary = (organizationId: string, operationId: string) =>
    Effect.flatMap(
      attempt('termination.organization-inventory.summary', () =>
        database
          .prepare(`SELECT
            COALESCE(SUM(CASE WHEN state IN ('pending', 'ambiguous', 'blocked') AND paid = 1 THEN 1 ELSE 0 END), 0)
              AS unresolvedPaidResources,
            COALESCE(SUM(CASE WHEN state IN ('pending', 'ambiguous', 'blocked') THEN 1 ELSE 0 END), 0)
              AS unresolvedResources,
            COALESCE(SUM(CASE WHEN kind = 'backup' AND state = 'retained' THEN 1 ELSE 0 END), 0)
              AS retainedBackups,
            (SELECT blocked_reason FROM organization_deletion_runs
              WHERE organization_id = ? AND operation_id = ?) AS blockedReason
          FROM organization_deletion_items
          WHERE organization_id = ? AND operation_id = ?`)
          .bind(organizationId, operationId, organizationId, operationId)
          .first(),
      ),
      (row) => decodeDeletionInventory(row),
    )

  const stageOrganizationAudit = (input: {
    readonly eventId: string
    readonly organizationId: string
    readonly operationId: string
    readonly action: string
    readonly targetType: string
    readonly targetId: string
    readonly before: Readonly<Record<string, unknown>>
    readonly after: Readonly<Record<string, unknown>>
    readonly now: string
  }) =>
    Effect.gen(function* () {
      const raw = yield* attempt('termination.organization-audit.context', () =>
        database
          .prepare(`SELECT operation.actor_id AS actorId,
            operation.correlation_id AS correlationId,
            run.audit_request_context_json AS auditRequestContext
          FROM operations operation JOIN organization_deletion_runs run
            ON run.organization_id = operation.organization_id
           AND run.operation_id = operation.id
          WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(input.organizationId, input.operationId)
          .first(),
      )
      const row = object(raw)
      const actorId = row === undefined ? undefined : text(row, 'actorId')
      const correlationId = row === undefined ? undefined : text(row, 'correlationId')
      const encoded = row === undefined ? undefined : text(row, 'auditRequestContext')
      if (actorId === undefined || correlationId === undefined || encoded === undefined)
        return yield* persistence(
          'termination.organization-audit.context',
          'deletion audit provenance is unavailable',
        )
      const parsed = yield* Effect.try({
        try: () => JSON.parse(encoded) as unknown,
        catch: (cause) => persistence('termination.organization-audit.context', cause),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(AuditRequestContextValue, {
            onExcessProperty: 'error',
          })(value).pipe(
            Effect.mapError((cause) =>
              persistence('termination.organization-audit.context', cause),
            ),
          ),
        ),
      )
      const childOperationId = `${input.eventId}-operation`
      const operation = database
        .prepare(`INSERT OR IGNORE INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
        .bind(
          childOperationId,
          input.organizationId,
          input.action,
          input.targetType,
          input.targetId,
          actorId,
          childOperationId,
          correlationId,
          input.now,
          input.now,
        )
      const staged = yield* stageTerminationAudit(database, {
        ...input,
        operationId: childOperationId,
        actorId,
        actorType: 'human',
        correlationId,
        request: parsed,
      })
      return { operation, ...staged }
    })

  const inventory: OrganizationDeletionRepositoryShape['inventory'] = (input) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId)
      if (run.state === 'tombstoned' || run.state === 'cancelled')
        return yield* failConflict('organization_deletion_not_inventoryable')
      const event = evidenceIds(
        'termination-organization-inventoried',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageOrganizationAudit({
        eventId: event.auditEventId,
        organizationId: input.organizationId,
        operationId: input.operationId,
        action: 'organization.delete.inventoried',
        targetType: 'organization',
        targetId: input.organizationId,
        before: { state: run.state },
        after: { state: 'inventorying' },
        now: input.now,
      })
      const runUpdate = database
        .prepare(`UPDATE organization_deletion_runs SET state = 'inventorying', blocked_reason = NULL, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state IN ('accepted', 'inventorying')`)
        .bind(input.now, input.organizationId, input.operationId)
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')`)
        .bind(input.now, input.organizationId, input.operationId)
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations SET state = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
        .bind(input.now, input.organizationId, input.operationId)
      const items = [
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'node', node.id, 'pending',
              CASE WHEN node.provider_instance_id IS NULL THEN 0 ELSE 1 END,
              json_object('providerType', node.provider_type, 'providerInstanceId', node.provider_instance_id),
              NULL, ?, NULL
            FROM organization_deletion_runs run JOIN nodes node ON node.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND node.desired_state <> 'deleted'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'game-server', server.id, 'pending', 0,
              json_object('desiredState', server.desired_state, 'observedState', server.observed_state),
              NULL, ?, NULL
            FROM organization_deletion_runs run JOIN game_servers server ON server.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND server.observed_state <> 'deleted'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'deployment', deployment.id, 'pending', 0,
              json_object('serverId', deployment.server_id, 'nodeId', deployment.node_id), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN deployments deployment ON deployment.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND deployment.observed_state <> 'deleted'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'backup', backup.id,
              CASE WHEN run.backup_policy = 'retain' THEN 'retained' ELSE 'pending' END,
              0, json_object('serverId', backup.server_id, 'state', backup.state),
              CASE WHEN run.backup_policy = 'retain' THEN json_object('policy', 'retain') ELSE NULL END,
              ?, CASE WHEN run.backup_policy = 'retain' THEN ? ELSE NULL END
            FROM organization_deletion_runs run JOIN backups backup ON backup.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ?
              AND (
                (run.backup_policy = 'retain' AND backup.state <> 'deleted')
                OR (run.backup_policy = 'delete-after-retention' AND NOT EXISTS (
                  SELECT 1
                  FROM backup_physical_deletion_receipts receipt
                  JOIN backup_deletion_claims claim
                    ON claim.organization_id = receipt.organization_id
                   AND claim.id = receipt.claim_id
                  JOIN operations operation
                    ON operation.organization_id = receipt.organization_id
                   AND operation.id = receipt.operation_id
                  WHERE receipt.organization_id = backup.organization_id
                    AND receipt.backup_id = backup.id
                    AND receipt.r2_key = backup.r2_key
                    AND backup.state = 'deleted'
                    AND claim.state = 'deleted'
                    AND operation.status = 'succeeded'
                ))
              )`)
          .bind(input.now, input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'tunnel', tunnel.node_id, 'pending', 0,
              json_object('tunnelId', tunnel.tunnel_id, 'hostname', tunnel.hostname), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN tunnels tunnel ON tunnel.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND tunnel.state <> 'deleted'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'dns-record', record.id, 'pending', 0,
              json_object('hostname', record.hostname, 'serverId', record.server_id), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN dns_records record ON record.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND record.state <> 'deleted'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'node-credential', credential.id, 'pending', 0,
              json_object('nodeId', credential.node_id), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN node_credentials credential ON credential.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND credential.status = 'active'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'node-registration-token', token.token_hash,
              'pending', 0, json_object('nodeId', token.node_id), NULL, ?, NULL
            FROM organization_deletion_runs run
            JOIN node_registration_tokens token ON token.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND token.revoked_at IS NULL`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'agent-session', session.node_id, 'pending', 0,
              json_object('credentialId', session.credential_id), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN agent_sessions session ON session.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND session.session_state <> 'revoked'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'automation-identity', identity.id, 'pending', 0,
              json_object('name', identity.name), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN automation_identities identity ON identity.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND identity.status = 'active'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'provider-account', account.id, 'pending', 1,
              json_object('providerType', account.provider_type, 'status', account.status), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN provider_accounts account ON account.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ?
              AND account.scope = 'organization' AND account.status = 'active'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'server-capacity-reservation', reservation.id,
              'pending', 0, json_object('serverId', reservation.server_id, 'nodeId', reservation.node_id),
              NULL, ?, NULL
            FROM organization_deletion_runs run
            JOIN server_capacity_reservations reservation ON reservation.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND reservation.state <> 'released'`)
          .bind(input.now, input.organizationId, input.operationId),
        database
          .prepare(`INSERT OR IGNORE INTO organization_deletion_items
            (organization_id, operation_id, kind, resource_id, state, paid, summary_json,
             resolution_evidence_json, discovered_at, resolved_at)
            SELECT run.organization_id, run.operation_id, 'port-lease', lease.id, 'pending', 0,
              json_object('serverId', lease.server_id, 'nodeId', lease.node_id), NULL, ?, NULL
            FROM organization_deletion_runs run JOIN port_leases lease ON lease.organization_id = run.organization_id
            WHERE run.organization_id = ? AND run.operation_id = ? AND lease.state <> 'released'`)
          .bind(input.now, input.organizationId, input.operationId),
      ]
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'organization.delete.inventoried',
            'organization', operation.resource_id, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'organization.delete.inventoried', 'operation', ?, '{}', 'pending', 0, ?, ?)`)
        .bind(event.outboxEventId, input.organizationId, input.operationId, input.now, input.now)
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'organization-inventoried', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.organization-inventory', () =>
          database.batch([
            runUpdate,
            operationUpdate,
            lifecycleUpdate,
            ...items,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* inventorySummary(input.organizationId, input.operationId)
        const after = yield* loadRun(input.organizationId, input.operationId)
        if (after.state === 'inventorying') return adopted
        return yield* outcome.failure
      }
      return yield* inventorySummary(input.organizationId, input.operationId)
    })

  const markItemResolved: OrganizationDeletionRepositoryShape['markItemResolved'] = (input) =>
    Effect.gen(function* () {
      const encodedEvidence = JSON.stringify(input.evidence)
      if (encodedEvidence.length > 8192)
        return yield* failConflict('organization_deletion_evidence_too_large')
      const existing = yield* attempt('termination.organization-item.load', () =>
        database
          .prepare(`SELECT state FROM organization_deletion_items
            WHERE organization_id = ? AND operation_id = ? AND kind = ? AND resource_id = ?`)
          .bind(input.organizationId, input.operationId, input.kind, input.resourceId)
          .first(),
      )
      const existingRow = object(existing)
      const existingState = existingRow === undefined ? undefined : text(existingRow, 'state')
      if (existingState === undefined)
        return yield* failConflict('organization_deletion_item_not_found')
      if (existingState === input.disposition) return
      if (!['pending', 'ambiguous', 'blocked'].includes(existingState))
        return yield* failConflict('organization_deletion_item_resolution_conflict')
      const resolvedAt = input.disposition === 'ambiguous' ? null : input.now
      const event = evidenceIds(
        `termination-organization-item-${input.kind}-${input.resourceId}`,
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageOrganizationAudit({
        eventId: event.auditEventId,
        organizationId: input.organizationId,
        operationId: input.operationId,
        action: 'organization.delete.item-resolved',
        targetType: input.kind,
        targetId: input.resourceId,
        before: { state: existingState },
        after: { state: input.disposition, evidence: input.evidence },
        now: input.now,
      })
      const itemUpdate = database
        .prepare(`UPDATE organization_deletion_items
          SET state = ?, resolution_evidence_json = ?, resolved_at = ?
          WHERE organization_id = ? AND operation_id = ? AND kind = ? AND resource_id = ?
            AND state IN ('pending', 'ambiguous', 'blocked')`)
        .bind(
          input.disposition,
          encodedEvidence,
          resolvedAt,
          input.organizationId,
          input.operationId,
          input.kind,
          input.resourceId,
        )
      const runUpdate =
        input.disposition === 'ambiguous'
          ? database
              .prepare(`UPDATE organization_deletion_runs
                SET state = 'blocked', blocked_reason = 'ambiguous-resource', updated_at = ?
                WHERE organization_id = ? AND operation_id = ?
                  AND state NOT IN ('tombstoned', 'cancelled')`)
              .bind(input.now, input.organizationId, input.operationId)
          : database
              .prepare(`UPDATE organization_deletion_runs SET updated_at = ?
                WHERE organization_id = ? AND operation_id = ?`)
              .bind(input.now, input.organizationId, input.operationId)
      const lifecycleUpdate =
        input.disposition === 'ambiguous'
          ? database
              .prepare(`UPDATE destructive_lifecycle_operations
                SET state = 'blocked', revision = revision + 1, updated_at = ?
                WHERE organization_id = ? AND operation_id = ?
                  AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
              .bind(input.now, input.organizationId, input.operationId)
          : database
              .prepare(`UPDATE destructive_lifecycle_operations SET updated_at = updated_at
                WHERE organization_id = ? AND operation_id = ?`)
              .bind(input.organizationId, input.operationId)
      const operationUpdate =
        input.disposition === 'ambiguous'
          ? database
              .prepare(`UPDATE operations SET status = 'waiting_external', revision = revision + 1, updated_at = ?
                WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')`)
              .bind(input.now, input.organizationId, input.operationId)
          : database
              .prepare(`UPDATE operations SET updated_at = updated_at
                WHERE organization_id = ? AND id = ?`)
              .bind(input.organizationId, input.operationId)
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'organization.delete.item-resolved',
            ?, ?, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          input.kind,
          input.resourceId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'organization.delete.item-resolved', 'operation', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.operationId,
          JSON.stringify({
            kind: input.kind,
            resourceId: input.resourceId,
            disposition: input.disposition,
          }),
          input.now,
          input.now,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          `organization-item:${input.kind}:${input.resourceId}`,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.organization-item.resolve', () =>
          database.batch([
            itemUpdate,
            runUpdate,
            lifecycleUpdate,
            operationUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* attempt('termination.organization-item.resolve.adopt', () =>
          database
            .prepare(`SELECT state FROM organization_deletion_items
              WHERE organization_id = ? AND operation_id = ? AND kind = ? AND resource_id = ?`)
            .bind(input.organizationId, input.operationId, input.kind, input.resourceId)
            .first(),
        )
        if (object(adopted) !== undefined && text(object(adopted)!, 'state') === input.disposition)
          return
        return yield* outcome.failure
      }
      const adopted = yield* attempt('termination.organization-item.resolve.verify', () =>
        database
          .prepare(`SELECT state FROM organization_deletion_items
            WHERE organization_id = ? AND operation_id = ? AND kind = ? AND resource_id = ?`)
          .bind(input.organizationId, input.operationId, input.kind, input.resourceId)
          .first(),
      )
      if (object(adopted) === undefined || text(object(adopted)!, 'state') !== input.disposition)
        return yield* failConflict('organization_deletion_item_not_adopted')
    })

  const revokeOrganizationCredentials: OrganizationDeletionRepositoryShape['revokeOrganizationCredentials'] =
    (input) =>
      Effect.gen(function* () {
        const run = yield* loadRun(input.organizationId, input.operationId)
        if (run.state === 'tombstoned' || run.state === 'cancelled')
          return yield* failConflict('organization_deletion_credentials_not_allowed')
        const event = evidenceIds(
          'termination-organization-credentials-revoked',
          input.organizationId,
          input.operationId,
        )
        const auditStage = yield* stageOrganizationAudit({
          eventId: event.auditEventId,
          organizationId: input.organizationId,
          operationId: input.operationId,
          action: 'organization.delete.credentials-revoked',
          targetType: 'organization',
          targetId: input.organizationId,
          before: { state: run.state },
          after: { state: 'revoking', credentialsRevoked: true },
          now: input.now,
        })
        const credentialUpdate = database
          .prepare(`UPDATE node_credentials SET status = 'revoked', revoked_at = ?
          WHERE organization_id = ? AND status = 'active'`)
          .bind(input.now, input.organizationId)
        const tokenUpdate = database
          .prepare(`UPDATE node_registration_tokens SET revoked_at = ?
          WHERE organization_id = ? AND revoked_at IS NULL`)
          .bind(input.now, input.organizationId)
        const sessionUpdate = database
          .prepare(`UPDATE agent_sessions SET session_state = 'revoked', revision = revision + 1
          WHERE organization_id = ? AND session_state <> 'revoked'`)
          .bind(input.organizationId)
        const automationUpdate = database
          .prepare(`UPDATE automation_identities SET status = 'revoked', revision = revision + 1
          WHERE organization_id = ? AND status = 'active'`)
          .bind(input.organizationId)
        // A provider account with an in-flight paid provision lease makes this batch fail. That is
        // deliberate: the organization remains frozen and cannot hide a paid/ambiguous instance.
        const providerAccountUpdate = database
          .prepare(`UPDATE provider_accounts SET status = 'disabled', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND scope = 'organization' AND status = 'active'`)
          .bind(input.now, input.organizationId)
        const itemUpdates = [
          ['node-credential', JSON.stringify({ revokedAt: input.now })],
          ['node-registration-token', JSON.stringify({ revokedAt: input.now })],
          ['agent-session', JSON.stringify({ revokedAt: input.now })],
          ['automation-identity', JSON.stringify({ revokedAt: input.now })],
          ['provider-account', JSON.stringify({ disabledAt: input.now })],
        ].map(([kind, evidence]) =>
          database
            .prepare(`UPDATE organization_deletion_items
            SET state = 'resolved', resolution_evidence_json = ?, resolved_at = ?
            WHERE organization_id = ? AND operation_id = ? AND kind = ?
              AND state IN ('pending', 'ambiguous', 'blocked')`)
            .bind(evidence, input.now, input.organizationId, input.operationId, kind),
        )
        const runUpdate = database
          .prepare(`UPDATE organization_deletion_runs SET state = 'revoking', blocked_reason = NULL, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state NOT IN ('tombstoned', 'cancelled')`)
          .bind(input.now, input.organizationId, input.operationId)
        const lifecycleUpdate = database
          .prepare(`UPDATE destructive_lifecycle_operations SET state = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
          .bind(input.now, input.organizationId, input.operationId)
        const operationUpdate = database
          .prepare(`UPDATE operations SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')`)
          .bind(input.now, input.organizationId, input.operationId)
        const auditInsert = database
          .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'organization.delete.credentials-revoked',
            'organization', operation.resource_id, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(
            event.auditEventId,
            auditStage.summaryJson,
            input.now,
            input.organizationId,
            input.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'organization.delete.credentials-revoked', 'operation', ?, '{}', 'pending', 0, ?, ?)`)
          .bind(event.outboxEventId, input.organizationId, input.operationId, input.now, input.now)
        const receiptInsert = database
          .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'organization-credentials-revoked', NULL, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            event.auditEventId,
            event.outboxEventId,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.organization-revoke-credentials', () =>
            database.batch([
              credentialUpdate,
              tokenUpdate,
              sessionUpdate,
              automationUpdate,
              providerAccountUpdate,
              ...itemUpdates,
              runUpdate,
              lifecycleUpdate,
              operationUpdate,
              auditStage.operation,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
            ]),
          ),
        )
        if (outcome._tag === 'Failure') {
          const remaining = yield* attempt(
            'termination.organization-revoke-credentials.adopt',
            () =>
              database
                .prepare(`SELECT
              (SELECT COUNT(*) FROM node_credentials WHERE organization_id = ? AND status = 'active') +
              (SELECT COUNT(*) FROM node_registration_tokens WHERE organization_id = ? AND revoked_at IS NULL) +
              (SELECT COUNT(*) FROM agent_sessions WHERE organization_id = ? AND session_state <> 'revoked') +
              (SELECT COUNT(*) FROM automation_identities WHERE organization_id = ? AND status = 'active') +
              (SELECT COUNT(*) FROM provider_accounts WHERE organization_id = ? AND scope = 'organization' AND status = 'active')
              AS count`)
                .bind(
                  input.organizationId,
                  input.organizationId,
                  input.organizationId,
                  input.organizationId,
                  input.organizationId,
                )
                .first(),
          ).pipe(
            Effect.flatMap((row) =>
              numberValue(row, 'termination.organization-revoke-credentials.adopt'),
            ),
          )
          if (remaining === 0) return
          return yield* outcome.failure
        }
        const remaining = yield* attempt('termination.organization-revoke-credentials.verify', () =>
          database
            .prepare(`SELECT
            (SELECT COUNT(*) FROM node_credentials WHERE organization_id = ? AND status = 'active') +
            (SELECT COUNT(*) FROM node_registration_tokens WHERE organization_id = ? AND revoked_at IS NULL) +
            (SELECT COUNT(*) FROM agent_sessions WHERE organization_id = ? AND session_state <> 'revoked') +
            (SELECT COUNT(*) FROM automation_identities WHERE organization_id = ? AND status = 'active') +
            (SELECT COUNT(*) FROM provider_accounts WHERE organization_id = ? AND scope = 'organization' AND status = 'active')
            AS count`)
            .bind(
              input.organizationId,
              input.organizationId,
              input.organizationId,
              input.organizationId,
              input.organizationId,
            )
            .first(),
        ).pipe(
          Effect.flatMap((row) =>
            numberValue(row, 'termination.organization-revoke-credentials.verify'),
          ),
        )
        if (remaining !== 0)
          return yield* failConflict('organization_credential_revoke_not_adopted')
      })

  const releaseOrganizationReservations: OrganizationDeletionRepositoryShape['releaseOrganizationReservations'] =
    (input) =>
      Effect.gen(function* () {
        const run = yield* loadRun(input.organizationId, input.operationId)
        if (run.state === 'tombstoned' || run.state === 'cancelled')
          return yield* failConflict('organization_deletion_reservations_not_allowed')
        const event = evidenceIds(
          'termination-organization-reservations-released',
          input.organizationId,
          input.operationId,
        )
        const auditStage = yield* stageOrganizationAudit({
          eventId: event.auditEventId,
          organizationId: input.organizationId,
          operationId: input.operationId,
          action: 'organization.delete.reservations-released',
          targetType: 'organization',
          targetId: input.organizationId,
          before: { state: run.state },
          after: { reservationsReleased: true },
          now: input.now,
        })
        const capacityUpdate = database
          .prepare(`UPDATE server_capacity_reservations SET state = 'released'
          WHERE organization_id = ? AND state IN ('reserved', 'releasing')`)
          .bind(input.organizationId)
        const portUpdate = database
          .prepare(`UPDATE port_leases SET state = 'released', revision = revision + 1
          WHERE organization_id = ? AND state IN ('reserved', 'releasing')`)
          .bind(input.organizationId)
        const capacityItems = database
          .prepare(`UPDATE organization_deletion_items
          SET state = 'resolved', resolution_evidence_json = ?, resolved_at = ?
          WHERE organization_id = ? AND operation_id = ? AND kind = 'server-capacity-reservation'
            AND state IN ('pending', 'ambiguous', 'blocked')`)
          .bind(
            JSON.stringify({ releasedAt: input.now }),
            input.now,
            input.organizationId,
            input.operationId,
          )
        const portItems = database
          .prepare(`UPDATE organization_deletion_items
          SET state = 'resolved', resolution_evidence_json = ?, resolved_at = ?
          WHERE organization_id = ? AND operation_id = ? AND kind = 'port-lease'
            AND state IN ('pending', 'ambiguous', 'blocked')`)
          .bind(
            JSON.stringify({ releasedAt: input.now }),
            input.now,
            input.organizationId,
            input.operationId,
          )
        const auditInsert = database
          .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'organization.delete.reservations-released',
            'organization', operation.resource_id, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
          .bind(
            event.auditEventId,
            auditStage.summaryJson,
            input.now,
            input.organizationId,
            input.operationId,
          )
        const outboxInsert = database
          .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'organization.delete.reservations-released', 'operation', ?, '{}', 'pending', 0, ?, ?)`)
          .bind(event.outboxEventId, input.organizationId, input.operationId, input.now, input.now)
        const receiptInsert = database
          .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'organization-reservations-released', NULL, ?, ?, ?)`)
          .bind(
            input.organizationId,
            input.operationId,
            event.auditEventId,
            event.outboxEventId,
            input.now,
          )
        const outcome = yield* Effect.result(
          attempt('termination.organization-release-reservations', () =>
            database.batch([
              capacityUpdate,
              portUpdate,
              capacityItems,
              portItems,
              auditStage.operation,
              auditStage.statement,
              auditInsert,
              outboxInsert,
              receiptInsert,
            ]),
          ),
        )
        if (outcome._tag === 'Failure') {
          const remaining = yield* attempt(
            'termination.organization-release-reservations.adopt',
            () =>
              database
                .prepare(`SELECT
              (SELECT COUNT(*) FROM server_capacity_reservations WHERE organization_id = ? AND state <> 'released') +
              (SELECT COUNT(*) FROM port_leases WHERE organization_id = ? AND state <> 'released') AS count`)
                .bind(input.organizationId, input.organizationId)
                .first(),
          ).pipe(
            Effect.flatMap((row) =>
              numberValue(row, 'termination.organization-release-reservations.adopt'),
            ),
          )
          if (remaining === 0) return
          return yield* outcome.failure
        }
        const remaining = yield* attempt(
          'termination.organization-release-reservations.verify',
          () =>
            database
              .prepare(`SELECT
            (SELECT COUNT(*) FROM server_capacity_reservations WHERE organization_id = ? AND state <> 'released') +
            (SELECT COUNT(*) FROM port_leases WHERE organization_id = ? AND state <> 'released') AS count`)
              .bind(input.organizationId, input.organizationId)
              .first(),
        ).pipe(
          Effect.flatMap((row) =>
            numberValue(row, 'termination.organization-release-reservations.verify'),
          ),
        )
        if (remaining !== 0)
          return yield* failConflict('organization_reservation_release_not_adopted')
      })

  const prepareTombstone: OrganizationDeletionRepositoryShape['prepareTombstone'] = (input) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId)
      if (run.state === 'ready-to-tombstone') return
      const summary = yield* inventorySummary(input.organizationId, input.operationId)
      if (summary.unresolvedResources > 0 || summary.unresolvedPaidResources > 0)
        return yield* failConflict('organization_deletion_unresolved_resources')
      const event = evidenceIds(
        'termination-organization-ready-to-tombstone',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageOrganizationAudit({
        eventId: event.auditEventId,
        organizationId: input.organizationId,
        operationId: input.operationId,
        action: 'organization.delete.ready-to-tombstone',
        targetType: 'organization',
        targetId: input.organizationId,
        before: { state: run.state, unresolvedResources: summary.unresolvedResources },
        after: { state: 'ready-to-tombstone' },
        now: input.now,
      })
      const runUpdate = database
        .prepare(`UPDATE organization_deletion_runs
          SET state = 'ready-to-tombstone', blocked_reason = NULL, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('inventorying', 'draining', 'retiring', 'revoking', 'cleaning-networking', 'blocked')`)
        .bind(input.now, input.organizationId, input.operationId)
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
        .bind(input.now, input.organizationId, input.operationId)
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')`)
        .bind(input.now, input.organizationId, input.operationId)
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'organization.delete.ready-to-tombstone',
            'organization', operation.resource_id, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'organization.delete.ready-to-tombstone', 'operation', ?, '{}', 'pending', 0, ?, ?)`)
        .bind(event.outboxEventId, input.organizationId, input.operationId, input.now, input.now)
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'organization-ready-to-tombstone', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.organization-prepare-tombstone', () =>
          database.batch([
            runUpdate,
            lifecycleUpdate,
            operationUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* loadRun(input.organizationId, input.operationId)
        if (adopted.state === 'ready-to-tombstone') return
        return yield* outcome.failure
      }
      const adopted = yield* loadRun(input.organizationId, input.operationId)
      if (adopted.state !== 'ready-to-tombstone')
        return yield* failConflict('organization_deletion_ready_not_adopted')
    })

  const tombstone: OrganizationDeletionRepositoryShape['tombstone'] = (input) =>
    Effect.gen(function* () {
      const run = yield* loadRun(input.organizationId, input.operationId)
      const existing = yield* attempt('termination.organization-tombstone.existing', () =>
        database
          .prepare(`SELECT inventory_digest AS inventoryDigest FROM organization_tombstones
            WHERE organization_id = ? AND operation_id = ?`)
          .bind(input.organizationId, input.operationId)
          .first(),
      )
      if (
        existing !== null &&
        object(existing) !== undefined &&
        text(object(existing)!, 'inventoryDigest') !== undefined
      )
        return
      if (run.state !== 'ready-to-tombstone')
        return yield* failConflict('organization_deletion_not_ready_to_tombstone')
      const rawItems = yield* attempt('termination.organization-tombstone.inventory', () =>
        database
          .prepare(`SELECT kind, resource_id AS resourceId, state, paid, summary_json AS summaryJson,
            resolution_evidence_json AS resolutionEvidenceJson
            FROM organization_deletion_items
            WHERE organization_id = ? AND operation_id = ? ORDER BY kind, resource_id`)
          .bind(input.organizationId, input.operationId)
          .all(),
      )
      const inventory = rawItems.results.map((value) => {
        const row = object(value)
        return {
          kind: row === undefined ? undefined : text(row, 'kind'),
          resourceId: row === undefined ? undefined : text(row, 'resourceId'),
          state: row === undefined ? undefined : text(row, 'state'),
          paid: row === undefined ? undefined : booleanInteger(row, 'paid'),
          summaryJson: row === undefined ? undefined : text(row, 'summaryJson'),
          resolutionEvidenceJson:
            row === undefined ? undefined : text(row, 'resolutionEvidenceJson'),
        }
      })
      if (
        inventory.some(
          (item) =>
            item.kind === undefined ||
            item.resourceId === undefined ||
            item.state === undefined ||
            item.paid === undefined ||
            item.summaryJson === undefined,
        )
      )
        return yield* Effect.fail(
          persistence('termination.organization-tombstone.inventory', 'invalid inventory row'),
        )
      const canonicalInventory = JSON.stringify(inventory)
      const digest = yield* Effect.tryPromise({
        try: async () => {
          const bytes = new TextEncoder().encode(canonicalInventory)
          const hash = await crypto.subtle.digest('SHA-256', bytes)
          return [...new Uint8Array(hash)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        },
        catch: (cause) => persistence('termination.organization-tombstone.digest', cause),
      })
      const organization = yield* attempt('termination.organization-tombstone.organization', () =>
        database
          .prepare(`SELECT slug FROM organizations WHERE id = ? AND status = 'deleting'`)
          .bind(input.organizationId)
          .first(),
      )
      const slug =
        object(organization) === undefined ? undefined : text(object(organization)!, 'slug')
      if (slug === undefined) return yield* failConflict('organization_deletion_status_conflict')
      const event = evidenceIds(
        'termination-organization-tombstoned',
        input.organizationId,
        input.operationId,
      )
      const auditStage = yield* stageOrganizationAudit({
        eventId: event.auditEventId,
        organizationId: input.organizationId,
        operationId: input.operationId,
        action: 'organization.delete.tombstoned',
        targetType: 'organization',
        targetId: input.organizationId,
        before: { state: run.state },
        after: { state: 'tombstoned', inventoryDigest: digest },
        now: input.now,
      })
      const tombstoneInsert = database
        .prepare(`INSERT INTO organization_tombstones
          (organization_id, operation_id, slug, retention_until, finalized_at, inventory_digest)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          slug,
          input.retentionUntil,
          input.now,
          digest,
        )
      const organizationUpdate = database
        .prepare(
          `UPDATE organizations SET status = 'deleted', revision = revision + 1 WHERE id = ? AND status = 'deleting'`,
        )
        .bind(input.organizationId)
      const runUpdate = database
        .prepare(`UPDATE organization_deletion_runs SET state = 'tombstoned', updated_at = ?
          WHERE organization_id = ? AND operation_id = ? AND state = 'ready-to-tombstone'`)
        .bind(input.now, input.organizationId, input.operationId)
      const lifecycleUpdate = database
        .prepare(`UPDATE destructive_lifecycle_operations
          SET state = 'succeeded', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND operation_id = ?
            AND state IN ('queued', 'running', 'waiting-external', 'blocked')`)
        .bind(input.now, input.organizationId, input.operationId)
      const operationUpdate = database
        .prepare(`UPDATE operations SET status = 'succeeded', progress = 100, revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_external')`)
        .bind(input.now, input.organizationId, input.operationId)
      const auditInsert = database
        .prepare(`INSERT OR IGNORE INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          SELECT ?, operation.organization_id, operation.actor_id, 'organization.delete.tombstoned',
            'organization', operation.resource_id, 'succeeded', operation.correlation_id, ?, ?
          FROM operations operation WHERE operation.organization_id = ? AND operation.id = ?`)
        .bind(
          event.auditEventId,
          auditStage.summaryJson,
          input.now,
          input.organizationId,
          input.operationId,
        )
      const outboxInsert = database
        .prepare(`INSERT OR IGNORE INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'organization.delete.tombstoned', 'operation', ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          event.outboxEventId,
          input.organizationId,
          input.operationId,
          JSON.stringify({ inventoryDigest: digest }),
          input.now,
          input.now,
        )
      const receiptInsert = database
        .prepare(`INSERT OR IGNORE INTO destructive_lifecycle_atomic_receipts
          (organization_id, operation_id, receipt_key, workflow_start_record_id,
           audit_event_id, outbox_event_id, created_at)
          VALUES (?, ?, 'organization-tombstoned', NULL, ?, ?, ?)`)
        .bind(
          input.organizationId,
          input.operationId,
          event.auditEventId,
          event.outboxEventId,
          input.now,
        )
      const outcome = yield* Effect.result(
        attempt('termination.organization-tombstone', () =>
          database.batch([
            tombstoneInsert,
            organizationUpdate,
            runUpdate,
            lifecycleUpdate,
            operationUpdate,
            auditStage.operation,
            auditStage.statement,
            auditInsert,
            outboxInsert,
            receiptInsert,
          ]),
        ),
      )
      if (outcome._tag === 'Failure') {
        const adopted = yield* attempt('termination.organization-tombstone.adopt', () =>
          database
            .prepare(`SELECT 1 AS present FROM organization_tombstones
              WHERE organization_id = ? AND operation_id = ?`)
            .bind(input.organizationId, input.operationId)
            .first(),
        )
        if (adopted !== null) return
        return yield* outcome.failure
      }
      const adopted = yield* loadRun(input.organizationId, input.operationId)
      if (adopted.state !== 'tombstoned')
        return yield* failConflict('organization_tombstone_not_adopted')
    })

  return {
    inventory,
    markItemResolved,
    revokeOrganizationCredentials,
    releaseOrganizationReservations,
    prepareTombstone,
    tombstone,
  }
}

export const OrganizationDeletionD1RepositoryLayer = (
  repository: OrganizationDeletionRepositoryShape,
) => Layer.succeed(OrganizationDeletionRepository, repository)

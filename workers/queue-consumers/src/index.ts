import { Effect, ManagedRuntime, Schema } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import { makePlatformAuditExportOutboxRepositoryD1 } from '@gridora/audit-d1'
import type { OutboxEvent } from '@gridora/contracts'
import { OutboxRepository } from '@gridora/db-contracts'
import { makeD1RepositoriesLayer } from '@gridora/db-d1'
import { IsoDateTime } from '@gridora/domain'
import {
  decodeOrphanScheduleTask,
  makeOrphanScheduleStore,
  OrphanScheduleError,
  type OrphanScheduleStore,
  type OrphanScheduleTask,
} from '@gridora/orphan-schedule'
import type { PolicyScheduleTask } from '@gridora/policy-schedule'
import type { LiveLogStreamDO, OrganizationEventsDO } from '@gridora/realtime'
import {
  AuditExportEvent,
  auditPartitionKey,
  prepareAuditExportQueueEvent,
  processAuditExportMessages,
} from './audit-export.js'
import {
  decodeInvitationEmailPayload,
  persistInvitationEmailRemediation,
  sendInvitationEmail,
  type InvitationTokenKeyring,
} from './invitation-email.js'
import {
  processPolicyReconciliationMessage,
  schedulePolicyReconciliations,
} from './policy-reconciliation.js'
import { processLiveLogArchiveAvailable } from './live-log-publication.js'
import { dispatchScheduledBackups } from './backup-schedule.js'
import { dispatchScheduledGameServers } from './game-server-schedule.js'
import { reconcilePendingTelemetryArchives } from './telemetry-archive-reconciliation.js'

export * from './invitation-email.js'
export * from './audit-export.js'
export * from './policy-reconciliation.js'
export * from './live-log-publication.js'
export * from './backup-schedule.js'
export * from './game-server-schedule.js'
export * from './telemetry-archive-reconciliation.js'

const QueueEvent = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  partitionKey: Schema.String,
  type: Schema.String,
  occurredAt: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
})
export type QueueEvent = typeof QueueEvent.Type

const MembershipLiveLogPayload = Schema.Union([
  Schema.Struct({ principalId: Schema.String }),
  Schema.Struct({ identityId: Schema.String }),
])
type MembershipLiveLogPayload = typeof MembershipLiveLogPayload.Type

export type QueueEnv = Omit<Env, 'ORGANIZATION_EVENTS' | 'LIVE_LOG_STREAM'> & {
  AUDIT_EXPORT: Queue<AuditExportEvent>
  RECONCILIATION_QUEUE: Queue<OrphanScheduleTask>
  RECONCILE_ORPHAN: Workflow<OrphanScheduleTask>
  POLICY_RECONCILIATION_QUEUE: Queue<PolicyScheduleTask>
  RECONCILE_POLICY: Workflow<PolicyScheduleTask>
  ORGANIZATION_EVENTS: DurableObjectNamespace<OrganizationEventsDO>
  LOGS: R2Bucket
  LIVE_LOG_STREAM: DurableObjectNamespace<LiveLogStreamDO>
  INVITATION_TOKEN_SECRET_PREVIOUS?: string
  INVITATION_TOKEN_PREVIOUS_KEY_VERSION?: string
}

export interface OrphanWorkflowBinding {
  create(options: {
    readonly id: string
    readonly params: OrphanScheduleTask
  }): Promise<{ readonly id: string }>
  get(id: string): Promise<{ readonly id: string }>
}

const terminalOrphanScheduleError = (error: unknown): boolean =>
  error instanceof OrphanScheduleError &&
  (error.code === 'invalid-task' ||
    error.code === 'invalid-scope' ||
    error.code === 'lease-expired' ||
    error.code === 'idempotency-conflict')

/**
 * D1 moves the exact task to running before the native Workflow call. If the
 * create response is lost, get() adopts only the same deterministic id.
 */
export const startOrAdoptOrphanWorkflow = async (
  input: unknown,
  store: OrphanScheduleStore,
  workflow: OrphanWorkflowBinding,
): Promise<'started' | 'adopted'> => {
  const task = await Effect.runPromise(decodeOrphanScheduleTask(input))
  const state = await Effect.runPromise(store.beginWorkflow(task))
  try {
    const created = await workflow.create({ id: task.workflowId, params: task })
    if (created.id !== task.workflowId) throw new Error('Workflow identity mismatch')
    return state === 'adopted' ? 'adopted' : 'started'
  } catch (createError) {
    try {
      const adopted = await workflow.get(task.workflowId)
      if (adopted.id !== task.workflowId) throw new Error('Workflow identity mismatch')
      return 'adopted'
    } catch {
      throw createError
    }
  }
}

export const scheduleOrphanReconciliations = async (
  env: Pick<QueueEnv, 'DB' | 'RECONCILIATION_QUEUE'>,
  scheduledAt: number,
): Promise<number> => {
  const tasks = await Effect.runPromise(
    makeOrphanScheduleStore(env.DB).claimScheduledTasks(new Date(scheduledAt).toISOString()),
  )
  await Promise.all(
    tasks.map((task) => env.RECONCILIATION_QUEUE.send(task, { contentType: 'json' })),
  )
  return tasks.length
}

const processOrphanMessage = async (
  env: QueueEnv,
  message: Message<unknown>,
): Promise<'ack' | 'retry'> => {
  const decoded = await Effect.runPromise(Effect.result(decodeOrphanScheduleTask(message.body)))
  if (decoded._tag === 'Failure') {
    log('warn', 'orphan_reconciliation_rejected', {
      queue: 'gridora-reconciliation',
      messageId: message.id,
      reason: 'invalid_task',
    })
    return 'ack'
  }
  const task = decoded.success
  const started = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          startOrAdoptOrphanWorkflow(task, makeOrphanScheduleStore(env.DB), env.RECONCILE_ORPHAN),
        catch: (cause) => cause,
      }),
    ),
  )
  if (started._tag === 'Failure') {
    const failure = started.failure
    const disposition = terminalOrphanScheduleError(failure) ? 'ack' : 'retry'
    log(disposition === 'ack' ? 'warn' : 'error', 'orphan_reconciliation_start_failed', {
      queue: 'gridora-reconciliation',
      messageId: message.id,
      organizationId: task.organizationId,
      providerAccountId: task.providerAccountId,
      disposition,
    })
    return disposition
  }
  log('info', 'orphan_reconciliation_workflow_started', {
    queue: 'gridora-reconciliation',
    messageId: message.id,
    organizationId: task.organizationId,
    providerAccountId: task.providerAccountId,
    workflowId: task.workflowId,
    disposition: started.success,
  })
  return 'ack'
}

interface OutboxRuntime {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, OutboxRepository>) => Promise<A>
}
const outboxRuntimes = new WeakMap<QueueEnv, OutboxRuntime>()
const outboxRuntime = (env: QueueEnv): OutboxRuntime => {
  const cached = outboxRuntimes.get(env)
  if (cached !== undefined) return cached
  const runtime = ManagedRuntime.make(makeD1RepositoriesLayer(env.DB))
  outboxRuntimes.set(env, runtime)
  return runtime
}

interface OutboxWakeupMessage {
  readonly attempts: number
  readonly ack: () => void
  readonly retry: (options: { readonly delaySeconds: number }) => void
}

export class TerminalOutboxFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(`Outbox delivery requires terminal remediation (${code})`)
    this.name = 'TerminalOutboxFailure'
    this.code = code
  }
}

export const handleOutboxWakeup = async (
  messages: ReadonlyArray<OutboxWakeupMessage>,
  publish: () => Promise<unknown>,
): Promise<'ack' | 'retry'> => {
  try {
    await publish()
    for (const message of messages) message.ack()
    return 'ack'
  } catch {
    for (const message of messages) {
      message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 6)) })
    }
    return 'retry'
  }
}

export const processOutboxWakeup = async (
  batch: MessageBatch<unknown>,
  env: QueueEnv,
): Promise<void> => {
  const decision = await handleOutboxWakeup(batch.messages, async () => {
    await Promise.all([
      drainOutbox(() => outboxRuntime(env).runPromise(publishOutbox(env))),
      drainOutbox(() => publishPlatformAuditOutbox(env)),
    ])
  })
  if (decision === 'retry') {
    log('error', 'outbox_wakeup_failed', { queue: batch.queue })
  }
}

export const drainOutbox = async (
  publishPage: () => Promise<number>,
  pageSize = 50,
): Promise<number> => {
  let total = 0
  while (true) {
    const published = await publishPage()
    total += published
    if (published < pageSize) return total
  }
}

const iso = (milliseconds: number): Effect.Effect<typeof IsoDateTime.Type> =>
  Schema.decodeUnknownEffect(IsoDateTime)(new Date(milliseconds).toISOString()).pipe(Effect.orDie)

const log = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown>,
): void => {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...fields }))
}

const validatePartition = (event: QueueEvent): boolean =>
  event.partitionKey.startsWith(`${event.organizationId}:`)

interface LiveLogEpochScope {
  readonly serverId: string
  readonly streamEpoch: string
}

interface LiveLogOrganizationAuthorization {
  readonly generation: number
  readonly state: 'active' | 'suspended' | 'deleted'
}

interface LiveLogMembershipAuthorization {
  readonly generation: number
  readonly membershipRevision: number
  readonly state: 'active' | 'revoked'
}

const liveLogStreamName = (scope: LiveLogEpochScope, organizationId: string): string =>
  `${encodeURIComponent(organizationId)}:logs:${encodeURIComponent(scope.serverId)}:${encodeURIComponent(scope.streamEpoch)}`

/**
 * Epoch rows retain historical streams after a move. The current deployment is
 * included too: a viewer can receive a ticket before the first archive creates
 * its epoch evidence row, and a later membership revoke must still find that
 * socket.
 */
const liveLogEpochScopes = async (
  env: Pick<QueueEnv, 'DB'>,
  organizationId: string,
): Promise<ReadonlyArray<LiveLogEpochScope>> => {
  const result = await env.DB.prepare(`SELECT server_id AS serverId, stream_epoch AS streamEpoch
    FROM telemetry_log_stream_epochs
    WHERE organization_id = ?
    UNION
    SELECT server_id AS serverId, id AS streamEpoch
    FROM deployments
    WHERE organization_id = ?
    ORDER BY server_id ASC, stream_epoch ASC`)
    .bind(organizationId, organizationId)
    .all<{
      readonly serverId: unknown
      readonly streamEpoch: unknown
    }>()
  return result.results.flatMap((row) =>
    typeof row.serverId === 'string' && typeof row.streamEpoch === 'string'
      ? [{ serverId: row.serverId, streamEpoch: row.streamEpoch }]
      : [],
  )
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined

/** Outbox payloads are advisory; current D1 authority decides every DO update. */
const liveLogOrganizationAuthorization = async (
  env: Pick<QueueEnv, 'DB'>,
  organizationId: string,
): Promise<LiveLogOrganizationAuthorization> => {
  const result =
    await env.DB.prepare(`SELECT authorization_generation AS authorizationGeneration, state
    FROM live_log_organization_authorizations WHERE organization_id = ?`)
      .bind(organizationId)
      .all<{
        readonly authorizationGeneration: unknown
        readonly state: unknown
      }>()
  const row = result.results[0]
  const generation = row === undefined ? undefined : positiveInteger(row.authorizationGeneration)
  const state = row === undefined ? undefined : row.state
  if (
    generation === undefined ||
    (state !== 'active' && state !== 'suspended' && state !== 'deleted')
  )
    throw new Error('Live log organization authorization is unavailable')
  return { generation, state }
}

const liveLogMembershipAuthorization = async (
  env: Pick<QueueEnv, 'DB'>,
  organizationId: string,
  principalId: string,
): Promise<LiveLogMembershipAuthorization> => {
  const result = await env.DB.prepare(`SELECT authorization_generation AS authorizationGeneration,
    membership_revision AS membershipRevision, state
    FROM live_log_membership_authorizations
    WHERE organization_id = ? AND identity_id = ?`)
    .bind(organizationId, principalId)
    .all<{
      readonly authorizationGeneration: unknown
      readonly membershipRevision: unknown
      readonly state: unknown
    }>()
  const row = result.results[0]
  const generation = row === undefined ? undefined : positiveInteger(row.authorizationGeneration)
  const membershipRevision = row === undefined ? undefined : positiveInteger(row.membershipRevision)
  const state = row === undefined ? undefined : row.state
  if (
    generation === undefined ||
    membershipRevision === undefined ||
    (state !== 'active' && state !== 'revoked')
  )
    throw new Error('Live log membership authorization is unavailable')
  return { generation, membershipRevision, state }
}

const synchronizeLiveLogPrincipal = async (
  env: QueueEnv,
  organizationId: string,
  principalId: string,
): Promise<void> => {
  const authorization = await liveLogMembershipAuthorization(env, organizationId, principalId)
  const scopes = await liveLogEpochScopes(env, organizationId)
  await Promise.all(
    scopes.map((scope) =>
      env.LIVE_LOG_STREAM.getByName(
        liveLogStreamName(scope, organizationId),
      ).synchronizePrincipalAuthorization(
        organizationId,
        scope.serverId,
        scope.streamEpoch,
        principalId,
        authorization.membershipRevision,
        authorization.generation,
        authorization.state,
      ),
    ),
  )
}

const synchronizeOrganizationLiveLogs = async (
  env: QueueEnv,
  organizationId: string,
): Promise<void> => {
  const authorization = await liveLogOrganizationAuthorization(env, organizationId)
  const scopes = await liveLogEpochScopes(env, organizationId)
  await Promise.all(
    scopes.map((scope) =>
      env.LIVE_LOG_STREAM.getByName(
        liveLogStreamName(scope, organizationId),
      ).synchronizeOrganizationAuthorization(
        organizationId,
        scope.serverId,
        scope.streamEpoch,
        authorization.generation,
        authorization.state,
      ),
    ),
  )
}

export const deliverClaimedOutboxEvent = async (
  event: OutboxEvent,
  publish: (event: OutboxEvent) => Promise<void>,
  markDelivered: (event: OutboxEvent) => Promise<void>,
  markFailed: (event: OutboxEvent, disposition: 'retryable' | 'terminal') => Promise<void>,
): Promise<void> => {
  try {
    await publish(event)
  } catch (error) {
    await markFailed(event, error instanceof TerminalOutboxFailure ? 'terminal' : 'retryable')
    throw error
  }
  // A crash here leaves the lease to expire. The next publisher repeats the idempotent
  // downstream publish and only then marks this exact lease delivered.
  await markDelivered(event)
}

export const toGenericOutboxQueueEvent = async (event: OutboxEvent): Promise<QueueEvent> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(QueueEvent)({
      id: event.id,
      organizationId: event.organizationId,
      partitionKey: `${event.organizationId}:${event.aggregateType}:${event.aggregateId}`,
      type: event.eventType,
      occurredAt: event.createdAt,
      payload: JSON.parse(event.payload) as unknown,
    }),
  )

export const deliverGenericOutboxEvent = async (
  event: OutboxEvent,
  deliverEvent: (queueName: 'gridora-outbox', event: QueueEvent) => Promise<void>,
): Promise<void> => deliverEvent('gridora-outbox', await toGenericOutboxQueueEvent(event))

export const toAuditExportQueueEvent = async (event: OutboxEvent): Promise<AuditExportEvent> => {
  const outboxSequence = event.id.match(/^audit-export-(\d{20})$/)?.[1]
  const aggregateSequence = event.aggregateId.match(/^audit-event-(\d{20})$/)?.[1]
  if (
    event.eventType !== 'audit.export.requested' ||
    event.aggregateType !== 'audit_event' ||
    outboxSequence === undefined ||
    aggregateSequence === undefined ||
    outboxSequence !== aggregateSequence
  )
    throw new TerminalOutboxFailure('E_AUDIT_EXPORT_CONTRACT')
  let payload: unknown
  try {
    payload = JSON.parse(event.payload)
  } catch {
    throw new TerminalOutboxFailure('E_AUDIT_EXPORT_CONTRACT')
  }
  const decoded = await Effect.runPromise(
    Effect.result(
      Schema.decodeUnknownEffect(AuditExportEvent, {
        onExcessProperty: 'error',
      })(payload),
    ),
  )
  if (
    decoded._tag === 'Failure' ||
    decoded.success.scope !== 'tenant' ||
    decoded.success.organizationId !== event.organizationId ||
    decoded.success.partitionKey !== auditPartitionKey(event.organizationId) ||
    decoded.success.exportRequestId !== event.id ||
    decoded.success.envelope.scope !== 'tenant' ||
    decoded.success.envelope.organizationId !== event.organizationId ||
    decoded.success.envelope.occurredAt !== event.createdAt
  )
    throw new TerminalOutboxFailure('E_AUDIT_EXPORT_CONTRACT')
  const prepared = await Effect.runPromise(
    Effect.result(prepareAuditExportQueueEvent(decoded.success)),
  )
  if (prepared._tag === 'Failure') throw new TerminalOutboxFailure('E_AUDIT_EXPORT_CONTRACT')
  return prepared.success
}

export const deliverAuditExportOutboxEvent = async (
  event: OutboxEvent,
  send: (auditEvent: AuditExportEvent) => Promise<unknown>,
): Promise<void> => {
  await send(await toAuditExportQueueEvent(event))
}

export const publishOutboxEvent = async (env: QueueEnv, event: OutboxEvent): Promise<void> => {
  if (event.eventType === 'audit.export.requested') {
    await deliverAuditExportOutboxEvent(event, (auditEvent) =>
      env.AUDIT_EXPORT.send(auditEvent, { contentType: 'json' }),
    )
    return
  }
  if (event.eventType === 'organization.invitation.created') {
    const payload = await decodeInvitationEmailPayload(JSON.parse(event.payload) as unknown)
    const previous =
      env.INVITATION_TOKEN_SECRET_PREVIOUS !== undefined &&
      env.INVITATION_TOKEN_PREVIOUS_KEY_VERSION !== undefined
        ? {
            secret: env.INVITATION_TOKEN_SECRET_PREVIOUS,
            version: env.INVITATION_TOKEN_PREVIOUS_KEY_VERSION,
          }
        : undefined
    const tokenKeys: InvitationTokenKeyring = {
      current: {
        secret: env.INVITATION_TOKEN_SECRET,
        version: env.INVITATION_TOKEN_KEY_VERSION,
      },
      previous,
    }
    const result = await sendInvitationEmail(
      event.id,
      payload,
      {
        publicAppUrl: env.PUBLIC_APP_URL,
        from: env.INVITATION_EMAIL_FROM,
        tokenKeys,
      },
      env.INVITATION_EMAIL,
    )
    if (result.status === 'permanent-failure') {
      log('warn', 'invitation_email_permanent_failure', {
        eventId: event.id,
        organizationId: event.organizationId,
        code: result.code,
      })
      await persistInvitationEmailRemediation(env.NOTIFICATION_REMEDIATION, {
        eventId: event.id,
        organizationId: event.organizationId,
        invitationId: payload.invitationId,
        code: result.code ?? 'E_UNKNOWN',
        eventCreatedAt: event.createdAt,
      })
      log('info', 'invitation_email_remediation_recorded', {
        eventId: event.id,
        organizationId: event.organizationId,
        code: result.code,
      })
      throw new TerminalOutboxFailure(result.code ?? 'E_UNKNOWN')
    }
    return
  }
  if (
    event.eventType === 'organization.membership.revoked' ||
    event.eventType === 'organization.membership.left' ||
    // A new membership revision makes every existing ticket stale. Closing
    // the old sockets is stronger than waiting for their next client frame;
    // the member may reconnect only with a freshly fenced ticket.
    event.eventType === 'organization.membership.role.updated'
  ) {
    const payload: unknown = JSON.parse(event.payload)
    const decoded: MembershipLiveLogPayload = await Effect.runPromise(
      Schema.decodeUnknownEffect(MembershipLiveLogPayload)(payload),
    )
    const principalId = 'principalId' in decoded ? decoded.principalId : decoded.identityId
    const events = env.ORGANIZATION_EVENTS.getByName(`${event.organizationId}:events`)
    await events.initialize(event.organizationId)
    await events.publish({
      id: event.id,
      organizationId: event.organizationId,
      type: event.eventType,
      resourceId: event.aggregateId,
      occurredAt: event.createdAt,
      data: decoded,
    })
    await synchronizeLiveLogPrincipal(env, event.organizationId, principalId)
    return
  }
  if (
    event.eventType === 'organization.live-log.suspended' ||
    event.eventType === 'organization.live-log.authorization.changed'
  ) {
    await synchronizeOrganizationLiveLogs(env, event.organizationId)
    return
  }
  await deliverGenericOutboxEvent(event, (queueName, queueEvent) =>
    Effect.runPromise(deliver(env, queueName, queueEvent)),
  )
}

export const publishOutbox = (env: QueueEnv): Effect.Effect<number, unknown, OutboxRepository> =>
  Effect.gen(function* () {
    const repository = yield* OutboxRepository
    const workerId = `outbox-worker:${crypto.randomUUID()}`
    const leaseToken = crypto.randomUUID()
    const now = yield* iso(Date.now())
    const leaseUntil = yield* iso(Date.now() + 60_000)
    const events = yield* repository.claimPending(workerId, leaseToken, 50, now, leaseUntil)
    const results = yield* Effect.forEach(
      events,
      (event) =>
        Effect.result(
          Effect.tryPromise({
            try: () =>
              deliverClaimedOutboxEvent(
                event,
                (claimed) => publishOutboxEvent(env, claimed),
                (claimed) =>
                  Effect.runPromise(
                    Effect.gen(function* () {
                      const deliveredAt = yield* iso(Date.now())
                      yield* repository.markDelivered(claimed.id, workerId, leaseToken, deliveredAt)
                    }),
                  ),
                (claimed, disposition) =>
                  Effect.runPromise(
                    Effect.gen(function* () {
                      if (disposition === 'terminal') {
                        yield* repository.markTerminalFailed(claimed.id, workerId, leaseToken)
                        return
                      }
                      const availableAt = yield* iso(
                        Date.now() +
                          Math.min(300_000, 2 ** Math.min(claimed.retryCount + 1, 8) * 1_000),
                      )
                      yield* repository.markFailed(claimed.id, workerId, leaseToken, availableAt)
                    }),
                  ),
              ),
            catch: (cause) => cause,
          }),
        ),
      { concurrency: 5 },
    )
    const failed = results.filter((result) => result._tag === 'Failure').length
    if (failed > 0) {
      return yield* Effect.fail(
        new Error(`Failed to publish ${failed} of ${events.length} claimed outbox events`),
      )
    }
    return events.length
  })

/**
 * Platform audit outbox is intentionally separate from tenant `outbox`: it has
 * no organization id, but shares the same lease and response-loss semantics.
 * Queue delivery happens before the exact lease is marked delivered, so a lost
 * response is safely replayed and R2 adopts the immutable event identity.
 */
export const publishPlatformAuditOutbox = async (
  env: Pick<QueueEnv, 'DB' | 'AUDIT_EXPORT'>,
): Promise<number> => {
  const repository = makePlatformAuditExportOutboxRepositoryD1(env.DB)
  const workerId = `platform-audit-outbox-worker:${crypto.randomUUID()}`
  const leaseToken = crypto.randomUUID()
  const now = await Effect.runPromise(iso(Date.now()))
  const leaseUntil = await Effect.runPromise(iso(Date.now() + 60_000))
  const events = await Effect.runPromise(
    repository.claimPending(workerId, leaseToken, 50, now, leaseUntil),
  )
  const results = await Promise.all(
    events.map(async (event) => {
      try {
        await env.AUDIT_EXPORT.send(event.payload, { contentType: 'json' })
      } catch (cause) {
        if (cause instanceof TerminalOutboxFailure) {
          await Effect.runPromise(repository.markTerminalFailed(event.id, workerId, leaseToken))
        } else {
          const availableAt = await Effect.runPromise(
            iso(Date.now() + Math.min(300_000, 2 ** Math.min(event.retryCount + 1, 8) * 1_000)),
          )
          await Effect.runPromise(
            repository.markFailed(event.id, workerId, leaseToken, availableAt),
          )
        }
        throw cause
      }
      await Effect.runPromise(
        repository.markDelivered(
          event.id,
          workerId,
          leaseToken,
          await Effect.runPromise(iso(Date.now())),
        ),
      )
    }),
  )
  return results.length
}

const deliver = (env: QueueEnv, queueName: string, event: QueueEvent): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const body = JSON.stringify(event)
      const routing = {
        method: 'POST',
        path: '/v1/internal/queue-events',
        queue: queueName,
        organizationId: event.organizationId,
      }
      const authentication = await Effect.runPromise(
        signInternalRequest(
          body,
          env.INTERNAL_SERVICE_SECRET,
          Date.now(),
          crypto.randomUUID(),
          routing,
        ),
      )
      const response = await env.APPLICATION.fetch(
        'https://gridora.internal/v1/internal/queue-events',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gridora-queue': queueName,
            'x-gridora-organization-id': event.organizationId,
            'idempotency-key': `queue:${event.id}`,
            ...authentication,
          },
          body,
        },
      )
      if (!response.ok) throw new Error(`Application rejected queue event with ${response.status}`)
      await response.body?.cancel()
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error('Queue event delivery failed')),
  })

const processMessage = (
  env: QueueEnv,
  queueName: string,
  message: Message<unknown>,
): Effect.Effect<'ack' | 'retry', never> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.result(Schema.decodeUnknownEffect(QueueEvent)(message.body))
    if (decoded._tag === 'Failure') {
      log('warn', 'queue_event_rejected', {
        queue: queueName,
        messageId: message.id,
        reason: 'invalid_schema',
      })
      return 'ack' as const
    }
    if (!validatePartition(decoded.success)) {
      log('warn', 'queue_event_rejected', {
        queue: queueName,
        messageId: message.id,
        reason: 'organization_partition_mismatch',
      })
      return 'ack' as const
    }
    const delivery = yield* Effect.result(deliver(env, queueName, decoded.success))
    if (delivery._tag === 'Failure') {
      log('error', 'queue_event_delivery_failed', {
        queue: queueName,
        messageId: message.id,
        eventId: decoded.success.id,
        organizationId: decoded.success.organizationId,
        attempt: message.attempts,
      })
      return 'retry' as const
    }
    log('info', 'queue_event_delivered', {
      queue: queueName,
      messageId: message.id,
      eventId: decoded.success.id,
      organizationId: decoded.success.organizationId,
    })
    return 'ack' as const
  })

const worker = {
  async queue(batch: MessageBatch<unknown>, env: QueueEnv): Promise<void> {
    if (batch.queue === 'gridora-outbox-publisher') {
      await processOutboxWakeup(batch, env)
      return
    }
    if (batch.queue === 'gridora-audit-export') {
      const decisions = await processAuditExportMessages(batch.messages, env.AUDIT_ARCHIVE)
      for (const decision of decisions) {
        if (decision.decision === 'ack') {
          log('info', 'audit_event_archived', {
            queue: batch.queue,
            organizationId: decision.receipt.organizationId,
            eventIdentitySha256: decision.receipt.eventIdentitySha256,
            checksum: decision.receipt.checksum,
            adopted: decision.receipt.adopted,
          })
        } else {
          log('error', 'audit_event_archive_failed', {
            queue: batch.queue,
            code: decision.errorCode,
          })
        }
      }
      return
    }
    if (batch.queue === 'gridora-telemetry') {
      const decisions = await Promise.all(
        batch.messages.map((message) => processLiveLogArchiveAvailable(env, message.body)),
      )
      for (const [index, decision] of decisions.entries()) {
        const message = batch.messages[index]
        if (message === undefined) continue
        log(decision.disposition === 'ack' ? 'info' : 'error', 'live_log_archive_publication', {
          queue: batch.queue,
          messageId: message.id,
          organizationId: decision.event?.organizationId,
          serverId: decision.event?.serverId,
          archiveId: decision.event?.archiveId,
          disposition: decision.disposition,
          reason: decision.reason,
        })
        if (decision.disposition === 'ack') message.ack()
        else message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) })
      }
      return
    }
    if (batch.queue === 'gridora-reconciliation') {
      const decisions = await Promise.all(
        batch.messages.map((message) => processOrphanMessage(env, message)),
      )
      for (const [index, decision] of decisions.entries()) {
        const message = batch.messages[index]
        if (message === undefined) continue
        if (decision === 'ack') message.ack()
        else message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) })
      }
      return
    }
    if (batch.queue === 'gridora-policy-reconciliation') {
      const decisions = await Promise.all(
        batch.messages.map((message) =>
          processPolicyReconciliationMessage(env.DB, env.RECONCILE_POLICY, message.body),
        ),
      )
      for (const [index, decision] of decisions.entries()) {
        const message = batch.messages[index]
        if (message === undefined) continue
        log(decision.disposition === 'ack' ? 'info' : 'error', 'policy_reconciliation_message', {
          queue: batch.queue,
          messageId: message.id,
          organizationId:
            typeof message.body === 'object' &&
            message.body !== null &&
            'organizationId' in message.body
              ? message.body.organizationId
              : undefined,
          disposition: decision.disposition,
          reason: decision.reason,
        })
        if (decision.disposition === 'ack') message.ack()
        else message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) })
      }
      return
    }
    const decisions = await Effect.runPromise(
      Effect.forEach(batch.messages, (message) => processMessage(env, batch.queue, message), {
        concurrency: 10,
      }),
    )
    for (const [index, decision] of decisions.entries()) {
      const message = batch.messages[index]
      if (message === undefined) continue
      if (decision === 'ack') message.ack()
      else message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) })
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: QueueEnv,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(scheduleOrphanReconciliations(env, controller.scheduledTime))
    context.waitUntil(
      schedulePolicyReconciliations(
        env.DB,
        env.POLICY_RECONCILIATION_QUEUE,
        controller.scheduledTime,
      ),
    )
    context.waitUntil(dispatchScheduledBackups(env, controller.scheduledTime))
    context.waitUntil(dispatchScheduledGameServers(env, controller.scheduledTime))
    context.waitUntil(
      reconcilePendingTelemetryArchives(env.DB, env.LOGS, controller.scheduledTime).then(
        (results) => {
          for (const result of results) {
            log(result.disposition === 'retry' ? 'error' : 'info', 'telemetry_archive_reconciled', {
              disposition: result.disposition,
              organizationId: result.archive?.organizationId,
              archiveId: result.archive?.archiveId,
            })
          }
        },
      ),
    )
    context.waitUntil(
      Promise.all([
        drainOutbox(() => outboxRuntime(env).runPromise(publishOutbox(env))),
        drainOutbox(() => publishPlatformAuditOutbox(env)),
      ]).then(() => undefined),
    )
  },

  fetch(): Response {
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<QueueEnv>

export default worker
export { QueueEvent, processMessage, validatePartition }

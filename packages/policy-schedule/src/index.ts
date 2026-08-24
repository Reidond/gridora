import { Effect, Schema } from 'effect'
import { IsoDateTime } from '@gridora/domain'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
)
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const PolicyScheduleInput = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  policyRevision: Revision,
  scheduleSlot: IsoDateTime,
})
export type PolicyScheduleInput = typeof PolicyScheduleInput.Type

/** A queue/Workflow payload contains no credentials, health body, or client input. */
export const PolicyScheduleTask = Schema.Struct({
  ...PolicyScheduleInput.fields,
  runId: Identifier,
  idempotencyKey: Identifier,
  workflowId: Identifier,
  leaseToken: Identifier,
})
export type PolicyScheduleTask = typeof PolicyScheduleTask.Type

export const POLICY_SCHEDULE_LEASE_MILLISECONDS = 15 * 60_000
export const POLICY_SCHEDULE_PAGE_SIZE = 25

export class PolicyScheduleError extends Schema.TaggedError<PolicyScheduleError>()(
  'PolicyScheduleError',
  {
    operation: Schema.String,
    code: Schema.Literals([
      'invalid-task',
      'invalid-scope',
      'lease-expired',
      'persistence-failed',
      'idempotency-conflict',
    ]),
    message: Schema.Literal('scheduled policy reconciliation could not be verified'),
  },
) {}

const failure = (
  operation: string,
  code: (typeof PolicyScheduleError.Type)['code'],
): PolicyScheduleError =>
  new PolicyScheduleError({
    operation,
    code,
    message: 'scheduled policy reconciliation could not be verified',
  })

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Stable identities make queue response loss and Workflow adoption one durable task. */
export const derivePolicyScheduleTask = (
  input: unknown,
): Effect.Effect<PolicyScheduleTask, PolicyScheduleError> =>
  Schema.decodeUnknownEffect(PolicyScheduleInput, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(() => failure('policy.schedule.task.decode', 'invalid-task')),
    Effect.flatMap((decoded) =>
      Effect.tryPromise({
        try: async () => {
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(
                [
                  'gridora-policy-schedule-v1',
                  decoded.organizationId,
                  decoded.actorId,
                  String(decoded.policyRevision),
                  decoded.scheduleSlot,
                ].join('\u0000'),
              ),
            ),
          )
          const identity = hex(digest)
          return {
            ...decoded,
            runId: `policy-run-${identity}`,
            idempotencyKey: `policy-idempotency-${identity}`,
            workflowId: `policy-workflow-${identity}`,
            leaseToken: `policy-lease-${identity}`,
          }
        },
        catch: () => failure('policy.schedule.task.derive', 'persistence-failed'),
      }),
    ),
    Effect.flatMap((task) =>
      Schema.decodeUnknownEffect(PolicyScheduleTask, { onExcessProperty: 'error' })(task).pipe(
        Effect.mapError(() => failure('policy.schedule.task.derive', 'invalid-task')),
      ),
    ),
  )

export const decodePolicyScheduleTask = (
  input: unknown,
): Effect.Effect<PolicyScheduleTask, PolicyScheduleError> =>
  Schema.decodeUnknownEffect(PolicyScheduleTask, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(() => failure('policy.schedule.task.decode', 'invalid-task')),
  )

export interface PolicyScheduleD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface PolicyScheduleD1Statement {
  bind(...values: ReadonlyArray<unknown>): PolicyScheduleD1Statement
  first(): Promise<unknown>
  all(): Promise<PolicyScheduleD1Result>
}
export interface PolicyScheduleD1Database {
  prepare(sql: string): PolicyScheduleD1Statement
  batch(statements: ReadonlyArray<PolicyScheduleD1Statement>): Promise<ReadonlyArray<unknown>>
}

export interface PolicyScheduleStoreOptions {
  readonly now?: () => Date
  readonly leaseMilliseconds?: number
  readonly pageSize?: number
}
const defaults: Required<PolicyScheduleStoreOptions> = {
  now: () => new Date(),
  leaseMilliseconds: POLICY_SCHEDULE_LEASE_MILLISECONDS,
  pageSize: POLICY_SCHEDULE_PAGE_SIZE,
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const text = (value: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof value[key] === 'string' ? (value[key] as string) : undefined
const integer = (value: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof value[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined

const exactTaskSelect = `SELECT lease.organization_id AS organizationId, lease.actor_id AS actorId,
 lease.policy_revision AS policyRevision, lease.schedule_slot AS scheduleSlot,
 lease.run_id AS runId, lease.idempotency_key AS idempotencyKey,
 lease.workflow_id AS workflowId, lease.lease_token AS leaseToken,
 lease.state, lease.lease_until AS leaseUntil, lease.revision
 FROM policy_reconciliation_schedule_leases lease
 WHERE lease.organization_id = ? AND lease.schedule_slot = ?`

const exactScope = `SELECT lease.state, lease.lease_until AS leaseUntil
 FROM policy_reconciliation_schedule_leases lease
 JOIN organizations organization ON organization.id = lease.organization_id
 JOIN organization_policies policy ON policy.organization_id = organization.id
 JOIN policy_reconciliation_scheduler_identities scheduler
   ON scheduler.organization_id = lease.organization_id AND scheduler.identity_id = lease.actor_id
 JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
 JOIN organization_memberships membership
   ON membership.organization_id = lease.organization_id AND membership.identity_id = actor.id
 WHERE lease.organization_id = ? AND lease.actor_id = ? AND lease.policy_revision = ?
   AND lease.schedule_slot = ? AND lease.run_id = ? AND lease.idempotency_key = ?
   AND lease.workflow_id = ? AND lease.lease_token = ?
   AND organization.status = 'active' AND organization.policy_revision = lease.policy_revision
   AND policy.revision = lease.policy_revision
   AND json_extract(policy.policy_json, '$.organizationId') = lease.organization_id
   AND json_extract(policy.policy_json, '$.revision') = lease.policy_revision
   AND membership.status = 'active' AND membership.role = 'automation'`

const recoverableSelect = `SELECT lease.organization_id AS organizationId, lease.actor_id AS actorId,
 lease.policy_revision AS policyRevision, lease.schedule_slot AS scheduleSlot,
 lease.run_id AS runId, lease.idempotency_key AS idempotencyKey,
 lease.workflow_id AS workflowId, lease.lease_token AS leaseToken,
 lease.state, lease.lease_until AS leaseUntil, lease.revision
 FROM policy_reconciliation_schedule_leases lease
 JOIN organizations organization ON organization.id = lease.organization_id AND organization.status = 'active'
 JOIN organization_policies policy ON policy.organization_id = organization.id
 JOIN policy_reconciliation_scheduler_identities scheduler
   ON scheduler.organization_id = lease.organization_id AND scheduler.identity_id = lease.actor_id
 JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
 JOIN organization_memberships membership
   ON membership.organization_id = lease.organization_id AND membership.identity_id = actor.id
 WHERE lease.state IN ('pending', 'running') AND julianday(lease.lease_until) <= julianday(?)
   AND organization.policy_revision = lease.policy_revision AND policy.revision = lease.policy_revision
   AND membership.status = 'active' AND membership.role = 'automation'
 ORDER BY lease.schedule_slot, lease.organization_id LIMIT ?`

const organizationPage = `SELECT organization.id AS organizationId,
 scheduler.identity_id AS actorId, organization.policy_revision AS policyRevision
 FROM organizations organization
 JOIN organization_policies policy ON policy.organization_id = organization.id
 JOIN policy_reconciliation_scheduler_identities scheduler ON scheduler.organization_id = organization.id
 JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
 JOIN organization_memberships membership
   ON membership.organization_id = organization.id AND membership.identity_id = actor.id
 WHERE organization.status = 'active'
   AND policy.revision = organization.policy_revision
   AND json_extract(policy.policy_json, '$.organizationId') = organization.id
   AND json_extract(policy.policy_json, '$.revision') = organization.policy_revision
   AND membership.status = 'active' AND membership.role = 'automation'
   AND NOT EXISTS (
     SELECT 1 FROM policy_reconciliation_schedule_leases activeLease
     WHERE activeLease.organization_id = organization.id
       AND activeLease.state IN ('pending', 'running')
       AND julianday(activeLease.lease_until) > julianday(?)
   )
   AND organization.id > ?
 ORDER BY organization.id LIMIT ?`

const cursorSelect = `SELECT last_organization_id AS organizationId
 FROM policy_reconciliation_schedule_cursor WHERE id = 'policy-schedule-v1'`
const cursorUpsert = `INSERT INTO policy_reconciliation_schedule_cursor
 (id, last_organization_id, updated_at, revision)
 VALUES ('policy-schedule-v1', ?, ?, 1)
 ON CONFLICT(id) DO UPDATE SET last_organization_id = excluded.last_organization_id,
   updated_at = excluded.updated_at,
   revision = policy_reconciliation_schedule_cursor.revision + 1`
const insertTask = `INSERT OR IGNORE INTO policy_reconciliation_schedule_leases
 (organization_id, actor_id, policy_revision, schedule_slot, run_id, idempotency_key,
  workflow_id, lease_token, state, lease_until, created_at, started_at, completed_at, revision)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 1)`

const sameTask = (left: PolicyScheduleTask, right: PolicyScheduleTask): boolean =>
  left.organizationId === right.organizationId &&
  left.actorId === right.actorId &&
  left.policyRevision === right.policyRevision &&
  left.scheduleSlot === right.scheduleSlot &&
  left.runId === right.runId &&
  left.idempotencyKey === right.idempotencyKey &&
  left.workflowId === right.workflowId &&
  left.leaseToken === right.leaseToken

interface DecodedLease {
  readonly task: PolicyScheduleTask
  readonly state: 'pending' | 'running' | 'completed'
  readonly leaseUntil: string
  readonly revision: number
}

const decodeLease = (value: unknown): Effect.Effect<DecodedLease, PolicyScheduleError> => {
  const row = record(value)
  if (row === undefined)
    return Effect.fail(failure('policy.schedule.lease.decode', 'persistence-failed'))
  const state = text(row, 'state')
  const leaseUntil = text(row, 'leaseUntil')
  const revision = integer(row, 'revision')
  if (
    (state !== 'pending' && state !== 'running' && state !== 'completed') ||
    leaseUntil === undefined ||
    revision === undefined ||
    revision < 1
  )
    return Effect.fail(failure('policy.schedule.lease.decode', 'persistence-failed'))
  return decodePolicyScheduleTask({
    organizationId: text(row, 'organizationId'),
    actorId: text(row, 'actorId'),
    policyRevision: integer(row, 'policyRevision'),
    scheduleSlot: text(row, 'scheduleSlot'),
    runId: text(row, 'runId'),
    idempotencyKey: text(row, 'idempotencyKey'),
    workflowId: text(row, 'workflowId'),
    leaseToken: text(row, 'leaseToken'),
  }).pipe(Effect.map((task) => ({ task, state, leaseUntil, revision })))
}

const d1 = <A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, PolicyScheduleError> =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation, 'persistence-failed') })
const withinLease = (leaseUntil: string, now: string): boolean =>
  Number.isFinite(Date.parse(leaseUntil)) && Date.parse(leaseUntil) > Date.parse(now)
const taskBindings = (task: PolicyScheduleTask): ReadonlyArray<unknown> => [
  task.organizationId,
  task.actorId,
  task.policyRevision,
  task.scheduleSlot,
  task.runId,
  task.idempotencyKey,
  task.workflowId,
  task.leaseToken,
]

const taskFromLease = (
  lease: DecodedLease,
): Effect.Effect<PolicyScheduleTask, PolicyScheduleError> =>
  derivePolicyScheduleTask({
    organizationId: lease.task.organizationId,
    actorId: lease.task.actorId,
    policyRevision: lease.task.policyRevision,
    scheduleSlot: lease.task.scheduleSlot,
  }).pipe(
    Effect.flatMap((derived) =>
      sameTask(derived, lease.task)
        ? Effect.succeed(derived)
        : Effect.fail(failure('policy.schedule.lease.binding', 'idempotency-conflict')),
    ),
  )

const exactLease = (
  database: PolicyScheduleD1Database,
  task: PolicyScheduleTask,
): Effect.Effect<DecodedLease, PolicyScheduleError> =>
  d1('policy.schedule.lease.read', () =>
    database.prepare(exactTaskSelect).bind(task.organizationId, task.scheduleSlot).first(),
  ).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(failure('policy.schedule.lease.read', 'invalid-scope'))
        : decodeLease(value),
    ),
    Effect.flatMap((lease) =>
      sameTask(lease.task, task)
        ? taskFromLease(lease).pipe(Effect.as(lease))
        : Effect.fail(failure('policy.schedule.lease.binding', 'idempotency-conflict')),
    ),
  )

export interface PolicyScheduleStore {
  readonly claimScheduledTasks: (
    scheduleSlot: unknown,
  ) => Effect.Effect<readonly PolicyScheduleTask[], PolicyScheduleError>
  readonly beginWorkflow: (
    task: unknown,
  ) => Effect.Effect<'started' | 'adopted', PolicyScheduleError>
  readonly assertExecutionLease: (task: unknown) => Effect.Effect<void, PolicyScheduleError>
  readonly complete: (task: unknown) => Effect.Effect<'completed' | 'replayed', PolicyScheduleError>
}

export const makePolicyScheduleStore = (
  database: PolicyScheduleD1Database,
  overrides: PolicyScheduleStoreOptions = {},
): PolicyScheduleStore => {
  const options = { ...defaults, ...overrides }
  const now = (): string => options.now().toISOString()
  const leaseUntil = (): string =>
    new Date(options.now().getTime() + options.leaseMilliseconds).toISOString()
  const pageSize = Math.max(1, Math.min(POLICY_SCHEDULE_PAGE_SIZE, Math.trunc(options.pageSize)))
  const decodeTask = (input: unknown) => decodePolicyScheduleTask(input)
  const validateSlot = (input: unknown) =>
    Schema.decodeUnknownEffect(IsoDateTime, { onExcessProperty: 'error' })(input).pipe(
      Effect.mapError(() => failure('policy.schedule.slot', 'invalid-task')),
    )

  const scopeLease = (task: PolicyScheduleTask) =>
    d1('policy.schedule.scope', () =>
      database
        .prepare(exactScope)
        .bind(...taskBindings(task))
        .first(),
    ).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(failure('policy.schedule.scope', 'invalid-scope'))
          : Effect.succeed(value),
      ),
      Effect.flatMap((value) => {
        const row = record(value)
        const state = row === undefined ? undefined : text(row, 'state')
        const leaseUntil = row === undefined ? undefined : text(row, 'leaseUntil')
        return state === undefined || leaseUntil === undefined
          ? Effect.fail(failure('policy.schedule.scope.decode', 'persistence-failed'))
          : Effect.succeed({ state, leaseUntil })
      }),
    )

  const recoverExpired = (current: string) =>
    d1('policy.schedule.recover.select', () =>
      database.prepare(recoverableSelect).bind(current, pageSize).all(),
    ).pipe(
      Effect.flatMap((result) => Effect.forEach(result.results, decodeLease)),
      Effect.flatMap((leases) => Effect.forEach(leases, taskFromLease)),
      Effect.flatMap((tasks) =>
        tasks.length === 0
          ? Effect.succeed(tasks)
          : d1('policy.schedule.recover.renew', () =>
              database.batch(
                tasks.map((task) =>
                  database
                    .prepare(`UPDATE policy_reconciliation_schedule_leases
                      SET lease_until = ?, revision = revision + 1
                      WHERE organization_id = ? AND schedule_slot = ? AND actor_id = ?
                        AND policy_revision = ? AND run_id = ? AND idempotency_key = ?
                        AND workflow_id = ? AND lease_token = ?
                        AND state IN ('pending', 'running') AND julianday(lease_until) <= julianday(?)`)
                    .bind(
                      leaseUntil(),
                      task.organizationId,
                      task.scheduleSlot,
                      task.actorId,
                      task.policyRevision,
                      task.runId,
                      task.idempotencyKey,
                      task.workflowId,
                      task.leaseToken,
                      current,
                    ),
                ),
              ),
            ).pipe(
              Effect.flatMap(() => Effect.forEach(tasks, (task) => exactLease(database, task))),
              Effect.flatMap((leases) =>
                leases.some((lease) => !withinLease(lease.leaseUntil, current))
                  ? Effect.fail(failure('policy.schedule.recover.renew', 'lease-expired'))
                  : Effect.succeed(tasks),
              ),
            ),
      ),
    )

  const claimScheduledTasks: PolicyScheduleStore['claimScheduledTasks'] = (scheduleSlot) =>
    Effect.gen(function* () {
      const slot = yield* validateSlot(scheduleSlot)
      const current = now()
      const recovered = yield* recoverExpired(current)
      if (recovered.length > 0) return recovered
      const cursor = yield* d1('policy.schedule.cursor.read', () =>
        database.prepare(cursorSelect).first(),
      )
      const cursorRow = cursor === null ? undefined : record(cursor)
      const cursorOrganizationId =
        cursorRow === undefined ? '' : (text(cursorRow, 'organizationId') ?? '')
      const query = (after: string) =>
        d1('policy.schedule.organizations', () =>
          database.prepare(organizationPage).bind(current, after, pageSize).all(),
        )
      let page = yield* query(cursorOrganizationId)
      if (page.results.length === 0 && cursorOrganizationId.length > 0) page = yield* query('')
      if (page.results.length > pageSize)
        return yield* failure('policy.schedule.organizations.bound', 'persistence-failed')
      const tasks = yield* Effect.forEach(page.results, (value) => {
        const row = record(value)
        return row === undefined
          ? Effect.fail(failure('policy.schedule.organizations.decode', 'persistence-failed'))
          : derivePolicyScheduleTask({
              organizationId: text(row, 'organizationId'),
              actorId: text(row, 'actorId'),
              policyRevision: integer(row, 'policyRevision'),
              scheduleSlot: slot,
            })
      })
      if (tasks.length === 0) return tasks
      const last = tasks.at(-1)
      if (last === undefined)
        return yield* failure('policy.schedule.cursor.write', 'persistence-failed')
      const persisted = yield* Effect.result(
        d1('policy.schedule.tasks.insert', () =>
          database.batch([
            ...tasks.map((task) =>
              database.prepare(insertTask).bind(...taskBindings(task), leaseUntil(), current),
            ),
            database.prepare(cursorUpsert).bind(last.organizationId, current),
          ]),
        ),
      )
      if (persisted._tag === 'Failure') {
        const adopted = yield* Effect.forEach(tasks, (task) => exactLease(database, task))
        if (adopted.some((lease) => !withinLease(lease.leaseUntil, current)))
          return yield* persisted.failure
      }
      const exact = yield* Effect.forEach(tasks, (task) => exactLease(database, task))
      if (exact.some((lease) => !withinLease(lease.leaseUntil, current)))
        return yield* failure('policy.schedule.tasks.insert', 'lease-expired')
      return tasks
    })

  const beginWorkflow: PolicyScheduleStore['beginWorkflow'] = (input) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(input)
      const current = now()
      const lease = yield* exactLease(database, task)
      if (lease.state === 'completed')
        return yield* failure('policy.schedule.begin.completed', 'idempotency-conflict')
      if (!withinLease(lease.leaseUntil, current))
        return yield* failure('policy.schedule.begin.lease', 'lease-expired')
      const scope = yield* scopeLease(task)
      if (
        (scope.state !== 'pending' && scope.state !== 'running') ||
        !withinLease(scope.leaseUntil, current)
      )
        return yield* failure('policy.schedule.begin.scope', 'lease-expired')
      if (lease.state === 'running') return 'adopted' as const
      const updated = yield* Effect.result(
        d1('policy.schedule.begin.update', () =>
          database.batch([
            database
              .prepare(`UPDATE policy_reconciliation_schedule_leases
                SET state = 'running', started_at = COALESCE(started_at, ?), revision = revision + 1
                WHERE organization_id = ? AND schedule_slot = ? AND actor_id = ?
                  AND policy_revision = ? AND run_id = ? AND idempotency_key = ?
                  AND workflow_id = ? AND lease_token = ? AND state = 'pending'
                  AND julianday(lease_until) > julianday(?)`)
              .bind(
                current,
                task.organizationId,
                task.scheduleSlot,
                task.actorId,
                task.policyRevision,
                task.runId,
                task.idempotencyKey,
                task.workflowId,
                task.leaseToken,
                current,
              ),
          ]),
        ),
      )
      if (updated._tag === 'Failure') {
        const adopted = yield* exactLease(database, task)
        if (adopted.state !== 'running' || !withinLease(adopted.leaseUntil, current))
          return yield* updated.failure
        return 'adopted' as const
      }
      const confirmed = yield* exactLease(database, task)
      if (confirmed.state !== 'running' || !withinLease(confirmed.leaseUntil, current))
        return yield* failure('policy.schedule.begin.confirm', 'lease-expired')
      return 'started' as const
    })

  const assertExecutionLease: PolicyScheduleStore['assertExecutionLease'] = (input) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(input)
      const current = now()
      const lease = yield* exactLease(database, task)
      if (lease.state !== 'running' || !withinLease(lease.leaseUntil, current))
        return yield* failure('policy.schedule.execute.lease', 'lease-expired')
      const scope = yield* scopeLease(task)
      if (scope.state !== 'running' || !withinLease(scope.leaseUntil, current))
        return yield* failure('policy.schedule.execute.scope', 'lease-expired')
    })

  const complete: PolicyScheduleStore['complete'] = (input) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(input)
      const current = now()
      const lease = yield* exactLease(database, task)
      if (lease.state === 'completed') return 'replayed' as const
      if (lease.state !== 'running' || !withinLease(lease.leaseUntil, current))
        return yield* failure('policy.schedule.complete.lease', 'lease-expired')
      yield* assertExecutionLease(task)
      const committed = yield* Effect.result(
        d1('policy.schedule.complete.update', () =>
          database.batch([
            database
              .prepare(`UPDATE policy_reconciliation_schedule_leases
                SET state = 'completed', completed_at = ?, revision = revision + 1
                WHERE organization_id = ? AND schedule_slot = ? AND actor_id = ?
                  AND policy_revision = ? AND run_id = ? AND idempotency_key = ?
                  AND workflow_id = ? AND lease_token = ? AND state = 'running'
                  AND julianday(lease_until) > julianday(?)`)
              .bind(
                current,
                task.organizationId,
                task.scheduleSlot,
                task.actorId,
                task.policyRevision,
                task.runId,
                task.idempotencyKey,
                task.workflowId,
                task.leaseToken,
                current,
              ),
          ]),
        ),
      )
      if (committed._tag === 'Failure') {
        const recovered = yield* exactLease(database, task)
        if (recovered.state !== 'completed') return yield* committed.failure
        return 'replayed' as const
      }
      const confirmed = yield* exactLease(database, task)
      if (confirmed.state !== 'completed')
        return yield* failure('policy.schedule.complete.confirm', 'persistence-failed')
      return 'completed' as const
    })

  return { claimScheduledTasks, beginWorkflow, assertExecutionLease, complete }
}

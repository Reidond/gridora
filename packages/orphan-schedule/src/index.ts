import { Effect, Schema } from 'effect'
import { IsoDateTime } from '@gridora/domain'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
)
const ProviderType = Schema.Literals(['ovhcloud', 'contabo'])

export const OrphanScheduleInput = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  providerType: ProviderType,
  actorId: Identifier,
  scheduleSlot: IsoDateTime,
})
export type OrphanScheduleInput = typeof OrphanScheduleInput.Type

/**
 * This is the only queue and Workflow payload for scheduled orphan discovery.
 * It deliberately contains no credential reference, encrypted envelope, or
 * provider response. Every field is verified again from D1 before execution.
 */
export const OrphanScheduleTask = Schema.Struct({
  ...OrphanScheduleInput.fields,
  runId: Identifier,
  idempotencyKey: Identifier,
  workflowId: Identifier,
  leaseToken: Identifier,
})
export type OrphanScheduleTask = typeof OrphanScheduleTask.Type

export const ORPHAN_SCHEDULE_LEASE_MILLISECONDS = 15 * 60 * 1000
export const ORPHAN_SCHEDULE_PAGE_SIZE = 25

export class OrphanScheduleError extends Schema.TaggedError<OrphanScheduleError>()(
  'OrphanScheduleError',
  {
    operation: Schema.String,
    code: Schema.Literals([
      'invalid-task',
      'invalid-scope',
      'lease-expired',
      'persistence-failed',
      'idempotency-conflict',
    ]),
    message: Schema.String,
  },
) {}

const scheduleFailure = (operation: string, code: (typeof OrphanScheduleError.Type)['code']) =>
  new OrphanScheduleError({
    operation,
    code,
    message: 'scheduled orphan reconciliation could not be verified',
  })

const hexadecimal = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Derive stable identifiers before a task reaches a queue. A retry, a queue
 * response loss, and a Workflow adoption therefore all refer to one D1 row.
 */
export const deriveOrphanScheduleTask = (
  input: unknown,
): Effect.Effect<OrphanScheduleTask, OrphanScheduleError> =>
  Schema.decodeUnknownEffect(OrphanScheduleInput, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(() => scheduleFailure('orphan.schedule.task.decode', 'invalid-task')),
    Effect.flatMap((decoded) =>
      Effect.tryPromise({
        try: async () => {
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(
                [
                  'gridora-orphan-schedule-v1',
                  decoded.organizationId,
                  decoded.providerAccountId,
                  decoded.providerType,
                  decoded.actorId,
                  decoded.scheduleSlot,
                ].join('\u0000'),
              ),
            ),
          )
          const identity = hexadecimal(digest)
          return {
            ...decoded,
            runId: `orphan-run-${identity}`,
            idempotencyKey: `orphan-idempotency-${identity}`,
            workflowId: `orphan-workflow-${identity}`,
            leaseToken: `orphan-lease-${identity}`,
          }
        },
        catch: () => scheduleFailure('orphan.schedule.task.derive', 'persistence-failed'),
      }),
    ),
    Effect.flatMap((task) =>
      Schema.decodeUnknownEffect(OrphanScheduleTask, { onExcessProperty: 'error' })(task).pipe(
        Effect.mapError(() => scheduleFailure('orphan.schedule.task.derive', 'invalid-task')),
      ),
    ),
  )

export const decodeOrphanScheduleTask = (
  input: unknown,
): Effect.Effect<OrphanScheduleTask, OrphanScheduleError> =>
  Schema.decodeUnknownEffect(OrphanScheduleTask, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(() => scheduleFailure('orphan.schedule.task.decode', 'invalid-task')),
  )

export interface OrphanScheduleD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}

export interface OrphanScheduleD1Statement {
  bind(...values: ReadonlyArray<unknown>): OrphanScheduleD1Statement
  first(): Promise<unknown>
  all(): Promise<OrphanScheduleD1Result>
}

export interface OrphanScheduleD1Database {
  prepare(sql: string): OrphanScheduleD1Statement
  /** Cloudflare D1 batches either commit all statements or roll the batch back. */
  batch(statements: ReadonlyArray<OrphanScheduleD1Statement>): Promise<ReadonlyArray<unknown>>
}

export interface OrphanScheduleStoreOptions {
  readonly now?: () => Date
  readonly leaseMilliseconds?: number
  readonly pageSize?: number
}

const defaults: Required<OrphanScheduleStoreOptions> = {
  now: () => new Date(),
  leaseMilliseconds: ORPHAN_SCHEDULE_LEASE_MILLISECONDS,
  pageSize: ORPHAN_SCHEDULE_PAGE_SIZE,
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

const exactTaskSelect = `SELECT lease.organization_id AS organizationId,
 lease.provider_account_id AS providerAccountId, lease.provider_type AS providerType,
 lease.actor_id AS actorId, lease.schedule_slot AS scheduleSlot, lease.run_id AS runId,
 lease.idempotency_key AS idempotencyKey, lease.workflow_id AS workflowId,
 lease.lease_token AS leaseToken, lease.state, lease.lease_until AS leaseUntil,
 lease.revision
 FROM orphan_reconciliation_schedule_leases AS lease
 WHERE lease.organization_id = ? AND lease.provider_account_id = ?
   AND lease.schedule_slot = ?`

const exactScope = `SELECT lease.state, lease.lease_until AS leaseUntil
 FROM orphan_reconciliation_schedule_leases AS lease
 JOIN provider_allocations AS allocation
   ON allocation.organization_id = lease.organization_id
  AND allocation.provider_account_id = lease.provider_account_id
  AND allocation.status = 'active'
 JOIN provider_accounts AS account
   ON account.id = allocation.provider_account_id
  AND account.provider_type = lease.provider_type
  AND account.status = 'active'
 JOIN organizations AS organization
   ON organization.id = allocation.organization_id
  AND organization.status = 'active'
 JOIN orphan_reconciliation_scheduler_identities AS schedulerIdentity
   ON schedulerIdentity.organization_id = lease.organization_id
  AND schedulerIdentity.identity_id = lease.actor_id
 JOIN identities AS actor ON actor.id = schedulerIdentity.identity_id AND actor.status = 'active'
 JOIN organization_memberships AS membership
   ON membership.organization_id = lease.organization_id
  AND membership.identity_id = schedulerIdentity.identity_id
  AND membership.role = 'automation'
  AND membership.status = 'active'
 WHERE lease.organization_id = ? AND lease.provider_account_id = ?
   AND lease.provider_type = ? AND lease.actor_id = ?
   AND lease.schedule_slot = ? AND lease.run_id = ?
   AND lease.idempotency_key = ? AND lease.workflow_id = ? AND lease.lease_token = ?
   AND (
     (account.scope = 'platform' AND account.organization_id IS NULL AND EXISTS (
       SELECT 1 FROM platform_secret_envelopes AS secret
       WHERE secret.id = account.credential_reference
         AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
     ))
     OR
     (account.scope = 'organization' AND account.organization_id = lease.organization_id AND EXISTS (
       SELECT 1 FROM secret_envelopes AS secret
       WHERE secret.organization_id = lease.organization_id
         AND secret.id = account.credential_reference
         AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
     ))
   )`

const recoverableSelect = `SELECT lease.organization_id AS organizationId,
 lease.provider_account_id AS providerAccountId, lease.provider_type AS providerType,
 lease.actor_id AS actorId, lease.schedule_slot AS scheduleSlot, lease.run_id AS runId,
 lease.idempotency_key AS idempotencyKey, lease.workflow_id AS workflowId,
 lease.lease_token AS leaseToken, lease.state, lease.lease_until AS leaseUntil,
 lease.revision
 FROM orphan_reconciliation_schedule_leases AS lease
 JOIN provider_allocations AS allocation
   ON allocation.organization_id = lease.organization_id
  AND allocation.provider_account_id = lease.provider_account_id
  AND allocation.status = 'active'
 JOIN provider_accounts AS account
   ON account.id = allocation.provider_account_id
  AND account.provider_type = lease.provider_type
  AND account.status = 'active'
 JOIN organizations AS organization
   ON organization.id = allocation.organization_id AND organization.status = 'active'
 JOIN orphan_reconciliation_scheduler_identities AS schedulerIdentity
   ON schedulerIdentity.organization_id = lease.organization_id
  AND schedulerIdentity.identity_id = lease.actor_id
 JOIN identities AS actor ON actor.id = schedulerIdentity.identity_id AND actor.status = 'active'
 JOIN organization_memberships AS membership
   ON membership.organization_id = lease.organization_id
  AND membership.identity_id = schedulerIdentity.identity_id
  AND membership.role = 'automation' AND membership.status = 'active'
 WHERE lease.state IN ('pending', 'running')
   AND julianday(lease.lease_until) <= julianday(?)
 ORDER BY lease.schedule_slot, lease.organization_id, lease.provider_account_id
 LIMIT ?`

const allocationPage = `SELECT allocation.organization_id AS organizationId,
 allocation.provider_account_id AS providerAccountId, account.provider_type AS providerType,
 schedulerIdentity.identity_id AS actorId
 FROM provider_allocations AS allocation
 JOIN provider_accounts AS account
   ON account.id = allocation.provider_account_id AND account.status = 'active'
 JOIN organizations AS organization
   ON organization.id = allocation.organization_id AND organization.status = 'active'
 JOIN orphan_reconciliation_scheduler_identities AS schedulerIdentity
   ON schedulerIdentity.organization_id = allocation.organization_id
 JOIN identities AS actor ON actor.id = schedulerIdentity.identity_id AND actor.status = 'active'
 JOIN organization_memberships AS membership
   ON membership.organization_id = allocation.organization_id
  AND membership.identity_id = schedulerIdentity.identity_id
  AND membership.role = 'automation' AND membership.status = 'active'
 WHERE allocation.status = 'active'
   AND (
     (account.scope = 'platform' AND account.organization_id IS NULL AND EXISTS (
       SELECT 1 FROM platform_secret_envelopes AS secret
       WHERE secret.id = account.credential_reference
         AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
     ))
     OR
     (account.scope = 'organization' AND account.organization_id = allocation.organization_id AND EXISTS (
       SELECT 1 FROM secret_envelopes AS secret
       WHERE secret.organization_id = allocation.organization_id
         AND secret.id = account.credential_reference
         AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
     ))
   )
   AND NOT EXISTS (
     SELECT 1 FROM orphan_reconciliation_schedule_leases AS activeLease
     WHERE activeLease.organization_id = allocation.organization_id
       AND activeLease.provider_account_id = allocation.provider_account_id
       AND activeLease.state IN ('pending', 'running')
       AND julianday(activeLease.lease_until) > julianday(?)
   )
   AND (
     allocation.organization_id > ?
     OR (allocation.organization_id = ? AND allocation.provider_account_id > ?)
   )
 ORDER BY allocation.organization_id, allocation.provider_account_id
 LIMIT ?`

const cursorSelect = `SELECT last_organization_id AS organizationId,
 last_provider_account_id AS providerAccountId
 FROM orphan_reconciliation_schedule_cursor WHERE id = 'orphan-schedule-v1'`

const cursorUpsert = `INSERT INTO orphan_reconciliation_schedule_cursor
 (id, last_organization_id, last_provider_account_id, updated_at, revision)
 VALUES ('orphan-schedule-v1', ?, ?, ?, 1)
 ON CONFLICT(id) DO UPDATE SET
  last_organization_id = excluded.last_organization_id,
  last_provider_account_id = excluded.last_provider_account_id,
  updated_at = excluded.updated_at,
  revision = orphan_reconciliation_schedule_cursor.revision + 1`

const insertTask = `INSERT OR IGNORE INTO orphan_reconciliation_schedule_leases
 (organization_id, provider_account_id, provider_type, actor_id, schedule_slot,
  run_id, idempotency_key, workflow_id, lease_token, state, lease_until,
  created_at, started_at, completed_at, revision)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 1)`

const taskEquals = (left: OrphanScheduleTask, right: OrphanScheduleTask): boolean =>
  left.organizationId === right.organizationId &&
  left.providerAccountId === right.providerAccountId &&
  left.providerType === right.providerType &&
  left.actorId === right.actorId &&
  left.scheduleSlot === right.scheduleSlot &&
  left.runId === right.runId &&
  left.idempotencyKey === right.idempotencyKey &&
  left.workflowId === right.workflowId &&
  left.leaseToken === right.leaseToken

interface DecodedLease {
  readonly task: OrphanScheduleTask
  readonly state: 'pending' | 'running' | 'completed'
  readonly leaseUntil: string
  readonly revision: number
}

const decodeLease = (value: unknown): Effect.Effect<DecodedLease, OrphanScheduleError> => {
  const row = record(value)
  if (row === undefined)
    return Effect.fail(scheduleFailure('orphan.schedule.lease.decode', 'persistence-failed'))
  const state = text(row, 'state')
  const leaseUntil = text(row, 'leaseUntil')
  const revision = integer(row, 'revision')
  if (
    (state !== 'pending' && state !== 'running' && state !== 'completed') ||
    leaseUntil === undefined ||
    revision === undefined ||
    revision < 1
  )
    return Effect.fail(scheduleFailure('orphan.schedule.lease.decode', 'persistence-failed'))
  return decodeOrphanScheduleTask({
    organizationId: text(row, 'organizationId'),
    providerAccountId: text(row, 'providerAccountId'),
    providerType: text(row, 'providerType'),
    actorId: text(row, 'actorId'),
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
): Effect.Effect<A, OrphanScheduleError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => scheduleFailure(operation, 'persistence-failed'),
  })

const withinLease = (leaseUntil: string, now: string): boolean =>
  Number.isFinite(Date.parse(leaseUntil)) && Date.parse(leaseUntil) > Date.parse(now)

const taskFromLease = (
  lease: DecodedLease,
): Effect.Effect<OrphanScheduleTask, OrphanScheduleError> =>
  deriveOrphanScheduleTask({
    organizationId: lease.task.organizationId,
    providerAccountId: lease.task.providerAccountId,
    providerType: lease.task.providerType,
    actorId: lease.task.actorId,
    scheduleSlot: lease.task.scheduleSlot,
  }).pipe(
    Effect.flatMap((derived) =>
      taskEquals(derived, lease.task)
        ? Effect.succeed(derived)
        : Effect.fail(scheduleFailure('orphan.schedule.lease.binding', 'idempotency-conflict')),
    ),
  )

const taskBindings = (task: OrphanScheduleTask): ReadonlyArray<unknown> => [
  task.organizationId,
  task.providerAccountId,
  task.providerType,
  task.actorId,
  task.scheduleSlot,
  task.runId,
  task.idempotencyKey,
  task.workflowId,
  task.leaseToken,
]

const exactLease = (
  database: OrphanScheduleD1Database,
  task: OrphanScheduleTask,
): Effect.Effect<DecodedLease, OrphanScheduleError> =>
  d1('orphan.schedule.lease.read', () =>
    database
      .prepare(exactTaskSelect)
      .bind(task.organizationId, task.providerAccountId, task.scheduleSlot)
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.fail(scheduleFailure('orphan.schedule.lease.read', 'invalid-scope'))
        : decodeLease(row),
    ),
    Effect.flatMap((lease) =>
      taskEquals(lease.task, task)
        ? taskFromLease(lease).pipe(Effect.as(lease))
        : Effect.fail(scheduleFailure('orphan.schedule.lease.binding', 'idempotency-conflict')),
    ),
  )

export interface OrphanScheduleStore {
  /** Claim at most one bounded page of exact active allocation tuples. */
  readonly claimScheduledTasks: (
    scheduleSlot: unknown,
  ) => Effect.Effect<readonly OrphanScheduleTask[], OrphanScheduleError>
  /** Move a durable task to running before the Workflow is created or adopted. */
  readonly beginWorkflow: (
    task: unknown,
  ) => Effect.Effect<'started' | 'adopted', OrphanScheduleError>
  /** API-side fence immediately before opening a provider credential. */
  readonly assertExecutionLease: (task: unknown) => Effect.Effect<void, OrphanScheduleError>
  /** Mark the one D1-backed workflow task complete after read-only discovery persists. */
  readonly complete: (task: unknown) => Effect.Effect<'completed' | 'replayed', OrphanScheduleError>
}

export const makeOrphanScheduleStore = (
  database: OrphanScheduleD1Database,
  overrides: OrphanScheduleStoreOptions = {},
): OrphanScheduleStore => {
  const options = { ...defaults, ...overrides }
  const now = (): string => options.now().toISOString()
  const leaseUntil = (): string =>
    new Date(options.now().getTime() + options.leaseMilliseconds).toISOString()
  const pageSize = Math.max(1, Math.min(ORPHAN_SCHEDULE_PAGE_SIZE, Math.trunc(options.pageSize)))

  const validateSlot = (input: unknown) =>
    Schema.decodeUnknownEffect(IsoDateTime, { onExcessProperty: 'error' })(input).pipe(
      Effect.mapError(() => scheduleFailure('orphan.schedule.slot', 'invalid-task')),
    )

  const queryAllocationPage = (
    current: string,
    organizationId: string,
    providerAccountId: string,
  ) =>
    d1('orphan.schedule.allocations', () =>
      database
        .prepare(allocationPage)
        .bind(current, organizationId, organizationId, providerAccountId, pageSize)
        .all(),
    )

  const rowsToTasks = (rows: ReadonlyArray<unknown>, slot: string) =>
    Effect.forEach(rows, (row) => {
      const value = record(row)
      return value === undefined
        ? Effect.fail(scheduleFailure('orphan.schedule.allocations.decode', 'persistence-failed'))
        : deriveOrphanScheduleTask({
            organizationId: text(value, 'organizationId'),
            providerAccountId: text(value, 'providerAccountId'),
            providerType: text(value, 'providerType'),
            actorId: text(value, 'actorId'),
            scheduleSlot: slot,
          })
    })

  const recoverExpired = (current: string) =>
    d1('orphan.schedule.recover.select', () =>
      database.prepare(recoverableSelect).bind(current, pageSize).all(),
    ).pipe(
      Effect.flatMap((result) => Effect.forEach(result.results, decodeLease)),
      Effect.flatMap((leases) => Effect.forEach(leases, taskFromLease)),
      Effect.flatMap((tasks) =>
        tasks.length === 0
          ? Effect.succeed(tasks)
          : d1('orphan.schedule.recover.renew', () =>
              database.batch(
                tasks.map((task) =>
                  database
                    .prepare(`UPDATE orphan_reconciliation_schedule_leases
                      SET lease_until = ?, revision = revision + 1
                      WHERE organization_id = ? AND provider_account_id = ? AND schedule_slot = ?
                        AND provider_type = ? AND actor_id = ? AND run_id = ?
                        AND idempotency_key = ? AND workflow_id = ? AND lease_token = ?
                        AND state IN ('pending', 'running') AND julianday(lease_until) <= julianday(?)`)
                    .bind(
                      leaseUntil(),
                      task.organizationId,
                      task.providerAccountId,
                      task.scheduleSlot,
                      task.providerType,
                      task.actorId,
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
              Effect.flatMap((leases) => {
                if (leases.some((lease) => !withinLease(lease.leaseUntil, current)))
                  return Effect.fail(
                    scheduleFailure('orphan.schedule.recover.renew', 'lease-expired'),
                  )
                return Effect.succeed(tasks)
              }),
            ),
      ),
    )

  const claimScheduledTasks: OrphanScheduleStore['claimScheduledTasks'] = (scheduleSlot) =>
    Effect.gen(function* () {
      const slot = yield* validateSlot(scheduleSlot)
      const current = now()
      const recovered = yield* recoverExpired(current)
      if (recovered.length > 0) return recovered

      const cursor = yield* d1('orphan.schedule.cursor.read', () =>
        database.prepare(cursorSelect).first(),
      )
      const cursorRow = cursor === null ? undefined : record(cursor)
      const cursorOrganizationId =
        cursorRow === undefined ? '' : (text(cursorRow, 'organizationId') ?? '')
      const cursorProviderAccountId =
        cursorRow === undefined ? '' : (text(cursorRow, 'providerAccountId') ?? '')
      let page = yield* queryAllocationPage(current, cursorOrganizationId, cursorProviderAccountId)
      if (page.results.length === 0 && cursorOrganizationId.length > 0)
        page = yield* queryAllocationPage(current, '', '')
      if (page.results.length > pageSize)
        return yield* scheduleFailure('orphan.schedule.allocations.bound', 'persistence-failed')
      const tasks = yield* rowsToTasks(page.results, slot)
      if (tasks.length === 0) return tasks
      const last = tasks.at(-1)
      if (last === undefined)
        return yield* scheduleFailure('orphan.schedule.cursor.write', 'persistence-failed')
      const desiredLeaseUntil = leaseUntil()
      const persisted = yield* Effect.result(
        d1('orphan.schedule.tasks.insert', () =>
          database.batch([
            ...tasks.map((task) =>
              database.prepare(insertTask).bind(...taskBindings(task), desiredLeaseUntil, current),
            ),
            database
              .prepare(cursorUpsert)
              .bind(last.organizationId, last.providerAccountId, current),
          ]),
        ),
      )
      // D1 can commit before its response is lost. Exact rows, rather than a
      // repeated insert outcome, decide whether this delivery is adopted.
      if (persisted._tag === 'Failure') {
        const recoveredRows = yield* Effect.forEach(tasks, (task) => exactLease(database, task))
        if (recoveredRows.some((lease) => !withinLease(lease.leaseUntil, current)))
          return yield* persisted.failure
      }
      const exact = yield* Effect.forEach(tasks, (task) => exactLease(database, task))
      if (exact.some((lease) => !withinLease(lease.leaseUntil, current)))
        return yield* scheduleFailure('orphan.schedule.tasks.insert', 'lease-expired')
      return tasks
    })

  const decodeTask = (input: unknown) => decodeOrphanScheduleTask(input)

  const exactScopeLease = (task: OrphanScheduleTask) =>
    d1('orphan.schedule.scope', () =>
      database
        .prepare(exactScope)
        .bind(...taskBindings(task))
        .first(),
    ).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(scheduleFailure('orphan.schedule.scope', 'invalid-scope'))
          : Effect.succeed(value),
      ),
      Effect.flatMap((value) => {
        const row = record(value)
        const state = row === undefined ? undefined : text(row, 'state')
        const activeLeaseUntil = row === undefined ? undefined : text(row, 'leaseUntil')
        if (state === undefined || activeLeaseUntil === undefined)
          return Effect.fail(scheduleFailure('orphan.schedule.scope.decode', 'persistence-failed'))
        return Effect.succeed({ state, leaseUntil: activeLeaseUntil })
      }),
    )

  const beginWorkflow: OrphanScheduleStore['beginWorkflow'] = (input) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(input)
      const current = now()
      const lease = yield* exactLease(database, task)
      if (lease.state === 'completed')
        return yield* scheduleFailure('orphan.schedule.begin.completed', 'idempotency-conflict')
      if (!withinLease(lease.leaseUntil, current))
        return yield* scheduleFailure('orphan.schedule.begin.lease', 'lease-expired')
      const scope = yield* exactScopeLease(task)
      if (
        (scope.state !== 'pending' && scope.state !== 'running') ||
        !withinLease(scope.leaseUntil, current)
      )
        return yield* scheduleFailure('orphan.schedule.begin.scope', 'lease-expired')
      if (lease.state === 'running') return 'adopted' as const
      const moved = yield* Effect.result(
        d1('orphan.schedule.begin.update', () =>
          database.batch([
            database
              .prepare(`UPDATE orphan_reconciliation_schedule_leases
                SET state = 'running', started_at = COALESCE(started_at, ?), revision = revision + 1
                WHERE organization_id = ? AND provider_account_id = ? AND schedule_slot = ?
                  AND provider_type = ? AND actor_id = ? AND run_id = ?
                  AND idempotency_key = ? AND workflow_id = ? AND lease_token = ?
                  AND state = 'pending' AND julianday(lease_until) > julianday(?)`)
              .bind(
                current,
                task.organizationId,
                task.providerAccountId,
                task.scheduleSlot,
                task.providerType,
                task.actorId,
                task.runId,
                task.idempotencyKey,
                task.workflowId,
                task.leaseToken,
                current,
              ),
          ]),
        ),
      )
      if (moved._tag === 'Failure') {
        const adopted = yield* exactLease(database, task)
        if (adopted.state !== 'running' || !withinLease(adopted.leaseUntil, current))
          return yield* moved.failure
        return 'adopted' as const
      }
      const confirmed = yield* exactLease(database, task)
      if (confirmed.state !== 'running' || !withinLease(confirmed.leaseUntil, current))
        return yield* scheduleFailure('orphan.schedule.begin.confirm', 'lease-expired')
      return 'started' as const
    })

  const assertExecutionLease: OrphanScheduleStore['assertExecutionLease'] = (input) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(input)
      const current = now()
      const lease = yield* exactLease(database, task)
      if (lease.state !== 'running' || !withinLease(lease.leaseUntil, current))
        return yield* scheduleFailure('orphan.schedule.execute.lease', 'lease-expired')
      const scope = yield* exactScopeLease(task)
      if (scope.state !== 'running' || !withinLease(scope.leaseUntil, current))
        return yield* scheduleFailure('orphan.schedule.execute.scope', 'lease-expired')
    })

  const complete: OrphanScheduleStore['complete'] = (input) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(input)
      const current = now()
      const lease = yield* exactLease(database, task)
      if (lease.state === 'completed') return 'replayed' as const
      if (lease.state !== 'running' || !withinLease(lease.leaseUntil, current))
        return yield* scheduleFailure('orphan.schedule.complete.lease', 'lease-expired')
      yield* assertExecutionLease(task)
      const committed = yield* Effect.result(
        d1('orphan.schedule.complete.update', () =>
          database.batch([
            database
              .prepare(`UPDATE orphan_reconciliation_schedule_leases
                SET state = 'completed', completed_at = ?, revision = revision + 1
                WHERE organization_id = ? AND provider_account_id = ? AND schedule_slot = ?
                  AND provider_type = ? AND actor_id = ? AND run_id = ?
                  AND idempotency_key = ? AND workflow_id = ? AND lease_token = ?
                  AND state = 'running' AND julianday(lease_until) > julianday(?)`)
              .bind(
                current,
                task.organizationId,
                task.providerAccountId,
                task.scheduleSlot,
                task.providerType,
                task.actorId,
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
        return yield* scheduleFailure('orphan.schedule.complete.confirm', 'persistence-failed')
      return 'completed' as const
    })

  return { claimScheduledTasks, beginWorkflow, assertExecutionLease, complete }
}

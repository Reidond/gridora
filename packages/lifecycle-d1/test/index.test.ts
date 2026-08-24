import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalCommandFingerprint,
  type AtomicReserveInput,
  type LifecycleCommand,
} from '@gridora/lifecycle-control'
import {
  type LifecycleD1Database,
  type LifecycleD1Statement,
  makeLifecycleD1Repository,
  makeWorkflowStartReconciliationD1Repository,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrationFiles = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
] as const

class SqliteStatement implements LifecycleD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(
    readonly statement: StatementSync,
    readonly sql: string,
  ) {}
  bind(...values: ReadonlyArray<unknown>): LifecycleD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
  run(): void {
    this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
  }
}

class SqliteD1 implements LifecycleD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): LifecycleD1Statement {
    return new SqliteStatement(this.database.prepare(sql), sql)
  }
  async batch(statements: ReadonlyArray<LifecycleD1Statement>): Promise<ReadonlyArray<unknown>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) (statement as SqliteStatement).run()
      this.database.exec('COMMIT')
      return statements.map(() => ({}))
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

let database: DatabaseSync
let d1: SqliteD1
let nextOperation = 1

const seed = () => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?) `)
    .run('actor-a', 'access-a', 'actor-a@example.com', 'Actor A', 'now', 'now')
  for (const { id, slug } of [
    { id: 'org-a', slug: 'organization-a' },
    { id: 'org-b', slug: 'organization-b' },
  ])
    database
      .prepare(`INSERT INTO organizations
       (id, name, slug, status, timezone, default_region, onboarding_step,
        policy_revision, revision, created_at)
       VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'organization', 1, 1, 'now')`)
      .run(id, id, slug)
  database
    .prepare(`INSERT INTO game_plugins
     (id, version, api_version, status, capability_manifest_json, config_schema_version)
     VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
    .run()
  for (const organizationId of ['org-a', 'org-b'])
    database
      .prepare(`INSERT INTO game_servers
       (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
        placement_policy_json, desired_revision, observed_revision, active_config_revision,
        created_at, updated_at)
       VALUES (?, 'server-a', ?, 'arma-reforger', '1.0.0', 'stopped', 'stopped',
        '{}', 3, 3, 1, 'now', 'now')`)
      .run(organizationId, `${organizationId} Server`)
}

const command = (overrides: Partial<LifecycleCommand> = {}): LifecycleCommand =>
  ({
    kind: 'set-server-state',
    organizationId: 'org-a',
    actorId: 'actor-a',
    resourceId: 'server-a',
    idempotencyKey: 'request-a',
    expectedDesiredRevision: 3,
    correlationId: 'correlation-a',
    state: 'running',
    ...overrides,
  }) as LifecycleCommand

const reserveInput = (value: LifecycleCommand = command()): AtomicReserveInput => ({
  command: value,
  fingerprint: canonicalCommandFingerprint(value),
  reservation: {
    organizationId: value.organizationId,
    resourceKind: 'server',
    resourceId: value.resourceId,
    action: value.kind,
    previousRevision: value.expectedDesiredRevision,
    desiredRevision: value.expectedDesiredRevision + 1,
    desiredState: value.kind === 'set-server-state' ? value.state : 'stopped',
  },
})

const failureTag = async (effect: Effect.Effect<unknown, unknown>) => {
  const result = await Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null })),
  )
  return result !== null && typeof result === 'object' && '_tag' in result
    ? String(result._tag)
    : 'Success'
}

describe('D1 lifecycle repository', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    d1 = new SqliteD1(database)
    nextOperation = 1
    seed()
  })
  afterEach(() => database.close())

  const repository = () =>
    makeLifecycleD1Repository(d1, {
      now: () => '2026-08-23T12:00:00.000Z',
      operationId: () => `operation-${nextOperation++}`,
    })

  it('uses organization-only lookups and does not expose another tenant resource', async () => {
    const repo = repository()
    const own = await Effect.runPromise(repo.get('org-a', 'server-a'))
    expect(own.organizationId).toBe('org-a')
    expect(await failureTag(repo.get('org-c', 'server-a'))).toBe('ResourceNotFoundError')
  })

  it('atomically reserves desired state, queued operation, and pending Workflow start', async () => {
    const repo = repository()
    const result = await Effect.runPromise(repo.reserveAtomic(reserveInput()))
    expect(result.disposition).toBe('created')
    expect(result.operation).toMatchObject({
      id: 'operation-1',
      organizationId: 'org-a',
      actorId: 'actor-a',
      state: 'queued',
    })
    expect(result.workflowStart).toMatchObject({
      id: 'workflow-start:operation-1',
      state: 'pending',
      attempts: 0,
    })
    expect(
      database
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id
         FROM game_servers WHERE organization_id = 'org-a' AND id = 'server-a'`)
        .get(),
    ).toEqual({
      desired_state: 'running',
      desired_revision: 4,
      pending_lifecycle_operation_id: 'operation-1',
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM lifecycle_workflow_starts').get(),
    ).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 1 })
    const outbox = database.prepare('SELECT event_type, payload_json FROM outbox').get() as {
      event_type: string
      payload_json: string
    }
    expect(outbox.event_type).toBe('lifecycle.workflow-start.requested')
    expect(JSON.parse(outbox.payload_json)).toEqual({
      operationId: 'operation-1',
      workflowStartRecordId: 'workflow-start:operation-1',
      resourceKind: 'server',
      resourceId: 'server-a',
      action: 'set-server-state',
    })
  })

  it('returns the exact prior records for a same-fingerprint replay', async () => {
    const repo = repository()
    const input = reserveInput()
    const first = await Effect.runPromise(repo.reserveAtomic(input))
    await Effect.runPromise(
      repo.recordWorkflowStartFailure('org-a', first.operation.id, 'ambiguous_create'),
    )
    const replay = await Effect.runPromise(repo.reserveAtomic(input))
    expect(replay.disposition).toBe('adopted')
    expect(replay.operation).toEqual(first.operation)
    expect(replay.reservation).toEqual(first.reservation)
    expect(replay.workflowStart).toMatchObject({
      id: first.workflowStart.id,
      state: 'pending',
      attempts: 1,
      lastError: 'ambiguous_create',
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
  })

  it('rejects an idempotency key rebound to a changed fingerprint', async () => {
    const repo = repository()
    await Effect.runPromise(repo.reserveAtomic(reserveInput()))
    const changed = command({ state: 'stopped' } as Partial<LifecycleCommand>)
    expect(await failureTag(repo.reserveAtomic(reserveInput(changed)))).toBe(
      'IdempotencyConflictError',
    )
  })

  it('rolls back all writes when the desired revision fence loses a race', async () => {
    const repo = repository()
    database
      .prepare(`UPDATE game_servers SET desired_revision = 4
       WHERE organization_id = 'org-a' AND id = 'server-a'`)
      .run()
    expect(await failureTag(repo.reserveAtomic(reserveInput()))).toBe('RevisionConflictError')
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM lifecycle_reservations').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 })
    expect(
      database
        .prepare(`SELECT pending_lifecycle_operation_id FROM game_servers
         WHERE organization_id = 'org-a' AND id = 'server-a'`)
        .get(),
    ).toEqual({ pending_lifecycle_operation_id: null })
  })

  it('allows only one of two different idempotency keys racing at the same revision', async () => {
    const repo = repository()
    const first = reserveInput(command({ idempotencyKey: 'race-a' } as Partial<LifecycleCommand>))
    const second = reserveInput(
      command({
        idempotencyKey: 'race-b',
        correlationId: 'correlation-b',
      } as Partial<LifecycleCommand>),
    )
    const [left, right] = await Promise.all([
      Effect.runPromise(Effect.result(repo.reserveAtomic(first))),
      Effect.runPromise(Effect.result(repo.reserveAtomic(second))),
    ])
    const outcomes = [left, right]
    expect(outcomes.filter((result) => result._tag === 'Success')).toHaveLength(1)
    const failure = outcomes.find((result) => result._tag === 'Failure')
    expect(failure?._tag).toBe('Failure')
    if (failure?._tag === 'Failure') expect(failure.failure._tag).toBe('RevisionConflictError')
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 1 })
  })

  it('rolls back the resource update when another operation owns the idempotency key', async () => {
    database
      .prepare(`INSERT INTO operations
       (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
        idempotency_key, correlation_id, revision, created_at, updated_at)
       VALUES ('other-operation', 'org-a', 'other', 'server', 'server-a', 'actor-a',
        'queued', 0, 'request-a', 'other-correlation', 1, 'now', 'now')`)
      .run()
    const repo = repository()
    expect(await failureTag(repo.reserveAtomic(reserveInput()))).toBe('IdempotencyConflictError')
    expect(
      database
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id
         FROM game_servers WHERE organization_id = 'org-a' AND id = 'server-a'`)
        .get(),
    ).toEqual({
      desired_state: 'stopped',
      desired_revision: 3,
      pending_lifecycle_operation_id: null,
    })
  })

  it('updates Workflow-start state only inside the organization key', async () => {
    const repo = repository()
    const reserved = await Effect.runPromise(repo.reserveAtomic(reserveInput()))
    expect(await failureTag(repo.markWorkflowStarted('org-b', reserved.operation.id))).toBe(
      'PersistenceError',
    )
    expect(
      await failureTag(repo.recordWorkflowStartFailure('org-b', reserved.operation.id, 'x')),
    ).toBe('PersistenceError')
    expect(await failureTag(repo.markWorkflowStarted('org-a', 'missing-operation'))).toBe(
      'PersistenceError',
    )
    let replay = await Effect.runPromise(
      repo.findIdempotent('org-a', 'request-a', reserved.operation.fingerprint),
    )
    expect(replay?.workflowStart.state).toBe('pending')
    await Effect.runPromise(repo.markWorkflowStarted('org-a', reserved.operation.id))
    replay = await Effect.runPromise(
      repo.findIdempotent('org-a', 'request-a', reserved.operation.fingerprint),
    )
    expect(replay?.workflowStart).toMatchObject({ state: 'started', attempts: 1 })
  })

  it('rejects corrupted stored JSON invariants instead of adopting it', async () => {
    const repo = repository()
    const reserved = await Effect.runPromise(repo.reserveAtomic(reserveInput()))
    database
      .prepare(`UPDATE lifecycle_reservations SET reservation_json = '{}'
       WHERE organization_id = 'org-a' AND idempotency_key = 'request-a'`)
      .run()
    expect(
      await failureTag(repo.findIdempotent('org-a', 'request-a', reserved.operation.fingerprint)),
    ).toBe('PersistenceError')
  })

  it('serializes overlapping lifecycle reservations until the prior operation is terminal', async () => {
    const repo = repository()
    const first = await Effect.runPromise(repo.reserveAtomic(reserveInput()))
    const secondCommand = command({
      idempotencyKey: 'request-b',
      expectedDesiredRevision: 4,
      correlationId: 'correlation-b',
      state: 'stopped',
    } as Partial<LifecycleCommand>)
    const blocked = await Effect.runPromise(
      Effect.result(repo.reserveAtomic(reserveInput(secondCommand))),
    )
    expect(blocked._tag).toBe('Failure')
    if (blocked._tag === 'Failure') {
      expect(blocked.failure._tag).toBe('LifecycleOperationInProgressError')
      if (blocked.failure._tag === 'LifecycleOperationInProgressError')
        expect(blocked.failure).toMatchObject({ resourceId: 'server-a' })
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT desired_revision, pending_lifecycle_operation_id FROM game_servers
         WHERE organization_id = 'org-a' AND id = 'server-a'`)
        .get(),
    ).toEqual({ desired_revision: 4, pending_lifecycle_operation_id: first.operation.id })

    database
      .prepare(
        `UPDATE operations SET status = 'succeeded' WHERE organization_id = 'org-a' AND id = ?`,
      )
      .run(first.operation.id)
    const accepted = await Effect.runPromise(repo.reserveAtomic(reserveInput(secondCommand)))
    expect(accepted.disposition).toBe('created')
    expect(accepted.reservation.desiredRevision).toBe(5)
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 2 })
  })
})

describe('D1 Workflow-start reconciliation repository', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    d1 = new SqliteD1(database)
    nextOperation = 1
    seed()
  })
  afterEach(() => database.close())

  const arrange = async () => {
    const lifecycle = makeLifecycleD1Repository(d1, {
      now: () => '2026-08-23T12:00:00.000Z',
      operationId: () => `operation-${nextOperation++}`,
    })
    const reserved = await Effect.runPromise(lifecycle.reserveAtomic(reserveInput()))
    return {
      lifecycle,
      reconciliation: makeWorkflowStartReconciliationD1Repository(d1),
      reserved,
      request: {
        organizationId: reserved.operation.organizationId,
        operationId: reserved.operation.id,
        workflowStartRecordId: reserved.workflowStart.id,
      },
    }
  }

  it('loads an authoritative pending start reservation', async () => {
    const fixture = await arrange()
    const loaded = await Effect.runPromise(fixture.reconciliation.load(fixture.request))
    expect(loaded).toEqual({ ...fixture.reserved, disposition: 'adopted' })
    expect(loaded.workflowStart.state).toBe('pending')
  })

  it('returns the current already-started state', async () => {
    const fixture = await arrange()
    await Effect.runPromise(
      fixture.lifecycle.markWorkflowStarted('org-a', fixture.reserved.operation.id),
    )
    const loaded = await Effect.runPromise(fixture.reconciliation.load(fixture.request))
    expect(loaded.workflowStart).toMatchObject({ state: 'started', attempts: 1 })
  })

  it('returns non-disclosing not-found for a foreign organization', async () => {
    const fixture = await arrange()
    expect(
      await failureTag(
        fixture.reconciliation.load({ ...fixture.request, organizationId: 'org-b' }),
      ),
    ).toBe('WorkflowStartReconciliationNotFoundError')
  })

  it('returns a generic mismatch for a wrong start-record identifier', async () => {
    const fixture = await arrange()
    const result = await Effect.runPromise(
      Effect.result(
        fixture.reconciliation.load({
          ...fixture.request,
          workflowStartRecordId: 'workflow-start:wrong',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(result.failure).toMatchObject({
        _tag: 'WorkflowStartReconciliationMismatchError',
        code: 'binding_mismatch',
      })
  })

  it('returns a generic mismatch for corrupted authoritative metadata', async () => {
    const fixture = await arrange()
    database
      .prepare(`UPDATE lifecycle_reservations SET command_json = '{}'
       WHERE organization_id = 'org-a' AND operation_id = ?`)
      .run(fixture.reserved.operation.id)
    expect(await failureTag(fixture.reconciliation.load(fixture.request))).toBe(
      'WorkflowStartReconciliationMismatchError',
    )
  })

  it('is read-idempotent for duplicate queue delivery', async () => {
    const fixture = await arrange()
    const first = await Effect.runPromise(fixture.reconciliation.load(fixture.request))
    const duplicate = await Effect.runPromise(fixture.reconciliation.load(fixture.request))
    expect(duplicate).toEqual(first)
    expect(duplicate.workflowStart).toMatchObject({ state: 'pending', attempts: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 1 })
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type LifecycleTerminationD1Database,
  type LifecycleTerminationD1Result,
  type LifecycleTerminationD1Statement,
  makeWorkflowStepD1Repository,
} from '../src/index.js'

const migrationDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = readdirSync(migrationDirectory)
  .filter((file) => /^00(?:0[1-9]|1[0-9])_.*\.sql$/.test(file))
  .sort()
const organizationId = 'org-a'
const operationId = 'operation-a'
const now = '2026-08-23T12:00:00.000Z'
const initialLease = {
  claimId: 'initial-claim-identity-0001',
  attempt: 1,
  expiresAt: '2026-08-23T12:05:00.000Z',
} as const
const retryLease = {
  claimId: 'retry-claim-identity-0002',
  attempt: 2,
  expiresAt: '2026-08-23T12:11:00.000Z',
} as const
const receipt = {
  effectId: 'ovh-delete-operation-identity-0001',
  outcomeFingerprint: 'a'.repeat(64),
} as const

class SqliteStatement implements LifecycleTerminationD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): LifecycleTerminationD1Statement {
    this.values = values
    return this
  }
  async first<T = unknown>(): Promise<T | null> {
    return (
      (this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) as T | undefined) ??
      null
    )
  }
  async all<T = unknown>(): Promise<{ readonly results: ReadonlyArray<T> }> {
    return {
      results: this.statement.all(
        ...(this.values as ReadonlyArray<SQLInputValue>),
      ) as unknown as ReadonlyArray<T>,
    }
  }
  run(): void {
    this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
  }
}

class SqliteD1 implements LifecycleTerminationD1Database {
  throwAfterCommit = false
  beforeNextBatch: (() => void) | undefined
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): LifecycleTerminationD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<LifecycleTerminationD1Statement>,
  ): Promise<ReadonlyArray<LifecycleTerminationD1Result>> {
    const before = this.beforeNextBatch
    this.beforeNextBatch = undefined
    before?.()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: LifecycleTerminationD1Result[] = []
      for (const statement of statements) {
        ;(statement as SqliteStatement).run()
        const changes = this.database.prepare('SELECT changes() AS changes').get() as {
          changes: number
        }
        results.push({ success: true, meta: { changes: changes.changes } })
      }
      this.database.exec('COMMIT')
      if (this.throwAfterCommit) {
        this.throwAfterCommit = false
        throw new Error('response lost after committed batch')
      }
      return results
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // A committed response-loss simulation has no open transaction to roll back.
      }
      throw error
    }
  }
}

let database: DatabaseSync
let d1: SqliteD1

const seed = () => {
  database
    .prepare(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('actor-a', 'access-a', 'actor-a@example.com', 'Actor A', 'active', ?, ?)`)
    .run(now, now)
  database
    .prepare(`INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES (?, 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`)
    .run(organizationId, now)
  database
    .prepare(`INSERT INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, revision)
    VALUES (?, 'actor-a', 'owner', 'active', ?, 1)`)
    .run(organizationId, now)
  database
    .prepare(`INSERT INTO operations
    (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
     idempotency_key, correlation_id, revision, created_at, updated_at)
    VALUES (?, ?, 'retire-node', 'node', 'node-a', 'actor-a', 'queued', 0,
      'operation-idempotency-a', 'correlation-a', 1, ?, ?)`)
    .run(operationId, organizationId, now, now)
  database
    .prepare(`INSERT INTO operation_cancellation_facts
    (organization_id, operation_id, resource_type, resource_id, resource_operation_do_name,
     workflow_binding, workflow_type, workflow_instance_id, cancellation_policy, phase,
     active_step_ordinal, active_step_name, revision, registered_at, updated_at)
    VALUES (?, ?, 'node', 'node-a', 'resource-operation:org-a:node:node-a',
      'RETIRE_NODE', 'RetireNodeWorkflow', ?, 'before-destructive-step',
      'before-destructive-step', NULL, NULL, 1, ?, ?)`)
    .run(organizationId, operationId, operationId, now, now)
}

const claim = (
  claimId: string = initialLease.claimId,
  leaseExpiresAt: string = initialLease.expiresAt,
  current: string = now,
) =>
  makeWorkflowStepD1Repository(d1).claimStep({
    organizationId,
    operationId,
    workflowType: 'RetireNodeWorkflow',
    workflowInstanceId: operationId,
    stepName: 'retire-provider-node',
    ordinal: 3,
    destructive: true,
    claimId,
    leaseExpiresAt,
    now: current,
  })

describe('D1 workflow step leases and effect adoption', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${migrationDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
  })
  afterEach(() => database.close())

  it('adopts committed side-effect evidence after a D1 response loss and completes without another claim', async () => {
    const repository = makeWorkflowStepD1Repository(d1)
    const claimed = await Effect.runPromise(claim())
    expect(claimed).toMatchObject({ disposition: 'execute', lease: initialLease })
    d1.throwAfterCommit = true
    const recorded = await Effect.runPromise(
      repository.recordStepEffectReceipt({
        organizationId,
        operationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        lease: initialLease,
        receipt,
        now,
      }),
    )
    expect(recorded).toEqual(receipt)
    const adopted = await Effect.runPromise(
      claim('unrelated-retry-claim-0003', '2026-08-23T12:06:00.000Z', '2026-08-23T12:05:01.000Z'),
    )
    expect(adopted).toMatchObject({
      disposition: 'effect-adopted',
      lease: initialLease,
      effectReceipt: receipt,
    })
    await Effect.runPromise(
      repository.completeStep({
        organizationId,
        operationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        lease: initialLease,
        now: '2026-08-23T12:05:02.000Z',
      }),
    )
    expect(
      database
        .prepare(`SELECT state, claim_attempt AS attempt FROM operation_cancellation_step_receipts`)
        .get(),
    ).toEqual({ state: 'completed', attempt: 1 })
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM operation_cancellation_step_effect_receipts`)
        .get(),
    ).toEqual({ count: 1 })
  })

  it('reclaims an expired lease only after exact non-application evidence, and keeps ambiguous truth non-executable', async () => {
    const repository = makeWorkflowStepD1Repository(d1)
    await Effect.runPromise(claim())
    const expiredAt = '2026-08-23T12:05:01.000Z'
    const ambiguous = await Effect.runPromise(
      repository.resolveExpiredStepClaim({
        organizationId,
        operationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        destructive: true,
        previousLease: initialLease,
        observation: { state: 'unknown' },
        nextClaimId: retryLease.claimId,
        nextLeaseExpiresAt: retryLease.expiresAt,
        now: expiredAt,
      }),
    )
    expect(ambiguous).toMatchObject({ disposition: 'reconciliation-required', lease: initialLease })
    const reclaimed = await Effect.runPromise(
      repository.resolveExpiredStepClaim({
        organizationId,
        operationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        destructive: true,
        previousLease: initialLease,
        observation: { state: 'not-applied' },
        nextClaimId: retryLease.claimId,
        nextLeaseExpiresAt: retryLease.expiresAt,
        now: expiredAt,
      }),
    )
    expect(reclaimed).toMatchObject({ disposition: 'execute', lease: retryLease })
    expect(
      database
        .prepare(
          `SELECT claim_id AS claimId, claim_attempt AS attempt FROM operation_cancellation_step_receipts`,
        )
        .get(),
    ).toEqual({ claimId: retryLease.claimId, attempt: 2 })
  })

  it('rolls back completion when a facts revision changes after the pre-read barrier', async () => {
    const repository = makeWorkflowStepD1Repository(d1)
    await Effect.runPromise(claim())
    await Effect.runPromise(
      repository.recordStepEffectReceipt({
        organizationId,
        operationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        lease: initialLease,
        receipt,
        now,
      }),
    )
    // This hook models a committed competing transition after completeStep has loaded its
    // context but before its SQL batch starts. The final completion receipt must turn the
    // resulting zero-change facts update into a full rollback, not a completed step.
    d1.beforeNextBatch = () => {
      database
        .prepare(`UPDATE operation_cancellation_facts
          SET revision = revision + 1, updated_at = '2026-08-23T12:00:01.000Z'
          WHERE organization_id = ? AND operation_id = ?`)
        .run(organizationId, operationId)
    }
    const exit = await Effect.runPromiseExit(
      repository.completeStep({
        organizationId,
        operationId,
        stepName: 'retire-provider-node',
        ordinal: 3,
        lease: initialLease,
        now: '2026-08-23T12:00:02.000Z',
      }),
    )
    expect(exit._tag).toBe('Failure')
    expect(
      database
        .prepare(
          `SELECT state, lease_expires_at AS leaseExpiresAt FROM operation_cancellation_step_receipts`,
        )
        .get(),
    ).toEqual({ state: 'running', leaseExpiresAt: initialLease.expiresAt })
    expect(
      database
        .prepare(
          `SELECT revision, active_step_name AS activeStepName FROM operation_cancellation_facts`,
        )
        .get(),
    ).toEqual({ revision: 3, activeStepName: 'retire-provider-node' })
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM operation_cancellation_step_completion_receipts`)
        .get(),
    ).toEqual({ count: 0 })
  })
})

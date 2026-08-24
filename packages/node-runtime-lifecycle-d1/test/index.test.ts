import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeNodeRuntimeLifecycleExecution } from '@gridora/node-runtime-lifecycle-execution'
import {
  transitionFor,
  type NodeRuntimeLifecycleAction,
  type NodeRuntimeLifecycleAtomicInput,
} from '@gridora/node-runtime-lifecycle-control'
import {
  makeNodeRuntimeLifecycleExecutionRepositoryD1,
  makeNodeRuntimeLifecycleRepositoryD1,
  type NodeRuntimeLifecycleD1Database,
  type NodeRuntimeLifecycleD1Result,
  type NodeRuntimeLifecycleD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
// Runtime endpoint authority is introduced after the strict-audit migrations.
// Apply the complete catalog so this test exercises the same endpoint and
// provenance fences that production D1 receives, rather than a historical
// subset that cannot reveal a torn or stale DNS target.
const migrationFiles = readdirSync(sqlDirectory)
  .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
  .sort()

class SqliteStatement implements NodeRuntimeLifecycleD1Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly values: ReadonlyArray<SQLInputValue> = [],
  ) {}

  bind(...values: ReadonlyArray<unknown>): NodeRuntimeLifecycleD1Statement {
    return new SqliteStatement(this.sqlite, this.sql, values as ReadonlyArray<SQLInputValue>)
  }

  async first(): Promise<unknown> {
    return this.sqlite.prepare(this.sql).get(...this.values) ?? null
  }

  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.values) }
  }

  run(): NodeRuntimeLifecycleD1Result {
    const result = this.sqlite.prepare(this.sql).run(...this.values)
    return { meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 implements NodeRuntimeLifecycleD1Database {
  beforeBatch: (() => void) | undefined
  loseBatchResponse = false

  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): NodeRuntimeLifecycleD1Statement {
    return new SqliteStatement(this.sqlite, sql)
  }

  async batch(
    statements: ReadonlyArray<NodeRuntimeLifecycleD1Statement>,
  ): Promise<ReadonlyArray<NodeRuntimeLifecycleD1Result>> {
    const hook = this.beforeBatch
    this.beforeBatch = undefined
    hook?.()
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement)) throw new Error('unexpected D1 statement')
        return statement.run()
      })
      this.sqlite.exec('COMMIT')
      if (this.loseBatchResponse) {
        this.loseBatchResponse = false
        throw new Error('injected response loss after commit')
      }
      return results
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

const acceptedAt = '2026-08-23T12:00:00.000Z'
const leaseExpiresAt = '2026-08-23T12:01:00.000Z'
const recoveryAt = '2026-08-23T12:02:00.000Z'
const recoveryLeaseExpiresAt = '2026-08-23T12:03:00.000Z'

let sqlite: DatabaseSync
let d1: SqliteD1

const count = (table: string): number =>
  Number(
    (sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
  )

const seedTenant = (input: {
  readonly organizationId: 'org-a' | 'org-b'
  readonly actorId: 'actor-a' | 'actor-b'
  readonly accountId: 'account-a' | 'account-b'
  readonly envelopeId: 'envelope-a' | 'envelope-b'
  readonly nodeId: 'node-a' | 'node-b'
  readonly instanceId: 'instance-a' | 'instance-b'
}) => {
  sqlite
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(
      input.actorId,
      `access-${input.actorId}`,
      `${input.actorId}@example.test`,
      input.actorId,
      acceptedAt,
      acceptedAt,
    )
  sqlite
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'region-a', 'complete', 1, 1, ?)`)
    .run(input.organizationId, input.organizationId, `${input.organizationId}-slug`, acceptedAt)
  sqlite
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES (?, ?, 'owner', 'active', ?, NULL, ?)`)
    .run(input.organizationId, input.actorId, acceptedAt, input.organizationId === 'org-a' ? 7 : 3)
  sqlite
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision,
       created_at, updated_at)
      VALUES (?, 'organization', ?, 'ovhcloud', ?, 'active', 3, ?, ?)`)
    .run(input.accountId, input.organizationId, input.envelopeId, acceptedAt, acceptedAt)
  sqlite
    .prepare(`INSERT INTO secret_envelopes
      (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
       key_version, revision, created_at, rotated_at)
      VALUES (?, ?, 'provider-account', ?, ?, ?, 1, 7, ?, NULL)`)
    .run(
      input.organizationId,
      input.envelopeId,
      input.accountId,
      `ciphertext-${input.accountId}-must-not-leak`,
      `wrapped-${input.accountId}-must-not-leak`,
      acceptedAt,
    )
  sqlite
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, monthly_budget_minor, status, revision)
      VALUES (?, ?, '["region-a"]', '["plan-a"]', 8, 100000, 'active', 5)`)
    .run(input.organizationId, input.accountId)
  sqlite
    .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
       plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
       observed_revision, reconciliation_error, last_reconciled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ovhcloud', 'region-a', 'plan-a', 'image-a', 'shared',
       'stopped', 'offline', 7, 4, NULL, ?, ?, ?)`)
    .run(
      input.organizationId,
      input.nodeId,
      input.accountId,
      input.instanceId,
      acceptedAt,
      acceptedAt,
      acceptedAt,
    )
}

const seed = () => {
  sqlite
    .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-a', '2026.08.23', ?, 'signature-a', ?, 'promoted', ?, ?)`)
    .run(
      `sha256:${'a'.repeat(64)}`,
      JSON.stringify({ ovhcloud: { 'region-a': 'provider-image-a' } }),
      acceptedAt,
      acceptedAt,
    )
  seedTenant({
    organizationId: 'org-a',
    actorId: 'actor-a',
    accountId: 'account-a',
    envelopeId: 'envelope-a',
    nodeId: 'node-a',
    instanceId: 'instance-a',
  })
  seedTenant({
    organizationId: 'org-b',
    actorId: 'actor-b',
    accountId: 'account-b',
    envelopeId: 'envelope-b',
    nodeId: 'node-b',
    instanceId: 'instance-b',
  })
}

const controlRepository = () => makeNodeRuntimeLifecycleRepositoryD1(d1)
const executionRepository = () => makeNodeRuntimeLifecycleExecutionRepositoryD1(d1)

const makeInput = async (
  input: {
    readonly action?: NodeRuntimeLifecycleAction
    readonly operationId?: string
    readonly idempotencyKey?: string
    readonly organizationId?: 'org-a' | 'org-b'
    readonly actorId?: 'actor-a' | 'actor-b'
    readonly actorMembershipRevision?: number
    readonly fingerprintCharacter?: 'a' | 'b'
  } = {},
): Promise<NodeRuntimeLifecycleAtomicInput> => {
  const action = input.action ?? 'start'
  const organizationId = input.organizationId ?? 'org-a'
  const actorId = input.actorId ?? (organizationId === 'org-a' ? 'actor-a' : 'actor-b')
  const nodeId = organizationId === 'org-a' ? 'node-a' : 'node-b'
  const node = await Effect.runPromise(controlRepository().getNode(organizationId, nodeId))
  const transition = await Effect.runPromise(
    transitionFor(node, {
      schemaVersion: 1,
      action,
      expectedDesiredRevision: node.desiredRevision,
    }),
  )
  const operationId = input.operationId ?? `operation-runtime-${action}`
  return {
    command: {
      organizationId,
      actorId,
      actorRole: 'owner',
      actorMembershipRevision:
        input.actorMembershipRevision ?? (organizationId === 'org-a' ? 7 : 3),
      nodeId,
      idempotencyKey: input.idempotencyKey ?? `runtime-${action}-request`,
      correlationId: `correlation-${operationId}`,
      intent: {
        schemaVersion: 1,
        action,
        expectedDesiredRevision: node.desiredRevision,
      },
    },
    node,
    transition,
    identity: {
      operationId,
      auditOperationId: `audit-operation-${operationId}`,
      workflowStartRecordId: `workflow-start:${operationId}`,
      auditEventId: `audit:${operationId}`,
      outboxEventId: `outbox:${operationId}`,
    },
    fingerprint: (input.fingerprintCharacter ?? 'a').repeat(64),
    now: acceptedAt,
  }
}

const accept = async (input: NodeRuntimeLifecycleAtomicInput) =>
  Effect.runPromise(controlRepository().acceptAtomic(input))

const claimDispatch = async (input: NodeRuntimeLifecycleAtomicInput) => {
  const claim = await Effect.runPromise(
    executionRepository().claim({
      organizationId: input.command.organizationId,
      operationId: input.identity.operationId,
      owner: 'worker-a',
      token: 'lease-token-a',
      leaseExpiresAt,
      now: acceptedAt,
    }),
  )
  if (claim.disposition !== 'dispatch')
    throw new Error(`expected dispatch, received ${claim.disposition}`)
  return claim
}

const markRequested = async (claim: Awaited<ReturnType<typeof claimDispatch>>) =>
  Effect.runPromise(
    executionRepository().markActionRequested({
      reservation: claim.reservation,
      lease: claim.lease,
      requestedAt: acceptedAt,
    }),
  )

const failureTag = async (effect: Effect.Effect<unknown, unknown>) => {
  const result = await Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null })),
  )
  return result !== null && typeof result === 'object' && '_tag' in result
    ? String(result._tag)
    : 'Success'
}

const makeReady = () =>
  sqlite
    .prepare(`UPDATE nodes SET desired_state = 'ready', observed_state = 'ready', desired_revision = 7,
      observed_revision = 4, reconciliation_error = NULL, pending_lifecycle_operation_id = NULL
      WHERE organization_id = 'org-a' AND id = 'node-a'`)
    .run()

describe('node runtime lifecycle D1 repositories', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    for (const migration of migrationFiles)
      sqlite.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(sqlite)
    seed()
  })

  afterEach(() => sqlite.close())

  it('accepts an exact account-bound start intent atomically without putting credential material in response evidence', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-accept' })
    const result = await accept(input)

    expect(result).toMatchObject({
      disposition: 'created',
      organizationId: 'org-a',
      nodeId: 'node-a',
      operationId: 'operation-runtime-accept',
      action: 'start',
    })
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id
          FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'ready',
      desired_revision: 8,
      pending_lifecycle_operation_id: 'operation-runtime-accept',
    })
    // The queued provider operation and the terminal acceptance fact are
    // deliberately separate so a succeeded v1 audit never points at queued work.
    expect(count('operations')).toBe(2)
    expect(
      sqlite
        .prepare(`SELECT type, status, progress FROM operations WHERE id = ?`)
        .get('audit-operation-operation-runtime-accept'),
    ).toEqual({ type: 'node.runtime.start.accepted', status: 'succeeded', progress: 100 })
    expect(count('node_runtime_lifecycle_workflow_starts')).toBe(1)
    expect(count('node_runtime_lifecycle_executions')).toBe(1)
    expect(count('node_runtime_lifecycle_intents')).toBe(1)
    expect(count('audit_events')).toBe(1)
    expect(count('audit_event_envelopes')).toBe(1)
    expect(
      sqlite
        .prepare(`SELECT schema_version, capture_status,
          json_extract(envelope_json, '$.operationId') AS operationId,
          json_extract(envelope_json, '$.action') AS action
          FROM audit_event_envelopes`)
        .get(),
    ).toEqual({
      schema_version: 1,
      capture_status: 'complete',
      operationId: 'audit-operation-operation-runtime-accept',
      action: 'node.runtime.start.accepted',
    })
    // The acceptance outbox event plus the audit-export trigger event are both expected.
    expect(count('outbox')).toBe(2)
    expect(
      sqlite
        .prepare(`SELECT provider_account_id, provider_account_revision, provider_allocation_revision,
          provider_credential_reference, provider_credential_revision
          FROM node_runtime_lifecycle_executions`)
        .get(),
    ).toEqual({
      provider_account_id: 'account-a',
      provider_account_revision: 3,
      provider_allocation_revision: 5,
      provider_credential_reference: 'envelope-a',
      provider_credential_revision: 7,
    })
    const publicEvidence = JSON.stringify({
      result,
      intent: sqlite.prepare(`SELECT response_json FROM node_runtime_lifecycle_intents`).get(),
      audit: sqlite.prepare(`SELECT summary_json FROM audit_events`).get(),
      outbox: sqlite.prepare(`SELECT payload_json FROM outbox`).get(),
    })
    expect(publicEvidence).not.toContain('envelope-a')
    expect(publicEvidence).not.toContain('ciphertext-account-a-must-not-leak')
    expect(publicEvidence).not.toContain('wrapped-account-a-must-not-leak')
  })

  it('adopts a committed acceptance after a lost D1 response and rejects a changed idempotency payload', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-response-loss' })
    d1.loseBatchResponse = true
    const first = await accept(input)
    const replay = await Effect.runPromise(
      controlRepository().findReplay({
        organizationId: 'org-a',
        idempotencyKey: input.command.idempotencyKey,
        fingerprint: input.fingerprint,
      }),
    )
    const repeated = await accept(input)

    expect(replay).toEqual(first)
    expect(repeated).toEqual(first)
    expect(count('operations')).toBe(2)
    expect(count('node_runtime_lifecycle_intents')).toBe(1)
    expect(
      await failureTag(
        controlRepository().findReplay({
          organizationId: 'org-a',
          idempotencyKey: input.command.idempotencyKey,
          fingerprint: 'b'.repeat(64),
        }),
      ),
    ).toBe('NodeRuntimeLifecycleConflictError')
  })

  it('does not disclose a forged tenant node and rolls back stale revisions', async () => {
    expect(await failureTag(controlRepository().getNode('org-b', 'node-a'))).toBe(
      'NodeRuntimeLifecycleNotFoundError',
    )

    const own = await makeInput({ operationId: 'operation-runtime-forged' })
    const forged: NodeRuntimeLifecycleAtomicInput = {
      ...own,
      command: {
        ...own.command,
        organizationId: 'org-b',
        actorId: 'actor-b',
        actorMembershipRevision: 3,
      },
      node: { ...own.node, organizationId: 'org-b' },
    }
    expect(await failureTag(controlRepository().acceptAtomic(forged))).toBe(
      'NodeRuntimeLifecycleNotFoundError',
    )
    expect(count('operations')).toBe(0)
    expect(
      sqlite
        .prepare(`SELECT desired_revision, pending_lifecycle_operation_id FROM nodes
          WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({ desired_revision: 7, pending_lifecycle_operation_id: null })

    const stale: NodeRuntimeLifecycleAtomicInput = {
      ...own,
      transition: {
        ...own.transition,
        previousDesiredRevision: 6,
        desiredRevision: 7,
      },
    }
    expect(await failureTag(controlRepository().acceptAtomic(stale))).toBe(
      'NodeRuntimeLifecycleConflictError',
    )
    expect(count('operations')).toBe(0)
    expect(count('node_runtime_lifecycle_intents')).toBe(0)
  })

  it('rechecks active Owner/Admin/Operator membership at the atomic mutation fence', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-demoted' })
    d1.beforeBatch = () => {
      sqlite
        .prepare(`UPDATE organization_memberships SET role = 'viewer', revision = 8
          WHERE organization_id = 'org-a' AND identity_id = 'actor-a'`)
        .run()
    }

    expect(await failureTag(controlRepository().acceptAtomic(input))).toBe(
      'NodeRuntimeLifecycleAuthorizationError',
    )
    expect(count('operations')).toBe(0)
    expect(count('node_runtime_lifecycle_intents')).toBe(0)
  })

  it('fails closed when the exact account binding is disabled after an execution pre-read', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-binding-change' })
    await accept(input)
    d1.beforeBatch = () => {
      sqlite
        .prepare(`UPDATE provider_accounts SET status = 'disabled', revision = 4
          WHERE id = 'account-a'`)
        .run()
    }

    expect(
      await failureTag(
        executionRepository().claim({
          organizationId: 'org-a',
          operationId: input.identity.operationId,
          owner: 'worker-a',
          token: 'lease-token-a',
          leaseExpiresAt,
          now: acceptedAt,
        }),
      ),
    ).toBe('NodeRuntimeLifecycleExecutionConflictError')
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id
          FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'ready',
      desired_revision: 8,
      pending_lifecycle_operation_id: input.identity.operationId,
    })
    expect(
      sqlite.prepare(`SELECT state, attempt FROM node_runtime_lifecycle_executions`).get(),
    ).toEqual({ state: 'pending', attempt: 0 })
  })

  it.each([
    {
      name: 'allocation',
      change: () =>
        sqlite
          .prepare(`UPDATE provider_allocations SET status = 'disabled', revision = 6
            WHERE organization_id = 'org-a' AND provider_account_id = 'account-a'`)
          .run(),
    },
    {
      name: 'credential envelope revision',
      change: () =>
        sqlite
          .prepare(`UPDATE secret_envelopes SET revision = 8
            WHERE organization_id = 'org-a' AND id = 'envelope-a'`)
          .run(),
    },
  ])(
    'fails closed when the exact $name changes after an execution pre-read',
    async ({ change }) => {
      const input = await makeInput({ operationId: 'operation-runtime-binding-coordinate-change' })
      await accept(input)
      d1.beforeBatch = change

      expect(
        await failureTag(
          executionRepository().claim({
            organizationId: 'org-a',
            operationId: input.identity.operationId,
            owner: 'worker-a',
            token: 'lease-token-a',
            leaseExpiresAt,
            now: acceptedAt,
          }),
        ),
      ).toBe('NodeRuntimeLifecycleExecutionConflictError')
      expect(
        sqlite.prepare(`SELECT state, attempt FROM node_runtime_lifecycle_executions`).get(),
      ).toEqual({
        state: 'pending',
        attempt: 0,
      })
    },
  )

  it('prevents allocation rotation while an exact action lease is active', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-active-allocation-fence' })
    await accept(input)
    const claim = await claimDispatch(input)
    expect(() =>
      sqlite
        .prepare(`UPDATE provider_allocations SET revision = 6
          WHERE organization_id = 'org-a' AND provider_account_id = 'account-a'`)
        .run(),
    ).toThrow('provider allocation has active node runtime execution')
    // The original lease still owns the exact allocation revision and can safely make its mark.
    await expect(markRequested(claim)).resolves.toBe('marked')
  })

  it('reclaims an expired lease without a dispatch mark for one safe provider dispatch', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-crash-before-mark' })
    await accept(input)
    await claimDispatch(input)
    // The first worker crashed before `markActionRequested`; no dispatch-mark receipt exists.
    const recovered = await Effect.runPromise(
      executionRepository().claim({
        organizationId: 'org-a',
        operationId: input.identity.operationId,
        owner: 'worker-b',
        token: 'lease-token-b',
        leaseExpiresAt: recoveryLeaseExpiresAt,
        now: recoveryAt,
      }),
    )
    expect(recovered.disposition).toBe('dispatch')
    if (recovered.disposition !== 'dispatch') throw new Error('expected safe dispatch recovery')
    expect(recovered.recovery).toBe('lease-expired-before-mark')
    expect(count('node_runtime_lifecycle_dispatch_marks')).toBe(0)
  })

  it('retries one provider call after a lost claim response, before any dispatch mark exists', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-claim-response-loss' })
    await accept(input)
    let lease = 0
    let providerDispatches = 0
    const worker = makeNodeRuntimeLifecycleExecution({
      repository: executionRepository(),
      transport: {
        assertSupported: () => Effect.void,
        dispatchAndObserve: () => {
          providerDispatches += 1
          return Effect.succeed({
            providerState: 'active' as const,
            rebootConfirmed: false,
            actionNotApplied: false,
            observedAt: recoveryAt,
          })
        },
        observe: () =>
          Effect.succeed({
            providerState: 'unknown' as const,
            rebootConfirmed: false,
            actionNotApplied: false,
            observedAt: recoveryAt,
          }),
      },
      leaseTokens: { next: () => `lease-token-service-${++lease}` },
      leaseDurationMilliseconds: 30_000,
    })
    d1.loseBatchResponse = true
    expect(
      await failureTag(
        worker.execute({
          organizationId: 'org-a',
          operationId: input.identity.operationId,
          leaseOwner: 'worker-service',
          attemptedAt: acceptedAt,
        }),
      ),
    ).toBe('NodeRuntimeLifecycleExecutionPersistenceError')
    expect(providerDispatches).toBe(0)

    const retried = await Effect.runPromise(
      worker.execute({
        organizationId: 'org-a',
        operationId: input.identity.operationId,
        leaseOwner: 'worker-service',
        attemptedAt: recoveryAt,
      }),
    )
    expect(retried).toMatchObject({ disposition: 'executed' })
    expect(providerDispatches).toBe(1)
    expect(count('node_runtime_lifecycle_dispatch_marks')).toBe(1)
  })

  it('keeps desired state pending when an accepted provider action has an uncertain post-dispatch observation', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-post-dispatch-unknown' })
    await accept(input)
    let providerDispatches = 0
    const worker = makeNodeRuntimeLifecycleExecution({
      repository: executionRepository(),
      // The provider transport test proves that a successful dispatch followed by an
      // authorization-failed observation maps to this exact unknown observation.
      transport: {
        assertSupported: () => Effect.void,
        dispatchAndObserve: () => {
          providerDispatches += 1
          return Effect.succeed({
            providerState: 'unknown' as const,
            rebootConfirmed: false,
            actionNotApplied: false,
            observedAt: acceptedAt,
          })
        },
        observe: () =>
          Effect.succeed({
            providerState: 'unknown' as const,
            rebootConfirmed: false,
            actionNotApplied: false,
            observedAt: acceptedAt,
          }),
      },
      leaseTokens: { next: () => 'lease-token-post-dispatch-unknown' },
    })
    const outcome = await Effect.runPromise(
      worker.execute({
        organizationId: 'org-a',
        operationId: input.identity.operationId,
        leaseOwner: 'worker-service',
        attemptedAt: acceptedAt,
      }),
    )
    expect(outcome).toMatchObject({
      disposition: 'executed',
      result: { state: 'waiting-observation', operationStatus: 'waiting_external' },
    })
    expect(providerDispatches).toBe(1)
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id,
          reconciliation_error FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'ready',
      desired_revision: 8,
      pending_lifecycle_operation_id: input.identity.operationId,
      reconciliation_error: 'provider_unknown_not_converged',
    })
    expect(sqlite.prepare(`SELECT state FROM node_runtime_lifecycle_executions`).get()).toEqual({
      state: 'waiting-observation',
    })
  })

  it('atomically replaces stale player endpoint authority after a proven ready reconciliation', async () => {
    makeReady()
    sqlite
      .prepare(`INSERT INTO node_player_endpoints
        (organization_id, node_id, provider_instance_id, record_type, target, source,
         observed_revision, revision, observed_at, created_at, updated_at)
        VALUES ('org-a', 'node-a', 'instance-a', 'A', '203.0.113.10', 'provider',
          4, 1, ?, ?, ?)`)
      .run(acceptedAt, acceptedAt, acceptedAt)
    const input = await makeInput({
      action: 'reconcile',
      operationId: 'operation-runtime-endpoint-reconcile',
    })
    await accept(input)
    const worker = makeNodeRuntimeLifecycleExecution({
      repository: executionRepository(),
      transport: {
        assertSupported: () => Effect.void,
        dispatchAndObserve: () => Effect.die('reconcile must use observation-only transport'),
        observe: () =>
          Effect.succeed({
            providerState: 'active' as const,
            rebootConfirmed: false,
            actionNotApplied: false,
            playerAddresses: ['198.051.100.042', '2001:0DB8:0:0:0:0:0:42'],
            observedAt: recoveryAt,
          }),
      },
      leaseTokens: { next: () => 'lease-token-endpoint-reconcile' },
    })

    const executed = await Effect.runPromise(
      worker.execute({
        organizationId: 'org-a',
        operationId: input.identity.operationId,
        leaseOwner: 'worker-endpoint-reconcile',
        attemptedAt: recoveryAt,
      }),
    )
    expect(executed).toMatchObject({
      disposition: 'executed',
      result: { state: 'succeeded', operationStatus: 'succeeded', observedState: 'ready' },
    })
    expect(
      sqlite
        .prepare(`SELECT record_type AS recordType, target, source, observed_revision AS observedRevision,
          revision FROM node_player_endpoints
          WHERE organization_id = 'org-a' AND node_id = 'node-a' ORDER BY record_type`)
        .all(),
    ).toEqual([
      {
        recordType: 'A',
        target: '198.51.100.42',
        source: 'provider',
        observedRevision: 5,
        revision: 2,
      },
      {
        recordType: 'AAAA',
        target: '2001:0db8:0:0:0:0:0:42',
        source: 'provider',
        observedRevision: 5,
        revision: 1,
      },
    ])
    const envelope = sqlite
      .prepare(`SELECT envelope_json AS envelopeJson FROM audit_event_envelopes
        WHERE event_id = ?`)
      .get(`audit_node_runtime_complete:${input.identity.operationId}`) as { envelopeJson: string }
    expect(JSON.parse(envelope.envelopeJson)).toMatchObject({
      after: {
        state: 'captured',
        summary: {
          playerEndpointEvidence: 'captured',
          playerEndpoints: [
            { recordType: 'A', target: '198.51.100.42' },
            { recordType: 'AAAA', target: '2001:0db8:0:0:0:0:0:42' },
          ],
        },
      },
    })
    expect(
      JSON.parse(
        String(
          (
            sqlite
              .prepare(`SELECT payload_json AS payloadJson FROM outbox WHERE id = ?`)
              .get(`outbox_node_runtime_complete:${input.identity.operationId}`) as {
              payloadJson: string
            }
          ).payloadJson,
        ),
      ),
    ).toMatchObject({
      playerEndpointEvidence: 'captured',
      playerEndpoints: [
        { recordType: 'A', target: '198.51.100.42' },
        { recordType: 'AAAA', target: '2001:0db8:0:0:0:0:0:42' },
      ],
    })
  })

  it('removes player endpoint authority when a proven ready reconciliation reports ambiguity', async () => {
    makeReady()
    sqlite
      .prepare(`INSERT INTO node_player_endpoints
        (organization_id, node_id, provider_instance_id, record_type, target, source,
         observed_revision, revision, observed_at, created_at, updated_at)
        VALUES ('org-a', 'node-a', 'instance-a', 'A', '203.0.113.10', 'provider',
          4, 1, ?, ?, ?)`)
      .run(acceptedAt, acceptedAt, acceptedAt)
    const input = await makeInput({
      action: 'reconcile',
      operationId: 'operation-runtime-endpoint-ambiguous',
    })
    await accept(input)
    const claim = await claimDispatch(input)
    const result = await Effect.runPromise(
      executionRepository().recordObservation({
        reservation: claim.reservation,
        lease: claim.lease,
        phase: 'leased',
        recovery: 'fresh',
        observation: {
          providerState: 'active',
          rebootConfirmed: false,
          actionNotApplied: false,
          playerAddresses: ['198.51.100.40', '198.51.100.41'],
          observedAt: recoveryAt,
        },
        observedAt: recoveryAt,
      }),
    )
    expect(result).toMatchObject({ state: 'succeeded', operationStatus: 'succeeded' })
    expect(
      sqlite
        .prepare(`SELECT count(*) AS count FROM node_player_endpoints
          WHERE organization_id = 'org-a' AND node_id = 'node-a'`)
        .get(),
    ).toEqual({ count: 0 })
    const outbox = sqlite
      .prepare(`SELECT payload_json AS payloadJson FROM outbox WHERE id = ?`)
      .get(`outbox_node_runtime_complete:${input.identity.operationId}`) as { payloadJson: string }
    expect(JSON.parse(outbox.payloadJson)).toMatchObject({
      playerEndpointEvidence: 'absent',
      playerEndpointReason: 'provider-addresses-ambiguous',
      playerEndpoints: [],
    })
  })

  it('rolls back a dispatch mark when the operation changes between pre-read and commit', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-dispatch-mark-barrier' })
    await accept(input)
    const claim = await claimDispatch(input)
    d1.beforeBatch = () => {
      sqlite
        .prepare(`UPDATE operations SET status = 'failed', revision = revision + 1
          WHERE organization_id = 'org-a' AND id = ?`)
        .run(input.identity.operationId)
    }

    expect(
      await failureTag(
        executionRepository().markActionRequested({
          reservation: claim.reservation,
          lease: claim.lease,
          requestedAt: acceptedAt,
        }),
      ),
    ).toBe('NodeRuntimeLifecycleExecutionConflictError')
    expect(sqlite.prepare(`SELECT state FROM node_runtime_lifecycle_executions`).get()).toEqual({
      state: 'leased',
    })
    expect(count('node_runtime_lifecycle_dispatch_marks')).toBe(0)
  })

  it('bounds a lost dispatch-mark response before any provider call with a released reconciliation outcome', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-dispatch-response-loss' })
    await accept(input)
    const claim = await claimDispatch(input)
    // This repository-only invocation models the exact dangerous boundary: the D1 mark commits,
    // its response is lost, and no transport/provider function has run yet.
    d1.loseBatchResponse = true
    expect(
      await Effect.runPromise(
        executionRepository().markActionRequested({
          reservation: claim.reservation,
          lease: claim.lease,
          requestedAt: acceptedAt,
        }),
      ),
    ).toBe('delivery-unknown')
    expect(sqlite.prepare(`SELECT state FROM node_runtime_lifecycle_executions`).get()).toEqual({
      state: 'action-requested',
    })
    expect(
      sqlite.prepare(`SELECT status FROM operations WHERE id = ?`).get(input.identity.operationId),
    ).toEqual({ status: 'running' })
    expect(count('node_runtime_lifecycle_dispatch_marks')).toBe(1)

    const result = await Effect.runPromise(
      executionRepository().recordObservation({
        reservation: claim.reservation,
        lease: claim.lease,
        phase: 'action-requested',
        recovery: 'dispatch-uncertain',
        observation: {
          providerState: 'stopped',
          rebootConfirmed: false,
          actionNotApplied: false,
          observedAt: acceptedAt,
        },
        observedAt: acceptedAt,
      }),
    )
    expect(result).toMatchObject({
      state: 'reconciliation-required',
      operationStatus: 'failed_terminal',
    })
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id,
          reconciliation_error FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'stopped',
      desired_revision: 9,
      pending_lifecycle_operation_id: null,
      reconciliation_error: 'provider_action_delivery_unproven',
    })
  })

  it('repairs a crash before a start call only with provider proof of non-application', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-crash-repair' })
    await accept(input)
    const first = await claimDispatch(input)
    await markRequested(first)

    const recovery = await Effect.runPromise(
      executionRepository().claim({
        organizationId: 'org-a',
        operationId: input.identity.operationId,
        owner: 'worker-b',
        token: 'lease-token-b',
        leaseExpiresAt: recoveryLeaseExpiresAt,
        now: recoveryAt,
      }),
    )
    expect(recovery.disposition).toBe('observe')
    if (recovery.disposition !== 'observe') throw new Error('expected observation recovery')
    expect(recovery.recovery).toBe('action-requested-expired')
    const result = await Effect.runPromise(
      executionRepository().recordObservation({
        reservation: recovery.reservation,
        lease: recovery.lease,
        phase: 'leased',
        recovery: recovery.recovery,
        observation: {
          providerState: 'stopped',
          rebootConfirmed: false,
          actionNotApplied: true,
          observedAt: recoveryAt,
        },
        observedAt: recoveryAt,
      }),
    )

    expect(result).toMatchObject({
      state: 'reconciliation-required',
      operationStatus: 'failed_terminal',
      providerState: 'stopped',
    })
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id,
          reconciliation_error FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'stopped',
      desired_revision: 9,
      pending_lifecycle_operation_id: null,
      reconciliation_error: 'provider_action_unproven_not_applied',
    })
    expect(
      sqlite.prepare(`SELECT state, failure_code FROM node_runtime_lifecycle_executions`).get(),
    ).toEqual({ state: 'reconciliation-required', failure_code: 'action_unproven_not_applied' })
    expect(count('node_runtime_lifecycle_execution_receipts')).toBe(1)
  })

  it('releases an ambiguous reboot only into manual reconciliation, never inferred success', async () => {
    makeReady()
    const input = await makeInput({
      action: 'reboot',
      operationId: 'operation-runtime-reboot-ambiguous',
    })
    await accept(input)
    const first = await claimDispatch(input)
    await markRequested(first)
    const recovery = await Effect.runPromise(
      executionRepository().claim({
        organizationId: 'org-a',
        operationId: input.identity.operationId,
        owner: 'worker-b',
        token: 'lease-token-b',
        leaseExpiresAt: recoveryLeaseExpiresAt,
        now: recoveryAt,
      }),
    )
    if (recovery.disposition !== 'observe') throw new Error('expected observation recovery')
    const result = await Effect.runPromise(
      executionRepository().recordObservation({
        reservation: recovery.reservation,
        lease: recovery.lease,
        phase: 'leased',
        recovery: recovery.recovery,
        observation: {
          providerState: 'active',
          rebootConfirmed: false,
          actionNotApplied: true,
          observedAt: recoveryAt,
        },
        observedAt: recoveryAt,
      }),
    )

    expect(result).toMatchObject({
      state: 'reconciliation-required',
      operationStatus: 'failed_terminal',
      rebootConfirmed: false,
    })
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id,
          reconciliation_error
          FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'ready',
      desired_revision: 9,
      pending_lifecycle_operation_id: null,
      reconciliation_error: 'provider_reboot_delivery_unproven_manual_review',
    })
    expect(sqlite.prepare(`SELECT state FROM node_runtime_lifecycle_executions`).get()).toEqual({
      state: 'reconciliation-required',
    })
  })

  it.each(['start', 'stop', 'reboot'] as const)(
    'releases a %s node after a definite provider authorization failure',
    async (action) => {
      if (action !== 'start') makeReady()
      const input = await makeInput({
        action,
        operationId: `operation-runtime-terminal-${action}`,
      })
      await accept(input)
      const claim = await claimDispatch(input)
      await markRequested(claim)
      const result = await Effect.runPromise(
        executionRepository().recordTerminalFailure({
          reservation: claim.reservation,
          lease: claim.lease,
          phase: 'action-requested',
          code: 'provider_authorization_blocked',
          failedAt: recoveryAt,
        }),
      )

      const originalDesiredState = action === 'start' ? 'stopped' : 'ready'
      expect(result).toMatchObject({ state: 'failed-terminal', operationStatus: 'failed_terminal' })
      expect(
        sqlite
          .prepare(`SELECT desired_state, desired_revision, observed_state, observed_revision,
            pending_lifecycle_operation_id, reconciliation_error
            FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
          .get(),
      ).toEqual({
        desired_state: originalDesiredState,
        desired_revision: 9,
        observed_state: 'degraded',
        observed_revision: 5,
        pending_lifecycle_operation_id: null,
        reconciliation_error: 'provider_authorization_blocked',
      })
      expect(
        sqlite
          .prepare(`SELECT status FROM operations WHERE id = ?`)
          .get(input.identity.operationId),
      ).toEqual({ status: 'failed_terminal' })
      expect(
        sqlite.prepare(`SELECT state, failure_code FROM node_runtime_lifecycle_executions`).get(),
      ).toEqual({ state: 'failed-terminal', failure_code: 'provider_authorization_blocked' })
      expect(count('node_runtime_lifecycle_execution_receipts')).toBe(1)
    },
  )

  it('rolls back a provider observation when the node changes between pre-read and commit', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-observation-barrier' })
    await accept(input)
    const claim = await claimDispatch(input)
    d1.beforeBatch = () => {
      sqlite
        .prepare(`UPDATE nodes SET observed_state = 'degraded', observed_revision = 5
          WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .run()
    }

    expect(
      await failureTag(
        executionRepository().recordObservation({
          reservation: claim.reservation,
          lease: claim.lease,
          phase: 'leased',
          recovery: 'fresh',
          observation: {
            providerState: 'stopped',
            rebootConfirmed: false,
            actionNotApplied: false,
            observedAt: recoveryAt,
          },
          observedAt: recoveryAt,
        }),
      ),
    ).toBe('NodeRuntimeLifecycleExecutionConflictError')
    // The hook's concurrent update remains. Every statement from the attempted D1 batch rolled
    // back: no stale operation/execution/observation receipt was partially committed.
    expect(
      sqlite.prepare(`SELECT status FROM operations WHERE id = ?`).get(input.identity.operationId),
    ).toEqual({ status: 'queued' })
    expect(sqlite.prepare(`SELECT state FROM node_runtime_lifecycle_executions`).get()).toEqual({
      state: 'leased',
    })
    expect(count('node_runtime_lifecycle_observations')).toBe(0)
    expect(count('node_runtime_lifecycle_execution_receipts')).toBe(0)
  })

  it('rolls back a terminal failure when its lease changes between pre-read and commit', async () => {
    const input = await makeInput({ operationId: 'operation-runtime-failure-barrier' })
    await accept(input)
    const claim = await claimDispatch(input)
    await markRequested(claim)
    d1.beforeBatch = () => {
      sqlite
        .prepare(`UPDATE node_runtime_lifecycle_executions SET lease_token = 'lease-token-other', revision = revision + 1
          WHERE organization_id = 'org-a' AND operation_id = ?`)
        .run(input.identity.operationId)
    }

    expect(
      await failureTag(
        executionRepository().recordTerminalFailure({
          reservation: claim.reservation,
          lease: claim.lease,
          phase: 'action-requested',
          code: 'provider_validation_blocked',
          failedAt: recoveryAt,
        }),
      ),
    ).toBe('NodeRuntimeLifecycleExecutionConflictError')
    expect(
      sqlite
        .prepare(`SELECT desired_state, desired_revision, pending_lifecycle_operation_id
          FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({
      desired_state: 'ready',
      desired_revision: 8,
      pending_lifecycle_operation_id: input.identity.operationId,
    })
    expect(
      sqlite.prepare(`SELECT status FROM operations WHERE id = ?`).get(input.identity.operationId),
    ).toEqual({ status: 'running' })
    expect(
      sqlite.prepare(`SELECT state, lease_token FROM node_runtime_lifecycle_executions`).get(),
    ).toEqual({ state: 'action-requested', lease_token: 'lease-token-other' })
    expect(count('node_runtime_lifecycle_observations')).toBe(0)
    expect(count('node_runtime_lifecycle_execution_receipts')).toBe(0)
  })
})

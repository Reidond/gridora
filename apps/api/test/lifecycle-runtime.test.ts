import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import {
  LifecycleControl,
  type LifecycleCommand,
  type PolicyAdmissionShape,
} from '@gridora/lifecycle-control'
import type { LifecycleD1Database, LifecycleD1Statement } from '@gridora/lifecycle-d1'
import {
  makeFixedLifecycleWorkflowStarter,
  makeLifecycleControlLayer,
  makeLifecyclePolicyAdmission,
  type NativeLifecycleWorkflowBinding,
  type LifecycleWorkflowBindings,
} from '../src/lifecycle-runtime.js'
import { app, type ApiBindings } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
] as const

class SqliteStatement implements LifecycleD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
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
    return new SqliteStatement(this.database.prepare(sql))
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

const binding = (
  create = vi.fn(async ({ id }: { readonly id: string }) => ({ id })),
  get = vi.fn(async (id: string) => ({ id })),
): NativeLifecycleWorkflowBinding => ({
  create,
  get,
})

const bindingSet = (selected?: NativeLifecycleWorkflowBinding): LifecycleWorkflowBindings => ({
  provisionNode: binding(),
  retireNode: binding(),
  deployServer: binding(),
  configureServer: selected ?? binding(),
  updateServerMods: binding(),
  createBackup: binding(),
  restoreBackup: binding(),
  moveServer: binding(),
  deleteServer: binding(),
})

const configure = (overrides: Partial<LifecycleCommand> = {}): LifecycleCommand =>
  ({
    kind: 'configure-server',
    organizationId: 'org-a',
    actorId: 'actor-a',
    resourceId: 'server-a',
    idempotencyKey: 'request-a',
    expectedDesiredRevision: 3,
    correlationId: 'correlation-a',
    configRevision: 2,
    ...overrides,
  }) as LifecycleCommand

const allow: PolicyAdmissionShape = { admit: () => Effect.void }
let database: DatabaseSync
let d1: SqliteD1

const seed = () => {
  database
    .prepare(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('actor-a', 'access-a', 'actor@example.com', 'Actor', 'active', 'now', 'now')`)
    .run()
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
  database
    .prepare(`INSERT INTO game_servers
    (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
     placement_policy_json, desired_revision, observed_revision, active_config_revision,
     created_at, updated_at)
    VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'stopped', 'stopped',
     '{}', 3, 3, 1, 'now', 'now')`)
    .run()
}

const submit = (command: LifecycleCommand, workflows: LifecycleWorkflowBindings) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* LifecycleControl).submit(command)
    }).pipe(
      Effect.provide(
        makeLifecycleControlLayer({
          database: d1,
          workflows,
          organizationPolicy: allow,
          d1: {
            now: () => '2026-08-23T12:00:00.000Z',
            operationId: () => 'operation-a',
            auditEventId: () => 'audit-a',
            outboxEventId: () => 'outbox-a',
          },
        }),
      ),
    ),
  )

const recoveryEnv = (workflows: LifecycleWorkflowBindings): ApiBindings =>
  ({
    DB: d1,
    ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    ACCESS_AUDIENCE: 'gridora-api',
    INTERNAL_SERVICE_SECRET: 'internal-service-secret-with-at-least-32-bytes',
    INVITATION_TOKEN_SECRET: 'invitation-secret-with-at-least-32-bytes',
    INVITATION_TOKEN_KEY_VERSION: 'v1',
    NODE_CREDENTIAL_SECRET: 'node-credential-secret-with-at-least-32-bytes',
    PROVIDER_KEK_ACTIVE_VERSION: '1',
    PROVIDER_KEK_V1: { get: async () => 'ERERERERERERERERERERERERERERERERERERERERERE' },
    PROVIDER_BYOP_ENABLED: 'false',
    REGISTRATION_MODE: 'invitation-only',
    INTERNAL_REPLAY_GUARD: { getByName: () => ({ claim: async () => true }) },
    PROVISION_NODE: workflows.provisionNode,
    RETIRE_NODE: workflows.retireNode,
    DEPLOY_GAME_SERVER: workflows.deployServer,
    APPLY_GAME_CONFIG: workflows.configureServer,
    SYNC_MODS: workflows.updateServerMods,
    BACKUP_GAME_SERVER: workflows.createBackup,
    RESTORE_GAME_SERVER: workflows.restoreBackup,
    MOVE_GAME_SERVER: workflows.moveServer,
    DELETE_GAME_SERVER: workflows.deleteServer,
  }) as unknown as ApiBindings

const lifecycleEvent = () => ({
  id: 'outbox-a',
  organizationId: 'org-a',
  partitionKey: 'org-a:operation:operation-a',
  type: 'lifecycle.workflow-start.requested',
  occurredAt: '2026-08-23T12:00:00.000Z',
  payload: {
    operationId: 'operation-a',
    workflowStartRecordId: 'workflow-start:operation-a',
    resourceKind: 'server',
    resourceId: 'server-a',
    action: 'configure-server',
  },
})

const recoverOverHttp = async (
  env: ApiBindings,
  event: ReturnType<typeof lifecycleEvent>,
  nonce: string,
) => {
  const body = JSON.stringify(event)
  const routing = {
    method: 'POST',
    path: '/v1/internal/queue-events',
    queue: 'gridora-outbox',
    organizationId: event.organizationId,
  }
  const headers = await Effect.runPromise(
    signInternalRequest(body, env.INTERNAL_SERVICE_SECRET, Date.now(), nonce, routing),
  )
  return app.request(
    'http://api.gridora.test/v1/internal/queue-events',
    {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-gridora-queue': routing.queue,
        'x-gridora-organization-id': routing.organizationId,
      },
      body,
    },
    env,
  )
}

describe('API lifecycle root composition', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    seed()
  })
  afterEach(() => database.close())

  it('selects only the fixed binding for the action and never accepts a client binding name', async () => {
    const chosen = binding()
    const workflows = bindingSet(chosen)
    const accepted = await submit(configure(), workflows)
    expect(accepted.workflowState).toBe('started')
    expect(chosen.create).toHaveBeenCalledOnce()
    for (const [key, candidate] of Object.entries(workflows)) {
      if (key !== 'configureServer') expect(candidate.create).not.toHaveBeenCalled()
    }
    const options = vi.mocked(chosen.create).mock.calls[0]?.[0]
    expect(options?.id).toBe('operation-a')
    expect(JSON.stringify(options)).not.toContain('APPLY_GAME_CONFIG')
  })

  it('atomically reserves operation, audit, outbox, and start record and adopts exact replay', async () => {
    const workflows = bindingSet()
    const first = await submit(configure(), workflows)
    const replay = await submit(configure(), workflows)
    expect(first.operation.id).toBe('operation-a')
    expect(replay).toMatchObject({ disposition: 'adopted', operation: { id: 'operation-a' } })
    expect(database.prepare('SELECT COUNT(*) count FROM operations').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) count FROM audit_events').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) count FROM outbox').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT state FROM lifecycle_workflow_starts').get()).toEqual({
      state: 'started',
    })
  })

  it('classifies response-loss as durable pending reconciliation', async () => {
    const ambiguous = binding(
      vi.fn(async () => {
        throw new Error('connection reset')
      }),
      vi.fn(async () => {
        throw new Error('instance unavailable')
      }),
    )
    const accepted = await submit(configure(), bindingSet(ambiguous))
    expect(accepted.workflowState).toBe('pending-reconciliation')
    expect(database.prepare('SELECT state, attempts FROM lifecycle_workflow_starts').get()).toEqual(
      {
        state: 'pending',
        attempts: 1,
      },
    )
    expect(database.prepare('SELECT COUNT(*) count FROM operations').get()).toEqual({ count: 1 })
  })

  it('adopts the same native Workflow instance when the create response is lost', async () => {
    const instances = new Set<string>()
    const responseLost = binding(
      vi.fn(async ({ id }: { readonly id: string }) => {
        instances.add(id)
        throw new Error('response lost after create')
      }),
      vi.fn(async (id: string) => {
        if (!instances.has(id)) throw new Error('missing')
        return { id }
      }),
    )
    const accepted = await submit(configure(), bindingSet(responseLost))
    expect(accepted.workflowState).toBe('started')
    expect(instances).toEqual(new Set(['operation-a']))
    expect(database.prepare('SELECT state, attempts FROM lifecycle_workflow_starts').get()).toEqual(
      {
        state: 'started',
        attempts: 1,
      },
    )
  })

  it('never adopts a native Workflow instance returned under a different id', async () => {
    const wrongId = binding(
      vi.fn(async () => {
        throw new Error('response lost')
      }),
      vi.fn(async () => ({ id: 'operation-foreign' })),
    )
    const accepted = await submit(configure(), bindingSet(wrongId))
    expect(accepted.workflowState).toBe('pending-reconciliation')
    expect(wrongId.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'operation-a' }))
    expect(wrongId.get).toHaveBeenCalledWith('operation-a')
    expect(database.prepare('SELECT state, attempts FROM lifecycle_workflow_starts').get()).toEqual(
      {
        state: 'pending',
        attempts: 1,
      },
    )
  })

  it('recovers a committed pending start over authenticated queue delivery using authoritative D1 state', async () => {
    const firstAttempt = binding(
      vi.fn(async () => {
        throw new Error('response lost')
      }),
      vi.fn(async () => {
        throw new Error('instance unavailable')
      }),
    )
    await submit(configure(), bindingSet(firstAttempt))
    const recoveredBinding = binding()
    const workflows = bindingSet(recoveredBinding)
    const response = await recoverOverHttp(
      recoveryEnv(workflows),
      lifecycleEvent(),
      'lifecycle-recovery-1',
    )
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'applied',
      operationId: 'operation-a',
      workflowState: 'started',
    })
    expect(recoveredBinding.create).toHaveBeenCalledOnce()
    expect(database.prepare('SELECT state, attempts FROM lifecycle_workflow_starts').get()).toEqual(
      {
        state: 'started',
        attempts: 2,
      },
    )
  })

  it('keeps ambiguous recovery retryable and rejects payload routing that disagrees with D1', async () => {
    const ambiguous = binding(
      vi.fn(async () => {
        throw new Error('response lost')
      }),
      vi.fn(async () => {
        throw new Error('instance unavailable')
      }),
    )
    const workflows = bindingSet(ambiguous)
    await submit(configure(), workflows)
    const pending = await recoverOverHttp(
      recoveryEnv(workflows),
      lifecycleEvent(),
      'lifecycle-recovery-2',
    )
    expect(pending.status).toBe(503)
    await expect(pending.json()).resolves.toMatchObject({
      code: 'PERSISTENCE_UNAVAILABLE',
      retryable: true,
    })
    expect(database.prepare('SELECT state, attempts FROM lifecycle_workflow_starts').get()).toEqual(
      {
        state: 'pending',
        attempts: 2,
      },
    )

    const tampered = lifecycleEvent()
    tampered.payload.resourceId = 'server-other'
    const rejected = await recoverOverHttp(
      recoveryEnv(bindingSet()),
      tampered,
      'lifecycle-recovery-3',
    )
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' })
    expect(database.prepare('SELECT state, attempts FROM lifecycle_workflow_starts').get()).toEqual(
      {
        state: 'pending',
        attempts: 2,
      },
    )
  })

  it('rejects changed fingerprints, stale revisions, and cross-organization ids without extra effects', async () => {
    const workflows = bindingSet()
    await submit(configure(), workflows)
    const changed = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          return yield* (yield* LifecycleControl).submit(
            configure({ configRevision: 4 } as Partial<LifecycleCommand>),
          )
        }).pipe(
          Effect.provide(
            makeLifecycleControlLayer({ database: d1, workflows, organizationPolicy: allow }),
          ),
        ),
      ),
    )
    expect(changed._tag).toBe('Failure')
    if (changed._tag === 'Failure') expect(changed.failure._tag).toBe('IdempotencyConflictError')

    const stale = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          return yield* (yield* LifecycleControl).submit(
            configure({
              idempotencyKey: 'request-b',
              expectedDesiredRevision: 2,
            } as Partial<LifecycleCommand>),
          )
        }).pipe(
          Effect.provide(
            makeLifecycleControlLayer({ database: d1, workflows, organizationPolicy: allow }),
          ),
        ),
      ),
    )
    expect(stale._tag).toBe('Failure')
    if (stale._tag === 'Failure') expect(stale.failure._tag).toBe('RevisionConflictError')

    const other = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          return yield* (yield* LifecycleControl).submit(
            configure({
              organizationId: 'org-b',
              idempotencyKey: 'request-c',
            } as Partial<LifecycleCommand>),
          )
        }).pipe(
          Effect.provide(
            makeLifecycleControlLayer({ database: d1, workflows, organizationPolicy: allow }),
          ),
        ),
      ),
    )
    expect(other._tag).toBe('Failure')
    if (other._tag === 'Failure') expect(other.failure._tag).toBe('ResourceNotFoundError')
    expect(database.prepare('SELECT COUNT(*) count FROM operations').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) count FROM audit_events').get()).toEqual({ count: 1 })
  })

  it('fails closed without organization policy and does not alias unsupported actions', async () => {
    const denied = await Effect.runPromise(
      Effect.result(
        makeLifecyclePolicyAdmission().admit(configure(), {
          kind: 'server',
          id: 'server-a',
          organizationId: 'org-a',
          desiredState: 'stopped',
          observedState: 'stopped',
          desiredRevision: 3,
          lastVerifiedBackupRevision: null,
        }),
      ),
    )
    expect(denied._tag).toBe('Failure')
    if (denied._tag === 'Failure')
      expect(denied.failure.code).toBe('organization_policy_unavailable')

    const workflows = bindingSet()
    const unsupported = makeFixedLifecycleWorkflowStarter(workflows)
    const result = await Effect.runPromise(
      Effect.result(
        unsupported.start({
          workflowInstanceId: 'operation-x',
          startRecordId: 'workflow-start:operation-x',
          operation: {
            id: 'operation-x',
            organizationId: 'org-a',
            actorId: 'actor-a',
            resourceId: 'server-a',
            action: 'set-server-state',
            state: 'queued',
            idempotencyKey: 'key',
            fingerprint: '{}',
            correlationId: 'correlation',
          },
          reservation: {
            organizationId: 'org-a',
            resourceKind: 'server',
            resourceId: 'server-a',
            action: 'set-server-state',
            previousRevision: 3,
            desiredRevision: 4,
            desiredState: 'running',
          },
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    for (const candidate of Object.values(workflows))
      expect(candidate.create).not.toHaveBeenCalled()
  })
})

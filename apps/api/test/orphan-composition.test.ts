import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import { OrganizationContext } from '@gridora/domain'
import { KekPortLayer, prepareSecretEnvelope } from '@gridora/secret-envelope'
import { makeCloudflareSecretsStoreKekPort } from '@gridora/secret-kek-cloudflare'
import { makeOrphanScheduleStore, type OrphanScheduleTask } from '@gridora/orphan-schedule'
import { app, type ApiBindings } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const migrationFiles = readdirSync(sqlDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

class Statement {
  private values: ReadonlyArray<unknown> = []

  constructor(
    readonly database: DatabaseSync,
    readonly statement: StatementSync,
  ) {}

  bind(...values: ReadonlyArray<unknown>): Statement {
    const bound = new Statement(this.database, this.statement)
    bound.values = values
    return bound
  }

  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }

  async all(): Promise<{
    readonly results: ReadonlyArray<unknown>
    readonly meta: { readonly changes: number }
  }> {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    const changes = this.database.prepare('SELECT changes() AS changes').get() as {
      readonly changes: number
    }
    return { results, meta: { changes: changes.changes } }
  }

  async run(): Promise<{ readonly success: true; readonly meta: { readonly changes: number } }> {
    const result = this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, this.database.prepare(sql))
  }

  async batch(statements: ReadonlyArray<Statement>): Promise<ReadonlyArray<unknown>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement.all())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const count = (database: DatabaseSync, table: string): number =>
  (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number })
    .count

describe('scheduled orphan reconciliation API composition', () => {
  let database: DatabaseSync
  let d1: SqliteD1
  let env: ApiBindings
  let task: OrphanScheduleTask
  let published: Array<Record<string, unknown>>
  let providerRequests: Array<{ readonly method: string; readonly url: string }>

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrationFiles)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    published = []
    providerRequests = []
    const now = new Date().toISOString()
    database
      .prepare(`INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step,
         policy_revision, revision, created_at)
        VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west',
         'complete', 1, 1, ?)`)
      .run(now)
    const scheduler = database
      .prepare(`SELECT identity_id AS identityId
        FROM orphan_reconciliation_scheduler_identities WHERE organization_id = 'org-a'`)
      .get() as { readonly identityId: string }

    const kekText = base64Url(new Uint8Array(32).fill(9))
    const kek = makeCloudflareSecretsStoreKekPort({
      activeVersion: 1,
      keys: { 1: { get: async () => kekText } },
    })
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        authUrl: 'https://auth.cloud.ovh.net/v3',
        region: 'GRA11',
        projectId: 'project-a',
        applicationCredentialId: 'credential-a',
        applicationCredentialSecret: 'credential-secret-a',
      }),
    )
    const context = Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: scheduler.identityId,
      role: 'automation',
      correlationId: 'orphan-run-a',
    })
    const envelope = await Effect.runPromise(
      prepareSecretEnvelope(context, {
        id: 'credential-account-a',
        scopeType: 'provider-account',
        scopeId: 'account-a',
        plaintext,
        now,
      }).pipe(Effect.provide(KekPortLayer(kek))),
    )
    plaintext.fill(0)
    database
      .prepare(`INSERT INTO secret_envelopes
        (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
         key_version, revision, created_at, rotated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        envelope.organizationId,
        envelope.id,
        envelope.scopeType,
        envelope.scopeId,
        envelope.ciphertext,
        envelope.wrappedDataKey,
        envelope.keyVersion,
        envelope.revision,
        envelope.createdAt,
        envelope.rotatedAt,
      )
    database
      .prepare(`INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference,
         status, revision, created_at, updated_at)
        VALUES ('account-a', 'organization', 'org-a', 'ovhcloud', 'credential-account-a',
         'active', 1, ?, ?)`)
      .run(now, now)
    database
      .prepare(`INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
         max_active_nodes, status, revision)
        VALUES ('org-a', 'account-a', '["eu-west"]', '["small"]', 10, 'active', 1)`)
      .run()

    const schedule = makeOrphanScheduleStore(d1, { now: () => new Date() })
    const scheduled = await Effect.runPromise(
      schedule.claimScheduledTasks(new Date().toISOString()),
    )
    const scheduledTask = scheduled[0]
    if (scheduledTask === undefined)
      throw new Error('orphan scheduler did not claim the active allocation')
    await Effect.runPromise(schedule.beginWorkflow(scheduledTask))
    task = scheduledTask

    const eventObject = {
      initialize: async () => undefined,
      publish: async (event: Record<string, unknown>) => {
        published.push(event)
      },
    }
    const unusedWorkflow = {
      create: async () => ({ id: 'unused' }),
      get: async () => ({ id: 'unused' }),
    }
    env = {
      DB: d1,
      ACCESS_ISSUER: 'https://access.gridora.test',
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'invitation-secret-with-at-least-thirty-two-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: { get: async () => kekText },
      REGISTRATION_MODE: 'open',
      INTERNAL_SERVICE_SECRET: 'internal-service-secret-with-at-least-thirty-two-bytes',
      INTERNAL_REPLAY_GUARD: { getByName: () => ({ claim: async () => true }) },
      ORGANIZATION_EVENTS: { getByName: () => eventObject },
      BACKUPS: {},
      PROVISION_NODE: unusedWorkflow,
      RETIRE_NODE: unusedWorkflow,
      DEPLOY_GAME_SERVER: unusedWorkflow,
      APPLY_GAME_CONFIG: unusedWorkflow,
      UPDATE_GAME_SERVER: unusedWorkflow,
      BACKUP_GAME_SERVER: unusedWorkflow,
      RESTORE_GAME_SERVER: unusedWorkflow,
      MOVE_GAME_SERVER: unusedWorkflow,
      DELETE_GAME_SERVER: unusedWorkflow,
    } as unknown as ApiBindings

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      providerRequests.push({ method: request.method, url: request.url })
      if (request.url === 'https://auth.cloud.ovh.net/v3/auth/tokens')
        return Response.json(
          {
            token: {
              catalog: [
                {
                  type: 'compute',
                  endpoints: [
                    {
                      region: 'GRA11',
                      interface: 'public',
                      url: 'https://compute.cloud.ovh.net/v2.1/project-a',
                    },
                  ],
                },
              ],
            },
          },
          { headers: { 'x-subject-token': 'subject-token-a' } },
        )
      if (request.url === 'https://compute.cloud.ovh.net/v2.1/project-a/servers/detail?limit=200')
        return Response.json({
          servers: [
            {
              id: 'instance-a',
              name: 'Gridora node',
              status: 'ACTIVE',
              flavor: { id: 'small' },
              addresses: {},
              metadata: {
                'managed-by': 'gridora',
                'organization-id': 'org-a',
                'node-id': 'node-a',
                'operation-id': 'operation-a',
                'image-version': '1.0.0',
                'gridora-region': 'eu-west',
              },
            },
          ],
          servers_links: [],
        })
      throw new Error(`unexpected provider request ${request.method} ${request.url}`)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  it('runs the signed task through real discovery, high finding/audit/event, and completion without deletion', async () => {
    const body = JSON.stringify(task)
    const routing = {
      method: 'POST',
      path: '/v1/internal/orphan-reconciliations/execute',
      workflow: 'reconcile-orphan',
      organizationId: task.organizationId,
    }
    const headers = await Effect.runPromise(
      signInternalRequest(
        body,
        env.INTERNAL_SERVICE_SECRET,
        Date.now(),
        'orphan-api-nonce-a',
        routing,
      ),
    )
    const response = await app.request(
      'https://api.gridora.test/v1/internal/orphan-reconciliations/execute',
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'x-gridora-workflow': 'reconcile-orphan',
          'x-gridora-organization-id': task.organizationId,
          'idempotency-key': `workflow:${task.idempotencyKey}`,
        },
        body,
      },
      env,
    )

    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ opened: 1, replayed: false })
    expect(count(database, 'orphan_findings')).toBe(1)
    expect(count(database, 'orphan_reconciliation_runs')).toBe(1)
    expect(count(database, 'audit_events')).toBe(1)
    expect(
      database
        .prepare(`SELECT state FROM orphan_reconciliation_schedule_leases
        WHERE organization_id = 'org-a' AND provider_account_id = 'account-a'`)
        .get(),
    ).toEqual({ state: 'completed' })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      organizationId: 'org-a',
      type: 'orphan.finding.detected',
      data: { severity: 'high', opened: 1 },
    })
    expect(JSON.stringify(published)).not.toContain('credential-secret-a')
    expect(providerRequests).toEqual([
      { method: 'POST', url: 'https://auth.cloud.ovh.net/v3/auth/tokens' },
      {
        method: 'GET',
        url: 'https://compute.cloud.ovh.net/v2.1/project-a/servers/detail?limit=200',
      },
    ])
    expect(providerRequests.some((request) => request.method === 'DELETE')).toBe(false)
  })
})

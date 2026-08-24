/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import { app, type ApiBindings } from '../src/index.js'

class Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): Statement {
    return new Statement(this.database, this.sql, values)
  }
  async first(): Promise<unknown> {
    return (
      this.database.prepare(this.sql).get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
    )
  }
  async all(): Promise<{ results: ReadonlyArray<unknown> }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as ReadonlyArray<SQLInputValue>)),
    }
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.database
      .prepare(this.sql)
      .run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const b64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const json = (value: unknown): string => b64(new TextEncoder().encode(JSON.stringify(value)))
const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)

describe('inventory HTTP tenant isolation', () => {
  let database: DatabaseSync
  let assertion: string
  let env: ApiBindings

  const insertCompleteAudit = (
    id: string,
    organizationId: string,
    actorId: string,
    action: string,
    correlationId: string,
    operationId: string,
  ): void => {
    const occurredAt = '2026-08-23T12:00:00Z'
    const stage = Effect.runSync(
      stageAuditEnvelope(
        'tenant',
        id,
        {
          version: 1,
          captureStatus: 'complete',
          occurredAt,
          scope: 'tenant',
          organizationId,
          actor: { type: 'human', id: actorId },
          request: { id: `request-${id}`, correlationId },
          action,
          target: { type: 'organization', id: organizationId },
          before: { state: 'captured', summary: { policyRevision: 1 } },
          after: { state: 'captured', summary: {} },
          operationId,
          source: {
            origin: 'http',
            ip: { state: 'captured', value: '203.0.113.20' },
            access: {
              state: 'captured',
              value: {
                subject: actorId === 'owner-a' ? 'subject-a' : 'subject-b',
                identityId: actorId,
                issuer: 'https://team.cloudflareaccess.com',
                email: actorId === 'owner-a' ? 'a@example.com' : 'b@example.com',
              },
            },
          },
          result: 'succeeded',
          error: { classification: 'none', code: null },
          forced: false,
          breakGlass: false,
        },
        occurredAt,
      ),
    )
    database.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
    database
      .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES (?, ?, ?, ?, 'organization', ?, 'succeeded', ?, '{}', ?)`)
      .run(id, organizationId, actorId, action, organizationId, correlationId, occurredAt)
  }

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const name of readdirSync(migrationsDirectory)
      .filter((name) => /^\d{4}_[A-Za-z0-9_]+\.sql$/.test(name))
      .sort()) {
      database.exec(readFileSync(`${migrationsDirectory}${name}`, 'utf8'))
    }
    const timestamp = '2026-08-23T12:00:00Z'
    database.exec(`
      INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('owner-a','subject-a','a@example.com','Owner A','active','${timestamp}','${timestamp}'),
               ('owner-b','subject-b','b@example.com','Owner B','active','${timestamp}','${timestamp}');
      INSERT INTO organizations (id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at)
        VALUES ('org-a','A','organization-a','active','UTC','eu','complete',1,1,'${timestamp}'),
               ('org-b','B','organization-b','active','UTC','eu','complete',1,1,'${timestamp}');
      INSERT INTO organization_memberships (organization_id,identity_id,role,status,joined_at,revision)
        VALUES ('org-a','owner-a','owner','active','${timestamp}',1),('org-b','owner-b','owner','active','${timestamp}',1);
      INSERT INTO provider_accounts (id,scope,organization_id,provider_type,credential_reference,status,revision,created_at,updated_at)
        VALUES ('account-a','organization','org-a','ovhcloud','secret-a','active',1,'${timestamp}','${timestamp}'),
               ('account-b','organization','org-b','contabo','secret-b','active',1,'${timestamp}','${timestamp}');
      INSERT INTO provider_allocations
        (organization_id,provider_account_id,allowed_regions_json,allowed_plans_json,max_active_nodes,status,revision)
        VALUES ('org-a','account-a','["eu"]','["small"]',2,'active',1),
               ('org-b','account-b','["us"]','["large"]',2,'active',1);
      INSERT INTO node_images (id,version,checksum,signature,provider_mappings_json,status,created_at,promoted_at)
        VALUES ('image-a','1','sum','sig','{}','promoted','${timestamp}','${timestamp}');
      INSERT INTO nodes (organization_id,id,provider_account_id,provider_type,region,plan,image_id,placement_mode,desired_state,observed_state,desired_revision,observed_revision,created_at,updated_at)
        VALUES ('org-a','node-a','account-a','ovhcloud','eu','small','image-a','shared','ready','ready',1,1,'${timestamp}','${timestamp}'),
               ('org-b','node-b','account-b','contabo','us','large','image-a','shared','ready','ready',1,1,'${timestamp}','${timestamp}');
    `)
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (url.includes('cdn-cgi/access/certs')) {
        return Response.json({ keys: [{ ...jwk, kid: 'inventory-key', alg: 'RS256', use: 'sig' }] })
      }
      if (url === 'https://auth.cloud.ovh.net/v3/auth/tokens') {
        return Response.json(
          {
            token: {
              project: { id: 'project-a' },
              catalog: [
                {
                  type: 'compute',
                  endpoints: [
                    {
                      interface: 'public',
                      region_id: 'GRA11',
                      url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-a',
                    },
                  ],
                },
              ],
            },
          },
          { status: 201, headers: { 'x-subject-token': 'subject-token-a' } },
        )
      }
      if (url.startsWith('https://compute.gra11.cloud.ovh.net/v2.1/project-a/flavors/detail')) {
        return Response.json({ flavors: [] })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const issuer = 'https://team.cloudflareaccess.com'
    const header = json({ alg: 'RS256', typ: 'JWT', kid: 'inventory-key' })
    const payload = json({
      iss: issuer,
      aud: ['gridora-api'],
      sub: 'subject-a',
      email: 'a@example.com',
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    assertion = `${header}.${payload}.${b64(new Uint8Array(signature))}`
    const db = {
      prepare: (sql: string) => new Statement(database, sql),
      batch: async (statements: ReadonlyArray<Statement>) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const results = []
          for (const statement of statements) results.push(await statement.run())
          database.exec('COMMIT')
          return results
        } catch (cause) {
          if (database.isTransaction) database.exec('ROLLBACK')
          throw cause
        }
      },
    }
    const remediationRecords = new Map<string, unknown>([
      [
        'organizations/org-a/notification-remediation/event-a.json',
        {
          version: 1,
          disposition: 'permanent-failure',
          action: 'reissue-invitation',
          eventId: 'event-a',
          organizationId: 'org-a',
          invitationId: 'invitation-a',
          code: 'E_RECIPIENT_SUPPRESSED',
          eventCreatedAt: timestamp,
        },
      ],
      [
        'organizations/org-b/notification-remediation/event-b.json',
        {
          version: 1,
          disposition: 'permanent-failure',
          action: 'reissue-invitation',
          eventId: 'event-b',
          organizationId: 'org-b',
          invitationId: 'invitation-b',
          code: 'E_RECIPIENT_SUPPRESSED',
          eventCreatedAt: timestamp,
        },
      ],
    ])
    const remediationBucket = {
      async get(key: string) {
        const value = remediationRecords.get(key)
        return value === undefined ? null : { json: async () => value }
      },
      async list(options: { readonly prefix?: string }) {
        return {
          objects: [...remediationRecords.keys()]
            .filter((key) => key.startsWith(options.prefix ?? ''))
            .map((key) => ({ key })),
          truncated: false,
        }
      },
    } as unknown as R2Bucket
    env = {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'test-invitation-secret-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_BYOP_ENABLED: 'true',
      PROVIDER_KEK_V1: {
        get: async () => b64(new Uint8Array(32).fill(41)),
      },
      DB: db,
      NOTIFICATION_REMEDIATION: remediationBucket,
    } as unknown as ApiBindings
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  it('lists only the authorized tenant and returns non-disclosing 404 for a foreign detail id', async () => {
    const headers = { 'cf-access-jwt-assertion': assertion }
    const list = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/nodes',
      { headers },
      env,
    )
    expect(list.status, await list.clone().text()).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: 'node-a', organizationId: 'org-a' }],
    })
    const foreign = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/nodes/node-b',
      { headers },
      env,
    )
    expect(foreign.status).toBe(404)
    await expect(foreign.json()).resolves.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('allows a Viewer to read only its organization audit history', async () => {
    database
      .prepare(
        "UPDATE organization_memberships SET role = 'viewer' WHERE organization_id = 'org-a' AND identity_id = 'owner-a'",
      )
      .run()
    database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES
          ('operation-a', 'org-a', 'viewer.audit.test', 'organization', 'org-a', 'owner-a',
           'succeeded', 100, 'audit-a-key', 'correlation-a', 1, '2026-08-23T12:00:00Z', '2026-08-23T12:00:00Z'),
          ('operation-b', 'org-b', 'foreign.audit.test', 'organization', 'org-b', 'owner-b',
           'succeeded', 100, 'audit-b-key', 'correlation-b', 1, '2026-08-23T12:00:00Z', '2026-08-23T12:00:00Z')`)
      .run()
    insertCompleteAudit(
      'audit-a',
      'org-a',
      'owner-a',
      'viewer.audit.test',
      'correlation-a',
      'operation-a',
    )
    insertCompleteAudit(
      'audit-b',
      'org-b',
      'owner-b',
      'foreign.audit.test',
      'correlation-b',
      'operation-b',
    )
    const response = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/audit-events',
      { headers: { 'cf-access-jwt-assertion': assertion } },
      env,
    )
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: 'audit-a',
          organizationId: 'org-a',
          schemaVersion: 1,
          captureStatus: 'complete',
          envelope: { operationId: 'operation-a', scope: 'tenant' },
        },
      ],
    })
  })

  it('rejects client-selected provider facts before accepting a node operation', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/nodes',
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': assertion,
          'content-type': 'application/json',
          'idempotency-key': 'node-create-gated-1',
        },
        body: JSON.stringify({ providerAccountId: 'account-a', region: 'eu' }),
      },
      env,
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'REQUEST_VALIDATION_FAILED',
      retryable: false,
    })
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 0 })
  })

  it("lists only the authorized tenant's token-free notification remediation records", async () => {
    const headers = { 'cf-access-jwt-assertion': assertion }
    const response = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/notification-remediation',
      { headers },
      env,
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const payload = (await response.json()) as {
      readonly items: ReadonlyArray<Record<string, unknown>>
    }
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      eventId: 'event-a',
      organizationId: 'org-a',
      action: 'reissue-invitation',
    })
    expect(JSON.stringify(payload)).not.toContain('token')
    expect(JSON.stringify(payload)).not.toContain('email')
  })

  it('creates and rotates a provider credential atomically without returning or auditing secrets', async () => {
    const credentialCanary = 'ovh-secret-canary-never-exposed'
    const headers = {
      'cf-access-jwt-assertion': assertion,
      'content-type': 'application/json',
      'idempotency-key': 'provider-create-1',
    }
    const createBody = {
      providerType: 'ovhcloud',
      credentials: {
        authUrl: 'https://auth.cloud.ovh.net/v3',
        region: 'GRA11',
        projectId: 'project-a',
        applicationCredentialId: 'credential-a',
        applicationCredentialSecret: credentialCanary,
      },
    }
    const create = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/provider-accounts',
      { method: 'POST', headers, body: JSON.stringify(createBody) },
      env,
    )
    expect(create.status, await create.clone().text()).toBe(201)
    const account = (await create.json()) as { readonly id: string; readonly revision: number }
    expect(account.revision).toBe(1)
    expect(JSON.stringify(account)).not.toContain(credentialCanary)
    expect(JSON.stringify(account)).not.toContain('credentials')
    const secretRow = database
      .prepare(
        "SELECT ciphertext, wrapped_data_key AS wrappedDataKey FROM secret_envelopes WHERE organization_id = 'org-a' AND scope_id = ?",
      )
      .get(account.id) as { readonly ciphertext: string; readonly wrappedDataKey: string }
    expect(secretRow.ciphertext).not.toContain(credentialCanary)
    expect(secretRow.wrappedDataKey).not.toContain(credentialCanary)
    expect(
      JSON.stringify(
        database
          .prepare(
            "SELECT summary_json AS summary FROM audit_events WHERE organization_id = 'org-a' AND target_id = ?",
          )
          .all(account.id),
      ),
    ).not.toContain(credentialCanary)

    const replay = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/provider-accounts',
      { method: 'POST', headers, body: JSON.stringify(createBody) },
      env,
    )
    expect(replay.status).toBe(201)
    await expect(replay.json()).resolves.toMatchObject({ id: account.id, revision: 1 })
    expect(
      database
        .prepare('SELECT count(*) AS count FROM provider_accounts WHERE id = ?')
        .get(account.id),
    ).toEqual({ count: 1 })

    const conflict = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/provider-accounts',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...createBody,
          credentials: {
            ...createBody.credentials,
            applicationCredentialSecret: 'different-secret',
          },
        }),
      },
      env,
    )
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ code: 'CONFLICT' })

    const updateCanary = 'rotated-secret-never-exposed'
    const update = await app.request(
      `http://api.gridora.test/v1/organizations/organization-a/provider-accounts/${account.id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'idempotency-key': 'provider-update-1' },
        body: JSON.stringify({
          providerType: 'ovhcloud',
          expectedRevision: 1,
          expectedCredentialRevision: 1,
          credentials: { ...createBody.credentials, applicationCredentialSecret: updateCanary },
        }),
      },
      env,
    )
    expect(update.status, await update.clone().text()).toBe(200)
    await expect(update.json()).resolves.toMatchObject({ id: account.id, revision: 2 })
    const stored = JSON.stringify(
      database
        .prepare(
          "SELECT ciphertext, wrapped_data_key, revision FROM secret_envelopes WHERE organization_id = 'org-a' AND scope_id = ?",
        )
        .get(account.id),
    )
    expect(stored).not.toContain(updateCanary)
    expect(stored).toContain('"revision":2')

    const updateReplay = await app.request(
      `http://api.gridora.test/v1/organizations/organization-a/provider-accounts/${account.id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'idempotency-key': 'provider-update-1' },
        body: JSON.stringify({
          providerType: 'ovhcloud',
          expectedRevision: 1,
          expectedCredentialRevision: 1,
          credentials: { ...createBody.credentials, applicationCredentialSecret: updateCanary },
        }),
      },
      env,
    )
    expect(updateReplay.status).toBe(200)
    await expect(updateReplay.json()).resolves.toMatchObject({ id: account.id, revision: 2 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE organization_id = 'org-a' AND target_id = ?",
        )
        .get(account.id),
    ).toEqual({ count: 2 })

    const stale = await app.request(
      `http://api.gridora.test/v1/organizations/organization-a/provider-accounts/${account.id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'idempotency-key': 'provider-update-stale' },
        body: JSON.stringify({
          providerType: 'ovhcloud',
          expectedRevision: 1,
          expectedCredentialRevision: 2,
          credentials: { ...createBody.credentials, applicationCredentialSecret: 'stale-secret' },
        }),
      },
      env,
    )
    expect(stale.status).toBe(409)
    expect(
      database
        .prepare(
          "SELECT revision FROM provider_accounts WHERE organization_id = 'org-a' AND id = ?",
        )
        .get(account.id),
    ).toEqual({ revision: 2 })

    const typeChange = await app.request(
      `http://api.gridora.test/v1/organizations/organization-a/provider-accounts/${account.id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'idempotency-key': 'provider-type-change' },
        body: JSON.stringify({
          providerType: 'contabo',
          expectedRevision: 2,
          expectedCredentialRevision: 2,
          credentials: {
            tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
            apiBaseUrl: 'https://api.contabo.com',
            clientId: 'client',
            clientSecret: 'secret',
            apiUser: 'user',
            apiPassword: 'password',
          },
        }),
      },
      env,
    )
    expect(typeChange.status).toBe(409)
    expect(
      database
        .prepare(
          "SELECT provider_type AS providerType, revision FROM provider_accounts WHERE organization_id = 'org-a' AND id = ?",
        )
        .get(account.id),
    ).toEqual({ providerType: 'ovhcloud', revision: 2 })

    const foreign = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/provider-accounts/account-b',
      {
        method: 'PATCH',
        headers: { ...headers, 'idempotency-key': 'provider-foreign-1' },
        body: JSON.stringify({
          providerType: 'contabo',
          expectedRevision: 1,
          expectedCredentialRevision: 1,
          credentials: {
            tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
            apiBaseUrl: 'https://api.contabo.com',
            clientId: 'client',
            clientSecret: 'secret',
            apiUser: 'user',
            apiPassword: 'password',
          },
        }),
      },
      env,
    )
    expect(foreign.status).toBe(404)
  })

  it('rejects provider shape confusion and validates an encrypted account through the real route', async () => {
    const headers = {
      'cf-access-jwt-assertion': assertion,
      'content-type': 'application/json',
      'idempotency-key': 'provider-invalid-1',
    }
    const invalid = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/provider-accounts',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerType: 'contabo',
          credentials: {
            authUrl: 'https://auth.cloud.ovh.net/v3',
            projectId: 'wrong-provider-shape',
          },
        }),
      },
      env,
    )
    expect(invalid.status).toBe(400)
    expect(
      database.prepare('SELECT count(*) AS count FROM provider_account_mutation_idempotency').get(),
    ).toEqual({ count: 0 })
    const createBody = {
      providerType: 'ovhcloud',
      credentials: {
        authUrl: 'https://auth.cloud.ovh.net/v3',
        region: 'GRA11',
        projectId: 'project-a',
        applicationCredentialId: 'credential-a',
        applicationCredentialSecret: 'provider-validation-secret-canary',
      },
    }
    const created = await app.request(
      'http://api.gridora.test/v1/organizations/organization-a/provider-accounts',
      {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'provider-validation-create' },
        body: JSON.stringify(createBody),
      },
      env,
    )
    expect(created.status, await created.clone().text()).toBe(201)
    const account = (await created.json()) as { readonly id: string; readonly revision: number }
    const liveTest = await app.request(
      `http://api.gridora.test/v1/organizations/organization-a/provider-accounts/${account.id}/test`,
      {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'provider-validation-test' },
        body: JSON.stringify({ expectedRevision: account.revision }),
      },
      env,
    )
    expect(liveTest.status, await liveTest.clone().text()).toBe(200)
    const validation = await liveTest.json()
    expect(validation).toMatchObject({
      accountId: account.id,
      organizationId: 'org-a',
      providerType: 'ovhcloud',
      action: 'test',
      outcome: 'valid',
      accountStatus: 'active',
      revision: 2,
      regionCount: 1,
      projectCount: 1,
      catalogItemCount: 0,
    })
    expect(JSON.stringify(validation)).not.toContain('provider-validation-secret-canary')
  })

  it('requires both an Owner membership and the server-side BYOP feature gate', async () => {
    const request = () =>
      app.request(
        'http://api.gridora.test/v1/organizations/organization-a/provider-accounts',
        {
          method: 'POST',
          headers: {
            'cf-access-jwt-assertion': assertion,
            'content-type': 'application/json',
            'idempotency-key': 'provider-policy-1',
          },
          body: JSON.stringify({
            providerType: 'ovhcloud',
            credentials: {
              authUrl: 'https://auth.cloud.ovh.net/v3',
              region: 'GRA11',
              projectId: 'project',
              applicationCredentialId: 'credential',
              applicationCredentialSecret: 'secret',
            },
          }),
        },
        env,
      )
    env.PROVIDER_BYOP_ENABLED = 'false'
    expect((await request()).status).toBe(403)
    env.PROVIDER_BYOP_ENABLED = 'true'
    database
      .prepare(
        "UPDATE organization_memberships SET role = 'administrator' WHERE organization_id = 'org-a' AND identity_id = 'owner-a'",
      )
      .run()
    expect((await request()).status).toBe(403)
    expect(
      database.prepare('SELECT count(*) AS count FROM provider_account_mutation_idempotency').get(),
    ).toEqual({ count: 0 })
  })
})

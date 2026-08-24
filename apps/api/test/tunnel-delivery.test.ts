/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAgentMachineAuditRepositoryD1 } from '@gridora/agent-observation-d1'
import { decodeTunnelCredentialAgentCommand } from '@gridora/agent-protocol'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import { generateTunnelCredentialNodeKeyPair } from '@gridora/tunnel-credential'
import { markTunnelCommandDelivered, validateInstallerPublicKey } from '../src/tunnel-delivery.js'
import { app, type ApiBindings } from '../src/index.js'

const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

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
  runSync(): { success: true; meta: { changes: number } } {
    const result = this.database
      .prepare(this.sql)
      .run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync()
  }
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const json = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)))
const pem = (der: ArrayBuffer): string => {
  const body =
    btoa(String.fromCharCode(...new Uint8Array(der)))
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
}

describe('sealed Tunnel credential delivery', () => {
  let database: DatabaseSync
  let env: ApiBindings
  let accessPrivateKey: CryptoKey
  let cloudflareRequests: Array<{
    readonly method: string
    readonly url: string
    readonly body: string | null
  }>
  let remoteNameMismatch: boolean
  let coordinatorEnqueue: ReturnType<typeof vi.fn>
  let failAfterTunnelAcceptanceCommitOnce: boolean
  const tokenCanary = 'cloudflare-tunnel-token-canary-never-persisted-0123456789'
  const assertion = async (subject: string): Promise<string> => {
    const header = json({ alg: 'RS256', typ: 'JWT', kid: 'tunnel-test-key' })
    const payload = json({
      iss: 'https://team.cloudflareaccess.com',
      aud: ['gridora-api'],
      sub: subject,
      email: `${subject}@example.com`,
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      accessPrivateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
  }
  const deliver = async (
    subject: string,
    organization: string,
    nodeId: string,
    tunnelId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ) =>
    app.request(
      `http://api.gridora.test/v1/organizations/${organization}/nodes/${nodeId}/tunnels/${tunnelId}/credential-deliveries`,
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': await assertion(subject),
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

  const acknowledgeTunnel = async (
    delivery: { readonly deliveryId: string; readonly operationId: string },
    revision: number,
    code: string,
    completedAt: string,
  ) =>
    Effect.runPromise(
      makeAgentMachineAuditRepositoryD1(env.DB).recordCommandResult({
        principal: {
          organizationId: 'org-a',
          nodeId: 'node-a',
          credentialId: 'credential-a',
          version: 1,
          sessionVersion: 1,
        },
        result: {
          commandId: delivery.deliveryId,
          operationId: delivery.operationId,
          status: 'succeeded',
          revision,
          code,
          message: 'machine acknowledgement payload is redacted before durable audit',
          duplicate: false,
          completedAt,
        },
        acceptedAt: completedAt,
      }),
    )

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const name of migrationFiles)
      database.exec(readFileSync(`${migrationsDirectory}${name}`, 'utf8'))
    const timestamp = '2026-08-23T12:00:00Z'
    database.exec(`
      INSERT INTO identities (id,access_subject,email,display_name,status,signed_up_at,last_login_at) VALUES
        ('owner-a','owner-a','owner-a@example.com','Owner A','active','${timestamp}','${timestamp}'),
        ('admin-a','admin-a','admin-a@example.com','Admin A','active','${timestamp}','${timestamp}'),
        ('operator-a','operator-a','operator-a@example.com','Operator A','active','${timestamp}','${timestamp}'),
        ('owner-b','owner-b','owner-b@example.com','Owner B','active','${timestamp}','${timestamp}');
      INSERT INTO organizations (id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at) VALUES
        ('org-a','A','organization-a','active','UTC','eu','complete',1,1,'${timestamp}'),
        ('org-b','B','organization-b','active','UTC','eu','complete',1,1,'${timestamp}');
      INSERT INTO organization_memberships (organization_id,identity_id,role,status,joined_at,revision) VALUES
        ('org-a','owner-a','owner','active','${timestamp}',1),
        ('org-a','admin-a','administrator','active','${timestamp}',1),
        ('org-a','operator-a','operator','active','${timestamp}',1),
        ('org-b','owner-b','owner','active','${timestamp}',1);
      INSERT INTO provider_accounts (id,scope,organization_id,provider_type,credential_reference,status,revision,created_at,updated_at) VALUES
        ('provider-a','organization','org-a','ovhcloud','ref-a','active',1,'${timestamp}','${timestamp}'),
        ('provider-b','organization','org-b','ovhcloud','ref-b','active',1,'${timestamp}','${timestamp}');
      INSERT INTO provider_allocations (organization_id,provider_account_id,allowed_regions_json,allowed_plans_json,max_active_nodes,status,revision) VALUES
        ('org-a','provider-a','["eu"]','["small"]',2,'active',1),
        ('org-b','provider-b','["eu"]','["small"]',2,'active',1);
      INSERT INTO node_images (id,version,checksum,signature,provider_mappings_json,status,created_at) VALUES
        ('image-a','1','sum','sig','{}','promoted','${timestamp}');
      INSERT INTO nodes (organization_id,id,provider_account_id,provider_instance_id,provider_type,region,plan,image_id,placement_mode,desired_state,observed_state,desired_revision,observed_revision,created_at,updated_at) VALUES
        ('org-a','node-a','provider-a','instance-a','ovhcloud','eu','small','image-a','shared','ready','ready',1,1,'${timestamp}','${timestamp}'),
        ('org-b','node-b','provider-b','instance-b','ovhcloud','eu','small','image-a','shared','ready','ready',1,1,'${timestamp}','${timestamp}');
      INSERT INTO tunnels (organization_id,node_id,tunnel_id,hostname,state,credential_reference,revision) VALUES
        ('org-a','node-a','tunnel-a','a.example.com','connected','ref-a',1),
        ('org-b','node-b','tunnel-b','b.example.com','connected','ref-b',1);
      INSERT INTO node_credentials
        (organization_id,node_id,id,credential_hash,version,status,issued_at,last_used_at) VALUES
        ('org-a','node-a','credential-a','machine-credential-hash',1,'active','${timestamp}','${timestamp}');
      INSERT INTO agent_sessions
        (organization_id,node_id,credential_id,session_version,agent_version,session_state,last_seen_at,revision) VALUES
        ('org-a','node-a','credential-a',1,'0.1.0','connected','${timestamp}',1);
    `)
    for (const [organizationId, nodeId] of [
      ['org-a', 'node-a'],
      ['org-b', 'node-b'],
    ] as const) {
      const pair = await Effect.runPromise(generateTunnelCredentialNodeKeyPair())
      const validated = await Effect.runPromise(validateInstallerPublicKey(pair.publicKey))
      database
        .prepare(`INSERT INTO node_installer_keys
        (organization_id,node_id,public_key,public_key_fingerprint,status,revision,registered_at)
        VALUES (?,?,?,?, 'active',1,?)`)
        .run(organizationId, nodeId, validated.publicKey, validated.fingerprint, timestamp)
    }
    const accessPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    accessPrivateKey = accessPair.privateKey
    const accessJwk = await crypto.subtle.exportKey('jwk', accessPair.publicKey)
    const signingPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const signingPem = pem(await crypto.subtle.exportKey('pkcs8', signingPair.privateKey))
    cloudflareRequests = []
    remoteNameMismatch = false
    failAfterTunnelAcceptanceCommitOnce = false
    coordinatorEnqueue = vi.fn(async () => ({ sequence: 1, replayed: false }))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (url.includes('cdn-cgi/access/certs')) {
        return Response.json({
          keys: [{ ...accessJwk, kid: 'tunnel-test-key', alg: 'RS256', use: 'sig' }],
        })
      }
      cloudflareRequests.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? init.body : null,
      })
      if (url.endsWith('/token')) return Response.json({ success: true, result: tokenCanary })
      if ((init?.method ?? 'GET') === 'GET') {
        const tunnelId = url.split('/').at(-1)
        const organizationId = tunnelId === 'tunnel-a' ? 'org-a' : 'org-b'
        const nodeId = tunnelId === 'tunnel-a' ? 'node-a' : 'node-b'
        return Response.json({
          success: true,
          result: {
            id: tunnelId,
            config_src: 'cloudflare',
            name: remoteNameMismatch
              ? 'human-managed'
              : `gridora:${organizationId}:${nodeId}:Node tunnel`,
          },
        })
      }
      return Response.json({ success: true, result: {} })
    })
    const db = {
      prepare: (sql: string) => new Statement(database, sql),
      batch: async (statements: ReadonlyArray<Statement>) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const results = statements.map((statement) => statement.runSync())
          database.exec('COMMIT')
          if (
            failAfterTunnelAcceptanceCommitOnce &&
            statements.some((statement) =>
              statement.sql.includes('INSERT INTO tunnel_credential_deliveries'),
            )
          ) {
            failAfterTunnelAcceptanceCommitOnce = false
            throw new Error('simulated D1 response loss after committed tunnel acceptance')
          }
          return results
        } catch (cause) {
          if (database.isTransaction) database.exec('ROLLBACK')
          throw cause
        }
      },
    }
    env = {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'test-invitation-secret-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: { get: async () => base64Url(new Uint8Array(32).fill(1)) },
      PROVIDER_BYOP_ENABLED: 'true',
      REGISTRATION_MODE: 'invitation-only',
      DB: db,
      CLOUDFLARE_ACCOUNT_ID: 'account-a',
      CLOUDFLARE_TUNNEL_API_TOKEN: { get: async () => 'cloudflare-api-token-with-required-length' },
      AGENT_COMMAND_SIGNING_KEY: { get: async () => signingPem },
      OUTBOX_WAKEUPS: { send: async () => undefined },
      INTERNAL_SERVICE_SECRET: 'internal-service-secret-with-at-least-32-bytes',
      INTERNAL_REPLAY_GUARD: { getByName: () => ({ claim: async () => true }) },
      NODE_COORDINATOR: { getByName: () => ({ enqueue: coordinatorEnqueue }) },
    } as unknown as ApiBindings
  }, 30_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  it('authorizes Owner/Admin, denies lower and foreign roles, and adopts exact replays', async () => {
    const body = { action: 'install', expectedPriorRevision: 0 }
    const injectedOperation = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'injected-operation',
      {
        ...body,
        operationId: 'client-chosen-operation',
      },
    )
    expect(injectedOperation.status).toBe(400)
    const denied = await deliver(
      'operator-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'operator-key',
      body,
    )
    expect(denied.status).toBe(403)
    const foreign = await deliver(
      'owner-a',
      'organization-b',
      'node-b',
      'tunnel-b',
      'foreign-key',
      body,
    )
    expect(foreign.status).toBe(403)
    expect(cloudflareRequests).toHaveLength(0)

    failAfterTunnelAcceptanceCommitOnce = true
    const first = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'install-key',
      body,
    )
    expect(first.status, await first.clone().text()).toBe(202)
    const created = (await first.json()) as Record<string, unknown>
    expect(created).toMatchObject({ action: 'install', revision: 1, state: 'queued' })
    const requestCount = cloudflareRequests.length
    const replay = await deliver(
      'admin-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'install-key',
      body,
    )
    expect(replay.status).toBe(409)
    const exactReplay = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'install-key',
      body,
    )
    expect(exactReplay.status).toBe(202)
    await expect(exactReplay.json()).resolves.toEqual(created)
    expect(cloudflareRequests).toHaveLength(requestCount)
    const changed = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'install-key',
      {
        action: 'rotate',
        expectedPriorRevision: 1,
      },
    )
    expect(changed.status).toBe(409)
    expect(cloudflareRequests).toHaveLength(requestCount)
  }, 30_000)

  it('rotates and revokes with revision fencing and never persists plaintext', async () => {
    const install = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'install-key',
      {
        action: 'install',
        expectedPriorRevision: 0,
      },
    )
    expect(install.status, await install.clone().text()).toBe(202)
    const first = (await install.json()) as { deliveryId: string; operationId: string }
    const firstCommandRow = database
      .prepare(
        'SELECT command_json AS commandJson FROM tunnel_credential_deliveries WHERE delivery_id = ?',
      )
      .get(first.deliveryId) as { commandJson: string }
    const firstCommand = await Effect.runPromise(
      decodeTunnelCredentialAgentCommand(JSON.parse(firstCommandRow.commandJson)),
    )
    await expect(
      Effect.runPromise(
        markTunnelCommandDelivered(env.DB, 'org-a', firstCommand, '2026-08-23T12:00:30Z'),
      ),
    ).resolves.toBe('applied')
    await expect(
      Effect.runPromise(
        markTunnelCommandDelivered(env.DB, 'org-a', firstCommand, '2026-08-23T12:00:31Z'),
      ),
    ).resolves.toBe('replayed')
    await expect(
      acknowledgeTunnel(first, 1, 'tunnel-active', '2026-08-23T12:01:00Z'),
    ).resolves.toMatchObject({ operationId: first.operationId, result: 'succeeded' })

    const rotate = await deliver('admin-a', 'organization-a', 'node-a', 'tunnel-a', 'rotate-key', {
      action: 'rotate',
      expectedPriorRevision: 1,
    })
    expect(rotate.status, await rotate.clone().text()).toBe(202)
    const second = (await rotate.json()) as { deliveryId: string; operationId: string }
    const secondCommandRow = database
      .prepare(
        'SELECT command_json AS commandJson FROM tunnel_credential_deliveries WHERE delivery_id = ?',
      )
      .get(second.deliveryId) as { commandJson: string }
    const secondCommand = await Effect.runPromise(
      decodeTunnelCredentialAgentCommand(JSON.parse(secondCommandRow.commandJson)),
    )
    await expect(
      Effect.runPromise(
        markTunnelCommandDelivered(env.DB, 'org-a', secondCommand, '2026-08-23T12:01:30Z'),
      ),
    ).resolves.toBe('applied')
    await expect(
      acknowledgeTunnel(second, 2, 'tunnel-active', '2026-08-23T12:02:00Z'),
    ).resolves.toMatchObject({ operationId: second.operationId, result: 'succeeded' })

    const revoke = await deliver('owner-a', 'organization-a', 'node-a', 'tunnel-a', 'revoke-key', {
      action: 'revoke',
      expectedPriorRevision: 2,
    })
    expect(revoke.status, await revoke.clone().text()).toBe(202)
    const third = (await revoke.json()) as { deliveryId: string; operationId: string }
    const thirdCommandRow = database
      .prepare(
        'SELECT command_json AS commandJson FROM tunnel_credential_deliveries WHERE delivery_id = ?',
      )
      .get(third.deliveryId) as { commandJson: string }
    const thirdCommand = await Effect.runPromise(
      decodeTunnelCredentialAgentCommand(JSON.parse(thirdCommandRow.commandJson)),
    )
    await expect(
      Effect.runPromise(
        markTunnelCommandDelivered(env.DB, 'org-a', thirdCommand, '2026-08-23T12:02:30Z'),
      ),
    ).resolves.toBe('applied')
    await expect(
      acknowledgeTunnel(third, 3, 'tunnel-revoked', '2026-08-23T12:03:00Z'),
    ).resolves.toMatchObject({ operationId: third.operationId, result: 'succeeded' })
    expect(cloudflareRequests.some((request) => request.method === 'PATCH')).toBe(true)
    expect(
      cloudflareRequests.some(
        (request) => request.method === 'DELETE' && request.url.endsWith('/connections'),
      ),
    ).toBe(true)
    const stored = database
      .prepare(`SELECT group_concat(value, '') AS content FROM (
      SELECT coalesce(command_json, '') AS value FROM tunnel_credential_deliveries
      UNION ALL SELECT payload_json FROM outbox
      UNION ALL SELECT summary_json FROM audit_events
    )`)
      .get() as { content: string }
    expect(stored.content).not.toContain(tokenCanary)
    expect(stored.content).toContain('sealedCredential')
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action LIKE 'tunnel.credential.%'",
        )
        .get(),
    ).toEqual({ count: 3 })
    expect(
      database
        .prepare("SELECT count(*) AS count FROM outbox WHERE event_type = 'agent.command.sealed'")
        .get(),
    ).toEqual({ count: 3 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM operations WHERE resource_type = 'tunnel' AND status = 'succeeded'",
        )
        .get(),
    ).toEqual({ count: 9 })
    expect(
      database
        .prepare('SELECT state FROM tunnel_credential_deliveries WHERE delivery_id = ?')
        .get(third.deliveryId),
    ).toEqual({ state: 'revoked' })
  }, 30_000)

  it('fails closed before remote access when secret bindings are unavailable', async () => {
    env.CLOUDFLARE_TUNNEL_API_TOKEN = {
      get: async () => {
        throw new Error('missing')
      },
    }
    const response = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'missing-secret',
      {
        action: 'install',
        expectedPriorRevision: 0,
      },
    )
    expect(response.status).toBe(503)
    expect(cloudflareRequests).toHaveLength(0)
    expect(database.prepare('SELECT state FROM tunnel_credential_deliveries').get()).toEqual({
      state: 'issuing',
    })
    expect(
      database
        .prepare("SELECT status FROM operations WHERE type = 'tunnel.credential.install'")
        .get(),
    ).toEqual({
      status: 'waiting_external',
    })
    env.CLOUDFLARE_TUNNEL_API_TOKEN = {
      get: async () => 'cloudflare-api-token-with-required-length',
    }
    const retried = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'missing-secret',
      {
        action: 'install',
        expectedPriorRevision: 0,
      },
    )
    expect(retried.status, await retried.clone().text()).toBe(202)
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 2 })
    expect(database.prepare('SELECT state FROM tunnel_credential_deliveries').get()).toEqual({
      state: 'queued',
    })
  }, 30_000)

  it('rejects a remote Tunnel whose canonical Gridora ownership name does not match', async () => {
    remoteNameMismatch = true
    const response = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'ownership-mismatch',
      {
        action: 'install',
        expectedPriorRevision: 0,
      },
    )
    expect(response.status).toBe(503)
    expect(cloudflareRequests.some((request) => request.url.endsWith('/token'))).toBe(false)
    expect(
      database
        .prepare("SELECT status FROM operations WHERE type = 'tunnel.credential.install'")
        .get(),
    ).toEqual({
      status: 'waiting_external',
    })
  }, 30_000)

  it('fails closed when persisted installer public-key metadata does not match', async () => {
    database
      .prepare(
        "UPDATE node_installer_keys SET public_key_fingerprint = ? WHERE organization_id = 'org-a' AND node_id = 'node-a'",
      )
      .run(`sha256:${'f'.repeat(64)}`)
    const response = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'key-mismatch',
      {
        action: 'install',
        expectedPriorRevision: 0,
      },
    )
    expect(response.status).toBe(503)
    expect(cloudflareRequests).toHaveLength(0)
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 0 })
  }, 30_000)

  it('reloads the authoritative sealed command before retry-safe coordinator delivery', async () => {
    const created = await deliver(
      'owner-a',
      'organization-a',
      'node-a',
      'tunnel-a',
      'queue-delivery',
      {
        action: 'install',
        expectedPriorRevision: 0,
      },
    )
    expect(created.status, await created.clone().text()).toBe(202)
    const reservation = (await created.json()) as { deliveryId: string }
    const row = database
      .prepare(`SELECT id, organization_id AS organizationId, aggregate_type AS aggregateType,
      aggregate_id AS aggregateId, event_type AS eventType, payload_json AS payload, created_at AS createdAt
      FROM outbox WHERE event_type = 'agent.command.sealed'`)
      .get() as Record<string, string>
    const event = {
      id: String(row.id),
      organizationId: String(row.organizationId),
      partitionKey: `${String(row.organizationId)}:${String(row.aggregateType)}:${String(row.aggregateId)}`,
      type: String(row.eventType),
      occurredAt: String(row.createdAt),
      payload: JSON.parse(String(row.payload)),
    }
    const send = async (payload: typeof event, nonce: string) => {
      const body = JSON.stringify(payload)
      const routing = {
        method: 'POST',
        path: '/v1/internal/queue-events',
        queue: 'gridora-outbox',
        organizationId: payload.organizationId,
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
    const applied = await send(event, 'tunnel-queue-1')
    expect(applied.status, await applied.clone().text()).toBe(200)
    await expect(applied.json()).resolves.toMatchObject({
      status: 'applied',
      commandId: reservation.deliveryId,
    })
    const replayed = await send(event, 'tunnel-queue-2')
    expect(replayed.status).toBe(200)
    await expect(replayed.json()).resolves.toMatchObject({ status: 'replayed' })
    expect(database.prepare('SELECT state FROM tunnel_credential_deliveries').get()).toEqual({
      state: 'delivered',
    })
    expect(database.prepare('SELECT status FROM operations').get()).toEqual({ status: 'running' })

    const tampered = structuredClone(event)
    tampered.payload.operationId = 'operation-foreign'
    const rejected = await send(tampered, 'tunnel-queue-3')
    expect(rejected.status).toBe(400)
    expect(coordinatorEnqueue).toHaveBeenCalledTimes(2)
  }, 30_000)
})

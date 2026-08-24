/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateTunnelCredentialNodeKeyPair } from '@gridora/tunnel-credential'
import { app, type ApiBindings } from '../src/index.js'

const migrationsDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

class Statement {
  private values: ReadonlyArray<unknown> = []

  constructor(
    readonly database: DatabaseSync,
    readonly statement: StatementSync,
    readonly sql: string,
  ) {}

  bind(...values: ReadonlyArray<unknown>): Statement {
    const bound = new Statement(this.database, this.statement, this.sql)
    bound.values = values
    return bound
  }

  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }

  async all(): Promise<{
    readonly results: ReadonlyArray<unknown>
    readonly meta: { changes: number }
  }> {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    const changes = this.database.prepare('SELECT changes() AS changes').get() as {
      changes: number
    }
    return { results, meta: { changes: changes.changes } }
  }

  async run(): Promise<{ readonly success: true; readonly meta: { changes: number } }> {
    const result = this.statement.run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 {
  /** Simulates a D1 acknowledgement loss only after a strict machine batch commits. */
  failAfterMachineAuditCommitOnce = false

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, this.database.prepare(sql), sql)
  }

  async batch(statements: ReadonlyArray<Statement>): Promise<ReadonlyArray<unknown>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement.all())
      this.database.exec('COMMIT')
      if (
        this.failAfterMachineAuditCommitOnce &&
        statements.some((statement) => statement.sql.includes('agent_machine_audit_receipts'))
      ) {
        this.failAfterMachineAuditCommitOnce = false
        throw new Error('simulated D1 response loss after a committed machine audit batch')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const sha256 = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

const imageChecksum = `sha256:${'a'.repeat(64)}`
const buildIdentityManifestSha256 = `sha256:${'b'.repeat(64)}`
const buildIdentitySignatureSha256 = `sha256:${'c'.repeat(64)}`
const buildIdentityPublicKeySha256 = `sha256:${'d'.repeat(64)}`
const imageSignature = JSON.stringify({
  schemaVersion: 1,
  algorithm: 'ed25519',
  buildIdentityManifestSha256,
  buildIdentitySignatureSha256,
  buildIdentityPublicKeySha256,
})
const existingCredential = `agent-bearer-${'a'.repeat(56)}`
const revokeToken = `registration-revoke-${'b'.repeat(48)}`
const exchangeToken = `registration-exchange-${'c'.repeat(46)}`

describe('agent machine audit HTTP composition', () => {
  let database: DatabaseSync
  let d1: SqliteD1
  let env: ApiBindings
  let now: string
  let commandResultCalls: number
  let coordinatorInitialize: ReturnType<typeof vi.fn>

  const machineRequest = (path: string, init: RequestInit = {}) =>
    app.request(
      `https://api.gridora.test${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          'cf-connecting-ip': '198.51.100.24',
        },
      },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

  const seed = async () => {
    const [existingCredentialHash, revokeTokenHash, exchangeTokenHash] = await Promise.all([
      sha256(existingCredential),
      sha256(revokeToken),
      sha256(exchangeToken),
    ])
    const command = JSON.stringify({
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: 'command-a',
      operationId: 'operation-command-a',
      organizationId: 'org-a',
      nodeId: 'node-a',
      resourceId: 'server-a',
      type: 'server.start',
      payloadSchemaVersion: 1,
      issuedAt: now,
      expiresAt: '2099-08-24T15:00:00.000Z',
      idempotencyKey: 'command-command-a',
      expectedPriorRevision: null,
      payload: {},
      signature: 'signature-not-verified-by-machine-route-test',
    })

    database.exec(`
      INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('actor-a', 'access-a', 'a@example.test', 'A', 'active', '${now}', '${now}');
      INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision,
         revision, created_at)
        VALUES ('org-a', 'Org A', 'org-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, '${now}');
      INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, revision)
        VALUES ('org-a', 'actor-a', 'owner', 'active', '${now}', 1);
      INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at,
         updated_at)
        VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'envelope-a', 'active', 1,
          '${now}', '${now}');
      INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
         max_active_nodes, status, revision)
        VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1);
      INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
        VALUES ('image-a', '1.0.0', '${imageChecksum}', '${imageSignature}',
          '{"ovhcloud":{"eu-west":"provider-image-a"}}', 'promoted', '${now}', '${now}');
      INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan,
         image_id, placement_mode, desired_state, observed_state, desired_revision, observed_revision,
         created_at, updated_at)
        VALUES
          ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small', 'image-a',
           'shared', 'ready', 'unknown', 1, 0, '${now}', '${now}'),
          ('org-a', 'node-registration', 'provider-a', 'instance-registration', 'ovhcloud', 'eu-west',
           'small', 'image-a', 'shared', 'provisioning', 'unknown', 1, 0, '${now}', '${now}');
      INSERT INTO tunnels
        (organization_id, node_id, tunnel_id, hostname, state, credential_reference, revision)
        VALUES ('org-a', 'node-a', 'tunnel-a', 'node-a.example.test', 'connected',
          'tunnel-envelope-a', 1);
      INSERT INTO node_credentials
        (organization_id, node_id, id, credential_hash, version, status, issued_at, last_used_at)
        VALUES ('org-a', 'node-a', 'credential-a', '${existingCredentialHash}', 1, 'active', '${now}',
          '${now}');
      INSERT INTO agent_sessions
        (organization_id, node_id, credential_id, session_version, agent_version, session_state,
         last_seen_at, revision)
        VALUES ('org-a', 'node-a', 'credential-a', 1, '0.1.0', 'connected', '${now}', 1);
      INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES
          ('operation-node-a', 'org-a', 'provision-node', 'node', 'node-a', 'actor-a',
           'waiting_external', 50, 'node-a-registration', 'node-a-correlation', 1, '${now}', '${now}'),
          ('operation-registration', 'org-a', 'provision-node', 'node', 'node-registration', 'actor-a',
           'waiting_external', 50, 'registration-exchange', 'registration-correlation', 1, '${now}', '${now}'),
          ('operation-command-a', 'org-a', 'server.start', 'server', 'server-a', 'actor-a', 'running', 60,
           'command-a', 'command-correlation-a', 1, '${now}', '${now}'),
          ('operation-ports-a', 'org-a', 'allocate-ports', 'server', 'server-a', 'actor-a', 'succeeded',
           100, 'ports-a', 'ports-correlation-a', 1, '${now}', '${now}');
      INSERT INTO node_registration_tokens
        (token_hash, organization_id, node_id, provider_instance_id, operation_id, credential_id,
         expires_at, consumed_at, revoked_at, issued_at)
        VALUES
          ('${revokeTokenHash}', 'org-a', 'node-a', 'instance-a', 'operation-node-a', 'credential-a',
           '2099-08-24T15:00:00.000Z', '${now}', NULL, '${now}'),
          ('${exchangeTokenHash}', 'org-a', 'node-registration', 'instance-registration',
           'operation-registration', NULL, '2099-08-24T15:00:00.000Z', NULL, NULL, '${now}');
      INSERT INTO game_plugins
        (id, version, api_version, status, capability_manifest_json, config_schema_version)
        VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
      INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at,
         updated_at)
        VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running', 'running', '{}',
          1, 1, 1, '${now}', '${now}');
      INSERT INTO port_leases
        (organization_id, id, node_id, server_id, protocol, public_port, container_port, state,
         operation_id, revision, created_at)
        VALUES
          ('org-a', 'port-tcp-22', 'node-a', 'server-a', 'tcp', 22, 22, 'active', 'operation-ports-a', 1,
           '${now}'),
          ('org-a', 'port-udp-2001', 'node-a', 'server-a', 'udp', 2001, 2001, 'active',
           'operation-ports-a', 1, '${now}');
      INSERT INTO game_command_deliveries
        (organization_id, operation_id, command_id, step_name, command_fingerprint, state, result_json,
         attempts, created_at, updated_at, command_json)
        VALUES ('org-a', 'operation-command-a', 'command-a', 'start', '${'f'.repeat(64)}', 'delivered',
          NULL, 1, '${now}', '${now}', '${command.replaceAll("'", "''")}');
    `)
  }

  const observation = () => ({
    apiVersion: 'agent.gridora.dev/v1alpha1',
    organizationId: 'org-a',
    nodeId: 'node-a',
    sessionVersion: 1,
    sequence: 1,
    observedRevision: 1,
    issuedAt: new Date().toISOString(),
    facts: {
      agent: { version: '0.1.0', ready: true },
      image: {
        imageId: 'image-a',
        imageVersion: '1.0.0',
        checksum: imageChecksum,
        signatureVerified: true,
        buildIdentityManifestSha256,
        buildIdentitySignatureSha256,
        buildIdentityPublicKeySha256,
        ready: true,
      },
      tunnel: { state: 'connected', ready: true },
      docker: {
        engineVersion: '28.0.0',
        storageDriver: 'overlay2',
        projectQuotaReady: true,
        privilegedContainers: 0,
        dockerSocketMounted: false,
        ready: true,
      },
      firewall: { defaultDeny: true, allowedTcpPorts: [22], allowedUdpPorts: [2001], ready: true },
      capacity: {
        architecture: 'amd64',
        cpuMillis: 4000,
        ramBytes: 8000,
        diskBytes: 16000,
        cpuUsedMillis: 100,
        ramUsedBytes: 1000,
        diskUsedBytes: 2000,
      },
      metrics: {
        loadPermille: 100,
        networkReceiveBytes: 10,
        networkTransmitBytes: 20,
        containerRestarts: 0,
      },
    },
  })

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles)
      database.exec(readFileSync(`${migrationsDirectory}${file}`, 'utf8'))
    now = new Date().toISOString()
    d1 = new SqliteD1(database)
    commandResultCalls = 0
    coordinatorInitialize = vi.fn(async () => undefined)
    env = {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'gridora-api',
      INVITATION_TOKEN_SECRET: 'test-invitation-secret-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: {
        get: async () => btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
      },
      REGISTRATION_MODE: 'invitation-only',
      NODE_CREDENTIAL_SECRET: 'node-credential-secret-at-least-thirty-two-bytes',
      DB: d1,
      NODE_COORDINATOR: {
        getByName: () => ({
          initialize: coordinatorInitialize,
          acceptCommandResult: async () => {
            commandResultCalls += 1
            return commandResultCalls === 1
              ? { accepted: true, replayed: false, lastSequence: 1 }
              : { accepted: false, replayed: true, lastSequence: 1 }
          },
        }),
      },
    } as unknown as ApiBindings
    await seed()
  }, 30_000)

  afterEach(() => database.close())

  it('exchanges a registration through the strict machine receipt and adopts a post-commit response loss', async () => {
    const installer = await Effect.runPromise(generateTunnelCredentialNodeKeyPair())
    const body = {
      organizationId: 'org-a',
      nodeId: 'node-registration',
      providerInstanceId: 'instance-registration',
      agentVersion: '0.1.0',
      installerPublicKey: installer.publicKey,
      registrationToken: exchangeToken,
    }
    d1.failAfterMachineAuditCommitOnce = true

    const first = await machineRequest('/v1/agent/registrations/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'machine-exchange-request',
        'x-correlation-id': 'machine-exchange-correlation',
      },
      body: JSON.stringify(body),
    })
    expect(first.status, await first.clone().text()).toBe(200)
    const firstBody = (await first.json()) as {
      readonly nodeCredential: string
      readonly credentialId: string
    }
    expect(firstBody).toMatchObject({ credentialId: expect.stringMatching(/^credential_/) })
    expect(firstBody.nodeCredential).toMatch(/^[a-f0-9]{64}$/)

    const replay = await machineRequest('/v1/agent/registrations/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(replay.status, await replay.clone().text()).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ credentialId: firstBody.credentialId })
    expect(coordinatorInitialize).toHaveBeenCalledTimes(2)

    expect(
      database
        .prepare(`SELECT count(*) AS count FROM agent_machine_audit_receipts
          WHERE organization_id = 'org-a' AND kind = 'registration-exchange'`)
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT operation.status AS operationStatus,
          json_extract(envelope.envelope_json, '$.source.origin') AS origin,
          json_extract(envelope.envelope_json, '$.source.ip.value') AS sourceIp,
          json_extract(envelope.envelope_json, '$.source.access.state') AS accessState,
          json_extract(envelope.envelope_json, '$.request.id') AS requestId,
          json_extract(envelope.envelope_json, '$.request.correlationId') AS correlationId
          FROM agent_machine_audit_receipts receipt
          JOIN operations operation ON operation.organization_id = receipt.organization_id
            AND operation.id = receipt.operation_id
          JOIN audit_event_envelopes envelope ON envelope.organization_id = receipt.organization_id
            AND envelope.event_id = receipt.audit_event_id
          WHERE receipt.organization_id = 'org-a' AND receipt.kind = 'registration-exchange'`)
        .get(),
    ).toEqual({
      operationStatus: 'succeeded',
      origin: 'machine',
      sourceIp: '198.51.100.24',
      accessState: 'not-available',
      requestId: 'machine-exchange-request',
      correlationId: 'machine-exchange-correlation',
    })
  }, 30_000)

  it('uses strict request-scoped machine repositories for command results, observations, and revocation', async () => {
    const authorization = `Bearer ${existingCredential}`
    const commandResult = {
      commandId: 'command-a',
      operationId: 'operation-command-a',
      status: 'succeeded',
      revision: 1,
      code: 'completed',
      message: 'provider output that must never become audit evidence',
      duplicate: false,
      completedAt: new Date().toISOString(),
    }

    d1.failAfterMachineAuditCommitOnce = true
    const command = await machineRequest('/v1/agent/nodes/node-a/commands/command-a/result', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(commandResult),
    })
    expect(command.status, await command.clone().text()).toBe(200)
    await expect(command.json()).resolves.toEqual({
      accepted: true,
      duplicate: false,
      watermark: 1,
    })
    const commandReplay = await machineRequest('/v1/agent/nodes/node-a/commands/command-a/result', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(commandResult),
    })
    expect(commandReplay.status).toBe(200)
    await expect(commandReplay.json()).resolves.toEqual({
      accepted: false,
      duplicate: true,
      watermark: 1,
    })
    expect(
      database
        .prepare(`SELECT state, json_extract(result_json, '$.message') AS message
          FROM game_command_deliveries WHERE command_id = 'command-a'`)
        .get(),
    ).toEqual({ state: 'completed', message: '[REDACTED]' })

    // This fixture has no accepted provisioning record. A real agent may report
    // all component facts while its desired lifecycle is still provisioning; the
    // observation must persist as bootstrapping rather than invent ready capacity.
    database
      .prepare(
        "UPDATE nodes SET desired_state = 'provisioning' WHERE organization_id = 'org-a' AND id = 'node-a'",
      )
      .run()
    const observationPayload = observation()
    d1.failAfterMachineAuditCommitOnce = true
    const observed = await machineRequest('/v1/agent/events', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(observationPayload),
    })
    expect(observed.status, await observed.clone().text()).toBe(200)
    await expect(observed.json()).resolves.toMatchObject({
      organizationId: 'org-a',
      nodeId: 'node-a',
      observedState: 'bootstrapping',
      capacityPublished: false,
    })
    const observedReplay = await machineRequest('/v1/agent/events', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(observationPayload),
    })
    // A response-loss retry must use the exact observation fingerprint and is
    // adopted from the immutable machine receipt.
    expect(observedReplay.status, await observedReplay.clone().text()).toBe(200)
    await expect(observedReplay.json()).resolves.toMatchObject({
      observedState: 'bootstrapping',
      capacityPublished: false,
    })

    d1.failAfterMachineAuditCommitOnce = true
    const revoked = await machineRequest('/v1/agent/registrations/revoke', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org-a',
        nodeId: 'node-a',
        registrationToken: revokeToken,
      }),
    })
    expect(revoked.status, await revoked.clone().text()).toBe(204)
    const revokeReplay = await machineRequest('/v1/agent/registrations/revoke', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org-a',
        nodeId: 'node-a',
        registrationToken: revokeToken,
      }),
    })
    expect(revokeReplay.status, await revokeReplay.clone().text()).toBe(204)

    expect(
      database
        .prepare(`SELECT count(*) AS count FROM agent_machine_audit_receipts
          WHERE organization_id = 'org-a' AND kind IN ('command-result', 'observation', 'registration-revoke')`)
        .get(),
    ).toEqual({ count: 3 })
    expect(
      database
        .prepare(`SELECT json_extract(envelope.envelope_json, '$.source.origin') AS origin,
          json_extract(envelope.envelope_json, '$.source.access.state') AS accessState
          FROM agent_machine_audit_receipts receipt
          JOIN audit_event_envelopes envelope ON envelope.organization_id = receipt.organization_id
            AND envelope.event_id = receipt.audit_event_id
          WHERE receipt.organization_id = 'org-a' AND receipt.kind = 'command-result'`)
        .get(),
    ).toEqual({ origin: 'machine', accessState: 'not-available' })
    expect(
      database
        .prepare(`SELECT revoked_at IS NOT NULL AS revoked, machine_revocation_operation_id IS NOT NULL AS audited
          FROM node_registration_tokens WHERE organization_id = 'org-a' AND node_id = 'node-a'`)
        .get(),
    ).toEqual({ revoked: 1, audited: 1 })
  }, 30_000)
})

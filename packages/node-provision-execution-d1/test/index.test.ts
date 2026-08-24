import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeHmacRegistrationTokenSecret,
  makeWebCryptoNodeProvisionIdentity,
  nodeProvisionPolicyAdmission,
  type CreateNodeIntent,
  type NodeProvisionAtomicInput,
  type NodeProvisionCommand,
  type NodeProvisionExecutionReservation,
} from '@gridora/node-provision-control'
import {
  makeNodeProvisionExecutionReservationD1,
  makeNodeProvisionFactsD1,
  makeNodeProvisionRepositoryD1,
  type NodeProvisionD1Database,
  type NodeProvisionD1Result,
  type NodeProvisionD1Statement,
} from '@gridora/node-provision-d1'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import type { AuthoritativeProviderAccount } from '@gridora/provider-runtime'
import type { ProviderNode } from '@gridora/provider-sdk'
import {
  makeNodeProvisionExecutionRepositoryD1,
  makeProvisionalNodeRegistrationExchangeD1,
  makeProvisionalNodeRegistrationBindingD1,
  type NodeProvisionExecutionD1Database,
  type NodeProvisionExecutionD1Result,
  type NodeProvisionExecutionD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
// Exercise the strict audit triggers as deployed, not the historical 0001-0025
// subset that masked post-provider-call audit failures.
const migrationFiles = readdirSync(sqlDirectory)
  .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
  .sort()

class SqliteStatement implements NodeProvisionD1Statement, NodeProvisionExecutionD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(
    readonly database: DatabaseSync,
    readonly statement: StatementSync,
  ) {}
  bind(...values: ReadonlyArray<unknown>): SqliteStatement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<NodeProvisionD1Result & NodeProvisionExecutionD1Result> {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    const changes = Number(
      (this.database.prepare('SELECT changes() AS changes').get() as { changes: number }).changes,
    )
    return { success: true, results, meta: { changes } }
  }
}

class SqliteD1 implements NodeProvisionD1Database, NodeProvisionExecutionD1Database {
  private serial: Promise<void> = Promise.resolve()
  failBatchStatement: number | undefined
  loseBatchResponse = false
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<SqliteStatement>,
  ): Promise<ReadonlyArray<NodeProvisionD1Result & NodeProvisionExecutionD1Result>> {
    const prior = this.serial
    let release!: () => void
    this.serial = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const results: Array<NodeProvisionD1Result & NodeProvisionExecutionD1Result> = []
      for (const [index, statement] of statements.entries()) {
        if (this.failBatchStatement === index) throw new Error('injected transaction failure')
        await statement.all()
        const changes = Number(
          (this.database.prepare('SELECT changes() AS changes').get() as { changes: number })
            .changes,
        )
        results.push({ success: true, results: [], meta: { changes } })
      }
      this.database.exec('COMMIT')
      if (this.loseBatchResponse) {
        this.loseBatchResponse = false
        throw new Error('injected response loss after commit')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.failBatchStatement = undefined
      release()
    }
  }
}

const acceptedAt = '2026-08-23T10:00:00.000Z'
const executeAt = '2026-08-23T10:05:00.000Z'
const bootstrapExpiresAt = '2026-08-23T11:05:00.000Z'
const nowEpoch = Date.parse(acceptedAt)
const intent: CreateNodeIntent = {
  schemaVersion: 1,
  placementMode: 'shared',
  temporaryLifetimeHours: null,
  nonHourlyCommitmentConfirmed: true,
}
const policy = (organizationId: string): OrganizationPolicyV1 => ({
  schemaVersion: 1,
  organizationId,
  revision: 1,
  allowedProviders: ['ovhcloud', 'contabo'],
  allowedRegions: ['region-a'],
  allowedPlans: ['plan-a'],
  capacity: {
    maxActiveNodes: 4,
    maxDedicatedNodes: 2,
    maxServersPerNode: 8,
    maxDeploymentCpuMillis: 8_000,
    maxDeploymentRamBytes: 16_000,
    maxDeploymentDiskBytes: 100_000,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 5_000,
    hardLimitMinor: 20_000,
  },
  temporaryNodes: { automaticExpiryRequired: false, maxLifetimeHours: 72 },
  idle: { action: 'none', afterMinutes: 60 },
  backups: { requiredBeforeDelete: true },
  maintenanceWindows: [],
  updates: { automatic: 'disabled', requireMaintenanceWindow: false },
  contabo: { maxContractMonths: 12 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
})

let database: DatabaseSync
let d1: SqliteD1
const identities = makeWebCryptoNodeProvisionIdentity()
const registrationTokens = makeHmacRegistrationTokenSecret({
  activeVersion: 2,
  keys: { 2: 'registration-token-key-material-with-at-least-32-bytes' },
})

const seed = (
  providerType: 'ovhcloud' | 'contabo' = 'ovhcloud',
  scope: 'organization' | 'platform' = 'organization',
) => {
  database
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('actor-a', 'access-a', 'actor@example.com', 'Actor', 'active', ?, ?)`)
    .run(acceptedAt, acceptedAt)
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES ('org-a', 'Org A', 'org-a', 'active', 'UTC', 'region-a', 'complete', 1, 1, ?)`)
    .run(acceptedAt)
  database
    .prepare(`INSERT INTO organization_memberships
      (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES ('org-a', 'actor-a', 'administrator', 'active', ?, NULL, 1)`)
    .run(acceptedAt)
  database
    .prepare(`INSERT INTO organization_policies
      (organization_id, policy_json, revision, updated_by, updated_at)
      VALUES ('org-a', ?, 1, 'actor-a', ?)`)
    .run(JSON.stringify(policy('org-a')), acceptedAt)
  database
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision,
       created_at, updated_at)
      VALUES ('account-a', ?, ?, ?, 'envelope-a', 'active', 3, ?, ?)`)
    .run(scope, scope === 'organization' ? 'org-a' : null, providerType, acceptedAt, acceptedAt)
  if (scope === 'organization')
    database
      .prepare(`INSERT INTO secret_envelopes
        (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
         key_version, revision, created_at, rotated_at)
        VALUES ('org-a', 'envelope-a', 'provider-account', 'account-a',
         'encrypted-canary', 'wrapped-canary', 1, 7, ?, NULL)`)
      .run(acceptedAt)
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, monthly_budget_minor, status, revision)
      VALUES ('org-a', 'account-a', '["region-a"]', '["plan-a"]', 4, 20000, 'active', 5)`)
    .run()
  const cadence = providerType === 'contabo' ? 'contract' : 'monthly'
  const months = providerType === 'contabo' ? 12 : 1
  const price = providerType === 'contabo' ? 1800 : 1500
  database
    .prepare(`INSERT INTO provider_catalog
      (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
       metadata_json, refreshed_at)
      VALUES (?, 'region-a', 'plan-a', 'EUR', NULL, ?, ?, ?)`)
    .run(
      providerType,
      price,
      JSON.stringify({
        schemaVersion: 1,
        billingCadence: cadence,
        contractMonths: months,
        validUntilEpochMilliseconds: nowEpoch + 86_400_000,
      }),
      acceptedAt,
    )
  database
    .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-a', '2026.08.23', ?, 'signature-a', ?, 'promoted', ?, ?)`)
    .run(
      `sha256:${'a'.repeat(64)}`,
      JSON.stringify({ [providerType]: { 'region-a': 'provider-image-a' } }),
      acceptedAt,
      acceptedAt,
    )
}

const command = (key = 'create-node-0001'): NodeProvisionCommand => ({
  organizationId: 'org-a',
  actorId: 'actor-a',
  actorRole: 'administrator',
  idempotencyKey: key,
  correlationId: `correlation-${key}`,
  intent,
})

const accept = async (
  providerType: 'ovhcloud' | 'contabo' = 'ovhcloud',
  scope: 'organization' | 'platform' = 'organization',
) => {
  seed(providerType, scope)
  const nextCommand = command()
  const facts = await Effect.runPromise(
    makeNodeProvisionFactsD1(d1, { nowEpochMilliseconds: () => nowEpoch }).resolve({
      organizationId: 'org-a',
      nodeId: 'pending',
      intent,
    }),
  )
  const fingerprint = await Effect.runPromise(identities.fingerprint(nextCommand))
  const identity = await Effect.runPromise(identities.derive(nextCommand, fingerprint))
  const billing = await Effect.runPromise(
    nodeProvisionPolicyAdmission.admit(intent, facts, nowEpoch),
  )
  const bootstrapToken = await Effect.runPromise(
    registrationTokens.hashFor({
      organizationId: 'org-a',
      nodeId: identity.nodeId,
      operationId: identity.operationId,
      tokenRecordId: identity.bootstrapTokenRecordId,
    }),
  )
  const input: NodeProvisionAtomicInput = {
    command: nextCommand,
    identity,
    fingerprint,
    facts,
    billing,
    bootstrapToken,
    now: acceptedAt,
  }
  await Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(input))
  const execution = await Effect.runPromise(
    makeNodeProvisionExecutionReservationD1(d1).load('org-a', identity.operationId),
  )
  return { input, execution, account: account(providerType, scope) }
}

const account = (
  providerType: 'ovhcloud' | 'contabo',
  scope: 'organization' | 'platform' = 'organization',
): AuthoritativeProviderAccount => ({
  id: 'account-a',
  providerType,
  scope,
  organizationId: scope === 'organization' ? 'org-a' : null,
  revision: 3,
  status: 'active',
})

const providerNode = (
  reservation: NodeProvisionExecutionReservation,
  overrides: Partial<ProviderNode> = {},
): ProviderNode => ({
  id: `${reservation.providerType}-instance-a`,
  name: `gridora-${reservation.nodeId}`,
  state: 'creating',
  regionId: reservation.region,
  planId: reservation.plan,
  addresses: ['203.0.113.10'],
  metadata: {
    managedBy: 'gridora',
    organizationId: reservation.organizationId,
    nodeId: reservation.nodeId,
    operationId: reservation.operationId,
    imageVersion: reservation.imageVersion,
  },
  ...overrides,
})

const begin = async (
  repository: ReturnType<typeof makeNodeProvisionExecutionRepositoryD1>,
  execution: NodeProvisionExecutionReservation,
  openedAccount: AuthoritativeProviderAccount,
  derivationTokenHash = execution.bootstrapToken.tokenHash,
) =>
  Effect.runPromise(
    repository.beginAttempt({
      reservation: execution,
      account: openedAccount,
      envelopeRevision: 7,
      derivationTokenHash,
      deliveredTokenHash: 'b'.repeat(64),
      bootstrapExpiresAt,
      attemptedAt: executeAt,
    }),
  )

const complete = (
  repository: ReturnType<typeof makeNodeProvisionExecutionRepositoryD1>,
  execution: NodeProvisionExecutionReservation,
  openedAccount: AuthoritativeProviderAccount,
) =>
  Effect.runPromise(
    repository.completeAtomic({
      reservation: execution,
      account: openedAccount,
      envelopeRevision: 7,
      providerNode: providerNode(execution),
      deliveredTokenHash: 'b'.repeat(64),
      completedAt: executeAt,
    }),
  )

const registrationExchangeInput = (
  execution: NodeProvisionExecutionReservation,
  overrides: Partial<{
    readonly organizationId: string
    readonly nodeId: string
    readonly deliveredTokenHash: string
    readonly providerInstanceId: string
    readonly credentialId: string
    readonly credentialHash: string
    readonly agentVersion: string
    readonly installerPublicKey: string
    readonly installerPublicKeyFingerprint: string
    readonly now: string
  }> = {},
) => ({
  organizationId: 'org-a',
  nodeId: execution.nodeId,
  deliveredTokenHash: 'b'.repeat(64),
  providerInstanceId: `${execution.providerType}-instance-a`,
  credentialId: 'credential-a',
  credentialHash: 'c'.repeat(64),
  agentVersion: '0.1.0',
  installerPublicKey: `rsa-oaep-spki-v1.${'A'.repeat(600)}`,
  installerPublicKeyFingerprint: `sha256:${'d'.repeat(64)}`,
  now: '2026-08-23T10:10:00.000Z',
  ...overrides,
})

const get = (sql: string): Record<string, unknown> =>
  database.prepare(sql).get() as Record<string, unknown>
const count = (table: string): number =>
  Number(
    (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
  )
const envelopeFor = (eventId: string): Record<string, unknown> => {
  const value = database
    .prepare(`SELECT envelope_json AS envelopeJson FROM audit_event_envelopes
      WHERE scope = 'tenant' AND event_id = ?`)
    .get(eventId) as { readonly envelopeJson?: unknown } | undefined
  if (typeof value?.envelopeJson !== 'string') throw new Error(`missing audit envelope ${eventId}`)
  return JSON.parse(value.envelopeJson) as Record<string, unknown>
}

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of migrationFiles)
    database.exec(readFileSync(`${sqlDirectory}/${migration}`, 'utf8'))
  d1 = new SqliteD1(database)
})

afterEach(() => database.close())

describe('node provision execution D1', () => {
  it('atomically records the owned provider result without claiming node readiness', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    expect(await begin(repository, accepted.execution, accepted.account)).toMatchObject({
      mode: 'create_or_adopt',
    })
    const result = await complete(repository, accepted.execution, accepted.account)
    expect(result).toMatchObject({
      disposition: 'completed',
      providerInstanceId: 'ovhcloud-instance-a',
      state: 'waiting-for-agent',
    })
    expect(
      get(`SELECT provider_instance_id AS providerInstanceId, desired_state AS desiredState,
      observed_state AS observedState, observed_revision AS observedRevision FROM nodes`),
    ).toEqual({
      providerInstanceId: 'ovhcloud-instance-a',
      desiredState: 'provisioning',
      observedState: 'provisioning',
      observedRevision: 0,
    })
    expect(
      get(`SELECT status, progress FROM operations WHERE type = 'provision-node'`),
    ).toMatchObject({
      status: 'waiting_external',
      progress: 50,
    })
    expect(
      get(`SELECT state, released_at AS releasedAt FROM node_provision_execution_leases`),
    ).toEqual({
      state: 'released',
      releasedAt: executeAt,
    })
    expect(
      get(`SELECT state, token_hash AS tokenHash, expires_at AS expiresAt
        FROM node_bootstrap_token_reservations`),
    ).toEqual({
      state: 'materialized',
      tokenHash: 'b'.repeat(64),
      expiresAt: bootstrapExpiresAt,
    })
    expect(get(`SELECT expires_at AS expiresAt FROM node_registration_tokens`)).toEqual({
      expiresAt: bootstrapExpiresAt,
    })
    expect(count('node_registration_tokens')).toBe(1)
    expect(
      get(`SELECT type, status, progress FROM operations
        WHERE id = '${accepted.execution.operationId}-audit-provider-created'`),
    ).toEqual({
      type: 'node.provision.provider-created',
      status: 'succeeded',
      progress: 100,
    })
    expect(envelopeFor(`audit_node_provider:${accepted.execution.operationId}`)).toMatchObject({
      version: 1,
      captureStatus: 'complete',
      actor: { type: 'human', id: 'actor-a' },
      action: 'node.provision.provider-created',
      target: { type: 'node', id: accepted.execution.nodeId },
      operationId: `${accepted.execution.operationId}-audit-provider-created`,
      result: 'succeeded',
      source: {
        origin: 'machine',
        ip: { state: 'not-available' },
        access: { state: 'not-available' },
      },
    })
  })

  it('adopts exact D1 completion after the commit response is lost', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    d1.loseBatchResponse = true
    const result = await complete(repository, accepted.execution, accepted.account)
    expect(result).toMatchObject({
      disposition: 'adopted',
      providerInstanceId: 'ovhcloud-instance-a',
    })
    expect(count('node_registration_tokens')).toBe(1)
    expect(count('node_provision_execution_leases')).toBe(1)
    expect(
      get(`SELECT provider_instance_id AS providerInstanceId, record_type AS recordType,
        target, source, observed_revision AS observedRevision, revision
        FROM node_player_endpoints`),
    ).toEqual({
      providerInstanceId: 'ovhcloud-instance-a',
      recordType: 'A',
      target: '203.0.113.10',
      source: 'provider',
      observedRevision: 1,
      revision: 1,
    })
    expect(
      Number(
        (
          database
            .prepare(`SELECT count(*) AS count FROM audit_events
              WHERE action = 'node.provision.provider-created'`)
            .get() as { count: number }
        ).count,
      ),
    ).toBe(1)
  })

  it('atomically records normalized provider player endpoints with the provider completion audit', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await Effect.runPromise(
      repository.completeAtomic({
        reservation: accepted.execution,
        account: accepted.account,
        envelopeRevision: 7,
        providerNode: providerNode(accepted.execution, {
          addresses: ['203.000.113.010', '2001:0DB8:0:0:0:0:0:10'],
        }),
        deliveredTokenHash: 'b'.repeat(64),
        completedAt: executeAt,
      }),
    )
    expect(
      database
        .prepare(`SELECT record_type AS recordType, target, source, observed_revision AS observedRevision,
          revision FROM node_player_endpoints ORDER BY record_type`)
        .all(),
    ).toEqual([
      {
        recordType: 'A',
        target: '203.0.113.10',
        source: 'provider',
        observedRevision: 1,
        revision: 1,
      },
      {
        recordType: 'AAAA',
        target: '2001:0db8:0:0:0:0:0:10',
        source: 'provider',
        observedRevision: 1,
        revision: 1,
      },
    ])
    const envelope = envelopeFor(`audit_node_provider:${accepted.execution.operationId}`)
    expect(envelope).toMatchObject({
      after: {
        state: 'captured',
        summary: {
          playerEndpointEvidence: 'captured',
          playerEndpoints: [
            { recordType: 'A', target: '203.0.113.10' },
            { recordType: 'AAAA', target: '2001:0db8:0:0:0:0:0:10' },
          ],
        },
      },
    })
  })

  it('does not invent a player endpoint for missing, invalid, or ambiguous provider addresses', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await Effect.runPromise(
      repository.completeAtomic({
        reservation: accepted.execution,
        account: accepted.account,
        envelopeRevision: 7,
        providerNode: providerNode(accepted.execution, {
          addresses: ['203.0.113.10', '203.0.113.11'],
        }),
        deliveredTokenHash: 'b'.repeat(64),
        completedAt: executeAt,
      }),
    )
    expect(count('node_player_endpoints')).toBe(0)
    const outbox = get(`SELECT payload_json AS payload FROM outbox
      WHERE id = 'outbox_node_provider:${accepted.execution.operationId}'`)
    expect(JSON.parse(String(outbox.payload))).toMatchObject({
      playerEndpointEvidence: 'absent',
      playerEndpointReason: 'provider-addresses-ambiguous',
      playerEndpoints: [],
    })
  })

  it('does not adopt a provider completion if its player endpoint evidence was torn away', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await complete(repository, accepted.execution, accepted.account)
    database.prepare(`DELETE FROM node_player_endpoints WHERE organization_id = 'org-a'`).run()
    await expect(
      Effect.runPromise(repository.findCompletion('org-a', accepted.execution.operationId)),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionPersistenceError' })
  })

  it('binds an early boot exactly once and matches a provider response after the token TTL', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    const binding = makeProvisionalNodeRegistrationBindingD1(d1)
    d1.loseBatchResponse = true
    const bound = await Effect.runPromise(
      binding.bindFirst({
        organizationId: 'org-a',
        nodeId: accepted.execution.nodeId,
        deliveredTokenHash: 'b'.repeat(64),
        providerInstanceId: 'ovhcloud-instance-a',
        boundAt: '2026-08-23T10:10:00.000Z',
      }),
    )
    expect(bound).toMatchObject({
      disposition: 'adopted',
      operationId: accepted.execution.operationId,
    })
    expect(count('node_registration_tokens')).toBe(1)
    expect(get(`SELECT expires_at AS expiresAt FROM node_registration_tokens`)).toEqual({
      expiresAt: bootstrapExpiresAt,
    })
    const completed = await Effect.runPromise(
      repository.completeAtomic({
        reservation: accepted.execution,
        account: accepted.account,
        envelopeRevision: 7,
        providerNode: providerNode(accepted.execution),
        deliveredTokenHash: 'b'.repeat(64),
        completedAt: '2026-08-23T12:05:00.000Z',
      }),
    )
    expect(completed).toMatchObject({ providerInstanceId: 'ovhcloud-instance-a' })
    expect(count('node_registration_tokens')).toBe(1)
    await expect(
      Effect.runPromise(
        repository.completeAtomic({
          reservation: accepted.execution,
          account: accepted.account,
          envelopeRevision: 7,
          providerNode: providerNode(accepted.execution, { id: 'ovhcloud-instance-b' }),
          deliveredTokenHash: 'b'.repeat(64),
          completedAt: '2026-08-23T12:06:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionConflictError' })
  })

  it('atomically binds and consumes an early boot registration before the provider response', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    const exchange = makeProvisionalNodeRegistrationExchangeD1(d1)
    const input = registrationExchangeInput(accepted.execution)
    const result = await Effect.runPromise(exchange.exchange(input))
    expect(result).toMatchObject({
      disposition: 'bound',
      operationId: accepted.execution.operationId,
      providerInstanceId: 'ovhcloud-instance-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
      sessionVersion: 1,
    })
    expect(
      get(`SELECT provider_instance_id AS providerInstanceId, observed_state AS observedState
        FROM nodes`),
    ).toEqual({ providerInstanceId: 'ovhcloud-instance-a', observedState: 'unknown' })
    expect(
      get(`SELECT state, provider_instance_id AS providerInstanceId
        FROM node_provision_registration_bindings`),
    ).toEqual({ state: 'bound', providerInstanceId: 'ovhcloud-instance-a' })
    expect(
      get(`SELECT credential_id AS credentialId, consumed_at AS consumedAt, revoked_at AS revokedAt
        FROM node_registration_tokens`),
    ).toMatchObject({ credentialId: 'credential-a', consumedAt: input.now, revokedAt: null })
    expect(count('node_credentials')).toBe(1)
    expect(count('agent_sessions')).toBe(1)
    expect(count('node_installer_keys')).toBe(1)
    expect(
      envelopeFor(`audit_node_registration_exchange:${accepted.execution.operationId}`),
    ).toMatchObject({
      version: 1,
      captureStatus: 'complete',
      action: 'node.registration.exchanged',
      operationId: `${accepted.execution.operationId}-audit-registration-exchanged`,
      result: 'succeeded',
      source: { origin: 'machine' },
    })
    expect(
      Number(
        (
          database
            .prepare(
              `SELECT count(*) AS count FROM audit_events WHERE action = 'node.registration.exchanged'`,
            )
            .get() as { count: number }
        ).count,
      ),
    ).toBe(1)
    expect(
      Number(
        (
          database
            .prepare(
              `SELECT count(*) AS count FROM outbox WHERE event_type = 'node.registration.exchanged'`,
            )
            .get() as { count: number }
        ).count,
      ),
    ).toBe(1)
    const completion = await complete(repository, accepted.execution, accepted.account)
    expect(completion).toMatchObject({ providerInstanceId: 'ovhcloud-instance-a' })
  })

  it('adopts the exact early registration when the committed response is lost', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    const exchange = makeProvisionalNodeRegistrationExchangeD1(d1)
    d1.loseBatchResponse = true
    const result = await Effect.runPromise(
      exchange.exchange(registrationExchangeInput(accepted.execution)),
    )
    expect(result).toMatchObject({
      disposition: 'adopted',
      operationId: accepted.execution.operationId,
      credentialId: 'credential-a',
    })
    expect(count('node_registration_tokens')).toBe(1)
    expect(count('node_credentials')).toBe(1)
    expect(count('agent_sessions')).toBe(1)
    expect(count('node_installer_keys')).toBe(1)
  })

  it('rejects an expired provisional token without binding an instance or consuming it', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    const exchange = makeProvisionalNodeRegistrationExchangeD1(d1)
    await expect(
      Effect.runPromise(
        exchange.exchange(
          registrationExchangeInput(accepted.execution, { now: '2026-08-23T11:05:00.000Z' }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionConflictError' })
    expect(get(`SELECT provider_instance_id AS providerInstanceId FROM nodes`)).toEqual({
      providerInstanceId: null,
    })
    expect(count('node_registration_tokens')).toBe(0)
    expect(count('node_credentials')).toBe(0)
  })

  it('allows only the first concurrent provider identity and requires the provider completion to match it', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    const exchange = makeProvisionalNodeRegistrationExchangeD1(d1)
    const first = registrationExchangeInput(accepted.execution)
    const conflicting = registrationExchangeInput(accepted.execution, {
      providerInstanceId: 'ovhcloud-instance-b',
      credentialId: 'credential-b',
      credentialHash: 'e'.repeat(64),
    })
    const settled = await Promise.allSettled([
      Effect.runPromise(exchange.exchange(first)),
      Effect.runPromise(exchange.exchange(conflicting)),
    ])
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1)
    const boundProvider = String(
      get(`SELECT provider_instance_id AS providerInstanceId FROM nodes`).providerInstanceId,
    )
    await expect(
      Effect.runPromise(
        repository.completeAtomic({
          reservation: accepted.execution,
          account: accepted.account,
          envelopeRevision: 7,
          providerNode: providerNode(accepted.execution, {
            id:
              boundProvider === 'ovhcloud-instance-a'
                ? 'ovhcloud-instance-b'
                : 'ovhcloud-instance-a',
          }),
          deliveredTokenHash: 'b'.repeat(64),
          completedAt: '2026-08-23T10:11:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionConflictError' })
  })

  it('consumes the provider-completed registration through the same atomic evidence path', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await complete(repository, accepted.execution, accepted.account)
    const exchange = makeProvisionalNodeRegistrationExchangeD1(d1)
    const result = await Effect.runPromise(
      exchange.exchange(registrationExchangeInput(accepted.execution)),
    )
    expect(result).toMatchObject({
      disposition: 'bound',
      operationId: accepted.execution.operationId,
      providerInstanceId: 'ovhcloud-instance-a',
    })
    expect(
      get(
        `SELECT credential_id AS credentialId, consumed_at AS consumedAt FROM node_registration_tokens`,
      ),
    ).toMatchObject({
      credentialId: 'credential-a',
      consumedAt: '2026-08-23T10:10:00.000Z',
    })
    expect(count('node_credentials')).toBe(1)
    expect(count('agent_sessions')).toBe(1)
    expect(count('node_installer_keys')).toBe(1)
  })

  it('durably changes a lost provider response to adopt-only without releasing the lease', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await Effect.runPromise(
      repository.recordFailureAtomic({
        reservation: accepted.execution,
        attemptedAt: executeAt,
        category: 'ProviderCreateUncertainError',
        retryable: true,
        attemptNumber: 2,
      }),
    )
    expect(get(`SELECT status FROM operations WHERE type = 'provision-node'`)).toEqual({
      status: 'retrying',
    })
    expect(get(`SELECT state FROM node_provision_execution_leases`)).toEqual({ state: 'active' })
    const reloaded = await Effect.runPromise(
      makeNodeProvisionExecutionReservationD1(d1).load('org-a', accepted.execution.operationId),
    )
    expect(
      await begin(
        repository,
        reloaded,
        accepted.account,
        accepted.execution.bootstrapToken.tokenHash,
      ),
    ).toMatchObject({
      mode: 'adopt_only',
    })
    expect(() =>
      database.prepare(`UPDATE provider_accounts SET revision = 4 WHERE id = 'account-a'`).run(),
    ).toThrow('active node provision execution')
    expect(
      get(`SELECT type, status FROM operations
        WHERE id = '${accepted.execution.operationId}-audit-provider-failed-2'`),
    ).toEqual({ type: 'node.provision.provider-failed', status: 'failed_terminal' })
    expect(
      envelopeFor(`audit_node_provider_failure:${accepted.execution.operationId}:2`),
    ).toMatchObject({
      version: 1,
      captureStatus: 'complete',
      action: 'node.provision.provider-failed',
      operationId: `${accepted.execution.operationId}-audit-provider-failed-2`,
      result: 'failed',
      error: { classification: 'provider', code: 'ProviderCreateUncertainError' },
      source: { origin: 'machine' },
    })
  })

  it('releases the execution lease after a definite terminal provider failure', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await Effect.runPromise(
      repository.recordFailureAtomic({
        reservation: accepted.execution,
        attemptedAt: executeAt,
        category: 'ProviderValidationError',
        retryable: false,
        attemptNumber: 2,
      }),
    )
    expect(get(`SELECT status FROM operations WHERE type = 'provision-node'`)).toEqual({
      status: 'failed_terminal',
    })
    expect(
      get(`SELECT state, released_at AS releasedAt FROM node_provision_execution_leases`),
    ).toEqual({
      state: 'released',
      releasedAt: executeAt,
    })
    expect(() =>
      database.prepare(`UPDATE provider_accounts SET revision = 4 WHERE id = 'account-a'`).run(),
    ).not.toThrow()
  })

  it('rolls back every failure artifact when a concurrent operation transition wins', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    database
      .prepare(
        `UPDATE operations SET status = 'waiting_external' WHERE organization_id = 'org-a' AND id = ?`,
      )
      .run(accepted.execution.operationId)
    const auditBefore = count('audit_events')
    const outboxBefore = count('outbox')
    await expect(
      Effect.runPromise(
        repository.recordFailureAtomic({
          reservation: accepted.execution,
          attemptedAt: executeAt,
          category: 'ProviderCreateUncertainError',
          retryable: true,
          attemptNumber: 2,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionPersistenceError' })
    expect(get(`SELECT status FROM operations WHERE type = 'provision-node'`)).toEqual({
      status: 'waiting_external',
    })
    expect(get(`SELECT reconciliation_error AS reconciliationError FROM nodes`)).toEqual({
      reconciliationError: null,
    })
    expect(count('audit_events')).toBe(auditBefore)
    expect(count('outbox')).toBe(outboxBefore)
  })

  it('rolls back all provider materialization when one statement fails', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    d1.failBatchStatement = 5
    await expect(complete(repository, accepted.execution, accepted.account)).rejects.toMatchObject({
      _tag: 'NodeProvisionExecutionPersistenceError',
    })
    expect(
      get(
        `SELECT provider_instance_id AS providerInstanceId, observed_state AS observedState FROM nodes`,
      ),
    ).toEqual({
      providerInstanceId: null,
      observedState: 'unknown',
    })
    expect(get(`SELECT status FROM operations WHERE type = 'provision-node'`)).toEqual({
      status: 'running',
    })
    expect(get(`SELECT state FROM node_bootstrap_token_reservations`)).toEqual({
      state: 'materialized',
    })
    expect(get(`SELECT state FROM node_provision_execution_leases`)).toEqual({ state: 'active' })
    expect(count('node_registration_tokens')).toBe(0)
    expect(
      Number(
        (
          database
            .prepare(`SELECT count(*) AS count FROM audit_events
            WHERE action = 'node.provision.provider-created'`)
            .get() as { count: number }
        ).count,
      ),
    ).toBe(0)
  })

  it('rejects the wrong account revision and foreign provider ownership before commit', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await expect(
      begin(repository, accepted.execution, { ...accepted.account, revision: 4 }),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionConflictError' })
    expect(count('node_provision_execution_leases')).toBe(0)
    await begin(repository, accepted.execution, accepted.account)
    await expect(
      Effect.runPromise(
        repository.completeAtomic({
          reservation: accepted.execution,
          account: accepted.account,
          envelopeRevision: 7,
          providerNode: providerNode(accepted.execution, {
            metadata: {
              managedBy: 'gridora',
              organizationId: 'org-foreign',
              nodeId: accepted.execution.nodeId,
              operationId: accepted.execution.operationId,
              imageVersion: accepted.execution.imageVersion,
            },
          }),
          deliveredTokenHash: 'b'.repeat(64),
          completedAt: executeAt,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionExecutionConflictError' })
    expect(get(`SELECT provider_instance_id AS providerInstanceId FROM nodes`)).toEqual({
      providerInstanceId: null,
    })
  })

  it('locks rotation across the paid call and releases the lock only with provider evidence', async () => {
    const accepted = await accept()
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    expect(() =>
      database
        .prepare(`UPDATE node_provision_execution_leases
          SET state = 'released', released_at = ? WHERE organization_id = 'org-a' AND operation_id = ?`)
        .run(executeAt, accepted.execution.operationId),
    ).toThrow('execution lease release is invalid')
    expect(() =>
      database.prepare(`UPDATE provider_accounts SET revision = 4 WHERE id = 'account-a'`).run(),
    ).toThrow('active node provision execution')
    expect(() =>
      database
        .prepare(
          `UPDATE secret_envelopes SET revision = 8 WHERE organization_id = 'org-a' AND id = 'envelope-a'`,
        )
        .run(),
    ).toThrow('active node provision execution')
    await complete(repository, accepted.execution, accepted.account)
    expect(() =>
      database.prepare(`UPDATE provider_accounts SET revision = 4 WHERE id = 'account-a'`).run(),
    ).not.toThrow()
  })

  it('supports an allocated platform account without inventing tenant ownership', async () => {
    const accepted = await accept('ovhcloud', 'platform')
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    const result = await complete(repository, accepted.execution, accepted.account)
    expect(result).toMatchObject({ providerInstanceId: 'ovhcloud-instance-a' })
    expect(get(`SELECT state FROM node_provision_execution_leases`)).toEqual({ state: 'released' })
  })

  it('persists immutable Contabo commercial terms and no plaintext canary', async () => {
    const accepted = await accept('contabo')
    const repository = makeNodeProvisionExecutionRepositoryD1(d1)
    await begin(repository, accepted.execution, accepted.account)
    await complete(repository, accepted.execution, accepted.account)
    expect(
      get(`SELECT provider_type AS providerType, billing_cadence AS billingCadence,
      contract_months AS contractMonths, estimated_monthly_minor AS estimatedMonthlyMinor,
      non_hourly_commitment_confirmed AS confirmed FROM node_provision_contracts`),
    ).toEqual({
      providerType: 'contabo',
      billingCadence: 'contract',
      contractMonths: 12,
      estimatedMonthlyMinor: 1800,
      confirmed: 1,
    })
    const evidence = get(`SELECT group_concat(value, '|') AS value FROM (
      SELECT summary_json AS value FROM audit_events
      UNION ALL SELECT payload_json FROM outbox
      UNION ALL SELECT token_hash FROM node_registration_tokens
    )`).value
    expect(String(evidence)).not.toContain('encrypted-canary')
    expect(String(evidence)).not.toContain('wrapped-canary')
    expect(String(evidence)).not.toContain('registration-token-key-material')
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  makeHmacRegistrationTokenSecret,
  makeNodeProvisionControl,
  makeWebCryptoNodeProvisionIdentity,
  nodeProvisionPolicyAdmission,
  NodeProvisionWorkflowStartError,
  reviewNodeProvision,
  type CreateNodeIntent,
  type NodeProvisionAtomicInput,
  type NodeProvisionCommand,
} from '@gridora/node-provision-control'
import {
  makeNodeProvisionExecutionReservationD1,
  makeNodeProvisionFactsD1,
  makeNodeProvisionRepositoryD1,
  type NodeProvisionD1Database,
  type NodeProvisionD1Result,
  type NodeProvisionD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrationFiles = readdirSync(sqlDirectory)
  .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
  .sort()

class SqliteStatement implements NodeProvisionD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(
    readonly database: DatabaseSync,
    readonly statement: StatementSync,
  ) {}
  bind(...values: ReadonlyArray<unknown>): NodeProvisionD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<NodeProvisionD1Result> {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    const changes = Number(
      (this.database.prepare('SELECT changes() AS changes').get() as { changes: number }).changes,
    )
    return { success: true, results, meta: { changes } }
  }
}

class SqliteD1 implements NodeProvisionD1Database {
  private serial: Promise<void> = Promise.resolve()
  beforeBatch: (() => void) | undefined
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): NodeProvisionD1Statement {
    return new SqliteStatement(this.database, this.database.prepare(sql))
  }
  async batch(
    statements: ReadonlyArray<NodeProvisionD1Statement>,
  ): Promise<ReadonlyArray<NodeProvisionD1Result>> {
    const prior = this.serial
    let release!: () => void
    this.serial = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    try {
      this.beforeBatch?.()
      this.database.exec('BEGIN IMMEDIATE')
      const results: NodeProvisionD1Result[] = []
      for (const statement of statements) {
        await statement.all()
        const row = this.database.prepare('SELECT changes() AS changes').get() as {
          changes: number
        }
        results.push({ success: true, results: [], meta: { changes: row.changes } })
      }
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }
}

const nowIso = '2026-08-23T10:00:00.000Z'
const nowEpoch = Date.parse(nowIso)
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
    maxActiveNodes: 2,
    maxDedicatedNodes: 1,
    maxServersPerNode: 8,
    maxDeploymentCpuMillis: 8_000,
    maxDeploymentRamBytes: 16_000,
    maxDeploymentDiskBytes: 100_000,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 5_000,
    hardLimitMinor: 10_000,
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

const seed = () => {
  database
    .prepare(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('actor-a', 'access-a', 'actor@example.com', 'Actor', 'active', ?, ?)`)
    .run(nowIso, nowIso)
  for (const [organizationId, slug] of [
    ['org-a', 'org-a'],
    ['org-b', 'org-b'],
  ] as const) {
    database
      .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'region-a', 'complete', 1, 1, ?)`)
      .run(organizationId, organizationId, slug, nowIso)
    database
      .prepare(`INSERT INTO organization_policies
      (organization_id, policy_json, revision, updated_by, updated_at)
      VALUES (?, ?, 1, 'actor-a', ?)`)
      .run(organizationId, JSON.stringify(policy(organizationId)), nowIso)
    database
      .prepare(`INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, invited_by, revision)
        VALUES (?, 'actor-a', 'administrator', 'active', ?, NULL, 1)`)
      .run(organizationId, nowIso)
  }
  database
    .prepare(`INSERT INTO provider_accounts
    (id, scope, organization_id, provider_type, credential_reference, status, revision,
     created_at, updated_at)
    VALUES ('account-a', 'organization', 'org-a', 'ovhcloud', 'envelope-a', 'active', 3, ?, ?)`)
    .run(nowIso, nowIso)
  database
    .prepare(`INSERT INTO provider_allocations
    (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
     max_active_nodes, monthly_budget_minor, status, revision)
    VALUES ('org-a', 'account-a', '["region-a"]', '["plan-a"]', 2, 10000, 'active', 5)`)
    .run()
  database
    .prepare(`INSERT INTO provider_catalog
    (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
     metadata_json, refreshed_at)
    VALUES ('ovhcloud', 'region-a', 'plan-a', 'EUR', NULL, 1500, ?, ?)`)
    .run(
      JSON.stringify({
        schemaVersion: 1,
        billingCadence: 'monthly',
        contractMonths: 1,
        validUntilEpochMilliseconds: nowEpoch + 86_400_000,
      }),
      nowIso,
    )
  database
    .prepare(`INSERT INTO node_images
    (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
    VALUES ('image-a', '2026.08.23', ?, 'signature-a', ?, 'promoted', ?, ?)`)
    .run(
      `sha256:${'a'.repeat(64)}`,
      JSON.stringify({ ovhcloud: { 'region-a': 'provider-image-a' } }),
      nowIso,
      nowIso,
    )
}

const identities = makeWebCryptoNodeProvisionIdentity()
const registrationTokens = makeHmacRegistrationTokenSecret({
  activeVersion: 2,
  keys: { 2: 'registration-token-key-material-with-at-least-32-bytes' },
})
const command = (
  idempotencyKey = 'create-node-0001',
  nextIntent: CreateNodeIntent = intent,
): NodeProvisionCommand => ({
  organizationId: 'org-a',
  actorId: 'actor-a',
  actorRole: 'administrator',
  idempotencyKey,
  correlationId: `correlation-${idempotencyKey}`,
  intent: nextIntent,
})

const makeInput = async (nextCommand: NodeProvisionCommand): Promise<NodeProvisionAtomicInput> => {
  const facts = await Effect.runPromise(
    makeNodeProvisionFactsD1(d1, { nowEpochMilliseconds: () => nowEpoch }).resolve({
      organizationId: nextCommand.organizationId,
      nodeId: 'pending',
      intent: nextCommand.intent,
    }),
  )
  const fingerprint = await Effect.runPromise(identities.fingerprint(nextCommand))
  const identity = await Effect.runPromise(identities.derive(nextCommand, fingerprint))
  const billing = await Effect.runPromise(
    nodeProvisionPolicyAdmission.admit(nextCommand.intent, facts, nowEpoch),
  )
  const bootstrapToken = await Effect.runPromise(
    registrationTokens.hashFor({
      organizationId: nextCommand.organizationId,
      nodeId: identity.nodeId,
      operationId: identity.operationId,
      tokenRecordId: identity.bootstrapTokenRecordId,
    }),
  )
  return {
    command: nextCommand,
    identity,
    fingerprint,
    facts,
    billing,
    bootstrapToken,
    now: nowIso,
  }
}

const count = (table: string): number =>
  Number(
    (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
  )

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of migrationFiles)
    database.exec(readFileSync(`${sqlDirectory}/${migration}`, 'utf8'))
  d1 = new SqliteD1(database)
  seed()
})

afterEach(() => database.close())

describe('node provision D1 acceptance', () => {
  it('resolves authoritative tenant-scoped facts and atomically materializes all evidence', async () => {
    const input = await makeInput(command())
    const accepted = await Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(input))
    expect(accepted).toMatchObject({
      disposition: 'created',
      organizationId: 'org-a',
      providerType: 'ovhcloud',
      billing: { estimatedMonthlyMinor: 1500 },
      workflowStart: { state: 'pending' },
    })
    for (const table of [
      'nodes',
      'lifecycle_workflow_starts',
      'lifecycle_reservations',
      'node_provision_contracts',
      'node_provision_spend_reservations',
      'node_bootstrap_token_reservations',
      'node_provision_acceptances',
      'audit_events',
    ])
      expect(count(table), table).toBe(1)
    expect(count('operations')).toBe(2) // queued provider work plus terminal acceptance fact
    expect(
      database
        .prepare(`SELECT type, status, progress FROM operations
        WHERE id = ?`)
        .get(`${accepted.operationId}-accepted`),
    ).toEqual({ type: 'node.provision.accepted', status: 'succeeded', progress: 100 })
    expect(count('audit_event_envelopes')).toBe(1)
    expect(count('audit_envelope_staging')).toBe(0)
    expect(count('outbox')).toBe(2) // workflow-start plus the audit-export event from migration 0007
    const token = database
      .prepare(`SELECT token_hash AS tokenHash, key_version AS keyVersion
      FROM node_bootstrap_token_reservations`)
      .get() as { tokenHash: string; keyVersion: number }
    expect(token).toMatchObject({ keyVersion: 2 })
    expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(token)).not.toContain('registration-token-key-material')
    const evidence = database
      .prepare(`SELECT group_concat(value, '|') AS value FROM (
        SELECT summary_json AS value FROM audit_events
        UNION ALL SELECT payload_json FROM outbox
        UNION ALL SELECT receipt_json FROM node_provision_acceptances
      )`)
      .get() as { value: string }
    expect(evidence.value).not.toContain('registration-token-key-material')
    const execution = await Effect.runPromise(
      makeNodeProvisionExecutionReservationD1(d1).load(
        input.command.organizationId,
        input.identity.operationId,
      ),
    )
    expect(execution).toMatchObject({
      organizationId: 'org-a',
      nodeId: input.identity.nodeId,
      operationId: input.identity.operationId,
      providerAccountId: 'account-a',
      providerAccountRevision: 3,
      providerType: 'ovhcloud',
      imageChecksum: `sha256:${'a'.repeat(64)}`,
      providerImageId: 'provider-image-a',
      billing: {
        currency: 'EUR',
        estimatedMonthlyMinor: 1500,
        billingCadence: 'monthly',
        contractMonths: 1,
        nonHourlyCommitmentConfirmed: true,
      },
      bootstrapToken: { keyVersion: 2, state: 'reserved' },
    })
  })

  it('persists one immutable temporary expiry with the acceptance and does not create it after a final policy race', async () => {
    const temporaryIntent: CreateNodeIntent = {
      ...intent,
      temporaryLifetimeHours: 4,
    }
    const temporary = await makeInput(command('create-node-temporary', temporaryIntent))
    const repository = makeNodeProvisionRepositoryD1(d1)
    const created = await Effect.runPromise(repository.acceptAtomic(temporary))
    const replayed = await Effect.runPromise(repository.acceptAtomic(temporary))

    expect(created.disposition).toBe('created')
    expect(replayed.disposition).toBe('adopted')
    const expiry = database
      .prepare(`SELECT node.temporary_expires_at AS nodeExpiry,
        acceptance.temporary_lifetime_hours AS lifetimeHours,
        acceptance.temporary_expires_at AS acceptanceExpiry
        FROM nodes node
        JOIN node_provision_acceptances acceptance
          ON acceptance.organization_id = node.organization_id AND acceptance.node_id = node.id
        WHERE node.organization_id = 'org-a' AND node.id = ?`)
      .get(temporary.identity.nodeId) as {
      readonly nodeExpiry: string
      readonly lifetimeHours: number
      readonly acceptanceExpiry: string
    }
    expect(expiry).toEqual({
      nodeExpiry: '2026-08-23T14:00:00.000Z',
      lifetimeHours: 4,
      acceptanceExpiry: '2026-08-23T14:00:00.000Z',
    })
    expect(() =>
      database
        .prepare(`UPDATE nodes SET temporary_expires_at = '2026-08-24T14:00:00.000Z'
          WHERE organization_id = 'org-a' AND id = ?`)
        .run(temporary.identity.nodeId),
    ).toThrow('node temporary expiry is immutable')

    const raced = await makeInput(command('create-node-temporary-raced', temporaryIntent))
    d1.beforeBatch = () =>
      database.prepare(`UPDATE organizations SET policy_revision = 2 WHERE id = 'org-a'`).run()
    await expect(Effect.runPromise(repository.acceptAtomic(raced))).rejects.toMatchObject({
      _tag: 'NodeProvisionPersistenceError',
    })
    expect(count('nodes')).toBe(1)
    expect(count('node_provision_acceptances')).toBe(1)
  })

  it('adopts exact replay before current provider admission and rejects changed fingerprint', async () => {
    const facts = makeNodeProvisionFactsD1(d1, { nowEpochMilliseconds: () => nowEpoch })
    const repository = makeNodeProvisionRepositoryD1(d1)
    const service = makeNodeProvisionControl({
      repository,
      facts,
      policy: nodeProvisionPolicyAdmission,
      identities,
      registrationTokens,
      clock: { now: Effect.succeed({ iso: nowIso, epochMilliseconds: nowEpoch }) },
      workflows: { start: () => Effect.void },
    })
    const created = await Effect.runPromise(service.submit(command()))
    database
      .prepare("UPDATE provider_accounts SET status = 'disabled' WHERE id = 'account-a'")
      .run()
    const adopted = await Effect.runPromise(service.submit(command()))
    expect(adopted).toMatchObject({
      disposition: 'adopted',
      nodeId: created.nodeId,
      operationId: created.operationId,
    })
    await expect(
      Effect.runPromise(
        service.submit(
          command('create-node-0001', {
            ...intent,
            placementMode: 'dedicated',
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionIdempotencyConflictError' })
    expect(count('operations')).toBe(2)
  })

  it('uses an exact reviewed binding and adopts a lost response before current provider facts', async () => {
    const factsPort = makeNodeProvisionFactsD1(d1, { nowEpochMilliseconds: () => nowEpoch })
    const resolved = await Effect.runPromise(
      factsPort.resolve({ organizationId: 'org-a', nodeId: 'preview-node', intent }),
    )
    const billing = await Effect.runPromise(
      nodeProvisionPolicyAdmission.admit(intent, resolved, nowEpoch),
    )
    const reviewed = await Effect.runPromise(reviewNodeProvision(resolved, billing))
    let starts = 0
    const service = makeNodeProvisionControl({
      repository: makeNodeProvisionRepositoryD1(d1),
      facts: factsPort,
      policy: nodeProvisionPolicyAdmission,
      identities,
      registrationTokens,
      clock: { now: Effect.succeed({ iso: nowIso, epochMilliseconds: nowEpoch }) },
      workflows: {
        start: (accepted) => {
          starts += 1
          return starts === 1
            ? Effect.fail(
                new NodeProvisionWorkflowStartError({
                  operationId: accepted.operationId,
                  message: 'ambiguous provider-workflow response loss',
                }),
              )
            : Effect.void
        },
      },
    })
    expect(
      (await Effect.runPromise(service.submitAccepted(command('reviewed-create-0001'), reviewed)))
        .workflowState,
    ).toBe('pending-reconciliation')
    database
      .prepare("UPDATE provider_accounts SET status = 'disabled' WHERE id = 'account-a'")
      .run()
    expect(
      await Effect.runPromise(service.submitAccepted(command('reviewed-create-0001'), reviewed)),
    ).toMatchObject({ disposition: 'adopted', workflowState: 'started' })
    expect(starts).toBe(2)
    expect(count('nodes')).toBe(1)
    expect(count('node_provision_acceptances')).toBe(1)
  })

  it('never substitutes a different eligible provider account for a reviewed selection', async () => {
    const factsPort = makeNodeProvisionFactsD1(d1, { nowEpochMilliseconds: () => nowEpoch })
    const resolveReviewed = factsPort.resolveReviewed
    if (resolveReviewed === undefined) throw new Error('reviewed fact resolver is required')
    const resolved = await Effect.runPromise(
      factsPort.resolve({ organizationId: 'org-a', nodeId: 'preview-node', intent }),
    )
    const billing = await Effect.runPromise(
      nodeProvisionPolicyAdmission.admit(intent, resolved, nowEpoch),
    )
    const reviewed = await Effect.runPromise(reviewNodeProvision(resolved, billing))
    database
      .prepare("UPDATE provider_accounts SET status = 'disabled' WHERE id = 'account-a'")
      .run()
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision,
       created_at, updated_at)
      VALUES ('account-b', 'organization', 'org-a', 'ovhcloud', 'envelope-b', 'active', 1, ?, ?)`)
      .run(nowIso, nowIso)
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, monthly_budget_minor, status, revision)
      VALUES ('org-a', 'account-b', '["region-a"]', '["plan-a"]', 2, 10000, 'active', 1)`)
      .run()
    expect(
      await Effect.runPromise(
        factsPort.resolve({ organizationId: 'org-a', nodeId: 'replacement-node', intent }),
      ),
    ).toMatchObject({ providerAccountId: 'account-b' })
    await expect(
      Effect.runPromise(
        resolveReviewed({
          organizationId: 'org-a',
          nodeId: 'reviewed-node',
          intent,
          reviewed,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionFactsUnavailableError' })
  })

  it('does not disclose or adopt another organization replay', async () => {
    const input = await makeInput(command())
    const repository = makeNodeProvisionRepositoryD1(d1)
    await Effect.runPromise(repository.acceptAtomic(input))
    expect(
      await Effect.runPromise(
        repository.findReplay('org-b', input.command.idempotencyKey, input.fingerprint),
      ),
    ).toBeNull()
    await expect(
      Effect.runPromise(
        makeNodeProvisionFactsD1(d1).resolve({
          organizationId: 'org-b',
          nodeId: 'node-x',
          intent,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionFactsUnavailableError' })
    await expect(
      Effect.runPromise(
        makeNodeProvisionExecutionReservationD1(d1).load('org-b', input.identity.operationId),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionFactsUnavailableError' })
  })

  it('fails the execution read when the accepted account revision is no longer authoritative', async () => {
    const input = await makeInput(command())
    await Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(input))
    database.prepare("UPDATE provider_accounts SET revision = 4 WHERE id = 'account-a'").run()
    await expect(
      Effect.runPromise(
        makeNodeProvisionExecutionReservationD1(d1).load('org-a', input.identity.operationId),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionFactsUnavailableError' })
  })

  it('rolls back every materialization when a policy revision fence changes', async () => {
    const input = await makeInput(command())
    database.prepare("UPDATE organizations SET policy_revision = 2 WHERE id = 'org-a'").run()
    await expect(
      Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(input)),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionPersistenceError' })
    for (const table of [
      'nodes',
      'operations',
      'node_provision_acceptances',
      'audit_events',
      'outbox',
    ])
      expect(count(table), table).toBe(0)
  })

  it.each([
    ["UPDATE provider_allocations SET revision = 6 WHERE organization_id = 'org-a'", 'allocation'],
    [
      "UPDATE provider_allocations SET monthly_budget_minor = 9999 WHERE organization_id = 'org-a'",
      'allocation budget',
    ],
    [
      "UPDATE provider_catalog SET monthly_price_minor = 1600 WHERE provider_type = 'ovhcloud'",
      'catalog',
    ],
    ["UPDATE node_images SET version = '2026.08.24' WHERE id = 'image-a'", 'image'],
    [
      `UPDATE node_images SET checksum = 'sha256:${'b'.repeat(64)}' WHERE id = 'image-a'`,
      'image checksum',
    ],
  ])('rejects a stale %s fence without leaving an operation', async (mutation) => {
    const input = await makeInput(command())
    database.exec(mutation)
    await expect(
      Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(input)),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionPersistenceError' })
    expect(count('operations')).toBe(0)
    expect(count('nodes')).toBe(0)
  })

  it('serializes overlapping acceptance snapshots so only one is accepted', async () => {
    const first = await makeInput(command('create-node-0001'))
    const second = await makeInput(command('create-node-0002'))
    database
      .prepare(
        "UPDATE provider_allocations SET max_active_nodes = 1 WHERE organization_id = 'org-a'",
      )
      .run()
    const firstStale: NodeProvisionAtomicInput = {
      ...first,
      facts: {
        ...first.facts,
        allocationMaxActiveNodes: 1,
        policy: {
          ...first.facts.policy,
          capacity: { ...first.facts.policy.capacity, maxActiveNodes: 1 },
        },
      },
    }
    const secondStale: NodeProvisionAtomicInput = {
      ...second,
      facts: {
        ...second.facts,
        allocationMaxActiveNodes: 1,
        policy: {
          ...second.facts.policy,
          capacity: { ...second.facts.policy.capacity, maxActiveNodes: 1 },
        },
      },
    }
    const repository = makeNodeProvisionRepositoryD1(d1)
    const outcomes = await Promise.allSettled([
      Effect.runPromise(repository.acceptAtomic(firstStale)),
      Effect.runPromise(repository.acceptAtomic(secondStale)),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(count('operations')).toBe(2)
    expect(count('nodes')).toBe(1)
    expect(count('node_provision_acceptances')).toBe(1)
  })

  it('adopts one exact request when duplicate deliveries race', async () => {
    const input = await makeInput(command('create-node-duplicate'))
    const repository = makeNodeProvisionRepositoryD1(d1)
    const outcomes = await Promise.all([
      Effect.runPromise(repository.acceptAtomic(input)),
      Effect.runPromise(repository.acceptAtomic(input)),
    ])
    expect(outcomes.map((outcome) => outcome.disposition).sort()).toEqual(['adopted', 'created'])
    expect(count('nodes')).toBe(1)
    expect(count('operations')).toBe(2)
  })

  it('fences usage and spend snapshots and rolls back the new acceptance', async () => {
    const input = await makeInput(command())
    database
      .prepare(`INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
         plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
         observed_revision, reconciliation_error, last_reconciled_at, created_at, updated_at,
         pending_lifecycle_operation_id)
        VALUES ('org-a', 'node-existing', 'account-a', 'provider-existing', 'ovhcloud',
         'region-a', 'plan-a', 'image-a', 'shared', 'ready', 'ready', 1, 1,
         NULL, ?, ?, ?, NULL)`)
      .run(nowIso, nowIso, nowIso)
    database
      .prepare(`INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES ('op-existing', 'org-a', 'provision-node', 'node', 'node-existing', 'actor-a',
         'succeeded', 100, 'existing-operation', 'existing-correlation', 1, ?, ?)`)
      .run(nowIso, nowIso)
    database
      .prepare(`INSERT INTO node_provision_spend_reservations
        (organization_id, node_id, operation_id, currency, estimated_monthly_minor,
         state, revision, reserved_at, released_at)
        VALUES ('org-a', 'node-existing', 'op-existing', 'EUR', 100, 'active', 1, ?, NULL)`)
      .run(nowIso)
    await expect(
      Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(input)),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionPersistenceError' })
    expect(count('nodes')).toBe(1)
    expect(count('operations')).toBe(1)
    expect(count('node_provision_acceptances')).toBe(0)
  })

  it('strictly rejects corrupted stored receipt metadata', async () => {
    const input = await makeInput(command())
    const repository = makeNodeProvisionRepositoryD1(d1)
    await Effect.runPromise(repository.acceptAtomic(input))
    database.exec('DROP TRIGGER node_provision_acceptances_immutable_update')
    database
      .prepare(`UPDATE node_provision_acceptances SET receipt_json = ?`)
      .run(JSON.stringify({ organizationId: 'org-a', plaintextCredential: 'secret' }))
    await expect(
      Effect.runPromise(
        repository.findReplay('org-a', input.command.idempotencyKey, input.fingerprint),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionPersistenceError' })
  })

  it('keeps immutable Contabo contract facts and requires explicit non-hourly confirmation', async () => {
    database.prepare("DELETE FROM provider_allocations WHERE organization_id = 'org-a'").run()
    database
      .prepare("UPDATE provider_accounts SET provider_type = 'contabo' WHERE id = 'account-a'")
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, monthly_budget_minor, status, revision)
      VALUES ('org-a', 'account-a', '["region-a"]', '["plan-a"]', 2, 10000, 'active', 5)`)
      .run()
    database.prepare("DELETE FROM provider_catalog WHERE provider_type = 'ovhcloud'").run()
    database
      .prepare(`INSERT INTO provider_catalog
      (provider_type, region, plan, currency, hourly_price_minor, monthly_price_minor,
       metadata_json, refreshed_at) VALUES ('contabo', 'region-a', 'plan-a', 'EUR', NULL, 1800, ?, ?)`)
      .run(
        JSON.stringify({
          schemaVersion: 1,
          billingCadence: 'contract',
          contractMonths: 12,
          validUntilEpochMilliseconds: nowEpoch + 86_400_000,
        }),
        nowIso,
      )
    database
      .prepare(`UPDATE node_images SET provider_mappings_json = ? WHERE id = 'image-a'`)
      .run(JSON.stringify({ contabo: { 'region-a': 'provider-image-contabo' } }))
    const unconfirmed = command('create-node-0003', {
      ...intent,
      nonHourlyCommitmentConfirmed: false,
    })
    await expect(
      Effect.runPromise(
        makeNodeProvisionControl({
          repository: makeNodeProvisionRepositoryD1(d1),
          facts: makeNodeProvisionFactsD1(d1, { nowEpochMilliseconds: () => nowEpoch }),
          policy: nodeProvisionPolicyAdmission,
          identities,
          registrationTokens,
          clock: { now: Effect.succeed({ iso: nowIso, epochMilliseconds: nowEpoch }) },
          workflows: { start: () => Effect.void },
        }).submit(unconfirmed),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionAdmissionDeniedError' })
    expect(count('operations')).toBe(0)
    const accepted = await makeInput(command('create-node-0004'))
    await Effect.runPromise(makeNodeProvisionRepositoryD1(d1).acceptAtomic(accepted))
    expect(() =>
      database
        .prepare(`UPDATE node_provision_contracts
      SET contract_months = 1 WHERE organization_id = 'org-a'`)
        .run(),
    ).toThrow('node provision contract is immutable')
  })

  it('fails closed when workflow start marks are missing or foreign', async () => {
    const input = await makeInput(command())
    const repository = makeNodeProvisionRepositoryD1(d1)
    await Effect.runPromise(repository.acceptAtomic(input))
    await expect(
      Effect.runPromise(repository.markWorkflowStarted('org-b', input.identity.operationId)),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionPersistenceError' })
    await Effect.runPromise(repository.markWorkflowStarted('org-a', input.identity.operationId))
    await expect(
      Effect.runPromise(
        repository.recordWorkflowStartFailure('org-a', input.identity.operationId, 'late failure'),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionPersistenceError' })
  })
})

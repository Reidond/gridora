import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { PlatformActor } from '@gridora/platform-authority'
import { PlatformAllocation, PlatformProviderAccount } from '@gridora/platform-provider-control'
import { PlatformSecretRecord } from '@gridora/platform-secret-envelope'
import {
  makePlatformProviderRepositoryD1,
  type D1Result,
  type D1Statement,
  type PlatformProviderD1Database,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
class Statement implements D1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(
    private db: DatabaseSync,
    private statement: StatementSync,
  ) {}
  bind(...values: ReadonlyArray<unknown>) {
    this.values = values
    return this
  }
  async first() {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all() {
    const results = this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>))
    return {
      results,
      meta: {
        changes: Number(
          (this.db.prepare('SELECT changes() changes').get() as { changes: number }).changes,
        ),
      },
    }
  }
}
class D1 implements PlatformProviderD1Database {
  lose = false
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string) {
    return new Statement(this.db, this.db.prepare(sql))
  }
  async batch(statements: ReadonlyArray<D1Statement>): Promise<ReadonlyArray<D1Result>> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.all())
      this.db.exec('COMMIT')
      if (this.lose) {
        this.lose = false
        throw new Error('response lost')
      }
      return results
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
let sqlite: DatabaseSync
let d1: D1
const actor = new PlatformActor({
  identityId: 'admin',
  accessSubject: 'access-admin',
  correlationId: 'corr',
  administratorRevision: 1,
})
const base = {
  actor,
  idempotencyKey: 'create-key',
  requestFingerprint: 'a'.repeat(64),
  operationId: 'platform-operation-create-key',
  operationIdempotencyKey: 'b'.repeat(64),
  auditEventId: 'platform-audit-create-key',
  now: '2026-08-23T10:00:00.000Z',
}
const auditRequestContext: AuditRequestContextValue = {
  origin: 'http',
  requestId: 'request-platform-provider',
  correlationId: actor.correlationId,
  source: {
    ip: { state: 'captured', value: '127.0.0.1' },
    access: {
      state: 'captured',
      value: {
        subject: actor.accessSubject,
        identityId: actor.identityId,
        issuer: 'https://access.example.test',
        email: 'admin@example.com',
      },
    },
  },
}
const makeRepository = () => makePlatformProviderRepositoryD1(d1, { auditRequestContext })
const account = new PlatformProviderAccount({
  id: 'platform-ovh',
  scope: 'platform',
  organizationId: null,
  providerType: 'ovhcloud',
  credentialReference: 'secret-platform-ovh',
  credentialRevision: 1,
  status: 'active',
  revision: 1,
  createdAt: base.now,
  updatedAt: base.now,
})
const secret = new PlatformSecretRecord({
  id: 'secret-platform-ovh',
  accountId: 'platform-ovh',
  ciphertext: 'v1.iv.cipher-canary',
  wrappedDataKey: 'wrapped-canary',
  keyVersion: 1,
  revision: 1,
  createdAt: base.now,
  rotatedAt: null,
})
const seed = () => {
  sqlite
    .prepare(
      `INSERT INTO identities(id,access_subject,email,display_name,status,signed_up_at,last_login_at) VALUES ('admin','access-admin','admin@example.com','Admin','active','now','now'),('owner','access-owner','owner@example.com','Owner','active','now','now')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO platform_administrators(identity_id,status,revision,granted_by,granted_at,updated_at) VALUES ('admin','active',1,'owner','now','now')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO organizations(id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at) VALUES ('org-a','A','a','active','UTC','eu','complete',1,1,'now')`,
    )
    .run()
}
describe('platform provider D1 repository', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const file of readdirSync(sqlDirectory)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort())
      sqlite.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    d1 = new D1(sqlite)
    seed()
  })
  afterEach(() => sqlite.close())
  it('atomically creates and exactly replays without exposing secret canaries', async () => {
    const repo = makeRepository()
    d1.lose = true
    await expect(
      Effect.runPromise(
        repo.createAccount({ ...base, account, secret, auditEventId: 'audit-create' }),
      ),
    ).rejects.toBeDefined()
    const replay = await Effect.runPromise(
      repo.findAccountReplay(base.idempotencyKey, base.requestFingerprint),
    )
    expect(replay).toEqual(account)
    expect(JSON.stringify(replay)).not.toContain('canary')
    expect(sqlite.prepare('SELECT count(*) count FROM global_audit_events').get()).toEqual({
      count: 1,
    })
    expect(
      sqlite
        .prepare(`SELECT id,type AS type,resource_type AS resourceType,resource_id AS resourceId,
          actor_id AS actorId,status,progress,idempotency_key AS idempotencyKey,
          payload_fingerprint AS payloadFingerprint
          FROM platform_operations WHERE id = ?`)
        .get(base.operationId),
    ).toEqual({
      id: base.operationId,
      type: 'platform.provider-account.create',
      resourceType: 'provider-account',
      resourceId: account.id,
      actorId: actor.identityId,
      status: 'succeeded',
      progress: 100,
      idempotencyKey: base.operationIdempotencyKey,
      payloadFingerprint: base.requestFingerprint,
    })
    expect(
      sqlite
        .prepare(`SELECT operation_id AS operationId, operation_idempotency_key AS operationIdempotencyKey,
          audit_event_id AS auditEventId FROM platform_provider_mutations WHERE idempotency_key = ?`)
        .get(base.idempotencyKey),
    ).toEqual({
      operationId: base.operationId,
      operationIdempotencyKey: base.operationIdempotencyKey,
      auditEventId: 'audit-create',
    })
    const envelope = JSON.parse(
      (
        sqlite
          .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes WHERE event_id = ?`)
          .get('audit-create') as { readonly envelope: string }
      ).envelope,
    ) as Record<string, unknown>
    expect(envelope).toMatchObject({
      version: 1,
      captureStatus: 'complete',
      operationId: base.operationId,
      action: 'platform.provider-account.create',
      target: { type: 'provider-account', id: account.id },
      source: { origin: 'http' },
    })
    expect(JSON.stringify(envelope)).not.toContain('canary')
  })
  it('rejects stale rotation and active execution lease account changes', async () => {
    const repo = makeRepository()
    await Effect.runPromise(
      repo.createAccount({ ...base, account, secret, auditEventId: 'audit-create' }),
    )
    await expect(
      Effect.runPromise(
        repo.updateAccount({
          ...base,
          idempotencyKey: 'rotate-stale',
          requestFingerprint: 'b'.repeat(64),
          operationId: 'platform-operation-rotate-stale',
          operationIdempotencyKey: 'c'.repeat(64),
          accountId: account.id,
          expectedRevision: 2,
          status: 'active',
          credentialRevision: 2,
          action: 'rotate',
          auditEventId: 'audit-rotate',
        }),
      ),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    sqlite
      .prepare(
        `INSERT INTO operations(id,organization_id,type,resource_type,resource_id,actor_id,status,idempotency_key,correlation_id,created_at,updated_at) VALUES ('op','org-a','node.create','node','node','admin','running','op-key','corr','now','now')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO node_images(id,version,checksum,signature,provider_mappings_json,status,created_at) VALUES ('img','1','sum','sig','{}','promoted','now')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO provider_allocations(organization_id,provider_account_id,allowed_regions_json,allowed_plans_json,max_active_nodes,status,revision) VALUES ('org-a','platform-ovh','["eu"]','["small"]',1,'active',1)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO nodes(organization_id,id,provider_account_id,provider_type,region,plan,image_id,placement_mode,desired_state,observed_state,desired_revision,observed_revision,pending_lifecycle_operation_id,created_at,updated_at) VALUES ('org-a','node','platform-ovh','ovhcloud','eu','small','img','shared','provisioning','unknown',1,0,'op','now','now')`,
      )
      .run()
    sqlite.exec('DROP TRIGGER node_provision_execution_lease_insert_fence')
    sqlite
      .prepare(
        `INSERT INTO node_provision_execution_leases(organization_id,operation_id,node_id,provider_account_id,provider_account_revision,provider_type,envelope_revision,derivation_token_hash,delivered_token_hash,bootstrap_expires_at,state,acquired_at) VALUES ('org-a','op','node','platform-ovh',1,'ovhcloud',1,?,?, 'later','active','now')`,
      )
      .run('d'.repeat(64), 'e'.repeat(64))
    expect(() =>
      sqlite.prepare(`UPDATE provider_accounts SET revision=2 WHERE id='platform-ovh'`).run(),
    ).toThrow(/active node provision execution/)
  })
  it('revision-fences tenant allocations and rejects cross-scope accounts', async () => {
    const repo = makeRepository()
    await Effect.runPromise(
      repo.createAccount({ ...base, account, secret, auditEventId: 'audit-create' }),
    )
    const allocation = new PlatformAllocation({
      organizationId: 'org-a',
      accountId: account.id,
      allowedRegions: ['eu'],
      allowedPlans: ['small'],
      maxActiveNodes: 2,
      monthlyBudgetMinor: 5000,
      status: 'active',
      revision: 1,
    })
    await expect(
      Effect.runPromise(
        repo.putAllocation({
          ...base,
          idempotencyKey: 'allocation',
          requestFingerprint: 'f'.repeat(64),
          operationId: 'platform-operation-allocation',
          operationIdempotencyKey: '1'.repeat(64),
          allocation,
          expectedRevision: 0,
          action: 'create',
          auditEventId: 'audit-allocation',
        }),
      ),
    ).resolves.toEqual(allocation)
    await expect(
      Effect.runPromise(
        repo.putAllocation({
          ...base,
          idempotencyKey: 'allocation-stale',
          requestFingerprint: '1'.repeat(64),
          operationId: 'platform-operation-allocation-stale',
          operationIdempotencyKey: '2'.repeat(64),
          allocation: new PlatformAllocation({
            organizationId: allocation.organizationId,
            accountId: allocation.accountId,
            allowedRegions: allocation.allowedRegions,
            allowedPlans: allocation.allowedPlans,
            maxActiveNodes: allocation.maxActiveNodes,
            monthlyBudgetMinor: allocation.monthlyBudgetMinor,
            status: allocation.status,
            revision: 2,
          }),
          expectedRevision: 0,
          action: 'update',
          auditEventId: 'audit-stale',
        }),
      ),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(
      sqlite
        .prepare(`SELECT type,resource_type AS resourceType,resource_id AS resourceId,
          idempotency_key AS idempotencyKey,payload_fingerprint AS payloadFingerprint,status,progress
          FROM platform_operations WHERE id = ?`)
        .get('platform-operation-allocation'),
    ).toEqual({
      type: 'platform.provider-allocation.create',
      resourceType: 'provider-allocation',
      resourceId: 'platform-allocation:org-a:platform-ovh',
      idempotencyKey: '1'.repeat(64),
      payloadFingerprint: 'f'.repeat(64),
      status: 'succeeded',
      progress: 100,
    })
    expect(
      sqlite
        .prepare(`SELECT operation_id AS operationId, operation_idempotency_key AS operationIdempotencyKey,
          audit_event_id AS auditEventId FROM platform_allocation_mutations WHERE idempotency_key = 'allocation'`)
        .get(),
    ).toEqual({
      operationId: 'platform-operation-allocation',
      operationIdempotencyKey: '1'.repeat(64),
      auditEventId: 'audit-allocation',
    })

    sqlite
      .prepare(
        `INSERT INTO provider_accounts
          (id,scope,organization_id,provider_type,credential_reference,status,revision,created_at,updated_at)
         VALUES ('tenant-contabo','organization','org-a','contabo','tenant-contabo.credentials','active',1,'now','now')`,
      )
      .run()
    const foreignAllocation = new PlatformAllocation({
      organizationId: 'org-a',
      accountId: 'tenant-contabo',
      allowedRegions: ['eu'],
      allowedPlans: ['small'],
      maxActiveNodes: 1,
      monthlyBudgetMinor: null,
      status: 'active',
      revision: 1,
    })
    await expect(
      Effect.runPromise(
        repo.putAllocation({
          ...base,
          idempotencyKey: 'allocation-foreign',
          requestFingerprint: '3'.repeat(64),
          operationId: 'platform-operation-allocation-foreign',
          operationIdempotencyKey: '4'.repeat(64),
          allocation: foreignAllocation,
          expectedRevision: 0,
          action: 'create',
          auditEventId: 'audit-allocation-foreign',
        }),
      ),
    ).rejects.toMatchObject({ code: 'persistence' })
    expect(
      sqlite
        .prepare(`SELECT count(*) AS count FROM platform_operations
          WHERE id = 'platform-operation-allocation-foreign'`)
        .get(),
    ).toEqual({ count: 0 })
    expect(
      sqlite
        .prepare(
          `SELECT count(*) AS count FROM global_audit_events WHERE id = 'audit-allocation-foreign'`,
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      sqlite
        .prepare(`SELECT count(*) AS count FROM platform_allocation_mutations
          WHERE idempotency_key = 'allocation-foreign'`)
        .get(),
    ).toEqual({ count: 0 })
  })
})

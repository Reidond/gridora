import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OrphanSymmetryClockLayer,
  OrphanSymmetryControl,
  OrphanSymmetryControlLive,
  OrphanSymmetryDiscoveryLayer,
  OrphanSymmetryRepositoryLayer,
  type OrphanSymmetryObservedResource,
} from '@gridora/orphan-control'
import {
  listOpenOrphanSymmetryEvidence,
  loadOrphanSymmetryAgentObservationPage,
  loadOrphanSymmetryDnsAuthorities,
  loadOrphanSymmetryTunnelAuthorities,
  makeOrphanSymmetryD1Repository,
  type OrphanD1Database,
  type OrphanD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = readdirSync(sqlDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

class Statement implements OrphanD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): OrphanD1Statement {
    const bound = new Statement(this.statement)
    bound.values = values
    return bound
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

class SqliteD1 implements OrphanD1Database {
  loseNextResponse = false
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): OrphanD1Statement {
    return new Statement(this.database.prepare(sql))
  }
  async batch(statements: ReadonlyArray<OrphanD1Statement>): Promise<ReadonlyArray<unknown>> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) (statement as Statement).run()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      throw new Error('simulated D1 response loss')
    }
    return statements.map(() => ({}))
  }
}

const unmanagedBackup: OrphanSymmetryObservedResource = {
  organizationId: 'org-a',
  kind: 'backup-object',
  resourceKey: 'organizations/org-a/servers/server-a/backups/unknown',
  resourceId: 'unknown-backup-object',
  nodeId: null,
  fingerprint: `sha256:${'a'.repeat(64)}`,
  ownerScope: 'unmanaged',
  observedAt: '2026-08-24T10:00:00.000Z',
}

describe('D1 orphan symmetry evidence', () => {
  let database: DatabaseSync
  let d1: SqliteD1
  let actorId: string

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    d1 = new SqliteD1(database)
    database
      .prepare(`INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step,
         policy_revision, revision, created_at)
        VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC',
          'eu-west', 'complete', 1, 1, '2026-08-24T09:00:00.000Z')`)
      .run()
    actorId = (
      database
        .prepare(`SELECT identity_id AS actorId
          FROM orphan_reconciliation_scheduler_identities WHERE organization_id = 'org-a'`)
        .get() as { readonly actorId: string }
    ).actorId
  })

  afterEach(() => database.close())

  const run = async (runId: string, resources: ReadonlyArray<OrphanSymmetryObservedResource>) => {
    const repository = makeOrphanSymmetryD1Repository(d1, {
      now: () => '2026-08-24T10:01:00.000Z',
    })
    const dependencies = Layer.mergeAll(
      OrphanSymmetryDiscoveryLayer({
        discoverPage: (_request, cursor) =>
          Effect.succeed({
            organizationId: 'org-a',
            runId,
            cursor,
            nextCursor: null,
            complete: true,
            resources,
          }),
      }),
      OrphanSymmetryRepositoryLayer(repository),
      OrphanSymmetryClockLayer(new Date('2026-08-24T10:01:00.000Z')),
    )
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* OrphanSymmetryControl).reconcile({
          organizationId: 'org-a',
          actorId,
          runId,
          idempotencyKey: `idempotency-${runId}`,
        })
      }).pipe(Effect.provide(OrphanSymmetryControlLive.pipe(Layer.provide(dependencies)))),
    )
  }

  it('atomically stores one high-severity finding and one complete v1 scan audit', async () => {
    const result = await run('symmetry-run-a', [unmanagedBackup])
    expect(result).toMatchObject({ opened: 1, replayed: false })
    expect(
      database
        .prepare(`SELECT severity, status, resource_kind AS resourceKind, reason, recommendation
          FROM orphan_symmetry_findings`)
        .get(),
    ).toEqual({
      severity: 'high',
      status: 'open',
      resourceKind: 'backup-object',
      reason: 'unmanaged-observed',
      recommendation: 'inspect-r2-prefix-and-backup-catalog',
    })
    expect(
      database
        .prepare(`SELECT operation.status, operation.resource_type AS resourceType,
          json_extract(envelope.envelope_json, '$.version') AS version,
          json_extract(envelope.envelope_json, '$.captureStatus') AS captureStatus,
          json_extract(envelope.envelope_json, '$.source.origin') AS origin,
          json_extract(envelope.envelope_json, '$.after.summary.destructiveActions') AS destructiveActions
          FROM orphan_symmetry_runs run
          JOIN operations operation
            ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
          JOIN audit_event_envelopes envelope
            ON envelope.scope = 'tenant' AND envelope.organization_id = run.organization_id
           AND envelope.event_id = run.audit_event_id`)
        .get(),
    ).toEqual({
      status: 'succeeded',
      resourceType: 'organization',
      version: 1,
      captureStatus: 'complete',
      origin: 'scheduler',
      destructiveActions: 0,
    })
    const immutableRun = database
      .prepare(`SELECT findings_json AS findingsJson FROM orphan_symmetry_runs`)
      .get() as { readonly findingsJson: string }
    expect(JSON.parse(immutableRun.findingsJson)).toEqual([
      expect.objectContaining({
        kind: 'backup-object',
        reason: 'unmanaged-observed',
        severity: 'high',
      }),
    ])
    expect(() =>
      database
        .prepare(`INSERT INTO orphan_symmetry_findings
          (organization_id, resource_kind, resource_key, reason, resource_id,
           node_id, severity, status, expected_fingerprint, observed_fingerprint,
           recommendation, first_detected_at, last_detected_at, last_run_id,
           resolved_at, revision)
          VALUES ('org-a', 'backup-object',
            'organizations/org-a/servers/server-a/backups/forged',
            'unmanaged-observed', 'forged', NULL, 'high', 'open', NULL,
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'inspect-r2-prefix-and-backup-catalog',
            '2026-08-24T10:01:00.000Z', '2026-08-24T10:01:00.000Z',
            'symmetry-run-a', NULL, 1)`)
        .run(),
    ).toThrow(/finding scope failed/)
    await expect(
      Effect.runPromise(
        listOpenOrphanSymmetryEvidence(d1, {
          organizationId: 'org-a',
          actorId,
          limit: 25,
        }),
      ),
    ).resolves.toMatchObject({
      items: [
        {
          severity: 'high',
          kind: 'backup-object',
          reason: 'unmanaged-observed',
          recommendation: 'inspect-r2-prefix-and-backup-catalog',
        },
      ],
      nextCursor: null,
    })
  })

  it('adopts the exact committed result after a lost D1 response', async () => {
    d1.loseNextResponse = true
    const result = await run('symmetry-run-loss', [unmanagedBackup])
    expect(result).toMatchObject({ opened: 1, replayed: true })
    expect(database.prepare('SELECT COUNT(*) AS count FROM orphan_symmetry_runs').get()).toEqual({
      count: 1,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
      count: 1,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM audit_envelope_staging').get()).toEqual({
      count: 0,
    })
  })

  it('resolves metadata only after a later complete scan restores symmetry', async () => {
    await run('symmetry-run-open', [unmanagedBackup])
    const result = await run('symmetry-run-resolve', [])
    expect(result).toMatchObject({ resolved: 1, replayed: false })
    expect(
      database
        .prepare('SELECT status, resolved_at AS resolvedAt, revision FROM orphan_symmetry_findings')
        .get(),
    ).toEqual({ status: 'resolved', resolvedAt: '2026-08-24T10:01:00.000Z', revision: 2 })
    expect(() => database.prepare('DELETE FROM orphan_symmetry_findings').run()).toThrow(
      /history is immutable/,
    )
  })

  it('rejects a foreign or inactive actor before discovery persistence', async () => {
    actorId = 'foreign-actor'
    database
      .prepare(`INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('foreign-actor', 'foreign', 'foreign@example.test', 'Foreign', 'active',
          '2026-08-24T09:00:00.000Z', '2026-08-24T09:00:00.000Z')`)
      .run()
    await expect(run('symmetry-run-foreign', [unmanagedBackup])).rejects.toMatchObject({
      code: 'invalid-scope',
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM orphan_symmetry_runs').get()).toEqual({
      count: 0,
    })
  })

  it('executes production agent, DNS, and Tunnel reads in exact tenant scope', async () => {
    const command = {
      organizationId: 'org-a',
      actorId,
      runId: 'symmetry-production-read',
      idempotencyKey: 'symmetry-production-read',
    }
    await expect(
      Effect.runPromise(loadOrphanSymmetryAgentObservationPage(d1, command, null)),
    ).resolves.toEqual({ resources: [], nextCursor: null })
    await expect(Effect.runPromise(loadOrphanSymmetryDnsAuthorities(d1, command))).resolves.toEqual(
      [],
    )
    await expect(
      Effect.runPromise(loadOrphanSymmetryTunnelAuthorities(d1, command)),
    ).resolves.toEqual([])
    await expect(
      Effect.runPromise(
        loadOrphanSymmetryAgentObservationPage(d1, { ...command, organizationId: 'org-b' }, null),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })
})

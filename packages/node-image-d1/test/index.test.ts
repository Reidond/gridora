import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { PlatformActor } from '@gridora/platform-authority'
import type {
  NodeImageAtomicInput,
  NodeImageCommand,
  NodeImageIdentity,
} from '@gridora/node-image-control'
import { makeWebCryptoNodeImageIdentity } from '@gridora/node-image-control'
import {
  makeNodeImageExecutionRepositoryD1,
  makeNodeImageRepositoryD1,
  type NodeImageD1Database,
  type NodeImageD1Result,
  type NodeImageD1Statement,
} from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const now = '2026-08-23T12:00:00.000Z'
const digest = (character: string) => `sha256:${character.repeat(64)}`
const sourceCommit = 'a'.repeat(40)

class Statement implements NodeImageD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: ReadonlyArray<SQLInputValue> = [],
  ) {}

  bind(...values: ReadonlyArray<unknown>): NodeImageD1Statement {
    return new Statement(this.database, this.sql, values as ReadonlyArray<SQLInputValue>)
  }

  async first(): Promise<unknown> {
    return this.database.prepare(this.sql).get(...this.values) ?? null
  }

  async all(): Promise<NodeImageD1Result> {
    const statement = this.database.prepare(this.sql)
    const result = statement.all(...this.values)
    const changes = Number(
      (this.database.prepare('SELECT changes() AS changes').get() as { changes: number }).changes,
    )
    return { results: result, meta: { changes } }
  }

  run(): NodeImageD1Result {
    const result = this.database.prepare(this.sql).run(...this.values)
    return { results: [], meta: { changes: Number(result.changes) } }
  }
}

class D1 implements NodeImageD1Database {
  loseResponse = false
  beforeBatch: ((statements: ReadonlyArray<NodeImageD1Statement>) => Promise<void>) | undefined
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): NodeImageD1Statement {
    return new Statement(this.sqlite, sql)
  }

  async batch(
    statements: ReadonlyArray<NodeImageD1Statement>,
  ): Promise<ReadonlyArray<NodeImageD1Result>> {
    await this.beforeBatch?.(statements)
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement))
          throw new Error('unexpected statement implementation')
        return statement.run()
      })
      this.sqlite.exec('COMMIT')
      if (this.loseResponse) {
        this.loseResponse = false
        throw new Error('response lost after D1 commit')
      }
      return results
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

let sqlite: DatabaseSync
let database: D1

const applyAllMigrations = () => {
  for (const file of readdirSync(sqlDirectory)
    .filter((entry) => /^\d{4}_.*\.sql$/.test(entry))
    .sort())
    sqlite.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
}

const seedPlatform = () => {
  sqlite
    .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('platform-admin', 'access-platform-admin', 'admin@example.test', 'Platform admin', 'active', ?, ?),
             ('organization-owner', 'access-organization-owner', 'owner@example.test', 'Owner', 'active', ?, ?)`)
    .run(now, now, now, now)
  sqlite
    .prepare(`INSERT INTO platform_administrators
      (identity_id, status, revision, granted_by, granted_at, updated_at)
      VALUES ('platform-admin', 'active', 1, 'organization-owner', ?, ?)`)
    .run(now, now)
  sqlite
    .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('platform-ovh', 'platform', NULL, 'ovhcloud', 'platform-secret-ovh', 'active', 1, ?, ?),
             ('platform-contabo', 'platform', NULL, 'contabo', 'platform-secret-contabo', 'active', 1, ?, ?)`)
    .run(now, now, now, now)
}

const actor = new PlatformActor({
  identityId: 'platform-admin',
  accessSubject: 'access-platform-admin',
  correlationId: 'correlation-node-image',
  administratorRevision: 1,
})
const auditRequestContextFor = (currentActor: PlatformActor): AuditRequestContextValue => ({
  origin: 'http',
  requestId: 'request-node-image',
  correlationId: currentActor.correlationId,
  source: {
    ip: { state: 'captured', value: '127.0.0.1' },
    access: {
      state: 'captured',
      value: {
        subject: currentActor.accessSubject,
        identityId: currentActor.identityId,
        issuer: 'https://access.example.test',
        email:
          currentActor.identityId === 'platform-admin'
            ? 'admin@example.test'
            : 'owner@example.test',
      },
    },
  },
})
const makeRepository = (currentActor: PlatformActor = actor) =>
  makeNodeImageRepositoryD1(database, { auditRequestContext: auditRequestContextFor(currentActor) })
const organizationOnlyActor = new PlatformActor({
  identityId: 'organization-owner',
  accessSubject: 'access-organization-owner',
  correlationId: 'correlation-organization-owner',
  administratorRevision: 1,
})
const identity = (suffix: string): NodeImageIdentity => ({
  operationId: `image-op_${suffix}`,
  workflowStartRecordId: `image-workflow-start:${suffix}`,
  auditEventId: `audit-image_${suffix}`,
  outboxEventId: `outbox-image_${suffix}`,
})
const fingerprint = (character: string) => character.repeat(64)
const command = (
  kind: NodeImageCommand['kind'],
  overrides: Record<string, unknown> = {},
): NodeImageCommand => {
  switch (kind) {
    case 'create':
      return {
        actor,
        idempotencyKey: 'node-image-create-0001',
        correlationId: actor.correlationId,
        kind,
        intent: {
          schemaVersion: 1,
          imageId: 'node-image-20260823',
          version: '2026.08.23.1',
          sourceCommit,
          architecture: 'amd64',
          artifactDigest: digest('a'),
          manifestDigest: digest('b'),
          sbomDigest: digest('c'),
          buildLogDigest: digest('d'),
          signature: {
            schemaVersion: 1,
            algorithm: 'ed25519',
            manifestDigest: digest('b'),
            detachedSignatureDigest: digest('e'),
            publicKeyDigest: digest('f'),
          },
          ...overrides,
        },
      }
    case 'configure-scope':
      return {
        actor,
        idempotencyKey: 'node-image-scope-0001',
        correlationId: actor.correlationId,
        kind,
        intent: {
          schemaVersion: 1,
          scopeId: 'scope-ovh-gra',
          providerType: 'ovhcloud',
          providerAccountId: 'platform-ovh',
          region: 'GRA11',
          architecture: 'amd64',
          allowStockUbuntuCloudInitFallback: false,
          expectedScopeRevision: 0,
          ...overrides,
        },
      }
    case 'register-provider':
      return {
        actor,
        idempotencyKey: 'node-image-registration-0001',
        correlationId: actor.correlationId,
        kind,
        imageId: 'node-image-20260823',
        intent: {
          schemaVersion: 1,
          scopeId: 'scope-ovh-gra',
          expectedImageRevision: 1,
          expectedScopeRevision: 1,
          expectedRegistrationRevision: 0,
          registration: {
            mode: 'stock-ubuntu-cloud-init',
            stockImageId: 'ubuntu-2404',
            cloudInitTemplateDigest: digest('7'),
          },
          ...overrides,
        },
      }
    default:
      throw new Error(`unsupported fixture command ${kind}`)
  }
}
const input = (
  nextCommand: NodeImageCommand,
  suffix: string,
  requestFingerprint = fingerprint('a'),
): NodeImageAtomicInput => ({
  command: nextCommand,
  identity: identity(suffix),
  requestFingerprint,
  verifiedTestingEvidence: null,
  now,
})

const startWorkflow = (operationId: string) => {
  sqlite
    .prepare(`UPDATE platform_node_image_workflow_starts
      SET state = 'started', attempts = attempts + 1, updated_at = ?
      WHERE operation_id = ? AND state = 'pending'`)
    .run(now, operationId)
}
const claimInput = (input: {
  readonly reservation: {
    readonly operationId: string
    readonly workflowStartRecordId: string
    readonly requestFingerprint: string
    readonly action: NodeImageCommand['kind']
    readonly imageId: string | null
    readonly scopeId: string | null
    readonly commandJson: string
  }
  readonly now: string
  readonly suffix: string
}) => ({
  reservation: input.reservation,
  now: input.now,
  claimId: `node-image-claim:${input.suffix}`,
  leaseExpiresAt: new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString(),
  recoveryDeadlineAtEpochMs: Date.parse(input.now) + 60 * 60 * 1000,
})

describe('node image D1 acceptance', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    applyAllMigrations()
    database = new D1(sqlite)
    seedPlatform()
  })
  afterEach(() => sqlite.close())

  it('records an image acceptance with atomic platform audit, outbox, and workflow facts', async () => {
    const repository = makeRepository()
    const created = await Effect.runPromise(
      repository.acceptAtomic(input(command('create'), 'create-a')),
    )
    expect(created).toMatchObject({
      disposition: 'created',
      operation: { action: 'create', state: 'queued' },
      workflowStart: { state: 'pending', workflowType: 'NodeImageLifecycleWorkflow' },
    })
    expect(
      sqlite
        .prepare(`SELECT state, revision, legacy_unattested AS legacyUnattested
      FROM node_image_lifecycle_records WHERE image_id = 'node-image-20260823'`)
        .get(),
    ).toEqual({
      state: 'building',
      revision: 1,
      legacyUnattested: 0,
    })
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM global_audit_events`).get()).toEqual({
      count: 1,
    })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_outbox`).get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_workflow_starts`).get(),
    ).toEqual({ count: 1 })

    const replay = await Effect.runPromise(
      repository.acceptAtomic(input(command('create'), 'other-identity')),
    )
    expect(replay.disposition).toBe('adopted')
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_operations`).get(),
    ).toEqual({ count: 1 })
  })

  it('accepts with the exact real WebCrypto audit identity instead of a string-derived convention', async () => {
    const repository = makeRepository()
    const nextCommand = command('create')
    const identities = makeWebCryptoNodeImageIdentity()
    const requestFingerprint = await Effect.runPromise(identities.fingerprint(nextCommand))
    const derived = await Effect.runPromise(identities.derive(nextCommand, requestFingerprint))
    const accepted = await Effect.runPromise(
      repository.acceptAtomic({
        command: nextCommand,
        identity: derived,
        requestFingerprint,
        verifiedTestingEvidence: null,
        now,
      }),
    )
    expect(accepted.operation.id).toBe(derived.operationId)
    expect(
      sqlite
        .prepare(`SELECT audit_event_id AS auditEventId FROM platform_node_image_operations`)
        .get(),
    ).toEqual({ auditEventId: derived.auditEventId })
  })

  it('adopts an exact response-loss retry without creating another lifecycle operation', async () => {
    const repository = makeRepository()
    database.loseResponse = true
    await expect(
      Effect.runPromise(repository.acceptAtomic(input(command('create'), 'response-loss'))),
    ).rejects.toMatchObject({ _tag: 'NodeImageConflictError' })
    const replay = await Effect.runPromise(
      repository.findReplay('node-image-create-0001', fingerprint('a')),
    )
    expect(replay).not.toBeNull()
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_operations`).get(),
    ).toEqual({ count: 1 })
  })

  it('rejects a scope update that forges immutable provider coordinates before a batch', async () => {
    const repository = makeRepository()
    await Effect.runPromise(
      repository.acceptAtomic(input(command('configure-scope'), 'scope-create', fingerprint('b'))),
    )
    const forged = command('configure-scope', {
      providerType: 'contabo',
      providerAccountId: 'platform-contabo',
      region: 'SIN',
      expectedScopeRevision: 1,
      allowStockUbuntuCloudInitFallback: true,
    })
    const result = await Effect.runPromiseExit(
      repository.acceptAtomic(
        input(
          { ...forged, idempotencyKey: 'node-image-scope-forged-0001' },
          'scope-forged',
          fingerprint('c'),
        ),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(JSON.stringify(result.cause)).toContain('scope_mismatch')
    expect(
      sqlite
        .prepare(`SELECT revision, provider_type AS providerType, provider_account_id AS providerAccountId
      FROM node_image_policy_scopes WHERE id = 'scope-ovh-gra'`)
        .get(),
    ).toEqual({
      revision: 1,
      providerType: 'ovhcloud',
      providerAccountId: 'platform-ovh',
    })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_operations`).get(),
    ).toEqual({ count: 1 })
  })

  it('keeps a final SQL acceptance fence when an already-staged scope command has forged coordinates', async () => {
    const repository = makeRepository()
    await Effect.runPromise(
      repository.acceptAtomic(input(command('configure-scope'), 'scope-create', fingerprint('b'))),
    )
    sqlite
      .prepare(`UPDATE node_image_policy_scopes
        SET allow_stock_ubuntu_cloud_init_fallback = 1, revision = 2, updated_at = ?
        WHERE id = 'scope-ovh-gra' AND revision = 1`)
      .run(now)
    const forgedCommand = JSON.stringify({
      kind: 'configure-scope',
      scopeId: 'scope-ovh-gra',
      intent: {
        schemaVersion: 1,
        scopeId: 'scope-ovh-gra',
        providerType: 'contabo',
        providerAccountId: 'platform-contabo',
        region: 'SIN',
        architecture: 'amd64',
        allowStockUbuntuCloudInitFallback: true,
        expectedScopeRevision: 1,
      },
      resultScopeRevision: 2,
    })
    expect(() =>
      sqlite
        .prepare(`INSERT INTO platform_node_image_operations
          (id, action, image_id, scope_id, actor_id, actor_administrator_revision, audit_event_id,
           idempotency_key, request_fingerprint, command_json,
           state, revision, created_at, updated_at)
          VALUES ('image-op_forged-sql', 'configure-scope', NULL, 'scope-ovh-gra', 'platform-admin', 1,
            'audit-image_forged-sql', 'node-image-scope-forged-sql', ?, ?, 'queued', 1, ?, ?)`)
        .run(fingerprint('c'), forgedCommand, now, now),
    ).toThrow(/node image operation acceptance revision fence failed/)
  })

  it('permits a stock Ubuntu fallback only when the immutable scope policy explicitly enables it', async () => {
    const repository = makeRepository()
    await Effect.runPromise(repository.acceptAtomic(input(command('create'), 'create-a')))
    await Effect.runPromise(
      repository.acceptAtomic(input(command('configure-scope'), 'scope-create', fingerprint('b'))),
    )
    await expect(
      Effect.runPromise(
        repository.acceptAtomic(
          input(command('register-provider'), 'fallback-denied', fingerprint('c')),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeImageConflictError', code: 'fallback_not_allowed' })

    await Effect.runPromise(
      repository.acceptAtomic(
        input(
          {
            ...command('configure-scope', {
              expectedScopeRevision: 1,
              allowStockUbuntuCloudInitFallback: true,
            }),
            idempotencyKey: 'node-image-scope-enable-fallback-0001',
          },
          'scope-enable-fallback',
          fingerprint('d'),
        ),
      ),
    )
    await Effect.runPromise(
      repository.acceptAtomic(
        input(
          {
            ...command('register-provider', { expectedScopeRevision: 2 }),
            idempotencyKey: 'node-image-fallback-approved-0001',
          },
          'fallback-approved',
          fingerprint('e'),
        ),
      ),
    )
    expect(
      sqlite
        .prepare(`SELECT mode, state, degraded_reason AS degradedReason
      FROM node_image_provider_registrations`)
        .get(),
    ).toEqual({
      mode: 'stock-ubuntu-cloud-init',
      state: 'degraded',
      degradedReason: 'stock-ubuntu-cloud-init',
    })
  })

  it('rejects organization-only identities at the platform operation ledger', async () => {
    const repository = makeRepository(organizationOnlyActor)
    const unprivileged = command('create')
    await expect(
      Effect.runPromise(
        repository.acceptAtomic(
          input(
            {
              ...unprivileged,
              actor: organizationOnlyActor,
              correlationId: organizationOnlyActor.correlationId,
              idempotencyKey: 'node-image-organization-role-0001',
            },
            'organization-only',
            fingerprint('f'),
          ),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeImageConflictError' })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_operations`).get(),
    ).toEqual({ count: 0 })
  })

  it('rejects an ABA platform administrator revision after authorization changes', async () => {
    const repository = makeRepository()
    sqlite
      .prepare(`UPDATE platform_administrators SET revision = 2, updated_at = ?
        WHERE identity_id = 'platform-admin' AND revision = 1`)
      .run(now)
    await expect(
      Effect.runPromise(
        repository.acceptAtomic(input(command('create'), 'admin-revision-stale', fingerprint('9'))),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeImageConflictError' })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM platform_node_image_operations`).get(),
    ).toEqual({ count: 0 })
  })

  it('bridges historical candidate and retired images without declaring them modern attested promotions', () => {
    sqlite.close()
    sqlite = new DatabaseSync(':memory:')
    for (const file of readdirSync(sqlDirectory)
      // This fixture is a pre-0023 historical database. Later migrations may
      // legitimately depend on node-image tables introduced by 0023, so they
      // cannot be applied while proving the one-way bridge itself.
      .filter((entry) => /^\d{4}_.*\.sql$/.test(entry) && entry < '0023_')
      .sort())
      sqlite.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    sqlite
      .prepare(`INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
        VALUES ('legacy-candidate', 'legacy-candidate', ?, 'legacy-signature', '{}', 'candidate', ?, NULL),
               ('legacy-retired', 'legacy-retired', ?, 'legacy-signature', '{}', 'retired', ?, ?)`)
      .run(digest('8'), now, digest('9'), now, now)
    sqlite.exec(readFileSync(`${sqlDirectory}0023_node_image_lifecycle.sql`, 'utf8'))
    expect(
      sqlite
        .prepare(`SELECT image_id AS imageId, state, legacy_unattested AS legacyUnattested
      FROM node_image_lifecycle_records ORDER BY image_id`)
        .all(),
    ).toEqual([
      { imageId: 'legacy-candidate', state: 'testing', legacyUnattested: 1 },
      { imageId: 'legacy-retired', state: 'deprecated', legacyUnattested: 1 },
    ])
  })

  it('recovers an expired exact claim after a worker crash and completes a local D1 transition once', async () => {
    const acceptance = makeRepository()
    const created = await Effect.runPromise(
      acceptance.acceptAtomic(input(command('create'), 'lease-create')),
    )
    startWorkflow(created.operation.id)
    const execution = makeNodeImageExecutionRepositoryD1(database)
    const reservation = await Effect.runPromise(
      execution.loadExact({
        operationId: created.operation.id,
        workflowStartRecordId: created.workflowStart.id,
        requestFingerprint: created.operation.requestFingerprint,
      }),
    )
    const first = await Effect.runPromise(
      execution.claimExact(claimInput({ reservation, now, suffix: 'first-claim-000001' })),
    )
    expect(first).toMatchObject({ disposition: 'execute', claimAttempt: 1 })
    const stillLeased = await Effect.runPromise(
      execution.claimExact(
        claimInput({ reservation, now: '2026-08-23T12:01:00.000Z', suffix: 'second-claim-00002' }),
      ),
    )
    expect(stillLeased).toMatchObject({ disposition: 'waiting-external', claimId: null })
    const recovered = await Effect.runPromise(
      execution.claimExact(
        claimInput({ reservation, now: '2026-08-23T12:06:00.000Z', suffix: 'recovered-claim-003' }),
      ),
    )
    expect(recovered).toMatchObject({ disposition: 'execute', claimAttempt: 2 })
    await expect(
      Effect.runPromise(
        execution.completeLocal({
          reservation,
          claim: recovered,
          now: '2026-08-23T12:06:00.000Z',
        }),
      ),
    ).resolves.toEqual({ status: 'completed' })
    expect(sqlite.prepare(`SELECT state FROM platform_node_image_step_receipts`).get()).toEqual({
      state: 'completed',
    })
    expect(
      sqlite
        .prepare(`SELECT state FROM platform_node_image_operations WHERE id = ?`)
        .get(created.operation.id),
    ).toEqual({
      state: 'succeeded',
    })
  })

  it('recovers a response-lost custom-image create as metadata-only adoption and records a terminal account fence', async () => {
    const acceptance = makeRepository()
    await Effect.runPromise(
      acceptance.acceptAtomic(input(command('create'), 'provider-create', fingerprint('a'))),
    )
    await Effect.runPromise(
      acceptance.acceptAtomic(
        input(command('configure-scope'), 'provider-scope', fingerprint('b')),
      ),
    )
    const registration = await Effect.runPromise(
      acceptance.acceptAtomic(
        input(
          {
            ...command('register-provider', { registration: { mode: 'custom-image' } }),
            idempotencyKey: 'node-image-custom-registration-0001',
          },
          'provider-register',
          fingerprint('c'),
        ),
      ),
    )
    startWorkflow(registration.operation.id)
    const execution = makeNodeImageExecutionRepositoryD1(database)
    const reservation = await Effect.runPromise(
      execution.loadExact({
        operationId: registration.operation.id,
        workflowStartRecordId: registration.workflowStart.id,
        requestFingerprint: registration.operation.requestFingerprint,
      }),
    )
    const first = await Effect.runPromise(
      execution.claimExact(claimInput({ reservation, now, suffix: 'provider-first-claim' })),
    )
    const initialWork = await Effect.runPromise(
      execution.registrationWork({ reservation, claim: first }),
    )
    expect(initialWork).toMatchObject({ mustAdoptOnly: false, adoptionAttempt: 0 })

    // The provider may have accepted a paid image immediately before this worker crashed.
    // The expired lease therefore never regains create permission.
    await Effect.runPromise(execution.beginProviderDispatch({ reservation, claim: first, now }))
    const recovered = await Effect.runPromise(
      execution.claimExact(
        claimInput({
          reservation,
          now: '2026-08-23T12:06:00.000Z',
          suffix: 'provider-recovered-02',
        }),
      ),
    )
    const recoveredWork = await Effect.runPromise(
      execution.registrationWork({ reservation, claim: recovered }),
    )
    expect(recoveredWork).toMatchObject({ mustAdoptOnly: true, adoptionAttempt: 1 })
    expect(recoveredWork.adoptionDeadlineAtEpochMs).toBe(Date.parse(now) + 60 * 60 * 1000)

    sqlite
      .prepare(`UPDATE provider_accounts
        SET credential_reference = 'platform-secret-ovh-r2', revision = 2, updated_at = ?
        WHERE id = 'platform-ovh' AND revision = 1`)
      .run('2026-08-23T12:06:00.000Z')
    const rotatedPreflight = await Effect.runPromiseExit(
      execution.preflightProviderRegistration({ reservation, claim: recovered }),
    )
    expect(rotatedPreflight._tag).toBe('Failure')
    sqlite
      .prepare(`UPDATE provider_accounts SET status = 'disabled', revision = 3, updated_at = ?
        WHERE id = 'platform-ovh' AND revision = 2`)
      .run('2026-08-23T12:06:00.000Z')
    const disabledPreflight = await Effect.runPromiseExit(
      execution.preflightProviderRegistration({ reservation, claim: recovered }),
    )
    expect(disabledPreflight._tag).toBe('Failure')
    await expect(
      Effect.runPromise(
        execution.failTerminal({
          reservation,
          claim: recovered,
          now: '2026-08-23T12:06:00.000Z',
          code: 'provider_account_unavailable',
        }),
      ),
    ).resolves.toEqual({ status: 'failed-terminal' })
    expect(
      sqlite
        .prepare(`SELECT state FROM platform_node_image_operations WHERE id = ?`)
        .get(registration.operation.id),
    ).toEqual({
      state: 'failed-terminal',
    })
    expect(
      sqlite
        .prepare(`SELECT failure_code AS failureCode FROM platform_node_image_terminal_outbox`)
        .get(),
    ).toEqual({
      failureCode: 'provider_account_unavailable',
    })
    const replay = await Effect.runPromise(
      execution.claimExact(
        claimInput({
          reservation,
          now: '2026-08-23T12:07:00.000Z',
          suffix: 'provider-terminal-reply',
        }),
      ),
    )
    expect(replay).toMatchObject({ disposition: 'failed-terminal', claimId: null })
  })

  it('keeps create permission after a released pre-dispatch dependency failure, then fences a post-dispatch crash to adoption', async () => {
    const acceptance = makeRepository()
    await Effect.runPromise(
      acceptance.acceptAtomic(input(command('create'), 'predispatch-create', fingerprint('1'))),
    )
    await Effect.runPromise(
      acceptance.acceptAtomic(
        input(command('configure-scope'), 'predispatch-scope', fingerprint('2')),
      ),
    )
    const registered = await Effect.runPromise(
      acceptance.acceptAtomic(
        input(
          {
            ...command('register-provider', { registration: { mode: 'custom-image' } }),
            idempotencyKey: 'node-image-predispatch-registration-0001',
          },
          'predispatch-register',
          fingerprint('3'),
        ),
      ),
    )
    startWorkflow(registered.operation.id)
    const execution = makeNodeImageExecutionRepositoryD1(database)
    const reservation = await Effect.runPromise(
      execution.loadExact({
        operationId: registered.operation.id,
        workflowStartRecordId: registered.workflowStart.id,
        requestFingerprint: registered.operation.requestFingerprint,
      }),
    )
    const first = await Effect.runPromise(
      execution.claimExact(claimInput({ reservation, now, suffix: 'predispatch-first-01' })),
    )
    await expect(
      Effect.runPromise(
        execution.releasePreDispatch({
          reservation,
          claim: first,
          now,
          code: 'artifact_locator_unavailable',
        }),
      ),
    ).resolves.toEqual({ status: 'waiting-external' })
    const retry = await Effect.runPromise(
      execution.claimExact(
        claimInput({
          reservation,
          now: '2026-08-23T12:01:00.000Z',
          suffix: 'predispatch-retry-02',
        }),
      ),
    )
    expect(retry).toMatchObject({ disposition: 'execute', claimAttempt: 2 })
    expect(
      await Effect.runPromise(execution.registrationWork({ reservation, claim: retry })),
    ).toMatchObject({
      mustAdoptOnly: false,
      adoptionAttempt: 0,
    })
    await Effect.runPromise(
      execution.beginProviderDispatch({
        reservation,
        claim: retry,
        now: '2026-08-23T12:01:00.000Z',
      }),
    )
    const afterDispatchCrash = await Effect.runPromise(
      execution.claimExact(
        claimInput({
          reservation,
          now: '2026-08-23T12:07:00.000Z',
          suffix: 'predispatch-crash-03',
        }),
      ),
    )
    expect(afterDispatchCrash).toMatchObject({ disposition: 'execute', claimAttempt: 3 })
    expect(
      await Effect.runPromise(
        execution.registrationWork({ reservation, claim: afterDispatchCrash }),
      ),
    ).toMatchObject({
      mustAdoptOnly: true,
      adoptionAttempt: 2,
    })
  })

  it('aborts a begin-dispatch versus pre-dispatch-release race instead of committing split receipt and operation state', async () => {
    const acceptance = makeRepository()
    await Effect.runPromise(
      acceptance.acceptAtomic(input(command('create'), 'race-create', fingerprint('4'))),
    )
    await Effect.runPromise(
      acceptance.acceptAtomic(input(command('configure-scope'), 'race-scope', fingerprint('5'))),
    )
    const registered = await Effect.runPromise(
      acceptance.acceptAtomic(
        input(
          {
            ...command('register-provider', { registration: { mode: 'custom-image' } }),
            idempotencyKey: 'node-image-release-race-registration-0001',
          },
          'race-register',
          fingerprint('6'),
        ),
      ),
    )
    startWorkflow(registered.operation.id)
    const execution = makeNodeImageExecutionRepositoryD1(database)
    const reservation = await Effect.runPromise(
      execution.loadExact({
        operationId: registered.operation.id,
        workflowStartRecordId: registered.workflowStart.id,
        requestFingerprint: registered.operation.requestFingerprint,
      }),
    )
    const active = await Effect.runPromise(
      execution.claimExact(claimInput({ reservation, now, suffix: 'release-race-claim-01' })),
    )
    let releaseReached!: () => void
    let allowRelease!: () => void
    const reached = new Promise<void>((resolve) => (releaseReached = resolve))
    const proceed = new Promise<void>((resolve) => (allowRelease = resolve))
    let blocked = false
    database.beforeBatch = async (statements) => {
      if (
        !blocked &&
        statements.some(
          (statement) =>
            statement instanceof Statement &&
            statement.sql.includes('provider_dispatch_started = 0'),
        )
      ) {
        blocked = true
        releaseReached()
        await proceed
      }
    }
    const release = Effect.runPromise(
      execution.releasePreDispatch({
        reservation,
        claim: active,
        now,
        code: 'artifact_locator_unavailable',
      }),
    )
    await reached
    await Effect.runPromise(execution.beginProviderDispatch({ reservation, claim: active, now }))
    allowRelease()
    await expect(release).rejects.toMatchObject({ _tag: 'NodeImageConflictError' })
    database.beforeBatch = undefined
    expect(
      sqlite
        .prepare(`SELECT state, provider_dispatch_started AS providerDispatchStarted
      FROM platform_node_image_step_receipts WHERE operation_id = ?`)
        .get(registered.operation.id),
    ).toEqual({
      state: 'running',
      providerDispatchStarted: 1,
    })
    expect(
      sqlite
        .prepare(`SELECT state FROM platform_node_image_operations WHERE id = ?`)
        .get(registered.operation.id),
    ).toEqual({
      state: 'running',
    })
  })

  it('aborts an uncertain settlement when its exact registration revision loses a concurrent transition', async () => {
    const acceptance = makeRepository()
    await Effect.runPromise(
      acceptance.acceptAtomic(input(command('create'), 'uncertain-create', fingerprint('7'))),
    )
    await Effect.runPromise(
      acceptance.acceptAtomic(
        input(command('configure-scope'), 'uncertain-scope', fingerprint('8')),
      ),
    )
    const registered = await Effect.runPromise(
      acceptance.acceptAtomic(
        input(
          {
            ...command('register-provider', { registration: { mode: 'custom-image' } }),
            idempotencyKey: 'node-image-uncertain-race-registration-0001',
          },
          'uncertain-register',
          fingerprint('9'),
        ),
      ),
    )
    startWorkflow(registered.operation.id)
    const execution = makeNodeImageExecutionRepositoryD1(database)
    const reservation = await Effect.runPromise(
      execution.loadExact({
        operationId: registered.operation.id,
        workflowStartRecordId: registered.workflowStart.id,
        requestFingerprint: registered.operation.requestFingerprint,
      }),
    )
    const active = await Effect.runPromise(
      execution.claimExact(claimInput({ reservation, now, suffix: 'uncertain-race-claim-1' })),
    )
    await Effect.runPromise(execution.beginProviderDispatch({ reservation, claim: active, now }))
    let settlementReached!: () => void
    let allowSettlement!: () => void
    const reached = new Promise<void>((resolve) => (settlementReached = resolve))
    const proceed = new Promise<void>((resolve) => (allowSettlement = resolve))
    let blocked = false
    database.beforeBatch = async (statements) => {
      if (
        !blocked &&
        statements.some(
          (statement) =>
            statement instanceof Statement && statement.sql.includes("SET state = 'uncertain'"),
        )
      ) {
        blocked = true
        settlementReached()
        await proceed
      }
    }
    const settlement = Effect.runPromise(
      execution.settleProviderRegistration({
        reservation,
        claim: active,
        now,
        outcome: {
          kind: 'uncertain',
          nextAttemptNumber: 1,
          nextAttemptAtEpochMs: Date.parse(now) + 60_000,
          recoveryDeadlineAtEpochMs: Date.parse(now) + 60 * 60 * 1000,
        },
      }),
    )
    await reached
    sqlite
      .prepare(`UPDATE node_image_provider_registrations
        SET provider_image_id = 'provider-image-already-registered', state = 'registered', revision = 2, updated_at = ?
        WHERE image_id = 'node-image-20260823' AND scope_id = 'scope-ovh-gra' AND revision = 1`)
      .run(now)
    allowSettlement()
    await expect(settlement).rejects.toMatchObject({ _tag: 'NodeImageConflictError' })
    database.beforeBatch = undefined
    expect(
      sqlite.prepare(`SELECT state, revision FROM node_image_provider_registrations`).get(),
    ).toEqual({
      state: 'registered',
      revision: 2,
    })
    expect(
      sqlite
        .prepare(`SELECT state FROM platform_node_image_step_receipts WHERE operation_id = ?`)
        .get(registered.operation.id),
    ).toEqual({
      state: 'running',
    })
    expect(
      sqlite
        .prepare(`SELECT state FROM platform_node_image_operations WHERE id = ?`)
        .get(registered.operation.id),
    ).toEqual({
      state: 'running',
    })
  })

  it('keeps bounded adopt-only visibility polling recoverable across more than one uncertain result', async () => {
    const acceptance = makeRepository()
    await Effect.runPromise(
      acceptance.acceptAtomic(input(command('create'), 'multi-uncertain-create', fingerprint('7'))),
    )
    await Effect.runPromise(
      acceptance.acceptAtomic(
        input(command('configure-scope'), 'multi-uncertain-scope', fingerprint('8')),
      ),
    )
    const registered = await Effect.runPromise(
      acceptance.acceptAtomic(
        input(
          {
            ...command('register-provider', { registration: { mode: 'custom-image' } }),
            idempotencyKey: 'node-image-multi-uncertain-registration-0001',
          },
          'multi-uncertain-register',
          fingerprint('9'),
        ),
      ),
    )
    startWorkflow(registered.operation.id)
    const execution = makeNodeImageExecutionRepositoryD1(database)
    const reservation = await Effect.runPromise(
      execution.loadExact({
        operationId: registered.operation.id,
        workflowStartRecordId: registered.workflowStart.id,
        requestFingerprint: registered.operation.requestFingerprint,
      }),
    )
    const deadline = Date.parse(now) + 60 * 60 * 1000
    const first = await Effect.runPromise(
      execution.claimExact(claimInput({ reservation, now, suffix: 'multi-uncertain-claim-1' })),
    )
    await Effect.runPromise(execution.beginProviderDispatch({ reservation, claim: first, now }))
    await expect(
      Effect.runPromise(
        execution.settleProviderRegistration({
          reservation,
          claim: first,
          now,
          outcome: {
            kind: 'uncertain',
            nextAttemptNumber: 1,
            nextAttemptAtEpochMs: Date.parse(now) + 60_000,
            recoveryDeadlineAtEpochMs: deadline,
          },
        }),
      ),
    ).resolves.toEqual({ status: 'waiting-external' })

    const secondNow = new Date(Date.parse(now) + 2 * 60_000).toISOString()
    const second = await Effect.runPromise(
      execution.claimExact(
        claimInput({ reservation, now: secondNow, suffix: 'multi-uncertain-claim-2' }),
      ),
    )
    await expect(
      Effect.runPromise(
        execution.settleProviderRegistration({
          reservation,
          claim: second,
          now: secondNow,
          outcome: {
            kind: 'uncertain',
            nextAttemptNumber: 2,
            nextAttemptAtEpochMs: Date.parse(secondNow) + 60_000,
            recoveryDeadlineAtEpochMs: deadline,
          },
        }),
      ),
    ).resolves.toEqual({ status: 'waiting-external' })
    expect(
      sqlite.prepare(`SELECT state, revision FROM node_image_provider_registrations`).get(),
    ).toEqual({
      state: 'uncertain',
      revision: 3,
    })

    const thirdNow = new Date(Date.parse(now) + 4 * 60_000).toISOString()
    const third = await Effect.runPromise(
      execution.claimExact(
        claimInput({ reservation, now: thirdNow, suffix: 'multi-uncertain-claim-3' }),
      ),
    )
    await expect(
      Effect.runPromise(
        execution.settleProviderRegistration({
          reservation,
          claim: third,
          now: thirdNow,
          outcome: {
            kind: 'adopted',
            providerImageId: 'ovh-image-visible-after-second-poll',
            providerRequestId: 'provider-request-visible-after-second-poll',
          },
        }),
      ),
    ).resolves.toEqual({ status: 'completed' })
    expect(
      sqlite
        .prepare(
          `SELECT state, provider_image_id AS providerImageId FROM node_image_provider_registrations`,
        )
        .get(),
    ).toEqual({
      state: 'registered',
      providerImageId: 'ovh-image-visible-after-second-poll',
    })
    expect(
      sqlite
        .prepare(`SELECT state FROM platform_node_image_operations WHERE id = ?`)
        .get(registered.operation.id),
    ).toEqual({
      state: 'succeeded',
    })
  })
})

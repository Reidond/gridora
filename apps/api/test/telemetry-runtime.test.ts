import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareAgentTelemetryPayload, type AgentTelemetryPayload } from '@gridora/agent-telemetry'
import { Operation } from '@gridora/contracts'
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '@gridora/db-d1'
import type { LiveLogArchiveAvailableEvent } from '@gridora/log-control'
import {
  reconcilePendingTelemetryArchive,
  type TelemetryArchiveReconciliationDatabase,
  type TelemetryArchiveReconciliationStatement,
} from '../../../workers/queue-consumers/src/telemetry-archive-reconciliation.js'
import { makeTelemetryIngestor, type TelemetryPrincipal } from '../src/telemetry-runtime.js'

type SqliteInput = SQLInputValue

class SqliteStatement implements D1PreparedStatementLike {
  #values: ReadonlyArray<unknown> = []

  constructor(
    readonly statement: StatementSync,
    readonly afterRun?: () => void,
  ) {}

  bind(...values: ReadonlyArray<unknown>): D1PreparedStatementLike {
    this.#values = values
    return this
  }

  first(): Promise<unknown> {
    return Promise.resolve(
      this.statement.get(...(this.#values as ReadonlyArray<SqliteInput>)) ?? null,
    )
  }

  all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return Promise.resolve({
      results: this.statement.all(...(this.#values as ReadonlyArray<SqliteInput>)),
    })
  }

  run(): Promise<D1ResultLike> {
    try {
      const result = this.statement.run(...(this.#values as ReadonlyArray<SqliteInput>))
      this.afterRun?.()
      return Promise.resolve({ success: true, meta: { changes: Number(result.changes) } })
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  execute(): D1ResultLike {
    const result = this.statement.run(...(this.#values as ReadonlyArray<SqliteInput>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 implements D1DatabaseLike {
  loseResponseAfterCommitOnce = false
  loseRunResponseAfterCommitOnce = false
  /** Lets a test target the final evidence commit after pre-upload intent writes. */
  committedResponsesBeforeLoss = 0
  beforeBatchOnce: (() => void) | undefined
  lastBatchError: unknown

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteStatement(this.database.prepare(sql), () => {
      if (!this.loseRunResponseAfterCommitOnce) return
      this.loseRunResponseAfterCommitOnce = false
      throw new Error('D1 response lost after committed statement')
    })
  }

  async batch(
    statements: ReadonlyArray<D1PreparedStatementLike>,
  ): Promise<ReadonlyArray<D1ResultLike>> {
    const beforeBatch = this.beforeBatchOnce
    this.beforeBatchOnce = undefined
    beforeBatch?.()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => (statement as SqliteStatement).execute())
      this.database.exec('COMMIT')
      if (this.loseResponseAfterCommitOnce) {
        if (this.committedResponsesBeforeLoss > 0) {
          this.committedResponsesBeforeLoss -= 1
        } else {
          this.loseResponseAfterCommitOnce = false
          throw new Error('D1 response lost after committed batch')
        }
      }
      return results
    } catch (cause) {
      this.lastBatchError = cause
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // A lost response is deliberately raised after COMMIT.
      }
      throw cause
    }
  }
}

interface StoredObject {
  readonly body: Uint8Array
  readonly key: string
  readonly size: number
  readonly etag: string
  readonly customMetadata: Readonly<Record<string, string>>
}

/** Minimal Cloudflare R2 shape; conditional puts emulate If-None-Match exactly. */
class MemoryR2 {
  readonly objects = new Map<string, StoredObject>()
  beforePut: (() => Promise<void> | void) | undefined
  afterReadBeforeCommit: (() => Promise<void> | void) | undefined

  async head(key: string): Promise<Omit<StoredObject, 'body'> | null> {
    const object = this.objects.get(key)
    return object === undefined ? null : { ...object }
  }

  async get(
    key: string,
  ): Promise<(Omit<StoredObject, 'body'> & { readonly body: ReadableStream<Uint8Array> }) | null> {
    const object = this.objects.get(key)
    return object === undefined
      ? null
      : {
          key: object.key,
          size: object.size,
          etag: object.etag,
          customMetadata: object.customMetadata,
          body: new Response(new Uint8Array(object.body).buffer).body!,
        }
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: {
      readonly customMetadata?: Readonly<Record<string, string>>
      readonly onlyIf?: Headers
    },
  ): Promise<Omit<StoredObject, 'body'>> {
    if (options?.onlyIf?.get('if-none-match') === '*' && this.objects.has(key))
      throw new Error('conditional R2 write was not applied')
    await this.beforePut?.()
    const copy = await this.readBody(body)
    await this.afterReadBeforeCommit?.()
    const object: StoredObject = {
      key,
      size: copy.byteLength,
      etag: `etag-${this.objects.size + 1}`,
      customMetadata: options?.customMetadata ?? {},
      body: copy,
    }
    this.objects.set(key, object)
    return {
      key: object.key,
      size: object.size,
      etag: object.etag,
      customMetadata: object.customMetadata,
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  private async readBody(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
    if (body instanceof Uint8Array) return new Uint8Array(body)
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const copy = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      copy.set(chunk, offset)
      offset += chunk.byteLength
    }
    return copy
  }
}

const migrationDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)
const now = Date.parse('2026-08-23T12:10:00.000Z')
const principal: TelemetryPrincipal = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  credentialId: 'credential-a',
  version: 1,
  sessionVersion: 1,
}

const applyMigrations = (database: DatabaseSync) => {
  for (const file of readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    database.exec(readFileSync(`${migrationDirectory}${file}`, 'utf8'))
}

const seed = (database: DatabaseSync) => {
  database.exec(`
    INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES ('owner-a', 'access-owner-a', 'owner-a@example.test', 'Owner A', 'active', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z');
    INSERT INTO organizations (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES ('org-a', 'Organization A', 'org-a', 'active', 'UTC', 'eu-west', 'complete', 1, 1, '2026-08-23T10:00:00.000Z');
    INSERT INTO organization_memberships (organization_id, identity_id, role, status, joined_at, invited_by, revision)
    VALUES ('org-a', 'owner-a', 'owner', 'active', '2026-08-23T10:00:00.000Z', NULL, 1);
    INSERT INTO provider_accounts (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
    VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'provider-reference', 'active', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z');
    INSERT INTO provider_allocations (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
    VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 10, 'active', 1);
    INSERT INTO node_images (id, version, checksum, signature, provider_mappings_json, status, created_at)
    VALUES ('image-a', '1.0.0', 'sha256:${'a'.repeat(64)}', 'signature-a', '{}', 'promoted', '2026-08-23T10:00:00.000Z');
    INSERT INTO nodes (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
      placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
    VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small', 'image-a',
      'shared', 'ready', 'ready', 1, 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z');
    INSERT INTO game_plugins (id, version, api_version, status, capability_manifest_json, config_schema_version)
    VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);
    INSERT INTO game_servers (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
      placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
    VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running', 'running', '{}', 1, 1, 1,
      '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z');
    INSERT INTO deployments (organization_id, id, server_id, node_id, desired_revision, observed_revision, observed_state, created_at, updated_at)
    VALUES ('org-a', 'deployment-a', 'server-a', 'node-a', 1, 1, 'running', '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z');
    INSERT INTO node_credentials (organization_id, node_id, id, credential_hash, version, status, issued_at)
    VALUES ('org-a', 'node-a', 'credential-a', 'credential-hash-a', 1, 'active', '2026-08-23T10:00:00.000Z');
    INSERT INTO agent_sessions (organization_id, node_id, credential_id, session_version, agent_version, session_state, last_seen_at, revision)
    VALUES ('org-a', 'node-a', 'credential-a', 1, '1.0.0', 'connected', '2026-08-23T10:00:00.000Z', 1);
  `)
}

const payload = async (
  overrides: {
    readonly organizationId?: string
    readonly nodeId?: string
    readonly sampledAt?: string
    readonly firstSequence?: number
    readonly message?: string
    readonly withLogs?: boolean
    readonly withServerHealth?: boolean
    readonly serverHealthDeploymentId?: string
  } = {},
): Promise<AgentTelemetryPayload> => {
  const organizationId = overrides.organizationId ?? 'org-a'
  const nodeId = overrides.nodeId ?? 'node-a'
  const sampledAt = overrides.sampledAt ?? '2026-08-23T12:00:00.000Z'
  const firstSequence = overrides.firstSequence ?? 1
  const logs =
    overrides.withLogs === false
      ? undefined
      : {
          organizationId,
          nodeId,
          entries: [
            {
              organizationId,
              nodeId,
              serverId: 'server-a',
              component: 'game',
              level: 'info',
              timestamp: sampledAt,
              sequence: firstSequence,
              message: overrides.message ?? `line ${firstSequence}`,
            },
          ],
        }
  const containers =
    overrides.withServerHealth === true
      ? [
          {
            id: 'container-a',
            name: 'gridora-server-a',
            state: 'running' as const,
            health: 'healthy' as const,
            restartCount: 0,
            cpuUsedMillis: 10,
            memoryUsedBytes: 100,
          },
        ]
      : []
  return Effect.runPromise(
    prepareAgentTelemetryPayload(
      {
        health: {
          apiVersion: 'agent.telemetry.gridora.dev/v1alpha1',
          organizationId,
          nodeId,
          sampledAt,
          agentVersion: '1.0.0',
          tunnel: 'connected',
          docker: 'healthy',
          firewall: 'ready',
          cpuUsedMillis: 10,
          cpuTotalMillis: 100,
          ramUsedBytes: 100,
          ramTotalBytes: 1_000,
          diskUsedBytes: 100,
          diskTotalBytes: 1_000,
          loadPermille: 10,
          networkReceiveBytes: 1,
          networkTransmitBytes: 2,
          containers,
        },
        ...(logs === undefined ? {} : { logs }),
        ...(overrides.withServerHealth !== true
          ? {}
          : {
              serverHealth: [
                {
                  serverId: 'server-a',
                  deploymentId: overrides.serverHealthDeploymentId ?? 'deployment-a',
                  containerId: 'container-a',
                  game: {
                    process: 'running' as const,
                    query: 'healthy' as const,
                    mods: 'healthy' as const,
                    playerCount: 12,
                  },
                },
              ],
            }),
      },
      now,
    ),
  )
}

let database: DatabaseSync
let d1: SqliteD1
let bucket: MemoryR2
let events: LiveLogArchiveAvailableEvent[]
let runtimeNow = now
let archiveUploadDeadlineMilliseconds: number | undefined

const ingestor = () =>
  makeTelemetryIngestor({
    database: d1,
    logBucket: bucket,
    telemetryQueue: {
      send: async (event) => {
        events.push(event)
        return { accepted: true }
      },
    },
    supportedAgentVersion: '1.0.0',
    now: () => runtimeNow,
    ...(archiveUploadDeadlineMilliseconds === undefined
      ? {}
      : { archiveUploadDeadlineMilliseconds }),
  })

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  applyMigrations(database)
  seed(database)
  d1 = new SqliteD1(database)
  bucket = new MemoryR2()
  events = []
  runtimeNow = now
  archiveUploadDeadlineMilliseconds = undefined
})

afterEach(() => database.close())

const reconciliationDatabase = (): TelemetryArchiveReconciliationDatabase => ({
  prepare: (sql) => {
    const statement = d1.prepare(sql)
    const wrapped: TelemetryArchiveReconciliationStatement = {
      bind: (...values) => {
        statement.bind(...values)
        return wrapped
      },
      all: () => statement.all(),
      first: () => statement.first(),
      run: () => statement.run(),
    }
    return wrapped
  },
})

const pendingArchiveForReconciliation = () =>
  database
    .prepare(`SELECT organization_id AS organizationId,
  archive_id AS archiveId, archive_base_id AS archiveBaseId,
  archive_generation AS archiveGeneration, node_id AS nodeId, server_id AS serverId,
  deployment_id AS deploymentId, stream_epoch AS streamEpoch, r2_key AS r2Key,
  sha256, compressed_sha256 AS compressedSha256, entry_count AS entryCount,
  uncompressed_bytes AS uncompressedBytes, compressed_bytes AS compressedBytes,
  state, upload_lease_id AS uploadLeaseId, upload_claimed_at AS uploadClaimedAt,
  upload_lease_expires_at AS uploadLeaseExpiresAt,
  upload_claimed_ever AS uploadClaimedEver,
  upload_watch_after AS uploadWatchAfter, upload_watch_until AS uploadWatchUntil,
  upload_watch_required AS uploadWatchRequired,
  upload_writer_state AS uploadWriterState,
  upload_writer_terminated_at AS uploadWriterTerminatedAt
  FROM telemetry_pending_archive_uploads
  WHERE organization_id = 'org-a'
  ORDER BY archive_generation ASC
  LIMIT 1`)
    .get()

describe('telemetry ingress evidence transaction', () => {
  it('archives exact bytes before the atomic receipt, server watermark, health facts, queue intent, and v1 machine audit', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        ingestor().ingest(principal, await payload(), {
          request: {
            origin: 'machine',
            requestId: 'request-telemetry-a',
            correlationId: 'correlation-telemetry-a',
            source: {
              ip: { state: 'captured', value: '203.0.113.7' },
              access: { state: 'not-available', reason: 'machine-bearer-credential' },
            },
          },
        }),
      ),
    )
    expect(d1.lastBatchError).toBeUndefined()
    if (result._tag === 'Failure') throw result.failure
    const accepted = result.success
    expect(accepted).toMatchObject({
      organizationId: 'org-a',
      nodeId: 'node-a',
      logFirstSequence: 1,
      logLastSequence: 1,
      replayed: false,
    })
    expect(bucket.objects.size).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      organizationId: 'org-a',
      nodeId: 'node-a',
      serverId: 'server-a',
      firstSequence: 1,
      lastSequence: 1,
    })
    expect(
      database
        .prepare(`SELECT server_id AS serverId, stream_epoch AS streamEpoch,
      last_sequence AS lastSequence FROM telemetry_log_stream_epoch_watermarks`)
        .all(),
    ).toEqual([{ serverId: 'server-a', streamEpoch: 'deployment-a', lastSequence: 1 }])
    expect(
      database
        .prepare(
          `SELECT resource_type AS resourceType, resource_id AS resourceId, server_id AS serverId FROM health_current_snapshots`,
        )
        .all(),
    ).toEqual([{ resourceType: 'node', resourceId: 'node-a', serverId: null }])
    expect(database.prepare(`SELECT state FROM telemetry_live_publications`).all()).toEqual([
      { state: 'enqueued' },
    ])
    const audit = database
      .prepare(`SELECT event_id AS eventId, envelope_json AS envelope FROM audit_event_envelopes`)
      .get() as { eventId: string; envelope: string }
    const envelope = JSON.parse(audit.envelope) as Record<string, unknown>
    expect(audit.eventId).toMatch(/^audit_telemetry_/)
    expect(envelope).toMatchObject({
      version: 1,
      actor: { type: 'machine' },
      source: { ip: { state: 'captured', value: '203.0.113.7' } },
      operationId: expect.stringMatching(/^op_telemetry_/),
    })
    expect(
      database
        .prepare(
          `SELECT actor_type AS actorType, actor_id AS actorId, operation_actor_id AS operationActorId FROM audit_actor_bindings`,
        )
        .all(),
    ).toContainEqual(
      expect.objectContaining({
        actorType: 'machine',
        actorId: expect.stringMatching(/^machine_/),
        operationActorId: expect.stringMatching(/^machine_/),
      }),
    )
    const operation = database
      .prepare(`SELECT id, organization_id AS organizationId, type,
      resource_type AS resourceType, resource_id AS resourceId, actor_id AS actorId,
      status, progress, idempotency_key AS idempotencyKey, correlation_id AS correlationId,
      revision, created_at AS createdAt, updated_at AS updatedAt
      FROM operations WHERE type = 'agent.telemetry'`)
      .get()
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(Operation)(operation)),
    ).resolves.toMatchObject({
      id: expect.stringMatching(/^op_telemetry_/),
      correlationId: 'correlation-telemetry-a',
    })
    // The agent sample remains health evidence, but all immutable
    // control-plane facts are stamped when this Worker accepted it.
    expect(
      database
        .prepare(`SELECT health_sampled_at AS healthSampledAt,
      accepted_at AS acceptedAt, created_at AS createdAt
      FROM telemetry_ingestion_receipts`)
        .all(),
    ).toEqual([
      {
        healthSampledAt: '2026-08-23T12:00:00.000Z',
        acceptedAt: '2026-08-23T12:10:00.000Z',
        createdAt: '2026-08-23T12:10:00.000Z',
      },
    ])
    expect(
      database
        .prepare(`SELECT created_at AS createdAt, updated_at AS updatedAt
      FROM operations WHERE type = 'agent.telemetry'`)
        .all(),
    ).toEqual([
      {
        createdAt: '2026-08-23T12:10:00.000Z',
        updatedAt: '2026-08-23T12:10:00.000Z',
      },
    ])
    expect(
      database
        .prepare(`SELECT created_at AS createdAt FROM audit_events
      WHERE action = 'agent.telemetry.accepted'`)
        .all(),
    ).toEqual([
      {
        createdAt: '2026-08-23T12:10:00.000Z',
      },
    ])
    expect(
      database
        .prepare(`SELECT created_at AS createdAt FROM audit_event_envelopes
      WHERE event_id = ?`)
        .all(audit.eventId),
    ).toEqual([
      {
        createdAt: '2026-08-23T12:10:00.000Z',
      },
    ])
    expect(envelope.occurredAt).toBe('2026-08-23T12:10:00.000Z')
  })

  it('adopts exact replay once, rejects forged body scope and changed sequence evidence, and does not double-publish', async () => {
    const runtime = ingestor()
    const original = await payload()
    await expect(Effect.runPromise(runtime.ingest(principal, original))).resolves.toMatchObject({
      replayed: false,
    })
    await expect(Effect.runPromise(runtime.ingest(principal, original))).resolves.toMatchObject({
      replayed: true,
    })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 1 })
    expect(events).toHaveLength(1)

    await expect(
      Effect.runPromise(runtime.ingest(principal, await payload({ organizationId: 'org-b' }))),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    await expect(
      Effect.runPromise(
        runtime.ingest(principal, await payload({ message: 'changed but still sequence one' })),
      ),
    ).rejects.toMatchObject({ code: 'telemetry_evidence_conflict' })
    // The stale conflicting body never reaches pending upload or R2.
    expect(bucket.objects.size).toBe(1)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 1 })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_log_epoch_reservations`).get(),
    ).toEqual({ count: 1 })
    expect(database.prepare(`SELECT count(*) AS count FROM log_archives`).get()).toEqual({
      count: 1,
    })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 1 })
  })

  it('adopts an exact immutable payload after a credential and session renewal without cross-node collision', async () => {
    const runtime = ingestor()
    const original = await payload()
    await expect(Effect.runPromise(runtime.ingest(principal, original))).resolves.toMatchObject({
      replayed: false,
    })

    database.exec(`
      UPDATE node_credentials SET status = 'revoked', revoked_at = '2026-08-23T12:01:00.000Z'
      WHERE organization_id = 'org-a' AND node_id = 'node-a' AND id = 'credential-a';
      INSERT INTO node_credentials
        (organization_id, node_id, id, credential_hash, version, status, issued_at)
      VALUES ('org-a', 'node-a', 'credential-b', 'credential-hash-b', 2, 'active', '2026-08-23T12:01:00.000Z');
      UPDATE agent_sessions
      SET credential_id = 'credential-b', session_version = 2, agent_version = '1.0.0',
          session_state = 'connected', revision = revision + 1
      WHERE organization_id = 'org-a' AND node_id = 'node-a';
    `)
    const renewed: TelemetryPrincipal = {
      organizationId: 'org-a',
      nodeId: 'node-a',
      credentialId: 'credential-b',
      version: 2,
      sessionVersion: 2,
    }
    await expect(Effect.runPromise(runtime.ingest(renewed, original))).resolves.toMatchObject({
      replayed: true,
      organizationId: 'org-a',
      nodeId: 'node-a',
      logFirstSequence: 1,
      logLastSequence: 1,
    })
    expect(
      database
        .prepare(`SELECT credential_id AS credentialId, session_version AS sessionVersion
      FROM telemetry_ingestion_receipts`)
        .all(),
    ).toEqual([{ credentialId: 'credential-a', sessionVersion: 1 }])
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM telemetry_payload_adoptions
      WHERE organization_id = 'org-a' AND node_id = 'node-a'`)
        .get(),
    ).toEqual({ count: 1 })
    expect(events).toHaveLength(1)
  })

  it('rejects server log evidence when the authenticated node does not own a running deployment', async () => {
    database
      .prepare(`UPDATE deployments SET observed_state = 'stopped'
      WHERE organization_id = 'org-a' AND id = 'deployment-a'`)
      .run()

    await expect(
      Effect.runPromise(ingestor().ingest(principal, await payload())),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    expect(bucket.objects.size).toBe(0)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 0 })
  })

  it('rejects samples outside the bounded offline window before reservation, pending upload, or R2 writes', async () => {
    await expect(
      Effect.runPromise(
        ingestor().ingest(principal, await payload({ sampledAt: '2026-08-22T12:09:59.999Z' })),
      ),
    ).rejects.toMatchObject({ code: 'invalid-entry' })
    expect(bucket.objects.size).toBe(0)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_log_epoch_reservations`).get(),
    ).toEqual({ count: 0 })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 0 })
  })

  it('writes authoritative plugin/container server health only for the exact active deployment', async () => {
    await expect(
      Effect.runPromise(
        ingestor().ingest(
          principal,
          await payload({
            withLogs: false,
            withServerHealth: true,
            sampledAt: '2026-08-23T12:10:00.000Z',
          }),
        ),
      ),
    ).resolves.toMatchObject({ replayed: false })
    expect(
      database
        .prepare(`SELECT resource_type AS resourceType, resource_id AS resourceId,
      node_id AS nodeId, server_id AS serverId, status, summary_json AS summaryJson
      FROM health_current_snapshots ORDER BY resource_type`)
        .all(),
    ).toEqual([
      expect.objectContaining({
        resourceType: 'node',
        resourceId: 'node-a',
        nodeId: 'node-a',
        serverId: null,
      }),
      expect.objectContaining({
        resourceType: 'server',
        resourceId: 'server-a',
        nodeId: 'node-a',
        serverId: 'server-a',
        status: 'healthy',
      }),
    ])
    const server = database
      .prepare(`SELECT summary_json AS summaryJson FROM health_current_snapshots
      WHERE organization_id = 'org-a' AND resource_type = 'server' AND resource_id = 'server-a'`)
      .get() as {
      summaryJson: string
    }
    expect(JSON.parse(server.summaryJson)).toMatchObject({
      game: { process: 'running', query: 'healthy', mods: 'healthy', playerCount: 12 },
      containers: [expect.objectContaining({ id: 'container-a', state: 'running' })],
    })

    await expect(
      Effect.runPromise(
        ingestor().ingest(
          principal,
          await payload({
            withLogs: false,
            withServerHealth: true,
            sampledAt: '2026-08-23T12:10:01.000Z',
            serverHealthDeploymentId: 'deployment-forged',
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM health_current_snapshots
      WHERE organization_id = 'org-a' AND resource_type = 'server'`)
        .get(),
    ).toEqual({ count: 1 })
  })

  it('rejects a receipt when the authenticated node is deleted after fact lookup but before its atomic evidence batch', async () => {
    d1.beforeBatchOnce = () => {
      database
        .prepare(`UPDATE nodes SET desired_state = 'deleted'
        WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .run()
    }

    await expect(
      Effect.runPromise(ingestor().ingest(principal, await payload())),
    ).rejects.toMatchObject({ code: 'telemetry_evidence_conflict' })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 0 })
    expect(
      database.prepare(`SELECT count(*) AS count FROM health_current_snapshots`).get(),
    ).toEqual({ count: 0 })
  })

  it('uses a new immutable R2 generation only after a settled writer is cleaned into the retry ledger', async () => {
    const original = await payload()
    // Let the durable pending-upload batch commit, then make only the final
    // evidence batch fail. This leaves generation zero uploaded but without a
    // receipt, exactly the cleanup-reconciliation crash window.
    d1.beforeBatchOnce = () => {
      d1.beforeBatchOnce = () => {
        d1.beforeBatchOnce = () => {
          throw new Error('final telemetry evidence batch unavailable')
        }
      }
    }
    await expect(Effect.runPromise(ingestor().ingest(principal, original))).rejects.toMatchObject({
      code: 'telemetry_evidence_conflict',
    })
    const firstAttempt = database
      .prepare(`SELECT archive_id AS archiveId, r2_key AS r2Key
      FROM telemetry_pending_archive_uploads
      WHERE organization_id = 'org-a'`)
      .get()
    const firstArchiveId = firstAttempt?.archiveId
    const firstR2Key = firstAttempt?.r2Key
    if (typeof firstArchiveId !== 'string' || typeof firstR2Key !== 'string')
      throw new Error('Expected a durable generation-zero telemetry archive attempt')
    // The failed final batch has settled and recorded writer termination, so
    // the queue can prove/delete the exact old key before allowing generation
    // one. A clock expiry by itself never performs this transition.
    await expect(
      reconcilePendingTelemetryArchive(
        reconciliationDatabase(),
        bucket,
        pendingArchiveForReconciliation(),
        '2026-08-23T12:10:01.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'cleaned' })
    expect(bucket.objects.has(firstR2Key)).toBe(false)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(`SELECT archive_attempt_generation AS generation,
        archive_attempt_count AS count, archive_retry_state AS retryState,
        archive_retry_after AS retryAfter
        FROM telemetry_log_epoch_reservations`)
        .get(),
    ).toEqual({
      generation: 0,
      count: 1,
      retryState: 'backoff',
      retryAfter: '2026-08-23T12:10:31.000Z',
    })

    runtimeNow = Date.parse('2026-08-23T12:10:31.000Z')
    await expect(Effect.runPromise(ingestor().ingest(principal, original))).resolves.toMatchObject({
      replayed: false,
      logFirstSequence: 1,
      logLastSequence: 1,
    })
    const attempts = database
      .prepare(`SELECT archive_id AS archiveId,
      archive_generation AS archiveGeneration, r2_key AS r2Key, state
      FROM telemetry_pending_archive_uploads
      WHERE organization_id = 'org-a'
      ORDER BY archive_generation ASC`)
      .all()
    expect(attempts).toEqual([
      expect.objectContaining({
        archiveId: `${firstArchiveId}_g1`,
        archiveGeneration: 1,
        state: 'accepted',
      }),
    ])
    const rearmedR2Key = attempts[0]?.r2Key
    if (typeof rearmedR2Key !== 'string') throw new Error('Expected a generation-one R2 key')
    expect(rearmedR2Key).not.toBe(firstR2Key)
    expect(bucket.objects.has(firstR2Key)).toBe(false)
    expect(bucket.objects.has(rearmedR2Key)).toBe(true)
  })

  it('aborts a delayed R2 stream at the hard deadline, adopts a lost terminal response, and leaves no late object', async () => {
    archiveUploadDeadlineMilliseconds = 1
    bucket.beforePut = async () => {
      // The adapter has not started consuming the stream, so the deadline
      // abort reaches its actual stream boundary before any byte can commit.
      d1.loseRunResponseAfterCommitOnce = true
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }

    await expect(
      Effect.runPromise(ingestor().ingest(principal, await payload())),
    ).rejects.toMatchObject({
      code: 'upload-uncertain',
      operation: 'logs.archive.put',
    })
    expect(bucket.objects.size).toBe(0)
    expect(
      database
        .prepare(`SELECT state, upload_lease_id AS uploadLeaseId,
      upload_watch_required AS uploadWatchRequired,
      upload_writer_state AS uploadWriterState,
      upload_writer_terminated_at AS uploadWriterTerminatedAt
      FROM telemetry_pending_archive_uploads`)
        .get(),
    ).toEqual({
      state: 'pending',
      uploadLeaseId: null,
      uploadWatchRequired: 0,
      uploadWriterState: 'terminated',
      uploadWriterTerminatedAt: '2026-08-23T12:10:00.000Z',
    })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 0 })

    // A response was lost after the terminal D1 update, but exact read-back
    // adopted it. Reconciliation may now compact the physical row; there is no
    // late PUT left to reappear after a finite watch horizon.
    await expect(
      reconcilePendingTelemetryArchive(
        reconciliationDatabase(),
        bucket,
        pendingArchiveForReconciliation(),
        '2026-08-23T12:10:11.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'cleaned' })
    expect(bucket.objects.size).toBe(0)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
  })

  it('fences a late R2 completion after stream consumption and retains its exact key until cleanup', async () => {
    archiveUploadDeadlineMilliseconds = 1
    bucket.afterReadBeforeCommit = async () => {
      // The terminal writer update commits, but its response is lost. Exact
      // read-back must still preserve the completed late object as cleanup
      // evidence rather than allowing a receipt or allocating a retry key.
      d1.loseRunResponseAfterCommitOnce = true
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }

    await expect(
      Effect.runPromise(ingestor().ingest(principal, await payload())),
    ).rejects.toMatchObject({
      operation: 'telemetry.archive-upload-deadline',
    })
    expect(bucket.objects.size).toBe(1)
    expect(
      database
        .prepare(`SELECT state, upload_lease_id AS uploadLeaseId,
        upload_writer_state AS uploadWriterState, upload_watch_required AS uploadWatchRequired
        FROM telemetry_pending_archive_uploads`)
        .get(),
    ).toEqual({
      state: 'pending',
      uploadLeaseId: null,
      uploadWriterState: 'terminated',
      uploadWatchRequired: 0,
    })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 0 })

    await expect(
      reconcilePendingTelemetryArchive(
        reconciliationDatabase(),
        bucket,
        pendingArchiveForReconciliation(),
        '2026-08-23T12:10:01.000Z',
      ),
    ).resolves.toMatchObject({ disposition: 'cleaned' })
    expect(bucket.objects.size).toBe(0)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
  })

  it('bounds repeated R2-outage retries to four immutable generations and quarantines the operation without pending-row growth', async () => {
    const original = await payload()
    bucket.beforePut = () => {
      throw new Error('R2 outage')
    }
    const attempts = [
      {
        acceptedAt: '2026-08-23T12:10:00.000Z',
        reconciledAt: '2026-08-23T12:10:01.000Z',
        retryAfter: '2026-08-23T12:10:31.000Z',
      },
      {
        acceptedAt: '2026-08-23T12:10:31.000Z',
        reconciledAt: '2026-08-23T12:10:32.000Z',
        retryAfter: '2026-08-23T12:12:32.000Z',
      },
      {
        acceptedAt: '2026-08-23T12:12:32.000Z',
        reconciledAt: '2026-08-23T12:12:33.000Z',
        retryAfter: '2026-08-23T12:22:33.000Z',
      },
      {
        acceptedAt: '2026-08-23T12:22:33.000Z',
        reconciledAt: '2026-08-23T12:22:34.000Z',
        retryAfter: null,
      },
    ] as const

    for (const [generation, attempt] of attempts.entries()) {
      runtimeNow = Date.parse(attempt.acceptedAt)
      await expect(Effect.runPromise(ingestor().ingest(principal, original))).rejects.toMatchObject(
        {
          code: 'upload-uncertain',
          operation: 'logs.archive.put',
        },
      )
      await expect(
        reconcilePendingTelemetryArchive(
          reconciliationDatabase(),
          bucket,
          pendingArchiveForReconciliation(),
          attempt.reconciledAt,
        ),
      ).resolves.toMatchObject({ disposition: 'cleaned' })
      expect(bucket.objects.size).toBe(0)
      expect(
        database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
      ).toEqual({ count: 0 })
      expect(
        database
          .prepare(`SELECT archive_attempt_generation AS generation,
          archive_attempt_count AS count, archive_retry_state AS retryState,
          archive_retry_after AS retryAfter
          FROM telemetry_log_epoch_reservations`)
          .get(),
      ).toEqual({
        generation,
        count: generation + 1,
        retryState: generation === 3 ? 'quarantined' : 'backoff',
        retryAfter: attempt.retryAfter,
      })
    }

    runtimeNow = Date.parse('2026-08-23T12:22:35.000Z')
    await expect(Effect.runPromise(ingestor().ingest(principal, original))).rejects.toMatchObject({
      operation: 'telemetry.archive-attempt.quarantined',
    })
    expect(bucket.objects.size).toBe(0)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 0 })
  })

  it('pre-reserves one exact epoch range so concurrent conflicting bodies cannot amplify pending rows or R2 objects', async () => {
    const runtime = ingestor()
    const [first, second] = await Promise.allSettled([
      Effect.runPromise(
        runtime.ingest(principal, await payload({ message: 'first immutable body' })),
      ),
      Effect.runPromise(
        runtime.ingest(principal, await payload({ message: 'conflicting immutable body' })),
      ),
    ])
    const outcomes = [first, second]
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    if (rejected?.status === 'rejected')
      expect(rejected.reason).toMatchObject({ code: 'telemetry_evidence_conflict' })
    expect(bucket.objects.size).toBe(1)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 1 })
    expect(database.prepare(`SELECT state FROM telemetry_log_epoch_reservations`).all()).toEqual([
      { state: 'accepted' },
    ])
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 1 })
  })

  it('adopts an exact epoch reservation after its committed D1 response is lost', async () => {
    d1.loseResponseAfterCommitOnce = true
    // The first committed batch is the D1 pre-upload reservation itself.
    d1.committedResponsesBeforeLoss = 0
    await expect(
      Effect.runPromise(ingestor().ingest(principal, await payload())),
    ).resolves.toMatchObject({
      replayed: false,
      logFirstSequence: 1,
      logLastSequence: 1,
    })
    expect(bucket.objects.size).toBe(1)
    expect(database.prepare(`SELECT state FROM telemetry_log_epoch_reservations`).all()).toEqual([
      { state: 'accepted' },
    ])
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 1 })
  })

  it('converges concurrent/lost responses on the immutable receipt and rejects a revoked credential', async () => {
    const runtime = ingestor()
    const first = await payload()
    const concurrent = await Promise.all([
      Effect.runPromise(runtime.ingest(principal, first)),
      Effect.runPromise(runtime.ingest(principal, first)),
    ])
    expect(concurrent.filter((result) => result.replayed).length).toBe(1)
    expect(concurrent.filter((result) => !result.replayed).length).toBe(1)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 1 })
    expect(bucket.objects.size).toBe(1)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 1 })

    d1.loseResponseAfterCommitOnce = true
    // Reservation and pending intent each commit before the final evidence
    // receipt. Lose only that last response so exact read-back adopts it.
    d1.committedResponsesBeforeLoss = 2
    const lost = await Effect.runPromise(
      runtime.ingest(
        principal,
        await payload({ sampledAt: '2026-08-23T12:01:00.000Z', firstSequence: 2 }),
      ),
    )
    expect(lost).toMatchObject({ replayed: true, logFirstSequence: 2, logLastSequence: 2 })
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_ingestion_receipts`).get(),
    ).toEqual({ count: 2 })
    expect(bucket.objects.size).toBe(2)
    expect(
      database.prepare(`SELECT count(*) AS count FROM telemetry_pending_archive_uploads`).get(),
    ).toEqual({ count: 2 })
    expect(events).toHaveLength(2)

    database
      .prepare(
        `UPDATE node_credentials SET status = 'revoked', revoked_at = ? WHERE organization_id = 'org-a' AND id = 'credential-a'`,
      )
      .run('2026-08-23T12:02:00.000Z')
    await expect(
      Effect.runPromise(
        runtime.ingest(
          principal,
          await payload({ sampledAt: '2026-08-23T12:02:00.000Z', firstSequence: 3 }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'membership_required' })
  })
})

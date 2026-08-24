import { Effect, Result } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  completeAuditEnvelope,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import type {
  AgentServerHealthSample,
  AgentTelemetryPayload,
  AgentTelemetryReceipt,
} from '@gridora/agent-telemetry'
import { AuthorizationError, ConflictError, PersistenceError } from '@gridora/contracts'
import type { D1DatabaseLike } from '@gridora/db-d1'
import {
  deriveHealthAlerts,
  evaluateNodeHealth,
  evaluateServerHealth,
} from '@gridora/health-control'
import type { HealthAlert, HealthSnapshot } from '@gridora/health-control'
import { LogPersistenceError, LogValidationError, makeLogBatch } from '@gridora/log-control'
import type {
  LiveLogArchiveAvailableEvent,
  LogArchiveMetadata,
  LogBatch,
} from '@gridora/log-control'
import {
  makeDeadlineAwareCloudflareLogR2Bucket,
  prepareLogArchive,
  uploadPreparedLogArchive,
} from '@gridora/log-r2'
import type { LogR2Error } from '@gridora/log-r2'

export interface TelemetryQueue {
  readonly send: (
    body: LiveLogArchiveAvailableEvent,
    options?: { readonly contentType?: 'json' },
  ) => Promise<unknown>
}

export interface TelemetryRuntimeBindings {
  readonly database: D1DatabaseLike
  readonly logBucket: Parameters<typeof makeDeadlineAwareCloudflareLogR2Bucket>[0]
  readonly telemetryQueue: TelemetryQueue
  readonly supportedAgentVersion: string
  readonly now?: () => number
  /** Test-only lowering is allowed; production cannot extend the hard limit. */
  readonly archiveUploadDeadlineMilliseconds?: number
}

export interface TelemetryPrincipal {
  readonly organizationId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly version: number
  readonly sessionVersion: number
}

/** Facts injected by the Worker edge; payload bodies never supply these. */
export interface TelemetryRequestSource {
  /** The Hono edge creates this once from the actual request, never from the body. */
  readonly request?: AuditRequestContextValue
  /** The raw Worker request signal participates in the archive stream deadline. */
  readonly requestSignal?: AbortSignal
}

interface TelemetryFacts {
  readonly providerState: 'active' | 'stopped' | 'error' | 'cancelling' | 'orphaned' | 'unknown'
  readonly sessionAgentVersion: string
}

interface DeploymentScope {
  readonly id: string
  readonly serverId: string
  readonly streamEpoch: string
}

interface TelemetryReceiptRow {
  readonly id: string
  readonly organizationId: string
  readonly nodeId: string
  readonly acceptedAt: string
  readonly logFirstSequence: number | null
  readonly logLastSequence: number | null
}

interface PendingPublication {
  readonly organizationId: string
  readonly receiptId: string
  readonly nodeId: string
  readonly serverId: string
  readonly streamEpoch: string
  readonly archiveId: string
  readonly r2Key: string
  readonly sha256: string
  readonly firstSequence: number
  readonly lastSequence: number
  readonly state: 'pending' | 'enqueued'
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === 'string' ? (value[key] as string) : undefined

const nullableText = (value: Record<string, unknown>, key: string): string | null | undefined =>
  value[key] === null ? null : text(value, key)

const nullableInteger = (value: Record<string, unknown>, key: string): number | null | undefined =>
  value[key] === null
    ? null
    : typeof value[key] === 'number' && Number.isSafeInteger(value[key])
      ? (value[key] as number)
      : undefined

const persistence = (operation: string, message: string): LogPersistenceError =>
  new LogPersistenceError({ operation, message })

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const sha256Hex = (value: string): Effect.Effect<string, LogPersistenceError> =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () => persistence('telemetry.sha256', 'Telemetry digest is unavailable'),
  })

const hourlyBucket = (sampledAt: string): string =>
  new Date(Math.floor(Date.parse(sampledAt) / 3_600_000) * 3_600_000).toISOString()

/** Offline agents may spool briefly, but sampled time never backdates control-plane evidence. */
const MAX_PAST_SAMPLE_SKEW_MILLISECONDS = 24 * 60 * 60_000
const MAX_FUTURE_SAMPLE_SKEW_MILLISECONDS = 5 * 60_000

const validateSampleAcceptanceWindow = (
  sampledAt: string,
  acceptedAtMilliseconds: number,
): Effect.Effect<void, LogValidationError> => {
  const sampledAtMilliseconds = Date.parse(sampledAt)
  if (!Number.isFinite(sampledAtMilliseconds))
    return Effect.fail(
      new LogValidationError({
        code: 'invalid-entry',
        message: 'Telemetry sample timestamp is invalid',
      }),
    )
  if (sampledAtMilliseconds < acceptedAtMilliseconds - MAX_PAST_SAMPLE_SKEW_MILLISECONDS)
    return Effect.fail(
      new LogValidationError({
        code: 'invalid-entry',
        message: 'Telemetry sample is older than the offline acceptance window',
      }),
    )
  if (sampledAtMilliseconds > acceptedAtMilliseconds + MAX_FUTURE_SAMPLE_SKEW_MILLISECONDS)
    return Effect.fail(
      new LogValidationError({
        code: 'invalid-entry',
        message: 'Telemetry sample is ahead of control-plane acceptance time',
      }),
    )
  return Effect.void
}

const readFacts = (
  database: D1DatabaseLike,
  principal: TelemetryPrincipal,
): Effect.Effect<TelemetryFacts, AuthorizationError | LogPersistenceError> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT provider.status AS providerStatus,
      session.agent_version AS sessionAgentVersion
      FROM organizations organization
      JOIN nodes node
        ON node.organization_id = organization.id
      JOIN node_credentials credential
        ON credential.organization_id = node.organization_id
       AND credential.node_id = node.id
      JOIN agent_sessions session
        ON session.organization_id = credential.organization_id
       AND session.node_id = credential.node_id
       AND session.credential_id = credential.id
      LEFT JOIN provider_accounts provider
        ON provider.id = node.provider_account_id
      WHERE organization.id = ?
        AND organization.status = 'active'
        AND node.id = ?
        AND node.desired_state <> 'deleted'
        AND node.observed_state <> 'deleted'
        AND credential.id = ?
        AND credential.version = ?
        AND credential.status = 'active'
        AND session.session_version = ?
        AND session.session_state = 'connected'`)
        .bind(
          principal.organizationId,
          principal.nodeId,
          principal.credentialId,
          principal.version,
          principal.sessionVersion,
        )
        .first(),
    catch: () =>
      persistence('telemetry.machine-auth', 'Telemetry machine authorization is unavailable'),
  }).pipe(
    Effect.flatMap((value) => {
      const row = record(value)
      const sessionAgentVersion = row === undefined ? undefined : text(row, 'sessionAgentVersion')
      const providerStatus = row === undefined ? undefined : text(row, 'providerStatus')
      if (sessionAgentVersion === undefined)
        return Effect.fail(
          new AuthorizationError({
            code: 'membership_required',
            message: 'The node credential or session is no longer active',
          }),
        )
      const providerState =
        providerStatus === 'active'
          ? 'active'
          : providerStatus === 'disabled'
            ? 'stopped'
            : providerStatus === 'error'
              ? 'error'
              : 'unknown'
      return Effect.succeed({ providerState, sessionAgentVersion })
    }),
  )

const validatePrincipalScope = (
  principal: TelemetryPrincipal,
  payload: AgentTelemetryPayload,
): Effect.Effect<void, LogValidationError> =>
  payload.health.organizationId !== principal.organizationId ||
  payload.health.nodeId !== principal.nodeId
    ? Effect.fail(
        new LogValidationError({
          code: 'invalid-scope',
          message: 'Telemetry organization or node does not match the active credential',
        }),
      )
    : Effect.void

const validateLogScope = (
  database: D1DatabaseLike,
  principal: TelemetryPrincipal,
  logs: LogBatch | undefined,
): Effect.Effect<
  { readonly logs?: LogBatch; readonly deployment?: DeploymentScope },
  LogValidationError | LogPersistenceError
> =>
  logs === undefined
    ? Effect.succeed({})
    : Effect.gen(function* () {
        const batch = yield* makeLogBatch(principal.organizationId, principal.nodeId, logs.entries)
        const serverIds = [...new Set(batch.entries.map((entry) => entry.serverId))]
        const serverId = serverIds[0]
        if (serverIds.length !== 1 || serverId === undefined)
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'One telemetry log batch must be scoped to one active game server',
          })
        const row = yield* Effect.tryPromise({
          try: () =>
            database
              .prepare(`SELECT deployment.id, deployment.server_id AS serverId
          FROM deployments deployment
          JOIN game_servers server
            ON server.organization_id = deployment.organization_id
           AND server.id = deployment.server_id
          WHERE deployment.organization_id = ?
            AND deployment.server_id = ?
            AND deployment.node_id = ?
            AND server.desired_state <> 'deleted'
            AND server.observed_state <> 'deleted'
            -- A machine may only submit server logs for the exact currently
            -- running deployment.  Pending, stopped, moving, or deleting rows
            -- are not an active container authority.
            AND deployment.observed_state = 'running'`)
              .bind(principal.organizationId, serverId, principal.nodeId)
              .first(),
          catch: () =>
            persistence('telemetry.deployment-scope', 'Deployment scope lookup is unavailable'),
        })
        const scope = record(row)
        const deploymentId = scope === undefined ? undefined : text(scope, 'id')
        const scopedServerId = scope === undefined ? undefined : text(scope, 'serverId')
        if (deploymentId === undefined || scopedServerId !== serverId)
          return yield* new LogValidationError({
            code: 'invalid-scope',
            message: 'Telemetry log server is not deployed on the authenticated node',
          })
        // Deployment IDs are immutable and become the stream epoch. The machine
        // cannot choose an epoch: it is resolved from the active D1 deployment.
        return {
          logs: batch,
          deployment: { id: deploymentId, serverId, streamEpoch: deploymentId },
        }
      })

interface ServerHealthScope {
  readonly sample: AgentServerHealthSample
  readonly deployment: DeploymentScope
  readonly container: AgentTelemetryPayload['health']['containers'][number]
}

/** Server health is accepted only for a labelled container in the exact current deployment. */
const validateServerHealthScope = (
  database: D1DatabaseLike,
  principal: TelemetryPrincipal,
  payload: AgentTelemetryPayload,
): Effect.Effect<ReadonlyArray<ServerHealthScope>, LogValidationError | LogPersistenceError> =>
  Effect.gen(function* () {
    const scopes: ServerHealthScope[] = []
    for (const sample of payload.serverHealth ?? []) {
      const container = payload.health.containers.find(
        (candidate) => candidate.id === sample.containerId,
      )
      if (container === undefined)
        return yield* new LogValidationError({
          code: 'invalid-scope',
          message: 'Server health container is not in the authenticated node sample',
        })
      const row = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`SELECT id, server_id AS serverId
          FROM deployments
          WHERE organization_id = ? AND node_id = ? AND server_id = ? AND id = ?
            AND observed_state = 'running'`)
            .bind(principal.organizationId, principal.nodeId, sample.serverId, sample.deploymentId)
            .first(),
        catch: () =>
          persistence(
            'telemetry.server-health-scope',
            'Server health deployment lookup is unavailable',
          ),
      })
      const deployment = record(row)
      const deploymentId = deployment === undefined ? undefined : text(deployment, 'id')
      const serverId = deployment === undefined ? undefined : text(deployment, 'serverId')
      if (deploymentId !== sample.deploymentId || serverId !== sample.serverId)
        return yield* new LogValidationError({
          code: 'invalid-scope',
          message: 'Server health deployment is not active on the authenticated node',
        })
      scopes.push({
        sample,
        deployment: { id: deploymentId, serverId, streamEpoch: deploymentId },
        container,
      })
    }
    return scopes
  })

const decodeReceipt = (value: unknown): TelemetryReceiptRow | null | undefined => {
  if (value === null) return null
  const row = record(value)
  if (row === undefined) return undefined
  const id = text(row, 'id')
  const organizationId = text(row, 'organizationId')
  const nodeId = text(row, 'nodeId')
  const acceptedAt = text(row, 'acceptedAt')
  const logFirstSequence = nullableInteger(row, 'logFirstSequence')
  const logLastSequence = nullableInteger(row, 'logLastSequence')
  if (
    id === undefined ||
    organizationId === undefined ||
    nodeId === undefined ||
    acceptedAt === undefined ||
    logFirstSequence === undefined ||
    logLastSequence === undefined ||
    (logFirstSequence === null) !== (logLastSequence === null)
  )
    return undefined
  return { id, organizationId, nodeId, acceptedAt, logFirstSequence, logLastSequence }
}

const findReceipt = (
  database: D1DatabaseLike,
  principal: TelemetryPrincipal,
  payloadFingerprint: string,
): Effect.Effect<TelemetryReceiptRow | null, LogPersistenceError> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT receipt.id, receipt.organization_id AS organizationId, receipt.node_id AS nodeId,
      receipt.accepted_at AS acceptedAt, receipt.log_first_sequence AS logFirstSequence,
      receipt.log_last_sequence AS logLastSequence
      FROM telemetry_payload_adoptions adoption
      JOIN telemetry_ingestion_receipts receipt
        ON receipt.organization_id = adoption.organization_id AND receipt.id = adoption.receipt_id
      WHERE adoption.organization_id = ? AND adoption.node_id = ? AND adoption.payload_fingerprint = ?
      UNION ALL
      SELECT id, organization_id AS organizationId, node_id AS nodeId,
        accepted_at AS acceptedAt, log_first_sequence AS logFirstSequence,
        log_last_sequence AS logLastSequence
      FROM telemetry_ingestion_receipts
      WHERE organization_id = ? AND node_id = ? AND payload_fingerprint = ?
        AND NOT EXISTS (
          SELECT 1 FROM telemetry_payload_adoptions adoption
          WHERE adoption.organization_id = ? AND adoption.node_id = ? AND adoption.payload_fingerprint = ?
        )
      LIMIT 1`)
        .bind(
          principal.organizationId,
          principal.nodeId,
          payloadFingerprint,
          principal.organizationId,
          principal.nodeId,
          payloadFingerprint,
          principal.organizationId,
          principal.nodeId,
          payloadFingerprint,
        )
        .first(),
    catch: () => persistence('telemetry.receipt.read', 'Telemetry receipt lookup is unavailable'),
  }).pipe(
    Effect.flatMap((value) => {
      const decoded = decodeReceipt(value)
      return decoded === undefined
        ? Effect.fail(
            persistence('telemetry.receipt.decode', 'Stored telemetry receipt is invalid'),
          )
        : Effect.succeed(decoded)
    }),
  )

const decodePublication = (value: unknown): PendingPublication | null | undefined => {
  if (value === null) return null
  const row = record(value)
  if (row === undefined) return undefined
  const organizationId = text(row, 'organizationId')
  const receiptId = text(row, 'receiptId')
  const nodeId = text(row, 'nodeId')
  const serverId = text(row, 'serverId')
  const streamEpoch = text(row, 'streamEpoch')
  const archiveId = text(row, 'archiveId')
  const r2Key = text(row, 'r2Key')
  const sha256 = text(row, 'sha256')
  const state = text(row, 'state')
  const firstSequence = nullableInteger(row, 'firstSequence')
  const lastSequence = nullableInteger(row, 'lastSequence')
  if (
    organizationId === undefined ||
    receiptId === undefined ||
    nodeId === undefined ||
    serverId === undefined ||
    streamEpoch === undefined ||
    archiveId === undefined ||
    r2Key === undefined ||
    sha256 === undefined ||
    (state !== 'pending' && state !== 'enqueued') ||
    firstSequence === null ||
    firstSequence === undefined ||
    lastSequence === null ||
    lastSequence === undefined ||
    lastSequence < firstSequence
  )
    return undefined
  return {
    organizationId,
    receiptId,
    nodeId,
    serverId,
    streamEpoch,
    archiveId,
    r2Key,
    sha256,
    firstSequence,
    lastSequence,
    state,
  }
}

const enqueuePendingPublication = (
  bindings: TelemetryRuntimeBindings,
  organizationId: string,
  receiptId: string,
): Effect.Effect<void, LogPersistenceError> =>
  Effect.gen(function* () {
    const current = yield* Effect.tryPromise({
      try: () =>
        bindings.database
          .prepare(`SELECT organization_id AS organizationId,
        receipt_id AS receiptId, node_id AS nodeId, server_id AS serverId, stream_epoch AS streamEpoch,
        archive_id AS archiveId, archive_r2_key AS r2Key, archive_sha256 AS sha256,
        first_sequence AS firstSequence, last_sequence AS lastSequence, state
        FROM telemetry_live_publications
        WHERE organization_id = ? AND receipt_id = ?`)
          .bind(organizationId, receiptId)
          .first(),
      catch: () =>
        persistence('telemetry.live-publication.read', 'Live publication state is unavailable'),
    })
    const publication = decodePublication(current)
    if (publication === undefined)
      return yield* persistence(
        'telemetry.live-publication.decode',
        'Live publication state is invalid',
      )
    if (publication === null || publication.state === 'enqueued') return
    const event: LiveLogArchiveAvailableEvent = {
      version: 2,
      type: 'log.archive.available',
      organizationId: publication.organizationId,
      nodeId: publication.nodeId,
      serverId: publication.serverId,
      streamEpoch: publication.streamEpoch,
      archiveId: publication.archiveId,
      r2Key: publication.r2Key,
      sha256: publication.sha256 as `sha256:${string}`,
      firstSequence: publication.firstSequence,
      lastSequence: publication.lastSequence,
    }
    yield* Effect.tryPromise({
      try: () => bindings.telemetryQueue.send(event, { contentType: 'json' }),
      catch: () =>
        persistence(
          'telemetry.live-publication.enqueue',
          'Live log publication queue is unavailable',
        ),
    })
    yield* Effect.tryPromise({
      try: () =>
        bindings.database
          .prepare(`UPDATE telemetry_live_publications
        SET state = 'enqueued', enqueued_at = ?
        WHERE organization_id = ? AND receipt_id = ? AND state = 'pending'`)
          .bind(
            new Date(bindings.now?.() ?? Date.now()).toISOString(),
            publication.organizationId,
            publication.receiptId,
          )
          .run(),
      catch: () =>
        persistence('telemetry.live-publication.mark', 'Live log publication state is unavailable'),
    })
  })

const receiptResponse = (
  receipt: TelemetryReceiptRow,
  replayed: boolean,
): AgentTelemetryReceipt => ({
  organizationId: receipt.organizationId,
  nodeId: receipt.nodeId,
  acceptedAt: receipt.acceptedAt,
  replayed,
  ...(receipt.logFirstSequence === null ? {} : { logFirstSequence: receipt.logFirstSequence }),
  ...(receipt.logLastSequence === null ? {} : { logLastSequence: receipt.logLastSequence }),
})

const readHealthBefore = (
  database: D1DatabaseLike,
  principal: TelemetryPrincipal,
): Effect.Effect<
  | { readonly state: 'captured'; readonly summary: Readonly<Record<string, unknown>> }
  | { readonly state: 'absent'; readonly reason: string },
  LogPersistenceError
> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT status, sampled_at AS sampledAt
      FROM health_current_snapshots
      WHERE organization_id = ? AND resource_type = 'node' AND resource_id = ?`)
        .bind(principal.organizationId, principal.nodeId)
        .first(),
    catch: () => persistence('telemetry.health-before', 'Current health lookup is unavailable'),
  }).pipe(
    Effect.map((value) => {
      const row = record(value)
      const status = row === undefined ? undefined : text(row, 'status')
      const sampledAt = row === undefined ? undefined : text(row, 'sampledAt')
      return status === undefined || sampledAt === undefined
        ? { state: 'absent' as const, reason: 'no-prior-node-health' }
        : { state: 'captured' as const, summary: { status, sampledAt } }
    }),
  )

const healthStatements = (
  database: D1DatabaseLike,
  snapshot: HealthSnapshot,
  alerts: ReadonlyArray<HealthAlert>,
) => {
  const summaryJson = JSON.stringify(snapshot.summary)
  const bucket = hourlyBucket(snapshot.sampledAt)
  const statements = [
    database
      .prepare(`INSERT INTO health_current_snapshots
      (organization_id, resource_type, resource_id, node_id, server_id, status, summary_json, sampled_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (organization_id, resource_type, resource_id) DO UPDATE SET
        node_id = excluded.node_id, server_id = excluded.server_id, status = excluded.status,
        summary_json = excluded.summary_json, sampled_at = excluded.sampled_at,
        revision = health_current_snapshots.revision + 1
      WHERE health_current_snapshots.sampled_at < excluded.sampled_at`)
      .bind(
        snapshot.organizationId,
        snapshot.resourceType,
        snapshot.resourceId,
        snapshot.nodeId,
        snapshot.serverId,
        snapshot.status,
        summaryJson,
        snapshot.sampledAt,
      ),
    database
      .prepare(`INSERT INTO health_hourly_snapshots
      (organization_id, resource_type, resource_id, node_id, server_id, bucket_start, status, summary_json, sampled_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (organization_id, resource_type, resource_id, bucket_start) DO UPDATE SET
        node_id = excluded.node_id, server_id = excluded.server_id, status = excluded.status,
        summary_json = excluded.summary_json, sampled_at = excluded.sampled_at,
        revision = health_hourly_snapshots.revision + 1
      WHERE health_hourly_snapshots.sampled_at < excluded.sampled_at`)
      .bind(
        snapshot.organizationId,
        snapshot.resourceType,
        snapshot.resourceId,
        snapshot.nodeId,
        snapshot.serverId,
        bucket,
        snapshot.status,
        summaryJson,
        snapshot.sampledAt,
      ),
    ...alerts.map((alert) =>
      database
        .prepare(`INSERT INTO health_alerts
      (organization_id, id, resource_type, resource_id, node_id, server_id, type, severity, message,
       fingerprint, state, first_seen_at, last_seen_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id, fingerprint) DO UPDATE SET
        severity = excluded.severity, message = excluded.message, state = 'open',
        last_seen_at = excluded.last_seen_at, resolved_at = NULL`)
        .bind(
          alert.organizationId,
          alert.id,
          alert.resourceType,
          alert.resourceId,
          alert.nodeId,
          alert.serverId,
          alert.type,
          alert.severity,
          alert.message,
          alert.fingerprint,
          alert.state,
          alert.firstSeenAt,
          alert.lastSeenAt,
          alert.resolvedAt,
        ),
    ),
    database
      .prepare(`UPDATE health_alerts SET state = 'resolved', resolved_at = ?
      WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
        AND state <> 'resolved'${alerts.length === 0 ? '' : ` AND fingerprint NOT IN (${alerts.map(() => '?').join(', ')})`}`)
      .bind(
        snapshot.sampledAt,
        snapshot.organizationId,
        snapshot.resourceType,
        snapshot.resourceId,
        ...alerts.map((alert) => alert.fingerprint),
      ),
  ]
  return { statements, summaryJson, bucket }
}

interface ArchiveEvidence {
  readonly batch: LogBatch
  readonly deployment: DeploymentScope
  readonly metadata: LogArchiveMetadata
  readonly fingerprint: string
}

interface ArchiveAttempt {
  readonly baseId: string
  readonly generation: number
  readonly id: string
}

interface ArchiveUploadLease {
  readonly id: string
  readonly expiresAt: string
}

interface EpochLogReservation {
  readonly firstSequence: number
  readonly lastSequence: number
  readonly fingerprint: string
  readonly archiveBaseId: string
  readonly state: 'reserved' | 'accepted'
  readonly archiveAttemptGeneration: number
  readonly archiveAttemptCount: number
  readonly archiveRetryState: 'active' | 'backoff' | 'quarantined'
  readonly archiveRetryAfter: string | null
}

const MAX_ARCHIVE_GENERATION = 3
const MAX_UNFINISHED_ARCHIVE_OPERATIONS_PER_NODE = 32
/** A Worker must prove this deadline-owned lease immediately before and after R2 PUT. */
const ARCHIVE_UPLOAD_DEADLINE_MILLISECONDS = 2 * 60_000

interface ArchiveUploadDeadline {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

const archiveUploadDeadlineMilliseconds = (bindings: TelemetryRuntimeBindings): number => {
  const configured = bindings.archiveUploadDeadlineMilliseconds
  return configured !== undefined && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, ARCHIVE_UPLOAD_DEADLINE_MILLISECONDS)
    : ARCHIVE_UPLOAD_DEADLINE_MILLISECONDS
}

/**
 * This timer starts at the actual R2 stream boundary, not when the HTTP body
 * first arrived. The stream adapter receives the signal and cannot yield any
 * further bytes after cancellation. D1 still retains the key until the R2
 * promise settles, so a platform-stalled writer is quarantined rather than
 * incorrectly inferred dead from wall time alone.
 */
const startArchiveUploadDeadline = (
  bindings: TelemetryRuntimeBindings,
  requestSignal: AbortSignal | undefined,
): ArchiveUploadDeadline => {
  const controller = new AbortController()
  const abortFromRequest = () => controller.abort()
  if (requestSignal?.aborted) controller.abort()
  else requestSignal?.addEventListener('abort', abortFromRequest, { once: true })
  const timeout = setTimeout(() => controller.abort(), archiveUploadDeadlineMilliseconds(bindings))
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      requestSignal?.removeEventListener('abort', abortFromRequest)
    },
  }
}

const archiveAttemptId = (baseId: string, generation: number): string =>
  generation === 0 ? baseId : `${baseId}_g${generation}`

const decodeEpochLogReservation = (value: unknown): EpochLogReservation | null | undefined => {
  if (value === null) return null
  const row = record(value)
  if (row === undefined) return undefined
  const firstSequence = nullableInteger(row, 'firstSequence')
  const lastSequence = nullableInteger(row, 'lastSequence')
  const fingerprint = text(row, 'fingerprint')
  const archiveBaseId = text(row, 'archiveBaseId')
  const state = text(row, 'state')
  const archiveAttemptGeneration = nullableInteger(row, 'archiveAttemptGeneration')
  const archiveAttemptCount = nullableInteger(row, 'archiveAttemptCount')
  const archiveRetryState = text(row, 'archiveRetryState')
  const archiveRetryAfter = nullableText(row, 'archiveRetryAfter')
  if (
    firstSequence === null ||
    firstSequence === undefined ||
    firstSequence < 1 ||
    lastSequence === null ||
    lastSequence === undefined ||
    lastSequence < firstSequence ||
    fingerprint === undefined ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    archiveBaseId === undefined ||
    (state !== 'reserved' && state !== 'accepted') ||
    archiveAttemptGeneration === null ||
    archiveAttemptGeneration === undefined ||
    archiveAttemptGeneration < 0 ||
    archiveAttemptGeneration > MAX_ARCHIVE_GENERATION ||
    archiveAttemptCount === null ||
    archiveAttemptCount === undefined ||
    archiveAttemptCount < 0 ||
    archiveAttemptCount > MAX_ARCHIVE_GENERATION + 1 ||
    !(
      (archiveAttemptCount === 0 && archiveAttemptGeneration === 0) ||
      archiveAttemptCount === archiveAttemptGeneration + 1
    ) ||
    (archiveRetryState !== 'active' &&
      archiveRetryState !== 'backoff' &&
      archiveRetryState !== 'quarantined') ||
    archiveRetryAfter === undefined ||
    (archiveRetryState === 'active' && archiveRetryAfter !== null) ||
    (archiveRetryState === 'backoff' && archiveRetryAfter === null) ||
    (archiveRetryState === 'quarantined' && archiveRetryAfter !== null)
  )
    return undefined
  return {
    firstSequence,
    lastSequence,
    fingerprint,
    archiveBaseId,
    state,
    archiveAttemptGeneration,
    archiveAttemptCount,
    archiveRetryState,
    archiveRetryAfter,
  }
}

/**
 * D1 owns the pre-upload contention point. It persists an exact, contiguous
 * epoch range before a pending row or an R2 key can exist. Reading back after
 * every batch deliberately adopts a response lost after commit, but never a
 * changed same-sequence body.
 */
const reserveEpochLogBatch = (
  bindings: TelemetryRuntimeBindings,
  principal: TelemetryPrincipal,
  deployment: DeploymentScope,
  batch: LogBatch,
  fingerprint: string,
  archiveBaseId: string,
  acceptedAt: string,
): Effect.Effect<EpochLogReservation, ConflictError | LogPersistenceError> =>
  Effect.gen(function* () {
    const persisted = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          bindings.database.batch([
            bindings.database
              .prepare(`INSERT OR IGNORE INTO telemetry_log_stream_epochs
          (organization_id, node_id, server_id, deployment_id, stream_epoch, created_at, last_authorized_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .bind(
                principal.organizationId,
                principal.nodeId,
                deployment.serverId,
                deployment.id,
                deployment.streamEpoch,
                acceptedAt,
                acceptedAt,
              ),
            // The first writer owns the sequence number. Later candidates must
            // read this immutable row and prove the exact same bytes fingerprint.
            bindings.database
              .prepare(`INSERT INTO telemetry_log_epoch_reservations
          (organization_id, node_id, server_id, deployment_id, stream_epoch,
           first_sequence, last_sequence, log_fingerprint, archive_base_id,
           state, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM telemetry_log_epoch_reservations
            WHERE organization_id = ? AND server_id = ? AND stream_epoch = ? AND first_sequence = ?
          )
          AND (
            SELECT COUNT(*) FROM telemetry_log_epoch_reservations
            WHERE organization_id = ? AND node_id = ? AND state = 'reserved'
          ) < ?`)
              .bind(
                principal.organizationId,
                principal.nodeId,
                deployment.serverId,
                deployment.id,
                deployment.streamEpoch,
                batch.firstSequence,
                batch.lastSequence,
                fingerprint,
                archiveBaseId,
                acceptedAt,
                acceptedAt,
                principal.organizationId,
                deployment.serverId,
                deployment.streamEpoch,
                batch.firstSequence,
                principal.organizationId,
                principal.nodeId,
                MAX_UNFINISHED_ARCHIVE_OPERATIONS_PER_NODE,
              ),
          ]),
        catch: () =>
          persistence(
            'telemetry.epoch-reservation.write',
            'Telemetry epoch reservation is unavailable',
          ),
      }),
    )
    const stored = yield* Effect.tryPromise({
      try: () =>
        bindings.database
          .prepare(`SELECT first_sequence AS firstSequence,
        last_sequence AS lastSequence, log_fingerprint AS fingerprint,
        archive_base_id AS archiveBaseId, state,
        archive_attempt_generation AS archiveAttemptGeneration,
        archive_attempt_count AS archiveAttemptCount,
        archive_retry_state AS archiveRetryState,
        archive_retry_after AS archiveRetryAfter
        FROM telemetry_log_epoch_reservations
        WHERE organization_id = ? AND server_id = ? AND stream_epoch = ? AND first_sequence = ?`)
          .bind(
            principal.organizationId,
            deployment.serverId,
            deployment.streamEpoch,
            batch.firstSequence,
          )
          .first(),
      catch: () =>
        persistence(
          'telemetry.epoch-reservation.read',
          'Telemetry epoch reservation is unavailable',
        ),
    })
    const reservation = decodeEpochLogReservation(stored)
    if (reservation === undefined)
      return yield* persistence(
        'telemetry.epoch-reservation.decode',
        'Stored telemetry epoch reservation is invalid',
      )
    if (reservation === null) {
      if (Result.isFailure(persisted)) return yield* persisted.failure
      const unfinished = yield* Effect.tryPromise({
        try: () =>
          bindings.database
            .prepare(`SELECT COUNT(*) AS count
            FROM telemetry_log_epoch_reservations
            WHERE organization_id = ? AND node_id = ? AND state = 'reserved'`)
            .bind(principal.organizationId, principal.nodeId)
            .first(),
        catch: () =>
          persistence(
            'telemetry.epoch-reservation.fleet',
            'Telemetry archive fleet capacity is unavailable',
          ),
      })
      const unfinishedCount =
        record(unfinished) === undefined ? undefined : nullableInteger(record(unfinished)!, 'count')
      if (
        unfinishedCount !== undefined &&
        unfinishedCount !== null &&
        unfinishedCount >= MAX_UNFINISHED_ARCHIVE_OPERATIONS_PER_NODE
      )
        return yield* persistence(
          'telemetry.epoch-reservation.fleet-saturated',
          'Telemetry archive fleet is saturated; the durable agent spool must retry later',
        )
      return yield* new ConflictError({
        code: 'telemetry_evidence_conflict',
        message: 'Telemetry log sequence is stale, out of order, or no longer in the active epoch',
      })
    }
    if (
      reservation.lastSequence !== batch.lastSequence ||
      reservation.fingerprint !== fingerprint ||
      reservation.archiveBaseId !== archiveBaseId
    )
      return yield* new ConflictError({
        code: 'telemetry_evidence_conflict',
        message: 'Telemetry log sequence is already reserved by different immutable evidence',
      })
    return reservation
  })

/**
 * The reservation is the bounded retry ledger. A writer that has not durably
 * settled remains quarantined on its original immutable key even after its
 * stream deadline: no timer is allowed to allocate a new generation.
 */
const resolveArchiveAttempt = (
  database: D1DatabaseLike,
  organizationId: string,
  reservation: EpochLogReservation,
  now: string,
): Effect.Effect<ArchiveAttempt, LogPersistenceError> =>
  reservation.state !== 'reserved'
    ? Effect.fail(
        persistence(
          'telemetry.archive-attempt.reservation',
          'Archive retry reservation is no longer active',
        ),
      )
    : reservation.archiveRetryState === 'quarantined'
      ? Effect.fail(
          persistence(
            'telemetry.archive-attempt.quarantined',
            'Archive retry generation budget is quarantined',
          ),
        )
      : reservation.archiveRetryState === 'backoff'
        ? reservation.archiveRetryAfter === null || reservation.archiveRetryAfter > now
          ? Effect.fail(
              persistence(
                'telemetry.archive-attempt.backoff',
                'Archive retry is backed off until its durable retry time',
              ),
            )
          : reservation.archiveAttemptGeneration >= MAX_ARCHIVE_GENERATION
            ? Effect.fail(
                persistence(
                  'telemetry.archive-attempt.quarantined',
                  'Archive retry generation budget is quarantined',
                ),
              )
            : Effect.succeed({
                baseId: reservation.archiveBaseId,
                generation: reservation.archiveAttemptGeneration + 1,
                id: archiveAttemptId(
                  reservation.archiveBaseId,
                  reservation.archiveAttemptGeneration + 1,
                ),
              })
        : reservation.archiveAttemptCount === 0
          ? Effect.succeed({
              baseId: reservation.archiveBaseId,
              generation: 0,
              id: reservation.archiveBaseId,
            })
          : Effect.tryPromise({
              try: () =>
                database
                  .prepare(`SELECT archive_id AS archiveId,
                archive_base_id AS archiveBaseId, archive_generation AS archiveGeneration,
                state, cleanup_lease_id AS cleanupLeaseId,
                cleanup_lease_expires_at AS cleanupLeaseExpiresAt,
                cleanup_claimed_ever AS cleanupClaimedEver,
                upload_lease_id AS uploadLeaseId,
                upload_claimed_at AS uploadClaimedAt,
                upload_lease_expires_at AS uploadLeaseExpiresAt,
                upload_claimed_ever AS uploadClaimedEver,
                upload_writer_state AS uploadWriterState,
                upload_writer_terminated_at AS uploadWriterTerminatedAt
                FROM telemetry_pending_archive_uploads
                WHERE organization_id = ? AND archive_base_id = ?
                  AND archive_generation = ?`)
                  .bind(
                    organizationId,
                    reservation.archiveBaseId,
                    reservation.archiveAttemptGeneration,
                  )
                  .first(),
              catch: () =>
                persistence(
                  'telemetry.archive-attempt.read',
                  'Archive retry generation lookup is unavailable',
                ),
            }).pipe(
              Effect.flatMap((value) => {
                const row = record(value)
                const archiveId = row === undefined ? undefined : text(row, 'archiveId')
                const archiveBaseId = row === undefined ? undefined : text(row, 'archiveBaseId')
                const archiveGeneration =
                  row === undefined ? undefined : nullableInteger(row, 'archiveGeneration')
                const state = row === undefined ? undefined : text(row, 'state')
                const cleanupLeaseId =
                  row === undefined ? undefined : nullableText(row, 'cleanupLeaseId')
                const cleanupLeaseExpiresAt =
                  row === undefined ? undefined : nullableText(row, 'cleanupLeaseExpiresAt')
                const cleanupClaimedEver =
                  row === undefined ? undefined : nullableInteger(row, 'cleanupClaimedEver')
                const uploadLeaseId =
                  row === undefined ? undefined : nullableText(row, 'uploadLeaseId')
                const uploadClaimedAt =
                  row === undefined ? undefined : nullableText(row, 'uploadClaimedAt')
                const uploadLeaseExpiresAt =
                  row === undefined ? undefined : nullableText(row, 'uploadLeaseExpiresAt')
                const uploadClaimedEver =
                  row === undefined ? undefined : nullableInteger(row, 'uploadClaimedEver')
                const uploadWriterState =
                  row === undefined ? undefined : text(row, 'uploadWriterState')
                const uploadWriterTerminatedAt =
                  row === undefined ? undefined : nullableText(row, 'uploadWriterTerminatedAt')
                if (
                  archiveId === undefined ||
                  archiveBaseId !== reservation.archiveBaseId ||
                  archiveGeneration === undefined ||
                  archiveGeneration === null ||
                  archiveGeneration !== reservation.archiveAttemptGeneration ||
                  archiveId !== archiveAttemptId(reservation.archiveBaseId, archiveGeneration) ||
                  (state !== 'pending' && state !== 'accepted' && state !== 'cleaned') ||
                  cleanupLeaseId === undefined ||
                  cleanupLeaseExpiresAt === undefined ||
                  (cleanupClaimedEver !== 0 && cleanupClaimedEver !== 1) ||
                  (cleanupLeaseId === null) !== (cleanupLeaseExpiresAt === null) ||
                  uploadLeaseId === undefined ||
                  uploadClaimedAt === undefined ||
                  uploadLeaseExpiresAt === undefined ||
                  (uploadClaimedEver !== 0 && uploadClaimedEver !== 1) ||
                  (uploadClaimedEver === 0 &&
                    (uploadLeaseId !== null ||
                      uploadClaimedAt !== null ||
                      uploadLeaseExpiresAt !== null)) ||
                  (uploadClaimedEver === 1 &&
                    (uploadClaimedAt === null || uploadLeaseExpiresAt === null)) ||
                  (uploadWriterState !== 'unresolved' && uploadWriterState !== 'terminated') ||
                  uploadWriterTerminatedAt === undefined ||
                  (uploadWriterState === 'unresolved' && uploadWriterTerminatedAt !== null) ||
                  (uploadWriterState === 'terminated' && uploadWriterTerminatedAt === null)
                )
                  return Effect.fail(
                    persistence(
                      'telemetry.archive-attempt.decode',
                      'Stored archive retry generation is invalid',
                    ),
                  )
                if (
                  state === 'pending' &&
                  cleanupLeaseId === null &&
                  cleanupClaimedEver === 0 &&
                  uploadClaimedEver === 0 &&
                  uploadWriterState === 'unresolved'
                )
                  return Effect.succeed({
                    baseId: reservation.archiveBaseId,
                    generation: archiveGeneration,
                    id: archiveId,
                  })
                if (uploadWriterState === 'terminated' || state === 'cleaned')
                  return Effect.fail(
                    persistence(
                      'telemetry.archive-attempt.reconciliation-pending',
                      'The terminal archive generation is awaiting fair reconciliation',
                    ),
                  )
                if (
                  state === 'pending' &&
                  uploadLeaseId !== null &&
                  uploadLeaseExpiresAt !== null &&
                  uploadLeaseExpiresAt <= now
                )
                  return Effect.fail(
                    persistence(
                      'telemetry.archive-attempt.quarantined',
                      'Archive upload deadline elapsed before writer termination was proven',
                    ),
                  )
                return Effect.fail(
                  persistence(
                    'telemetry.archive-attempt.in-flight',
                    'An exact immutable archive upload is already in progress',
                  ),
                )
              }),
            )

/** Persist an exact cleanup target before R2 receives immutable bytes. */
const persistPendingArchiveUpload = (
  bindings: TelemetryRuntimeBindings,
  principal: TelemetryPrincipal,
  deployment: DeploymentScope,
  reservation: EpochLogReservation,
  attempt: ArchiveAttempt,
  metadata: LogArchiveMetadata,
  compressedSha256: string,
): Effect.Effect<'ready' | 'accepted', LogPersistenceError> =>
  Effect.gen(function* () {
    const now = new Date(bindings.now?.() ?? Date.now()).toISOString()
    const initialCleanupAfter = new Date(
      (bindings.now?.() ?? Date.now()) + 60 * 60_000,
    ).toISOString()
    const streamEpoch = metadata.streamEpoch
    if (streamEpoch === undefined)
      return yield* persistence(
        'telemetry.pending-archive',
        'Epoch-bound archive metadata is required',
      )
    if (metadata.id !== attempt.id || !metadata.r2Key.endsWith(`/${attempt.id}.ndjson.gz`))
      return yield* persistence(
        'telemetry.pending-archive',
        'Archive retry generation does not own its R2 key',
      )
    if (attempt.generation < 0 || attempt.generation > MAX_ARCHIVE_GENERATION)
      return yield* persistence(
        'telemetry.pending-archive',
        'Archive retry generation is outside the bounded retry budget',
      )
    // A competing identical request may create this immutable intent first.
    // Do not fail a lost/contended response until the exact stored target has
    // been checked: only matching immutable metadata is safe to adopt.
    if (
      reservation.state !== 'reserved' ||
      reservation.archiveBaseId !== attempt.baseId ||
      reservation.firstSequence < 1
    )
      return yield* persistence(
        'telemetry.pending-archive',
        'Epoch reservation is not available for immutable upload',
      )
    yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          bindings.database.batch([
            // The reservation owns bounded retry progression. Updating it and
            // inserting the physical pending row in one D1 batch prevents a
            // response-loss retry from allocating another generation.
            bindings.database
              .prepare(`UPDATE telemetry_log_epoch_reservations
            SET archive_attempt_generation = ?, archive_attempt_count = archive_attempt_count + 1,
                archive_retry_state = 'active', archive_retry_after = NULL, updated_at = ?
            WHERE organization_id = ? AND node_id = ? AND server_id = ?
              AND deployment_id = ? AND stream_epoch = ? AND first_sequence = ?
              AND last_sequence = ? AND log_fingerprint = ? AND archive_base_id = ?
              AND state = 'reserved'
              AND (
                (
                  archive_attempt_count = 0 AND archive_attempt_generation = 0
                  AND archive_retry_state = 'active' AND ? = 0
                )
                OR (
                  archive_retry_state = 'backoff' AND archive_retry_after <= ?
                  AND archive_attempt_generation = ? AND ? = archive_attempt_generation + 1
                )
              )`)
              .bind(
                attempt.generation,
                now,
                principal.organizationId,
                principal.nodeId,
                deployment.serverId,
                deployment.id,
                streamEpoch,
                reservation.firstSequence,
                reservation.lastSequence,
                reservation.fingerprint,
                reservation.archiveBaseId,
                attempt.generation,
                now,
                reservation.archiveAttemptGeneration,
                attempt.generation,
              ),
            bindings.database
              .prepare(`INSERT OR IGNORE INTO telemetry_pending_archive_uploads
          (organization_id, archive_id, archive_base_id, archive_generation,
           node_id, server_id, deployment_id, stream_epoch, r2_key,
           sha256, compressed_sha256, entry_count, uncompressed_bytes, compressed_bytes,
           state, created_at, updated_at, cleanup_after)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM telemetry_log_epoch_reservations
            WHERE organization_id = ? AND node_id = ? AND server_id = ?
              AND deployment_id = ? AND stream_epoch = ? AND first_sequence = ?
              AND last_sequence = ? AND log_fingerprint = ? AND archive_base_id = ?
              AND state = 'reserved'
              AND archive_attempt_generation = ?
              AND archive_attempt_count = ?
              AND archive_retry_state = 'active'
          )`)
              .bind(
                principal.organizationId,
                metadata.id,
                attempt.baseId,
                attempt.generation,
                principal.nodeId,
                deployment.serverId,
                deployment.id,
                streamEpoch,
                metadata.r2Key,
                metadata.sha256,
                compressedSha256,
                metadata.entryCount,
                metadata.uncompressedBytes,
                metadata.compressedBytes,
                now,
                now,
                initialCleanupAfter,
                principal.organizationId,
                principal.nodeId,
                deployment.serverId,
                deployment.id,
                streamEpoch,
                reservation.firstSequence,
                reservation.lastSequence,
                reservation.fingerprint,
                reservation.archiveBaseId,
                attempt.generation,
                attempt.generation + 1,
              ),
          ]),
        catch: (cause) => cause,
      }),
    )
    const readStored = () =>
      Effect.tryPromise({
        try: () =>
          bindings.database
            .prepare(`SELECT node_id AS nodeId, server_id AS serverId,
        deployment_id AS deploymentId, stream_epoch AS streamEpoch, r2_key AS r2Key,
        archive_base_id AS archiveBaseId, archive_generation AS archiveGeneration,
        sha256, compressed_sha256 AS compressedSha256, entry_count AS entryCount,
        uncompressed_bytes AS uncompressedBytes, compressed_bytes AS compressedBytes,
        state, cleanup_lease_id AS cleanupLeaseId,
        cleanup_lease_expires_at AS cleanupLeaseExpiresAt,
        cleanup_claimed_ever AS cleanupClaimedEver,
        upload_lease_id AS uploadLeaseId,
        upload_claimed_at AS uploadClaimedAt,
        upload_lease_expires_at AS uploadLeaseExpiresAt,
        upload_claimed_ever AS uploadClaimedEver,
        upload_writer_state AS uploadWriterState,
        upload_writer_terminated_at AS uploadWriterTerminatedAt
        FROM telemetry_pending_archive_uploads
        WHERE organization_id = ? AND archive_id = ?`)
            .bind(principal.organizationId, metadata.id)
            .first(),
        catch: () =>
          persistence('telemetry.pending-archive', 'Pending archive intent could not be verified'),
      })
    const row = record(yield* readStored())
    if (
      row === undefined ||
      text(row, 'archiveBaseId') !== attempt.baseId ||
      nullableInteger(row, 'archiveGeneration') !== attempt.generation ||
      text(row, 'nodeId') !== principal.nodeId ||
      text(row, 'serverId') !== deployment.serverId ||
      text(row, 'deploymentId') !== deployment.id ||
      text(row, 'streamEpoch') !== streamEpoch ||
      text(row, 'r2Key') !== metadata.r2Key ||
      text(row, 'sha256') !== metadata.sha256 ||
      text(row, 'compressedSha256') !== compressedSha256 ||
      nullableInteger(row, 'entryCount') !== metadata.entryCount ||
      nullableInteger(row, 'uncompressedBytes') !== metadata.uncompressedBytes ||
      nullableInteger(row, 'compressedBytes') !== metadata.compressedBytes
    )
      return yield* persistence(
        'telemetry.pending-archive',
        'Pending archive identity conflicts with immutable bytes',
      )
    const state = text(row, 'state')
    const cleanupLeaseId = nullableText(row, 'cleanupLeaseId')
    const cleanupLeaseExpiresAt = nullableText(row, 'cleanupLeaseExpiresAt')
    const cleanupClaimedEver = nullableInteger(row, 'cleanupClaimedEver')
    const uploadLeaseId = nullableText(row, 'uploadLeaseId')
    const uploadClaimedAt = nullableText(row, 'uploadClaimedAt')
    const uploadLeaseExpiresAt = nullableText(row, 'uploadLeaseExpiresAt')
    const uploadClaimedEver = nullableInteger(row, 'uploadClaimedEver')
    const uploadWriterState = text(row, 'uploadWriterState')
    const uploadWriterTerminatedAt = nullableText(row, 'uploadWriterTerminatedAt')
    if (
      state === undefined ||
      cleanupLeaseId === undefined ||
      cleanupLeaseExpiresAt === undefined ||
      (cleanupClaimedEver !== 0 && cleanupClaimedEver !== 1) ||
      (cleanupLeaseId === null) !== (cleanupLeaseExpiresAt === null) ||
      uploadLeaseId === undefined ||
      uploadClaimedAt === undefined ||
      uploadLeaseExpiresAt === undefined ||
      (uploadClaimedEver !== 0 && uploadClaimedEver !== 1) ||
      (uploadWriterState !== 'unresolved' && uploadWriterState !== 'terminated') ||
      uploadWriterTerminatedAt === undefined ||
      (uploadClaimedEver === 0 &&
        (uploadLeaseId !== null || uploadClaimedAt !== null || uploadLeaseExpiresAt !== null)) ||
      (uploadClaimedEver === 1 && (uploadClaimedAt === null || uploadLeaseExpiresAt === null)) ||
      (uploadWriterState === 'unresolved' && uploadWriterTerminatedAt !== null) ||
      (uploadWriterState === 'terminated' && uploadWriterTerminatedAt === null)
    )
      return yield* persistence(
        'telemetry.pending-archive',
        'Pending archive cleanup state is invalid',
      )
    if (state === 'accepted') return 'accepted' as const
    if (state !== 'pending')
      return yield* persistence(
        'telemetry.pending-archive',
        'Pending archive is not available for immutable upload',
      )
    if (
      cleanupLeaseId !== null ||
      cleanupClaimedEver !== 0 ||
      uploadClaimedEver !== 0 ||
      uploadWriterState !== 'unresolved'
    )
      return yield* persistence(
        'telemetry.pending-archive',
        'Pending archive cleanup is currently fenced',
      )
    return 'ready' as const
  })

/**
 * The exact archive generation receives one hard-deadline upload owner before
 * its R2 PUT begins. A later ingress retry never reuses that key until its
 * stream writer has durably settled and reconciliation compacts the attempt.
 */
const claimArchiveUploadLease = (
  bindings: TelemetryRuntimeBindings,
  organizationId: string,
  archiveId: string,
): Effect.Effect<ArchiveUploadLease, LogPersistenceError> =>
  Effect.gen(function* () {
    const claimedAt = new Date(bindings.now?.() ?? Date.now()).toISOString()
    const claimedAtMilliseconds = Date.parse(claimedAt)
    if (!Number.isFinite(claimedAtMilliseconds))
      return yield* persistence(
        'telemetry.archive-upload-lease.clock',
        'Archive upload clock is invalid',
      )
    const expiresAt = new Date(
      claimedAtMilliseconds + archiveUploadDeadlineMilliseconds(bindings),
    ).toISOString()
    const lease: ArchiveUploadLease = { id: crypto.randomUUID(), expiresAt }
    const result = yield* Effect.tryPromise({
      try: () =>
        bindings.database
          .prepare(`UPDATE telemetry_pending_archive_uploads
        SET upload_lease_id = ?, upload_claimed_at = ?, upload_lease_expires_at = ?,
            upload_claimed_ever = 1, upload_watch_after = ?, upload_watch_until = NULL,
            upload_watch_required = 1, updated_at = ?
        WHERE organization_id = ? AND archive_id = ? AND state = 'pending'
          AND cleanup_lease_id IS NULL AND cleanup_claimed_ever = 0
          AND upload_claimed_ever = 0
          AND NOT EXISTS (
            SELECT 1 FROM telemetry_ingestion_receipts receipt
            WHERE receipt.organization_id = telemetry_pending_archive_uploads.organization_id
              AND receipt.archive_id = telemetry_pending_archive_uploads.archive_id
          )`)
          .bind(lease.id, claimedAt, expiresAt, expiresAt, claimedAt, organizationId, archiveId)
          .run(),
      catch: () =>
        persistence('telemetry.archive-upload-lease.claim', 'Archive upload lease is unavailable'),
    })
    if (result.meta?.changes !== 1)
      return yield* persistence(
        'telemetry.archive-upload-lease.claim',
        'Archive upload lease was not available for this immutable generation',
      )
    return lease
  })

/** Prove ownership immediately before and after R2 side effects using wall-clock D1 state. */
const ownsArchiveUploadLease = (
  bindings: TelemetryRuntimeBindings,
  organizationId: string,
  archiveId: string,
  lease: ArchiveUploadLease,
): Effect.Effect<boolean, LogPersistenceError> =>
  Effect.tryPromise({
    try: () =>
      bindings.database
        .prepare(`SELECT state, cleanup_lease_id AS cleanupLeaseId,
      cleanup_claimed_ever AS cleanupClaimedEver, upload_lease_id AS uploadLeaseId,
      upload_lease_expires_at AS uploadLeaseExpiresAt,
      upload_claimed_ever AS uploadClaimedEver, upload_watch_required AS uploadWatchRequired
      FROM telemetry_pending_archive_uploads
      WHERE organization_id = ? AND archive_id = ?`)
        .bind(organizationId, archiveId)
        .first(),
    catch: () =>
      persistence('telemetry.archive-upload-lease.read', 'Archive upload lease is unavailable'),
  }).pipe(
    Effect.flatMap((value) => {
      const row = record(value)
      const state = row === undefined ? undefined : text(row, 'state')
      const cleanupLeaseId = row === undefined ? undefined : nullableText(row, 'cleanupLeaseId')
      const cleanupClaimedEver =
        row === undefined ? undefined : nullableInteger(row, 'cleanupClaimedEver')
      const uploadLeaseId = row === undefined ? undefined : nullableText(row, 'uploadLeaseId')
      const uploadLeaseExpiresAt =
        row === undefined ? undefined : nullableText(row, 'uploadLeaseExpiresAt')
      const uploadClaimedEver =
        row === undefined ? undefined : nullableInteger(row, 'uploadClaimedEver')
      const uploadWatchRequired =
        row === undefined ? undefined : nullableInteger(row, 'uploadWatchRequired')
      if (
        state === undefined ||
        cleanupLeaseId === undefined ||
        cleanupClaimedEver === undefined ||
        uploadLeaseId === undefined ||
        uploadLeaseExpiresAt === undefined ||
        uploadClaimedEver === undefined ||
        uploadWatchRequired === undefined ||
        (state !== 'pending' && state !== 'accepted' && state !== 'cleaned') ||
        (cleanupClaimedEver !== 0 && cleanupClaimedEver !== 1) ||
        (uploadClaimedEver !== 0 && uploadClaimedEver !== 1) ||
        (uploadWatchRequired !== 0 && uploadWatchRequired !== 1)
      )
        return Effect.fail(
          persistence(
            'telemetry.archive-upload-lease.decode',
            'Archive upload lease state is invalid',
          ),
        )
      const now = new Date(bindings.now?.() ?? Date.now()).toISOString()
      return Effect.succeed(
        state === 'pending' &&
          cleanupLeaseId === null &&
          cleanupClaimedEver === 0 &&
          uploadClaimedEver === 1 &&
          uploadWatchRequired === 1 &&
          uploadLeaseId === lease.id &&
          uploadLeaseExpiresAt === lease.expiresAt &&
          lease.expiresAt > now,
      )
    }),
  )

/**
 * A settled R2 write (success is finalized by the receipt batch; failure is
 * recorded here) is the only proof that permits queue cleanup to release an
 * immutable key. A lost D1 response adopts the exact terminal row instead of
 * guessing from the upload deadline.
 */
const terminateArchiveUploadWriter = (
  bindings: TelemetryRuntimeBindings,
  organizationId: string,
  archiveId: string,
  lease: ArchiveUploadLease,
): Effect.Effect<void, LogPersistenceError> =>
  Effect.gen(function* () {
    const now = new Date(bindings.now?.() ?? Date.now()).toISOString()
    yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          bindings.database
            .prepare(`UPDATE telemetry_pending_archive_uploads
          SET upload_lease_id = NULL, upload_watch_required = 0,
              upload_writer_state = 'terminated', upload_writer_terminated_at = ?, updated_at = ?
          WHERE organization_id = ? AND archive_id = ? AND state = 'pending'
            AND cleanup_lease_id IS NULL AND cleanup_claimed_ever = 0
            AND upload_claimed_ever = 1 AND upload_writer_state = 'unresolved'
            AND upload_writer_terminated_at IS NULL AND upload_lease_id = ?
            AND upload_lease_expires_at = ?`)
            .bind(now, now, organizationId, archiveId, lease.id, lease.expiresAt)
            .run(),
        catch: () =>
          persistence(
            'telemetry.archive-upload-lease.terminate',
            'Archive upload termination could not be recorded',
          ),
      }),
    )
    const row = record(
      yield* Effect.tryPromise({
        try: () =>
          bindings.database
            .prepare(`SELECT state, upload_lease_id AS uploadLeaseId,
            upload_lease_expires_at AS uploadLeaseExpiresAt,
            upload_writer_state AS uploadWriterState,
            upload_writer_terminated_at AS uploadWriterTerminatedAt
            FROM telemetry_pending_archive_uploads
            WHERE organization_id = ? AND archive_id = ?`)
            .bind(organizationId, archiveId)
            .first(),
        catch: () =>
          persistence(
            'telemetry.archive-upload-lease.terminate-read',
            'Archive upload termination could not be verified',
          ),
      }),
    )
    const state = row === undefined ? undefined : text(row, 'state')
    const uploadLeaseId = row === undefined ? undefined : nullableText(row, 'uploadLeaseId')
    const uploadLeaseExpiresAt =
      row === undefined ? undefined : nullableText(row, 'uploadLeaseExpiresAt')
    const uploadWriterState = row === undefined ? undefined : text(row, 'uploadWriterState')
    const uploadWriterTerminatedAt =
      row === undefined ? undefined : nullableText(row, 'uploadWriterTerminatedAt')
    if (
      state === 'pending' &&
      uploadLeaseId === null &&
      uploadLeaseExpiresAt === lease.expiresAt &&
      uploadWriterState === 'terminated' &&
      uploadWriterTerminatedAt !== null &&
      uploadWriterTerminatedAt !== undefined
    )
      return
    return yield* persistence(
      'telemetry.archive-upload-lease.terminate',
      'Archive upload termination was not durably proven',
    )
  })

/**
 * Builds a production ingress adapter. Bodies never choose their tenant or
 * node: the caller supplies the authenticated credential principal.
 */
export const makeTelemetryIngestor = (bindings: TelemetryRuntimeBindings) => ({
  ingest: (
    principal: TelemetryPrincipal,
    payload: AgentTelemetryPayload,
    source: TelemetryRequestSource = {},
  ): Effect.Effect<
    AgentTelemetryReceipt,
    | AuthorizationError
    | ConflictError
    | PersistenceError
    | LogPersistenceError
    | LogR2Error
    | LogValidationError
    | import('@gridora/health-control').HealthValidationError
  > =>
    Effect.gen(function* () {
      const now = bindings.now?.() ?? Date.now()
      let acceptedAt = new Date(now).toISOString()
      yield* validatePrincipalScope(principal, payload)
      const facts = yield* readFacts(bindings.database, principal)
      if (facts.sessionAgentVersion !== payload.health.agentVersion)
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'Telemetry agent version does not match the active session',
        })
      const scoped = yield* validateLogScope(bindings.database, principal, payload.logs)
      const serverHealthScopes = yield* validateServerHealthScope(
        bindings.database,
        principal,
        payload,
      )
      const payloadFingerprint = yield* sha256Hex(canonicalJson(payload))
      const existing = yield* findReceipt(bindings.database, principal, payloadFingerprint)
      if (existing !== null) {
        yield* enqueuePendingPublication(bindings, principal.organizationId, existing.id)
        return receiptResponse(existing, true)
      }
      yield* validateSampleAcceptanceWindow(payload.health.sampledAt, now)

      const node = yield* evaluateNodeHealth(
        {
          organizationId: principal.organizationId,
          nodeId: principal.nodeId,
          sampledAt: payload.health.sampledAt,
          provider: { state: facts.providerState },
          agentLastSeenAt: payload.health.sampledAt,
          agentVersion: payload.health.agentVersion,
          supportedAgent: payload.health.agentVersion === bindings.supportedAgentVersion,
          tunnel: payload.health.tunnel,
          docker: payload.health.docker,
          firewall: payload.health.firewall,
          cpuUsedMillis: payload.health.cpuUsedMillis,
          cpuTotalMillis: payload.health.cpuTotalMillis,
          ramUsedBytes: payload.health.ramUsedBytes,
          ramTotalBytes: payload.health.ramTotalBytes,
          diskUsedBytes: payload.health.diskUsedBytes,
          diskTotalBytes: payload.health.diskTotalBytes,
          loadPermille: payload.health.loadPermille,
          networkReceiveBytes: payload.health.networkReceiveBytes,
          networkTransmitBytes: payload.health.networkTransmitBytes,
          containers: payload.health.containers,
        },
        now,
      )
      const alerts = deriveHealthAlerts(node)
      const serverHealth = yield* Effect.forEach(
        serverHealthScopes,
        (scope) =>
          evaluateServerHealth(
            {
              organizationId: principal.organizationId,
              nodeId: principal.nodeId,
              serverId: scope.sample.serverId,
              deploymentId: scope.deployment.id,
              sampledAt: payload.health.sampledAt,
              container: scope.container,
              game: scope.sample.game,
              // Backup and operation truth remain control-plane-owned. This writer
              // deliberately does not manufacture those facts from agent payloads.
              lastSuccessfulBackupAt: null,
              backupStale: false,
              currentOperation: null,
              operationFailed: false,
            },
            node,
            now,
          ),
        { concurrency: 1 },
      )
      const before = yield* readHealthBefore(bindings.database, principal)
      const receiptId = `telemetry_${payloadFingerprint}`
      // The operation and staged envelope must share the request correlation.
      // A trusted edge request supplies it; the deterministic internal fallback
      // exists only for direct/runtime tests that do not cross the HTTP adapter.
      const request: AuditRequestContextValue = source.request ?? {
        origin: 'internal',
        requestId: `telemetry_${payloadFingerprint}`,
        correlationId: `corr_telemetry_${payloadFingerprint}`,
        source: {
          ip: { state: 'not-available', reason: 'internal-telemetry-test-context' },
          access: { state: 'not-available', reason: 'machine-bearer-credential' },
        },
      }
      const machineDigest = yield* sha256Hex(
        `gridora-machine-audit-v1:${principal.organizationId}:${principal.nodeId}:${principal.credentialId}:${principal.version}`,
      )
      const machineIdentityId = `machine_${machineDigest}`
      // Operations/correlations pass through the public inventory schema, whose
      // identifiers deliberately exclude punctuation such as a colon.
      const operationId = `op_telemetry_${payloadFingerprint}`
      const auditEventId = `audit_telemetry_${payloadFingerprint}`
      const correlationId = request.correlationId

      let archive: ArchiveEvidence | undefined
      let archiveUploadLease: ArchiveUploadLease | undefined
      if (scoped.logs !== undefined && scoped.deployment !== undefined) {
        const logFingerprint = yield* sha256Hex(canonicalJson(scoped.logs))
        const archiveBaseId = `archive_${logFingerprint}`
        const reservation = yield* reserveEpochLogBatch(
          bindings,
          principal,
          scoped.deployment,
          scoped.logs,
          logFingerprint,
          archiveBaseId,
          acceptedAt,
        )
        if (reservation.state === 'accepted') {
          const accepted = yield* findReceipt(bindings.database, principal, payloadFingerprint)
          if (accepted !== null) {
            yield* enqueuePendingPublication(bindings, principal.organizationId, accepted.id)
            return receiptResponse(accepted, true)
          }
          return yield* new ConflictError({
            code: 'telemetry_evidence_conflict',
            message:
              'Telemetry log sequence has already been accepted with different immutable evidence',
          })
        }
        const attempt = yield* resolveArchiveAttempt(
          bindings.database,
          principal.organizationId,
          reservation,
          acceptedAt,
        )
        const prepared = yield* prepareLogArchive(scoped.logs, {
          archiveId: attempt.id,
          createdAt: scoped.logs.entries.at(-1)!.timestamp,
          expiresAt: null,
          streamEpoch: scoped.deployment.streamEpoch,
          archiveGeneration: attempt.generation,
        })
        const pending = yield* persistPendingArchiveUpload(
          bindings,
          principal,
          scoped.deployment,
          reservation,
          attempt,
          prepared.metadata,
          prepared.customMetadata.compressedSha256!,
        )
        if (pending === 'accepted') {
          const accepted = yield* findReceipt(bindings.database, principal, payloadFingerprint)
          if (accepted !== null) {
            yield* enqueuePendingPublication(bindings, principal.organizationId, accepted.id)
            return receiptResponse(accepted, true)
          }
          return yield* persistence(
            'telemetry.pending-archive',
            'Accepted archive does not match this immutable telemetry receipt',
          )
        }
        const uploadLease = yield* claimArchiveUploadLease(
          bindings,
          principal.organizationId,
          prepared.metadata.id,
        )
        if (
          !(yield* ownsArchiveUploadLease(
            bindings,
            principal.organizationId,
            prepared.metadata.id,
            uploadLease,
          ))
        )
          return yield* persistence(
            'telemetry.archive-upload-lease.pre-put',
            'Archive upload lease was lost before immutable R2 write',
          )
        const uploadDeadline = startArchiveUploadDeadline(bindings, source.requestSignal)
        const uploaded = yield* Effect.result(
          uploadPreparedLogArchive(
            makeDeadlineAwareCloudflareLogR2Bucket(bindings.logBucket),
            prepared,
            { signal: uploadDeadline.signal },
          ),
        )
        const uploadDeadlineElapsed = uploadDeadline.signal.aborted
        uploadDeadline.dispose()
        if (Result.isFailure(uploaded)) {
          yield* terminateArchiveUploadWriter(
            bindings,
            principal.organizationId,
            prepared.metadata.id,
            uploadLease,
          )
          return yield* uploaded.failure
        }
        // R2 may have consumed the finite stream before the deadline yet delay
        // its own completion response. Its external bytes are still retained
        // as an exact cleanup target, but the late completion is never allowed
        // to become a D1 receipt/acceptance commit.
        if (uploadDeadlineElapsed) {
          yield* terminateArchiveUploadWriter(
            bindings,
            principal.organizationId,
            prepared.metadata.id,
            uploadLease,
          )
          return yield* persistence(
            'telemetry.archive-upload-deadline',
            'Archive R2 completion exceeded the application upload deadline',
          )
        }
        const stored = uploaded.success
        if (
          !(yield* ownsArchiveUploadLease(
            bindings,
            principal.organizationId,
            prepared.metadata.id,
            uploadLease,
          ))
        ) {
          yield* terminateArchiveUploadWriter(
            bindings,
            principal.organizationId,
            prepared.metadata.id,
            uploadLease,
          )
          return yield* persistence(
            'telemetry.archive-upload-lease.post-put',
            'Archive upload completed after its ownership lease was lost; exact cleanup is required',
          )
        }
        archive = {
          batch: scoped.logs,
          deployment: scoped.deployment,
          metadata: stored.metadata,
          fingerprint: logFingerprint,
        }
        archiveUploadLease = uploadLease
      }

      // Reservation time is ingress evidence; immutable receipt/audit evidence
      // records the control-plane instant immediately before its final D1 batch.
      acceptedAt = new Date(bindings.now?.() ?? Date.now()).toISOString()
      if (archive !== undefined && archiveUploadLease === undefined)
        return yield* persistence(
          'telemetry.archive-upload-lease',
          'Archive evidence has no active upload owner',
        )

      // The compact row is intentionally the exact post-state in the staged
      // envelope; migration 0028 rejects any audit/event divergence. Versions
      // that bind the machine credential live in the immutable receipt, rather
      // than in a redaction-sensitive compact audit summary.
      const auditAfterSummary = {
        status: node.status,
        sampledAt: node.sampledAt,
        acceptedAt,
        receiptId,
        payloadFingerprint,
        sessionVersion: principal.sessionVersion,
        ...(archive === undefined
          ? {}
          : {
              archiveId: archive.metadata.id,
              archiveSha256: archive.metadata.sha256,
              streamEpoch: archive.deployment.streamEpoch,
              firstSequence: archive.batch.firstSequence,
              lastSequence: archive.batch.lastSequence,
            }),
      }

      const health = healthStatements(bindings.database, node, alerts)
      const serverHealthStatements = serverHealth.flatMap(
        (snapshot) =>
          healthStatements(bindings.database, snapshot, deriveHealthAlerts(snapshot)).statements,
      )
      const envelope = yield* completeAuditEnvelope({
        occurredAt: acceptedAt,
        scope: 'tenant',
        organizationId: principal.organizationId,
        actor: { type: 'machine', id: machineIdentityId },
        action: 'agent.telemetry.accepted',
        target: { type: 'node', id: principal.nodeId },
        before,
        after: {
          state: 'captured',
          summary: auditAfterSummary,
        },
        operationId,
        request,
        result: 'succeeded',
        error: { classification: 'none', code: null },
        forced: false,
        breakGlass: false,
      }).pipe(
        Effect.mapError(() =>
          persistence('telemetry.audit.stage', 'Telemetry audit envelope is invalid'),
        ),
      )
      const staged = yield* stageAuditEnvelope('tenant', auditEventId, envelope, acceptedAt).pipe(
        Effect.mapError(() =>
          persistence('telemetry.audit.stage', 'Telemetry audit envelope is invalid'),
        ),
      )

      const archiveStatements =
        archive === undefined
          ? []
          : [
              bindings.database
                .prepare(`INSERT OR IGNORE INTO log_archives
            (organization_id, id, server_id, node_id, stream_epoch, r2_key, compression, first_timestamp,
             last_timestamp, entry_count, uncompressed_bytes, compressed_bytes, sha256,
             state, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, 'gzip', ?, ?, ?, ?, ?, ?, 'available', ?, NULL)`)
                .bind(
                  archive.metadata.organizationId,
                  archive.metadata.id,
                  archive.metadata.serverId,
                  archive.metadata.nodeId,
                  archive.deployment.streamEpoch,
                  archive.metadata.r2Key,
                  archive.metadata.firstTimestamp,
                  archive.metadata.lastTimestamp,
                  archive.metadata.entryCount,
                  archive.metadata.uncompressedBytes,
                  archive.metadata.compressedBytes,
                  archive.metadata.sha256,
                  archive.metadata.createdAt,
                ),
              bindings.database
                .prepare(`INSERT OR IGNORE INTO telemetry_log_stream_epoch_watermarks
            (organization_id, node_id, server_id, deployment_id, stream_epoch,
             last_sequence, last_timestamp, last_fingerprint, revision)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE ? = 1`)
                .bind(
                  principal.organizationId,
                  principal.nodeId,
                  archive.deployment.serverId,
                  archive.deployment.id,
                  archive.deployment.streamEpoch,
                  archive.batch.lastSequence,
                  archive.metadata.lastTimestamp,
                  archive.fingerprint,
                  archive.batch.firstSequence,
                ),
              bindings.database
                .prepare(`UPDATE telemetry_log_stream_epoch_watermarks
            SET last_sequence = ?, last_timestamp = ?, last_fingerprint = ?,
              revision = revision + 1
            WHERE organization_id = ? AND node_id = ? AND server_id = ? AND deployment_id = ? AND stream_epoch = ?
              AND last_sequence = ? AND last_timestamp <= ?`)
                .bind(
                  archive.batch.lastSequence,
                  archive.metadata.lastTimestamp,
                  archive.fingerprint,
                  principal.organizationId,
                  principal.nodeId,
                  archive.deployment.serverId,
                  archive.deployment.id,
                  archive.deployment.streamEpoch,
                  archive.batch.firstSequence - 1,
                  archive.metadata.lastTimestamp,
                ),
            ]

      const receiptStatement = bindings.database
        .prepare(`INSERT INTO telemetry_ingestion_receipts
      (organization_id, node_id, id, credential_id, credential_version, session_version,
       machine_identity_id, payload_fingerprint, health_sampled_at, health_summary_json,
       health_hour_bucket, server_id, deployment_id, log_first_sequence, log_last_sequence,
       log_last_timestamp, log_fingerprint, archive_id, archive_r2_key, archive_sha256,
       archive_entry_count, archive_uncompressed_bytes, archive_compressed_bytes,
       stream_epoch, operation_id, audit_event_id, accepted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          principal.organizationId,
          principal.nodeId,
          receiptId,
          principal.credentialId,
          principal.version,
          principal.sessionVersion,
          machineIdentityId,
          payloadFingerprint,
          payload.health.sampledAt,
          health.summaryJson,
          health.bucket,
          archive?.deployment.serverId ?? null,
          archive?.deployment.id ?? null,
          archive?.batch.firstSequence ?? null,
          archive?.batch.lastSequence ?? null,
          archive?.metadata.lastTimestamp ?? null,
          archive?.fingerprint ?? null,
          archive?.metadata.id ?? null,
          archive?.metadata.r2Key ?? null,
          archive?.metadata.sha256 ?? null,
          archive?.metadata.entryCount ?? null,
          archive?.metadata.uncompressedBytes ?? null,
          archive?.metadata.compressedBytes ?? null,
          archive?.deployment.streamEpoch ?? null,
          operationId,
          auditEventId,
          acceptedAt,
          acceptedAt,
        )

      const publicationStatement =
        archive === undefined
          ? []
          : [
              bindings.database
                .prepare(`INSERT INTO telemetry_live_publications
          (organization_id, receipt_id, node_id, server_id, archive_id, archive_r2_key,
           archive_sha256, first_sequence, last_sequence, stream_epoch, state, created_at, enqueued_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
                .bind(
                  principal.organizationId,
                  receiptId,
                  principal.nodeId,
                  archive.deployment.serverId,
                  archive.metadata.id,
                  archive.metadata.r2Key,
                  archive.metadata.sha256,
                  archive.batch.firstSequence,
                  archive.batch.lastSequence,
                  archive.deployment.streamEpoch,
                  acceptedAt,
                ),
            ]

      const archiveAcceptanceFence =
        archive === undefined || archiveUploadLease === undefined
          ? []
          : [
              bindings.database
                .prepare(`INSERT INTO telemetry_archive_upload_acceptance_fences
          (organization_id, receipt_id, archive_id, upload_lease_id, accepted_at)
          VALUES (?, ?, ?, ?, ?)`)
                .bind(
                  principal.organizationId,
                  receiptId,
                  archive.metadata.id,
                  archiveUploadLease.id,
                  acceptedAt,
                ),
            ]

      const statements = [
        bindings.database
          .prepare(`INSERT OR IGNORE INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES (?, ?, ?, ?, 'suspended', ?, ?)`)
          .bind(
            machineIdentityId,
            `gridora-machine:${machineDigest}`,
            `machine-${machineDigest.slice(0, 32)}@audit.invalid`,
            `Machine telemetry ${principal.nodeId}`.slice(0, 160),
            acceptedAt,
            acceptedAt,
          ),
        bindings.database
          .prepare(`INSERT OR IGNORE INTO machine_audit_identities
        (organization_id, node_id, credential_id, credential_version, identity_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(
            principal.organizationId,
            principal.nodeId,
            principal.credentialId,
            principal.version,
            machineIdentityId,
            acceptedAt,
          ),
        // The v1 envelope's machine actor is explicitly bound to the compact
        // operation/audit identity before either record can be staged. This is
        // immutable evidence, not a credential lookup at audit-read time.
        bindings.database
          .prepare(`INSERT OR IGNORE INTO audit_actor_bindings
        (scope, scope_key, organization_id, actor_type, actor_id, operation_actor_id, created_at)
        VALUES ('tenant', ?, ?, 'machine', ?, ?, ?)`)
          .bind(
            principal.organizationId,
            principal.organizationId,
            machineIdentityId,
            machineIdentityId,
            acceptedAt,
          ),
        bindings.database
          .prepare(`INSERT OR IGNORE INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
        VALUES (?, ?, 'agent.telemetry', 'node', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
          .bind(
            operationId,
            principal.organizationId,
            principal.nodeId,
            machineIdentityId,
            `telemetry:${receiptId}`,
            correlationId,
            acceptedAt,
            acceptedAt,
          ),
        ...archiveStatements,
        ...health.statements,
        ...serverHealthStatements,
        ...archiveAcceptanceFence,
        receiptStatement,
        bindings.database
          .prepare(`INSERT INTO telemetry_payload_adoptions
        (organization_id, node_id, payload_fingerprint, receipt_id, created_at)
        VALUES (?, ?, ?, ?, ?)`)
          .bind(
            principal.organizationId,
            principal.nodeId,
            payloadFingerprint,
            receiptId,
            acceptedAt,
          ),
        ...publicationStatement,
        bindings.database
          .prepare(auditEnvelopeStageSql)
          .bind(...auditEnvelopeStageBindings(staged)),
        bindings.database
          .prepare(`INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, result,
         correlation_id, summary_json, created_at)
        VALUES (?, ?, ?, 'agent.telemetry.accepted', 'node', ?, 'succeeded', ?, ?, ?)`)
          .bind(
            auditEventId,
            principal.organizationId,
            machineIdentityId,
            principal.nodeId,
            correlationId,
            JSON.stringify(auditAfterSummary),
            acceptedAt,
          ),
      ]

      const persisted = yield* Effect.result(
        Effect.tryPromise({
          try: () => bindings.database.batch(statements),
          catch: () => persistence('telemetry.commit', 'Telemetry evidence could not be committed'),
        }),
      )
      if (Result.isFailure(persisted)) {
        const raced = yield* findReceipt(bindings.database, principal, payloadFingerprint)
        if (raced !== null) {
          yield* enqueuePendingPublication(bindings, principal.organizationId, raced.id)
          return receiptResponse(raced, true)
        }
        // R2 has settled, but no exact receipt was observed after the final
        // D1 response failed. Record termination before returning: the queue
        // may then prove/delete this one immutable key, while a lost terminal
        // response is adopted by `terminateArchiveUploadWriter` itself.
        if (archive !== undefined && archiveUploadLease !== undefined)
          yield* terminateArchiveUploadWriter(
            bindings,
            principal.organizationId,
            archive.metadata.id,
            archiveUploadLease,
          )
        return yield* new ConflictError({
          code: 'telemetry_evidence_conflict',
          message:
            'Telemetry was stale, replayed with different evidence, or lost its deployment scope',
        })
      }
      const committed = yield* findReceipt(bindings.database, principal, payloadFingerprint)
      if (committed === null) {
        if (archive !== undefined && archiveUploadLease !== undefined)
          yield* terminateArchiveUploadWriter(
            bindings,
            principal.organizationId,
            archive.metadata.id,
            archiveUploadLease,
          )
        return yield* new PersistenceError({
          operation: 'telemetry.receipt.commit',
          message: 'Telemetry receipt was not committed',
        })
      }
      yield* enqueuePendingPublication(bindings, principal.organizationId, committed.id)
      return receiptResponse(committed, false)
    }),
})

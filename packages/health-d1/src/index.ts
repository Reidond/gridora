import { Effect, Layer } from 'effect'
import { HealthPersistenceError, HealthRepository, HEALTH_LIMITS } from '@gridora/health-control'
import type {
  HealthAlert,
  HealthSnapshot,
  HealthStatus,
  HealthResourceType,
  HealthRepositoryShape,
} from '@gridora/health-control'

export interface HealthD1Result {
  readonly success?: boolean
  readonly meta?: { readonly changes?: number }
}
export interface HealthD1AllResult {
  readonly results: ReadonlyArray<unknown>
}
export interface HealthD1Statement {
  bind(...values: ReadonlyArray<unknown>): HealthD1Statement
  first(): Promise<unknown>
  all(): Promise<HealthD1AllResult>
  run(): Promise<HealthD1Result>
}
export interface HealthD1Database {
  prepare(sql: string): HealthD1Statement
}

const persistence = (operation: string, cause: unknown) =>
  new HealthPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const nullableText = (row: Record<string, unknown>, key: string): string | null | undefined =>
  row[key] === null ? null : text(row, key)
const safeTimestamp = (value: string): boolean =>
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value

const snapshotSelect = `SELECT organization_id AS organizationId, resource_type AS resourceType,
  resource_id AS resourceId, node_id AS nodeId, server_id AS serverId, status,
  summary_json AS summaryJson, sampled_at AS sampledAt
FROM health_hourly_snapshots`
const currentSnapshotSelect = `SELECT organization_id AS organizationId, resource_type AS resourceType,
  resource_id AS resourceId, node_id AS nodeId, server_id AS serverId, status,
  summary_json AS summaryJson, sampled_at AS sampledAt
FROM health_current_snapshots`
const alertSelect = `SELECT organization_id AS organizationId, id, resource_type AS resourceType,
  resource_id AS resourceId, node_id AS nodeId, server_id AS serverId, type, severity,
  message, fingerprint, state, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
  resolved_at AS resolvedAt FROM health_alerts`

const decodeSnapshot = (value: unknown): HealthSnapshot | undefined => {
  const row = object(value)
  if (row === undefined) return undefined
  const organizationId = text(row, 'organizationId')
  const resourceType = text(row, 'resourceType') as HealthResourceType | undefined
  const resourceId = text(row, 'resourceId')
  const nodeId = text(row, 'nodeId')
  const serverId = nullableText(row, 'serverId')
  const status = text(row, 'status') as HealthStatus | undefined
  const sampledAt = text(row, 'sampledAt')
  if (
    organizationId === undefined ||
    resourceType === undefined ||
    !['node', 'server', 'container'].includes(resourceType) ||
    resourceId === undefined ||
    nodeId === undefined ||
    serverId === undefined ||
    status === undefined ||
    !['healthy', 'degraded', 'unhealthy', 'unknown'].includes(status) ||
    sampledAt === undefined ||
    typeof row.summaryJson !== 'string'
  )
    return undefined
  let summary: unknown
  try {
    summary = JSON.parse(row.summaryJson)
  } catch {
    return undefined
  }
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return undefined
  return {
    organizationId,
    resourceType,
    resourceId,
    nodeId,
    serverId,
    sampledAt,
    status,
    summary: summary as HealthSnapshot['summary'],
  }
}

const decodeAlert = (value: unknown): HealthAlert | undefined => {
  const row = object(value)
  if (row === undefined) return undefined
  const organizationId = text(row, 'organizationId')
  const id = text(row, 'id')
  const resourceType = text(row, 'resourceType')
  const resourceId = text(row, 'resourceId')
  const nodeId = text(row, 'nodeId')
  const serverId = nullableText(row, 'serverId')
  const type = text(row, 'type')
  const severity = text(row, 'severity')
  const message = text(row, 'message')
  const fingerprint = text(row, 'fingerprint')
  const state = text(row, 'state')
  const firstSeenAt = text(row, 'firstSeenAt')
  const lastSeenAt = text(row, 'lastSeenAt')
  const resolvedAt = nullableText(row, 'resolvedAt')
  if (
    organizationId === undefined ||
    id === undefined ||
    resourceType === undefined ||
    !['node', 'server', 'container'].includes(resourceType) ||
    resourceId === undefined ||
    nodeId === undefined ||
    serverId === undefined ||
    type === undefined ||
    severity === undefined ||
    !['info', 'warning', 'critical'].includes(severity) ||
    message === undefined ||
    fingerprint === undefined ||
    state === undefined ||
    !['open', 'acknowledged', 'resolved'].includes(state) ||
    firstSeenAt === undefined ||
    lastSeenAt === undefined ||
    resolvedAt === undefined
  )
    return undefined
  return {
    organizationId,
    id,
    resourceType: resourceType as HealthResourceType,
    resourceId,
    nodeId,
    serverId,
    type,
    severity: severity as HealthAlert['severity'],
    message,
    fingerprint,
    state: state as HealthAlert['state'],
    firstSeenAt,
    lastSeenAt,
    resolvedAt,
  }
}

const hourlyBucket = (sampledAt: string): string => {
  const value = Date.parse(sampledAt)
  if (!Number.isFinite(value)) throw new Error('invalid health timestamp')
  return new Date(Math.floor(value / 3_600_000) * 3_600_000).toISOString()
}

const currentScope = (snapshot: HealthSnapshot): ReadonlyArray<unknown> => [
  snapshot.organizationId,
  snapshot.resourceType,
  snapshot.resourceId,
  snapshot.nodeId,
  snapshot.serverId,
  snapshot.status,
  JSON.stringify(snapshot.summary),
  snapshot.sampledAt,
]

const settleSnapshotWrite = (
  database: HealthD1Database,
  operation: 'health.current' | 'health.hourly',
  snapshot: HealthSnapshot,
  summaryJson: string,
  bucket?: string,
): Effect.Effect<void, HealthPersistenceError> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT node_id AS nodeId, server_id AS serverId,
      status, summary_json AS summaryJson, sampled_at AS sampledAt
      FROM ${operation === 'health.current' ? 'health_current_snapshots' : 'health_hourly_snapshots'}
      WHERE organization_id = ? AND resource_type = ? AND resource_id = ?${bucket === undefined ? '' : ' AND bucket_start = ?'}`)
        .bind(
          snapshot.organizationId,
          snapshot.resourceType,
          snapshot.resourceId,
          ...(bucket === undefined ? [] : [bucket]),
        )
        .first(),
    catch: (cause) => persistence(`${operation}.settle`, cause),
  }).pipe(
    Effect.flatMap((value) => {
      const row = object(value)
      if (
        row === undefined ||
        typeof row.sampledAt !== 'string' ||
        typeof row.status !== 'string' ||
        typeof row.summaryJson !== 'string' ||
        typeof row.nodeId !== 'string' ||
        (row.serverId !== null && typeof row.serverId !== 'string')
      )
        return Effect.fail(
          persistence(
            `${operation}.settle`,
            'The authoritative health sample is missing or invalid',
          ),
        )
      if (row.sampledAt > snapshot.sampledAt) return Effect.void
      if (
        row.sampledAt === snapshot.sampledAt &&
        row.status === snapshot.status &&
        row.summaryJson === summaryJson &&
        row.nodeId === snapshot.nodeId &&
        row.serverId === snapshot.serverId
      )
        return Effect.void
      if (row.sampledAt === snapshot.sampledAt)
        return Effect.fail(
          persistence(`${operation}.conflict`, 'Equal-time health samples disagree'),
        )
      return Effect.fail(
        persistence(`${operation}.settle`, 'The authoritative health sample did not advance'),
      )
    }),
  )

export const makeHealthRepositoryD1 = (database: HealthD1Database): HealthRepositoryShape => ({
  getCurrent: (input) =>
    Effect.tryPromise({
      try: () =>
        database
          .prepare(`${currentSnapshotSelect}
        WHERE organization_id = ? AND resource_type = ? AND resource_id = ?`)
          .bind(input.organizationId, input.resourceType, input.resourceId)
          .first(),
      catch: (cause) => persistence('health.current.read', cause),
    }).pipe(
      Effect.flatMap((value) => {
        if (value === null) return Effect.succeed(null)
        const snapshot = decodeSnapshot(value)
        return snapshot === undefined
          ? Effect.fail(
              persistence('health.current.decode', 'Stored current health aggregate is invalid'),
            )
          : Effect.succeed(snapshot)
      }),
    ),
  upsertCurrent: (snapshot) =>
    Effect.gen(function* () {
      const summaryJson = JSON.stringify(snapshot.summary)
      if (new TextEncoder().encode(summaryJson).byteLength > HEALTH_LIMITS.maximumSummaryBytes)
        return yield* persistence(
          'health.current.upsert',
          'Health summary exceeds configured limits',
        )
      const result = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`INSERT INTO health_current_snapshots
        (organization_id, resource_type, resource_id, node_id, server_id, status, summary_json, sampled_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (organization_id, resource_type, resource_id) DO UPDATE SET
          node_id = excluded.node_id, server_id = excluded.server_id, status = excluded.status,
          summary_json = excluded.summary_json, sampled_at = excluded.sampled_at,
          revision = health_current_snapshots.revision + 1
        WHERE health_current_snapshots.sampled_at < excluded.sampled_at`)
            .bind(...currentScope(snapshot))
            .run(),
        catch: (cause) => persistence('health.current.upsert', cause),
      })
      if ((result.meta?.changes ?? 0) === 0)
        yield* settleSnapshotWrite(database, 'health.current', snapshot, summaryJson)
    }),
  appendHourly: (snapshot) =>
    Effect.gen(function* () {
      const summaryJson = JSON.stringify(snapshot.summary)
      if (new TextEncoder().encode(summaryJson).byteLength > HEALTH_LIMITS.maximumSummaryBytes)
        return yield* persistence(
          'health.hourly.upsert',
          'Health summary exceeds configured limits',
        )
      const bucket = hourlyBucket(snapshot.sampledAt)
      const result = yield* Effect.tryPromise({
        try: () =>
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
            )
            .run(),
        catch: (cause) => persistence('health.hourly.upsert', cause),
      })
      if ((result.meta?.changes ?? 0) === 0)
        yield* settleSnapshotWrite(database, 'health.hourly', snapshot, summaryJson, bucket)
    }),
  listHistory: (input) =>
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > HEALTH_LIMITS.maximumHistoryPageSize
      )
        return yield* persistence('health.history.list', 'History page size is invalid')
      if (
        (input.from !== undefined && !safeTimestamp(input.from)) ||
        (input.to !== undefined && !safeTimestamp(input.to)) ||
        (input.before !== undefined && !safeTimestamp(input.before)) ||
        (input.from !== undefined &&
          input.to !== undefined &&
          (input.to < input.from ||
            Date.parse(input.to) - Date.parse(input.from) >
              HEALTH_LIMITS.maximumHistoryRangeMilliseconds))
      )
        return yield* persistence('health.history.list', 'History time range is invalid')
      const predicates = ['organization_id = ?', 'resource_type = ?', 'resource_id = ?']
      const values: unknown[] = [input.organizationId, input.resourceType, input.resourceId]
      if (input.from !== undefined) {
        predicates.push('sampled_at >= ?')
        values.push(input.from)
      }
      if (input.to !== undefined) {
        predicates.push('sampled_at <= ?')
        values.push(input.to)
      }
      if (input.before !== undefined) {
        predicates.push('sampled_at < ?')
        values.push(input.before)
      }
      values.push(input.limit)
      const result = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(
              `${snapshotSelect} WHERE ${predicates.join(' AND ')} ORDER BY sampled_at DESC LIMIT ?`,
            )
            .bind(...values)
            .all(),
        catch: (cause) => persistence('health.history.list', cause),
      })
      const snapshots: HealthSnapshot[] = []
      for (const row of result.results) {
        const snapshot = decodeSnapshot(row)
        if (snapshot === undefined)
          return yield* persistence('health.history.decode', 'Stored health aggregate is invalid')
        snapshots.push(snapshot)
      }
      return snapshots
    }),
  upsertAlert: (alert) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
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
            )
            .run(),
        catch: (cause) => persistence('health.alert.upsert', cause),
      })
      const row = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`${alertSelect} WHERE organization_id = ? AND fingerprint = ?`)
            .bind(alert.organizationId, alert.fingerprint)
            .first(),
        catch: (cause) => persistence('health.alert.read', cause),
      })
      const decoded = decodeAlert(row)
      if (decoded === undefined)
        return yield* persistence('health.alert.decode', 'Stored health alert is invalid')
      if ((result.meta?.changes ?? 0) === 0 && decoded.organizationId !== alert.organizationId)
        return yield* persistence('health.alert.scope', 'Stored health alert scope mismatch')
      return decoded
    }),
  resolveMissingAlerts: (organizationId, resourceType, resourceId, seenFingerprints, resolvedAt) =>
    Effect.tryPromise({
      try: () => {
        const placeholders = seenFingerprints.map(() => '?').join(', ')
        const values: unknown[] = [resolvedAt, organizationId, resourceType, resourceId]
        if (seenFingerprints.length > 0) values.push(...seenFingerprints)
        return database
          .prepare(`UPDATE health_alerts SET state = 'resolved', resolved_at = ?
          WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
            AND state <> 'resolved' ${seenFingerprints.length > 0 ? `AND fingerprint NOT IN (${placeholders})` : ''}`)
          .bind(...values)
          .run()
      },
      catch: (cause) => persistence('health.alert.resolve', cause),
    }).pipe(Effect.map((result) => result.meta?.changes ?? 0)),
  listAlerts: (input) =>
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > HEALTH_LIMITS.maximumHistoryPageSize
      )
        return yield* persistence('health.alert.list', 'Alert page size is invalid')
      const predicates = ['organization_id = ?']
      const values: unknown[] = [input.organizationId]
      if (input.resourceType !== undefined) {
        predicates.push('resource_type = ?')
        values.push(input.resourceType)
      }
      if (input.resourceId !== undefined) {
        predicates.push('resource_id = ?')
        values.push(input.resourceId)
      }
      values.push(input.limit)
      const result = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(
              `${alertSelect} WHERE ${predicates.join(' AND ')} ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
            )
            .bind(...values)
            .all(),
        catch: (cause) => persistence('health.alert.list', cause),
      })
      const alerts: HealthAlert[] = []
      for (const row of result.results) {
        const alert = decodeAlert(row)
        if (alert === undefined)
          return yield* persistence('health.alert.list.decode', 'Stored health alert is invalid')
        alerts.push(alert)
      }
      return alerts
    }),
})

export const HealthRepositoryD1Live = (database: HealthD1Database) =>
  Layer.succeed(HealthRepository, makeHealthRepositoryD1(database))

import { Effect, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  fingerprintOrphanSymmetry,
  OrphanSymmetryAuthorityResource,
  OrphanSymmetryError,
  OrphanSymmetryPlan,
  type OrphanSymmetryRepositoryShape,
  type OrphanSymmetryRequest,
  OrphanSymmetryResult,
  OrphanSymmetryRepository,
} from '@gridora/orphan-control'
import type { OrphanD1Database, OrphanD1Statement } from './index.js'

export interface OrphanSymmetryD1Options {
  readonly now: () => string
}

export interface OrphanSymmetryEvidenceCursor {
  readonly kind: string
  readonly resourceKey: string
  readonly reason: string
}

export interface OrphanSymmetryEvidenceItem {
  readonly kind: string
  readonly resourceKey: string
  readonly reason: string
  readonly resourceId: string
  readonly nodeId: string | null
  readonly severity: 'high'
  readonly expectedFingerprint: string | null
  readonly observedFingerprint: string | null
  readonly recommendation: string
  readonly firstDetectedAt: string
  readonly lastDetectedAt: string
  readonly revision: number
}

export interface OrphanSymmetryEvidencePage {
  readonly items: ReadonlyArray<OrphanSymmetryEvidenceItem>
  readonly nextCursor: OrphanSymmetryEvidenceCursor | null
}

export interface OrphanSymmetryObservedPage {
  readonly resources: ReadonlyArray<
    import('@gridora/orphan-control').OrphanSymmetryObservedResource
  >
  readonly nextCursor: string | null
}

export interface OrphanSymmetryDnsAuthority {
  readonly serverId: string
  readonly hostname: string
  readonly target: string
  readonly providerRecordId: string
  readonly recordType: 'A' | 'AAAA'
  readonly zoneId: string
}

export interface OrphanSymmetryTunnelAuthority {
  readonly nodeId: string
  readonly tunnelId: string
  readonly hostname: string
}

const defaults: OrphanSymmetryD1Options = { now: () => new Date().toISOString() }
const failure = (
  operation: string,
  code: (typeof OrphanSymmetryError.Type)['code'] = 'persistence-failed',
) => new OrphanSymmetryError({ operation, code, message: 'orphan symmetry reconciliation failed' })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const text = (row: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof row[key] === 'string' ? (row[key] as string) : undefined
const nullableText = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined => (row[key] === null ? null : text(row, key))

const scopeSelect = `SELECT organization.id
 FROM organizations organization
 JOIN identities actor ON actor.id = ? AND actor.status = 'active'
 JOIN organization_memberships membership
   ON membership.organization_id = organization.id
  AND membership.identity_id = actor.id
  AND membership.status = 'active'
 WHERE organization.id = ? AND organization.status IN ('active', 'deleting')`

const authoritativeSelect = `
 SELECT deployment.organization_id AS organizationId,
   'deployment-container' AS kind,
   deployment.node_id || ':' || deployment.server_id AS resourceKey,
   deployment.id AS resourceId, deployment.node_id AS nodeId,
   json_object('deploymentId', deployment.id, 'serverId', deployment.server_id,
     'nodeId', deployment.node_id, 'desiredRevision', deployment.desired_revision) AS fingerprintSource,
   'expected' AS state
 FROM deployments deployment
 JOIN game_servers server
   ON server.organization_id = deployment.organization_id AND server.id = deployment.server_id
 WHERE deployment.organization_id = ?
   AND server.desired_state <> 'deleted' AND deployment.observed_state <> 'deleted'
 UNION ALL
 SELECT lease.organization_id, 'port-lease',
   lease.node_id || ':' || lease.protocol || ':' || CAST(lease.public_port AS TEXT),
   lease.id, lease.node_id,
   json_object('leaseId', lease.id, 'serverId', lease.server_id, 'nodeId', lease.node_id,
     'protocol', lease.protocol, 'publicPort', lease.public_port,
     'containerPort', lease.container_port, 'operationId', lease.operation_id,
     'revision', lease.revision),
   'expected'
 FROM port_leases lease
 WHERE lease.organization_id = ? AND lease.state <> 'released'
 UNION ALL
 SELECT record.organization_id, 'dns-record', record.hostname, record.id, NULL,
   json_object('hostname', record.hostname, 'target', record.target,
     'providerRecordId', record.provider_record_id),
   CASE
     WHEN record.provider_record_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM game_dns_lifecycle_receipts receipt
       WHERE receipt.organization_id = record.organization_id
         AND receipt.server_id = record.server_id
         AND receipt.hostname = record.hostname
         AND receipt.action = 'publish' AND receipt.state = 'active'
     ) THEN 'receipt-missing'
     WHEN NOT EXISTS (
       SELECT 1 FROM game_dns_lifecycle_receipts receipt
       WHERE receipt.organization_id = record.organization_id
         AND receipt.server_id = record.server_id
         AND receipt.hostname = record.hostname
         AND receipt.action = 'publish' AND receipt.state = 'active'
         AND receipt.target = record.target
         AND receipt.provider_record_id = record.provider_record_id
     ) THEN 'receipt-stale'
     ELSE 'expected'
   END
 FROM dns_records record
 WHERE record.organization_id = ? AND record.state = 'active'
 UNION ALL
 SELECT node.organization_id, 'tunnel-authority', node.id,
   COALESCE(tunnel.tunnel_id, node.id), node.id,
   json_object('nodeId', node.id, 'tunnelId', tunnel.tunnel_id,
     'hostname', tunnel.hostname),
   CASE WHEN tunnel.tunnel_id IS NULL OR tunnel.state NOT IN ('connected', 'pending')
     THEN 'authority-stale' ELSE 'expected' END
 FROM nodes node
 LEFT JOIN tunnels tunnel
   ON tunnel.organization_id = node.organization_id AND tunnel.node_id = node.id
 WHERE node.organization_id = ? AND node.desired_state <> 'deleted'
 UNION ALL
 SELECT backup.organization_id, 'backup-object', backup.r2_key, backup.id, NULL,
   json_object('r2Key', backup.r2_key),
   CASE WHEN backup.state IN ('available', 'expired', 'creating')
     THEN 'expected' ELSE 'authority-stale' END
 FROM backups backup
 WHERE backup.organization_id = ? AND backup.state <> 'deleted'
 ORDER BY kind, resourceKey
 LIMIT 501`

const replaySelect = `SELECT run_id AS runId, actor_id AS actorId,
 discovery_fingerprint AS discoveryFingerprint, result_json AS resultJson
 FROM orphan_symmetry_runs
 WHERE organization_id = ? AND idempotency_key = ?`

const findingSelect = `SELECT resource_kind AS kind, resource_key AS resourceKey,
 reason, resource_id AS resourceId, node_id AS nodeId, status,
 expected_fingerprint AS expectedFingerprint,
 observed_fingerprint AS observedFingerprint, recommendation, revision
 FROM orphan_symmetry_findings
 WHERE organization_id = ? AND status = 'open'
 ORDER BY resource_kind, resource_key, reason
 LIMIT 501`

const evidencePageSelect = `SELECT resource_kind AS kind, resource_key AS resourceKey,
 reason, resource_id AS resourceId, node_id AS nodeId, severity,
 expected_fingerprint AS expectedFingerprint,
 observed_fingerprint AS observedFingerprint, recommendation,
 first_detected_at AS firstDetectedAt, last_detected_at AS lastDetectedAt, revision
 FROM orphan_symmetry_findings
 WHERE organization_id = ? AND status = 'open'
   AND (resource_kind > ? OR (resource_kind = ? AND resource_key > ?)
     OR (resource_kind = ? AND resource_key = ? AND reason > ?))
 ORDER BY resource_kind, resource_key, reason
 LIMIT ?`

const agentObservationPageSelect = `
 SELECT snapshot.organization_id AS organizationId, 'deployment-container' AS kind,
   deployment.node_id || ':' || deployment.server_id AS resourceKey,
   json_extract(snapshot.summary_json, '$.containers[0].id') AS resourceId,
   deployment.node_id AS nodeId, snapshot.sampled_at AS observedAt,
   json_object('deploymentId', deployment.id, 'serverId', deployment.server_id,
     'nodeId', deployment.node_id, 'desiredRevision', deployment.desired_revision) AS fingerprintSource,
   'tenant' AS ownerScope
 FROM health_current_snapshots snapshot
 JOIN deployments deployment
   ON deployment.organization_id = snapshot.organization_id
  AND deployment.server_id = snapshot.server_id
  AND deployment.node_id = snapshot.node_id
 WHERE snapshot.organization_id = ? AND snapshot.resource_type = 'server'
   AND snapshot.server_id IS NOT NULL
   AND json_type(snapshot.summary_json, '$.containers') = 'array'
   AND json_array_length(snapshot.summary_json, '$.containers') = 1
   AND json_extract(snapshot.summary_json, '$.containers[0].id') IS NOT NULL
   AND deployment.observed_state <> 'deleted'
 UNION ALL
 SELECT aggregate.organization_id, 'port-lease',
   aggregate.node_id || ':' || observed.protocol || ':' || CAST(observed.publicPort AS TEXT),
   COALESCE(lease.id, 'observed-' || aggregate.node_id || '-' || observed.protocol || '-' || observed.publicPort),
   aggregate.node_id, aggregate.observed_at,
   CASE WHEN lease.id IS NULL
     THEN json_object('nodeId', aggregate.node_id, 'protocol', observed.protocol,
       'publicPort', observed.publicPort)
     ELSE json_object('leaseId', lease.id, 'serverId', lease.server_id,
       'nodeId', lease.node_id, 'protocol', lease.protocol,
       'publicPort', lease.public_port, 'containerPort', lease.container_port,
       'operationId', lease.operation_id, 'revision', lease.revision)
   END,
   CASE WHEN lease.id IS NULL THEN 'unmanaged' ELSE 'tenant' END
 FROM agent_observation_aggregates aggregate
 JOIN (
   SELECT source.organization_id, source.node_id, 'tcp' AS protocol,
     CAST(port.value AS INTEGER) AS publicPort
   FROM agent_observation_aggregates source, json_each(source.summary_json, '$.allowedTcpPorts') port
   WHERE source.fact_kind = 'firewall'
   UNION ALL
   SELECT source.organization_id, source.node_id, 'udp', CAST(port.value AS INTEGER)
   FROM agent_observation_aggregates source, json_each(source.summary_json, '$.allowedUdpPorts') port
   WHERE source.fact_kind = 'firewall'
 ) observed
   ON observed.organization_id = aggregate.organization_id AND observed.node_id = aggregate.node_id
 LEFT JOIN port_leases lease
   ON lease.organization_id = aggregate.organization_id AND lease.node_id = aggregate.node_id
  AND lease.protocol = observed.protocol AND lease.public_port = observed.publicPort
  AND lease.state <> 'released'
 WHERE aggregate.organization_id = ? AND aggregate.fact_kind = 'firewall'
 ORDER BY kind, resourceKey, resourceId
 LIMIT 101 OFFSET ?`

const dnsAuthoritySelect = `SELECT record.server_id AS serverId, record.hostname,
 record.target, record.provider_record_id AS providerRecordId,
 receipt.record_type AS recordType, receipt.zone_id AS zoneId
 FROM dns_records record
 JOIN game_dns_lifecycle_receipts receipt
   ON receipt.organization_id = record.organization_id
  AND receipt.server_id = record.server_id
  AND receipt.hostname = record.hostname
  AND receipt.target = record.target
  AND receipt.provider_record_id = record.provider_record_id
  AND receipt.action = 'publish' AND receipt.state = 'active'
 WHERE record.organization_id = ? AND record.state = 'active'
 ORDER BY record.hostname
 LIMIT 101`

const tunnelAuthoritySelect = `SELECT node_id AS nodeId, tunnel_id AS tunnelId, hostname
 FROM tunnels
 WHERE organization_id = ? AND state <> 'deleted'
 ORDER BY node_id
 LIMIT 101`

const assertScope = (database: OrphanD1Database, request: OrphanSymmetryRequest) =>
  attempt('orphan.symmetry.scope', () =>
    database.prepare(scopeSelect).bind(request.actorId, request.organizationId).first(),
  ).pipe(
    Effect.flatMap((value) =>
      value === null ? Effect.fail(failure('orphan.symmetry.scope', 'invalid-scope')) : Effect.void,
    ),
  )

const decodeReplay = (
  value: unknown,
  request: OrphanSymmetryRequest,
): Effect.Effect<OrphanSymmetryResult, OrphanSymmetryError> =>
  Effect.gen(function* () {
    const row = record(value)
    if (
      row === undefined ||
      text(row, 'runId') !== request.runId ||
      text(row, 'actorId') !== request.actorId
    )
      return yield* failure('orphan.symmetry.replay.conflict', 'idempotency-conflict')
    const resultJson = text(row, 'resultJson')
    if (resultJson === undefined) return yield* failure('orphan.symmetry.replay.decode')
    const result = yield* Schema.decodeUnknownEffect(OrphanSymmetryResult, {
      onExcessProperty: 'error',
    })(JSON.parse(resultJson)).pipe(Effect.mapError(() => failure('orphan.symmetry.replay.decode')))
    if (
      result.organizationId !== request.organizationId ||
      result.runId !== request.runId ||
      result.discoveryFingerprint !== text(row, 'discoveryFingerprint')
    )
      return yield* failure('orphan.symmetry.replay.scope', 'idempotency-conflict')
    return { ...result, replayed: true }
  }).pipe(
    Effect.catch((error) =>
      error instanceof OrphanSymmetryError
        ? Effect.fail(error)
        : Effect.fail(failure('orphan.symmetry.replay.json')),
    ),
  )

export const loadOrphanSymmetryAuthority = (
  database: OrphanD1Database,
  request: OrphanSymmetryRequest,
): Effect.Effect<ReadonlyArray<OrphanSymmetryAuthorityResource>, OrphanSymmetryError> =>
  Effect.gen(function* () {
    yield* assertScope(database, request)
    const rows = yield* attempt('orphan.symmetry.authority', () =>
      database
        .prepare(authoritativeSelect)
        .bind(
          request.organizationId,
          request.organizationId,
          request.organizationId,
          request.organizationId,
          request.organizationId,
        )
        .all(),
    )
    if (rows.results.length > 500)
      return yield* failure('orphan.symmetry.authority.bound', 'unbounded-discovery')
    const resources: Array<OrphanSymmetryAuthorityResource> = []
    for (const value of rows.results) {
      const row = record(value)
      const sourceJson = row === undefined ? undefined : text(row, 'fingerprintSource')
      if (row === undefined || sourceJson === undefined)
        return yield* failure('orphan.symmetry.authority.decode')
      const fingerprint = yield* fingerprintOrphanSymmetry(JSON.parse(sourceJson)).pipe(
        Effect.mapError(() => failure('orphan.symmetry.authority.fingerprint')),
      )
      const resource = yield* Schema.decodeUnknownEffect(OrphanSymmetryAuthorityResource, {
        onExcessProperty: 'error',
      })({
        organizationId: text(row, 'organizationId'),
        kind: text(row, 'kind'),
        resourceKey: text(row, 'resourceKey'),
        resourceId: text(row, 'resourceId'),
        nodeId: nullableText(row, 'nodeId'),
        fingerprint,
        state: text(row, 'state'),
      }).pipe(Effect.mapError(() => failure('orphan.symmetry.authority.decode')))
      resources.push(resource)
    }
    return resources
  }).pipe(
    Effect.catch((error) =>
      error instanceof OrphanSymmetryError
        ? Effect.fail(error)
        : Effect.fail(failure('orphan.symmetry.authority.json')),
    ),
  )

interface ExistingFinding {
  readonly kind: string
  readonly resourceKey: string
  readonly reason: string
  readonly resourceId: string
  readonly nodeId: string | null
  readonly status: 'open'
  readonly expectedFingerprint: string | null
  readonly observedFingerprint: string | null
  readonly recommendation: string
  readonly revision: number
}

const decodeExisting = (value: unknown): ExistingFinding | undefined => {
  const row = record(value)
  if (row === undefined || row.status !== 'open' || typeof row.revision !== 'number')
    return undefined
  const kind = text(row, 'kind')
  const resourceKey = text(row, 'resourceKey')
  const reason = text(row, 'reason')
  const resourceId = text(row, 'resourceId')
  const nodeId = nullableText(row, 'nodeId')
  const expectedFingerprint = nullableText(row, 'expectedFingerprint')
  const observedFingerprint = nullableText(row, 'observedFingerprint')
  const recommendation = text(row, 'recommendation')
  if (
    kind === undefined ||
    resourceKey === undefined ||
    reason === undefined ||
    resourceId === undefined ||
    nodeId === undefined ||
    expectedFingerprint === undefined ||
    observedFingerprint === undefined ||
    recommendation === undefined ||
    !Number.isSafeInteger(row.revision)
  )
    return undefined
  return {
    kind,
    resourceKey,
    reason,
    resourceId,
    nodeId,
    status: 'open',
    expectedFingerprint,
    observedFingerprint,
    recommendation,
    revision: row.revision,
  }
}

/** Tenant-scoped, bounded, secret-free evidence for an operator/API projection. */
export const listOpenOrphanSymmetryEvidence = (
  database: OrphanD1Database,
  input: {
    readonly organizationId: string
    readonly actorId: string
    readonly cursor?: OrphanSymmetryEvidenceCursor
    readonly limit?: number
  },
): Effect.Effect<OrphanSymmetryEvidencePage, OrphanSymmetryError> =>
  Effect.gen(function* () {
    const request: OrphanSymmetryRequest = {
      organizationId: input.organizationId,
      actorId: input.actorId,
      runId: 'orphan-symmetry-evidence-read',
      idempotencyKey: 'orphan-symmetry-evidence-read',
    }
    yield* assertScope(database, request)
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return yield* failure('orphan.symmetry.evidence.limit', 'unbounded-discovery')
    const cursor = input.cursor ?? { kind: '', resourceKey: '', reason: '' }
    const rows = yield* attempt('orphan.symmetry.evidence.list', () =>
      database
        .prepare(evidencePageSelect)
        .bind(
          input.organizationId,
          cursor.kind,
          cursor.kind,
          cursor.resourceKey,
          cursor.kind,
          cursor.resourceKey,
          cursor.reason,
          limit + 1,
        )
        .all(),
    )
    const decoded: Array<OrphanSymmetryEvidenceItem> = []
    for (const value of rows.results.slice(0, limit)) {
      const row = record(value)
      const nodeId = row === undefined ? undefined : nullableText(row, 'nodeId')
      const expectedFingerprint =
        row === undefined ? undefined : nullableText(row, 'expectedFingerprint')
      const observedFingerprint =
        row === undefined ? undefined : nullableText(row, 'observedFingerprint')
      if (
        row === undefined ||
        nodeId === undefined ||
        expectedFingerprint === undefined ||
        observedFingerprint === undefined ||
        row.severity !== 'high' ||
        typeof row.revision !== 'number'
      )
        return yield* failure('orphan.symmetry.evidence.decode')
      const kind = text(row, 'kind')
      const resourceKey = text(row, 'resourceKey')
      const reason = text(row, 'reason')
      const resourceId = text(row, 'resourceId')
      const recommendation = text(row, 'recommendation')
      const firstDetectedAt = text(row, 'firstDetectedAt')
      const lastDetectedAt = text(row, 'lastDetectedAt')
      if (
        kind === undefined ||
        resourceKey === undefined ||
        reason === undefined ||
        resourceId === undefined ||
        recommendation === undefined ||
        firstDetectedAt === undefined ||
        lastDetectedAt === undefined ||
        !Number.isSafeInteger(row.revision)
      )
        return yield* failure('orphan.symmetry.evidence.decode')
      decoded.push({
        kind,
        resourceKey,
        reason,
        resourceId,
        nodeId,
        severity: 'high',
        expectedFingerprint,
        observedFingerprint,
        recommendation,
        firstDetectedAt,
        lastDetectedAt,
        revision: row.revision,
      })
    }
    const last = decoded.at(-1)
    return {
      items: decoded,
      nextCursor:
        rows.results.length > limit && last !== undefined
          ? { kind: last.kind, resourceKey: last.resourceKey, reason: last.reason }
          : null,
    }
  })

/** Production agent source: accepted D1 health plus authenticated firewall observations. */
export const loadOrphanSymmetryAgentObservationPage = (
  database: OrphanD1Database,
  request: OrphanSymmetryRequest,
  cursor: string | null,
): Effect.Effect<OrphanSymmetryObservedPage, OrphanSymmetryError> =>
  Effect.gen(function* () {
    yield* assertScope(database, request)
    const page = cursor === null ? 0 : Number(cursor.slice('agent-page-'.length))
    if (
      (cursor !== null && !/^agent-page-[1-4]$/.test(cursor)) ||
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page > 4
    )
      return yield* failure('orphan.symmetry.agent.cursor', 'ambiguous-discovery')
    const rows = yield* attempt('orphan.symmetry.agent.list', () =>
      database
        .prepare(agentObservationPageSelect)
        .bind(request.organizationId, request.organizationId, page * 100)
        .all(),
    )
    const resources: Array<import('@gridora/orphan-control').OrphanSymmetryObservedResource> = []
    for (const value of rows.results.slice(0, 100)) {
      const row = record(value)
      const source = row === undefined ? undefined : text(row, 'fingerprintSource')
      const rawObservedAt = row === undefined ? undefined : text(row, 'observedAt')
      const ownerScope = row === undefined ? undefined : text(row, 'ownerScope')
      const kind = row === undefined ? undefined : text(row, 'kind')
      const resourceKey = row === undefined ? undefined : text(row, 'resourceKey')
      const resourceId = row === undefined ? undefined : text(row, 'resourceId')
      const nodeId = row === undefined ? undefined : text(row, 'nodeId')
      if (
        source === undefined ||
        rawObservedAt === undefined ||
        (ownerScope !== 'tenant' && ownerScope !== 'unmanaged') ||
        (kind !== 'deployment-container' && kind !== 'port-lease') ||
        resourceKey === undefined ||
        resourceId === undefined ||
        nodeId === undefined
      )
        return yield* failure('orphan.symmetry.agent.decode')
      const observedAt = new Date(rawObservedAt).toISOString()
      resources.push({
        organizationId: request.organizationId,
        kind,
        resourceKey,
        resourceId,
        nodeId,
        fingerprint: yield* fingerprintOrphanSymmetry(JSON.parse(source)).pipe(
          Effect.mapError(() => failure('orphan.symmetry.agent.fingerprint')),
        ),
        ownerScope,
        observedAt,
      })
    }
    return {
      resources,
      nextCursor: rows.results.length > 100 ? `agent-page-${page + 1}` : null,
    }
  }).pipe(
    Effect.catch((error) =>
      error instanceof OrphanSymmetryError
        ? Effect.fail(error)
        : Effect.fail(failure('orphan.symmetry.agent.json')),
    ),
  )

export const loadOrphanSymmetryDnsAuthorities = (
  database: OrphanD1Database,
  request: OrphanSymmetryRequest,
): Effect.Effect<ReadonlyArray<OrphanSymmetryDnsAuthority>, OrphanSymmetryError> =>
  Effect.gen(function* () {
    yield* assertScope(database, request)
    const rows = yield* attempt('orphan.symmetry.dns.authority', () =>
      database.prepare(dnsAuthoritySelect).bind(request.organizationId).all(),
    )
    if (rows.results.length > 100)
      return yield* failure('orphan.symmetry.dns.authority.bound', 'unbounded-discovery')
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          serverId: Schema.String,
          hostname: Schema.String,
          target: Schema.String,
          providerRecordId: Schema.String,
          recordType: Schema.Literals(['A', 'AAAA']),
          zoneId: Schema.String,
        }),
      ),
      { onExcessProperty: 'error' },
    )(rows.results).pipe(Effect.mapError(() => failure('orphan.symmetry.dns.authority.decode')))
  })

export const loadOrphanSymmetryTunnelAuthorities = (
  database: OrphanD1Database,
  request: OrphanSymmetryRequest,
): Effect.Effect<ReadonlyArray<OrphanSymmetryTunnelAuthority>, OrphanSymmetryError> =>
  Effect.gen(function* () {
    yield* assertScope(database, request)
    const rows = yield* attempt('orphan.symmetry.tunnel.authority', () =>
      database.prepare(tunnelAuthoritySelect).bind(request.organizationId).all(),
    )
    if (rows.results.length > 100)
      return yield* failure('orphan.symmetry.tunnel.authority.bound', 'unbounded-discovery')
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({ nodeId: Schema.String, tunnelId: Schema.String, hostname: Schema.String }),
      ),
      { onExcessProperty: 'error' },
    )(rows.results).pipe(Effect.mapError(() => failure('orphan.symmetry.tunnel.authority.decode')))
  })

export const makeOrphanSymmetryD1Repository = (
  database: OrphanD1Database,
  overrides: Partial<OrphanSymmetryD1Options> = {},
): OrphanSymmetryRepositoryShape => {
  const options = { ...defaults, ...overrides }
  return OrphanSymmetryRepository.of({
    findReplay: (request) =>
      Effect.gen(function* () {
        yield* assertScope(database, request)
        const replay = yield* attempt('orphan.symmetry.replay', () =>
          database
            .prepare(replaySelect)
            .bind(request.organizationId, request.idempotencyKey)
            .first(),
        )
        return replay === null ? null : yield* decodeReplay(replay, request)
      }),
    authoritative: (request) => loadOrphanSymmetryAuthority(database, request),
    applyAtomic: (input) =>
      Effect.gen(function* () {
        const plan = yield* Schema.decodeUnknownEffect(OrphanSymmetryPlan, {
          onExcessProperty: 'error',
        })(input).pipe(
          Effect.mapError(() => failure('orphan.symmetry.plan', 'ambiguous-discovery')),
        )
        if (plan.findings.length > 500)
          return yield* failure('orphan.symmetry.plan.bound', 'unbounded-discovery')
        yield* assertScope(database, plan)
        const replay = yield* attempt('orphan.symmetry.replay.apply', () =>
          database.prepare(replaySelect).bind(plan.organizationId, plan.idempotencyKey).first(),
        )
        if (replay !== null) return yield* decodeReplay(replay, plan)

        const currentAuthority = yield* loadOrphanSymmetryAuthority(database, plan)
        const currentAuthorityFingerprint = yield* fingerprintOrphanSymmetry(currentAuthority).pipe(
          Effect.mapError(() => failure('orphan.symmetry.authority.recheck')),
        )
        if (currentAuthorityFingerprint !== plan.authorityFingerprint)
          return yield* failure('orphan.symmetry.authority.changed', 'stale-discovery')

        const rows = yield* attempt('orphan.symmetry.findings', () =>
          database.prepare(findingSelect).bind(plan.organizationId).all(),
        )
        if (rows.results.length > 500)
          return yield* failure('orphan.symmetry.findings.bound', 'unbounded-discovery')
        const existing = new Map<string, ExistingFinding>()
        for (const value of rows.results) {
          const decoded = decodeExisting(value)
          if (decoded === undefined) return yield* failure('orphan.symmetry.findings.decode')
          existing.set(
            `${decoded.kind}\u0000${decoded.resourceKey}\u0000${decoded.reason}`,
            decoded,
          )
        }

        const now = options.now()
        const statements: Array<OrphanD1Statement> = []
        const keys = new Set<string>()
        let opened = 0
        let updated = 0
        let resolved = 0
        let unchanged = 0
        for (const finding of plan.findings) {
          const key = `${finding.kind}\u0000${finding.resourceKey}\u0000${finding.reason}`
          if (keys.has(key))
            return yield* failure('orphan.symmetry.findings.duplicate', 'ambiguous-discovery')
          keys.add(key)
          const prior = existing.get(key)
          if (prior === undefined) opened += 1
          else if (
            prior.resourceId === finding.resourceId &&
            prior.nodeId === finding.nodeId &&
            prior.expectedFingerprint === finding.expectedFingerprint &&
            prior.observedFingerprint === finding.observedFingerprint &&
            prior.recommendation === finding.recommendation
          )
            unchanged += 1
          else updated += 1
        }
        for (const key of existing.keys()) if (!keys.has(key)) resolved += 1

        const result: OrphanSymmetryResult = {
          organizationId: plan.organizationId,
          runId: plan.runId,
          discoveryFingerprint: plan.discoveryFingerprint,
          opened,
          updated,
          resolved,
          unchanged,
          replayed: false,
        }
        const operationId = `orphan-symmetry-operation:${plan.runId}`
        const auditEventId = `orphan-symmetry-audit:${plan.runId}`
        const stage = yield* stageAuditEnvelope(
          'tenant',
          auditEventId,
          {
            version: 1,
            captureStatus: 'complete',
            occurredAt: now,
            scope: 'tenant',
            organizationId: plan.organizationId,
            actor: { type: 'system', id: plan.actorId },
            request: { id: plan.runId, correlationId: plan.runId },
            action: 'orphan.symmetry.reconciled',
            target: { type: 'organization', id: plan.organizationId },
            before: { state: 'absent', reason: 'scheduled-scan-has-no-prior-run-state' },
            after: {
              state: 'captured',
              summary: {
                severity: 'high',
                destructiveActions: 0,
                opened,
                updated,
                resolved,
                unchanged,
                findingCount: plan.findings.length,
                discoveryFingerprint: plan.discoveryFingerprint,
              },
            },
            operationId,
            source: {
              origin: 'scheduler',
              ip: { state: 'not-available', reason: 'scheduler-has-no-client-ip' },
              access: { state: 'not-available', reason: 'scheduler-has-no-access-session' },
            },
            result: 'succeeded',
            error: { classification: 'none', code: null },
            forced: false,
            breakGlass: false,
          },
          now,
        ).pipe(Effect.mapError(() => failure('orphan.symmetry.audit')))

        statements.push(
          database
            .prepare(`INSERT INTO operations
              (id, organization_id, type, resource_type, resource_id, actor_id, status,
               progress, idempotency_key, correlation_id, revision, created_at, updated_at)
              VALUES (?, ?, 'orphan.symmetry.reconciled', 'organization', ?, ?, 'succeeded',
                100, ?, ?, 1, ?, ?)`)
            .bind(
              operationId,
              plan.organizationId,
              plan.organizationId,
              plan.actorId,
              `orphan-symmetry-audit:${plan.idempotencyKey}`,
              plan.runId,
              now,
              now,
            ),
          database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
          database
            .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              VALUES (?, ?, ?, 'orphan.symmetry.reconciled', 'organization', ?, 'succeeded',
                ?, ?, ?)`)
            .bind(
              auditEventId,
              plan.organizationId,
              plan.actorId,
              plan.organizationId,
              plan.runId,
              JSON.stringify({
                severity: 'high',
                destructiveActions: 0,
                opened,
                updated,
                resolved,
                unchanged,
                findingCount: plan.findings.length,
                discoveryFingerprint: plan.discoveryFingerprint,
              }),
              now,
            ),
          database
            .prepare(`INSERT INTO orphan_symmetry_runs
              (organization_id, idempotency_key, run_id, actor_id, authority_fingerprint,
               discovery_fingerprint, discovery_observed_at, result_json, findings_json,
               operation_id, audit_event_id, completed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              plan.organizationId,
              plan.idempotencyKey,
              plan.runId,
              plan.actorId,
              plan.authorityFingerprint,
              plan.discoveryFingerprint,
              plan.observedAt,
              JSON.stringify(result),
              JSON.stringify(plan.findings),
              operationId,
              auditEventId,
              now,
            ),
        )

        for (const finding of plan.findings) {
          const key = `${finding.kind}\u0000${finding.resourceKey}\u0000${finding.reason}`
          const prior = existing.get(key)
          if (prior === undefined) {
            statements.push(
              database
                .prepare(`INSERT INTO orphan_symmetry_findings
                  (organization_id, resource_kind, resource_key, reason, resource_id,
                   node_id, severity, status, expected_fingerprint, observed_fingerprint,
                   recommendation, first_detected_at, last_detected_at, last_run_id,
                   resolved_at, revision)
                  VALUES (?, ?, ?, ?, ?, ?, 'high', 'open', ?, ?, ?, ?, ?, ?, NULL, 1)`)
                .bind(
                  plan.organizationId,
                  finding.kind,
                  finding.resourceKey,
                  finding.reason,
                  finding.resourceId,
                  finding.nodeId,
                  finding.expectedFingerprint,
                  finding.observedFingerprint,
                  finding.recommendation,
                  now,
                  now,
                  plan.runId,
                ),
            )
          } else {
            statements.push(
              database
                .prepare(`UPDATE orphan_symmetry_findings SET
                  resource_id = ?, node_id = ?, expected_fingerprint = ?,
                  observed_fingerprint = ?, recommendation = ?, last_detected_at = ?,
                  last_run_id = ?, revision = revision + 1
                  WHERE organization_id = ? AND resource_kind = ? AND resource_key = ?
                    AND reason = ? AND status = 'open' AND revision = ?`)
                .bind(
                  finding.resourceId,
                  finding.nodeId,
                  finding.expectedFingerprint,
                  finding.observedFingerprint,
                  finding.recommendation,
                  now,
                  plan.runId,
                  plan.organizationId,
                  finding.kind,
                  finding.resourceKey,
                  finding.reason,
                  prior.revision,
                ),
            )
          }
        }
        for (const [key, prior] of existing) {
          if (keys.has(key)) continue
          statements.push(
            database
              .prepare(`UPDATE orphan_symmetry_findings SET
                status = 'resolved', resolved_at = ?, last_run_id = ?, revision = revision + 1
                WHERE organization_id = ? AND resource_kind = ? AND resource_key = ?
                  AND reason = ? AND status = 'open' AND revision = ?`)
              .bind(
                now,
                plan.runId,
                plan.organizationId,
                prior.kind,
                prior.resourceKey,
                prior.reason,
                prior.revision,
              ),
          )
        }

        return yield* attempt('orphan.symmetry.apply', () => database.batch(statements)).pipe(
          Effect.as(result),
          Effect.catch(() =>
            attempt('orphan.symmetry.apply.adopt', () =>
              database.prepare(replaySelect).bind(plan.organizationId, plan.idempotencyKey).first(),
            ).pipe(
              Effect.flatMap((committed) =>
                committed === null
                  ? Effect.fail(failure('orphan.symmetry.apply'))
                  : decodeReplay(committed, plan),
              ),
            ),
          ),
        )
      }),
  })
}

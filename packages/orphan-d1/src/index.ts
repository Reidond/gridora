import { Context, Effect, Layer, Schema } from 'effect'
import {
  type AuditStateSummary,
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  type AuthoritativeManagedResource,
  OrphanControlError,
  OrphanReconciliationPlan,
  type OrphanReconciliationRequest,
  OrphanReconciliationResult,
  OrphanRepository,
  type OrphanRepositoryShape,
} from '@gridora/orphan-control'

export * from './symmetry.js'

export interface OrphanD1Result {
  readonly results: ReadonlyArray<unknown>
}

export interface OrphanD1Statement {
  bind(...values: ReadonlyArray<unknown>): OrphanD1Statement
  first(): Promise<unknown>
  all(): Promise<OrphanD1Result>
}

export interface OrphanD1Database {
  prepare(sql: string): OrphanD1Statement
  /** Cloudflare D1 commits all statements in a batch or rolls the whole batch back. */
  batch(statements: ReadonlyArray<OrphanD1Statement>): Promise<ReadonlyArray<unknown>>
}

export class OrphanD1Client extends Context.Service<OrphanD1Client, OrphanD1Database>()(
  '@gridora/orphan-d1/OrphanD1Client',
) {}
export const OrphanD1ClientLayer = (database: OrphanD1Database) =>
  Layer.succeed(OrphanD1Client, database)

export interface OrphanD1Options {
  readonly now: () => string
}

const defaultOptions: OrphanD1Options = { now: () => new Date().toISOString() }
const failure = (
  operation: string,
  code:
    | 'invalid-scope'
    | 'stale-discovery'
    | 'ambiguous-discovery'
    | 'unbounded-discovery'
    | 'persistence-failed'
    | 'idempotency-conflict',
) => new OrphanControlError({ operation, code, message: 'orphan reconciliation failed' })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => failure(operation, 'persistence-failed'),
  })
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const string = (row: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const nullableString = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined => (row[key] === null ? null : string(row, key))
const integer = (row: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] : undefined

const scopeSelect = `SELECT allocation.organization_id AS organizationId
 FROM provider_allocations AS allocation
 JOIN provider_accounts AS account ON account.id = allocation.provider_account_id
 JOIN organizations AS organization ON organization.id = allocation.organization_id
 JOIN identities AS identity ON identity.id = ?
 JOIN organization_memberships AS membership
   ON membership.organization_id = allocation.organization_id
  AND membership.identity_id = identity.id
 WHERE allocation.organization_id = ?
   AND allocation.provider_account_id = ?
   AND account.provider_type = ?
   AND allocation.status = 'active'
   AND account.status = 'active'
   AND organization.status = 'active'
   AND identity.status = 'active'
   AND membership.status = 'active'`

const exactCredentialScopeSelect = `SELECT allocation.organization_id AS organizationId
 FROM provider_allocations AS allocation
 JOIN provider_accounts AS account ON account.id = allocation.provider_account_id
 JOIN organizations AS organization ON organization.id = allocation.organization_id
 JOIN identities AS identity ON identity.id = ?
 JOIN organization_memberships AS membership
   ON membership.organization_id = allocation.organization_id
  AND membership.identity_id = identity.id
 WHERE allocation.organization_id = ?
   AND allocation.provider_account_id = ?
   AND account.provider_type = ?
   AND allocation.status = 'active'
   AND account.status = 'active'
   AND organization.status = 'active'
   AND identity.status = 'active'
   AND membership.status = 'active'
   AND (
     (account.scope = 'platform' AND account.organization_id IS NULL AND EXISTS (
       SELECT 1 FROM platform_secret_envelopes AS secret
       WHERE secret.id = account.credential_reference
         AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
         AND secret.revision = ? AND account.credential_reference = ?
     ))
     OR
     (account.scope = 'organization' AND account.organization_id = ? AND EXISTS (
       SELECT 1 FROM secret_envelopes AS secret
       WHERE secret.organization_id = allocation.organization_id
         AND secret.id = account.credential_reference
         AND secret.scope_type = 'provider-account' AND secret.scope_id = account.id
         AND secret.revision = ? AND account.credential_reference = ?
     ))
   )`

const authoritativeSelect = `SELECT node.organization_id AS organizationId,
 node.provider_account_id AS providerAccountId, node.provider_type AS providerType,
 'node' AS kind, node.provider_instance_id AS providerResourceId,
 node.id AS nodeId, operation.id AS operationId, image.version AS imageVersion
 FROM nodes AS node
 JOIN node_images AS image ON image.id = node.image_id
 LEFT JOIN node_provision_acceptances AS acceptance
   ON acceptance.organization_id = node.organization_id
  AND acceptance.node_id = node.id
  AND acceptance.provider_account_id = node.provider_account_id
  AND acceptance.provider_type = node.provider_type
 JOIN operations AS operation
   ON operation.organization_id = node.organization_id
  AND operation.resource_type = 'node'
  AND operation.resource_id = node.id
  AND operation.id = COALESCE(
    acceptance.operation_id,
    (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(candidate.id) END
     FROM (
       SELECT legacy.id
       FROM operations AS legacy
       WHERE legacy.organization_id = node.organization_id
         AND legacy.resource_type = 'node'
         AND legacy.resource_id = node.id
         AND legacy.type = 'node.provision'
         AND legacy.status = 'succeeded'
       ORDER BY legacy.id
       LIMIT 2
     ) AS candidate)
  )
 WHERE node.organization_id = ?
   AND node.provider_account_id = ?
   AND node.provider_type = ?
   AND node.provider_instance_id IS NOT NULL
 ORDER BY node.provider_instance_id, node.id, operation.id
 LIMIT 201`

const replaySelect = `SELECT run_id AS runId, provider_account_id AS providerAccountId,
 provider_type AS providerType, actor_id AS actorId,
 discovery_fingerprint AS discoveryFingerprint, result_json AS resultJson
 FROM orphan_reconciliation_runs
 WHERE organization_id = ? AND idempotency_key = ?`

const latestObservationSelect = `SELECT discovery_observed_at AS observedAt
 FROM orphan_reconciliation_runs
 WHERE organization_id = ? AND provider_account_id = ? AND provider_type = ?
 ORDER BY julianday(discovery_observed_at) DESC
 LIMIT 1`

const findingSelect = `SELECT organization_id AS organizationId,
 provider_account_id AS providerAccountId, provider_type AS providerType,
 resource_kind AS resourceKind, provider_resource_id AS providerResourceId,
 node_id AS nodeId, operation_id AS operationId, image_version AS imageVersion,
 severity, status, resolution_kind AS resolutionKind, revision
 FROM orphan_findings
 WHERE organization_id = ? AND provider_account_id = ?
   AND provider_resource_id IN (SELECT value FROM json_each(?))
 ORDER BY provider_resource_id`

const exactAuthorityExists = `EXISTS (
 SELECT 1 FROM nodes AS node
 JOIN node_images AS image ON image.id = node.image_id
 LEFT JOIN node_provision_acceptances AS acceptance
   ON acceptance.organization_id = node.organization_id
  AND acceptance.node_id = node.id
  AND acceptance.provider_account_id = node.provider_account_id
  AND acceptance.provider_type = node.provider_type
 JOIN operations AS operation
   ON operation.organization_id = node.organization_id
  AND operation.resource_type = 'node'
  AND operation.resource_id = node.id
  AND operation.id = COALESCE(
    acceptance.operation_id,
    (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(candidate.id) END
     FROM (
       SELECT legacy.id
       FROM operations AS legacy
       WHERE legacy.organization_id = node.organization_id
         AND legacy.resource_type = 'node'
         AND legacy.resource_id = node.id
         AND legacy.type = 'node.provision'
         AND legacy.status = 'succeeded'
       ORDER BY legacy.id
       LIMIT 2
     ) AS candidate)
  )
 WHERE node.organization_id = ?
   AND node.provider_account_id = ?
   AND node.provider_type = ?
   AND node.provider_instance_id = ?
   AND node.id = ?
   AND operation.id = ?
   AND image.version = ?
)`

interface FindingRow {
  readonly organizationId: string
  readonly providerAccountId: string
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly resourceKind: 'node'
  readonly providerResourceId: string
  readonly nodeId: string
  readonly operationId: string
  readonly imageVersion: string
  readonly severity: 'high'
  readonly status: 'open' | 'resolved'
  readonly resolutionKind: 'authoritative-adoption' | 'provider-removal' | null
  readonly revision: number
}

const decodeFinding = (value: unknown): Effect.Effect<FindingRow, OrphanControlError> => {
  const row = record(value)
  if (row === undefined) return Effect.fail(failure('orphan.finding.decode', 'persistence-failed'))
  const providerType = string(row, 'providerType')
  const resourceKind = string(row, 'resourceKind')
  const severity = string(row, 'severity')
  const status = string(row, 'status')
  const resolutionKind = nullableString(row, 'resolutionKind')
  const revision = integer(row, 'revision')
  const organizationId = string(row, 'organizationId')
  const providerAccountId = string(row, 'providerAccountId')
  const providerResourceId = string(row, 'providerResourceId')
  const nodeId = string(row, 'nodeId')
  const operationId = string(row, 'operationId')
  const imageVersion = string(row, 'imageVersion')
  if (
    (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
    resourceKind !== 'node' ||
    severity !== 'high' ||
    (status !== 'open' && status !== 'resolved') ||
    (resolutionKind !== null &&
      resolutionKind !== 'authoritative-adoption' &&
      resolutionKind !== 'provider-removal') ||
    revision === undefined ||
    revision < 1 ||
    organizationId === undefined ||
    providerAccountId === undefined ||
    providerResourceId === undefined ||
    nodeId === undefined ||
    operationId === undefined ||
    imageVersion === undefined
  )
    return Effect.fail(failure('orphan.finding.decode', 'persistence-failed'))
  return Effect.succeed({
    organizationId,
    providerAccountId,
    providerType,
    resourceKind,
    providerResourceId,
    nodeId,
    operationId,
    imageVersion,
    severity,
    status,
    resolutionKind,
    revision,
  })
}

const assertScope = (database: OrphanD1Database, request: OrphanReconciliationRequest) =>
  attempt('orphan.scope', () =>
    database
      .prepare(scopeSelect)
      .bind(
        request.actorId,
        request.organizationId,
        request.providerAccountId,
        request.providerType,
      )
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null ? Effect.fail(failure('orphan.scope', 'invalid-scope')) : Effect.void,
    ),
  )

const assertExactCredentialScope = (database: OrphanD1Database, plan: OrphanReconciliationPlan) =>
  attempt('orphan.scope.credential', () =>
    database
      .prepare(exactCredentialScopeSelect)
      .bind(
        plan.actorId,
        plan.organizationId,
        plan.providerAccountId,
        plan.providerType,
        plan.credentialRevision,
        plan.credentialReference,
        plan.organizationId,
        plan.credentialRevision,
        plan.credentialReference,
      )
      .first(),
  ).pipe(
    Effect.flatMap((row) =>
      row === null ? Effect.fail(failure('orphan.scope.credential', 'invalid-scope')) : Effect.void,
    ),
  )

const loadAuthoritative = (
  database: OrphanD1Database,
  request: OrphanReconciliationRequest,
): Effect.Effect<ReadonlyArray<AuthoritativeManagedResource>, OrphanControlError> =>
  Effect.gen(function* () {
    yield* assertScope(database, request)
    const rows = yield* attempt('orphan.authoritative', () =>
      database
        .prepare(authoritativeSelect)
        .bind(request.organizationId, request.providerAccountId, request.providerType)
        .all(),
    )
    if (rows.results.length > 200)
      return yield* failure('orphan.authoritative.bound', 'unbounded-discovery')
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          organizationId: Schema.String,
          providerAccountId: Schema.String,
          providerType: Schema.Literals(['ovhcloud', 'contabo']),
          kind: Schema.Literal('node'),
          providerResourceId: Schema.String,
          nodeId: Schema.String,
          operationId: Schema.String,
          imageVersion: Schema.String,
        }),
      ),
      { onExcessProperty: 'error' },
    )(rows.results).pipe(
      Effect.mapError(() => failure('orphan.authoritative.decode', 'persistence-failed')),
    )
  })

const decodeRequestReplay = (
  value: unknown,
  request: OrphanReconciliationRequest,
): Effect.Effect<OrphanReconciliationResult, OrphanControlError> =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* failure('orphan.replay.decode', 'persistence-failed')
    if (
      string(row, 'runId') !== request.runId ||
      string(row, 'providerAccountId') !== request.providerAccountId ||
      string(row, 'providerType') !== request.providerType ||
      string(row, 'actorId') !== request.actorId
    )
      return yield* failure('orphan.replay.binding', 'idempotency-conflict')
    const resultJson = string(row, 'resultJson')
    if (resultJson === undefined)
      return yield* failure('orphan.replay.decode', 'persistence-failed')
    const parsed = yield* Effect.try({
      try: () => JSON.parse(resultJson) as unknown,
      catch: () => failure('orphan.replay.decode', 'persistence-failed'),
    })
    const result = yield* Schema.decodeUnknownEffect(OrphanReconciliationResult, {
      onExcessProperty: 'error',
    })(parsed).pipe(Effect.mapError(() => failure('orphan.replay.decode', 'persistence-failed')))
    if (
      result.organizationId !== request.organizationId ||
      result.providerAccountId !== request.providerAccountId ||
      result.runId !== request.runId ||
      result.discoveryFingerprint !== string(row, 'discoveryFingerprint') ||
      result.replayed
    )
      return yield* failure('orphan.replay.result', 'persistence-failed')
    return { ...result, replayed: true }
  })

const decodePlanReplay = (
  value: unknown,
  plan: OrphanReconciliationPlan,
): Effect.Effect<OrphanReconciliationResult, OrphanControlError> =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined || string(row, 'discoveryFingerprint') !== plan.discoveryFingerprint)
      return yield* failure('orphan.replay.binding', 'idempotency-conflict')
    return yield* decodeRequestReplay(value, plan)
  })

const findingSummary = (
  plan: OrphanReconciliationPlan,
  providerResourceId: string,
  status: 'open' | 'resolved',
  resolutionKind: 'authoritative-adoption' | 'provider-removal' | null,
  revision?: number,
) => ({
  severity: 'high',
  status,
  providerType: plan.providerType,
  providerAccountId: plan.providerAccountId,
  providerResourceId,
  resourceKind: 'node',
  ...(revision === undefined ? {} : { revision }),
  ...(resolutionKind === null ? {} : { resolutionKind }),
})

const findingBefore = (
  plan: OrphanReconciliationPlan,
  providerResourceId: string,
  existing: FindingRow | undefined,
): AuditStateSummary =>
  existing === undefined
    ? { state: 'absent', reason: 'orphan-finding-did-not-exist' }
    : {
        state: 'captured',
        summary: findingSummary(
          plan,
          providerResourceId,
          existing.status,
          existing.resolutionKind,
          existing.revision,
        ),
      }

/**
 * The mutation operation, v1 envelope staging row, and compact audit row are
 * deliberately returned in this order. D1 batches execute sequentially, so
 * 0028 can prove the envelope references this exact terminal operation before
 * it accepts the compact row and emits an export request.
 */
const auditStatements = (
  database: OrphanD1Database,
  plan: OrphanReconciliationPlan,
  providerResourceId: string,
  action: string,
  status: 'open' | 'resolved',
  resolutionKind: 'authoritative-adoption' | 'provider-removal' | null,
  ordinal: number,
  now: string,
  before: AuditStateSummary,
): Effect.Effect<ReadonlyArray<OrphanD1Statement>, OrphanControlError> =>
  Effect.gen(function* () {
    const auditEventId = `orphan-audit:${plan.organizationId}:${plan.runId}:${ordinal}`
    const operationId = `orphan-audit-operation:${plan.organizationId}:${plan.runId}:${ordinal}`
    const targetId = `${plan.providerAccountId}:${providerResourceId}`
    const afterSummary = findingSummary(plan, providerResourceId, status, resolutionKind)
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
        action,
        target: { type: 'orphan_finding', id: targetId },
        before,
        after: { state: 'captured', summary: afterSummary },
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
    ).pipe(Effect.mapError(() => failure('orphan.audit.envelope', 'persistence-failed')))
    return [
      database
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status,
           progress, idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, ?, 'orphan_finding', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
        .bind(
          operationId,
          plan.organizationId,
          action,
          targetId,
          plan.actorId,
          `orphan-audit:${plan.runId}:${ordinal}`,
          plan.runId,
          now,
          now,
        ),
      database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      database
        .prepare(`INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, 'orphan_finding', ?, 'succeeded', ?, ?, ?)`)
        .bind(
          auditEventId,
          plan.organizationId,
          plan.actorId,
          action,
          targetId,
          plan.runId,
          JSON.stringify(afterSummary),
          now,
        ),
    ]
  })

export const makeOrphanD1Repository = (
  database: OrphanD1Database,
  overrides: Partial<OrphanD1Options> = {},
): OrphanRepositoryShape => {
  const options = { ...defaultOptions, ...overrides }
  return OrphanRepository.of({
    findReplay: (request) =>
      Effect.gen(function* () {
        yield* assertScope(database, request)
        const replay = yield* attempt('orphan.replay.find', () =>
          database
            .prepare(replaySelect)
            .bind(request.organizationId, request.idempotencyKey)
            .first(),
        )
        return replay === null ? null : yield* decodeRequestReplay(replay, request)
      }),
    authoritative: (request) => loadAuthoritative(database, request),
    applyAtomic: (input) =>
      Effect.gen(function* () {
        const plan = yield* Schema.decodeUnknownEffect(OrphanReconciliationPlan, {
          onExcessProperty: 'error',
        })(input).pipe(Effect.mapError(() => failure('orphan.plan.decode', 'ambiguous-discovery')))
        if (plan.observations.length > 200 || plan.removalEvidence.length > 200)
          return yield* failure('orphan.plan.bound', 'unbounded-discovery')
        yield* assertExactCredentialScope(database, plan)

        const replay = yield* attempt('orphan.replay.get', () =>
          database.prepare(replaySelect).bind(plan.organizationId, plan.idempotencyKey).first(),
        )
        if (replay !== null) return yield* decodePlanReplay(replay, plan)
        const runCollision = yield* attempt('orphan.replay.run', () =>
          database
            .prepare(
              `SELECT idempotency_key AS idempotencyKey
               FROM orphan_reconciliation_runs
               WHERE organization_id = ? AND run_id = ?`,
            )
            .bind(plan.organizationId, plan.runId)
            .first(),
        )
        if (runCollision !== null)
          return yield* failure('orphan.replay.run', 'idempotency-conflict')
        const latestObservation = yield* attempt('orphan.replay.latest', () =>
          database
            .prepare(latestObservationSelect)
            .bind(plan.organizationId, plan.providerAccountId, plan.providerType)
            .first(),
        )
        const latestObservedAt =
          latestObservation === null
            ? undefined
            : string(record(latestObservation) ?? {}, 'observedAt')
        if (
          latestObservedAt === undefined
            ? latestObservation !== null
            : Date.parse(latestObservedAt) >= Date.parse(plan.observedAt)
        )
          return yield* failure('orphan.replay.latest', 'stale-discovery')

        const observationIds = new Set<string>()
        for (const observation of plan.observations) {
          if (observationIds.has(observation.providerResourceId))
            return yield* failure('orphan.plan.observation', 'ambiguous-discovery')
          observationIds.add(observation.providerResourceId)
        }
        const removalIds = new Set<string>()
        for (const evidence of plan.removalEvidence) {
          if (
            removalIds.has(evidence.providerResourceId) ||
            observationIds.has(evidence.providerResourceId)
          )
            return yield* failure('orphan.plan.removal', 'ambiguous-discovery')
          removalIds.add(evidence.providerResourceId)
        }

        const authoritative = yield* loadAuthoritative(database, plan)
        const authoritativeKeys = new Set(
          authoritative.map((resource) =>
            [
              resource.providerResourceId,
              resource.nodeId,
              resource.operationId,
              resource.imageVersion,
            ].join('\u0000'),
          ),
        )
        for (const observation of plan.observations) {
          const exact = authoritativeKeys.has(
            [
              observation.providerResourceId,
              observation.nodeId,
              observation.operationId,
              observation.imageVersion,
            ].join('\u0000'),
          )
          if (
            (observation.disposition === 'authoritative-adoption' && !exact) ||
            (observation.disposition === 'orphan' && exact)
          )
            return yield* failure('orphan.plan.authority', 'persistence-failed')
        }

        const targetIds = [...observationIds, ...removalIds].sort()
        const findingRows =
          targetIds.length === 0
            ? []
            : (yield* attempt('orphan.findings.get', () =>
                database
                  .prepare(findingSelect)
                  .bind(plan.organizationId, plan.providerAccountId, JSON.stringify(targetIds))
                  .all(),
              )).results
        const findings = new Map<string, FindingRow>()
        for (const value of findingRows) {
          const finding = yield* decodeFinding(value)
          if (
            finding.organizationId !== plan.organizationId ||
            finding.providerAccountId !== plan.providerAccountId ||
            finding.providerType !== plan.providerType ||
            findings.has(finding.providerResourceId)
          )
            return yield* failure('orphan.findings.scope', 'persistence-failed')
          findings.set(finding.providerResourceId, finding)
        }

        const now = options.now()
        const statements: Array<OrphanD1Statement> = []
        let opened = 0
        let updated = 0
        let resolved = 0
        let unchanged = 0
        let auditOrdinal = 0

        for (const observation of plan.observations) {
          const existing = findings.get(observation.providerResourceId)
          if (
            existing !== undefined &&
            (existing.nodeId !== observation.nodeId ||
              existing.operationId !== observation.operationId ||
              existing.imageVersion !== observation.imageVersion)
          )
            return yield* failure('orphan.finding.identity', 'ambiguous-discovery')

          if (observation.disposition === 'orphan') {
            if (existing === undefined) {
              statements.push(
                database
                  .prepare(`INSERT INTO orphan_findings
                    (organization_id, provider_account_id, provider_type, resource_kind,
                     provider_resource_id, node_id, operation_id, image_version, severity,
                     status, first_detected_at, last_detected_at, last_discovery_run_id,
                     resolution_kind, resolution_evidence_id, resolved_at, revision)
                    VALUES (?, ?, ?, 'node', CASE WHEN NOT ${exactAuthorityExists} THEN ? ELSE NULL END,
                     ?, ?, ?, 'high', 'open', ?, ?, ?, NULL, NULL, NULL, 1)`)
                  .bind(
                    plan.organizationId,
                    plan.providerAccountId,
                    plan.providerType,
                    plan.organizationId,
                    plan.providerAccountId,
                    plan.providerType,
                    observation.providerResourceId,
                    observation.nodeId,
                    observation.operationId,
                    observation.imageVersion,
                    observation.providerResourceId,
                    observation.nodeId,
                    observation.operationId,
                    observation.imageVersion,
                    now,
                    now,
                    plan.runId,
                  ),
              )
              opened += 1
              auditOrdinal += 1
              statements.push(
                ...(yield* auditStatements(
                  database,
                  plan,
                  observation.providerResourceId,
                  'orphan.finding.opened',
                  'open',
                  null,
                  auditOrdinal,
                  now,
                  findingBefore(plan, observation.providerResourceId, existing),
                )),
              )
            } else if (existing.status === 'open') {
              statements.push(
                database
                  .prepare(`UPDATE orphan_findings SET
                    last_detected_at = ?, last_discovery_run_id = ?,
                    revision = CASE
                      WHEN revision = ? AND status = 'open' AND NOT ${exactAuthorityExists}
                      THEN revision + 1 ELSE NULL END
                    WHERE organization_id = ? AND provider_account_id = ?
                      AND provider_resource_id = ?`)
                  .bind(
                    now,
                    plan.runId,
                    existing.revision,
                    plan.organizationId,
                    plan.providerAccountId,
                    plan.providerType,
                    observation.providerResourceId,
                    observation.nodeId,
                    observation.operationId,
                    observation.imageVersion,
                    plan.organizationId,
                    plan.providerAccountId,
                    observation.providerResourceId,
                  ),
              )
              updated += 1
              auditOrdinal += 1
              statements.push(
                ...(yield* auditStatements(
                  database,
                  plan,
                  observation.providerResourceId,
                  'orphan.finding.observed',
                  'open',
                  null,
                  auditOrdinal,
                  now,
                  findingBefore(plan, observation.providerResourceId, existing),
                )),
              )
            } else {
              statements.push(
                database
                  .prepare(`UPDATE orphan_findings SET
                    status = CASE
                      WHEN revision = ? AND status = 'resolved' AND NOT ${exactAuthorityExists}
                      THEN 'open' ELSE NULL END,
                    last_detected_at = ?, last_discovery_run_id = ?,
                    resolution_kind = NULL, resolution_evidence_id = NULL, resolved_at = NULL,
                    revision = revision + 1
                    WHERE organization_id = ? AND provider_account_id = ?
                      AND provider_resource_id = ?`)
                  .bind(
                    existing.revision,
                    plan.organizationId,
                    plan.providerAccountId,
                    plan.providerType,
                    observation.providerResourceId,
                    observation.nodeId,
                    observation.operationId,
                    observation.imageVersion,
                    now,
                    plan.runId,
                    plan.organizationId,
                    plan.providerAccountId,
                    observation.providerResourceId,
                  ),
              )
              opened += 1
              auditOrdinal += 1
              statements.push(
                ...(yield* auditStatements(
                  database,
                  plan,
                  observation.providerResourceId,
                  'orphan.finding.reopened',
                  'open',
                  null,
                  auditOrdinal,
                  now,
                  findingBefore(plan, observation.providerResourceId, existing),
                )),
              )
            }
          } else if (existing?.status === 'open') {
            statements.push(
              database
                .prepare(`UPDATE orphan_findings SET
                  status = CASE
                    WHEN revision = ? AND status = 'open' AND ${exactAuthorityExists}
                    THEN 'resolved' ELSE NULL END,
                  last_discovery_run_id = ?, resolution_kind = 'authoritative-adoption',
                  resolution_evidence_id = ?, resolved_at = ?, revision = revision + 1
                  WHERE organization_id = ? AND provider_account_id = ?
                    AND provider_resource_id = ?`)
                .bind(
                  existing.revision,
                  plan.organizationId,
                  plan.providerAccountId,
                  plan.providerType,
                  observation.providerResourceId,
                  observation.nodeId,
                  observation.operationId,
                  observation.imageVersion,
                  plan.runId,
                  observation.operationId,
                  now,
                  plan.organizationId,
                  plan.providerAccountId,
                  observation.providerResourceId,
                ),
            )
            resolved += 1
            auditOrdinal += 1
            statements.push(
              ...(yield* auditStatements(
                database,
                plan,
                observation.providerResourceId,
                'orphan.finding.resolved',
                'resolved',
                'authoritative-adoption',
                auditOrdinal,
                now,
                findingBefore(plan, observation.providerResourceId, existing),
              )),
            )
          } else {
            unchanged += 1
          }
        }

        for (const evidence of plan.removalEvidence) {
          const existing = findings.get(evidence.providerResourceId)
          if (existing?.status !== 'open') {
            unchanged += 1
            continue
          }
          statements.push(
            database
              .prepare(`UPDATE orphan_findings SET
                status = CASE WHEN revision = ? AND status = 'open' THEN 'resolved' ELSE NULL END,
                last_discovery_run_id = ?, resolution_kind = 'provider-removal',
                resolution_evidence_id = ?, resolved_at = ?, revision = revision + 1
                WHERE organization_id = ? AND provider_account_id = ?
                  AND provider_resource_id = ?`)
              .bind(
                existing.revision,
                plan.runId,
                evidence.evidenceId,
                now,
                plan.organizationId,
                plan.providerAccountId,
                evidence.providerResourceId,
              ),
          )
          resolved += 1
          auditOrdinal += 1
          statements.push(
            ...(yield* auditStatements(
              database,
              plan,
              evidence.providerResourceId,
              'orphan.finding.resolved',
              'resolved',
              'provider-removal',
              auditOrdinal,
              now,
              findingBefore(plan, evidence.providerResourceId, existing),
            )),
          )
        }

        const result: OrphanReconciliationResult = {
          organizationId: plan.organizationId,
          providerAccountId: plan.providerAccountId,
          runId: plan.runId,
          discoveryFingerprint: plan.discoveryFingerprint,
          opened,
          updated,
          resolved,
          unchanged,
          replayed: false,
        }
        statements.push(
          database
            .prepare(`INSERT INTO orphan_reconciliation_runs
              (organization_id, idempotency_key, run_id, provider_account_id, provider_type,
               credential_reference, credential_revision, actor_id, discovery_fingerprint,
               discovery_observed_at, result_json, completed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              plan.organizationId,
              plan.idempotencyKey,
              plan.runId,
              plan.providerAccountId,
              plan.providerType,
              plan.credentialReference,
              plan.credentialRevision,
              plan.actorId,
              plan.discoveryFingerprint,
              plan.observedAt,
              JSON.stringify(result),
              now,
            ),
        )

        const write = attempt('orphan.apply', () => database.batch(statements)).pipe(
          Effect.as(result),
        )
        return yield* write.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const concurrent = yield* attempt('orphan.replay.response-loss', () =>
                database
                  .prepare(replaySelect)
                  .bind(plan.organizationId, plan.idempotencyKey)
                  .first(),
              )
              if (concurrent !== null) return yield* decodePlanReplay(concurrent, plan)
              const latest = yield* attempt('orphan.replay.response-loss.latest', () =>
                database
                  .prepare(latestObservationSelect)
                  .bind(plan.organizationId, plan.providerAccountId, plan.providerType)
                  .first(),
              )
              const latestAt =
                latest === null ? undefined : string(record(latest) ?? {}, 'observedAt')
              return latestAt !== undefined && Date.parse(latestAt) > Date.parse(plan.observedAt)
                ? yield* failure('orphan.replay.response-loss.latest', 'stale-discovery')
                : yield* Effect.fail(error)
            }),
          ),
        )
      }),
  })
}

export const OrphanD1RepositoryLive = Layer.effect(
  OrphanRepository,
  Effect.gen(function* () {
    const database = yield* OrphanD1Client
    return makeOrphanD1Repository(database)
  }),
)

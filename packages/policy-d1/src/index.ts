import { Context, Effect, Layer, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import {
  AdmissionFactsError,
  AdmissionFactsPort,
  type AdmissionFactsPortShape,
  type AdmissionRequest,
  decodeOrganizationPolicy,
  type LifecycleAdmissionCommand,
  type LifecycleAdmissionSnapshot,
  type OrganizationPolicyRepositoryShape,
  OrganizationPolicyRepository,
  OrganizationPolicyV1,
  PolicyStoreError,
  type OrganizationUsage,
  type PriceEstimate,
} from '@gridora/policy-control'

export interface PolicyD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface PolicyD1Statement {
  bind(...values: ReadonlyArray<unknown>): PolicyD1Statement
  first(): Promise<unknown>
  all(): Promise<PolicyD1Result>
}
export interface PolicyD1Database {
  prepare(sql: string): PolicyD1Statement
  /** Cloudflare D1 executes a batch in one transaction and returns results in statement order. */
  batch(statements: ReadonlyArray<PolicyD1Statement>): Promise<ReadonlyArray<PolicyD1Result>>
}
export class PolicyD1Client extends Context.Service<PolicyD1Client, PolicyD1Database>()(
  '@gridora/policy-d1/PolicyD1Client',
) {}
export const PolicyD1ClientLayer = (database: PolicyD1Database) =>
  Layer.succeed(PolicyD1Client, database)

export interface PolicyD1Options {
  readonly nowEpochMilliseconds: () => number
  readonly priceMaxAgeMilliseconds: number
  readonly hourlyEstimateHoursPerMonth: number
}
const defaults: PolicyD1Options = {
  nowEpochMilliseconds: () => Date.now(),
  priceMaxAgeMilliseconds: 6 * 60 * 60 * 1_000,
  hourlyEstimateHoursPerMonth: 730,
}

const failure = (operation: string) => new AdmissionFactsError({ operation })
const policyFailure = (operation: string) => new PolicyStoreError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const policyAttempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => policyFailure(operation) })
const row = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const safeInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
const nonNegative = (value: unknown): number | undefined => {
  const number = safeInt(value)
  return number !== undefined && number >= 0 ? number : undefined
}
const positive = (value: unknown): number | undefined => {
  const number = safeInt(value)
  return number !== undefined && number > 0 ? number : undefined
}
const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}
const isoEpoch = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
const addSafe = (left: number, right: number): number | undefined => {
  const result = left + right
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined
}
const multiplySafe = (left: number, right: number): number | undefined => {
  const result = left * right
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined
}

const policySql = `SELECT policy.organization_id AS organizationId,
 policy.policy_json AS policyJson, policy.revision AS storedRevision,
 organization.policy_revision AS organizationRevision
 FROM organization_policies policy
 JOIN organizations organization ON organization.id = policy.organization_id
 WHERE policy.organization_id = ?`

export const makeOrganizationPolicyRepositoryD1 = (
  database: PolicyD1Database,
): OrganizationPolicyRepositoryShape => ({
  get: (organizationId) =>
    Effect.gen(function* () {
      const value = yield* policyAttempt('policy.get', () =>
        database.prepare(policySql).bind(organizationId).first(),
      )
      const record = row(value)
      const policyJson = parseJson(record?.policyJson)
      const storedRevision = safeInt(record?.storedRevision)
      const organizationRevision = safeInt(record?.organizationRevision)
      if (
        record === undefined ||
        record.organizationId !== organizationId ||
        policyJson === undefined ||
        storedRevision === undefined ||
        organizationRevision === undefined
      )
        return yield* policyFailure('policy.get.not-found-or-invalid')
      const policy = yield* decodeOrganizationPolicy(policyJson).pipe(
        Effect.mapError(() => policyFailure('policy.get.decode')),
      )
      if (
        policy.organizationId !== organizationId ||
        policy.revision !== storedRevision ||
        policy.revision !== organizationRevision
      )
        return yield* policyFailure('policy.get.revision-fence')
      return policy
    }),
})

const nodeCountsSql = `SELECT COUNT(*) AS activeNodes,
 COALESCE(SUM(CASE WHEN placement_mode = 'dedicated' THEN 1 ELSE 0 END), 0) AS dedicatedNodes,
 (SELECT json_extract(policy_json, '$.monthlyBudget.currency') FROM organization_policies
   WHERE organization_id = ?) AS budgetCurrency
 FROM nodes WHERE organization_id = ? AND desired_state <> 'deleted' AND id <> ?`
const serverCountsSql = `SELECT deployment.node_id AS nodeId, COUNT(*) AS serverCount
 FROM deployments deployment
 JOIN game_servers server ON server.organization_id = deployment.organization_id
  AND server.id = deployment.server_id
 WHERE deployment.organization_id = ? AND server.desired_state <> 'deleted'
  AND deployment.observed_state <> 'deleted'
 GROUP BY deployment.node_id ORDER BY deployment.node_id`
const resourceTotalsSql = `SELECT COALESCE(SUM(capacity.cpu_millis_reserved), 0) AS cpuMillisReserved,
 COALESCE(SUM(capacity.memory_bytes_reserved), 0) AS ramBytesReserved,
 COALESCE(SUM(capacity.disk_bytes_reserved), 0) AS diskBytesReserved,
 MAX(capacity.observed_at) AS latestObservedAt
 FROM node_capacity capacity
 JOIN nodes node ON node.organization_id = capacity.organization_id AND node.id = capacity.node_id
 WHERE capacity.organization_id = ? AND node.desired_state <> 'deleted' AND node.id <> ?`
const commitmentsSql = `SELECT node.id AS nodeId, node.provider_type AS provider,
 node.region, node.plan, catalog.currency,
 catalog.hourly_price_minor AS hourlyPriceMinor,
 catalog.monthly_price_minor AS monthlyPriceMinor, catalog.metadata_json AS metadataJson,
 catalog.refreshed_at AS refreshedAt
 FROM nodes node
 LEFT JOIN provider_catalog catalog ON catalog.provider_type = node.provider_type
  AND catalog.region = node.region AND catalog.plan = node.plan
 WHERE node.organization_id = ? AND node.desired_state <> 'deleted' AND node.id <> ?
 ORDER BY node.id`
const orphanPaidOperationsSql = `SELECT COUNT(*) AS orphanCount FROM operations operation
 WHERE operation.organization_id = ? AND operation.resource_type = 'node'
  AND operation.type = 'provision-node'
  AND operation.status IN ('requested', 'queued', 'running', 'waiting_external', 'retrying')
  AND NOT EXISTS (SELECT 1 FROM nodes node WHERE node.organization_id = operation.organization_id
   AND node.id = operation.resource_id AND node.desired_state <> 'deleted')`
const resourceSql = `SELECT 'node' AS resourceKind, node.id AS resourceId,
 node.provider_type AS provider, node.region, node.plan, node.placement_mode AS placementMode,
 NULL AS placementPolicyJson, node.id AS targetNodeId, NULL AS serverRevision
 FROM nodes node WHERE ? = 'node' AND node.organization_id = ? AND node.id = ?
 UNION ALL
 SELECT 'server' AS resourceKind, server.id AS resourceId,
 node.provider_type AS provider, node.region, node.plan, node.placement_mode AS placementMode,
 server.placement_policy_json AS placementPolicyJson, deployment.node_id AS targetNodeId,
 server.desired_revision AS serverRevision
 FROM game_servers server
 LEFT JOIN deployments deployment ON deployment.organization_id = server.organization_id
  AND deployment.server_id = server.id
 LEFT JOIN nodes node ON node.organization_id = deployment.organization_id
  AND node.id = deployment.node_id
 WHERE ? = 'server' AND server.organization_id = ? AND server.id = ?`
const allocationSql = `SELECT account.provider_type AS provider,
 allocation.allowed_regions_json AS allowedRegionsJson,
 allocation.allowed_plans_json AS allowedPlansJson, allocation.status
 FROM nodes node
 JOIN provider_allocations allocation ON allocation.organization_id = node.organization_id
  AND allocation.provider_account_id = node.provider_account_id
 JOIN provider_accounts account ON account.id = allocation.provider_account_id
 WHERE node.organization_id = ? AND node.id = ? AND account.status = 'active'`
const requestedPriceSql = `SELECT catalog.provider_type AS provider, catalog.region, catalog.plan,
 catalog.currency, catalog.hourly_price_minor AS hourlyPriceMinor,
 catalog.monthly_price_minor AS monthlyPriceMinor, catalog.metadata_json AS metadataJson,
 catalog.refreshed_at AS refreshedAt
 FROM nodes node
 JOIN provider_catalog catalog ON catalog.provider_type = node.provider_type
  AND catalog.region = node.region AND catalog.plan = node.plan
 WHERE node.organization_id = ? AND node.id = ?`
const backupCoverageSql = `SELECT server.id AS serverId, server.desired_revision AS desiredRevision,
 CASE WHEN EXISTS (
  SELECT 1 FROM backups backup WHERE backup.organization_id = server.organization_id
   AND backup.server_id = server.id AND backup.state = 'available'
   AND json_type(backup.metadata_json, '$.desiredRevision') = 'integer'
   AND CAST(json_extract(backup.metadata_json, '$.desiredRevision') AS INTEGER) = server.desired_revision
 ) THEN 1 ELSE 0 END AS verified
 FROM game_servers server
 LEFT JOIN deployments deployment ON deployment.organization_id = server.organization_id
  AND deployment.server_id = server.id
 WHERE server.organization_id = ? AND server.desired_state <> 'deleted'
  AND ((? = 'server' AND server.id = ?) OR (? = 'node' AND deployment.node_id = ?))
 ORDER BY server.id`

export interface ResourceUsageTotals {
  readonly cpuMillisReserved: number
  readonly ramBytesReserved: number
  readonly diskBytesReserved: number
  readonly latestObservedAtEpochMilliseconds: number | null
}
export interface PolicyD1UsageSnapshot {
  readonly usage: OrganizationUsage
  readonly resources: ResourceUsageTotals
}

const monthlyEstimate = (
  value: Record<string, unknown>,
  hourlyEstimateHoursPerMonth: number,
): number | undefined => {
  const monthly = nonNegative(value.monthlyPriceMinor)
  if (monthly !== undefined) return monthly
  const hourly = nonNegative(value.hourlyPriceMinor)
  return hourly === undefined ? undefined : multiplySafe(hourly, hourlyEstimateHoursPerMonth)
}

const decodeUsageBatch = (
  organizationId: string,
  now: number,
  results: ReadonlyArray<PolicyD1Result>,
  options: PolicyD1Options,
): Effect.Effect<PolicyD1UsageSnapshot, AdmissionFactsError> => {
  const counts = row(results[0]?.results[0])
  const activeNodes = nonNegative(counts?.activeNodes)
  const dedicatedNodes = nonNegative(counts?.dedicatedNodes)
  const budgetCurrency = text(counts?.budgetCurrency)
  const serversByNode: Record<string, number> = {}
  for (const value of results[1]?.results ?? []) {
    const server = row(value)
    const nodeId = text(server?.nodeId)
    const serverCount = nonNegative(server?.serverCount)
    if (nodeId === undefined || serverCount === undefined)
      return Effect.fail(failure('policy.usage.server-counts.decode'))
    serversByNode[nodeId] = serverCount
  }
  const resources = row(results[2]?.results[0])
  const cpuMillisReserved = nonNegative(resources?.cpuMillisReserved)
  const ramBytesReserved = nonNegative(resources?.ramBytesReserved)
  const diskBytesReserved = nonNegative(resources?.diskBytesReserved)
  const latestObserved =
    resources?.latestObservedAt === null ? null : isoEpoch(resources?.latestObservedAt)
  const orphanCount = nonNegative(row(results[4]?.results[0])?.orphanCount)
  if (
    activeNodes === undefined ||
    dedicatedNodes === undefined ||
    budgetCurrency === undefined ||
    cpuMillisReserved === undefined ||
    ramBytesReserved === undefined ||
    diskBytesReserved === undefined ||
    latestObserved === undefined ||
    orphanCount === undefined ||
    orphanCount !== 0
  )
    return Effect.fail(failure('policy.usage.invalid-or-incomplete'))

  let currency: string | undefined
  let commitment = 0
  for (const value of results[3]?.results ?? []) {
    const commitmentRow = row(value)
    const rowCurrency = text(commitmentRow?.currency)
    const estimate =
      commitmentRow === undefined
        ? undefined
        : monthlyEstimate(commitmentRow, options.hourlyEstimateHoursPerMonth)
    const refreshedAt = isoEpoch(commitmentRow?.refreshedAt)
    const validUntil =
      refreshedAt === undefined ? undefined : addSafe(refreshedAt, options.priceMaxAgeMilliseconds)
    if (
      rowCurrency === undefined ||
      estimate === undefined ||
      validUntil === undefined ||
      validUntil <= now
    )
      return Effect.fail(failure('policy.usage.commitment-price-missing'))
    if (rowCurrency !== budgetCurrency || (currency !== undefined && rowCurrency !== currency))
      return Effect.fail(failure('policy.usage.mixed-currency'))
    currency = rowCurrency
    const total = addSafe(commitment, estimate)
    if (total === undefined) return Effect.fail(failure('policy.usage.commitment-overflow'))
    commitment = total
  }
  return Effect.succeed({
    usage: {
      organizationId,
      observedAtEpochMilliseconds: now,
      activeNodes,
      dedicatedNodes,
      serversByNode,
      estimatedCommittedMonthlyMinor: commitment,
      currency: budgetCurrency,
    },
    resources: {
      cpuMillisReserved,
      ramBytesReserved,
      diskBytesReserved,
      latestObservedAtEpochMilliseconds: latestObserved,
    },
  })
}

const batchUsage = (
  database: PolicyD1Database,
  organizationId: string,
  resourceId: string,
  excludedNodeId: string,
  resourceKind: LifecycleAdmissionSnapshot['kind'],
) =>
  database.batch([
    database.prepare(nodeCountsSql).bind(organizationId, organizationId, excludedNodeId),
    database.prepare(serverCountsSql).bind(organizationId),
    database.prepare(resourceTotalsSql).bind(organizationId, excludedNodeId),
    database.prepare(commitmentsSql).bind(organizationId, excludedNodeId),
    database.prepare(orphanPaidOperationsSql).bind(organizationId),
    database
      .prepare(resourceSql)
      .bind(resourceKind, organizationId, resourceId, resourceKind, organizationId, resourceId),
    database.prepare(allocationSql).bind(organizationId, resourceId),
    database.prepare(requestedPriceSql).bind(organizationId, resourceId),
    database
      .prepare(backupCoverageSql)
      .bind(organizationId, resourceKind, resourceId, resourceKind, resourceId),
  ])

const stringArray = (value: unknown): ReadonlyArray<string> | undefined => {
  const parsed = parseJson(value)
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
    ? parsed
    : undefined
}
const placement = (value: unknown) => {
  const parsed = row(parseJson(value))
  const resources = row(parsed?.resources)
  return {
    resources:
      resources !== undefined &&
      positive(resources.cpuMillis) !== undefined &&
      positive(resources.ramBytes) !== undefined &&
      positive(resources.diskBytes) !== undefined
        ? {
            cpuMillis: positive(resources.cpuMillis) as number,
            ramBytes: positive(resources.ramBytes) as number,
            diskBytes: positive(resources.diskBytes) as number,
          }
        : null,
    temporaryNodeLifetimeHours: positive(parsed?.temporaryNodeLifetimeHours) ?? null,
    nonHourlyCommitmentConfirmed: parsed?.nonHourlyCommitmentConfirmed === true,
    updateMode:
      parsed?.updateMode === 'automatic' || parsed?.updateMode === 'manual'
        ? parsed.updateMode
        : 'not-applicable',
    updateCategory:
      parsed?.updateCategory === 'security' || parsed?.updateCategory === 'feature'
        ? parsed.updateCategory
        : 'not-applicable',
  } as const
}

const action = (kind: string): AdmissionRequest['action'] => {
  if (kind === 'provision-node') return 'provision-node'
  if (kind === 'deploy-server') return 'deploy-server'
  if (kind === 'move-server') return 'move-server'
  if (kind === 'delete-node' || kind === 'retire-node') return 'delete-node'
  if (kind === 'delete-server') return 'delete-server'
  if (kind === 'update-server-mods') return 'update-server'
  return 'other'
}
const actionKind = (
  value: AdmissionRequest['action'],
): LifecycleAdmissionSnapshot['kind'] | null =>
  value === 'provision-node' || value === 'delete-node'
    ? 'node'
    : value === 'deploy-server' ||
        value === 'move-server' ||
        value === 'delete-server' ||
        value === 'update-server'
      ? 'server'
      : null

const decodeRequestedPrice = (
  value: unknown,
  now: number,
  options: PolicyD1Options,
): PriceEstimate => {
  const price = row(value)
  if (price === undefined) return { status: 'unknown' }
  const provider = text(price.provider)
  const region = text(price.region)
  const plan = text(price.plan)
  const currency = text(price.currency)
  const refreshedAt = isoEpoch(price.refreshedAt)
  const estimate = monthlyEstimate(price, options.hourlyEstimateHoursPerMonth)
  // The current schema has no immutable node-specific Contabo contract duration. Mutable catalog
  // metadata cannot prove the commitment accepted for this node, so Contabo fails closed here.
  const contractMonths = provider === 'contabo' ? undefined : 1
  const billingCadence =
    provider === 'contabo'
      ? 'contract'
      : nonNegative(price.hourlyPriceMinor) !== undefined
        ? 'hourly'
        : 'monthly'
  if (
    provider === undefined ||
    region === undefined ||
    plan === undefined ||
    currency === undefined ||
    refreshedAt === undefined ||
    estimate === undefined ||
    contractMonths === undefined ||
    contractMonths < 1
  )
    return { status: 'unknown' }
  const validUntil = addSafe(refreshedAt, options.priceMaxAgeMilliseconds)
  if (validUntil === undefined) return { status: 'unknown' }
  return {
    status: 'known',
    provider,
    region,
    plan,
    currency,
    estimatedMonthlyMinor: estimate,
    billingCadence,
    contractMonths,
    observedAtEpochMilliseconds: refreshedAt,
    validUntilEpochMilliseconds: validUntil,
  }
}

export interface PolicyFactsD1Repository {
  readonly readUsageSnapshot: (
    organizationId: string,
  ) => Effect.Effect<PolicyD1UsageSnapshot, AdmissionFactsError>
  readonly resolve: AdmissionFactsPortShape['resolve']
}

export const makePolicyFactsD1Repository = (
  database: PolicyD1Database,
  overrides: Partial<PolicyD1Options> = {},
): PolicyFactsD1Repository => {
  const options = { ...defaults, ...overrides }
  const resolveBatch = (
    organizationId: string,
    resourceId: string,
    excludedNodeId: string,
    resourceKind: LifecycleAdmissionSnapshot['kind'],
  ) =>
    Effect.gen(function* () {
      const now = options.nowEpochMilliseconds()
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(options.priceMaxAgeMilliseconds) ||
        options.priceMaxAgeMilliseconds <= 0 ||
        !Number.isSafeInteger(options.hourlyEstimateHoursPerMonth) ||
        options.hourlyEstimateHoursPerMonth <= 0
      )
        return yield* failure('policy.facts.configuration-invalid')
      const results = yield* attempt('policy.facts.batch', () =>
        batchUsage(database, organizationId, resourceId, excludedNodeId, resourceKind),
      )
      const snapshot = yield* decodeUsageBatch(organizationId, now, results, options)
      return { now, results, snapshot }
    })
  return {
    readUsageSnapshot: (organizationId) =>
      resolveBatch(organizationId, '__policy_usage_only__', '__exclude_no_node__', 'node').pipe(
        Effect.map((result) => result.snapshot),
      ),
    resolve: (command: LifecycleAdmissionCommand, snapshot: LifecycleAdmissionSnapshot) =>
      Effect.gen(function* () {
        if (command.organizationId !== snapshot.organizationId)
          return yield* failure('policy.facts.organization-scope')
        if (
          'resourceId' in command &&
          typeof command.resourceId === 'string' &&
          command.resourceId !== snapshot.id
        )
          return yield* failure('policy.facts.resource-scope')
        const resourceId = snapshot.id
        const mappedAction = action(command.kind)
        const requiredKind = actionKind(mappedAction)
        if (requiredKind !== null && requiredKind !== snapshot.kind)
          return yield* failure('policy.facts.resource-kind')
        const result = yield* resolveBatch(
          command.organizationId,
          resourceId,
          command.kind === 'provision-node' ? resourceId : '__exclude_no_node__',
          snapshot.kind,
        )
        const resourceRows = result.results[5]?.results ?? []
        const resource = resourceRows.length === 1 ? row(resourceRows[0]) : undefined
        if (resource === undefined && mappedAction !== 'other')
          return yield* failure('policy.facts.resource-not-found')
        const allocation = row(result.results[6]?.results[0])
        const requestedPrice = result.results[7]?.results[0]
        const provider = text(resource?.provider) ?? null
        const region = text(resource?.region) ?? null
        const plan = text(resource?.plan) ?? null
        let price = decodeRequestedPrice(requestedPrice, result.now, options)
        if (mappedAction === 'provision-node') {
          const allowedRegions = stringArray(allocation?.allowedRegionsJson)
          const allowedPlans = stringArray(allocation?.allowedPlansJson)
          if (
            allocation?.status !== 'active' ||
            provider === null ||
            region === null ||
            plan === null ||
            allowedRegions === undefined ||
            allowedPlans === undefined ||
            !allowedRegions.includes(region) ||
            !allowedPlans.includes(plan)
          )
            price = { status: 'unknown' }
        } else {
          price = { status: 'unknown' }
        }
        const placementPolicy = placement(resource?.placementPolicyJson)
        const verifiedBackup = (result.results[8]?.results ?? []).every((backup) => {
          const coverage = row(backup)
          return (
            text(coverage?.serverId) !== undefined &&
            safeInt(coverage?.desiredRevision) !== undefined &&
            coverage?.verified === 1
          )
        })
        const request: AdmissionRequest = {
          organizationId: command.organizationId,
          action: mappedAction,
          provider,
          region,
          plan,
          dedicatedNode: resource?.placementMode === 'dedicated',
          targetNodeId: text(resource?.targetNodeId) ?? null,
          resources: placementPolicy.resources,
          temporaryNodeLifetimeHours: placementPolicy.temporaryNodeLifetimeHours,
          destructiveBackup:
            mappedAction === 'delete-node' || mappedAction === 'delete-server'
              ? verifiedBackup
                ? 'verified'
                : 'missing'
              : 'not-applicable',
          nonHourlyCommitmentConfirmed: placementPolicy.nonHourlyCommitmentConfirmed,
          updateContext: {
            mode: mappedAction === 'update-server' ? placementPolicy.updateMode : 'not-applicable',
            category:
              mappedAction === 'update-server' ? placementPolicy.updateCategory : 'not-applicable',
          },
        }
        return { request, usage: result.snapshot.usage, price }
      }),
  }
}

export const OrganizationPolicyRepositoryD1Live = Layer.effect(
  OrganizationPolicyRepository,
  Effect.gen(function* () {
    return OrganizationPolicyRepository.of(
      makeOrganizationPolicyRepositoryD1(yield* PolicyD1Client),
    )
  }),
)
export const AdmissionFactsD1Live = (options: Partial<PolicyD1Options> = {}) =>
  Layer.effect(
    AdmissionFactsPort,
    Effect.gen(function* () {
      return AdmissionFactsPort.of(makePolicyFactsD1Repository(yield* PolicyD1Client, options))
    }),
  )

export const makePolicyD1Layers = (
  database: PolicyD1Database,
  options: Partial<PolicyD1Options> = {},
) =>
  Layer.merge(OrganizationPolicyRepositoryD1Live, AdmissionFactsD1Live(options)).pipe(
    Layer.provide(PolicyD1ClientLayer(database)),
  )

// Compile-time assurance that the decoded repository output remains the policy-control contract.
const _policyContract: (value: OrganizationPolicyV1) => OrganizationPolicyV1 = (value) => value
void _policyContract

export class PolicyManagementNotFoundError extends Schema.TaggedError<PolicyManagementNotFoundError>()(
  'PolicyManagementNotFoundError',
  { organizationId: Schema.String },
) {}
export class PolicyManagementConflictError extends Schema.TaggedError<PolicyManagementConflictError>()(
  'PolicyManagementConflictError',
  {
    code: Schema.Literals(['revision_mismatch', 'idempotency_payload_mismatch']),
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
  },
) {}
export class PolicyManagementPersistenceError extends Schema.TaggedError<PolicyManagementPersistenceError>()(
  'PolicyManagementPersistenceError',
  { operation: Schema.String },
) {}

export interface PolicyMutationContext {
  readonly organizationId: string
  readonly identityId: string
  readonly correlationId: string
}
export interface PutOrganizationPolicyInput {
  readonly context: PolicyMutationContext
  readonly expectedRevision: number
  readonly policy: OrganizationPolicyV1
  readonly idempotencyKey: string
  readonly operationIdempotencyKey: string
  readonly requestFingerprint: string
  readonly operationId: string
  readonly request: AuditRequestContextValue
  readonly now: string
}
export interface PutOrganizationPolicyResult {
  readonly operationId: string
  readonly resourceId: string
  readonly value: OrganizationPolicyV1
  readonly replayed: boolean
}
export type PolicyManagementError =
  | PolicyManagementNotFoundError
  | PolicyManagementConflictError
  | PolicyManagementPersistenceError

export interface PolicyManagementRepositoryShape {
  readonly get: (
    organizationId: string,
  ) => Effect.Effect<OrganizationPolicyV1, PolicyManagementError>
  readonly put: (
    input: PutOrganizationPolicyInput,
  ) => Effect.Effect<PutOrganizationPolicyResult, PolicyManagementError>
}

const replaySql = `SELECT operation_id AS operationId, resource_id AS resourceId,
 payload_fingerprint AS requestFingerprint, result_json AS resultJson
 FROM core_mutation_receipts
 WHERE organization_id = ? AND actor_id = ? AND action = 'update-organization-policy'
  AND idempotency_key = ?`

const managementPersistence = (operation: string) =>
  new PolicyManagementPersistenceError({ operation })
const managementAttempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => managementPersistence(operation) })

const decodeManagementPolicyRow = (
  organizationId: string,
  value: unknown,
): Effect.Effect<OrganizationPolicyV1, PolicyManagementError> =>
  Effect.gen(function* () {
    if (value === null) return yield* new PolicyManagementNotFoundError({ organizationId })
    const record = row(value)
    const storedRevision = safeInt(record?.storedRevision)
    const organizationRevision = safeInt(record?.organizationRevision)
    const encoded = parseJson(record?.policyJson)
    if (
      record?.organizationId !== organizationId ||
      storedRevision === undefined ||
      organizationRevision === undefined
    )
      return yield* managementPersistence('policy.management.decode')
    const decoded = yield* decodeOrganizationPolicy(encoded).pipe(
      Effect.mapError(() => managementPersistence('policy.management.decode')),
    )
    if (
      decoded.organizationId !== organizationId ||
      decoded.revision !== storedRevision ||
      decoded.revision !== organizationRevision
    )
      return yield* managementPersistence('policy.management.revision-fence')
    return decoded
  })

const getManaged = (database: PolicyD1Database, organizationId: string) =>
  managementAttempt('policy.management.get', () =>
    database.prepare(policySql).bind(organizationId).first(),
  ).pipe(Effect.flatMap((value) => decodeManagementPolicyRow(organizationId, value)))

interface StoredReplay {
  readonly operationId: string
  readonly resourceId: string
  readonly fingerprint: string
  readonly result: OrganizationPolicyV1
}
const getReplay = (
  database: PolicyD1Database,
  organizationId: string,
  actorId: string,
  idempotencyKey: string,
  expectedRevision: number,
): Effect.Effect<
  StoredReplay | null,
  PolicyManagementPersistenceError | PolicyManagementConflictError
> =>
  Effect.gen(function* () {
    const value = yield* managementAttempt('policy.management.replay.get', () =>
      database.prepare(replaySql).bind(organizationId, actorId, idempotencyKey).first(),
    )
    if (value === null) return null
    const record = row(value)
    if (record?.resourceId !== organizationId)
      return yield* new PolicyManagementConflictError({
        code: 'idempotency_payload_mismatch',
        expectedRevision,
        actualRevision: 0,
      })
    const result = yield* Schema.decodeUnknownEffect(OrganizationPolicyV1, {
      onExcessProperty: 'error',
    })(parseJson(record.resultJson)).pipe(
      Effect.mapError(() => managementPersistence('policy.management.replay.decode')),
    )
    if (result.organizationId !== organizationId)
      return yield* managementPersistence('policy.management.replay.fence')
    return {
      operationId: text(record.operationId) ?? '',
      resourceId: organizationId,
      fingerprint: text(record.requestFingerprint) ?? '',
      result,
    }
  })

const replayOrConflict = (
  replay: StoredReplay,
  expectedRevision: number,
  requestFingerprint: string,
): Effect.Effect<PutOrganizationPolicyResult, PolicyManagementConflictError> =>
  replay.fingerprint === requestFingerprint && replay.result.revision === expectedRevision + 1
    ? Effect.succeed({
        operationId: replay.operationId,
        resourceId: replay.resourceId,
        value: replay.result,
        replayed: true,
      })
    : Effect.fail(
        new PolicyManagementConflictError({
          code: 'idempotency_payload_mismatch',
          expectedRevision,
          actualRevision: replay.result.revision,
        }),
      )

const updatePolicySql = `UPDATE organization_policies
 SET policy_json = ?, revision = ?, updated_by = ?, updated_at = ?
 WHERE organization_id = ? AND revision = ?
  AND CAST(json_extract(policy_json, '$.revision') AS INTEGER) = ?`
const updateOrganizationRevisionSql = `UPDATE organizations SET policy_revision = ?
 WHERE id = ? AND policy_revision = ?`
const insertOperationSql = `INSERT INTO operations
 (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
  idempotency_key, correlation_id, revision, created_at, updated_at)
 SELECT ?, ?, 'update-organization-policy', 'organization-policy', ?, ?, 'succeeded', 100,
  ?, ?, ?, ?, ?
 WHERE changes() = 1 AND EXISTS (
  SELECT 1 FROM organization_policies policy
  JOIN organizations organization ON organization.id = policy.organization_id
  WHERE policy.organization_id = ? AND policy.revision = ?
   AND organization.policy_revision = ?
   AND CAST(json_extract(policy.policy_json, '$.revision') AS INTEGER) = ?
   AND policy.policy_json = ?
 )`
export const makePolicyManagementRepositoryD1 = (
  database: PolicyD1Database,
): PolicyManagementRepositoryShape => ({
  get: (organizationId) => getManaged(database, organizationId),
  put: (input) =>
    Effect.gen(function* () {
      const replay = yield* getReplay(
        database,
        input.context.organizationId,
        input.context.identityId,
        input.idempotencyKey,
        input.expectedRevision,
      )
      if (replay !== null)
        return yield* replayOrConflict(replay, input.expectedRevision, input.requestFingerprint)

      const before = yield* getManaged(database, input.context.organizationId)
      if (before.revision !== input.expectedRevision)
        return yield* new PolicyManagementConflictError({
          code: 'revision_mismatch',
          expectedRevision: input.expectedRevision,
          actualRevision: before.revision,
        })
      const resultRevision = input.expectedRevision + 1
      if (
        !Number.isSafeInteger(resultRevision) ||
        input.policy.organizationId !== input.context.organizationId ||
        input.policy.revision !== resultRevision
      )
        return yield* new PolicyManagementConflictError({
          code: 'revision_mismatch',
          expectedRevision: input.expectedRevision,
          actualRevision: before.revision,
        })

      const policyJson = JSON.stringify(input.policy)
      const envelope = yield* completeAuditEnvelope({
        occurredAt: input.now,
        scope: 'tenant',
        organizationId: input.context.organizationId,
        actor: { type: 'human', id: input.context.identityId },
        action: 'update-organization-policy',
        target: { type: 'organization-policy', id: input.context.organizationId },
        before: { state: 'captured', summary: before },
        after: { state: 'captured', summary: input.policy },
        operationId: input.operationId,
        request: input.request,
        result: 'succeeded',
        error: { classification: 'none', code: null },
        forced: false,
        breakGlass: false,
      }).pipe(Effect.mapError(() => managementPersistence('policy.management.audit-envelope')))
      const auditId = `audit-${input.operationId}`
      const stage = yield* stageAuditEnvelope('tenant', auditId, envelope, input.now).pipe(
        Effect.mapError(() => managementPersistence('policy.management.audit-stage')),
      )
      const statements = [
        database
          .prepare(updatePolicySql)
          .bind(
            policyJson,
            resultRevision,
            input.context.identityId,
            input.now,
            input.context.organizationId,
            input.expectedRevision,
            input.expectedRevision,
          ),
        database
          .prepare(updateOrganizationRevisionSql)
          .bind(resultRevision, input.context.organizationId, input.expectedRevision),
        database
          .prepare(insertOperationSql)
          .bind(
            input.operationId,
            input.context.organizationId,
            input.context.organizationId,
            input.context.identityId,
            input.operationIdempotencyKey,
            input.context.correlationId,
            1,
            input.now,
            input.now,
            input.context.organizationId,
            resultRevision,
            resultRevision,
            resultRevision,
            policyJson,
          ),
        database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
        database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            VALUES (?, ?, ?, 'update-organization-policy', 'organization-policy', ?,
              'succeeded', ?, ?, ?)`)
          .bind(
            auditId,
            input.context.organizationId,
            input.context.identityId,
            input.context.organizationId,
            input.context.correlationId,
            auditEventSummaryJson(envelope),
            input.now,
          ),
        database
          .prepare(`INSERT INTO core_mutation_receipts
            (organization_id, actor_id, action, idempotency_key, payload_fingerprint,
             operation_id, resource_type, resource_id, result_json, response_json, created_at)
            VALUES (?, ?, 'update-organization-policy', ?, ?, ?, 'organization-policy', ?, ?, ?, ?)`)
          .bind(
            input.context.organizationId,
            input.context.identityId,
            input.idempotencyKey,
            input.requestFingerprint,
            input.operationId,
            input.context.organizationId,
            policyJson,
            JSON.stringify({
              operationId: input.operationId,
              resourceId: input.context.organizationId,
              status: 'succeeded',
              links: {
                operation: `/v1/organizations/${input.context.organizationId}/operations/${input.operationId}`,
              },
            }),
            input.now,
          ),
      ]
      const written = yield* Effect.result(
        managementAttempt('policy.management.put', () => database.batch(statements)),
      )
      if (
        written._tag === 'Failure' ||
        written.success.length !== 6 ||
        written.success.some((result) => result.meta?.changes !== 1)
      ) {
        const concurrentReplay = yield* getReplay(
          database,
          input.context.organizationId,
          input.context.identityId,
          input.idempotencyKey,
          input.expectedRevision,
        )
        if (concurrentReplay !== null)
          return yield* replayOrConflict(
            concurrentReplay,
            input.expectedRevision,
            input.requestFingerprint,
          )
        const current = yield* getManaged(database, input.context.organizationId)
        if (current.revision !== input.expectedRevision)
          return yield* new PolicyManagementConflictError({
            code: 'revision_mismatch',
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          })
        if (written._tag === 'Failure') return yield* written.failure
        return yield* managementPersistence('policy.management.put.batch-fence')
      }
      const after = yield* getManaged(database, input.context.organizationId)
      if (after.revision !== resultRevision || JSON.stringify(after) !== policyJson)
        return yield* managementPersistence('policy.management.put.verify')
      return {
        operationId: input.operationId,
        resourceId: input.context.organizationId,
        value: after,
        replayed: false,
      }
    }),
})

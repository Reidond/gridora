import { Context, Effect, Layer, Schema } from 'effect'
import {
  AuditRequestContext,
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelopeFromRequestContext,
  stageAuditEnvelope,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import { canonicalCommandFingerprint, type ProvisionNodeCommand } from '@gridora/lifecycle-control'
import {
  canonicalReviewedNodeProvision,
  NodeProvisionAcceptanceContract,
  NodeProvisionExecutionReservationContract,
  NodeProvisionExecutionReservationPort,
  NodeProvisionFactsPort,
  NodeProvisionFactsUnavailableError,
  NodeProvisionIdempotencyConflictError,
  NodeProvisionPersistenceError,
  NodeProvisionRepository,
  type AuthoritativeProvisionFacts,
  type NodeProvisionAcceptance,
  type NodeProvisionAtomicInput,
  type NodeProvisionExecutionReservationPortShape,
  type NodeProvisionFactsPortShape,
  type NodeProvisionRepositoryShape,
} from '@gridora/node-provision-control'
import {
  decodeOrganizationPolicy,
  type OrganizationPolicyV1,
  type OrganizationUsage,
} from '@gridora/policy-control'

export interface NodeProvisionD1Result {
  readonly success?: boolean
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface NodeProvisionD1Statement {
  bind(...values: ReadonlyArray<unknown>): NodeProvisionD1Statement
  first(): Promise<unknown>
  all(): Promise<NodeProvisionD1Result>
}
export interface NodeProvisionD1Database {
  prepare(sql: string): NodeProvisionD1Statement
  /** Cloudflare D1 executes the ordered statements as one transaction. */
  batch(
    statements: ReadonlyArray<NodeProvisionD1Statement>,
  ): Promise<ReadonlyArray<NodeProvisionD1Result>>
}

export class NodeProvisionD1Client extends Context.Service<
  NodeProvisionD1Client,
  NodeProvisionD1Database
>()('@gridora/node-provision-d1/NodeProvisionD1Client') {}
export const NodeProvisionD1ClientLayer = (database: NodeProvisionD1Database) =>
  Layer.succeed(NodeProvisionD1Client, database)

export interface NodeProvisionD1Options {
  readonly bootstrapTtlMilliseconds?: number
  /**
   * The edge request evidence is persisted with the immutable acceptance so
   * asynchronous provider work can retain the original provenance.
   */
  readonly auditRequestContext?: AuditRequestContextValue
}

const defaultAuditRequestContext: AuditRequestContextValue = {
  origin: 'internal',
  requestId: 'node-provision-internal',
  correlationId: 'node-provision-internal',
  source: {
    ip: { state: 'not-available', reason: 'internal node provision has no client IP' },
    access: { state: 'not-available', reason: 'internal node provision has no Access assertion' },
  },
}

const failure = (operation: string) => new NodeProvisionPersistenceError({ operation })
const factFailure = (operation: string) => new NodeProvisionFactsUnavailableError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const attemptFacts = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => factFailure(operation) })
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined
const integer = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isSafeInteger(row[key]) ? row[key] : undefined
const parseJson = (
  operation: string,
  value: unknown,
): Effect.Effect<unknown, NodeProvisionPersistenceError> =>
  typeof value !== 'string'
    ? Effect.fail(failure(operation))
    : Effect.try({ try: () => JSON.parse(value) as unknown, catch: () => failure(operation) })

const catalogMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
  contractMonths: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  validUntilEpochMilliseconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
const providerMappings = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))

const candidateSql = `SELECT
 organization.id AS organizationId,
 organization.policy_revision AS organizationPolicyRevision,
 policy.policy_json AS policyJson,
 policy.revision AS policyRevision,
 account.id AS providerAccountId,
 account.revision AS providerAccountRevision,
 account.provider_type AS providerType,
 allocation.revision AS allocationRevision,
 allocation.max_active_nodes AS allocationMaxActiveNodes,
 allocation.monthly_budget_minor AS allocationMonthlyBudgetMinor,
 catalog.region,
 catalog.plan,
 catalog.currency,
 catalog.hourly_price_minor AS hourlyPriceMinor,
 catalog.monthly_price_minor AS monthlyPriceMinor,
 catalog.metadata_json AS catalogMetadataJson,
 catalog.refreshed_at AS catalogRefreshedAt,
 image.id AS imageId,
 image.version AS imageVersion,
 image.checksum AS imageChecksum,
 image.provider_mappings_json AS providerMappingsJson
FROM organizations organization
JOIN organization_policies policy ON policy.organization_id = organization.id
JOIN provider_allocations allocation ON allocation.organization_id = organization.id
JOIN provider_accounts account ON account.id = allocation.provider_account_id
JOIN provider_catalog catalog ON catalog.provider_type = account.provider_type
JOIN node_images image ON image.status = 'promoted'
WHERE organization.id = ?
  AND organization.status = 'active'
  AND organization.policy_revision = policy.revision
  AND allocation.status = 'active'
  AND account.status = 'active'
  AND (account.scope = 'platform' OR account.organization_id = organization.id)
  AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_regions_json) WHERE value = catalog.region)
  AND EXISTS (SELECT 1 FROM json_each(allocation.allowed_plans_json) WHERE value = catalog.plan)
  AND EXISTS (SELECT 1 FROM json_each(policy.policy_json, '$.allowedProviders') WHERE value = account.provider_type)
  AND EXISTS (SELECT 1 FROM json_each(policy.policy_json, '$.allowedRegions') WHERE value = catalog.region)
  AND EXISTS (SELECT 1 FROM json_each(policy.policy_json, '$.allowedPlans') WHERE value = catalog.plan)
  AND json_type(
    image.provider_mappings_json,
    '$."' || account.provider_type || '"."' || catalog.region || '"'
  ) = 'text'
ORDER BY account.id, catalog.region, catalog.plan, image.version DESC, image.id
LIMIT 1`

/**
 * Unlike `candidateSql`, this statement never ranks eligible infrastructure.
 * It accepts every immutable coordinate from a parent-reviewed snapshot and
 * returns a row only when that exact account/allocation/catalog/image binding
 * remains authoritative. The remaining policy and usage values are decoded
 * and compared with the reviewed snapshot below.
 */
const reviewedCandidateSql = `SELECT
 organization.id AS organizationId,
 organization.policy_revision AS organizationPolicyRevision,
 policy.policy_json AS policyJson,
 policy.revision AS policyRevision,
 account.id AS providerAccountId,
 account.revision AS providerAccountRevision,
 account.provider_type AS providerType,
 allocation.revision AS allocationRevision,
 allocation.max_active_nodes AS allocationMaxActiveNodes,
 allocation.monthly_budget_minor AS allocationMonthlyBudgetMinor,
 catalog.region,
 catalog.plan,
 catalog.currency,
 catalog.hourly_price_minor AS hourlyPriceMinor,
 catalog.monthly_price_minor AS monthlyPriceMinor,
 catalog.metadata_json AS catalogMetadataJson,
 catalog.refreshed_at AS catalogRefreshedAt,
 image.id AS imageId,
 image.version AS imageVersion,
 image.checksum AS imageChecksum,
 image.provider_mappings_json AS providerMappingsJson
FROM organizations organization
JOIN organization_policies policy ON policy.organization_id = organization.id
JOIN provider_allocations allocation ON allocation.organization_id = organization.id
JOIN provider_accounts account ON account.id = allocation.provider_account_id
JOIN provider_catalog catalog ON catalog.provider_type = account.provider_type
JOIN node_images image ON image.status = 'promoted'
WHERE organization.id = ?
  AND organization.status = 'active'
  AND organization.policy_revision = policy.revision
  AND allocation.status = 'active'
  AND account.status = 'active'
  AND (account.scope = 'platform' OR account.organization_id = organization.id)
  AND account.id = ?
  AND account.revision = ?
  AND account.provider_type = ?
  AND allocation.revision = ?
  AND allocation.max_active_nodes = ?
  AND allocation.monthly_budget_minor IS ?
  AND catalog.region = ?
  AND catalog.plan = ?
  AND catalog.currency = ?
  AND catalog.refreshed_at = ?
  AND COALESCE(catalog.monthly_price_minor, catalog.hourly_price_minor * 730) = ?
  AND json_extract(catalog.metadata_json, '$.schemaVersion') = 1
  AND json_extract(catalog.metadata_json, '$.billingCadence') = ?
  AND json_extract(catalog.metadata_json, '$.contractMonths') = ?
  AND json_extract(catalog.metadata_json, '$.validUntilEpochMilliseconds') = ?
  AND image.id = ?
  AND image.version = ?
  AND image.checksum = ?
  AND json_extract(
    image.provider_mappings_json,
    '$."' || account.provider_type || '"."' || catalog.region || '"'
  ) = ?
LIMIT 1`

const usageSql = `SELECT
 (SELECT count(*) FROM nodes WHERE organization_id = ?
   AND desired_state <> 'deleted' AND observed_state <> 'deleted') AS activeNodes,
 (SELECT count(*) FROM nodes WHERE organization_id = ? AND placement_mode = 'dedicated'
   AND desired_state <> 'deleted' AND observed_state <> 'deleted') AS dedicatedNodes,
 (SELECT count(*) FROM nodes WHERE organization_id = ? AND provider_account_id = ?
   AND desired_state <> 'deleted' AND observed_state <> 'deleted') AS allocationActiveNodes,
 COALESCE((SELECT sum(estimated_monthly_minor) FROM node_provision_spend_reservations
   WHERE organization_id = ? AND state = 'active' AND currency = ?), 0) AS committedMonthlyMinor,
 (SELECT count(*) FROM node_provision_spend_reservations
   WHERE organization_id = ? AND state = 'active' AND currency <> ?) AS currencyMismatchCount`

const decodeCandidate = (
  organizationId: string,
  value: unknown,
): Effect.Effect<
  Omit<AuthoritativeProvisionFacts, 'usage' | 'allocationActiveNodes'>,
  ReturnType<typeof factFailure>
> =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* factFailure('node-provision.facts.decode-candidate')
    const organizationPolicyRevision = integer(row, 'organizationPolicyRevision')
    const policyRevision = integer(row, 'policyRevision')
    const providerType = text(row, 'providerType')
    const hourly = row.hourlyPriceMinor === null ? null : integer(row, 'hourlyPriceMinor')
    const monthly = row.monthlyPriceMinor === null ? null : integer(row, 'monthlyPriceMinor')
    const allocationMonthlyBudgetMinor =
      row.allocationMonthlyBudgetMinor === null
        ? null
        : integer(row, 'allocationMonthlyBudgetMinor')
    const required = {
      organizationId: text(row, 'organizationId'),
      providerAccountId: text(row, 'providerAccountId'),
      providerAccountRevision: integer(row, 'providerAccountRevision'),
      allocationRevision: integer(row, 'allocationRevision'),
      allocationMaxActiveNodes: integer(row, 'allocationMaxActiveNodes'),
      region: text(row, 'region'),
      plan: text(row, 'plan'),
      currency: text(row, 'currency'),
      catalogRefreshedAt: text(row, 'catalogRefreshedAt'),
      imageId: text(row, 'imageId'),
      imageVersion: text(row, 'imageVersion'),
      imageChecksum: text(row, 'imageChecksum'),
    }
    if (
      Object.values(required).some((entry) => entry === undefined) ||
      required.organizationId !== organizationId ||
      organizationPolicyRevision === undefined ||
      policyRevision === undefined ||
      organizationPolicyRevision !== policyRevision ||
      (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
      allocationMonthlyBudgetMinor === undefined ||
      (monthly === null && hourly === null)
    )
      return yield* factFailure('node-provision.facts.decode-candidate')
    const policyInput = yield* parseJson('node-provision.facts.policy-json', row.policyJson).pipe(
      Effect.mapError(() => factFailure('node-provision.facts.policy-json')),
    )
    const policy = yield* decodeOrganizationPolicy(policyInput).pipe(
      Effect.mapError(() => factFailure('node-provision.facts.policy')),
    )
    const metadataInput = yield* parseJson(
      'node-provision.facts.catalog-metadata-json',
      row.catalogMetadataJson,
    ).pipe(Effect.mapError(() => factFailure('node-provision.facts.catalog-metadata-json')))
    const metadata = yield* Schema.decodeUnknownEffect(catalogMetadata, {
      onExcessProperty: 'error',
    })(metadataInput).pipe(
      Effect.mapError(() => factFailure('node-provision.facts.catalog-metadata')),
    )
    const mappingsInput = yield* parseJson(
      'node-provision.facts.provider-mappings-json',
      row.providerMappingsJson,
    ).pipe(Effect.mapError(() => factFailure('node-provision.facts.provider-mappings-json')))
    const mappings = yield* Schema.decodeUnknownEffect(providerMappings, {
      onExcessProperty: 'error',
    })(mappingsInput).pipe(
      Effect.mapError(() => factFailure('node-provision.facts.provider-mappings')),
    )
    const providerImageId = mappings[providerType]?.[required.region as string]
    const estimatedMonthlyMinor = monthly ?? (hourly as number) * 730
    if (
      providerImageId === undefined ||
      !Number.isSafeInteger(estimatedMonthlyMinor) ||
      !Number.isFinite(Date.parse(required.catalogRefreshedAt as string))
    )
      return yield* factFailure('node-provision.facts.decode-candidate')
    return {
      organizationId,
      providerAccountId: required.providerAccountId as string,
      providerAccountRevision: required.providerAccountRevision as number,
      providerType,
      allocationRevision: required.allocationRevision as number,
      allocationMaxActiveNodes: required.allocationMaxActiveNodes as number,
      allocationMonthlyBudgetMinor,
      region: required.region as string,
      plan: required.plan as string,
      catalogRefreshedAt: required.catalogRefreshedAt as string,
      catalogValidUntilEpochMilliseconds: metadata.validUntilEpochMilliseconds,
      imageId: required.imageId as string,
      imageVersion: required.imageVersion as string,
      imageChecksum: required.imageChecksum as string,
      providerImageId,
      policy: policy as OrganizationPolicyV1,
      price: {
        currency: required.currency as string,
        estimatedMonthlyMinor,
        billingCadence: metadata.billingCadence,
        contractMonths: metadata.contractMonths,
      },
    }
  })

const resolveUsageFacts = (
  database: NodeProvisionD1Database,
  organizationId: string,
  selected: Omit<AuthoritativeProvisionFacts, 'usage' | 'allocationActiveNodes'>,
  nowEpochMilliseconds: () => number,
): Effect.Effect<
  Pick<AuthoritativeProvisionFacts, 'allocationActiveNodes' | 'usage'>,
  NodeProvisionFactsUnavailableError
> =>
  Effect.gen(function* () {
    const usageValue = yield* attemptFacts('node-provision.facts.usage', () =>
      database
        .prepare(usageSql)
        .bind(
          organizationId,
          organizationId,
          organizationId,
          selected.providerAccountId,
          organizationId,
          selected.price.currency,
          organizationId,
          selected.price.currency,
        )
        .first(),
    )
    const row = record(usageValue)
    if (row === undefined) return yield* factFailure('node-provision.facts.usage-decode')
    const activeNodes = integer(row, 'activeNodes')
    const dedicatedNodes = integer(row, 'dedicatedNodes')
    const allocationActiveNodes = integer(row, 'allocationActiveNodes')
    const committed = integer(row, 'committedMonthlyMinor')
    const currencyMismatchCount = integer(row, 'currencyMismatchCount')
    if (
      activeNodes === undefined ||
      dedicatedNodes === undefined ||
      allocationActiveNodes === undefined ||
      committed === undefined ||
      currencyMismatchCount === undefined ||
      currencyMismatchCount !== 0
    )
      return yield* factFailure('node-provision.facts.usage-decode')
    const usage: OrganizationUsage = {
      organizationId,
      observedAtEpochMilliseconds: nowEpochMilliseconds(),
      activeNodes,
      dedicatedNodes,
      serversByNode: {},
      estimatedCommittedMonthlyMinor: committed,
      currency: selected.price.currency,
    }
    return { allocationActiveNodes, usage }
  })

const resolveFacts = (
  database: NodeProvisionD1Database,
  input: {
    readonly organizationId: string
    readonly candidate: () => Promise<NodeProvisionD1Result>
    readonly noCandidateOperation: string
    readonly nowEpochMilliseconds: () => number
  },
): Effect.Effect<AuthoritativeProvisionFacts, NodeProvisionFactsUnavailableError> =>
  Effect.gen(function* () {
    const candidates = yield* attemptFacts('node-provision.facts.candidates', input.candidate)
    const candidate = candidates.results[0]
    if (candidate === undefined) return yield* factFailure(input.noCandidateOperation)
    const selected = yield* decodeCandidate(input.organizationId, candidate)
    const usage = yield* resolveUsageFacts(
      database,
      input.organizationId,
      selected,
      input.nowEpochMilliseconds,
    )
    return { ...selected, ...usage }
  })

export const makeNodeProvisionFactsD1 = (
  database: NodeProvisionD1Database,
  options: { readonly nowEpochMilliseconds?: () => number } = {},
): NodeProvisionFactsPortShape => {
  const nowEpochMilliseconds = options.nowEpochMilliseconds ?? Date.now
  return {
    resolve: ({ organizationId, intent: _intent }) =>
      resolveFacts(database, {
        organizationId,
        candidate: () => database.prepare(candidateSql).bind(organizationId).all(),
        noCandidateOperation: 'node-provision.facts.no-eligible-candidate',
        nowEpochMilliseconds,
      }),
    resolveReviewed: ({ organizationId, intent: _intent, reviewed }) =>
      Effect.gen(function* () {
        const facts = reviewed.facts
        const current = yield* resolveFacts(database, {
          organizationId,
          candidate: () =>
            database
              .prepare(reviewedCandidateSql)
              .bind(
                organizationId,
                facts.providerAccountId,
                facts.providerAccountRevision,
                facts.providerType,
                facts.allocationRevision,
                facts.allocationMaxActiveNodes,
                facts.allocationMonthlyBudgetMinor,
                facts.region,
                facts.plan,
                facts.price.currency,
                facts.catalogRefreshedAt,
                facts.price.estimatedMonthlyMinor,
                facts.price.billingCadence,
                facts.price.contractMonths,
                facts.catalogValidUntilEpochMilliseconds,
                facts.imageId,
                facts.imageVersion,
                facts.imageChecksum,
                facts.providerImageId,
              )
              .all(),
          noCandidateOperation: 'node-provision.reviewed-facts.stale-or-ineligible',
          nowEpochMilliseconds,
        })
        if (
          canonicalReviewedNodeProvision({ facts: current, billing: reviewed.billing }) !==
          canonicalReviewedNodeProvision({ facts, billing: reviewed.billing })
        )
          return yield* factFailure('node-provision.reviewed-facts.drift')
        return current
      }),
  }
}

const replaySql = `SELECT acceptance.receipt_json AS receiptJson,
 acceptance.request_fingerprint AS fingerprint,
 acceptance.node_id AS nodeId,
 acceptance.operation_id AS operationId,
 acceptance.workflow_start_record_id AS workflowStartRecordId,
 start.state AS workflowState, start.attempts, start.last_error AS lastError
FROM node_provision_acceptances acceptance
JOIN lifecycle_workflow_starts start
  ON start.organization_id = acceptance.organization_id
 AND start.operation_id = acceptance.operation_id
WHERE acceptance.organization_id = ? AND acceptance.idempotency_key = ?`

const executionReservationSql = `SELECT
 acceptance.organization_id AS organizationId,
 acceptance.node_id AS nodeId,
 acceptance.operation_id AS operationId,
 acceptance.provider_account_id AS providerAccountId,
 acceptance.provider_account_revision AS providerAccountRevision,
 acceptance.provider_type AS providerType,
 acceptance.region,
 acceptance.plan,
 acceptance.image_id AS imageId,
 acceptance.image_version AS imageVersion,
 acceptance.image_checksum AS imageChecksum,
 acceptance.provider_image_id AS providerImageId,
 acceptance.placement_mode AS placementMode,
 contract.currency,
 contract.estimated_monthly_minor AS estimatedMonthlyMinor,
 contract.billing_cadence AS billingCadence,
 contract.contract_months AS contractMonths,
 contract.non_hourly_commitment_confirmed AS nonHourlyCommitmentConfirmed,
 contract.catalog_refreshed_at AS contractCatalogRefreshedAt,
 token.token_record_id AS bootstrapTokenRecordId,
 token.key_version AS bootstrapKeyVersion,
 token.token_hash AS bootstrapTokenHash,
 token.state AS bootstrapTokenState,
 token.expires_at AS bootstrapExpiresAt,
 start.start_record_id AS workflowStartRecordId,
 start.state AS workflowStartState
FROM node_provision_acceptances acceptance
JOIN provider_accounts account
  ON account.id = acceptance.provider_account_id
 AND account.provider_type = acceptance.provider_type
 AND account.revision = acceptance.provider_account_revision
 AND account.status = 'active'
 AND (account.scope = 'platform' OR account.organization_id = acceptance.organization_id)
JOIN provider_allocations allocation
  ON allocation.organization_id = acceptance.organization_id
 AND allocation.provider_account_id = acceptance.provider_account_id
 AND allocation.revision = acceptance.allocation_revision
 AND allocation.status = 'active'
JOIN nodes node
  ON node.organization_id = acceptance.organization_id
 AND node.id = acceptance.node_id
 AND node.provider_account_id = acceptance.provider_account_id
 AND node.provider_type = acceptance.provider_type
 AND node.region = acceptance.region
 AND node.plan = acceptance.plan
 AND node.image_id = acceptance.image_id
 AND node.pending_lifecycle_operation_id = acceptance.operation_id
JOIN node_bootstrap_token_reservations token
  ON token.organization_id = acceptance.organization_id
 AND token.token_record_id = acceptance.bootstrap_token_record_id
 AND token.node_id = acceptance.node_id
 AND token.operation_id = acceptance.operation_id
JOIN node_provision_contracts contract
  ON contract.organization_id = acceptance.organization_id
 AND contract.node_id = acceptance.node_id
 AND contract.operation_id = acceptance.operation_id
JOIN lifecycle_workflow_starts start
  ON start.organization_id = acceptance.organization_id
 AND start.operation_id = acceptance.operation_id
 AND start.start_record_id = acceptance.workflow_start_record_id
WHERE acceptance.organization_id = ? AND acceptance.operation_id = ?`

export const makeNodeProvisionExecutionReservationD1 = (
  database: NodeProvisionD1Database,
): NodeProvisionExecutionReservationPortShape => ({
  load: (organizationId, operationId) =>
    Effect.gen(function* () {
      const value = yield* attemptFacts('node-provision.execution-reservation.read', () =>
        database.prepare(executionReservationSql).bind(organizationId, operationId).first(),
      )
      const row = record(value)
      if (row === undefined)
        return yield* factFailure('node-provision.execution-reservation.not-found')
      const nonHourlyCommitmentConfirmed = integer(row, 'nonHourlyCommitmentConfirmed')
      if (nonHourlyCommitmentConfirmed !== 0 && nonHourlyCommitmentConfirmed !== 1)
        return yield* factFailure('node-provision.execution-reservation.decode')
      const candidate = {
        organizationId: text(row, 'organizationId'),
        nodeId: text(row, 'nodeId'),
        operationId: text(row, 'operationId'),
        providerAccountId: text(row, 'providerAccountId'),
        providerAccountRevision: integer(row, 'providerAccountRevision'),
        providerType: text(row, 'providerType'),
        region: text(row, 'region'),
        plan: text(row, 'plan'),
        imageId: text(row, 'imageId'),
        imageVersion: text(row, 'imageVersion'),
        imageChecksum: text(row, 'imageChecksum'),
        providerImageId: text(row, 'providerImageId'),
        placementMode: text(row, 'placementMode'),
        billing: {
          currency: text(row, 'currency'),
          estimatedMonthlyMinor: integer(row, 'estimatedMonthlyMinor'),
          billingCadence: text(row, 'billingCadence'),
          contractMonths: integer(row, 'contractMonths'),
          nonHourlyCommitmentConfirmed: nonHourlyCommitmentConfirmed === 1,
          catalogRefreshedAt: text(row, 'contractCatalogRefreshedAt'),
        },
        bootstrapToken: {
          recordId: text(row, 'bootstrapTokenRecordId'),
          keyVersion: integer(row, 'bootstrapKeyVersion'),
          tokenHash: text(row, 'bootstrapTokenHash'),
          state: text(row, 'bootstrapTokenState'),
          expiresAt: text(row, 'bootstrapExpiresAt'),
        },
        workflowStart: {
          id: text(row, 'workflowStartRecordId'),
          state: text(row, 'workflowStartState'),
        },
      }
      return yield* Schema.decodeUnknownEffect(NodeProvisionExecutionReservationContract, {
        onExcessProperty: 'error',
      })(candidate).pipe(
        Effect.mapError(() => factFailure('node-provision.execution-reservation.decode')),
      )
    }),
})

const decodeReplay = (
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
  value: unknown,
  disposition: 'created' | 'adopted',
) =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* failure('node-provision.replay.decode')
    const storedFingerprint = text(row, 'fingerprint')
    if (storedFingerprint !== fingerprint)
      return yield* new NodeProvisionIdempotencyConflictError({ idempotencyKey })
    const parsed = yield* parseJson('node-provision.replay.receipt-json', row.receiptJson)
    const decoded = yield* Schema.decodeUnknownEffect(NodeProvisionAcceptanceContract, {
      onExcessProperty: 'error',
    })(parsed).pipe(Effect.mapError(() => failure('node-provision.replay.receipt-decode')))
    const workflowState = text(row, 'workflowState')
    const attempts = integer(row, 'attempts')
    const lastError = row.lastError === null ? null : text(row, 'lastError')
    if (
      decoded.organizationId !== organizationId ||
      decoded.idempotencyKey !== idempotencyKey ||
      decoded.fingerprint !== fingerprint ||
      decoded.nodeId !== text(row, 'nodeId') ||
      decoded.operationId !== text(row, 'operationId') ||
      decoded.workflowStart.id !== text(row, 'workflowStartRecordId') ||
      (workflowState !== 'pending' && workflowState !== 'started') ||
      attempts === undefined ||
      (row.lastError !== null && lastError === undefined)
    )
      return yield* failure('node-provision.replay.binding-mismatch')
    return {
      ...decoded,
      disposition,
      workflowStart: { ...decoded.workflowStart, state: workflowState, attempts, lastError },
    } as NodeProvisionAcceptance
  })

const changesExactlyOne = (result: NodeProvisionD1Result): boolean =>
  result.success !== false && result.meta?.changes === 1

const acceptanceAuditOperationId = (operationId: string) => `${operationId}-accepted`

const stageAcceptanceAudit = (
  database: NodeProvisionD1Database,
  input: NodeProvisionAtomicInput,
  request: AuditRequestContextValue,
): Effect.Effect<
  { readonly statement: NodeProvisionD1Statement; readonly summaryJson: string },
  NodeProvisionPersistenceError
> =>
  Effect.gen(function* () {
    const after = {
      operationId: input.identity.operationId,
      providerType: input.facts.providerType,
      policyRevision: input.facts.policy.revision,
      estimatedMonthlyMinor: input.billing.estimatedMonthlyMinor,
      currency: input.billing.currency,
      desiredState: 'provisioning',
      desiredRevision: 2,
    }
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.command.organizationId,
      actor: { type: 'human', id: input.command.actorId },
      action: 'node.provision.accepted',
      target: { type: 'node', id: input.identity.nodeId },
      before: { state: 'absent', reason: 'node did not exist before provision acceptance' },
      after: { state: 'captured', summary: after },
      operationId: acceptanceAuditOperationId(input.identity.operationId),
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.provideService(AuditRequestContext, {
        ...request,
        correlationId: input.command.correlationId,
      }),
      Effect.mapError(() => failure('node-provision.accept.audit-envelope')),
    )
    const stage = yield* stageAuditEnvelope(
      'tenant',
      input.identity.auditEventId,
      envelope,
      input.now,
    ).pipe(Effect.mapError(() => failure('node-provision.accept.audit-stage')))
    return {
      statement: database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

export const makeNodeProvisionRepositoryD1 = (
  database: NodeProvisionD1Database,
  options: NodeProvisionD1Options = {},
): NodeProvisionRepositoryShape => {
  const findReplay: NodeProvisionRepositoryShape['findReplay'] = (
    organizationId,
    idempotencyKey,
    fingerprint,
  ) =>
    Effect.gen(function* () {
      const value = yield* attempt('node-provision.replay.read', () =>
        database.prepare(replaySql).bind(organizationId, idempotencyKey).first(),
      )
      return value === null || value === undefined
        ? null
        : yield* decodeReplay(organizationId, idempotencyKey, fingerprint, value, 'adopted')
    })

  const acceptAtomic: NodeProvisionRepositoryShape['acceptAtomic'] = (input) =>
    Effect.gen(function* () {
      const replay = yield* findReplay(
        input.command.organizationId,
        input.command.idempotencyKey,
        input.fingerprint,
      )
      if (replay !== null) return replay
      const command: ProvisionNodeCommand = {
        kind: 'provision-node',
        organizationId: input.command.organizationId,
        actorId: input.command.actorId,
        resourceId: input.identity.nodeId,
        idempotencyKey: input.command.idempotencyKey,
        expectedDesiredRevision: 1,
        correlationId: input.command.correlationId,
      }
      // This immutable fact is intentionally present only in the internal
      // reservation evidence. The public provision command never chooses a
      // retirement operation or scheduler identity.
      const reservationCommand = {
        ...command,
        temporaryLifetimeHours: input.command.intent.temporaryLifetimeHours,
      }
      const reservation = {
        organizationId: input.command.organizationId,
        resourceKind: 'node' as const,
        resourceId: input.identity.nodeId,
        action: 'provision-node' as const,
        previousRevision: 1,
        desiredRevision: 2,
        desiredState: 'provisioning' as const,
      }
      const receipt: NodeProvisionAcceptance = {
        disposition: 'created',
        organizationId: input.command.organizationId,
        nodeId: input.identity.nodeId,
        operationId: input.identity.operationId,
        idempotencyKey: input.command.idempotencyKey,
        fingerprint: input.fingerprint,
        providerType: input.facts.providerType,
        placementMode: input.command.intent.placementMode,
        billing: input.billing,
        workflowStart: {
          id: input.identity.workflowStartRecordId,
          state: 'pending',
          attempts: 0,
          lastError: null,
        },
      }
      yield* Schema.decodeUnknownEffect(NodeProvisionAcceptanceContract, {
        onExcessProperty: 'error',
      })(receipt).pipe(Effect.mapError(() => failure('node-provision.accept.invalid-receipt')))
      const acceptedAt = Date.parse(input.now)
      const bootstrapTtlMilliseconds = options.bootstrapTtlMilliseconds ?? 15 * 60_000
      if (
        !Number.isFinite(acceptedAt) ||
        new Date(acceptedAt).toISOString() !== input.now ||
        !Number.isSafeInteger(bootstrapTtlMilliseconds) ||
        bootstrapTtlMilliseconds < 60_000 ||
        bootstrapTtlMilliseconds > 24 * 60 * 60_000 ||
        input.facts.organizationId !== input.command.organizationId ||
        input.facts.policy.organizationId !== input.command.organizationId ||
        input.facts.usage.organizationId !== input.command.organizationId ||
        input.billing.providerType !== input.facts.providerType ||
        input.billing.currency !== input.facts.price.currency ||
        input.billing.estimatedMonthlyMinor !== input.facts.price.estimatedMonthlyMinor ||
        input.billing.billingCadence !== input.facts.price.billingCadence ||
        input.billing.contractMonths !== input.facts.price.contractMonths
      )
        return yield* failure('node-provision.accept.invalid-input')
      const expiresAt = new Date(acceptedAt + bootstrapTtlMilliseconds).toISOString()
      const temporaryLifetimeHours = input.command.intent.temporaryLifetimeHours
      const temporaryExpiresAt =
        temporaryLifetimeHours === null
          ? null
          : new Date(acceptedAt + temporaryLifetimeHours * 60 * 60_000).toISOString()
      if (
        temporaryLifetimeHours !== null &&
        (!Number.isSafeInteger(temporaryLifetimeHours) ||
          temporaryLifetimeHours < 1 ||
          temporaryExpiresAt === null ||
          !Number.isFinite(Date.parse(temporaryExpiresAt)))
      )
        return yield* failure('node-provision.accept.invalid-temporary-expiry')
      const org = input.command.organizationId
      const operation = input.identity.operationId
      const auditRequestContext = {
        ...(options.auditRequestContext ?? defaultAuditRequestContext),
        correlationId: input.command.correlationId,
      }
      const auditRequestContextJson = JSON.stringify(auditRequestContext)
      const audit = yield* stageAcceptanceAudit(database, input, auditRequestContext)
      const statements = [
        database
          .prepare(`INSERT INTO nodes
          (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
           plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
           observed_revision, reconciliation_error, last_reconciled_at, temporary_expires_at, created_at, updated_at,
           pending_lifecycle_operation_id)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'provisioning', 'unknown', 2, 0,
           NULL, NULL, ?, ?, ?, ?)`)
          .bind(
            org,
            input.identity.nodeId,
            input.facts.providerAccountId,
            input.facts.providerType,
            input.facts.region,
            input.facts.plan,
            input.facts.imageId,
            input.command.intent.placementMode,
            temporaryExpiresAt,
            input.now,
            input.now,
            operation,
          ),
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'provision-node', 'node', ?, ?, 'queued', 0, ?, ?, 1, ?, ?)`)
          .bind(
            operation,
            org,
            input.identity.nodeId,
            input.command.actorId,
            input.command.idempotencyKey,
            input.command.correlationId,
            input.now,
            input.now,
          ),
        // This is the terminal completed fact being audited; the parent
        // provisioning operation remains queued for the provider Workflow.
        database
          .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, 'node.provision.accepted', 'node', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
          .bind(
            acceptanceAuditOperationId(operation),
            org,
            input.identity.nodeId,
            input.command.actorId,
            `node-provision-accepted:${operation}`,
            input.command.correlationId,
            input.now,
            input.now,
          ),
        database
          .prepare(`INSERT INTO lifecycle_workflow_starts
          (organization_id, operation_id, start_record_id, state, attempts, last_error, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`)
          .bind(org, operation, input.identity.workflowStartRecordId, input.now, input.now),
        database
          .prepare(`INSERT INTO lifecycle_reservations
          (organization_id, idempotency_key, fingerprint, operation_id, resource_kind,
           resource_id, command_json, reservation_json, created_at)
          VALUES (?, ?, ?, ?, 'node', ?, ?, ?, ?)`)
          .bind(
            org,
            input.command.idempotencyKey,
            canonicalCommandFingerprint(reservationCommand),
            operation,
            input.identity.nodeId,
            JSON.stringify(reservationCommand),
            JSON.stringify(reservation),
            input.now,
          ),
        database
          .prepare(`INSERT INTO node_provision_contracts
          (organization_id, node_id, operation_id, provider_type, currency,
           estimated_monthly_minor, billing_cadence, contract_months,
           non_hourly_commitment_confirmed, catalog_refreshed_at, accepted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            org,
            input.identity.nodeId,
            operation,
            input.facts.providerType,
            input.billing.currency,
            input.billing.estimatedMonthlyMinor,
            input.billing.billingCadence,
            input.billing.contractMonths,
            input.command.intent.nonHourlyCommitmentConfirmed ? 1 : 0,
            input.facts.catalogRefreshedAt,
            input.now,
          ),
        database
          .prepare(`INSERT INTO node_provision_spend_reservations
          (organization_id, node_id, operation_id, currency, estimated_monthly_minor,
           state, revision, reserved_at, released_at)
          VALUES (?, ?, ?, ?, ?, 'active', 1, ?, NULL)`)
          .bind(
            org,
            input.identity.nodeId,
            operation,
            input.billing.currency,
            input.billing.estimatedMonthlyMinor,
            input.now,
          ),
        database
          .prepare(`INSERT INTO node_bootstrap_token_reservations
          (organization_id, token_record_id, node_id, operation_id, key_version, token_hash,
           state, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
          .bind(
            org,
            input.identity.bootstrapTokenRecordId,
            input.identity.nodeId,
            operation,
            input.bootstrapToken.keyVersion,
            input.bootstrapToken.tokenHash,
            expiresAt,
            input.now,
            input.now,
          ),
        audit.statement,
        database
          .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, 'node.provision.accepted', 'node', ?, 'succeeded', ?, ?, ?)`)
          .bind(
            input.identity.auditEventId,
            org,
            input.command.actorId,
            input.identity.nodeId,
            input.command.correlationId,
            audit.summaryJson,
            input.now,
          ),
        database
          .prepare(`INSERT INTO outbox
          (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
           publish_state, retry_count, available_at, created_at)
          VALUES (?, ?, 'lifecycle.workflow-start.requested', 'operation', ?, ?,
           'pending', 0, ?, ?)`)
          .bind(
            input.identity.outboxEventId,
            org,
            operation,
            JSON.stringify({
              operationId: operation,
              workflowStartRecordId: input.identity.workflowStartRecordId,
              resourceKind: 'node',
              resourceId: input.identity.nodeId,
              action: 'provision-node',
            }),
            input.now,
            input.now,
          ),
        database
          .prepare(`INSERT INTO node_provision_acceptances
          (organization_id, idempotency_key, request_fingerprint, node_id, operation_id,
           workflow_start_record_id, audit_event_id, outbox_event_id,
           bootstrap_token_record_id, bootstrap_key_version, provider_account_id,
           provider_account_revision, provider_type, allocation_revision,
           allocation_max_active_nodes, allocation_monthly_budget_minor,
           allocation_active_nodes_before, region, plan,
           catalog_refreshed_at, catalog_valid_until_epoch_ms, image_id, image_version,
           image_checksum, provider_image_id, placement_mode, policy_revision, active_nodes_before,
           dedicated_nodes_before, currency, estimated_monthly_minor, billing_cadence,
           contract_months, committed_monthly_before_minor, projected_committed_monthly_minor,
           temporary_lifetime_hours, temporary_expires_at, receipt_json, audit_request_context_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            org,
            input.command.idempotencyKey,
            input.fingerprint,
            input.identity.nodeId,
            operation,
            input.identity.workflowStartRecordId,
            input.identity.auditEventId,
            input.identity.outboxEventId,
            input.identity.bootstrapTokenRecordId,
            input.bootstrapToken.keyVersion,
            input.facts.providerAccountId,
            input.facts.providerAccountRevision,
            input.facts.providerType,
            input.facts.allocationRevision,
            input.facts.allocationMaxActiveNodes,
            input.facts.allocationMonthlyBudgetMinor,
            input.facts.allocationActiveNodes,
            input.facts.region,
            input.facts.plan,
            input.facts.catalogRefreshedAt,
            input.facts.catalogValidUntilEpochMilliseconds,
            input.facts.imageId,
            input.facts.imageVersion,
            input.facts.imageChecksum,
            input.facts.providerImageId,
            input.command.intent.placementMode,
            input.facts.policy.revision,
            input.facts.usage.activeNodes,
            input.facts.usage.dedicatedNodes,
            input.billing.currency,
            input.billing.estimatedMonthlyMinor,
            input.billing.billingCadence,
            input.billing.contractMonths,
            input.billing.committedMonthlyBeforeMinor,
            input.billing.projectedCommittedMonthlyMinor,
            temporaryLifetimeHours,
            temporaryExpiresAt,
            JSON.stringify(receipt),
            auditRequestContextJson,
            input.now,
          ),
      ]
      const committed = yield* Effect.result(
        attempt('node-provision.accept.atomic', () => database.batch(statements)),
      )
      if (committed._tag === 'Failure') {
        const adopted = yield* findReplay(org, input.command.idempotencyKey, input.fingerprint)
        if (adopted !== null) return adopted
        return yield* committed.failure
      }
      if (
        committed.success.length !== statements.length ||
        committed.success.some((result: NodeProvisionD1Result) => !changesExactlyOne(result))
      )
        return yield* failure('node-provision.accept.atomic-changes')
      return receipt
    })

  const updateWorkflow = (
    organizationId: string,
    operationId: string,
    mode: 'started' | 'failure',
    message?: string,
  ) =>
    Effect.gen(function* () {
      const sql =
        mode === 'started'
          ? `UPDATE lifecycle_workflow_starts SET state = 'started', attempts = attempts + 1,
           last_error = NULL, updated_at = ?
           WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`
          : `UPDATE lifecycle_workflow_starts SET attempts = attempts + 1, last_error = ?, updated_at = ?
           WHERE organization_id = ? AND operation_id = ? AND state = 'pending'`
      const now = new Date().toISOString()
      const statement =
        mode === 'started'
          ? database.prepare(sql).bind(now, organizationId, operationId)
          : database
              .prepare(sql)
              .bind(message ?? 'workflow start failed', now, organizationId, operationId)
      const result = yield* attempt(`node-provision.workflow.${mode}`, () => statement.all())
      if (!changesExactlyOne(result))
        return yield* failure(`node-provision.workflow.${mode}-not-pending`)
    })

  return {
    findReplay,
    acceptAtomic,
    markWorkflowStarted: (organizationId, operationId) =>
      updateWorkflow(organizationId, operationId, 'started'),
    recordWorkflowStartFailure: (organizationId, operationId, _message) =>
      updateWorkflow(organizationId, operationId, 'failure', 'workflow-start-failed'),
  }
}

export const NodeProvisionFactsD1Live = Layer.effect(
  NodeProvisionFactsPort,
  Effect.gen(function* () {
    const database = yield* NodeProvisionD1Client
    return NodeProvisionFactsPort.of(makeNodeProvisionFactsD1(database))
  }),
)
export const NodeProvisionRepositoryD1Live = Layer.effect(
  NodeProvisionRepository,
  Effect.gen(function* () {
    const database = yield* NodeProvisionD1Client
    return NodeProvisionRepository.of(makeNodeProvisionRepositoryD1(database))
  }),
)
export const NodeProvisionExecutionReservationD1Live = Layer.effect(
  NodeProvisionExecutionReservationPort,
  Effect.gen(function* () {
    const database = yield* NodeProvisionD1Client
    return NodeProvisionExecutionReservationPort.of(
      makeNodeProvisionExecutionReservationD1(database),
    )
  }),
)

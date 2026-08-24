import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const ProviderName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
)
const RegionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const PlanName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const EpochMilliseconds = NonNegativeInt
const MinuteOfDay = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_439 }))
const DurationMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 }))

export const MaintenanceWindow = Schema.Struct({
  dayOfWeekUtc: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  startMinuteUtc: MinuteOfDay,
  durationMinutes: DurationMinutes,
})

export const OrganizationPolicyV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: Identifier,
  revision: PositiveInt,
  allowedProviders: Schema.Array(ProviderName),
  allowedRegions: Schema.Array(RegionName),
  allowedPlans: Schema.Array(PlanName),
  capacity: Schema.Struct({
    maxActiveNodes: NonNegativeInt,
    maxDedicatedNodes: NonNegativeInt,
    maxServersPerNode: NonNegativeInt,
    maxDeploymentCpuMillis: NonNegativeInt,
    maxDeploymentRamBytes: NonNegativeInt,
    maxDeploymentDiskBytes: NonNegativeInt,
  }),
  monthlyBudget: Schema.Struct({
    currency: Schema.NullOr(Currency),
    setupWarningMinor: Schema.NullOr(NonNegativeInt),
    softLimitMinor: NonNegativeInt,
    hardLimitMinor: NonNegativeInt,
  }),
  temporaryNodes: Schema.Struct({
    automaticExpiryRequired: Schema.Boolean,
    maxLifetimeHours: PositiveInt,
  }),
  idle: Schema.Struct({
    action: Schema.Literals(['none', 'shutdown', 'delete']),
    afterMinutes: PositiveInt,
  }),
  backups: Schema.Struct({
    requiredBeforeDelete: Schema.Boolean,
  }),
  maintenanceWindows: Schema.Array(MaintenanceWindow),
  updates: Schema.Struct({
    automatic: Schema.Literals(['disabled', 'security', 'all']),
    requireMaintenanceWindow: Schema.Boolean,
  }),
  contabo: Schema.Struct({
    maxContractMonths: PositiveInt,
  }),
  nonHourlyCommitment: Schema.Struct({
    explicitConfirmationRequired: Schema.Boolean,
  }),
})
export type OrganizationPolicyV1 = typeof OrganizationPolicyV1.Type

export class PolicyValidationError extends Schema.TaggedError<PolicyValidationError>()(
  'PolicyValidationError',
  { code: Schema.String, message: Schema.String },
) {}

const hasDuplicates = (values: ReadonlyArray<string>) => new Set(values).size !== values.length

const validateSemantics = (
  policy: OrganizationPolicyV1,
): Effect.Effect<OrganizationPolicyV1, PolicyValidationError> => {
  if (policy.monthlyBudget.softLimitMinor > policy.monthlyBudget.hardLimitMinor) {
    return Effect.fail(
      new PolicyValidationError({
        code: 'soft_budget_exceeds_hard_budget',
        message: 'Monthly soft budget must not exceed the hard budget',
      }),
    )
  }
  if (policy.monthlyBudget.setupWarningMinor !== null && policy.monthlyBudget.currency === null) {
    return Effect.fail(
      new PolicyValidationError({
        code: 'setup_warning_currency_required',
        message: 'A setup budget warning requires an explicit currency',
      }),
    )
  }
  if (
    policy.updates.automatic !== 'disabled' &&
    policy.updates.requireMaintenanceWindow &&
    policy.maintenanceWindows.length === 0
  ) {
    return Effect.fail(
      new PolicyValidationError({
        code: 'automatic_update_requires_maintenance_window',
        message: 'Automatic updates requiring a maintenance window need at least one window',
      }),
    )
  }
  for (const [name, values] of [
    ['allowedProviders', policy.allowedProviders],
    ['allowedRegions', policy.allowedRegions],
    ['allowedPlans', policy.allowedPlans],
  ] as const) {
    if (hasDuplicates(values)) {
      return Effect.fail(
        new PolicyValidationError({
          code: 'duplicate_allow_list_value',
          message: `${name} must not contain duplicates`,
        }),
      )
    }
  }
  return Effect.succeed(policy)
}

export const decodeOrganizationPolicy = (input: unknown) =>
  Schema.decodeUnknownEffect(OrganizationPolicyV1, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new PolicyValidationError({
          code: 'invalid_policy_schema',
          message: 'Policy does not conform to schema version 1',
        }),
    ),
    Effect.flatMap(validateSemantics),
  )

export const DeploymentResources = Schema.Struct({
  cpuMillis: PositiveInt,
  ramBytes: PositiveInt,
  diskBytes: PositiveInt,
})
export type DeploymentResources = typeof DeploymentResources.Type

export const AdmissionRequest = Schema.Struct({
  organizationId: Identifier,
  action: Schema.Literals([
    'provision-node',
    'deploy-server',
    'move-server',
    'delete-node',
    'delete-server',
    'update-server',
    'other',
  ]),
  provider: Schema.NullOr(ProviderName),
  region: Schema.NullOr(RegionName),
  plan: Schema.NullOr(PlanName),
  dedicatedNode: Schema.Boolean,
  targetNodeId: Schema.NullOr(Identifier),
  resources: Schema.NullOr(DeploymentResources),
  temporaryNodeLifetimeHours: Schema.NullOr(PositiveInt),
  destructiveBackup: Schema.Literals(['not-applicable', 'verified', 'skip-authorized', 'missing']),
  nonHourlyCommitmentConfirmed: Schema.Boolean,
  updateContext: Schema.Struct({
    mode: Schema.Literals(['not-applicable', 'manual', 'automatic']),
    category: Schema.Literals(['not-applicable', 'security', 'feature']),
  }),
})
export type AdmissionRequest = typeof AdmissionRequest.Type

export const OrganizationUsage = Schema.Struct({
  organizationId: Identifier,
  observedAtEpochMilliseconds: EpochMilliseconds,
  activeNodes: NonNegativeInt,
  dedicatedNodes: NonNegativeInt,
  serversByNode: Schema.Record(Identifier, NonNegativeInt),
  estimatedCommittedMonthlyMinor: NonNegativeInt,
  currency: Currency,
})
export type OrganizationUsage = typeof OrganizationUsage.Type

export const PriceEstimate = Schema.Union([
  Schema.Struct({ status: Schema.Literal('unknown') }),
  Schema.Struct({
    status: Schema.Literal('known'),
    provider: ProviderName,
    region: RegionName,
    plan: PlanName,
    currency: Currency,
    estimatedMonthlyMinor: NonNegativeInt,
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: PositiveInt,
    observedAtEpochMilliseconds: EpochMilliseconds,
    validUntilEpochMilliseconds: EpochMilliseconds,
  }),
])
export type PriceEstimate = typeof PriceEstimate.Type

const strictDecode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(input)

export const decodeAdmissionRequest = (input: unknown) => strictDecode(AdmissionRequest, input)
export const decodeOrganizationUsage = (input: unknown) => strictDecode(OrganizationUsage, input)
export const decodePriceEstimate = (input: unknown) => strictDecode(PriceEstimate, input)

export interface AdmissionInput {
  readonly policy: OrganizationPolicyV1
  readonly request: AdmissionRequest
  readonly usage: OrganizationUsage
  readonly price: PriceEstimate
  readonly nowEpochMilliseconds: number
}

export type PolicyViolationCode =
  | 'policy_tenant_mismatch'
  | 'usage_tenant_mismatch'
  | 'usage_currency_mismatch'
  | 'budget_currency_unconfigured'
  | 'provider_not_allowed'
  | 'region_not_allowed'
  | 'plan_not_allowed'
  | 'active_node_limit'
  | 'dedicated_node_limit'
  | 'servers_per_node_limit'
  | 'deployment_cpu_limit'
  | 'deployment_ram_limit'
  | 'deployment_disk_limit'
  | 'temporary_expiry_required'
  | 'temporary_lifetime_limit'
  | 'backup_required_before_delete'
  | 'price_unknown'
  | 'price_stale'
  | 'price_scope_mismatch'
  | 'price_currency_mismatch'
  | 'hard_budget_exceeded'
  | 'contabo_contract_too_long'
  | 'non_hourly_confirmation_required'
  | 'update_context_invalid'
  | 'automatic_updates_disabled'
  | 'automatic_update_category_not_allowed'
  | 'outside_maintenance_window'

export type PolicyWarningCode = 'soft_budget_exceeded'

export interface PolicyViolation {
  readonly code: PolicyViolationCode
  readonly message: string
}
export interface PolicyWarning {
  readonly code: PolicyWarningCode
  readonly message: string
  readonly projectedEstimatedMonthlyMinor: number
  readonly currency: string
}
export type PolicyDecision =
  | { readonly outcome: 'allow'; readonly warnings: readonly [] }
  | { readonly outcome: 'warn'; readonly warnings: readonly PolicyWarning[] }
  | {
      readonly outcome: 'deny'
      readonly violations: readonly PolicyViolation[]
      readonly warnings: readonly PolicyWarning[]
    }

const needsPrice = (request: AdmissionRequest) => request.action === 'provision-node'
const createsNode = (request: AdmissionRequest) => request.action === 'provision-node'
const placesServer = (request: AdmissionRequest) =>
  request.action === 'deploy-server' || request.action === 'move-server'

const isInsideMaintenanceWindow = (
  windows: OrganizationPolicyV1['maintenanceWindows'],
  nowEpochMilliseconds: number,
) => {
  const date = new Date(nowEpochMilliseconds)
  if (!Number.isFinite(date.getTime())) return false
  const minuteOfWeek = date.getUTCDay() * 1_440 + date.getUTCHours() * 60 + date.getUTCMinutes()
  const weekMinutes = 7 * 1_440
  return windows.some((window) => {
    const start = window.dayOfWeekUtc * 1_440 + window.startMinuteUtc
    const elapsed = (minuteOfWeek - start + weekMinutes) % weekMinutes
    return elapsed < window.durationMinutes
  })
}

/** Pure, deterministic FR-19 decision. Inputs must already be decoded at their trust boundaries. */
export const evaluatePolicyAdmission = (input: AdmissionInput): PolicyDecision => {
  const { policy, request, usage, price, nowEpochMilliseconds: now } = input
  const violations: PolicyViolation[] = []
  const warnings: PolicyWarning[] = []
  const deny = (code: PolicyViolationCode, message: string) => violations.push({ code, message })

  if (policy.organizationId !== request.organizationId)
    deny('policy_tenant_mismatch', 'Policy does not belong to the requested organization')
  if (usage.organizationId !== request.organizationId)
    deny('usage_tenant_mismatch', 'Usage does not belong to the requested organization')
  if (policy.monthlyBudget.currency === null)
    deny('budget_currency_unconfigured', 'Organization budget currency is not configured')
  else if (usage.currency !== policy.monthlyBudget.currency)
    deny('usage_currency_mismatch', 'Usage currency differs from the organization budget currency')

  if (request.provider !== null && !policy.allowedProviders.includes(request.provider))
    deny('provider_not_allowed', 'Provider is not allowed by organization policy')
  if (request.region !== null && !policy.allowedRegions.includes(request.region))
    deny('region_not_allowed', 'Region is not allowed by organization policy')
  if (request.plan !== null && !policy.allowedPlans.includes(request.plan))
    deny('plan_not_allowed', 'Plan is not allowed by organization policy')

  if (createsNode(request) && usage.activeNodes + 1 > policy.capacity.maxActiveNodes)
    deny('active_node_limit', 'Maximum active node count would be exceeded')
  if (
    createsNode(request) &&
    request.dedicatedNode &&
    usage.dedicatedNodes + 1 > policy.capacity.maxDedicatedNodes
  )
    deny('dedicated_node_limit', 'Maximum dedicated node count would be exceeded')
  if (placesServer(request) && request.targetNodeId !== null) {
    const existing = usage.serversByNode[request.targetNodeId]
    if (existing === undefined)
      deny('usage_tenant_mismatch', 'Target node is absent from the tenant-scoped usage snapshot')
    else if (existing + 1 > policy.capacity.maxServersPerNode)
      deny('servers_per_node_limit', 'Maximum servers per node would be exceeded')
  }

  if (request.resources !== null) {
    if (request.resources.cpuMillis > policy.capacity.maxDeploymentCpuMillis)
      deny('deployment_cpu_limit', 'Deployment CPU limit would be exceeded')
    if (request.resources.ramBytes > policy.capacity.maxDeploymentRamBytes)
      deny('deployment_ram_limit', 'Deployment RAM limit would be exceeded')
    if (request.resources.diskBytes > policy.capacity.maxDeploymentDiskBytes)
      deny('deployment_disk_limit', 'Deployment disk limit would be exceeded')
  }

  if (createsNode(request) && policy.temporaryNodes.automaticExpiryRequired) {
    if (request.temporaryNodeLifetimeHours === null)
      deny('temporary_expiry_required', 'Temporary node expiry is required')
    else if (request.temporaryNodeLifetimeHours > policy.temporaryNodes.maxLifetimeHours)
      deny('temporary_lifetime_limit', 'Temporary node lifetime exceeds organization policy')
  }

  if (
    (request.action === 'delete-node' || request.action === 'delete-server') &&
    policy.backups.requiredBeforeDelete &&
    request.destructiveBackup !== 'verified'
  )
    deny('backup_required_before_delete', 'A verified backup is required before deletion')

  if (
    request.action === 'update-server' &&
    (request.updateContext.mode === 'not-applicable' ||
      request.updateContext.category === 'not-applicable')
  )
    deny('update_context_invalid', 'Server updates require an explicit manual or automatic context')
  if (
    request.action !== 'update-server' &&
    (request.updateContext.mode !== 'not-applicable' ||
      request.updateContext.category !== 'not-applicable')
  )
    deny('update_context_invalid', 'Update context is only valid for a server update')
  if (request.updateContext.mode === 'automatic') {
    if (policy.updates.automatic === 'disabled')
      deny('automatic_updates_disabled', 'Automatic updates are disabled by organization policy')
    else if (
      policy.updates.automatic === 'security' &&
      request.updateContext.category !== 'security'
    )
      deny(
        'automatic_update_category_not_allowed',
        'Only automatic security updates are allowed by organization policy',
      )
    else if (
      policy.updates.requireMaintenanceWindow &&
      !isInsideMaintenanceWindow(policy.maintenanceWindows, now)
    )
      deny(
        'outside_maintenance_window',
        'Automatic update is outside an allowed maintenance window',
      )
  }

  if (needsPrice(request)) {
    if (price.status === 'unknown') {
      deny('price_unknown', 'A current provider price estimate is required')
    } else {
      if (price.validUntilEpochMilliseconds <= now)
        deny('price_stale', 'Provider price estimate is stale')
      if (
        request.provider !== price.provider ||
        request.region !== price.region ||
        request.plan !== price.plan
      )
        deny('price_scope_mismatch', 'Provider price estimate does not match the request')
      if (
        policy.monthlyBudget.currency === null ||
        price.currency !== policy.monthlyBudget.currency
      )
        deny('price_currency_mismatch', 'Provider price estimate currency differs from the budget')
      if (price.provider === 'contabo' && price.contractMonths > policy.contabo.maxContractMonths)
        deny('contabo_contract_too_long', 'Contabo contract period exceeds organization policy')
      if (
        price.billingCadence !== 'hourly' &&
        policy.nonHourlyCommitment.explicitConfirmationRequired &&
        !request.nonHourlyCommitmentConfirmed
      )
        deny(
          'non_hourly_confirmation_required',
          'Explicit non-hourly commitment confirmation is required',
        )

      if (
        policy.monthlyBudget.currency !== null &&
        price.currency === usage.currency &&
        price.currency === policy.monthlyBudget.currency
      ) {
        const projected = usage.estimatedCommittedMonthlyMinor + price.estimatedMonthlyMinor
        if (!Number.isSafeInteger(projected)) {
          deny(
            'hard_budget_exceeded',
            'Projected estimated monthly spend is outside safe integer range',
          )
        } else {
          if (projected > policy.monthlyBudget.hardLimitMinor)
            deny(
              'hard_budget_exceeded',
              'Projected estimated monthly spend exceeds the hard budget',
            )
          if (projected > policy.monthlyBudget.softLimitMinor)
            warnings.push({
              code: 'soft_budget_exceeded',
              message: 'Projected estimated monthly spend exceeds the soft budget',
              projectedEstimatedMonthlyMinor: projected,
              currency: price.currency,
            })
        }
      }
    }
  }

  if (violations.length > 0) return { outcome: 'deny', violations, warnings }
  if (warnings.length > 0) return { outcome: 'warn', warnings }
  return { outcome: 'allow', warnings: [] }
}

export interface IdleDecisionInput {
  readonly policy: OrganizationPolicyV1
  readonly nowEpochMilliseconds: number
  readonly lastActivityEpochMilliseconds: number
}
export type IdleDecision =
  | { readonly action: 'none'; readonly reason: 'disabled' | 'not-idle' | 'invalid-clock' }
  | {
      readonly action: 'shutdown' | 'delete'
      readonly reason: 'idle-threshold-reached'
      readonly backupRequiredBeforeDelete: boolean
    }

/** Pure reconciler projection. Lifecycle admission does not itself schedule idle actions. */
export const evaluateIdlePolicy = (input: IdleDecisionInput): IdleDecision => {
  if (input.policy.idle.action === 'none') return { action: 'none', reason: 'disabled' }
  if (
    !Number.isSafeInteger(input.nowEpochMilliseconds) ||
    !Number.isSafeInteger(input.lastActivityEpochMilliseconds) ||
    input.lastActivityEpochMilliseconds > input.nowEpochMilliseconds
  )
    return { action: 'none', reason: 'invalid-clock' }
  const idleFor = input.nowEpochMilliseconds - input.lastActivityEpochMilliseconds
  if (idleFor < input.policy.idle.afterMinutes * 60_000)
    return { action: 'none', reason: 'not-idle' }
  return {
    action: input.policy.idle.action,
    reason: 'idle-threshold-reached',
    backupRequiredBeforeDelete:
      input.policy.idle.action === 'delete' && input.policy.backups.requiredBeforeDelete,
  }
}

export interface InitialOrganizationPolicyInput {
  readonly organizationId: string
  readonly defaultRegion: string
  readonly setupBudgetWarning?: { readonly minor: number; readonly currency: string } | undefined
}

/**
 * Deterministic revision-1 onboarding policy. Paid creation remains denied by empty provider/plan
 * allow-lists, zero node limits, and a zero hard budget. A setup warning is preserved separately
 * and is never promoted into a spend authorization.
 */
export const makeInitialOrganizationPolicy = (
  input: InitialOrganizationPolicyInput,
): OrganizationPolicyV1 => {
  const setupWarning = input.setupBudgetWarning
  return Schema.decodeUnknownSync(OrganizationPolicyV1)({
    schemaVersion: 1,
    organizationId: input.organizationId,
    revision: 1,
    allowedProviders: [],
    allowedRegions: [input.defaultRegion],
    allowedPlans: [],
    capacity: {
      maxActiveNodes: 0,
      maxDedicatedNodes: 0,
      maxServersPerNode: 0,
      maxDeploymentCpuMillis: 0,
      maxDeploymentRamBytes: 0,
      maxDeploymentDiskBytes: 0,
    },
    monthlyBudget: {
      currency: setupWarning?.currency ?? null,
      setupWarningMinor: setupWarning?.minor ?? null,
      softLimitMinor: 0,
      hardLimitMinor: 0,
    },
    temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 1 },
    idle: { action: 'none', afterMinutes: 1 },
    backups: { requiredBeforeDelete: true },
    maintenanceWindows: [],
    updates: { automatic: 'disabled', requireMaintenanceWindow: false },
    contabo: { maxContractMonths: 1 },
    nonHourlyCommitment: { explicitConfirmationRequired: true },
  })
}

export class PolicyStoreError extends Schema.TaggedError<PolicyStoreError>()('PolicyStoreError', {
  operation: Schema.String,
}) {}
export class AdmissionFactsError extends Schema.TaggedError<AdmissionFactsError>()(
  'AdmissionFactsError',
  { operation: Schema.String },
) {}
export class PolicyAdmissionDeniedError extends Schema.TaggedError<PolicyAdmissionDeniedError>()(
  'PolicyAdmissionDeniedError',
  { code: Schema.String, message: Schema.String },
) {}

export interface OrganizationPolicyRepositoryShape {
  readonly get: (
    organizationId: string,
  ) => Effect.Effect<OrganizationPolicyV1, PolicyStoreError | PolicyValidationError>
}
export class OrganizationPolicyRepository extends Context.Service<
  OrganizationPolicyRepository,
  OrganizationPolicyRepositoryShape
>()('@gridora/policy-control/OrganizationPolicyRepository') {}

export interface LifecycleAdmissionCommand {
  readonly organizationId: string
  readonly kind: string
}
export interface LifecycleAdmissionSnapshot {
  readonly organizationId: string
  readonly id: string
  readonly kind: 'node' | 'server'
}
export interface AdmissionFacts {
  readonly request: AdmissionRequest
  readonly usage: OrganizationUsage
  readonly price: PriceEstimate
}
export interface AdmissionFactsPortShape {
  readonly resolve: (
    command: LifecycleAdmissionCommand,
    snapshot: LifecycleAdmissionSnapshot,
  ) => Effect.Effect<AdmissionFacts, AdmissionFactsError | PolicyValidationError>
}
export class AdmissionFactsPort extends Context.Service<
  AdmissionFactsPort,
  AdmissionFactsPortShape
>()('@gridora/policy-control/AdmissionFactsPort') {}

export interface PolicyClockShape {
  readonly nowEpochMilliseconds: Effect.Effect<number>
}
export class PolicyClock extends Context.Service<PolicyClock, PolicyClockShape>()(
  '@gridora/policy-control/PolicyClock',
) {}

export interface PolicyWarningSinkShape {
  readonly record: (
    organizationId: string,
    warnings: readonly PolicyWarning[],
  ) => Effect.Effect<void, AdmissionFactsError>
}
export class PolicyWarningSink extends Context.Service<PolicyWarningSink, PolicyWarningSinkShape>()(
  '@gridora/policy-control/PolicyWarningSink',
) {}

export interface LifecyclePolicyAdmissionShape {
  readonly admit: (
    command: LifecycleAdmissionCommand,
    snapshot: LifecycleAdmissionSnapshot,
  ) => Effect.Effect<void, PolicyAdmissionDeniedError>
}

/**
 * Structurally matches lifecycle-control's PolicyAdmissionShape for its command/snapshot members.
 * The application root maps PolicyAdmissionDeniedError to lifecycle-control PolicyDeniedError.
 */
export const makeLifecyclePolicyAdmission = (
  policies: OrganizationPolicyRepositoryShape,
  facts: AdmissionFactsPortShape,
  clock: PolicyClockShape,
  warningSink: PolicyWarningSinkShape,
): LifecyclePolicyAdmissionShape => ({
  admit: (command, snapshot) =>
    Effect.gen(function* () {
      if (command.organizationId !== snapshot.organizationId)
        return yield* new PolicyAdmissionDeniedError({
          code: 'usage_tenant_mismatch',
          message: 'Lifecycle snapshot does not belong to the requested organization',
        })
      const policy = yield* policies.get(command.organizationId).pipe(
        Effect.mapError(
          () =>
            new PolicyAdmissionDeniedError({
              code: 'policy_unavailable',
              message: 'Organization policy is unavailable',
            }),
        ),
      )
      const resolved = yield* facts.resolve(command, snapshot).pipe(
        Effect.mapError(
          () =>
            new PolicyAdmissionDeniedError({
              code: 'admission_facts_unavailable',
              message: 'Authoritative admission facts are unavailable',
            }),
        ),
      )
      const now = yield* clock.nowEpochMilliseconds
      const decision = evaluatePolicyAdmission({ policy, ...resolved, nowEpochMilliseconds: now })
      if (decision.outcome === 'deny') {
        const first = decision.violations[0]
        return yield* new PolicyAdmissionDeniedError({
          code: first?.code ?? 'policy_denied',
          message: first?.message ?? 'Organization policy denied the operation',
        })
      }
      if (decision.outcome === 'warn')
        yield* warningSink.record(command.organizationId, decision.warnings).pipe(
          Effect.mapError(
            () =>
              new PolicyAdmissionDeniedError({
                code: 'policy_warning_record_failed',
                message: 'Policy warning could not be recorded',
              }),
          ),
        )
    }),
})

export class LifecyclePolicyAdmission extends Context.Service<
  LifecyclePolicyAdmission,
  LifecyclePolicyAdmissionShape
>()('@gridora/policy-control/LifecyclePolicyAdmission') {}

export const LifecyclePolicyAdmissionLive = Layer.effect(
  LifecyclePolicyAdmission,
  Effect.gen(function* () {
    return makeLifecyclePolicyAdmission(
      yield* OrganizationPolicyRepository,
      yield* AdmissionFactsPort,
      yield* PolicyClock,
      yield* PolicyWarningSink,
    )
  }),
)

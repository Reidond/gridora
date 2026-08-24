import { Effect, Schema } from 'effect'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import {
  GameCreateIntent,
  type GameCreateIntent as GameCreateIntentType,
} from '@gridora/game-lifecycle-control'
import type {
  AuthoritativeProvisionFacts,
  CreateNodeIntent,
  NodeProvisionBillingReceipt,
  ProviderType,
  ReviewedNodeProvision,
} from '@gridora/node-provision-control'
import { OrganizationPolicyV1, OrganizationUsage } from '@gridora/policy-control'
import {
  ServerPlacementRejectedError,
  ServerPlanAuthorizationError,
  type ServerPlanContext,
  type ServerPlanControlShape,
  type ServerPlanDecision,
  type ServerPlanError,
} from './index.js'
import {
  ServerCreateIntent,
  type ServerCreateIntent as ServerCreateIntentType,
} from './server-intent.js'
import { ServerPlanDecisionSchema } from './server-plan-decision.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const MembershipRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const ImageChecksum = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SelectionDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const CommercialReviewToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

/**
 * A single immutable public request. `server` is the scheduler contract and
 * `game` is the reviewed plugin contract; callers never supply provider
 * accounts, images, catalog prices, or an eventual node identifier for auto
 * placement.
 */
export const ServerApplyIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  server: ServerCreateIntent,
  game: GameCreateIntent,
  /** Opaque HMAC over a reviewed commercial offer; never a provider-selection input. */
  commercialReviewToken: Schema.optional(CommercialReviewToken),
})
export type ServerApplyIntent = typeof ServerApplyIntent.Type

const PolicyWarningSchema = Schema.Struct({
  code: Schema.Literal('soft_budget_exceeded'),
  message: Schema.String,
  projectedEstimatedMonthlyMinor: Schema.Number,
  currency: Schema.String,
})

/**
 * Internal-only evidence for a no-fit placement. This mirrors the node
 * control's reviewed selection exactly, including the observation clock. The
 * clock remains provenance rather than part of `selectionDigest`; the node
 * control deliberately canonicalizes only the mutable selection facts it
 * needs to fence before acceptance.
 */
export const ServerProvisionReviewedNodeProvisionSchema = Schema.Struct({
  facts: Schema.Struct({
    organizationId: Identifier,
    providerAccountId: Identifier,
    providerAccountRevision: PositiveRevision,
    providerType: Schema.Literals(['ovhcloud', 'contabo']),
    allocationRevision: PositiveRevision,
    allocationMaxActiveNodes: NonNegativeInteger,
    allocationMonthlyBudgetMinor: Schema.NullOr(NonNegativeInteger),
    allocationActiveNodes: NonNegativeInteger,
    region: Identifier,
    plan: Identifier,
    catalogRefreshedAt: Timestamp,
    catalogValidUntilEpochMilliseconds: NonNegativeInteger,
    imageId: Identifier,
    imageVersion: Identifier,
    imageChecksum: ImageChecksum,
    providerImageId: Identifier,
    policy: OrganizationPolicyV1,
    usage: OrganizationUsage,
    price: Schema.Struct({
      currency: Currency,
      estimatedMonthlyMinor: NonNegativeInteger,
      billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
      contractMonths: PositiveRevision,
    }),
  }),
  billing: Schema.Struct({
    providerType: Schema.Literals(['ovhcloud', 'contabo']),
    currency: Currency,
    estimatedMonthlyMinor: NonNegativeInteger,
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: PositiveRevision,
    committedMonthlyBeforeMinor: NonNegativeInteger,
    projectedCommittedMonthlyMinor: NonNegativeInteger,
    warnings: Schema.Array(PolicyWarningSchema),
  }),
  selectionDigest: SelectionDigest,
})
export interface ServerProvisionReviewedNodeProvision extends ReviewedNodeProvision {
  readonly facts: AuthoritativeProvisionFacts
  readonly billing: NodeProvisionBillingReceipt
  readonly selectionDigest: string
}

export const ServerProvisionNodePlanSchema = Schema.Struct({
  kind: Schema.Literal('provision-node'),
  pluginId: Identifier,
  /** The reviewed plugin channel is part of the accepted no-fit plan. */
  pluginVersion: Identifier,
  pluginSelectionRevision: PositiveRevision,
  placementMode: Schema.Literals(['shared', 'dedicated']),
  nodeIntent: Schema.Struct({
    schemaVersion: Schema.Literal(1),
    placementMode: Schema.Literals(['shared', 'dedicated']),
    temporaryLifetimeHours: Schema.Null,
    nonHourlyCommitmentConfirmed: Schema.Boolean,
  }),
  selectedInfrastructure: Schema.Struct({
    providerType: Schema.Literals(['ovhcloud', 'contabo']),
    region: Identifier,
    plan: Identifier,
  }),
  billing: Schema.Struct({
    currency: Schema.String,
    estimatedMonthlyIncreaseMinor: Schema.Number,
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: Schema.Number,
    committedMonthlyBeforeMinor: Schema.Number,
    projectedCommittedMonthlyMinor: Schema.Number,
  }),
  /**
   * A plan can be shown before a required commercial acknowledgement is made.
   * It is never accepted until that acknowledgement is carried in `nodeIntent`.
   */
  requiresNonHourlyCommitmentConfirmation: Schema.Boolean,
  /** Whether policy makes this non-hourly commercial offer review-bound. */
  commercialConsentRequired: Schema.Boolean,
  /** Opaque actor/org/intent/offer-bound token, present only for a required review. */
  commercialReviewToken: Schema.optional(CommercialReviewToken),
  implications: Schema.Struct({
    dns: Schema.String,
    mods: Schema.String,
    backups: Schema.String,
    downtime: Schema.String,
    billing: Schema.String,
  }),
  warnings: Schema.Array(PolicyWarningSchema),
  explanation: Schema.String,
  newPaidInfrastructure: Schema.Literal(true),
})
export interface ServerProvisionNodePlan {
  readonly kind: 'provision-node'
  readonly pluginId: string
  readonly pluginVersion: string
  readonly pluginSelectionRevision: number
  readonly placementMode: 'shared' | 'dedicated'
  /** Auto/dedicated orchestration never accepts an arbitrary temporary TTL. */
  readonly nodeIntent: CreateNodeIntent & { readonly temporaryLifetimeHours: null }
  readonly selectedInfrastructure: {
    readonly providerType: ProviderType
    readonly region: string
    readonly plan: string
  }
  readonly billing: {
    readonly currency: string
    readonly estimatedMonthlyIncreaseMinor: number
    readonly billingCadence: 'hourly' | 'monthly' | 'contract'
    readonly contractMonths: number
    readonly committedMonthlyBeforeMinor: number
    readonly projectedCommittedMonthlyMinor: number
  }
  readonly requiresNonHourlyCommitmentConfirmation: boolean
  readonly commercialConsentRequired: boolean
  readonly commercialReviewToken?: string | undefined
  readonly implications: {
    readonly dns: string
    readonly mods: string
    readonly backups: string
    readonly downtime: string
    readonly billing: string
  }
  readonly warnings: readonly {
    readonly code: 'soft_budget_exceeded'
    readonly message: string
    readonly projectedEstimatedMonthlyMinor: number
    readonly currency: string
  }[]
  readonly explanation: string
  readonly newPaidInfrastructure: true
}

export const ServerApplyPlanSchema = Schema.Union([
  ServerPlanDecisionSchema,
  ServerProvisionNodePlanSchema,
])
export type ServerApplyPlan = ServerPlanDecision | ServerProvisionNodePlan

/**
 * The accepted plan is persisted only in the parent Workflow record. Public
 * preview and apply responses continue to expose `ServerApplyPlan`, never the
 * allocation account, image, policy/usage fence, price catalog provenance, or
 * selection digest that the node-control adapter needs to validate.
 */
export const ServerProvisionAcceptedNodePlanSchema = Schema.Struct({
  ...ServerProvisionNodePlanSchema.fields,
  reviewedNodeProvision: ServerProvisionReviewedNodeProvisionSchema,
})
export interface ServerProvisionAcceptedNodePlan extends ServerProvisionNodePlan {
  readonly reviewedNodeProvision: ServerProvisionReviewedNodeProvision
}
export const ServerProvisionAcceptedPlanSchema = Schema.Union([
  ServerPlanDecisionSchema,
  ServerProvisionAcceptedNodePlanSchema,
])
export type ServerProvisionAcceptedPlan = ServerPlanDecision | ServerProvisionAcceptedNodePlan

export const publicServerProvisionPlan = (plan: ServerProvisionAcceptedPlan): ServerApplyPlan => {
  if (plan.kind === 'existing-node') return plan
  // A review token is needed only between preview and apply. Never replay it
  // from an accepted operation alongside the private reviewed-node evidence.
  const {
    reviewedNodeProvision: _reviewedNodeProvision,
    commercialReviewToken: _commercialReviewToken,
    ...publicPlan
  } = plan
  return publicPlan
}

export const ServerProvisionAcceptanceSchema = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  organizationId: Identifier,
  operationId: Identifier,
  resourceId: Identifier,
  idempotencyKey: IdempotencyKey,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  state: Schema.Literal('queued'),
  plan: ServerApplyPlanSchema,
  /** Whether the accepted parent Workflow was started or needs reconciliation. */
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
})
export interface ServerProvisionAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly organizationId: string
  readonly operationId: string
  /** A parent coordination resource; the eventual game-server ID is recorded by the Workflow. */
  readonly resourceId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly state: 'queued'
  readonly plan: ServerApplyPlan
  /** Present on the public apply response; absent from the internal D1 receipt. */
  readonly workflowState?: 'started' | 'pending-reconciliation'
}

export type ServerProvisionApplyAcceptance = ServerProvisionAcceptance & {
  readonly workflowState: 'started' | 'pending-reconciliation'
}

export interface ServerProvisionApplyCommand {
  readonly context: ServerPlanContext
  readonly idempotencyKey: string
  readonly intent: ServerApplyIntent
  /** Immutable HTTP provenance carried through all child operations. */
  readonly auditRequestContext: AuditRequestContextValue
}

export interface ServerProvisionIdentity {
  readonly resourceId: string
  readonly operationId: string
  readonly workflowStartRecordId: string
  readonly auditEventId: string
  readonly outboxEventId: string
}

export interface ServerProvisionAtomicInput {
  readonly command: ServerProvisionApplyCommand
  readonly fingerprint: string
  readonly identity: ServerProvisionIdentity
  /** Strict internal plan persisted in `plan_json`; it includes reviewed node evidence only for no-fit plans. */
  readonly plan: ServerProvisionAcceptedPlan
  readonly now: string
}

export class ServerProvisionValidationError extends Schema.TaggedError<ServerProvisionValidationError>()(
  'ServerProvisionValidationError',
  { code: Schema.String, message: Schema.String },
) {}
/** Stable internal conflict code mapped to the public HTTP 409 problem. */
export const CommercialReviewRequiredValidationCode = 'commercial_review_required' as const
export type CommercialReviewRequiredValidationCode = typeof CommercialReviewRequiredValidationCode
export class ServerProvisionIdempotencyConflictError extends Schema.TaggedError<ServerProvisionIdempotencyConflictError>()(
  'ServerProvisionIdempotencyConflictError',
  { idempotencyKey: Schema.String },
) {}
export class ServerProvisionPersistenceError extends Schema.TaggedError<ServerProvisionPersistenceError>()(
  'ServerProvisionPersistenceError',
  { operation: Schema.String, message: Schema.String },
) {}
export class ServerProvisionWorkflowStartError extends Schema.TaggedError<ServerProvisionWorkflowStartError>()(
  'ServerProvisionWorkflowStartError',
  { operationId: Schema.String, message: Schema.String },
) {}

export type ServerProvisionControlError =
  | ServerPlanError
  | ServerProvisionValidationError
  | ServerProvisionIdempotencyConflictError
  | ServerProvisionPersistenceError

/** A read-only adapter over the authoritative node allocation/catalog selection. */
export interface ServerProvisionPreviewRequest extends ServerPlanContext {
  readonly intent: ServerCreateIntentType
  /**
   * Internal apply-only signal. It never contains the proof and lets the
   * authoritative preview distinguish an expired reviewed commercial offer
   * from a first-time infrastructure-planning failure.
   */
  readonly commercialReviewProvided?: boolean
}
export interface ServerProvisionPreviewPort {
  readonly preview: (request: ServerProvisionPreviewRequest) => Effect.Effect<
    {
      readonly plan: ServerProvisionNodePlan
      readonly reviewedNodeProvision: ServerProvisionReviewedNodeProvision
    },
    ServerProvisionControlError
  >
}

export interface ServerProvisionRepositoryShape {
  readonly findReplay: (
    organizationId: string,
    idempotencyKey: string,
    fingerprint: string,
  ) => Effect.Effect<
    ServerProvisionAcceptance | null,
    ServerProvisionIdempotencyConflictError | ServerProvisionPersistenceError
  >
  /** Atomically persists the immutable parent operation, start receipt, and complete v1 audit envelope. */
  readonly acceptAtomic: (
    input: ServerProvisionAtomicInput,
  ) => Effect.Effect<
    ServerProvisionAcceptance,
    ServerProvisionIdempotencyConflictError | ServerProvisionPersistenceError
  >
  readonly markWorkflowStarted: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<void, ServerProvisionPersistenceError>
  readonly recordWorkflowStartFailure: (
    organizationId: string,
    operationId: string,
    message: string,
  ) => Effect.Effect<void, ServerProvisionPersistenceError>
}

export interface ServerProvisionWorkflowStarter {
  readonly start: (
    acceptance: ServerProvisionAcceptance,
  ) => Effect.Effect<void, ServerProvisionWorkflowStartError>
}

export interface ServerProvisionIdentityPort {
  readonly fingerprint: (
    command: ServerProvisionApplyCommand,
  ) => Effect.Effect<string, ServerProvisionValidationError>
  readonly derive: (
    command: ServerProvisionApplyCommand,
    fingerprint: string,
  ) => Effect.Effect<ServerProvisionIdentity, ServerProvisionValidationError>
}

export interface ServerProvisionClock {
  readonly now: Effect.Effect<{ readonly iso: string; readonly epochMilliseconds: number }>
}

/**
 * The public review token is an opaque MAC over this exact scope. It includes
 * the private reviewed-selection digest as input, but the digest itself never
 * leaves the control plane. The acknowledgement boolean is intentionally
 * omitted: a user reviews first with `false`, then submits `true` for the
 * exact same scheduling request and offer.
 */
export interface ServerProvisionCommercialReviewScope {
  readonly schemaVersion: 1
  readonly organizationId: string
  readonly actorId: string
  readonly actorRole: 'owner' | 'administrator' | 'operator' | 'viewer'
  readonly actorMembershipRevision?: number
  readonly intent: {
    readonly schemaVersion: 1
    readonly name: string
    readonly pluginId: string
    readonly placementMode: 'auto' | 'shared' | 'dedicated'
    readonly resources: ServerCreateIntentType['resources']
  }
  readonly offer: {
    readonly pluginId: string
    readonly pluginVersion: string
    readonly pluginSelectionRevision: number
    readonly placementMode: 'shared' | 'dedicated'
    readonly providerType: ProviderType
    readonly region: string
    readonly plan: string
    readonly currency: string
    readonly estimatedMonthlyIncreaseMinor: number
    readonly billingCadence: 'hourly' | 'monthly' | 'contract'
    readonly contractMonths: number
    readonly committedMonthlyBeforeMinor: number
    readonly projectedCommittedMonthlyMinor: number
  }
  readonly reviewedSelectionDigest: string
  /** The authoritative provider catalog review expires at this instant. */
  readonly expiresAtEpochMilliseconds: number
}

export interface ServerProvisionCommercialReviewTokenPort {
  readonly issue: (
    scope: ServerProvisionCommercialReviewScope,
  ) => Effect.Effect<string, ServerProvisionPersistenceError>
  readonly verify: (
    scope: ServerProvisionCommercialReviewScope,
    token: string,
  ) => Effect.Effect<boolean, ServerProvisionPersistenceError>
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    )
  return value
}

export const commercialReviewScopeFor = (input: {
  readonly context: ServerPlanContext
  readonly intent: ServerCreateIntentType
  readonly plan: ServerProvisionNodePlan
  readonly reviewedNodeProvision: ServerProvisionReviewedNodeProvision
}): ServerProvisionCommercialReviewScope => ({
  schemaVersion: 1,
  organizationId: input.context.organizationId,
  actorId: input.context.actorId,
  actorRole: input.context.actorRole,
  ...(input.context.actorMembershipRevision === undefined
    ? {}
    : { actorMembershipRevision: input.context.actorMembershipRevision }),
  intent: {
    schemaVersion: input.intent.schemaVersion,
    name: input.intent.name,
    pluginId: input.intent.pluginId,
    placementMode: input.intent.placementMode,
    resources: input.intent.resources,
  },
  offer: {
    pluginId: input.plan.pluginId,
    pluginVersion: input.plan.pluginVersion,
    pluginSelectionRevision: input.plan.pluginSelectionRevision,
    placementMode: input.plan.placementMode,
    providerType: input.plan.selectedInfrastructure.providerType,
    region: input.plan.selectedInfrastructure.region,
    plan: input.plan.selectedInfrastructure.plan,
    currency: input.plan.billing.currency,
    estimatedMonthlyIncreaseMinor: input.plan.billing.estimatedMonthlyIncreaseMinor,
    billingCadence: input.plan.billing.billingCadence,
    contractMonths: input.plan.billing.contractMonths,
    committedMonthlyBeforeMinor: input.plan.billing.committedMonthlyBeforeMinor,
    projectedCommittedMonthlyMinor: input.plan.billing.projectedCommittedMonthlyMinor,
  },
  reviewedSelectionDigest: input.reviewedNodeProvision.selectionDigest,
  expiresAtEpochMilliseconds: input.reviewedNodeProvision.facts.catalogValidUntilEpochMilliseconds,
})

export const canonicalServerProvisionCommercialReviewScope = (
  scope: ServerProvisionCommercialReviewScope,
): string => JSON.stringify(canonical(scope))

export const canonicalServerProvisionCommand = (command: ServerProvisionApplyCommand): string =>
  JSON.stringify(
    canonical({
      organizationId: command.context.organizationId,
      actorId: command.context.actorId,
      intent: command.intent,
    }),
  )

const bytes = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
const sha256 = (value: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', bytes(new TextEncoder().encode(value))),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () =>
      new ServerProvisionValidationError({
        code: 'identity_derivation_failed',
        message: 'Server provisioning identity could not be derived',
      }),
  })

export const makeWebCryptoServerProvisionIdentity = (): ServerProvisionIdentityPort => ({
  fingerprint: (command) => sha256(canonicalServerProvisionCommand(command)),
  derive: (command, fingerprint) =>
    Effect.map(
      sha256(
        `gridora:server-provision-plan:v1:${command.context.organizationId}:${command.context.actorId}:${command.idempotencyKey}:${fingerprint}`,
      ),
      (scope) => {
        const prefix = scope.slice(0, 24)
        return {
          resourceId: `server-provision_${prefix}`,
          operationId: `op_${prefix}`,
          workflowStartRecordId: `workflow-start:op_${prefix}`,
          auditEventId: `audit_server-provision_${prefix}`,
          outboxEventId: `outbox_server-provision_${prefix}`,
        }
      },
    ),
})

const CommandContract = Schema.Struct({
  context: Schema.Struct({
    organizationId: Identifier,
    actorId: Identifier,
    actorRole: Schema.Literals(['owner', 'administrator', 'operator', 'viewer']),
    correlationId: Identifier,
    actorMembershipRevision: Schema.optional(MembershipRevision),
  }),
  idempotencyKey: IdempotencyKey,
  intent: ServerApplyIntent,
})

const validateCommand = (command: ServerProvisionApplyCommand) =>
  Schema.decodeUnknownEffect(CommandContract, { onExcessProperty: 'error' })({
    context: command.context,
    idempotencyKey: command.idempotencyKey,
    intent: command.intent,
  }).pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new ServerProvisionValidationError({
          code: 'invalid_server_apply_command',
          message: 'Server apply command does not match schema version 1',
        }),
    ),
  )

/** Prevent two superficially similar public documents from diverging at apply time. */
export const validateServerApplyIntent = (
  intent: ServerApplyIntent,
): Effect.Effect<void, ServerProvisionValidationError> => {
  const game = intent.game as GameCreateIntentType
  if (intent.server.name !== game.name || intent.server.pluginId !== game.pluginId)
    return Effect.fail(
      new ServerProvisionValidationError({
        code: 'server_game_identity_mismatch',
        message: 'Server and game intents must name the same plugin and server',
      }),
    )
  const expectedCpu = intent.server.resources.cpuMillis / 1_000
  const expectedMemory = intent.server.resources.ramBytes / (1024 * 1024)
  const expectedDisk = intent.server.resources.diskBytes / (1024 * 1024 * 1024)
  if (
    !Number.isInteger(expectedCpu) ||
    !Number.isInteger(expectedMemory) ||
    !Number.isInteger(expectedDisk) ||
    game.resources === undefined ||
    game.resources.cpu !== expectedCpu ||
    game.resources.memoryMiB !== expectedMemory ||
    game.resources.diskGiB !== expectedDisk
  )
    return Effect.fail(
      new ServerProvisionValidationError({
        code: 'resource_contract_mismatch',
        message: 'Game resources must exactly match the canonical server resource request',
      }),
    )
  const requestedMode = intent.server.placementMode
  if (requestedMode !== 'auto' && game.placement.mode !== requestedMode)
    return Effect.fail(
      new ServerProvisionValidationError({
        code: 'placement_contract_mismatch',
        message: 'Game placement must match the canonical server placement request',
      }),
    )
  if (requestedMode === 'auto' && game.placement.nodeId !== undefined)
    return Effect.fail(
      new ServerProvisionValidationError({
        code: 'auto_placement_node_forbidden',
        message: 'Auto placement cannot be pinned to a client-selected node',
      }),
    )
  return Effect.void
}

const startAccepted = (
  repository: ServerProvisionRepositoryShape,
  workflows: ServerProvisionWorkflowStarter,
  acceptance: ServerProvisionAcceptance,
) =>
  workflows.start(acceptance).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        repository
          .recordWorkflowStartFailure(
            acceptance.organizationId,
            acceptance.operationId,
            error.message,
          )
          .pipe(
            Effect.catch(() => Effect.void),
            Effect.as('pending-reconciliation' as const),
          ),
      onSuccess: () =>
        repository.markWorkflowStarted(acceptance.organizationId, acceptance.operationId).pipe(
          Effect.match({
            onFailure: () => 'pending-reconciliation' as const,
            onSuccess: () => 'started' as const,
          }),
        ),
    }),
  )

export interface ServerProvisionPlanControlShape {
  readonly plan: (request: {
    readonly context: ServerPlanContext
    readonly intent: ServerCreateIntentType
  }) => Effect.Effect<ServerApplyPlan, ServerProvisionControlError>
  readonly apply: (
    command: ServerProvisionApplyCommand,
  ) => Effect.Effect<ServerProvisionApplyAcceptance, ServerProvisionControlError>
}

interface SelectedServerProvisionPlan {
  readonly publicPlan: ServerApplyPlan
  readonly acceptedPlan: ServerProvisionAcceptedPlan
  readonly commercialReviewScope?: ServerProvisionCommercialReviewScope
}

/**
 * Coordinates only the durable parent acceptance. The Workflow invokes the
 * existing node-provision and game-lifecycle controls; it never owns a
 * provider adapter or fabricates capacity readiness.
 */
export const makeServerProvisionPlanControl = (dependencies: {
  readonly serverPlan: ServerPlanControlShape
  readonly preview: ServerProvisionPreviewPort
  readonly repository: ServerProvisionRepositoryShape
  readonly identities: ServerProvisionIdentityPort
  readonly commercialReviews: ServerProvisionCommercialReviewTokenPort
  readonly clock: ServerProvisionClock
  readonly workflows: ServerProvisionWorkflowStarter
}): ServerProvisionPlanControlShape => {
  const selectPlan = (
    request: {
      readonly context: ServerPlanContext
      readonly intent: ServerCreateIntentType
    },
    options: { readonly commercialReviewProvided?: boolean } = {},
  ): Effect.Effect<SelectedServerProvisionPlan, ServerProvisionControlError> =>
    dependencies.serverPlan.plan(request).pipe(
      Effect.map((selected) => ({ publicPlan: selected, acceptedPlan: selected })),
      Effect.catchIf(
        (error) =>
          error instanceof ServerPlacementRejectedError && error.code === 'no_existing_node_fit',
        () =>
          dependencies.preview
            .preview({
              ...request.context,
              intent: request.intent,
              ...(options.commercialReviewProvided === true
                ? { commercialReviewProvided: true }
                : {}),
            })
            .pipe(
              Effect.flatMap(({ plan, reviewedNodeProvision }) => {
                const acceptedPlan = { ...plan, reviewedNodeProvision }
                if (!plan.commercialConsentRequired)
                  return Effect.succeed({ publicPlan: plan, acceptedPlan })
                const commercialReviewScope = commercialReviewScopeFor({
                  context: request.context,
                  intent: request.intent,
                  plan,
                  reviewedNodeProvision,
                })
                const issueCommercialReview = (): Effect.Effect<
                  SelectedServerProvisionPlan,
                  ServerProvisionControlError
                > =>
                  Effect.gen(function* () {
                    const now = yield* dependencies.clock.now
                    if (commercialReviewScope.expiresAtEpochMilliseconds <= now.epochMilliseconds)
                      return yield* new ServerProvisionValidationError({
                        code: CommercialReviewRequiredValidationCode,
                        message:
                          'The reviewed commercial provider offer has expired; review it again before applying',
                      })
                    const commercialReviewToken =
                      yield* dependencies.commercialReviews.issue(commercialReviewScope)
                    const publicPlan = { ...plan, commercialReviewToken }
                    return {
                      publicPlan,
                      acceptedPlan: { ...publicPlan, reviewedNodeProvision },
                      commercialReviewScope,
                    }
                  })
                return issueCommercialReview()
              }),
            ),
      ),
    )
  const plan = (request: {
    readonly context: ServerPlanContext
    readonly intent: ServerCreateIntentType
  }): Effect.Effect<ServerApplyPlan, ServerProvisionControlError> =>
    selectPlan(request).pipe(Effect.map(({ publicPlan }) => publicPlan))
  return {
    plan,
    apply: (command) =>
      Effect.gen(function* () {
        yield* validateCommand(command)
        yield* validateServerApplyIntent(command.intent)
        if (command.context.actorRole === 'viewer')
          return yield* new ServerPlanAuthorizationError({ code: 'operator_required' })
        const fingerprint = yield* dependencies.identities.fingerprint(command)
        const replay = yield* dependencies.repository.findReplay(
          command.context.organizationId,
          command.idempotencyKey,
          fingerprint,
        )
        const accepted =
          replay ??
          (yield* Effect.gen(function* () {
            const selected = yield* selectPlan(
              { context: command.context, intent: command.intent.server },
              { commercialReviewProvided: command.intent.commercialReviewToken !== undefined },
            )
            const now = yield* dependencies.clock.now
            if (
              selected.publicPlan.kind === 'provision-node' &&
              selected.publicPlan.requiresNonHourlyCommitmentConfirmation
            )
              return yield* new ServerProvisionValidationError({
                code: 'non_hourly_confirmation_required',
                message:
                  'The reviewed non-hourly provider commitment must be explicitly confirmed before apply',
              })
            if (
              selected.publicPlan.kind === 'provision-node' &&
              selected.publicPlan.commercialConsentRequired
            ) {
              const token = command.intent.commercialReviewToken
              if (token === undefined || selected.commercialReviewScope === undefined)
                return yield* new ServerProvisionValidationError({
                  code: CommercialReviewRequiredValidationCode,
                  message: 'Review the exact current commercial provider offer before applying it',
                })
              if (
                selected.commercialReviewScope.expiresAtEpochMilliseconds <= now.epochMilliseconds
              )
                return yield* new ServerProvisionValidationError({
                  code: CommercialReviewRequiredValidationCode,
                  message:
                    'The reviewed commercial provider offer has expired; review it again before applying',
                })
              const tokenMatches = yield* dependencies.commercialReviews.verify(
                selected.commercialReviewScope,
                token,
              )
              if (!tokenMatches)
                return yield* new ServerProvisionValidationError({
                  code: CommercialReviewRequiredValidationCode,
                  message:
                    'The reviewed commercial provider offer changed; review it again before applying',
                })
            }
            if (
              selected.publicPlan.kind === 'provision-node' &&
              command.context.actorRole !== 'owner' &&
              command.context.actorRole !== 'administrator'
            )
              return yield* new ServerPlanAuthorizationError({ code: 'operator_required' })
            const identity = yield* dependencies.identities.derive(command, fingerprint)
            return yield* dependencies.repository.acceptAtomic({
              command,
              fingerprint,
              identity,
              plan: selected.acceptedPlan,
              now: now.iso,
            })
          }))
        const workflowState = yield* startAccepted(
          dependencies.repository,
          dependencies.workflows,
          accepted,
        )
        return { ...accepted, workflowState }
      }),
  }
}

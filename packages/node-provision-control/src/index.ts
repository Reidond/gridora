import { Context, Effect, Layer, Schema } from 'effect'
import {
  evaluatePolicyAdmission,
  type OrganizationPolicyV1,
  type OrganizationUsage,
  type PolicyWarning,
} from '@gridora/policy-control'

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
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const ImageChecksum = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)

/**
 * Public node-create intent. Provider/account/catalog/image identifiers, prices, and credentials are
 * deliberately absent. They are selected from authoritative allocation facts after authorization.
 */
export const CreateNodeIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  placementMode: Schema.Literals(['shared', 'dedicated']),
  temporaryLifetimeHours: Schema.NullOr(PositiveInteger),
  nonHourlyCommitmentConfirmed: Schema.Boolean,
})
export type CreateNodeIntent = typeof CreateNodeIntent.Type

export const decodeCreateNodeIntent = (input: unknown) =>
  Schema.decodeUnknownEffect(CreateNodeIntent, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new NodeProvisionValidationError({
          code: 'invalid_create_node_intent',
          message: 'Node create intent does not match the public contract',
        }),
    ),
  )

export interface NodeProvisionCommand {
  readonly organizationId: string
  readonly actorId: string
  readonly actorRole: 'owner' | 'administrator' | 'operator' | 'viewer'
  readonly idempotencyKey: string
  readonly correlationId: string
  readonly intent: CreateNodeIntent
}

export type ProviderType = 'ovhcloud' | 'contabo'
export type BillingCadence = 'hourly' | 'monthly' | 'contract'

export interface AuthoritativeProvisionFacts {
  readonly organizationId: string
  readonly providerAccountId: string
  readonly providerAccountRevision: number
  readonly providerType: ProviderType
  readonly allocationRevision: number
  readonly allocationMaxActiveNodes: number
  readonly allocationMonthlyBudgetMinor: number | null
  readonly allocationActiveNodes: number
  readonly region: string
  readonly plan: string
  readonly catalogRefreshedAt: string
  readonly catalogValidUntilEpochMilliseconds: number
  readonly imageId: string
  readonly imageVersion: string
  readonly imageChecksum: string
  readonly providerImageId: string
  readonly policy: OrganizationPolicyV1
  readonly usage: OrganizationUsage
  readonly price: {
    readonly currency: string
    readonly estimatedMonthlyMinor: number
    readonly billingCadence: BillingCadence
    readonly contractMonths: number
  }
}

export interface NodeProvisionBillingReceipt {
  readonly providerType: ProviderType
  readonly currency: string
  readonly estimatedMonthlyMinor: number
  readonly billingCadence: BillingCadence
  readonly contractMonths: number
  readonly committedMonthlyBeforeMinor: number
  readonly projectedCommittedMonthlyMinor: number
  readonly warnings: readonly PolicyWarning[]
}

/**
 * Immutable facts reviewed by a parent orchestration before it may ask the
 * node control to spend on a new provider instance. This type deliberately
 * contains no credential material. `selectionDigest` binds the durable
 * selection, policy/usage fence, and price receipt to the child request.
 */
export interface ReviewedNodeProvision {
  readonly facts: AuthoritativeProvisionFacts
  readonly billing: NodeProvisionBillingReceipt
  readonly selectionDigest: string
}

export interface NodeProvisionWorkflowStart {
  readonly id: string
  readonly state: 'pending' | 'started'
  readonly attempts: number
  readonly lastError: string | null
}

export interface NodeProvisionAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly providerType: ProviderType
  readonly placementMode: 'shared' | 'dedicated'
  readonly billing: NodeProvisionBillingReceipt
  readonly workflowStart: NodeProvisionWorkflowStart
}

export interface NodeProvisionIdentity {
  readonly nodeId: string
  readonly operationId: string
  readonly workflowStartRecordId: string
  readonly auditEventId: string
  readonly outboxEventId: string
  readonly bootstrapTokenRecordId: string
}

export interface RegistrationTokenScope {
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly tokenRecordId: string
}

export interface RegistrationTokenHash {
  readonly keyVersion: number
  readonly tokenHash: string
}

/** Secret-free, immutable coordinates loaded by the post-commit provisioning Workflow. */
export interface NodeProvisionExecutionReservation {
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly providerAccountId: string
  readonly providerAccountRevision: number
  readonly providerType: ProviderType
  readonly region: string
  readonly plan: string
  readonly imageId: string
  readonly imageVersion: string
  readonly imageChecksum: string
  readonly providerImageId: string
  readonly placementMode: 'shared' | 'dedicated'
  readonly billing: {
    readonly currency: string
    readonly estimatedMonthlyMinor: number
    readonly billingCadence: BillingCadence
    readonly contractMonths: number
    readonly nonHourlyCommitmentConfirmed: boolean
    readonly catalogRefreshedAt: string
  }
  readonly bootstrapToken: {
    readonly recordId: string
    readonly keyVersion: number
    readonly tokenHash: string
    readonly state: 'reserved' | 'materialized' | 'consumed' | 'revoked'
    readonly expiresAt: string
  }
  readonly workflowStart: {
    readonly id: string
    readonly state: 'pending' | 'started'
  }
}

export class NodeProvisionValidationError extends Schema.TaggedError<NodeProvisionValidationError>()(
  'NodeProvisionValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class NodeProvisionAuthorizationError extends Schema.TaggedError<NodeProvisionAuthorizationError>()(
  'NodeProvisionAuthorizationError',
  { code: Schema.Literal('administrator_required') },
) {}
export class NodeProvisionIdempotencyConflictError extends Schema.TaggedError<NodeProvisionIdempotencyConflictError>()(
  'NodeProvisionIdempotencyConflictError',
  { idempotencyKey: Schema.String },
) {}
export class NodeProvisionAdmissionDeniedError extends Schema.TaggedError<NodeProvisionAdmissionDeniedError>()(
  'NodeProvisionAdmissionDeniedError',
  { code: Schema.String, message: Schema.String },
) {}
export class NodeProvisionFactsUnavailableError extends Schema.TaggedError<NodeProvisionFactsUnavailableError>()(
  'NodeProvisionFactsUnavailableError',
  { operation: Schema.String },
) {}
export class NodeProvisionPersistenceError extends Schema.TaggedError<NodeProvisionPersistenceError>()(
  'NodeProvisionPersistenceError',
  { operation: Schema.String },
) {}
export class NodeProvisionWorkflowStartError extends Schema.TaggedError<NodeProvisionWorkflowStartError>()(
  'NodeProvisionWorkflowStartError',
  { operationId: Schema.String, message: Schema.String },
) {}
export class RegistrationTokenSecretError extends Schema.TaggedError<RegistrationTokenSecretError>()(
  'RegistrationTokenSecretError',
  { operation: Schema.String },
) {}

export type NodeProvisionControlError =
  | NodeProvisionValidationError
  | NodeProvisionAuthorizationError
  | NodeProvisionIdempotencyConflictError
  | NodeProvisionAdmissionDeniedError
  | NodeProvisionFactsUnavailableError
  | NodeProvisionPersistenceError
  | RegistrationTokenSecretError

export interface NodeProvisionFactsPortShape {
  readonly resolve: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly intent: CreateNodeIntent
  }) => Effect.Effect<AuthoritativeProvisionFacts, NodeProvisionFactsUnavailableError>
  /**
   * Revalidates a reviewed selection without selecting a replacement account,
   * region, plan, catalog item, or image. It remains optional for existing
   * direct-create ports; `submitAccepted` fails closed when it is unavailable.
   */
  readonly resolveReviewed?: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly intent: CreateNodeIntent
    readonly reviewed: ReviewedNodeProvision
  }) => Effect.Effect<AuthoritativeProvisionFacts, NodeProvisionFactsUnavailableError>
}
export class NodeProvisionFactsPort extends Context.Service<
  NodeProvisionFactsPort,
  NodeProvisionFactsPortShape
>()('@gridora/node-provision-control/NodeProvisionFactsPort') {}
export const NodeProvisionFactsPortLayer = (port: NodeProvisionFactsPortShape) =>
  Layer.succeed(NodeProvisionFactsPort, port)

export interface NodeProvisionExecutionReservationPortShape {
  readonly load: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<NodeProvisionExecutionReservation, NodeProvisionFactsUnavailableError>
}
export class NodeProvisionExecutionReservationPort extends Context.Service<
  NodeProvisionExecutionReservationPort,
  NodeProvisionExecutionReservationPortShape
>()('@gridora/node-provision-control/NodeProvisionExecutionReservationPort') {}
export const NodeProvisionExecutionReservationPortLayer = (
  port: NodeProvisionExecutionReservationPortShape,
) => Layer.succeed(NodeProvisionExecutionReservationPort, port)

export interface NodeProvisionPolicyAdmissionShape {
  readonly admit: (
    intent: CreateNodeIntent,
    facts: AuthoritativeProvisionFacts,
    nowEpochMilliseconds: number,
  ) => Effect.Effect<NodeProvisionBillingReceipt, NodeProvisionAdmissionDeniedError>
}
export class NodeProvisionPolicyAdmission extends Context.Service<
  NodeProvisionPolicyAdmission,
  NodeProvisionPolicyAdmissionShape
>()('@gridora/node-provision-control/NodeProvisionPolicyAdmission') {}
export const NodeProvisionPolicyAdmissionLayer = (port: NodeProvisionPolicyAdmissionShape) =>
  Layer.succeed(NodeProvisionPolicyAdmission, port)

export interface NodeProvisionRepositoryShape {
  /** Exact replay is queried before current admission facts are read. */
  readonly findReplay: (
    organizationId: string,
    idempotencyKey: string,
    fingerprint: string,
  ) => Effect.Effect<
    NodeProvisionAcceptance | null,
    NodeProvisionIdempotencyConflictError | NodeProvisionPersistenceError
  >
  readonly acceptAtomic: (
    input: NodeProvisionAtomicInput,
  ) => Effect.Effect<
    NodeProvisionAcceptance,
    NodeProvisionIdempotencyConflictError | NodeProvisionPersistenceError
  >
  readonly markWorkflowStarted: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<void, NodeProvisionPersistenceError>
  readonly recordWorkflowStartFailure: (
    organizationId: string,
    operationId: string,
    message: string,
  ) => Effect.Effect<void, NodeProvisionPersistenceError>
}
export class NodeProvisionRepository extends Context.Service<
  NodeProvisionRepository,
  NodeProvisionRepositoryShape
>()('@gridora/node-provision-control/NodeProvisionRepository') {}
export const NodeProvisionRepositoryLayer = (repository: NodeProvisionRepositoryShape) =>
  Layer.succeed(NodeProvisionRepository, repository)

export interface NodeProvisionIdentityPortShape {
  readonly fingerprint: (
    command: NodeProvisionCommand,
  ) => Effect.Effect<string, NodeProvisionValidationError>
  readonly derive: (
    command: NodeProvisionCommand,
    fingerprint: string,
  ) => Effect.Effect<NodeProvisionIdentity, NodeProvisionValidationError>
}
export class NodeProvisionIdentityPort extends Context.Service<
  NodeProvisionIdentityPort,
  NodeProvisionIdentityPortShape
>()('@gridora/node-provision-control/NodeProvisionIdentityPort') {}
export const NodeProvisionIdentityPortLayer = (port: NodeProvisionIdentityPortShape) =>
  Layer.succeed(NodeProvisionIdentityPort, port)

export interface RegistrationTokenSecretShape {
  readonly hashFor: (
    scope: RegistrationTokenScope,
  ) => Effect.Effect<RegistrationTokenHash, RegistrationTokenSecretError>
  /** Caller must clear the returned bytes after placing the token in an ephemeral provider request. */
  readonly recoverBytes: (
    scope: RegistrationTokenScope,
    keyVersion: number,
    expectedHash: string,
  ) => Effect.Effect<Uint8Array, RegistrationTokenSecretError>
}
export class RegistrationTokenSecret extends Context.Service<
  RegistrationTokenSecret,
  RegistrationTokenSecretShape
>()('@gridora/node-provision-control/RegistrationTokenSecret') {}
export const RegistrationTokenSecretLayer = (secret: RegistrationTokenSecretShape) =>
  Layer.succeed(RegistrationTokenSecret, secret)

export interface NodeProvisionClockShape {
  readonly now: Effect.Effect<{ readonly iso: string; readonly epochMilliseconds: number }>
}
export class NodeProvisionClock extends Context.Service<
  NodeProvisionClock,
  NodeProvisionClockShape
>()('@gridora/node-provision-control/NodeProvisionClock') {}
export const NodeProvisionClockLayer = (clock: NodeProvisionClockShape) =>
  Layer.succeed(NodeProvisionClock, clock)

export interface NodeProvisionWorkflowStarterShape {
  readonly start: (
    acceptance: NodeProvisionAcceptance,
  ) => Effect.Effect<void, NodeProvisionWorkflowStartError>
}
export class NodeProvisionWorkflowStarter extends Context.Service<
  NodeProvisionWorkflowStarter,
  NodeProvisionWorkflowStarterShape
>()('@gridora/node-provision-control/NodeProvisionWorkflowStarter') {}
export const NodeProvisionWorkflowStarterLayer = (starter: NodeProvisionWorkflowStarterShape) =>
  Layer.succeed(NodeProvisionWorkflowStarter, starter)

export interface NodeProvisionAtomicInput {
  readonly command: NodeProvisionCommand
  readonly identity: NodeProvisionIdentity
  readonly fingerprint: string
  readonly facts: AuthoritativeProvisionFacts
  readonly billing: NodeProvisionBillingReceipt
  readonly bootstrapToken: RegistrationTokenHash
  readonly now: string
}

export interface NodeProvisionResult {
  readonly disposition: 'created' | 'adopted'
  readonly nodeId: string
  readonly operationId: string
  readonly workflowState: 'started' | 'pending-reconciliation'
  readonly billing: NodeProvisionBillingReceipt
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
export const canonicalCreateNodeIntent = (command: NodeProvisionCommand): string =>
  JSON.stringify(
    canonical({
      organizationId: command.organizationId,
      actorId: command.actorId,
      intent: command.intent,
    }),
  )

/** The live sampling time is not an admission fact and cannot be replayed. */
const reviewedFactsPayload = (facts: AuthoritativeProvisionFacts) => ({
  organizationId: facts.organizationId,
  providerAccountId: facts.providerAccountId,
  providerAccountRevision: facts.providerAccountRevision,
  providerType: facts.providerType,
  allocationRevision: facts.allocationRevision,
  allocationMaxActiveNodes: facts.allocationMaxActiveNodes,
  allocationMonthlyBudgetMinor: facts.allocationMonthlyBudgetMinor,
  allocationActiveNodes: facts.allocationActiveNodes,
  region: facts.region,
  plan: facts.plan,
  catalogRefreshedAt: facts.catalogRefreshedAt,
  catalogValidUntilEpochMilliseconds: facts.catalogValidUntilEpochMilliseconds,
  imageId: facts.imageId,
  imageVersion: facts.imageVersion,
  imageChecksum: facts.imageChecksum,
  providerImageId: facts.providerImageId,
  policy: facts.policy,
  usage: {
    organizationId: facts.usage.organizationId,
    activeNodes: facts.usage.activeNodes,
    dedicatedNodes: facts.usage.dedicatedNodes,
    serversByNode: facts.usage.serversByNode,
    estimatedCommittedMonthlyMinor: facts.usage.estimatedCommittedMonthlyMinor,
    currency: facts.usage.currency,
  },
  price: facts.price,
})

export const canonicalReviewedNodeProvision = (input: {
  readonly facts: AuthoritativeProvisionFacts
  readonly billing: NodeProvisionBillingReceipt
}): string =>
  JSON.stringify(canonical({ facts: reviewedFactsPayload(input.facts), billing: input.billing }))

const digest = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes))), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () =>
      new NodeProvisionValidationError({
        code: 'identity_derivation_failed',
        message: 'Node provision identity could not be derived',
      }),
  })

/** Creates the immutable reviewed snapshot persisted by a parent planner. */
export const reviewNodeProvision = (
  facts: AuthoritativeProvisionFacts,
  billing: NodeProvisionBillingReceipt,
): Effect.Effect<ReviewedNodeProvision, NodeProvisionValidationError> =>
  digest(new TextEncoder().encode(canonicalReviewedNodeProvision({ facts, billing }))).pipe(
    Effect.map((selectionDigest) => ({ facts, billing, selectionDigest })),
  )

const reviewedFingerprint = (
  command: NodeProvisionCommand,
  selectionDigest: string,
): Effect.Effect<string, NodeProvisionValidationError> =>
  digest(
    new TextEncoder().encode(
      `gridora:node-provision:reviewed:v1:${canonicalCreateNodeIntent(command)}:${selectionDigest}`,
    ),
  )

const verifyReviewedNodeProvision = (
  reviewed: ReviewedNodeProvision,
): Effect.Effect<void, NodeProvisionFactsUnavailableError> =>
  reviewNodeProvision(reviewed.facts, reviewed.billing).pipe(
    Effect.flatMap((derived) =>
      constantTimeEqual(derived.selectionDigest, reviewed.selectionDigest)
        ? Effect.void
        : Effect.fail(
            new NodeProvisionFactsUnavailableError({
              operation: 'node-provision.reviewed.selection-digest-mismatch',
            }),
          ),
    ),
    Effect.mapError(
      () =>
        new NodeProvisionFactsUnavailableError({
          operation: 'node-provision.reviewed.selection-digest-invalid',
        }),
    ),
  )

export const makeWebCryptoNodeProvisionIdentity = (): NodeProvisionIdentityPortShape => ({
  fingerprint: (command) => digest(new TextEncoder().encode(canonicalCreateNodeIntent(command))),
  derive: (command, fingerprint) =>
    Effect.gen(function* () {
      const scope = yield* digest(
        new TextEncoder().encode(
          `gridora:node-provision:v1:${command.organizationId}:${command.actorId}:${command.idempotencyKey}:${fingerprint}`,
        ),
      )
      return {
        nodeId: `node_${scope.slice(0, 24)}`,
        operationId: `op_${scope.slice(0, 24)}`,
        workflowStartRecordId: `workflow-start:op_${scope.slice(0, 24)}`,
        auditEventId: `audit_node_${scope.slice(0, 24)}`,
        outboxEventId: `outbox_node_${scope.slice(0, 24)}`,
        bootstrapTokenRecordId: `bootstrap_${scope.slice(0, 24)}`,
      }
    }),
})

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const constantTimeEqual = (left: string, right: string): boolean => {
  const length = Math.max(left.length, right.length)
  let mismatch = left.length ^ right.length
  for (let index = 0; index < length; index += 1)
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  return mismatch === 0
}

export const makeHmacRegistrationTokenSecret = (options: {
  readonly activeVersion: number
  readonly keys: Readonly<Record<number, string>>
}): RegistrationTokenSecretShape => {
  const derive = (scope: RegistrationTokenScope, version: number) =>
    Effect.tryPromise({
      try: async () => {
        const secret = options.keys[version]
        if (!Number.isSafeInteger(version) || version < 1 || secret === undefined)
          throw new Error('missing registration-token key version')
        const keyBytes = new TextEncoder().encode(secret)
        if (keyBytes.byteLength < 32) {
          keyBytes.fill(0)
          throw new Error('registration-token key is too short')
        }
        try {
          const key = await crypto.subtle.importKey(
            'raw',
            buffer(keyBytes),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          )
          return new Uint8Array(
            await crypto.subtle.sign(
              'HMAC',
              key,
              new TextEncoder().encode(
                `gridora:node-registration-token:v1:${version}:${scope.organizationId}:${scope.nodeId}:${scope.operationId}:${scope.tokenRecordId}`,
              ),
            ),
          )
        } finally {
          keyBytes.fill(0)
        }
      },
      catch: () => new RegistrationTokenSecretError({ operation: 'registration-token.derive' }),
    })
  const tokenHash = (token: Uint8Array) =>
    Effect.tryPromise({
      try: async () =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(token))), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      catch: () => new RegistrationTokenSecretError({ operation: 'registration-token.hash' }),
    })
  return {
    hashFor: (scope) =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(options.activeVersion) || options.activeVersion < 1)
          return yield* new RegistrationTokenSecretError({
            operation: 'registration-token.active-version',
          })
        const token = yield* derive(scope, options.activeVersion)
        try {
          return { keyVersion: options.activeVersion, tokenHash: yield* tokenHash(token) }
        } finally {
          token.fill(0)
        }
      }),
    recoverBytes: (scope, keyVersion, expectedHash) =>
      Effect.gen(function* () {
        const token = yield* derive(scope, keyVersion)
        const actual = yield* tokenHash(token).pipe(
          Effect.tapError(() => Effect.sync(() => token.fill(0))),
        )
        if (!constantTimeEqual(actual, expectedHash)) {
          token.fill(0)
          return yield* new RegistrationTokenSecretError({
            operation: 'registration-token.hash-mismatch',
          })
        }
        return token
      }),
  }
}

export const nodeProvisionPolicyAdmission: NodeProvisionPolicyAdmissionShape = {
  admit: (intent, facts, nowEpochMilliseconds) => {
    if (
      facts.organizationId !== facts.policy.organizationId ||
      facts.organizationId !== facts.usage.organizationId
    )
      return Effect.fail(
        new NodeProvisionAdmissionDeniedError({
          code: 'admission_tenant_mismatch',
          message: 'Provision admission facts do not belong to one organization',
        }),
      )
    const decision = evaluatePolicyAdmission({
      policy: facts.policy,
      request: {
        organizationId: facts.organizationId,
        action: 'provision-node',
        provider: facts.providerType,
        region: facts.region,
        plan: facts.plan,
        dedicatedNode: intent.placementMode === 'dedicated',
        targetNodeId: null,
        resources: null,
        temporaryNodeLifetimeHours: intent.temporaryLifetimeHours,
        destructiveBackup: 'not-applicable',
        nonHourlyCommitmentConfirmed: intent.nonHourlyCommitmentConfirmed,
        updateContext: { mode: 'not-applicable', category: 'not-applicable' },
      },
      usage: facts.usage,
      price: {
        status: 'known',
        provider: facts.providerType,
        region: facts.region,
        plan: facts.plan,
        currency: facts.price.currency,
        estimatedMonthlyMinor: facts.price.estimatedMonthlyMinor,
        billingCadence: facts.price.billingCadence,
        contractMonths: facts.price.contractMonths,
        observedAtEpochMilliseconds: Date.parse(facts.catalogRefreshedAt),
        validUntilEpochMilliseconds: facts.catalogValidUntilEpochMilliseconds,
      },
      nowEpochMilliseconds,
    })
    if (decision.outcome === 'deny') {
      const first = decision.violations[0]
      return Effect.fail(
        new NodeProvisionAdmissionDeniedError({
          code: first?.code ?? 'policy_denied',
          message: first?.message ?? 'Organization policy denied node provisioning',
        }),
      )
    }
    const projected = facts.usage.estimatedCommittedMonthlyMinor + facts.price.estimatedMonthlyMinor
    if (!Number.isSafeInteger(projected))
      return Effect.fail(
        new NodeProvisionAdmissionDeniedError({
          code: 'unsafe_spend_projection',
          message: 'Projected estimated monthly spend is outside safe integer range',
        }),
      )
    if (
      facts.allocationMonthlyBudgetMinor !== null &&
      projected > facts.allocationMonthlyBudgetMinor
    )
      return Effect.fail(
        new NodeProvisionAdmissionDeniedError({
          code: 'allocation_budget_exceeded',
          message: 'Provider allocation monthly budget would be exceeded',
        }),
      )
    return Effect.succeed({
      providerType: facts.providerType,
      currency: facts.price.currency,
      estimatedMonthlyMinor: facts.price.estimatedMonthlyMinor,
      billingCadence: facts.price.billingCadence,
      contractMonths: facts.price.contractMonths,
      committedMonthlyBeforeMinor: facts.usage.estimatedCommittedMonthlyMinor,
      projectedCommittedMonthlyMinor: projected,
      warnings: decision.warnings,
    })
  },
}

const CommandContract = Schema.Struct({
  organizationId: Identifier,
  actorId: Identifier,
  actorRole: Schema.Literals(['owner', 'administrator', 'operator', 'viewer']),
  idempotencyKey: IdempotencyKey,
  correlationId: Identifier,
  intent: CreateNodeIntent,
})

const validateCommand = (command: NodeProvisionCommand) =>
  Schema.decodeUnknownEffect(CommandContract, { onExcessProperty: 'error' })(command).pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new NodeProvisionValidationError({
          code: 'invalid_node_provision_command',
          message: 'Node provision command is invalid',
        }),
    ),
  )

const startAccepted = (
  repository: NodeProvisionRepositoryShape,
  workflows: NodeProvisionWorkflowStarterShape,
  acceptance: NodeProvisionAcceptance,
) =>
  acceptance.workflowStart.state === 'started'
    ? Effect.succeed(true)
    : workflows.start(acceptance).pipe(
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
                Effect.as(false),
              ),
          onSuccess: () =>
            repository
              .markWorkflowStarted(acceptance.organizationId, acceptance.operationId)
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
        }),
      )

export interface NodeProvisionControlShape {
  readonly submit: (
    command: NodeProvisionCommand,
  ) => Effect.Effect<NodeProvisionResult, NodeProvisionControlError>
  /**
   * Accepts a parent-reviewed selection without performing a replacement
   * catalog/allocation selection. It is internal-only: public node creation
   * continues to use `submit` and accepts intent alone.
   */
  readonly submitAccepted: (
    command: NodeProvisionCommand,
    reviewed: ReviewedNodeProvision,
  ) => Effect.Effect<NodeProvisionResult, NodeProvisionControlError>
}
export class NodeProvisionControl extends Context.Service<
  NodeProvisionControl,
  NodeProvisionControlShape
>()('@gridora/node-provision-control/NodeProvisionControl') {}

export const makeNodeProvisionControl = (dependencies: {
  readonly repository: NodeProvisionRepositoryShape
  readonly facts: NodeProvisionFactsPortShape
  readonly policy: NodeProvisionPolicyAdmissionShape
  readonly identities: NodeProvisionIdentityPortShape
  readonly registrationTokens: RegistrationTokenSecretShape
  readonly clock: NodeProvisionClockShape
  readonly workflows: NodeProvisionWorkflowStarterShape
}): NodeProvisionControlShape => ({
  submit: (command) =>
    Effect.gen(function* () {
      yield* validateCommand(command)
      if (command.actorRole !== 'owner' && command.actorRole !== 'administrator')
        return yield* new NodeProvisionAuthorizationError({ code: 'administrator_required' })
      const fingerprint = yield* dependencies.identities.fingerprint(command)
      const replay = yield* dependencies.repository.findReplay(
        command.organizationId,
        command.idempotencyKey,
        fingerprint,
      )
      const accepted = yield* Effect.gen(function* () {
        if (replay !== null) return { ...replay, disposition: 'adopted' as const }
        const identity = yield* dependencies.identities.derive(command, fingerprint)
        const facts = yield* dependencies.facts.resolve({
          organizationId: command.organizationId,
          nodeId: identity.nodeId,
          intent: command.intent,
        })
        const current = yield* dependencies.clock.now
        const billing = yield* dependencies.policy.admit(
          command.intent,
          facts,
          current.epochMilliseconds,
        )
        const bootstrapToken = yield* dependencies.registrationTokens.hashFor({
          organizationId: command.organizationId,
          nodeId: identity.nodeId,
          operationId: identity.operationId,
          tokenRecordId: identity.bootstrapTokenRecordId,
        })
        return yield* dependencies.repository.acceptAtomic({
          command,
          identity,
          fingerprint,
          facts,
          billing,
          bootstrapToken,
          now: current.iso,
        })
      })
      const started = yield* startAccepted(
        dependencies.repository,
        dependencies.workflows,
        accepted,
      )
      return {
        disposition: accepted.disposition,
        nodeId: accepted.nodeId,
        operationId: accepted.operationId,
        workflowState: started ? 'started' : 'pending-reconciliation',
        billing: accepted.billing,
      }
    }),
  submitAccepted: (command, reviewed) =>
    Effect.gen(function* () {
      yield* validateCommand(command)
      if (command.actorRole !== 'owner' && command.actorRole !== 'administrator')
        return yield* new NodeProvisionAuthorizationError({ code: 'administrator_required' })
      // This verifies only the immutable parent snapshot. It never reads live
      // selection state, so an exact response-loss replay remains adoptable
      // before any mutable provider/allocation/policy lookup.
      yield* verifyReviewedNodeProvision(reviewed)
      const fingerprint = yield* reviewedFingerprint(command, reviewed.selectionDigest)
      const replay = yield* dependencies.repository.findReplay(
        command.organizationId,
        command.idempotencyKey,
        fingerprint,
      )
      const accepted = yield* Effect.gen(function* () {
        if (replay !== null) return { ...replay, disposition: 'adopted' as const }
        const resolveReviewed = dependencies.facts.resolveReviewed
        if (resolveReviewed === undefined)
          return yield* new NodeProvisionFactsUnavailableError({
            operation: 'node-provision.reviewed-facts.port-unavailable',
          })
        const identity = yield* dependencies.identities.derive(command, fingerprint)
        const facts = yield* resolveReviewed({
          organizationId: command.organizationId,
          nodeId: identity.nodeId,
          intent: command.intent,
          reviewed,
        })
        const current = yield* dependencies.clock.now
        const billing = yield* dependencies.policy.admit(
          command.intent,
          facts,
          current.epochMilliseconds,
        )
        if (
          canonicalReviewedNodeProvision({ facts, billing }) !==
          canonicalReviewedNodeProvision({ facts: reviewed.facts, billing: reviewed.billing })
        )
          return yield* new NodeProvisionFactsUnavailableError({
            operation: 'node-provision.reviewed-facts-or-billing-drift',
          })
        const bootstrapToken = yield* dependencies.registrationTokens.hashFor({
          organizationId: command.organizationId,
          nodeId: identity.nodeId,
          operationId: identity.operationId,
          tokenRecordId: identity.bootstrapTokenRecordId,
        })
        return yield* dependencies.repository.acceptAtomic({
          command,
          identity,
          fingerprint,
          facts,
          billing,
          bootstrapToken,
          now: current.iso,
        })
      })
      const started = yield* startAccepted(
        dependencies.repository,
        dependencies.workflows,
        accepted,
      )
      return {
        disposition: accepted.disposition,
        nodeId: accepted.nodeId,
        operationId: accepted.operationId,
        workflowState: started ? 'started' : 'pending-reconciliation',
        billing: accepted.billing,
      }
    }),
})

export const NodeProvisionControlLive = Layer.effect(
  NodeProvisionControl,
  Effect.gen(function* () {
    return NodeProvisionControl.of(
      makeNodeProvisionControl({
        repository: yield* NodeProvisionRepository,
        facts: yield* NodeProvisionFactsPort,
        policy: yield* NodeProvisionPolicyAdmission,
        identities: yield* NodeProvisionIdentityPort,
        registrationTokens: yield* RegistrationTokenSecret,
        clock: yield* NodeProvisionClock,
        workflows: yield* NodeProvisionWorkflowStarter,
      }),
    )
  }),
)

export const NodeProvisionPolicyAdmissionLive = Layer.succeed(
  NodeProvisionPolicyAdmission,
  nodeProvisionPolicyAdmission,
)

export const NodeProvisionAcceptanceContract = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  organizationId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  idempotencyKey: IdempotencyKey,
  fingerprint: Sha256,
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  placementMode: Schema.Literals(['shared', 'dedicated']),
  billing: Schema.Struct({
    providerType: Schema.Literals(['ovhcloud', 'contabo']),
    currency: Currency,
    estimatedMonthlyMinor: NonNegativeInteger,
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: PositiveInteger,
    committedMonthlyBeforeMinor: NonNegativeInteger,
    projectedCommittedMonthlyMinor: NonNegativeInteger,
    warnings: Schema.Array(
      Schema.Struct({
        code: Schema.Literal('soft_budget_exceeded'),
        message: Schema.String,
        projectedEstimatedMonthlyMinor: NonNegativeInteger,
        currency: Currency,
      }),
    ),
  }),
  workflowStart: Schema.Struct({
    id: Identifier,
    state: Schema.Literals(['pending', 'started']),
    attempts: NonNegativeInteger,
    lastError: Schema.NullOr(Schema.String),
  }),
})

export const RegistrationTokenHashContract = Schema.Struct({
  keyVersion: PositiveInteger,
  tokenHash: Sha256,
})

export const NodeProvisionExecutionReservationContract = Schema.Struct({
  organizationId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  providerAccountId: Identifier,
  providerAccountRevision: PositiveInteger,
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  region: Identifier,
  plan: Identifier,
  imageId: Identifier,
  imageVersion: Identifier,
  imageChecksum: ImageChecksum,
  providerImageId: Identifier,
  placementMode: Schema.Literals(['shared', 'dedicated']),
  billing: Schema.Struct({
    currency: Currency,
    estimatedMonthlyMinor: NonNegativeInteger,
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: PositiveInteger,
    nonHourlyCommitmentConfirmed: Schema.Boolean,
    catalogRefreshedAt: Timestamp,
  }),
  bootstrapToken: Schema.Struct({
    recordId: Identifier,
    keyVersion: PositiveInteger,
    tokenHash: Sha256,
    state: Schema.Literals(['reserved', 'materialized', 'consumed', 'revoked']),
    expiresAt: Timestamp,
  }),
  workflowStart: Schema.Struct({
    id: Identifier,
    state: Schema.Literals(['pending', 'started']),
  }),
})

export const ProvisionTimestamp = Timestamp

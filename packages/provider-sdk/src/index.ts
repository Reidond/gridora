import { Context, Effect, Schema } from 'effect'

export type OrganizationId = string
export type OperationId = string
export type ProviderNodeId = string
export type ProviderId = 'ovhcloud' | 'contabo'
export type ProviderAccountRef =
  | { readonly id: string; readonly provider: ProviderId; readonly scope: 'platform' }
  | {
      readonly id: string
      readonly provider: ProviderId
      readonly scope: 'organization'
      readonly organizationId: OrganizationId
    }

const providerErrorFields = {
  provider: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}

export class ProviderAuthenticationError extends Schema.TaggedError<ProviderAuthenticationError>()(
  'ProviderAuthenticationError',
  providerErrorFields,
) {}
export class ProviderAuthorizationError extends Schema.TaggedError<ProviderAuthorizationError>()(
  'ProviderAuthorizationError',
  providerErrorFields,
) {}
export class ProviderValidationError extends Schema.TaggedError<ProviderValidationError>()(
  'ProviderValidationError',
  { ...providerErrorFields, field: Schema.optional(Schema.String) },
) {}
export class ProviderQuotaError extends Schema.TaggedError<ProviderQuotaError>()(
  'ProviderQuotaError',
  providerErrorFields,
) {}
export class ProviderNotFoundError extends Schema.TaggedError<ProviderNotFoundError>()(
  'ProviderNotFoundError',
  providerErrorFields,
) {}
export class ProviderConflictError extends Schema.TaggedError<ProviderConflictError>()(
  'ProviderConflictError',
  providerErrorFields,
) {}
export class ProviderRateLimitError extends Schema.TaggedError<ProviderRateLimitError>()(
  'ProviderRateLimitError',
  { ...providerErrorFields, retryAfterSeconds: Schema.optional(Schema.Number) },
) {}
export class ProviderTemporaryError extends Schema.TaggedError<ProviderTemporaryError>()(
  'ProviderTemporaryError',
  providerErrorFields,
) {}
/**
 * The provider may have accepted a paid create although its response was lost.
 * Persist this result and retry the operation in `adopt_only` mode; generic retry loops must not POST.
 */
export class ProviderCreateUncertainError extends Schema.TaggedError<ProviderCreateUncertainError>()(
  'ProviderCreateUncertainError',
  {
    ...providerErrorFields,
    organizationId: Schema.String,
    operationId: Schema.String,
    retryMode: Schema.Literal('adopt_only'),
    stabilizationAttempts: Schema.Number,
    nextAttemptNumber: Schema.Number,
    nextAttemptAtEpochMs: Schema.Number,
    recoveryDeadlineAtEpochMs: Schema.Number,
  },
) {}
export class ProviderBillingActionRequiredError extends Schema.TaggedError<ProviderBillingActionRequiredError>()(
  'ProviderBillingActionRequiredError',
  providerErrorFields,
) {}
export class ProviderUnsupportedCapabilityError extends Schema.TaggedError<ProviderUnsupportedCapabilityError>()(
  'ProviderUnsupportedCapabilityError',
  { ...providerErrorFields, capability: Schema.String },
) {}
export class ProviderUnknownError extends Schema.TaggedError<ProviderUnknownError>()(
  'ProviderUnknownError',
  providerErrorFields,
) {}

export type ProviderError =
  | ProviderAuthenticationError
  | ProviderAuthorizationError
  | ProviderValidationError
  | ProviderQuotaError
  | ProviderNotFoundError
  | ProviderConflictError
  | ProviderRateLimitError
  | ProviderTemporaryError
  | ProviderCreateUncertainError
  | ProviderBillingActionRequiredError
  | ProviderUnsupportedCapabilityError
  | ProviderUnknownError

export const isRetryableProviderError = (error: ProviderError): boolean =>
  error._tag === 'ProviderRateLimitError' || error._tag === 'ProviderTemporaryError'

export const authorizeProviderAccount = (
  account: ProviderAccountRef,
  expectedProvider: ProviderId,
  organizationId: OrganizationId,
  operation: string,
): Effect.Effect<void, ProviderError> => {
  if (account.provider !== expectedProvider)
    return Effect.fail(
      new ProviderValidationError({
        provider: expectedProvider,
        operation,
        field: 'providerAccountId',
        message: `provider account ${account.id} is not a ${expectedProvider} account`,
      }),
    )
  if (account.scope === 'organization' && account.organizationId !== organizationId)
    return Effect.fail(
      new ProviderAuthorizationError({
        provider: expectedProvider,
        operation,
        message: 'provider account belongs to another organization',
      }),
    )
  return Effect.void
}

export interface ProviderCapabilities {
  readonly hourlyBilling: boolean
  readonly immediateDelete: boolean
  readonly scheduledCancellation: boolean
  readonly cloudInit: boolean
  readonly customImages: boolean
  readonly snapshots: boolean
  readonly nativeFirewall: boolean
  readonly privateNetworking: boolean
  readonly floatingIp: boolean
  readonly rebuild: boolean
}

export interface Region {
  readonly id: string
  readonly displayName: string
}
export interface Plan {
  readonly id: string
  readonly regionId: string
  readonly cpu: number
  readonly memoryMiB: number
  readonly diskGiB: number
  readonly estimatedMonthlyCost?: number
}
export interface ProviderImage {
  readonly id: string
  readonly name: string
  readonly architecture: 'amd64' | 'arm64'
  readonly version?: string
}
export interface ProviderNodeMetadata {
  readonly managedBy: 'gridora'
  readonly organizationId: OrganizationId
  readonly nodeId: string
  readonly operationId: OperationId
  readonly imageVersion: string
}
export interface ProviderNode {
  readonly id: ProviderNodeId
  readonly name: string
  readonly state:
    | 'creating'
    | 'active'
    | 'stopped'
    | 'rebuilding'
    | 'retiring'
    | 'retired'
    | 'unknown'
  readonly regionId: string
  readonly planId: string
  readonly addresses: readonly string[]
  readonly metadata: ProviderNodeMetadata
  readonly contract?: {
    readonly periodEndsAt: string
    readonly cancellationDate?: string
    readonly billingStopsAt?: string
  }
}
export interface ProviderSnapshot {
  readonly id: string
  readonly nodeId: ProviderNodeId
  readonly state: 'creating' | 'ready' | 'failed'
}
export interface FirewallRule {
  readonly protocol: 'tcp' | 'udp'
  readonly portFrom: number
  readonly portTo: number
  readonly sourceCidrs: readonly string[]
}
export interface FirewallResult {
  readonly applied: boolean
  readonly mode: 'native' | 'host-only'
  readonly rules: readonly FirewallRule[]
}
export type RetirementResult =
  | { readonly kind: 'deleted'; readonly billingStopped: true }
  | {
      readonly kind: 'cancel_at_earliest_date'
      readonly cancellationDate: string
      readonly billingStopsAt: string
    }
  | {
      readonly kind: 'secure_wipe_and_stop'
      readonly billingStopped: false
      readonly cancellationDate?: string
    }
  | {
      readonly kind: 'cancel_scheduled'
      readonly cancellationDate: string
      readonly billingStopsAt: string
    }
  | { readonly kind: 'contract_ended'; readonly billingStopped: true; readonly endedAt: string }

export interface ProviderContext {
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
}
export interface CreateNodeInput extends ProviderContext {
  readonly nodeId: string
  readonly name: string
  readonly regionId: string
  readonly planId: string
  readonly imageId: string
  readonly imageVersion: string
  readonly cloudInit?: string
  /** Required after `ProviderCreateUncertainError`; forbids another paid create POST. */
  readonly createMode?: 'create_or_adopt' | 'adopt_only'
  /** Durable provider-attempt number. It is never used to permit another create. */
  readonly adoptionAttempt?: number
  /** Durable bootstrap visibility deadline. Exhaustion keeps orphan reconciliation fail-closed. */
  readonly adoptionDeadlineAtEpochMs?: number
}
export interface GetNodeInput {
  readonly organizationId: OrganizationId
  readonly providerNodeId: ProviderNodeId
}
export interface ListNodesInput {
  readonly organizationId: OrganizationId
  readonly operationId?: OperationId
}
export interface NodeActionInput extends GetNodeInput {
  readonly operationId: OperationId
  /** Canonical Gridora node identity expected in provider-managed metadata. */
  readonly nodeId: string
}
export interface RebuildNodeInput extends NodeActionInput {
  readonly imageId: string
  readonly imageVersion: string
  readonly cloudInit?: string
}
export interface RetireNodeInput extends NodeActionInput {
  readonly mode?: 'delete' | 'cancel_at_earliest_date' | 'secure_wipe_and_stop'
}
export interface CreateSnapshotInput extends NodeActionInput {
  readonly name: string
}
export interface DeleteSnapshotInput extends ProviderContext {
  readonly providerNodeId: ProviderNodeId
  readonly nodeId: string
  readonly snapshotId: string
}
export interface ApplyFirewallInput extends NodeActionInput {
  readonly rules: readonly FirewallRule[]
  readonly allowHostOnlyFallback: boolean
}
export interface ListRegionsInput {
  readonly organizationId: OrganizationId
}
export interface ListPlansInput extends ListRegionsInput {
  readonly regionId?: string
}
export interface ListImagesInput extends ListRegionsInput {
  readonly regionId?: string
}

export type ProviderEffect<A> = Effect.Effect<A, ProviderError>
export interface ComputeProviderShape {
  readonly capabilities: ProviderCapabilities
  readonly listRegions: (input: ListRegionsInput) => ProviderEffect<readonly Region[]>
  readonly listPlans: (input: ListPlansInput) => ProviderEffect<readonly Plan[]>
  readonly listImages: (input: ListImagesInput) => ProviderEffect<readonly ProviderImage[]>
  readonly createNode: (input: CreateNodeInput) => ProviderEffect<ProviderNode>
  readonly getNode: (input: GetNodeInput) => ProviderEffect<ProviderNode>
  readonly listNodes: (input: ListNodesInput) => ProviderEffect<readonly ProviderNode[]>
  readonly startNode: (input: NodeActionInput) => ProviderEffect<void>
  readonly stopNode: (input: NodeActionInput) => ProviderEffect<void>
  readonly rebootNode: (input: NodeActionInput) => ProviderEffect<void>
  readonly rebuildNode: (input: RebuildNodeInput) => ProviderEffect<void>
  readonly retireNode: (input: RetireNodeInput) => ProviderEffect<RetirementResult>
  readonly createSnapshot: (input: CreateSnapshotInput) => ProviderEffect<ProviderSnapshot>
  readonly deleteSnapshot: (input: DeleteSnapshotInput) => ProviderEffect<void>
  readonly applyFirewall: (input: ApplyFirewallInput) => ProviderEffect<FirewallResult>
}
export class ComputeProvider extends Context.Service<ComputeProvider, ComputeProviderShape>()(
  '@gridora/provider-sdk/ComputeProvider',
) {}

export interface JsonHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}
export interface JsonHttpResponse {
  readonly status: number
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}
export class ProviderTransportError extends Schema.TaggedError<ProviderTransportError>()(
  'ProviderTransportError',
  { message: Schema.String, retryable: Schema.Boolean },
) {}
export interface JsonHttpClientShape {
  readonly request: (
    request: JsonHttpRequest,
  ) => Effect.Effect<JsonHttpResponse, ProviderTransportError>
}
export class JsonHttpClient extends Context.Service<JsonHttpClient, JsonHttpClientShape>()(
  '@gridora/provider-sdk/JsonHttpClient',
) {}
export interface FetchJsonHttpClientOptions {
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
}
/** Concrete cancellable Fetch adapter. Authentication headers are supplied by the composition root and never logged. */
export const makeFetchJsonHttpClient = (
  options: FetchJsonHttpClientOptions,
): JsonHttpClientShape => ({
  request: (request) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(new URL(request.path, options.baseUrl), {
          method: request.method,
          headers: {
            accept: 'application/json',
            ...options.headers,
            ...request.headers,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal,
        })
        const text = await response.text()
        let body: unknown = undefined
        if (text.length > 0) {
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
        }
        return {
          status: response.status,
          body,
          headers: Object.fromEntries(response.headers.entries()),
        }
      },
      catch: (cause) =>
        new ProviderTransportError({
          message: cause instanceof Error ? cause.message : 'provider transport failure',
          retryable: true,
        }),
    }),
})

export const managedMetadata = (input: CreateNodeInput): ProviderNodeMetadata => ({
  managedBy: 'gridora',
  organizationId: input.organizationId,
  nodeId: input.nodeId,
  operationId: input.operationId,
  imageVersion: input.imageVersion,
})

export interface CreateOrAdoptOptions {
  readonly provider?: string
  /** Multiple observations prevent eventual-consistency gaps from becoming duplicate paid creates. */
  readonly stabilizationAttempts?: number
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Number of observations completed by a prior durable invocation. */
  readonly attemptOffset?: number
  readonly scheduler?: ProviderStabilizationScheduler
}

export interface ProviderStabilizationScheduler {
  readonly nowEpochMs: Effect.Effect<number>
  readonly sleep: (milliseconds: number) => Effect.Effect<void>
}

/** Production default. Tests should inject a virtual implementation and never wait on wall time. */
export const RealProviderStabilizationScheduler: ProviderStabilizationScheduler = {
  nowEpochMs: Effect.sync(() => Date.now()),
  sleep: (milliseconds) => Effect.sleep(`${milliseconds} millis`),
}

interface StabilizationResult {
  readonly node?: ProviderNode
  readonly observations: number
  readonly nextDelayMs: number
}

const matchingCreate = (input: CreateNodeInput, nodes: readonly ProviderNode[]) =>
  nodes.filter(
    (node) =>
      node.metadata.managedBy === 'gridora' &&
      node.metadata.organizationId === input.organizationId &&
      node.metadata.nodeId === input.nodeId &&
      node.metadata.operationId === input.operationId,
  )

const collidingCreate = (input: CreateNodeInput, nodes: readonly ProviderNode[]) =>
  nodes.some(
    (node) =>
      node.metadata.managedBy === 'gridora' &&
      node.metadata.organizationId === input.organizationId &&
      node.metadata.operationId === input.operationId &&
      node.metadata.nodeId !== input.nodeId,
  )

const stabilizeCreate = (
  input: CreateNodeInput,
  find: (input: ListNodesInput) => ProviderEffect<readonly ProviderNode[]>,
  provider: string,
  attempts: number,
  scheduler: ProviderStabilizationScheduler,
  initialBackoffMs: number,
  maxBackoffMs: number,
  attemptOffset: number,
): ProviderEffect<StabilizationResult> => {
  const delayFor = (zeroBasedAttempt: number) =>
    Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.min(zeroBasedAttempt, 20))
  const poll = (observation: number): ProviderEffect<StabilizationResult> =>
    Effect.suspend(() =>
      Effect.flatMap(
        find({ organizationId: input.organizationId, operationId: input.operationId }),
        (nodes) => {
          if (collidingCreate(input, nodes))
            return Effect.fail(
              new ProviderConflictError({
                provider,
                operation: 'createNode',
                message: 'operation metadata belongs to another canonical node',
              }),
            )
          const exact = matchingCreate(input, nodes)
          if (exact.length === 1)
            return Effect.succeed({
              node: exact[0],
              observations: observation,
              nextDelayMs: delayFor(attemptOffset + observation - 1),
            })
          if (exact.length > 1)
            return Effect.fail(
              new ProviderConflictError({
                provider,
                operation: 'createNode',
                message: 'multiple resources match operation metadata',
              }),
            )
          const nextDelayMs = delayFor(attemptOffset + observation - 1)
          return observation < attempts
            ? Effect.andThen(scheduler.sleep(nextDelayMs), poll(observation + 1))
            : Effect.succeed({ observations: observation, nextDelayMs })
        },
      ),
    )
  return poll(1)
}

const uncertain = (
  input: CreateNodeInput,
  provider: string,
  message: string,
  result: StabilizationResult,
  scheduler: ProviderStabilizationScheduler,
  attemptOffset: number,
) =>
  Effect.map(
    scheduler.nowEpochMs,
    (now) =>
      new ProviderCreateUncertainError({
        provider,
        operation: 'createNode',
        message,
        organizationId: input.organizationId,
        operationId: input.operationId,
        retryMode: 'adopt_only',
        stabilizationAttempts: result.observations,
        nextAttemptNumber: attemptOffset + result.observations + 1,
        nextAttemptAtEpochMs: Math.floor(now) + result.nextDelayMs,
        recoveryDeadlineAtEpochMs:
          input.adoptionDeadlineAtEpochMs ?? Math.floor(now) + 15 * 60 * 1000,
      }),
  )

/** Adopt first, create second. Uncertain creates are stabilized and then fail closed as adopt-only. */
export const createOrAdopt = (
  input: CreateNodeInput,
  find: (input: ListNodesInput) => ProviderEffect<readonly ProviderNode[]>,
  create: (input: CreateNodeInput) => ProviderEffect<ProviderNode>,
  options: CreateOrAdoptOptions = {},
): ProviderEffect<ProviderNode> =>
  Effect.gen(function* () {
    const provider = options.provider ?? 'unknown'
    const attempts = Math.max(2, Math.min(Math.floor(options.stabilizationAttempts ?? 4), 10))
    const initialBackoffMs = Math.max(
      1,
      Math.min(Math.floor(options.initialBackoffMs ?? 250), 30_000),
    )
    const maxBackoffMs = Math.max(
      initialBackoffMs,
      Math.min(Math.floor(options.maxBackoffMs ?? 4_000), 60_000),
    )
    const attemptOffset = Math.max(0, Math.floor(options.attemptOffset ?? 0))
    const scheduler = options.scheduler ?? RealProviderStabilizationScheduler
    const adopted = yield* stabilizeCreate(
      input,
      find,
      provider,
      attempts,
      scheduler,
      initialBackoffMs,
      maxBackoffMs,
      attemptOffset,
    )
    if (adopted.node !== undefined) return adopted.node
    if (input.createMode === 'adopt_only') {
      return yield* Effect.flatMap(
        uncertain(
          input,
          provider,
          'create outcome remains uncertain; another create is forbidden',
          adopted,
          scheduler,
          attemptOffset,
        ),
        Effect.fail,
      )
    }
    return yield* create(input).pipe(
      Effect.catch((error) => {
        if (!isRetryableProviderError(error)) return Effect.fail(error)
        return Effect.flatMap(
          stabilizeCreate(
            input,
            find,
            provider,
            attempts,
            scheduler,
            initialBackoffMs,
            maxBackoffMs,
            attemptOffset + adopted.observations,
          ),
          (afterCreate) =>
            afterCreate.node !== undefined
              ? Effect.succeed(afterCreate.node)
              : Effect.flatMap(
                  uncertain(
                    input,
                    provider,
                    'provider create may have succeeded but could not be stabilized',
                    afterCreate,
                    scheduler,
                    attemptOffset + adopted.observations,
                  ),
                  Effect.fail,
                ),
        )
      }),
    )
  })

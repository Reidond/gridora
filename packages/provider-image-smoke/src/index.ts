import { createHash } from 'node:crypto'
import { Cause, Clock, Context, Duration, Effect, Exit, Schema } from 'effect'
import { validateAgentHealthSample, type AgentHealthSample } from '@gridora/agent-telemetry'
import {
  makeProviderImageRegistrationTransport,
  type ProviderImageRegistrationRemoteShape,
  type ProviderImageRegistrationRequest,
} from '@gridora/provider-image-registration'
import {
  createOrAdopt,
  type CreateNodeInput,
  type ProviderError,
  type ProviderId,
  type ProviderNode,
  type ProviderStabilizationScheduler,
} from '@gridora/provider-sdk'

/** The smoke lane owns one provider metadata namespace. Orphan reconciliation reports anything left in it. */
export const SMOKE_ORGANIZATION_ID = 'platform-image-smoke'
export const DEFAULT_SMOKE_IMAGE_ID = 'gridora-node'
export const SMOKE_TTL_MINUTES = { minimum: 1, maximum: 60 } as const

export interface ProviderImageSmokeLimits {
  /** Delay between bounded provider and agent observations. */
  readonly pollIntervalMs: number
  readonly imageReadyTimeoutMs: number
  readonly bootTimeoutMs: number
  readonly agentHealthTimeoutMs: number
  /** Cleanup has its own budget so an expired TTL still reconciles every resource. */
  readonly cleanupTimeoutMs: number
  /** Adopt-only discovery attempts after an uncertain image import or node create. */
  readonly maxAdoptionAttempts: number
}

export const DEFAULT_SMOKE_LIMITS: ProviderImageSmokeLimits = {
  pollIntervalMs: 15_000,
  imageReadyTimeoutMs: 20 * 60_000,
  bootTimeoutMs: 15 * 60_000,
  agentHealthTimeoutMs: 10 * 60_000,
  cleanupTimeoutMs: 15 * 60_000,
  maxAdoptionAttempts: 6,
}

export interface ProviderImageSmokeInput {
  readonly provider: ProviderId
  readonly providerAccountId: string
  readonly region: string
  readonly plan: string
  readonly ttlMinutes: number
  /** GitHub run coordinate, for example `123456789.1`. */
  readonly runId: string
  readonly sourceCommit: string
  readonly artifactDigest: string
  readonly imageVersion: string
  /** Short-lived HTTPS artifact locator. It is sent to the provider once and never returned. */
  readonly artifactUrl: string
  readonly imageId?: string
  readonly cloudInit?: string
  readonly limits?: Partial<ProviderImageSmokeLimits>
}

const SmokeStage = Schema.Literals([
  'input',
  'credentials',
  'live-gate',
  'image-import',
  'image-ready',
  'node-create',
  'boot',
  'agent-health',
  'ttl',
  'cleanup',
])
export type ProviderImageSmokeStage = typeof SmokeStage.Type

export const ProviderImageSmokeCleanupReceipt = Schema.Struct({
  resource: Schema.Literals(['node', 'image']),
  providerResourceIds: Schema.Array(Schema.String),
  disposition: Schema.Literals(['deleted', 'cancellation-scheduled', 'absent', 'unconfirmed']),
  confirmed: Schema.Boolean,
  failureCode: Schema.optional(Schema.String),
})
export type ProviderImageSmokeCleanupReceipt = typeof ProviderImageSmokeCleanupReceipt.Type

export const ProviderImageSmokeCleanup = Schema.Struct({
  node: ProviderImageSmokeCleanupReceipt,
  image: ProviderImageSmokeCleanupReceipt,
})
export type ProviderImageSmokeCleanup = typeof ProviderImageSmokeCleanup.Type

/**
 * The evidence is built from typed fields only. It never carries a credential,
 * token, artifact locator, or provider response body.
 */
export const ProviderImageSmokeEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  result: Schema.Literal('passed'),
  provider: Schema.Literals(['ovhcloud', 'contabo']),
  region: Schema.String,
  plan: Schema.String,
  runId: Schema.String,
  sourceCommit: Schema.String,
  artifactDigest: Schema.String,
  imageVersion: Schema.String,
  idempotencyKey: Schema.String,
  ttlMinutes: Schema.Number,
  providerImageId: Schema.String,
  imageRegistration: Schema.Literals(['registered', 'adopted']),
  providerNodeId: Schema.String,
  bootDurationMs: Schema.Number,
  agentHealth: Schema.Struct({
    outcome: Schema.Literal('healthy'),
    agentVersion: Schema.String,
    docker: Schema.String,
    firewall: Schema.String,
    tunnel: Schema.String,
    observedAfterMs: Schema.Number,
  }),
  cleanup: ProviderImageSmokeCleanup,
  startedAtEpochMs: Schema.Number,
  finishedAtEpochMs: Schema.Number,
})
export type ProviderImageSmokeEvidence = typeof ProviderImageSmokeEvidence.Type

/** Operator-visible failure. `code` is a fixed token or a provider error tag, never a response body. */
export class ProviderImageSmokeError extends Schema.TaggedError<ProviderImageSmokeError>()(
  'ProviderImageSmokeError',
  {
    stage: SmokeStage,
    code: Schema.String,
    message: Schema.String,
    cleanup: Schema.optional(ProviderImageSmokeCleanup),
  },
) {}

export class AgentHealthObservationError extends Schema.TaggedError<AgentHealthObservationError>()(
  'AgentHealthObservationError',
  { code: Schema.String },
) {}

export type ProviderImageObservation = 'pending' | 'ready' | 'failed' | 'absent'
export type ProviderNodeObservation =
  | { readonly kind: 'present'; readonly node: ProviderNode }
  | { readonly kind: 'absent' }

/**
 * Provider-neutral port. Drivers translate their API into these calls and add
 * no smoke policy of their own.
 */
export interface ProviderImageSmokeDriverShape {
  readonly provider: ProviderId
  /** `delete` removes a node immediately; `cancel_contract` records a confirmed provider cancellation. */
  readonly nodeDisposal: 'delete' | 'cancel_contract'
  readonly images: ProviderImageRegistrationRemoteShape
  readonly observeImage: (
    providerImageId: string,
  ) => Effect.Effect<ProviderImageObservation, ProviderError>
  readonly deleteImage: (providerImageId: string) => Effect.Effect<void, ProviderError>
  readonly listNodes: (input: {
    readonly organizationId: string
    readonly operationId: string
  }) => Effect.Effect<readonly ProviderNode[], ProviderError>
  /** One paid create request. Adoption and retries are owned by the smoke service. */
  readonly createNode: (input: CreateNodeInput) => Effect.Effect<ProviderNode, ProviderError>
  readonly observeNode: (
    providerNodeId: string,
  ) => Effect.Effect<ProviderNodeObservation, ProviderError>
  readonly disposeNode: (providerNodeId: string) => Effect.Effect<void, ProviderError>
  /** True only when the observation proves disposal: absence, or a recorded cancellation. */
  readonly nodeDisposed: (observation: ProviderNodeObservation) => boolean
}
export class ProviderImageSmokeDriver extends Context.Service<
  ProviderImageSmokeDriver,
  ProviderImageSmokeDriverShape
>()('@gridora/provider-image-smoke/ProviderImageSmokeDriver') {}

/** Reads the latest agent health sample for the exact smoke node, or `undefined` before the first report. */
export interface AgentHealthObserverShape {
  readonly latest: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly providerNodeId: string
  }) => Effect.Effect<AgentHealthSample | undefined, AgentHealthObservationError>
}
export class AgentHealthObserver extends Context.Service<
  AgentHealthObserver,
  AgentHealthObserverShape
>()('@gridora/provider-image-smoke/AgentHealthObserver') {}

export interface ProviderImageSmokeIdentity {
  readonly idempotencyKey: string
  readonly operationId: string
  readonly nodeId: string
  readonly nodeName: string
  readonly registrationId: string
}

const fail = (stage: ProviderImageSmokeStage, code: string, message: string) =>
  new ProviderImageSmokeError({ stage, code, message })

const providerFailure =
  (stage: ProviderImageSmokeStage, message: string) => (error: ProviderError) =>
    fail(stage, error._tag, message)

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Derives the ADR 0008 idempotency identity from the immutable smoke coordinates. */
export const deriveSmokeIdentity = (input: {
  readonly sourceCommit: string
  readonly artifactDigest: string
  readonly provider: ProviderId
  readonly region: string
  readonly runId: string
}): Effect.Effect<ProviderImageSmokeIdentity> =>
  Effect.sync(() => {
    const canonical = JSON.stringify([
      'gridora-provider-image-smoke-v1',
      input.sourceCommit,
      input.artifactDigest,
      input.provider,
      input.region,
      input.runId,
    ])
    const hex = createHash('sha256').update(canonical, 'utf8').digest('hex')
    return {
      idempotencyKey: `sha256:${hex}`,
      operationId: `smoke-${hex.slice(0, 32)}`,
      nodeId: `smoke-node-${hex.slice(0, 24)}`,
      nodeName: `gridora-smoke-${hex.slice(0, 12)}`,
      registrationId: `smoke-image-${hex.slice(0, 32)}`,
    }
  })

const validArtifactUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

const positive = (value: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= maximum

/** Validation runs before any provider call. */
export const validateSmokeInput = (
  input: ProviderImageSmokeInput,
  driver: Pick<ProviderImageSmokeDriverShape, 'provider'>,
): Effect.Effect<ProviderImageSmokeLimits, ProviderImageSmokeError> => {
  const limits = { ...DEFAULT_SMOKE_LIMITS, ...input.limits }
  if (input.provider !== 'ovhcloud' && input.provider !== 'contabo')
    return Effect.fail(fail('input', 'provider-invalid', 'Smoke provider is not supported'))
  if (driver.provider !== input.provider)
    return Effect.fail(
      fail('input', 'driver-mismatch', 'Smoke driver does not match the requested provider'),
    )
  if (
    !Number.isSafeInteger(input.ttlMinutes) ||
    input.ttlMinutes < SMOKE_TTL_MINUTES.minimum ||
    input.ttlMinutes > SMOKE_TTL_MINUTES.maximum
  )
    return Effect.fail(fail('input', 'ttl-invalid', 'Smoke TTL must be 1 to 60 minutes'))
  if (!identifier.test(input.region))
    return Effect.fail(fail('input', 'region-invalid', 'Smoke region is invalid'))
  if (!identifier.test(input.plan))
    return Effect.fail(fail('input', 'plan-invalid', 'Smoke plan is invalid'))
  if (!identifier.test(input.providerAccountId))
    return Effect.fail(fail('input', 'account-invalid', 'Smoke provider account is invalid'))
  if (!/^[0-9]{1,20}(\.[0-9]{1,6})?$/.test(input.runId))
    return Effect.fail(fail('input', 'run-invalid', 'Smoke run coordinate is invalid'))
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit))
    return Effect.fail(fail('input', 'commit-invalid', 'Smoke source commit is invalid'))
  if (!/^sha256:[0-9a-f]{64}$/.test(input.artifactDigest))
    return Effect.fail(fail('input', 'digest-invalid', 'Smoke artifact digest is invalid'))
  if (!identifier.test(input.imageVersion))
    return Effect.fail(fail('input', 'version-invalid', 'Smoke image version is invalid'))
  if (input.imageId !== undefined && !identifier.test(input.imageId))
    return Effect.fail(fail('input', 'image-invalid', 'Smoke image identifier is invalid'))
  if (!validArtifactUrl(input.artifactUrl))
    return Effect.fail(fail('input', 'artifact-url-invalid', 'Smoke artifact locator is invalid'))
  if (
    !positive(limits.pollIntervalMs, 5 * 60_000) ||
    !positive(limits.imageReadyTimeoutMs, 60 * 60_000) ||
    !positive(limits.bootTimeoutMs, 60 * 60_000) ||
    !positive(limits.agentHealthTimeoutMs, 60 * 60_000) ||
    !positive(limits.cleanupTimeoutMs, 60 * 60_000) ||
    !positive(limits.maxAdoptionAttempts, 20)
  )
    return Effect.fail(fail('input', 'limits-invalid', 'Smoke limits are invalid'))
  return Effect.succeed(limits)
}

const effectScheduler: ProviderStabilizationScheduler = {
  nowEpochMs: Clock.currentTimeMillis,
  sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)),
}

/** Polls `observe` until it returns a value, bounded by `timeoutMs` on the effect clock. */
const pollUntil = <A, E>(
  observe: Effect.Effect<A | undefined, E>,
  intervalMs: number,
  timeoutMs: number,
  onTimeout: () => ProviderImageSmokeError,
): Effect.Effect<A, E | ProviderImageSmokeError> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while (true) {
      const value = yield* observe
      if (value !== undefined) return value
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return yield* onTimeout()
      yield* Effect.sleep(Duration.millis(Math.min(intervalMs, deadline - now)))
    }
  })

interface Tracked {
  providerImageId?: string
  providerNodeId?: string
}

interface MainResult {
  readonly providerImageId: string
  readonly imageRegistration: 'registered' | 'adopted'
  readonly providerNodeId: string
  readonly bootDurationMs: number
  readonly agentHealth: ProviderImageSmokeEvidence['agentHealth']
}

const registrationRequest = (
  input: ProviderImageSmokeInput,
  identity: ProviderImageSmokeIdentity,
  createMode: ProviderImageRegistrationRequest['createMode'],
  adoptionAttempt: number,
  adoptionDeadlineAtEpochMs: number,
): ProviderImageRegistrationRequest => ({
  registrationId: identity.registrationId,
  providerAccountId: input.providerAccountId,
  provider: input.provider,
  region: input.region,
  imageId: input.imageId ?? DEFAULT_SMOKE_IMAGE_ID,
  version: input.imageVersion,
  sourceCommit: input.sourceCommit,
  architecture: 'amd64',
  artifactDigest: input.artifactDigest,
  artifactUrl: input.artifactUrl,
  createMode,
  adoptionAttempt,
  adoptionDeadlineAtEpochMs,
})

const registerImage = (
  driver: ProviderImageSmokeDriverShape,
  input: ProviderImageSmokeInput,
  identity: ProviderImageSmokeIdentity,
  limits: ProviderImageSmokeLimits,
  deadline: number,
) =>
  Effect.gen(function* () {
    const transport = makeProviderImageRegistrationTransport(driver.images)
    const first = yield* Effect.result(
      transport.registerOrAdopt(
        registrationRequest(input, identity, 'create_or_adopt', 0, deadline),
      ),
    )
    if (first._tag === 'Success') {
      if (first.success.kind === 'uncertain')
        return yield* fail('image-import', 'image-import-uncertain', 'Image import is uncertain')
      return { providerImageId: first.success.providerImageId, kind: first.success.kind }
    }
    if (first.failure._tag !== 'ProviderCreateUncertainError')
      return yield* providerFailure('image-import', 'Provider image import failed')(first.failure)
    // ADR 0019: after a lost import response only metadata-bound discovery may adopt.
    for (let attempt = 1; attempt <= limits.maxAdoptionAttempts; attempt += 1) {
      yield* Effect.sleep(Duration.millis(limits.pollIntervalMs))
      const result = yield* transport
        .registerOrAdopt(registrationRequest(input, identity, 'adopt_only', attempt, deadline))
        .pipe(Effect.mapError(providerFailure('image-import', 'Provider image adoption failed')))
      if (result.kind !== 'uncertain')
        return { providerImageId: result.providerImageId, kind: 'adopted' as const }
    }
    return yield* fail(
      'image-import',
      'image-import-uncertain',
      'Image import stayed uncertain after bounded adopt-only discovery',
    )
  })

const createNode = (
  driver: ProviderImageSmokeDriverShape,
  input: ProviderImageSmokeInput,
  identity: ProviderImageSmokeIdentity,
  providerImageId: string,
  limits: ProviderImageSmokeLimits,
  deadline: number,
) =>
  Effect.gen(function* () {
    const request = (
      createMode: 'create_or_adopt' | 'adopt_only',
      adoptionAttempt: number,
    ): CreateNodeInput => ({
      organizationId: SMOKE_ORGANIZATION_ID,
      operationId: identity.operationId,
      nodeId: identity.nodeId,
      name: identity.nodeName,
      regionId: input.region,
      planId: input.plan,
      imageId: providerImageId,
      imageVersion: input.imageVersion,
      ...(input.cloudInit === undefined ? {} : { cloudInit: input.cloudInit }),
      createMode,
      adoptionAttempt,
      adoptionDeadlineAtEpochMs: deadline,
    })
    const find = (listInput: { readonly organizationId: string; readonly operationId?: string }) =>
      driver.listNodes({
        organizationId: listInput.organizationId,
        operationId: listInput.operationId ?? identity.operationId,
      })
    const options = {
      provider: input.provider,
      scheduler: effectScheduler,
      initialBackoffMs: Math.min(limits.pollIntervalMs, 30_000),
      maxBackoffMs: Math.min(limits.pollIntervalMs * 4, 60_000),
    }
    const first = yield* Effect.result(
      createOrAdopt(request('create_or_adopt', 0), find, driver.createNode, options),
    )
    if (first._tag === 'Success') return first.success
    if (first.failure._tag !== 'ProviderCreateUncertainError')
      return yield* providerFailure('node-create', 'Provider node create failed')(first.failure)
    let offset = first.failure.nextAttemptNumber - 1
    // ADR 0019: a retry discovers and adopts; it never sends a second paid create.
    for (let attempt = 1; attempt <= limits.maxAdoptionAttempts; attempt += 1) {
      const retry = yield* Effect.result(
        createOrAdopt(request('adopt_only', offset), find, driver.createNode, {
          ...options,
          attemptOffset: offset,
        }),
      )
      if (retry._tag === 'Success') return retry.success
      if (retry.failure._tag !== 'ProviderCreateUncertainError')
        return yield* providerFailure('node-create', 'Provider node adoption failed')(retry.failure)
      offset = retry.failure.nextAttemptNumber - 1
    }
    return yield* fail(
      'node-create',
      'node-create-uncertain',
      'Node create stayed uncertain after bounded adopt-only discovery',
    )
  })

const healthyAgent = (
  sample: AgentHealthSample,
  identity: ProviderImageSmokeIdentity,
  now: number,
): Effect.Effect<boolean, ProviderImageSmokeError> =>
  Effect.gen(function* () {
    yield* validateAgentHealthSample(sample, now).pipe(
      Effect.mapError(() =>
        fail('agent-health', 'agent-health-invalid', 'Agent health sample is invalid'),
      ),
    )
    if (sample.organizationId !== SMOKE_ORGANIZATION_ID || sample.nodeId !== identity.nodeId)
      return yield* fail(
        'agent-health',
        'agent-health-scope-mismatch',
        'Agent health sample belongs to another node',
      )
    // The smoke issues no Tunnel credential, so Tunnel state is recorded but not required.
    return sample.docker === 'healthy' && sample.firewall === 'ready'
  })

const main = (
  driver: ProviderImageSmokeDriverShape,
  observer: AgentHealthObserverShape,
  input: ProviderImageSmokeInput,
  identity: ProviderImageSmokeIdentity,
  limits: ProviderImageSmokeLimits,
  deadline: number,
  tracked: Tracked,
): Effect.Effect<MainResult, ProviderImageSmokeError> =>
  Effect.gen(function* () {
    const image = yield* registerImage(driver, input, identity, limits, deadline)
    tracked.providerImageId = image.providerImageId
    yield* pollUntil(
      Effect.flatMap(
        driver
          .observeImage(image.providerImageId)
          .pipe(
            Effect.mapError(providerFailure('image-ready', 'Provider image observation failed')),
          ),
        (state) =>
          state === 'ready'
            ? Effect.succeed(true as const)
            : state === 'pending'
              ? Effect.succeed(undefined)
              : Effect.fail(
                  fail('image-ready', `image-${state}`, 'Provider image did not become usable'),
                ),
      ),
      limits.pollIntervalMs,
      limits.imageReadyTimeoutMs,
      () => fail('image-ready', 'image-ready-timeout', 'Provider image import timed out'),
    )
    const createdAt = yield* Clock.currentTimeMillis
    const node = yield* createNode(driver, input, identity, image.providerImageId, limits, deadline)
    tracked.providerNodeId = node.id
    yield* pollUntil(
      Effect.flatMap(
        driver
          .observeNode(node.id)
          .pipe(Effect.mapError(providerFailure('boot', 'Provider node observation failed'))),
        (observation) =>
          observation.kind === 'absent'
            ? Effect.fail(fail('boot', 'node-disappeared', 'Provider node disappeared during boot'))
            : observation.node.state === 'active'
              ? Effect.succeed(true as const)
              : observation.node.state === 'creating' || observation.node.state === 'unknown'
                ? Effect.succeed(undefined)
                : Effect.fail(
                    fail('boot', `node-${observation.node.state}`, 'Provider node did not boot'),
                  ),
      ),
      limits.pollIntervalMs,
      limits.bootTimeoutMs,
      () => fail('boot', 'boot-timeout', 'Provider node did not become active in time'),
    )
    const bootedAt = yield* Clock.currentTimeMillis
    const sample = yield* pollUntil(
      Effect.gen(function* () {
        const latest = yield* observer
          .latest({
            organizationId: SMOKE_ORGANIZATION_ID,
            nodeId: identity.nodeId,
            providerNodeId: node.id,
          })
          .pipe(
            Effect.mapError((error) =>
              fail('agent-health', error.code, 'Agent health observation failed'),
            ),
          )
        if (latest === undefined) return undefined
        const now = yield* Clock.currentTimeMillis
        return (yield* healthyAgent(latest, identity, now)) ? latest : undefined
      }),
      limits.pollIntervalMs,
      limits.agentHealthTimeoutMs,
      () =>
        fail('agent-health', 'agent-never-healthy', 'Node agent did not report healthy in time'),
    )
    const healthyAt = yield* Clock.currentTimeMillis
    return {
      providerImageId: image.providerImageId,
      imageRegistration: image.kind,
      providerNodeId: node.id,
      bootDurationMs: bootedAt - createdAt,
      agentHealth: {
        outcome: 'healthy' as const,
        agentVersion: sample.agentVersion,
        docker: sample.docker,
        firewall: sample.firewall,
        tunnel: sample.tunnel,
        observedAfterMs: healthyAt - bootedAt,
      },
    }
  })

const unique = (values: readonly (string | undefined)[]): readonly string[] => [
  ...new Set(values.filter((value): value is string => value !== undefined)),
]

const cleanupNodes = (
  driver: ProviderImageSmokeDriverShape,
  identity: ProviderImageSmokeIdentity,
  tracked: Tracked,
  limits: ProviderImageSmokeLimits,
): Effect.Effect<ProviderImageSmokeCleanupReceipt> =>
  Effect.gen(function* () {
    const discovered = yield* Effect.result(
      driver.listNodes({
        organizationId: SMOKE_ORGANIZATION_ID,
        operationId: identity.operationId,
      }),
    )
    const exact =
      discovered._tag === 'Success'
        ? discovered.success
            .filter(
              (node) =>
                node.metadata.organizationId === SMOKE_ORGANIZATION_ID &&
                node.metadata.operationId === identity.operationId &&
                node.metadata.nodeId === identity.nodeId,
            )
            .map((node) => node.id)
        : []
    const ids = unique([tracked.providerNodeId, ...exact])
    if (ids.length === 0)
      return discovered._tag === 'Success'
        ? {
            resource: 'node' as const,
            providerResourceIds: [],
            disposition: 'absent' as const,
            confirmed: true,
          }
        : {
            resource: 'node' as const,
            providerResourceIds: [],
            disposition: 'unconfirmed' as const,
            confirmed: false,
            failureCode: discovered.failure._tag,
          }
    const failures: string[] = []
    if (discovered._tag === 'Failure') failures.push(discovered.failure._tag)
    for (const id of ids) {
      const disposed = yield* Effect.result(driver.disposeNode(id))
      if (disposed._tag === 'Failure' && disposed.failure._tag !== 'ProviderNotFoundError') {
        failures.push(disposed.failure._tag)
        continue
      }
      const confirmed = yield* Effect.result(
        pollUntil(
          Effect.map(driver.observeNode(id), (observation) =>
            driver.nodeDisposed(observation) ? (true as const) : undefined,
          ),
          limits.pollIntervalMs,
          limits.cleanupTimeoutMs,
          () => fail('cleanup', 'node-cleanup-timeout', 'Node disposal was not confirmed'),
        ),
      )
      if (confirmed._tag === 'Failure')
        failures.push(
          confirmed.failure._tag === 'ProviderImageSmokeError'
            ? confirmed.failure.code
            : confirmed.failure._tag,
        )
    }
    return failures.length === 0
      ? {
          resource: 'node' as const,
          providerResourceIds: ids,
          disposition:
            driver.nodeDisposal === 'delete'
              ? ('deleted' as const)
              : ('cancellation-scheduled' as const),
          confirmed: true,
        }
      : {
          resource: 'node' as const,
          providerResourceIds: ids,
          disposition: 'unconfirmed' as const,
          confirmed: false,
          failureCode: failures[0]!,
        }
  })

const cleanupImages = (
  driver: ProviderImageSmokeDriverShape,
  input: ProviderImageSmokeInput,
  identity: ProviderImageSmokeIdentity,
  tracked: Tracked,
  limits: ProviderImageSmokeLimits,
): Effect.Effect<ProviderImageSmokeCleanupReceipt> =>
  Effect.gen(function* () {
    const expectedName = `gridora-${input.imageId ?? DEFAULT_SMOKE_IMAGE_ID}-${input.artifactDigest.slice(7, 23)}`
    const discovered = yield* Effect.result(
      driver.images.list({
        providerAccountId: input.providerAccountId,
        region: input.region,
        expectedName,
      }),
    )
    const exact =
      discovered._tag === 'Success'
        ? discovered.success
            .filter(
              (image) =>
                image.name === expectedName &&
                image.metadata['managed-by'] === 'gridora' &&
                image.metadata['gridora-registration-id'] === identity.registrationId,
            )
            .map((image) => image.id)
        : []
    const ids = unique([tracked.providerImageId, ...exact])
    if (ids.length === 0)
      return discovered._tag === 'Success'
        ? {
            resource: 'image' as const,
            providerResourceIds: [],
            disposition: 'absent' as const,
            confirmed: true,
          }
        : {
            resource: 'image' as const,
            providerResourceIds: [],
            disposition: 'unconfirmed' as const,
            confirmed: false,
            failureCode: discovered.failure._tag,
          }
    const failures: string[] = []
    if (discovered._tag === 'Failure') failures.push(discovered.failure._tag)
    for (const id of ids) {
      const deleted = yield* Effect.result(driver.deleteImage(id))
      if (deleted._tag === 'Failure' && deleted.failure._tag !== 'ProviderNotFoundError') {
        failures.push(deleted.failure._tag)
        continue
      }
      const confirmed = yield* Effect.result(
        pollUntil(
          Effect.map(driver.observeImage(id), (state) =>
            state === 'absent' ? (true as const) : undefined,
          ),
          limits.pollIntervalMs,
          limits.cleanupTimeoutMs,
          () => fail('cleanup', 'image-cleanup-timeout', 'Image deletion was not confirmed'),
        ),
      )
      if (confirmed._tag === 'Failure')
        failures.push(
          confirmed.failure._tag === 'ProviderImageSmokeError'
            ? confirmed.failure.code
            : confirmed.failure._tag,
        )
    }
    return failures.length === 0
      ? {
          resource: 'image' as const,
          providerResourceIds: ids,
          disposition: 'deleted' as const,
          confirmed: true,
        }
      : {
          resource: 'image' as const,
          providerResourceIds: ids,
          disposition: 'unconfirmed' as const,
          confirmed: false,
          failureCode: failures[0]!,
        }
  })

const stageFailure = (cause: Cause.Cause<ProviderImageSmokeError>): ProviderImageSmokeError => {
  const error = Cause.findErrorOption(cause)
  if (error._tag === 'Some') return error.value
  return Cause.hasInterrupts(cause)
    ? fail('ttl', 'interrupted', 'Smoke run was interrupted before completion')
    : fail('input', 'defect', 'Smoke run failed unexpectedly')
}

/**
 * Registers or adopts one custom image, creates or adopts one disposable node,
 * observes boot and agent health, and always reconciles cleanup.
 *
 * The TTL bounds every provider and agent step. When it expires, the running
 * step is interrupted, cleanup still runs with its own budget, and the run
 * fails. Cleanup is uninterruptible and discovers resources by exact metadata,
 * so a lost create or import response cannot leave an untracked resource.
 */
export const runProviderImageSmoke = (
  input: ProviderImageSmokeInput,
): Effect.Effect<
  ProviderImageSmokeEvidence,
  ProviderImageSmokeError,
  ProviderImageSmokeDriver | AgentHealthObserver
> =>
  Effect.gen(function* () {
    const driver = yield* ProviderImageSmokeDriver
    const observer = yield* AgentHealthObserver
    const limits = yield* validateSmokeInput(input, driver)
    const identity = yield* deriveSmokeIdentity(input)
    const startedAt = yield* Clock.currentTimeMillis
    const ttlMs = input.ttlMinutes * 60_000
    const deadline = startedAt + ttlMs
    const tracked: Tracked = {}
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          restore(
            main(driver, observer, input, identity, limits, deadline, tracked).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(ttlMs),
                orElse: () =>
                  Effect.fail(fail('ttl', 'ttl-expired', 'Smoke TTL expired before completion')),
              }),
            ),
          ),
        )
        const node = yield* cleanupNodes(driver, identity, tracked, limits)
        const image = yield* cleanupImages(driver, input, identity, tracked, limits)
        const cleanup = { node, image }
        const finishedAt = yield* Clock.currentTimeMillis
        if (Exit.isFailure(exit)) {
          const failure = stageFailure(exit.cause)
          return yield* new ProviderImageSmokeError({
            stage: failure.stage,
            code: failure.code,
            message: failure.message,
            cleanup,
          })
        }
        if (!node.confirmed || !image.confirmed)
          return yield* new ProviderImageSmokeError({
            stage: 'cleanup',
            code: node.confirmed
              ? (image.failureCode ?? 'image-cleanup-unconfirmed')
              : (node.failureCode ?? 'node-cleanup-unconfirmed'),
            message: 'Smoke cleanup did not confirm provider disposal',
            cleanup,
          })
        return {
          schemaVersion: 1 as const,
          result: 'passed' as const,
          provider: input.provider,
          region: input.region,
          plan: input.plan,
          runId: input.runId,
          sourceCommit: input.sourceCommit,
          artifactDigest: input.artifactDigest,
          imageVersion: input.imageVersion,
          idempotencyKey: identity.idempotencyKey,
          ttlMinutes: input.ttlMinutes,
          ...exit.value,
          cleanup,
          startedAtEpochMs: startedAt,
          finishedAtEpochMs: finishedAt,
        }
      }),
    )
  })

/**
 * Fails when any known secret value appears anywhere in the serialized record.
 * The CLI applies it to evidence and failure reports before printing them.
 */
export const assertNoSecretValues = (
  record: unknown,
  secrets: readonly string[],
): Effect.Effect<string, ProviderImageSmokeError> => {
  const serialized = JSON.stringify(record)
  return secrets.some((secret) => secret.length >= 4 && serialized.includes(secret))
    ? Effect.fail(fail('input', 'secret-in-report', 'Smoke report contained a secret value'))
    : Effect.succeed(serialized)
}

import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Version = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
const BoundedPorts = Schema.Array(Port).check(Schema.isMaxLength(64))
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))

export const AgentObservationEvent = Schema.Struct({
  apiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
  organizationId: Identifier,
  nodeId: Identifier,
  sessionVersion: PositiveInteger,
  sequence: PositiveInteger,
  observedRevision: PositiveInteger,
  issuedAt: Timestamp,
  facts: Schema.Struct({
    agent: Schema.Struct({ version: Version, ready: Schema.Boolean }),
    image: Schema.Struct({
      imageId: Identifier,
      imageVersion: Version,
      checksum: Sha256,
      signatureVerified: Schema.Boolean,
      buildIdentityManifestSha256: Sha256,
      buildIdentitySignatureSha256: Sha256,
      buildIdentityPublicKeySha256: Sha256,
      ready: Schema.Boolean,
    }),
    tunnel: Schema.Struct({
      state: Schema.Literals(['connected', 'degraded', 'disconnected']),
      ready: Schema.Boolean,
    }),
    docker: Schema.Struct({
      engineVersion: Version,
      storageDriver: Schema.Literal('overlay2'),
      projectQuotaReady: Schema.Boolean,
      privilegedContainers: NonNegativeInteger,
      dockerSocketMounted: Schema.Boolean,
      ready: Schema.Boolean,
    }),
    firewall: Schema.Struct({
      defaultDeny: Schema.Boolean,
      allowedTcpPorts: BoundedPorts,
      allowedUdpPorts: BoundedPorts,
      ready: Schema.Boolean,
    }),
    capacity: Schema.Struct({
      architecture: Schema.Literals(['amd64', 'arm64']),
      cpuMillis: PositiveInteger,
      ramBytes: PositiveInteger,
      diskBytes: PositiveInteger,
      cpuUsedMillis: NonNegativeInteger,
      ramUsedBytes: NonNegativeInteger,
      diskUsedBytes: NonNegativeInteger,
    }),
    metrics: Schema.Struct({
      loadPermille: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
      networkReceiveBytes: NonNegativeInteger,
      networkTransmitBytes: NonNegativeInteger,
      containerRestarts: NonNegativeInteger,
    }),
  }),
})
export type AgentObservationEvent = typeof AgentObservationEvent.Type

export interface AuthenticatedAgentPrincipal {
  readonly organizationId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly version: number
  readonly sessionVersion: number
}

export interface AgentObservationReceipt {
  readonly organizationId: string
  readonly nodeId: string
  readonly sequence: number
  readonly observedRevision: number
  readonly observedState: 'bootstrapping' | 'ready' | 'degraded'
  readonly capacityPublished: boolean
  readonly acceptedAt: string
}

export interface AgentObservationReplayKey {
  readonly principal: AuthenticatedAgentPrincipal
  readonly event: AgentObservationEvent
  readonly fingerprint: string
}

export class AgentObservationValidationError extends Schema.TaggedError<AgentObservationValidationError>()(
  'AgentObservationValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class AgentObservationAuthenticationError extends Schema.TaggedError<AgentObservationAuthenticationError>()(
  'AgentObservationAuthenticationError',
  { code: Schema.String },
) {}
export class AgentObservationConflictError extends Schema.TaggedError<AgentObservationConflictError>()(
  'AgentObservationConflictError',
  { code: Schema.String },
) {}
export class AgentObservationNotCommittedError extends Schema.TaggedError<AgentObservationNotCommittedError>()(
  'AgentObservationNotCommittedError',
  {
    code: Schema.Literal('agent_observation_not_committed'),
    message: Schema.String,
  },
) {}
export class AgentObservationPersistenceError extends Schema.TaggedError<AgentObservationPersistenceError>()(
  'AgentObservationPersistenceError',
  { operation: Schema.String },
) {}

export type AgentObservationControlError =
  | AgentObservationValidationError
  | AgentObservationAuthenticationError
  | AgentObservationConflictError
  | AgentObservationNotCommittedError
  | AgentObservationPersistenceError

export interface AgentObservationRepositoryShape {
  /** Exact replay is checked before freshness so a lost response remains recoverable. */
  readonly findReplay: (
    input: AgentObservationReplayKey,
  ) => Effect.Effect<
    AgentObservationReceipt | null,
    AgentObservationConflictError | AgentObservationPersistenceError
  >
  /** Proves the authoritative cursor is exactly one event before this event. */
  readonly probeNotCommitted: (input: {
    readonly principal: AuthenticatedAgentPrincipal
    readonly event: AgentObservationEvent
  }) => Effect.Effect<void, AgentObservationConflictError | AgentObservationPersistenceError>
  readonly ingestAtomic: (input: {
    readonly principal: AuthenticatedAgentPrincipal
    readonly event: AgentObservationEvent
    readonly fingerprint: string
    readonly acceptedAt: string
  }) => Effect.Effect<
    AgentObservationReceipt,
    AgentObservationConflictError | AgentObservationPersistenceError
  >
}
export class AgentObservationRepository extends Context.Service<
  AgentObservationRepository,
  AgentObservationRepositoryShape
>()('@gridora/agent-observation-control/AgentObservationRepository') {}
export const AgentObservationRepositoryLayer = (service: AgentObservationRepositoryShape) =>
  Layer.succeed(AgentObservationRepository, service)

export interface AgentObservationClockShape {
  readonly nowEpochMilliseconds: () => number
}
export class AgentObservationClock extends Context.Service<
  AgentObservationClock,
  AgentObservationClockShape
>()('@gridora/agent-observation-control/AgentObservationClock') {}
export const AgentObservationClockLayer = (clock: AgentObservationClockShape) =>
  Layer.succeed(AgentObservationClock, clock)

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export const canonicalObservationPayload = (event: AgentObservationEvent): string =>
  canonicalJson(event)

export const sha256ObservationFingerprint = (
  canonicalPayload: string,
): Effect.Effect<string, AgentObservationPersistenceError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalPayload),
      )
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () =>
      new AgentObservationPersistenceError({ operation: 'agent-observation.fingerprint' }),
  })

export const decodeAgentObservationEvent = (input: unknown) =>
  Schema.decodeUnknownEffect(AgentObservationEvent, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () =>
        new AgentObservationValidationError({
          code: 'invalid_agent_observation',
          message: 'Agent observation does not match the strict contract',
        }),
    ),
  )

const coordinatesMatch = (
  principal: AuthenticatedAgentPrincipal,
  event: AgentObservationEvent,
): boolean =>
  principal.organizationId === event.organizationId &&
  principal.nodeId === event.nodeId &&
  principal.sessionVersion === event.sessionVersion

export const makeAgentObservationControl = Effect.gen(function* () {
  const repository = yield* AgentObservationRepository
  const clock = yield* AgentObservationClock
  return {
    ingest: (principal: AuthenticatedAgentPrincipal, input: unknown) =>
      Effect.gen(function* () {
        const event = yield* decodeAgentObservationEvent(input)
        if (!coordinatesMatch(principal, event))
          return yield* new AgentObservationAuthenticationError({ code: 'agent_scope_mismatch' })
        const canonicalPayload = canonicalObservationPayload(event)
        if (new TextEncoder().encode(canonicalPayload).byteLength > 32_768)
          return yield* new AgentObservationValidationError({
            code: 'agent_observation_too_large',
            message: 'Agent observation exceeds the bounded payload size',
          })
        const fingerprint = yield* sha256ObservationFingerprint(canonicalPayload)
        const replay = yield* repository.findReplay({ principal, event, fingerprint })
        if (replay !== null) return replay
        const now = clock.nowEpochMilliseconds()
        const issued = Date.parse(event.issuedAt)
        if (!Number.isFinite(issued) || issued < now - 120_000 || issued > now + 30_000) {
          yield* repository.probeNotCommitted({ principal, event })
          return yield* new AgentObservationNotCommittedError({
            code: 'agent_observation_not_committed',
            message: 'The stale observation was not committed; refresh it at the same cursor',
          })
        }
        if (
          event.facts.capacity.cpuUsedMillis > event.facts.capacity.cpuMillis ||
          event.facts.capacity.ramUsedBytes > event.facts.capacity.ramBytes ||
          event.facts.capacity.diskUsedBytes > event.facts.capacity.diskBytes
        )
          return yield* new AgentObservationValidationError({
            code: 'invalid_capacity_usage',
            message: 'Observed usage exceeds reported capacity',
          })
        return yield* repository.ingestAtomic({
          principal,
          event,
          fingerprint,
          acceptedAt: new Date(now).toISOString(),
        })
      }),
  } as const
})

export interface AgentObservationControlShape {
  readonly ingest: (
    principal: AuthenticatedAgentPrincipal,
    input: unknown,
  ) => Effect.Effect<AgentObservationReceipt, AgentObservationControlError>
}

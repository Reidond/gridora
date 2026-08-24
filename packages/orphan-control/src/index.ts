import { Context, Effect, Layer, Schema } from 'effect'

export * from './symmetry.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
export const OrphanProviderType = Schema.Literals(['ovhcloud', 'contabo'])
export type OrphanProviderType = typeof OrphanProviderType.Type

export const OrphanReconciliationRequest = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  providerType: OrphanProviderType,
  runId: Identifier,
  idempotencyKey: Identifier,
  actorId: Identifier,
})
export type OrphanReconciliationRequest = typeof OrphanReconciliationRequest.Type

export const DiscoveredOwnership = Schema.Struct({
  managedBy: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  organizationId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  imageVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type DiscoveredOwnership = typeof DiscoveredOwnership.Type

export const DiscoveredProviderResource = Schema.Struct({
  kind: Schema.Literal('node'),
  providerResourceId: Identifier,
  ownership: Schema.NullOr(DiscoveredOwnership),
})
export type DiscoveredProviderResource = typeof DiscoveredProviderResource.Type

export const ProviderRemovalEvidence = Schema.Struct({
  providerResourceId: Identifier,
  evidenceId: Identifier,
  observedAt: Timestamp,
  kind: Schema.Literal('provider-removal'),
})
export type ProviderRemovalEvidence = typeof ProviderRemovalEvidence.Type

export const OrphanDiscoverySnapshot = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  providerType: OrphanProviderType,
  /** Exact account secret evidence captured before provider discovery. */
  credentialReference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  credentialRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  requestId: Identifier,
  observedAt: Timestamp,
  complete: Schema.Literal(true),
  truncated: Schema.Literal(false),
  continuationToken: Schema.Null,
  resources: Schema.Array(DiscoveredProviderResource),
  removalEvidence: Schema.Array(ProviderRemovalEvidence),
})
export type OrphanDiscoverySnapshot = typeof OrphanDiscoverySnapshot.Type

export const AuthoritativeManagedResource = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  providerType: OrphanProviderType,
  kind: Schema.Literal('node'),
  providerResourceId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  imageVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type AuthoritativeManagedResource = typeof AuthoritativeManagedResource.Type

export const OrphanObservation = Schema.Struct({
  providerResourceId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  imageVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  disposition: Schema.Literals(['orphan', 'authoritative-adoption']),
})
export type OrphanObservation = typeof OrphanObservation.Type

const DiscoveryFingerprint = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
export const OrphanReconciliationPlan = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  providerType: OrphanProviderType,
  credentialReference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  credentialRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  runId: Identifier,
  idempotencyKey: Identifier,
  actorId: Identifier,
  discoveryFingerprint: DiscoveryFingerprint,
  observedAt: Timestamp,
  observations: Schema.Array(OrphanObservation),
  removalEvidence: Schema.Array(ProviderRemovalEvidence),
})
export type OrphanReconciliationPlan = typeof OrphanReconciliationPlan.Type

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const OrphanReconciliationResult = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  runId: Identifier,
  discoveryFingerprint: DiscoveryFingerprint,
  opened: Count,
  updated: Count,
  resolved: Count,
  unchanged: Count,
  replayed: Schema.Boolean,
})
export type OrphanReconciliationResult = typeof OrphanReconciliationResult.Type

const ErrorCode = Schema.Literals([
  'invalid-scope',
  'stale-discovery',
  'ambiguous-discovery',
  'unbounded-discovery',
  'discovery-failed',
  'persistence-failed',
  'idempotency-conflict',
])
export class OrphanControlError extends Schema.TaggedError<OrphanControlError>()(
  'OrphanControlError',
  {
    code: ErrorCode,
    operation: Schema.String,
    message: Schema.Literal('orphan reconciliation failed'),
  },
) {}
const failure = (operation: string, code: typeof ErrorCode.Type) =>
  new OrphanControlError({ operation, code, message: 'orphan reconciliation failed' })

export interface OrphanDiscoveryPortShape {
  readonly discover: (
    request: OrphanReconciliationRequest,
  ) => Effect.Effect<OrphanDiscoverySnapshot, OrphanControlError>
}
export class OrphanDiscoveryPort extends Context.Service<
  OrphanDiscoveryPort,
  OrphanDiscoveryPortShape
>()('@gridora/orphan-control/OrphanDiscoveryPort') {}
export const OrphanDiscoveryPortLayer = (port: OrphanDiscoveryPortShape) =>
  Layer.succeed(OrphanDiscoveryPort, port)

export interface OrphanRepositoryShape {
  readonly findReplay: (
    request: OrphanReconciliationRequest,
  ) => Effect.Effect<OrphanReconciliationResult | null, OrphanControlError>
  readonly authoritative: (
    request: OrphanReconciliationRequest,
  ) => Effect.Effect<ReadonlyArray<AuthoritativeManagedResource>, OrphanControlError>
  readonly applyAtomic: (
    plan: OrphanReconciliationPlan,
  ) => Effect.Effect<OrphanReconciliationResult, OrphanControlError>
}
export class OrphanRepository extends Context.Service<OrphanRepository, OrphanRepositoryShape>()(
  '@gridora/orphan-control/OrphanRepository',
) {}
export const OrphanRepositoryLayer = (repository: OrphanRepositoryShape) =>
  Layer.succeed(OrphanRepository, repository)

export class OrphanClock extends Context.Service<
  OrphanClock,
  { readonly now: Effect.Effect<Date> }
>()('@gridora/orphan-control/OrphanClock') {}
export const OrphanClockLayer = (now: Date | (() => Date)) =>
  Layer.succeed(OrphanClock, {
    now: Effect.sync(() => (typeof now === 'function' ? now() : now)),
  })

export interface OrphanControlShape {
  readonly reconcile: (
    request: unknown,
  ) => Effect.Effect<OrphanReconciliationResult, OrphanControlError>
}
export class OrphanControl extends Context.Service<OrphanControl, OrphanControlShape>()(
  '@gridora/orphan-control/OrphanControl',
) {}

const MAX_DISCOVERED_RESOURCES = 200
const MAX_REMOVAL_EVIDENCE = 200
const MAX_DISCOVERY_AGE_MS = 10 * 60_000
const MAX_FUTURE_SKEW_MS = 60_000

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}
const sha256 = (value: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      )
      return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => failure('orphan.fingerprint', 'persistence-failed'),
  })
const tuple = (value: {
  readonly organizationId: string
  readonly providerAccountId: string
  readonly providerType: string
  readonly providerResourceId: string
  readonly nodeId: string
  readonly operationId: string
  readonly imageVersion: string
}) =>
  [
    value.organizationId,
    value.providerAccountId,
    value.providerType,
    value.providerResourceId,
    value.nodeId,
    value.operationId,
    value.imageVersion,
  ].join('\u0000')

export const OrphanControlLive = Layer.effect(
  OrphanControl,
  Effect.gen(function* () {
    const discoveryPort = yield* OrphanDiscoveryPort
    const repository = yield* OrphanRepository
    const clock = yield* OrphanClock
    return OrphanControl.of({
      reconcile: (input) =>
        Effect.gen(function* () {
          const request = yield* Schema.decodeUnknownEffect(OrphanReconciliationRequest, {
            onExcessProperty: 'error',
          })(input).pipe(Effect.mapError(() => failure('orphan.request', 'invalid-scope')))
          const replay = yield* repository.findReplay(request)
          if (replay !== null) return replay
          const [snapshotValue, authoritativeValue, now] = yield* Effect.all([
            discoveryPort.discover(request),
            repository.authoritative(request),
            clock.now,
          ])
          const snapshot = yield* Schema.decodeUnknownEffect(OrphanDiscoverySnapshot, {
            onExcessProperty: 'error',
          })(snapshotValue).pipe(
            Effect.mapError(() => failure('orphan.discovery.decode', 'ambiguous-discovery')),
          )
          const authoritative = yield* Schema.decodeUnknownEffect(
            Schema.Array(AuthoritativeManagedResource),
            { onExcessProperty: 'error' },
          )(authoritativeValue).pipe(
            Effect.mapError(() => failure('orphan.authoritative.decode', 'persistence-failed')),
          )
          if (
            snapshot.organizationId !== request.organizationId ||
            snapshot.providerAccountId !== request.providerAccountId ||
            snapshot.providerType !== request.providerType ||
            snapshot.credentialReference.length === 0 ||
            snapshot.credentialRevision < 1 ||
            snapshot.requestId !== request.runId
          )
            return yield* failure('orphan.discovery.scope', 'invalid-scope')
          if (
            snapshot.resources.length > MAX_DISCOVERED_RESOURCES ||
            snapshot.removalEvidence.length > MAX_REMOVAL_EVIDENCE ||
            authoritative.length > MAX_DISCOVERED_RESOURCES
          )
            return yield* failure('orphan.discovery.bound', 'unbounded-discovery')
          const observedAt = Date.parse(snapshot.observedAt)
          if (
            !Number.isFinite(observedAt) ||
            now.getTime() - observedAt > MAX_DISCOVERY_AGE_MS ||
            observedAt - now.getTime() > MAX_FUTURE_SKEW_MS
          )
            return yield* failure('orphan.discovery.time', 'stale-discovery')

          const resourceIds = new Set<string>()
          const ownershipTuples = new Set<string>()
          const managed: Array<DiscoveredProviderResource & { ownership: DiscoveredOwnership }> = []
          for (const resource of snapshot.resources) {
            if (resourceIds.has(resource.providerResourceId))
              return yield* failure('orphan.discovery.duplicate', 'ambiguous-discovery')
            resourceIds.add(resource.providerResourceId)
            if (resource.ownership === null || resource.ownership.managedBy !== 'gridora') continue
            if (resource.ownership.organizationId !== request.organizationId)
              return yield* failure('orphan.discovery.foreign', 'invalid-scope')
            const ownershipKey = [
              resource.ownership.organizationId,
              resource.ownership.nodeId,
              resource.ownership.operationId,
            ].join('\u0000')
            if (ownershipTuples.has(ownershipKey))
              return yield* failure('orphan.discovery.ownership', 'ambiguous-discovery')
            ownershipTuples.add(ownershipKey)
            managed.push(
              resource as DiscoveredProviderResource & { ownership: DiscoveredOwnership },
            )
          }

          const authoritativeKeys = new Set<string>()
          for (const resource of authoritative) {
            if (
              resource.organizationId !== request.organizationId ||
              resource.providerAccountId !== request.providerAccountId ||
              resource.providerType !== request.providerType
            )
              return yield* failure('orphan.authoritative.scope', 'invalid-scope')
            const key = tuple(resource)
            if (authoritativeKeys.has(key))
              return yield* failure('orphan.authoritative.duplicate', 'ambiguous-discovery')
            authoritativeKeys.add(key)
          }

          const evidenceIds = new Set<string>()
          for (const evidence of snapshot.removalEvidence) {
            const evidenceAt = Date.parse(evidence.observedAt)
            if (
              evidenceIds.has(evidence.providerResourceId) ||
              resourceIds.has(evidence.providerResourceId) ||
              !Number.isFinite(evidenceAt) ||
              evidenceAt < observedAt ||
              evidenceAt - now.getTime() > MAX_FUTURE_SKEW_MS
            )
              return yield* failure('orphan.discovery.removal', 'ambiguous-discovery')
            evidenceIds.add(evidence.providerResourceId)
          }

          const observations = managed
            .map((resource): OrphanObservation => ({
              providerResourceId: resource.providerResourceId,
              nodeId: resource.ownership.nodeId,
              operationId: resource.ownership.operationId,
              imageVersion: resource.ownership.imageVersion,
              disposition: authoritativeKeys.has(
                tuple({
                  ...request,
                  providerResourceId: resource.providerResourceId,
                  nodeId: resource.ownership.nodeId,
                  operationId: resource.ownership.operationId,
                  imageVersion: resource.ownership.imageVersion,
                }),
              )
                ? 'authoritative-adoption'
                : 'orphan',
            }))
            .sort((left, right) => left.providerResourceId.localeCompare(right.providerResourceId))
          const fingerprint = yield* sha256(
            canonicalJson({
              ...snapshot,
              resources: [...snapshot.resources].sort((left, right) =>
                left.providerResourceId.localeCompare(right.providerResourceId),
              ),
              removalEvidence: [...snapshot.removalEvidence].sort((left, right) =>
                left.providerResourceId.localeCompare(right.providerResourceId),
              ),
            }),
          )
          return yield* repository.applyAtomic({
            ...request,
            credentialReference: snapshot.credentialReference,
            credentialRevision: snapshot.credentialRevision,
            discoveryFingerprint: `sha256:${fingerprint}`,
            observedAt: snapshot.observedAt,
            observations,
            removalEvidence: [...snapshot.removalEvidence].sort((left, right) =>
              left.providerResourceId.localeCompare(right.providerResourceId),
            ),
          })
        }),
    })
  }),
)

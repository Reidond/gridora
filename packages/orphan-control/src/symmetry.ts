import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
)
const ScheduleIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)
const Fingerprint = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const OrphanSymmetryKind = Schema.Literals([
  'deployment-container',
  'port-lease',
  'dns-record',
  'tunnel-authority',
  'backup-object',
])
export type OrphanSymmetryKind = typeof OrphanSymmetryKind.Type

export const OrphanSymmetryReason = Schema.Literals([
  'missing-observed',
  'unmanaged-observed',
  'duplicate-observed',
  'foreign-observed',
  'fingerprint-mismatch',
  'receipt-missing',
  'receipt-stale',
  'authority-stale',
])
export type OrphanSymmetryReason = typeof OrphanSymmetryReason.Type

export const OrphanSymmetryRequest = Schema.Struct({
  organizationId: Identifier,
  actorId: ScheduleIdentifier,
  runId: ScheduleIdentifier,
  idempotencyKey: ScheduleIdentifier,
})
export type OrphanSymmetryRequest = typeof OrphanSymmetryRequest.Type

export const OrphanSymmetryAuthorityResource = Schema.Struct({
  organizationId: Identifier,
  kind: OrphanSymmetryKind,
  resourceKey: Identifier,
  resourceId: Identifier,
  nodeId: Schema.NullOr(Identifier),
  fingerprint: Fingerprint,
  state: Schema.Literals(['expected', 'receipt-missing', 'receipt-stale', 'authority-stale']),
})
export type OrphanSymmetryAuthorityResource = typeof OrphanSymmetryAuthorityResource.Type

export const OrphanSymmetryObservedResource = Schema.Struct({
  organizationId: Identifier,
  kind: OrphanSymmetryKind,
  resourceKey: Identifier,
  resourceId: Identifier,
  nodeId: Schema.NullOr(Identifier),
  fingerprint: Fingerprint,
  ownerScope: Schema.Literals(['tenant', 'foreign', 'unmanaged']),
  observedAt: Timestamp,
})
export type OrphanSymmetryObservedResource = typeof OrphanSymmetryObservedResource.Type

export const OrphanSymmetryDiscoveryPage = Schema.Struct({
  organizationId: Identifier,
  runId: Identifier,
  cursor: Schema.NullOr(Identifier),
  nextCursor: Schema.NullOr(Identifier),
  complete: Schema.Boolean,
  resources: Schema.Array(OrphanSymmetryObservedResource),
})
export type OrphanSymmetryDiscoveryPage = typeof OrphanSymmetryDiscoveryPage.Type

export const OrphanSymmetryFinding = Schema.Struct({
  kind: OrphanSymmetryKind,
  resourceKey: Identifier,
  resourceId: Identifier,
  nodeId: Schema.NullOr(Identifier),
  reason: OrphanSymmetryReason,
  severity: Schema.Literal('high'),
  expectedFingerprint: Schema.NullOr(Fingerprint),
  observedFingerprint: Schema.NullOr(Fingerprint),
  recommendation: Schema.Literals([
    'inspect-agent-container-inventory',
    'inspect-node-port-ownership',
    'inspect-provider-dns-and-receipt',
    'inspect-tunnel-and-node-authority',
    'inspect-r2-prefix-and-backup-catalog',
  ]),
})
export type OrphanSymmetryFinding = typeof OrphanSymmetryFinding.Type

export const OrphanSymmetryPlan = Schema.Struct({
  ...OrphanSymmetryRequest.fields,
  observedAt: Timestamp,
  authorityFingerprint: Fingerprint,
  discoveryFingerprint: Fingerprint,
  findings: Schema.Array(OrphanSymmetryFinding),
})
export type OrphanSymmetryPlan = typeof OrphanSymmetryPlan.Type

export const OrphanSymmetryResult = Schema.Struct({
  organizationId: Identifier,
  runId: Identifier,
  discoveryFingerprint: Fingerprint,
  opened: Count,
  updated: Count,
  resolved: Count,
  unchanged: Count,
  replayed: Schema.Boolean,
})
export type OrphanSymmetryResult = typeof OrphanSymmetryResult.Type

export class OrphanSymmetryError extends Schema.TaggedError<OrphanSymmetryError>()(
  'OrphanSymmetryError',
  {
    operation: Schema.String,
    code: Schema.Literals([
      'invalid-scope',
      'ambiguous-discovery',
      'unbounded-discovery',
      'stale-discovery',
      'persistence-failed',
      'idempotency-conflict',
    ]),
    message: Schema.Literal('orphan symmetry reconciliation failed'),
  },
) {}

const failure = (operation: string, code: (typeof OrphanSymmetryError.Type)['code']) =>
  new OrphanSymmetryError({ operation, code, message: 'orphan symmetry reconciliation failed' })

export interface OrphanSymmetryDiscoveryShape {
  readonly discoverPage: (
    request: OrphanSymmetryRequest,
    cursor: string | null,
  ) => Effect.Effect<OrphanSymmetryDiscoveryPage, OrphanSymmetryError>
}
export class OrphanSymmetryDiscovery extends Context.Service<
  OrphanSymmetryDiscovery,
  OrphanSymmetryDiscoveryShape
>()('@gridora/orphan-control/OrphanSymmetryDiscovery') {}
export const OrphanSymmetryDiscoveryLayer = (value: OrphanSymmetryDiscoveryShape) =>
  Layer.succeed(OrphanSymmetryDiscovery, value)

export interface OrphanSymmetryRepositoryShape {
  readonly findReplay: (
    request: OrphanSymmetryRequest,
  ) => Effect.Effect<OrphanSymmetryResult | null, OrphanSymmetryError>
  readonly authoritative: (
    request: OrphanSymmetryRequest,
  ) => Effect.Effect<ReadonlyArray<OrphanSymmetryAuthorityResource>, OrphanSymmetryError>
  readonly applyAtomic: (
    plan: OrphanSymmetryPlan,
  ) => Effect.Effect<OrphanSymmetryResult, OrphanSymmetryError>
}
export class OrphanSymmetryRepository extends Context.Service<
  OrphanSymmetryRepository,
  OrphanSymmetryRepositoryShape
>()('@gridora/orphan-control/OrphanSymmetryRepository') {}
export const OrphanSymmetryRepositoryLayer = (value: OrphanSymmetryRepositoryShape) =>
  Layer.succeed(OrphanSymmetryRepository, value)

export class OrphanSymmetryClock extends Context.Service<
  OrphanSymmetryClock,
  { readonly now: Effect.Effect<Date> }
>()('@gridora/orphan-control/OrphanSymmetryClock') {}
export const OrphanSymmetryClockLayer = (now: Date | (() => Date)) =>
  Layer.succeed(OrphanSymmetryClock, {
    now: Effect.sync(() => (typeof now === 'function' ? now() : now)),
  })

export interface OrphanSymmetryControlShape {
  readonly reconcile: (request: unknown) => Effect.Effect<OrphanSymmetryResult, OrphanSymmetryError>
}
export class OrphanSymmetryControl extends Context.Service<
  OrphanSymmetryControl,
  OrphanSymmetryControlShape
>()('@gridora/orphan-control/OrphanSymmetryControl') {}

const MAX_PAGE_SIZE = 100
const MAX_PAGES = 5
const MAX_AUTHORITY = 500
const MAX_DISCOVERY_AGE_MS = 10 * 60_000
const MAX_FUTURE_SKEW_MS = 60_000

export const canonicalOrphanSymmetryJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalOrphanSymmetryJson).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalOrphanSymmetryJson(record[key])}`)
    .join(',')}}`
}

export const fingerprintOrphanSymmetry = (value: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(canonicalOrphanSymmetryJson(value)),
        ),
      )
      return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    },
    catch: () => failure('orphan.symmetry.fingerprint', 'persistence-failed'),
  })

const keyOf = (value: { readonly kind: OrphanSymmetryKind; readonly resourceKey: string }) =>
  `${value.kind}\u0000${value.resourceKey}`

const recommendation = (kind: OrphanSymmetryKind): OrphanSymmetryFinding['recommendation'] => {
  switch (kind) {
    case 'deployment-container':
      return 'inspect-agent-container-inventory'
    case 'port-lease':
      return 'inspect-node-port-ownership'
    case 'dns-record':
      return 'inspect-provider-dns-and-receipt'
    case 'tunnel-authority':
      return 'inspect-tunnel-and-node-authority'
    case 'backup-object':
      return 'inspect-r2-prefix-and-backup-catalog'
  }
}

const finding = (
  resource: OrphanSymmetryAuthorityResource | OrphanSymmetryObservedResource,
  reason: OrphanSymmetryReason,
  expectedFingerprint: string | null,
  observedFingerprint: string | null,
): OrphanSymmetryFinding => ({
  kind: resource.kind,
  resourceKey: resource.resourceKey,
  resourceId: resource.resourceId,
  nodeId: resource.nodeId,
  reason,
  severity: 'high',
  expectedFingerprint,
  observedFingerprint,
  recommendation: recommendation(resource.kind),
})

export const compareOrphanSymmetry = (
  organizationId: string,
  authoritative: ReadonlyArray<OrphanSymmetryAuthorityResource>,
  observed: ReadonlyArray<OrphanSymmetryObservedResource>,
): Effect.Effect<ReadonlyArray<OrphanSymmetryFinding>, OrphanSymmetryError> =>
  Effect.gen(function* () {
    if (authoritative.length > MAX_AUTHORITY || observed.length > MAX_PAGE_SIZE * MAX_PAGES)
      return yield* failure('orphan.symmetry.compare.bound', 'unbounded-discovery')

    const authorityByKey = new Map<string, OrphanSymmetryAuthorityResource>()
    for (const resource of authoritative) {
      if (resource.organizationId !== organizationId)
        return yield* failure('orphan.symmetry.authority.scope', 'invalid-scope')
      const key = keyOf(resource)
      if (authorityByKey.has(key))
        return yield* failure('orphan.symmetry.authority.duplicate', 'ambiguous-discovery')
      authorityByKey.set(key, resource)
    }

    const observedByKey = new Map<string, Array<OrphanSymmetryObservedResource>>()
    for (const resource of observed) {
      if (resource.organizationId !== organizationId)
        return yield* failure('orphan.symmetry.observed.scope', 'invalid-scope')
      const values = observedByKey.get(keyOf(resource)) ?? []
      values.push(resource)
      observedByKey.set(keyOf(resource), values)
    }

    const findings: Array<OrphanSymmetryFinding> = []
    for (const authority of authoritative) {
      const values = observedByKey.get(keyOf(authority)) ?? []
      if (authority.state !== 'expected') {
        findings.push(
          finding(
            authority,
            authority.state === 'receipt-missing'
              ? 'receipt-missing'
              : authority.state === 'receipt-stale'
                ? 'receipt-stale'
                : 'authority-stale',
            authority.fingerprint,
            values[0]?.fingerprint ?? null,
          ),
        )
      }
      if (values.length === 0) {
        findings.push(finding(authority, 'missing-observed', authority.fingerprint, null))
        continue
      }
      if (values.length > 1)
        findings.push(
          finding(
            authority,
            'duplicate-observed',
            authority.fingerprint,
            values[0]?.fingerprint ?? null,
          ),
        )
      for (const value of values) {
        if (value.ownerScope === 'foreign')
          findings.push(
            finding(value, 'foreign-observed', authority.fingerprint, value.fingerprint),
          )
        else if (value.ownerScope === 'unmanaged')
          findings.push(
            finding(value, 'unmanaged-observed', authority.fingerprint, value.fingerprint),
          )
        if (value.fingerprint !== authority.fingerprint)
          findings.push(
            finding(value, 'fingerprint-mismatch', authority.fingerprint, value.fingerprint),
          )
      }
      observedByKey.delete(keyOf(authority))
    }
    for (const values of observedByKey.values()) {
      for (const value of values)
        findings.push(
          finding(
            value,
            value.ownerScope === 'foreign' ? 'foreign-observed' : 'unmanaged-observed',
            null,
            value.fingerprint,
          ),
        )
      if (values.length > 1 && values[0] !== undefined)
        findings.push(finding(values[0], 'duplicate-observed', null, values[0].fingerprint))
    }
    const unique = new Map<string, OrphanSymmetryFinding>()
    for (const value of findings)
      unique.set(`${value.kind}\u0000${value.resourceKey}\u0000${value.reason}`, value)
    return [...unique.values()].sort((left, right) =>
      `${left.kind}\u0000${left.resourceKey}\u0000${left.reason}`.localeCompare(
        `${right.kind}\u0000${right.resourceKey}\u0000${right.reason}`,
      ),
    )
  })

export const OrphanSymmetryControlLive = Layer.effect(
  OrphanSymmetryControl,
  Effect.gen(function* () {
    const discovery = yield* OrphanSymmetryDiscovery
    const repository = yield* OrphanSymmetryRepository
    const clock = yield* OrphanSymmetryClock
    return OrphanSymmetryControl.of({
      reconcile: (input) =>
        Effect.gen(function* () {
          const request = yield* Schema.decodeUnknownEffect(OrphanSymmetryRequest, {
            onExcessProperty: 'error',
          })(input).pipe(Effect.mapError(() => failure('orphan.symmetry.request', 'invalid-scope')))
          const replay = yield* repository.findReplay(request)
          if (replay !== null) return replay

          const authoritative = yield* repository.authoritative(request)
          const now = yield* clock.now
          const resources: Array<OrphanSymmetryObservedResource> = []
          const cursors = new Set<string>()
          let cursor: string | null = null
          let observedAt = now.toISOString()
          for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
            const pageValue: OrphanSymmetryDiscoveryPage = yield* discovery.discoverPage(
              request,
              cursor,
            )
            const page: OrphanSymmetryDiscoveryPage = yield* Schema.decodeUnknownEffect(
              OrphanSymmetryDiscoveryPage,
              {
                onExcessProperty: 'error',
              },
            )(pageValue).pipe(
              Effect.mapError(() =>
                failure('orphan.symmetry.discovery.decode', 'ambiguous-discovery'),
              ),
            )
            if (
              page.organizationId !== request.organizationId ||
              page.runId !== request.runId ||
              page.cursor !== cursor
            )
              return yield* failure('orphan.symmetry.discovery.scope', 'invalid-scope')
            if (page.resources.length > MAX_PAGE_SIZE)
              return yield* failure('orphan.symmetry.discovery.page', 'unbounded-discovery')
            if (page.complete !== (page.nextCursor === null))
              return yield* failure('orphan.symmetry.discovery.completion', 'ambiguous-discovery')
            for (const resource of page.resources) {
              const timestamp = Date.parse(resource.observedAt)
              if (
                resource.organizationId !== request.organizationId ||
                !Number.isFinite(timestamp) ||
                now.getTime() - timestamp > MAX_DISCOVERY_AGE_MS ||
                timestamp - now.getTime() > MAX_FUTURE_SKEW_MS
              )
                return yield* failure('orphan.symmetry.discovery.resource', 'stale-discovery')
              if (timestamp < Date.parse(observedAt)) observedAt = resource.observedAt
              resources.push(resource)
            }
            if (page.nextCursor === null) {
              const findings = yield* compareOrphanSymmetry(
                request.organizationId,
                authoritative,
                resources,
              )
              const authorityFingerprint = yield* fingerprintOrphanSymmetry(authoritative)
              const discoveryFingerprint = yield* fingerprintOrphanSymmetry({
                authoritative,
                observed: resources,
                findings,
              })
              return yield* repository.applyAtomic({
                ...request,
                observedAt,
                authorityFingerprint,
                discoveryFingerprint,
                findings,
              })
            }
            if (cursors.has(page.nextCursor))
              return yield* failure('orphan.symmetry.discovery.cursor', 'ambiguous-discovery')
            cursors.add(page.nextCursor)
            cursor = page.nextCursor
          }
          return yield* failure('orphan.symmetry.discovery.bound', 'unbounded-discovery')
        }),
    })
  }),
)

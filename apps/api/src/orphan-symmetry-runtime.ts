import { Effect, Layer, Schema } from 'effect'
import {
  fingerprintOrphanSymmetry,
  OrphanSymmetryClockLayer,
  OrphanSymmetryControl,
  OrphanSymmetryControlLive,
  OrphanSymmetryDiscoveryLayer,
  OrphanSymmetryError,
  OrphanSymmetryRepositoryLayer,
  type OrphanSymmetryDiscoveryPage,
  type OrphanSymmetryObservedResource,
  type OrphanSymmetryRequest,
  type OrphanSymmetryResult,
} from '@gridora/orphan-control'
import {
  resourceComment,
  tunnelResourceName,
  type CloudflareApiShape,
} from '@gridora/cloudflare-control'
import {
  loadOrphanSymmetryAgentObservationPage,
  loadOrphanSymmetryDnsAuthorities,
  loadOrphanSymmetryTunnelAuthorities,
  makeOrphanSymmetryD1Repository,
  type OrphanD1Database,
} from '@gridora/orphan-d1'

const Cursor = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
)

export interface OrphanSymmetrySourcePage {
  readonly resources: ReadonlyArray<OrphanSymmetryObservedResource>
  readonly nextCursor: string | null
}

type OwnerScope = OrphanSymmetryObservedResource['ownerScope']

export interface AgentSymmetryInventory {
  readonly organizationId: string
  readonly observedAt: string
  readonly containers: ReadonlyArray<{
    readonly nodeId: string
    readonly containerId: string
    readonly deploymentId: string
    readonly serverId: string
    readonly desiredRevision: number
    readonly ownerScope: OwnerScope
  }>
  readonly ports: ReadonlyArray<{
    readonly nodeId: string
    readonly leaseId: string
    readonly serverId: string
    readonly protocol: 'tcp' | 'udp'
    readonly publicPort: number
    readonly containerPort: number
    readonly operationId: string
    readonly revision: number
    readonly ownerScope: OwnerScope
  }>
}

/** Project a bounded, label-derived Docker inventory into comparable evidence. */
export const projectAgentSymmetryInventory = (
  request: OrphanSymmetryRequest,
  inventory: AgentSymmetryInventory,
): Effect.Effect<ReadonlyArray<OrphanSymmetryObservedResource>, OrphanSymmetryError> =>
  Effect.gen(function* () {
    if (
      inventory.organizationId !== request.organizationId ||
      inventory.containers.length + inventory.ports.length > 100
    )
      return yield* failure(
        'orphan.symmetry.agent.inventory',
        inventory.organizationId === request.organizationId
          ? 'unbounded-discovery'
          : 'invalid-scope',
      )
    const resources: Array<OrphanSymmetryObservedResource> = []
    for (const container of inventory.containers) {
      resources.push({
        organizationId: request.organizationId,
        kind: 'deployment-container',
        resourceKey: `${container.nodeId}:${container.serverId}`,
        resourceId: container.containerId,
        nodeId: container.nodeId,
        fingerprint: yield* fingerprintOrphanSymmetry({
          deploymentId: container.deploymentId,
          serverId: container.serverId,
          nodeId: container.nodeId,
          desiredRevision: container.desiredRevision,
        }).pipe(Effect.mapError(() => failure('orphan.symmetry.agent.container.fingerprint'))),
        ownerScope: container.ownerScope,
        observedAt: inventory.observedAt,
      })
    }
    for (const port of inventory.ports) {
      resources.push({
        organizationId: request.organizationId,
        kind: 'port-lease',
        resourceKey: `${port.nodeId}:${port.protocol}:${port.publicPort}`,
        resourceId: port.leaseId,
        nodeId: port.nodeId,
        fingerprint: yield* fingerprintOrphanSymmetry({
          leaseId: port.leaseId,
          serverId: port.serverId,
          nodeId: port.nodeId,
          protocol: port.protocol,
          publicPort: port.publicPort,
          containerPort: port.containerPort,
          operationId: port.operationId,
          revision: port.revision,
        }).pipe(Effect.mapError(() => failure('orphan.symmetry.agent.port.fingerprint'))),
        ownerScope: port.ownerScope,
        observedAt: inventory.observedAt,
      })
    }
    return resources
  })

export const projectDnsSymmetryRecord = (
  request: OrphanSymmetryRequest,
  record: {
    readonly providerRecordId: string
    readonly hostname: string
    readonly target: string
    readonly ownerScope: OwnerScope
    readonly observedAt: string
  },
): Effect.Effect<OrphanSymmetryObservedResource, OrphanSymmetryError> =>
  fingerprintOrphanSymmetry({
    hostname: record.hostname,
    target: record.target,
    providerRecordId: record.providerRecordId,
  }).pipe(
    Effect.mapError(() => failure('orphan.symmetry.dns.fingerprint')),
    Effect.map((fingerprint) => ({
      organizationId: request.organizationId,
      kind: 'dns-record' as const,
      resourceKey: record.hostname,
      resourceId: record.providerRecordId,
      nodeId: null,
      fingerprint,
      ownerScope: record.ownerScope,
      observedAt: record.observedAt,
    })),
  )

export const projectTunnelSymmetryAuthority = (
  request: OrphanSymmetryRequest,
  tunnel: {
    readonly nodeId: string
    readonly tunnelId: string
    readonly hostname: string
    readonly ownerScope: OwnerScope
    readonly observedAt: string
  },
): Effect.Effect<OrphanSymmetryObservedResource, OrphanSymmetryError> =>
  fingerprintOrphanSymmetry({
    nodeId: tunnel.nodeId,
    tunnelId: tunnel.tunnelId,
    hostname: tunnel.hostname,
  }).pipe(
    Effect.mapError(() => failure('orphan.symmetry.tunnel.fingerprint')),
    Effect.map((fingerprint) => ({
      organizationId: request.organizationId,
      kind: 'tunnel-authority' as const,
      resourceKey: tunnel.nodeId,
      resourceId: tunnel.tunnelId,
      nodeId: tunnel.nodeId,
      fingerprint,
      ownerScope: tunnel.ownerScope,
      observedAt: tunnel.observedAt,
    })),
  )

/** A read-only source has no stop, delete, update, or put capability. */
export interface OrphanSymmetryReadSource {
  readonly name: 'agent' | 'dns' | 'tunnel' | 'r2'
  readonly list: (
    request: OrphanSymmetryRequest,
    cursor: string | null,
  ) => Effect.Effect<OrphanSymmetrySourcePage, OrphanSymmetryError>
}

const failure = (
  operation: string,
  code: (typeof OrphanSymmetryError.Type)['code'] = 'ambiguous-discovery',
) => new OrphanSymmetryError({ operation, code, message: 'orphan symmetry reconciliation failed' })

const parseCursor = (
  value: string | null,
): Effect.Effect<
  { readonly sourceIndex: number; readonly sourceCursor: string | null },
  OrphanSymmetryError
> => {
  if (value === null) return Effect.succeed({ sourceIndex: 0, sourceCursor: null })
  const separator = value.indexOf(':')
  const index = Number(value.slice(1, separator))
  const sourceCursor = value.slice(separator + 1)
  if (
    !value.startsWith('s') ||
    separator < 2 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    sourceCursor.length === 0
  )
    return Effect.fail(failure('orphan.symmetry.runtime.cursor'))
  return Effect.succeed({
    sourceIndex: index,
    sourceCursor: sourceCursor === 'start' ? null : sourceCursor,
  })
}

const compositeCursor = (sourceIndex: number, sourceCursor: string | null) =>
  `s${sourceIndex}:${sourceCursor ?? 'start'}`

/**
 * Compose fixed read-only sources into the cursor contract consumed by the
 * durable control. A source must finish before the next source starts. The
 * cursor never contains credentials, provider responses, or object metadata.
 */
export const makeOrphanSymmetryDiscovery = (sources: ReadonlyArray<OrphanSymmetryReadSource>) => ({
  discoverPage: (
    request: OrphanSymmetryRequest,
    cursor: string | null,
  ): Effect.Effect<OrphanSymmetryDiscoveryPage, OrphanSymmetryError> =>
    Effect.gen(function* () {
      const requiredSources = ['agent', 'dns', 'tunnel', 'r2'] as const
      if (
        sources.length !== requiredSources.length ||
        requiredSources.some((name, index) => sources[index]?.name !== name)
      )
        return yield* failure('orphan.symmetry.runtime.sources', 'ambiguous-discovery')
      const decoded = yield* parseCursor(cursor)
      const source = sources[decoded.sourceIndex]
      if (source === undefined) return yield* failure('orphan.symmetry.runtime.source')
      const page = yield* source.list(request, decoded.sourceCursor)
      if (page.resources.length > 100)
        return yield* failure('orphan.symmetry.runtime.source.bound', 'unbounded-discovery')
      const allowedKinds: Readonly<Record<OrphanSymmetryReadSource['name'], ReadonlySet<string>>> =
        {
          agent: new Set(['deployment-container', 'port-lease']),
          dns: new Set(['dns-record']),
          tunnel: new Set(['tunnel-authority']),
          r2: new Set(['backup-object']),
        }
      if (
        page.resources.some(
          (resource) =>
            resource.organizationId !== request.organizationId ||
            !allowedKinds[source.name].has(resource.kind),
        )
      )
        return yield* failure('orphan.symmetry.runtime.source.scope', 'invalid-scope')
      let nextCursor: string | null
      if (page.nextCursor !== null) {
        const safe = yield* Schema.decodeUnknownEffect(Cursor)(page.nextCursor).pipe(
          Effect.mapError(() => failure('orphan.symmetry.runtime.source.cursor')),
        )
        nextCursor = compositeCursor(decoded.sourceIndex, safe)
      } else {
        nextCursor =
          decoded.sourceIndex + 1 < sources.length
            ? compositeCursor(decoded.sourceIndex + 1, null)
            : null
      }
      return {
        organizationId: request.organizationId,
        runId: request.runId,
        cursor,
        nextCursor,
        complete: nextCursor === null,
        resources: page.resources,
      }
    }),
})

export interface OrphanSymmetryR2ListBucket {
  readonly list: (input: {
    readonly prefix: string
    readonly cursor?: string
    readonly limit: number
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>
    readonly truncated: boolean
    readonly cursor?: string
  }>
}

/**
 * Build a bounded R2 inventory without accepting an R2 delete capability.
 * Objects are grouped by the exact tenant backup prefix. A partial upload with
 * chunks but no manifest remains visible as one unmanaged prefix.
 */
export const discoverR2BackupPrefixes = (
  bucket: OrphanSymmetryR2ListBucket,
  request: OrphanSymmetryRequest,
  now: () => Date,
): Effect.Effect<OrphanSymmetrySourcePage, OrphanSymmetryError> =>
  Effect.gen(function* () {
    const organizationPrefix = `organizations/${request.organizationId}/`
    const pattern = new RegExp(
      `^organizations/${request.organizationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/servers/([A-Za-z0-9_-]{1,128})/backups/([A-Za-z0-9_-]{1,128})/(?:manifest\\.json|chunks/[0-9]{8}\\.bin)$`,
    )
    const prefixes = new Map<string, string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = yield* Effect.tryPromise({
        try: () =>
          bucket.list({
            prefix: organizationPrefix,
            ...(cursor === undefined ? {} : { cursor }),
            limit: 100,
          }),
        catch: () => failure('orphan.symmetry.r2.list', 'persistence-failed'),
      })
      if (page.objects.length > 100)
        return yield* failure('orphan.symmetry.r2.page', 'unbounded-discovery')
      for (const object of page.objects) {
        if (!object.key.startsWith(organizationPrefix))
          return yield* failure('orphan.symmetry.r2.scope', 'invalid-scope')
        const match = pattern.exec(object.key)
        if (match === null) return yield* failure('orphan.symmetry.r2.key', 'ambiguous-discovery')
        const backupId = match[2]
        if (backupId === undefined)
          return yield* failure('orphan.symmetry.r2.key', 'ambiguous-discovery')
        const prefix = object.key.slice(0, object.key.lastIndexOf('/'))
        const backupPrefix = prefix.endsWith('/chunks')
          ? prefix.slice(0, -'/chunks'.length)
          : prefix
        prefixes.set(backupPrefix, backupId)
        if (prefixes.size > 100)
          return yield* failure('orphan.symmetry.r2.prefixes', 'unbounded-discovery')
      }
      if (!page.truncated) {
        const resources: Array<OrphanSymmetryObservedResource> = []
        for (const [resourceKey, resourceId] of [...prefixes].sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          const fingerprint = yield* fingerprintOrphanSymmetry({ r2Key: resourceKey }).pipe(
            Effect.mapError(() => failure('orphan.symmetry.r2.fingerprint')),
          )
          resources.push({
            organizationId: request.organizationId,
            kind: 'backup-object',
            resourceKey,
            resourceId,
            nodeId: null,
            fingerprint,
            ownerScope: 'tenant',
            observedAt: now().toISOString(),
          })
        }
        return { resources, nextCursor: null }
      }
      if (page.cursor === undefined || page.cursor.length === 0 || seenCursors.has(page.cursor))
        return yield* failure('orphan.symmetry.r2.cursor')
      seenCursors.add(page.cursor)
      cursor = page.cursor
    }
    return yield* failure('orphan.symmetry.r2.bound', 'unbounded-discovery')
  })

const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const resultArray = (
  value: unknown,
  operation: string,
): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, OrphanSymmetryError> => {
  const envelope = object(value)
  if (envelope === undefined || !Array.isArray(envelope.result) || envelope.result.length > 100)
    return Effect.fail(failure(operation))
  const resources: Array<Readonly<Record<string, unknown>>> = []
  for (const item of envelope.result) {
    const decoded = object(item)
    if (decoded === undefined) return Effect.fail(failure(operation))
    resources.push(decoded)
  }
  return Effect.succeed(resources)
}

export interface ProductionOrphanSymmetrySourceOptions {
  readonly database: OrphanD1Database
  readonly dnsApi: CloudflareApiShape
  readonly tunnelApi: CloudflareApiShape
  readonly cloudflareAccountId: string
  readonly r2: OrphanSymmetryR2ListBucket
  readonly now?: () => Date
}

/**
 * Production read adapters. DNS uses an exact zone/type/name and owner comment.
 * Tunnel uses the configured account and canonical Gridora name. Agent data is
 * accepted telemetry/observation state in D1. No adapter has a mutation method.
 */
export const makeProductionOrphanSymmetrySources = (
  options: ProductionOrphanSymmetrySourceOptions,
): ReadonlyArray<OrphanSymmetryReadSource> => {
  const now = options.now ?? (() => new Date())
  return [
    {
      name: 'agent',
      list: (request, cursor) =>
        loadOrphanSymmetryAgentObservationPage(options.database, request, cursor),
    },
    {
      name: 'dns',
      list: (request, cursor) =>
        Effect.gen(function* () {
          if (cursor !== null) return yield* failure('orphan.symmetry.dns.cursor')
          const authorities = yield* loadOrphanSymmetryDnsAuthorities(options.database, request)
          const resources: Array<OrphanSymmetryObservedResource> = []
          for (const authority of authorities) {
            const response = yield* options.dnsApi
              .request({
                method: 'GET',
                path: `/zones/${encodeURIComponent(authority.zoneId)}/dns_records?type=${encodeURIComponent(authority.recordType)}&name.exact=${encodeURIComponent(authority.hostname)}&match=all`,
              })
              .pipe(
                Effect.mapError(() =>
                  failure('orphan.symmetry.dns.provider', 'persistence-failed'),
                ),
              )
            const records = yield* resultArray(response, 'orphan.symmetry.dns.provider.decode')
            for (const record of records) {
              if (
                typeof record.id !== 'string' ||
                record.type !== authority.recordType ||
                record.name !== authority.hostname ||
                typeof record.content !== 'string'
              )
                return yield* failure('orphan.symmetry.dns.provider.scope', 'invalid-scope')
              resources.push(
                yield* projectDnsSymmetryRecord(request, {
                  providerRecordId: record.id,
                  hostname: authority.hostname,
                  target: record.content,
                  ownerScope:
                    record.comment ===
                    resourceComment({
                      organizationId: request.organizationId,
                      ownerResourceId: authority.serverId,
                    })
                      ? 'tenant'
                      : 'foreign',
                  observedAt: now().toISOString(),
                }),
              )
            }
          }
          return { resources, nextCursor: null }
        }),
    },
    {
      name: 'tunnel',
      list: (request, cursor) =>
        Effect.gen(function* () {
          if (cursor !== null) return yield* failure('orphan.symmetry.tunnel.cursor')
          if (options.cloudflareAccountId.length < 1)
            return yield* failure('orphan.symmetry.tunnel.account', 'invalid-scope')
          const authorities = yield* loadOrphanSymmetryTunnelAuthorities(options.database, request)
          const resources: Array<OrphanSymmetryObservedResource> = []
          for (const authority of authorities) {
            const expectedName = tunnelResourceName({
              accountId: options.cloudflareAccountId,
              organizationId: request.organizationId,
              ownerResourceId: authority.nodeId,
              name: 'Node tunnel',
            })
            const response = yield* options.tunnelApi
              .request({
                method: 'GET',
                path: `/accounts/${encodeURIComponent(options.cloudflareAccountId)}/cfd_tunnel?name=${encodeURIComponent(expectedName)}&is_deleted=false`,
              })
              .pipe(
                Effect.mapError(() =>
                  failure('orphan.symmetry.tunnel.provider', 'persistence-failed'),
                ),
              )
            const tunnels = yield* resultArray(response, 'orphan.symmetry.tunnel.provider.decode')
            for (const tunnel of tunnels) {
              if (typeof tunnel.id !== 'string' || typeof tunnel.name !== 'string')
                return yield* failure('orphan.symmetry.tunnel.provider.scope', 'invalid-scope')
              resources.push(
                yield* projectTunnelSymmetryAuthority(request, {
                  nodeId: authority.nodeId,
                  tunnelId: tunnel.id,
                  hostname: authority.hostname,
                  ownerScope: tunnel.name === expectedName ? 'tenant' : 'foreign',
                  observedAt: now().toISOString(),
                }),
              )
            }
          }
          return { resources, nextCursor: null }
        }),
    },
    {
      name: 'r2',
      list: (request, cursor) =>
        cursor === null
          ? discoverR2BackupPrefixes(options.r2, request, now)
          : Effect.fail(failure('orphan.symmetry.r2.source.cursor')),
    },
  ]
}

export interface OrphanSymmetryRuntimeOptions {
  readonly database: OrphanD1Database
  /** Fixed agent, DNS, Tunnel, and R2 read-only sources. */
  readonly sources: ReadonlyArray<OrphanSymmetryReadSource>
  readonly now?: () => Date
}

/** Queue/Workflow composition seam. This function registers no public route. */
export const makeOrphanSymmetryReconciliation = (options: OrphanSymmetryRuntimeOptions) => {
  const now = options.now ?? (() => new Date())
  const repository = makeOrphanSymmetryD1Repository(options.database, {
    now: () => now().toISOString(),
  })
  const dependencies = Layer.mergeAll(
    OrphanSymmetryDiscoveryLayer(makeOrphanSymmetryDiscovery(options.sources)),
    OrphanSymmetryRepositoryLayer(repository),
    OrphanSymmetryClockLayer(now),
  )
  const live = OrphanSymmetryControlLive.pipe(Layer.provide(dependencies))
  return (request: unknown): Effect.Effect<OrphanSymmetryResult, OrphanSymmetryError> =>
    Effect.gen(function* () {
      return yield* (yield* OrphanSymmetryControl).reconcile(request)
    }).pipe(Effect.provide(live))
}

export const makeProductionOrphanSymmetryReconciliation = (
  options: ProductionOrphanSymmetrySourceOptions,
) =>
  makeOrphanSymmetryReconciliation({
    database: options.database,
    sources: makeProductionOrphanSymmetrySources(options),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

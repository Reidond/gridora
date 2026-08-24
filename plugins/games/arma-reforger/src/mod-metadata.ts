import { Effect } from 'effect'
import {
  PluginControlError,
  type DesiredMod,
  type ModDependencyMetadata,
  type ModMetadataProvenance,
  type ModMetadataResolution,
} from '@gridora/plugin-sdk-control'

/**
 * This is deliberately not presented as a Bohemia endpoint. Reforger Mods
 * documents this public, third-party V2 API and normalizes Workshop metadata.
 * The plugin never fetches Workshop HTML or follows an upstream-supplied URL.
 */
export const ARMA_REFORGER_MOD_METADATA_ORIGIN = 'https://api.reforgermods.net'
export const ARMA_REFORGER_MOD_METADATA_PROVIDER = 'reforgermods-v2-third-party'
export const ARMA_REFORGER_WORKSHOP_SOURCE = 'reforger.armaplatform.com'

const PLUGIN_ID = 'arma-reforger'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 10_000
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000
const MAX_CACHE_TTL_MS = 60 * 60 * 1_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_JSON_DEPTH = 16
const MAX_JSON_NODES = 5_000
const MAX_DEPENDENCIES_PER_MOD = 256
const MAX_RESOLVED_MODS = 512
const MAX_UPSTREAM_POLLS = 2
const MAX_RETRY_AFTER_MS = 5_000
const MOD_ID = /^[A-Fa-f0-9]{16}$/
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type ArmaMetadataFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ArmaReforgerModMetadataResolver {
  readonly resolve: (
    mods: readonly DesiredMod[],
  ) => Effect.Effect<ModMetadataResolution, PluginControlError>
}

export interface ArmaReforgerModMetadataOptions {
  /** Test seam. Production resolves the current global Fetch only at call time. */
  readonly fetch?: ArmaMetadataFetch
  /** Test seam for the process-local public metadata cache. */
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly cacheTtlMs?: number
  readonly maxResponseBytes?: number
  /** Test seam; production uses an abort-aware bounded timer. */
  readonly pause?: (milliseconds: number) => Effect.Effect<void, PluginControlError>
}

type CacheEntry = {
  readonly metadata: ModDependencyMetadata
  readonly endpoint: string
  readonly fetchedAtEpochMs: number
  readonly expiresAtEpochMs: number
  readonly bodySha256: string
  readonly etag?: string
  readonly upstreamCache?: 'HIT' | 'MISS' | 'STALE'
  readonly workshopSource?: string
  readonly workshopOrigin?: string
}

type ResponseBody = {
  readonly value: unknown
  readonly sha256: string
}

class MetadataResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback

const canonicalId = (id: string): string => id.toUpperCase()
const text = (value: unknown, key: string): string | undefined =>
  typeof value === 'object' &&
  value !== null &&
  key in value &&
  typeof value[key as keyof typeof value] === 'string'
    ? (value[key as keyof typeof value] as string)
    : undefined
const boolean = (value: unknown, key: string): boolean | undefined =>
  typeof value === 'object' &&
  value !== null &&
  key in value &&
  typeof value[key as keyof typeof value] === 'boolean'
    ? (value[key as keyof typeof value] as boolean)
    : undefined
const array = (value: unknown, key: string): readonly unknown[] | undefined =>
  typeof value === 'object' &&
  value !== null &&
  key in value &&
  Array.isArray(value[key as keyof typeof value])
    ? (value[key as keyof typeof value] as readonly unknown[])
    : undefined

const safeHeader = (response: Response, name: string): string | undefined => {
  const value = response.headers.get(name)
  return value !== null && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value)
    ? value
    : undefined
}

const upstreamCache = (response: Response): 'HIT' | 'MISS' | 'STALE' | undefined => {
  const value = safeHeader(response, 'x-cache')
  return value === 'HIT' || value === 'MISS' || value === 'STALE' ? value : undefined
}

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  // Copy into an ArrayBuffer-backed view. TypeScript's DOM declaration rejects
  // a generic ArrayBufferLike even though the streamed body is byte-safe.
  const stable = Uint8Array.from(bytes)
  const digest = await crypto.subtle.digest('SHA-256', stable.buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const readBoundedJson = async (
  response: Response,
  maxResponseBytes: number,
): Promise<ResponseBody> => {
  const advertisedLength = response.headers.get('content-length')
  if (
    advertisedLength !== null &&
    (!/^\d+$/.test(advertisedLength) ||
      !Number.isSafeInteger(Number(advertisedLength)) ||
      Number(advertisedLength) > maxResponseBytes)
  )
    throw new MetadataResponseError(
      'metadata-response-too-large',
      'Metadata response exceeds the byte limit',
    )
  if (response.body === null)
    throw new MetadataResponseError('metadata-response-invalid', 'Metadata response is empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw new MetadataResponseError(
          'metadata-response-too-large',
          'Metadata response exceeds the byte limit',
        )
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (length === 0)
    throw new MetadataResponseError('metadata-response-invalid', 'Metadata response is empty')
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MetadataResponseError('metadata-response-invalid', 'Metadata response is not UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(decoded) as unknown
  } catch {
    throw new MetadataResponseError('metadata-response-invalid', 'Metadata response is not JSON')
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH)
      throw new MetadataResponseError(
        'metadata-response-invalid',
        'Metadata response exceeds JSON safety bounds',
      )
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
    } else if (typeof current.value === 'object' && current.value !== null) {
      for (const item of Object.values(current.value))
        pending.push({ value: item, depth: current.depth + 1 })
    }
  }
  return { value, sha256: await sha256(bytes) }
}

const discard = (response: Response) =>
  Effect.tryPromise({
    try: () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
    catch: () => new Error('metadata response cancellation failed'),
  }).pipe(Effect.catch(() => Effect.void))

const retryAfterMilliseconds = (response: Response): number => {
  const value = response.headers.get('retry-after')
  if (value === null || !/^\d{1,5}$/.test(value)) return 250
  return Math.min(Number(value) * 1_000, MAX_RETRY_AFTER_MS)
}

const retryAfterSeconds = (response: Response): number | undefined => {
  const value = response.headers.get('retry-after')
  return value !== null && /^\d{1,5}$/.test(value) ? Math.min(Number(value), 86_400) : undefined
}

const defaultPause = (milliseconds: number) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, milliseconds)
        const abort = () => {
          clearTimeout(timeout)
          reject(new Error('metadata pause aborted'))
        }
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
      }),
    catch: () =>
      new PluginControlError({
        pluginId: PLUGIN_ID,
        operation: 'resolveModMetadata',
        code: 'metadata-aborted',
        message: 'Metadata resolution was cancelled',
      }),
  })

const endpointFor = (id: string): string =>
  `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${encodeURIComponent(id)}`

const authoritativeWorkshopUrl = (id: string, value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MetadataResponseError(
      'metadata-response-invalid',
      'Metadata response has an invalid Workshop URL',
    )
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const candidate = parts[0] === 'workshop' ? parts[1] : undefined
  const workshopId = candidate?.slice(0, 16)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== ARMA_REFORGER_WORKSHOP_SOURCE ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    workshopId === undefined ||
    !MOD_ID.test(workshopId) ||
    canonicalId(workshopId) !== id
  )
    throw new MetadataResponseError(
      'metadata-response-invalid',
      'Metadata response does not bind the expected Workshop mod identity',
    )
  return url.toString()
}

const decodeDetail = (
  value: unknown,
  expectedId: string,
  failure: (code: string, message: string) => PluginControlError,
): Effect.Effect<ModDependencyMetadata, PluginControlError> =>
  Effect.try({
    try: () => {
      if (text(value, 'status') !== 'success')
        throw new MetadataResponseError(
          'metadata-response-invalid',
          'Metadata response is not a successful V2 detail envelope',
        )
      const mod =
        typeof value === 'object' && value !== null && 'mod' in value ? value.mod : undefined
      const id = text(mod, 'id')
      const version = text(mod, 'version')
      const workshopUrl = text(mod, 'workshopUrl')
      if (
        id === undefined ||
        !MOD_ID.test(id) ||
        canonicalId(id) !== expectedId ||
        version === undefined ||
        !SAFE_VERSION.test(version) ||
        workshopUrl === undefined
      )
        throw new MetadataResponseError(
          'metadata-response-invalid',
          'Metadata response omits the exact mod identity or version',
        )
      if (boolean(mod, 'private') === true)
        throw new MetadataResponseError(
          'metadata-incompatible',
          'The requested mod is private and cannot be staged',
        )
      const dependencies = array(mod, 'dependencies') ?? []
      if (dependencies.length > MAX_DEPENDENCIES_PER_MOD)
        throw new MetadataResponseError(
          'metadata-response-invalid',
          'Metadata response has too many direct dependencies',
        )
      const dependencyIds: string[] = []
      const seen = new Set<string>()
      for (const dependency of dependencies) {
        const dependencyId = text(dependency, 'id')
        if (dependencyId === undefined || !MOD_ID.test(dependencyId))
          throw new MetadataResponseError(
            'metadata-response-invalid',
            'Metadata response has an invalid dependency ID',
          )
        const canonical = canonicalId(dependencyId)
        if (seen.has(canonical))
          throw new MetadataResponseError(
            'metadata-response-invalid',
            'Metadata response repeats a dependency',
          )
        if (boolean(dependency, 'private') === true || boolean(dependency, 'published') === false)
          throw new MetadataResponseError(
            'metadata-incompatible',
            'A required dependency is not publicly stageable',
          )
        seen.add(canonical)
        dependencyIds.push(canonical)
      }
      const warnings: string[] = []
      if (boolean(mod, 'obsolete') === true) warnings.push('Metadata marks this mod obsolete')
      if (boolean(mod, 'unlisted') === true) warnings.push('Metadata marks this mod unlisted')
      return {
        source: ARMA_REFORGER_WORKSHOP_SOURCE,
        id: expectedId,
        version,
        dependencies: dependencyIds,
        sourceUrl: authoritativeWorkshopUrl(expectedId, workshopUrl),
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
    catch: (cause) =>
      failure(
        cause instanceof MetadataResponseError ? cause.code : 'metadata-response-invalid',
        cause instanceof Error ? cause.message : 'Metadata response is invalid',
      ),
  })

const errorEnvelopeCode = (value: unknown): string | undefined => {
  const error =
    typeof value === 'object' && value !== null && 'error' in value ? value.error : undefined
  const code = text(error, 'code')
  return code === 'RATE_LIMITED' ||
    code === 'DAILY_QUOTA_EXCEEDED' ||
    code === 'UPSTREAM_UNAVAILABLE' ||
    code === 'NOT_FOUND'
    ? code
    : undefined
}

const normalizeRequested = (
  mods: readonly DesiredMod[],
  failure: (code: string, message: string) => PluginControlError,
): Effect.Effect<readonly DesiredMod[], PluginControlError> =>
  Effect.try({
    try: () => {
      const normalized = new Map<string, DesiredMod>()
      for (const mod of mods) {
        if (mod.source !== ARMA_REFORGER_WORKSHOP_SOURCE || !MOD_ID.test(mod.id))
          throw failure(
            'metadata-source-unsupported',
            'Live metadata resolution supports only exact Arma Reforger Workshop IDs',
          )
        if (mod.requestedVersion !== undefined && !SAFE_VERSION.test(mod.requestedVersion))
          throw failure('metadata-version-invalid', 'Requested mod version is invalid')
        const id = canonicalId(mod.id)
        const key = `${mod.source}:${id}`
        const candidate: DesiredMod = {
          source: mod.source,
          id,
          loadOrder: mod.loadOrder,
          ...(mod.requestedVersion === undefined ? {} : { requestedVersion: mod.requestedVersion }),
        }
        const existing = normalized.get(key)
        if (
          existing !== undefined &&
          (existing.loadOrder !== candidate.loadOrder ||
            existing.requestedVersion !== candidate.requestedVersion)
        )
          throw failure(
            'metadata-request-conflict',
            'A mod is requested with conflicting versions or load order',
          )
        normalized.set(key, candidate)
      }
      return [...normalized.values()].sort(
        (left, right) => left.loadOrder - right.loadOrder || left.id.localeCompare(right.id),
      )
    },
    catch: (cause) =>
      cause instanceof PluginControlError
        ? cause
        : failure('metadata-request-invalid', 'Metadata request is invalid'),
  })

const offline = (): ModMetadataResolution => ({
  state: 'offline',
  catalog: [],
  provenance: [],
  warnings: [
    'External mod metadata was not fetched; dependency resolution is intentionally offline',
  ],
})

/** Deterministic preview/testing result. It never calls a network API. */
export const offlineArmaReforgerModMetadata = (): ModMetadataResolution => offline()

/**
 * Builds the only production metadata adapter for this plugin version. It
 * calls the exact V2 detail path, not a Workshop page, and cannot be pointed
 * at another origin through data or configuration.
 */
export const makeArmaReforgerModMetadataResolver = (
  options: ArmaReforgerModMetadataOptions = {},
): ArmaReforgerModMetadataResolver => {
  const fetch: ArmaMetadataFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const now = options.now ?? Date.now
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const cacheTtlMs = bounded(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS)
  const maxResponseBytes = bounded(options.maxResponseBytes, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES)
  const cache = new Map<string, CacheEntry>()
  const failure = (code: string, message: string, retryAfter?: number) =>
    new PluginControlError({
      pluginId: PLUGIN_ID,
      operation: 'resolveModMetadata',
      code,
      message,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    })
  const pause = options.pause ?? defaultPause

  const provenance = (
    entry: CacheEntry,
    cacheState: ModMetadataProvenance['cache'],
  ): ModMetadataProvenance => ({
    provider: ARMA_REFORGER_MOD_METADATA_PROVIDER,
    endpoint: entry.endpoint,
    fetchedAt: new Date(entry.fetchedAtEpochMs).toISOString(),
    expiresAt: new Date(entry.expiresAtEpochMs).toISOString(),
    cache: cacheState,
    bodySha256: entry.bodySha256,
    ...(entry.etag === undefined ? {} : { etag: entry.etag }),
    ...(entry.upstreamCache === undefined ? {} : { upstreamCache: entry.upstreamCache }),
    ...(entry.workshopSource === undefined ? {} : { workshopSource: entry.workshopSource }),
    ...(entry.workshopOrigin === undefined ? {} : { workshopOrigin: entry.workshopOrigin }),
  })

  const fetchResponse = (endpoint: string, etag: string | undefined) =>
    Effect.tryPromise({
      try: async (signal) => {
        const controller = new AbortController()
        let timedOut = false
        const abort = () => controller.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error('metadata request timed out'))
        }, timeoutMs)
        try {
          if (signal.aborted) throw new Error('metadata request aborted')
          return await fetch(endpoint, {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'x-api-client': 'gridora/0.1.0',
              'x-reforgermods-client': 'gridora',
              'x-reforgermods-client-version': '0.1.0',
              ...(etag === undefined ? {} : { 'if-none-match': etag }),
            },
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
          })
        } catch (cause) {
          if (timedOut)
            throw new MetadataResponseError('metadata-timeout', 'Metadata request timed out')
          throw cause
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
      },
      catch: (cause) =>
        failure(
          cause instanceof MetadataResponseError ? cause.code : 'metadata-network-unavailable',
          cause instanceof Error ? cause.message : 'Metadata transport is unavailable',
        ),
    })

  const readErrorCode = (response: Response) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return errorEnvelopeCode((await readBoundedJson(response, maxResponseBytes)).value)
        } catch {
          return undefined
        }
      },
      catch: () => new Error('metadata error envelope could not be read'),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

  const load = (
    id: string,
    requestedVersion: string | undefined,
    prior: CacheEntry | undefined,
    poll: number,
  ): Effect.Effect<
    { readonly entry: CacheEntry; readonly cache: ModMetadataProvenance['cache'] },
    PluginControlError
  > =>
    Effect.gen(function* () {
      const endpoint = endpointFor(id)
      const response = yield* fetchResponse(endpoint, prior?.etag)
      if (response.status === 304) {
        yield* discard(response)
        if (prior === undefined)
          return yield* failure(
            'metadata-response-invalid',
            'Metadata returned 304 without a matching cache entry',
          )
        const refreshedAt = now()
        const entry: CacheEntry = {
          ...prior,
          fetchedAtEpochMs: refreshedAt,
          expiresAtEpochMs: refreshedAt + cacheTtlMs,
          ...(safeHeader(response, 'etag') === undefined
            ? {}
            : { etag: safeHeader(response, 'etag')! }),
          ...(upstreamCache(response) === undefined
            ? {}
            : { upstreamCache: upstreamCache(response)! }),
        }
        if (requestedVersion !== undefined && entry.metadata.version !== requestedVersion)
          return yield* failure(
            'metadata-incompatible',
            'The requested mod version is not the current verified version',
          )
        cache.set(id, entry)
        return { entry, cache: 'revalidated' as const }
      }
      if (response.status === 202 || response.status === 503) {
        const delay = retryAfterMilliseconds(response)
        const retryAfter = retryAfterSeconds(response)
        yield* discard(response)
        if (poll >= MAX_UPSTREAM_POLLS)
          return yield* failure(
            'metadata-upstream-unavailable',
            'Metadata source did not produce a bounded detail response',
            retryAfter,
          )
        // Do not trust an upstream job/resource URL. Re-poll only this exact,
        // fixed-origin detail URL after a finite, cancellable delay.
        yield* pause(delay)
        return yield* load(id, requestedVersion, prior, poll + 1)
      }
      if (response.status === 429) {
        const upstreamCode = yield* readErrorCode(response)
        return yield* failure(
          upstreamCode === 'DAILY_QUOTA_EXCEEDED'
            ? 'metadata-quota-exhausted'
            : 'metadata-rate-limited',
          upstreamCode === 'DAILY_QUOTA_EXCEEDED'
            ? 'Metadata source daily quota is exhausted'
            : 'Metadata source rate limit is exhausted',
          retryAfterSeconds(response),
        )
      }
      if (response.status === 404) {
        yield* discard(response)
        return yield* failure(
          'metadata-not-found',
          'Metadata source does not know the requested mod',
        )
      }
      if (response.status < 200 || response.status >= 300) {
        const upstreamCode = yield* readErrorCode(response)
        return yield* failure(
          upstreamCode === 'UPSTREAM_UNAVAILABLE'
            ? 'metadata-upstream-unavailable'
            : 'metadata-upstream-error',
          'Metadata source returned an unexpected HTTP status',
          retryAfterSeconds(response),
        )
      }
      const parsed = yield* Effect.tryPromise({
        try: () => readBoundedJson(response, maxResponseBytes),
        catch: (cause) =>
          failure(
            cause instanceof MetadataResponseError ? cause.code : 'metadata-response-invalid',
            cause instanceof Error ? cause.message : 'Metadata response is invalid',
          ),
      })
      const metadata = yield* decodeDetail(parsed.value, id, failure)
      if (requestedVersion !== undefined && metadata.version !== requestedVersion)
        return yield* failure(
          'metadata-incompatible',
          'The requested mod version is not the current verified version',
        )
      const fetchedAt = now()
      const entry: CacheEntry = {
        metadata,
        endpoint,
        fetchedAtEpochMs: fetchedAt,
        expiresAtEpochMs: fetchedAt + cacheTtlMs,
        bodySha256: parsed.sha256,
        ...(safeHeader(response, 'etag') === undefined
          ? {}
          : { etag: safeHeader(response, 'etag')! }),
        ...(upstreamCache(response) === undefined
          ? {}
          : { upstreamCache: upstreamCache(response)! }),
        ...(safeHeader(response, 'x-workshop-source') === undefined
          ? {}
          : { workshopSource: safeHeader(response, 'x-workshop-source')! }),
        ...(safeHeader(response, 'x-workshop-origin') === undefined
          ? {}
          : { workshopOrigin: safeHeader(response, 'x-workshop-origin')! }),
      }
      cache.set(id, entry)
      return { entry, cache: 'upstream' as const }
    })

  const resolveOne = (id: string, requestedVersion: string | undefined) => {
    const cached = cache.get(id)
    const current = now()
    if (cached !== undefined && cached.expiresAtEpochMs > current) {
      if (requestedVersion !== undefined && cached.metadata.version !== requestedVersion)
        return Effect.fail(
          failure(
            'metadata-incompatible',
            'The requested mod version is not the current verified version',
          ),
        )
      return Effect.succeed({ entry: cached, cache: 'memory' as const })
    }
    return load(id, requestedVersion, cached, 0)
  }

  return {
    resolve: (requested) =>
      Effect.gen(function* () {
        const roots = yield* normalizeRequested(requested, failure)
        if (roots.length === 0)
          return {
            state: 'resolved' as const,
            catalog: [],
            provenance: [],
            warnings: [],
          }
        const catalog = new Map<string, ModDependencyMetadata>()
        const provenanceById = new Map<string, ModMetadataProvenance>()
        const queue = roots.map((mod) => ({ id: mod.id, requestedVersion: mod.requestedVersion }))
        while (queue.length > 0) {
          const next = queue.shift()!
          if (catalog.has(next.id)) continue
          if (catalog.size >= MAX_RESOLVED_MODS)
            return yield* failure(
              'metadata-resolution-too-large',
              'Metadata dependency graph exceeds the safe limit',
            )
          const resolved = yield* resolveOne(next.id, next.requestedVersion)
          catalog.set(next.id, resolved.entry.metadata)
          provenanceById.set(next.id, provenance(resolved.entry, resolved.cache))
          for (const dependency of resolved.entry.metadata.dependencies)
            if (!catalog.has(dependency))
              queue.push({ id: dependency, requestedVersion: undefined })
        }
        return {
          state: 'resolved' as const,
          catalog: [...catalog.values()],
          provenance: [...provenanceById.values()],
          warnings: [],
        }
      }),
  }
}

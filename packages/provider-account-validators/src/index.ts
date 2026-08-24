import { Effect, Schema } from 'effect'
import { ContaboCredentials, OvhPublicCloudCredentials } from '@gridora/contracts'
import {
  ProviderDiscoverySnapshot,
  type ProviderAccountValidationInput,
  type ProviderAccountValidatorShape,
  type ProviderCatalogEntry,
} from '@gridora/provider-account-control'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderBillingActionRequiredError,
  ProviderConflictError,
  ProviderNotFoundError,
  ProviderRateLimitError,
  ProviderTemporaryError,
  ProviderUnknownError,
  ProviderValidationError,
  type ProviderError,
  type ProviderId,
} from '@gridora/provider-sdk'

const MAX_CREDENTIAL_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 100_000
const PAGE_SIZE = 100
const MAX_PAGES = 8
const MAX_REGIONS = 256
const MAX_CATALOG_ITEMS = 512
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_TIMEOUT_MS = 30_000

export type ValidatorFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ProviderAccountValidatorOptions {
  readonly fetch?: ValidatorFetch
  /** Test seam in milliseconds. Positive integers are capped at 30 seconds; invalid values use 8 seconds. */
  readonly timeoutMs?: number
  readonly requestId?: () => string
}

interface Dependencies {
  readonly fetch: ValidatorFetch
  readonly timeoutMs: number
  readonly requestId: () => string
}

interface JsonResponse {
  readonly body: unknown
  readonly headers: Headers
}

class InvalidProviderResponse extends Error {}
class ProviderRequestAborted extends Error {}

const operation = (provider: ProviderId, action: string): string =>
  `providerAccount.${provider}.${action}`

const validationError = (
  provider: ProviderId,
  action: string,
  message: string,
  field?: string,
): ProviderValidationError =>
  new ProviderValidationError({
    provider,
    operation: operation(provider, action),
    message,
    ...(field === undefined ? {} : { field }),
  })

const providerResponseError = (
  provider: ProviderId,
  action: string,
  message: string,
): ProviderUnknownError =>
  new ProviderUnknownError({
    provider,
    operation: operation(provider, action),
    message,
  })

const dependencies = (options: ProviderAccountValidatorOptions): Dependencies => {
  const proposed = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs =
    Number.isSafeInteger(proposed) && proposed > 0
      ? Math.min(proposed, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS
  return {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs,
    requestId: options.requestId ?? (() => crypto.randomUUID()),
  }
}

const retryAfterSeconds = (headers: Headers): number | undefined => {
  const value = headers.get('retry-after')
  if (value === null || !/^\d{1,5}$/.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined
}

const httpError = (
  provider: ProviderId,
  action: string,
  status: number,
  headers: Headers,
): ProviderError => {
  const fields = {
    provider,
    operation: operation(provider, action),
    message: `${provider} returned HTTP ${status}`,
  }
  if (status === 401) return new ProviderAuthenticationError(fields)
  if (status === 403) return new ProviderAuthorizationError(fields)
  if (status === 404) return new ProviderNotFoundError(fields)
  if (status === 409) return new ProviderConflictError(fields)
  if (status === 400 || status === 422) return new ProviderValidationError(fields)
  if (status === 402) return new ProviderBillingActionRequiredError(fields)
  if (status === 429) {
    const retryAfter = retryAfterSeconds(headers)
    return new ProviderRateLimitError({
      ...fields,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    })
  }
  if (status === 408 || status === 425 || status >= 500) return new ProviderTemporaryError(fields)
  return new ProviderUnknownError(fields)
}

const assertSafeJsonShape = (value: unknown): void => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH)
      throw new InvalidProviderResponse('JSON structure exceeds safety bounds')
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
    } else if (typeof current.value === 'object' && current.value !== null) {
      for (const item of Object.values(current.value))
        pending.push({ value: item, depth: current.depth + 1 })
    }
  }
}

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (
    contentType === undefined ||
    (contentType !== 'application/json' && !/^[^/\s]+\/[^/\s]+\+json$/.test(contentType))
  )
    throw new InvalidProviderResponse('Provider response is not JSON')

  const advertisedLength = response.headers.get('content-length')
  if (advertisedLength !== null) {
    if (!/^\d+$/.test(advertisedLength))
      throw new InvalidProviderResponse('Provider response has an invalid byte length')
    const length = Number(advertisedLength)
    if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES)
      throw new InvalidProviderResponse('Provider response exceeds the byte limit')
  }

  if (response.body === null) throw new InvalidProviderResponse('Provider response is empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new InvalidProviderResponse('Provider response exceeds the byte limit')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new InvalidProviderResponse('Provider response is empty')

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new InvalidProviderResponse('Provider response is not valid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new InvalidProviderResponse('Provider response is not valid JSON')
  }
  assertSafeJsonShape(value)
  return value
}

const requestJson = (
  deps: Dependencies,
  provider: ProviderId,
  action: string,
  url: URL,
  expectedStatus: number,
  init: Omit<RequestInit, 'signal'>,
): Effect.Effect<JsonResponse, ProviderError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const controller = new AbortController()
      let rejectDeadline: (cause: ProviderRequestAborted) => void = () => undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject
      })
      const forwardAbort = () => {
        controller.abort()
        rejectDeadline(new ProviderRequestAborted('Provider request was aborted'))
      }
      signal.addEventListener('abort', forwardAbort, { once: true })
      const timeout = setTimeout(forwardAbort, deps.timeoutMs)
      try {
        if (signal.aborted) throw new ProviderRequestAborted('Provider request was aborted')
        const request = async () => {
          const response = await deps.fetch(url, {
            ...init,
            redirect: 'error',
            signal: controller.signal,
          })
          if (!response.ok || response.status !== expectedStatus) {
            await response.body?.cancel().catch(() => undefined)
            return { status: response.status, headers: response.headers } as const
          }
          return {
            status: response.status,
            headers: response.headers,
            body: await readBoundedJson(response),
          } as const
        }
        return await Promise.race([request(), deadline])
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', forwardAbort)
      }
    },
    catch: (cause) =>
      cause instanceof InvalidProviderResponse
        ? providerResponseError(provider, action, cause.message)
        : new ProviderTemporaryError({
            provider,
            operation: operation(provider, action),
            message: `${provider} request failed or timed out`,
          }),
  }).pipe(
    Effect.flatMap((response) =>
      'body' in response
        ? Effect.succeed({ body: response.body, headers: response.headers })
        : Effect.fail(httpError(provider, action, response.status, response.headers)),
    ),
  )

const parseCredentialJson = (
  provider: ProviderId,
  input: ProviderAccountValidationInput,
): Effect.Effect<unknown, ProviderValidationError> =>
  Effect.try({
    try: () => {
      if (
        input.credentialBytes.byteLength === 0 ||
        input.credentialBytes.byteLength > MAX_CREDENTIAL_BYTES
      )
        throw new Error('invalid credential length')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(input.credentialBytes)
      const value: unknown = JSON.parse(text)
      assertSafeJsonShape(value)
      return value
    },
    catch: () =>
      validationError(
        provider,
        'decodeCredentials',
        'Provider credentials are malformed',
        'credentials',
      ),
  })

const httpsEndpoint = (
  provider: ProviderId,
  action: string,
  field: string,
  value: string,
): Effect.Effect<URL, ProviderValidationError> =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== '' ||
        url.search !== ''
      )
        throw new Error('unsafe endpoint')
      return url
    },
    catch: () => validationError(provider, action, 'Provider endpoint must be an HTTPS URL', field),
  })

const approvedEndpoint = (
  provider: ProviderId,
  action: string,
  field: string,
  value: string,
  approved: (url: URL) => boolean,
): Effect.Effect<URL, ProviderValidationError> =>
  httpsEndpoint(provider, action, field, value).pipe(
    Effect.flatMap((url) =>
      approved(url)
        ? Effect.succeed(url)
        : Effect.fail(
            validationError(provider, action, 'Provider endpoint is not approved', field),
          ),
    ),
  )

const approvedDiscoveredEndpoint = (
  provider: ProviderId,
  action: string,
  value: string,
  approved: (url: URL) => boolean,
): Effect.Effect<URL, ProviderUnknownError> =>
  httpsEndpoint(provider, action, 'providerResponse', value).pipe(
    Effect.mapError(() =>
      providerResponseError(provider, action, 'Provider returned an invalid endpoint'),
    ),
    Effect.flatMap((url) =>
      approved(url)
        ? Effect.succeed(url)
        : Effect.fail(
            providerResponseError(provider, action, 'Provider returned an unapproved endpoint'),
          ),
    ),
  )

const isOvhAuthEndpoint = (url: URL): boolean =>
  url.port === '' &&
  (url.hostname === 'auth.cloud.ovh.net' || url.hostname === 'auth.cloud.ovh.us') &&
  /^\/v3(?:\.0)?\/?$/.test(url.pathname)

const isOvhComputeEndpoint = (url: URL): boolean =>
  url.port === '' &&
  ['cloud.ovh.net', 'cloud.ovh.us'].some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
  )

const isContaboTokenEndpoint = (url: URL): boolean =>
  url.port === '' &&
  url.hostname === 'auth.contabo.com' &&
  url.pathname === '/auth/realms/contabo/protocol/openid-connect/token'

const isContaboApiEndpoint = (url: URL): boolean =>
  url.port === '' && url.hostname === 'api.contabo.com' && url.pathname === '/'

const appendPath = (base: URL, suffix: string): URL => {
  const result = new URL(base.href)
  result.pathname = `${result.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  result.search = ''
  result.hash = ''
  return result
}

const isSafeHttpCredential = (value: string): boolean =>
  value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/.test(value)

const finalSnapshot = (
  provider: ProviderId,
  regions: readonly string[],
  projects: readonly string[],
  catalog: readonly ProviderCatalogEntry[],
): Effect.Effect<ProviderDiscoverySnapshot, ProviderUnknownError> =>
  Schema.decodeUnknownEffect(ProviderDiscoverySnapshot, { onExcessProperty: 'error' })({
    regions: [...new Set(regions)].sort(),
    projects: [...new Set(projects)].sort(),
    catalog: [...catalog].sort((left, right) =>
      left.region === right.region
        ? left.plan < right.plan
          ? -1
          : left.plan > right.plan
            ? 1
            : 0
        : left.region < right.region
          ? -1
          : 1,
    ),
  }).pipe(
    Effect.mapError(() =>
      providerResponseError(provider, 'normalizeDiscovery', 'Provider discovery data is invalid'),
    ),
  )

const KeystoneEndpoint = Schema.Struct({
  interface: Schema.String,
  region: Schema.optional(Schema.String),
  region_id: Schema.optional(Schema.String),
  url: Schema.String,
})
const KeystoneService = Schema.Struct({
  type: Schema.String,
  endpoints: Schema.Array(KeystoneEndpoint),
})
const KeystoneResponse = Schema.Struct({
  token: Schema.Struct({
    project: Schema.Struct({ id: Schema.String }),
    catalog: Schema.Array(KeystoneService),
  }),
})
const OvhFlavor = Schema.Struct({
  id: Schema.String,
  vcpus: Schema.Number,
  ram: Schema.Number,
  disk: Schema.Number,
})
const OvhFlavorPage = Schema.Struct({ flavors: Schema.Array(OvhFlavor) })

const decodeOvhCredentials = (input: ProviderAccountValidationInput) =>
  parseCredentialJson('ovhcloud', input).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(OvhPublicCloudCredentials, { onExcessProperty: 'error' })(value),
    ),
    Effect.mapError(() =>
      validationError(
        'ovhcloud',
        'decodeCredentials',
        'OVHcloud credentials are malformed',
        'credentials',
      ),
    ),
  )

const ovhFlavorPages = (
  deps: Dependencies,
  endpoint: URL,
  token: string,
): Effect.Effect<void, ProviderError> => {
  const load = (
    page: number,
    marker: string | undefined,
    seen: ReadonlySet<string>,
    count: number,
  ): Effect.Effect<void, ProviderError> => {
    if (page > MAX_PAGES)
      return Effect.fail(
        providerResponseError(
          'ovhcloud',
          'discoverFlavors',
          'OpenStack pagination exceeded the limit',
        ),
      )
    const url = appendPath(endpoint, 'flavors/detail')
    url.searchParams.set('limit', String(PAGE_SIZE))
    if (marker !== undefined) url.searchParams.set('marker', marker)
    return requestJson(deps, 'ovhcloud', 'discoverFlavors', url, 200, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-auth-token': token },
    }).pipe(
      Effect.flatMap((response) =>
        Schema.decodeUnknownEffect(OvhFlavorPage)(response.body).pipe(
          Effect.mapError(() =>
            providerResponseError(
              'ovhcloud',
              'discoverFlavors',
              'OpenStack flavor response is invalid',
            ),
          ),
        ),
      ),
      Effect.flatMap((body) => {
        if (body.flavors.length > PAGE_SIZE || count + body.flavors.length > MAX_CATALOG_ITEMS)
          return Effect.fail(
            providerResponseError(
              'ovhcloud',
              'discoverFlavors',
              'OpenStack flavor count exceeds the limit',
            ),
          )
        const nextSeen = new Set(seen)
        for (const flavor of body.flavors)
          if (flavor.id.length === 0 || flavor.id.length > 128 || nextSeen.has(flavor.id))
            return Effect.fail(
              providerResponseError(
                'ovhcloud',
                'discoverFlavors',
                'OpenStack flavor identifiers are invalid',
              ),
            )
          else if (
            !Number.isSafeInteger(flavor.vcpus) ||
            flavor.vcpus <= 0 ||
            !Number.isSafeInteger(flavor.ram) ||
            flavor.ram <= 0 ||
            !Number.isSafeInteger(flavor.disk) ||
            flavor.disk < 0
          )
            return Effect.fail(
              providerResponseError(
                'ovhcloud',
                'discoverFlavors',
                'OpenStack flavor dimensions are invalid',
              ),
            )
          else nextSeen.add(flavor.id)
        if (body.flavors.length === 0) return Effect.void
        const nextMarker = body.flavors.at(-1)?.id
        if (nextMarker === undefined || nextMarker === marker)
          return Effect.fail(
            providerResponseError(
              'ovhcloud',
              'discoverFlavors',
              'OpenStack flavor pagination did not advance',
            ),
          )
        return load(page + 1, nextMarker, nextSeen, count + body.flavors.length)
      }),
    )
  }
  return load(1, undefined, new Set(), 0)
}

export const makeOvhProviderAccountValidator = (
  options: ProviderAccountValidatorOptions = {},
): ProviderAccountValidatorShape => {
  const deps = dependencies(options)
  return {
    validate: (input) =>
      Effect.gen(function* () {
        const credentials = yield* decodeOvhCredentials(input)
        const authBase = yield* approvedEndpoint(
          'ovhcloud',
          'authenticate',
          'authUrl',
          credentials.authUrl,
          isOvhAuthEndpoint,
        )
        const auth = yield* requestJson(
          deps,
          'ovhcloud',
          'authenticate',
          appendPath(authBase, 'auth/tokens'),
          201,
          {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
              auth: {
                identity: {
                  methods: ['application_credential'],
                  application_credential: {
                    id: credentials.applicationCredentialId,
                    secret: credentials.applicationCredentialSecret,
                  },
                },
              },
            }),
          },
        )
        const identity = yield* Schema.decodeUnknownEffect(KeystoneResponse)(auth.body).pipe(
          Effect.mapError(() =>
            providerResponseError(
              'ovhcloud',
              'authenticate',
              'OpenStack identity response is invalid',
            ),
          ),
        )
        if (identity.token.project.id !== credentials.projectId)
          return yield* new ProviderAuthorizationError({
            provider: 'ovhcloud',
            operation: operation('ovhcloud', 'authenticate'),
            message: 'OpenStack token is scoped to a different project',
          })
        const token = auth.headers.get('x-subject-token')
        if (token === null || !isSafeHttpCredential(token))
          return yield* providerResponseError(
            'ovhcloud',
            'authenticate',
            'OpenStack identity response omitted the subject token',
          )

        const publicComputeCandidates = identity.token.catalog
          .filter((service) => service.type === 'compute')
          .flatMap((service) => service.endpoints)
          .filter((endpoint) => endpoint.interface === 'public')
        const publicCompute = [
          ...new Map(
            publicComputeCandidates.map((endpoint) => [
              `${endpoint.region_id ?? endpoint.region ?? ''}\u0000${endpoint.url}`,
              endpoint,
            ]),
          ).values(),
        ]
        const regions = publicCompute
          .map((endpoint) => endpoint.region_id ?? endpoint.region)
          .filter((region): region is string => region !== undefined)
        if (regions.length === 0 || regions.length > MAX_REGIONS)
          return yield* providerResponseError(
            'ovhcloud',
            'discoverCatalog',
            'OpenStack compute region catalog is missing or too large',
          )
        const selected = publicCompute.filter(
          (endpoint) => (endpoint.region_id ?? endpoint.region) === credentials.region,
        )
        if (selected.length === 0)
          return yield* validationError(
            'ovhcloud',
            'discoverCatalog',
            'Configured OpenStack region is not accessible',
            'region',
          )
        if (selected.length > 1)
          return yield* providerResponseError(
            'ovhcloud',
            'discoverCatalog',
            'OpenStack returned ambiguous public compute endpoints',
          )
        const compute = yield* approvedDiscoveredEndpoint(
          'ovhcloud',
          'discoverCatalog',
          selected[0]!.url,
          isOvhComputeEndpoint,
        )
        yield* ovhFlavorPages(deps, compute, token)

        // Nova flavors do not carry currency or price. Emitting a priced catalog entry here would
        // fabricate billing data; keep it empty until an OVH billing-catalog adapter is composed.
        return yield* finalSnapshot('ovhcloud', regions, [credentials.projectId], [])
      }),
  }
}

const ContaboTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
})
const ContaboPage = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  _pagination: Schema.Struct({
    page: Schema.Number,
    totalPages: Schema.Number,
  }),
})
const ContaboDataCenter = Schema.Struct({
  regionSlug: Schema.String,
  capabilities: Schema.Array(Schema.String),
})

const decodeContaboCredentials = (input: ProviderAccountValidationInput) =>
  parseCredentialJson('contabo', input).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ContaboCredentials, { onExcessProperty: 'error' })(value),
    ),
    Effect.mapError(() =>
      validationError(
        'contabo',
        'decodeCredentials',
        'Contabo credentials are malformed',
        'credentials',
      ),
    ),
  )

const contaboRequestId = (
  deps: Dependencies,
  action: string,
): Effect.Effect<string, ProviderValidationError> =>
  Effect.try({
    try: () => deps.requestId(),
    catch: () => validationError('contabo', action, 'Contabo request ID generation failed'),
  }).pipe(
    Effect.flatMap((requestId) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
        ? Effect.succeed(requestId)
        : Effect.fail(validationError('contabo', action, 'Contabo request ID is invalid')),
    ),
  )

const contaboPage = (
  deps: Dependencies,
  base: URL,
  token: string,
  path: string,
  action: string,
  page: number,
  size: number,
): Effect.Effect<typeof ContaboPage.Type, ProviderError> => {
  const url = appendPath(base, path)
  url.searchParams.set('page', String(page))
  url.searchParams.set('size', String(size))
  return contaboRequestId(deps, action).pipe(
    Effect.flatMap((requestId) =>
      requestJson(deps, 'contabo', action, url, 200, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'x-request-id': requestId,
        },
      }),
    ),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(ContaboPage)(response.body).pipe(
        Effect.mapError(() =>
          providerResponseError('contabo', action, 'Contabo paginated response is invalid'),
        ),
      ),
    ),
  )
}

const contaboPages = (
  deps: Dependencies,
  base: URL,
  token: string,
  path: string,
  action: string,
  maxItems: number,
): Effect.Effect<readonly unknown[], ProviderError> => {
  const load = (
    page: number,
    expectedPages: number | undefined,
    accumulated: readonly unknown[],
  ): Effect.Effect<readonly unknown[], ProviderError> => {
    if (page > MAX_PAGES)
      return Effect.fail(
        providerResponseError('contabo', action, 'Contabo pagination exceeded the limit'),
      )
    return contaboPage(deps, base, token, path, action, page, PAGE_SIZE).pipe(
      Effect.flatMap((body) => {
        const totalPages = body._pagination.totalPages
        if (
          !Number.isSafeInteger(totalPages) ||
          !Number.isSafeInteger(body._pagination.page) ||
          body._pagination.page !== page ||
          totalPages < 0 ||
          totalPages > MAX_PAGES ||
          (expectedPages !== undefined && expectedPages !== totalPages) ||
          body.data.length > PAGE_SIZE ||
          (totalPages === 0 && (page !== 1 || body.data.length !== 0)) ||
          (totalPages > 0 && totalPages < page) ||
          (page < totalPages && body.data.length === 0)
        )
          return Effect.fail(
            providerResponseError('contabo', action, 'Contabo pagination metadata is invalid'),
          )
        const next = [...accumulated, ...body.data]
        if (next.length > maxItems)
          return Effect.fail(
            providerResponseError(
              'contabo',
              action,
              'Contabo discovery item count exceeds the limit',
            ),
          )
        return totalPages === 0 || page === totalPages
          ? Effect.succeed(next)
          : load(page + 1, totalPages, next)
      }),
    )
  }
  return load(1, undefined, [])
}

export const makeContaboProviderAccountValidator = (
  options: ProviderAccountValidatorOptions = {},
): ProviderAccountValidatorShape => {
  const deps = dependencies(options)
  return {
    validate: (input) =>
      Effect.gen(function* () {
        const credentials = yield* decodeContaboCredentials(input)
        const tokenUrl = yield* approvedEndpoint(
          'contabo',
          'authenticate',
          'tokenUrl',
          credentials.tokenUrl,
          isContaboTokenEndpoint,
        )
        const apiBaseUrl = yield* approvedEndpoint(
          'contabo',
          'authenticate',
          'apiBaseUrl',
          credentials.apiBaseUrl,
          isContaboApiEndpoint,
        )
        const auth = yield* requestJson(deps, 'contabo', 'authenticate', tokenUrl, 200, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'password',
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            username: credentials.apiUser,
            password: credentials.apiPassword,
          }),
        })
        const tokenBody = yield* Schema.decodeUnknownEffect(ContaboTokenResponse)(auth.body).pipe(
          Effect.mapError(() =>
            providerResponseError('contabo', 'authenticate', 'Contabo token response is invalid'),
          ),
        )
        if (
          !isSafeHttpCredential(tokenBody.access_token) ||
          !Number.isSafeInteger(tokenBody.expires_in) ||
          tokenBody.expires_in <= 0
        )
          return yield* providerResponseError(
            'contabo',
            'authenticate',
            'Contabo token response is invalid',
          )

        const computeProof = yield* contaboPage(
          deps,
          apiBaseUrl,
          tokenBody.access_token,
          'v1/compute/instances',
          'verifyComputeRead',
          1,
          1,
        )
        if (
          !Number.isSafeInteger(computeProof._pagination.page) ||
          computeProof._pagination.page !== 1 ||
          !Number.isSafeInteger(computeProof._pagination.totalPages) ||
          computeProof._pagination.totalPages < 0 ||
          computeProof.data.length > 1 ||
          (computeProof._pagination.totalPages === 0 && computeProof.data.length !== 0) ||
          (computeProof._pagination.totalPages > 0 && computeProof.data.length === 0)
        )
          return yield* providerResponseError(
            'contabo',
            'verifyComputeRead',
            'Contabo compute response pagination is invalid',
          )

        const dataCenters = yield* contaboPages(
          deps,
          apiBaseUrl,
          tokenBody.access_token,
          'v1/data-centers',
          'discoverRegions',
          MAX_REGIONS,
        )
        const regions = yield* Effect.forEach(dataCenters, (item) =>
          Schema.decodeUnknownEffect(ContaboDataCenter)(item).pipe(
            Effect.map((dataCenter) =>
              dataCenter.capabilities.includes('VPS') ? dataCenter.regionSlug : undefined,
            ),
            Effect.mapError(() =>
              providerResponseError('contabo', 'discoverRegions', 'Contabo data center is invalid'),
            ),
          ),
        )
        const computeRegions = regions.filter((region): region is string => region !== undefined)
        if (computeRegions.length === 0)
          return yield* providerResponseError(
            'contabo',
            'discoverRegions',
            'Contabo returned no compute-capable regions',
          )

        // Contabo's public account API exposes per-instance upgrade offers, but no account-wide
        // read-only product catalog with explicit billing currency.
        // Do not call undocumented endpoints or infer a currency from tenant/location metadata.
        return yield* finalSnapshot('contabo', computeRegions, [], [])
      }),
  }
}

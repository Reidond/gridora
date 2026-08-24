import { Effect, Layer } from 'effect'
import {
  ContaboCreateTransport,
  OvhCreateTransport,
  type AcceptedProviderCommercialTerms,
  type ContaboCreateTransportShape,
  type ContaboRuntimeCredentials,
  type OvhCreateTransportShape,
  type OvhRuntimeCredentials,
} from '@gridora/provider-runtime'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderBillingActionRequiredError,
  ProviderConflictError,
  ProviderCreateUncertainError,
  ProviderNotFoundError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTemporaryError,
  ProviderUnknownError,
  ProviderValidationError,
  managedMetadata,
  type CreateNodeInput,
  type ProviderError,
  type ProviderId,
  type ProviderNode,
} from '@gridora/provider-sdk'

const maxResponseBytes = 1024 * 1024
const maxRequestBytes = 1024 * 1024
const maxJsonDepth = 16
const maxJsonNodes = 5000
const maxAdoptionPages = 5
const pageSize = 100
const timeoutFor = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value)
    ? Math.min(60_000, Math.max(100, Math.trunc(value)))
    : 15_000

interface HttpFailure {
  readonly kind: 'http' | 'transport' | 'protocol'
  readonly status?: number
  readonly retryAfterSeconds?: number
}

export interface ProviderTransportOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMilliseconds?: number
  readonly now?: () => number
  readonly requestId?: () => string
}

const operation = 'nodeProvision.createOrAdopt'
const failure = (
  kind: HttpFailure['kind'],
  status?: number,
  retryAfterSeconds?: number,
): HttpFailure => ({
  kind,
  ...(status === undefined ? {} : { status }),
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
})
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined
const stringField = (value: unknown, key: string): string | undefined => {
  const result = field(value, key)
  return typeof result === 'string' ? result : undefined
}
const numberField = (value: unknown, key: string): number | undefined => {
  const result = field(value, key)
  return typeof result === 'number' && Number.isSafeInteger(result) ? result : undefined
}
const arrayField = (value: unknown, key: string): readonly unknown[] | undefined => {
  const result = field(value, key)
  return Array.isArray(result) ? result : undefined
}
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

const boundedJson = async (response: Response): Promise<unknown> => {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > maxResponseBytes) throw failure('protocol')
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maxResponseBytes) {
      await reader.cancel()
      throw failure('protocol')
    }
    chunks.push(next.value)
  }
  if (size === 0) return undefined
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw failure('protocol')
  }
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > maxJsonNodes || depth > maxJsonDepth) throw failure('protocol')
    if (Array.isArray(value)) {
      if (value.length > maxJsonNodes) throw failure('protocol')
      for (const item of value) visit(item, depth + 1)
    } else if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value)
      if (entries.length > maxJsonNodes) throw failure('protocol')
      for (const [, item] of entries) visit(item, depth + 1)
    }
  }
  visit(parsed, 0)
  return parsed
}

const safeUrl = (
  value: string,
  allow: (url: URL) => boolean,
): Effect.Effect<URL, ProviderValidationError> =>
  Effect.try({
    try: () => new URL(value),
    catch: () =>
      new ProviderValidationError({
        provider: 'unknown',
        operation,
        message: 'Provider endpoint is invalid',
      }),
  }).pipe(
    Effect.filterOrFail(
      allow,
      () =>
        new ProviderValidationError({
          provider: 'unknown',
          operation,
          message: 'Provider endpoint is not allow-listed',
        }),
    ),
  )

const exactHttps = (url: URL, hostname: string, pathname: string): boolean =>
  url.protocol === 'https:' &&
  url.hostname === hostname &&
  url.port === '' &&
  url.username === '' &&
  url.password === '' &&
  url.pathname.replace(/\/$/, '') === pathname.replace(/\/$/, '') &&
  url.search === '' &&
  url.hash === ''

const request = (
  fetchImplementation: typeof globalThis.fetch,
  timeoutMilliseconds: number,
  url: URL,
  init: RequestInit,
): Effect.Effect<{ readonly response: Response; readonly body: unknown }, HttpFailure> =>
  (() => {
    const requestBody = init.body
    const requestBytes =
      typeof requestBody === 'string'
        ? new TextEncoder().encode(requestBody).byteLength
        : requestBody instanceof URLSearchParams
          ? new TextEncoder().encode(requestBody.toString()).byteLength
          : 0
    if (requestBytes > maxRequestBytes) return Effect.fail(failure('protocol'))
    return Effect.tryPromise({
      try: async (effectSignal) => {
        const timeout = AbortSignal.timeout(timeoutMilliseconds)
        const response = await fetchImplementation(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([effectSignal, timeout]),
        })
        const body = await boundedJson(response)
        return { response, body }
      },
      catch: (cause) =>
        typeof cause === 'object' && cause !== null && 'kind' in cause
          ? (cause as HttpFailure)
          : failure('transport'),
    })
  })()

const normalizedError = (provider: ProviderId, failed: HttpFailure): ProviderError => {
  const values = { provider, operation, message: 'Provider request failed' }
  if (failed.status === 401) return new ProviderAuthenticationError(values)
  if (failed.status === 403) return new ProviderAuthorizationError(values)
  if (failed.status === 404) return new ProviderNotFoundError(values)
  if (failed.status === 409) return new ProviderConflictError(values)
  if (failed.status === 400 || failed.status === 413 || failed.status === 422)
    return new ProviderValidationError(values)
  if (failed.status === 402) return new ProviderBillingActionRequiredError(values)
  if (failed.status === 429)
    return new ProviderRateLimitError({
      ...values,
      ...(failed.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failed.retryAfterSeconds }),
    })
  if (failed.status === 507) return new ProviderQuotaError(values)
  if (failed.kind === 'transport' || (failed.status !== undefined && failed.status >= 500))
    return new ProviderTemporaryError(values)
  return new ProviderUnknownError(values)
}

const requireSuccess = (
  provider: ProviderId,
  result: { readonly response: Response; readonly body: unknown },
  allowedStatuses: readonly number[],
): Effect.Effect<unknown, ProviderError> =>
  allowedStatuses.includes(result.response.status)
    ? Effect.succeed(result.body)
    : Effect.fail(
        normalizedError(
          provider,
          failure(
            'http',
            result.response.status,
            Number(result.response.headers.get('retry-after')) || undefined,
          ),
        ),
      )

const metadata = (input: CreateNodeInput) => {
  const value = managedMetadata(input)
  return {
    'managed-by': value.managedBy,
    'organization-id': value.organizationId,
    'node-id': value.nodeId,
    'operation-id': value.operationId,
    'image-version': value.imageVersion,
  } as const
}

const owned = (node: ProviderNode, input: CreateNodeInput): boolean =>
  node.name === input.name &&
  node.regionId === input.regionId &&
  node.planId === input.planId &&
  node.metadata.managedBy === 'gridora' &&
  node.metadata.organizationId === input.organizationId &&
  node.metadata.nodeId === input.nodeId &&
  node.metadata.operationId === input.operationId &&
  node.metadata.imageVersion === input.imageVersion

const uniqueOwned = (
  provider: ProviderId,
  nodes: readonly ProviderNode[],
  input: CreateNodeInput,
): Effect.Effect<ProviderNode | null, ProviderError> => {
  const matches = nodes.filter((node) => owned(node, input))
  return matches.length === 0
    ? Effect.succeed(null)
    : matches.length === 1
      ? Effect.succeed(matches[0]!)
      : Effect.fail(
          new ProviderConflictError({
            provider,
            operation,
            message: 'Multiple provider instances match the immutable ownership metadata',
          }),
        )
}

const uncertain = (
  provider: ProviderId,
  input: CreateNodeInput,
  now: () => number,
): ProviderCreateUncertainError => {
  const observedAt = now()
  const attempt = input.adoptionAttempt ?? 0
  const deadline = input.adoptionDeadlineAtEpochMs ?? observedAt + 15 * 60 * 1000
  const delay = Math.min(5_000 * 2 ** Math.min(attempt, 6), 5 * 60 * 1000)
  const nextAttemptAtEpochMs =
    observedAt >= deadline ? deadline + 1 : Math.min(observedAt + delay, deadline)
  return new ProviderCreateUncertainError({
    provider,
    operation,
    message: 'Provider create outcome is uncertain; continue with adopt-only discovery',
    organizationId: input.organizationId,
    operationId: input.operationId,
    retryMode: 'adopt_only',
    stabilizationAttempts: attempt,
    nextAttemptNumber: attempt + 1,
    nextAttemptAtEpochMs,
    recoveryDeadlineAtEpochMs: deadline,
  })
}

const definitelyRejectedCreate = (status: number): boolean =>
  [400, 401, 402, 403, 404, 409, 413, 422, 429].includes(status)

const normalizeOvhState = (status: string): ProviderNode['state'] => {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'active'
    case 'SHUTOFF':
    case 'STOPPED':
      return 'stopped'
    case 'BUILD':
    case 'BUILDING':
      return 'creating'
    case 'REBUILD':
    case 'REBUILDING':
      return 'rebuilding'
    case 'DELETED':
      return 'retired'
    default:
      return 'unknown'
  }
}

const decodeOvhNode = (
  raw: unknown,
  regionId: string,
  expectedImageId?: string,
): Effect.Effect<ProviderNode, ProviderUnknownError> => {
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  const status = stringField(raw, 'status')
  const flavor = field(raw, 'flavor')
  const planId = stringField(flavor, 'id')
  const imageId = stringField(field(raw, 'image'), 'id')
  const rawMetadata = field(raw, 'metadata')
  const managedBy = stringField(rawMetadata, 'managed-by')
  const organizationId = stringField(rawMetadata, 'organization-id')
  const nodeId = stringField(rawMetadata, 'node-id')
  const operationId = stringField(rawMetadata, 'operation-id')
  const imageVersion = stringField(rawMetadata, 'image-version')
  if (
    id === undefined ||
    name === undefined ||
    status === undefined ||
    planId === undefined ||
    (expectedImageId !== undefined && imageId !== expectedImageId) ||
    managedBy !== 'gridora' ||
    organizationId === undefined ||
    nodeId === undefined ||
    operationId === undefined ||
    imageVersion === undefined
  )
    return Effect.fail(
      new ProviderUnknownError({
        provider: 'ovhcloud',
        operation,
        message: 'OVHcloud returned an invalid server representation',
      }),
    )
  const addresses: string[] = []
  const addressGroups = field(raw, 'addresses')
  if (typeof addressGroups === 'object' && addressGroups !== null)
    for (const items of Object.values(addressGroups))
      if (Array.isArray(items))
        for (const item of items) {
          const address = stringField(item, 'addr')
          if (address !== undefined && addresses.length < 64) addresses.push(address)
        }
  return Effect.succeed({
    id,
    name,
    state: normalizeOvhState(status),
    regionId,
    planId,
    addresses,
    metadata: { managedBy, organizationId, nodeId, operationId, imageVersion },
  })
}

interface OvhSession {
  readonly token: string
  readonly compute: URL
  readonly network: URL
}

const ovhEndpointAllowed = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.port === '' &&
  url.username === '' &&
  url.password === '' &&
  url.hostname.endsWith('.cloud.ovh.net') &&
  url.search === '' &&
  url.hash === ''

const authenticateOvh = (
  fetchImplementation: typeof globalThis.fetch,
  timeoutMilliseconds: number,
  credentials: OvhRuntimeCredentials,
): Effect.Effect<OvhSession, ProviderError> =>
  Effect.gen(function* () {
    const authBase = yield* safeUrl(credentials.authUrl, (url) =>
      exactHttps(url, 'auth.cloud.ovh.net', '/v3'),
    ).pipe(Effect.mapError(() => normalizedError('ovhcloud', failure('protocol'))))
    const authUrl = new URL('/v3/auth/tokens', authBase)
    const result = yield* request(fetchImplementation, timeoutMilliseconds, authUrl, {
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
    }).pipe(Effect.mapError((error) => normalizedError('ovhcloud', error)))
    const body = yield* requireSuccess('ovhcloud', result, [201])
    const token = result.response.headers.get('x-subject-token')
    const catalog = arrayField(field(body, 'token'), 'catalog')
    if (token === null || token.length < 16 || token.length > 16_384 || catalog === undefined)
      return yield* normalizedError('ovhcloud', failure('protocol'))
    const select = (serviceType: 'compute' | 'network') => {
      const candidates: URL[] = []
      for (const service of catalog) {
        if (stringField(service, 'type') !== serviceType) continue
        const endpoints = arrayField(service, 'endpoints') ?? []
        for (const endpoint of endpoints) {
          if (
            stringField(endpoint, 'interface') !== 'public' ||
            stringField(endpoint, 'region') !== credentials.region
          )
            continue
          const rawUrl = stringField(endpoint, 'url')
          if (rawUrl === undefined) continue
          try {
            const url = new URL(rawUrl)
            if (ovhEndpointAllowed(url)) candidates.push(url)
          } catch {
            // Ignore malformed catalog candidates and fail closed below.
          }
        }
      }
      return candidates
    }
    const compute = select('compute')
    const network = select('network')
    if (compute.length !== 1 || network.length !== 1)
      return yield* normalizedError('ovhcloud', failure('protocol'))
    if (!compute[0]!.pathname.includes(credentials.projectId))
      return yield* new ProviderAuthorizationError({
        provider: 'ovhcloud',
        operation,
        message: 'OVHcloud compute catalog does not match the accepted project',
      })
    return { token, compute: compute[0]!, network: network[0]! }
  })

const ovhApi = (
  fetchImplementation: typeof globalThis.fetch,
  timeoutMilliseconds: number,
  session: OvhSession,
  input: CreateNodeInput,
  now: () => number,
) => {
  const computeUrl = (path: string): URL => {
    const base = new URL(session.compute)
    const relative = new URL(path, 'https://provider-path.invalid')
    base.pathname = `${base.pathname.replace(/\/$/, '')}${relative.pathname}`
    base.search = relative.search
    return base
  }
  const call = (path: string, init: RequestInit) =>
    request(fetchImplementation, timeoutMilliseconds, computeUrl(path), {
      ...init,
      headers: {
        accept: 'application/json',
        'x-auth-token': session.token,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    })
  const list = Effect.gen(function* () {
    const nodes: ProviderNode[] = []
    let marker: string | undefined
    for (let page = 0; page < maxAdoptionPages; page += 1) {
      const suffix = `?limit=${pageSize}${marker === undefined ? '' : `&marker=${encodeURIComponent(marker)}`}`
      const result = yield* call(`/servers/detail${suffix}`, { method: 'GET' }).pipe(
        Effect.mapError((error) => normalizedError('ovhcloud', error)),
      )
      const body = yield* requireSuccess('ovhcloud', result, [200])
      const servers = arrayField(body, 'servers')
      const links = arrayField(body, 'servers_links')
      if (servers === undefined || links === undefined)
        return yield* normalizedError('ovhcloud', failure('protocol'))
      for (const server of servers) {
        const decoded = yield* Effect.result(decodeOvhNode(server, input.regionId, input.imageId))
        if (decoded._tag === 'Success') nodes.push(decoded.success)
      }
      const nextLinks = links.filter((link) => stringField(link, 'rel') === 'next')
      if (nextLinks.length === 0) return nodes
      if (nextLinks.length !== 1 || servers.length === 0)
        return yield* normalizedError('ovhcloud', failure('protocol'))
      const nextUrl = stringField(nextLinks[0], 'href')
      if (nextUrl === undefined) return yield* normalizedError('ovhcloud', failure('protocol'))
      try {
        const parsedNext = new URL(nextUrl)
        if (
          parsedNext.origin !== session.compute.origin ||
          !parsedNext.pathname.endsWith('/servers/detail')
        )
          return yield* normalizedError('ovhcloud', failure('protocol'))
      } catch {
        return yield* normalizedError('ovhcloud', failure('protocol'))
      }
      marker = stringField(servers.at(-1), 'id')
      if (marker === undefined) return yield* normalizedError('ovhcloud', failure('protocol'))
    }
    return yield* new ProviderConflictError({
      provider: 'ovhcloud',
      operation,
      message: 'OVHcloud adoption scan exceeded its bounded page limit',
    })
  })
  const create = Effect.gen(function* () {
    const result = yield* call('/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server: {
          name: input.name,
          flavorRef: input.planId,
          imageRef: input.imageId,
          ...(input.cloudInit === undefined
            ? {}
            : { user_data: bytesToBase64(new TextEncoder().encode(input.cloudInit)) }),
          metadata: metadata(input),
        },
      }),
    }).pipe(Effect.mapError(() => uncertain('ovhcloud', input, now)))
    if (result.response.status < 200 || result.response.status >= 300)
      return yield* definitelyRejectedCreate(result.response.status)
        ? normalizedError('ovhcloud', failure('http', result.response.status))
        : uncertain('ovhcloud', input, now)
    const id = stringField(field(result.body, 'server'), 'id')
    if (id === undefined || id.length > 256) return yield* uncertain('ovhcloud', input, now)
    const detail = yield* call(`/servers/${encodeURIComponent(id)}`, { method: 'GET' }).pipe(
      Effect.mapError(() => uncertain('ovhcloud', input, now)),
    )
    const detailBody = yield* requireSuccess('ovhcloud', detail, [200]).pipe(
      Effect.mapError(() => uncertain('ovhcloud', input, now)),
    )
    const node = yield* decodeOvhNode(
      field(detailBody, 'server'),
      input.regionId,
      input.imageId,
    ).pipe(Effect.mapError(() => uncertain('ovhcloud', input, now)))
    return yield* owned(node, input)
      ? Effect.succeed(node)
      : new ProviderAuthorizationError({
          provider: 'ovhcloud',
          operation,
          message: 'OVHcloud created server ownership does not match the reservation',
        })
  })
  return { list, create }
}

export const makeOvhCreateTransport = (
  options: ProviderTransportOptions = {},
): OvhCreateTransportShape => ({
  createOrAdopt: (credentials, input, commercialTerms) =>
    Effect.gen(function* () {
      if (
        commercialTerms.billingCadence !== 'hourly' ||
        commercialTerms.contractMonths !== 1 ||
        commercialTerms.nonHourlyCommitmentConfirmed
      )
        return yield* new ProviderValidationError({
          provider: 'ovhcloud',
          operation,
          message: 'Accepted OVHcloud commercial terms do not map to hourly Public Cloud',
        })
      const session = yield* authenticateOvh(
        options.fetch ?? globalThis.fetch,
        timeoutFor(options.timeoutMilliseconds),
        credentials,
      )
      // Neutron is selected and pinned during authentication even though creation delegates
      // interface attachment to Nova. This prevents later network work from catalog ambiguity.
      void session.network
      const api = ovhApi(
        options.fetch ?? globalThis.fetch,
        timeoutFor(options.timeoutMilliseconds),
        session,
        input,
        options.now ?? (() => Date.now()),
      )
      const adopted = yield* uniqueOwned('ovhcloud', yield* api.list, input)
      if (adopted !== null) return adopted
      if (input.createMode === 'adopt_only')
        return yield* uncertain('ovhcloud', input, options.now ?? (() => Date.now()))
      return yield* api.create
    }),
})

const normalizeContaboState = (status: string): ProviderNode['state'] => {
  switch (status.toLowerCase()) {
    case 'running':
    case 'active':
      return 'active'
    case 'stopped':
      return 'stopped'
    case 'provisioning':
    case 'creating':
      return 'creating'
    case 'reinstalling':
      return 'rebuilding'
    case 'cancelled':
    case 'deleted':
      return 'retired'
    default:
      return 'unknown'
  }
}

const contaboName = (input: CreateNodeInput): Effect.Effect<string, ProviderValidationError> => {
  const encoded = [
    'gridora',
    input.organizationId,
    input.nodeId,
    input.operationId,
    input.imageVersion,
    input.name,
  ]
    .map(encodeURIComponent)
    .join('|')
  return new TextEncoder().encode(encoded).byteLength <= 255
    ? Effect.succeed(encoded)
    : Effect.fail(
        new ProviderValidationError({
          provider: 'contabo',
          operation,
          field: 'name',
          message: 'Contabo ownership display name exceeds 255 bytes',
        }),
      )
}

const decodeContaboNode = (
  raw: unknown,
  expectedImageId?: string,
): Effect.Effect<ProviderNode, ProviderUnknownError> => {
  const idValue = field(raw, 'instanceId')
  const id =
    typeof idValue === 'number'
      ? String(idValue)
      : typeof idValue === 'string'
        ? idValue
        : undefined
  const displayName = stringField(raw, 'displayName')
  const status = stringField(raw, 'status') ?? 'unknown'
  const regionId = stringField(raw, 'region')
  const planId = stringField(raw, 'productId')
  const imageId = stringField(raw, 'imageId')
  let parts: string[] = []
  try {
    parts = (displayName ?? '').split('|').map(decodeURIComponent)
  } catch {
    parts = []
  }
  if (
    id === undefined ||
    regionId === undefined ||
    planId === undefined ||
    (expectedImageId !== undefined && imageId !== expectedImageId) ||
    parts.length !== 6 ||
    parts[0] !== 'gridora'
  )
    return Effect.fail(
      new ProviderUnknownError({
        provider: 'contabo',
        operation,
        message: 'Contabo returned an invalid instance representation',
      }),
    )
  const addresses: string[] = []
  const ipConfig = field(raw, 'ipConfig')
  for (const version of ['v4', 'v6']) {
    const address = stringField(field(ipConfig, version), 'ip')
    if (address !== undefined) addresses.push(address)
  }
  const contractEnd =
    stringField(raw, 'contractEndDate') ??
    stringField(raw, 'nextBillingDate') ??
    stringField(raw, 'cancelDate')
  return Effect.succeed({
    id,
    name: parts[5]!,
    state: normalizeContaboState(status),
    regionId,
    planId,
    addresses,
    metadata: {
      managedBy: 'gridora',
      organizationId: parts[1]!,
      nodeId: parts[2]!,
      operationId: parts[3]!,
      imageVersion: parts[4]!,
    },
    ...(contractEnd === undefined ? {} : { contract: { periodEndsAt: contractEnd } }),
  })
}

const contaboPeriod = (
  terms: AcceptedProviderCommercialTerms,
): Effect.Effect<1 | 12 | 24, ProviderValidationError> =>
  terms.billingCadence !== 'monthly' && terms.billingCadence !== 'contract'
    ? Effect.fail(
        new ProviderValidationError({
          provider: 'contabo',
          operation,
          message: 'Contabo does not support hourly instance terms',
        }),
      )
    : !terms.nonHourlyCommitmentConfirmed ||
        (terms.contractMonths !== 1 && terms.contractMonths !== 12 && terms.contractMonths !== 24)
      ? Effect.fail(
          new ProviderValidationError({
            provider: 'contabo',
            operation,
            message: 'Accepted Contabo contract period must be confirmed as 1, 12, or 24 months',
          }),
        )
      : Effect.succeed(terms.contractMonths)

interface ContaboSession {
  readonly token: string
  readonly apiBase: URL
}

const authenticateContabo = (
  fetchImplementation: typeof globalThis.fetch,
  timeoutMilliseconds: number,
  credentials: ContaboRuntimeCredentials,
): Effect.Effect<ContaboSession, ProviderError> =>
  Effect.gen(function* () {
    const tokenUrl = yield* safeUrl(credentials.tokenUrl, (url) =>
      exactHttps(url, 'auth.contabo.com', '/auth/realms/contabo/protocol/openid-connect/token'),
    ).pipe(Effect.mapError(() => normalizedError('contabo', failure('protocol'))))
    const apiBase = yield* safeUrl(credentials.apiBaseUrl, (url) =>
      exactHttps(url, 'api.contabo.com', '/'),
    ).pipe(Effect.mapError(() => normalizedError('contabo', failure('protocol'))))
    const result = yield* request(fetchImplementation, timeoutMilliseconds, tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        username: credentials.apiUser,
        password: credentials.apiPassword,
      }),
    }).pipe(Effect.mapError((error) => normalizedError('contabo', error)))
    const body = yield* requireSuccess('contabo', result, [200])
    const token = stringField(body, 'access_token')
    if (token === undefined || token.length < 16 || token.length > 16_384)
      return yield* normalizedError('contabo', failure('protocol'))
    return { token, apiBase }
  })

const contaboApi = (
  fetchImplementation: typeof globalThis.fetch,
  timeoutMilliseconds: number,
  session: ContaboSession,
  input: CreateNodeInput,
  requestId: () => string,
  now: () => number,
  period: 1 | 12 | 24,
) => {
  const nextRequestId = (): Effect.Effect<string, HttpFailure> =>
    Effect.try({ try: requestId, catch: () => failure('protocol') }).pipe(
      Effect.filterOrFail(
        (value) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
        () => failure('protocol'),
      ),
    )
  const call = (path: string, init: RequestInit) => {
    const url = new URL(path, session.apiBase)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.contabo.com' ||
      url.port !== '' ||
      !url.pathname.startsWith('/v1/compute/instances')
    )
      return Effect.fail(failure('protocol'))
    return Effect.flatMap(nextRequestId(), (id) =>
      request(fetchImplementation, timeoutMilliseconds, url, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${session.token}`,
          'x-request-id': id,
          'x-trace-id': input.operationId,
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    )
  }
  const list = Effect.gen(function* () {
    const nodes: ProviderNode[] = []
    for (let page = 1; page <= maxAdoptionPages; page += 1) {
      const result = yield* call(`/v1/compute/instances?page=${page}&size=${pageSize}`, {
        method: 'GET',
      }).pipe(Effect.mapError((error) => normalizedError('contabo', error)))
      const body = yield* requireSuccess('contabo', result, [200])
      const data = arrayField(body, 'data')
      if (data === undefined) return yield* normalizedError('contabo', failure('protocol'))
      for (const item of data) {
        const decoded = yield* Effect.result(decodeContaboNode(item, input.imageId))
        if (decoded._tag === 'Success') nodes.push(decoded.success)
      }
      const pagination = field(body, '_pagination')
      const totalPages = numberField(pagination, 'totalPages')
      if (totalPages === undefined || totalPages < page)
        return yield* normalizedError('contabo', failure('protocol'))
      if (totalPages > maxAdoptionPages)
        return yield* new ProviderConflictError({
          provider: 'contabo',
          operation,
          message: 'Contabo adoption scan exceeded its bounded page limit',
        })
      if (page >= totalPages) return nodes
    }
    return nodes
  })
  const create = Effect.gen(function* () {
    const displayName = yield* contaboName(input)
    const result = yield* call('/v1/compute/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        imageId: input.imageId,
        productId: input.planId,
        region: input.regionId,
        period,
        displayName,
        ...(input.cloudInit === undefined ? {} : { userData: input.cloudInit }),
      }),
    }).pipe(Effect.mapError(() => uncertain('contabo', input, now)))
    if (result.response.status !== 201)
      return yield* definitelyRejectedCreate(result.response.status)
        ? normalizedError('contabo', failure('http', result.response.status))
        : uncertain('contabo', input, now)
    const data = arrayField(result.body, 'data')
    if (data?.length !== 1) return yield* uncertain('contabo', input, now)
    const node = yield* decodeContaboNode(data[0], input.imageId).pipe(
      Effect.mapError(() => uncertain('contabo', input, now)),
    )
    return yield* owned(node, input)
      ? Effect.succeed(node)
      : new ProviderAuthorizationError({
          provider: 'contabo',
          operation,
          message: 'Contabo created instance ownership does not match the reservation',
        })
  })
  return { list, create }
}

export const makeContaboCreateTransport = (
  options: ProviderTransportOptions = {},
): ContaboCreateTransportShape => ({
  createOrAdopt: (credentials, input, commercialTerms) =>
    Effect.gen(function* () {
      const period = yield* contaboPeriod(commercialTerms)
      const session = yield* authenticateContabo(
        options.fetch ?? globalThis.fetch,
        timeoutFor(options.timeoutMilliseconds),
        credentials,
      )
      const api = contaboApi(
        options.fetch ?? globalThis.fetch,
        timeoutFor(options.timeoutMilliseconds),
        session,
        input,
        options.requestId ?? (() => crypto.randomUUID()),
        options.now ?? (() => Date.now()),
        period,
      )
      const adopted = yield* uniqueOwned('contabo', yield* api.list, input)
      if (adopted !== null) return adopted
      if (input.createMode === 'adopt_only')
        return yield* uncertain('contabo', input, options.now ?? (() => Date.now()))
      return yield* api.create
    }),
})

export const OvhCreateTransportLive = (options: ProviderTransportOptions = {}) =>
  Layer.succeed(OvhCreateTransport, makeOvhCreateTransport(options))

export const ContaboCreateTransportLive = (options: ProviderTransportOptions = {}) =>
  Layer.succeed(ContaboCreateTransport, makeContaboCreateTransport(options))

export const ProviderCreateTransportsLive = (options: ProviderTransportOptions = {}) =>
  Layer.merge(OvhCreateTransportLive(options), ContaboCreateTransportLive(options))

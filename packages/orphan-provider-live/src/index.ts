import { Effect } from 'effect'
import { type ContaboCredentials, type OvhPublicCloudCredentials } from '@gridora/contracts'
import type {
  OrphanDiscoveryAccount,
  OrphanProviderDiscoveryDependencies,
  ReadOnlyListNodes,
} from '@gridora/orphan-provider-discovery'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderRateLimitError,
  ProviderTemporaryError,
  ProviderUnknownError,
  ProviderValidationError,
  type ProviderError,
  type ProviderNode,
} from '@gridora/provider-sdk'

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_NODES = 200
const MAX_ADDRESSES = 64
const MAX_ADDRESS_LENGTH = 256
const PROVIDER_OPERATION = 'orphan-reconciliation.list-nodes'

export interface OrphanLiveProviderOptions {
  readonly fetch?: typeof globalThis.fetch
}

interface ProviderResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: unknown
}

class BoundedProviderResponseError extends Error {
  constructor() {
    super('provider response rejected')
    this.name = 'BoundedProviderResponseError'
  }
}

const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const field = (value: unknown, name: string): unknown => object(value)?.[name]
const array = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined
const identifier = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) && value.length <= 128

const failure = (
  provider: 'ovhcloud' | 'contabo',
  kind: 'authentication' | 'authorization' | 'rate-limit' | 'temporary' | 'validation' | 'unknown',
  retryAfterSeconds?: number,
): ProviderError => {
  const values = { provider, operation: PROVIDER_OPERATION, message: 'provider discovery failed' }
  switch (kind) {
    case 'authentication':
      return new ProviderAuthenticationError(values)
    case 'authorization':
      return new ProviderAuthorizationError(values)
    case 'rate-limit':
      return new ProviderRateLimitError({
        ...values,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      })
    case 'temporary':
      return new ProviderTemporaryError(values)
    case 'validation':
      return new ProviderValidationError(values)
    case 'unknown':
      return new ProviderUnknownError(values)
  }
}

const statusFailure = (
  provider: 'ovhcloud' | 'contabo',
  status: number,
  retryAfter: string | null,
): ProviderError => {
  if (status === 401) return failure(provider, 'authentication')
  if (status === 403) return failure(provider, 'authorization')
  if (status === 429) {
    const parsed = Number(retryAfter)
    return failure(
      provider,
      'rate-limit',
      Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    )
  }
  if (status >= 500) return failure(provider, 'temporary')
  return failure(provider, 'validation')
}

const boundedJson = async (response: Response): Promise<unknown> => {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
    throw new BoundedProviderResponseError()
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new BoundedProviderResponseError()
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new BoundedProviderResponseError()
  }
}

const request = (
  fetchImplementation: typeof globalThis.fetch,
  provider: 'ovhcloud' | 'contabo',
  url: URL,
  init: RequestInit,
): Effect.Effect<ProviderResponse, ProviderError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImplementation(url, { ...init, redirect: 'error', signal })
      return {
        status: response.status,
        headers: response.headers,
        body: await boundedJson(response),
      }
    },
    catch: (cause) =>
      cause instanceof BoundedProviderResponseError
        ? failure(provider, 'validation')
        : failure(provider, 'temporary'),
  })

const successful = (
  provider: 'ovhcloud' | 'contabo',
  response: ProviderResponse,
): Effect.Effect<ProviderResponse, ProviderError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(statusFailure(provider, response.status, response.headers.get('retry-after')))

const fixedHttps = (value: string, allow: (url: URL) => boolean): URL | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      allow(url)
      ? url
      : undefined
  } catch {
    return undefined
  }
}

const appendPath = (base: URL, path: string, query?: string): URL => {
  const url = new URL(base.toString())
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  url.search = query ?? ''
  url.hash = ''
  return url
}

const validAccount = (
  account: OrphanDiscoveryAccount,
  organizationId: string,
  providerType: 'ovhcloud' | 'contabo',
): boolean =>
  account.providerType === providerType &&
  account.organizationId === organizationId &&
  account.status === 'active' &&
  (account.scope === 'platform' || account.accountOrganizationId === organizationId)

const mapOvhNode = (raw: unknown): Effect.Effect<ProviderNode | undefined, ProviderError> => {
  const metadata = object(field(raw, 'metadata'))
  if (metadata?.['managed-by'] !== 'gridora') return Effect.succeed(undefined)
  const id = string(field(raw, 'id'))
  const name = string(field(raw, 'name'))
  const organizationId = string(metadata['organization-id'])
  const nodeId = string(metadata['node-id'])
  const operationId = string(metadata['operation-id'])
  const imageVersion = string(metadata['image-version'])
  const regionId = string(metadata['gridora-region'])
  const planId = string(field(field(raw, 'flavor'), 'id'))
  if (
    id === undefined ||
    name === undefined ||
    organizationId === undefined ||
    nodeId === undefined ||
    operationId === undefined ||
    imageVersion === undefined ||
    regionId === undefined ||
    planId === undefined ||
    !identifier(id) ||
    !identifier(organizationId) ||
    !identifier(nodeId) ||
    !identifier(operationId) ||
    !identifier(regionId) ||
    !identifier(planId) ||
    name.length === 0 ||
    name.length > 256 ||
    imageVersion.length === 0 ||
    imageVersion.length > 128
  )
    return Effect.fail(failure('ovhcloud', 'validation'))
  const addresses: string[] = []
  const groups = object(field(raw, 'addresses'))
  if (groups !== undefined) {
    for (const entries of Object.values(groups)) {
      const values = array(entries)
      if (values === undefined) continue
      for (const entry of values) {
        const address = string(field(entry, 'addr'))
        if (address !== undefined) {
          if (
            address.length === 0 ||
            address.length > MAX_ADDRESS_LENGTH ||
            addresses.length >= MAX_ADDRESSES
          )
            return Effect.fail(failure('ovhcloud', 'validation'))
          addresses.push(address)
        }
      }
    }
  }
  const status = string(field(raw, 'status'))?.toLowerCase()
  const state: ProviderNode['state'] =
    status === 'active'
      ? 'active'
      : status === 'shutoff' || status === 'stopped'
        ? 'stopped'
        : status === 'build' || status === 'building'
          ? 'creating'
          : status === 'rebuild' || status === 'rebuilding'
            ? 'rebuilding'
            : 'unknown'
  return Effect.succeed({
    id,
    name,
    state,
    regionId,
    planId,
    addresses,
    metadata: { managedBy: 'gridora', organizationId, nodeId, operationId, imageVersion },
  })
}

const ovhList =
  (
    fetchImplementation: typeof globalThis.fetch,
    credentials: typeof OvhPublicCloudCredentials.Type,
    account: OrphanDiscoveryAccount,
  ): ReadOnlyListNodes =>
  (input) =>
    Effect.gen(function* () {
      if (!validAccount(account, input.organizationId, 'ovhcloud'))
        return yield* Effect.fail(failure('ovhcloud', 'authorization'))
      const authUrl = fixedHttps(
        credentials.authUrl,
        (url) =>
          (url.hostname === 'auth.cloud.ovh.net' || url.hostname === 'auth.cloud.ovh.us') &&
          /^\/v3(?:\.0)?\/?$/.test(url.pathname),
      )
      if (authUrl === undefined) return yield* Effect.fail(failure('ovhcloud', 'validation'))
      const token = yield* request(
        fetchImplementation,
        'ovhcloud',
        appendPath(authUrl, 'auth/tokens'),
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
              scope: { project: { id: credentials.projectId } },
            },
          }),
        },
      ).pipe(Effect.flatMap((response) => successful('ovhcloud', response)))
      const subjectToken = token.headers.get('x-subject-token')
      const catalog = array(field(field(token.body, 'token'), 'catalog'))
      const endpointValue = catalog
        ?.filter((item) => string(field(item, 'type')) === 'compute')
        .flatMap((service) => array(field(service, 'endpoints')) ?? [])
        .find(
          (endpoint) =>
            string(field(endpoint, 'region')) === credentials.region &&
            (string(field(endpoint, 'interface')) === 'public' ||
              field(endpoint, 'interface') === undefined),
        )
      const endpoint = string(field(endpointValue, 'url'))
      const computeUrl =
        endpoint === undefined
          ? undefined
          : fixedHttps(
              endpoint,
              (url) =>
                /(^|\.)cloud\.ovh\.(net|us)$/.test(url.hostname) &&
                url.pathname.includes(`/${encodeURIComponent(credentials.projectId)}`),
            )
      if (subjectToken === null || subjectToken.length === 0 || computeUrl === undefined)
        return yield* Effect.fail(failure('ovhcloud', 'validation'))
      const listed = yield* request(
        fetchImplementation,
        'ovhcloud',
        appendPath(computeUrl, 'servers/detail', 'limit=200'),
        { method: 'GET', headers: { accept: 'application/json', 'x-auth-token': subjectToken } },
      ).pipe(Effect.flatMap((response) => successful('ovhcloud', response)))
      const servers = array(field(listed.body, 'servers'))
      const links = array(field(listed.body, 'servers_links'))
      if (
        servers === undefined ||
        servers.length >= MAX_NODES ||
        (links !== undefined && links.length > 0)
      )
        return yield* Effect.fail(failure('ovhcloud', 'validation'))
      const decoded = yield* Effect.forEach(servers, mapOvhNode)
      return decoded.filter((node): node is ProviderNode => node !== undefined)
    })

const mapContaboNode = (raw: unknown): Effect.Effect<ProviderNode | undefined, ProviderError> => {
  const encoded = string(field(raw, 'displayName'))
  if (encoded === undefined || !encoded.startsWith('gridora|')) return Effect.succeed(undefined)
  let parts: string[]
  try {
    parts = encoded.split('|').map((part) => decodeURIComponent(part))
  } catch {
    return Effect.fail(failure('contabo', 'validation'))
  }
  const [managedBy, organizationId, nodeId, operationId, imageVersion, name] = parts
  const id = string(field(raw, 'instanceId'))
  const regionId = string(field(raw, 'region'))
  const planId = string(field(raw, 'productId'))
  if (
    managedBy !== 'gridora' ||
    parts.length !== 6 ||
    id === undefined ||
    regionId === undefined ||
    planId === undefined ||
    organizationId === undefined ||
    nodeId === undefined ||
    operationId === undefined ||
    imageVersion === undefined ||
    name === undefined ||
    !identifier(id) ||
    !identifier(regionId) ||
    !identifier(planId) ||
    !identifier(organizationId) ||
    !identifier(nodeId) ||
    !identifier(operationId) ||
    imageVersion.length === 0 ||
    imageVersion.length > 128 ||
    name.length === 0 ||
    name.length > 256
  )
    return Effect.fail(failure('contabo', 'validation'))
  const addresses: string[] = []
  for (const version of ['v4', 'v6']) {
    const value = string(field(field(field(raw, 'ipConfig'), version), 'ip'))
    if (value !== undefined) {
      if (
        value.length === 0 ||
        value.length > MAX_ADDRESS_LENGTH ||
        addresses.length >= MAX_ADDRESSES
      )
        return Effect.fail(failure('contabo', 'validation'))
      addresses.push(value)
    }
  }
  const status = string(field(raw, 'status'))?.toLowerCase()
  const state: ProviderNode['state'] =
    status === 'running'
      ? 'active'
      : status === 'stopped'
        ? 'stopped'
        : status === 'provisioning'
          ? 'creating'
          : 'unknown'
  return Effect.succeed({
    id,
    name,
    state,
    regionId,
    planId,
    addresses,
    metadata: { managedBy: 'gridora', organizationId, nodeId, operationId, imageVersion },
  })
}

const contaboList =
  (
    fetchImplementation: typeof globalThis.fetch,
    credentials: typeof ContaboCredentials.Type,
    account: OrphanDiscoveryAccount,
  ): ReadOnlyListNodes =>
  (input) =>
    Effect.gen(function* () {
      if (!validAccount(account, input.organizationId, 'contabo'))
        return yield* Effect.fail(failure('contabo', 'authorization'))
      const tokenUrl = fixedHttps(
        credentials.tokenUrl,
        (url) =>
          url.hostname === 'auth.contabo.com' &&
          url.pathname === '/auth/realms/contabo/protocol/openid-connect/token',
      )
      const apiBaseUrl = fixedHttps(
        credentials.apiBaseUrl,
        (url) => url.hostname === 'api.contabo.com' && /^\/?$/.test(url.pathname),
      )
      if (tokenUrl === undefined || apiBaseUrl === undefined)
        return yield* Effect.fail(failure('contabo', 'validation'))
      const tokenResponse = yield* request(fetchImplementation, 'contabo', tokenUrl, {
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
      }).pipe(Effect.flatMap((response) => successful('contabo', response)))
      const accessToken = string(field(tokenResponse.body, 'access_token'))
      const expiresIn = field(tokenResponse.body, 'expires_in')
      if (
        accessToken === undefined ||
        accessToken.length === 0 ||
        typeof expiresIn !== 'number' ||
        expiresIn <= 0
      )
        return yield* Effect.fail(failure('contabo', 'validation'))
      const listed = yield* request(
        fetchImplementation,
        'contabo',
        appendPath(apiBaseUrl, 'v1/compute/instances', 'page=1&size=200'),
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        },
      ).pipe(Effect.flatMap((response) => successful('contabo', response)))
      const instances = array(field(listed.body, 'data'))
      const pages = field(field(listed.body, '_pagination'), 'totalPages')
      if (instances === undefined || instances.length >= MAX_NODES || pages !== 1)
        return yield* Effect.fail(failure('contabo', 'validation'))
      const decoded = yield* Effect.forEach(instances, mapContaboNode)
      return decoded.filter((node): node is ProviderNode => node !== undefined)
    })

/**
 * The factories expose only `listNodes`. They use a fixed authentication POST
 * and fixed bounded list endpoint; no provider resource mutation is reachable.
 */
export const makeLiveOrphanProviderFactories = (
  options: OrphanLiveProviderOptions = {},
): Pick<OrphanProviderDiscoveryDependencies, 'ovhcloud' | 'contabo'> => {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  return {
    ovhcloud: (credentials, account) =>
      Effect.succeed(ovhList(fetchImplementation, credentials, account)),
    contabo: (credentials, account) =>
      Effect.succeed(contaboList(fetchImplementation, credentials, account)),
  }
}

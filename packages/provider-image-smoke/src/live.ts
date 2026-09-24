import { Effect } from 'effect'
import {
  makeContaboHttpApi,
  makeContaboOAuthHttpClient,
  type ContaboApiError,
} from '@gridora/provider-contabo'
import { makeOvhOpenStackHttpApi } from '@gridora/provider-ovh-public-cloud'
import {
  ProviderTransportError,
  type JsonHttpClientShape,
  type ProviderId,
} from '@gridora/provider-sdk'
import { makeContaboImageSmokeDriver, makeOvhImageSmokeDriver } from './drivers.js'
import {
  AgentHealthObservationError,
  ProviderImageSmokeError,
  type AgentHealthObserverShape,
  type ProviderImageSmokeDriverShape,
} from './index.js'

/** Secret names the `image-signing` environment must provide. Values are never printed. */
export const SMOKE_CREDENTIAL_ENVIRONMENT = {
  ovhcloud: [
    'GRIDORA_SMOKE_OVH_PROJECT_ID',
    'GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_ID',
    'GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_SECRET',
  ],
  contabo: [
    'GRIDORA_SMOKE_CONTABO_CLIENT_ID',
    'GRIDORA_SMOKE_CONTABO_CLIENT_SECRET',
    'GRIDORA_SMOKE_CONTABO_API_USER',
    'GRIDORA_SMOKE_CONTABO_API_PASSWORD',
  ],
} as const satisfies Record<ProviderId, readonly string[]>

const OVH_AUTH_URL = 'https://auth.cloud.ovh.net/v3/auth/tokens'
const CONTABO_TOKEN_URL =
  'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token'
const CONTABO_API_BASE_URL = 'https://api.contabo.com'
const MAX_RESPONSE_BYTES = 1024 * 1024

export type SmokeEnvironment = Readonly<Record<string, string | undefined>>

export type SmokeCredentials =
  | {
      readonly provider: 'ovhcloud'
      readonly projectId: string
      readonly applicationCredentialId: string
      readonly applicationCredentialSecret: string
    }
  | {
      readonly provider: 'contabo'
      readonly clientId: string
      readonly clientSecret: string
      readonly apiUser: string
      readonly apiPassword: string
    }

const credentialFailure = (code: string, message: string) =>
  new ProviderImageSmokeError({ stage: 'credentials', code, message })

/** Reads only the fixed secret names for the selected provider. A missing value fails before any request. */
export const resolveSmokeCredentials = (
  provider: ProviderId,
  environment: SmokeEnvironment,
): Effect.Effect<SmokeCredentials, ProviderImageSmokeError> => {
  const names = SMOKE_CREDENTIAL_ENVIRONMENT[provider]
  const missing = names.filter((name) => (environment[name] ?? '').trim().length === 0)
  if (missing.length > 0)
    return Effect.fail(
      credentialFailure(
        'credential-absent',
        `Provider credential is absent: ${missing.join(', ')}`,
      ),
    )
  const value = (name: string) => environment[name]!.trim()
  return Effect.succeed(
    provider === 'ovhcloud'
      ? {
          provider,
          projectId: value('GRIDORA_SMOKE_OVH_PROJECT_ID'),
          applicationCredentialId: value('GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_ID'),
          applicationCredentialSecret: value('GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_SECRET'),
        }
      : {
          provider,
          clientId: value('GRIDORA_SMOKE_CONTABO_CLIENT_ID'),
          clientSecret: value('GRIDORA_SMOKE_CONTABO_CLIENT_SECRET'),
          apiUser: value('GRIDORA_SMOKE_CONTABO_API_USER'),
          apiPassword: value('GRIDORA_SMOKE_CONTABO_API_PASSWORD'),
        },
  )
}

/** Every value that must never appear in a printed report. */
export const smokeSecretValues = (credentials: SmokeCredentials): readonly string[] =>
  credentials.provider === 'ovhcloud'
    ? [credentials.applicationCredentialId, credentials.applicationCredentialSecret]
    : [credentials.clientId, credentials.clientSecret, credentials.apiUser, credentials.apiPassword]

export interface LiveSmokeOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMilliseconds?: number
}

const boundedBody = async (response: Response): Promise<unknown> => {
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
      throw new Error('provider response exceeded the size limit')
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
    return undefined
  }
}

/**
 * Bounded JSON client rooted at one catalog endpoint. It refuses redirects,
 * applies a fixed timeout, and never includes a response body in an error.
 */
const rootedJsonClient = (
  fetchImplementation: typeof globalThis.fetch,
  base: URL,
  token: string,
  timeoutMilliseconds: number,
): JsonHttpClientShape => ({
  request: (request) =>
    Effect.tryPromise({
      try: async (signal) => {
        const relative = new URL(request.path, 'https://provider-path.invalid')
        const url = new URL(base)
        url.pathname = `${base.pathname.replace(/\/$/, '')}${relative.pathname}`
        url.search = relative.search
        const response = await fetchImplementation(url, {
          method: request.method,
          headers: {
            accept: 'application/json',
            'x-auth-token': token,
            ...request.headers,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]),
        })
        return {
          status: response.status,
          body: await boundedBody(response),
          headers: Object.fromEntries(response.headers.entries()),
        }
      },
      catch: () =>
        new ProviderTransportError({ message: 'provider transport failed', retryable: true }),
    }),
})

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined

const ovhEndpointAllowed = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.port === '' &&
  url.username === '' &&
  url.password === '' &&
  url.hostname.endsWith('.cloud.ovh.net') &&
  url.search === '' &&
  url.hash === ''

/** Authenticates one Keystone application credential and selects exact regional endpoints. */
const authenticateOvh = (
  fetchImplementation: typeof globalThis.fetch,
  credentials: Extract<SmokeCredentials, { provider: 'ovhcloud' }>,
  region: string,
  timeoutMilliseconds: number,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchImplementation(OVH_AUTH_URL, {
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
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]),
        })
        return {
          status: response.status,
          token: response.headers.get('x-subject-token'),
          body: await boundedBody(response),
        }
      },
      catch: () => credentialFailure('provider-authentication-failed', 'OVHcloud sign-in failed'),
    })
    const catalog = field(field(result.body, 'token'), 'catalog')
    if (
      result.status !== 201 ||
      result.token === null ||
      result.token.length < 16 ||
      !Array.isArray(catalog)
    )
      return yield* credentialFailure(
        'provider-authentication-failed',
        `OVHcloud sign-in returned HTTP ${result.status}`,
      )
    const select = (serviceType: 'compute' | 'network' | 'image') => {
      const candidates: URL[] = []
      for (const service of catalog) {
        if (field(service, 'type') !== serviceType) continue
        const endpoints = field(service, 'endpoints')
        if (!Array.isArray(endpoints)) continue
        for (const endpoint of endpoints) {
          const raw = field(endpoint, 'url')
          if (
            field(endpoint, 'interface') !== 'public' ||
            field(endpoint, 'region') !== region ||
            typeof raw !== 'string'
          )
            continue
          try {
            const url = new URL(raw)
            if (ovhEndpointAllowed(url)) candidates.push(url)
          } catch {
            // Malformed catalog entries are ignored and the exact-one check fails closed.
          }
        }
      }
      return candidates
    }
    const compute = select('compute')
    const network = select('network')
    const image = select('image')
    if (compute.length !== 1 || network.length !== 1 || image.length !== 1)
      return yield* credentialFailure(
        'provider-catalog-invalid',
        'OVHcloud catalog does not expose exactly one regional endpoint per service',
      )
    if (!compute[0]!.pathname.includes(credentials.projectId))
      return yield* credentialFailure(
        'provider-project-mismatch',
        'OVHcloud compute endpoint does not match the configured project',
      )
    return { token: result.token, compute: compute[0]!, network: network[0]!, image: image[0]! }
  })

const refuse = (message: string) => (): never => {
  throw new Error(message)
}

/**
 * Composes the live driver from existing provider adapters. Only the smoke
 * CLI calls it, after the live-test gate and credential checks pass.
 */
export const makeLiveSmokeDriver = (
  credentials: SmokeCredentials,
  region: string,
  options: LiveSmokeOptions = {},
): Effect.Effect<ProviderImageSmokeDriverShape, ProviderImageSmokeError> => {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000
  if (credentials.provider === 'ovhcloud')
    return Effect.map(
      authenticateOvh(fetchImplementation, credentials, region, timeoutMilliseconds),
      (session) => {
        const client = (base: URL) =>
          rootedJsonClient(fetchImplementation, base, session.token, timeoutMilliseconds)
        const api = makeOvhOpenStackHttpApi(client(session.compute), {
          regions: [{ id: region, name: region }],
          regionId: region,
          networkHttp: client(session.network),
          imageHttp: client(session.image),
          securityGroupIdForServer: refuse('smoke never changes security groups'),
          securityGroupOwnershipDescription: refuse('smoke never changes security groups'),
        })
        return makeOvhImageSmokeDriver(api, region)
      },
    )
  return Effect.map(
    makeContaboOAuthHttpClient({
      tokenUrl: CONTABO_TOKEN_URL,
      apiBaseUrl: CONTABO_API_BASE_URL,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      apiUser: credentials.apiUser,
      apiPassword: credentials.apiPassword,
    }),
    (http) => {
      const today = () => new Date().toISOString().slice(0, 10)
      const api = makeContaboHttpApi(http, {
        contractPeriodMonths: 1,
        requestId: () => globalThis.crypto.randomUUID(),
        cancellation: () => ({ cancellationDate: today(), billingStopsAt: today() }),
        secureWipeAndStop: () =>
          Effect.fail<ContaboApiError>({ message: 'smoke never secure-wipes a node' }),
        firewallIdForInstance: refuse('smoke never changes firewalls'),
        firewallOwnershipDescription: refuse('smoke never changes firewalls'),
      })
      return makeContaboImageSmokeDriver(api, region)
    },
  )
}

/**
 * The smoke node receives no registration token, so no control-plane agent
 * readiness source exists for it yet. This observer fails closed instead of
 * inferring agent health from provider state.
 */
export const unavailableAgentHealthObserver: AgentHealthObserverShape = {
  latest: () =>
    Effect.fail(new AgentHealthObservationError({ code: 'agent-health-source-unavailable' })),
}

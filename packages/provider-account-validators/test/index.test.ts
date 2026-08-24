import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderAccountValidationInput } from '@gridora/provider-account-control'
import {
  makeContaboProviderAccountValidator,
  makeOvhProviderAccountValidator,
} from '../src/index.js'

const credentialCanary = 'credential-canary-do-not-leak'
const tokenCanary = 'provider-token-do-not-leak'
const encoder = new TextEncoder()

const ovhCredentials = {
  authUrl: 'https://auth.cloud.ovh.net/v3',
  region: 'GRA11',
  projectId: 'project-a',
  applicationCredentialId: 'application-credential-a',
  applicationCredentialSecret: credentialCanary,
}

const contaboCredentials = {
  tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  apiBaseUrl: 'https://api.contabo.com',
  clientId: 'client-a',
  clientSecret: credentialCanary,
  apiUser: 'api-user@example.test',
  apiPassword: 'api-password-a',
}

const validationInput = (credentials: unknown): ProviderAccountValidationInput => ({
  credentialBytes: encoder.encode(JSON.stringify(credentials)),
  organizationId: 'org-a',
  accountId: 'provider-account-a',
  refresh: false,
})

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(headers)
  if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

const urlOf = (input: RequestInfo | URL): URL =>
  new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)

const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (result._tag === 'Success') throw new Error('Expected the Effect to fail')
  return result.failure
}

const identityResponse = (
  endpoints: readonly {
    readonly region: string
    readonly url: string
  }[] = [
    {
      region: 'GRA11',
      url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-a',
    },
    {
      region: 'BHS5',
      url: 'https://compute.bhs5.cloud.ovh.net/v2.1/project-a',
    },
  ],
) => ({
  token: {
    project: { id: 'project-a', name: 'ignored-extra-field' },
    catalog: [
      {
        type: 'compute',
        name: 'nova',
        endpoints: endpoints.map((endpoint) => ({
          interface: 'public',
          region_id: endpoint.region,
          url: endpoint.url,
          id: `endpoint-${endpoint.region}`,
        })),
      },
    ],
  },
})

const fixedRequestId = () => '00000000-0000-4000-8000-000000000001'

describe('OVHcloud provider-account validator', () => {
  it('authenticates, normalizes regions, and follows Nova markers until an empty page', async () => {
    const requests: Array<{ readonly url: URL; readonly init?: RequestInit }> = []
    const duplicateEndpoint = {
      region: 'GRA11',
      url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-a',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      requests.push({ url, ...(init === undefined ? {} : { init }) })
      if (url.hostname === 'auth.cloud.ovh.net')
        return jsonResponse(
          identityResponse([
            duplicateEndpoint,
            duplicateEndpoint,
            {
              region: 'BHS5',
              url: 'https://compute.bhs5.cloud.ovh.net/v2.1/project-a',
            },
          ]),
          201,
          { 'x-subject-token': tokenCanary },
        )
      return url.searchParams.has('marker')
        ? jsonResponse({ flavors: [] })
        : jsonResponse({
            flavors: [{ id: 'b2-15', vcpus: 4, ram: 15_360, disk: 100, name: 'B2-15' }],
          })
    })

    const snapshot = await Effect.runPromise(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(snapshot).toMatchObject({
      regions: ['BHS5', 'GRA11'],
      projects: ['project-a'],
      catalog: [],
    })
    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      '/v3/auth/tokens',
      '/v2.1/project-a/flavors/detail?limit=100',
      '/v2.1/project-a/flavors/detail?limit=100&marker=b2-15',
    ])
    const authRequestBody = requests[0]!.init?.body
    if (typeof authRequestBody !== 'string') throw new Error('Expected a JSON request body')
    const authBody = JSON.parse(authRequestBody) as {
      auth: { identity: { application_credential: { secret: string } } }
    }
    expect(authBody.auth.identity.application_credential.secret).toBe(credentialCanary)
    expect(new Headers(requests[1]!.init?.headers).get('x-auth-token')).toBe(tokenCanary)
    expect(JSON.stringify(requests.slice(1))).not.toContain(credentialCanary)
  })

  it('rejects excess credential properties before making a request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput({ ...ovhCredentials, extra: credentialCanary }),
      ),
    )

    expect(error._tag).toBe('ProviderValidationError')
    expect(error).toMatchObject({ field: 'credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain(credentialCanary)
  })

  it('pins the configured identity origin before sending application credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput({
          ...ovhCredentials,
          authUrl: 'https://auth.cloud.ovh.net.attacker.example/v3',
        }),
      ),
    )

    expect(error._tag).toBe('ProviderValidationError')
    expect(error).toMatchObject({ field: 'authUrl' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain('attacker.example')
  })

  it('rejects a non-OVH compute endpoint from the service catalog', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      urlOf(input).hostname === 'auth.cloud.ovh.net'
        ? jsonResponse(
            identityResponse([
              { region: 'GRA11', url: 'https://compute.attacker.example/v2.1/project-a' },
            ]),
            201,
            { 'x-subject-token': tokenCanary },
          )
        : jsonResponse({ flavors: [] }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.ovhcloud.discoverCatalog' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(error)).not.toContain('attacker.example')
  })

  it('fails closed on distinct public compute endpoints for the selected region', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        identityResponse([
          {
            region: 'GRA11',
            url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-a',
          },
          {
            region: 'GRA11',
            url: 'https://nova.gra11.cloud.ovh.net/v2.1/project-a',
          },
        ]),
        201,
        { 'x-subject-token': tokenCanary },
      ),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.ovhcloud.discoverCatalog' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate flavor IDs instead of accepting a pagination cycle', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      urlOf(input).hostname === 'auth.cloud.ovh.net'
        ? jsonResponse(identityResponse(), 201, { 'x-subject-token': tokenCanary })
        : jsonResponse({
            flavors: [
              { id: 'duplicate', vcpus: 2, ram: 4096, disk: 40 },
              { id: 'duplicate', vcpus: 2, ram: 4096, disk: 40 },
            ],
          }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.ovhcloud.discoverFlavors' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    [400, 'ProviderValidationError'],
    [401, 'ProviderAuthenticationError'],
    [402, 'ProviderBillingActionRequiredError'],
    [403, 'ProviderAuthorizationError'],
    [404, 'ProviderNotFoundError'],
    [408, 'ProviderTemporaryError'],
    [409, 'ProviderConflictError'],
    [418, 'ProviderUnknownError'],
    [422, 'ProviderValidationError'],
    [425, 'ProviderTemporaryError'],
    [429, 'ProviderRateLimitError'],
    [503, 'ProviderTemporaryError'],
  ] as const)('maps HTTP %i to %s without reading or leaking its body', async (status, tag) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ credential: credentialCanary }, status, { 'retry-after': '7' }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe(tag)
    if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 7 })
    expect(JSON.stringify(error)).not.toContain(credentialCanary)
  })

  it('caps the actual streamed response body even without Content-Length', async () => {
    const oversizedJson = `{"value":"${'x'.repeat(1024 * 1024)}"}`
    const fetchMock = vi.fn(
      async () =>
        new Response(oversizedJson, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.ovhcloud.authenticate' })
  })

  it('rejects a successful response with a non-JSON media type', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(credentialCanary, {
          status: 201,
          headers: { 'content-type': 'text/plain' },
        }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(JSON.stringify(error)).not.toContain(credentialCanary)
  })

  it('rejects invalid UTF-8 before attempting provider schema decoding', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xfe]), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.ovhcloud.authenticate' })
  })

  it('rejects JSON deeper than the configured structural bound', async () => {
    let body: unknown = 'leaf'
    for (let depth = 0; depth < 34; depth += 1) body = { nested: body }
    const fetchMock = vi.fn(async () => jsonResponse(body, 201))
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.ovhcloud.authenticate' })
  })

  it('requires the exact Keystone 201 success status', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(identityResponse(), 200, { 'x-subject-token': tokenCanary }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('disables redirect following and normalizes a fetch redirect rejection', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      throw new Error(`redirect blocked: ${credentialCanary}`)
    })
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderTemporaryError')
    expect(JSON.stringify(error)).not.toContain(credentialCanary)
  })

  it('enforces its deadline even when an injected fetch ignores AbortSignal', async () => {
    const fetchMock = vi.fn(async () => await new Promise<Response>(() => undefined))
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock, timeoutMs: 2 }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderTemporaryError')
    expect(JSON.stringify(error)).not.toContain(credentialCanary)
  })

  it('aborts a cooperating fetch transport when its deadline expires', async () => {
    let transportAborted = false
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          if (init?.signal === null || init?.signal === undefined)
            throw new Error('Expected an AbortSignal')
          init.signal.addEventListener(
            'abort',
            () => {
              transportAborted = true
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        }),
    )
    const error = await failureOf(
      makeOvhProviderAccountValidator({ fetch: fetchMock, timeoutMs: 2 }).validate(
        validationInput(ovhCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderTemporaryError')
    expect(transportAborted).toBe(true)
  })
})

describe('Contabo provider-account validator', () => {
  it('proves compute read access and normalizes paginated VPS data-center regions', async () => {
    const requests: Array<{ readonly url: URL; readonly init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      requests.push({ url, ...(init === undefined ? {} : { init }) })
      if (url.hostname === 'auth.contabo.com')
        return jsonResponse({ access_token: tokenCanary, expires_in: 300, extra: 'ignored' })
      if (url.pathname === '/v1/compute/instances')
        return jsonResponse({ _pagination: { page: 1, totalPages: 0 }, data: [] })
      return url.searchParams.get('page') === '1'
        ? jsonResponse({
            _pagination: { page: 1, totalPages: 2 },
            data: [
              { regionSlug: 'US-east', capabilities: ['Object-Storage', 'VPS'] },
              { regionSlug: 'object-only', capabilities: ['Object-Storage'] },
            ],
          })
        : jsonResponse({
            _pagination: { page: 2, totalPages: 2 },
            data: [
              { regionSlug: 'EU', capabilities: ['VPS'] },
              { regionSlug: 'US-east', capabilities: ['VPS'] },
            ],
          })
    })

    const snapshot = await Effect.runPromise(
      makeContaboProviderAccountValidator({
        fetch: fetchMock,
        requestId: fixedRequestId,
      }).validate(validationInput(contaboCredentials)),
    )

    expect(snapshot).toMatchObject({ regions: ['EU', 'US-east'], projects: [], catalog: [] })
    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      '/auth/realms/contabo/protocol/openid-connect/token',
      '/v1/compute/instances?page=1&size=1',
      '/v1/data-centers?page=1&size=100',
      '/v1/data-centers?page=2&size=100',
    ])
    expect(requests.some(({ url }) => url.pathname.includes('/compute/products'))).toBe(false)
    expect(requests.some(({ url }) => url.pathname.includes('/compute/regions'))).toBe(false)
    const authRequestBody = requests[0]!.init?.body
    if (!(authRequestBody instanceof URLSearchParams))
      throw new Error('Expected a URL-encoded request body')
    const authBody = authRequestBody
    expect(authBody.get('client_secret')).toBe(credentialCanary)
    for (const request of requests.slice(1)) {
      const headers = new Headers(request.init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${tokenCanary}`)
      expect(headers.get('x-request-id')).toBe(fixedRequestId())
    }
    expect(JSON.stringify(requests.slice(1))).not.toContain(credentialCanary)
  })

  it('rejects excess Contabo credential properties before authentication', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    const error = await failureOf(
      makeContaboProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput({ ...contaboCredentials, unexpected: credentialCanary }),
      ),
    )

    expect(error._tag).toBe('ProviderValidationError')
    expect(error).toMatchObject({ field: 'credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain(credentialCanary)
  })

  it('pins the API base origin before sending credentials to the token endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    const error = await failureOf(
      makeContaboProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput({
          ...contaboCredentials,
          apiBaseUrl: 'https://api.contabo.com.attacker.example',
        }),
      ),
    )

    expect(error._tag).toBe('ProviderValidationError')
    expect(error).toMatchObject({ field: 'apiBaseUrl' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain('attacker.example')
  })

  it('pins the token origin before sending Contabo credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    const error = await failureOf(
      makeContaboProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput({
          ...contaboCredentials,
          tokenUrl:
            'https://auth.contabo.com.attacker.example/auth/realms/contabo/protocol/openid-connect/token',
        }),
      ),
    )

    expect(error._tag).toBe('ProviderValidationError')
    expect(error).toMatchObject({ field: 'tokenUrl' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain('attacker.example')
  })

  it('requires the exact Contabo token 200 success status', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: tokenCanary, expires_in: 300 }, 201),
    )
    const error = await failureOf(
      makeContaboProviderAccountValidator({ fetch: fetchMock }).validate(
        validationInput(contaboCredentials),
      ),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('requires exact 200 status for authenticated Contabo reads', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      urlOf(input).hostname === 'auth.contabo.com'
        ? jsonResponse({ access_token: tokenCanary, expires_in: 300 })
        : jsonResponse({ _pagination: { page: 1, totalPages: 0 }, data: [] }, 206),
    )
    const error = await failureOf(
      makeContaboProviderAccountValidator({
        fetch: fetchMock,
        requestId: fixedRequestId,
      }).validate(validationInput(contaboCredentials)),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.contabo.verifyComputeRead' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when compute-read pagination contradicts an empty account', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      urlOf(input).hostname === 'auth.contabo.com'
        ? jsonResponse({ access_token: tokenCanary, expires_in: 300 })
        : jsonResponse({
            _pagination: { page: 1, totalPages: 0 },
            data: [{ instanceId: 1 }],
          }),
    )
    const error = await failureOf(
      makeContaboProviderAccountValidator({
        fetch: fetchMock,
        requestId: fixedRequestId,
      }).validate(validationInput(contaboCredentials)),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.contabo.verifyComputeRead' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refuses data-center pagination beyond the configured page bound', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.hostname === 'auth.contabo.com')
        return jsonResponse({ access_token: tokenCanary, expires_in: 300 })
      if (url.pathname === '/v1/compute/instances')
        return jsonResponse({ _pagination: { page: 1, totalPages: 0 }, data: [] })
      return jsonResponse({
        _pagination: { page: 1, totalPages: 9 },
        data: [{ regionSlug: 'EU', capabilities: ['VPS'] }],
      })
    })
    const error = await failureOf(
      makeContaboProviderAccountValidator({
        fetch: fetchMock,
        requestId: fixedRequestId,
      }).validate(validationInput(contaboCredentials)),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.contabo.discoverRegions' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('requires a valid UUIDv4 request ID before each authenticated API call', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: tokenCanary, expires_in: 300 }),
    )
    const error = await failureOf(
      makeContaboProviderAccountValidator({
        fetch: fetchMock,
        requestId: () => 'not-a-request-id',
      }).validate(validationInput(contaboCredentials)),
    )

    expect(error._tag).toBe('ProviderValidationError')
    expect(error).toMatchObject({ operation: 'providerAccount.contabo.verifyComputeRead' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not claim success when data centers expose no compute region', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.hostname === 'auth.contabo.com')
        return jsonResponse({ access_token: tokenCanary, expires_in: 300 })
      if (url.pathname === '/v1/compute/instances')
        return jsonResponse({ _pagination: { page: 1, totalPages: 0 }, data: [] })
      return jsonResponse({
        _pagination: { page: 1, totalPages: 1 },
        data: [{ regionSlug: 'object-only', capabilities: ['Object-Storage'] }],
      })
    })
    const error = await failureOf(
      makeContaboProviderAccountValidator({
        fetch: fetchMock,
        requestId: fixedRequestId,
      }).validate(validationInput(contaboCredentials)),
    )

    expect(error._tag).toBe('ProviderUnknownError')
    expect(error).toMatchObject({ operation: 'providerAccount.contabo.discoverRegions' })
  })
})

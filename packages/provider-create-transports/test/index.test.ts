import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeContaboCreateTransport, makeOvhCreateTransport } from '../src/index.js'

const input = {
  organizationId: 'org-a',
  operationId: 'op-a',
  nodeId: 'node-a',
  name: 'Gridora Node A',
  regionId: 'GRA11',
  planId: 'plan-a',
  imageId: 'image-a',
  imageVersion: '2026.08.23',
  cloudInit: '#cloud-config\nwrite_files: []',
} as const
const ovhCredentials = {
  authUrl: 'https://auth.cloud.ovh.net/v3',
  region: 'GRA11',
  projectId: 'project-a',
  applicationCredentialId: 'application-id-canary',
  applicationCredentialSecret: 'application-secret-canary',
} as const
const contaboCredentials = {
  tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  apiBaseUrl: 'https://api.contabo.com/',
  clientId: 'client-id-canary',
  clientSecret: 'client-secret-canary',
  apiUser: 'api-user-canary@example.com',
  apiPassword: 'api-password-canary',
} as const
const hourlyTerms = {
  currency: 'EUR',
  estimatedMonthlyMinor: 1200,
  billingCadence: 'hourly',
  contractMonths: 1,
  nonHourlyCommitmentConfirmed: false,
  catalogRefreshedAt: '2026-08-23T00:00:00.000Z',
} as const
const contractTerms = {
  ...hourlyTerms,
  billingCadence: 'contract',
  contractMonths: 12,
  nonHourlyCommitmentConfirmed: true,
} as const

const json = (value: unknown, init: ResponseInit = {}) =>
  Response.json(value, { status: 200, ...init })
const ovhCatalog = {
  token: {
    catalog: [
      {
        type: 'compute',
        endpoints: [
          {
            interface: 'public',
            region: 'GRA11',
            url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-a',
          },
        ],
      },
      {
        type: 'network',
        endpoints: [
          {
            interface: 'public',
            region: 'GRA11',
            url: 'https://network.compute.gra11.cloud.ovh.net/',
          },
        ],
      },
    ],
  },
}
const ovhServer = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: 'server-a',
  name: input.name,
  status: 'ACTIVE',
  flavor: { id: input.planId },
  image: { id: input.imageId },
  addresses: { public: [{ addr: '192.0.2.10' }] },
  metadata: {
    'managed-by': 'gridora',
    'organization-id': input.organizationId,
    'node-id': input.nodeId,
    'operation-id': input.operationId,
    'image-version': input.imageVersion,
  },
  ...overrides,
})
const contaboDisplayName = [
  'gridora',
  input.organizationId,
  input.nodeId,
  input.operationId,
  input.imageVersion,
  input.name,
]
  .map(encodeURIComponent)
  .join('|')
const contaboInstance = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  instanceId: 12345,
  displayName: contaboDisplayName,
  status: 'running',
  region: input.regionId,
  productId: input.planId,
  imageId: input.imageId,
  ipConfig: { v4: { ip: '192.0.2.20' } },
  contractEndDate: '2027-08-23T00:00:00.000Z',
  ...overrides,
})
const requestId = () => '00000000-0000-4000-8000-000000000001'

const ovhAuthResponse = () =>
  json(ovhCatalog, { status: 201, headers: { 'x-subject-token': 'token-value-at-least-sixteen' } })
const contaboAuthResponse = () =>
  json({ access_token: 'access-token-at-least-sixteen', expires_in: 300 })

describe('production provider create transports', () => {
  it('authenticates with OVH application credentials and creates with exact ownership metadata', async () => {
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.hostname === 'auth.cloud.ovh.net') return ovhAuthResponse()
      if (request.method === 'GET' && url.pathname.endsWith('/servers/detail'))
        return json({ servers: [], servers_links: [] })
      if (request.method === 'POST' && url.pathname.endsWith('/servers'))
        return json({ server: { id: 'server-a' } }, { status: 202 })
      return json({ server: ovhServer() })
    }
    const node = await Effect.runPromise(
      makeOvhCreateTransport({ fetch: fetchImplementation }).createOrAdopt(
        ovhCredentials,
        input,
        hourlyTerms,
      ),
    )
    expect(node).toMatchObject({ id: 'server-a', state: 'active', addresses: ['192.0.2.10'] })
    expect(requests.every((request) => request.redirect === 'error')).toBe(true)
    const authBody = await requests[0]!.json()
    expect(authBody).toMatchObject({
      auth: {
        identity: {
          methods: ['application_credential'],
          application_credential: {
            id: ovhCredentials.applicationCredentialId,
            secret: ovhCredentials.applicationCredentialSecret,
          },
        },
      },
    })
    const create = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/servers'),
    )!
    await expect(create.json()).resolves.toMatchObject({
      server: {
        name: input.name,
        flavorRef: input.planId,
        imageRef: input.imageId,
        metadata: {
          'managed-by': 'gridora',
          'organization-id': input.organizationId,
          'node-id': input.nodeId,
          'operation-id': input.operationId,
          'image-version': input.imageVersion,
        },
      },
    })
  })

  it('switches an ambiguous OVH paid POST to adopt-only without issuing a second POST', async () => {
    let createPosts = 0
    let recoveryPolls = 0
    let now = 1_000
    const fetchImplementation: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init)
      const url = new URL(request.url)
      if (url.hostname === 'auth.cloud.ovh.net') return ovhAuthResponse()
      if (request.method === 'POST') {
        createPosts += 1
        throw new TypeError('response lost after provider acceptance')
      }
      if (url.pathname.endsWith('/servers/detail'))
        return json({
          servers: recoveryPolls >= 3 ? [ovhServer({ status: 'BUILD' })] : [],
          servers_links: [],
        })
      throw new Error('unexpected request')
    }
    const transport = makeOvhCreateTransport({ fetch: fetchImplementation, now: () => now })
    const uncertain = await Effect.runPromise(
      Effect.flip(transport.createOrAdopt(ovhCredentials, input, hourlyTerms)),
    )
    expect(uncertain).toMatchObject({
      _tag: 'ProviderCreateUncertainError',
      retryMode: 'adopt_only',
      nextAttemptAtEpochMs: 6000,
    })
    expect(JSON.stringify(uncertain)).not.toContain(ovhCredentials.applicationCredentialSecret)
    for (const adoptionAttempt of [2, 3]) {
      recoveryPolls += 1
      now = adoptionAttempt === 2 ? 841_000 : 899_000
      const stillUncertain = await Effect.runPromise(
        Effect.flip(
          transport.createOrAdopt(
            ovhCredentials,
            {
              ...input,
              createMode: 'adopt_only',
              adoptionAttempt,
              adoptionDeadlineAtEpochMs: 901_000,
            },
            hourlyTerms,
          ),
        ),
      )
      expect(stillUncertain).toMatchObject({
        _tag: 'ProviderCreateUncertainError',
        nextAttemptNumber: adoptionAttempt + 1,
        recoveryDeadlineAtEpochMs: 901_000,
      })
    }
    recoveryPolls = 3
    now = 901_000
    const adopted = await Effect.runPromise(
      transport.createOrAdopt(
        ovhCredentials,
        { ...input, createMode: 'adopt_only', adoptionAttempt: 4 },
        hourlyTerms,
      ),
    )
    expect(adopted).toMatchObject({ id: 'server-a', state: 'creating' })
    expect(createPosts).toBe(1)
  })

  it('rejects ambiguous or foreign OVH catalogs before any compute call', async () => {
    let calls = 0
    const fetchImplementation: typeof fetch = async () => {
      calls += 1
      return json(
        {
          token: {
            catalog: [...ovhCatalog.token.catalog, ovhCatalog.token.catalog[0]],
          },
        },
        { status: 201, headers: { 'x-subject-token': 'token-value-at-least-sixteen' } },
      )
    }
    const error = await Effect.runPromise(
      Effect.flip(
        makeOvhCreateTransport({ fetch: fetchImplementation }).createOrAdopt(
          ovhCredentials,
          input,
          hourlyTerms,
        ),
      ),
    )
    expect(error._tag).toBe('ProviderUnknownError')
    expect(calls).toBe(1)
  })

  it('maps fixed Contabo commercial terms and sends exact documented create metadata', async () => {
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.hostname === 'auth.contabo.com') return contaboAuthResponse()
      if (request.method === 'GET') return json({ data: [], _pagination: { totalPages: 1 } })
      return json({ data: [contaboInstance()] }, { status: 201 })
    }
    const node = await Effect.runPromise(
      makeContaboCreateTransport({ fetch: fetchImplementation, requestId }).createOrAdopt(
        contaboCredentials,
        input,
        contractTerms,
      ),
    )
    expect(node).toMatchObject({
      id: '12345',
      state: 'active',
      contract: { periodEndsAt: '2027-08-23T00:00:00.000Z' },
    })
    const create = requests.find(
      (request) => request.method === 'POST' && request.url.includes('/v1/compute/instances'),
    )!
    expect(create.headers.get('x-request-id')).toBe(requestId())
    expect(create.headers.get('x-trace-id')).toBe(input.operationId)
    expect(create.headers.get('authorization')).not.toContain(contaboCredentials.clientSecret)
    await expect(create.json()).resolves.toEqual({
      imageId: input.imageId,
      productId: input.planId,
      region: input.regionId,
      period: 12,
      displayName: contaboDisplayName,
      userData: input.cloudInit,
    })
  })

  it('recovers a lost Contabo create response by exact adopt-only ownership discovery', async () => {
    let createPosts = 0
    let recovery = false
    const fetchImplementation: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init)
      const url = new URL(request.url)
      if (url.hostname === 'auth.contabo.com') return contaboAuthResponse()
      if (request.method === 'POST') {
        createPosts += 1
        throw new TypeError('secret response canary should never escape')
      }
      return json({
        data: recovery ? [contaboInstance({ status: 'provisioning' })] : [],
        _pagination: { totalPages: 1 },
      })
    }
    const transport = makeContaboCreateTransport({
      fetch: fetchImplementation,
      requestId,
      now: () => 2000,
    })
    const uncertain = await Effect.runPromise(
      Effect.flip(transport.createOrAdopt(contaboCredentials, input, contractTerms)),
    )
    expect(uncertain).toMatchObject({
      _tag: 'ProviderCreateUncertainError',
      retryMode: 'adopt_only',
      nextAttemptAtEpochMs: 7000,
    })
    recovery = true
    const adopted = await Effect.runPromise(
      transport.createOrAdopt(
        contaboCredentials,
        { ...input, createMode: 'adopt_only' },
        contractTerms,
      ),
    )
    expect(adopted).toMatchObject({ id: '12345', state: 'creating' })
    expect(createPosts).toBe(1)
  })

  it('rejects unsupported Contabo periods before authentication', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const error = await Effect.runPromise(
      Effect.flip(
        makeContaboCreateTransport({ fetch: fetchImplementation }).createOrAdopt(
          contaboCredentials,
          input,
          { ...contractTerms, contractMonths: 6 },
        ),
      ),
    )
    expect(error._tag).toBe('ProviderValidationError')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('treats a provider 5xx after a paid POST as uncertain, never generically retryable', async () => {
    let createPosts = 0
    const fetchImplementation: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init)
      const url = new URL(request.url)
      if (url.hostname === 'auth.contabo.com') return contaboAuthResponse()
      if (request.method === 'GET') return json({ data: [], _pagination: { totalPages: 1 } })
      createPosts += 1
      return json({ code: 'internal' }, { status: 503 })
    }
    const error = await Effect.runPromise(
      Effect.flip(
        makeContaboCreateTransport({ fetch: fetchImplementation, requestId }).createOrAdopt(
          contaboCredentials,
          input,
          contractTerms,
        ),
      ),
    )
    expect(error).toMatchObject({
      _tag: 'ProviderCreateUncertainError',
      retryMode: 'adopt_only',
    })
    expect(createPosts).toBe(1)
  })

  it('rejects lookalike provider hosts before sending credentials', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const error = await Effect.runPromise(
      Effect.flip(
        makeContaboCreateTransport({ fetch: fetchImplementation }).createOrAdopt(
          { ...contaboCredentials, apiBaseUrl: 'https://api.contabo.com.evil.test/' },
          input,
          contractTerms,
        ),
      ),
    )
    expect(error._tag).toBe('ProviderUnknownError')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it.each([
    [
      'redirect',
      () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    ],
    ['malformed', () => new Response('{not-json', { status: 200 })],
    [
      'oversize',
      () =>
        new Response('x'.repeat(1024 * 1024 + 1), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
  ])(
    'fails closed on %s authentication responses without leaking secret canaries',
    async (_name, response) => {
      const fetchImplementation: typeof fetch = async (_raw, init) => {
        expect(init?.redirect).toBe('error')
        return response()
      }
      const error = await Effect.runPromise(
        Effect.flip(
          makeContaboCreateTransport({ fetch: fetchImplementation }).createOrAdopt(
            contaboCredentials,
            input,
            contractTerms,
          ),
        ),
      )
      const rendered = JSON.stringify(error)
      for (const canary of Object.values(contaboCredentials)) expect(rendered).not.toContain(canary)
    },
  )

  it('propagates Effect cancellation to the in-flight provider request', async () => {
    let aborted = false
    const fetchImplementation: typeof fetch = async (_raw, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new DOMException('cancelled', 'AbortError'))
          },
          { once: true },
        )
      })
    const transport = makeOvhCreateTransport({
      fetch: fetchImplementation,
      timeoutMilliseconds: 60_000,
    })
    await Effect.runPromise(
      Effect.exit(
        transport
          .createOrAdopt(ovhCredentials, input, hourlyTerms)
          .pipe(Effect.timeout('10 millis')),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(aborted).toBe(true)
  })

  it('rejects foreign ownership, image, plan, and region during adoption', async () => {
    const foreign = contaboInstance({
      displayName: contaboDisplayName.replace('org-a', 'org-b'),
      imageId: 'foreign-image',
      productId: 'foreign-plan',
      region: 'foreign-region',
    })
    const fetchImplementation: typeof fetch = async (raw) =>
      new URL(raw instanceof Request ? raw.url : String(raw)).hostname === 'auth.contabo.com'
        ? contaboAuthResponse()
        : json({ data: [foreign], _pagination: { totalPages: 1 } })
    const error = await Effect.runPromise(
      Effect.flip(
        makeContaboCreateTransport({ fetch: fetchImplementation, requestId }).createOrAdopt(
          contaboCredentials,
          { ...input, createMode: 'adopt_only' },
          contractTerms,
        ),
      ),
    )
    expect(error._tag).toBe('ProviderCreateUncertainError')
  })

  it.each([
    ['missing', {}],
    ['zero', { totalPages: 0 }],
    ['malformed', { totalPages: '2' }],
    ['over-limit', { totalPages: 6 }],
  ])('fails closed on %s Contabo pagination and never creates', async (_name, pagination) => {
    let createPosts = 0
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      ...contaboInstance({
        instanceId: index + 1,
        displayName: contaboDisplayName.replace('op-a', `foreign-${index}`),
      }),
    }))
    const fetchImplementation: typeof fetch = async (raw, init) => {
      const request = new Request(raw, init)
      if (new URL(request.url).hostname === 'auth.contabo.com') return contaboAuthResponse()
      if (request.method === 'POST') createPosts += 1
      return json({ data: fullPage, _pagination: pagination })
    }
    const error = await Effect.runPromise(
      Effect.flip(
        makeContaboCreateTransport({ fetch: fetchImplementation, requestId }).createOrAdopt(
          contaboCredentials,
          input,
          contractTerms,
        ),
      ),
    )
    expect(['ProviderUnknownError', 'ProviderConflictError']).toContain(error._tag)
    expect(createPosts).toBe(0)
  })
})

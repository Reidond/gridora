import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonHttpRequest, JsonHttpResponse } from '@gridora/provider-sdk'
import { makeContaboHttpApi, makeContaboOAuthHttpClient } from './http.js'

describe('Contabo REST adapter', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('follows pagination and supplies request IDs without a live API', async () => {
    const requests: JsonHttpRequest[] = []
    const http = {
      request: (input: JsonHttpRequest) => {
        requests.push(input)
        const page = input.path.includes('page=2') ? 2 : 1
        const displayName = [
          'gridora',
          'org',
          'node',
          `operation-${page}`,
          'image-v1',
          `server-${page}`,
        ]
          .map(encodeURIComponent)
          .join('|')
        return Effect.succeed({
          status: 200,
          headers: {},
          body: {
            _pagination: { totalPages: 2 },
            data: [
              {
                instanceId: page,
                displayName,
                region: 'EU',
                productId: 'V1',
                status: 'running',
                ipConfig: {},
              },
            ],
          },
        } satisfies JsonHttpResponse)
      },
    }
    const api = makeContaboHttpApi(http, {
      contractPeriodMonths: 1,
      requestId: () => '00000000-0000-4000-8000-000000000001',
      cancellation: () => ({ cancellationDate: '2026-09-01', billingStopsAt: '2026-09-01' }),
      secureWipeAndStop: () => Effect.succeed({}),
      firewallIdForInstance: () => 'firewall',
      firewallOwnershipDescription: () => 'gridora:org=org;node=node',
    })
    expect(await Effect.runPromise(api.instances({ 'organization-id': 'org' }))).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect(
      requests.every(
        (request) => request.headers?.['x-request-id'] === '00000000-0000-4000-8000-000000000001',
      ),
    ).toBe(true)
  })
  it('acquires and caches OAuth tokens without exposing API credentials to the resource request', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) =>
      (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes(
        '/token',
      )
        ? new Response(JSON.stringify({ access_token: 'token-value', expires_in: 300 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = await Effect.runPromise(
      makeContaboOAuthHttpClient({
        tokenUrl: 'https://auth.contabo.test/token',
        apiBaseUrl: 'https://api.contabo.test/',
        clientId: 'client',
        clientSecret: 'client-secret',
        apiUser: 'user',
        apiPassword: 'api-password',
      }),
    )
    await Effect.runPromise(client.request({ method: 'GET', path: '/v1/compute/instances' }))
    await Effect.runPromise(client.request({ method: 'GET', path: '/v1/compute/images' }))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const resourceHeaders = fetchMock.mock.calls[1]?.[1]?.headers
    expect(resourceHeaders).toMatchObject({ authorization: 'Bearer token-value' })
    expect(JSON.stringify(resourceHeaders)).not.toContain('api-password')
  })
  it('reconciles only an exactly owned firewall and preserves human rules', async () => {
    const requests: JsonHttpRequest[] = []
    const http = {
      request: (input: JsonHttpRequest) => {
        requests.push(input)
        return Effect.succeed({
          status: input.method === 'POST' ? 201 : 200,
          headers: {},
          body:
            input.method === 'GET'
              ? {
                  data: [
                    {
                      firewallId: 'firewall',
                      description: 'gridora:org=org;node=node',
                      rules: {
                        inbound: [
                          {
                            protocol: 'tcp',
                            destPorts: ['22'],
                            srcCidr: { ipv4: ['203.0.113.0/24'], ipv6: [] },
                            action: 'accept',
                            status: 'active',
                            displayName: 'human SSH',
                          },
                          {
                            protocol: 'udp',
                            destPorts: ['9999'],
                            srcCidr: { ipv4: ['0.0.0.0/0'], ipv6: [] },
                            action: 'accept',
                            status: 'active',
                            displayName: 'gridora:org=org;node=node',
                          },
                        ],
                      },
                    },
                  ],
                }
              : { data: [] },
        } satisfies JsonHttpResponse)
      },
    }
    const api = makeContaboHttpApi(http, {
      contractPeriodMonths: 1,
      requestId: () => '00000000-0000-4000-8000-000000000001',
      cancellation: () => ({ cancellationDate: '2026-09-01', billingStopsAt: '2026-09-01' }),
      secureWipeAndStop: () => Effect.succeed({}),
      firewallIdForInstance: () => 'firewall',
      firewallOwnershipDescription: () => 'gridora:org=org;node=node',
    })
    await Effect.runPromise(
      api.replaceFirewall('node', [
        { protocol: 'udp', portFrom: 2001, portTo: 2001, sourceCidrs: ['0.0.0.0/0'] },
      ]),
    )
    const update = requests.find((request) => request.method === 'PUT')
    expect(update?.body).toMatchObject({
      rules: {
        inbound: [
          { displayName: 'human SSH' },
          { displayName: 'gridora:org=org;node=node', destPorts: ['2001'] },
        ],
      },
    })
  })
})

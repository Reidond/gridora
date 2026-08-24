import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { OrphanDiscoveryAccount } from '@gridora/orphan-provider-discovery'
import { makeLiveOrphanProviderFactories } from '../src/index.js'

const account: OrphanDiscoveryAccount = {
  id: 'account-a',
  scope: 'organization',
  organizationId: 'org-a',
  accountOrganizationId: 'org-a',
  providerType: 'ovhcloud',
  credentialReference: 'credential-a',
  credentialRevision: 1,
  status: 'active',
}

const ovhCredentials = {
  authUrl: 'https://auth.cloud.ovh.net/v3',
  region: 'GRA11',
  projectId: 'project-a',
  applicationCredentialId: 'application-a',
  applicationCredentialSecret: 'ovh-secret-canary',
}

const contaboCredentials = {
  tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  apiBaseUrl: 'https://api.contabo.com/',
  clientId: 'client-a',
  clientSecret: 'contabo-secret-canary',
  apiUser: 'user-a',
  apiPassword: 'password-a',
}

const fetchFrom = (responses: readonly Response[]) => {
  const remaining = [...responses]
  const fetch = vi.fn(async () => {
    const next = remaining.shift()
    if (next === undefined) throw new Error('unexpected request')
    return next
  })
  return fetch as unknown as typeof globalThis.fetch
}

describe('live read-only orphan provider factories', () => {
  it('uses a fixed OVH token POST and one bounded read-only list request', async () => {
    const token = Response.json(
      {
        token: {
          catalog: [
            {
              type: 'compute',
              endpoints: [
                {
                  region: 'GRA11',
                  interface: 'public',
                  url: 'https://nova.openstack.gra11.cloud.ovh.net/v2.1/project-a',
                },
              ],
            },
          ],
        },
      },
      { headers: { 'x-subject-token': 'token-canary' } },
    )
    const listed = Response.json({
      servers: [
        {
          id: 'instance-a',
          name: 'node-a',
          status: 'ACTIVE',
          flavor: { id: 'small' },
          metadata: {
            'managed-by': 'gridora',
            'organization-id': 'org-a',
            'node-id': 'node-a',
            'operation-id': 'operation-a',
            'image-version': '1.0.0',
            'gridora-region': 'GRA11',
          },
          addresses: { public: [{ addr: '192.0.2.10' }] },
        },
        { id: 'unmanaged', name: 'other' },
      ],
      servers_links: [],
    })
    const fetch = fetchFrom([token, listed])
    const factories = makeLiveOrphanProviderFactories({ fetch })
    const list = await Effect.runPromise(factories.ovhcloud(ovhCredentials, account))
    await expect(Effect.runPromise(list({ organizationId: 'org-a' }))).resolves.toEqual([
      expect.objectContaining({
        id: 'instance-a',
        metadata: expect.objectContaining({ organizationId: 'org-a' }),
      }),
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
    const calls = (fetch as unknown as { readonly mock: { readonly calls: unknown[][] } }).mock
      .calls
    const [tokenUrl, tokenInit] = calls[0] as [URL, RequestInit]
    const [listUrl, listInit] = calls[1] as [URL, RequestInit]
    expect(tokenUrl.toString()).toBe('https://auth.cloud.ovh.net/v3/auth/tokens')
    expect(tokenInit.method).toBe('POST')
    expect(listUrl.toString()).toBe(
      'https://nova.openstack.gra11.cloud.ovh.net/v2.1/project-a/servers/detail?limit=200',
    )
    expect(listInit.method).toBe('GET')
  })

  it('fails closed on a provider continuation or forged organization without exposing credentials', async () => {
    const fetch = fetchFrom([
      Response.json(
        {
          token: {
            catalog: [
              {
                type: 'compute',
                endpoints: [
                  {
                    region: 'GRA11',
                    interface: 'public',
                    url: 'https://nova.openstack.gra11.cloud.ovh.net/v2.1/project-a',
                  },
                ],
              },
            ],
          },
        },
        { headers: { 'x-subject-token': 'token-canary' } },
      ),
      Response.json({
        servers: [],
        servers_links: [{ rel: 'next', href: 'https://example.invalid' }],
      }),
    ])
    const list = await Effect.runPromise(
      makeLiveOrphanProviderFactories({ fetch }).ovhcloud(ovhCredentials, account),
    )
    const result = await Effect.runPromise(Effect.result(list({ organizationId: 'org-a' })))
    expect(result._tag).toBe('Failure')
    expect(JSON.stringify(result)).not.toContain('ovh-secret-canary')
    expect(fetch).toHaveBeenCalledTimes(2)

    const deniedFetch = fetchFrom([])
    const denied = await Effect.runPromise(
      makeLiveOrphanProviderFactories({ fetch: deniedFetch }).ovhcloud(ovhCredentials, account),
    )
    await expect(Effect.runPromise(denied({ organizationId: 'org-b' }))).rejects.toMatchObject({
      _tag: 'ProviderAuthorizationError',
    })
    expect(deniedFetch).not.toHaveBeenCalled()
  })

  it('rejects Contabo pagination rather than enumerating a second page', async () => {
    const fetch = fetchFrom([
      Response.json({ access_token: 'token-canary', expires_in: 300 }),
      Response.json({ data: [], _pagination: { totalPages: 2 } }),
    ])
    const contaboAccount = { ...account, providerType: 'contabo' as const }
    const list = await Effect.runPromise(
      makeLiveOrphanProviderFactories({ fetch }).contabo(contaboCredentials, contaboAccount),
    )
    const result = await Effect.runPromise(Effect.result(list({ organizationId: 'org-a' })))
    expect(result._tag).toBe('Failure')
    expect(JSON.stringify(result)).not.toContain('contabo-secret-canary')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

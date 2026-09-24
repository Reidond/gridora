import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type { JsonHttpRequest, JsonHttpResponse } from '@gridora/provider-sdk'
import { makeOvhOpenStackHttpApi } from './http.js'
describe('OVH Neutron ownership', () => {
  it('preserves unknown security-group rules', async () => {
    const requests: JsonHttpRequest[] = []
    const networkHttp = {
      request: (input: JsonHttpRequest) => {
        requests.push(input)
        const body = input.path.includes('security-groups/')
          ? { security_group: { id: 'sg', description: 'gridora:org=o;node=n' } }
          : input.path.includes('security-group-rules?')
            ? {
                security_group_rules: [
                  { id: 'owned', description: 'gridora:org=o;node=n' },
                  { id: 'human', description: 'allow office SSH' },
                ],
              }
            : {}
        return Effect.succeed({
          status: input.method === 'POST' ? 201 : 200,
          body,
          headers: {},
        } satisfies JsonHttpResponse)
      },
    }
    const api = makeOvhOpenStackHttpApi(networkHttp, {
      regions: [],
      regionId: 'GRA',
      networkHttp,
      securityGroupIdForServer: () => 'sg',
      securityGroupOwnershipDescription: () => 'gridora:org=o;node=n',
    })
    await Effect.runPromise(
      api.replaceSecurityGroupRules('node', [
        { protocol: 'udp', portFrom: 2001, portTo: 2001, sourceCidrs: ['0.0.0.0/0'] },
      ]),
    )
    expect(requests.some((r) => r.path.endsWith('/owned') && r.method === 'DELETE')).toBe(true)
    expect(requests.some((r) => r.path.endsWith('/human') && r.method === 'DELETE')).toBe(false)
  })
})

describe('OVH Glance custom images', () => {
  const setup = (respond: (input: JsonHttpRequest) => JsonHttpResponse) => {
    const requests: JsonHttpRequest[] = []
    const imageHttp = {
      request: (input: JsonHttpRequest) => {
        requests.push(input)
        return Effect.succeed(respond(input))
      },
    }
    const unused = {
      request: () => Effect.die('compute and network are not used by image operations'),
    }
    const api = makeOvhOpenStackHttpApi(unused, {
      regions: [],
      regionId: 'GRA11',
      networkHttp: unused,
      imageHttp,
      securityGroupIdForServer: () => 'sg',
      securityGroupOwnershipDescription: () => 'gridora',
    })
    return { api, requests }
  }

  it('creates a private QCOW2 image, then starts one web-download import', async () => {
    const { api, requests } = setup((input) =>
      input.path === '/v2/images'
        ? {
            status: 201,
            headers: {},
            body: {
              id: 'image-1',
              name: 'gridora-node',
              status: 'queued',
              'managed-by': 'gridora',
              'gridora-image-id': 'gridora-node',
              os_hidden: false,
            },
          }
        : { status: 202, headers: {}, body: undefined },
    )
    const image = await Effect.runPromise(
      api.importImage!({
        name: 'gridora-node',
        architecture: 'amd64',
        sourceUrl: 'https://artifacts.example.test/image.qcow2',
        properties: { 'managed-by': 'gridora', 'gridora-image-id': 'gridora-node' },
      }),
    )
    expect(image).toEqual({
      id: 'image-1',
      name: 'gridora-node',
      status: 'queued',
      architecture: 'amd64',
      properties: { 'managed-by': 'gridora', 'gridora-image-id': 'gridora-node' },
    })
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/v2/images'],
      ['POST', '/v2/images/image-1/import'],
    ])
    expect(requests[0]!.body).toMatchObject({
      disk_format: 'qcow2',
      container_format: 'bare',
      visibility: 'private',
      'managed-by': 'gridora',
    })
    expect(requests[1]!.body).toEqual({
      method: { name: 'web-download', uri: 'https://artifacts.example.test/image.qcow2' },
    })
  })

  it('lists by exact name, maps states, and deletes by encoded id', async () => {
    const { api, requests } = setup((input) =>
      input.method === 'DELETE'
        ? { status: 204, headers: {}, body: undefined }
        : input.path.startsWith('/v2/images?')
          ? {
              status: 200,
              headers: {},
              body: { images: [{ id: 'a', name: 'n', status: 'killed', architecture: 'x86_64' }] },
            }
          : { status: 200, headers: {}, body: { id: 'a', name: 'n', status: 'active' } },
    )
    expect(await Effect.runPromise(api.customImages!('gridora node'))).toMatchObject([
      { id: 'a', status: 'failed', architecture: 'amd64', properties: {} },
    ])
    expect((await Effect.runPromise(api.getImage!('a'))).status).toBe('active')
    await Effect.runPromise(api.deleteImage!('a/b'))
    expect(requests.map((request) => request.path)).toEqual([
      '/v2/images?name=gridora%20node&limit=25',
      '/v2/images/a',
      '/v2/images/a%2Fb',
    ])
  })

  it('offers no image operations without an image endpoint and fails on HTTP errors', async () => {
    const unused = { request: () => Effect.die('unused') }
    const bare = makeOvhOpenStackHttpApi(unused, {
      regions: [],
      regionId: 'GRA11',
      networkHttp: unused,
      securityGroupIdForServer: () => 'sg',
      securityGroupOwnershipDescription: () => 'gridora',
    })
    expect(bare.importImage).toBeUndefined()
    expect(bare.deleteImage).toBeUndefined()
    const { api } = setup(() => ({ status: 404, headers: {}, body: {} }))
    const result = await Effect.runPromise(Effect.result(api.getImage!('missing')))
    expect(result._tag === 'Failure' && result.failure.status).toBe(404)
  })
})

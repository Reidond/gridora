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

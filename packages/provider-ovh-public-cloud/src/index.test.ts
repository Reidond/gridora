import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderAccountRef } from '@gridora/provider-sdk'
import { makeOvhPublicCloudProvider, normalizeOvhError, type OvhOpenStackApi } from './index.js'
const node = {
  id: 'p',
  name: 'n',
  state: 'active' as const,
  regionId: 'r',
  planId: 'f',
  addresses: [],
  metadata: {
    managedBy: 'gridora' as const,
    organizationId: 'o',
    nodeId: 'n',
    operationId: 'op',
    imageVersion: '1',
  },
}
const ovhAccount = {
  id: 'ovh-account',
  provider: 'ovhcloud',
  scope: 'platform',
} satisfies ProviderAccountRef
const api = (): OvhOpenStackApi => ({
  regions: () => Effect.succeed([]),
  flavors: () => Effect.succeed([]),
  images: () => Effect.succeed([]),
  servers: vi.fn(() => Effect.succeed([node])),
  createServer: vi.fn(() => Effect.succeed(node)),
  getServer: () => Effect.succeed(node),
  action: vi.fn(() => Effect.void),
  deleteServer: () => Effect.void,
  createSnapshot: () => Effect.succeed({ id: 's', state: 'creating' }),
  getSnapshot: () => Effect.succeed({ id: 's', organizationId: 'o', nodeId: 'n' }),
  deleteSnapshot: vi.fn(() => Effect.void),
  replaceSecurityGroupRules: () => Effect.void,
})
describe('OVH driver', () => {
  it('accepts the canonical API/D1 provider identifier through the real driver boundary', async () => {
    const client = api()
    const account = {
      id: 'api-shaped-ovh-account',
      provider: 'ovhcloud',
      scope: 'organization',
      organizationId: 'o',
    } satisfies ProviderAccountRef
    const result = await Effect.runPromise(
      makeOvhPublicCloudProvider(client, account).listNodes({ organizationId: 'o' }),
    )
    expect(result).toEqual([node])
    expect(client.servers).toHaveBeenCalledOnce()
  })

  it('adopts uncertain creates', async () => {
    const client = api()
    const p = makeOvhPublicCloudProvider(client, ovhAccount)
    await Effect.runPromise(
      p.createNode({
        organizationId: 'o',
        operationId: 'op',
        nodeId: 'n',
        name: 'n',
        regionId: 'r',
        planId: 'f',
        imageId: 'i',
        imageVersion: '1',
      }),
    )
    expect(client.createServer).not.toHaveBeenCalled()
  })
  it('normalizes quota failures', () =>
    expect(normalizeOvhError({ code: 'QUOTA_EXCEEDED', message: 'q' }, 'create')._tag).toBe(
      'ProviderQuotaError',
    ))
  it('does not mutate a node owned by another organization', async () => {
    const client = api()
    const result = await Effect.runPromise(
      Effect.result(
        makeOvhPublicCloudProvider(client, ovhAccount).startNode({
          organizationId: 'foreign',
          providerNodeId: 'p',
          operationId: 'mutate',
          nodeId: 'n',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(client.action).not.toHaveBeenCalled()
  })
  it('does not delete a snapshot owned by another organization or node', async () => {
    const client: OvhOpenStackApi = {
      ...api(),
      getSnapshot: () =>
        Effect.succeed({ id: 'foreign-snapshot', organizationId: 'foreign', nodeId: 'other' }),
    }
    const result = await Effect.runPromise(
      Effect.result(
        makeOvhPublicCloudProvider(client, ovhAccount).deleteSnapshot({
          organizationId: 'o',
          operationId: 'delete-snapshot',
          providerNodeId: 'p',
          nodeId: 'n',
          snapshotId: 'foreign-snapshot',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(client.deleteSnapshot).not.toHaveBeenCalled()
  })
  it('does not mutate another same-organization canonical node', async () => {
    const client = api()
    const result = await Effect.runPromise(
      Effect.result(
        makeOvhPublicCloudProvider(client, ovhAccount).startNode({
          organizationId: 'o',
          providerNodeId: 'p',
          operationId: 'mutate-node-a',
          nodeId: 'node-a',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(client.action).not.toHaveBeenCalled()
  })
  it('rejects a node create through an account for another provider type', async () => {
    const client = api()
    const result = await Effect.runPromise(
      Effect.result(
        makeOvhPublicCloudProvider(client, {
          id: 'wrong',
          provider: 'contabo',
          scope: 'platform',
        }).createNode({
          organizationId: 'o',
          operationId: 'wrong-account',
          nodeId: 'n',
          name: 'n',
          regionId: 'r',
          planId: 'f',
          imageId: 'i',
          imageVersion: '1',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(client.createServer).not.toHaveBeenCalled()
    expect(client.servers).not.toHaveBeenCalled()
  })
})

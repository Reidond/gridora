import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeContaboProvider, type ContaboApi } from './index.js'
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
  contract: { periodEndsAt: '2026-09-01' },
}
const contaboAccount = { id: 'contabo-account', provider: 'contabo', scope: 'platform' } as const
const api: ContaboApi = {
  regions: () => Effect.succeed([]),
  products: () => Effect.succeed([]),
  images: () => Effect.succeed([]),
  instances: () => Effect.succeed([node]),
  createInstance: () => Effect.succeed(node),
  getInstance: () => Effect.succeed(node),
  action: vi.fn(() => Effect.void),
  scheduleCancellation: () =>
    Effect.succeed({ cancellationDate: '2026-08-31', billingStopsAt: '2026-09-01' }),
  secureWipeAndStop: () => Effect.succeed({}),
  createSnapshot: () => Effect.succeed({ id: 's', state: 'creating' }),
  deleteSnapshot: () => Effect.void,
  replaceFirewall: () => Effect.void,
}
describe('Contabo contract truth', () => {
  it('returns scheduled billing semantics', async () => {
    const result = await Effect.runPromise(
      makeContaboProvider(api, false, contaboAccount).retireNode({
        organizationId: 'o',
        providerNodeId: 'p',
        operationId: 'op',
        nodeId: 'n',
      }),
    )
    expect(result).toEqual({
      kind: 'cancel_at_earliest_date',
      cancellationDate: '2026-08-31',
      billingStopsAt: '2026-09-01',
    })
  })
  it('never reports secure wipe as billing stopped', async () => {
    const result = await Effect.runPromise(
      makeContaboProvider(api, false, contaboAccount).retireNode({
        organizationId: 'o',
        providerNodeId: 'p',
        operationId: 'op',
        nodeId: 'n',
        mode: 'secure_wipe_and_stop',
      }),
    )
    expect(result.kind).toBe('secure_wipe_and_stop')
    if (result.kind === 'secure_wipe_and_stop') expect(result.billingStopped).toBe(false)
  })
  it('does not mutate a node owned by another organization', async () => {
    vi.mocked(api.action).mockClear()
    const result = await Effect.runPromise(
      Effect.result(
        makeContaboProvider(api, false, contaboAccount).rebootNode({
          organizationId: 'foreign',
          providerNodeId: 'p',
          operationId: 'mutate',
          nodeId: 'n',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(api.action).not.toHaveBeenCalled()
  })
  it('does not mutate another same-organization canonical node', async () => {
    vi.mocked(api.action).mockClear()
    const result = await Effect.runPromise(
      Effect.result(
        makeContaboProvider(api, false, contaboAccount).rebootNode({
          organizationId: 'o',
          providerNodeId: 'p',
          operationId: 'mutate-node-a',
          nodeId: 'node-a',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(api.action).not.toHaveBeenCalled()
  })
})

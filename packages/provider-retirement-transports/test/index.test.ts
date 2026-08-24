import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  ProviderNotFoundError,
  ProviderTemporaryError,
  type ComputeProviderShape,
  type ProviderNode,
} from '@gridora/provider-sdk'
import { makeProviderRetirementTransport } from '../src/index.js'

const input = {
  organizationId: 'org-a',
  operationId: 'operation-a',
  nodeId: 'node-a',
  providerNodeId: 'provider-node-a',
} as const

const node = (contract?: ProviderNode['contract']): ProviderNode => ({
  id: input.providerNodeId,
  name: 'Gridora node',
  state: 'stopped',
  regionId: 'eu-west',
  planId: 'plan-a',
  addresses: [],
  metadata: {
    managedBy: 'gridora',
    organizationId: input.organizationId,
    nodeId: input.nodeId,
    operationId: input.operationId,
    imageVersion: '1',
  },
  ...(contract === undefined ? {} : { contract }),
})

const provider = (overrides: Partial<ComputeProviderShape>): ComputeProviderShape =>
  ({
    capabilities: {
      hourlyBilling: false,
      immediateDelete: false,
      scheduledCancellation: true,
      cloudInit: false,
      customImages: false,
      snapshots: false,
      nativeFirewall: false,
      privateNetworking: false,
      floatingIp: false,
      rebuild: false,
    },
    listRegions: () => Effect.succeed([]),
    listPlans: () => Effect.succeed([]),
    listImages: () => Effect.succeed([]),
    createNode: () => Effect.die('not used'),
    getNode: () => Effect.die('not configured'),
    listNodes: () => Effect.succeed([]),
    startNode: () => Effect.die('not used'),
    stopNode: () => Effect.die('not used'),
    rebootNode: () => Effect.die('not used'),
    rebuildNode: () => Effect.die('not used'),
    retireNode: () => Effect.die('not configured'),
    createSnapshot: () => Effect.die('not used'),
    deleteSnapshot: () => Effect.die('not used'),
    applyFirewall: () => Effect.die('not used'),
    ...overrides,
  }) as ComputeProviderShape

describe('provider retirement truth', () => {
  it('only reports OVH deletion after a post-delete not-found observation, including response loss', async () => {
    let retireCalls = 0
    const ovh = provider({
      retireNode: () => {
        retireCalls += 1
        return Effect.fail(
          new ProviderTemporaryError({
            provider: 'ovhcloud',
            operation: 'delete',
            message: 'response lost',
          }),
        )
      },
      getNode: () =>
        Effect.fail(
          new ProviderNotFoundError({
            provider: 'ovhcloud',
            operation: 'get',
            message: 'not found',
          }),
        ),
    })
    const transport = makeProviderRetirementTransport({ ovh, contabo: provider({}) })
    await expect(
      Effect.runPromise(transport.retire({ ...input, provider: 'ovhcloud' })),
    ).resolves.toEqual({
      state: 'deleted-confirmed',
      billingState: 'stopped',
    })
    expect(retireCalls).toBe(1)
  })

  it('reconciles a prior OVH delete through a read only observation', async () => {
    let retireCalls = 0
    const ovh = provider({
      retireNode: () => {
        retireCalls += 1
        return Effect.die('a lease recovery must not issue another delete')
      },
      getNode: () =>
        Effect.fail(
          new ProviderNotFoundError({
            provider: 'ovhcloud',
            operation: 'get',
            message: 'not found',
          }),
        ),
    })
    const transport = makeProviderRetirementTransport({ ovh, contabo: provider({}) })
    await expect(
      Effect.runPromise(transport.observe({ ...input, provider: 'ovhcloud' })),
    ).resolves.toEqual({
      state: 'deleted-confirmed',
      billingState: 'stopped',
    })
    expect(retireCalls).toBe(0)
  })

  it('does not convert Contabo secure wipe into immediate deletion and requires a concrete cancellation schedule', async () => {
    const modes: string[] = []
    const contabo = provider({
      getNode: () => Effect.succeed(node({ periodEndsAt: '2026-09-01T00:00:00.000Z' })),
      retireNode: (request) => {
        modes.push(request.mode ?? '')
        return request.mode === 'secure_wipe_and_stop'
          ? Effect.succeed({ kind: 'secure_wipe_and_stop', billingStopped: false })
          : Effect.succeed({
              kind: 'cancel_at_earliest_date',
              cancellationDate: '2026-09-01T00:00:00.000Z',
              billingStopsAt: '2026-09-01T00:00:00.000Z',
            })
      },
    })
    const transport = makeProviderRetirementTransport({ ovh: provider({}), contabo })
    await expect(
      Effect.runPromise(transport.retire({ ...input, provider: 'contabo' })),
    ).resolves.toEqual({
      state: 'cancel-scheduled',
      billingState: 'continues-until-cancellation',
      cancellationDate: '2026-09-01T00:00:00.000Z',
      billingStopsAt: '2026-09-01T00:00:00.000Z',
    })
    expect(modes).toEqual(['secure_wipe_and_stop', 'cancel_at_earliest_date'])
  })

  it('keeps ambiguous Contabo provider truth blocked instead of inventing deletion', async () => {
    const contabo = provider({
      getNode: () => Effect.succeed(node({ periodEndsAt: '2026-09-01T00:00:00.000Z' })),
      retireNode: (request) =>
        request.mode === 'secure_wipe_and_stop'
          ? Effect.succeed({ kind: 'secure_wipe_and_stop', billingStopped: false })
          : Effect.fail(
              new ProviderTemporaryError({
                provider: 'contabo',
                operation: 'cancel',
                message: 'timeout',
              }),
            ),
    })
    const transport = makeProviderRetirementTransport({ ovh: provider({}), contabo })
    await expect(
      Effect.runPromise(transport.retire({ ...input, provider: 'contabo' })),
    ).resolves.toEqual({
      state: 'ambiguous',
      billingState: 'unknown',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { NodeRuntimeLifecycleCapabilityError } from '@gridora/node-runtime-lifecycle-control'
import {
  ProviderAuthorizationError,
  ProviderNotFoundError,
  ProviderTemporaryError,
  type ComputeProviderShape,
  type ProviderNode,
} from '@gridora/provider-sdk'
import {
  makeProviderNodeLifecycleTransport,
  type ProviderNodeLifecycleCapabilities,
} from '../src/index.js'

const target = {
  provider: 'ovhcloud' as const,
  organizationId: 'org-a',
  operationId: 'operation-a',
  nodeId: 'node-a',
  providerNodeId: 'provider-node-a',
  credentialBinding: {
    providerAccountId: 'provider-account-a',
    providerAccountScope: 'organization' as const,
    providerAccountRevision: 3,
    providerAllocationRevision: 5,
    providerCredentialReference: 'provider-secret-a',
    providerCredentialRevision: 7,
  },
}

const node = (overrides: Partial<ProviderNode> = {}): ProviderNode => ({
  id: target.providerNodeId,
  name: 'Gridora node',
  state: 'active',
  regionId: 'eu-west',
  planId: 'small',
  addresses: [],
  metadata: {
    managedBy: 'gridora',
    organizationId: target.organizationId,
    nodeId: target.nodeId,
    operationId: 'provision-operation-a',
    imageVersion: '1',
  },
  ...overrides,
})

const provider = (overrides: Partial<ComputeProviderShape> = {}): ComputeProviderShape => ({
  capabilities: {
    hourlyBilling: true,
    immediateDelete: true,
    scheduledCancellation: false,
    cloudInit: true,
    customImages: true,
    snapshots: true,
    nativeFirewall: true,
    privateNetworking: true,
    floatingIp: false,
    rebuild: true,
  },
  listRegions: () => Effect.succeed([]),
  listPlans: () => Effect.succeed([]),
  listImages: () => Effect.succeed([]),
  createNode: () => Effect.die('not used'),
  getNode: () => Effect.die('not configured'),
  listNodes: () => Effect.succeed([]),
  startNode: () => Effect.die('not configured'),
  stopNode: () => Effect.die('not configured'),
  rebootNode: () => Effect.die('not configured'),
  rebuildNode: () => Effect.die('not used'),
  retireNode: () => Effect.die('not used'),
  createSnapshot: () => Effect.die('not used'),
  deleteSnapshot: () => Effect.die('not used'),
  applyFirewall: () => Effect.die('not used'),
  ...overrides,
})

const enabled = { start: true, stop: true, reboot: true, observe: true } as const

const lifecycleTransport = (input: {
  readonly ovh?: ComputeProviderShape
  readonly contabo?: ComputeProviderShape
  readonly capabilities?: {
    readonly ovhcloud: ProviderNodeLifecycleCapabilities
    readonly contabo: ProviderNodeLifecycleCapabilities
  }
  readonly now?: () => string
  readonly resolve?: (accountId: string) => ComputeProviderShape
}) =>
  makeProviderNodeLifecycleTransport({
    capabilities: input.capabilities ?? { ovhcloud: enabled, contabo: enabled },
    resolver: {
      openExact: (request) =>
        Effect.succeed({
          provider:
            input.resolve?.(request.credentialBinding.providerAccountId) ??
            (request.provider === 'ovhcloud'
              ? (input.ovh ?? provider())
              : (input.contabo ?? provider())),
          capabilities: (input.capabilities ?? { ovhcloud: enabled, contabo: enabled })[
            request.provider
          ],
        }),
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  })

describe('provider node lifecycle transport', () => {
  it('observes after a lost start response and never repeats the provider action', async () => {
    let starts = 0
    const ovh = provider({
      startNode: () => {
        starts += 1
        return Effect.fail(
          new ProviderTemporaryError({
            provider: 'ovhcloud',
            operation: 'startNode',
            message: 'response lost',
          }),
        )
      },
      getNode: () => Effect.succeed(node()),
    })
    const transport = lifecycleTransport({ ovh, now: () => '2026-08-23T12:10:00.000Z' })
    await expect(
      Effect.runPromise(transport.dispatchAndObserve({ ...target, action: 'start' })),
    ).resolves.toEqual({
      providerState: 'active',
      rebootConfirmed: false,
      actionNotApplied: false,
      playerAddresses: [],
      observedAt: '2026-08-23T12:10:00.000Z',
    })
    expect(starts).toBe(1)
  })

  it('turns a post-dispatch observation authorization error into an uncertain outcome', async () => {
    let starts = 0
    const transport = lifecycleTransport({
      ovh: provider({
        startNode: () => {
          starts += 1
          return Effect.void
        },
        getNode: () =>
          Effect.fail(
            new ProviderAuthorizationError({
              provider: 'ovhcloud',
              operation: 'getNode',
              message: 'rotated credential must not imply an action rollback',
            }),
          ),
      }),
      now: () => '2026-08-23T12:11:00.000Z',
    })
    await expect(
      Effect.runPromise(transport.dispatchAndObserve({ ...target, action: 'start' })),
    ).resolves.toEqual({
      providerState: 'unknown',
      rebootConfirmed: false,
      actionNotApplied: false,
      observedAt: '2026-08-23T12:11:00.000Z',
    })
    expect(starts).toBe(1)
  })

  it('requires the deployed action capability at both admission and dispatch', async () => {
    const transport = lifecycleTransport({
      capabilities: { ovhcloud: { ...enabled, reboot: false }, contabo: enabled },
    })
    await expect(
      Effect.runPromise(transport.assertSupported({ providerType: 'ovhcloud', action: 'reboot' })),
    ).rejects.toBeInstanceOf(NodeRuntimeLifecycleCapabilityError)
    await expect(
      Effect.runPromise(transport.dispatchAndObserve({ ...target, action: 'reboot' })),
    ).rejects.toMatchObject({ _tag: 'ProviderUnsupportedCapabilityError', capability: 'reboot' })
  })

  it('does not trust a provider observation with forged Gridora ownership metadata', async () => {
    const transport = lifecycleTransport({
      ovh: provider({
        getNode: () => Effect.succeed(node({ metadata: { ...node().metadata, nodeId: 'node-b' } })),
      }),
    })
    await expect(Effect.runPromise(transport.observe(target))).rejects.toBeInstanceOf(
      ProviderAuthorizationError,
    )
  })

  it('maps a proven provider 404 to missing but treats unproven state as unknown', async () => {
    const missing = lifecycleTransport({
      ovh: provider({
        getNode: () =>
          Effect.fail(
            new ProviderNotFoundError({
              provider: 'ovhcloud',
              operation: 'getNode',
              message: 'not found',
            }),
          ),
      }),
      now: () => '2026-08-23T12:20:00.000Z',
    })
    await expect(Effect.runPromise(missing.observe(target))).resolves.toMatchObject({
      providerState: 'missing',
      rebootConfirmed: false,
      actionNotApplied: false,
    })
  })

  it('opens the exact same-provider account binding and never falls back to another account', async () => {
    let accountAStarts = 0
    let accountBStarts = 0
    const accountA = provider({
      startNode: () => {
        accountAStarts += 1
        return Effect.void
      },
      getNode: () => Effect.succeed(node()),
    })
    const accountB = provider({
      startNode: () => {
        accountBStarts += 1
        return Effect.void
      },
      getNode: () => Effect.succeed(node()),
    })
    const transport = lifecycleTransport({
      resolve: (accountId) => (accountId === 'provider-account-a' ? accountA : accountB),
    })
    await Effect.runPromise(transport.dispatchAndObserve({ ...target, action: 'start' }))
    expect(accountAStarts).toBe(1)
    expect(accountBStarts).toBe(0)
  })
})

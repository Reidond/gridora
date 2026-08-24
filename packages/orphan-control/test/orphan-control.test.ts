import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  OrphanClockLayer,
  OrphanControl,
  OrphanControlLive,
  OrphanDiscoveryPortLayer,
  OrphanRepositoryLayer,
  type AuthoritativeManagedResource,
  type OrphanDiscoverySnapshot,
  type OrphanReconciliationPlan,
} from '../src/index.js'

const request = {
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  providerType: 'ovhcloud' as const,
  runId: 'run-a',
  idempotencyKey: 'request-a',
  actorId: 'actor-a',
}
const resource = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  kind: 'node' as const,
  providerResourceId: 'instance-a',
  ownership: {
    managedBy: 'gridora',
    organizationId: 'org-a',
    nodeId: 'node-a',
    operationId: 'operation-a',
    imageVersion: '1.0.0',
  },
  ...overrides,
})
const snapshot = (overrides: Partial<OrphanDiscoverySnapshot> = {}): OrphanDiscoverySnapshot => ({
  organizationId: request.organizationId,
  providerAccountId: request.providerAccountId,
  providerType: request.providerType,
  credentialReference: 'credential-a',
  credentialRevision: 1,
  requestId: request.runId,
  observedAt: '2026-08-23T10:00:00Z',
  complete: true,
  truncated: false,
  continuationToken: null,
  resources: [resource()],
  removalEvidence: [],
  ...overrides,
})

const run = async (
  discovery: OrphanDiscoverySnapshot,
  authoritative: ReadonlyArray<AuthoritativeManagedResource> = [],
) => {
  let plan: OrphanReconciliationPlan | undefined
  const dependencies = Layer.mergeAll(
    OrphanDiscoveryPortLayer({ discover: () => Effect.succeed(discovery) }),
    OrphanRepositoryLayer({
      findReplay: () => Effect.succeed(null),
      authoritative: () => Effect.succeed(authoritative),
      applyAtomic: (value) => {
        plan = value
        return Effect.succeed({
          organizationId: value.organizationId,
          providerAccountId: value.providerAccountId,
          runId: value.runId,
          discoveryFingerprint: value.discoveryFingerprint,
          opened: value.observations.filter(({ disposition }) => disposition === 'orphan').length,
          updated: 0,
          resolved: value.observations.filter(
            ({ disposition }) => disposition === 'authoritative-adoption',
          ).length,
          unchanged: 0,
          replayed: false,
        })
      },
    }),
    OrphanClockLayer(new Date('2026-08-23T10:05:00Z')),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* OrphanControl).reconcile(request)
    }).pipe(Effect.provide(OrphanControlLive.pipe(Layer.provide(dependencies)))),
  )
  return { plan: plan!, result }
}

describe('tenant-scoped orphan control', () => {
  it('marks an exactly owned provider node as orphan without issuing a mutation', async () => {
    const { plan, result } = await run(snapshot())
    expect(plan.observations).toEqual([
      {
        providerResourceId: 'instance-a',
        nodeId: 'node-a',
        operationId: 'operation-a',
        imageVersion: '1.0.0',
        disposition: 'orphan',
      },
    ])
    expect(result.opened).toBe(1)
  })

  it('recognizes only an exact authoritative organization/account/resource/operation tuple', async () => {
    const authoritative: AuthoritativeManagedResource = {
      organizationId: 'org-a',
      providerAccountId: 'account-a',
      providerType: 'ovhcloud',
      kind: 'node',
      providerResourceId: 'instance-a',
      nodeId: 'node-a',
      operationId: 'operation-a',
      imageVersion: '1.0.0',
    }
    const { plan } = await run(snapshot(), [authoritative])
    expect(plan.observations[0]?.disposition).toBe('authoritative-adoption')

    const mismatchedImage = await run(snapshot(), [{ ...authoritative, imageVersion: '2.0.0' }])
    expect(mismatchedImage.plan.observations[0]?.disposition).toBe('orphan')
  })

  it('rejects a provider response containing foreign Gridora ownership', async () => {
    await expect(
      run(
        snapshot({
          resources: [
            resource({
              ownership: {
                managedBy: 'gridora',
                organizationId: 'org-b',
                nodeId: 'node-b',
                operationId: 'operation-b',
                imageVersion: '1.0.0',
              },
            }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })

  it('rejects stale, duplicate, and unbounded discovery', async () => {
    await expect(run(snapshot({ observedAt: '2026-08-23T09:00:00Z' }))).rejects.toMatchObject({
      code: 'stale-discovery',
    })
    await expect(run(snapshot({ resources: [resource(), resource()] }))).rejects.toMatchObject({
      code: 'ambiguous-discovery',
    })
    await expect(
      run(
        snapshot({
          resources: Array.from({ length: 501 }, (_, index) =>
            resource({ providerResourceId: `instance-${index}` }),
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: 'unbounded-discovery' })
  })

  it('ignores unmanaged resources and forwards only explicit removal evidence', async () => {
    const { plan } = await run(
      snapshot({
        resources: [{ kind: 'node', providerResourceId: 'human-instance', ownership: null }],
        removalEvidence: [
          {
            providerResourceId: 'instance-removed',
            evidenceId: 'provider-get-404-a',
            observedAt: '2026-08-23T10:01:00Z',
            kind: 'provider-removal',
          },
        ],
      }),
    )
    expect(plan.observations).toEqual([])
    expect(plan.removalEvidence).toHaveLength(1)
  })
})

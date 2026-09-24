import { Effect, Exit, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import type { AgentHealthSample } from '@gridora/agent-telemetry'
import type { RemoteProviderImage } from '@gridora/provider-image-registration'
import {
  ProviderNotFoundError,
  ProviderTemporaryError,
  ProviderValidationError,
  type ProviderError,
  type ProviderNode,
} from '@gridora/provider-sdk'
import {
  AgentHealthObservationError,
  AgentHealthObserver,
  ProviderImageSmokeDriver,
  SMOKE_ORGANIZATION_ID,
  type AgentHealthObserverShape,
  type ProviderImageObservation,
  type ProviderImageSmokeDriverShape,
  type ProviderImageSmokeInput,
} from '../src/index.js'

export const artifactUrl = 'https://artifacts.example.test/smoke.qcow2?X-Signature=locator-secret'

export const smokeInput = (
  overrides: Partial<ProviderImageSmokeInput> = {},
): ProviderImageSmokeInput => ({
  provider: 'ovhcloud',
  providerAccountId: 'platform-smoke-ovh',
  region: 'GRA11',
  plan: 'b3-8',
  ttlMinutes: 60,
  runId: '4242.1',
  sourceCommit: 'a'.repeat(40),
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  imageVersion: '4242.1',
  artifactUrl,
  ...overrides,
})

export interface FakeOptions {
  readonly provider?: 'ovhcloud' | 'contabo'
  readonly disposal?: 'delete' | 'cancel_contract'
  /** `lost`: the provider accepts the request but the response is lost. */
  readonly imageCreate?: 'ok' | 'lost' | 'reject'
  readonly nodeCreate?: 'ok' | 'lost' | 'lost-invisible' | 'reject'
  readonly imageReady?: 'ready' | 'never' | 'failed'
  readonly boot?: 'active' | 'never'
  readonly imageDelete?: 'ok' | 'fail'
  readonly nodeDispose?: 'ok' | 'fail'
}

export interface FakeProvider {
  readonly driver: ProviderImageSmokeDriverShape
  readonly seedImage: (image: RemoteProviderImage) => void
  readonly seedNode: (node: ProviderNode) => void
  readonly calls: {
    imageCreates: number
    nodeCreates: number
    imageDeletes: string[]
    nodeDisposals: string[]
    requests: string[]
  }
}

export const makeFakeProvider = (options: FakeOptions = {}): FakeProvider => {
  const provider = options.provider ?? 'ovhcloud'
  const disposal = options.disposal ?? (provider === 'contabo' ? 'cancel_contract' : 'delete')
  const cancels = disposal === 'cancel_contract'
  const images = new Map<string, { image: RemoteProviderImage; deleted: boolean }>()
  const nodes = new Map<string, { node: ProviderNode; disposed: boolean; visible: boolean }>()
  const calls: FakeProvider['calls'] = {
    imageCreates: 0,
    nodeCreates: 0,
    imageDeletes: [],
    nodeDisposals: [],
    requests: [],
  }
  let nextNode = 1
  const addNode = (
    input: Parameters<ProviderImageSmokeDriverShape['createNode']>[0],
    visible = true,
  ) => {
    const node: ProviderNode = {
      id: `node-${nextNode++}`,
      name: input.name,
      state: 'creating',
      regionId: input.regionId,
      planId: input.planId,
      addresses: [],
      metadata: {
        managedBy: 'gridora',
        organizationId: input.organizationId,
        nodeId: input.nodeId,
        operationId: input.operationId,
        imageVersion: input.imageVersion,
      },
    }
    nodes.set(node.id, { node, disposed: false, visible })
    return node
  }
  const driver: ProviderImageSmokeDriverShape = {
    provider,
    nodeDisposal: disposal,
    images: {
      list: (input) =>
        Effect.sync(() => {
          calls.requests.push('images.list')
          return [...images.values()]
            .filter((entry) => !entry.deleted && entry.image.name === input.expectedName)
            .map((entry) => entry.image)
        }),
      create: (input) =>
        Effect.suspend((): Effect.Effect<RemoteProviderImage, ProviderError> => {
          calls.requests.push('images.create')
          calls.imageCreates += 1
          if (options.imageCreate === 'reject')
            return Effect.fail(
              new ProviderValidationError({
                provider,
                operation: 'importImage',
                message: 'rejected',
              }),
            )
          const image: RemoteProviderImage = {
            id: `image-${calls.imageCreates}`,
            name: input.name,
            region: input.region,
            architecture: input.architecture,
            metadata: input.metadata,
          }
          images.set(image.id, { image, deleted: false })
          return options.imageCreate === 'lost'
            ? Effect.fail(
                new ProviderTemporaryError({ provider, operation: 'importImage', message: 'lost' }),
              )
            : Effect.succeed(image)
        }),
    },
    observeImage: (id) =>
      Effect.sync((): ProviderImageObservation => {
        calls.requests.push('images.observe')
        const entry = images.get(id)
        if (entry === undefined || entry.deleted) return 'absent'
        return options.imageReady === 'never'
          ? 'pending'
          : options.imageReady === 'failed'
            ? 'failed'
            : 'ready'
      }),
    deleteImage: (id) =>
      Effect.suspend((): Effect.Effect<void, ProviderError> => {
        calls.requests.push('images.delete')
        calls.imageDeletes.push(id)
        if (options.imageDelete === 'fail')
          return Effect.fail(
            new ProviderTemporaryError({ provider, operation: 'deleteImage', message: 'down' }),
          )
        const entry = images.get(id)
        if (entry === undefined)
          return Effect.fail(
            new ProviderNotFoundError({ provider, operation: 'deleteImage', message: 'gone' }),
          )
        entry.deleted = true
        return Effect.void
      }),
    listNodes: (input) =>
      Effect.sync(() => {
        calls.requests.push('nodes.list')
        return [...nodes.values()]
          .filter(
            (entry) =>
              entry.visible &&
              !(entry.disposed && !cancels) &&
              entry.node.metadata.organizationId === input.organizationId &&
              entry.node.metadata.operationId === input.operationId,
          )
          .map((entry) => entry.node)
      }),
    createNode: (input) =>
      Effect.suspend((): Effect.Effect<ProviderNode, ProviderError> => {
        calls.requests.push('nodes.create')
        calls.nodeCreates += 1
        if (options.nodeCreate === 'reject')
          return Effect.fail(
            new ProviderValidationError({ provider, operation: 'createNode', message: 'no' }),
          )
        if (options.nodeCreate === 'lost-invisible') {
          addNode(input, false)
          return Effect.fail(
            new ProviderTemporaryError({ provider, operation: 'createNode', message: 'lost' }),
          )
        }
        const node = addNode(input)
        return options.nodeCreate === 'lost'
          ? Effect.fail(
              new ProviderTemporaryError({ provider, operation: 'createNode', message: 'lost' }),
            )
          : Effect.succeed(node)
      }),
    observeNode: (id) =>
      Effect.sync(() => {
        calls.requests.push('nodes.observe')
        const entry = nodes.get(id)
        if (entry === undefined) return { kind: 'absent' as const }
        if (entry.disposed) {
          if (cancels)
            return {
              kind: 'present' as const,
              node: {
                ...entry.node,
                state: 'active' as const,
                contract: { periodEndsAt: '2026-10-24', cancellationDate: '2026-10-24' },
              },
            }
          return { kind: 'absent' as const }
        }
        return {
          kind: 'present' as const,
          node: { ...entry.node, state: options.boot === 'never' ? 'creating' : 'active' },
        }
      }),
    disposeNode: (id) =>
      Effect.suspend((): Effect.Effect<void, ProviderError> => {
        calls.requests.push('nodes.dispose')
        calls.nodeDisposals.push(id)
        if (options.nodeDispose === 'fail')
          return Effect.fail(
            new ProviderTemporaryError({ provider, operation: 'deleteNode', message: 'down' }),
          )
        const entry = nodes.get(id)
        if (entry === undefined)
          return Effect.fail(
            new ProviderNotFoundError({ provider, operation: 'deleteNode', message: 'gone' }),
          )
        entry.disposed = true
        return Effect.void
      }),
    nodeDisposed: (observation) =>
      observation.kind === 'absent' || observation.node.contract?.cancellationDate !== undefined,
  }
  return {
    driver,
    calls,
    seedImage: (image) => images.set(image.id, { image, deleted: false }),
    seedNode: (node) => nodes.set(node.id, { node, disposed: false, visible: true }),
  }
}

export const healthySample = (nodeId: string, overrides: Partial<AgentHealthSample> = {}) =>
  ({
    apiVersion: 'agent.telemetry.gridora.dev/v1alpha1',
    organizationId: SMOKE_ORGANIZATION_ID,
    nodeId,
    sampledAt: '1970-01-01T00:00:00.000Z',
    agentVersion: '1.4.0',
    tunnel: 'offline',
    docker: 'healthy',
    firewall: 'ready',
    cpuUsedMillis: 1,
    cpuTotalMillis: 2,
    ramUsedBytes: 1,
    ramTotalBytes: 2,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    loadPermille: 1,
    networkReceiveBytes: 0,
    networkTransmitBytes: 0,
    containers: [],
    ...overrides,
  }) satisfies AgentHealthSample

export const observer = (
  behavior: 'healthy' | 'never' | 'degraded' | 'foreign' | 'error' = 'healthy',
  reportAfterCalls = 2,
): AgentHealthObserverShape & { calls: number } => {
  const state = {
    calls: 0,
    latest: (input: { readonly nodeId: string }) =>
      Effect.suspend(() => {
        state.calls += 1
        if (behavior === 'error')
          return Effect.fail(new AgentHealthObservationError({ code: 'source-down' }))
        if (behavior === 'never' || state.calls < reportAfterCalls) return Effect.succeed(undefined)
        if (behavior === 'foreign') return Effect.succeed(healthySample('another-node'))
        if (behavior === 'degraded')
          return Effect.succeed(healthySample(input.nodeId, { docker: 'degraded' }))
        return Effect.succeed(healthySample(input.nodeId))
      }),
  }
  return state
}

/** Runs an effect under the test clock and advances virtual time until it completes. */
export const advanceVirtual = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(effect))
      for (let minute = 0; minute < 6 * 60; minute += 1) {
        yield* TestClock.adjust('1 minute')
      }
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )

export const runVirtual = <A, E>(
  effect: Effect.Effect<A, E, ProviderImageSmokeDriver | AgentHealthObserver>,
  driver: ProviderImageSmokeDriverShape,
  agent: AgentHealthObserverShape,
): Promise<Exit.Exit<A, E>> =>
  advanceVirtual(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderImageSmokeDriver, driver),
          Layer.succeed(AgentHealthObserver, agent),
        ),
      ),
    ),
  )

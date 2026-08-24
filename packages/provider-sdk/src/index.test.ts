import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  createOrAdopt,
  isRetryableProviderError,
  ProviderCreateUncertainError,
  ProviderTemporaryError,
  type ProviderNode,
  type ProviderStabilizationScheduler,
} from './index.js'

const virtualScheduler = (start = 0) => {
  let now = start
  const sleeps: number[] = []
  const scheduler: ProviderStabilizationScheduler = {
    nowEpochMs: Effect.sync(() => now),
    sleep: (milliseconds) =>
      Effect.sync(() => {
        sleeps.push(milliseconds)
        now += milliseconds
      }),
  }
  return {
    scheduler,
    sleeps,
    now: () => now,
    advanceTo: (epochMs: number) => {
      now = Math.max(now, epochMs)
    },
  }
}

const node: ProviderNode = {
  id: 'p-1',
  name: 'n',
  state: 'active',
  regionId: 'r',
  planId: 'p',
  addresses: [],
  metadata: {
    managedBy: 'gridora',
    organizationId: 'o',
    nodeId: 'n',
    operationId: 'op',
    imageVersion: '1',
  },
}
describe('provider contract', () => {
  it('adopts by organization and operation without creating', async () => {
    let creates = 0
    const result = await Effect.runPromise(
      createOrAdopt(
        {
          organizationId: 'o',
          operationId: 'op',
          nodeId: 'n',
          name: 'n',
          regionId: 'r',
          planId: 'p',
          imageId: 'i',
          imageVersion: '1',
        },
        () => Effect.succeed([node]),
        () => {
          creates++
          return Effect.succeed(node)
        },
      ),
    )
    expect(result.id).toBe('p-1')
    expect(creates).toBe(0)
  })
  it('does not adopt a same-operation resource for another canonical node', async () => {
    let creates = 0
    const result = await Effect.runPromise(
      Effect.result(
        createOrAdopt(
          {
            organizationId: 'o',
            operationId: 'op',
            nodeId: 'expected-node',
            name: 'n',
            regionId: 'r',
            planId: 'p',
            imageId: 'i',
            imageVersion: '1',
            createMode: 'adopt_only',
          },
          () => Effect.succeed([node]),
          () => {
            creates++
            return Effect.succeed(node)
          },
          { stabilizationAttempts: 2 },
        ),
      ),
    )
    expect(creates).toBe(0)
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProviderConflictError' },
    })
  })
  it('only retries transient failures', () =>
    expect(
      isRetryableProviderError(
        new ProviderTemporaryError({ provider: 'x', operation: 'list', message: 'down' }),
      ),
    ).toBe(true))

  it('stabilizes a transport-lost create through multiple stale reads without a second POST', async () => {
    let lists = 0
    let creates = 0
    const clock = virtualScheduler()
    const result = await Effect.runPromise(
      createOrAdopt(
        {
          organizationId: 'o',
          operationId: 'op',
          nodeId: 'n',
          name: 'n',
          regionId: 'r',
          planId: 'p',
          imageId: 'i',
          imageVersion: '1',
        },
        () => {
          lists++
          return Effect.succeed(clock.now() < 90 ? [] : [node])
        },
        () => {
          creates++
          return Effect.fail(
            new ProviderTemporaryError({
              provider: 'test',
              operation: 'createNode',
              message: 'response lost',
            }),
          )
        },
        {
          provider: 'test',
          stabilizationAttempts: 4,
          initialBackoffMs: 10,
          maxBackoffMs: 20,
          scheduler: clock.scheduler,
        },
      ),
    )
    expect(result.id).toBe('p-1')
    expect(creates).toBe(1)
    expect(clock.sleeps).toEqual([10, 20, 20, 20, 20])
    expect(lists).toBe(7)
  })

  it('returns a persistable adopt-only state and never recreates an uncertain request', async () => {
    let creates = 0
    const clock = virtualScheduler(1_000)
    const result = await Effect.runPromise(
      Effect.result(
        createOrAdopt(
          {
            organizationId: 'o',
            operationId: 'op',
            nodeId: 'n',
            name: 'n',
            regionId: 'r',
            planId: 'p',
            imageId: 'i',
            imageVersion: '1',
            createMode: 'adopt_only',
          },
          () => Effect.succeed([]),
          () => {
            creates++
            return Effect.succeed(node)
          },
          {
            provider: 'test',
            stabilizationAttempts: 3,
            initialBackoffMs: 10,
            maxBackoffMs: 20,
            scheduler: clock.scheduler,
          },
        ),
      ),
    )
    expect(creates).toBe(0)
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'ProviderCreateUncertainError',
        retryMode: 'adopt_only',
        stabilizationAttempts: 3,
        nextAttemptNumber: 4,
        nextAttemptAtEpochMs: 1050,
      },
    })
    if (result._tag === 'Failure')
      expect(result.failure).toBeInstanceOf(ProviderCreateUncertainError)
  })

  it('persists uncertain metadata and adopts after process reconstruction without a second create', async () => {
    const clock = virtualScheduler(10_000)
    let creates = 0
    let visibleAt = Number.POSITIVE_INFINITY
    const find = () => Effect.succeed(clock.now() >= visibleAt ? [node] : [])
    const create = () => {
      creates++
      return Effect.fail(
        new ProviderTemporaryError({
          provider: 'test',
          operation: 'createNode',
          message: 'response lost after acceptance',
        }),
      )
    }
    const request = {
      organizationId: 'o',
      operationId: 'op',
      nodeId: 'n',
      name: 'n',
      regionId: 'r',
      planId: 'p',
      imageId: 'i',
      imageVersion: '1',
    } as const
    const first = await Effect.runPromise(
      Effect.result(
        createOrAdopt(request, find, create, {
          provider: 'test',
          stabilizationAttempts: 2,
          initialBackoffMs: 10,
          maxBackoffMs: 20,
          scheduler: clock.scheduler,
        }),
      ),
    )
    expect(first).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'ProviderCreateUncertainError',
        retryMode: 'adopt_only',
        nextAttemptNumber: 5,
        nextAttemptAtEpochMs: 10050,
      },
    })
    if (first._tag !== 'Failure' || first.failure._tag !== 'ProviderCreateUncertainError')
      throw new Error('expected uncertain create')

    // Simulate durable persistence, process loss, and a Workflow wake-up at the supplied time.
    const persisted = JSON.parse(JSON.stringify(first.failure)) as ProviderCreateUncertainError
    visibleAt = persisted.nextAttemptAtEpochMs
    clock.advanceTo(persisted.nextAttemptAtEpochMs)
    const reconstructed = await Effect.runPromise(
      createOrAdopt({ ...request, createMode: persisted.retryMode }, find, create, {
        provider: 'test',
        stabilizationAttempts: 2,
        initialBackoffMs: 10,
        maxBackoffMs: 20,
        attemptOffset: persisted.nextAttemptNumber - 1,
        scheduler: clock.scheduler,
      }),
    )
    expect(reconstructed.id).toBe(node.id)
    expect(creates).toBe(1)
  })

  it('fails closed when stabilization finds ambiguous owned resources', async () => {
    let lists = 0
    let creates = 0
    const clock = virtualScheduler()
    const result = await Effect.runPromise(
      Effect.result(
        createOrAdopt(
          {
            organizationId: 'o',
            operationId: 'op',
            nodeId: 'n',
            name: 'n',
            regionId: 'r',
            planId: 'p',
            imageId: 'i',
            imageVersion: '1',
          },
          () => Effect.succeed(++lists <= 3 ? [] : [node, { ...node, id: 'p-2' }]),
          () => {
            creates++
            return Effect.succeed(node)
          },
          {
            provider: 'test',
            stabilizationAttempts: 4,
            initialBackoffMs: 1,
            maxBackoffMs: 1,
            scheduler: clock.scheduler,
          },
        ),
      ),
    )
    expect(creates).toBe(0)
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ProviderConflictError' } })
  })
})

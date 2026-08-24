import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { ProviderAuthorizationError, type ProviderError } from '@gridora/provider-sdk'
import type {
  ProviderNodeLifecycleObservation,
  ProviderNodeLifecycleTransportShape,
} from '@gridora/provider-node-lifecycle-transports'
import {
  makeNodeRuntimeLifecycleExecution,
  type NodeRuntimeLifecycleExecutionClaim,
  type NodeRuntimeLifecycleExecutionLease,
  type NodeRuntimeLifecycleExecutionRepositoryShape,
  type NodeRuntimeLifecycleExecutionReservation,
  type NodeRuntimeLifecycleExecutionResult,
} from '../src/index.js'

const request = {
  organizationId: 'org-a',
  operationId: 'operation-a',
  leaseOwner: 'workflow-worker-a',
  attemptedAt: '2026-08-23T12:30:00.000Z',
} as const

const reservation = (
  action: NodeRuntimeLifecycleExecutionReservation['action'],
): NodeRuntimeLifecycleExecutionReservation => ({
  organizationId: request.organizationId,
  nodeId: 'node-a',
  operationId: request.operationId,
  action,
  providerType: 'ovhcloud',
  providerInstanceId: 'provider-node-a',
  credentialBinding: {
    providerAccountId: 'provider-account-a',
    providerAccountScope: 'organization',
    providerAccountRevision: 3,
    providerAllocationRevision: 5,
    providerCredentialReference: 'provider-secret-a',
    providerCredentialRevision: 7,
  },
  previousDesiredState: action === 'stop' ? 'ready' : 'stopped',
  previousDesiredRevision: 7,
  desiredState: action === 'stop' ? 'stopped' : 'ready',
  desiredRevision: 8,
})

const observation = (
  providerState: ProviderNodeLifecycleObservation['providerState'],
  rebootConfirmed = false,
): ProviderNodeLifecycleObservation => ({
  providerState,
  rebootConfirmed,
  actionNotApplied: false,
  observedAt: request.attemptedAt,
})

const resultFor = (
  current: NodeRuntimeLifecycleExecutionReservation,
  received: ProviderNodeLifecycleObservation,
): NodeRuntimeLifecycleExecutionResult => {
  const succeeded =
    (current.action === 'stop' && received.providerState === 'stopped') ||
    (current.action === 'reconcile' && received.providerState === 'active')
  return {
    organizationId: current.organizationId,
    nodeId: current.nodeId,
    operationId: current.operationId,
    action: current.action,
    state: succeeded ? 'succeeded' : 'waiting-observation',
    operationStatus: succeeded ? 'succeeded' : 'waiting_external',
    providerState: received.providerState,
    rebootConfirmed: received.rebootConfirmed,
    observedState: succeeded ? 'ready' : 'bootstrapping',
  }
}

const repository = (initial: NodeRuntimeLifecycleExecutionReservation) => {
  let state: 'pending' | 'waiting' | 'terminal' = 'pending'
  let attempt = 0
  let phase: 'leased' | 'action-requested' | null = null
  let currentLease: NodeRuntimeLifecycleExecutionLease | null = null
  let terminalCode: string | null = null
  let stored: NodeRuntimeLifecycleExecutionResult | null = null
  const port: NodeRuntimeLifecycleExecutionRepositoryShape = {
    claim: ({ owner, token, leaseExpiresAt }) =>
      Effect.sync((): NodeRuntimeLifecycleExecutionClaim => {
        if (state === 'terminal' && stored !== null)
          return { disposition: 'adopted', result: stored }
        attempt += 1
        currentLease = { owner, token, expiresAt: leaseExpiresAt, attempt }
        return state === 'pending'
          ? {
              disposition: 'dispatch',
              reservation: initial,
              lease: currentLease,
              recovery: 'fresh',
            }
          : {
              disposition: 'observe',
              reservation: initial,
              lease: currentLease,
              recovery: 'observation-retry',
            }
      }),
    markActionRequested: ({ lease }) =>
      Effect.sync(() => {
        expect(lease).toEqual(currentLease)
        phase = 'action-requested'
        return 'marked' as const
      }),
    recordObservation: ({ lease, phase: nextPhase, observation: received }) =>
      Effect.sync(() => {
        expect(lease).toEqual(currentLease)
        phase = nextPhase
        stored = resultFor(initial, received)
        state = stored.state === 'succeeded' ? 'terminal' : 'waiting'
        return stored
      }),
    recordTerminalFailure: ({ lease, phase: nextPhase, code }) =>
      Effect.sync(() => {
        expect(lease).toEqual(currentLease)
        phase = nextPhase
        terminalCode = code
        stored = {
          organizationId: initial.organizationId,
          nodeId: initial.nodeId,
          operationId: initial.operationId,
          action: initial.action,
          state: 'failed-terminal',
          operationStatus: 'failed_terminal',
          providerState: 'unknown',
          rebootConfirmed: false,
          observedState: 'degraded',
        }
        state = 'terminal'
        return stored
      }),
  }
  return {
    port,
    phase: () => phase,
    attempts: () => attempt,
    terminalCode: () => terminalCode,
  }
}

const transport = (input: {
  readonly dispatch?: () => Effect.Effect<ProviderNodeLifecycleObservation, ProviderError>
  readonly observe?: () => Effect.Effect<ProviderNodeLifecycleObservation, ProviderError>
}) => {
  let dispatches = 0
  let observations = 0
  const port: ProviderNodeLifecycleTransportShape = {
    assertSupported: () => Effect.void,
    dispatchAndObserve: () => {
      dispatches += 1
      return input.dispatch?.() ?? Effect.succeed(observation('active'))
    },
    observe: () => {
      observations += 1
      return input.observe?.() ?? Effect.succeed(observation('active'))
    },
  }
  return { port, dispatches: () => dispatches, observations: () => observations }
}

const execution = (store: ReturnType<typeof repository>, provider: ReturnType<typeof transport>) =>
  makeNodeRuntimeLifecycleExecution({
    repository: store.port,
    transport: provider.port,
    leaseTokens: { next: () => `lease-${store.attempts() + 1}` },
  })

describe('node runtime lifecycle execution', () => {
  it('records dispatch before one provider action, then replays only an observation after response loss', async () => {
    const store = repository(reservation('start'))
    const provider = transport({})
    const first = await Effect.runPromise(execution(store, provider).execute(request))
    const second = await Effect.runPromise(execution(store, provider).execute(request))
    expect(first).toMatchObject({
      disposition: 'executed',
      result: { state: 'waiting-observation' },
    })
    expect(second).toMatchObject({
      disposition: 'executed',
      result: { state: 'waiting-observation' },
    })
    expect(store.phase()).toBe('leased')
    expect(store.attempts()).toBe(2)
    expect(provider.dispatches()).toBe(1)
    expect(provider.observations()).toBe(1)
  })

  it('never calls a provider after a committed dispatch mark has an unknown response', async () => {
    const current = reservation('start')
    const base = repository(current)
    const store: NodeRuntimeLifecycleExecutionRepositoryShape = {
      ...base.port,
      markActionRequested: () => Effect.succeed('delivery-unknown' as const),
      recordObservation: ({ recovery }) => {
        expect(recovery).toBe('dispatch-uncertain')
        return Effect.succeed({
          organizationId: current.organizationId,
          nodeId: current.nodeId,
          operationId: current.operationId,
          action: current.action,
          state: 'reconciliation-required' as const,
          operationStatus: 'failed_terminal' as const,
          providerState: 'stopped' as const,
          rebootConfirmed: false,
          observedState: 'offline' as const,
        })
      },
    }
    const provider = transport({ observe: () => Effect.succeed(observation('stopped')) })
    const outcome = await Effect.runPromise(
      makeNodeRuntimeLifecycleExecution({
        repository: store,
        transport: provider.port,
        leaseTokens: { next: () => 'lease-unknown-mark' },
      }).execute(request),
    )
    expect(outcome).toMatchObject({
      disposition: 'executed',
      result: { state: 'reconciliation-required', operationStatus: 'failed_terminal' },
    })
    expect(provider.dispatches()).toBe(0)
    expect(provider.observations()).toBe(1)
  })

  it('does not infer reboot completion from an accepted request and an active provider read', async () => {
    const store = repository(reservation('reboot'))
    const provider = transport({ dispatch: () => Effect.succeed(observation('active', false)) })
    const outcome = await Effect.runPromise(execution(store, provider).execute(request))
    expect(outcome).toMatchObject({
      disposition: 'executed',
      result: {
        action: 'reboot',
        state: 'waiting-observation',
        operationStatus: 'waiting_external',
        providerState: 'active',
        rebootConfirmed: false,
      },
    })
    expect(store.phase()).toBe('action-requested')
    expect(provider.dispatches()).toBe(1)
  })

  it('uses observe-only execution for reconcile and can converge desired ready with a provider observation', async () => {
    const store = repository(reservation('reconcile'))
    const provider = transport({ observe: () => Effect.succeed(observation('active')) })
    const outcome = await Effect.runPromise(execution(store, provider).execute(request))
    expect(outcome).toMatchObject({
      disposition: 'executed',
      result: { action: 'reconcile', state: 'succeeded', operationStatus: 'succeeded' },
    })
    expect(provider.dispatches()).toBe(0)
    expect(provider.observations()).toBe(1)
  })

  it('stores a redacted terminal authorization code without propagating provider messages', async () => {
    const store = repository(reservation('stop'))
    const provider = transport({
      dispatch: () =>
        Effect.fail(
          new ProviderAuthorizationError({
            provider: 'ovhcloud',
            operation: 'stopNode',
            message: 'credential value must never be persisted',
          }),
        ),
    })
    const outcome = await Effect.runPromise(execution(store, provider).execute(request))
    expect(outcome).toMatchObject({
      disposition: 'executed',
      result: { state: 'failed-terminal', operationStatus: 'failed_terminal' },
    })
    expect(store.terminalCode()).toBe('provider_authorization_blocked')
    expect(JSON.stringify(outcome)).not.toContain('credential value')
  })
})

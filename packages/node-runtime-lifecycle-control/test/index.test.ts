import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  NodeRuntimeLifecycleAuthorizationError,
  NodeRuntimeLifecycleCapabilityError,
  NodeRuntimeLifecycleConflictError,
  NodeRuntimeLifecycleWorkflowStartError,
  makeNodeRuntimeLifecycleControl,
  makeWebCryptoNodeRuntimeLifecycleIdentity,
  type NodeRuntimeLifecycleAcceptance,
  type NodeRuntimeLifecycleAtomicInput,
  type NodeRuntimeLifecycleCommand,
  type NodeRuntimeLifecycleNode,
  type NodeRuntimeLifecycleRepositoryShape,
} from '../src/index.js'

const node = (overrides: Partial<NodeRuntimeLifecycleNode> = {}): NodeRuntimeLifecycleNode => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  providerAccountId: 'provider-account-a',
  providerAccountScope: 'organization',
  providerAccountRevision: 3,
  providerAllocationRevision: 5,
  providerCredentialReference: 'provider-secret-a',
  providerCredentialRevision: 7,
  providerType: 'ovhcloud',
  providerInstanceId: 'instance-a',
  desiredState: 'stopped',
  observedState: 'offline',
  desiredRevision: 7,
  observedRevision: 4,
  pendingLifecycleOperationId: null,
  ...overrides,
})

const command = (
  overrides: Partial<NodeRuntimeLifecycleCommand> = {},
): NodeRuntimeLifecycleCommand => ({
  organizationId: 'org-a',
  actorId: 'actor-a',
  actorRole: 'operator',
  actorMembershipRevision: 9,
  nodeId: 'node-a',
  idempotencyKey: 'node-runtime-start-0001',
  correlationId: 'correlation-a',
  intent: { schemaVersion: 1, action: 'start', expectedDesiredRevision: 7 },
  ...overrides,
})

const acceptance = (input: NodeRuntimeLifecycleAtomicInput): NodeRuntimeLifecycleAcceptance => ({
  disposition: 'created',
  organizationId: input.command.organizationId,
  nodeId: input.command.nodeId,
  action: input.command.intent.action,
  operationId: input.identity.operationId,
  idempotencyKey: input.command.idempotencyKey,
  fingerprint: input.fingerprint,
  transition: input.transition,
  workflowStart: {
    id: input.identity.workflowStartRecordId,
    state: 'pending',
    attempts: 0,
    lastError: null,
  },
})

const repository = (current = node()) => {
  let reads = 0
  let accepts = 0
  let startFailures = 0
  const replays = new Map<string, NodeRuntimeLifecycleAcceptance>()
  const port: NodeRuntimeLifecycleRepositoryShape = {
    findReplay: ({ organizationId, idempotencyKey, fingerprint }) => {
      const stored = replays.get(`${organizationId}:${idempotencyKey}`)
      if (stored !== undefined && stored.fingerprint !== fingerprint)
        return Effect.fail(
          new NodeRuntimeLifecycleConflictError({ code: 'idempotency_payload_mismatch' }),
        )
      return Effect.succeed(stored ?? null)
    },
    getNode: (organizationId, nodeId) =>
      Effect.sync(() => {
        reads += 1
        if (organizationId !== current.organizationId || nodeId !== current.nodeId)
          throw new Error('test only exposes the scoped node')
        return current
      }),
    acceptAtomic: (input) =>
      Effect.sync(() => {
        accepts += 1
        const next = acceptance(input)
        replays.set(`${input.command.organizationId}:${input.command.idempotencyKey}`, next)
        current = {
          ...current,
          desiredState: input.transition.desiredState,
          desiredRevision: input.transition.desiredRevision,
          pendingLifecycleOperationId: input.identity.operationId,
        }
        return next
      }),
    markWorkflowStarted: () => Effect.void,
    markWorkflowAdopted: () => Effect.void,
    recordWorkflowStartFailure: () =>
      Effect.sync(() => {
        startFailures += 1
      }),
  }
  return {
    port,
    reads: () => reads,
    accepts: () => accepts,
    startFailures: () => startFailures,
  }
}

const service = (store: ReturnType<typeof repository>, supported = true, startFails = false) =>
  makeNodeRuntimeLifecycleControl({
    repository: store.port,
    capabilities: {
      assertSupported: ({ action, providerType }) =>
        supported
          ? Effect.void
          : Effect.fail(new NodeRuntimeLifecycleCapabilityError({ action, providerType })),
    },
    identities: makeWebCryptoNodeRuntimeLifecycleIdentity(),
    clock: { now: Effect.succeed({ iso: '2026-08-23T12:00:00.000Z' }) },
    workflows: {
      start: (accepted) =>
        startFails
          ? Effect.fail(
              new NodeRuntimeLifecycleWorkflowStartError({
                operationId: accepted.operationId,
                message: 'response lost',
              }),
            )
          : Effect.void,
    },
  })

describe('node runtime lifecycle control', () => {
  it('accepts an Operator start with a deterministic identity and an exact revision intent', async () => {
    const store = repository()
    const result = await Effect.runPromise(service(store).submit(command()))
    expect(result).toMatchObject({
      disposition: 'created',
      nodeId: 'node-a',
      action: 'start',
      workflowState: 'started',
      transition: {
        previousDesiredState: 'stopped',
        previousDesiredRevision: 7,
        desiredState: 'ready',
        desiredRevision: 8,
      },
    })
    expect(result.operationId).toMatch(/^op_node_runtime_[a-f0-9]{24}$/)
    expect(store.reads()).toBe(1)
    expect(store.accepts()).toBe(1)
  })

  it('adopts an exact response-loss replay before loading the current node or capability facts', async () => {
    const store = repository()
    const first = await Effect.runPromise(service(store).submit(command()))
    const second = await Effect.runPromise(service(store).submit(command()))
    expect(second).toEqual({ ...first, disposition: 'adopted' })
    expect(store.reads()).toBe(1)
    expect(store.accepts()).toBe(1)
  })

  it('rejects a Viewer and never accepts an automation role as a human operator', async () => {
    const viewerStore = repository()
    await expect(
      Effect.runPromise(service(viewerStore).submit(command({ actorRole: 'viewer' }))),
    ).rejects.toBeInstanceOf(NodeRuntimeLifecycleAuthorizationError)
    expect(viewerStore.reads()).toBe(0)
    expect(viewerStore.accepts()).toBe(0)

    const automationStore = repository()
    await expect(
      Effect.runPromise(service(automationStore).submit(command({ actorRole: 'automation' }))),
    ).rejects.toBeInstanceOf(NodeRuntimeLifecycleAuthorizationError)
    expect(automationStore.accepts()).toBe(0)
  })

  it('fails a stale revision, invalid transition, or unsupported provider before recording a workflow', async () => {
    await expect(
      Effect.runPromise(
        service(repository()).submit(
          command({ intent: { schemaVersion: 1, action: 'start', expectedDesiredRevision: 6 } }),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: 'NodeRuntimeLifecycleConflictError',
      code: 'desired_revision_mismatch',
    })
    await expect(
      Effect.runPromise(service(repository(node({ desiredState: 'ready' }))).submit(command())),
    ).rejects.toMatchObject({
      _tag: 'NodeRuntimeLifecycleConflictError',
      code: 'invalid_desired_state',
    })
    await expect(
      Effect.runPromise(service(repository(), false).submit(command())),
    ).rejects.toBeInstanceOf(NodeRuntimeLifecycleCapabilityError)
  })

  it('keeps the accepted intent durable when a Workflow start response is lost', async () => {
    const store = repository()
    const result = await Effect.runPromise(service(store, true, true).submit(command()))
    expect(result.workflowState).toBe('pending-reconciliation')
    expect(store.accepts()).toBe(1)
    expect(store.startFailures()).toBe(1)
  })
})

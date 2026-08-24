import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  makeTerminationControl,
  sha256TerminationFingerprint,
  type CancellationRequest,
  type NodeLifecycleAcceptance,
  type NodeLifecycleCommand,
  type OperationCancellationSignalShape,
  type TerminationRepositoryShape,
  TerminationPersistenceError,
} from '../src/index.js'

const facts = {
  organizationId: 'org-a',
  operationId: 'operation-a',
  resourceType: 'node',
  resourceId: 'node-a',
  resourceOperationDoName: 'resource-operation:org-a:node:node-a',
  workflowBinding: 'RETIRE_NODE',
  workflowType: 'RetireNodeWorkflow',
  workflowInstanceId: 'operation-a',
  policy: 'before-destructive-step' as const,
  phase: 'before-destructive-step' as const,
  revision: 1,
}

const baseRequest = (signalState: CancellationRequest['signalState']): CancellationRequest => ({
  disposition: 'created',
  operation: {
    id: 'operation-a',
    organizationId: 'org-a',
    actorId: 'actor-a',
    action: 'retire-node',
    resourceType: 'node',
    resourceId: 'node-a',
    cancellationPolicy: 'before-destructive-step',
    revision: 2,
    state: 'cancelling',
  },
  facts,
  signalState,
})

const repository = (
  record: TerminationRepositoryShape['recordCancellationSignal'],
): TerminationRepositoryShape => ({
  acceptNodeLifecycle: () => Effect.die('not used'),
  acceptOrganizationDeletion: () => Effect.die('not used'),
  requestCancellation: () => Effect.succeed(baseRequest('pending-delivery')),
  recordCancellationSignal: record,
})

const cancellation = {
  organizationId: 'org-a',
  actorId: 'actor-a',
  role: 'administrator' as const,
  correlationId: 'correlation-a',
  idempotencyKey: 'cancellation-key-0001',
  operationId: 'operation-a',
  expectedOperationRevision: 1,
}

const fingerprint = { fingerprint: () => Effect.succeed('a'.repeat(64)) }

const policySchedulerCommand = (
  overrides: Partial<NodeLifecycleCommand> = {},
): NodeLifecycleCommand => ({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-a',
  role: 'automation',
  correlationId: 'policy-reconciliation-run-a',
  idempotencyKey: 'policy-action-idempotency-a',
  action: 'retire-node',
  nodeId: 'node-a',
  expectedNodeRevision: 4,
  force: false,
  backupPolicy: 'required',
  policySchedulerRetire: { actionId: 'policy-action-a' },
  ...overrides,
})

const policySchedulerAcceptance = (command: NodeLifecycleCommand): NodeLifecycleAcceptance => ({
  disposition: 'created',
  operation: {
    id: 'operation-policy-a',
    organizationId: command.organizationId,
    actorId: command.actorId,
    action: command.action,
    resourceType: 'node',
    resourceId: command.nodeId,
    cancellationPolicy: 'before-destructive-step',
    revision: 1,
    state: 'queued',
  },
  nodeId: command.nodeId,
  previousNodeRevision: command.expectedNodeRevision,
  desiredNodeRevision: command.expectedNodeRevision + 1,
  state: 'retiring',
  workflowStart: {
    id: 'workflow-start-policy-a',
    organizationId: command.organizationId,
    operationId: 'operation-policy-a',
    workflowType: 'RetireNodeWorkflow',
    workflowInstanceId: 'operation-policy-a',
    paramsFingerprint: 'a'.repeat(64),
    state: 'pending',
    attempts: 0,
    lastErrorCode: null,
  },
})

const lifecycleRepository = (
  acceptNodeLifecycle: TerminationRepositoryShape['acceptNodeLifecycle'],
): TerminationRepositoryShape => ({
  acceptNodeLifecycle,
  acceptOrganizationDeletion: () => Effect.die('not used'),
  requestCancellation: () => Effect.die('not used'),
  recordCancellationSignal: () => Effect.die('not used'),
})

describe('termination cancellation control', () => {
  it('does not turn a successful false target acknowledgement into delivered', async () => {
    const signal: OperationCancellationSignalShape = {
      signal: () => Effect.succeed({ resourceOperationSignalled: false, workflowSignalled: true }),
    }
    const control = makeTerminationControl(
      repository(() => Effect.succeed(baseRequest('pending-delivery'))),
      signal,
      fingerprint,
    )
    await expect(Effect.runPromise(control.cancelOperation(cancellation))).resolves.toMatchObject({
      signalState: 'pending-delivery',
    })
  })

  it('uses exact durable state after a transport response loss instead of transient true/true', async () => {
    const signal: OperationCancellationSignalShape = {
      signal: () => Effect.succeed({ resourceOperationSignalled: true, workflowSignalled: true }),
    }
    const control = makeTerminationControl(
      repository(() => Effect.succeed(baseRequest('pending-delivery'))),
      signal,
      fingerprint,
    )
    await expect(Effect.runPromise(control.cancelOperation(cancellation))).resolves.toMatchObject({
      signalState: 'pending-delivery',
    })
  })

  it('does not suppress a failed durable signal record', async () => {
    const signal: OperationCancellationSignalShape = {
      signal: () => Effect.succeed({ resourceOperationSignalled: true, workflowSignalled: true }),
    }
    const control = makeTerminationControl(
      repository(() =>
        Effect.fail(
          new TerminationPersistenceError({
            operation: 'record-cancellation',
            message: 'response lost',
          }),
        ),
      ),
      signal,
      fingerprint,
    )
    const exit = await Effect.runPromiseExit(control.cancelOperation(cancellation))
    expect(exit._tag).toBe('Failure')
  })

  it('uses a stable SHA-256 request fingerprint without preserving canonical payload', async () => {
    const value = await Effect.runPromise(sha256TerminationFingerprint(cancellation))
    expect(value).toHaveLength(64)
    expect(value).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('policy scheduler retirement boundary', () => {
  it('accepts only the exact internal automation retirement binding and passes it unchanged to the D1 boundary', async () => {
    let accepted: NodeLifecycleCommand | undefined
    const control = makeTerminationControl(
      lifecycleRepository((command) => {
        accepted = command
        return Effect.succeed(policySchedulerAcceptance(command))
      }),
      { signal: () => Effect.die('not used') },
      fingerprint,
    )

    await expect(
      Effect.runPromise(control.beginNodeLifecycle(policySchedulerCommand())),
    ).resolves.toMatchObject({
      operation: { actorId: 'policy-scheduler-a', action: 'retire-node' },
      workflowStart: { state: 'pending' },
    })
    expect(accepted?.policySchedulerRetire).toEqual({ actionId: 'policy-action-a' })
  })

  it.each([
    ['ordinary automation', policySchedulerCommand({ policySchedulerRetire: undefined })],
    ['wrong role', policySchedulerCommand({ role: 'administrator' })],
    ['wrong action', policySchedulerCommand({ action: 'drain-node' })],
    ['forced retirement', policySchedulerCommand({ force: true })],
    ['skip backup', policySchedulerCommand({ backupPolicy: 'skip-authorized' })],
    ['target image', policySchedulerCommand({ targetImageId: 'image-a' })],
  ] as const)(
    'rejects %s before an automation principal can enter the destructive boundary',
    async (_label, command) => {
      let calls = 0
      const control = makeTerminationControl(
        lifecycleRepository(() => {
          calls += 1
          return Effect.die('must not accept')
        }),
        { signal: () => Effect.die('not used') },
        fingerprint,
      )

      await expect(Effect.runPromise(control.beginNodeLifecycle(command))).rejects.toBeDefined()
      expect(calls).toBe(0)
    },
  )
})

import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  GameLifecycleOperation,
  GameLifecycleRepository,
} from '@gridora/game-lifecycle-control'
import { GameLifecycleRevisionConflictError } from '@gridora/game-lifecycle-d1'
import type {
  PolicyReconciliationActionRecord,
  PolicyReconciliationControlShape,
  PolicyReconciliationResult,
} from '@gridora/policy-reconciliation-control'
import {
  derivePolicyScheduleTask,
  type PolicyScheduleStore,
  type PolicyScheduleTask,
} from '@gridora/policy-schedule'
import {
  TerminationConflictError,
  TerminationValidationError,
  type TerminationControlShape,
  type TerminationOperation,
} from '@gridora/lifecycle-termination-control'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  makePolicyLifecycleActionExecutor,
  registerPolicyReconciliationRoutes,
} from '../src/policy-reconciliation-routes.js'

type TestEnv = { Bindings: Record<string, never> }

const runtime = makeWorkerEffectRuntime(Layer.empty)
const now = '2026-08-23T10:30:00.000Z'

const task = async (): Promise<PolicyScheduleTask> =>
  Effect.runPromise(
    derivePolicyScheduleTask({
      organizationId: 'org-a',
      actorId: 'policy-scheduler-org-a',
      policyRevision: 1,
      scheduleSlot: now,
    }),
  )

const action = (
  overrides: Partial<PolicyReconciliationActionRecord> = {},
): PolicyReconciliationActionRecord => ({
  id: 'policy-action-server-a',
  organizationId: 'org-a',
  actorId: 'policy-scheduler-org-a',
  runId: 'policy-run-a',
  policyRevision: 1,
  resourceKind: 'server',
  resourceId: 'server-a',
  resourceRevision: 7,
  kind: 'update-server',
  reason: 'automatic-update-eligible',
  idempotencyKey: 'policy-action-idempotency-server-a',
  correlationId: 'policy-reconciliation-policy-run-a',
  resourceExpiresAt: null,
  activityLastAt: null,
  healthSampledAt: null,
  healthRevision: null,
  configRevision: 3,
  modRevision: 2,
  updateCandidateId: 'candidate-a',
  updateCandidateRevision: 1,
  updateCategory: 'security',
  updateTargetVersion: '1.2.3',
  dispatchState: 'pending',
  operationId: null,
  ...overrides,
})

const result = (scheduled: PolicyScheduleTask): PolicyReconciliationResult => ({
  organizationId: scheduled.organizationId,
  actorId: scheduled.actorId,
  policyRevision: scheduled.policyRevision,
  runId: scheduled.runId,
  idempotencyKey: scheduled.idempotencyKey,
  snapshotFingerprint: `sha256:${'a'.repeat(64)}`,
  actions: [],
  replayed: false,
})

const gameOperation = (): GameLifecycleOperation => ({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-org-a',
  operationId: 'operation-game-a',
  serverId: 'server-a',
  action: 'update',
  expectedRevision: 7,
  fingerprint: 'a'.repeat(64),
  state: 'queued',
})

const nodeOperation = (): TerminationOperation => ({
  id: 'operation-node-a',
  organizationId: 'org-a',
  actorId: 'policy-scheduler-org-a',
  action: 'retire-node',
  resourceType: 'node',
  resourceId: 'node-a',
  cancellationPolicy: 'before-destructive-step',
  revision: 1,
  state: 'queued',
})

describe('policy reconciliation internal route', () => {
  let app: Hono<TestEnv>
  let scheduled: PolicyScheduleTask
  let authenticationCalls = 0
  let leaseCalls = 0
  let reconcileCalls = 0
  let publishCalls = 0
  let completeCalls = 0

  beforeEach(async () => {
    scheduled = await task()
    authenticationCalls = 0
    leaseCalls = 0
    reconcileCalls = 0
    publishCalls = 0
    completeCalls = 0
    const schedule: PolicyScheduleStore = {
      claimScheduledTasks: () => Effect.succeed([]),
      beginWorkflow: () => Effect.succeed('started'),
      assertExecutionLease: (input) =>
        Effect.sync(() => {
          leaseCalls += 1
          expect(input).toEqual(scheduled)
        }),
      complete: (input) =>
        Effect.sync(() => {
          completeCalls += 1
          expect(input).toEqual(scheduled)
          return 'completed' as const
        }),
    }
    const control: PolicyReconciliationControlShape = {
      reconcile: (input) =>
        Effect.sync(() => {
          reconcileCalls += 1
          expect(input).toMatchObject({
            organizationId: scheduled.organizationId,
            actorId: scheduled.actorId,
            policyRevision: scheduled.policyRevision,
            runId: scheduled.runId,
            leaseToken: scheduled.leaseToken,
          })
          return result(scheduled)
        }),
    }
    app = new Hono<TestEnv>()
    registerPolicyReconciliationRoutes(app, {
      runtimeFor: () => runtime,
      authenticate: (_request, rawBody) =>
        Effect.sync(() => {
          authenticationCalls += 1
          expect(new TextDecoder().decode(rawBody)).toBe(JSON.stringify(scheduled))
        }),
      schedule: () => Effect.succeed(schedule),
      control: () => Effect.succeed(control),
      publish: (_bindings, published) =>
        Effect.sync(() => {
          publishCalls += 1
          expect(published).toEqual(result(scheduled))
        }),
    })
  })

  afterAll(async () => runtime.dispose())

  const execute = (headers: Record<string, string> = {}) =>
    app.request('https://api.gridora.test/v1/internal/policy-reconciliations/execute', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gridora-workflow': 'reconcile-policy',
        'x-gridora-organization-id': scheduled.organizationId,
        'idempotency-key': `workflow:${scheduled.idempotencyKey}`,
        ...headers,
      },
      body: JSON.stringify(scheduled),
    })

  it('authenticates raw bytes, rechecks the lease, then publishes only after reconciliation', async () => {
    const response = await execute()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result(scheduled))
    expect({
      authenticationCalls,
      leaseCalls,
      reconcileCalls,
      publishCalls,
      completeCalls,
    }).toEqual({
      authenticationCalls: 1,
      leaseCalls: 1,
      reconcileCalls: 1,
      publishCalls: 1,
      completeCalls: 1,
    })
  })

  it('rejects a forged tenant header before lease or lifecycle work', async () => {
    const response = await execute({ 'x-gridora-organization-id': 'org-b' })

    expect(response.status).toBe(400)
    expect({
      authenticationCalls,
      leaseCalls,
      reconcileCalls,
      publishCalls,
      completeCalls,
    }).toEqual({
      authenticationCalls: 1,
      leaseCalls: 0,
      reconcileCalls: 0,
      publishCalls: 0,
      completeCalls: 0,
    })
  })
})

describe('policy lifecycle action executor', () => {
  it('submits exact update revisions through the existing game lifecycle acceptance boundary', async () => {
    let received: unknown
    const gameLifecycle: GameLifecycleRepository = {
      findIdempotent: () => Effect.succeed(null),
      create: () => Effect.fail(new Error('not used')),
      mutate: (input) =>
        Effect.sync(() => {
          received = input
          return {
            disposition: 'created' as const,
            operation: gameOperation(),
            workflowState: 'pending-reconciliation' as const,
          }
        }),
    }
    const termination: TerminationControlShape = {
      beginNodeLifecycle: () => Effect.fail(new TerminationValidationError({ code: 'not_used' })),
      beginOrganizationDeletion: () =>
        Effect.fail(new TerminationValidationError({ code: 'not_used' })),
      cancelOperation: () => Effect.fail(new TerminationValidationError({ code: 'not_used' })),
    }

    const receipt = await Effect.runPromise(
      makePolicyLifecycleActionExecutor({ gameLifecycle, termination }).dispatch(action()),
    )

    expect(receipt).toEqual({
      actionId: 'policy-action-server-a',
      operationId: 'operation-game-a',
      disposition: 'accepted',
      workflowState: 'pending-reconciliation',
    })
    expect(received).toMatchObject({
      organizationId: 'org-a',
      actorId: 'policy-scheduler-org-a',
      serverId: 'server-a',
      expectedRevision: 7,
      policyReconciliationActionId: 'policy-action-server-a',
      intent: {
        action: 'update',
        expectedConfigRevision: 3,
        expectedModRevision: 2,
        backupBeforeUpdate: true,
      },
    })
  })

  it('submits a retire request only with the exact scheduler binding', async () => {
    let received: unknown
    const gameLifecycle: GameLifecycleRepository = {
      findIdempotent: () => Effect.succeed(null),
      create: () => Effect.fail(new Error('not used')),
      mutate: () => Effect.fail(new Error('not used')),
    }
    const termination: TerminationControlShape = {
      beginNodeLifecycle: (input) =>
        Effect.sync(() => {
          received = input
          return {
            disposition: 'created' as const,
            operation: nodeOperation(),
            nodeId: 'node-a',
            previousNodeRevision: 3,
            desiredNodeRevision: 4,
            state: 'accepted' as const,
            workflowStart: {
              id: 'workflow-start-node-a',
              organizationId: 'org-a',
              operationId: 'operation-node-a',
              workflowType: 'retire-node',
              workflowInstanceId: 'retire-node-a',
              paramsFingerprint: 'b'.repeat(64),
              state: 'pending' as const,
              attempts: 0,
              lastErrorCode: null,
            },
          }
        }),
      beginOrganizationDeletion: () =>
        Effect.fail(new TerminationValidationError({ code: 'not_used' })),
      cancelOperation: () => Effect.fail(new TerminationValidationError({ code: 'not_used' })),
    }
    const retire = action({
      id: 'policy-action-node-a',
      resourceKind: 'node',
      resourceId: 'node-a',
      resourceRevision: 3,
      kind: 'retire-node',
      reason: 'temporary-node-expired',
      resourceExpiresAt: '2026-08-23T10:00:00.000Z',
      configRevision: null,
      modRevision: null,
      updateCandidateId: null,
      updateCandidateRevision: null,
      updateCategory: null,
      updateTargetVersion: null,
    })

    const receipt = await Effect.runPromise(
      makePolicyLifecycleActionExecutor({ gameLifecycle, termination }).dispatch(retire),
    )

    expect(receipt).toMatchObject({
      actionId: 'policy-action-node-a',
      operationId: 'operation-node-a',
      disposition: 'accepted',
      workflowState: 'pending-reconciliation',
    })
    expect(received).toMatchObject({
      role: 'automation',
      action: 'retire-node',
      force: false,
      backupPolicy: 'required',
      policySchedulerRetire: { actionId: 'policy-action-node-a' },
    })
  })

  it('fails closed when the game boundary reports a stale revision', async () => {
    const gameLifecycle: GameLifecycleRepository = {
      findIdempotent: () => Effect.succeed(null),
      create: () => Effect.fail(new Error('not used')),
      mutate: () =>
        Effect.fail(
          new GameLifecycleRevisionConflictError({ serverId: 'server-a', expected: 7, actual: 8 }),
        ),
    }
    const termination: TerminationControlShape = {
      beginNodeLifecycle: () => Effect.fail(new TerminationConflictError({ code: 'not used' })),
      beginOrganizationDeletion: () =>
        Effect.fail(new TerminationValidationError({ code: 'not_used' })),
      cancelOperation: () => Effect.fail(new TerminationValidationError({ code: 'not_used' })),
    }

    await expect(
      Effect.runPromise(
        makePolicyLifecycleActionExecutor({ gameLifecycle, termination }).dispatch(action()),
      ),
    ).rejects.toMatchObject({ code: 'stale-resource' })
  })
})

import { Effect, Layer, Schema } from 'effect'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { OrganizationContext } from '@gridora/domain'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import type {
  NodeLifecycleAcceptance,
  TerminationControlShape,
} from '@gridora/lifecycle-termination-control'
import { registerNodeLifecycleRoutes } from '../src/node-lifecycle-routes.js'

const runtime = makeWorkerEffectRuntime(Layer.empty)
const actor = Schema.decodeUnknownSync(OrganizationContext)({
  organizationId: 'org-a',
  organizationSlug: 'org-a',
  identityId: 'identity-a',
  role: 'administrator',
  correlationId: 'correlation-a',
})

const acceptanceFor = (
  action: 'drain-node' | 'leave-drain' | 'rebuild-node' | 'retire-node',
): NodeLifecycleAcceptance => ({
  disposition: 'created',
  operation: {
    id: `operation-${action}`,
    organizationId: 'org-a',
    actorId: 'identity-a',
    action,
    resourceType: 'node',
    resourceId: 'node-a',
    cancellationPolicy: 'before-destructive-step',
    revision: 1,
    state: 'queued',
  },
  nodeId: 'node-a',
  previousNodeRevision: 7,
  desiredNodeRevision: 8,
  state:
    action === 'retire-node' ? 'retiring' : action === 'rebuild-node' ? 'draining' : 'accepted',
  workflowStart: {
    id: `start-${action}`,
    organizationId: 'org-a',
    operationId: `operation-${action}`,
    workflowType: 'DrainNodeWorkflow',
    workflowInstanceId: `operation-${action}`,
    paramsFingerprint: 'a'.repeat(64),
    state: 'pending',
    attempts: 0,
    lastErrorCode: null,
  },
})

const appWith = (control: TerminationControlShape) => {
  const app = new Hono<{ Bindings: {} }>()
  registerNodeLifecycleRoutes(app, {
    runtimeFor: () => runtime,
    authorize: () => Effect.succeed(actor),
    control: () => Effect.succeed(control),
    startWorkflow: () => Effect.succeed('started'),
  })
  return app
}

const body = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schemaVersion: 1,
  expectedNodeRevision: 7,
  force: false,
  backupPolicy: 'required',
  ...overrides,
})

describe('canonical node lifecycle routes', () => {
  it.each([
    ['drain', 'POST', '/actions/drain', 'drain-node'],
    ['uncordon', 'POST', '/actions/uncordon', 'leave-drain'],
  ] as const)(
    'maps public %s to the accepted action and starts its exact workflow',
    async (_label, method, suffix, action) => {
      let received: unknown
      const control: TerminationControlShape = {
        beginNodeLifecycle: (command) => {
          received = command
          return Effect.succeed(acceptanceFor(action))
        },
        beginOrganizationDeletion: () => Effect.die('not used'),
        cancelOperation: () => Effect.die('not used'),
      }
      const response = await appWith(control).request(
        `https://api.test/v1/organizations/org-a/nodes/node-a${suffix}`,
        {
          method,
          headers: { 'content-type': 'application/json', 'idempotency-key': `node-${action}-0001` },
          body: JSON.stringify(body()),
        },
      )

      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({
        disposition: 'created',
        operationId: `operation-${action}`,
        nodeId: 'node-a',
        workflowState: 'started',
      })
      expect(received).toMatchObject({
        organizationId: 'org-a',
        actorId: 'identity-a',
        correlationId: 'correlation-a',
        idempotencyKey: `node-${action}-0001`,
        action,
        nodeId: 'node-a',
        expectedNodeRevision: 7,
        force: false,
        backupPolicy: 'required',
      })
    },
  )

  it('rejects a client-selected image on non-rebuild routes before entering the control', async () => {
    let calls = 0
    const app = appWith({
      beginNodeLifecycle: () => {
        calls += 1
        return Effect.die('untrusted body must not reach the control')
      },
      beginOrganizationDeletion: () => Effect.die('not used'),
      cancelOperation: () => Effect.die('not used'),
    })
    const response = await app.request(
      'https://api.test/v1/organizations/org-a/nodes/node-a/actions/drain',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'node-drain-0002' },
        body: JSON.stringify(body({ targetImageId: 'image-a' })),
      },
    )

    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  it('requires a target image for canonical rebuild before lifecycle acceptance', async () => {
    let calls = 0
    const app = appWith({
      beginNodeLifecycle: () => {
        calls += 1
        return Effect.die('rebuild without image must not be accepted')
      },
      beginOrganizationDeletion: () => Effect.die('not used'),
      cancelOperation: () => Effect.die('not used'),
    })
    const response = await app.request(
      'https://api.test/v1/organizations/org-a/nodes/node-a/actions/rebuild',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'node-rebuild-0001' },
        body: JSON.stringify(body()),
      },
    )

    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  it('does not advertise unknown node actions', async () => {
    const response = await appWith({
      beginNodeLifecycle: () => Effect.die('unknown action must not reach control'),
      beginOrganizationDeletion: () => Effect.die('not used'),
      cancelOperation: () => Effect.die('not used'),
    }).request('https://api.test/v1/organizations/org-a/nodes/node-a/actions/hibernate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'node-unknown-0001' },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(404)
  })
})

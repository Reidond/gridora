import { Effect, Layer, Schema } from 'effect'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { OrganizationContext } from '@gridora/domain'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import type { NodeRuntimeLifecycleControlShape } from '@gridora/node-runtime-lifecycle-control'
import { registerNodeRuntimeLifecycleRoutes } from '../src/node-runtime-lifecycle-routes.js'

const runtime = makeWorkerEffectRuntime(Layer.empty)
const actor = Schema.decodeUnknownSync(OrganizationContext)({
  organizationId: 'org-a',
  organizationSlug: 'org-a',
  identityId: 'identity-a',
  role: 'operator',
  correlationId: 'correlation-a',
})

const result = {
  disposition: 'created' as const,
  nodeId: 'node-a',
  action: 'start' as const,
  operationId: 'operation-runtime-a',
  transition: {
    previousDesiredState: 'stopped' as const,
    previousDesiredRevision: 7,
    desiredState: 'ready' as const,
    desiredRevision: 8,
  },
  workflowState: 'started' as const,
}

describe('node runtime lifecycle routes', () => {
  it('accepts a URL-selected action with only revision and returns the durable result', async () => {
    let received: unknown
    const control: NodeRuntimeLifecycleControlShape = {
      submit: (command) => {
        received = command
        return Effect.succeed(result)
      },
    }
    const app = new Hono<{ Bindings: {} }>()
    registerNodeRuntimeLifecycleRoutes(app, {
      runtimeFor: () => runtime,
      authorize: () => Effect.succeed(actor),
      control: () => Effect.succeed(control),
    })

    const response = await app.request(
      'https://api.test/v1/organizations/org-a/nodes/node-a/actions/start',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'node-runtime-start-0001',
        },
        body: JSON.stringify({ schemaVersion: 1, expectedDesiredRevision: 7 }),
      },
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(result)
    expect(received).toMatchObject({
      organizationId: 'org-a',
      actorId: 'identity-a',
      nodeId: 'node-a',
      idempotencyKey: 'node-runtime-start-0001',
      intent: { schemaVersion: 1, expectedDesiredRevision: 7, action: 'start' },
    })
  })

  it('rejects client-selected provider state or action before control dispatch', async () => {
    let calls = 0
    const app = new Hono<{ Bindings: {} }>()
    registerNodeRuntimeLifecycleRoutes(app, {
      runtimeFor: () => runtime,
      authorize: () => Effect.succeed(actor),
      control: () => {
        calls += 1
        return Effect.die('route must reject untrusted runtime fields')
      },
    })

    const response = await app.request(
      'https://api.test/v1/organizations/org-a/nodes/node-a/actions/stop',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'node-runtime-stop-0001',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          expectedDesiredRevision: 7,
          action: 'start',
          providerInstanceId: 'untrusted-provider-instance',
        }),
      },
    )

    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  it('does not advertise unknown runtime actions', async () => {
    const app = new Hono<{ Bindings: {} }>()
    registerNodeRuntimeLifecycleRoutes(app, {
      runtimeFor: () => runtime,
      authorize: () => Effect.succeed(actor),
      control: () => Effect.die('unknown action must not resolve a control'),
    })

    const response = await app.request(
      'https://api.test/v1/organizations/org-a/nodes/node-a/actions/hibernate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'node-runtime-unknown-0001',
        },
        body: JSON.stringify({ schemaVersion: 1, expectedDesiredRevision: 7 }),
      },
    )

    expect(response.status).toBe(404)
  })
})

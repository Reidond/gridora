import { Effect, Layer, Schema } from 'effect'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { OrganizationContext } from '@gridora/domain'
import type { NodeProvisionControlShape } from '@gridora/node-provision-control'
import { registerNodeProvisionRoutes } from '../src/node-provision-routes.js'

const runtime = makeWorkerEffectRuntime(Layer.empty)
const actor = Schema.decodeUnknownSync(OrganizationContext)({
  organizationId: 'org-a',
  organizationSlug: 'org-a',
  identityId: 'identity-a',
  role: 'administrator',
  correlationId: 'corr-a',
})

describe('node provision routes', () => {
  it('accepts intent only and returns the atomic acceptance result', async () => {
    let received: unknown
    const control: NodeProvisionControlShape = {
      submit: (command) => {
        received = command
        return Effect.succeed({
          disposition: 'created',
          nodeId: 'node-a',
          operationId: 'op-a',
          workflowState: 'started',
          billing: {
            providerType: 'ovhcloud',
            currency: 'EUR',
            estimatedMonthlyMinor: 1200,
            billingCadence: 'hourly',
            contractMonths: 1,
            committedMonthlyBeforeMinor: 0,
            projectedCommittedMonthlyMinor: 1200,
            warnings: [],
          },
        })
      },
      submitAccepted: () =>
        Effect.die('public node provision route must not dispatch reviewed input'),
    }
    const app = new Hono<{ Bindings: {} }>()
    registerNodeProvisionRoutes(app, {
      runtimeFor: () => runtime,
      authorize: () => Effect.succeed(actor),
      control: () => Effect.succeed(control),
    })
    const response = await app.request('https://api.test/v1/organizations/org-a/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'node-create-a' },
      body: JSON.stringify({
        schemaVersion: 1,
        placementMode: 'dedicated',
        temporaryLifetimeHours: null,
        nonHourlyCommitmentConfirmed: false,
      }),
    })
    expect(response.status).toBe(202)
    expect(received).toMatchObject({
      organizationId: 'org-a',
      actorId: 'identity-a',
      idempotencyKey: 'node-create-a',
      intent: { placementMode: 'dedicated' },
    })
  })

  it('rejects provider, account, image, and price fields before control dispatch', async () => {
    let calls = 0
    const app = new Hono<{ Bindings: {} }>()
    registerNodeProvisionRoutes(app, {
      runtimeFor: () => runtime,
      authorize: () => Effect.succeed(actor),
      control: () => {
        calls += 1
        return Effect.die('must not dispatch')
      },
    })
    const response = await app.request('https://api.test/v1/organizations/org-a/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'node-create-a' },
      body: JSON.stringify({
        schemaVersion: 1,
        placementMode: 'shared',
        temporaryLifetimeHours: null,
        nonHourlyCommitmentConfirmed: false,
        providerAccountId: 'client-selected',
      }),
    })
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })
})

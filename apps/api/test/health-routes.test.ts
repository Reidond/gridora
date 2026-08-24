import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { OrganizationContext } from '@gridora/domain'
import type { HealthRepositoryShape, HealthSnapshot } from '@gridora/health-control'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { registerHealthRoutes } from '../src/health-routes.js'

type TestEnv = { Bindings: Record<string, never> }

const actor = {
  organizationId: 'org-a',
  organizationSlug: 'night-watch',
  identityId: 'identity-a',
  role: 'viewer',
  correlationId: 'correlation-a',
} as OrganizationContext

const nodeSnapshot: HealthSnapshot = {
  organizationId: 'org-a',
  resourceType: 'node',
  resourceId: 'node-a',
  nodeId: 'node-a',
  serverId: null,
  sampledAt: '2026-08-23T12:00:00.000Z',
  status: 'healthy',
  summary: {
    provider: 'active',
    agentLastSeenAt: '2026-08-23T12:00:00.000Z',
    agentVersion: '1.0.0',
    supportedAgent: true,
    tunnel: 'connected',
    docker: 'healthy',
    firewall: 'ready',
    cpu: { usedMillis: 1, totalMillis: 2 },
    ram: { usedBytes: 1, totalBytes: 2 },
    disk: { usedBytes: 1, totalBytes: 2, availableRatio: 0.5 },
    loadPermille: 1,
    network: { receiveBytes: 1, transmitBytes: 1 },
    containers: [],
    degradationReasons: [],
  },
}

const repository = (): HealthRepositoryShape => ({
  getCurrent: (input) =>
    Effect.succeed(
      input.organizationId === 'org-a' &&
        input.resourceType === 'node' &&
        input.resourceId === 'node-a'
        ? nodeSnapshot
        : null,
    ),
  upsertCurrent: () => Effect.void,
  appendHourly: () => Effect.void,
  listHistory: (input) =>
    Effect.succeed(
      input.organizationId === 'org-a' && input.resourceId === 'node-a' ? [nodeSnapshot] : [],
    ),
  upsertAlert: (alert) => Effect.succeed(alert),
  resolveMissingAlerts: () => Effect.succeed(0),
  listAlerts: (input) =>
    Effect.succeed(
      input.organizationId === 'org-a'
        ? [
            {
              organizationId: 'org-a',
              id: 'alert-node-a-disk-low',
              resourceType: 'node',
              resourceId: 'node-a',
              nodeId: 'node-a',
              serverId: null,
              type: 'disk-low',
              severity: 'warning',
              message: 'Disk headroom is low.',
              fingerprint: 'node:node-a:disk-low',
              state: 'open',
              firstSeenAt: nodeSnapshot.sampledAt,
              lastSeenAt: nodeSnapshot.sampledAt,
              resolvedAt: null,
            },
          ]
        : [],
    ),
})

const makeApp = () => {
  const app = new Hono<TestEnv>()
  const runtime = makeWorkerEffectRuntime(Layer.empty)
  registerHealthRoutes(app, {
    runtimeFor: () => runtime,
    authorize: () => Effect.succeed(actor),
    health: repository,
  })
  return { app, runtime }
}

describe('health HTTP boundary', () => {
  it('accepts either the authorized organization slug or id', async () => {
    const { app, runtime } = makeApp()
    try {
      for (const organization of ['night-watch', 'org-a']) {
        const response = await app.request(`/v1/organizations/${organization}/nodes/node-a/health`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ resourceId: 'node-a', status: 'healthy' })
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('does not disclose a resource through a foreign route scope', async () => {
    const { app, runtime } = makeApp()
    try {
      const response = await app.request('/v1/organizations/org-b/nodes/node-a/health')
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' })
    } finally {
      await runtime.dispose()
    }
  })

  it('bounds history filters and rejects ambiguous query fields', async () => {
    const { app, runtime } = makeApp()
    try {
      const ok = await app.request(
        '/v1/organizations/night-watch/nodes/node-a/health/history?limit=10',
      )
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ items: [{ resourceId: 'node-a' }] })
      const invalid = await app.request(
        '/v1/organizations/night-watch/nodes/node-a/health/history?limit=101&tenant=org-b',
      )
      expect(invalid.status).toBe(400)
    } finally {
      await runtime.dispose()
    }
  })

  it('requires a resource type when an alert resource id is supplied', async () => {
    const { app, runtime } = makeApp()
    try {
      const invalid = await app.request(
        '/v1/organizations/night-watch/health-alerts?resourceId=node-a',
      )
      expect(invalid.status).toBe(400)
      const ok = await app.request(
        '/v1/organizations/night-watch/health-alerts?resourceType=node&resourceId=node-a',
      )
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ items: [{ type: 'disk-low' }] })
    } finally {
      await runtime.dispose()
    }
  })
})

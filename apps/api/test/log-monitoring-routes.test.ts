import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import type { LogArchiveRepositoryShape } from '@gridora/log-control'
import type { LogR2BucketShape } from '@gridora/log-r2'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  cloudflareSourceIp,
  readBoundedJson,
  registerLogMonitoringRoutes,
  type LogMonitoringPrincipal,
} from '../src/log-monitoring-routes.js'

type TestEnv = { Bindings: Record<string, never> }

const actor = {
  organizationId: 'org-a',
  organizationSlug: 'night-watch',
  identityId: 'identity-a',
  role: 'viewer',
  correlationId: 'correlation-a',
  membershipRevision: 3,
  membershipAuthorizationGeneration: 5,
} as LogMonitoringPrincipal

const logs: LogArchiveRepositoryShape = {
  record: (metadata) => Effect.succeed(metadata),
  get: () => Effect.succeed(null),
  list: () => Effect.succeed({ items: [] }),
  expire: () => Effect.succeed(0),
  advanceWatermark: () => Effect.succeed({ accepted: true, replayed: false }),
}

const bucket: LogR2BucketShape = {
  head: () => Promise.resolve(null),
  get: () => Promise.resolve(null),
  put: () => Promise.reject(new Error('not used')),
  delete: () => Promise.resolve(),
}

const makeApp = (
  options: {
    readonly serverAvailable?: boolean
    readonly streamFailure?: boolean
  } = {},
) => {
  const app = new Hono<TestEnv>()
  const runtime = makeWorkerEffectRuntime(Layer.empty)
  let ticketIssues = 0
  let serverChecks = 0
  let telemetryIngestions = 0
  let telemetrySource: unknown
  registerLogMonitoringRoutes<TestEnv, never>(app, {
    runtimeFor: () => runtime,
    authorize: () => Effect.succeed(actor),
    logs: () => logs,
    logArchiveBucket: () => bucket,
    liveTicket: () => ({
      issue: () => {
        ticketIssues += 1
        return Effect.succeed({
          ticket: 'header.signature',
          expiresAt: Date.now() + 60_000,
          organizationId: 'org-a',
          streamEpoch: 'deployment-a',
        })
      },
    }),
    liveStreamScope: () => {
      serverChecks += 1
      return Effect.succeed(
        options.serverAvailable === false
          ? null
          : {
              deploymentId: 'deployment-a',
              streamEpoch: 'deployment-a',
              organizationAuthorizationGeneration: 2,
            },
      )
    },
    cursorSecret: () => 'a'.repeat(32),
    agentAuthorize: () =>
      Effect.succeed({
        organizationId: 'org-a',
        nodeId: 'node-a',
        credentialId: 'credential-a',
        version: 1,
        sessionVersion: 1,
      }),
    agentIngest: () => ({
      ingest: (_principal, _payload, source) => {
        telemetryIngestions += 1
        telemetrySource = source
        return Effect.succeed({
          organizationId: 'org-a',
          nodeId: 'node-a',
          acceptedAt: '2026-08-23T12:00:00.000Z',
          replayed: false,
        })
      },
    }),
    ...(options.streamFailure === true
      ? {
          liveTicketVerifier: () => ({
            verify: () =>
              Effect.succeed({
                organizationId: 'org-a',
                serverId: 'server-a',
                streamEpoch: 'deployment-a',
                principalId: 'identity-a',
                membershipRevision: 3,
                membershipAuthorizationGeneration: 5,
                organizationAuthorizationGeneration: 2,
                nonce: '00000000-0000-4000-8000-000000000001',
                expiresAt: Date.now() + 60_000,
              }),
            consume: () => Effect.void,
          }),
          logStream: () => ({
            open: () => Promise.reject(new Error('stream unavailable')),
          }),
        }
      : {}),
  })
  return {
    app,
    runtime,
    counters: {
      ticketIssues: () => ticketIssues,
      serverChecks: () => serverChecks,
      telemetryIngestions: () => telemetryIngestions,
      telemetrySource: () => telemetrySource,
    },
  }
}

describe('log monitoring request boundary', () => {
  it('captures only a semantic Cloudflare edge IP and ignores spoofed/local header values', async () => {
    const app = new Hono()
    app.get('/source', (context) => new Response(cloudflareSourceIp(context) ?? 'unavailable'))
    const edgeRequest = new Request('https://gridora.test/source', {
      headers: { 'cf-connecting-ip': '2001:db8::1' },
    })
    Object.defineProperty(edgeRequest, 'cf', { value: { colo: 'TEST' } })
    expect(await (await app.fetch(edgeRequest)).text()).toBe('2001:db8::1')

    const localSpoof = new Request('https://gridora.test/source', {
      headers: { 'cf-connecting-ip': '2001:db8::1' },
    })
    expect(await (await app.fetch(localSpoof)).text()).toBe('unavailable')
    const malformedEdge = new Request('https://gridora.test/source', {
      headers: { 'cf-connecting-ip': 'de:ad:be:ef' },
    })
    Object.defineProperty(malformedEdge, 'cf', { value: { colo: 'TEST' } })
    expect(await (await app.fetch(malformedEdge)).text()).toBe('unavailable')
  })

  it('rejects a chunked body over the cap before buffering it', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"health":'))
        controller.enqueue(new Uint8Array(32))
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request('https://gridora.test/v1/agent/telemetry', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)
    await expect(Effect.runPromise(readBoundedJson(request, 16))).rejects.toThrow(
      'request body exceeds the telemetry limit',
    )
    expect(cancelled).toBe(true)
  })

  it('accepts the authorized organization slug and id for archive reads', async () => {
    const { app, runtime } = makeApp()
    try {
      for (const organization of ['night-watch', 'org-a']) {
        const response = await app.request(
          `/v1/organizations/${organization}/game-servers/server-a/logs`,
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ items: [] })
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects a route organization outside the authorized context', async () => {
    const { app, runtime } = makeApp()
    try {
      const response = await app.request('/v1/organizations/org-b/game-servers/server-a/logs')
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' })
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects unknown and repeated archive query fields', async () => {
    const { app, runtime } = makeApp()
    try {
      for (const query of ['?unknown=value', '?limit=1&limit=2', '?from=x&from=y']) {
        const response = await app.request(
          `/v1/organizations/org-a/game-servers/server-a/logs${query}`,
        )
        expect(response.status).toBe(400)
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('checks the current server scope before issuing a live stream ticket', async () => {
    const { app, runtime, counters } = makeApp({ serverAvailable: false })
    try {
      const response = await app.request(
        '/v1/organizations/org-a/game-servers/synthetic-server/logs/stream/ticket',
        { method: 'POST' },
      )
      expect(response.status).toBe(400)
      expect(counters.serverChecks()).toBe(1)
      expect(counters.ticketIssues()).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('maps malformed and chunked oversize telemetry bodies to a stable client failure', async () => {
    const { app, runtime, counters } = makeApp()
    try {
      const malformed = await app.request('/v1/agent/telemetry', {
        method: 'POST',
        body: '{',
      })
      expect(malformed.status).toBe(400)

      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
        },
        cancel() {
          cancelled = true
        },
      })
      const oversize = await app.request(
        new Request('https://gridora.test/v1/agent/telemetry', {
          method: 'POST',
          body: stream,
          duplex: 'half',
        } as RequestInit),
      )
      expect(oversize.status).toBe(400)
      expect(cancelled).toBe(true)
      expect(counters.telemetryIngestions()).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('passes actual machine request provenance to telemetry and never trusts a local spoofed edge IP', async () => {
    const body = JSON.stringify({
      health: {
        apiVersion: 'agent.telemetry.gridora.dev/v1alpha1',
        organizationId: 'org-a',
        nodeId: 'node-a',
        sampledAt: '2026-08-23T12:00:00.000Z',
        agentVersion: '1.0.0',
        tunnel: 'connected',
        docker: 'healthy',
        firewall: 'ready',
        cpuUsedMillis: 1,
        cpuTotalMillis: 2,
        ramUsedBytes: 1,
        ramTotalBytes: 2,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        loadPermille: 1,
        networkReceiveBytes: 1,
        networkTransmitBytes: 1,
        containers: [],
      },
    })
    const { app, runtime, counters } = makeApp()
    try {
      const edge = new Request('https://gridora.test/v1/agent/telemetry', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.7',
          'x-request-id': 'request-telemetry-edge',
          'x-correlation-id': 'correlation-telemetry-edge',
        },
        body,
      })
      Object.defineProperty(edge, 'cf', { value: { colo: 'TEST' } })
      expect((await app.request(edge)).status).toBe(200)
      expect(counters.telemetrySource()).toMatchObject({
        request: {
          origin: 'machine',
          requestId: 'request-telemetry-edge',
          correlationId: 'correlation-telemetry-edge',
          source: {
            ip: { state: 'captured', value: '203.0.113.7' },
            access: { state: 'not-available', reason: 'machine-bearer-credential' },
          },
        },
        requestSignal: expect.any(AbortSignal),
      })

      const local = new Request('https://gridora.test/v1/agent/telemetry', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.7',
          'x-request-id': 'request-telemetry-local',
        },
        body,
      })
      expect((await app.request(local)).status).toBe(200)
      expect(counters.telemetrySource()).toMatchObject({
        request: {
          origin: 'machine',
          requestId: 'request-telemetry-local',
          correlationId: 'request-telemetry-local',
          source: {
            ip: { state: 'not-available', reason: 'cloudflare-source-ip-not-available' },
            access: { state: 'not-available', reason: 'machine-bearer-credential' },
          },
        },
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('returns 503 when the live stream object cannot open the socket', async () => {
    const { app, runtime } = makeApp({ streamFailure: true })
    try {
      const response = await app.request(
        '/v1/organizations/org-a/game-servers/server-a/logs/stream?ticket=header.signature',
        { headers: { upgrade: 'websocket' } },
      )
      expect(response.status).toBe(503)
    } finally {
      await runtime.dispose()
    }
  })
})

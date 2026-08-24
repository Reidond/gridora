import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import {
  makeDurableLogSpool,
  prepareAgentHealthSample,
  prepareAgentTelemetryPayload,
  FetchAgentTelemetryTransport,
  type AgentHealthSample,
  type DurableLogSpoolStorage,
} from '../src/index.js'
import type { LogBatch } from '@gridora/log-control'

const health = (overrides: Partial<AgentHealthSample> = {}): AgentHealthSample => ({
  apiVersion: 'agent.telemetry.gridora.dev/v1alpha1',
  organizationId: 'org-a',
  nodeId: 'node-a',
  sampledAt: new Date().toISOString(),
  agentVersion: '1.0.0',
  tunnel: 'connected',
  docker: 'healthy',
  firewall: 'ready',
  cpuUsedMillis: 100,
  cpuTotalMillis: 4000,
  ramUsedBytes: 100,
  ramTotalBytes: 4000,
  diskUsedBytes: 100,
  diskTotalBytes: 4000,
  loadPermille: 100,
  networkReceiveBytes: 1,
  networkTransmitBytes: 2,
  containers: [],
  ...overrides,
})
const log = (sequence: number) => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  serverId: 'server-a',
  component: 'game' as const,
  level: 'info' as const,
  timestamp: new Date(Date.now() + sequence).toISOString(),
  sequence,
  message: `line ${sequence}`,
})

describe('agent telemetry publication', () => {
  it('rejects future samples and excludes provider/control-plane truth from machine health', async () => {
    await expect(
      Effect.runPromise(
        prepareAgentHealthSample({
          ...health(),
          sampledAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    const sample = health()
    expect(sample).not.toHaveProperty('provider')
    expect(sample).not.toHaveProperty('backupStale')
    expect(sample).not.toHaveProperty('currentOperation')
    await expect(
      Effect.runPromise(
        prepareAgentTelemetryPayload({ health: { ...sample, provider: 'must-not-be-accepted' } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('publishes only to an exact HTTPS host and validates the receipt scope', async () => {
    const sample = health()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            organizationId: 'org-a',
            nodeId: 'node-a',
            acceptedAt: sample.sampledAt,
            replayed: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const transport = FetchAgentTelemetryTransport(
      'https://api.gridora.test/control',
      'api.gridora.test',
    )
    await expect(
      Effect.runPromise(transport.publish('machine-canary', { health: sample })),
    ).resolves.toMatchObject({ organizationId: 'org-a', nodeId: 'node-a' })
    const request = fetchMock.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('https://api.gridora.test/v1/agent/telemetry')
    expect(request.headers.get('authorization')).toBe('Bearer machine-canary')
    expect(await request.clone().text()).not.toContain('machine-canary')
    const logs: LogBatch = {
      organizationId: 'org-a',
      nodeId: 'node-a',
      entries: [{ ...log(1), message: 'Bearer log-secret', fields: { token: 'log-token' } }],
      firstSequence: 1,
      lastSequence: 1,
      uncompressedBytes: 1,
    }
    await Effect.runPromise(transport.publish('machine-canary', { health: sample, logs }))
    const secondCall = fetchMock.mock.calls[1]
    expect(secondCall).toBeDefined()
    const payload = JSON.parse(await (secondCall![0] as Request).clone().text()) as {
      logs: { entries: ReadonlyArray<{ message: string; fields?: Record<string, unknown> }> }
    }
    expect(payload.logs.entries[0]?.message).toBe('Bearer [REDACTED]')
    expect(payload.logs.entries[0]?.fields).toEqual({ token: '[REDACTED]' })
    expect(() =>
      FetchAgentTelemetryTransport('http://api.gridora.test', 'api.gridora.test'),
    ).toThrow()
  })

  it('keeps durable spool data until an explicit contiguous acknowledgement', async () => {
    let stored: ReadonlyArray<unknown> = []
    const storage: DurableLogSpoolStorage = {
      transact: (operation) =>
        Effect.gen(function* () {
          const transition = yield* operation(stored)
          stored = transition.entries
          return transition.result
        }),
    }
    const spool = makeDurableLogSpool(storage)
    await Effect.runPromise(spool.append(log(1)))
    await Effect.runPromise(spool.append(log(2)))
    await expect(Effect.runPromise(spool.peek(2))).resolves.toHaveLength(2)
    await Effect.runPromise(spool.acknowledgeThrough(1))
    await expect(Effect.runPromise(spool.peek(2))).resolves.toHaveLength(1)
    await expect(Effect.runPromise(spool.append(log(4)))).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await Effect.runPromise(spool.acknowledgeThrough(2))
    await expect(Effect.runPromise(spool.size)).resolves.toBe(0)
  })

  it('serializes concurrent append and ack transactions and redacts before persistence', async () => {
    let stored: ReadonlyArray<unknown> = []
    const storage: DurableLogSpoolStorage = {
      transact: (operation) =>
        Effect.gen(function* () {
          const transition = yield* operation(stored)
          stored = transition.entries
          return transition.result
        }),
    }
    const spool = makeDurableLogSpool(storage)
    await Effect.runPromise(
      spool.append({
        ...log(1),
        message: 'Bearer do-not-persist',
        fields: { token: 'canary-secret' },
      }),
    )
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Bearer [REDACTED]', fields: { token: '[REDACTED]' } }),
      ]),
    )
    await Effect.runPromise(spool.append(log(2)))
    const append = Effect.runPromise(spool.append(log(3)))
    await Promise.resolve()
    const acknowledge = Effect.runPromise(spool.acknowledgeThrough(1))
    await Promise.all([append, acknowledge])
    await expect(Effect.runPromise(spool.peek(10))).resolves.toHaveLength(2)
    expect((await Effect.runPromise(spool.peek(10))).map((entry) => entry.sequence)).toEqual([2, 3])
  })
})

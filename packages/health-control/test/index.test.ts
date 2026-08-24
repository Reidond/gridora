import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  deriveHealthAlerts,
  evaluateHealth,
  evaluateNodeHealth,
  type NodeHealthInput,
  type ServerHealthInput,
} from '../src/index.js'

const node = (overrides: Partial<NodeHealthInput> = {}): NodeHealthInput => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  sampledAt: '2026-08-23T12:00:00.000Z',
  provider: { state: 'active' },
  agentLastSeenAt: '2026-08-23T11:59:30.000Z',
  agentVersion: '1.0.0',
  supportedAgent: true,
  tunnel: 'connected',
  docker: 'healthy',
  firewall: 'ready',
  cpuUsedMillis: 1000,
  cpuTotalMillis: 4000,
  ramUsedBytes: 1000,
  ramTotalBytes: 4000,
  diskUsedBytes: 1000,
  diskTotalBytes: 4000,
  loadPermille: 100,
  networkReceiveBytes: 10,
  networkTransmitBytes: 20,
  containers: [],
  ...overrides,
})
const server = (overrides: Partial<ServerHealthInput> = {}): ServerHealthInput => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  serverId: 'server-a',
  deploymentId: 'deployment-a',
  sampledAt: '2026-08-23T12:00:00.000Z',
  container: {
    id: 'container-a',
    name: 'game',
    state: 'running',
    health: 'healthy',
    restartCount: 0,
    cpuUsedMillis: 100,
    memoryUsedBytes: 100,
  },
  game: { process: 'running', query: 'healthy', mods: 'healthy', playerCount: 1 },
  lastSuccessfulBackupAt: '2026-08-23T11:00:00.000Z',
  backupStale: false,
  currentOperation: null,
  operationFailed: false,
  ...overrides,
})

describe('health aggregation and alerts', () => {
  it('marks a stale agent unhealthy and emits only bounded actionable alerts', async () => {
    const snapshot = await Effect.runPromise(
      evaluateNodeHealth(
        node({
          agentLastSeenAt: '2026-08-23T11:58:00.000Z',
          tunnel: 'offline',
          diskUsedBytes: 3900,
        }),
        Date.parse('2026-08-23T12:00:00.000Z'),
      ),
    )
    expect(snapshot.status).toBe('unhealthy')
    expect(snapshot.summary.degradationReasons).toEqual(
      expect.arrayContaining(['agent_offline', 'tunnel_offline', 'disk_low']),
    )
    expect(deriveHealthAlerts(snapshot).map((alert) => alert.type)).toEqual(
      expect.arrayContaining(['node-offline', 'tunnel-offline', 'disk-low']),
    )
  })

  it('does not treat a running container as healthy when game query is unhealthy', async () => {
    const result = await Effect.runPromise(
      evaluateHealth(
        node(),
        server({ game: { process: 'running', query: 'unhealthy', mods: 'healthy' } }),
      ),
    )
    expect(result.server?.status).toBe('unhealthy')
    expect(result.server?.summary.degradationReasons).toContain('game_query_unhealthy')
    expect(result.alerts.some((alert) => alert.type === 'game-unhealthy')).toBe(true)
  })

  it('rejects foreign server/node scope before deriving health', async () => {
    await expect(
      Effect.runPromise(evaluateHealth(node(), server({ organizationId: 'org-b' }))),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      Effect.runPromise(evaluateHealth(node(), server({ nodeId: 'node-b' }))),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('reports provider cancellation and unsupported agent as separate conditions', async () => {
    const result = await Effect.runPromise(
      evaluateHealth(
        node({ provider: { state: 'cancelling' }, supportedAgent: false }),
        undefined,
        Date.parse('2026-08-23T12:00:00.000Z'),
      ),
    )
    expect(result.node.status).toBe('degraded')
    expect(result.alerts.map((alert) => alert.type)).toEqual(
      expect.arrayContaining(['provider-cancellation-pending', 'agent-unsupported']),
    )
  })
})

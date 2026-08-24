import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { schedule, type ReservationStoreShape, type SchedulerNode } from './index.js'
const node = (organizationId: string): SchedulerNode => ({
  id: organizationId,
  organizationId,
  provider: 'ovh',
  region: 'eu',
  architecture: 'amd64',
  allocatable: { cpu: 4, memoryMiB: 8192, diskGiB: 100 },
  reserved: { cpu: 0, memoryMiB: 0, diskGiB: 0 },
  drain: false,
  labels: {},
  portLeases: [],
  deploymentIds: [],
  cachedSteamAppIds: [1874900],
  estimatedMarginalCost: 0,
  agentVersion: '1',
  pluginVersions: { 'arma-reforger': '0.1.0' },
})
const store: ReservationStoreShape = {
  reserve: (i) =>
    Effect.succeed({
      nodeId: i.nodeId,
      capacity: i.capacity,
      ports: i.ports,
      reservationId: i.operationId,
    }),
  release: () => Effect.void,
}
describe('scheduler', () => {
  it('never crosses organization boundaries', async () => {
    const result = await Effect.runPromise(
      schedule(
        {
          organizationId: 'a',
          deploymentId: 'd',
          operationId: 'op',
          mode: 'shared',
          resources: { cpu: 1, memoryMiB: 1024, diskGiB: 10 },
          ports: [{ protocol: 'udp', preferredPort: 2001, name: 'game' }],
          architecture: 'amd64',
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
        },
        [node('b'), node('a')],
        store,
        false,
      ),
    )
    expect(result.kind).toBe('existing')
    if (result.kind === 'existing') expect(result.reservation.nodeId).toBe('a')
  })
  it('requests provisioning when no node fits', async () => {
    const result = await Effect.runPromise(
      schedule(
        {
          organizationId: 'a',
          deploymentId: 'd',
          operationId: 'op',
          mode: 'auto',
          resources: { cpu: 99, memoryMiB: 1, diskGiB: 1 },
          ports: [],
          architecture: 'amd64',
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
        },
        [node('a')],
        store,
        true,
      ),
    )
    expect(result.kind).toBe('provision')
  })
  it('hard-rejects anti-affinity collisions and non-empty dedicated nodes', async () => {
    const occupied = {
      ...node('a'),
      deploymentIds: ['avoid-me'],
      reserved: { cpu: 0, memoryMiB: 1, diskGiB: 0 },
    }
    const result = await Effect.runPromise(
      schedule(
        {
          organizationId: 'a',
          deploymentId: 'd',
          operationId: 'op',
          mode: 'dedicated',
          resources: { cpu: 1, memoryMiB: 1, diskGiB: 1 },
          ports: [],
          architecture: 'amd64',
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          antiAffinityDeploymentIds: ['avoid-me'],
        },
        [occupied],
        store,
        true,
      ),
    )
    expect(result.kind).toBe('provision')
    expect(result.candidates[0]?.reasons).toEqual(
      expect.arrayContaining([
        'anti-affinity deployment is present',
        'dedicated placement requires empty node',
      ]),
    )
  })
})

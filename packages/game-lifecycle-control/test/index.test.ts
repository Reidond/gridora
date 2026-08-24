import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import {
  decodeGameCreateIntent,
  planGameServer,
  type GameCreateIntent,
  type GameNodeFact,
} from '../src/index.js'

const intent = (overrides: Partial<GameCreateIntent> = {}): GameCreateIntent => ({
  schemaVersion: 1,
  name: 'Frontline',
  pluginId: 'arma-reforger',
  placement: { mode: 'shared' },
  config: {
    name: 'Frontline',
    scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
    maxPlayers: 32,
    visible: true,
    crossPlatform: true,
  },
  mods: [],
  ...overrides,
})

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input

const node = (overrides: Partial<GameNodeFact> = {}): GameNodeFact => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  placementMode: 'shared',
  provider: 'ovhcloud',
  region: 'eu-west',
  plan: 'small',
  architecture: 'amd64',
  ready: true,
  policyRevision: 1,
  nodeDesiredRevision: 1,
  capacityRevision: 1,
  allocationRevision: 1,
  catalogRefreshedAt: '2026-08-23T12:00:00.000Z',
  capacity: { cpu: 8, memoryMiB: 16_384, diskGiB: 200 },
  reserved: { cpu: 0, memoryMiB: 0, diskGiB: 0 },
  livePorts: [],
  ...overrides,
})

const catalog = [
  {
    pluginId: 'arma-reforger',
    activeVersion: '0.1.0',
    selectionRevision: 1,
    image: {
      installer: `sha256:${'a'.repeat(64)}`,
      runtime: `sha256:${'b'.repeat(64)}`,
    },
  },
] as const

const armaMetadata = (id: string, dependencies: readonly string[] = []) =>
  Response.json({
    status: 'success',
    mod: {
      id,
      version: '1.2.3',
      private: false,
      workshopUrl: `https://reforger.armaplatform.com/workshop/${id}-fixture`,
      dependencies: dependencies.map((dependency) => ({
        id: dependency,
        version: '1.2.3',
        private: false,
        published: true,
      })),
    },
  })

describe('game lifecycle control', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('does not accept client-selected image fields', async () => {
    await expect(
      Effect.runPromise(
        decodeGameCreateIntent({
          ...intent(),
          runtimeImage: `sha256:${'c'.repeat(64)}`,
          installerImage: `sha256:${'d'.repeat(64)}`,
        }),
      ),
    ).rejects.toBeDefined()
  })

  it('cannot place an organization A request on organization B capacity', async () => {
    await expect(
      Effect.runPromise(
        planGameServer('org-a', intent(), [node({ organizationId: 'org-b' })], catalog),
      ),
    ).rejects.toMatchObject({ _tag: 'GamePlacementError' })
  })

  it('requires an authoritative dedicated reservation', async () => {
    await expect(
      Effect.runPromise(
        planGameServer(
          'org-a',
          intent({ placement: { mode: 'dedicated' } }),
          [node({ placementMode: 'dedicated' })],
          catalog,
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'GamePlacementError' })
    const planned = await Effect.runPromise(
      planGameServer(
        'org-a',
        intent({ placement: { mode: 'dedicated' } }),
        [node({ placementMode: 'dedicated', dedicatedReservationId: 'reservation-a' })],
        catalog,
      ),
    )
    expect(planned.nodeId).toBe('node-a')
  })

  it('allocates exact free TCP/UDP ports from the authoritative node view', async () => {
    const planned = await Effect.runPromise(
      planGameServer(
        'org-a',
        intent(),
        [
          node({
            livePorts: [{ protocol: 'udp', publicPort: 20_000 }],
            portRange: { start: 20_000, end: 20_005 },
          }),
        ],
        catalog,
      ),
    )
    expect(planned.ports.map((port) => `${port.protocol}:${port.publicPort}`)).toEqual([
      'udp:20001',
      'udp:20002',
    ])
    expect(planned.ports.every((port) => port.publicPort !== 20_000)).toBe(true)
  })

  it('rejects malformed DNS intent and credential references for anonymous Steam', async () => {
    await expect(
      Effect.runPromise(
        planGameServer('org-a', intent({ domain: 'Bad Domain' }), [node()], catalog),
      ),
    ).rejects.toMatchObject({ _tag: 'GameLifecycleValidationError' })
    await expect(
      Effect.runPromise(
        planGameServer('org-a', intent({ steamCredentialRef: 'steam-secret' }), [node()], catalog),
      ),
    ).rejects.toMatchObject({ _tag: 'GameLifecycleValidationError' })
  })

  it('uses the plugin-owned live metadata resolver at create acceptance and carries verified dependencies to the signed plan', async () => {
    const root = '5A54BB9103829754'
    const framework = '5965550F24A0C152'
    const core = '65F551D028D59363'
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input))
      const id = requestUrl(input).split('/').at(-1)
      if (id === root) return armaMetadata(root, [framework])
      if (id === framework) return armaMetadata(framework, [core])
      if (id === core) return armaMetadata(core)
      return new Response(null, { status: 404 })
    })

    const planned = await Effect.runPromise(
      planGameServer(
        'org-a',
        intent({
          mods: [
            {
              source: 'reforger.armaplatform.com',
              id: root.toLowerCase(),
              loadOrder: 10,
            },
          ],
        }),
        [node()],
        catalog,
      ),
    )

    expect(urls).toEqual([
      `https://api.reforgermods.net/v2/mods/${root}`,
      `https://api.reforgermods.net/v2/mods/${framework}`,
      `https://api.reforgermods.net/v2/mods/${core}`,
    ])
    expect(planned.mods).toEqual([
      { source: 'reforger.armaplatform.com', id: core, loadOrder: 0, requestedVersion: '1.2.3' },
      {
        source: 'reforger.armaplatform.com',
        id: framework,
        loadOrder: 0,
        requestedVersion: '1.2.3',
      },
      { source: 'reforger.armaplatform.com', id: root, loadOrder: 10, requestedVersion: '1.2.3' },
    ])
    expect(planned.controlPlan.modMetadata?.state).toBe('resolved')
    expect(planned.controlPlan.modMetadata?.provenance[0]).toMatchObject({
      endpoint: `https://api.reforgermods.net/v2/mods/${root}`,
    })
  })
})

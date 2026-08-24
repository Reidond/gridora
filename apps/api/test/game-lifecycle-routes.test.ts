import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { OrganizationContext, type OrganizationRole } from '@gridora/domain'
import {
  type GameDeploymentPlan,
  type GameLifecycleOperation,
  type GameLifecycleRepository,
  type GameNodeFact,
  type GamePluginCatalogEntry,
} from '@gridora/game-lifecycle-control'
import { GameLifecycleD1Error } from '@gridora/game-lifecycle-d1'
import type {
  GameLifecyclePlanningD1Repository,
  GameLifecycleWorkflowData,
} from '@gridora/game-lifecycle-d1'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  makeAuthoritativeGameWorkflowPayload,
  matchesAcceptedGameWorkflowPayload,
  registerGameLifecycleRoutes,
  type GameLifecycleRouteDependencies,
} from '../src/game-lifecycle-routes.js'

type TestEnv = { Bindings: Record<string, never> }

const now = '2026-08-23T12:00:00.000Z'
const image: GamePluginCatalogEntry['image'] = {
  installer: `sha256:${'a'.repeat(64)}`,
  runtime: `sha256:${'b'.repeat(64)}`,
}
const catalog: readonly GamePluginCatalogEntry[] = [
  { pluginId: 'arma-reforger', activeVersion: '0.1.0', selectionRevision: 1, image },
]
const node: GameNodeFact = {
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
  catalogRefreshedAt: now,
  capacity: { cpu: 16, memoryMiB: 65_536, diskGiB: 500 },
  reserved: { cpu: 0, memoryMiB: 0, diskGiB: 0 },
  livePorts: [],
  portRange: { start: 20_000, end: 60_000 },
}

const actor = (role: OrganizationRole = 'operator') =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId: 'org-a',
    organizationSlug: 'organization-a',
    identityId: 'identity-a',
    role,
    correlationId: 'correlation-a',
  })

const operation = (
  action: GameLifecycleOperation['action'],
  state: GameLifecycleOperation['state'] = 'queued',
): GameLifecycleOperation => ({
  organizationId: 'org-a',
  actorId: 'identity-a',
  operationId: `operation-${action}`,
  serverId: 'server-a',
  action,
  expectedRevision: action === 'create' ? 0 : 1,
  fingerprint: 'f'.repeat(64),
  state,
})

const plan: GameDeploymentPlan = {
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  nodeId: 'node-a',
  placementMode: 'shared',
  resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
  ports: [
    { protocol: 'udp', containerPort: 2001, publicPort: 20_001, purpose: 'game' },
    { protocol: 'udp', containerPort: 17777, publicPort: 20_002, purpose: 'query' },
  ],
  image,
  loginMode: 'anonymous',
  config: {
    name: 'Frontline',
    scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
    maxPlayers: 32,
    visible: true,
    crossPlatform: true,
  },
  mods: [],
  controlPlan: {} as GameDeploymentPlan['controlPlan'],
  policyRevision: 1,
  pluginSelectionRevision: 1,
  nodeDesiredRevision: 1,
  capacityRevision: 1,
  allocationRevision: 1,
  catalogRefreshedAt: now,
}

const workflowData = (action: GameLifecycleOperation['action']): GameLifecycleWorkflowData => ({
  organizationId: 'org-a',
  actorId: 'identity-a',
  correlationId: 'correlation-a',
  idempotencyKey: `idem-${action}`,
  operationId: `operation-${action}`,
  serverId: 'server-a',
  action,
  expectedPriorRevision: action === 'create' ? 0 : 1,
  createdAt: now,
  workflowState: 'pending',
  nodeId: 'node-a',
  deploymentId: 'deployment-a',
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  ports: plan.ports,
  resources: plan.resources,
  config: plan.config,
  mods: [],
  configRevision: 1,
  modRevision: 0,
})

const createIntent = {
  schemaVersion: 1,
  name: 'Frontline',
  pluginId: 'arma-reforger',
  placement: { mode: 'shared' },
  config: plan.config,
  mods: [],
} as const

const mutationBody = (action: Exclude<GameLifecycleOperation['action'], 'create'>) => {
  switch (action) {
    case 'start':
    case 'stop':
    case 'restart':
      return { expectedRevision: 1, action }
    case 'update':
      return {
        expectedRevision: 1,
        action,
        expectedConfigRevision: 1,
        expectedModRevision: 0,
        backupBeforeUpdate: true,
      }
    case 'apply-config':
      return {
        expectedRevision: 1,
        action,
        expectedConfigRevision: 1,
        config: plan.config,
      }
    case 'sync-mods':
      return {
        expectedRevision: 1,
        action,
        expectedConfigRevision: 1,
        expectedModRevision: 0,
        mods: [],
      }
    case 'delete':
      return { expectedRevision: 1, action, backupPolicy: 'skip-authorized' }
  }
}

const responseText = async (response: Response) =>
  JSON.parse(await response.text()) as Record<string, unknown>

const makeHarness = (role: OrganizationRole = 'operator') => {
  let acceptedAction: GameLifecycleOperation['action'] = 'create'
  let existingWorkflow = false
  let replayAccepted = false
  let createThrows = false
  let getThrows = true
  let operationState: GameLifecycleOperation['state'] = 'queued'
  const calls = {
    create: 0,
    get: 0,
    mark: 0,
    planningFacts: 0,
    createInput: undefined as unknown,
    repositoryCreateInput: undefined as unknown,
    repositoryMutationInput: undefined as unknown,
  }
  const accepted = () => ({
    disposition: existingWorkflow ? ('adopted' as const) : ('created' as const),
    operation: operation(acceptedAction, operationState),
    workflowState: existingWorkflow ? ('started' as const) : ('pending-reconciliation' as const),
  })
  const repository: GameLifecycleRepository = {
    findIdempotent: () => Effect.succeed(replayAccepted ? accepted() : null),
    create: (input) => {
      acceptedAction = 'create'
      calls.repositoryCreateInput = input
      calls.createInput = input
      return Effect.succeed(accepted())
    },
    mutate: (input) => {
      acceptedAction = input.intent.action
      calls.repositoryMutationInput = input
      return Effect.succeed(accepted())
    },
  }
  const planning: GameLifecyclePlanningD1Repository = {
    readPlanningFacts: () => {
      calls.planningFacts += 1
      return replayAccepted
        ? Effect.fail(
            new GameLifecycleD1Error({
              operation: 'test.planning',
              message: 'planning facts intentionally unavailable on replay',
            }),
          )
        : Effect.succeed({ nodes: [node], catalog })
    },
    readWorkflowData: (_organizationId, _operationId) =>
      Effect.succeed(workflowData(acceptedAction)),
    markWorkflowStarted: () => {
      calls.mark += 1
      return Effect.succeed(undefined)
    },
  }
  const binding = {
    create: async (input: { id: string; params: unknown }) => {
      calls.create += 1
      calls.createInput = input.params
      if (createThrows) {
        getThrows = false
        throw new Error('response lost')
      }
      return { id: input.id }
    },
    get: async (id: string) => {
      calls.get += 1
      if (getThrows) throw new Error('not found')
      return { id }
    },
  }
  const runtime = makeWorkerEffectRuntime(Layer.empty)
  const app = new Hono<TestEnv>()
  const dependencies: GameLifecycleRouteDependencies<TestEnv, never> = {
    runtimeFor: () => runtime,
    authorize: (_context: HonoContext<TestEnv>) => Effect.succeed(actor(role)),
    repository: () => Effect.succeed(repository),
    planning: () => Effect.succeed(planning),
    workflow: () => binding,
    auditRequestContext: () => ({
      origin: 'http',
      requestId: 'request-a',
      correlationId: 'correlation-a',
      source: {
        ip: { state: 'captured', value: '203.0.113.10' },
        access: {
          state: 'captured',
          value: {
            subject: 'access-a',
            identityId: 'identity-a',
            issuer: 'https://team.cloudflareaccess.com',
            email: 'a@example.com',
          },
        },
      },
    }),
  }
  registerGameLifecycleRoutes(app, dependencies)
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    headers.set('idempotency-key', 'idempotency-a')
    return app.request(`https://api.gridora.test${path}`, { ...init, headers }, {})
  }
  return {
    app,
    request,
    calls,
    binding,
    set acceptedAction(value: GameLifecycleOperation['action']) {
      acceptedAction = value
    },
    set existingWorkflow(value: boolean) {
      existingWorkflow = value
    },
    set replayAccepted(value: boolean) {
      replayAccepted = value
    },
    set operationState(value: GameLifecycleOperation['state']) {
      operationState = value
    },
    set createThrows(value: boolean) {
      createThrows = value
    },
    set getThrows(value: boolean) {
      getThrows = value
    },
    runtime,
  }
}

describe('public game lifecycle routes', () => {
  afterEach(() => undefined)

  it('creates from tenant facts and starts the exact derived Workflow', async () => {
    const harness = makeHarness()
    const response = await harness.request('/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      body: JSON.stringify(createIntent),
    })
    expect(response.status, await response.clone().text()).toBe(202)
    expect(await responseText(response)).toEqual({
      operationId: 'operation-create',
      resourceId: 'server-a',
      status: 'queued',
      links: { operation: '/v1/organizations/organization-a/operations/operation-create' },
    })
    expect(harness.calls.create).toBe(1)
    expect(harness.calls.mark).toBe(1)
    const input = harness.calls.createInput as { input: Record<string, unknown> }
    expect(input.input).toMatchObject({
      organizationId: 'org-a',
      deploymentId: 'deployment-a',
      image,
    })
    expect(input.input).not.toHaveProperty('runtimeImage')
    expect(harness.calls.repositoryCreateInput).toMatchObject({
      auditRequestContext: {
        origin: 'http',
        requestId: 'request-a',
        correlationId: 'correlation-a',
        source: {
          ip: { state: 'captured', value: '203.0.113.10' },
          access: { state: 'captured', value: { subject: 'access-a', identityId: 'identity-a' } },
        },
      },
      auditActorType: 'human',
    })
  })

  it('rejects client image/deployment selection and tenant or role mismatches', async () => {
    const harness = makeHarness()
    const excess = await harness.request('/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      body: JSON.stringify({ ...createIntent, runtimeImage: image.runtime }),
    })
    expect(excess.status).toBe(400)

    const crossTenant = await harness.request('/v1/organizations/organization-b/game-servers', {
      method: 'POST',
      body: JSON.stringify(createIntent),
    })
    expect(crossTenant.status).toBe(403)

    const viewer = makeHarness('viewer')
    const denied = await viewer.request('/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      body: JSON.stringify(createIntent),
    })
    expect(denied.status).toBe(403)
  })

  it.each(['start', 'stop', 'restart', 'update', 'apply-config', 'sync-mods', 'delete'] as const)(
    'accepts strict %s mutations with an expected desired revision',
    async (action) => {
      const harness = makeHarness(action === 'delete' ? 'administrator' : 'operator')
      const path =
        action === 'apply-config'
          ? '/v1/organizations/organization-a/game-servers/server-a/config'
          : action === 'sync-mods'
            ? '/v1/organizations/organization-a/game-servers/server-a/mods'
            : action === 'delete'
              ? '/v1/organizations/organization-a/game-servers/server-a'
              : `/v1/organizations/organization-a/game-servers/server-a/actions/${action}`
      const method =
        action === 'delete' || action === 'sync-mods'
          ? action === 'delete'
            ? 'DELETE'
            : 'PUT'
          : 'POST'
      const response = await harness.request(path, {
        method,
        body: JSON.stringify(mutationBody(action)),
      })
      expect(response.status, await response.clone().text()).toBe(202)
      expect((await responseText(response)).resourceId).toBe('server-a')
      expect(harness.calls.create).toBe(1)
      expect(harness.calls.mark).toBe(1)
    },
  )

  it('does not claim a Workflow started after response loss and adopts an exact retry', async () => {
    const harness = makeHarness()
    harness.createThrows = true
    const response = await harness.request('/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      body: JSON.stringify(createIntent),
    })
    expect(response.status).toBe(202)
    expect(harness.calls.create).toBe(1)
    expect(harness.calls.get).toBe(2)
    expect(harness.calls.mark).toBe(1)
  })

  it('accepts the product PATCH alias only as the strict logical update action', async () => {
    const harness = makeHarness()
    const response = await harness.request(
      '/v1/organizations/organization-a/game-servers/server-a',
      {
        method: 'PATCH',
        body: JSON.stringify(mutationBody('update')),
      },
    )
    expect(response.status, await response.clone().text()).toBe(202)
    expect(await responseText(response)).toMatchObject({
      operationId: 'operation-update',
      resourceId: 'server-a',
      status: 'queued',
    })
    expect(harness.calls.mark).toBe(1)
  })

  it('returns the persisted operation state on an exact replay', async () => {
    const harness = makeHarness()
    harness.existingWorkflow = true
    harness.operationState = 'succeeded'
    harness.getThrows = false
    const response = await harness.request('/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      body: JSON.stringify(createIntent),
    })
    expect(response.status).toBe(202)
    expect((await responseText(response)).status).toBe('succeeded')
  })

  it('adopts a create replay before reading changed planning facts', async () => {
    const harness = makeHarness()
    harness.replayAccepted = true
    harness.existingWorkflow = true
    harness.operationState = 'succeeded'
    harness.getThrows = false
    const response = await harness.request('/v1/organizations/organization-a/game-servers', {
      method: 'POST',
      body: JSON.stringify(createIntent),
    })
    expect(response.status, await response.clone().text()).toBe(202)
    expect((await responseText(response)).status).toBe('succeeded')
    expect(harness.calls.planningFacts).toBe(0)
    expect(harness.calls.create).toBe(0)
  })

  it('requires the route action and revision fence in every mutation body', async () => {
    const harness = makeHarness()
    const missingRevision = await harness.request(
      '/v1/organizations/organization-a/game-servers/server-a/actions/start',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'start' }),
      },
    )
    expect(missingRevision.status).toBe(400)
    const wrongAction = await harness.request(
      '/v1/organizations/organization-a/game-servers/server-a/actions/start',
      {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: 1, action: 'stop' }),
      },
    )
    expect(wrongAction.status).toBe(400)
  })

  it('keeps accepted source coordinates immutable while ignoring move progress evidence', async () => {
    const accepted = await Effect.runPromise(
      makeAuthoritativeGameWorkflowPayload(
        {
          ...workflowData('move'),
          operationId: 'operation-move',
          nodeId: 'node-source',
          targetNodeId: 'node-target',
          deploymentId: 'deployment-source',
          movePhase: 'reserved',
          moveSourcePreserved: true,
        },
        image,
      ),
    )
    const laterProgress = {
      ...accepted,
      movePhase: 'cutover' as const,
      moveSourcePreserved: true,
      moveBackupId: 'backup-move-a',
    }
    expect(matchesAcceptedGameWorkflowPayload(accepted, laterProgress)).toBe(true)
    expect(
      matchesAcceptedGameWorkflowPayload(accepted, {
        ...laterProgress,
        nodeId: 'node-foreign',
      }),
    ).toBe(false)
    expect(
      matchesAcceptedGameWorkflowPayload(accepted, {
        ...laterProgress,
        targetNodeId: 'node-foreign',
      }),
    ).toBe(false)
    expect(
      matchesAcceptedGameWorkflowPayload(accepted, {
        ...laterProgress,
        deploymentId: 'deployment-foreign',
      }),
    ).toBe(false)
  })
})

import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError } from '@gridora/contracts'
import { OrganizationContext } from '@gridora/domain'
import {
  defaultGameServerManifestPolicies,
  manifestFromDesiredSpec,
  type GameServerDesiredSpec,
  type GameServerManifest,
  type GameServerManifestRepository,
  type GameServerManifestStoredState,
} from '@gridora/game-server-manifest-control'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { registerGameServerManifestRoutes } from '../src/game-server-manifest-routes.js'

type TestEnv = { Bindings: Record<string, never> }

const runtime = makeWorkerEffectRuntime(Layer.empty)
const desired: GameServerDesiredSpec = {
  schemaVersion: 1,
  plugin: { id: 'arma-reforger', version: '1.2.3' },
  placement: { mode: 'shared', nodeId: 'node-a' },
  resources: {
    cpuMillis: 2_000,
    ramBytes: 4 * 1024 * 1024 * 1024,
    diskBytes: 40 * 1024 * 1024 * 1024,
  },
  endpoint: { domain: 'frontline.example.test' },
  updatePolicy: defaultGameServerManifestPolicies.updatePolicy,
  backupPolicy: defaultGameServerManifestPolicies.backupPolicy,
  config: { scenarioId: 'scenario-a' },
  mods: [{ id: 'mod-a', source: 'workshop', requestedVersion: '1.0.0', loadOrder: 0 }],
}
const stored: GameServerManifestStoredState = {
  organizationId: 'org-a',
  serverId: 'server-a',
  name: 'Frontline',
  desiredRevision: 7,
  configRevision: 3,
  modRevision: 4,
  sourceOperationId: 'operation-create-a',
  spec: desired,
}

const exported = (): GameServerManifest =>
  manifestFromDesiredSpec({
    organization: 'organization-a',
    serverId: stored.serverId,
    name: stored.name,
    spec: stored.spec,
  })

let acceptedPolicies = 0
let lastAuditOrigin: string | undefined
let app: Hono<TestEnv>

const authorize = (context: HonoContext<TestEnv>) => {
  const routeOrganization = context.req.param('organization')
  if (routeOrganization !== 'organization-a' && routeOrganization !== 'org-a')
    return Effect.fail(
      new AuthorizationError({
        code: 'membership_required',
        message: 'organization membership is required',
      }),
    )
  return Effect.succeed(
    Schema.decodeUnknownSync(OrganizationContext)({
      organizationId: 'org-a',
      organizationSlug: 'organization-a',
      identityId: 'operator-a',
      role: 'operator',
      correlationId: 'manifest-http-correlation',
      membershipRevision: 3,
    }),
  )
}

const repository: GameServerManifestRepository = {
  readById: (organizationId, serverId) =>
    organizationId === stored.organizationId && serverId === stored.serverId
      ? Effect.succeed(stored)
      : Effect.die('unexpected manifest read'),
  readByName: (organizationId, name) =>
    Effect.succeed(
      organizationId === stored.organizationId && name === stored.name ? stored : null,
    ),
  acceptPolicyUpdate: (command) =>
    Effect.sync(() => {
      acceptedPolicies += 1
      lastAuditOrigin = command.auditRequestContext.origin
      return {
        disposition: 'created' as const,
        operationId: 'manifest-policy-operation-a',
        serverId: command.serverId,
        expectedRevision: command.expectedRevision,
        desiredRevision: command.expectedRevision + 1,
        state: 'succeeded' as const,
      }
    }),
}

const request = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  headers.set('cf-ray', 'request-manifest-route-test')
  return app.request(`https://api.gridora.test${path}`, { ...init, headers }, {})
}

const manifestRequest = (manifest: GameServerManifest, idempotencyKey?: string): RequestInit => ({
  method: 'POST',
  ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
  body: JSON.stringify(manifest),
})

describe('game server manifest routes', () => {
  beforeEach(() => {
    acceptedPolicies = 0
    lastAuditOrigin = undefined
    app = new Hono<TestEnv>()
    registerGameServerManifestRoutes(app, {
      runtimeFor: () => runtime,
      authorize,
      repository: () => Effect.succeed(repository),
      serverPlan: () => Effect.die('create planning is not expected'),
      provisionControl: () => Effect.die('create apply is not expected'),
      lifecycle: () => Effect.die('lifecycle apply is not expected'),
      lifecyclePlanning: () => Effect.die('workflow planning is not expected'),
      lifecycleWorkflow: () => undefined,
      auditRequestContext: () => ({
        origin: 'http',
        requestId: 'request-manifest-route-test',
        correlationId: 'manifest-http-correlation',
        source: {
          ip: { state: 'captured', value: '203.0.113.9' },
          access: {
            state: 'captured',
            value: {
              subject: 'access-a',
              identityId: 'operator-a',
              issuer: 'https://team.cloudflareaccess.com',
              email: 'operator-a@example.test',
            },
          },
        },
      }),
    })
  })

  afterAll(() => runtime.dispose())

  it('exports authoritative desired state and plans the export as a no-op', async () => {
    const base = '/v1/organizations/organization-a'
    const response = await request(`${base}/game-servers/server-a/manifest`)
    expect(response.status, await response.clone().text()).toBe(200)
    const manifest = (await response.json()) as GameServerManifest
    expect(manifest).toEqual(exported())
    expect(JSON.stringify(manifest)).not.toContain('commercialReviewToken')

    const plan = await request(`${base}/game-server-manifests/plan`, manifestRequest(manifest))
    expect(plan.status, await plan.clone().text()).toBe(200)
    await expect(plan.json()).resolves.toEqual({
      kind: 'no-op',
      serverId: 'server-a',
      desiredRevision: 7,
    })
  })

  it('requires tenant scope and an idempotency key before manifest mutation', async () => {
    const foreign = await request(
      '/v1/organizations/organization-b/game-server-manifests/apply',
      manifestRequest(exported(), 'manifest-apply-a'),
    )
    expect(foreign.status).toBe(403)
    const missingKey = await request(
      '/v1/organizations/organization-a/game-server-manifests/apply',
      manifestRequest(exported()),
    )
    expect(missingKey.status).toBe(400)
  })

  it('accepts a policy-only update through the strict audit repository boundary', async () => {
    const current = exported()
    const changed: GameServerManifest = {
      ...current,
      spec: {
        ...current.spec,
        updatePolicy: { mode: 'automatic', backupBeforeUpdate: false },
      },
    }
    const response = await request(
      '/v1/organizations/organization-a/game-server-manifests/apply',
      manifestRequest(changed, 'manifest-policy-a'),
    )
    expect(response.status, await response.clone().text()).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      kind: 'policy-update',
      acceptance: {
        operationId: 'manifest-policy-operation-a',
        expectedRevision: 7,
        desiredRevision: 8,
        state: 'succeeded',
      },
      workflowState: 'not-required',
    })
    expect(acceptedPolicies).toBe(1)
    expect(lastAuditOrigin).toBe('http')
  })

  it('rejects multi-mutation manifests before a lifecycle or policy side effect', async () => {
    const current = exported()
    const changed: GameServerManifest = {
      ...current,
      spec: {
        ...current.spec,
        config: { scenarioId: 'scenario-b' },
        mods: [{ id: 'mod-b', source: 'workshop', loadOrder: 0 }],
      },
    }
    const response = await request(
      '/v1/organizations/organization-a/game-server-manifests/apply',
      manifestRequest(changed, 'manifest-composed-a'),
    )
    expect(response.status).toBe(409)
    expect(acceptedPolicies).toBe(0)
  })
})

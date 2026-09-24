import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError } from '@gridora/contracts'
import { OrganizationContext } from '@gridora/domain'
import {
  defaultGameServerManifestPolicies,
  GameServerManifestIdempotencyConflictError,
  GameServerManifestNameConflictError,
  GameServerManifestNotFoundError,
  GameServerManifestRevisionConflictError,
  GameServerManifestValidationError,
  manifestFromDesiredSpec,
  type GameServerDesiredSpec,
  type GameServerManifest,
  type GameServerManifestRepository,
  type GameServerManifestStoredState,
  type GameServerRenameAcceptance,
  type GameServerRenameCommand,
  type GameServerRenameError,
} from '@gridora/game-server-manifest-control'
import { makeWorkerEffectRuntime, NameConflictProblemCode } from '@gridora/http-hono-effect'
import { openApiDocument, unsupportedApiRoutes } from '../src/contracts.js'
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
let actorRole: 'operator' | 'viewer' = 'operator'
let renameCommands: GameServerRenameCommand[] = []
const renameReceipts = new Map<string, GameServerRenameAcceptance>()
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
      role: actorRole,
      correlationId: 'manifest-http-correlation',
      membershipRevision: 3,
    }),
  )
}

/** A small in-memory stand-in that mirrors the D1 rename fences and receipts. */
const acceptRename = (
  command: GameServerRenameCommand,
): Effect.Effect<GameServerRenameAcceptance, GameServerRenameError> =>
  Effect.suspend((): Effect.Effect<GameServerRenameAcceptance, GameServerRenameError> => {
    renameCommands.push(command)
    const receipt = renameReceipts.get(command.idempotencyKey)
    if (receipt !== undefined)
      return receipt.name === command.name && receipt.expectedRevision === command.expectedRevision
        ? Effect.succeed({ ...receipt, disposition: 'adopted' as const })
        : Effect.fail(
            new GameServerManifestIdempotencyConflictError({
              idempotencyKey: command.idempotencyKey,
            }),
          )
    if (command.serverId !== stored.serverId)
      return Effect.fail(new GameServerManifestNotFoundError({ server: command.serverId }))
    if (command.expectedRevision !== stored.desiredRevision)
      return Effect.fail(
        new GameServerManifestRevisionConflictError({
          serverId: command.serverId,
          expectedRevision: command.expectedRevision,
        }),
      )
    if (command.name === stored.name)
      return Effect.fail(
        new GameServerManifestValidationError({
          code: 'name_unchanged',
          message: 'The new server name must differ from the current name',
        }),
      )
    if (command.name === 'Taken Name')
      return Effect.fail(
        new GameServerManifestNameConflictError({ serverId: command.serverId, name: command.name }),
      )
    const acceptance: GameServerRenameAcceptance = {
      disposition: 'created',
      operationId: `manifest-rename-operation-${renameReceipts.size + 1}`,
      serverId: command.serverId,
      name: command.name,
      expectedRevision: command.expectedRevision,
      desiredRevision: command.expectedRevision + 1,
      state: 'succeeded',
    }
    renameReceipts.set(command.idempotencyKey, acceptance)
    return Effect.succeed(acceptance)
  })

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
  acceptRename,
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
    actorRole = 'operator'
    renameCommands = []
    renameReceipts.clear()
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

  describe('rename', () => {
    const renamePath = '/v1/organizations/organization-a/game-servers/server-a/actions/rename'
    const renameRequest = (body: unknown, idempotencyKey?: string): RequestInit => ({
      method: 'POST',
      ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
      body: JSON.stringify(body),
    })
    const renamedManifest = (name: string): GameServerManifest => {
      const current = exported()
      return { ...current, metadata: { ...current.metadata, name } }
    }

    it('publishes the typed rename route in the OpenAPI contract', () => {
      const path = '/v1/organizations/{organization}/game-servers/{id}/actions/rename'
      const operation = (openApiDocument.paths[path] as Record<string, unknown> | undefined)?.post
      expect(operation).toMatchObject({
        operationId: 'renameGameServer',
        responses: { '200': { description: 'Success' } },
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: { name: {}, expectedRevision: {} },
                required: ['name', 'expectedRevision'],
              },
            },
          },
        },
      })
      expect(
        (operation as { parameters: readonly { name: string }[] }).parameters.map(
          ({ name }) => name,
        ),
      ).toContain('Idempotency-Key')
      expect(unsupportedApiRoutes.some((route) => route.path === path)).toBe(false)
    })

    it('renames through the typed action and replays the original acceptance', async () => {
      const body = { name: 'Frontline West', expectedRevision: 7 }
      const first = await request(renamePath, renameRequest(body, 'rename-key-a'))
      expect(first.status, await first.clone().text()).toBe(200)
      const accepted = await first.json()
      expect(accepted).toEqual({
        acceptance: {
          disposition: 'created',
          operationId: 'manifest-rename-operation-1',
          serverId: 'server-a',
          name: 'Frontline West',
          expectedRevision: 7,
          desiredRevision: 8,
          state: 'succeeded',
        },
        workflowState: 'not-required',
      })
      expect(renameCommands[0]).toMatchObject({
        organizationId: 'org-a',
        actorId: 'operator-a',
        idempotencyKey: 'rename-key-a',
        auditRequestContext: { origin: 'http' },
      })
      const replay = await request(renamePath, renameRequest(body, 'rename-key-a'))
      expect(replay.status).toBe(200)
      await expect(replay.json()).resolves.toMatchObject({
        acceptance: { disposition: 'adopted', operationId: 'manifest-rename-operation-1' },
      })
      const changed = await request(
        renamePath,
        renameRequest({ name: 'Frontline East', expectedRevision: 7 }, 'rename-key-a'),
      )
      expect(changed.status).toBe(409)
      expect(renameReceipts.size).toBe(1)
    })

    it('denies a viewer and a foreign organization before any rename', async () => {
      actorRole = 'viewer'
      const viewer = await request(
        renamePath,
        renameRequest({ name: 'Frontline West', expectedRevision: 7 }, 'rename-key-viewer'),
      )
      expect(viewer.status).toBe(403)
      await expect(viewer.json()).resolves.toMatchObject({ code: 'ORGANIZATION_ACCESS_DENIED' })
      actorRole = 'operator'
      const foreign = await request(
        '/v1/organizations/organization-b/game-servers/server-a/actions/rename',
        renameRequest({ name: 'Frontline West', expectedRevision: 7 }, 'rename-key-foreign'),
      )
      expect(foreign.status).toBe(403)
      const otherTenantServer = await request(
        '/v1/organizations/organization-a/game-servers/server-of-org-b/actions/rename',
        renameRequest({ name: 'Frontline West', expectedRevision: 7 }, 'rename-key-cross'),
      )
      expect(otherTenantServer.status).toBe(404)
      expect(renameReceipts.size).toBe(0)
    })

    it('returns 409 for a stale revision and NAME_CONFLICT for a held name', async () => {
      const stale = await request(
        renamePath,
        renameRequest({ name: 'Frontline West', expectedRevision: 6 }, 'rename-key-stale'),
      )
      expect(stale.status).toBe(409)
      await expect(stale.json()).resolves.toMatchObject({ code: 'CONFLICT' })
      const conflict = await request(
        renamePath,
        renameRequest({ name: 'Taken Name', expectedRevision: 7 }, 'rename-key-conflict'),
      )
      expect(conflict.status).toBe(409)
      await expect(conflict.json()).resolves.toMatchObject({
        code: NameConflictProblemCode,
        detail: 'Another game server in this organization already uses this name',
      })
      expect(renameReceipts.size).toBe(0)
    })

    it.each([
      ['empty', { name: '', expectedRevision: 7 }],
      ['whitespace-padded', { name: ' Frontline West', expectedRevision: 7 }],
      ['control-character', { name: 'Front\u0007line', expectedRevision: 7 }],
      ['too long', { name: 'x'.repeat(97), expectedRevision: 7 }],
      ['missing revision', { name: 'Frontline West' }],
      ['extra field', { name: 'Frontline West', expectedRevision: 7, domain: 'x.example.test' }],
      ['unchanged', { name: 'Frontline', expectedRevision: 7 }],
    ])('rejects an %s rename request with 400', async (_label, body) => {
      const response = await request(renamePath, renameRequest(body, 'rename-key-invalid'))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' })
      expect(renameReceipts.size).toBe(0)
    })

    it('requires an idempotency key', async () => {
      const response = await request(
        renamePath,
        renameRequest({ name: 'Frontline West', expectedRevision: 7 }),
      )
      expect(response.status).toBe(400)
      expect(renameCommands).toEqual([])
    })

    it('plans and applies a name-only manifest delta as a rename', async () => {
      const plan = await request(
        '/v1/organizations/organization-a/game-server-manifests/plan',
        manifestRequest(renamedManifest('Frontline West')),
      )
      expect(plan.status).toBe(200)
      await expect(plan.json()).resolves.toEqual({
        kind: 'rename',
        serverId: 'server-a',
        desiredRevision: 7,
        name: 'Frontline West',
      })
      const applied = await request(
        '/v1/organizations/organization-a/game-server-manifests/apply',
        manifestRequest(renamedManifest('Frontline West'), 'manifest-rename-a'),
      )
      expect(applied.status, await applied.clone().text()).toBe(202)
      await expect(applied.json()).resolves.toMatchObject({
        kind: 'rename',
        acceptance: { name: 'Frontline West', expectedRevision: 7, desiredRevision: 8 },
        workflowState: 'not-required',
      })
      expect(renameCommands).toHaveLength(1)
      expect(acceptedPolicies).toBe(0)
    })

    it('rejects a manifest rename combined with another delta or an invalid name', async () => {
      const current = renamedManifest('Frontline West')
      const combined = await request(
        '/v1/organizations/organization-a/game-server-manifests/apply',
        manifestRequest(
          {
            ...current,
            spec: {
              ...current.spec,
              updatePolicy: { mode: 'automatic', backupBeforeUpdate: false },
            },
          },
          'manifest-rename-combined',
        ),
      )
      expect(combined.status).toBe(409)
      await expect(combined.json()).resolves.toMatchObject({
        detail: expect.stringContaining('metadata.name'),
      })
      const invalid = await request(
        '/v1/organizations/organization-a/game-server-manifests/apply',
        manifestRequest(renamedManifest('Frontline West '), 'manifest-rename-invalid'),
      )
      expect(invalid.status).toBe(400)
      expect(renameCommands).toEqual([])
      expect(acceptedPolicies).toBe(0)
    })
  })
})

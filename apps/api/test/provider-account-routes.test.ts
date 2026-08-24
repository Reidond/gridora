import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorizationError, NotFoundError } from '@gridora/contracts'
import {
  IdempotencyKey,
  OrganizationContext,
  roleRank,
  type OrganizationRole,
} from '@gridora/domain'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  ProviderAccountLifecycleResult,
  type ProviderAccountControlShape,
  type ProviderAccountLifecycleCommand,
} from '@gridora/provider-account-control'
import {
  ProviderAccountRequestValidationError,
  registerProviderAccountRoutes,
  type ProviderAccountRouteMinimumRole,
} from '../src/provider-account-routes.js'

type TestEnv = { Bindings: { BYOP: boolean } }

const runtime = makeWorkerEffectRuntime(Layer.empty)
const calls: Array<{
  readonly action: 'test' | 'refresh' | 'disable' | 'remove'
  readonly command: ProviderAccountLifecycleCommand
}> = []

const resultFor = (
  action: 'test' | 'refresh' | 'disable' | 'remove',
  command: ProviderAccountLifecycleCommand,
) =>
  new ProviderAccountLifecycleResult({
    accountId: command.accountId,
    organizationId: command.context.organizationId,
    providerType: 'ovhcloud',
    action,
    outcome:
      action === 'test'
        ? 'valid'
        : action === 'refresh'
          ? 'refreshed'
          : action === 'disable'
            ? 'disabled'
            : 'removed',
    accountStatus: action === 'remove' ? null : action === 'disable' ? 'disabled' : 'active',
    revision: command.expectedRevision + 1,
    operationId: command.operationId,
    failureCategory: null,
    regionCount: action === 'refresh' ? 2 : 0,
    projectCount: action === 'refresh' ? 1 : 0,
    catalogItemCount: action === 'refresh' ? 3 : 0,
    completedAt: command.now as never,
  })

const makeControl = (): ProviderAccountControlShape => ({
  test: (command) => {
    calls.push({ action: 'test', command })
    return Effect.succeed(resultFor('test', command))
  },
  refresh: (command) => {
    calls.push({ action: 'refresh', command })
    return Effect.succeed(resultFor('refresh', command))
  },
  disable: (command) => {
    calls.push({ action: 'disable', command })
    return Effect.succeed(resultFor('disable', command))
  },
  remove: (command) => {
    calls.push({ action: 'remove', command })
    return Effect.succeed(resultFor('remove', command))
  },
  assertUsable: () => Effect.die('not used by lifecycle HTTP routes'),
})

const minimumRank: Readonly<Record<ProviderAccountRouteMinimumRole, number>> = {
  administrator: roleRank.administrator,
  owner: roleRank.owner,
}

const roles: Readonly<Record<string, OrganizationRole>> = {
  owner: 'owner',
  admin: 'administrator',
  operator: 'operator',
}

let app: Hono<TestEnv>
let control: ProviderAccountControlShape
let observedRoles: ProviderAccountRouteMinimumRole[]
let mutationSequence = 0

const authorize = (context: HonoContext<TestEnv>, minimumRole: ProviderAccountRouteMinimumRole) =>
  Effect.gen(function* () {
    observedRoles.push(minimumRole)
    const identity = context.req.header('x-test-identity') ?? 'owner'
    const role = roles[identity]
    if (role === undefined || roleRank[role] < minimumRank[minimumRole])
      return yield* new AuthorizationError({
        code: 'role_required',
        message: 'A higher organization role is required',
      })
    const organizationId = context.req.param('organization') ?? 'missing'
    return new OrganizationContext({
      organizationId: organizationId as never,
      organizationSlug: `${organizationId}-slug` as never,
      identityId: identity as never,
      role,
      correlationId: 'provider-account-route-test' as never,
    })
  })

const mutation = (context: HonoContext<TestEnv>, actor: OrganizationContext) =>
  Effect.gen(function* () {
    const rawKey = context.req.header('idempotency-key')
    if (rawKey === undefined)
      return yield* new ProviderAccountRequestValidationError({
        message: 'Idempotency-Key is required',
      })
    const idempotencyKey = yield* Schema.decodeUnknownEffect(IdempotencyKey)(rawKey).pipe(
      Effect.mapError(
        () => new ProviderAccountRequestValidationError({ message: 'Idempotency-Key is invalid' }),
      ),
    )
    mutationSequence += 1
    const scoped = mutationSequence.toString(16).padStart(64, '0')
    return {
      idempotencyKey,
      operationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(scoped),
      requestFingerprint: scoped,
      auditRequestContext: {
        origin: 'http' as const,
        requestId: `provider-account-route-${mutationSequence}`,
        correlationId: actor.correlationId,
        source: {
          ip: { state: 'captured' as const, value: '203.0.113.10' },
          access: {
            state: 'captured' as const,
            value: {
              subject: `access-${actor.identityId}`,
              identityId: actor.identityId,
              issuer: 'https://access.example.test',
              email: `${actor.identityId}@example.test`,
            },
          },
        },
      },
    }
  })

const request = (
  path: string,
  options: {
    readonly method?: 'POST' | 'DELETE'
    readonly body?: unknown
    readonly key?: string | null
    readonly identity?: string
    readonly byop?: boolean
  } = {},
) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('x-test-identity', options.identity ?? 'owner')
  if (options.key !== null) headers.set('idempotency-key', options.key ?? 'provider-action-key')
  return app.request(
    `https://api.gridora.test${path}`,
    {
      method: options.method ?? 'POST',
      headers,
      body: JSON.stringify(options.body ?? { expectedRevision: 4 }),
    },
    { BYOP: options.byop ?? true },
  )
}

describe('provider-account lifecycle route module', () => {
  beforeEach(() => {
    calls.length = 0
    observedRoles = []
    mutationSequence = 0
    control = makeControl()
    app = new Hono<TestEnv>()
    registerProviderAccountRoutes(app, {
      runtimeFor: () => runtime,
      authorize,
      byopEnabled: (bindings) => bindings.BYOP,
      control: () => Effect.succeed(control),
      mutation: (context, actor) => mutation(context, actor),
    })
  })

  afterAll(() => runtime.dispose())

  it('dispatches all four actions with their exact role boundaries and safe results', async () => {
    const cases = [
      ['/v1/organizations/org-a/provider-accounts/account-a/test', 'POST', 'admin', 'test'],
      ['/v1/organizations/org-a/provider-accounts/account-a/refresh', 'POST', 'admin', 'refresh'],
      [
        '/v1/organizations/org-a/provider-accounts/account-a/actions/disable',
        'POST',
        'owner',
        'disable',
      ],
      ['/v1/organizations/org-a/provider-accounts/account-a', 'DELETE', 'owner', 'remove'],
    ] as const

    for (const [path, method, identity, action] of cases) {
      const response = await request(path, { method, identity, key: `provider-${action}-key` })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        accountId: 'account-a',
        organizationId: 'org-a',
        action,
        revision: 5,
      })
    }

    expect(observedRoles).toEqual(['administrator', 'administrator', 'owner', 'owner'])
    expect(calls.map(({ action }) => action)).toEqual(['test', 'refresh', 'disable', 'remove'])
  })

  it('denies callers below the required roles without dispatching an action', async () => {
    expect(
      (
        await request('/v1/organizations/org-a/provider-accounts/account-a/test', {
          identity: 'operator',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request('/v1/organizations/org-a/provider-accounts/account-a/actions/disable', {
          identity: 'admin',
        })
      ).status,
    ).toBe(403)
    expect(calls).toEqual([])
  })

  it('fails closed when organization BYOP accounts are disabled', async () => {
    const response = await request('/v1/organizations/org-a/provider-accounts/account-a/test', {
      byop: false,
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      code: 'ORGANIZATION_ACCESS_DENIED',
    })
    expect(calls).toEqual([])
  })

  it('strictly validates revision, excess fields, JSON, idempotency key, and account id', async () => {
    const path = '/v1/organizations/org-a/provider-accounts/account-a/test'
    expect((await request(path, { body: { expectedRevision: 0 } })).status).toBe(400)
    expect(
      (await request(path, { body: { expectedRevision: 4, providerType: 'contabo' } })).status,
    ).toBe(400)
    expect((await request(path, { key: null })).status).toBe(400)
    expect((await request(path, { key: 'short' })).status).toBe(400)
    expect(
      (await request('/v1/organizations/org-a/provider-accounts/account!bad/test')).status,
    ).toBe(400)

    const invalidJson = await app.request(
      'https://api.gridora.test/v1/organizations/org-a/provider-accounts/account-a/test',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'valid-provider-key',
          'x-test-identity': 'owner',
        },
        body: '{',
      },
      { BYOP: true },
    )
    expect(invalidJson.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('binds the canonical fingerprint to organization, account, action, and revision', async () => {
    for (const [path, revision, key] of [
      ['/v1/organizations/org-a/provider-accounts/account-a/test', 4, 'fingerprint-one'],
      ['/v1/organizations/org-a/provider-accounts/account-b/test', 4, 'fingerprint-two'],
      ['/v1/organizations/org-b/provider-accounts/account-a/test', 4, 'fingerprint-three'],
      ['/v1/organizations/org-a/provider-accounts/account-a/refresh', 4, 'fingerprint-four'],
      ['/v1/organizations/org-a/provider-accounts/account-a/test', 5, 'fingerprint-five'],
    ] as const)
      expect((await request(path, { body: { expectedRevision: revision }, key })).status).toBe(200)

    const fingerprints = calls.map(({ command }) => command.requestFingerprint)
    expect(fingerprints.every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true)
    expect(new Set(fingerprints).size).toBe(fingerprints.length)
  })

  it('does not disclose cross-organization identifiers, raw provider errors, or secrets', async () => {
    const test = vi.fn((_command: ProviderAccountLifecycleCommand) =>
      Effect.fail(
        new NotFoundError({ resource: 'provider-account', id: 'foreign-secret-account' }),
      ),
    )
    control = { ...makeControl(), test }
    const response = await request(
      '/v1/organizations/org-a/provider-accounts/foreign-secret-account/test',
      { body: { expectedRevision: 7 }, key: 'foreign-account-key' },
    )
    expect(response.status).toBe(404)
    const serialized = JSON.stringify(await response.json())
    expect(serialized).not.toContain('foreign-secret-account')
    expect(serialized).not.toMatch(/credential|password|token|provider body/i)
  })

  it('emits fresh valid operation and audit ids without putting secret-like data in output', async () => {
    const response = await request('/v1/organizations/org-a/provider-accounts/account-a/refresh')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { readonly operationId: string }
    expect(body.operationId).toMatch(/^provider_account_[a-f0-9-]+$/)
    expect(calls[0]?.command.auditEventId).toMatch(/^audit_provider_account_[a-f0-9-]+$/)
    expect(JSON.stringify(body)).not.toMatch(/credential|password|token|apiKey|secret/i)
  })
})

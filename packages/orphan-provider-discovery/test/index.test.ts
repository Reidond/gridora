import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'
import type { OrphanReconciliationRequest } from '@gridora/orphan-control'
import {
  makeOvhPublicCloudProvider,
  type OvhOpenStackApi,
} from '@gridora/provider-ovh-public-cloud'
import { makeContaboProvider, type ContaboApi } from '@gridora/provider-contabo'
import { ProviderTemporaryError, type ProviderNode } from '@gridora/provider-sdk'
import {
  makeOrphanProviderDiscovery,
  type OrphanDiscoveryAccount,
  type OrphanProviderDiscoveryDependencies,
} from '../src/index.js'

const encoder = new TextEncoder()
const request: OrphanReconciliationRequest = {
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  providerType: 'ovhcloud',
  runId: 'run-a',
  idempotencyKey: 'request-a',
  actorId: 'actor-a',
}
const account: OrphanDiscoveryAccount = {
  id: 'account-a',
  scope: 'organization',
  organizationId: 'org-a',
  accountOrganizationId: 'org-a',
  providerType: 'ovhcloud',
  credentialReference: 'credential-a',
  credentialRevision: 1,
  status: 'active',
}
const ovhCredentials = {
  authUrl: 'https://auth.cloud.ovh.net/v3',
  region: 'GRA11',
  projectId: 'project-a',
  applicationCredentialId: 'application-a',
  applicationCredentialSecret: 'secret-canary-do-not-disclose',
}
const contaboCredentials = {
  tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  apiBaseUrl: 'https://api.contabo.com/',
  clientId: 'client-a',
  clientSecret: 'client-secret-canary',
  apiUser: 'user-a',
  apiPassword: 'password-a',
}
const node = (overrides: Partial<ProviderNode> = {}): ProviderNode => ({
  id: 'instance-a',
  name: 'node-a',
  state: 'active',
  regionId: 'GRA11',
  planId: 'b2-7',
  addresses: ['192.0.2.10'],
  metadata: {
    managedBy: 'gridora',
    organizationId: 'org-a',
    nodeId: 'node-a',
    operationId: 'operation-a',
    imageVersion: '1.0.0',
  },
  ...overrides,
})

const unused = () => Effect.die('unreachable mutation capability')
const ovhApi = (nodes: ReadonlyArray<ProviderNode>): OvhOpenStackApi => ({
  regions: unused,
  flavors: unused,
  images: unused,
  servers: () => Effect.succeed(nodes),
  createServer: unused,
  getServer: unused,
  action: unused,
  deleteServer: unused,
  createSnapshot: unused,
  getSnapshot: unused,
  deleteSnapshot: unused,
  replaceSecurityGroupRules: unused,
})
const contaboApi = (nodes: ReadonlyArray<ProviderNode>): ContaboApi => ({
  regions: unused,
  products: unused,
  images: unused,
  instances: () => Effect.succeed(nodes),
  createInstance: unused,
  getInstance: unused,
  action: unused,
  scheduleCancellation: unused,
  secureWipeAndStop: unused,
  createSnapshot: unused,
  deleteSnapshot: unused,
  replaceFirewall: unused,
})

interface SubjectOptions {
  readonly account?: OrphanDiscoveryAccount
  readonly credentialBody?: unknown
  readonly listNodes?: OrphanProviderDiscoveryDependencies['ovhcloud']
  readonly contabo?: OrphanProviderDiscoveryDependencies['contabo']
}

const subject = (options: SubjectOptions = {}) => {
  let opened: Uint8Array | undefined
  const discovery = makeOrphanProviderDiscovery({
    now: () => new Date('2026-08-23T10:00:00.000Z'),
    loadAccount: () => Effect.succeed(options.account ?? account),
    openCredentials: () => {
      opened = encoder.encode(JSON.stringify(options.credentialBody ?? ovhCredentials))
      return Effect.succeed(opened)
    },
    ovhcloud:
      options.listNodes ??
      ((_credentials, exactAccount) => {
        const provider = makeOvhPublicCloudProvider(ovhApi([node()]), {
          id: exactAccount.id,
          provider: 'ovhcloud',
          scope: 'organization',
          organizationId: exactAccount.organizationId,
        })
        return Effect.succeed(provider.listNodes)
      }),
    contabo:
      options.contabo ??
      (() =>
        Effect.fail(
          new ProviderTemporaryError({
            provider: 'contabo',
            operation: 'listNodes',
            message: 'unexpected provider dispatch',
          }),
        )),
  })
  return { discovery, opened: () => opened }
}

describe('read-only provider orphan discovery', () => {
  it('uses the existing provider listNodes adapter and emits a complete secret-free snapshot', async () => {
    const test = subject()
    const snapshot = await Effect.runPromise(test.discovery.discover(request))
    expect(snapshot).toMatchObject({
      organizationId: 'org-a',
      providerAccountId: 'account-a',
      providerType: 'ovhcloud',
      requestId: 'run-a',
      complete: true,
      truncated: false,
      continuationToken: null,
    })
    expect(snapshot.resources).toEqual([
      {
        kind: 'node',
        providerResourceId: 'instance-a',
        ownership: node().metadata,
      },
    ])
    expect(snapshot.removalEvidence).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('canary')
    expect(test.opened()?.every((byte) => byte === 0)).toBe(true)
  })

  it('strictly binds organization, account, provider type, and active status before listing', async () => {
    let calls = 0
    for (const rebound of [
      { ...account, organizationId: 'org-b' },
      { ...account, accountOrganizationId: 'org-b' },
      { ...account, id: 'account-b' },
      { ...account, providerType: 'contabo' as const },
      { ...account, status: 'disabled' as const },
    ]) {
      const test = subject({
        account: rebound,
        listNodes: () => {
          calls += 1
          return Effect.succeed(() => Effect.succeed([]))
        },
      })
      await expect(Effect.runPromise(test.discovery.discover(request))).rejects.toMatchObject({
        code: 'invalid-scope',
      })
    }
    expect(calls).toBe(0)
  })

  it('rejects malformed, unknown, duplicate, foreign, and over-limit provider output', async () => {
    const cases: ReadonlyArray<{ readonly value: unknown; readonly code: string }> = [
      { value: [{ id: 'malformed' }], code: 'discovery-failed' },
      { value: [node({ state: 'invented' as ProviderNode['state'] })], code: 'discovery-failed' },
      { value: [node(), node()], code: 'discovery-failed' },
      {
        value: [node({ metadata: { ...node().metadata, organizationId: 'org-b' } })],
        code: 'invalid-scope',
      },
      {
        value: Array.from({ length: 201 }, (_, index) => node({ id: `instance-${index}` })),
        code: 'unbounded-discovery',
      },
    ]
    for (const testCase of cases) {
      const test = subject({
        listNodes: () => Effect.succeed(() => Effect.succeed(testCase.value as ProviderNode[])),
      })
      await expect(Effect.runPromise(test.discovery.discover(request))).rejects.toMatchObject({
        code: testCase.code,
      })
      expect(test.opened()?.every((byte) => byte === 0)).toBe(true)
    }
  })

  it('rejects malformed credentials and clears provider failures without leaking canaries', async () => {
    for (const credentialBody of [
      { ...ovhCredentials, unexpected: 'field' },
      { ...ovhCredentials, authUrl: 'https://example.com/v3' },
      '{not-json',
    ]) {
      const test = subject({ credentialBody })
      const outcome = await Effect.runPromise(Effect.result(test.discovery.discover(request)))
      expect(outcome._tag).toBe('Failure')
      expect(JSON.stringify(outcome)).not.toContain('secret-canary-do-not-disclose')
      expect(test.opened()?.every((byte) => byte === 0)).toBe(true)
    }

    const failed = subject({
      listNodes: () =>
        Effect.succeed(() =>
          Effect.fail(
            new ProviderTemporaryError({
              provider: 'ovhcloud',
              operation: 'listNodes',
              message: 'secret-canary-do-not-disclose',
            }),
          ),
        ),
    })
    const outcome = await Effect.runPromise(Effect.result(failed.discovery.discover(request)))
    expect(JSON.stringify(outcome)).not.toContain('secret-canary-do-not-disclose')
    expect(failed.opened()?.every((byte) => byte === 0)).toBe(true)
  })

  it('dispatches the existing Contabo listNodes adapter from an allocated platform account', async () => {
    let ovhCalls = 0
    let contaboCalls = 0
    const test = subject({
      account: {
        ...account,
        scope: 'platform',
        accountOrganizationId: null,
        providerType: 'contabo',
        credentialRevision: 1,
      },
      credentialBody: contaboCredentials,
      listNodes: () => {
        ovhCalls += 1
        return Effect.succeed(() => Effect.succeed([]))
      },
      contabo: (_credentials, exactAccount) => {
        contaboCalls += 1
        const provider = makeContaboProvider(contaboApi([]), false, {
          id: exactAccount.id,
          provider: 'contabo',
          scope: 'platform',
        })
        return Effect.succeed(provider.listNodes)
      },
    })
    await Effect.runPromise(test.discovery.discover({ ...request, providerType: 'contabo' }))
    expect({ ovhCalls, contaboCalls }).toEqual({ ovhCalls: 0, contaboCalls: 1 })
    expect(test.opened()?.every((byte) => byte === 0)).toBe(true)
  })

  it('clears opened credential bytes when listing is interrupted', async () => {
    const started = Deferred.makeUnsafe<void>()
    const test = subject({
      listNodes: () =>
        Effect.succeed(() => Effect.andThen(Deferred.succeed(started, undefined), Effect.never)),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(test.discovery.discover(request))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(test.opened()?.every((byte) => byte === 0)).toBe(true)
  })
})

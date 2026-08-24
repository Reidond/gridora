import { createGridoraClient, GridoraClientError } from '@gridora/generated-client'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  GridoraApiError,
  canConfirmProviderAccountRemoval,
  createProviderAccountActions,
  providerAccountActionPermissions,
  providerAccountErrorMessage,
  providersFromApi,
  type CreateOrganizationProviderAccountInput,
  type ProviderAccountApiRecord,
  type ProviderAccountViewModel,
} from '../services/gridora-api'
import {
  createIdempotentMutationRunner,
  type IdempotencyStorage,
} from '../services/idempotent-mutation'

const account = (overrides: Partial<ProviderAccountApiRecord> = {}): ProviderAccountApiRecord => ({
  id: 'provider_01',
  scope: 'organization',
  organizationId: 'org_01',
  providerType: 'ovhcloud',
  status: 'disabled',
  revision: 1,
  credentialRevision: 1,
  createdAt: '2026-08-23T10:00:00Z',
  updatedAt: '2026-08-23T10:00:00Z',
  ...overrides,
})

const lifecycle = (action: 'test' | 'refresh' | 'disable' | 'remove') => ({
  accountId: 'provider_01',
  organizationId: 'org_01',
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
  revision: 3,
  operationId: `operation_${action}`,
  failureCategory: null,
  regionCount: 1,
  projectCount: 1,
  catalogItemCount: 0,
  completedAt: '2026-08-23T10:05:00Z',
})

const mutationRunner = (
  storage: IdempotencyStorage,
  isAmbiguous: (error: unknown) => boolean = () => false,
) => {
  let sequence = 0
  return createIdempotentMutationRunner({
    storage,
    createKey: () => `idempotency-${++sequence}`,
    isAmbiguous,
  })
}

const memoryStorage = () => {
  const values = new Map<string, string>()
  const storage: IdempotencyStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  return { storage, values }
}

const runClient = <A>(effect: Effect.Effect<A, GridoraClientError>): Promise<A> =>
  Effect.runPromise(effect)

describe('provider-account generated-client actions', () => {
  it('uses the exact secret body and explicit idempotency key without returning credentials', async () => {
    const canary = 'secret-canary-never-return'
    const observed: Request[] = []
    const fetcher: typeof fetch = async (input, init) => {
      observed.push(new Request(input, init))
      return Response.json(account())
    }
    const client = createGridoraClient({ baseUrl: 'https://api.gridora.test', fetch: fetcher })
    const { storage, values } = memoryStorage()
    const actions = createProviderAccountActions({
      client,
      run: runClient,
      mutations: mutationRunner(storage),
    })
    const input: CreateOrganizationProviderAccountInput = {
      providerType: 'ovhcloud',
      credentials: {
        authUrl: 'https://auth.cloud.ovh.net/v3',
        region: 'GRA11',
        projectId: 'project_01',
        applicationCredentialId: 'credential_01',
        applicationCredentialSecret: canary,
      },
    }

    const created = await actions.createProviderAccount('night-watch', input)
    const request = observed[0]
    expect(request).toBeDefined()
    expect(request?.url).toBe(
      'https://api.gridora.test/v1/organizations/night-watch/provider-accounts',
    )
    expect(request?.headers.get('idempotency-key')).toBe('idempotency-1')
    await expect(request?.json()).resolves.toEqual(input)
    expect(JSON.stringify(created)).not.toContain(canary)
    expect([...values.entries()]).toEqual([])
  })

  it('retains only a digest and key after an ambiguous create and adopts the same key on retry', async () => {
    const canary = 'ambiguous-secret-canary'
    const keys: string[] = []
    let attempts = 0
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      keys.push(request.headers.get('idempotency-key') ?? '')
      attempts += 1
      if (attempts === 1) throw new TypeError('connection closed')
      return Response.json(account({ providerType: 'contabo' }))
    }
    const client = createGridoraClient({ baseUrl: 'https://api.gridora.test', fetch: fetcher })
    const { storage, values } = memoryStorage()
    const actions = createProviderAccountActions({
      client,
      run: runClient,
      mutations: mutationRunner(
        storage,
        (error) => error instanceof GridoraClientError && error.retryable,
      ),
    })
    const input: CreateOrganizationProviderAccountInput = {
      providerType: 'contabo',
      credentials: {
        tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
        apiBaseUrl: 'https://api.contabo.com',
        clientId: 'client_01',
        clientSecret: canary,
        apiUser: 'api-user',
        apiPassword: 'api-password',
      },
    }

    await expect(actions.createProviderAccount('night-watch', input)).rejects.toBeInstanceOf(
      GridoraClientError,
    )
    expect(JSON.stringify([...values.entries()])).not.toContain(canary)
    expect([...values.keys()][0]).toMatch(/^gridora\.idempotency\.v1\.[a-f0-9]{64}$/)
    await expect(actions.createProviderAccount('night-watch', input)).resolves.toMatchObject({
      id: 'provider_01',
    })
    expect(keys).toEqual(['idempotency-1', 'idempotency-1'])
    expect([...values.entries()]).toEqual([])
  })

  it('forwards both credential revisions and every lifecycle revision with distinct keys', async () => {
    const requests: Request[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      const path = new URL(request.url).pathname
      if (request.method === 'PATCH')
        return Response.json(account({ status: 'active', revision: 8, credentialRevision: 6 }))
      const action =
        request.method === 'DELETE'
          ? 'remove'
          : path.endsWith('/test')
            ? 'test'
            : path.endsWith('/refresh')
              ? 'refresh'
              : 'disable'
      return Response.json(lifecycle(action))
    }
    const client = createGridoraClient({ baseUrl: 'https://api.gridora.test', fetch: fetcher })
    const { storage } = memoryStorage()
    const actions = createProviderAccountActions({
      client,
      run: runClient,
      mutations: mutationRunner(storage),
    })

    await actions.updateProviderAccountCredentials('night-watch', 'provider_01', {
      providerType: 'ovhcloud',
      expectedRevision: 7,
      expectedCredentialRevision: 5,
      credentials: {
        authUrl: 'https://auth.cloud.ovh.net/v3',
        region: 'GRA11',
        projectId: 'project_01',
        applicationCredentialId: 'credential_01',
        applicationCredentialSecret: 'replacement-secret',
      },
    })
    await actions.testProviderAccount('night-watch', 'provider_01', 8)
    await actions.refreshProviderAccount('night-watch', 'provider_01', 9)
    await actions.disableProviderAccount('night-watch', 'provider_01', 10)
    await actions.deleteProviderAccount('night-watch', 'provider_01', 11)

    await expect(requests[0]?.json()).resolves.toMatchObject({
      expectedRevision: 7,
      expectedCredentialRevision: 5,
    })
    for (const [index, revision] of [8, 9, 10, 11].entries())
      await expect(requests[index + 1]?.json()).resolves.toEqual({ expectedRevision: revision })
    expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
      'idempotency-1',
      'idempotency-2',
      'idempotency-3',
      'idempotency-4',
      'idempotency-5',
    ])
  })
})

describe('provider-account UI policy', () => {
  const organizationProvider = (): ProviderAccountViewModel => ({
    id: 'provider_01',
    provider: 'OVHcloud',
    providerType: 'ovhcloud',
    accountScope: 'organization',
    source: 'Organization account',
    status: 'disabled',
    regions: [],
    refreshedAt: '2026-08-23T10:00:00Z',
    revision: 4,
    credentialRevision: 2,
  })

  it('keeps platform allocation policy distinct from organization credentials and telemetry', () => {
    const result = providersFromApi(
      [
        account({
          id: 'platform_01',
          scope: 'platform',
          organizationId: null,
          credentialRevision: null,
          status: 'active',
        }),
        account(),
      ],
      [
        {
          organizationId: 'org_01',
          providerAccountId: 'platform_01',
          providerType: 'ovhcloud',
          accountScope: 'platform',
          allowedRegions: ['GRA11'],
          allowedPlans: ['b2-15'],
          maxActiveNodes: 3,
          monthlyBudgetMinor: 12_500,
          status: 'active',
          revision: 6,
        },
      ],
    )

    expect(result[0]).toMatchObject({
      source: 'Platform allocation',
      regions: ['GRA11'],
      allocation: {
        allowedPlans: ['b2-15'],
        maxActiveNodes: 3,
        monthlyBudgetMinor: 12_500,
        revision: 6,
      },
    })
    expect(result[0]).not.toHaveProperty('credentialRevision')
    expect(result[0]).not.toHaveProperty('nodes')
    expect(result[0]).not.toHaveProperty('billing')
    expect(result[1]).toMatchObject({ source: 'Organization account', regions: [] })
    expect(result[1]).not.toHaveProperty('allocation')
  })

  it('enforces role, source, state, and exact two-step removal confirmation', () => {
    const provider = organizationProvider()
    expect(providerAccountActionPermissions('Owner', provider)).toEqual({
      canTest: true,
      canRefresh: false,
      canReplaceCredentials: true,
      canDisable: false,
      canBeginRemove: true,
    })
    expect(providerAccountActionPermissions('Administrator', provider)).toMatchObject({
      canTest: true,
      canRefresh: false,
      canReplaceCredentials: false,
      canBeginRemove: false,
    })
    expect(providerAccountActionPermissions('Viewer', provider).canTest).toBe(false)
    expect(canConfirmProviderAccountRemoval('Owner', provider, 'provider_0')).toBe(false)
    expect(canConfirmProviderAccountRemoval('Owner', provider, 'provider_01')).toBe(true)
    expect(canConfirmProviderAccountRemoval('Administrator', provider, 'provider_01')).toBe(false)

    expect(
      Object.values(
        providerAccountActionPermissions('Owner', {
          ...provider,
          revision: undefined,
        }),
      ),
    ).toEqual([false, false, false, false, false])

    const platform = { ...provider, accountScope: 'platform' as const }
    expect(Object.values(providerAccountActionPermissions('Owner', platform))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it('never re-emits raw server details in credential-operation errors', () => {
    const canary = 'provider-body-secret-canary'
    for (const error of [
      new GridoraApiError(0, 'NETWORK', canary),
      new GridoraApiError(400, 'INVALID', canary),
      new GridoraApiError(403, 'ROLE', canary),
      new GridoraApiError(409, 'CONFLICT', canary),
      new GridoraApiError(500, 'UPSTREAM', canary),
      new Error(canary),
    ])
      expect(providerAccountErrorMessage(error, 'replace credentials')).not.toContain(canary)
  })
})

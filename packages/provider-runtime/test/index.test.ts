import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  ProviderTemporaryError,
  type CreateNodeInput,
  type ProviderNode,
} from '@gridora/provider-sdk'
import {
  makeProviderCreateRuntime,
  type AuthoritativeProviderAccount,
  type ContaboRuntimeCredentials,
  type OvhRuntimeCredentials,
  type ProviderRuntimeCreateInput,
} from '../src/index.js'

const nodeInput: CreateNodeInput = {
  organizationId: 'org-a',
  operationId: 'op-a',
  nodeId: 'node-a',
  name: 'gridora-node-a',
  regionId: 'region-a',
  planId: 'plan-a',
  imageId: 'image-provider-a',
  imageVersion: '2026.08.23',
  createMode: 'create_or_adopt',
}
const providerNode = (overrides: Partial<ProviderNode> = {}): ProviderNode => ({
  id: 'provider-node-a',
  name: nodeInput.name,
  state: 'creating',
  regionId: nodeInput.regionId,
  planId: nodeInput.planId,
  addresses: [],
  metadata: {
    managedBy: 'gridora',
    organizationId: nodeInput.organizationId,
    nodeId: nodeInput.nodeId,
    operationId: nodeInput.operationId,
    imageVersion: nodeInput.imageVersion,
  },
  ...overrides,
})
const account = (
  providerType: 'ovhcloud' | 'contabo',
  overrides: Partial<AuthoritativeProviderAccount> = {},
): AuthoritativeProviderAccount => ({
  id: 'account-a',
  providerType,
  scope: 'organization',
  organizationId: 'org-a',
  revision: 3,
  status: 'active',
  ...overrides,
})
const accepted = (
  providerType: 'ovhcloud' | 'contabo',
): ProviderRuntimeCreateInput['accepted'] => ({
  organizationId: nodeInput.organizationId,
  nodeId: nodeInput.nodeId,
  operationId: nodeInput.operationId,
  providerAccountId: 'account-a',
  providerAccountRevision: 3,
  providerType,
  regionId: nodeInput.regionId,
  planId: nodeInput.planId,
  providerImageId: nodeInput.imageId,
  imageVersion: nodeInput.imageVersion,
  commercialTerms: {
    currency: 'EUR',
    estimatedMonthlyMinor: providerType === 'contabo' ? 1_800 : 1_500,
    billingCadence: providerType === 'contabo' ? 'contract' : 'monthly',
    contractMonths: providerType === 'contabo' ? 12 : 1,
    nonHourlyCommitmentConfirmed: true,
    catalogRefreshedAt: '2026-08-23T10:00:00.000Z',
  },
})
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
const ovhCredentials = {
  authUrl: 'https://auth.cloud.ovh.net/v3',
  region: 'region-a',
  projectId: 'project-a',
  applicationCredentialId: 'credential-a',
  applicationCredentialSecret: 'secret-a',
}
const contaboCredentials = {
  tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  apiBaseUrl: 'https://api.contabo.com',
  clientId: 'client-a',
  clientSecret: 'secret-a',
  apiUser: 'user-a',
  apiPassword: 'password-a',
}

const runtime = (calls: string[]) =>
  makeProviderCreateRuntime({
    ovhcloud: {
      createOrAdopt: (credentials: OvhRuntimeCredentials) => {
        calls.push(`ovh:${credentials.projectId}`)
        return Effect.succeed(providerNode())
      },
    },
    contabo: {
      createOrAdopt: (credentials: ContaboRuntimeCredentials, _input, terms) => {
        calls.push(`contabo:${credentials.clientId}:${terms.contractMonths}`)
        return Effect.succeed(providerNode())
      },
    },
  })

describe('provider runtime', () => {
  it('fixed-dispatches only from the authoritative account type', async () => {
    const calls: string[] = []
    const ovhBytes = bytes(ovhCredentials)
    await Effect.runPromise(
      runtime(calls).createOrAdopt({
        account: account('ovhcloud'),
        accepted: accepted('ovhcloud'),
        credentialBytes: ovhBytes,
        node: nodeInput,
      }),
    )
    const contaboBytes = bytes(contaboCredentials)
    await Effect.runPromise(
      runtime(calls).createOrAdopt({
        account: account('contabo'),
        accepted: accepted('contabo'),
        credentialBytes: contaboBytes,
        node: nodeInput,
      }),
    )
    expect(calls).toEqual(['ovh:project-a', 'contabo:client-a:12'])
    expect([...ovhBytes, ...contaboBytes].every((byte) => byte === 0)).toBe(true)
  })

  it('strictly rejects excess or malformed credential output and clears bytes', async () => {
    for (const body of [{ ...ovhCredentials, providerType: 'contabo' }, '{not-json']) {
      const credentialBytes =
        typeof body === 'string' ? new TextEncoder().encode(body) : bytes(body)
      await expect(
        Effect.runPromise(
          runtime([]).createOrAdopt({
            account: account('ovhcloud'),
            accepted: accepted('ovhcloud'),
            credentialBytes,
            node: nodeInput,
          }),
        ),
      ).rejects.toMatchObject({ _tag: 'ProviderValidationError' })
      expect([...credentialBytes].every((byte) => byte === 0)).toBe(true)
    }
  })

  it('rejects endpoint substitution before an injected transport can run', async () => {
    const calls: string[] = []
    const credentialBytes = bytes({ ...contaboCredentials, apiBaseUrl: 'https://example.com' })
    await expect(
      Effect.runPromise(
        runtime(calls).createOrAdopt({
          account: account('contabo'),
          accepted: accepted('contabo'),
          credentialBytes,
          node: nodeInput,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderValidationError' })
    expect(calls).toEqual([])
    expect([...credentialBytes].every((byte) => byte === 0)).toBe(true)
  })

  it('fails closed across an organization account boundary', async () => {
    const credentialBytes = bytes(ovhCredentials)
    await expect(
      Effect.runPromise(
        runtime([]).createOrAdopt({
          account: account('ovhcloud', { organizationId: 'org-b' }),
          accepted: accepted('ovhcloud'),
          credentialBytes,
          node: nodeInput,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderAuthorizationError' })
    expect([...credentialBytes].every((byte) => byte === 0)).toBe(true)
  })

  it('binds the authoritative account to the immutable accepted account revision', async () => {
    const calls: string[] = []
    const credentialBytes = bytes(ovhCredentials)
    await expect(
      Effect.runPromise(
        runtime(calls).createOrAdopt({
          account: account('ovhcloud', { revision: 4 }),
          accepted: accepted('ovhcloud'),
          credentialBytes,
          node: nodeInput,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderValidationError' })
    expect(calls).toEqual([])
    expect([...credentialBytes].every((byte) => byte === 0)).toBe(true)
  })

  it('never falls through to a transport for an unsupported account type', async () => {
    const calls: string[] = []
    const credentialBytes = bytes(contaboCredentials)
    const unsupported = { ...account('contabo'), providerType: 'arbitrary-provider' }
    await expect(
      Effect.runPromise(
        runtime(calls).createOrAdopt({
          account: unsupported as unknown as AuthoritativeProviderAccount,
          accepted: accepted('contabo'),
          credentialBytes,
          node: nodeInput,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderValidationError' })
    expect(calls).toEqual([])
    expect([...credentialBytes].every((byte) => byte === 0)).toBe(true)
  })

  it('rejects provider response ownership, operation, catalog, or image mismatches', async () => {
    const mismatches: Partial<ProviderNode>[] = [
      { regionId: 'region-b' },
      { planId: 'plan-b' },
      { metadata: { ...providerNode().metadata, organizationId: 'org-b' } },
      { metadata: { ...providerNode().metadata, operationId: 'op-b' } },
      { metadata: { ...providerNode().metadata, imageVersion: 'old' } },
    ]
    for (const mismatch of mismatches) {
      const credentialBytes = bytes(ovhCredentials)
      const subject = makeProviderCreateRuntime({
        ovhcloud: { createOrAdopt: () => Effect.succeed(providerNode(mismatch)) },
        contabo: { createOrAdopt: () => Effect.succeed(providerNode()) },
      })
      await expect(
        Effect.runPromise(
          subject.createOrAdopt({
            account: account('ovhcloud'),
            accepted: accepted('ovhcloud'),
            credentialBytes,
            node: nodeInput,
          }),
        ),
      ).rejects.toMatchObject({ _tag: 'ProviderValidationError' })
      expect([...credentialBytes].every((byte) => byte === 0)).toBe(true)
    }
  })

  it('clears credential bytes when transport fails or the effect is interrupted', async () => {
    const failedBytes = bytes(ovhCredentials)
    const subject = makeProviderCreateRuntime({
      ovhcloud: {
        createOrAdopt: () =>
          Effect.fail(
            new ProviderTemporaryError({
              provider: 'ovhcloud',
              operation: 'createNode',
              message: 'temporary',
            }),
          ),
      },
      contabo: { createOrAdopt: () => Effect.succeed(providerNode()) },
    })
    await expect(
      Effect.runPromise(
        subject.createOrAdopt({
          account: account('ovhcloud'),
          accepted: accepted('ovhcloud'),
          credentialBytes: failedBytes,
          node: nodeInput,
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderTemporaryError' })
    expect([...failedBytes].every((byte) => byte === 0)).toBe(true)

    const interruptedBytes = bytes(ovhCredentials)
    const never = makeProviderCreateRuntime({
      ovhcloud: { createOrAdopt: () => Effect.never },
      contabo: { createOrAdopt: () => Effect.never },
    })
    const fiber = Effect.runFork(
      never.createOrAdopt({
        account: account('ovhcloud'),
        accepted: accepted('ovhcloud'),
        credentialBytes: interruptedBytes,
        node: nodeInput,
      }),
    )
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect([...interruptedBytes].every((byte) => byte === 0)).toBe(true)
  })

  it('passes adopt-only response-loss recovery through without inventing a second identity', async () => {
    let observed: CreateNodeInput | undefined
    const credentialBytes = bytes(ovhCredentials)
    const subject = makeProviderCreateRuntime({
      ovhcloud: {
        createOrAdopt: (_credentials, input) => {
          observed = input
          return Effect.succeed(providerNode())
        },
      },
      contabo: { createOrAdopt: () => Effect.succeed(providerNode()) },
    })
    await Effect.runPromise(
      subject.createOrAdopt({
        account: account('ovhcloud'),
        accepted: accepted('ovhcloud'),
        credentialBytes,
        node: { ...nodeInput, createMode: 'adopt_only' },
      }),
    )
    expect(observed).toMatchObject({
      createMode: 'adopt_only',
      operationId: 'op-a',
      nodeId: 'node-a',
    })
  })
})

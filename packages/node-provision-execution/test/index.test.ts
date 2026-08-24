import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
  NodeProvisionExecutionReservation,
  RegistrationTokenSecretShape,
} from '@gridora/node-provision-control'
import { makeProviderCreateRuntime } from '@gridora/provider-runtime'
import {
  ProviderCreateUncertainError,
  ProviderTemporaryError,
  type CreateNodeInput,
  type ProviderNode,
} from '@gridora/provider-sdk'
import {
  makeNodeProvisionExecution,
  nodeBootstrapCloudInit,
  NodeProvisionExecutionPersistenceError,
  type NodeProvisionExecutionRepositoryShape,
  type NodeProvisionExecutionResult,
  type NodeProvisionExecutionPreparation,
} from '../src/index.js'

const now = '2026-08-23T16:00:00.000Z'
const reservation = (
  providerType: 'ovhcloud' | 'contabo' = 'ovhcloud',
): NodeProvisionExecutionReservation => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  operationId: 'op-a',
  providerAccountId: 'account-a',
  providerAccountRevision: 3,
  providerType,
  region: 'region-a',
  plan: 'plan-a',
  imageId: 'image-a',
  imageVersion: '2026.08.23',
  imageChecksum: `sha256:${'a'.repeat(64)}`,
  providerImageId: 'provider-image-a',
  placementMode: 'shared',
  billing: {
    currency: 'EUR',
    estimatedMonthlyMinor: providerType === 'contabo' ? 1800 : 1500,
    billingCadence: providerType === 'contabo' ? 'contract' : 'monthly',
    contractMonths: providerType === 'contabo' ? 12 : 1,
    nonHourlyCommitmentConfirmed: true,
    catalogRefreshedAt: '2026-08-23T10:00:00.000Z',
  },
  bootstrapToken: {
    recordId: 'bootstrap-a',
    keyVersion: 2,
    tokenHash: 'a'.repeat(64),
    state: 'reserved',
    expiresAt: '2026-08-23T17:00:00.000Z',
  },
  workflowStart: { id: 'workflow-start-a', state: 'started' },
})

const providerNode = (
  next: Partial<ProviderNode> = {},
  providerType: 'ovhcloud' | 'contabo' = 'ovhcloud',
): ProviderNode => ({
  id: `${providerType}-instance-a`,
  name: 'gridora-node-a',
  state: 'creating',
  regionId: 'region-a',
  planId: 'plan-a',
  addresses: ['203.0.113.10'],
  metadata: {
    managedBy: 'gridora',
    organizationId: 'org-a',
    nodeId: 'node-a',
    operationId: 'op-a',
    imageVersion: '2026.08.23',
  },
  ...next,
})

const ovhCredentials = {
  authUrl: 'https://auth.cloud.ovh.net/v3',
  region: 'region-a',
  projectId: 'canary-project',
  applicationCredentialId: 'canary-application-id',
  applicationCredentialSecret: 'canary-application-secret',
}
const contaboCredentials = {
  tokenUrl: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  apiBaseUrl: 'https://api.contabo.com/',
  clientId: 'canary-client',
  clientSecret: 'canary-client-secret',
  apiUser: 'canary-user',
  apiPassword: 'canary-password',
}

class MemoryRepository implements NodeProvisionExecutionRepositoryShape {
  status: 'queued' | 'running' | 'retrying' | 'waiting_external' | 'failed_terminal' = 'queued'
  attemptNumber = 1
  completion: NodeProvisionExecutionResult | null = null
  preparation: NodeProvisionExecutionPreparation | null = null
  failCompletionResponseOnce = false
  readonly persisted: unknown[] = []
  findCompletion = () => Effect.succeed(this.completion)
  findPreparation = () => Effect.succeed(this.preparation)
  beginAttempt: NodeProvisionExecutionRepositoryShape['beginAttempt'] = (input) => {
    const mode = this.status === 'queued' ? ('create_or_adopt' as const) : ('adopt_only' as const)
    this.status = 'running'
    this.attemptNumber += 1
    this.preparation ??= {
      organizationId: input.reservation.organizationId,
      nodeId: input.reservation.nodeId,
      operationId: input.reservation.operationId,
      providerAccountId: input.reservation.providerAccountId,
      providerAccountRevision: input.reservation.providerAccountRevision,
      providerType: input.reservation.providerType,
      envelopeRevision: input.envelopeRevision,
      derivationTokenHash: input.derivationTokenHash,
      deliveredTokenHash: input.deliveredTokenHash,
      bootstrapExpiresAt: input.bootstrapExpiresAt,
      state: 'active',
    }
    return Effect.succeed({ mode, attemptNumber: this.attemptNumber })
  }
  completeAtomic: NodeProvisionExecutionRepositoryShape['completeAtomic'] = (input) => {
    this.status = 'waiting_external'
    this.completion = {
      disposition: 'completed',
      organizationId: input.reservation.organizationId,
      nodeId: input.reservation.nodeId,
      operationId: input.reservation.operationId,
      providerInstanceId: input.providerNode.id,
      providerState: input.providerNode.state,
      state: 'waiting-for-agent',
    }
    this.persisted.push({
      envelopeRevision: input.envelopeRevision,
      providerInstanceId: input.providerNode.id,
      deliveredTokenHash: input.deliveredTokenHash,
    })
    if (this.failCompletionResponseOnce) {
      this.failCompletionResponseOnce = false
      return Effect.fail(new NodeProvisionExecutionPersistenceError({ operation: 'response-lost' }))
    }
    return Effect.succeed(this.completion)
  }
  recordFailureAtomic: NodeProvisionExecutionRepositoryShape['recordFailureAtomic'] = (input) => {
    this.status = input.retryable ? 'retrying' : 'failed_terminal'
    this.persisted.push({
      category: input.category,
      retryable: input.retryable,
      attemptNumber: input.attemptNumber,
    })
    return Effect.void
  }
}

const fixture = (
  options: {
    readonly providerType?: 'ovhcloud' | 'contabo'
    readonly repository?: MemoryRepository
    readonly providerNode?: ProviderNode
    readonly transport?: (input: CreateNodeInput) => Effect.Effect<ProviderNode, never>
    readonly trustedNow?: () => string
  } = {},
) => {
  const providerType = options.providerType ?? 'ovhcloud'
  const accepted = reservation(providerType)
  const repository = options.repository ?? new MemoryRepository()
  const credentialBuffers: Uint8Array[] = []
  let rawToken: Uint8Array | undefined
  let cloudInit: Uint8Array | undefined
  let observedInput: CreateNodeInput | undefined
  const registrationTokens: RegistrationTokenSecretShape = {
    hashFor: () => Effect.die('not used'),
    recoverBytes: () => {
      rawToken = new TextEncoder().encode('bootstrap-canary-secret-32-bytes')
      return Effect.succeed(rawToken)
    },
  }
  const provider = makeProviderCreateRuntime({
    ovhcloud: {
      createOrAdopt: (_credentials, input) => {
        observedInput = input
        return (
          options.transport?.(input) ??
          Effect.succeed(options.providerNode ?? providerNode({}, 'ovhcloud'))
        )
      },
    },
    contabo: {
      createOrAdopt: (_credentials, input, commercialTerms) => {
        observedInput = input
        expect(commercialTerms).toEqual(accepted.billing)
        return (
          options.transport?.(input) ??
          Effect.succeed(options.providerNode ?? providerNode({}, 'contabo'))
        )
      },
    },
  })
  const service = makeNodeProvisionExecution({
    reservations: {
      load: () =>
        Effect.succeed(
          repository.preparation === null
            ? accepted
            : {
                ...accepted,
                bootstrapToken: {
                  ...accepted.bootstrapToken,
                  tokenHash: repository.preparation.deliveredTokenHash,
                  expiresAt: repository.preparation.bootstrapExpiresAt,
                  state: 'materialized' as const,
                },
              },
        ),
    },
    credentials: {
      openExact: () =>
        Effect.sync(() => {
          const credentialBytes = new TextEncoder().encode(
            JSON.stringify(providerType === 'ovhcloud' ? ovhCredentials : contaboCredentials),
          )
          credentialBuffers.push(credentialBytes)
          return {
            account: {
              id: 'account-a',
              providerType,
              scope: 'organization' as const,
              organizationId: 'org-a',
              revision: 3,
              status: 'active' as const,
            },
            envelopeRevision: 7,
            credentialBytes,
          }
        }),
    },
    registrationTokens,
    cloudInit: {
      render: (input) =>
        Effect.tap(nodeBootstrapCloudInit.render(input), (value) =>
          Effect.sync(() => {
            cloudInit = value
          }),
        ),
    },
    provider,
    repository,
    clock: {
      now: Effect.sync(() => {
        const iso = options.trustedNow?.() ?? now
        return { iso, epochMilliseconds: Date.parse(iso) }
      }),
    },
    trustedBootstrap: {
      controlPlaneUrl: 'https://api.gridora.dev',
      expectedControlPlaneHost: 'api.gridora.dev',
      allowLoopbackHttp: false,
      agentVersion: '0.1.0',
      dockerSocket: '/var/run/docker.sock',
      pollWaitSeconds: 10,
      registrationTtlSeconds: 3600,
      commandSigningPublicKeyPem:
        '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----',
      providerInstanceDiscovery: {
        mode: 'image-metadata-helper-v1',
        helperUnit: 'gridora-node-bootstrap.service',
      },
    },
  })
  return {
    accepted,
    repository,
    credentialBuffers,
    rawToken: () => rawToken,
    cloudInit: () => cloudInit,
    observedInput: () => observedInput,
    service,
  }
}

describe('node provider execution control', () => {
  it('creates from immutable facts, commits waiting-for-agent, and clears every byte buffer', async () => {
    const test = fixture()
    const result = await Effect.runPromise(
      test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
    )
    expect(result).toMatchObject({
      disposition: 'completed',
      providerInstanceId: 'ovhcloud-instance-a',
      state: 'waiting-for-agent',
    })
    expect(test.observedInput()).toMatchObject({
      organizationId: 'org-a',
      operationId: 'op-a',
      nodeId: 'node-a',
      name: 'gridora-node-a',
      imageId: 'provider-image-a',
      createMode: 'create_or_adopt',
    })
    const renderedCloudInit = test.observedInput()?.cloudInit
    if (renderedCloudInit === undefined) throw new Error('cloud-init was not rendered')
    expect(renderedCloudInit).not.toMatch(/systemctl.*(?:start|restart).*gridora-node-bootstrap/)
    const manifestLine = renderedCloudInit
      .split('\n')
      .find((line) => line.startsWith('    content: '))
    expect(manifestLine).toBeDefined()
    const manifest = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob((manifestLine as string).slice('    content: '.length)), (value) =>
          value.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      organizationId: 'org-a',
      nodeId: 'node-a',
      operationId: 'op-a',
      providerType: 'ovhcloud',
      imageId: 'image-a',
      providerImageId: 'provider-image-a',
      imageVersion: '2026.08.23',
      imageChecksum: `sha256:${'a'.repeat(64)}`,
      controlPlaneUrl: 'https://api.gridora.dev',
      expectedControlPlaneHost: 'api.gridora.dev',
      allowLoopbackHttp: false,
      agentVersion: '0.1.0',
      dockerSocket: '/var/run/docker.sock',
      pollWaitSeconds: 10,
      registrationExpiresAt: '2026-08-23T17:00:00.000Z',
    })
    expect(Object.keys(manifest)).toEqual([
      'schemaVersion',
      'organizationId',
      'nodeId',
      'operationId',
      'providerType',
      'imageId',
      'providerImageId',
      'imageVersion',
      'imageChecksum',
      'controlPlaneUrl',
      'expectedControlPlaneHost',
      'allowLoopbackHttp',
      'agentVersion',
      'dockerSocket',
      'pollWaitSeconds',
      'registrationExpiresAt',
      'registrationToken',
      'commandSigningPublicKeyPem',
    ])
    expect(String(manifest.commandSigningPublicKeyPem)).not.toContain('PRIVATE KEY')
    expect(test.repository.persisted).toHaveLength(1)
    expect(JSON.stringify(test.repository.persisted)).not.toContain('canary-secret')
    expect(test.credentialBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expect(test.rawToken()?.every((byte) => byte === 0)).toBe(true)
    expect(test.cloudInit()?.every((byte) => byte === 0)).toBe(true)
  })

  it('uses adopt-only after a lost provider response and never creates a second identity', async () => {
    const calls: CreateNodeInput[] = []
    let first = true
    const test = fixture({
      transport: (input) => {
        calls.push(input)
        if (first) {
          first = false
          return Effect.fail(
            new ProviderCreateUncertainError({
              provider: 'ovhcloud',
              operation: 'createNode',
              message: 'response lost',
              organizationId: 'org-a',
              operationId: 'op-a',
              retryMode: 'adopt_only',
              stabilizationAttempts: 3,
              nextAttemptNumber: 2,
              nextAttemptAtEpochMs: Date.parse(now) + 1000,
              recoveryDeadlineAtEpochMs: Date.parse(now) + 15 * 60 * 1000,
            }),
          ) as never
        }
        return Effect.succeed(providerNode())
      },
    })
    await expect(
      Effect.runPromise(
        test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderCreateUncertainError' })
    const result = await Effect.runPromise(
      test.service.execute({
        organizationId: 'org-a',
        operationId: 'op-a',
        attemptedAt: '2026-08-23T16:00:01.000Z',
      }),
    )
    expect(calls.map((input) => input.createMode)).toEqual(['create_or_adopt', 'adopt_only'])
    expect(new Set(calls.map((input) => input.operationId))).toEqual(new Set(['op-a']))
    expect(result.providerInstanceId).toBe('ovhcloud-instance-a')
  })

  it('adopts a committed completion when the D1 response was lost', async () => {
    const repository = new MemoryRepository()
    repository.failCompletionResponseOnce = true
    const test = fixture({ repository })
    await expect(
      Effect.runPromise(
        test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
      ),
    ).rejects.toBeDefined()
    const replay = await Effect.runPromise(
      test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
    )
    expect(replay).toMatchObject({
      disposition: 'adopted',
      providerInstanceId: 'ovhcloud-instance-a',
    })
    expect(test.repository.persisted).toHaveLength(1)
  })

  it('rejects changed account revision and foreign provider ownership before persistence', async () => {
    const changed = fixture()
    const originalOpen = changed.service
    const bytes = new TextEncoder().encode(JSON.stringify(ovhCredentials))
    const service = makeNodeProvisionExecution({
      reservations: { load: () => Effect.succeed(reservation()) },
      credentials: {
        openExact: () =>
          Effect.succeed({
            account: {
              id: 'account-a',
              providerType: 'ovhcloud',
              scope: 'organization',
              organizationId: 'org-a',
              revision: 4,
              status: 'active',
            },
            envelopeRevision: 8,
            credentialBytes: bytes,
          }),
      },
      registrationTokens: {
        hashFor: () => Effect.die('not used'),
        recoverBytes: () => Effect.die('must not open token'),
      },
      cloudInit: nodeBootstrapCloudInit,
      provider: { createOrAdopt: () => Effect.die('must not call provider') },
      repository: changed.repository,
      clock: { now: Effect.succeed({ iso: now, epochMilliseconds: Date.parse(now) }) },
      trustedBootstrap: {
        controlPlaneUrl: 'https://api.gridora.dev',
        expectedControlPlaneHost: 'api.gridora.dev',
        allowLoopbackHttp: false,
        agentVersion: '0.1.0',
        dockerSocket: '/var/run/docker.sock',
        pollWaitSeconds: 10,
        registrationTtlSeconds: 3600,
        commandSigningPublicKeyPem:
          '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----',
        providerInstanceDiscovery: {
          mode: 'image-metadata-helper-v1',
          helperUnit: 'gridora-node-bootstrap.service',
        },
      },
    })
    void originalOpen
    await expect(
      Effect.runPromise(
        service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionCredentialError' })
    expect(bytes.every((byte) => byte === 0)).toBe(true)

    const foreign = fixture({
      providerNode: providerNode({
        metadata: {
          managedBy: 'gridora',
          organizationId: 'org-foreign',
          nodeId: 'node-a',
          operationId: 'op-a',
          imageVersion: '2026.08.23',
        },
      }),
    })
    await expect(
      Effect.runPromise(
        foreign.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderValidationError' })
    expect(foreign.repository.persisted).toHaveLength(1)
    expect(foreign.repository.completion).toBeNull()
  })

  it('forwards the immutable Contabo commercial commitment unchanged', async () => {
    const test = fixture({ providerType: 'contabo' })
    const result = await Effect.runPromise(
      test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
    )
    expect(result.providerInstanceId).toBe('contabo-instance-a')
    expect(test.observedInput()?.createMode).toBe('create_or_adopt')
  })

  it('makes zero provider calls when a delayed retry reaches the trusted bootstrap expiry', async () => {
    let providerCalls = 0
    let trustedNow = now
    let first = true
    const expiredAt = '2026-08-23T18:00:00.000Z'
    const test = fixture({
      trustedNow: () => trustedNow,
      transport: () => {
        providerCalls += 1
        if (first) {
          first = false
          return Effect.fail(
            new ProviderCreateUncertainError({
              provider: 'ovhcloud',
              operation: 'createNode',
              message: 'response lost',
              organizationId: 'org-a',
              operationId: 'op-a',
              retryMode: 'adopt_only',
              stabilizationAttempts: 3,
              nextAttemptNumber: 2,
              nextAttemptAtEpochMs: Date.parse(now) + 1000,
              recoveryDeadlineAtEpochMs: Date.parse(now) + 15 * 60 * 1000,
            }),
          ) as never
        }
        return Effect.succeed(providerNode())
      },
    })
    await expect(
      Effect.runPromise(
        test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderCreateUncertainError' })
    trustedNow = expiredAt
    await expect(
      Effect.runPromise(
        test.service.execute({
          organizationId: 'org-a',
          operationId: 'op-a',
          attemptedAt: expiredAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'NodeProvisionExecutionValidationError',
      code: 'execution_reservation_invalid',
    })
    expect(providerCalls).toBe(1)
    expect(test.repository.status).toBe('retrying')
    expect(test.credentialBuffers).toHaveLength(1)
    expect(test.credentialBuffers[0]?.every((byte) => byte === 0)).toBe(true)
  })

  it('clears credentials, token, and cloud-init when provider execution is interrupted', async () => {
    const started = Deferred.makeUnsafe<void>()
    const test = fixture({
      transport: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(test.credentialBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expect(test.rawToken()?.every((byte) => byte === 0)).toBe(true)
    expect(test.cloudInit()?.every((byte) => byte === 0)).toBe(true)
  })

  it('keeps definite provider failure terminal and secret-free', async () => {
    const test = fixture({
      transport: () =>
        Effect.fail(
          new ProviderTemporaryError({
            provider: 'ovhcloud',
            operation: 'createNode',
            message: 'canary must not persist',
          }),
        ) as never,
    })
    await expect(
      Effect.runPromise(
        test.service.execute({ organizationId: 'org-a', operationId: 'op-a', attemptedAt: now }),
      ),
    ).rejects.toMatchObject({ _tag: 'ProviderTemporaryError' })
    expect(test.repository.status).toBe('retrying')
    expect(JSON.stringify(test.repository.persisted)).not.toContain('canary')
    expect(test.credentialBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expect(test.rawToken()?.every((byte) => byte === 0)).toBe(true)
    expect(test.cloudInit()?.every((byte) => byte === 0)).toBe(true)
  })
})

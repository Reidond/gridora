import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import {
  AtomicCredentialInstallerLayer,
  TunnelCredentialError,
  TunnelCredentialRepositoryLayer,
  TunnelCredentialService,
  TunnelCredentialServiceLive,
  type AtomicCredentialInstallResult,
  type TunnelCredentialInstallPayload,
  type TunnelCredentialRepositoryShape,
  type TunnelCredentialRevokePayload,
  type TunnelCredentialScope,
  type TunnelCredentialState,
} from '../src/index.js'

const scope: TunnelCredentialScope = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  tunnelId: 'tunnel-a',
}
const sealed = `v1.${'A'.repeat(32)}.${'B'.repeat(16)}.${'C'.repeat(48)}`
const now = '2026-08-23T10:00:00Z'
const install = (overrides: Partial<TunnelCredentialInstallPayload> = {}) => ({
  apiVersion: 'tunnel.gridora.dev/v1alpha1' as const,
  action: 'install' as const,
  deliveryId: 'delivery-1',
  organizationId: scope.organizationId,
  nodeId: scope.nodeId,
  tunnelId: scope.tunnelId,
  operationId: 'operation-1',
  revision: 1,
  expectedPriorRevision: 0,
  expiresAt: '2026-08-23T11:00:00Z',
  sealedCredential: sealed,
  destination: {
    path: '/var/lib/gridora/tunnel/credential' as const,
    owner: 'root' as const,
    group: 'root' as const,
    mode: '0600' as const,
  },
  ...overrides,
})
const revoke = (overrides: Partial<TunnelCredentialRevokePayload> = {}) => ({
  apiVersion: 'tunnel.gridora.dev/v1alpha1' as const,
  action: 'revoke' as const,
  deliveryId: 'delivery-revoke-2',
  organizationId: scope.organizationId,
  nodeId: scope.nodeId,
  tunnelId: scope.tunnelId,
  operationId: 'operation-revoke-2',
  revision: 2,
  expectedPriorRevision: 1,
  expiresAt: '2026-08-23T11:00:00Z',
  ...overrides,
})

interface HarnessOptions {
  readonly unsafeInstall?: boolean
  readonly failFirstWrite?: boolean
}
const harness = (options: HarnessOptions = {}) => {
  let state: TunnelCredentialState | null = null
  let failWrite = options.failFirstWrite ?? false
  let installs = 0
  let revocations = 0
  const installed = new Set<string>()
  const repository: TunnelCredentialRepositoryShape = {
    get: () => Effect.succeed(state),
    replace: (_scope, expectedRevision, next) =>
      Effect.suspend(() => {
        if (failWrite) {
          failWrite = false
          return Effect.fail(
            new TunnelCredentialError({
              operation: 'repository.replace',
              code: 'persistence-failed',
              message: 'tunnel credential operation failed',
            }),
          )
        }
        if ((state?.revision ?? null) !== expectedRevision)
          return Effect.fail(
            new TunnelCredentialError({
              operation: 'repository.replace',
              code: 'revision-conflict',
              message: 'tunnel credential operation failed',
            }),
          )
        state = next
        return Effect.void
      }),
  }
  const installer = {
    install: (command: TunnelCredentialInstallPayload) =>
      Effect.sync(() => {
        installs += 1
        const duplicate = installed.has(command.deliveryId)
        installed.add(command.deliveryId)
        return {
          organizationId: command.organizationId,
          nodeId: command.nodeId,
          tunnelId: command.tunnelId,
          operationId: command.operationId,
          deliveryId: command.deliveryId,
          revision: command.revision,
          owner: options.unsafeInstall ? ('nobody' as never) : ('root' as const),
          group: 'root' as const,
          mode: '0600' as const,
          usedAtomicRename: true,
          fsyncedFile: true,
          fsyncedDirectory: true,
          activated: true,
          healthChecked: true,
          healthy: true,
          alreadyInstalled: duplicate,
        } satisfies AtomicCredentialInstallResult
      }),
    revoke: (_command: TunnelCredentialRevokePayload) =>
      Effect.sync(() => {
        revocations += 1
        installed.clear()
        return { removed: true, activationStopped: true, alreadyRevoked: false }
      }),
  }
  const dependencies = Layer.merge(
    TunnelCredentialRepositoryLayer(repository),
    AtomicCredentialInstallerLayer(installer),
  )
  const layer = TunnelCredentialServiceLive.pipe(Layer.provide(dependencies))
  const execute = (command: unknown, authenticatedScope = scope, at = now) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TunnelCredentialService
        return yield* service.execute(authenticatedScope, command, at)
      }).pipe(Effect.provide(layer)),
    )
  return {
    execute,
    get state() {
      return state
    },
    get installs() {
      return installs
    },
    get revocations() {
      return revocations
    },
  }
}

describe('tunnel credential delivery', () => {
  it('installs a sealed credential and returns a token-free health acknowledgement', async () => {
    const test = harness()
    const acknowledgement = await test.execute(install())
    expect(acknowledgement).toMatchObject({ status: 'active', healthy: true, duplicate: false })
    expect(JSON.stringify(acknowledgement)).not.toContain(sealed)
    expect(test.state?.revision).toBe(1)
  })

  it('rejects cross-node and cross-organization delivery before installation', async () => {
    const test = harness()
    await expect(test.execute(install(), { ...scope, nodeId: 'node-b' })).rejects.toMatchObject({
      code: 'scope-mismatch',
    })
    await expect(
      test.execute(install(), { ...scope, organizationId: 'org-b' }),
    ).rejects.toMatchObject({ code: 'scope-mismatch' })
    expect(test.installs).toBe(0)
  })

  it('deduplicates an acknowledged delivery and rejects a different replay at its revision', async () => {
    const test = harness()
    await test.execute(install())
    await expect(test.execute(install())).resolves.toMatchObject({ duplicate: true })
    await expect(
      test.execute(install({ deliveryId: 'delivery-replay', operationId: 'operation-replay' })),
    ).rejects.toMatchObject({ code: 'replay-rejected' })
    expect(test.installs).toBe(1)
  })

  it('rejects expired, reordered, and skipped rotations', async () => {
    const test = harness()
    await expect(
      test.execute(install({ expiresAt: '2026-08-23T09:59:59Z' })),
    ).rejects.toMatchObject({ code: 'expired-command' })
    await test.execute(install())
    await test.execute(
      install({
        deliveryId: 'delivery-2',
        operationId: 'operation-2',
        revision: 2,
        expectedPriorRevision: 1,
      }),
    )
    await expect(test.execute(install())).rejects.toMatchObject({ code: 'revision-conflict' })
    await expect(
      test.execute(
        install({
          deliveryId: 'delivery-4',
          operationId: 'operation-4',
          revision: 4,
          expectedPriorRevision: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('recovers from response loss with an idempotent privileged install', async () => {
    const test = harness({ failFirstWrite: true })
    await expect(test.execute(install())).rejects.toMatchObject({ code: 'persistence-failed' })
    await expect(test.execute(install())).resolves.toMatchObject({ status: 'active' })
    expect(test.installs).toBe(2)
    await expect(test.execute(install())).resolves.toMatchObject({ duplicate: true })
    expect(test.installs).toBe(2)
  })

  it('rejects unsafe file metadata and does not persist activation', async () => {
    const test = harness({ unsafeInstall: true })
    await expect(test.execute(install())).rejects.toMatchObject({ code: 'unsafe-install' })
    expect(test.state).toBeNull()
  })

  it('redacts the sealed credential from decode, installer, and persistence errors', async () => {
    const malformed = { ...install(), sealedCredential: `plaintext-${'secret'.repeat(20)}` }
    const test = harness({ failFirstWrite: true })
    const errors: unknown[] = []
    for (const command of [malformed, install()]) {
      try {
        await test.execute(command)
      } catch (error) {
        errors.push(error)
      }
    }
    const rendered = JSON.stringify(errors)
    expect(rendered).not.toContain(sealed)
    expect(rendered).not.toContain(String(malformed.sealedCredential))
    expect(rendered).toContain('tunnel credential operation failed')
  })

  it('revokes the credential, stops activation, and fences the old install', async () => {
    const test = harness()
    await test.execute(install())
    const acknowledgement = await test.execute(revoke())
    expect(acknowledgement).toMatchObject({ status: 'revoked', healthy: false })
    expect(test.revocations).toBe(1)
    await expect(test.execute(revoke())).resolves.toMatchObject({ duplicate: true })
    await expect(test.execute(install())).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(test.revocations).toBe(1)
  })
})

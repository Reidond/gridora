import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
  NodeImageExecutionClaim,
  NodeImageExecutionRepositoryShape,
  NodeImageProviderRegistrationWork,
  NodeImageWorkflowReservation,
} from '@gridora/node-image-d1'
import type { ProviderImageRegistrationTransportShape } from '@gridora/provider-image-registration'
import { ProviderAuthenticationError } from '@gridora/provider-sdk'
import { makeNodeImageExecution } from '../src/index.js'

const now = {
  iso: '2026-09-01T12:00:00.000Z',
  epochMilliseconds: Date.parse('2026-09-01T12:00:00.000Z'),
}
const reservation: NodeImageWorkflowReservation = {
  operationId: 'image-op-provider-recovery',
  workflowStartRecordId: 'image-workflow-start:provider-recovery',
  requestFingerprint: 'a'.repeat(64),
  action: 'register-provider',
  imageId: 'node-image-20260901',
  scopeId: 'scope-ovh-gra',
  commandJson: '{"registrationId":"image-registration:image-op-provider-recovery"}',
}
const claim: NodeImageExecutionClaim = {
  disposition: 'execute',
  reservation,
  claimId: 'node-image-claim:recovery-0001',
  claimAttempt: 2,
}
const authority = {
  providerType: 'ovhcloud' as const,
  providerAccountId: 'platform-ovh',
  providerAccountRevision: 7,
  credentialReference: 'platform-secret-ovh-r7',
}
const work = (
  overrides: Partial<NodeImageProviderRegistrationWork> = {},
): NodeImageProviderRegistrationWork => ({
  registrationId: 'image-registration:image-op-provider-recovery',
  registrationRevision: 1,
  mode: 'custom-image',
  registrationState: 'pending',
  providerType: 'ovhcloud',
  providerAccountId: 'platform-ovh',
  providerAccountRevision: 7,
  credentialReference: 'platform-secret-ovh-r7',
  region: 'GRA11',
  architecture: 'amd64',
  imageId: 'node-image-20260901',
  version: '2026.09.01.1',
  sourceCommit: 'a'.repeat(40),
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  providerRequestId: null,
  adoptionAttempt: 1,
  adoptionDeadlineAtEpochMs: now.epochMilliseconds + 60 * 60 * 1000,
  mustAdoptOnly: true,
  ...overrides,
})

const repository = (
  input: {
    readonly currentWork?: NodeImageProviderRegistrationWork
    readonly preflight?: 'ok' | 'fail'
    readonly onTerminal?: (code: string) => void
    readonly onSettle?: () => void
    readonly onRelease?: (code: string) => void
    readonly onBeginDispatch?: () => void
  } = {},
): NodeImageExecutionRepositoryShape => ({
  loadExact: () => Effect.succeed(reservation),
  claimExact: () => Effect.succeed(claim),
  completeLocal: () => Effect.succeed({ status: 'completed' as const }),
  registrationWork: () => Effect.succeed(input.currentWork ?? work()),
  preflightProviderRegistration: () =>
    input.preflight === 'fail'
      ? Effect.fail({ _tag: 'NodeImageConflictError', code: 'registration_unavailable' } as never)
      : Effect.succeed(authority),
  beginProviderDispatch: () => {
    input.onBeginDispatch?.()
    return Effect.void
  },
  releasePreDispatch: ({ code }) => {
    input.onRelease?.(code)
    return Effect.succeed({ status: 'waiting-external' as const })
  },
  settleProviderRegistration: () => {
    input.onSettle?.()
    return Effect.succeed({ status: 'completed' as const })
  },
  failTerminal: ({ code }) => {
    input.onTerminal?.(code)
    return Effect.succeed({ status: 'failed-terminal' as const })
  },
})

const execution = (input: {
  readonly repository?: NodeImageExecutionRepositoryShape
  readonly transport?: ProviderImageRegistrationTransportShape
  readonly onResolve?: () => void
  readonly onArtifact?: () => void
  readonly clock?: typeof now
}) =>
  makeNodeImageExecution({
    repository: input.repository ?? repository(),
    artifacts: {
      locate: () => {
        input.onArtifact?.()
        return Effect.succeed('https://r2.gridora.internal/private/node-image')
      },
    },
    providers: {
      resolve: () => {
        input.onResolve?.()
        return Effect.succeed(
          input.transport ?? {
            registerOrAdopt: () =>
              Effect.succeed({
                kind: 'adopted' as const,
                providerImageId: 'ovh-image-1',
                providerRequestId: null,
              }),
          },
        )
      },
    },
    clock: { now: Effect.succeed(input.clock ?? now) },
  })

describe('node-image execution', () => {
  it('uses adopt-only discovery after a response-lost provider create and never reissues create permission', async () => {
    let settled = 0
    let receivedMode: string | undefined
    const result = await Effect.runPromise(
      execution({
        repository: repository({ onSettle: () => settled++ }),
        transport: {
          registerOrAdopt: (request) => {
            receivedMode = request.createMode
            return Effect.succeed({
              kind: 'adopted' as const,
              providerImageId: 'ovh-image-adopted',
              providerRequestId: 'req-1',
            })
          },
        },
      }).execute(reservation),
    )
    expect(result).toEqual({ status: 'completed' })
    expect(receivedMode).toBe('adopt_only')
    expect(settled).toBe(1)
  })

  it('does not open a provider transport when the account is disabled or its credential revision changed after claim', async () => {
    let artifacts = 0
    let transports = 0
    let terminal: string | undefined
    const result = await Effect.runPromise(
      execution({
        repository: repository({ preflight: 'fail', onTerminal: (code) => (terminal = code) }),
        onArtifact: () => artifacts++,
        onResolve: () => transports++,
      }).execute(reservation),
    )
    expect(result).toEqual({ status: 'failed-terminal' })
    // Artifact lookup is harmless; the paid credential/HTTP boundary is not opened.
    expect(artifacts).toBe(1)
    expect(transports).toBe(0)
    expect(terminal).toBe('provider_account_unavailable')
  })

  it('writes a redacted terminal outcome for a definitive provider authentication failure', async () => {
    let terminal: string | undefined
    const result = await Effect.runPromise(
      execution({
        repository: repository({ onTerminal: (code) => (terminal = code) }),
        transport: {
          registerOrAdopt: () =>
            Effect.fail(
              new ProviderAuthenticationError({
                provider: 'ovhcloud',
                operation: 'nodeImage.registerOrAdopt',
                message: 'secret text must not reach the D1 receipt',
              }),
            ),
        },
      }).execute(reservation),
    )
    expect(result).toEqual({ status: 'failed-terminal' })
    expect(terminal).toBe('provider_authentication_failed')
  })

  it('does not dispatch discovery or a provider POST after the persisted recovery deadline elapses', async () => {
    let artifacts = 0
    let transports = 0
    let terminal: string | undefined
    const expiredWork = work({
      adoptionDeadlineAtEpochMs: now.epochMilliseconds - 1,
      mustAdoptOnly: true,
    })
    const result = await Effect.runPromise(
      execution({
        repository: repository({
          currentWork: expiredWork,
          onTerminal: (code) => (terminal = code),
        }),
        onArtifact: () => artifacts++,
        onResolve: () => transports++,
      }).execute(reservation),
    )
    expect(result).toEqual({ status: 'failed-terminal' })
    expect(artifacts).toBe(0)
    expect(transports).toBe(0)
    expect(terminal).toBe('provider_reconciliation_required')
  })

  it('releases an artifact pre-dispatch failure so a later delivery still has exactly one create permission', async () => {
    let artifactAvailable = false
    let released: string | undefined
    let receivedMode: string | undefined
    let began = 0
    const instance = makeNodeImageExecution({
      repository: repository({
        currentWork: work({ mustAdoptOnly: false, adoptionAttempt: 0 }),
        onRelease: (code) => (released = code),
        onBeginDispatch: () => began++,
      }),
      artifacts: {
        locate: () =>
          artifactAvailable
            ? Effect.succeed('https://r2.gridora.internal/private/node-image')
            : Effect.fail({
                _tag: 'NodeImageExecutionError',
                code: 'artifact_locator_unavailable',
              } as never),
      },
      providers: {
        resolve: () =>
          Effect.succeed({
            registerOrAdopt: (request) => {
              receivedMode = request.createMode
              return Effect.succeed({
                kind: 'registered' as const,
                providerImageId: 'ovh-created-once',
                providerRequestId: null,
              })
            },
          }),
      },
      clock: { now: Effect.succeed(now) },
    })
    await expect(Effect.runPromise(instance.execute(reservation))).resolves.toEqual({
      status: 'waiting-external',
    })
    expect(released).toBe('artifact_locator_unavailable')
    expect(began).toBe(0)
    artifactAvailable = true
    await expect(Effect.runPromise(instance.execute(reservation))).resolves.toEqual({
      status: 'completed',
    })
    expect(began).toBe(1)
    expect(receivedMode).toBe('create_or_adopt')
  })

  it('releases a credential-transport unwrap failure before dispatch and does not terminalize it as provider uncertainty', async () => {
    let released: string | undefined
    let resolveAvailable = false
    const instance = makeNodeImageExecution({
      repository: repository({ onRelease: (code) => (released = code) }),
      artifacts: { locate: () => Effect.succeed('https://r2.gridora.internal/private/node-image') },
      providers: {
        resolve: () =>
          resolveAvailable
            ? Effect.succeed({
                registerOrAdopt: () =>
                  Effect.succeed({
                    kind: 'registered' as const,
                    providerImageId: 'ovh-created-after-unwrap',
                    providerRequestId: null,
                  }),
              })
            : Effect.fail({
                _tag: 'NodeImageExecutionError',
                code: 'provider_transport_unavailable',
              } as never),
      },
      clock: { now: Effect.succeed(now) },
    })
    await expect(Effect.runPromise(instance.execute(reservation))).resolves.toEqual({
      status: 'waiting-external',
    })
    expect(released).toBe('provider_transport_unavailable')
    resolveAvailable = true
    await expect(Effect.runPromise(instance.execute(reservation))).resolves.toEqual({
      status: 'completed',
    })
  })
})

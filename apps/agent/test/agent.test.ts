import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { healthStatus, redact } from '../src/health.js'
import { handleCommand } from '../src/processor.js'
import {
  AgentClock,
  CommandExecutor,
  MemoryCommandState,
  SignatureVerifier,
} from '../src/services.js'

const command = {
  apiVersion: 'agent.gridora.dev/v1alpha1',
  commandId: 'command-1',
  operationId: 'operation-1',
  organizationId: 'org-1',
  nodeId: 'node-1',
  resourceId: 'server-1',
  type: 'server.start',
  payloadSchemaVersion: 1,
  issuedAt: '2026-08-23T09:00:00Z',
  expiresAt: '2026-08-23T11:00:00Z',
  idempotencyKey: 'idem-1',
  expectedPriorRevision: 0,
  payload: { deploymentId: 'deployment-1' },
  signature: 's'.repeat(64),
} as const

describe('agent command boundary', () => {
  it('returns the stored result for duplicate delivery without executing twice', async () => {
    let executions = 0
    const layers = Layer.mergeAll(
      Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T10:00:00Z')) }),
      Layer.succeed(SignatureVerifier, { verify: () => Effect.succeed(true) }),
      Layer.succeed(CommandExecutor, {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return { revision: 1, code: 'started', message: 'started' }
          }),
      }),
      MemoryCommandState(),
    )
    const run = () =>
      Effect.runPromise(
        handleCommand(command, { organizationId: 'org-1', nodeId: 'node-1' }).pipe(
          Effect.provide(layers),
        ),
      )
    expect((await run())?.duplicate).toBe(false)
    expect((await run())?.duplicate).toBe(true)
    expect(executions).toBe(1)
  })
  it('never lowers revision state after a malformed stale command', async () => {
    let executions = 0
    const layers = Layer.mergeAll(
      Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T10:00:00Z')) }),
      Layer.succeed(SignatureVerifier, { verify: () => Effect.succeed(true) }),
      Layer.succeed(CommandExecutor, {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return { revision: 5, code: 'advanced', message: 'advanced' }
          }),
      }),
      MemoryCommandState(),
    )
    const run = (input: unknown) =>
      Effect.runPromise(
        handleCommand(input, { organizationId: 'org-1', nodeId: 'node-1' }).pipe(
          Effect.provide(layers),
        ),
      )
    await expect(run({ ...command, commandId: 'advance-to-5' })).resolves.toMatchObject({
      status: 'succeeded',
      revision: 5,
    })
    await expect(
      run({
        ...command,
        commandId: 'malformed-stale',
        expectedPriorRevision: 1,
        payload: {},
      }),
    ).resolves.toMatchObject({ status: 'rejected', revision: 5 })
    await expect(
      run({ ...command, commandId: 'valid-stale', expectedPriorRevision: 1 }),
    ).resolves.toMatchObject({
      status: 'rejected',
      revision: 5,
      code: 'revision-conflict',
    })
    expect(executions).toBe(1)
  })
  it('does not return a terminal acknowledgement for a concurrent busy duplicate', async () => {
    let executions = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const layers = Layer.mergeAll(
      Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T10:00:00Z')) }),
      Layer.succeed(SignatureVerifier, { verify: () => Effect.succeed(true) }),
      Layer.succeed(CommandExecutor, {
        execute: () =>
          Effect.tryPromise(async () => {
            executions += 1
            await gate
            return { revision: 1, code: 'started', message: 'started' }
          }),
      }),
      MemoryCommandState(),
    )
    const run = () =>
      Effect.runPromise(
        handleCommand(command, { organizationId: 'org-1', nodeId: 'node-1' }).pipe(
          Effect.provide(layers),
        ),
      )
    const executing = run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(run()).resolves.toBeUndefined()
    release?.()
    await expect(executing).resolves.toMatchObject({ status: 'succeeded' })
    expect(executions).toBe(1)
  })
  it('redacts nested credentials and bearer values', () => {
    const canaries = ['agent-client-secret-canary', 'agent-steam-guard-canary']
    const redacted = redact({
      token: 'value',
      message: `Authorization Bearer abc.def clientSecret=${canaries[0]}`,
      nested: [{ SteamGuardCode: canaries[1] }],
    })
    expect(redacted).toEqual({
      token: '[REDACTED]',
      message: 'Authorization Bearer [REDACTED] clientSecret=[REDACTED]',
      nested: [{ SteamGuardCode: '[REDACTED]' }],
    })
    for (const canary of canaries) expect(JSON.stringify(redacted)).not.toContain(canary)
  })
  it('reports Docker and disk health independently', () => {
    expect(
      healthStatus({
        version: '1',
        organizationId: 'o',
        nodeId: 'n',
        docker: { reachable: true },
        disk: { availableBytes: 5, totalBytes: 100 },
        checkedAt: 'now',
      }).status,
    ).toBe('degraded')
  })
})

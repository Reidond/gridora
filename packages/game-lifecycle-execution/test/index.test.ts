import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  makeAgentCommandSpec,
  makeDeploymentSpec,
  publishGameDns,
  teardownGameDns,
  verifyGameObservation,
  GameWorkflowStepError,
  type GameWorkflowPayload,
} from '../src/index.js'
import { executeGameWorkflowStep } from '../src/workflow.js'

const payload: GameWorkflowPayload = {
  schemaVersion: 1,
  organizationId: 'org-a',
  actorId: 'identity-a',
  operationId: 'operation-a',
  serverId: 'server-a',
  nodeId: 'node-a',
  deploymentId: 'deployment-a',
  plugin: { id: 'arma-reforger', version: '0.1.0' },
  image: {
    installer: `sha256:${'a'.repeat(64)}`,
    runtime: `sha256:${'b'.repeat(64)}`,
  },
  ports: [{ protocol: 'udp', containerPort: 2001, publicPort: 22001, purpose: 'game' }],
  resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
  config: {
    name: 'Frontline',
    scenarioId: 'scenario',
    maxPlayers: 32,
    visible: true,
    crossPlatform: true,
  },
  mods: [],
  configRevision: 1,
  modRevision: 0,
  expectedPriorRevision: 0,
  action: 'start',
  expiresAt: '2026-08-23T13:00:00.000Z',
}

const movePayload: GameWorkflowPayload = {
  ...payload,
  operationId: 'move-operation-a',
  action: 'move',
  targetNodeId: 'node-b',
}

describe('game lifecycle execution', () => {
  it('binds commands and containers to the real deployment identity', async () => {
    const deployment = await Effect.runPromise(makeDeploymentSpec(payload))
    expect(deployment.serverId).toBe('server-a')
    expect(deployment.deploymentId).toBe('deployment-a')
    const command = await Effect.runPromise(makeAgentCommandSpec(payload, 'start'))
    expect(command).toEqual({ type: 'server.start', payload: { deploymentId: 'deployment-a' } })
    const update = await Effect.runPromise(
      makeAgentCommandSpec({ ...payload, action: 'update' }, 'update'),
    )
    expect(update.payload).toMatchObject({
      serverId: 'server-a',
      deploymentId: 'deployment-a',
      operationId: 'operation-a',
    })
    expect(update.payload).not.toMatchObject({ deploymentId: 'server-a' })
  })

  it('requires the tenant and operation-bound observation, not node health', async () => {
    await expect(
      Effect.runPromise(
        verifyGameObservation(payload, 0, {
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: 'operation-a',
          observedRevision: 1,
          state: 'running',
          observedAt: '2026-08-23T12:01:00.000Z',
        }),
      ),
    ).resolves.toEqual({ revision: 1, state: 'running' })
    await expect(
      Effect.runPromise(
        verifyGameObservation(payload, 0, {
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: null,
          observedRevision: 1,
          state: 'running',
          observedAt: '2026-08-23T12:01:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'authoritative-observation-required' })
    await expect(
      Effect.runPromise(makeAgentCommandSpec(payload, 'verify-observation')),
    ).rejects.toMatchObject({
      code: 'authoritative-observation-required',
    })
  })

  it('publishes DNS-only A/AAAA ownership through the Cloudflare control boundary', async () => {
    const requests: unknown[] = []
    let published = false
    const api = {
      request: (request: unknown) => {
        requests.push(request)
        const method = (request as { readonly method?: string }).method
        if (method === 'GET')
          return Effect.succeed({
            result: published
              ? [
                  {
                    id: 'record-a',
                    type: 'A',
                    name: 'frontline.example.com',
                    content: '203.0.113.10',
                    comment: 'gridora:org=org-a;owner=server-a',
                  },
                ]
              : [],
          })
        if (method === 'POST') published = true
        return Effect.succeed({ result: { id: 'record-a' } })
      },
    }
    await Effect.runPromise(
      publishGameDns(api, {
        zoneId: 'zone-a',
        organizationId: 'org-a',
        serverId: 'server-a',
        hostname: 'frontline.example.com',
        target: '203.0.113.10',
      }),
    )
    expect(requests).toContainEqual(expect.objectContaining({ method: 'POST' }))
    expect(requests.at(-1)).toMatchObject({
      body: expect.objectContaining({ type: 'A', proxied: false, content: '203.0.113.10' }),
    })
    await Effect.runPromise(
      teardownGameDns(api, {
        zoneId: 'zone-a',
        organizationId: 'org-a',
        serverId: 'server-a',
        hostname: 'frontline.example.com',
        type: 'A',
        target: '203.0.113.10',
        providerRecordId: 'record-a',
      }),
    )
    await expect(
      Effect.runPromise(
        publishGameDns(api, {
          zoneId: 'zone-a',
          organizationId: 'org-a',
          serverId: 'server-a',
          hostname: 'frontline.example.com',
          target: 'not-an-ip',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-endpoint-target' })
  })

  it('keeps command acceptance distinct from observation-backed completion', async () => {
    const accepted = await Effect.runPromise(
      executeGameWorkflowStep(payload, 'start', {
        dispatch: () =>
          Effect.succeed({
            commandId: 'command-a',
            operationId: 'operation-a',
            step: 'start' as const,
            status: 'succeeded' as const,
            delivery: 'executed' as const,
            revision: 1,
          }),
        readObservation: () =>
          Effect.fail(
            new GameWorkflowStepError({
              code: 'unexpected-read',
              message: 'must not read before dispatch',
            }),
          ),
        complete: (_payload, step) =>
          Effect.succeed({
            organizationId: 'org-a',
            serverId: 'server-a',
            operationId: 'operation-a',
            step,
            revision: 1,
          }),
      }),
    )
    expect(accepted).toEqual({
      status: 'completed',
      step: 'start',
      commandId: 'command-a',
      revision: 1,
    })
    const verified = await Effect.runPromise(
      executeGameWorkflowStep(payload, 'verify-observation', {
        dispatch: () =>
          Effect.fail(
            new GameWorkflowStepError({
              code: 'unexpected-dispatch',
              message: 'must not dispatch verification',
            }),
          ),
        readObservation: () =>
          Effect.succeed({
            organizationId: 'org-a',
            serverId: 'server-a',
            operationId: 'operation-a',
            observedRevision: 1,
            state: 'running',
            observedAt: '2026-08-23T12:01:00.000Z',
          }),
        complete: (_payload, step) =>
          Effect.succeed({
            organizationId: 'org-a',
            serverId: 'server-a',
            operationId: 'operation-a',
            step,
            revision: 1,
          }),
      }),
    )
    expect(verified).toEqual({ status: 'verified', step: 'verify-observation', revision: 1 })
  })

  it('fails rejected terminal commands and refuses coordinator no-ops', async () => {
    await expect(
      Effect.runPromise(
        executeGameWorkflowStep(payload, 'start', {
          dispatch: () =>
            Effect.succeed({
              commandId: 'command-rejected',
              operationId: 'operation-a',
              step: 'start' as const,
              status: 'rejected' as const,
              delivery: 'executed' as const,
              revision: null,
            }),
          readObservation: () =>
            Effect.fail(
              new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' }),
            ),
          complete: (_payload, step) =>
            Effect.succeed({
              organizationId: 'org-a',
              serverId: 'server-a',
              operationId: 'operation-a',
              step,
              revision: 1,
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'command-rejected' })
    await expect(
      Effect.runPromise(
        executeGameWorkflowStep(payload, 'reserve', {
          dispatch: () =>
            Effect.fail(
              new GameWorkflowStepError({ code: 'unexpected-dispatch', message: 'not used' }),
            ),
          readObservation: () =>
            Effect.fail(
              new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' }),
            ),
          complete: (_payload, step) =>
            Effect.succeed({
              organizationId: 'org-a',
              serverId: 'server-a',
              operationId: 'operation-a',
              step,
              revision: 1,
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'coordinator-evidence-missing' })
  })

  it('requires explicit no-domain evidence for optional DNS workflow steps', async () => {
    const noDomain: Parameters<typeof executeGameWorkflowStep>[2] = {
      dispatch: () =>
        Effect.fail(
          new GameWorkflowStepError({ code: 'unexpected-dispatch', message: 'not used' }),
        ),
      readObservation: () =>
        Effect.fail(new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' })),
      verifyNoDns: () =>
        Effect.succeed({
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: 'operation-a',
        }),
      complete: (_payload, step) =>
        Effect.succeed({
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: 'operation-a',
          step,
          revision: 1,
        }),
    }
    await expect(
      Effect.runPromise(executeGameWorkflowStep(payload, 'publish-endpoint', noDomain)),
    ).resolves.toMatchObject({ status: 'completed' })
    await expect(
      Effect.runPromise(executeGameWorkflowStep(payload, 'delete-dns', noDomain)),
    ).resolves.toMatchObject({ status: 'completed' })
  })

  it.each(['restore-target', 'verify-target', 'cutover-endpoint', 'release-source'] as const)(
    'physically compensates a stopped move when %s fails',
    async (failedStep) => {
      const calls: string[] = []
      const failure = new GameWorkflowStepError({
        code: `injected-${failedStep}`,
        message: `${failedStep} failed after the source stop`,
      })
      const dependencies: Parameters<typeof executeGameWorkflowStep>[2] = {
        dispatch: () =>
          Effect.fail(
            new GameWorkflowStepError({ code: 'unexpected-dispatch', message: 'not used' }),
          ),
        readObservation: () =>
          Effect.fail(new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' })),
        complete: (_payload, step) =>
          Effect.succeed({
            organizationId: 'org-a',
            serverId: 'server-a',
            operationId: 'move-operation-a',
            step,
            revision: 1,
          }),
        move: (_payload, step) => {
          calls.push(step)
          if (step === failedStep) return Effect.fail(failure)
          if (step === 'rollback-if-required')
            return Effect.succeed({
              organizationId: 'org-a',
              serverId: 'server-a',
              operationId: 'move-operation-a',
              step,
              revision: 7,
            })
          return Effect.fail(
            new GameWorkflowStepError({ code: 'unexpected-move-step', message: step }),
          )
        },
      }
      await expect(
        Effect.runPromise(executeGameWorkflowStep(movePayload, failedStep, dependencies)),
      ).rejects.toMatchObject({
        code: `injected-${failedStep}`,
      })
      expect(calls).toEqual([failedStep, 'rollback-if-required'])
    },
  )

  it('compensates a successful stop-source command when its durable move transition fails', async () => {
    const calls: string[] = []
    const dependencies: Parameters<typeof executeGameWorkflowStep>[2] = {
      dispatch: (_payload, step) => {
        calls.push(`dispatch:${step}`)
        return Effect.succeed({
          commandId: 'source-stop-command',
          operationId: 'move-operation-a',
          step,
          status: 'succeeded' as const,
          delivery: 'executed' as const,
          revision: 1,
        })
      },
      readObservation: () =>
        Effect.fail(new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' })),
      complete: (_payload, step) =>
        Effect.succeed({
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: 'move-operation-a',
          step,
          revision: 1,
        }),
      move: (_payload, step) => {
        calls.push(`move:${step}`)
        if (step === 'stop-source')
          return Effect.fail(
            new GameWorkflowStepError({
              code: 'stop-transition-lost',
              message: 'the source command completed before its D1 transition failed',
            }),
          )
        if (step === 'rollback-if-required')
          return Effect.succeed({
            organizationId: 'org-a',
            serverId: 'server-a',
            operationId: 'move-operation-a',
            step,
            revision: 3,
          })
        return Effect.fail(
          new GameWorkflowStepError({ code: 'unexpected-move-step', message: step }),
        )
      },
    }
    await expect(
      Effect.runPromise(executeGameWorkflowStep(movePayload, 'stop-source', dependencies)),
    ).rejects.toMatchObject({
      code: 'stop-transition-lost',
    })
    expect(calls).toEqual(['dispatch:stop-source', 'move:stop-source', 'move:rollback-if-required'])
  })

  it('refuses a response-lost move failure if rollback evidence is foreign or incomplete', async () => {
    const dependencies: Parameters<typeof executeGameWorkflowStep>[2] = {
      dispatch: () =>
        Effect.fail(
          new GameWorkflowStepError({ code: 'unexpected-dispatch', message: 'not used' }),
        ),
      readObservation: () =>
        Effect.fail(new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' })),
      complete: (_payload, step) =>
        Effect.succeed({
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: 'move-operation-a',
          step,
          revision: 1,
        }),
      move: (_payload, step) =>
        step === 'restore-target'
          ? Effect.fail(
              new GameWorkflowStepError({
                code: 'restore-response-lost',
                message: 'target reply was lost',
              }),
            )
          : Effect.succeed({
              organizationId: 'org-a',
              serverId: 'foreign-server',
              operationId: 'move-operation-a',
              step,
              revision: 7,
            }),
    }
    await expect(
      Effect.runPromise(executeGameWorkflowStep(movePayload, 'restore-target', dependencies)),
    ).rejects.toMatchObject({
      code: 'move-compensation-evidence-mismatch',
    })
  })

  it('surfaces a physical rollback failure after a post-stop move failure', async () => {
    const dependencies: Parameters<typeof executeGameWorkflowStep>[2] = {
      dispatch: () =>
        Effect.fail(
          new GameWorkflowStepError({ code: 'unexpected-dispatch', message: 'not used' }),
        ),
      readObservation: () =>
        Effect.fail(new GameWorkflowStepError({ code: 'unexpected-read', message: 'not used' })),
      complete: (_payload, step) =>
        Effect.succeed({
          organizationId: 'org-a',
          serverId: 'server-a',
          operationId: 'move-operation-a',
          step,
          revision: 1,
        }),
      move: (_payload, step) =>
        step === 'cutover-endpoint'
          ? Effect.fail(
              new GameWorkflowStepError({
                code: 'cutover-failed',
                message: 'provider transfer failed',
              }),
            )
          : Effect.fail(
              new GameWorkflowStepError({
                code: 'rollback-failed',
                message: 'reverse provider transfer failed',
              }),
            ),
    }
    await expect(
      Effect.runPromise(executeGameWorkflowStep(movePayload, 'cutover-endpoint', dependencies)),
    ).rejects.toMatchObject({
      code: 'move-compensation-failed',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { runWorkflowPlan, type DurableStep } from '../src/workflow-plan.js'

describe('Phase-0 durable workflow plan', () => {
  it('resumes after a forced failure without re-running completed steps', async () => {
    const completed = new Map<string, unknown>()
    const calls = new Map<string, number>()
    const durableStep: DurableStep = async (name, _options, action) => {
      if (completed.has(name)) return
      calls.set(name, (calls.get(name) ?? 0) + 1)
      await action()
      completed.set(name, true)
    }
    let failInspection = true
    const execute = async (_payload: { operationId: string }, name: string) => {
      if (name === 'inspect-provider-resource' && failInspection) {
        failInspection = false
        throw new Error('forced retry')
      }
      return { status: 'completed' }
    }
    const publish = async () => undefined
    const payload = { operationId: 'op_phase0' }
    const steps = ['record-operation-started', 'inspect-provider-resource', 'notify-administrator']
    await expect(runWorkflowPlan(payload, steps, durableStep, execute, publish)).rejects.toThrow(
      'forced retry',
    )
    await expect(runWorkflowPlan(payload, steps, durableStep, execute, publish)).resolves.toEqual({
      operationId: 'op_phase0',
      completedSteps: 3,
    })
    expect(calls.get('01-record-operation-started')).toBe(1)
    expect(calls.get('01-publish-progress')).toBe(1)
    expect(calls.get('02-inspect-provider-resource')).toBe(2)
    expect(calls.get('03-notify-administrator')).toBe(1)
  })

  it('retries progress publication without re-executing a completed operation step', async () => {
    const completed = new Set<string>()
    const calls = new Map<string, number>()
    const durableStep: DurableStep = async (name, _options, action) => {
      if (completed.has(name)) return
      calls.set(name, (calls.get(name) ?? 0) + 1)
      await action()
      completed.add(name)
    }
    let failProgress = true
    const payload = { operationId: 'op_progress' }
    const execute = async () => undefined
    const publish = async () => {
      if (failProgress) {
        failProgress = false
        throw new Error('realtime unavailable')
      }
    }
    await expect(
      runWorkflowPlan(payload, ['inspect-provider-resource'], durableStep, execute, publish),
    ).rejects.toThrow('realtime unavailable')
    await expect(
      runWorkflowPlan(payload, ['inspect-provider-resource'], durableStep, execute, publish),
    ).resolves.toEqual({ operationId: 'op_progress', completedSteps: 1 })
    expect(calls.get('01-inspect-provider-resource')).toBe(1)
    expect(calls.get('01-publish-progress')).toBe(2)
  })

  it('persists adopt-only recovery across restart and sleeps until delayed provider visibility', async () => {
    const completed = new Map<string, unknown>()
    const durableStep: DurableStep = async (name, _options, action) => {
      if (completed.has(name)) return completed.get(name)
      const result = await action()
      completed.set(name, result)
      return result
    }
    let creates = 0
    let adopts = 0
    let restartBeforeAdopt = true
    const sleepTimestamps: Array<string> = []
    const payload = { operationId: 'op_uncertain' }
    const steps = ['create-or-adopt-instance']
    const execute = async () => {
      creates += 1
      return {
        status: 'waiting',
        retryMode: 'adopt_only' as const,
        nextAttemptAt: '2026-08-23T12:01:00.000Z',
        recoveryDeadlineAt: '2026-08-23T12:15:00.000Z',
      }
    }
    const options = {
      sleepUntil: async (_name: string, timestamp: Date) => {
        sleepTimestamps.push(timestamp.toISOString())
        if (restartBeforeAdopt) {
          restartBeforeAdopt = false
          throw new Error('workflow restarted')
        }
      },
      executeAdoptOnly: async (
        _input: typeof payload,
        _stepName: string,
        _ordinal: number,
        state: { retryMode: 'adopt_only'; attempt: number; previousNextAttemptAt: string },
      ) => {
        adopts += 1
        expect(state).toEqual({
          retryMode: 'adopt_only',
          attempt: adopts,
          previousNextAttemptAt: '2026-08-23T12:01:00.000Z',
        })
        return adopts < 3
          ? {
              status: 'waiting',
              retryMode: 'adopt_only' as const,
              nextAttemptAt: '2026-08-23T12:01:00.000Z',
              recoveryDeadlineAt: '2026-08-23T12:15:00.000Z',
            }
          : { status: 'adopted' }
      },
    }
    await expect(
      runWorkflowPlan(payload, steps, durableStep, execute, async () => undefined, options),
    ).rejects.toThrow('workflow restarted')
    expect(completed.get('01-create-or-adopt-instance')).toMatchObject({ retryMode: 'adopt_only' })
    await expect(
      runWorkflowPlan(payload, steps, durableStep, execute, async () => undefined, options),
    ).resolves.toEqual({ operationId: 'op_uncertain', completedSteps: 1 })
    expect(creates).toBe(1)
    expect(adopts).toBe(3)
    expect(sleepTimestamps).toEqual([
      '2026-08-23T12:01:00.000Z',
      '2026-08-23T12:01:00.000Z',
      '2026-08-23T12:01:00.000Z',
      '2026-08-23T12:01:00.000Z',
    ])
  })

  it('stops bounded adopt-only polling without converting uncertainty into terminal absence', async () => {
    const durableStep: DurableStep = async (_name, _options, action) => action()
    let adopts = 0
    const waiting = {
      status: 'waiting',
      retryMode: 'adopt_only' as const,
      nextAttemptAt: '2026-08-23T12:01:00.000Z',
      recoveryDeadlineAt: '2026-08-23T12:15:00.000Z',
    }
    await expect(
      runWorkflowPlan(
        { operationId: 'op-exhausted' },
        ['create-or-adopt-instance'],
        durableStep,
        async () => waiting,
        async () => undefined,
        {
          sleepUntil: async () => undefined,
          executeAdoptOnly: async () => {
            adopts += 1
            return waiting
          },
        },
      ),
    ).rejects.toThrow('read-only orphan reconciliation')
    expect(adopts).toBe(12)
  })

  it('honors an explicit bounded recovery window for long-running parent cleanup', async () => {
    const durableStep: DurableStep = async (_name, _options, action) => action()
    let adopts = 0
    const waiting = {
      status: 'waiting',
      retryMode: 'adopt_only' as const,
      nextAttemptAt: '2026-08-23T12:01:00.000Z',
      recoveryDeadlineAt: '2026-08-24T12:15:00.000Z',
    }
    await expect(
      runWorkflowPlan(
        { operationId: 'op-parent-cleanup' },
        ['wait-for-children'],
        durableStep,
        async () => waiting,
        async () => undefined,
        {
          maxRecoveryAttempts: 13,
          sleepUntil: async () => undefined,
          executeAdoptOnly: async () => {
            adopts += 1
            return waiting
          },
        },
      ),
    ).rejects.toThrow('read-only orphan reconciliation')
    expect(adopts).toBe(13)
  })
})

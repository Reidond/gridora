import { describe, expect, it } from 'vitest'
import {
  runServerProvisionPlan,
  type ServerProvisionPlanRunner,
  type ServerProvisionPlanStepName,
} from '../src/server-provision-plan-runner.js'

const runnerFor = (overrides: Partial<ServerProvisionPlanRunner> = {}) => {
  const calls: Array<{ readonly step: ServerProvisionPlanStepName; readonly ordinal: number }> = []
  const sleeps: string[] = []
  const runner: ServerProvisionPlanRunner = {
    execute: async (step, ordinal) => {
      calls.push({ step, ordinal })
      if (step === 'submit-node' || step === 'wait-node-ready' || step === 'reserve-and-deploy')
        return { status: 'completed' }
      if (step === 'wait-game-deployment' || step === 'wait-compensation')
        return { status: 'completed' }
      return { status: 'completed' }
    },
    sleep: async (name) => {
      sleeps.push(name)
    },
    publish: async () => undefined,
    ...overrides,
  }
  return { runner, calls, sleeps }
}

const compensationCalls = (
  calls: readonly { readonly step: ServerProvisionPlanStepName; readonly ordinal: number }[],
) => calls.filter((call) => call.step === 'compensate-node' || call.step === 'wait-compensation')

describe('server provision plan Workflow compensation', () => {
  it('retires the exact recorded temporary node after readiness retries exhaust', async () => {
    const { runner, calls, sleeps } = runnerFor({
      execute: async (step, ordinal) => {
        calls.push({ step, ordinal })
        if (step === 'submit-node') return { status: 'completed' }
        if (step === 'wait-node-ready') return { status: 'waiting' }
        if (step === 'compensate-node' || step === 'wait-compensation')
          return { status: 'completed' }
        return { status: 'completed' }
      },
    })

    await expect(runServerProvisionPlan(runner)).rejects.toThrow(
      'node readiness did not receive authoritative agent/capacity evidence',
    )
    expect(compensationCalls(calls)).toEqual([
      { step: 'compensate-node', ordinal: 243 },
      { step: 'wait-compensation', ordinal: 244 },
    ])
    expect(sleeps).toHaveLength(120)
  })

  it('retires after a terminal readiness failure once the node child is durable', async () => {
    const { runner, calls } = runnerFor({
      execute: async (step, ordinal) => {
        calls.push({ step, ordinal })
        if (step === 'submit-node') return { status: 'completed' }
        if (step === 'wait-node-ready')
          return { status: 'failed', reason: 'agent registration rejected' }
        return { status: 'completed' }
      },
    })

    await expect(runServerProvisionPlan(runner)).rejects.toThrow('agent registration rejected')
    expect(compensationCalls(calls)).toEqual([
      { step: 'compensate-node', ordinal: 243 },
      { step: 'wait-compensation', ordinal: 244 },
    ])
  })

  it('compensates a non-completed server reservation after the node child exists', async () => {
    const { runner, calls } = runnerFor({
      execute: async (step, ordinal) => {
        calls.push({ step, ordinal })
        if (step === 'reserve-and-deploy') return { status: 'waiting' }
        return { status: 'completed' }
      },
    })

    await expect(runServerProvisionPlan(runner)).rejects.toThrow(
      'reserve-and-deploy did not reach a durable completed state',
    )
    expect(compensationCalls(calls)).toEqual([
      { step: 'compensate-node', ordinal: 243 },
      { step: 'wait-compensation', ordinal: 244 },
    ])
  })

  it('compensates an execution exception after node acceptance and waits for terminal proof', async () => {
    const { runner, calls } = runnerFor({
      execute: async (step, ordinal) => {
        calls.push({ step, ordinal })
        if (step === 'reserve-and-deploy')
          throw new Error('injected game reservation response loss')
        return { status: 'completed' }
      },
    })

    await expect(runServerProvisionPlan(runner)).rejects.toThrow(
      'injected game reservation response loss',
    )
    expect(compensationCalls(calls)).toEqual([
      { step: 'compensate-node', ordinal: 243 },
      { step: 'wait-compensation', ordinal: 244 },
    ])
  })

  it('does not report a failed deployment terminally until compensation has terminal evidence', async () => {
    const { runner, calls } = runnerFor({
      execute: async (step, ordinal) => {
        calls.push({ step, ordinal })
        if (step === 'wait-game-deployment')
          return { status: 'failed', reason: 'agent deployment failed' }
        if (step === 'wait-compensation') return { status: 'waiting' }
        return { status: 'completed' }
      },
    })

    await expect(runServerProvisionPlan(runner)).rejects.toThrow(
      'exact node compensation did not reach terminal evidence',
    )
    expect(compensationCalls(calls)[0]).toEqual({ step: 'compensate-node', ordinal: 243 })
    expect(compensationCalls(calls)).toHaveLength(121)
  })

  it('never compensates when submit-node itself has no durable child acceptance', async () => {
    const { runner, calls } = runnerFor({
      execute: async (step, ordinal) => {
        calls.push({ step, ordinal })
        if (step === 'submit-node') throw new Error('node admission rejected before acceptance')
        return { status: 'completed' }
      },
    })

    await expect(runServerProvisionPlan(runner)).rejects.toThrow(
      'node admission rejected before acceptance',
    )
    expect(compensationCalls(calls)).toEqual([])
  })
})

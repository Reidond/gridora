/**
 * The provider-neutral parent sequence is kept outside the Worker entrypoint
 * so failure paths can be exercised without a live Workflow binding.  A
 * successful `submit-node` is the durable point after which the parent owns
 * compensation for its exact temporary node child.
 */
export type ServerProvisionPlanStepName =
  | 'submit-node'
  | 'wait-node-ready'
  | 'reserve-and-deploy'
  | 'wait-game-deployment'
  | 'compensate-node'
  | 'wait-compensation'

export interface ServerProvisionPlanStepResult {
  readonly status: 'completed' | 'waiting' | 'failed'
  readonly reason?: string | undefined
}

export interface ServerProvisionPlanRunner {
  readonly execute: (
    stepName: ServerProvisionPlanStepName,
    ordinal: number,
  ) => Promise<ServerProvisionPlanStepResult>
  readonly sleep: (name: string) => Promise<void>
  /** Progress fan-out is observational; it cannot make a completed mutation fail. */
  readonly publish: (stepName: string, progress: number) => Promise<void>
}

const reasonOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback

const requireCompleted = (result: ServerProvisionPlanStepResult, name: string) => {
  if (result.status === 'failed')
    throw new Error(result.reason ?? `${name} reached a terminal failure`)
  if (result.status !== 'completed')
    throw new Error(`${name} did not reach a durable completed state`)
}

const publishBestEffort = async (
  runner: ServerProvisionPlanRunner,
  stepName: string,
  progress: number,
) => {
  try {
    await runner.publish(stepName, progress)
  } catch {
    // The durable operation state is authoritative. Realtime fan-out can be
    // retried independently and must not retire a successfully deployed node.
  }
}

/**
 * Runs the accepted parent plan. Every error after `submit-node` has
 * durably recorded a parent-to-node link, so the failure path always starts
 * and waits for that exact retirement child before surfacing the failure.
 */
export const runServerProvisionPlan = async (runner: ServerProvisionPlanRunner): Promise<void> => {
  let nodeSubmitted = false

  const compensate = async (reason: string) => {
    requireCompleted(await runner.execute('compensate-node', 243), 'compensate-node')
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await runner.execute('wait-compensation', attempt + 244)
      if (result.status === 'failed')
        throw new Error(result.reason ?? 'node retirement compensation reached a terminal failure')
      if (result.status === 'completed') return
      await runner.sleep(`server-provision-compensation-${attempt}`)
    }
    throw new Error(`server provision compensation did not reach terminal evidence: ${reason}`)
  }

  try {
    requireCompleted(await runner.execute('submit-node', 0), 'submit-node')
    nodeSubmitted = true
    await publishBestEffort(runner, 'submit-node', 20)

    let ready = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await runner.execute('wait-node-ready', attempt + 1)
      if (result.status === 'failed')
        throw new Error(result.reason ?? 'node provisioning reached a terminal failure')
      if (result.status === 'completed') {
        ready = true
        break
      }
      await runner.sleep(`server-provision-node-readiness-${attempt}`)
    }
    if (!ready)
      throw new Error('node readiness did not receive authoritative agent/capacity evidence')
    await publishBestEffort(runner, 'wait-node-ready', 55)

    requireCompleted(await runner.execute('reserve-and-deploy', 122), 'reserve-and-deploy')
    await publishBestEffort(runner, 'reserve-and-deploy', 75)

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await runner.execute('wait-game-deployment', attempt + 123)
      if (result.status === 'failed')
        throw new Error(result.reason ?? 'game deployment reached a terminal failure')
      if (result.status === 'completed') {
        await publishBestEffort(runner, 'wait-game-deployment', 100)
        return
      }
      await runner.sleep(`server-provision-game-observation-${attempt}`)
    }
    throw new Error('game deployment did not receive a terminal observation')
  } catch (cause) {
    if (!nodeSubmitted) throw cause
    const reason = reasonOf(cause, 'server provision did not reach verified deployment')
    try {
      await compensate(reason)
    } catch (compensationError) {
      throw new Error(
        `${reason}; exact node compensation did not reach terminal evidence: ${reasonOf(
          compensationError,
          'unknown compensation failure',
        )}`,
      )
    }
    throw cause
  }
}

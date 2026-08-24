export interface WorkflowPlanResult {
  readonly operationId: string
  readonly completedSteps: number
}

export type DurableStep = (
  name: string,
  options: Readonly<Record<string, unknown>>,
  action: () => Promise<unknown>,
) => Promise<unknown>

export interface ProviderCreateRecoveryState {
  readonly retryMode: 'adopt_only'
  readonly nextAttemptAt: string
  readonly recoveryDeadlineAt: string
}

export interface WorkflowPlanOptions<Payload> {
  readonly maxRecoveryAttempts?: number | undefined
  readonly sleepUntil?: ((name: string, timestamp: Date) => Promise<void>) | undefined
  readonly executeAdoptOnly?: (
    payload: Payload,
    stepName: string,
    ordinal: number,
    state: {
      readonly retryMode: 'adopt_only'
      readonly attempt: number
      readonly previousNextAttemptAt: string
    },
  ) => Promise<unknown>
}

const providerCreateRecovery = (result: unknown): ProviderCreateRecoveryState | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  if (!('retryMode' in result) || result.retryMode !== 'adopt_only') return undefined
  if (!('nextAttemptAt' in result) || typeof result.nextAttemptAt !== 'string') return undefined
  if (!('recoveryDeadlineAt' in result) || typeof result.recoveryDeadlineAt !== 'string')
    return undefined
  return {
    retryMode: 'adopt_only',
    nextAttemptAt: result.nextAttemptAt,
    recoveryDeadlineAt: result.recoveryDeadlineAt,
  }
}

export const runWorkflowPlan = async <Payload extends { readonly operationId: string }>(
  payload: Payload,
  stepNames: ReadonlyArray<string>,
  durableStep: DurableStep,
  execute: (payload: Payload, stepName: string, ordinal: number) => Promise<unknown>,
  publish: (payload: Payload, stepName: string, ordinal: number) => Promise<void>,
  options: WorkflowPlanOptions<Payload> = {},
): Promise<WorkflowPlanResult> => {
  for (const [ordinal, stepName] of stepNames.entries()) {
    let result = await durableStep(
      `${String(ordinal + 1).padStart(2, '0')}-${stepName}`,
      { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      () => execute(payload, stepName, ordinal),
    )
    let recovery = providerCreateRecovery(result)
    let recoveryAttempt = 0
    while (recovery !== undefined) {
      if (options.sleepUntil === undefined || options.executeAdoptOnly === undefined) {
        throw new Error('Provider create recovery requires durable sleep and adopt-only execution')
      }
      const executeAdoptOnly = options.executeAdoptOnly
      recoveryAttempt += 1
      const nextAttempt = new Date(recovery.nextAttemptAt)
      const recoveryDeadline = new Date(recovery.recoveryDeadlineAt)
      if (
        Number.isNaN(nextAttempt.getTime()) ||
        Number.isNaN(recoveryDeadline.getTime()) ||
        nextAttempt.getTime() > recoveryDeadline.getTime() ||
        recoveryAttempt > (options.maxRecoveryAttempts ?? 12)
      )
        throw new Error('Provider create recovery requires read-only orphan reconciliation')
      await options.sleepUntil(
        `${String(ordinal + 1).padStart(2, '0')}-${stepName}-visibility-${recoveryAttempt}`,
        nextAttempt,
      )
      const previousNextAttemptAt = recovery.nextAttemptAt
      result = await durableStep(
        `${String(ordinal + 1).padStart(2, '0')}-${stepName}-adopt-only-${recoveryAttempt}`,
        {
          retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
          timeout: '2 minutes',
        },
        () =>
          executeAdoptOnly(payload, stepName, ordinal, {
            retryMode: 'adopt_only',
            attempt: recoveryAttempt,
            previousNextAttemptAt,
          }),
      )
      recovery = providerCreateRecovery(result)
    }
    await durableStep(
      `${String(ordinal + 1).padStart(2, '0')}-publish-progress`,
      { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
      () => publish(payload, stepName, ordinal),
    )
  }
  return { operationId: payload.operationId, completedSteps: stepNames.length }
}

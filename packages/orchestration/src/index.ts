import { Effect, Schema } from 'effect'

export class OperationStepError extends Schema.TaggedError<OperationStepError>()(
  'OperationStepError',
  { stepId: Schema.String, message: Schema.String, retryable: Schema.Boolean },
) {}
export interface OperationContext {
  readonly organizationId: string
  readonly operationId: string
  readonly resourceId: string
  readonly actorId: string
  readonly correlationId: string
}
export interface OperationStep<A = unknown> {
  readonly id: string
  readonly description: string
  readonly destructive: boolean
  readonly run: (context: OperationContext) => Effect.Effect<A, OperationStepError>
  readonly compensate?: (
    context: OperationContext,
    result: A,
  ) => Effect.Effect<void, OperationStepError>
}
export interface OperationPlan {
  readonly kind:
    | 'provision-node'
    | 'deploy-server'
    | 'update-server'
    | 'backup-server'
    | 'restore-server'
    | 'move-server'
    | 'retire-node'
  readonly context: OperationContext
  readonly steps: readonly OperationStep[]
  readonly cancellation: 'before-destructive-step' | 'between-steps' | 'not-cancellable'
  readonly summary: readonly string[]
}
export const planDeployment = (
  context: OperationContext,
  steps: {
    readonly reserveCapacity: OperationStep
    readonly reservePorts: OperationStep
    readonly install: OperationStep
    readonly configure: OperationStep
    readonly start: OperationStep
  },
): OperationPlan => ({
  kind: 'deploy-server',
  context,
  cancellation: 'between-steps',
  summary: [
    'Reserve capacity and ports atomically',
    'Install immutable plugin plan',
    'Stage and activate configuration',
    'Start and verify protocol health',
  ],
  steps: [steps.reserveCapacity, steps.reservePorts, steps.install, steps.configure, steps.start],
})
export const planMove = (
  context: OperationContext,
  steps: readonly OperationStep[],
): OperationPlan => ({
  kind: 'move-server',
  context,
  cancellation: 'before-destructive-step',
  summary: [
    'Stop source',
    'Create and verify backup',
    'Deploy target',
    'Restore and validate target',
    'Switch DNS and ports',
    'Clean up positively identified source',
  ],
  steps,
})
export interface CompletedStep {
  readonly step: OperationStep
  readonly result: unknown
}
export const executePlan = (
  plan: OperationPlan,
): Effect.Effect<readonly CompletedStep[], OperationStepError> => {
  const completed: CompletedStep[] = []
  const compensate = (): Effect.Effect<void, OperationStepError> =>
    completed
      .slice()
      .reverse()
      .reduce<Effect.Effect<void, OperationStepError>>(
        (acc, entry) =>
          Effect.andThen(
            acc,
            entry.step.compensate === undefined
              ? Effect.void
              : entry.step.compensate(plan.context, entry.result),
          ),
        Effect.void,
      )
  return Effect.catch(
    Effect.forEach(
      plan.steps,
      (step) =>
        Effect.map(step.run(plan.context), (result) => {
          const entry = { step, result }
          completed.push(entry)
          return entry
        }),
      { discard: false },
    ),
    (error) =>
      Effect.andThen(
        Effect.catch(compensate(), () => Effect.void),
        Effect.fail(error),
      ),
  )
}

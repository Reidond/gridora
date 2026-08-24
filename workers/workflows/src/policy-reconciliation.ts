import { Effect, Schema } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import {
  PolicyReconciliationResult,
  type PolicyReconciliationResult as PolicyReconciliationResultType,
} from '@gridora/policy-reconciliation-control'
import { decodePolicyScheduleTask, PolicyScheduleTask } from '@gridora/policy-schedule'

export const PolicyWorkflowPayload = PolicyScheduleTask
export type PolicyWorkflowPayload = typeof PolicyScheduleTask.Type
export type PolicyWorkflowResult = PolicyReconciliationResultType

export interface PolicyDurableStepOptions {
  readonly retries: {
    readonly limit: number
    readonly delay: `${number} ${
      | 'second'
      | 'minute'
      | 'hour'
      | 'day'
      | 'week'
      | 'month'
      | 'year'}${'s' | ''}`
    readonly backoff: 'exponential'
  }
  readonly timeout: `${number} ${
    | 'second'
    | 'minute'
    | 'hour'
    | 'day'
    | 'week'
    | 'month'
    | 'year'}${'s' | ''}`
}

export type PolicyDurableStep = (
  name: string,
  options: PolicyDurableStepOptions,
  action: () => Promise<string>,
) => Promise<string>

export type ReconcilePolicy = (payload: PolicyWorkflowPayload) => Promise<unknown>

export interface PolicyInternalWorkflowEnvironment {
  readonly APPLICATION: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
  readonly INTERNAL_SERVICE_SECRET: string
}

export const POLICY_RECONCILIATION_STEP_NAME = '01-plan-fence-and-submit-lifecycle-requests'
export const POLICY_RECONCILIATION_STEP_OPTIONS = {
  retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const satisfies PolicyDurableStepOptions

const decodePayload = (input: unknown): Promise<PolicyWorkflowPayload> =>
  Effect.runPromise(decodePolicyScheduleTask(input))

const decodeResult = (input: unknown): Promise<PolicyWorkflowResult> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(PolicyReconciliationResult, { onExcessProperty: 'error' })(input),
  )

/**
 * The Workflow can submit only the already fenced, tenant-scoped schedule
 * task. The response describes acceptance/rejection receipts, not a provider
 * deletion, node action, or game-process success.
 */
export const executeSignedPolicyReconciliation = async (
  env: PolicyInternalWorkflowEnvironment,
  payload: PolicyWorkflowPayload,
): Promise<unknown> => {
  const body = JSON.stringify(payload)
  const routing = {
    method: 'POST',
    path: '/v1/internal/policy-reconciliations/execute',
    workflow: 'reconcile-policy',
    organizationId: payload.organizationId,
  }
  const authentication = await Effect.runPromise(
    signInternalRequest(
      body,
      env.INTERNAL_SERVICE_SECRET,
      Date.now(),
      crypto.randomUUID(),
      routing,
    ),
  )
  const response = await env.APPLICATION.fetch(
    'https://gridora.internal/v1/internal/policy-reconciliations/execute',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gridora-workflow': 'reconcile-policy',
        'x-gridora-organization-id': payload.organizationId,
        'x-correlation-id': payload.runId,
        'idempotency-key': `workflow:${payload.idempotencyKey}`,
        ...authentication,
      },
      body,
    },
  )
  const responseBody: unknown = await response.json()
  if (!response.ok) throw new Error(`Policy reconciliation failed with status ${response.status}`)
  return responseBody
}

/** A single deterministic durable step makes replay adopt the stored result. */
export const runPolicyReconciliationWorkflow = async (
  input: unknown,
  step: PolicyDurableStep,
  reconcile: ReconcilePolicy,
): Promise<PolicyWorkflowResult> => {
  const payload = await decodePayload(input)
  const persisted = await step(
    POLICY_RECONCILIATION_STEP_NAME,
    POLICY_RECONCILIATION_STEP_OPTIONS,
    async () => JSON.stringify(await decodeResult(await reconcile(payload))),
  )
  return decodeResult(JSON.parse(persisted))
}

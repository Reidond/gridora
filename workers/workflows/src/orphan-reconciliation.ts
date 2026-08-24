import { Effect, Schema } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import { decodeOrphanScheduleTask, OrphanScheduleTask } from '@gridora/orphan-schedule'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
)
const Fingerprint = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const OrphanWorkflowPayload = OrphanScheduleTask
export type OrphanWorkflowPayload = typeof OrphanScheduleTask.Type

export const OrphanWorkflowResult = Schema.Struct({
  organizationId: Identifier,
  providerAccountId: Identifier,
  runId: Identifier,
  discoveryFingerprint: Fingerprint,
  opened: Count,
  updated: Count,
  resolved: Count,
  unchanged: Count,
  replayed: Schema.Boolean,
})
export type OrphanWorkflowResult = typeof OrphanWorkflowResult.Type

export interface OrphanDurableStepOptions {
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

export type OrphanDurableStep = (
  name: string,
  options: OrphanDurableStepOptions,
  action: () => Promise<string>,
) => Promise<string>

export type ReconcileOrphans = (payload: OrphanWorkflowPayload) => Promise<unknown>

export interface OrphanInternalWorkflowEnvironment {
  readonly APPLICATION: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
  readonly INTERNAL_SERVICE_SECRET: string
}

export const ORPHAN_RECONCILIATION_STEP_NAME = '01-discover-compare-and-record'
export const ORPHAN_RECONCILIATION_STEP_OPTIONS = {
  retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const satisfies OrphanDurableStepOptions

const decodePayload = (input: unknown): Promise<OrphanWorkflowPayload> =>
  Effect.runPromise(decodeOrphanScheduleTask(input))

const decodeResult = (input: unknown): Promise<OrphanWorkflowResult> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(OrphanWorkflowResult, { onExcessProperty: 'error' })(input),
  )

/**
 * Invoke the one signed API capability used by the read-only orphan Workflow.
 * The D1-derived task contains no provider credential or provider response.
 */
export const executeSignedOrphanReconciliation = async (
  env: OrphanInternalWorkflowEnvironment,
  payload: OrphanWorkflowPayload,
): Promise<unknown> => {
  const body = JSON.stringify(payload)
  const routing = {
    method: 'POST',
    path: '/v1/internal/orphan-reconciliations/execute',
    workflow: 'reconcile-orphan',
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
    'https://gridora.internal/v1/internal/orphan-reconciliations/execute',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gridora-workflow': 'reconcile-orphan',
        'x-gridora-organization-id': payload.organizationId,
        'x-correlation-id': payload.runId,
        'idempotency-key': `workflow:${payload.idempotencyKey}`,
        ...authentication,
      },
      body,
    },
  )
  const responseBody: unknown = await response.json()
  if (!response.ok) throw new Error(`Orphan reconciliation failed with status ${response.status}`)
  return responseBody
}

/**
 * Isolated Cloudflare Workflow adapter. Its only injected capability is the
 * detection/repository composition; no provider mutation capability is accepted.
 */
export const runOrphanReconciliationWorkflow = async (
  input: unknown,
  step: OrphanDurableStep,
  reconcile: ReconcileOrphans,
): Promise<OrphanWorkflowResult> => {
  const payload = await decodePayload(input)
  const persisted = await step(
    ORPHAN_RECONCILIATION_STEP_NAME,
    ORPHAN_RECONCILIATION_STEP_OPTIONS,
    async () => JSON.stringify(await decodeResult(await reconcile(payload))),
  )
  return decodeResult(JSON.parse(persisted))
}

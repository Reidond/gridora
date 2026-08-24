import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { Effect, Schema } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import type { OrganizationEventsDO } from '@gridora/realtime'
import { runServerProvisionPlan } from './server-provision-plan-runner.js'

export const ServerProvisionPlanWorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.Literal('server-provision'),
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Struct({
    acceptanceFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
})
export type ServerProvisionPlanWorkflowPayload = typeof ServerProvisionPlanWorkflowPayload.Type

const StepResult = Schema.Struct({
  status: Schema.Literals(['completed', 'waiting', 'failed']),
  reason: Schema.optional(Schema.String),
})
type StepResult = typeof StepResult.Type

type WorkflowEnv = Omit<Env, 'ORGANIZATION_EVENTS'> & {
  ORGANIZATION_EVENTS: DurableObjectNamespace<OrganizationEventsDO>
}

/**
 * Parent orchestration deliberately has no provider adapter. Its durable
 * calls cause the API to adopt the accepted node and game operations, then
 * wait for agent/capacity and game observation evidence before completing.
 */
export class ServerProvisionPlanWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  ServerProvisionPlanWorkflowPayload
> {
  private async execute(
    payload: ServerProvisionPlanWorkflowPayload,
    stepName:
      | 'submit-node'
      | 'wait-node-ready'
      | 'reserve-and-deploy'
      | 'wait-game-deployment'
      | 'compensate-node'
      | 'wait-compensation',
    ordinal: number,
  ): Promise<StepResult> {
    const body = JSON.stringify({ ...payload, stepName, ordinal })
    const routing = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: 'server-provision-plan',
      workflowStep: stepName,
      workflowStepOrdinal: String(ordinal),
      organizationId: payload.organizationId,
    }
    const authentication = await Effect.runPromise(
      signInternalRequest(
        body,
        this.env.INTERNAL_SERVICE_SECRET,
        Date.now(),
        crypto.randomUUID(),
        routing,
      ),
    )
    const response = await this.env.APPLICATION.fetch(
      'https://gridora.internal/v1/internal/workflow-steps/execute',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gridora-workflow': 'server-provision-plan',
          'x-gridora-workflow-step': stepName,
          'x-gridora-workflow-step-ordinal': String(ordinal),
          'x-gridora-organization-id': payload.organizationId,
          'x-correlation-id': payload.correlationId,
          // The API binds child work to immutable parent IDs. The outer key is
          // stable only for request authentication/replay diagnostics.
          'idempotency-key': `${payload.idempotencyKey}:server-provision:${stepName}`,
          ...authentication,
        },
        body,
      },
    )
    if (!response.ok)
      throw new Error(
        `Server provision Workflow step ${stepName} failed with status ${response.status}`,
      )
    return Effect.runPromise(Schema.decodeUnknownEffect(StepResult)(await response.json()))
  }

  private async durable(
    step: WorkflowStep,
    payload: ServerProvisionPlanWorkflowPayload,
    stepName:
      | 'submit-node'
      | 'wait-node-ready'
      | 'reserve-and-deploy'
      | 'wait-game-deployment'
      | 'compensate-node'
      | 'wait-compensation',
    ordinal: number,
  ): Promise<StepResult> {
    const serialized = await step.do(
      `server-provision-${String(ordinal + 1).padStart(2, '0')}-${stepName}`,
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      async () => JSON.stringify(await this.execute(payload, stepName, ordinal)),
    )
    return Effect.runPromise(Schema.decodeUnknownEffect(StepResult)(JSON.parse(serialized)))
  }

  private async publish(
    payload: ServerProvisionPlanWorkflowPayload,
    stepName: string,
    progress: number,
  ): Promise<void> {
    const events = this.env.ORGANIZATION_EVENTS.getByName(`${payload.organizationId}:events`)
    await events.initialize(payload.organizationId)
    await events.publish({
      id: `${payload.operationId}:${stepName}:${progress}`,
      organizationId: payload.organizationId,
      type: 'operation.progressed',
      resourceId: payload.resourceId,
      occurredAt: new Date().toISOString(),
      data: {
        operationId: payload.operationId,
        operationType: 'server-provision-plan',
        step: stepName,
        progress,
      },
    })
  }

  override async run(
    event: Readonly<WorkflowEvent<ServerProvisionPlanWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ readonly operationId: string; readonly state: 'succeeded' }> {
    const payload = await Effect.runPromise(
      Schema.decodeUnknownEffect(ServerProvisionPlanWorkflowPayload, { onExcessProperty: 'error' })(
        event.payload,
      ),
    )
    await runServerProvisionPlan({
      execute: (stepName, ordinal) => this.durable(step, payload, stepName, ordinal),
      sleep: (name) => step.sleep(name, '30 seconds'),
      publish: (stepName, progress) => this.publish(payload, stepName, progress),
    })
    return { operationId: payload.operationId, state: 'succeeded' }
  }
}

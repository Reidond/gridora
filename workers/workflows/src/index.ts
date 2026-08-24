import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { Effect, Schema } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'
import { canonicalWorkflowStep, type SignedBackupWorkflowStep } from '@gridora/backup-workflow'
import { GameWorkflowStepNames } from '@gridora/game-lifecycle-execution'
import {
  makeSignedNodeImageWorkflowStep,
  type NodeImageWorkflowPayload,
} from '@gridora/node-image-workflow'
import type { OrganizationEventsDO } from '@gridora/realtime'
import {
  executeSignedOrphanReconciliation,
  runOrphanReconciliationWorkflow,
  type OrphanDurableStep,
  type OrphanWorkflowPayload,
  type OrphanWorkflowResult,
} from './orphan-reconciliation.js'
import {
  executeSignedPolicyReconciliation,
  runPolicyReconciliationWorkflow,
  type PolicyDurableStep,
  type PolicyWorkflowPayload,
  type PolicyWorkflowResult,
} from './policy-reconciliation.js'
import { runWorkflowPlan } from './workflow-plan.js'
import { runBackupWorkflowSteps } from './backup-workflow-plan.js'
export { ServerProvisionPlanWorkflow } from './server-provision-plan.js'
export type { ServerProvisionPlanWorkflowPayload } from './server-provision-plan.js'

export * from './workflow-plan.js'
export * from './command-producer.js'
export * from './orphan-reconciliation.js'
export * from './policy-reconciliation.js'
export * from './backup-workflow-plan.js'

const WorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.String,
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
})
export type WorkflowPayload = typeof WorkflowPayload.Type

type WorkflowEnv = Omit<Env, 'ORGANIZATION_EVENTS'> & {
  ORGANIZATION_EVENTS: DurableObjectNamespace<OrganizationEventsDO>
}

interface StepResult {
  readonly status: 'completed' | 'adopted' | 'skipped' | 'waiting'
  readonly resourceRevision?: number | undefined
  readonly providerRequestId?: string | undefined
  readonly artifactKey?: string | undefined
  readonly retryMode?: 'adopt_only' | undefined
  readonly nextAttemptAt?: string | undefined
  readonly recoveryDeadlineAt?: string | undefined
}

const WorkflowStepResult = Schema.Struct({
  status: Schema.Literals(['completed', 'adopted', 'skipped', 'waiting']),
  resourceRevision: Schema.optional(Schema.Number),
  providerRequestId: Schema.optional(Schema.String),
  artifactKey: Schema.optional(Schema.String),
  retryMode: Schema.optional(Schema.Literal('adopt_only')),
  nextAttemptAt: Schema.optional(Schema.String),
  recoveryDeadlineAt: Schema.optional(Schema.String),
})

const decodePayload = (payload: unknown): Promise<WorkflowPayload> =>
  Effect.runPromise(Schema.decodeUnknownEffect(WorkflowPayload)(payload))

const NodeRuntimeWorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.Literal('node'),
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Struct({
    action: Schema.Literals(['start', 'stop', 'reboot', 'reconcile']),
    workflowStartRecordId: Schema.String,
    requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
})
type NodeRuntimeWorkflowPayload = typeof NodeRuntimeWorkflowPayload.Type

const NodeRuntimeWorkflowResult = Schema.Struct({
  status: Schema.Literals(['completed', 'adopted', 'waiting']),
  terminal: Schema.Boolean,
  operationState: Schema.Literals([
    'succeeded',
    'waiting-observation',
    'reconciliation-required',
    'failed-terminal',
  ]),
})
type NodeRuntimeWorkflowResult = typeof NodeRuntimeWorkflowResult.Type

const NodeTerminationWorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.Literal('node'),
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Struct({
    action: Schema.Literals(['drain-node', 'leave-drain', 'rebuild-node', 'retire-node']),
    workflowStartRecordId: Schema.String,
    requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
})
type NodeTerminationWorkflowPayload = typeof NodeTerminationWorkflowPayload.Type

const TerminationWorkflowResult = Schema.Struct({
  status: Schema.Literals(['completed', 'adopted', 'cancelled']),
})

abstract class GridoraOperationWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  protected abstract readonly operationType: string
  protected abstract readonly stepNames: readonly string[]
  protected readonly maxRecoveryAttempts: number = 12

  private async executeStep(
    payload: WorkflowPayload,
    stepName: string,
    ordinal: number,
    providerCreateRecovery?: {
      readonly retryMode: 'adopt_only'
      readonly attempt: number
      readonly previousNextAttemptAt: string
    },
  ): Promise<StepResult> {
    const body = JSON.stringify({
      ...payload,
      input:
        providerCreateRecovery === undefined
          ? payload.input
          : { ...payload.input, providerCreateRecovery },
      stepName,
      ordinal,
    })
    const routing = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: this.operationType,
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
          'x-gridora-workflow': this.operationType,
          'x-gridora-workflow-step': stepName,
          'x-gridora-workflow-step-ordinal': String(ordinal),
          'x-gridora-organization-id': payload.organizationId,
          'x-correlation-id': payload.correlationId,
          'idempotency-key': `${payload.idempotencyKey}:${stepName}${providerCreateRecovery === undefined ? '' : `:adopt:${providerCreateRecovery.attempt}`}`,
          ...authentication,
        },
        body,
      },
    )
    const responseBody: unknown = await response.json()
    if (!response.ok)
      throw new Error(`Workflow step ${stepName} failed with status ${response.status}`)
    return Effect.runPromise(Schema.decodeUnknownEffect(WorkflowStepResult)(responseBody))
  }

  private async publishProgress(
    payload: WorkflowPayload,
    stepName: string,
    ordinal: number,
  ): Promise<void> {
    const events = this.env.ORGANIZATION_EVENTS.getByName(`${payload.organizationId}:events`)
    await events.initialize(payload.organizationId)
    await events.publish({
      id: `${payload.operationId}:${ordinal}`,
      organizationId: payload.organizationId,
      type: 'operation.progressed',
      resourceId: payload.resourceId,
      occurredAt: new Date().toISOString(),
      data: {
        operationId: payload.operationId,
        operationType: this.operationType,
        step: stepName,
        progress: Math.round(((ordinal + 1) / this.stepNames.length) * 100),
      },
    })
  }

  override async run(
    event: Readonly<WorkflowEvent<WorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{
    readonly operationId: string
    readonly completedSteps: number
  }> {
    const payload = await decodePayload(event.payload)
    return runWorkflowPlan(
      payload,
      this.stepNames,
      async (name, options, action) => {
        const serialized = await step.do<string>(name, options, async () =>
          JSON.stringify({ value: await action() }),
        )
        const decoded: unknown = JSON.parse(serialized)
        return typeof decoded === 'object' && decoded !== null && 'value' in decoded
          ? decoded.value
          : undefined
      },
      (input, stepName, ordinal) => this.executeStep(input, stepName, ordinal),
      (input, stepName, ordinal) => this.publishProgress(input, stepName, ordinal),
      {
        maxRecoveryAttempts: this.maxRecoveryAttempts,
        sleepUntil: (name, timestamp) => step.sleepUntil(name, timestamp),
        executeAdoptOnly: (input, stepName, ordinal, state) =>
          this.executeStep(input, stepName, ordinal, state),
      },
    )
  }
}

export class DeleteOrganizationWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'delete-organization'
  protected override readonly maxRecoveryAttempts = 256
  protected override readonly stepNames = [
    'mark-deleting',
    'drain-deployments',
    'retire-nodes',
    'revoke-credentials',
    'delete-dns-and-tunnels',
    'finalize-deletion',
  ] as const
}
export class ProvisionNodeWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'provision-node'
  // Admission and reservation already committed atomically before this Workflow
  // starts. Agent observations own readiness and final operation completion.
  protected override readonly stepNames = ['create-or-adopt-instance'] as const
}

/**
 * Runtime actions use their dedicated D1 execution ledger. Each loop body is
 * a distinct durable step, so a post-dispatch provider visibility delay is
 * resumed as observation-only work rather than reissuing the provider action.
 */
export class NodeRuntimeLifecycleWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  NodeRuntimeWorkflowPayload
> {
  private async execute(
    payload: NodeRuntimeWorkflowPayload,
    attempt: number,
  ): Promise<NodeRuntimeWorkflowResult> {
    const stepName = 'execute-runtime-lifecycle'
    const body = JSON.stringify({ ...payload, stepName, ordinal: attempt })
    const routing = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: 'NodeRuntimeLifecycleWorkflow',
      workflowStep: stepName,
      workflowStepOrdinal: String(attempt),
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
          'x-gridora-workflow': 'NodeRuntimeLifecycleWorkflow',
          'x-gridora-workflow-step': stepName,
          'x-gridora-workflow-step-ordinal': String(attempt),
          'x-gridora-organization-id': payload.organizationId,
          'x-correlation-id': payload.correlationId,
          'idempotency-key': `${payload.idempotencyKey}:runtime:${attempt}`,
          ...authentication,
        },
        body,
      },
    )
    if (!response.ok)
      throw new Error(`Node runtime Workflow execution failed with status ${response.status}`)
    return Effect.runPromise(
      Schema.decodeUnknownEffect(NodeRuntimeWorkflowResult)(await response.json()),
    )
  }

  override async run(
    event: Readonly<WorkflowEvent<NodeRuntimeWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{
    readonly operationId: string
    readonly state: NodeRuntimeWorkflowResult['operationState']
  }> {
    const payload = await Effect.runPromise(
      Schema.decodeUnknownEffect(NodeRuntimeWorkflowPayload, { onExcessProperty: 'error' })(
        event.payload,
      ),
    )
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const serialized = await step.do(
        `runtime-execution-${attempt}`,
        {
          retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
          timeout: '2 minutes',
        },
        async () => JSON.stringify(await this.execute(payload, attempt)),
      )
      const result = await Effect.runPromise(
        Schema.decodeUnknownEffect(NodeRuntimeWorkflowResult)(JSON.parse(serialized)),
      )
      if (result.terminal) return { operationId: payload.operationId, state: result.operationState }
      await step.sleep(`runtime-observation-wait-${attempt}`, '30 seconds')
    }
    throw new Error('Node runtime Workflow visibility did not reach a terminal observation window')
  }
}

abstract class GridoraTerminationWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  NodeTerminationWorkflowPayload
> {
  protected abstract readonly workflowType:
    | 'DrainNodeWorkflow'
    | 'LeaveDrainNodeWorkflow'
    | 'RebuildNodeWorkflow'
    | 'RetireNodeWorkflow'
  protected abstract readonly steps: ReadonlyArray<{
    readonly name: string
    readonly destructive: boolean
  }>

  private async execute(
    payload: NodeTerminationWorkflowPayload,
    stepName: string,
    ordinal: number,
    destructive: boolean,
  ): Promise<typeof TerminationWorkflowResult.Type> {
    const body = JSON.stringify({
      organizationId: payload.organizationId,
      operationId: payload.operationId,
      workflowType: this.workflowType,
      workflowInstanceId: payload.operationId,
      stepName,
      ordinal,
      destructive,
    })
    const routing = {
      method: 'POST',
      path: '/v1/internal/workflow-steps/execute',
      workflow: this.workflowType,
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
          'x-gridora-workflow': this.workflowType,
          'x-gridora-workflow-step': stepName,
          'x-gridora-workflow-step-ordinal': String(ordinal),
          'x-gridora-organization-id': payload.organizationId,
          'x-correlation-id': payload.correlationId,
          'idempotency-key': `${payload.idempotencyKey}:termination:${ordinal}`,
          ...authentication,
        },
        body,
      },
    )
    if (!response.ok)
      throw new Error(
        `Node termination Workflow step ${stepName} failed with status ${response.status}`,
      )
    return Effect.runPromise(
      Schema.decodeUnknownEffect(TerminationWorkflowResult)(await response.json()),
    )
  }

  override async run(
    event: Readonly<WorkflowEvent<NodeTerminationWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ readonly operationId: string; readonly completedSteps: number }> {
    const payload = await Effect.runPromise(
      Schema.decodeUnknownEffect(NodeTerminationWorkflowPayload, { onExcessProperty: 'error' })(
        event.payload,
      ),
    )
    for (const [ordinal, detail] of this.steps.entries()) {
      const serialized = await step.do(
        `termination-${String(ordinal + 1).padStart(2, '0')}-${detail.name}`,
        {
          retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        },
        async () =>
          JSON.stringify(await this.execute(payload, detail.name, ordinal, detail.destructive)),
      )
      const result = await Effect.runPromise(
        Schema.decodeUnknownEffect(TerminationWorkflowResult)(JSON.parse(serialized)),
      )
      if (result.status === 'cancelled')
        return { operationId: payload.operationId, completedSteps: ordinal + 1 }
    }
    return { operationId: payload.operationId, completedSteps: this.steps.length }
  }
}

export class DrainNodeWorkflow extends GridoraTerminationWorkflow {
  protected override readonly workflowType = 'DrainNodeWorkflow' as const
  protected override readonly steps = [{ name: 'complete-node-drain', destructive: false }] as const
}

export class LeaveDrainNodeWorkflow extends GridoraTerminationWorkflow {
  protected override readonly workflowType = 'LeaveDrainNodeWorkflow' as const
  protected override readonly steps = [{ name: 'complete-node-drain', destructive: false }] as const
}

export class RebuildNodeWorkflow extends GridoraTerminationWorkflow {
  protected override readonly workflowType = 'RebuildNodeWorkflow' as const
  protected override readonly steps = [
    { name: 'drain-node', destructive: false },
    { name: 'verify-backups', destructive: false },
    { name: 'rebuild-provider-instance', destructive: true },
    { name: 'bootstrap-node', destructive: false },
    { name: 'verify-agent', destructive: false },
  ] as const
}

export class RetireNodeWorkflow extends GridoraTerminationWorkflow {
  protected override readonly workflowType = 'RetireNodeWorkflow' as const
  protected override readonly steps = [
    { name: 'drain-node', destructive: false },
    { name: 'verify-retention-policy', destructive: false },
    { name: 'revoke-node-credentials', destructive: false },
    { name: 'delete-provider-instance', destructive: true },
    { name: 'cleanup-networking', destructive: false },
  ] as const
}
export class DeployGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'deploy-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.create
}
export class UpdateGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'update-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.update
}
export class ApplyGameConfigWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'apply-game-config'
  protected override readonly stepNames = GameWorkflowStepNames['apply-config']
}
export class SyncModsWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'sync-mods'
  protected override readonly stepNames = GameWorkflowStepNames['sync-mods']
}
const signBackupStep = async (
  secret: string,
  input: Omit<SignedBackupWorkflowStep, 'signature'>,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalWorkflowStep(input))),
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

abstract class GridoraBackupWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowPayload> {
  protected abstract readonly operationType: 'backup-game-server' | 'restore-game-server'
  protected abstract readonly steps: readonly SignedBackupWorkflowStep['step'][]

  override async run(event: Readonly<WorkflowEvent<WorkflowPayload>>, step: WorkflowStep) {
    const payload = await decodePayload(event.payload)
    const jobId = typeof payload.input.backupJobId === 'string' ? payload.input.backupJobId : ''
    const acceptedAt = typeof payload.input.acceptedAt === 'string' ? payload.input.acceptedAt : ''
    if (jobId.length === 0 || !Number.isFinite(Date.parse(acceptedAt)))
      throw new Error('Backup Workflow identity is unavailable')
    const execute = async (
      stepName: SignedBackupWorkflowStep['step'],
      ordinal: number,
      stepPayload: Readonly<Record<string, unknown>> = {},
    ) =>
      await step.do(
        `${ordinal}-${stepName}`,
        {
          retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        },
        async () => {
          const unsigned: Omit<SignedBackupWorkflowStep, 'signature'> = {
            apiVersion: 'backup.workflow.gridora.dev/v1alpha1',
            organizationId: payload.organizationId,
            operationId: payload.operationId,
            jobId,
            step: stepName,
            ordinal,
            issuedAt: acceptedAt,
            expiresAt: new Date(Date.parse(acceptedAt) + 7 * 24 * 60 * 60_000).toISOString(),
            payload: stepPayload,
          }
          const body = JSON.stringify({
            ...unsigned,
            signature: await signBackupStep(this.env.INTERNAL_SERVICE_SECRET, unsigned),
          })
          const routing = {
            method: 'POST',
            path: '/v1/internal/workflow-steps/execute',
            workflow: this.operationType,
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
                'x-gridora-workflow': this.operationType,
                'x-gridora-workflow-step': stepName,
                'x-gridora-workflow-step-ordinal': String(ordinal),
                'x-gridora-organization-id': payload.organizationId,
                'x-correlation-id': payload.correlationId,
                'idempotency-key': `${payload.idempotencyKey}:${stepName}`,
                ...authentication,
              },
              body,
            },
          )
          if (!response.ok)
            throw new Error(
              `Backup Workflow step ${stepName} failed with status ${response.status}`,
            )
          return response.text()
        },
      )
    await runBackupWorkflowSteps(this.operationType, this.steps, execute)
    return { operationId: payload.operationId, completedSteps: this.steps.length }
  }
}

export class BackupGameServerWorkflow extends GridoraBackupWorkflow {
  protected override readonly operationType = 'backup-game-server' as const
  protected override readonly steps = ['mark-running', 'agent-create'] as const
}
export class RestoreGameServerWorkflow extends GridoraBackupWorkflow {
  protected override readonly operationType = 'restore-game-server' as const
  protected override readonly steps = [
    'mark-running',
    'agent-restore-stage',
    'restore-validate',
    'restore-cutover',
    'complete',
    'restore-finalize',
  ] as const
}
export class MoveGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'move-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.move
}
export class DeleteGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'delete-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.delete
}

export class StartGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'start-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.start
}
export class StopGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'stop-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.stop
}
export class RestartGameServerWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'restart-game-server'
  protected override readonly stepNames = GameWorkflowStepNames.restart
}
export class RegisterProviderImageWorkflow extends GridoraOperationWorkflow {
  protected override readonly operationType = 'register-provider-image'
  protected override readonly stepNames = [
    'verify-artifact',
    'register-provider-image',
    'wait-image-ready',
    'verify-image-checksum',
    'promote-image',
  ] as const
}

/**
 * Platform image operations use a separate signed, D1-bound step rather than
 * the tenant generic Workflow endpoint.  This prevents a tenant operation
 * body from ever selecting a platform image action or provider scope.
 */
export class NodeImageLifecycleWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  NodeImageWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<NodeImageWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ readonly operationId: string; readonly status: string }> {
    const payload = await Effect.runPromise(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          operationId: Schema.String,
          workflowStartRecordId: Schema.String,
          requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          action: Schema.Literals([
            'create',
            'test',
            'configure-scope',
            'register-provider',
            'promote',
            'rollback',
            'revoke',
          ]),
          imageId: Schema.NullOr(Schema.String),
          scopeId: Schema.NullOr(Schema.String),
        }),
        { onExcessProperty: 'error' },
      )(event.payload),
    )
    const serialized = await step.do('apply-node-image-lifecycle', async () => {
      const signed = await Effect.runPromise(
        makeSignedNodeImageWorkflowStep(payload, this.env.INTERNAL_SERVICE_SECRET),
      )
      const response = await this.env.APPLICATION.fetch(
        'https://gridora.internal/v1/internal/node-image-workflow/execute',
        {
          method: 'POST',
          headers: signed.headers,
          body: signed.body,
        },
      )
      if (!response.ok) throw new Error(`Node image Workflow failed with status ${response.status}`)
      return JSON.stringify(await response.json())
    })
    const result = JSON.parse(serialized) as { readonly status?: unknown }
    return {
      operationId: payload.operationId,
      status: typeof result.status === 'string' ? result.status : 'completed',
    }
  }
}

export class ReconcileOrphanWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  OrphanWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<OrphanWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<OrphanWorkflowResult> {
    const durableStep: OrphanDurableStep = (name, options, action) =>
      step.do<string>(name, options, action)
    return runOrphanReconciliationWorkflow(event.payload, durableStep, (payload) =>
      executeSignedOrphanReconciliation(this.env, payload),
    )
  }
}

export class ReconcilePolicyWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  PolicyWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<PolicyWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<PolicyWorkflowResult> {
    const durableStep: PolicyDurableStep = (name, options, action) =>
      step.do<string>(name, options, action)
    return runPolicyReconciliationWorkflow(event.payload, durableStep, (payload) =>
      executeSignedPolicyReconciliation(this.env, payload),
    )
  }
}

export default {
  fetch(): Response {
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<WorkflowEnv>

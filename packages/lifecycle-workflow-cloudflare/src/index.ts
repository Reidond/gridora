import { Effect } from 'effect'
import {
  type LifecycleCommand,
  type WorkflowStarterShape,
  WorkflowStartError,
} from '@gridora/lifecycle-control'

export interface LifecycleWorkflowParams {
  readonly operationId: string
  readonly organizationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly resourceId: string
  readonly command: LifecycleCommand
  readonly fingerprint: string
  readonly previousRevision: number
  readonly desiredRevision: number
}

/** Metadata must come from the same durable operation ledger that owns the Workflow start record. */
export interface LifecycleWorkflowMetadata {
  readonly operationId: string
  readonly organizationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly commandKind: LifecycleCommand['kind']
  readonly fingerprint: string
  readonly previousRevision: number
  readonly desiredRevision: number
}

export interface LifecycleWorkflowInstance {
  readonly id: string
  /** Native Workflow handles do not expose params. The API composition must attach ledger metadata. */
  readonly metadata?: LifecycleWorkflowMetadata
}

/** The only Cloudflare surface accepted by this adapter. It cannot select a Workflow by name. */
export interface LifecycleWorkflowBinding {
  readonly create: (options: {
    readonly id: string
    readonly params: LifecycleWorkflowParams
  }) => Promise<LifecycleWorkflowInstance>
  readonly get: (id: string) => Promise<LifecycleWorkflowInstance>
}

export type WorkflowStartClassification =
  | { readonly kind: 'started'; readonly instanceId: string }
  | { readonly kind: 'adopted'; readonly instanceId: string }
  | {
      readonly kind: 'pending-reconciliation'
      readonly instanceId: string
      readonly reason: 'ambiguous_create' | 'lookup_failed' | 'existing_metadata_unavailable'
    }
  | {
      readonly kind: 'rejected-mismatch'
      readonly instanceId: string
      readonly field: keyof LifecycleWorkflowMetadata | 'instanceId' | 'command'
    }
  | {
      readonly kind: 'terminal-provider-error'
      readonly instanceId: string
      readonly code: string
    }

type StartInput = Parameters<WorkflowStarterShape['start']>[0]

export interface LifecycleWorkflowStartShape {
  readonly startClassified: (input: StartInput) => Effect.Effect<WorkflowStartClassification>
  readonly port: WorkflowStarterShape
}

interface ProviderErrorShape {
  readonly code?: unknown
  readonly status?: unknown
  readonly retryable?: unknown
  readonly ambiguous?: unknown
  readonly name?: unknown
}

const providerError = (error: unknown): ProviderErrorShape =>
  typeof error === 'object' && error !== null ? error : {}

const providerCode = (error: unknown): string => {
  const value = providerError(error).code
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const status = providerError(error).status
  return typeof status === 'number' ? String(status) : 'provider_rejected'
}

const isAlreadyExisting = (error: unknown): boolean => {
  const details = providerError(error)
  return (
    details.status === 409 ||
    details.code === 409 ||
    details.code === 'instance_already_exists' ||
    details.code === 'WORKFLOW_INSTANCE_ALREADY_EXISTS'
  )
}

const isTerminalProviderError = (error: unknown): boolean => {
  const details = providerError(error)
  if (details.retryable === false) return true
  if (typeof details.status === 'number') return details.status >= 400 && details.status < 500
  if (typeof details.code === 'number') return details.code >= 400 && details.code < 500
  return false
}

const metadataFrom = (params: LifecycleWorkflowParams): LifecycleWorkflowMetadata => ({
  operationId: params.operationId,
  organizationId: params.organizationId,
  actorId: params.actorId,
  correlationId: params.correlationId,
  commandKind: params.command.kind,
  fingerprint: params.fingerprint,
  previousRevision: params.previousRevision,
  desiredRevision: params.desiredRevision,
})

const metadataMismatch = (
  expected: LifecycleWorkflowMetadata,
  actual: LifecycleWorkflowMetadata,
): keyof LifecycleWorkflowMetadata | undefined => {
  const keys = Object.keys(expected) as ReadonlyArray<keyof LifecycleWorkflowMetadata>
  return keys.find((key) => actual[key] !== expected[key])
}

const decodeBoundCommand = (input: StartInput): LifecycleCommand | undefined => {
  try {
    const value: unknown = JSON.parse(input.operation.fingerprint)
    if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined
    const command = value as LifecycleCommand
    if (
      command.kind !== input.operation.action ||
      command.organizationId !== input.operation.organizationId ||
      command.actorId !== input.operation.actorId ||
      command.resourceId !== input.operation.resourceId ||
      command.correlationId !== input.operation.correlationId ||
      command.expectedDesiredRevision !== input.reservation.previousRevision
    )
      return undefined
    return command
  } catch {
    return undefined
  }
}

const classifyStart = async (
  binding: LifecycleWorkflowBinding,
  input: StartInput,
): Promise<WorkflowStartClassification> => {
  const instanceId = input.operation.id
  if (input.workflowInstanceId !== instanceId)
    return { kind: 'rejected-mismatch', instanceId, field: 'instanceId' }
  const command = decodeBoundCommand(input)
  if (command === undefined) return { kind: 'rejected-mismatch', instanceId, field: 'command' }
  const params: LifecycleWorkflowParams = {
    operationId: instanceId,
    organizationId: input.operation.organizationId,
    actorId: input.operation.actorId,
    correlationId: input.operation.correlationId,
    resourceId: input.operation.resourceId,
    command,
    fingerprint: input.operation.fingerprint,
    previousRevision: input.reservation.previousRevision,
    desiredRevision: input.reservation.desiredRevision,
  }
  try {
    const created = await binding.create({ id: instanceId, params })
    return created.id === instanceId
      ? { kind: 'started', instanceId }
      : { kind: 'rejected-mismatch', instanceId, field: 'instanceId' }
  } catch (error) {
    if (!isAlreadyExisting(error))
      return isTerminalProviderError(error)
        ? {
            kind: 'terminal-provider-error',
            instanceId,
            code: providerCode(error),
          }
        : { kind: 'pending-reconciliation', instanceId, reason: 'ambiguous_create' }
  }

  let existing: LifecycleWorkflowInstance
  try {
    existing = await binding.get(instanceId)
  } catch {
    return { kind: 'pending-reconciliation', instanceId, reason: 'lookup_failed' }
  }
  if (existing.id !== instanceId)
    return { kind: 'rejected-mismatch', instanceId, field: 'instanceId' }
  if (existing.metadata === undefined)
    return {
      kind: 'pending-reconciliation',
      instanceId,
      reason: 'existing_metadata_unavailable',
    }
  const mismatch = metadataMismatch(metadataFrom(params), existing.metadata)
  return mismatch === undefined
    ? { kind: 'adopted', instanceId }
    : { kind: 'rejected-mismatch', instanceId, field: mismatch }
}

export const makeLifecycleWorkflowStart = (
  binding: LifecycleWorkflowBinding,
): LifecycleWorkflowStartShape => {
  const startClassified = (input: StartInput): Effect.Effect<WorkflowStartClassification> =>
    Effect.promise(() => classifyStart(binding, input))
  return {
    startClassified,
    port: {
      start: (input) =>
        startClassified(input).pipe(
          Effect.flatMap((result) => {
            if (result.kind === 'started' || result.kind === 'adopted') return Effect.void
            return Effect.fail(
              new WorkflowStartError({
                operationId: input.operation.id,
                message: `workflow_start_${result.kind}:${
                  result.kind === 'pending-reconciliation'
                    ? result.reason
                    : result.kind === 'rejected-mismatch'
                      ? result.field
                      : result.code
                }`,
              }),
            )
          }),
        ),
    },
  }
}

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  canonicalCommandFingerprint,
  type LifecycleCommand,
  type WorkflowStarterShape,
} from '@gridora/lifecycle-control'
import {
  type LifecycleWorkflowBinding,
  type LifecycleWorkflowInstance,
  type LifecycleWorkflowMetadata,
  type LifecycleWorkflowParams,
  makeLifecycleWorkflowStart,
} from '../src/index.js'

type StartInput = Parameters<WorkflowStarterShape['start']>[0]

const command: LifecycleCommand = {
  kind: 'move-server',
  organizationId: 'org-a',
  actorId: 'actor-a',
  resourceId: 'server-a',
  idempotencyKey: 'request-a',
  expectedDesiredRevision: 7,
  correlationId: 'correlation-a',
  placement: { mode: 'dedicated', nodeId: 'node-b' },
}

const input = (): StartInput => ({
  workflowInstanceId: 'operation-a',
  startRecordId: 'workflow-start:operation-a',
  operation: {
    id: 'operation-a',
    organizationId: command.organizationId,
    actorId: command.actorId,
    resourceId: command.resourceId,
    action: command.kind,
    state: 'queued',
    idempotencyKey: command.idempotencyKey,
    fingerprint: canonicalCommandFingerprint(command),
    correlationId: command.correlationId,
  },
  reservation: {
    organizationId: command.organizationId,
    resourceKind: 'server',
    resourceId: command.resourceId,
    action: command.kind,
    previousRevision: 7,
    desiredRevision: 8,
    desiredState: 'stopped',
    placement: command.placement,
  },
})

const metadata = (params: LifecycleWorkflowParams): LifecycleWorkflowMetadata => ({
  operationId: params.operationId,
  organizationId: params.organizationId,
  actorId: params.actorId,
  correlationId: params.correlationId,
  commandKind: params.command.kind,
  fingerprint: params.fingerprint,
  previousRevision: params.previousRevision,
  desiredRevision: params.desiredRevision,
})

class MemoryBinding implements LifecycleWorkflowBinding {
  readonly instances = new Map<string, LifecycleWorkflowInstance>()
  readonly createCalls: Array<{ readonly id: string; readonly params: LifecycleWorkflowParams }> =
    []
  loseCreateResponse = false

  readonly create: LifecycleWorkflowBinding['create'] = async (options) => {
    this.createCalls.push(options)
    if (this.instances.has(options.id))
      throw { code: 'WORKFLOW_INSTANCE_ALREADY_EXISTS', status: 409 }
    const instance = { id: options.id, metadata: metadata(options.params) }
    this.instances.set(options.id, instance)
    if (this.loseCreateResponse) {
      this.loseCreateResponse = false
      throw { ambiguous: true, code: 'connection_reset' }
    }
    return instance
  }

  readonly get: LifecycleWorkflowBinding['get'] = async (id) => {
    const instance = this.instances.get(id)
    if (instance === undefined) throw { status: 404, code: 'not_found' }
    return instance
  }
}

describe('Cloudflare lifecycle Workflow start adapter', () => {
  it('starts once with the operation ID and complete bound params', async () => {
    const binding = new MemoryBinding()
    const adapter = makeLifecycleWorkflowStart(binding)
    const result = await Effect.runPromise(adapter.startClassified(input()))
    expect(result).toEqual({ kind: 'started', instanceId: 'operation-a' })
    expect(binding.createCalls).toHaveLength(1)
    expect(binding.createCalls[0]).toEqual({
      id: 'operation-a',
      params: {
        operationId: 'operation-a',
        organizationId: 'org-a',
        actorId: 'actor-a',
        correlationId: 'correlation-a',
        resourceId: 'server-a',
        command,
        fingerprint: canonicalCommandFingerprint(command),
        previousRevision: 7,
        desiredRevision: 8,
      },
    })
  })

  it('adopts an exact duplicate instead of selecting another instance ID', async () => {
    const binding = new MemoryBinding()
    const adapter = makeLifecycleWorkflowStart(binding)
    await Effect.runPromise(adapter.startClassified(input()))
    const duplicate = await Effect.runPromise(adapter.startClassified(input()))
    expect(duplicate).toEqual({ kind: 'adopted', instanceId: 'operation-a' })
    expect(binding.instances.size).toBe(1)
    expect([...binding.instances.keys()]).toEqual(['operation-a'])
  })

  it('reports response loss as pending and adopts the same instance on reconciliation', async () => {
    const binding = new MemoryBinding()
    binding.loseCreateResponse = true
    const adapter = makeLifecycleWorkflowStart(binding)
    const lost = await Effect.runPromise(adapter.startClassified(input()))
    expect(lost).toEqual({
      kind: 'pending-reconciliation',
      instanceId: 'operation-a',
      reason: 'ambiguous_create',
    })
    expect(binding.instances.size).toBe(1)
    const reconciled = await Effect.runPromise(adapter.startClassified(input()))
    expect(reconciled).toEqual({ kind: 'adopted', instanceId: 'operation-a' })
    expect(binding.createCalls.every((call) => call.id === 'operation-a')).toBe(true)
  })

  it('rejects foreign instance handles and mismatched durable metadata', async () => {
    const foreign: LifecycleWorkflowBinding = {
      create: async () => {
        throw { status: 409, code: 'instance_already_exists' }
      },
      get: async () => ({ id: 'operation-foreign' }),
    }
    const foreignResult = await Effect.runPromise(
      makeLifecycleWorkflowStart(foreign).startClassified(input()),
    )
    expect(foreignResult).toEqual({
      kind: 'rejected-mismatch',
      instanceId: 'operation-a',
      field: 'instanceId',
    })

    const binding = new MemoryBinding()
    await Effect.runPromise(makeLifecycleWorkflowStart(binding).startClassified(input()))
    const existing = binding.instances.get('operation-a')
    if (existing?.metadata === undefined) throw new Error('fixture metadata is required')
    binding.instances.set('operation-a', {
      ...existing,
      metadata: { ...existing.metadata, organizationId: 'org-foreign' },
    })
    const mismatch = await Effect.runPromise(
      makeLifecycleWorkflowStart(binding).startClassified(input()),
    )
    expect(mismatch).toEqual({
      kind: 'rejected-mismatch',
      instanceId: 'operation-a',
      field: 'organizationId',
    })
  })

  it('classifies terminal provider rejection without retrying another ID', async () => {
    let calls = 0
    const binding: LifecycleWorkflowBinding = {
      create: async () => {
        calls++
        throw { status: 403, code: 'workflow_binding_forbidden', retryable: false }
      },
      get: async () => {
        throw new Error('get must not run for a terminal create rejection')
      },
    }
    const adapter = makeLifecycleWorkflowStart(binding)
    const result = await Effect.runPromise(adapter.startClassified(input()))
    expect(result).toEqual({
      kind: 'terminal-provider-error',
      instanceId: 'operation-a',
      code: 'workflow_binding_forbidden',
    })
    expect(calls).toBe(1)
    const portExit = await Effect.runPromiseExit(adapter.port.start(input()))
    expect(portExit._tag).toBe('Failure')
    expect(calls).toBe(2)
  })
})

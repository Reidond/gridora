import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { type NodeImageAcceptance } from '@gridora/node-image-control'
import {
  executeSignedNodeImageWorkflowStep,
  makeNodeImageWorkflowStarter,
  makeSignedNodeImageWorkflowStep,
  type NodeImageWorkflowBinding,
  type NodeImageWorkflowPayload,
} from '../src/index.js'

const secret = 'node-image-internal-service-secret-with-at-least-32-bytes'
const now = 1_700_000_000_000
const payload: NodeImageWorkflowPayload = {
  operationId: 'image-op-123',
  workflowStartRecordId: 'image-workflow-start:123',
  requestFingerprint: 'a'.repeat(64),
  action: 'promote',
  imageId: 'node-image-20260823',
  scopeId: 'scope-ovh-gra',
}
const acceptance: NodeImageAcceptance = {
  disposition: 'created',
  operation: {
    id: payload.operationId,
    action: payload.action,
    imageId: payload.imageId,
    scopeId: payload.scopeId,
    actorId: 'platform-admin',
    idempotencyKey: 'node-image-start-0001',
    requestFingerprint: payload.requestFingerprint,
    state: 'queued',
    revision: 1,
    createdAt: '2026-08-23T12:00:00.000Z',
    updatedAt: '2026-08-23T12:00:00.000Z',
  },
  workflowStart: {
    id: payload.workflowStartRecordId,
    operationId: payload.operationId,
    workflowType: 'NodeImageLifecycleWorkflow',
    workflowInstanceId: payload.operationId,
    paramsFingerprint: payload.requestFingerprint,
    state: 'pending',
    attempts: 0,
    lastError: null,
  },
}

class Binding implements NodeImageWorkflowBinding {
  readonly instances = new Map<string, { readonly id: string; readonly metadata: typeof payload }>()
  loseResponse = false
  idOnlyGet = false
  readonly create: NodeImageWorkflowBinding['create'] = async (input) => {
    if (this.instances.has(input.id))
      throw { status: 409, code: 'WORKFLOW_INSTANCE_ALREADY_EXISTS' }
    const instance = { id: input.id, metadata: input.params }
    this.instances.set(input.id, instance)
    if (this.loseResponse) throw new Error('response lost after Workflow creation')
    return instance
  }
  readonly get: NodeImageWorkflowBinding['get'] = async (id) => {
    const instance = this.instances.get(id)
    if (instance === undefined) throw { status: 404 }
    return this.idOnlyGet ? { id: instance.id } : instance
  }
}

const requestFor = (signed: {
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}) =>
  new Request('https://gridora.internal/v1/internal/node-image-workflow/execute', {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  })

describe('node image Workflow start', () => {
  it('starts exactly one instance and adopts an exact existing instance', async () => {
    const binding = new Binding()
    const starter = makeNodeImageWorkflowStarter(binding)
    await expect(Effect.runPromise(starter.start(acceptance))).resolves.toBeUndefined()
    await expect(Effect.runPromise(starter.start(acceptance))).resolves.toBeUndefined()
    expect(binding.instances.size).toBe(1)
    expect(binding.instances.get(payload.operationId)).toEqual({
      id: payload.operationId,
      metadata: payload,
    })
  })

  it('does not call a second Workflow instance after an ambiguous create response', async () => {
    const binding = new Binding()
    binding.loseResponse = true
    const starter = makeNodeImageWorkflowStarter(binding)
    await expect(Effect.runPromise(starter.start(acceptance))).rejects.toMatchObject({
      _tag: 'NodeImageWorkflowStartError',
      message: 'workflow_start_ambiguous_create',
    })
    binding.idOnlyGet = true
    await expect(Effect.runPromise(starter.start(acceptance))).resolves.toBeUndefined()
    expect([...binding.instances.keys()]).toEqual([payload.operationId])
  })

  it('rejects an existing Workflow instance with mismatched immutable metadata', async () => {
    const binding = new Binding()
    binding.instances.set(payload.operationId, {
      id: payload.operationId,
      metadata: { ...payload, scopeId: 'scope-forged' },
    })
    await expect(
      Effect.runPromise(makeNodeImageWorkflowStarter(binding).start(acceptance)),
    ).rejects.toMatchObject({
      _tag: 'NodeImageWorkflowStartError',
      message: 'workflow_start_existing_metadata_mismatch',
    })
  })
})

describe('signed node image Workflow step', () => {
  it('executes only the exact HMAC-bound D1 reservation and adopts a receipt replay', async () => {
    const signed = await Effect.runPromise(
      makeSignedNodeImageWorkflowStep(payload, secret, now, 'nonce-step'),
    )
    let sideEffects = 0
    let completed = false
    const execute = () =>
      Effect.sync(() => {
        if (completed) return { status: 'adopted' as const }
        completed = true
        sideEffects += 1
        return { status: 'completed' as const }
      })
    const dependencies = {
      secret,
      now,
      reservations: {
        loadExact: () => Effect.succeed({ ...payload, commandJson: '{"authoritative":true}' }),
      },
      executor: { execute },
    }
    await expect(
      Effect.runPromise(
        executeSignedNodeImageWorkflowStep({ request: requestFor(signed), ...dependencies }),
      ),
    ).resolves.toEqual({ status: 'completed' })
    await expect(
      Effect.runPromise(
        executeSignedNodeImageWorkflowStep({ request: requestFor(signed), ...dependencies }),
      ),
    ).resolves.toEqual({ status: 'adopted' })
    expect(sideEffects).toBe(1)
  })

  it('rejects a properly signed body that tries to select a different scope than D1 reserved', async () => {
    const forged = await Effect.runPromise(
      makeSignedNodeImageWorkflowStep(
        { ...payload, scopeId: 'scope-forged' },
        secret,
        now,
        'nonce-forged',
      ),
    )
    let calls = 0
    const result = await Effect.runPromiseExit(
      executeSignedNodeImageWorkflowStep({
        request: requestFor(forged),
        secret,
        now,
        reservations: { loadExact: () => Effect.succeed({ ...payload, commandJson: '{}' }) },
        executor: {
          execute: () => {
            calls += 1
            return Effect.succeed({ status: 'completed' as const })
          },
        },
      }),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(JSON.stringify(result.cause)).toContain('workflow_reservation_mismatch')
    expect(calls).toBe(0)
  })

  it('rejects a replay body whose route signature no longer matches', async () => {
    const signed = await Effect.runPromise(
      makeSignedNodeImageWorkflowStep(payload, secret, now, 'nonce-tampered'),
    )
    const request = new Request(
      'https://gridora.internal/v1/internal/node-image-workflow/execute',
      {
        method: 'POST',
        headers: { ...signed.headers, 'x-gridora-workflow-step': 'wrong-step' },
        body: signed.body,
      },
    )
    const result = await Effect.runPromiseExit(
      executeSignedNodeImageWorkflowStep({
        request,
        secret,
        now,
        reservations: { loadExact: () => Effect.die('must not load') },
        executor: { execute: () => Effect.die('must not execute') },
      }),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(JSON.stringify(result.cause)).toContain('invalid_internal_signature')
  })
})

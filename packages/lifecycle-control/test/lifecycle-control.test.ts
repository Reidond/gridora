import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  baselinePolicyAdmission,
  canonicalCommandFingerprint,
  IdempotencyConflictError,
  type AtomicReservation,
  type AtomicReserveInput,
  type LifecycleCommand,
  type LifecycleRepositoryShape,
  makeLifecycleControl,
  OrganizationScopeError,
  ResourceNotFoundError,
  type ResourceSnapshot,
  RevisionConflictError,
  type WorkflowStarterShape,
  WorkflowStartError,
} from '../src/index.js'

class MemoryRepository implements LifecycleRepositoryShape {
  readonly resources = new Map<string, ResourceSnapshot>()
  readonly submissions = new Map<string, AtomicReservation>()
  readonly startRecords = new Map<string, AtomicReservation['workflowStart']>()
  nextOperation = 1
  beforeReserve: ((input: AtomicReserveInput) => void) | undefined

  constructor(resources: readonly ResourceSnapshot[]) {
    for (const resource of resources) this.resources.set(resource.id, resource)
  }

  private submissionKey(organizationId: string, idempotencyKey: string) {
    return `${organizationId}:${idempotencyKey}`
  }

  private allocateOperationId() {
    return `operation-${this.nextOperation++}`
  }

  readonly findIdempotent: LifecycleRepositoryShape['findIdempotent'] = (
    organizationId,
    idempotencyKey,
    fingerprint,
  ) => {
    const submissions = this.submissions
    const submissionKey = this.submissionKey.bind(this)
    return Effect.gen(function* () {
      const existing = submissions.get(submissionKey(organizationId, idempotencyKey))
      if (existing === undefined) return null
      if (existing.operation.fingerprint !== fingerprint)
        return yield* new IdempotencyConflictError({ idempotencyKey })
      return existing
    })
  }

  readonly get: LifecycleRepositoryShape['get'] = (organizationId, resourceId) => {
    const resources = this.resources
    return Effect.gen(function* () {
      const resource = resources.get(resourceId)
      if (resource === undefined) return yield* new ResourceNotFoundError({ resourceId })
      if (resource.organizationId !== organizationId)
        return yield* new OrganizationScopeError({ organizationId, resourceId })
      return resource
    })
  }

  readonly reserveAtomic: LifecycleRepositoryShape['reserveAtomic'] = (input) => {
    const resources = this.resources
    const submissions = this.submissions
    const startRecords = this.startRecords
    const beforeReserve = this.beforeReserve
    const submissionKey = this.submissionKey.bind(this)
    const allocateOperationId = this.allocateOperationId.bind(this)
    return Effect.gen(function* () {
      beforeReserve?.(input)
      const key = submissionKey(input.command.organizationId, input.command.idempotencyKey)
      const existing = submissions.get(key)
      if (existing !== undefined) {
        if (existing.operation.fingerprint !== input.fingerprint)
          return yield* new IdempotencyConflictError({
            idempotencyKey: input.command.idempotencyKey,
          })
        return { ...existing, disposition: 'adopted' as const }
      }
      const resource = resources.get(input.command.resourceId)
      if (resource === undefined || resource.organizationId !== input.command.organizationId)
        return yield* new OrganizationScopeError({
          organizationId: input.command.organizationId,
          resourceId: input.command.resourceId,
        })
      if (resource.desiredRevision !== input.command.expectedDesiredRevision)
        return yield* new RevisionConflictError({
          resourceId: resource.id,
          expected: input.command.expectedDesiredRevision,
          actual: resource.desiredRevision,
        })
      const operationId = allocateOperationId()
      const workflowStart = {
        id: `workflow-start:${operationId}`,
        operationId,
        organizationId: input.command.organizationId,
        state: 'pending' as const,
        attempts: 0,
        lastError: null,
      }
      const result: AtomicReservation = {
        disposition: 'created',
        operation: {
          id: operationId,
          organizationId: input.command.organizationId,
          actorId: input.command.actorId,
          resourceId: resource.id,
          action: input.command.kind,
          state: 'queued',
          idempotencyKey: input.command.idempotencyKey,
          fingerprint: input.fingerprint,
          correlationId: input.command.correlationId,
        },
        reservation: input.reservation,
        workflowStart,
      }
      resources.set(resource.id, {
        ...resource,
        desiredState: input.reservation.desiredState,
        desiredRevision: input.reservation.desiredRevision,
      } as ResourceSnapshot)
      submissions.set(key, result)
      startRecords.set(operationId, workflowStart)
      return result
    })
  }

  readonly markWorkflowStarted: LifecycleRepositoryShape['markWorkflowStarted'] = (
    organizationId,
    operationId,
  ) =>
    Effect.sync(() => {
      const record = this.startRecords.get(operationId)
      if (record !== undefined && record.organizationId === organizationId)
        this.startRecords.set(operationId, {
          ...record,
          state: 'started',
          attempts: record.attempts + 1,
          lastError: null,
        })
    })

  readonly recordWorkflowStartFailure: LifecycleRepositoryShape['recordWorkflowStartFailure'] = (
    organizationId,
    operationId,
    message,
  ) =>
    Effect.sync(() => {
      const record = this.startRecords.get(operationId)
      if (record !== undefined && record.organizationId === organizationId)
        this.startRecords.set(operationId, {
          ...record,
          attempts: record.attempts + 1,
          lastError: message,
        })
    })
}

const server = (overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot =>
  ({
    kind: 'server',
    id: 'server-1',
    organizationId: 'org-a',
    desiredState: 'stopped',
    observedState: 'stopped',
    desiredRevision: 3,
    lastVerifiedBackupRevision: 3,
    ...overrides,
  }) as ResourceSnapshot

const base = {
  organizationId: 'org-a',
  actorId: 'user-1',
  resourceId: 'server-1',
  idempotencyKey: 'request-1',
  expectedDesiredRevision: 3,
  correlationId: 'correlation-1',
} as const

const starter = (): WorkflowStarterShape & { starts: Set<string> } => {
  const starts = new Set<string>()
  return {
    starts,
    start: ({ operation }) =>
      Effect.sync(() => {
        starts.add(operation.id)
      }),
  }
}

const exitTag = async (effect: Effect.Effect<unknown, unknown>) => {
  const outcome = await Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null })),
  )
  if (outcome === null) return 'Success'
  return typeof outcome === 'object' && '_tag' in outcome ? String(outcome._tag) : 'Defect'
}

describe('lifecycle control', () => {
  it('denies a cross-organization resource without creating an operation', async () => {
    const repository = new MemoryRepository([server()])
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, starter())
    const command: LifecycleCommand = {
      ...base,
      organizationId: 'org-b',
      kind: 'set-server-state',
      state: 'running',
    }
    expect(await exitTag(service.submit(command))).toBe('OrganizationScopeError')
    expect(repository.submissions.size).toBe(0)
  })

  it('adopts the same key and fingerprint after the revision was reserved', async () => {
    const repository = new MemoryRepository([server()])
    const workflows = starter()
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, workflows)
    const command: LifecycleCommand = { ...base, kind: 'set-server-state', state: 'running' }
    const first = await Effect.runPromise(service.submit(command))
    const replay = await Effect.runPromise(service.submit(command))
    expect(first.disposition).toBe('created')
    expect(replay.disposition).toBe('adopted')
    expect(replay.operation.id).toBe(first.operation.id)
    expect(repository.submissions.size).toBe(1)
    expect(workflows.starts.size).toBe(1)
  })

  it('rejects a reused key when the canonical fingerprint changes', async () => {
    const repository = new MemoryRepository([server()])
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, starter())
    await Effect.runPromise(service.submit({ ...base, kind: 'set-server-state', state: 'running' }))
    expect(
      await exitTag(service.submit({ ...base, kind: 'set-server-state', state: 'stopped' })),
    ).toBe('IdempotencyConflictError')
    expect(repository.submissions.size).toBe(1)
  })

  it('rejects invalid transitions before durable reservation', async () => {
    const repository = new MemoryRepository([
      server({ observedState: 'running', desiredState: 'running' }),
    ])
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, starter())
    const command: LifecycleCommand = {
      ...base,
      kind: 'restore-backup',
      backupId: 'backup-1',
    }
    expect(await exitTag(service.submit(command))).toBe('InvalidTransitionError')
    expect(repository.submissions.size).toBe(0)
  })

  it('enforces the revision again inside the atomic adapter', async () => {
    const repository = new MemoryRepository([server()])
    repository.beforeReserve = (input) => {
      const current = repository.resources.get(input.command.resourceId)
      if (current !== undefined)
        repository.resources.set(current.id, { ...current, desiredRevision: 4 } as ResourceSnapshot)
    }
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, starter())
    expect(
      await exitTag(service.submit({ ...base, kind: 'set-server-state', state: 'running' })),
    ).toBe('RevisionConflictError')
    expect(repository.submissions.size).toBe(0)
  })

  it.each(['shared', 'dedicated'] as const)(
    'preserves %s placement intent in the desired-state reservation',
    async (mode) => {
      const repository = new MemoryRepository([server({ observedState: 'unknown' })])
      const service = makeLifecycleControl(repository, baselinePolicyAdmission, starter())
      const result = await Effect.runPromise(
        service.submit({
          ...base,
          kind: 'deploy-server',
          placement: { mode, nodeId: mode === 'shared' ? 'node-1' : 'node-2' },
        }),
      )
      expect(result.reservation.placement).toEqual({
        mode,
        nodeId: mode === 'shared' ? 'node-1' : 'node-2',
      })
    },
  )

  it('requires a verified current backup before delete when policy requires one', async () => {
    const repository = new MemoryRepository([server({ lastVerifiedBackupRevision: 2 })])
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, starter())
    expect(
      await exitTag(service.submit({ ...base, kind: 'delete-server', backupPolicy: 'required' })),
    ).toBe('PolicyDeniedError')
    expect(repository.submissions.size).toBe(0)
  })

  it('retains a pending start record and safely adopts after workflow response loss', async () => {
    const repository = new MemoryRepository([server()])
    const workflowInstances = new Set<string>()
    let loseFirstResponse = true
    const workflows: WorkflowStarterShape = {
      start: ({ operation }) =>
        Effect.gen(function* () {
          workflowInstances.add(operation.id)
          if (loseFirstResponse) {
            loseFirstResponse = false
            return yield* new WorkflowStartError({
              operationId: operation.id,
              message: 'response lost after instance creation',
            })
          }
        }),
    }
    const service = makeLifecycleControl(repository, baselinePolicyAdmission, workflows)
    const command: LifecycleCommand = { ...base, kind: 'set-server-state', state: 'running' }
    const first = await Effect.runPromise(service.submit(command))
    expect(first.workflowState).toBe('pending-reconciliation')
    expect(repository.startRecords.get(first.operation.id)?.lastError).toContain('response lost')

    const replay = await Effect.runPromise(service.submit(command))
    expect(replay.disposition).toBe('adopted')
    expect(replay.workflowState).toBe('started')
    expect(workflowInstances.size).toBe(1)
    expect(repository.startRecords.get(first.operation.id)?.state).toBe('started')
  })

  it('uses a deterministic canonical fingerprint independent of object key order', () => {
    const command = { ...base, kind: 'set-server-state', state: 'running' } as const
    const reordered = {
      state: 'running',
      kind: 'set-server-state',
      correlationId: base.correlationId,
      expectedDesiredRevision: base.expectedDesiredRevision,
      idempotencyKey: base.idempotencyKey,
      resourceId: base.resourceId,
      actorId: base.actorId,
      organizationId: base.organizationId,
    } as const
    expect(canonicalCommandFingerprint(command)).toBe(canonicalCommandFingerprint(reordered))
  })
})

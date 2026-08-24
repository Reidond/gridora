import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
  BackupArtifact,
  BackupControlShape,
  BackupJob,
  BackupRepositoryShape,
} from '@gridora/backup-control'
import {
  BackupWorkflowError,
  BackupWorkflowExecutor,
  makeBackupWorkflowLayer,
  type BackupArchiveAgentShape,
  type BackupRestoreCutoverShape,
  type BackupRestoreObservationShape,
  type BackupUploadPortShape,
  type BackupWorkflowReceiptShape,
  type BackupWorkflowSignatureShape,
  type SignedBackupWorkflowStep,
} from '../src/index.js'

const now = '2026-08-23T10:00:00.000Z'
const metadata = {
  pluginId: 'arma-reforger',
  pluginVersion: '1.0.0',
  gameBuild: 'arma-build-1',
  configRevision: 1,
  modSetRevision: 0,
  desiredRevision: 1,
  nodeId: 'node-a',
  consistency: 'crash-consistent' as const,
  includes: ['config', 'data'] as const,
  containsGameBinaries: false as const,
}
const job: BackupJob = {
  organizationId: 'org-a',
  id: 'job-a',
  operationId: 'op-a',
  mode: 'restore',
  trigger: 'manual',
  backupId: 'backup-a',
  sourceServerId: 'server-a',
  targetServerId: 'server-a',
  sourceNodeId: 'node-a',
  targetNodeId: 'node-b',
  idempotencyKey: 'restore-key-a',
  fingerprint: 'a'.repeat(64),
  completionFingerprint: null,
  state: 'running',
  revision: 1,
  createdAt: now,
  updatedAt: now,
  cancelledAt: null,
}
const artifact: BackupArtifact = {
  organizationId: 'org-a',
  id: 'backup-a',
  serverId: 'server-a',
  r2Key: 'organizations/org-a/servers/server-a/backups/backup-a',
  checksum: `sha256:${'b'.repeat(64)}`,
  encryptionVersion: 1,
  metadata,
  state: 'available',
  revision: 1,
  createdAt: now,
  expiresAt: null,
}

const step = (
  name: SignedBackupWorkflowStep['step'],
  ordinal = name === 'complete' ? 4 : 0,
): SignedBackupWorkflowStep => ({
  apiVersion: 'backup.workflow.gridora.dev/v1alpha1',
  organizationId: job.organizationId,
  operationId: job.operationId,
  jobId: job.id,
  step: name,
  ordinal,
  issuedAt: now,
  expiresAt: '2026-08-23T11:00:00.000Z',
  payload: {},
  signature: 's'.repeat(32),
})

const defaultReceipts: BackupWorkflowReceiptShape = {
  claim: () => Effect.succeed({ disposition: 'execute', revision: 1 }),
  complete: () => Effect.void,
  requireCommittedRestore: () =>
    Effect.succeed({ committed: true, sourcePreserved: true, revision: 1 }),
}

const makeExecutor = (
  observation: BackupRestoreObservationShape,
  receipts: BackupWorkflowReceiptShape = defaultReceipts,
  cutoverOverride?: BackupRestoreCutoverShape,
) => {
  const control = {
    markRunning: () => Effect.succeed(job),
    markSucceeded: () =>
      Effect.succeed({
        ...job,
        state: 'succeeded' as const,
        revision: 2,
        completionFingerprint: 'c'.repeat(64),
      }),
    markFailed: () => Effect.succeed({ ...job, state: 'failed' as const, revision: 2 }),
  } as unknown as BackupControlShape
  const signature: BackupWorkflowSignatureShape = { verify: () => Effect.succeed(true) }
  const agent: BackupArchiveAgentShape = {
    create: () =>
      Effect.succeed({
        archivePath: '/var/lib/gridora/archive',
        bytes: 1,
        sha256: artifact.checksum,
        checksum: artifact.checksum,
        encryptionVersion: artifact.encryptionVersion,
        r2Key: artifact.r2Key,
        manifestVerified: true,
      }),
    restore: () => Effect.succeed({ staged: true, validation: 'passed' }),
  }
  const uploader: BackupUploadPortShape = {
    upload: () =>
      Effect.succeed({
        checksum: artifact.checksum,
        encryptionVersion: 1,
        r2Key: artifact.r2Key,
        manifestVerified: true,
      }),
  }
  const cutover: BackupRestoreCutoverShape = cutoverOverride ?? {
    validate: () => Effect.succeed({ validated: true }),
    cutover: () => Effect.succeed({ cutover: true, sourcePreserved: true }),
    rollback: () => Effect.succeed({ rolledBack: true, sourcePreserved: true }),
    finalize: () => Effect.succeed({ finalized: true }),
  }
  return Effect.runSync(
    Effect.service(BackupWorkflowExecutor).pipe(
      Effect.provide(
        makeBackupWorkflowLayer({
          control,
          repository: {} as BackupRepositoryShape,
          signature,
          agent,
          uploader,
          cutover,
          observation,
          receipts,
        }),
      ),
    ),
  )
}

describe('backup workflow executor', () => {
  it('fails unsupported workflow steps instead of reporting a no-op success', async () => {
    const executor = makeExecutor({
      observe: () =>
        Effect.fail(new BackupWorkflowError({ code: 'restore-failed', message: 'not used' })),
    })
    const result = await Effect.runPromise(
      Effect.result(executor.execute(step('reserve'), job, artifact, now)),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(BackupWorkflowError)
      expect(result.failure.code).toBe('invalid-step')
    }
  })

  it('requires an exact agent observation before restore completion', async () => {
    const noObservation = makeExecutor({
      observe: () =>
        Effect.fail(
          new BackupWorkflowError({ code: 'restore-failed', message: 'observation unavailable' }),
        ),
    })
    const failed = await Effect.runPromise(
      Effect.result(noObservation.execute(step('complete'), job, artifact, now)),
    )
    expect(failed._tag).toBe('Failure')

    const observed: BackupRestoreObservationShape = {
      observe: () =>
        Effect.succeed({
          observed: true,
          sourceServerId: 'server-a',
          targetServerId: 'server-a',
          targetNodeId: 'node-b',
          observedRevision: 4,
        }),
    }
    const executor = makeExecutor(observed)
    const completed = await Effect.runPromise(
      executor.execute(step('complete'), job, artifact, now),
    )
    expect(completed.job.state).toBe('succeeded')
  })

  it('rejects skipped signed ordinals before any durable claim', async () => {
    let claims = 0
    const executor = makeExecutor(
      { observe: () => Effect.die('not used') },
      {
        ...defaultReceipts,
        claim: () => {
          claims += 1
          return Effect.succeed({ disposition: 'execute', revision: 1 })
        },
      },
    )
    const result = await Effect.runPromise(
      Effect.result(executor.execute(step('agent-restore-stage', 2), job, artifact, now)),
    )
    expect(result._tag).toBe('Failure')
    expect(claims).toBe(0)
  })

  it('requires committed source-preserving cutover evidence and adopts a persisted response', async () => {
    let observations = 0
    const observation: BackupRestoreObservationShape = {
      observe: () => {
        observations += 1
        return Effect.succeed({
          observed: true,
          sourceServerId: 'server-a',
          targetServerId: 'server-a',
          targetNodeId: 'node-b',
          observedRevision: 4,
        })
      },
    }
    const blocked = makeExecutor(observation, {
      ...defaultReceipts,
      requireCommittedRestore: () =>
        Effect.fail(
          new BackupWorkflowError({ code: 'restore-failed', message: 'cutover is not committed' }),
        ),
    })
    expect(
      (
        await Effect.runPromise(
          Effect.result(blocked.execute(step('complete'), job, artifact, now)),
        )
      )._tag,
    ).toBe('Failure')
    expect(observations).toBe(0)

    const adopted = makeExecutor(observation, {
      ...defaultReceipts,
      claim: () => Effect.succeed({ disposition: 'adopted', revision: 2 }),
    })
    expect(
      (await Effect.runPromise(adopted.execute(step('complete'), job, artifact, now))).job,
    ).toBe(job)
    expect(observations).toBe(0)
  })

  it('retries a claimed effect with one durable idempotent cutover mutation', async () => {
    const applied = new Set<string>()
    let physicalCutovers = 0
    let receiptCompletions = 0
    const cutover: BackupRestoreCutoverShape = {
      validate: () => Effect.succeed({ validated: true }),
      rollback: () => Effect.succeed({ rolledBack: true, sourcePreserved: true }),
      finalize: () => Effect.succeed({ finalized: true }),
      cutover: ({ effectId }) => {
        if (!applied.has(effectId)) {
          applied.add(effectId)
          physicalCutovers += 1
        }
        return Effect.succeed({ cutover: true, sourcePreserved: true })
      },
    }
    const receipts: BackupWorkflowReceiptShape = {
      ...defaultReceipts,
      claim: () => Effect.succeed({ disposition: 'execute', revision: 1 }),
      complete: () => {
        receiptCompletions += 1
        return receiptCompletions === 1
          ? Effect.fail(
              new BackupWorkflowError({
                code: 'persistence-failed',
                message: 'response lost after commit boundary',
              }),
            )
          : Effect.void
      },
    }
    const executor = makeExecutor({ observe: () => Effect.die('not used') }, receipts, cutover)
    const signedCutover = step('restore-cutover', 3)
    expect(
      (await Effect.runPromise(Effect.result(executor.execute(signedCutover, job, artifact, now))))
        ._tag,
    ).toBe('Failure')
    expect((await Effect.runPromise(executor.execute(signedCutover, job, artifact, now))).job).toBe(
      job,
    )
    expect(receiptCompletions).toBe(2)
    expect(physicalCutovers).toBe(1)
  })
})

import { Context, Effect, Layer, Schema } from 'effect'
import {
  BackupArtifact,
  BackupControl,
  BackupMetadata,
  BackupPersistenceError,
  type BackupJob,
  type BackupControlShape,
  type BackupRepositoryShape,
} from '@gridora/backup-control'

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
export const BackupWorkflowStep = Schema.Literals([
  'reserve',
  'mark-running',
  'agent-create',
  'r2-upload',
  'manifest-verify',
  'agent-restore-stage',
  'restore-validate',
  'restore-cutover',
  'restore-rollback',
  'restore-finalize',
  'retention-delete',
  'complete',
  'fail',
])
export type BackupWorkflowStep = typeof BackupWorkflowStep.Type

export const SignedBackupWorkflowStep = Schema.Struct({
  apiVersion: Schema.Literal('backup.workflow.gridora.dev/v1alpha1'),
  organizationId: identifier,
  operationId: identifier,
  jobId: identifier,
  step: BackupWorkflowStep,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  issuedAt: timestamp,
  expiresAt: timestamp,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  signature: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
})
export type SignedBackupWorkflowStep = typeof SignedBackupWorkflowStep.Type

export const canonicalWorkflowStep = (
  input: Omit<SignedBackupWorkflowStep, 'signature'>,
): string => {
  const sort = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(sort).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sort(object[key])}`)
      .join(',')}}`
  }
  return sort(input)
}

export interface BackupWorkflowSignatureShape {
  readonly verify: (
    step: SignedBackupWorkflowStep,
  ) => Effect.Effect<boolean, BackupPersistenceError>
}
export class BackupWorkflowSignature extends Context.Service<
  BackupWorkflowSignature,
  BackupWorkflowSignatureShape
>()('@gridora/backup-workflow/BackupWorkflowSignature') {}
export const BackupWorkflowSignatureLayer = (port: BackupWorkflowSignatureShape) =>
  Layer.succeed(BackupWorkflowSignature, port)

export interface BackupArchiveAgentShape {
  /** Implementations must durably adopt the exact effectId and must not repeat
   * the archive or restore mutation after a timeout or lost response. */
  readonly create: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly backupId: string
    readonly serverId: string
    readonly nodeId: string
    readonly metadata: BackupMetadata
    readonly signal?: AbortSignal
  }) => Effect.Effect<
    {
      readonly archivePath: string
      readonly bytes: number
      readonly sha256: string
      readonly checksum: string
      readonly encryptionVersion: number
      readonly r2Key: string
      readonly manifestVerified: true
    },
    BackupWorkflowError
  >
  readonly restore: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly backupId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
    readonly artifact: BackupArtifact
    readonly signal?: AbortSignal
  }) => Effect.Effect<{ readonly staged: true; readonly validation: 'passed' }, BackupWorkflowError>
}
export class BackupArchiveAgent extends Context.Service<
  BackupArchiveAgent,
  BackupArchiveAgentShape
>()('@gridora/backup-workflow/BackupArchiveAgent') {}
export const BackupArchiveAgentLayer = (port: BackupArchiveAgentShape) =>
  Layer.succeed(BackupArchiveAgent, port)

export interface BackupUploadPortShape {
  /** The upload adapter must make effectId an exact durable idempotency key. */
  readonly upload: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly backupId: string
    readonly serverId: string
    readonly archivePath: string
    readonly bytes: number
    readonly sha256: string
    readonly signal?: AbortSignal
  }) => Effect.Effect<
    {
      readonly checksum: string
      readonly encryptionVersion: number
      readonly r2Key: string
      readonly manifestVerified: true
    },
    BackupWorkflowError
  >
}
export class BackupUploadPort extends Context.Service<BackupUploadPort, BackupUploadPortShape>()(
  '@gridora/backup-workflow/BackupUploadPort',
) {}
export const BackupUploadPortLayer = (port: BackupUploadPortShape) =>
  Layer.succeed(BackupUploadPort, port)

export interface BackupRestoreCutoverShape {
  /** Every method must durably adopt effectId before changing endpoint state. */
  readonly validate: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly backupId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  }) => Effect.Effect<{ readonly validated: true }, BackupWorkflowError>
  readonly cutover: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  }) => Effect.Effect<
    { readonly cutover: true; readonly sourcePreserved: true },
    BackupWorkflowError
  >
  readonly rollback: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
    readonly backupId: string
  }) => Effect.Effect<
    { readonly rolledBack: true; readonly sourcePreserved: true },
    BackupWorkflowError
  >
  readonly finalize: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly backupId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  }) => Effect.Effect<{ readonly finalized: true }, BackupWorkflowError>
}
export class BackupRestoreCutover extends Context.Service<
  BackupRestoreCutover,
  BackupRestoreCutoverShape
>()('@gridora/backup-workflow/BackupRestoreCutover') {}
export const BackupRestoreCutoverLayer = (port: BackupRestoreCutoverShape) =>
  Layer.succeed(BackupRestoreCutover, port)

/** A restore completion must be based on an authenticated agent observation,
 * not the acknowledgement of a stage/cutover request. The adapter persists or
 * verifies this observation against the node's monotonic observation stream. */
export interface BackupRestoreObservationShape {
  readonly observe: (input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly backupId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  }) => Effect.Effect<
    {
      readonly observed: true
      readonly sourceServerId: string
      readonly targetServerId: string
      readonly targetNodeId: string
      readonly observedRevision: number
    },
    BackupWorkflowError
  >
}
export class BackupRestoreObservation extends Context.Service<
  BackupRestoreObservation,
  BackupRestoreObservationShape
>()('@gridora/backup-workflow/BackupRestoreObservation') {}
export const BackupRestoreObservationLayer = (port: BackupRestoreObservationShape) =>
  Layer.succeed(BackupRestoreObservation, port)

export interface BackupWorkflowReceiptClaim {
  readonly disposition: 'execute' | 'adopted'
  readonly revision: number
}

export interface BackupWorkflowReceiptShape {
  readonly claim: (input: {
    readonly job: BackupJob
    readonly ordinal: number
    readonly step: BackupWorkflowStep
    readonly payloadFingerprint: string
    readonly now: string
  }) => Effect.Effect<BackupWorkflowReceiptClaim, BackupWorkflowError>
  readonly complete: (input: {
    readonly job: BackupJob
    readonly ordinal: number
    readonly step: BackupWorkflowStep
    readonly payloadFingerprint: string
    readonly expectedRevision: number
    readonly evidence: Readonly<Record<string, unknown>>
    readonly now: string
  }) => Effect.Effect<void, BackupWorkflowError>
  readonly requireCommittedRestore: (job: BackupJob) => Effect.Effect<
    {
      readonly committed: true
      readonly sourcePreserved: true
      readonly revision: number
    },
    BackupWorkflowError
  >
}
export class BackupWorkflowReceipt extends Context.Service<
  BackupWorkflowReceipt,
  BackupWorkflowReceiptShape
>()('@gridora/backup-workflow/BackupWorkflowReceipt') {}
export const BackupWorkflowReceiptLayer = (port: BackupWorkflowReceiptShape) =>
  Layer.succeed(BackupWorkflowReceipt, port)

export class BackupWorkflowError extends Schema.TaggedError<BackupWorkflowError>()(
  'BackupWorkflowError',
  {
    code: Schema.Literals([
      'invalid-step',
      'signature-invalid',
      'expired-step',
      'scope-mismatch',
      'cancelled',
      'agent-failed',
      'upload-failed',
      'restore-failed',
      'persistence-failed',
    ]),
    message: Schema.String,
  },
) {}

export interface BackupWorkflowExecutorShape {
  readonly execute: (
    step: SignedBackupWorkflowStep,
    job: BackupJob,
    artifact: BackupArtifact,
    now: string,
  ) => Effect.Effect<
    { readonly job: BackupJob; readonly artifact: BackupArtifact },
    BackupWorkflowError
  >
}
export class BackupWorkflowExecutor extends Context.Service<
  BackupWorkflowExecutor,
  BackupWorkflowExecutorShape
>()('@gridora/backup-workflow/BackupWorkflowExecutor') {}

const fail = (
  code: ConstructorParameters<typeof BackupWorkflowError>[0]['code'],
  message: string,
) => new BackupWorkflowError({ code, message })

const payloadString = (
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
const payloadBytes = (payload: Readonly<Record<string, unknown>>): number | undefined => {
  const value = payload['bytes']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const expectedStep = (job: BackupJob, step: BackupWorkflowStep, ordinal: number): boolean => {
  const sequence =
    job.mode === 'create'
      ? (['mark-running', 'agent-create'] as const)
      : ([
          'mark-running',
          'agent-restore-stage',
          'restore-validate',
          'restore-cutover',
          'complete',
          'restore-finalize',
        ] as const)
  if (step === 'fail') return ordinal === 100
  if (job.mode === 'restore' && step === 'restore-rollback') return ordinal === 99
  return sequence[ordinal] === step
}

const workflowStepFingerprint = (step: SignedBackupWorkflowStep) =>
  Effect.tryPromise({
    try: async () => {
      const { signature: _signature, ...unsigned } = step
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalWorkflowStep(unsigned)),
      )
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => fail('persistence-failed', 'backup Workflow step fingerprint failed'),
  })

export const BackupWorkflowExecutorLive = Layer.effect(
  BackupWorkflowExecutor,
  Effect.gen(function* () {
    const control = yield* BackupControl
    const signature = yield* BackupWorkflowSignature
    const agent = yield* BackupArchiveAgent
    const uploader = yield* BackupUploadPort
    const cutover = yield* BackupRestoreCutover
    const observation = yield* BackupRestoreObservation
    const receipts = yield* BackupWorkflowReceipt
    return BackupWorkflowExecutor.of({
      execute: (step, job, artifact, now) =>
        Effect.gen(function* () {
          if (
            step.organizationId !== job.organizationId ||
            step.jobId !== job.id ||
            step.operationId !== job.operationId
          )
            return yield* fail(
              'scope-mismatch',
              'signed backup Workflow scope does not match durable job',
            )
          if (Date.parse(step.expiresAt) <= Date.parse(now))
            return yield* fail('expired-step', 'signed backup Workflow step expired')
          if (
            !(yield* signature
              .verify(step)
              .pipe(
                Effect.mapError(() =>
                  fail('persistence-failed', 'backup Workflow signature verification failed'),
                ),
              ))
          )
            return yield* fail('signature-invalid', 'backup Workflow step signature is invalid')
          if (
            job.state === 'cancelled' ||
            job.state === 'failed' ||
            job.state === 'failed_terminal'
          )
            return yield* fail('cancelled', 'backup Workflow is already terminal')
          if (!expectedStep(job, step.step, step.ordinal))
            return yield* fail(
              'invalid-step',
              'backup Workflow step is skipped, reordered, or invalid for this job',
            )
          const payloadFingerprint = yield* workflowStepFingerprint(step)
          const receipt = yield* receipts.claim({
            job,
            ordinal: step.ordinal,
            step: step.step,
            payloadFingerprint,
            now,
          })
          if (receipt.disposition === 'adopted') return { job, artifact }
          const effectId = `${job.organizationId}:${job.id}:${step.ordinal}:${payloadFingerprint}`
          let evidence: Readonly<Record<string, unknown>> = {}
          const result = yield* Effect.gen(function* () {
            switch (step.step) {
              case 'mark-running': {
                const updated = yield* control
                  .markRunning(job.organizationId, job.id, job.revision)
                  .pipe(
                    Effect.mapError(() =>
                      fail('persistence-failed', 'backup job could not be marked running'),
                    ),
                  )
                return { job: updated, artifact }
              }
              case 'agent-create': {
                if (job.mode !== 'create' || job.sourceNodeId === null)
                  return yield* fail('invalid-step', 'agent-create requires a create job')
                const details = yield* agent
                  .create({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    serverId: job.sourceServerId,
                    nodeId: job.sourceNodeId,
                    metadata: artifact.metadata,
                  })
                  .pipe(Effect.mapError(() => fail('agent-failed', 'agent backup archive failed')))
                if (
                  details.checksum !== details.sha256 ||
                  !details.manifestVerified ||
                  details.r2Key !== artifact.r2Key
                )
                  return yield* fail(
                    'upload-failed',
                    'agent upload evidence does not match the reserved backup',
                  )
                evidence = details
                const completed = yield* control
                  .markSucceeded({
                    organizationId: job.organizationId,
                    jobId: job.id,
                    expectedRevision: job.revision,
                    checksum: details.checksum,
                    encryptionVersion: details.encryptionVersion,
                    r2Key: details.r2Key,
                    manifest: artifact.metadata,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('persistence-failed', 'backup completion could not be recorded'),
                    ),
                  )
                return {
                  job: completed,
                  artifact: {
                    ...artifact,
                    checksum: details.checksum,
                    encryptionVersion: details.encryptionVersion,
                    state: 'available' as const,
                  },
                }
              }
              case 'r2-upload': {
                if (job.mode !== 'create')
                  return yield* fail('invalid-step', 'r2-upload requires a create job')
                const archivePath = payloadString(step.payload, 'archivePath')
                const sha256 = payloadString(step.payload, 'sha256')
                const bytes = payloadBytes(step.payload)
                if (archivePath === undefined || sha256 === undefined || bytes === undefined)
                  return yield* fail(
                    'invalid-step',
                    'r2-upload requires bounded archive path, byte count, and checksum',
                  )
                const details = yield* uploader
                  .upload({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    serverId: job.sourceServerId,
                    archivePath,
                    bytes,
                    sha256,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('upload-failed', 'backup upload failed or was not verified'),
                    ),
                  )
                evidence = details
                const completed = yield* control
                  .markSucceeded({
                    organizationId: job.organizationId,
                    jobId: job.id,
                    expectedRevision: job.revision,
                    checksum: details.checksum,
                    encryptionVersion: details.encryptionVersion,
                    r2Key: details.r2Key,
                    manifest: artifact.metadata,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('persistence-failed', 'backup completion could not be recorded'),
                    ),
                  )
                return {
                  job: completed,
                  artifact: {
                    ...artifact,
                    checksum: details.checksum,
                    encryptionVersion: details.encryptionVersion,
                    r2Key: details.r2Key,
                    state: 'available' as const,
                  },
                }
              }
              case 'agent-restore-stage': {
                if (
                  job.mode !== 'restore' ||
                  job.targetServerId === null ||
                  job.targetNodeId === null
                )
                  return yield* fail(
                    'invalid-step',
                    'agent-restore-stage requires a restore target',
                  )
                evidence = yield* agent
                  .restore({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    sourceServerId: job.sourceServerId,
                    targetServerId: job.targetServerId,
                    targetNodeId: job.targetNodeId,
                    artifact,
                  })
                  .pipe(Effect.mapError(() => fail('agent-failed', 'restore staging failed')))
                return { job, artifact }
              }
              case 'restore-validate': {
                if (
                  job.mode !== 'restore' ||
                  job.targetServerId === null ||
                  job.targetNodeId === null
                )
                  return yield* fail('invalid-step', 'restore-validate requires a restore target')
                evidence = yield* cutover
                  .validate({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    sourceServerId: job.sourceServerId,
                    targetServerId: job.targetServerId,
                    targetNodeId: job.targetNodeId,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('restore-failed', 'plugin/config/mod validation failed'),
                    ),
                  )
                return { job, artifact }
              }
              case 'restore-cutover': {
                if (
                  job.mode !== 'restore' ||
                  job.targetServerId === null ||
                  job.targetNodeId === null
                )
                  return yield* fail('invalid-step', 'restore-cutover requires a restore target')
                const cutoverResult = yield* cutover
                  .cutover({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    sourceServerId: job.sourceServerId,
                    targetServerId: job.targetServerId,
                    targetNodeId: job.targetNodeId,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('restore-failed', 'restore endpoint cutover failed'),
                    ),
                  )
                if (!cutoverResult.sourcePreserved)
                  return yield* fail('restore-failed', 'restore cutover did not preserve source')
                evidence = cutoverResult
                return { job, artifact }
              }
              case 'restore-rollback': {
                if (
                  job.mode !== 'restore' ||
                  job.targetServerId === null ||
                  job.targetNodeId === null
                )
                  return yield* fail('invalid-step', 'restore-rollback requires a restore target')
                evidence = yield* cutover
                  .rollback({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    sourceServerId: job.sourceServerId,
                    targetServerId: job.targetServerId,
                    targetNodeId: job.targetNodeId,
                  })
                  .pipe(Effect.mapError(() => fail('restore-failed', 'restore rollback failed')))
                return { job, artifact }
              }
              case 'restore-finalize': {
                if (
                  job.mode !== 'restore' ||
                  job.targetServerId === null ||
                  job.targetNodeId === null
                )
                  return yield* fail('invalid-step', 'restore-finalize requires a restore target')
                evidence = yield* cutover
                  .finalize({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    sourceServerId: job.sourceServerId,
                    targetServerId: job.targetServerId,
                    targetNodeId: job.targetNodeId,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('restore-failed', 'restore rollback material finalization failed'),
                    ),
                  )
                return { job, artifact }
              }
              case 'fail': {
                const failed = yield* control
                  .markFailed({
                    organizationId: job.organizationId,
                    jobId: job.id,
                    expectedRevision: job.revision,
                    terminal: step.payload['terminal'] === true,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('persistence-failed', 'backup failure could not be recorded'),
                    ),
                  )
                return { job: failed, artifact }
              }
              case 'complete': {
                if (
                  job.mode !== 'restore' ||
                  job.targetServerId === null ||
                  job.targetNodeId === null
                )
                  return yield* fail(
                    'invalid-step',
                    'complete requires restore completion handled by cutover',
                  )
                yield* receipts.requireCommittedRestore(job)
                const completedObservation = yield* observation
                  .observe({
                    effectId,
                    organizationId: job.organizationId,
                    jobId: job.id,
                    backupId: job.backupId,
                    sourceServerId: job.sourceServerId,
                    targetServerId: job.targetServerId,
                    targetNodeId: job.targetNodeId,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail(
                        'restore-failed',
                        'restore completion has no validated agent observation',
                      ),
                    ),
                  )
                if (
                  !completedObservation.observed ||
                  completedObservation.sourceServerId !== job.sourceServerId ||
                  completedObservation.targetServerId !== job.targetServerId ||
                  completedObservation.targetNodeId !== job.targetNodeId ||
                  !Number.isSafeInteger(completedObservation.observedRevision) ||
                  completedObservation.observedRevision < 1
                )
                  return yield* fail(
                    'restore-failed',
                    'restore completion observation does not match the reserved target',
                  )
                evidence = { ...completedObservation, committed: true, sourcePreserved: true }
                const completed = yield* control
                  .markSucceeded({
                    organizationId: job.organizationId,
                    jobId: job.id,
                    expectedRevision: job.revision,
                    checksum: artifact.checksum,
                    encryptionVersion: artifact.encryptionVersion,
                    r2Key: artifact.r2Key,
                    manifest: artifact.metadata,
                  })
                  .pipe(
                    Effect.mapError(() =>
                      fail('persistence-failed', 'restore completion could not be recorded'),
                    ),
                  )
                return { job: completed, artifact }
              }
              default:
                return yield* fail('invalid-step', `unsupported backup Workflow step: ${step.step}`)
            }
          })
          yield* receipts.complete({
            job,
            ordinal: step.ordinal,
            step: step.step,
            payloadFingerprint,
            expectedRevision: receipt.revision,
            evidence,
            now,
          })
          return result
        }),
    })
  }),
)

export const makeBackupWorkflowLayer = (options: {
  readonly control: BackupControlShape
  readonly repository: BackupRepositoryShape
  readonly signature: BackupWorkflowSignatureShape
  readonly agent: BackupArchiveAgentShape
  readonly uploader: BackupUploadPortShape
  readonly cutover: BackupRestoreCutoverShape
  readonly observation: BackupRestoreObservationShape
  readonly receipts: BackupWorkflowReceiptShape
}) =>
  BackupWorkflowExecutorLive.pipe(
    Layer.provide(Layer.succeed(BackupControl, options.control)),
    Layer.provide(BackupWorkflowSignatureLayer(options.signature)),
    Layer.provide(BackupArchiveAgentLayer(options.agent)),
    Layer.provide(BackupUploadPortLayer(options.uploader)),
    Layer.provide(BackupRestoreCutoverLayer(options.cutover)),
    Layer.provide(BackupRestoreObservationLayer(options.observation)),
    Layer.provide(BackupWorkflowReceiptLayer(options.receipts)),
  )

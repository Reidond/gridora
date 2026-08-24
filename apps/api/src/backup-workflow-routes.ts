import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { ConflictError, NotFoundError, PersistenceError } from '@gridora/contracts'
import {
  BackupArtifact,
  BackupNotFoundError,
  BackupPersistenceError,
  type BackupArtifact as BackupArtifactType,
  type BackupJob,
} from '@gridora/backup-control'
import {
  BackupWorkflowError,
  SignedBackupWorkflowStep,
  type BackupWorkflowExecutorShape,
  type SignedBackupWorkflowStep as SignedBackupWorkflowStepType,
} from '@gridora/backup-workflow'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

export class BackupWorkflowRequestValidationError extends Schema.TaggedError<BackupWorkflowRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface BackupWorkflowRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Verify the internal service identity and signature before durable loading. */
  readonly authenticate: (request: Request, rawBody: Uint8Array) => Effect.Effect<void, unknown, R>
  readonly executor: (
    bindings: E['Bindings'],
  ) => Effect.Effect<BackupWorkflowExecutorShape, never, R>
  readonly load: (
    bindings: E['Bindings'],
    step: SignedBackupWorkflowStepType,
  ) => Effect.Effect<
    { readonly job: BackupJob; readonly artifact: BackupArtifactType },
    BackupNotFoundError | BackupPersistenceError,
    R
  >
  readonly now: (bindings: E['Bindings']) => Effect.Effect<string, BackupPersistenceError, R>
}

const invalid = (message: string) => new BackupWorkflowRequestValidationError({ message })
export const readBackupWorkflowBody = (request: Request, maximumBytes = 65_536) =>
  Effect.tryPromise({
    try: async () => {
      const declared = request.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))
        throw new Error('The request body exceeds the backup Workflow limit')
      if (request.body === null) return new Uint8Array()
      const reader = request.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const read = await reader.read()
        if (read.done) break
        size += read.value.byteLength
        if (size > maximumBytes) {
          await reader.cancel()
          throw new Error('The request body exceeds the backup Workflow limit')
        }
        chunks.push(read.value)
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return body
    },
    catch: () => invalid('The request body is missing or exceeds the backup Workflow limit'),
  })

const decodeStep = (body: Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(body)) as unknown,
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(SignedBackupWorkflowStep, { onExcessProperty: 'error' })(
        value,
      ).pipe(Effect.mapError(() => invalid('The request is not a signed backup Workflow step'))),
    ),
  )

const publicArtifact = (artifact: BackupArtifactType) => {
  const { r2Key: _privateKey, ...view } = artifact
  return view
}
const publicJob = (job: BackupJob) => ({
  organizationId: job.organizationId,
  id: job.id,
  operationId: job.operationId,
  mode: job.mode,
  trigger: job.trigger,
  backupId: job.backupId,
  sourceServerId: job.sourceServerId,
  targetServerId: job.targetServerId,
  sourceNodeId: job.sourceNodeId,
  targetNodeId: job.targetNodeId,
  state: job.state,
  revision: job.revision,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  cancelledAt: job.cancelledAt,
})

const mapError = (error: BackupWorkflowError | BackupNotFoundError | BackupPersistenceError) => {
  if (error instanceof BackupWorkflowRequestValidationError) return error
  if (error instanceof BackupNotFoundError)
    return new NotFoundError({ resource: 'backup-job', id: error.backupId })
  if (error instanceof BackupPersistenceError)
    return new PersistenceError({
      operation: error.operation,
      message: 'Backup Workflow state is unavailable',
    })
  if (
    error.code === 'scope-mismatch' ||
    error.code === 'invalid-step' ||
    error.code === 'signature-invalid' ||
    error.code === 'expired-step'
  )
    return new ConflictError({ code: error.code, message: error.message })
  return new PersistenceError({
    operation: 'backup.workflow.execute',
    message: 'Backup Workflow execution failed',
  })
}

/** Internal signed Workflow-step endpoint. Keep it out of the public route
 * registration until the composition root supplies service authentication and
 * the authoritative D1 loader. */
export const registerBackupWorkflowRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: BackupWorkflowRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.post(
    '/v1/internal/workflow-steps/execute',
    handler((context) =>
      Effect.gen(function* () {
        const rawBody = yield* readBackupWorkflowBody(context.req.raw)
        yield* dependencies.authenticate(context.req.raw, rawBody)
        const step = yield* decodeStep(rawBody)
        const loaded = yield* dependencies.load(context.env, step)
        const executor = yield* dependencies.executor(context.env)
        const now = yield* dependencies.now(context.env)
        const result = yield* executor
          .execute(step, loaded.job, loaded.artifact, now)
          .pipe(Effect.mapError(mapError))
        return jsonResponse({
          job: publicJob(result.job),
          artifact: publicArtifact(result.artifact),
        })
      }),
    ),
  )
  return app
}

export { BackupArtifact }

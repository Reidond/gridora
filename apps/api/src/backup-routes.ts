import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
} from '@gridora/contracts'
import { IdempotencyKey, type OrganizationContext } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  BackupArtifact,
  BackupAuthorizationError,
  BackupConflictError,
  BackupNotFoundError,
  BackupPersistenceError,
  BackupValidationError,
  type BackupArtifact as BackupArtifactType,
  type BackupControlError,
  type BackupControlShape,
  type BackupJob,
  type BackupCreateIntent,
  type BackupRestoreIntent,
} from '@gridora/backup-control'

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const restoreBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targetServerId: Schema.optional(identifier),
  targetNodeId: Schema.optional(identifier),
})
const createBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  includes: Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state'])),
  expiresAt: Schema.NullOr(Schema.String),
})
export class BackupRequestValidationError extends Schema.TaggedError<BackupRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface BackupRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'viewer' | 'operator' | 'administrator',
  ) => Effect.Effect<OrganizationContext, unknown, R>
  readonly control: (bindings: E['Bindings']) => Effect.Effect<BackupControlShape, never, R>
}

const invalid = (message: string) => new BackupRequestValidationError({ message })
function decodeBody(
  request: Request,
  schema: typeof createBody,
): Effect.Effect<BackupCreateIntent, BackupRequestValidationError>
function decodeBody(
  request: Request,
  schema: typeof restoreBody,
): Effect.Effect<BackupRestoreIntent, BackupRequestValidationError>
function decodeBody(request: Request, schema: typeof createBody | typeof restoreBody) {
  return Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() => invalid('The request does not match the backup API contract')),
      ),
    ),
  )
}
const decodeIdempotency = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )
const decodeIdentifier = (value: string, field: string) =>
  Schema.decodeUnknownEffect(identifier)(value).pipe(
    Effect.mapError(() => invalid(`${field} does not match the API contract`)),
  )
const decodeExpectedRevision = (value: string | undefined) => {
  if (value === undefined || !/^\d+$/.test(value))
    return Effect.fail(invalid('If-Match must contain the expected backup revision'))
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision > 0
    ? Effect.succeed(revision)
    : Effect.fail(invalid('If-Match must contain the expected backup revision'))
}

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

const mapError = (error: BackupControlError) => {
  if (error instanceof BackupValidationError)
    return invalid('The request does not match the backup API contract')
  if (error instanceof BackupAuthorizationError)
    return new AuthorizationError({
      code: 'role_required',
      message: 'The requested backup action requires a higher organization role',
    })
  if (error instanceof BackupNotFoundError)
    return new NotFoundError({ resource: 'backup', id: error.backupId })
  if (error instanceof BackupConflictError)
    return new ConflictError({ code: error.code, message: error.message })
  if (error instanceof BackupPersistenceError)
    return new PersistenceError({
      operation: error.operation,
      message: 'Authoritative backup state is unavailable',
    })
  return new ConflictError({
    code: 'backup_concurrency',
    message: 'Backup state changed; retry with the latest revision',
  })
}

/** Public backup endpoints. This file is intentionally not imported by the
 * central app index until the D1/Workflow composition root is selected. */
export const registerBackupRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: BackupRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)
  const collectionPath = '/v1/organizations/:organization/backups'

  app.post(
    '/v1/organizations/:organization/game-servers/:serverId/backups',
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'operator')
        const serverId = yield* decodeIdentifier(context.req.param('serverId') ?? '', 'Server id')
        const idempotencyKey = yield* decodeIdempotency(context.req.header('idempotency-key'))
        const body = yield* decodeBody(context.req.raw, createBody) as Effect.Effect<
          BackupCreateIntent,
          BackupRequestValidationError,
          R
        >
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .create(actor, { serverId, idempotencyKey, intent: body })
          .pipe(Effect.mapError(mapError))
        return jsonResponse(
          {
            disposition: result.disposition,
            job: publicJob(result.job),
            artifact: publicArtifact(result.artifact),
          },
          202,
        )
      }),
    ),
  )

  app.post(
    '/v1/organizations/:organization/backups/:backupId/actions/restore',
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'operator')
        const backupId = yield* decodeIdentifier(context.req.param('backupId') ?? '', 'Backup id')
        const body = yield* decodeBody(context.req.raw, restoreBody)
        const idempotencyKey = yield* decodeIdempotency(context.req.header('idempotency-key'))
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .restore(actor, {
            idempotencyKey,
            intent: {
              schemaVersion: 1,
              backupId,
              ...(body.targetServerId === undefined ? {} : { targetServerId: body.targetServerId }),
              ...(body.targetNodeId === undefined ? {} : { targetNodeId: body.targetNodeId }),
            },
          })
          .pipe(Effect.mapError(mapError))
        return jsonResponse(
          {
            disposition: result.disposition,
            job: publicJob(result.job),
            artifact: publicArtifact(result.artifact),
          },
          202,
        )
      }),
    ),
  )

  app.get(
    collectionPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const rawLimit = context.req.query('limit')
        const limit = rawLimit === undefined ? 50 : Number(rawLimit)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return yield* invalid('limit must be an integer between 1 and 100')
        const cursor = context.req.query('cursor')
        const serverIdQuery = context.req.query('serverId')
        const serverId =
          serverIdQuery === undefined
            ? undefined
            : yield* decodeIdentifier(serverIdQuery, 'Server id')
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .list(actor, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(serverId === undefined ? {} : { serverId }),
          })
          .pipe(Effect.mapError(mapError))
        return jsonResponse({
          items: result.items.map(publicArtifact),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        })
      }),
    ),
  )

  app.get(
    `${collectionPath}/:backupId`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'viewer')
        const backupId = yield* decodeIdentifier(context.req.param('backupId') ?? '', 'Backup id')
        const control = yield* dependencies.control(context.env)
        const artifact = yield* control.get(actor, backupId).pipe(Effect.mapError(mapError))
        return jsonResponse(publicArtifact(artifact))
      }),
    ),
  )

  app.delete(
    `${collectionPath}/:backupId`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        const backupId = yield* decodeIdentifier(context.req.param('backupId') ?? '', 'Backup id')
        if (actor.role !== 'administrator' && actor.role !== 'owner')
          return yield* new AuthorizationError({
            code: 'role_required',
            message: 'Administrator role is required to delete a backup',
          })
        const expectedRevision = yield* decodeExpectedRevision(context.req.header('if-match'))
        const control = yield* dependencies.control(context.env)
        const artifact = yield* control
          .delete(actor, backupId, expectedRevision)
          .pipe(Effect.mapError(mapError))
        return jsonResponse(publicArtifact(artifact))
      }),
    ),
  )
  return app
}

export { BackupArtifact }

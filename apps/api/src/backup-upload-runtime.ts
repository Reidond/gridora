import { Effect } from 'effect'
import {
  BackupR2Error,
  makeCloudflareBackupR2Bucket,
  makeManagedBackupUploadObjectPublisher,
  recoverManagedBackupUploadEffects,
  type BackupUploadObjectPublisher,
  type CloudflareR2BucketBindingShape,
  type ManagedBackupUploadEffectRepositoryShape,
} from '@gridora/backup-r2'
import {
  abortBackupUploadObjectEffect,
  closeBackupUploadSession,
  completeBackupUploadObjectEffect,
  listPreparedBackupUploadObjectEffects,
  loadBackupUploadObjectEffect,
  loadBackupUploadRecoverySession,
  registerBackupUploadObjectEffect,
  type BackupD1Database,
  type BackupUploadSessionAuthority,
} from '@gridora/backup-d1'

export interface BackupUploadRuntimeBindings {
  readonly DB: BackupD1Database
  readonly BACKUPS: CloudflareR2BucketBindingShape
}

const failure = (operation: string, code: BackupR2Error['code'] = 'publication-denied') =>
  new BackupR2Error({
    code,
    operation,
    message: 'the durable multipart publication evidence is unavailable',
  })

const managedUploadRepository = <R>(
  bindings: BackupUploadRuntimeBindings,
  authority: BackupUploadSessionAuthority,
  now: Effect.Effect<string, never, R>,
): ManagedBackupUploadEffectRepositoryShape<R> => {
  const exactEffect = (effectId: string, objectKey: string) =>
    loadBackupUploadObjectEffect(bindings.DB, authority, objectKey).pipe(
      Effect.flatMap((effect) =>
        effect !== null && effect.effectId === effectId
          ? Effect.succeed(effect)
          : Effect.fail(failure('backup.upload-effect.reload')),
      ),
      Effect.mapError(() => failure('backup.upload-effect.reload')),
    )
  return {
    load: (objectKey) =>
      loadBackupUploadObjectEffect(bindings.DB, authority, objectKey).pipe(
        Effect.mapError(() => failure('backup.upload-effect.load')),
      ),
    register: (publication) =>
      now.pipe(
        Effect.flatMap((createdAt) =>
          registerBackupUploadObjectEffect(bindings.DB, {
            ...authority,
            objectKey: publication.key,
            objectKind: publication.kind,
            chunkIndex: publication.index ?? -1,
            objectBytes: publication.objectBytes,
            objectSha256: publication.checksum,
            multipartUploadId: publication.multipartUploadId,
            now: createdAt,
          }),
        ),
        Effect.mapError(() => failure('backup.upload-effect.register')),
      ),
    complete: (effect, providerEtag) =>
      Effect.gen(function* () {
        const selected = yield* exactEffect(effect.effectId, effect.objectKey)
        const completedAt = yield* now
        return yield* completeBackupUploadObjectEffect(bindings.DB, {
          ...authority,
          effect: selected,
          providerEtag,
          now: completedAt,
        }).pipe(Effect.mapError(() => failure('backup.upload-effect.complete')))
      }),
    abort: (effect) =>
      Effect.gen(function* () {
        const selected = yield* exactEffect(effect.effectId, effect.objectKey)
        const abortedAt = yield* now
        return yield* abortBackupUploadObjectEffect(bindings.DB, {
          ...authority,
          effect: selected,
          now: abortedAt,
        }).pipe(Effect.mapError(() => failure('backup.upload-effect.abort')))
      }),
    listPrepared: listPreparedBackupUploadObjectEffects(bindings.DB, authority).pipe(
      Effect.mapError(() => failure('backup.upload-effect.list')),
    ),
  }
}

export const makeBackupUploadObjectPublisher = <R>(
  bindings: BackupUploadRuntimeBindings,
  authority: BackupUploadSessionAuthority,
  now: Effect.Effect<string, never, R>,
): BackupUploadObjectPublisher<R> =>
  makeManagedBackupUploadObjectPublisher(
    makeCloudflareBackupR2Bucket(bindings.BACKUPS),
    authority,
    managedUploadRepository(bindings, authority, now),
  )

export type BackupUploadCleanupRecovery =
  | { readonly state: 'not-required' }
  | {
      readonly state: 'reconciled'
      readonly sessionId: string
      readonly generation: number
      readonly completedEffects: number
      readonly abortedEffects: number
    }

/** Reconciles a lost upload only through provider terminal facts. For every
 * prepared effect, R2 must prove an exact visible object or acknowledge abort.
 * Only then may the durable writer tombstone close and physical prefix cleanup
 * proceed. Lease/watch timestamps are never used as quiescence evidence. */
export const recoverBackupUploadForCleanup = (
  bindings: BackupUploadRuntimeBindings,
  organizationId: string,
  backupId: string,
  now: string,
): Effect.Effect<BackupUploadCleanupRecovery, BackupR2Error> =>
  Effect.gen(function* () {
    const session = yield* loadBackupUploadRecoverySession(
      bindings.DB,
      organizationId,
      backupId,
    ).pipe(Effect.mapError(() => failure('backup.upload-recovery.load')))
    if (session === null || session.state === 'accepted' || session.state === 'reconciled')
      return { state: 'not-required' as const }
    const { state: _state, ...authority } = session
    const repository = managedUploadRepository(bindings, authority, Effect.succeed(now))
    const recovered = yield* recoverManagedBackupUploadEffects(
      makeCloudflareBackupR2Bucket(bindings.BACKUPS),
      authority,
      repository,
    )
    const stillPrepared = yield* repository.listPrepared
    if (stillPrepared.length !== 0)
      return yield* failure('backup.upload-recovery.prepared', 'upload-uncertain')
    yield* closeBackupUploadSession(bindings.DB, {
      ...authority,
      reason: 'authority-lost',
      now,
    }).pipe(Effect.mapError(() => failure('backup.upload-recovery.close')))
    return {
      state: 'reconciled' as const,
      sessionId: authority.sessionId,
      generation: authority.generation,
      completedEffects: recovered.completed,
      abortedEffects: recovered.aborted,
    }
  })

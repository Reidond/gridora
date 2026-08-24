import { Context, Effect, Layer, Schema } from 'effect'

export class BackupPlanError extends Schema.TaggedError<BackupPlanError>()('BackupPlanError', {
  code: Schema.Literals(['unsafe-path', 'checksum-required', 'server-mismatch', 'invalid-archive']),
  message: Schema.String,
}) {}

export interface BackupManifest {
  readonly apiVersion: 'backup.gridora.dev/v1alpha1'
  readonly backupId: string
  readonly organizationId: string
  readonly serverId: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly consistency: 'crash-consistent' | 'plugin-quiesced'
  readonly createdAt: string
  readonly sha256: string
  readonly files: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
  readonly diskBytes: number
}

export interface BackupPlan {
  readonly mode: 'create' | 'restore'
  readonly serverRoot: string
  readonly stagingDirectory: string
  readonly archivePath: string
  readonly includes: ReadonlyArray<string>
  readonly expectedSha256?: string
  readonly atomicTarget?: string
  readonly diskBytes: number
}
export interface BackupArchiveReceipt {
  readonly archivePath: string
  readonly bytes: number
  readonly sha256: string
}

export interface RestoreTarget {
  readonly organizationId: string
  readonly sourceServerId: string
  readonly targetServerId: string
}
export interface ArchiveEntry {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'hardlink' | 'device' | 'fifo'
}

export class BackupExecutionError extends Schema.TaggedError<BackupExecutionError>()(
  'BackupExecutionError',
  {
    code: Schema.Literals(['io-failed', 'checksum-mismatch', 'invalid-plan']),
    message: Schema.String,
  },
) {}

/** Archive implementation port. It receives validated plans, never arbitrary paths. */
export class BackupArchive extends Context.Service<
  BackupArchive,
  {
    readonly create: (plan: BackupPlan) => Effect.Effect<BackupArchiveReceipt, BackupExecutionError>
    readonly checksum: (plan: BackupPlan) => Effect.Effect<string, BackupExecutionError>
    readonly enumerate: (
      plan: BackupPlan,
    ) => Effect.Effect<ReadonlyArray<ArchiveEntry>, BackupExecutionError>
    readonly extractToStaging: (
      plan: BackupPlan,
      entries: ReadonlyArray<ArchiveEntry>,
    ) => Effect.Effect<void, BackupExecutionError>
    readonly commitRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    /** Restore the exact pre-cutover target. Safe before or after commit. */
    readonly rollbackRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    /** Remove rollback material only after the control plane is terminal-successful. */
    readonly finalizeRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    readonly release: (plan: BackupPlan) => Effect.Effect<void>
  }
>()('gridora/backup-runtime/BackupArchive') {}

export class BackupExecutor extends Context.Service<
  BackupExecutor,
  {
    readonly create: (plan: BackupPlan) => Effect.Effect<BackupArchiveReceipt, BackupExecutionError>
    readonly stageRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    readonly commitRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    readonly rollbackRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    readonly finalizeRestore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
    /** Compatibility composite for callers that own the whole local transaction. */
    readonly restore: (plan: BackupPlan) => Effect.Effect<void, BackupExecutionError>
  }
>()('gridora/backup-runtime/BackupExecutor') {}

const safeId = (value: string): boolean =>
  value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value)
const digest = /^sha256:[a-f0-9]{64}$/

export const createBackupPlan = (manifest: Omit<BackupManifest, 'sha256'>): BackupPlan => {
  if (![manifest.serverId, manifest.backupId].every(safeId))
    throw new BackupPlanError({
      code: 'unsafe-path',
      message: 'backup or server ID is not path-safe',
    })
  const root = `/var/lib/gridora/servers/${manifest.serverId}`
  const staging = `${root}/backups/${manifest.backupId}.partial`
  return {
    mode: 'create',
    serverRoot: root,
    stagingDirectory: staging,
    archivePath: `${root}/backups/${manifest.backupId}.tar.zst`,
    includes: manifest.files.map((directory) => `${root}/${directory}`),
    diskBytes: manifest.diskBytes,
  }
}

export const createRestorePlan = (manifest: BackupManifest, target: RestoreTarget): BackupPlan => {
  if (
    ![target.organizationId, target.sourceServerId, target.targetServerId, manifest.backupId].every(
      safeId,
    )
  )
    throw new BackupPlanError({
      code: 'unsafe-path',
      message: 'backup or target server ID is not path-safe',
    })
  if (
    target.organizationId !== manifest.organizationId ||
    target.sourceServerId !== manifest.serverId
  )
    throw new BackupPlanError({
      code: 'server-mismatch',
      message: 'backup manifest does not belong to the expected organization and source server',
    })
  if (!digest.test(manifest.sha256))
    throw new BackupPlanError({
      code: 'checksum-required',
      message: 'restore requires a SHA-256 checksum',
    })
  const targetRoot = `/var/lib/gridora/servers/${target.targetServerId}`
  return {
    mode: 'restore',
    serverRoot: targetRoot,
    stagingDirectory: `/var/lib/gridora/servers/.gridora-restore-${target.targetServerId}-${manifest.backupId}`,
    archivePath: `${targetRoot}/backups/${manifest.backupId}.tar.zst`,
    includes: manifest.files,
    expectedSha256: manifest.sha256,
    atomicTarget: targetRoot,
    diskBytes: manifest.diskBytes,
  }
}

/** Reject traversal and absolute paths before any archive is unpacked. */
export const validateArchiveEntries = (entries: ReadonlyArray<string>): void => {
  for (const entry of entries) {
    if (
      entry.startsWith('/') ||
      entry.includes('\0') ||
      entry.includes('\\') ||
      entry.split('/').some((part) => part === '..' || part === '.' || part === '')
    ) {
      throw new BackupPlanError({
        code: 'invalid-archive',
        message: `unsafe archive entry: ${entry}`,
      })
    }
  }
}

export const validateTypedArchiveEntries = (entries: ReadonlyArray<ArchiveEntry>): void => {
  validateArchiveEntries(entries.map((entry) => entry.path))
  for (const entry of entries) {
    if (entry.kind !== 'file' && entry.kind !== 'directory')
      throw new BackupPlanError({
        code: 'invalid-archive',
        message: `archive entry type is forbidden: ${entry.kind} ${entry.path}`,
      })
  }
}

export const BackupExecutorLive = Layer.effect(
  BackupExecutor,
  Effect.gen(function* () {
    const archive = yield* BackupArchive
    const requireRestore = (plan: BackupPlan) =>
      plan.mode === 'restore' &&
      plan.expectedSha256 !== undefined &&
      plan.atomicTarget !== undefined
        ? Effect.void
        : Effect.fail(
            new BackupExecutionError({
              code: 'invalid-plan',
              message: 'restore requires checksum and atomic target',
            }),
          )
    const stageRestore = (plan: BackupPlan) =>
      Effect.gen(function* () {
        yield* requireRestore(plan)
        const observed = yield* archive.checksum(plan)
        if (observed !== plan.expectedSha256)
          return yield* Effect.fail(
            new BackupExecutionError({
              code: 'checksum-mismatch',
              message: 'backup checksum does not match the signed manifest',
            }),
          )
        const entries = yield* archive.enumerate(plan)
        yield* Effect.try({
          try: () => validateTypedArchiveEntries(entries),
          catch: (cause) =>
            new BackupExecutionError({ code: 'invalid-plan', message: String(cause) }),
        })
        yield* archive.extractToStaging(plan, entries)
      }).pipe(Effect.ensuring(archive.release(plan)))
    return {
      create: (plan: BackupPlan) =>
        plan.mode !== 'create'
          ? Effect.fail(
              new BackupExecutionError({
                code: 'invalid-plan',
                message: 'create requires a validated create plan',
              }),
            )
          : archive.create(plan),
      stageRestore,
      commitRestore: (plan: BackupPlan) =>
        requireRestore(plan).pipe(Effect.andThen(archive.commitRestore(plan))),
      rollbackRestore: (plan: BackupPlan) =>
        requireRestore(plan).pipe(Effect.andThen(archive.rollbackRestore(plan))),
      finalizeRestore: (plan: BackupPlan) =>
        requireRestore(plan).pipe(Effect.andThen(archive.finalizeRestore(plan))),
      restore: (plan: BackupPlan) =>
        Effect.gen(function* () {
          yield* stageRestore(plan)
          yield* archive.commitRestore(plan)
          yield* archive.finalizeRestore(plan)
        }),
    }
  }),
)

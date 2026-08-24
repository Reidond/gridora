import {
  cp,
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises'
import { join } from 'node:path'
import { findPluginRuntime, pluginRegistry } from '@gridora/plugin-registry'
import {
  assertExecutableAllowed,
  type AgentFacet,
  type ExecutablePlan,
  type FileRender,
} from '@gridora/plugin-sdk-agent'
import type {
  ConfigApplyPayload,
  DeploymentSpec,
  ModSyncPayload,
  ServerUpdatePayload,
} from '@gridora/agent-protocol'
import { IsolatedJobEngine, NodeIsolatedJobEngine } from '@gridora/docker-runtime'
import { Effect } from 'effect'
import { AgentError } from './errors.js'
import { NodePluginEgressLeaseManager, type PluginEgressLeaseManager } from './plugin-egress.js'
import type { ExecutionResult } from './services.js'

export interface GameProcessInput {
  readonly serverId: string
  readonly operationId: string
  readonly image: string
  readonly restoreValidationBackupId?: string
  readonly writableStagingRelative?: string
  readonly networkDestinations?: readonly string[]
}

export interface GameProcessRunner {
  readonly run: (
    plan: ExecutablePlan,
    input: GameProcessInput,
  ) => Effect.Effect<{ readonly output: string }, AgentError>
}

export interface GameFileWriter {
  readonly activeRevision: (serverId: string) => Effect.Effect<number | null, AgentError>
  readonly prepare: (
    serverId: string,
    revision: number,
    files: readonly FileRender[],
  ) => Effect.Effect<
    {
      readonly root: string
      readonly promote: Effect.Effect<'promoted' | 'adopted', AgentError>
      readonly discard: Effect.Effect<void, never>
    },
    AgentError
  >
  readonly stage: (
    serverId: string,
    revision: number,
    files: readonly FileRender[],
  ) => Effect.Effect<void, AgentError>
}

export interface GameModWriter {
  readonly activeRevision: (serverId: string) => Effect.Effect<number | null, AgentError>
  readonly prepare: (
    serverId: string,
    revision: number,
  ) => Effect.Effect<
    {
      readonly root: string
      readonly writableStagingRelative: string
      readonly promote: Effect.Effect<'promoted' | 'adopted', AgentError>
      readonly discard: Effect.Effect<void, never>
    },
    AgentError
  >
}

export interface GameRuntime {
  readonly install: (spec: DeploymentSpec) => Effect.Effect<ExecutionResult, AgentError>
  readonly validateRestore: (
    serverId: string,
    pluginId: string,
    pluginVersion: string,
    operationId: string,
    backupId: string,
    restoreRoot?: string,
  ) => Effect.Effect<void, AgentError>
  readonly applyConfig: (
    serverId: string,
    payload: ConfigApplyPayload,
  ) => Effect.Effect<ExecutionResult, AgentError>
  readonly syncMods: (
    serverId: string,
    payload: ModSyncPayload,
  ) => Effect.Effect<ExecutionResult, AgentError>
  readonly update: (
    serverId: string,
    payload: ServerUpdatePayload,
  ) => Effect.Effect<ExecutionResult, AgentError>
  readonly inspectHealth: (
    serverId: string,
    pluginId: string,
    pluginVersion: string,
    operationId: string,
  ) => Effect.Effect<ReturnType<AgentFacet['parseHealth']>, AgentError>
}

const failure = (message: string) => new AgentError({ code: 'execution-failed', message })
const safeSegment = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..'
const safeRelative = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\0') &&
  value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

type SecureDirectory = {
  readonly handle: FileHandle
  readonly path: string
}

/**
 * The agent and the isolated plugin job share the same server lock.  A job is
 * never allowed to run while the agent is cutting over configuration, and a
 * second config writer cannot observe a half-written staging tree.  The lock
 * is deliberately process-local: the node has one long-running agent and the
 * Docker helper is only reached through this process.
 */
const serverLocks = new Map<string, Promise<void>>()

const withServerLock = async <T>(serverId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = serverLocks.get(serverId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(
    () => current,
    () => current,
  )
  serverLocks.set(serverId, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (serverLocks.get(serverId) === queued) serverLocks.delete(serverId)
  }
}

const procFdPath = (directory: SecureDirectory, child: string): string =>
  process.platform === 'linux'
    ? join('/proc/self/fd', String(directory.handle.fd), child)
    : join(directory.path, child)

const openDirectory = async (path: string): Promise<SecureDirectory> => {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  const metadata = await handle.stat()
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    await handle.close()
    throw new Error('plugin path is not a real directory')
  }
  return { handle, path }
}

/**
 * Open every component from a stable directory descriptor. On Linux the
 * /proc/self/fd path keeps the already-open parent descriptor authoritative,
 * while O_NOFOLLOW rejects a swapped final component. On development hosts
 * without procfs, the same ownership/mount invariant is enforced by the node
 * image: plugin jobs receive staging/config read-only; tests still exercise
 * the no-symlink checks and atomic rename contract.
 */
const ensureDirectoryAt = async (
  parent: SecureDirectory,
  relativePath: string,
  mode: number,
): Promise<SecureDirectory> => {
  if (!safeRelative(relativePath)) throw new Error('plugin directory path is unsafe')
  let current = parent
  for (const segment of relativePath.split('/')) {
    const path = procFdPath(current, segment)
    await mkdir(path, { mode }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    })
    const next = await openDirectory(path)
    // chmod through the descriptor avoids a second path lookup and keeps the
    // group read/write contract intact despite the service umask.
    await next.handle.chmod(mode)
    if (current !== parent) await current.handle.close()
    current = next
  }
  return current
}

const closeDirectory = async (directory: SecureDirectory | undefined): Promise<void> => {
  if (directory === undefined) return
  await directory.handle.close().catch(() => undefined)
}

const ensureServerRoot = async (path: string): Promise<SecureDirectory> => {
  const rootStat = await lstat(path)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o022) !== 0)
    throw new Error('server root is not a real non-replaceable directory')
  return openDirectory(path)
}

const hostRoot = (serverId: string): string => `/var/lib/gridora/servers/${serverId}`
const revisionFile = 'active-config-revision'
const modRevisionFile = 'active-mod-revision'
const steamDestinations = (destinations: readonly string[]) =>
  destinations.filter((destination) => /(?:steam|valve)/i.test(destination))

const containerPath = (serverId: string, value: string): string => {
  const root = hostRoot(serverId)
  if (value === root) return '/work'
  if (!value.startsWith(`${root}/`)) throw new Error('plugin plan path is outside the server root')
  const relative = value.slice(root.length + 1)
  if (!safeRelative(relative)) throw new Error('plugin plan path is unsafe')
  return `/work/${relative}`
}

const isolatedPlan = (
  input: GameProcessInput,
  plan: ExecutablePlan,
): Omit<ExecutablePlan, 'workingDirectory'> & { readonly workingDirectory: string } => {
  const restoreHostRoot =
    input.restoreValidationBackupId === undefined
      ? undefined
      : `/var/lib/gridora/servers/.gridora-restore-${input.serverId}-${input.restoreValidationBackupId}`
  const restoreContainerRoot = `/work/staging/restore-${input.operationId}`
  const translate = (value: string): string => {
    if (
      restoreHostRoot !== undefined &&
      (value === restoreHostRoot || value.startsWith(`${restoreHostRoot}/`))
    ) {
      const relative = value === restoreHostRoot ? '' : value.slice(restoreHostRoot.length + 1)
      if (relative !== '' && !safeRelative(relative))
        throw new Error('restore validation path is unsafe')
      return relative === '' ? restoreContainerRoot : `${restoreContainerRoot}/${relative}`
    }
    return value.startsWith(`${hostRoot(input.serverId)}/`) || value === hostRoot(input.serverId)
      ? containerPath(input.serverId, value)
      : value
  }
  return {
    ...plan,
    arguments: plan.arguments.map(translate),
    workingDirectory: translate(plan.workingDirectory),
    environment: Object.fromEntries(
      Object.entries(plan.environment).map(([key, value]) => [key, translate(value)]),
    ),
  }
}

/**
 * Plugin plans are still generated by the signed build registry, but the
 * process itself runs in a short-lived, digest-pinned container.  The agent
 * process never execs a plugin binary and the child has no Docker socket,
 * provider credentials, host namespace, or host filesystem path.
 */
export const NodeGameProcessRunner = (
  socketPath: '/var/run/docker.sock' | '/run/docker.sock' = '/var/run/docker.sock',
  egressLeaseManager: PluginEgressLeaseManager = NodePluginEgressLeaseManager(),
): GameProcessRunner => ({
  run: (plan, input) =>
    Effect.tryPromise({
      try: () =>
        withServerLock(input.serverId, async () => {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              let translated: ReturnType<typeof isolatedPlan>
              try {
                translated = isolatedPlan(input, plan)
              } catch (cause) {
                return yield* failure(
                  `plugin execution plan is unsafe: ${cause instanceof Error ? cause.message : String(cause)}`,
                )
              }
              const engine = yield* IsolatedJobEngine
              const lease = yield* egressLeaseManager.acquire(
                input.operationId,
                input.networkDestinations ?? [],
              )
              return yield* engine
                .run({
                  jobId: input.operationId,
                  serverId: input.serverId,
                  image: input.image,
                  executable: translated.executable,
                  arguments: translated.arguments,
                  workingDirectory: translated.workingDirectory,
                  environment: translated.environment,
                  timeoutSeconds: Math.min(3600, Math.max(1, Math.ceil(translated.timeoutSeconds))),
                  ...(input.restoreValidationBackupId === undefined
                    ? {}
                    : { restoreValidationBackupId: input.restoreValidationBackupId }),
                  ...(input.writableStagingRelative === undefined
                    ? {}
                    : { writableStagingRelative: input.writableStagingRelative }),
                })
                .pipe(
                  Effect.mapError((error) => failure(error.message)),
                  Effect.map(({ output }) => ({ output })),
                  Effect.ensuring(lease.release),
                )
            }).pipe(Effect.provide(NodeIsolatedJobEngine(socketPath))),
          )
          return result
        }),
      catch: (cause) =>
        cause instanceof AgentError
          ? cause
          : failure(`isolated plugin execution failed: ${String(cause)}`),
    }),
})

const readActiveConfigRevision = async (serverRoot: string): Promise<number | null> => {
  try {
    const value = (await readFile(join(serverRoot, 'state', revisionFile), 'utf8')).trim()
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error('active config revision marker is corrupt')
    return Number(value)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

const prepareConfig = (
  root: string,
  serverId: string,
  revision: number,
  files: readonly FileRender[],
): Effect.Effect<string, AgentError> =>
  Effect.tryPromise({
    try: () =>
      withServerLock(serverId, async () => {
        if (
          !safeSegment(serverId) ||
          !Number.isSafeInteger(revision) ||
          revision < 1 ||
          new Set(files.map((file) => file.relativePath)).size !== files.length
        )
          throw new Error('game staging identity is invalid')
        const serverRoot = join(root, serverId)
        const rootDirectory = await ensureServerRoot(serverRoot)
        let stagingDirectory: SecureDirectory | undefined
        let stagingRoot: SecureDirectory | undefined
        try {
          const activeRevision = await readActiveConfigRevision(serverRoot)
          if (activeRevision !== null && activeRevision >= revision)
            return join(serverRoot, 'staging', `config-${revision}`)
          stagingDirectory = await ensureDirectoryAt(rootDirectory, 'staging', 0o2770)
          const stagingPath = procFdPath(stagingDirectory, `config-${revision}`)
          const existingStaging = await lstat(stagingPath).catch((cause: unknown) => {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw cause
          })
          if (
            existingStaging !== undefined &&
            (existingStaging.isSymbolicLink() || !existingStaging.isDirectory())
          )
            throw new Error('plugin staging path is not a real directory')
          await rm(stagingPath, { recursive: true, force: true })
          stagingRoot = await ensureDirectoryAt(stagingDirectory, `config-${revision}`, 0o2770)
          for (const file of files) {
            if (!safeRelative(file.relativePath) || file.relativePath.includes('..'))
              throw new Error('plugin rendered an unsafe relative path')
            const fileParent = file.relativePath.includes('/')
              ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/'))
              : ''
            const destinationDirectory: SecureDirectory =
              fileParent.length > 0
                ? await ensureDirectoryAt(stagingRoot, fileParent, 0o2770)
                : stagingRoot
            const targetName = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1)
            const temporaryName = `${targetName}.tmp-${process.pid}`
            const handle = await open(
              procFdPath(destinationDirectory, temporaryName),
              fsConstants.O_WRONLY |
                fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_NOFOLLOW,
              file.mode & 0o777,
            )
            try {
              await handle.writeFile(file.content, 'utf8')
              await handle.sync()
              await handle.chmod(file.mode & 0o777)
            } finally {
              await handle.close()
            }
            await rename(
              procFdPath(destinationDirectory, temporaryName),
              procFdPath(destinationDirectory, targetName),
            )
            if (destinationDirectory !== stagingRoot) await closeDirectory(destinationDirectory)
          }
          return join(serverRoot, 'staging', `config-${revision}`)
        } finally {
          await closeDirectory(stagingRoot)
          await closeDirectory(stagingDirectory)
          await closeDirectory(rootDirectory)
        }
      }),
    catch: (cause) =>
      failure(`config staging failed: ${cause instanceof Error ? cause.message : String(cause)}`),
  })

const promoteConfig = (
  root: string,
  serverId: string,
  revision: number,
  files: readonly FileRender[],
): Effect.Effect<'promoted' | 'adopted', AgentError> =>
  Effect.tryPromise({
    try: () =>
      withServerLock(serverId, async () => {
        const serverRoot = join(root, serverId)
        const currentRevision = await readActiveConfigRevision(serverRoot)
        const stagingPath = join(serverRoot, 'staging', `config-${revision}`)
        if (currentRevision === revision) {
          await rm(stagingPath, { recursive: true, force: true })
          return 'adopted' as const
        }
        if (currentRevision !== null && currentRevision > revision)
          throw new Error('config revision is stale')
        const rootDirectory = await ensureServerRoot(serverRoot)
        let stagingDirectory: SecureDirectory | undefined
        let stagingRoot: SecureDirectory | undefined
        let activeRoot: SecureDirectory | undefined
        let knownGoodRoot: SecureDirectory | undefined
        let stateRoot: SecureDirectory | undefined
        const processed: Array<{ readonly path: string; readonly hadPrior: boolean }> = []
        try {
          stagingDirectory = await ensureDirectoryAt(rootDirectory, 'staging', 0o2770)
          const stagingMetadata = await lstat(procFdPath(stagingDirectory, `config-${revision}`))
          if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink())
            throw new Error('prepared config root is not a real directory')
          stagingRoot = await openDirectory(procFdPath(stagingDirectory, `config-${revision}`))
          const knownGoodName = `config-known-good-${Math.max(0, revision - 1)}`
          const knownGoodPath = procFdPath(stagingDirectory, knownGoodName)
          const existingKnownGood = await lstat(knownGoodPath).catch((cause: unknown) => {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw cause
          })
          if (existingKnownGood?.isSymbolicLink())
            throw new Error('known-good config root is a symlink')
          await rm(knownGoodPath, { recursive: true, force: true })
          knownGoodRoot = await ensureDirectoryAt(stagingDirectory, knownGoodName, 0o2770)
          activeRoot = await ensureDirectoryAt(rootDirectory, 'config', 0o2770)
          for (const file of files) {
            const parent = file.relativePath.includes('/')
              ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/'))
              : ''
            const activeParent: SecureDirectory =
              parent === '' ? activeRoot : await ensureDirectoryAt(activeRoot, parent, 0o2770)
            const knownGoodParent: SecureDirectory =
              parent === '' ? knownGoodRoot : await ensureDirectoryAt(knownGoodRoot, parent, 0o2770)
            const name = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1)
            const activePath = procFdPath(activeParent, name)
            const prior = await lstat(activePath).catch((cause: unknown) => {
              if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
              throw cause
            })
            if (prior !== undefined && (!prior.isFile() || prior.isSymbolicLink()))
              throw new Error('active config contains an unsafe entry')
            if (prior !== undefined) await rename(activePath, procFdPath(knownGoodParent, name))
            try {
              await rename(procFdPath(stagingRoot, file.relativePath), activePath)
              processed.push({ path: file.relativePath, hadPrior: prior !== undefined })
            } catch (cause) {
              if (prior !== undefined)
                await rename(procFdPath(knownGoodParent, name), activePath).catch(() => undefined)
              throw cause
            } finally {
              if (activeParent !== activeRoot) await closeDirectory(activeParent)
              if (knownGoodParent !== knownGoodRoot) await closeDirectory(knownGoodParent)
            }
          }
          stateRoot = await ensureDirectoryAt(rootDirectory, 'state', 0o2770)
          const temporaryMarker = `${revisionFile}.tmp-${process.pid}`
          await rm(procFdPath(stateRoot, temporaryMarker), { force: true })
          const marker = await open(
            procFdPath(stateRoot, temporaryMarker),
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW,
            0o640,
          )
          try {
            await marker.writeFile(`${revision}\n`, 'utf8')
            await marker.sync()
          } finally {
            await marker.close()
          }
          await rename(procFdPath(stateRoot, temporaryMarker), procFdPath(stateRoot, revisionFile))
          await rm(procFdPath(stagingDirectory, `config-${revision}`), {
            recursive: true,
            force: true,
          })
          if (revision > 2)
            await rm(procFdPath(stagingDirectory, `config-known-good-${revision - 2}`), {
              recursive: true,
              force: true,
            })
          return 'promoted' as const
        } catch (cause) {
          for (const entry of [...processed].reverse()) {
            const parent = entry.path.includes('/')
              ? entry.path.slice(0, entry.path.lastIndexOf('/'))
              : ''
            const activeParent =
              parent === '' ? activeRoot : await ensureDirectoryAt(activeRoot!, parent, 0o2770)
            const knownGoodParent =
              parent === ''
                ? knownGoodRoot
                : await ensureDirectoryAt(knownGoodRoot!, parent, 0o2770)
            const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
            await rm(procFdPath(activeParent!, name), { force: true })
            if (entry.hadPrior)
              await rename(
                procFdPath(knownGoodParent!, name),
                procFdPath(activeParent!, name),
              ).catch(() => undefined)
            if (activeParent !== activeRoot) await closeDirectory(activeParent)
            if (knownGoodParent !== knownGoodRoot) await closeDirectory(knownGoodParent)
          }
          throw cause
        } finally {
          await closeDirectory(stateRoot)
          await closeDirectory(knownGoodRoot)
          await closeDirectory(activeRoot)
          await closeDirectory(stagingRoot)
          await closeDirectory(stagingDirectory)
          await closeDirectory(rootDirectory)
        }
      }),
    catch: (cause) =>
      failure(`config promotion failed: ${cause instanceof Error ? cause.message : String(cause)}`),
  })

export const NodeGameFileWriter = (
  root = '/var/lib/gridora/servers',
  planRoot = root,
): GameFileWriter => {
  const writer: GameFileWriter = {
    activeRevision: (serverId) =>
      Effect.tryPromise({
        try: async () => {
          if (!safeSegment(serverId)) throw new Error('game server identity is invalid')
          const serverRoot = join(root, serverId)
          const directory = await ensureServerRoot(serverRoot)
          try {
            return await readActiveConfigRevision(serverRoot)
          } finally {
            await directory.handle.close()
          }
        },
        catch: (cause) =>
          failure(
            `config revision read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      }),
    prepare: (serverId, revision, files) =>
      prepareConfig(root, serverId, revision, files).pipe(
        Effect.map(() => ({
          root: join(planRoot, serverId, 'staging', `config-${revision}`),
          promote: promoteConfig(root, serverId, revision, files),
          discard: Effect.promise(() =>
            withServerLock(serverId, () =>
              rm(join(root, serverId, 'staging', `config-${revision}`), {
                recursive: true,
                force: true,
              }),
            ),
          ).pipe(Effect.ignore),
        })),
      ),
    stage: (serverId, revision, files) =>
      prepareConfig(root, serverId, revision, files).pipe(
        Effect.andThen(promoteConfig(root, serverId, revision, files)),
        Effect.asVoid,
      ),
  }
  return writer
}

const readActiveModRevision = async (serverRoot: string): Promise<number | null> => {
  try {
    const value = (await readFile(join(serverRoot, 'state', modRevisionFile), 'utf8')).trim()
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error('active mod revision marker is corrupt')
    return Number(value)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

const assertSafeTree = async (root: string): Promise<void> => {
  let entries = 0
  const visit = async (directory: string): Promise<void> => {
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('mod staging tree is not a real directory')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      if (
        entries > 50_000 ||
        entry.name === '.' ||
        entry.name === '..' ||
        entry.name.includes('\0')
      )
        throw new Error('mod staging tree is too large or unsafe')
      const path = join(directory, entry.name)
      const child = await lstat(path)
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory()))
        throw new Error('mod staging tree contains an unsupported entry')
      if (child.isDirectory()) await visit(path)
    }
  }
  await visit(root)
}

const clearDirectory = async (root: string): Promise<void> => {
  for (const entry of await readdir(root))
    await rm(join(root, entry), { recursive: true, force: true })
}

const copyDirectoryContents = async (source: string, target: string): Promise<void> => {
  await assertSafeTree(source)
  for (const entry of await readdir(source))
    await cp(join(source, entry), join(target, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    })
}

const writeRevisionMarker = async (
  rootDirectory: SecureDirectory,
  name: string,
  revision: number,
): Promise<void> => {
  const stateRoot = await ensureDirectoryAt(rootDirectory, 'state', 0o2770)
  const temporary = `${name}.tmp-${process.pid}`
  try {
    await rm(procFdPath(stateRoot, temporary), { force: true })
    const marker = await open(
      procFdPath(stateRoot, temporary),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o640,
    )
    try {
      await marker.writeFile(`${revision}\n`, 'utf8')
      await marker.sync()
    } finally {
      await marker.close()
    }
    await rename(procFdPath(stateRoot, temporary), procFdPath(stateRoot, name))
  } finally {
    await closeDirectory(stateRoot)
  }
}

export const NodeGameModWriter = (
  root = '/var/lib/gridora/servers',
  planRoot = root,
): GameModWriter => ({
  activeRevision: (serverId) =>
    Effect.tryPromise({
      try: async () => {
        if (!safeSegment(serverId)) throw new Error('game server identity is invalid')
        const serverRoot = join(root, serverId)
        const directory = await ensureServerRoot(serverRoot)
        try {
          return await readActiveModRevision(serverRoot)
        } finally {
          await closeDirectory(directory)
        }
      },
      catch: (cause) =>
        failure(
          `mod revision read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    }),
  prepare: (serverId, revision) =>
    Effect.tryPromise({
      try: () =>
        withServerLock(serverId, async () => {
          if (!safeSegment(serverId) || !Number.isSafeInteger(revision) || revision < 1)
            throw new Error('mod staging identity is invalid')
          const serverRoot = join(root, serverId)
          const rootDirectory = await ensureServerRoot(serverRoot)
          let staging: SecureDirectory | undefined
          let prepared: SecureDirectory | undefined
          try {
            const current = await readActiveModRevision(serverRoot)
            const relative = `mods-${revision}`
            if (current === revision)
              return {
                root: join(planRoot, serverId, 'staging', relative),
                writableStagingRelative: relative,
              }
            if (current !== null && current > revision) throw new Error('mod revision is stale')
            staging = await ensureDirectoryAt(rootDirectory, 'staging', 0o2770)
            const path = procFdPath(staging, relative)
            const existing = await lstat(path).catch((cause: unknown) => {
              if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
              throw cause
            })
            if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isDirectory()))
              throw new Error('mod staging root is unsafe')
            await rm(path, { recursive: true, force: true })
            prepared = await ensureDirectoryAt(staging, relative, 0o2770)
            return {
              root: join(planRoot, serverId, 'staging', relative),
              writableStagingRelative: relative,
            }
          } finally {
            await closeDirectory(prepared)
            await closeDirectory(staging)
            await closeDirectory(rootDirectory)
          }
        }),
      catch: (cause) =>
        failure(`mod staging failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    }).pipe(
      Effect.map(({ root: stagedRoot, writableStagingRelative }) => ({
        root: stagedRoot,
        writableStagingRelative,
        promote: Effect.tryPromise({
          try: () =>
            withServerLock(serverId, async () => {
              const serverRoot = join(root, serverId)
              const current = await readActiveModRevision(serverRoot)
              const stagedPath = join(serverRoot, 'staging', `mods-${revision}`)
              if (current === revision) {
                await rm(stagedPath, { recursive: true, force: true })
                return 'adopted' as const
              }
              if (current !== null && current > revision) throw new Error('mod revision is stale')
              const rootDirectory = await ensureServerRoot(serverRoot)
              const activePath = join(serverRoot, 'mods')
              const knownGoodPath = join(
                serverRoot,
                'staging',
                `mods-known-good-${Math.max(0, revision - 1)}`,
              )
              try {
                await assertSafeTree(stagedPath)
                await assertSafeTree(activePath)
                const knownGoodMetadata = await lstat(knownGoodPath).catch((cause: unknown) => {
                  if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
                  throw cause
                })
                if (knownGoodMetadata?.isSymbolicLink())
                  throw new Error('known-good mod root is a symlink')
                await rm(knownGoodPath, { recursive: true, force: true })
                await mkdir(knownGoodPath, { mode: 0o2770 })
                await copyDirectoryContents(activePath, knownGoodPath)
                try {
                  await clearDirectory(activePath)
                  await copyDirectoryContents(stagedPath, activePath)
                  await writeRevisionMarker(rootDirectory, modRevisionFile, revision)
                } catch (cause) {
                  await clearDirectory(activePath)
                  await copyDirectoryContents(knownGoodPath, activePath)
                  throw cause
                }
                await rm(stagedPath, { recursive: true, force: true })
                if (revision > 2)
                  await rm(join(serverRoot, 'staging', `mods-known-good-${revision - 2}`), {
                    recursive: true,
                    force: true,
                  })
                return 'promoted' as const
              } finally {
                await closeDirectory(rootDirectory)
              }
            }),
          catch: (cause) =>
            failure(
              `mod promotion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
        }),
        discard: Effect.promise(() =>
          withServerLock(serverId, () =>
            rm(join(root, serverId, 'staging', `mods-${revision}`), {
              recursive: true,
              force: true,
            }),
          ),
        ).pipe(Effect.ignore),
      })),
    ),
})

const assertPlan = (
  pluginId: string,
  plan: ExecutablePlan,
): Effect.Effect<ExecutablePlan, AgentError> => {
  const bundle = pluginRegistry.get(pluginId)
  if (bundle === undefined)
    return Effect.fail(failure(`plugin ${pluginId} is not in the signed build registry`))
  return assertExecutableAllowed(bundle.permissions, plan).pipe(
    Effect.mapError((error) => failure(error.message)),
  )
}

export const makeGameRuntime = (
  processRunner: GameProcessRunner,
  fileWriter: GameFileWriter,
  modWriter: GameModWriter,
): GameRuntime => ({
  install: (spec) =>
    Effect.gen(function* () {
      const pluginKey = `${spec.plugin.id}@${spec.plugin.version}`
      const bundle = pluginRegistry.get(pluginKey)
      if (bundle === undefined)
        return yield* failure('plugin version is not in the signed build registry')
      if (
        spec.serverId.length === 0 ||
        !safeSegment(spec.serverId) ||
        !safeSegment(spec.operationId) ||
        !/^sha256:[a-f0-9]{64}$/.test(spec.image.installer)
      )
        return yield* failure('signed installation identity is unsafe')
      const root = hostRoot(spec.serverId)
      const plan = yield* (bundle.agent as AgentFacet<Readonly<Record<string, unknown>>>)
        .installPlan(root)
        .pipe(Effect.mapError((error) => failure(error.message)))
      yield* assertPlan(pluginKey, plan)
      const result = yield* processRunner.run(plan, {
        serverId: spec.serverId,
        operationId: spec.operationId,
        image: spec.image.installer,
        networkDestinations: steamDestinations(bundle.permissions.networkDestinations),
      })
      const build = /(?:build(?:id)?|buildid)\s*[=: ]\s*([0-9]{1,20})/i.exec(result.output)?.[1]
      return {
        revision: spec.revision,
        code: build === undefined ? 'plugin-installed' : `plugin-installed-build-${build}`,
        message:
          build === undefined
            ? 'reviewed plugin installation completed; runtime activation remains observation-gated'
            : `reviewed plugin installation completed at build ${build}; runtime activation remains observation-gated`,
      }
    }),
  validateRestore: (serverId, pluginId, pluginVersion, operationId, backupId, restoreRoot) =>
    Effect.gen(function* () {
      const runtime = findPluginRuntime(pluginId, pluginVersion)
      if (runtime === undefined)
        return yield* failure('plugin runtime is not in the signed build registry')
      const bundle = pluginRegistry.get(`${pluginId}@${pluginVersion}`)
      if (bundle === undefined)
        return yield* failure('plugin version is not in the signed build registry')
      if (!/^sha256:[a-f0-9]{64}$/.test(bundle.manifest.restoreValidationImageDigest))
        return yield* failure('plugin restore validation image is not digest pinned')
      if (![serverId, operationId, backupId].every(safeSegment))
        return yield* failure('restore validation identity is unsafe')
      const expectedRestoreRoot = `/var/lib/gridora/servers/.gridora-restore-${serverId}-${backupId}`
      if (restoreRoot !== undefined && restoreRoot !== expectedRestoreRoot)
        return yield* failure('restore validation root does not match the signed operation')
      const plan = yield* runtime
        .restoreValidationPlan(expectedRestoreRoot)
        .pipe(Effect.mapError((error) => failure(error.message)))
      yield* assertPlan(`${pluginId}@${pluginVersion}`, plan)
      yield* processRunner.run(plan, {
        serverId,
        operationId,
        image: bundle.manifest.restoreValidationImageDigest,
        restoreValidationBackupId: backupId,
      })
    }),
  applyConfig: (serverId, payload) =>
    Effect.gen(function* () {
      const pluginKey = `${payload.pluginId}@${payload.pluginVersion}`
      const bundle = pluginRegistry.get(pluginKey)
      if (bundle === undefined)
        return yield* failure('plugin version is not in the signed build registry')
      const runtime = findPluginRuntime(payload.pluginId, payload.pluginVersion)
      if (runtime === undefined)
        return yield* failure('plugin runtime is not in the signed build registry')
      const activeRevision = yield* fileWriter.activeRevision(serverId)
      if (activeRevision === payload.configRevision)
        return {
          revision: payload.configRevision,
          code: 'config-activation-adopted',
          message: 'the exact validated config revision was already active after response loss',
        }
      if (activeRevision !== null && activeRevision > payload.configRevision)
        return yield* failure('config revision is stale')
      const agent = bundle.agent as AgentFacet<Readonly<Record<string, unknown>>>
      const files = yield* agent
        .renderConfig(payload.config)
        .pipe(Effect.mapError((error) => failure(error.message)))
      const prepared = yield* fileWriter.prepare(serverId, payload.configRevision, files)
      const plans = yield* runtime
        .activationPlan(hostRoot(serverId), prepared.root)
        .pipe(Effect.mapError((error) => failure(error.message)))
      const validationPlan = plans[0]
      if (validationPlan === undefined)
        return yield* failure('plugin does not declare staged configuration validation')
      yield* assertPlan(pluginKey, validationPlan)
      yield* processRunner
        .run(validationPlan, {
          serverId,
          operationId: payload.operationId,
          image: bundle.manifest.restoreValidationImageDigest,
        })
        .pipe(Effect.tapError(() => prepared.discard))
      const disposition = yield* prepared.promote
      return {
        revision: payload.configRevision,
        code: disposition === 'adopted' ? 'config-activation-adopted' : 'config-activated',
        message:
          'plugin configuration was validated before atomic promotion; the previous known-good revision is retained',
      }
    }),
  syncMods: (serverId, payload) =>
    Effect.gen(function* () {
      const pluginKey = `${payload.pluginId}@${payload.pluginVersion}`
      const bundle = pluginRegistry.get(pluginKey)
      if (bundle === undefined)
        return yield* failure('plugin version is not in the signed build registry')
      const runtime = findPluginRuntime(payload.pluginId, payload.pluginVersion)
      if (runtime?.modValidationPlan === undefined)
        return yield* failure('plugin does not declare staged mod validation capability')
      const activeRevision = yield* modWriter.activeRevision(serverId)
      if (activeRevision === payload.modRevision)
        return {
          revision: payload.modRevision,
          code: 'mod-activation-adopted',
          message: 'the exact validated mod revision was already active after response loss',
        }
      if (activeRevision !== null && activeRevision > payload.modRevision)
        return yield* failure('mod revision is stale')
      const agent = bundle.agent as AgentFacet<Readonly<Record<string, unknown>>>
      if (agent.modInstallPlan === undefined)
        return yield* failure('plugin does not declare mod installation capability')
      const root = hostRoot(serverId)
      const prepared = yield* modWriter.prepare(serverId, payload.modRevision)
      const plans = yield* agent
        .modInstallPlan(
          prepared.root,
          payload.mods.map((mod) => ({
            id: mod.id,
            ...(mod.requestedVersion === undefined ? {} : { version: mod.requestedVersion }),
          })),
        )
        .pipe(Effect.mapError((error) => failure(error.message)))
      yield* Effect.gen(function* () {
        for (const plan of plans) {
          yield* assertPlan(pluginKey, plan)
          yield* processRunner.run(plan, {
            serverId,
            operationId: payload.operationId,
            image: payload.image,
            writableStagingRelative: prepared.writableStagingRelative,
            networkDestinations: bundle.permissions.networkDestinations,
          })
        }
        const validation = yield* runtime.modValidationPlan!(root, prepared.root).pipe(
          Effect.mapError((error) => failure(error.message)),
        )
        yield* assertPlan(pluginKey, validation)
        yield* processRunner.run(validation, {
          serverId,
          operationId: payload.operationId,
          image: bundle.manifest.restoreValidationImageDigest,
        })
      }).pipe(Effect.tapError(() => prepared.discard))
      const disposition = yield* prepared.promote
      return {
        revision: payload.modRevision,
        code: disposition === 'adopted' ? 'mod-activation-adopted' : 'mods-activated',
        message:
          'plugin mods were installed into staging, validated, and promoted with the previous known-good set retained',
      }
    }),
  update: (serverId, payload) =>
    Effect.gen(function* () {
      const bundle = pluginRegistry.get(`${payload.pluginId}@${payload.pluginVersion}`)
      if (bundle === undefined)
        return yield* failure('plugin version is not in the signed build registry')
      const root = `/var/lib/gridora/servers/${serverId}`
      const agent = bundle.agent as AgentFacet<Readonly<Record<string, unknown>>>
      const plan = yield* agent
        .updatePlan(root)
        .pipe(Effect.mapError((error) => failure(error.message)))
      yield* assertPlan(`${payload.pluginId}@${payload.pluginVersion}`, plan)
      yield* processRunner.run(plan, {
        serverId,
        operationId: payload.operationId,
        image: payload.image,
        networkDestinations: steamDestinations(bundle.permissions.networkDestinations),
      })
      return {
        revision: null,
        code: payload.backupBeforeUpdate ? 'updated-after-backup' : 'updated',
        message: 'Steam plugin update completed; observation is required for activation',
      }
    }),
  inspectHealth: (serverId, pluginId, pluginVersion, operationId) =>
    Effect.gen(function* () {
      if (![serverId, operationId].every(safeSegment))
        return yield* failure('game health identity is unsafe')
      const pluginKey = `${pluginId}@${pluginVersion}`
      const bundle = pluginRegistry.get(pluginKey)
      if (bundle === undefined)
        return yield* failure('plugin version is not in the signed build registry')
      const agent = bundle.agent as AgentFacet<Readonly<Record<string, unknown>>>
      const plan = yield* agent
        .healthPlan(hostRoot(serverId))
        .pipe(Effect.mapError((error) => failure(error.message)))
      yield* assertPlan(pluginKey, plan)
      const result = yield* processRunner.run(plan, {
        serverId,
        operationId,
        image: bundle.manifest.restoreValidationImageDigest,
      })
      return agent.parseHealth(result.output)
    }),
})

export const NodeGameRuntime = (
  root = '/var/lib/gridora/servers',
  socketPath: '/var/run/docker.sock' | '/run/docker.sock' = '/var/run/docker.sock',
): GameRuntime =>
  makeGameRuntime(
    NodeGameProcessRunner(socketPath),
    NodeGameFileWriter(root),
    NodeGameModWriter(root),
  )

import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Effect } from 'effect'
import {
  AGENT_TELEMETRY_LIMITS,
  AgentTelemetryError,
  type DurableLogSpoolStorage,
  type DurableTelemetrySpoolStorage,
} from './index.js'

const DEFAULT_MAXIMUM_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_STALE_LOCK_MILLISECONDS = 30_000
const DEFAULT_LOCK_WAIT_MILLISECONDS = 5_000
const LOCK_FILE_NAME_SUFFIX = '.lock'
const LOCK_RECOVERY_FILE_NAME_SUFFIX = '.recovery'
const PREVIOUS_FILE_NAME_SUFFIX = '.prev'
const TEMP_FILE_NAME_MARKER = '.tmp-'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0

/**
 * Node does not expose a portable advisory flock primitive without a native
 * dependency.  This adapter therefore uses an exclusive lock file, validates
 * the owner PID and Linux `/proc/<pid>/stat` start time before recovering stale
 * locks, and fails closed when liveness/start time cannot be established.
 * `rename` is atomic within the validated directory; callers should still keep
 * the spool directory private (0700) and on a local filesystem.
 */
export const FILE_SPOOL_LOCKING_NOTE =
  'exclusive lockfile with PID/start-time and token/inode recovery validation; no portable kernel flock is available without a native dependency'

export interface FileDurableLogSpoolOptions {
  readonly directory: string
  readonly fileName?: string
  /** Defaults to the current effective UID. */
  readonly expectedUid?: number
  readonly maximumAgeMilliseconds?: number
  readonly staleLockMilliseconds?: number
  readonly lockWaitMilliseconds?: number
  readonly now?: () => number
  /**
   * Test-only race seam. Production callers must not configure it; the
   * recovery path revalidates identity after this callback before unlinking.
   */
  readonly onStaleLockRevalidatedForTest?: (input: {
    readonly path: string
    readonly token: string | null
    readonly device: number
    readonly inode: number
  }) => Promise<void>
}

export interface FileDurableLogSpoolStorage
  extends DurableLogSpoolStorage, DurableTelemetrySpoolStorage {
  readonly dataPath: string
  readonly lockPath: string
  readonly previousPath: string
  readonly capabilities: {
    readonly atomicReplace: true
    readonly directoryFsync: true
    readonly ackOnlyDeletion: true
    readonly locking: typeof FILE_SPOOL_LOCKING_NOTE
  }
}

interface PersistedState {
  readonly version: 1
  readonly entries: ReadonlyArray<unknown>
  readonly pendingPayload?: unknown
  readonly updatedAt: number
}

interface LockRecord {
  readonly pid: number
  readonly processStart: string | null
  readonly token: string
  readonly acquiredAt: number
}

interface LockLease {
  readonly token: string
  readonly handle: Awaited<ReturnType<typeof open>>
  readonly path: string
}

const asError = (cause: unknown, fallback: string): AgentTelemetryError =>
  cause instanceof AgentTelemetryError
    ? cause
    : new AgentTelemetryError({ code: 'offline', message: fallback })

const invalid = (message: string): AgentTelemetryError =>
  new AgentTelemetryError({ code: 'invalid-input', message })

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST'

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const safeFileName = (fileName: string): boolean =>
  fileName.length > 0 &&
  fileName.length <= 128 &&
  basename(fileName) === fileName &&
  !fileName.includes('/') &&
  !fileName.includes('\\') &&
  fileName !== '.' &&
  fileName !== '..' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code

const currentUid = (): number => {
  const uid = process.getuid?.()
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error('file spool requires a process UID')
  return uid
}

const assertDirectorySecurity = (
  status: Awaited<ReturnType<FileHandle['stat']>>,
  expectedUid: number,
): void => {
  if (
    !status.isDirectory() ||
    status.uid !== expectedUid ||
    (Number(status.mode) & 0o777) !== PRIVATE_DIRECTORY_MODE
  )
    throw invalid('spool directory ownership or mode is invalid')
}

const assertFileSecurity = (
  status: Awaited<ReturnType<FileHandle['stat']>>,
  expectedUid: number,
): void => {
  if (
    !status.isFile() ||
    status.uid !== expectedUid ||
    (Number(status.mode) & 0o777) !== PRIVATE_FILE_MODE
  )
    throw invalid('spool file ownership or mode is invalid')
}

const openSecureDirectory = async (path: string, expectedUid: number): Promise<FileHandle> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    assertDirectorySecurity(await handle.stat(), expectedUid)
    return handle
  } catch (cause) {
    try {
      await handle?.close()
    } catch {
      /* preserve the validation failure */
    }
    if (isErrno(cause, 'ELOOP') || isErrno(cause, 'ENOTDIR'))
      throw invalid('spool directory cannot be a symbolic link')
    throw cause
  }
}

const privateDirectory = async (directory: string, expectedUid: number): Promise<string> => {
  const requested = resolve(directory)
  await mkdir(requested, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const handle = await openSecureDirectory(requested, expectedUid)
  await handle.close()
  const canonical = await realpath(requested)
  // Ancestor aliases such as macOS /var -> /private/var are harmless once the
  // canonical directory is used for every subsequent path operation.  The
  // The opened descriptor above identifies the validated spool root. The
  // canonical path is used only to keep ancestor aliases stable.
  return canonical
}

const openSecureExistingFile = async (
  path: string,
  expectedUid: number,
): Promise<FileHandle | undefined> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW)
    assertFileSecurity(await handle.stat(), expectedUid)
    return handle
  } catch (cause) {
    try {
      await handle?.close()
    } catch {
      /* preserve the validation failure */
    }
    if (isErrno(cause, 'ENOENT')) return undefined
    if (isErrno(cause, 'ELOOP')) throw invalid('spool file cannot be a symbolic link')
    throw cause
  }
}

const openSecureWritableFile = async (
  path: string,
  expectedUid: number,
  flags: number,
): Promise<FileHandle> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, flags | O_NOFOLLOW, PRIVATE_FILE_MODE)
    assertFileSecurity(await handle.stat(), expectedUid)
    return handle
  } catch (cause) {
    try {
      await handle?.close()
    } catch {
      /* preserve the validation failure */
    }
    if (isErrno(cause, 'ELOOP')) throw invalid('spool file cannot be a symbolic link')
    throw cause
  }
}

const openSecureExistingOrCreate = async (
  path: string,
  expectedUid: number,
): Promise<FileHandle> => {
  const existing = await openSecureExistingFile(path, expectedUid)
  if (existing !== undefined) {
    await existing.close()
    return openSecureWritableFile(path, expectedUid, fsConstants.O_WRONLY | fsConstants.O_TRUNC)
  }
  return openSecureWritableFile(
    path,
    expectedUid,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
  )
}

interface FileSnapshot {
  readonly text: string
  readonly mtimeMs: number
  readonly device: number
  readonly inode: number
}

interface SpoolPaths {
  readonly directory: string
  readonly dataPath: string
  readonly lockPath: string
  readonly recoveryPath: string
  readonly previousPath: string
}

const readFileSnapshot = async (
  path: string,
  expectedUid: number,
): Promise<FileSnapshot | undefined> => {
  const handle = await openSecureExistingFile(path, expectedUid)
  if (handle === undefined) return undefined
  try {
    const status = await handle.stat()
    return {
      text: await handle.readFile({ encoding: 'utf8' }),
      mtimeMs: status.mtimeMs,
      device: status.dev,
      inode: status.ino,
    }
  } finally {
    await handle.close()
  }
}

const processStartTime = async (pid: number): Promise<string | null> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/)
    // The remainder starts at field 3; field 22 is index 19.
    return fields[19] ?? null
  } catch {
    return null
  }
}

const processAlive = (pid: number): boolean | undefined => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH')
      return false
    return undefined
  }
}

const decodeLock = (value: string): LockRecord | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (typeof parsed.processStart !== 'string' && parsed.processStart !== null) ||
      typeof parsed.token !== 'string' ||
      parsed.token.length < 16 ||
      !Number.isSafeInteger(parsed.acquiredAt)
    )
      return null
    const pid = parsed.pid as number
    const processStart = parsed.processStart as string | null
    const token = parsed.token as string
    const acquiredAt = parsed.acquiredAt as number
    return { pid, processStart, token, acquiredAt }
  } catch {
    return null
  }
}

const staleLock = async (
  record: LockRecord | null,
  fallbackMtimeMs: number | undefined,
  now: number,
  staleMilliseconds: number,
): Promise<boolean> => {
  const acquiredAt = record?.acquiredAt ?? fallbackMtimeMs ?? 0
  if (!Number.isFinite(acquiredAt) || now - acquiredAt < staleMilliseconds) return false
  if (record === null) return true
  const alive = processAlive(record.pid)
  if (alive === true) {
    const actualStart = await processStartTime(record.pid)
    // A live PID with a different start token is PID reuse, not the owner.
    if (record.processStart !== null && actualStart !== null && actualStart !== record.processStart)
      return true
    return false
  }
  // Unknown liveness is deliberately not recoverable: deleting a lock owned
  // by a live process would permit two writers to commit concurrently.
  return alive === false
}

/**
 * Lock records are immutable after exclusive creation. Matching both the
 * kernel file identity and the owner token prevents a stale reader from
 * unlinking a pathname that has since been replaced by a fresh contender.
 */
const matchesLockSnapshot = (
  expected: FileSnapshot,
  current: FileSnapshot | undefined,
  record: LockRecord | null,
): boolean => {
  if (
    current === undefined ||
    current.device !== expected.device ||
    current.inode !== expected.inode
  )
    return false
  if (record === null) return current.text === expected.text && decodeLock(current.text) === null
  return decodeLock(current.text)?.token === record.token
}

const parseState = (value: string | undefined): PersistedState | undefined => {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      !Number.isSafeInteger(parsed.updatedAt)
    )
      return undefined
    return {
      version: 1,
      entries: parsed.entries,
      ...(!('pendingPayload' in parsed) ? {} : { pendingPayload: parsed.pendingPayload }),
      updatedAt: parsed.updatedAt as number,
    }
  } catch {
    return undefined
  }
}

const syncDirectory = async (directory: string, expectedUid: number): Promise<void> => {
  const handle = await openSecureDirectory(directory, expectedUid)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const writeAtomic = async (
  dataPath: string,
  previousPath: string,
  directory: string,
  expectedUid: number,
  state: PersistedState,
): Promise<void> => {
  const existingHandle = await openSecureExistingFile(dataPath, expectedUid)
  const existing = existingHandle === undefined ? undefined : await existingHandle.readFile()
  try {
    await existingHandle?.close()
  } catch {
    /* preserve the write result */
  }
  if (existing !== undefined) {
    const previousHandle = await openSecureExistingOrCreate(previousPath, expectedUid)
    try {
      await previousHandle.writeFile(existing)
      await previousHandle.sync()
    } finally {
      await previousHandle.close()
    }
  }
  const temporary = `${dataPath}${TEMP_FILE_NAME_MARKER}${process.pid}-${randomUUID()}`
  const handle = await openSecureWritableFile(
    temporary,
    expectedUid,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
  )
  try {
    await handle.writeFile(JSON.stringify(state))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, dataPath)
  await syncDirectory(directory, expectedUid)
}

export const makeFileDurableLogSpoolStorage = (
  options: FileDurableLogSpoolOptions,
): FileDurableLogSpoolStorage => {
  if (
    !Number.isSafeInteger(options.maximumAgeMilliseconds ?? DEFAULT_MAXIMUM_AGE_MILLISECONDS) ||
    (options.maximumAgeMilliseconds ?? DEFAULT_MAXIMUM_AGE_MILLISECONDS) < 1
  )
    throw new Error('spool maximum age is invalid')
  const fileName = options.fileName ?? 'logs.spool.json'
  if (!safeFileName(fileName)) throw new Error('spool file name is unsafe')
  const expectedUid = options.expectedUid ?? currentUid()
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0)
    throw new Error('spool expected UID is invalid')
  const maximumAge = options.maximumAgeMilliseconds ?? DEFAULT_MAXIMUM_AGE_MILLISECONDS
  const staleMilliseconds = options.staleLockMilliseconds ?? DEFAULT_STALE_LOCK_MILLISECONDS
  const waitMilliseconds = options.lockWaitMilliseconds ?? DEFAULT_LOCK_WAIT_MILLISECONDS
  if (
    !Number.isSafeInteger(staleMilliseconds) ||
    staleMilliseconds < 1000 ||
    !Number.isSafeInteger(waitMilliseconds) ||
    waitMilliseconds < 0
  )
    throw new Error('spool lock timing is invalid')

  let initializedDirectory: string | undefined
  let dataPath: string | undefined
  let lockPath: string | undefined
  let recoveryPath: string | undefined
  let previousPath: string | undefined

  const initialize = async (): Promise<SpoolPaths> => {
    if (initializedDirectory !== undefined)
      return {
        directory: initializedDirectory,
        dataPath: dataPath!,
        lockPath: lockPath!,
        recoveryPath: recoveryPath!,
        previousPath: previousPath!,
      }
    const directory = await privateDirectory(options.directory, expectedUid)
    const nextDataPath = join(directory, fileName)
    const nextLockPath = `${nextDataPath}${LOCK_FILE_NAME_SUFFIX}`
    const nextRecoveryPath = `${nextLockPath}${LOCK_RECOVERY_FILE_NAME_SUFFIX}`
    const nextPreviousPath = `${nextDataPath}${PREVIOUS_FILE_NAME_SUFFIX}`
    for (const path of [nextDataPath, nextLockPath, nextRecoveryPath, nextPreviousPath]) {
      const handle = await openSecureExistingFile(path, expectedUid)
      await handle?.close()
    }
    initializedDirectory = directory
    dataPath = nextDataPath
    lockPath = nextLockPath
    recoveryPath = nextRecoveryPath
    previousPath = nextPreviousPath
    return {
      directory,
      dataPath: nextDataPath,
      lockPath: nextLockPath,
      recoveryPath: nextRecoveryPath,
      previousPath: nextPreviousPath,
    }
  }

  const lockRecord = async (token: string): Promise<LockRecord> => ({
    pid: process.pid,
    processStart: await processStartTime(process.pid),
    token,
    acquiredAt: Date.now(),
  })

  const createExclusiveLock = async (path: string, record: LockRecord): Promise<LockLease> => {
    const handle = await openSecureWritableFile(
      path,
      expectedUid,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    )
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } catch (cause) {
      try {
        await handle.close()
      } catch {
        /* preserve the write failure */
      }
      const snapshot = await readFileSnapshot(path, expectedUid)
      if (decodeLock(snapshot?.text ?? '')?.token === record.token) {
        try {
          await rm(path)
        } catch {
          /* preserve the write failure */
        }
      }
      throw cause
    }
    return { token: record.token, handle, path }
  }

  const removeIfSnapshotMatches = async (
    paths: SpoolPaths,
    path: string,
    expected: FileSnapshot,
    record: LockRecord | null,
    invokeTestHook: boolean,
  ): Promise<boolean> => {
    const revalidated = await readFileSnapshot(path, expectedUid)
    if (!matchesLockSnapshot(expected, revalidated, record)) return false
    if (invokeTestHook) {
      await options.onStaleLockRevalidatedForTest?.({
        path,
        token: record?.token ?? null,
        device: expected.device,
        inode: expected.inode,
      })
    }
    // The test hook deliberately permits another process to replace the
    // pathname. Always inspect inode and token again immediately before unlink.
    const final = await readFileSnapshot(path, expectedUid)
    if (!matchesLockSnapshot(expected, final, record)) return false
    try {
      await rm(path)
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) return false
      throw cause
    }
    await syncDirectory(paths.directory, expectedUid)
    return true
  }

  const releaseLease = async (paths: SpoolPaths, lease: LockLease): Promise<void> => {
    try {
      await lease.handle.close()
    } catch {
      /* preserve the transaction result */
    }
    const snapshot = await readFileSnapshot(lease.path, expectedUid)
    const record = decodeLock(snapshot?.text ?? '')
    if (snapshot !== undefined && record?.token === lease.token)
      await removeIfSnapshotMatches(paths, lease.path, snapshot, record, false)
  }

  const recoveryGateOpen = async (paths: SpoolPaths): Promise<boolean> => {
    const snapshot = await readFileSnapshot(paths.recoveryPath, expectedUid)
    if (snapshot === undefined) return false
    const record = decodeLock(snapshot.text)
    if (!(await staleLock(record, snapshot.mtimeMs, Date.now(), staleMilliseconds))) return true
    // A crashed recovery contender cannot permanently deny spool progress. Its
    // gate is removed only after the same inode/token revalidation used for a
    // stale primary lock.
    await removeIfSnapshotMatches(paths, paths.recoveryPath, snapshot, record, false)
    return (await readFileSnapshot(paths.recoveryPath, expectedUid)) !== undefined
  }

  const acquireRecoveryGate = async (paths: SpoolPaths): Promise<LockLease | undefined> => {
    const record = await lockRecord(randomUUID())
    try {
      return await createExclusiveLock(paths.recoveryPath, record)
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause
      await recoveryGateOpen(paths)
      return undefined
    }
  }

  const recoverStalePrimaryLock = async (
    paths: SpoolPaths,
    snapshot: FileSnapshot,
    record: LockRecord | null,
  ): Promise<boolean> => {
    const gate = await acquireRecoveryGate(paths)
    if (gate === undefined) return false
    try {
      // The recovery lease serializes destructive stale-lock cleanup. A new
      // contender that races after this point observes the lease and never
      // enters its critical section until the old pathname is resolved.
      return await removeIfSnapshotMatches(paths, paths.lockPath, snapshot, record, true)
    } finally {
      await releaseLease(paths, gate)
    }
  }

  const acquire = async (paths: SpoolPaths): Promise<LockLease> => {
    const deadline = Date.now() + waitMilliseconds
    for (;;) {
      if (await recoveryGateOpen(paths)) {
        if (Date.now() >= deadline)
          throw new AgentTelemetryError({ code: 'offline', message: 'Log spool lock is busy' })
        await delay(Math.min(25, Math.max(1, deadline - Date.now())))
        continue
      }
      const record = await lockRecord(randomUUID())
      try {
        const lease = await createExclusiveLock(paths.lockPath, record)
        // A recovery lease can appear in the narrow interval between the first
        // gate observation and O_EXCL creation. Relinquish this exact lock and
        // retry rather than entering a critical section during recovery.
        if (!(await recoveryGateOpen(paths))) return lease
        await releaseLease(paths, lease)
        continue
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause
        const snapshot = await readFileSnapshot(paths.lockPath, expectedUid)
        const existing = decodeLock(snapshot?.text ?? '')
        if (await staleLock(existing, snapshot?.mtimeMs, Date.now(), staleMilliseconds)) {
          if (snapshot !== undefined) await recoverStalePrimaryLock(paths, snapshot, existing)
          continue
        }
        if (Date.now() >= deadline)
          throw new AgentTelemetryError({ code: 'offline', message: 'Log spool lock is busy' })
        await delay(Math.min(25, Math.max(1, deadline - Date.now())))
      }
    }
  }

  const release = async (paths: SpoolPaths, lease: LockLease): Promise<void> =>
    releaseLease(paths, lease)

  const recover = async (
    paths: Awaited<ReturnType<typeof initialize>>,
  ): Promise<PersistedState | undefined> => {
    const current = parseState((await readFileSnapshot(paths.dataPath, expectedUid))?.text)
    if (current !== undefined) {
      const directoryHandle = await openSecureDirectory(paths.directory, expectedUid)
      const names = await readdir(paths.directory)
      await directoryHandle.close()
      for (const name of names.filter((item) =>
        item.startsWith(`${basename(paths.dataPath)}${TEMP_FILE_NAME_MARKER}`),
      )) {
        const candidate = join(paths.directory, name)
        const candidateHandle = await openSecureExistingFile(candidate, expectedUid)
        await candidateHandle?.close()
        try {
          await rm(candidate)
        } catch (cause) {
          if (!isErrno(cause, 'ENOENT')) throw cause
        }
      }
      return current
    }
    const previous = parseState((await readFileSnapshot(paths.previousPath, expectedUid))?.text)
    const directoryHandle = await openSecureDirectory(paths.directory, expectedUid)
    const names = await readdir(paths.directory)
    await directoryHandle.close()
    const temporaryCandidates: Array<{
      readonly path: string
      readonly mtimeMs: number
      readonly state: PersistedState
    }> = []
    for (const name of names.filter((item) =>
      item.startsWith(`${basename(paths.dataPath)}${TEMP_FILE_NAME_MARKER}`),
    )) {
      const candidate = join(paths.directory, name)
      const snapshot = await readFileSnapshot(candidate, expectedUid)
      const candidateState = parseState(snapshot?.text)
      if (candidateState !== undefined && snapshot !== undefined) {
        temporaryCandidates.push({
          path: candidate,
          mtimeMs: snapshot.mtimeMs,
          state: candidateState,
        })
      }
    }
    const recovered = temporaryCandidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
    if (recovered !== undefined) {
      await rename(recovered.path, paths.dataPath)
      await syncDirectory(paths.directory, expectedUid)
      return recovered.state
    }
    if (previous !== undefined) {
      await rename(paths.previousPath, paths.dataPath)
      await syncDirectory(paths.directory, expectedUid)
      return previous
    }
    const raw = (await readFileSnapshot(paths.dataPath, expectedUid))?.text
    if (raw === undefined) return undefined
    throw invalid('durable log spool state is corrupt')
  }

  const validateEntries = (entries: ReadonlyArray<unknown>, now: number): void => {
    if (entries.length > AGENT_TELEMETRY_LIMITS.maximumSpoolEntries)
      throw new AgentTelemetryError({
        code: 'offline',
        message: 'Durable log spool exceeds the configured entry bound',
      })
    const bytes = byteLength({ version: 1, entries, updatedAt: now })
    if (bytes > AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes)
      throw new AgentTelemetryError({
        code: 'offline',
        message: 'Durable log spool exceeds the configured byte bound',
      })
    for (const value of entries) {
      const timestamp =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>).timestamp
          : undefined
      if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))
        throw invalid('durable log spool entry timestamp is invalid')
      const timestampMilliseconds = Date.parse(timestamp)
      if (timestampMilliseconds > now + AGENT_TELEMETRY_LIMITS.maximumFutureSkewMilliseconds)
        throw invalid('durable log spool entry timestamp is too far in the future')
      if (timestampMilliseconds < now - maximumAge)
        throw new AgentTelemetryError({
          code: 'offline',
          message: 'Durable log spool entry exceeds the retention age',
        })
    }
  }

  const transact: DurableLogSpoolStorage['transact'] = (operation) =>
    Effect.tryPromise({
      try: async () => {
        const paths = await initialize()
        const lease = await acquire(paths)
        try {
          const state = await recover(paths)
          const transition = await Effect.runPromise(operation(state?.entries ?? []))
          validateEntries(transition.entries, options.now?.() ?? Date.now())
          await writeAtomic(paths.dataPath, paths.previousPath, paths.directory, expectedUid, {
            version: 1,
            entries: transition.entries,
            updatedAt: options.now?.() ?? Date.now(),
          })
          return transition.result
        } finally {
          await release(paths, lease)
        }
      },
      catch: (cause) => asError(cause, 'Durable log spool transaction failed'),
    })

  const transactTelemetry: DurableTelemetrySpoolStorage['transactTelemetry'] = (operation) =>
    Effect.tryPromise({
      try: async () => {
        const paths = await initialize()
        const lease = await acquire(paths)
        try {
          const stored = await recover(paths)
          const persistedPending = stored?.pendingPayload
          // JSON must preserve a pending publication as an envelope object.
          // A scalar would otherwise be mistaken for an empty slot and lose
          // the only durable copy after a crash.
          if (
            persistedPending !== undefined &&
            (typeof persistedPending !== 'object' || persistedPending === null)
          )
            throw invalid('Durable telemetry pending payload is invalid')
          const current = {
            entries: stored?.entries ?? [],
            pendingPayload: persistedPending ?? null,
          }
          const transition = await Effect.runPromise(operation(current))
          validateEntries(transition.state.entries, options.now?.() ?? Date.now())
          const pendingBytes =
            transition.state.pendingPayload === null
              ? 0
              : byteLength(transition.state.pendingPayload)
          if (
            pendingBytes >
            AGENT_TELEMETRY_LIMITS.maximumHealthBytes + AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes
          )
            throw new AgentTelemetryError({
              code: 'offline',
              message: 'Durable telemetry pending payload exceeds the configured byte bound',
            })
          await writeAtomic(paths.dataPath, paths.previousPath, paths.directory, expectedUid, {
            version: 1,
            entries: transition.state.entries,
            ...(transition.state.pendingPayload === null
              ? {}
              : { pendingPayload: transition.state.pendingPayload }),
            updatedAt: options.now?.() ?? Date.now(),
          })
          return transition.result
        } finally {
          await release(paths, lease)
        }
      },
      catch: (cause) => asError(cause, 'Durable telemetry spool transaction failed'),
    })

  return {
    transact,
    transactTelemetry,
    get dataPath() {
      return dataPath ?? resolve(options.directory, fileName)
    },
    get lockPath() {
      return lockPath ?? resolve(options.directory, `${fileName}${LOCK_FILE_NAME_SUFFIX}`)
    },
    get previousPath() {
      return previousPath ?? resolve(options.directory, `${fileName}${PREVIOUS_FILE_NAME_SUFFIX}`)
    },
    capabilities: {
      atomicReplace: true,
      directoryFsync: true,
      ackOnlyDeletion: true,
      locking: FILE_SPOOL_LOCKING_NOTE,
    },
  }
}

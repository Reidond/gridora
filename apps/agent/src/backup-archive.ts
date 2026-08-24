import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import {
  type ArchiveEntry,
  BackupArchive,
  BackupExecutionError,
  type BackupPlan,
  validateTypedArchiveEntries,
  validateArchiveEntries,
} from '@gridora/backup-runtime'
import { Effect, Layer } from 'effect'

const blockSize = 512
const markerName = '.gridora-restore-complete'
const sourceAbsentMarkerSuffix = '.source-absent'
const maxEntryBytes = 256 * 1024 * 1024 * 1024
const failure = (message: string) => new BackupExecutionError({ code: 'io-failed', message })
const byteOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const beneath = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

const octal = (value: number, length: number): Buffer => {
  const encoded = value.toString(8).padStart(length - 1, '0')
  if (encoded.length >= length) throw new Error('tar numeric field overflow')
  return Buffer.from(`${encoded}\0`, 'ascii')
}

const tarName = (path: string): { readonly name: string; readonly prefix: string } => {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`archive path is too long for deterministic ustar: ${path}`)
}

const tarHeader = (path: string, kind: 'file' | 'directory', size: number): Buffer => {
  const header = Buffer.alloc(blockSize)
  const split = tarName(path)
  header.write(split.name, 0, 100, 'utf8')
  octal(kind === 'directory' ? 0o755 : 0o600, 8).copy(header, 100)
  octal(0, 8).copy(header, 108)
  octal(0, 8).copy(header, 116)
  octal(size, 12).copy(header, 124)
  octal(0, 12).copy(header, 136)
  header.fill(0x20, 148, 156)
  header.write(kind === 'directory' ? '5' : '0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'ascii')
  header.write('root', 297, 32, 'ascii')
  header.write(split.prefix, 345, 155, 'utf8')
  octal(
    [...header].reduce((sum, byte) => sum + byte, 0),
    8,
  ).copy(header, 148)
  return header
}

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
): Promise<void> => {
  let offset = 0
  while (offset < buffer.length) offset += (await handle.write(buffer, offset)).bytesWritten
}

const appendTree = async (
  tar: Awaited<ReturnType<typeof open>>,
  source: string,
  archivePath: string,
  budget: { entries: number; bytes: number; readonly plan: BackupPlan },
): Promise<void> => {
  validateArchiveEntries([archivePath])
  const metadata = await lstat(source)
  budget.entries += 1
  const maxEntries = Math.max(1, Math.min(100_000, Math.floor(budget.plan.diskBytes / blockSize)))
  if (budget.entries > maxEntries) throw new Error('backup entry count exceeds disk policy')
  if (metadata.isSymbolicLink()) throw new Error(`backup source contains symlink: ${archivePath}`)
  if (metadata.isDirectory()) {
    await writeAll(tar, tarHeader(archivePath, 'directory', 0))
    const children = (await readdir(source)).sort(byteOrder)
    for (const child of children)
      await appendTree(tar, join(source, child), `${archivePath}/${child}`, budget)
    return
  }
  if (!metadata.isFile()) throw new Error(`backup source has forbidden type: ${archivePath}`)
  if (metadata.size > Math.min(maxEntryBytes, budget.plan.diskBytes))
    throw new Error(`backup entry exceeds size limit: ${archivePath}`)
  budget.bytes += metadata.size
  if (budget.bytes > budget.plan.diskBytes) throw new Error('backup data exceeds disk policy')
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = await input.stat()
    if (!opened.isFile() || opened.ino !== metadata.ino)
      throw new Error(`backup source changed before open: ${archivePath}`)
    await writeAll(tar, tarHeader(archivePath, 'file', opened.size))
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < opened.size) {
      const read = await input.read(
        chunk,
        0,
        Math.min(chunk.length, opened.size - position),
        position,
      )
      if (read.bytesRead === 0) throw new Error(`backup source was truncated: ${archivePath}`)
      await writeAll(tar, chunk.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
    const after = await input.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new Error(`backup source changed while archiving: ${archivePath}`)
    const padding = (blockSize - (opened.size % blockSize)) % blockSize
    if (padding > 0) await writeAll(tar, Buffer.alloc(padding))
  } finally {
    await input.close()
  }
}

const parseOctal = (buffer: Buffer, start: number, length: number): number => {
  const value = buffer
    .subarray(start, start + length)
    .toString('ascii')
    .replace(/\0.*$/, '')
    .trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('archive contains an invalid numeric field')
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) throw new Error('archive numeric field is unsafe')
  return parsed
}

interface ParsedEntry extends ArchiveEntry {
  readonly size: number
  readonly dataOffset: number
}

const parseTar = async (path: string, plan: BackupPlan): Promise<ReadonlyArray<ParsedEntry>> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  const entries: ParsedEntry[] = []
  try {
    let offset = 0
    let zeroBlocks = 0
    let aggregateBytes = 0
    const maxEntries = Math.max(1, Math.min(100_000, Math.floor(plan.diskBytes / blockSize)))
    while (true) {
      const header = Buffer.alloc(blockSize)
      const read = await handle.read(header, 0, blockSize, offset)
      if (read.bytesRead === 0) break
      if (read.bytesRead !== blockSize) throw new Error('archive has a truncated header')
      offset += blockSize
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1
        if (zeroBlocks === 2) break
        continue
      }
      zeroBlocks = 0
      const checksum = parseOctal(header, 148, 8)
      const checksumHeader = Buffer.from(header)
      checksumHeader.fill(0x20, 148, 156)
      if ([...checksumHeader].reduce((sum, byte) => sum + byte, 0) !== checksum)
        throw new Error('archive header checksum is invalid')
      if (header.subarray(257, 263).toString('ascii') !== 'ustar\0')
        throw new Error('archive is not deterministic ustar')
      const readString = (start: number, length: number) =>
        header
          .subarray(start, start + length)
          .toString('utf8')
          .replace(/\0.*$/, '')
      const name = readString(0, 100)
      const prefix = readString(345, 155)
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      const size = parseOctal(header, 124, 12)
      if (size > Math.min(maxEntryBytes, plan.diskBytes))
        throw new Error(`archive entry exceeds size limit: ${entryPath}`)
      const type = readString(156, 1) || '0'
      const kind: ArchiveEntry['kind'] =
        type === '0'
          ? 'file'
          : type === '5'
            ? 'directory'
            : type === '2'
              ? 'symlink'
              : type === '1'
                ? 'hardlink'
                : type === '3' || type === '4'
                  ? 'device'
                  : type === '6'
                    ? 'fifo'
                    : 'symlink'
      entries.push({ path: entryPath, kind, size, dataOffset: offset })
      aggregateBytes += size
      if (entries.length > maxEntries) throw new Error('archive entry count exceeds disk policy')
      if (aggregateBytes > plan.diskBytes) throw new Error('archive data exceeds disk policy')
      offset += Math.ceil(size / blockSize) * blockSize
    }
    const metadata = await handle.stat()
    if (zeroBlocks !== 2 || offset !== metadata.size)
      throw new Error('archive does not have an exact deterministic ustar terminator')
    if (entries.some((entry) => entry.kind === 'directory' && entry.size !== 0))
      throw new Error('archive directory entry has data')
    validateTypedArchiveEntries(entries)
    return entries
  } finally {
    await handle.close()
  }
}

const byteLimiter = (maximum: number, label: string) => {
  let observed = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      observed += chunk.length
      callback(observed > maximum ? new Error(`${label} exceeds disk policy`) : undefined, chunk)
    },
  })
}

const expandedLimit = (plan: BackupPlan): number => {
  const entries = Math.max(1, Math.min(100_000, Math.floor(plan.diskBytes / blockSize)))
  return plan.diskBytes + entries * blockSize + blockSize * 2
}

const ensureFreeSpace = async (path: string, requiredBytes: number): Promise<void> => {
  const available = await statfs(path)
  const availableBytes = Number(available.bavail) * Number(available.bsize)
  if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredBytes)
    throw new Error('insufficient free space for bounded backup operation')
}

const decompress = async (archivePath: string, target: string, plan: BackupPlan): Promise<void> => {
  const input = await open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  await pipeline(
    input.createReadStream(),
    createZstdDecompress(),
    byteLimiter(expandedLimit(plan), 'expanded archive'),
    createWriteStream(target, { flags: 'wx', mode: 0o600 }),
  )
}

const checksumFile = async (path: string): Promise<string> => {
  const digest = createHash('sha256')
  const input = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  for await (const chunk of input.createReadStream()) digest.update(chunk as Buffer)
  return `sha256:${digest.digest('hex')}`
}

const exists = async (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch((cause: unknown) => {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT')
        return false
      throw cause
    })

const fsyncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const copyNoFollow = async (source: string, target: string): Promise<void> => {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  const output = await open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (true) {
      const read = await input.read(buffer, 0, buffer.length, position)
      if (read.bytesRead === 0) break
      await writeAll(output, buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
    await output.sync()
  } finally {
    await Promise.allSettled([input.close(), output.close()])
  }
}

const snapshotAndChecksum = async (
  source: string,
  target: string,
  maximumBytes: number,
): Promise<string> => {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  const output = await open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  )
  const digest = createHash('sha256')
  try {
    const sourceMetadata = await input.stat()
    if (!sourceMetadata.isFile() || sourceMetadata.size > maximumBytes)
      throw new Error('compressed archive exceeds disk policy')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (true) {
      const read = await input.read(buffer, 0, buffer.length, position)
      if (read.bytesRead === 0) break
      position += read.bytesRead
      if (position > maximumBytes) throw new Error('compressed archive exceeds disk policy')
      const chunk = buffer.subarray(0, read.bytesRead)
      digest.update(chunk)
      await writeAll(output, chunk)
    }
    const after = await input.stat()
    if (
      after.ino !== sourceMetadata.ino ||
      after.size !== position ||
      after.mtimeMs !== sourceMetadata.mtimeMs
    )
      throw new Error('archive changed while creating the verified snapshot')
    await output.sync()
    return `sha256:${digest.digest('hex')}`
  } finally {
    await Promise.allSettled([input.close(), output.close()])
  }
}

const validatePlanPaths = async (plan: BackupPlan, trustedRoot: string): Promise<void> => {
  if (!Number.isSafeInteger(plan.diskBytes) || plan.diskBytes < 1 || plan.diskBytes > 1024 ** 5)
    throw new Error('backup disk policy is invalid')
  const canonicalRoot = await realpath(trustedRoot)
  const lexicalRoot = resolve(trustedRoot)
  for (const candidate of [
    plan.serverRoot,
    plan.stagingDirectory,
    plan.archivePath,
    ...(plan.atomicTarget === undefined ? [] : [plan.atomicTarget]),
    ...plan.includes.filter((path) => path.startsWith('/')),
  ]) {
    const resolved = resolve(candidate)
    if (!beneath(lexicalRoot, resolved))
      throw new Error(`backup path escapes trusted root: ${candidate}`)
    let existing = resolved
    while (!(await exists(existing))) existing = dirname(existing)
    const canonicalExisting = await realpath(existing)
    if (canonicalExisting !== canonicalRoot && !beneath(canonicalRoot, canonicalExisting))
      throw new Error(`backup path resolves outside trusted root: ${candidate}`)
  }
}

export const NodeBackupArchive = (trustedRoot = '/var/lib/gridora/servers') => {
  const snapshots = new Map<string, string>()
  const snapshotKey = (plan: BackupPlan) => `${plan.archivePath}\0${plan.stagingDirectory}`
  const snapshotFor = (plan: BackupPlan): string => {
    const snapshot = snapshots.get(snapshotKey(plan))
    if (snapshot === undefined) throw new Error('verified archive snapshot is unavailable')
    return snapshot
  }
  const releaseSnapshot = async (plan: BackupPlan): Promise<void> => {
    const key = snapshotKey(plan)
    const snapshot = snapshots.get(key)
    snapshots.delete(key)
    if (snapshot !== undefined) await rm(snapshot, { force: true })
  }
  return Layer.succeed(BackupArchive, {
    create: (plan) =>
      Effect.tryPromise({
        try: async () => {
          await validatePlanPaths(plan, trustedRoot)
          await ensureFreeSpace(trustedRoot, expandedLimit(plan) + plan.diskBytes)
          const tarPath = `${plan.stagingDirectory}.${process.pid}.${randomBytes(6).toString('hex')}.tar`
          const compressed = `${plan.archivePath}.partial-${process.pid}-${randomBytes(6).toString('hex')}`
          await mkdir(dirname(plan.archivePath), { recursive: true, mode: 0o700 })
          try {
            const tar = await open(tarPath, 'wx', 0o600)
            try {
              const budget = { entries: 0, bytes: 0, plan }
              for (const source of [...plan.includes].sort(byteOrder)) {
                const sourcePath = resolve(source)
                if (!beneath(resolve(plan.serverRoot), sourcePath))
                  throw new Error(`backup include escapes server root: ${source}`)
                await appendTree(tar, sourcePath, relative(plan.serverRoot, sourcePath), budget)
              }
              await writeAll(tar, Buffer.alloc(blockSize * 2))
              await tar.sync()
            } finally {
              await tar.close()
            }
            const input = await open(tarPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
            if ((await input.stat()).size > expandedLimit(plan))
              throw new Error('expanded archive exceeds disk policy')
            await pipeline(
              input.createReadStream(),
              createZstdCompress(),
              byteLimiter(plan.diskBytes, 'compressed archive'),
              createWriteStream(compressed, { flags: 'wx', mode: 0o600 }),
            )
            const output = await open(compressed, 'r')
            await output.sync()
            await output.close()
            const digest = await checksumFile(compressed)
            const bytes = (await lstat(compressed)).size
            await rename(compressed, plan.archivePath)
            await fsyncDirectory(dirname(plan.archivePath))
            return { archivePath: plan.archivePath, bytes, sha256: digest }
          } finally {
            await rm(compressed, { force: true })
            await rm(tarPath, { force: true })
          }
        },
        catch: (cause) => failure(`backup creation failed: ${String(cause)}`),
      }),
    checksum: (plan) =>
      Effect.tryPromise({
        try: async () => {
          await validatePlanPaths(plan, trustedRoot)
          await releaseSnapshot(plan)
          const verifiedRoot = join(trustedRoot, '.gridora-verified-backups')
          await mkdir(verifiedRoot, { recursive: true, mode: 0o700 })
          const verifiedMetadata = await lstat(verifiedRoot)
          if (
            verifiedMetadata.isSymbolicLink() ||
            (verifiedMetadata.mode & 0o077) !== 0 ||
            (process.getuid !== undefined && verifiedMetadata.uid !== process.getuid())
          )
            throw new Error('verified backup directory has unsafe ownership or permissions')
          const snapshot = join(
            verifiedRoot,
            `${basename(plan.archivePath)}-${process.pid}-${randomBytes(8).toString('hex')}`,
          )
          try {
            const sourceSize = (await stat(plan.archivePath)).size
            await ensureFreeSpace(verifiedRoot, sourceSize)
            const observed = await snapshotAndChecksum(plan.archivePath, snapshot, plan.diskBytes)
            snapshots.set(snapshotKey(plan), snapshot)
            return observed
          } catch (cause) {
            await rm(snapshot, { force: true })
            throw cause
          }
        },
        catch: (cause) => failure(`backup checksum failed: ${String(cause)}`),
      }),
    enumerate: (plan) =>
      Effect.tryPromise({
        try: async () => {
          const snapshot = snapshotFor(plan)
          const temporary = `${snapshot}.inspect`
          try {
            await ensureFreeSpace(dirname(temporary), expandedLimit(plan))
            await decompress(snapshot, temporary, plan)
            return (await parseTar(temporary, plan)).map(({ path, kind }) => ({ path, kind }))
          } finally {
            await rm(temporary, { force: true })
          }
        },
        catch: (cause) => failure(`backup inspection failed: ${String(cause)}`),
      }),
    extractToStaging: (plan, expectedEntries) =>
      Effect.tryPromise({
        try: async () => {
          await validatePlanPaths(plan, trustedRoot)
          const temporary = `${plan.stagingDirectory}.archive-${process.pid}-${randomBytes(6).toString('hex')}`
          await rm(plan.stagingDirectory, { recursive: true, force: true })
          await rm(temporary, { force: true })
          try {
            const snapshot = snapshotFor(plan)
            await ensureFreeSpace(
              dirname(plan.stagingDirectory),
              expandedLimit(plan) + plan.diskBytes,
            )
            await decompress(snapshot, temporary, plan)
            const entries = await parseTar(temporary, plan)
            const inventory = entries.map(({ path, kind }) => ({ path, kind }))
            if (JSON.stringify(inventory) !== JSON.stringify(expectedEntries))
              throw new Error('archive changed between inspection and extraction')
            await mkdir(plan.stagingDirectory, { recursive: true, mode: 0o700 })
            const archive = await open(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
            try {
              for (const entry of entries) {
                const target = join(plan.stagingDirectory, entry.path)
                if (!beneath(plan.stagingDirectory, target))
                  throw new Error('archive extraction escaped staging')
                if (entry.kind === 'directory') {
                  await mkdir(target, { recursive: true, mode: 0o755 })
                  continue
                }
                await mkdir(dirname(target), { recursive: true, mode: 0o755 })
                const output = await open(
                  target,
                  fsConstants.O_WRONLY |
                    fsConstants.O_CREAT |
                    fsConstants.O_EXCL |
                    fsConstants.O_NOFOLLOW,
                  0o600,
                )
                try {
                  const buffer = Buffer.allocUnsafe(1024 * 1024)
                  let copied = 0
                  while (copied < entry.size) {
                    const read = await archive.read(
                      buffer,
                      0,
                      Math.min(buffer.length, entry.size - copied),
                      entry.dataOffset + copied,
                    )
                    if (read.bytesRead === 0)
                      throw new Error(`archive entry is truncated: ${entry.path}`)
                    await writeAll(output, buffer.subarray(0, read.bytesRead))
                    copied += read.bytesRead
                  }
                  await output.sync()
                } finally {
                  await output.close()
                }
              }
            } finally {
              await archive.close()
            }
            await mkdir(join(plan.stagingDirectory, 'backups'), { recursive: true, mode: 0o700 })
            const retainedArchive = join(
              plan.stagingDirectory,
              'backups',
              basename(plan.archivePath),
            )
            await copyNoFollow(snapshot, retainedArchive)
            await writeFile(join(plan.stagingDirectory, markerName), plan.expectedSha256 ?? '', {
              mode: 0o600,
              flag: 'wx',
            })
            await fsyncDirectory(plan.stagingDirectory)
          } catch (cause) {
            await rm(plan.stagingDirectory, { recursive: true, force: true })
            throw cause
          } finally {
            await rm(temporary, { force: true })
          }
        },
        catch: (cause) => failure(`backup extraction failed: ${String(cause)}`),
      }),
    commitRestore: (plan) =>
      Effect.tryPromise({
        try: async () => {
          if (plan.atomicTarget === undefined) throw new Error('atomic target is required')
          await validatePlanPaths(plan, trustedRoot)
          const target = plan.atomicTarget
          const rollback = `${target}.rollback-${basename(plan.stagingDirectory)}`
          const sourceAbsentMarker = `${rollback}${sourceAbsentMarkerSuffix}`
          const targetExists = await exists(target)
          const stageExists = await exists(plan.stagingDirectory)
          const rollbackExists = await exists(rollback)
          if (targetExists && !stageExists) {
            if ((await readFile(join(target, markerName), 'utf8')).trim() !== plan.expectedSha256)
              throw new Error('restore staging disappeared before cutover')
            // Exact response-loss adoption. The rollback tree/absence marker is
            // deliberately retained until the control-plane operation succeeds.
            return
          }
          if (!stageExists) {
            if (!targetExists && rollbackExists) {
              await rename(rollback, target)
              await fsyncDirectory(dirname(target))
            }
            throw new Error('restore staging is unavailable')
          }
          if (!targetExists && rollbackExists) {
            await rename(plan.stagingDirectory, target)
            await fsyncDirectory(dirname(target))
            return
          }
          if (!targetExists) {
            await writeFile(sourceAbsentMarker, plan.expectedSha256 ?? '', {
              mode: 0o600,
              flag: (await exists(sourceAbsentMarker)) ? 'r+' : 'wx',
            })
            await rename(plan.stagingDirectory, target)
            await fsyncDirectory(dirname(target))
            return
          }
          if (rollbackExists || (await exists(sourceAbsentMarker)))
            throw new Error('restore rollback identity already exists before cutover')
          await rename(target, rollback)
          try {
            await rename(plan.stagingDirectory, target)
            await fsyncDirectory(dirname(target))
          } catch (cause) {
            await rename(rollback, target)
            throw cause
          }
          await fsyncDirectory(dirname(target))
        },
        catch: (cause) => failure(`backup cutover failed: ${String(cause)}`),
      }),
    rollbackRestore: (plan) =>
      Effect.tryPromise({
        try: async () => {
          if (plan.atomicTarget === undefined) throw new Error('atomic target is required')
          await validatePlanPaths(plan, trustedRoot)
          const target = plan.atomicTarget
          const rollback = `${target}.rollback-${basename(plan.stagingDirectory)}`
          const sourceAbsentMarker = `${rollback}${sourceAbsentMarkerSuffix}`
          const targetExists = await exists(target)
          const rollbackExists = await exists(rollback)
          const sourceWasAbsent = await exists(sourceAbsentMarker)
          if (rollbackExists) {
            if (targetExists) {
              const marker = await readFile(join(target, markerName), 'utf8').catch(() => '')
              if (marker.trim() !== plan.expectedSha256)
                throw new Error('restore rollback target is not the exact committed staging tree')
              await rm(target, { recursive: true, force: true })
            }
            await rename(rollback, target)
            await rm(plan.stagingDirectory, { recursive: true, force: true })
            await rm(sourceAbsentMarker, { force: true })
            await fsyncDirectory(dirname(target))
            return
          }
          if (sourceWasAbsent) {
            if (targetExists) {
              const marker = await readFile(join(target, markerName), 'utf8').catch(() => '')
              if (marker.trim() !== plan.expectedSha256)
                throw new Error('restore rollback target does not match the absent-source receipt')
              await rm(target, { recursive: true, force: true })
            }
            await rm(plan.stagingDirectory, { recursive: true, force: true })
            await rm(sourceAbsentMarker, { force: true })
            await fsyncDirectory(dirname(target))
            return
          }
          // Rollback before cutover: remove only the isolated staging tree.
          await rm(plan.stagingDirectory, { recursive: true, force: true })
        },
        catch: (cause) => failure(`backup rollback failed: ${String(cause)}`),
      }),
    finalizeRestore: (plan) =>
      Effect.tryPromise({
        try: async () => {
          if (plan.atomicTarget === undefined) throw new Error('atomic target is required')
          await validatePlanPaths(plan, trustedRoot)
          const target = plan.atomicTarget
          const rollback = `${target}.rollback-${basename(plan.stagingDirectory)}`
          const sourceAbsentMarker = `${rollback}${sourceAbsentMarkerSuffix}`
          if (!(await exists(target))) throw new Error('restore target is unavailable at finalize')
          const marker = await readFile(join(target, markerName), 'utf8').catch(() => '')
          if (marker.trim() !== plan.expectedSha256)
            throw new Error('restore finalize target is not the exact committed staging tree')
          await rm(rollback, { recursive: true, force: true })
          await rm(sourceAbsentMarker, { force: true })
          await rm(plan.stagingDirectory, { recursive: true, force: true })
          await fsyncDirectory(dirname(target))
        },
        catch: (cause) => failure(`backup finalize failed: ${String(cause)}`),
      }),
    release: (plan) => Effect.promise(() => releaseSnapshot(plan)),
  })
}

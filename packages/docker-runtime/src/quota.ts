import { execFile } from 'node:child_process'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  statfs,
  unlink,
} from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PROJECT_QUOTA_API_VERSION = 'quota.gridora.dev/v1alpha1' as const
export const PROJECT_QUOTA_SOCKET = '/run/gridora/quota.sock' as const
export const PROJECT_QUOTA_ROOT = '/var/lib/gridora/servers' as const
export const PROJECT_QUOTA_STATE = '/var/lib/gridora/quota/projects.json' as const
export const PROJECT_QUOTA_BACKING_FILE = '/var/lib/gridora/gridora-servers.ext4' as const

const PROJECT_ID_START = 1_000_000_000
const PROJECT_ID_MAX = 2_147_483_647
const MAX_REQUEST_BYTES = 16 * 1024
const DATA_UID = 10_001
const DATA_GID = 10_001
const MIN_QUOTA_BYTES = 1024 * 1024
const MIN_FILESYSTEM_BYTES = 4n * 1024n * 1024n * 1024n
const MIN_HOST_RESERVE_BYTES = 4n * 1024n * 1024n * 1024n
const CAPACITY_NUMERATOR = 9n
const CAPACITY_DENOMINATOR = 10n
const SERVER_DIRECT_CHILDREN = [
  'game',
  'config',
  'data',
  'mods',
  'staging',
  'backups',
  'state',
] as const

const FIXED_COMMANDS = {
  blkid: '/usr/sbin/blkid',
  chattr: '/usr/bin/chattr',
  e2fsck: '/usr/sbin/e2fsck',
  fallocate: '/usr/bin/fallocate',
  find: '/usr/bin/find',
  findmnt: '/usr/bin/findmnt',
  getent: '/usr/bin/getent',
  losetup: '/usr/sbin/losetup',
  lsattr: '/usr/bin/lsattr',
  mkfsExt4: '/usr/sbin/mkfs.ext4',
  mount: '/usr/bin/mount',
  repquota: '/usr/sbin/repquota',
  setquota: '/usr/sbin/setquota',
  tune2fs: '/usr/sbin/tune2fs',
} as const

type FixedCommand = (typeof FIXED_COMMANDS)[keyof typeof FIXED_COMMANDS]

export interface ProjectQuotaRequest {
  readonly apiVersion: typeof PROJECT_QUOTA_API_VERSION
  readonly action: 'ensure'
  readonly serverId: string
  readonly requestedBytes: number
  readonly mountSources: readonly string[]
}

export interface ProjectQuotaProof {
  readonly apiVersion: typeof PROJECT_QUOTA_API_VERSION
  readonly enforced: true
  readonly method: 'ext4-project-quota'
  readonly serverId: string
  readonly projectId: number
  readonly hardBytes: number
  readonly root: string
}

export class ProjectQuotaError extends Error {
  override readonly name = 'ProjectQuotaError'

  constructor(
    readonly code:
      | 'invalid_request'
      | 'unsafe_path'
      | 'unsupported_filesystem'
      | 'capacity_exceeded'
      | 'state_corrupt'
      | 'command_failed'
      | 'unavailable'
      | 'invalid_response',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface QuotaCommandRunner {
  run(
    command: FixedCommand,
    args: readonly string[],
    acceptedExitCodes?: readonly number[],
  ): Promise<string>
}

export const NodeQuotaCommandRunner: QuotaCommandRunner = {
  async run(command, args, acceptedExitCodes = [0]) {
    try {
      const result = await execFileAsync(command, [...args], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      return result.stdout
    } catch (cause) {
      const exitCode = (cause as { code?: unknown }).code
      if (
        typeof exitCode === 'number' &&
        acceptedExitCodes.includes(exitCode) &&
        typeof (cause as { stdout?: unknown }).stdout === 'string'
      ) {
        return (cause as { stdout: string }).stdout
      }
      throw new ProjectQuotaError('command_failed', `fixed quota command failed: ${command}`, cause)
    }
  },
}

interface RegistryEntry {
  readonly projectId: number
  readonly requestedBytes: number
}

interface QuotaRegistry {
  readonly version: 1
  readonly nextProjectId: number
  readonly servers: Readonly<Record<string, RegistryEntry>>
}

export interface ProjectQuotaHelperOptions {
  readonly serversRoot: string
  readonly backingFile: string
  readonly statePath: string
  readonly commandRunner: QuotaCommandRunner
  readonly rootUid: number
  readonly trustedGid: number | null
  readonly dataUid: number
  readonly dataGid: number
}

export interface ProjectQuotaHelper {
  ensure(request: ProjectQuotaRequest): Promise<ProjectQuotaProof>
}

const defaultOptions: ProjectQuotaHelperOptions = {
  serversRoot: PROJECT_QUOTA_ROOT,
  backingFile: PROJECT_QUOTA_BACKING_FILE,
  statePath: PROJECT_QUOTA_STATE,
  commandRunner: NodeQuotaCommandRunner,
  rootUid: 0,
  trustedGid: null,
  dataUid: DATA_UID,
  dataGid: DATA_GID,
}

function isSafeSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}

function validateQuotaRequest(
  request: ProjectQuotaRequest,
  serversRoot: string,
): { readonly serverRoot: string; readonly mountSources: readonly string[] } {
  if (
    request.apiVersion !== PROJECT_QUOTA_API_VERSION ||
    request.action !== 'ensure' ||
    !isSafeSegment(request.serverId) ||
    !Number.isSafeInteger(request.requestedBytes) ||
    request.requestedBytes < MIN_QUOTA_BYTES ||
    request.requestedBytes % 1024 !== 0 ||
    !Array.isArray(request.mountSources) ||
    request.mountSources.length === 0 ||
    request.mountSources.length > 32
  ) {
    throw new ProjectQuotaError('invalid_request', 'invalid quota request')
  }

  const canonicalRoot = resolve(serversRoot)
  const serverRoot = join(canonicalRoot, request.serverId)
  const uniqueSources = new Set<string>()

  for (const source of request.mountSources) {
    if (typeof source !== 'string') {
      throw new ProjectQuotaError('invalid_request', 'invalid mount source')
    }

    const canonicalSource = resolve(source)
    const sourceRelative = relative(serverRoot, canonicalSource)
    if (
      canonicalSource !== source ||
      !isSafeSegment(sourceRelative) ||
      sourceRelative.includes('/') ||
      sourceRelative.includes('\\') ||
      uniqueSources.has(canonicalSource)
    ) {
      throw new ProjectQuotaError(
        'unsafe_path',
        'mount source must be a unique direct child of the server root',
      )
    }
    uniqueSources.add(canonicalSource)
  }

  return { serverRoot, mountSources: [...uniqueSources].sort() }
}

async function ensureDirectory(
  path: string,
  ownerUid: number,
  ownerGid: number,
  mode: number,
): Promise<void> {
  await mkdir(path, { recursive: false, mode }).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw cause
    }
  })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectQuotaError('unsafe_path', 'quota path is not a directory')
  }
  const canonical = await realpath(path)
  if (canonical !== path) {
    throw new ProjectQuotaError('unsafe_path', 'quota path is not canonical')
  }
  await chown(path, ownerUid, ownerGid)
  await chmod(path, mode)
  const secured = await lstat(path)
  if (secured.uid !== ownerUid || secured.gid !== ownerGid || (secured.mode & 0o7777) !== mode) {
    throw new ProjectQuotaError('unsafe_path', 'quota path is replaceable')
  }
}

async function ensureServerTree(
  options: ProjectQuotaHelperOptions,
  trustedGid: number,
  serverRoot: string,
  mountSources: readonly string[],
): Promise<void> {
  const rootStat = await lstat(options.serversRoot).catch((cause: unknown) => {
    throw new ProjectQuotaError('unsafe_path', 'quota root is unavailable', cause)
  })
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== options.rootUid ||
    rootStat.gid !== trustedGid ||
    (rootStat.mode & 0o022) !== 0 ||
    (await realpath(options.serversRoot)) !== options.serversRoot
  ) {
    throw new ProjectQuotaError('unsafe_path', 'quota root is not trusted')
  }

  await ensureDirectory(serverRoot, options.rootUid, trustedGid, 0o750)
  const standardSources = SERVER_DIRECT_CHILDREN.map((child) => join(serverRoot, child))
  for (const source of [...new Set([...standardSources, ...mountSources])].sort()) {
    // Game containers own files as dataUid, while the unprivileged agent is a
    // member of trustedGid.  Group-write on these fixed direct children is the
    // intentional handoff: the root-owned server parent remains non-replaceable,
    // and no caller can choose an arbitrary path or group.
    // The game UID/GID owns the writable tree. The agent receives this fixed
    // group through its service account, so generated config remains readable
    // by the game process without making the game a member of gridora-agent.
    await ensureDirectory(source, options.dataUid, options.dataGid, 0o2770)
  }
}

async function resolveTrustedGid(options: ProjectQuotaHelperOptions): Promise<number> {
  if (options.trustedGid !== null) return options.trustedGid
  const fields = (
    await options.commandRunner.run(FIXED_COMMANDS.getent, ['group', 'gridora-agent'])
  )
    .trim()
    .split(':')
  const gid = Number(fields[2])
  if (
    fields.length !== 4 ||
    fields[0] !== 'gridora-agent' ||
    !Number.isSafeInteger(gid) ||
    gid <= 0 ||
    gid === options.dataGid
  ) {
    throw new ProjectQuotaError('unsafe_path', 'gridora agent group is invalid')
  }
  return gid
}

function parseFindmnt(stdout: string): {
  readonly target: string
  readonly source: string
  readonly fstype: string
  readonly options: readonly string[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (cause) {
    throw new ProjectQuotaError('unsupported_filesystem', 'findmnt returned invalid JSON', cause)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('filesystems' in parsed) ||
    !Array.isArray(parsed.filesystems) ||
    parsed.filesystems.length !== 1
  ) {
    throw new ProjectQuotaError('unsupported_filesystem', 'quota filesystem is ambiguous')
  }
  const filesystem = parsed.filesystems[0] as Record<string, unknown>
  if (
    typeof filesystem.target !== 'string' ||
    typeof filesystem.source !== 'string' ||
    typeof filesystem.fstype !== 'string' ||
    typeof filesystem.options !== 'string'
  ) {
    throw new ProjectQuotaError('unsupported_filesystem', 'quota filesystem metadata is incomplete')
  }
  return {
    target: filesystem.target,
    source: filesystem.source,
    fstype: filesystem.fstype,
    options: filesystem.options.split(','),
  }
}

async function assertProjectQuotaMount(options: ProjectQuotaHelperOptions): Promise<void> {
  const stdout = await options.commandRunner.run(FIXED_COMMANDS.findmnt, [
    '--json',
    '--target',
    options.serversRoot,
    '--output',
    'TARGET,SOURCE,FSTYPE,OPTIONS',
  ])
  const filesystem = parseFindmnt(stdout)
  if (
    filesystem.target !== options.serversRoot ||
    filesystem.fstype !== 'ext4' ||
    !/^\/dev\/loop[0-9]+$/.test(filesystem.source) ||
    (!filesystem.options.includes('prjquota') && !filesystem.options.includes('project'))
  ) {
    throw new ProjectQuotaError('unsupported_filesystem', 'ext4 project quotas are not active')
  }
  const loopReport = await options.commandRunner.run(FIXED_COMMANDS.losetup, [
    '--json',
    '--list',
    '--output',
    'NAME,BACK-FILE',
    filesystem.source,
  ])
  let parsedLoop: unknown
  try {
    parsedLoop = JSON.parse(loopReport)
  } catch (cause) {
    throw new ProjectQuotaError('unsupported_filesystem', 'loop backing metadata is invalid', cause)
  }
  if (
    typeof parsedLoop !== 'object' ||
    parsedLoop === null ||
    !('loopdevices' in parsedLoop) ||
    !Array.isArray(parsedLoop.loopdevices) ||
    parsedLoop.loopdevices.length !== 1 ||
    parsedLoop.loopdevices[0]?.name !== filesystem.source ||
    parsedLoop.loopdevices[0]?.['back-file'] !== options.backingFile
  ) {
    throw new ProjectQuotaError(
      'unsupported_filesystem',
      'project quota mount does not use the dedicated backing file',
    )
  }
}

function emptyRegistry(): QuotaRegistry {
  return { version: 1, nextProjectId: PROJECT_ID_START, servers: {} }
}

function parseRegistry(raw: string): QuotaRegistry {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ProjectQuotaError('state_corrupt', 'quota state is invalid', cause)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Number.isSafeInteger((parsed as { nextProjectId?: unknown }).nextProjectId) ||
    typeof (parsed as { servers?: unknown }).servers !== 'object' ||
    (parsed as { servers?: unknown }).servers === null ||
    Array.isArray((parsed as { servers?: unknown }).servers)
  ) {
    throw new ProjectQuotaError('state_corrupt', 'quota state is invalid')
  }

  const candidate = parsed as {
    version: 1
    nextProjectId: number
    servers: Record<string, unknown>
  }
  if (candidate.nextProjectId < PROJECT_ID_START || candidate.nextProjectId > PROJECT_ID_MAX + 1) {
    throw new ProjectQuotaError('state_corrupt', 'quota state is invalid')
  }

  const servers: Record<string, RegistryEntry> = {}
  const projectIds = new Set<number>()
  for (const [serverId, value] of Object.entries(candidate.servers)) {
    if (
      !isSafeSegment(serverId) ||
      typeof value !== 'object' ||
      value === null ||
      !Number.isSafeInteger((value as { projectId?: unknown }).projectId) ||
      !Number.isSafeInteger((value as { requestedBytes?: unknown }).requestedBytes)
    ) {
      throw new ProjectQuotaError('state_corrupt', 'quota state is invalid')
    }
    const entry = value as RegistryEntry
    if (
      entry.projectId < PROJECT_ID_START ||
      entry.projectId > PROJECT_ID_MAX ||
      entry.requestedBytes < MIN_QUOTA_BYTES ||
      projectIds.has(entry.projectId)
    ) {
      throw new ProjectQuotaError('state_corrupt', 'quota state is invalid')
    }
    projectIds.add(entry.projectId)
    servers[serverId] = entry
  }

  return {
    version: 1,
    nextProjectId: candidate.nextProjectId,
    servers,
  }
}

async function loadRegistry(statePath: string): Promise<QuotaRegistry> {
  try {
    return parseRegistry(await readFile(statePath, 'utf8'))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistry()
    }
    throw cause
  }
}

async function persistRegistry(statePath: string, registry: QuotaRegistry): Promise<void> {
  const stateDirectory = dirname(statePath)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await chmod(stateDirectory, 0o700)
  const temporaryPath = join(stateDirectory, `.projects.${process.pid}.${Date.now()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(registry)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, statePath)
    const directoryHandle = await open(stateDirectory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined)
    }
    await unlink(temporaryPath).catch(() => undefined)
  }
}

async function reserveProject(
  options: ProjectQuotaHelperOptions,
  serverId: string,
  requestedBytes: number,
): Promise<RegistryEntry> {
  const registry = await loadRegistry(options.statePath)
  const filesystem = await statfs(options.serversRoot, { bigint: true })
  const capacityBytes =
    (filesystem.blocks * BigInt(filesystem.bsize) * CAPACITY_NUMERATOR) / CAPACITY_DENOMINATOR
  const otherReserved = Object.entries(registry.servers).reduce(
    (total, [candidateId, entry]) =>
      candidateId === serverId ? total : total + BigInt(entry.requestedBytes),
    0n,
  )
  if (otherReserved + BigInt(requestedBytes) > capacityBytes) {
    throw new ProjectQuotaError(
      'capacity_exceeded',
      'project quota reservations exceed the node capacity boundary',
    )
  }

  const existing = registry.servers[serverId]
  const entry: RegistryEntry = existing
    ? { projectId: existing.projectId, requestedBytes }
    : { projectId: registry.nextProjectId, requestedBytes }
  if (!existing && registry.nextProjectId > PROJECT_ID_MAX) {
    throw new ProjectQuotaError('capacity_exceeded', 'project ID range exhausted')
  }
  const nextRegistry: QuotaRegistry = {
    version: 1,
    nextProjectId: existing ? registry.nextProjectId : registry.nextProjectId + 1,
    servers: { ...registry.servers, [serverId]: entry },
  }
  await persistRegistry(options.statePath, nextRegistry)
  return entry
}

async function enforceProjectQuota(
  options: ProjectQuotaHelperOptions,
  serverRoot: string,
  entry: RegistryEntry,
): Promise<void> {
  const projectId = String(entry.projectId)
  const hardKiB = String(entry.requestedBytes / 1024)
  await options.commandRunner.run(FIXED_COMMANDS.chattr, ['-R', '-p', projectId, serverRoot])
  await options.commandRunner.run(FIXED_COMMANDS.find, [
    serverRoot,
    '-xdev',
    '-type',
    'd',
    '-exec',
    FIXED_COMMANDS.chattr,
    '+P',
    '{}',
    '+',
  ])
  await options.commandRunner.run(FIXED_COMMANDS.setquota, [
    '-P',
    projectId,
    hardKiB,
    hardKiB,
    '0',
    '0',
    options.serversRoot,
  ])
  const quotaReport = await options.commandRunner.run(FIXED_COMMANDS.repquota, [
    '-P',
    '-O',
    'csv',
    options.serversRoot,
  ])
  const quotaLines = quotaReport
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
  const expectedHeader =
    'Project,BlockStatus,FileStatus,BlockUsed,BlockSoftLimit,BlockHardLimit,BlockGrace,FileUsed,FileSoftLimit,FileHardLimit,FileGrace'
  if (quotaLines[0] !== expectedHeader) {
    throw new ProjectQuotaError('command_failed', 'project quota readback header is invalid')
  }
  const matchingRows = quotaLines.slice(1).filter((line) => line.split(',')[0] === `#${projectId}`)
  if (matchingRows.length !== 1) {
    throw new ProjectQuotaError('command_failed', 'project quota readback is missing or ambiguous')
  }
  const columns = matchingRows[0]?.split(',') ?? []
  if (
    columns.length !== 11 ||
    columns[4] !== hardKiB ||
    columns[5] !== hardKiB ||
    columns[8] !== '0' ||
    columns[9] !== '0'
  ) {
    throw new ProjectQuotaError('command_failed', 'project quota readback does not match the limit')
  }

  const attributes = (
    await options.commandRunner.run(FIXED_COMMANDS.lsattr, ['-d', '-p', serverRoot])
  )
    .trim()
    .split(/\s+/)
  if (
    attributes.length !== 3 ||
    attributes[0] !== projectId ||
    !attributes[1]?.includes('P') ||
    attributes[2] !== serverRoot
  ) {
    throw new ProjectQuotaError(
      'command_failed',
      'project inheritance readback does not match the server root',
    )
  }
}

export function createProjectQuotaHelper(
  overrides: Partial<ProjectQuotaHelperOptions> = {},
): ProjectQuotaHelper {
  const options = { ...defaultOptions, ...overrides }
  let serial: Promise<unknown> = Promise.resolve()

  return {
    ensure(request) {
      const operation = serial.then(async () => {
        const { serverRoot, mountSources } = validateQuotaRequest(request, options.serversRoot)
        const trustedGid = await resolveTrustedGid(options)
        await assertProjectQuotaMount(options)
        await ensureServerTree(options, trustedGid, serverRoot, mountSources)
        const entry = await reserveProject(options, request.serverId, request.requestedBytes)
        await enforceProjectQuota(options, serverRoot, entry)
        return {
          apiVersion: PROJECT_QUOTA_API_VERSION,
          enforced: true,
          method: 'ext4-project-quota',
          serverId: request.serverId,
          projectId: entry.projectId,
          hardBytes: request.requestedBytes,
          root: serverRoot,
        } satisfies ProjectQuotaProof
      })
      serial = operation.catch(() => undefined)
      return operation
    },
  }
}

export interface ProjectQuotaFilesystemOptions {
  readonly serversRoot: string
  readonly backingFile: string
  readonly commandRunner: QuotaCommandRunner
  readonly rootUid: number
  readonly trustedGid: number | null
}

async function secureServersRoot(
  serversRoot: string,
  rootUid: number,
  trustedGid: number,
): Promise<void> {
  const metadata = await lstat(serversRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProjectQuotaError('unsafe_path', 'server filesystem root is not a directory')
  }
  if ((await realpath(serversRoot)) !== serversRoot) {
    throw new ProjectQuotaError('unsafe_path', 'server filesystem root is not canonical')
  }
  await chown(serversRoot, rootUid, trustedGid)
  await chmod(serversRoot, 0o750)
  const secured = await lstat(serversRoot)
  if (secured.uid !== rootUid || secured.gid !== trustedGid || (secured.mode & 0o7777) !== 0o750) {
    throw new ProjectQuotaError('unsafe_path', 'server filesystem root is not secured')
  }
}

async function assertBackingFile(backingFile: string, rootUid: number): Promise<void> {
  const metadata = await lstat(backingFile)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== rootUid ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < Number(MIN_FILESYSTEM_BYTES)
  ) {
    throw new ProjectQuotaError('unsafe_path', 'project quota backing file is not trusted')
  }
  if ((await realpath(backingFile)) !== backingFile) {
    throw new ProjectQuotaError('unsafe_path', 'project quota backing file is not canonical')
  }
}

async function assertBackingFeatures(
  commandRunner: QuotaCommandRunner,
  backingFile: string,
): Promise<void> {
  const filesystemType = (
    await commandRunner.run(FIXED_COMMANDS.blkid, [
      '--probe',
      '--output',
      'value',
      '--match-tag',
      'TYPE',
      backingFile,
    ])
  ).trim()
  if (filesystemType !== 'ext4') {
    throw new ProjectQuotaError('unsupported_filesystem', 'project quota backing file is not ext4')
  }
  const superblock = await commandRunner.run(FIXED_COMMANDS.tune2fs, ['-l', backingFile])
  const featureLine = superblock
    .split(/\r?\n/)
    .find((line) => line.startsWith('Filesystem features:'))
  const features = new Set(featureLine?.slice('Filesystem features:'.length).trim().split(/\s+/))
  if (!features.has('quota') || !features.has('project')) {
    throw new ProjectQuotaError(
      'unsupported_filesystem',
      'project quota backing features are incomplete',
    )
  }
}

export async function prepareProjectQuotaFilesystem(
  overrides: Partial<ProjectQuotaFilesystemOptions> = {},
): Promise<void> {
  const options: ProjectQuotaFilesystemOptions = {
    serversRoot: PROJECT_QUOTA_ROOT,
    backingFile: PROJECT_QUOTA_BACKING_FILE,
    commandRunner: NodeQuotaCommandRunner,
    rootUid: 0,
    trustedGid: null,
    ...overrides,
  }
  const helperOptions = { ...defaultOptions, ...options }
  const trustedGid = await resolveTrustedGid(helperOptions)
  const baseDirectory = dirname(options.serversRoot)
  if (
    dirname(options.backingFile) !== baseDirectory ||
    resolve(options.serversRoot) !== options.serversRoot ||
    resolve(options.backingFile) !== options.backingFile
  ) {
    throw new ProjectQuotaError('unsafe_path', 'project quota filesystem paths are invalid')
  }
  const baseMetadata = await lstat(baseDirectory)
  if (
    !baseMetadata.isDirectory() ||
    baseMetadata.isSymbolicLink() ||
    baseMetadata.uid !== options.rootUid ||
    (baseMetadata.mode & 0o022) !== 0 ||
    (await realpath(baseDirectory)) !== baseDirectory
  ) {
    throw new ProjectQuotaError('unsafe_path', 'project quota base directory is not trusted')
  }

  const mountOutput = await options.commandRunner.run(FIXED_COMMANDS.findmnt, [
    '--json',
    '--target',
    options.serversRoot,
    '--output',
    'TARGET,SOURCE,FSTYPE,OPTIONS',
  ])
  const currentMount = parseFindmnt(mountOutput)
  if (currentMount.target === options.serversRoot) {
    await assertBackingFile(options.backingFile, options.rootUid)
    await assertBackingFeatures(options.commandRunner, options.backingFile)
    await assertProjectQuotaMount(helperOptions)
    await secureServersRoot(options.serversRoot, options.rootUid, trustedGid)
    return
  }

  const mountpointMetadata = await lstat(options.serversRoot)
  if (
    !mountpointMetadata.isDirectory() ||
    mountpointMetadata.isSymbolicLink() ||
    (await realpath(options.serversRoot)) !== options.serversRoot ||
    (await readdir(options.serversRoot)).length !== 0
  ) {
    throw new ProjectQuotaError(
      'unsafe_path',
      'unmounted project quota directory is not an empty canonical directory',
    )
  }

  try {
    await assertBackingFile(options.backingFile, options.rootUid)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    const hostFilesystem = await statfs(baseDirectory, { bigint: true })
    const totalBytes = hostFilesystem.blocks * BigInt(hostFilesystem.bsize)
    const availableBytes = hostFilesystem.bavail * BigInt(hostFilesystem.bsize)
    const reserveBytes =
      totalBytes / 5n > MIN_HOST_RESERVE_BYTES ? totalBytes / 5n : MIN_HOST_RESERVE_BYTES
    const allocationBytes = ((availableBytes - reserveBytes) / 4096n) * 4096n
    if (allocationBytes < MIN_FILESYSTEM_BYTES) {
      throw new ProjectQuotaError(
        'capacity_exceeded',
        'node does not have enough capacity for the project quota filesystem',
      )
    }

    const handle = await open(options.backingFile, 'wx', 0o600)
    await handle.close()
    try {
      await chown(options.backingFile, options.rootUid, trustedGid)
      await chmod(options.backingFile, 0o600)
      await options.commandRunner.run(FIXED_COMMANDS.fallocate, [
        '--length',
        String(allocationBytes),
        options.backingFile,
      ])
      await options.commandRunner.run(FIXED_COMMANDS.mkfsExt4, [
        '-q',
        '-F',
        '-O',
        'quota,project',
        '-E',
        'nodiscard,quotatype=prjquota',
        options.backingFile,
      ])
    } catch (cause) {
      await unlink(options.backingFile).catch(() => undefined)
      throw cause
    }
  }

  await assertBackingFile(options.backingFile, options.rootUid)
  await assertBackingFeatures(options.commandRunner, options.backingFile)
  await options.commandRunner.run(FIXED_COMMANDS.e2fsck, ['-p', options.backingFile], [0, 1])
  await options.commandRunner.run(FIXED_COMMANDS.mount, [
    '-o',
    'loop,nodev,nosuid,prjquota',
    options.backingFile,
    options.serversRoot,
  ])
  await secureServersRoot(options.serversRoot, options.rootUid, trustedGid)
  await assertProjectQuotaMount(helperOptions)
}

function decodeRequest(value: unknown): ProjectQuotaRequest {
  if (typeof value !== 'object' || value === null) {
    throw new ProjectQuotaError('invalid_request', 'invalid quota request')
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.apiVersion !== PROJECT_QUOTA_API_VERSION ||
    candidate.action !== 'ensure' ||
    typeof candidate.serverId !== 'string' ||
    typeof candidate.requestedBytes !== 'number' ||
    !Array.isArray(candidate.mountSources) ||
    !candidate.mountSources.every((source) => typeof source === 'string') ||
    Object.keys(candidate).some(
      (key) =>
        !['apiVersion', 'action', 'serverId', 'requestedBytes', 'mountSources'].includes(key),
    )
  ) {
    throw new ProjectQuotaError('invalid_request', 'invalid quota request')
  }
  return candidate as unknown as ProjectQuotaRequest
}

function decodeProof(value: unknown): ProjectQuotaProof {
  if (typeof value !== 'object' || value === null) {
    throw new ProjectQuotaError('invalid_response', 'invalid quota response')
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.apiVersion !== PROJECT_QUOTA_API_VERSION ||
    candidate.enforced !== true ||
    candidate.method !== 'ext4-project-quota' ||
    typeof candidate.serverId !== 'string' ||
    !Number.isSafeInteger(candidate.projectId) ||
    !Number.isSafeInteger(candidate.hardBytes) ||
    typeof candidate.root !== 'string' ||
    Object.keys(candidate).some(
      (key) =>
        ![
          'apiVersion',
          'enforced',
          'method',
          'serverId',
          'projectId',
          'hardBytes',
          'root',
        ].includes(key),
    )
  ) {
    throw new ProjectQuotaError('invalid_response', 'invalid quota response')
  }
  return candidate as unknown as ProjectQuotaProof
}

export function createProjectQuotaHttpServer(helper: ProjectQuotaHelper): Server {
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/v1/project-quotas/ensure' ||
      request.headers['content-type'] !== 'application/json'
    ) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not_found"}')
      return
    }

    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      void (async () => {
        try {
          if (tooLarge) {
            throw new ProjectQuotaError('invalid_request', 'quota request is too large')
          }
          const decoded = decodeRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          const proof = await helper.ensure(decoded)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(proof))
        } catch (cause) {
          const status =
            (cause instanceof ProjectQuotaError &&
              ['invalid_request', 'unsafe_path'].includes(cause.code)) ||
            cause instanceof SyntaxError
              ? 400
              : 503
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end('{"error":"quota_not_enforced"}')
        }
      })()
    })
  })
  server.maxHeadersCount = 16
  server.headersTimeout = 5_000
  server.requestTimeout = 35_000
  return server
}

export async function serveProjectQuotaHelperOnFd(fd: number): Promise<void> {
  if (fd !== 3) {
    throw new ProjectQuotaError('invalid_request', 'invalid activation fd')
  }
  const server = createProjectQuotaHttpServer(createProjectQuotaHelper())
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen({ fd }, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  await new Promise<void>((resolveClose, rejectClose) => {
    server.once('close', resolveClose)
    server.once('error', rejectClose)
  })
}

export interface ProjectQuotaClient {
  ensure(request: ProjectQuotaRequest): Promise<ProjectQuotaProof>
}

export function makeProjectQuotaClient(
  socketPath: string = PROJECT_QUOTA_SOCKET,
): ProjectQuotaClient {
  return {
    ensure(payload) {
      return new Promise<ProjectQuotaProof>((resolveRequest, rejectRequest) => {
        const body = JSON.stringify(payload)
        const request = httpRequest(
          {
            socketPath,
            path: '/v1/project-quotas/ensure',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
            },
            timeout: 40_000,
          },
          (response) => {
            let size = 0
            const chunks: Buffer[] = []
            response.once('error', (cause) => {
              rejectRequest(
                cause instanceof ProjectQuotaError
                  ? cause
                  : new ProjectQuotaError(
                      'invalid_response',
                      'project quota response failed',
                      cause,
                    ),
              )
            })
            response.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (size > MAX_REQUEST_BYTES) {
                response.destroy(
                  new ProjectQuotaError('invalid_response', 'quota response is too large'),
                )
                return
              }
              chunks.push(chunk)
            })
            response.on('end', () => {
              try {
                if (response.statusCode !== 200) {
                  throw new ProjectQuotaError(
                    'unavailable',
                    'project quota helper rejected the request',
                  )
                }
                resolveRequest(decodeProof(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
              } catch (cause) {
                rejectRequest(
                  cause instanceof ProjectQuotaError
                    ? cause
                    : new ProjectQuotaError(
                        'invalid_response',
                        'project quota helper returned invalid JSON',
                        cause,
                      ),
                )
              }
            })
          },
        )
        request.on('timeout', () => {
          request.destroy(new ProjectQuotaError('unavailable', 'project quota helper timed out'))
        })
        request.on('error', (cause) => {
          rejectRequest(
            cause instanceof ProjectQuotaError
              ? cause
              : new ProjectQuotaError('unavailable', 'project quota helper is unavailable', cause),
          )
        })
        request.end(body)
      })
    },
  }
}

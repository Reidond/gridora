import { execFile } from 'node:child_process'
import { constants as fsConstants, type Stats } from 'node:fs'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  AgentUpdateManifest,
  canonicalJson,
  type AgentUpdateManifest as AgentUpdateManifestType,
} from '@gridora/agent-protocol'
import { Schema } from 'effect'
import {
  AGENT_UPDATE_SOCKET,
  AgentUpdateError,
  type AgentUpdateActivationProof,
  type AgentUpdateActivationRequest,
  type AgentUpdatePaths,
  productionAgentUpdatePaths,
  stagePathsForDigest,
  verifyAgentUpdateManifest,
} from './self-update.js'

export const AGENT_UPDATE_DIRECTORY = '/var/lib/gridora/agent-updates' as const
export const AGENT_UPDATE_RELEASE_DIRECTORY = '/var/lib/gridora/agent-updates/releases' as const
export const AGENT_UPDATE_CURRENT_LINK = '/var/lib/gridora/agent-updates/current' as const
export const AGENT_UPDATE_STATE_PATH = '/var/lib/gridora/agent-updates/root-state.json' as const

const MAX_REQUEST_BYTES = 8 * 1024
const MAX_STATE_BYTES = 32 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024
const LOCK_LEASE_MILLISECONDS = 180_000
const UPDATE_API_VERSION = 'agent-update.gridora.dev/v1alpha1' as const
const HEALTH_API_VERSION = 'agent-update-health.gridora.dev/v1alpha1' as const
const execFileAsync = promisify(execFile)

const mode = (value: number) => value & 0o7777
const safeError = (code: AgentUpdateError['code']) => new AgentUpdateError(code)

export interface RootAgentUpdatePaths extends AgentUpdatePaths {
  readonly directory: string
  readonly releaseDirectory: string
  readonly currentLink: string
  readonly statePath: string
}

export const productionRootAgentUpdatePaths: RootAgentUpdatePaths = {
  ...productionAgentUpdatePaths,
  directory: AGENT_UPDATE_DIRECTORY,
  releaseDirectory: AGENT_UPDATE_RELEASE_DIRECTORY,
  currentLink: AGENT_UPDATE_CURRENT_LINK,
  statePath: AGENT_UPDATE_STATE_PATH,
}

export type AgentUpdateSystemctlArguments =
  | readonly ['restart', 'gridora-agent.service']
  | readonly ['is-active', '--quiet', 'gridora-agent.service']

export interface AgentUpdateCommandRunner {
  readonly run: (
    command: '/usr/bin/systemctl',
    args: AgentUpdateSystemctlArguments,
  ) => Promise<void>
}

export const NodeAgentUpdateCommandRunner: AgentUpdateCommandRunner = {
  async run(command, args) {
    try {
      await execFileAsync(command, [...args], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      })
    } catch {
      throw safeError('helper-rejected')
    }
  },
}

export interface ReleaseRecord {
  readonly version: string
  readonly digest: string
  readonly releaseSequence: number
  readonly securityEpoch: number
}

interface ActivationRecord {
  readonly commandId: string
  readonly operationId: string
  readonly candidate: ReleaseRecord
  readonly previous: ReleaseRecord
  readonly startedAt: string
}

interface UpdateOutcome {
  readonly commandId: string
  readonly operationId: string
  readonly release: ReleaseRecord
  readonly status: 'active' | 'rolled-back'
  readonly observedAt: string
}

interface RootUpdateState {
  readonly version: 1
  readonly phase: 'active' | 'activating'
  readonly active: ReleaseRecord
  readonly previous: ReleaseRecord | null
  readonly activation: ActivationRecord | null
  readonly outcomes: readonly UpdateOutcome[]
  /** Never decreases, including after an internal rollback. */
  readonly highestReleaseSequence: number
  /** Never decreases, including after an internal rollback. */
  readonly minimumSecurityEpoch: number
}

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
)
const ReleaseRecordSchema = Schema.Struct({
  version: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/),
  ),
  digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  releaseSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  securityEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
})
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const ActivationSchema = Schema.Struct({
  commandId: Identifier,
  operationId: Identifier,
  candidate: ReleaseRecordSchema,
  previous: ReleaseRecordSchema,
  startedAt: Timestamp,
})
const OutcomeSchema = Schema.Struct({
  commandId: Identifier,
  operationId: Identifier,
  release: ReleaseRecordSchema,
  status: Schema.Literals(['active', 'rolled-back']),
  observedAt: Timestamp,
})
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(['active', 'activating']),
  active: ReleaseRecordSchema,
  previous: Schema.NullOr(ReleaseRecordSchema),
  activation: Schema.NullOr(ActivationSchema),
  outcomes: Schema.Array(OutcomeSchema).check(Schema.isMaxLength(32)),
  highestReleaseSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  minimumSecurityEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
})
const ActivationRequestSchema = Schema.Struct({
  apiVersion: Schema.Literal(UPDATE_API_VERSION),
  action: Schema.Literal('activate'),
  digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  version: ReleaseRecordSchema.fields.version,
  architecture: Schema.Literals(['amd64', 'arm64']),
  commandId: Identifier,
  operationId: Identifier,
})
const HealthSchema = Schema.Struct({
  apiVersion: Schema.Literal(HEALTH_API_VERSION),
  version: ReleaseRecordSchema.fields.version,
  digest: ReleaseRecordSchema.fields.digest,
  startedAt: Timestamp,
})

export interface AgentUpdateHealthProbe {
  readonly healthy: (release: ReleaseRecord, startedAfter: number) => Promise<boolean>
}

export interface RootAgentUpdateOptions {
  readonly paths: RootAgentUpdatePaths
  readonly rootUid: number
  readonly rootGid: number
  readonly agentUid: number
  readonly agentGid: number
  readonly architecture: 'amd64' | 'arm64'
  readonly commandRunner: AgentUpdateCommandRunner
  readonly healthProbe?: AgentUpdateHealthProbe
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Production requires a continuous ready/active interval before commit. */
  readonly probationMilliseconds?: number
}

const productionOptions: RootAgentUpdateOptions = {
  paths: productionRootAgentUpdatePaths,
  rootUid: 0,
  rootGid: 0,
  // Replaced by the fixed, root-owned account lookup in the production factory.
  agentUid: -1,
  agentGid: -1,
  architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
  commandRunner: NodeAgentUpdateCommandRunner,
}

const assertCanonical = (path: string): void => {
  if (!path.startsWith('/') || resolve(path) !== path || path.includes('\0'))
    throw safeError('unsafe-filesystem')
}

const assertPathLayout = (paths: RootAgentUpdatePaths): void => {
  for (const path of [
    paths.directory,
    paths.releaseDirectory,
    paths.currentLink,
    paths.statePath,
    paths.stagingDirectory,
    paths.healthPath,
    paths.policyPath,
    paths.releaseSigningPublicKeyPath,
    paths.socketPath,
  ])
    assertCanonical(path)
  if (
    paths.releaseDirectory !== join(paths.directory, 'releases') ||
    paths.currentLink !== join(paths.directory, 'current') ||
    paths.statePath !== join(paths.directory, 'root-state.json') ||
    paths.stagingDirectory !== join(paths.directory, 'staged') ||
    paths.healthPath !== join(paths.directory, 'health', 'receipt.json')
  )
    throw safeError('unsafe-filesystem')
}

const assertDirectory = async (
  path: string,
  owner: number,
  group: number,
  expectedMode: number,
): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== owner ||
    metadata.gid !== group ||
    mode(metadata.mode) !== expectedMode
  )
    throw safeError('unsafe-filesystem')
}

const assertTrustedRootDirectory = async (path: string, rootUid: number): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== rootUid ||
    (mode(metadata.mode) & 0o022) !== 0
  )
    throw safeError('unsafe-filesystem')
}

const createDirectory = async (
  path: string,
  owner: number,
  group: number,
  expectedMode: number,
): Promise<void> => {
  try {
    await mkdir(path, { recursive: false, mode: expectedMode })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw safeError('unsafe-filesystem')
  }
  try {
    await chmod(path, expectedMode)
    await chown(path, owner, group)
  } catch {
    throw safeError('unsafe-filesystem')
  }
  await assertDirectory(path, owner, group, expectedMode)
}

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const lockPath = (options: RootAgentUpdateOptions) =>
  join(options.paths.directory, 'root-update.lock')

const releaseExclusiveLock = async (
  path: string,
  options: RootAgentUpdateOptions,
): Promise<void> => {
  try {
    await assertRootRegular(path, options, undefined, 0o600)
    await unlink(path)
    await syncDirectory(dirname(path))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw cause
  }
}

const acquireExclusiveLock = async (
  options: RootAgentUpdateOptions,
): Promise<() => Promise<void>> => {
  const path = lockPath(options)
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      const lease = Buffer.from(
        `${canonicalJson({ ownerPid: process.pid, expiresAt: Date.now() + LOCK_LEASE_MILLISECONDS })}\n`,
        'utf8',
      )
      await handle.writeFile(lease)
      await handle.sync()
      await handle.chmod(0o600)
      await handle.chown(options.rootUid, options.rootGid)
      await handle.close()
      handle = undefined
      await assertRootRegular(path, options, undefined, 0o600)
      await syncDirectory(options.paths.directory)
      return () => releaseExclusiveLock(path, options)
    } catch (cause) {
      await handle?.close().catch(() => undefined)
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (cause instanceof AgentUpdateError) throw cause
        throw safeError('unsafe-filesystem')
      }
      try {
        const bytes = await readNoFollow(
          path,
          512,
          () => assertRootRegular(path, options, undefined, 0o600),
          rootFileExpectation(options, 0o600),
        )
        const parsed = JSON.parse(bytes.toString('utf8')) as { expiresAt?: unknown }
        if (typeof parsed.expiresAt !== 'number' || !Number.isSafeInteger(parsed.expiresAt))
          throw safeError('unsafe-filesystem')
        if (parsed.expiresAt < Date.now()) {
          await releaseExclusiveLock(path, options)
          continue
        }
      } catch (lockCause) {
        if (lockCause instanceof AgentUpdateError) throw lockCause
        throw safeError('unsafe-filesystem')
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  }
  throw safeError('helper-response-pending')
}

const assertRootRegular = async (
  path: string,
  options: RootAgentUpdateOptions,
  expectedSize: number | undefined,
  expectedMode: number,
): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== options.rootUid ||
    metadata.gid !== options.rootGid ||
    mode(metadata.mode) !== expectedMode ||
    (expectedSize !== undefined && metadata.size !== expectedSize)
  )
    throw safeError('unsafe-filesystem')
}

const assertAgentRegular = async (
  path: string,
  options: RootAgentUpdateOptions,
  expectedSize?: number,
): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== options.agentUid ||
    metadata.gid !== options.agentGid ||
    mode(metadata.mode) !== 0o600 ||
    (expectedSize !== undefined && metadata.size !== expectedSize)
  )
    throw safeError('unsafe-filesystem')
}

/**
 * The lstat checks above protect the pathname. This expectation is repeated
 * against the opened descriptor so an unprivileged writer cannot exchange a
 * file between the pathname check and the O_NOFOLLOW open.
 */
interface NoFollowFileExpectation {
  readonly uid: number
  readonly gid: number
  readonly expectedMode: number
}

const rootFileExpectation = (
  options: RootAgentUpdateOptions,
  expectedMode: number,
): NoFollowFileExpectation => ({
  uid: options.rootUid,
  gid: options.rootGid,
  expectedMode,
})

const agentFileExpectation = (options: RootAgentUpdateOptions): NoFollowFileExpectation => ({
  uid: options.agentUid,
  gid: options.agentGid,
  expectedMode: 0o600,
})

const hasExpectedOpenedFile = (
  metadata: Stats,
  maximumBytes: number,
  expectation: NoFollowFileExpectation,
): boolean =>
  metadata.isFile() &&
  metadata.uid === expectation.uid &&
  metadata.gid === expectation.gid &&
  mode(metadata.mode) === expectation.expectedMode &&
  metadata.nlink === 1 &&
  metadata.size >= 1 &&
  metadata.size <= maximumBytes

const readNoFollow = async (
  path: string,
  maximumBytes: number,
  assert: () => Promise<void>,
  expectation: NoFollowFileExpectation,
): Promise<Buffer> => {
  await assert()
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!hasExpectedOpenedFile(before, maximumBytes, expectation))
      throw safeError('unsafe-filesystem')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      after.ino !== before.ino ||
      after.size !== before.size ||
      !hasExpectedOpenedFile(after, maximumBytes, expectation) ||
      bytes.byteLength !== before.size
    )
      throw safeError('unsafe-filesystem')
    return bytes
  } finally {
    await handle.close()
  }
}

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const digestSuffix = (value: string) => value.slice('sha256:'.length)

const releaseDirectoryFor = (options: RootAgentUpdateOptions, release: ReleaseRecord): string => {
  const path = join(options.paths.releaseDirectory, digestSuffix(release.digest))
  if (resolve(path) !== path || dirname(path) !== options.paths.releaseDirectory)
    throw safeError('unsafe-filesystem')
  return path
}

const readState = async (options: RootAgentUpdateOptions): Promise<RootUpdateState | null> => {
  try {
    const bytes = await readNoFollow(
      options.paths.statePath,
      MAX_STATE_BYTES,
      () => assertRootRegular(options.paths.statePath, options, undefined, 0o600),
      rootFileExpectation(options, 0o600),
    )
    const state = await Schema.decodeUnknownPromise(StateSchema, { onExcessProperty: 'error' })(
      JSON.parse(bytes.toString('utf8')) as unknown,
    )
    if (
      state.highestReleaseSequence < state.active.releaseSequence ||
      state.minimumSecurityEpoch < state.active.securityEpoch ||
      (state.previous !== null &&
        (state.highestReleaseSequence < state.previous.releaseSequence ||
          state.minimumSecurityEpoch < state.previous.securityEpoch))
    )
      throw safeError('unsafe-filesystem')
    return state
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  }
}

const atomicWriteRoot = async (
  path: string,
  bytes: Uint8Array,
  options: RootAgentUpdateOptions,
  fileMode: number,
): Promise<void> => {
  const directory = dirname(path)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      fileMode,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.chmod(fileMode)
    await handle.chown(options.rootUid, options.rootGid)
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      metadata.uid !== options.rootUid ||
      metadata.gid !== options.rootGid ||
      mode(metadata.mode) !== fileMode ||
      metadata.size !== bytes.byteLength
    )
      throw safeError('unsafe-filesystem')
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(directory)
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

const persistState = async (
  state: RootUpdateState,
  options: RootAgentUpdateOptions,
): Promise<void> =>
  atomicWriteRoot(
    options.paths.statePath,
    Buffer.from(`${canonicalJson(state)}\n`, 'utf8'),
    options,
    0o600,
  )

const manifestBytes = (manifest: AgentUpdateManifestType) =>
  Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')

const readStagedManifest = async (
  request: AgentUpdateActivationRequest,
  options: RootAgentUpdateOptions,
): Promise<AgentUpdateManifestType> => {
  const staged = stagePathsForDigest(options.paths.stagingDirectory, request.digest)
  const bytes = await readNoFollow(
    staged.manifestPath,
    MAX_MANIFEST_BYTES,
    () => assertAgentRegular(staged.manifestPath, options),
    agentFileExpectation(options),
  )
  let manifest: AgentUpdateManifestType
  try {
    manifest = await Schema.decodeUnknownPromise(AgentUpdateManifest, {
      onExcessProperty: 'error',
    })(JSON.parse(bytes.toString('utf8')) as unknown)
  } catch {
    throw safeError('invalid-manifest')
  }
  const checked = await verifyAgentUpdateManifest(manifest, {
    paths: options.paths,
    trustedUid: options.rootUid,
    architecture: options.architecture,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (
    checked.manifest.source.sha256 !== request.digest ||
    checked.manifest.version !== request.version ||
    checked.manifest.architecture !== request.architecture ||
    !bytes.equals(manifestBytes(checked.manifest))
  )
    throw safeError('invalid-manifest')
  return checked.manifest
}

const readStagedArtifact = async (
  manifest: AgentUpdateManifestType,
  options: RootAgentUpdateOptions,
): Promise<Buffer> => {
  const staged = stagePathsForDigest(options.paths.stagingDirectory, manifest.source.sha256)
  const bytes = await readNoFollow(
    staged.artifactPath,
    manifest.source.sizeBytes,
    () => assertAgentRegular(staged.artifactPath, options, manifest.source.sizeBytes),
    agentFileExpectation(options),
  )
  if (bytes.byteLength !== manifest.source.sizeBytes || digest(bytes) !== manifest.source.sha256)
    throw safeError('artifact-rejected')
  return bytes
}

const assertRelease = async (
  release: ReleaseRecord,
  options: RootAgentUpdateOptions,
): Promise<void> => {
  const directory = releaseDirectoryFor(options, release)
  await assertDirectory(directory, options.rootUid, options.rootGid, 0o755)
  const executable = join(directory, 'gridora-agent')
  const manifestPath = join(directory, 'release.json')
  await assertRootRegular(executable, options, undefined, 0o755)
  await assertRootRegular(manifestPath, options, undefined, 0o644)
  const bytes = await readNoFollow(
    executable,
    128 * 1024 * 1024,
    () => assertRootRegular(executable, options, undefined, 0o755),
    rootFileExpectation(options, 0o755),
  )
  if (digest(bytes) !== release.digest) throw safeError('unsafe-filesystem')
  const manifest = await readNoFollow(
    manifestPath,
    MAX_MANIFEST_BYTES,
    () => assertRootRegular(manifestPath, options, undefined, 0o644),
    rootFileExpectation(options, 0o644),
  )
  try {
    const decoded = await Schema.decodeUnknownPromise(AgentUpdateManifest, {
      onExcessProperty: 'error',
    })(JSON.parse(manifest.toString('utf8')) as unknown)
    if (
      decoded.version !== release.version ||
      decoded.source.sha256 !== release.digest ||
      decoded.releaseSequence !== release.releaseSequence ||
      decoded.securityEpoch !== release.securityEpoch ||
      !manifest.equals(manifestBytes(decoded))
    )
      throw safeError('unsafe-filesystem')
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  }
}

const ensureRelease = async (
  manifest: AgentUpdateManifestType,
  artifact: Buffer,
  options: RootAgentUpdateOptions,
): Promise<ReleaseRecord> => {
  const release: ReleaseRecord = {
    version: manifest.version,
    digest: manifest.source.sha256,
    releaseSequence: manifest.releaseSequence,
    securityEpoch: manifest.securityEpoch,
  }
  const directory = releaseDirectoryFor(options, release)
  try {
    await mkdir(directory, { recursive: false, mode: 0o755 })
    await chmod(directory, 0o755)
    await chown(directory, options.rootUid, options.rootGid)
    const executable = join(directory, 'gridora-agent')
    const releaseManifest = join(directory, 'release.json')
    await atomicWriteRoot(executable, artifact, options, 0o755)
    await atomicWriteRoot(releaseManifest, manifestBytes(manifest), options, 0o644)
    await syncDirectory(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      if (cause instanceof AgentUpdateError) throw cause
      throw safeError('unsafe-filesystem')
    }
  }
  await assertRelease(release, options)
  return release
}

const currentTarget = async (options: RootAgentUpdateOptions): Promise<ReleaseRecord | null> => {
  try {
    const metadata = await lstat(options.paths.currentLink)
    if (!metadata.isSymbolicLink() || metadata.uid !== options.rootUid)
      throw safeError('unsafe-filesystem')
    const target = await readlink(options.paths.currentLink)
    if (!/^releases\/[a-f0-9]{64}$/.test(target)) throw safeError('unsafe-filesystem')
    const resolved = resolve(options.paths.directory, target)
    if (dirname(resolved) !== options.paths.releaseDirectory) throw safeError('unsafe-filesystem')
    const digestValue = `sha256:${target.slice('releases/'.length)}`
    const manifest = await readNoFollow(
      join(resolved, 'release.json'),
      MAX_MANIFEST_BYTES,
      () => assertRootRegular(join(resolved, 'release.json'), options, undefined, 0o644),
      rootFileExpectation(options, 0o644),
    )
    const decoded = await Schema.decodeUnknownPromise(AgentUpdateManifest, {
      onExcessProperty: 'error',
    })(JSON.parse(manifest.toString('utf8')) as unknown)
    const release = {
      version: decoded.version,
      digest: digestValue,
      releaseSequence: decoded.releaseSequence,
      securityEpoch: decoded.securityEpoch,
    }
    await assertRelease(release, options)
    return release
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  }
}

const sameRelease = (left: ReleaseRecord, right: ReleaseRecord) =>
  left.version === right.version &&
  left.digest === right.digest &&
  left.releaseSequence === right.releaseSequence &&
  left.securityEpoch === right.securityEpoch

const activateCurrent = async (
  release: ReleaseRecord,
  options: RootAgentUpdateOptions,
): Promise<void> => {
  await assertRelease(release, options)
  const target = `releases/${digestSuffix(release.digest)}`
  const temporary = join(options.paths.directory, `.current-${randomUUID()}`)
  try {
    await symlink(target, temporary)
    const link = await lstat(temporary)
    if (!link.isSymbolicLink()) throw safeError('unsafe-filesystem')
    await rename(temporary, options.paths.currentLink)
    await syncDirectory(options.paths.directory)
    const observed = await currentTarget(options)
    if (observed === null || !sameRelease(observed, release)) throw safeError('unsafe-filesystem')
  } catch (cause) {
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

const clearHealth = async (options: RootAgentUpdateOptions): Promise<void> => {
  try {
    const metadata = await lstat(options.paths.healthPath)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw safeError('unsafe-filesystem')
    await unlink(options.paths.healthPath)
    await syncDirectory(dirname(options.paths.healthPath))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    if (cause instanceof AgentUpdateError) throw cause
    throw safeError('unsafe-filesystem')
  }
}

const defaultHealthProbe = (options: RootAgentUpdateOptions): AgentUpdateHealthProbe => ({
  healthy: async (release, startedAfter) => {
    try {
      const bytes = await readNoFollow(
        options.paths.healthPath,
        MAX_MANIFEST_BYTES,
        () => assertAgentRegular(options.paths.healthPath, options),
        agentFileExpectation(options),
      )
      const metadata = await lstat(options.paths.healthPath)
      if (metadata.mtimeMs < startedAfter) return false
      const health = await Schema.decodeUnknownPromise(HealthSchema, {
        onExcessProperty: 'error',
      })(JSON.parse(bytes.toString('utf8')) as unknown)
      return (
        health.version === release.version &&
        health.digest === release.digest &&
        Date.parse(health.startedAt) >= startedAfter
      )
    } catch {
      return false
    }
  },
})

const waitForHealth = async (
  release: ReleaseRecord,
  startedAfter: number,
  options: RootAgentUpdateOptions,
): Promise<boolean> => {
  const probe = options.healthProbe ?? defaultHealthProbe(options)
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const probationMilliseconds = options.probationMilliseconds ?? 5_000
  let stableSince: number | undefined
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let active = false
    try {
      await options.commandRunner.run('/usr/bin/systemctl', [
        'is-active',
        '--quiet',
        'gridora-agent.service',
      ])
      active = true
    } catch {
      active = false
    }
    const ready = active && (await probe.healthy(release, startedAfter))
    const observedAt = (options.now ?? (() => new Date()))().getTime()
    if (ready) {
      stableSince ??= observedAt
      if (observedAt - stableSince >= probationMilliseconds) return true
    } else stableSince = undefined
    await sleep(500)
  }
  return false
}

const releaseCount = async (options: RootAgentUpdateOptions): Promise<number> => {
  const entries = await readdir(options.paths.releaseDirectory, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).length
}

const garbageCollectReleases = async (
  state: RootUpdateState,
  options: RootAgentUpdateOptions,
): Promise<void> => {
  const retained = new Set<string>([
    digestSuffix(state.active.digest),
    ...(state.previous === null ? [] : [digestSuffix(state.previous.digest)]),
    ...(state.activation === null
      ? []
      : [
          digestSuffix(state.activation.candidate.digest),
          digestSuffix(state.activation.previous.digest),
        ]),
  ])
  const entries = await readdir(options.paths.releaseDirectory, { withFileTypes: true })
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) throw safeError('unsafe-filesystem')
    const path = join(options.paths.releaseDirectory, entry.name)
    if (dirname(path) !== options.paths.releaseDirectory || !entry.isDirectory())
      throw safeError('unsafe-filesystem')
    if (retained.has(entry.name)) continue
    await assertDirectory(path, options.rootUid, options.rootGid, 0o755)
    const contents = await readdir(path, { withFileTypes: true })
    if (
      contents.length !== 2 ||
      !contents.some((item) => item.name === 'gridora-agent' && item.isFile()) ||
      !contents.some((item) => item.name === 'release.json' && item.isFile())
    )
      throw safeError('unsafe-filesystem')
    const executable = join(path, 'gridora-agent')
    const manifest = join(path, 'release.json')
    await assertRootRegular(executable, options, undefined, 0o755)
    await assertRootRegular(manifest, options, undefined, 0o644)
    await unlink(executable)
    await unlink(manifest)
    await syncDirectory(path)
    await rmdir(path)
    await syncDirectory(options.paths.releaseDirectory)
  }
}

const proof = (
  outcome: UpdateOutcome,
  duplicate: boolean,
  retainedReleaseCount: number,
): AgentUpdateActivationProof => ({
  status: outcome.status,
  version: outcome.release.version,
  digest: outcome.release.digest,
  commandId: outcome.commandId,
  operationId: outcome.operationId,
  duplicate,
  observedAt: outcome.observedAt,
  ...(retainedReleaseCount >= 2 ? { retainedReleaseCount } : {}),
})

const appendOutcome = (state: RootUpdateState, outcome: UpdateOutcome): RootUpdateState => ({
  ...state,
  outcomes: [
    ...state.outcomes.filter((entry) => entry.commandId !== outcome.commandId),
    outcome,
  ].slice(-32),
})

const exactOutcome = (
  state: RootUpdateState,
  request: AgentUpdateActivationRequest,
): UpdateOutcome | undefined => {
  const matchingCommand = state.outcomes.find((outcome) => outcome.commandId === request.commandId)
  if (matchingCommand === undefined) return undefined
  if (
    matchingCommand.operationId !== request.operationId ||
    matchingCommand.release.version !== request.version ||
    matchingCommand.release.digest !== request.digest
  )
    throw safeError('helper-rejected')
  return matchingCommand
}

const completedState = (
  state: RootUpdateState,
  outcome: UpdateOutcome,
  active: ReleaseRecord,
  previous: ReleaseRecord | null,
): RootUpdateState =>
  appendOutcome(
    {
      ...state,
      phase: 'active',
      active,
      previous,
      activation: null,
      highestReleaseSequence: Math.max(
        state.highestReleaseSequence,
        active.releaseSequence,
        outcome.release.releaseSequence,
      ),
      minimumSecurityEpoch: Math.max(
        state.minimumSecurityEpoch,
        active.securityEpoch,
        outcome.release.securityEpoch,
      ),
    },
    outcome,
  )

const rollback = async (
  state: RootUpdateState,
  activation: ActivationRecord,
  options: RootAgentUpdateOptions,
): Promise<RootUpdateState> => {
  const startedAt = (options.now ?? (() => new Date()))().getTime()
  await clearHealth(options)
  await activateCurrent(activation.previous, options)
  await options.commandRunner.run('/usr/bin/systemctl', ['restart', 'gridora-agent.service'])
  if (!(await waitForHealth(activation.previous, startedAt, options)))
    throw safeError('helper-rejected')
  const outcome: UpdateOutcome = {
    commandId: activation.commandId,
    operationId: activation.operationId,
    release: activation.candidate,
    status: 'rolled-back',
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
  }
  const completed = completedState(state, outcome, activation.previous, state.previous)
  await persistState(completed, options)
  await garbageCollectReleases(completed, options)
  return completed
}

const recoverActivation = async (
  state: RootUpdateState,
  options: RootAgentUpdateOptions,
): Promise<RootUpdateState> => {
  const activation = state.activation
  if (state.phase !== 'activating' || activation === null) throw safeError('unsafe-filesystem')
  const current = await currentTarget(options)
  if (current !== null && sameRelease(current, activation.candidate)) {
    if (
      await (options.healthProbe ?? defaultHealthProbe(options)).healthy(
        activation.candidate,
        Date.parse(activation.startedAt),
      )
    ) {
      const outcome: UpdateOutcome = {
        commandId: activation.commandId,
        operationId: activation.operationId,
        release: activation.candidate,
        status: 'active',
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
      }
      const completed = completedState(state, outcome, activation.candidate, activation.previous)
      await persistState(completed, options)
      await garbageCollectReleases(completed, options)
      return completed
    }
  }
  // An expired helper cannot know whether a restart reached the new agent when
  // the exact health receipt is absent. Revert to the already-known release;
  // never repeat the candidate activation blindly.
  return rollback(state, activation, options)
}

export interface RootAgentUpdateHelper {
  readonly setup: () => Promise<void>
  readonly execute: (request: unknown) => Promise<AgentUpdateActivationProof>
}

export const createRootAgentUpdateHelper = (
  options: RootAgentUpdateOptions,
): RootAgentUpdateHelper => {
  const setup = async (): Promise<void> => {
    assertPathLayout(options.paths)
    if (process.getuid?.() !== options.rootUid) throw safeError('unsafe-filesystem')
    await assertTrustedRootDirectory(dirname(options.paths.directory), options.rootUid)
    await createDirectory(options.paths.directory, options.rootUid, options.rootGid, 0o755)
    await createDirectory(options.paths.releaseDirectory, options.rootUid, options.rootGid, 0o755)
    await createDirectory(options.paths.stagingDirectory, options.agentUid, options.agentGid, 0o700)
    await createDirectory(
      dirname(options.paths.healthPath),
      options.agentUid,
      options.agentGid,
      0o700,
    )
  }

  const executeUnlocked = async (input: unknown): Promise<AgentUpdateActivationProof> => {
    await setup()
    let request: AgentUpdateActivationRequest
    try {
      request = await Schema.decodeUnknownPromise(ActivationRequestSchema, {
        onExcessProperty: 'error',
      })(input)
    } catch {
      throw safeError('helper-rejected')
    }
    let state = await readState(options)
    if (state === null) throw safeError('helper-rejected')
    if (state.phase === 'activating') state = await recoverActivation(state, options)
    const replay = exactOutcome(state, request)
    if (replay !== undefined) {
      await garbageCollectReleases(state, options)
      return proof(replay, true, await releaseCount(options))
    }
    await assertRelease(state.active, options)
    const current = await currentTarget(options)
    if (current === null || !sameRelease(current, state.active))
      throw safeError('unsafe-filesystem')
    const manifest = await readStagedManifest(request, options)
    const requestedRelease: ReleaseRecord = {
      version: manifest.version,
      digest: manifest.source.sha256,
      releaseSequence: manifest.releaseSequence,
      securityEpoch: manifest.securityEpoch,
    }
    if (
      !sameRelease(requestedRelease, state.active) &&
      (requestedRelease.releaseSequence <= state.highestReleaseSequence ||
        requestedRelease.securityEpoch < state.minimumSecurityEpoch)
    )
      throw safeError('helper-rejected')
    const artifact = await readStagedArtifact(manifest, options)
    const candidate = await ensureRelease(manifest, artifact, options)
    if (sameRelease(candidate, state.active)) {
      const outcome: UpdateOutcome = {
        commandId: request.commandId,
        operationId: request.operationId,
        release: candidate,
        status: 'active',
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
      }
      const completed = completedState(state, outcome, state.active, state.previous)
      await persistState(completed, options)
      await garbageCollectReleases(completed, options)
      return proof(outcome, false, await releaseCount(options))
    }
    const activation: ActivationRecord = {
      commandId: request.commandId,
      operationId: request.operationId,
      candidate,
      previous: state.active,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
    }
    const activating: RootUpdateState = {
      ...state,
      phase: 'activating',
      activation,
    }
    // Persist intent before the externally visible service restart. If the
    // process disappears, recovery has a fixed previous release and requires
    // an exact health receipt before it adopts candidate success.
    await persistState(activating, options)
    const startedAt = (options.now ?? (() => new Date()))().getTime()
    let committed = false
    try {
      await clearHealth(options)
      await activateCurrent(candidate, options)
      await options.commandRunner.run('/usr/bin/systemctl', ['restart', 'gridora-agent.service'])
      if (!(await waitForHealth(candidate, startedAt, options))) throw safeError('helper-rejected')
      const outcome: UpdateOutcome = {
        commandId: request.commandId,
        operationId: request.operationId,
        release: candidate,
        status: 'active',
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
      }
      const completed = completedState(activating, outcome, candidate, state.active)
      await persistState(completed, options)
      committed = true
      await garbageCollectReleases(completed, options)
      return proof(outcome, false, await releaseCount(options))
    } catch (cause) {
      if (cause instanceof AgentUpdateError && cause.code === 'unsafe-filesystem') throw cause
      // The successful activation receipt is authoritative. If a later local
      // response/GC step failed, preserve it for exact replay rather than
      // performing a second externally visible restart or an unnecessary
      // rollback.
      if (committed) throw safeError('helper-response-pending')
      const rolledBack = await rollback(activating, activation, options)
      const outcome = exactOutcome(rolledBack, request)
      if (outcome === undefined) throw safeError('helper-rejected')
      await garbageCollectReleases(rolledBack, options)
      return proof(outcome, false, await releaseCount(options))
    }
  }
  const execute = async (input: unknown): Promise<AgentUpdateActivationProof> => {
    await setup()
    const release = await acquireExclusiveLock(options)
    try {
      return await executeUnlocked(input)
    } finally {
      await release()
    }
  }
  return { setup, execute }
}

const productionAgentIdentity = async (): Promise<{
  readonly uid: number
  readonly gid: number
}> => {
  try {
    const [uidResult, gidResult] = await Promise.all([
      execFileAsync('/usr/bin/id', ['-u', 'gridora-agent'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1_024,
        windowsHide: true,
      }),
      execFileAsync('/usr/bin/id', ['-g', 'gridora-agent'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1_024,
        windowsHide: true,
      }),
    ])
    const uid = Number(uidResult.stdout.trim())
    const gid = Number(gidResult.stdout.trim())
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1)
      throw new Error('agent identity is invalid')
    return { uid, gid }
  } catch {
    throw safeError('unsafe-filesystem')
  }
}

export const createProductionRootAgentUpdateHelper = async (): Promise<RootAgentUpdateHelper> => {
  const identity = await productionAgentIdentity()
  return createRootAgentUpdateHelper({
    ...productionOptions,
    agentUid: identity.uid,
    agentGid: identity.gid,
  })
}

export const createAgentUpdateHttpServer = (helper: RootAgentUpdateHelper): Server => {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST' || request.url !== '/v1/agent-updates/activate')
          throw safeError('helper-rejected')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.byteLength
          if (size > MAX_REQUEST_BYTES) throw safeError('helper-rejected')
          chunks.push(bytes)
        }
        const proof = await helper.execute(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        )
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(proof))
      } catch (cause) {
        response.writeHead(
          cause instanceof AgentUpdateError && cause.code === 'helper-response-pending'
            ? 503
            : cause instanceof AgentUpdateError
              ? 409
              : 400,
          {
            'content-type': 'application/json',
          },
        )
        response.end('{"error":"agent_update_operation_failed"}')
      }
    })()
  })
  server.maxHeadersCount = 16
  server.headersTimeout = 5_000
  server.requestTimeout = 140_000
  return server
}

export async function serveProductionAgentUpdateHelperOnFd(fd: number): Promise<void> {
  if (fd !== 3 || process.getuid?.() !== 0) throw safeError('unsafe-filesystem')
  const socket = await lstat(AGENT_UPDATE_SOCKET).catch(() => {
    throw safeError('unsafe-filesystem')
  })
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== 0 ||
    ![0o600, 0o660].includes(mode(socket.mode))
  )
    throw safeError('unsafe-filesystem')
  const helper = await createProductionRootAgentUpdateHelper()
  await helper.setup()
  const server = createAgentUpdateHttpServer(helper)
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

export const setupProductionAgentUpdate = async () =>
  (await createProductionRootAgentUpdateHelper()).setup()
